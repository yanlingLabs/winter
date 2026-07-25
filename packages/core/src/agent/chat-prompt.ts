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
  "# Asking",
  "When a choice is genuinely the user's to make, use ask_user rather than assuming.",
].join("\n");

// Declared as `Set<string>` (not `ReadonlySet<string>`) to match runThread's existing `allowTools?:
// Set<string>` option (engine.ts) — the NAME LIST is the invariant this constant pins, not the
// container type.
/** The chat toolset, by REGISTERED tool name. Slice A is deliberately minimal — chat-specific
 *  web_search / web_fetch / simplified ask_user arrive in Slice B and are the ONLY additions
 *  planned. Nothing that touches the filesystem, the shell, or the machine may ever join. */
export const CHAT_ALLOW_TOOLS: Set<string> = new Set(["ask_user"]);
