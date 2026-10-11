// ComputerV2 Phase 2 — the BROWSER ENGINE: browser tabs as ComputerV2 targets, and the `browsers` global. The service
// (`service.ts`) routes every primitive on a tab target and every `browsers.*` call here, with a `TabRunScope`; the
// engine speaks CDP to the tab through its backend's transport (`transport.ts` — Winter.app's link for the built-in
// browser, Winter for Chrome for the user's), via one `TabDriver` per tab.
//
// What the engine owns, per session: its BINDINGS (target ids `bt_<12 hex>`, stable per (session, backend, tab) while
// the runtime lives), which tabs are its AGENT tabs (opened by `browsers.open`; remembered across a reset), and the
// sites approved on the dangerous-domain card. Tab targets never enter the service's own target table: every
// helper-facing loop stays app-only, and a tab-only script never launches the helper.
//
// POLICY. The built-in browser (`winter`) has no per-app card and no access setting ("Allow all apps" does not apply),
// but `plan` is observe-only and chat has no computer use. A user's browser is the app with its bundle id: the
// existing per-app policy (`authorize`) — `browsers.open` is checked as a full-class act first, then as a bind;
// `browsers.tab` is a bind; reads are observes; acts are acts. One grant covers the browser as an app and its tabs.
// The dangerous-domain floor and the secure-field floor apply to both backends.
import { randomBytes } from "node:crypto";
import { constants, copyFileSync, lstatSync, realpathSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { nextScreenshotQuality, screenshotBudgetFor, SCREENSHOT_BYTE_CAP, SCREENSHOT_QUALITY } from "../budget";
import { AutomationFailure } from "../errors";
import { cardReason, type AppRef } from "../policy";
import type { TabHandle } from "../worker/bridge";
import { browserForBundleId, familyInfo, familyOfBackendId } from "./families";
import { shouldCloseAgentTab } from "./lifecycle";
import type { BrowserBackendRegistry } from "./registry";
import { BLOCKED_TAB_PRIMITIVES, ensureSiteAllowed, listedHost, SiteApprovals, type SiteFloorDeps } from "./site-policy";
import type { TabRunScope } from "./tab-scope";
import { redactText, redactUrl } from "./page-runtime/redact";
import { cssSelectorRefusal } from "./page-runtime/rules";
import { pickerSentence, shownUrl, TabDriver, transportFailure, transportHasCdp3 } from "./tab-driver";
import { TransportError, type BackendId, type BrowserFamily, type CdpTransport, type TransportTab } from "./transport";
import { checkUploadFiles, clearStagedUploads, stageUploads } from "./upload-paths";
import { BODY_DEFAULT_CHARS, BODY_MAX_CHARS, isTextMime, redactBody } from "./body-redact";
import { bytesLabel, CONSOLE_LEVELS, consoleLine, requestLine } from "./devtools";
import { clearStagedDownloads, DOWNLOAD_MAX_BYTES, DOWNLOADS_PER_RUN, newStagingDir, placeDownload, planDownload, type DownloadPlan, type DownloadRoots } from "./download-paths";
import {
  decodeDataUrl, DOWNLOAD_START_DEFAULT_MS, DOWNLOAD_TOTAL_MAX_MS, FetchCapture, NativeCapture, nativeArmFailure, waitForCapture, type CapturedFile,
} from "./downloads";

/** `state()`/`screenshot()` settle for at most this long after an act in the same call (Phase 1's cap). */
const SETTLE_CAP_MS = 1_500;
const HTML_DEFAULT_CHARS = 100_000;
const HTML_MAX_CHARS = 500_000;
const ASSET_KINDS = ["image", "media", "font", "stylesheet", "script"] as const;
/** Chrome's tab-group colors. */
const GROUP_COLORS: readonly string[] = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
const WAIT_FOR_DEFAULT_MS = 10_000;
const NO_VISION = "this model can't see images — use state()";
const FOCUS_NOT_EDITABLE = "the focus is not a text field, so nothing was typed — click the field or pass { into }";

/** What a tab primitive is, for the per-app policy (everything not here acts). */
const OBSERVE_PRIMITIVES: ReadonlySet<string> = new Set(["state", "find", "screenshot", "waitFor", "waitForIdle", "url", "title", "text",
  // Phase 3's readers, and the hand-off (the user acts there, not Winter; it has its own card)
  "console", "network", "networkBody", "inspect", "html", "assets", "dialog", "waitForUser"]);
/** waitForUser(): 5 minutes by default, at most 30 (the script's clock is paused while the user works). */
const HANDOFF_DEFAULT_MS = 5 * 60_000;
const HANDOFF_MAX_MS = 30 * 60_000;
/** The hand-off's two cards (the Mac words their buttons by these ids: "Show me the tab" / "Not now", then
 *  "Done" / "Stop waiting"). A plain approve of the first card is "show"; of the second, "done". */
export const HANDOFF_ASK_OPTIONS = [{ id: "handoff_show", label: "Show me the tab" }, { id: "handoff_done", label: "I've done it" }] as const;
export const HANDOFF_WAIT_OPTIONS = [{ id: "handoff_done", label: "Done" }] as const;

export interface BrowserEngineDeps {
  registry: BrowserBackendRegistry;
  /** Mint a web tab in the session's panel strip (the daemon's `mintPanelTab`, the old Browser's door); its id. */
  mintWinterTab(sessionId: string, url: string | undefined): string;
  /** A built-in tab the engine closed: the daemon records `panel_tab_closed` for it. */
  winterTabClosed?(sessionId: string, tabId: string): void;
  /** The session's own panel web tabs (`foldPanelTabs`). */
  winterTabs(sessionId: string): { tabs: Array<{ tabId: string; url?: string; title?: string }>; activeTabId?: string };
  /** The session's working directory and title. */
  sessionInfo(sessionId: string): { cwd?: string | null; title?: string };
  site?: SiteFloorDeps;
  /** Uploads: the Winter home, and the session's temp directory and read-deny list. */
  home: string;
  uploadRoots?(sessionId: string, cwd: string | null | undefined): { tmpDir?: string; denyRead: readonly string[] };
  /** Downloads: the session's temp directory AS SPELLED (`sessionTmpDirPath`), and the sandbox's deny-write and
   *  deny-read lists for the session. */
  downloadRoots?(sessionId: string, cwd: string | null | undefined): { tmpDir: string; denyWrite: readonly string[]; denyRead: readonly string[] };
  /** `computerUse.screenshotMaxDim` (read live). */
  screenshotMaxDim?(): number | undefined;
  /** Is an app with this bundle id installed (a LaunchServices lookup, never a launch)? */
  installed?(bundleId: string): boolean;
  /** Did the user allow this app beyond one call (the service's policy)? */
  persistentlyAllowed?(sessionId: string, bundleId: string): boolean;
  /** Stop the script a session is running now (the extension's Stop button). */
  stopScript?(sessionId: string, reason: string): void;
  /** Is the session running a main-thread turn now (a daemon restart's orphaned agent tabs stay open while it is)? */
  turnRunning?(sessionId: string): boolean;
  now?(): number;
  log?(line: string): void;
}

interface Binding {
  targetId: string;
  backend: BackendId;
  /** The tab's key in its backend (moves when the tab comes back under a new one after a navigation). */
  tabKey: string;
  kind: "agent" | "user";
  boundRun: string;
  bundleId?: string;
  /** Why the binding no longer works (`turn_end`, `once`, `closed`, `crashed`, …). */
  lost?: string;
}

interface SessionBrowsers {
  bindings: Map<string, Binding>;
  /** backend|tabKey → target id. */
  byTab: Map<string, string>;
  /** This session's agent tabs (kept across a reset or a worker restart), with the model's marks: `kept` (handed to
   *  the user) and `handoff` (survives this turn's end only). */
  agentTabs: Map<string, AgentTab>;
}

interface AgentTab { backend: BackendId; tabKey: string; kept: boolean; handoff: boolean }

export interface BrowserListRow { id: string; name: string; isDefault: boolean; connected: boolean; reason?: string }
/** One `browsers.tabs()` row. */
type TabRow = { id: string; browser: string; url: string; title: string; active: boolean; yours: boolean; lastUsed?: string; group?: string };

/** At most this many tabs held (a live built-in browser, an attached debugger) per session and in all; past it the
 *  least recently used is let go (still open: its next use takes it again). */
export const HOLDS_PER_SESSION = 8;
/** Navigation in a user's browser leaves only tabs Winter opened and still owns: the user's own tab — or one handed to
 *  them with `keep()` — could ask "leave this page?" and lose their work (the controller's ruling; Winter's built-in
 *  browser hides its dialogs, so it is exempt). */
const NAVIGATE_PRIMITIVES: ReadonlySet<string> = new Set(["goto", "back", "forward", "reload"]);
export const USER_TAB_NAVIGATION = "this is the user's own tab — navigating it away could raise a leave-page prompt and lose their work; open the page in a new tab with browsers.open(url)";
/** How long a closed tab's teardown is kept for a `rekey` (a navigation's answer follows its "closed" at once). */
const RECENTLY_CLOSED_MS = 30_000;
export const HOLDS_GLOBAL = 16;

const isRef = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const isPoint = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n));
const bad = (message: string): Error => Object.assign(new TypeError(message), { name: "TypeError" });
const tabKeyOf = (backend: string, tabKey: string): string => `${backend}|${tabKey}`;

/** `browsers.open`/`goto` URLs: http(s), or exactly about:blank. Any other scheme (`javascript:` would run code outside
 *  the isolated world; `file:` is not in this phase) is refused here, before any browser sees it. */
export function checkTabUrl(url: unknown, what: string): string {
  if (typeof url !== "string" || url.trim().length === 0) throw bad(`${what} takes a URL`);
  let u = url.trim();
  if (u === "about:blank") return u;
  // A bare host[:port][/path] gets a scheme: http for this Mac's own servers, https for the rest.
  const bare = /^(localhost|\[[0-9a-f:]+\]|\d{1,3}(?:\.\d{1,3}){3}|(?:[a-z0-9-]+\.)+[a-z]{2,})(:\d{1,5})?([/?#].*)?$/i.exec(u);
  if (bare !== null) {
    const host = bare[1]!.toLowerCase();
    const local = host === "localhost" || host === "[::1]" || /^127\./.test(host);
    u = `${local ? "http" : "https"}://${u}`;
  }
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(u)?.[1]?.toLowerCase();
  if (scheme !== undefined && scheme !== "http" && scheme !== "https") {
    throw new AutomationFailure("NotAllowed", `${what} opens only http(s) pages and about:blank — a ${scheme}: URL is refused`);
  }
  let parsed: URL;
  try { parsed = new URL(u); } catch { throw bad(`${what}: "${u.slice(0, 120)}" is not a URL — pass a full http(s) URL`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new AutomationFailure("NotAllowed", `${what} opens only http(s) pages and about:blank`);
  return parsed.href;
}

/** "1 character" / "12 characters" (grapheme clusters). */
function characters(text: string): string {
  let n = 0;
  for (const _ of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) n += 1;
  return `${n.toLocaleString("en-US")} character${n === 1 ? "" : "s"}`;
}

export class BrowserEngine {
  private readonly sessions = new Map<string, SessionBrowsers>();
  private readonly drivers = new Map<string, TabDriver>();
  /** Tabs reported closed a moment ago, with what that tore down (`rekey` restores it when a navigation's answer says
   *  the tab came back under a new key). */
  private readonly recentlyClosed = new Map<string, { at: number; reason: string; agentTabs: Map<string, AgentTab> }>();
  private readonly hooked = new Map<CdpTransport, { backend: BackendId; off: Array<() => void> }>();
  private readonly approvals = new SiteApprovals();
  private readonly declined = new Map<string, Set<string>>();
  /** download() calls per run (session + run id), for the per-run cap. */
  private readonly downloadsByRun = new Map<string, number>();
  /** waitForUser(): the hand-off card waiting on a tab (backend|tabKey), answerable from the browser's own Done. */
  private readonly handoffAnswers = new Map<string, (approved: boolean, by: string, optionId?: string) => void>();
  private installedCache?: { at: number; ids: Set<string> };
  private unwatch?: () => void;
  private stopped = false;

  constructor(private readonly deps: BrowserEngineDeps) {
    // Files an earlier daemon run staged for uploads or downloads go (the daemon is starting: no session can be using
    // them).
    clearStagedUploads(deps.home);
    clearStagedDownloads(deps.home);
    this.unwatch = deps.registry.onChange(() => this.hookTransports());
    this.hookTransports();
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }

  private session(sessionId: string): SessionBrowsers {
    let s = this.sessions.get(sessionId);
    if (s === undefined) { s = { bindings: new Map(), byTab: new Map(), agentTabs: new Map() }; this.sessions.set(sessionId, s); }
    return s;
  }

  // ── the service's doors ────────────────────────────────────────────────────────────────────────

  owns(sessionId: string, targetId: string): boolean { return this.sessions.get(sessionId)?.bindings.has(targetId) === true; }

  label(sessionId: string, targetId: string): string | undefined {
    const b = this.sessions.get(sessionId)?.bindings.get(targetId);
    if (b === undefined) return undefined;
    const title = this.drivers.get(tabKeyOf(b.backend, b.tabKey))?.shownTitle.replace(/\s+/g, " ").trim();
    return title !== undefined && title.length > 0 ? `Tab "${title.slice(0, 60)}"` : `Tab ${b.backend}:${b.tabKey}`;
  }

  async global(scope: TabRunScope, primitive: string, args: Record<string, unknown>): Promise<unknown> {
    const t0 = this.now();
    try {
      if (this.stopped) throw new AutomationFailure("BrowserUnavailable", "Winter is shutting down");
      switch (primitive) {
        case "browsers.list": return this.listCall(scope, args);
        case "browsers.open": return await this.open(scope, args);
        case "browsers.tabs": return await this.tabs(scope, args);
        case "browsers.tab": return await this.bindCall(scope, args);
        case "browsers.windows": return await this.windowsCall(scope, args);
        case "browsers.history": return await this.libraryCall(scope, args, "history");
        case "browsers.bookmarks": return await this.libraryCall(scope, args, "bookmarks");
        case "browsers.group": return await this.groupCall(scope, args);
        default: throw bad(`unknown primitive ${primitive}`);
      }
    } finally {
      scope.metric.engineMs = this.now() - t0;
    }
  }

  async primitive(scope: TabRunScope, targetId: string, primitive: string, args: Record<string, unknown>): Promise<unknown> {
    const t0 = this.now();
    const b = this.binding(scope.sessionId, targetId);
    scope.metric.backend = b.backend;
    scope.noteBrowser(b.backend);
    try {
      scope.live();
      const facts = scope.sessionFacts();
      if (facts.mode === "chat" || facts.policy === "chat") throw new AutomationFailure("NotAllowed", "computer use is not available in chat");
      if (NAVIGATE_PRIMITIVES.has(primitive) && this.familyOf(b.backend) !== "winter" && this.usersTab(scope.sessionId, b)) throw new AutomationFailure("NotAllowed", USER_TAB_NAVIGATION);
      const act = !OBSERVE_PRIMITIVES.has(primitive);
      if (b.bundleId !== undefined) {
        const app = this.appRef(b.backend, b.bundleId);
        await scope.authorize(app, act ? { kind: "act", primitive } : { kind: "observe" });
      } else if (act && facts.policy === "plan") {
        throw new AutomationFailure("NotAllowed", "this session is in plan mode — ComputerV2 can look but not act");
      }
      scope.live();
      const driver = this.driverFor(b.backend, b.tabKey);
      await scope.lock(`tab:${b.backend}:${b.tabKey}`, this.label(scope.sessionId, targetId) ?? "That browser tab");
      scope.live();
      this.makeRoomForHold(scope, driver);
      driver.busy++;
      try {
        await driver.ensureAttached(scope.sessionId);
        scope.live();
        if (!BLOCKED_TAB_PRIMITIVES.has(primitive)) await this.siteFloor(scope, b, driver);
        return await this.run(scope, b, driver, primitive, args);
      } finally {
        driver.busy--;
      }
    } catch (err) {
      throw this.lostIfGone(scope.sessionId, b, err);
    } finally {
      scope.metric.engineMs = this.now() - t0;
    }
  }

  /** A run ended: its "once" site approvals go, and a user browser bound on an "Allow once" answer is released. */
  runEnded(sessionId: string, runId: string): void {
    this.approvals.runEnded(sessionId, runId);
    this.downloadsByRun.delete(`${sessionId}\u0000${runId}`);
    this.declined.delete(`${sessionId}\u0000${runId}`);
    const s = this.sessions.get(sessionId);
    if (s === undefined) return;
    for (const b of s.bindings.values()) {
      if (b.lost !== undefined || b.boundRun !== runId || b.bundleId === undefined) continue;
      if (this.deps.persistentlyAllowed?.(sessionId, b.bundleId) === true) continue;
      b.lost = "once";
      void this.drivers.get(tabKeyOf(b.backend, b.tabKey))?.release(sessionId);
    }
  }

  /** A main-thread turn ended: the user's tabs are released (never closed); the session's agent tabs in a user's
   *  browser close unless the model marked them (`keep()`, `handoff()` — the latter cleared now); built-in tabs stay. */
  turnEnded(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s === undefined) return;
    for (const b of s.bindings.values()) {
      if (b.kind !== "user" || b.lost !== undefined) continue;
      b.lost = "turn_end";
      void this.drivers.get(tabKeyOf(b.backend, b.tabKey))?.release(sessionId);
    }
    // A built-in tab's hold keeps a browser alive in Winter.app: it goes at the turn's end too (the binding stays; its
    // next use takes the hold again — the page is re-read then, so earlier refs are stale).
    for (const b of s.bindings.values()) {
      if (b.lost !== undefined || this.familyOf(b.backend) !== "winter") continue;
      void this.drivers.get(tabKeyOf(b.backend, b.tabKey))?.release(sessionId);
    }
    for (const [key, a] of [...s.agentTabs]) {
      if (shouldCloseAgentTab({ event: "turn-ended", family: this.familyOf(a.backend), kept: a.kept, handoff: a.handoff })) {
        this.closeAgentTab(sessionId, s, key, a, "closed_turn_end");
      } else {
        a.handoff = false;
      }
    }
  }

  /** The session was archived: its remaining agent tabs in a user's browser close (unless kept). */
  sessionArchived(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s === undefined) return;
    for (const [key, a] of [...s.agentTabs]) {
      if (shouldCloseAgentTab({ event: "session-archived", family: this.familyOf(a.backend), kept: a.kept })) this.closeAgentTab(sessionId, s, key, a, "closed_session_end");
    }
  }

  /** Close one agent tab in its browser (best effort) and forget it; a binding of it reads why. */
  private closeAgentTab(sessionId: string, s: SessionBrowsers, key: string, a: AgentTab, why: string): void {
    s.agentTabs.delete(key);
    const targetId = s.byTab.get(key);
    const b = targetId === undefined ? undefined : s.bindings.get(targetId);
    if (b !== undefined && b.lost === undefined) b.lost = why;
    const d = this.drivers.get(key);
    if (d !== undefined) { void d.release(sessionId); d.onGone("closed"); this.drivers.delete(key); }
    const transport = this.deps.registry.get(a.backend);
    if (transport === undefined || !transport.connected) return;
    void transport.closeTab(a.tabKey).catch((err: unknown) => this.deps.log?.(`computer-use: closing ${a.backend}:${a.tabKey} failed (${err instanceof Error ? err.message : "error"})`));
  }

  /** A reset or a worker restart: the bindings and holds go; the tabs stay open, and the engine still remembers
   *  which are this session's agent tabs. */
  forgetBindings(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s === undefined) return;
    for (const b of s.bindings.values()) if (b.lost === undefined) void this.drivers.get(tabKeyOf(b.backend, b.tabKey))?.release(sessionId);
    s.bindings.clear();
    s.byTab.clear();
  }

  /** The session's computer-use runtime ended: idled out, the session deleted, or the daemon stopping. */
  sessionEnded(sessionId: string, reason: "deleted" | "idle" | "stop"): void {
    clearStagedUploads(this.deps.home, sessionId);
    clearStagedDownloads(this.deps.home, sessionId);
    const s = this.sessions.get(sessionId);
    if (s !== undefined) {
      for (const b of s.bindings.values()) if (b.lost === undefined) void this.drivers.get(tabKeyOf(b.backend, b.tabKey))?.release(sessionId);
      if (reason === "deleted") {
        for (const [key, a] of [...s.agentTabs]) {
          if (shouldCloseAgentTab({ event: "session-deleted", family: this.familyOf(a.backend), kept: a.kept })) this.closeAgentTab(sessionId, s, key, a, "closed_session_end");
        }
      }
    }
    // The runtime idling out keeps the session's memory of its agent tabs (the next turn's end still closes them);
    // the bindings themselves went with the worker.
    if (reason === "idle" && s !== undefined) {
      s.bindings.clear();
      s.byTab.clear();
    }
    if (reason === "deleted") {
      this.sessions.delete(sessionId);
      this.approvals.sessionEnded(sessionId);
    }
  }

  /**
   * A built-in tab left the session's strip (`panel_tab_closed` — the user closed it, or Winter did): its hold is
   * released and every binding of it is `TargetLost`. The app cannot tell a closed tab from one not folded yet, so it
   * keeps a held browser alive until the daemon lets go.
   */
  panelTabClosed(sessionId: string, tabId: string): void {
    const key = tabKeyOf("winter", tabId);
    const d = this.drivers.get(key);
    if (d !== undefined) {
      for (const sid of [...d.holders]) void d.release(sid);
      d.onGone("closed");
      this.drivers.delete(key);
    }
    for (const s of this.sessions.values()) {
      const targetId = s.byTab.get(key);
      const b = targetId === undefined ? undefined : s.bindings.get(targetId);
      if (b !== undefined && b.lost === undefined) b.lost = "closed";
      s.agentTabs.delete(key);
    }
    void sessionId;
  }

  /** Daemon stop: every hold is released, nothing is closed. */
  stop(): void {
    this.stopped = true;
    for (const d of this.drivers.values()) for (const sid of [...d.holders]) void d.release(sid);
    this.unwatch?.();
    for (const h of this.hooked.values()) for (const off of h.off) off();
    this.hooked.clear();
  }

  /** The backends for `computerUse.status` and `browsers.list()`. */
  listRows(): BrowserListRow[] {
    const rows = new Map<string, BrowserListRow>();
    for (const r of this.deps.registry.list()) {
      rows.set(r.id, { id: r.id, name: r.name, isDefault: r.id === "winter", connected: r.connected, ...(r.reason === undefined ? {} : { reason: r.reason }) });
    }
    if (!rows.has("winter")) rows.set("winter", { id: "winter", name: "Winter (built-in)", isDefault: true, connected: false, reason: "Winter isn't running" });
    const installed = this.installedBundleIds();
    for (const fam of ["chrome", "edge", "brave", "vivaldi", "opera", "arc", "chromium"] as const) {
      const info = familyInfo(fam)!;
      if ([...rows.values()].some((r) => familyOfBackendId(r.id) === fam)) continue;
      // Named by the channel that is installed (the main one first): a Mac with only Chrome Beta lists "Google Chrome Beta".
      const channel = info.bundleIds.find((b) => installed.has(b));
      if (channel === undefined) continue;
      const name = browserForBundleId(channel)?.name ?? info.name;
      rows.set(fam, { id: fam, name, isDefault: false, connected: false, reason: `Winter for Chrome is not installed in ${name} — ask the user` });
    }
    const order = ["winter", "chrome", "edge", "brave", "vivaldi", "opera", "arc", "chromium"];
    return [...rows.values()].sort((a, b) => order.indexOf(familyOfBackendId(a.id) ?? "") - order.indexOf(familyOfBackendId(b.id) ?? "") || a.id.localeCompare(b.id));
  }

  // ── transports ─────────────────────────────────────────────────────────────────────────────────

  private hookTransports(): void {
    if (this.stopped) return;
    const live = new Set<CdpTransport>();
    for (const { id, transport } of this.deps.registry.transports()) {
      live.add(transport);
      if (this.hooked.has(transport)) continue;
      const off = [
        transport.onEvent((e) => this.drivers.get(tabKeyOf(id, e.tabKey))?.onEvent(e)),
        transport.onTabGone((tabKey, reason) => this.tabGone(id, tabKey, reason)),
        transport.onStop((tabKey) => this.stopPressed(id, tabKey)),
        // The hand-off's Done / Stop waiting in the browser itself (Winter for Chrome's toolbar popup).
        ...(transport.onUserDone === undefined ? [] : [transport.onUserDone((tabKey, done) => {
          this.handoffAnswers.get(tabKeyOf(id, tabKey))?.(done, "browser", done ? "handoff_done" : undefined);
        })]),
        // A download the built-in browser refused while nothing was armed: the next state says so.
        ...(transport.onDownload === undefined ? [] : [transport.onDownload((tabKey, d) => {
          if (d.state === "refused") this.drivers.get(tabKeyOf(id, tabKey))?.noteUncaughtDownload(d.name);
        })]),
      ];
      this.hooked.set(transport, { backend: id, off });
      if (this.familyOf(id) !== "winter" && transport.connected) void this.reconcileOrphans(id, transport);
    }
    for (const [t, h] of this.hooked) {
      if (live.has(t)) continue;
      for (const off of h.off) off();
      this.hooked.delete(t);
    }
  }

  /**
   * A user's browser (re)connected: agent tabs it reports that this daemon run never opened belong to a run before a
   * restart. Those of sessions with no running turn close (the ruling; a `handoff` does not survive a restart, and a
   * kept tab is no longer an agent tab). Agent tabs this run knows are left to the turn-end rule.
   */
  private async reconcileOrphans(backend: BackendId, transport: CdpTransport): Promise<void> {
    let tabs: TransportTab[];
    try { tabs = await transport.listTabs(); } catch { return; }
    for (const t of tabs) {
      if (!t.agent || t.sessionId === undefined) continue;
      if (this.sessions.get(t.sessionId)?.agentTabs.has(tabKeyOf(backend, t.tabKey)) === true) continue;
      let running = false;
      try { running = this.deps.turnRunning?.(t.sessionId) === true; } catch { running = false; }
      if (!shouldCloseAgentTab({ event: "restart-orphan", family: this.familyOf(backend), kept: false, turnRunning: running })) {
        // Its session is mid-turn: the tab becomes that session's agent tab again, so this turn's end closes it.
        this.session(t.sessionId).agentTabs.set(tabKeyOf(backend, t.tabKey), { backend, tabKey: t.tabKey, kept: false, handoff: false });
        continue;
      }
      try { await transport.closeTab(t.tabKey); } catch (err) {
        this.deps.log?.(`computer-use: closing an orphaned agent tab ${backend}:${t.tabKey} failed (${err instanceof Error ? err.message : "error"})`);
      }
    }
  }

  /**
   * A tab went away. Only a real close or crash loses it — its bindings read why and it leaves the agent tabs.
   * `stopped` (the app parked its browser; the extension's debugger idled out) keeps everything: the next primitive
   * attaches again. The user cancelling control keeps the tab an agent tab (its turn end may still close it), but no
   * binding of it works until it is bound again.
   */
  private tabGone(backend: BackendId, tabKey: string, reason: string): void {
    const key = tabKeyOf(backend, tabKey);
    const d = this.drivers.get(key);
    // A tab handed to the user and closed (or crashed) while Winter waited: the wait is over.
    if (reason !== "stopped") this.handoffAnswers.get(key)?.(false, "tab-gone");
    if (reason === "stopped") { d?.onGone("stopped"); return; }
    d?.onGone(reason);
    // A "closed" may be a navigation that gave the tab a new key, said by the command's own answer just after: what it
    // tears down is kept a little while, so `rekey` can put it back.
    const agentTabs = new Map<string, AgentTab>();
    for (const [sid, s] of this.sessions) {
      const targetId = s.byTab.get(key);
      const b = targetId === undefined ? undefined : s.bindings.get(targetId);
      if (b !== undefined && b.lost === undefined) b.lost = reason;
      const a = s.agentTabs.get(key);
      if (a !== undefined) agentTabs.set(sid, a);
      if (reason === "closed" || reason === "crashed") s.agentTabs.delete(key);
    }
    if (reason === "closed" && d !== undefined) {
      const now = this.now();
      for (const [k, v] of this.recentlyClosed) if (now - v.at > RECENTLY_CLOSED_MS) this.recentlyClosed.delete(k);
      this.recentlyClosed.set(key, { at: now, reason, agentTabs });
    }
    this.drivers.delete(key);
  }

  /** Before taking a new hold: past the per-session or global cap, let go of the least recently used one (it stays
   *  open; its next use takes it again) and say so. Never one a primitive is using now, nor one another run holds. */
  private makeRoomForHold(scope: TabRunScope, driver: TabDriver): void {
    driver.lastUsed = this.now();
    if (driver.isAttached && driver.holders.has(scope.sessionId)) return;
    const held = [...this.drivers.values()].filter((d) => d !== driver && d.isAttached && d.holders.size > 0);
    const mine = held.filter((d) => d.holders.has(scope.sessionId));
    const free = (list: TabDriver[]): TabDriver[] => list.filter((d) => {
      if (d.busy > 0) return false;
      const run = scope.lockRun(`tab:${d.backend}:${d.tabKey}`);
      return run === undefined || run === scope.runId;
    });
    const lru = (list: TabDriver[]): TabDriver | undefined => free(list).reduce<TabDriver | undefined>((a, d) => (a === undefined || d.lastUsed < a.lastUsed ? d : a), undefined);
    const victim = mine.length >= HOLDS_PER_SESSION ? lru(mine) : held.length >= HOLDS_GLOBAL ? lru(held) : undefined;
    if (victim === undefined) return;
    const cap = mine.length >= HOLDS_PER_SESSION ? `${HOLDS_PER_SESSION} in this session` : `${HOLDS_GLOBAL} in all`;
    scope.builder.daemonLine(`let go of ${victim.backend}:${victim.tabKey} (the least recently used of more than ${cap} held tabs) — it stays open; using it again takes it back`);
    for (const sid of [...victim.holders]) void victim.release(sid);
  }

  private stopPressed(backend: BackendId, tabKey: string): void {
    const d = this.drivers.get(tabKeyOf(backend, tabKey));
    for (const sid of d?.holders ?? []) this.deps.stopScript?.(sid, "the user pressed Stop in the browser");
  }

  private driverFor(backend: BackendId, tabKey: string): TabDriver {
    const transport = this.deps.registry.get(backend);
    if (transport === undefined || !transport.connected) throw this.unavailable(backend);
    const key = tabKeyOf(backend, tabKey);
    let d = this.drivers.get(key);
    if (d === undefined) {
      const driver = new TabDriver(backend, tabKey, transport, this.browserName(backend), () => this.now());
      if (this.familyOf(backend) !== "winter") driver.onRekey = (newKey) => this.rekey(driver, newKey);
      d = driver;
      this.drivers.set(key, d);
    } else d.replaceTransport(transport);
    return d;
  }

  /**
   * The tab came back under a NEW key after a navigation (Winter for Chrome, PROTOCOL.md §5.3: a browser that gives a
   * discarded tab a new id). Everything keyed by the old key moves to the new one: the driver, each session's binding
   * (same target id) and its agent-tab mark — restored if the old key's "closed" already arrived. The handle's printed
   * id changes; its target id does not.
   */
  private rekey(driver: TabDriver, newKey: string): boolean {
    const backend = driver.backend;
    const oldKey = driver.tabKey;
    if (newKey === oldKey) return false;
    const oldK = tabKeyOf(backend, oldKey);
    const newK = tabKeyOf(backend, newKey);
    if (this.drivers.has(newK)) return false;
    const closed = this.recentlyClosed.get(oldK);
    this.recentlyClosed.delete(oldK);
    if (closed !== undefined) driver.revive();
    if (this.drivers.get(oldK) === driver) this.drivers.delete(oldK);
    this.drivers.set(newK, driver);
    driver.tabKey = newKey;
    for (const [sid, s] of this.sessions) {
      const targetId = s.byTab.get(oldK);
      if (targetId !== undefined) {
        s.byTab.delete(oldK);
        s.byTab.set(newK, targetId);
        const b = s.bindings.get(targetId);
        if (b !== undefined) {
          b.tabKey = newKey;
          if (closed !== undefined && b.lost === closed.reason) delete b.lost;
        }
      }
      const a = s.agentTabs.get(oldK) ?? closed?.agentTabs.get(sid);
      if (a !== undefined) {
        s.agentTabs.delete(oldK);
        a.tabKey = newKey;
        s.agentTabs.set(newK, a);
      }
    }
    this.deps.log?.(`computer-use: ${backend} tab ${oldKey} came back as ${newKey} after a navigation`);
    return true;
  }

  private unavailable(backend: BackendId): AutomationFailure {
    const row = this.listRows().find((r) => r.id === backend);
    const reason = row?.reason ?? (familyOfBackendId(backend) === "winter" ? "Winter isn't running" : "it is not connected");
    return new AutomationFailure("BrowserUnavailable", `${row?.name ?? backend} can't be reached: ${reason}`, true);
  }

  private familyOf(backend: BackendId): BrowserFamily {
    return this.deps.registry.info(backend)?.family ?? familyOfBackendId(backend) ?? "chromium";
  }

  private browserName(backend: BackendId): string {
    if (this.familyOf(backend) === "winter") return "Winter's browser";
    return this.deps.registry.info(backend)?.name ?? familyInfo(this.familyOf(backend))?.name ?? backend;
  }

  private bundleIdOf(backend: BackendId): string | undefined {
    const fam = this.familyOf(backend);
    if (fam === "winter") return undefined;
    return this.deps.registry.info(backend)?.bundleId ?? familyInfo(fam)?.bundleIds[0];
  }

  private appRef(backend: BackendId, bundleId: string): AppRef {
    return { bundleId, name: this.browserName(backend) };
  }

  private installedBundleIds(): Set<string> {
    const now = this.now();
    if (this.installedCache !== undefined && now - this.installedCache.at < 60_000) return this.installedCache.ids;
    const ids = new Set<string>();
    if (this.deps.installed !== undefined) {
      for (const fam of ["chrome", "edge", "brave", "vivaldi", "opera", "arc", "chromium"] as const) {
        for (const b of familyInfo(fam)!.bundleIds) {
          try { if (this.deps.installed(b)) ids.add(b); } catch { /* unknown: not listed */ }
        }
      }
    }
    this.installedCache = { at: now, ids };
    return ids;
  }

  // ── bindings ───────────────────────────────────────────────────────────────────────────────────

  private binding(sessionId: string, targetId: string): Binding {
    const b = this.sessions.get(sessionId)?.bindings.get(targetId);
    if (b === undefined) throw new AutomationFailure("TargetLost", "that tab is no longer bound (the runtime restarted) — bind it again with browsers.tab()");
    if (b.lost !== undefined) throw new AutomationFailure("TargetLost", lostSentence(b));
    return b;
  }

  /** The user's tab: one Winter did not open, or one it handed over with `keep()`. */
  private usersTab(sessionId: string, b: Binding): boolean {
    return b.kind === "user" || this.sessions.get(sessionId)?.agentTabs.get(tabKeyOf(b.backend, b.tabKey))?.kept === true;
  }

  private lostIfGone(sessionId: string, b: Binding, err: unknown): unknown {
    const d = this.drivers.get(tabKeyOf(b.backend, b.tabKey));
    if (d?.gone !== undefined && b.lost === undefined) {
      b.lost = d.gone;
      this.sessions.get(sessionId)?.agentTabs.delete(tabKeyOf(b.backend, b.tabKey));
    }
    return err;
  }

  private handle(b: Binding): TabHandle {
    return { kind: "tab", targetId: b.targetId, id: `${b.backend}:${b.tabKey}`, browser: b.backend };
  }

  /** Bind (or re-bind) a tab in this session: policy, the site floor, the lock, attach, and its state printed. */
  private async bind(scope: TabRunScope, backend: BackendId, tabKey: string, url: string, opened: boolean): Promise<TabHandle> {
    const s = this.session(scope.sessionId);
    const key = tabKeyOf(backend, tabKey);
    const kind: Binding["kind"] = s.agentTabs.has(key) ? "agent" : "user";
    const bundleId = this.bundleIdOf(backend);
    if (!opened && bundleId !== undefined) await scope.authorize(this.appRef(backend, bundleId), { kind: "bind" });
    scope.live();
    const driver = this.driverFor(backend, tabKey);
    if (!opened && url.length > 0 && url !== "about:blank") await ensureSiteAllowed(scope, this.approvals, this.deps.site ?? {}, url, this.browserName(backend), this.cwdOf(scope.sessionId));
    noteSiteOf(scope, url);
    let targetId = s.byTab.get(key);
    const existing = targetId === undefined ? undefined : s.bindings.get(targetId);
    const again = existing !== undefined && existing.lost === undefined;
    if (targetId === undefined) {
      targetId = `bt_${randomBytes(6).toString("hex")}`;
      s.byTab.set(key, targetId);
    }
    // A fresh binding prints the whole tab: "new page" means something only against a state the model saw.
    if (!again) driver.resetPageMark();
    const b: Binding = existing !== undefined && again ? existing : {
      targetId, backend, tabKey, kind, boundRun: scope.runId, ...(bundleId === undefined ? {} : { bundleId }),
    };
    if (!again) { b.kind = kind; b.boundRun = scope.runId; delete b.lost; }
    s.bindings.set(targetId, b);
    scope.noteBrowser(backend);
    await scope.lock(`tab:${backend}:${tabKey}`, `Tab ${backend}:${tabKey}`);
    scope.live();
    this.makeRoomForHold(scope, driver);
    driver.busy++;
    try { await driver.ensureAttached(scope.sessionId); } finally { driver.busy--; }
    scope.live();
    return { ...this.handle(b) };
  }

  // ── browsers.* ─────────────────────────────────────────────────────────────────────────────────

  private listCall(scope: TabRunScope, args: Record<string, unknown>): BrowserListRow[] {
    const rows = this.listRows();
    if (args.emit !== false) {
      scope.builder.text(rows.map((r) => `${r.id} — ${r.name}${r.isDefault ? " · default" : ""} · ${r.connected ? "connected" : `not connected: ${r.reason ?? "unavailable"}`}`).join("\n"));
    }
    return rows;
  }

  private backendFor(name: unknown): BackendId {
    if (name === undefined) return "winter";
    if (typeof name !== "string" || name.trim().length === 0) throw bad("{ browser } takes a browser id from browsers.list()");
    const id = name.trim().toLowerCase();
    const known = this.listRows();
    if (known.some((r) => r.id === id)) return id;
    throw bad(`no browser "${name.slice(0, 40)}" — browsers.list() shows: ${known.map((r) => r.id).join(", ")}`);
  }

  private cwdOf(sessionId: string): string | undefined {
    try { return this.deps.sessionInfo(sessionId).cwd ?? undefined; } catch { return undefined; }
  }

  private async open(scope: TabRunScope, args: Record<string, unknown>): Promise<TabHandle> {
    const url = checkTabUrl(args.url, "browsers.open()");
    const backend = this.backendFor(args.browser);
    const facts = scope.sessionFacts();
    if (facts.mode === "chat" || facts.policy === "chat") throw new AutomationFailure("NotAllowed", "computer use is not available in chat");
    const transport = this.deps.registry.get(backend);
    if (transport === undefined || !transport.connected) throw this.unavailable(backend);
    const bundleId = this.bundleIdOf(backend);
    const name = this.browserName(backend);
    if (bundleId !== undefined) {
      const app = this.appRef(backend, bundleId);
      await scope.authorize(app, { kind: "act", primitive: "browsers.open" });
      await scope.authorize(app, { kind: "bind" });
    } else if (facts.policy === "plan") {
      throw new AutomationFailure("NotAllowed", "this session is in plan mode — ComputerV2 can look but not open tabs");
    }
    scope.live();
    if (url !== "about:blank") await ensureSiteAllowed(scope, this.approvals, this.deps.site ?? {}, url, name, this.cwdOf(scope.sessionId));
    scope.noteBrowser(backend);
    noteSiteOf(scope, url);
    let title: string | undefined;
    try { title = this.deps.sessionInfo(scope.sessionId).title; } catch { title = undefined; }
    let tab: TransportTab;
    try {
      if (this.familyOf(backend) === "winter") {
        const tabKey = this.deps.mintWinterTab(scope.sessionId, url === "about:blank" ? undefined : url);
        tab = await transport.createTab({ sessionId: scope.sessionId, url, tabKey, ...(title === undefined ? {} : { sessionTitle: title }) });
      } else {
        tab = await transport.createTab({ sessionId: scope.sessionId, url, ...(title === undefined ? {} : { sessionTitle: title }) });
      }
    } catch (err) { throw transportFailure(err, name); }
    const s = this.session(scope.sessionId);
    s.agentTabs.set(tabKeyOf(backend, tab.tabKey), { backend, tabKey: tab.tabKey, kept: false, handoff: false });
    const handle = await this.bind(scope, backend, tab.tabKey, url, true);
    const driver = this.driverFor(backend, tab.tabKey);
    const loaded = await driver.waitOpened(url, scope.signal);
    scope.live();
    scope.builder.daemonLine(this.familyOf(backend) === "winter" ? "opened a new tab in Winter's browser" : `opened a new tab in ${name} (in the background)`);
    if (!loaded) scope.builder.daemonLine("still loading after 10 s");
    // Where the tab LANDED (a redirect) meets the dangerous-domain floor before anything of it is printed.
    await this.siteFloor(scope, this.binding(scope.sessionId, handle.targetId), driver);
    // The goto rule: the new page settles (frames still loading, late content) before its state is printed — the
    // ordinary state (viewport first, folded), never `full`, which is the model's to ask for.
    await this.printState(scope, handle.targetId, driver, { settle: true });
    return handle;
  }

  /** `yours`: an agent tab this session still owns — a kept one is the user's (it follows the user-tab rule). */
  private async tabRows(scope: TabRunScope, backend: BackendId): Promise<TabRow[]> {
    const s = this.session(scope.sessionId);
    if (this.familyOf(backend) === "winter") {
      const fold = this.deps.winterTabs(scope.sessionId);
      return fold.tabs.map((t) => ({
        id: `${backend}:${t.tabId}`, browser: backend, url: shownUrl(t.url ?? "about:blank"), title: t.title ?? "",
        active: t.tabId === fold.activeTabId, yours: s.agentTabs.get(tabKeyOf(backend, t.tabId))?.kept === false,
      }));
    }
    const transport = this.deps.registry.get(backend);
    if (transport === undefined || !transport.connected) throw this.unavailable(backend);
    // Listing a user's browser reads every tab's title and URL: it needs that browser's per-app consent, the same as
    // binding it (the card under the asking policies; only "Always allow" under dont-ask).
    const bundleId = this.bundleIdOf(backend);
    if (bundleId !== undefined) await scope.authorize(this.appRef(backend, bundleId), { kind: "bind" });
    let tabs: TransportTab[];
    try { tabs = await transport.listTabs(); } catch (err) { throw transportFailure(err, this.browserName(backend)); }
    return tabs.map((t) => ({
      id: `${backend}:${t.tabKey}`, browser: backend, url: t.url, title: t.title, active: t.active, yours: s.agentTabs.get(tabKeyOf(backend, t.tabKey))?.kept === false,
      ...(t.lastAccessed === undefined ? {} : { lastUsed: new Date(t.lastAccessed).toISOString() }), ...(t.group === undefined ? {} : { group: t.group }),
    }));
  }

  /**
   * The backends a call with no `{ browser }` reads: the built-in browser, and each connected user's browser this
   * session already allowed (no card is raised for one it did not); the rest are named in `leftOut`.
   */
  private defaultBackends(scope: TabRunScope): { ids: BackendId[]; leftOut: string[] } {
    const ids: BackendId[] = [];
    const leftOut: string[] = [];
    for (const r of this.listRows()) {
      if (familyOfBackendId(r.id) === "winter") { ids.push(r.id); continue; }
      if (!r.connected) continue;
      const bundleId = this.bundleIdOf(r.id);
      if (bundleId !== undefined && !scope.granted(bundleId)) { leftOut.push(`${r.name} (${r.id}) — not allowed in this session yet`); continue; }
      ids.push(r.id);
    }
    return { ids, leftOut };
  }

  private async tabs(scope: TabRunScope, args: Record<string, unknown>): Promise<unknown> {
    const chosen = args.browser === undefined ? this.defaultBackends(scope) : { ids: [this.backendFor(args.browser)], leftOut: [] as string[] };
    const leftOut = [...chosen.leftOut];
    const rows: TabRow[] = [];
    for (const b of chosen.ids) {
      // What the model reads: credentials in a URL, and token-looking text in a title, redacted.
      try { rows.push(...(await this.tabRows(scope, b)).map((r) => ({ ...r, url: redactUrl(r.url), title: redactText(r.title), ...(r.group === undefined ? {} : { group: redactText(r.group) }) }))); } catch (err) {
        if (args.browser !== undefined || !skippable(err)) throw err;
        leftOut.push(`${this.browserName(b)} (${b}) — ${err instanceof AutomationFailure && err.kind === "NotAllowed" ? "not allowed" : "can't be reached"}`);
      }
      scope.live();
    }
    if (leftOut.length > 0) {
      scope.builder.daemonLine(`${leftOut.length} browser${leftOut.length === 1 ? "" : "s"} left out: ${leftOut.join("; ")} — name one with { browser } to ask the user`);
    }
    scope.builder.markScreenRead();
    if (args.emit !== false) {
      scope.builder.text(rows.length === 0 ? "(no tabs)" : rows.map((r) => `${r.id} — ${JSON.stringify(r.title.slice(0, 120))} ${r.url.slice(0, 200)}${r.active ? " (active)" : ""}${r.yours ? " (yours)" : ""}${r.group === undefined ? "" : ` · group ${JSON.stringify(redactText(r.group).slice(0, 60))}`}`).join("\n"), { screen: true });
    }
    return rows;
  }

  private async bindCall(scope: TabRunScope, args: Record<string, unknown>): Promise<TabHandle> {
    const t = args.tab;
    let backend: BackendId;
    let tabKey: string;
    let url: string;
    if (typeof t === "string") {
      const i = t.indexOf(":");
      if (i <= 0 || i === t.length - 1) throw bad("browsers.tab() takes a tab id from browsers.tabs() (\"winter:…\", \"chrome:…\") or { url }");
      backend = this.backendFor(t.slice(0, i));
      tabKey = t.slice(i + 1);
      const rows = await this.tabRows(scope, backend);
      const hit = rows.find((r) => r.id === `${backend}:${tabKey}`);
      if (hit === undefined) {
        throw new AutomationFailure("TargetLost", this.familyOf(backend) === "winter"
          ? `no tab ${t.slice(0, 80)} in this session's tabs — browsers.tabs() lists them`
          : `no tab ${t.slice(0, 80)} is open — browsers.tabs() lists them`);
      }
      url = hit.url;
    } else if (t !== null && typeof t === "object" && (t as { active?: unknown }).active === true) {
      // The tab the user has in front in a user's browser (named, or the one allowed and connected).
      const chosen = args.browser === undefined ? this.defaultBackends(scope).ids.filter((id) => this.familyOf(id) !== "winter") : [this.backendFor(args.browser)];
      if (chosen.length === 0) throw bad("browsers.tab({ active: true }) needs a user's browser: name it with { browser } (browsers.list() shows them)");
      if (chosen.length > 1) throw bad(`several browsers are connected — name one with { browser }: ${chosen.join(", ")}`);
      backend = chosen[0]!;
      if (this.familyOf(backend) === "winter") throw bad("browsers.tab({ active: true }) is for a user's browser — bind a built-in tab by its id from browsers.tabs()");
      const rows = await this.tabRows(scope, backend);
      const front = rows.filter((r) => r.active).sort((a, b) => (b.lastUsed ?? "").localeCompare(a.lastUsed ?? ""))[0];
      if (front === undefined) throw new AutomationFailure("TargetLost", `no tab is in front in ${this.browserName(backend)}`);
      tabKey = front.id.slice(backend.length + 1);
      url = front.url;
    } else if (t !== null && typeof t === "object" && typeof (t as { url?: unknown }).url === "string") {
      const want = stripFragment((t as { url: string }).url.trim());
      const chosen = args.browser === undefined ? this.defaultBackends(scope) : { ids: [this.backendFor(args.browser)], leftOut: [] as string[] };
      const hits: Array<{ id: string; url: string; backend: string }> = [];
      let skipped = chosen.leftOut.length;
      for (const b of chosen.ids) {
        let rows;
        try { rows = await this.tabRows(scope, b); } catch (err) {
          if (args.browser !== undefined || !skippable(err)) throw err;
          skipped++;
          continue;
        }
        // The URL as the model read it (redacted) matches too.
        for (const r of rows) if (stripFragment(r.url) === want || stripFragment(redactUrl(r.url)) === want) hits.push({ id: r.id, url: r.url, backend: b });
      }
      if (hits.length === 0) {
        throw new AutomationFailure("TargetLost", `no open tab has that URL — browsers.tabs() lists them${skipped === 0 ? "" : ` (${skipped} browser${skipped === 1 ? " was" : "s were"} not searched: not allowed in this session yet — name one with { browser })`}`);
      }
      if (hits.length > 1) throw bad(`several tabs have that URL: ${hits.map((h) => h.id).join(", ")} — pass one id`);
      backend = hits[0]!.backend;
      tabKey = hits[0]!.id.slice(backend.length + 1);
      url = hits[0]!.url;
    } else {
      throw bad("browsers.tab() takes a tab id from browsers.tabs() or { url }");
    }
    const s = this.session(scope.sessionId);
    const known = s.byTab.get(tabKeyOf(backend, tabKey));
    const wasBound = known !== undefined && s.bindings.get(known)?.lost === undefined;
    const handle = await this.bind(scope, backend, tabKey, url, false);
    const driver = this.driverFor(backend, tabKey);
    const base = scope.diffBases.get(scope.sessionId, handle.targetId);
    if (wasBound && base !== undefined) {
      await this.siteFloor(scope, this.binding(scope.sessionId, handle.targetId), driver);
      await this.printState(scope, handle.targetId, driver, { since: base, quietOnDiff: true });
      return handle;
    }
    scope.builder.daemonLine(`bound ${backend}:${tabKey.slice(0, 60)} in ${this.browserName(backend)}`);
    await this.siteFloor(scope, this.binding(scope.sessionId, handle.targetId), driver);
    await this.printState(scope, handle.targetId, driver, {});
    return handle;
  }

  /** Print a tab's state (fenced) and make it the diff base. */
  private async printState(scope: TabRunScope, targetId: string, driver: TabDriver, o: { full?: boolean; since?: string; quietOnDiff?: boolean; settle?: boolean }): Promise<{ isDiff: boolean }> {
    const res = await driver.state({
      ...(o.full === true ? { full: true } : {}), ...(o.since === undefined ? {} : { since: o.since }),
      ...(o.settle === true ? { settle: { maxMs: Math.min(SETTLE_CAP_MS, scope.clampWait(SETTLE_CAP_MS)) } } : {}),
    });
    scope.live();
    if (res.isDiff && o.quietOnDiff === true) {
      scope.builder.daemonLine("this tab was already bound — the same handle; what changed since its last state follows (keep the handle in a top-level const: it lasts between calls)");
    }
    scope.builder.markScreenRead();
    scope.builder.text(res.text, { screen: true });
    scope.diffBases.set(scope.sessionId, targetId, res.snapshotId);
    return { isDiff: res.isDiff };
  }

  // ── the site floor ─────────────────────────────────────────────────────────────────────────────

  /** A tab sitting on a listed host that is not approved: the card (once per run), or `NotAllowed`. */
  private async siteFloor(scope: TabRunScope, b: Binding, driver: TabDriver): Promise<void> {
    const cwd = this.cwdOf(scope.sessionId);
    const url = driver.url;
    if (url.length === 0) return;
    const match = listedHost(url, this.deps.site ?? {}, cwd);
    if (match === null) return;
    const runKey = `${scope.sessionId}\u0000${scope.runId}`;
    const blocked = (): AutomationFailure => new AutomationFailure("NotAllowed",
      `this tab is on ${match.host}, which is on the dangerous-domains list and was not approved — only back(), close(), url() and title() work on it until it navigates away`);
    if (this.declined.get(runKey)?.has(match.host) === true) throw blocked();
    try {
      await ensureSiteAllowed(scope, this.approvals, this.deps.site ?? {}, url, this.browserName(b.backend), cwd);
    } catch (err) {
      if (err instanceof AutomationFailure && err.kind === "NotAllowed") {
        let set = this.declined.get(runKey);
        if (set === undefined) { set = new Set(); this.declined.set(runKey, set); }
        set.add(match.host);
        throw blocked();
      }
      throw err;
    }
  }

  // ── one tab primitive ──────────────────────────────────────────────────────────────────────────

  private requireVision(scope: TabRunScope): void {
    if (!scope.vision) throw new AutomationFailure("NotAllowed", NO_VISION);
  }

  /** Where a pointer act lands. `press`: the act presses a button there — refused on a native picker control (a
   *  <select>, a date/time/color or file input, a label for one), whose window would open on the user's screen.
   *  `menu`: a right-click — the browser's own context menu must not open either (the page's own may). */
  private async pointOf(scope: TabRunScope, b: Binding, driver: TabDriver, v: unknown, what: string, press = false, menu = false): Promise<{ x: number; y: number }> {
    if (isRef(v)) {
      const p = await driver.pointForRef(v, menu ? { guardMenu: true } : {});
      if (press && p.picker !== undefined) throw new AutomationFailure("Refused", pickerSentence(v, p.picker));
      return { x: p.x, y: p.y };
    }
    if (isPoint(v)) {
      this.requireVision(scope);
      const at = driver.pointForShot(scope.lastTargetShot.get(b.targetId), v[0], v[1]);
      if (press) {
        const picker = await driver.pickerAt(at.x, at.y, menu ? { guardMenu: true } : {});
        if (picker !== undefined) throw new AutomationFailure("Refused", pickerSentence(undefined, picker));
      }
      return at;
    }
    throw bad(`${what} takes an element ref${scope.vision ? " or a [x, y] point" : ""}`);
  }

  private settleFor(scope: TabRunScope, b: Binding, args: Record<string, unknown>): { maxMs: number } | undefined {
    return args.settle !== false && scope.acted.has(b.targetId) ? { maxMs: Math.min(SETTLE_CAP_MS, scope.clampWait(SETTLE_CAP_MS)) } : undefined;
  }

  private async run(scope: TabRunScope, b: Binding, driver: TabDriver, primitive: string, args: Record<string, unknown>): Promise<unknown> {
    const sid = scope.sessionId;
    // An open page dialog: answering it is the only act; reading the dialog itself still works.
    if (driver.dialog !== undefined && !OBSERVE_PRIMITIVES.has(primitive) && primitive !== "close" && primitive !== "keep" && primitive !== "answerDialog") {
      const ref = primitive === "click" || primitive === "setValue" ? (primitive === "click" ? args.target : args.ref) : undefined;
      if (!(isRef(ref) && driver.isDialogRef(ref))) throw new AutomationFailure("TargetBusy", driver.dialogBusySentence());
    }
    switch (primitive) {
      case "state": {
        const full = args.full === true;
        const within = isRef(args.within) ? args.within : undefined;
        const since = full || within !== undefined ? undefined : scope.diffBases.get(sid, b.targetId);
        const settle = this.settleFor(scope, b, args);
        const res = await driver.state({ ...(within === undefined ? {} : { within }), ...(full ? { full: true } : {}), ...(since === undefined ? {} : { since }), ...(settle === undefined ? {} : { settle }) });
        if (settle !== undefined) { scope.metric.settleMs = res.waitedMs; scope.metric.settleExit = res.settled === true ? "quiet" : "cap"; }
        scope.builder.markScreenRead();
        if (args.emit !== false) {
          scope.builder.text(res.text, { screen: true });
          if (within === undefined) scope.diffBases.set(sid, b.targetId, res.snapshotId);
        }
        return res.text;
      }
      case "find": {
        const q = args.query;
        let query: { text?: string; role?: string; name?: string };
        if (typeof q === "string" && q.length > 0) query = { text: q };
        else if (q !== null && typeof q === "object" && !Array.isArray(q)) {
          const o = q as Record<string, unknown>;
          query = Object.fromEntries(["role", "name", "text", "label", "placeholder", "testId", "css"].filter((k) => typeof o[k] === "string" && (o[k] as string).length > 0).map((k) => [k, o[k] as string]));
          if (Object.keys(query).length === 0) throw bad("find() takes text, or { role, name, text, label, placeholder, testId, css }");
          if (typeof o.css === "string") {
            // A tokenised safe subset only: a value test on an attribute would read hidden or secret values through the
            // match count (`page-runtime/rules.ts`, `cssSelectorRefusal`).
            const why = cssSelectorRefusal(o.css);
            if (why !== undefined) throw new AutomationFailure("NotAllowed", `find({ css }): ${why}`);
          }
          if (o.exact === true) (query as Record<string, unknown>).exact = true;
        } else throw bad("find() takes text, or { role, name, text, label, placeholder, testId, css }");
        const found = await driver.find(query);
        scope.builder.markScreenRead();
        if (args.emit !== false) {
          scope.builder.text(found.length === 0 ? "(nothing in this tab matches)" : found.map((e) => {
            const states = e.states !== undefined && e.states.length > 0 ? ` (${e.states.join(", ")})` : "";
            return `[${e.ref}] ${e.role}${e.name === undefined ? "" : ` "${e.name}"`}${e.value === undefined ? "" : e.value === "<redacted>" ? " value=<redacted>" : ` value="${e.value.slice(0, 200)}"`}${states}`;
          }).join("\n"), { screen: true });
        }
        return found;
      }
      case "screenshot": return await this.screenshot(scope, b, driver, args);
      case "click": {
        if (isRef(args.target) && driver.isDialogRef(args.target)) {
          await driver.answerDialog(args.target);
          scope.acted.add(b.targetId);
          return undefined;
        }
        const at = await this.pointOf(scope, b, driver, args.target, "click()", true, args.button === "right");
        scope.live();
        await driver.click(at, { button: args.button, count: args.count, modifiers: args.modifiers });
        scope.acted.add(b.targetId);
        return undefined;
      }
      case "setValue": {
        if (isRef(args.ref) && typeof args.value === "boolean") {
          // A check box, radio or switch: pressed as a person would, only when its state differs.
          const st = await driver.checkState(args.ref);
          if (!st.checkable) throw bad(`setValue(ref, true | false) is for a check box, radio or switch — [${args.ref}] is not one`);
          if (st.checked !== args.value) {
            const at = await this.pointOf(scope, b, driver, args.ref, "setValue()", true);
            scope.live();
            await driver.click(at, {});
          }
          scope.acted.add(b.targetId);
          return undefined;
        }
        if (!isRef(args.ref) || typeof args.value !== "string") throw bad("setValue() takes an element ref and a string (true or false for a check box)");
        if (driver.dialog !== undefined && args.ref === driver.dialog.promptRef) {
          driver.dialog.promptText = args.value;
          return undefined;
        }
        await driver.setValue(args.ref, args.value);
        scope.acted.add(b.targetId);
        return undefined;
      }
      case "type": {
        if (typeof args.text !== "string") throw bad("type() takes a string");
        const target = await driver.keyboardTarget(isRef(args.into) ? args.into : undefined);
        if (!target.editable) throw new AutomationFailure("Refused", FOCUS_NOT_EDITABLE);
        scope.live();
        await driver.typeText(args.text, scope.signal);
        scope.acted.add(b.targetId);
        let received = "unverifiable";
        if (target.ref !== undefined) {
          const now = await driver.readBack(target.ref);
          if (now !== null) received = now.includes(args.text) ? "verified" : "partly";
        }
        scope.builder.text(`sent ${characters(args.text)} to ${target.label ?? "the focused field"}; received: ${received}`, { screen: true });
        return undefined;
      }
      case "paste": {
        if (typeof args.text !== "string") throw bad("paste() takes a string");
        const format = args.format === "html" || args.format === "markdown" ? args.format : "text";
        const target = await driver.keyboardTarget(isRef(args.into) ? args.into : undefined);
        if (!target.editable) throw new AutomationFailure("Refused", FOCUS_NOT_EDITABLE);
        scope.live();
        let handled = false;
        if (format === "html") handled = await driver.pasteEvent(target.frame, args.text, args.text.replace(/<[^>]*>/g, ""));
        else if (format === "markdown") handled = await driver.pasteEvent(target.frame, undefined, args.text);
        if (!handled) await driver.insertText(args.text);
        scope.acted.add(b.targetId);
        scope.builder.text(`pasted into ${target.label ?? "the focused field"}${handled ? " (as the page's own paste)" : ""}`, { screen: true });
        return undefined;
      }
      case "key": {
        if (typeof args.combo !== "string" || args.combo.length === 0) throw bad("key() takes a combo such as \"cmd+s\"");
        const press = driver.parseKey(args.combo);
        const repeat = typeof args.repeat === "number" && Number.isInteger(args.repeat) && args.repeat > 0 ? Math.min(args.repeat, 100) : 1;
        const target = await driver.keyboardTarget(isRef(args.into) ? args.into : undefined);
        scope.live();
        await driver.press(press, repeat, scope.signal);
        scope.acted.add(b.targetId);
        if (target.label !== undefined) scope.builder.text(`pressed ${args.combo} in ${target.label}`, { screen: true });
        return undefined;
      }
      case "scroll": {
        const dir = args.direction;
        if (dir !== "up" && dir !== "down" && dir !== "left" && dir !== "right") throw bad("scroll() takes a direction: up, down, left or right");
        const pages = typeof args.pages === "number" && args.pages > 0 ? Math.min(args.pages, 20) : 1;
        const at = await this.pointOf(scope, b, driver, args.target, "scroll()");
        await driver.scroll(at, dir, pages);
        scope.acted.add(b.targetId);
        return undefined;
      }
      case "drag": {
        const from = await this.pointOf(scope, b, driver, args.from, "drag()", true);
        const to = await this.pointOf(scope, b, driver, args.to, "drag()", true);
        await driver.drag(from, to, scope.signal);
        scope.acted.add(b.targetId);
        return undefined;
      }
      case "select": {
        if (!isRef(args.ref) || typeof args.text !== "string") throw bad("select() takes an element ref and the text to select");
        const caret = args.caret === "start" || args.caret === "end" ? { caret: args.caret as "start" | "end" } : {};
        await driver.select(args.ref, args.text, { ...(typeof args.before === "string" ? { before: args.before } : {}), ...(typeof args.after === "string" ? { after: args.after } : {}), ...caret });
        scope.acted.add(b.targetId);
        return undefined;
      }
      case "hover": {
        const at = await this.pointOf(scope, b, driver, args.target, "hover()");
        const ms = typeof args.ms === "number" && Number.isFinite(args.ms) ? Math.max(0, Math.min(5_000, Math.round(args.ms))) : 600;
        await driver.hover(at, scope.clampWait(ms), scope.signal);
        scope.acted.add(b.targetId);
        return undefined;
      }
      case "waitFor": {
        const c = args.cond;
        if (c === null || typeof c !== "object" || Array.isArray(c)) throw bad("waitFor() takes { text, ref, gone, title, url }");
        const o = c as Record<string, unknown>;
        const cond: { text?: string; title?: string; url?: string; goneText?: string; refs?: number[]; goneRefs?: number[] } = {};
        if (typeof o.text === "string") cond.text = o.text;
        if (isRef(o.ref)) cond.refs = [o.ref];
        if (isRef(o.gone)) cond.goneRefs = [o.gone];
        else if (typeof o.gone === "string") cond.goneText = o.gone;
        if (typeof o.title === "string") cond.title = o.title;
        if (typeof o.url === "string") cond.url = o.url;
        if (o.load !== undefined) {
          if (o.load !== "domcontentloaded" && o.load !== "load") throw bad("waitFor()'s load is \"domcontentloaded\" or \"load\"");
          if (Object.keys(cond).length === 0) {
            const timeout = scope.clampWait(typeof args.timeoutMs === "number" ? args.timeoutMs : WAIT_FOR_DEFAULT_MS);
            return await driver.waitForLoad(o.load, timeout, scope.signal);
          }
          throw bad("waitFor({ load }) waits for the page's load alone — wait for the rest in a second waitFor()");
        }
        if (Object.keys(cond).length === 0) throw bad("waitFor() needs one of text, ref, gone, title, url or load");
        const timeout = scope.clampWait(typeof args.timeoutMs === "number" ? args.timeoutMs : WAIT_FOR_DEFAULT_MS);
        try {
          return await driver.waitFor(cond, timeout, scope.signal);
        } catch (err) {
          if (err instanceof AutomationFailure && err.kind === "WaitTimeout") scope.builder.markScreenRead();
          throw err;
        }
      }
      case "waitForIdle": {
        const quietMs = typeof args.quietMs === "number" ? Math.max(30, Math.floor(args.quietMs)) : 150;
        const timeout = scope.clampWait(typeof args.timeoutMs === "number" ? args.timeoutMs : 3_000);
        const res = await driver.waitForIdle(quietMs, timeout, scope.signal);
        scope.metric.settleMs = res.waitedMs;
        scope.metric.settleExit = res.settled ? "quiet" : "cap";
        return { settled: res.settled, waitedMs: res.waitedMs };
      }
      case "goto": {
        const url = checkTabUrl(args.url, "goto()");
        if (url !== "about:blank") await ensureSiteAllowed(scope, this.approvals, this.deps.site ?? {}, url, this.browserName(b.backend), this.cwdOf(sid));
        scope.live();
        noteSiteOf(scope, url);
        return await this.navigate(scope, b, driver, () => driver.goto(url, scope.signal, scope.sessionId));
      }
      case "back": return await this.navigate(scope, b, driver, () => driver.history(-1, scope.signal, scope.sessionId));
      case "forward": return await this.navigate(scope, b, driver, () => driver.history(1, scope.signal, scope.sessionId));
      case "reload": return await this.navigate(scope, b, driver, () => driver.reload(scope.signal, scope.sessionId));
      case "url": {
        // While a page dialog is open the page is paused: the engine's own tracked URL answers.
        if (driver.dialog === undefined) { try { await driver.quietInfo(); } catch { /* the last committed URL */ } }
        scope.builder.markScreenRead();
        return driver.shownUrl;
      }
      case "title": {
        if (driver.dialog === undefined) { try { await driver.quietInfo(); } catch { /* the last title read */ } }
        scope.builder.markScreenRead();
        return driver.shownTitle;
      }
      case "text": {
        if (args.within !== undefined && !isRef(args.within)) throw bad("text()'s within takes an element ref");
        const text = isRef(args.within) ? await driver.textWithin(args.within, args.markdown === true) : await driver.text(args.markdown === true);
        scope.builder.markScreenRead();
        if (args.emit !== false) scope.builder.text(text.length === 0 ? "(the page has no readable text)" : text, { screen: true });
        return text;
      }
      case "inspect": return await this.inspectCall(scope, b, driver, args);
      case "html": {
        if (args.within !== undefined && !isRef(args.within)) throw bad("html()'s within takes an element ref");
        const maxChars = typeof args.maxChars === "number" && Number.isFinite(args.maxChars) && args.maxChars > 0 ? Math.min(HTML_MAX_CHARS, Math.floor(args.maxChars)) : HTML_DEFAULT_CHARS;
        const r = await driver.html(isRef(args.within) ? args.within : undefined, maxChars);
        scope.builder.markScreenRead();
        const out = r.cut ? `${r.html}\n<!-- cut at ${maxChars} characters — html({ within: ref }) reads one part, { maxChars } up to ${HTML_MAX_CHARS} -->` : r.html;
        if (args.emit !== false) scope.builder.text(out, { screen: true });
        return out;
      }
      case "assets": {
        const kinds = args.kinds === undefined ? [...ASSET_KINDS] : stringList(args.kinds, "assets()'s kinds");
        const unknown = kinds.filter((k) => !(ASSET_KINDS as readonly string[]).includes(k));
        if (unknown.length > 0) throw bad(`assets()'s kinds are ${ASSET_KINDS.join(", ")} (not ${unknown.join(", ")})`);
        const max = typeof args.limit === "number" && args.limit > 0 ? Math.min(1_000, Math.floor(args.limit)) : 200;
        const list = await driver.assets(kinds, max);
        scope.builder.markScreenRead();
        if (args.emit !== false) scope.builder.text(list.length === 0 ? "(no assets of those kinds)" : list.map((a) => `${a.kind} ${a.url}`).join("\n"), { screen: true });
        return list;
      }
      case "dialog": {
        const d = driver.dialog;
        if (d === undefined) return null;
        scope.builder.markScreenRead();
        return { type: d.type, message: redactText(d.message), ...(d.type === "prompt" ? { defaultValue: redactText(d.promptText ?? "") } : {}) };
      }
      case "answerDialog": {
        const d = driver.dialog;
        if (d === undefined) throw new Error("no page dialog is open — dialog() says when one is");
        if (typeof args.accept !== "boolean") throw bad("answerDialog() takes true (OK) or false (Cancel), and a prompt's text");
        if (typeof args.text === "string" && d.type === "prompt") d.promptText = args.text;
        await driver.answerDialog(args.accept ? d.okRef : d.cancelRef ?? d.okRef);
        scope.acted.add(b.targetId);
        return undefined;
      }
      case "console": this.requireCdp3(driver, "console()"); return this.consoleCall(scope, driver, args);
      case "network": this.requireCdp3(driver, "network()"); return this.networkCall(scope, driver, args);
      case "networkBody": this.requireCdp3(driver, "networkBody()"); return await this.networkBodyCall(scope, driver, args);
      case "download": return await this.downloadCall(scope, b, driver, args);
      case "waitForUser": return await this.waitForUserCall(scope, b, driver, args);
      case "upload": {
        if (!isRef(args.ref)) throw bad("upload() takes a file input's ref and a path or an array of paths");
        const cwd = (() => { try { return this.deps.sessionInfo(sid).cwd; } catch { return undefined; } })();
        const roots = this.deps.uploadRoots?.(sid, cwd) ?? { denyRead: [] };
        const files = checkUploadFiles(args.paths, { cwd, home: this.deps.home, denyRead: roots.denyRead, ...(roots.tmpDir === undefined ? {} : { tmpDir: roots.tmpDir }) });
        // The browser is handed private COPIES (opened without following links, staged where the session's shell
        // cannot write): a path swapped after the checks can't change what is uploaded.
        const staged = stageUploads(files, this.deps.home, sid);
        await driver.upload(args.ref, staged);
        scope.acted.add(b.targetId);
        scope.builder.daemonLine(`uploaded ${staged.length} file${staged.length === 1 ? "" : "s"} into [${args.ref}]`);
        return undefined;
      }
      case "keep": {
        if (b.kind !== "agent") return undefined; // a tab the user already owns
        const a = this.session(sid).agentTabs.get(tabKeyOf(b.backend, b.tabKey));
        const group = typeof args.group === "string" && args.group.trim().length > 0 ? args.group.trim().slice(0, 80) : undefined;
        if (args.group !== undefined && group === undefined) throw bad("keep()'s group is a name");
        // The tab is the user's from now on: an emulated screen size goes first.
        await driver.setViewport(null).catch(() => undefined);
        if (this.familyOf(b.backend) !== "winter") {
          try { await driver.transport.keepTab(b.tabKey, group === undefined ? undefined : { group }); } catch (err) { throw transportFailure(err, this.browserName(b.backend)); }
          if (group !== undefined && !(driver.transport as { features?: ReadonlySet<string> }).features?.has("keepGroup")) {
            scope.builder.daemonLine("kept — but this Winter for Chrome is too old to put it in a group; the user can update it");
          }
        } else if (group !== undefined) {
          scope.builder.daemonLine("kept — Winter's built-in browser has no tab groups, so the group name was not used");
        }
        if (a !== undefined) { a.kept = true; a.handoff = false; }
        return undefined;
      }
      case "viewport": {
        this.requireOwnTab(sid, b, "viewport()");
        this.requireCdp3(driver, "viewport()");
        const size = args.size;
        if (size === null) { await driver.setViewport(null); scope.acted.add(b.targetId); return undefined; }
        if (size === null || typeof size !== "object" || Array.isArray(size)) throw bad("viewport() takes { width, height, mobile?, scale? } or null");
        const o = size as Record<string, unknown>;
        const w = o.width, h = o.height;
        if (typeof w !== "number" || typeof h !== "number" || !Number.isInteger(w) || !Number.isInteger(h) || w < 200 || w > 3840 || h < 200 || h > 2160) {
          throw bad("viewport()'s width is a whole number 200–3840 and its height 200–2160 (CSS px)");
        }
        const scale = o.scale === undefined ? undefined : o.scale;
        if (scale !== undefined && (typeof scale !== "number" || !Number.isFinite(scale) || scale < 1 || scale > 3)) throw bad("viewport()'s scale is 1–3");
        await driver.setViewport({ width: w, height: h, mobile: o.mobile === true, ...(scale === undefined ? {} : { scale: scale as number }) });
        scope.acted.add(b.targetId);
        scope.diffBases.clearTarget(sid, b.targetId);
        return undefined;
      }
      case "mute": {
        this.requireOwnTab(sid, b, "mute()");
        const on = args.on === undefined ? true : args.on;
        if (typeof on !== "boolean") throw bad("mute() takes true (the default) or false");
        const t = driver.transport;
        if (t.setMuted === undefined) {
          throw this.familyOf(b.backend) === "winter"
            ? new Error("Winter's built-in browser can't mute a tab yet — update Winter")
            : new AutomationFailure("BrowserUnavailable", `this Winter for Chrome is too old for mute() — ask the user to update Winter for Chrome`);
        }
        try { await t.setMuted(b.tabKey, on); } catch (err) { throw transportFailure(err, this.browserName(b.backend)); }
        return undefined;
      }
      case "handoff": {
        // Engine-side only: the tab stays the agent's and in Winter's group, and survives this turn's end.
        const a = this.session(sid).agentTabs.get(tabKeyOf(b.backend, b.tabKey));
        if (a !== undefined && !a.kept) a.handoff = true;
        return undefined;
      }
      case "close": {
        if (b.kind !== "agent") throw new AutomationFailure("NotAllowed", "that tab is the user's — Winter never closes a tab it did not open");
        if (this.session(sid).agentTabs.get(tabKeyOf(b.backend, b.tabKey))?.kept === true) {
          throw new AutomationFailure("NotAllowed", "that tab is the user's now — Winter never closes it");
        }
        driver.agentNavigating = true;
        try { await driver.transport.closeTab(b.tabKey); } catch (err) { throw transportFailure(err, this.browserName(b.backend)); }
        if (this.familyOf(b.backend) === "winter") {
          try { this.deps.winterTabClosed?.(sid, b.tabKey); } catch { /* the strip catches up from the app */ }
        }
        b.lost = "closed_by_you";
        const key = tabKeyOf(b.backend, b.tabKey);
        this.session(sid).agentTabs.delete(key);
        driver.onGone("closed");
        this.drivers.delete(key);
        scope.diffBases.clearTarget(sid, b.targetId);
        return undefined;
      }
      default:
        throw bad(`unknown primitive ${primitive}`);
    }
  }

  // ── Phase 3: the developer readers ─────────────────────────────────────────────────────────────

  private async inspectCall(scope: TabRunScope, b: Binding, driver: TabDriver, args: Record<string, unknown>): Promise<unknown> {
    let got: Awaited<ReturnType<TabDriver["inspect"]>> | undefined;
    if (isRef(args.target)) got = await driver.inspect(args.target);
    else if (isPoint(args.target)) {
      this.requireVision(scope);
      const at = driver.pointForShot(scope.lastTargetShot.get(b.targetId), args.target[0], args.target[1]);
      got = await driver.inspectAt(at.x, at.y);
      if (got === undefined) throw new Error("nothing is at that point");
    } else throw bad(`inspect() takes an element ref${scope.vision ? " or a [x, y] point" : ""}`);
    const i = got.info;
    const out = {
      ref: got.ref, tag: i.tag, role: i.role, ...(i.name === undefined ? {} : { name: i.name }), ...(i.text === undefined ? {} : { text: i.text }),
      ...(i.value === undefined ? {} : { value: i.value }), attributes: i.attributes, box: i.box, visible: i.visible, enabled: i.enabled,
      ...(i.states === undefined ? {} : { states: i.states }), ...(got.frame === undefined ? {} : { frame: got.frame }),
    };
    scope.builder.markScreenRead();
    if (args.emit !== false) {
      const attrs = Object.entries(i.attributes).map(([k, v]) => `${k}="${v}"`).join(" ");
      scope.builder.text([
        `[${got.ref}] <${i.tag}> ${i.role}${i.name === undefined ? "" : ` "${i.name}"`}${i.states === undefined ? "" : ` (${i.states.join(", ")})`}`,
        `box ${i.box.join(", ")} · ${i.visible ? "visible" : "not visible"} · ${i.enabled ? "enabled" : "disabled"}${got.frame === undefined ? "" : ` · in a frame of ${got.frame}`}`,
        ...(attrs.length === 0 ? [] : [`attributes: ${attrs}`]),
        ...(i.value === undefined ? [] : [`value: ${i.value}`]),
        ...(i.text === undefined ? [] : [`text: ${i.text}`]),
      ].join("\n"), { screen: true });
    }
    return out;
  }

  /** A Winter for Chrome built before Phase 3 has none of its CDP (its hello names no `cdp3`). */
  private requireCdp3(driver: TabDriver, what: string): void {
    if (!transportHasCdp3(driver.transport)) {
      throw new AutomationFailure("BrowserUnavailable", `the Winter for Chrome in ${driver.browserName} is too old for ${what} — ask the user to update it`);
    }
  }

  /** viewport()/mute(): only a tab Winter opened and still owns (never the user's page). */
  private requireOwnTab(sessionId: string, b: Binding, what: string): void {
    if (b.kind !== "agent" || this.session(sessionId).agentTabs.get(tabKeyOf(b.backend, b.tabKey))?.kept === true) {
      throw new AutomationFailure("NotAllowed", `${what} works on a tab you opened with browsers.open() and still own — this one is the user's`);
    }
  }

  /** The user's browser a `{ browser }`-less call means: the one connected and allowed in this session. */
  private oneUserBrowser(scope: TabRunScope, named: unknown, what: string): BackendId {
    if (named !== undefined) {
      const id = this.backendFor(named);
      if (this.familyOf(id) === "winter") throw new Error(`Winter's built-in browser has no ${what} — name a user's browser (browsers.list())`);
      return id;
    }
    const ids = this.defaultBackends(scope).ids.filter((id) => this.familyOf(id) !== "winter");
    if (ids.length === 1) return ids[0]!;
    throw bad(ids.length === 0 ? `name the user's browser with { browser } (browsers.list() shows them) — none is allowed in this session yet` : `several browsers are connected — name one with { browser }: ${ids.join(", ")}`);
  }

  private async windowsCall(scope: TabRunScope, args: Record<string, unknown>): Promise<unknown> {
    const ids = args.browser !== undefined ? [this.oneUserBrowser(scope, args.browser, "windows")] : this.defaultBackends(scope).ids.filter((id) => this.familyOf(id) !== "winter");
    const rows: Array<{ browser: string; id: number; focused: boolean; tabs: number }> = [];
    for (const id of ids) {
      const t = this.deps.registry.get(id);
      if (t === undefined || !t.connected) throw this.unavailable(id);
      if (t.listWindows === undefined) throw new AutomationFailure("BrowserUnavailable", `the Winter for Chrome in ${this.browserName(id)} is too old for browsers.windows() — ask the user to update it`);
      const bundleId = this.bundleIdOf(id);
      if (bundleId !== undefined) await scope.authorize(this.appRef(id, bundleId), { kind: "bind" });
      try { for (const w of await t.listWindows()) rows.push({ browser: id, ...w }); } catch (err) { throw transportFailure(err, this.browserName(id)); }
      scope.live();
    }
    if (args.emit !== false) scope.builder.text(rows.length === 0 ? "(no windows)" : rows.map((w) => `${w.browser} window ${w.id} — ${w.tabs} tab${w.tabs === 1 ? "" : "s"}${w.focused ? " (in front)" : ""}`).join("\n"));
    return rows;
  }

  /**
   * `browsers.history()` / `browsers.bookmarks()`: a read-only search of the user's browser, to find a page they mean.
   * `{ browser }`, else every connected user's browser this session already allowed (the others named in a line).
   * Checked as a BIND of the browser (its per-app card), and Winter for Chrome's optional permission (refused
   * `NotAllowed` until the user switches it on in the extension's menu). URLs and titles redacted; printed fenced.
   */
  private async libraryCall(scope: TabRunScope, args: Record<string, unknown>, what: "history" | "bookmarks"): Promise<unknown> {
    const label = `${what}()`;
    if (args.browser !== undefined && this.familyOf(this.backendFor(args.browser)) === "winter") {
      throw new Error("Winter's built-in browser keeps no history or bookmarks Winter can read");
    }
    const facts = scope.sessionFacts();
    if (facts.mode === "chat" || facts.policy === "chat") throw new AutomationFailure("NotAllowed", "computer use is not available in chat");
    const chosen = args.browser === undefined ? this.defaultBackends(scope) : { ids: [this.backendFor(args.browser)], leftOut: [] as string[] };
    const ids = chosen.ids.filter((id) => this.familyOf(id) !== "winter");
    if (ids.length === 0) {
      throw bad(`browsers.${label} searches a user's browser — name it with { browser } (browsers.list() shows them)${chosen.leftOut.length > 0 ? `; not allowed in this session yet: ${chosen.leftOut.join("; ")}` : ""}`);
    }
    const limit = args.limit === undefined ? 25 : args.limit;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 200) throw bad(`browsers.${label}'s limit is a whole number 1–200`);
    const query = args.query === undefined ? "" : args.query;
    if (typeof query !== "string") throw bad(`browsers.${label}'s query is text`);
    const when = (v: unknown, key: string): number | undefined => {
      if (v === undefined) return undefined;
      const ms = typeof v === "string" ? Date.parse(v) : Number.NaN;
      if (!Number.isFinite(ms)) throw bad(`browsers.history()'s ${key} is a date ("2026-10-01" or an ISO time)`);
      return ms;
    };
    const from = what === "history" ? when(args.from, "from") : undefined;
    const to = what === "history" ? when(args.to, "to") : undefined;
    const leftOut = [...chosen.leftOut];
    const rows: Array<{ browser: string; url: string; title: string; visited?: string; folder?: string }> = [];
    for (const id of ids) {
      const name = this.browserName(id);
      const t = this.deps.registry.get(id);
      if (t === undefined || !t.connected) {
        if (args.browser !== undefined) throw this.unavailable(id);
        leftOut.push(`${name} (${id}) — can't be reached`);
        continue;
      }
      const fn = what === "history" ? t.history : t.bookmarks;
      if (fn === undefined) {
        const e = new AutomationFailure("BrowserUnavailable", `the Winter for Chrome in ${name} is too old for ${label} — ask the user to update it`);
        if (args.browser !== undefined) throw e;
        leftOut.push(`${name} (${id}) — its Winter for Chrome is too old`);
        continue;
      }
      const bundleId = this.bundleIdOf(id);
      if (bundleId !== undefined) await scope.authorize(this.appRef(id, bundleId), { kind: "bind" });
      scope.live();
      scope.noteBrowser(id);
      try {
        if (what === "history") {
          const found = await t.history!({ text: query.slice(0, 500), maxResults: limit, startTime: from ?? this.now() - 90 * 24 * 3_600_000, ...(to === undefined ? {} : { endTime: to }) });
          for (const i of found) rows.push({ browser: id, url: redactUrl(i.url), title: redactText(i.title), visited: new Date(i.lastVisitTime).toISOString() });
        } else {
          const found = await t.bookmarks!({ ...(query.trim() === "" ? {} : { text: query.slice(0, 500) }), maxResults: limit });
          for (const i of found) rows.push({ browser: id, url: redactUrl(i.url), title: redactText(i.title), folder: redactText(i.folder) });
        }
      } catch (err) {
        if (err instanceof TransportError && err.code === "not_allowed") throw new AutomationFailure("NotAllowed", err.message);
        throw transportFailure(err, name);
      }
      scope.live();
    }
    const out = rows.slice(0, limit);
    if (leftOut.length > 0) scope.builder.daemonLine(`left out: ${leftOut.join("; ")}`);
    scope.builder.markScreenRead();
    if (args.emit !== false) {
      scope.builder.text(out.length === 0 ? `(nothing in the ${what === "history" ? "history" : "bookmarks"} matches)` : out.map((r) =>
        `${JSON.stringify(r.title.slice(0, 120))} ${r.url.slice(0, 200)}${r.visited === undefined ? "" : ` · ${r.visited}`}${r.folder === undefined || r.folder === "" ? "" : ` · ${JSON.stringify(r.folder.slice(0, 80))}`}${ids.length > 1 ? ` · ${r.browser}` : ""}`).join("\n"), { screen: true });
    }
    return out;
  }

  private async groupCall(scope: TabRunScope, args: Record<string, unknown>): Promise<undefined> {
    const id = this.oneUserBrowser(scope, args.browser, "tab groups");
    const t = this.deps.registry.get(id);
    if (t === undefined || !t.connected) throw this.unavailable(id);
    if (t.updateGroup === undefined) throw new AutomationFailure("BrowserUnavailable", `the Winter for Chrome in ${this.browserName(id)} is too old for browsers.group() — ask the user to update it`);
    const facts = scope.sessionFacts();
    if (facts.mode === "chat" || facts.policy === "chat") throw new AutomationFailure("NotAllowed", "computer use is not available in chat");
    const bundleId = this.bundleIdOf(id);
    if (bundleId !== undefined) await scope.authorize(this.appRef(id, bundleId), { kind: "act", primitive: "browsers.group" });
    const o: { sessionId: string; title?: string; color?: string; collapsed?: boolean } = { sessionId: scope.sessionId };
    if (args.title !== undefined) { if (typeof args.title !== "string" || args.title.trim().length === 0) throw bad("browsers.group()'s title is a name"); o.title = args.title.trim().slice(0, 60); }
    if (args.color !== undefined) {
      if (typeof args.color !== "string" || !GROUP_COLORS.includes(args.color)) throw bad(`browsers.group()'s color is one of ${GROUP_COLORS.join(", ")}`);
      o.color = args.color;
    }
    if (args.collapsed !== undefined) { if (typeof args.collapsed !== "boolean") throw bad("browsers.group()'s collapsed is true or false"); o.collapsed = args.collapsed; }
    if (o.title === undefined && o.color === undefined && o.collapsed === undefined) throw bad("browsers.group() takes a title, color or collapsed");
    try { await t.updateGroup(o); } catch (err) { throw transportFailure(err, this.browserName(id)); }
    return undefined;
  }

  private consoleCall(scope: TabRunScope, driver: TabDriver, args: Record<string, unknown>): unknown {
    const levels = args.levels === undefined ? undefined : stringList(args.levels, "console()'s levels");
    if (levels !== undefined) {
      const unknown = levels.filter((l) => !(CONSOLE_LEVELS as readonly string[]).includes(l === "warn" ? "warning" : l));
      if (unknown.length > 0) throw bad(`console()'s levels are ${CONSOLE_LEVELS.join(", ")} (not ${unknown.join(", ")})`);
    }
    const read = driver.devtools.console({
      ...(levels === undefined ? {} : { levels }), ...(typeof args.filter === "string" && args.filter.length > 0 ? { filter: args.filter } : {}),
      ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
    });
    if (args.clear === true) driver.devtools.clearConsole();
    scope.builder.markScreenRead();
    if (args.emit !== false) {
      const counts = Object.entries(read.counts).map(([l, n]) => `${n} ${l}${n === 1 ? "" : l === "debug" || l === "info" || l === "log" ? "" : "s"}`).join(", ");
      const head = `console of ${this.labelOf(driver)}: ${counts.length === 0 ? "nothing logged" : counts}${read.total > read.entries.length ? ` (showing the last ${read.entries.length} of ${read.total})` : ""}`;
      scope.builder.text([head, ...read.entries.map(consoleLine)].join("\n"), { screen: true });
    }
    return read.entries;
  }

  private networkCall(scope: TabRunScope, driver: TabDriver, args: Record<string, unknown>): unknown {
    const types = args.types === undefined ? undefined : stringList(args.types, "network()'s types");
    const read = driver.devtools.network({
      ...(types === undefined ? {} : { types }), ...(typeof args.filter === "string" && args.filter.length > 0 ? { filter: args.filter } : {}),
      ...(args.failed === true ? { failed: true } : {}), ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
    });
    if (args.clear === true) driver.devtools.clearNetwork();
    scope.builder.markScreenRead();
    if (args.emit !== false) {
      const head = `network of ${this.labelOf(driver)}: ${read.total === 0 ? "no requests seen (only those made while Winter worked in the tab)" : `${read.total} request${read.total === 1 ? "" : "s"}`}${read.total > read.entries.length ? ` (showing the last ${read.entries.length})` : ""}`;
      scope.builder.text([head, ...read.entries.map(requestLine)].join("\n"), { screen: true });
    }
    return read.entries;
  }

  // ── waitForUser() — the sign-in hand-off ──────────────────────────────────────────────────────

  /**
   * `waitForUser(reason, { timeoutMs })`: a page needs the user (a sign-in, a 2-step code, a CAPTCHA). Winter asks on a
   * card under every policy but `dont-ask` (which never asks: refused, and the model tells the user in its reply).
   * "Show me the tab" lets the tab go — nothing is read while the user types — and brings it forward: the built-in
   * browser shows the session's window with that tab; a user's browser activates the tab and focuses its window (the
   * one place Winter for Chrome does). A second card waits for "Done" (the browser's own toolbar offers it too). Done:
   * the tab is taken again and its whole state printed — `{ done: true }`. Declined, "Stop waiting" or no answer:
   * `{ done: false }`, the tab left with the user. The tab closed meanwhile is `TargetLost`.
   */
  private async waitForUserCall(scope: TabRunScope, b: Binding, driver: TabDriver, args: Record<string, unknown>): Promise<{ done: boolean }> {
    const sid = scope.sessionId;
    const reason = typeof args.reason === "string" ? cardReason(args.reason) : "";
    if (reason === "") throw bad("waitForUser() takes a reason — what the user needs to do there (\"sign in\", \"enter the code\")");
    const timeout = args.timeoutMs === undefined ? HANDOFF_DEFAULT_MS : args.timeoutMs;
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) throw bad("waitForUser()'s timeoutMs is a positive number of ms");
    const total = Math.min(timeout, HANDOFF_MAX_MS);
    let host = "this page";
    try { const h = new URL(driver.url).hostname; if (h.length > 0) host = h; } catch { /* not a URL with a host */ }
    if (scope.sessionPolicy() === "dont-ask") {
      throw new AutomationFailure("NotAllowed", `this session never asks — tell the user in your reply what they need to do on ${host}`);
    }
    if (scope.userCard === undefined) throw new Error("this Winter can't hand a tab to the user");
    const winter = this.familyOf(b.backend) === "winter";
    const name = this.browserName(b.backend);
    const transport = driver.transport;
    if (transport.present === undefined) {
      throw winter
        ? new Error("Winter's built-in browser can't show a tab to the user until Winter is updated")
        : new AutomationFailure("BrowserUnavailable", `the Winter for Chrome in ${name} is too old for waitForUser() — ask the user to update it`);
    }
    scope.noteHandoff?.();
    const t0 = this.now();
    const ask = await scope.userCard(`${name} — ${host}: ${reason}. Winter waits while you do it.`, HANDOFF_ASK_OPTIONS, total);
    scope.live();
    if (!ask.approved) {
      scope.builder.daemonLine(`the user did not take over (${ask.by === "timeout" ? "no answer" : "declined"})`);
      return { done: false };
    }
    if (ask.optionId !== "handoff_done") {
      // Hand the tab over: nothing of Winter's reads it while the user is there.
      const key = tabKeyOf(b.backend, b.tabKey);
      try {
        if (winter) {
          // Shown first (so the built-in browser keeps it live in the panel), then let go.
          await transport.present(b.tabKey, { sessionId: sid });
          await driver.release(sid);
        } else {
          await driver.release(sid);
          await transport.present(b.tabKey, { sessionId: sid });
        }
      } catch (err) { throw transportFailure(err, name); }
      scope.builder.daemonLine(winter ? `showed the tab to the user in Winter's window` : `brought the tab forward in ${name} for the user`);
      const left = Math.max(1_000, total - (this.now() - t0));
      let wait: { approved: boolean; optionId?: string; by?: string };
      try {
        wait = await scope.userCard(`Waiting for you on ${host} in ${name} — press Done when you have finished.`, HANDOFF_WAIT_OPTIONS, left,
          (answer) => { this.handoffAnswers.set(key, answer); });
      } finally {
        this.handoffAnswers.delete(key);
        // The browser's own waiting mark goes (Winter for Chrome's badge and pill).
        if (!winter) transport.overlay(b.tabKey, { active: false });
      }
      scope.live();
      if (wait.by === "tab-gone") throw new AutomationFailure("TargetLost", "the tab was closed while Winter waited for the user");
      if (!wait.approved) {
        scope.builder.daemonLine(`the user ${wait.by === "timeout" ? "did not finish in time" : "stopped the wait"} — the tab stays with them`);
        return { done: false };
      }
    }
    // Done: the tab is taken again — a fresh look (every earlier ref is stale).
    await driver.ensureAttached(sid);
    scope.live();
    scope.builder.daemonLine(`the user finished on ${host}`);
    await this.printState(scope, b.targetId, driver, { full: true, settle: true });
    return { done: true };
  }

  // ── download() ─────────────────────────────────────────────────────────────────────────────────

  /**
   * `download(ref | { url }, { to?, timeoutMs? })`: the file a link or button gives, saved into the session's temp
   * folder (or `to`) — never through the user's Downloads folder for an ordinary file. The routes:
   *  - a `data:` link: decoded here, no browser;
   *  - an http(s) link or media (or `{ url }`): the built-in browser downloads it in that tab (its cookies), a user's
   *    browser loads it in a temporary background tab of the session's group under Fetch interception;
   *  - a `blob:` link (a file the page makes itself) or a button: the tab is armed and the ref clicked — the built-in
   *    browser's own handler catches anything; a user's browser catches http(s) over Fetch, and a page-made file only
   *    through Winter for Chrome's optional downloads permission.
   */
  private async downloadCall(scope: TabRunScope, b: Binding, driver: TabDriver, args: Record<string, unknown>): Promise<{ path: string; name: string; bytes: number; mime: string }> {
    const sid = scope.sessionId;
    const cwd = this.cwdOf(sid);
    const r = this.deps.downloadRoots?.(sid, cwd);
    if (r === undefined) throw new Error("downloads are not available in this Winter");
    const roots: DownloadRoots = { cwd, tmpDir: r.tmpDir, home: this.deps.home, denyWrite: r.denyWrite };
    // A destination that can't be used fails before anything is fetched.
    planDownload(args.to, "download", roots);
    const runKey = `${sid}\u0000${scope.runId}`;
    const count = this.downloadsByRun.get(runKey) ?? 0;
    if (count >= DOWNLOADS_PER_RUN) throw new AutomationFailure("NotAllowed", `at most ${DOWNLOADS_PER_RUN} downloads per script — run another script for more`);
    const timeout = args.timeoutMs === undefined ? DOWNLOAD_START_DEFAULT_MS : args.timeoutMs;
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) throw bad("download()'s timeoutMs is a positive number of ms");
    const startMs = scope.clampWait(Math.min(timeout, DOWNLOAD_TOTAL_MAX_MS));
    const totalMs = scope.clampWait(DOWNLOAD_TOTAL_MAX_MS);
    const winter = this.familyOf(b.backend) === "winter";

    const t = args.target;
    let ref: number | undefined;
    let url: string | undefined;
    let linkName: string | undefined;
    if (isRef(t)) {
      ref = t;
      const link = await driver.linkOf(t);
      scope.live();
      if (link.kind !== "other") url = link.url;
      if (link.kind === "link" && link.download !== undefined && link.download !== "") linkName = link.download;
    } else if (t !== null && typeof t === "object" && !Array.isArray(t) && typeof (t as { url?: unknown }).url === "string") {
      url = (t as { url: string }).url.trim();
    } else {
      throw bad("download() takes an element ref or { url }");
    }
    this.downloadsByRun.set(runKey, count + 1);

    const staging = newStagingDir(this.deps.home, sid);
    let captured: CapturedFile;
    let fromBrowserFolder: { path: string; subdir: string; id?: string; transport: CdpTransport; armedAt: number } | undefined;
    if (url !== undefined && /^data:/i.test(url)) {
      const { bytes, mime } = decodeDataUrl(url, DOWNLOAD_MAX_BYTES);
      const stagedPath = join(staging, "file");
      writeFileSync(stagedPath, bytes, { mode: 0o600, flag: "wx" });
      captured = { stagedPath, bytes: bytes.length, mime, name: linkName ?? `download${extFor(mime)}` };
    } else if (url !== undefined && /^blob:/i.test(url)) {
      if (ref === undefined) throw new AutomationFailure("NotAllowed", "a blob: address only works inside its page — pass the link's ref instead");
      const out = await this.captureByClick(scope, b, driver, ref, { staging, startMs, totalMs, fetch: false });
      captured = out.file;
      fromBrowserFolder = out.browserFolder;
    } else if (url !== undefined) {
      const checked = checkTabUrl(url, "download()");
      if (checked === "about:blank") throw bad("download() needs the address of a file");
      await ensureSiteAllowed(scope, this.approvals, this.deps.site ?? {}, checked, this.browserName(b.backend), cwd);
      scope.live();
      noteSiteOf(scope, checked);
      captured = winter
        ? await this.captureNativeUrl(scope, b, driver, checked, { staging, startMs, totalMs })
        : await this.captureUrlRoute(scope, b, checked, { staging, startMs, totalMs });
    } else {
      const out = await this.captureByClick(scope, b, driver, ref!, { staging, startMs, totalMs, fetch: !winter });
      captured = out.file;
      fromBrowserFolder = out.browserFolder;
    }
    scope.live();

    // Into place: the name the server (or the browser) suggested, under the rules of `download-paths.ts`.
    const plan: DownloadPlan = planDownload(args.to, captured.name, roots);
    let source = captured.stagedPath;
    let afterPlaced: (() => void) | undefined;
    if (fromBrowserFolder !== undefined) ({ source, afterPlaced } = this.takeFromBrowserFolder(fromBrowserFolder, captured, staging, r.denyRead));
    else if (winter && captured.reportedPath !== undefined) this.requireInStaging(captured.reportedPath, staging);
    const placed = placeDownload(source, plan, { expectedBytes: captured.bytes, tmpDir: r.tmpDir });
    afterPlaced?.();
    if (fromBrowserFolder?.id !== undefined) void fromBrowserFolder.transport.releaseDownload?.(fromBrowserFolder.id).catch(() => undefined);
    scope.metric.download = { bytes: placed.bytes };
    scope.noteDownload?.();
    scope.builder.markScreenRead();
    scope.builder.text(`downloaded "${redactText(placed.name)}" (${bytesLabel(placed.bytes)}, ${captured.mime}) → ${placed.path}`, { screen: true });
    return { path: placed.path, name: placed.name, bytes: placed.bytes, mime: captured.mime };
  }

  /** Arm the tab, click the ref, take whichever capture catches first. */
  private async captureByClick(
    scope: TabRunScope, b: Binding, driver: TabDriver, ref: number,
    o: { staging: string; startMs: number; totalMs: number; fetch: boolean },
  ): Promise<{ file: CapturedFile; browserFolder?: { path: string; subdir: string; id?: string; transport: CdpTransport; armedAt: number } }> {
    const winter = this.familyOf(b.backend) === "winter";
    const name = this.browserName(b.backend);
    const transport = driver.transport;
    if (o.fetch) this.requireCdp3(driver, "download()");
    const fetch = o.fetch ? new FetchCapture(driver, { anyResponse: false, stagingDir: o.staging, maxBytes: DOWNLOAD_MAX_BYTES, now: () => this.now() }) : undefined;
    const subdir = winter ? "" : `Winter/${randomBytes(6).toString("hex")}`;
    let native: NativeCapture | undefined;
    if (transport.armDownloads !== undefined && transport.onDownload !== undefined) {
      native = new NativeCapture(transport, b.tabKey, { dir: winter ? o.staging : "", subdir, until: this.now() + o.totalMs, maxBytes: DOWNLOAD_MAX_BYTES, now: () => this.now() });
    } else if (winter) {
      throw new Error("Winter's built-in browser can't save downloads until Winter is updated");
    }
    let nativeRefusal: Error | undefined;
    const armedAt = this.now();
    try {
      if (fetch !== undefined) await fetch.arm();
      if (native !== undefined) {
        try { await native.arm(); } catch (err) {
          nativeRefusal = winter ? transportFailure(err, name) : nativeArmFailure(err, name);
          native = undefined;
          if (fetch === undefined) throw nativeRefusal;
        }
      } else if (fetch === undefined) {
        throw new AutomationFailure("NotAllowed", `this file is made by the page itself — to save it from ${name}, ask the user to allow downloads in Winter for Chrome's menu (its toolbar button)`);
      }
      const at = await this.pointOf(scope, b, driver, ref, "download()", true);
      scope.live();
      await driver.click(at, {});
      scope.acted.add(b.targetId);
      const captures = [fetch, native].filter((c): c is FetchCapture | NativeCapture => c !== undefined);
      const any = firstOf(captures);
      const file = await waitForCapture(any, {
        startMs: o.startMs, totalMs: o.totalMs, signal: scope.signal, now: () => this.now(),
        nothing: () => {
          const pageMade = fetch?.sighting.pageDownload;
          if (pageMade !== undefined) {
            const saved = `${name} saved "${redactText(pageMade)}" in its own Downloads folder`;
            if (nativeRefusal !== undefined) return `${nativeRefusal.message} (${saved})`;
            if (!winter && transport.armDownloads === undefined) {
              return `that file is made by the page itself — to save it from ${name}, ask the user to update Winter for Chrome and allow downloads in its menu (its toolbar button) (${saved})`;
            }
            return `the page started a download of "${redactText(pageMade)}" that Winter could not catch`;
          }
          if ((fetch?.sighting.pages ?? 0) > 0) return "the click opened a page instead of a download — read the page (state()) and download from its link";
          return `nothing started a download within ${Math.round(o.startMs / 1000)} s of the click`;
        },
      });
      if (file.nativeId !== undefined && !winter) return { file, browserFolder: { path: file.reportedPath ?? file.stagedPath, subdir, id: file.nativeId, transport, armedAt } };
      return { file };
    } finally {
      await fetch?.disarm();
      await native?.disarm();
    }
  }

  /** The built-in browser: arm the tab and have it download `url` itself (its cookies), with no navigation. */
  private async captureNativeUrl(scope: TabRunScope, b: Binding, driver: TabDriver, url: string, o: { staging: string; startMs: number; totalMs: number }): Promise<CapturedFile> {
    const transport = driver.transport;
    if (transport.armDownloads === undefined || transport.startDownload === undefined || transport.onDownload === undefined) {
      throw new Error("Winter's built-in browser can't save downloads until Winter is updated");
    }
    const native = new NativeCapture(transport, b.tabKey, { dir: o.staging, subdir: "", until: this.now() + o.totalMs, maxBytes: DOWNLOAD_MAX_BYTES, now: () => this.now() });
    try {
      try { await native.arm(); } catch (err) { throw transportFailure(err, this.browserName(b.backend)); }
      try { await transport.startDownload(b.tabKey, url); } catch (err) { throw transportFailure(err, this.browserName(b.backend)); }
      return await waitForCapture(native, {
        startMs: o.startMs, totalMs: o.totalMs, signal: scope.signal, now: () => this.now(),
        nothing: () => `the download of ${redactUrl(url).slice(0, 200)} did not start within ${Math.round(o.startMs / 1000)} s`,
      });
    } finally {
      await native.disarm();
    }
  }

  /**
   * A user's browser: the file at `url` loaded in a TEMPORARY background tab of the session's group, under Fetch
   * interception (any final 2xx is the file), then the tab closed. The bound tab itself is never navigated (a "leave
   * this page?" there could cost it its page).
   */
  private async captureUrlRoute(scope: TabRunScope, b: Binding, url: string, o: { staging: string; startMs: number; totalMs: number }): Promise<CapturedFile> {
    const sid = scope.sessionId;
    const name = this.browserName(b.backend);
    const transport = this.deps.registry.get(b.backend);
    if (transport === undefined || !transport.connected) throw this.unavailable(b.backend);
    if (!transportHasCdp3(transport)) throw new AutomationFailure("BrowserUnavailable", `the Winter for Chrome in ${name} is too old for download() — ask the user to update it`);
    let title: string | undefined;
    try { title = this.deps.sessionInfo(sid).title; } catch { title = undefined; }
    let tab: TransportTab;
    try { tab = await transport.createTab({ sessionId: sid, url: "about:blank", ...(title === undefined ? {} : { sessionTitle: title }) }); } catch (err) { throw transportFailure(err, name); }
    const s = this.session(sid);
    const key = tabKeyOf(b.backend, tab.tabKey);
    const agent: AgentTab = { backend: b.backend, tabKey: tab.tabKey, kept: false, handoff: false };
    s.agentTabs.set(key, agent);
    const temp = this.driverFor(b.backend, tab.tabKey);
    let fetch: FetchCapture | undefined;
    try {
      await temp.ensureAttached(sid);
      scope.live();
      fetch = new FetchCapture(temp, { anyResponse: true, stagingDir: o.staging, maxBytes: DOWNLOAD_MAX_BYTES, now: () => this.now() });
      await fetch.arm();
      const f = fetch;
      void temp.send<{ errorText?: unknown }>("Page.navigate", { url }).then((res) => {
        if (typeof res.errorText === "string" && res.errorText.length > 0) f.fail(new Error(`${name} could not load ${redactUrl(url).slice(0, 200)} (${res.errorText})`));
      }, (err: unknown) => f.fail(err instanceof Error ? err : new Error(String(err))));
      return await waitForCapture(fetch, {
        startMs: o.startMs, totalMs: o.totalMs, signal: scope.signal, now: () => this.now(),
        nothing: () => `${redactUrl(url).slice(0, 200)} did not answer within ${Math.round(o.startMs / 1000)} s`,
      });
    } finally {
      await fetch?.disarm();
      if (s.agentTabs.get(key) === agent) this.closeAgentTab(sid, s, key, agent, "closed");
    }
  }

  /** The built-in browser saved into the staging directory: the file it reported must be there. */
  private requireInStaging(path: string, staging: string): void {
    let realPath: string | undefined;
    try { realPath = realpathSync(path); } catch { realPath = undefined; }
    const root = realpathSync(staging);
    if (realPath === undefined || !realPath.startsWith(`${root}/`)) throw new Error("the browser saved the download somewhere Winter did not expect — nothing was saved");
  }

  /**
   * The extension's downloads route: the browser saved the file in its own downloads folder, under `Winter/<random>/`
   * (or wherever the user chose in its save dialog). It is accepted only as a regular file of the reported size, not
   * a link, outside Winter's home and the sandbox's read-deny list. Under our subfolder it is MOVED (and the subfolder
   * removed); elsewhere — the user's choice — it is copied and theirs left alone.
   */
  private takeFromBrowserFolder(f: { path: string; subdir: string; armedAt: number }, captured: CapturedFile, staging: string, denyRead: readonly string[]): { source: string; afterPlaced?: () => void } {
    const path = f.path;
    let st;
    try { st = lstatSync(path); } catch { throw new Error("the browser's downloaded file is gone"); }
    if (st.isSymbolicLink() || !st.isFile()) throw new Error("the browser's downloaded file is not a regular file — nothing was saved");
    if (st.size !== captured.bytes) throw new Error(`the browser's downloaded file is not the size it reported (${st.size} of ${captured.bytes} bytes)`);
    // Written by this download: modified after the arm (a little slack for the file system's clock).
    if (st.mtimeMs + 2_000 < f.armedAt) throw new Error("the browser reported a file older than the download — nothing was saved");
    const home = [this.deps.home, (() => { try { return realpathSync(this.deps.home); } catch { return this.deps.home; } })()];
    const realPath = realpathSync(path);
    const under = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);
    if (home.some((h) => under(realPath, h)) || denyRead.some((d) => under(realPath, d))) throw new Error("the browser saved the download somewhere Winter may not read — nothing was saved");
    const ours = dirname(realPath).endsWith(`/${f.subdir}`);
    if (ours) {
      // A move: placeDownload removes it once copied; the subfolder (and `Winter/` when empty) goes after.
      return {
        source: realPath,
        afterPlaced: () => {
          try { rmdirSync(dirname(realPath)); } catch { /* not empty, or gone */ }
          try { rmdirSync(dirname(dirname(realPath))); } catch { /* the user's other Winter downloads, or gone */ }
        },
      };
    }
    const copy = join(staging, "file");
    copyFileSync(realPath, copy, constants.COPYFILE_EXCL);
    return { source: copy };
  }

  private async networkBodyCall(scope: TabRunScope, driver: TabDriver, args: Record<string, unknown>): Promise<string> {
    if (typeof args.id !== "string" || args.id.length === 0) throw bad("networkBody() takes a request's id from network() (\"r12\")");
    const req = driver.devtools.request(args.id);
    if (req === undefined) throw new Error(`no request ${args.id.slice(0, 20)} in this tab's network log — network() lists them`);
    if (!req.done) throw new Error(`${req.id} has not finished loading — wait for it (waitForIdle()) and read it again`);
    if (req.failed !== undefined) throw new Error(`${req.id} failed (${req.failed}) — it has no body`);
    const maxChars = typeof args.maxChars === "number" && Number.isFinite(args.maxChars) && args.maxChars > 0 ? Math.min(BODY_MAX_CHARS, Math.floor(args.maxChars)) : BODY_DEFAULT_CHARS;
    let body: { body: string; base64Encoded: boolean; truncated: boolean };
    try {
      body = await driver.responseBody(req.session, req.requestId);
    } catch (err) {
      if (err instanceof AutomationFailure) throw err;
      throw new Error(`the browser no longer keeps that response's body (it was larger than 1 MB, the page moved on, or the tab was let go) — reload and read it sooner`);
    }
    scope.live();
    scope.builder.markScreenRead();
    let out: string;
    if (!isTextMime(req.mime) && (body.base64Encoded || req.mime !== undefined)) {
      const bytes = body.base64Encoded ? Math.floor((body.body.length * 3) / 4) : body.body.length;
      out = `(binary, ${bytesLabel(bytes)}${req.mime === undefined ? "" : `, ${req.mime}`}) — save it with download({ url })`;
    } else {
      const raw = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
      const r = redactBody(raw, req.mime, maxChars);
      out = r.text + (r.cut || body.truncated ? `\n… (cut — ${body.truncated ? "the browser hands over at most 1 MB" : `pass { maxChars } up to ${BODY_MAX_CHARS}`})` : "");
    }
    if (args.emit !== false) scope.builder.text(out, { screen: true });
    return out;
  }

  private labelOf(driver: TabDriver): string {
    const t = driver.shownTitle.replace(/\s+/g, " ").trim();
    return t.length > 0 ? `Tab "${t.slice(0, 60)}"` : `Tab ${driver.backend}:${driver.tabKey}`;
  }

  private async navigate(scope: TabRunScope, b: Binding, driver: TabDriver, go: () => Promise<boolean>): Promise<undefined> {
    driver.agentNavigating = b.kind === "agent";
    let loaded: boolean;
    try { loaded = await go(); } finally { driver.agentNavigating = false; }
    scope.live();
    scope.acted.add(b.targetId);
    scope.diffBases.clearTarget(scope.sessionId, b.targetId);
    if (!loaded) scope.builder.daemonLine("still loading after 10 s");
    return undefined;
  }

  private async screenshot(scope: TabRunScope, b: Binding, driver: TabDriver, args: Record<string, unknown>): Promise<unknown> {
    this.requireVision(scope);
    const r = args.region;
    let region = Array.isArray(r) && r.length === 4 && r.every((n) => typeof n === "number" && Number.isFinite(n))
      ? { x: r[0] as number, y: r[1] as number, width: r[2] as number, height: r[3] as number } : undefined;
    const fullPage = args.fullPage === true;
    if (args.within !== undefined) {
      if (!isRef(args.within)) throw bad("screenshot()'s within takes an element ref");
      if (fullPage) throw bad("screenshot() takes within or fullPage, not both");
      region = await driver.rectForRef(args.within);
      scope.live();
    }
    const settle = this.settleFor(scope, b, args);
    if (settle !== undefined) {
      const w = await driver.waitForIdle(150, settle.maxMs, scope.signal);
      scope.metric.settleMs = w.waitedMs;
      scope.metric.settleExit = w.settled ? "quiet" : "cap";
    }
    let maxDim: number | undefined;
    try { maxDim = this.deps.screenshotMaxDim?.(); } catch { maxDim = undefined; }
    let quality: number = SCREENSHOT_QUALITY;
    let shot: Awaited<ReturnType<TabDriver["screenshot"]>>;
    for (;;) {
      shot = await driver.screenshot(screenshotBudgetFor(scope.model, maxDim, quality), fullPage ? undefined : region, quality, { fullPage });
      const bytes = Math.floor((shot.imageBase64.length * 3) / 4);
      const next = nextScreenshotQuality(quality);
      if (bytes <= SCREENSHOT_BYTE_CAP || next === undefined) { scope.metric.imageBytes = bytes; break; }
      quality = next;
    }
    scope.live();
    scope.lastTargetShot.set(b.targetId, shot.shotId);
    const handle = scope.keepImage({ imageBase64: shot.imageBase64, mime: "image/jpeg", width: shot.width, height: shot.height });
    if (args.emit !== false) {
      scope.builder.daemonLine(fullPage
        ? `the whole page, ${shot.width}×${shot.height} (${Math.round(shot.css.width)}×${Math.round(shot.css.height)} CSS px) — for looking; clicks take an ordinary screenshot's coordinates`
        : `clicks take this image's pixel coordinates: ${shot.width}×${shot.height} (viewport ${Math.round(shot.css.width)}×${Math.round(shot.css.height)} CSS px)`);
      scope.builder.image(shot.imageBase64, "image/jpeg");
    } else {
      scope.builder.markScreenRead();
    }
    return handle;
  }
}

/** The audit's site: a URL's host only (never its path or query). */
/** A file extension for a decoded `data:` file's type (the common ones; else none). */
function extFor(mime: string): string {
  const map: Record<string, string> = {
    "text/plain": ".txt", "text/csv": ".csv", "text/html": ".html", "application/json": ".json", "application/pdf": ".pdf",
    "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/svg+xml": ".svg", "application/zip": ".zip",
  };
  return map[mime] ?? "";
}

/** The first capture to catch a file wins; the wait fails only when every capture failed (with the first's error). Its
 *  progress is that of the capture(s) that STARTED — one still waiting never makes a running one look stalled. */
function firstOf(captures: Array<FetchCapture | NativeCapture>): { file: Promise<CapturedFile>; readonly started: boolean; fail(e: Error): void; progressAt(): number } {
  const file = new Promise<CapturedFile>((resolve, reject) => {
    let failed = 0;
    let first: unknown;
    for (const c of captures) {
      c.file.then(resolve, (err: unknown) => {
        failed++;
        first ??= err;
        if (failed === captures.length) reject(first);
      });
    }
  });
  file.catch(() => undefined);
  return {
    file,
    get started() { return captures.some((c) => c.started); },
    fail: (e) => { for (const c of captures) c.fail(e); },
    progressAt: () => Math.max(0, ...captures.filter((c) => c.started).map((c) => c.progressAt())),
  };
}

function noteSiteOf(scope: TabRunScope, url: string): void {
  try {
    const host = new URL(url).hostname;
    if (host.length > 0) scope.noteSite(host);
  } catch { /* not a URL with a host */ }
}

/** With no `{ browser }` named, a browser that can't be reached or that the user does not allow is skipped. */
function skippable(err: unknown): boolean {
  return err instanceof AutomationFailure && (err.kind === "BrowserUnavailable" || err.kind === "NotAllowed");
}

/** A list of strings (or one string) from the model. */
function stringList(v: unknown, what: string): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  throw bad(`${what} take a list of strings`);
}

function stripFragment(url: string): string {
  const i = url.indexOf("#");
  return i < 0 ? url : url.slice(0, i);
}

function lostSentence(b: Binding): string {
  switch (b.lost) {
    case "turn_end": return "that tab is the user's and was released at the end of the turn — bind it again with browsers.tab()";
    case "once": return `${b.backend} was allowed for one call only — bind the tab again with browsers.tab()`;
    case "closed_by_you": return "you closed that tab — open another with browsers.open()";
    case "closed_turn_end": return "Winter closed that tab when your turn ended (it was not marked with keep() or handoff()) — open a new one with browsers.open()";
    case "closed_session_end": return "Winter closed that tab when the session ended — open a new one with browsers.open()";
    case "crashed": return "the tab crashed — open it again with browsers.open()";
    case "detached_by_user": return "the user stopped Winter from controlling this tab — ask them before binding it again";
    case "stopped": return "the tab's browser was stopped — open a new tab with browsers.open()";
    default: return "the tab was closed — open a new one with browsers.open() or bind another with browsers.tab()";
  }
}

