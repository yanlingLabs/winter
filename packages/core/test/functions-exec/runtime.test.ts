import { describe, expect, test } from "bun:test";
import { FunctionsExecRuntime, defaultFunctionsExecWorkerCommand } from "../../src/functions-exec/runtime";
import { executeFunctionsExecWorkerCell, isFunctionsExecWorkerInvocation } from "../../src/functions-exec/subprocess-entry";
import type { WorkerToParentFrame } from "../../src/functions-exec/protocol";

describe("functions-exec worker routing", () => {
  test("selects the source entry in development and the exact sentinel in compiled binaries", () => {
    const development = defaultFunctionsExecWorkerCommand("/work/packages/core/test/runtime.test.ts");
    expect(development.file).toBe(process.execPath);
    expect(development.args).toHaveLength(1);
    expect(development.args[0]).toEndWith("subprocess-entry.ts");
    expect(development.runtimePaths).toHaveLength(1);

    expect(defaultFunctionsExecWorkerCommand("/$bunfs/root/main.ts")).toEqual({
      file: process.execPath,
      args: ["__functions-exec-worker"],
      runtimePaths: [],
    });
    expect(isFunctionsExecWorkerInvocation(["__functions-exec-worker"])).toBe(true);
    expect(isFunctionsExecWorkerInvocation(["-p", "__functions-exec-worker"])).toBe(false);
    expect(isFunctionsExecWorkerInvocation(["__functions-exec-worker", "extra"])).toBe(false);
  });

  test("executes only the constrained helper surface inside the worker entry", async () => {
    const frames: WorkerToParentFrame[] = [];
    await executeFunctionsExecWorkerCell({
      type: "execute",
      cellId: "cell-1",
      source: 'tools.text("ready"); tools.notify("progress"); await tools.yield();',
    }, (frame) => frames.push(frame));

    expect(frames).toEqual([
      { type: "cell", cellId: "cell-1", frame: { type: "text", text: "ready" } },
      { type: "cell", cellId: "cell-1", frame: { type: "notification", text: "progress" } },
      { type: "cell", cellId: "cell-1", frame: { type: "yield" } },
      { type: "completed", cellId: "cell-1" },
    ]);
  });

  test("bridges only bounded aliases and waits for unawaited nested calls before completing", async () => {
    const calls: unknown[] = [];
    const frames: WorkerToParentFrame[] = [];
    await executeFunctionsExecWorkerCell({
      type: "execute",
      cellId: "cell-1",
      source: 'tools.bash({command: "pwd"}); const page = await tools.read({path: "README.md"}); tools.text(page);',
    }, (frame) => frames.push(frame), async (name, args) => {
      calls.push({ name, args });
      return name === "read" ? "read-result" : "bash-result";
    });

    expect(calls).toEqual([
      { name: "bash", args: { command: "pwd" } },
      { name: "read", args: { path: "README.md" } },
    ]);
    expect(frames).toEqual([
      { type: "cell", cellId: "cell-1", frame: { type: "text", text: "read-result" } },
      { type: "completed", cellId: "cell-1" },
    ]);
  });

  test("fails the cell when unawaited nested calls exceed the fixed bridge limit", async () => {
    await expect(executeFunctionsExecWorkerCell({
      type: "execute",
      cellId: "cell-1",
      source: 'tools.bash({command:"1"});tools.bash({command:"2"});tools.bash({command:"3"});tools.bash({command:"4"});tools.bash({command:"5"});',
    }, () => {}, async () => "ok")).rejects.toThrow(/nested tool-call limit/i);
  });

  test("fails closed without macOS Seatbelt before spawning a worker", async () => {
    const runtime = new FunctionsExecRuntime({ platform: "linux", hasSeatbelt: true });
    await expect(runtime.execute({
      sessionId: "session-1",
      cellId: "cell-1",
      source: 'tools.text("never runs")',
      protectedRoots: ["/workspace"],
    })).resolves.toEqual({
      status: "failed",
      cellId: "cell-1",
      frames: [],
      error: "functions.exec is unavailable on this platform",
    });
  });
});
