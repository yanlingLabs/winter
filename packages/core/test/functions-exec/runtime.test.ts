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
