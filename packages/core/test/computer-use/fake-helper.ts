// A FAKE "Winter Computer Use" helper for the ComputerV2 tests: an in-memory transport that speaks the spine §2
// JSON-RPC protocol, a launcher that "launches" it, and a verifier. No app, no socket, no TCC.
import type { HelperConnection, HelperLauncher, HelperTransport, HelperVerifier } from "../../src/computer-use/helper-client";

export class FakeHelperError extends Error {
  constructor(readonly code: string, message: string, readonly data: Record<string, unknown> = {}) { super(message); }
}

export interface FakeApp { name: string; bundleId: string; pid: number; running: boolean }

type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>;

export class FakeHelper {
  /** Does the socket answer (is the helper running)? */
  running = true;
  installed = true;
  verifyOk = true;
  helloProtocol = 1;
  /** The helper version `hello` and `status` report (the daemon requires ≥ HELPER_MIN_VERSION). */
  helperVersion = "1.7.0";
  pid = 4242;
  /** The pids the daemon asked to end (an outdated helper); `onTerminate` lets a test "update" it. */
  readonly terminated: number[] = [];
  onTerminate?: (pid: number) => void;
  /** The app PATHS the launcher was asked to open (the daemon launches the helper by path). */
  readonly launched: string[] = [];
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly apps: FakeApp[] = [
    { name: "Notes", bundleId: "com.apple.Notes", pid: 501, running: true },
    { name: "TextEdit", bundleId: "com.apple.TextEdit", pid: 502, running: false },
    { name: "Winter", bundleId: "com.winter.app", pid: 503, running: true },
    { name: "1Password", bundleId: "com.1password.1password", pid: 504, running: true },
    { name: "Keychain Access", bundleId: "com.apple.keychainaccess", pid: 505, running: true },
  ];
  /** The on-screen desktop-switch prompts shown (`prompt.desktopVisit`, helper 1.7.0): `answer` clicks a button
   *  (or runs the countdown out); `closed` once the daemon cancelled it (the card was answered first). */
  readonly prompts: Array<{ params: Record<string, unknown>; answer(a: "switch" | "refuse" | "expired"): void; closed: boolean; cancel(): void }> = [];
  private nextTarget = 1;
  private nextSnap = 1;
  private nextShot = 1;
  readonly targets = new Map<string, FakeApp>();
  /** Per-method overrides (throw `FakeHelperError` for a typed error). */
  readonly handlers: Record<string, Handler> = {};
  private readonly conns = new Set<{ deliver(line: string): void; close(): void }>();

  readonly transport: HelperTransport = {
    connect: async () => {
      if (!this.running) throw new Error("ECONNREFUSED");
      return this.open();
    },
  };
  readonly launcher: HelperLauncher = {
    installed: () => this.installed,
    launch: async (appPath) => { this.launched.push(appPath); this.running = true; },
  };
  readonly verifier: HelperVerifier = () => this.verifyOk;
  /** The daemon's `terminate` seam: SIGTERM to an outdated helper — it quits (its socket stops answering). */
  readonly terminate = (pid: number): void => {
    this.terminated.push(pid);
    this.quit();
    this.onTerminate?.(pid);
  };

  calls(method: string): Array<Record<string, unknown>> {
    return this.requests.filter((r) => r.method === method).map((r) => r.params);
  }

  /** A helper → daemon notification on every open connection. */
  notify(method: string, params: Record<string, unknown>): void {
    for (const c of this.conns) c.deliver(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  /** The helper quits: every connection closes and the socket stops answering. */
  quit(): void {
    this.running = false;
    for (const c of [...this.conns]) c.close();
  }

  private open(): HelperConnection {
    const lineHandlers: Array<(l: string) => void> = [];
    const closeHandlers: Array<() => void> = [];
    let closed = false;
    const conn = {
      deliver: (line: string) => { if (!closed) queueMicrotask(() => { for (const h of lineHandlers) h(line); }); },
      close: () => {
        if (closed) return;
        closed = true;
        this.conns.delete(conn);
        queueMicrotask(() => { for (const h of closeHandlers) h(); });
      },
    };
    this.conns.add(conn);
    return {
      write: (line) => {
        if (closed) return;
        const msg = JSON.parse(line) as { id: number; method: string; params: Record<string, unknown> };
        this.requests.push({ method: msg.method, params: msg.params ?? {} });
        void (async () => {
          try {
            const result = await this.answer(msg.method, msg.params ?? {});
            conn.deliver(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
          } catch (err) {
            const e = err instanceof FakeHelperError ? err : new FakeHelperError("unsupported", String(err));
            conn.deliver(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: e.message, data: { code: e.code, ...e.data } } }));
          }
        })();
      },
      close: () => conn.close(),
      onLine: (cb) => { lineHandlers.push(cb); },
      onClose: (cb) => { closeHandlers.push(cb); },
    };
  }

  private async answer(method: string, params: Record<string, unknown>): Promise<unknown> {
    const override = this.handlers[method];
    if (override !== undefined) return await override(params);
    switch (method) {
      case "hello": return { protocol: this.helloProtocol, helperVersion: this.helperVersion, pid: this.pid };
      case "status": return { helperVersion: this.helperVersion, permissions: { accessibility: true, screenRecording: false } };
      case "permissions.request": return { opened: true };
      case "apps.list": return { apps: this.apps.map((a) => ({ name: a.name, bundleId: a.bundleId, running: a.running, ...(a.running ? { pid: a.pid } : {}) })) };
      case "screen.windows": return { windows: this.apps.filter((a) => a.running).map((a, i) => ({ app: a.name, bundleId: a.bundleId, pid: a.pid, windowId: 100 + i, title: `${a.name} window`, frame: [0, 0, 800, 600], onScreen: true })) };
      case "target.bind": {
        const want = String(params.app);
        // By bundle id, name, or an .app PATH (the daemon binds a path it resolved itself).
        const app = this.apps.find((a) => a.bundleId === want || a.name === want || want.endsWith(`/${a.name}.app`));
        if (app === undefined) throw new FakeHelperError("invalid_params", `no app ${want}`);
        const targetId = `t${this.nextTarget++}`;
        this.targets.set(targetId, app);
        return { targetId, app: { name: app.name, bundleId: app.bundleId, pid: app.pid }, window: { id: 7, title: `${app.name} window`, frame: [0, 0, 800, 600] } };
      }
      case "target.snapshot": {
        const app = this.targets.get(String(params.targetId));
        if (app === undefined) throw new FakeHelperError("target_lost", "gone");
        const snapshotId = `snap${this.nextSnap++}`;
        const isDiff = params.since !== undefined && params.full !== true;
        const text = isDiff ? `${app.name} — focused [14] · settled 80 ms\n~ [14] value "a" → "b"` : `${app.name} — window "${app.name} window" · focused [14] · settled 120 ms\n[1] window "${app.name} window"\n  [14] text area value="a" (focused)`;
        return { snapshotId, text, isDiff, changedRatio: isDiff ? 0.1 : 1, settled: true, waitedMs: params.settle === undefined ? 0 : 40 };
      }
      case "target.find": return { elements: [{ ref: 14, role: "text area", value: "a" }] };
      case "target.screenshot":
      case "screen.screenshot": {
        const shotId = `shot${this.nextShot++}`;
        return { imageBase64: Buffer.from(`jpeg-${shotId}`).toString("base64"), mime: "image/jpeg", width: 800, height: 600, pointsWidth: 1512, pointsHeight: 949, shotId, settled: true, waitedMs: 0 };
      }
      case "screen.appAt": return { app: "Notes", bundleId: "com.apple.Notes", windowId: 7 };
      case "target.act": return { rung: 1 };
      case "target.waitIdle": return { settled: true, waitedMs: 30 };
      case "target.waitFor": return { met: true, waitedMs: 12 };
      case "target.windows": return { windows: [{ id: 7, title: "w", focused: true }] };
      case "target.useWindow": return { window: { id: 8, title: "other", frame: [0, 0, 1, 1] } };
      case "prompt.desktopVisit":
        return await new Promise((resolve, reject) => {
          const entry = {
            params, closed: false,
            answer: (a: "switch" | "refuse" | "expired") => { if (!entry.closed) { entry.closed = true; resolve({ answer: a }); } },
            cancel: () => { if (!entry.closed) { entry.closed = true; reject(new FakeHelperError("cancelled", "cancelled")); } },
          };
          this.prompts.push(entry);
        });
      case "cancel":
        // `cancel {callId}` stops that call's in-flight requests (here: an on-screen prompt the daemon closed).
        for (const p of this.prompts) if (!p.closed && p.params.callId === params.callId) p.cancel();
        return {};
      case "target.release":
      case "turn.ended":
      case "session.ended":
      case "script.active":
        return {};
      default: throw new FakeHelperError("unsupported", method);
    }
  }
}
