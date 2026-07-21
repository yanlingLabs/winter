import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { bootstrapNormaDir, resolveNormaHome } from "./norma-dir";
import { acquireLock, type Lock } from "./lock";
import { TokenAuthority } from "./auth/tokens";
import { KeychainSecretStore, type SecretStore } from "./auth/secret-store";
import { SessionStore } from "./sessions/store";
import { SessionHub } from "./sessions/hub";
import { startIpcServer, type IpcServer, type IpcServerOptions } from "./ipc/server";
import { loadSettings, loadPermissionDirs, hooksEnabledFrom, memoryEnabledFrom, lspAutoDiagnosticsEnabledFrom } from "./settings";
import { ProjectSettingsResolver } from "./project-settings";
import { memoryDirFor, globalMemoryDirFor, assistantMemoryDirFor } from "./agent/memory-dir";
import { migrateMemoryStore } from "./agent/memory-migrate";
import { createProvider } from "./providers/manager";
import type { Provider } from "./providers/types";
import { QuotaManager } from "./providers/quota";
import { ToolRegistry } from "./agent/tools/registry";
import { registerReadTools } from "./agent/tools/fs-read";
import { registerWriteTools } from "./agent/tools/fs-write";
import { registerBashTool } from "./agent/tools/bash";
import { registerBackgroundTools } from "./agent/tools/background";
import { registerSkillTools } from "./agent/tools/skill";
import { registerToolSearchTool } from "./agent/tools/toolsearch";
import { registerAskUserTool } from "./agent/tools/ask-user";
import { registerTaskTools } from "./agent/tools/tasks";
import { registerPlanTool } from "./agent/tools/plan";
import { registerNotebookTool } from "./agent/tools/notebook";
import { registerWorktreeTools } from "./agent/tools/worktree";
import { registerSpawnAgentTool } from "./agent/tools/spawn";
import { registerSessionSpawnTool } from "./agent/tools/session-spawn";
import { DispatchChildren } from "./agent/dispatch-children";
import { registerSendMessageTool } from "./agent/tools/send-message";
import { registerTaskStopTool } from "./agent/tools/task-stop";
import { registerAgentQueryTools } from "./agent/tools/agent-query";
import { registerSkillWriteTool } from "./agent/tools/skill-write";
import { MemoryStore } from "./agent/memory";
import { registerScheduleTool } from "./agent/tools/schedule";
import { registerWebTools } from "./agent/tools/web";
import { registerComputerTool } from "./agent/tools/computer";
import { ComputerUseService } from "./agent/computer-use";
import { McpManager } from "./agent/mcp/manager";
import { registerMcpResourceTools } from "./agent/tools/mcp-resources";
import { registerPushNotificationTool } from "./agent/tools/push-notification";
import { notifyHeadless } from "./agent/notify-fallback";
import { registerLspTools } from "./agent/tools/lsp";
import { LspManager } from "./agent/lsp/manager";
import { PermissionGate, type SessionApprovalPolicy } from "./agent/gate";
import { PermissionRules } from "./agent/permission-rules";
import { ApprovalBroker } from "./agent/approvals";
import { QuestionBroker } from "./agent/questions";
import { TaskStore } from "./agent/task-store";
import { PlanBroker } from "./agent/plans";
import { WorktreeManager } from "./agent/worktree";
import { AgentStore } from "./agent/agents";
import { SubagentManager } from "./agent/subagents";
import { BackgroundAgentRegistry } from "./agent/bg-agent-registry";
import { AgentEngine, SYSTEM_PROMPT } from "./agent/engine";
import { Dreamer } from "./agent/dreamer";
import { deriveModelAliases } from "./agent/model-aliases";
import { BashReviewer } from "./agent/reviewer";
import { SessionTitler } from "./agent/titles";
import { Compactor } from "./agent/compactor";
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
import { AuditLog } from "./peripheral/audit";
import { PeripheralBroker, type PeripheralClass } from "./peripheral/broker";
import { ProviderLink } from "./peripheral/provider-link";
import { HardwareBroker } from "./peripheral/hardware";
import { openRoutineStore } from "./routines/store";
import { RoutineAuditLog } from "./routines/audit";
import { makeApply } from "./settings-apply";
import { SettingsWatcher } from "./settings-watcher";
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
  stop(): void;
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
    let approvalPolicy: SessionApprovalPolicy;
    try {
      // COUPLING (4h-i, refined 4h-ii-a): this reads the PERSISTED session policy as a proxy for
      // "the current caller's policy". That's safe because peripheral.lease is a harness-only RPC
      // (ipc/server.ts line 654), NEVER registered as an agent tool — so NO thread (main or
      // subagent, sync or async/4h-ii) can ever reach it from a tool call. If a thread-correlated
      // lease path is ever added to the registry in the future, gate approval on the calling
      // thread's policy (opts.threadId, or a thread_policy map), not the persisted session policy.
      approvalPolicy = deps.store.meta(sessionId).approvalPolicy;
    } catch {
      return "denied"; // unknown session — fail closed (ipc/server.ts already validates first)
    }
    if (approvalPolicy === "plan") return "denied";
    if (approvalPolicy === "auto") return "granted";

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

export async function startDaemon(opts: {
  home?: string;
  secrets?: SecretStore;
  server?: Partial<Pick<IpcServerOptions, "helloTimeoutMs" | "maxConnections" | "preAuthMaxLine">>;
  /** undefined: try settings.json (production default). null: agent disabled (tests, Phase 0
   *  behavior). object: use this provider directly (tests inject FakeProvider). `live`, when
   *  present, is threaded into EngineConfig.provider.live (no-restart model resolution) — tests
   *  that inject a provider directly and don't care about live resolution just omit it. */
  agentProvider?: { provider: Provider; model: string; live?: () => { model: string; reasoningEffort?: string } } | null;
} = {}): Promise<RunningDaemon> {
  const startedAt = Date.now();
  const dirs = bootstrapNormaDir(opts.home ?? resolveNormaHome());
  const lock: Lock = await acquireLock(dirs.lockPath, dirs.socketPath);

  const secrets = opts.secrets ?? new KeychainSecretStore();
  const authority = new TokenAuthority(secrets);
  const tokens = await authority.ensureTokens();

  const store = new SessionStore(dirs.home);
  const hub = new SessionHub(store);

  const normaHome = dirs.home;

  // Loaded once, up front, so the settings-derived plugin consent (below) is available before
  // the SkillStore and PluginStore are built. A malformed settings.json degrades to `null` here
  // — the agent gets disabled further down rather than crashing daemon startup.
  let settings: ReturnType<typeof loadSettings> | null;
  try {
    settings = loadSettings(dirs.settingsPath);
  } catch (err) {
    console.error(`settings unavailable, agent disabled: ${(err as Error).message}`);
    settings = null;
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
  const memoryDirOf = (cwd: string): string => memoryDirFor(cwd, { normaHome, directory: settings?.memory?.directory });
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
      migrateMemoryStore({ normaHome, trust: trustStore, directory: settings?.memory?.directory });
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
    if (!m.cwd) return [];
    const roots = [m.cwd, ...loadPermissionDirs(normaHome, m.cwd, trustStore.isTrusted(m.cwd))];
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
      const memDir = memoryDirOf(m.cwd);
      mkdirSync(memDir, { recursive: true });
      roots.push(memDir);
    }
    return roots;
  });

  // Built unconditionally (needs only store/sessionDirs, no provider) so background tasks
  // spawned before the agent is enabled (or during tests without a provider) still have a
  // registry to land in; the bg.* IPC handlers work regardless of agentProvider.
  const bgRegistry = new BackgroundTaskRegistry({
    emit: (sid, e) => hub.append(sid, e),
    spawnCtx: (sid) => {
      const m = store.meta(sid);
      return { cwd: m.cwd!, roots: sessionDirs.roots(sid), tmpDir: sessionTmpDir(sid) };
    },
  });

  // Unconditional (not gated on agentProvider): tool-call approvals need it only when the agent
  // is enabled, but peripheral lease acquisition (below) follows the SAME approval-broker
  // machinery under `ask` policy regardless of whether an LLM provider is configured — leasing is
  // an independent feature (spec §A1). An unused, empty broker behaves identically to the
  // previous `null` for approval.respond (nothing pending either way).
  const approvalBroker = new ApprovalBroker();

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

  let engine: AgentEngine | null = null;
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
  // hot-settings T5b: reassigned inside the `if (agentProvider)` gate below (built only when the
  // engine/registry exist to hot-apply against); declared here (function scope, outside the gate)
  // so the shutdown path past the gate's close can still stop() it regardless of agentProvider.
  let settingsWatcher: SettingsWatcher | null = null;
  let questions: QuestionBroker | null = null;
  let taskStore: TaskStore | null = null;
  let plans: PlanBroker | null = null;
  // ipc/server.ts (Phase 4b Task 4) needs the SAME ToolRegistry instance the engine executes tool
  // calls against, to register/unregister `plugin__<id>__<tool>` tools — but startIpcServer() is
  // called OUTSIDE the `if (agentProvider)` block below, where the registry is constructed.
  // Mirrored into this outer binding right after construction rather than hoisting the `const`
  // itself, so every existing narrowed (non-null) use of `registry` inside the block is untouched.
  let sharedRegistry: ToolRegistry | null = null;

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
    registerReadTools(registry, { deniedPrefixes: [dirs.runDir] });
    registerWriteTools(registry);
    registerBashTool(registry, { bgRegistry }); // bash itself is NEVER deferred — only its background-poll tool below (bash_output; task_stop, below, is the sole way to kill one)
    registerBackgroundTools(registry, { bgRegistry }, { deferred: true });
    registerSkillTools(registry, { skills: skillStore });
    registerToolSearchTool(registry);
    questions = new QuestionBroker();
    taskStore = new TaskStore();
    registerAskUserTool(registry);
    registerTaskTools(registry, { tasks: taskStore });
    plans = new PlanBroker();
    registerPlanTool(registry, { deferred: true });
    registerNotebookTool(registry, { deferred: true });
    registerPushNotificationTool(registry); // task-30: deferred:true is baked into the tool's own registration
    // hot-settings T2: getter over the live `settings` holder (was a boot-captured value) — a
    // later task's watcher reassigns `settings` in place; this closure re-reads it on the NEXT
    // enter_worktree/spawn isolation call, no WorktreeManager reconstruction needed.
    const worktrees = new WorktreeManager({ baseRef: () => settings?.worktree?.baseRef });
    registerWorktreeTools(registry, { deferred: true });
    // 4g Task 5: web_fetch — Norma's ONLY sanctioned network egress (bash's sandbox denies network
    // by design). Shares the SAME `audit` appender instance as peripheral/hardware below (hoisted
    // above this gate for exactly this reason) — every call (success, ssrf-refusal, http error,
    // timeout) gets one `{kind:"network", tool:"web_fetch", url, outcome}` line on audit.jsonl.
    // 4g Task 6: web_search's Brave API key rides the SAME `secrets` store (KeychainSecretStore,
    // built at the top of startDaemon) `norma login --web-search-key` writes into — one
    // SecretStore instance, one Keychain, no separate store to keep in sync.
    registerWebTools(registry, { audit: (line) => audit.append(line), secret: (name) => secrets.get(name) });
    const agents = new AgentStore({
      normaHome, trust: trustStore, baseInstructions: SYSTEM_PROMPT,
      plugins: { disabled: settings?.plugins?.disabled ?? [] },
    });
    // hot-settings T2: getters over the live `settings` holder (was a boot-captured value) — a
    // later task's watcher reassigns `settings` in place; these closures re-read it on the NEXT
    // acquire()/run(), no SubagentManager reconstruction needed. No-timeout task (user rule
    // 2026-07-12): `timeoutMs` absent from settings → NO wall clock (the manager has no default
    // one anymore); `stallTimeoutMs` absent → the manager's own 600s progress-stall default.
    // Both hot — a settings edit applies to the very next subagent run, no daemon restart.
    const subagents = new SubagentManager({
      maxConcurrent: () => settings?.subagents?.maxConcurrent,
      timeoutMs: () => settings?.subagents?.timeoutMs,
      stallTimeoutMs: () => settings?.subagents?.stallTimeoutMs,
    });
    // Async spawn (4h-ii-a): tracks DETACHED (`run_in_background:true`) child threads — see
    // bg-agent-registry.ts's own doc comment for why this is separate from `bgRegistry` above
    // (that one owns backgrounded bash processes; this one owns agent threads). Built
    // unconditionally alongside `subagents` — both are required together for the spawn bridge's
    // async branch to activate (engine.ts's EngineConfig.bgAgents doc comment).
    const bgAgents = new BackgroundAgentRegistry();
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
    const knownModelIds = agentProvider.provider.models().map((m) => m.id);
    registerSpawnAgentTool(registry, { models: [...knownModelIds, ...deriveModelAliases(knownModelIds)] });
    // Dispatch (Phase 7) Task 4: session_spawn — registered unconditionally alongside spawn_agent
    // (both live on the SAME shared `registry`; engine.ts's SESSION_SPAWN_TOOL exclusion is what
    // actually keeps it out of a code session's tool list — registering it here doesn't by itself
    // make it code-visible). SAME models list as spawn_agent (full ids + their unambiguous short
    // aliases) so the bridge's alias resolution (engine.ts) always accepts whatever this tool's own
    // schema enum advertised.
    registerSessionSpawnTool(registry, { models: [...knownModelIds, ...deriveModelAliases(knownModelIds)] });
    // 4h-ii-b Task 4 (CC SendMessage): registered alongside spawn_agent (only when subagents are
    // available) so the MAIN thread can address a subagent by agentId/name — a running one gets the
    // message at its next step, a finished one is resumed with it. Like spawn_agent it's an engine
    // bridge; this DEF is what the model sees, the engine intercepts the call (see engine.ts's
    // sendMessageCalls bridge). Excluded from every child's tool set (depth-0 only).
    registerSendMessageTool(registry);
    // 4h-ii-c Task 2 (CC TaskStop): registered alongside spawn_agent/send_message — the SAME
    // `bgAgents`/`bgRegistry` instances the engine cfg gets below, so a stop here is visible to
    // the engine's own pin/completion-reminder bookkeeping. Unlike spawn_agent/send_message this
    // is a PLAIN TOOL (no engine bridge — see task-stop.ts's own doc comment), deferred like
    // bash_output (registerBackgroundTools above) — CC parity: one generic stop tool, no separate
    // bash_kill (removed; task_stop's bash-unify path is now the only way to kill a bg bash task).
    // Dispatch (Phase 7) Task 5: `dispatch` closes over the `dispatchChildren` binding declared
    // further down (before `new AgentEngine(...)`) — safe (same later-assigned-closure shape as
    // `engine?.transcriptPathFor` a few lines below): this closure is only ever INVOKED at a real
    // task_stop call, long after boot finishes assigning it.
    registerTaskStopTool(registry, { bgAgents, bgRegistry, deferred: true, dispatch: { stopChild: (caller, id) => dispatchChildren?.stopChild(caller, id) } });
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
    registerAgentQueryTools(registry, { bgAgents, store, transcriptPathFor: (sid, tid) => engine?.transcriptPathFor(sid, tid) });
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
    registerSkillWriteTool(registry, { skills: skillStore });
    // Computer use (Phase 5 CU): opt-in via settings.computerUse.enabled (the strongest reading of
    // "full-auto CU requires explicit opt-in" — absent/false, the `computer` tool does not exist).
    // The service holds leases on the SAME `peripheral` broker (hoisted above this gate) that
    // Norma.app serves screenshot/ax-read/input-drive behind. reuses settings.peripheral.heartbeatMs.
    let computerUse: ComputerUseService | undefined;
    if (settings?.computerUse?.enabled) {
      computerUse = new ComputerUseService({ broker: peripheral, heartbeatMs: settings?.peripheral?.heartbeatMs });
      registerComputerTool(registry, { screenshotMaxDim: settings?.computerUse?.screenshotMaxDim });
    }
    // Phase 5 routines T3 (design doc §4): the agent-facing management surface over the SAME
    // `routineStore` instance the scheduler (below, past this gate's close) fires against —
    // `routineStore` is hoisted above this gate for exactly this sharing (see its own doc comment).
    // Deferred like worktree/notebook/plan above — a specialized tool, not needed in every turn.
    registerScheduleTool(registry, { routines: routineStore }, { deferred: true });
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
    if (lspCfg?.enabled !== false) {
      lspManager = new LspManager({ idleShutdownMs: lspCfg?.idleShutdownMs });
      registerLspTools(registry, { lsp: lspManager, cwdOf, rootsOf, tmpDirOf });
    }
    mcp = new McpManager({ registry, trust: trustStore, log: (m) => console.error(m) });
    // MCP resources (CC parity: ListMcpResourcesTool/ReadMcpResourceTool) — registered
    // unconditionally here (not per-server-connect: see mcp-resources.ts's own doc comment for why
    // a live conditional-registration mirror of CC isn't cheap with this registry's shape) so it
    // exists across every later startAll/ensureProject/startPlugins call this `mcp` instance ever
    // makes. Deferred like schedule/notebook_edit/worktree above — specialized, not needed most
    // turns.
    registerMcpResourceTools(registry, { mcp }, { deferred: true });
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

    const compactor = new Compactor({ provider: agentProvider, store, hub });
    // hot-settings T2 review: ALWAYS constructed, never gated on the boot-time reviewer.enabled.
    // The BashReviewer constructor is inert (stores provider/model/timeoutMs refs only — no I/O,
    // spawns nothing; review() is what does work, and it's only ever reached through the engine's
    // `reviewerEnabled?.() !== false` gate). Building it unconditionally is what makes
    // reviewer.enabled hot in BOTH directions: were it left undefined at a disabled-boot, a later
    // false→true edit could never take effect (the getter gates whether review RUNS, but only if
    // there's a reviewer object to run) — a restart-required toggle, which the "no restart
    // anywhere" rule forbids. `reviewer.model` stays a boot snapshot (out of T2's scope — it
    // picks WHICH model the reviewer would use, not whether reviewing is on).
    const reviewerCfg = settings?.reviewer;
    const reviewer = new BashReviewer({ provider: agentProvider, model: reviewerCfg?.model });
    // Default ON: the titler is built unless settings.titles.enabled is explicitly false.
    const titlesCfg = settings?.titles;
    const titler =
      titlesCfg?.enabled === false ? undefined : new SessionTitler({ provider: agentProvider, store, hub, model: titlesCfg?.model });
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
    const hooksEnabledHot = (): boolean => (settings ? hooksEnabledFrom(settings) : true);
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
      const s = projectSettings.effective(cwd ?? null);
      return s ? lspAutoDiagnosticsEnabledFrom(s) : true;
    };
    const hookFacade = new HookFacade({ registry: hookRegistry, runner: new HookRunner(), hooksEnabled: hooksEnabledHot });
    // Dispatch (Phase 7) Task 4: declared BEFORE `engine` is constructed (computerUse precedent —
    // see EngineConfig.dispatch's own doc comment, engine.ts) so the `dispatch: () =>
    // dispatchChildren` getter below closes over this SAME binding; assigned right after
    // `new AgentEngine(...)` returns, since DispatchChildren.spawnChild needs `engine.runTurn`/
    // `engine.isRunning`, which don't exist until the engine itself does.
    let dispatchChildren: DispatchChildren | undefined;
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
    engine = new AgentEngine({
      store, hub, registry, broker: approvalBroker,
      gate: new PermissionGate(),
      // SP-approvals Task 3: the CC-grammar allow-rules store (Task 1) — plain instance, not a
      // getter (mirrors `gate` just above): PermissionRules is already "hot" internally (its own
      // mtime-cached project-rules-file read, re-checked on every decision()/rulesFor() call), and
      // `globalAllow` is the live-settings thunk that makes the GLOBAL side hot too — this reads
      // `settings` (the SAME reassignable holder every other hot-settings getter in this file
      // closes over) fresh on every call, so a settings.json edit to `permissions.allow` applies
      // with no daemon restart, exactly like reviewerAllow/reviewerEnabled below.
      //
      // THE `["Computer"]` DEFAULT LIVES IN THIS GETTER FALLBACK, deliberately NOT inside
      // PermissionRules itself (see that class's own doc comment, "Spec deviation"): CC parity
      // wants a fresh session's `computer` tool calls pre-approved out of the box, but the default
      // must be overridable — an explicit `"permissions": { "allow": [] }` in settings.json
      // disables it outright (the `?? ["Computer"]` fallback only fires when the key is ABSENT,
      // never when it's present-but-empty), while an absent `permissions` block (or an absent
      // `allow` key within it) gets the default. normaHome is the SAME control-plane path passed
      // to `grantDeniedPrefixes` below — PermissionRules uses it only to refuse writing a
      // project-scoped rule file inside Norma's own home (append()'s control-plane guard), never
      // to read/write settings.json's global rules itself (that's what the globalAllow thunk +
      // this class's OWN read-modify-write in append(scope:"global") are for).
      permissionRules,
      // SP-approvals Task 10 (spec §7): the user-added half of web_fetch's dangerous-domain floor
      // — same live-getter shape as `globalAllow` just above, so an edit to
      // `permissions.dangerousDomains.added` applies with no daemon restart. Absent block/field
      // both resolve to `undefined`, which engine.ts's `?? []` treats as "no user additions" — the
      // shipped list alone still applies.
      // Task 7: now resolved per-project through the SAME `projectSettings` instance `globalAllow`
      // uses above — `cwd` is the calling session's cwd (engine.ts's webFetchGate passes its own
      // param straight through); `effective(cwd ?? null)` degrades to `settings` verbatim for a
      // null/untrusted/overlay-less cwd, so this reads byte-identically to the pre-Task-7 getter
      // whenever no project overlay applies.
      dangerousDomainsAdded: (cwd) => projectSettings.effective(cwd ?? null)?.permissions?.dangerousDomains?.added,
      dirs: sessionDirs,
      // write-permission-flow F2: the out-of-root write/edit grant flow must never silently grant
      // any part of Norma's OWN home directory. This is BROADER than the READ denylist above
      // (which locks only `dirs.runDir` — the rest of normaHome stays readable by design) on
      // purpose: a GRANT is strictly higher-risk than a read — it opens the directory to WRITE,
      // and because bash's seatbelt shares the session's write roots, to bash too. normaHome holds
      // the control plane (run/: IPC socket, lock, plugin PID files) AND Norma's managed internal
      // state (sessions/, logs/, plugins/, and crucially projects/<key>/memory — the per-project
      // MEMDIR). The MEMDIR is the load-bearing case: when memory is ENABLED it's already a session
      // BASE root (sessionDirs above), so a write there is in-root and never reaches the grant flow
      // — but when memory is DISABLED it is deliberately NOT a root, and without this an auto-policy
      // write could silently re-grant it, quietly defeating the memory-disable gate (and writing
      // into ~/.norma). The agent never has a legitimate need to be *granted* write access to
      // Norma's own home — its legitimate MEMDIR access comes from memory being enabled (a base
      // root), not from a grant. Realpath-hardened in engine.ts's grantDenied, bidirectional
      // (an ancestor of normaHome is refused too — see grantDenied's doc comment).
      grantDeniedPrefixes: [normaHome],
      provider: agentProvider,
      assembler,
      compactor,
      mcp: mcp ?? undefined,
      questions: questions ?? undefined,
      tasks: taskStore ?? undefined,
      plans: plans ?? undefined,
      setPolicy: (sid, pol) => store.setApprovalPolicy(sid, pol),
      worktrees,
      bgRegistry,
      agents,
      subagents,
      bgAgents,
      // 4h-i Task 3: undefined (settings.subagents.maxDepth unset) → engine.ts's runThread
      // defaults it to 5 itself (`subagentMaxDepth?.() ?? 5`) — mirrors the maxConcurrent line
      // above, which leans on SubagentManager's own internal default the same way. hot-settings
      // T2: getter over the live `settings` holder, not the boot-captured value — see
      // `worktrees`/`subagents` above for the same shape.
      subagentMaxDepth: () => settings?.subagents?.maxDepth,
      reviewer,
      // hot-settings T2: these three read the LIVE `settings` holder directly (NOT the
      // boot-captured `reviewerCfg` above, which only decides whether the BashReviewer object
      // itself gets constructed — that decision stays a one-time boot snapshot, out of T2's
      // scope). A later task's watcher reassigns `settings` in place; engine.ts calls each getter
      // fresh per read site, so a reviewer.enabled/allow/classes edit applies with no engine
      // reconstruction.
      // Task 8 (CC project-folder-mechanics): now resolved per-project through the SAME
      // `projectSettings` instance `dangerousDomainsAdded`/`globalAllow` above use — `cwd` is the
      // calling session's cwd (engine.ts's dispatch-loop/runThread locals, threaded straight
      // through); `effective(cwd ?? null)` degrades to `settings` verbatim for a
      // null/untrusted/overlay-less cwd, so this reads byte-identically to the pre-Task-8 getter
      // whenever no project overlay applies. The reviewer OBJECT itself (`reviewer` just above)
      // stays a single boot-constructed instance shared by every project — only whether it's
      // CONSULTED for a given cwd is per-project (mirrors the doc comment on `reviewerCfg`/
      // `lspAutoDiagnosticsHot`: which reviewer model to use is a boot snapshot; whether reviewing
      // runs at all is hot, and now project-scoped too).
      reviewerEnabled: (cwd) => projectSettings.effective(cwd ?? null)?.reviewer?.enabled,
      reviewerAllow: (cwd) => projectSettings.effective(cwd ?? null)?.reviewer?.allow ?? [],
      // Phase 5e T4: raw pass-through — engine.ts's reviewClassEnabled already treats an absent
      // object/key as enabled, and reviewerEnabled:false already short-circuits before this is
      // ever consulted (see its own doc comment), so no extra defaulting belongs here.
      reviewerClasses: (cwd) => projectSettings.effective(cwd ?? null)?.reviewer?.classes,
      titler,
      // hot-settings T5a/T5b: EngineConfig.computerUse is a getter (engine.ts) over the SAME `let
      // computerUse` holder assigned at boot above (~line 423) — T5b (below, after this engine is
      // constructed) builds the apply callbacks that reassign that holder (registerComputer sets
      // it, teardownComputer clears it) as settings.json changes, so this closure — unchanged since
      // T5a — now resolves LIVE: a hot enable/disable is visible on this session's NEXT tool ctx
      // with no engine reconstruction.
      computerUse: () => computerUse,
      // lsp-consolidation T3: mirrors `computerUse`'s own getter-over-a-hot-rebuilt-holder shape —
      // `lspManager` is the SAME `let` binding registerLsp/teardownLsp (settings-apply.ts, below)
      // reassign on an `lsp.enabled` hot flip, so this resolves live: a disable is invisible to a
      // NEW tool call the instant teardownLsp clears the holder, no engine reconstruction. `??
      // undefined` just normalizes the `LspManager | null` holder to EngineConfig's `| undefined`
      // field type (the getter itself, not the holder, is what's optional on EngineConfig).
      lsp: () => lspManager ?? undefined,
      autoDiagnosticsEnabled: lspAutoDiagnosticsHot,
      // Task 8 (CC project-folder-mechanics): each sub-getter now resolves through the SAME
      // `projectSettings` instance the reviewer getters above use — `cwd` is engine.ts's
      // toolSearchEnabled/Threshold/DeferExternals param, threaded from every one of their own
      // call sites (buildInstructionsFull, runThread, executeCall). `effective(cwd ?? null)`
      // degrades to `settings` verbatim for a null/untrusted/overlay-less cwd, so this reads
      // byte-identically to the pre-Task-8 getters whenever no project overlay applies — the
      // deferThreshold env fallback is UNCHANGED, still consulted whenever the resolved effective
      // settings (global or project-merged) don't set one.
      toolSearch: {
        enabled: (cwd) => projectSettings.effective(cwd ?? null)?.toolSearch?.enabled,
        deferThreshold: (cwd) => projectSettings.effective(cwd ?? null)?.toolSearch?.deferThreshold ?? Number(process.env.NORMA_TOOLSEARCH_THRESHOLD ?? 12),
        deferExternals: (cwd) => projectSettings.effective(cwd ?? null)?.toolSearch?.deferExternals,
      },
      hooks: hookFacade,
      // Subagent transcript files (CC parity): the SAME session-tmp-dir accessor registerLspTools
      // above already gets — sessionTmpDir-backed, so a subagent's transcript lands right next to
      // whatever else this session's tools already write there (web_fetch's saved pages, bg-task
      // output), inside the SAME sandbox-readable root.
      tmpDirOf,
      // task-30 (push-notification track): the real osascript-shelling implementation — the
      // engine's `notify` bridge only calls this when hub.attachedCount(sessionId) === 0 at
      // emission time (see engine.ts's executeCall). Boot-constant (no settings gate — v1 keeps
      // this always-on, matching the task's "keep it simple" design).
      notifyFallback: notifyHeadless,
      dispatch: () => dispatchChildren,
      // Dispatch (Phase 7) Task 5: both getters — same live-closure-over-`dispatchChildren` shape
      // as `dispatch` just above, so a call before `dispatchChildren` is assigned (can't happen:
      // no turn runs before construction finishes) would just no-op via `?.`.
      onTurnEnd: (sid) => dispatchChildren?.onTurnEnd(sid),
      dispatchRoster: (sid) => dispatchChildren?.rosterFor(sid),
    });
    // Dispatch (Phase 7) Task 4: constructed AFTER `engine` exists — its `runTurn`/`isRunning`
    // deps close over `engine!` (non-null: this whole block only runs once `engine` is assigned
    // just above, mirroring `registerAgentQueryTools`' own `engine?.transcriptPathFor` lazy-closure
    // precedent a few dozen lines up). Reassigns the SAME `dispatchChildren` binding the
    // `dispatch: () => dispatchChildren` getter above already closes over — no engine
    // reconstruction needed, same shape as `computerUse`'s own post-construction assignment.
    // Task 5 adds `interrupt` (engine.interrupt, the SAME mechanism task_stop already uses for bg
    // agents) — stopChild's dep — and, once constructed, `start()`: rebuilds the child set from
    // the store (daemon-restart recovery) and subscribes to the hub's observer fan-out.
    dispatchChildren = new DispatchChildren({
      store, hub,
      runTurn: (sid) => engine!.runTurn(sid),
      isRunning: (sid) => engine!.isRunning(sid),
      interrupt: (sid) => { engine!.interrupt(sid); },
    });
    dispatchChildren.start();

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
      activeTurnCount: () => engine?.activeTurnCount() ?? 1, // no engine yet -> treat as busy
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
        registerComputerTool(registry, { screenshotMaxDim: s?.computerUse?.screenshotMaxDim });
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
        lspManager = mgr;
        registerLspTools(registry, { lsp: mgr, cwdOf, rootsOf, tmpDirOf }); // SAME session-meta sources as the boot registration above
      },
      teardownLsp: async () => {
        registry.unregister("lsp");
        const m = lspManager;
        lspManager = null;
        await m?.stopAll();
      },
      // File-based memory hot-toggle (T3, design doc follow-up / task-23): the SAME boot-time call
      // above (`migrateMemoryStore({ normaHome, trust: trustStore, directory: settings?.memory?.directory })`),
      // re-run whenever `memory.enabled` flips false→true on THIS running daemon — closes T2's
      // "boot-time only" gap. `settings` here is read at the moment this closure actually RUNS
      // (fire-and-forget, deferred a tick past `apply()`'s synchronous `setLiveSettings` swap), so
      // it already reflects `next`'s own `memory.directory` override, exactly like the boot-time
      // call reflects the settings loaded at THAT time. Failures are logged by settings-apply.ts's
      // own `.catch` (this closure just re-throws/returns whatever `migrateMemoryStore` does);
      // never touches/deletes the old store either way (memory-migrate.ts's own contract).
      migrateMemory: () => { migrateMemoryStore({ normaHome, trust: trustStore, directory: settings?.memory?.directory }); },
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
  const routineRunner = makeDaemonRoutineRunner({ store, hub, engine });
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

  const server: IpcServer = startIpcServer({
    socketPath: dirs.socketPath,
    serverVersion: CORE_VERSION,
    tokens: authority,
    store,
    hub,
    engine,
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
    // OpenAI API key server-side.
    secrets,
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
    tasks: taskStore ?? undefined,
    plans: plans ?? undefined,
    peripheral,
    providerLink,
    hardware,
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
    ...opts.server,
  });

  console.error(`norma-core ${CORE_VERSION} listening on ${dirs.socketPath}`);
  return {
    socketPath: dirs.socketPath,
    tokens,
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
      store.close(); lock.release();
    },
  };
}

// Direct execution: `bun run src/daemon.ts` (also the compiled binary's `daemon run` path).
if (import.meta.main) {
  const daemon = await startDaemon();
  const shutdown = () => { daemon.stop(); process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
