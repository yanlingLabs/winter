// ComputerV2 — how long a type() or paste() of some text is expected to take in the helper, so a known-long
// primitive is never killed by the run's timeout halfway through (live: a 3,000-character paste typed for 29 s
// and was cancelled at the default 30 s, the field part-filled). It mirrors the helper's route split
// (`CUCore.typeText` / `backgroundWebPaste`): multi-line or longer text is pasted; short text goes as keys, at the
// helper's batched pace plus its per-character focus check and one keyboard focus blip per burst.

/** At most this many characters are typed as keys; longer or multi-line text is pasted (the helper's `typeKeysMax`). */
export const TYPE_KEYS_MAX = 200;
/** Per character typed as keys, with the helper's checks and blips — calibrate from the helper's "chars/s" log line. */
export const PER_KEY_MS = 6;
/** A type's fixed cost: the accessibility insert tried first (it can wait 400 ms for a web editor), focus placement. */
export const TYPE_FIXED_MS = 1_000;
/** A paste's fixed cost: the clipboard, the real paste in up to two focus blips, the read-back wait (≤ 1.5 s). */
export const PASTE_FIXED_MS = 3_000;

/** The expected time (ms) of a `type` or `paste` of `text`. */
export function typingEstimateMs(primitive: "type" | "paste", text: string): number {
  const chars = [...text].length;
  const asKeys = chars <= TYPE_KEYS_MAX && !/[\r\n]/.test(text);
  if (primitive === "type") return asKeys ? TYPE_FIXED_MS + chars * PER_KEY_MS : TYPE_FIXED_MS + PASTE_FIXED_MS;
  // A paste the helper could not do for real types short text instead.
  return PASTE_FIXED_MS + (chars <= TYPE_KEYS_MAX ? chars * PER_KEY_MS : 0);
}

/**
 * What to do when a text primitive's estimate does not fit the run's time left: extend the run by the estimate,
 * within the 300 s maximum — or refuse up front when even that is too little.
 */
export type TypingFit = { kind: "fits" } | { kind: "extend"; byMs: number } | { kind: "refuse"; message: string };

export function typingFit(estimateMs: number, leftMs: number, budgetMs: number, maxMs: number, margin = 1_000): TypingFit {
  if (estimateMs + margin <= leftMs) return { kind: "fits" };
  const byMs = Math.min(estimateMs + margin, Math.max(0, maxMs - budgetMs));
  // Within the maximum, the estimate itself must fit (the margin is only asked for when there is room).
  if (byMs > 0 && leftMs + byMs >= estimateMs) return { kind: "extend", byMs };
  if (leftMs >= estimateMs) return { kind: "fits" };  // tight, with no room left to extend
  const seconds = Math.max(1, Math.ceil(estimateMs / 1000));
  return { kind: "refuse", message: `this text would take ~${seconds} s to type — pass timeoutMs or paste it` };
}
