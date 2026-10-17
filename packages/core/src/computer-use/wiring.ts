// ComputerV2 (2026-10-08) — the daemon's computer-use runtime, assembled ONCE at boot: the helper connection,
// the policy, the service, the telemetry, the recently-used apps, the settings writes the cards and the app's
// RPCs make, and the control surface behind the four local-only `computerUse.*` RPCs (plus `setSettings`).
//
// SETTINGS ARE HOT, never a restart: every reader reads the daemon's live holder, and a write made here (an
// "Always allow" answer, `computerUse.apps.set`, `computerUse.setSettings`) is ALSO served from memory until the
// settings watcher swaps the holder (the `connector-source.ts` `noteWritten` pattern) — the very next call sees it.
import { PanelOpenTabParams, type NewSessionEvent, type SessionEvent } from "@yanlinglabs/winter-protocol";
import type { ApprovalBroker } from "../agent/approvals";
import { sessionTmpDir, sessionTmpDirPath } from "../agent/session-tmp";
import { mintPanelTab } from "../panel/open-tab";
import { foldPanelTabs } from "../panel/store";
import { sandboxConfigFor } from "../runtime-sdk/mode-options";
import type { WinterProfile } from "../profile";
import type { SessionHub } from "../sessions/hub";
import type { SessionStore } from "../sessions/store";
import { isHumanTurnOrigin } from "../sessions/turn-origins";
import { turnOriginIndexFor } from "../sessions/turn-origin-index";
import {
  computerUseAllowAllAppsFrom, computerUseAppsFrom, computerUseEnabledFrom, computerUseHeadlessEnabledFrom, computerUseLegacyComputerFrom,
  computerUseMirrorFrom, computerUsePrivateEventPathFrom, computerUseScreenshotMaxDimFrom, computerUseWakesFrom, computerUseWebMcpFrom, loadSettings, saveSettings,
  setComputerUseApp, setComputerUseFlags, type ComputerUseAccess, type ComputerUseFlagsPatch, type Settings,
} from "../settings";
import { AppAdapters, type AppAdapter } from "./adapters";
import { installedBrowser, systemAppResolver } from "./app-resolve";
import { BrowserLink, type HeadlessLinkActions } from "./browser/cef-link/rpc";
import { BrowserEngine } from "./browser/engine";
import { BrowserBackendRegistry } from "./browser/registry";
import { resolveWinterHeadless, winterAppRequirementFor } from "./browser/headless/engines";
import { HEADLESS_NAME, HeadlessPool, sweepHeadless, type HeadlessPoolDeps } from "./browser/headless/pool";
import { processSatisfiesRequirement } from "./helper-verify";
import { DiffBases } from "./diff-base";
import { HelperClient, type HelperLauncher, type HelperTransport, type HelperVerifier } from "./helper-client";
import { ISLAND_SHOWN_ACK_MS, type IslandPresence } from "../island/registry";
import { ComputerPolicy, DEFAULT_APP_EXCEPTIONS, defaultAppException, type DesktopVisitPanel } from "./policy";
import { HelperRpcError, HelperUnavailableError, type DesktopVisitPromptResult, type HelperPermissions } from "./protocol";
import { RecentApps } from "./recent-apps";
import { ComputerV2Service } from "./service";
import { AutomationTelemetry } from "./telemetry";
import type { AutomationWorker, AutomationWorkerOptions } from "./worker-host";
import type { MessagingDriverHandle } from "../agent/session-messaging";
import { BrowserWakeBackend } from "./browser/wake/backend";
import { AppWakeBackend } from "./wakes/app-backend";
import { WakeStore } from "./wakes/persist";
import { WakeRegistry, type WakeBackends } from "./wakes/registry";
import type { WakeSessionState } from "./wakes/delivery";

/** Test seams: a FAKE helper (transport, launcher, verifier), a scripted worker, the idle timeout. */
export interface ComputerUseInjection {
  transport?: HelperTransport;
  launcher?: HelperLauncher;
  verifier?: HelperVerifier;
  launchAllowed?: boolean;
  worker?: AutomationWorkerOptions;
  startWorker?: () => Promise<AutomationWorker>;
  idleMs?: number;
  /** The live suite's screenshot sink (`ComputerV2ServiceDeps.screenshotSink`) — never set in production. */
  screenshotSink?: (shot: { sessionId: string; primitive: string; mime: string; base64: string }) => void;
  /** More app adapters beside the built-in ones (the live suite's fixture adapter) — never set in production. */
  adapters?: readonly AppAdapter[];
  /** Phase 2: is a browser app installed (default: a LaunchServices lookup, never a launch)? */
  browserInstalled?: (bundleId: string) => boolean;
  /** Phase 4: the headless pool's engine seams (a fake helper on its pipe, no signature check) — tests only. */
  headless?: Partial<Pick<HeadlessPoolDeps, "resolve" | "spawn" | "verify" | "memoryOf" | "idleExitMs" | "enabledPollMs" | "timeouts" | "presentStartMs">>;
  /** Wake triggers (2026-10-12): FAKE backends in place of the real ones (the e2e drives a trigger through a real
   *  daemon), and the registry's timing seams. Never set in production. */
  wakeBackends?: WakeBackends;
  wakeTimings?: { coalesceMs?: number; pollMs?: number; retryDelaysMs?: readonly number[]; armTimeoutMs?: number };
}

export interface ComputerUseRuntimeDeps {
  home: string;
  profile: WinterProfile;
  /** The daemon's live settings holder. */
  settings(): Settings | null | undefined;
  settingsPath: string;
  approvals: ApprovalBroker;
  hub: SessionHub;
  store: SessionStore;
  audit?(line: Record<string, unknown>): void;
  /** Interrupt a session's running turn (`session.interrupt`'s door). */
  interrupt?(sessionId: string): void;
  /** Does the helper serve this daemon's home (the profile's default)? Only then may it be launched. */
  launchAllowed: boolean;
  /** Phase 2, the browsers' dangerous-domain floor: the user-added half of the list for a project, and the user's saved
   *  allow rules there (a standing `WebFetch(domain:…)` rule approves a listed host where a card could). */
  dangerousDomainsAdded?(cwd?: string): readonly string[] | undefined;
  savedAllowRules?(cwd?: string): readonly string[];
  /** Is the session running a main-thread turn now (a daemon restart's orphaned agent tabs stay open while it is)? */
  turnRunning?(sessionId: string): boolean;
  /** Wake triggers: the session driver table (late-bound — built after this runtime), the door a wake goes in by. */
  sessions?(): { get(sessionId: string): MessagingDriverHandle | undefined; ensure(sessionId: string): Promise<MessagingDriverHandle | undefined> } | undefined;
  /** Wake triggers, Dispatch: is a turn of this child followed now; follow its wake turn (`DispatchChildren`). */
  followedNow?(sessionId: string): boolean;
  followWake?(sessionId: string, text: string): (() => void) | undefined;
  /** The Winter island: whether an island client (Winter.app) is connected and shows the desktop-switch card — then
   *  the prompt is the app's and the helper's own panel is only the fallback (`islandAwareDesktopPanel`). */
  island?: IslandPresence;
  inject?: ComputerUseInjection;
  log?(line: string): void;
}

export interface ComputerUseStatus {
  enabled: boolean;
  allowAllApps: boolean;
  legacyComputer: boolean;
  mirror: boolean;
  privateEventPath: boolean;
  /** Phase 4: `computerUse.headless.enabled` (default true). */
  headlessEnabled: boolean;
  /** Phase 4: `computerUse.webmcp` (default true). */
  webmcp: boolean;
  /** Wake triggers (2026-10-12): `computerUse.wakes` (default true). */
  wakes: boolean;
  helper: { installed: boolean; running: boolean; version?: string; permissions?: HelperPermissions };
  /** Phase 2: the browsers ComputerV2 can drive (the built-in one, and every user's browser connected or installed). */
  browsers?: Array<{ id: string; name: string; connected: boolean; reason?: string }>;
}

/** One EXCEPTION to the master switch (`computerUse.apps.list`). `access: null` — the row is listed only for its
 *  "Always allow" grant; `isDefault` — the access is a built-in default exception the user has not changed. */
export interface ComputerUseAppRow {
  bundleId: string; name: string; access: ComputerUseAccess | null; grant: "always" | null; isDefault: boolean; lastUsedAt?: number;
}

/** A refusal the RPC layer turns into a typed JSON-RPC error. */
export class ComputerUseControlError extends Error {
  constructor(readonly code: "helper_unavailable" | "invalid_params" | "settings_write_refused", message: string) {
    super(message);
    this.name = "ComputerUseControlError";
  }
}

export interface ComputerUseControl {
  status(): Promise<ComputerUseStatus>;
  requestPermission(kind: "accessibility" | "screenRecording"): Promise<void>;
  appsList(): ComputerUseAppRow[];
  appsSet(p: { bundleId: string; name?: string; access?: ComputerUseAccess | null; grant?: "always" | null }): void;
  setSettings(p: ComputerUseFlagsPatch): void;
  /** Wake triggers: how many the session has armed (the session list's mark), and the Mac's [Stop waiting]. */
  wakesArmed?(sessionId: string): number;
  wakesCancel?(sessionId: string, wakeId: string): boolean;
  /** Every armed trigger across sessions (the Mac island's Watches tab). */
  wakesList?(): { sessionId: string; wakeId: string; condition: string; targetLabel: string; elementLabel?: string; armedAt: number; expiresAt: number }[];
}

export interface ComputerUseRuntime {
  service: ComputerV2Service;
  helper: HelperClient;
  policy: ComputerPolicy;
  control: ComputerUseControl;
  /** The settings every computer-use reader reads: the live holder, or a write made here it has not caught up with. */
  settings(): Settings | null | undefined;
  /** The hub observer: compaction (diff bases) and main-thread turn ends (the helper fades the mirrors). */
  observe(event: SessionEvent): void;
  /** Phase 2: the browser engine, the backends it can use, and Winter.app's browser link (`browserLink.*`). */
  browsers: BrowserEngine;
  backends: BrowserBackendRegistry;
  browserLink: BrowserLink;
  /** Phase 4: Winter's headless browser (the `headless` backend). */
  headless: HeadlessPool;
  /** Wake triggers (2026-10-12): the registry. `wakes.start()` runs the boot sweep once the session drivers exist;
   *  `wakes.beginShutdown()` stops deliveries before the drivers drain. */
  wakes: WakeRegistry;
  /** The session was archived: its wake triggers end `disabled` FIRST — before the browser engine closes its agent
   *  tabs, whose backend would otherwise report the closing tab as `lost` and wake the archived session — then the
   *  engine closes them. (A deletion takes the same order in `service.endSession`.) */
  sessionArchived(sessionId: string): void;
  stop(): void;
}

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

/**
 * THE DESKTOP SWITCH, refused (user ruling 2026-10-10, 5a): the session whose desktop-switch refusals an event lifts —
 * a HUMAN-origin `user_message` (never `messaging`, `dispatch` or `dispatch-wake`, nor the projector's own echo); the
 * policy then lifts that session's refusals and those of the dispatch children it coordinates.
 */
export function desktopRefusalLiftFor(event: SessionEvent): string | undefined {
  if (event.type !== "user_message") return undefined;
  const clientName = (event as { clientName?: string }).clientName;
  return isHumanTurnOrigin(clientName ?? "session") ? event.sessionId : undefined;
}

/**
 * The desktop-switch ruling (2026-10-10): the prompt's ON-SCREEN half — the helper's panel on the user's current
 * desktop (`prompt.desktopVisit`), with its own call id so closing it never cancels the script's other helper work.
 * Closing it (the session's card was answered first) is the helper's `cancel`. Any failure — an older helper, the
 * helper gone — reads as no answer: the card alone asks.
 */
export function helperDesktopPanel(helper: Pick<HelperClient, "request">, log: (line: string) => void): DesktopVisitPanel {
  return {
    show(p) {
      const abort = new AbortController();
      const answer = helper.request<DesktopVisitPromptResult>("prompt.desktopVisit", { ...p, callId: p.promptId }, {
        signal: abort.signal, callId: p.promptId, timeoutMs: p.timeoutMs + 15_000,
      }).then((r) => (r?.answer === "switch" || r?.answer === "refuse" || r?.answer === "expired" ? r.answer : undefined), (err) => {
        if (!(err instanceof HelperRpcError && err.code === "cancelled")) log(`computer-use: the on-screen desktop-switch prompt was not shown (${err instanceof Error ? err.message : "error"})`);
        return undefined;
      });
      return { answer, close: () => abort.abort() };
    },
  };
}

/**
 * The Winter island (`docs/claude/island.md`): while Winter.app is connected with an island (its hello advertised
 * `CLIENT_CAPABILITY_ISLAND`), the desktop-switch prompt's on-screen half is the APP's — it shows the session's own
 * card (`approval_requested`, `onTimeout: "allow"`) in the island, answered through `approval.respond` like any card,
 * the first answer winning in the broker. The helper's own panel stays the fallback, asked (with the same deadline,
 * its answer chained) when there is no island client at the prompt, when the last one LEAVES before an answer (the app
 * quit or crashed mid-prompt), or when none says it shows the card within `ackMs` (`island.shown`; an app that is
 * connected but hung). `close()` closes whichever is up.
 */
export function islandAwareDesktopPanel(
  helperPanel: DesktopVisitPanel, island: IslandPresence | undefined, log: (line: string) => void, ackMs = ISLAND_SHOWN_ACK_MS,
): DesktopVisitPanel {
  return {
    show(p) {
      if (island === undefined || !island.hasClient()) return helperPanel.show(p);
      log(`computer-use: the desktop-switch prompt ${p.promptId} is shown by Winter's island`);
      let closed = false;
      let inner: ReturnType<DesktopVisitPanel["show"]> | undefined;
      let settle!: (a: "switch" | "refuse" | "expired" | undefined) => void;
      const answer = new Promise<"switch" | "refuse" | "expired" | undefined>((resolve) => { settle = resolve; });
      const fallBack = (why: string): void => {
        if (closed || inner !== undefined) return;
        log(`computer-use: the desktop-switch prompt ${p.promptId} goes to the helper too (${why})`);
        try {
          inner = helperPanel.show(p);
        } catch {
          return;
        }
        inner.answer.then(settle, () => settle(undefined));
      };
      const unsubscribe = island.onAllClientsGone(() => fallBack("Winter's island left"));
      const ackWait = new AbortController();
      void island.waitShown(p.promptId, ackMs, ackWait.signal).then((shown) => { if (!shown) fallBack("Winter's island did not show it"); });
      return {
        answer,
        close: () => {
          closed = true;
          ackWait.abort(); // the 2 s ack timer goes with the prompt
          unsubscribe();
          try { inner?.close(); } catch { /* already gone */ }
          settle(undefined);
        },
      };
    },
  };
}

export function createComputerUseRuntime(deps: ComputerUseRuntimeDeps): ComputerUseRuntime {
  const log = (line: string): void => deps.log?.(line);
  let written: { basis: Settings | null | undefined; next: Settings } | undefined;
  const settings = (): Settings | null | undefined => {
    const live = deps.settings();
    if (written === undefined || written.basis !== live) return live;
    // Only the `computerUse` block is served from the write — everything else stays the live holder's.
    return live === null || live === undefined ? written.next : { ...live, computerUse: written.next.computerUse };
  };
  const writeSettings = (transform: (s: Settings) => Settings): void => {
    let next: Settings;
    try {
      next = transform(loadSettings(deps.settingsPath));
      saveSettings(deps.settingsPath, next);
    } catch (err) {
      throw new ComputerUseControlError("settings_write_refused", `settings.json could not be written: ${err instanceof Error ? err.message : "error"}`);
    }
    written = { basis: deps.settings(), next };
  };

  const recentApps = new RecentApps(deps.home);
  const diffBases = new DiffBases();
  const adapters = new AppAdapters({ ...(deps.inject?.adapters === undefined ? {} : { extra: deps.inject.adapters }), log });
  // Late-bound: the helper's notifications go to the service, which is built after the helper — and to the wake
  // registry's backends (the app backend routes the helper's `watchEvent`).
  let service: ComputerV2Service | undefined;
  let wakes: WakeRegistry | undefined;
  const helper = new HelperClient({
    home: deps.home,
    profile: deps.profile,
    launchAllowed: deps.inject?.launchAllowed ?? deps.launchAllowed,
    ...(deps.inject?.transport === undefined ? {} : { transport: deps.inject.transport }),
    ...(deps.inject?.launcher === undefined ? {} : { launcher: deps.inject.launcher }),
    ...(deps.inject?.verifier === undefined ? {} : { verifier: deps.inject.verifier }),
    onNotification: (n) => { service?.handleNotification(n); wakes?.handleNotification(n); },
    onDisconnect: () => { service?.helperDisconnected(); wakes?.helperDisconnected(); },
    log,
  });

  const policy = new ComputerPolicy({
    settings,
    saveAlwaysGrant: (bundleId, name) => writeSettings((s) => setComputerUseApp(s, bundleId, { grant: "always", name })),
    approvals: deps.approvals,
    emit: (sessionId, event: NewSessionEvent) => { deps.hub.append(sessionId, event); },
    session: (sessionId) => {
      const meta = deps.store.meta(sessionId);
      const mode = meta.mode === "chat" || meta.mode === "dispatch" ? meta.mode : "code";
      return { policy: meta.approvalPolicy, mode, ...(meta.origin === undefined ? {} : { origin: meta.origin }), ...(meta.parentSessionId === undefined ? {} : { parentSessionId: meta.parentSessionId }) };
    },
    turnOrigin: (sessionId) => turnOriginIndexFor(deps.hub, deps.store).origin(sessionId),
    // Someone at the MAC is looking at THIS session (the controller's ruling for rung 4): a Mac window or a terminal
    // attached to the session itself. The phone never counts (its gateway connects as the remote role), and a
    // Dispatch coordinator never does: the Mac's Dispatch pill is attached to it all the time, under the same
    // client name as a window (`orb`), and no wire fact tells the two apart — so the pill alone cannot count.
    // A Dispatch child counts only its OWN window, never its coordinator's pill.
    attended: (sessionId) => {
      try { if (deps.store.meta(sessionId).mode === "dispatch") return false; } catch { return false; }
      return deps.hub.attachedHarnesses(sessionId).some((h) => h.role !== "remote" && h.clientName !== "iphone-gateway");
    },
    desktopPanel: islandAwareDesktopPanel(helperDesktopPanel(helper, log), deps.island, log),
    log,
  });

  // Phase 2: the browsers. The registry holds the backends (Winter.app's link registers the built-in browser; Winter
  // for Chrome's host server registers the user's); the engine drives their tabs for the service.
  const backends = new BrowserBackendRegistry();
  const winterWebTabs = (sessionId: string): { tabs: Array<{ tabId: string; url?: string; title?: string }>; activeTabId?: string } => {
    let events: SessionEvent[];
    try { events = deps.store.read(sessionId); } catch { return { tabs: [] }; }
    const fold = foldPanelTabs(events);
    return {
      tabs: fold.tabs.filter((t) => t.kind === "web").map((t) => ({ tabId: t.tabId, ...(t.url === undefined ? {} : { url: t.url }), ...(t.title === undefined ? {} : { title: t.title }) })),
      ...(fold.activeTabId === undefined ? {} : { activeTabId: fold.activeTabId }),
    };
  };
  // Lane H3: the person's panel actions on headless tabs reach the pool (made just below).
  const headlessActions: HeadlessLinkActions = {
    list: (sessionId) => headless.panelTabs(sessionId),
    act: (sessionId, tabId, action) => headless.panelAction(sessionId, tabId, action),
  };
  const browserLink: BrowserLink = new BrowserLink({
    registry: backends, log, headless: headlessActions,
    tabUrl: (sessionId, tabId) => winterWebTabs(sessionId).tabs.find((t) => t.tabId === tabId)?.url,
  });
  // Phase 4: Winter's headless browser — the `headless` backend, its engine started on the first tab. A helper and a
  // cache an earlier daemon left behind go first (this daemon is starting: nothing of them can be in use).
  const telemetry = new AutomationTelemetry(deps.home);
  sweepHeadless(deps.home, { log });
  const headless: HeadlessPool = new HeadlessPool({
    home: deps.home,
    enabled: () => computerUseHeadlessEnabledFrom(settings()),
    // A daemon off its profile's own home finds the helper only through `$WINTER_HEADLESS_APP` (never an installed one).
    resolve: deps.inject?.headless?.resolve ?? (() => resolveWinterHeadless(deps.profile, { overrideOnly: !(deps.inject?.launchAllowed ?? deps.launchAllowed) })),
    ...(deps.inject?.headless?.spawn === undefined ? {} : { spawn: deps.inject.headless.spawn }),
    verify: deps.inject?.headless?.verify ?? processSatisfiesRequirement,
    ...(deps.inject?.headless?.memoryOf === undefined ? {} : { memoryOf: deps.inject.headless.memoryOf }),
    ...(deps.inject?.headless?.idleExitMs === undefined ? {} : { idleExitMs: deps.inject.headless.idleExitMs }),
    ...(deps.inject?.headless?.enabledPollMs === undefined ? {} : { enabledPollMs: deps.inject.headless.enabledPollMs }),
    ...(deps.inject?.headless?.timeouts === undefined ? {} : { timeouts: deps.inject.headless.timeouts }),
    // Lane H3: Winter.app's panel shows a headless tab (the browser link's feature `headless`); the helper accepts only
    // Winter's own app as its viewer.
    viewer: () => browserLink.headlessViewer(),
    viewerMissing: () => browserLink.headlessViewerMissing(),
    viewerRequirement: () => winterAppRequirementFor(deps.profile),
    ...(deps.inject?.headless?.presentStartMs === undefined ? {} : { presentStartMs: deps.inject.headless.presentStartMs }),
    metric: (m) => telemetry.primitive(m),
    log,
  });
  backends.register(headless, { family: "headless", name: HEADLESS_NAME, instanceKey: "headless" });
  const browsers = new BrowserEngine({
    registry: backends,
    // The old Browser's door: parsed through the panel's schema (the http/https guard and the caps), then minted —
    // opened and activated in the session's strip, exactly as `Browser`'s `open` does.
    mintWinterTab: (sessionId, url) => mintPanelTab(deps.hub, PanelOpenTabParams.parse({ sessionId, kind: "web", ...(url === undefined ? {} : { url }) })),
    winterTabClosed: (sessionId, tabId) => { deps.hub.append(sessionId, { type: "panel_tab_closed", sessionId, tabId } as NewSessionEvent); },
    winterTabs: winterWebTabs,
    sessionInfo: (sessionId) => {
      const meta = deps.store.meta(sessionId);
      let title: string | null = null;
      try { title = deps.store.getTitle(sessionId); } catch { title = null; }
      return { cwd: meta.cwd, ...(title === null ? {} : { title }) };
    },
    site: {
      ...(deps.dangerousDomainsAdded === undefined ? {} : { dangerousDomainsAdded: deps.dangerousDomainsAdded }),
      ...(deps.savedAllowRules === undefined ? {} : { savedAllowRules: deps.savedAllowRules }),
    },
    home: deps.home,
    uploadRoots: (sessionId, cwd) => ({ tmpDir: sessionTmpDir(sessionId), denyRead: sandboxConfigFor(deps.home, cwd).filesystem?.denyRead ?? [] }),
    downloadRoots: (sessionId, cwd) => {
      const sandbox = sandboxConfigFor(deps.home, cwd).filesystem;
      return { tmpDir: sessionTmpDirPath(sessionId), denyWrite: sandbox?.denyWrite ?? [], denyRead: sandbox?.denyRead ?? [] };
    },
    screenshotMaxDim: () => computerUseScreenshotMaxDimFrom(settings()),
    // A real install only: a copy in the Trash, a cache (Playwright's Chrome for Testing), a translocated or temp copy
    // does not make a browser "installed" for browsers.list().
    installed: deps.inject?.browserInstalled ?? ((bundleId) => installedBrowser(bundleId)),
    persistentlyAllowed: (sessionId, bundleId) => policy.persistentlyAllowed(sessionId, bundleId),
    stopScript: (sessionId, reason) => service?.stopScript(sessionId, reason),
    ...(deps.turnRunning === undefined ? {} : { turnRunning: deps.turnRunning }),
    headlessSessionEnded: (sessionId) => headless.disposeSession(sessionId),
    headlessReason: () => headless.reason,
    headlessLocalNetworkRefusedAt: (tabKey) => headless.localNetworkRefusedAt(tabKey),
    headlessPresentMissing: () => headless.presentMissing(),
    headlessHandBack: (tabKey) => headless.handBack(tabKey),
    headlessHandoffOver: (tabKey) => headless.handoffOver(tabKey),
    headlessView: (tabKey) => headless.view(tabKey),
    headlessHeld: (tabKey) => headless.held(tabKey),
    headlessHolds: (tabKey) => headless.holds(tabKey),
    // Wake triggers: the helper's input to a browser bound as an APP reaches its page as trusted DOM events — Winter's
    // own, never the user's action on a tab trigger (the service records it per app, from every session).
    ownAppInputAt: (bundleId, at) => service?.ownAppInputAt(bundleId, at) === true,
    log,
  });

  // Wake triggers (2026-10-12): the registry, and the two backends it routes to by target kind — a tab binding → the
  // browser engine's backend, an app target → the helper's. A test daemon may inject fakes in their place.
  const wakeBackends: WakeBackends = { ...(deps.inject?.wakeBackends ?? {}) };
  if (deps.inject?.wakeBackends === undefined) {
    // The tab watches, over the engine's tabs (the page runtime's watcher, or Winter for Chrome's own). The registry
    // calls its `stop()` first at daemon stop — before `svc.stop()` stops the engine — so its watches end quietly
    // rather than as `lost` while their links close.
    wakeBackends.tab = new BrowserWakeBackend(browsers, { log });
    // The helper's watches. Its hooks — the helper's `watchEvent`, the connection's loss, the daemon's stop — reach it
    // through the registry, which fans the helper callbacks above and its own `stop()` out to each backend.
    wakeBackends.app = new AppWakeBackend({
      helper,
      target: (sessionId, targetId) => service?.appTarget(sessionId, targetId),
      persistentlyAllowed: (sessionId, bundleId) => policy.persistentlyAllowed(sessionId, bundleId),
      log,
    });
  }
  const sessionState = (sessionId: string): WakeSessionState => {
    try { return deps.store.meta(sessionId).archived === true ? "archived" : "live"; } catch { return "gone"; }
  };
  wakes = new WakeRegistry({
    backends: () => wakeBackends,
    settings,
    append: (sessionId, event) => { deps.hub.append(sessionId, event); },
    sessionState,
    sessions: () => deps.sessions?.(),
    ...(deps.followedNow === undefined ? {} : { followedNow: deps.followedNow }),
    ...(deps.followWake === undefined ? {} : { followWake: deps.followWake }),
    store: new WakeStore(deps.home, log),
    telemetry: (m) => telemetry.primitive(m),
    ...(deps.audit === undefined ? {} : { audit: deps.audit }),
    ...(deps.inject?.wakeTimings?.coalesceMs === undefined ? {} : { coalesceMs: deps.inject.wakeTimings.coalesceMs }),
    ...(deps.inject?.wakeTimings?.pollMs === undefined ? {} : { pollMs: deps.inject.wakeTimings.pollMs }),
    ...(deps.inject?.wakeTimings?.retryDelaysMs === undefined ? {} : { retryDelaysMs: deps.inject.wakeTimings.retryDelaysMs }),
    ...(deps.inject?.wakeTimings?.armTimeoutMs === undefined ? {} : { armTimeoutMs: deps.inject.wakeTimings.armTimeoutMs }),
    log,
  });
  const wakeRegistry = wakes;

  service = new ComputerV2Service({
    helper, policy, settings, diffBases, recentApps, adapters, browsers, wakes: wakeRegistry,
    site: {
      ...(deps.dangerousDomainsAdded === undefined ? {} : { dangerousDomainsAdded: deps.dangerousDomainsAdded }),
      ...(deps.savedAllowRules === undefined ? {} : { savedAllowRules: deps.savedAllowRules }),
    },
    sessionCwd: (sessionId) => deps.store.meta(sessionId).cwd ?? undefined,
    telemetry,
    ...(deps.audit === undefined ? {} : { audit: deps.audit }),
    ...(deps.interrupt === undefined ? {} : { interrupt: deps.interrupt }),
    // The worker never reads the daemon's own home, whatever its profile would otherwise allow (review I2).
    worker: { ...(deps.inject?.worker ?? {}), denyRead: [deps.home, ...(deps.inject?.worker?.denyRead ?? [])] },
    ...(deps.inject?.startWorker === undefined ? {} : { startWorker: deps.inject.startWorker }),
    ...(deps.inject?.idleMs === undefined ? {} : { idleMs: deps.inject.idleMs }),
    ...(deps.inject?.screenshotSink === undefined ? {} : { screenshotSink: deps.inject.screenshotSink }),
    log,
  });
  const svc = service;

  const control: ComputerUseControl = {
    async status() {
      const s = settings();
      const helperStatus = await helper.status();
      return {
        enabled: s ? computerUseEnabledFrom(s) : true,
        allowAllApps: computerUseAllowAllAppsFrom(s),
        legacyComputer: computerUseLegacyComputerFrom(s),
        mirror: computerUseMirrorFrom(s),
        privateEventPath: computerUsePrivateEventPathFrom(s),
        headlessEnabled: computerUseHeadlessEnabledFrom(s),
        webmcp: computerUseWebMcpFrom(s),
        wakes: computerUseWakesFrom(s),
        helper: helperStatus,
        browsers: browsers.listRows().map((r) => ({ id: r.id, name: r.name, connected: r.connected, ...(r.reason === undefined ? {} : { reason: r.reason }) })),
      };
    },
    async requestPermission(kind) {
      try {
        await helper.request("permissions.request", { kind }, { timeoutMs: 15_000 });
      } catch (err) {
        if (err instanceof HelperUnavailableError) throw new ComputerUseControlError("helper_unavailable", err.message);
        if (err instanceof HelperRpcError) throw new ComputerUseControlError("helper_unavailable", `Winter Computer Use could not ask for the permission (${err.code})`);
        throw err;
      }
    },
    appsList() {
      // EXCEPTIONS ONLY (the user ruling): the user's rows with an access, the built-in default exceptions they
      // have not removed, and the rows that exist only for an "Always allow" grant (`access: null`).
      const apps = computerUseAppsFrom(settings());
      const recentById = new Map(recentApps.list().map((r) => [r.bundleId, r]));
      const rows: ComputerUseAppRow[] = [];
      const row = (bundleId: string, access: ComputerUseAccess | null, isDefault: boolean, grant: "always" | null, storedName?: string): ComputerUseAppRow => {
        const r = recentById.get(bundleId);
        return {
          bundleId,
          name: storedName ?? defaultAppException(bundleId)?.name ?? r?.name ?? bundleId,
          access, grant, isDefault,
          ...(r === undefined ? {} : { lastUsedAt: r.lastUsedAt }),
        };
      };
      for (const [bundleId, set] of Object.entries(apps)) {
        const grant = set.grant ?? null;
        const builtIn = defaultAppException(bundleId);
        if (set.access !== undefined) rows.push(row(bundleId, set.access, false, grant, set.name));
        else if (set.removed !== true && builtIn !== undefined) rows.push(row(bundleId, builtIn.access, true, grant, set.name));
        else if (grant !== null) rows.push(row(bundleId, null, false, grant, set.name));
      }
      for (const [bundleId, builtIn] of Object.entries(DEFAULT_APP_EXCEPTIONS)) {
        if (!Object.hasOwn(apps, bundleId)) rows.push(row(bundleId, builtIn.access, true, null));
      }
      return rows.sort((a, b) => a.name.localeCompare(b.name) || a.bundleId.localeCompare(b.bundleId));
    },
    appsSet(p) {
      if (!BUNDLE_ID.test(p.bundleId)) throw new ComputerUseControlError("invalid_params", "bundleId is not a bundle identifier");
      // `access: null` removes the exception: a built-in default's removal is STORED (`removed: true`), or the
      // default would come straight back.
      const hasDefault = defaultAppException(p.bundleId) !== undefined;
      writeSettings((s) => setComputerUseApp(s, p.bundleId, {
        ...(p.access === undefined ? {} : { access: p.access }),
        ...(p.grant === undefined ? {} : { grant: p.grant }),
        ...(p.name === undefined ? {} : { name: p.name }),
      }, { hasDefault }));
      // A revoked "Always allow" must not survive as this daemon's in-memory session grant from its card.
      if (p.grant === null) policy.forgetGrant(p.bundleId);
    },
    setSettings(p) {
      writeSettings((s) => setComputerUseFlags(s, p));
      // Turned off from the app: the armed triggers end now, not at the next poll.
      if (p.wakes === false || p.enabled === false) wakeRegistry.checkSettings();
    },
    wakesArmed: (sessionId) => wakeRegistry.countFor(sessionId),
    wakesCancel: (sessionId, wakeId) => wakeRegistry.cancel(sessionId, wakeId, "user"),
    wakesList: () => wakeRegistry.listAll(),
  };

  return {
    service: svc,
    helper,
    policy,
    control,
    settings,
    browsers,
    backends,
    browserLink,
    headless,
    wakes: wakeRegistry,
    sessionArchived(sessionId) {
      wakeRegistry.sessionEnded(sessionId);
      browsers.sessionArchived(sessionId);
    },
    observe(event) {
      diffBases.observe(event);
      adapters.observe(event);
      svc.hoverNotes.observe(event);
      // 5a: the USER's next message lifts the session's desktop-switch refusals (and its dispatch children's).
      const lift = desktopRefusalLiftFor(event);
      if (lift !== undefined) policy.liftDesktopRefusals(lift);
      // A built-in tab closed in the strip (by the user, or by Winter): the engine lets go of it.
      if (event.type === "panel_tab_closed") browsers.panelTabClosed(event.sessionId, (event as { tabId: string }).tabId);
      if (event.type === "turn_completed") {
        const threadId = (event as { threadId?: string }).threadId;
        if (threadId === undefined || threadId === "main") svc.turnEnded(event.sessionId);
      }
    },
    stop() {
      // The armed triggers stay in `wakes.json` (the next boot's `restart`); their backends let go first.
      wakeRegistry.stop();
      svc.stop();
      browserLink.stop();
      headless.stop();
      helper.close();
    },
  };
}
