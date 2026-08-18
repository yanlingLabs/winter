import { NdjsonDecoder, encodeNdjsonFrame } from "./ndjson";
import {
  assertParentToWorkerFrame,
  type CellFrame,
  type JsonValue,
  type NestedToolName,
  type ParentToWorkerFrame,
  type WorkerToParentFrame,
} from "./protocol";
import { createWorkerHelpers, type WorkerHelpers } from "./worker-api";

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

type NestedCaller = (name: NestedToolName, args: JsonValue) => Promise<JsonValue>;
type WorkerTools = WorkerHelpers & Record<NestedToolName, (args: JsonValue) => Promise<JsonValue>>;
type AsyncCell = (tools: WorkerTools) => Promise<void>;
const MAX_NESTED_CALLS = 4;

function compileCell(source: string): AsyncCell {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (name: string, source: string) => AsyncCell;
  return new AsyncFunction("tools", "\"use strict\";\n" + source);
}

function toolSurface(helpers: WorkerHelpers, callTool: NestedCaller | undefined): WorkerTools {
  if (!callTool) return Object.freeze(helpers) as WorkerTools;
  const call = (name: NestedToolName) => (args: JsonValue): Promise<JsonValue> => callTool(name, args);
  return Object.freeze({
    ...helpers,
    bash: call("bash"),
    edit: call("edit"),
    read: call("read"),
    web_fetch: call("web_fetch"),
    web_search: call("web_search"),
  });
}

export async function executeFunctionsExecWorkerCell(
  frame: Extract<ParentToWorkerFrame, { type: "execute" }>,
  post: (frame: WorkerToParentFrame) => void,
  callTool?: NestedCaller,
): Promise<void> {
  const postCell = (cell: CellFrame): void => post({ type: "cell", cellId: frame.cellId, frame: cell });
  const helpers = createWorkerHelpers({ emit: postCell });
  const issued = new Set<Promise<JsonValue>>();
  let calls = 0;
  let callLimitError: Error | undefined;
  const trackedCall = callTool === undefined ? undefined : (name: NestedToolName, args: JsonValue): Promise<JsonValue> => {
    if (calls >= MAX_NESTED_CALLS) {
      callLimitError ??= new RangeError("functions.exec exceeded its nested tool-call limit");
      const rejected = Promise.reject<JsonValue>(callLimitError);
      issued.add(rejected);
      void rejected.catch(() => {});
      return rejected;
    }
    calls += 1;
    const request = callTool(name, args);
    issued.add(request);
    return request;
  };
  await compileCell(frame.source)(toolSurface(helpers, trackedCall));
  await Promise.allSettled(issued);
  if (callLimitError !== undefined) throw callLimitError;
  post({ type: "completed", cellId: frame.cellId });
}

interface DeferredCall {
  resolve(value: JsonValue): void;
}

/** Runs only inside the worker subprocess. The parent supplies nested call results over the same
 * bounded NDJSON bridge; JavaScript itself remains confined by the parent-created Seatbelt process. */
export function runFunctionsExecSubprocess(): void {
  const decoder = new NdjsonDecoder(assertParentToWorkerFrame);
  const pending = new Map<string, DeferredCall>();
  let started = false;
  let ending = false;
  let nextCallId = 0;
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
  const callTool = (cellId: string, name: NestedToolName, args: JsonValue): Promise<JsonValue> => {
    const callId = "call-" + (++nextCallId);
    const request = new Promise<JsonValue>((resolve, reject) => {
      pending.set(callId, { resolve });
      try {
        post({ type: "call", cellId, callId, name, args });
      } catch (error) {
        pending.delete(callId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    void request.catch(() => {});
    return request;
  };

  process.stdin.on("data", (chunk: Buffer) => {
    const result = decoder.push(new Uint8Array(chunk));
    if (!result.ok) {
      fail(result.fatal.message);
      return;
    }
    for (const frame of result.frames) {
      if (frame.type === "tool_result") {
        const deferred = pending.get(frame.callId);
        if (!deferred) {
          fail("functions.exec worker received an unknown tool result");
          return;
        }
        pending.delete(frame.callId);
        deferred.resolve(frame.isError ? { error: frame.result } : frame.result);
        continue;
      }
      if (frame.type === "abort") {
        fail("functions.exec worker aborted");
        return;
      }
      if (frame.type !== "execute" || started) {
        fail("functions.exec worker expected one execute frame");
        return;
      }
      started = true;
      post({ type: "ready" });
      void executeFunctionsExecWorkerCell(frame, post, (name, args) => {
        const promise = callTool(frame.cellId, name, args);
        return promise;
      }).then(
        () => terminate(0),
        (error) => fail(boundedError(error)),
      );
    }
  });
  process.stdin.on("end", () => {
    if (started || ending) return;
    const result = decoder.finish();
    if (!result.ok) fail(result.fatal.message);
    else fail("functions.exec worker ended before execute");
  });
  process.stdin.resume();
}

if (import.meta.main) runFunctionsExecSubprocess();
