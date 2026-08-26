import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OFFICE_DEADLINES_MS } from "../../../src/panel/office-commands";
import { ToolRegistry, type ToolContext } from "../../../src/agent/tools/registry";
import { registerSlidesTool, type SlidesToolDeps } from "../../../src/agent/tools/slides";
import { officeTimeoutMessage } from "../../../src/agent/tools/sheets";
import type { PanelCommandOutcome } from "../../../src/panel/commands";
import type { SessionDirs } from "../../../src/sessions/dirs";
import { PermissionGate } from "../../../src/agent/gate";

/**
 * office-agent-tools T6 — the `slides` daemon tool, through a FAKE registry recorder, mirroring
 * `sheets.test.ts`'s own posture exactly (spec §9: "the daemon tool [is tested] through the fake
 * transport, end-to-end only at the live gate" — the live gate here is the Swift-side live drills
 * task-6-report.md documents against real fixtures).
 */

const SID = "s-slides";
const WORKDIR = "/repo";

interface Recorded {
  sessionId: string;
  action: string;
  args?: Record<string, unknown>;
  deadlineMs: number;
}

interface Harness {
  deps: SlidesToolDeps;
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
      return h.registry.execute("slides", args, {
        cwd: WORKDIR, roots: [WORKDIR], sessionId: SID, mode: "code",
        ...ctx,
      } as ToolContext);
    },
  };
  registerSlidesTool(h.registry, h.deps);
  return h;
}

// ================================================================================================
// Registration
// ================================================================================================

describe("registration", () => {
  test("modes is exactly [\"code\", \"dispatch\"] — never chat", () => {
    const h = makeHarness();
    expect(h.registry.namesForMode("code").has("slides")).toBe(true);
    expect(h.registry.namesForMode("dispatch").has("slides")).toBe(true);
    expect(h.registry.namesForMode("chat").has("slides")).toBe(false);
  });

  // Mirrors sheets.test.ts's own I6 tripwire: the verb enum pinned literally through the SAME
  // z.toJSONSchema path a real model sees, so the day this tool grows a new verb it fails here
  // first, before that verb ships silently inheriting an unaudited gate classification.
  test("the verb enum is exactly the 7 verbs shipped (6 from T6 + office-finish's batch)", () => {
    const h = makeHarness();
    const spec = h.registry.specFor("slides", WORKDIR, "code");
    const parameters = spec?.parameters as { properties?: { verb?: { enum?: string[] } } } | undefined;
    const verbEnum = parameters?.properties?.verb?.enum;
    expect(verbEnum).toEqual(["info", "read", "set_text", "add_slide", "delete_slide", "reorder", "batch"]);
  });

  test("slides is classified MUTATING in gate.ts, not READ_ONLY — every verb, including info/read, pays this now", () => {
    const gate = new PermissionGate();
    expect(gate.evaluate("slides", "ask")).toBe("ask");
    expect(gate.evaluate("slides", "plan")).toBe("deny");
  });
});

// ================================================================================================
// info
// ================================================================================================

describe("info", () => {
  test("dispatches office.slides.info with just path, at its own deadline", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "info", path: `${WORKDIR}/deck.pptx` });
    expect(result.isError).toBe(false);
    expect(h.recorded).toEqual([{
      sessionId: SID, action: "office.slides.info",
      args: { path: `${WORKDIR}/deck.pptx` },
      deadlineMs: OFFICE_DEADLINES_MS["office.slides.info"],
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
  test("dispatches office.slides.read with path/slide, at its own deadline", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "read", path: `${WORKDIR}/deck.pptx`, slide: 1 });
    expect(result.isError).toBe(false);
    expect(h.recorded).toEqual([{
      sessionId: SID, action: "office.slides.read",
      args: { path: `${WORKDIR}/deck.pptx`, slide: 1 },
      deadlineMs: OFFICE_DEADLINES_MS["office.slides.read"],
    }]);
  });

  test("a missing slide is malformed and refused, before dispatch", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "read", path: `${WORKDIR}/deck.pptx` });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("slide");
    expect(h.recorded).toEqual([]);
  });

  // T5 fix-round RE-REVIEW, the NEW Critical — every value here used to satisfy
  // `z.number().int().positive()` (`Number.isInteger(1e30)` is `true`), reach the app's own
  // `oneBasedIndex`, and ABORT NORMA.APP inside its `Int(Double)`. Proven red at the app: removing
  // the app-side ceiling crashes the XCTest runner outright ("Restarting after unexpected exit,
  // crash, or test timeout"), which is what an aborting `Int(Double)` looks like from outside.
  test("an app-aborting slide/at/to index is refused before dispatch — every verb that takes one", async () => {
    const cases: Array<Record<string, unknown>> = [
      { verb: "read", slide: 1e30 },
      { verb: "read", slide: 9223372036854775807 },
      { verb: "read", slide: 10001 },
      { verb: "set_text", slide: 1e30, title: "x" },
      { verb: "delete_slide", slide: 1e30 },
      { verb: "reorder", slide: 1e30, to: 2 },
      { verb: "reorder", slide: 1, to: 1e30 },
      { verb: "add_slide", at: 1e30 },
    ];
    for (const c of cases) {
      const h = makeHarness();
      const result = await h.run({ path: `${WORKDIR}/deck.pptx`, ...c } as never);
      expect(result.isError).toBe(true);
      expect(h.recorded).toEqual([]);
    }
  });

  test("the index ceiling is inclusive — exactly 10000 still dispatches", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "read", path: `${WORKDIR}/deck.pptx`, slide: 10000 });
    expect(result.isError).toBe(false);
    expect(h.recorded).toHaveLength(1);
  });

  test("slide must be a positive integer — zero and negative are refused by zod", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "read", path: `${WORKDIR}/deck.pptx`, slide: 0 });
    expect(result.isError).toBe(true);
    expect(h.recorded).toEqual([]);
  });
});

// ================================================================================================
// set_text
// ================================================================================================

describe("set_text", () => {
  test("dispatches office.slides.set_text with slide+title", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "set_text", path: `${WORKDIR}/deck.pptx`, slide: 2, title: "Q3 Revenue" });
    expect(result.isError).toBe(false);
    expect(h.recorded).toEqual([{
      sessionId: SID, action: "office.slides.set_text",
      args: { path: `${WORKDIR}/deck.pptx`, slide: 2, title: "Q3 Revenue" },
      deadlineMs: OFFICE_DEADLINES_MS["office.slides.set_text"],
    }]);
  });

  test("dispatches title+body together when both are given", async () => {
    const h = makeHarness();
    await h.run({ verb: "set_text", path: `${WORKDIR}/deck.pptx`, slide: 1, title: "Hi", body: "bullet one" });
    expect(h.recorded[0]?.args).toEqual({ path: `${WORKDIR}/deck.pptx`, slide: 1, title: "Hi", body: "bullet one" });
  });

  // The absent-key contract this verb's whole design rests on (mirroring `sheets format`'s own
  // pinned test of the identical contract) — an operand the caller never named must not be a KEY in
  // the wire args at all.
  test("an attribute never named by the caller is not a key in args at all", async () => {
    const h = makeHarness();
    await h.run({ verb: "set_text", path: `${WORKDIR}/deck.pptx`, slide: 1, body: "only body" });
    const args = h.recorded[0]?.args ?? {};
    expect(Object.keys(args).sort()).toEqual(["body", "path", "slide"]);
    expect("title" in args).toBe(false);
  });

  test("naming neither title nor body is refused, before dispatch — it would do nothing", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "set_text", path: `${WORKDIR}/deck.pptx`, slide: 1 });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("at least one");
    expect(h.recorded).toEqual([]);
  });

  test("a missing slide is malformed and refused, before dispatch", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "set_text", path: `${WORKDIR}/deck.pptx`, title: "Hi" });
    expect(result.isError).toBe(true);
    expect(h.recorded).toEqual([]);
  });

  test("title past its own schema ceiling is refused by zod, before dispatch", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "set_text", path: `${WORKDIR}/deck.pptx`, slide: 1, title: "x".repeat(501) });
    expect(result.isError).toBe(true);
    expect(h.recorded).toEqual([]);
  });
});

// ================================================================================================
// add_slide
// ================================================================================================

describe("add_slide", () => {
  test("dispatches office.slides.add_slide with no fields when neither at nor layout is given", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "add_slide", path: `${WORKDIR}/deck.pptx` });
    expect(result.isError).toBe(false);
    expect(h.recorded).toEqual([{
      sessionId: SID, action: "office.slides.add_slide",
      args: { path: `${WORKDIR}/deck.pptx` },
      deadlineMs: OFFICE_DEADLINES_MS["office.slides.add_slide"],
    }]);
  });

  test("dispatches at+layout together when both are given", async () => {
    const h = makeHarness();
    await h.run({ verb: "add_slide", path: `${WORKDIR}/deck.pptx`, at: 2, layout: "title_content" });
    expect(h.recorded[0]?.args).toEqual({ path: `${WORKDIR}/deck.pptx`, at: 2, layout: "title_content" });
  });

  test("layout must be one of the closed presets — an unrecognized value is malformed and refused by zod", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "add_slide", path: `${WORKDIR}/deck.pptx`, layout: "custom-xyz" });
    expect(result.isError).toBe(true);
    expect(h.recorded).toEqual([]);
  });

  test("at must be a positive integer — zero is refused by zod", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "add_slide", path: `${WORKDIR}/deck.pptx`, at: 0 });
    expect(result.isError).toBe(true);
    expect(h.recorded).toEqual([]);
  });

  test("no path is malformed and refused by zod, before dispatch", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "add_slide" });
    expect(result.isError).toBe(true);
    expect(h.recorded).toEqual([]);
  });
});

// ================================================================================================
// delete_slide
// ================================================================================================

describe("delete_slide", () => {
  test("dispatches office.slides.delete_slide with slide", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "delete_slide", path: `${WORKDIR}/deck.pptx`, slide: 3 });
    expect(result.isError).toBe(false);
    expect(h.recorded).toEqual([{
      sessionId: SID, action: "office.slides.delete_slide",
      args: { path: `${WORKDIR}/deck.pptx`, slide: 3 },
      deadlineMs: OFFICE_DEADLINES_MS["office.slides.delete_slide"],
    }]);
  });

  test("a missing slide is malformed and refused, before dispatch", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "delete_slide", path: `${WORKDIR}/deck.pptx` });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("slide");
    expect(h.recorded).toEqual([]);
  });
});

// ================================================================================================
// reorder
// ================================================================================================

describe("reorder", () => {
  test("dispatches office.slides.reorder with slide+to", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "reorder", path: `${WORKDIR}/deck.pptx`, slide: 3, to: 1 });
    expect(result.isError).toBe(false);
    expect(h.recorded).toEqual([{
      sessionId: SID, action: "office.slides.reorder",
      args: { path: `${WORKDIR}/deck.pptx`, slide: 3, to: 1 },
      deadlineMs: OFFICE_DEADLINES_MS["office.slides.reorder"],
    }]);
  });

  test("a missing `to` is malformed and refused, before dispatch", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "reorder", path: `${WORKDIR}/deck.pptx`, slide: 1 });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("`to`");
    expect(h.recorded).toEqual([]);
  });

  test("a missing slide is malformed and refused, before dispatch", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "reorder", path: `${WORKDIR}/deck.pptx`, to: 1 });
    expect(result.isError).toBe(true);
    expect(h.recorded).toEqual([]);
  });
});

// ================================================================================================
// The fence (spec §5) — and its precedence over reach
// ================================================================================================

describe("the fence", () => {
  /** **Whole-branch review F4 (CRITICAL), this tool's own call site.** The fence body is now shared
   *  (`sheets.ts`'s `officeResolvedPathWithinFence`), but a shared body proves nothing about whether
   *  THIS tool actually calls it — that wiring is what F4's three byte-identical copies were hiding.
   *  Real directory, real `ln -s`, real tool surface. */
  test("a path through an in-root symlink that LEAVES the root is refused (F4)", async () => {
    const base = mkdtempSync(join(tmpdir(), "office-fence-"));
    const proj = join(base, "proj");
    const outside = join(base, "outside");
    mkdirSync(proj); mkdirSync(outside);
    writeFileSync(join(outside, "deck.bin"), "x");
    symlinkSync(outside, join(proj, "link"));
    const symPath = join(proj, "link", "deck.bin");

    const h = makeHarness({ dirs: [{ path: proj, locked: true }] });
    const result = await h.run({ verb: "info", path: symPath });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("working directories");
    expect(h.recorded).toEqual([]);
    rmSync(base, { recursive: true, force: true });
  });

  test("a path outside every working directory is refused, before dispatch", async () => {
    const h = makeHarness({ dirs: [{ path: WORKDIR, locked: true }] });
    const result = await h.run({ verb: "info", path: "/etc/passwd" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("working directories");
    expect(h.recorded).toEqual([]);
  });

  test("no working directories at all refuses every path", async () => {
    const h = makeHarness({ dirs: [] });
    const result = await h.run({ verb: "info", path: `${WORKDIR}/deck.pptx` });
    expect(result.isError).toBe(true);
    expect(h.recorded).toEqual([]);
  });

  test("a relative path resolves against the primary working directory", async () => {
    const h = makeHarness({ dirs: [{ path: WORKDIR, locked: true }] });
    const result = await h.run({ verb: "info", path: "deck.pptx" });
    expect(result.isError).toBe(false);
    expect(h.recorded[0]?.args?.path).toBe(`${WORKDIR}/deck.pptx`);
  });

  test("a sibling directory that merely shares a string prefix is not inside the root", async () => {
    const h = makeHarness({ dirs: [{ path: "/x/proj", locked: true }] });
    const result = await h.run({ verb: "info", path: "/x/proj-evil/deck.pptx" });
    expect(result.isError).toBe(true);
    expect(h.recorded).toEqual([]);
  });

  test("a secondary (non-primary) working directory is in-fence too", async () => {
    const h = makeHarness({ dirs: [{ path: WORKDIR, locked: true }, { path: "/granted", locked: false }] });
    const result = await h.run({ verb: "info", path: "/granted/deck.pptx" });
    expect(result.isError).toBe(false);
    expect(h.recorded[0]?.args?.path).toBe("/granted/deck.pptx");
  });

  test("an out-of-fence path with the app not even running still gets the FENCE refusal, not \"app not running\"", async () => {
    const h = makeHarness({ dirs: [{ path: WORKDIR, locked: true }], harnesses: [] });
    const result = await h.run({ verb: "info", path: "/etc/passwd" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("working directories");
    expect(result.output).not.toContain("isn't showing this session");
    expect(h.recorded).toEqual([]);
  });

  test("a write verb is refused by the fence exactly like a read, before dispatch", async () => {
    const h = makeHarness({ dirs: [{ path: WORKDIR, locked: true }] });
    const result = await h.run({ verb: "set_text", path: "/etc/passwd", slide: 1, title: "x" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("working directories");
    expect(h.recorded).toEqual([]);
  });
});

// ================================================================================================
// Reach (spec §3 — info doubles as the drivability probe)
// ================================================================================================

describe("reach", () => {
  test("no attached client at all refuses with a clear reason, before dispatch", async () => {
    const h = makeHarness({ harnesses: [] });
    const result = await h.run({ verb: "info", path: `${WORKDIR}/deck.pptx` });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("isn't showing this session");
    expect(h.recorded).toEqual([]);
  });

  test("only a phone/terminal attached (no panel-hosting client) refuses, before dispatch", async () => {
    const h = makeHarness({ harnesses: [{ clientName: "cli-abc", role: "harness" }] });
    const result = await h.run({ verb: "read", path: `${WORKDIR}/deck.pptx`, slide: 1 });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("cli-abc");
    expect(h.recorded).toEqual([]);
  });

  test("a remote (phone) role does not count as a panel host", async () => {
    const h = makeHarness({ harnesses: [{ clientName: "orb", role: "remote" }] });
    const result = await h.run({ verb: "info", path: `${WORKDIR}/deck.pptx` });
    expect(result.isError).toBe(true);
    expect(h.recorded).toEqual([]);
  });
});

// ================================================================================================
// Outcomes — timeout (OUTCOME UNKNOWN, never "failed"), ok:false, ok:true
// ================================================================================================

describe("outcomes", () => {
  test("a timeout says OUTCOME UNKNOWN, never that the read failed — the identical wording sheets already inherited", async () => {
    const h = makeHarness();
    h.outcome = async () => ({ kind: "timeout", deadlineMs: OFFICE_DEADLINES_MS["office.slides.info"] });
    const result = await h.run({ verb: "info", path: `${WORKDIR}/deck.pptx` });
    expect(result.isError).toBe(true);
    expect(result.output.toLowerCase()).toContain("unknown");
    expect(result.output.toLowerCase()).toContain("not a failure");
    expect(result.output.toLowerCase()).not.toContain("this failed");
    expect(result.output.toLowerCase()).not.toContain("did not happen");
    expect(result.output).toBe(officeTimeoutMessage("slides info", OFFICE_DEADLINES_MS["office.slides.info"]));
  });

  test("an app-reported failure (ok:false) surfaces the app's own reason, unedited", async () => {
    const h = makeHarness();
    h.outcome = async () => ({ kind: "result", ok: false, result: "no slide 9 in deck.pptx — this presentation has 3 slides" });
    const result = await h.run({ verb: "read", path: `${WORKDIR}/deck.pptx`, slide: 9 });
    expect(result.isError).toBe(true);
    expect(result.output).toBe("no slide 9 in deck.pptx — this presentation has 3 slides");
  });

  test("a successful read returns the app's own result text verbatim", async () => {
    const h = makeHarness();
    h.outcome = async () => ({ kind: "result", ok: true, result: "Slide 1: title=\"Hello\" body=\"world\"" });
    const result = await h.run({ verb: "read", path: `${WORKDIR}/deck.pptx`, slide: 1 });
    expect(result.isError).toBe(false);
    expect(result.output).toBe("Slide 1: title=\"Hello\" body=\"world\"");
  });

  test("an aborted turn returns an interrupted note rather than dispatching or throwing", async () => {
    const h = makeHarness();
    const controller = new AbortController();
    controller.abort();
    const result = await h.run({ verb: "info", path: `${WORKDIR}/deck.pptx` }, { signal: controller.signal });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("interrupted");
    expect(h.recorded).toEqual([]);
  });
});
