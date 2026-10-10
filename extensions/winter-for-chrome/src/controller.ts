// Winter for Chrome — what the extension does for Winter's browser engine: the daemon's requests (spine §6.4) and the
// browser's events, turned into each other.
//
// The rules it keeps whatever it is asked:
//  - It never moves the user's view: tabs open with `active: false`, in the session's Winter group; nothing here can
//    activate a tab or focus a window (the `ChromeApi` it is given has no such call).
//  - It never reads a site's cookies or storage, and runs page code only in the "winter" world (the guard).
//  - The debugger is attached only while the daemon has the tab bound — and is detached after 5 minutes without a
//    command, whenever the link to Winter drops, and (for any left from a previous run of the service worker) at start.
//  - It closes only Winter's own tabs (an agent tab, by tab id — pinned or moved, until `keep()`), and only when the
//    daemon says so: it never decides by itself that a tab should close. A page's "leave this page?" (beforeunload)
//    prompt must neither be left as a native dialog nor bring anything forward — and the browser brings a tab forward to
//    show that prompt whatever raises it (a close or a navigation; measured), then activates a neighbour once the tab is
//    gone. So a close first DISCARDS the tab (its page unloads without beforeunload) and then removes it. Only when the
//    browser will not discard it (the active tab: already in front) does it fall back to holding the debugger with Page
//    events on and accepting that agent tab's own prompt. It ungroups the tab first, so a group's last tab leaves no
//    group behind.
//  - The same prompt stands in the way of a NAVIGATION (`Page.navigate`, `Page.reload`, `Page.navigateToHistoryEntry`)
//    of a background agent tab whose page may raise it — one Winter typed or clicked into (any `Input.*`), or the user
//    visited, since its document loaded. Such a navigation first discards the page too, then runs exactly as asked on
//    the SAME debugger session (a discard keeps it — measured), so the daemon gets the browser's own answer and events.
//    The active tab, the user's own tabs, a page with no input since it loaded, and a subframe's navigation go to the
//    browser unchanged.
//  - Stop is the toolbar button: while any tab is driven, a click on it stops Winter there.
import type { ChromeApi, ChromeTab, Clock, DebuggerTarget } from "./chrome-api";
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
/** How long a close may take, the page's beforeunload prompt included, before it is reported as failed. */
export const CLOSE_TIMEOUT_MS = 10_000;
/** How long the start waits to learn whether the browser itself just started (`runtime.onStartup`). */
export const LAUNCH_HINT_MS = 3_000;
/** How long a navigation waits for a discarded page's stand-in document to finish loading before it runs (so none of
 *  the stand-in's events can arrive after the new page's), and for a debugger session a discard ended to report so. */
export const DISCARD_SETTLE_MS = 1_000;
/** The top-level commands that leave the tab's document — the ones a "leave this page?" prompt can hold up. */
const LEAVING_METHODS = new Set(["Page.navigate", "Page.reload", "Page.navigateToHistoryEntry"]);
const NOT_ATTACHED = /not attached to the tab/i;
/** `leaveWithoutPrompt`'s "not for me": the command goes to the browser as it is. */
const AS_IS = Symbol("as is");
/** The answer when the browser ended the debugger session to navigate (the daemon reads `data.navigated`). */
export const NAVIGATED_IN_NEW_SESSION = "the page was navigated, but the browser started a new debugging session for it — read the page again";
const DEBUGGER_PROTOCOL_VERSION = "1.3";
const ATTACHED_KEY = "winterAttached";
const ALIVE_KEY = "winterAlive";

/** Why the service worker started: the browser started, the extension was installed or updated, or it simply woke. */
export type LaunchKind = "startup" | "install" | "update";

interface Attached {
  tabId: number;
  guard: TabGuard;
  subscribed: Set<string>;
  idle?: unknown;
  overlay: boolean;
  /** The daemon turned Page events on in the tab's own session (`Page.enable`). */
  pageEvents: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface ControllerOptions {
  /** Sends one notification to the daemon. */
  notify(method: string, params: Record<string, unknown>): void;
  /** How many tabs are being driven now (the toolbar button turns into Stop while it is more than 0). */
  onDriven?(count: number): void;
  clock?: Clock;
  idleDetachMs?: number;
  closeTimeoutMs?: number;
  launchHintMs?: number;
  log?(line: string): void;
}

export class ExtensionController {
  private readonly attached = new Map<number, Attached>();
  private readonly book: AgentBook;
  private readonly clock: Clock;
  private readonly idleMs: number;
  /** Tabs whose `tab.gone` was sent (ids are never reused while the browser runs). */
  private readonly goneSent = new Set<number>();
  /** Agent tabs being closed by `tabs.close`: their beforeunload prompt is accepted. */
  private readonly closing = new Set<number>();
  private readonly removedWaiters = new Map<number, () => void>();
  private launch: LaunchKind | undefined;
  private launchWaiter: ((k: LaunchKind) => void) | undefined;
  /** Agent tabs whose page may ask "leave this page?": Winter sent it input, or the user visited it, since its document
   *  loaded. Cleared by the tab's next cross-document load. After a worker start, every agent tab (it cannot know). */
  private readonly mayPrompt = new Set<number>();
  /** Each window's active tab, as `tabs.onActivated` last said. */
  private readonly activeIn = new Map<number, number>();
  /** A navigation waiting for a discarded page's stand-in document to load (`Page.loadEventFired`). */
  private readonly settleWaiters = new Map<number, () => void>();
  /** A navigation waiting for the browser to report the debugger session a discard ended (`debugger.onDetach`). */
  private readonly detachWaiters = new Map<number, () => void>();

  constructor(private readonly chrome: ChromeApi, private readonly opts: ControllerOptions) {
    this.book = new AgentBook(chrome);
    this.clock = opts.clock ?? realClock;
    this.idleMs = opts.idleDetachMs ?? IDLE_DETACH_MS;
  }

  /** `runtime.onStartup` / `runtime.onInstalled` told why the worker started (background.ts forwards them). */
  noteLaunch(kind: LaunchKind): void {
    if (this.launch !== undefined) return;
    this.launch = kind;
    this.launchWaiter?.(kind);
  }

  /**
   * Listens to the browser, decides whether the agent-tab record still describes this browser session, and detaches
   * whatever a previous run of the worker left attached. Call once, synchronously at the worker's top level (its
   * listeners are registered before its first await), before the first request.
   */
  async start(): Promise<void> {
    this.chrome.debugger.onEvent.addListener((source, method, params) => this.onDebuggerEvent(source, method, params));
    this.chrome.debugger.onDetach.addListener((source, reason) => { void this.onDebuggerDetach(source, reason); });
    this.chrome.tabs.onRemoved.addListener((tabId) => this.onTabRemoved(tabId));
    this.chrome.tabs.onActivated.addListener((info) => this.onActivated(info));
    this.chrome.tabGroups.onRemoved.addListener((group) => { void this.book.dropGroup(group.id); });
    this.chrome.action.onClicked.addListener(() => this.stopDriven());

    // storage.session holds the "alive" mark for this browser session AND this version of the extension. Present: the
    // worker merely restarted. Absent: the browser started, or the extension was installed or updated — onStartup /
    // onInstalled says which (after a browser start every recorded id is stale; after an update the tabs are still
    // Winter's). No word in time is treated as a browser start: Winter would rather forget a tab than take a user's.
    const alive = (await this.chrome.storage.session.get([ALIVE_KEY]))[ALIVE_KEY] === true;
    const kind = alive ? undefined : await this.launchKind();
    if (kind === "startup") await this.book.clear();
    else await this.book.load();
    // What happened in a tab while no worker ran is unknown: leaving any agent tab may ask, until it next loads.
    for (const tabId of this.book.tabIds()) this.mayPrompt.add(tabId);
    await this.chrome.storage.session.set({ [ALIVE_KEY]: true });
    await this.recoverAttached();
  }

  private launchKind(): Promise<LaunchKind> {
    if (this.launch !== undefined) return Promise.resolve(this.launch);
    return new Promise((resolve) => {
      const timer = this.clock.setTimeout(() => { this.launchWaiter = undefined; resolve("startup"); }, this.opts.launchHintMs ?? LAUNCH_HINT_MS);
      this.launchWaiter = (k) => { this.clock.clearTimeout(timer); this.launchWaiter = undefined; resolve(k); };
    });
  }

  /** Debuggers and overlays a previous run of the worker left behind: nothing is bound to them any more. */
  private async recoverAttached(): Promise<void> {
    const stored = (await this.chrome.storage.session.get([ATTACHED_KEY]))[ATTACHED_KEY];
    const ids = Array.isArray(stored) ? stored.filter((x): x is number => Number.isInteger(x)) : [];
    for (const tabId of ids) {
      if (this.attached.has(tabId)) continue;
      await this.paintOverlay(tabId, { active: false });
      try { await this.chrome.debugger.detach({ tabId }); } catch { /* already gone */ }
    }
    if (ids.length > 0) this.opts.log?.(`detached ${ids.length} tab(s) a previous worker left attached`);
    await this.saveAttached();
  }

  private async saveAttached(): Promise<void> {
    try { await this.chrome.storage.session.set({ [ATTACHED_KEY]: [...this.attached.keys()] }); } catch { /* best effort */ }
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

  /** The toolbar button was clicked while Winter was driving: Stop, for every driven tab. */
  stopDriven(): boolean {
    const driven = [...this.attached.values()].filter((a) => a.overlay);
    for (const a of driven) this.opts.notify("stop.pressed", { tabKey: String(a.tabId) });
    return driven.length > 0;
  }

  private drivenChanged(): void {
    this.opts.onDriven?.([...this.attached.values()].filter((a) => a.overlay).length);
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
    // From here on the tab exists and is Winter's: it is returned whatever the grouping does, so it can be driven and
    // closed like any other agent tab — a failed group step must never leave an untracked tab behind.
    await this.book.addTab(tab.id, sessionId);
    let grouped = -1;
    try {
      if (groupId !== undefined) {
        await this.chrome.tabs.group({ tabIds: [tab.id], groupId });
        grouped = groupId;
      } else {
        grouped = await this.chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId } });
        const title = groupTitle(sessionTitle);
        await this.book.addGroup(grouped, sessionId, title);
        await this.chrome.tabGroups.update(grouped, { title, color: "blue" });
      }
    } catch (err) {
      this.opts.log?.(`tab ${tab.id}: could not put it in its Winter group (${err instanceof Error ? err.message : String(err)}) — it stays Winter's, ungrouped`);
    }
    return this.wire({ ...tab, groupId: grouped });
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
    // Out of its group first: closing a group's last tab would otherwise leave the browser holding the group (a saved
    // group, in browsers that save them); ungrouping the last tab removes the group with it.
    if (tab.groupId >= 0) {
      try { await this.chrome.tabs.ungroup([tabId]); } catch { /* the tab is closing anyway */ }
    }
    // Discard first: the page unloads with no beforeunload, so nothing can ask, and nothing comes forward.
    let closeId = tabId;
    let discarded = false;
    if (!tab.active) {
      await this.detach(tabId);
      try {
        const d = await this.chrome.tabs.discard(tabId);
        if (d?.id !== undefined) {
          discarded = true;
          if (d.id !== tabId) {
            // An older browser hands a discarded tab a new id: it is still the same agent tab.
            const sessionId = this.book.sessionOfTab(tabId);
            await this.book.dropTab(tabId);
            if (sessionId !== undefined) await this.book.addTab(d.id, sessionId);
            closeId = d.id;
          }
        }
      } catch { /* not discardable: the debugger path below */ }
    }
    this.closing.add(closeId);
    if (!discarded) await this.holdForPrompt(closeId, tab);
    const removed = new Promise<boolean>((resolve) => {
      const timer = this.clock.setTimeout(() => { this.removedWaiters.delete(closeId); resolve(false); }, this.opts.closeTimeoutMs ?? CLOSE_TIMEOUT_MS);
      this.removedWaiters.set(closeId, () => { this.clock.clearTimeout(timer); resolve(true); });
    });
    // `tabs.remove` answers only once the page let itself be closed; the tab's removal (onRemoved) is what counts.
    this.chrome.tabs.remove(closeId).catch(() => undefined);
    const gone = await removed;
    this.closing.delete(closeId);
    if (!gone) {
      // Still there: say so, and leave nothing of Winter's on it (the debugger was only held for the close).
      await this.detach(closeId);
      throw new ExtensionError("timeout", "the tab did not close (the page kept it open)");
    }
  }

  /** The fallback close: the debugger held through it with Page events on, so the page's prompt — if it raises one —
   *  comes to the extension and is accepted (`onDebuggerEvent`), never left as a native dialog. */
  private async holdForPrompt(tabId: number, tab: ChromeTab): Promise<void> {
    if (!this.attached.has(tabId) && attachRefusal(tab.url ?? tab.pendingUrl, this.chrome.runtimeId) === undefined) {
      try {
        await this.chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
        this.attached.set(tabId, { tabId, guard: new TabGuard(), subscribed: new Set(), overlay: false, pageEvents: false });
        await this.saveAttached();
      } catch { /* another debugger, or the tab is going: removed all the same */ }
    }
    const a = this.attached.get(tabId);
    if (a === undefined) return;
    if (a.idle !== undefined) this.clock.clearTimeout(a.idle);
    if (a.overlay) {
      a.overlay = false;
      this.drivenChanged();
    }
    try { await this.chrome.debugger.sendCommand({ tabId }, "Page.enable", {}); } catch { /* best effort */ }
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
      this.attached.set(tabId, { tabId, guard: new TabGuard(), subscribed: new Set(), overlay: false, pageEvents: false });
      this.goneSent.delete(tabId);
      await this.saveAttached();
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
    if (a.overlay) {
      await this.paintOverlay(tabId, { active: false });
      this.drivenChanged();
    }
    try {
      await this.chrome.debugger.detach({ tabId });
    } catch { /* already detached (the tab closed, or the user cancelled) */ }
    await this.saveAttached();
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
    if (a === undefined || this.closing.has(tabId)) throw new ExtensionError("tab_gone", "Winter is not attached to this tab (attach it first)");
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
    // Input gives the page a user gesture: from now until its next load, leaving it may ask "leave this page?".
    if (method.startsWith("Input.")) this.mayPrompt.add(tabId);
    if (LEAVING_METHODS.has(method) && cdpSessionId === undefined && cdpParams.frameId === undefined) {
      const left = await this.leaveWithoutPrompt(tabId, a, method, cdpParams);
      if (left !== AS_IS) return left;
    }
    const target: DebuggerTarget = cdpSessionId === undefined ? { tabId } : { tabId, sessionId: cdpSessionId };
    let result: unknown;
    try {
      result = await this.chrome.debugger.sendCommand(target, method, cdpParams);
    } catch (err) {
      throw this.cdpError(tabId, err);
    }
    a.guard.observeResult(method, cdpParams, result, cdpSessionId);
    if (cdpSessionId === undefined && (method === "Page.enable" || method === "Page.disable")) a.pageEvents = method === "Page.enable";
    return result ?? {};
  }

  // ── leaving a page that may ask "leave this page?" ──────────────────────────────────────────────────────────────

  /**
   * A top-level navigation of a BACKGROUND agent tab whose page may ask "leave this page?": the browser would bring the
   * tab forward to show that prompt, whatever raised it (measured) — so the page is discarded first (it unloads with no
   * beforeunload), and the command then runs exactly as asked on the same debugger session, which a discard keeps
   * (measured): the daemon gets the browser's own answer and the browser's own events — the discard's (the old
   * document's frames and contexts end, a stand-in document loads, no `Page.frameNavigated`) and then the navigation's.
   * `AS_IS` for everything else, and when the browser will not discard the tab.
   */
  private async leaveWithoutPrompt(tabId: number, a: Attached, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.mayPrompt.has(tabId) || this.book.sessionOfTab(tabId) === undefined) return AS_IS;
    let tab: ChromeTab;
    try { tab = await this.chrome.tabs.get(tabId); } catch { return AS_IS; }
    // In front already: a prompt shows where the user is looking, and the daemon answers it.
    if (tab.active) return AS_IS;
    let discarded: ChromeTab | undefined;
    try { discarded = await this.chrome.tabs.discard(tabId); } catch { discarded = undefined; }
    if (discarded?.id === undefined) return AS_IS;
    this.mayPrompt.delete(tabId);
    if (discarded.id !== tabId) return await this.leaveReplacedTab(tabId, discarded.id, a, method, params);
    // The stand-in document's events come right after the discard: let them all arrive before the navigation's.
    if (a.pageEvents && this.attached.get(tabId) === a) await this.settle(this.settleWaiters, tabId);
    if (this.attached.get(tabId) === a) {
      try {
        const result = await this.chrome.debugger.sendCommand({ tabId }, method, params);
        a.guard.observeResult(method, params, result);
        return result ?? {};
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!NOT_ATTACHED.test(message)) throw this.cdpError(tabId, err);
      }
    }
    return await this.leaveInNewSession(tabId, a, method, params);
  }

  /** Resolves when `waiters`' entry for the tab is called, or after DISCARD_SETTLE_MS. */
  private settle(waiters: Map<number, () => void>, tabId: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        this.clock.clearTimeout(timer);
        if (waiters.get(tabId) === done) waiters.delete(tabId);
        resolve();
      };
      const timer = this.clock.setTimeout(done, DISCARD_SETTLE_MS);
      waiters.set(tabId, done);
    });
  }

  /**
   * The discard ended the tab's debugger session (Chrome keeps it; another Chromium browser may not): the daemon is told
   * the debugger detached (as for any detach), the tab is attached again and the command runs there — and the answer is
   * `cdp_error` with `data.navigated: true`: the navigation happened, but its events went to a session the daemon no
   * longer follows, so it reads the page again.
   */
  private async leaveInNewSession(tabId: number, a: Attached, method: string, params: Record<string, unknown>): Promise<never> {
    // Its own onDetach reports it to the daemon; else it is reported here.
    if (this.attached.get(tabId) === a) await this.settle(this.detachWaiters, tabId);
    if (this.attached.get(tabId) === a) {
      this.forgetAttached(tabId, a);
      this.opts.notify("debugger.detached", { tabKey: String(tabId), reason: "target_closed" });
    }
    try {
      await this.chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
    } catch (err) {
      throw new ExtensionError("attach_refused", `the page was unloaded to navigate it, but the browser would not let Winter control the tab again: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.attached.set(tabId, { tabId, guard: new TabGuard(), subscribed: new Set(), overlay: false, pageEvents: false });
    this.goneSent.delete(tabId);
    await this.saveAttached();
    try { await this.chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true }); } catch { /* best effort */ }
    this.touch(tabId);
    try {
      await this.chrome.debugger.sendCommand({ tabId }, method, params);
    } catch (err) {
      throw this.cdpError(tabId, err);
    }
    throw new ExtensionError("cdp_error", NAVIGATED_IN_NEW_SESSION, { navigated: true, cdpMessage: NAVIGATED_IN_NEW_SESSION });
  }

  /**
   * The browser gave the discarded tab a new id (older Chromium browsers do): to the daemon the old tab is gone; the new
   * one is the same session's agent tab. The navigation is still made there (the debugger held only for it), and the
   * answer is `tab_gone` naming the new tab (`data.tabKey`, `data.navigated`).
   */
  private async leaveReplacedTab(oldId: number, newId: number, a: Attached, method: string, params: Record<string, unknown>): Promise<never> {
    const sessionId = this.book.sessionOfTab(oldId);
    await this.book.dropTab(oldId);
    if (sessionId !== undefined) await this.book.addTab(newId, sessionId);
    this.forgetAttached(oldId, a);
    try { await this.chrome.debugger.detach({ tabId: oldId }); } catch { /* went with the old tab */ }
    this.gone(oldId, "closed");
    let navigated = false;
    try {
      await this.chrome.debugger.attach({ tabId: newId }, DEBUGGER_PROTOCOL_VERSION);
      try {
        await this.chrome.debugger.sendCommand({ tabId: newId }, method, params);
        navigated = true;
      } finally {
        try { await this.chrome.debugger.detach({ tabId: newId }); } catch { /* best effort */ }
      }
    } catch { /* left unloaded: it loads when next attached or shown */ }
    throw new ExtensionError("tab_gone", navigated
      ? `the browser replaced the tab to navigate it — it is tab ${newId} now; bind that one`
      : `the browser replaced the tab — it is tab ${newId} now (not navigated); bind that one`, { navigated, tabKey: String(newId) });
  }

  /** Drop the record of an attachment that ended (the browser's doing, not a detach of ours). */
  private forgetAttached(tabId: number, a: Attached): void {
    if (this.attached.get(tabId) !== a) return;
    this.attached.delete(tabId);
    if (a.idle !== undefined) this.clock.clearTimeout(a.idle);
    if (a.overlay) this.drivenChanged();
    void this.saveAttached();
  }

  /** chrome.debugger's failure as a typed error: a protocol error's JSON becomes cdpCode/cdpMessage. */
  private cdpError(tabId: number, err: unknown): ExtensionError {
    const message = err instanceof Error ? err.message : String(err);
    if (/not attached to the tab|no tab with given id|cannot access a/i.test(message)) {
      this.attached.delete(tabId);
      void this.saveAttached();
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
    const changed = a.overlay !== active;
    a.overlay = active;
    await this.paintOverlay(tabId, { active, ...(cursor === undefined ? {} : { cursor }) });
    if (changed) this.drivenChanged();
  }

  private async paintOverlay(tabId: number, args: { active: boolean; cursor?: { x: number; y: number; kind: string } }): Promise<void> {
    try {
      await this.chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: drawOverlay as (arg: never) => void, args: [args] });
    } catch { /* best effort: a page that forbids scripts (a store page, a PDF viewer) simply shows none */ }
  }

  // ── the browser's events ─────────────────────────────────────────────────────────────────────────────────────────

  private onDebuggerEvent(source: DebuggerTarget, method: string, params: Record<string, unknown> | undefined): void {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    const a = this.attached.get(tabId);
    if (a === undefined) return;
    // The page's own "leave this page?" while Winter closes one of its agent tabs: accepted, so the close completes and
    // no dialog is left in the user's browser. Never for the user's tabs, and never outside a close.
    if (method === "Page.javascriptDialogOpening" && source.sessionId === undefined && params?.type === "beforeunload"
      && this.closing.has(tabId) && this.book.sessionOfTab(tabId) !== undefined) {
      void this.chrome.debugger.sendCommand({ tabId }, "Page.handleJavaScriptDialog", { accept: true }).catch(() => undefined);
      return;
    }
    a.guard.observeEvent(method, params, source.sessionId);
    if (source.sessionId === undefined) {
      if (method === "Page.loadEventFired") this.settleWaiters.get(tabId)?.();
      // A new document in the tab: no gesture yet, so leaving it cannot ask (a page restored from the back/forward
      // cache keeps whatever it had, so that one does not count).
      const frame = isRecord(params?.frame) ? params.frame : undefined;
      if (method === "Page.frameNavigated" && frame !== undefined && frame.parentId === undefined && params?.type === "Navigation") this.mayPrompt.delete(tabId);
    }
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
    if (tabId !== undefined) {
      // A navigation waiting on this session stops waiting: nothing more comes from it.
      this.settleWaiters.get(tabId)?.();
      this.detachWaiters.get(tabId)?.();
    }
    if (tabId === undefined || !this.attached.has(tabId)) return; // not ours, or detached by us
    const a = this.attached.get(tabId)!;
    this.attached.delete(tabId);
    await this.saveAttached();
    if (a.idle !== undefined) this.clock.clearTimeout(a.idle);
    if (a.overlay) this.drivenChanged();
    if (this.closing.has(tabId)) return; // the close itself reports the outcome
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
    if (a !== undefined) {
      this.attached.delete(tabId);
      void this.saveAttached();
      if (a.overlay) this.drivenChanged();
    }
    void this.book.dropTab(tabId);
    this.mayPrompt.delete(tabId);
    this.settleWaiters.get(tabId)?.();
    this.removedWaiters.get(tabId)?.();
    this.removedWaiters.delete(tabId);
    this.gone(tabId, "closed");
  }

  /** The user made `info.tabId` active. Winter never does: an agent tab the user visited may have their gesture — until
   *  it next loads, leaving it may ask "leave this page?", as after Winter's own input. */
  private onActivated(info: { tabId: number; windowId: number }): void {
    const before = this.activeIn.get(info.windowId);
    this.activeIn.set(info.windowId, info.tabId);
    for (const tabId of [before, info.tabId]) {
      if (tabId !== undefined && this.book.sessionOfTab(tabId) !== undefined) this.mayPrompt.add(tabId);
    }
  }

  private gone(tabId: number, reason: "closed" | "crashed"): void {
    if (reason === "closed") {
      if (this.goneSent.has(tabId)) return;
      this.goneSent.add(tabId);
    }
    this.opts.notify("tab.gone", { tabKey: String(tabId), reason });
  }
}
