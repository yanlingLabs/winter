// WS-18 §9 / W18-19 — what "body-level on every hop" actually means, as predicates over the raw
// request bodies the loopback fakes record (Lane P fix round 1, review Major 1).
//
// A hop asserted only as "the body names the model id" proves the ROUTING and nothing else: an
// empty, rebuilt conversation on the right endpoint would pass it. What W18-19 is about is what
// TRAVELS — the prior turns, in order, and the prior model's reasoning re-rendered as data the
// destination can read, with the source's opaque state left behind. These are the three questions,
// asked of the bytes that actually went out.
//
// THE CARRIAGE TAG'S FORM IS PER-ADAPTER, and that is MEASURED, not assumed (2026-09-15, against
// the pinned SDK 0.0.12 / router 0.0.7 through real `dist/winter` children):
//
//   - `openai-responses` (the `openai` provider) renders W18-19's literal tag:
//       <recovered_reasoning kind="exposed" provider="deepseek" model="deepseek/deepseek-reasoner">…</recovered_reasoning>
//     with `kind="summary"` for a Claude source and `kind="exposed"` for DeepSeek/GLM.
//   - `openai-chat-completions` (deepseek, zai, openrouter, xai) renders the SAME fact as a labelled
//     plain-text prefix on the assistant message:
//       [prior-model reasoning, carried as data — provider: deepseek, model: deepseek/deepseek-reasoner]
//     followed by the reasoning text.
//
// Both carry the same three things (the text, the source provider, the source model), so
// `carriesReasoning` accepts either and the tests say which hop is which adapter. Asserting only the
// angle-bracket form would have made every chat-completions hop unprovable and read as a defect.

/**
 * The CONVERSATION part of a request body — messages/input/system — with the tool schemas left out.
 *
 * Load-bearing for the opacity check: the `advisor` tool's own description contains the literal
 * string "encrypted_content" (it says opaque state is never included in what it sends), so a
 * whole-body scan for that word reports a hit on every single request and can never fail. The
 * question is whether opaque state rode in the CONVERSATION, and this is the part that answers it.
 */
export function conversationOf(body: string): string {
  try {
    const o = JSON.parse(body) as Record<string, unknown>;
    return JSON.stringify({ messages: o.messages, input: o.input, system: o.system });
  } catch {
    return body;
  }
}

/** The opaque-state field NAMES that must never appear in a conversation (`reasoning_item.itemJson`
 *  and friends are never rendered into a request body). Asserted on `conversationOf`, never the raw
 *  body — see that function for why. */
const OPAQUE_FIELD_NAMES = ["signature", "encrypted_content", "redacted_thinking"] as const;

/** Which opaque field names (and which caller-supplied opaque VALUES, e.g. a scripted `signature`)
 *  leaked into this body's conversation. `[]` is the required answer on every hop. */
export function opaqueLeaks(body: string, opaqueValues: readonly string[] = []): string[] {
  const conversation = conversationOf(body);
  return [
    ...OPAQUE_FIELD_NAMES.filter((name) => conversation.includes(name)),
    // A VALUE check as well as a name check: a renderer that inlined a signature's bytes without its
    // field name would pass the names-only half.
    ...opaqueValues.filter((value) => body.includes(value)),
  ];
}

/**
 * Do these needles appear in the body in THIS ORDER, each exactly where the conversation would put
 * it? Returns the needles that are missing or out of order — `[]` is the required answer.
 *
 * Order is what makes this an assertion about a CONVERSATION rather than a bag of strings: the
 * destination must receive hop 0's user turn before hop 0's assistant turn before hop 1's, or it is
 * not the same conversation continued.
 */
export function outOfOrder(body: string, needles: readonly string[]): string[] {
  const bad: string[] = [];
  let cursor = 0;
  for (const needle of needles) {
    const at = body.indexOf(needle, cursor);
    if (at === -1) bad.push(needle);
    else cursor = at + needle.length;
  }
  return bad;
}

/** Is the prior model's reasoning carried, in either adapter's rendering, with its own provenance?
 *  See this file's header for the two forms and why both are accepted. */
export function carriesReasoning(body: string, opts: { kind: "summary" | "exposed"; provider: string; text: string }): boolean {
  if (!body.includes(opts.text)) return false;
  const responsesTag = `<recovered_reasoning kind=\\"${opts.kind}\\" provider=\\"${opts.provider}\\"`;
  const responsesTagRaw = `<recovered_reasoning kind="${opts.kind}" provider="${opts.provider}"`;
  if (body.includes(responsesTag) || body.includes(responsesTagRaw)) return true;
  return body.includes("prior-model reasoning, carried as data") && body.includes(`provider: ${opts.provider}`);
}
