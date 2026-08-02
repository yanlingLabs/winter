import type { ProviderEvent } from "./types";

type ProviderError = Extract<ProviderEvent, { type: "error" }>;

/** Lifts the provider's STRUCTURED error code out of a raw HTTP error body (OpenAI's canonical
 *  `{"error":{"message":…,"type":…,"code":…}}` envelope, which both the plain OpenAI-compatible
 *  endpoint and the Codex `/responses` backend speak).
 *
 *  Why this exists at all, rather than reading the code back out of the mapped `message`:
 *  `mapHttpError` embeds the body text capped at 200 chars, and `code` trails the (unbounded)
 *  human `message` inside the envelope — so on the longer of the two live context-overflow bodies
 *  (252 chars; see test/providers/errors.test.ts, which records both verbatim) the cap slices the
 *  body mid-`"type"` and eats the code entirely. Parsed here off the FULL body, BEFORE the cap.
 *
 *  Never throws and never guesses: a non-JSON body (an HTML 502 page, a bare "err"), a body with
 *  no envelope, or a non-string `code` all yield undefined, leaving the mapped event's shape
 *  byte-identical to what it was before this field existed. */
export function parseProviderErrorCode(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") return undefined;
    const err = (parsed as { error?: unknown }).error;
    if (!err || typeof err !== "object") return undefined;
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" && code.length > 0 ? code : undefined;
  } catch {
    return undefined;
  }
}

/** OpenAI's canonical structured code for "your input is bigger than the model's context window".
 *  A Set (not a bare string) because the two backends have historically disagreed on spelling and
 *  a second alias would land here, not in the prose patterns below. */
const CONTEXT_LENGTH_CODES = new Set(["context_length_exceeded"]);

/** Prose fallback, for the case the structured code did NOT survive (the 200-char cap above, or a
 *  context overflow delivered mid-stream as `response.failed`, whose message is all we ever get).
 *
 *  Every alternative demands an overflow CLAIM, never the bare nouns, and every one is
 *  word-boundary anchored. Both halves are deliberate, and both are the SAME lesson (I4): a raw
 *  `contains` is unsafe here because `mapHttpError` embeds RAW BODY TEXT, and a 400 body routinely
 *  echoes the offending input back — i.e. the user's own prose ("explain how context length
 *  works") can land in `message`. `\b` likewise keeps `subcontext_length_exceeded_flag` and
 *  `contextlength` from matching. Compare `agent/research.ts`'s looser `/context.length/`, which
 *  is safe there only because it guards a much weaker decision (whether to burn one retry).
 *
 *  KNOWN, ACCEPTED false positive (T1 review M2): an unrelated 400 with NO structured code whose
 *  body echoes user prose that makes an overflow CLAIM — e.g. "please do not exceed the context
 *  window" — matches. Cost: one wasted summarization and detail dropping out of the model's view
 *  (the session log itself is never touched). Accepted because demanding the claim already filters
 *  the common echoes, and tightening further starts missing real overflows, the worse direction. */
const CONTEXT_LENGTH_PROSE_RE =
  /\bcontext_length_exceeded\b|\bmaximum context length\b|\bexceeds? the context (?:window|length)\b/i;

/** True when a provider error is the model refusing an over-sized context — the signal that a
 *  session needs compaction NOW, independent of any token measurement (which, in exactly this
 *  case, can never arrive: the request 400s before a single `usage` event exists).
 *
 *  Recognition order is "structured first, and structured is FINAL": when the provider handed us a
 *  code, that code decides — a non-context-length code returns false even if the prose happens to
 *  contain a matching phrase. The prose patterns only ever run when no structured code survived.
 *
 *  Deliberately NOT gated on the coarse `ev.code`: the same overflow arrives as `bad_request` from
 *  `mapHttpError` and as `server` from `responses-sse.ts`'s `response.failed` mapping, and a gate
 *  would silently miss the streamed half. */
export function isContextLengthError(ev: ProviderError): boolean {
  if (ev.providerCode !== undefined) return CONTEXT_LENGTH_CODES.has(ev.providerCode);
  return CONTEXT_LENGTH_PROSE_RE.test(ev.message);
}
