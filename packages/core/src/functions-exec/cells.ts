import { randomUUID } from "node:crypto";
import type { CellFrame } from "./protocol";
import type { FunctionsExecRuntimeResult } from "./runtime";

const MAX_CELLS_PER_SESSION = 8;
const MAX_CELLS = 32;
// A checkpoint is wrapped with a cell id and status before reaching provider input. Keep the
// combined text/error payload well below the 512-byte envelope limit from protocol.ts.
const MAX_CHECKPOINT_OUTPUT_BYTES = 256;
const MAX_CHECKPOINT_ERROR_BYTES = 96;
const encoder = new TextEncoder();

export type FunctionsExecCheckpoint =
  | { status: "yielded"; output: string }
  | { status: "completed"; output: string }
  | { status: "failed"; output: string; error: string };

type CellStatus = "running" | "yielded" | "completed" | "failed" | "cancelled";

interface FunctionsExecCell {
  cellId: string;
  sessionId: string;
  status: CellStatus;
  yielded: boolean;
  output: string;
  checkpoint?: FunctionsExecCheckpoint;
  waiters: Set<() => void>;
  cancel: () => void;
  onFrame?: (sessionId: string, cellId: string, frame: CellFrame) => void;
  onRemoved?: (sessionId: string, cellId: string) => void;
}

export interface StartFunctionsExecCell {
  sessionId: string;
  run: (cellId: string) => Promise<FunctionsExecRuntimeResult>;
  cancel: (cellId: string) => void;
  onFrame?: (sessionId: string, cellId: string, frame: CellFrame) => void;
  onRemoved?: (sessionId: string, cellId: string) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cap(value: string, maxBytes: number): string {
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let end = 0;
  for (const character of value) {
    const next = end + character.length;
    if (encoder.encode(value.slice(0, next)).byteLength > maxBytes) break;
    end = next;
  }
  return value.slice(0, end);
}

function outputAfter(current: string, next: string): string {
  return cap(current ? `${current}\n${next}` : next, MAX_CHECKPOINT_OUTPUT_BYTES);
}

/**
 * Engine-owned, in-memory lifecycle for a single functions.exec invocation.
 *
 * It deliberately has no source field, no durable media field, and no unbounded transcript. The
 * engine may forward frames to a live client, but only the compact text checkpoint is available to
 * the model through functions.exec/functions.wait.
 */
export class FunctionsExecCells {
  private readonly cells = new Map<string, FunctionsExecCell>();

  start(input: StartFunctionsExecCell): string {
    if (this.cells.size >= MAX_CELLS) {
      throw new Error("too many live functions.exec cells");
    }
    if (this.countForSession(input.sessionId) >= MAX_CELLS_PER_SESSION) {
      throw new Error("too many live functions.exec cells");
    }
    const cellId = `fx_${randomUUID()}`;
    const cell: FunctionsExecCell = {
      cellId,
      sessionId: input.sessionId,
      status: "running",
      yielded: false,
      output: "",
      waiters: new Set(),
      cancel: () => input.cancel(cellId),
      onFrame: input.onFrame,
      onRemoved: input.onRemoved,
    };
    this.cells.set(cellId, cell);
    // Defer the runner one microtask so the parent can retain the returned cell id and bind its
    // nested-tool dispatcher before a fast worker makes its first bridge call.
    void Promise.resolve().then(() => input.run(cellId)).then(
      (result) => this.finish(cellId, result),
      (error) => this.finish(cellId, {
        status: "failed",
        cellId,
        frames: [],
        error: cap(errorMessage(error), MAX_CHECKPOINT_ERROR_BYTES),
      }),
    );
    return cellId;
  }

  recordFrame(sessionId: string, cellId: string, frame: CellFrame): void {
    const cell = this.cells.get(cellId);
    if (!cell || cell.sessionId !== sessionId || cell.status === "cancelled") return;
    cell.onFrame?.(sessionId, cellId, frame);
    switch (frame.type) {
      case "text":
        cell.output = outputAfter(cell.output, frame.text);
        return;
      case "error":
        cell.output = outputAfter(cell.output, `${frame.code}: ${frame.message}`);
        return;
      case "yield":
        cell.status = "yielded";
        cell.yielded = true;
        this.publish(cell, { status: "yielded", output: cell.output });
        return;
      case "image":
      case "audio":
      case "notification":
        // These frames are intentionally forwarded only. Keeping them here would make media or
        // progress survive beyond the current live turn.
        return;
    }
  }

  canWait(sessionId: string, cellId: string): boolean {
    const cell = this.cells.get(cellId);
    return cell?.sessionId === sessionId && (cell.yielded || cell.checkpoint !== undefined);
  }

  hasWaitable(sessionId: string): boolean {
    for (const cell of this.cells.values()) {
      if (cell.sessionId === sessionId && (cell.yielded || cell.checkpoint !== undefined)) return true;
    }
    return false;
  }

  async next(sessionId: string, cellId: string, signal?: AbortSignal): Promise<FunctionsExecCheckpoint> {
    const cell = this.cellFor(sessionId, cellId);
    while (cell.checkpoint === undefined) {
      if (cell.status === "cancelled") throw new Error("functions execution interrupted");
      if (signal?.aborted) throw new Error("functions execution interrupted");
      await this.waitForCheckpoint(cell, signal);
    }
    const checkpoint = cell.checkpoint;
    cell.checkpoint = undefined;
    if (checkpoint.status === "yielded") cell.status = "running";
    else this.remove(cell);
    return checkpoint;
  }

  cancel(sessionId: string, cellId: string): boolean {
    const cell = this.cells.get(cellId);
    if (!cell || cell.sessionId !== sessionId) return false;
    cell.status = "cancelled";
    cell.cancel();
    this.remove(cell);
    return true;
  }

  cancelSession(sessionId: string): void {
    for (const cell of [...this.cells.values()]) {
      if (cell.sessionId === sessionId) this.cancel(sessionId, cell.cellId);
    }
  }

  private finish(cellId: string, result: FunctionsExecRuntimeResult): void {
    const cell = this.cells.get(cellId);
    if (!cell || cell.status === "cancelled") return;
    if (result.cellId !== cellId) {
      cell.status = "failed";
      this.publish(cell, {
        status: "failed",
        output: cell.output,
        error: "functions.exec runtime completed another cell",
      });
      return;
    }
    if (result.status === "completed") {
      cell.status = "completed";
      this.publish(cell, { status: "completed", output: cell.output });
      return;
    }
    cell.status = "failed";
    this.publish(cell, {
      status: "failed",
      output: cell.output,
      error: cap(result.error, MAX_CHECKPOINT_ERROR_BYTES),
    });
  }

  private countForSession(sessionId: string): number {
    let count = 0;
    for (const cell of this.cells.values()) if (cell.sessionId === sessionId) count += 1;
    return count;
  }

  private cellFor(sessionId: string, cellId: string): FunctionsExecCell {
    const cell = this.cells.get(cellId);
    if (!cell) throw new Error(`unknown functions.exec cell: ${cellId}`);
    if (cell.sessionId !== sessionId) throw new Error(`functions.exec cell ${cellId} belongs to another session`);
    return cell;
  }

  private publish(cell: FunctionsExecCell, checkpoint: FunctionsExecCheckpoint): void {
    cell.checkpoint = checkpoint;
    for (const wake of cell.waiters) wake();
    cell.waiters.clear();
  }

  private remove(cell: FunctionsExecCell): void {
    this.cells.delete(cell.cellId);
    cell.onRemoved?.(cell.sessionId, cell.cellId);
    for (const wake of cell.waiters) wake();
    cell.waiters.clear();
  }

  private async waitForCheckpoint(cell: FunctionsExecCell, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        cell.waiters.delete(wake);
        reject(new Error("functions execution interrupted"));
      };
      cell.waiters.add(wake);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}
