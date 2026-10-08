// ComputerV2 (2026-10-08) — the automation worker's PERSISTENT-REPL transform. Pure: no I/O, no globals.
//
// A script is evaluated as the body of an async function, inside `with (__scope) { … }` where `__scope` is a
// Proxy over the session's persistent store. That gives top-level `await` for free, and makes every free
// identifier the store HAS resolve to it. What it does not give is persistence of DECLARATIONS: a top-level
// `const`/`let`/`class` in a function body is local to that one call. So this module finds the TOP-LEVEL
// declarations (depth 0 — never one inside a block, a `for (const …)`, a function body or a template
// expression) and rewrites them in place into assignments to names it pre-seeds in the store:
//
//   const x = 1, {a, b: [c]} = o    →   ;x = 1, ({a, b: [c]} = o);       names: x, a, c
//   let y                          →   ;y = undefined;                  names: y
//   class C { … }                  →   ;C = class C { … };              names: C
//   function f() { … }             →   left in place (block-level hoisting inside the `with` block), and
//                                        copied into the store at block entry; names: f (as `functions`)
//
// Redeclaring is therefore just reassigning — the REPL semantics the tool promises. Every edit keeps the
// line structure (an inserted `;`/`(`/`)`/`= undefined` never adds a newline), so an error's line number
// in the rewritten body is the line in the model's own script. TypeScript is NOT this module's business:
// the worker tries the script as JavaScript first and only on a syntax error strips types with Bun's
// transpiler and runs the result through here again (`entry.ts`).
//
// The lexer is the smallest one that tracks depth correctly: strings, template literals with nested
// `${…}`, regular-expression literals (told from division by the previous token), comments and
// punctuators. A shape it does not recognise inside a declaration makes `prepareScript` throw
// `ReplTransformError`, and the caller falls back to the transpiler (then to reporting the error).

export class ReplTransformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplTransformError";
  }
}

type TokType = "ident" | "punct" | "string" | "template" | "regex" | "number" | "private";

interface Tok {
  type: TokType;
  value: string;
  start: number;
  end: number;
  /** A line terminator sits between this token and the previous one. */
  nl: boolean;
  /** Set on a template token: does it end with `${` (a head/middle) or with a closing backtick? */
  templateOpen?: boolean;
}

const PUNCTUATORS = [
  ">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=",
  "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=",
  "&=", "|=", "^=", "<<", ">>", "**",
  "{", "}", "(", ")", "[", "]", ";", ",", "<", ">", "+", "-", "*", "/", "%", "&", "|", "^", "!", "~",
  "?", ":", "=", ".", "@", "#",
];

/** Keywords after which a `/` starts a regular expression rather than a division. */
const REGEX_AFTER_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else",
  "yield", "await",
]);

const isIdStart = (c: string): boolean => /[\p{ID_Start}$_\\]/u.test(c);
const isIdPart = (c: string): boolean => /[\p{ID_Continue}$\u200c\u200d\\]/u.test(c);

/** Can `prev` END an expression (so a following `/` is a division, and a newline may be an ASI point)? */
function endsExpression(prev: Tok | undefined): boolean {
  if (prev === undefined) return false;
  switch (prev.type) {
    case "number": case "string": case "regex": case "private": return true;
    case "template": return prev.templateOpen !== true;
    case "ident": return !REGEX_AFTER_KEYWORDS.has(prev.value);
    case "punct": return prev.value === ")" || prev.value === "]" || prev.value === "}" || prev.value === "++" || prev.value === "--";
  }
}

/** Tokenize `src`. Throws `ReplTransformError` on an unterminated string, template, regex or comment. */
export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  // For each `{` / `${` opened: whether closing it resumes a template literal.
  const braceStack: boolean[] = [];
  let i = 0;
  let nl = false;
  const n = src.length;
  const push = (t: Omit<Tok, "nl">): void => { out.push({ ...t, nl }); nl = false; };

  const scanTemplate = (from: number): void => {
    // `from` is just past a backtick or a `}` that closes a `${`. Scan to the next backtick or `${`.
    let j = from;
    while (j < n) {
      const c = src[j]!;
      if (c === "\\") { j += 2; continue; }
      if (c === "`") { push({ type: "template", value: src.slice(from - 1, j + 1), start: from - 1, end: j + 1, templateOpen: false }); i = j + 1; return; }
      if (c === "$" && src[j + 1] === "{") {
        push({ type: "template", value: src.slice(from - 1, j + 2), start: from - 1, end: j + 2, templateOpen: true });
        braceStack.push(true);
        i = j + 2;
        return;
      }
      j++;
    }
    throw new ReplTransformError("unterminated template literal");
  };

  while (i < n) {
    const c = src[i]!;
    // Whitespace and line terminators.
    if (c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029") { nl = true; i++; continue; }
    if (c === " " || c === "\t" || c === "\v" || c === "\f" || c === "\u00a0" || c === "\ufeff" || /\s/u.test(c)) { i++; continue; }
    // Comments.
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n" && src[i] !== "\r") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      if (close < 0) throw new ReplTransformError("unterminated comment");
      if (/[\n\r\u2028\u2029]/u.test(src.slice(i, close))) nl = true;
      i = close + 2;
      continue;
    }
    // Hashbang on the very first line.
    if (i === 0 && c === "#" && src[1] === "!") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    // Strings.
    if (c === "'" || c === "\"") {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === "\\") j++;
        else if (src[j] === "\n") throw new ReplTransformError("unterminated string literal");
        j++;
      }
      if (j >= n) throw new ReplTransformError("unterminated string literal");
      push({ type: "string", value: src.slice(i, j + 1), start: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    // Template literals.
    if (c === "`") { scanTemplate(i + 1); continue; }
    if (c === "}" && braceStack.length > 0 && braceStack[braceStack.length - 1] === true) {
      braceStack.pop();
      scanTemplate(i + 1);
      continue;
    }
    // Numbers (a leading digit, or `.` followed by a digit).
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n && /[0-9a-zA-Z_.]/.test(src[j]!)) {
        // An exponent's sign belongs to the number.
        if ((src[j] === "e" || src[j] === "E") && (src[j + 1] === "+" || src[j + 1] === "-") && !/^0[xXbBoO]/.test(src.slice(i, j))) j += 2;
        else j++;
      }
      push({ type: "number", value: src.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    // Private names.
    if (c === "#" && isIdStart(src[i + 1] ?? "")) {
      let j = i + 2;
      while (j < n && isIdPart(src[j]!)) j++;
      push({ type: "private", value: src.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    // Identifiers and keywords.
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(src[j]!)) j++;
      push({ type: "ident", value: src.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    // A regular-expression literal where an expression may START.
    if (c === "/" && !endsExpression(out[out.length - 1])) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const d = src[j]!;
        if (d === "\\") { j += 2; continue; }
        if (d === "\n" || d === "\r") throw new ReplTransformError("unterminated regular expression");
        if (inClass) { if (d === "]") inClass = false; }
        else if (d === "[") inClass = true;
        else if (d === "/") break;
        j++;
      }
      if (j >= n) throw new ReplTransformError("unterminated regular expression");
      j++;
      while (j < n && isIdPart(src[j]!)) j++; // flags
      push({ type: "regex", value: src.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    const p = PUNCTUATORS.find((cand) => src.startsWith(cand, i));
    if (p === undefined) throw new ReplTransformError(`unexpected character ${JSON.stringify(c)}`);
    if (p === "{") braceStack.push(false);
    else if (p === "}") braceStack.pop();
    // `?.` followed by a digit is `?` then a number (`a?.5:b`).
    const value = p === "?." && /[0-9]/.test(src[i + 2] ?? "") ? "?" : p;
    push({ type: "punct", value, start: i, end: i + value.length });
    i += value.length;
  }
  return out;
}

const OPEN = new Set(["(", "[", "{"]);
const CLOSE = new Set([")", "]", "}"]);
const isOpen = (t: Tok): boolean => (t.type === "punct" && OPEN.has(t.value)) || (t.type === "template" && t.templateOpen === true);
const isClose = (t: Tok): boolean => t.type === "punct" && CLOSE.has(t.value);
/** A template middle (`}…${`) both closes and opens; a template tail (`}…\``) only closes. Both are handled by the
 *  brace stack in the lexer: the `}` is consumed into the template token. So for depth: a template head opens
 *  one level, a middle keeps it, a tail closes it. */
function depthDelta(t: Tok): number {
  if (t.type === "template") {
    const startsWithBacktick = t.value.startsWith("`");
    const opensExpr = t.templateOpen === true;
    // head: `…${  → +1;  middle: }…${ → 0;  tail: }…` → -1;  no-substitution: `…` → 0
    if (startsWithBacktick) return opensExpr ? 1 : 0;
    return opensExpr ? 0 : -1;
  }
  if (isOpen(t)) return 1;
  if (isClose(t)) return -1;
  return 0;
}

/** Index of the token that closes the bracket opened at `open` (same depth), or -1. */
function matchClose(toks: Tok[], open: number): number {
  let depth = 0;
  for (let k = open; k < toks.length; k++) {
    depth += depthDelta(toks[k]!);
    if (depth === 0) return k;
  }
  return -1;
}

/** Tokens that, at the start of the next line, CONTINUE the previous expression (no automatic semicolon). */
const CONTINUES = new Set([
  "(", "[", ".", "?.", ",", "=", "=>", "+", "-", "*", "/", "%", "**", "<", ">", "<=", ">=", "==", "!=", "===",
  "!==", "&", "|", "^", "&&", "||", "??", "?", ":", "+=", "-=", "*=", "/=", "%=", "**=", "<<", ">>", ">>>",
  "<<=", ">>=", ">>>=", "&=", "|=", "^=", "&&=", "||=", "??=",
]);

function continuesExpression(t: Tok): boolean {
  if (t.type === "punct") return CONTINUES.has(t.value);
  if (t.type === "template") return t.value.startsWith("`"); // a tagged template continues
  if (t.type === "ident") return t.value === "in" || t.value === "instanceof" || t.value === "as" || t.value === "satisfies";
  return false;
}

/**
 * The end (exclusive token index) of the declaration statement whose declarators begin at `from`, and
 * whether it ended at an explicit `;` (`semi` is that token's index). Ends at a depth-0 `;`, at a closing
 * bracket that would go below depth 0, at EOF, or where a line break is an automatic-semicolon point.
 */
function statementEnd(toks: Tok[], from: number): { end: number; semi?: number } {
  let depth = 0;
  for (let k = from; k < toks.length; k++) {
    const t = toks[k]!;
    if (depth === 0 && k > from && t.nl && endsExpression(toks[k - 1]) && !continuesExpression(t)) return { end: k };
    if (depth === 0 && t.type === "punct" && t.value === ";") return { end: k, semi: k };
    const d = depthDelta(t);
    if (depth + d < 0) return { end: k };
    depth += d;
  }
  return { end: toks.length };
}

/** Split tokens [from, to) at depth-0 commas. */
function splitTopLevel(toks: Tok[], from: number, to: number): Array<[number, number]> {
  const parts: Array<[number, number]> = [];
  let depth = 0;
  let start = from;
  for (let k = from; k < to; k++) {
    const t = toks[k]!;
    if (depth === 0 && t.type === "punct" && t.value === ",") { parts.push([start, k]); start = k + 1; continue; }
    depth += depthDelta(t);
  }
  parts.push([start, to]);
  return parts;
}

/** Index just past an expression starting at `from` that ends at a depth-0 `,` or the pattern's own close. */
function skipExpression(toks: Tok[], from: number, stopAt: number): number {
  let depth = 0;
  for (let k = from; k < stopAt; k++) {
    const t = toks[k]!;
    if (depth === 0 && t.type === "punct" && t.value === ",") return k;
    const d = depthDelta(t);
    if (depth + d < 0) return k;
    depth += d;
  }
  return stopAt;
}

/** The binding names a destructuring pattern at `open` (a `{` or `[`) declares, and its closing index. */
function patternNames(toks: Tok[], open: number): { names: string[]; close: number } {
  const close = matchClose(toks, open);
  if (close < 0) throw new ReplTransformError("unterminated destructuring pattern");
  const names: string[] = [];
  const isObject = toks[open]!.value === "{";
  let k = open + 1;
  const target = (at: number): number => {
    const t = toks[at];
    if (t === undefined) throw new ReplTransformError("malformed destructuring pattern");
    if (t.type === "ident") { names.push(t.value); return at + 1; }
    if (t.type === "punct" && (t.value === "{" || t.value === "[")) {
      const inner = patternNames(toks, at);
      names.push(...inner.names);
      return inner.close + 1;
    }
    throw new ReplTransformError(`unexpected ${JSON.stringify(t.value)} in a destructuring pattern`);
  };
  const afterElement = (at: number): number => {
    // optional `= default`, then `,` or the close.
    let p = at;
    if (toks[p]?.type === "punct" && toks[p]!.value === "=") p = skipExpression(toks, p + 1, close);
    if (p < close && toks[p]!.type === "punct" && toks[p]!.value === ",") return p + 1;
    if (p === close) return p;
    throw new ReplTransformError(`unexpected ${JSON.stringify(toks[p]?.value ?? "")} in a destructuring pattern`);
  };
  while (k < close) {
    const t = toks[k]!;
    if (!isObject && t.type === "punct" && t.value === ",") { k++; continue; } // a hole
    if (t.type === "punct" && t.value === "...") { k = afterElement(target(k + 1)); continue; }
    if (!isObject) { k = afterElement(target(k)); continue; }
    // Object: key (identifier, string, number or [computed]), then `: target` or shorthand.
    let keyIdent: string | undefined;
    if (t.type === "ident") { keyIdent = t.value; k++; }
    else if (t.type === "string" || t.type === "number") k++;
    else if (t.type === "punct" && t.value === "[") {
      const c = matchClose(toks, k);
      if (c < 0 || c > close) throw new ReplTransformError("malformed computed key");
      k = c + 1;
    } else throw new ReplTransformError(`unexpected ${JSON.stringify(t.value)} in a destructuring pattern`);
    if (toks[k]?.type === "punct" && toks[k]!.value === ":") { k = afterElement(target(k + 1)); continue; }
    if (keyIdent === undefined) throw new ReplTransformError("a destructured key needs a target");
    names.push(keyIdent);
    k = afterElement(k);
  }
  return { names, close };
}

export interface PreparedScript {
  /** The rewritten script body, line-for-line with the source. */
  body: string;
  /** Names the store must HAVE before the body runs (top-level const/let/var/class bindings). */
  names: string[];
  /** Top-level function declarations, copied into the store at block entry. */
  functions: string[];
}

interface Edit { at: number; remove: number; insert: string }

const DECLARATION_KEYWORDS = new Set(["const", "let", "var"]);

/** Is the depth-0 token at `k` at the start of a statement? */
function atStatementStart(toks: Tok[], k: number): boolean {
  if (k === 0) return true;
  const prev = toks[k - 1]!;
  if (prev.type === "punct" && (prev.value === ";" || prev.value === "}")) return true;
  return toks[k]!.nl && endsExpression(prev);
}

/** Rewrite a script's top-level declarations into persistent assignments. Throws `ReplTransformError`. */
export function prepareScript(src: string): PreparedScript {
  const toks = tokenize(src);
  const edits: Edit[] = [];
  const names: string[] = [];
  const functions: string[] = [];
  let depth = 0;
  let k = 0;
  while (k < toks.length) {
    const t = toks[k]!;
    if (depth === 0 && t.type === "ident" && atStatementStart(toks, k)) {
      // `export` / `export default` at the top of a script mean nothing here: dropped.
      if (t.value === "export") {
        edits.push({ at: t.start, remove: t.end - t.start, insert: "" });
        const next = toks[k + 1];
        if (next?.type === "ident" && next.value === "default") {
          edits.push({ at: next.start, remove: next.end - next.start, insert: "" });
          k += 2;
        } else k += 1;
        // Re-examine the following token as a statement start.
        const following = toks[k];
        if (following === undefined) break;
        toks[k] = { ...following, nl: true };
        continue;
      }
      if (t.value === "import" && toks[k + 1]?.type !== "punct") {
        throw new ReplTransformError("import statements are not available in the automation runtime");
      }
      // `let` used as an identifier (`let = 1`, `let[0]`) is not a declaration.
      const next = toks[k + 1];
      const letIsIdent = t.value === "let" && (next === undefined || (next.type === "punct" && next.value !== "{" && next.value !== "["));
      if (DECLARATION_KEYWORDS.has(t.value) && !letIsIdent && next !== undefined) {
        const { end, semi } = statementEnd(toks, k + 1);
        const parts = splitTopLevel(toks, k + 1, end);
        edits.push({ at: t.start, remove: t.end - t.start, insert: ";" });
        for (const [a, b] of parts) {
          const head = toks[a];
          if (head === undefined || a >= b) throw new ReplTransformError(`malformed ${t.value} declaration`);
          if (head.type === "ident") {
            names.push(head.value);
            const after = toks[a + 1];
            if (a + 1 === b) edits.push({ at: head.end, remove: 0, insert: " = undefined" });
            else if (!(after?.type === "punct" && after.value === "=")) throw new ReplTransformError(`unexpected ${JSON.stringify(after?.value ?? "")} after ${head.value}`);
          } else if (head.type === "punct" && (head.value === "{" || head.value === "[")) {
            const { names: bound, close } = patternNames(toks, a);
            names.push(...bound);
            const eq = toks[close + 1];
            if (close + 1 >= b || !(eq?.type === "punct" && eq.value === "=")) throw new ReplTransformError("a destructuring declaration needs an initializer");
            if (head.value === "{") {
              edits.push({ at: head.start, remove: 0, insert: "(" });
              edits.push({ at: toks[b - 1]!.end, remove: 0, insert: ")" });
            }
          } else throw new ReplTransformError(`unexpected ${JSON.stringify(head.value)} in a ${t.value} declaration`);
        }
        if (semi === undefined && end > k + 1) edits.push({ at: toks[end - 1]!.end, remove: 0, insert: ";" });
        k = semi === undefined ? end : semi + 1;
        continue;
      }
      if (t.value === "class" && next?.type === "ident" && next.value !== "extends") {
        // The heritage clause may itself contain braces (`extends mixin({…})`): find the body brace at
        // depth 0 relative to the class keyword.
        let d = 0;
        let open = -1;
        for (let m = k + 2; m < toks.length; m++) {
          const x = toks[m]!;
          if (d === 0 && x.type === "punct" && x.value === "{") { open = m; break; }
          d += depthDelta(x);
        }
        if (open < 0) throw new ReplTransformError("malformed class declaration");
        const close = matchClose(toks, open);
        if (close < 0) throw new ReplTransformError("unterminated class body");
        names.push(next.value);
        edits.push({ at: t.start, remove: 0, insert: `;${next.value} = ` });
        edits.push({ at: toks[close]!.end, remove: 0, insert: ";" });
        k = close + 1;
        continue;
      }
      const fnAt = t.value === "function" ? k : t.value === "async" && next?.type === "ident" && next.value === "function" && !next.nl ? k + 1 : -1;
      if (fnAt >= 0) {
        let nameAt = fnAt + 1;
        if (toks[nameAt]?.type === "punct" && toks[nameAt]!.value === "*") nameAt++;
        const nameTok = toks[nameAt];
        if (nameTok?.type === "ident") functions.push(nameTok.value);
        // Walk on normally: the body raises and lowers the depth.
      }
    }
    depth += depthDelta(t);
    k++;
  }
  // Apply edits back to front so earlier offsets stay valid. Two insertions at ONE offset must land in the
  // order they were pushed (`x` + ` = undefined` + `;`, `pattern = init` + `)` + `;`), and applying an
  // insertion at an offset puts it BEFORE whatever an earlier application put there — so at equal
  // offsets the LATER-pushed edit is applied first.
  const ordered = edits.map((e, idx) => ({ e, idx })).sort((a, b) => (b.e.at - a.e.at) || (b.idx - a.idx));
  let body = src;
  for (const { e } of ordered) body = body.slice(0, e.at) + e.insert + body.slice(e.at + e.remove);
  return { body, names: [...new Set(names)], functions: [...new Set(functions)] };
}
