import { join } from "node:path";
import { mkdirSync, realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { bootstrapNormaDir, resolveNormaHome } from "./norma-dir";
import { acquireLock, type Lock } from "./lock";
import { TokenAuthority } from "./auth/tokens";
import { KeychainSecretStore, type SecretStore } from "./auth/secret-store";
import { migrateLegacyCredentialMaterial } from "./auth/credential-material";
import { SessionStore } from "./sessions/store";
import { SessionHub } from "./sessions/hub";
import { reapEmptySessions } from "./sessions/reaper";
import { ensureOutdir } from "./sessions/outdir";
import { writeDiff, type DiffHeader } from "./diffs/store";
import type { ActivityDeriver } from "./sessions/activity";
import { startIpcServer, type IpcServer, type IpcServerOptions } from "./ipc/server";
import { loadSettings, loadPermissionDirs, hooksEnabledFrom, memoryEnabledFrom, lspAutoDiagnosticsEnabledFrom, workflowsEnabledFrom, keywordTriggerEnabledFrom, cleanerEnabledFrom, winterLegDisabledKeys } from "./settings";
import { ProjectSettingsResolver } from "./project-settings";
import { memoryDirFor, globalMemoryDirFor, assistantMemoryDirFor, memoryProjectKeyFor, repoRootFor } from "./agent/memory-dir";
import { migrateMemoryStore } from "./agent/memory-migrate";
import { createProvider } from "./providers/manager";
import type { Provider } from "./providers/types";
import { QuotaManager } from "./providers/quota";
import { ToolRegistry } from "./agent/tools/registry";
import { WorkflowRuntime } from "./workflows/runtime";
import { WorkflowStore } from "./workflows/store";
import { MemoryStore } from "./agent/memory";
import type { ResearchRunner } from "./agent/tools/read-page";
import { PageCache } from "./agent/tools/page-core";
import { createResearchRunner } from "./agent/research";
import { registerComputerTool } from "./agent/tools/computer";
import { ComputerUseService } from "./agent/computer-use";
import { SessionTitler } from "./agent/titles";
import { McpManager } from "./agent/mcp/manager";
import { notifyHeadless } from "./agent/notify-fallback";
import { LspManager } from "./agent/lsp/manager";
import { PermissionGate, type SessionApprovalPolicy } from "./agent/gate";
import { PermissionRules } from "./agent/permission-rules";
import { ApprovalBroker } from "./agent/approvals";
import { QuestionBroker } from "./agent/questions";
import { createPersistedChildren, type AgentRegistry } from "./agent/bg-agent-registry";
import { createChildrenRpc } from "./runtime-sdk/children-rpc";
import type { EngineSignals } from "./ipc/server";
import { realpathSync as realpathForGrant } from "node:fs";
import { resolve as resolveForGrant, sep as pathSep } from "node:path";
import { OutputStyleStore } from "./agent/output-styles";
import { Dreamer } from "./agent/dreamer";
import { SessionCleaner } from "./sessions/cleaner";
import { deriveModelAliases } from "./agent/model-aliases";
import { SessionDirectories } from "./agent/dirs";
import { TrustStore } from "./agent/trust";
import { ContextAssembler } from "./agent/context";
import { SkillStore } from "./agent/skills";
import { BackgroundTaskRegistry } from "./agent/bg-registry";
import { sessionTmpDir } from "./agent/session-tmp";
import { PluginStore, pluginMcpEligible, pluginSpawnEligible, hookRegistryPlugins } from "./agent/plugins";
import { PluginSupervisor } from "./plugins/supervisor";
import { PluginContribRegistry } from "./plugins/contrib";
import { HookRegistry, HookFacade } from "./plugins/hook-registry";
import { HookRunner } from "./plugins/hook-runner";
import { BashReviewer } from "./agent/reviewer";
import { AuditLog } from "./peripheral/audit";
import { PeripheralBroker, type PeripheralClass } from "./peripheral/broker";
import { ProviderLink } from "./peripheral/provider-link";
import { HardwareBroker } from "./peripheral/hardware";
import { PanelCommandRegistry } from "./panel/commands";
import { foldPanelTabs } from "./panel/store";
import { mintPanelTab } from "./panel/open-tab";
import { openRoutineStore } from "./routines/store";
import { RoutineAuditLog } from "./routines/audit";
import { makeApply } from "./settings-apply";
import { SettingsWatcher } from "./settings-watcher";
import { startRuntimeState, runtimeStateOnline, type DaemonRuntimeState } from "./runtime-state/wiring";
import { restampStep } from "./runtime-state/recovery";
import { createNormaRuntimeSdk, type NormaRuntimeSdk } from "./runtime-sdk/create";
import { advisorReviewerFor, familyOfModel, officialLegDefaultSessionModel } from "./runtime-sdk/advisor-reviewer";
import { attachedFacetFor, parkRecoveredSessions } from "./runtime-sdk/messaging";
import { createWinterSessionDrivers, sessionPermissionClassFor, type WinterLegDeps, type WinterSessionDrivers } from "./runtime-sdk/session-driver";
import { configuredMcpServersFor } from "./runtime-sdk/external-mcp";
import { planBridgeFor, type PlanBridge } from "./runtime-sdk/plan-bridge";
import { importEngineEraSession } from "./runtime-sdk/import-legacy";
import { registerHandoffParticipants, planAndApplySwitch } from "./runtime-sdk/handoff";
import { createSinkCallStore, sinksFor } from "./runtime-sdk/sinks";
import { sessionHooksFor } from "./runtime-sdk/hooks";
import { buildCapabilitiesFor, type CapabilityDeps, type CapabilityServerRecord, type CapabilitySession } from "./capabilities";
import type { McpSdkServerConfigWithInstance } from "@yanlinglabs/winter-agent-sdk";
import { makeDaemonRoutineRunner } from "./routines/runner";
import { makeRoutineScheduler } from "./routines/scheduler";
import type { NewSessionEvent } from "@norma/protocol";
import { CORE_VERSION } from "./version";

export { CORE_VERSION } from "./version";

export interface RunningDaemon {
  socketPath: string;
  // `remote` (SP2a Task 1): ensureTokens() already mints/returns it (auth/tokens.ts's
  // TOKEN_NAMES table, Remote Gateway SP1 Task 1) and the `tokens` object below is that SAME
  // result passed through verbatim — this widens the TYPE to match what's already there, no
  // runtime change. Lets a Swift test harness (RealDaemon.swift) that spawns this via a `bun -e`
  // fixture print `d.tokens.remote` without a separate FileSecretStore read.
  tokens: { harness: string; admin: string; remote: string };
  // R-T3 whole-branch review FIX 1: the SAME ToolRegistry instance every `register*Tool(s)` call
  // inside the `if (agentProvider)` gate above populates (mirrored into `sharedRegistry`, then
  // threaded to ipc/server.ts's `registry` option) — exposed here too so a test that boots a REAL
  // daemon (temp NORMA_HOME + injected FakeProvider, same precedent as server.test.ts/
  // remote-allowlist-parity.test.ts) can walk `registry.namesForMode(mode, ...)` against daemon.ts's
  // ACTUAL registration path instead of a hand-picked mirror of it (see
  // test/agent/mode-toolset-census.test.ts). `null` on a no-agentProvider daemon (opts.agentProvider
  // === null), same "typed no-op" precedent as `sharedRegistry ?? undefined` a few lines below.
  registry: ToolRegistry | null;
  // P8a Task 12: the runtime spine this daemon booted — the open `runtime-state.db`, its six
  // repositories, and the reports from this boot's recovery/backfill. `{ unavailable: error }` when
  // the store would not open (a corrupt or newer-schema file): the daemon runs WITHOUT runtime
  // routing rather than refusing to start, and nothing else in the daemon depends on it in 8a.
  // 8b's `createRuntimeSdk({ directoryStore })` consumes `directory` off this.
  runtimeState: DaemonRuntimeState;
  /**
   * P8b Task 5: THE ONE Winter runtime handle — the router `createRuntimeSdk` built, the spawn
   * hook every Winter session's `Options` takes its executable from, and the tracked-query registry
   * shutdown drains. `undefined` when the router could not construct (a packaging fault: a peer
   * version mismatch, an invalid brand, a malformed capability declaration), in which case EVERY
   * `session.create`/`session.dispatch` refuses typed (`winter_leg_unavailable`) — there is no
   * engine leg to fall back to since Task 17.
   *
   * Exposed here for the same reason `runtimeState` is: a test that boots a REAL daemon needs to
   * assert against the handle daemon.ts actually built, not a hand-made mirror of it.
   */
  runtimeSdk: NormaRuntimeSdk | undefined;
  /**
   * P8b Task 5: THE SessionStore this daemon opened — the same instance `stop()` closes.
   *
   * Exposed for the same reason `registry` is: `store.close()` moved onto `stop()`'s ASYNC tail
   * (behind `runtimeSdk.dispose()`, because a draining Winter child appends its final events
   * through it), and the only honest way to prove that ordering is to use the daemon's OWN handle
   * from inside a tracked session's teardown — a second `SessionStore` over the same home would
   * answer whether or not this one had been closed, which is a test that passes for the wrong
   * reason. See `test/daemon-runtime-sdk-boot.test.ts`.
   */
  sessions: SessionStore;
  /**
   * P8b Tasks 6-7/16 (P8b-36): this session's daemon-owned capability servers.
   *
   * `callTool(name, args)` carries no session identity, so the identity is BAKED INTO the server —
   * one set per session, handed to that session's own `Options.mcpServers` by the driver (Task 16).
   * Already KEYED BY NAME, because the child derives each tool's wire name from the record key.
   * Exposed on the daemon because a test needs the SAME deps bundle daemon.ts wired, never a mirror.
   */
  buildSessionCapabilities(session: CapabilitySession): CapabilityServerRecord;
  /**
   * P8b Task 16: the Winter leg's driver table — the SAME instance `ipc/server.ts` routes through.
   * A test that boots a REAL daemon reads a session's live driver (its `init` facts, its state, its
   * child) off this rather than off a mirror it built itself.
   */
  winter: WinterSessionDrivers;
  /**
   * P8b Task 15: THE LIVE settings holder — the same binding the settings-watcher swaps, not a boot
   * snapshot. Reading it twice around a `settings.json` write is how a test proves a key is hot
   * without a restart, which matters most for keys whose only consumer lands in a later task
   * (`runtimes.winterLeg`, `winterExecutable`, `advisorModel`, `winterIdleTimeoutSec` are read by
   * Tasks 5/9/16). `null` on a daemon that never loaded settings at all.
   */
  settings(): ReturnType<typeof loadSettings> | null;
  /**
   * Tear the daemon down, in THIS order (P8b Task 5 widened it — read the whole thing):
   *
   *   1. synchronous kills — the socket server, MCP, LSP, plugins, background agents, the settings
   *      watcher, the routine scheduler/store, the dreamer. All of this has happened when `stop()`
   *      RETURNS, exactly as it always has.
   *   2. `runtimeSdk.dispose()` — every live Winter session ends (bounded by
   *      `SHUTDOWN_QUERY_GRACE_MS`), then the router's own dispose. ASYNC.
   *   3. `store.close()` — the session store. NO LONGER SYNCHRONOUS when a Winter handle exists: a
   *      draining child appends its last events through it, so it must outlive step 2.
   *   4. `runtime.close()` — the §16 deletion drain (bounded) and `runtime-state.db`, which step 2's
   *      delivery receipts likewise write into.
   *   5. `lock.release()` — unlinks the socket file, and `norma doctor`'s repairs check for its
   *      absence before touching it.
   *
   * The returned promise is present whenever EITHER the Winter handle or the runtime spine exists —
   * i.e. on essentially every real daemon. A caller that then exits the process MUST await it, or
   * the process dies mid-drain with the lock still on disk.
   */
  stop(): void | Promise<void>;
}

/** Builds the `policy(sessionId, cls)` dependency PeripheralBroker.lease() awaits (spec §A1:
 *  "lease acquisition FOLLOWS THE SESSION APPROVAL POLICY for ALL classes" — plan→denied,
 *  auto→granted, ask→a normal approval card). Reuses the SAME ApprovalBroker + approval_requested/
 *  approval_resolved/approval.respond machinery the agent engine's tool-call approvals use (no
 *  new wire method) — see engine.ts's `requestApproval` for the byte-identical
 *  wait-before-emit pattern this mirrors.
 *
 *  `cls` is now a plain call argument — PeripheralBroker.lease() passes `req.class` straight
 *  through, so the approval card's summary reads it off this closure's own parameter instead of
 *  a synchronous set/get side-channel (the former `peripheralClassHint` map) that only stayed
 *  race-safe because nothing ever awaited between the set and the card emit. */
function buildLeasePolicy(deps: {
  store: SessionStore;
  approvals: ApprovalBroker;
  hub: SessionHub;
  timeoutMs?: number;
}): (sessionId: string, cls: PeripheralClass) => Promise<"granted" | "denied"> {
  return async (sessionId: string, cls: PeripheralClass): Promise<"granted" | "denied"> => {
    let meta: { approvalPolicy: SessionApprovalPolicy; mode?: string };
    try {
      // COUPLING (4h-i, refined 4h-ii-a): this reads the PERSISTED session policy as a proxy for
      // "the current caller's policy". That's safe because peripheral.lease is a harness-only RPC
      // (ipc/server.ts line 654), NEVER registered as an agent tool — so NO thread (main or
      // subagent, sync or async/4h-ii) can ever reach it from a tool call. If a thread-correlated
      // lease path is ever added to the registry in the future, gate approval on the calling
      // thread's policy (opts.threadId, or a thread_policy map), not the persisted session policy.
      meta = deps.store.meta(sessionId);
    } catch {
      return "denied"; // unknown session — fail closed (ipc/server.ts already validates first)
    }
    // Plan-immunity fix round 1, Minor 1 (reviewer finding): a chat session never gets a peripheral
    // lease — denied outright, matching "chat never asks permissions" (and chat has no computer
    // tool in the first place, so this is unreachable today — same defense-in-depth tier as the
    // other explicit "chat" handling this slice added). Keyed on `meta.mode`, NOT
    // `meta.approvalPolicy` — a chat session created BEFORE this fix shipped keeps its stored
    // policy at "auto" forever (session.setPolicy now rejects EVERY change to a chat target, so
    // there is no migration path that would ever rewrite that row to "chat"), so a raw-policy check
    // here would miss exactly the rows this fix most needs to catch — proven by a synthetic
    // stale-row test (packages/core/test/peripheral/e2e.test.ts) that GRANTS instead of denying
    // without this `mode` check.
    if (meta.mode === "chat") return "denied";
    if (meta.approvalPolicy === "plan") return "denied";
    if (meta.approvalPolicy === "auto") return "granted";

    // ask: register the wait BEFORE emitting approval_requested (the append is synchronous, so a
    // watcher that resolves as soon as it observes the event would otherwise race broker.wait()).
    const callId = `lease_${randomBytes(6).toString("hex")}`;
    const timeoutMs = deps.timeoutMs ?? 5 * 60_000;
    // issuedAt/expiresAt threaded to BOTH the broker (approval.list) and the event (SP3 T4b) — see
    // engine.ts's requestApproval for the same one-compute-thread-both pattern.
    const issuedAt = Date.now();
    const expiresAt = issuedAt + timeoutMs;
    const summary = `Session ${sessionId} requests ${cls}`;
    const waiting = deps.approvals.wait(sessionId, callId, timeoutMs, {
      toolName: "peripheral.lease", summary, issuedAt, expiresAt,
    });
    const event: NewSessionEvent = {
      type: "approval_requested", sessionId, threadId: "main", callId,
      toolName: "peripheral.lease", summary, issuedAt, expiresAt,
    };
    try {
      deps.hub.append(sessionId, event);
    } catch (err) {
      deps.approvals.resolve(sessionId, callId, false, "emit-failure");
      throw err;
    }
    const res = await waiting;
    deps.hub.append(sessionId, {
      type: "approval_resolved", sessionId, threadId: "main", callId, approved: res.approved, by: res.by,
    });
    return res.approved ? "granted" : "denied";
  };
}

/** `plugin__<pluginId>__<name>` → its two halves (P8c integration round 2, `capabilityDeps.external`
 *  below) — the exact inverse of `ipc/server.ts`'s `tool.register` handler's own
 *  `` `plugin__${pluginId}__${p.name}` `` template. Splits on the FIRST `__` after the `plugin__`
 *  prefix: `pluginId` is a raw plugin-directory name that `agent/plugin-manifest.ts#loadManifest`
 *  only WARNS about (not rejects) containing `__`, while `ToolRegisterParams`'s wire schema REJECTS
 *  `__` in a tool `name` outright (`protocol/methods.ts`'s "Safe tool-name charset" comment) — so a
 *  first-`__` split can only misparse a pluginId that already carries the exact collision hazard
 *  `unregisterByPrefix` names as a known, documented risk elsewhere. Returns `undefined` for
 *  anything not shaped `plugin__x__y` (never throws). */
export function pluginToolNameParts(fullName: string): { pluginId: string; name: string } | undefined {
  const PREFIX = "plugin__";
  if (!fullName.startsWith(PREFIX)) return undefined;
  const rest = fullName.slice(PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep < 0) return undefined;
  const pluginId = rest.slice(0, sep);
  const name = rest.slice(sep + 2);
  return pluginId && name ? { pluginId, name } : undefined;
}

export async function startDaemon(opts: {
  home?: string;
  secrets?: SecretStore;
  server?: Partial<Pick<IpcServerOptions, "helloTimeoutMs" | "maxConnections" | "preAuthMaxLine">>;
  /** undefined: try settings.json (production default). null: agent disabled (tests, Phase 0
   *  behavior). object: use this provider directly (tests inject FakeProvider). `live`, when
   *  present, is threaded into EngineConfig.provider.live (no-restart model resolution) — tests
   *  that inject a provider directly and don't care about live resolution just omit it. */
  agentProvider?: { provider: Provider; model: string; live?: () => { model: string; reasoningEffort?: string } } | null;
  /** TEST ONLY (fix round 1, M2) — threaded straight into `WinterLegDeps.officialConnectionOverride`;
   *  a production caller never sets this. See that field's own doc for why it exists at all. */
  officialConnectionOverride?: WinterLegDeps["officialConnectionOverride"];
} = {}): Promise<RunningDaemon> {
  const startedAt = Date.now();
  const dirs = bootstrapNormaDir(opts.home ?? resolveNormaHome());
  const lock: Lock = await acquireLock(dirs.lockPath, dirs.socketPath);

  const secrets = opts.secrets ?? new KeychainSecretStore();
  const authority = new TokenAuthority(secrets);
  const tokens = await authority.ensureTokens();

  const store = new SessionStore(dirs.home);
  const hub = new SessionHub(store);

  // session-activity-hygiene T8: THE activity derivation, filled in by `startIpcServer` below
  // (`onActivityDeriver`) and read live by dispatch's `list_sessions` tool, which is registered long
  // before the server exists. It cannot be built here: two of its five signals come from T5's
  // enforcement, which lives inside the server's scope and is mutually recursive with the derivation
  // — see `IpcServerOptions.onActivityDeriver`. `startIpcServer` is called unconditionally further
  // down (before any turn can run), so the tool never actually observes the unset holder.
  let activityDeriver: ActivityDeriver | undefined;

  const normaHome = dirs.home;

  // Loaded once, up front, so the settings-derived plugin consent (below) is available before
  // the SkillStore and PluginStore are built. A malformed settings.json degrades to `null` here
  // — the agent gets disabled further down rather than crashing daemon startup.
  //
  // P8a Task 12 HOISTED this above the reaper's boot sweep (it used to sit just below): the runtime
  // spine's boot block between them reads `settings.provider.type` for §17's backfill, and recovery
  // has to run BEFORE the reaper — a reaper pass reads the product index that recovery's step 1 is
  // what rebuilds. `loadSettings` depends on nothing but `dirs.settingsPath`, so the move is a
  // reordering of two independent statements, not a change of behaviour.
  let settings: ReturnType<typeof loadSettings> | null;
  try {
    settings = loadSettings(dirs.settingsPath);
    // Task 17: the engine leg no longer exists — a `winterLeg.<mode>: false` is accepted for one
    // release, reported here (and by settings-apply on a hot edit), never obeyed.
    for (const key of winterLegDisabledKeys(settings)) console.error(`settings: runtimes.winterLeg.${key} = false — the engine leg no longer exists; ignored`);
  } catch (err) {
    console.error(`settings unavailable, agent disabled: ${(err as Error).message}`);
    settings = null;
  }

  // ── The runtime spine (P8a, WS-16) ────────────────────────────────────────────────────────────
  // Open `runtimes/runtime-state.db`, run §13's twelve recovery steps, catch the §17 backfill up,
  // and arm the §16 retention sweep — ALL of it before the reaper below and long before the socket
  // exists, because §13's recovery must have finished before any client can ask this daemon about a
  // session. A store that will not open costs runtime routing and NOTHING else: `runtimeState`
  // carries `{ unavailable }`, the failure is logged, and boot continues (nothing else in the
  // daemon depends on the spine in 8a). See `runtime-state/wiring.ts` for the whole sequence.
  const runtimeState = await startRuntimeState({
    home: normaHome,
    store,
    settings: () => settings, // LIVE holder, re-read per sweep — never a boot snapshot
    log: (line) => console.error(`runtime-state: ${line}`),
  });
  const runtime = runtimeStateOnline(runtimeState);

  // session-activity-hygiene T6 (spec §2): the empty-session reaper's boot sweep — once, here,
  // right after store/hub exist and before anything can attach to anything. Catches sessions left
  // empty by a previous run that never triggered another `session.create` (that sweep only fires at
  // the NEXT mint) — without this, a daemon that's never asked to create a session again would keep
  // an old empty one forever. Synchronous (nothing is replying at boot to protect) and wrapped in
  // its own try/catch anyway (the same caution this file already gives other best-effort boot steps,
  // e.g. the settings load above) even though `reapEmptySessions` is designed to never throw.
  //
  // P8a Task 12: `onDelete` takes the reaped session's runtime state with it (WS-16 §16). Undefined
  // when the spine could not be opened — there are no runtime rows to remove in that case.
  try {
    reapEmptySessions({ store, attachedCount: (id) => hub.attachedCount(id), home: dirs.home, onDelete: runtime?.onSessionDeleted });
  } catch (err) {
    console.error(`empty-session boot sweep failed: ${(err as Error).message}`);
  }

  const trustStore = new TrustStore(join(normaHome, "trust.json"));
  // Task 7 (CC project-folder-mechanics): the ONE cwd-keyed "effective settings" resolver for the
  // whole daemon — `base` reads the reassignable `settings` holder above LIVE (same hot-settings
  // shape as memoryEnabledHot/hooksEnabledHot below: a watcher-driven reload swaps in a NEW object
  // in place, and this thunk re-reads that same binding on its NEXT call, never a boot snapshot).
  // Constructed here — after both `trustStore` and the initial `settings` load exist, before
  // anything that needs it — so it's reachable from every getter below that wants a per-project
  // view of settings.json (today: the `permissionRules`/`dangerousDomainsAdded` getters further
  // down; later tasks convert more getters against this SAME instance, never a second one, so
  // there is exactly one mtime cache per project cwd for the whole daemon).
  const projectSettings = new ProjectSettingsResolver({ base: () => settings, trust: trustStore });
  // fix-wave B (I1): every per-project getter below resolves at the REPO ROOT, matching
  // `globalAllow`'s own `projectRoot` (engine.ts's `repoRootFor(cwd)`) — NOT the raw session cwd.
  // Before this, a SUBDIRECTORY session read a DIFFERENT `.norma/settings.json` than
  // `globalAllow`/`editPathRules` did for the identical repo, so a repo-root settings.json was only
  // half-honored: `permissions.allow` picked it up, but `dangerousDomains.added` (and
  // reviewer/toolSearch/hooks/lsp) silently didn't — same-file keys diverging on which cwd they're
  // even resolved against was never intended, and it made a project-configured dangerous domain
  // fail-OPEN (card-less) for any subdir session. `repoRootFor` is memoized per canon(cwd) (a git
  // spawn only on first sight of a dir) and falls back to the dir itself outside a git repo, so
  // this is perf-neutral and a non-repo cwd behaves exactly as before.
  const projectRootOf = (cwd?: string | null): string | null => (cwd ? repoRootFor(cwd) : null);
  // Critical 1 fix, whole-branch review (2026-07-28): the user-added half of the effective
  // dangerous-domain list, SAME live-settings shape engine.ts's own EngineConfig.dangerousDomainsAdded
  // getter (below) already used for web_fetch's approval-card floor — hoisted into ONE shared const
  // here so ReadPage's/the research runner's/Search's NEW hard-block/withhold logic (this task) reads
  // the IDENTICAL effective list that floor does, never a second independently-maintained getter.
  const dangerousDomainsAdded = (cwd?: string): string[] | undefined =>
    projectSettings.effective(projectRootOf(cwd))?.permissions?.dangerousDomains?.added;
  // B2 Task 2: the panel command channel's pending-command registry (`panel/commands.ts`). Built
  // unconditionally, the same reasoning as `hardware` further down — driving the user's panel has
  // nothing to do with whether an LLM provider is configured, and a `panel.commandResult` can arrive
  // on any daemon. `emit` is `hub.broadcastTransient`, NOT `providerLink.push`: unlike a hardware
  // verb (aimed at the one provider connection), a panel command belongs to a SESSION and goes to
  // whoever is attached to it — which is precisely why first-result-per-commandId dedup is needed.
  //
  // B2 Task 4 HOISTED it here, from just below the `if (agentProvider)` block to just above it. Its
  // only dependency is `hub` (constructed far above), and the browser tool — registered inside that
  // block — must dispatch into the SAME registry the `panel.commandResult` handler resolves against,
  // or every command would time out against an empty map.
  const panelCommands = new PanelCommandRegistry({
    emit: (event) => { hub.broadcastTransient(event.sessionId, event); },
  });
  // Output styles (CC-parity phase 2, Task 4): per-project effective outputStyle, repo-root-keyed
  // via the SAME projectRootOf as every other getter here — a trusted project's `.norma/settings.json`
  // outputStyle applies; an untrusted project's is ignored (ProjectSettingsResolver.effective()'s own
  // trust gate). Resolution itself (name -> ResolvedStyle, incl. the slug-guard against a
  // project-supplied name escaping the output-styles dir) lives in OutputStyleStore.resolve — this is
  // just the name lookup.
  const outputStyleStore = new OutputStyleStore({ normaHome, trust: trustStore });
  const outputStyleFor = (cwd?: string | null): string | undefined => projectSettings.effective(projectRootOf(cwd ?? null))?.outputStyle;
  // CC-parity phase 3 (Workflows, Track C Task C2): built unconditionally, same "no engine
  // dependency" precedent as `outputStyleStore` just above — workflow.list's "saved" section and
  // workflow.run's by-name resolution work even on a no-agentProvider daemon (only launching a
  // resolved/inline script needs the WorkflowRuntime below, which DOES require an engine).
  const workflowStore = new WorkflowStore({ normaHome, trust: trustStore });
  const pluginStore = new PluginStore({
    normaHome, plugins: settings?.plugins, consents: settings?.plugins?.consents, log: (m) => console.error(m),
  });
  // Built unconditionally (Phase 4b Task 4): shortcut.register/tile.update/provider.register are
  // plain latest-per-plugin storage, independent of whether an LLM provider (and thus a
  // ToolRegistry/PluginSupervisor) exists — a plugin process started outside the supervisor (e.g.
  // manually, for development) can still register contributions over a plain plugin-role hello.
  const pluginContrib = new PluginContribRegistry();
  // Plugin hooks runtime (Phase 4f Task 2): the registry itself is built unconditionally, same
  // precedent as `pluginContrib` above — it's cheap in-memory state, independent of whether an LLM
  // provider is configured. Rebuilt below (once `allPlugins` exists) at boot, and again by
  // ipc/server.ts's plugin.enable/disable/remove/setConsent handlers via the SAME instance (passed
  // through startIpcServer's opts) — mirroring how `contributes.mcpServers` attaches at scan time,
  // but ALSO hot-rebuilt on lifecycle changes (unlike MCP servers today), matching Tier-2's
  // hotApplyStart/hotApplyStop precedent for "no restart needed" plugin changes.
  const hookRegistry = new HookRegistry();
  const skillStore = new SkillStore({ normaHome, trust: trustStore, plugins: { disabled: settings?.plugins?.disabled ?? [] } });
  // File-based memory (MEMDIR, T1 — design doc `2026-07-15-file-based-memory-design.md`): a live
  // getter over the `settings` holder (assigned above; reassigned in place by the hot-settings
  // watcher below), read fresh by BOTH the write-root join (`sessionDirs`, just below) and the
  // assembler's injection — a `memory.enabled`/`memory.directory` edit applies to the session's
  // NEXT tool call / turn, no daemon restart, same shape as `hooksEnabledHot` further down.
  const memoryEnabledHot = (): boolean => (settings ? memoryEnabledFrom(settings) : true);
  // session-activity-hygiene T7 (spec §3): the session cleaner's own switch, on exactly the
  // `memoryEnabledHot` terms one line up — a live getter over the reassignable `settings` holder
  // (the settings watcher swaps a NEW object into that same binding), so a `cleaner.enabled` edit
  // takes effect on the very next cleaner pass with no daemon restart in either direction. Read
  // inside `SessionCleaner.runPass`, first thing, every pass.
  const cleanerEnabledHot = (): boolean => (settings ? cleanerEnabledFrom(settings) : true);
  // `relocatedKey` is P8b-17's live half: if WS-16 §17 phase 5 has relocated this project's tree to
  // the compatibility key, this is what finds it — the same fact the session's runtime record
  // carries, reachable from a bare cwd (memory-dir.ts's own doc). Read through the `runtime` handle
  // on every call, never snapshotted: flipping `runtimes.migrations.memoryKeys` on a RUNNING daemon
  // moves the trees, and the next memory read has to follow them. Absent (no runtime store, or
  // nothing relocated) leaves the derivation exactly as it was.
  const memoryDirOf = (cwd: string): string =>
    memoryDirFor(cwd, { normaHome, directory: settings?.memory?.directory, relocatedKey: (k) => runtime?.relocatedMemoryKey(k) });
  const memoryGlobalDirOf = (): string => globalMemoryDirFor({ normaHome, directory: settings?.memory?.directory });
  const assembler = new ContextAssembler({
    normaHome, trust: trustStore, skills: skillStore,
    memory: {
      enabled: memoryEnabledHot,
      dirFor: memoryDirOf,
      // Dreaming (Phase 7b): the reserved `_assistant` bucket — deliberately NOT run through
      // `settings?.memory?.directory` (unlike `memoryDirOf`/`memoryGlobalDirOf` above): honoring
      // the relocation override would collapse this bucket into the project bucket and leak dream
      // memories into code sessions (see assistantMemoryDirFor's own doc comment).
      assistantDir: () => assistantMemoryDirFor({ normaHome }),
    },
    // Output styles (CC-parity phase 2, Task 4): main-conversation only — assemble() itself skips
    // this resolver under a basePromptOverride (dispatch coordinators/subagents keep their own base;
    // see context.ts's assemble()), so wiring it here — and NOT into the :514 AgentStore's
    // baseInstructions (a separate, subagent-only object) — is what keeps styles out of subagents.
    styleResolver: (cwd: string | null) => {
      const name = outputStyleFor(cwd);
      if (!name || name === "default") return null;
      const s = outputStyleStore.resolve(name, cwd);
      if (!s) { console.error(`output-style: unknown style "${name}" — using default`); return null; }
      return s;
    },
  });
  // T2 (design doc "migration importer"): one-time-per-fact, idempotent best-effort import of
  // Phase 5b's MemoryStore facts into MEMDIR files, run at boot whenever memory.enabled's
  // BOOT-TIME value (not hot — this ONE call runs once, here, not re-checked per turn like
  // `memoryEnabledHot` above) is on. Never touches/deletes the old store (see
  // memory-migrate.ts's own doc comment) — a later `memory.enabled: false` still finds the
  // original data untouched. Failure is logged, never fatal to daemon boot (same "degrade, don't
  // crash" precedent as the settings-load try/catch above). T3 (task-23) added a SECOND,
  // hot-triggered call site for the SAME idempotent importer — see `makeApply`'s `migrateMemory`
  // dep below (wired further down, near the `if (agentProvider)` block's settings-watcher setup)
  // — so a mid-session `memory.enabled` false→true flip no longer waits for a restart either.
  if (memoryEnabledHot()) {
    try {
      migrateMemoryStore({ normaHome, trust: trustStore, directory: settings?.memory?.directory, relocatedKey: (k) => runtime?.relocatedMemoryKey(k) });
    } catch (err) {
      console.error(`memory migration skipped: ${(err as Error).message}`);
    }
  }
  // Phase 5b Task 2: ONE MemoryStore for the whole daemon (fact-file CRUD is the single-writer
  // contract §4.8 requires — daemon RPCs (ipc/server.ts's memory.*) must share this exact
  // instance, never open a second one). Built unconditionally, same "needs only normaHome/trust,
  // no provider" precedent as skillStore/assembler just above — a provider-disabled daemon (or a
  // future read-only RPC) can still serve memory state.
  //
  // T1 (file-based memory) supersedes this store's TOOL surface (memory_read/write/delete are
  // deleted — see agent/tools/memory.ts's removal) and, whenever `memory.enabled` (above) is on,
  // the assembler's OWN injection of this store's data (context.ts's legacy branch, which reads
  // these exact `<normaHome>/memory/MEMORY.md` / `<cwd>/.norma/memory/MEMORY.md` paths, is skipped
  // in favor of the new per-project MEMDIR). T2 rewires the memory.* RPCs (below, `memoryFiles`)
  // to read/write MEMDIR files whenever `memory.enabled` is on, falling back to THIS store
  // unchanged when it's off — the store instance itself and its on-disk data stay untouched
  // either way (the escape hatch, and the migration importer's source, both need it intact).
  const memoryStore = new MemoryStore({ normaHome, trust: trustStore });
  // Built unconditionally (needs only store, no provider) so the server's session.addDir /
  // setCwd handlers always have live roots to work with, even when the agent is disabled.
  const sessionDirs = new SessionDirectories((sid) => {
    const m = store.meta(sid);
    // working-directories T5 (spec §1: "the engine's writableRoots derives from the row"): the
    // session's own working directories come from the `dirs` column, not from the single `cwd`
    // column. For every row that has never been written this is byte-identical — T1's lazy
    // migration derives `[{path: cwd, locked: true}]` from that same column, verbatim — so this
    // list is unchanged for every pre-branch session while picker/RPC/dirGrant-adopted dirs now
    // reach the fence (and survive a daemon restart, which `SessionDirectories.added` never did).
    // `primary` keeps the `cwd` column FIRST when it has one: it is what `enter_worktree`/
    // `session.setCwd` move, and the turn already runs there. A workdir-less session that has
    // adopted a primary has no cwd column yet, hence the `dirs[0]` fallback — the SAME precedence
    // engine.ts's `primaryDir` uses.
    const row = store.dirs(sid);
    const primary = m.cwd ?? row[0]?.path ?? null;
    const roots: string[] = [];
    if (primary) roots.push(primary);
    // I-2 fix (whole-branch review): realpath-or-SKIP each row entry — mirrors the SAME idiom
    // engine.ts's `writableRoots` Edit-dirs loop already documents and uses. `SessionDirectories`'s
    // own `canon()` falls back to the RAW path on a realpath failure rather than dropping it (that
    // fallback is deliberate and pinned elsewhere — it's what lets `remove()` still find a since-
    // deleted added dir), so an unguarded push here reaches bash.ts's `roots.map(realpathSync)` and
    // ENOENT-crashes EVERY bash call in the session the moment one row entry doesn't exist yet (an
    // RPC/TUI/`session.setDirs` door can add a path without mkdir'ing it — only the dirGrant door
    // does). Skipping costs nothing: `roots(sid)` recomputes on every call, so a skipped entry
    // re-enters the fence the instant the directory is actually created.
    for (const d of row) {
      try { roots.push(realpathSync(d.path)); } catch { /* not yet on disk — skip, never widen with a missing root */ }
    }
    // Everything below is keyed off the PRIMARY: the project-local permission dirs are
    // project-scoped, so a session with no primary at all (workdir-less) simply has none of them.
    // The outputs dir (further down) is NOT project-scoped and is folded in regardless — that is
    // what keeps a workdir-less session writable in its own delivery folder. The MEMDIR is ALSO
    // folded in for a workdir-less session (working-directories T6, spec §2: "MEMDIR for
    // workdir-less sessions: the shared `_assistant` bucket") — `assistantMemoryDirFor` is the ONE
    // spelling of that path (the ContextAssembler's own assistant-mode branch and the Dreamer share
    // it), gated on the SAME `memoryEnabledHot()` the with-dirs branch below reads.
    //
    // Ordering is deliberately OUTDIR-FIRST here, the reverse of the with-dirs branch further down
    // (MEMDIR then OUTDIR): T5 pinned `$OUTDIR` as `roots[0]` for a primary-less session (a
    // workdir-less relative fs-tool path resolves there — engine.test.ts's own "never the daemon's
    // cwd" pin) BEFORE this MEMDIR fold existed, and that pin must survive memory being enabled.
    if (!primary) {
      roots.push(ensureOutdir(normaHome, sid));
      if (memoryEnabledHot()) {
        const memDir = assistantMemoryDirFor({ normaHome });
        mkdirSync(memDir, { recursive: true });
        roots.push(memDir);
      }
      return roots;
    }
    roots.push(...loadPermissionDirs(normaHome, primary, trustStore.isTrusted(primary)));
    // T1 write-root join (design doc: "the tmpDir pattern" — a plain, ungated, auto-provisioned
    // root, mirroring how `sessionTmpDir` needs no user approval either): whenever file-based
    // memory is enabled, the session's MEMDIR joins the SAME write-fence `roots` the `write`/`edit`
    // tools (fs-write.ts) and bash's OS-sandbox writable set (bash.ts) already resolve against —
    // no new fencing mechanism, just one more entry in the list every other grant here (permission
    // dirs, an out-of-root write/edit grant, `enter_worktree`) already goes through. `roots(sid)` is
    // SESSION-scoped (not per-thread): an isolated worktree child gets `rootsOverride` instead,
    // which REPLACES this list wholesale (engine.ts), so it never sees MEMDIR — but a plain
    // (non-isolated) child thread shares the session's roots exactly as it already shares every
    // other grant here; there is no thread-scoped write-fence in this codebase to exclude it
    // further without a broader refactor (see task-21-report.md's "concerns" for this nuance).
    // mkdir here (not inside `memoryDirFor`, which stays a pure path computation for easy unit
    // testing) is the SAME "create on demand, every call, idempotent" precedent session-tmp.ts's
    // `sessionTmpDir` already sets — cheap relative to the git spawn `memoryDirFor` itself already
    // memoizes.
    if (memoryEnabledHot()) {
      // T5: keyed off `primary`, not `m.cwd` — identical for every session that has a cwd column,
      // and the only sane key for one that reached its primary by adopting a dir. (Spec §2 gives a
      // workdir-less session the shared `_assistant` bucket instead; that is T6's own task.)
      const memDir = memoryDirOf(primary);
      mkdirSync(memDir, { recursive: true });
      roots.push(memDir);
    }
    // working-directories T4: the session's own delivery folder — `<normaHome>/outputs/<sid>` —
    // joins the SAME write-fence roots the MEMDIR just above does, and by the identical mechanism:
    // one more entry in this session-scoped list, no new fencing/grant machinery. Unlike the MEMDIR
    // this is NOT gated on a settings flag — the outputs dir is a core primitive, always available.
    // Keyed by `sid` (this closure's own parameter, never a bare `~/.norma/outputs/` prefix), which
    // is exactly what keeps ANOTHER session's outputs dir OUT of this list — `grantDeniedPrefixes:
    // [normaHome]` (below) still refuses it for every session but this one.
    roots.push(ensureOutdir(normaHome, sid));
    return roots;
  });

  // Built unconditionally (needs only store/sessionDirs, no provider) so background tasks
  // spawned before the agent is enabled (or during tests without a provider) still have a
  // registry to land in; the bg.* IPC handlers work regardless of agentProvider.
  const bgRegistry = new BackgroundTaskRegistry({
    emit: (sid, e) => hub.append(sid, e),
    spawnCtx: (sid) => {
      const m = store.meta(sid);
      // working-directories T5: a workdir-less session (no cwd column, empty dirs row) can now run
      // turns — its shell starts in the session tmp dir (scratch by default; deliverables are
      // deliberate copies into $OUTDIR), the SAME fallback the engine gives a foreground turn and
      // `bash.ts` itself keeps as a defensive last resort. Before this, `m.cwd!` handed a `null`
      // straight to `realpathSync` in the bash tool.
      const dirs0 = store.dirs(sid)[0]?.path;
      return { cwd: m.cwd ?? dirs0 ?? sessionTmpDir(sid), roots: sessionDirs.roots(sid), tmpDir: sessionTmpDir(sid) };
    },
  });

  // Unconditional (not gated on agentProvider): tool-call approvals need it only when the agent
  // is enabled, but peripheral lease acquisition (below) follows the SAME approval-broker
  // machinery under `ask` policy regardless of whether an LLM provider is configured — leasing is
  // an independent feature (spec §A1). An unused, empty broker behaves identically to the
  // previous `null` for approval.respond (nothing pending either way).
  const approvalBroker = new ApprovalBroker();

  // Hotfix (credential material, P8b): boot-time, idempotent, one-way — promotes the legacy raw
  // openai-api-key / codex-access-token(+4) records into the JSON material records the spawned
  // Winter child actually reads (auth/credential-material.ts). Unconditional and BEFORE
  // createProvider below (even when `settings` is absent, and regardless of whether
  // `opts.agentProvider` was injected) — this `secrets` store is the daemon's own real one
  // (`KeychainSecretStore` in production, whatever a test injected) every time this function
  // boots, so there is never a reason to skip it. Never throws (see the module's own doc comment);
  // status words only in the log line, never a value.
  const credentialMigration = await migrateLegacyCredentialMaterial(secrets);
  console.log(`credentials: openai ${credentialMigration.openai}, codex-oauth ${credentialMigration.codexOauth}`);

  let agentProvider = opts.agentProvider;
  let quota: QuotaManager | undefined;
  if (agentProvider === undefined) {
    if (settings) {
      try {
        const active = await createProvider(settings, secrets, dirs.settingsPath);
        // `model` here is the RESOLVED (not raw) boot selection — active.model is the raw
        // settings.json value, which for codex-oauth may be a since-deprecated slug (e.g.
        // "gpt-5.4"). Everything that consumes this snapshot directly rather than calling `live`
        // per-turn (Compactor's own summarization turn, BashReviewer, SessionTitler, the
        // daemon-status `providerInfo` below) needs a model the backend will actually accept, so
        // resolve once here via the SAME deprecation-fallback path `live` uses on every turn.
        // `live` itself is still wired separately below (EngineConfig.provider.live) so turns
        // keep re-resolving on every call, not just at this boot snapshot.
        agentProvider = { provider: active.provider, model: active.liveModel().model, live: active.liveModel };
        quota = active.quota;
      } catch (err) {
        console.error(`agent disabled: ${(err as Error).message}`);
        agentProvider = null;
      }
    } else {
      agentProvider = null;
    }
  }
  // Test-injected / disabled-agent paths never went through createProvider() (so never got a
  // real QuotaManager wrapping the provider) — quota.state() still needs SOMETHING to read, so
  // fall back to an inert manager that just reports the zero/ok defaults.
  quota ??= new QuotaManager();

  // SP-approvals Task 5: hoisted alongside `engine` — same "declared null/undefined above, assigned
  // inside the gate" shape as `dreamer`/`mcp`/etc below. PermissionRules itself needs no provider
  // (only settings + normaHome), but has always been constructed inside the `if (agentProvider)`
  // gate next to the engine that consumes it (see the assignment site's own doc comment); declared
  // here so it's reachable AFTER the gate closes, where startIpcServer's opts (below) share this
  // SAME instance with the engine's own ask-policy rule-consult path — one mtime cache, not two
  // independently-stale copies.
  let permissionRules: PermissionRules | undefined;
  // Dreaming (Phase 7b): constructed AFTER `engine` (its `activeTurnCount` thunk closes over it —
  // see the construction site inside `if (agentProvider)` below), and only there — a no-provider
  // daemon has no dispatch turns to dream about. Declared here (function scope, outside the gate)
  // so `stop()` past the gate's close can still stop() it regardless of agentProvider, same
  // "declared null/undefined above, assigned inside the gate" shape as `mcp`/`lspManager` below.
  let dreamer: Dreamer | undefined;
  let mcp: McpManager | null = null;
  let lspManager: LspManager | null = null;
  // CC-parity phase 3 (Workflows, Track C Task C2): constructed inside the `if (agentProvider)`
  // gate below (B2 — spawnAgent needs a live engine), reassigned onto this OUTER binding so
  // startIpcServer's opts (built past the gate's close) can wire it — same "declared null above,
  // assigned inside the gate" shape as `mcp`/`lspManager` just above.
  let workflowRuntime: WorkflowRuntime | null = null;
  // hot-settings T5b: reassigned inside the `if (agentProvider)` gate below (built only when the
  // engine/registry exist to hot-apply against); declared here (function scope, outside the gate)
  // so the shutdown path past the gate's close can still stop() it regardless of agentProvider.
  let settingsWatcher: SettingsWatcher | null = null;
  // P8b Task 16 HOISTED this out of the `if (agentProvider)` gate (it used to be built beside
  // `taskStore` inside it): the Winter leg's question bridge (`AskUserQuestion` → `question_asked`)
  // needs a broker whether or not an engine exists, and `ask_user.respond` must resolve into the
  // SAME instance. Wire-identical on a no-provider daemon: `respond()` on a broker with nothing
  // pending answers `{ ok: true, alreadyResolved: true }`, which is exactly the handler's old
  // no-broker fallback.
  const questions = new QuestionBroker();
  // ipc/server.ts (Phase 4b Task 4) needs the SAME ToolRegistry instance the engine executes tool
  // calls against, to register/unregister `plugin__<id>__<tool>` tools — but startIpcServer() is
  // called OUTSIDE the `if (agentProvider)` block below, where the registry is constructed.
  // Mirrored into this outer binding right after construction rather than hoisting the `const`
  // itself, so every existing narrowed (non-null) use of `registry` inside the block is untouched.
  let sharedRegistry: ToolRegistry | null = null;

  // P8b Task 6: HOISTED out of the `if (agentProvider)` gate below (its construction stays there,
  // unchanged). The `computer` capability server's getter reads THIS holder — one
  // `ComputerUseService`, one lease set, whichever door drives it — and `settings-apply.ts`
  // reassigns the same binding on a hot `computerUse.enabled` toggle.
  let computerUse: ComputerUseService | undefined;

  // P8b Task 7: HOISTED for the same reason `computerUse` is — the `research` capability server is
  // built above the `if (agentProvider)` gate and must hand `ReadPage` the SAME `PageCache` the
  // registry door and the ephemeral research runner share (a second cache would make a report's own
  // citations miss on the follow-up read). `PageCache` has no dependencies, so the construction
  // itself moves; the runner still needs `agentProvider.provider` and so stays a holder assigned
  // inside the gate, read through a closure at tool-call time.
  const pageCache = new PageCache();
  let researchRunner: ResearchRunner | undefined;

  // Phase 4d-cleanup Task 2: PluginSupervisor construction + the boot-time orphan-PID sweep are
  // hoisted OUT of `if (agentProvider)` below — the ctor's own deps (runDir/socketPath/mintToken/
  // settings/logger) don't need a provider, and a daemon booted with the agent disabled (no
  // provider configured, or a test that injects `agentProvider: null`) should still reclaim/clean
  // up stale <runDir>/plugins/<id>.pid files left by a PREVIOUS run instead of leaving them
  // orphaned indefinitely — until, if ever, a provider happens to become configured. `startAll(...)`
  // — the part that actually spawns spawn-eligible plugins as live agent tools — STAYS inside the
  // gate below (a plugin process spawned with no engine/registry to bridge its tools into would be
  // pointless). `onCircuitOpen` closes over the OUTER `sharedRegistry` binding (not the gate-local
  // `registry` const, which isn't in scope here) so it keeps behaving correctly either way — a safe
  // no-op via optional chaining while `sharedRegistry` is still null (no provider).
  const allPlugins = pluginStore.list();
  // Boot-time hook-registry build (Phase 4f Task 2) — the SAME eligible-plugin projection
  // (`hookRegistryPlugins`, agent/plugins.ts) ipc/server.ts's lifecycle RPCs use to rebuild this
  // SAME `hookRegistry` instance hot, later, off a fresh `livePlugins()` read.
  hookRegistry.rebuild(hookRegistryPlugins(allPlugins, normaHome));
  const pluginSupervisor = new PluginSupervisor({
    runDir: dirs.runDir,
    socketPath: dirs.socketPath,
    mintToken: (id) => store.mintPluginToken(id),
    settings: settings?.plugins?.supervisor,
    onLog: (m) => console.error(m),
    onCircuitOpen: (id) => sharedRegistry?.unregisterByPrefix(`plugin__${id}__`),
  });
  const spawnablePlugins = allPlugins
    .filter(pluginSpawnEligible)
    .map((p) => ({ id: p.name, dir: join(normaHome, "plugins", p.name), entry: p.entry! }));
  // Phase 4d-i Task 4: boot-time orphan-PID sweep, BEFORE startAll spawns the current set — a
  // plugin disabled or removed since the last run may have left its process running under a
  // stale <runDir>/plugins/<id>.pid; startAll/reclaimOrphans would never find it (they only look
  // at PID files for plugins in `spawnablePlugins`), so this sweeps the FULL PID-file directory
  // and cleans up anything not in the currently spawn-eligible set (verified via the same
  // ps-lstart identity check, fail-safe no-kill on any mismatch — see sweepOrphans's doc comment).
  // Runs regardless of agentProvider (see this block's own doc comment above).
  pluginSupervisor.sweepOrphans(spawnablePlugins.map((p) => p.id));

  // Hoisted above the `if (agentProvider)` gate (4g Task 5) — registerWebTools below needs it, and
  // tool registration happens inside that gate. Built unconditionally regardless (same precedent as
  // `peripheral`/`hardware` further down, which share this SAME instance): normaHome is ready at
  // line 135, and AuditLog's own constructor is cheap (mkdir is lazy, on first write — see audit.ts).
  const audit = new AuditLog(join(normaHome, "audit.jsonl"));

  // Peripheral lease v1 (Phase 2f) — HOISTED above the `if (agentProvider)` gate (phase 5 CU): the
  // ComputerUseService (built inside the gate) needs this broker to lease screenshot/ax-read/input-
  // drive in-process, and the `computer` tool is registered inside the gate. Construction only needs
  // audit/store/approvalBroker/hub, all ready above — same "build unconditionally, leasing is
  // independent of an LLM provider" rationale it had further down. `hardware` (which shares this
  // SAME providerLink) stays below; it only references providerLink, which is now in scope earlier.
  const providerLink = new ProviderLink();
  const peripheral = new PeripheralBroker({
    audit,
    heartbeatMs: settings?.peripheral?.heartbeatMs,
    expiryMs: settings?.peripheral?.expiryMs,
    policy: buildLeasePolicy({ store, approvals: approvalBroker, hub }),
    // lease_granted/lease_lost are emitted on the REQUESTER's session (broadcastTransient scopes
    // fan-out to that session's attached harnesses), but the provider connection (Norma.app) is
    // rarely attached to the requesting session — it needs its own copy of these two event types
    // to track its active-lease set regardless of what it's attached to. peripheral_call_requested
    // already reaches the provider via pushToProvider; lease_granted/lease_lost did not, which
    // would have left the provider's lease-tracking silently blind whenever it wasn't attached to
    // the leasing session. Pushed in addition to (not instead of) the session broadcast.
    emitTransient: (sessionId, event) => {
      hub.broadcastTransient(sessionId, event);
      if (event.type === "lease_granted" || event.type === "lease_lost") providerLink.push(event);
    },
    pushToProvider: (event) => providerLink.push(event),
  });
  // Phase 5 routines T3: hoisted above the `if (agentProvider)` gate for the SAME reason as `audit`
  // just above — the `schedule` tool (registered inside that gate, alongside every other built-in
  // tool) needs the store, but the rest of the routines subsystem (audit log/runner/scheduler,
  // below, past the gate's closing brace) needs `engine`, which isn't settled until the gate
  // closes. Splitting the construction this way means there is still only ONE RoutineStore
  // instance for the whole daemon (no risk of the tool and the scheduler racing on two separate
  // sqlite handles to the same file) — see the "Scheduled routines" block below, which reuses this
  // SAME `routineStore` rather than calling `openRoutineStore` a second time.
  const routineStore = openRoutineStore(join(normaHome, "routines.db"));

  // ── The Winter runtime handle (P8b Task 5) ────────────────────────────────────────────────────
  // THE ONE `createRuntimeSdk` for this daemon. It slots here because it needs everything above it
  // — the settings holder (its retention and advisor options are settings-derived), the secrets
  // store (the keychain seam) and the runtime spine's directory store — and because the capability
  // servers that will fill `capabilities` (Tasks 6-7) are built in the block below.
  //
  // A ROUTER THAT CANNOT CONSTRUCT NEVER STOPS THE DAEMON. `createRuntimeSdk` throws typed refusals
  // for a peer-version mismatch, an invalid brand and a malformed capability declaration (surface
  // map §1.10) — every one of them a packaging fault, not a user fault. In this task the engine
  // still serves every mode, so the cost of an undefined handle is the Winter leg alone: a session
  // created on it refuses with a typed error at create. Only the error's CODE/class is logged; the
  // message can carry paths and option contents.
  //
  // `directoryStore` is 8a's SQLite store when the spine opened, and undefined when it did not — in
  // which case the router falls back to its own in-memory directory: messaging works for this
  // process's lifetime, receipts are not durable. That is the same "runtime routing degraded, boot
  // continues" posture the spine itself takes.
  let runtimeSdk: NormaRuntimeSdk | undefined;
  // ── The daemon-owned capability servers (P8b Tasks 6-7, R-8-1, P8b-36) ────────────────────────
  // The router owns no tool; the DAEMON owns the capability tools. This bundle is the daemon-wide
  // HALF of that wiring — the instances, stores and closures the tools need, built once and shared —
  // and `buildCapabilitiesFor(session, …)` turns it into ONE SESSION'S six servers. Each server
  // holds the SAME `ToolDefinition` objects the shared `ToolRegistry` below registers (one
  // implementation, two doors), so a Winter child and an engine turn run identical code with
  // identical schemas and identical refusals.
  //
  // PER SESSION, NOT PER DAEMON (P8b-36). `callTool(name, args)` carries no session identity, so an
  // instance shared across the handle would have to look one up — and a daemon-wide "currently
  // bound session" slot cross-attributes the moment two Winter sessions run turns concurrently.
  // Because `ctx.mode` comes from the same place and resolves `browser`'s read-only chat subset,
  // that is a SECURITY bug, not only an identity one. 8b is Winter-leg-only (P8b-1) and the router
  // forwards a caller's own `Options.mcpServers` straight through, so the session driver (Task 16)
  // builds this session's servers and puts them on that session's own `Options` —
  // `RuntimeSdkOptions.capabilities` stays `[]` and is reserved for the official leg.
  //
  // `computerUse`/`researchRunner` are LETs assigned inside the gate below; these are closures,
  // invoked at tool-call time long after boot (the `engine?.turnStartedAt` precedent this file
  // already relies on).
  //
  // Steering only, exactly as on the registry door (`registerSessionSpawnTool` below gets the same
  // list). A daemon with no agent provider has no model catalogue and the field is a free string.
  const spawnModelIds = agentProvider ? agentProvider.provider.models().map((m) => m.id) : [];
  const capabilityDeps: CapabilityDeps = {
    sessions: {
      models: [...spawnModelIds, ...deriveModelAliases(spawnModelIds)],
      // THE SAME instances the registry door gets (`registerListSessionsTools` below): a
      // management surface with its own hub/store would read every attached session as idle.
      sessions: {
        store,
        derive: (row, sessionId, nowMs) => activityDeriver?.(row, sessionId, nowMs),
        turnStartedAt: (sid) => winterDrivers.get(sid)?.turnStartedAt,
        isRunning: (sid) => winterDrivers.get(sid)?.turnRunning ?? false,
        interrupt: (sid) => { void winterDrivers.get(sid)?.interrupt(); },
        emit: (sid, activity) => { hub.emitActivity(sid, activity); },
      },
    },
    computer: {
      // Hot, read per call.
      screenshotMaxDim: () => settings?.computerUse?.screenshotMaxDim,
      // The SAME holder `EngineConfig.computerUse`'s getter reads, including after
      // `settings-apply.ts` rebuilds the service on a hot toggle. One service, one lease set.
      computerUse: () => computerUse,
    },
    // LIVE, not a boot snapshot: the servers are built when a session starts, so toggling computer
    // use reaches the next session with no restart and no help from Task 9's `disallowedTools`.
    computerUseEnabled: () => settings?.computerUse?.enabled === true,
    // THE SAME four closures `registerBrowserTool` gets below — `mintPanelTab` and
    // `panelCommands.dispatch` are what emit `panel_tab_opened`/`panel_tab_activated`/
    // `panel_command`, so a capability with its own would open tabs nobody can see and dispatch
    // commands `panel.commandResult` could never answer (P8b-20).
    browser: {
      browser: {
        tabs: (sid) => foldPanelTabs(store.read(sid)),
        openTab: (p) => mintPanelTab(hub, p),
        dispatch: (cmd) => panelCommands.dispatch(cmd),
        harnesses: (sid) => hub.attachedHarnesses(sid),
        dangerousDomainsAdded,
      },
    },
    // The identical trio all three office tools take. `dirsOf` is `store.dirs` — never
    // `writableRoots` — so the daemon's fence and the app-side `OfficeAgentBroker` fence agree
    // on what "this session's working directories" means.
    office: {
      office: {
        dispatch: (cmd) => panelCommands.dispatch(cmd),
        harnesses: (sid) => hub.attachedHarnesses(sid),
        dirsOf: (sid) => store.dirs(sid),
      },
    },
    // C-6: Norma's OWN web surface for chat/dispatch. `secret` is a CLOSURE — the Exa key is
    // read inside `run`, never here and never into `listTools()`. `dangerousDomainsAdded` is
    // the same shared getter every other consumer takes, so the floor is one list.
    research: {
      search: { audit: (line) => audit.append(line), secret: (name) => secrets.get(name), dangerousDomainsAdded },
      readPage: {
        cache: pageCache,
        audit: (line) => audit.append(line),
        // The runner is assigned inside the agent gate; read LIVE at call time, exactly as
        // `ReadPage`'s own "research is not available in this session yet" fallback expects.
        get research() { return researchRunner; },
        dangerousDomainsAdded,
      },
    },
    // P8b-33: code's web surface, for the same reason `research` exists for chat — the SDK's
    // built-in WebSearch/WebFetch are disallowed in every mode in 8b. Same `audit`/`secrets`
    // instances the registry door takes; the Brave key is read inside `run`.
    web: { web: { audit: (line) => audit.append(line), secret: (name) => secrets.get(name) } },
    // Fix wave (review F7): the `lsp` tool over the SAME `let lspManager` holder the registry
    // door and `settings-apply.ts`'s hot `lsp.enabled` flip reassign — read per call.
    lsp: { lsp: () => lspManager ?? undefined },
    // P8c integration round 2: the `external` capability server's real source
    // (`capabilities/external.ts`'s own header names the design). `sharedRegistry` is the SAME
    // `ToolRegistry` `tool.register` (ipc/server.ts) writes `plugin__<pluginId>__<name>` rows into
    // — read live per session build, never a boot snapshot (a plugin registering mid-daemon-life
    // reaches the NEXT session built, matching every other capability's "session keeps what it
    // started with" contract). `null` (no agent provider) reads as zero tools, same as every other
    // capability closure over `sharedRegistry`/`lspManager` in this object.
    external: {
      tools: (session) => {
        if (!sharedRegistry) return [];
        return sharedRegistry.listByPrefix("plugin__").flatMap((spec) => {
          const parsed = pluginToolNameParts(spec.name);
          if (!parsed) return [];
          return [{
            pluginId: parsed.pluginId,
            name: parsed.name,
            description: spec.description,
            ...(spec.parameters === undefined ? {} : { parameters: spec.parameters as Record<string, unknown> }),
            async invoke(argsJson: string) {
              const args = JSON.parse(argsJson) as Record<string, unknown>;
              const outcome = await sharedRegistry!.execute(spec.name, args, {
                cwd: session.cwd, roots: session.roots, sessionId: session.sessionId,
                tmpDir: session.tmpDir, outDir: session.outDir, mode: session.mode,
              });
              return outcome.isError ? { ok: false as const, message: outcome.output } : { ok: true as const, resultJson: outcome.output };
            },
          }];
        });
      },
    },
  };
  /** THE door Task 16's session driver opens: one session in, its servers out — already keyed by
   *  name, i.e. already in `Options.mcpServers` shape (the child derives each tool's wire name from
   *  that key, so the keying must not be the driver's to get wrong). */
  const buildSessionCapabilities = (session: CapabilitySession): CapabilityServerRecord =>
    buildCapabilitiesFor(session, capabilityDeps);
  try {
    runtimeSdk = await createNormaRuntimeSdk({
      home: normaHome,
      settings: () => settings, // LIVE holder, never a boot snapshot
      secrets,
      directoryStore: runtime?.directory,
      // EMPTY ON PURPOSE (P8b-36) — this list is handle-wide and construction-time, which is
      // exactly what a per-session capability set must not be. Norma's capability servers ride each
      // session's own `Options.mcpServers` instead (`buildSessionCapabilities` above). The field is
      // reserved for the official leg, which has no host in 8b.
      capabilities: [],
      // Task 12's seam, filled by Task 16: the inbound class of a session this process holds no
      // live facet for — a parked (`resumable`) Winter session answers `unavailable` instead of
      // holding its mail forever, and is never cold-resumed behind the daemon's back.
      sessionPermissionClass: sessionPermissionClassFor({ records: () => runtime?.records, store }),
      // P8d-8 (D30): the OFFICIAL leg's ONE reviewer resolver, ALWAYS wired (never conditional on
      // whether `runtimes.advisorModel` is set — `advisorReviewerFor` reads that setting live
      // itself). `sessionModel` (review fix F1) is NEVER `settings.provider.model` — that is the
      // WINTER leg's own default-provider model (openai/codex on a non-Anthropic-primary install),
      // and feeding it here silently resolved an OpenAI reviewer on a Claude-only leg.
      // `officialLegDefaultSessionModel()` states the one fact this deployment can promise instead:
      // every session on THIS leg is Claude-family (D13-2 — no other family can route here at all),
      // so the D30 default is unconditionally "claude -> fable" regardless of which session asked
      // (`advisor-reviewer.ts`'s own header records why a single daemon-wide getter cannot
      // disambiguate between concurrent official-leg sessions on different models, and why that is a
      // non-issue today for exactly this reason).
      advisorReviewer: advisorReviewerFor({
        settings: () => settings ?? undefined,
        secrets,
        familyOf: familyOfModel,
        sessionModel: officialLegDefaultSessionModel,
      }),
      log: (line) => console.error(`runtime-sdk: ${line}`),
    });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? (err as Error)?.constructor?.name ?? "unknown";
    console.error(`runtime-sdk: winter runtime sdk unavailable (${code}) — every session.create/session.dispatch will refuse typed (winter_leg_unavailable); there is no engine leg`);
    runtimeSdk = undefined;
  }

  // ── §13 step 10, run from here because the handle does not exist where the step does ──────────
  //
  // WS-15 §6.4's directory recovery — mark previously-live handles unavailable, restore cursors,
  // reconcile every CLAIMED-BUT-UNRECEIPTED delivery as `delivery_uncertain`, prune what retention
  // says is past its horizon — belongs inside `recoverRuntimeState`'s step 10, and that is where
  // its hook lives (`RecoveryHooks.recoverDirectory`, exercised by
  // `test/runtime-state/recovery-messaging.test.ts`). It cannot be supplied from THIS boot, because
  // the two constructions are circular: `startRuntimeState` (≈300 lines above) opens the directory
  // store that `createRuntimeSdk` needs, and runs §13 before it returns. Task 12 therefore runs the
  // step here — still before `startIpcServer`, so no client has been able to ask this daemon about
  // a session — and the ordering is a recorded plan conflict for the controller, not a fix invented
  // in a lane. Nothing else in boot depends on the result; a failure costs the reconciliation and
  // the daemon starts.
  if (runtimeSdk !== undefined) {
    try {
      const recovered = await runtimeSdk.sdk.directory.recover();
      // F3 (fix round 1): recovery marks a crash-left row `unavailable` but KEEPS its
      // `backendSessionId`, and the router's only refusal before a cold resume is `archived` — so
      // every session from the last boot would still be resumable from inside a delivery, by a
      // spawn this daemon never tracked. Nothing is attached at this point in boot by construction,
      // so the sweep parks them all. A Norma session is resumed by its DRIVER from the 8a record
      // (which keeps its own backend id), never by the messaging layer.
      const parked = await parkRecoveredSessions(runtimeSdk, (line) => console.error(`runtime-sdk: ${line}`));
      console.error(
        `runtime-sdk: directory recovery — ${recovered.entriesLoaded} entr(ies), ${recovered.staleMarked} stale, ` +
          `${recovered.cursorsRestored} cursor(s), ${recovered.heldMessagesFound} held, ${parked} parked`,
      );
      // P8d-11 (ruling: 8b task-12 option (b)): step 10 ran LATE by design — the router handle is
      // built after §13 — so the boot-time attempt row says `skipped`; re-stamp it with the real
      // outcome so `norma doctor` reads one honest step 10.
      if (runtime?.lastRecovery.step10AttemptId !== undefined) {
        restampStep(runtime.db.db, runtime.lastRecovery.step10AttemptId, 10, "ok", { entriesLoaded: recovered.entriesLoaded, staleMarked: recovered.staleMarked });
      }
    } catch (err) {
      console.error(`runtime-sdk: directory recovery failed (${(err as Error)?.name ?? "unknown"}) — messaging starts without it`);
      if (runtime?.lastRecovery.step10AttemptId !== undefined) {
        restampStep(runtime.db.db, runtime.lastRecovery.step10AttemptId, 10, "failed", { errorName: (err as Error)?.name ?? "unknown" });
      }
    }
  }

  // ── The Winter leg's driver table (P8b Task 16) ───────────────────────────────────────────────
  // Built HERE, after §13's recovery (`startRuntimeState` above) and the router's own directory
  // recovery + `parkRecoveredSessions` (just above): a projector is never constructed before that
  // sweep has run, and nothing below can construct one before `startIpcServer` hands a client a
  // socket. `ipc/server.ts` routes every `session.*` method through this table — every mode is
  // the Winter leg since Task 17. The drivers it starts are tracked on `runtimeSdk`
  // (`trackQuery`), so `stop()`'s `dispose()` ends them inside the shutdown budget.
  // P8b Task 17: HOISTED above the `if (agentProvider)` gate — the Winter leg's drivers (below)
  // persist their children through this roster too, on a daemon with or without an engine.
  // Async spawn (4h-ii-a): tracks DETACHED (`run_in_background:true`) child threads — see
  // bg-agent-registry.ts's own doc comment for why this is separate from `bgRegistry` above
  // (that one owns backgrounded bash processes; this one owns agent threads). Built
  // unconditionally alongside `subagents` — both are required together for the spawn bridge's
  // async branch to activate (engine.ts's EngineConfig.bgAgents doc comment).
  //
  // P8b Task 13 (C-12 / P8b-15): DURABLE when the 8a spine opened, in-memory when it did not.
  //
  // `BackgroundAgentRegistry` is one `Map`, so every daemon restart lost the whole roster — the
  // names a model was still using, which children had finished, and every `ResumeContext` that
  // made `resume` possible (WS-17 §8 row 6). 8a shipped `runtime_children` and its
  // reclassification rule and wired it to nothing; `createPersistedChildren` is that wiring, and
  // it satisfies the same `AgentRegistry` contract every consumer here already takes, so the
  // engine's spawn bridge, `task_stop`, `agent_list`/`agent_output` and the `thread.send`/
  // `agent.stop` RPCs are untouched.
  //
  // A SPINE THAT WOULD NOT OPEN FALLS BACK, never fails: children are then exactly as durable as
  // they were before this task, which is the same "runtime routing degraded, boot continues"
  // posture the spine itself takes.
  //
  // ⚠️ NO `stallTimeoutMs` HERE, DELIBERATELY (fix round 1, F1). `SubagentManager` already owns a
  // RESETTABLE progress window for every engine child, and its controller is folded into the
  // child's run signal on both spawn paths — so arming a second timer over the same children is a
  // second KILLER, not a second safety net. Worse, while nothing in production reset it, it was a
  // 600 s WALL CLOCK, which is exactly what CLAUDE.md's tool surface and the standing "subagents:
  // no timeout" rule forbid. The registry's window is opt-in (see `stallTimeoutMs`'s own note) and
  // Task 17 turns it on for Winter children when `SubagentManager` retires with the engine. The
  // engine DOES feed `progress()` here and now (engine.ts's three child sites), so the window is a
  // progress window the moment it is armed rather than an API nobody calls.
  // Task 17: the roster's progress watchdog is ARMED here — `SubagentManager` retired with the
  // engine, so this is the only window over a Winter child (progress-fed by the driver, no wall
  // clock; `settings.subagents.stallTimeoutMs` hot, undefined = 600 s, null/0 = off).
  const bgAgents: AgentRegistry | undefined =
    runtime === undefined
      ? undefined
      : createPersistedChildren({
          stallTimeoutMs: () => settings?.subagents?.stallTimeoutMs,
          store: runtime.children,
          profiles: runtime.profiles,
          providerId: () => settings?.provider?.type ?? "unstated",
          // The owning session's live facet — Task 16 attaches Winter sessions, and until then a
          // stop with no local `AbortController` is recorded and nothing is asked of the child.
          facetFor: (sessionId) => {
            // A child's `parentWinterSessionId` is NORMA's session id; the router addresses a
            // session by its BACKEND id (P8b Task 12), so the 8a record is the hop between them.
            // Nothing attaches until Task 16, so this answers `undefined` today and a stop with
            // no local controller is recorded without anything being asked of the child.
            const backend = runtime.records.get(sessionId)?.backendSessionId;
            return backend === undefined || runtimeSdk === undefined ? undefined : attachedFacetFor(runtimeSdk, backend);
          },
          log: (line) => console.error(`children: ${line}`),
        });
  // Fix wave (review row 4): session titles on the Winter leg. The titler stays on Norma's OWN
  // provider layer (P8b-10 — never `sdk.query()`), so it needs `agentProvider`; a no-provider
  // daemon simply titles nothing, as before. `titles.enabled` is read LIVE at every fire (the
  // engine-era wiring was a boot snapshot; no setting may need a restart), `titles.model` stays the
  // boot snapshot it always was (it names WHICH model titles, not whether titling is on).
  const sessionTitler = agentProvider === null ? undefined : new SessionTitler({ provider: agentProvider, store, hub, model: settings?.titles?.model });
  const titler = sessionTitler === undefined ? undefined : {
    maybeTitle: (sid: string): Promise<void> => (settings?.titles?.enabled === false ? Promise.resolve() : sessionTitler.maybeTitle(sid)),
  };
  // ── P8c integration Wiring 1: the ExitPlanMode bridge (lane 2's `plan-bridge.ts`, P8c-14) ──────
  // `winterDriversForPlanBridge` breaks the construction cycle: `planBridge` is a `WinterLegDeps`
  // field `createWinterSessionDrivers` below needs at construction, but an APPROVAL's `setPolicy`
  // reaches a LIVE child through that same `winterDrivers` table (mirrors `ipc/server.ts`'s own
  // `session.setPolicy` composition: `store.setApprovalPolicy` + `winter.get(sessionId)?.setPolicy`)
  // — so the reference is filled in right after `winterDrivers` itself is assigned, below.
  let winterDriversForPlanBridge: WinterSessionDrivers | undefined;
  const planBridgeLog = { info: (m: string) => console.error(`plan-bridge: ${m}`), error: (m: string) => console.error(`plan-bridge: ${m}`) };
  const planBridge: PlanBridge = planBridgeFor({
    emit: (event) => { hub.append(event.sessionId, event); },
    setPolicy: async (sessionId, policy) => {
      store.setApprovalPolicy(sessionId, policy);
      try {
        await winterDriversForPlanBridge?.get(sessionId)?.setPolicy(policy);
      } catch (err) {
        console.error(`plan-bridge: setPolicy for ${sessionId} failed: ${err instanceof Error ? err.name : "unknown"}`);
      }
    },
    log: planBridgeLog,
  });
  // ── P8c integration Wiring 3: the Winter/official hooks facade (lane 3's `hooks.ts`, P8c-14) ───
  // `hookRegistry`/`hooksEnabledFrom`/`lspAutoDiagnosticsEnabledFrom`/`projectRootOf` are all
  // already live above (boot + Task 9 project-settings machinery); `HookFacade`/`HookRunner`/
  // `BashReviewer` were never constructed anywhere in this file post-engine-deletion (8b) — this is
  // their first live wiring since the retired AgentEngine's own `cfg.hooks`/`reviewer`. Read LIVE
  // per call (settings hot-reload), matching every other getter in this block.
  const winterHooksEnabled = (cwd?: string | null): boolean => {
    const s = projectSettings.effective(projectRootOf(cwd));
    return s ? hooksEnabledFrom(s) : true;
  };
  const winterLspAutoDiagnosticsEnabled = (cwd?: string | null): boolean => {
    const s = projectSettings.effective(projectRootOf(cwd));
    return s ? lspAutoDiagnosticsEnabledFrom(s) : true;
  };
  const hookFacade = new HookFacade({
    registry: hookRegistry,
    runner: new HookRunner(),
    hooksEnabled: winterHooksEnabled,
    cwdForSession: (sid) => { try { return store.meta(sid).cwd ?? undefined; } catch { return undefined; } },
  });
  // The retired engine's own BashReviewer gate (engine.ts:4547-4548): `provider`/`model` are the
  // SAME shape `SessionTitler` above takes — inert without an `agentProvider` (mirrors `titler`'s
  // own `agentProvider === null` guard).
  const bashReviewer = agentProvider === null || agentProvider === undefined
    ? undefined
    : new BashReviewer({ provider: agentProvider, model: settings?.reviewer?.model });
  const hooksFor = (session: CapabilitySession) =>
    sessionHooksFor({
      sessionId: session.sessionId,
      home: normaHome,
      roots: session.roots,
      tmpDir: session.tmpDir,
      hookFacade,
      ...(bashReviewer === undefined ? {} : { reviewer: bashReviewer }),
      reviewerEnabled: () => settings?.reviewer?.enabled,
      reviewerAllow: () => settings?.reviewer?.allow,
      policy: () => { try { return store.meta(session.sessionId).approvalPolicy; } catch { return undefined; } },
      lsp: () => lspManager ?? undefined,
      autoDiagnosticsEnabled: () => winterLspAutoDiagnosticsEnabled(session.cwd),
    });
  // ── P8c integration Wiring 2: the notification/schedule sinks (lane 2's `sinks.ts`, P8c-11) ────
  // `hub.addObserver` (Dispatch/Phase 7's existing fan-out of every appended event of EVERY
  // session, both legs alike — see `sessions/hub.ts`) is the wiring point named in the brief: it
  // needs no change to `session-driver.ts`/`official-session.ts`, so both legs' projected
  // `tool_call`/`tool_result` reach the sinks through the SAME hub every other cross-cutting
  // observer (Dispatch's own) already uses.
  const sinks = sinksFor({
    routines: routineStore,
    emit: (event) => { hub.append(event.sessionId, event); },
    attachedCount: (sid) => hub.attachedCount(sid),
    notifyFallback: (title, message) => notifyHeadless(title, message),
    cwdFor: (sid) => { try { return store.meta(sid).cwd ?? undefined; } catch { return undefined; } },
    log: { info: (m) => console.error(`sinks: ${m}`), error: (m) => console.error(`sinks: ${m}`) },
    // P8d-13: the durable dedupe half (`runtime_sink_calls`), so a restarted daemon never re-fires
    // a side effect for a call id it already served; absent only when the runtime spine is offline.
    ...(runtime === undefined ? {} : { durable: createSinkCallStore(runtime.db) }),
  });
  hub.addObserver((event) => {
    // P8d-13: the generation scopes the durable key `(session, generation, callId)`.
    const generation = runtime?.records.get(event.sessionId)?.generation;
    if (event.type === "tool_call") sinks.onToolCall({ ...event, generation });
    else if (event.type === "tool_result") sinks.onToolResult({ ...event, generation });
  });
  const winterDrivers: WinterSessionDrivers = createWinterSessionDrivers({
    home: normaHome,
    profile: process.env.NORMA_PROFILE,
    settings: () => settings, // LIVE holder
    runtime: runtimeSdk,
    records: runtime?.records,
    checkpoints: runtime?.checkpoints,
    store, hub, secrets,
    buildSessionCapabilities,
    approvals: approvalBroker,
    questions,
    gate: new PermissionGate(),
    rootsOf: (sid) => sessionDirs.roots(sid),
    tmpDirOf: (sid) => sessionTmpDir(sid),
    outDirOf: (sid) => ensureOutdir(normaHome, sid),
    // The SAME relocation-aware derivation the live memory path uses (`memoryDirOf` above), so the
    // record names the directory the session actually reads.
    memoryKeyOf: (cwd) => memoryProjectKeyFor(cwd, { normaHome, directory: settings?.memory?.directory, relocatedKey: (k) => runtime?.relocatedMemoryKey(k) }),
    // Task 17 Step 0(a): the SAME assembler the engine's `turn()` composes its instructions with —
    // Norma's persona per mode, the `_assistant` bucket, the output style — so a Winter-leg session
    // speaks as Norma.
    assembler,
    // Task 17 (P8b-15): Winter children land in the persisted roster (absent when the spine is offline).
    ...(bgAgents === undefined ? {} : { children: bgAgents }),
    onTurnSettled: (sid) => { signals.onTurnSettled?.(sid); },
    ...(titler === undefined ? {} : { titler }),
    // Fix wave (review row 7): the user's `settings.mcpServers` and a TRUSTED project's `.mcp.json`
    // reach the child as stdio configs under the registry's own keys (`mcp__<key>__<tool>`). Read
    // LIVE per incarnation from the same holder and the same `TrustStore` the McpManager consults.
    extraMcpServers: (session) => configuredMcpServersFor({ settings, cwd: session.cwd, trusted: (dir) => trustStore.isTrusted(dir) }),
    log: (line) => console.error(`winter-leg: ${line}`),
    ...(opts.officialConnectionOverride === undefined ? {} : { officialConnectionOverride: opts.officialConnectionOverride }),
    // P8c integration Wirings 1 & 3 (P8c-14): lane 2's plan bridge and lane 3's hooks facade,
    // built above. `hooksFor` reaches the official leg's `Options.hooks` today (session-driver.ts's
    // `assembleOfficial`); the Winter-leg side of `planBridge`/`hooksFor.winter` has no consumer yet
    // in this spine (`approval-bridge.ts` never reads `WinterLegDeps.planBridge`, and this file's
    // own `optionsFor` never threads `hooksFor(...).winter` into `buildWinterOptions` at all) — both
    // fields are still wired here because `WinterLegDeps` already declares the seam and the brief's
    // wiring is this daemon.ts assignment, not the still-open lane-1 consumption (see report).
    planBridge,
    hooksFor,
  });
  // Wiring 1: fills the forward reference `planBridge`'s `setPolicy` closes over (declared above,
  // before `winterDrivers` existed) — see that block's own comment for why the cycle is broken here.
  winterDriversForPlanBridge = winterDrivers;
  // P8c integration round 3 (lane 4's NEEDS daemon.ts note): the ONE registration of the router's
  // handoff participants (`create.ts`'s `NormaRuntimeSdk.registerHandoffParticipants`, lane 1's
  // hook) — the router reads `participants`/`selectionInputFor` LAZILY at handoff time, so this
  // must run once, after both `runtimeSdk` (the router handle — `HandoffDeps.runtime`) and
  // `winterDrivers` exist, and never inside an RPC case. Guarded on both existing: `runtime`
  // (the 8a spine, for `.records`) can be offline (`runtimeStateOnline` returned undefined), and
  // `runtimeSdk` can be undefined (a packaging fault) — either absence already means every
  // `session.*` Winter-leg call refuses typed, so a handoff has nothing live to register against.
  if (runtime !== undefined && runtimeSdk !== undefined) {
    registerHandoffParticipants({ runtime: runtimeSdk, winter: winterDrivers, records: runtime.records, store, settings: () => settings });
  }
  /** A deleted session takes its Winter child (bounded `end()`, out of the table) AND its runtime
   *  rows with it — the reaper's 600 s grace is shorter than the 900 s idle timer, so without the
   *  first half a live child would outlive its session. The boot sweep above ran before any driver
   *  could exist, so it keeps the bare records hook. */
  const onSessionDeleted = (sessionId: string): void => {
    void winterDrivers.evict(sessionId);
    runtime?.onSessionDeleted(sessionId);
  };
  /** Task 17: what the engine used to answer, over the driver table + the child roster. */
  const grantDeniedPrefixes = [normaHome];
  const signals: EngineSignals = {
    isRunning: (sid) => winterDrivers.get(sid)?.turnRunning ?? false,
    hasBackgroundWork: (sid) => (bgAgents?.list(sid) ?? []).some((a) => a.status === "running"),
    interrupt: (sid) => { const d = winterDrivers.get(sid); if (d === undefined || !d.turnRunning) return { wasRunning: false }; void d.interrupt(); return { wasRunning: true }; },
    activeTurnCount: () => winterDrivers.list().filter((d) => d.turnRunning).length,
    knownModels: () => agentProvider?.provider.models() ?? [],
    // engine.ts's `grantDenied`, verbatim: at/under a prefix, or an ANCESTOR of one (fence
    // containment is subtree-based; granting an ancestor of ~/.norma/run would open the control plane).
    isGrantDenied: (dir) => {
      for (const p of grantDeniedPrefixes) {
        let cp: string;
        try { cp = realpathForGrant(p); } catch { cp = resolveForGrant(p); }
        if (dir === cp || dir.startsWith(cp + pathSep) || cp.startsWith(dir + pathSep)) return true;
      }
      return false;
    },
    threadsFor: (sid) => [
      { threadId: "main", status: winterDrivers.get(sid)?.turnRunning ? "running" : "completed" },
      ...(bgAgents?.list(sid) ?? []).map((a) => ({ threadId: a.threadId, parentThreadId: "main", status: a.status === "running" ? "running" as const : "completed" as const, ...(a.status === "running" ? {} : { stopReason: a.status }) })),
    ],
  };
  const childrenRpc = createChildrenRpc({
    registry: () => bgAgents,
    facetFor: (sid) => { const backend = runtime?.records.get(sid)?.backendSessionId; return backend === undefined || runtimeSdk === undefined ? undefined : attachedFacetFor(runtimeSdk, backend); },
  });

  if (agentProvider) {
    const registry = new ToolRegistry();
    sharedRegistry = registry;
    // Reads-unrestricted (user rule, memory/reads-unrestricted.md, task-10): read/ls/glob/grep get
    // NO path fence — the ONE carve-out is denying `dirs.runDir` (~/.norma/run), the sole directory
    // bootstrapNormaDir (norma-dir.ts) locks down to 0700; every other normaHome subdir (sessions,
    // memory, skills, agents, plugins, hooks, logs, settings.json) stays fully readable by design.
    // Boot-constant: normaHome can't change within a daemon lifetime, and `run` already exists by
    // this point (bootstrapNormaDir mkdir'd it above). This is belt-and-suspenders — today every
    // actual secret (harness/admin tokens, Codex OAuth tokens, web-search/OpenAI API keys) lives in
    // the OS Keychain via `secrets` (KeychainSecretStore), never on disk under normaHome — but it's
    // the real, deliberately-hardened boundary Norma draws around its own runtime material (the IPC
    // socket, the daemon lock file, plugin-supervisor PID files), so a prompt-injected turn can't
    // read the daemon's own control-plane files through the tool the daemon itself hosts.
    // P8a (WS-16 §10, whole-branch review M1): `runtimes/` joins `run/`. It holds the authoritative
    // `runtime-state.db` (and its `-wal`, and every `backups/*.db` copy of it), the official-agent
    // spool and the resume-staging roots — i.e. router metadata today and MESSAGE BODIES the moment
    // 8b lands (`global_messages`/`held_messages` carry whole envelopes), plus 8c's staged
    // credentials. A model that could `read` the db file could read all of it around every seam this
    // branch built. `norma doctor` is a separate CLI process and is unaffected by this denial.
    // hot-settings T2: getter over the live `settings` holder (was a boot-captured value) — a
    // later task's watcher reassigns `settings` in place; this closure re-reads it on the NEXT
    // enter_worktree/spawn isolation call, no WorktreeManager reconstruction needed.
    // 4g Task 5: web_fetch — Norma's ONLY sanctioned network egress (bash's sandbox denies network
    // by design). Shares the SAME `audit` appender instance as peripheral/hardware below (hoisted
    // above this gate for exactly this reason) — every call (success, ssrf-refusal, http error,
    // timeout) gets one `{kind:"network", tool:"web_fetch", url, outcome}` line on audit.jsonl.
    // 4g Task 6: web_search's Brave API key rides the SAME `secrets` store (KeychainSecretStore,
    // built at the top of startDaemon) `norma login --web-search-key` writes into — one
    // SecretStore instance, one Keychain, no separate store to keep in sync.
    // B1-T5: Search — chat's Exa-backed one-call web search (results + page excerpts in a single
    // request). Same `audit`/`secrets` instances as registerWebTools just above; its own keychain
    // secret (EXA_API_KEY_SECRET) is `norma login --exa-key`'s write target, never web_search's.
    // Critical 1 fix (whole-branch review): `dangerousDomainsAdded` — the same shared getter every
    // other consumer of the effective dangerous-domain list uses below — so a Search result whose
    // url matches it is withheld before the model ever sees it (never a silent drop; see search.ts).
    // B2-T2: ReadPage — chat's (and, per user decision, dispatch's) batched page-reading tool.
    // ONE PageCache instance per daemon, constructed here and shared: Task 3's ephemeral research
    // runner hands the SAME instance to its FetchPage-only sub-agent, so a report's own citations
    // resolve from the identical cache a follow-up ReadPage(lineStart/lineEnd) call would hit.
    // (`pageCache` itself is HOISTED above the Winter runtime block — P8b Task 7 — so the `research`
    // capability server shares this exact instance; nothing else about this wiring changed.)
    // B2-T3: the ephemeral research sub-agent — FetchPage-only, cited reports. Reuses the SAME
    // Provider instance (`agentProvider.provider`) the main engine turns use — this whole `if` is
    // already gated on agentProvider being present, so `research` is constructed unconditionally
    // HERE and stays undefined only when this gate never opens at all (no agentProvider), matching
    // ReadPage's own "research is not available in this session yet" fallback for that case.
    // `research.ts` never touches this (or any) ToolRegistry itself — FetchPage is a hand-built
    // spec + direct dispatch entirely inside that module, never registered here or anywhere else
    // (mode-toolset-census.test.ts's forward guard pins that FetchPage never joins this registry).
    // Critical 1 fix (whole-branch review, USER-REVISED design): both ReadPage and its research
    // runner get the SAME `dangerousDomainsAdded` getter — chat/dispatch have no approval flow at
    // all, so a dangerous-domain url is HARD-BLOCKED (isError, no card) rather than carded like
    // web_fetch (code mode, unchanged). See page-core.ts's `checkDangerousDomain` for the full
    // rationale and read-page.ts/research.ts for where the check actually fires.
    const research = createResearchRunner({ provider: agentProvider.provider, cache: pageCache, audit: (line) => audit.append(line), dangerousDomainsAdded });
    researchRunner = research; // the holder the `research` capability server reads (P8b Task 7)
    // B2 Task 4: the agent's browser. Four narrow deps, each the SAME thing the equivalent RPC uses —
    // `tabs` is the fold `panel.list` serves, `openTab` is the function `panel.openTab`'s handler
    // runs, `dispatch` is the one pending-command registry `panel.commandResult` resolves against,
    // and `harnesses` is the hub's own attachment record. Nothing here is a second, parallel path to
    // the panel; that is what keeps an agent-driven tab indistinguishable from a user-driven one.
    // `dangerousDomainsAdded` is the SAME shared getter ReadPage/Search/research already take (spec
    // §7: the dangerous-domains list is shared).
    // office-agent-tools T3: sheets — the same `panelCommands`/`hub` doors as `browser` above, plus
    // ONE more: `dirsOf`. `store.dirs(sid)` — never `writableRoots`/`ctx.roots` — is deliberate: it
    // is the EXACT function `session.list`'s own handler calls to populate the wire `dirs` field the
    // Mac app reads (`ipc/server.ts`, the `const dirs = opts.store.dirs(s.sessionId)` line), so the
    // daemon's own fence (`sheets.ts`'s `officeSheetsResolvedPathWithinFence`) agrees with the app's
    // independent one (`OfficeAgentBroker`'s Swift fence) on what "this session's working
    // directories" means — `writableRoots` is a WIDER set (folds in `Edit(<path>)`-declared dirs and
    // any dirGrant-adopted directory), which would let this tool accept a path the app-side broker
    // was always going to refuse anyway.
    // office-agent-tools T6 — `slides`, the identical deps shape as `sheets` immediately above (same
    // `dirsOf` sourcing rationale: `store.dirs(sid)`, never `writableRoots`, so the daemon's fence
    // agrees with the app-side broker's independent one on what "this session's working directories"
    // means — see the comment on the `sheets` registration above for the fuller reasoning, not
    // repeated here).
    // office-agent-tools T7 — `docs`, the identical deps shape as `sheets`/`slides` above and for
    // the identical reasons (see the `sheets` registration's own comment).
    // hot-settings T2: getters over the live `settings` holder (was a boot-captured value) — a
    // later task's watcher reassigns `settings` in place; these closures re-read it on the NEXT
    // acquire()/run(), no SubagentManager reconstruction needed. No-timeout task (user rule
    // 2026-07-12): `timeoutMs` absent from settings → NO wall clock (the manager has no default
    // one anymore); `stallTimeoutMs` absent → the manager's own 600s progress-stall default.
    // Both hot — a settings edit applies to the very next subagent run, no daemon restart.
    // CC-parity phase 3 (Workflows, Task B2): constructed unconditionally alongside bgAgents (same
    // "always build it, the tool/bridge itself decides whether to use it" shape spawn_agent's own
    // subagents/agents above follow) — PRODUCTION deps only: no `workerCommand` override (that's a
    // test-only seam over in workflows/runtime.test.ts; the real default self-spawns the compiled
    // binary in `__workflow-worker` mode, workflows/runtime.ts's own `defaultWorkerCommand`).
    // `spawnAgent`/`onEvent` both close over the `engine` binding assigned further down — same
    // later-assigned-closure precedent as `dispatchChildren`/`dreamer` below (neither is ever
    // INVOKED until a real Workflow launch happens, long after `engine` is assigned).
    workflowRuntime = new WorkflowRuntime({
      onEvent: (sid, ev) => {
        // Track D Task D1: hub.append the wire counterpart of this runtime event so an attached
        // client (the app) can watch a Workflow run live — ADDITIVE to (never instead of) the
        // notifyWorkflowCompletion call below, which still drives the assistant-facing
        // task_notification on completion/failure. Field mapping mirrors the fixtures in
        // packages/protocol/scripts/generate.ts (workflow_started/_progress/_completed/_failed).
        switch (ev.type) {
          case "started":
            hub.append(sid, { type: "workflow_started", sessionId: sid, threadId: "main", runId: ev.runId, name: ev.name, summary: ev.summary });
            break;
          case "progress":
            hub.append(sid, {
              type: "workflow_progress", sessionId: sid, threadId: "main", runId: ev.runId,
              phase: ev.progress.phase, log: ev.progress.log,
              running: ev.progress.counts.running, completed: ev.progress.counts.completed, total: ev.progress.counts.total,
            });
            break;
          case "completed":
            hub.append(sid, { type: "workflow_completed", sessionId: sid, threadId: "main", runId: ev.runId, resultSummary: ev.result });
            break;
          case "failed":
            hub.append(sid, { type: "workflow_failed", sessionId: sid, threadId: "main", runId: ev.runId, error: ev.error });
            break;
        }
        // Task 17: the engine's `notifyWorkflowCompletion` pinned a notice into the parent's next
        // turn; the `Workflow` tool is not served to a Winter child yet (carry), so there is no
        // parent turn to notify — the completion event above is the record.
      },
      // Task 17: a workflow's `agent()` is a Winter CODE child session with a fixed prompt, run to
      // its first idle through the driver table; the result is its last assistant text.
      spawnAgent: async (sid, prompt, o, signal) => {
        const parent = store.meta(sid);
        const childId = store.createSession("global", { cwd: parent.cwd ?? undefined, approvalPolicy: parent.approvalPolicy, origin: "workflow-child", mode: "code", parentSessionId: sid, ...(o?.model === undefined ? {} : { model: o.model }) });
        const onAbort = (): void => { void winterDrivers.get(childId)?.end(); };
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          await winterDrivers.runTurn(childId, prompt, "workflow");
        } catch (err) {
          return { ok: false, result: err instanceof Error ? err.message : String(err) };
        } finally {
          signal.removeEventListener("abort", onAbort);
          void winterDrivers.get(childId)?.end();
        }
        const log = store.read(childId);
        const last = [...log].reverse().find((e) => e.type === "assistant_message" && (e as { threadId?: string }).threadId === "main") as { text: string } | undefined;
        const failed = log.some((e) => e.type === "agent_error") || signal.aborted;
        return { ok: !failed, result: last?.text ?? "" };
      },
      runsDir: join(normaHome, "workflows-runs"),
    });
    // Deferred (rides ToolSearch like worktree/notebook/plan/schedule above) — a specialized
    // orchestration primitive, not needed in every turn. Session-type/settings gating (Task B3/B4,
    // per workflowsEnabled/keywordTriggerEnabled below) is layered on top of this later; B2 only
    // wires the tool + its launch bridge.
    // `agentProvider` is already narrowed non-null here (we're inside `if (agentProvider)`), and
    // its `.provider` is the SAME provider instance the engine's spawn bridge calls .models() on
    // to validate a spawn_agent model override (4e gate F9) — so this list is exactly what the
    // bridge will accept. Empty (an openai-compatible provider with no static `models` configured)
    // → registerSpawnAgentTool falls back to its generic "model: optional model override" wording.
    // 4h-ii-b Task 6 (CC parity: short model aliases) — the full ids are extended with their
    // UNAMBIGUOUS derived short aliases ("sol"/"terra"/"luna" for the gpt-5.6 trio), never
    // replacing them, so the enum/description offer both spellings; engine.ts's own
    // resolveModelAlias (the spawn bridge's runtime gate) uses the identical uniqueness rule, so an
    // alias offered here is always one the bridge will actually accept.
    // Dispatch (Phase 7) Task 4: session_spawn — registered unconditionally alongside spawn_agent
    // (both live on the SAME shared `registry`; engine.ts's SESSION_SPAWN_TOOL exclusion is what
    // actually keeps it out of a code session's tool list — registering it here doesn't by itself
    // make it code-visible). SAME models list as spawn_agent (full ids + their unambiguous short
    // aliases) so the bridge's alias resolution (engine.ts) always accepts whatever this tool's own
    // schema enum advertised.
    // session-activity-hygiene T8: dispatch's MANAGEMENT surface over the session lifecycle —
    // `list_sessions` (read) and `manage_session` (stop/background/archive/resume). Both declare
    // `modes: ["dispatch"]` in their own file (the per-mode registry's single declaration site), so
    // registering them on the shared registry here cannot make them code-visible.
    //
    // WIRED FROM THE SAME INSTANCES the rest of the daemon uses — the `store` and `hub` consts
    // above, and the `engine` binding these closures read LIVE (assigned further down; the
    // `registerAgentQueryTools` lazy-closure precedent). Handing a management surface its own hub
    // would read `attachedCount` as a hard 0 forever and quietly report every attached session as
    // idle — the T7 review's own finding, avoided here by construction rather than by care.
    //
    // `derive` is THE activity derivation `session.list` stamps rows with, published out of
    // `startIpcServer` into `activityDeriver` below: a management listing that derived state its own
    // way would disagree with the session list in exactly the two windows that matter most (the
    // post-turn grace and the >24h demotion), because those two signals live only in that scope.
    // 4h-ii-b Task 4 (CC SendMessage): registered alongside spawn_agent (only when subagents are
    // available) so the MAIN thread can address a subagent by agentId/name — a running one gets the
    // message at its next step, a finished one is resumed with it. Like spawn_agent it's an engine
    // bridge; this DEF is what the model sees, the engine intercepts the call (see engine.ts's
    // sendMessageCalls bridge). Excluded from every child's tool set (depth-0 only).
    // 4h-ii-c Task 2 (CC TaskStop): registered alongside spawn_agent/send_message — the SAME
    // `bgAgents`/`bgRegistry` instances the engine cfg gets below, so a stop here is visible to
    // the engine's own pin/completion-reminder bookkeeping. Unlike spawn_agent/send_message this
    // is a PLAIN TOOL (no engine bridge — see task-stop.ts's own doc comment).
    // D1-T2 originally narrowed this to `deferred: ["dispatch"]` (from `true`, deferred like
    // bash_output/registerBackgroundTools above, in every mode), which silently made task_stop
    // IMMEDIATE IN CODE — an unrequested regression nobody named at the time (whole-branch review
    // FIX 3): the user's request was "deferred on dispatch" (narrowing bash/task_stop/computer/
    // AskQuestion/send_message's EXISTING toolset into dispatch), never "make task_stop immediate in
    // code", and CC parity (this repo's tool surface deliberately tracks Claude Code's shape — see
    // norma-vs-cc-tools.md) has TaskStop deferred: one generic stop tool, no separate bash_kill
    // (removed; task_stop's bash-unify path is now the only way to kill a bg bash task) — that is
    // the ORIGINAL CC-parity clause this comment used to (mis)attribute to "stays immediate in
    // code" instead. Restored to `deferred: ["code", "dispatch"]` — deferred in BOTH modes it's
    // eligible for (task_stop's own `modes` below is exactly `["code","dispatch"]`), matching its
    // pre-D1-T2 `deferred: true` behavior exactly rather than the narrower one D1-T2 introduced.
    // Dispatch (Phase 7) Task 5: `dispatch` closes over the `dispatchChildren` binding declared
    // further down (before `new AgentEngine(...)`) — safe (same later-assigned-closure shape as
    // `engine?.transcriptPathFor` a few lines below): this closure is only ever INVOKED at a real
    // task_stop call, long after boot finishes assigning it.
    // phase 5a Task 1: agent_list/agent_output — the read-only "collect your subagents"
    // counterpart to spawn_agent/send_message/task_stop above, same bgAgents instance so what
    // they report is exactly what the engine's own pin/completion bookkeeping sees. `deferred:
    // true` is hardcoded inside registerAgentQueryTools itself (unlike task_stop's caller-supplied
    // flag), so no `deferred` option is passed here.
    // `transcriptPathFor` (CC-parity subagent transcripts): a closure over the `engine` binding
    // declared above — `engine` isn't assigned until further down this same `if` block, but this
    // closure is only ever INVOKED at tool-call time (well after boot completes), by which point
    // it's set. Mirrors `cwdOf`/`rootsOf`/`tmpDirOf`'s own lazy-closure-over-a-later-assigned-const
    // shape used for registerLspTools above.
    // T1 (file-based memory, design doc `2026-07-15-file-based-memory-design.md`) DELETES the
    // memory_read/memory_write/memory_delete tools that used to register here (phase 5b Task 2) —
    // CC parity: no dedicated memory tools, plain write/edit/read/glob/grep over the per-project
    // MEMDIR instead (sessionDirs's baseDirs closure above joins it into the write fence; the
    // ContextAssembler wired above injects the protocol + index). `memoryStore` itself is UNTOUCHED
    // (still backs ipc/server.ts's memory.* RPCs for the dashboard/CLI — see its own doc comment).
    // Phase 5c Task 2: skill_write over the SAME `skillStore` instance registerSkillTools above
    // reads from — one store, so a skill written here is immediately loadable via Skill with no
    // second handle to keep in sync. ALWAYS_ASK-gated (gate.ts): a card under BOTH ask and auto,
    // and excluded from every child's tool set (engine.ts childExcludeTools).
    // Computer use (Phase 5 CU): opt-in via settings.computerUse.enabled (the strongest reading of
    // "full-auto CU requires explicit opt-in" — absent/false, the `computer` tool does not exist).
    // The service holds leases on the SAME `peripheral` broker (hoisted above this gate) that
    // Norma.app serves screenshot/ax-read/input-drive behind. reuses settings.peripheral.heartbeatMs.
    // P8b Task 6: the `let` itself is HOISTED above the Winter runtime block (it is the holder the
    // `computer` capability server's getter reads — one service, one lease set, two doors); only
    // the construction stays here, unchanged.
    if (settings?.computerUse?.enabled) {
      computerUse = new ComputerUseService({ broker: peripheral, heartbeatMs: settings?.peripheral?.heartbeatMs });
      // D1-T2: `deferred: ["dispatch"]` — immediate in code (unchanged), deferred only for the
      // dispatch coordinator (matches the hot-toggle re-registration below, registerComputer).
      registerComputerTool(registry, { screenshotMaxDim: settings?.computerUse?.screenshotMaxDim, deferred: ["dispatch"] });
    }
    // Phase 5 routines T3 (design doc §4): the agent-facing management surface over the SAME
    // `routineStore` instance the scheduler (below, past this gate's close) fires against —
    // `routineStore` is hoisted above this gate for exactly this sharing (see its own doc comment).
    // Deferred like worktree/notebook/plan above — a specialized tool, not needed in every turn.
    // Phase 5f Task 3, consolidated into the single `lsp` tool by lsp-consolidation T2 (design doc
    // `2026-07-15-lsp-consolidation-design.md`): ONE LspManager for the whole daemon (mirrors the
    // ONE-MemoryStore/ONE-McpManager precedent above), reaped on shutdown below.
    // NOTE: unlike the SYNCHRONOUS mcp?.stopAll()/pluginSupervisor.stopAll() kills, LspClient's stop
    // is async — so shutdown uses lspManager.killAllNow() (synchronous SIGTERM backstop) BEFORE the
    // graceful `void stopAll()`; see the daemon.stop() body. `cwdOf`/`rootsOf`/`tmpDirOf`
    // are the SAME session-meta sources fs-read.ts's roots+tmpDir already read: `store.meta(sid).
    // cwd`, `sessionDirs.roots(sid)`, `sessionTmpDir(sid)`.
    //
    // Phase 5f Task 4: default ON, same boot-snapshot `cfg?.enabled === false` shape as
    // reviewer/titles above — an explicit `settings.lsp.enabled: false` is the only way to skip
    // this whole block, so when off the `lsp` tool is simply never registered (a query for it
    // becomes the registry's ordinary "unknown tool" error, no special-cased denial).
    // `idleShutdownMs` threads straight from settings into the SAME LspManager constructor call.
    const lspCfg = settings?.lsp;
    // hot-settings T5b: named (not inline-arrow) so a later lsp.enabled hot re-enable (the apply
    // deps' `registerLsp` below) re-registers the SAME session-meta sources this boot call uses —
    // one definition, two registration sites, never drifting.
    const cwdOf = (sid: string) => store.meta(sid).cwd ?? undefined;
    const rootsOf = (sid: string) => sessionDirs.roots(sid);
    const tmpDirOf = (sid: string) => sessionTmpDir(sid);
    // working-directories T4: engine.ts's `EngineConfig.outDirOf` — read fresh per tool call
    // alongside `tmpDir` (executeCall), independent of `sessionDirs`/`rootsOverride` (see that
    // field's own doc comment for why: mirrors `tmpDir`'s own rootsOverride-independence).
    const outDirOf = (sid: string) => ensureOutdir(normaHome, sid);
    // diff-tabs Task 6: engine.ts's `EngineConfig.persistDiff` — same normaHome-closure shape as
    // outDirOf just above, action- rather than value-shaped (see persistDiff's own doc comment).
    const persistDiff = (sid: string, diffId: string, header: Omit<DiffHeader, "truncated">, patch: string) =>
      writeDiff(normaHome, sid, diffId, header, patch);
    if (lspCfg?.enabled !== false) {
      lspManager = new LspManager({ idleShutdownMs: lspCfg?.idleShutdownMs });
    }
    mcp = new McpManager({ registry, trust: trustStore, log: (m) => console.error(m) });
    // MCP resources (CC parity: ListMcpResourcesTool/ReadMcpResourceTool) — registered
    // unconditionally here (not per-server-connect: see mcp-resources.ts's own doc comment for why
    // a live conditional-registration mirror of CC isn't cheap with this registry's shape) so it
    // exists across every later startAll/ensureProject/startPlugins call this `mcp` instance ever
    // makes. Deferred like schedule/notebook_edit/worktree above — specialized, not needed most
    // turns.
    await mcp.startAll(settings?.mcpServers ?? {});
    // Plugin MCP servers start only with explicit settings consent (mcpEnabled = enabled &&
    // !disabled); a plugin's skills are always live (SkillStore above), but its MCP/manifest
    // content is the seam that needs the user opting in via settings.plugins.enabled AND,
    // per-exec-class, a settings.plugins.consents record (pluginMcpEligible in agent/plugins.ts —
    // legacy plugins have requiredConsents [] so this is unchanged for them; a manifest plugin
    // with exec content that's enabled but unconsented is excluded here, logged below). The
    // `!pluginMcpEligible(p)` on the right is the SAME eligibility predicate the enabledPlugins
    // filter below uses — deriving it inline (e.g. hand-rolling !consentComplete(p)) would let the
    // why-log drift out of sync with what actually gates MCP start; the left-hand guard just
    // narrows the log to the "would be eligible if not for consent" case so we don't log for
    // plugins that were never enabled or never carried MCP content in the first place.
    for (const p of allPlugins) {
      if (p.mcpEnabled && !p.disabled && (p.hasMcp || p.hasManifestMcp) && !pluginMcpEligible(p)) {
        const missing = p.requiredConsents.filter((c) => !p.consented.includes(c));
        console.error(`plugin ${p.name}: enabled but missing consent for ${missing.join(", ")} — MCP not started`);
      }
    }
    // manifestServers (Task 4, spec §2: "mcpServers may now come from the manifest instead of
    // .mcp.json ... manifest wins on conflict") comes straight off PluginInfo — PluginStore.list()
    // already ran loadManifest once per plugin and carried contributes.mcpServers through as
    // p.manifestServers (undefined for legacy plugins and manifest plugins with no mcpServers
    // declared). Re-reading norma-plugin.json here would risk a manifest that read fine moments
    // ago (hasManifestMcp true, gating eligibility) but fails to reparse on a second read —
    // silently falling back to the legacy .mcp.json path without ever disclosing that switch.
    const enabledPlugins = allPlugins
      .filter(pluginMcpEligible)
      .map((p) => ({ name: p.name, dir: join(normaHome, "plugins", p.name), manifestServers: p.manifestServers }));
    await mcp.startPlugins(enabledPlugins);

    // Tier-2 platform plugins (Phase 4b Task 3, spec §3): PluginSupervisor owns process lifecycle
    // (spawn/registration timeout/crash backoff/circuit breaker/PID-file orphan reclaim) for every
    // spawn-eligible plugin (pluginSpawnEligible — tier "platform" + entry present + enabled +
    // consented, the same enabled/disabled/consent shape as pluginMcpEligible above). `pluginSupervisor`/
    // `spawnablePlugins` are constructed above, OUTSIDE this gate (Phase 4d-cleanup Task 2 — the
    // orphan sweep runs regardless of agentProvider); only the actual spawn — `startAll()` — is
    // gated here, since a spawned plugin process needs `registry` (just below) to bridge its tools
    // into. startAll() is non-blocking (orphan reclaim/registration waits are timer-driven, never
    // awaited here). Task 4 wires the actual tool.register/plugin_tool_invoke bridge into `registry`
    // and the ipc handlers that call notifyRegistered/notifyDisconnected/resolveToolResult.
    // `onCircuitOpen` (wired at construction, above) is Task 4's other half of that wiring: when the
    // breaker trips, this plugin's process is done until a manual restart — its `plugin__<id>__*`
    // tools must stop being offered to the agent, so it unregisters them straight out of the SAME
    // registry `registerReadTools` etc. above populated (via the `sharedRegistry` mirror, since
    // `onCircuitOpen` was wired before `registry` existed).
    pluginSupervisor.startAll(spawnablePlugins);

    // hot-settings T2 review: ALWAYS constructed, never gated on the boot-time reviewer.enabled.
    // The BashReviewer constructor is inert (stores provider/model/timeoutMs refs only — no I/O,
    // spawns nothing; review() is what does work, and it's only ever reached through the engine's
    // `reviewerEnabled?.() !== false` gate). Building it unconditionally is what makes
    // reviewer.enabled hot in BOTH directions: were it left undefined at a disabled-boot, a later
    // false→true edit could never take effect (the getter gates whether review RUNS, but only if
    // there's a reviewer object to run) — a restart-required toggle, which the "no restart
    // anywhere" rule forbids. `reviewer.model` stays a boot snapshot (out of T2's scope — it
    // picks WHICH model the reviewer would use, not whether reviewing is on).
    // Default ON: the titler is built unless settings.titles.enabled is explicitly false.
    // Plugin hooks runtime (Phase 4f Task 2): the engine-facing `cfg.hooks` facade. `hookRegistry`
    // is the SAME instance ipc/server.ts's plugin-lifecycle RPCs rebuild in place (passed through
    // startIpcServer's opts below), so a `plugin.enable`/`disable` hot-apply is visible to the
    // facade with no daemon restart. hot-settings T2: `hooksEnabledHot` COLLAPSES from a
    // mtime-cached settings.json re-read per call into a plain thunk over the live `settings`
    // holder above — no disk read at all; a later task's watcher reassigns `settings` in place
    // and this thunk re-reads that same reference on its NEXT call, exactly the getter shape
    // every other in-scope field in this file now uses. `settings` can still be null (a malformed
    // settings.json at boot, or a test injecting `agentProvider` directly) — `true` there is the
    // SAME fail-open default the pre-collapse disk-read-failure catch used.
    // Task 9 (CC project-folder-mechanics, final task): now resolves through the SAME
    // `projectSettings` instance the reviewer/toolSearch/lsp.autoDiagnostics getters use (mirrors
    // `lspAutoDiagnosticsHot` immediately below exactly). Unlike those getters, `cwd` is NOT threaded
    // in by an engine.ts call site — HookFacade.runFor (hook-registry.ts) only ever has a
    // `sessionId` in scope, so IT resolves the cwd (preferring the session-start `extra.cwd`, else
    // the `cwdForSession` dep wired below, which reads `store.meta(sid).cwd`) before calling this.
    // `effective(cwd ?? null)` degrades to `settings` verbatim for a null/untrusted/overlay-less
    // cwd, so this reads byte-identically to the pre-Task-9 zero-arg getter whenever no project
    // overlay applies or no cwd was resolvable. The null-settings fail-open default is unchanged.
    const hooksEnabledHot = (cwd?: string | null): boolean => {
      const s = projectSettings.effective(projectRootOf(cwd));
      return s ? hooksEnabledFrom(s) : true;
    };
    // lsp-consolidation T3: same live-getter shape as `hooksEnabledHot`/`memoryEnabledHot` above —
    // `settings` can still be null (malformed settings.json at boot, or a test that injects
    // `agentProvider` directly), `true` there is the same fail-open default those two use.
    // Task 8 (CC project-folder-mechanics): now resolves through the SAME `projectSettings`
    // instance the reviewer/toolSearch getters below use — `cwd` is engine.ts's executeCall cwd;
    // `effective(cwd ?? null)` degrades to `settings` verbatim for a null/untrusted/overlay-less
    // cwd, so this reads byte-identically to the pre-Task-8 getter whenever no project overlay
    // applies. The null-settings fail-open default is unchanged (`effective` itself returns
    // `base()`'s null straight through when `base()` is null).
    const lspAutoDiagnosticsHot = (cwd?: string): boolean => {
      const s = projectSettings.effective(projectRootOf(cwd));
      return s ? lspAutoDiagnosticsEnabledFrom(s) : true;
    };
    // Dispatch (Phase 7) Task 4: declared BEFORE `engine` is constructed (computerUse precedent —
    // see EngineConfig.dispatch's own doc comment, engine.ts) so the `dispatch: () =>
    // dispatchChildren` getter below closes over this SAME binding; assigned right after
    // `new AgentEngine(...)` returns, since DispatchChildren.spawnChild needs `engine.runTurn`/
    // `engine.isRunning`, which don't exist until the engine itself does.
    // SP-approvals Task 5: constructed here (a statement, not an inline object-literal value) and
    // assigned to the OUTER `permissionRules` binding declared above the `if (agentProvider)` gate
    // — startIpcServer's opts (below, built AFTER this gate closes) need this EXACT instance so
    // `approval.respond`'s optionId-driven append() shares one mtime cache with the engine's own
    // decision() reads, never two independently-stale PermissionRules. See the field below (still
    // referenced by its old inline comment, now a shorthand) for what this class actually does.
    // Task 7: `globalAllow` now takes the `projectRoot` PermissionRules' own decision()/rulesFor()/
    // editPathRules() already have in scope, and resolves it through the SAME `projectSettings`
    // instance above — a trusted project's OWN `.norma/settings.json` `permissions.allow` UNIONS
    // into this project's effective rules (mergeSettings, Task 5) on top of the global settings.json
    // value; `effective(null)` degrades to `settings` verbatim, so a null projectRoot (or an
    // untrusted/overlay-less one) reads byte-identically to the pre-Task-7 global-only getter.
    permissionRules = new PermissionRules({
      globalAllow: (projectRoot) => projectSettings.effective(projectRoot)?.permissions?.allow ?? ["Computer"],
      normaHome,
    });
    // P8b Task 5, deliberately: `runtimeSdk` is NOT on this config. The engine never consumes the
    // Winter handle — P8b-13 decides the leg at `session.create` (`ipc/server.ts`, which has it) and
    // Task 16's driver owns every session that runs on it — and this whole class is deleted in
    // Task 17, so a field here would be churn on a dying config. See the report's F7.
    // Dispatch (Phase 7) Task 4: constructed AFTER `engine` exists — its `runTurn`/`isRunning`
    // deps close over `engine!` (non-null: this whole block only runs once `engine` is assigned
    // just above, mirroring `registerAgentQueryTools`' own `engine?.transcriptPathFor` lazy-closure
    // precedent a few dozen lines up). Reassigns the SAME `dispatchChildren` binding the
    // `dispatch: () => dispatchChildren` getter above already closes over — no engine
    // reconstruction needed, same shape as `computerUse`'s own post-construction assignment.
    // Task 5 adds `interrupt` (engine.interrupt, the SAME mechanism task_stop already uses for bg
    // agents) — stopChild's dep — and, once constructed, `start()`: rebuilds the child set from
    // the store (daemon-restart recovery) and subscribes to the hub's observer fan-out.

    // Dreaming (Phase 7b): background memory synthesis for the dispatch session. Hardcoded
    // model/cadence per spec; memory.enabled (hot) is the only switch. Constructed here, AFTER
    // `engine` is assigned above, since `activeTurnCount` closes over it (an idle read at tick
    // time, not a boot-time snapshot — `engine` is already its final value by this point in the
    // gate, same as `dispatchChildren`'s own runTurn/isRunning/interrupt closures just above).
    dreamer = new Dreamer({
      provider: agentProvider,
      store,
      dir: () => assistantMemoryDirFor({ normaHome }),
      enabled: memoryEnabledHot,
      // P8b Task 17: a Winter-leg turn in flight is activity too (the drivers' host-side count).
      activeTurnCount: () => signals.activeTurnCount(),
      // session-activity-hygiene T7 (spec §3): the cleaner rides THIS scheduler slot. Constructed
      // here (not at the top of the file) for the same reason the Dreamer is: it needs a provider,
      // and the signals it derives activity from (`engine`, `hub`) are only final by this point.
      //
      // SIGNAL ASSEMBLY, deliberately LOCAL rather than shared with `startIpcServer`'s
      // `deriveActivity`: two of that closure's five signals (`activeSince`, `autoBackground`) come
      // from the activity ENFORCEMENT, which lives inside the IPC server's scope and is not
      // reachable here — so a "shared" helper would still take them as parameters and dedupe
      // nothing. Their absence costs the cleaner's rail nothing: both can only push a session from
      // idle TOWARDS background, i.e. towards being railed, and in each case another input already
      // rails it (see `SessionCleaner.railFor`'s own note). The three signals that DO matter —
      // attachments, running turns, background work — are read from the SAME hub and the SAME
      // engine `session.list` reads, so the two can never disagree about a live session.
      cleaner: new SessionCleaner({
        provider: agentProvider,
        store,
        attachedCount: (sid) => hub.attachedCount(sid),
        turnRunning: (sid) => signals.isRunning(sid),
        bgWork: (sid) => signals.hasBackgroundWork(sid),
        home: normaHome,
        enabled: cleanerEnabledHot,
        // P8a Task 12: the second sanctioned deletion path takes runtime state with it too, exactly
        // as the reaper's does (WS-16 §16) — and, since Task 16, the session's Winter child.
        onDelete: onSessionDeleted,
      }),
    });
    dreamer.start();

    // hot-settings T5b (final task of the hot-settings track): compose T2's live getters (already
    // reading `settings` above), T3's SettingsWatcher, and T4's makeApply diff-applier into one
    // running watcher — the payoff that makes flipping computerUse.enabled/lsp.enabled/any other
    // value knob in settings.json take effect in THIS running daemon, no restart. Built here (after
    // `engine`, so `registry`/`computerUse`/`lspManager` above are all in their post-boot-
    // registration state) and only when `agentProvider` — a no-provider daemon has no registry/
    // engine to hot-apply against (same "agent disabled" boundary the rest of this gate follows).
    const apply = makeApply({
      // THE atomic swap — a single synchronous assignment, first thing every apply does (T4).
      setLiveSettings: (s) => { settings = s; },
      registry,
      buildComputerService: (s) => new ComputerUseService({ broker: peripheral, heartbeatMs: s?.peripheral?.heartbeatMs }),
      registerComputer: (svc, s) => {
        computerUse = svc; // reassigns the SAME holder the `computerUse: () => computerUse` getter above reads
        // D1-T2: same `deferred: ["dispatch"]` as the boot-time registration above — a hot toggle
        // must not re-register computer with weaker (or different) deferral than boot gave it.
        registerComputerTool(registry, { screenshotMaxDim: s?.computerUse?.screenshotMaxDim, deferred: ["dispatch"] });
      },
      teardownComputer: () => {
        // T4's drain (computerInFlight gate below) already waited out any in-flight `computer`
        // call before this runs — never yanks a live capability call.
        registry.unregister("computer");
        computerUse?.releaseAll();
        computerUse = undefined;
      },
      computerInFlight: () => computerUse?.inFlight() ?? false,
      buildLspManager: (s) => new LspManager({ idleShutdownMs: s?.lsp?.idleShutdownMs }),
      registerLsp: (mgr) => {
        // Fix wave (review F7): the `lsp` CAPABILITY server reads this holder per call, so
        // reassigning it IS the hot re-enable — the next `lsp` call on any session finds the new
        // manager. (Task 17 had retired the registry-door tool on the false premise that Winter's
        // own LSP serves the child; the 0.0.4 child advertises none.)
        lspManager = mgr;
      },
      teardownLsp: async () => {
        registry.unregister("lsp");
        const m = lspManager;
        lspManager = null;
        await m?.stopAll();
      },
      // File-based memory hot-toggle (T3, design doc follow-up / task-23): the SAME boot-time call
      // above (`migrateMemoryStore({ normaHome, trust: trustStore, directory, relocatedKey })`),
      // re-run whenever `memory.enabled` flips false→true on THIS running daemon — closes T2's
      // "boot-time only" gap. `settings` here is read at the moment this closure actually RUNS
      // (fire-and-forget, deferred a tick past `apply()`'s synchronous `setLiveSettings` swap), so
      // it already reflects `next`'s own `memory.directory` override, exactly like the boot-time
      // call reflects the settings loaded at THAT time. Failures are logged by settings-apply.ts's
      // own `.catch` (this closure just re-throws/returns whatever `migrateMemoryStore` does);
      // never touches/deletes the old store either way (memory-migrate.ts's own contract).
      migrateMemory: () => { migrateMemoryStore({ normaHome, trust: trustStore, directory: settings?.memory?.directory, relocatedKey: (k) => runtime?.relocatedMemoryKey(k) }); },
      // P8a Task 12: `runtimes.migrations.memoryKeys` flipped on a RUNNING daemon must migrate
      // without a restart (the project's standing no-restart-for-settings rule). The wiring's own
      // `schema_meta` marker is what keeps it a ONE-TIME relocation, so this is handed the new
      // settings unconditionally rather than diffed here.
      applyRuntimeMigrations: (next) => runtime?.applySettings(next),
      // P8b Task 5: the handle, so `settings-apply`'s `runtimeSdk?.messaging?.releaseHeld` hop is
      // WIRED rather than waiting on a later task to remember it. `messaging` is Task 12's member
      // and is undefined until then, so the call is a typed no-op today — but a retention widening
      // on a running daemon reaches it the moment that task fills it in.
      runtimeSdk,
      log: (msg) => console.error(`settings-apply: ${msg}`),
    });
    settingsWatcher = new SettingsWatcher({
      path: dirs.settingsPath,
      load: loadSettings,
      apply,
      log: (msg) => console.error(`settings-watcher: ${msg}`),
    });
    settingsWatcher.start(settings);
  }

  // Scheduled routines (Phase 5 T2, design doc §2; `routineStore` itself hoisted above the
  // `if (agentProvider)` gate in T3 — see its own doc comment). Built unconditionally (same
  // precedent as peripheral/hardware below) — a no-provider daemon still owns the store/audit so
  // `routines.*` RPCs (T3) work and existing routines aren't silently dropped; `engine` being null
  // just makes every fire fail cleanly via runHeadless's own "agent disabled" short-circuit (below
  // `engine` is ALREADY its final value — this sits after the `if (agentProvider)` block closes,
  // never reassigned again — so no thunk/live-read indirection is needed for `engine` itself here.
  // `routines.maxConcurrent` below is ALREADY a getter over the live `settings` holder (hot-settings
  // T2 leaves it exactly as it already was — same shape `subagents.maxConcurrent`/`worktrees.baseRef`
  // above were just converted TO).
  const routinesAudit = new RoutineAuditLog(join(normaHome, "routines-audit.jsonl"));
  // P8b Task 17: a routine fires as a NEW code session through the driver table (fix wave F9: the
  // runner's engine branch is gone with the engine).
  const routineRunner = makeDaemonRoutineRunner({ store, hub, winter: winterDrivers });
  const routineScheduler = makeRoutineScheduler({
    store: routineStore,
    runner: routineRunner,
    audit: (line) => routinesAudit.append(line),
    maxConcurrent: () => settings?.routines?.maxConcurrent,
  });
  routineScheduler.start();

  // Peripheral lease v1 (Phase 2f): `providerLink`/`peripheral` are constructed ABOVE the
  // `if (agentProvider)` gate (phase 5 CU hoist — see that block); reused here.

  // Hardware helper (Phase 4c Task 2, spec §5).  // Hardware helper (Phase 4c Task 2, spec §5). Built unconditionally, same precedent as
  // `peripheral` above — hardware access has nothing to do with whether an LLM provider is
  // configured. Shares the SAME `providerLink`/`audit` instances as `peripheral`: Norma.app's one
  // provider connection doubles as the hardware provider, and `hardware.respond` (ipc/server.ts)
  // reuses `peripheral.isProvider()` to gate on that SAME connection identity rather than tracking
  // its own.
  const hardware = new HardwareBroker({ audit, pushToProvider: (event) => providerLink.push(event) });

  const providerInfo = agentProvider ? { id: agentProvider.provider.id, model: agentProvider.model } : null;

  // Chat Slice D task 3 (`sync.config`): the phone's "default model" bootstrap value, re-resolved
  // HOT at every call — mirrors engine.ts's own boot idiom EXACTLY
  // (`this.cfg.provider.live?.() ?? {model: this.cfg.provider.model}`) rather than reusing
  // `providerInfo` above, which is a boot-time snapshot. `undefined` on a no-agentProvider daemon —
  // `ipc/server.ts` degrades that to `""`.
  //
  // provider-correctness T3 adds the EFFORT beside it, off the same `LiveModelSelection`
  // (`{model, reasoningEffort?}`). `reasoningEffort` is genuinely optional in settings, and an
  // unset one reports `""`: unset is NOT `"none"` (unset omits the `reasoning` block entirely), and
  // `SyncConfigResult.defaultEffort` documents why the phone must not collapse the two.
  //
  // T3 review m3 — TWO calls, not one selection, and the honest reading of that: `syncConfig` calls
  // `liveModel()` and `liveEffort()` separately, so a settings.json write landing exactly between
  // them could pair a new model with the old effort. Real, and immaterial: both hit the same
  // mtime-cached resolver microseconds apart, neither can throw, and the worst outcome is one
  // `sync.config` reply carrying a one-edit-stale effort that the phone's very next connect
  // corrects. Collapsing them into a single call would need `syncConfig` to take a selection object
  // instead of two independent getters — a wider seam for a race nobody can observe. Not done
  // deliberately; do not "fix" it by caching the selection across calls, which would break the hot
  // read that is the actual contract here.
  const liveSelection = agentProvider
    ? () => agentProvider!.live?.() ?? { model: agentProvider!.model }
    : undefined;
  const liveModel = liveSelection ? () => liveSelection().model : undefined;
  const liveEffort = liveSelection ? () => liveSelection().reasoningEffort ?? "" : undefined;
  // Whole-branch review C1 — WHICH provider the two lines above (and the catalogue the server reads
  // off `engine`) belong to. Read off `agentProvider.provider` and NOT off `liveSelection`: the
  // provider TYPE is boot-bound (`buildLiveModelResolver` closes over the boot `providerType` and
  // deliberately ignores a live-read one, because changing `provider.type` needs a restart), so
  // routing it through the hot resolver would advertise a hotness that does not exist. This is the
  // SAME instance `providerInfo` above and `engine.knownModels()` (via `cfg.provider.provider`)
  // read, so the identity and the catalogue cannot drift apart; `Provider.id` is `codex-oauth` /
  // `openai-compatible`, `ProviderSettings.type`'s own vocabulary. `undefined` on a no-provider
  // daemon — ipc/sync.ts degrades that to `"none"`, never to `""`.
  const liveProvider = agentProvider ? () => agentProvider!.provider.id : undefined;

  const server: IpcServer = startIpcServer({
    socketPath: dirs.socketPath,
    serverVersion: CORE_VERSION,
    tokens: authority,
    store,
    hub,
    engine: signals,
    agents: childrenRpc,
    // session-activity-hygiene T8: fills the `activityDeriver` holder above with THE derivation the
    // server stamps `session.list` with, so dispatch's `list_sessions` answers with the same state
    // this daemon serves everywhere else — including the two signals (post-turn grace, >24h
    // demotion) that exist only inside the server's own enforcement scope.
    onActivityDeriver: (derive) => { activityDeriver = derive; },
    broker: approvalBroker,
    // SP-approvals Task 5: the SAME PermissionRules instance the engine's ask-policy rule-consult
    // path reads (hoisted above, assigned inside the `if (agentProvider)` gate) — lets
    // `approval.respond`'s optionId-driven rule persistence share one mtime cache rather than a
    // second, independently-stale instance. `undefined` on a no-agentProvider daemon (no engine,
    // so no approval flow could ever produce a rule-bearing optionId to persist in the first
    // place) — same typed-no-op precedent as `registry`/`mcp` elsewhere in this options object.
    permissionRules,
    dirs: sessionDirs,
    trust: trustStore,
    bg: bgRegistry,
    skills: skillStore,
    plugins: pluginStore,
    // Phase 4d-ii Task 2: lets the plugin-lifecycle RPCs (plugins.install/plugin.enable/disable/
    // remove/setConsent) read+write settings.json and the plugins directory directly, and re-read
    // both fresh on every call (`livePlugins`, ipc/server.ts) instead of trusting `pluginStore`
    // above's boot-time snapshot.
    normaHome,
    // BYOK T1: the SAME SecretStore instance `authority`/`createProvider` above already use (one
    // Keychain, no separate store to keep in sync) — lets `provider.configure` write the BYO
    // OpenAI API key server-side. Chat Slice D task 3: also `sync.config`'s ONLY route to the Exa
    // key, never a second read path.
    secrets,
    // Chat Slice D task 3 (`sync.config`): the SAME shared getter Search/ReadPage/the research
    // runner already consult (constructed above, before the `if (agentProvider)` gate).
    dangerousDomainsAdded,
    // Chat Slice D task 3 (`sync.config`): the hot live-model closure built just above.
    // provider-correctness T3: its effort half. The model CATALOGUE needs no wiring here — the
    // server reads it off the `engine` it is already handed, so there is exactly one catalogue.
    liveModel,
    liveEffort,
    // Whole-branch review C1: the provider identity that makes the two above interpretable.
    liveProvider,
    mcp: mcp ?? undefined,
    // Phase 4b Task 4: the plugin tool bridge. `registry` is undefined whenever agentProvider is
    // null (see `sharedRegistry`'s doc comment above). `supervisor`, unlike `registry`, is now
    // ALWAYS defined (Phase 4d-cleanup Task 2 hoisted its construction out of the agentProvider
    // gate — its orphan-sweep duties don't need a provider) — ipc/server.ts's handlers that need
    // BOTH together (e.g. `tool.register`) still gate correctly since they check `opts.registry`
    // explicitly, not `opts.supervisor`'s presence as a proxy for it. `contrib` is always available.
    registry: sharedRegistry ?? undefined,
    supervisor: pluginSupervisor,
    contrib: pluginContrib,
    // Phase 4f Task 2: the SAME HookRegistry instance the engine's `cfg.hooks` facade (above,
    // inside the agentProvider gate) reads from — lets plugin.enable/disable/remove/setConsent
    // rebuild it hot (mirroring hotApplyStart/hotApplyStop's Tier-2 precedent), with no daemon
    // restart, even on a no-provider daemon where the facade itself was never built.
    hooks: hookRegistry,
    questions: questions ?? undefined,
    tasks: undefined,
    // P8c integration Wiring 1: lane 2's `planBridgeFor(...)` (built above), replacing the retired
    // `PlanBroker` this field used to hold — `ipc/server.ts`'s existing, unchanged `plan.respond`
    // case already calls `opts.plans?.respond(...)` generically (the `plans` field's TYPE was
    // widened to `PlanBridge` alongside this wiring).
    plans: planBridge,
    peripheral,
    providerLink,
    hardware,
    // B2 Task 2: the one pending-command registry for the whole daemon — the ipc handler resolving
    // `panel.commandResult` and (Task 4) the browser tool dispatching commands must share the SAME
    // map, or every command would time out against an empty one.
    panelCommands,
    quota,
    providerInfo,
    startedAt,
    // Phase 5 routines T3: same RoutineStore instance the `schedule` tool (inside the
    // `if (agentProvider)` gate above) and the scheduler (constructed just above this call) both
    // share — one sqlite handle for the whole daemon.
    routines: routineStore,
    // Phase 5b Task 3: the memory.* RPCs' LEGACY backing store — one single-writer promise chain
    // for the whole daemon (memory.ts's own §4.8 contract). Read/written whenever `memoryFiles`
    // below reports disabled (the escape hatch) — the RPCs never open a second store instance.
    memory: memoryStore,
    // T2 (design doc "dashboard rewire"): the SAME live enabled()/dirFor() getters the write-root
    // join and the assembler's injection already use (`memoryEnabledHot`/`memoryDirOf` above) —
    // one settings-derived decision, read hot by every consumer, not re-derived per call site.
    // `globalDir()` is the "no project" bucket (`globalMemoryDirFor`) the RPCs fall back to for a
    // cwd-less request (the CLI's `scope:"user"`, no `--project`, never passes one) — see
    // ipc/server.ts's memory.* handlers and memory-migrate.ts's own doc comment for why this is
    // the SAME bucket the importer uses for facts that don't map to a project.
    memoryFiles: { enabled: memoryEnabledHot, dirFor: memoryDirOf, globalDir: memoryGlobalDirOf },
    // CC-parity phase 3 (Workflows, Track C Task C2): `workflowRuntime` is only ever assigned
    // inside the `if (agentProvider)` gate above (B2); `workflowStore` is always built. Local-only
    // in v1 — ipc/server.ts's PLUGIN_ALLOWED_METHODS/REMOTE_ALLOWED_METHODS deliberately don't
    // gain these four verbs.
    workflows: workflowRuntime ?? undefined,
    workflowStore,
    // P8a Task 12: the mint-time reaper inside this server deletes sessions too — same hook, same
    // reach as the boot sweep above (WS-16 §16), plus the Winter child (Task 16).
    onSessionDeleted,
    // P8b Task 5: the Winter handle, on the deps object the IPC layer receives — this is the door
    // Task 16 opens a Chat session on the Winter leg through (`session.create`'s handler). Undefined
    // means the router never constructed; a Winter-leg create must then refuse with a typed error.
    runtimeSdk,
    // P8b-36: the per-session capability door, on the same deps object as the handle above.
    buildSessionCapabilities,
    // P8b Task 16: the driver table — the Winter leg's door for every `session.*` handler.
    winter: winterDrivers,
    // P8c integration round 3: lane 4's engine-era IMPORT door (`session.send`'s one-shot
    // conversion before the permanent refusal) and the handoff-aware `session.setModel` path
    // (`runtime-sdk/handoff.ts`'s `planAndApplySwitch`) — both bound to this daemon's OWN
    // home/store/records/driver table/router handle, same "typed no-op when the dep is missing"
    // precedent as every other optional field in this object. `runtime` here is the 8a spine
    // (`.records`); `runtimeSdk` is the router handle `HandoffDeps.runtime` names.
    ...(runtime === undefined ? {} : {
      importLegacy: { importSession: (sessionId: string) => importEngineEraSession({ home: normaHome, store, records: runtime.records }, sessionId) },
    }),
    // `sdk` is captured into its own `const` before the closure below: `runtimeSdk` (outer scope)
    // is a `let` reassigned inside a try/catch above, so a narrowing on it does not persist into a
    // nested arrow function — TS would otherwise still see `NormaRuntimeSdk | undefined` inside
    // `planAndApplySwitch`'s call and refuse `runtime: sdk` against `HandoffDeps.runtime`'s
    // non-optional type. `runtime` (the 8a spine, unlike the router handle) IS a `const`, so
    // `runtime.records` needs no such capture.
    ...(runtime === undefined || runtimeSdk === undefined ? {} : ((sdk: NormaRuntimeSdk) => ({
      handoff: {
        planAndApplySwitch: (sessionId: string, model: string | null, confirmLossy: boolean) =>
          planAndApplySwitch({ runtime: sdk, winter: winterDrivers, records: runtime.records, store, settings: () => settings }, sessionId, model, confirmLossy),
      },
    }))(runtimeSdk)),
    ...opts.server,
  });

  console.error(`norma-core ${CORE_VERSION} listening on ${dirs.socketPath}`);
  return {
    socketPath: dirs.socketPath,
    tokens,
    registry: sharedRegistry,
    runtimeState,
    runtimeSdk,
    sessions: store,
    buildSessionCapabilities,
    winter: winterDrivers,
    // The HOLDER, read through a closure — never `settings` captured by value, which would freeze
    // this at boot and make every hot-reload assertion above it a lie.
    settings: () => settings,
    stop() {
      // lspManager: killAllNow() FIRST delivers a synchronous SIGTERM to every warm child (the real
      // shutdown protection — mcp/pluginSupervisor's stopAll are likewise synchronous kills), since
      // the `void stopAll()` graceful path below is async and process.exit(0) (direct-run path) drops
      // its shutdown-request/.then + SIGKILL-timer before they can fire. stopAll still runs to drain
      // any in-flight spawn on the in-process (awaited) path.
      server.stop(); mcp?.stopAll(); lspManager?.killAllNow(); void lspManager?.stopAll(); pluginSupervisor.stopAll(); bgRegistry.killAll();
      settingsWatcher?.stop(); // closes the fs.watch handle on settings.json — no leaked watcher past shutdown
      routineScheduler.stop(); routineStore.close(); // no orphan tick timer past drain
      dreamer?.stop(); // no orphan dream tick timer past shutdown (unref'd already, but never left running)
      // P8a Task 12 — SHUTDOWN ORDER, and it is an order, not a list. `server.stop()` above has
      // already run, so no RPC can arrive after this point and reach a closed handle; the reaper's
      // mint-time sweep (the one caller that could still queue a runtime deletion) lives inside that
      // server and is gone with it. `runtime.close()` then clears the retention interval, DRAINS the
      // queued §16 deletions (bounded, 5s — review r1 minor 5: a delete queued microseconds before
      // shutdown has only reached the microtask queue, and dropping it strands a runtime record
      // whose session is gone), and closes `runtime-state.db`. That drain was the FIRST part of
      // teardown that could not be synchronous, which is why `stop()` hands back a promise (P8b
      // Task 5 added a second, below: ending the live Winter sessions — so `store.close()` is on
      // the async tail now too; see `RunningDaemon.stop`'s doc for the whole order), and
      // `lock.release()` — which unlinks
      // the socket, and whose absence is what `norma doctor`'s repairs check before touching this
      // file — happens strictly after the handle is closed. AWAIT IT in any path that then calls
      // `process.exit` (daemon.ts's own SIGTERM handler below, and cli/src/main.ts's `daemon run`),
      // or the process dies mid-drain with the lock still on disk.
      // P8b Task 5 (G-14) — AND IT IS PART OF THE SAME ORDER. Every live Winter session ends BEFORE
      // the router disposes (that ordering is inside `runtimeSdk.dispose()`), and the whole of it
      // happens BEFORE `store.close()` and `runtime.close()` below: a child draining its last turn
      // appends its final events into the session store and writes delivery receipts into
      // `runtime-state.db`, and a store closed underneath it loses exactly the evidence WS-15 §6.4
      // needs to tell `delivered` from `delivery_uncertain`. The router's own `dispose()` is only a
      // use-after-shutdown latch (surface map §1.11) — it kills nothing, which is why the host does.
      //
      // The failure of one session's teardown is not the daemon's: `dispose()` bounds each `end()`
      // and swallows rejections, and this `.catch` is the belt for anything it did not.
      const winterDone = runtimeSdk === undefined
        ? undefined
        : runtimeSdk.dispose().catch((err: unknown) => { console.error(`runtime-sdk: dispose failed: ${(err as Error)?.name ?? "unknown"}`); });
      const closeRest = (): void | Promise<void> => {
        store.close();
        if (!runtime) { lock.release(); return; }
        return runtime.close().then(() => lock.release(), () => lock.release());
      };
      // Synchronous when there is no Winter handle — `stop()`'s existing contract for every pre-8b
      // caller is unchanged (everything but the runtime drain has already happened on return).
      return winterDone === undefined ? closeRest() : winterDone.then(closeRest);
    },
  };
}

// Direct execution: `bun run src/daemon.ts` (also the compiled binary's `daemon run` path).
if (import.meta.main) {
  const daemon = await startDaemon();
  // AWAITED (P8a Task 12): `stop()`'s tail drains the queued runtime-state deletions and releases
  // the lock — which unlinks the socket. Exiting without awaiting would leave a stale socket file,
  // the exact regression the CLI's own `daemon run` handler was written to prevent.
  const shutdown = async () => { await daemon.stop(); process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
