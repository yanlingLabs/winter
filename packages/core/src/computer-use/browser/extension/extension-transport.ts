// ComputerV2 Phase 2 — `ExtensionTransport`: the browser engine's `CdpTransport` for one connected Winter for Chrome
// instance (one browser profile), reached over `<home>/run/browser.sock` through `winter-browser-host`. Every call is
// one JSON-RPC request to the extension (spine §6.4); the extension's notifications become the transport's events.
//
// The extension is where the CDP allowlist and the world rules are ENFORCED (it is the last hop before the browser and
// the only one that sees which execution contexts are the "winter" world). This side refuses a method or an event
// outside `cdp-allowlist.ts` before anything is sent, and drops an event it did not subscribe to — defense in depth,
// never the guard of record.
import { CDP_ALLOWED_EVENTS, CDP_ALLOWED_METHODS } from "../cdp-allowlist";
import { cdpEventParams } from "../cdp-reduce";
import type { WatchArmResult } from "../page-runtime/watch";
import {
  TransportError, type BackendId, type BrowserFamily, type CdpEvent, type CdpTransport, type TransportDownload, type TransportErrorCode, type TransportTab,
  type TransportWatchEvent,
} from "../transport";
import { DAEMON_TO_HOST_MAX_LINE, type ExtensionMethod } from "./protocol";

const ALLOWED_METHODS = new Set(CDP_ALLOWED_METHODS);
const ALLOWED_EVENTS = new Set(CDP_ALLOWED_EVENTS);
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
  family: BrowserFamily;
  /** Phase 3: the features the extension's hello named (`EXTENSION_FEATURES`). */
  features?: readonly string[];
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
  readonly family: BrowserFamily;
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
  private readonly doneListeners = new Set<(tabKey: string, done: boolean) => void>();
  private readonly downloadListeners = new Set<(tabKey: string, d: TransportDownload) => void>();
  private readonly watchListeners = new Set<(tabKey: string, e: TransportWatchEvent) => void>();
  /** 1.2.0: the watches this extension keeps for the engine (`tabKey|watchId`) — lost all at once if the link drops. */
  private readonly watching = new Set<string>();
  /** Phase 3: what this extension build said it can do. */
  readonly features: ReadonlySet<string>;

  // Phase 3's optional members: defined only when the extension named their feature at hello.
  present?: CdpTransport["present"];
  onUserDone?: CdpTransport["onUserDone"];
  setMuted?: CdpTransport["setMuted"];
  updateGroup?: CdpTransport["updateGroup"];
  listWindows?: CdpTransport["listWindows"];
  history?: CdpTransport["history"];
  bookmarks?: CdpTransport["bookmarks"];
  armDownloads?: CdpTransport["armDownloads"];
  onDownload?: CdpTransport["onDownload"];
  releaseDownload?: CdpTransport["releaseDownload"];
  watch?: CdpTransport["watch"];
  unwatch?: CdpTransport["unwatch"];
  onWatchEvent?: CdpTransport["onWatchEvent"];

  constructor(private readonly opts: ExtensionTransportOptions) {
    this.family = opts.family;
    this.timeouts = { ...DEFAULT_EXTENSION_TIMEOUTS, ...(opts.timeouts ?? {}) };
    const f = new Set(opts.features ?? []);
    this.features = f;
    const t = this.timeouts;
    if (f.has("present")) this.present = async (tabKey) => { await this.request("tabs.present", { tabKey }, t.command); };
    if (f.has("userDone")) this.onUserDone = (l) => { this.doneListeners.add(l); return () => { this.doneListeners.delete(l); }; };
    if (f.has("mute")) this.setMuted = async (tabKey, muted) => { await this.request("tabs.mute", { tabKey, muted }, t.command); };
    if (f.has("group")) this.updateGroup = async (o) => { await this.request("group.update", { ...o }, t.command); };
    if (f.has("windows")) {
      this.listWindows = async () => {
        const r = await this.request("windows.list", {}, t.command);
        if (!isRecord(r) || !Array.isArray(r.windows)) throw malformed("windows.list");
        return r.windows.filter(isRecord).map((w) => ({ id: Number(w.id), focused: w.focused === true, tabs: Number(w.tabs) || 0 })).filter((w) => Number.isFinite(w.id));
      };
    }
    if (f.has("history")) {
      this.history = async (q) => {
        const r = await this.request("history.search", { ...q }, t.command);
        if (!isRecord(r) || !Array.isArray(r.items)) throw malformed("history.search");
        return r.items.filter(isRecord).filter((i) => typeof i.url === "string").map((i) => ({ url: String(i.url), title: typeof i.title === "string" ? i.title : "", lastVisitTime: Number(i.lastVisitTime) || 0 }));
      };
    }
    if (f.has("bookmarks")) {
      this.bookmarks = async (q) => {
        const r = await this.request("bookmarks.search", { ...q }, t.command);
        if (!isRecord(r) || !Array.isArray(r.items)) throw malformed("bookmarks.search");
        return r.items.filter(isRecord).filter((i) => typeof i.url === "string").map((i) => ({ url: String(i.url), title: typeof i.title === "string" ? i.title : "", folder: typeof i.folder === "string" ? i.folder : "" }));
      };
    }
    if (f.has("downloads")) {
      this.armDownloads = async (tabKey, o) => { await this.request("downloads.arm", o === null ? { tabKey, subdir: null } : { tabKey, subdir: o.subdir, until: o.until, maxBytes: o.maxBytes }, t.command); };
      this.onDownload = (l) => { this.downloadListeners.add(l); return () => { this.downloadListeners.delete(l); }; };
      this.releaseDownload = async (id) => { await this.request("downloads.release", { id }, t.command); };
    }
    if (f.has("watch")) {
      this.watch = async (tabKey, spec) => {
        const r = await this.request("watch.arm", { tabKey, spec }, t.command);
        const result = parseArmResult(r);
        if (result === undefined) throw malformed("watch.arm");
        if (result.ok) this.watching.add(`${tabKey}|${spec.watchId}`);
        return result;
      };
      this.unwatch = async (tabKey, watchId) => {
        this.watching.delete(`${tabKey}|${watchId}`);
        await this.request("watch.cancel", { tabKey, watchId }, t.command);
      };
      this.onWatchEvent = (l) => { this.watchListeners.add(l); return () => { this.watchListeners.delete(l); }; };
    }
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

  async keepTab(tabKey: string, opts?: { group?: string }): Promise<void> {
    await this.request("tabs.keep", { tabKey, ...(opts?.group === undefined || !this.features.has("keepGroup") ? {} : { group: opts.group }) }, this.timeouts.command);
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
          params: cdpEventParams(method, raw),
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
        if (params.reason === "canceled_by_user") {
          // The user dismissed Chrome's "started debugging" bar: they took the tab back.
          this.gone(tabKey, "detached_by_user");
          return true;
        }
        // Any other detach (the extension's idle detach, the page going where the debugger cannot follow) leaves a tab
        // that is still open and can be attached again — never "gone". The engine hears it as the debugger's own
        // `Inspector.detached` on the tab's top-level session (delivered whatever the subscription: it ends them all)
        // and re-attaches when it next needs the tab.
        this.subscriptions.delete(tabKey);
        {
          const detached: CdpEvent = { tabKey, method: "Inspector.detached", params: { reason: typeof params.reason === "string" ? params.reason : "detached" } };
          for (const l of this.eventListeners) this.safely(() => l(detached));
        }
        return true;
      case "stop.pressed":
        for (const l of this.stopListeners) this.safely(() => l(tabKey));
        return true;
      case "user.done":
        for (const l of this.doneListeners) this.safely(() => l(tabKey, params.done === true));
        return true;
      case "download": {
        const d = parseDownload(params.download);
        if (d !== undefined) for (const l of this.downloadListeners) this.safely(() => l(tabKey, d));
        return true;
      }
      case "watch.event": {
        const e = parseWatchEvent(params);
        if (e === undefined || !this.watching.has(`${tabKey}|${e.watchId}`)) return true;
        if (e.outcome === "lost") this.watching.delete(`${tabKey}|${e.watchId}`);
        for (const l of this.watchListeners) this.safely(() => l(tabKey, e));
        return true;
      }
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
    // Every watch the extension kept for the engine ends with the link (the extension takes its watchers down too).
    const watches = [...this.watching];
    this.watching.clear();
    for (const key of watches) {
      const i = key.indexOf("|");
      const e: TransportWatchEvent = { watchId: key.slice(i + 1), outcome: "lost", at: Date.now(), reason: "disconnected" };
      for (const l of this.watchListeners) this.safely(() => l(key.slice(0, i), e));
    }
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
  const { tabKey, url, title, active, agent, sessionId, lastAccessed, group, windowId } = raw;
  if (typeof tabKey !== "string" || typeof url !== "string" || typeof title !== "string" || typeof active !== "boolean" || typeof agent !== "boolean") return undefined;
  if (sessionId !== undefined && typeof sessionId !== "string") return undefined;
  return {
    tabKey, url, title, active, agent, ...(sessionId === undefined ? {} : { sessionId }),
    ...(typeof lastAccessed === "number" && Number.isFinite(lastAccessed) ? { lastAccessed } : {}),
    ...(typeof group === "string" && group.length > 0 ? { group } : {}),
    ...(typeof windowId === "number" && Number.isFinite(windowId) ? { windowId } : {}),
  };
}

const WATCH_OUTCOMES = new Set(["fired", "pressed", "lost", "url"]);
/** One `watch.event` (its strings capped; what the page said is only ever a URL or a title, redacted by the engine). */
function parseWatchEvent(raw: Record<string, unknown>): TransportWatchEvent | undefined {
  const { watchId, outcome, at, url, title, reason, own } = raw;
  if (typeof watchId !== "string" || !/^wk_[0-9a-f]{12}$/.test(watchId) || typeof outcome !== "string" || !WATCH_OUTCOMES.has(outcome)) return undefined;
  if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
  return {
    watchId, outcome: outcome as TransportWatchEvent["outcome"], at,
    ...(typeof url === "string" ? { url: url.slice(0, 4096) } : {}), ...(typeof title === "string" ? { title: title.slice(0, 300) } : {}),
    ...(typeof reason === "string" ? { reason: reason.slice(0, 40) } : {}), ...(own === true ? { own: true } : {}),
  };
}

/** The watcher's answer to `watch.arm`. */
function parseArmResult(raw: unknown): WatchArmResult | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.ok === true && (raw.installed === "new" || raw.installed === "alive") && typeof raw.doc === "number") {
    return { ok: true, installed: raw.installed, doc: raw.doc, ...(typeof raw.met === "boolean" ? { met: raw.met } : {}) };
  }
  if (raw.ok === false && (raw.reason === "met" || raw.reason === "gone" || raw.reason === "doc" || raw.reason === "noform")) return { ok: false, reason: raw.reason };
  return undefined;
}

const DOWNLOAD_STATES = new Set(["started", "progress", "done", "failed", "refused"]);
function parseDownload(raw: unknown): TransportDownload | undefined {
  if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.state !== "string" || !DOWNLOAD_STATES.has(raw.state) || typeof raw.name !== "string") return undefined;
  return {
    id: raw.id, state: raw.state as TransportDownload["state"], name: raw.name, bytes: typeof raw.bytes === "number" ? raw.bytes : 0,
    ...(typeof raw.url === "string" ? { url: raw.url } : {}), ...(typeof raw.path === "string" ? { path: raw.path } : {}),
    ...(typeof raw.totalBytes === "number" ? { totalBytes: raw.totalBytes } : {}), ...(typeof raw.mime === "string" ? { mime: raw.mime } : {}),
    ...(typeof raw.error === "string" ? { error: raw.error } : {}),
  };
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
