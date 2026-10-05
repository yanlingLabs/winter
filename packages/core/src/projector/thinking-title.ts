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
 * Everything here works on UTF-16 code units and ASCII regexes (no `\b`, whose ICU meaning differs),
 * so the Swift port can match it unit for unit.
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

/** Whitespace collapsed to single spaces, trimmed. */
export const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/** At most `THINKING_TITLE_MAX_LENGTH` characters, an ellipsis marking a cut. */
export function clipTitle(s: string): string {
  if (s.length <= THINKING_TITLE_MAX_LENGTH) return s;
  return `${sliceUnits(s, THINKING_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

// ── 1. the provider's bold heading ──────────────────────────────────────────────────────────────

/** A `**…**` span that OPENS a line (after optional spaces/tabs): the first closing `**` at least one
 *  unit past the opening, and whatever follows it on that line. */
const LINE_HEADING = /^[ \t]*\*\*(.+?)\*\*(.*)$/gm;
/** Nothing but spaces/tabs after the closing `**`: a heading stands alone on its line (the end of the
 *  text counts — a heading whose line has not ended yet is already one). */
const BLANK_REST = /^[ \t]*$/;
/** A file-name-like token (`calc.js`, `Node.js`, `e.g`): a word character, a dot, a letter-led
 *  extension of at most 5. */
const FILE_TOKEN = /[A-Za-z0-9_]\.[A-Za-z][A-Za-z0-9]{0,4}(?![A-Za-z0-9])/;
/** At most this many words. */
const HEADING_MAX_WORDS = 10;

/** Whether a collapsed heading is a TITLE, not markdown structure: raw reasoning (DeepSeek, also when
 *  served over the Anthropic dialect and labelled `summary`) bolds file names and labels —
 *  `**src/calc.js:**`, `**test/calc.test.js:**`, `**Lines per file (sorted by size):**`. */
function isTitleHeading(inner: string): boolean {
  if (inner.length === 0 || inner.endsWith(":")) return false;
  if (inner.includes("/") || inner.includes("`") || FILE_TOKEN.test(inner)) return false;
  return inner.split(" ").length <= HEADING_MAX_WORDS;
}

/**
 * The LAST valid heading anywhere in `text`, collapsed and clipped — `undefined` when there is none.
 * A heading opens its line, closes on it with nothing after, and passes `isTitleHeading`; one still
 * missing its closing `**` does not count (the one before it still does), nor does a bold word
 * mid-line, nor a bold span followed by more text on its line (`**src/calc.js** (5 lines):`).
 */
export function lastValidHeading(text: string): string | undefined {
  let found: string | undefined;
  for (const m of text.matchAll(LINE_HEADING)) {
    if (!BLANK_REST.test(m[2] ?? "")) continue;
    const inner = collapse(m[1] ?? "");
    if (isTitleHeading(inner)) found = inner;
  }
  return found === undefined ? undefined : clipTitle(found);
}

// ── 2. the activity rule ────────────────────────────────────────────────────────────────────────

/** A sentence longer than this is never read (a run-on sentence is a dump, not an activity); a
 *  candidate (a sentence or a clause of one) longer than `CANDIDATE_MAX` is skipped. */
const SEGMENT_MAX = 600;
const CANDIDATE_MAX = 220;
/** A title has at most this many words (the verb included), "…" marking a cut. */
const TITLE_MAX_WORDS = 9;
/** The head of a segment kept for classifying the line it opens (fence/list/heading/table). */
const SEGMENT_HEAD = 16;

const words = (...lists: string[]): ReadonlySet<string> => new Set(lists.join(" ").split(/\s+/).filter((w) => w.length > 0));

/** Discourse words a candidate may open with ("Now", "So,", "OK, next"). */
const LEAD_WORDS = "now first firstly also quickly carefully actually just then next still again briefly finally lastly so ok okay alright right and but well anyway instead meanwhile second secondly third thirdly further simply really properly directly thoroughly wait hmm ah oh great good perfect fine sure yes yeah";
/** Adverbs between a modal and its verb ("Let me QUICKLY check"). */
const MID_WORDS = "now first also quickly carefully actually just then next still again briefly finally properly really simply directly thoroughly systematically further explicitly manually separately immediately quick";
const alt = (list: string): string => list.split(/\s+/).filter((w) => w.length > 0).join("|");
const LEAD = String.raw`^(?:(?:${alt(LEAD_WORDS)})(?![A-Za-z'])\s*,?\s+)*`;
const MID = String.raw`(?:(?:${alt(MID_WORDS)})(?![A-Za-z'])\s+)*`;
/** Phrases that announce what the writer does next. Longer alternatives first. */
const MODAL = [
  "let me", "let's", "let us",
  "i'll need to", "i will need to", "i'll have to", "i will have to", "i'll", "i will",
  "i'd like to", "i would like to", "i want to", "i need to", "i should", "i must", "i have to",
  "i'm going to", "i am going to", "i'm about to", "i am about to", "i'm ready to", "i am ready to",
  "i'm planning to", "i am planning to", "i plan to",
  "we need to", "we should", "we'll", "we will",
  "it's time to", "time to",
].map((m) => m.replace(/ /g, "\\s+")).join("|");
const STOP = String.raw`(?=[\s,.:;!?]|$)`;

/** "Let me start by exploring …" — the gerund itself. */
const P_START_BY = new RegExp(String.raw`${LEAD}(?:${MODAL})\s+${MID}(?:start|begin)\s+(?:off\s+)?by\s+([a-z]+ing)${STOP}(.*)$`, "i");
/** "Let me read …", "I'll count …", "Now I need to check …" — a base verb, made a gerund. */
const P_MODAL = new RegExp(String.raw`${LEAD}(?:${MODAL})\s+${MID}([a-z][a-z-]*)${STOP}(.*)$`, "i");
/** "I'm exploring …", "I am now analyzing …". */
const P_IM = new RegExp(String.raw`${LEAD}i(?:'m|\s+am)\s+${MID}([a-z]+ing)${STOP}(.*)$`, "i");
/** "Found two bugs …", "I've identified the bugs …" — kept as written. */
const P_FOUND = new RegExp(String.raw`${LEAD}(?:i(?:'ve|\s+have)\s+(?:(?:just|now|also|already)\s+)*)?(found|confirmed|identified|spotted)${STOP}(.*)$`, "i");
/** A step the writer reports as done, in the first person: "I checked the git log." → "Checked the git
 *  log" (only these activity verbs: "I decided …", "I think …" are not steps). */
const PAST_STEPS = "checked double-checked counted ran reviewed examined inspected verified tested searched scanned explored gathered analyzed analysed compared traced read opened grepped listed located measured reran re-ran";
const P_PAST = new RegExp(String.raw`${LEAD}i(?:'ve|\s+have)?\s+(?:(?:just|now|also|already|quickly|carefully|first)\s+)*(${alt(PAST_STEPS)})${STOP}(.*)$`, "i");
/** "Scanning the project …", "Now checking pad …". */
const P_GERUND = new RegExp(String.raw`${LEAD}([a-z]+ing)${STOP}(.*)$`, "i");

/** "go ahead and run" / "go through and read" / "try and fix" → the second verb. */
const GO_AND = /^\s+(?:(?:ahead|through|back|on)\s+)?and\s+([a-z][a-z-]*)(?=[\s,.:;!?]|$)(.*)$/i;
/** "double check" → "Double-checking". */
const DOUBLE_CHECK = /^[\s-]+check(?=[\s,.:;!?]|$)(.*)$/i;
/** "Starting to analyze …" → "Analyzing …". */
const TO_VERB = /^\s+to\s+([a-z][a-z-]*)(?=[\s,.:;!?]|$)(.*)$/i;

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

/** Where a title's object is cut: purpose and reason clauses, coordinated next steps, punctuation. */
const PURPOSES = "identify see understand find confirm check figure determine get make know verify ensure learn decide catch spot locate gather compare validate inspect review map trace reproduce isolate avoid prevent count orient answer";
/** Verbs that, after "and", start the writer's NEXT step ("read X and check Y") — never words that are
 *  as often nouns ("source and test files", "plan and report"). */
const NEXT_VERBS = "check read run look lay write fix add verify confirm try give review examine inspect identify count find explore compare make keep summarize glance outline produce present provide propose suggest finalize mention explain describe grep focus dig figure determine think consider decide proceed continue begin maybe possibly am i";
const W = (w: string): string => `${w.replace(/ /g, "\\s+")}(?![A-Za-z])`;
const CUT_WORDS = [
  `to\\s+(?:${alt(PURPOSES)})(?![A-Za-z])`,
  ...["in order to", "so that", "so", "because", "before", "after", "which", "since", "then", "and then", "and also", "while", "whereas", "though", "although", "but", "or if", "or whether"].map(W),
  `and\\s+(?:${alt(NEXT_VERBS)})(?![A-Za-z])`,
  "by\\s+[a-z]+ing(?![A-Za-z])",
  "that\\s+(?:might|could|would|may|will|can|should|is|are|was|were)(?![A-Za-z])",
].join("|");
const CUT = new RegExp(String.raw`\s+(?:${CUT_WORDS})|\s+\(|\s+[-–]+\s|\s*—|[,;:!?]`, "gi");
/** Where a sentence splits into later clauses, each its own candidate ("…, so I'll just read X"). */
const CLAUSE = /,\s+(?=(?:so|and|then|but|now|next|i'll|i will|i'm|i am|i need|i should|i want|let me|let's)(?![A-Za-z]))|;\s+|\s*—\s*|\s+–\s+|\s+--\s+|:\s+/gi;
/** "Verifying by checking X" → "Checking X": a bare verb whose object is a "by" clause. */
const BY_GERUND = /^\s+by\s+([a-z]+ing)(?=[\s,.:;!?]|$)(.*)$/i;
/** A line that is structure, not prose: a list item, a markdown heading, a table row, a quote. */
const STRUCTURE_LINE = /^(?:[-*+•]\s|\d{1,3}[.)](?:\s|$)|#{1,6}(?:\s|$)|\||>)/;
const FENCE_LINE = /^(?:```|~~~)/;

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
  const v = verb.toLowerCase();
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

/** Whitespace-separated words, a code span or bracket group staying inside its word. */
function tokens(s: string): string[] {
  const mask = protectedMask(s);
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (!mask[i] && c !== "`" && /\s/.test(c)) {
      if (cur.length > 0) out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** A word's letters, lower case, for list lookups ("`pad`," → "pad", "isn't" stays). */
const bare = (w: string): string => w.toLowerCase().replace(/[^a-z'-]/g, "");

function trimTail(list: string[]): string[] {
  const out = [...list];
  for (;;) {
    const last = out[out.length - 1];
    if (last === undefined) return out;
    const stripped = last.replace(/[.,;:!?…]+$/, "");
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
  for (const m of rest.matchAll(CUT)) {
    if (!mask[m.index]) { end = m.index; break; }
  }
  let list = trimTail(tokens(rest.slice(0, end)));
  if (list.length > TITLE_MAX_WORDS - 1) {
    list = trimTail(list.slice(0, TITLE_MAX_WORDS - 1));
    if (list.length === 0) return "";
    return `${list.join(" ")}…`;
  }
  return list.join(" ");
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

/** The title for a verb (already a gerund, or "Found"-like) and the rest of its candidate. */
function build(verbIng: string, rest: string, shape: Shape): RuleTitle | undefined {
  let verb = verbIng.toLowerCase();
  let tail = rest;
  if (shape !== "found") {
    if (NOT_GERUNDS.has(verb)) return undefined;
    if (shape === "gerund" && isStatement(tail)) return undefined;
    // "Starting to analyze X" → "Analyzing X".
    if (verb === "starting" || verb === "beginning" || verb === "continuing") {
      const m = TO_VERB.exec(tail);
      if (m !== null && !STOP_VERBS.has(m[1]!.toLowerCase())) { verb = gerundOf(m[1]!); tail = m[2] ?? ""; }
    }
    // "Verifying by checking X" → "Checking X".
    const by = BY_GERUND.exec(tail);
    if (by !== null && !NOT_GERUNDS.has(by[1]!.toLowerCase())) { verb = by[1]!.toLowerCase(); tail = by[2] ?? ""; }
  }
  const object = shortenObject(tail);
  if (countOf(object, "`") % 2 !== 0) return undefined;           // a cut inside inline code
  const objectWords = tokens(object).map(bare).filter((w) => w.length > 0);
  if (META_VERBS.has(verb) && (objectWords.length === 0 || objectWords.some((w) => META_OBJECTS.has(w)))) return undefined;
  let weak = false;
  if (objectWords.length === 0) {
    if (shape === "found" || GENERIC.has(verb)) return undefined;
    weak = true;
  } else if (objectWords.every((w) => PRONOUNISH.has(w))) {
    return undefined;
  }
  const head = verb.charAt(0).toUpperCase() + verb.slice(1);
  return { title: clipTitle(object.length > 0 ? `${head} ${object}` : head), weak };
}

/** One candidate (a sentence, or a clause of one) → a title, or `undefined`. */
function matchCandidate(c: string): RuleTitle | undefined {
  let m = P_START_BY.exec(c);
  if (m !== null) return build(m[1]!, m[2] ?? "", "gerund");
  m = P_MODAL.exec(c);
  if (m !== null) {
    let verb = m[1]!.toLowerCase();
    let rest = m[2] ?? "";
    if (STOP_VERBS.has(verb)) return undefined;
    if (verb === "go" || verb === "try" || verb === "come") {
      const g = GO_AND.exec(rest);
      if (g !== null) { verb = g[1]!.toLowerCase(); rest = g[2] ?? ""; }
      if (STOP_VERBS.has(verb)) return undefined;
    }
    if (verb === "double") {
      const d = DOUBLE_CHECK.exec(rest);
      if (d !== null) return build("double-checking", d[1] ?? "", "converted");
    }
    return build(gerundOf(verb), rest, "converted");
  }
  m = P_IM.exec(c);
  if (m !== null) return build(m[1]!, m[2] ?? "", "converted");
  m = P_FOUND.exec(c) ?? P_PAST.exec(c);
  if (m !== null) return build(m[1]!, m[2] ?? "", "found");
  m = P_GERUND.exec(c);
  if (m !== null) return build(m[1]!, m[2] ?? "", "gerund");
  return undefined;
}

/** A complete sentence → the title of its LATEST matching candidate (the sentence itself, then every
 *  clause that opens after `CLAUSE`), or `undefined`. */
function evaluateSentence(segment: string): RuleTitle | undefined {
  let s = segment.replace(/[‘’]/g, "'").trim();
  if (s.length === 0) return undefined;
  if (countOf(s, "**") % 2 !== 0) return undefined;             // half a bold span (a heading cut by a line break)
  s = s.replace(/\*\*/g, "");
  const mask = protectedMask(s);
  const starts = [0];
  for (const m of s.matchAll(CLAUSE)) if (!mask[m.index]) starts.push(m.index + m[0].length);
  for (let i = starts.length - 1; i >= 0; i--) {
    const c = s.slice(starts[i]).trim();
    if (c.length === 0 || c.length > CANDIDATE_MAX || c.startsWith("`")) continue;
    const r = matchCandidate(c);
    if (r !== undefined) return r;
  }
  return undefined;
}

const isLineBreak = (c: string): boolean => c === "\n" || c === "\r" || c === " " || c === " ";
const isSentenceEnd = (c: string): boolean => c === "." || c === "!" || c === "?";

/**
 * The activity rule over a stream of text, INCREMENTAL: every pushed unit is looked at once, and only
 * a sentence that has just COMPLETED is evaluated — so a block of any length costs O(n) in total.
 *
 * Sentences end at a line break, or at `.`/`!`/`?` followed by whitespace. While the block streams,
 * only complete sentences count — plus the trailing one if it already ends with `.`/`!`/`?` (a
 * one-sentence summary gets its title live, not only at the block's end). At the block's end
 * (`title(true)`) the trailing sentence counts whatever it ends with.
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
  /** The rest of the current line is structure (a list item, a heading, a table row). */
  private lineSkip = false;
  private inFence = false;
  private prev = "";
  private committed: RuleTitle | undefined;

  push(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!;
      if (isLineBreak(c)) {
        this.endSegment();
        this.segAtLineStart = true;
        this.lineSkip = false;
      } else if (isSentenceEnd(this.prev) && !this.segInCode && /\s/.test(c)) {
        this.endSegment();
        this.segAtLineStart = false;
      } else {
        if (c === "`") this.segInCode = !this.segInCode;
        if (this.segHead.length < SEGMENT_HEAD) this.segHead += c;
        if (!this.segOverlong) {
          if (this.seg.length >= SEGMENT_MAX) { this.segOverlong = true; this.seg = ""; } else this.seg += c;
        }
      }
      this.prev = c;
    }
  }

  /** The current title: the latest committed match, or the trailing sentence's when it counts. */
  title(final: boolean): string | undefined {
    let best = this.committed;
    const tail = this.seg;
    if (!this.segOverlong && tail.length > 0 && (final || isSentenceEnd(tail.trimEnd().slice(-1))) && this.readable(false)) {
      best = prefer(best, evaluateSentence(tail));
    }
    return best?.title;
  }

  /** Whether the current segment is prose to read; with `commit`, a fence line toggles the fence and a
   *  structure line skips the rest of its line. */
  private readable(commit: boolean): boolean {
    if (this.segAtLineStart) {
      const head = this.segHead.trimStart();
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
    const empty = !overlong && text.trim().length === 0;
    const readable = empty ? !this.inFence : this.readable(true);
    if (readable && !overlong && !empty) this.committed = prefer(this.committed, evaluateSentence(text));
    this.seg = "";
    this.segHead = "";
    this.segOverlong = false;
    this.segInCode = false;
  }
}

/** The later of two matches, unless the later one is weak and the earlier one is not. */
function prefer(earlier: RuleTitle | undefined, later: RuleTitle | undefined): RuleTitle | undefined {
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
