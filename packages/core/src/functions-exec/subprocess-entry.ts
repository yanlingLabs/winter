import { NdjsonDecoder, encodeNdjsonFrame } from "./ndjson";
import { assertParentToWorkerFrame, type CellFrame, type ParentToWorkerFrame, type WorkerToParentFrame } from "./protocol";
import { createWorkerHelpers } from "./worker-api";

export const FUNCTIONS_EXEC_WORKER_ARGUMENT = "__functions-exec-worker";

export function isFunctionsExecWorkerInvocation(argv: readonly string[]): boolean {
  return argv.length === 1 && argv[0] === FUNCTIONS_EXEC_WORKER_ARGUMENT;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedError(error: unknown): string {
  return errorMessage(error).slice(0, 192);
}

type AsyncCell = (tools: ReturnType<typeof createWorkerHelpers>) => Promise<void>;

function compileCell(source: string): AsyncCell {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (name: string, source: string) => AsyncCell;
  return new AsyncFunction("tools", `"use strict";\n${source}`);
}

export async function executeFunctionsExecWorkerCell(
  frame: Extract<ParentToWorkerFrame, { type: "execute" }>,
  post: (frame: WorkerToParentFrame) => void,
): Promise<void> {
  const postCell = (cell: CellFrame): void => post({ type: "cell", cellId: frame.cellId, frame: cell });
  const tools = Object.freeze(createWorkerHelpers({ emit: postCell }));
  await compileCell(frame.source)(tools);
  post({ type: "completed", cellId: frame.cellId });
}

/** Runs only inside the worker subprocess. The parent chooses when that process is born and wraps
 * it in Seatbelt; this module itself never grants filesystem, network, or process capabilities. */
export function runFunctionsExecSubprocess(): void {
  const decoder = new NdjsonDecoder(assertParentToWorkerFrame);
  let started = false;
  let ending = false;
  const post = (frame: WorkerToParentFrame): void => {
    process.stdout.write(encodeNdjsonFrame(frame));
  };
  const terminate = (status: number): void => {
    if (ending) return;
    ending = true;
    setTimeout(() => process.exit(status), 10);
  };

  const fail = (message: string): void => {
    post({ type: "fatal", code: "invalid_frame", message: boundedError(message) });
    terminate(1);
  };

  process.stdin.on("data", (chunk: Buffer) => {
    if (started) return;
    const result = decoder.push(new Uint8Array(chunk));
    if (!result.ok) {
      fail(result.fatal.message);
      return;
    }
    for (const frame of result.frames) {
      if (frame.type !== "execute" || started) {
        fail("functions.exec worker expected one execute frame");
        return;
      }
      started = true;
      post({ type: "ready" });
      void executeFunctionsExecWorkerCell(frame, post).then(
        () => terminate(0),
        (error) => fail(boundedError(error)),
      );
    }
  });
  process.stdin.on("end", () => {
    if (started) return;
    const result = decoder.finish();
    if (!result.ok) fail(result.fatal.message);
    else fail("functions.exec worker ended before execute");
  });
  process.stdin.resume();
}

if (import.meta.main) runFunctionsExecSubprocess();
