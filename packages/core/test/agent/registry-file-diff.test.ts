import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ToolRegistry, MAX_OUTPUT } from "../../src/agent/tools/registry";
import { FakeProvider } from "../../src/agent/fake-provider";
import { setupEngine } from "./engine-steer.test";

// diff-tabs Task 5: the registry's structured-return channel. A tool's `run()` may now return
// `string | { output: string; fileDiff?: FileDiffSummary }` instead of only `string` —
// `execute()` normalizes both shapes, applies MAX_OUTPUT truncation to `output` ONLY, and threads
// `fileDiff` onto the returned ToolOutcome untouched. No REAL tool sets fileDiff yet (Task 6
// does that) — every fixture here is a fake/scratch tool, mirroring tool-registry.test.ts's and
// tools-registry.test.ts's own harness pattern (`new ToolRegistry()` + `r.register({...})` +
// `r.execute(name, args, ctx)`, a minimal ctx literal satisfying only ToolContext's required
// fields). Nothing here touches disk, so no temp NORMA_HOME is needed.

describe("ToolRegistry: structured fileDiff return (Task 5)", () => {
  test("fake tool returning {output, fileDiff} → outcome carries both verbatim", async () => {
    const r = new ToolRegistry();
    // Must stay FileDiffSummary-schema-valid (packages/protocol/src/events.ts): diffId matches
    // DIFF_ID_SHAPE, path/added/removed are the right primitive shapes. Irrelevant to execute()
    // itself (registry.ts never validates it — TS structural typing only), but the engine-level
    // tests below round-trip this same shape through SessionEvent.parse() at emit time, where an
    // invalid fixture would throw mid-turn instead of failing an assertion.
    const fileDiff = { path: "/p", added: 1, removed: 2, diffId: "abc" };
    r.register({ name: "fake_diff", description: "d", args: z.object({}), run: () => ({ output: "did it", fileDiff }) });
    const res = await r.execute("fake_diff", {}, { cwd: "/", roots: ["/"], sessionId: "s" });
    expect(res.isError).toBe(false);
    expect(res.output).toBe("did it");
    expect(res.fileDiff).toEqual(fileDiff);
  });

  test("plain-string tool → fileDiff is undefined, and the key itself is absent", async () => {
    const r = new ToolRegistry();
    r.register({ name: "fake_plain", description: "d", args: z.object({}), run: () => "just text" });
    const res = await r.execute("fake_plain", {}, { cwd: "/", roots: ["/"], sessionId: "s" });
    expect(res.isError).toBe(false);
    expect(res.output).toBe("just text");
    expect(res.fileDiff).toBeUndefined();
    // Stronger than toBeUndefined(): the field must be genuinely ABSENT from the outcome object,
    // not present-with-value-undefined — matching the brief's "must be ABSENT (not
    // undefined-serialized)" contract for the eventual emitted event, one layer down at the
    // registry itself so a plain-string tool's outcome shape stays byte-identical to pre-Task-5.
    expect(Object.hasOwn(res, "fileDiff")).toBe(false);
  });

  test("oversized output + fileDiff → output truncated at MAX_OUTPUT, fileDiff intact", async () => {
    const r = new ToolRegistry();
    const fileDiff = { path: "/big", added: 100, removed: 50, diffId: "xyz" };
    const bigOutput = "x".repeat(70_000);
    r.register({ name: "fake_big", description: "d", args: z.object({}), run: () => ({ output: bigOutput, fileDiff }) });
    const res = await r.execute("fake_big", {}, { cwd: "/", roots: ["/"], sessionId: "s" });
    expect(res.isError).toBe(false);
    expect(res.output.length).toBe(MAX_OUTPUT + `\n[truncated at ${MAX_OUTPUT} bytes]`.length);
    expect(res.output).toContain(`\n[truncated at ${MAX_OUTPUT} bytes]`);
    expect(res.output.startsWith("x".repeat(1000))).toBe(true); // still the real content, just capped
    // fileDiff rides the outcome UNTOUCHED — truncation applies to `output` only.
    expect(res.fileDiff).toEqual(fileDiff);
  });
});

// -------------------------------------------------------------------------------------------
// Engine-level: does the emitted `tool_result` SessionEvent actually carry fileDiff end-to-end?
// Reuses engine-steer.test.ts's exported `setupEngine` harness (the same one engine-runthread.
// test.ts and approval-options.test.ts reuse) + FakeProvider, following engine.test.ts's/
// approval-options.test.ts's precedent of registering a custom tool into the registry handed to
// the harness. Kept here rather than deferred to Task 6 because the harness makes it cheap.
//
// Policy "bypass" (not the harness default "auto"): a fake, unregistered-with-gate.ts tool name
// is UNCLASSIFIED (gate.ts's isGateClassified), which fails CLOSED to "ask" under every policy
// except "bypass" (gate.ts's evaluate(): `if (policy === "bypass") return "allow";` is checked
// before the isGateClassified fail-closed branch) — bypass is the one verdict that reaches
// registry.execute() with no approval card, so the test doesn't need to also drive the
// ApprovalBroker to resolution just to prove the plumbing.
// -------------------------------------------------------------------------------------------
describe("engine: fileDiff rides the emitted tool_result event (Task 5)", () => {
  test("a fake tool's fileDiff is stamped onto the tool_result event, JSON included", async () => {
    const registry = new ToolRegistry();
    const fileDiff = { path: "/p", added: 3, removed: 1, diffId: "diff1" };
    registry.register({ name: "fake_diff_tool", description: "d", args: z.object({}), run: () => ({ output: "did it", fileDiff }) });
    const provider = new FakeProvider([
      [{ type: "tool_call", callId: "c1", name: "fake_diff_tool", argsJson: "{}" }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }],
    ]);
    const { engine, sessionId, events } = setupEngine(provider, { registry, policy: "bypass" });
    await engine.runTurn(sessionId);
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();
    expect(toolResult).toMatchObject({ type: "tool_result", isError: false, fileDiff });
    expect(JSON.stringify(toolResult)).toContain("fileDiff");
  });

  test("a plain-string fake tool's tool_result event has NO fileDiff key at all", async () => {
    const registry = new ToolRegistry();
    registry.register({ name: "fake_plain_tool", description: "d", args: z.object({}), run: () => "just text" });
    const provider = new FakeProvider([
      [{ type: "tool_call", callId: "c1", name: "fake_plain_tool", argsJson: "{}" }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }],
    ]);
    const { engine, sessionId, events } = setupEngine(provider, { registry, policy: "bypass" });
    await engine.runTurn(sessionId);
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();
    expect(JSON.stringify(toolResult)).not.toContain("fileDiff");
    expect(Object.hasOwn(toolResult!, "fileDiff")).toBe(false);
  });
});
