// An in-memory browser behind the `ChromeApi` the extension is written against: windows, tabs (one active per window),
// groups, the debugger, scripting, storage and a native port — every call recorded, so a test can prove what the
// extension did and, as importantly, what it never did.
import type { ChromeApi, ChromePort, ChromeTab, ChromeTabGroup, ChromeWindow, Clock, DebuggerTarget, MessageSender } from "../src/chrome-api";

type Listener<F> = { listeners: F[]; addListener(l: F): void };
function event<F>(): Listener<F> {
  const listeners: F[] = [];
  return { listeners, addListener: (l: F) => { listeners.push(l); } };
}

export class FakePort implements ChromePort {
  readonly sent: Record<string, any>[] = [];
  readonly onMessage = event<(m: unknown) => void>();
  readonly onDisconnect = event<() => void>();
  disconnected = false;
  postMessage(message: unknown): void { this.sent.push(JSON.parse(JSON.stringify(message))); }
  disconnect(): void { this.disconnected = true; }
  /** The host sends the extension a message. */
  async deliver(message: Record<string, unknown>): Promise<void> {
    for (const l of this.onMessage.listeners) l({ jsonrpc: "2.0", ...message });
    await flush();
  }
  /** The host went away. */
  drop(): void { for (const l of this.onDisconnect.listeners) l(); }
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

export class ManualClock implements Clock {
  private now = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private next = 1;
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.push({ at: this.now + ms, fn, id });
    return id;
  }
  clearTimeout(h: unknown): void { this.timers = this.timers.filter((t) => t.id !== h); }
  pending(): number[] { return this.timers.map((t) => t.at - this.now).sort((a, b) => a - b); }
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.now = due.at;
      due.fn();
      await flush();
    }
    this.now = target;
  }
}

export class FakeChrome implements ChromeApi {
  readonly runtimeId = "jikdcokcpbacalfeipkognejnlnobbbf";
  readonly extensionVersion = "1.0.0";
  readonly calls: { api: string; args: unknown[] }[] = [];
  windows_: ChromeWindow[] = [];
  tabs_ = new Map<number, ChromeTab>();
  groups_ = new Map<number, ChromeTabGroup>();
  attachedDebuggers = new Set<number>();
  /** Tabs another debugger already holds (DevTools). */
  foreignDebuggers = new Set<number>();
  storage_: Record<string, unknown> = {};
  sessionStorage_: Record<string, unknown> = {};
  lastFocused: number | undefined;
  lastErrorMessage: string | undefined;
  ports: FakePort[] = [];
  connectNativeThrows = false;
  /** What `debugger.sendCommand` answers, by method (a function gets the target and params). */
  cdp: Record<string, unknown | ((t: DebuggerTarget, p: Record<string, unknown> | undefined) => unknown)> = {
    "Page.getLayoutMetrics": { cssVisualViewport: { clientWidth: 1280, clientHeight: 720 }, visualViewport: { clientWidth: 2560, clientHeight: 1440 } },
    "Emulation.setFocusEmulationEnabled": {},
  };
  nextTab = 100;
  private nextGroup = 1;
  private uuid = 0;

  readonly debuggerOnEvent = event<(source: DebuggerTarget, method: string, params?: Record<string, unknown>) => void>();
  readonly debuggerOnDetach = event<(source: DebuggerTarget, reason: string) => void>();
  readonly tabsOnRemoved = event<(tabId: number) => void>();
  readonly groupsOnRemoved = event<(group: { id: number }) => void>();
  readonly runtimeOnMessage = event<(message: unknown, sender: MessageSender, sendResponse: (r: unknown) => void) => boolean | undefined>();
  readonly actionOnClicked = event<(tab: ChromeTab) => void>();
  /** Tabs whose page set a beforeunload handler (and had a user gesture): closing them asks "leave this page?". */
  beforeunload = new Set<number>();
  /** Tabs with Page events on (through the debugger). */
  pageEnabled = new Set<number>();
  /** A beforeunload prompt shown as a NATIVE dialog in the user's browser (nothing handled it over CDP). */
  nativeDialogs: number[] = [];
  private pendingDialogs = new Map<number, () => void>();
  /** Make the next tabs.group call fail. */
  groupFails = false;

  constructor() {
    this.addWindow({ id: 1, incognito: false });
    this.addTab({ windowId: 1, url: "https://user.example/inbox", title: "Inbox", active: true });
    this.addTab({ windowId: 1, url: "https://user.example/doc", title: "Doc", active: false });
    this.lastFocused = 1;
  }

  addWindow(w: ChromeWindow): void { this.windows_.push(w); }
  addTab(t: Partial<ChromeTab> & { windowId: number }): ChromeTab {
    const tab: ChromeTab = { url: "about:blank", title: "", active: false, groupId: -1, incognito: false, ...t, id: t.id ?? this.nextTab++ };
    this.tabs_.set(tab.id!, tab);
    return tab;
  }
  activeTabs(): Record<number, number | undefined> {
    const out: Record<number, number | undefined> = {};
    for (const w of this.windows_) out[w.id!] = [...this.tabs_.values()].find((t) => t.windowId === w.id && t.active)?.id;
    return out;
  }
  private record(api: string, ...args: unknown[]): void { this.calls.push({ api, args: JSON.parse(JSON.stringify(args ?? [])) }); }
  private tabOr(tabId: number): ChromeTab {
    const t = this.tabs_.get(tabId);
    if (t === undefined) throw new Error(`No tab with id: ${tabId}.`);
    return t;
  }

  lastError(): string | undefined { return this.lastErrorMessage; }

  tabs = {
    get: async (tabId: number) => { this.record("tabs.get", tabId); return { ...this.tabOr(tabId) }; },
    query: async (q: Record<string, never>) => { this.record("tabs.query", q); return [...this.tabs_.values()].map((t) => ({ ...t })); },
    create: async (p: { url: string; active: false; windowId: number }) => {
      this.record("tabs.create", p);
      if (!this.windows_.some((w) => w.id === p.windowId)) throw new Error(`No window with id: ${p.windowId}.`);
      return { ...this.addTab({ windowId: p.windowId, url: p.url, title: "", active: p.active }) };
    },
    remove: (tabId: number) => {
      this.record("tabs.remove", tabId);
      try { this.tabOr(tabId); } catch (err) { return Promise.reject(err); }
      if (!this.beforeunload.has(tabId)) {
        void this.closeTab(tabId);
        return Promise.resolve();
      }
      // The page asks "leave this page?": over CDP when a debugger has Page events on, else as a native dialog.
      return new Promise<void>((resolve) => {
        if (this.attachedDebuggers.has(tabId) && this.pageEnabled.has(tabId)) {
          this.pendingDialogs.set(tabId, () => { void this.closeTab(tabId).then(resolve); });
          this.emitCdp(tabId, "Page.javascriptDialogOpening", { url: "https://x/", message: "", type: "beforeunload", hasBrowserHandler: true });
        } else {
          this.nativeDialogs.push(tabId); // never resolves: the user's browser now shows a dialog
        }
      });
    },
    group: async (p: { tabIds: number[]; groupId?: number; createProperties?: { windowId: number } }) => {
      this.record("tabs.group", p);
      if (this.groupFails) { this.groupFails = false; throw new Error("Tabs cannot be edited right now (user may be dragging a tab)."); }
      let id = p.groupId;
      if (id === undefined) {
        id = this.nextGroup++;
        this.groups_.set(id, { id, windowId: p.createProperties?.windowId ?? this.tabOr(p.tabIds[0]!).windowId });
      } else if (!this.groups_.has(id)) {
        throw new Error(`No group with id: ${id}.`);
      }
      for (const t of p.tabIds) this.tabOr(t).groupId = id;
      return id;
    },
    ungroup: async (tabIds: number[]) => {
      this.record("tabs.ungroup", tabIds);
      for (const t of tabIds) this.tabOr(t).groupId = -1;
      this.pruneGroups();
    },
    onRemoved: this.tabsOnRemoved,
  };

  tabGroups = {
    get: async (groupId: number) => {
      this.record("tabGroups.get", groupId);
      const g = this.groups_.get(groupId);
      if (g === undefined) throw new Error(`No group with id: ${groupId}.`);
      return { ...g };
    },
    update: async (groupId: number, p: { title: string; color: "blue" }) => {
      this.record("tabGroups.update", groupId, p);
      const g = this.groups_.get(groupId);
      if (g === undefined) throw new Error(`No group with id: ${groupId}.`);
      g.title = p.title;
      return { ...g };
    },
    onRemoved: this.groupsOnRemoved,
  };

  windows = {
    getLastFocused: async (q: { windowTypes: ["normal"] }) => {
      this.record("windows.getLastFocused", q);
      const w = this.windows_.find((x) => x.id === this.lastFocused);
      if (w === undefined) throw new Error("No last-focused window");
      return { ...w };
    },
    getAll: async (q: { windowTypes: ["normal"] }) => { this.record("windows.getAll", q); return this.windows_.map((w) => ({ ...w })); },
  };

  debugger = {
    attach: async (target: { tabId: number }, version: string) => {
      this.record("debugger.attach", target, version);
      this.tabOr(target.tabId);
      if (this.foreignDebuggers.has(target.tabId)) throw new Error("Another debugger is already attached to the tab with id: " + target.tabId + ".");
      if (this.attachedDebuggers.has(target.tabId)) throw new Error("Another debugger is already attached to the tab with id: " + target.tabId + ".");
      this.attachedDebuggers.add(target.tabId);
    },
    detach: async (target: { tabId: number }) => {
      this.record("debugger.detach", target);
      if (!this.attachedDebuggers.delete(target.tabId)) throw new Error(`Debugger is not attached to the tab with id: ${target.tabId}.`);
    },
    sendCommand: async (target: DebuggerTarget, method: string, params?: Record<string, unknown>) => {
      this.record("debugger.sendCommand", target, method, params);
      if (target.tabId === undefined || !this.attachedDebuggers.has(target.tabId)) throw new Error(`Debugger is not attached to the tab with id: ${target.tabId}.`);
      if (method === "Page.enable" && target.sessionId === undefined) this.pageEnabled.add(target.tabId);
      if (method === "Page.handleJavaScriptDialog") {
        const pending = this.pendingDialogs.get(target.tabId);
        if (pending !== undefined && params?.accept === true) {
          this.pendingDialogs.delete(target.tabId);
          pending();
        }
        return {};
      }
      const answer = this.cdp[method];
      if (answer === undefined) return {};
      if (typeof answer === "function") return (answer as (t: DebuggerTarget, p: Record<string, unknown> | undefined) => unknown)(target, params);
      return JSON.parse(JSON.stringify(answer));
    },
    onEvent: this.debuggerOnEvent,
    onDetach: this.debuggerOnDetach,
  };

  scripting = {
    executeScript: async (i: { target: { tabId: number }; world: "ISOLATED"; func: (arg: never) => void; args: [unknown] }) => {
      this.record("scripting.executeScript", { target: i.target, world: i.world, func: i.func.name, args: i.args });
      return [];
    },
  };

  private area(store: Record<string, unknown>) {
    return {
      get: async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, JSON.parse(JSON.stringify(store[k]))])),
      set: async (items: Record<string, unknown>) => { Object.assign(store, JSON.parse(JSON.stringify(items))); },
    };
  }
  storage = { local: this.area(this.storage_), session: this.area(this.sessionStorage_) };
  /** The extension was updated or reloaded: `storage.session` is cleared (and its debuggers dropped); tabs stay. */
  updateExtension(): void {
    for (const k of Object.keys(this.sessionStorage_)) delete this.sessionStorage_[k];
    this.attachedDebuggers.clear();
  }

  action = {
    setBadgeText: async (p: { text: string }) => { this.record("action.setBadgeText", p); },
    setBadgeBackgroundColor: async (_p: { color: string }) => undefined,
    setTitle: async (p: { title: string }) => { this.record("action.setTitle", p); },
    setPopup: async (p: { popup: string }) => { this.record("action.setPopup", p); },
    onClicked: this.actionOnClicked,
  };
  /** The user clicks the extension's toolbar button. */
  clickAction(): void {
    for (const l of this.actionOnClicked.listeners) l({ windowId: 1, active: true, groupId: -1, incognito: false, id: 100 });
  }

  runtime = {
    connectNative: (application: string) => {
      this.record("runtime.connectNative", application);
      if (this.connectNativeThrows) throw new Error("Specified native messaging host not found.");
      const port = new FakePort();
      this.ports.push(port);
      return port;
    },
    onMessage: this.runtimeOnMessage,
  };

  randomUUID(): string { this.uuid += 1; return `00000000-0000-4000-8000-${String(this.uuid).padStart(12, "0")}`; }

  // ── browser-side events ──────────────────────────────────────────────────────────────────────────────────────────

  emitCdp(tabId: number, method: string, params: Record<string, unknown> = {}, sessionId?: string): void {
    for (const l of this.debuggerOnEvent.listeners) l(sessionId === undefined ? { tabId } : { tabId, sessionId }, method, params);
  }
  async userCancelsInfobar(tabId: number): Promise<void> {
    this.attachedDebuggers.delete(tabId);
    for (const l of this.debuggerOnDetach.listeners) l({ tabId }, "canceled_by_user");
    await flush();
  }
  /** The user (or the page) closes a tab. */
  async closeTab(tabId: number): Promise<void> {
    const had = this.attachedDebuggers.delete(tabId);
    this.pageEnabled.delete(tabId);
    this.tabs_.delete(tabId);
    if (had) for (const l of this.debuggerOnDetach.listeners) l({ tabId }, "target_closed");
    for (const l of this.tabsOnRemoved.listeners) l(tabId);
    this.pruneGroups();
    await flush();
  }
  /** The user pins a tab: Chrome takes a pinned tab out of its group. */
  pinTab(tabId: number): void {
    this.tabOr(tabId).groupId = -1;
    this.pruneGroups();
  }
  /** The browser restarted: session storage is gone, and so are the old tab and group ids. */
  restartBrowser(): void {
    for (const k of Object.keys(this.sessionStorage_)) delete this.sessionStorage_[k];
    const old = [...this.tabs_.values()];
    this.tabs_.clear();
    this.groups_.clear();
    this.attachedDebuggers.clear();
    // Ids start over: a restored tab can get an id an old agent tab had.
    this.nextTab = 100;
    for (const t of old) this.addTab({ ...t, id: undefined, groupId: -1 });
  }
  private pruneGroups(): void {
    for (const id of [...this.groups_.keys()]) {
      if (![...this.tabs_.values()].some((t) => t.groupId === id)) {
        this.groups_.delete(id);
        for (const l of this.groupsOnRemoved.listeners) l({ id });
      }
    }
  }

  /** Calls whose name says they could move the user's view. The ChromeApi has none; this proves none were made. */
  viewMovingCalls(): string[] {
    return this.calls.filter((c) => /update$|highlight|focus|windows\.create/.test(c.api) && c.api !== "tabGroups.update").map((c) => c.api)
      .concat(this.calls.filter((c) => c.api === "tabs.create" && (c.args[0] as { active?: boolean }).active !== false).map(() => "tabs.create active"));
  }
}
