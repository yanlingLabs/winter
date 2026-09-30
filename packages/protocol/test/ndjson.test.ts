import { describe, expect, test } from "bun:test";
import { LineDecoder, encodeLine } from "../src/ndjson";

describe("NDJSON framing", () => {
  test("encodeLine appends newline", () => {
    expect(new TextDecoder().decode(encodeLine({ a: 1 }))).toBe('{"a":1}\n');
  });

  test("decoder handles one message split across chunks", () => {
    const d = new LineDecoder();
    expect(d.push(new TextEncoder().encode('{"a"'))).toEqual([]);
    expect(d.push(new TextEncoder().encode(':1}\n'))).toEqual(['{"a":1}']);
  });

  test("decoder handles multiple messages in one chunk", () => {
    const d = new LineDecoder();
    expect(d.push(new TextEncoder().encode('{"a":1}\n{"b":2}\n'))).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("decoder handles multi-byte UTF-8 split mid-character", () => {
    const d = new LineDecoder();
    const bytes = new TextEncoder().encode('{"t":"é"}\n'); // é is 2 bytes
    const cut = 6; // splits inside the é
    const out = [...d.push(bytes.slice(0, cut)), ...d.push(bytes.slice(cut))];
    expect(out).toEqual(['{"t":"é"}']);
  });

  test("oversized line throws", () => {
    const d = new LineDecoder(64);
    expect(() => d.push(new TextEncoder().encode("x".repeat(100)))).toThrow(/line too long/);
  });

  test("blank lines are skipped (bare newline keep-alives, NDJSON blank separators)", () => {
    const d = new LineDecoder();
    expect(d.push(new TextEncoder().encode("\n"))).toEqual([]);
    expect(d.push(new TextEncoder().encode('{"a":1}\n\n{"b":2}\n'))).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("decoder is reset (not poisoned) after oversized-line throw", () => {
    const d = new LineDecoder(8);
    expect(() => d.push(new TextEncoder().encode("x".repeat(20)))).toThrow(/line too long/);
    expect(d.push(new TextEncoder().encode('{"ok":1}\n'))).toEqual(['{"ok":1}']);
  });

  test("a long line in many small chunks decodes exactly, in linear time", () => {
    const d = new LineDecoder();
    const body = "A".repeat(7_000_000);
    const bytes = new TextEncoder().encode(`${body}\n{"b":2}\n`);
    const out: string[] = [];
    const t = performance.now();
    for (let i = 0; i < bytes.length; i += 8192) out.push(...d.push(bytes.subarray(i, i + 8192)));
    expect(out.length).toBe(2);
    expect(out[0]!.length).toBe(body.length);
    expect(out[1]).toBe('{"b":2}');
    // The quadratic re-merge/re-scan took well over a second here; linear is a few ms.
    expect(performance.now() - t).toBeLessThan(500);
  });

  test("a held partial line is a copy — the caller may reuse its chunk buffer", () => {
    const d = new LineDecoder();
    const chunk = new TextEncoder().encode('{"a"');
    expect(d.push(chunk)).toEqual([]);
    chunk.fill(0x78);
    expect(d.push(new TextEncoder().encode(":1}\n"))).toEqual(['{"a":1}']);
  });

  test("a held partial line survives the caller REUSING a Node Buffer (Buffer#slice is a view)", () => {
    const d = new LineDecoder();
    const chunk = Buffer.from('{"a"');
    expect(d.push(chunk)).toEqual([]);
    chunk.fill(0x78);
    expect(d.push(Buffer.from(":1}\n"))).toEqual(['{"a":1}']);
  });

  test("a long line fed one byte at a time decodes exactly, in linear time", () => {
    const d = new LineDecoder();
    const body = "B".repeat(300_000);
    const bytes = new TextEncoder().encode(`${body}\n`);
    const out: string[] = [];
    const t = performance.now();
    for (let i = 0; i < bytes.length; i++) out.push(...d.push(bytes.subarray(i, i + 1)));
    expect(out).toEqual([body]);
    expect(performance.now() - t).toBeLessThan(1500);
  });
});
