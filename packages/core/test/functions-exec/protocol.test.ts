import { describe, expect, test } from "bun:test";
import {
  MAX_CONTEXT_ENVELOPE_BYTES,
  MAX_FUNCTIONS_EXEC_SOURCE_BYTES,
  assertParentToWorkerFrame,
  assertWorkerToParentFrame,
  encodedEnvelopeBytes,
} from "../../src/functions-exec/protocol";

describe("functions-exec protocol bounds", () => {
  test("accepts a bounded private source transport while keeping worker envelopes under the context cap", () => {
    const parent = assertParentToWorkerFrame({ type: "execute", cellId: "cell-1", source: "text('ok')" });
    const worker = assertWorkerToParentFrame({ type: "cell", cellId: "cell-1", frame: { type: "text", text: "ok" } });

    expect(parent).toEqual({ type: "execute", cellId: "cell-1", source: "text('ok')" });
    expect(assertParentToWorkerFrame({ type: "execute", cellId: "cell-1", source: "x".repeat(2_048) })).toEqual({
      type: "execute", cellId: "cell-1", source: "x".repeat(2_048),
    });
    expect(worker).toEqual({ type: "cell", cellId: "cell-1", frame: { type: "text", text: "ok" } });
    expect(encodedEnvelopeBytes(worker)).toBeLessThanOrEqual(MAX_CONTEXT_ENVELOPE_BYTES);
  });

  test("rejects non-JSON values, unknown keys, deep arguments, and aggregate envelopes over the cap", () => {
    expect(() => assertParentToWorkerFrame({ type: "execute", cellId: "cell-1", source: "ok", extra: true })).toThrow(/unknown/i);
    expect(() => assertWorkerToParentFrame({ type: "call", callId: "call-1", cellId: "cell-1", name: "bash", args: { value: undefined } })).toThrow(/JSON/i);
    expect(() => assertWorkerToParentFrame({ type: "call", callId: "call-1", cellId: "cell-1", name: "bash", args: { a: { b: { c: { d: { e: "too deep" } } } } } })).toThrow(/depth/i);
    expect(() => assertParentToWorkerFrame({ type: "execute", cellId: "cell-1", source: "x".repeat(MAX_FUNCTIONS_EXEC_SOURCE_BYTES + 1) })).toThrow(/source/i);
    expect(() => assertWorkerToParentFrame({ type: "call", callId: "call-1", cellId: "cell-1", name: "bash", args: { first: "x".repeat(250), second: "y".repeat(250) } })).toThrow(/envelope/i);
  });

  test("applies the helper media MIME, base64, and detail rules to raw worker frames", () => {
    expect(() => assertWorkerToParentFrame({
      type: "cell", cellId: "cell-1", frame: { type: "image", dataUrl: "data:text/plain;base64,eA==", detail: "auto" },
    })).toThrow(/image/i);
    expect(() => assertWorkerToParentFrame({
      type: "cell", cellId: "cell-1", frame: { type: "audio", dataUrl: "data:audio/mpeg;base64,%%%%" },
    })).toThrow(/audio/i);
    expect(() => assertWorkerToParentFrame({
      type: "cell", cellId: "cell-1", frame: { type: "image", dataUrl: "data:image/png;base64,aGVsbG8=", detail: "sharp" },
    })).toThrow(/detail/i);
  });
});
