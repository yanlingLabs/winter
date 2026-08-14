import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry, type ToolContext } from "../../src/agent/tools/registry";
import { registerWriteTools } from "../../src/agent/tools/fs-write";
import { registerNotebookTool } from "../../src/agent/tools/notebook";
import { writeDiff, readStoredDiff, diffDirPath, type DiffHeader } from "../../src/diffs/store";
import { FakeProvider } from "../../src/agent/fake-provider";
import { setupEngine } from "./engine-steer.test";

// diff-tabs Task 6: edit/write/notebook_edit actually computing, persisting, and reporting
// per-edit diffs (myers.ts/store.ts/registry.ts's fileDiff channel are Tasks 1/2/5, already
// shipped). `ctx.diffSink` is built here the same way engine.ts's executeCall would build it in
// production (bound to one sessionId, backed by the REAL diffs/store.ts `writeDiff` — not a
// mock), so a store failure test (below) exercises the actual on-disk failure path, not a stub.

function setup(sessionId = "s1"): { r: ToolRegistry; d: string; home: string; ctx: ToolContext } {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "norma-fdiff-")));
  const home = mkdtempSync(join(tmpdir(), "norma-fdiff-home-"));
  const r = new ToolRegistry();
  registerWriteTools(r);
  registerNotebookTool(r);
  const diffSink = (diffId: string, header: Omit<DiffHeader, "truncated">, patch: string) =>
    writeDiff(home, sessionId, diffId, header, patch);
  const ctx: ToolContext = { cwd: d, roots: [d], sessionId, diffSink };
  return { r, d, home, ctx };
}

describe("write: diff computation + persistence", () => {
  test("new file → fileDiff {removed:0, added:lineCount}, patch on disk, header round-trips, output ends (-0 +N)", async () => {
    const { r, home, ctx } = setup();
    const content = "line1\nline2\nline3\n";
    const res = await r.execute("write", { path: "new.txt", content }, ctx);
    expect(res.isError).toBe(false);
    expect(res.fileDiff).toBeDefined();
    expect(res.fileDiff!.path).toBe("new.txt");
    expect(res.fileDiff!.added).toBe(3);
    expect(res.fileDiff!.removed).toBe(0);
    expect(res.output.endsWith("(-0 +3)")).toBe(true);

    // patch file exists at the store path
    const dir = diffDirPath(home, "s1");
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir)).toContain(`${res.fileDiff!.diffId}.diff`);

    // header round-trips
    const stored = await readStoredDiff(home, "s1", res.fileDiff!.diffId);
    expect(stored).not.toBeNull();
    expect(stored!.header).toEqual({ path: "new.txt", added: 3, removed: 0, truncated: false });
  });

  test("overwrite → both counts > 0, patch contains the old first line as a removal", async () => {
    const { r, d, home, ctx } = setup();
    writeFileSync(join(d, "o.txt"), "alpha\nbeta\n");
    const res = await r.execute("write", { path: "o.txt", content: "ALPHA\nbeta\n" }, ctx);
    expect(res.isError).toBe(false);
    expect(res.fileDiff).toBeDefined();
    expect(res.fileDiff!.added).toBeGreaterThan(0);
    expect(res.fileDiff!.removed).toBeGreaterThan(0);
    const stored = await readStoredDiff(home, "s1", res.fileDiff!.diffId);
    expect(stored!.patch).toContain("-alpha");
  });

  test("no-op (identical content) → plain string, no fileDiff, no patch file", async () => {
    const { r, d, home, ctx } = setup();
    writeFileSync(join(d, "same.txt"), "same content\n");
    const res = await r.execute("write", { path: "same.txt", content: "same content\n" }, ctx);
    expect(res.isError).toBe(false);
    expect(res.output).toBe("wrote 13 bytes to same.txt");
    expect(Object.hasOwn(res, "fileDiff")).toBe(false);
    expect(existsSync(diffDirPath(home, "s1"))).toBe(false);
  });

  test("exact confirmation string format", async () => {
    const { r, ctx } = setup();
    const res = await r.execute("write", { path: "hello.txt", content: "abc\n" }, ctx);
    expect(res.output).toBe("wrote 4 bytes to hello.txt (-0 +1)");
  });
});

describe("edit: diff computation + persistence", () => {
  test("replace → counts match, exact output 'edited <path> (-1 +1)'", async () => {
    const { r, d, ctx } = setup();
    writeFileSync(join(d, "f.txt"), "one two three\n");
    const res = await r.execute("edit", { path: "f.txt", old_string: "two", new_string: "TWO" }, ctx);
    expect(res.isError).toBe(false);
    expect(res.output).toBe("edited f.txt (-1 +1)");
    expect(res.fileDiff).toMatchObject({ path: "f.txt", added: 1, removed: 1 });
    expect(typeof res.fileDiff!.diffId).toBe("string");
  });

  test("diff-store failure (read-only diffs home) → edit still succeeds, plain string, no fileDiff", async () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "norma-fdiff-target-")));
    writeFileSync(join(d, "g.txt"), "one\n");
    const roHome = mkdtempSync(join(tmpdir(), "norma-fdiff-ro-"));
    chmodSync(roHome, 0o555); // read+execute only — mkdirSync(recursive) inside writeDiff must EACCES
    const r = new ToolRegistry();
    registerWriteTools(r);
    const ctx: ToolContext = {
      cwd: d,
      roots: [d],
      sessionId: "s1",
      diffSink: (diffId, header, patch) => writeDiff(roHome, "s1", diffId, header, patch),
    };
    try {
      const res = await r.execute("edit", { path: "g.txt", old_string: "one", new_string: "two" }, ctx);
      expect(res.isError).toBe(false);
      expect(res.output).toBe("edited g.txt");
      expect(Object.hasOwn(res, "fileDiff")).toBe(false);
      expect(readFileSync(join(d, "g.txt"), "utf8")).toBe("two\n"); // mutation still happened
    } finally {
      chmodSync(roHome, 0o755); // restore so tmpdir cleanup doesn't hit EACCES
    }
  });
});

describe("notebook_edit: diff computation + persistence", () => {
  test("replace on a markdown cell's source → fileDiff present, counts > 0, exact confirmation string", async () => {
    const { r, d, ctx } = setup();
    // Deliberately minimal: ONE cell, markdown (no outputs/execution_count fields to begin with,
    // so `replace`'s delete-if-not-code branch is a no-op and touches no other key), single-line
    // source. Every JSON line except that one source string is byte-identical before/after —
    // hand-verifiable removed=1/added=1 regardless of json indentation specifics.
    const nb = { cells: [{ id: "c1", cell_type: "markdown", source: ["# Old\n"], metadata: {} }], metadata: {}, nbformat: 4, nbformat_minor: 5 };
    writeFileSync(join(d, "n.ipynb"), JSON.stringify(nb, null, 1) + "\n");
    const res = await r.execute("notebook_edit", { notebook_path: "n.ipynb", cell_id: "c1", new_source: "# New\n" }, ctx);
    expect(res.isError).toBe(false);
    expect(res.fileDiff).toMatchObject({ path: "n.ipynb", added: 1, removed: 1 });
    expect(res.output).toBe("notebook_edit replace on n.ipynb (cell c1) — 1 cells (-1 +1)");
  });
});

// -------------------------------------------------------------------------------------------
// Engine-level: the seam Task 6 alone adds — EngineConfig.persistDiff → executeCall's per-call
// `ctx.diffSink` binding (engine.ts) → a REAL `write` tool call. Task 5's registry-file-diff.
// test.ts already proves a fake tool's fileDiff rides the tool_result event; every test above
// proves the tools produce fileDiff given a ctx-level diffSink. Neither exercises the binding
// itself — in `persistDiff(sessionId, diffId, header, patch)` both leading params are strings, so
// a transposition there would compile and pass both of those test layers while silently storing
// every diff under the wrong session (readStoredDiff below reads back by the SAME sessionId the
// event reports, so a swap makes this assertion fail rather than the bug going unnoticed).
// -------------------------------------------------------------------------------------------
describe("engine: cfg.persistDiff reaches the real store through a live `write` call (Task 6)", () => {
  test("tool_result.fileDiff is stamped AND the patch is retrievable under the reported sessionId", async () => {
    const diffHome = mkdtempSync(join(tmpdir(), "norma-fdiff-engine-home-"));
    const provider = new FakeProvider([
      [{ type: "tool_call", callId: "c1", name: "write", argsJson: JSON.stringify({ path: "out.txt", content: "a\nb\n" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }],
    ]);
    const { engine, sessionId, events } = setupEngine(provider, { policy: "bypass", diffHome });
    await engine.runTurn(sessionId);
    const toolResult = events.find((e) => e.type === "tool_result") as { isError: boolean; fileDiff?: { path: string; added: number; removed: number; diffId: string } } | undefined;
    expect(toolResult).toBeDefined();
    expect(toolResult!.isError).toBe(false);
    expect(toolResult!.fileDiff).toBeDefined();
    expect(toolResult!.fileDiff!.added).toBe(2);
    expect(toolResult!.fileDiff!.removed).toBe(0);
    // Retrievable under the SAME sessionId the event itself reports — this is what would fail if
    // executeCall's persistDiff→diffSink binding ever transposed sessionId/diffId (see above).
    const stored = await readStoredDiff(diffHome, sessionId, toolResult!.fileDiff!.diffId);
    expect(stored).not.toBeNull();
    expect(stored!.header).toEqual({ path: "out.txt", added: 2, removed: 0, truncated: false });
  });
});
