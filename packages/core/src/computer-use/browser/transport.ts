// ComputerV2 Phase 2 — the ONE interface between the browser engine and a browser backend. The engine speaks
// CDP through it and nothing else; the built-in browser (Winter.app over the browser link), Winter's headless browser
// (private, windowless engines the daemon runs over pipes) and the user's browsers (the Winter for Chrome extension
// over winter-browser-host) each implement it. Change it only through the controller.
import type { WatchArmResult, WatchSpec } from "./page-runtime/watch";

/** A browser family as the model names it: `browsers.list()` ids, `{ browser }` options, tab id prefixes. */
export type BrowserFamily = "winter" | "headless" | "chrome" | "edge" | "brave" | "vivaldi" | "opera" | "arc" | "chromium";

/** One connected backend: the family's id for the first instance, `"<family>#<n>"` for further ones. */
export type BackendId = string;

export interface TransportTab {
  /** The backend's own tab id as a string: a panel tab id (winter), an engine-prefixed id (headless: "w-…" for Winter's
   *  own engine, "chrome-…" and so on for an installed one) or a chrome.tabs id (extension). */
  tabKey: string;
  url: string;
  title: string;
  active: boolean;
  /** Opened by Winter's automation — winter: minted by `browsers.open` in this daemon run; headless: every tab (the
   *  browser is Winter's own); extension: in a Winter group. */
  agent: boolean;
  /** The Winter session it belongs to — winter: the panel tab's session; headless: the session whose browser context
   *  holds it; extension: the Winter group's session. */
  sessionId?: string;
  /** Phase 3 (extension): when the user last had the tab in front (epoch ms), its tab group's title, its window. */
  lastAccessed?: number;
  group?: string;
  windowId?: number;
}

/** Phase 3 — one download the browser itself is saving for an armed tab (`CdpTransport.armDownloads`). */
export interface TransportDownload {
  /** The backend's own id for this download. */
  id: string;
  /** `refused`: a download the tab started while NOT armed (winter: Winter.app refused it; the engine only says so). */
  state: "started" | "progress" | "done" | "failed" | "refused";
  /** The suggested file name. */
  name: string;
  url?: string;
  /** `done`: the finished file — inside the armed `dir` (winter), or in the browser's own download folder (extension:
   *  under the armed `subdir`, unless the user picked another place in the browser's save dialog). */
  path?: string;
  bytes: number;
  totalBytes?: number;
  mime?: string;
  error?: string;
}

export interface CdpEvent {
  tabKey: string;
  method: string;
  params: Record<string, unknown>;
  /** A flattened child target's CDP session (an out-of-process iframe), when the event is from one. */
  cdpSessionId?: string;
}

export type TransportErrorCode =
  | "disconnected"        // the backend went away (Winter.app quit, the host or extension disconnected) — retryable
  | "tab_gone"            // the tab was closed, crashed, or its browser was stopped
  | "attach_refused"      // the tab cannot be debugged (a browser-internal page, a store page, another debugger, the user cancelled)
  | "not_allowed"         // a method or event outside cdp-allowlist.ts, or a world rule broken — refused before sending
  | "cdp_error"           // the browser answered an error: data.cdpCode, data.cdpMessage
  | "timeout"
  | "capacity"            // the backend's own tab or memory budget is spent (headless) — close tabs first; not retryable at once
  | "protocol_mismatch";  // the far side speaks another protocol: data.side ("app" | "extension"), data.expected

export class TransportError extends Error {
  constructor(readonly code: TransportErrorCode, message: string, readonly data: Record<string, unknown> = {}) {
    super(message);
    this.name = "TransportError";
  }
}

export interface CdpTransport {
  readonly backend: BackendId;
  readonly family: BrowserFamily;
  /** False once the far side is gone; every call then rejects `disconnected`. */
  readonly connected: boolean;
  /** Open a tab without activating anything the user is looking at outside Winter (extension: `active: false`, in the
   *  session's Winter group; winter: the daemon has already minted the panel tab, so this makes its browser live;
   *  headless: a windowless or background page in the session's own private context, on `engine` — "winter" (the
   *  default: Winter's own CEF helper) or an installed browser's family id; every other backend ignores `engine`). */
  createTab(opts: { sessionId: string; sessionTitle?: string; url: string; tabKey?: string; engine?: string }): Promise<TransportTab>;
  closeTab(tabKey: string): Promise<void>;
  /** extension: take it out of the Winter group (it stays as the user's tab) — into the user's own group named `group`
   *  in its window when given (Phase 3); winter, headless: nothing. */
  keepTab(tabKey: string, opts?: { group?: string }): Promise<void>;
  listTabs(opts?: { sessionId?: string }): Promise<TransportTab[]>;
  /** Make the tab drivable — winter: its browser live and held; headless: a flattened CDP session on its page target;
   *  extension: the debugger attached. Idempotent. */
  attach(tabKey: string, opts: { sessionId: string }): Promise<{ viewport: [w: number, h: number]; dpr: number }>;
  /** Drop the hold / detach the debugger. Idempotent; never closes the tab. */
  detach(tabKey: string): Promise<void>;
  send<T = unknown>(tabKey: string, method: string, params?: Record<string, unknown>, opts?: { cdpSessionId?: string; timeoutMs?: number }): Promise<T>;
  /** Forward exactly these events for the tab (a subset of CDP_ALLOWED_EVENTS); replaces the tab's previous set. */
  subscribe(tabKey: string, events: readonly string[]): Promise<void>;
  onEvent(listener: (e: CdpEvent) => void): () => void;
  onTabGone(listener: (tabKey: string, reason: "closed" | "crashed" | "stopped" | "detached_by_user") => void): () => void;
  /** The agent cursor / glow in the tab. Best effort: never throws, never awaited by the engine. */
  overlay(tabKey: string, o: { active: boolean; cursor?: { x: number; y: number; kind: "move" | "press" | "type" | "scroll" } }): void;
  /** extension: the user pressed the in-page Stop button. winter, headless: never fires. */
  onStop(listener: (tabKey: string) => void): () => void;

  // ── Phase 3: optional members. A backend without one does not offer that capability (the engine says so typed). ──

  /** Show the tab to the user: its window (winter: the session's window) brought forward and the tab selected. ONLY
   *  for `waitForUser`, after the user's own "Show me the tab" on its card. */
  present?(tabKey: string, opts: { sessionId: string }): Promise<void>;
  /** extension: the user answered Done (`true`) or Stop waiting (`false`) in the toolbar for a tab waiting on them. */
  onUserDone?(listener: (tabKey: string, done: boolean) => void): () => void;
  setMuted?(tabKey: string, muted: boolean): Promise<void>;
  /** extension: the session's Winter group — its title (shown "Winter · <title>"), color, collapsed state. */
  updateGroup?(opts: { sessionId: string; title?: string; color?: string; collapsed?: boolean }): Promise<void>;
  /** extension: the normal, non-private windows. */
  listWindows?(): Promise<Array<{ id: number; focused: boolean; tabs: number }>>;
  /** extension, read-only; refused `not_allowed` with `data.permission` while the user has not granted it. */
  history?(q: { text: string; startTime?: number; endTime?: number; maxResults: number }): Promise<Array<{ url: string; title: string; lastVisitTime: number }>>;
  bookmarks?(q: { text?: string; maxResults: number }): Promise<Array<{ url: string; title: string; folder: string }>>;
  /**
   * Downloads the BROWSER itself saves for this tab until `until` (epoch ms), at most `maxBytes` each; `null` disarms.
   * winter: Winter.app's own handler writes into `dir` (Winter's staging, inside its home); extension (its optional
   * `downloads` permission granted): the browser writes into `<its download folder>/<subdir>/` and may show its own
   * "save as" dialog if the user asked it to. Each is reported through `onDownload`. Absent, or refused `not_allowed`
   * (`data.permission`): the engine catches http(s) downloads over CDP Fetch instead.
   */
  armDownloads?(tabKey: string, opts: { dir: string; subdir: string; until: number; maxBytes: number } | null): Promise<void>;
  /** winter: download `url` in that tab's browser (its cookies), caught by the armed handler. */
  startDownload?(tabKey: string, url: string): Promise<void>;
  onDownload?(listener: (tabKey: string, d: TransportDownload) => void): () => void;
  /** The engine has taken the finished file: the browser forgets the item (extension: its downloads list entry). */
  releaseDownload?(id: string): Promise<void>;

  // ── wake triggers (Winter for Chrome 1.2.0, feature `watch`) ──

  /** Keep a watch on the tab's top document with NO debugger: the extension injects the page watcher
   *  (`page-runtime/watch.ts`) into its own isolated world, again in each new document of the tab (`initial: "fire"`,
   *  or `"baseline"` after its own input or navigation), and reports what it sees. The watcher's answer to the first
   *  injection. */
  watch?(tabKey: string, spec: WatchSpec): Promise<WatchArmResult>;
  /** Idempotent; the watcher (its ring and pill) leaves the page. */
  unwatch?(tabKey: string, watchId: string): Promise<void>;
  onWatchEvent?(listener: (tabKey: string, e: TransportWatchEvent) => void): () => void;
}

/** One report of a tab watch (`CdpTransport.onWatchEvent`). */
export interface TransportWatchEvent {
  watchId: string;
  /** `url`: the tab's top-level URL changed (a `navigated` watch); `lost`: `reason` "doc" (a new document under a ref
   *  watch), "gone" (its element went), "disconnected" (the link to the extension dropped). */
  outcome: "fired" | "pressed" | "lost" | "url";
  /** Epoch ms. */
  at: number;
  url?: string;
  title?: string;
  reason?: string;
  /** The extension sent this tab input or a navigation (its debugger) within the grace before `at`. */
  own?: boolean;
}

export interface BrowserBackendInfo {
  id: BackendId;
  family: BrowserFamily;
  /** "Winter (built-in)", "Google Chrome", "Google Chrome (2)". */
  name: string;
  /** Extension backends: the browser app's bundle id (the per-app card and access settings). */
  bundleId?: string;
  connected: boolean;
  /** Why it is not connected, one sentence for the model and Settings. */
  reason?: string;
}

/** The backends the engine can use. B's link and D's host server register transports; the engine reads. */
export interface BackendRegistry {
  /** `instanceKey` (the extension's instanceId; "winter" for the link; "headless" for the pool) keeps the id stable:
   *  the same key always gets the same BackendId back for the daemon's lifetime, replacing a stale entry — never a new `#n`. */
  register(transport: CdpTransport, info: { family: BrowserFamily; name: string; bundleId?: string; instanceKey: string }): { id: BackendId; unregister(): void };
  /** A known-but-unconnected family (installed, not connected; or refused at hello), shown by browsers.list(). */
  noteUnavailable(info: { family: BrowserFamily; name: string; bundleId?: string; reason: string }): void;
  get(id: BackendId): CdpTransport | undefined;
  list(): BrowserBackendInfo[];
  onChange(listener: () => void): () => void;
}
