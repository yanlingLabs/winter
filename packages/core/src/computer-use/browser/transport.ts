// ComputerV2 Phase 2 — the ONE interface between the browser engine and a browser backend. The engine speaks
// CDP through it and nothing else; the built-in browser (Winter.app over the browser link) and the user's browsers (the
// Winter for Chrome extension over winter-browser-host) each implement it. Change it only through the controller.

/** A browser family as the model names it: `browsers.list()` ids, `{ browser }` options, tab id prefixes. */
export type BrowserFamily = "winter" | "chrome" | "edge" | "brave" | "vivaldi" | "opera" | "arc" | "chromium";

/** One connected backend: the family's id for the first instance, `"<family>#<n>"` for further ones. */
export type BackendId = string;

export interface TransportTab {
  /** The backend's own tab id as a string: a panel tab id (winter) or a chrome.tabs id (extension). */
  tabKey: string;
  url: string;
  title: string;
  active: boolean;
  /** Opened by Winter's automation — winter: minted by `browsers.open` in this daemon run; extension: in a Winter group. */
  agent: boolean;
  /** The Winter session it belongs to — winter: the panel tab's session; extension: the Winter group's session. */
  sessionId?: string;
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
   *  session's Winter group; winter: the daemon has already minted the panel tab, so this makes its browser live). */
  createTab(opts: { sessionId: string; sessionTitle?: string; url: string; tabKey?: string }): Promise<TransportTab>;
  closeTab(tabKey: string): Promise<void>;
  /** extension: take it out of the Winter group (it stays as the user's tab); winter: nothing. */
  keepTab(tabKey: string): Promise<void>;
  listTabs(opts?: { sessionId?: string }): Promise<TransportTab[]>;
  /** Make the tab drivable — winter: its browser live and held; extension: the debugger attached. Idempotent. */
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
  /** extension: the user pressed the in-page Stop button. winter: never fires. */
  onStop(listener: (tabKey: string) => void): () => void;
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
  /** `instanceKey` (the extension's instanceId; "winter" for the link) keeps the id stable: the same key always gets
   *  the same BackendId back for the daemon's lifetime, replacing a stale entry — never a new `#n`. */
  register(transport: CdpTransport, info: { family: BrowserFamily; name: string; bundleId?: string; instanceKey: string }): { id: BackendId; unregister(): void };
  /** A known-but-unconnected family (installed, not connected; or refused at hello), shown by browsers.list(). */
  noteUnavailable(info: { family: BrowserFamily; name: string; bundleId?: string; reason: string }): void;
  get(id: BackendId): CdpTransport | undefined;
  list(): BrowserBackendInfo[];
  onChange(listener: () => void): () => void;
}
