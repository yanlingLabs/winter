/** Chat mode (Slice A). Its OWN base prompt — ContextAssembler swaps this in for the code
 *  SYSTEM_PROMPT, exactly as it does for dispatch; the assembler's other sections (date, user
 *  instructions, memory) still apply. */

/**
 * The web paragraph, which is the ONE part of chat's prompt that depends on runtime state.
 *
 * Chat's search tool moves with the Exa key (the 2026-09-18 ruling): with one stored the daemon's
 * `Search` is exposed and the runtime's `WebSearch` is withheld; with none it is the other way round,
 * because Exa's `/answer` endpoint cannot be called anonymously. `disallowedToolsFor` and the `research`
 * capability server both decide that from the same value, and so does this — naming a tool the session
 * was not given is how a model ends up apologising for a tool that "failed" when it was never there.
 *
 * `exaKeyPresent` ABSENT reads as PRESENT, the same convention `ToolExposure` and `CapabilitySession`
 * keep, so all three doors agree by default rather than by coincidence.
 */
function lookingThingsUp(exaKeyPresent: boolean): string[] {
  return exaKeyPresent
    ? [
      "You can Search the web. Ask it a real question, not keywords: it comes back with a written answer and the pages that answer came from. Do it whenever a fact might have changed since you were trained, or the user asks about something current — do not guess and do not hedge about not knowing. Say where a fact came from, and never present an answer it marked unsourced as if it were cited.",
      "You can also open any page with WebFetch — give it a URL and what you want to know from it, and you get an answer read off that page.",
    ]
    : [
      "You can search the web with WebSearch, and open any page with WebFetch — give WebFetch a URL and what you want to know from it, and you get an answer read off that page. Use them whenever a fact might have changed since you were trained, or the user asks about something current — do not guess and do not hedge about not knowing. Say where a fact came from.",
      "(The user has not stored an Exa API key, so Winter's own Search tool — one call, a written answer with sources — is not available in this conversation. `winter login --exa-key` turns it on.)",
    ];
}

/**
 * Chat's base prompt for ONE session. A function, not a constant, because its web paragraph depends on
 * whether an Exa key is stored — see `lookingThingsUp`. Everything else is fixed.
 */
export function chatSystemPrompt(opts: { exaKeyPresent?: boolean } = {}): string {
  return [
    "You are Winter in Chat mode: a conversation, not an agent. You have no access to this machine — no files, no shell, no repository — and you never imply otherwise.",
    "",
    "# What you are here for",
    "Thinking things through with the user: questions, explanations, drafting, planning, remembering.",
    "You share the assistant memory that Winter builds across conversations — use what you know about the user, and do not re-ask what is already established.",
    "",
    "# Honesty about your reach",
    "If something needs the user's files, code, or terminal, say so plainly and point at the mode that can do it (Code for a project, Dispatch to coordinate work).",
    "Never guess at file contents or command output. You cannot see them.",
    "",
    "# Looking things up",
    ...lookingThingsUp(opts.exaKeyPresent !== false),
    "",
    "# Asking",
    "When a choice is genuinely the user's to make, use AskQuestion rather than assuming.",
  ].join("\n");
}

// R-T2 (per-mode tool registry, Task 2 — "the flip"): CHAT_ALLOW_TOOLS and CHAT_ONLY_TOOLS used to
// live here as the hand-maintained source of truth for chat's toolset. Both are gone — engine.ts's
// toolAccess (chat/dispatch allowlist, code's exclude-derived complement) and its two
// childExcludeTools sites now all read `ToolRegistry.namesForMode`/`namesNotForMode` (registry.ts),
// driven live off each tool def's own `modes` field (search.ts: `modes: ["chat","dispatch"]`;
// ask-question.ts: `modes: ["chat"]`) — declaring eligibility AT the tool instead of enumerating it
// in a THIRD place here. The handful of tests that used to import these constants for static
// sanity checks were rewritten to call `registry.namesForMode(...)`/`namesNotForMode(...)` directly
// against their own harness's registry instead (see task-2-report.md, "Fix round 1").
//
// 2026-09-18 (the web-tools ruling): `CHAT_SYSTEM_PROMPT`, the constant this file exported until now,
// became `chatSystemPrompt(...)` for the same class of reason — the prompt is built per session
// (`runtime-sdk/system-prompt.ts`'s `winterSystemPromptFor`), and chat's search tool is decided per
// session too. A constant would have had to name BOTH tools and let the model find out which one it
// actually has by calling the wrong one.
