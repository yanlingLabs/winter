// ComputerV2 Phase 2 — the built-in browser's `CdpTransport`: Winter.app's CEF tabs, reached over the BROWSER LINK
// (`rpc.ts`). Every call is one `browserLink.command` notification the app answers with one `browserLink.result`; a
// late result is dropped by its `cmdId`. The app enforces the CDP allowlist with its own Swift copy, and so does this
// transport, before anything is written (both layers). One transport per link: a second attach (or a relaunched app)
// gets a new one, and the engine's tab drivers start over on it.
import { CDP_ALLOWED_EVENTS, CDP_ALLOWED_METHODS, CDP_NETWORK_EVENT_PARAMS } from "../cdp-allowlist";
import { TransportError, type CdpEvent, type CdpTransport, type TransportErrorCode, type TransportTab } from "../transport";

export const BROWSER_LINK_PROTOCOL = 1;
/** The ops a `browserLink.command` carries (spine §5.2). */
export type BrowserLinkOp = "tab.ensure" | "tab.release" | "tab.close" | "tabs.live" | "cdp.send" | "cdp.subscribe" | "overlay";
/** A command line is at most this long (the app's own cap); a result line rides the daemon's 8 MiB authed cap. */
export const BROWSER_LINK_COMMAND_MAX = 1024 * 1024;
export const LINK_TIMEOUTS = { send: 15_000, screenshot: 20_000, ensure: 20_000, other: 15_000 } as const;

/** Writes one JSON-RPC notification object to the app's link connection. */
export interface LinkPeer { write(message: Record<string, unknown>): void }

export interface CefTransportOptions {
  /** A panel tab's URL, for `tab.ensure` of a tab the app may never have shown. */
  tabUrl?(sessionId: string, tabId: string): string | undefined;
  timeouts?: Partial<Record<keyof typeof LINK_TIMEOUTS, number>>;
  log?(line: string): void;
}

interface Pending { op: string; resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }

/** An app error code → the transport's. `not_live` (the hold should prevent it) and an unknown code read as the tab
 *  gone / a CDP error; `quiescent` (the app's runtime is shutting down) is the link going away. */
export function linkErrorToTransport(code: string, message: string, data: Record<string, unknown> = {}): TransportError {
  const map: Record<string, TransportErrorCode> = {
    tab_gone: "tab_gone", not_live: "tab_gone", cdp_error: "cdp_error", not_allowed: "not_allowed", timeout: "timeout",
    quiescent: "disconnected", protocol_mismatch: "protocol_mismatch", attach_refused: "attach_refused", disconnected: "disconnected",
  };
  return new TransportError(map[code] ?? "cdp_error", message, data);
}

export class CefTransport implements CdpTransport {
  readonly backend = "winter";
  readonly family = "winter" as const;
  connected = true;
  private nextCmd = 1;
  private readonly pending = new Map<string, Pending>();
  private readonly agent = new Set<string>();
  private readonly tabSession = new Map<string, string>();
  private readonly events = new Set<(e: CdpEvent) => void>();
  private readonly gone = new Set<(tabKey: string, reason: "closed" | "crashed" | "stopped" | "detached_by_user") => void>();
  private readonly timeouts: Record<keyof typeof LINK_TIMEOUTS, number>;

  constructor(readonly linkId: string, private readonly peer: LinkPeer, private readonly opts: CefTransportOptions = {}) {
    this.timeouts = { ...LINK_TIMEOUTS, ...opts.timeouts };
  }

  // ── the link ────────────────────────────────────────────────────────────────────────────────────

  /** One command, answered by one `browserLink.result` (or a timeout; there is no cancel op). */
  command(op: BrowserLinkOp, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (!this.connected) return Promise.reject(new TransportError("disconnected", "Winter isn't running"));
    const cmdId = `c${this.nextCmd++}`;
    const message = { jsonrpc: "2.0", method: "browserLink.command", params: { linkId: this.linkId, cmdId, op, params } };
    let size: number;
    try { size = Buffer.byteLength(JSON.stringify(message)); } catch { return Promise.reject(new TransportError("not_allowed", "the command can't be encoded")); }
    if (size > BROWSER_LINK_COMMAND_MAX) return Promise.reject(new TransportError("not_allowed", `the command is too large for the browser link (${size} bytes)`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(cmdId);
        reject(new TransportError("timeout", `Winter's browser did not answer ${op} in time`));
      }, timeoutMs);
      this.pending.set(cmdId, { op, resolve, reject, timer });
      try { this.peer.write(message); } catch {
        clearTimeout(timer);
        this.pending.delete(cmdId);
        reject(new TransportError("disconnected", "Winter isn't running"));
      }
    });
  }

  /** `browserLink.result`: settle the command (an unknown or timed-out `cmdId` is dropped). */
  settle(cmdId: string, outcome: { ok: true; result: unknown } | { ok: false; error: { code: string; message: string; data?: Record<string, unknown> } }): void {
    const p = this.pending.get(cmdId);
    if (p === undefined) return;
    this.pending.delete(cmdId);
    clearTimeout(p.timer);
    if (outcome.ok) p.resolve(outcome.result);
    else p.reject(linkErrorToTransport(outcome.error.code, outcome.error.message, outcome.error.data ?? {}));
  }

  /** `browserLink.events`: forward each allowlisted event to the engine. */
  dispatch(e: { tabId: string; method: string; params: Record<string, unknown>; cdpSessionId?: string }): void {
    if (!CDP_ALLOWED_EVENTS.includes(e.method)) return;
    // The app strips Network events already; so does this side (no header, URL or body ever reaches the engine).
    const params = e.method.startsWith("Network.") ? Object.fromEntries(Object.entries(e.params).filter(([k]) => CDP_NETWORK_EVENT_PARAMS.includes(k))) : e.params;
    const ev: CdpEvent = { tabKey: e.tabId, method: e.method, params, ...(e.cdpSessionId === undefined ? {} : { cdpSessionId: e.cdpSessionId }) };
    for (const l of [...this.events]) {
      try { l(ev); } catch (err) { this.opts.log?.(`computer-use: a browser event listener failed (${err instanceof Error ? err.message : "error"})`); }
    }
  }

  /** `browserLink.tabGone`. */
  tabGone(tabId: string, reason: "closed" | "crashed" | "stopped"): void {
    this.agent.delete(tabId);
    this.tabSession.delete(tabId);
    for (const l of [...this.gone]) {
      try { l(tabId, reason); } catch { /* a listener never breaks the link */ }
    }
  }

  /** The link closed or was replaced: every command in flight fails `disconnected`. */
  close(): void {
    this.connected = false;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new TransportError("disconnected", "Winter isn't running"));
      this.pending.delete(id);
    }
  }

  // ── CdpTransport ────────────────────────────────────────────────────────────────────────────────

  async createTab(opts: { sessionId: string; sessionTitle?: string; url: string; tabKey?: string }): Promise<TransportTab> {
    if (opts.tabKey === undefined) throw new TransportError("not_allowed", "a built-in tab is minted by the daemon first");
    const r = await this.ensure({ sessionId: opts.sessionId, tabId: opts.tabKey, url: opts.url }) as { url?: string; title?: string };
    this.agent.add(opts.tabKey);
    this.tabSession.set(opts.tabKey, opts.sessionId);
    return { tabKey: opts.tabKey, url: typeof r?.url === "string" ? r.url : opts.url, title: typeof r?.title === "string" ? r.title : "", active: false, agent: true, sessionId: opts.sessionId };
  }

  /** `tab.ensure`: a hold on a built-in tab. The app's only `not_allowed` for it is its ceiling on held tabs — said so
   *  in the error's data (`holdCeiling`), for the engine's sentence. */
  private async ensure(params: Record<string, unknown>): Promise<unknown> {
    try { return await this.command("tab.ensure", params, this.timeouts.ensure); } catch (err) {
      if (err instanceof TransportError && err.code === "not_allowed") throw new TransportError("not_allowed", err.message, { ...err.data, holdCeiling: true });
      throw err;
    }
  }

  async closeTab(tabKey: string): Promise<void> {
    await this.command("tab.close", { tabId: tabKey }, this.timeouts.other);
    this.agent.delete(tabKey);
    this.tabSession.delete(tabKey);
  }

  /** Winter's built-in tabs are never auto-closed: keeping one changes nothing. */
  async keepTab(): Promise<void> {}

  async listTabs(opts?: { sessionId?: string }): Promise<TransportTab[]> {
    const r = await this.command("tabs.live", {}, this.timeouts.other) as { tabs?: Array<{ tabId: string; url?: string; title?: string }> };
    const out: TransportTab[] = [];
    for (const t of r?.tabs ?? []) {
      if (typeof t.tabId !== "string") continue;
      const sessionId = this.tabSession.get(t.tabId);
      if (opts?.sessionId !== undefined && sessionId !== opts.sessionId) continue;
      out.push({ tabKey: t.tabId, url: t.url ?? "", title: t.title ?? "", active: false, agent: this.agent.has(t.tabId), ...(sessionId === undefined ? {} : { sessionId }) });
    }
    return out;
  }

  async attach(tabKey: string, opts: { sessionId: string }): Promise<{ viewport: [w: number, h: number]; dpr: number }> {
    const url = this.opts.tabUrl?.(opts.sessionId, tabKey);
    const r = await this.ensure({ sessionId: opts.sessionId, tabId: tabKey, ...(url === undefined ? {} : { url }) }) as { viewport?: [number, number]; dpr?: number };
    this.tabSession.set(tabKey, opts.sessionId);
    const vp = Array.isArray(r?.viewport) && r.viewport.length === 2 ? r.viewport : [0, 0];
    return { viewport: [Number(vp[0]) || 0, Number(vp[1]) || 0], dpr: typeof r?.dpr === "number" && r.dpr > 0 ? r.dpr : 1 };
  }

  async detach(tabKey: string): Promise<void> {
    await this.command("tab.release", { tabId: tabKey }, this.timeouts.other);
  }

  async send<T = unknown>(tabKey: string, method: string, params: Record<string, unknown> = {}, opts: { cdpSessionId?: string; timeoutMs?: number } = {}): Promise<T> {
    if (!CDP_ALLOWED_METHODS.includes(method)) throw new TransportError("not_allowed", `${method} is not on the allowlist`);
    const timeout = opts.timeoutMs ?? (method === "Page.captureScreenshot" ? this.timeouts.screenshot : this.timeouts.send);
    const r = await this.command("cdp.send", { tabId: tabKey, method, params, ...(opts.cdpSessionId === undefined ? {} : { cdpSessionId: opts.cdpSessionId }) }, timeout) as { result?: unknown };
    return (r?.result ?? {}) as T;
  }

  async subscribe(tabKey: string, events: readonly string[]): Promise<void> {
    const bad = events.find((e) => !CDP_ALLOWED_EVENTS.includes(e));
    if (bad !== undefined) throw new TransportError("not_allowed", `${bad} is not an allowed event`);
    await this.command("cdp.subscribe", { tabId: tabKey, events: [...events] }, this.timeouts.other);
  }

  onEvent(listener: (e: CdpEvent) => void): () => void { this.events.add(listener); return () => { this.events.delete(listener); }; }
  onTabGone(listener: (tabKey: string, reason: "closed" | "crashed" | "stopped" | "detached_by_user") => void): () => void { this.gone.add(listener); return () => { this.gone.delete(listener); }; }

  /** Best effort: never throws, never awaited. */
  overlay(tabKey: string, o: { active: boolean; cursor?: { x: number; y: number; kind: "move" | "press" | "type" | "scroll" } }): void {
    if (!this.connected) return;
    void this.command("overlay", { tabId: tabKey, active: o.active, ...(o.cursor === undefined ? {} : { cursor: o.cursor }) }, this.timeouts.other).catch(() => undefined);
  }

  /** The built-in browser has no in-page Stop button (the Mac's stop button is the session's). */
  onStop(): () => void { return () => {}; }
}
