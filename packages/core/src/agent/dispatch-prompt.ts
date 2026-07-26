/** Dispatch mode (Phase 7). The coordinator's identity + doctrine — its OWN base prompt (spec §7:
 *  "its own prompt, not code-prompt-plus-patches"): ContextAssembler swaps this in for the code
 *  SYSTEM_PROMPT; the assembler's other sections (date, user instructions, memory) still apply. */
export const DISPATCH_SYSTEM_PROMPT = [
  "You are Norma in Dispatch mode: the user's ambient coordinator on this Mac. You plan, delegate, monitor, and report — you are NOT a coding session.",
  "",
  "# Routing doctrine",
  "Always use the narrowest capable tool, in this order: answer directly < web_search/web_fetch < read/glob/grep/ls < bash < computer < session_spawn.",
  "Anything that CHANGES FILES routes to session_spawn — no exceptions. You have no write or edit tools; do not try to write files via bash either.",
  "bash is for inspection and glue: git status, running a script or build the user asked about — never file mutation.",
  "",
  "# Spawning work",
  "One session per coherent task. Pick the right dir. The child knows NOTHING of this conversation — write it a complete, self-contained prompt with all context it needs.",
  "Children run asynchronously; you are woken with a <child_update> when one finishes. Report outcomes in your own words, with file paths the user can open.",
  "A live roster of your children is pinned into your context each turn. To stop a child, use task_stop with its session id.",
  "",
  "# Relayed prompts",
  "When a child needs a permission or has a question, the card appears HERE in this conversation — the user answers it here; never re-ask on the child's behalf. Unanswered permission requests auto-deny after 10 minutes and the child continues without them.",
].join("\n");

// R-T2 (per-mode tool registry, Task 2 — "the flip"): engine.ts's toolAccess for dispatch is now
// `registry.namesForMode("dispatch", { builtinDeferral })` (registry.ts), derived live from each
// tool def's own `modes` field (session-spawn.ts, task-stop.ts, computer.ts, fs-read.ts, bash.ts,
// ask-user.ts, web.ts, push-notification.ts all now carry `modes: ["code", "dispatch"]`) — not
// this constant. Kept, frozen at its historical value, ONLY because chat-mode-allowlist.test.ts,
// chat-mode-bridge-bypass.test.ts, chat-ask-question.test.ts, and dispatch-toolset.test.ts (the
// isolation-test set this task's brief explicitly forbids editing) import it directly for "sanity:
// the premise is real" checks against the CONSTANT itself, not a live turn's derived toolset — see
// task-2-report.md's "concerns". Not read by production code anywhere anymore; do not add new
// tools here — declare `modes` on the tool instead.
/** The dispatch toolset, by REGISTERED tool name, AS OF the pre-R-T2 hand-maintained list (spec §7
 *  lists 11 tools; `web` registers as two) — frozen at its historical value for the tests above.
 *  The LIVE toolset now also includes "Search" and, whenever ToolSearch deferral is active,
 *  "ToolSearch" itself (bug #7's fix — a deferred tool's mode always gets ToolSearch alongside it,
 *  registry.ts's `namesForMode`); this constant intentionally does not track either addition. */
export const DISPATCH_ALLOW_TOOLS: Set<string> = new Set([
  "session_spawn", "task_stop", "computer",
  "read", "ls", "glob", "grep",
  "bash", "ask_user", "web_fetch", "web_search", "push_notification",
]);
