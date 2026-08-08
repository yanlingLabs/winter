import { z } from "zod";
// `SessionActivity` is defined in ./events (not here, where its first consumer `SessionListResult`
// lives): the `session_activity` EVENT variant needs the same enum, and events.ts cannot import
// from this file — methods.ts already imports from events.ts, so the reverse edge would be a module
// cycle whose `z.enum(...)` const would be in the TDZ at events.ts's evaluation. Re-exported by the
// package index either way, so `@norma/protocol` consumers see no difference.
import { SessionEvent, SessionActivity, TaskSchema, PeripheralClassSchema, HolderSchema, ApprovalOption, PanelTabKind } from "./events";

export const PROTOCOL_VERSION = 0;

/** An absolute directory path that is not the filesystem root (guards against a whole-fs writable fence). */
export const AbsoluteDirPath = z.string().startsWith("/").refine((p) => p !== "/", { message: "path must not be the filesystem root '/'" });

export const Role = z.enum(["harness", "plugin", "admin", "remote"]);
export type Role = z.infer<typeof Role>;

export const ApprovalPolicy = z.enum(["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"]);
export type ApprovalPolicy = z.infer<typeof ApprovalPolicy>;

export const HelloParams = z.object({
  protocolVersion: z.number().int(),
  role: Role,
  token: z.string().min(1),
  clientName: z.string().min(1),
  // Phase 4b Task 2 (spec §3): role "plugin" is id-bound (a plugin authenticates AS a specific
  // installed plugin id, not just "any plugin"). Verification is sqlite-hashed and lives outside
  // TokenAuthority — ipc/server.ts routes role "plugin" through SessionStore.verifyPluginToken
  // instead; a missing pluginId (or one with no minted/matching token) fails closed.
  pluginId: z.string().min(1).optional(),
});
export const HelloResult = z.object({
  ok: z.literal(true),
  serverVersion: z.string(),
  protocolVersion: z.number().int(),
});

/** The phone transport's hard per-frame ceiling, mirroring Swift's `maxFrameBytes` default
 *  (`IrohListener.swift` / `IrohDialer.swift`). An oversized frame does NOT produce an error — the
 *  connection's inbound stream simply ENDS — so every phone-reachable request and response has to
 *  fit under it by construction, not by hope. Declared here so the TS side can size its own bounds
 *  against the real number instead of against the local Unix socket's much larger 8 MiB line cap
 *  (`LineDecoder`'s authed default), which is the wrong transport for anything the phone calls. */
export const IROH_MAX_FRAME_BYTES = 1 << 20;

/** Hard ceiling on a session's stored (index) title, in characters.
 *
 *  Every DAEMON-side writer is already far below it — `SessionTitler` slices to 60 chars and
 *  `fallbackTitle` truncates at 60 — but `sync.push` made the title remote-settable on two new
 *  paths (`meta.title`, and a replicated `session_titled` event), and BOTH `session.list` and
 *  `sync.heads` return every session's title in ONE unpaged response. Without a bound, two
 *  sessions carrying ~600 KiB titles would push every such response past `IROH_MAX_FRAME_BYTES`
 *  above — a PERSISTENT phone-connection kill: the value lives in `index.db` so it survives daemon
 *  and app restarts, and `sync.heads`, the call a client would need to diagnose or repair the
 *  state, is itself one of the broken ones. This is the write-path twin of the hazard CLAUDE.md
 *  names for `session.history` ("an unbounded field is a silent connection-killer").
 *
 *  200 rather than 60: comfortably above every existing writer (so no current behavior changes)
 *  and small enough that the title contribution to an unpaged list stays negligible. */
export const SESSION_TITLE_MAX_CHARS = 200;

/** Chat Slice D task 1 review (M2), landed in the whole-branch fix round: the same unbounded-field
 *  hazard as `SESSION_TITLE_MAX_CHARS`, one column over. `model` is remote-settable on three
 *  ingress paths (`session.create`, `session.setModel`, `sync.push`'s `meta`) and rides EVERY
 *  `session.list`/`sync.heads` row, both unpaged. When the provider cannot enumerate its catalogue
 *  the daemon deliberately stores an unrecognized slug rather than refusing it — correct for a
 *  BYO-endpoint deployment, but it means nothing else bounds the value. A multi-megabyte "model"
 *  would then make every subsequent list response exceed the phone transport's frame limit
 *  (`WireError.oversize`), permanently and across restarts, with the repair calls among the broken
 *  ones. Bounded at the SCHEMA, so every ingress inherits it without remembering to.
 *
 *  200 for the same reason the title cap is: far above every real slug (the longest today is under
 *  40 characters), far below anything that could bloat a row. */
export const SESSION_MODEL_MAX_CHARS = 200;

/** provider-correctness T4: the same unbounded-field hazard `SESSION_MODEL_MAX_CHARS` documents,
 *  one column over — a per-session `effort` rides every `session.list` row, unpaged and
 *  remote-reachable, exactly like `model`.
 *
 *  Belt-and-braces rather than the primary guard, and the difference from `model` is worth stating:
 *  a provider that cannot enumerate its catalogue makes `session.setModel` store an unrecognized
 *  slug VERBATIM (correct for a BYO endpoint), so for `model` the schema cap really is the only
 *  bound. Effort has no such escape hatch — `session.setEffort`'s handler refuses anything outside
 *  the effort list of the session's own model, a closed set of short slugs. The cap lives here
 *  anyway so the bound is structural at the SCHEMA and survives any future relaxation of that
 *  membership check, for exactly the reason the model cap does.
 *
 *  32 for the same reason 200 is: far above every real slug (the longest today is "medium", six
 *  characters), far below anything that could bloat a row. */
export const SESSION_EFFORT_MAX_CHARS = 32;

/** Chat Slice D task 2 (session sync): where a session was branched from — the parent session's id
 *  plus the seq it was forked AT (every parent event with `seq <= atSeq` is shared history). Index-
 *  only metadata carried by `sync.push`'s `meta` and reported by `sync.heads`/`session.list`; it
 *  does NOT ride the event log, so it resets to absent on a full index rebuild, same as
 *  `cwd`/`model` (see `SessionRow` in packages/core/src/sessions/store.ts). */
export const SessionForkRef = z.object({
  sessionId: z.string().min(1),
  atSeq: z.number().int().nonnegative(),
});

// working-directories T3 (design doc §1): one entry in a session's ordered working-directory set —
// mirrors `SessionDir`/`SessionDirs` (core's sessions/dirs.ts) field-for-field. `dirs[0]` is the
// PRIMARY by POSITION, not a flag. Shared by `SessionListResult`'s per-row `dirs` (the read half,
// below) and `SessionSetDirsResult` (the write half's echo, defined further down beside
// `session.setDirs`'s params) — one schema, so the two surfaces can never describe an entry
// differently. Declared here (ahead of `SessionListResult`) rather than beside `SessionSetDirsParams`
// because these are plain `const`s evaluated in file order — a forward reference would be a TDZ
// throw at module load, not a type error.
export const SessionDirEntry = z.object({ path: z.string(), locked: z.boolean() });

export const SessionCreateParams = z.object({
  scope: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,39}[a-z0-9])?$/), // slug: no leading/trailing hyphen, ≤41 chars
  cwd: AbsoluteDirPath.optional(),        // absolute path (not '/'); session working directory for tools
  approvalPolicy: ApprovalPolicy.default("ask"),
  // Phase 5 routines T3 (design doc §3): a machine-readable "who/what created this session" tag —
  // routines/runner.ts's runHeadless stamps `routine/<id>` here (ALONGSIDE the session-title stamp
  // T2 already ships as a documented fallback — see that file's own doc comment: the title is
  // user-visible, this field is the machine-readable record, and neither is ever overwritten by
  // the other). Additive/optional so every existing caller (CLI, NormaKit) that never sends it is
  // unaffected — SessionStore.createSession defaults it to `undefined`/NULL on the row.
  origin: z.string().min(1).optional(),
  // Dispatch (Phase 7): "code" (default) | "dispatch". The handler REJECTS "dispatch" — the
  // singleton is minted only by session.dispatch. Accepted here so the wire shape documents the
  // axis; passing "code" is a no-op.
  // Chat Mode Slice A: "chat" added — additive, NOT a singleton (many chat sessions may exist).
  // The handler rejects it for remote callers only (Mac-local for this slice).
  mode: z.enum(["code", "dispatch", "chat"]).optional(),
  // Chat Slice D Task 1: an optional per-session model override, stamped at creation time —
  // additive/optional so every existing caller (CLI, NormaKit, the phone) that never sends it is
  // unaffected. Index-only metadata (like `cwd`/`approvalPolicy`, NOT `mode` — see
  // `SessionRow.model`'s own doc comment in store.ts), so it does NOT ride the `session_created`
  // event and resets to absent on a full index rebuild. Bounded — see SESSION_MODEL_MAX_CHARS.
  model: z.string().min(1).max(SESSION_MODEL_MAX_CHARS).optional(),
  // provider-correctness T6: the effort half of `model` just above, stamped at creation time and
  // validated by the SAME rules `session.setEffort` applies (model-aware membership against
  // `effortsForModel`, plus the code-sessions-only gate for a Norma-level tier). Added rather than
  // left to a create-then-setEffort pair because the phone's New Chat flow sets model AND effort at
  // create time on a latency-critical path: two round-trips leave a window in which a turn fired
  // immediately after create resolves at the GLOBAL effort, silently. Index-only metadata like
  // `model` — it does not ride `session_created` and resets to absent on a full index rebuild.
  // Bounded — see SESSION_EFFORT_MAX_CHARS.
  effort: z.string().min(1).max(SESSION_EFFORT_MAX_CHARS).optional(),
});
export const SessionCreateResult = z.object({ sessionId: z.string(), trusted: z.boolean() });

export const SessionListResult = z.object({
  sessions: z.array(z.object({
    sessionId: z.string(),
    scope: z.string(),
    createdAt: z.number().int(),
    lastSeq: z.number().int().nonnegative(),
    // Session history: the session's human title (session_titled's title or
    // the daemon's first-message fallback). Values already flow from store.list(); this declares them
    // so a schema-validating client (the phone's SessionSummary) reads them without smuggling.
    title: z.string().optional(),
    // session-activity-hygiene T9: the session's working directory — round-trips SessionRow.cwd
    // (store.ts), which `store.list()` has always selected and this handler has always returned
    // verbatim. DECLARED here rather than left to smuggle through undeclared, for exactly the reason
    // `title`/`forkedFrom` above are: the value really does flow out of `store.list()`, so a
    // schema-validating client must be able to read it. It could not — a zod object strips every key
    // it does not name, so the TS client (packages/cli/src/client.ts `validated()`) silently dropped
    // a field the daemon was already putting on the socket, while Swift's `NormaClient.listSessions()`
    // (which reads raw JSON, not a schema) has been consuming `s["cwd"]` all along. This declaration
    // closes that asymmetry; `norma agents`' cwd column is its first schema-validating consumer.
    //
    // Optional and index-only, on `origin`'s exact terms: absent means "no recorded cwd" — a session
    // created without one, or one whose index was rebuilt (cwd does NOT ride the event log, so a full
    // index.db rebuild resets it, same class as `origin`/`model`/`effort`). Never fabricated.
    cwd: z.string().optional(),
    // working-directories T3 (design doc §1): the session's ordered working-directory set — the
    // read half of `session.setDirs` (T2's domain setter). `dirs[0]` is the PRIMARY by POSITION,
    // and `cwd` just above is kept an ALIAS of it: the daemon populates BOTH from the same read at
    // `session.list` time (`cwd: dirs[0]?.path`, ipc/server.ts) rather than trusting the separately
    // stored `cwd` column to stay in sync — `setDirsRaw` (store.ts) deliberately does NOT touch that
    // column, so once a session's dirs have been written through `session.setDirs`, only this
    // populate-time alias keeps the two fields agreeing. Absent for chat/dispatch — those modes have
    // no writable root at all (DIRS_MODE_REFUSAL), the same participation gate `activity` below uses.
    dirs: z.array(SessionDirEntry).optional(),
    // Additive (phase 5 routines T3): round-trips SessionCreateParams.origin — undefined for
    // every session created before this field existed, or created without one.
    origin: z.string().optional(),
    mode: z.string().optional(),            // "dispatch" for the singleton; absent = code
    parentSessionId: z.string().optional(), // set on dispatch children
    // Chat Slice D Task 1: round-trips SessionRow.model (store.ts) — absent for every session
    // created before this field existed, or created/left without an explicit override.
    model: z.string().optional(),
    // provider-correctness T4: round-trips SessionRow.effort (store.ts), the per-session reasoning
    // effort `session.setEffort` writes. Declared alongside `model` for the same reason `title` and
    // `forkedFrom` are — the value really does flow out of `store.list()`, so a schema-validating
    // client must be able to read it. Absent means "this session uses the global default", never
    // "no effort" (an unset effort omits the provider's `reasoning` block entirely; `"none"` is a
    // distinct, real, measured level — see REASONING_EFFORTS in core's settings.ts).
    // provider-correctness T5: the value may ALSO be a Norma-level tier from
    // `sync.config.clientEfforts` (e.g. "ultra") — the user's SELECTION is stored and reported
    // verbatim, never rewritten to its wire translation. A picker matching this against the
    // chosen model's `efforts` array alone will miss; match against BOTH lists.
    effort: z.string().optional(),
    // Chat Slice D Task 2: round-trips SessionRow.forkedFrom (store.ts). Declared here — rather
    // than left to smuggle through undeclared — for the same reason `title` above is: the value
    // really does flow out of `store.list()`, so a schema-validating client must be able to read
    // it. Absent for every session that isn't a fork.
    forkedFrom: SessionForkRef.optional(),
    // session-activity-hygiene T2 (spec §1): the DERIVED lifecycle state — see `SessionActivity`
    // above. Unlike every other field on this row it is not a stored column read back verbatim: the
    // daemon computes it per row at list time from the two stored flags plus live signals, so two
    // calls a second apart legitimately differ. Absent means "does not participate" (chat/dispatch)
    // — NOT "idle", and not "old daemon" for any daemon at or past this version.
    activity: SessionActivity.optional(),
  })),
});

export const SessionAttachParams = z.object({
  sessionId: z.string(),
  fromSeq: z.number().int().nonnegative().optional().default(0),
});
export const SessionAttachResult = z.object({ ok: z.literal(true), lastSeq: z.number().int().nonnegative() });

// Session history: a paged, allowlisted, byte-budgeted read of past
// SessionEvents so a reconnecting/never-attached client can render history without an unbounded
// attach replay. beforeSeq is an EXCLUSIVE upper bound (paging: pass the previous page's oldestSeq);
// omitted = from newest. limit defaults to 200 server-side (packages/core/src/sessions/history.ts).
export const SessionHistoryParams = z.object({
  sessionId: z.string(),
  beforeSeq: z.number().int().positive().optional(), // EXCLUSIVE upper bound; omitted = from newest
  limit: z.number().int().positive().max(500).optional(), // default 200 (server-side)
});
export const SessionHistoryResult = z.object({
  events: z.array(SessionEvent),         // ascending seq; live-stream envelopes verbatim (post filter/truncation)
  hasMore: z.boolean(),                  // true iff an allowlisted event older than the page remains
  oldestSeq: z.number().int().nullable(), // seq of events[0]; null iff events is empty
});

export const SessionSendParams = z.object({
  sessionId: z.string(),
  text: z.string().min(1),
});
export const SessionSendResult = z.object({ seq: z.number().int() });

/** Dispatch (Phase 7): get-or-create the ONE permanent dispatch session. No params. */
export const SessionDispatchParams = z.object({});
export const SessionDispatchResult = z.object({ sessionId: z.string(), created: z.boolean() });

export const ApprovalRespondParams = z.object({
  sessionId: z.string(),
  callId: z.string().min(1),
  approved: z.boolean(),
  // SP-approvals T4: which `ApprovalOption` (events.ts) the caller chose, by `id` — Task 5's
  // respond handler looks up the pending approval's stored options by this id and, if it names a
  // rule-bearing option AND `approved` is true, persists that rule. Optional/additive: a plain
  // approve/deny (no options offered, or a client that predates this field) omits it and behaves
  // exactly as before — no rule is ever persisted without an explicit optionId.
  optionId: z.string().optional(),
});
export const ApprovalRespondResult = z.object({ ok: z.literal(true), alreadyResolved: z.boolean() });

/** SP3 T4b: queryable pending-approval STATE (the report's approval contract — pending approvals
 *  age out of the event stream, so a reconnecting phone can't reconstruct them from replay alone).
 *  Mirrors `ApprovalBroker.list()` (core/src/agent/approvals.ts) field-for-field. `callId` IS the
 *  approval identity + compare-and-set token for the subsequent `approval.respond` — there is NO
 *  numeric `version` field (callId + `approval.respond`'s `alreadyResolved` subsumes the report's
 *  `expectedVersion`, see that broker's doc comment). `expiresAt` (epoch ms) is the fail-closed
 *  deadline, so a phone renders "expires in Ns" and derives `.expired` without the resolve event. */
export const ApprovalListParams = z.object({ sessionId: z.string().min(1) });
export const PendingApprovalSchema = z.object({
  callId: z.string().min(1),
  toolName: z.string(),
  summary: z.string(),
  issuedAt: z.number().int(),
  expiresAt: z.number().int(),
  // SP-approvals T4: mirrors ApprovalRequestedEvent.options field-for-field (same
  // ApprovalBroker-stored meta backs both) — see that field's own doc comment in events.ts.
  options: z.array(ApprovalOption).optional(),
});
export const ApprovalListResult = z.object({ pending: z.array(PendingApprovalSchema) });

export const SessionAddDirParams = z.object({
  sessionId: z.string(),
  path: z.string().min(1),
  persist: z.boolean().default(false),
});
export const SessionAddDirResult = z.object({ ok: z.literal(true), roots: z.array(z.string()) });
export const SessionSetCwdParams = z.object({ sessionId: z.string(), cwd: AbsoluteDirPath });
export const SessionSetCwdResult = z.object({ ok: z.literal(true), cwd: z.string() });

export const TrustDirParams = z.object({ path: AbsoluteDirPath });
export const TrustDirResult = z.object({ ok: z.literal(true), trusted: z.literal(true) });

/** Server → client notification: method "event", params = SessionEvent. */
export const EventNotificationParams = SessionEvent;

export const BgTaskSummary = z.object({ taskId: z.string(), command: z.string(), status: z.string(), exitCode: z.number().int().nullable(), startedAt: z.number() });
export const BgListParams = z.object({ sessionId: z.string() });
export const BgListResult = z.object({ tasks: z.array(BgTaskSummary) });
export const BgPeekParams = z.object({ sessionId: z.string(), taskId: z.string().min(1) });
export const BgPeekResult = z.object({ chunk: z.string(), status: z.string(), exitCode: z.number().int().nullable() });
export const BgKillParams = z.object({ sessionId: z.string(), taskId: z.string().min(1) });
export const BgKillResult = z.object({ ok: z.literal(true) });
export const BgKillAllParams = z.object({ sessionId: z.string() });
export const BgKillAllResult = z.object({ ok: z.literal(true), killed: z.number().int().nonnegative() });

export const SessionSteerParams = z.object({ sessionId: z.string(), text: z.string().min(1) });
export const SessionSteerResult = z.object({ ok: z.literal(true), injected: z.boolean() });
export const SessionInterruptParams = z.object({ sessionId: z.string() });
export const SessionInterruptResult = z.object({ ok: z.literal(true), wasRunning: z.boolean() });

export const SessionCompactParams = z.object({ sessionId: z.string().min(1) });
export const SessionCompactResult = z.object({
  ok: z.literal(true),
  compacted: z.boolean(),
  uptoSeq: z.number().int().nonnegative(),
  summaryChars: z.number().int().nonnegative(),
});

/** Mirrors `SkillMeta` (core/src/agent/skills.ts) field-for-field — this schema drifting behind
 *  that interface is a LIVE break, not cosmetic: the CLI's `listSkills` (cli/src/client.ts)
 *  validates every `skills.list` response through `SkillsListResult.safeParse` and throws on
 *  failure, and `z.array()` fails the whole array on one bad element. Phase 5c T1's always-present
 *  `writing-skills` builtin did exactly that (`source:"builtin"` wasn't in this enum), breaking
 *  `norma skills` on every invocation until the 5c T3 review fix admitted it here. */
export const SkillMetaSchema = z.object({
  name: z.string(),
  description: z.string(),
  source: z.enum(["project", "user", "self", "plugin", "builtin"]),
  path: z.string(),
  // Set only on claude-format plugin skills (SkillStore.discover, agent/skills.ts) — omitted
  // (never false) otherwise.
  claudeFormat: z.boolean().optional(),
  // Phase 5c Task 3: mirrors SkillStore's `author?` (agent/skills.ts) — set for a self-authored
  // skill (T1 stamps `author: norma` in the frontmatter, T3's list()/load() parse it back out),
  // undefined for every other source. Additive/optional: an older server that never sends it still
  // parses.
  author: z.string().optional(),
});
export const SkillsListParams = z.object({ cwd: z.string().optional() });
export const SkillsListResult = z.object({ ok: z.literal(true), skills: z.array(SkillMetaSchema) });

// ---------------------------------------------------------------------------------------------
// Skills read/write/delete (Phase 5c Task 3, spec: self-authored skills) — the management surface
// over the daemon's `SkillStore` (core/src/agent/skills.ts), same precedent as the memory.* block
// below (5b Task 3): a store `ok:false` becomes a thrown RpcFailure (never a typed result union),
// mapped from the store's structural `kind` by ipc/server.ts's `skillErrorCode` — the SAME
// structural switch as `memoryErrorCode`, over `SkillResult.kind` instead of `MemoryResult.kind`.
//
// Unlike memory.*, there is no `scope` param to abuse: `skills.write`/`skills.delete` are confined
// SERVER-SIDE to `SkillStore.writeSelf`/`deleteSelf` — a caller can never write/delete a
// project/user/plugin/builtin skill through this RPC, only ever its own self-authored one.
// `skills.read`, by contrast, reads ANY source by the store's normal precedence (project > user >
// self > plugin > builtin) — same `{name, cwd?}` shape as `skills.list`'s per-name lookup would be.
// ---------------------------------------------------------------------------------------------

export const SkillsReadParams = z.object({ name: z.string().min(1), cwd: z.string().optional() });
/** Mirrors `MemoryReadResult`'s `{fact}` pattern: `SkillMetaSchema` plus the full body. */
export const SkillsReadResult = z.object({ skill: SkillMetaSchema.extend({ body: z.string() }) });

/** No `cwd`/scope: `writeSelf` always targets `~/.norma/skills/self`, independent of caller cwd. */
export const SkillsWriteParams = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  body: z.string().min(1),
});
export const SkillsWriteResult = z.object({});

/** No `cwd`: same self-confinement as `skills.write` — the store resolves the name against ALL
 *  sources only to check the "must be self" precondition (ipc/server.ts), never to gate deletion
 *  itself. */
export const SkillsDeleteParams = z.object({ name: z.string().min(1) });
export const SkillsDeleteResult = z.object({});

export const McpServerStatusSchema = z.object({
  name: z.string(),
  status: z.enum(["connected", "failed"]),
  toolNames: z.array(z.string()),
  source: z.enum(["user", "project", "plugin"]),
});
export const McpListParams = z.object({ cwd: z.string().optional() });
export const McpListResult = z.object({ ok: z.literal(true), servers: z.array(McpServerStatusSchema) });

/** The `SupervisorStatus` union (core/plugins/supervisor.ts) plus `"na"` for Tier-1/legacy plugins
 *  that never run a process — shared by `PluginInfoSchema.status` (below) and, from Phase 4d-ii
 *  Task 2, `plugin.enable`'s result, which reports the SAME status right after its hot-apply
 *  start (factored out here so the two can't drift apart). */
export const PluginRuntimeStatusSchema = z.enum(["starting", "running", "backoff", "circuit-open", "stopped", "na"]);

export const PluginInfoSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  version: z.string().optional(),
  skills: z.array(z.string()),
  hasMcp: z.boolean(),
  mcpEnabled: z.boolean(),
  disabled: z.boolean(),
  // Phase 4a Task 3 additions — carried so the CLI's consent flow (norma plugin enable/list) can
  // render tier + consent state + the full exec-payload disclosure without a second round trip.
  // All optional so older-shaped fixtures/servers still parse (see methods.test.ts).
  tier: z.enum(["capability", "platform"]).optional(),
  requiredConsents: z.array(z.string()).optional(),
  consented: z.array(z.string()).optional(),
  legacy: z.boolean().optional(),
  /** Verbatim exec-payload disclosure lines (plugin-manifest.ts#execPayloadLines) — spec §1:
   *  "Consent text always shows the exec payload ... never just a summary." */
  execPayload: z.array(z.string()).optional(),
  /** manifest.permissions.tcc verbatim, for the "will request macOS permission: <each>" lines. */
  tccPermissions: z.array(z.string()).optional(),
  /** manifest.permissions.hardware verbatim, for the "hardware access via Norma.app helper: <each>" lines. */
  hardwarePermissions: z.array(z.string()).optional(),
  /** Phase 4d-i Task 4: live PluginSupervisor runtime status for Tier-2 (`platform`,
   *  pluginSpawnEligible) plugins — the SAME `SupervisorStatus` the supervisor tracks
   *  (supervisor.ts), surfaced here so a dashboard can tell running/crashed/circuit-open apart
   *  from static manifest/consent data. `"na"` for Tier-1 (`capability`) plugins and legacy
   *  plugins, which never run a process and so have no supervisor status to report. Optional so
   *  older-shaped fixtures/servers still parse, same precedent as the Phase 4a Task 3 fields above. */
  status: PluginRuntimeStatusSchema.optional(),
});
export const PluginsListParams = z.object({});
export const PluginsListResult = z.object({ ok: z.literal(true), plugins: z.array(PluginInfoSchema) });

export const AskUserRespondParams = z.object({
  sessionId: z.string().min(1), callId: z.string().min(1), answers: z.record(z.string(), z.string()),
  // CC AskUserQuestion parity: optional per-question notes (mirrors QuestionResolvedEvent.notes,
  // events.ts), keyed by question text like `answers`. Additive — older callers omitting it
  // still parse.
  notes: z.record(z.string(), z.string()).optional(),
});
export const AskUserRespondResult = z.object({ ok: z.literal(true), alreadyResolved: z.boolean() });

export const TaskListParams = z.object({ sessionId: z.string().min(1) });
export const TaskListResult = z.object({ ok: z.literal(true), tasks: z.array(TaskSchema) });

export const PlanRespondParams = z.object({
  sessionId: z.string().min(1), callId: z.string().min(1), approved: z.boolean(),
  feedback: z.string().optional(), autoAccept: z.boolean().default(false),
});
export const PlanRespondResult = z.object({ ok: z.literal(true), alreadyResolved: z.boolean() });

export const SessionSetPolicyParams = z.object({ sessionId: z.string().min(1), policy: ApprovalPolicy });
export const SessionSetPolicyResult = z.object({ ok: z.literal(true) });

// Chat Slice D Task 1: per-session model override, mode-agnostic — unlike session.setPolicy
// (chat rejects EVERY value, plan-immunity's fixed policy), session.setModel works identically
// for code/dispatch/chat: there is no "fixed model" concept for any mode. `model: null` CLEARS the
// override (falls back to the live/boot default — AgentEngine.resolveSel) rather than being
// omittable — the field is required-but-nullable so a caller can't confuse "didn't send it" with
// "explicitly clearing it". Result mirrors skills.write's bare-`{}` idiom (nothing to report beyond
// success — a thrown RpcFailure is how the daemon reports an unknown sessionId, same NOT_FOUND
// precedent as session.setPolicy).
export const SessionSetModelParams = z.object({ sessionId: z.string().min(1), model: z.string().min(1).max(SESSION_MODEL_MAX_CHARS).nullable() });
export const SessionSetModelResult = z.object({});

// provider-correctness T4 (spec Component 4): per-session reasoning effort. Its OWN method rather
// than a second argument on `session.setModel` — the user's call, verbatim: "effort and model are
// two different things, just like the CLI", where `norma model <slug>` and `norma model --effort
// <level>` are separate controls over separate axes. Everything else mirrors `session.setModel`
// above: mode-agnostic (there is no "fixed effort" concept for any mode, unlike session.setPolicy's
// chat rule), `effort: null` CLEARS the override so the next resolution falls back to the global
// default (`settings.provider.reasoningEffort` — AgentEngine.resolveSel), required-but-nullable
// rather than optional so a caller can't confuse "didn't send it" with "explicitly clearing it",
// and a bare-`{}` result with an unknown sessionId reported as a thrown NOT_FOUND.
//
// The VALUE is deliberately NOT enumerated here. Which efforts a model accepts is provider
// knowledge — the API validates effort PER-MODEL (`minimal` is refused with an `unsupported_value`
// naming the slug, by a different layer than the global enum that refuses `ultra`) — so the daemon
// checks membership at set time against the session's own model's list (ipc/server.ts, reading
// core's `effortsForModel`, the SAME list `sync.config` advertises to the phone). A zod enum here
// would be a second, drift-prone copy of a set the protocol package cannot see change.
export const SessionSetEffortParams = z.object({ sessionId: z.string().min(1), effort: z.string().min(1).max(SESSION_EFFORT_MAX_CHARS).nullable() });
export const SessionSetEffortResult = z.object({});

// session-activity-hygiene T3 (spec §1): the WRITE half of the session lifecycle — `session.list`'s
// derived `activity` (T2) is the read half. ONE method behind every surface that moves a session's
// state: the TUI's `/background` and `/archive`, dispatch's management verbs (T8), the `norma
// agents` TUI (T9), and the phone (which is why it joins the remote allowlist — 19 → 20).
//
// The VALUE NAMES A TARGET STATE, not a flag, and only the two STORED states are settable —
// `active` and `idle` are pure consequences of live signals (an attachment, a running turn), so
// offering them would be offering a write that cannot be honoured.
//
// activity-verb-semantics: FOUR values, one per stored bit in each direction. `"background"` and
// `"archived"` SET their bit; `"unbackground"` clears the background bit; `null` — RESUME — clears
// the ARCHIVE bit. Each clear touches exactly one flag, which is what lets an archived background
// worker be resumed BACK INTO background rather than into a state nobody asked for. `null` is
// required-but-nullable, not optional, for the same reason `session.setModel`/`session.setEffort`'s
// clears are — a caller must never be able to confuse "didn't send it" with "explicitly clearing".
//
// ARCHIVED IS IMMUTABLE EXCEPT THROUGH RESUME (the ruling that replaced T3's "background is a
// target state, so it un-archives"). On a session whose archive flag is set, `"background"` and
// `"unbackground"` are REFUSED and name the remedy; `"archived"` is an idempotent success; `null`
// is the one door out. A verb that silently un-hid what the user hid would be exactly the
// invisible-resurrection `send_message`'s own archived guard already refuses, spelled differently.
// Resume matches resume-by-opening: `session.attach` has always cleared only the archive flag.
//
// Refusals, all daemon-side (sessions/set-activity.ts, behind ipc/server.ts): an unknown session is
// `NOT_FOUND` and takes precedence over everything below it; a chat/dispatch target is
// `INVALID_PARAMS` ("activity states apply to code and cowork sessions only" — those modes have no
// lifecycle at all, T2's participation allowlist); `"background"`/`"unbackground"` on an ARCHIVED
// session is `INVALID_PARAMS` ("session is archived — resume it first"); `"archived"` on a session
// with a RUNNING TURN is `INVALID_PARAMS` ("stop or background it first"), because archived is a
// flag over IDLE (spec §1.4) and archiving a live turn would strand it behind a hidden tab.
// PHONE DEBT (activity-verb-semantics, owed at the next kit bump): the iOS companion consumes this
// method through NormaKit's Gateway allowlist and has NOT been updated. It owes BOTH halves — the
// widened `activity` param (`"unbackground"` is new; the result shape is unchanged, so nothing
// breaks on the wire today) AND the changed SEMANTICS of what it already sends: `null` no longer
// clears both flags, it is RESUME (archive bit only), so a phone control that sends `null` to
// un-background is now writing a resume; and `"background"` on an archived session no longer
// un-archives it, it is REFUSED ("session is archived — resume it first").
export const SessionSetActivityParams = z.object({
  sessionId: z.string().min(1),
  activity: z.enum(["background", "archived", "unbackground"]).nullable(),
});
/** `activity` is the POST-WRITE DERIVED state, not an echo of what was written — a caller learns
 *  what its write actually produced without a second `session.list` round trip (clearing a session
 *  whose detached bash task is still writing reads back `"background"`, not `"idle"`). Optional for
 *  exactly the reason `SessionSummary.activity` is: absence means "does not participate". No
 *  successful call can currently produce that (a non-participating target is refused above), so the
 *  field is present in practice — it stays optional so the two surfaces express absence identically
 *  and a future participating-mode change has one vocabulary, not two. */
export const SessionSetActivityResult = z.object({ ok: z.literal(true), activity: SessionActivity.optional() });

// working-directories T3: params for the one write door onto a session's working-directory set
// (`setSessionDirs`, core's sessions/set-dirs.ts, T2's domain setter). `op` is the three mutations
// the setter supports — no "clear"/"remove all" (see that module's own doc comment for why).
// `path` is `AbsoluteDirPath`, the SAME bound `session.setCwd`'s `cwd` uses above: a relative path
// is refused HERE with a clean INVALID_PARAMS, rather than reaching the setter's own
// `canonicalizeDirPath` (which throws on a relative path) and surfacing as an undifferentiated
// ERR.INTERNAL.
export const SessionSetDirsParams = z.object({
  sessionId: z.string().min(1),
  op: z.enum(["setPrimary", "add", "remove"]),
  path: AbsoluteDirPath,
});
/** `dirs` is the POST-WRITE state, not an echo of what was sent — mirrors
 *  `SessionSetActivityResult.activity`'s own "report what the write actually produced" contract. */
export const SessionSetDirsResult = z.object({ ok: z.literal(true), dirs: z.array(SessionDirEntry) });

export const ThreadInfoSchema = z.object({
  threadId: z.string(), parentThreadId: z.string().optional(), agentType: z.string().optional(),
  status: z.enum(["running", "completed"]), stopReason: z.string().optional(),
});
export const ThreadListParams = z.object({ sessionId: z.string().min(1) });
export const ThreadListResult = z.object({ ok: z.literal(true), threads: z.array(ThreadInfoSchema) });

// ---------------------------------------------------------------------------------------------
// Live child-transcript view T1 (design doc 2026-07-15-child-transcript-view-design.md, "Wire"):
// two new harness-reachable RPCs over primitives the engine already had for the MODEL (the
// send_message tool bridge / task_stop tool) — now reachable from a live UI so a user can message
// or stop a running/finished background subagent directly, not just watch it. Both mirror those
// bridges' exact resolve+dispatch logic (AgentEngine.sendToAgent/stopAgent, core/src/agent/
// engine.ts) rather than duplicating it — see bg-agent-registry.ts's `guardAgentName` helper,
// shared by all four call sites (the two tool bridges + these two RPCs' engine methods). No new
// SessionEvent — the child's own events (assistant_message/tool_call/tool_result/user_message) are
// already visible over session.attach; this just adds the two missing WRITE paths.
// ---------------------------------------------------------------------------------------------

export const ThreadSendParams = z.object({ sessionId: z.string(), agent: z.string().min(1), text: z.string().min(1) });
/** `delivered`: `"queued"` — `agent` was RUNNING; `text` landed in its steer queue (drained at its
 *  next round boundary — the running-target half `session.steer` already uses for the main
 *  thread, `AgentEngine.sendToThread` for a child). `"resumed"` — `agent` was TERMINAL and was
 *  just re-run in the background with `text` as its new prompt (the SAME `resumeThread` a model's
 *  own send_message-to-a-finished-agent triggers, now user-initiated). `agentId` is always the
 *  STABLE bg-agent-registry id — never the possibly-transient `agent` the caller may have
 *  addressed by name — so a caller that sent by name can key its own state off something that
 *  never goes stale. */
export const ThreadSendResult = z.object({ ok: z.literal(true), delivered: z.enum(["queued", "resumed"]), agentId: z.string() });

export const AgentStopParams = z.object({ sessionId: z.string(), agent: z.string().min(1) });
/** Mirrors `BackgroundAgentRegistry.AgentStatus` (core/src/agent/bg-agent-registry.ts) field-for-
 *  field — kept as a separate literal here (protocol can't import from core) same precedent as
 *  `ThreadInfoSchema.status` above. Stopping an already-terminal agent is not an error (task_stop
 *  tool parity, CC SDK `stop_task`/`/tasks` `x` parity): `status` reports whatever it already was
 *  ("completed"/"failed"/"stopped"/"timeout"); a freshly-stopped RUNNING agent reports "stopped".
 *  `"running"` never appears in a response — a running agent is always flipped to "stopped" by
 *  this call, never left running. */
export const AgentStopResult = z.object({ ok: z.literal(true), status: z.enum(["running", "completed", "failed", "stopped", "timeout"]) });

// ---------------------------------------------------------------------------------------------
// Peripheral lease v1 (Phase 2f, spec §A2) + dashboard read methods (spec Part B).
// ---------------------------------------------------------------------------------------------

/** The 5-member reason union shared with `LeaseLostEvent` (events.ts) — kept as a separate
 *  literal here (rather than importing the event schema's inner shape) since zod object shapes
 *  don't expose their field schemas for reuse without reaching into `.shape`. */
const LeaseLostReasonSchema = z.enum(["expired", "released", "panic", "revoked", "provider-gone"]);

/** A `denied` result additionally carries an optional `reason` — used for the pinned
 *  `{code:"denied", reason:"plugin-leasing-not-yet-available"}` typed error (spec §A2 requester
 *  scope: sessions-only in v1) as well as the plain policy-denied case (`reason` omitted). */
const PeripheralDeniedSchema = z.object({ code: z.literal("denied"), reason: z.string().optional() });

export const PeripheralLeaseParams = z.object({ sessionId: z.string().min(1), class: PeripheralClassSchema });
export const PeripheralLeaseResult = z.union([
  z.object({ leaseId: z.string().min(1), token: z.string().min(1), expiresAt: z.number().int().nonnegative() }),
  z.object({ code: z.literal("lease_held"), holder: HolderSchema }),
  z.object({ code: z.literal("no_provider") }),
  PeripheralDeniedSchema,
]);

export const PeripheralRenewParams = z.object({ sessionId: z.string().min(1), leaseId: z.string().min(1), token: z.string().min(1) });
export const PeripheralRenewResult = z.union([
  z.object({ ok: z.literal(true), expiresAt: z.number().int().nonnegative() }),
  z.object({ code: z.literal("not_found") }),
  z.object({ code: z.literal("token_mismatch") }),
  // L1 fix: renew() now rejects a lease past its expiresAt but not yet swept, instead of
  // silently resurrecting it — see PeripheralBroker.renew()'s RenewError union in broker.ts.
  z.object({ code: z.literal("expired") }),
  PeripheralDeniedSchema,
]);

export const PeripheralReleaseParams = z.object({ sessionId: z.string().min(1), leaseId: z.string().min(1), token: z.string().min(1) });
export const PeripheralReleaseResult = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ code: z.literal("not_found") }),
  z.object({ code: z.literal("token_mismatch") }),
  PeripheralDeniedSchema,
]);

export const PeripheralAdvertiseParams = z.object({
  classes: z.array(z.object({ class: PeripheralClassSchema, tccGranted: z.boolean() })),
});
export const PeripheralAdvertiseResult = z.object({ ok: z.literal(true) });

export const PeripheralRevokeParams = z.object({
  leaseId: z.string().min(1).optional(),
  all: z.boolean().optional(),
  reason: LeaseLostReasonSchema,
});
export const PeripheralRevokeResult = z.object({ ok: z.literal(true), revoked: z.number().int().nonnegative() });

export const PeripheralRespondParams = z.object({
  requestId: z.string().min(1),
  resultJson: z.string().optional(),
  error: z.string().optional(),
});
export const PeripheralRespondResult = z.object({ ok: z.literal(true), alreadyResolved: z.boolean() });

export const DaemonStatusParams = z.object({});
export const DaemonStatusResult = z.object({
  version: z.string(),
  uptimeMs: z.number().int().nonnegative(),
  socketPath: z.string(),
  provider: z.object({ id: z.string(), model: z.string() }).nullable(),
  sessionsCount: z.number().int().nonnegative(),
  pluginsCount: z.number().int().nonnegative(),
});

// Sparkle T2: the update idle gate's poll — how many sessions have a turn executing right now
// (off AgentEngine.runningTurns). Engine-wide, not per-session: the gate only needs to know
// whether the DAEMON is idle before Sparkle is allowed to relaunch it.
export const EngineActivityParams = z.object({});
export const EngineActivityResult = z.object({
  activeTurns: z.number().int().nonnegative(),
});

export const QuotaStateParams = z.object({});
/** The FLAT merge of `QuotaManager.state()` ({kind:"ok"} | {kind:"limited", resumeAt}) and
 *  `.usage()` ({inputTokens, outputTokens}) — matches NormaKit's `quotaState()` wrapper
 *  field-for-field (apple/NormaKit/Sources/NormaKit/NormaClient+Methods.swift). */
export const QuotaStateResult = z.object({
  kind: z.enum(["ok", "limited"]),
  resumeAt: z.number().int().nonnegative().optional(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

export const TrustListParams = z.object({});
export const TrustListResult = z.object({ dirs: z.array(z.string()) });

export const TrustRemoveParams = z.object({ path: AbsoluteDirPath });
export const TrustRemoveResult = z.object({ removed: z.boolean() });

// ---------------------------------------------------------------------------------------------
// Plugin role verbs (Phase 4b Task 1, spec §3 "Tier-2 — supervisor + plugin role"). Wire shapes
// only here — the supervisor/registry wiring that makes these verbs DO something (ToolRegistry
// registration, contrib registries) is Task 3/4. Task 2 implements the role→methods allowlist
// (ipc/server.ts) covering EXACTLY these six verbs — a plugin connection may call these and
// nothing else; everything else, including the 2f peripheral.lease/renew/release verbs the spec
// text names as a plugin-facing cross-spec fix, is role-rejected. That's a deliberate narrowing
// of the spec's plugin-can-lease language for this task's scope (Task 2's contract fixes exactly
// these six) — widening the allowlist to admit peripheral leasing for plugins, if still wanted,
// is a follow-up decision for a later task, not implied by anything below.
// ---------------------------------------------------------------------------------------------

export const PluginRegisterParams = z.object({ pluginId: z.string().min(1) });
export const PluginRegisterResult = z.object({ ok: z.literal(true) });

/** Safe tool-name charset (final-review Fix 3): the wire `name` becomes the last segment of the
 *  namespaced tool `plugin__<pluginId>__<name>` (ipc/server.ts's `tool.register` handler), and
 *  `ToolRegistry.unregisterByPrefix("plugin__<id>__")` (agent/tools/registry.ts) matches by plain
 *  STRING PREFIX on that namespaced name. A `__` inside a tool name (or a pluginId — warned about
 *  separately at plugin load time, agent/plugin-manifest.ts#loadManifest) can make one plugin's
 *  registeredAs collide with a DIFFERENT plugin's unregister prefix, so a sibling plugin loses
 *  tools it never registered when the wrong plugin disconnects or its circuit trips. Alphanumeric
 *  plus single `-`/`_` separators only — no leading/trailing/double underscore, no other
 *  punctuation. */
const SAFE_TOOL_NAME = /^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/;

/** `parameters` is a raw JSON-schema-shaped record (mirrors ToolDef.rawParameters in
 *  agent/tools/registry.ts) — the plugin author supplies whatever `z.toJSONSchema` would've
 *  produced; core does not re-validate its shape beyond "is an object". Optional: a schema-less
 *  tool is still registrable (deferred-detail case — spec §3 "optionally deferred JSON schema"). */
export const ToolRegisterParams = z.object({
  name: z.string().min(1).regex(SAFE_TOOL_NAME, {
    message: "tool name must be alphanumeric with single - or _ separators (no leading/trailing/double underscore)",
  }),
  description: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()).optional(),
});
/** `registeredAs` is the namespaced tool name core assigns (`plugin__<pluginId>__<name>`, Task 4)
 *  — round-tripped to the plugin so its own logs/errors can reference the name the agent sees. */
export const ToolRegisterResult = z.object({ ok: z.literal(true), registeredAs: z.string().min(1) });

export const ShortcutRegisterParams = z.object({
  shortcuts: z.array(z.object({
    id: z.string().min(1),
    description: z.string().optional(),
    default: z.string().optional(), // default keybinding suggestion; user-set binding always wins (spec §6)
  })),
});
export const ShortcutRegisterResult = z.object({ ok: z.literal(true) });

/** Declarative tile schema is spec §6's `{title, value?, icon?, progress?, actions?}` — kept as an
 *  opaque record at the wire layer (like ToolRegisterParams.parameters) since core's job is
 *  latest-per-plugin storage + broadcast, not shape validation of plugin-supplied UI data. */
export const TileUpdateParams = z.object({ tile: z.record(z.string(), z.unknown()) });
export const TileUpdateResult = z.object({ ok: z.literal(true) });

/** Reserved-minimal (spec §3 `provider?: true` manifest flag): model-provider registration wiring
 *  is a later plugin's phase (the local-models plugin), not Phase 4b. `info` is opaque here. */
export const ProviderRegisterParams = z.object({ info: z.record(z.string(), z.unknown()) });
export const ProviderRegisterResult = z.object({ ok: z.literal(true) });

/** Phase 4d Task 1's read surface for `PluginContribRegistry` (core/src/plugins/contrib.ts):
 *  one entry per plugin with at least one contribution recorded, mirroring `PluginContribState`
 *  field-for-field. `shortcuts` reuses `ShortcutRegisterParams`'s own field schema rather than
 *  duplicating it (same shape a plugin actually sent). NOT a plugin-role verb (a plugin never
 *  needs to read the aggregate back over the wire) — ipc/server.ts's `PLUGIN_ALLOWED_METHODS`
 *  deliberately does not include it; harness/admin connections call it directly. */
export const PluginContribEntrySchema = z.object({
  pluginId: z.string(),
  shortcuts: ShortcutRegisterParams.shape.shortcuts.optional(),
  tile: z.record(z.string(), z.unknown()).optional(),
  provider: z.record(z.string(), z.unknown()).optional(),
});
export const PluginsContribParams = z.object({});
export const PluginsContribResult = z.object({ ok: z.literal(true), entries: z.array(PluginContribEntrySchema) });

/** A plugin's answer to a `plugin_tool_invoke` push (events.ts) — the PluginSupervisor's
 *  request/response correlation (Task 3), mirroring `PeripheralRespondParams`'s shape exactly
 *  (`peripheral.respond`'s provider-answers-a-push pattern) but without `alreadyResolved`: the
 *  supervisor's pending-invoke map is the single source of truth for double-settle guarding, not
 *  the wire result. */
export const PluginToolResultParams = z.object({
  requestId: z.string().min(1),
  resultJson: z.string().optional(),
  error: z.string().optional(),
});
export const PluginToolResultResult = z.object({ ok: z.literal(true) });

/** Harness-role admin verb (Phase 4b Task 2, spec §3): deletes a plugin's stored token hash so a
 *  subsequent plugin hello for that id fails closed. Mirrors trust.remove's role precedent — NOT
 *  itself one of the six plugin-role verbs (a plugin can never revoke its own or another plugin's
 *  token). Exists because `plugin_tokens` lives in the daemon's sqlite: the CLI's disable/remove
 *  never opens that database directly (locking risk) and calls this RPC best-effort instead —
 *  mint stays daemon-side (Task 3, at supervisor spawn). */
export const PluginRevokeTokenParams = z.object({ pluginId: z.string().min(1) });
export const PluginRevokeTokenResult = z.object({ ok: z.literal(true) });

/** Final-review Fix 1: the manual-restart rider (`PluginSupervisor.restart`, plugins/supervisor.ts
 *  — existed and was tested but had no caller) exposed over the wire so `norma plugin restart
 *  <id>` can recover a plugin stuck "circuit-open" (nothing else ever clears that state short of
 *  a daemon restart). Same role precedent as `plugins.list` — harness OR admin, NOT one of the six
 *  plugin-role verbs (a plugin can never restart itself or another plugin). */
export const PluginRestartParams = z.object({ pluginId: z.string().min(1) });
export const PluginRestartResult = z.object({ ok: z.literal(true) });

// ---------------------------------------------------------------------------------------------
// Hardware helper (Phase 4c Task 1, spec §5): plugin (or harness, dev/testing) → core →
// Norma.app's XPC helper. `hardware.request` is PLUGIN-CALLABLE (ipc/server.ts's
// PLUGIN_ALLOWED_METHODS gains it, growing the plugin-role allowlist to seven verbs);
// `hardware.respond` is NOT — only the active provider connection (Norma.app) may answer a
// `hardware_requested` push (events.ts), same precedent as `peripheral.respond` above. The
// core-side broker (Task 2) owns unknown-verb/consent/no-provider/timeout error shaping; this
// task only pins the wire shapes.
// ---------------------------------------------------------------------------------------------

export const HardwareRequestParams = z.object({
  verb: z.string().min(1),
  argsJson: z.string().optional(),
});
/** Task 2 review pin (binding): a typed RESULT UNION, not RpcFailure — mirrors
 *  `PeripheralLeaseResult`'s success|error-code union shape (see "Peripheral lease v1" above).
 *  Success carries `resultJson`; failures are typed by `code`: `unknown_verb`
 *  (`verbClass(verb) === null`, core's peripheral/hardware.ts), `consent_denied` (a plugin-role
 *  caller's manifest permissions/consent record didn't cover the verb's class — `missing` names
 *  which permission/consent class was absent), `no_provider` (Norma.app isn't connected —
 *  `message` is the user-facing "hardware features require Norma.app" string), `timeout` (the
 *  provider never answered within the broker's timeoutMs), and `provider_error` (the provider's
 *  own `hardware.respond` carried an `error` string, passed through verbatim as `message`). */
export const HardwareRequestResult = z.union([
  z.object({ resultJson: z.string() }),
  z.object({ code: z.literal("unknown_verb") }),
  z.object({ code: z.literal("consent_denied"), missing: z.string().optional() }),
  z.object({ code: z.literal("no_provider"), message: z.string() }),
  z.object({ code: z.literal("timeout") }),
  z.object({ code: z.literal("provider_error"), message: z.string() }),
]);

/** The active provider connection's answer to a `hardware_requested` push — mirrors
 *  `PeripheralRespondParams`'s shape exactly (provider-answers-a-push pattern) but without
 *  `alreadyResolved`, same precedent as `PluginToolResultParams`: the broker's pending-request
 *  map (Task 2) is the single source of truth for double-settle guarding, not the wire result. */
export const HardwareRespondParams = z.object({
  requestId: z.string().min(1),
  resultJson: z.string().optional(),
  error: z.string().optional(),
});
export const HardwareRespondResult = z.object({ ok: z.literal(true) });

// ---------------------------------------------------------------------------------------------
// Phase 4d Task 2 (spec §6/§7): harness→core→plugin PUSH methods — the reverse of Task 1's
// plugin→core→dashboard tile broadcast. A future UI fires a plugin's registered shortcut or a
// tile-action button by calling one of these; core pushes a transient event to that plugin's own
// connection, mirroring how `plugin_tool_invoke` is pushed today (ipc/server.ts). Both are
// HARNESS-role (the app calls them, never a plugin) — deliberately NOT added to
// PLUGIN_ALLOWED_METHODS.
// ---------------------------------------------------------------------------------------------

export const ShortcutInvokeParams = z.object({ pluginId: z.string().min(1), shortcutId: z.string().min(1) });
export const TileActionParams = z.object({ pluginId: z.string().min(1), actionId: z.string().min(1) });
/** Shared by both verbs below — mirrors `HardwareRequestResult`'s typed-union style (success vs.
 *  typed failure codes, never a bare throw). There is no payload to round-trip on success: the
 *  push either reaches the plugin's connection or it doesn't. `unknown_plugin` = `pluginId` isn't
 *  a plugin core has any record of; `not_connected` = a known plugin with no live connection right
 *  now. */
export const PluginPushResult = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ code: z.literal("not_connected") }),
  z.object({ code: z.literal("unknown_plugin") }),
]);
export const ShortcutInvokeResult = PluginPushResult;
export const TileActionResult = PluginPushResult;

// ---------------------------------------------------------------------------------------------
// Plugin lifecycle (Phase 4d-ii Task 2, spec: harness-role RPCs so the app can install/enable/
// disable/remove a plugin — and grant its consent — over the wire, applied HOT to the running
// daemon (no restart required), instead of the CLI-only, file-based, restart-to-apply flow that
// predates this task. Mirrors the CLI's own plugin-cli.ts flow (missingConsents/
// buildConsentBlock/applyFreshPluginConsent/setPluginEnabled/grantPluginConsents/
// removePluginFromSettings/removePluginDir, all @norma/core's plugins/lifecycle.ts) but wire-
// shaped as typed result unions that never throw for an expected outcome — same precedent as
// `HardwareRequestResult`/`PluginPushResult` above. NOT plugin-role verbs: a plugin can never
// install/enable/disable/remove/consent itself or another plugin — ipc/server.ts's
// PLUGIN_ALLOWED_METHODS deliberately omits all five, so a plugin connection is role-rejected
// before dispatch for every one of them.
// ---------------------------------------------------------------------------------------------

/** Copies a local directory (`source`) into the daemon's plugins root — the RPC analog of the
 *  CLI's `installPlugin` (git clone) for a caller that already has the plugin's contents on disk
 *  (e.g. a dashboard-driven local install, or a git checkout the app did itself). `name` defaults
 *  to `source`'s basename (`deriveInstallName`) when omitted. Installs DISABLED + UNCONSENTED —
 *  NEVER touches settings.json (installPluginFromDir's own contract) — so the caller always gets
 *  `requiredConsents`/`consentBlock` back to drive a consent sheet before the plugin can do
 *  anything, exactly like `plugin.enable`'s `needs_consent` branch below. */
export const PluginsInstallParams = z.object({ source: z.string().min(1), name: z.string().min(1).optional() });
export const PluginsInstallResult = z.union([
  z.object({
    ok: z.literal(true), name: z.string(),
    requiredConsents: z.array(z.string()), hasMcp: z.boolean(), consentBlock: z.array(z.string()),
  }),
  z.object({ code: z.literal("invalid_source") }),
  z.object({ code: z.literal("already_installed"), name: z.string() }),
]);

/** Two-step consent flow, both over this ONE verb: called with no `consent` (or `consent:false`),
 *  a plugin with outstanding required-but-ungranted consent classes returns `needs_consent` +
 *  the full disclosure block (spec §1: "Consent text always shows the exec payload ... never
 *  just a summary.") WITHOUT mutating settings at all — the caller shows that block to the user,
 *  then re-calls with `consent:true` once they agree, which grants every required class fresh
 *  (`applyFreshPluginConsent`) and enables. `status` on success is the SAME `SupervisorStatus`
 *  union `PluginInfoSchema.status` reports (`"na"` for a non-Tier-2 plugin; `"stopped"` for a
 *  Tier-2 plugin when this daemon has no supervisor wired at all — settings are still recorded,
 *  there's just nothing to hot-spawn onto). */
export const PluginEnableParams = z.object({ name: z.string().min(1), consent: z.boolean().optional() });
export const PluginEnableResult = z.union([
  z.object({ ok: z.literal(true), status: PluginRuntimeStatusSchema }),
  z.object({ code: z.literal("needs_consent"), requiredConsents: z.array(z.string()), consentBlock: z.array(z.string()) }),
  z.object({ code: z.literal("unknown_plugin") }),
]);

export const PluginDisableParams = z.object({ name: z.string().min(1) });
export const PluginDisableResult = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ code: z.literal("unknown_plugin") }),
]);

export const PluginRemoveParams = z.object({ name: z.string().min(1) });
export const PluginRemoveResult = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ code: z.literal("unknown_plugin") }),
]);

/** Records consent separately from enabling, for a UI that wants to disclose/collect consent as
 *  its own step rather than folding it into `plugin.enable {consent:true}` (the common path). */
export const PluginSetConsentParams = z.object({ name: z.string().min(1), classes: z.array(z.string()) });
export const PluginSetConsentResult = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ code: z.literal("unknown_plugin") }),
]);

// ---------------------------------------------------------------------------------------------
// Scheduled routines (Phase 5 / Routines, design doc §3): the management surface over
// `RoutineStore` (core/src/routines/store.ts) — mirrors that store's `Routine` shape field-for-
// field via `RoutineSchema`. Routines run headless/unattended (T1: `policy` is restricted to
// "auto"|"plan" — "ask" is rejected, at the store boundary AND here at the wire schema, since a
// headless turn has nobody to answer an approval prompt). No typed error-code unions here (unlike
// the plugin-lifecycle verbs above) — invalid input (a bad spec, `policy:"ask"`, an unknown id on
// update) is a thrown RpcFailure (INVALID_PARAMS / NOT_FOUND — see ipc/server.ts), same precedent
// as `session.setPolicy`/`session.setCwd` above.
// ---------------------------------------------------------------------------------------------

/** Restricted to "auto"|"plan" (NOT the full `ApprovalPolicy` union above) — a routine fires with
 *  nobody present to answer an "ask" approval prompt, so the wire schema rejects it up front
 *  (before ever reaching RoutineStore's own runtime `validatePolicy` guard, which every OTHER
 *  caller — the `schedule` tool, a future CLI — must still go through, since they don't necessarily
 *  route through this zod schema first). */
export const RoutinePolicySchema = z.enum(["auto", "plan"]);

/** Mirrors `Routine` (core/src/routines/store.ts) field-for-field. */
export const RoutineSchema = z.object({
  id: z.string(),
  spec: z.string(),
  prompt: z.string(),
  policy: RoutinePolicySchema,
  cwd: z.string(),
  enabled: z.boolean(),
  lastRunAt: z.number().int().nonnegative().nullable(),
  nextRunAt: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  lastResult: z.string().nullable(),
  deferAttempts: z.number().int().nonnegative(),
});

export const RoutinesCreateParams = z.object({
  spec: z.string().min(1),
  prompt: z.string().min(1),
  policy: RoutinePolicySchema.optional(),
  cwd: AbsoluteDirPath.optional(),
});
export const RoutinesCreateResult = z.object({ routine: RoutineSchema });

export const RoutinesListParams = z.object({});
export const RoutinesListResult = z.object({ routines: z.array(RoutineSchema) });

/** Only the fields the design doc names for `routines.update` — enable/disable, and editing the
 *  spec/prompt/policy. (`RoutineStore.update` also accepts a `cwd` patch; that's deliberately not
 *  exposed over this RPC yet — narrower wire surface than the store's own capability, widenable
 *  later without a breaking change.) */
export const RoutinePatchSchema = z.object({
  spec: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  policy: RoutinePolicySchema.optional(),
  enabled: z.boolean().optional(),
});
export const RoutinesUpdateParams = z.object({ id: z.string().min(1), patch: RoutinePatchSchema });
export const RoutinesUpdateResult = z.object({ routine: RoutineSchema });

export const RoutinesDeleteParams = z.object({ id: z.string().min(1) });
export const RoutinesDeleteResult = z.object({ ok: z.literal(true), removed: z.boolean() });

// ---------------------------------------------------------------------------------------------
// Memory (Phase 5b Task 3, design doc §4): the management surface over `MemoryStore` (core/src/
// agent/memory.ts) — mirrors that store's `MemoryFactMeta`/`MemoryFact`/`MemoryAuditLine` shapes
// field-for-field, same precedent as the routines block above. Unlike routines (no session
// context to source a cwd from), the caller here IS a session-less dashboard/CLI connection, so
// `cwd` is an explicit param on every scope-bearing verb — the store's own trust gate (project
// scope requires a TrustStore-trusted cwd) does the enforcement, not this schema. No typed
// error-code unions (unlike the plugin-lifecycle verbs): a store `ok:false` becomes a thrown
// RpcFailure, same precedent as routines.create/update above.
// ---------------------------------------------------------------------------------------------

export const MemoryScopeSchema = z.enum(["user", "project"]);
export const MemoryTypeSchema = z.enum(["user", "feedback", "project", "reference"]);

/** Mirrors `MemoryFactMeta` (core/src/agent/memory.ts) field-for-field. */
export const MemoryFactMetaSchema = z.object({
  name: z.string(),
  description: z.string(),
  type: MemoryTypeSchema,
});
/** Mirrors `MemoryFact` — `MemoryFactMetaSchema` plus the full body. */
export const MemoryFactSchema = MemoryFactMetaSchema.extend({ body: z.string() });

/** Mirrors `MemoryAuditLine` — `sessionId`/`description` optional exactly as the store's
 *  `appendAudit` omits them from the JSON line when absent (never serializes `null`). */
export const MemoryAuditLineSchema = z.object({
  ts: z.number().int().nonnegative(),
  sessionId: z.string().optional(),
  source: z.enum(["tool", "rpc"]),
  scope: MemoryScopeSchema,
  action: z.enum(["write", "delete"]),
  name: z.string(),
  description: z.string().optional(),
});

export const MemoryListParams = z.object({ scope: MemoryScopeSchema, cwd: AbsoluteDirPath.optional() });
export const MemoryListResult = z.object({ facts: z.array(MemoryFactMetaSchema) });

export const MemoryReadParams = z.object({ scope: MemoryScopeSchema, name: z.string().min(1), cwd: AbsoluteDirPath.optional() });
export const MemoryReadResult = z.object({ fact: MemoryFactSchema });

export const MemoryWriteParams = z.object({
  scope: MemoryScopeSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  type: MemoryTypeSchema.default("user"),
  body: z.string().min(1),
  cwd: AbsoluteDirPath.optional(),
});
/** Nothing to round-trip on success — the wire result truly is empty (design doc §4's own
 *  `{scope, name, ...} → {}` shape), unlike routines.delete's `{ok, removed}`: an unknown-name
 *  delete/write failure is a store `ok:false` (thrown RpcFailure) here, never a soft boolean. */
export const MemoryWriteResult = z.object({});

export const MemoryDeleteParams = z.object({ scope: MemoryScopeSchema, name: z.string().min(1), cwd: AbsoluteDirPath.optional() });
export const MemoryDeleteResult = z.object({});

// T3 (file-based memory, design doc follow-up / task-23): `cwd` is additive/optional — every
// existing caller (the Swift dashboard's user-scope-only pane, task-22's tests) omits it and gets
// EXACTLY the prior behavior. It exists so a files-mode caller (CLI `--project`, or a future
// project-aware dashboard view) can target a SPECIFIC project's `.audit.jsonl` (memory-file-ops.ts
// `deleteMemoryDir`'s audit trail, T2) instead of only ever reading the legacy central log — see
// ipc/server.ts's `memory.audit` handler for the resolution (mirrors `memory.list`/etc.'s own
// `memoryFileDir(opts.memoryFiles, cwd)`: present -> that project's MEMDIR; absent -> the global
// bucket). Under the legacy backend (`memoryFiles` disabled) `cwd` is accepted but ignored — the
// central `audit.jsonl` has no per-project split to filter by.
export const MemoryAuditParams = z.object({ limit: z.number().int().nonnegative().optional(), cwd: AbsoluteDirPath.optional() });
/** Newest FIRST (design doc §4) — the inverse of `MemoryStore.auditTail`'s own newest-LAST
 *  contract; the handler reverses the store's slice before returning it. */
export const MemoryAuditResult = z.object({ lines: z.array(MemoryAuditLineSchema) });

/** BYOK T1 (design doc `2026-07-16-byok-provider-setup-design.md` §1): the in-app "bring your own
 *  OpenAI API key" path — a scoped, purpose-specific RPC (deliberately NOT a generic secret-write
 *  verb). `type` is a literal (openai-compatible only, v1) — switching back to codex-oauth stays
 *  CLI-only (`norma login`), same "out of scope" carve-out as the design doc. `model` defaults to
 *  "gpt-4o" server-side when omitted (ipc/server.ts's handler), mirroring `ProviderSettings`'s own
 *  required (non-optional) `model` field for openai-compatible. Provider-TYPE changes need a
 *  daemon restart to take effect (providers/manager.ts fixes `providerType` at boot) — this RPC
 *  only persists the new config; triggering the restart is the caller's job (T2's Dashboard pane). */
export const ProviderConfigureParams = z.object({
  type: z.literal("openai-compatible"),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  model: z.string().min(1).optional(),
});
export const ProviderConfigureResult = z.object({ ok: z.literal(true) });

// ---------------------------------------------------------------------------------------------
// Workflows (CC-parity phase 3, Track C Task C2): the RPC surface over `WorkflowRuntime` (live
// runs, core/src/workflows/runtime.ts, A3+/B2) + `WorkflowStore` (saved, trust-gated
// `.norma/workflows/*.js` scripts, C1) — mirrors the routines.*/memory.* blocks above (harness AND
// admin role, no additional role check at the wire-schema layer; ipc/server.ts enforces it).
// LOCAL-ONLY IN V1 (Global Constraints): these four verbs are deliberately NOT added to
// PLUGIN_ALLOWED_METHODS or REMOTE_ALLOWED_METHODS (ipc/server.ts) — a plugin or remote (iPhone
// gateway) connection is role-rejected before dispatch ever reaches a handler for any of them. The
// Swift NormaKit mirror for these same four methods is a LATER task (Track D) — no protocol
// codegen fixture cost here either way: only new `SessionEvent` VARIANTS need
// `pnpm protocol:generate`'s fixtures, and this task adds no new event variant.
//
// `WorkflowRunViewSchema` mirrors `WorkflowRunView` (core/src/workflows/types.ts) field-for-field,
// same "kept as a separate literal, protocol can't import from core" precedent as `RoutineSchema`/
// `ThreadInfoSchema` above. `WorkflowRunParams`'s `name`/`script` can't both be expressed as
// "exactly one required" in zod without a discriminated union that would reject a plain
// `{sessionId, name}` OR `{sessionId, script}` shape identically to how a caller naturally sends
// them — the handler enforces it (methods.ts doc precedent: routines.create's `policy:"ask"`
// rejection is schema-level because it's a single-field enum; this is a cross-field XOR, left to
// ipc/server.ts, same as `PluginEnableParams`'s two-step consent flow being handler-shaped rather
// than schema-shaped).
// ---------------------------------------------------------------------------------------------

export const WorkflowListParams = z.object({ sessionId: z.string().min(1), cwd: z.string().optional() });
export const WorkflowRunViewSchema = z.object({
  runId: z.string(), sessionId: z.string(), name: z.string().optional(),
  status: z.enum(["running", "completed", "failed", "stopped"]),
  counts: z.object({ running: z.number().int(), completed: z.number().int(), total: z.number().int() }),
  phase: z.string().optional(), result: z.string().optional(), error: z.string().optional(),
  startedAt: z.number().int(),
});
/** A saved (not-yet-running) workflow's identity — mirrors `ResolvedWorkflow`
 *  (core/src/workflows/store.ts) field-for-field. */
export const WorkflowSavedSchema = z.object({ name: z.string(), description: z.string(), source: z.string() });
export const WorkflowListResult = z.object({
  running: z.array(WorkflowRunViewSchema),
  saved: z.array(z.object({ name: z.string(), description: z.string(), source: z.string() })),
});

/** `name`/`script`: exactly one required, enforced by the handler (see the block comment above) —
 *  `name` resolves a saved workflow via `WorkflowStore` IN THE SESSION'S OWN cwd (trust-gated,
 *  slug-guarded — C1's guards); `script` launches an inline body verbatim. `args` is opaque
 *  (mirrors `WorkflowLaunch.args?: unknown`, runtime.ts) — the workflow script's own `args` binding. */
export const WorkflowRunParams = z.object({
  sessionId: z.string().min(1), name: z.string().optional(), script: z.string().optional(), args: z.unknown().optional(),
});
/** `status` is always `"running"` — `runtime.launch()` returns synchronously, right after
 *  registering the run (WorkflowRegistry.register sets it "running" before launch() ever returns),
 *  so there is no other value a fresh launch could report here. */
export const WorkflowRunResult = z.object({ runId: z.string(), status: z.literal("running") });

export const WorkflowStopParams = z.object({ runId: z.string().min(1) });
/** `stopped` is a soft boolean, never a thrown NOT_FOUND — mirrors `routines.delete`'s
 *  `{ok, removed}` idiom: stopping an unknown or already-terminal runId is not an error, it just
 *  didn't stop anything (`WorkflowRegistry.stop`'s own "false for unknown/already terminal, never
 *  throws" contract, runtime.ts). */
export const WorkflowStopResult = z.object({ ok: z.literal(true), stopped: z.boolean() });

export const WorkflowGetParams = z.object({ runId: z.string().min(1) });
export const WorkflowGetResult = z.object({ run: WorkflowRunViewSchema });

// ---------------------------------------------------------------------------------------------
// Session sync (Chat Slice D task 2) — `sync.heads` / `sync.pull` / `sync.push`.
//
// The replication wire between a phone's own chat-session logs and the daemon's. All three are
// CHAT-ONLY and fail closed on an absent/unknown session `mode` (the plan-immunity composing-seam
// rule — `mode ?? "code"` is the store-wide convention, so an absent mode is a CODE session and is
// refused, never waved through). All three are REMOTE_ALLOWED_METHODS-listed: the phone is the
// only client that has ever needed them.
//
// Paging is over RAW JSONL BYTES, not events. That is the load-bearing design choice: a single
// event larger than a page is a non-problem BY CONSTRUCTION (it simply spans pages), where an
// event-granular pager would have to either drop it or blow the transport's frame limit. It also
// keeps the replica byte-identical — the daemon stores the client's exact line bytes rather than a
// re-serialization, so pull → push → pull is a fixed point and a future content hash stays stable.
// ---------------------------------------------------------------------------------------------

/** No params: the daemon reports the head of every chat session it holds, and the client diffs. */
export const SyncHeadsParams = z.object({});
export const SyncHeadsResult = z.object({
  sessions: z.array(z.object({
    sessionId: z.string(),
    /** The daemon's current head — the `baseSeq` a subsequent `sync.push` must declare. */
    lastSeq: z.number().int().nonnegative(),
    /** `null`, never absent, when the session has neither a generated title nor a first message. */
    title: z.string().nullable(),
    model: z.string().optional(),
    /** provider-correctness T6: the READ half of `sync.push`'s `meta.effort`, and the reason it is
     *  here rather than left for later — replication through this pair is bidirectional by design,
     *  so a field that only travels one way produces exactly the divergence the field was added to
     *  fix, mirrored. The Mac's own picker can set an effort on a chat session; without this the
     *  phone would keep running that session at its own effort forever, and the only symptom would
     *  again be "the answers are different".
     *
     *  Unvalidated on the way OUT, deliberately: this reports the daemon's own column, which every
     *  ingress into it (`session.setEffort`, `session.create`, `sync.push`) has already checked.
     *  Absent means "no override" — the session resolves at the global default. It may be a
     *  Norma-level TIER only in theory: `sync.heads` lists CHAT sessions exclusively and every
     *  ingress refuses a tier for chat, so a reader that treats it as a wire effort is safe today —
     *  but `SessionSummary.effort`'s rule (match against BOTH lists) is the one to follow. */
    effort: z.string().optional(),
    forkedFrom: SessionForkRef.optional(),
  })),
});
export type SyncHeadsResult = z.infer<typeof SyncHeadsResult>;

/** `fromSeq` is an EXCLUSIVE lower bound (matches `SessionStore.read`'s own `seq > fromSeq`), so
 *  `fromSeq: 0` is "the whole log" and `fromSeq: lastSeq` is "nothing new". `cursor` is a BYTE
 *  offset into the tail slice that starts at `fromSeq` — echo back the previous page's
 *  `nextCursor`, never a value you computed yourself. The tail only ever grows at the end (the log
 *  is append-only), so a cursor stays valid across a concurrent append; one past the end of the
 *  tail is refused rather than silently emptied. */
export const SyncPullParams = z.object({
  sessionId: z.string().min(1),
  fromSeq: z.number().int().nonnegative(),
  cursor: z.number().int().nonnegative().optional(),
});
export const SyncPullResult = z.object({
  /** base64 of raw JSONL bytes — verbatim log lines, NOT re-serialized events. `""` when empty. */
  data: z.string(),
  /** Present iff `complete` is false: the byte offset to pass as the next call's `cursor`. */
  nextCursor: z.number().int().nonnegative().optional(),
  complete: z.boolean(),
});
export type SyncPullParams = z.infer<typeof SyncPullParams>;
export type SyncPullResult = z.infer<typeof SyncPullResult>;

/** Hard ceiling on a single `sync.push` chunk's base64 payload — sized against the PHONE
 *  transport, `IROH_MAX_FRAME_BYTES` (1 MiB), NOT the local Unix socket's 8 MiB line cap. That
 *  distinction is the whole point: the phone is the only client this surface exists for, and a
 *  frame above the iroh limit ENDS the connection rather than returning an error a client could
 *  log. A chunk at this ceiling plus its JSON-RPC envelope lands around 384 KiB — under 40% of the
 *  frame budget, the same generous margin `SYNC_PAGE_BYTES` leaves on the pull side.
 *
 *  Chosen so a client can push back exactly what it pulled: base64 inflates by 4/3, so a full
 *  `SYNC_PAGE_BYTES` (256 KiB) page re-encodes to 349,528 characters, which this admits with room
 *  to spare. It bounds ONE chunk; total reassembly across chunks is bounded separately (32 MiB,
 *  `SYNC_PUSH_BUFFER_MAX_BYTES` in packages/core/src/ipc/sync.ts). */
export const SYNC_MAX_CHUNK_B64 = 384 * 1024;

/** `baseSeq` is the client's belief about the daemon's head, and it is CHECKED, never trusted: a
 *  mismatch is `ERR.DIVERGED` carrying `data: { lastSeq }`, never a silent overwrite. An UNKNOWN
 *  `sessionId` with `baseSeq: 0` CREATES the session (chat mode, fixed "chat" policy, cwd $HOME,
 *  and the id must be a UUID — a phone-minted id, distinct from the daemon's own `s_<hex>` shape).
 *  Chunking: send `complete: false` for every chunk but the last; the daemon buffers per
 *  (connection, sessionId) and applies the whole batch ATOMICALLY on the final chunk — nothing is
 *  appended unless every line validates. `meta` is index-only session metadata that has no event
 *  of its own (title/model/fork provenance); it is applied only alongside a successful `complete`.
 *
 *  READING A `DIVERGED` (`ERR.DIVERGED`, `data: { lastSeq }`) — branch on `data.lastSeq`, never on
 *  the code alone: `lastSeq: 0` means the daemon holds NOTHING for this id, so the answer is
 *  "re-push from seq 1" (which creates it), NOT "fork". Only a non-zero `lastSeq` describes a real
 *  branch point. A client that forks on the bare code will spawn a spurious fork for every session
 *  it retries after a partial failure.
 *
 *  `meta.model` is validated against the daemon's own model catalogue exactly as `session.setModel`
 *  is (alias-resolved, membership-checked when the provider can enumerate, stored freely when it
 *  can't) — but an UNKNOWN slug is DROPPED rather than failing the call: a model mismatch between a
 *  phone and a Mac must never block log replication, which is the irreplaceable half.
 *
 *  `meta.effort` (provider-correctness T6) carries the same rule and the same reason. It exists
 *  because a phone-set per-session effort that does NOT replicate is invisible: the Mac keeps
 *  resolving that session at the global default while the phone's UI shows the override, and the
 *  only symptom is "the answers are different on the Mac". Its ingress validation is model-aware
 *  (`effortsForModel`, packages/core/src/ipc/sync.ts) exactly as `session.setEffort`'s is, and it
 *  drops-and-logs rather than failing the push, exactly as `model` does. One rule is stricter here
 *  than at `session.setEffort`: a Norma-level TIER (`sync.config.clientEfforts`, e.g. `"ultra"`) is
 *  ALWAYS dropped on this ingress, because a tier is code-sessions-only and this surface is
 *  chat-only fail-closed — no session reachable through it may ever hold one. */
export const SyncPushParams = z.object({
  sessionId: z.string().min(1),
  baseSeq: z.number().int().nonnegative(),
  data: z.string().max(SYNC_MAX_CHUNK_B64), // base64 of a raw JSONL chunk; may split mid-line
  complete: z.boolean(),
  meta: z.object({
    // Bounded at the wire, not just clamped internally — see SESSION_TITLE_MAX_CHARS for why an
    // unbounded title on an UNPAGED heads/list response is a persistent connection killer.
    title: z.string().max(SESSION_TITLE_MAX_CHARS).optional(),
    model: z.string().min(1).max(SESSION_MODEL_MAX_CHARS).optional(),
    // provider-correctness T6. Bounded by the SAME constant `session.setEffort`'s param uses, and
    // NOT enumerated here for the same reason that one isn't: which levels a model accepts is
    // provider knowledge the protocol package cannot see change, so a zod enum here would be a
    // second, drift-prone copy. Membership is checked at the handler, against the session's own
    // model's list.
    //
    // THREE STATES, and the distinction between the last two is the whole point (T6 review, C6):
    //   * ABSENT      → unchanged. This is what a STALE client sends — one that simply has not
    //                   learned about an override the other side set. It must never be able to wipe
    //                   one, which is why "I have no effort" is spelled by omitting the key.
    //   * `null`      → CLEAR the override, restoring the precedence chain (session → global).
    //   * a string    → set it, subject to the handler's model-aware + tier checks.
    // `null` rather than `""` deliberately: it is the SAME clear vocabulary `session.setEffort`
    // already uses for this exact column (`SessionSetEffortParams.effort` is `.nullable()`), so
    // there is no second magic value to remember, no `.min(1)` to relax, and no ""→NULL mapping a
    // future writer can miss and thereby store a truthy-but-meaningless effort that then flows out
    // through `sync.heads` and `session.list`.
    //
    // Deliberately NOT extended to `title`/`model` beside it: neither has a clear affordance in any
    // UI, so giving them a null state would be inventing a capability nothing asks for.
    effort: z.string().min(1).max(SESSION_EFFORT_MAX_CHARS).nullable().optional(),
    forkedFrom: SessionForkRef.optional(),
  }).optional(),
});
export const SyncPushResult = z.object({
  /** True only on the final chunk, once the batch has actually landed on disk. */
  applied: z.boolean(),
  /** The daemon's head AFTER this call: the new head when `applied`, the unchanged current head
   *  (0 for a session that does not exist yet) while chunks are still being buffered. */
  lastSeq: z.number().int().nonnegative(),
  /** Bytes currently held in the reassembly buffer for this (connection, sessionId) — 0 once
   *  applied. Lets a client see its own chunking progress without guessing. */
  buffered: z.number().int().nonnegative(),
});
export type SyncPushParams = z.infer<typeof SyncPushParams>;
export type SyncPushResult = z.infer<typeof SyncPushResult>;
export type SessionForkRef = z.infer<typeof SessionForkRef>;

// ---------------------------------------------------------------------------------------------
// Chat Slice D task 3 — `sync.config` + `sync.memory`, the two remaining sync surfaces for the
// phone's OWN standalone chat (no Mac session in the loop at all): the bootstrap config bundle a
// freshly-paired phone needs to run chat locally, and a read-only replica of the shared
// `_assistant` memory bucket so its own context assembler can inject the SAME memory the Mac's
// chat sessions see. Neither carries a `sessionId` — there is no session to gate on — but both stay
// REMOTE_ALLOWED_METHODS-listed for the same reason `sync.heads`/`pull`/`push` are: the phone is
// the only client that has ever needed them.
// ---------------------------------------------------------------------------------------------

/** No params: everything returned is either global (the Exa key, the user's added dangerous
 *  domains) or a live daemon-wide default (the current model) — nothing here is per-project or
 *  per-session. Every field is read AT CALL TIME (hot, no daemon restart), same discipline as
 *  every other settings-backed getter in this codebase. */
export const SyncConfigParams = z.object({});

/** One row of the daemon's model catalogue: the slug, plus the reasoning-effort levels that slug
 *  accepts.
 *
 *  **Why `efforts` rides PER MODEL when all three gpt-5.6 slugs accept the identical six today.**
 *  The backend validates effort in TWO different layers, and they do not agree with each other:
 *  `ultra` is refused by a GLOBAL, model-agnostic enum (`invalid_value`), while `minimal` is refused
 *  PER MODEL (`unsupported_value`, the error naming the slug). So per-model divergence is not
 *  hypothetical — it is the observed behaviour of the layer that already exists. Carrying one flat
 *  list would mean a future divergence could only be expressed by shipping a new PHONE APP; carrying
 *  it per model makes that same divergence a daemon-side data edit that reaches every paired device
 *  on its next connect. (See `REASONING_EFFORTS` in packages/core/src/settings.ts for the full
 *  two-layer story and why "ultra" must never come back.) */
export const SyncConfigModel = z.object({
  id: z.string().min(1),
  efforts: z.array(z.string().min(1)),
});
export type SyncConfigModel = z.infer<typeof SyncConfigModel>;

export const SyncConfigResult = z.object({
  /** WHICH PROVIDER this whole bundle describes — `"codex-oauth"` / `"openai-compatible"`, the
   *  `ProviderSettings.type` vocabulary (packages/core/src/settings.ts), `"none"` on a daemon with
   *  no provider configured at all.
   *
   *  **NOT sentinel-optional, unlike every other field here.** `models: []` and `defaultEffort: ""`
   *  are real answers meaning "I have none"; there is no equivalent for this one, because the daemon
   *  always knows which provider it is running (including "not one"). `min(1)`, always stated.
   *
   *  **THE RULE THIS FIELD EXISTS FOR: a provider MISMATCH means NEVER-SYNCED for the model half.**
   *  A client that runs its OWN engine on its OWN credentials — the phone, which is always
   *  codex-oauth (`phone-always-local`) — must, on a non-empty `provider` that is not its own,
   *  discard `defaultModel` (and `models`, already `[]`) instead of adopting it. Without that rule
   *  the bundle is not self-describing and one live 400 follows directly: on an `openai-compatible`
   *  Mac the provider is constructed with no enumerable catalogue (`ProviderSettings` has no
   *  `models` field), so `models` is `[]` — but `defaultModel` is still a non-empty FOREIGN slug (a
   *  llama/BYOK name). A phone that stores any non-empty `defaultModel` then sends that slug to
   *  Codex `/responses` and is 400'd on its first turn. The "an empty catalogue is ignored on apply"
   *  rule governs `models` ONLY and does not close this; nothing but the provider identity can.
   *
   *  ABSENT (a daemon built before this field) is NOT a mismatch. A client mirror decodes absence as
   *  `""` — "the Mac did not say" — which is the pre-field status quo and must keep behaving like
   *  it; treating unknown as mismatched would take local chat down on every older Mac.
   *
   *  BOOT-BOUND, deliberately, and it agrees with `models` by construction: it is the identity of
   *  the very provider instance whose `models()` feeds this bundle, NOT a fresh read of
   *  `settings.provider.type`. A settings.json edited to a different `provider.type` needs a daemon
   *  restart to take effect (providers/manager.ts says so), so a live-read type would claim a
   *  provider whose catalogue this bundle is not reporting — the same mismatch, manufactured by the
   *  field meant to detect it. */
  provider: z.string().min(1),
  /** `null` when no key is stored — never an empty string (indistinguishable from "stored but
   *  blank"). Sourced from `Bun.secrets` (`EXA_API_KEY_SECRET`), the SAME keychain item Search's
   *  own accessor reads — never written to disk anywhere in this envelope. */
  exaKey: z.string().nullable(),
  /** The USER-ADDED half of the dangerous-domains list ONLY (`settings.permissions.dangerousDomains.added`)
   *  — the shipped baseline list ships baked into the phone kit itself (Task 6), so sending it here
   *  too would be redundant on every call and would need to stay in lockstep with the kit release
   *  forever. An empty array, never omitted, when the user has added nothing. */
  dangerousDomains: z.array(z.string()),
  /** The provider's LIVE model (re-resolved every call, mirroring `AgentEngine`'s own
   *  `provider.live?.() ?? {model: provider.model}` idiom) — the phone's starting point for a brand
   *  new local chat session, not a value it re-validates against anything. */
  defaultModel: z.string(),
  /** The ACTIVE provider's whole model catalogue — `AgentEngine.knownModels()`, the SAME list
   *  `session.setModel` and `sync.push` validate a slug against, re-read every call.
   *
   *  Before this field the phone DERIVED its lineup: it split `defaultModel` on its last `-`, read
   *  the tail as a tier, and synthesized the sibling slugs by string concatenation. A derivation
   *  cannot be proved — the phone could never know the tiers it invented exist, and its parallel
   *  effort control (a pure UI mock) had drifted to offering `ultra`, which the backend rejects
   *  outright. The daemon is the side that already holds and validates this list, so it serves it.
   *
   *  **EMPTY IS A REAL ANSWER, and it is never a licence to guess.** `[]` means the active provider
   *  cannot enumerate its models (an arbitrary openai-compatible endpoint — the same case
   *  `session.setModel` handles by skipping its membership check), or that no provider is configured
   *  at all. A client that receives `[]` has NOT been told a catalogue and must wait for one, exactly
   *  as it already waits on an empty `defaultModel` rather than substituting a guess: a guessed
   *  fallback model is what produced a 400-on-first-turn on a freshly-paired phone once already. */
  models: z.array(SyncConfigModel),
  /** The LIVE reasoning effort (`settings.provider.reasoningEffort`), re-resolved every call
   *  alongside `defaultModel` and off the same resolver.
   *
   *  `""` means UNSET, and unset is NOT `"none"`. An unset effort makes the daemon omit the
   *  `reasoning` block from the request body entirely (providers/openai-compatible.ts); `"none"` is
   *  an explicit level the backend honours and echoes back. A client must treat `""` as "the Mac has
   *  configured no effort" and send none itself — never as a level to put on the wire, and never as
   *  a reason to pick one. */
  defaultEffort: z.string(),
  /** NORMA-LEVEL effort tiers this daemon offers — selectable in Norma, **never sent upstream**,
   *  and offered on CODE sessions only (`session.setEffort` refuses them for chat/dispatch).
   *  `["ultra"]` on a current daemon (`CLIENT_EFFORTS`, packages/core/src/settings.ts).
   *
   *  **A SEPARATE FIELD, deliberately never merged into `models[].efforts`.** That array is exactly
   *  what the endpoint's request validator accepts and exactly what `session.setEffort` accepts as
   *  a wire effort — one list, one meaning. A tier here is the opposite kind of value: the daemon
   *  TRANSLATES it to a wire effort (today `ultra` → `max`) plus some local behaviour before any
   *  request is built, so putting it in `models[].efforts` would make the daemon advertise a level
   *  its own turn would be 400'd on. That is precisely the bug the catalogue field was added to fix
   *  — `ultra` was offered by a phone-side mock while a global enum on the backend rejected it — so
   *  re-merging the two lists would reintroduce it through the fix.
   *
   *  `[]` is a real answer and the only correct degrade: "this daemon offers no Norma-level tiers".
   *  A client renders exactly what it is told (wire levels from `models[].efforts`, tiers from
   *  here) and invents neither, so an older daemon meeting a newer client simply shows no tiers
   *  rather than offering one the daemon would refuse. */
  clientEfforts: z.array(z.string().min(1)),
});
export type SyncConfigParams = z.infer<typeof SyncConfigParams>;
export type SyncConfigResult = z.infer<typeof SyncConfigResult>;

/** `cursor` echoes back a previous page's `nextCursor` — an index into the bucket's STABLE
 *  (sorted-by-name) file list, not a byte offset (contrast `sync.pull`'s `cursor`, which IS a byte
 *  offset into one file's tail): this bucket is many small files, not one growing log, so paging
 *  over whole files is the natural unit. Omitted/`0` starts from the beginning.
 *
 *  "STABLE" means stable ORDERING (sorted by name), NOT a snapshot: the handler re-reads the
 *  directory on every call, so a write landing between two pages of the same walk — a Dreamer cycle
 *  adding a topic file that sorts before the cursor — shifts what that index means, and one file can
 *  be served twice or skipped for that walk (T3 review Minor). Harmless by design: this is a
 *  stale-is-fine replica, and the client's next walk from cursor 0 self-heals it. Do not read it as
 *  "consistent under concurrent writes". */
export const SyncMemoryParams = z.object({
  cursor: z.number().int().nonnegative().optional(),
});
export const SyncMemoryResult = z.object({
  files: z.array(z.object({ name: z.string(), content: z.string() })),
  /** Present iff `complete` is false. */
  nextCursor: z.number().int().nonnegative().optional(),
  complete: z.boolean(),
});
export type SyncMemoryParams = z.infer<typeof SyncMemoryParams>;
export type SyncMemoryResult = z.infer<typeof SyncMemoryResult>;

/** panel-shell T6: the RPC surface over Task 5's `foldPanelTabs` (packages/core/src/panel/store.ts)
 *  — five methods, all harness/admin-only (never added to REMOTE_ALLOWED_METHODS or
 *  PLUGIN_ALLOWED_METHODS in ipc/server.ts: the phone has no panel, and a plugin has no reason to
 *  drive one).
 *
 *  There is deliberately NO `panel.navigate`. A navigation has two producers that must not be
 *  conflated: the agent's navigation is a REQUEST and travels later as a `panel_command` (transient,
 *  Plan B — not this task); the user clicking a link inside a page is a FACT only the app observes,
 *  via CEF, and travels as `panel.reportNavigation`. Both converge on the same persisted
 *  `panel_tab_navigated` event, through the same handler — see that handler's own doc comment in
 *  ipc/server.ts for why an unknown/already-closed tabId is accepted rather than refused there. */
export const PanelTabSchema = z.object({
  tabId: z.string().min(1),
  kind: PanelTabKind,
  url: z.string().optional(),
  title: z.string().optional(),
});

export const PanelListParams = z.object({ sessionId: z.string().min(1) });
/** Mirrors `PanelTabState` (core/src/panel/store.ts) field-for-field — this IS the fold, verbatim. */
export const PanelListResult = z.object({
  tabs: z.array(PanelTabSchema),
  activeTabId: z.string().optional(),
});

/** `panel.openTab` mints `tabId` DAEMON-SIDE (`crypto.randomUUID()`, ipc/server.ts) — the caller
 *  never supplies one, on purpose: that is what makes an agent-opened tab and a user-opened tab
 *  indistinguishable downstream. Exactly one code path creates a tab, and it always runs here,
 *  regardless of who asked — see CLAUDE.md's "the rule that decides who mints what". */
export const PanelOpenTabParams = z.object({
  sessionId: z.string().min(1),
  kind: PanelTabKind,
  url: z.string().optional(),
  title: z.string().optional(),
});
export const PanelOpenTabResult = z.object({ ok: z.literal(true), tabId: z.string().min(1) });

export const PanelCloseTabParams = z.object({ sessionId: z.string().min(1), tabId: z.string().min(1) });
export const PanelCloseTabResult = z.object({ ok: z.literal(true) });

export const PanelActivateTabParams = z.object({ sessionId: z.string().min(1), tabId: z.string().min(1) });
export const PanelActivateTabResult = z.object({ ok: z.literal(true) });

/** The app is the SOLE witness of a committed top-level navigation (CEF fired it) — this is a FACT
 *  report, never a request, and has no `panel.navigate` counterpart (see this section's own doc
 *  comment above). `url` is required non-empty; `title` is required but MAY be empty (a page with no
 *  `<title>`), mirroring `PanelTabNavigatedEvent` (events.ts) exactly. */
export const PanelReportNavigationParams = z.object({
  sessionId: z.string().min(1),
  tabId: z.string().min(1),
  url: z.string().min(1),
  title: z.string(),
});
export const PanelReportNavigationResult = z.object({ ok: z.literal(true) });

export const METHODS = {
  hello: "protocol.hello",
  sessionCreate: "session.create",
  sessionList: "session.list",
  sessionAttach: "session.attach",
  sessionHistory: "session.history",
  sessionSend: "session.send",
  sessionDispatch: "session.dispatch",
  approvalRespond: "approval.respond",
  approvalList: "approval.list",
  sessionAddDir: "session.addDir",
  sessionSetCwd: "session.setCwd",
  trustDir: "daemon.trustDir",
  event: "event",
  bgList: "bg.list",
  bgPeek: "bg.peek",
  bgKill: "bg.kill",
  bgKillAll: "bg.killAll",
  sessionSteer: "session.steer",
  sessionInterrupt: "session.interrupt",
  sessionCompact: "session.compact",
  skillsList: "skills.list",
  skillsRead: "skills.read",
  skillsWrite: "skills.write",
  skillsDelete: "skills.delete",
  mcpList: "mcp.list",
  pluginsList: "plugins.list",
  askUserRespond: "ask_user.respond",
  taskList: "task.list",
  planRespond: "plan.respond",
  sessionSetPolicy: "session.setPolicy",
  sessionSetModel: "session.setModel",
  sessionSetEffort: "session.setEffort",
  sessionSetActivity: "session.setActivity",
  sessionSetDirs: "session.setDirs",
  threadList: "thread.list",
  threadSend: "thread.send",
  agentStop: "agent.stop",
  peripheralLease: "peripheral.lease",
  peripheralRenew: "peripheral.renew",
  peripheralRelease: "peripheral.release",
  peripheralAdvertise: "peripheral.advertise",
  peripheralRevoke: "peripheral.revoke",
  peripheralRespond: "peripheral.respond",
  daemonStatus: "daemon.status",
  engineActivity: "engine.activity",
  quotaState: "quota.state",
  trustList: "trust.list",
  trustRemove: "trust.remove",
  pluginRegister: "plugin.register",
  toolRegister: "tool.register",
  shortcutRegister: "shortcut.register",
  tileUpdate: "tile.update",
  providerRegister: "provider.register",
  pluginsContrib: "plugins.contrib",
  pluginToolResult: "plugin.toolResult",
  pluginRevokeToken: "plugin.revokeToken",
  pluginRestart: "plugin.restart",
  hardwareRequest: "hardware.request",
  hardwareRespond: "hardware.respond",
  shortcutInvoke: "shortcut.invoke",
  tileAction: "tile.action",
  pluginsInstall: "plugins.install",
  pluginEnable: "plugin.enable",
  pluginDisable: "plugin.disable",
  pluginRemove: "plugin.remove",
  pluginSetConsent: "plugin.setConsent",
  routinesCreate: "routines.create",
  routinesList: "routines.list",
  routinesUpdate: "routines.update",
  routinesDelete: "routines.delete",
  memoryList: "memory.list",
  memoryRead: "memory.read",
  memoryWrite: "memory.write",
  memoryDelete: "memory.delete",
  memoryAudit: "memory.audit",
  providerConfigure: "provider.configure",
  workflowList: "workflow.list",
  workflowRun: "workflow.run",
  workflowStop: "workflow.stop",
  workflowGet: "workflow.get",
  syncHeads: "sync.heads",
  syncPull: "sync.pull",
  syncPush: "sync.push",
  syncConfig: "sync.config",
  syncMemory: "sync.memory",
  panelList: "panel.list",
  panelOpenTab: "panel.openTab",
  panelCloseTab: "panel.closeTab",
  panelActivateTab: "panel.activateTab",
  panelReportNavigation: "panel.reportNavigation",
} as const;
