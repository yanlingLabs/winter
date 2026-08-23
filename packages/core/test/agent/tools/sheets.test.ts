import { describe, expect, test } from "bun:test";
import { OFFICE_DEADLINES_MS } from "../../../src/panel/office-commands";
import { ToolRegistry, type ToolContext } from "../../../src/agent/tools/registry";
import { registerSheetsTool, officeTimeoutMessage, type SheetsToolDeps } from "../../../src/agent/tools/sheets";
import type { PanelCommandOutcome } from "../../../src/panel/commands";
import type { SessionDirs } from "../../../src/sessions/dirs";
import { PermissionGate } from "../../../src/agent/gate";

/**
 * office-agent-tools T3 — the `sheets` daemon tool, through a FAKE registry recorder rather than a
 * live daemon (same posture `browser.test.ts` takes, spec §9: "the daemon tool [is tested] through
 * the fake transport, end-to-end only at the live gate" — the live gate here is the Swift-side live
 * drills task-3-report.md documents against real fixtures).
 */

const SID = "s-sheets";
const WORKDIR = "/repo";

interface Recorded {
  sessionId: string;
  action: string;
  args?: Record<string, unknown>;
  deadlineMs: number;
}

interface Harness {
  deps: SheetsToolDeps;
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
      return h.registry.execute("sheets", args, {
        cwd: WORKDIR, roots: [WORKDIR], sessionId: SID, mode: "code",
        ...ctx,
      } as ToolContext);
    },
  };
  registerSheetsTool(h.registry, h.deps);
  return h;
}

// ================================================================================================
// Registration — the brief's own explicit pin
// ================================================================================================

describe("registration", () => {
  test("modes is exactly [\"code\", \"dispatch\"] — never chat", () => {
    const h = makeHarness();
    expect(h.registry.namesForMode("code").has("sheets")).toBe(true);
    expect(h.registry.namesForMode("dispatch").has("sheets")).toBe(true);
    expect(h.registry.namesForMode("chat").has("sheets")).toBe(false);
  });

  // office-agent-tools T3 review (I6), T4 update — `sheets`' verb enum is pinned literally,
  // rendered through the SAME z.toJSONSchema path a real model actually sees (ToolRegistry.specFor),
  // not a raw zod import that could drift from what's really offered. T3 warned that gate.ts's
  // READ_ONLY classification was name-keyed and would need revisiting the day a write verb landed —
  // T4 did that (gate.ts now classifies `sheets` MUTATING; see gate.test.ts's own dedicated test).
  // This test now guards the NEXT growth (`format`, T5+): the day the enum grows again, it fails
  // here first, before a new verb ships without its own operand validation/gate audit.
  test("the verb enum is exactly the 10 verbs T3+T4 shipped — format (T5+) is not registered yet", () => {
    const h = makeHarness();
    const spec = h.registry.specFor("sheets", WORKDIR, "code");
    const parameters = spec?.parameters as { properties?: { verb?: { enum?: string[] } } } | undefined;
    const verbEnum = parameters?.properties?.verb?.enum;
    expect(verbEnum).toEqual([
      "info", "read", "set",
      "insert_rows", "insert_cols", "delete_rows", "delete_cols",
      "add_sheet", "delete_sheet", "rename_sheet",
    ]);
  });

  // office-agent-tools T4 — the companion half of the guard above: the day a verb lands here, it
  // must ALSO be reflected in gate.ts's classification. Since gate.ts classifies by TOOL NAME (not
  // verb), this is a single assertion rather than one per verb — but it is what actually closes the
  // loop the I6 comment above promises, rather than merely restating the enum.
  test("sheets is classified MUTATING in gate.ts, not READ_ONLY — every verb, including info/read, pays this now", () => {
    const gate = new PermissionGate();
    expect(gate.evaluate("sheets", "ask")).toBe("ask");
    expect(gate.evaluate("sheets", "plan")).toBe("deny");
  });
});

// ================================================================================================
// info
// ================================================================================================

describe("info", () => {
  test("dispatches office.sheets.info with just path, at its own deadline", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "info", path: `${WORKDIR}/budget.xlsx` });
    expect(result.isError).toBe(false);
    expect(h.recorded).toEqual([{
      sessionId: SID, action: "office.sheets.info",
      args: { path: `${WORKDIR}/budget.xlsx` },
      deadlineMs: OFFICE_DEADLINES_MS["office.sheets.info"],
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
  test("dispatches office.sheets.read with path/sheet/range/formulas, at its own deadline", async () => {
    const h = makeHarness();
    const result = await h.run({
      verb: "read", path: `${WORKDIR}/budget.xlsx`, sheet: "Sheet1", range: "A1:C10", formulas: true,
    });
    expect(result.isError).toBe(false);
    expect(h.recorded).toEqual([{
      sessionId: SID, action: "office.sheets.read",
      args: { path: `${WORKDIR}/budget.xlsx`, sheet: "Sheet1", range: "A1:C10", formulas: true },
      deadlineMs: OFFICE_DEADLINES_MS["office.sheets.read"],
    }]);
  });

  test("formulas defaults to false when absent — the one genuinely optional operand", async () => {
    const h = makeHarness();
    await h.run({ verb: "read", path: `${WORKDIR}/budget.xlsx`, sheet: "Sheet1", range: "A1" });
    expect(h.recorded[0]?.args).toEqual({ path: `${WORKDIR}/budget.xlsx`, sheet: "Sheet1", range: "A1", formulas: false });
  });

  test("a missing sheet is malformed and refused, before dispatch", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "read", path: `${WORKDIR}/budget.xlsx`, range: "A1" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("sheet");
    expect(h.recorded).toEqual([]);
  });

  test("a missing range is malformed and refused, before dispatch", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "read", path: `${WORKDIR}/budget.xlsx`, sheet: "Sheet1" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("range");
    expect(h.recorded).toEqual([]);
  });

  test("a range that does not even LOOK like A1 notation is refused before dispatch — no round trip for an obviously bad string", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "read", path: `${WORKDIR}/budget.xlsx`, sheet: "Sheet1", range: "not a range" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("not a range");
    expect(h.recorded).toEqual([]);
  });

  test("a single cell is a legal range shape", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "read", path: `${WORKDIR}/budget.xlsx`, sheet: "Sheet1", range: "B2" });
    expect(result.isError).toBe(false);
    expect(h.recorded).toHaveLength(1);
  });
});

// ================================================================================================
// set (T4) — a single `values` grid, content-driven formula detection (this file's own header)
// ================================================================================================

describe("set", () => {
  test("dispatches office.sheets.set via the dedicated typed builder, at its own deadline", async () => {
    const h = makeHarness();
    const result = await h.run({
      verb: "set", path: `${WORKDIR}/budget.xlsx`, sheet: "Sheet1", range: "A1:B1",
      values: [["hello", 42]],
    });
    expect(result.isError).toBe(false);
    expect(h.recorded).toEqual([{
      sessionId: SID, action: "office.sheets.set",
      args: { path: `${WORKDIR}/budget.xlsx`, sheet: "Sheet1", range: "A1:B1", values: [["hello", 42]] },
      deadlineMs: OFFICE_DEADLINES_MS["office.sheets.set"],
    }]);
  });

  test("a missing sheet is malformed and refused, before dispatch", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "set", path: `${WORKDIR}/budget.xlsx`, range: "A1", values: [["x"]] });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("sheet");
    expect(h.recorded).toEqual([]);
  });

  test("a missing range is malformed and refused, before dispatch", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "set", path: `${WORKDIR}/budget.xlsx`, sheet: "Sheet1", values: [["x"]] });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("range");
    expect(h.recorded).toEqual([]);
  });

  test("a missing values is malformed and refused, before dispatch", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "set", path: `${WORKDIR}/budget.xlsx`, sheet: "Sheet1", range: "A1" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("values");
    expect(h.recorded).toEqual([]);
  });

  test("a ragged (non-rectangular) grid is refused, before dispatch", async () => {
    const h = makeHarness();
    const result = await h.run({
      verb: "set", path: `${WORKDIR}/budget.xlsx`, sheet: "Sheet1", range: "A1:B2",
      values: [["a", "b"], ["c"]],
    });
    expect(result.isError).toBe(true);
    expect(result.output.toLowerCase()).toContain("rectangular");
    expect(h.recorded).toEqual([]);
  });

  test("an embedded tab in a cell is refused, before dispatch — write to one cell at a time instead", async () => {
    const h = makeHarness();
    const result = await h.run({
      verb: "set", path: `${WORKDIR}/budget.xlsx`, sheet: "Sheet1", range: "A1", values: [["a\tb"]],
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("tab");
    expect(h.recorded).toEqual([]);
  });

  test("an embedded newline in a cell is refused, before dispatch", async () => {
    const h = makeHarness();
    const result = await h.run({
      verb: "set", path: `${WORKDIR}/budget.xlsx`, sheet: "Sheet1", range: "A1", values: [["a\nb"]],
    });
    expect(result.isError).toBe(true);
    expect(h.recorded).toEqual([]);
  });

  test("a grid past sheetsSetMaxCells is refused outright, before dispatch", async () => {
    const h = makeHarness();
    const row = Array.from({ length: 201 }, (_, i) => i);
    const result = await h.run({
      verb: "set", path: `${WORKDIR}/budget.xlsx`, sheet: "Sheet1", range: "A1:GS1", values: [row],
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("201 cells");
    expect(h.recorded).toEqual([]);
  });

  test("values may carry a formula string — the tool never distinguishes it from a plain value at this layer", async () => {
    const h = makeHarness();
    const result = await h.run({
      verb: "set", path: `${WORKDIR}/budget.xlsx`, sheet: "Sheet1", range: "A1", values: [["=1+1"]],
    });
    expect(result.isError).toBe(false);
    expect(h.recorded[0]?.args).toEqual({
      path: `${WORKDIR}/budget.xlsx`, sheet: "Sheet1", range: "A1", values: [["=1+1"]],
    });
  });
});

// ================================================================================================
// insert_rows / insert_cols / delete_rows / delete_cols (T4)
// ================================================================================================

describe("resize verbs", () => {
  test("insert_rows dispatches office.sheets.insert_rows with sheet/at/count", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "insert_rows", path: `${WORKDIR}/b.xlsx`, sheet: "Sheet1", at: 3, count: 2 });
    expect(result.isError).toBe(false);
    expect(h.recorded).toEqual([{
      sessionId: SID, action: "office.sheets.insert_rows",
      args: { path: `${WORKDIR}/b.xlsx`, sheet: "Sheet1", at: 3, count: 2 },
      deadlineMs: OFFICE_DEADLINES_MS["office.sheets.insert_rows"],
    }]);
  });

  // Fix-round review (item 4) — `at` for a row verb is documented-legal as EITHER a JSON number OR
  // a digit-only JSON string (the validation below coerces via `String(a.at)` against a regex, never
  // requiring `typeof a.at === "number"`) — and passes the ORIGINAL value through UNCHANGED, never
  // normalized to a number, so the app-side consumer must accept a string "3" too (a real gap this
  // review round found and fixed on the Swift side — see OfficeCommandConsumerTests.swift).
  test("a row verb's `at` may be a digit-only STRING, not just a number — documented-legal, passed through unchanged", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "insert_rows", path: `${WORKDIR}/b.xlsx`, sheet: "Sheet1", at: "3", count: 2 });
    expect(result.isError).toBe(false);
    expect(h.recorded[0]?.args).toEqual({ path: `${WORKDIR}/b.xlsx`, sheet: "Sheet1", at: "3", count: 2 });
  });

  test("delete_cols dispatches office.sheets.delete_cols with sheet/at/count, at as letters", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "delete_cols", path: `${WORKDIR}/b.xlsx`, sheet: "Sheet1", at: "C", count: 2 });
    expect(result.isError).toBe(false);
    expect(h.recorded[0]?.args).toEqual({ path: `${WORKDIR}/b.xlsx`, sheet: "Sheet1", at: "C", count: 2 });
  });

  test("a row verb's `at` must be a positive integer row number, not letters", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "insert_rows", path: `${WORKDIR}/b.xlsx`, sheet: "Sheet1", at: "C", count: 1 });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("row number");
    expect(h.recorded).toEqual([]);
  });

  test("a column verb's `at` must be letters, not a number", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "insert_cols", path: `${WORKDIR}/b.xlsx`, sheet: "Sheet1", at: 3, count: 1 });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("column letters");
    expect(h.recorded).toEqual([]);
  });

  test("a missing count is malformed and refused, before dispatch", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "delete_rows", path: `${WORKDIR}/b.xlsx`, sheet: "Sheet1", at: 1 });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("count");
    expect(h.recorded).toEqual([]);
  });

  test("a missing sheet is malformed and refused, before dispatch", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "insert_rows", path: `${WORKDIR}/b.xlsx`, at: 1, count: 1 });
    expect(result.isError).toBe(true);
    expect(h.recorded).toEqual([]);
  });
});

// ================================================================================================
// add_sheet / delete_sheet / rename_sheet (T4) — `name`/`newName`, no `sheet` operand
// ================================================================================================

describe("sheet management verbs", () => {
  test("add_sheet dispatches office.sheets.add_sheet with just name (no `sheet`, no position)", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "add_sheet", path: `${WORKDIR}/b.xlsx`, name: "Q3" });
    expect(result.isError).toBe(false);
    expect(h.recorded).toEqual([{
      sessionId: SID, action: "office.sheets.add_sheet",
      args: { path: `${WORKDIR}/b.xlsx`, name: "Q3" },
      deadlineMs: OFFICE_DEADLINES_MS["office.sheets.add_sheet"],
    }]);
  });

  test("add_sheet without a name is malformed and refused, before dispatch", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "add_sheet", path: `${WORKDIR}/b.xlsx` });
    expect(result.isError).toBe(true);
    expect(h.recorded).toEqual([]);
  });

  test("delete_sheet dispatches office.sheets.delete_sheet with name", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "delete_sheet", path: `${WORKDIR}/b.xlsx`, name: "Sheet2" });
    expect(result.isError).toBe(false);
    expect(h.recorded[0]?.args).toEqual({ path: `${WORKDIR}/b.xlsx`, name: "Sheet2" });
  });

  test("rename_sheet dispatches office.sheets.rename_sheet with name+newName", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "rename_sheet", path: `${WORKDIR}/b.xlsx`, name: "Sheet1", newName: "Revenue" });
    expect(result.isError).toBe(false);
    expect(h.recorded[0]?.args).toEqual({ path: `${WORKDIR}/b.xlsx`, name: "Sheet1", newName: "Revenue" });
  });

  test("rename_sheet without newName is malformed and refused, before dispatch", async () => {
    const h = makeHarness();
    const result = await h.run({ verb: "rename_sheet", path: `${WORKDIR}/b.xlsx`, name: "Sheet1" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("newName");
    expect(h.recorded).toEqual([]);
  });
});

// ================================================================================================
// The fence (spec §5) — and its precedence over reach
// ================================================================================================

describe("the fence", () => {
  test("a path outside every working directory is refused, before dispatch", async () => {
    const h = makeHarness({ dirs: [{ path: WORKDIR, locked: true }] });
    const result = await h.run({ verb: "info", path: "/etc/passwd" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("working directories");
    expect(h.recorded).toEqual([]);
  });

  test("no working directories at all refuses every path", async () => {
    const h = makeHarness({ dirs: [] });
    const result = await h.run({ verb: "info", path: `${WORKDIR}/budget.xlsx` });
    expect(result.isError).toBe(true);
    expect(h.recorded).toEqual([]);
  });

  test("a relative path resolves against the primary working directory", async () => {
    const h = makeHarness({ dirs: [{ path: WORKDIR, locked: true }] });
    const result = await h.run({ verb: "info", path: "budget.xlsx" });
    expect(result.isError).toBe(false);
    expect(h.recorded[0]?.args?.path).toBe(`${WORKDIR}/budget.xlsx`);
  });

  test("a sibling directory that merely shares a string prefix is not inside the root", async () => {
    const h = makeHarness({ dirs: [{ path: "/x/proj", locked: true }] });
    const result = await h.run({ verb: "info", path: "/x/proj-evil/budget.xlsx" });
    expect(result.isError).toBe(true);
    expect(h.recorded).toEqual([]);
  });

  test("a secondary (non-primary) working directory is in-fence too", async () => {
    const h = makeHarness({ dirs: [{ path: WORKDIR, locked: true }, { path: "/granted", locked: false }] });
    const result = await h.run({ verb: "info", path: "/granted/budget.xlsx" });
    expect(result.isError).toBe(false);
    expect(h.recorded[0]?.args?.path).toBe("/granted/budget.xlsx");
  });

  /** spec §5's own words, tested literally: "a probe outside the working dirs answers with the
   *  fence refusal, not the app-not-running one." With NO harnesses attached AND an out-of-fence
   *  path, the fence must win — reach is never even consulted. */
  test("an out-of-fence path with the app not even running still gets the FENCE refusal, not \"app not running\"", async () => {
    const h = makeHarness({ dirs: [{ path: WORKDIR, locked: true }], harnesses: [] });
    const result = await h.run({ verb: "info", path: "/etc/passwd" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("working directories");
    expect(result.output).not.toContain("isn't showing this session");
    expect(h.recorded).toEqual([]);
  });

  // office-agent-tools T4 — the fence applies identically to a WRITE verb (this file's own header:
  // "v1 office tools, read or write, are working-directories-only"). Cheap defense-in-depth here;
  // the live, Swift-side proof (both the app's own fence and the daemon's, agreeing) is the real
  // one — see task-4-report.md.
  test("a write verb is refused by the fence exactly like a read, before dispatch", async () => {
    const h = makeHarness({ dirs: [{ path: WORKDIR, locked: true }] });
    const result = await h.run({ verb: "set", path: "/etc/passwd", sheet: "Sheet1", range: "A1", values: [["x"]] });
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
    const result = await h.run({ verb: "info", path: `${WORKDIR}/budget.xlsx` });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("isn't showing this session");
    expect(h.recorded).toEqual([]);
  });

  test("only a phone/terminal attached (no panel-hosting client) refuses, before dispatch", async () => {
    const h = makeHarness({ harnesses: [{ clientName: "cli-abc", role: "harness" }] });
    const result = await h.run({ verb: "read", path: `${WORKDIR}/budget.xlsx`, sheet: "Sheet1", range: "A1" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("cli-abc");
    expect(h.recorded).toEqual([]);
  });

  test("a remote (phone) role does not count as a panel host", async () => {
    const h = makeHarness({ harnesses: [{ clientName: "orb", role: "remote" }] });
    const result = await h.run({ verb: "info", path: `${WORKDIR}/budget.xlsx` });
    expect(result.isError).toBe(true);
    expect(h.recorded).toEqual([]);
  });
});

// ================================================================================================
// Outcomes — timeout (OUTCOME UNKNOWN, never "failed"), ok:false, ok:true
// ================================================================================================

describe("outcomes", () => {
  test("a timeout says OUTCOME UNKNOWN, never that the read failed — and Task 4 inherits this exact wording", async () => {
    const h = makeHarness();
    h.outcome = async () => ({ kind: "timeout", deadlineMs: OFFICE_DEADLINES_MS["office.sheets.info"] });
    const result = await h.run({ verb: "info", path: `${WORKDIR}/budget.xlsx` });
    expect(result.isError).toBe(true);
    expect(result.output.toLowerCase()).toContain("unknown");
    // The word "failed" legitimately appears in a NEGATING clause ("don't act as if it failed") —
    // the claim this pins is "never asserts failure as fact," not "never uses the word."
    expect(result.output.toLowerCase()).toContain("not a failure");
    expect(result.output.toLowerCase()).not.toContain("this failed");
    expect(result.output.toLowerCase()).not.toContain("did not happen");
    expect(result.output).toBe(officeTimeoutMessage("sheets info", OFFICE_DEADLINES_MS["office.sheets.info"]));
  });

  test("officeTimeoutMessage never claims the outcome is known — pinned literally so Task 4's write verbs inherit the same guarantee, not just the same function name", () => {
    const message = officeTimeoutMessage("sheets set", 12_345);
    expect(message).toContain("UNKNOWN");
    expect(message.toLowerCase()).not.toContain("did not happen");
    expect(message.toLowerCase()).not.toContain("this failed");
    expect(message.toLowerCase()).toContain("never retry blindly");
  });

  test("an app-reported failure (ok:false) surfaces the app's own reason, unedited", async () => {
    const h = makeHarness();
    h.outcome = async () => ({ kind: "result", ok: false, result: "no sheet named \"Nope\" — this workbook has: Sheet1" });
    const result = await h.run({ verb: "read", path: `${WORKDIR}/budget.xlsx`, sheet: "Nope", range: "A1" });
    expect(result.isError).toBe(true);
    expect(result.output).toBe("no sheet named \"Nope\" — this workbook has: Sheet1");
  });

  test("a successful read returns the app's own result text verbatim", async () => {
    const h = makeHarness();
    h.outcome = async () => ({ kind: "result", ok: true, result: "Sheet1!A1:B2 (values):\n42\tHello" });
    const result = await h.run({ verb: "read", path: `${WORKDIR}/budget.xlsx`, sheet: "Sheet1", range: "A1:B2" });
    expect(result.isError).toBe(false);
    expect(result.output).toBe("Sheet1!A1:B2 (values):\n42\tHello");
  });

  test("an aborted turn returns an interrupted note rather than dispatching or throwing", async () => {
    const h = makeHarness();
    const controller = new AbortController();
    controller.abort();
    const result = await h.run({ verb: "info", path: `${WORKDIR}/budget.xlsx` }, { signal: controller.signal });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("interrupted");
    expect(h.recorded).toEqual([]);
  });
});
