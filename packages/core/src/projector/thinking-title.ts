import { THINKING_TITLE_MAX_LENGTH } from "@yanlinglabs/winter-protocol";

/**
 * ── THE THINKING PILL'S TITLE (2026-10-05, user ruling) ─────────────────────────────────────────
 *
 * Every reasoning block a provider shows us gets a title whenever one can be inferred, in this order:
 *
 *   1. the provider's own BOLD HEADING (OpenAI/Codex and Gemini summaries open each part with
 *      `**Heading**`) — `lastValidHeading`;
 *   2. otherwise an ACTIVITY title inferred from the prose by fixed rules — `ActivityTitleTracker`
 *      ("Let me read the files." → "Reading the files"). NO model call: deterministic, cheap, O(n);
 *   3. otherwise none (clients render "Thinking"/"Thought").
 *
 * Provider-agnostic: it runs on `summary` and `exposed` blocks alike (Grok and Claude summaries,
 * DeepSeek raw reasoning, …). The rule was measured on real reasoning from live runs; its fixture
 * (`test/projector/fixtures/thinking-titles.json`) is shared verbatim with the phone engine's Swift
 * port (`apple/WinterChatKit/Sources/WinterChatKit/ThinkingTitleRule.swift`) — change both together.
 *
 * ENGINE-INDEPENDENT BY CONSTRUCTION (review r1). Everything works on UTF-16 code units. Every text a
 * rule reads is first CLEANED (`cleanText`): whitespace — JS `\s` plus NEL — becomes single spaces,
 * control/zero-width/bidi units are dropped, curly apostrophes become `'`. Matching then runs on an
 * ASCII-only lower-cased copy (same length, so positions map back), with no case-insensitive flag, no
 * `\s`, no `\b` and no `.` outside a trailing `(.*)$` over line-free text — so V8 and ICU cannot
 * disagree on Unicode case folding (`ſ`, the Kelvin sign), on what is whitespace, or on what `.`
 * matches. Every pattern is linear: no quantified group holds an unbounded quantifier and no two
 * unbounded quantifiers can share a span (`test/projector/thinking-title.test.ts` audits each one and
 * fuzzes them against a time budget; the Swift tripwire does the same on its side).
 */

// ── shared text helpers ─────────────────────────────────────────────────────────────────────────

/** The first `n` UTF-16 units of `s`, never ending on half of a surrogate pair — a lone surrogate
 *  would survive `JSON.stringify` as an escape that strict decoders (Swift's) refuse. */
export function sliceUnits(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, Math.max(0, n));
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Whitespace for every rule here: JS `\s` (incl. line terminators and U+FEFF) plus NEL (U+0085). */
export function isSpaceUnit(u: number): boolean {
  return (u >= 0x09 && u <= 0x0d) || u === 0x20 || u === 0x85 || u === 0xa0 || u === 0x1680 || (u >= 0x2000 && u <= 0x200a)
    || u === 0x2028 || u === 0x2029 || u === 0x202f || u === 0x205f || u === 0x3000 || u === 0xfeff;
}

/** Units no title may carry: C0/C1 controls, DEL, zero-width and bidi controls. */
function isDroppedUnit(u: number): boolean {
  return u <= 0x1f || (u >= 0x7f && u <= 0x9f) || (u >= 0x200b && u <= 0x200f) || (u >= 0x202a && u <= 0x202e)
    || (u >= 0x2060 && u <= 0x2064) || (u >= 0x2066 && u <= 0x2069) || u === 0x061c;
}

/** Whitespace runs → one space (trimmed), controls/zero-width/bidi dropped, ‘’ → '. */
export function cleanText(s: string): string {
  let out = "";
  let space = false;
  for (let i = 0; i < s.length; i++) {
    const u = s.charCodeAt(i);
    if (isSpaceUnit(u)) { space = out.length > 0; continue; }
    if (isDroppedUnit(u)) continue;
    if (space) { out += " "; space = false; }
    out += u === 0x2018 || u === 0x2019 ? "'" : s[i];
  }
  return out;
}

/** Kept for the update title: the same cleaning. */
export const collapse = cleanText;

/** At most `THINKING_TITLE_MAX_LENGTH` characters, an ellipsis marking a cut. */
export function clipTitle(s: string): string {
  if (s.length <= THINKING_TITLE_MAX_LENGTH) return s;
  return `${sliceUnits(s, THINKING_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

/** A–Z → a–z, nothing else (same length: positions map back to the original). */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/** Han, kana and Hangul: a run of them is words without spaces. */
function isCjkCodePoint(cp: number): boolean {
  return (cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x20000 && cp <= 0x2ffff);
}

// ── 1. the provider's bold heading ──────────────────────────────────────────────────────────────

/** A `**…**` span that OPENS a line (after optional spaces/tabs): the first closing `**` at least one
 *  unit past the opening, and whatever follows it on that line. */
const LINE_HEADING = /^[ \t]*\*\*(.+?)\*\*(.*)$/gm;
/** Nothing but spaces/tabs after the closing `**`: a heading stands alone on its line. */
const BLANK_REST = /^[ \t]*$/;
/** A file-name-like token (`calc.js`, `Node.js`): a word character, a dot, a letter-led extension. */
const FILE_TOKEN = /[A-Za-z0-9_]\.[A-Za-z][A-Za-z0-9]{0,4}(?![A-Za-z0-9])/;
/** One path-or-file token and nothing else. */
const SINGLE_TOKEN = /^[A-Za-z0-9_./-]+$/;
const HEADING_MAX_WORDS = 10;

/** Whether a cleaned heading is a TITLE, not markdown structure. Raw reasoning (DeepSeek, also when
 *  served over the Anthropic dialect and labelled `summary`) bolds labels and file names —
 *  `**src/calc.js:**`, `**Lines per file (sorted by size):**`, `**src/format.js**`, `` **`calc.js`** `` —
 *  while a real heading may well NAME a file (`**Inspecting package.json scripts**`). */
/** One inline code span and nothing else (`` **`div`** ``). */
const SINGLE_CODE_SPAN = /^`[^`]+`$/;

function isTitleHeading(inner: string): boolean {
  if (inner.length === 0 || inner.endsWith(":")) return false;
  if (inner.split(" ").length > HEADING_MAX_WORDS) return false;
  if (SINGLE_CODE_SPAN.test(inner)) return false;
  const bare = inner.replace(/`/g, "");
  if (SINGLE_TOKEN.test(bare) && (bare.includes("/") || FILE_TOKEN.test(bare))) return false;
  return true;
}

/** A title and where it starts in its part (UTF-16 offset). */
export interface Placed { title: string; pos: number }

/** What a part's headings say about its title (offsets relative to the text scanned, plus `base`). */
export interface HeadingFacts {
  /** The last valid heading. */
  latest: Placed | undefined;
  /** The part's OPENING heading: its first non-blank line, a valid heading. */
  opening: Placed | undefined;
  /** Where the opening heading's body ends: the next heading-shaped line after it (valid or not). */
  protectEnd: number | undefined;
  /** Every counted heading-shaped line's offset, in order. */
  lines: number[];
}

/**
 * The headings of `text`. A heading line opens its line (after spaces/tabs), closes its `**` on it and
 * has nothing after; it counts once a line break has CLOSED its line — or, with `final`, at the end of
 * the text too (no more text can follow it on that line). `isTitleHeading` decides which are titles;
 * any heading-shaped line ends the opening heading's body. `base` is added to every offset.
 */
export function scanHeadings(text: string, final: boolean, base = 0): HeadingFacts {
  let latest: Placed | undefined;
  let opening: Placed | undefined;
  let protectEnd: number | undefined;
  const lines: number[] = [];
  let firstContent = 0;
  while (firstContent < text.length && isSpaceUnit(text.charCodeAt(firstContent))) firstContent += 1;
  const firstLineStart = text.lastIndexOf("\n", firstContent - 1) + 1;
  for (const m of text.matchAll(LINE_HEADING)) {
    if (!BLANK_REST.test(m[2] ?? "")) continue;
    if (!final && m.index + m[0].length >= text.length) continue;    // its line is still open
    lines.push(base + m.index);
    if (opening !== undefined && protectEnd === undefined) protectEnd = base + m.index;
    const inner = cleanText(m[1] ?? "");
    if (!isTitleHeading(inner)) continue;
    const placed = { title: clipTitle(inner), pos: base + m.index };
    latest = placed;
    if (m.index === firstLineStart && m.index <= firstContent) opening = placed;
  }
  return { latest, opening, protectEnd, lines };
}

/**
 * The LAST valid heading anywhere in `text`, cleaned and clipped — `undefined` when there is none.
 * A heading opens its line, closes on it with nothing after, and passes `isTitleHeading`; one still
 * missing its closing `**` does not count (the one before it still does), nor does a bold word
 * mid-line, a bold span followed by more text on its line (`**src/calc.js** (5 lines):`), a label
 * (`**Note:**`), a lone path/file name or a lone code span. `includeOpenLine: false` ignores a heading
 * on the last line while no line break has closed it yet (text may still follow it on that line).
 */
export function lastValidHeading(text: string, includeOpenLine = true): string | undefined {
  return scanHeadings(text, includeOpenLine).latest?.title;
}

/**
 * PRECEDENCE between a part's headings and its activity rule (review r2):
 *
 *  - a `summary` part that OPENS with a heading is provider-written (OpenAI, Gemini — each chunk opens
 *    with `**Heading**` and the prose under it is that heading's body): its latest heading wins;
 *  - otherwise (any `exposed` part, a raw-looking `summary` — DeepSeek served over the Anthropic
 *    dialect): an activity title beats every heading, EXCEPT an opening heading over the rule titles
 *    of its own body (up to the next heading-shaped line). Bold lines in raw reasoning are mostly
 *    answer drafts (`` **`div` is wrong** ``, `` **Riskiest: `div`** ``) — never the activity;
 *  - with no activity title, the latest heading.
 */
export function decideTitle(kind: "summary" | "exposed", h: HeadingFacts, rule: Placed | undefined): string | undefined {
  if (kind === "summary" && h.opening !== undefined) return h.latest?.title ?? rule?.title;
  if (rule !== undefined) {
    if (h.opening === undefined) return rule.title;
    if (h.protectEnd !== undefined && rule.pos >= h.protectEnd) return rule.title;
    return h.opening.title;
  }
  return h.latest?.title;
}

// ── 2. the activity rule ────────────────────────────────────────────────────────────────────────

/** A sentence longer than this is never read (a run-on sentence is a dump, not an activity); a
 *  candidate (a sentence or a clause of one) longer than `CANDIDATE_MAX` is skipped. */
const SEGMENT_MAX = 600;
const CANDIDATE_MAX = 220;
/** A title has at most this many words (the verb included), "…" marking a cut. A run of CJK
 *  characters counts one word per `CJK_CHARS_PER_WORD`. */
const TITLE_MAX_WORDS = 9;
const CJK_CHARS_PER_WORD = 4;
/** The head of a segment kept for classifying the line it opens (fence/list/heading/table). */
const SEGMENT_HEAD = 16;

const words = (...lists: string[]): ReadonlySet<string> => new Set(lists.join(" ").split(" ").filter((w) => w.length > 0));
const alt = (list: string): string => list.split(" ").filter((w) => w.length > 0).join("|");

/** Discourse words a candidate may open with ("Now", "So,", "OK, next"). */
const LEAD_WORDS = "now first firstly also quickly carefully actually just then next still again briefly finally lastly so ok okay alright right and but well anyway instead meanwhile second secondly third thirdly further simply really properly directly thoroughly wait hmm ah oh great good perfect fine sure yes yeah";
/** Adverbs between a modal and its verb ("Let me QUICKLY check"). */
const MID_WORDS = "now first also quickly carefully actually just then next still again briefly finally properly really simply directly thoroughly systematically further explicitly manually separately immediately quick";
/** Each lead word is followed by an optional comma and exactly one space (the text is cleaned, so a
 *  run of whitespace is one space): one way to match, so the group never backtracks into itself. */
const LEAD = `^(?:(?:${alt(LEAD_WORDS)})(?![a-z'])(?: ?,)? )*`;
const MID = `(?:(?:${alt(MID_WORDS)})(?![a-z']) )*`;
/** Phrases that announce what the writer does next. Longer alternatives first. */
const MODAL = [
  "let me", "let's", "let us",
  "i'll need to", "i will need to", "i'll have to", "i will have to", "i'll", "i will",
  "i'd like to", "i would like to", "i want to", "i need to", "i should", "i must", "i have to",
  "i'm going to", "i am going to", "i'm about to", "i am about to", "i'm ready to", "i am ready to",
  "i'm planning to", "i am planning to", "i plan to",
  "we need to", "we should", "we'll", "we will",
  "it's time to", "time to",
].join("|");
/** What may follow a word: a space, punctuation (ASCII or fullwidth), or the end. */
const END = "(?=[ ,.:;!?，。；：！？]|$)";
const PAST_STEPS = "checked double-checked counted ran reviewed examined inspected verified tested searched scanned explored gathered analyzed analysed compared traced read opened grepped listed located measured reran re-ran";

/** "Let me start by exploring …" — the gerund itself. */
const P_START_BY = new RegExp(`${LEAD}(?:${MODAL}) ${MID}(?:start|begin) (?:off )?by ([a-z]+ing)${END}(.*)$`);
/** "Let me read …", "I'll count …", "Now I need to check …" — a base verb, made a gerund. */
const P_MODAL = new RegExp(`${LEAD}(?:${MODAL}) ${MID}([a-z][a-z-]*)${END}(.*)$`);
/** "I'm exploring …", "I am now analyzing …". */
const P_IM = new RegExp(`${LEAD}i(?:'m| am) ${MID}([a-z]+ing)${END}(.*)$`);
/** "Found two bugs …", "I've identified the bugs …" — kept as written. */
const P_FOUND = new RegExp(`${LEAD}(?:i(?:'ve| have) (?:(?:just|now|also|already) )*)?(found|confirmed|identified|spotted)${END}(.*)$`);
/** A step the writer reports as done, in the first person: "I checked the git log." → "Checked the git
 *  log" (only these activity verbs: "I decided …", "I think …" are not steps). */
const P_PAST = new RegExp(`${LEAD}i(?:'ve| have)? (?:(?:just|now|also|already|quickly|carefully|first) )*(${alt(PAST_STEPS)})${END}(.*)$`);
/** "Scanning the project …", "Now checking pad …". */
const P_GERUND = new RegExp(`${LEAD}([a-z]+ing)${END}(.*)$`);

/** "go ahead and run" / "go through and read" / "try and fix" → the second verb. */
const GO_AND = new RegExp(`^ (?:(?:ahead|through|back|on) )?and ([a-z][a-z-]*)${END}(.*)$`);
/** "double check" → "Double-checking". */
const DOUBLE_CHECK = new RegExp(`^[ -]check${END}(.*)$`);
/** "Starting to analyze …" → "Analyzing …". */
const TO_VERB = new RegExp(`^ to ([a-z][a-z-]*)${END}(.*)$`);
/** "Verifying by checking X" → "Checking X": a bare verb whose object is a "by" clause. */
const BY_GERUND = new RegExp(`^ by ([a-z]+ing)${END}(.*)$`);

/** A base verb that is not a verb (or not an activity) after a modal: "I should NOT …", "Let me BE …". */
const STOP_VERBS = words("not never be been being have has had also probably maybe likely definitely certainly so the a an it this that there here just");
/** -ing words that are adjectives or nouns, never an activity's verb. */
const NOT_GERUNDS = words(
  "interesting existing missing remaining following corresponding surprising confusing amazing nothing something everything anything",
  "string strings during thing things king ring bring spring sing wing swing sting morning evening ceiling according including regarding",
  "concerning pending outstanding upcoming ongoing trailing leading underlying misleading promising boring willing ending being",
);
/** Gerunds that say nothing without an object. */
const GENERIC = words(
  "thinking analyzing analysing continuing proceeding starting working beginning going trying doing getting having looking seeing",
  "considering reconsidering reflecting pondering reasoning focusing moving waiting wondering deciding finishing finalizing",
);
/** Writing the ANSWER is not an activity worth a title ("Writing a concise final answer") — a verb
 *  from here AND an object word from `META_OBJECTS` (or none). */
const META_VERBS = words("writing giving presenting keeping answering providing composing responding replying formatting wrapping finalizing drafting putting outputting delivering sharing stating summarizing framing phrasing structuring crafting preparing leaving");
const META_OBJECTS = words(
  "answer answers response reply final concise concisely clear clearly tight short brief briefly bullet bullets sentence sentences",
  "prose summary report up it them this that output findings together list user message words paragraph paragraphs format plan",
  "recommendation conclusion verdict",
);
/** An object made only of these is no object ("Analyzing them", "Checking it", "Taking a look"). */
const PRONOUNISH = words(
  "it them this that these those things everything something anything more all both stuff again now here there further",
  "at into over through on for with about to up out in a an the bit little closer deeper look one",
);
/** A finite verb after a leading gerund makes the gerund a SUBJECT ("Reassigning the string works fine"). */
const FINITE = words(
  "is are was were will would can could should may might must does did has had isn't aren't wasn't weren't doesn't don't didn't",
  "won't wouldn't can't cannot couldn't shouldn't hasn't haven't works returns increases decreases means uses throws yields produces",
  "requires seems appears becomes breaks fails gives makes causes prevents ensures depends",
);
/** Where a finite-verb search stops: what follows is a subordinate clause ("Checking whether X is …"). */
const SUBORDINATORS = words("whether if that what which how why where when who whose to for because so since while as than until unless before after though although");
/** Trailing words dropped from a title ("Reading the source next" → "Reading the source"). */
const TRAILING_ADVERBS = words("now next first then again too also here directly quickly briefly carefully");
const TRAILING_DANGLING = words("the a an and or of to for with in on at by as from etc");
/** Trailing punctuation stripped from a title's last word. */
const TRAILING_PUNCTUATION = new Set([..."．.,;:!?…。，；：！？、"].map((c) => c.charCodeAt(0)));

/** Where a title's object is cut: purpose and reason clauses, coordinated next steps, punctuation. */
const PURPOSES = "identify see understand find confirm check figure determine get make know verify ensure learn decide catch spot locate gather compare validate inspect review map trace reproduce isolate avoid prevent count orient answer";
/** Verbs that, after "and", start the writer's NEXT step ("read X and check Y") — never words that are
 *  as often nouns ("source and test files", "plan and report"). */
const NEXT_VERBS = "check read run look lay write fix add verify confirm try give review examine inspect identify count find explore compare make keep summarize glance outline produce present provide propose suggest finalize mention explain describe grep focus dig figure determine think consider decide proceed continue begin maybe possibly am i";
const CUT_WORDS = [
  `to (?:${alt(PURPOSES)})(?![a-z])`,
  ...["in order to", "so that", "so", "because", "before", "after", "which", "since", "then", "and then", "and also", "while", "whereas", "though", "although", "but", "or if", "or whether"].map((w) => `${w}(?![a-z])`),
  `and (?:${alt(NEXT_VERBS)})(?![a-z])`,
  "by [a-z]+ing(?![a-z])",
  "that (?:might|could|would|may|will|can|should|is|are|was|were)(?![a-z])",
].join("|");
const CUT = new RegExp(` (?:${CUT_WORDS})| \\(| (?:-{1,3}|–) |—|[,;:!?，；：！？、]`, "g");
/** Where a sentence splits into later clauses, each its own candidate ("…, so I'll just read X"). */
const CLAUSE = /, (?=(?:so|and|then|but|now|next|i'll|i will|i'm|i am|i need|i should|i want|let me|let's)(?![a-z]))|; | ?— ?| – | -- |: /g;
/** A line that is structure, not prose: a list item, a markdown heading, a table row, a quote. Read
 *  on the line's cleaned head. */
const STRUCTURE_LINE = /^(?:[-*+•] |[0-9]{1,3}[.)](?: |$)|#{1,6}(?: |$)|\||>)/;
const FENCE_LINE = /^(?:```|~~~)/;

/** EVERY pattern this module compiles — the test suite audits each for nested or adjacent unbounded
 *  quantifiers and runs them against adversarial input on a time budget. */
export const TITLE_PATTERNS: readonly RegExp[] = [
  LINE_HEADING, BLANK_REST, FILE_TOKEN, SINGLE_TOKEN, P_START_BY, P_MODAL, P_IM, P_FOUND, P_PAST, P_GERUND,
  GO_AND, DOUBLE_CHECK, TO_VERB, BY_GERUND, CUT, CLAUSE, STRUCTURE_LINE, FENCE_LINE,
];

// ── gerunds ──

const IRREGULAR_GERUNDS: Readonly<Record<string, string>> = {
  be: "being", see: "seeing", flee: "fleeing", free: "freeing", agree: "agreeing", lie: "lying", die: "dying", tie: "tying",
  dye: "dyeing", eye: "eyeing", hoe: "hoeing", toe: "toeing", shoe: "shoeing", ski: "skiing", singe: "singeing",
  panic: "panicking", mimic: "mimicking", picnic: "picnicking", traffic: "trafficking", quit: "quitting", quiz: "quizzing",
};
/** Stressed-final multi-syllable verbs that double their last consonant. */
const DOUBLED_MULTI = words("begin commit submit admit omit permit refer prefer occur debug rerun forget control regret recur compel expel propel equip deter incur infer confer defer patrol unwrap unzip upset overlap reset recap remap rewrap outrun rebut transmit emit acquit");
/** Never doubled (unstressed final syllable) — listed for the record; they fail the one-syllable test anyway. */
const NEVER_DOUBLED = words("visit edit open listen limit target exit audit filter render answer consider develop order offer enter gather cover deliver remember happen travel cancel label model level");

const VOWELS = "aeiou";
function vowelGroups(v: string): number {
  let groups = 0;
  let inGroup = false;
  for (const ch of v) {
    const isVowel = VOWELS.includes(ch);
    if (isVowel && !inGroup) groups += 1;
    inGroup = isVowel;
  }
  return groups;
}

/** Whether a base verb doubles its final consonant before -ing (run → running, skip → skipping). */
function doublesFinal(v: string): boolean {
  if (NEVER_DOUBLED.has(v)) return false;
  if (DOUBLED_MULTI.has(v)) return true;
  if (v.length < 3 || vowelGroups(v) !== 1) return false;
  const [a, b, c] = [v[v.length - 3]!, v[v.length - 2]!, v[v.length - 1]!];
  return !VOWELS.includes(a) && VOWELS.includes(b) && !VOWELS.includes(c) && !"wxy".includes(c);
}

/** The -ing form of a base verb, lower case: drop a silent e, -ie → -ying, CVC doubling. A hyphenated
 *  verb takes the ending on its last part ("re-examine" → "re-examining", "double-check"). */
export function gerundOf(verb: string): string {
  const v = asciiLower(verb);
  const hyphen = v.lastIndexOf("-");
  if (hyphen > 0 && hyphen < v.length - 1) return v.slice(0, hyphen + 1) + gerundOf(v.slice(hyphen + 1));
  const irregular = IRREGULAR_GERUNDS[v];
  if (irregular !== undefined) return irregular;
  if (v.endsWith("ie")) return `${v.slice(0, -2)}ying`;
  if (v.endsWith("ee") || v.endsWith("ye") || v.endsWith("oe")) return `${v}ing`;
  if (v.endsWith("e") && v.length > 2) return `${v.slice(0, -1)}ing`;
  if (doublesFinal(v)) return `${v}${v[v.length - 1]}ing`;
  return `${v}ing`;
}

// ── shortening ──

/** For each position: whether it lies inside inline code or parentheses/brackets (a cut never lands
 *  there: "pow(a,b)", "`find . -type f`"). */
function protectedMask(s: string): boolean[] {
  const mask = new Array<boolean>(s.length);
  let code = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "`") code = !code;
    else if (!code && (c === "(" || c === "[")) depth += 1;
    else if (!code && (c === ")" || c === "]") && depth > 0) depth -= 1;
    mask[i] = code || depth > 0;
  }
  return mask;
}

/** Space-separated words of CLEANED text, a code span or bracket group staying inside its word. */
function tokens(s: string): string[] {
  const mask = protectedMask(s);
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (!mask[i] && c === " ") {
      if (cur.length > 0) out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** A word's letters, ASCII lower case, for list lookups ("`Pad`," → "pad", "isn't" stays). */
const bare = (w: string): string => asciiLower(w).replace(/[^a-z'-]/g, "");

/** How many words a token weighs: 1, or one per `CJK_CHARS_PER_WORD` CJK characters. */
function cjkCount(w: string): number {
  let n = 0;
  for (const ch of w) if (isCjkCodePoint(ch.codePointAt(0)!)) n += 1;
  return n;
}
const weightOf = (w: string): number => Math.max(1, Math.ceil(cjkCount(w) / CJK_CHARS_PER_WORD));

/** The head of a token holding at most `n` CJK characters. */
function cjkPrefix(w: string, n: number): string {
  let out = "";
  let seen = 0;
  for (const ch of w) {
    if (isCjkCodePoint(ch.codePointAt(0)!)) {
      if (seen === n) break;
      seen += 1;
    }
    out += ch;
  }
  return out;
}

function stripTrailingPunctuation(w: string): string {
  let end = w.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(w.charCodeAt(end - 1))) end -= 1;
  return w.slice(0, end);
}

function trimTail(list: string[]): string[] {
  const out = [...list];
  for (;;) {
    const last = out[out.length - 1];
    if (last === undefined) return out;
    const stripped = stripTrailingPunctuation(last);
    if (stripped.length === 0) { out.pop(); continue; }
    if (stripped !== last) { out[out.length - 1] = stripped; continue; }
    const b = bare(last);
    if (TRAILING_ADVERBS.has(b) || TRAILING_DANGLING.has(b)) { out.pop(); continue; }
    return out;
  }
}

/** The title's object: `rest` cut at its first purpose/reason clause or punctuation (never inside code
 *  or brackets), trailing adverbs and dangling words dropped, at most `TITLE_MAX_WORDS - 1` words. */
function shortenObject(rest: string): string {
  const mask = protectedMask(rest);
  let end = rest.length;
  for (const m of asciiLower(rest).matchAll(CUT)) {
    if (!mask[m.index]) { end = m.index; break; }
  }
  const list = trimTail(tokens(rest.slice(0, end)));
  let budget = TITLE_MAX_WORDS - 1;
  const kept: string[] = [];
  for (const w of list) {
    const weight = weightOf(w);
    if (weight <= budget) { kept.push(w); budget -= weight; continue; }
    if (budget > 0 && cjkCount(w) > 0) kept.push(cjkPrefix(w, budget * CJK_CHARS_PER_WORD));
    const cut = trimTail(kept);
    return cut.length === 0 ? "" : `${cut.join(" ")}…`;
  }
  return kept.join(" ");
}

/** A leading gerund is the sentence's SUBJECT when a finite verb follows it before any subordinate
 *  clause ("Adding spaces always increases string length"), or when two do (a subordinate clause has
 *  one, the main clause the other: "Dividing by zero when the array is empty also produces NaN").
 *  Read up to the first punctuation. */
function isStatement(rest: string): boolean {
  const clause = rest.split(/[,;:—–(]/, 1)[0] ?? "";
  let finite = 0;
  let subordinate = false;
  for (const w of tokens(clause)) {
    const b = bare(w);
    if (SUBORDINATORS.has(b)) subordinate = true;
    else if (FINITE.has(b)) {
      finite += 1;
      if (!subordinate || finite >= 2) return true;
    }
  }
  return false;
}

const countOf = (s: string, sub: string): number => s.split(sub).length - 1;

/** A rule title and whether it is WEAK (a bare verb: it never replaces a title with an object). */
interface RuleTitle { title: string; weak: boolean }

type Shape = "converted" | "gerund" | "found";

/** Runs an anchored pattern ending in `(.*)$` on the lower-cased copy of `s`: its first group (lower
 *  case) and the REST in its original casing (the last group is a suffix of `s`). */
function execTail(re: RegExp, s: string, lower = asciiLower(s)): { word: string; rest: string } | undefined {
  const m = re.exec(lower);
  if (m === null) return undefined;
  const tail = m[m.length - 1] ?? "";
  return { word: m.length > 2 ? (m[1] ?? "") : "", rest: s.slice(s.length - tail.length) };
}

/** The title for a verb (already a gerund, or "Found"-like) and the rest of its candidate. */
function build(verbIng: string, rest: string, shape: Shape): RuleTitle | undefined {
  let verb = asciiLower(verbIng);
  let tail = rest;
  if (shape !== "found") {
    if (NOT_GERUNDS.has(verb)) return undefined;
    if (shape === "gerund" && isStatement(tail)) return undefined;
    // "Starting to analyze X" → "Analyzing X".
    if (verb === "starting" || verb === "beginning" || verb === "continuing") {
      const m = execTail(TO_VERB, tail);
      if (m !== undefined && !STOP_VERBS.has(m.word)) { verb = gerundOf(m.word); tail = m.rest; }
    }
    // "Verifying by checking X" → "Checking X".
    const by = execTail(BY_GERUND, tail);
    if (by !== undefined && !NOT_GERUNDS.has(by.word)) { verb = by.word; tail = by.rest; }
  }
  const object = shortenObject(tail);
  if (countOf(object, "`") % 2 !== 0) return undefined;           // a cut inside inline code
  const objectWords = tokens(object).map(bare).filter((w) => w.length > 0);
  const hasCjk = cjkCount(object) > 0;
  if (META_VERBS.has(verb) && ((objectWords.length === 0 && !hasCjk) || objectWords.some((w) => META_OBJECTS.has(w)))) return undefined;
  let weak = false;
  if (objectWords.length === 0 && !hasCjk) {
    if (shape === "found" || GENERIC.has(verb)) return undefined;
    weak = true;
  } else if (!hasCjk && objectWords.every((w) => PRONOUNISH.has(w))) {
    return undefined;
  }
  const head = verb.charAt(0).toUpperCase() + verb.slice(1);
  return { title: clipTitle(object.length > 0 ? `${head} ${object}` : head), weak };
}

/** One cleaned candidate (a sentence, or a clause of one) → a title, or `undefined`. */
function matchCandidate(c: string): RuleTitle | undefined {
  const low = asciiLower(c);
  let m = execTail(P_START_BY, c, low);
  if (m !== undefined) return build(m.word, m.rest, "gerund");
  m = execTail(P_MODAL, c, low);
  if (m !== undefined) {
    let verb = m.word;
    let rest = m.rest;
    if (STOP_VERBS.has(verb)) return undefined;
    if (verb === "go" || verb === "try" || verb === "come") {
      const g = execTail(GO_AND, rest);
      if (g !== undefined) { verb = g.word; rest = g.rest; }
      if (STOP_VERBS.has(verb)) return undefined;
    }
    if (verb === "double") {
      const d = execTail(DOUBLE_CHECK, rest);
      if (d !== undefined) return build("double-checking", d.rest, "converted");
    }
    return build(gerundOf(verb), rest, "converted");
  }
  m = execTail(P_IM, c, low);
  if (m !== undefined) return build(m.word, m.rest, "converted");
  m = execTail(P_FOUND, c, low) ?? execTail(P_PAST, c, low);
  if (m !== undefined) return build(m.word, m.rest, "found");
  m = execTail(P_GERUND, c, low);
  if (m !== undefined) return build(m.word, m.rest, "gerund");
  return undefined;
}

/** At most this many clauses of one sentence are read (the latest ones), besides the sentence itself —
 *  a sentence of sixty ", so"s is noise, and each candidate costs a few regex runs. */
const MAX_CLAUSES = 8;

/** A complete sentence → the title of its LATEST matching candidate (the sentence itself, then the
 *  latest `MAX_CLAUSES` clauses that open after `CLAUSE`), or `undefined`. */
function evaluateSentence(segment: string): RuleTitle | undefined {
  if (countOf(segment, "**") % 2 !== 0) return undefined;        // half a bold span (a heading cut by a line break)
  const s = cleanText(segment.replace(/\*\*/g, ""));
  if (s.length === 0) return undefined;
  const mask = protectedMask(s);
  const clauses: number[] = [];
  for (const m of asciiLower(s).matchAll(CLAUSE)) if (!mask[m.index]) clauses.push(m.index + m[0].length);
  const starts = [0, ...clauses.slice(-MAX_CLAUSES)];
  for (let i = starts.length - 1; i >= 0; i--) {
    const c = s.slice(starts[i]).trim();
    if (c.length === 0 || c.length > CANDIDATE_MAX || c.startsWith("`")) continue;
    const r = matchCandidate(c);
    if (r !== undefined) return r;
  }
  return undefined;
}

const isLineBreak = (u: number): boolean => u === 0x0a || u === 0x0d || u === 0x2028 || u === 0x2029;
/** `.` `!` `?` end a sentence when whitespace follows; the fullwidth `。！？；` end one by themselves. */
const isAsciiSentenceEnd = (u: number): boolean => u === 0x2e || u === 0x21 || u === 0x3f;
const isCjkSentenceEnd = (u: number): boolean => u === 0x3002 || u === 0xff01 || u === 0xff1f || u === 0xff1b;

/** The head of a line, cleaned for classification. */
const lineHead = (head: string): string => cleanText(head);

/**
 * The activity rule over a stream of text, INCREMENTAL: every pushed unit is looked at once, and only
 * a sentence that has just COMPLETED is evaluated — so a block of any length costs O(n) in total.
 *
 * Sentences end at a line break, at `.`/`!`/`?` followed by whitespace (never inside inline code), or
 * right after a fullwidth `。！？；`. While the text streams only COMPLETE sentences count
 * (`placed(false)`, review r2: a title read off text still to come could be refuted by what follows
 * and would then stick on screen); at the block's end (`placed(true)`) the trailing sentence counts
 * whatever it ends with. Each title carries its sentence's start offset (`pos`) for the precedence
 * against headings (`decideTitle`).
 *
 * Skipped: fenced code, list items, markdown headings, table rows and quotes (a whole line), and any
 * sentence over `SEGMENT_MAX`. The LATEST match wins — except that a WEAK one (a bare verb) never
 * replaces a title with an object.
 *
 * `activityTitleOf(text, final)` is this tracker fed the whole text, so the streamed and the whole-text
 * answers are the same by construction.
 */
export class ActivityTitleTracker {
  private seg = "";
  private segHead = "";
  private segOverlong = false;
  private segAtLineStart = true;
  /** An odd number of backticks so far: inside inline code, where ". " ends no sentence. */
  private segInCode = false;
  /** The offset of the current segment's first unit. */
  private segStart = 0;
  /** Units pushed so far. */
  private total = 0;
  /** The rest of the current line is structure (a list item, a heading, a table row). */
  private lineSkip = false;
  private inFence = false;
  private prev = 0;
  private committed: PlacedRule | undefined;

  push(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const u = text.charCodeAt(i);
      if (isLineBreak(u)) {
        this.endSegment();
        this.segAtLineStart = true;
        this.lineSkip = false;
      } else if (isAsciiSentenceEnd(this.prev) && !this.segInCode && isSpaceUnit(u)) {
        this.endSegment();
        this.segAtLineStart = false;
      } else {
        this.append(text[i]!, u);
        if (isCjkSentenceEnd(u) && !this.segInCode) {
          this.endSegment();
          this.segAtLineStart = false;
        }
      }
      this.prev = u;
      this.total += 1;
    }
  }

  private append(c: string, u: number): void {
    if (this.segHead.length === 0) this.segStart = this.total;
    if (u === 0x60) this.segInCode = !this.segInCode;
    if (this.segHead.length < SEGMENT_HEAD) this.segHead += c;
    if (!this.segOverlong) {
      if (this.seg.length >= SEGMENT_MAX) { this.segOverlong = true; this.seg = ""; } else this.seg += c;
    }
  }

  /** The latest match among COMPLETE sentences, with its offset; with `final`, the trailing sentence
   *  counts too (the text has ended). */
  placed(final: boolean): Placed | undefined {
    let best = this.committed;
    if (final && !this.segOverlong && this.seg.length > 0 && this.readable(false)) {
      best = prefer(best, placeRule(evaluateSentence(this.seg), this.segStart));
    }
    return best === undefined ? undefined : { title: best.title, pos: best.pos };
  }

  /** `placed(final)`'s title. */
  title(final: boolean): string | undefined {
    return this.placed(final)?.title;
  }

  /** Whether the current segment is prose to read; with `commit`, a fence line toggles the fence and a
   *  structure line skips the rest of its line. */
  private readable(commit: boolean): boolean {
    if (this.segAtLineStart) {
      const head = lineHead(this.segHead);
      if (FENCE_LINE.test(head)) {
        if (commit) { this.inFence = !this.inFence; this.lineSkip = true; }
        return false;
      }
      if (this.inFence) return false;
      if (STRUCTURE_LINE.test(head)) {
        if (commit) this.lineSkip = true;
        return false;
      }
      return true;
    }
    return !this.inFence && !this.lineSkip;
  }

  private endSegment(): void {
    const text = this.seg;
    const overlong = this.segOverlong;
    const empty = !overlong && isBlank(text);
    const readable = empty ? !this.inFence : this.readable(true);
    if (readable && !overlong && !empty) this.committed = prefer(this.committed, placeRule(evaluateSentence(text), this.segStart));
    this.seg = "";
    this.segHead = "";
    this.segOverlong = false;
    this.segInCode = false;
  }
}

interface PlacedRule extends RuleTitle { pos: number }
const placeRule = (r: RuleTitle | undefined, pos: number): PlacedRule | undefined => (r === undefined ? undefined : { ...r, pos });

function isBlank(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (!isSpaceUnit(s.charCodeAt(i))) return false;
  return true;
}

/** The later of two matches, unless the later one is weak and the earlier one is not. */
function prefer<T extends RuleTitle>(earlier: T | undefined, later: T | undefined): T | undefined {
  if (later === undefined) return earlier;
  if (earlier !== undefined && later.weak && !earlier.weak) return earlier;
  return later;
}

/** PURE: the activity title of a whole text (see `ActivityTitleTracker`). */
export function activityTitleOf(text: string, final: boolean): string | undefined {
  const t = new ActivityTitleTracker();
  t.push(text);
  return t.title(final);
}
