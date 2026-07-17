import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";
import { FakeProvider } from "../../src/agent/fake-provider";
import { Dreamer, DREAM_INSTRUCTION, DREAM_MIN_EVENTS, DREAM_MODEL, DREAM_EFFORT, DREAM_WINDOW_MAX_CHARS } from "../../src/agent/dreamer";

/** A real temp store with a dispatch session (the sole session `dispatchSessionId()` finds) —
 *  same fixture shape across all 8 cases; individual tests append whatever events/memory files
 *  they need on top. */
function setup(prefix: string): { home: string; store: SessionStore; dispatchId: string; dir: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const store = new SessionStore(home);
  const dispatchId = store.createSession("global", { mode: "dispatch", origin: "dispatch" });
  const dir = join(home, "memory");
  return { home, store, dispatchId, dir };
}

/** Pads the dispatch log with `n` generic substantive (user_message) events so the
 *  DREAM_MIN_EVENTS gate is satisfied without interfering with a test's own signal events. */
function fillSubstantive(store: SessionStore, sid: string, n: number): void {
  for (let i = 0; i < n; i++) {
    store.append(sid, { type: "user_message", sessionId: sid, threadId: "main", text: `filler message ${i}`, clientName: "test" });
  }
}

function okProvider(delta = '{"ops":[]}'): FakeProvider {
  return new FakeProvider([[{ type: "text_delta", delta }, { type: "done", stopReason: "end_turn" }]]);
}

function firstInputContent(provider: FakeProvider): string {
  const input = provider.requests[0]!.input;
  expect(input).toHaveLength(1);
  return (input[0] as { content: string }).content;
}

describe("Dreamer.tick", () => {
  test("1) event filtering: window carries only user_message/assistant_message/child_update text, never tool/reasoning/harness noise", async () => {
    const { store, dispatchId, dir } = setup("norma-dreamer-filter-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS - 3);
    store.append(dispatchId, { type: "user_message", sessionId: dispatchId, threadId: "main", text: "my name is Alex", clientName: "test" });
    store.append(dispatchId, { type: "assistant_message", sessionId: dispatchId, threadId: "main", text: "noted" });
    store.append(dispatchId, {
      type: "child_update", sessionId: dispatchId, threadId: "main", childSessionId: "s_child",
      status: "completed", title: "build the site", resultSummary: "built the site",
    });
    // Noise: none of this may leak into the window text.
    store.append(dispatchId, { type: "tool_call", sessionId: dispatchId, threadId: "main", callId: "c1", name: "bash", argsJson: "{}" });
    store.append(dispatchId, { type: "tool_result", sessionId: dispatchId, threadId: "main", callId: "c1", output: "SECRET_TOOL_OUTPUT", isError: false });
    store.append(dispatchId, { type: "reasoning_item", sessionId: dispatchId, threadId: "main", itemJson: '{"reasoning":"hidden chain of thought"}' });
    store.append(dispatchId, { type: "harness_attached", sessionId: dispatchId, clientName: "cli" });

    const provider = okProvider();
    const dreamer = new Dreamer({
      provider: { provider, model: "ignored" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 0,
    });
    await dreamer.tick();

    expect(provider.requests).toHaveLength(1);
    const content = firstInputContent(provider);
    expect(content).toContain("my name is Alex");
    expect(content).toContain("noted");
    expect(content).toContain("built the site");
    expect(content).not.toContain("SECRET_TOOL_OUTPUT");
    expect(content).not.toContain("reasoning");
    expect(content).not.toContain("harness_attached");
  });

  test("2) request shape: hardcoded model/effort, no tools, exact instruction text", async () => {
    const { store, dispatchId, dir } = setup("norma-dreamer-shape-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);

    const provider = okProvider();
    const dreamer = new Dreamer({
      provider: { provider, model: "some-other-model" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 0,
    });
    await dreamer.tick();

    expect(provider.requests).toHaveLength(1);
    const req = provider.requests[0]!;
    expect(req.model).toBe(DREAM_MODEL);
    expect(req.reasoningEffort).toBe(DREAM_EFFORT);
    expect(req.tools).toEqual([]);
    expect(req.instructions).toBe(DREAM_INSTRUCTION);
  });

  test("3) prompt carries state: memory file content, tombstones, and today's date (from injected now()) all appear", async () => {
    const { store, dispatchId, dir } = setup("norma-dreamer-state-");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "alex.md"), "Alex builds Norma.\n");
    writeFileSync(join(dir, "MEMORY.md"), "# Assistant memory index\n\n- [alex](alex.md) — Alex builds Norma.\n");
    writeFileSync(join(dir, "tombstones.md"), "- never remember the user's address\n");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);

    const fixedNow = new Date("2026-07-18T12:00:00Z").getTime();
    const provider = okProvider();
    const dreamer = new Dreamer({
      provider: { provider, model: "x" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 0, now: () => fixedNow,
    });
    await dreamer.tick();

    const content = firstInputContent(provider);
    expect(content).toContain("Alex builds Norma.");
    expect(content).toContain("never remember the user's address");
    expect(content).toContain("2026-07-18");
  });

  test("4) ops applied + watermark: write op lands on disk, MEMORY.md lists it, watermarkSeq === lastSeq, lastDreamAt === now()", async () => {
    const { store, dispatchId, dir } = setup("norma-dreamer-apply-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);

    const opsJson = JSON.stringify({
      ops: [{ op: "write", file: "alex.md", content: "---\nrevised: 2026-07-18\n---\nAlex builds Norma." }],
    });
    const fixedNow = 1_753_000_000_000;
    const provider = okProvider(opsJson);
    const dreamer = new Dreamer({
      provider: { provider, model: "x" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 0, now: () => fixedNow,
    });
    await dreamer.tick();

    expect(readFileSync(join(dir, "alex.md"), "utf8")).toBe("---\nrevised: 2026-07-18\n---\nAlex builds Norma.");
    expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toContain("alex.md");
    const state = JSON.parse(readFileSync(join(dir, "dream-state.json"), "utf8")) as { watermarkSeq: number; lastDreamAt: number };
    expect(state.watermarkSeq).toBe(store.lastSeq(dispatchId));
    expect(state.lastDreamAt).toBe(fixedNow);
  });

  test("5) empty ops is a valid dream: no memory content file written, watermark still advances", async () => {
    const { store, dispatchId, dir } = setup("norma-dreamer-empty-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);

    const provider = okProvider('{"ops":[]}');
    const dreamer = new Dreamer({
      provider: { provider, model: "x" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 0,
    });
    await dreamer.tick();

    const filesAfter = existsSync(dir) ? readdirSync(dir) : [];
    expect(filesAfter.filter((f) => f.endsWith(".md") && f !== "MEMORY.md")).toHaveLength(0);
    const state = JSON.parse(readFileSync(join(dir, "dream-state.json"), "utf8")) as { watermarkSeq: number; lastDreamAt: number };
    expect(state.watermarkSeq).toBe(store.lastSeq(dispatchId));
  });

  test("6) malformed (no JSON) response: watermark not advanced, no files written, tick does not throw", async () => {
    const { store, dispatchId, dir } = setup("norma-dreamer-malformed-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);

    const provider = okProvider("I have nothing worth keeping today.");
    const dreamer = new Dreamer({
      provider: { provider, model: "x" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 0,
    });
    await expect(dreamer.tick()).resolves.toBeUndefined();
    expect(existsSync(join(dir, "dream-state.json"))).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  test("7) invalid ops (13 ops, over MAX_OPS): watermark not advanced", async () => {
    const { store, dispatchId, dir } = setup("norma-dreamer-invalidops-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);

    const tooMany = { ops: Array.from({ length: 13 }, (_, i) => ({ op: "tombstone", text: `t${i}` })) };
    const provider = okProvider(JSON.stringify(tooMany));
    const dreamer = new Dreamer({
      provider: { provider, model: "x" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 0,
    });
    await dreamer.tick();

    expect(existsSync(join(dir, "dream-state.json"))).toBe(false);
  });

  test("8) window cap: transcript is trimmed to DREAM_WINDOW_MAX_CHARS, marked, and drops the OLDEST content first", async () => {
    const { store, dispatchId, dir } = setup("norma-dreamer-cap-");
    const big = "x".repeat(5000);
    for (let i = 0; i < 50; i++) {
      store.append(dispatchId, { type: "user_message", sessionId: dispatchId, threadId: "main", text: `${big}-${i}`, clientName: "test" });
    }

    const provider = okProvider();
    const dreamer = new Dreamer({
      provider: { provider, model: "x" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 0,
    });
    await dreamer.tick();

    const content = firstInputContent(provider);
    expect(content).toContain("[earlier events trimmed]");
    // Well under the raw ~250,000 chars of seeded messages -> the cap actually took effect.
    expect(content.length).toBeLessThan(DREAM_WINDOW_MAX_CHARS + 1000);
    // Oldest trimmed away, newest survives -> trims OLDEST, not newest.
    expect(content).not.toContain(`${big}-0`);
    expect(content).toContain(`${big}-49`);
  });
});
