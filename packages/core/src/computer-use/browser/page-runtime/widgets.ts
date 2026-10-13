// ComputerV2 — the page runtime's WIDGET decisions, as pure functions over plain facts (no DOM types, no I/O): how a
// long value is cut and measured, what a check box's state is when a page builds it from ARIA or draws it over a
// hidden native input (Material-style controls), and which option of a list a wanted text names. The runtime
// (`main.ts`) reads the facts off the page; the engine and the unit tests ask these directly.
import { sliceUnits } from "./rules";

/** A state line's value cap (characters): past it a value is cut and says its length. */
export const VALUE_CAP = 200;
/** A `state({ within })` read's value cap: one element's field, read back whole up to this many characters (the
 *  helper's `wholeValueCap`). */
export const WHOLE_VALUE_CAP = 8_000;

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/** How many characters (code points) `s` holds. */
export function countPoints(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (isHigh(s.charCodeAt(i)) && i + 1 < s.length && isLow(s.charCodeAt(i + 1))) i++;
    n++;
  }
  return n;
}

/** The first `n` characters (code points) of `s` — never half a surrogate pair. */
export function prefixPoints(s: string, n: number): string {
  if (n <= 0) return "";
  if (s.length <= n) return s;
  let i = 0;
  for (let k = 0; k < n && i < s.length; k++) i += isHigh(s.charCodeAt(i)) && i + 1 < s.length && isLow(s.charCodeAt(i + 1)) ? 2 : 1;
  return s.slice(0, i);
}

/** A value as the runtime hands it over: whole up to `cap` characters, else its first `cap` and its full length. */
export function capValue(s: string, cap: number): { value: string; length?: number } {
  if (s.length <= cap) return { value: s };
  const length = countPoints(s);
  return length <= cap ? { value: s } : { value: prefixPoints(s, cap), length };
}

/** A value as the model reads it — the helper's wording (`StateFormatter.renderedValue`, `Finder.summary`): whole up to
 *  `cap` characters, else `"<first cap>…" (N characters — state({within:R}) shows it whole)`; the pointer only below
 *  the whole-value cap (a within read's own cut has nowhere further to point). `fullLength`: the length the runtime
 *  measured before it cut. `quoteFn` quotes the kept text. */
export function valueWithLength(ref: number, value: string, fullLength: number | undefined, cap: number, quoteFn: (s: string) => string): string {
  const length = Math.max(fullLength ?? 0, countPoints(value));
  if (length <= cap) return quoteFn(value);
  const whole = cap >= WHOLE_VALUE_CAP ? ""
    : length <= WHOLE_VALUE_CAP ? ` — state({within:${ref}}) shows it whole` : ` — state({within:${ref}}) shows its first ${WHOLE_VALUE_CAP}`;
  return `${quoteFn(`${prefixPoints(value, cap)}…`)} (${length} characters${whole})`;
}

// ── check boxes, radios, switches ─────────────────────────────────────────────────────────────────

/**
 * The roles whose accessible name is their content when nothing else names them (ARIA's "name from content"): their
 * subtree is not read again as text. Check boxes and radios are among them — a `<div role="checkbox">Accept the
 * terms</div>` (a Material-style box) is named "Accept the terms", as the browser's own accessibility names it; before,
 * it read unnamed, its text a child, and `find({ name })` missed it (the leftover probes, 2026-10-13).
 */
export const NAME_FROM_CONTENT_ROLES: ReadonlySet<string> = new Set([
  "button", "link", "heading", "tab", "option", "menuitem", "menuitemcheckbox", "menuitemradio", "treeitem", "cell", "columnheader", "rowheader",
  "switch", "checkbox", "radio",
]);

/** Is a role named by its content (ARIA name from content)? Pure. */
export function nameFromContent(role: string | undefined): boolean {
  return role !== undefined && NAME_FROM_CONTENT_ROLES.has(role);
}

/** What a checkable control's state is read from: the element's own `aria-checked`, and the native check box or radio
 *  that carries it — the element itself (`nativeIsSelf`), or one it wraps or labels (a page that draws its own box over
 *  a hidden native input). */
export interface CheckFacts {
  ariaChecked: string | null;
  native?: { checked: boolean; indeterminate: boolean };
  nativeIsSelf?: boolean;
}
export type CheckedState = "checked" | "unchecked" | "mixed";

/** A native control's own state wins on itself; on a wrapper, its stated `aria-checked` (what a screen reader hears),
 *  else the native control it wraps; nothing at all reads unchecked. */
export function checkedStateOf(f: CheckFacts): CheckedState {
  const native = (n: { checked: boolean; indeterminate: boolean }): CheckedState => (n.indeterminate ? "mixed" : n.checked ? "checked" : "unchecked");
  if (f.native !== undefined && f.nativeIsSelf === true) return native(f.native);
  const aria = (f.ariaChecked ?? "").trim().toLowerCase();
  if (aria === "true") return "checked";
  if (aria === "mixed") return "mixed";
  if (aria === "false") return "unchecked";
  return f.native === undefined ? "unchecked" : native(f.native);
}

/** Did a press do what it should? A check box or switch flips; a radio button ends checked. */
export function pressTookEffect(kind: "checkbox" | "radio", before: boolean, after: boolean): boolean {
  return kind === "radio" ? after : after !== before;
}

// ── options (a <select>'s, a list box's) ──────────────────────────────────────────────────────────

/** One option as the runtime read it: its visible text (collapsed), its value (a native option's), and its states. */
export interface OptionFacts { text: string; value?: string; disabled?: boolean; selected?: boolean }

const fold = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The option a wanted text names: its visible text exactly (case and spacing aside), else its value exactly, else the
 *  ONE option whose text starts with it, else the ONE whose text contains it. More than one at a step is ambiguous:
 *  never a guess ("Small" must not pick "Extra Small" by chance). */
export type OptionMatch<T> = { option: T } | { ambiguous: T[] } | { none: true };
export function matchOption<T extends OptionFacts>(options: readonly T[], want: string): OptionMatch<T> {
  const w = fold(want);
  if (w.length === 0) return { none: true };
  const exact = options.find((o) => fold(o.text) === w) ?? options.find((o) => o.value !== undefined && o.value.toLowerCase() === w);
  if (exact !== undefined) return { option: exact };
  for (const step of [(t: string) => t.startsWith(w), (t: string) => t.includes(w)]) {
    const hits = options.filter((o) => step(fold(o.text)));
    if (hits.length === 1) return { option: hits[0]! };
    if (hits.length > 1) return { ambiguous: hits };
  }
  return { none: true };
}

/** The refusal when a wanted text names more than one option: the candidates (at most 10). */
export function ambiguousOptionSentence(want: string, candidates: readonly OptionFacts[]): string {
  return `"${capText(want, 60)}" matches more than one option: ${candidates.slice(0, 10).map((o) => `"${capText(o.text, 40)}"`).join(", ")}${candidates.length > 10 ? ` … and ${candidates.length - 10} more` : ""} — give the whole option text`;
}

const capText = (s: string, n: number): string => (s.length <= n ? s : `${sliceUnits(s, n)}…`);

/** The refusal when no option matches: the first 20 options, by their text. */
export function noOptionSentence(want: string, options: readonly OptionFacts[]): string {
  const list = options.length === 0 ? "(it lists none)" : options.slice(0, 20).map((o) => `"${capText(o.text, 40)}"`).join(", ");
  return `no option "${capText(want, 60)}" — the options are: ${list}${options.length > 20 ? ` … and ${options.length - 20} more` : ""}`;
}

/** Does a combo box now show the option chosen? Its shown text IS the option's (case and spacing aside) — never a
 *  text that merely contains it ("Extra Small" does not show "Small"). */
export function comboShows(shown: string | undefined, option: string): boolean {
  const o = fold(option);
  return o.length > 0 && fold(shown ?? "") === o;
}
