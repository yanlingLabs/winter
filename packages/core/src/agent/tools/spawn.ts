import { z } from "zod";
import type { ToolRegistry } from "./registry";

/** Registers spawn_agent with a placeholder run(). The engine intercepts spawn_agent tool calls
 *  before run() fires whenever cfg.subagents AND cfg.agents are both set (daemon.ts) AND the
 *  calling thread is depth 0 (see the parallel bridge in engine.ts's runThread dispatch loop,
 *  mirroring the exit_plan_mode/worktree bridges) — this placeholder only fires outside that flow
 *  (cfg.subagents/cfg.agents absent), or is never reached at all when the bridge is wired, since
 *  the engine short-circuits execution for spawn_agent calls before executeCall runs.
 *
 *  `models` (4e gate F9, design upgrade): the calling provider's own `models()` ids, when the
 *  provider enumerates a known set (e.g. codex-oauth's gpt-5.6 trio). When non-empty, the `model`
 *  arg is a CLOSED zod `enum` — not just a free string — so the JSON schema the model actually
 *  sees in the tools array (`ToolRegistry.specs()` → `z.toJSONSchema`, confirmed to serialize a
 *  zod enum as `{"type":"string","enum":[...]}`) constrains the choice at the source, the same
 *  "pick from the list" pattern Claude Code uses for its own tool enums — rather than relying on
 *  a model reading prose and guessing anyway (the live defect this fixes: a hallucinated id like
 *  "gpt-5-mini"). The description clause ALSO enumerates the ids (some clients render enums
 *  poorly / strip schema detail before showing the model the tool). Omitted, or the calling
 *  provider's models() is empty (e.g. openai-compatible against an arbitrary endpoint it can't
 *  enumerate), falls back to a plain `z.string().optional()` — unchanged behavior.
 *
 *  IMPORTANT: this schema enum is NOT the runtime gate. The engine's spawn bridge intercepts
 *  spawn_agent calls and hand-parses `call.argsJson` directly (engine.ts's spawn bridge, ~line
 *  488) BEFORE this tool's own zod validation would ever run — so a provider that ignores its own
 *  declared schema (or a client that strips it) could still send an out-of-enum string through.
 *  The bridge's OWN `known.some(m => m.id === effectiveOverride)` check (engine.ts) is what
 *  actually rejects it at runtime; this schema is defense-in-depth / the steering half of a
 *  two-layer gate — same shape as the plugin consent re-gate precedent (schema/UX nudge one layer,
 *  authoritative runtime check the other), not a replacement for it. */
export function registerSpawnAgentTool(r: ToolRegistry, opts: { models?: string[] } = {}): void {
  const hasModels = !!opts.models && opts.models.length > 0;
  const modelField = hasModels
    ? z.enum(opts.models as [string, ...string[]]).optional()
    : z.string().optional();
  const modelClause = hasModels
    ? `model: optional override, one of: ${opts.models!.join(", ")} (omit to inherit the session model)`
    : "model: optional model override";
  // `mode` (4h-i, CC parity: Agent's permission-mode override): a RESTRICT-ONLY override of the
  // child's approval policy. The runtime enforcement lives in engine.ts's spawn bridge
  // (restrictPolicy/mapSpawnMode) — this schema enum is the same two-layer shape as `model`
  // above (steering/UX one layer, the bridge's own hand-parsed check the authoritative one),
  // since the bridge hand-parses call.argsJson BEFORE this zod schema would ever run. The child
  // can only end up MORE restrictive than this session's own policy, never less — a request that
  // would widen permissions (e.g. this session is "ask" and the child asks for
  // "bypassPermissions") is silently ignored and the child keeps this session's policy.
  // `isolation` (4h-i Task 4, CC parity: Agent.isolation): "worktree" runs the child in a
  // fresh git worktree — an isolated copy of the repo — instead of the parent's own cwd. Same
  // two-layer shape as `model`/`mode` above: the engine's spawn bridge hand-parses argsJson
  // BEFORE this zod schema would ever run, and is the ONLY thing that actually creates/tears
  // down the worktree (via WorktreeManager's stateless createDetached/removeDetached, NOT the
  // per-session enter()/exit() a user's own enter_worktree/exit_worktree calls use — a child's
  // isolation worktree must never collide with the session's own active-worktree state).
  const SpawnArgs = z.object({
    prompt: z.string().min(1),
    agentType: z.string().optional(),
    model: modelField,
    description: z.string().min(1),
    max_turns: z.number().int().positive().max(50).optional(),
    mode: z.enum(["default", "plan", "acceptEdits", "dontAsk", "bypassPermissions"]).optional(),
    isolation: z.literal("worktree").optional(),
    // 5a (USER pin: background children, CC parity): at depth 0 with the bg registry wired
    // (daemon.ts), the engine's spawn bridge now DEFAULTS this to detached — omitted means
    // background, `false` opts into the synchronous await instead. From WITHIN a child (depth>0),
    // or a depth-0 session with no registry wired, the default stays synchronous — `true` opts
    // into detaching there. Detached, the engine does NOT await the child — it starts it (still
    // through SubagentManager's slot limit + depth cap) and returns `{agentId, status:"running"}`
    // immediately so the CALLING thread's turn continues without waiting. The child's threadId IS
    // its agentId (BackgroundAgentRegistry, bg-agent-registry.ts) — agent_list/agent_output poll
    // it, send_message re-tasks it, task_stop kills it, and `resume` continues it once finished.
    // Same two-layer shape as `model`/`mode`/`isolation` above: the engine's spawn bridge hand-
    // parses argsJson BEFORE this zod schema would ever run, and is the ONLY thing that actually
    // branches sync vs. detached.
    run_in_background: z.boolean().optional(),
    // `name` (4h-ii-b Task 2, CC parity: a stable per-session handle): a short human-readable
    // name for this child, registered alongside its agentId in BackgroundAgentRegistry
    // (bg-agent-registry.ts) — a later `resume`/`send_message` (Tasks 3-4) can then address the
    // agent by this name instead of its opaque agentId. Same two-layer shape as the other args
    // above: the engine's spawn bridge hand-parses argsJson BEFORE this zod schema would ever
    // run and is the ONLY thing that actually registers/collision-checks it. A name already in
    // use by a DIFFERENT agent in this session fails the spawn as a typed isError tool_result;
    // omitted → the child is addressable by agentId only, unchanged from before this arg.
    name: z.string().min(1).max(64).optional(),
    // `resume` (4h-ii-b Task 3, CC parity: continue a finished agent): an agentId or `name` of a
    // FINISHED child in this session to CONTINUE with its full prior context (its own message +
    // tool history), re-running the SAME child thread rather than spawning a fresh one. Requires a
    // `prompt` (the new instruction). Same two-layer shape as the args above: the engine's spawn
    // bridge hand-parses argsJson BEFORE this zod schema would ever run and is the ONLY thing that
    // actually looks the agent up / replays its thread — a resume of a still-running agent, an
    // unknown one, or one without a prompt fails as a typed isError tool_result. Omitted → today's
    // fresh-spawn behavior, unchanged.
    resume: z.string().min(1).optional(),
  });
  r.register({
    name: "spawn_agent",
    description:
      "Launch a child agent to handle a task autonomously with its own fresh context. It runs its own tool loop and returns its final report. " +
      "Its full transcript is also saved to a file (path included in the result/notification, and via agent_output) you can read/glob/grep — it can be large, so grep it or read it with offset/limit rather than reading it whole. " +
      "Delegate multi-step work; run several in parallel by emitting multiple spawn_agent calls in one message. " +
      "The child does NOT see this conversation — put everything it needs in `prompt`. " +
      `agentType: optional subagent type; ${modelClause}; description: a short (3-5 word) summary of the task (required); ` +
      "max_turns: optional cap (1-50) on the child's own tool-use iterations, after which it stops with an error (omit to use the default child cap — your own thread has no such cap, so there is nothing to inherit); " +
      "mode: optional child permission-mode override (default/plan/acceptEdits/dontAsk/bypassPermissions) — RESTRICT-ONLY: it can only make the child MORE restrictive than this session, never less; a request that would widen permissions is ignored and the child keeps this session's policy. " +
      "isolation: optional; \"worktree\" runs the child in a fresh git worktree (an isolated copy of the repo, not the parent's own working directory) — its read/write/edit/glob/grep and foreground bash are fenced to that worktree (note: a background bash task it starts is NOT yet fenced and still runs against the session's own working directory); the worktree is automatically removed when the child finishes IF it's clean (no uncommitted changes), otherwise it's left on disk for you to review (no auto-merge). Requires the session's cwd to be a git repository. " +
      "run_in_background: optional, and its default DEPENDS on where you're calling from. At the top level: spawns run in the background BY DEFAULT — the call returns `{agentId, status:\"running\"}` immediately, your turn continues right away, you're notified when the child finishes, and agent_list/agent_output fetch its status/results on demand; pass `run_in_background: false` to wait instead and get the child's final report directly in this tool_result. From WITHIN a child agent: spawns wait BY DEFAULT (today's synchronous behavior); pass `run_in_background: true` to detach that grandchild instead. Either way, a detached child has no wall-clock timeout but still stops at its own `max_turns` cap or if you call task_stop on it. " +
      "name: optional stable handle (1-64 chars) for this child, unique per session — lets you address it later by name instead of its agentId; a name already in use by a different agent in this session is rejected. " +
      "resume: optional; an agentId or name of a FINISHED child to continue with its full prior context (it remembers its earlier work) instead of spawning a fresh one — still supply `prompt` with the new instruction. Resuming a still-running agent, an unknown one, or omitting the prompt is rejected.",
    args: SpawnArgs,
    run(_args: z.infer<typeof SpawnArgs>) {
      return "subagents are not available in this session";
    },
  });
}
