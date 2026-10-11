// ComputerV2 Phase 4 — the SHAPE a saved script's source must have: exactly one function or arrow expression and
// nothing else. Pure; used by the worker before it sends a save and by the daemon before it keeps one (the worker is
// untrusted), with the persistent-REPL transform's own lexer (`repl.ts`).
//
// Why it matters: a saved source is evaluated again in later workers, as `return (\n<source>\n)`. Evaluating a
// function or arrow EXPRESSION runs nothing — parameter defaults and the body run only when it is called — so a source
// of this shape can be re-created without side effects. Anything else (a comma expression ending in a function, a
// call, a function followed by `(…)` or `.call(…)`) would run code at re-creation, so it is refused.
import { tokenize } from "./repl";

type Tok = ReturnType<typeof tokenize>[number];

const OPEN = new Set(["(", "[", "{"]);
const CLOSE = new Set([")", "]", "}"]);

/** The lexer's depth rule: brackets, and a template literal's `${…}` pieces (head +1, middle 0, tail −1). */
function depthDelta(t: Tok): number {
  if (t.type === "template") {
    const head = t.value.startsWith("`");
    const opens = t.templateOpen === true;
    if (head) return opens ? 1 : 0;
    return opens ? 0 : -1;
  }
  if (t.type === "punct" && OPEN.has(t.value)) return 1;
  if (t.type === "punct" && CLOSE.has(t.value)) return -1;
  return 0;
}

/** The token that closes the bracket opened at `open`, or -1 (never past a depth that went below it). */
function matchClose(toks: readonly Tok[], open: number): number {
  let depth = 0;
  for (let k = open; k < toks.length; k++) {
    depth += depthDelta(toks[k]!);
    if (depth === 0) return k;
    if (depth < 0) return -1;
  }
  return -1;
}

const is = (t: Tok | undefined, type: Tok["type"], value?: string): boolean => t !== undefined && t.type === type && (value === undefined || t.value === value);

/** A block `{ … }` starting at `at` that is the LAST thing in the source. */
const blockToEnd = (toks: readonly Tok[], at: number): boolean => is(toks[at], "punct", "{") && matchClose(toks, at) === toks.length - 1;

/**
 * Whether `source` is exactly one function or arrow expression: `function`/`function*` (optionally `async`, optionally
 * named) with its parameters and body and nothing after; or an arrow (`x =>`, `(…) =>`, optionally `async`) whose
 * body is a block ending the source, or an expression body with balanced brackets and no `,` or `;` at its own level.
 */
export function savedScriptShapeOk(source: string): boolean {
  let toks: Tok[];
  try { toks = tokenize(source); } catch { return false; }
  if (toks.length === 0) return false;
  let i = 0;
  // `async` as a prefix — not a parameter named `async` (`async => …`).
  if (is(toks[0], "ident", "async") && !is(toks[1], "punct", "=>") && !toks[1]?.nl) i = 1;
  if (is(toks[i], "ident", "function")) {
    i++;
    if (is(toks[i], "punct", "*")) i++;
    if (is(toks[i], "ident")) i++;
    if (!is(toks[i], "punct", "(")) return false;
    const params = matchClose(toks, i);
    if (params < 0) return false;
    return blockToEnd(toks, params + 1);
  }
  if (is(toks[i], "punct", "(")) {
    const params = matchClose(toks, i);
    if (params < 0) return false;
    i = params + 1;
  } else if (is(toks[i], "ident") && toks[i]!.value !== "function" && toks[i]!.value !== "class") {
    i++;
  } else {
    return false;
  }
  if (!is(toks[i], "punct", "=>")) return false;
  i++;
  if (i >= toks.length) return false;
  if (is(toks[i], "punct", "{")) return blockToEnd(toks, i);
  // An expression body: it runs only when called, and must be all that follows.
  let depth = 0;
  for (let k = i; k < toks.length; k++) {
    const t = toks[k]!;
    if (depth === 0 && t.type === "punct" && (t.value === "," || t.value === ";")) return false;
    depth += depthDelta(t);
    if (depth < 0) return false;
  }
  return depth === 0;
}
