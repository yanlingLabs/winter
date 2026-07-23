import { chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import {
  ERR, METHODS, PROTOCOL_VERSION, LineDecoder, encodeLine, parseIncoming,
  HelloParams, SessionCreateParams, SessionDispatchParams, SessionAttachParams, SessionSendParams, ApprovalRespondParams,
  SessionHistoryParams,
  ApprovalListParams,
  SessionAddDirParams, SessionSetCwdParams, TrustDirParams,
  BgListParams, BgPeekParams, BgKillParams, BgKillAllParams,
  SessionSteerParams, SessionInterruptParams, SessionCompactParams, SkillsListParams, McpListParams,
  SkillsReadParams, SkillsWriteParams, SkillsDeleteParams,
  PluginsListParams, AskUserRespondParams, TaskListParams, PlanRespondParams, SessionSetPolicyParams,
  ThreadListParams, ThreadSendParams, AgentStopParams,
  PeripheralLeaseParams, PeripheralRenewParams, PeripheralReleaseParams, PeripheralAdvertiseParams,
  PeripheralRevokeParams, PeripheralRespondParams, DaemonStatusParams, EngineActivityParams, QuotaStateParams,
  TrustListParams, TrustRemoveParams, PluginRevokeTokenParams, PluginRestartParams,
  PluginRegisterParams, ToolRegisterParams, ShortcutRegisterParams, TileUpdateParams,
  ProviderRegisterParams, PluginsContribParams, PluginToolResultParams, HardwareRequestParams, HardwareRespondParams,
  ShortcutInvokeParams, TileActionParams,
  PluginsInstallParams, PluginEnableParams, PluginDisableParams, PluginRemoveParams, PluginSetConsentParams,
  RoutinesCreateParams, RoutinesListParams, RoutinesUpdateParams, RoutinesDeleteParams,
  MemoryListParams, MemoryReadParams, MemoryWriteParams, MemoryDeleteParams, MemoryAuditParams,
  ProviderConfigureParams,
  WorkflowListParams, WorkflowRunParams, WorkflowStopParams, WorkflowGetParams,
  SYSTEM_SESSION_ID,
  type SessionEvent, ConnWriter, type WritableSocket,
} from "@norma/protocol";
import type { TokenAuthority } from "../auth/tokens";
import type { SecretStore } from "../auth/secret-store";
import { OPENAI_API_KEY_SECRET } from "../providers/manager";
import type { RoutineStore } from "../routines/store";
import type { WorkflowRuntime } from "../workflows/runtime";
import type { WorkflowStore } from "../workflows/store";
import type { MemoryStore, MemoryErrorKind } from "../agent/memory";
import { listMemoryDir, readMemoryDir, writeMemoryDir, deleteMemoryDir, auditTailMemDir } from "../agent/memory-file-ops";
import type { SessionStore } from "../sessions/store";
import { readHistoryPage } from "../sessions/history";
import { SessionHub, type HubClient } from "../sessions/hub";
import type { AgentEngine } from "../agent/engine";
import type { ApprovalBroker } from "../agent/approvals";
import type { PermissionRules } from "../agent/permission-rules";
import { repoRootFor } from "../agent/memory-dir";
import type { QuestionBroker } from "../agent/questions";
import type { TaskStore } from "../agent/task-store";
import type { PlanBroker } from "../agent/plans";
import type { SessionDirectories } from "../agent/dirs";
import type { TrustStore } from "../agent/trust";
import type { BackgroundTaskRegistry } from "../agent/bg-registry";
import type { SkillStore, SkillErrorKind } from "../agent/skills";
import type { McpManager } from "../agent/mcp/manager";
import { PluginStore, type PluginInfo } from "../agent/plugins";
import { pluginSpawnEligible, hookRegistryPlugins } from "../agent/plugins";
import type { ToolRegistry } from "../agent/tools/registry";
import type { PluginSupervisor, PluginConn, InvokeError, EligiblePlugin, SupervisorStatus } from "../plugins/supervisor";
import type { PluginContribRegistry } from "../plugins/contrib";
import type { HookRegistry } from "../plugins/hook-registry";
import type { PeripheralBroker } from "../peripheral/broker";
import type { ProviderLink } from "../peripheral/provider-link";
import type { HardwareBroker } from "../peripheral/hardware";
import { verbClass } from "../peripheral/hardware";
import type { QuotaManager } from "../providers/quota";
import { addLocalDir, loadSettings, saveSettings, type Settings } from "../settings";
import {
  deriveInstallName, installPluginFromDir, missingConsents, buildConsentBlock, applyFreshPluginConsent,
  setPluginEnabled, grantPluginConsents, removePluginFromSettings, removePluginDir, stripPluginConsents,
  type InstallPluginResult,
} from "../plugins/lifecycle";

interface ConnState {
  decoder: LineDecoder;
  authedRole: string | null;
  clientName: string;
  hubClient: HubClient | null;
  helloTimer: ReturnType<typeof setTimeout> | null;
  writer: ConnWriter;
  // Phase 4b Task 2: set on a successful role:"plugin" hello (the specific installed plugin id
  // this connection authenticated as); null for every other role. Consumed by Task 3/4's
  // supervisor wiring (notifyRegistered/tool bridge) to correlate a connection to its plugin.
  pluginId: string | null;
  // Remote Gateway SP1 Task 2: per-connection idempotency cache for `authedRole === "remote"`
  // callers only (see the data() pump). Insertion-ordered so the oldest entry is always
  // `.keys().next().value` — a cheap LRU-by-insertion once capped at 256 entries. Caches
  // SUCCESSFUL results only (a thrown RpcFailure is never stored), so a retry after a transient
  // failure still re-attempts.
  seenCommands: Map<string, unknown>;
}

export interface IpcServerOptions {
  socketPath: string;
  serverVersion: string;
  tokens: TokenAuthority;
  store: SessionStore;
  hub?: SessionHub;          // shared with the agent engine when the daemon wires one up
  engine?: AgentEngine | null;
  broker?: ApprovalBroker | null;
  // SP-approvals Task 5: the CC-grammar allow-rules store (Task 1) — daemon.ts hoists ONE instance
  // shared with the engine's own ask-policy rule-consult path, so `approval.respond`'s optionId-
  // driven `append()` below and the dispatch loop's `decision()` reads share the SAME mtime cache,
  // never two independently-stale copies. Optional: a server built without one (most existing
  // tests, and any daemon with no agentProvider) makes a rule-bearing optionId a silent no-op —
  // same "typed no-op, never a crash" precedent as `broker`/`dirs`/etc below — since without an
  // engine there is no approval flow that could ever produce a rule-bearing optionId to persist.
  permissionRules?: PermissionRules;
  dirs?: SessionDirectories; // live allowed-roots per session; addDir/setCwd need it
  trust?: TrustStore;        // per-directory trust; session.create result + daemon.trustDir
  bg?: BackgroundTaskRegistry; // background bash tasks; bg.list/peek/kill/killAll
  skills?: SkillStore;       // discovered SKILL.md skills; skills.list/read/write/delete (5c T3)
  mcp?: McpManager;          // MCP servers started at boot; mcp.list
  plugins?: PluginStore;     // discovered ~/.norma/plugins/*; plugins.list
  // Phase 4d-ii Task 2: `<normaHome>/settings.json` + `<normaHome>/plugins/` — the SAME
  // convention `bootstrapNormaDir` (norma-dir.ts) and every other normaHome-taking store
  // (PluginStore, SkillStore, ContextAssembler, …) already assumes. Lets the plugin-lifecycle
  // RPCs below (plugins.install/plugin.enable/disable/remove/setConsent) read+write settings.json
  // and the plugins directory directly, and re-derive a FRESH `PluginStore` per call (`livePlugins`
  // below) instead of trusting `plugins` above, whose `enabled`/`disabled`/`consents` deps are a
  // snapshot captured once at daemon boot and never updated — exactly the staleness this task's
  // "applied HOT, no restart" requirement exists to fix. Optional: a server built without it (most
  // existing tests) keeps working via `livePlugins`'s fallback to the boot-time `plugins` above;
  // the five lifecycle RPCs themselves become a typed INTERNAL failure (never a crash) when a
  // caller actually invokes them with no `normaHome` wired.
  normaHome?: string;
  // BYOK T1 (design doc `2026-07-16-byok-provider-setup-design.md` §1): the daemon's OWN
  // SecretStore — threaded here so `provider.configure` can write the BYO OpenAI API key
  // server-side (never a Swift/Keychain write, avoiding the Bun.secrets item-format mismatch the
  // design doc's recon flagged). Optional, same "typed INTERNAL failure, never a crash" precedent
  // as `normaHome` above: a server built without one (most existing tests) makes
  // `provider.configure` a typed failure rather than throwing on construction. daemon.ts always
  // wires its own `secrets` (KeychainSecretStore by default, `startDaemon({secrets})`-injectable
  // for tests) into this field.
  secrets?: SecretStore;
  // Phase 4b Task 4 (spec §3): the plugin tool bridge. `registry` is the SAME ToolRegistry the
  // AgentEngine executes tool calls against (daemon.ts shares the one instance) — tool.register
  // registers `plugin__<pluginId>__<tool>` into it; the socket close() handler and the
  // supervisor's onCircuitOpen callback unregister a plugin's tools out of it. `supervisor`
  // brokers plugin.register/tool.register's bridged run()/plugin.toolResult against
  // PluginSupervisor (Task 3). `contrib` is latest-per-plugin storage for shortcut.register/
  // tile.update/provider.register (Phase 4d's read surface). `registry`/`supervisor` are normally
  // undefined together (no agentProvider ⇒ no ToolRegistry at all) — tool.register then throws a
  // typed RpcFailure rather than crashing; plugin.register/plugin.toolResult degrade to a bare
  // `{ok:true}` no-op (same precedent as `mcp`/`plans`/`tasks` above).
  registry?: ToolRegistry;
  supervisor?: PluginSupervisor;
  contrib?: PluginContribRegistry;
  // Phase 4f Task 2: the SAME HookRegistry instance daemon.ts builds and wires into the engine's
  // `cfg.hooks` facade — the plugin-lifecycle RPCs below (plugin.enable/disable/remove/setConsent)
  // rebuild it hot, off `livePlugins()`'s fresh read, at every point they already call
  // `invalidateLivePluginsCache()`. Optional: a server built without it (most existing tests) just
  // skips the rebuild — same "typed no-op, never a crash" precedent as `registry`/`supervisor`
  // being absent elsewhere in this file.
  hooks?: HookRegistry;
  questions?: QuestionBroker; // in-flight ask_user questions; ask_user.respond
  tasks?: TaskStore;         // session task lists; task.list
  plans?: PlanBroker;        // in-flight exit_plan_mode plans; plan.respond
  peripheral?: PeripheralBroker; // lease machinery; peripheral.* verbs (Phase 2f)
  providerLink?: ProviderLink;   // bridges PeripheralBroker.call()'s pushToProvider to the live
                                  // provider connection this server tracks (Phase 2f)
  // Phase 4c Task 2 (spec §5): plugin (or harness, dev/testing) → Norma.app's XPC helper.
  // `hardware` is constructed with the SAME `providerLink` as `peripheral` above (daemon.ts) — the
  // app's one provider connection doubles as the hardware provider. `hardware.respond` reuses
  // `peripheral.isProvider()` to gate on that SAME connection identity (see the hardware.respond
  // case below) rather than tracking its own.
  hardware?: HardwareBroker;
  quota?: QuotaManager;      // token/rate-limit snapshot; quota.state (dashboard read)
  // Phase 5 routines T3 (design doc §3): the daemon-owned RoutineStore backing routines.*
  // (create/list/update/delete). Optional — same "typed no-op, never a crash" precedent as
  // `bg`/`skills`/`mcp` above: a server built without one (most existing tests) degrades
  // routines.list to an empty list and routines.create/update to a typed INTERNAL RpcFailure,
  // rather than throwing on construction.
  routines?: RoutineStore;
  // Phase 5b Task 3 (design doc §4): the daemon-owned MemoryStore backing memory.* (list/read/
  // write/delete/audit) — the SAME instance T2's memory_read/write/delete tools run against
  // (daemon.ts hoists ONE MemoryStore for exactly this sharing; a second instance would split the
  // single-writer promise chain §4.8 requires). Optional — same "typed no-op, never a crash"
  // precedent as `routines` above, with a deliberate per-verb split when unset: the COLLECTION
  // reads (memory.list/memory.audit) degrade to empty results (routines.list precedent), while
  // memory.read/write/delete fail hard with a typed INTERNAL RpcFailure — a mutation (or a
  // single-fact read a caller acts on) silently no-oping would mask a wiring bug.
  memory?: MemoryStore;
  // T2 (design doc "dashboard rewire"), extended by T3 to memory.audit: when `enabled()` is true,
  // memory.list/read/write/delete/audit below operate on MEMDIR files (`dirFor(cwd)` for a
  // request that carries a `cwd` — the CLI's `--project`; `globalDir()` for one that doesn't, the
  // CLI's default "user" scope, which never passes a cwd) INSTEAD OF `memory` above — the SAME
  // live decision (and the SAME `dirFor`/`globalDir` computation) the write-root join and the
  // context assembler's injection already use (daemon.ts's
  // `memoryEnabledHot`/`memoryDirOf`/`memoryGlobalDirOf`), so a toggle applies to the very next
  // RPC call, no daemon restart. Optional — a server built without it (every pre-T2 test, and any
  // server that only ever wants the legacy store) keeps calling into `memory` unconditionally,
  // byte-for-byte the T1 behavior. `scope` itself is NOT consulted once this path is taken: MEMDIR
  // has no user/project split, only "does this request carry a cwd" — see memory-migrate.ts's doc
  // comment for why a cwd-less request's target (`globalDir()`) is the SAME bucket the migration
  // importer uses for facts that don't map to a project.
  memoryFiles?: { enabled(): boolean; dirFor(cwd: string): string; globalDir(): string };
  // CC-parity phase 3 (Workflows, Track C Task C2): the daemon's own WorkflowRuntime (B2) —
  // constructed only inside daemon.ts's `if (agentProvider)` gate (spawnAgent needs a live engine
  // to bridge a script's `agent()` calls) — backing workflow.list's "running" section plus
  // workflow.run/stop/get. LOCAL-ONLY IN V1 (Global Constraints) — never added to
  // PLUGIN_ALLOWED_METHODS or REMOTE_ALLOWED_METHODS above. Optional — same "typed no-op/INTERNAL
  // failure, never a crash" precedent as `routines`/`memory` above: a server built without one
  // (every pre-C2 test, and a no-agentProvider daemon) degrades workflow.list's running section to
  // [] and workflow.stop to a soft no-op, while workflow.run/get become a typed RpcFailure.
  workflows?: WorkflowRuntime;
  // The daemon's own WorkflowStore (C1) — trust-gated project/user `.norma`/`<normaHome>` `.js`
  // workflow discovery, backing workflow.list's "saved" section and workflow.run's by-name
  // resolution. Built UNCONDITIONALLY in daemon.ts (no engine dependency — same precedent as
  // `outputStyleStore`), so it's present even on a no-agentProvider daemon. Optional here only for
  // tests that don't need it (degrades to an empty `saved` list / a NOT_FOUND on workflow.run by
  // name, same "typed no-op" precedent as `routines` above).
  workflowStore?: WorkflowStore;
  providerInfo?: { id: string; model: string } | null; // active LLM provider identity; daemon.status
  startedAt?: number;        // daemon process start time (Date.now()); daemon.status uptimeMs
  helloTimeoutMs?: number;   // default 5000
  maxConnections?: number;   // default 64
  preAuthMaxLine?: number;   // default 64 KiB
}

export interface IpcServer { stop(): void }

class RpcFailure extends Error { constructor(public code: number, message: string) { super(message); } }

/** Maps a `MemoryStore` failure's structural `kind` to a JSON-RPC code, for the memory.*
 *  handlers below. Only two buckets, same precedent as routines.create/update's INVALID_PARAMS/
 *  NOT_FOUND split above: `"not_found"` (unknown/corrupt fact on read, unknown fact on delete)
 *  is the ONLY "no such resource" case; everything else — `"invalid"` (bad/reserved name),
 *  `"trust"` (untrusted project cwd), or an ABSENT kind (a wrapped fs failure the store leaves
 *  unclassified) — is a caller-facing input problem from this RPC boundary's point of view, so it
 *  maps to INVALID_PARAMS. Structural on purpose: `error` text embeds caller input verbatim (a
 *  name like "why is this not found" is an INVALID name), so it must never be string-matched. */
function memoryErrorCode(failure: { kind?: MemoryErrorKind }): number {
  return failure.kind === "not_found" ? ERR.NOT_FOUND : ERR.INVALID_PARAMS;
}

/** Resolves WHICH MEMDIR a memory.* request targets once the file-backed path is taken (T2): a
 *  `cwd` (the CLI's `--project`, or any future caller that supplies one) resolves the requester's
 *  OWN project directory via `dirFor` (`memoryDirFor`, memory-dir.ts — git-repo-root keyed); no
 *  `cwd` (the CLI's default "user" scope) falls back to `globalDir()`, the same "no project"
 *  bucket the migration importer uses for facts that don't map to one. `scope` itself is never
 *  consulted here — see `IpcServerOptions.memoryFiles`'s own doc comment for why. */
function memoryFileDir(files: { dirFor(cwd: string): string; globalDir(): string }, cwd?: string): string {
  return cwd ? files.dirFor(cwd) : files.globalDir();
}

/** Maps a `SkillStore` failure's structural `kind` to a JSON-RPC code, for the skills.* handlers
 *  below — the SAME structural switch as `memoryErrorCode` above, over `SkillResult.kind` instead
 *  of `MemoryResult.kind`. Only two buckets (no "trust" bucket: SkillStore's write/delete are
 *  never project-trust-gated, see agent/skills.ts's own `SkillErrorKind` doc comment): `"not_found"`
 *  is the only "no such resource" case; `"invalid"` or an ABSENT kind (an unclassified wrapped fs
 *  failure) is a caller-facing input problem from this RPC boundary's point of view. */
function skillErrorCode(failure: { kind?: SkillErrorKind }): number {
  return failure.kind === "not_found" ? ERR.NOT_FOUND : ERR.INVALID_PARAMS;
}

// Phase 4b Task 2 (spec §3): the table-driven role→methods gate for plugin connections. A plugin
// authenticates as a SPECIFIC installed plugin id (hello role "plugin") and may ONLY ever call
// these wire verbs — everything else (session.*, approval.*, peripheral.*, daemon.*, trust.*,
// plugins.*, ask_user.*, etc.) is role-rejected BEFORE dispatch, never reaching a handler. Task 4
// wires the original six handlers (plugin.register/tool.register/shortcut.register/tile.update/
// provider.register/plugin.toolResult) into PluginSupervisor + ToolRegistry + PluginContribRegistry
// below.
//
// Phase 4c Task 1 (spec §5) adds a seventh: `hardware.request` — a plugin's own tool may need to
// ask Norma.app's XPC helper to do something (e.g. set the battery charge limit). `hardware.respond`
// is DELIBERATELY NOT here: only the active provider connection (Norma.app) may answer a
// `hardware_requested` push, same precedent as `peripheral.respond` staying off this list — a
// plugin connection calling it is role-rejected before dispatch, never reaching the handler.
// Task 2 wires `hardware.request`'s handler (consent gate + HardwareBroker) below.
const PLUGIN_ALLOWED_METHODS = new Set<string>([
  METHODS.pluginRegister,
  METHODS.toolRegister,
  METHODS.shortcutRegister,
  METHODS.tileUpdate,
  METHODS.providerRegister,
  METHODS.pluginToolResult,
  METHODS.hardwareRequest,
]);

// Remote (iPhone) principal — the LEAST-privileged role. The gateway connects as `remote`
// deliberately so a gateway bug can't relay a privileged method. Additive: a new remote-facing
// method requires a deliberate edit here (SP1 spec §6).
// Exported (SP2a gate G7) so the cross-language allowlist-parity test can pin this exact runtime
// Set against the Swift gateway's mirror (`Gateway.remoteAllowedMethods`) — a drift tripwire: an
// edit to one side that isn't matched on the other fails the parity test rather than silently
// letting the two allowlists diverge.
export const REMOTE_ALLOWED_METHODS = new Set<string>([
  METHODS.hello, METHODS.sessionList, METHODS.sessionAttach, METHODS.sessionSend,
  METHODS.sessionDispatch, METHODS.approvalRespond, METHODS.askUserRespond,
  METHODS.sessionInterrupt, METHODS.engineActivity,
  // SP3 T4b: the phone queries pending approvals it missed in the replay window (approval.list).
  METHODS.approvalList,
  // SP3.4: the phone may START a Code session (sidebar "+ New"), not just continue one.
  METHODS.sessionCreate,
  // Session history: the phone reads past events to render history without
  // an unbounded attach replay. Pure passthrough — all filtering/budgeting is daemon-side.
  METHODS.sessionHistory,
]);

/** Maps a failed `PluginSupervisor.invoke()` result to the message a `throw new Error(...)` in
 *  `tool.register`'s bridged `run()` turns into an isError tool_result (ToolRegistry.execute's
 *  catch path) — see that handler below. */
function pluginInvokeErrorMessage(pluginId: string, tool: string, err: InvokeError): string {
  switch (err.code) {
    case "not_running": return `plugin ${pluginId} is not running`;
    case "no_connection": return `plugin ${pluginId} has no active connection`;
    case "timeout": return `plugin ${pluginId} tool ${tool} timed out`;
    case "crashed": return err.message;
    case "plugin_error": return err.message;
  }
}

export function startIpcServer(opts: IpcServerOptions): IpcServer {
  if (opts.engine && !opts.hub) {
    throw new Error("startIpcServer: an engine requires a shared hub (engine and server must broadcast through the same SessionHub)");
  }
  const hub = opts.hub ?? new SessionHub(opts.store);

  const helloTimeoutMs = opts.helloTimeoutMs ?? 5000;
  const maxConnections = opts.maxConnections ?? 64;
  const preAuthMaxLine = opts.preAuthMaxLine ?? 64 * 1024;
  let connections = 0;

  // Every currently-authed harness-role connection, across all sessions. A brand-new session has
  // no attachments yet, so its session_created event can't reach anyone through the hub's
  // per-session fan-out — instead it's broadcast here to every harness so other harnesses (e.g. an
  // orb attached to a different, older session) learn about it and can offer to follow (spec §4.4).
  // Added on successful hello (role === "harness"); removed on socket close.
  const harnessConns = new Set<ConnState>();

  // session_titled (Task 3) is broadcast to EVERY authed harness, not just clients attached to
  // that session — mirrors the session.create broadcast above for the same reason: a harness
  // watching the session list (but not attached to this particular session) still needs to learn
  // its title live. Attached harnesses may receive it twice (fanOut + this); seq-based dedupe
  // absorbs that (NormaKit dedupes on seq; the CLI ignores unknown/duplicate event types).
  hub.onGlobalEvent = (event) => {
    for (const conn of harnessConns) {
      try { conn.writer.enqueue(encodeLine({ jsonrpc: "2.0", method: METHODS.event, params: event })); }
      catch { /* dead socket — its close() handler will evict it from harnessConns */ }
    }
  };

  // Phase 4d Task 1 (spec §6/§7): a monotonic counter for `plugin_tile_updated`'s `seq` field.
  // `SessionStore.lastSeq(sessionId)` (what every OTHER transient event stamps itself with, e.g.
  // `SessionHub.broadcastTransient`) requires a REAL, already-created session row and throws
  // "unknown session" otherwise — there is no session backing `SYSTEM_SESSION_ID`, and minting a
  // fake one just to read a counter would be its own footgun (a phantom row in session.list).
  // NormaKit's dedupe gate is scoped to the currently ATTACHED session (`e.sessionId == attached`,
  // NormaClient.swift) and `$system` can never equal a real attached session id, so this event
  // always bypasses that gate regardless of its seq value — a locally-monotonic counter is
  // sufficient (schema-valid, ordered) without needing the store at all.
  let systemSeq = 0;

  /** Broadcasts `plugin_tile_updated` to every authed harness — modeled EXACTLY on the
   *  `session_created` broadcast above (same `harnessConns` set, same enqueue/encodeLine, same
   *  swallow-on-dead-socket): a dashboard connection is never attached to any session, so this
   *  goes out over the harness broadcast set rather than the per-session `SessionHub`. Reads the
   *  CURRENT tile straight out of the registry (rather than taking one as a parameter) so both
   *  call sites — `tile.update` (after `setTile`) and `close()` (after `clear`) — stay a single
   *  line each and can never drift from what `plugins.contrib` would return for the same plugin. */
  function broadcastTileUpdated(pluginId: string): void {
    const tile = opts.contrib?.get(pluginId)?.tile ?? null;
    const event = {
      type: "plugin_tile_updated" as const,
      sessionId: SYSTEM_SESSION_ID,
      seq: ++systemSeq,
      ts: Date.now(),
      pluginId,
      tile,
    };
    for (const conn of harnessConns) {
      try { conn.writer.enqueue(encodeLine({ jsonrpc: "2.0", method: METHODS.event, params: event })); }
      catch { /* dead socket — its close() handler will evict it from harnessConns */ }
    }
  }

  function parseParams<S extends z.ZodTypeAny>(schema: S, params: unknown): z.infer<S> {
    const result = schema.safeParse(params);
    if (!result.success) {
      throw new RpcFailure(
        ERR.INVALID_PARAMS,
        `invalid params: ${result.error.issues.map((i: z.ZodIssue) => i.path.join(".") || "(root)").join(", ")}`,
      );
    }
    return result.data;
  }

  // -----------------------------------------------------------------------------------------
  // Plugin lifecycle (Phase 4d-ii Task 2) support: a settings-current plugin view + hot-apply
  // start/stop against the SAME PluginSupervisor `plugins.list`/`plugin.restart` already use.
  // -----------------------------------------------------------------------------------------

  // Phase 4d-cleanup Task 1: `livePlugins()` used to re-derive a brand-new `PluginStore().list()`
  // (readdirSync of the plugins dir + a `loadManifest` per plugin) on EVERY call — including every
  // consented `hardware.request` (a hot path: one call per plugin tool invocation that touches
  // hardware), not just the plugin-lifecycle RPCs it exists for. Cache the derived list, keyed on
  // the mtimeMs of settings.json + the plugins dir — every lifecycle RPC below writes settings.json
  // (pluginsInstall additionally creates a new dir entry under plugins/, bumping ITS mtime too), so
  // a key mismatch reliably detects any settings/install/remove change and forces a re-derive,
  // preserving the 4d-ii "applied HOT, no restart" staleness fix. `statSync(...).mtimeMs` has only
  // whole-millisecond resolution, so two writes inside the same millisecond could in principle
  // alias onto an unchanged key — rather than rely on that granularity alone, every lifecycle RPC
  // handler that writes ALSO calls `invalidateLivePluginsCache()` explicitly at the point it
  // mutates, making the mtime key a fast-path/fallback guard, not the sole one.
  let livePluginsCache: { key: string; list: PluginInfo[] } | null = null;

  function statMtimeOrZero(path: string): number {
    try { return statSync(path).mtimeMs; } catch { return 0; } // missing file/dir -> key component 0
  }

  /** The cache key: settings.json's mtime (every lifecycle write touches it) + the plugins dir's
   *  mtime (install/remove touch it — enable/disable/setConsent don't, but they always write
   *  settings.json, which is enough on its own to change this key). */
  function livePluginsCacheKey(normaHome: string): string {
    return `${statMtimeOrZero(join(normaHome, "settings.json"))}:${statMtimeOrZero(join(normaHome, "plugins"))}`;
  }

  /** Called at the end of every plugin-lifecycle RPC handler that mutates settings.json or the
   *  plugins directory (pluginsInstall/pluginEnable/pluginDisable/pluginRemove/pluginSetConsent) —
   *  see the mtime-aliasing note above for why this explicit invalidation exists alongside the
   *  mtime key rather than instead of it. */
  function invalidateLivePluginsCache(): void {
    livePluginsCache = null;
  }

  /** Rebuilds `opts.hooks` (Phase 4f Task 2) off a FRESH `livePlugins()` read — called at every
   *  point a plugin-lifecycle RPC below already calls `invalidateLivePluginsCache()`, so the two
   *  never drift: whatever `livePlugins()` would now return, the hook registry reflects. A safe
   *  no-op when `opts.hooks` or `opts.normaHome` is unset (most existing tests) — same "typed
   *  no-op" precedent `hotApplyStart`/`hotApplyStop` already follow for a no-provider daemon. */
  function rebuildHookRegistry(): void {
    if (!opts.hooks || !opts.normaHome) return;
    opts.hooks.rebuild(hookRegistryPlugins(livePlugins(), opts.normaHome));
  }

  /** A fresh, settings-current view of installed plugins — unlike `opts.plugins` (its
   *  `enabled`/`disabled`/`consents` deps are a snapshot captured once at daemon boot and never
   *  updated), this re-reads settings.json on every CACHE-MISS call so a `plugin.enable`/`disable`/
   *  `setConsent` written moments ago — by this task's own RPCs, or a concurrent `norma plugin
   *  ...` CLI invocation — is reflected immediately, without a daemon restart (the whole point of
   *  this task). Falls back to the boot-time `opts.plugins` when `normaHome` isn't wired (keeps
   *  every pre-existing test that passes a bare `plugins:` PluginStore, with no `normaHome`,
   *  working unchanged) or when settings.json can't be read (defensive — never throws); neither
   *  fallback path is cached (nothing stable to key on). */
  function livePlugins(): PluginInfo[] {
    if (!opts.normaHome) return opts.plugins?.list() ?? [];
    const key = livePluginsCacheKey(opts.normaHome);
    if (livePluginsCache && livePluginsCache.key === key) return livePluginsCache.list;
    let settings: Settings;
    try {
      settings = loadSettings(join(opts.normaHome, "settings.json"));
    } catch {
      return opts.plugins?.list() ?? [];
    }
    const list = new PluginStore({ normaHome: opts.normaHome, plugins: settings.plugins, consents: settings.plugins?.consents }).list();
    livePluginsCache = { key, list };
    return list;
  }

  /** `plugin.enable`'s hot-apply START — spawns a Tier-2 (platform, spawn-eligible) plugin's
   *  process NOW, on the running daemon, instead of requiring a restart to pick up the settings
   *  change just persisted. Reuses `PluginSupervisor.restart()` — the SAME single-plugin
   *  spawn path `startAll` calls per-id (`spawnFresh`) — as the single-plugin "start": `restart`
   *  already handles an id the supervisor has never tracked cleanly (its teardown-existing-runtime
   *  branch is skipped, straight to a fresh spawn), so no separate "start" method was needed. `"na"`
   *  for a non-Tier-2 plugin (capability/legacy, or no `entry`) — nothing to spawn, matching
   *  `plugins.list`'s own status enrichment below. `"stopped"` for a Tier-2 plugin when this daemon
   *  has no agent runtime wired — settings are already recorded by the caller; there's just nothing
   *  to hot-spawn onto, same "na"/"stopped" precedent `plugins.list` already uses. Gated on
   *  `opts.registry`, NOT just `opts.supervisor`: since Phase 4d-cleanup Task 2 hoisted
   *  `PluginSupervisor`'s construction out of daemon.ts's `if (agentProvider)` gate (so its
   *  boot-time orphan sweep runs even with no provider configured), `opts.supervisor` is now ALWAYS
   *  defined — it's no longer a reliable signal for "a provider is configured". `opts.registry`
   *  still is: daemon.ts only builds a `ToolRegistry` (and mirrors it into `sharedRegistry`, what
   *  becomes `opts.registry` here) inside that same `if (agentProvider)` block, exactly like
   *  `tool.register` below already gates on `opts.registry` for the same reason. Without this, a
   *  no-provider daemon would fall through to a REAL `opts.supervisor.restart()` spawn on
   *  `plugin.enable` — settings-only recording is the correct behavior for that daemon shape. */
  function hotApplyStart(info: PluginInfo): SupervisorStatus | "na" {
    if (!pluginSpawnEligible(info)) return "na";
    if (!opts.supervisor || !opts.registry || !opts.normaHome) return "stopped";
    const config: EligiblePlugin = { id: info.name, dir: join(opts.normaHome, "plugins", info.name), entry: info.entry! };
    opts.supervisor.restart(config);
    return opts.supervisor.status(info.name);
  }

  /** `plugin.disable`/`plugin.remove`'s hot-apply STOP — kills a Tier-2 plugin's running process
   *  (if any) NOW via the single-plugin `PluginSupervisor.stop()` (added this task — previously
   *  only a whole-daemon `stopAll()` existed). A safe no-op when no supervisor is wired, or the
   *  plugin was never tracked as running in the first place — which, on a no-provider daemon (see
   *  `hotApplyStart`'s doc comment), is always: `startAll` never ran, so there's never anything to
   *  stop. Deliberately left ungated on `opts.registry`, unlike `hotApplyStart` — a stop can only
   *  ever tear something down, never spawn, so widening when it runs is harmless cleanup, not a
   *  new-process risk. */
  function hotApplyStop(name: string): void {
    opts.supervisor?.stop(name);
  }

  const server = Bun.listen<ConnState>({
    unix: opts.socketPath,
    socket: {
      open(socket) {
        if (connections >= maxConnections) {
          // Bun requires socket.data to be assigned before close() fires.
          // Set a sentinel so the close() guard can detect the capped case.
          (socket as any).data = null;
          socket.end();
          return;
        }
        connections++;
        socket.data = {
          decoder: new LineDecoder(preAuthMaxLine),
          authedRole: null,
          clientName: "",
          hubClient: null,
          helloTimer: setTimeout(() => socket.end(), helloTimeoutMs),
          writer: new ConnWriter(socket as unknown as WritableSocket),
          pluginId: null,
          seenCommands: new Map(),
        };
      },
      drain(socket) {
        socket.data?.writer?.onDrain();
      },
      close(socket) {
        if (!socket.data) return; // rejected at cap before data was set (sentinel null)
        connections--;
        if (socket.data.helloTimer) clearTimeout(socket.data.helloTimer);
        if (socket.data.hubClient) hub.detach(socket.data.hubClient);
        harnessConns.delete(socket.data);
        // Provider disconnect (spec §A3): only the connection that most recently advertised
        // counts — isProvider() is checked BEFORE providerGone() resets the broker's identity.
        if (opts.peripheral?.isProvider(socket.data)) {
          opts.peripheral.providerGone();
          opts.providerLink?.setWriter(null);
        }
        // Phase 4b Task 4: a plugin connection dropping (crash, SIGTERM, clean SDK shutdown, the
        // socket cap, anything) means every tool it registered can no longer be invoked —
        // unregister them FIRST (so a stale plugin__<id>__* tool never lingers in specs()/
        // ToolSearch even for the instant before notifyDisconnected's own backoff/circuit
        // bookkeeping runs), then tell the supervisor the connection is gone. notifyDisconnected
        // is an idempotent no-op outside status "running" (see its doc comment) — safe even for a
        // connection that never got past hello/plugin.register.
        if (socket.data.pluginId) {
          opts.registry?.unregisterByPrefix(`plugin__${socket.data.pluginId}__`);
          opts.supervisor?.notifyDisconnected(socket.data.pluginId);
          // Phase 4d Task 1: a disconnected plugin's shortcuts/tile/provider info is stale the
          // instant the connection drops (the SDK's serve() re-declares everything fresh on
          // reconnect, Task 5's contract) — clear it out of the registry, then broadcast so any
          // dashboard showing this plugin's tile drops the now-stale card (tile: null).
          opts.contrib?.clear(socket.data.pluginId);
          broadcastTileUpdated(socket.data.pluginId);
        }
      },
      async data(socket, chunk) {
        let lines: string[];
        try { lines = socket.data.decoder.push(chunk); }
        catch { socket.end(); return; } // oversized line: hostile or broken peer

        for (const line of lines) {
          let id: number | string | null = null;
          try {
            let incoming: ReturnType<typeof parseIncoming>;
            try {
              incoming = parseIncoming(JSON.parse(line));
            } catch {
              throw new RpcFailure(ERR.PARSE_ERROR, "parse error");
            }
            if (incoming.kind !== "request") continue; // Phase 0: ignore client notifications
            id = incoming.msg.id;
            // Remote Gateway SP1 Task 2: a flaky mobile link means a phone may resend a request
            // whose ack was lost — dedup remote mutating RPCs per-connection by `commandId`. A
            // repeat returns the CACHED result and does NOT re-dispatch. Remote-only; harness/
            // plugin/local callers (no commandId, or role !== "remote") are unaffected. Errors are
            // NOT cached (only the success path below reaches the `.set`), so a retry after a
            // transient failure re-attempts.
            const commandId = socket.data.authedRole === "remote" ? incoming.msg.commandId : undefined;
            let result: unknown;
            if (commandId && socket.data.seenCommands.has(commandId)) {
              result = socket.data.seenCommands.get(commandId); // replay: no re-dispatch
            } else {
              result = await handle(socket, incoming.msg.method, incoming.msg.params);
              if (commandId) {
                socket.data.seenCommands.set(commandId, result);
                if (socket.data.seenCommands.size > 256) {
                  const oldest = socket.data.seenCommands.keys().next().value as string;
                  socket.data.seenCommands.delete(oldest);
                }
              }
            }
            socket.data.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, result }));
          } catch (err) {
            const e = err as Partial<RpcFailure>;
            const code = e.code ?? ERR.INTERNAL;
            const message = e.message ?? "internal error";
            socket.data.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, error: { code, message } }));
          }
        }
      },
    },
  });
  chmodSync(opts.socketPath, 0o600);

  async function handle(socket: { data: ConnState }, method: string, params: unknown): Promise<unknown> {
    if (method === METHODS.hello) {
      if (socket.data.authedRole !== null) {
        throw new RpcFailure(ERR.INVALID_REQUEST, "already authenticated — open a new connection to change role");
      }
      const p = parseParams(HelloParams, params);
      if (p.protocolVersion !== PROTOCOL_VERSION) {
        throw new RpcFailure(ERR.VERSION_MISMATCH, `server speaks protocol v${PROTOCOL_VERSION}, client sent v${p.protocolVersion}`);
      }
      // Phase 4b Task 2: role "plugin" is id-bound and verified against SessionStore's sqlite-
      // hashed plugin_tokens table (mintPluginToken/verifyPluginToken), NOT TokenAuthority — a
      // plugin's token has nothing to do with the harness/admin Keychain secrets. A hello with no
      // pluginId, or one whose token doesn't match what was minted for that exact id, fails closed.
      if (p.role === "plugin") {
        if (!p.pluginId || !opts.store.verifyPluginToken(p.pluginId, p.token)) {
          throw new RpcFailure(ERR.UNAUTHORIZED, "invalid token for role");
        }
      } else if (!(await opts.tokens.verify(p.role, p.token))) {
        throw new RpcFailure(ERR.UNAUTHORIZED, "invalid token for role");
      }
      socket.data.authedRole = p.role;
      socket.data.clientName = p.clientName;
      socket.data.pluginId = p.role === "plugin" ? p.pluginId! : null;
      if (socket.data.helloTimer) { clearTimeout(socket.data.helloTimer); socket.data.helloTimer = null; }
      socket.data.decoder = new LineDecoder(); // authed: default 8 MiB line cap
      if (p.role === "harness") harnessConns.add(socket.data);
      return { ok: true, serverVersion: opts.serverVersion, protocolVersion: PROTOCOL_VERSION };
    }

    if (socket.data.authedRole === null) throw new RpcFailure(ERR.UNAUTHORIZED, "hello required first");

    // Role→method allowlist gate — BEFORE dispatch, ahead of the switch below (Task 2 contract).
    if (socket.data.authedRole === "plugin" && !PLUGIN_ALLOWED_METHODS.has(method)) {
      throw new RpcFailure(ERR.UNAUTHORIZED, `plugin role may not call ${method}`);
    }
    // Remote Gateway SP1 Task 1: same table-driven gate, for the least-privileged `remote` role.
    if (socket.data.authedRole === "remote" && !REMOTE_ALLOWED_METHODS.has(method)) {
      throw new RpcFailure(ERR.UNAUTHORIZED, `remote role may not call ${method}`);
    }

    switch (method) {
      case METHODS.sessionCreate: {
        const p = parseParams(SessionCreateParams, params);
        // Dispatch (Phase 7): the singleton dispatch session is minted ONLY by session.dispatch's
        // get-or-create — session.create rejects the mode outright rather than silently minting a
        // second one (there must only ever be one).
        if (p.mode === "dispatch") throw new RpcFailure(ERR.INVALID_PARAMS, "dispatch sessions are created via session.dispatch, not session.create");
        // SP3.4 hardening: the phone never picks a working directory or approval policy — the
        // spec's "the phone does not browse the Mac's filesystem" is enforced here, not just
        // convention. Local/harness callers are unchanged. Checked against the RAW wire params
        // (not `p`): SessionCreateParams.approvalPolicy carries a zod `.default("ask")`, so on `p`
        // it is never `undefined` even when the caller omitted it entirely — that would reject
        // every remote session.create. The raw object only has the key when the caller sent it.
        const rawParams = params as { cwd?: unknown; approvalPolicy?: unknown } | null | undefined;
        if (socket.data.authedRole === "remote" && rawParams && typeof rawParams === "object" &&
          (rawParams.cwd !== undefined || rawParams.approvalPolicy !== undefined)) {
          throw new RpcFailure(ERR.INVALID_PARAMS, "remote session.create may not set cwd or approvalPolicy");
        }
        // SP3.4: a remote (phone) caller can't browse this Mac's filesystem to pick a cwd — its
        // sessions default to the home directory (the same value session.dispatch uses). Scoped to
        // the remote role so local/harness callers keep today's semantics (omitted cwd stays unset).
        const cwd = p.cwd ?? (socket.data.authedRole === "remote" ? homedir() : undefined);
        const sessionId = opts.store.createSession(p.scope, { cwd, approvalPolicy: p.approvalPolicy, origin: p.origin });
        const trusted = cwd ? (opts.trust?.isTrusted(cwd) ?? false) : false;
        // Broadcast the session_created event to every authed harness (not just attachments —
        // a brand-new session has none) so other harnesses can offer to follow (spec §4.4).
        const created = opts.store.read(sessionId, 0)[0];
        if (created) {
          for (const conn of harnessConns) {
            try { conn.writer.enqueue(encodeLine({ jsonrpc: "2.0", method: METHODS.event, params: created })); }
            catch { /* dead socket — its close() handler will evict it from harnessConns */ }
          }
        }
        return { sessionId, trusted };
      }
      case METHODS.sessionList:
        return { sessions: opts.store.list() };
      case METHODS.sessionDispatch: {
        parseParams(SessionDispatchParams, params);
        // Get-or-create is atomic here: the lookup+create sequence is synchronous (bun:sqlite,
        // no await between), so two concurrent RPCs cannot both create.
        const existing = opts.store.dispatchSessionId();
        if (existing) return { sessionId: existing, created: false };
        const sessionId = opts.store.createSession("global", {
          cwd: homedir(), approvalPolicy: "auto", origin: "dispatch", mode: "dispatch",
        });
        return { sessionId, created: true };
      }
      case METHODS.sessionAttach: {
        const p = parseParams(SessionAttachParams, params);
        const hubClient: HubClient = {
          clientName: socket.data.clientName,
          deliver(event: SessionEvent): boolean {
            return socket.data.writer.enqueue(encodeLine({ jsonrpc: "2.0", method: METHODS.event, params: event }));
          },
        };
        // Detach the old client before attaching a new one (re-attach = move semantics).
        if (socket.data.hubClient) hub.detach(socket.data.hubClient);
        try {
          const lastSeq = hub.attach(hubClient, p.sessionId, p.fromSeq);
          socket.data.hubClient = hubClient;
          return { ok: true, lastSeq };
        } catch (e) {
          throw new RpcFailure(ERR.NOT_FOUND, (e as Error).message);
        }
      }
      case METHODS.sessionHistory: {
        const p = parseParams(SessionHistoryParams, params);
        try {
          return readHistoryPage(opts.store, { sessionId: p.sessionId, beforeSeq: p.beforeSeq, limit: p.limit });
        } catch (e) {
          // Unknown session → the same NOT_FOUND mapping session.attach uses (store.read throws).
          throw new RpcFailure(ERR.NOT_FOUND, (e as Error).message);
        }
      }
      case METHODS.sessionSend: {
        const p = parseParams(SessionSendParams, params);
        if (!socket.data.hubClient) throw new RpcFailure(ERR.NOT_FOUND, "attach to the session first");
        const seq = hub.send(socket.data.hubClient, p.sessionId, p.text);
        // Fire-and-forget: the response returns immediately and turn events stream separately.
        // If a turn is already running, this message just lands in history for the next turn
        // (full mid-turn steering is deferred).
        if (opts.engine && !opts.engine.isRunning(p.sessionId)) {
          opts.engine.runTurn(p.sessionId).catch((e) => console.error("turn failed:", e));
        }
        return { seq };
      }
      case METHODS.sessionSteer: {
        const p = parseParams(SessionSteerParams, params);
        if (!opts.engine) return { ok: true, injected: false };
        return { ok: true, ...opts.engine.steer(p.sessionId, p.text) };
      }
      case METHODS.sessionInterrupt: {
        const p = parseParams(SessionInterruptParams, params);
        if (!opts.engine) return { ok: true, wasRunning: false };
        return { ok: true, ...opts.engine.interrupt(p.sessionId) };
      }
      case METHODS.sessionCompact: {
        const p = parseParams(SessionCompactParams, params);
        if (!opts.engine) return { ok: true, compacted: false, uptoSeq: 0, summaryChars: 0 };
        return { ok: true, ...(await opts.engine.compact(p.sessionId)) };
      }
      case METHODS.skillsList: {
        const p = parseParams(SkillsListParams, params);
        if (!opts.skills) return { ok: true, skills: [] };
        return { ok: true, skills: opts.skills.list({ cwd: p.cwd ?? null }) };
      }

      // -----------------------------------------------------------------------------------------
      // Skills read/write/delete (Phase 5c Task 3): the management surface over the SAME SkillStore
      // instance `skills.list` above and T2's `skill_write` tool run against (daemon.ts hoists ONE
      // SkillStore). Role-gated exactly like memory.* below (harness AND admin; PLUGIN_ALLOWED_METHODS
      // omits all three, so a plugin connection never reaches this switch for any of them). Degraded
      // split mirrors memory's exactly: `skills.list` above already degrades to an empty list with no
      // store; `skills.read` (a single-fact read, like `memory.read`) and the two mutations fail hard
      // with a typed INTERNAL RpcFailure rather than silently no-oping.
      // -----------------------------------------------------------------------------------------
      case METHODS.skillsRead: {
        const p = parseParams(SkillsReadParams, params);
        if (!opts.skills) throw new RpcFailure(ERR.INTERNAL, "skills are not available on this server (no SkillStore configured)");
        const cwd = p.cwd ?? null;
        const meta = opts.skills.list({ cwd }).find((s) => s.name === p.name);
        const loaded = meta ? opts.skills.load(p.name, { cwd }) : null;
        if (!meta || !loaded) throw new RpcFailure(ERR.NOT_FOUND, `skill not found: "${p.name}"`);
        return { skill: { ...meta, body: loaded.body } };
      }
      case METHODS.skillsWrite: {
        const p = parseParams(SkillsWriteParams, params);
        if (!opts.skills) throw new RpcFailure(ERR.INTERNAL, "skills are not available on this server (no SkillStore configured)");
        // Server-side self-confinement (no scope param to abuse, unlike memory.write): ALWAYS
        // writeSelf, never any other source.
        const res = await opts.skills.writeSelf({ name: p.name, description: p.description, body: p.body });
        if (!res.ok) throw new RpcFailure(skillErrorCode(res), res.error);
        return {};
      }
      case METHODS.skillsDelete: {
        const p = parseParams(SkillsDeleteParams, params);
        if (!opts.skills) throw new RpcFailure(ERR.INTERNAL, "skills are not available on this server (no SkillStore configured)");
        // A name that resolves (by the store's normal precedence) to a NON-self source is refused
        // BEFORE ever calling deleteSelf — deleteSelf only ever touches self/<name>, so without this
        // check a project/user/plugin/builtin skill of that name would silently survive while the
        // caller got back a confusing "not found" (there being no self/<name> to delete) instead of
        // the actual reason: this isn't a self-authored skill at all.
        const meta = opts.skills.list({ cwd: null }).find((s) => s.name === p.name);
        if (meta && meta.source !== "self") {
          throw new RpcFailure(ERR.INVALID_PARAMS, `only self-authored skills can be deleted: "${p.name}" resolves to source "${meta.source}"`);
        }
        const res = await opts.skills.deleteSelf(p.name);
        if (!res.ok) throw new RpcFailure(skillErrorCode(res), res.error);
        return {};
      }
      case METHODS.mcpList: {
        const p = parseParams(McpListParams, params);
        if (p.cwd) await opts.mcp?.ensureProject(p.cwd);
        return { ok: true, servers: opts.mcp?.list(p.cwd) ?? [] };
      }
      case METHODS.pluginsList: {
        parseParams(PluginsListParams, params);
        // Phase 4d-i Task 4: enrich each entry with live PluginSupervisor runtime status. Kept
        // HERE (the ipc handler, which has `opts.supervisor`) rather than in PluginStore.list()
        // (agent/plugins.ts), which stays pure fs/settings with no supervisor coupling. Tier-2
        // (pluginSpawnEligible — platform tier, entry present, enabled, consented) plugins get the
        // real SupervisorStatus (defaulting to "stopped" when this plugin was never tracked by the
        // supervisor at all, e.g. no agentProvider so no PluginSupervisor was even built); Tier-1
        // (capability) and legacy plugins never run a process, so they always report "na".
        // Phase 4d-ii Task 2: `livePlugins()` (not the boot-time-stale `opts.plugins` directly) so
        // a `plugin.enable`/`disable`/`setConsent` this same connection just called is reflected
        // immediately — see that helper's doc comment above.
        const plugins = livePlugins().map((p) => ({
          ...p,
          status: pluginSpawnEligible(p) ? (opts.supervisor?.status(p.name) ?? "stopped") : ("na" as const),
        }));
        return { ok: true, plugins };
      }
      case METHODS.approvalRespond: {
        const p = parseParams(ApprovalRespondParams, params);
        // SP-approvals Task 5: BEFORE resolving, look up the pending approval's stored options via
        // Task 4's `pendingMeta` — a non-consuming read (see its own doc comment), so this lookup
        // can never itself count as an answer for the `resolve()` call right below. Gated on
        // `p.optionId` being present at all: a plain approve/deny (no options were ever offered on
        // this card, or a client that predates this field) skips this entirely, byte-identical to
        // before this task.
        if (p.optionId !== undefined && opts.broker) {
          const meta = opts.broker.pendingMeta(p.sessionId, p.callId);
          const option = meta?.options?.find((o) => o.id === p.optionId);
          if (meta && !option) {
            // A genuinely pending approval, but optionId names nothing it actually offered — a
            // client bug or protocol drift, not a crash: log once and fall through to the normal
            // resolve below (approved per p.approved, exactly as if optionId had been omitted).
            console.error(`approval.respond: unknown optionId ${JSON.stringify(p.optionId)} for session ${p.sessionId} call ${p.callId} — resolving with no rule persisted`);
          } else if (option?.rule && p.approved && opts.permissionRules) {
            // Persist the chosen rule. `approved:false` on a rule-bearing option must NEVER
            // append — enforced by `p.approved` being part of THIS same condition, not a separate
            // branch, so there is no path that persists a rule for a denied call. Wrapped in
            // try/catch: `append()` throws RuleAppendError for scope "project" when there's no
            // usable project root (a null session cwd, or one nested inside/equal to normaHome) —
            // the approval outcome must never hang or fail on a persistence problem, so a failure
            // here only logs; `resolve()` below still runs unconditionally either way.
            try {
              const cwd = opts.store.meta(p.sessionId).cwd;
              opts.permissionRules.append(option.rule, option.scope ?? "project", cwd ? repoRootFor(cwd) : null);
            } catch (err) {
              console.error(`approval.respond: failed to persist permission rule ${JSON.stringify(option.rule)} for session ${p.sessionId}: ${(err as Error).message}`);
            }
          }
        }
        return opts.broker?.resolve(p.sessionId, p.callId, p.approved, socket.data.clientName) ?? { ok: true, alreadyResolved: true };
      }
      case METHODS.approvalList: {
        // SP3 T4b: queryable pending-approval state (remote-allowlisted so a phone can render live
        // approval cards it missed in the replay window). No broker (agent disabled) → no pending.
        const p = parseParams(ApprovalListParams, params);
        return { pending: opts.broker?.list(p.sessionId) ?? [] };
      }
      case METHODS.askUserRespond: {
        const p = parseParams(AskUserRespondParams, params);
        return opts.questions?.respond(p.sessionId, p.callId, p.answers, socket.data.clientName, p.notes) ?? { ok: true, alreadyResolved: true };
      }
      case METHODS.taskList: {
        const p = parseParams(TaskListParams, params);
        return { ok: true, tasks: opts.tasks?.list(p.sessionId) ?? [] };
      }
      case METHODS.threadList: {
        const p = parseParams(ThreadListParams, params);
        return { ok: true, threads: opts.engine?.threadsFor(p.sessionId) ?? [] };
      }
      // ---------------------------------------------------------------------------------------
      // Live child-transcript view T1 (design doc "Wire"): thread.send / agent.stop — thin RPCs
      // over AgentEngine.sendToAgent/stopAgent, which mirror the send_message tool bridge /
      // task_stop tool's own resolve+dispatch logic exactly (see those methods' doc comments in
      // engine.ts). No engine → typed INTERNAL RpcFailure (same "typed no-op/error, never a
      // crash" precedent as skills.read/write/delete above) rather than a silent no-op — unlike
      // session.steer/interrupt's soft `{ok:true, injected:false}` degrade, there is nothing
      // meaningful to report back for "message an agent" with no engine to hold one.
      // ---------------------------------------------------------------------------------------
      case METHODS.threadSend: {
        const p = parseParams(ThreadSendParams, params);
        if (!opts.engine) throw new RpcFailure(ERR.INTERNAL, "background agents are not available on this server (no engine configured)");
        const result = await opts.engine.sendToAgent(p.sessionId, p.agent, p.text);
        if (!result.ok) throw new RpcFailure(result.kind === "not_found" ? ERR.NOT_FOUND : ERR.INVALID_PARAMS, result.error);
        return { ok: true, delivered: result.delivered, agentId: result.agentId };
      }
      case METHODS.agentStop: {
        const p = parseParams(AgentStopParams, params);
        if (!opts.engine) throw new RpcFailure(ERR.INTERNAL, "background agents are not available on this server (no engine configured)");
        const result = opts.engine.stopAgent(p.sessionId, p.agent);
        if (!result.ok) throw new RpcFailure(ERR.NOT_FOUND, result.error);
        return { ok: true, status: result.status };
      }
      case METHODS.planRespond: {
        const p = parseParams(PlanRespondParams, params);
        return (
          opts.plans?.respond(
            p.sessionId, p.callId,
            { approved: p.approved, feedback: p.feedback, autoAccept: p.autoAccept },
            socket.data.clientName,
          ) ?? { ok: true, alreadyResolved: true }
        );
      }
      case METHODS.sessionSetPolicy: {
        const p = parseParams(SessionSetPolicyParams, params);
        try {
          opts.store.setApprovalPolicy(p.sessionId, p.policy);
        } catch (e) {
          throw new RpcFailure(ERR.NOT_FOUND, (e as Error).message);
        }
        return { ok: true };
      }

      // -----------------------------------------------------------------------------------------
      // Scheduled routines (Phase 5 routines T3, design doc §3): the management surface over
      // `RoutineStore`. Role-gated EXACTLY like session.create/session.list above — no additional
      // role check here (harness AND admin may both call these; a plugin-role connection is
      // rejected before dispatch ever reaches this switch, since none of these four are in
      // PLUGIN_ALLOWED_METHODS above). Invalid input (a bad spec, `policy:"ask"`, an unknown id on
      // update) is a thrown RpcFailure (INVALID_PARAMS/NOT_FOUND) — no typed result union, same
      // precedent as session.setPolicy/session.setCwd just above, NOT the plugin-lifecycle verbs'
      // typed-union style further down this file.
      // -----------------------------------------------------------------------------------------
      case METHODS.routinesCreate: {
        const p = parseParams(RoutinesCreateParams, params);
        if (!opts.routines) throw new RpcFailure(ERR.INTERNAL, "routines are not available on this server (no RoutineStore configured)");
        let routine;
        try {
          routine = opts.routines.create({ spec: p.spec, prompt: p.prompt, policy: p.policy, cwd: p.cwd });
        } catch (e) {
          throw new RpcFailure(ERR.INVALID_PARAMS, (e as Error).message);
        }
        return { routine };
      }
      case METHODS.routinesList: {
        parseParams(RoutinesListParams, params);
        return { routines: opts.routines?.list() ?? [] };
      }
      case METHODS.routinesUpdate: {
        const p = parseParams(RoutinesUpdateParams, params);
        if (!opts.routines) throw new RpcFailure(ERR.INTERNAL, "routines are not available on this server (no RoutineStore configured)");
        let routine;
        try {
          routine = opts.routines.update(p.id, p.patch);
        } catch (e) {
          throw new RpcFailure(ERR.INVALID_PARAMS, (e as Error).message);
        }
        if (!routine) throw new RpcFailure(ERR.NOT_FOUND, `unknown routine: ${p.id}`);
        return { routine };
      }
      case METHODS.routinesDelete: {
        const p = parseParams(RoutinesDeleteParams, params);
        const removed = opts.routines?.delete(p.id) ?? false;
        return { ok: true, removed };
      }

      // -----------------------------------------------------------------------------------------
      // Memory (Phase 5b Task 3 / T2 design doc §4 / T3 task-23): the management surface over
      // EITHER backend. Role-gated exactly like routines.* above (harness AND admin; a plugin-role
      // connection never reaches this switch for any of these five). Every verb below — INCLUDING
      // memory.audit as of T3 (see its own comment for the audit-line shape mapping) — checks
      // `opts.memoryFiles?.enabled()` FIRST: true → MEMDIR files (`memoryFileDir` below resolves
      // WHICH directory from `p.cwd`), regardless of `p.scope`; false, or `memoryFiles` absent
      // entirely (every pre-T2 test) → the legacy `MemoryStore` path, byte-for-byte T1's behavior
      // (scope/cwd/trust-gating all still apply there). A store `ok:false` becomes a thrown
      // RpcFailure via `memoryErrorCode` above either way — same structural mapping, since
      // `memory-file-ops.ts`'s `MemoryResult`s use the identical `kind` union. RPC-sourced
      // legacy-store mutations pass `source:"rpc"` and no `sessionId` (there is no session context
      // on this connection) — mirrors the (now-deleted) tools' own `source:"tool"` + real
      // sessionId.
      // -----------------------------------------------------------------------------------------
      case METHODS.memoryList: {
        const p = parseParams(MemoryListParams, params);
        if (opts.memoryFiles?.enabled()) return { facts: listMemoryDir(memoryFileDir(opts.memoryFiles, p.cwd)) };
        if (!opts.memory) return { facts: [] }; // degrades like memory.audit below / routines.list above
        const res = opts.memory.list(p.scope, p.cwd);
        if (!res.ok) throw new RpcFailure(memoryErrorCode(res), res.error);
        return { facts: res.value };
      }
      case METHODS.memoryRead: {
        const p = parseParams(MemoryReadParams, params);
        if (opts.memoryFiles?.enabled()) {
          const res = readMemoryDir(memoryFileDir(opts.memoryFiles, p.cwd), p.name);
          if (!res.ok) throw new RpcFailure(memoryErrorCode(res), res.error);
          return { fact: res.value };
        }
        if (!opts.memory) throw new RpcFailure(ERR.INTERNAL, "memory is not available on this server (no MemoryStore configured)");
        const res = opts.memory.read(p.scope, p.name, p.cwd);
        if (!res.ok) throw new RpcFailure(memoryErrorCode(res), res.error);
        return { fact: res.value };
      }
      case METHODS.memoryWrite: {
        const p = parseParams(MemoryWriteParams, params);
        if (opts.memoryFiles?.enabled()) {
          const res = writeMemoryDir(memoryFileDir(opts.memoryFiles, p.cwd), { name: p.name, description: p.description, type: p.type, body: p.body });
          if (!res.ok) throw new RpcFailure(memoryErrorCode(res), res.error);
          return {};
        }
        if (!opts.memory) throw new RpcFailure(ERR.INTERNAL, "memory is not available on this server (no MemoryStore configured)");
        const res = await opts.memory.write(
          p.scope, { name: p.name, description: p.description, type: p.type, body: p.body }, { source: "rpc" }, p.cwd,
        );
        if (!res.ok) throw new RpcFailure(memoryErrorCode(res), res.error);
        return {};
      }
      case METHODS.memoryDelete: {
        const p = parseParams(MemoryDeleteParams, params);
        if (opts.memoryFiles?.enabled()) {
          const res = deleteMemoryDir(memoryFileDir(opts.memoryFiles, p.cwd), p.name);
          if (!res.ok) throw new RpcFailure(memoryErrorCode(res), res.error);
          return {};
        }
        if (!opts.memory) throw new RpcFailure(ERR.INTERNAL, "memory is not available on this server (no MemoryStore configured)");
        const res = await opts.memory.delete(p.scope, p.name, { source: "rpc" }, p.cwd);
        if (!res.ok) throw new RpcFailure(memoryErrorCode(res), res.error);
        return {};
      }
      case METHODS.memoryAudit: {
        const p = parseParams(MemoryAuditParams, params);
        // T3 (design doc follow-up / task-23): closes T2's documented limitation above by giving
        // this verb the SAME `cwd` targeting memory.list/read/write/delete already have —
        // `memoryFileDir` (this file, above) resolves cwd present -> the caller's own project
        // MEMDIR, absent -> the global bucket, EXACTLY the same resolution those four verbs use.
        // Only reached when files-mode is on; files-mode off (or `memoryFiles` absent — every
        // pre-T3 test) falls through to the UNCHANGED legacy central-log path below regardless of
        // whether `cwd` was supplied (a files-mode param is meaningless against the legacy store).
        // The file-backed audit line (`MemDirAuditLine`/`appendMemDirAudit`, memory-file-ops.ts)
        // only ever carries `{ts, op, name}` — no sessionId/source/scope/description, since MEMDIR
        // itself has no scope concept (T2's own doc comment) and only the RPC delete path is
        // audited at all. Mapped onto the wire's `MemoryAuditLineSchema` shape here: `source:"rpc"`
        // (only the RPC delete path is ever audited), `scope` synthesized from whether `cwd` was
        // supplied ("project" vs "user") purely for display parity with the legacy shape — it is
        // NOT read back to resolve anything. `auditTailMemDir` mirrors `MemoryStore.auditTail`'s
        // own newest-LAST/limit contract; reversed to newest-FIRST here, same as the legacy branch.
        if (opts.memoryFiles?.enabled()) {
          const dir = memoryFileDir(opts.memoryFiles, p.cwd);
          const lines = auditTailMemDir(dir, p.limit)
            .slice()
            .reverse()
            .map((l) => ({ ts: l.ts, source: "rpc" as const, scope: p.cwd ? ("project" as const) : ("user" as const), action: l.op, name: l.name }));
          return { lines };
        }
        // Legacy central-log path (T1/T2, unchanged): store contract is newest-LAST (memory.ts's
        // own doc comment); the wire contract (design doc §4) is newest-FIRST — reversed here,
        // once, rather than pushing that inversion onto every caller.
        const lines = (opts.memory?.auditTail(p.limit) ?? []).slice().reverse();
        return { lines };
      }

      // -----------------------------------------------------------------------------------------
      // Workflows (CC-parity phase 3, Track C Task C2): the management/control surface over
      // WorkflowRuntime (live runs) + WorkflowStore (saved `.norma/workflows/*.js` scripts, C1).
      // Role-gated exactly like routines.*/memory.* above — no additional role check here (harness
      // AND admin may both call these; a plugin or remote connection is role-rejected before
      // dispatch ever reaches this switch, since none of these four are in PLUGIN_ALLOWED_METHODS
      // or REMOTE_ALLOWED_METHODS — LOCAL-ONLY IN V1, Global Constraints). Every verb below
      // validates `sessionId`/`runId` exist first (unknown → NOT_FOUND), same
      // `opts.store.meta(...)` try/catch idiom as session.addDir/peripheral.lease above.
      // -----------------------------------------------------------------------------------------
      case METHODS.workflowList: {
        const p = parseParams(WorkflowListParams, params);
        let meta: ReturnType<SessionStore["meta"]>;
        try {
          meta = opts.store.meta(p.sessionId);
        } catch (e) {
          throw new RpcFailure(ERR.NOT_FOUND, (e as Error).message);
        }
        const cwd = p.cwd ?? meta.cwd;
        const running = opts.workflows?.list(p.sessionId) ?? [];
        const saved = opts.workflowStore?.list(cwd) ?? [];
        return { running, saved };
      }
      case METHODS.workflowRun: {
        const p = parseParams(WorkflowRunParams, params);
        let meta: ReturnType<SessionStore["meta"]>;
        try {
          meta = opts.store.meta(p.sessionId);
        } catch (e) {
          throw new RpcFailure(ERR.NOT_FOUND, (e as Error).message);
        }
        if (!opts.workflows) throw new RpcFailure(ERR.INTERNAL, "workflows are not available on this server (no WorkflowRuntime configured)");
        let source: string;
        if (p.name) {
          if (!opts.workflowStore) throw new RpcFailure(ERR.INTERNAL, "workflows are not available on this server (no WorkflowStore configured)");
          const resolved = opts.workflowStore.read(p.name, meta.cwd);
          if (!resolved) throw new RpcFailure(ERR.NOT_FOUND, `unknown workflow: ${p.name}`);
          source = resolved.body;
        } else if (p.script) {
          source = p.script;
        } else {
          throw new RpcFailure(ERR.INVALID_PARAMS, "workflow.run requires either `name` or `script`");
        }
        const runId = opts.workflows.launch({ sessionId: p.sessionId, source, args: p.args, name: p.name });
        return { runId, status: "running" };
      }
      case METHODS.workflowStop: {
        const p = parseParams(WorkflowStopParams, params);
        const stopped = opts.workflows?.stop(p.runId) ?? false;
        return { ok: true, stopped };
      }
      case METHODS.workflowGet: {
        const p = parseParams(WorkflowGetParams, params);
        const run = opts.workflows?.get(p.runId);
        if (!run) throw new RpcFailure(ERR.NOT_FOUND, `unknown run: ${p.runId}`);
        return { run };
      }

      case METHODS.sessionAddDir: {
        const p = parseParams(SessionAddDirParams, params);
        let meta: ReturnType<SessionStore["meta"]>;
        try {
          meta = opts.store.meta(p.sessionId); // throws for unknown session
        } catch (e) {
          throw new RpcFailure(ERR.NOT_FOUND, (e as Error).message);
        }
        opts.dirs?.add(p.sessionId, p.path);
        const persisted = p.persist && meta.cwd !== null;
        if (persisted) addLocalDir(meta.cwd!, p.path);
        hub.append(p.sessionId, { type: "directory_added", sessionId: p.sessionId, threadId: "main", path: p.path, persisted });
        return { ok: true, roots: opts.dirs?.roots(p.sessionId) ?? [] };
      }
      case METHODS.sessionSetCwd: {
        const p = parseParams(SessionSetCwdParams, params);
        opts.store.setCwd(p.sessionId, p.cwd);
        return { ok: true, cwd: p.cwd };
      }
      case METHODS.trustDir: {
        const p = parseParams(TrustDirParams, params);
        opts.trust?.trust(p.path);
        return { ok: true, trusted: true };
      }
      case METHODS.bgList: {
        const p = parseParams(BgListParams, params);
        return { tasks: opts.bg?.list(p.sessionId) ?? [] };
      }
      case METHODS.bgPeek: {
        const p = parseParams(BgPeekParams, params);
        if (!opts.bg) throw new RpcFailure(ERR.NOT_FOUND, "background tasks unavailable");
        try {
          return opts.bg.read(p.sessionId, p.taskId);
        } catch (e) {
          throw new RpcFailure(ERR.NOT_FOUND, (e as Error).message);
        }
      }
      case METHODS.bgKill: {
        const p = parseParams(BgKillParams, params);
        if (!opts.bg) throw new RpcFailure(ERR.NOT_FOUND, "background tasks unavailable");
        try {
          opts.bg.kill(p.sessionId, p.taskId);
        } catch (e) {
          throw new RpcFailure(ERR.NOT_FOUND, (e as Error).message);
        }
        return { ok: true };
      }
      case METHODS.bgKillAll: {
        const p = parseParams(BgKillAllParams, params);
        const killed = opts.bg?.list(p.sessionId).filter((t) => t.status === "running").length ?? 0;
        opts.bg?.killAllForSession(p.sessionId);
        return { ok: true, killed };
      }

      // -----------------------------------------------------------------------------------------
      // Peripheral lease v1 (Phase 2f, spec §A1/§A2). Requester scope is SESSIONS-ONLY in v1: a
      // non-"harness" role (the plugin role doesn't exist end-to-end yet — TokenAuthority.verify
      // has no plugin token, so this guard is defensive/future-proofing) gets the typed denied
      // result the spec pins, rather than a bare role-rejection error — see spec §A2 "Requester
      // scope" and the plan's Task 3 carried item #4.
      // -----------------------------------------------------------------------------------------
      case METHODS.peripheralLease: {
        const p = parseParams(PeripheralLeaseParams, params);
        if (socket.data.authedRole !== "harness") return { code: "denied", reason: "plugin-leasing-not-yet-available" };
        try { opts.store.meta(p.sessionId); } catch (e) { throw new RpcFailure(ERR.NOT_FOUND, (e as Error).message); }
        if (!opts.peripheral) return { code: "no_provider" };
        return await opts.peripheral.lease({ sessionId: p.sessionId, class: p.class });
      }
      case METHODS.peripheralRenew: {
        const p = parseParams(PeripheralRenewParams, params);
        if (socket.data.authedRole !== "harness") return { code: "denied", reason: "plugin-leasing-not-yet-available" };
        try { opts.store.meta(p.sessionId); } catch (e) { throw new RpcFailure(ERR.NOT_FOUND, (e as Error).message); }
        if (!opts.peripheral) return { code: "not_found" };
        return opts.peripheral.renew({ leaseId: p.leaseId, token: p.token });
      }
      case METHODS.peripheralRelease: {
        const p = parseParams(PeripheralReleaseParams, params);
        if (socket.data.authedRole !== "harness") return { code: "denied", reason: "plugin-leasing-not-yet-available" };
        try { opts.store.meta(p.sessionId); } catch (e) { throw new RpcFailure(ERR.NOT_FOUND, (e as Error).message); }
        if (!opts.peripheral) return { code: "not_found" };
        return opts.peripheral.release({ leaseId: p.leaseId, token: p.token });
      }
      case METHODS.peripheralAdvertise: {
        const p = parseParams(PeripheralAdvertiseParams, params);
        // Pin (Task 3 carried item #3): THE provider = the connection that most recently
        // advertised — any authed harness may advertise; last write wins (mirrors
        // PeripheralBroker.advertise's own "last advertiser wins" semantics).
        if (socket.data.authedRole !== "harness") {
          throw new RpcFailure(ERR.UNAUTHORIZED, "peripheral.advertise requires harness role");
        }
        opts.peripheral?.advertise(socket.data, p.classes, socket.data.clientName);
        opts.providerLink?.setWriter(socket.data.writer);
        return { ok: true };
      }
      case METHODS.peripheralRevoke: {
        const p = parseParams(PeripheralRevokeParams, params);
        if (!opts.peripheral?.isProvider(socket.data)) {
          throw new RpcFailure(ERR.UNAUTHORIZED, "peripheral.revoke requires the active provider connection");
        }
        return opts.peripheral.revoke({ leaseId: p.leaseId, all: p.all, reason: p.reason });
      }
      case METHODS.peripheralRespond: {
        const p = parseParams(PeripheralRespondParams, params);
        if (!opts.peripheral?.isProvider(socket.data)) {
          throw new RpcFailure(ERR.UNAUTHORIZED, "peripheral.respond requires the active provider connection");
        }
        return opts.peripheral.respond({ requestId: p.requestId, resultJson: p.resultJson, error: p.error });
      }

      // -----------------------------------------------------------------------------------------
      // Hardware helper (Phase 4c Task 2, spec §5): plugin (or harness, dev/testing) → core →
      // Norma.app's XPC helper. Consent gating lives HERE, not in HardwareBroker — the broker has
      // no PluginStore access, only `verbClass` (this file's `hardware.request` case is the one
      // place that has BOTH the requesting plugin's PluginInfo and the verb's class at once). A
      // plugin-role caller must have the verb's class in its manifest's `permissions.hardware`
      // AND a "hardware" consent record on file; an unknown verb (`verbClass` returns null) skips
      // straight past this gate — the broker's own `request()` typed-rejects it as
      // `{code:"unknown_verb"}` (same check, reused, so a plugin can never learn "not consented"
      // for a verb that isn't even real). A harness (or admin) caller skips consent entirely —
      // dev/testing precedent, same as peripheral.lease's non-plugin paths — but is still audited,
      // as a `{kind:"harness"}` requester, by the broker itself.
      // -----------------------------------------------------------------------------------------
      case METHODS.hardwareRequest: {
        const p = parseParams(HardwareRequestParams, params);
        if (!opts.hardware) throw new RpcFailure(ERR.NOT_FOUND, "hardware broker unavailable");
        let requester: { kind: "plugin" | "harness"; id: string };
        if (socket.data.authedRole === "plugin") {
          const pluginId = socket.data.pluginId;
          if (!pluginId) throw new RpcFailure(ERR.UNAUTHORIZED, "hardware.request requires an authenticated plugin connection");
          requester = { kind: "plugin", id: pluginId };
          const cls = verbClass(p.verb);
          if (cls) {
            // Phase 4d-ii Task 2: livePlugins() (not the boot-time-stale opts.plugins directly) —
            // otherwise a `plugin.setConsent`/`plugin.enable {consent:true}` grant of "hardware"
            // consent would stay invisible to this gate until a daemon restart, quietly breaking
            // this task's "applied HOT" promise for the hardware.request consent path specifically.
            const info = livePlugins().find((pl) => pl.name === pluginId);
            if (!info?.hardwarePermissions.includes(cls)) {
              opts.hardware.auditDenied({ requester, verb: p.verb, code: "consent_denied", missing: cls });
              return { code: "consent_denied", missing: cls };
            }
            if (!info.consented.includes("hardware")) {
              opts.hardware.auditDenied({ requester, verb: p.verb, code: "consent_denied", missing: "hardware" });
              return { code: "consent_denied", missing: "hardware" };
            }
          }
        } else {
          requester = { kind: "harness", id: socket.data.clientName };
        }
        return await opts.hardware.request({ requester, verb: p.verb, argsJson: p.argsJson });
      }
      case METHODS.hardwareRespond: {
        const p = parseParams(HardwareRespondParams, params);
        if (!opts.peripheral?.isProvider(socket.data)) {
          throw new RpcFailure(ERR.UNAUTHORIZED, "hardware.respond requires the active provider connection");
        }
        return opts.hardware?.respond({ requestId: p.requestId, resultJson: p.resultJson, error: p.error }) ?? { ok: true };
      }

      // -----------------------------------------------------------------------------------------
      // Dashboard read methods (Phase 2f, spec Part B). All read-only except trust.remove.
      // -----------------------------------------------------------------------------------------
      case METHODS.daemonStatus: {
        parseParams(DaemonStatusParams, params);
        return {
          version: opts.serverVersion,
          uptimeMs: Date.now() - (opts.startedAt ?? Date.now()),
          socketPath: opts.socketPath,
          provider: opts.providerInfo ?? null,
          sessionsCount: opts.store.list().length,
          // Phase 4d-i Task 4: real installed-plugin count (was hardcoded 0). Installed count
          // (opts.plugins?.list().length), not a running-Tier-2 count — matches the field name
          // "pluginsCount" (installed plugins, mirroring skills.list/mcp.list which report
          // everything discovered, not just currently-active entries).
          pluginsCount: opts.plugins?.list().length ?? 0,
        };
      }
      case METHODS.engineActivity: {
        parseParams(EngineActivityParams, params);
        return { activeTurns: opts.engine?.activeTurnCount() ?? 0 };
      }
      case METHODS.quotaState: {
        parseParams(QuotaStateParams, params);
        const state = opts.quota?.state() ?? { kind: "ok" as const };
        const usage = opts.quota?.usage() ?? { inputTokens: 0, outputTokens: 0 };
        return { ...state, ...usage }; // FLAT merge — see carried item #2 (matches the NormaKit wrapper)
      }
      case METHODS.trustList: {
        parseParams(TrustListParams, params);
        return { dirs: opts.trust?.list() ?? [] };
      }
      case METHODS.trustRemove: {
        const p = parseParams(TrustRemoveParams, params);
        // No admin-gating precedent exists on this socket yet (daemon.trustDir has none either) —
        // fall back to harness-role + an audit log line, per the plan's Task 3 interface note.
        if (socket.data.authedRole !== "harness") {
          throw new RpcFailure(ERR.UNAUTHORIZED, "trust.remove requires harness role");
        }
        const removed = opts.trust?.remove(p.path) ?? false;
        console.error(`[trust.remove] path=${p.path} removed=${removed} by=${socket.data.clientName}`);
        return { removed };
      }

      // -----------------------------------------------------------------------------------------
      // provider.configure (BYOK T1, design doc `2026-07-16-byok-provider-setup-design.md` §1): the
      // in-app "bring your own OpenAI API key" path. Scoped + purpose-specific — NOT a generic
      // secret-write RPC. Writes the api-key secret via the daemon's OWN SecretStore (`secrets`
      // above), never a Swift-side Keychain write, then loads settings.json, REPLACES the whole
      // `provider` block with `{type:"openai-compatible", baseUrl, model: model ?? "gpt-4o"}` (every
      // other top-level settings field is preserved via the spread), and saves. Provider-TYPE
      // changes need a daemon restart to actually take effect (providers/manager.ts fixes
      // `providerType` at boot from the settings snapshot it was constructed with) — this RPC only
      // persists the new config; triggering that restart is the caller's job (T2's Dashboard pane
      // calling `daemonSupervisor?.restart()`). `parseParams`'s zod validation above already rejects
      // a malformed baseUrl or empty apiKey as INVALID_PARAMS before this body ever runs.
      // -----------------------------------------------------------------------------------------
      case METHODS.providerConfigure: {
        const p = parseParams(ProviderConfigureParams, params);
        if (!opts.normaHome) throw new RpcFailure(ERR.INTERNAL, "provider.configure is not available on this server (no normaHome configured)");
        if (!opts.secrets) throw new RpcFailure(ERR.INTERNAL, "provider.configure is not available on this server (no secret store configured)");
        await opts.secrets.set(OPENAI_API_KEY_SECRET, p.apiKey);
        const settingsPath = join(opts.normaHome, "settings.json");
        const settings = loadSettings(settingsPath);
        saveSettings(settingsPath, {
          ...settings,
          provider: { type: "openai-compatible", baseUrl: p.baseUrl, model: p.model ?? "gpt-4o" },
        });
        return { ok: true };
      }

      // -----------------------------------------------------------------------------------------
      // plugin.revokeToken (Phase 4b Task 2, spec §3): harness-role admin verb, same precedent as
      // trust.remove above — NOT one of the six plugin-role verbs (rejected by the allowlist gate
      // above before ever reaching here if called from a plugin connection). The CLI's `norma
      // plugin disable/remove` call this best-effort instead of opening the daemon's sqlite
      // directly (locking risk) — mint stays daemon-side (Task 3, lazily at supervisor spawn).
      // -----------------------------------------------------------------------------------------
      case METHODS.pluginRevokeToken: {
        const p = parseParams(PluginRevokeTokenParams, params);
        if (socket.data.authedRole !== "harness") {
          throw new RpcFailure(ERR.UNAUTHORIZED, "plugin.revokeToken requires harness role");
        }
        opts.store.revokePluginToken(p.pluginId);
        return { ok: true };
      }

      // -----------------------------------------------------------------------------------------
      // plugin.restart (final-review Fix 1): the `PluginSupervisor.restart()` manual-restart rider
      // existed and was tested (supervisor.ts) but had no caller — this wires it up so `norma
      // plugin restart <id>` can recover a plugin stuck "circuit-open" (nothing else ever clears
      // that state short of a daemon restart). harness OR admin role, same precedent as
      // `plugins.list` above (no extra role check here) — NOT one of the six plugin-role verbs, so
      // a plugin connection never reaches this case at all (rejected by the allowlist gate first).
      // `configFor` looks up the spawn config the supervisor already has on record for a TRACKED
      // plugin (set at `startAll`/`reclaimOrphans`/an earlier `restart`) — a plugin id the
      // supervisor has never seen has nothing to restart FROM, so that's a typed NOT_FOUND rather
      // than silently no-op'ing.
      // -----------------------------------------------------------------------------------------
      case METHODS.pluginRestart: {
        const p = parseParams(PluginRestartParams, params);
        if (!opts.supervisor) throw new RpcFailure(ERR.INTERNAL, "plugin supervisor is not available on this server");
        const config = opts.supervisor.configFor(p.pluginId);
        if (!config) throw new RpcFailure(ERR.NOT_FOUND, `unknown plugin: ${p.pluginId}`);
        opts.supervisor.restart(config);
        return { ok: true };
      }

      // -----------------------------------------------------------------------------------------
      // Plugin lifecycle (Phase 4d-ii Task 2): install/enable/disable/remove/setConsent applied
      // HOT to the running daemon — the over-the-wire counterpart to the CLI's file-based,
      // restart-to-apply `norma plugin ...` flow (plugin-cli.ts). harness-role (like
      // `plugin.restart`/`plugins.list` above — no extra role check needed here); NOT any of the
      // six plugin-role verbs, so a plugin connection is role-rejected before dispatch
      // (PLUGIN_ALLOWED_METHODS above deliberately omits all five). Every result is a typed union
      // — none of these ever throw for an expected outcome (unknown plugin, bad source, needs
      // consent, already installed) — same discipline as `hardware.request`'s HardwareRequestResult
      // above; a thrown RpcFailure(INTERNAL) is reserved for genuine server misconfiguration (no
      // `normaHome` wired at all, which only an incomplete test harness would hit — `daemon.ts`
      // always wires it).
      // -----------------------------------------------------------------------------------------
      case METHODS.pluginsInstall: {
        const p = parseParams(PluginsInstallParams, params);
        if (!opts.normaHome) throw new RpcFailure(ERR.INTERNAL, "plugins.install is not available on this server (no normaHome configured)");
        const pluginsRoot = join(opts.normaHome, "plugins");
        let name: string;
        try {
          name = deriveInstallName(p.source, p.name);
        } catch {
          return { code: "invalid_source" };
        }
        let installed: InstallPluginResult;
        try {
          // Installs DISABLED + UNCONSENTED, never touches settings.json (installPluginFromDir's
          // own contract) — the caller always gets requiredConsents/consentBlock back to drive a
          // consent sheet before `plugin.enable {consent:true}` can let anything run.
          installed = installPluginFromDir(p.source, name, pluginsRoot);
        } catch (e) {
          const message = (e as Error).message;
          if (message.includes("already exists")) return { code: "already_installed", name };
          return { code: "invalid_source" }; // no manifest, invalid/traversal name, unreadable source, ...
        }
        invalidateLivePluginsCache(); // installFromDir just created a new plugins/<name> dir
        rebuildHookRegistry(); // harmless no-op here (installs disabled+unconsented, never hook-eligible) — mirrors every other lifecycle site for consistency
        const info = livePlugins().find((pl) => pl.name === installed.name);
        return {
          ok: true,
          name: installed.name,
          requiredConsents: info?.requiredConsents ?? [],
          hasMcp: info?.hasMcp ?? false,
          consentBlock: info ? buildConsentBlock(info) : [`plugin ${installed.name} requests:`],
        };
      }
      case METHODS.pluginEnable: {
        const p = parseParams(PluginEnableParams, params);
        const info = livePlugins().find((pl) => pl.name === p.name);
        if (!info) return { code: "unknown_plugin" };
        const missing = missingConsents(info.requiredConsents, info.consented);
        if (missing.length > 0 && p.consent !== true) {
          // No mutation — the caller shows this disclosure and re-calls with consent:true once
          // the user agrees (the CLI's interactive `readLine` prompt, over the wire).
          return { code: "needs_consent", requiredConsents: info.requiredConsents, consentBlock: buildConsentBlock(info) };
        }
        if (!opts.normaHome) throw new RpcFailure(ERR.INTERNAL, "plugin.enable is not available on this server (no normaHome configured)");
        const settingsPath = join(opts.normaHome, "settings.json");
        const settings = p.consent === true
          ? applyFreshPluginConsent(() => loadSettings(settingsPath), p.name, info.requiredConsents, Date.now())
          : setPluginEnabled(loadSettings(settingsPath), p.name, true);
        saveSettings(settingsPath, settings);
        invalidateLivePluginsCache();
        rebuildHookRegistry();
        const updated = livePlugins().find((pl) => pl.name === p.name) ?? info;
        return { ok: true, status: hotApplyStart(updated) };
      }
      case METHODS.pluginDisable: {
        const p = parseParams(PluginDisableParams, params);
        const info = livePlugins().find((pl) => pl.name === p.name);
        if (!info) return { code: "unknown_plugin" };
        if (!opts.normaHome) throw new RpcFailure(ERR.INTERNAL, "plugin.disable is not available on this server (no normaHome configured)");
        const settingsPath = join(opts.normaHome, "settings.json");
        // Fresh-consent semantics on disable (matches the CLI's `norma plugin disable` and the
        // design spec — lifecycle.ts's stripPluginConsents doc, settings.ts:38-40): re-enabling
        // a disabled plugin must require consenting again, so strip its consent record here too.
        saveSettings(settingsPath, stripPluginConsents(setPluginEnabled(loadSettings(settingsPath), p.name, false), p.name));
        invalidateLivePluginsCache();
        rebuildHookRegistry();
        hotApplyStop(p.name);
        return { ok: true };
      }
      case METHODS.pluginRemove: {
        const p = parseParams(PluginRemoveParams, params);
        const info = livePlugins().find((pl) => pl.name === p.name);
        if (!info) return { code: "unknown_plugin" };
        if (!opts.normaHome) throw new RpcFailure(ERR.INTERNAL, "plugin.remove is not available on this server (no normaHome configured)");
        hotApplyStop(p.name); // stop the running process BEFORE the directory backing it disappears
        const pluginsRoot = join(opts.normaHome, "plugins");
        const settingsPath = join(opts.normaHome, "settings.json");
        // removePluginFromSettings strips both enabled/disabled list membership AND the plugin's
        // whole consent record (it composes stripPluginConsents internally — see lifecycle.ts).
        const settings = removePluginFromSettings(loadSettings(settingsPath), p.name);
        removePluginDir(pluginsRoot, p.name); // containment-checked; a genuine fs failure here is
        // NOT swallowed — it propagates as an INTERNAL error rather than silently persisting a
        // "removed" settings state while the directory is still on disk.
        saveSettings(settingsPath, settings);
        invalidateLivePluginsCache();
        rebuildHookRegistry();
        return { ok: true };
      }
      case METHODS.pluginSetConsent: {
        const p = parseParams(PluginSetConsentParams, params);
        const info = livePlugins().find((pl) => pl.name === p.name);
        if (!info) return { code: "unknown_plugin" };
        if (!opts.normaHome) throw new RpcFailure(ERR.INTERNAL, "plugin.setConsent is not available on this server (no normaHome configured)");
        const settingsPath = join(opts.normaHome, "settings.json");
        saveSettings(settingsPath, grantPluginConsents(loadSettings(settingsPath), p.name, p.classes, Date.now()));
        invalidateLivePluginsCache();
        rebuildHookRegistry();
        return { ok: true };
      }

      // -----------------------------------------------------------------------------------------
      // Plugin tool bridge (Phase 4b Task 4, spec §3): wires the six plugin-role verbs (Task 1's
      // wire shapes, Task 2's role allowlist) into PluginSupervisor (Task 3) and the SAME
      // ToolRegistry the agent engine executes every other tool call against. The
      // PLUGIN_ALLOWED_METHODS gate above only RESTRICTS what a plugin-role connection may call —
      // it never widens who may call these, so a harness connection could technically reach these
      // cases too; each handler below still requires `socket.data.pluginId` itself (a
      // contribution/tool with no owning plugin id makes no sense), which only a plugin-role hello
      // ever sets.
      // -----------------------------------------------------------------------------------------
      case METHODS.pluginRegister: {
        const p = parseParams(PluginRegisterParams, params);
        // socket.data.pluginId is the id THIS connection actually authenticated as (hello,
        // verified against the sqlite-hashed plugin_tokens table) — authoritative over the wire
        // param. A mismatch means a plugin trying to register under an id it never authenticated
        // as; reject rather than silently trust `p.pluginId`.
        if (!socket.data.pluginId || p.pluginId !== socket.data.pluginId) {
          throw new RpcFailure(ERR.UNAUTHORIZED, "plugin.register: pluginId does not match the authenticated connection");
        }
        const conn: PluginConn = {
          push: (event) => socket.data.writer.enqueue(encodeLine({ jsonrpc: "2.0", method: METHODS.event, params: event })),
        };
        // The wire result is always {ok:true} (PluginRegisterResult has no room for a typed
        // rejection) regardless of whether the supervisor actually accepted the registration — a
        // late/duplicate/unexpected registration (notifyRegistered returns false) just means this
        // connection's tools, once registered, will never be invokable until a fresh spawn cycle
        // re-registers it; the plugin itself learns nothing different from a normal success.
        opts.supervisor?.notifyRegistered(socket.data.pluginId, conn);
        return { ok: true };
      }
      case METHODS.toolRegister: {
        const p = parseParams(ToolRegisterParams, params);
        const pluginId = socket.data.pluginId;
        if (!pluginId) throw new RpcFailure(ERR.UNAUTHORIZED, "tool.register requires an authenticated plugin connection");
        if (!opts.registry || !opts.supervisor) {
          throw new RpcFailure(ERR.INTERNAL, "plugin tool bridge is not available on this server");
        }
        const registry = opts.registry;
        const supervisor = opts.supervisor;
        const registeredAs = `plugin__${pluginId}__${p.name}`;
        try {
          registry.register({
            name: registeredAs,
            description: p.description,
            // The plugin author's raw JSON schema (or none) rides verbatim as rawParameters,
            // exactly like MCP's mcp/manager.ts#startOne — `args` is a permissive passthrough
            // since core never re-validates plugin-supplied argument shapes beyond "is an object"
            // (ToolRegisterParams.parameters's own doc comment, protocol/methods.ts).
            args: z.object({}).passthrough(),
            rawParameters: p.parameters,
            run: async (args) => {
              const result = await supervisor.invoke(pluginId, p.name, JSON.stringify(args));
              if ("ok" in result) return result.resultJson;
              // Throwing here is deliberate: ToolRegistry.execute's catch turns a thrown Error's
              // message into `{output: message, isError: true}` — the ONLY way a ToolDefinition's
              // `run()` (which returns a plain string) produces an isError tool_result.
              throw new Error(pluginInvokeErrorMessage(pluginId, p.name, result));
            },
          });
        } catch (e) {
          throw new RpcFailure(ERR.INVALID_REQUEST, (e as Error).message);
        }
        return { ok: true, registeredAs };
      }
      case METHODS.pluginToolResult: {
        const p = parseParams(PluginToolResultParams, params);
        // Final-review Fix 2: caller-bound — settle only goes through if THIS connection's own
        // authenticated pluginId (never a wire param) matches the pending invoke's pluginId. See
        // resolveToolResult's doc comment (plugins/supervisor.ts).
        return opts.supervisor?.resolveToolResult(p, socket.data.pluginId) ?? { ok: true };
      }
      case METHODS.shortcutRegister: {
        const p = parseParams(ShortcutRegisterParams, params);
        if (!socket.data.pluginId) throw new RpcFailure(ERR.UNAUTHORIZED, "shortcut.register requires an authenticated plugin connection");
        opts.contrib?.setShortcuts(socket.data.pluginId, p.shortcuts);
        return { ok: true };
      }
      case METHODS.tileUpdate: {
        const p = parseParams(TileUpdateParams, params);
        if (!socket.data.pluginId) throw new RpcFailure(ERR.UNAUTHORIZED, "tile.update requires an authenticated plugin connection");
        opts.contrib?.setTile(socket.data.pluginId, p.tile);
        broadcastTileUpdated(socket.data.pluginId);
        return { ok: true };
      }
      case METHODS.providerRegister: {
        const p = parseParams(ProviderRegisterParams, params);
        if (!socket.data.pluginId) throw new RpcFailure(ERR.UNAUTHORIZED, "provider.register requires an authenticated plugin connection");
        opts.contrib?.setProvider(socket.data.pluginId, p.info);
        return { ok: true };
      }
      case METHODS.pluginsContrib: {
        parseParams(PluginsContribParams, params);
        const entries = opts.contrib?.all().map(({ pluginId, state }) => ({ pluginId, ...state })) ?? [];
        return { ok: true, entries };
      }

      // Phase 4d Task 2 (spec §6/§7): the reverse direction of the tile broadcast above — a
      // future UI fires a plugin's registered shortcut or a tile-action button. HARNESS-role (not
      // in PLUGIN_ALLOWED_METHODS, so a plugin connection is role-rejected before it ever reaches
      // here). Both push a transient, session-less event straight to the target plugin's own
      // connection via PluginSupervisor.pushToPlugin — the SAME runtimes lookup
      // plugin_tool_invoke's dispatch uses (`supervisor.invoke`, above) — but fire-and-forget, no
      // request/response correlation. `seq` reuses the SAME local `systemSeq` monotonic counter as
      // `broadcastTileUpdated`'s plugin_tile_updated (store.lastSeq() throws for $system — see that
      // counter's own doc comment). No supervisor wired in at all (no agentProvider) means core has
      // no record of any plugin — degrades to unknown_plugin, same as a truly untracked id.
      case METHODS.shortcutInvoke: {
        const p = parseParams(ShortcutInvokeParams, params);
        if (!opts.supervisor) return { code: "unknown_plugin" };
        const event = {
          type: "shortcut_invoke" as const, sessionId: SYSTEM_SESSION_ID, seq: ++systemSeq, ts: Date.now(),
          shortcutId: p.shortcutId,
        };
        return opts.supervisor.pushToPlugin(p.pluginId, event);
      }
      case METHODS.tileAction: {
        const p = parseParams(TileActionParams, params);
        if (!opts.supervisor) return { code: "unknown_plugin" };
        const event = {
          type: "tile_action" as const, sessionId: SYSTEM_SESSION_ID, seq: ++systemSeq, ts: Date.now(),
          actionId: p.actionId,
        };
        return opts.supervisor.pushToPlugin(p.pluginId, event);
      }

      default:
        throw new RpcFailure(ERR.METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  }

  return { stop() { server.stop(true); } };
}
