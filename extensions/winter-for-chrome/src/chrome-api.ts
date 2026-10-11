// Winter for Chrome — exactly the `chrome.*` surface the extension uses, as an interface: `background.ts` binds the
// real `chrome`, and the tests bind a fake. Anything not listed here the extension never calls — in particular nothing
// that activates a tab or focuses a window (`tabs.highlight`, `windows.create`, and `tabs.update`/`windows.update` only
// through the narrow members below: `tabs.setMuted` changes nothing but a tab's sound, and `tabs.bringForward` is the
// sign-in hand-off's ONE door, reached only from `tabs.present` — which Winter sends only after the user's OK on its
// card), and nothing that reads cookies or storage of a site.

export interface ChromeTab {
  id?: number;
  windowId: number;
  url?: string;
  pendingUrl?: string;
  title?: string;
  active: boolean;
  /** -1 when the tab is in no group. */
  groupId: number;
  status?: "loading" | "complete" | "unloaded";
  /** Its page was unloaded to save memory (`tabs.discard`); it loads again when shown or navigated. */
  discarded?: boolean;
  incognito: boolean;
  /** When the tab was last active, ms since the epoch (Chrome 121+). */
  lastAccessed?: number;
  mutedInfo?: { muted: boolean };
}

export interface ChromeWindow {
  id?: number;
  incognito: boolean;
  type?: string;
  focused?: boolean;
}

/** Chrome's tab-group colors. */
export const GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"] as const;
export type GroupColor = (typeof GROUP_COLORS)[number];

export interface ChromeTabGroup {
  id: number;
  windowId: number;
  title?: string;
  color?: GroupColor;
  collapsed?: boolean;
}

/** `chrome.debugger`'s Debuggee / DebuggerSession (a `sessionId` addresses a flattened child target, Chrome 125+). */
export interface DebuggerTarget {
  tabId?: number;
  sessionId?: string;
}

export interface StorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface ChromeEvent<F extends (...args: never[]) => unknown> {
  addListener(listener: F): void;
}

export interface ChromePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: ChromeEvent<(message: unknown) => void>;
  onDisconnect: ChromeEvent<() => void>;
}

export interface MessageSender {
  id?: string;
  tab?: ChromeTab;
}

/** `chrome.downloads.DownloadItem`, as far as Winter for Chrome reads it. */
export interface ChromeDownloadItem {
  id: number;
  url: string;
  finalUrl?: string;
  referrer?: string;
  /** The absolute path the file is (or will be) saved at. */
  filename: string;
  mime?: string;
  /** ISO 8601. */
  startTime?: string;
  state?: "in_progress" | "interrupted" | "complete";
  totalBytes: number;
  fileSize: number;
  bytesReceived: number;
  error?: string;
}

/** `chrome.downloads`, while the optional `downloads` permission is granted. */
export interface ChromeDownloads {
  search(q: { id: number }): Promise<ChromeDownloadItem[]>;
  /** Removes the item from the browser's downloads list (never the file). */
  erase(q: { id: number }): Promise<number[]>;
  cancel(id: number): Promise<void>;
  onCreated: ChromeEvent<(item: ChromeDownloadItem) => void>;
  onDeterminingFilename: ChromeEvent<(item: ChromeDownloadItem, suggest: (s?: { filename: string; conflictAction: "uniquify" }) => void) => boolean | undefined | void>;
  onChanged: ChromeEvent<(delta: { id: number; state?: { current?: string }; error?: { current?: string }; totalBytes?: { current?: number } }) => void>;
}

/** The optional permissions' APIs, each present only while the user has granted it — read-only for history and
 *  bookmarks (no member here could add, change or remove one). */
export interface ChromeOptionalApis {
  history?: { search(q: { text: string; maxResults: number; startTime?: number; endTime?: number }): Promise<Array<{ url?: string; title?: string; lastVisitTime?: number }>> };
  bookmarks?: {
    search(query: string): Promise<Array<{ id: string; url?: string; title?: string; parentId?: string }>>;
    getRecent(n: number): Promise<Array<{ id: string; url?: string; title?: string; parentId?: string }>>;
    get(id: string): Promise<Array<{ id: string; url?: string; title?: string; parentId?: string }>>;
  };
  downloads?: ChromeDownloads;
}

export interface ChromeApi {
  readonly runtimeId: string;
  readonly extensionVersion: string;
  /** `chrome.runtime.lastError?.message` right now (a native port's disconnect reason). */
  lastError(): string | undefined;
  tabs: {
    get(tabId: number): Promise<ChromeTab>;
    query(query: Record<string, never>): Promise<ChromeTab[]>;
    create(p: { url: string; active: false; windowId: number }): Promise<ChromeTab>;
    remove(tabId: number): Promise<void>;
    /** Unloads a background tab's page (no beforeunload: nothing can ask "leave this page?"); refused for the active tab. */
    discard(tabId: number): Promise<ChromeTab | undefined>;
    group(p: { tabIds: number[]; groupId?: number; createProperties?: { windowId: number } }): Promise<number>;
    ungroup(tabIds: number[]): Promise<void>;
    /** `tabs.update(tabId, { muted })` — nothing else of the tab changes. */
    setMuted(tabId: number, muted: boolean): Promise<void>;
    /** The hand-off: the tab becomes its window's active one and the window is focused — `tabs.update(tabId, { active:
     *  true })` + `windows.update(windowId, { focused: true })`. ONLY `tabs.present` calls it. */
    bringForward(tabId: number, windowId: number): Promise<void>;
    onRemoved: ChromeEvent<(tabId: number) => void>;
    /** The user (never Winter) made a tab the active one of its window. */
    onActivated: ChromeEvent<(info: { tabId: number; windowId: number }) => void>;
  };
  tabGroups: {
    get(groupId: number): Promise<ChromeTabGroup>;
    update(groupId: number, p: { title?: string; color?: GroupColor; collapsed?: boolean }): Promise<unknown>;
    /** The groups of the browser's windows (private windows' included: the caller filters by window). */
    query(q: Record<string, never>): Promise<ChromeTabGroup[]>;
    onRemoved: ChromeEvent<(group: { id: number }) => void>;
  };
  windows: {
    getLastFocused(q: { windowTypes: ["normal"] }): Promise<ChromeWindow>;
    getAll(q: { windowTypes: ["normal"] }): Promise<ChromeWindow[]>;
  };
  debugger: {
    attach(target: { tabId: number }, version: string): Promise<void>;
    detach(target: { tabId: number }): Promise<void>;
    sendCommand(target: DebuggerTarget, method: string, params?: Record<string, unknown>): Promise<unknown>;
    onEvent: ChromeEvent<(source: DebuggerTarget, method: string, params?: Record<string, unknown>) => void>;
    onDetach: ChromeEvent<(source: DebuggerTarget, reason: string) => void>;
  };
  scripting: {
    /** Always `world: "ISOLATED"` — the extension's own content-script world, never the page's. */
    executeScript(i: { target: { tabId: number }; world: "ISOLATED"; func: (arg: never) => void; args: [unknown] }): Promise<unknown>;
  };
  storage: {
    /** `chrome.storage.local`: kept across browser restarts (the instance id). */
    local: StorageArea;
    /** `chrome.storage.session`: kept across service-worker restarts, cleared when the browser quits (tab and group ids). */
    session: StorageArea;
  };
  action: {
    setBadgeText(p: { text: string }): Promise<void>;
    setBadgeBackgroundColor(p: { color: string }): Promise<void>;
    setTitle(p: { title: string }): Promise<void>;
    /** "" while Winter is driving a tab: a click on the toolbar button is then Stop (`onClicked`), not the popup. */
    setPopup(p: { popup: string }): Promise<void>;
    onClicked: ChromeEvent<(tab: ChromeTab) => void>;
  };
  runtime: {
    connectNative(application: string): ChromePort;
    onMessage: ChromeEvent<(message: unknown, sender: MessageSender, sendResponse: (response: unknown) => void) => boolean | undefined>;
  };
  /** `chrome.permissions`: whether an optional permission is granted, and when one is switched on or off (the popup
   *  asks for them — a permission request needs the user's own click there). */
  permissions: {
    contains(p: { permissions: string[] }): Promise<boolean>;
    onAdded: ChromeEvent<(p: { permissions?: string[] }) => void>;
    onRemoved: ChromeEvent<(p: { permissions?: string[] }) => void>;
  };
  /** The optional permissions' APIs as they are NOW (each appears when granted). */
  optional(): ChromeOptionalApis;
  randomUUID(): string;
}

/** Timers, injectable so the 5-minute idle detach and the reconnect backoff are testable. */
export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};
