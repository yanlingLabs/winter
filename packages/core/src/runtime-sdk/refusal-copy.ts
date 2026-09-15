/**
 * What a ROUTER REFUSAL may say to a user, and what only the log may see.
 *
 * The router's `SelectionRefusal.detail` is written for a host, not for a person. Measured shapes
 * from the pinned router (0.0.7) name a RUNTIME ("the official runtime", "persisted on
 * claude-agent"), cite internal spec ids ("WS-00 §2, D13", "(D28)"), and — for `slot-unservable` —
 * enumerate the user's own configured providers ("configured: openai, openrouter"). R-10b-4 forbids
 * the first outright; the second is noise; the third is a fact about the user's setup that has no
 * business on a wire that reaches the phone.
 *
 * `session.setModel` has scrubbed this class since D1 fix round 4. `session.create` did not — it
 * handed `detail` through verbatim — which is what the whole-branch review caught. Both doors now
 * share ONE definition, here, so they cannot drift again: the raw detail goes to the LOG as a
 * category, and the user gets copy Winter owns.
 */

/** The raw detail, reduced to something a log line can carry. NEVER the text itself. */
export function refusalDetailCategoryFor(detail: string): "names-a-runtime" | "names-a-spec-id" | "opaque" {
  if (/\b(winter|official|claude)[- ]?(runtime|agent)\b/i.test(detail)) return "names-a-runtime";
  if (/\b(WS-\d|D\d{1,2}\b|R-\d)/.test(detail)) return "names-a-spec-id";
  return "opaque";
}

/** The neutral sentence a refusal Winter has nothing better to say about gets. One shape for every
 *  reason, deliberately — conditioning the copy on the reason's content is how the content leaks. */
export function neutralSelectionRefusal(modelLabel: string): string {
  return `Winter can't start a session on ${modelLabel} right now.`;
}
