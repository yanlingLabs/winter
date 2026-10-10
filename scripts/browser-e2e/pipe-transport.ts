// TEST ONLY — a `CdpTransport` over a headless Chromium's `--remote-debugging-pipe` (fd 3 in, fd 4 out, NUL-framed
// JSON), standing in for Winter.app's link so the browser engine can be driven end to end against a real browser.
// It enforces what every real transport enforces before anything reaches the browser — `cdp-allowlist.ts`'s methods
// and events and its world rules — and strips Network events to their allowed params. Tabs are the browser's page
// targets (created and attached at the BROWSER level here, which the engine itself can never do).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { CDP_ALLOWED_EVENTS, CDP_ALLOWED_METHODS, CDP_NETWORK_EVENT_PARAMS, CDP_WORLD_NAME } from "../../packages/core/src/computer-use/browser/cdp-allowlist";
import { TransportError, type BrowserFamily, type CdpEvent, type CdpTransport, type TransportTab } from "../../packages/core/src/computer-use/browser/transport";

interface Pending { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }
interface Tab {
  tabKey: string; targetId: string; session?: string; events: Set<string>;
  /** "winter" worlds this transport itself created (`<session>:<contextId>`), and their unique ids when reported. */
  winterCtx: Set<string>; winterUnique: Map<string, string>;
  winterObjects: Set<string>; children: Set<string>; sessionId?: string; agent: boolean;
}

export class PipeTransport implements CdpTransport {
  readonly family: BrowserFamily;
  connected = true;
  /** Every method the engine asked for, for the allowlist assertion. */
  readonly sent: string[] = [];
  readonly refused: string[] = [];
  private proc?: ChildProcess;
  private out?: Writable;
  private nextId = 1;
  private buf = "";
  private readonly pending = new Map<number, Pending>();
  private readonly tabs = new Map<string, Tab>();
  private readonly bySession = new Map<string, Tab>();
  private readonly listeners = new Set<(e: CdpEvent) => void>();
  private readonly goneListeners = new Set<(tabKey: string, reason: "closed" | "crashed" | "stopped" | "detached_by_user") => void>();
  private nextTab = 1;
  private profile = "";

  constructor(readonly backend: string, family: BrowserFamily) { this.family = family; }

  async launch(chrome: string, extraArgs: string[] = []): Promise<void> {
    this.profile = mkdtempSync(join(tmpdir(), "winter-browser-e2e-profile-"));
    const args = [
      "--headless=new", "--remote-debugging-pipe", `--user-data-dir=${this.profile}`, "--no-first-run", "--no-default-browser-check",
      "--use-mock-keychain", "--password-store=basic", "--disable-background-networking", "--disable-component-update", "--disable-sync",
      "--disable-default-apps", "--mute-audio", "--hide-scrollbars", "--site-per-process", "--window-size=1200,800", ...extraArgs, "about:blank",
    ];
    const proc = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
    this.proc = proc;
    proc.stderr?.on("data", () => { /* chromium's own chatter */ });
    this.out = proc.stdio[3] as Writable;
    const input = proc.stdio[4] as Readable;
    input.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf8")));
    proc.on("exit", () => {
      this.connected = false;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new TransportError("disconnected", "the browser exited")); }
      this.pending.clear();
    });
    await this.raw("Browser.getVersion", {});
  }

  async close(): Promise<void> {
    try { await this.raw("Browser.close", {}, undefined, 3_000); } catch { /* exiting */ }
    this.proc?.kill("SIGKILL");
    try { rmSync(this.profile, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  private onData(text: string): void {
    this.buf += text;
    for (;;) {
      const i = this.buf.indexOf("\0");
      if (i < 0) break;
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      let msg: { id?: number; result?: unknown; error?: { code: number; message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
      try { msg = JSON.parse(line); } catch { continue; }
      if (typeof msg.id === "number") {
        const p = this.pending.get(msg.id);
        if (p === undefined) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error !== undefined) p.reject(new TransportError("cdp_error", msg.error.message, { cdpCode: msg.error.code, cdpMessage: msg.error.message }));
        else p.resolve(msg.result ?? {});
      } else if (typeof msg.method === "string") {
        this.onEvent_(msg.method, msg.params ?? {}, msg.sessionId);
      }
    }
  }

  private raw<T = Record<string, unknown>>(method: string, params: Record<string, unknown>, sessionId?: string, timeoutMs = 15_000): Promise<T> {
    if (!this.connected || this.out === undefined) return Promise.reject(new TransportError("disconnected", "the browser is gone"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new TransportError("timeout", `${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.out!.write(`${JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) })}\0`);
    });
  }

  private onEvent_(method: string, params: Record<string, unknown>, sessionId?: string): void {
    if (method === "Target.detachedFromTarget" && sessionId === undefined) {
      const t = this.bySession.get(String(params.sessionId));
      if (t !== undefined && t.session === params.sessionId) {
        for (const l of [...this.goneListeners]) l(t.tabKey, "closed");
      }
      return;
    }
    if (sessionId === undefined) return;
    const tab = this.bySession.get(sessionId);
    if (tab === undefined) return;
    const child = sessionId === tab.session ? undefined : sessionId;
    const sessKey = child ?? "";
    if (method === "Target.attachedToTarget" && typeof params.sessionId === "string") {
      tab.children.add(params.sessionId);
      this.bySession.set(params.sessionId, tab);
    }
    // A world counts as "winter" only when this transport made it (its own createIsolatedWorld answered that id) —
    // never by its name. Its creation event adds the unique id; its destruction ends it.
    if (method === "Runtime.executionContextCreated") {
      const c = params.context as { id: number; uniqueId?: string };
      if (tab.winterCtx.has(`${sessKey}:${c.id}`) && typeof c.uniqueId === "string") tab.winterUnique.set(c.uniqueId, `${sessKey}:${c.id}`);
    }
    if (method === "Runtime.executionContextDestroyed") {
      const unique = typeof params.executionContextUniqueId === "string" ? params.executionContextUniqueId : undefined;
      const key = unique !== undefined ? tab.winterUnique.get(unique) : `${sessKey}:${String(params.executionContextId)}`;
      if (key !== undefined) tab.winterCtx.delete(key);
      if (unique !== undefined) tab.winterUnique.delete(unique);
    }
    if (method === "Runtime.executionContextsCleared") {
      for (const k of [...tab.winterCtx]) if (k.startsWith(`${sessKey}:`)) tab.winterCtx.delete(k);
    }
    if (method === "Inspector.targetCrashed") for (const l of [...this.goneListeners]) l(tab.tabKey, "crashed");
    if (!tab.events.has(method) || !CDP_ALLOWED_EVENTS.includes(method)) return;
    let p = params;
    if (method.startsWith("Network.")) p = Object.fromEntries(Object.entries(params).filter(([k]) => CDP_NETWORK_EVENT_PARAMS.includes(k)));
    for (const l of [...this.listeners]) l({ tabKey: tab.tabKey, method, params: p, ...(child === undefined ? {} : { cdpSessionId: child }) });
  }

  private tab(tabKey: string): Tab {
    if (!this.connected) throw new TransportError("disconnected", "the browser is gone");
    const t = this.tabs.get(tabKey);
    if (t === undefined) throw new TransportError("tab_gone", "no such tab");
    return t;
  }

  /** Open a page target (not activated — headless has no front anyway). */
  async createTab(opts: { sessionId: string; url: string; tabKey?: string }): Promise<TransportTab> {
    const r = await this.raw<{ targetId: string }>("Target.createTarget", { url: opts.url, background: true });
    const tabKey = opts.tabKey ?? `t${this.nextTab++}`;
    this.tabs.set(tabKey, { tabKey, targetId: r.targetId, events: new Set(), winterCtx: new Set(), winterUnique: new Map(), winterObjects: new Set(), children: new Set(), sessionId: opts.sessionId, agent: true });
    return { tabKey, url: opts.url, title: "", active: false, agent: true, sessionId: opts.sessionId };
  }

  async closeTab(tabKey: string): Promise<void> {
    const t = this.tab(tabKey);
    await this.raw("Target.closeTarget", { targetId: t.targetId });
    this.tabs.delete(tabKey);
  }

  async keepTab(): Promise<void> { /* nothing to ungroup here */ }

  async listTabs(): Promise<TransportTab[]> {
    const r = await this.raw<{ targetInfos: Array<{ targetId: string; type: string; url: string; title: string }> }>("Target.getTargets", {});
    const out: TransportTab[] = [];
    for (const t of this.tabs.values()) {
      const info = r.targetInfos.find((i) => i.targetId === t.targetId);
      if (info !== undefined) out.push({ tabKey: t.tabKey, url: info.url, title: info.title, active: false, agent: t.agent, ...(t.sessionId === undefined ? {} : { sessionId: t.sessionId }) });
    }
    return out;
  }

  async attach(tabKey: string): Promise<{ viewport: [number, number]; dpr: number }> {
    const t = this.tab(tabKey);
    if (t.session === undefined) {
      const r = await this.raw<{ sessionId: string }>("Target.attachToTarget", { targetId: t.targetId, flatten: true });
      t.session = r.sessionId;
      this.bySession.set(r.sessionId, t);
    }
    return { viewport: [1200, 800], dpr: 1 };
  }

  async detach(tabKey: string): Promise<void> {
    const t = this.tabs.get(tabKey);
    if (t?.session === undefined) return;
    const s = t.session;
    delete t.session;
    t.winterCtx.clear();
    t.winterUnique.clear();
    t.winterObjects.clear();
    t.events.clear();
    try { await this.raw("Target.detachFromTarget", { sessionId: s }); } catch { /* gone */ }
  }

  async send<T = unknown>(tabKey: string, method: string, params: Record<string, unknown> = {}, opts: { cdpSessionId?: string; timeoutMs?: number } = {}): Promise<T> {
    const t = this.tab(tabKey);
    this.sent.push(method);
    const refuse = (why: string): never => {
      const detail = JSON.stringify({ session: opts.cdpSessionId, contextId: params.contextId, executionContextId: params.executionContextId, objectId: params.objectId, op: (params.arguments as Array<{ value?: unknown }> | undefined)?.[0]?.value, known: [...t.winterCtx] });
      this.refused.push(`${method}: ${why} ${detail}`);
      throw new TransportError("not_allowed", `${method}: ${why}`);
    };
    if (!CDP_ALLOWED_METHODS.includes(method)) refuse("not on the allowlist");
    const sessKey = opts.cdpSessionId ?? "";
    if (opts.cdpSessionId !== undefined && !t.children.has(opts.cdpSessionId)) refuse("an unknown child session");
    const winterCtx = (id: unknown): boolean => t.winterCtx.has(`${sessKey}:${String(id)}`);
    const winterUnique = (u: unknown): boolean => typeof u === "string" && t.winterUnique.has(u);
    switch (method) {
      case "Page.reload": if (params.scriptToEvaluateOnLoad !== undefined) refuse("a script to evaluate on load runs in the page's own world"); break;
      case "Page.navigate": {
        const url = typeof params.url === "string" ? params.url : "";
        if (url !== "about:blank" && !/^https?:/i.test(url)) refuse("only http(s) and about:blank navigations");
        break;
      }
      case "Runtime.evaluate": if (!(winterCtx(params.contextId) || winterUnique(params.uniqueContextId))) refuse("outside the winter world"); break;
      case "Runtime.callFunctionOn":
        if (!(winterCtx(params.executionContextId) || winterUnique(params.uniqueContextId) || (typeof params.objectId === "string" && t.winterObjects.has(params.objectId)))) refuse("outside the winter world");
        break;
      case "DOM.resolveNode": if (!winterCtx(params.executionContextId)) refuse("outside the winter world"); break;
      case "Page.createIsolatedWorld": if (params.worldName !== CDP_WORLD_NAME || params.grantUniveralAccess === true) refuse("a world other than winter"); break;
      default: break;
    }
    if (t.session === undefined) throw new TransportError("cdp_error", "not attached", { cdpMessage: "not attached" });
    const res = await this.raw<Record<string, unknown>>(method, params, opts.cdpSessionId ?? t.session, opts.timeoutMs ?? (method === "Page.captureScreenshot" ? 20_000 : 15_000));
    // The world this transport just made is "winter" (by the id it answered, not by any name).
    if (method === "Page.createIsolatedWorld" && typeof res.executionContextId === "number") t.winterCtx.add(`${sessKey}:${res.executionContextId}`);
    // Object ids minted in the winter world may be used again (the world rule's second half).
    const minted = (res.result as { objectId?: string } | undefined)?.objectId ?? (res.object as { objectId?: string } | undefined)?.objectId;
    if (typeof minted === "string" && (method === "Runtime.callFunctionOn" || method === "Runtime.evaluate" || method === "DOM.resolveNode")) t.winterObjects.add(minted);
    return res as T;
  }

  async subscribe(tabKey: string, events: readonly string[]): Promise<void> {
    const bad = events.find((e) => !CDP_ALLOWED_EVENTS.includes(e));
    if (bad !== undefined) throw new TransportError("not_allowed", `${bad} is not an allowed event`);
    this.tab(tabKey).events = new Set(events);
  }

  onEvent(listener: (e: CdpEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onTabGone(listener: (tabKey: string, reason: "closed" | "crashed" | "stopped" | "detached_by_user") => void): () => void { this.goneListeners.add(listener); return () => { this.goneListeners.delete(listener); }; }
  overlay(): void { /* no overlay in a headless test */ }
  onStop(): () => void { return () => {}; }
}
