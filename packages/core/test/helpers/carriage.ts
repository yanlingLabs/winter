// WS-18 §9 / W18-19 — what "body-level on every hop" actually means, as predicates over the raw
// request bodies the loopback fakes record (Lane P fix round 1, review Major 1).
//
// A hop asserted only as "the body names the model id" proves the ROUTING and nothing else: an
// empty, rebuilt conversation on the right endpoint would pass it. What W18-19 is about is what
// TRAVELS — the prior turns, in order, and the prior model's reasoning re-rendered as data the
// destination can read, with the source's opaque state left behind. These are the three questions,
// asked of the bytes that actually went out.
//
// THE CARRIAGE'S FORM IS CHOSEN BY THE DESTINATION'S OWN READABLE STATE, not by its adapter (review
// correction — the first pass of this comment said "per-adapter", which happens to agree on every
// row we exercise and is the wrong rule). The SDK's `doorFor` picks the THINKING CHANNEL for a
// destination whose `readableState` is `full-exposed`, and the TAG for every other destination;
// `kind` is then the SOURCE's own readableState. MEASURED 2026-09-15 against the pinned SDK 0.0.12 /
// router 0.0.7 through real `dist/winter` children:
//
//   - TAG door (a destination that is not full-exposed — the `openai` rows we drive here, and a
//     Claude destination): W18-19's literal
//       <recovered_reasoning kind="exposed" provider="deepseek" model="deepseek/deepseek-reasoner">…</recovered_reasoning>
//     with `kind="summary"` for a Claude source and `kind="exposed"` for DeepSeek/GLM.
//   - THINKING-CHANNEL door (a full-exposed destination — the deepseek and zai rows we drive here):
//     the same fact as a labelled plain-text prefix on the assistant message,
//       [prior-model reasoning, carried as data — provider: deepseek, model: deepseek/deepseek-reasoner]
//     followed by the reasoning text. This door renders NO `kind` at all, which is why
//     `carriesReasoning` cannot check one on it and the tests that need `kind` proven use a
//     tag-door destination.
//
// Both carry the same three things (the text, the source provider, the source model), so
// `carriesReasoning` accepts either and each test says which door its destination takes. Asserting
// only the angle-bracket form would have made every thinking-channel hop unprovable and read as a
// defect.

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
    // `instructions` is the Responses leg's system prompt (review nit) — part of the conversation,
    // and cheap to include. It carries no tool schemas, so it does not reintroduce the
    // `encrypted_content` false hit the tool list would.
    return JSON.stringify({ messages: o.messages, input: o.input, system: o.system, instructions: o.instructions });
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
  // ASSOCIATED on the tag branch too (review N6): `kind` and `provider` must be in the SAME tag, so
  // a body carrying two prior models of different kinds cannot satisfy a claim about one of them
  // using the other one's `kind`.
  const responsesTag = `<recovered_reasoning kind=\\"${opts.kind}\\" provider=\\"${opts.provider}\\"`;
  const responsesTagRaw = `<recovered_reasoning kind="${opts.kind}" provider="${opts.provider}"`;
  if (body.includes(responsesTag) || body.includes(responsesTagRaw)) return true;
  // ASSOCIATED, not merely both-present (review nit): the label and the provider must be in the SAME
  // prefix, so a body carrying two prior models cannot satisfy a claim about one of them using the
  // other one's label.
  return body.includes(`prior-model reasoning, carried as data — provider: ${opts.provider}`)
    || body.includes(`prior-model reasoning, carried as data \\u2014 provider: ${opts.provider}`);
}
