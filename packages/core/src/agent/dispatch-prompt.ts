/** Dispatch mode (Phase 7). The coordinator's identity + doctrine — its OWN base prompt (spec §7:
 *  "its own prompt, not code-prompt-plus-patches"): ContextAssembler swaps this in for the code
 *  SYSTEM_PROMPT; the assembler's other sections (date, user instructions, memory) still apply. */
export const DISPATCH_SYSTEM_PROMPT = [
  "You are Norma in Dispatch mode: the user's ambient coordinator on this Mac. You plan, delegate, monitor, and report — you are NOT a coding session.",
  "",
  "# Routing doctrine",
  "Always use the narrowest capable tool, in this order: answer directly < Search < read/glob/grep/ls < bash < computer < session_spawn.",
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

// R-T2 (per-mode tool registry, Task 2 — "the flip"): DISPATCH_ALLOW_TOOLS used to live here as
// the hand-maintained source of truth for dispatch's toolset (spec §7's 11 tools; `web` registers
// as two). It's gone — engine.ts's toolAccess for dispatch is now
// `registry.namesForMode("dispatch", { builtinDeferral })` (registry.ts), derived live from each
// tool def's own `modes` field (session-spawn.ts, task-stop.ts, computer.ts, fs-read.ts, bash.ts,
// push-notification.ts all carry `modes: ["code", "dispatch"]`; search.ts carries `modes: ["chat",
// "dispatch"]`). The live toolset also now includes "ToolSearch" whenever ToolSearch deferral is
// active (bug #7's fix — a mode with any eligible deferred tool always gets ToolSearch alongside
// it, registry.ts's `namesForMode`), which this constant never tracked. The tests that used to
// import this constant for static sanity checks were rewritten to call
// `registry.namesForMode(...)` directly against their own harness's registry instead (see
// task-2-report.md, "Fix round 1").
//
// R-T3 (Task 3): the derivation above is what EXPOSED bug #7's other half — dispatch's toolset
// historically had no ToolSearch entry point of its own, so its two `deferred: true` web tools
// (web_fetch/web_search, web.ts) were advertised but permanently uncallable; a reviewer reproduced
// the catch-22 end to end (ToolSearch itself refused as unavailable, then push_notification
// refused as "deferred — load its schema via ToolSearch first"). push_notification staying
// dispatch-eligible+deferred is what makes ToolSearch appear for dispatch at all (it is loadable
// now); web_fetch/web_search are simply gone from dispatch's `modes` (web.ts, R-T3) — dispatch
// routes web lookups through `Search` (search.ts) instead, which was already `modes: ["chat",
// "dispatch"]` and NOT deferred, so it needs no ToolSearch round-trip and returns page excerpts in
// one call (no fetch-the-result-url second step, unlike the old web_search+web_fetch pair).
//
// D1-T2 (per-mode `deferred`): dispatch's simplified question tool is now `AskQuestion`
// (ask-question.ts, `modes: ["chat", "dispatch"]`), not `ask_user` — `ask-user.ts` dropped
// "dispatch" from its own `modes` in the same change, so dispatch no longer sees it at all (there
// is no literal "ask_user" text anywhere in DISPATCH_SYSTEM_PROMPT above to fix — this comment
// block was the only place still naming the file). `bash`/`task_stop`/`computer`/`AskQuestion`/
// `send_message` are all now `deferred: ["dispatch"]` too — immediate in code (or, for AskQuestion,
// immediate in chat), loadable via ToolSearch for dispatch specifically. `push_notification` is
// UNCHANGED (`deferred: true` — every mode, deliberately untouched).
