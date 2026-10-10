// ComputerV2 (2026-10-08) — the daemon's computer-use runtime, assembled ONCE at boot: the helper connection,
// the policy, the service, the telemetry, the recently-used apps, the settings writes the cards and the app's
// RPCs make, and the control surface behind the four local-only `computerUse.*` RPCs (plus `setSettings`).
//
// SETTINGS ARE HOT, never a restart: every reader reads the daemon's live holder, and a write made here (an
// "Always allow" answer, `computerUse.apps.set`, `computerUse.setSettings`) is ALSO served from memory until the
// settings watcher swaps the holder (the `connector-source.ts` `noteWritten` pattern) — the very next call sees it.
import { PanelOpenTabParams, type NewSessionEvent, type SessionEvent } from "@yanlinglabs/winter-protocol";
import type { ApprovalBroker } from "../agent/approvals";
import { sessionTmpDir } from "../agent/session-tmp";
import { mintPanelTab } from "../panel/open-tab";
import { foldPanelTabs } from "../panel/store";
import { sandboxConfigFor } from "../runtime-sdk/mode-options";
import type { WinterProfile } from "../profile";
import type { SessionHub } from "../sessions/hub";
import type { SessionStore } from "../sessions/store";
import { isHumanTurnOrigin, runningTurnOrigin } from "../sessions/turn-origins";
import {
  computerUseAllowAllAppsFrom, computerUseAppsFrom, computerUseEnabledFrom, computerUseLegacyComputerFrom, computerUseMirrorFrom,
  computerUsePrivateEventPathFrom, computerUseScreenshotMaxDimFrom, loadSettings, saveSettings, setComputerUseApp, setComputerUseFlags,
  type ComputerUseAccess, type Settings,
} from "../settings";
import { AppAdapters, type AppAdapter } from "./adapters";
import { systemAppResolver } from "./app-resolve";
import { BrowserLink } from "./browser/cef-link/rpc";
import { BrowserEngine } from "./browser/engine";
import { BrowserBackendRegistry } from "./browser/registry";
import { DiffBases } from "./diff-base";
import { HelperClient, type HelperLauncher, type HelperTransport, type HelperVerifier } from "./helper-client";
import { ComputerPolicy, DEFAULT_APP_EXCEPTIONS, defaultAppException, type DesktopVisitPanel } from "./policy";
import { HelperRpcError, HelperUnavailableError, type DesktopVisitPromptResult, type HelperPermissions } from "./protocol";
import { RecentApps } from "./recent-apps";
import { ComputerV2Service } from "./service";
import { AutomationTelemetry } from "./telemetry";
import type { AutomationWorker, AutomationWorkerOptions } from "./worker-host";

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
  inject?: ComputerUseInjection;
  log?(line: string): void;
}

export interface ComputerUseStatus {
  enabled: boolean;
  allowAllApps: boolean;
  legacyComputer: boolean;
  mirror: boolean;
  privateEventPath: boolean;
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
  setSettings(p: { enabled?: boolean; mirror?: boolean; privateEventPath?: boolean; allowAllApps?: boolean }): void;
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
  // Late-bound: the helper's notifications go to the service, which is built after the helper.
  let service: ComputerV2Service | undefined;
  const helper = new HelperClient({
    home: deps.home,
    profile: deps.profile,
    launchAllowed: deps.inject?.launchAllowed ?? deps.launchAllowed,
    ...(deps.inject?.transport === undefined ? {} : { transport: deps.inject.transport }),
    ...(deps.inject?.launcher === undefined ? {} : { launcher: deps.inject.launcher }),
    ...(deps.inject?.verifier === undefined ? {} : { verifier: deps.inject.verifier }),
    onNotification: (n) => service?.handleNotification(n),
    onDisconnect: () => service?.helperDisconnected(),
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
    turnOrigin: (sessionId) => { try { return runningTurnOrigin(deps.store.read(sessionId)); } catch { return undefined; } },
    // Someone at the MAC is looking at THIS session (the controller's ruling for rung 4): a Mac window or a terminal
    // attached to the session itself. The phone never counts (its gateway connects as the remote role), and a
    // Dispatch coordinator never does: the Mac's Dispatch pill is attached to it all the time, under the same
    // client name as a window (`orb`), and no wire fact tells the two apart — so the pill alone cannot count.
    // A Dispatch child counts only its OWN window, never its coordinator's pill.
    attended: (sessionId) => {
      try { if (deps.store.meta(sessionId).mode === "dispatch") return false; } catch { return false; }
      return deps.hub.attachedHarnesses(sessionId).some((h) => h.role !== "remote" && h.clientName !== "iphone-gateway");
    },
    desktopPanel: helperDesktopPanel(helper, log),
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
  const browserLink = new BrowserLink({
    registry: backends, log,
    tabUrl: (sessionId, tabId) => winterWebTabs(sessionId).tabs.find((t) => t.tabId === tabId)?.url,
  });
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
    screenshotMaxDim: () => computerUseScreenshotMaxDimFrom(settings()),
    installed: deps.inject?.browserInstalled ?? ((bundleId) => systemAppResolver.fromBundleId(bundleId) !== undefined),
    persistentlyAllowed: (sessionId, bundleId) => policy.persistentlyAllowed(sessionId, bundleId),
    stopScript: (sessionId, reason) => service?.stopScript(sessionId, reason),
    ...(deps.turnRunning === undefined ? {} : { turnRunning: deps.turnRunning }),
    log,
  });

  service = new ComputerV2Service({
    helper, policy, settings, diffBases, recentApps, adapters, browsers,
    telemetry: new AutomationTelemetry(deps.home),
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
    },
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
    observe(event) {
      diffBases.observe(event);
      adapters.observe(event);
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
      svc.stop();
      browserLink.stop();
      helper.close();
    },
  };
}
