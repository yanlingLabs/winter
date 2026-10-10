// ComputerV2 Phase 2 — `ExtensionTransport`: the browser engine's `CdpTransport` for one connected Winter for Chrome
// instance (one browser profile), reached over `<home>/run/browser.sock` through `winter-browser-host`. Every call is
// one JSON-RPC request to the extension (spine §6.4); the extension's notifications become the transport's events.
//
// The extension is where the CDP allowlist and the world rules are ENFORCED (it is the last hop before the browser and
// the only one that sees which execution contexts are the "winter" world). This side refuses a method or an event
// outside `cdp-allowlist.ts` before anything is sent, and drops an event it did not subscribe to — defense in depth,
// never the guard of record.
import { CDP_ALLOWED_EVENTS, CDP_ALLOWED_METHODS, CDP_NETWORK_EVENT_PARAMS } from "../cdp-allowlist";
import {
  TransportError, type BackendId, type BrowserFamily, type CdpEvent, type CdpTransport, type TransportErrorCode, type TransportTab,
} from "../transport";
import { DAEMON_TO_HOST_MAX_LINE, type ExtensionMethod } from "./protocol";

const ALLOWED_METHODS = new Set(CDP_ALLOWED_METHODS);
const ALLOWED_EVENTS = new Set(CDP_ALLOWED_EVENTS);
const NETWORK_PARAMS = new Set(CDP_NETWORK_EVENT_PARAMS);
const TRANSPORT_CODES = new Set<TransportErrorCode>(["disconnected", "tab_gone", "attach_refused", "not_allowed", "cdp_error", "timeout", "protocol_mismatch"]);

/** Per-request ceilings (ms). `cdp.send`'s two mirror the built-in browser's link (15 s, a screenshot 20 s). */
export interface ExtensionTimeouts {
  command: number;
  cdp: number;
  screenshot: number;
  create: number;
  attach: number;
  overlay: number;
}

export const DEFAULT_EXTENSION_TIMEOUTS: ExtensionTimeouts = { command: 10_000, cdp: 15_000, screenshot: 20_000, create: 20_000, attach: 20_000, overlay: 5_000 };

export interface ExtensionTransportOptions {
  family: Exclude<BrowserFamily, "winter">;
  /** Writes one JSON-RPC object to the host. False when the connection can no longer carry it. */
  write(message: Record<string, unknown>): boolean;
  timeouts?: Partial<ExtensionTimeouts>;
  log?(line: string): void;
}

interface Pending {
  method: ExtensionMethod;
  resolve(value: unknown): void;
  reject(err: TransportError): void;
  timer: ReturnType<typeof setTimeout>;
}

type GoneReason = "closed" | "crashed" | "stopped" | "detached_by_user";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export class ExtensionTransport implements CdpTransport {
  readonly family: Exclude<BrowserFamily, "winter">;
  private backendId: BackendId = "";
  private alive = true;
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private readonly timeouts: ExtensionTimeouts;
  /** The events the engine subscribed to, per tab (what `cdp.subscribe` last succeeded with). */
  private readonly subscriptions = new Map<string, Set<string>>();
  private readonly eventListeners = new Set<(e: CdpEvent) => void>();
  private readonly goneListeners = new Set<(tabKey: string, reason: GoneReason) => void>();
  private readonly stopListeners = new Set<(tabKey: string) => void>();

  constructor(private readonly opts: ExtensionTransportOptions) {
    this.family = opts.family;
    this.timeouts = { ...DEFAULT_EXTENSION_TIMEOUTS, ...(opts.timeouts ?? {}) };
  }

  /** The id the registry assigned (`chrome`, `chrome#2`, …), set once registered. */
  get backend(): BackendId { return this.backendId; }
  bind(id: BackendId): void { this.backendId = id; }

  get connected(): boolean { return this.alive; }

  // ── CdpTransport ───────────────────────────────────────────────────────────────────────────────────────────────

  async createTab(opts: { sessionId: string; sessionTitle?: string; url: string; tabKey?: string }): Promise<TransportTab> {
    const r = await this.request("tabs.create", { url: opts.url, sessionId: opts.sessionId, sessionTitle: opts.sessionTitle ?? "" }, this.timeouts.create);
    const tab = isRecord(r) ? parseTab(r.tab) : undefined;
    if (tab === undefined) throw malformed("tabs.create");
    return tab;
  }

  async closeTab(tabKey: string): Promise<void> {
    await this.request("tabs.close", { tabKey }, this.timeouts.command);
    this.subscriptions.delete(tabKey);
  }

  async keepTab(tabKey: string): Promise<void> {
    await this.request("tabs.keep", { tabKey }, this.timeouts.command);
  }

  async listTabs(_opts?: { sessionId?: string }): Promise<TransportTab[]> {
    // A user browser lists every tab of its profile; `sessionId` only scopes the built-in browser's strip.
    const r = await this.request("tabs.list", {}, this.timeouts.command);
    if (!isRecord(r) || !Array.isArray(r.tabs)) throw malformed("tabs.list");
    const tabs: TransportTab[] = [];
    for (const raw of r.tabs) {
      const tab = parseTab(raw);
      if (tab === undefined) throw malformed("tabs.list");
      tabs.push(tab);
    }
    return tabs;
  }

  async attach(tabKey: string, _opts: { sessionId: string }): Promise<{ viewport: [w: number, h: number]; dpr: number }> {
    const r = await this.request("debugger.attach", { tabKey }, this.timeouts.attach);
    if (!isRecord(r) || !Array.isArray(r.viewport) || r.viewport.length !== 2 || typeof r.dpr !== "number") throw malformed("debugger.attach");
    const [w, h] = r.viewport as unknown[];
    if (typeof w !== "number" || typeof h !== "number") throw malformed("debugger.attach");
    return { viewport: [w, h], dpr: r.dpr };
  }

  async detach(tabKey: string): Promise<void> {
    this.subscriptions.delete(tabKey);
    await this.request("debugger.detach", { tabKey }, this.timeouts.command);
  }

  async send<T = unknown>(tabKey: string, method: string, params: Record<string, unknown> = {}, opts: { cdpSessionId?: string; timeoutMs?: number } = {}): Promise<T> {
    if (!ALLOWED_METHODS.has(method)) throw new TransportError("not_allowed", `${method} is not in Winter's CDP allowlist`, { method });
    const timeout = opts.timeoutMs ?? (method === "Page.captureScreenshot" ? this.timeouts.screenshot : this.timeouts.cdp);
    const r = await this.request("cdp.send", { tabKey, method, params, ...(opts.cdpSessionId === undefined ? {} : { cdpSessionId: opts.cdpSessionId }) }, timeout);
    if (!isRecord(r) || !("result" in r)) throw malformed("cdp.send");
    return r.result as T;
  }

  async subscribe(tabKey: string, events: readonly string[]): Promise<void> {
    const outside = events.filter((e) => !ALLOWED_EVENTS.has(e));
    if (outside.length > 0) throw new TransportError("not_allowed", `not in Winter's CDP allowlist: ${outside.join(", ")}`, { events: outside });
    await this.request("cdp.subscribe", { tabKey, events: [...events] }, this.timeouts.command);
    this.subscriptions.set(tabKey, new Set(events));
  }

  onEvent(listener: (e: CdpEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => { this.eventListeners.delete(listener); };
  }

  onTabGone(listener: (tabKey: string, reason: GoneReason) => void): () => void {
    this.goneListeners.add(listener);
    return () => { this.goneListeners.delete(listener); };
  }

  overlay(tabKey: string, o: { active: boolean; cursor?: { x: number; y: number; kind: "move" | "press" | "type" | "scroll" } }): void {
    if (!this.alive) return;
    // Best effort, never awaited by the engine: a failure is only logged.
    this.request("overlay", { tabKey, active: o.active, ...(o.cursor === undefined ? {} : { cursor: o.cursor }) }, this.timeouts.overlay)
      .catch((err: unknown) => this.opts.log?.(`[browser-ext] overlay on ${this.backendId}:${tabKey} failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  onStop(listener: (tabKey: string) => void): () => void {
    this.stopListeners.add(listener);
    return () => { this.stopListeners.delete(listener); };
  }

  // ── the connection side (BrowserHostServer) ────────────────────────────────────────────────────────────────────

  /**
   * One object from the extension after its hello: a response to one of this transport's requests (a `d…` id), or a
   * notification. Returns false for anything else (the server answers or drops it).
   */
  handle(msg: Record<string, unknown>): boolean {
    if (typeof msg.method !== "string") {
      if (typeof msg.id !== "string") return false;
      const p = this.pending.get(msg.id);
      if (p === undefined) return true; // late (timed out) or unknown: dropped
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (isRecord(msg.error)) p.reject(errorFrom(msg.error));
      else p.resolve(msg.result);
      return true;
    }
    if (msg.id !== undefined) return false; // a request: not ours to answer
    const params = isRecord(msg.params) ? msg.params : {};
    const tabKey = typeof params.tabKey === "string" ? params.tabKey : undefined;
    if (tabKey === undefined) return true;
    switch (msg.method) {
      case "cdp.event": {
        const method = params.method;
        if (typeof method !== "string" || !ALLOWED_EVENTS.has(method) || !(this.subscriptions.get(tabKey)?.has(method) ?? false)) return true;
        const raw = isRecord(params.params) ? params.params : {};
        const event: CdpEvent = {
          tabKey,
          method,
          params: method.startsWith("Network.") ? Object.fromEntries(Object.entries(raw).filter(([k]) => NETWORK_PARAMS.has(k))) : raw,
          ...(typeof params.cdpSessionId === "string" ? { cdpSessionId: params.cdpSessionId } : {}),
        };
        for (const l of this.eventListeners) this.safely(() => l(event));
        return true;
      }
      case "tab.gone": {
        const reason = params.reason === "crashed" || params.reason === "stopped" ? params.reason : "closed";
        this.gone(tabKey, reason);
        return true;
      }
      case "debugger.detached":
        // The user cancelling Chrome's "started debugging" infobar is the user taking the tab back; any other detach
        // (the page went somewhere the debugger cannot follow, the extension's idle detach) leaves a tab that can be
        // attached again.
        this.gone(tabKey, params.reason === "canceled_by_user" ? "detached_by_user" : "stopped");
        return true;
      case "stop.pressed":
        for (const l of this.stopListeners) this.safely(() => l(tabKey));
        return true;
      default:
        return true;
    }
  }

  /** The connection closed (or was replaced): every call from now on, and every one in flight, is `disconnected`. */
  disconnect(why = "Winter for Chrome disconnected"): void {
    if (!this.alive) return;
    this.alive = false;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new TransportError("disconnected", why));
    }
    this.subscriptions.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────────────────────────

  private gone(tabKey: string, reason: GoneReason): void {
    this.subscriptions.delete(tabKey);
    for (const l of this.goneListeners) this.safely(() => l(tabKey, reason));
  }

  private safely(fn: () => void): void {
    try { fn(); } catch (err) { this.opts.log?.(`[browser-ext] a listener threw: ${err instanceof Error ? err.message : String(err)}`); }
  }

  private request(method: ExtensionMethod, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (!this.alive) return Promise.reject(new TransportError("disconnected", "Winter for Chrome is not connected"));
    const id = `d${this.nextId++}`;
    const message = { jsonrpc: "2.0", id, method, params };
    // The host hands each line to the browser as one native message, and Chrome takes at most 1 MiB from a host.
    const size = Buffer.byteLength(JSON.stringify(message)) + 1;
    if (size > DAEMON_TO_HOST_MAX_LINE) {
      return Promise.reject(new TransportError("not_allowed", `the ${method} command is ${size} bytes — more than the 1 MiB a browser takes from its native host`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new TransportError("timeout", `Winter for Chrome did not answer ${method} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      if (!this.opts.write(message)) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new TransportError("disconnected", "Winter for Chrome is not connected"));
      }
    });
  }
}

function parseTab(raw: unknown): TransportTab | undefined {
  if (!isRecord(raw)) return undefined;
  const { tabKey, url, title, active, agent, sessionId } = raw;
  if (typeof tabKey !== "string" || typeof url !== "string" || typeof title !== "string" || typeof active !== "boolean" || typeof agent !== "boolean") return undefined;
  if (sessionId !== undefined && typeof sessionId !== "string") return undefined;
  return { tabKey, url, title, active, agent, ...(sessionId === undefined ? {} : { sessionId }) };
}

function errorFrom(error: Record<string, unknown>): TransportError {
  const data = isRecord(error.data) ? { ...error.data } : {};
  const code = typeof data.code === "string" && TRANSPORT_CODES.has(data.code as TransportErrorCode) ? (data.code as TransportErrorCode) : "cdp_error";
  delete data.code;
  return new TransportError(code, typeof error.message === "string" ? error.message : "Winter for Chrome refused the command", data);
}

function malformed(method: string): TransportError {
  return new TransportError("cdp_error", `Winter for Chrome sent a malformed answer to ${method}`);
}
