import { z } from "zod";
import type { PermissionResult } from "@yanlinglabs/winter-agent-sdk";
import type { NewSessionEvent, Question } from "@norma/protocol";
import type { QuestionBroker } from "../agent/questions";
import { NO_PARK_TIMEOUT_MS, type BridgeLogger } from "./bridge-common";

/** Winter's built-in question tool. Pinned by the SDK surface map §5.6 (`canonicalName` /
 *  `advertisedName: "AskUserQuestion"`). */
export const ASK_USER_QUESTION_TOOL = "AskUserQuestion";

/**
 * **`AskUserQuestion`'s input schema, hard-coded (G-9).**
 *
 * The descriptor lives in the PRIVATE `winter-agent-runtime` package, so this shape is a repo fact
 * rather than a published type — SDK surface map §5.6 quotes it: `questions` (required, 1..4), each
 * `{ question: string; header: string (maxLength 12); options: Array<{ label; description;
 * preview? }> (2..4); multiSelect?: boolean }`, plus `answers?`, `annotations?` and `metadata?`.
 *
 * Only `questions` is modelled: this schema's job is to VALIDATE, never to reshape. The answer is
 * returned as `{ ...input, answers }` off the ORIGINAL object, so `answers`/`annotations`/`metadata`
 * (and anything a later runtime adds) ride through untouched whether or not they appear here — the
 * "strip unknown keys" default can therefore never lose a field. `header` is `.optional()` even
 * though the descriptor marks it required, because Norma's own `QuestionSchema` has made it optional
 * since chat's simplified card shipped: a header-less question is a genuinely valid Norma question
 * (the simplified card), and refusing one here would be stricter than the surface it feeds.
 */
export const AskUserQuestionInput = z.object({
  questions: z.array(z.object({
    question: z.string().min(1),
    header: z.string().min(1).max(12).optional(),
    options: z.array(z.object({
      label: z.string().min(1),
      description: z.string().optional(),
      preview: z.string().optional(),
    })).min(2).max(4),
    multiSelect: z.boolean().optional(),
  })).min(1).max(4),
});

export interface AskUserQuestionDeps {
  /** The OWNING Norma session. A Winter sub-agent's question surfaces HERE (see below). */
  sessionId: string;
  threadId?: string;
  questions: QuestionBroker;
  emit: (event: NewSessionEvent) => void;
  log?: BridgeLogger;
  now?: () => number;
}

/**
 * **The `AskUserQuestion` bridge** — a Winter child's question over the daemon's EXISTING
 * `QuestionBroker`, `question_asked`/`question_resolved` events and `ask_user.respond` RPC, the
 * same machinery `ask_user` (code) and `AskQuestion` (chat/dispatch) use today. The two tools
 * collapse into this one (Norma map §5.3 / digest item 51); the answer goes back to the model as
 * `canUseTool`'s `updatedInput.answers`, keyed by question TEXT — which is exactly how
 * `QuestionBroker`, `AskUserRespondParams` and `QuestionResolvedEvent.answers` are already keyed,
 * so no translation is needed anywhere on the phone's path.
 *
 * **Routing, and `agentID`.** The event is emitted on `deps.sessionId` — the owning Norma session —
 * *by construction*: this bridge is built once per session and never learns a child session id. A
 * Winter `agentID` names a sub-agent INSIDE that session's one child process, not a Norma session
 * of its own; it has no event stream, no `SessionStore` row and no id `ask_user.respond` could
 * address. So a sub-agent's question surfaces on the parent's stream and is answered at the
 * parent's `sessionId` — the same end state today's dispatch relay reaches by MIRRORING a child
 * session's `question_asked` into the parent's stream (`agent/dispatch-children.ts`), minus the
 * mirror, because there is no second stream to mirror from. (`AskUserQuestion` is in any case
 * `availability: { insideSubagent: false }` in Winter's own descriptor, so `agentID` here is the
 * narrow case of a non-Agent-tool sub-agent.)
 *
 * **Fail-closed** (P8b-19): a timeout, an abort, an unparseable input, an emit failure or an empty
 * answer map all return a typed deny. There is no path that allows the call without a human answer.
 */
export function askUserQuestionBridge(
  deps: AskUserQuestionDeps,
): (toolUseID: string, input: unknown, ctx: { signal: AbortSignal; agentID?: string }) => Promise<PermissionResult> {
  const threadId = deps.threadId ?? "main";
  const log = deps.log;
  /** `callId` → how many stale invocations must SKIP their own `question_resolved` emit, because
   *  the superseding one already emitted it in the right order. */
  const supersededEmits = new Map<string, number>();

  return async (toolUseID, input, ctx): Promise<PermissionResult> => {
    const { sessionId } = deps;
    const callId = toolUseID;

    if (ctx.signal.aborted) {
      return { behavior: "deny", message: `${ASK_USER_QUESTION_TOOL} was not answered — the turn was aborted before the question could be asked.` };
    }

    const parsed = AskUserQuestionInput.safeParse(input);
    if (!parsed.success) {
      // A malformed question is the model's bug, not the human's: refuse it with a message the
      // model can act on rather than throwing (a throw becomes an opaque runtime deny).
      log?.info(`AskUserQuestion: deny session=${sessionId} call=${callId} reason=invalid-input`);
      return { behavior: "deny", message: `${ASK_USER_QUESTION_TOOL} input was not valid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
    }
    const raw = parsed.data;

    // Norma's `QuestionSchema` requires `multiSelect`; Winter's descriptor makes it optional. The
    // default is `false` — a single-choice question, which is what an omitted flag means.
    const questions: Question[] = raw.questions.map((q) => ({
      question: q.question,
      ...(q.header ? { header: q.header } : {}),
      options: q.options.map((o) => ({
        label: o.label,
        ...(o.description ? { description: o.description } : {}),
        ...(o.preview ? { preview: o.preview } : {}),
      })),
      multiSelect: q.multiSelect ?? false,
    }));

    // Supersede guard — the same defect the approval side guards, and the same ordering rule.
    //
    // `QuestionBroker.wait` does `pending.set(k, …)`, so a second `AskUserQuestion` for the SAME
    // `toolUseID` would overwrite the entry: the first promise never settles and its ~24.8-day
    // timer leaks. `respond` is already a safe no-op when nothing is pending (it reports
    // `alreadyResolved: true`), so it doubles as the "was one pending?" question — no `pendingMeta`
    // equivalent is needed.
    //
    // The WITHDRAWAL is emitted HERE, synchronously, before this invocation's own `question_asked`
    // — not from the stale invocation's microtask continuation, which would arrive AFTER the
    // replacement question and dismiss the live card (clients resolve pending cards by `callId`
    // alone). The stale invocation skips its own emit through the suppression count.
    if (!deps.questions.respond(sessionId, callId, {}, "superseded").alreadyResolved) {
      supersededEmits.set(callId, (supersededEmits.get(callId) ?? 0) + 1);
      log?.info(`AskUserQuestion: superseding a pending question session=${sessionId} call=${callId}`);
      deps.emit({ type: "question_resolved", sessionId, threadId, callId, answers: {}, by: "superseded" });
    }

    // Wait-before-emit, for the same reason the engine and `buildLeasePolicy` do it: the broadcast
    // is synchronous, so a watcher that answers on sight would race an unregistered wait.
    const waiting = deps.questions.wait(sessionId, callId, NO_PARK_TIMEOUT_MS);
    try {
      deps.emit({ type: "question_asked", sessionId, threadId, callId, questions });
    } catch (err) {
      deps.questions.respond(sessionId, callId, {}, "emit-failure");
      await waiting;
      log?.error(`AskUserQuestion: failed to emit question_asked session=${sessionId} call=${callId}: ${(err as Error).message}`);
      return { behavior: "deny", message: `${ASK_USER_QUESTION_TOOL} was not answered — this session could not raise the question.` };
    }

    const onAbort = () => { deps.questions.respond(sessionId, callId, {}, "aborted"); };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    let res: Awaited<ReturnType<QuestionBroker["wait"]>> | null | undefined;
    try {
      res = await waiting;
    } finally {
      ctx.signal.removeEventListener("abort", onAbort);
    }

    const answered = !!res && typeof res === "object" && "answers" in res ? res : undefined;
    const answers = answered?.answers ?? {};
    const notes = answered && "notes" in answered ? answered.notes : undefined;
    const by = answered && typeof answered.by === "string" ? answered.by : "timeout";

    // A stale invocation whose question was already withdrawn by the SUPERSEDING one must not emit
    // a second `question_resolved` — the withdrawal went out in the right order above, and a
    // duplicate arriving here (after the replacement question) would dismiss the live card.
    const suppressions = supersededEmits.get(callId) ?? 0;
    if (by === "superseded" && suppressions > 0) {
      if (suppressions > 1) supersededEmits.set(callId, suppressions - 1);
      else supersededEmits.delete(callId);
    } else {
      deps.emit({
        type: "question_resolved", sessionId, threadId, callId,
        answers, by,
        ...(notes ? { notes } : {}),
      });
    }

    // Fail closed: no answers (timeout, abort, emit-failure, or a genuinely empty response) is a
    // deny, never a silent allow with an unanswered question in the input.
    if (Object.keys(answers).length === 0) {
      log?.info(`AskUserQuestion: deny session=${sessionId} call=${callId} by=${by}`);
      // No `decisionClassification`: nobody answered, which is not the same thing as a user
      // rejecting the call (see the approval bridge's own note on the same distinction).
      return {
        behavior: "deny",
        message: by === "aborted"
          ? `${ASK_USER_QUESTION_TOOL} was not answered — the turn was aborted while the question was pending.`
          : `${ASK_USER_QUESTION_TOOL} was not answered — no response was given.`,
      };
    }

    log?.info(`AskUserQuestion: answered session=${sessionId} call=${callId} by=${by} count=${Object.keys(answers).length}`);
    // `annotations` is §5.6's own home for per-question free text, keyed by question text exactly
    // like `answers` — so the broker's `notes` fold in there rather than inventing a field. MERGED
    // over whatever the model already sent (it may have supplied its own `preview` annotations):
    // a wholesale replacement would silently drop the model's half of the field.
    const priorInput = (input ?? {}) as Record<string, unknown>;
    const priorAnnotations = (typeof priorInput.annotations === "object" && priorInput.annotations !== null)
      ? priorInput.annotations as Record<string, Record<string, unknown>>
      : undefined;
    const annotations = notes
      ? {
          ...priorAnnotations,
          ...Object.fromEntries(Object.entries(notes).map(([q, n]) => [q, { ...priorAnnotations?.[q], notes: n }])),
        }
      : undefined;
    return {
      behavior: "allow",
      updatedInput: {
        ...priorInput,
        answers,
        ...(annotations ? { annotations } : {}),
      },
      decisionClassification: "user_temporary",
    };
  };
}
