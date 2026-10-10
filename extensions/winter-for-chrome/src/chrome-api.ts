// Winter for Chrome — exactly the `chrome.*` surface the extension uses, as an interface: `background.ts` binds the
// real `chrome`, and the tests bind a fake. Anything not listed here the extension never calls — in particular nothing
// that activates a tab or focuses a window (`tabs.update`, `tabs.highlight`, `windows.update`, `windows.create`), and
// nothing that reads cookies or storage of a site.

export interface ChromeTab {
  id?: number;
  windowId: number;
  url?: string;
  pendingUrl?: string;
  title?: string;
  active: boolean;
  /** -1 when the tab is in no group. */
  groupId: number;
  incognito: boolean;
}

export interface ChromeWindow {
  id?: number;
  incognito: boolean;
  type?: string;
}

export interface ChromeTabGroup {
  id: number;
  windowId: number;
  title?: string;
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
    group(p: { tabIds: number[]; groupId?: number; createProperties?: { windowId: number } }): Promise<number>;
    ungroup(tabIds: number[]): Promise<void>;
    onRemoved: ChromeEvent<(tabId: number) => void>;
  };
  tabGroups: {
    get(groupId: number): Promise<ChromeTabGroup>;
    update(groupId: number, p: { title: string; color: "blue" }): Promise<unknown>;
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
  };
  runtime: {
    connectNative(application: string): ChromePort;
    onMessage: ChromeEvent<(message: unknown, sender: MessageSender, sendResponse: (response: unknown) => void) => boolean | undefined>;
  };
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
