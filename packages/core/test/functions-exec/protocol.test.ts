import { describe, expect, test } from "bun:test";
import {
  MAX_CONTEXT_ENVELOPE_BYTES,
  MAX_UNTRUSTED_STRING_CHARS,
  assertParentToWorkerFrame,
  assertWorkerToParentFrame,
  encodedEnvelopeBytes,
} from "../../src/functions-exec/protocol";

describe("functions-exec protocol bounds", () => {
  test("accepts strict parent and worker envelopes below the single aggregate context cap", () => {
    const parent = assertParentToWorkerFrame({ type: "execute", cellId: "cell-1", source: "text('ok')" });
    const worker = assertWorkerToParentFrame({ type: "cell", cellId: "cell-1", frame: { type: "text", text: "ok" } });

    expect(parent).toEqual({ type: "execute", cellId: "cell-1", source: "text('ok')" });
    expect(worker).toEqual({ type: "cell", cellId: "cell-1", frame: { type: "text", text: "ok" } });
    expect(encodedEnvelopeBytes(worker)).toBeLessThanOrEqual(MAX_CONTEXT_ENVELOPE_BYTES);
  });

  test("rejects non-JSON values, unknown keys, deep arguments, and aggregate envelopes over the cap", () => {
    expect(() => assertParentToWorkerFrame({ type: "execute", cellId: "cell-1", source: "ok", extra: true })).toThrow(/unknown/i);
    expect(() => assertWorkerToParentFrame({ type: "call", callId: "call-1", cellId: "cell-1", name: "bash", args: { value: undefined } })).toThrow(/JSON/i);
    expect(() => assertWorkerToParentFrame({ type: "call", callId: "call-1", cellId: "cell-1", name: "bash", args: { a: { b: { c: { d: { e: "too deep" } } } } } })).toThrow(/depth/i);
    expect(() => assertParentToWorkerFrame({ type: "execute", cellId: "cell-1", source: "x".repeat(MAX_UNTRUSTED_STRING_CHARS + 1) })).toThrow(/string/i);
    expect(() => assertWorkerToParentFrame({ type: "call", callId: "call-1", cellId: "cell-1", name: "bash", args: { first: "x".repeat(250), second: "y".repeat(250) } })).toThrow(/envelope/i);
  });
});
