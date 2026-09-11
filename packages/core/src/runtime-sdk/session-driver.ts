// P8b Task 16 — THE DRIVER TABLE: `sessionId → WinterSession`, and everything a Norma session needs
// assembled before a `winter` child can run it.
//
// `ipc/server.ts` routes by asking this table (see `WinterSessionDrivers`): a live driver wins; a
// record that says "winter" with no live driver is resumed here; anything else is the engine's,
// exactly as today. The table is built once in `daemon.ts` (after the runtime spine has recovered
// and the router handle has run its directory recovery — a projector is never constructed before
// that sweep) and shared with the IPC layer through `IpcServerOptions.winter`.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE CREATION TRANSACTION (WS-16 §6, P8b-13, P8b-14) — both legs, one record
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// `session.create` decides the leg with `legForNewSession(mode, settings())` and then persists ONE
// `RuntimeSessionRecord` on either leg (P8b-14: "both paths allocate and persist the same
// RuntimeSessionRecord"). The two records differ in exactly the facts that differ:
//
//   winter   `backendSessionId` = a fresh uuid (the child's transcript name — `Options.sessionId`
//            on the first incarnation, `Options.resume` afterwards); `transcriptHealth: "clean"`;
//            `versionProvenance: "recorded"` with the SDK/catalog versions this daemon pins;
//            `selection.reason` names the flag that put it here.
//   engine   the backfill's honest shape: NO backend id (there is no Winter transcript),
//            `transcriptHealth: "unsupported"`, `versionProvenance: "legacy-unknown"`,
//            `selection.reason` names the flag that kept it here.
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
import type { EffortLevel, ProviderConnectionConfig } from "@yanlinglabs/winter-agent-sdk";
import { transcriptProjectKey } from "@yanlinglabs/winter-agent-sdk";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import type { RuntimeDirectoryEntry, RuntimeSelection } from "@yanlinglabs/winter-runtime-sdk";
import type { SecretStore } from "../auth/secret-store";
import type { ApprovalBroker } from "../agent/approvals";
import type { PermissionGate } from "../agent/gate";
import type { QuestionBroker } from "../agent/questions";
import { NORMA_CAPABILITY_TOOLS, assertNoCapabilityCollision, type CapabilityServerRecord, type CapabilitySession } from "../capabilities";
import { createProjector, type Projector } from "../projector";
import type { RuntimeSessionRecord, RuntimeSessionRecords } from "../runtime-state/records";
import type { ProjectionCheckpoints } from "../runtime-state/checkpoints";
import type { SessionHub } from "../sessions/hub";
import type { SessionStore } from "../sessions/store";
import { winterOptionsFromSettings, type Settings } from "../settings";
import { canUseToolFor } from "./approval-bridge";
import type { NormaRuntimeSdk, SessionMode } from "./create";
import { credentialPresenceFrom } from "./keychain";
import { legForNewSession, sessionLegOf, type SessionLeg } from "./leg";
import { attachWinterSession } from "./messaging";
import { buildWinterOptions, permissionModeFor } from "./mode-options";
import { providerSelectionFor } from "./provider-selection";
import { normaSessions } from "./sessions";
import { NORMA_PEER_VERSIONS } from "./versions";
import { winterSystemPromptFor } from "./system-prompt";
import { DISPATCH_EFFORT, DISPATCH_MODEL } from "../agent/dispatch-config";
import type { AgentRegistry } from "../agent/bg-agent-registry";
import type { ContextAssembler } from "../agent/context";
import { startWinterSession, unconsumedUserMessages, type WinterChildrenSink, type WinterIncarnation, type WinterIncarnationShape, type WinterSession } from "./winter-session";

export type WinterLegRefusalCode =
  | "winter_executable_unavailable"   // P8b-2: no `winter` binary resolves (setting → env → bundle → home)
  | "winter_leg_unavailable"          // the router handle or the runtime spine did not construct
  | "session_predates_winter_leg"     // P8b-22: the record has no Winter transcript to resume
  | "winter_session_ended"            // the driver said the store refused it for good
  | "not_supported_on_winter_leg";    // `session.compact` (SDK 0.0.4 carry)

export class WinterLegRefusal extends Error {
  constructor(readonly code: WinterLegRefusalCode, message: string) {
    super(message);
    this.name = "WinterLegRefusal";
  }
}

/** The narrowed `SessionMode` a stored `mode` column resolves to (absent = code, as everywhere). */
const modeOf = (raw: string | undefined): SessionMode => (raw === "chat" || raw === "dispatch" ? raw : "code");

/** Norma's effort strings that are also the SDK's `EffortLevel`. `none` is the wire's "unset" and
 *  `ultra` is Norma-only (a client-side selector the engine translates); neither crosses here. */
const SDK_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);
const sdkEffortOf = (raw: string | undefined): EffortLevel | undefined => (raw !== undefined && SDK_EFFORTS.has(raw) ? (raw as EffortLevel) : undefined);

export interface WinterLegDeps {
  home: string;
  /** `NORMA_PROFILE` for the child (`""` on dist). */
  profile?: string;
  /** THE LIVE settings holder. */
  settings: () => Settings | null | undefined;
  runtime: NormaRuntimeSdk | undefined;
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
  /** Task 17 Step 0(a): the daemon's ONE `ContextAssembler` — Norma's system prompt per mode,
   *  composed per incarnation (hot: NORMA.md, memory, the output style are re-read on resume).
   *  Absent (a harness without one) ⇒ no `systemPrompt` and the child runs Winter's own. */
  assembler?: Pick<ContextAssembler, "assemble">;
  /** Task 17 (P8b-15): the persisted child roster (`createPersistedChildren` over 8a's
   *  `runtime_children`). A Winter child is registered under the spawning `tool_use.id` with NO
   *  local abort (its process is the session's), fed `progress()` on every frame of its thread, and
   *  completed from the spawning call's `tool_result`. */
  children?: AgentRegistry;
  /** Any OTHER MCP servers merged into a session's record (settings/plugin servers). None in 8b;
   *  the seam exists so the collision guard has something to guard. */
  extraMcpServers?: (session: CapabilitySession) => Record<string, unknown>;
  log?: (line: string) => void;
  /** Test seams. */
  idleTimeoutMs?: () => number;
  endGraceMs?: number;
}

export interface WinterSessionDrivers {
  /** P8b-13: the leg a NEW session of this mode is created on, from the live settings. */
  legForNewSession(mode: SessionMode): SessionLeg;
  /** The leg an EXISTING session runs on, from its record; undefined when it has no record. */
  legOf(sessionId: string): SessionLeg | undefined;
  /** Refuse (typed) unless a Winter-leg session of this mode could be created right now. Runs
   *  BEFORE the product row is minted, so a refusal costs nothing. */
  assertAvailable(mode: SessionMode): void;
  /** The Winter half of the creation transaction, for a session row that already exists: persist
   *  the record (fresh backend uuid), start the driver, register it. Throws `WinterLegRefusal`. */
  create(sessionId: string): Promise<WinterSession>;
  /** The engine half of P8b-14's dual-run: persist the backfill-shaped record. Best effort. */
  recordEngineCreation(sessionId: string): void;
  /** The live driver, if any. */
  get(sessionId: string): WinterSession | undefined;
  /** One HEADLESS turn (routines, the -p path): the session's driver (created for a session that
   *  has no record yet, resumed otherwise), `send`, then wait until nothing is in flight. */
  runTurn(sessionId: string, text: string, clientName: string): Promise<void>;
  /** A live driver, or a resumed one when the record says "winter"; undefined ⇒ the engine's. */
  ensure(sessionId: string): Promise<WinterSession | undefined>;
  /** The session was DELETED (the reaper, the cleaner): end its child (bounded) and forget the
   *  driver — a live child never outlives its session (the reaper's 600 s grace is shorter than
   *  the 900 s idle timer). Never throws. */
  evict(sessionId: string): Promise<void>;
  list(): WinterSession[];
  /** End every live driver (bounded each). Shutdown reaches them through `trackQuery` anyway; this
   *  is the door a test drives. */
  endAll(): Promise<void>;
}

/**
 * The `sessionPermissionClass` seam Task 12 left for this task (`NormaRuntimeSdkDeps`): the inbound
 * class of a session this process holds NO live facet for. Without it every unattached receiver
 * holds its mail forever; with it a parked (`resumable`) session answers the honest `unavailable`
 * and is never cold-resumed behind the daemon's back.
 *
 * The directory address carries the BACKEND id; the 8a record is the hop back to Norma's session,
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
function childrenSinkFor(registry: AgentRegistry, sessionId: string, log: (line: string) => void): WinterChildrenSink {
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
  const drivers = new Map<string, WinterSession>();
  const log = deps.log ?? ((): void => {});
  const sdkVersion = NORMA_PEER_VERSIONS.winterAgentSdk;

  const catalogVersion = (): string => {
    try { return loadCatalog().catalogVersion; } catch { return "unstated"; }
  };

  const legForNew = (mode: SessionMode): SessionLeg => legForNewSession(mode, deps.settings() ?? undefined);

  /** The spine half of `assertAvailable`: the handle and 8a's repositories exist. */
  const assertSpine = (): void => {
    if (deps.runtime === undefined) throw new WinterLegRefusal("winter_leg_unavailable", "the Winter runtime handle did not construct on this daemon; the Winter leg refuses (every mode still runs on the engine)");
    if (deps.records === undefined || deps.checkpoints === undefined) throw new WinterLegRefusal("winter_leg_unavailable", "runtime-state is offline on this daemon; the Winter leg needs its records and checkpoints");
  };

  const assertAvailable = (mode: SessionMode): void => {
    assertSpine();
    const hook = deps.runtime!.spawnHookFor(mode);
    if (hook instanceof Error) throw new WinterLegRefusal("winter_executable_unavailable", hook.message);
  };

  /** The 8a record, read WITHOUT letting a store failure out: on the engine paths (`legOf`,
   *  `ensure`, every `session.*` handler of an engine session while the table is present) a
   *  records store that will not answer must cost the log line only, never the RPC — the engine
   *  path is the answer, exactly as if the table were absent. */
  const recordOf = (sessionId: string): RuntimeSessionRecord | undefined => {
    try { return deps.records?.get(sessionId); } catch (err) {
      log(`runtime record for ${sessionId} unreadable (${err instanceof Error ? err.name : "unknown"}) — treated as engine-leg`);
      return undefined;
    }
  };

  /** The Winter leg's fallback for a cwd-less session: its per-session temp dir (the CC-parity
   *  $TMPDIR — the directory the child actually runs in, so its transcript key names it). The
   *  ENGINE-leg record uses 8a's boot backfill's own fallback instead (`migrations/backfill.ts`,
   *  `home`) — the two producers of an engine-leg record must agree on `transcriptProjectKey`/
   *  `backendRoot` (re-review N3), and the backfill's shape is the surviving truth. */
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
    });

    /** Predictive, and exact: the driver appends every batch synchronously right after the projector
     *  returns it, so "the store's lastSeq plus how many this batch has already claimed" IS the seq
     *  the store will stamp. Reset after every append (a user_message the host appends itself, the
     *  bridge's cards between frames — none of them drift it, because it is re-read per call). */
    let claimedInBatch = 0;
    const append = (event: Parameters<SessionHub["append"]>[1]) => {
      const stamped = deps.hub.append(sessionId, event);
      claimedInBatch = 0;
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
      const selection = providerSelectionFor(model, credentials);
      // P8b-30: a BYO `openai-compatible` endpoint travels as the provider's connection, or the
      // catalog's `openai` row would route it to api.openai.com.
      const connection: ProviderConnectionConfig | undefined =
        settings?.provider?.type === "openai-compatible" && selection?.providerId === "openai"
          ? { baseUrl: settings.provider.baseUrl, endpointOrigin: "user" }
          : undefined;
      const capSession: CapabilitySession = {
        sessionId, mode, cwd,
        roots: deps.rootsOf(sessionId),
        tmpDir: deps.tmpDirOf(sessionId),
        outDir: deps.outDirOf(sessionId),
        signal: inc.abort.signal,
      };
      const capabilities = deps.buildSessionCapabilities(capSession);
      // Norma's own voice (Step 0(a)): the engine's `primaryDir`/`cwd`/`additionalWorkDirs` inputs,
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
      // daemon-owned one. Nothing else is merged in 8b; the guard runs regardless so the day
      // something is, the collision is loud.
      const extra = deps.extraMcpServers?.(capSession) ?? {};
      assertNoCapabilityCollision(extra, capabilities);
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
        effort,
        ...(systemPrompt === undefined ? {} : { systemPrompt }),
        spawn: hook,
        canUseTool,
        abort: inc.abort,
        capabilityTools: NORMA_CAPABILITY_TOOLS,
        capabilities: { ...extra, ...capabilities } as CapabilityServerRecord,
        ...(connection === undefined ? {} : { connection }),
        resume: inc.resume,
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
      try { await normaSessions(home).getSessionInfo(backendSessionId); return true; } catch { return false; }
    };

    const session = startWinterSession({
      sessionId, backendSessionId, mode, runtime,
      options: optionsFor,
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
      // P8b-39: the session log is the durable queue — what `open()` re-pushes is read from it.
      unconsumed: () => unconsumedUserMessages(deps.store.read(sessionId)),
      idleTimeoutMs: deps.idleTimeoutMs ?? (() => winterOptionsFromSettings(deps.settings()).idleTimeoutSec * 1000),
      ...(deps.endGraceMs === undefined ? {} : { endGraceMs: deps.endGraceMs }),
      log,
    });
    drivers.set(sessionId, session);
    return session;
  };

  const selectionFor = (mode: SessionMode, leg: SessionLeg, model: string | undefined, providerId: string, authFamily: RuntimeSelection["authFamily"]): RuntimeSelection => ({
    runtimeKind: "winter-agent",
    providerId,
    modelRef: model ?? "unknown",
    family: leg === "winter" ? "winter" : "legacy",
    authFamily,
    sdkVersion: leg === "winter" ? sdkVersion : "unknown",
    reason: leg === "winter"
      ? `created on the winter leg (settings.runtimes.winterLeg.${mode} is on)`
      : `created on the engine leg (settings.runtimes.winterLeg.${mode} is off)`,
    decidedAt: new Date().toISOString(),
  });

  const create = async (sessionId: string): Promise<WinterSession> => {
    const meta = deps.store.meta(sessionId);
    const mode = modeOf(meta.mode);
    // The executable was asserted by the caller BEFORE the product row was minted (`session.create`);
    // here only the spine is re-checked — the first `open()` re-resolves the hook anyway and
    // refuses typed if it went away in between.
    assertSpine();
    const records = deps.records!;
    const settings = deps.settings();
    const cwd = winterCwdOf(sessionId, meta.cwd);
    const backendSessionId = randomUUID();
    const transcriptKey = transcriptProjectKey(cwd);
    const credentials = await credentialPresenceFrom(deps.secrets);
    const selection = providerSelectionFor(meta.model, credentials);
    const providerId = selection?.providerId ?? settings?.provider?.type ?? "unstated";
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
        selection: selectionFor(mode, "winter", meta.model, providerId, authFamily),
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

  const recordEngineCreation = (sessionId: string): void => {
    const records = deps.records;
    if (records === undefined) return;
    try {
      if (records.get(sessionId) !== undefined) return;
      const meta = deps.store.meta(sessionId);
      const mode = modeOf(meta.mode);
      const settings = deps.settings();
      const cwd = meta.cwd ?? deps.home;   // = `migrations/backfill.ts`'s own fallback (N3)
      const transcriptKey = transcriptProjectKey(cwd);
      const providerId = settings?.provider?.type ?? "unstated";
      const authFamily: RuntimeSelection["authFamily"] = providerId === "openai-compatible" ? "api-key" : "custom";
      records.create({
        winterSessionId: sessionId,
        runtimeKind: "winter-agent",
        providerId,
        modelRef: meta.model ?? "unknown",
        backendRoot: join(deps.home, "projects", transcriptKey),
        transcriptProjectKey: transcriptKey,
        memoryProjectKey: deps.memoryKeyOf(cwd),
        tempProjectKey: transcriptKey,
        transcriptDialect: "claude-code-jsonl",
        transcriptHealth: "unsupported",
        compatibilityLevel: "conversation",
        conformanceCorpusVersion: "legacy",
        versionProvenance: "legacy-unknown",
        capabilities: ["import-conversation"],
        selection: selectionFor(mode, "engine", meta.model, providerId, authFamily),
      });
      records.transition(sessionId, "ready");
    } catch (err) {
      log(`engine-leg record for ${sessionId} not written (${err instanceof Error ? err.name : "unknown"}) — the boot backfill catches it up`);
    }
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
  const resume = async (sessionId: string): Promise<WinterSession> => {
    const record = recordOf(sessionId);
    if (sessionLegOf(record) !== "winter" || record?.backendSessionId === undefined) {
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

  return {
    legForNewSession: legForNew,
    legOf: (sessionId) => sessionLegOf(recordOf(sessionId)),
    assertAvailable,
    create,
    recordEngineCreation,
    get: (sessionId) => drivers.get(sessionId),
    async ensure(sessionId) {
      const live = drivers.get(sessionId);
      if (live !== undefined) return live;
      if (sessionLegOf(recordOf(sessionId)) !== "winter") return undefined;
      return resume(sessionId);   // synchronous up to `drivers.set` — see the invariant above
    },
    async runTurn(sessionId, text, clientName) {
      const session = drivers.get(sessionId) ?? (sessionLegOf(recordOf(sessionId)) === "winter" ? await resume(sessionId) : await create(sessionId));
      await session.send(text, clientName);
      await session.idle();
    },
    async evict(sessionId) {
      const session = drivers.get(sessionId);
      drivers.delete(sessionId);
      if (session === undefined) return;
      try { await session.end(); } catch (err) { log(`evicting ${sessionId}: end failed (${err instanceof Error ? err.name : "unknown"})`); }
    },
    list: () => [...drivers.values()],
    async endAll() {
      await Promise.all([...drivers.values()].map((s) => s.end().catch(() => {})));
    },
  };
}
