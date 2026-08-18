import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatchFunctionsExecAlias } from "./aliases";
import { NdjsonDecoder, encodeNdjsonFrame } from "./ndjson";
import { assertWorkerToParentFrame, type CellFrame, type JsonValue, type NestedToolName } from "./protocol";
import { buildFunctionsExecSeatbeltProfile, functionsExecSandboxAvailable } from "./sandbox";
import { FUNCTIONS_EXEC_WORKER_ARGUMENT } from "./subprocess-entry";

export interface FunctionsExecWorkerCommand {
  file: string;
  args: string[];
  runtimePaths: string[];
}

export interface FunctionsExecRuntimeInput {
  sessionId: string;
  cellId: string;
  source: string;
  protectedRoots: readonly string[];
  timeoutMs?: number;
}

export interface FunctionsExecNestedCall {
  sessionId: string;
  cellId: string;
  callId: string;
  name: NestedToolName;
  args: JsonValue;
}

export type FunctionsExecRuntimeResult =
  | { status: "completed"; cellId: string; frames: CellFrame[] }
  | { status: "failed"; cellId: string; frames: CellFrame[]; error: string };

export interface FunctionsExecRuntimeDeps {
  workerCommand?: () => FunctionsExecWorkerCommand;
  onFrame?: (sessionId: string, cellId: string, frame: CellFrame) => void;
  callTool?: (call: FunctionsExecNestedCall) => Promise<JsonValue>;
  platform?: NodeJS.Platform;
  hasSeatbelt?: boolean;
}

/** The engine-facing worker contract, kept narrow so alternate process hosts can preserve the same bridge. */
export interface FunctionsExecRuntimeBridge {
  cancel(sessionId: string, cellId: string): boolean;
  execute(input: FunctionsExecRuntimeInput): Promise<FunctionsExecRuntimeResult>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;

/** Resolves the actual executable for both source execution and a Bun-compiled Norma binary. */
export function defaultFunctionsExecWorkerCommand(bunMain: string = Bun.main): FunctionsExecWorkerCommand {
  if (bunMain.includes("/$bunfs/")) {
    return { file: process.execPath, args: [FUNCTIONS_EXEC_WORKER_ARGUMENT], runtimePaths: [] };
  }
  const entry = fileURLToPath(new URL("./subprocess-entry.ts", import.meta.url));
  return { file: process.execPath, args: [entry], runtimePaths: [dirname(entry)] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function activeKey(sessionId: string, cellId: string): string {
  return sessionId + "\u0000" + cellId;
}

export class FunctionsExecRuntime implements FunctionsExecRuntimeBridge {
  private readonly active = new Map<string, () => void>();

  constructor(private readonly deps: FunctionsExecRuntimeDeps = {}) {}

  cancel(sessionId: string, cellId: string): boolean {
    const cancel = this.active.get(activeKey(sessionId, cellId));
    if (!cancel) return false;
    cancel();
    return true;
  }

  execute(input: FunctionsExecRuntimeInput): Promise<FunctionsExecRuntimeResult> {
    const frames: CellFrame[] = [];
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
      return Promise.resolve({ status: "failed", cellId: input.cellId, frames, error: "timeout must be an integer between 1 and " + MAX_TIMEOUT_MS + " ms" });
    }
    if (!functionsExecSandboxAvailable(this.deps.platform, this.deps.hasSeatbelt)) {
      return Promise.resolve({ status: "failed", cellId: input.cellId, frames, error: "functions.exec is unavailable on this platform" });
    }
    if (input.protectedRoots.length === 0) {
      return Promise.resolve({ status: "failed", cellId: input.cellId, frames, error: "functions.exec requires protected roots" });
    }

    const command = this.deps.workerCommand?.() ?? defaultFunctionsExecWorkerCommand();
    let profile: string;
    try {
      profile = buildFunctionsExecSeatbeltProfile({
        workerExecutable: command.file,
        runtimePaths: command.runtimePaths,
        protectedRoots: input.protectedRoots,
      });
    } catch (error) {
      return Promise.resolve({ status: "failed", cellId: input.cellId, frames, error: errorMessage(error) });
    }

    return new Promise((resolve) => {
      const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, command.file, ...command.args], {
        cwd: dirname(command.file),
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: "/tmp" },
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const decoder = new NdjsonDecoder(assertWorkerToParentFrame);
      const key = activeKey(input.sessionId, input.cellId);
      const pendingCalls = new Set<string>();
      const seenCallIds = new Set<string>();
      let workerCompleted = false;
      let settled = false;
      let stderr = "";
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stop = (): void => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const finish = (result: FunctionsExecRuntimeResult): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        this.active.delete(key);
        stop();
        resolve(result);
      };
      const fail = (error: string): void => {
        finish({ status: "failed", cellId: input.cellId, frames, error: error.slice(0, 256) });
      };
      const write = (frame: Parameters<typeof encodeNdjsonFrame>[0]): boolean => {
        if (settled) return false;
        try {
          child.stdin.write(encodeNdjsonFrame(frame));
          return true;
        } catch (error) {
          fail("functions.exec worker stdin failed: " + errorMessage(error));
          return false;
        }
      };
      const maybeComplete = (): void => {
        if (workerCompleted && pendingCalls.size === 0) {
          finish({ status: "completed", cellId: input.cellId, frames });
        }
      };
      const serviceCall = (call: Extract<ReturnType<typeof assertWorkerToParentFrame>, { type: "call" }>): void => {
        if (call.cellId !== input.cellId || seenCallIds.has(call.callId)) {
          fail("functions.exec worker sent an invalid nested tool call");
          return;
        }
        seenCallIds.add(call.callId);
        pendingCalls.add(call.callId);
        const dispatch = this.deps.callTool;
        if (!dispatch) {
          write({ type: "tool_result", cellId: input.cellId, callId: call.callId, result: "nested tools are unavailable", isError: true });
          pendingCalls.delete(call.callId);
          maybeComplete();
          return;
        }
        void dispatchFunctionsExecAlias(call.name, call.args, (name, args) => dispatch({
          sessionId: input.sessionId,
          cellId: input.cellId,
          callId: call.callId,
          name,
          args,
        })).then(
          (result) => { write({ type: "tool_result", cellId: input.cellId, callId: call.callId, result, isError: false }); },
          (error) => { write({ type: "tool_result", cellId: input.cellId, callId: call.callId, result: errorMessage(error).slice(0, 128), isError: true }); },
        ).finally(() => {
          pendingCalls.delete(call.callId);
          maybeComplete();
        });
      };

      timer = setTimeout(() => fail("functions.exec timed out after " + timeoutMs + " ms"), timeoutMs);
      this.active.set(key, () => fail("functions.exec cancelled"));
      child.on("error", (error) => fail("functions.exec worker failed to spawn: " + error.message));
      child.stdin.on("error", (error) => fail("functions.exec worker stdin failed: " + error.message));
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 256) stderr += chunk.toString("utf8").slice(0, 256 - stderr.length);
      });
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        const result = decoder.push(new Uint8Array(chunk));
        if (!result.ok) {
          fail("functions.exec worker protocol failure: " + result.fatal.code);
          return;
        }
        for (const frame of result.frames) {
          if (frame.type === "fatal") {
            fail("functions.exec worker failed: " + frame.message);
            return;
          }
          if (frame.type === "call") {
            serviceCall(frame);
            continue;
          }
          if (frame.type === "cell") {
            if (frame.cellId !== input.cellId) {
              fail("functions.exec worker sent a frame for another cell");
              return;
            }
            frames.push(frame.frame);
            this.deps.onFrame?.(input.sessionId, input.cellId, frame.frame);
            continue;
          }
          if (frame.type === "completed") {
            if (frame.cellId !== input.cellId) {
              fail("functions.exec worker completed another cell");
              return;
            }
            workerCompleted = true;
            maybeComplete();
          }
        }
      });
      child.on("close", (code) => {
        if (settled) return;
        const result = decoder.finish();
        if (!result.ok) fail("functions.exec worker protocol failure: " + result.fatal.code);
        else fail("functions.exec worker exited (" + (code ?? "signal") + ")" + (stderr.trim() ? ": " + stderr.trim() : ""));
      });
      write({ type: "execute", cellId: input.cellId, source: input.source });
    });
  }
}
