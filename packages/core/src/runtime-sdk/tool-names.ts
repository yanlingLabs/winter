/**
 * **Winter tool name → the name `PermissionGate.evaluate` classifies.** (Task 8, the approval
 * bridge's first move.)
 *
 * The gate's four class sets (`agent/gate.ts`) are keyed by NORMA's tool names — `bash`, `read`,
 * `write`, `web_fetch`, `Search`, `ReadPage`, `browser`, `docs`… — because every caller it has
 * today is the engine's dispatch loop, which hands it `call.name` straight off Norma's own
 * `ToolRegistry`. A Winter child calls the SAME actions under DIFFERENT names (`Bash`, `Read`,
 * `Write`, `WebFetch`, and the capability tools under `mcp__norma__<key>__<tool>`), so feeding the
 * raw Winter name to the gate would be wrong in both directions and SILENTLY:
 *
 *  - `mcp__norma__research__Search` is not in `NETWORK`, so chat's gate branch ("allow READ_ONLY /
 *    NETWORK, deny everything else") would DENY chat's only research tool — chat's Search dies with
 *    every unit test green.
 *  - `"Bash"` is not in `MUTATING`, so it falls to the unclassified fail-closed `"ask"` branch —
 *    which under `auto` is a card where today there is silence, and under dispatch/chat a typed
 *    deny (P8b-7) where today the command runs.
 *  - `approvalCardSummary` / `approvalOptionsFor` (`agent/approvals.ts`) both switch on the literal
 *    `"bash"`, so a card for `"Bash"` would lose its command text AND its "always allow
 *    `Bash(git push:*)`" options — i.e. the rules-store "remember this" path would have nothing to
 *    remember.
 *
 * **Failing to map a name is SAFE, by construction:** an unmapped name passes through unchanged,
 * lands on `isGateClassified`'s `false` branch and fails closed to `"ask"`. That is the whole reason
 * this table may be incomplete without being dangerous — completeness across the capability surface
 * is Task 9's parity tripwire (P8b-12), not this module's burden.
 *
 * **Source of the built-in rows:** the "WS-06 §5 successor" column of the Winter Phase 8b codebase
 * map §5.1/§5.3 (the class-(a) and class-(c) disposition tables) — one row per Norma tool, read off
 * the map rather than recalled. `AskUserQuestion` is pinned separately by the SDK surface map §5.6.
 * Names with no successor in that table (`ls`, `skill_write` — map §5.4) have no row here either.
 */
export const WINTER_TO_NORMA_TOOL_NAME: Readonly<Record<string, string>> = {
  // class (a) — CC-shaped tools the Winter SDK provides natively (map §5.1)
  Read: "read",
  Glob: "glob",
  Grep: "grep",
  Write: "write",
  Edit: "edit",
  Bash: "bash",
  TaskOutput: "bash_output",
  NotebookEdit: "notebook_edit",
  Skill: "Skill",
  ToolSearch: "ToolSearch",
  TaskCreate: "task_create",
  TaskUpdate: "task_update",
  TaskList: "task_list",
  TaskGet: "task_get",
  TaskStop: "task_stop",
  LSP: "lsp",
  WebFetch: "web_fetch",
  WebSearch: "web_search",
  EnterPlanMode: "enter_plan_mode",
  ExitPlanMode: "exit_plan_mode",
  EnterWorktree: "enter_worktree",
  ExitWorktree: "exit_worktree",
  ListMcpResourcesTool: "list_mcp_resources",
  ReadMcpResourceTool: "read_mcp_resource",
  PushNotification: "push_notification",
  // The three cron names collapse onto Norma's single `schedule` tool, which is how gate.ts already
  // classifies every schedule op ("one tool, one gate decision, no op-dependent carve-out").
  CronCreate: "schedule",
  CronDelete: "schedule",
  CronList: "schedule",
  Agent: "spawn_agent",
  Workflow: "Workflow",
  // class (c) — bridged to Winter built-ins (map §5.3)
  ListAgents: "agent_list",
  SendMessage: "send_message",
  // `AskUserQuestion` never actually reaches the gate: `canUseToolFor` routes it to the question
  // bridge FIRST (it is a question, not a permission). Mapped anyway so the table reads honestly
  // and a future caller that DOES gate it lands on `ask_user`'s READ_ONLY classification — the
  // human IS the approval, so a gate card on top would double-ask (gate.ts's own reasoning).
  AskUserQuestion: "ask_user",
};

/** `mcp__norma__` — the prefix every daemon-owned capability tool carries under R-1 / P8b-12
 *  (`mcp__norma__<serverKey>__<tool>`, minted by Task 6-7's `capabilityToolName`). Spelled out
 *  literally rather than derived from Task 5's `NORMA_BRAND.mcpServerName`: that module lands in a
 *  different lane, and the brand's `mcpServerName` is itself pinned to `"norma"` by the Interfaces
 *  block, so the two cannot disagree without the interfaces block changing first. */
export const NORMA_CAPABILITY_TOOL_PREFIX = "mcp__norma__";

/**
 * The gate-facing name for a tool a Winter child just asked permission for.
 *
 * Three cases, in order:
 *  1. a Norma capability tool (`mcp__norma__<key>__<tool>`) → the BARE `<tool>` name, which is
 *     exactly how `gate.ts` already classifies all five servers' tools (`Search`/`ReadPage` in
 *     `NETWORK`, `browser` in `NETWORK`, `computer`/`docs`/`sheets`/`slides`/`session_spawn` in
 *     `MUTATING`, `list_sessions`/`manage_session` in `READ_ONLY`);
 *  2. a mapped Winter built-in → its Norma name (the table above);
 *  3. anything else → UNCHANGED. A third-party `mcp__…`/`plugin__…` name keeps its prefix so
 *     `isExternalToolName` still classifies it as external; every other unknown name stays unknown
 *     and fails closed to `"ask"`.
 *
 * Pure; no I/O; safe to call on every permission request.
 */
export function gateToolNameFor(winterToolName: string): string {
  if (winterToolName.startsWith(NORMA_CAPABILITY_TOOL_PREFIX)) {
    const rest = winterToolName.slice(NORMA_CAPABILITY_TOOL_PREFIX.length);
    // `<serverKey>__<tool>` — take everything after the FIRST `__`, so a tool name that itself
    // contains `__` survives intact. A malformed entry with no separator falls through unchanged
    // (still `mcp__`-prefixed ⇒ still classified as external, never silently widened).
    const sep = rest.indexOf("__");
    if (sep > 0 && sep + 2 < rest.length) return rest.slice(sep + 2);
    return winterToolName;
  }
  return WINTER_TO_NORMA_TOOL_NAME[winterToolName] ?? winterToolName;
}
