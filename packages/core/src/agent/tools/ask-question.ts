import { z } from "zod";
import type { ToolRegistry } from "./registry";

const ASK_TIMEOUT_S = () => Math.round(Number(process.env.NORMA_ASK_TIMEOUT_MS ?? 300_000) / 1000);
const NO_ANSWER = () => `No answer within ${ASK_TIMEOUT_S()}s — the user is not available right now. Answer as best you can and say what you assumed.`;

/** Chat's question tool (B1-T3). Deliberately smaller than code's `ask_user`: no header chip, no
 *  per-option description, no preview, no notes, no multi-select — the user asked for "just a
 *  clean question + answer options with an Other field". A SEPARATE tool rather than a mode-aware
 *  schema on `ask_user` itself because `ToolRegistry.register()` throws on duplicate names
 *  (registry.ts) and the registry is built ONCE per daemon (daemon.ts), not per session —
 *  per-session differentiation is purely name filtering (CHAT_ALLOW_TOOLS vs code's registry-wide
 *  visibility), nothing else. That is the structural reason for the new name, not a style choice. */
const AskQuestionArgs = z.object({
  question: z.string().min(1),
  options: z.array(z.object({ label: z.string().min(1) })).min(2).max(4),
});

export function registerAskQuestionTool(r: ToolRegistry): void {
  r.register({
    name: "AskQuestion",
    description:
      "Ask the user one question when a choice is genuinely theirs to make and you cannot resolve it from the conversation. ALWAYS ask through this tool — a question posed as prose stalls the conversation and cannot be answered from other surfaces. " +
      "Give 2-4 short, distinct option labels. Do NOT add an 'Other' option: the interface always offers a free-text 'Other' itself, so an option spelled 'Other' just wastes a slot. " +
      "Options are labels only — no descriptions. If you recommend one, put it first and append ' (Recommended)' to its label. " +
      "The user's answer is returned to you; if nobody answers in time you'll be told to proceed.",
    // NOT deferred: chat's derived toolset has no ToolSearch member unless something eligible for
    // chat is itself deferred (none is), so a deferred tool here could never be loaded and would
    // be permanently uncallable while still appearing in chat's instructions.
    modes: ["chat"], // R-T2: was CHAT_ALLOW_TOOLS's literal membership
    args: AskQuestionArgs,
    async run({ question, options }: z.infer<typeof AskQuestionArgs>, ctx) {
      if (!ctx.ask) return NO_ANSWER();
      // `header` and per-option `description` are omitted ON PURPOSE (not set to undefined —
      // never assigned as keys at all): Task 2 made `Question.header` optional specifically so a
      // header-less question is a genuinely different SHAPE for a client to key off of. Task 4
      // made the Mac client (PendingCards.swift's `cardTitle`/`questionShowsHeaderChip`/
      // `questionAllowsNotes`), the CLI one-liner (main.ts's `formatQuestionHeadlineLine`), and the
      // TUI card (pending-cards.tsx's `QuestionCard`) all key off that absence — no chip, no
      // per-option descriptions, no notes affordance, and no empty/broken title on any surface.
      const res = await ctx.ask([{ question, options, multiSelect: false }]);
      if ("timedOut" in res) return NO_ANSWER();
      return `User answered: ${res.answers[question] ?? "(no answer)"}`;
    },
  });
}
