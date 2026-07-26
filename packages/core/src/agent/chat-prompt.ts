/** Chat mode (Slice A). Its OWN base prompt — ContextAssembler swaps this in for the code
 *  SYSTEM_PROMPT, exactly as it does for dispatch; the assembler's other sections (date, user
 *  instructions, memory) still apply. */
export const CHAT_SYSTEM_PROMPT = [
  "You are Norma in Chat mode: a conversation, not an agent. You have no access to this machine — no files, no shell, no repository — and you never imply otherwise.",
  "",
  "# What you are here for",
  "Thinking things through with the user: questions, explanations, drafting, planning, remembering.",
  "You share the assistant memory that Norma builds across conversations — use what you know about the user, and do not re-ask what is already established.",
  "",
  "# Honesty about your reach",
  "If something needs the user's files, code, or terminal, say so plainly and point at the mode that can do it (Code for a project, Dispatch to coordinate work).",
  "Never guess at file contents or command output. You cannot see them.",
  "",
  "# Looking things up",
  "You can Search the web. Do it whenever a fact might have changed since you were trained, or the user asks about something current — do not guess and do not hedge about not knowing. Say where a fact came from.",
  "",
  "# Asking",
  "When a choice is genuinely the user's to make, use AskQuestion rather than assuming.",
].join("\n");

// R-T2 (per-mode tool registry, Task 2 — "the flip"): engine.ts's OWN toolAccess no longer reads
// either constant below — chat/dispatch's allowlists and code's exclude-derived complement are now
// `ToolRegistry.namesForMode`/`namesNotForMode` (registry.ts), driven live off each tool def's own
// `modes` field (search.ts: `modes: ["chat","dispatch"]`; ask-question.ts: `modes: ["chat"]`) —
// declaring eligibility AT the tool instead of enumerating it in a THIRD place here.
//
// Both constants are kept, unchanged, ONLY because a handful of pre-existing regression tests
// (chat-mode-allowlist.test.ts, chat-mode-bridge-bypass.test.ts, chat-ask-question.test.ts,
// dispatch-toolset.test.ts — the isolation-test set this task's brief explicitly forbids editing)
// import them directly for "sanity: the premise is real" checks against the CONSTANT's own
// membership, not against a live turn's derived toolset — see task-2-report.md's "concerns" for
// the full accounting of why deleting them (as R-T2's brief literally instructs) is not safe here.
// Do not add new production reads of either — namesForMode("chat")/("dispatch") is the only
// current source of truth for that.
/** The chat toolset, by REGISTERED tool name, AS OF the pre-R-T2 hand-maintained list — frozen at
 *  its historical value for the tests above; do not add new tools here. Chat's own tools are
 *  deliberately separate from code's (`ask_user`, `web_search`, `web_fetch`) — the registry is
 *  per-daemon and rejects duplicate names, so the chat variants carry their own names and code's
 *  are untouched. (B1-T3: `AskQuestion` replaces `ask_user` here; B1-T5 adds `Search`.) */
export const CHAT_ALLOW_TOOLS: Set<string> = new Set(["AskQuestion", "Search"]);

/** Chat's OWN tools, AS OF the pre-R-T2 hand-maintained list — frozen at its historical value.
 *  Still read at engine.ts's TWO `childExcludeTools` sites (the spawn_agent bridge and
 *  runWorkflowAgent) — see task-2-report.md's "concerns" for why those two sites specifically were
 *  NOT flipped to `registry.namesNotForMode("code")` in this task (byte-identical in the real
 *  daemon, where AskQuestion/Search are always registered; only two test harnesses that omit them
 *  would diverge). turn()'s own toolAccess (the MAIN exclude-shaped seam) IS fully flipped. */
export const CHAT_ONLY_TOOLS: ReadonlySet<string> = new Set(["AskQuestion", "Search"]);
