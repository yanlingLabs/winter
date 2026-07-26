import { z } from "zod";
import type { ToolRegistry } from "./registry";

const ASK_TIMEOUT_S = () => Math.round(Number(process.env.NORMA_ASK_TIMEOUT_MS ?? 300_000) / 1000);
const NO_ANSWER = () => `No answer within ${ASK_TIMEOUT_S()}s — the user is not available right now. Proceed with your best judgment and note the assumption.`;

const AskUserQuestionArgs = z.object({
  question: z.string().min(1),
  header: z.string().min(1).max(12),
  // CC AskUserQuestion parity: `preview` is an optional short visual/example (e.g. a diff snippet
  // or path) shown beside the option — single-select only, enforced by the refine below.
  options: z.array(z.object({ label: z.string().min(1), description: z.string().min(1), preview: z.string().optional() })).min(2).max(4),
  multiSelect: z.boolean(),
}).refine(
  (q) => !(q.multiSelect && q.options.some((o) => o.preview !== undefined)),
  { message: "option previews are only supported for single-select questions (multiSelect: false)" },
);

const AskUserArgs = z.object({
  questions: z.array(AskUserQuestionArgs).min(1).max(4),
});

export function registerAskUserTool(r: ToolRegistry): void {
  r.register({
    name: "ask_user",
    description:
      "Ask the user 1-4 questions whenever you need them to choose between options or clarify something you cannot resolve from the request, the code, or sensible defaults. ALWAYS ask through this tool — never pose the question as prose and stop; a prose question stalls the session and can't be answered from other surfaces. " +
      "Each question has 2-4 distinct option choices; each option needs a label AND a description explaining what it means; do NOT add an 'Other' option (the interface adds a free-text 'Other' automatically). " +
      "An option may also carry a short `preview` (a visual/example, e.g. a diff snippet or path, shown beside the option) — previews are only supported for single-select questions (multiSelect: false). " +
      "If you recommend an option, put it first and append ' (Recommended)' to its label. Use multiSelect: true when choices are not mutually exclusive. " +
      "The user's answers are returned; if no one answers in time you'll be told to proceed with your best judgment.",
    args: AskUserArgs,
    modes: ["code", "dispatch"], // R-T2: was DISPATCH_ALLOW_TOOLS's literal membership
    async run({ questions }: z.infer<typeof AskUserArgs>, ctx) {
      if (!ctx.ask) return NO_ANSWER();
      const res = await ctx.ask(questions);
      if ("timedOut" in res) return NO_ANSWER();
      const lines = questions.map((q) => `- ${q.header}: ${res.answers[q.question] ?? "(no answer)"}`);
      let out = `User answered:\n${lines.join("\n")}`;
      // CC AskUserQuestion parity: fold any per-question free-text note into the model-visible
      // return string verbatim, so the model actually sees the annotation (notes never appear in
      // `answers` itself). Absent when the resolution carried no notes — no-notes output is
      // byte-identical to before this field existed.
      if (res.notes) {
        for (const q of questions) {
          const note = res.notes[q.question];
          if (note) out += `\n[user note on "${q.question}": ${note}]`;
        }
      }
      return out;
    },
  });
}
