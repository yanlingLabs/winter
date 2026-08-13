import { describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/agent/tools/registry";
import type { ToolContext } from "../../src/agent/tools/registry";
import { registerAskUserTool } from "../../src/agent/tools/ask-user";

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: "/", roots: ["/"], sessionId: "s", ...overrides };
}

function buildRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  registerAskUserTool(r);
  return r;
}

const Q = (over: Record<string, unknown> = {}) => ({
  question: "Pick one",
  header: "Pick",
  options: [{ label: "A", description: "Option A" }, { label: "B", description: "Option B" }],
  multiSelect: false,
  ...over,
});

describe("ask_user tool", () => {
  test("zod bounds: 0 and 5 questions, 1 and 5 options, 15-char header all rejected", async () => {
    const r = buildRegistry();
    const badArgs = [
      { questions: [] },
      { questions: Array(5).fill(Q()) },
      { questions: [Q({ options: [{ label: "A" }] })] },
      { questions: [Q({ options: Array(5).fill({ label: "x" }) })] },
      // 15 chars — one past the accepted ceiling. The previous fixture here was
      // "ThirteenChars!", which is FOURTEEN characters despite its name; under the old max(12)
      // both 13 and 14 were refused, so nothing ever caught the mislabel. It matters now that 14
      // is the boundary.
      { questions: [Q({ header: "FifteenChars!!!" })] },
    ];
    for (const bad of badArgs) {
      const out = await r.execute("ask_user", bad, ctx());
      expect(out.isError).toBe(true);
    }
  });

  /// The advertised-12 / accepted-14 tolerance (user call, 2026-08-13). The description asks for 12
  /// because that is what the chip renders cleanly; the schema takes 14 so a near miss does not
  /// refuse the WHOLE call and lose every question in it. Both halves are pinned here, because the
  /// gap between them is the entire point and a future "tidy-up" to one number would erase it
  /// silently in either direction.
  test("header: 12 advertised, 13 and 14 tolerated, 15 refused", async () => {
    const r = buildRegistry();
    const answer = ctx({ ask: async () => ({ answers: { "Pick one": "B" }, by: "cli" }) });

    for (const header of ["Exactly 12ch", "Draft details", "Call to action"]) {
      expect(header.length).toBeLessThanOrEqual(14);
      const out = await r.execute("ask_user", { questions: [Q({ header })] }, answer);
      expect(out.isError).toBe(false);
    }

    const refused = await r.execute("ask_user", { questions: [Q({ header: "A".repeat(15) })] }, answer);
    expect(refused.isError).toBe(true);

    // The DESCRIPTION still asks for 12 — the tolerance is a safety net the model is never invited
    // to spend. If this ever advertises 14, the net is gone and 15s start costing whole calls.
    const described = r.specFor("ask_user")?.description ?? "";
    expect(described).toContain("12 CHARACTERS MAXIMUM (including spaces)");
    expect(described).not.toContain("14 CHARACTERS");
  });

  /// One overlong header refuses EVERY question in the call — the cost that motivated the
  /// tolerance, pinned so it stays visible.
  test("one bad header refuses the whole multi-question call", async () => {
    const r = buildRegistry();
    const out = await r.execute(
      "ask_user",
      { questions: [Q({ question: "Q1", header: "Fine" }), Q({ question: "Q2", header: "A".repeat(15) })] },
      ctx({ ask: async () => ({ answers: {}, by: "cli" }) }),
    );
    expect(out.isError).toBe(true);
  });

  // 4g-ii (CC parity): option description is now REQUIRED — a label without one is invalid args,
  // distinct from the count-bounds cases above (this option list is otherwise well-formed).
  test("option missing description → invalid args", async () => {
    const r = buildRegistry();
    const out = await r.execute(
      "ask_user",
      { questions: [Q({ options: [{ label: "A", description: "Option A" }, { label: "B" }] })] },
      ctx(),
    );
    expect(out.isError).toBe(true);
    expect(out.output).toContain("description");
  });

  test("formats answers by header, keyed by question text", async () => {
    const r = buildRegistry();
    const out = await r.execute(
      "ask_user",
      { questions: [Q()] },
      ctx({ ask: async () => ({ answers: { "Pick one": "B" }, by: "cli" }) }),
    );
    expect(out.isError).toBe(false);
    expect(out.output).toContain("Pick: B");
  });

  test("multiSelect + missing answers render", async () => {
    const r = buildRegistry();
    const out = await r.execute(
      "ask_user",
      {
        questions: [
          Q({ question: "Q1", header: "First", options: [{ label: "A", description: "Option A" }, { label: "C", description: "Option C" }], multiSelect: true }),
          Q({ question: "Q2", header: "Second" }),
        ],
      },
      ctx({ ask: async () => ({ answers: { Q1: "A, C" }, by: "cli" }) }),
    );
    expect(out.isError).toBe(false);
    expect(out.output).toContain("First: A, C");
    expect(out.output).toContain("Second: (no answer)");
  });

  test("timeout → non-error proceed message", async () => {
    const r = buildRegistry();
    const out = await r.execute(
      "ask_user",
      { questions: [Q()] },
      ctx({ ask: async () => ({ timedOut: true }) }),
    );
    expect(out.isError).toBe(false);
    expect(out.output).toContain("Proceed with your best judgment");
  });

  test("no ctx.ask → immediate proceed message", async () => {
    const r = buildRegistry();
    const out = await r.execute("ask_user", { questions: [Q()] }, ctx());
    expect(out.isError).toBe(false);
    expect(out.output).toContain("Proceed with your best judgment");
  });

  // CC AskUserQuestion parity (Task 2): option preview, single-select only.
  test("option preview accepted on a single-select question", async () => {
    const r = buildRegistry();
    const out = await r.execute(
      "ask_user",
      { questions: [Q({ options: [{ label: "A", description: "Option A", preview: "diff A" }, { label: "B", description: "Option B" }] })] },
      ctx({ ask: async () => ({ answers: { "Pick one": "A" }, by: "cli" }) }),
    );
    expect(out.isError).toBe(false);
    expect(out.output).toContain("Pick: A");
  });

  test("option preview + multiSelect:true → invalid args", async () => {
    const r = buildRegistry();
    const out = await r.execute(
      "ask_user",
      { questions: [Q({ multiSelect: true, options: [{ label: "A", description: "Option A", preview: "diff A" }, { label: "B", description: "Option B" }] })] },
      ctx(),
    );
    expect(out.isError).toBe(true);
  });

  test("ask outcome with notes → tool result includes the note text verbatim", async () => {
    const r = buildRegistry();
    const out = await r.execute(
      "ask_user",
      { questions: [Q()] },
      ctx({ ask: async () => ({ answers: { "Pick one": "B" }, notes: { "Pick one": "prefer B for perf" }, by: "cli" }) }),
    );
    expect(out.isError).toBe(false);
    expect(out.output).toContain("Pick: B");
    expect(out.output).toContain('[user note on "Pick one": prefer B for perf]');
  });

  // (d) no-preview/no-notes path unchanged — locks the exact byte shape of the pre-existing
  // "formats answers by header" output so the notes-folding addition never perturbs it.
  test("no-notes path is byte-identical to the pre-notes output", async () => {
    const r = buildRegistry();
    const out = await r.execute(
      "ask_user",
      { questions: [Q()] },
      ctx({ ask: async () => ({ answers: { "Pick one": "B" }, by: "cli" }) }),
    );
    expect(out.output).toBe("User answered:\n- Pick: B");
  });
});
