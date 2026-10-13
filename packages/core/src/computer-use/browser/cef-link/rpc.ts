// ComputerV2 Phase 2 — the daemon side of Winter.app's BROWSER LINK (spine §5): the four `browserLink.*` requests the
// app makes, and the link's lifetime. The app opens a dedicated harness connection (clientName "browser-link") once
// its main connection is up, attaches, and keeps it for its life; the daemon writes `browserLink.command`
// notifications on it and the app answers each with `browserLink.result`, streams the subscribed events in batches
// and reports tabs that went away. It never attaches to a session, and nothing on it is a `SessionEvent`.
//
// Protocol 2 (Phase 3) adds the app's `browserLink.download` (one download a tab's own handler saved, or refused).
// HARNESS ROLE ONLY (the IPC server checks it before calling here), never in the remote or plugin allowlists. A second
// attach replaces the first: the older connection is told `browserLink.detached { reason: "replaced" }` and the daemon
// stops using it. When the link's connection closes, every command in flight fails `disconnected` and the built-in
// browser reads "Winter isn't running".
import { randomBytes } from "node:crypto";
import {
  BROWSER_LINK_FEATURES, BrowserLinkAttachParams, BrowserLinkDownloadParams, BrowserLinkEventsParams, BrowserLinkHeadlessParams, BrowserLinkResultParams,
  BrowserLinkTabGoneParams, METHODS,
} from "@yanlinglabs/winter-protocol";
import type { BrowserBackendRegistry } from "../registry";
import { BROWSER_LINK_PROTOCOL, CefTransport, type CefTransportOptions, type HeadlessShowParams, type HeadlessTabRow, type LinkPeer } from "./cef-transport";

export { BROWSER_LINK_PROTOCOL } from "./cef-transport";

/** A refusal the IPC server turns into a typed JSON-RPC error (`data.code`). */
export class BrowserLinkRpcError extends Error {
  constructor(readonly code: "invalid_params" | "protocol_mismatch" | "not_found" | "headless_unavailable" | "headless_refused", message: string, readonly data: Record<string, unknown> = {}) {
    super(message);
    this.name = "BrowserLinkRpcError";
  }
}

/** Feature `headless`: what the person's actions in the panel reach (the headless pool's presentations). */
export interface HeadlessLinkActions {
  list(sessionId: string): Promise<HeadlessTabRow[]>;
  act(sessionId: string, tabId: string, action: "watch" | "takeOver" | "handBack" | "done" | "stopWaiting" | "close"): Promise<void>;
}

/** Feature `headless`, the daemon's side: the app's panel as a viewer of headless tabs — absent while the link is down
 *  or the app did not name the feature. */
export interface HeadlessViewer {
  show(p: HeadlessShowParams): Promise<void>;
  hide(p: { sessionId: string; tabId: string; reason: string }): Promise<void>;
  tabs(p: { sessionId: string; tabs: HeadlessTabRow[] }): void;
  update(p: { sessionId: string; tabId: string; purpose: HeadlessShowParams["purpose"] }): void;
}

export interface BrowserLinkDeps extends CefTransportOptions {
  registry: BrowserBackendRegistry;
  /** Feature `headless`: the person's panel actions on headless tabs (the pool). */
  headless?: HeadlessLinkActions;
}

interface Link { linkId: string; conn: object; peer: LinkPeer; transport: CefTransport; unregister(): void }

export class BrowserLink {
  private current?: Link;

  constructor(private readonly deps: BrowserLinkDeps) {}

  /** Is Winter.app's link up now? */
  get connected(): boolean { return this.current !== undefined && this.current.transport.connected; }

  /** Feature `headless`: the app's panel as a viewer, while the link is up and the app named the feature. */
  headlessViewer(): HeadlessViewer | undefined {
    const c = this.current;
    if (c === undefined || !c.transport.connected || !c.transport.appFeatures.has("headless")) return undefined;
    const t = c.transport;
    return { show: (p) => t.headlessShow(p), hide: (p) => t.headlessHide(p), tabs: (p) => t.headlessTabs(p), update: (p) => t.headlessUpdate(p) };
  }

  /** Why there is no headless viewer now (for the model's sentence), or undefined when there is one. */
  headlessViewerMissing(): string | undefined {
    const c = this.current;
    if (c === undefined || !c.transport.connected) return "Winter isn't running — ask the user to open Winter";
    if (!c.transport.appFeatures.has("headless")) return "this Winter's app can't show a headless tab — ask the user to update Winter";
    return undefined;
  }

  /** One `browserLink.*` request from connection `conn`; `write` sends a notification back on that connection. */
  handle(conn: object, write: (message: Record<string, unknown>) => void, method: string, params: unknown): Record<string, unknown> | Promise<Record<string, unknown>> {
    switch (method) {
      case METHODS.browserLinkAttach: {
        const p = parse(BrowserLinkAttachParams, params);
        return this.attach(conn, { write }, p);
      }
      case METHODS.browserLinkResult: {
        const p = parse(BrowserLinkResultParams, params);
        const link = this.linkFor(conn, p.linkId);
        if (link !== undefined) link.transport.settle(p.cmdId, p.ok ? { ok: true, result: p.result } : { ok: false, error: p.error });
        return {};
      }
      case METHODS.browserLinkEvents: {
        const p = parse(BrowserLinkEventsParams, params);
        const link = this.linkFor(conn, p.linkId);
        if (link !== undefined) for (const e of p.events) link.transport.dispatch(e);
        return {};
      }
      case METHODS.browserLinkTabGone: {
        const p = parse(BrowserLinkTabGoneParams, params);
        this.linkFor(conn, p.linkId)?.transport.tabGone(p.tabId, p.reason);
        return {};
      }
      case METHODS.browserLinkDownload: {
        const p = parse(BrowserLinkDownloadParams, params);
        const d = p.download;
        this.linkFor(conn, p.linkId)?.transport.downloadReported(p.tabId, {
          id: d.id, state: d.state, name: d.name, bytes: d.bytes,
          ...(d.url === undefined ? {} : { url: d.url }), ...(d.path === undefined ? {} : { path: d.path }),
          ...(d.totalBytes === undefined ? {} : { totalBytes: d.totalBytes }), ...(d.mime === undefined ? {} : { mime: d.mime }),
          ...(d.error === undefined ? {} : { error: d.error }),
        });
        return {};
      }
      case METHODS.browserLinkHeadless: {
        const p = parse(BrowserLinkHeadlessParams, params);
        const link = this.linkFor(conn, p.linkId);
        if (link === undefined) throw new BrowserLinkRpcError("invalid_params", "not the live browser link");
        if (!link.transport.appFeatures.has("headless")) throw new BrowserLinkRpcError("invalid_params", "the app did not name the headless feature at attach");
        return this.headlessAction(p);
      }
      default:
        throw new BrowserLinkRpcError("invalid_params", `${method} is not a browser link method`);
    }
  }

  private async headlessAction(p: { sessionId: string; tabId?: string | undefined; action: string }): Promise<Record<string, unknown>> {
    const h = this.deps.headless;
    if (h === undefined) throw new BrowserLinkRpcError("headless_unavailable", "Winter's headless browser is not available");
    if (p.action === "list") return { tabs: await h.list(p.sessionId) };
    if (p.tabId === undefined) throw new BrowserLinkRpcError("invalid_params", `${p.action} names a tab`);
    await h.act(p.sessionId, p.tabId, p.action as "watch" | "takeOver" | "handBack" | "done" | "stopWaiting" | "close");
    return {};
  }

  private attach(conn: object, peer: LinkPeer, p: { protocol: number; appVersion: string; pid: number; features?: string[] | undefined }): { linkId: string; protocol: number; features: string[] } {
    if (p.protocol !== BROWSER_LINK_PROTOCOL) {
      this.deps.registry.noteUnavailable({
        family: "winter", name: "Winter (built-in)",
        reason: p.protocol < BROWSER_LINK_PROTOCOL ? "Winter's app is older than its daemon — ask the user to update Winter" : "Winter's app is newer than its daemon — ask the user to update Winter",
      });
      throw new BrowserLinkRpcError("protocol_mismatch", `the browser link speaks protocol ${BROWSER_LINK_PROTOCOL}, not ${p.protocol}`, { code: "protocol_mismatch", expected: BROWSER_LINK_PROTOCOL });
    }
    const old = this.current;
    if (old !== undefined) {
      this.current = undefined;
      try { old.peer.write({ jsonrpc: "2.0", method: METHODS.browserLinkDetached, params: { linkId: old.linkId, reason: "replaced" } }); } catch { /* it may be gone already */ }
      old.transport.close();
      old.unregister();
    }
    const linkId = `bl_${randomBytes(6).toString("hex")}`;
    const transport = new CefTransport(linkId, peer, this.deps);
    // The features both sides name are the ones used.
    const ours: readonly string[] = BROWSER_LINK_FEATURES;
    transport.appFeatures = new Set((p.features ?? []).filter((f) => ours.includes(f)));
    const reg = this.deps.registry.register(transport, { family: "winter", name: "Winter (built-in)", instanceKey: "winter" });
    this.current = { linkId, conn, peer, transport, unregister: reg.unregister };
    this.deps.log?.(`computer-use: Winter's browser link attached (app ${p.appVersion.slice(0, 40)}, pid ${p.pid}${transport.appFeatures.size > 0 ? `, ${[...transport.appFeatures].join(", ")}` : ""})`);
    return { linkId, protocol: BROWSER_LINK_PROTOCOL, features: [...ours] };
  }

  /** The live link, if `conn` is it and `linkId` names it — anything else is a stale or foreign link, dropped. */
  private linkFor(conn: object, linkId: string): Link | undefined {
    const c = this.current;
    return c !== undefined && c.conn === conn && c.linkId === linkId ? c : undefined;
  }

  /** The IPC connection closed: if it carried the link, the built-in browser is gone until the app attaches again. */
  connectionClosed(conn: object): void {
    const c = this.current;
    if (c === undefined || c.conn !== conn) return;
    this.current = undefined;
    c.transport.close();
    c.unregister();
    this.deps.log?.("computer-use: Winter's browser link closed");
  }

  /** Daemon stop. */
  stop(): void {
    const c = this.current;
    this.current = undefined;
    if (c === undefined) return;
    c.transport.close();
    c.unregister();
  }
}

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ message: string; path: PropertyKey[] }> } } }, params: unknown): T {
  const r = schema.safeParse(params);
  if (!r.success) throw new BrowserLinkRpcError("invalid_params", r.error.issues.slice(0, 3).map((i) => `${i.path.map(String).join(".") || "params"}: ${i.message}`).join("; "));
  return r.data;
}
