// ComputerV2 (2026-10-08) — the daemon's ONE connection to the "Winter Computer Use" helper, shared by every
// session. Lazily opened on the first call that needs it:
//
//   1. connect to `<home>/run/computer-use.sock`; when nothing answers, LAUNCH the helper through
//      LaunchServices BY PATH (`open -g -a <app>` — never a child of the daemon, or TCC would check the
//      daemon's grants; `protocol.ts`'s `helperAppPathFor`) and retry for up to 5 s;
//   2. `hello {protocol: 1, client: "daemon", home}` → `{protocol, helperVersion, pid}`;
//   3. VERIFY the helper: `pid`'s running code against the helper's designated requirement
//      (`helper-verify.ts`). A mismatch closes the connection and fails `helper_unavailable`.
//      A helper speaking another protocol (its `protocol_mismatch` refusal, or another number in its `hello`
//      result) is the typed `HelperProtocolMismatchError` — "too old/too new for this Winter — update Winter",
//      never retried — and `status()` reports it (apple/ComputerUse/PROTOCOL.md, "Compatibility").
//
// Every failure to reach it is the typed `HelperUnavailableError` (retryable): the next call tries again, and
// a relaunched helper starts with no targets — the service turns that into `TargetLost` on the next use.
//
// ONE persistent connection per daemon: the helper releases a session's targets when the last connection that
// used the session closes, so a connection per call would drop every binding. The helper also idle-quits (10
// minutes with no targets, mirrors or running scripts), connection or not: a closed connection is "the helper
// is gone" — `onDisconnect` clears the helper-side state, and the next call relaunches it.
//
// The transport, the launcher and the verifier are injectable: tests drive a FAKE helper end to end and never
// launch an app or touch TCC. In production the client launches nothing unless the daemon runs on its
// profile's own default home (the helper serves only that home, by its bundle id), so a test daemon on a temp
// home can never start the real helper.
import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { WinterProfile } from "../profile";
import { processSatisfiesRequirement } from "./helper-verify";
import {
  HELPER_MAX_RESPONSE_LINE, HELPER_PROTOCOL, HelperProtocolMismatchError, HelperRpcError, HelperUnavailableError, helperAppPathFor,
  helperBundleIdFor, helperRequirementFor, helperSocketPath, type HelloResult, type HelperNotification, type HelperPermissions,
  type HelperProtocolMismatch, type StatusResult,
} from "./protocol";

export interface HelperConnection {
  write(line: string): void;
  close(): void;
  onLine(cb: (line: string) => void): void;
  onClose(cb: () => void): void;
}
export interface HelperTransport { connect(socketPath: string): Promise<HelperConnection> }
export interface HelperLauncher {
  /** Is the helper app at `appPath`? */
  installed(appPath: string): boolean;
  /** Launch the app at `appPath` through LaunchServices. */
  launch(appPath: string): Promise<void>;
}
export type HelperVerifier = (pid: number, requirement: string) => boolean;

export interface HelperClientDeps {
  home: string;
  profile: WinterProfile;
  transport?: HelperTransport;
  launcher?: HelperLauncher;
  verifier?: HelperVerifier;
  /** May the client LAUNCH the helper? Production passes "the daemon runs on its profile's default home". */
  launchAllowed: boolean;
  /** The helper app to launch (default `helperAppPathFor(profile)`). */
  appPath?: string;
  /** How long to wait for the socket after a launch (spec §3.4: 5 s). */
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  onNotification?: (n: HelperNotification) => void;
  /** The connection closed (helper quit or crashed): every target it held is gone. */
  onDisconnect?: () => void;
  log?: (line: string) => void;
}

const CONNECT_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 120_000;
const CANCEL_GRACE_MS = 1_000;

/** The real transport: a Unix-socket NDJSON stream with a 16 MiB line cap. */
export const unixSocketTransport: HelperTransport = {
  connect: (socketPath) => new Promise((resolve, reject) => {
    const sock = createConnection({ path: socketPath });
    let buf = "";
    const lineHandlers: Array<(l: string) => void> = [];
    const closeHandlers: Array<() => void> = [];
    let closed = false;
    const fireClose = (): void => { if (closed) return; closed = true; for (const h of closeHandlers) h(); };
    sock.once("connect", () => {
      sock.removeAllListeners("error");
      sock.on("error", () => fireClose());
      sock.on("close", () => fireClose());
      sock.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim()) for (const h of lineHandlers) h(line);
        }
        // A response line over the cap is a protocol violation: drop the connection.
        if (buf.length > HELPER_MAX_RESPONSE_LINE) { buf = ""; sock.destroy(); }
      });
      resolve({
        write: (line) => { if (!closed) sock.write(line); },
        close: () => { sock.destroy(); fireClose(); },
        onLine: (cb) => { lineHandlers.push(cb); },
        onClose: (cb) => { closeHandlers.push(cb); },
      });
    });
    sock.once("error", (err) => reject(err));
  }),
};

/** The real launcher: LaunchServices BY PATH, in the background (`-g`). Never hidden (`-j`): a hidden app's windows
 *  are never drawn, and the helper's agent cursor is one. */
export const launchServicesLauncher: HelperLauncher = {
  installed: (appPath) => {
    try { return existsSync(join(appPath, "Contents", "Info.plist")); } catch { return false; }
  },
  launch: (appPath) => new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/open", ["-g", "-a", appPath], { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`open exited ${code}`))));
  }),
};

interface Pending { resolve(v: unknown): void; reject(e: unknown): void; timer: ReturnType<typeof setTimeout> }

export interface HelperStatus {
  installed: boolean; running: boolean; version?: string; permissions?: HelperPermissions;
  /** The running helper speaks another protocol: nothing works until Winter is updated. */
  protocolMismatch?: HelperProtocolMismatch;
}

export class HelperClient {
  private conn: HelperConnection | undefined;
  private connecting: Promise<HelperConnection> | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private helperVersion: string | undefined;
  /** The last handshake's protocol mismatch, until a handshake succeeds. */
  private lastMismatch: HelperProtocolMismatch | undefined;
  private permissionsCache: HelperPermissions | undefined;
  private closedByUs = false;
  private connectionGeneration = 0;
  private connectingLaunches = false;
  private readonly transport: HelperTransport;
  private readonly launcher: HelperLauncher;
  private readonly verifier: HelperVerifier;
  readonly bundleId: string;
  readonly appPath: string;

  constructor(private readonly deps: HelperClientDeps) {
    this.transport = deps.transport ?? unixSocketTransport;
    this.launcher = deps.launcher ?? launchServicesLauncher;
    this.verifier = deps.verifier ?? processSatisfiesRequirement;
    this.bundleId = helperBundleIdFor(deps.profile);
    this.appPath = deps.appPath ?? helperAppPathFor(deps.profile);
  }

  get connected(): boolean { return this.conn !== undefined; }
  /** Bumped on every verified connection — a run tells `script.active` again on a helper relaunched mid-run. */
  get generation(): number { return this.connectionGeneration; }
  get version(): string | undefined { return this.helperVersion; }
  get permissions(): HelperPermissions | undefined { return this.permissionsCache; }

  private log(line: string): void { this.deps.log?.(line); }

  /** Connected and verified, launching the helper if needed. Throws `HelperUnavailableError`. */
  ensure(): Promise<HelperConnection> {
    if (this.conn !== undefined) return Promise.resolve(this.conn);
    // A `status()` connect in flight does not launch: wait for it, then launch if it found nothing.
    if (this.connecting !== undefined && !this.connectingLaunches) return this.connecting.then((c) => c, () => this.ensure());
    return this.connecting ?? this.startConnect(true);
  }

  private startConnect(launch: boolean): Promise<HelperConnection> {
    this.connectingLaunches = launch;
    const p: Promise<HelperConnection> = this.open(launch).finally(() => { if (this.connecting === p) this.connecting = undefined; });
    this.connecting = p;
    return p;
  }

  /** The single-flight connect WITHOUT a launch (`status()`): joins a connect already in flight, never opens a
   *  second connection beside it (the review's helper-client minor), and never starts the helper. */
  private connectIfRunning(): Promise<HelperConnection | undefined> {
    if (this.conn !== undefined) return Promise.resolve(this.conn);
    return (this.connecting ?? this.startConnect(false)).then((c) => c, () => undefined);
  }

  private async open(launch: boolean): Promise<HelperConnection> {
    const socketPath = helperSocketPath(this.deps.home);
    let conn = await this.tryConnect(socketPath);
    if (conn === undefined) {
      if (!launch) throw new HelperUnavailableError("Winter Computer Use is not running");
      if (!this.deps.launchAllowed) {
        throw new HelperUnavailableError("Winter Computer Use is not running, and this daemon does not launch it (it serves only the profile's own Winter home)", false);
      }
      if (!this.launcher.installed(this.appPath)) {
        throw new HelperUnavailableError(this.deps.profile === "dev"
          ? "Winter Computer Use Dev is not built — run `bun run dev:helper`, then try again"
          : "Winter Computer Use is not installed — reinstall Winter, then try again", false);
      }
      try { await this.launcher.launch(this.appPath); } catch (err) {
        throw new HelperUnavailableError(`Winter Computer Use could not be launched (${err instanceof Error ? err.message : "error"})`);
      }
      const deadline = Date.now() + (this.deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
      while (conn === undefined && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        conn = await this.tryConnect(socketPath);
      }
      if (conn === undefined) throw new HelperUnavailableError("Winter Computer Use did not start in time");
    }
    return await this.handshake(conn);
  }

  private async tryConnect(socketPath: string): Promise<HelperConnection | undefined> {
    try { return await this.transport.connect(socketPath); } catch { return undefined; }
  }

  private async handshake(conn: HelperConnection): Promise<HelperConnection> {
    conn.onLine((line) => this.onLine(line));
    conn.onClose(() => this.onClose(conn));
    let hello: HelloResult;
    try {
      hello = await this.send(conn, "hello", { protocol: HELPER_PROTOCOL, client: "daemon", home: this.deps.home }, 5_000) as HelloResult;
    } catch (err) {
      this.drop(conn);
      if (err instanceof HelperRpcError && err.code === "protocol_mismatch") {
        // The helper refused OUR number; `data.expected` is its own (absent: a hello it could not read at all).
        const expected = typeof err.data.expected === "number" ? err.data.expected : undefined;
        throw this.mismatch(expected, typeof err.data.helperVersion === "string" ? err.data.helperVersion : undefined);
      }
      if (err instanceof HelperRpcError) throw new HelperUnavailableError(`Winter Computer Use refused the connection (${err.code})`, false);
      throw err instanceof HelperUnavailableError ? err : new HelperUnavailableError("Winter Computer Use did not answer its handshake");
    }
    if (hello?.protocol !== HELPER_PROTOCOL) {
      this.drop(conn);
      throw this.mismatch(typeof hello?.protocol === "number" ? hello.protocol : undefined, hello?.helperVersion);
    }
    if (!this.verifier(hello.pid, helperRequirementFor(this.deps.profile))) {
      this.drop(conn);
      this.log(`computer-use: the process on ${helperSocketPath(this.deps.home)} (pid ${hello.pid}) is not a verified Winter Computer Use — connection closed`);
      throw new HelperUnavailableError("the process answering on the computer-use socket is not a verified Winter Computer Use", false);
    }
    this.helperVersion = hello.helperVersion;
    this.lastMismatch = undefined;
    this.conn = conn;
    this.connectionGeneration++;
    this.closedByUs = false;
    this.log(`computer-use: connected to Winter Computer Use ${hello.helperVersion} (pid ${hello.pid})`);
    return conn;
  }

  /** A typed mismatch, remembered for `status()` and logged once per distinct mismatch. */
  private mismatch(helperProtocol: number | undefined, helperVersion: string | undefined): HelperProtocolMismatchError {
    const err = new HelperProtocolMismatchError(helperProtocol, helperVersion);
    if (this.lastMismatch?.message !== err.mismatch.message || this.lastMismatch?.helperVersion !== err.mismatch.helperVersion) {
      this.log(`computer-use: ${err.message}${helperVersion === undefined ? "" : ` (Winter Computer Use ${helperVersion})`}`);
    }
    this.lastMismatch = err.mismatch;
    return err;
  }

  private drop(conn: HelperConnection): void {
    this.closedByUs = true;
    try { conn.close(); } catch { /* already closed */ }
  }

  private send(conn: HelperConnection, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HelperUnavailableError(`Winter Computer Use did not answer ${method} in time`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { conn.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new HelperUnavailableError(`the connection to Winter Computer Use failed (${err instanceof Error ? err.message : "error"})`));
      }
    });
  }

  private onLine(line: string): void {
    let msg: { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown }; method?: unknown; params?: unknown };
    try { msg = JSON.parse(line); } catch { return; }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (p === undefined) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error !== undefined && msg.error !== null) {
        const data = (msg.error.data !== null && typeof msg.error.data === "object" ? msg.error.data : {}) as Record<string, unknown>;
        const code = typeof data.code === "string" ? data.code : "unsupported";
        p.reject(new HelperRpcError(code, typeof msg.error.message === "string" ? msg.error.message : code, data));
      } else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === "string") {
      const n = { method: msg.method, params: msg.params } as HelperNotification;
      if (n.method === "permissionsChanged" && n.params?.permissions !== undefined) this.permissionsCache = n.params.permissions;
      try { this.deps.onNotification?.(n); } catch { /* a handler bug never breaks the connection */ }
    }
  }

  private onClose(conn: HelperConnection): void {
    if (this.conn !== conn && this.conn !== undefined) return;
    const wasOurs = this.conn === conn;
    this.conn = undefined;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new HelperUnavailableError("Winter Computer Use went away during the call"));
    }
    if (wasOurs) {
      if (!this.closedByUs) this.log("computer-use: the connection to Winter Computer Use closed");
      try { this.deps.onDisconnect?.(); } catch { /* never breaks the close */ }
    }
  }

  /**
   * One request. `signal` aborts it: with a `callId` the helper is told to stop that work (`cancel`), and the
   * request answers `cancelled` — or fails locally after a 1 s grace if the helper does not answer.
   */
  async request<T>(method: string, params: Record<string, unknown>, opts: { signal?: AbortSignal; callId?: string; timeoutMs?: number } = {}): Promise<T> {
    // An already-cancelled call never connects, let alone launches the helper (the review's helper-client minor).
    if (opts.signal?.aborted) throw new HelperRpcError("cancelled", "cancelled");
    const conn = await this.ensure();
    const pending = this.send(conn, method, params, opts.timeoutMs ?? this.deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
    const signal = opts.signal;
    if (signal === undefined) return await pending as T;
    if (signal.aborted) {
      this.cancelOnHelper(opts.callId);
      pending.catch(() => {});
      throw new HelperRpcError("cancelled", "cancelled");
    }
    return await new Promise<T>((resolve, reject) => {
      let grace: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => {
        this.cancelOnHelper(opts.callId);
        grace = setTimeout(() => reject(new HelperRpcError("cancelled", "cancelled")), CANCEL_GRACE_MS);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      pending.then(
        (v) => { signal.removeEventListener("abort", onAbort); if (grace) clearTimeout(grace); resolve(v as T); },
        (e) => { signal.removeEventListener("abort", onAbort); if (grace) clearTimeout(grace); reject(e); },
      );
    });
  }

  private cancelOnHelper(callId: string | undefined): void {
    if (callId === undefined || this.conn === undefined) return;
    this.send(this.conn, "cancel", { callId }, 5_000).catch(() => { /* best effort */ });
  }

  /** A request whose answer nobody waits for (`turn.ended`, `session.ended`, `script.active`) — only when
   *  already connected: telling a helper that is not running anything is pointless, so never launches one. */
  tell(method: string, params: Record<string, unknown>): void {
    const conn = this.conn;
    if (conn === undefined) return;
    this.send(conn, method, params, 10_000).catch(() => { /* best effort */ });
  }

  /** What Settings → Computer Use shows. Never launches the helper; asks a connected one for its status. */
  async status(): Promise<HelperStatus> {
    let installed = false;
    try { installed = this.launcher.installed(this.appPath); } catch { installed = false; }
    // Not connected: connect only if it is already running (no launch), inside the single-flight connect.
    if (this.conn === undefined) await this.connectIfRunning();
    if (this.conn === undefined) {
      // It answered, in another protocol: running, and unusable until Winter is updated.
      if (this.lastMismatch !== undefined) return { installed, running: true, protocolMismatch: this.lastMismatch };
      return { installed, running: false };
    }
    try {
      const st = await this.request<StatusResult>("status", {}, { timeoutMs: 5_000 });
      this.permissionsCache = st.permissions;
      return { installed: true, running: true, version: st.helperVersion, permissions: st.permissions };
    } catch {
      return { installed, running: this.conn !== undefined, ...(this.helperVersion === undefined ? {} : { version: this.helperVersion }) };
    }
  }

  close(): void {
    const conn = this.conn;
    if (conn !== undefined) this.drop(conn);
  }
}
