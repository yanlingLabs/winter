import { describe, expect, test } from "bun:test";
import { FunctionsExecCells } from "../../src/functions-exec/cells";
import { ImageDetail, type CellFrame } from "../../src/functions-exec/protocol";
import type { FunctionsExecRuntimeResult } from "../../src/functions-exec/runtime";

function completed(cellId: string): FunctionsExecRuntimeResult {
  return { status: "completed", cellId, frames: [] };
}

describe("functions-exec cell lifecycle", () => {
  test("delivers a yield checkpoint then the terminal checkpoint without retaining media or notifications", async () => {
    const cells = new FunctionsExecCells();
    let complete!: (result: FunctionsExecRuntimeResult) => void;
    const live: CellFrame[] = [];
    const cellId = cells.start({
      sessionId: "s1",
      run: () => new Promise((resolve) => { complete = resolve; }),
      cancel: () => {},
      onFrame: (_sessionId, _cellId, frame) => live.push(frame),
    });

    cells.recordFrame("s1", cellId, { type: "text", text: "first" });
    cells.recordFrame("s1", cellId, { type: "image", dataUrl: "data:image/png;base64,AA==", detail: ImageDetail.Auto });
    cells.recordFrame("s1", cellId, { type: "notification", text: "working" });
    cells.recordFrame("s1", cellId, { type: "yield" });
    expect(await cells.next("s1", cellId)).toEqual({ status: "yielded", output: "first" });

    cells.recordFrame("s1", cellId, { type: "text", text: "second" });
    complete(completed(cellId));
    expect(await cells.next("s1", cellId)).toEqual({ status: "completed", output: "first\nsecond" });
    expect(live).toEqual([
      { type: "text", text: "first" },
      { type: "image", dataUrl: "data:image/png;base64,AA==", detail: ImageDetail.Auto },
      { type: "notification", text: "working" },
      { type: "yield" },
      { type: "text", text: "second" },
    ]);
    await expect(cells.next("s1", cellId)).rejects.toThrow("unknown functions.exec cell");
  });

  test("keeps the next checkpoint bounded even when a worker emits many text frames", async () => {
    const cells = new FunctionsExecCells();
    let complete!: (result: FunctionsExecRuntimeResult) => void;
    const cellId = cells.start({
      sessionId: "s1",
      run: () => new Promise((resolve) => { complete = resolve; }),
      cancel: () => {},
    });
    for (let index = 0; index < 8; index += 1) {
      cells.recordFrame("s1", cellId, { type: "text", text: "x".repeat(256) });
    }
    cells.recordFrame("s1", cellId, { type: "yield" });
    const checkpoint = await cells.next("s1", cellId);
    expect(checkpoint.status).toBe("yielded");
    expect(Buffer.byteLength(checkpoint.output, "utf8")).toBeLessThanOrEqual(256);
    complete(completed(cellId));
    await cells.next("s1", cellId);
  });

  test("makes wait available only after a yield or terminal checkpoint", async () => {
    const cells = new FunctionsExecCells();
    let complete!: (result: FunctionsExecRuntimeResult) => void;
    const cellId = cells.start({
      sessionId: "s1",
      run: () => new Promise((resolve) => { complete = resolve; }),
      cancel: () => {},
    });
    expect(cells.canWait("s1", cellId)).toBe(false);
    cells.recordFrame("s1", cellId, { type: "yield" });
    expect(cells.canWait("s1", cellId)).toBe(true);
    await cells.next("s1", cellId);
    expect(cells.canWait("s1", cellId)).toBe(true);
    complete(completed(cellId));
    await cells.next("s1", cellId);
  });

  test("cancels and removes a live cell when its turn is interrupted", async () => {
    const cells = new FunctionsExecCells();
    let cancelled = 0;
    const cellId = cells.start({
      sessionId: "s1",
      run: () => new Promise(() => {}),
      cancel: () => { cancelled += 1; },
    });
    const waiting = cells.next("s1", cellId);
    expect(cells.cancel("s1", cellId)).toBe(true);
    expect(cancelled).toBe(1);
    expect(cells.cancel("s1", cellId)).toBe(false);
    await expect(waiting).rejects.toThrow("interrupted");
    await expect(cells.next("s1", cellId)).rejects.toThrow("unknown functions.exec cell");
  });

  test("fails closed if a runner tries to complete a different cell", async () => {
    const cells = new FunctionsExecCells();
    const cellId = cells.start({
      sessionId: "s1",
      run: async () => completed("other-cell"),
      cancel: () => {},
    });
    await expect(cells.next("s1", cellId)).resolves.toEqual({
      status: "failed",
      output: "",
      error: "functions.exec runtime completed another cell",
    });
  });

  test("does not let a session observe another session's cell", async () => {
    const cells = new FunctionsExecCells();
    const cellId = cells.start({
      sessionId: "s1",
      run: async (id) => completed(id),
      cancel: () => {},
    });
    await expect(cells.next("s2", cellId)).rejects.toThrow("belongs to another session");
    await cells.next("s1", cellId);
  });

  test("cancels every live cell in an interrupted session and clears removal callbacks", () => {
    const cells = new FunctionsExecCells();
    let cancelled = 0;
    const removed: string[] = [];
    for (const sessionId of ["s1", "s1", "s2"]) {
      cells.start({
        sessionId,
        run: () => new Promise(() => {}),
        cancel: () => { cancelled += 1; },
        onRemoved: (_sessionId, cellId) => removed.push(cellId),
      });
    }
    cells.cancelSession("s1");
    expect(cancelled).toBe(2);
    expect(removed).toHaveLength(2);
  });

  test("caps live cells across sessions as well as within one session", () => {
    const cells = new FunctionsExecCells();
    const ids: Array<{ sessionId: string; cellId: string }> = [];
    for (let index = 0; index < 32; index += 1) {
      const sessionId = `session-${Math.floor(index / 8)}`;
      const cellId = cells.start({
        sessionId,
        run: async () => await new Promise<FunctionsExecRuntimeResult>(() => {}),
        cancel: () => {},
      });
      ids.push({ sessionId, cellId });
    }

    expect(() => cells.start({
      sessionId: "overflow",
      run: async () => await new Promise<FunctionsExecRuntimeResult>(() => {}),
      cancel: () => {},
    })).toThrow(/too many live/i);
    for (const { sessionId, cellId } of ids) cells.cancel(sessionId, cellId);
  });
});
