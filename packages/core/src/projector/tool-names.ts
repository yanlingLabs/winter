/**
 * ── TEMPORARY, PRIVATE TO `projector/` — controller ruling P8b-25 ───────────────────────────────
 *
 * **The policy lane owns the canonical shared table at `runtime-sdk/tool-names.ts`. This module is
 * a stand-in until that lands: in Task 11 (after this lane rebases onto integration) the projector
 * switches its import to that module and THIS FILE IS DELETED.** Do not add a second consumer.
 *
 * ── WHY THE MAPPING EXISTS AT ALL ───────────────────────────────────────────────────────────────
 *
 * The `SessionEvent` surface keeps NORMA tool names. The Mac and iOS transcripts key their tool
 * rows on them (the 37 rows of the chat-parity work), the engine's golden streams carry them
 * (`read`, `write`, `bash`, `spawn_agent`), and `session.history` replays years of past sessions
 * that spell them that way. A Winter child speaks the SDK's CC-shaped names (`Read`, `Write`,
 * `Bash`, `Agent`), so the projector translates at the ONE place a tool name enters the product
 * event stream. Letting the raw Winter name through would have re-labelled every tool row on the
 * Winter leg with every unit test green — the kind of change that is only visible on a screen.
 *
 * An UNKNOWN name returns `undefined` and the projector falls back to the raw Winter name (logged
 * once at debug). Fail-open is right here and fail-closed would be wrong: a tool row labelled with
 * an unfamiliar name is a cosmetic surprise, whereas dropping the call or inventing a name would
 * corrupt the transcript and break the `callId` linkage the renderers fold on.
 */

/**
 * Winter → Norma, for the built-ins that appear in the goldens and fixtures plus the CC-shaped
 * neighbours a real session reaches immediately. Norma-side names are the literal `name:` fields of
 * `src/agent/tools/*.ts`, not guesses.
 */
const WINTER_TO_NORMA: Readonly<Record<string, string>> = {
  // the file surface
  Read: "read",
  Write: "write",
  Edit: "edit",
  NotebookEdit: "notebook_edit",
  Glob: "glob",
  Grep: "grep",
  // shell
  Bash: "bash",
  // subagents and messaging
  Agent: "spawn_agent",
  SendMessage: "send_message",
  ListAgents: "agent_list",
  TaskOutput: "agent_output",
  TaskStop: "task_stop",
  Monitor: "bash_output",
  // tasks / todos
  TaskCreate: "task_create",
  TaskGet: "task_get",
  TaskList: "task_list",
  TaskUpdate: "task_update",
  // plan mode and worktrees
  EnterPlanMode: "enter_plan_mode",
  ExitPlanMode: "exit_plan_mode",
  EnterWorktree: "enter_worktree",
  ExitWorktree: "exit_worktree",
  // same name on both sides, listed so they are a DECISION rather than a fall-through
  Skill: "Skill",
  Workflow: "Workflow",
  AskUserQuestion: "AskQuestion",
  PushNotification: "push_notification",
};

/** `mcp__norma__<serverKey>__<tool>` — the brand-named capability tools of ruling P8b-12. Their
 *  Norma name is the bare tool (`browser`, `docs`, `sheets`, `slides`, `computer`, `Search`,
 *  `ReadPage`, `session_spawn`, …), which is exactly what the registered tool is called today. */
const NORMA_MCP_TOOL = /^mcp__norma__[A-Za-z0-9_-]+__(.+)$/;

/**
 * The Norma name for a Winter tool, or `undefined` when nothing is known about it (a third-party
 * MCP tool, a plugin tool, a Winter built-in with no Norma counterpart). The caller falls back to
 * the raw name.
 */
export function normaToolNameFor(winterName: string): string | undefined {
  const mcp = NORMA_MCP_TOOL.exec(winterName);
  if (mcp !== null) return mcp[1];
  return WINTER_TO_NORMA[winterName];
}

/** Exported for the table's own test; never read by the projector. */
export const WINTER_TOOL_NAMES: readonly string[] = Object.keys(WINTER_TO_NORMA);
