// Winter for Chrome — what the extension does for Winter's browser engine: the daemon's requests (spine §6.4) and the
// browser's events, turned into each other.
//
// The rules it keeps whatever it is asked:
//  - It never moves the user's view: tabs open with `active: false`, in the session's Winter group; nothing here can
//    activate a tab or focus a window (the `ChromeApi` it is given has no such call).
//  - It never reads a site's cookies or storage, and runs page code only in the "winter" world (the guard).
//  - The debugger is attached only while the daemon has the tab bound — and is detached after 5 minutes without a
//    command, and whenever the link to Winter drops.
//  - It closes only Winter's own tabs (an agent tab, by tab id — pinned or moved, until `keep()`), and only when the
//    daemon says so: it never decides by itself that a tab should close. Closing ungroups the tab first, so a group's
//    last tab never leaves an empty (or a saved) group behind.
import type { ChromeApi, ChromeTab, Clock, DebuggerTarget, MessageSender } from "./chrome-api";
import { realClock } from "./chrome-api";
import { AgentBook, groupTitle } from "./groups";
import { isAllowedEvent, strippedParams, TabGuard } from "./guard";
import { drawOverlay } from "./overlay";
import type { ErrorCode, WireTab } from "./protocol";
import { attachRefusal, openable } from "./urls";

/** A typed refusal: the daemon reads `code` as a TransportErrorCode. */
export class ExtensionError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly data: Record<string, unknown> = {}) {
    super(message);
    this.name = "ExtensionError";
  }
}

export class UnknownMethod extends Error {}

export const IDLE_DETACH_MS = 5 * 60 * 1000;
const DEBUGGER_PROTOCOL_VERSION = "1.3";

interface Attached {
  tabId: number;
  guard: TabGuard;
  subscribed: Set<string>;
  idle?: unknown;
  overlay: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface ControllerOptions {
  /** Sends one notification to the daemon. */
  notify(method: string, params: Record<string, unknown>): void;
  clock?: Clock;
  idleDetachMs?: number;
  log?(line: string): void;
}

export class ExtensionController {
  private readonly attached = new Map<number, Attached>();
  private readonly book: AgentBook;
  private readonly clock: Clock;
  private readonly idleMs: number;
  /** Tabs whose `tab.gone` was sent (ids are never reused while the browser runs). */
  private readonly goneSent = new Set<number>();

  constructor(private readonly chrome: ChromeApi, private readonly opts: ControllerOptions) {
    this.book = new AgentBook(chrome);
    this.clock = opts.clock ?? realClock;
    this.idleMs = opts.idleDetachMs ?? IDLE_DETACH_MS;
  }

  /** Loads the group book and listens to the browser. Call once, before the first request. */
  async start(): Promise<void> {
    this.chrome.debugger.onEvent.addListener((source, method, params) => this.onDebuggerEvent(source, method, params));
    this.chrome.debugger.onDetach.addListener((source, reason) => { void this.onDebuggerDetach(source, reason); });
    this.chrome.tabs.onRemoved.addListener((tabId) => this.onTabRemoved(tabId));
    this.chrome.tabGroups.onRemoved.addListener((group) => { void this.book.dropGroup(group.id); });
    await this.book.load();
  }

  /** The tab ids attached right now (tests, status). */
  attachedTabs(): number[] {
    return [...this.attached.keys()];
  }

  /** One daemon request. Throws `ExtensionError` (typed) or `UnknownMethod`. */
  async handle(method: string, rawParams: unknown): Promise<unknown> {
    const params = isRecord(rawParams) ? rawParams : {};
    switch (method) {
      case "ping": return {};
      case "tabs.list": return { tabs: await this.listTabs() };
      case "tabs.create": return { tab: await this.createTab(params) };
      case "tabs.close": await this.closeTab(this.tabId(params)); return {};
      case "tabs.keep": await this.keepTab(this.tabId(params)); return {};
      case "debugger.attach": return await this.attach(this.tabId(params));
      case "debugger.detach": await this.detach(this.tabId(params)); return {};
      case "cdp.send": return { result: await this.send(this.tabId(params), params) };
      case "cdp.subscribe": this.subscribe(this.tabId(params), params.events); return {};
      case "overlay": await this.overlay(this.tabId(params), params); return {};
      default: throw new UnknownMethod(method);
    }
  }

  /** The link to Winter dropped: nothing is bound any more, so every debugger detaches and every overlay goes. */
  async releaseAll(): Promise<void> {
    for (const tabId of [...this.attached.keys()]) await this.detach(tabId);
  }

  /** A message from one of the extension's own overlays: the user pressed Stop. */
  onRuntimeMessage(message: unknown, sender: MessageSender): boolean {
    if (!isRecord(message) || message.type !== "winter.stop") return false;
    const tabId = sender.tab?.id;
    if (sender.id !== this.chrome.runtimeId || tabId === undefined || !this.attached.has(tabId)) return false;
    this.opts.notify("stop.pressed", { tabKey: String(tabId) });
    return true;
  }

  // ── tabs ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  private tabId(params: Record<string, unknown>): number {
    const key = params.tabKey;
    const id = typeof key === "string" && /^\d{1,10}$/.test(key) ? Number(key) : Number.NaN;
    if (!Number.isSafeInteger(id)) throw new ExtensionError("tab_gone", "no such tab");
    return id;
  }

  private wire(tab: ChromeTab): WireTab {
    const sessionId = tab.id === undefined ? undefined : this.book.sessionOfTab(tab.id);
    return {
      tabKey: String(tab.id),
      url: tab.url ?? tab.pendingUrl ?? "",
      title: tab.title ?? "",
      active: tab.active,
      agent: sessionId !== undefined,
      ...(sessionId === undefined ? {} : { sessionId }),
    };
  }

  private async getTab(tabId: number): Promise<ChromeTab> {
    try {
      const tab = await this.chrome.tabs.get(tabId);
      if (tab.incognito) throw new ExtensionError("tab_gone", "Winter does not use private windows");
      return tab;
    } catch (err) {
      if (err instanceof ExtensionError) throw err;
      throw new ExtensionError("tab_gone", "the tab is closed");
    }
  }

  private async listTabs(): Promise<WireTab[]> {
    const tabs = await this.chrome.tabs.query({});
    return tabs.filter((t) => t.id !== undefined && !t.incognito).map((t) => this.wire(t));
  }

  private async createTab(params: Record<string, unknown>): Promise<WireTab> {
    const { url, sessionId } = params;
    if (!openable(url)) throw new ExtensionError("not_allowed", "Winter opens only http, https and about:blank pages");
    if (typeof sessionId !== "string" || sessionId === "") throw new ExtensionError("not_allowed", "a tab opens for a session");
    const sessionTitle = typeof params.sessionTitle === "string" ? params.sessionTitle : "";

    let groupId = this.book.groupFor(sessionId);
    let windowId: number | undefined;
    if (groupId !== undefined) {
      try {
        windowId = (await this.chrome.tabGroups.get(groupId)).windowId;
      } catch {
        await this.book.dropGroup(groupId);
        groupId = undefined;
      }
    }
    windowId ??= await this.pickWindow();
    // In the BACKGROUND: the user's active tab and window never change.
    const tab = await this.chrome.tabs.create({ url, active: false, windowId });
    if (tab.id === undefined) throw new ExtensionError("cdp_error", "the browser opened no tab");
    await this.book.addTab(tab.id, sessionId);
    if (groupId !== undefined) {
      await this.chrome.tabs.group({ tabIds: [tab.id], groupId });
    } else {
      groupId = await this.chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId } });
      const title = groupTitle(sessionTitle);
      await this.chrome.tabGroups.update(groupId, { title, color: "blue" });
      await this.book.addGroup(groupId, sessionId, title);
    }
    return this.wire({ ...tab, groupId });
  }

  /** The window a new Winter group goes into: the one the user used last, else any normal one; never a private one. */
  private async pickWindow(): Promise<number> {
    try {
      const w = await this.chrome.windows.getLastFocused({ windowTypes: ["normal"] });
      if (w.id !== undefined && !w.incognito) return w.id;
    } catch { /* none focused */ }
    const all = await this.chrome.windows.getAll({ windowTypes: ["normal"] });
    const w = all.find((x) => x.id !== undefined && !x.incognito);
    if (w?.id === undefined) throw new ExtensionError("cdp_error", "the browser has no window open — ask the user to open one");
    return w.id;
  }

  private async closeTab(tabId: number): Promise<void> {
    const tab = await this.getTab(tabId);
    if (this.book.sessionOfTab(tabId) === undefined) throw new ExtensionError("not_allowed", "Winter closes only the tabs it opened");
    await this.detach(tabId);
    // Out of its group first: closing a group's last tab would otherwise leave the browser holding the group (a saved
    // group, in browsers that save them); ungrouping the last tab removes the group with it.
    if (tab.groupId >= 0) {
      try { await this.chrome.tabs.ungroup([tabId]); } catch { /* the tab is closing anyway */ }
    }
    try {
      await this.chrome.tabs.remove(tabId);
    } catch {
      throw new ExtensionError("tab_gone", "the tab is closed");
    } finally {
      await this.book.dropTab(tabId);
    }
  }

  /** `keep()`: the tab is the user's for good — out of the agent tabs, out of its Winter group, never closed by Winter. */
  private async keepTab(tabId: number): Promise<void> {
    const tab = await this.getTab(tabId);
    if (this.book.sessionOfTab(tabId) === undefined) return; // already the user's
    await this.book.dropTab(tabId);
    if (this.book.isWinterGroup(tab.groupId)) await this.chrome.tabs.ungroup([tabId]);
  }

  // ── the debugger ─────────────────────────────────────────────────────────────────────────────────────────────────

  private async attach(tabId: number): Promise<{ viewport: [number, number]; dpr: number }> {
    const tab = await this.getTab(tabId);
    const refusal = attachRefusal(tab.url ?? tab.pendingUrl, this.chrome.runtimeId);
    if (refusal !== undefined) throw new ExtensionError("attach_refused", refusal);
    if (!this.attached.has(tabId)) {
      try {
        await this.chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/no tab with/i.test(message)) throw new ExtensionError("tab_gone", "the tab is closed");
        throw new ExtensionError("attach_refused", /another debugger/i.test(message)
          ? "another debugger is already attached to this tab (DevTools or another extension)"
          : `the browser would not let Winter control this tab: ${message}`);
      }
      this.attached.set(tabId, { tabId, guard: new TabGuard(), subscribed: new Set(), overlay: false });
      this.goneSent.delete(tabId);
      try {
        // A background tab behaves as focused (focus events, :focus, caret), so it can be driven without coming forward.
        await this.chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true });
      } catch { /* best effort */ }
    }
    this.touch(tabId);
    return await this.metrics(tabId);
  }

  /** The CSS viewport and the device pixel ratio, from `Page.getLayoutMetrics` (its device-pixel visual viewport over its
   *  CSS one) — no page code runs to learn them. */
  private async metrics(tabId: number): Promise<{ viewport: [number, number]; dpr: number }> {
    let m: unknown;
    try {
      m = await this.chrome.debugger.sendCommand({ tabId }, "Page.getLayoutMetrics", {});
    } catch (err) {
      throw this.cdpError(tabId, err);
    }
    const css = isRecord(m) && isRecord(m.cssVisualViewport) ? m.cssVisualViewport : {};
    const device = isRecord(m) && isRecord(m.visualViewport) ? m.visualViewport : {};
    const w = typeof css.clientWidth === "number" ? css.clientWidth : 0;
    const h = typeof css.clientHeight === "number" ? css.clientHeight : 0;
    const dw = typeof device.clientWidth === "number" ? device.clientWidth : 0;
    const dpr = w > 0 && dw > 0 ? Math.round((dw / w) * 100) / 100 : 1;
    return { viewport: [Math.round(w), Math.round(h)], dpr };
  }

  private async detach(tabId: number): Promise<void> {
    const a = this.attached.get(tabId);
    if (a === undefined) return;
    this.attached.delete(tabId);
    if (a.idle !== undefined) this.clock.clearTimeout(a.idle);
    if (a.overlay) await this.paintOverlay(tabId, { active: false });
    try {
      await this.chrome.debugger.detach({ tabId });
    } catch { /* already detached (the tab closed, or the user cancelled) */ }
  }

  private touch(tabId: number): void {
    const a = this.attached.get(tabId);
    if (a === undefined) return;
    if (a.idle !== undefined) this.clock.clearTimeout(a.idle);
    a.idle = this.clock.setTimeout(() => {
      if (this.attached.get(tabId) !== a) return;
      this.opts.log?.(`tab ${tabId}: no command for ${Math.round(this.idleMs / 1000)} s — detaching`);
      void this.detach(tabId).then(() => this.opts.notify("debugger.detached", { tabKey: String(tabId), reason: "idle" }));
    }, this.idleMs);
  }

  private attachedOrGone(tabId: number): Attached {
    const a = this.attached.get(tabId);
    if (a === undefined) throw new ExtensionError("tab_gone", "Winter is not attached to this tab (attach it first)");
    return a;
  }

  private async send(tabId: number, params: Record<string, unknown>): Promise<unknown> {
    const a = this.attachedOrGone(tabId);
    const method = params.method;
    if (typeof method !== "string") throw new ExtensionError("not_allowed", "cdp.send needs a method");
    const cdpParams = isRecord(params.params) ? params.params : {};
    const cdpSessionId = typeof params.cdpSessionId === "string" ? params.cdpSessionId : undefined;
    const decision = a.guard.check(method, cdpParams, cdpSessionId);
    if (decision.kind === "refuse") throw new ExtensionError("not_allowed", decision.reason, { method });
    this.touch(tabId);
    if (decision.kind === "answer") return decision.result;
    const target: DebuggerTarget = cdpSessionId === undefined ? { tabId } : { tabId, sessionId: cdpSessionId };
    let result: unknown;
    try {
      result = await this.chrome.debugger.sendCommand(target, method, cdpParams);
    } catch (err) {
      throw this.cdpError(tabId, err);
    }
    a.guard.observeResult(method, cdpParams, result, cdpSessionId);
    return result ?? {};
  }

  /** chrome.debugger's failure as a typed error: a protocol error's JSON becomes cdpCode/cdpMessage. */
  private cdpError(tabId: number, err: unknown): ExtensionError {
    const message = err instanceof Error ? err.message : String(err);
    if (/not attached to the tab|no tab with given id|cannot access a/i.test(message)) {
      this.attached.delete(tabId);
      return new ExtensionError("tab_gone", "Winter is no longer attached to this tab");
    }
    try {
      const parsed: unknown = JSON.parse(message);
      if (isRecord(parsed) && typeof parsed.message === "string") {
        return new ExtensionError("cdp_error", parsed.message, { cdpCode: typeof parsed.code === "number" ? parsed.code : undefined, cdpMessage: parsed.message });
      }
    } catch { /* not JSON */ }
    return new ExtensionError("cdp_error", message, { cdpMessage: message });
  }

  private subscribe(tabId: number, events: unknown): void {
    const a = this.attachedOrGone(tabId);
    if (!Array.isArray(events) || events.some((e) => typeof e !== "string")) throw new ExtensionError("not_allowed", "cdp.subscribe needs a list of event names");
    const outside = (events as string[]).filter((e) => !isAllowedEvent(e));
    if (outside.length > 0) throw new ExtensionError("not_allowed", `not in Winter's CDP allowlist: ${outside.join(", ")}`, { events: outside });
    a.subscribed = new Set(events as string[]);
    this.touch(tabId);
  }

  // ── the overlay ──────────────────────────────────────────────────────────────────────────────────────────────────

  private async overlay(tabId: number, params: Record<string, unknown>): Promise<void> {
    const a = this.attached.get(tabId);
    if (a === undefined) return; // best effort: only a driven tab gets one
    const active = params.active === true;
    const c = isRecord(params.cursor) ? params.cursor : undefined;
    const cursor = c !== undefined && typeof c.x === "number" && typeof c.y === "number" && typeof c.kind === "string" ? { x: c.x, y: c.y, kind: c.kind } : undefined;
    a.overlay = active;
    await this.paintOverlay(tabId, { active, ...(cursor === undefined ? {} : { cursor }) });
  }

  private async paintOverlay(tabId: number, args: { active: boolean; cursor?: { x: number; y: number; kind: string } }): Promise<void> {
    try {
      await this.chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: drawOverlay as (arg: never) => void, args: [{ ...args, stopLabel: "Stop Winter" }] });
    } catch { /* best effort: a page that forbids scripts (a store page, a PDF viewer) simply shows none */ }
  }

  // ── the browser's events ─────────────────────────────────────────────────────────────────────────────────────────

  private onDebuggerEvent(source: DebuggerTarget, method: string, params: Record<string, unknown> | undefined): void {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    const a = this.attached.get(tabId);
    if (a === undefined) return;
    a.guard.observeEvent(method, params, source.sessionId);
    const tabKey = String(tabId);
    if (a.subscribed.has(method) && isAllowedEvent(method)) {
      this.opts.notify("cdp.event", {
        tabKey,
        method,
        params: strippedParams(method, params),
        ...(source.sessionId === undefined ? {} : { cdpSessionId: source.sessionId }),
      });
    }
    if (method === "Inspector.targetCrashed" && source.sessionId === undefined) this.gone(tabId, "crashed");
  }

  private async onDebuggerDetach(source: DebuggerTarget, reason: string): Promise<void> {
    const tabId = source.tabId;
    if (tabId === undefined || !this.attached.has(tabId)) return; // not ours, or detached by us
    const a = this.attached.get(tabId)!;
    this.attached.delete(tabId);
    if (a.idle !== undefined) this.clock.clearTimeout(a.idle);
    if (reason === "canceled_by_user") {
      // The user dismissed the browser's "started debugging this browser" bar: they took the tab back.
      if (a.overlay) await this.paintOverlay(tabId, { active: false });
      this.opts.notify("debugger.detached", { tabKey: String(tabId), reason: "canceled_by_user" });
      return;
    }
    let exists = true;
    try { await this.chrome.tabs.get(tabId); } catch { exists = false; }
    if (exists) this.opts.notify("debugger.detached", { tabKey: String(tabId), reason: "target_closed" });
    else this.gone(tabId, "closed");
  }

  private onTabRemoved(tabId: number): void {
    const a = this.attached.get(tabId);
    if (a?.idle !== undefined) this.clock.clearTimeout(a.idle);
    this.attached.delete(tabId);
    void this.book.dropTab(tabId);
    this.gone(tabId, "closed");
  }

  private gone(tabId: number, reason: "closed" | "crashed"): void {
    if (reason === "closed") {
      if (this.goneSent.has(tabId)) return;
      this.goneSent.add(tabId);
    }
    this.opts.notify("tab.gone", { tabKey: String(tabId), reason });
  }
}
