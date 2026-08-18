import {
  MAX_CONTEXT_ENVELOPE_BYTES,
  assertParentToWorkerFrame,
  assertWireFrame,
  type FunctionsExecFatalCode,
  type ParentToWorkerFrame,
  type WorkerToParentFrame,
} from "./protocol";

export type { ParentToWorkerFrame, WorkerToParentFrame } from "./protocol";

export const MAX_NDJSON_LINE_BYTES = MAX_CONTEXT_ENVELOPE_BYTES;
export const MAX_NDJSON_TOTAL_BYTES = MAX_NDJSON_LINE_BYTES * 8;

export interface NdjsonLimits {
  maxLineBytes?: number;
  maxTotalBytes?: number;
}

export interface NdjsonFatalError {
  code: FunctionsExecFatalCode;
  message: string;
}

export type NdjsonDecodeResult<T> =
  | { ok: true; frames: T[] }
  | { ok: false; fatal: NdjsonFatalError };

export type FrameValidator<T> = (value: unknown) => T;

type ParsedFrame<T> = { ok: true; frame: T } | { ok: false; fatal: NdjsonFatalError };

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function error(code: FunctionsExecFatalCode, message: string): NdjsonDecodeResult<never> {
  return { ok: false, fatal: { code, message } };
}

function positiveLimit(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > maximum) throw new RangeError(`${name} must be a positive integer no greater than ${maximum}`);
  return limit;
}

export function encodeNdjsonFrame(frame: ParentToWorkerFrame | WorkerToParentFrame): Uint8Array {
  const validated = assertWireFrame(frame);
  const line = encoder.encode(`${JSON.stringify(validated)}\n`);
  if (line.byteLength - 1 > MAX_NDJSON_LINE_BYTES) throw new RangeError("NDJSON frame exceeds the line limit");
  return line;
}

/** Incremental byte framer: it scans for newlines before decoding, so a multibyte UTF-8 character
 * split between chunks is reconstructed without accepting malformed UTF-8 or buffering an
 * unbounded line. */
export class NdjsonDecoder<T = ParentToWorkerFrame> {
  private readonly validate: FrameValidator<T>;
  private readonly maxLineBytes: number;
  private readonly maxTotalBytes: number;
  private pending = new Uint8Array();
  private totalBytes = 0;
  private terminal: NdjsonFatalError | "finished" | undefined;

  constructor(options?: NdjsonLimits);
  constructor(validate: FrameValidator<T>, options?: NdjsonLimits);
  constructor(input?: NdjsonLimits | FrameValidator<T>, options?: NdjsonLimits) {
    const isValidator = typeof input === "function";
    this.validate = (isValidator ? input : assertParentToWorkerFrame) as FrameValidator<T>;
    const limits = (isValidator ? options : input) as NdjsonLimits | undefined;
    this.maxLineBytes = positiveLimit(limits?.maxLineBytes, MAX_NDJSON_LINE_BYTES, MAX_NDJSON_LINE_BYTES, "maxLineBytes");
    this.maxTotalBytes = positiveLimit(limits?.maxTotalBytes, MAX_NDJSON_TOTAL_BYTES, MAX_NDJSON_TOTAL_BYTES, "maxTotalBytes");
  }

  push(chunk: Uint8Array): NdjsonDecodeResult<T> {
    if (this.terminal) return this.terminal === "finished" ? error("stream_closed", "NDJSON stream is already closed") : { ok: false, fatal: this.terminal };
    this.totalBytes += chunk.byteLength;
    if (this.totalBytes > this.maxTotalBytes) return this.fail("output_limit_exceeded", "NDJSON output exceeded its total byte limit");

    const frames: T[] = [];
    let start = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      const appended = this.append(chunk.subarray(start, index));
      if (appended) return appended;
      const line = this.takeLine();
      start = index + 1;
      if (line.byteLength === 0) continue;
      const parsed = this.parseLine(line);
      if (!parsed.ok) return parsed;
      frames.push(parsed.frame);
    }
    const appended = this.append(chunk.subarray(start));
    if (appended) return appended;
    return { ok: true, frames };
  }

  finish(reason: "eof" | "epipe" = "eof"): NdjsonDecodeResult<T> {
    if (this.terminal) return this.terminal === "finished" ? { ok: true, frames: [] } : { ok: false, fatal: this.terminal };
    if (reason === "epipe") return this.fail("broken_pipe", "NDJSON pipe closed before completion");
    if (this.pending.byteLength !== 0) return this.fail("truncated_line", "NDJSON stream ended with a partial line");
    this.terminal = "finished";
    return { ok: true, frames: [] };
  }

  private append(bytes: Uint8Array): NdjsonDecodeResult<never> | undefined {
    if (bytes.byteLength === 0) return undefined;
    if (this.pending.byteLength + bytes.byteLength > this.maxLineBytes) {
      return this.fail("line_too_large", "NDJSON line exceeded its byte limit");
    }
    const next = new Uint8Array(this.pending.byteLength + bytes.byteLength);
    next.set(this.pending);
    next.set(bytes, this.pending.byteLength);
    this.pending = next;
    return undefined;
  }

  private takeLine(): Uint8Array {
    const line = this.pending;
    this.pending = new Uint8Array();
    return line.byteLength > 0 && line[line.byteLength - 1] === 0x0d ? line.slice(0, -1) : line;
  }

  private parseLine(line: Uint8Array): ParsedFrame<T> {
    let decoded: string;
    try {
      decoded = decoder.decode(line);
    } catch {
      return this.fail("invalid_utf8", "NDJSON line is not valid UTF-8");
    }
    let json: unknown;
    try {
      json = JSON.parse(decoded);
    } catch {
      return this.fail("invalid_json", "NDJSON line is not valid JSON");
    }
    try {
      return { ok: true, frame: this.validate(json) };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "NDJSON frame is invalid";
      return this.fail("invalid_frame", message);
    }
  }

  private fail(code: FunctionsExecFatalCode, message: string): { ok: false; fatal: NdjsonFatalError } {
    this.terminal = { code, message };
    this.pending = new Uint8Array();
    return { ok: false, fatal: this.terminal };
  }
}
