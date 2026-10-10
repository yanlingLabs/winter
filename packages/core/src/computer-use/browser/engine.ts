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
import { nextScreenshotQuality, screenshotBudgetFor, SCREENSHOT_BYTE_CAP, SCREENSHOT_QUALITY } from "../budget";
import { AutomationFailure } from "../errors";
import type { AppRef } from "../policy";
import type { TabHandle } from "../worker/bridge";
import { familyInfo, familyOfBackendId } from "./families";
import { shouldCloseAgentTab } from "./lifecycle";
import type { BrowserBackendRegistry } from "./registry";
import { BLOCKED_TAB_PRIMITIVES, ensureSiteAllowed, listedHost, SiteApprovals, type SiteFloorDeps } from "./site-policy";
import type { TabRunScope } from "./tab-scope";
import { redactText, redactUrl } from "./page-runtime/redact";
import { pickerSentence, shownUrl, TabDriver, transportFailure } from "./tab-driver";
import type { BackendId, BrowserFamily, CdpTransport, TransportTab } from "./transport";
import { checkUploadFiles, clearStagedUploads, stageUploads } from "./upload-paths";

/** `state()`/`screenshot()` settle for at most this long after an act in the same call (Phase 1's cap). */
const SETTLE_CAP_MS = 1_500;
const WAIT_FOR_DEFAULT_MS = 10_000;
const NO_VISION = "this model can't see images — use state()";
const FOCUS_NOT_EDITABLE = "the focus is not a text field, so nothing was typed — click the field or pass { into }";

/** What a tab primitive is, for the per-app policy (everything not here acts). */
const OBSERVE_PRIMITIVES: ReadonlySet<string> = new Set(["state", "find", "screenshot", "waitFor", "waitForIdle", "url", "title", "text"]);

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
  private installedCache?: { at: number; ids: Set<string> };
  private unwatch?: () => void;
  private stopped = false;

  constructor(private readonly deps: BrowserEngineDeps) {
    // Files an earlier daemon run staged for uploads go (the daemon is starting: no session can be using them).
    clearStagedUploads(deps.home);
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
      if (!info.bundleIds.some((b) => installed.has(b))) continue;
      rows.set(fam, { id: fam, name: info.name, isDefault: false, connected: false, reason: `Winter for Chrome is not installed in ${info.name} — ask the user` });
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
    // The goto rule: the new page settles (frames still loading, late content) before its state is printed.
    await this.printState(scope, handle.targetId, driver, { full: true, settle: true });
    return handle;
  }

  private async tabRows(scope: TabRunScope, backend: BackendId): Promise<Array<{ id: string; browser: string; url: string; title: string; active: boolean; yours: boolean }>> {
    const s = this.session(scope.sessionId);
    if (this.familyOf(backend) === "winter") {
      const fold = this.deps.winterTabs(scope.sessionId);
      return fold.tabs.map((t) => ({
        id: `${backend}:${t.tabId}`, browser: backend, url: shownUrl(t.url ?? "about:blank"), title: t.title ?? "",
        active: t.tabId === fold.activeTabId, yours: s.agentTabs.has(tabKeyOf(backend, t.tabId)),
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
    return tabs.map((t) => ({ id: `${backend}:${t.tabKey}`, browser: backend, url: t.url, title: t.title, active: t.active, yours: s.agentTabs.has(tabKeyOf(backend, t.tabKey)) }));
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
    const rows: Array<{ id: string; browser: string; url: string; title: string; active: boolean; yours: boolean }> = [];
    for (const b of chosen.ids) {
      // What the model reads: credentials in a URL, and token-looking text in a title, redacted.
      try { rows.push(...(await this.tabRows(scope, b)).map((r) => ({ ...r, url: redactUrl(r.url), title: redactText(r.title) }))); } catch (err) {
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
      scope.builder.text(rows.length === 0 ? "(no tabs)" : rows.map((r) => `${r.id} — ${JSON.stringify(r.title.slice(0, 120))} ${r.url.slice(0, 200)}${r.active ? " (active)" : ""}${r.yours ? " (yours)" : ""}`).join("\n"), { screen: true });
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
    await this.printState(scope, handle.targetId, driver, { full: true });
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
    if (driver.dialog !== undefined && !OBSERVE_PRIMITIVES.has(primitive) && primitive !== "close" && primitive !== "keep") {
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
          query = Object.fromEntries(["role", "name", "text"].filter((k) => typeof o[k] === "string").map((k) => [k, o[k] as string]));
          if (Object.keys(query).length === 0) throw bad("find() takes text, or { role, name, text }");
        } else throw bad("find() takes text, or { role, name, text }");
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
        if (!isRef(args.ref) || typeof args.value !== "string") throw bad("setValue() takes an element ref and a string");
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
        if (Object.keys(cond).length === 0) throw bad("waitFor() needs one of text, ref, gone, title or url");
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
        const text = await driver.text(args.markdown === true);
        scope.builder.markScreenRead();
        if (args.emit !== false) scope.builder.text(text.length === 0 ? "(the page has no readable text)" : text, { screen: true });
        return text;
      }
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
        if (this.familyOf(b.backend) !== "winter") {
          try { await driver.transport.keepTab(b.tabKey); } catch (err) { throw transportFailure(err, this.browserName(b.backend)); }
        }
        if (a !== undefined) { a.kept = true; a.handoff = false; }
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
    const region = Array.isArray(r) && r.length === 4 && r.every((n) => typeof n === "number" && Number.isFinite(n))
      ? { x: r[0] as number, y: r[1] as number, width: r[2] as number, height: r[3] as number } : undefined;
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
      shot = await driver.screenshot(screenshotBudgetFor(scope.model, maxDim, quality), region, quality);
      const bytes = Math.floor((shot.imageBase64.length * 3) / 4);
      const next = nextScreenshotQuality(quality);
      if (bytes <= SCREENSHOT_BYTE_CAP || next === undefined) { scope.metric.imageBytes = bytes; break; }
      quality = next;
    }
    scope.live();
    scope.lastTargetShot.set(b.targetId, shot.shotId);
    const handle = scope.keepImage({ imageBase64: shot.imageBase64, mime: "image/jpeg", width: shot.width, height: shot.height });
    if (args.emit !== false) {
      scope.builder.daemonLine(`clicks take this image's pixel coordinates: ${shot.width}×${shot.height} (viewport ${Math.round(shot.css.width)}×${Math.round(shot.css.height)} CSS px)`);
      scope.builder.image(shot.imageBase64, "image/jpeg");
    } else {
      scope.builder.markScreenRead();
    }
    return handle;
  }
}

/** The audit's site: a URL's host only (never its path or query). */
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

