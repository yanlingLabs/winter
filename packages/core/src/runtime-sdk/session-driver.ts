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
import { statSync } from "node:fs";
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
import { moveTranscriptFiles, transcriptEntriesOf, type TranscriptMoveResult } from "../runtime-state/transcript-rekey";
import { recordLazyRekey } from "../migration/migrate-c";
import type { SessionHub } from "../sessions/hub";
import type { SessionStore } from "../sessions/store";
import { CLAUDE_FIRST_PARTY_PROVIDER_IDS, DEFAULT_PROVIDER, effortRefusalFor, effortToSpendForRole, ownProviderFor, pinsFor, providerBaseUrlFor, sdkAllowRules, sdkDenyRules, winterOptionsFromSettings, type Settings } from "../settings";
import { d30DefaultModel } from "./advisor-reviewer";
import { canUseToolFor, type BridgedApprovalRequest } from "./approval-bridge";
import type { WinterRuntimeSdk, SessionMode } from "./create";
import { clearSession } from "./diff-attach";
import { credentialPresenceFrom, credentialRefFor, refMaterialPresent } from "./keychain";
import { SHIPPED_DANGEROUS_DOMAINS } from "../agent/dangerous-domains";
import { apiKeyProviderIsUnauthenticated, exaKeyPresent, missingCredentialDetail } from "./credentials";
import { renderNoCredentialHint } from "./handoff";
import { neutralSelectionRefusal, refusalDetailCategoryFor } from "./refusal-copy";
import { legForNewSession, sessionLegOf, type SessionLeg } from "./leg";
import { attachWinterSession } from "./messaging";
import { buildWinterOptions, bypassAllowedAtSpawn, permissionModeFor } from "./mode-options";
import { providerFor, rowForTag, testProviderNameFor } from "./provider-selection";
import { splitTag, UNSTATED_TAG, isModelTag, WINTER_TEST_PREFIX, type ModelTag } from "./model-tag";
import { winterSessions } from "./sessions";
import { canonicalCwd, storeProjectsDir } from "../agent/paths";
import { linkedRouterSupportsRunHome } from "./run-home-support";
import { isRetiredCatalogTag } from "../providers/catalog-role-problems";
import { WINTER_PEER_VERSIONS } from "./versions";
import { winterSystemPromptFor } from "./system-prompt";
import { dispatchEffortFor } from "../agent/dispatch-config";
import { loadUserAgentDefinitions, loadProjectAgentDefinitions, mergeAgentDefinitionTiers, type LoadedAgentDefinitions } from "../agent/agent-definitions";

/**
 * Daemon settings surface batch 3: the ONE merge the incarnation builder calls — `<home>/agents/*.md`
 * (user tier) merged with a TRUSTED project's `<cwd>/.winter/agents/*.md` (project tier, trust-gated
 * by `projectAgentDefinitions` itself — absent/untrusted degrades to the empty scan shape), project
 * winning by name (the SDK's own precedence, batch 3 item 1). A fresh scan on every call, same as
 * `loadUserAgentDefinitions` itself — no caching here either, so a new/edited/removed file reaches
 * the very next incarnation with no daemon restart.
 */
function mergedAgentDefinitions(
  home: string,
  cwd: string,
  projectAgentDefinitions: ((cwd: string) => LoadedAgentDefinitions) | undefined,
): Record<string, import("@yanlinglabs/winter-agent-sdk").AgentDefinition> {
  const project = projectAgentDefinitions?.(cwd) ?? { definitions: {}, sources: [], rejected: [] };
  return mergeAgentDefinitionTiers(loadUserAgentDefinitions(home), project).optionsMap;
}
import type { AgentRegistry } from "../agent/bg-agent-registry";
import type { ContextAssembler } from "../agent/context";
import type { SkillStore } from "../agent/skills";
import { startWinterSession, unconsumedUserMessages, withRunHome, type WinterChildrenSink, type WinterIncarnation, type WinterIncarnationShape, type WinterSession } from "./winter-session";
import { RunHomeError, type RunHome, type RunHomeErrorCode, type RunHomeFor, type RunHomeInput } from "@yanlinglabs/winter-runtime-sdk";
import { projectScopeTrusted, type RunHomeSessionFacts } from "./run-home-input";
import { readWinterTasks } from "./tasks-reader";

export type WinterLegRefusalCode =
  | "winter_executable_unavailable"   // P8b-2: no `winter` binary resolves (setting → env → bundle → home)
  | "embedded_runtime_unavailable"    // WS-23: chat/dispatch's embedded runtime refused (version lock, no host)
  | "winter_leg_unavailable"          // the router handle or the runtime spine did not construct
  | "session_predates_winter_leg"     // P8b-22: the record has no Winter transcript to resume
  // `session_unrecorded` (fix wave F2) is minted by `ipc/server.ts` directly — a session with NO
  // record at all (phone-owned, `createSynced`) never reaches the table's own refusals.
  | "winter_session_ended"            // the driver said the store refused it for good
  | "not_supported_on_winter_leg"     // `session.compact` (SDK 0.0.4 carry)
  | "runtime_selection_refused"       // P8c-14: the router's selectRuntime refused this session's model
  // WS-23 (ruling R2): a session recorded on the retired official leg (`runtimeKind: "claude-agent"`)
  // could not be moved onto the Winter leg at its resume. `data.reason` says why: `transcript-collision`
  // (the Winter key already holds a copy), `transcript-move-refused` (a link, mkdir or rename the
  // filesystem refused), `repair-required` (already marked) or `claude-oauth`. Nothing is moved or
  // opened, and the record keeps naming the old leg, until `winter doctor --repair
  // adopt-legacy-session` (finding `legacy-adoption-blocked`) clears it for the next resume.
  | "legacy_session_migration_refused"
  // The session's own working directory is gone (deleted, moved, unmounted) or is not a directory:
  // refused before any child spawns, naming the path — never the child's generic death at spawn, and
  // never a silent fallback to another directory (`sessionCwdRefusal`).
  | "session_cwd_unavailable"
  // WS-21: a run-home router's refusal (`RunHomeError.code`), forwarded verbatim as `data.code`.
  | RunHomeErrorCode;

/**
 * THE SESSION'S WORKING DIRECTORY MUST EXIST before a runtime is started in it. A `winter` child spawned
 * with a `cwd` that is gone dies before its first frame, and all the user saw was the generic
 * `agent_error` "the runtime process exited unexpectedly: runtime exited before init"
 * (`process_death`) — nothing said the directory was the problem. An embedded (chat/dispatch) session
 * with a cwd runs its tools there too, so it is held to the same rule.
 *
 * A REFUSAL, deliberately, never a fallback: running the session somewhere else (its temp dir, `$HOME`)
 * would put the model's shell and file edits in a directory the user never chose. The message names the
 * path and the two ways out; `data.code` is `session_cwd_unavailable` for a client to branch on.
 *
 * `statSync` follows symlinks, so a dangling link reads as missing (ENOENT), and a link to a directory
 * passes. Only the cwd the SESSION stored is checked — a cwd-less session runs in its daemon-owned temp
 * dir, which is Winter's own to create.
 */
export function sessionCwdRefusal(cwd: string): WinterLegRefusal | undefined {
  let isDirectory: boolean;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    const what = code === "ENOENT" || code === "ENOTDIR" ? "no longer exists" : `can't be opened (${typeof code === "string" ? code : "unreadable"})`;
    return new WinterLegRefusal("session_cwd_unavailable", `this session's working directory ${cwd} ${what} — restore it, or start a new session`);
  }
  if (!isDirectory) {
    return new WinterLegRefusal("session_cwd_unavailable", `this session's working directory ${cwd} is not a directory — restore it, or start a new session`);
  }
  return undefined;
}

/**
 * P8c-14: the public members of a live session driver the IPC layer and this table's own
 * `evict`/`list`/`endAll`/`runTurn` need. It was the intersection of the two legs' drivers; since
 * WS-23 `WinterSession` is the only implementation, and the interface stays as the narrow surface the
 * rest of the daemon is written against (`query` and friends remain `winter-session.ts`'s own).
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
  /** `daemon.ts`'s `list_sessions` activity surface reads it. */
  readonly turnStartedAt: number | undefined;
  readonly done: Promise<void>;
  readonly pendingSends: readonly string[];
  readonly heldDeliveries: readonly string[];
  send(text: string, clientName?: string): Promise<{ seq: number; queued: boolean }>;
  steer(text: string, clientName?: string): Promise<{ seq: number; injected: boolean }>;
  interrupt(): Promise<{ wasRunning: boolean }>;
  /** WS-23 (reasoning-state): compact the live child now, on its own model -- see `WinterSession.compact`. */
  compact(opts?: { customInstructions?: string }): Promise<{ retainedCount: number }>;
  /** WS-23 review r1 I-5: hold what arrives for the TARGET while a provider switch replaces this
   *  child -- see `WinterSession.beginHandoff`. Optional so a test double need not implement it. */
  beginHandoff?(work: () => Promise<void>): Promise<{ heldTurns: number }>;
  readonly handoffPending?: boolean;
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

/**
 * WS-21: the user tier's rules, read live from `sdk/settings.json` at every incarnation (claude grammar,
 * verbatim — see `WinterOptionsInput.userAllow`). `userAllow` is omitted when the key is absent, so an
 * untouched home's `Options` are byte-identical to before.
 */
function userRulesFrom(home: string, runHomeApplied: boolean): { userAllow?: readonly string[]; userDeny: readonly string[] } {
  // WS-21 (L3.4): on a run-home incarnation the user's allow rules ride the run folder's settings; the
  // deny rules stay stated here too (a redundant deny is harmless; the floor is never thinned).
  const allow = runHomeApplied ? undefined : sdkAllowRules(home);
  return { ...(allow === undefined ? {} : { userAllow: allow }), userDeny: sdkDenyRules(home) };
}

/** The narrowed `SessionMode` a stored `mode` column resolves to (absent = code, as everywhere). */
const modeOf = (raw: string | undefined): SessionMode => (raw === "chat" || raw === "dispatch" ? raw : "code");

/** Winter's effort strings that are also the SDK's `EffortLevel`. `none` is the wire's "unset" and
 *  `ultra` is Winter-only (a client-side selector the engine translates); neither crosses here. */
const SDK_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);
const sdkEffortOf = (raw: string | undefined): EffortLevel | undefined => (raw !== undefined && SDK_EFFORTS.has(raw) ? (raw as EffortLevel) : undefined);

/**
 * The effort a session SPENDS on its requests — ONE expression.
 *
 * It exists as a function because it once had two callers (the retired official leg took effort
 * through a different door and, until 2026-09-18, silently never sent it). The rule:
 *  - the session's OWN effort first, verbatim (explicit — the child refuses it typed when unsupported);
 *  - else dispatch's role effort on a dispatch session, else the daemon default
 *    (`provider.reasoningEffort`), each IMPLICIT and therefore mapped onto `model`'s own vocabulary;
 *  - `sdkEffortOf` last, which drops `"none"` and Winter's `ultra` tier — neither is an SDK
 *    `EffortLevel`, and "no effort sent" is what both already mean on the Winter leg.
 */
function spendEffortFor(settings: Settings | null | undefined, mode: SessionMode, model: string, liveEffort: string | undefined): EffortLevel | undefined {
  // A STALE session effort is not an explicit choice for THIS model: it was picked for the model the
  // session was on before a switch (or arrived through a door that never checked — a phone-synced
  // session, a row older than the store's own clearing). Sending it verbatim ended the next turn
  // ("model … declares no effort vocabulary, so no effort level can be verified for it"), so a level
  // the one selection rule refuses for this model is treated as unset and the implicit default takes
  // over. `session.setEffort` still refuses the same level up front, so a fresh choice is never
  // silently dropped — only one that a model change left behind.
  const own = liveEffort !== undefined && effortRefusalFor(liveEffort, model, mode) === undefined ? liveEffort : undefined;
  if (liveEffort !== undefined && own === undefined) noteStaleEffortOnce(model, liveEffort);
  return sdkEffortOf(own ?? (mode === "dispatch" ? dispatchEffortFor(settings, model) : effortToSpendForRole(settings, "provider.model", model, undefined)));
}

const staleEffortNoted = new Set<string>();
/** One line per (model, level) per process — a resumed session re-assembles its options every turn. */
function noteStaleEffortOnce(model: string, effort: string): void {
  const key = `${model}\u0000${effort}`;
  if (staleEffortNoted.has(key)) return;
  if (staleEffortNoted.size > 256) staleEffortNoted.clear();
  staleEffortNoted.add(key);
  console.error(`session effort '${effort}' is not selectable on '${model}' — spending the default effort instead`);
}

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
   *  Absent (a harness without one) ⇒ no `systemPrompt` and the child runs Winter's own.
   *  (`"memoryDirFor"` stays in the pick for the daemon's own wiring, which hands the same instance
   *  elsewhere; this file calls only `assemble`.) */
  assembler?: Pick<ContextAssembler, "assemble" | "memoryDirFor">;
  /**
   * Lane B (2026-09-22): the user's SAVED allow rules for a session at `cwd` — Winter's raw rule
   * strings, trust-gated (`mode-options.ts`'s `persistedAllowRulesFor`, wired by `daemon.ts` over the
   * live settings, the project-settings resolver, the rules store and the trust store). Read at EVERY
   * incarnation on BOTH legs, so a rule saved from a card reaches the next child with no restart.
   * Absent (a harness without one) ⇒ no saved rules in `Options`, exactly as before.
   */
  persistedAllowRules?: (cwd: string) => readonly string[];
  /** Task 17 (P8b-15): the persisted child roster (`createPersistedChildren` over 8a's
   *  `runtime_children`). A Winter child is registered under the spawning `tool_use.id` with NO
   *  local abort (its process is the session's), fed `progress()` on every frame of its thread, and
   *  completed from the spawning call's `tool_result`. */
  children?: AgentRegistry;
  /** The activity enforcement's post-turn re-check (`enforcement.onTurnSettled(sessionId)`). */
  onTurnSettled?: (sessionId: string) => void;
  /**
   * Daemon settings surface (2026-09-17 plan, item 3): fired best-effort, fire-and-forget, once per
   * incarnation, with whatever `Query.supportedAgents()` answers for THIS session's live child
   * (`winter-session.ts`'s `open()`, right after the query is created). This is the ONLY place a
   * built-in-agent-type list can come from, and it must NOT be read off
   * `system/init.agents` in the projector, which serves a different purpose (the projector's job is
   * turning wire frames into `SessionEvent`s, not caching a daemon-wide fact). Absent from a test
   * double that doesn't care; never awaited or retried by this file — a rejection (a torn/aborted
   * child before the call resolves) is swallowed at the call site, never surfaced here.
   */
  onSupportedAgents?: (sessionId: string, agents: import("@yanlinglabs/winter-agent-sdk").AgentInfo[]) => void;
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
  /**
   * Daemon settings surface batch 3 (item 1): a TRUSTED project's `<cwd>/.winter/agents/*.md`
   * (`agent/agent-definitions.ts`'s `loadProjectAgentDefinitions`) — trust-gated by the CALLER
   * (daemon.ts wires this exactly like `extraMcpServers` above: a closure over the daemon's own
   * `TrustStore`, returning the empty scan shape outright for an untrusted `cwd`). Absent from a
   * test double that doesn't care, in which case only the user tier (`<home>/agents`) is ever
   * consulted — byte-identical to a pre-item-1 session.
   */
  projectAgentDefinitions?: (cwd: string) => LoadedAgentDefinitions;
  /**
   * 2026-09-18 (agent SDK 0.0.17): the USER-ADDED half of the dangerous-domain floor for a project,
   * `settings.permissions.dangerousDomains.added` through the PROJECT-settings overlay — the same
   * `dangerousDomainsAdded` closure `daemon.ts` already hands the `Search` and `browser`
   * tools, wired here verbatim so the floor a Winter CHILD honours through
   * `Options.web.blockedDomains` is the identical list the daemon's own tools honour.
   *
   * Absent (every test double that does not care) ⇒ the shipped list alone, which is the same
   * degradation the tools' own absent getter already has.
   */
  dangerousDomainsAdded?: (cwd?: string) => string[] | undefined;
  log?: (line: string) => void;
  /**
   * P8c-14 (integration round 2): lane 2's `planBridgeFor(...)` module — this file never imports
   * it, only threads a value of this shape through to both legs' `CanUseToolDeps.planBridge`
   * (`approval-bridge.ts`, consulted BEFORE the generic gate/never-prompt logic when
   * `toolName === "ExitPlanMode"`). Now typed EXACTLY as `CanUseToolDeps.planBridge` (widened from
   * the original `unknown`-shaped placeholder once a real consumer existed) — passed straight into
   * `canUseToolFor` below.
   */
  planBridge?: { onExitPlanMode(req: BridgedApprovalRequest): Promise<PermissionResult> };
  /**
   * P8c-14 (integration round 2): lane 3's `sessionHooksFor(...)` module — this file never imports
   * it, only threads its result through: `.winter` goes into every incarnation's
   * `buildWinterOptions({..., hooks})` call (TYPED as `Options["hooks"]`, the exact type
   * `mode-options.ts`'s `WinterOptionsInput.hooks` needs). WS-23: the `.official` half is gone with
   * the leg it fed.
   */
  hooksFor?: (session: CapabilitySession) => { winter?: Options["hooks"] };
  /** Test seams. */
  idleTimeoutMs?: () => number;
  endGraceMs?: number;
  /**
   * WS-21 (spec §3.1): present ONLY when the linked router applies run homes (`daemon.ts` wires it
   * from `linkedRunHomeBuilder()`; a test injects a stub). Then EVERY incarnation — create, resume,
   * eviction, a policy switch across the bypass boundary, a model switch — awaits
   * `build(inputFor(facts))` in `optionsFor` (built LAST, after every refusal) and hands the result to
   * the router as `runtime.runHome`. Absent (router 0.0.11): no run home, and every child is launched
   * exactly as before.
   */
  runHome?: {
    build: (input: RunHomeInput) => Promise<RunHome>;
    inputFor: (facts: RunHomeSessionFacts) => RunHomeInput;
  };
  /**
   * WS-21 (spec §4.3): the daemon's `TrustStore.isTrusted`. An approval card offers "Allow … in this
   * project" only for a trusted project (the answer is saved to its `.winter/settings.local.json`, a tier
   * the runtimes read for a trusted project alone). Absent (a test double): offered as before.
   */
  isTrusted?: (dir: string) => boolean;
}

export interface WinterSessionDrivers {
  /** P8b-13: the leg a NEW session of this mode is created on, from the live settings. */
  legForNewSession(mode: SessionMode): SessionLeg;
  /** The leg an EXISTING session runs on, from its record; undefined when it has no record. */
  legOf(sessionId: string): SessionLeg | undefined;
  /** Whole-branch review (minor d): the provider a LIVE child's cross-provider advisor pin names —
   *  running there, or fallen back because that provider's slot was empty — so a credential write for
   *  it replaces the child too. Undefined without a live driver or a cross-provider pin. Optional so a
   *  test double need not implement it. */
  advisorProviderOf?(sessionId: string): string | undefined;
  /** Refuse (typed) unless a Winter-leg session of this mode could be created right now. Runs
   *  BEFORE the product row is minted, so a refusal costs nothing. */
  assertAvailable(mode: SessionMode): void;
  /** The creation transaction, for a session row that already exists: ask the router for the
   *  selection (`runtime.selectRuntimeFor`), persist the record (fresh backend uuid), start the driver,
   *  register it. Throws `WinterLegRefusal`. */
  create(sessionId: string): Promise<LegSession>;
  /** The live driver, if any. */
  get(sessionId: string): LegSession | undefined;
  /** One HEADLESS turn (routines, the -p path): the session's driver (created for a session that
   *  has no record yet, resumed otherwise), `send`, then wait until nothing is in flight. */
  runTurn(sessionId: string, text: string, clientName: string): Promise<void>;
  /** A live driver, or a resumed one when the record says "winter" — or "official", which is adopted
   *  onto the Winter leg first (`adoptLegacyRecord`); undefined ⇒ no transcript to resume (an
   *  engine-era or record-less session — the IPC layer refuses typed). */
  ensure(sessionId: string): Promise<LegSession | undefined>;
  /**
   * WS-23 (ruling R2): move a record the retired official leg wrote (`runtimeKind: "claude-agent"`)
   * onto the Winter leg, WITHOUT opening anything — the transcript re-keyed to the Winter cwd key, then
   * `runtimeKind`/`selection` rewritten. The same step `resume()` runs first; `session.setModel` calls it
   * too, so a model change on a not-yet-resumed legacy session lands on a Winter record rather than
   * being refused for disagreeing with one. Returns the (possibly re-read) record; a record that is not
   * a legacy one comes back untouched. Throws a typed `WinterLegRefusal`
   * (`legacy_session_migration_refused`) and moves nothing on a collision or a `repair-required`
   * transcript. SYNCHRONOUS — sqlite and same-volume renames only — so `ensure()`'s no-await window
   * holds. Optional so a test double need not implement it.
   */
  adoptLegacyRecord?(sessionId: string): RuntimeSessionRecord | undefined;
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
      // and `mode-options.ts` grants it exactly when `bypassAllowedAtSpawn` says so — so the two ARE one
      // predicate. (The SDK consults it for `plan` alone; `bypassPermissions` classifies
      // `bypasses` unconditionally, everything else `prompts`.)
      return classifyPermissionMode(permissionModeFor(policy), { bypassAvailable: bypassAllowedAtSpawn(policy) });
    } catch {
      return "unknown";
    }
  };
}

/** R.3 I-1: the approval bridge's `projectTrusted` for a session cwd — the SAME trust the run home's
 *  project tier uses (`projectScopeTrusted`: the cwd's own trust, or its repository's — a linked worktree of
 *  a trusted repo is trusted), read live per call. It gates both the card's "in this project" option and the
 *  bridge's protected-path walk; `approval.respond` saves the answer under the same trust, into the local
 *  tier at `localScopeKeyFor(cwd)` (a linked worktree's own top). */
export function bridgeProjectTrustedFor(isTrusted: (dir: string) => boolean, cwd: string): () => boolean {
  return () => projectScopeTrusted(cwd, { isTrusted });
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

/**
 * WS-21 round 3 (Important): THE LAZY CANONICAL-CWD RE-KEY, before a session's child opens — at every
 * `resume()` and (round 4, minor 3) the router's own cold resume. A session whose record still names another
 * key than the one `cwd` (canonicalized here) keys it under — a 0.116 session in a symlinked cwd, a symlink
 * made later, anything Migration C's bulk step never saw — has its files moved there (`moveTranscriptFiles`:
 * never overwriting, the transcript last) and its record re-pointed; on a migrated home the move joins
 * Migration C's manifest, intent first (round 4, minor 1), so a rollback reverses it. A collision (both keys
 * hold the session) or a refusal moves NOTHING: the session is marked `repair-required` and logged, and the
 * child opens on whatever the canonical key holds. SYNCHRONOUS (the n7 invariant). Returns the record to
 * open with — re-read when it changed.
 */
export function rekeyTranscriptToCwd(
  deps: { home: string; records: RuntimeSessionRecords; log: (line: string) => void },
  sessionId: string, record: RuntimeSessionRecord, cwd: string,
  /** WS-23 (fix round 1): told what the move did, so a caller can tell a collision from a refusal. */
  onMove?: (result: TranscriptMoveResult) => void,
): RuntimeSessionRecord {
  const { records, log } = deps;
  const backendId = record.backendSessionId;
  if (backendId === undefined) return record;
  let toKey: string;
  try { toKey = transcriptProjectKey(canonicalCwd(cwd)); } catch { return record; }
  if (toKey === record.transcriptProjectKey) return record;
  const projects = storeProjectsDir(deps.home);
  const fromKey = record.transcriptProjectKey;
  const intent = { sessionId, backendId, from: fromKey, to: toKey, entries: transcriptEntriesOf(join(projects, fromKey), backendId) };
  recordLazyRekey(deps.home, { ...intent, outcome: "pending" });
  const moved = moveTranscriptFiles(projects, backendId, fromKey, toKey);
  onMove?.(moved);
  recordLazyRekey(deps.home, moved.kind === "moved" || moved.kind === "not-needed"
    ? { ...intent, ...(moved.kind === "moved" ? { entries: moved.entries } : {}), outcome: "moved" }
    : { ...intent, outcome: moved.kind, ...(moved.kind === "refused" ? { reason: moved.reason } : {}) });
  if (moved.kind === "not-needed") return record;
  if (moved.kind === "moved") {
    try {
      records.rekeyTranscript(sessionId, fromKey, toKey, join(projects, toKey));
    } catch (err) {
      log(`transcript re-key for ${sessionId}: the files moved but the record could not be re-pointed (${err instanceof Error ? err.name : "unknown"})`);
      return record;
    }
    log(`transcript re-keyed for ${sessionId} to the canonical cwd's key (${moved.entries.length} entr${moved.entries.length === 1 ? "y" : "ies"} moved)`);
    try { return records.get(sessionId) ?? record; } catch { return record; }
  }
  try { records.setTranscriptHealth(sessionId, "repair-required"); } catch { /* bounded */ }
  log(moved.kind === "collision"
    ? `transcript re-key collision for ${sessionId}: both the recorded key and the canonical cwd's key hold its transcript — nothing moved, marked repair-required`
    : `transcript re-key for ${sessionId} refused (${moved.reason}) — nothing moved, marked repair-required`);
  return record;
}

/**
 * Round 4, minor 3: the `runHomeFor` a run-home router calls for ITS OWN cold resume (a message delivered to
 * an exited Winter session) — the one incarnation that never passes through `resume()`. The cwd is
 * canonicalized, like every other run-home input (L2 O-1), and the same lazy re-key runs first, so that path
 * finds the history too. (The router's run home check compares this cwd with the one it resumes on: that one
 * is the directory row's, written from an incarnation's own `Options.cwd`, canonical since L2 O-1 — for a
 * row still spelled otherwise, the router refuses the cold resume typed, `run_home_cwd_mismatch`, and the
 * session resumes through its driver instead.)
 */
export function coldResumeRunHomeFor(deps: {
  home: string;
  store: Pick<SessionStore, "meta" | "dirs">;
  records: RuntimeSessionRecords | undefined;
  runHome: NonNullable<WinterLegDeps["runHome"]>;
  log: (line: string) => void;
}): RunHomeFor {
  return async (ctx) => {
    const cwd = canonicalCwd(ctx.cwd);
    let origin: string | undefined;
    let workdirLess = false;
    try {
      const meta = deps.store.meta(ctx.sessionId);
      origin = meta.origin;
      workdirLess = (meta.cwd ?? deps.store.dirs(ctx.sessionId)[0]?.path) === undefined;
    } catch { /* an unknown session: the router refuses it on its own */ }
    try {
      const record = deps.records?.get(ctx.sessionId);
      if (record !== undefined && deps.records !== undefined) rekeyTranscriptToCwd({ home: deps.home, records: deps.records, log: deps.log }, ctx.sessionId, record, cwd);
    } catch { /* a records store that will not answer: the child opens on whatever the canonical key holds */ }
    return deps.runHome.build(deps.runHome.inputFor({ mode: ctx.mode, dispatchChild: origin === "dispatch-child", leg: ctx.leg, cwd, workdirLess }));
  };
}

export function createWinterSessionDrivers(deps: WinterLegDeps): WinterSessionDrivers {
  const drivers = new Map<string, LegSession>();
  /** Per live Winter-leg child: the provider its `runtimes.advisorModel` pin names when that is ANOTHER
   *  provider (set at every incarnation's options build) — `advisorProviderOf`, read by
   *  `evictSessionsForCredential`. */
  const advisorProviders = new Map<string, string>();
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
    // R.1: on a run-home build every record and store path is under `sdk/` (`storeProjectsDir`), and only
    // a run home points a child there — a driver table built WITHOUT run-home deps would launch children on
    // `<home>` while recording `sdk/` transcript paths the child never writes. Refused, typed, before any
    // record is written (production always wires both: `daemon.ts`'s `runHomeDeps`).
    if (deps.runHome === undefined && linkedRouterSupportsRunHome()) {
      throw new WinterLegRefusal("run_home_required", "this build applies per-run homes, but the session driver was constructed without run-home dependencies — no child can be launched on the layout its records name");
    }
  };

  const assertAvailable = (mode: SessionMode): void => {
    assertSpine();
    const hook = deps.runtime!.spawnHookFor(mode);
    // WS-23: the refusal carries its own code — a binary that does not resolve (code) or an embedded
    // runtime that refused (chat, dispatch). Forwarded as-is, never re-described as the other.
    if (hook instanceof Error) throw new WinterLegRefusal(hook.code, hook.message);
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
  // WS-21 (L2 O-1): the CANONICAL path — the Winter child keys its transcript by realpath(cwd), the router
  // by the cwd it is given; every Options.cwd, run-home input and recorded transcript key derives from this.
  const winterCwdOf = (sessionId: string, cwd: string | null | undefined): string => canonicalCwd(cwd ?? deps.tmpDirOf(sessionId));

  /**
   * Round 3/4: the lazy canonical-cwd re-key (`rekeyTranscriptToCwd`), keyed by the cwd the Winter child
   * runs in (`winterCwdOf`). WS-23: the retired official leg keyed a cwd-less session by its first working
   * directory instead (`dirs[0]`), so adopting one of its records moves the transcript here too.
   */
  const rekeyForCanonicalCwd = (sessionId: string, record: RuntimeSessionRecord, onMove?: (result: TranscriptMoveResult) => void): RuntimeSessionRecord => {
    if (deps.records === undefined) return record;
    let cwd: string;
    try { cwd = winterCwdOf(sessionId, deps.store.meta(sessionId).cwd); } catch { return record; }
    return rekeyTranscriptToCwd({ home: deps.home, records: deps.records, log }, sessionId, record, cwd, onMove);
  };

  /**
   * WS-23 (ruling R2) — THE LAZY ADOPTION of a record the retired official leg wrote. See
   * `WinterSessionDrivers.adoptLegacyRecord` for the contract; the WHY of each step:
   *
   *  - Nothing new is needed to READ the history. The Winter runtime resumes transcripts the `claude`
   *    binary wrote (it reads claude's entry shapes), and a resume needs only the transcript file and a
   *    lease, never a Winter producer record — the same file the retired handoff barrier reused
   *    unchanged when it moved a session between the two legs.
   *  - `repair-required` refuses BEFORE anything moves: that flag means the canonical transcript is
   *    not proven (a quarantined working copy, an earlier collision), and opening a Winter child on it
   *    would append to a history nobody has reconciled.
   *  - The re-key runs next, and a collision (both keys hold the session) or a refused move leaves the
   *    record marked `repair-required` by `rekeyTranscriptToCwd` — refused here too, with the record
   *    still naming `claude-agent`, so every later resume refuses the same way rather than opening on
   *    whichever copy the Winter key happens to hold.
   *  - Only then are `runtimeKind`/`selection` rewritten — the same two fields (plus the credential
   *    locator) the retired handoff's `confirmInit` patched when a session moved legs. Provider, model,
   *    family and auth family are the session's own and carry over verbatim: a `console/*` record stays
   *    a Console session, and whether its credential can serve a turn is `beforeTurn`'s typed question,
   *    exactly as for any Winter session.
   *  - A `claude-oauth` selection is refused: that credential family never routed to the Winter runtime
   *    (D28), and claude.ai subscription auth never shipped, so no such record should exist — but if one
   *    does, a typed refusal is the only honest answer.
   *
   * SYNCHRONOUS — sqlite and same-volume renames — so `ensure()`'s no-await window (see `resume()`) holds.
   */
  const adoptLegacyRecord = (sessionId: string): RuntimeSessionRecord | undefined => {
    const record = recordOf(sessionId);
    const records = deps.records;
    if (record === undefined || records === undefined || record.runtimeKind !== "claude-agent" || record.backendSessionId === undefined) return record;
    const refuse = (reason: string, why: string): never => {
      log(`legacy session ${sessionId} not adopted onto the Winter leg (${reason})`);
      throw new WinterLegRefusal(
        "legacy_session_migration_refused",
        `session ${sessionId} was created on the retired official Claude runtime and cannot move to Winter's runtime: ${why}`,
        reason,
      );
    };
    if (record.selection.authFamily === "claude-oauth") {
      refuse("claude-oauth", "it was authorised with a Claude subscription login, which Winter's runtime does not use — start a new session");
    }
    // The one remedy for all three: `winter doctor` names the session (`legacy-adoption-blocked`) and
    // `--repair adopt-legacy-session` clears it; the next resume then adopts it.
    const remedy = `quit Winter, then run \`winter doctor\` and \`winter doctor --repair adopt-legacy-session --session ${sessionId}\``;
    if (record.transcriptHealth === "repair-required") {
      refuse("repair-required", `its transcript is marked repair-required, so its history is not proven — ${remedy}`);
    }
    let move: TranscriptMoveResult | undefined;
    rekeyForCanonicalCwd(sessionId, record, (result) => { move = result; });
    const moved = recordOf(sessionId);
    if (moved === undefined) return undefined;
    if (moved.transcriptHealth === "repair-required") {
      // Fix round 1 (minor 2): a COLLISION (the Winter key already holds a copy) and a REFUSED move (a
      // link in the way, a directory or rename the filesystem refused) are different problems.
      const refusedMove = (move as TranscriptMoveResult | undefined)?.kind === "refused";
      if (refusedMove) {
        refuse("transcript-move-refused", `its transcript could not be moved to the key Winter reads it from (${(move as Extract<TranscriptMoveResult, { kind: "refused" }>).reason}) — fix that, then ${remedy}`);
      }
      refuse("transcript-collision", `the key Winter reads its transcript from already holds another copy of it — compare the two, then ${remedy} with \`--keep recorded\` or \`--keep canonical\` (the other copy is moved to quarantine, never deleted)`);
    }
    const authRef = credentialRefFor(moved.selection.providerId, deps.home);
    try {
      records.patch(sessionId, moved.state, {
        runtimeKind: "winter-agent",
        selection: {
          ...moved.selection,
          runtimeKind: "winter-agent",
          sdkVersion,
          engineVersion: sdkVersion,
          reason: "adopted onto the Winter runtime at its next resume: the official claude runtime this session was created on is retired (WS-23)",
          decidedAt: new Date().toISOString(),
        },
        authRef: authRef?.kind === "keychain" ? `keychain:${authRef.account}` : undefined,
        // Fix round 1 (minor 7): the record-level versions too, not only the selection's.
        sdkVersion,
        engineVersion: sdkVersion,
      });
    } catch (err) {
      throw new WinterLegRefusal("winter_leg_unavailable", `the runtime record for ${sessionId} could not be moved to the Winter leg (${err instanceof Error ? err.name : "unknown"})`);
    }
    log(`legacy session ${sessionId} adopted onto the Winter leg (${moved.selection.providerId}, transcript kept)`);
    return recordOf(sessionId);
  };

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
      // WS-21: "in this project" is offered only for a trusted project (live — trusting it reaches the next card).
      ...(deps.isTrusted === undefined ? {} : { projectTrusted: bridgeProjectTrustedFor(deps.isTrusted, cwd) }),
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
      // the first user/assistant pair sees a complete turn). ON AN ERROR TERMINAL TOO (2026-09-19):
      // a chat whose FIRST turn fails — a usage limit, a refused model — used to stay untitled for
      // good when the user never sent a second message, a permanent "New chat" row. The titler runs
      // on the daemon's own internal provider, not the session's, and already titles from the user's
      // message alone when there is no reply; it is at-most-once and never throws, so a failed
      // attempt costs one logged line and the next completed turn simply tries again.
      if (deps.titler !== undefined && event.type === "turn_completed") {
        const threadId = (event as { threadId?: string }).threadId;
        if (threadId === undefined || threadId === "main") {
          try { void deps.titler.maybeTitle(sessionId); } catch { /* maybeTitle never throws by contract; belt only */ }
        }
      }
      return stamped;
    };

    const optionsFor = async (inc: WinterIncarnationShape) => {
      // FIRST, before the spawn hook, the credential probes or the run home: a session whose own
      // working directory is gone refuses typed here rather than dying at spawn (`sessionCwdRefusal`).
      // Every incarnation passes this — create, resume, and a send that re-opens a resumable session —
      // and `open()` builds its options before it bumps a generation or appends anything, so a refusal
      // leaves no orphan row and no orphan `user_message`. `cwd` is the path the child is spawned in.
      if (meta.cwd != null) {
        const cwdRefusal = sessionCwdRefusal(cwd);
        if (cwdRefusal !== undefined) throw cwdRefusal;
      }
      const live = deps.store.meta(sessionId);
      // WS-21 (spec §3.1, §6.1): the ONE place that knows whether this incarnation runs on a run home —
      // the builders below stop building what the run folder carries when it does.
      const runHomeApplied = deps.runHome !== undefined;
      const settings = deps.settings();
      const hook = runtime.spawnHookFor(mode);
      if (hook instanceof Error) throw new WinterLegRefusal(hook.code, hook.message);
      // Both credential probes, together: the provider inventory (`CredentialPresence`) and the ONE
      // tool key whose presence changes the tool SURFACE (0.0.17 — see `WinterOptionsInput`'s
      // `exaKeyPresent`). Independent Keychain reads, so they are issued in parallel, and re-issued at
      // EVERY incarnation: adding or removing the Exa key must reach a session's next turn with no
      // daemon restart, which is what `credentials.ts`'s eviction closes for the live child.
      const [credentials, exaPresent] = await Promise.all([
        credentialPresenceFrom(deps.secrets),
        exaKeyPresent(deps.secrets),
      ]);
      // `resolveSel`, the retired engine's resolution, carried here: dispatch runs its PIN — the live
      // `pinsFor(settings).dispatch` at `dispatchEffortFor` (the `pins.dispatch` role's stored effort,
      // else `DISPATCH_EFFORT`); `session.setModel`/`setEffort` refuse a dispatch target, so a stored
      // override can only come from a harness that wrote the store directly — a test's door to
      // the `winter-test/*` doubles); every other mode is the per-session override, else the
      // daemon's configured provider model, else (no settings loaded at all — no agent provider
      // configured) `DEFAULT_PROVIDER.model`, the same ultimate fallback `pinsFor` itself falls
      // back through for a null `settings`. `buildWinterOptions` below requires a real `ModelTag`,
      // never `undefined` — there is always a real spawn boundary to cross even on a freshly
      // installed, unconfigured daemon.
      //
      // `live.model` (`SessionStore`'s raw `model` column) is deliberately UNBRANDED at the store
      // layer — `session.list` reports it verbatim, legacy/pre-pin rows may still hold one, and the
      // column itself is never re-validated on read (see `session.setModel`'s own doc comment on
      // why a stored override must stay clearable even after the shape rule tightened). The `as
      // ModelTag` below trusts the WRITE-time invariant instead: every door that can set this
      // column (`session.setModel`, `session.create`, `sync.push`) validates through
      // `ModelTagSchema`/`resolveModelSelection` before the write, so a value that reaches here
      // already satisfies the shape this cast asserts.
      const model = mode === "dispatch" ? (live.model as ModelTag | undefined ?? pinsFor(settings).dispatch) : (live.model as ModelTag | undefined ?? settings?.provider?.model ?? DEFAULT_PROVIDER.model);
      // 2026-09-17: the dispatch pin's fixed tier is IMPLICIT — mapped onto the pin row's vocabulary
      // (`implicitEffortFor`), never sent to a row that does not declare it. A per-session effort stays explicit.
      //
      // 2026-09-18: both arms now honour the STORED role effort, through the one resolver
      // (`effortToSpendForRole`, settings.ts) and off the `settings` this incarnation just read live:
      //  - dispatch: `roleEfforts["pins.dispatch"]`, else `DISPATCH_EFFORT` as before (`dispatchEffortFor`).
      //    `mode === "dispatch"` is the ONLY door to it — a dispatch CHILD is `mode: "code"` and takes the
      //    other arm, so the coordinator's effort cannot leak onto the work it spawns.
      //  - every other mode: the session's OWN effort first, always. Only a session that never chose one
      //    falls back to the daemon's default effort, `provider.reasoningEffort` (the `provider.model`
      //    role's effort) — the rule `SessionMeta.effort`'s doc has promised since the engine
      //    ("absent means use the global default") and that nothing had implemented since the engine
      //    was retired: the value was stored, reported by `sync.config`, and spent by no request. It
      //    is IMPLICIT here, so it is mapped onto THIS session's model's row, never forced onto it.
      // `live.effort` stays first on both arms and stays verbatim (explicit; the child refuses it typed
      // when unsupported). `sdkEffortOf` then drops `"none"`/`ultra` on every path alike, so a role's
      // stored `"none"` is spent exactly as a session's is: the request carries no effort.
      const effort = spendEffortFor(settings, mode, model, live.effort);
      // WS-20: `model` is ALWAYS a provider-qualified tag now (or the winter-test escape hatch) —
      // `providerFor` names exactly its provider, no inventory-order tie-break, no "router's decided
      // provider" hotfix needed (that hotfix existed only because a BARE id could be ambiguous).
      // 2026-09-17 field report: an EXISTING record gets the same typed refusal `create()` gives a fresh
      // one — 0.114.1 resumed a dispatch session with `model: "unstated"` and no provider, and the
      // child's own "a bare model id needs a provider" was all the user saw.
      if (model === UNSTATED_TAG) {
        throw new WinterLegRefusal(
          "runtime_selection_refused",
          `this ${mode} session has no runnable model: its pin resolves to no known slot for this daemon's own provider (${ownProviderFor(settings)}) — set settings.pins.dispatch explicitly, or pick a default model whose provider serves it`,
          "pin-unstated",
        );
      }
      const selection = model === undefined ? undefined : providerFor(model, deps.home);
      // WS-19 (W19-6): a BYO endpoint travels as the provider's connection, or the catalog's own row
      // would route it to that provider's default endpoint. There is deliberately NO daemon-side
      // endpoint table: the catalog ships each provider's own `defaultEndpoints` and the SDK's
      // `connectionFrom` copies them for the multi-provider adapters, so an unconfigured provider
      // needs no `connection` at all and gets the right endpoint anyway. This is for the case the SDK
      // cannot answer — a self-hosted or proxied endpoint, and the loopback fakes the parity e2e
      // tests point at.
      //
      // Fix wave item 2 (measured against a real child): `local: true` is a DELIBERATE
      // compatibility decision, not an oversight — the SAME one `providers/runtime-provider.ts`'s
      // own `createOpenAiCompatibleRuntimeProvider` already makes for the identical setting.
      // Without it the Winter runtime's own endpoint policy refuses a loopback/private-address
      // base URL outright, which silently breaks every real self-hosted/LAN endpoint (Ollama, LM
      // Studio, a local gateway) even though a BYO provider has never had an endpoint allowlist.
      //
      // WS-20: the LEGACY `settings.provider.baseUrl` arm is GONE — `ProviderSettings` has no
      // `baseUrl` field any more (the v2→v3 migration copies a stored value into
      // `providers.openai.baseUrl` once), so `providerBaseUrlFor` is the ONLY door.
      const perProviderBaseUrl = selection === undefined ? undefined : providerBaseUrlFor(settings, selection.providerId);
      const connection: ProviderConnectionConfig | undefined =
        perProviderBaseUrl === undefined ? undefined : { baseUrl: perProviderBaseUrl, endpointOrigin: "user", local: true };
      const capSession: CapabilitySession = {
        sessionId, mode, cwd,
        roots: deps.rootsOf(sessionId),
        tmpDir: deps.tmpDirOf(sessionId),
        outDir: deps.outDirOf(sessionId),
        signal: inc.abort.signal,
        // The SAME probe `buildWinterOptions` gets below (one read, one incarnation): it decides
        // whether this session's `research` server advertises `Search` at all, and `disallowedTools`
        // decides the complementary `WebSearch`/`Search` withholding from the identical value. Two
        // doors, one answer — see `capabilities/research.ts` for what disagreement would cost.
        exaKeyPresent: exaPresent,
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
      // WS-21 (L4 request 2): the daemon hands no skills or plugin views to a child any more — the run
      // folder carries the skills and both runtimes load plugins natively (`enabledPlugins`); the old
      // skills-only plugin-view handover (`SkillStore.childSkillSurface`) is retired.
      const systemPrompt = deps.assembler === undefined ? undefined : winterSystemPromptFor(deps.assembler, {
        mode, origin: live.origin, primary, cwd: primary ?? deps.tmpDirOf(sessionId),
        outDir: deps.outDirOf(sessionId), extraDirs, effort: live.effort,
        // THE THIRD READER of this one probe, and the reason it is threaded rather than re-derived:
        // chat's and dispatch's base prompts NAME their search tool, and the prompt must name the one
        // `disallowedTools` and the capability server actually gave this incarnation.
        exaKeyPresent: exaPresent,
        // WS-21 (L3.4): the run folder carries the instructions, the output style and the code memory.
        ...(runHomeApplied ? { runHomeApplied: true } : {}),
      });
      // P8b-36 obligation: any other server merged into the same record must not shadow a
      // daemon-owned one. Since the fix wave the configured user/project MCP servers ARE merged
      // here, so the guard is live: a `settings.mcpServers` key spelled `winter__browser` refuses
      // this session TYPED (the message names the server) rather than handing the model a
      // `browser` that is not Winter's under Winter's name. The user fixes the key; settings are hot.
      // WS-21 (L3.4): on a run-home incarnation the configured servers (user, local, trusted project) are
      // the run folder's `.winter.json`; only the daemon's capability servers ride `Options.mcpServers`.
      const extra = runHomeApplied ? {} : (deps.extraMcpServers?.(capSession) ?? {});
      try { assertNoCapabilityCollision(extra, capabilities); } catch (err) {
        throw new WinterLegRefusal("winter_leg_unavailable", err instanceof Error ? err.message : String(err));
      }
      // P8d-8 (D30), computed ONCE (review Minor fix): `runtimes.advisorModel` when the user set
      // one, else Winter's own D30 default for this session's model family.
      //
      // WS-20: `runtimes.advisorModel` stays a PLAIN, deliberately unvalidated string at the schema
      // level (settings.ts's own doc comment — "blank-is-absent must never invalidate the file");
      // the ONLY door that validates it as a real tag is `settings.setAdvisorModel`
      // (ipc/server.ts). A hand-edited settings.json could still park a non-tag string there, so
      // this is the one OTHER place that must not trust it blindly — `isModelTag` degrades an
      // invalid stored value to "unset", falling through to the same D30 default an absent value
      // already gets, rather than handing a malformed string to the spawn boundary.
      const rawAdvisorModel = winterOptionsFromSettings(settings).advisorModel;
      const pinnedAdvisor = rawAdvisorModel !== undefined && isModelTag(rawAdvisorModel) ? rawAdvisorModel : undefined;
      let advisorModel = pinnedAdvisor ?? d30DefaultModel(model);
      // D3 (2026-09-22) + review M2: a pin on ANOTHER provider now runs there, on that provider's own
      // credential (`buildWinterOptions` sends the full tag + its `authRef`), so the `pins.research`
      // digest rule below applies to it IN FULL, for the same reason — a stated advisor that cannot run
      // makes every `advisor` call a typed refusal, while the family default keeps the tool working.
      // The pin is therefore not stated, and the D30 default is (one line naming the setting), when:
      //   - it names no catalog row (`rowForTag`: a hand-edited settings file can hold any tag shape);
      //   - it is cross-provider and excluded from this route (the reserved `cc`, which names no slot
      //     at all; stating nothing avoids the M7 hazard, the child's fallback to the brand's own
      //     Keychain lookup). `console` is an ordinary route since the WS-23 live-gate fix: its bearer
      //     slot is named like any provider's, and the SDK adapter sends it for the `console` id;
      //   - it is cross-provider and that provider's slot is EMPTY.
      // A same-provider pin needs no probe: the session's own turn cannot run without that credential.
      advisorProviders.delete(sessionId);
      if (pinnedAdvisor !== undefined && pinnedAdvisor !== UNSTATED_TAG && !pinnedAdvisor.startsWith(WINTER_TEST_PREFIX)) {
        const advisorProviderId = splitTag(pinnedAdvisor).providerId;
        const crossProvider = advisorProviderId !== selection?.providerId;
        // Whole-branch review (minor d): the provider a CREDENTIAL write must also reach this child for
        // — whether the pin runs there (its `authRef` names that slot) or fell back because the slot was
        // empty (the key is what it waits for). An off-catalog pin is not recorded: no key fixes it.
        if (crossProvider && rowForTag(pinnedAdvisor) !== undefined) advisorProviders.set(sessionId, advisorProviderId);
        // `CLAUDE_FIRST_PARTY_PROVIDER_IDS` (only the reserved `cc` since the WS-23 live-gate fix lifted
        // `console`, whose bearer the SDK adapter now sends) — symmetric with the internal jobs' set.
        const advisorRef = crossProvider && !(CLAUDE_FIRST_PARTY_PROVIDER_IDS as readonly string[]).includes(advisorProviderId)
          ? credentialRefFor(advisorProviderId, deps.home)
          : undefined;
        const why = rowForTag(pinnedAdvisor) === undefined ? `names ${JSON.stringify(pinnedAdvisor)}, which no model in the pinned catalog carries`
          : !crossProvider ? undefined
            : advisorRef === undefined ? `names ${advisorProviderId}, whose credential this route cannot state (an excluded first-party login, or a provider with no Keychain slot)`
              : !(await refMaterialPresent(deps.secrets, advisorRef)) ? `names ${advisorProviderId}, whose credential slot is empty`
                : undefined;
        if (why !== undefined) {
          advisorModel = d30DefaultModel(model);
          log(`runtimes.advisorModel: ${why} — the advisor runs on this session's family default${advisorModel === undefined ? " (the child's own)" : ` (${advisorModel})`} instead`);
        }
      }
      // 2026-09-18 (user ruling): `pins.research` is `WebFetch`'s PAGE-DIGEST model. Read LIVE here
      // like every other per-incarnation value, and DROPPED — rather than stated — in the cases
      // where stating it would make every `WebFetch` call in the session a typed refusal (the SDK
      // never silently falls back to the session's model for a STATED digest model, deliberately):
      //
      //   the `unstated` sentinel   `pinsFor` answers it when the daemon's own provider serves no
      //                             `luna` slot and the user pinned nothing.
      //   no stored credential      the pin names a provider this machine has no key for. The
      //                             session's own model always has one (`beforeTurn` refuses first),
      //                             so the digest runs there instead — a little more expensive, and
      //                             the tool works.
      //   the session's own tag     nothing to state: that IS the SDK's default (`buildWinterOptions`
      //                             drops this one itself, since it holds both tags).
      //   an excluded first-party login (the reserved `cc`, which has no slot; `console` is an
      //                             ordinary digest route since the WS-23 live-gate fix).
      //
      // Logged once per incarnation when it is dropped for a reason the user could act on, naming the
      // setting — a pin that silently does nothing is exactly what `runtimes.advisorModel`'s own
      // dropped-advisor log line exists to prevent.
      const researchPin = pinsFor(settings).research;
      const digestProviderId = researchPin === UNSTATED_TAG ? undefined : (() => {
        try { return splitTag(researchPin).providerId; } catch { return undefined; }
      })();
      // The probe is of the ITEM THIS DOOR WOULD NAME (`refMaterialPresent`'s own doc) — one extra
      // read, only when an explicit pin differs from the session's own model, which is the rare case.
      // `CLAUDE_FIRST_PARTY_PROVIDER_IDS` is the same set as the advisor pin's above (only `cc`).
      const digestRef = digestProviderId === undefined || researchPin === model ||
          (CLAUDE_FIRST_PARTY_PROVIDER_IDS as readonly string[]).includes(digestProviderId)
        ? undefined
        : credentialRefFor(digestProviderId, deps.home);
      const digestUsable = await refMaterialPresent(deps.secrets, digestRef);
      // AND the tag must actually BE a catalog row (whole-branch review M1). This is the one check
      // whose absence WITHDREW THE TOOL: the child advertises `WebFetch` only while its digest model
      // resolves, so a hand-edited `pins.research` naming a model no catalog row carries — the zod
      // schema checks the tag's SHAPE only, and `settings.setModelRole`'s catalog check guards just
      // that one door — made `WebFetch` disappear from every Winter session, chat included, where the
      // base prompt still names it. Same NON-throwing catalog membership test the RPC door runs
      // (`rowForTag`, the `assertCatalogBackedTag` family), and a miss drops the pin exactly like a
      // missing credential does. `winter-test/*` is excluded by construction: it is not a catalog
      // provider at all, and `buildWinterOptions` drops it independently.
      const digestOffCatalog = researchPin !== UNSTATED_TAG && researchPin !== model
        && !researchPin.startsWith(WINTER_TEST_PREFIX) && rowForTag(researchPin) === undefined;
      const digestModel = researchPin !== UNSTATED_TAG && researchPin !== model && digestUsable && !digestOffCatalog
        ? researchPin
        : undefined;
      if (digestModel === undefined && researchPin !== model) {
        log(`pins.research: ${
          researchPin === UNSTATED_TAG ? "resolves to no known slot for this daemon's own provider"
            : digestOffCatalog ? `names ${JSON.stringify(researchPin)}, which no model in the pinned catalog carries`
              : digestRef === undefined ? `names ${digestProviderId ?? "a provider"} whose credential this route cannot state (an excluded first-party login, or a provider with no Keychain slot)`
                : `names ${digestProviderId}, whose credential slot is empty`
        } — WebFetch will digest pages on this session's own model instead`);
      }
      // A cross-provider digest is legitimate and stays silent in production logs at `info` — but it
      // is new spend on a credential the session never named (`pins.research` defaults to the DAEMON's
      // own provider, not the session's), so it is worth one debug line naming both providers when the
      // two differ. Providers only: never a credential, never a locator.
      if (digestModel !== undefined && selection !== undefined && digestProviderId !== undefined && digestProviderId !== selection.providerId) {
        deps.log?.(`pins.research: this session runs on ${selection.providerId} and its WebFetch digest runs on ${digestProviderId} — that provider's own credential pays for it`);
      }
      const options = buildWinterOptions({
        mode,
        policy: live.approvalPolicy,
        origin: live.origin,
        sessionId: backendSessionId,
        home,
        profile: deps.profile,
        cwd,
        // R.3 I-4: the other working directories get the sandbox's any-depth `.winter/<kind>` fence too.
        extraDirs,
        outputsDir: deps.outDirOf(sessionId),
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
        // P8c-14 (integration round 2): lane 3's hooks facade (`hooks.ts`'s `sessionHooksFor`).
        ...(deps.hooksFor === undefined ? {} : { hooks: deps.hooksFor(capSession).winter }),
        // P8d-8 (D30): a LIVE read at every incarnation — `runtimes.advisorModel` when the user set
        // one, else Winter's own D30 default for this session's model family (`advisor-reviewer.ts`'s
        // `d30DefaultModel`), so `Options.advisor.model` is ALWAYS explicit rather than depending on
        // the child's own internal default resolution (the M5 gap this task diagnosed). Computed
        // ONCE (review Minor fix) — the prior form called both `winterOptionsFromSettings` and
        // `d30DefaultModel` twice for the identical value.
        ...(advisorModel === undefined ? {} : { advisorModel }),
        // 0.0.17's `Options.web`, assembled in `buildWinterOptions` from these three pure inputs —
        // see `webOptionsFor` there for what each one decides. `dangerousDomainsAdded` is the project
        // overlay-aware getter the daemon's own web tools already read, so the child's floor and the
        // daemon's are provably the same list.
        exaKeyPresent: exaPresent,
        dangerousDomains: [...SHIPPED_DANGEROUS_DOMAINS, ...(deps.dangerousDomainsAdded?.(cwd) ?? [])],
        ...(digestModel === undefined ? {} : { digestModel }),
        // Daemon settings surface (2026-09-17 plan, item 3): a FRESH scan of `<home>/agents/*.md`
        // at every incarnation (never cached here or in `loadUserAgentDefinitions` itself) — a
        // new/edited/removed file reaches THIS session's very next incarnation, no daemon restart.
        // `buildWinterOptions` itself stays pure/no-I/O (its own doc comment); this is the ONE
        // caller that does the read, exactly where every other per-incarnation live read (advisor
        // model, system prompt, connection override) already happens.
        //
        // Batch 3 (item 1): merged with the TRUSTED project tier (`deps.projectAgentDefinitions`,
        // trust-gated by the daemon's own wiring — absent/untrusted degrades to the empty scan
        // shape) via `mergeAgentDefinitionTiers`, restoring the SDK's own precedence (project wins
        // over user, by name) instead of the user tier alone winning outright.
        // WS-21 (L3.4): on a run-home incarnation the agents are the run folder's (copies, spec §3.3).
        ...(runHomeApplied ? {} : { agents: mergedAgentDefinitions(home, cwd, deps.projectAgentDefinitions) }),
        // Lane B: the user's SAVED allow rules, live and trust-gated (`WinterLegDeps.persistedAllowRules`).
        ...(runHomeApplied || deps.persistedAllowRules === undefined ? {} : { persistedAllow: deps.persistedAllowRules(cwd) }),
        // WS-21: the user tier's allow and deny rules, read live from `sdk/settings.json` (claude grammar).
        ...userRulesFrom(home, runHomeApplied),
        ...(runHomeApplied ? { runHomeApplied: true } : {}),
      });
      // WS-21 (spec §3.1): LAST, so a refusal above never leaves a run folder behind. The router's Winter
      // overload reads `options.runtime.runHome` and applies it synchronously; `WinterSession` disposes it
      // when the incarnation ends (or at once, if the open fails before the child iterates).
      if (deps.runHome === undefined) return options;
      const runHome = await deps.runHome.build(deps.runHome.inputFor({
        mode, dispatchChild: live.origin === "dispatch-child", leg: "winter", cwd, workdirLess: primary === undefined,
      }));
      return withRunHome(options, runHome);
    };

    const projectorFor = (inc: WinterIncarnation): Projector =>
      createProjector({
        sessionId, mode,
        generation: inc.generation,
        winterSessionId: sessionId,
        runtimeKind: "winter-agent",
        nextSeq: () => deps.store.lastSeq(sessionId) + (++claimedInBatch),
        priorTodos: () => readWinterTasks(deps.store, sessionId),
        // C2 (lane C, 2026-09-22): a card the child abandoned (an interrupt's `[interrupted]` result)
        // is withdrawn before that result lands — this SDK never cancels the pending `canUseTool`.
        onToolResults: (callIds) => { for (const callId of callIds) canUseTool.withdrawPending(callId); },
        checkpoint: checkpoints,
        now: () => new Date().toISOString(),
        log: {
          warn: (message, fields) => log(`${message} ${fields === undefined ? "" : JSON.stringify(fields)}`.trim()),
        },
      });

    // WS-21: `winterSessions` reads this build's store home (`storeHomeFor`) — see `sessions.ts`.
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
     * WS-20: a model is ALWAYS a provider-qualified tag now (or the winter-test escape hatch), so
     * `providerFor` names exactly one provider — there is no more "ambiguous bare id served by
     * several inventory providers" case to narrow around, and this gate ALWAYS runs for a real
     * tag. `local-none` providers (Ollama, LM Studio, a local gateway — anything whose catalog
     * `authKinds` is not `api-key`) are excluded a layer down, by auth family
     * (`apiKeyProviderIsUnauthenticated`) — never a settings-field special case.
     */
    const beforeTurn = async (): Promise<void> => {
      const live = deps.store.meta(sessionId);
      const settings = deps.settings();
      const model = mode === "dispatch" ? (live.model ?? pinsFor(settings).dispatch) : (live.model ?? settings?.provider?.model);
      if (model === undefined) return;
      // R.1 ruling 1: a model the catalog RETIRED with no rename (a tag stored before the upgrade) is a
      // typed refusal here, before any child — never a silent fallback to another model, and never the
      // child's own mid-turn "not in provider's catalog" error. No key makes it runnable, so it is judged
      // before the credential. The session's fix is `session.setModel`; the Roles pane shows the same fact
      // as a `model-not-in-catalog` problem (`providers/catalog-role-problems.ts`). Any OTHER off-catalog
      // tag gets the same answer, earlier and typed: the daemon never sets the child's
      // `provider.allowUnlisted`, so the child refused every unlisted model anyway.
      if (isRetiredCatalogTag(model)) {
        throw new WinterLegRefusal("runtime_selection_refused", `${model} is not in this build's model catalog — switch this session to another model`, "model-not-in-catalog");
      }
      const selection = providerFor(model, deps.home);
      if (selection === undefined) return;
      const credentials = await credentialPresenceFrom(deps.secrets);
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
      ...(deps.onSupportedAgents === undefined ? {} : { onSupportedAgents: (agents) => deps.onSupportedAgents!(sessionId, agents) }),
      // P8b-39: the session log is the durable queue — what `open()` re-pushes is read from it.
      unconsumed: () => unconsumedUserMessages(deps.store.read(sessionId)),
      idleTimeoutMs: deps.idleTimeoutMs ?? (() => winterOptionsFromSettings(deps.settings()).idleTimeoutSec * 1000),
      ...(deps.endGraceMs === undefined ? {} : { endGraceMs: deps.endGraceMs }),
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
    modelRef: model ?? UNSTATED_TAG,
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
   *   4. (Fix round 1, M5; WS-20) The model has NO ROW IN THE PINNED CATALOG AT ALL —
   *      `rowForTag(model) === undefined` — a tag whose exact key no catalog row carries. The
   *      selector has NOTHING to route on for a name it does not recognise at all — this is exactly
   *      that same "the child decides" case, not the D13 "we know the family, we lack the
   *      credential" refusal, so it keeps today's literal too. A model the catalog DOES recognise
   *      (e.g. a Claude model) but no provider can serve is NOT this bail-out — that stays a real,
   *      typed `runtime_selection_refused` (bail-out 4 checks the catalog, not the credential map).
   *
   * Outside those four cases the router's answer — including a REFUSAL — is honoured: a Claude
   * model with no configured credential is `runtime_selection_refused`, never a silent fallback to
   * another provider (D13's own "never a substitution").
   *
   * WS-23: the router is told there is no official runtime (`hasClaudePeer: false`, `create.ts`), so
   * a Claude model selects the Winter runtime like every other family. An answer naming any other
   * runtime would be a router this daemon cannot serve, and is refused typed rather than recorded.
   */
  const decideRuntime = async (mode: SessionMode, model: string | undefined): Promise<RuntimeSelection | undefined> => {
    if (typeof deps.runtime?.selectRuntimeFor !== "function") return undefined;
    if (model === undefined || testProviderNameFor(model) !== undefined) return undefined;
    if (rowForTag(model) === undefined) return undefined;
    const decided = await deps.runtime.selectRuntimeFor({ mode, model });
    if (isSelectionRefusal(decided)) throw await refusalForSelection(decided, model);
    if (decided.runtimeKind !== "winter-agent") {
      deps.log?.(`selectRuntimeFor chose ${decided.runtimeKind} for ${model}, which this daemon no longer hosts — refused`);
      throw new WinterLegRefusal("runtime_selection_refused", neutralSelectionRefusal(model), "runtime-unavailable");
    }
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
   *     happened to find an empty slot, so a session whose runtime was unavailable would have been
   *     told to go and add an API key).
   *
   * The credential probe happens ONLY on this path (a refusal), never on the hot create path, which
   * has already done its own.
   */
  const refusalForSelection = async (refusal: { reason: string; detail: string; alternatives?: readonly SelectionAlternative[] }, model: string): Promise<WinterLegRefusal> => {
    // THE RAW DETAIL GOES TO THE LOG, AS A CATEGORY, AND NOWHERE ELSE (whole-branch review MAJOR 2).
    // `session.setModel` has scrubbed this class since D1 fix round 4; `session.create` handed it
    // through verbatim, and `session.create` is REMOTE-ALLOWED, so router-internal wording (runtime
    // kinds, spec ids) and `slot-unservable`'s enumeration of the user's own configured providers were
    // reaching the phone. Both doors now share one definition (`refusal-copy.ts`).
    deps.log?.(`selectRuntimeFor refused ${model} (reason=${refusal.reason}, detail=${refusalDetailCategoryFor(refusal.detail)})`);
    const neutral = neutralSelectionRefusal(model);
    if (refusal.reason === "no-credential" && refusal.alternatives !== undefined) {
      // The hint is the ONE refusal text that is actionable, and it is built HERE out of the
      // router's structured `alternatives` — never out of `detail`, whose prefix is now dropped.
      const hint = renderNoCredentialHint(refusal.alternatives);
      return new WinterLegRefusal("runtime_selection_refused", `${neutral} ${hint}`, "no-credential");
    }
    if (!refusalMayBeCredentialShaped(refusal.reason)) {
      return new WinterLegRefusal("runtime_selection_refused", neutral, refusal.reason);
    }
    try {
      // WS-20: `providerFor` always names exactly one provider (a tag is never ambiguous) — the
      // MINOR 1 narrowing this used to need (a bare id served by several inventory providers) no
      // longer applies.
      const credentials = await credentialPresenceFrom(deps.secrets);
      const selection = providerFor(model, deps.home);
      if (selection !== undefined
          && apiKeyProviderIsUnauthenticated(selection.providerId, credentials.byProvider[selection.providerId] !== undefined)) {
        return new WinterLegRefusal("runtime_selection_refused", missingCredentialDetail(selection.providerId), "no-credential");
      }
    } catch { /* a store that will not answer must not turn one refusal into a different one */ }
    return new WinterLegRefusal("runtime_selection_refused", neutral, refusal.reason);
  };

  const create = async (sessionId: string): Promise<LegSession> => {
    const meta = deps.store.meta(sessionId);
    const mode = modeOf(meta.mode);
    // The executable was asserted by the caller BEFORE the product row was minted (`session.create`);
    // here only the spine is re-checked — the first `open()` re-resolves the hook anyway and
    // refuses typed if it went away in between.
    assertSpine();
    const records = deps.records!;
    const cwd = winterCwdOf(sessionId, meta.cwd);

    const decided = await decideRuntime(mode, meta.model);

    const backendSessionId = randomUUID();
    const transcriptKey = transcriptProjectKey(cwd);
    // WS-20 (review round 2, M1): `session.create` with NO explicit `model` (the normal Mac case)
    // must still record a REAL provider, because the child runs on `settings.provider.model`'s
    // provider regardless — the OLD code recorded `providerId: "unstated"` here, which made
    // `credential.set`'s hot-swap (`credentials.ts`'s `evictSessionsForCredential`, which reads
    // THIS record's `providerId`) evict nothing for a default-model session. Computed ONCE, the
    // SAME precedence `optionsFor`'s own `model` derivation uses just above: dispatch runs its own
    // pin, everything else falls back to the daemon's configured provider.
    const settings = deps.settings();
    const effectiveTag = meta.model ?? (mode === "dispatch" ? pinsFor(settings).dispatch : settings?.provider?.model ?? DEFAULT_PROVIDER.model);
    // WS-20 (review round 2, M6): `pinsFor` dropped its old cross-provider "openai" fallback rung —
    // a provider that does not itself serve the terra/luna slot now yields `UNSTATED_TAG`, never a
    // silent guess at a different provider. `meta.model` can never BE the sentinel here (rejected at
    // the RPC door, `resolveModelSelection`'s nit-e check), so this can only fire for the
    // `pinsFor(settings).dispatch` branch in practice — refused typed, BEFORE `records.create` mints
    // a record naming the "unstated" pseudo-provider and BEFORE the child would ever be handed the
    // literal string "unstated" as its model.
    if (effectiveTag === UNSTATED_TAG) {
      throw new WinterLegRefusal(
        "runtime_selection_refused",
        `dispatch has no runnable model: pins.dispatch resolves to no known slot for this daemon's own provider (${ownProviderFor(settings)}) — set settings.pins.dispatch explicitly to a tag naming a provider this daemon can serve, or configure settings.provider.model to a provider whose catalog serves the terra slot`,
        "pin-unstated",
      );
    }
    // WS-20: a tag names exactly its provider — no more "steer this selection to agree with the
    // router's decision" hotfix; `providerFor` and `splitTag` can never disagree because they are
    // the same tag's own prefix.
    const selection = providerFor(effectiveTag, deps.home);
    const providerId = decided?.providerId ?? splitTag(effectiveTag).providerId;
    const providerAuthKinds = loadCatalog().providers.find((p) => p.id === providerId)?.authKinds ?? [];
    const authFamily: RuntimeSelection["authFamily"] = providerAuthKinds.includes("api-key") ? "api-key" : "custom";
    try {
      records.create({
        winterSessionId: sessionId,
        runtimeKind: "winter-agent",
        backendSessionId,
        providerId,
        // WS-20 (review round 2, M1): the EFFECTIVE tag, never the `UNSTATED_TAG` sentinel — a
        // default-model session has a real, known model (the daemon's configured provider.model,
        // or the dispatch pin) the moment it is created; recording "unstated" for it was itself
        // part of the same lie `providerId` told.
        modelRef: effectiveTag,
        // The LOCATOR only (`keychain:<account>`) — never material (records.ts's own rule).
        ...(selection?.authRef?.kind === "keychain" ? { authRef: `keychain:${selection.authRef.account}` } : {}),
        backendRoot: join(storeProjectsDir(deps.home), transcriptKey),
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
      if (err instanceof RunHomeError) throw new WinterLegRefusal(err.code, err.message);
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
  const resume = async (sessionId: string): Promise<LegSession> => {
    assertSpine();
    // WS-23 (R2): a record the retired official leg wrote is adopted onto the Winter leg first — its
    // transcript re-keyed, its runtime kind and selection rewritten — or refused typed, having moved
    // nothing (`adoptLegacyRecord`). Synchronous, like everything up to `drivers.set` (n7).
    const recorded = sessionLegOf(recordOf(sessionId)) === "official" ? adoptLegacyRecord(sessionId) : recordOf(sessionId);
    const leg = sessionLegOf(recorded);
    // Round 3: the transcript is where the child will look BEFORE it opens (synchronous — n7).
    const record = recorded !== undefined && leg === "winter" ? rekeyForCanonicalCwd(sessionId, recorded) : recorded;
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

  /** P8c-14: a leg the table can resume a driver on — `official` included, because `resume()` adopts
   *  such a record onto the Winter leg before it opens (WS-23). */
  const isResumableLeg = (leg: SessionLeg | undefined): boolean => leg === "winter" || leg === "official";

  return {
    legForNewSession: legForNew,
    legOf: (sessionId) => sessionLegOf(recordOf(sessionId)),
    advisorProviderOf: (sessionId) => (drivers.has(sessionId) ? advisorProviders.get(sessionId) : undefined),
    adoptLegacyRecord,
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
      advisorProviders.delete(sessionId);   // the next incarnation records its own
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
