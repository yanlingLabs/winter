import { describe, expect, test } from "bun:test";
import {
  NdjsonDecoder,
  encodeNdjsonFrame,
  type ParentToWorkerFrame,
} from "../../src/functions-exec/ndjson";
import { assertWorkerToParentFrame, type WorkerToParentFrame } from "../../src/functions-exec/protocol";

const frame: ParentToWorkerFrame = { type: "execute", cellId: "cell-1", source: "text('é')" };

function fatalCode<T>(result: ReturnType<NdjsonDecoder<T>["push"]>): string | undefined {
  return result.ok ? undefined : result.fatal.code;
}

describe("functions-exec NDJSON framing", () => {
  test("round-trips UTF-8 split across chunks", () => {
    const encoded = encodeNdjsonFrame(frame);
    const split = encoded.indexOf(0xc3) + 1;
    const decoder = new NdjsonDecoder();

    expect(decoder.push(encoded.slice(0, split))).toEqual({ ok: true, frames: [] });
    expect(decoder.push(encoded.slice(split))).toEqual({ ok: true, frames: [frame] });
    expect(decoder.finish()).toEqual({ ok: true, frames: [] });
  });

  test("admits a bounded private execute source without widening worker output frames", () => {
    const source = "x".repeat(2_048);
    const execute: ParentToWorkerFrame = { type: "execute", cellId: "cell-1", source };
    const parent = new NdjsonDecoder();
    expect(parent.push(encodeNdjsonFrame(execute))).toEqual({ ok: true, frames: [execute] });

    const worker = new NdjsonDecoder<WorkerToParentFrame>(assertWorkerToParentFrame);
    expect(fatalCode(worker.push(new TextEncoder().encode(`${JSON.stringify({ type: "cell", cellId: "cell-1", frame: { type: "text", text: "x".repeat(513) } })}\n`)))).toBe("line_too_large");
  });

  test("rejects malformed json, malformed UTF-8, oversized lines, and excessive total output", () => {
    const malformed = new NdjsonDecoder();
    expect(fatalCode(malformed.push(new TextEncoder().encode("{not json}\n")))).toBe("invalid_json");

    const utf8 = new NdjsonDecoder();
    expect(fatalCode(utf8.push(new Uint8Array([0xff, 0x0a])))).toBe("invalid_utf8");

    const tooLong = new NdjsonDecoder({ maxLineBytes: 8 });
    expect(fatalCode(tooLong.push(new TextEncoder().encode("123456789\n")))).toBe("line_too_large");

    const total = new NdjsonDecoder({ maxTotalBytes: 8 });
    expect(fatalCode(total.push(new TextEncoder().encode("123456789")))).toBe("output_limit_exceeded");

    expect(() => new NdjsonDecoder({ maxLineBytes: Number.MAX_SAFE_INTEGER })).toThrow(/no greater/i);
  });

  test("gives typed early EOF and EPIPE failures", () => {
    const eof = new NdjsonDecoder();
    eof.push(new TextEncoder().encode('{"type":"abort"'));
    expect(eof.finish()).toEqual({ ok: false, fatal: { code: "truncated_line", message: "NDJSON stream ended with a partial line" } });

    const epipe = new NdjsonDecoder();
    expect(epipe.finish("epipe")).toEqual({ ok: false, fatal: { code: "broken_pipe", message: "NDJSON pipe closed before completion" } });
  });

  test("requires a completed worker terminal frame even when EOF has no pending bytes", () => {
    const decoder = new NdjsonDecoder<WorkerToParentFrame>(assertWorkerToParentFrame);
    expect(decoder.push(encodeNdjsonFrame({ type: "ready" }))).toEqual({ ok: true, frames: [{ type: "ready" }] });
    expect(decoder.finish()).toEqual({ ok: false, fatal: { code: "broken_pipe", message: "NDJSON stream ended before completion" } });
  });

  test("accepts EPIPE only after a completed worker terminal frame", () => {
    const completed: WorkerToParentFrame = { type: "completed", cellId: "cell-1" };
    const decoder = new NdjsonDecoder<WorkerToParentFrame>(assertWorkerToParentFrame);
    expect(decoder.push(encodeNdjsonFrame(completed))).toEqual({ ok: true, frames: [completed] });
    expect(decoder.finish("epipe")).toEqual({ ok: true, frames: [] });
  });

  test("does not count CRLF framing bytes against an exact payload limit", () => {
    const encoded = encodeNdjsonFrame(frame);
    const payload = encoded.slice(0, -1);
    const crlf = new Uint8Array(payload.byteLength + 2);
    crlf.set(payload);
    crlf.set([0x0d, 0x0a], payload.byteLength);
    const decoder = new NdjsonDecoder({ maxLineBytes: payload.byteLength });

    expect(decoder.push(crlf)).toEqual({ ok: true, frames: [frame] });
  });
});
