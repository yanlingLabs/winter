// P8b Task 16 — THE DRIVER TABLE: `sessionId → WinterSession`, and everything a Winter session needs
// assembled before a `winter` child can run it.
//
// `ipc/server.ts` routes by asking this table (see `WinterSessionDrivers`): a live driver wins; a
// record that says "winter" with no live driver is resumed here; an ENGINE-ERA record (no Winter
// transcript) and a record-less session are typed refusals in the IPC layer (P8b-22 / fix wave
// F2) — since Task 17 there is no engine to fall back to. The table is built once in `daemon.ts`
// (after the runtime spine has recovered and the router handle has run its directory recovery — a
// projector is never constructed before that sweep) and shared with the IPC layer through
// `IpcServerOptions.winter`.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE CREATION TRANSACTION (WS-16 §6, P8b-14) — one record per session
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// `session.create` persists ONE `RuntimeSessionRecord` with `backendSessionId` = a fresh uuid (the
// child's transcript name — `Options.sessionId` on the first incarnation, `Options.resume`
// afterwards), `transcriptHealth: "clean"`, `versionProvenance: "recorded"` with the SDK/catalog
// versions this daemon pins. (Task 16's dual-run also wrote a backfill-shaped ENGINE record for
// engine-leg creates; fix wave F9 deleted that half with the engine — 8a's boot backfill is now the
// only producer of a record without a backend id, for pre-8b rows.)
//
// There is no `leg` column (Task 16 finding); `sessionLegOf(record)` reads the leg off
// `backendSessionId`, which is the same fact P8b-22's refusal needs ("a record whose Winter
// transcript does not exist").
//
// REFUSALS ARE TYPED AND NEVER FALL BACK (P8b-2). `assertAvailable(mode)` runs BEFORE the product
// session row is minted, so an executable that cannot be resolved costs nothing but the reply; a
// record write that fails after the row exists is rolled back by the caller (the row is deleted —
// it was never announced to any client). Every refusal is a `WinterLegRefusal` whose `code` the IPC
// layer forwards as the JSON-RPC error's `data.code`.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { classifyPermissionMode } from "@yanlinglabs/winter-agent-sdk/messaging";
import type { PermissionClassLabel } from "@yanlinglabs/winter-agent-sdk/messaging";
import type { EffortLevel, McpServerConfig, Options, PermissionResult, ProviderConnectionConfig } from "@yanlinglabs/winter-agent-sdk";
import { transcriptProjectKey } from "@yanlinglabs/winter-agent-sdk";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { isSelectionRefusal, type RuntimeDirectoryEntry, type RuntimeSelection, type SelectionAlternative } from "@yanlinglabs/winter-runtime-sdk";
import type { SecretStore } from "../auth/secret-store";
import type { ApprovalBroker } from "../agent/approvals";
import type { PermissionGate, SessionApprovalPolicy } from "../agent/gate";
import type { QuestionBroker } from "../agent/questions";
import { WINTER_CAPABILITY_TOOLS, assertNoCapabilityCollision, type CapabilityServerRecord, type CapabilitySession } from "../capabilities";
import { createProjector, type Projector } from "../projector";
import type { RuntimeSessionRecord, RuntimeSessionRecords } from "../runtime-state/records";
import type { ProjectionCheckpoints } from "../runtime-state/checkpoints";
import type { SessionHub } from "../sessions/hub";
import type { SessionStore } from "../sessions/store";
import { officialSubscriptionAuthEnabled, providerBaseUrlFor, winterOptionsFromSettings, type Settings } from "../settings";
import { d30DefaultModel } from "./advisor-reviewer";
import { canUseToolFor, type BridgedApprovalRequest } from "./approval-bridge";
import type { WinterRuntimeSdk, SessionMode } from "./create";
import { clearSession } from "./diff-attach";
import { credentialPresenceFrom, credentialRefFor } from "./keychain";
import { apiKeyProviderIsUnauthenticated, missingCredentialDetail } from "./credentials";
import { renderNoCredentialHint } from "./handoff";
import { legForNewSession, sessionLegOf, type SessionLeg } from "./leg";
import { attachOfficialSession, attachWinterSession } from "./messaging";
import { buildWinterOptions, permissionModeFor } from "./mode-options";
import { catalogRowsFor, inventoryProvidersServing, providerSelectionFor, qualifiedProviderFor, testProviderNameFor } from "./provider-selection";
import { winterSessions } from "./sessions";
import { WINTER_PEER_VERSIONS } from "./versions";
import { winterSystemPromptFor } from "./system-prompt";
import { DISPATCH_EFFORT, DISPATCH_MODEL } from "../agent/dispatch-config";
import type { AgentRegistry } from "../agent/bg-agent-registry";
import type { ContextAssembler } from "../agent/context";
import { startWinterSession, unconsumedUserMessages, type WinterChildrenSink, type WinterIncarnation, type WinterIncarnationShape, type WinterSession } from "./winter-session";
import { ClaudeExecutableUnavailable } from "./official-executable";
import { startOfficialSession, type OfficialSession } from "./official-session";
import { officialAuthFamilyFor, OfficialConsoleProfileMissing, OfficialConsoleRouterUnsupported, type OfficialInputDeps, type OfficialSessionInput } from "./official-options";

export type WinterLegRefusalCode =
  | "winter_executable_unavailable"   // P8b-2: no `winter` binary resolves (setting → env → bundle → home)
  | "winter_leg_unavailable"          // the router handle or the runtime spine did not construct
  | "session_predates_winter_leg"     // P8b-22: the record has no Winter transcript to resume
  // `session_unrecorded` (fix wave F2) is minted by `ipc/server.ts` directly — a session with NO
  // record at all (phone-owned, `createSynced`) never reaches the table's own refusals.
  | "winter_session_ended"            // the driver said the store refused it for good
  | "not_supported_on_winter_leg"     // `session.compact` (SDK 0.0.4 carry)
  | "claude_executable_unavailable"   // P8c-3: no `claude` binary resolves for an official-leg create
  | "runtime_selection_refused"       // P8c-14: the router's selectRuntime refused this session's model
  | "official_console_router_unsupported" // C1-interim: the pinned router cannot support the console auth arm yet
  | "console_profile_missing"; // Winter Phase 10a fix wave (F3): the console arm's on-disk profile is missing

/**
 * P8c-14: the intersection of `WinterSession`'s and `OfficialSession`'s public members — everything
 * the IPC layer and this table's own `evict`/`list`/`endAll`/`runTurn` need, on EITHER leg, without
 * caring which one a given driver actually is. Deliberately excludes `query`/`turnStartedAt`
 * (Winter-only; nothing outside `winter-session.ts` reads them) and `resumed`'s callers never
 * needed cross-leg parity beyond the boolean itself.
 */
export interface LegSession {
  readonly sessionId: string;
  readonly backendSessionId: string;
  readonly mode: SessionMode;
  readonly state: "live" | "resumable" | "ended";
  readonly generation: number;
  readonly resumed: boolean;
  readonly init: { sessionId?: string; model?: string; tools: string[] } | undefined;
  readonly turnRunning: boolean;
  /** Present on both legs (`WinterSession`/`OfficialSession` both track it) — `daemon.ts`'s
   *  `list_sessions` activity surface reads it across whichever leg a session is actually on. */
  readonly turnStartedAt: number | undefined;
  readonly done: Promise<void>;
  readonly pendingSends: readonly string[];
  readonly heldDeliveries: readonly string[];
  send(text: string, clientName?: string): Promise<{ seq: number; queued: boolean }>;
  steer(text: string, clientName?: string): Promise<{ seq: number; injected: boolean }>;
  interrupt(): Promise<{ wasRunning: boolean }>;
  compact(): Promise<never>;
  setModel(model?: string): Promise<void>;
  setPolicy(policy: SessionApprovalPolicy): Promise<void>;
  end(): Promise<void>;
  deliver(text: string): void;
  open(): Promise<void>;
  idle(): Promise<void>;
}

export class WinterLegRefusal extends Error {
  /**
   * `reason` (WS-19, W19-7) is the refusal's own sub-classification, additive beside `code` and
   * carried through to `error.data.reason` by `ipc/server.ts` — the same slot `session.setModel`'s
   * review refusals already use. `runtime_selection_refused` is one code covering several distinct
   * situations, and a client that wants to say "you have no key for DeepSeek" rather than "the model
   * could not be selected" needs to tell them apart without string-matching the message.
   */
  constructor(readonly code: WinterLegRefusalCode, message: string, readonly reason?: string) {
    super(message);
    this.name = "WinterLegRefusal";
  }
}

/**
 * WS-19 (W19-7, review Minor 2): which of the router's own refusal reasons a MISSING CREDENTIAL can
 * actually produce — the only ones `refusalForSelection` may re-describe as `no-credential`.
 *
 * MEASURED against the pinned router (0.0.7), because the two are not interchangeable:
 *
 *   - `"no-credential"` is what a CLAUDE-family model gets ("...is served by rows with no configured
 *     credential ref"), and it carries `alternatives`.
 *   - `"slot-unservable"` is what EVERY OTHER family gets for the identical situation — the detail
 *     reads "every candidate row was blocked, deprecated, known-unservable, or belongs to a provider
 *     with no configured credential ref (configured: none)". A `deepseek` session with an empty slot
 *     is refused with THIS reason, never `no-credential`, which is why gating on the literal
 *     `"no-credential"` alone would silently switch W19-7 off for every non-Claude provider.
 *
 * Everything else — `"runtime-unavailable"`, `"mode-forbids-runtime"`, `"claude-oauth-not-approved"`,
 * and any reason a later router adds (the union is widened to `string` for exactly that) — is NOT
 * about a credential and keeps its own reason and its own words. An allowlist, not a denylist: a new
 * reason is passed through verbatim until someone deliberately decides it belongs here.
 */
export function refusalMayBeCredentialShaped(reason: string): boolean {
  return reason === "no-credential" || reason === "slot-unservable";
}

/** The narrowed `SessionMode` a stored `mode` column resolves to (absent = code, as everywhere). */
const modeOf = (raw: string | undefined): SessionMode => (raw === "chat" || raw === "dispatch" ? raw : "code");

/** Winter's effort strings that are also the SDK's `EffortLevel`. `none` is the wire's "unset" and
 *  `ultra` is Winter-only (a client-side selector the engine translates); neither crosses here. */
const SDK_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);
const sdkEffortOf = (raw: string | undefined): EffortLevel | undefined => (raw !== undefined && SDK_EFFORTS.has(raw) ? (raw as EffortLevel) : undefined);

export interface WinterLegDeps {
  home: string;
  /** `WINTER_PROFILE` for the child (`""` on dist). */
  profile?: string;
  /** THE LIVE settings holder. */
  settings: () => Settings | null | undefined;
  runtime: WinterRuntimeSdk | undefined;
  /** 8a's repositories; undefined when the spine is offline (the Winter leg then refuses). */
  records: RuntimeSessionRecords | undefined;
  checkpoints: ProjectionCheckpoints | undefined;
  store: SessionStore;
  hub: SessionHub;
  secrets: SecretStore;
  buildSessionCapabilities: (session: CapabilitySession) => CapabilityServerRecord;
  approvals: ApprovalBroker;
  questions: QuestionBroker;
  gate: PermissionGate;
  rootsOf: (sessionId: string) => string[];
  tmpDirOf: (sessionId: string) => string;
  outDirOf: (sessionId: string) => string;
  /** The memory key the LIVE memory path files this cwd under (relocation-aware). */
  memoryKeyOf: (cwd: string) => string;
  /** Task 17 Step 0(a): the daemon's ONE `ContextAssembler` — Winter's system prompt per mode,
   *  composed per incarnation (hot: WINTER.md, memory, the output style are re-read on resume).
   *  Absent (a harness without one) ⇒ no `systemPrompt` and the child runs Winter's own. */
  assembler?: Pick<ContextAssembler, "assemble">;
  /** Task 17 (P8b-15): the persisted child roster (`createPersistedChildren` over 8a's
   *  `runtime_children`). A Winter child is registered under the spawning `tool_use.id` with NO
   *  local abort (its process is the session's), fed `progress()` on every frame of its thread, and
   *  completed from the spawning call's `tool_result`. */
  children?: AgentRegistry;
  /** The activity enforcement's post-turn re-check (`enforcement.onTurnSettled(sessionId)`). */
  onTurnSettled?: (sessionId: string) => void;
  /**
   * Fix wave (review row 4): Winter's `SessionTitler` — P8b-10 keeps it on Winter's OWN provider
   * layer (never `sdk.query()`). Fired fire-and-forget after every MAIN-thread `turn_completed`
   * that is not an error terminal, which is exactly where the engine fired it (`engine.ts`'s two
   * depth-0 completion sites: `void this.cfg.titler.maybeTitle(sessionId)` right after the
   * `turn_completed` emit; never on the error paths — an errored first turn has nothing worth
   * titling). `maybeTitle` dedupes itself (store title guard + in-flight set) and never throws.
   */
  titler?: { maybeTitle(sessionId: string): Promise<void> };
  /** Any OTHER MCP servers merged into a session's record. Fix wave (review row 7): the daemon
   *  fills this with Winter's CONFIGURED servers — `settings.mcpServers` + a trusted project's
   *  `.mcp.json` — as SDK stdio configs (`runtime-sdk/external-mcp.ts`), read live per incarnation.
   *  Plugin-contributed tools (`tool.register`) are NOT here: they are registry entries, not server
   *  configs, and stay the `winter__external` capability carry. A key colliding with a daemon-owned
   *  `winter__<key>` server refuses the session typed (`assertNoCapabilityCollision`). */
  extraMcpServers?: (session: CapabilitySession) => Record<string, McpServerConfig>;
  log?: (line: string) => void;
  /**
   * P8c-14 (integration round 2): lane 2's `planBridgeFor(...)` module — this file never imports
   * it, only threads a value of this shape through to both legs' `CanUseToolDeps.planBridge`
   * (`approval-bridge.ts`, consulted BEFORE the generic gate/never-prompt logic when
   * `toolName === "ExitPlanMode"`). Now typed EXACTLY as `CanUseToolDeps.planBridge` (widened from
   * the original `unknown`-shaped placeholder once a real consumer existed on both legs) — the
   * Winter path passes it straight into `canUseToolFor` below; the official path passes it into
   * `assembleOfficial`'s `canUseToolDeps` (`officialBrokerFor` reads the SAME field).
   */
  planBridge?: { onExitPlanMode(req: BridgedApprovalRequest): Promise<PermissionResult> };
  /**
   * P8c-14 (integration round 2): lane 3's `sessionHooksFor(...)` module — this file never imports
   * it, only threads its result through. `.official` is wired into the official leg's
   * `OfficialInputDeps.hooks` below (`assembleOfficial`'s own `inputDeps()`); `.winter` is now
   * threaded into the Winter incarnation's `buildWinterOptions({..., hooks})` call above (`.winter`
   * TYPED as `Options["hooks"]`, not `unknown`, since `mode-options.ts`'s `WinterOptionsInput.hooks`
   * needs that exact type and `sessionHooksFor(...).winter` already produces it).
   */
  hooksFor?: (session: CapabilitySession) => { winter?: Options["hooks"]; official?: unknown };
  /** Test seams. */
  idleTimeoutMs?: () => number;
  endGraceMs?: number;
  /**
   * TEST ONLY — never set by production `daemon.ts` wiring (fix round 1, M2): the ONLY way an
   * official-leg e2e reaches a loopback fake is a real `anthropic:default` credential PLUS this
   * override, injected the same way `startDaemon`'s own test callers already inject a fake
   * provider — never an ambient env var (the deleted `WINTER_OFFICIAL_TEST_BASE_URL` hatch). Mirrors
   * the `winter-test/<name>` double's own shape: a value only a test constructs, threaded through
   * an explicit parameter, inert unless a caller supplies one.
   */
  officialConnectionOverride?: () => { explicitConnectionEnv?: Readonly<Record<string, string>>; authFamily?: RuntimeSelection["authFamily"] } | undefined;
}

export interface WinterSessionDrivers {
  /** P8b-13: the leg a NEW session of this mode is created on, from the live settings. */
  legForNewSession(mode: SessionMode): SessionLeg;
  /** The leg an EXISTING session runs on, from its record; undefined when it has no record. */
  legOf(sessionId: string): SessionLeg | undefined;
  /** Refuse (typed) unless a Winter-leg session of this mode could be created right now. Runs
   *  BEFORE the product row is minted, so a refusal costs nothing. */
  assertAvailable(mode: SessionMode): void;
  /** The creation transaction, for a session row that already exists: decide the leg
   *  (`runtime.selectRuntimeFor`), persist the record (fresh backend uuid), start the driver,
   *  register it. Throws `WinterLegRefusal`. P8c-14: may return either leg's session. */
  create(sessionId: string): Promise<LegSession>;
  /** The live driver, if any. */
  get(sessionId: string): LegSession | undefined;
  /** One HEADLESS turn (routines, the -p path): the session's driver (created for a session that
   *  has no record yet, resumed otherwise), `send`, then wait until nothing is in flight. */
  runTurn(sessionId: string, text: string, clientName: string): Promise<void>;
  /** A live driver, or a resumed one when the record says "winter"/"official"; undefined ⇒ no
   *  transcript to resume (an engine-era or record-less session — the IPC layer refuses typed). */
  ensure(sessionId: string): Promise<LegSession | undefined>;
  /** The session was DELETED (the reaper, the cleaner): end its child (bounded) and forget the
   *  driver — a live child never outlives its session (the reaper's 600 s grace is shorter than
   *  the 900 s idle timer). Never throws. */
  evict(sessionId: string): Promise<void>;
  list(): LegSession[];
  /** End every live driver (bounded each). Shutdown reaches them through `trackQuery` anyway; this
   *  is the door a test drives. */
  endAll(): Promise<void>;
}

/**
 * The `sessionPermissionClass` seam Task 12 left for this task (`WinterRuntimeSdkDeps`): the inbound
 * class of a session this process holds NO live facet for. Without it every unattached receiver
 * holds its mail forever; with it a parked (`resumable`) session answers the honest `unavailable`
 * and is never cold-resumed behind the daemon's back.
 *
 * The directory address carries the BACKEND id; the 8a record is the hop back to Winter's session,
 * whose stored policy is the fact the class is derived from — `permissionModeFor(policy)` →
 * `classifyPermissionMode`, the same 1:1 map the session's own `Options.permissionMode` took.
 */
export function sessionPermissionClassFor(deps: {
  records: () => Pick<RuntimeSessionRecords, "byBackendSessionId"> | undefined;
  store: Pick<SessionStore, "meta">;
}): (entry: RuntimeDirectoryEntry) => PermissionClassLabel {
  return (entry) => {
    try {
      const backend = entry.parsed?.winterSessionId ?? entry.backendSessionId;
      if (backend === undefined) return "unknown";
      const record = deps.records()?.byBackendSessionId(backend);
      if (record === undefined) return "unknown";
      const policy = deps.store.meta(record.winterSessionId).approvalPolicy;
      // `bypassAvailable` is the SDK's "was `allowDangerouslySkipPermissions` granted" predicate,
      // and `mode-options.ts` grants it under the `bypass` policy only — so the two ARE one
      // predicate. (The SDK consults it for `plan` alone; `bypassPermissions` classifies
      // `bypasses` unconditionally, everything else `prompts`.)
      return classifyPermissionMode(permissionModeFor(policy), { bypassAvailable: policy === "bypass" });
    } catch {
      return "unknown";
    }
  };
}

/** The driver's three child moments → the persisted roster's doors. `agentId` = `threadId` = the
 *  spawning `tool_use.id` (the cross-lane contract `capability-parity.test.ts` pins). No `name`:
 *  Winter children are addressed by id, and two children may share a description. */
export function childrenSinkFor(registry: AgentRegistry, sessionId: string, log: (line: string) => void): WinterChildrenSink {
  return {
    started(child) {
      const res = registry.register({ agentId: child.threadId, sessionId, threadId: child.threadId });
      if (!res.ok) log(`child ${child.threadId} of ${sessionId} not registered: ${res.error}`);
    },
    progress(threadId) { registry.progress(threadId); },
    completed(threadId, stopReason) {
      registry.complete(threadId, { ok: stopReason === "end_turn", result: "" });
    },
  };
}

export function createWinterSessionDrivers(deps: WinterLegDeps): WinterSessionDrivers {
  const drivers = new Map<string, LegSession>();
  const log = deps.log ?? ((): void => {});
  const sdkVersion = WINTER_PEER_VERSIONS.winterAgentSdk;

  const catalogVersion = (): string => {
    try { return loadCatalog().catalogVersion; } catch { return "unstated"; }
  };

  const legForNew = (mode: SessionMode): SessionLeg => legForNewSession(mode, deps.settings() ?? undefined);

  /** The spine half of `assertAvailable`: the handle and 8a's repositories exist. */
  const assertSpine = (): void => {
    if (deps.runtime === undefined) throw new WinterLegRefusal("winter_leg_unavailable", "the Winter runtime handle did not construct on this daemon (a packaging fault — see the boot log); sessions cannot be created until it does");
    if (deps.records === undefined || deps.checkpoints === undefined) throw new WinterLegRefusal("winter_leg_unavailable", "runtime-state is offline on this daemon; the Winter leg needs its records and checkpoints");
  };

  const assertAvailable = (mode: SessionMode): void => {
    assertSpine();
    const hook = deps.runtime!.spawnHookFor(mode);
    if (hook instanceof Error) throw new WinterLegRefusal("winter_executable_unavailable", hook.message);
  };

  /** The 8a record, read WITHOUT letting a store failure out of `legOf`/`ensure`: a records store
   *  that will not answer costs the log line here and a TYPED refusal in the IPC layer
   *  (`session_unrecorded`, fix wave F2) — never a throw out of the table. */
  const recordOf = (sessionId: string): RuntimeSessionRecord | undefined => {
    try { return deps.records?.get(sessionId); } catch (err) {
      log(`runtime record for ${sessionId} unreadable (${err instanceof Error ? err.name : "unknown"}) — treated as unrecorded`);
      return undefined;
    }
  };

  /** The Winter leg's fallback for a cwd-less session: its per-session temp dir (the CC-parity
   *  $TMPDIR — the directory the child actually runs in, so its transcript key names it). 8a's
   *  boot backfill uses `home` for a pre-8b row instead (`migrations/backfill.ts`) — that shape
   *  is the surviving truth for engine-ERA records, which nothing here writes any more. */
  const winterCwdOf = (sessionId: string, cwd: string | null | undefined): string => cwd ?? deps.tmpDirOf(sessionId);

  /** The facts every incarnation of a session needs, assembled once per driver. */
  const assemble = (sessionId: string, backendSessionId: string): WinterSession => {
    const runtime = deps.runtime!;
    const records = deps.records!;
    const checkpoints = deps.checkpoints!;
    const meta = deps.store.meta(sessionId);
    const mode = modeOf(meta.mode);
    const cwd = winterCwdOf(sessionId, meta.cwd);
    const home = deps.home;

    const canUseTool = canUseToolFor({
      sessionId, mode, origin: meta.origin, home, cwd,
      // A getter: `session.setPolicy` mid-session is seen by the NEXT call (the engine re-reads too).
      policy: () => deps.store.meta(sessionId).approvalPolicy,
      approvals: deps.approvals, questions: deps.questions, gate: deps.gate,
      emit: (event) => { deps.hub.append(sessionId, event); },
      threadId: "main",
      // P8c-14 (integration round 2): `ExitPlanMode` on the Winter leg now answers through the
      // controller-wired plan bridge (see `WinterLegDeps.planBridge`'s own doc comment).
      ...(deps.planBridge === undefined ? {} : { planBridge: deps.planBridge }),
    });

    /** Predictive, and exact: the driver appends every batch synchronously right after the projector
     *  returns it, so "the store's lastSeq plus how many this batch has already claimed" IS the seq
     *  the store will stamp. Reset after every append (a user_message the host appends itself, the
     *  bridge's cards between frames — none of them drift it, because it is re-read per call). */
    let claimedInBatch = 0;
    const append = (event: Parameters<SessionHub["append"]>[1]) => {
      const stamped = deps.hub.append(sessionId, event);
      claimedInBatch = 0;
      // The engine's titling moment, reproduced at the ONE place every persisted Winter-leg event
      // passes: after the main thread's `turn_completed` is in the log (so `maybeTitle`'s read of
      // the first user/assistant pair sees a complete turn). Never on an error terminal.
      if (deps.titler !== undefined && event.type === "turn_completed") {
        const threadId = (event as { threadId?: string }).threadId;
        const stop = (event as { stopReason?: string }).stopReason;
        if ((threadId === undefined || threadId === "main") && stop !== "error") {
          try { void deps.titler.maybeTitle(sessionId); } catch { /* maybeTitle never throws by contract; belt only */ }
        }
      }
      return stamped;
    };

    const optionsFor = async (inc: WinterIncarnationShape) => {
      const live = deps.store.meta(sessionId);
      const settings = deps.settings();
      const hook = runtime.spawnHookFor(mode);
      if (hook instanceof Error) throw new WinterLegRefusal("winter_executable_unavailable", hook.message);
      const credentials = await credentialPresenceFrom(deps.secrets);
      // `resolveSel`, the engine's own resolution: dispatch runs its FIXED PIN (`DISPATCH_MODEL` at
      // `DISPATCH_EFFORT`; `session.setModel`/`setEffort` refuse a dispatch target, so a stored
      // override can only come from a harness that wrote the store directly — a test's door to
      // the `winter-test/*` doubles); every other mode is the per-session override, else the
      // daemon's configured provider model.
      const model = mode === "dispatch" ? (live.model ?? DISPATCH_MODEL) : (live.model ?? settings?.provider?.model);
      const effort = mode === "dispatch" ? sdkEffortOf(live.effort ?? DISPATCH_EFFORT) : sdkEffortOf(live.effort);
      const selection = providerSelectionFor(model, credentials, deps.home, settings);
      // P8b-30: a BYO `openai-compatible` endpoint travels as the provider's connection, or the
      // catalog's `openai` row would route it to api.openai.com.
      //
      // Fix wave item 2 (measured against a real child): `local: true` is a DELIBERATE
      // compatibility decision, not an oversight — the SAME one `providers/runtime-provider.ts`'s
      // own `createOpenAiCompatibleRuntimeProvider` already makes for the identical setting.
      // Without it the Winter runtime's own endpoint policy refuses a loopback/private-address
      // base URL outright ("points at a loopback address but the connection is not declared
      // local"), which — measured — is not merely a test-fixture inconvenience: it silently
      // broke every real self-hosted/LAN `openai-compatible` endpoint (Ollama, LM Studio, a local
      // gateway) on the Winter leg, even though Winter's own `openai-compatible` provider type has
      // never had an endpoint allowlist ("arbitrary API models are legitimate there" — the SAME
      // doc comment `runtime-provider.ts` cites). A no-op for an ordinary public HTTPS endpoint
      // (the address-class check never triggers for one).
      //
      // WS-19 (W19-6): the SAME connection shape is now available for ANY provider, through
      // `settings.providers.<catalogId>.baseUrl`. There is deliberately NO daemon-side endpoint
      // table: the catalog ships each provider's own `defaultEndpoints` and the SDK's
      // `connectionFrom` copies them for the multi-provider adapters (deepseek/zai/openrouter/xai
      // all ride `winter.openai-chat-completions`), so an unconfigured provider needs no
      // `connection` at all and gets the right endpoint anyway. This block is for the case the SDK
      // cannot answer — a self-hosted or proxied endpoint, and the loopback fakes the parity e2e
      // tests point at.
      //
      // THE LEGACY ARM KEEPS PRECEDENCE and stays byte-identical: a home that configured BYO OpenAI
      // through `settings.provider` is unaffected by this block existing, even if it ALSO happens to
      // carry a `providers.openai.baseUrl`. Read hot, per incarnation, like everything else here.
      const legacyOpenAiConnection: ProviderConnectionConfig | undefined =
        settings?.provider?.type === "openai-compatible" && selection?.providerId === "openai"
          ? { baseUrl: settings.provider.baseUrl, endpointOrigin: "user", local: true }
          : undefined;
      const perProviderBaseUrl = selection === undefined ? undefined : providerBaseUrlFor(settings, selection.providerId);
      const connection: ProviderConnectionConfig | undefined =
        legacyOpenAiConnection
        ?? (perProviderBaseUrl === undefined ? undefined : { baseUrl: perProviderBaseUrl, endpointOrigin: "user", local: true });
      const capSession: CapabilitySession = {
        sessionId, mode, cwd,
        roots: deps.rootsOf(sessionId),
        tmpDir: deps.tmpDirOf(sessionId),
        outDir: deps.outDirOf(sessionId),
        signal: inc.abort.signal,
      };
      const capabilities = deps.buildSessionCapabilities(capSession);
      // Winter's own voice (Step 0(a)): the engine's `primaryDir`/`cwd`/`additionalWorkDirs` inputs,
      // read live so a resume sees the session's current directories.
      let primary: string | undefined = live.cwd ?? undefined;
      let extraDirs: string[] = [];
      try {
        const rows = deps.store.dirs(sessionId).map((d) => d.path);
        primary ??= rows[0];
        extraDirs = primary === undefined ? [] : rows.filter((d) => d !== primary);
      } catch { /* a session with no dirs row: workdir-less */ }
      const systemPrompt = deps.assembler === undefined ? undefined : winterSystemPromptFor(deps.assembler, {
        mode, origin: live.origin, primary, cwd: primary ?? deps.tmpDirOf(sessionId),
        outDir: deps.outDirOf(sessionId), extraDirs, effort: live.effort,
      });
      // P8b-36 obligation: any other server merged into the same record must not shadow a
      // daemon-owned one. Since the fix wave the configured user/project MCP servers ARE merged
      // here, so the guard is live: a `settings.mcpServers` key spelled `winter__browser` refuses
      // this session TYPED (the message names the server) rather than handing the model a
      // `browser` that is not Winter's under Winter's name. The user fixes the key; settings are hot.
      const extra = deps.extraMcpServers?.(capSession) ?? {};
      try { assertNoCapabilityCollision(extra, capabilities); } catch (err) {
        throw new WinterLegRefusal("winter_leg_unavailable", err instanceof Error ? err.message : String(err));
      }
      // P8d-8 (D30), computed ONCE (review Minor fix): `runtimes.advisorModel` when the user set
      // one, else Winter's own D30 default for this session's model family.
      const advisorModel = winterOptionsFromSettings(settings).advisorModel ?? d30DefaultModel(model);
      return buildWinterOptions({
        mode,
        policy: live.approvalPolicy,
        origin: live.origin,
        sessionId: backendSessionId,
        home,
        profile: deps.profile,
        cwd,
        model,
        credentials,
        settings,
        effort,
        ...(systemPrompt === undefined ? {} : { systemPrompt }),
        spawn: hook,
        canUseTool,
        abort: inc.abort,
        capabilityTools: WINTER_CAPABILITY_TOOLS,
        capabilities: { ...extra, ...capabilities } as CapabilityServerRecord,
        ...(connection === undefined ? {} : { connection }),
        resume: inc.resume,
        // P8c-14 (integration round 2): the Winter-leg half of lane 3's hooks facade — the official
        // leg's `inputDeps()` below already threads `.official`; this is that same call's `.winter`.
        ...(deps.hooksFor === undefined ? {} : { hooks: deps.hooksFor(capSession).winter }),
        // P8d-8 (D30): a LIVE read at every incarnation — `runtimes.advisorModel` when the user set
        // one, else Winter's own D30 default for this session's model family (`advisor-reviewer.ts`'s
        // `d30DefaultModel`), so `Options.advisor.model` is ALWAYS explicit rather than depending on
        // the child's own internal default resolution (the M5 gap this task diagnosed). Computed
        // ONCE (review Minor fix) — the prior form called both `winterOptionsFromSettings` and
        // `d30DefaultModel` twice for the identical value.
        ...(advisorModel === undefined ? {} : { advisorModel }),
      });
    };

    const projectorFor = (inc: WinterIncarnation): Projector =>
      createProjector({
        sessionId, mode,
        generation: inc.generation,
        winterSessionId: sessionId,
        runtimeKind: "winter-agent",
        nextSeq: () => deps.store.lastSeq(sessionId) + (++claimedInBatch),
        checkpoint: checkpoints,
        now: () => new Date().toISOString(),
        log: {
          warn: (message, fields) => log(`${message} ${fields === undefined ? "" : JSON.stringify(fields)}`.trim()),
        },
      });

    const hasTranscript = async (): Promise<boolean> => {
      try { await winterSessions(home).getSessionInfo(backendSessionId); return true; } catch { return false; }
    };

    /**
     * WS-19 (W19-7) — THE PRE-TURN CREDENTIAL REFUSAL.
     *
     * WHY IT IS A TURN GATE AND NOT PART OF `optionsFor` (fix round 2, and the correction of a real
     * regression): `optionsFor` runs at EVERY `open()`, including the eager one `session.create` and
     * `session.dispatch` perform — so refusing there made a credential-less home unable to create
     * ANY session at all. A fresh install has no key yet, and the Mac app dispatches a session at
     * launch, so that is the "orb Enter silently no-op'd" class of failure, not a safety win. The
     * thing that must not happen is a TURN against a provider Winter holds no credential for, and
     * `beforeTurn` is the one place every turn passes — still strictly BEFORE the child is spawned
     * (it runs ahead of `send`/`steer`'s own `open()`), so it is never a vendor 401 mid-turn.
     *
     * Everything else about the rule is unchanged from the first round: the refusal is typed
     * (`runtime_selection_refused`, reason `no-credential`), it names the provider and the three
     * doors, and it fires on EVERY incarnation's first turn — a fresh create, a resume after an idle
     * reap, a resume after a daemon restart.
     *
     * THE EXEMPTION is today's behaviour preserved byte-for-byte: the legacy `openai-compatible` arm
     * (a BYO `settings.provider.baseUrl`) is never refused, because a self-hosted or LAN endpoint —
     * Ollama, LM Studio, a local gateway — legitimately wants no key at all. The per-provider
     * `providers.<id>.baseUrl` arm is NOT exempt. A `local-none` provider is excluded a layer down,
     * by auth family (`apiKeyProviderIsUnauthenticated`).
     */
    const beforeTurn = async (): Promise<void> => {
      const live = deps.store.meta(sessionId);
      const settings = deps.settings();
      const model = mode === "dispatch" ? (live.model ?? DISPATCH_MODEL) : (live.model ?? settings?.provider?.model);
      if (model === undefined) return;
      // ONLY A PROVIDER WINTER ACTUALLY DECIDED ON — never `providerSelectionFor`'s inventory-order
      // FALLBACK, and this is the second half of the fix round 2 correction.
      //
      // When a BARE model id is served by several inventory providers and NONE of them is
      // credentialled, `providerSelectionFor` returns `inInventory[0]` — a name, deliberately, not a
      // decision (its own doc: "a provider that serves the model but has NO stored credential still
      // returns a selection WITHOUT an authRef — the child then refuses with its own typed provider
      // error, which is a better message than anything the host could invent"). Refusing on that
      // fallback is exactly the invention it warns against: a fresh home configured for Codex OAuth,
      // asking for `gpt-5.6-sol`, was being told to run `winter credentials set openai` — a provider
      // the user never chose, through a door that would not have helped. It is also what broke the
      // WinterKit gateway suite, whose harness dispatches on precisely that home.
      //
      // So the gate fires for the two cases where the provider IS Winter's answer:
      //   - a fully-qualified `<provider>/<model>` key (`deepseek/deepseek-reasoner`), which names
      //     one provider and no other;
      //   - a bare id only ONE inventory provider serves, where there is nothing to be ambiguous
      //     about.
      // Anything else falls through to the child's own typed provider error, exactly as before
      // WS-19. Codex OAuth is additionally never in scope at all — its auth family is `custom`, and
      // `winter login`, not an API key, is its door (`apiKeyProviderIsUnauthenticated`).
      const servingProviders = inventoryProvidersServing(model);
      if (qualifiedProviderFor(model) === undefined && servingProviders.length !== 1) return;
      const credentials = await credentialPresenceFrom(deps.secrets);
      const selection = providerSelectionFor(model, credentials, deps.home, settings);
      if (selection === undefined) return;
      if (settings?.provider?.type === "openai-compatible" && selection.providerId === "openai") return;
      if (apiKeyProviderIsUnauthenticated(selection.providerId, credentials.byProvider[selection.providerId] !== undefined)) {
        throw new WinterLegRefusal("runtime_selection_refused", missingCredentialDetail(selection.providerId), "no-credential");
      }
    };

    const session = startWinterSession({
      sessionId, backendSessionId, mode, runtime,
      options: optionsFor,
      beforeTurn,
      projector: projectorFor,
      append,
      broadcast: (event) => { deps.hub.broadcastTransient(sessionId, event); },
      messaging: {
        attach: attachWinterSession,
        facts: () => {
          const title = deps.store.getTitle(sessionId) ?? undefined;
          const record = records.get(sessionId);
          return { ...(title === undefined ? {} : { title }), cwd, ...(record === undefined ? {} : { selection: record.selection }) };
        },
      },
      records,
      hasTranscript,
      ...(deps.children === undefined ? {} : { children: childrenSinkFor(deps.children, sessionId, log) }),
      ...(deps.onTurnSettled === undefined ? {} : { onTurnSettled: () => deps.onTurnSettled!(sessionId) }),
      // P8b-39: the session log is the durable queue — what `open()` re-pushes is read from it.
      unconsumed: () => unconsumedUserMessages(deps.store.read(sessionId)),
      idleTimeoutMs: deps.idleTimeoutMs ?? (() => winterOptionsFromSettings(deps.settings()).idleTimeoutSec * 1000),
      ...(deps.endGraceMs === undefined ? {} : { endGraceMs: deps.endGraceMs }),
      log,
    });
    drivers.set(sessionId, session);
    return session;
  };

  /**
   * P8c-14: the official leg's per-session assembly, mirroring `assemble()`'s shape as closely as
   * the two legs' state machines allow (same `append`/titler hook, same capability-record source).
   * SYNCHRONOUS on purpose — `ensure()`'s "no await from map-miss to drivers.set" invariant (see
   * `assemble`'s own callers) applies to this leg too, and `runtime.officialPeerSync()`/
   * `claudeExecutableFor()` are both synchronous accessors for exactly this reason.
   */
  const assembleOfficial = (sessionId: string, backendSessionId: string, persistedSelection: RuntimeSelection): OfficialSession => {
    const runtime = deps.runtime!;
    const records = deps.records;
    const meta = deps.store.meta(sessionId);
    const mode = modeOf(meta.mode);
    const cwd = winterCwdOf(sessionId, meta.cwd);
    // TEST-ONLY (see `officialConnectionOverride` on `WinterLegDeps`): the LIVE query's own
    // selection is widened to the injected `authFamily` (a loopback needs `custom` so the
    // env-allowlist's family-shape check does not itself refuse `ANTHROPIC_BASE_URL`) — never the
    // PERSISTED record, which keeps the router's real decision.
    const connectionOverride = deps.officialConnectionOverride?.();
    // Winter Phase 10a (router 0.0.4, C1): Winter's OWN console-vs-api-key decision now widens THIS
    // session's `RuntimeSelection.authFamily` to `"console-profile"` directly, rather than riding a
    // parallel `officialAuthArm` field the way the C1-interim fix wave did — the router's own
    // `openOfficialLeg` re-derives `credentials`/`connectionEnv` from `Options.runtime.selection`
    // AT SPAWN (measured: `officialCredentialPlan`/`officialConnectionEnv` are called a SECOND time
    // inside the router, keyed on `request.selection`, not merely on whatever `officialInputFor`
    // pre-computed) — so a selection left at `"api-key"` would have the router re-inject
    // `ANTHROPIC_API_KEY` from the provider's own authRef regardless of what this host built, and a
    // widened `connectionEnv` paired with an unwidened `"api-key"` selection would fail the router's
    // own `validateAuthEnvironment` ("a variable outside the family's set") before the child ever
    // spawned. Evaluated HERE (session assembly, same posture as the `connectionOverride` widening
    // above and as every other family this leg persists) rather than per-incarnation inside
    // `inputDeps()`: `officialAuthFamilyFor`'s `hasApiKey` argument is accepted only for
    // `provider.status`'s own "effective auth" combination (its own doc: "accepted for the caller's
    // use, not consulted here") — the family decision itself needs no async credential read, so
    // nothing here is losing liveness by moving out of the per-`open()` closure; `officialAuthFamilyFor`
    // still re-reads `deps.settings()` (hot) and the console profile file's live on-disk presence
    // each time THIS function runs (once per session assembly — fresh session create, or resume from
    // a record after a driver restart), the same "no daemon restart required" contract every other
    // settings-hot-reload call site in this file already has.
    const officialAuthArm: "api-key" | "console" | undefined =
      connectionOverride?.authFamily === undefined && persistedSelection.authFamily === "api-key"
        ? officialAuthFamilyFor(deps.home, deps.settings(), false)
        : undefined;
    const selection: RuntimeSelection = connectionOverride?.authFamily !== undefined
      ? { ...persistedSelection, authFamily: connectionOverride.authFamily }
      : officialAuthArm === "console"
        ? { ...persistedSelection, authFamily: "console-profile" }
        : persistedSelection;

    let claimedInBatch = 0;
    const append = (event: Parameters<SessionHub["append"]>[1]) => {
      const stamped = deps.hub.append(sessionId, event);
      claimedInBatch = 0;
      if (deps.titler !== undefined && event.type === "turn_completed") {
        const threadId = (event as { threadId?: string }).threadId;
        const stop = (event as { stopReason?: string }).stopReason;
        if ((threadId === undefined || threadId === "main") && stop !== "error") {
          try { void deps.titler.maybeTitle(sessionId); } catch { /* maybeTitle never throws by contract; belt only */ }
        }
      }
      return stamped;
    };

    const capSessionFor = (): CapabilitySession => ({
      sessionId, mode, cwd,
      roots: deps.rootsOf(sessionId),
      tmpDir: deps.tmpDirOf(sessionId),
      outDir: deps.outDirOf(sessionId),
    });

    const sessionInput = (): OfficialSessionInput => {
      const live = deps.store.meta(sessionId);
      let primary: string | undefined = live.cwd ?? undefined;
      let extraDirs: string[] = [];
      try {
        const rows = deps.store.dirs(sessionId).map((d) => d.path);
        primary ??= rows[0];
        extraDirs = primary === undefined ? [] : rows.filter((d) => d !== primary);
      } catch { /* a session with no dirs row: workdir-less */ }
      return {
        sessionId, mode,
        cwd: primary ?? cwd,
        outDir: deps.outDirOf(sessionId),
        extraDirs,
        ...(live.effort === undefined ? {} : { effort: live.effort }),
        ...(live.origin === undefined ? {} : { origin: live.origin }),
      };
    };

    const inputDeps = async (): Promise<OfficialInputDeps> => {
      const live = deps.store.meta(sessionId);
      const capSession = capSessionFor();
      const capabilities = deps.buildSessionCapabilities(capSession);
      const hooks = deps.hooksFor?.(capSession).official;
      // The SAME credential read `optionsFor` (the Winter incarnation builder, above) makes per
      // incarnation — `officialCredentialPlan`'s auto-derivation (`official-options.ts`) needs this
      // provider's `authRef` to inject `ANTHROPIC_API_KEY` at spawn.
      const credentials = await credentialPresenceFrom(deps.secrets);
      // Winter Phase 10a fix wave 4 (M-C): NEVER thread `deps.settings()` into this call — fix
      // wave 3 (M-B, "Native sessions") used to, on the theory that it was "inert for the console
      // arm itself" and merely kept this leg's own ref decision agreeing with the Winter leg's.
      // Measured wrong: `selection.authFamily` (this session's ARM) is fixed ONCE, at session
      // ASSEMBLY (`assembleOfficial`, above) — it is never re-widened by a later `open()` — while
      // `inputDeps()` runs fresh on EVERY `open()`/resume. A session assembled on the "api-key" arm
      // before a Console sign-in, then re-opened after one (the profile file and `anthropic:console`
      // bearer both now present), would have THIS call re-point `provider.authRef` at
      // `anthropic:console` on the very next open — while `selection.authFamily` stayed the
      // assembly-time `"api-key"`. The router's own `officialCredentialPlan` derives
      // `ANTHROPIC_API_KEY` from `provider.authRef` for the api-key family regardless of which
      // account that ref names, so the child would receive `ANTHROPIC_API_KEY=<the Console OAuth
      // bearer>` — and `official-session.ts`'s own `apiKeySource === "ANTHROPIC_API_KEY"` assertion
      // still passes, because it only checks WHICH env var the vendor CLI read from, never which
      // account produced its value. Fix: never let this leg's own credential ref move with live
      // settings — `credentialRefFor`'s own doc says an absent `settings` argument keeps its OLD,
      // unconditional `anthropic:default` answer, which is exactly what the api-key arm must
      // ALWAYS get; the console arm never reads `provider.authRef` at all regardless of what it
      // holds (`officialCredentialPlan`'s own `AUTH_FAMILY_VARIABLES["console-profile"]` injects
      // nothing), so leaving it at the same settings-independent `anthropic:default` value costs
      // the console arm nothing. (Simplest of the two fixes the review offered — dropping the
      // argument — chosen over threading `selection.authFamily` through explicitly, since the
      // settings-independent default already IS "api-key arm -> anthropic:default" with no new
      // branch needed.) The native Winter leg's own `optionsFor` (this file, above) is UNCHANGED —
      // it re-derives its OWN per-incarnation live choice every `open()`, which is correct for that
      // leg because it has no separately-fixed `selection.authFamily` to disagree with.
      const provider = providerSelectionFor(live.model, credentials, deps.home);
      // TEST-ONLY (`WinterLegDeps.officialConnectionOverride`, fix round 1 M2 — never an ambient
      // env var, never set by production `daemon.ts` wiring): a loopback fake needs
      // `ANTHROPIC_BASE_URL` beside the key, which the `api-key` family's own variable set does
      // not include (WS-14 §12) — the SAME reason the router's own door-bed test widens to
      // `authFamily: "custom"` (done above, in `assembleOfficial`). `custom` needs the credential
      // named explicitly too (`officialCredentialPlan` refuses to guess it for that family), so
      // this still derives the REAL keychain ref for the provider the router actually selected —
      // only the CONNECTION is test-injected, never the credential material.
      const testOverrides = connectionOverride === undefined || provider?.providerId === undefined ? {} : {
        explicitCredentials: [{ variable: "ANTHROPIC_API_KEY", ref: credentialRefFor(provider.providerId, deps.home) ?? provider.authRef! }],
        ...(connectionOverride.explicitConnectionEnv === undefined ? {} : { explicitConnectionEnv: connectionOverride.explicitConnectionEnv }),
      };
      // Winter Phase 10a (router 0.0.4, C1): the console-vs-api-key decision now lives entirely in
      // `selection.authFamily` (widened once, above, in `assembleOfficial` — see that widening's own
      // doc for why the parallel `officialAuthArm` field from the C1-interim fix wave is gone). This
      // closure captures `selection` from the outer scope, so `official-session.ts`'s init-message
      // assertion (`this.deps.selection.authFamily`) and this leg's `officialInputFor` call
      // (`deps.selection.authFamily` below) read the identical value with no separate field to keep
      // in sync.
      return {
        home: deps.home,
        selection,
        ...(provider === undefined ? {} : { provider }),
        ...testOverrides,
        officialPeer: runtime.officialPeerSync(),
        claudeExecutableFor: () => runtime.claudeExecutableFor(),
        assembler: deps.assembler ?? { assemble: () => "" },
        capabilities,
        // Phase 9c (P9c-1): the LIVE settings snapshot (`deps.settings()` — the same hot holder
        // `create()`/`legForNew` already read above; never a boot snapshot) — `official-options.ts`'s
        // `officialInputFor` reads it ONLY through `officialSubscriptionAuthEnabled`, and
        // `official-session.ts`'s own init-message assertion reads the SAME value off this object
        // (never re-fetched separately) so the two agree within one incarnation. This is the one
        // field `OfficialInputDeps` cannot get from `WinterRuntimeSdk` itself (that handle exposes
        // no settings accessor of its own — only this driver's own `deps.settings` holds it), which
        // is why it is threaded here rather than read inside `official-session.ts`/`official-options.ts`.
        settings: deps.settings(),
        canUseToolDeps: {
          approvals: deps.approvals, questions: deps.questions, gate: deps.gate,
          emit: (event) => { deps.hub.append(sessionId, event); },
          home: deps.home, threadId: "main",
          ...(live.origin === undefined ? {} : { origin: live.origin }),
          // A getter, same as the Winter incarnation builder's own `canUseTool` above — a
          // `session.setPolicy` mid-session is seen by the NEXT approval, not just the next open().
          policy: () => deps.store.meta(sessionId).approvalPolicy,
          // P8c-14 (integration round 2): the SAME plan bridge the Winter leg wires above —
          // `officialBrokerFor` (official-options.ts) reads this field the identical way.
          ...(deps.planBridge === undefined ? {} : { planBridge: deps.planBridge }),
        },
        policy: live.approvalPolicy,
        ...(hooks === undefined ? {} : { hooks }),
      };
    };

    const projectorFor = (generation: number): Projector =>
      createProjector({
        sessionId, mode,
        generation,
        winterSessionId: sessionId,
        runtimeKind: "claude-agent",
        nextSeq: () => deps.store.lastSeq(sessionId) + (++claimedInBatch),
        checkpoint: deps.checkpoints!,
        now: () => new Date().toISOString(),
        log: {
          warn: (message, fields) => log(`${message} ${fields === undefined ? "" : JSON.stringify(fields)}`.trim()),
        },
      });

    const session = startOfficialSession({
      sessionId, backendSessionId, mode, runtime, selection,
      sessionInput,
      inputDeps,
      projector: projectorFor,
      append,
      broadcast: (event) => { deps.hub.broadcastTransient(sessionId, event); },
      messaging: {
        attach: attachOfficialSession,
        facts: () => {
          const title = deps.store.getTitle(sessionId) ?? undefined;
          const record = records?.get(sessionId);
          return { ...(title === undefined ? {} : { title }), cwd, ...(record === undefined ? {} : { selection: record.selection }) };
        },
      },
      records,
      log,
    });
    drivers.set(sessionId, session);
    return session;
  };

  /** `selection.reason` is what `winter doctor` and the app render for "why is this session on that
   *  runtime" — it narrates a FACT, never a flag: since Task 17 the Winter leg is the only leg
   *  (fix wave F12 retired the "settings.runtimes.winterLeg.<mode> is on" wording, which named a
   *  setting that no longer decides anything). */
  const selectionFor = (mode: SessionMode, model: string | undefined, providerId: string, authFamily: RuntimeSelection["authFamily"]): RuntimeSelection => ({
    runtimeKind: "winter-agent",
    providerId,
    modelRef: model ?? "unknown",
    family: "winter",
    authFamily,
    sdkVersion,
    reason: `created as a ${mode} session on the Winter leg (the only leg since Phase 8b)`,
    decidedAt: new Date().toISOString(),
  });

  /**
   * P8c-14: the router's decision for a NEW session, or `undefined` when the selector must not be
   * consulted at all. FOUR deliberate bail-outs, each preserving today's Winter-only behaviour
   * byte-for-byte rather than risking a regression on a case the selector was never meant to judge:
   *
   *   1. No `selectRuntimeFor` on the handle — a partial test double (`session-driver.test.ts`'s
   *      own fake `WinterRuntimeSdk`, which implements only `spawnHookFor`/`trackQuery`/`untrack`).
   *   2. `winter-test/<name>` — the double-selection convention (`testProviderNameFor`): it is
   *      chosen by env var, never by the catalog, and the listing has no row for it AT ALL, so
   *      `selectRuntime` refuses every such session outright (measured) — exactly the models every
   *      existing Winter e2e creates.
   *   3. `meta.model` unset — the session named no model of its own. Today's Winter path resolves
   *      one LATER, inside `optionsFor`, from `settings.provider.model` live at OPEN time; asking
   *      the selector to judge an as-yet-undecided model is not what P8c-12 means by "decides the
   *      leg for a session", and the router refuses an empty `requested` unconditionally (measured)
   *      — which would turn "no model configured yet" into a hard `session.create` failure for
   *      every mode. Once a model-picker UI sets `meta.model` explicitly (8d), this bail-out stops
   *      firing for that session.
   *   4. (Fix round 1, M5) The model has NO ROW IN THE PINNED CATALOG AT ALL —
   *      `catalogRowsFor(model).length === 0` — e.g. a custom `provider.baseUrl` endpoint's own
   *      model id, which `providerSelectionFor`'s own doc calls "served by no inventory provider …
   *      letting the child's own catalog-first selection answer, never a host-side throw". The
   *      selector has NOTHING to route on for a name it does not recognise at all — this is exactly
   *      that same "the child decides" case, not the D13 "we know the family, we lack the
   *      credential" refusal, so it keeps today's literal too. A model the catalog DOES recognise
   *      (e.g. a Claude model) but no provider can serve is NOT this bail-out — that stays a real,
   *      typed `runtime_selection_refused` (bail-out 4 checks the catalog, not the credential map).
   *
   * Outside those four cases the router's answer — including a REFUSAL — is honoured: a Claude
   * model with no configured credential is `runtime_selection_refused`, never a silent Winter
   * fallback (D13's own "never a substitution").
   */
  const decideRuntime = async (mode: SessionMode, model: string | undefined): Promise<RuntimeSelection | undefined> => {
    if (typeof deps.runtime?.selectRuntimeFor !== "function") return undefined;
    if (model === undefined || testProviderNameFor(model) !== undefined) return undefined;
    if (catalogRowsFor(model).length === 0) return undefined;
    const decided = await deps.runtime.selectRuntimeFor({ mode, model });
    if (isSelectionRefusal(decided)) throw await refusalForSelection(decided, model);
    return decided;
  };

  /**
   * WS-19 (W19-7): the router's refusal, made ACTIONABLE, without taking its authority away.
   *
   * Three cases, in order:
   *
   *  1. `no-credential` WITH `alternatives` — the router's own W18-3 list of every catalog row able
   *     to serve this model, whichever door. `renderNoCredentialHint` turns it into doors. This is
   *     the SAME hint `session.setModel` has rendered since D1-7 (`handoff.ts`); `session.create`
   *     simply never rendered it, so a user creating a Claude session with no Anthropic credential
   *     got the bare one-sentence detail and no way in. Only the Claude family produces this list.
   *  2. Outside that family the router has no alternatives to offer — but WINTER knows exactly which
   *     provider this model resolves to and whether its slot is empty, so it answers with its own
   *     door hint naming that provider. This is the `deepseek`/`zai`/`openrouter` case the derived
   *     inventory made reachable: without it the user gets the router's honest but unhelpful "every
   *     candidate row … belongs to a provider with no configured credential ref".
   *  3. Anything else — a runtime that is not installed, a mode that forbids one — passes through
   *     verbatim, with the router's own `reason`. `refusalMayBeCredentialShaped` is the gate: only
   *     the two reasons a MISSING CREDENTIAL can actually produce are eligible for case 2 (review
   *     Minor 2 — before this, ANY refusal was relabelled `no-credential` whenever the probe
   *     happened to find an empty slot, so a Claude session on a home with no `claude` binary would
   *     have been told to go and add an API key).
   *
   * The credential probe happens ONLY on this path (a refusal), never on the hot create path, which
   * has already done its own.
   */
  const refusalForSelection = async (refusal: { reason: string; detail: string; alternatives?: readonly SelectionAlternative[] }, model: string): Promise<WinterLegRefusal> => {
    if (refusal.reason === "no-credential" && refusal.alternatives !== undefined) {
      const hint = renderNoCredentialHint(refusal.alternatives, { subscriptionEnabled: officialSubscriptionAuthEnabled(deps.settings()) });
      return new WinterLegRefusal("runtime_selection_refused", `${refusal.detail} ${hint}`, "no-credential");
    }
    if (!refusalMayBeCredentialShaped(refusal.reason)) {
      return new WinterLegRefusal("runtime_selection_refused", refusal.detail, refusal.reason);
    }
    try {
      const credentials = await credentialPresenceFrom(deps.secrets);
      const selection = providerSelectionFor(model, credentials, deps.home, deps.settings());
      if (selection !== undefined
          && apiKeyProviderIsUnauthenticated(selection.providerId, credentials.byProvider[selection.providerId] !== undefined)) {
        return new WinterLegRefusal("runtime_selection_refused", missingCredentialDetail(selection.providerId), "no-credential");
      }
    } catch { /* a store that will not answer must not turn one refusal into a different one */ }
    return new WinterLegRefusal("runtime_selection_refused", refusal.detail, refusal.reason);
  };

  const createOfficial = async (sessionId: string, selection: RuntimeSelection): Promise<LegSession> => {
    const records = deps.records!;
    const meta = deps.store.meta(sessionId);
    const cwd = winterCwdOf(sessionId, meta.cwd);
    const executable = deps.runtime!.claudeExecutableFor();
    if (executable instanceof ClaudeExecutableUnavailable) {
      throw new WinterLegRefusal("claude_executable_unavailable", executable.message);
    }
    const backendSessionId = randomUUID();
    const transcriptKey = transcriptProjectKey(cwd);
    // m5: the same locator-only rule the Winter path follows (records.ts's own rule: never
    // material, just where to find it) — `credentialRefFor` is this leg's OWN source of truth for
    // "is this provider one of Winter's keychain-backed slots", the identical function the Winter
    // path's `explicitCredentials` build already calls (`credentialRefFor(provider.providerId) ??
    // provider.authRef!` above). `selection.providerId` is "anthropic" for a real Claude selection,
    // so this resolves to `keychain:anthropic:default`.
    const authRef = credentialRefFor(selection.providerId, deps.home);
    try {
      records.create({
        winterSessionId: sessionId,
        runtimeKind: "claude-agent",
        backendSessionId,
        providerId: selection.providerId,
        modelRef: selection.modelRef,
        ...(authRef?.kind === "keychain" ? { authRef: `keychain:${authRef.account}` } : {}),
        backendRoot: join(deps.home, "projects", transcriptKey),
        effectiveTempDir: deps.tmpDirOf(sessionId),
        transcriptProjectKey: transcriptKey,
        memoryProjectKey: deps.memoryKeyOf(cwd),
        tempProjectKey: transcriptKey,
        transcriptDialect: "claude-code-jsonl",
        transcriptHealth: "clean",
        compatibilityLevel: "agent-state",
        conformanceCorpusVersion: "unverified",
        versionProvenance: "recorded",
        sdkVersion: selection.sdkVersion,
        engineVersion: selection.sdkVersion,   // the official SDK's own version (P8c-14)
        providerCatalogVersion: catalogVersion(),
        providerAdapterVersion: "unstated",
        capabilities: ["message", "resume"],
        selection,
      });
      records.transition(sessionId, "ready");
    } catch (err) {
      throw new WinterLegRefusal("winter_leg_unavailable", `the runtime record for ${sessionId} could not be written (${err instanceof Error ? err.name : "unknown"})`);
    }
    const session = assembleOfficial(sessionId, backendSessionId, selection);
    try {
      await session.open();
    } catch (err) {
      drivers.delete(sessionId);
      if (err instanceof WinterLegRefusal) throw err;
      if (err instanceof ClaudeExecutableUnavailable) throw new WinterLegRefusal("claude_executable_unavailable", err.message);
      if (err instanceof OfficialConsoleRouterUnsupported) throw new WinterLegRefusal("official_console_router_unsupported", err.message);
      if (err instanceof OfficialConsoleProfileMissing) throw new WinterLegRefusal("console_profile_missing", err.message);
      throw new WinterLegRefusal("winter_leg_unavailable", `the official child for ${sessionId} could not be started (${err instanceof Error ? err.name : "unknown"})`);
    }
    return session;
  };

  const create = async (sessionId: string): Promise<LegSession> => {
    const meta = deps.store.meta(sessionId);
    const mode = modeOf(meta.mode);
    // The executable was asserted by the caller BEFORE the product row was minted (`session.create`);
    // here only the spine is re-checked — the first `open()` re-resolves the hook anyway and
    // refuses typed if it went away in between.
    assertSpine();
    const records = deps.records!;
    const settings = deps.settings();
    const cwd = winterCwdOf(sessionId, meta.cwd);

    const decided = await decideRuntime(mode, meta.model);
    if (decided !== undefined && decided.runtimeKind === "claude-agent") {
      return createOfficial(sessionId, decided);
    }

    const backendSessionId = randomUUID();
    const transcriptKey = transcriptProjectKey(cwd);
    const credentials = await credentialPresenceFrom(deps.secrets);
    const selection = providerSelectionFor(meta.model, credentials, deps.home, settings);
    const providerId = decided?.providerId ?? selection?.providerId ?? settings?.provider?.type ?? "unstated";
    const authFamily: RuntimeSelection["authFamily"] = settings?.provider?.type === "openai-compatible" ? "api-key" : "custom";
    try {
      records.create({
        winterSessionId: sessionId,
        runtimeKind: "winter-agent",
        backendSessionId,
        providerId,
        modelRef: meta.model ?? "unknown",
        // The LOCATOR only (`keychain:<account>`) — never material (records.ts's own rule).
        ...(selection?.authRef?.kind === "keychain" ? { authRef: `keychain:${selection.authRef.account}` } : {}),
        backendRoot: join(deps.home, "projects", transcriptKey),
        effectiveTempDir: deps.tmpDirOf(sessionId),
        transcriptProjectKey: transcriptKey,
        memoryProjectKey: deps.memoryKeyOf(cwd),
        tempProjectKey: transcriptKey,
        transcriptDialect: "claude-code-jsonl",
        transcriptHealth: "clean",
        compatibilityLevel: "agent-state",
        conformanceCorpusVersion: "unverified",
        versionProvenance: "recorded",
        sdkVersion,
        engineVersion: sdkVersion,   // the `winter` binary is built from the same pinned tag
        providerCatalogVersion: catalogVersion(),
        providerAdapterVersion: "unstated",
        capabilities: ["message", "resume"],
        // P8c-14: the router's OWN decision when it was consulted (persisted verbatim — "the
        // persisted selection wins", never re-derived); the pre-8c hand-built literal only when
        // `decideRuntime` deliberately did not ask (see that function's own three bail-outs).
        selection: decided ?? selectionFor(mode, meta.model, providerId, authFamily),
      });
      records.transition(sessionId, "ready");
    } catch (err) {
      throw new WinterLegRefusal("winter_leg_unavailable", `the runtime record for ${sessionId} could not be written (${err instanceof Error ? err.name : "unknown"})`);
    }
    const session = assemble(sessionId, backendSessionId);
    try {
      await session.open();
    } catch (err) {
      drivers.delete(sessionId);
      if (err instanceof WinterLegRefusal) throw err;
      throw new WinterLegRefusal("winter_leg_unavailable", `the winter child for ${sessionId} could not be started (${err instanceof Error ? err.name : "unknown"})`);
    }
    return session;
  };

  /**
   * INVARIANT (the single-process guarantee for racing resumes): from `ensure()`'s map miss to
   * `assemble()`'s `drivers.set` there is NO `await` — `recordOf`, `store.meta`, `assertAvailable`
   * and `assemble` are all synchronous, so two RPCs that race a resume after a restart both see
   * ONE driver (the second finds it in the map), and the driver's own `opening` promise dedupes the
   * spawn. Anything asynchronous a resume needs (credentials, the transcript check) belongs INSIDE
   * `open()`/`optionsFor`, after the driver is in the table — `create()` may await before
   * `assemble` only because its caller holds the freshly minted row nobody else can address yet.
   * `session-driver.test.ts` pins the race.
   */
  const resumeOfficial = async (sessionId: string, record: RuntimeSessionRecord): Promise<LegSession> => {
    const executable = deps.runtime!.claudeExecutableFor();
    if (executable instanceof ClaudeExecutableUnavailable) {
      throw new WinterLegRefusal("claude_executable_unavailable", executable.message);
    }
    // P8c-14: "the persisted selection wins" (D13's own rule) — resume reads `record.selection`
    // BY IDENTITY, never re-decides through `selectRuntimeFor`.
    const session = assembleOfficial(sessionId, record.backendSessionId!, record.selection);
    try {
      await session.open();
    } catch (err) {
      drivers.delete(sessionId);
      if (err instanceof WinterLegRefusal) throw err;
      if (err instanceof ClaudeExecutableUnavailable) throw new WinterLegRefusal("claude_executable_unavailable", err.message);
      if (err instanceof OfficialConsoleRouterUnsupported) throw new WinterLegRefusal("official_console_router_unsupported", err.message);
      if (err instanceof OfficialConsoleProfileMissing) throw new WinterLegRefusal("console_profile_missing", err.message);
      throw new WinterLegRefusal("winter_leg_unavailable", `the official child for ${sessionId} could not be resumed (${err instanceof Error ? err.name : "unknown"})`);
    }
    return session;
  };

  const resume = async (sessionId: string): Promise<LegSession> => {
    const record = recordOf(sessionId);
    const leg = sessionLegOf(record);
    if (leg === "official" && record !== undefined) {
      return resumeOfficial(sessionId, record);
    }
    if (leg !== "winter" || record?.backendSessionId === undefined) {
      throw new WinterLegRefusal("session_predates_winter_leg", `session ${sessionId} predates the Winter leg (it has no Winter transcript); start a new session`);
    }
    const mode = modeOf(deps.store.meta(sessionId).mode);
    assertAvailable(mode);
    const session = assemble(sessionId, record.backendSessionId);
    try {
      await session.open();
    } catch (err) {
      drivers.delete(sessionId);
      if (err instanceof WinterLegRefusal) throw err;
      if ((err as { code?: unknown })?.code === "winter_session_ended") throw new WinterLegRefusal("winter_session_ended", (err as Error).message);
      throw new WinterLegRefusal("winter_leg_unavailable", `the winter child for ${sessionId} could not be resumed (${err instanceof Error ? err.name : "unknown"})`);
    }
    return session;
  };

  /** P8c-14: a leg the table can actually resume/create a driver on. */
  const isResumableLeg = (leg: SessionLeg | undefined): boolean => leg === "winter" || leg === "official";

  return {
    legForNewSession: legForNew,
    legOf: (sessionId) => sessionLegOf(recordOf(sessionId)),
    assertAvailable,
    create,
    get: (sessionId) => drivers.get(sessionId),
    async ensure(sessionId) {
      const live = drivers.get(sessionId);
      if (live !== undefined) return live;
      if (!isResumableLeg(sessionLegOf(recordOf(sessionId)))) return undefined;
      return resume(sessionId);   // synchronous up to `drivers.set` — see the invariant above
    },
    async runTurn(sessionId, text, clientName) {
      const session = drivers.get(sessionId) ?? (isResumableLeg(sessionLegOf(recordOf(sessionId))) ? await resume(sessionId) : await create(sessionId));
      await session.send(text, clientName);
      await session.idle();
    },
    async evict(sessionId) {
      const session = drivers.get(sessionId);
      drivers.delete(sessionId);
      // M5 (whole-branch review): `diff-attach.ts`'s pending map is per-session and in-memory —
      // an evicted session's own PostToolUse attachments (a call whose matching `tool_result`
      // never made it into the log before eviction) must not linger forever under a dead id.
      clearSession(sessionId);
      if (session === undefined) return;
      try { await session.end(); } catch (err) { log(`evicting ${sessionId}: end failed (${err instanceof Error ? err.name : "unknown"})`); }
    },
    list: () => [...drivers.values()],
    async endAll() {
      await Promise.all([...drivers.entries()].map(([sessionId, s]) => s.end().catch(() => {}).finally(() => clearSession(sessionId))));
    },
  };
}
