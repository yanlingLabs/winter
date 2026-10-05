// The thinking pill's title rule (user ruling 2026-10-05): the provider's own bold heading first, else
// an ACTIVITY title inferred from the prose by fixed rules (no model call), else none. Pinned on REAL
// reasoning from live runs (`fixtures/thinking-titles.json`, shared with the phone engine's Swift port)
// and on unit cases for every rule and filter.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingKind } from "@yanlinglabs/winter-protocol";
import { ThinkingBlocks, deriveThinkingTitle, gerundOf, type ReasoningProgressFrame } from "../../src/projector/thinking";
import { ActivityTitleTracker, TITLE_PATTERNS, activityTitleOf, lastValidHeading } from "../../src/projector/thinking-title";

interface FixtureBlock { id: string; model: string; kind: ThinkingKind; note?: string; title: string | null; text: string }
const fixture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "thinking-titles.json"), "utf8")) as { blocks: FixtureBlock[] };

const final = (text: string): string | undefined => activityTitleOf(text, true);
const live = (text: string): string | undefined => activityTitleOf(text, false);

/** Streams `text` through a fresh `ThinkingBlocks` in `size`-unit deltas: every delta's title, and the
 *  persisted block's. */
function stream(kind: ThinkingKind, text: string, size: number): { live: Array<string | undefined>; block: string | undefined } {
  const blocks = new ThinkingBlocks("s_test", () => 0);
  const frame = (phase: "start" | "delta" | "end", extra: Partial<ReasoningProgressFrame> = {}): ReasoningProgressFrame =>
    ({ type: "system", subtype: "reasoning_progress", block_id: "rb", phase, kind, provider: "p", model: "m", parent_tool_use_id: null, ...extra });
  blocks.start(frame("start"));
  const titles: Array<string | undefined> = [];
  for (let i = 0; i < text.length; i += size) {
    const out = blocks.delta(frame("delta", { text: text.slice(i, i + size), part: 0 }));
    titles.push((out[0] as { title?: string } | undefined)?.title);
  }
  const end = blocks.end(frame("end"))[0] as { title?: string };
  return { live: titles, block: end.title };
}

describe("the fixture: real reasoning blocks and the title each gets", () => {
  test("the fixture is the size the report quotes (67 blocks — 52 real, 15 synthetic — 58 titled)", () => {
    expect(fixture.blocks).toHaveLength(67);
    expect(fixture.blocks.filter((b) => b.title !== null)).toHaveLength(58);
  });

  for (const b of fixture.blocks) {
    test(`${b.id}${b.note ? ` — ${b.note}` : ""}`, () => {
      expect(deriveThinkingTitle(b.kind, [b.text], { final: true }) ?? null).toBe(b.title);
    });
  }

  test("streamed through ThinkingBlocks in any chunking, every block persists the same title", () => {
    for (const b of fixture.blocks) {
      for (const size of b.text.length <= 1500 ? [1, 17, 160] : [17, 160]) {
        expect({ id: b.id, size, title: stream(b.kind, b.text, size).block ?? null }).toEqual({ id: b.id, size, title: b.title });
      }
    }
  });

  test("the tracker answers the same however the text is pushed (it is chunking-independent by construction)", () => {
    for (const b of fixture.blocks) {
      const t = new ActivityTitleTracker();
      for (let i = 0; i < b.text.length; i += 3) t.push(b.text.slice(i, i + 3));
      expect(t.title(true)).toBe(activityTitleOf(b.text, true));
    }
  });
});

describe("gerundOf", () => {
  test("silent e, -ie, -ee/-ye/-oe, irregulars", () => {
    expect(["read", "examine", "write", "use", "take", "lie", "tie", "see", "agree", "be", "dye", "panic", "quit", "verify", "try"].map(gerundOf))
      .toEqual(["reading", "examining", "writing", "using", "taking", "lying", "tying", "seeing", "agreeing", "being", "dyeing", "panicking", "quitting", "verifying", "trying"]);
  });

  test("CVC doubling for one-syllable verbs, never for -w/-x/-y or a vowel pair", () => {
    expect(["run", "skip", "plan", "scan", "stop", "get", "set", "put", "map", "dig", "drop", "step", "swap", "wrap", "cut", "sum", "grep", "skim", "trim"].map(gerundOf))
      .toEqual(["running", "skipping", "planning", "scanning", "stopping", "getting", "setting", "putting", "mapping", "digging", "dropping", "stepping", "swapping", "wrapping", "cutting", "summing", "grepping", "skimming", "trimming"]);
    expect(["fix", "show", "say", "read", "look", "check", "test", "add", "ask", "find"].map(gerundOf))
      .toEqual(["fixing", "showing", "saying", "reading", "looking", "checking", "testing", "adding", "asking", "finding"]);
  });

  test("stressed-final multi-syllable verbs double; unstressed ones never do", () => {
    expect(["begin", "commit", "submit", "admit", "omit", "permit", "refer", "prefer", "occur", "debug", "rerun", "forget", "control"].map(gerundOf))
      .toEqual(["beginning", "committing", "submitting", "admitting", "omitting", "permitting", "referring", "preferring", "occurring", "debugging", "rerunning", "forgetting", "controlling"]);
    expect(["visit", "edit", "open", "listen", "limit", "target", "exit", "audit", "filter", "render", "answer", "consider", "develop", "order", "offer", "enter", "gather", "cover", "deliver", "remember"].map(gerundOf))
      .toEqual(["visiting", "editing", "opening", "listening", "limiting", "targeting", "exiting", "auditing", "filtering", "rendering", "answering", "considering", "developing", "ordering", "offering", "entering", "gathering", "covering", "delivering", "remembering"]);
  });

  test("a hyphenated verb takes the ending on its last part", () => {
    expect(gerundOf("re-examine")).toBe("re-examining");
    expect(gerundOf("double-check")).toBe("double-checking");
  });
});

describe("the activity patterns", () => {
  test("a leading gerund, optionally after Now/Carefully/Still/First/Next", () => {
    expect(final("Scanning the project source and test files to identify every bug.")).toBe("Scanning the project source and test files");
    expect(final("Now checking `test/calc.test.js`.")).toBe("Checking `test/calc.test.js`");
    expect(final("Carefully reviewing all files to identify every bug.")).toBe("Reviewing all files");
    expect(final("Still investigating the flaky test.")).toBe("Investigating the flaky test");
  });

  test("I'm / I am (now) <gerund>", () => {
    expect(final("I am now identifying the riskiest function.")).toBe("Identifying the riskiest function");
    expect(final("I'm exploring the project structure to identify source files before counting lines.")).toBe("Exploring the project structure");
  });

  test("Let me / I'll / I will / I should / I need to / I'm going to (adverbs) <verb> → a gerund", () => {
    expect(final("Let me read all the files.")).toBe("Reading all the files");
    expect(final("I'll run the tests.")).toBe("Running the tests");
    expect(final("I will skip the slow suite.")).toBe("Skipping the slow suite");
    expect(final("I should examine the schema.")).toBe("Examining the schema");
    expect(final("I need to count lines per file, check git log, and identify the riskiest function.")).toBe("Counting lines per file");
    expect(final("I'm going to scan the logs.")).toBe("Scanning the logs");
    expect(final("Let me first take a look at the working directory to see what's there.")).toBe("Taking a look at the working directory");
    expect(final("Now let me quickly check the README.")).toBe("Checking the README");
  });

  test("… start by <gerund>; go/try and <verb>; double check; verify by <gerund>", () => {
    expect(final("Let me start by exploring the project directory to understand what we're working with.")).toBe("Exploring the project directory");
    expect(final("I'll go through and read all the files.")).toBe("Reading all the files");
    expect(final("Let me double check the imports.")).toBe("Double-checking the imports");
    expect(final("Let me verify by checking git status.")).toBe("Checking git status");
    expect(final("Starting to analyze the project for bugs.")).toBe("Analyzing the project for bugs");
  });

  test("Found / Confirmed / Identified / Spotted and first-person past steps are kept as written", () => {
    expect(final("Found two bugs in src/calc.js.")).toBe("Found two bugs in src/calc.js");
    expect(final("Confirmed a bug where the div function returns 18 instead of 2.")).toBe("Confirmed a bug where the div function returns 18…");
    expect(final("I've identified the bugs and am now analyzing them.")).toBe("Identified the bugs");
    expect(final("I checked the git log.")).toBe("Checked the git log");
    expect(final("Confirmed.")).toBeUndefined();                                 // nothing found is no title
    expect(final("I decided not to list it.")).toBeUndefined();                  // not a step
  });

  test("mid-clause candidates: after ', so' / '; ' / ' — ' (and an unspaced em dash)", () => {
    expect(final("It's a small project, so I'll just read through all the files.")).toBe("Reading through all the files");
    expect(final("The tests pass; now examining the fixtures.")).toBe("Examining the fixtures");
    expect(final("Nothing useful in the history — I'll count lines per file instead.")).toBe("Counting lines per file instead");
    expect(final("There's no useful history to inspect—I'll just count lines per file and read through the contents directly.")).toBe("Counting lines per file");
    // The sentence's own match stands when its later clause has none.
    expect(final("Let me check the files, so the plan is grounded.")).toBe("Checking the files");
  });

  test("the LATEST matching sentence wins", () => {
    expect(final("Let me read the files. Now let me run the tests.")).toBe("Running the tests");
    expect(final("Let me read the files. The tests look fine.")).toBe("Reading the files");
  });

  test("shortening: purpose/reason clauses, commas, parentheses after a space; never inside code or a call", () => {
    expect(final("Let me run the tests to see what fails.")).toBe("Running the tests");
    expect(final("Let me read the logs because the build failed.")).toBe("Reading the logs");
    expect(final("Let me read the README (it is short).")).toBe("Reading the README");
    expect(final("Then I will plan the pow(a,b) implementation and test coverage.")).toBe("Planning the pow(a,b) implementation and test coverage");
    expect(final("I'll run `find . -type f | xargs wc -l` to count lines per file, then check the git log.")).toBe("Running `find . -type f | xargs wc -l`");
    expect(final("Let me read the source next.")).toBe("Reading the source");
  });

  test("a title is capped at 9 words with an ellipsis, and at 200 characters", () => {
    expect(final("Let me read the first second third fourth fifth sixth seventh eighth ninth file.")).toBe("Reading the first second third fourth fifth sixth seventh…");
    const long = final(`Let me read ${Array.from({ length: 8 }, () => "x".repeat(24)).join(" ")}.`)!;
    expect(long.length).toBe(200);
    expect(long.endsWith("…")).toBe(true);
  });

  test("skipped: code fences, list items, headings, table rows, overlong sentences", () => {
    expect(final("```js\n// Let me read the file.\n```\n")).toBeUndefined();
    expect(final("1. Let me read the file.\n- Let me run the tests.\n## Checking the build\n| Reading | x |\n")).toBeUndefined();
    expect(final(`Let me read ${"very ".repeat(150)}long.`)).toBeUndefined();
    // …and prose after a closed fence counts again.
    expect(final("```\ncode. More code.\n```\nLet me run it now.\nLet me run the suite.")).toBe("Running the suite");
  });
});

describe("the misfire filters", () => {
  test("(a) a gerund SUBJECT followed by a finite verb is a statement, not an activity", () => {
    expect(final("Reassigning the string parameter works fine in JavaScript.")).toBeUndefined();
    expect(final("Adding spaces always increases string length.")).toBeUndefined();
    expect(final("Passing a number like `42` will return the raw value.")).toBeUndefined();
    expect(final("Dividing by zero when the array is empty also produces invalid output.")).toBeUndefined();
    // …but a finite verb inside a subordinate clause leaves the activity standing.
    expect(final("Checking whether the missing test imports are a code bug.")).toBe("Checking whether the missing test imports are a code…");
  });

  test("(b) -ing adjectives and nouns never lead", () => {
    for (const s of ["Interesting findings.", "Existing tests use Jest.", "Missing sub/mul tests aren't really bugs.", "Remaining work is small.", "Nothing else stands out.", "String concatenation in a loop.", "During the run nothing failed."]) {
      expect(final(s)).toBeUndefined();
    }
  });

  test("(c) a cut inside inline code, or an unbalanced backtick, is no title", () => {
    expect(final("Running `find")).toBeUndefined();
    expect(final("Let me check `pad.")).toBeUndefined();
  });

  test("(d) a pronoun-only object is no object", () => {
    for (const s of ["Let me analyze them.", "I'll check it.", "Let me look at this.", "Let me take a look.", "Reading those again."]) expect(final(s)).toBeUndefined();
  });

  test("(e) a bare generic verb is no title; any other bare verb is WEAK (never replaces a title with an object)", () => {
    for (const s of ["Let me think.", "Let me analyze.", "Continuing.", "Proceeding.", "I'll start.", "Working."]) expect(final(s)).toBeUndefined();
    expect(final("Let me verify.")).toBe("Verifying");
    expect(final("Let me run node to confirm it. Let me test.")).toBe("Running node");
  });

  test("(f) writing the ANSWER is skipped, so the previous real activity stands", () => {
    for (const s of ["Let me write a concise final answer.", "Let me give two sentences.", "I'll present clearly.", "Keeping it tight.", "Answering in prose.", "Now I'll provide the final report.", "Let me write up the findings in severity order."]) {
      expect(final(`Let me read the logs. ${s}`)).toBe("Reading the logs");
    }
    // A writing verb with a working object is an activity.
    expect(final("Drafting the one-line fixes now.")).toBe("Drafting the one-line fixes");
  });

  test("half a bold span (a heading broken by a line) is no candidate", () => {
    expect(final("**Checking the\ntests**")).toBeUndefined();
  });
});

describe("the bold heading", () => {
  test("OpenAI/Gemini headings are unchanged", () => {
    expect(lastValidHeading("**Listing source files for inspection**\n\nI will run ls.")).toBe("Listing source files for inspection");
    expect(lastValidHeading("**Reading the schema**\n\nThree tables.\n\n**Planning the migration**\n\nTwo steps.")).toBe("Planning the migration");
    expect(lastValidHeading("**Done**")).toBe("Done");
  });

  test("a bold heading beats the prose rule", () => {
    expect(deriveThinkingTitle("summary", ["**Listing source files for inspection**\n\nLet me run the tests first."], { final: true })).toBe("Listing source files for inspection");
  });

  test("BUG FIX: markdown labels and file names are not headings (DeepSeek over the Anthropic dialect)", () => {
    for (const t of ["**src/calc.js:**", "**test/calc.test.js:**", "**src/format.js**", "**src/calc.js** (5 lines):", "**src/format.js**:", "**Lines per file (sorted by size):**", "**Note:**", "**calc.js**", "**`calc.js`**", "**src/**"]) {
      expect({ t, h: lastValidHeading(`${t}\n1. body`) ?? null }).toEqual({ t, h: null });
    }
    expect(lastValidHeading(`**${"word ".repeat(11).trim()}**`)).toBeUndefined();   // > 10 words
    // An invalid heading after a valid one leaves the valid one standing.
    expect(lastValidHeading("**Planning the fix**\n\nbody\n\n**src/calc.js:**\n```js\n```")).toBe("Planning the fix");
    // …and the prose rule answers instead.
    expect(deriveThinkingTitle("summary", ["Let me analyze each file carefully for bugs.\n\n**src/calc.js:**\n```js\nexport function div(a, b) { return a * b; }\n```\n"], { final: true }))
      .toBe("Analyzing each file carefully for bugs");
  });

  test("a bold span followed by more text on its line is not a heading", () => {
    expect(lastValidHeading("**Not a heading** for raw CoT")).toBeUndefined();
  });
});

describe("kinds", () => {
  test("summary and exposed share the rule; update keeps its own text; hidden has none", () => {
    expect(deriveThinkingTitle("summary", ["Let me read the files."], { final: true })).toBe("Reading the files");
    expect(deriveThinkingTitle("exposed", ["Let me read the files."], { final: true })).toBe("Reading the files");
    expect(deriveThinkingTitle("exposed", ["**Looks like a heading**"])).toBe("Looks like a heading");
    expect(deriveThinkingTitle("update", ["Let me read the files."])).toBe("Let me read the files.");
    expect(deriveThinkingTitle("hidden", ["Let me read the files."])).toBeUndefined();
  });
});

describe("streaming", () => {
  test("an incomplete sentence yields nothing yet; the title appears only once the sentence is CLOSED (review r2: no provisional titles)", () => {
    expect(live("Let me read the fi")).toBeUndefined();
    expect(live("Let me read the files")).toBeUndefined();
    expect(live("Let me read the files.")).toBeUndefined();                          // what follows could still continue it
    expect(live("Let me read the files. ")).toBe("Reading the files");
    expect(live("Let me read the files.\n")).toBe("Reading the files");
    // At the block's end the trailing sentence counts whatever it ends with.
    expect(final("Let me read the files")).toBe("Reading the files");
  });

  test("a '.' that the next delta continues is not a sentence end (\"src/calc.\" + \"js\") — and no title is shown meanwhile", () => {
    const t = new ActivityTitleTracker();
    t.push("Let me read src/calc.");
    expect(t.title(false)).toBeUndefined();
    t.push("js first. The");
    expect(t.title(false)).toBe("Reading src/calc.js");
  });

  test("the live pill: no title until the first sentence completes, then it rides every text delta; the block keeps it", () => {
    const out = stream("exposed", "Let me read the files. Then the tests", 6);
    expect(out.live.slice(0, 3)).toEqual([undefined, undefined, undefined]);
    expect(out.live[3]).toBe("Reading the files");                                    // "Let me read the files." complete
    expect(out.live.slice(4).every((t) => t === "Reading the files")).toBe(true);
    expect(out.block).toBe("Reading the files");
  });

  test("the block's end counts its unterminated last sentence (the persisted title may be newer than the live one)", () => {
    const out = stream("summary", "Let me read the files. Now let me run the tests", 8);
    expect(out.live[out.live.length - 1]).toBe("Reading the files");
    expect(out.block).toBe("Running the tests");
  });

  test("sticky: a title never drops back to none within a block — a later part with no title keeps it", () => {
    const blocks = new ThinkingBlocks("s_test", () => 0);
    const f = (phase: "delta" | "end", text?: string, part?: number): ReasoningProgressFrame =>
      ({ type: "system", subtype: "reasoning_progress", block_id: "rb", phase, kind: "summary", ...(text === undefined ? {} : { text }), ...(part === undefined ? {} : { part }) });
    expect((blocks.delta(f("delta", "Let me read the schema.\n", 0))[0] as { title?: string }).title).toBe("Reading the schema");
    expect((blocks.delta(f("delta", "The schema has three tables.", 1))[0] as { title?: string }).title).toBe("Reading the schema");
    expect((blocks.end(f("end"))[0] as { title?: string }).title).toBe("Reading the schema");
  });

  test("a provider heading that scrolls out of the window stays the part's title; the prose rule never takes over", () => {
    const text = `**Planning the migration**\n\n${"Let me read the schema. ".repeat(300)}`;
    expect(stream("summary", text, 500).block).toBe("Planning the migration");
  });
});
