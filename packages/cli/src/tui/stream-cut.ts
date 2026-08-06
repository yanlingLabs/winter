/** `stream-cut.ts` (TUI renderer T3) — the pure line-cut every streaming render derives from
 *  (mechanism report Q2, adapted): a growing stream buffer splits at its LAST newline into
 *  `complete` (fully-terminated source lines — the part that settles into the transcript flow and
 *  whose markdown boundary is allowed to advance) and `tail` (the single still-open source line,
 *  re-rendered per delta). The cut is defined purely on `\n`: a `\r` in a CRLF pair stays glued to
 *  its `\n` inside `complete`, and a bare interior `\r` with no `\n` yet is NOT a cut point (see
 *  the test file's CRLF note — provider deltas are raw model text, so CRLF can occur on the wire).
 *
 *  Invariants (each pinned by `test/tui/stream-cut.test.ts`): `complete + tail === buffer`;
 *  `tail` never contains `\n`; `complete` is empty or ends with `\n`. No Ink, no React, no state —
 *  a total, deterministic transform. */

export function cutCompleteLines(buffer: string): { complete: string; tail: string } {
  const lastNewline = buffer.lastIndexOf("\n");
  if (lastNewline === -1) return { complete: "", tail: buffer };
  return { complete: buffer.slice(0, lastNewline + 1), tail: buffer.slice(lastNewline + 1) };
}
