import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_CODEX_MODEL } from "./providers/codex-config";
import { ensureGlobalGitignore, WINTER_PERSONAL_IGNORES } from "./global-gitignore";
import { OFFICIAL_SUBSCRIPTION_AUTH_APPROVED } from "./runtime-sdk/versions";

/** Reasoning-effort slugs valid on the wire — measured LIVE against the Codex OAuth endpoint
 *  (2026-07-30), one model at a time, NOT read off the /models catalogue text. That distinction
 *  matters: "ultra" was added here on 2026-07-10 from exactly that catalogue reading and was
 *  never checked against the request validator. Effort is global and hot-reloaded (every session
 *  re-resolves it every turn), so a persisted invalid slug doesn't fail at set-time — it breaks
 *  EVERY session with an opaque HTTP 400 one turn later.
 *
 *  There are TWO validation layers on the wire, and they disagree per-model — never infer one
 *  model's answer from another's:
 *   - "none" is genuinely HONOURED on all three gpt-5.6 models: the server echoes back
 *     `effort: "none"` in both response.created and response.completed, emits no reasoning item
 *     at all, and reports 0 reasoning tokens (the same model at "max" reports 42, proving the
 *     counter is live rather than always zero).
 *   - "ultra" is rejected by a DIFFERENT, GLOBAL enum layer (`invalid_value`, model-agnostic) —
 *     it is not a per-model gap, it is invalid everywhere. It must never be re-added here.
 *
 *  "minimal" is deliberately ABSENT from this list: it is rejected PER-MODEL (`unsupported_value`,
 *  the error naming the slug) rather than globally. A future read of the /models catalogue will
 *  list it right alongside the others that ARE valid — do not re-add it from that reading alone.
 *  That is exactly the mistake that put "ultra" here on 2026-07-10; verify per-model wire support
 *  first, the same way "none" and "ultra" were verified for this list. */
export const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;

/** WINTER-LEVEL effort tiers (provider-correctness T5) — selectable in Winter, **never on the wire**.
 *
 *  This is a STRICTLY DISJOINT vocabulary from `REASONING_EFFORTS` above, and the two live next to
 *  each other so nobody reads one without the other. `REASONING_EFFORTS` is what the endpoint's
 *  request validator accepts. A value here is a Winter product decision that is TRANSLATED to a wire
 *  effort (`wireEffort` below) before any request body exists, plus whatever local behaviour the
 *  tier names.
 *
 *  `ultra` belongs here precisely BECAUSE the wire refuses it — the same global `invalid_value`
 *  enum documented above. It was never a real API level; it was a catalogue misreading. What the
 *  user actually wanted from it (the thing that made it look real) is now what it means in Winter:
 *  `max` on the wire, plus a proactive-delegation posture in the system prompt
 *  (`ULTRA_DELEGATION_INSTRUCTION`, agent/context.ts). Code sessions only — see
 *  `clientEffortEligible`.
 *
 *  **Never merge these into `REASONING_EFFORTS`, and never let them into `effortsForModel`**
 *  (ipc/sync.ts): that function is the single source for BOTH what `sync.config` advertises as a
 *  model's levels AND what `session.setEffort` accepts as a wire effort, so a tier inside it would
 *  make the daemon advertise a value its own turn would be 400'd on — the original bug, arriving
 *  through the fix. Tiers ride `sync.config`'s own `clientEfforts` field instead. */
export const CLIENT_EFFORTS = ["ultra"] as const;
export type ClientEffort = (typeof CLIENT_EFFORTS)[number];

/** The WIRE effort each tier is translated to. A `Record<ClientEffort, …>` on purpose: adding a
 *  tier to `CLIENT_EFFORTS` without deciding what it sends is a TYPE ERROR here, not a runtime
 *  surprise at the request layer. The value type is pinned to `REASONING_EFFORTS` for the same
 *  reason — a mapping to something the wire refuses cannot be written. */
const CLIENT_EFFORT_WIRE: Record<ClientEffort, (typeof REASONING_EFFORTS)[number]> = {
  // "reason as hard as the endpoint allows" — the honest wire meaning of the tier.
  ultra: "max",
};

/** Whether `effort` is a Winter-level tier rather than a wire effort. Undefined (no selection) is
 *  not a tier. */
export function isClientEffort(effort: string | undefined): effort is ClientEffort {
  return effort !== undefined && (CLIENT_EFFORTS as readonly string[]).includes(effort);
}

/** Translate a SELECTED effort (a wire effort, a Winter tier, or nothing) into what may go on the
 *  wire. TOTAL by construction: every result is either `undefined` or a member of
 *  `REASONING_EFFORTS`, so no caller downstream of this can hand a tier to a provider. Applied at
 *  `AgentEngine.resolveSel` — the one place a session's stored effort becomes a request field. */
export function wireEffort(effort: string | undefined): string | undefined {
  if (effort === undefined) return undefined;
  return isClientEffort(effort) ? CLIENT_EFFORT_WIRE[effort] : effort;
}

/** Which session modes may SELECT a client tier: CODE ONLY.
 *
 *  A tier changes the system prompt, and chat/dispatch have their own base prompts and their own
 *  narrow toolsets (a chat session has no `spawn_agent` at all, so a delegation posture there would
 *  be an instruction to use a tool it does not have — the exact machine-touching-capability leak
 *  `skillToolOffered` exists to prevent, in a different slot).
 *
 *  An ALLOWLIST, deliberately fail-CLOSED, and deliberately NOT `engine.ts`'s `resolveMode` (which
 *  defaults an unrecognised mode to "code"). They agree on every mode that exists today; on a mode
 *  nobody has written yet they disagree, and "not this one" is the safe default for something that
 *  rewrites the prompt. `undefined` is code by the store-wide `mode ?? "code"` convention. */
export function clientEffortEligible(mode: string | undefined): boolean {
  return mode === undefined || mode === "code";
}

export const ProviderSettings = z.discriminatedUnion("type", [
  z.object({ type: z.literal("codex-oauth"), model: z.string().min(1), reasoningEffort: z.enum(REASONING_EFFORTS).optional() }),
  z.object({ type: z.literal("openai-compatible"), model: z.string().min(1), baseUrl: z.string().url(), reasoningEffort: z.enum(REASONING_EFFORTS).optional() }),
]);

export const PermissionsSettings = z.object({
  additionalDirectories: z.array(z.string()).optional(),
  /** CC-grammar allow-rules (SP-approvals T1, `agent/permission-rules.ts`'s `PermissionRules`
   *  class) — global-scope rule strings like `"Bash(git push:*)"`/`"Edit"`/`"Computer"`. Additive
   *  optional key: schemaVersion stays 2, no migration needed. Absent means "no global rules
   *  configured here"; the CC-parity `["Computer"]` default is NOT this field's default — it is
   *  applied by the daemon's OWN getter fallback (Task 3), so an explicit `"allow": []` can
   *  disable that default outright. */
  allow: z.array(z.string()).optional(),
  /** SP-approvals T10 (spec §7 "Web tools"): user-added dangerous-domain entries — the effective
   *  set web_fetch's pre-exec floor checks against is `agent/dangerous-domains.ts`'s
   *  SHIPPED_DANGEROUS_DOMAINS ∪ this array. Additive optional key: schemaVersion stays 2, no
   *  migration needed. Absent (or `added` absent) means "no user additions" — the shipped list
   *  alone is still enforced. Removing an entry HERE is how a user-added domain is removed; the
   *  shipped list itself is immutable by construction (there is no equivalent of `allow: []`'s
   *  "opt out of a default" for it — a shipped entry can never be deleted this way). */
  dangerousDomains: z.object({
    added: z.array(z.string()).optional(),
  }).optional(),
});

/** The default `runtimes.winterIdleTimeoutSec`, spelled once so the schema and the absent-block
 *  answer cannot drift (the same pairing `retention.ts` keeps for its two windows). */
export const DEFAULT_WINTER_IDLE_TIMEOUT_SEC = 900;

export const Settings = z.object({
  schemaVersion: z.literal(2),
  provider: ProviderSettings,
  permissions: PermissionsSettings.optional(),
  mcpServers: z.record(z.string(), z.object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })).optional(),
  reviewer: z.object({
    enabled: z.boolean().optional(),
    model: z.string().optional(),
    allow: z.array(z.string()).optional(),
    // Phase 5e T4: per-class on/off, subordinate to `enabled` — an `enabled:false` reviewer
    // never runs regardless of what's set here (engine.ts ANDs reviewerEnabled with
    // reviewClassEnabled at every call site). Absent block OR an absent per-class key means
    // enabled — same optional-means-default-true shape as engine.ts's own reviewClassEnabled.
    classes: z.object({
      bash: z.boolean().optional(),
      fs: z.boolean().optional(),
      external: z.boolean().optional(),
    }).optional(),
  }).optional(),
  titles: z.object({
    enabled: z.boolean().optional(),
    model: z.string().optional(),
  }).optional(),
  /** CC-parity output style: the active style NAME (built-in or a `.winter/output-styles/<name>.md`).
   *  Absent or "default" → Winter's base prompt (today's behavior). Hot-reloaded; per-project via the
   *  ProjectSettingsResolver. */
  outputStyle: z.string().optional(),
  plugins: z.object({
    enabled: z.array(z.string()).optional(),
    disabled: z.array(z.string()).optional(),
    /** Per-plugin per-permission-class consent records (design spec §1): { [pluginId]: { exec?:
     *  ts, tcc?: ts, hardware?: ts } }, timestamp = Date.now() at grant time. A class's presence
     *  (not its value) is what counts as consented — see plugins.ts#consentComplete. `disable`
     *  deletes a plugin's whole record (fresh-consent semantics, generalized from today's
     *  enabled-strip). */
    consents: z.record(z.string(), z.object({
      exec: z.number().optional(),
      tcc: z.number().optional(),
      hardware: z.number().optional(),
    })).optional(),
    /** PluginSupervisor lifecycle overrides (Phase 4b Task 3, spec §3 — all four values are
     *  spec-defaulted when omitted: registration timeout 10s, backoff cap 60s, circuit 5
     *  failures/10min). The invoke timeout (default 60s) and the SIGTERM→SIGKILL kill grace (5s)
     *  are deliberately NOT here — spec pins the former to the `WINTER_PLUGIN_TOOL_TIMEOUT_MS` env
     *  var and the latter isn't settings-overridable at all. */
    supervisor: z.object({
      registrationTimeoutMs: z.number().int().positive().optional(),
      backoffCapMs: z.number().int().positive().optional(),
      circuitFailures: z.number().int().positive().optional(),
      circuitWindowMs: z.number().int().positive().optional(),
    }).optional(),
  }).optional(),
  toolSearch: z.object({
    enabled: z.boolean().optional(),
    deferThreshold: z.number().int().positive().optional(),
    // "always": externals (mcp__/plugin__) defer whenever ANY is visible, ignoring deferThreshold's
    // count comparison entirely. Absent/"count" = today's threshold-count behavior, unchanged.
    deferExternals: z.enum(["count", "always"]).optional(),
  }).optional(),
  worktree: z.object({
    baseRef: z.enum(["fresh", "head"]).optional(),
  }).optional(),
  subagents: z.object({
    maxConcurrent: z.number().int().positive().optional(),
    // 4h-i Task 3 (CC parity: nesting depth up to 5): how many levels of spawn_agent nesting are
    // allowed — a thread at depth < maxDepth may spawn a child; a thread AT maxDepth cannot.
    // Default 5 when unset (engine.ts's `subagentMaxDepth ?? 5`) — matches Claude Code's fixed
    // max nesting depth of 5 (user decision 2026-07-11: "whatever Claude Code does"). Lower it
    // (e.g. `maxDepth: 1`, the pre-4h-i behavior where a depth-1 child could never spawn further)
    // to restrict nesting. Concurrency (maxConcurrent, default 4) and total fan-out are separate:
    // total spawns per session are UNLIMITED by design (user decision), bounded only by the
    // concurrency semaphore at any instant.
    // CC itself allows depth 5, hence the upper bound here.
    maxDepth: z.number().int().min(1).max(5).optional(),
    /** No-timeout task (user rule 2026-07-12): an EXPLICIT wall-clock cap per subagent run, in
     *  ms. ABSENT (the default) means NO wall clock at all — subagents are never killed just for
     *  running long (a legitimate laptop-wide scan died at the old always-on 300s cap; CC has no
     *  wall-clock subagent timeout either). Hot: read via a live getter (daemon.ts) — an edit
     *  applies to the very next subagent run, no daemon restart. */
    timeoutMs: z.number().int().positive().optional(),
    /** No-timeout task: the progress-STALL watchdog window, in ms — a subagent whose provider
     *  stream produces NO events for this long is aborted as stalled (its partial output is
     *  surfaced to the parent). ABSENT means the default 600000 (10 min — deliberately ≥ bash's
     *  own max per-call timeout, so a tool-bounded silent bash never falsely trips it; env
     *  override: WINTER_SUBAGENT_STALL_TIMEOUT_MS). Hot, same live-getter semantics as timeoutMs
     *  above. */
    stallTimeoutMs: z.number().int().positive().optional(),
  }).optional(),
  /** Peripheral lease v1 (Phase 2f, spec §A1): "Heartbeat 5s / expiry 15s (user-confirmed;
   *  settings-overridable peripheral.heartbeatMs/expiryMs)". Both optional — PeripheralBroker
   *  falls back to the spec defaults (5000/15000) when omitted. */
  peripheral: z.object({
    heartbeatMs: z.number().int().positive().optional(),
    expiryMs: z.number().int().positive().optional(),
  }).optional(),
  /** Computer use (Phase 5 CU). `enabled` is the capability opt-in: the `computer` tool is
   *  registered ONLY when true (the strongest reading of "full-auto CU requires explicit opt-in" —
   *  absent/false means CU does not exist for the session). `screenshotMaxDim` caps the longest
   *  side of a captured screenshot (default 1280, Winter.app-side) to bound the base64 payload well
   *  under the NDJSON line limit and the model's image budget. The lease heartbeat/expiry reuse the
   *  `peripheral` block above. */
  computerUse: z.object({
    enabled: z.boolean().optional(),
    screenshotMaxDim: z.number().int().positive().optional(),
  }).optional(),
  /** web_search backend (4g Task 6). `provider` defaults to "brave" when the block/field is
   *  absent — the literal union is forward-room for other search backends later; today "brave"
   *  is the only accepted value. */
  webSearch: z.object({
    provider: z.literal("brave").optional(),
  }).optional(),
  /** Plugin hooks runtime (Phase 4f, plan Global Constraints: "default true, read like other hot
   *  settings"). `enabled: undefined` (block absent OR field absent) means ENABLED — see
   *  `hooksEnabledFrom` below, the single place that decision is made. */
  hooks: z.object({
    enabled: z.boolean().optional(),
  }).optional(),
  /** Scheduled routines (Phase 5, design doc header — USER-DECIDED pin: "routines run in
   *  PARALLEL ... routines.maxConcurrent? settings knob, default unlimited"). Undefined (block or
   *  field absent) means unlimited — mirrors subagents.maxConcurrent's own optional-means-default
   *  shape above, read once at daemon boot (same boot-snapshot precedent as subagents.maxConcurrent,
   *  not hot-reloaded — routines/scheduler.ts's makeRoutineScheduler takes it as a `() => number |
   *  undefined` thunk purely to match its own injectable-dependency shape, not because this needs
   *  to change without a daemon restart). */
  routines: z.object({
    maxConcurrent: z.number().int().positive().optional(),
  }).optional(),
  /** LSP integration (Phase 5f; consolidated into the single `lsp` tool by lsp-consolidation T2,
   *  design doc `2026-07-15-lsp-consolidation-design.md`) over a lazily-spawned
   *  typescript-language-server/sourcekit-lsp. `enabled` is default-ON, the SAME boot-snapshot
   *  shape as `reviewer.enabled`/`titles.enabled` above (an explicit `false` is the only way to
   *  turn it off; block absent, field absent, or `true` all mean the `lsp` tool gets registered —
   *  daemon.ts's registerLspTools gate reads `settings?.lsp?.enabled !== false`).
   *  When off, the tool is never registered, so a model's query for it is the registry's
   *  ordinary "unknown tool" error — no special-cased denial path. `idleShutdownMs` threads
   *  straight into `new LspManager({idleShutdownMs})`; absent means the manager's own default
   *  (300_000 — 5 min, agent/lsp/manager.ts's DEFAULT_SCHEDULER-adjacent constant).
   *  `autoDiagnostics` (lsp-consolidation T3, design doc §2 — CC parity: "after each file edit, it
   *  automatically reports type errors and warnings so Claude can fix issues without a separate
   *  build step") is ALSO default-ON, same `!== false` shape — see `lspAutoDiagnosticsEnabledFrom`
   *  below, the one place that decision is made. Read LIVE (hot, per
   *  [[no-daemon-restart-for-settings]]) by engine.ts's post-write/edit/notebook_edit hook — a
   *  toggle applies to the session's NEXT edit, no restart. Independent of `enabled`: turning THIS
   *  off still leaves the on-demand `lsp` tool (action: diagnostics) usable; only the automatic
   *  post-edit append is skipped. */
  lsp: z.object({
    enabled: z.boolean().optional(),
    idleShutdownMs: z.number().int().positive().optional(),
    autoDiagnostics: z.boolean().optional(),
  }).optional(),
  /** Auto-update channel. "beta" additionally receives beta-tagged appcast items;
   *  absent/stable = stable only. Read live by the app at each update check (hot — no restart). */
  updates: z
    .object({
      channel: z.enum(["stable", "beta"]).optional(),
    })
    .optional(),
  /** File-based memory (MEMDIR, T1 — design doc `2026-07-15-file-based-memory-design.md`).
   *  `enabled` default-ON, the SAME `!== false` boot-snapshot-shaped default as `lsp.enabled`/
   *  `hooks.enabled` above, but read LIVE (hot, per [[no-daemon-restart-for-settings]]) by both
   *  daemon.ts's write-root join and context.ts's injection — a toggle takes effect on the
   *  session's NEXT tool call / turn, no restart. `directory` (absolute or `~/`-relative) replaces
   *  the computed `~/.winter/projects/<key>/memory` path entirely (CC's own relocatable-directory
   *  setting) — see memory-dir.ts's `memoryDirFor`. */
  memory: z
    .object({
      enabled: z.boolean().optional(),
      directory: z.string().optional(),
    })
    .optional(),
  /** Dynamic workflows (CC-parity phase 3). `enabled` default-ON (`!== false`, same shape as
   *  hooks/memory/lsp above): the deferred Workflow tool is registered + /ultracode active only when
   *  true. `keywordTrigger` default-ON: `/ultracode` is inert when false, but the tool is still
   *  available to the model. Hot-reloaded, per-project via the ProjectSettingsResolver. */
  workflows: z.object({
    enabled: z.boolean().optional(),
    keywordTrigger: z.boolean().optional(),
  }).optional(),
  /** The session cleaner (session-activity-hygiene T7, spec §3) — the LLM-judged pass that deletes
   *  old, idle, unjudged junk sessions. `enabled` default-ON (`!== false`, the same shape as
   *  hooks/memory/lsp/workflows above), read LIVE by daemon.ts's `cleanerEnabledHot` closure over
   *  the hot-swapped settings holder: turning it off stops the very NEXT pass, and turning it back
   *  on resumes at the next one, with no daemon restart in either direction (the project's standing
   *  no-restart-for-settings rule).
   *
   *  Deliberately does NOT gate the empty-session reaper (T6) — that path deletes only sessions
   *  with no content at all and is not a judgment. */
  cleaner: z.object({
    enabled: z.boolean().optional(),
  }).optional(),
  /** Runtime-state housekeeping (P8a, WS-16 §16). Hot like every other key here: the retention
   *  sweep re-reads this through a live getter on each pass, so widening or narrowing a window
   *  takes effect at the very next sweep with no daemon restart (the project's standing rule).
   *
   *  `.prefault({})` RATHER THAN `.default({})` on the two inner blocks, and the difference is not
   *  cosmetic: in zod 4 a `.default()` value is the parsed OUTPUT, handed back verbatim without
   *  descending — so `.default({})` would make `runtimes: {}` parse with `retention` and
   *  `migrations` UNDEFINED, and the shipped 30/7 defaults would exist only in this file's prose.
   *  `.prefault` feeds the value back through the schema, which is what actually fills them in.
   *
   *  The BLOCK ITSELF is `.optional()`, like every other top-level key in this schema, rather than
   *  defaulted. Two reasons, both about not moving things that already work: a defaulted block makes
   *  `runtimes` REQUIRED on the inferred `Settings` type, which breaks every hand-built settings
   *  literal in the codebase (35 of them); and `saveSettings` writes the parsed object verbatim, so
   *  it would start stamping these defaults into every user's settings.json — freezing today's
   *  values into files that should have kept following the shipped default. The 30/7 answer for an
   *  absent block therefore lives in `retention.ts`'s `retentionFromSettings`, which is the door
   *  every consumer actually reads, and which must answer for `undefined` settings anyway.
   *
   *  The two windows have a floor of one day and must be whole days: a zero would prune a delivery
   *  record in the same second its receipt landed, destroying the evidence WS-15 §6.4 needs to tell
   *  `delivered` from `delivery_uncertain`. Neither window can ever reach an UNRECEIPTED delivery or
   *  a HELD name lease — those are pruned at no age at all (see `directory-store.ts`); retention
   *  only ever shortens the tail of things that are already settled.
   *
   *  `migrations.memoryKeys` is OFF until a user turns it on: WS-16 §17 phase 5 relocates a user's
   *  own memory files, and that is not a thing an upgrade does on its own initiative.
   *
   *  WHEN IT IS ON, THE MIGRATION RUNS (P8b-17, Task 14 — 8a's build accepted the flag and ignored
   *  it, because the live memory path still derived today's key). Three things are worth knowing
   *  before turning it on: a home whose `memory.directory` (above) pins the MEMDIR is DECLINED
   *  rather than migrated — the project key decides nothing there — and a decline is not an attempt,
   *  so clearing that override later still gets the migration with no restart; a completed
   *  relocation is one-shot (a `schema_meta` marker), while a run that could not finish (a
   *  destination to clear, a cwd to restore) retries at the next boot; and a relocation interrupted
   *  between its rename and its commit is repaired at EVERY boot, flag or no flag, so turning the
   *  flag back off can never strand a half-moved tree. See `runtime-state/migrations/memory-keys.ts`.
   *
   *  ── The Winter leg (8b) ──────────────────────────────────────────────────────────────────────
   *
   *  `winterLeg` DECIDED, per mode, whether a NEW session ran on the Winter runtime or on the
   *  legacy engine (P8b-13) while both existed. Task 17 retired the engine: every mode runs on the
   *  Winter leg, the keys are accepted for one release and a `false` is logged and ignored
   *  (`winterLegDisabledKeys` below names them for the log). A flag governs new sessions only: a session runs to
   *  completion on the leg it was created with, which is what makes flipping one safe at any moment.
   *
   *  `winterExecutable` overrides the `winter` binary lookup (P8b-2's first door, ahead of
   *  `WINTER_RUNTIME_EXECUTABLE`, the bundle drop and `<WINTER_HOME>/runtimes/bin/winter`).
   *  `advisorModel` names the model the router's advisor uses. Both are plain `z.string()` on
   *  purpose — NOT `.min(1)` — because an invalid `settings.json` costs the WHOLE FILE: boot
   *  degrades to `settings = null` and the agent is disabled (`daemon.ts`'s load catch), and a hot
   *  edit is discarded entirely by the watcher ("settings reload failed, keeping previous"). One
   *  blank string must not be able to do that. Blank therefore means absent, and
   *  `winterOptionsFromSettings` below is the door that says so once for every consumer.
   *  (`winterIdleTimeoutSec`'s floor CAN invalidate the file the same way — that is the deliberate
   *  shape the retention windows already have, and the brief mandates it; it is stated here so the
   *  asymmetry reads as a decision rather than an oversight.)
   *
   *  `winterIdleTimeoutSec` ends an idle Winter child (P8b-24) — the session becomes `resumable` and
   *  its next message resumes it, so this is a memory bound, not a session lifetime. The floor is
   *  10s rather than 1: below that, a child would be reaped between a user's own keystrokes.
   *
   *  THE DEFAULTS ONLY MATERIALIZE WHEN THE BLOCK IS PRESENT, because the block is `.optional()`
   *  (see above — a defaulted block would make `runtimes` required on every settings literal in the
   *  codebase, and `saveSettings` would start stamping today's values into every user's file). So
   *  an absent block has to be answered for, and `winterOptionsFromSettings` below is the ONE place
   *  that does it — the same shape `retentionFromSettings` has for the windows. Read that door
   *  rather than the raw block, or three lanes each re-derive "absent means all legs false" and
   *  "blank means absent", and nothing fails to compile when one of them forgets. */
  runtimes: z.object({
    retention: z.object({
      deliveriesDays: z.number().int().min(1).default(30),
      nameLeasesDays: z.number().int().min(1).default(7),
    }).prefault({}),
    migrations: z.object({ memoryKeys: z.boolean().default(false) }).prefault({}),
    winterExecutable: z.string().optional(),
    // P8c-3: the same blank-is-absent, restart-free ladder rung as `winterExecutable` above, for the
    // official leg's `claude` executable (`official-executable.ts`'s `resolveClaudeExecutable`,
    // ahead of env `WINTER_CLAUDE_EXECUTABLE`, the 8d bundle drop and the dev-only package door).
    claudeExecutable: z.string().optional(),
    // Winter Phase 10a (Lane L's own rung — `bundle-layout.ts`'s `resolveAntExecutable` ladder):
    // same blank-is-absent shape as `claudeExecutable` above, for the bundled Anthropic Platform
    // CLI (`ant`) the console-profile broker spawns. Lane O adds only the schema line here; Lane L
    // owns the resolver that reads it.
    antExecutable: z.string().optional(),
    // Task 17 Step 4: the engine is retired — every mode runs on the Winter leg. The block stays
    // ACCEPTED for one release (the `migrations.memoryKeys` pattern): a `false` is read, logged
    // ("the engine leg no longer exists; ignored") and ignored by `winterOptionsFromSettings`.
    winterLeg: z.object({
      chat: z.boolean().default(true),
      dispatch: z.boolean().default(true),
      code: z.boolean().default(true),
    }).prefault({}),
    advisorModel: z.string().optional(),
    winterIdleTimeoutSec: z.number().int().min(10).default(DEFAULT_WINTER_IDLE_TIMEOUT_SEC),
    // Fix wave (whole-branch review C2 / ruling P8c-18): a `session.setModel` whose FRESH
    // destination decision names a DIFFERENT runtime leg than the session's recorded one is a
    // cross-runtime HANDOFF (`runtime-sdk/handoff.ts`). Winter Phase 10b (D1-1, W18-10, R-10b-1):
    // the real round-trip is now measured end to end (the whole-branch parity e2e coverage), so the
    // fence flips to default ON for Code sessions — chat and dispatch never reach the official leg
    // regardless (`select-runtime.ts`'s own mode gate), so they stay at the pre-10b "off" posture.
    // `crossRuntime` is deliberately left `.optional()` here rather than `.default()`ed, so a raw
    // parse can tell "never set" from an explicit `true`/`false` — same "absent isn't a value"
    // shape `winterExecutable`/`advisorModel` already have on this block. The MODE-AWARE default
    // lives in `handoffCrossRuntimeEnabled` below, the one door every reader goes through; an
    // explicit value here always overrides it, in every mode. `handoff.ts` reads this HOT
    // (`handoffCrossRuntimeEnabled(deps.settings(), mode)`), never a boot snapshot, same as every
    // other setting in this file.
    handoff: z.object({ crossRuntime: z.boolean().optional() }).prefault({}),
    // Phase 9c (P9c-1, the user's ruling on WS-00 §8 #1): the official leg authenticates ONLY with
    // Anthropic API-key material the user supplied to Winter. `subscriptionAuth: false` (the
    // default, and the ONLY shipped value until Anthropic approves subscription auth for Winter's
    // Agent SDK integration) means the spawned `claude` child gets a Winter-owned
    // `CLAUDE_CONFIG_DIR`, an env scrubbed of every auth-injecting variable except the one the
    // credential plan names, and a per-session assertion on the SDK's reported `apiKeySource`.
    // Read HOT (`official-options.ts`), never a boot snapshot.
    official: z.object({
      subscriptionAuth: z.boolean().default(false),
      // Winter Phase 10a (P10a-3): which credential the official leg's spawned `claude` child
      // authenticates with. "auto" (the default) picks the console profile when one exists
      // (`<home>/runtimes/anthropic-config/credentials/winter.json`) and falls back to the
      // Anthropic API-key material otherwise; "api-key"/"console" pin one arm explicitly. Read
      // HOT via `officialAuthModeSetting` below, never a boot snapshot — same posture as
      // `subscriptionAuth` beside it.
      auth: z.enum(["auto", "api-key", "console"]).default("auto"),
    }).optional(),
  }).optional(),
  // Phase 9c (P9c-4, the user's ruling on WS-00 §8 #7): Winter reads a project's unconverted legacy
  // instructions file / project dir (`legacy-names.ts`'s `LEGACY_INSTRUCTIONS_FILE` / `LEGACY_PROJECT_DIR`) READ-ONLY when the Winter-named file/dir is absent and this is true —
  // with a visible per-project deprecation notice; `winter migrate-project` converts. Default ON,
  // indefinitely, until a later release flips the default. Read HOT, never a boot snapshot.
  // OPTIONAL (not prefaulted) for the same reason `runtimes` is: a prefaulted block becomes REQUIRED on
  // the inferred `Settings` type and breaks every hand-built settings literal. Absent block = default
  // ON; readers go through `legacyProjectFilesReadEnabled()` below, never the raw block.
  /**
   * WS-19 (W19-6): per-provider connection overrides, keyed by the CATALOG provider id
   * (`deepseek`, `zai`, `openrouter`, …) — the same ids `credential.list` reports and
   * `credential.set` writes a slot for.
   *
   * There is NO daemon-side endpoint table and there must never be one: the catalog ships every
   * provider's own `defaultEndpoints`, and the SDK's `connectionFrom` copies them for the
   * multi-provider adapters (deepseek/zai/openrouter/xai all ride `winter.openai-chat-completions`).
   * This block exists only for the case the SDK cannot answer — a self-hosted or proxied endpoint
   * for a provider whose shipped endpoint is not where the user's account lives, and the loopback
   * fakes the parity e2e tests point at.
   *
   * ABSENT IS THE NORMAL CASE. An entry without a `baseUrl` is the same as no entry: the session
   * gets no `connection` at all and the SDK fills the catalog endpoint.
   *
   * `settings.provider.baseUrl` (the legacy single-provider `openai-compatible` arm) KEEPS
   * PRECEDENCE for `openai` and is byte-identical to what it was — a home that configured BYO
   * OpenAI that way is untouched by this block existing.
   *
   * Read HOT at every incarnation (`session-driver.ts`'s `optionsFor` calls `deps.settings()`), so
   * adding or changing an endpoint takes effect on the next turn with no daemon restart — the
   * project's standing rule.
   *
   * `.url()` rather than a bare string, unlike `runtimes.winterExecutable`: a malformed endpoint
   * cannot be treated as "absent" the way a blank executable path can, because the only other
   * reading is "send the user's credential to whatever this parses as".
   */
  providers: z.record(z.string(), z.object({ baseUrl: z.string().url().optional() })).optional(),
  legacy: z.object({ readLegacyProjectFiles: z.boolean().default(true) }).optional(),
});
export type Settings = z.infer<typeof Settings>;

/** Phase 9c (P9c-4): the ONE reader of `legacy.readLegacyProjectFiles` — absent block or absent key
 *  means ON (the shipped default); only an explicit `false` turns the legacy read-only fallback off. */
export function legacyProjectFilesReadEnabled(settings: Settings | null | undefined): boolean {
  return settings?.legacy?.readLegacyProjectFiles ?? true;
}

/** WS-19 (W19-6): the ONE reader of `providers.<id>.baseUrl` — absent block, absent entry, absent
 *  key and a blank string all mean "no override", so callers never have to spell that themselves.
 *  The legacy `provider.baseUrl` arm is NOT consulted here; `session-driver.ts` checks it first and
 *  only reaches this when it did not apply. */
export function providerBaseUrlFor(settings: Settings | null | undefined, providerId: string): string | undefined {
  const url = settings?.providers?.[providerId]?.baseUrl;
  return url === undefined || url.length === 0 ? undefined : url;
}

/**
 * Phase 9c (P9c-1) / pre-release hardening: the ONE reader of `runtimes.official.subscriptionAuth`
 * — absent means OFF (blocked); only an explicit `true` on the SETTINGS FLAG opens the door, and
 * even then only while the compile-time approval gate (`OFFICIAL_SUBSCRIPTION_AUTH_APPROVED`,
 * `runtime-sdk/versions.ts`) is also `true`. Before this hardening the settings flag alone could
 * flip the official leg's subscription posture — this ANDs the two so a hand-set (or migrated,
 * or mis-synced) `true` in settings.json can never do that on its own; only a reviewed code change
 * to the compile-time constant can. `approved` defaults to the real constant and exists ONLY as an
 * injectable seam for tests that need to exercise the "approved" branch — production callers must
 * never pass it.
 */
export function officialSubscriptionAuthEnabled(
  settings: Settings | null | undefined,
  approved: boolean = OFFICIAL_SUBSCRIPTION_AUTH_APPROVED,
): boolean {
  return approved && (settings?.runtimes?.official?.subscriptionAuth ?? false);
}

/**
 * Pre-release hardening (P9c-1 amendment): true when the settings file's raw flag is `true` but
 * the compile-time approval gate is not — i.e. the flag is currently INERT and every settings
 * change while it stays set should say so exactly once (`settings-apply.ts`'s hot-reload diff,
 * `daemon.ts`'s boot-time check). Never the inverse of `officialSubscriptionAuthEnabled`: an
 * absent/false raw flag is not "inert", it is simply off and unremarkable.
 */
export function officialSubscriptionAuthFlagInert(
  settings: Settings | null | undefined,
  approved: boolean = OFFICIAL_SUBSCRIPTION_AUTH_APPROVED,
): boolean {
  return !approved && (settings?.runtimes?.official?.subscriptionAuth ?? false);
}

/** Winter Phase 10a (P10a-3): the ONE reader of `runtimes.official.auth` — absent block or absent
 *  field both mean `"auto"` (the schema's own default only materializes once `runtimes.official`
 *  itself is present, same "an absent block is not unknown" rule every sibling getter in this file
 *  follows). Deliberately total (`null`/`undefined` settings both answer `"auto"`) for the same
 *  boot-degraded-to-`settings=null` reason `handoffCrossRuntimeEnabled` is total. Read HOT by
 *  `official-options.ts`'s `officialAuthFamilyFor`, never a boot snapshot. */
export function officialAuthModeSetting(settings: Settings | null | undefined): "auto" | "api-key" | "console" {
  return settings?.runtimes?.official?.auth ?? "auto";
}

/** The one place `hooks.enabled`'s default-ON semantics live (4f Task 2): absent block, absent
 *  field, or `enabled: true` all mean hooks run; only an explicit `false` turns them off. Kept as
 *  a pure `Settings -> boolean` helper (not inlined at each call site) so both the daemon's hot
 *  settings-reader (daemon.ts, re-reads settings.json per call, mtime-cached — same pattern as
 *  providers/manager.ts's `liveModel`) and this file's own tests exercise the SAME decision. */
export const hooksEnabledFrom = (s: Settings): boolean => s.hooks?.enabled !== false;

/** Fix wave (C2 / P8c-18); Winter Phase 10b (D1-1, W18-10, R-10b-1): the ONE door
 *  `runtime-sdk/handoff.ts` reads before letting a `session.setModel` cross a runtime leg.
 *
 *  An EXPLICIT `true`/`false` on `runtimes.handoff.crossRuntime` always wins, in every mode — the
 *  schema leaves the field `.optional()` (no `.default()`) precisely so this function can tell
 *  "the user never set it" from "the user set it to false" (see the schema comment above).
 *
 *  Absent (never set) falls back to the MODE-AWARE default: ON for Code, OFF for chat/dispatch.
 *  `mode` follows the file-wide `mode ?? "code"` convention (`clientEffortEligible` above is the
 *  same shape) — an omitted mode reads as Code, never as "unknown". Chat and dispatch sessions
 *  never reach the official leg regardless of this flag (`select-runtime.ts`'s own mode gate), so
 *  their OFF default is belt-and-suspenders, not a behavioural fence on its own.
 *
 *  Deliberately total (`null`/`undefined` settings both fall through to the mode-aware default,
 *  never a throw) for the same boot-degraded-to-`settings=null` reason every getter here is total. */
export function handoffCrossRuntimeEnabled(s: Settings | null | undefined, mode?: string): boolean {
  const explicit = s?.runtimes?.handoff?.crossRuntime;
  if (explicit !== undefined) return explicit;
  return mode === undefined || mode === "code";
}

/** What the Winter leg actually runs with, for a home whose `runtimes` block may not exist at all. */
export interface WinterOptions {
  /** Absent when unset OR blank — never `""`. See `winterOptionsFromSettings`. */
  winterExecutable?: string;
  /** P8c-3's own rung, same blank-is-absent rule. Read only by the official leg's ladder — inert on
   *  a Winter-only session. */
  claudeExecutable?: string;
  /** Winter Phase 10a (Lane L's `bundle-layout.ts` `resolveAntExecutable` ladder), same
   *  blank-is-absent rule. Read only by the console-profile broker (`daemon.ts`, O6) — inert
   *  everywhere else. */
  antExecutable?: string;
  advisorModel?: string;
  idleTimeoutSec: number;
  winterLeg: { chat: boolean; dispatch: boolean; code: boolean };
}

/**
 * THE DOOR EVERY WINTER-LEG CONSUMER READS (`resolveWinterExecutable`, `createWinterRuntimeSdk`,
 * `legForNewSession`, the idle timer), and the reason it exists rather than three lanes each
 * reaching into `settings.runtimes`.
 *
 * It answers the two conventions the raw block cannot:
 *
 *   AN ABSENT BLOCK IS NOT UNKNOWN. `runtimes` is `.optional()` (a defaulted block would make it
 *   required on every settings literal in this codebase and would have `saveSettings` stamp today's
 *   values into every user's file), so zod's per-key defaults never materialize for a home that has
 *   never configured it. Absent means all three legs OFF and 900 seconds — stated here, once.
 *
 *   BLANK MEANS ABSENT. `winterExecutable: ""` is a user clearing the field, not a path to an
 *   executable at the filesystem root; `advisorModel: ""` is not a model id. Both are trimmed to
 *   `undefined` so no consumer has to remember (the same rule `memory.directory` follows in
 *   `memory-dir.ts`), and neither can invalidate the whole settings file the way a `.min(1)` would.
 *
 * Deliberately total: it takes `null`/`undefined` settings, because the daemon boots with
 * `settings = null` when `settings.json` is missing or invalid and every getter here must still
 * answer.
 */
/** The `winterLeg` keys a settings file sets to `false` — accepted, logged, ignored (Task 17). */
export function winterLegDisabledKeys(s: Settings | null | undefined): string[] {
  const leg = s?.runtimes?.winterLeg;
  if (leg === undefined) return [];
  return (["chat", "dispatch", "code"] as const).filter((m) => leg[m] === false);
}

export function winterOptionsFromSettings(s: Settings | null | undefined): WinterOptions {
  const r = s?.runtimes;
  const blankIsAbsent = (v: string | undefined): string | undefined => {
    const trimmed = v?.trim();
    return trimmed ? trimmed : undefined;
  };
  return {
    ...(blankIsAbsent(r?.winterExecutable) === undefined ? {} : { winterExecutable: blankIsAbsent(r?.winterExecutable)! }),
    ...(blankIsAbsent(r?.claudeExecutable) === undefined ? {} : { claudeExecutable: blankIsAbsent(r?.claudeExecutable)! }),
    ...(blankIsAbsent(r?.antExecutable) === undefined ? {} : { antExecutable: blankIsAbsent(r?.antExecutable)! }),
    ...(blankIsAbsent(r?.advisorModel) === undefined ? {} : { advisorModel: blankIsAbsent(r?.advisorModel)! }),
    idleTimeoutSec: r?.winterIdleTimeoutSec ?? DEFAULT_WINTER_IDLE_TIMEOUT_SEC,
    // Task 17 Step 4: the engine leg no longer exists. Every mode answers `true` whatever the block
    // says; a written `false` is reported by `settings-apply.ts` and by the boot log, never obeyed.
    winterLeg: { chat: true, dispatch: true, code: true },
  };
}

/** Same default-ON shape as `hooksEnabledFrom` above: absent block, absent field, or `true` all
 *  mean file-based memory is on; only an explicit `false` turns it off. The single place this
 *  decision is made — daemon.ts's write-root join and context.ts's injection gate both call this
 *  (via a live getter over the `settings` holder) rather than re-deriving it inline. */
export const memoryEnabledFrom = (s: Settings): boolean => s.memory?.enabled !== false;

/** Same default-ON shape as `hooksEnabledFrom`/`memoryEnabledFrom` above: absent block, absent
 *  field, or `true` all mean the dynamic Workflow tool is registered and `/ultracode` is active;
 *  only an explicit `false` turns the whole feature off. The single place THIS decision is made —
 *  daemon.ts's `workflowsEnabled` getter (mirrors reviewerEnabled/toolSearch's own per-project,
 *  hot-reloaded shape) calls this rather than re-deriving it inline. */
export const workflowsEnabledFrom = (s: Settings): boolean => s.workflows?.enabled !== false;
/** Same default-ON shape as `workflowsEnabledFrom` just above, but gates ONLY the `/ultracode`
 *  keyword trigger — an explicit `false` here leaves the Workflow tool itself registered and
 *  available to the model; it just stops treating the keyword as an implicit invocation. */
export const keywordTriggerEnabledFrom = (s: Settings): boolean => s.workflows?.keywordTrigger !== false;

/** Same default-ON shape as `memoryEnabledFrom`/`hooksEnabledFrom` above: absent block, absent
 *  field, or `true` all mean auto-diagnostics-after-edit is on; only an explicit `false` turns it
 *  off. The single place THIS decision is made — engine.ts's post-write/edit/notebook_edit hook
 *  calls this (via a live getter over the `settings` holder) rather than re-deriving it inline. */
export const lspAutoDiagnosticsEnabledFrom = (s: Settings): boolean => s.lsp?.autoDiagnostics !== false;

/** session-activity-hygiene T7: same default-ON shape as `memoryEnabledFrom`/`workflowsEnabledFrom`
 *  above — absent block, absent field, or `true` all mean the session cleaner's pass runs; only an
 *  explicit `false` turns it off. The single place THIS decision is made: daemon.ts's
 *  `cleanerEnabledHot` live getter calls it rather than re-deriving the `!== false` shape inline,
 *  so the two can never drift. */
export const cleanerEnabledFrom = (s: Settings): boolean => s.cleaner?.enabled !== false;

// gpt-5.4 was the pre-deprecation default; fully deprecated per the 2026-07-10 user decision
// (packages/core/src/providers/codex-config.ts) — a fresh v1→v2 migration must not persist a
// dead slug to disk, so this points at the current default instead.
const DEFAULT_PROVIDER = { type: "codex-oauth", model: DEFAULT_CODEX_MODEL } as const;

export function loadSettings(path: string): Settings {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`settings file not found at ${path} — run \`winter daemon run\` once to initialize`);
    }
    throw err;
  }
  if (raw.schemaVersion !== 2) {
    // v1-or-legacy file (Phase 0 wrote {schemaVersion:1}; the retired v1 app wrote files with
    // no schemaVersion at all — same directory on case-insensitive APFS). Migrate to v2,
    // preserving unknown fields so nothing is silently lost.
    const { schemaVersion: _legacy, ...preserved } = raw;
    const migrated = { ...preserved, schemaVersion: 2 as const, provider: DEFAULT_PROVIDER };
    writeFileSync(path, JSON.stringify(migrated, null, 2) + "\n");
    // zod v4 z.object() strips unknown keys by default (does NOT throw) — safe to parse migrated
    return Settings.parse(migrated);
  }
  const parsed = Settings.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`settings.json is invalid: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")} — fix or delete ${path}`);
  }
  return parsed.data;
}

export function saveSettings(path: string, s: Settings): void {
  Settings.parse(s); // validate before writing — never persist an invalid settings file
  writeFileSync(path, JSON.stringify(s, null, 2) + "\n");
}

/** Parse a settings file to a raw object for OVERLAY merging (no zod, no migration) — absent/torn → null. */
export function readRawSettings(path: string): Record<string, unknown> | null {
  try {
    const o = JSON.parse(readFileSync(path, "utf8"));
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
}

/** Pure `Settings -> Settings` provider-model transform (mirrors plugins/lifecycle.ts's
 *  `setPluginEnabled` pattern) — used by `winter model <slug>`. Preserves every other field,
 *  including `provider.reasoningEffort` if set. Validation (codex-oauth slug membership,
 *  non-empty for openai-compatible) is the CALLER's job — this never throws on the slug itself,
 *  only on whatever Settings.parse would already reject (e.g. an empty string, caught by the
 *  schema's `z.string().min(1)`). */
export function setProviderModel(settings: Settings, model: string): Settings {
  return { ...settings, provider: { ...settings.provider, model } };
}

/** Pure Settings→Settings: set the active output style (or clear it for undefined/"default").
 *  Preserves every other field — mirrors setProviderModel. */
export function setOutputStyle(settings: Settings, name: string | undefined): Settings {
  const next = { ...settings };
  if (!name || name === "default") delete next.outputStyle;
  else next.outputStyle = name;
  return next;
}

/** Pure `Settings -> Settings` reasoning-effort transform — used by `winter model --effort
 *  <level>` (effort-only or combined with a model change). `effort: undefined` clears it. */
export function setReasoningEffort(settings: Settings, effort: (typeof REASONING_EFFORTS)[number] | undefined): Settings {
  return { ...settings, provider: { ...settings.provider, reasoningEffort: effort } };
}

/**
 * Winter Phase 8d (P8d-8): pure `Settings -> Settings` transform for THE ONE D30 advisor
 * setting (`settings.runtimes.advisorModel`) — used by `winter model --advisor <slug|auto>`
 * (Task 4.3) and the Mac app's composer-chip picker (Swift side writes the JSON file directly,
 * same "no daemon RPC needed" posture this function's CLI caller takes). `model: undefined`
 * clears the override, mirroring `setReasoningEffort`'s own `effort: undefined` convention — the
 * router then applies D30's per-family defaults (OpenAI family → astra, Claude family → fable,
 * else the session's own model), never a fabricated slug written here.
 *
 * Preserves every OTHER key already under `runtimes` (retention/migrations/winterExecutable/etc.)
 * — a shallow merge one level in, mirroring `provider.configure`'s own handler-side merge
 * (`ipc/server.ts`) rather than replacing the whole block. `settings.runtimes` may be absent
 * entirely (it is `.optional()`); spreading `undefined` is a no-op object literal, so the first
 * write on a home with no `runtimes` block yet still produces a schema-valid one.
 */
export function setAdvisorModel(settings: Settings, model: string | undefined): Settings {
  // `Record<string, unknown>` rather than `Settings["runtimes"]`: that type's OTHER fields
  // (`retention`/`migrations`/`winterLeg`/`winterIdleTimeoutSec`/`handoff`) are non-optional in
  // zod's INFERRED output type (`.prefault({})` fills them during validation), but this function
  // — like `saveSettings` itself (which persists its argument VERBATIM, never the parsed/defaulted
  // result) — must be able to write a `runtimes` block that omits them, exactly as a home that has
  // never touched `runtimes` at all has none of them on disk either. The cast back on `return` is
  // the honest boundary: `Settings.parse` (inside `saveSettings`) is what actually re-validates
  // this shape before it is ever persisted.
  const runtimes: Record<string, unknown> = { ...settings.runtimes };
  const trimmed = model?.trim();
  if (trimmed) runtimes.advisorModel = trimmed;
  else delete runtimes.advisorModel;
  return { ...settings, runtimes: runtimes as Settings["runtimes"] };
}

function expandTilde(p: string): string {
  return p.startsWith("~/") || p === "~" ? join(homedir(), p.slice(1)) : p;
}

function readDirs(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const dirs = raw?.permissions?.additionalDirectories;
    return Array.isArray(dirs) ? dirs.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Merge additionalDirectories across scopes (Claude-Code-style). BOTH the COMMITTED
 * <projectDir>/.winter/settings.json AND the gitignored settings.local.json are honored ONLY when
 * `projectTrusted` — a repo can't silently widen the fence until the user trusts the folder.
 * fix-wave A2: settings.local.json used to be honored unconditionally ("gitignored, always"), but
 * gitignore is advisory, not a trust boundary — a repo can `git add -f` one, so it needs the same
 * gate the committed file gets (matches CC). Only the user's OWN ~/.winter/settings.json is always
 * honored, trust-independent.
 */
export function loadPermissionDirs(homeDir: string, projectDir?: string, projectTrusted = false): string[] {
  const sources = [join(homeDir, "settings.json")]; // user global — always
  if (projectDir && projectTrusted) {
    sources.push(join(projectDir, ".winter", "settings.json"));      // committed — trust-gated
    sources.push(join(projectDir, ".winter", "settings.local.json")); // local: a repo can force-commit one → also trust-gated (matches CC)
  }
  const merged: string[] = [];
  for (const src of sources) {
    for (const d of readDirs(src)) {
      const e = expandTilde(d);
      if (!merged.includes(e)) merged.push(e);
    }
  }
  return merged;
}

/** Persist a runtime-granted directory to the project's local (gitignored) settings. */
export function addLocalDir(projectDir: string, dir: string): void {
  const dotWinter = join(projectDir, ".winter");
  mkdirSync(dotWinter, { recursive: true });
  const path = join(dotWinter, "settings.local.json");
  let obj: any = {};
  if (existsSync(path)) {
    try {
      obj = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      obj = {};
    }
  }
  obj.permissions ??= {};
  obj.permissions.additionalDirectories ??= [];
  if (!obj.permissions.additionalDirectories.includes(dir)) obj.permissions.additionalDirectories.push(dir);
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
  ensureGlobalGitignore(WINTER_PERSONAL_IGNORES);
}
