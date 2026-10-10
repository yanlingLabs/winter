// ComputerV2 Phase 2 — the daemon side of Winter.app's BROWSER LINK (spine §5): the four `browserLink.*` requests the
// app makes, and the link's lifetime. The app opens a dedicated harness connection (clientName "browser-link") once
// its main connection is up, attaches, and keeps it for its life; the daemon writes `browserLink.command`
// notifications on it and the app answers each with `browserLink.result`, streams the subscribed events in batches
// and reports tabs that went away. It never attaches to a session, and nothing on it is a `SessionEvent`.
//
// HARNESS ROLE ONLY (the IPC server checks it before calling here), never in the remote or plugin allowlists. A second
// attach replaces the first: the older connection is told `browserLink.detached { reason: "replaced" }` and the daemon
// stops using it. When the link's connection closes, every command in flight fails `disconnected` and the built-in
// browser reads "Winter isn't running".
import { randomBytes } from "node:crypto";
import {
  BrowserLinkAttachParams, BrowserLinkEventsParams, BrowserLinkResultParams, BrowserLinkTabGoneParams, METHODS,
} from "@yanlinglabs/winter-protocol";
import type { BrowserBackendRegistry } from "../registry";
import { BROWSER_LINK_PROTOCOL, CefTransport, type CefTransportOptions, type LinkPeer } from "./cef-transport";

export { BROWSER_LINK_PROTOCOL } from "./cef-transport";

/** A refusal the IPC server turns into a typed JSON-RPC error (`data.code`). */
export class BrowserLinkRpcError extends Error {
  constructor(readonly code: "invalid_params" | "protocol_mismatch", message: string, readonly data: Record<string, unknown> = {}) {
    super(message);
    this.name = "BrowserLinkRpcError";
  }
}

export interface BrowserLinkDeps extends CefTransportOptions {
  registry: BrowserBackendRegistry;
}

interface Link { linkId: string; conn: object; peer: LinkPeer; transport: CefTransport; unregister(): void }

export class BrowserLink {
  private current?: Link;

  constructor(private readonly deps: BrowserLinkDeps) {}

  /** Is Winter.app's link up now? */
  get connected(): boolean { return this.current !== undefined && this.current.transport.connected; }

  /** One `browserLink.*` request from connection `conn`; `write` sends a notification back on that connection. */
  handle(conn: object, write: (message: Record<string, unknown>) => void, method: string, params: unknown): Record<string, unknown> {
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
      default:
        throw new BrowserLinkRpcError("invalid_params", `${method} is not a browser link method`);
    }
  }

  private attach(conn: object, peer: LinkPeer, p: { protocol: number; appVersion: string; pid: number }): { linkId: string; protocol: number } {
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
    const reg = this.deps.registry.register(transport, { family: "winter", name: "Winter (built-in)", instanceKey: "winter" });
    this.current = { linkId, conn, peer, transport, unregister: reg.unregister };
    this.deps.log?.(`computer-use: Winter's browser link attached (app ${p.appVersion.slice(0, 40)}, pid ${p.pid})`);
    return { linkId, protocol: BROWSER_LINK_PROTOCOL };
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
