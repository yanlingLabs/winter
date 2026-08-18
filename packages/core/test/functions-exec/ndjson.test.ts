import { describe, expect, test } from "bun:test";
import {
  NdjsonDecoder,
  encodeNdjsonFrame,
  type ParentToWorkerFrame,
} from "../../src/functions-exec/ndjson";

const frame: ParentToWorkerFrame = { type: "execute", cellId: "cell-1", source: "text('é')" };

function fatalCode(result: ReturnType<NdjsonDecoder["push"]>): string | undefined {
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
});
