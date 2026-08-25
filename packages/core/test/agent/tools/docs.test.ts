import { describe, expect, test } from "bun:test";
import { OFFICE_DEADLINES_MS } from "../../../src/panel/office-commands";
import { ToolRegistry, type ToolContext } from "../../../src/agent/tools/registry";
import { registerDocsTool, type DocsToolDeps } from "../../../src/agent/tools/docs";
import { officeTimeoutMessage } from "../../../src/agent/tools/sheets";
import type { PanelCommandOutcome } from "../../../src/panel/commands";
import type { SessionDirs } from "../../../src/sessions/dirs";
import { PermissionGate } from "../../../src/agent/gate";

/**
 * office-agent-tools T7 — the `docs` daemon tool, through a FAKE registry recorder, mirroring
 * `slides.test.ts`/`sheets.test.ts`'s own posture exactly (spec §9: the daemon tool is tested
 * through the fake transport; end-to-end proof lives in the Swift live drills,
 * `OfficeDocsCommandTests.swift`, which assert on the SAVED FILE'S OWN BYTES).
 */

const SID = "s-docs";
const WORKDIR = "/repo";
const DOC = `${WORKDIR}/notes.odt`;

interface Recorded {
  sessionId: string;
  action: string;
  args?: Record<string, unknown>;
  deadlineMs: number;
}

interface Harness {
  deps: DocsToolDeps;
  recorded: Recorded[];
  registry: ToolRegistry;
  outcome: (cmd: Recorded) => Promise<PanelCommandOutcome>;
  run(args: unknown, ctx?: Partial<ToolContext>): Promise<{ output: string; isError: boolean }>;
}

function makeHarness(opts?: {
  dirs?: SessionDirs;
  harnesses?: Array<{ clientName: string; role?: string | null }>;
}): Harness {
  const recorded: Recorded[] = [];
  const h: Harness = {
    recorded,
    outcome: async () => ({ kind: "result", ok: true, result: "did it" }),
    registry: new ToolRegistry(),
    deps: {
      dispatch(cmd) {
        const rec: Recorded = { sessionId: cmd.sessionId, action: cmd.action, args: cmd.args, deadlineMs: cmd.deadlineMs };
        recorded.push(rec);
        return { commandId: `pcmd_${recorded.length}`, settled: h.outcome(rec) };
      },
      harnesses: () => opts?.harnesses ?? [{ clientName: "orb", role: "harness" }],
      dirsOf: () => opts?.dirs ?? [{ path: WORKDIR, locked: true }],
    },
    async run(args, ctx) {
      return h.registry.execute("docs", args, {
        cwd: WORKDIR, roots: [WORKDIR], sessionId: SID, mode: "code",
        ...ctx,
      } as ToolContext);
    },
  };
  registerDocsTool(h.registry, h.deps);
  return h;
}

// ================================================================================================
// Registration
// ================================================================================================

describe("registration", () => {
  test("modes is exactly [\"code\", \"dispatch\"] — never chat", () => {
    const h = makeHarness();
    expect(h.registry.namesForMode("code").has("docs")).toBe(true);
    expect(h.registry.namesForMode("dispatch").has("docs")).toBe(true);
    expect(h.registry.namesForMode("chat").has("docs")).toBe(false);
  });

  // Mirrors sheets/slides' own tripwire: the verb enum pinned literally through the SAME
  // z.toJSONSchema path a real model sees, so a new verb fails here before it ships silently
  // inheriting an unaudited gate classification.
  test("the verb enum is exactly the 5 verbs this task ships", () => {
    const h = makeHarness();
    const spec = h.registry.specFor("docs", WORKDIR, "code");
    const parameters = spec?.parameters as { properties?: { verb?: { enum?: string[] } } } | undefined;
    expect(parameters?.properties?.verb?.enum).toEqual(["info", "read", "replace", "insert", "append"]);
  });

  test("`at` is a closed enum — start/end only, so a free-form position can never reach the app", () => {
    const h = makeHarness();
    const spec = h.registry.specFor("docs", WORKDIR, "code");
    const parameters = spec?.parameters as { properties?: { at?: { enum?: string[] } } } | undefined;
    expect(parameters?.properties?.at?.enum).toEqual(["start", "end"]);
  });

  test("docs is classified MUTATING in gate.ts, not READ_ONLY — every verb, including info/read", () => {
    const gate = new PermissionGate();
    expect(gate.evaluate("docs", "ask")).toBe("ask");
    expect(gate.evaluate("docs", "plan")).toBe("deny");
    expect(gate.evaluate("docs", "auto")).toBe("allow");
  });

  // The tool description is a shipped artifact this arc has already caught contradicting the code
  // once (T5's Minor-5: a description that was not merely untested but FALSE). These three claims
  // are the ones a model will act on and the ones the code below actually enforces.
  test("the description states the three facts the code enforces — undo is REFUSED, literal find, no first-only replace", () => {
    const h = makeHarness();
    const description = h.registry.specFor("docs", WORKDIR, "code")?.description ?? "";
    // Ruling 4's user-facing half, CORRECTED by T7's own live drill: LOK refuses a cross-view undo
    // outside repair mode (`docundo.cxx:456-472`), so a human's ⌘Z cannot take back a docs edit and
    // silently does nothing. The description must say that, not the ruling's original "shared" text.
    expect(description).toContain("NO WAY TO UNDO IT");
    expect(description).toContain("⌘Z will simply do nothing");
    // Ruling 1: literal, case-sensitive.
    expect(description).toContain("LITERAL and CASE-SENSITIVE");
    // The v1 narrowing, stated where a model will read it rather than discovered by refusal.
    expect(description).toContain("no way to replace only the FIRST occurrence");
  });
});

// ================================================================================================
// info
// ================================================================================================

describe("info", () => {
  test("dispatches office.docs.info with just path, at its own deadline", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "info", path: DOC });
    expect(result.isError).toBe(false);
    expect(h.recorded).toEqual([{
      sessionId: SID, action: "office.docs.info",
      args: { path: DOC },
      deadlineMs: OFFICE_DEADLINES_MS["office.docs.info"],
    }]);
  });

  test("a missing path is malformed and refused by zod, before dispatch", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "info" });
    expect(result.isError).toBe(true);
    expect(h.recorded).toEqual([]);
  });
});

// ================================================================================================
// read
// ================================================================================================

describe("read", () => {
  test("dispatches office.docs.read with just path when no range is named", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "read", path: DOC });
    expect(result.isError).toBe(false);
    expect(h.recorded).toEqual([{
      sessionId: SID, action: "office.docs.read",
      args: { path: DOC },
      deadlineMs: OFFICE_DEADLINES_MS["office.docs.read"],
    }]);
  });

  test("forwards each paragraph bound independently — naming one never invents the other", async () => {
    const from = makeHarness();
    await from.run({ verb: "read", path: DOC, fromParagraph: 3 });
    expect(from.recorded[0]?.args).toEqual({ path: DOC, fromParagraph: 3 });

    const to = makeHarness();
    await to.run({ verb: "read", path: DOC, toParagraph: 9 });
    expect(to.recorded[0]?.args).toEqual({ path: DOC, toParagraph: 9 });

    const both = makeHarness();
    await both.run({ verb: "read", path: DOC, fromParagraph: 2, toParagraph: 4 });
    expect(both.recorded[0]?.args).toEqual({ path: DOC, fromParagraph: 2, toParagraph: 4 });
  });

  // The class this arc has now paid for three times: `z.number().int().positive()` is NOT a bound
  // (`Number.isInteger(1e30)` is `true`), the app's `Int(Double)` TRAPS outside `Int`'s range, and a
  // trap ABORTS Norma.app along with every open document's unsaved edits. `docs.ts` did not exist
  // during the sweep that closed `sheets`' and `slides`' own doors, so it is outside that sweep by
  // construction — these are bounded on arrival rather than after a review.
  test("an app-aborting paragraph index is refused before dispatch — both operands, every shape", async () => {
    const cases: Array<Record<string, unknown>> = [
      { fromParagraph: 1e30 },
      { toParagraph: 1e30 },
      { fromParagraph: 9223372036854775807 },
      { toParagraph: 9223372036854775807 },
      { fromParagraph: 1_000_001 },
      { toParagraph: 1_000_001 },
      { fromParagraph: 0 },
      { toParagraph: 0 },
      { fromParagraph: -1 },
      { fromParagraph: 1.5 },
      { fromParagraph: "3" },
      { toParagraph: true },
    ];
    for (const c of cases) {
      const h = makeHarness();
      const result = await h.run({ verb: "read", path: DOC, ...c } as never);
      expect(result.isError).toBe(true);
      expect(h.recorded).toEqual([]);
    }
  });

  test("the paragraph ceiling is inclusive — exactly 1000000 still dispatches", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "read", path: DOC, fromParagraph: 1_000_000 });
    expect(result.isError).toBe(false);
    expect(h.recorded).toHaveLength(1);
  });

  test("from after to is refused before dispatch, naming both numbers", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "read", path: DOC, fromParagraph: 9, toParagraph: 2 });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("9");
    expect(result.output).toContain("2");
    expect(h.recorded).toEqual([]);
  });

  test("from EQUAL to is legal — a one-paragraph read is a real request", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "read", path: DOC, fromParagraph: 4, toParagraph: 4 });
    expect(result.isError).toBe(false);
    expect(h.recorded[0]?.args).toEqual({ path: DOC, fromParagraph: 4, toParagraph: 4 });
  });
});

// ================================================================================================
// replace — ruling 1's own surface
// ================================================================================================

describe("replace", () => {
  test("dispatches office.docs.replace with find+replaceWith, at the WRITE deadline", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "replace", path: DOC, find: "old", replaceWith: "new" });
    expect(result.isError).toBe(false);
    expect(h.recorded).toEqual([{
      sessionId: SID, action: "office.docs.replace",
      args: { path: DOC, find: "old", replaceWith: "new" },
      deadlineMs: OFFICE_DEADLINES_MS["office.docs.replace"],
    }]);
    // A write verb must not be sharing the read deadline — the two are different numbers for a
    // reason (`office-commands.ts` §A: a write pays for one more helper round trip).
    expect(OFFICE_DEADLINES_MS["office.docs.replace"])
      .not.toBe(OFFICE_DEADLINES_MS["office.docs.read"]);
  });

  test("an EMPTY replaceWith is legal and is forwarded — that is how you delete every occurrence", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "replace", path: DOC, find: "TODO ", replaceWith: "" });
    expect(result.isError).toBe(false);
    expect(h.recorded[0]?.args).toEqual({ path: DOC, find: "TODO ", replaceWith: "" });
  });

  test("an ABSENT replaceWith is refused — a forgotten operand must never become a deletion", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "replace", path: DOC, find: "old" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("replaceWith");
    expect(h.recorded).toEqual([]);
  });

  test("a missing or empty find is refused before dispatch", async () => {
    for (const args of [{ verb: "replace", path: DOC, replaceWith: "new" },
                        { verb: "replace", path: DOC, find: "", replaceWith: "new" }]) {
      const h = makeHarness();
      const result = await h.run(args);
      expect(result.isError).toBe(true);
      expect(h.recorded).toEqual([]);
    }
  });

  // The engine's matcher never crosses a paragraph node, but OUR literal count over `\n`-joined
  // text happily would — a guaranteed divergence, i.e. a guaranteed trip of ruling 1's own
  // cross-check tripwire, on input a model can produce by accident. Refused at the daemon, and
  // again at the wire, rather than discovered mid-verb after a dispatch already ran.
  test("a line break in find or replaceWith is refused before dispatch, naming the engine reason", async () => {
    for (const args of [
      { verb: "replace", path: DOC, find: "one\ntwo", replaceWith: "x" },
      { verb: "replace", path: DOC, find: "one\rtwo", replaceWith: "x" },
      { verb: "replace", path: DOC, find: "x", replaceWith: "one\ntwo" },
      { verb: "replace", path: DOC, find: "x", replaceWith: "one\rtwo" },
    ]) {
      const h = makeHarness();
      const result = await h.run(args);
      expect(result.isError).toBe(true);
      expect(result.output).toContain("line break");
      expect(h.recorded).toEqual([]);
    }
  });

  // The whole point of KEEPING `all` in the schema. Zod's object parse strips unknown keys, so a
  // schema without `all` would silently DROP an `all: false` a model meant and replace everything
  // while reporting success — this arc's own silent-wrong-answer class, in the one place where the
  // wrong answer is a wrong edit in the user's saved file.
  test("all:false is REFUSED with the engine reason — never silently upgraded to replace-everything", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "replace", path: DOC, find: "old", replaceWith: "new", all: false });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("every one, or nothing");
    expect(h.recorded).toEqual([]);
  });

  test("all:true dispatches, and `all` is NOT forwarded — only one value survives validation", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "replace", path: DOC, find: "old", replaceWith: "new", all: true });
    expect(result.isError).toBe(false);
    expect(h.recorded[0]?.args).toEqual({ path: DOC, find: "old", replaceWith: "new" });
  });
});

// ================================================================================================
// insert / append
// ================================================================================================

describe("insert / append", () => {
  test("insert dispatches office.docs.insert with text, and omits `at` when unnamed", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "insert", path: DOC, text: "hello" });
    expect(result.isError).toBe(false);
    expect(h.recorded).toEqual([{
      sessionId: SID, action: "office.docs.insert",
      args: { path: DOC, text: "hello" },
      deadlineMs: OFFICE_DEADLINES_MS["office.docs.insert"],
    }]);
  });

  test("insert forwards at:start and at:end verbatim", async () => {
    for (const at of ["start", "end"] as const) {
      const h = makeHarness();
      await h.run({ verb: "insert", path: DOC, text: "hello", at });
      expect(h.recorded[0]?.args).toEqual({ path: DOC, text: "hello", at });
    }
  });

  test("an `at` outside the closed enum is refused by zod, before dispatch", async () => {
    for (const at of ["beginning", "END", "middle", 0, true]) {
      const h = makeHarness();
      const result = await h.run({ verb: "insert", path: DOC, text: "hello", at } as never);
      expect(result.isError).toBe(true);
      expect(h.recorded).toEqual([]);
    }
  });

  test("append dispatches office.docs.append and never carries an `at`", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "append", path: DOC, text: "a new paragraph" });
    expect(result.isError).toBe(false);
    expect(h.recorded).toEqual([{
      sessionId: SID, action: "office.docs.append",
      args: { path: DOC, text: "a new paragraph" },
      deadlineMs: OFFICE_DEADLINES_MS["office.docs.append"],
    }]);
  });

  // Accepting an `at` `append` cannot honour would be the description contradicting the code —
  // this arc's own named defect class.
  test("append REFUSES an `at` rather than accepting one it would not honour", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "append", path: DOC, text: "x", at: "start" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("insert");
    expect(h.recorded).toEqual([]);
  });

  test("a missing or empty text is refused for both verbs, before dispatch", async () => {
    for (const verb of ["insert", "append"] as const) {
      for (const args of [{ verb, path: DOC }, { verb, path: DOC, text: "" }]) {
        const h = makeHarness();
        const result = await h.run(args);
        expect(result.isError).toBe(true);
        expect(h.recorded).toEqual([]);
      }
    }
  });
});

// ================================================================================================
// The fence and reach — the two rungs before dispatch, and their ORDER
// ================================================================================================

describe("fence and reach", () => {
  test("a path outside the working directories is refused, for every verb, before dispatch", async () => {
    for (const args of [
      { verb: "info", path: "/etc/passwd" },
      { verb: "read", path: "/etc/passwd" },
      { verb: "replace", path: "/etc/passwd", find: "a", replaceWith: "b" },
      { verb: "insert", path: "/etc/passwd", text: "x" },
      { verb: "append", path: "/etc/passwd", text: "x" },
    ]) {
      const h = makeHarness();
      const result = await h.run(args);
      expect(result.isError).toBe(true);
      expect(result.output).toContain("outside the allowed directories");
      expect(h.recorded).toEqual([]);
    }
  });

  test("a traversal path that escapes the fence is refused after normalization", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "info", path: `${WORKDIR}/../etc/passwd` });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("outside the allowed directories");
    expect(h.recorded).toEqual([]);
  });

  test("a relative path resolves against the primary working directory and dispatches ABSOLUTE", async () => {
    const h = makeHarness();
    await h.run({ verb: "info", path: "notes.odt" });
    expect(h.recorded[0]?.args).toEqual({ path: DOC });
  });

  test("with no working directories at all, every path is outside the fence", async () => {
    const h = makeHarness({ dirs: [] });
    const result = await h.run({ verb: "info", path: DOC });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("outside the allowed directories");
  });

  test("no attached harness refuses with the app-not-running sentence", async () => {
    const h = makeHarness({ harnesses: [] });
    const result = await h.run({ verb: "info", path: DOC });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("isn't showing this session");
    expect(h.recorded).toEqual([]);
  });

  test("a phone-only harness cannot host the panel and is named in the refusal", async () => {
    const h = makeHarness({ harnesses: [{ clientName: "norma-ios", role: "remote" }] });
    const result = await h.run({ verb: "info", path: DOC });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("norma-ios");
    expect(h.recorded).toEqual([]);
  });

  // Spec §5, explicitly: "a probe outside the working directories answers with the fence refusal
  // rather than the app-not-running one." The daemon knows the session's dirs without the app, so
  // an impossible path must never have to wait to learn whether the app is running.
  test("the FENCE wins when both would fire — an out-of-fence path with no app attached", async () => {
    const h = makeHarness({ harnesses: [] });
    const result = await h.run({ verb: "info", path: "/etc/passwd" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("outside the allowed directories");
    expect(result.output).not.toContain("isn't showing this session");
  });
});

// ================================================================================================
// Outcomes — timeout, failure, abort
// ================================================================================================

describe("outcomes", () => {
  test("a timeout says OUTCOME UNKNOWN, in the one shared sentence every office tool uses", async () => {
    const h = makeHarness();
    h.outcome = async () => ({ kind: "timeout", deadlineMs: 185_000 });
    const result = await h.run({ verb: "append", path: DOC, text: "x" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain(officeTimeoutMessage("docs append", 185_000));
    expect(result.output).toContain("UNKNOWN");
    expect(result.output).not.toContain("did not happen");
  });

  test("an app-side refusal is surfaced verbatim, never replaced with this tool's own prose", async () => {
    const h = makeHarness();
    h.outcome = async () => ({ kind: "result", ok: false, result: "the tab has unsaved changes" });
    const result = await h.run({ verb: "replace", path: DOC, find: "a", replaceWith: "b" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("the tab has unsaved changes");
  });

  test("a successful result is returned verbatim — the app's own smallest useful truth", async () => {
    const h = makeHarness();
    h.outcome = async () => ({ kind: "result", ok: true, result: "replaced 3 occurrences of \"old\" in notes.odt" });
    const result = await h.run({ verb: "replace", path: DOC, find: "old", replaceWith: "new" });
    expect(result.isError).toBe(false);
    expect(result.output).toBe("replaced 3 occurrences of \"old\" in notes.odt");
  });

  test("an already-aborted turn never dispatches", async () => {
    const h = makeHarness();
    const controller = new AbortController();
    controller.abort();
    const result = await h.run({ verb: "append", path: DOC, text: "x" }, { signal: controller.signal });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("interrupted");
    expect(h.recorded).toEqual([]);
  });
});
