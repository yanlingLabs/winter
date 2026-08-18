/**
 * The functions-exec wire is deliberately tiny. A future model-context fragment may be made of
 * any one of these envelopes, so its complete UTF-8 representation is capped at 512 bytes. This
 * is a conservative worst-case token guard: a byte-oriented tokenizer cannot require more than
 * one token per UTF-8 byte, leaving the whole fragment well below one thousand tokens.
 */
export const MAX_CONTEXT_ENVELOPE_BYTES = 512;
export const MAX_UNTRUSTED_STRING_CHARS = 256;
export const MAX_UNTRUSTED_STRING_BYTES = 384;
// Source is transport-only: the engine replaces it with an opaque marker before provider input or
// durable history. It still needs a meaningful but fixed budget for raw Codex patches.
export const MAX_FUNCTIONS_EXEC_SOURCE_CHARS = 8 * 1024;
export const MAX_FUNCTIONS_EXEC_SOURCE_BYTES = 8 * 1024;
// JSON can double a source made only of quotes or backslashes. This caps the execute transport
// envelope without weakening the 512-byte cap for any model-visible worker result.
export const MAX_EXECUTE_ENVELOPE_BYTES = MAX_FUNCTIONS_EXEC_SOURCE_BYTES * 2 + 256;
export const MAX_JSON_DEPTH = 4;
export const MAX_JSON_CONTAINER_ENTRIES = 16;
export const MAX_CELL_ID_CHARS = 64;
export const MAX_MEDIA_DATA_URL_BYTES = 256;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export enum ImageDetail {
  Auto = "auto",
  Low = "low",
  High = "high",
  Original = "original",
}

export type CellFrame =
  | { type: "text"; text: string }
  | { type: "image"; dataUrl: string; detail: ImageDetail }
  | { type: "audio"; dataUrl: string }
  | { type: "notification"; text: string }
  | { type: "yield" }
  | { type: "error"; code: string; message: string };

export type NestedToolName = "bash" | "edit" | "read" | "web_fetch" | "web_search";

export type FunctionsExecFatalCode =
  | "invalid_utf8"
  | "invalid_json"
  | "invalid_frame"
  | "line_too_large"
  | "output_limit_exceeded"
  | "truncated_line"
  | "broken_pipe"
  | "stream_closed";

export type ParentToWorkerFrame =
  | { type: "execute"; cellId: string; source: string }
  | { type: "tool_result"; cellId: string; callId: string; result: JsonValue; isError: boolean }
  | { type: "abort"; cellId: string }
  | { type: "shutdown" };

export type WorkerToParentFrame =
  | { type: "ready" }
  | { type: "call"; cellId: string; callId: string; name: NestedToolName; args: JsonValue }
  | { type: "cell"; cellId: string; frame: CellFrame }
  | { type: "completed"; cellId: string }
  | { type: "fatal"; code: FunctionsExecFatalCode; message: string };

const textEncoder = new TextEncoder();
const imageMimes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const audioMimes = new Set(["audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4"]);
const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const mediaDataUrl = /^data:(image\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i;
const nestedToolNames = new Set<NestedToolName>(["bash", "edit", "read", "web_fetch", "web_search"]);
const fatalCodes = new Set<FunctionsExecFatalCode>([
  "invalid_utf8",
  "invalid_json",
  "invalid_frame",
  "line_too_large",
  "output_limit_exceeded",
  "truncated_line",
  "broken_pipe",
  "stream_closed",
]);

function fail(message: string): never {
  throw new TypeError(`Invalid functions-exec frame: ${message}`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) fail("unknown or missing key");
}

export function assertUntrustedString(value: unknown, label = "string"): asserts value is string {
  if (typeof value !== "string") fail(`${label} must be a string`);
  if (value.length > MAX_UNTRUSTED_STRING_CHARS || textEncoder.encode(value).byteLength > MAX_UNTRUSTED_STRING_BYTES) {
    fail(`${label} string exceeds its hard bound`);
  }
}

export function assertFunctionsExecSource(value: unknown): asserts value is string {
  if (typeof value !== "string") fail("source must be a string");
  if (value.length > MAX_FUNCTIONS_EXEC_SOURCE_CHARS || textEncoder.encode(value).byteLength > MAX_FUNCTIONS_EXEC_SOURCE_BYTES) {
    fail("source exceeds its hard bound");
  }
}

export function assertMediaDataUrl(value: unknown, kind: "image" | "audio"): string {
  assertUntrustedString(value, `${kind} data URL`);
  if (textEncoder.encode(value).byteLength > MAX_MEDIA_DATA_URL_BYTES) {
    fail(`${kind} data URL exceeds its hard bound`);
  }
  const match = mediaDataUrl.exec(value);
  const allowedMimes = kind === "image" ? imageMimes : audioMimes;
  if (!match || !match[1] || !match[2] || !allowedMimes.has(match[1].toLowerCase()) || !base64.test(match[2])) {
    fail(`${kind} data URL or base64 payload is invalid`);
  }
  return value;
}

export function assertImageDetail(value: unknown): asserts value is ImageDetail {
  if (!Object.values(ImageDetail).includes(value as ImageDetail)) fail("image detail is invalid");
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  assertUntrustedString(value, label);
  if (value.length === 0 || value.length > MAX_CELL_ID_CHARS || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    fail(`${label} must be a compact identifier`);
  }
}

export function assertJsonValue(value: unknown, depth = 0): asserts value is JsonValue {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("JSON numbers must be finite");
    return;
  }
  if (typeof value === "string") {
    assertUntrustedString(value, "JSON value");
    return;
  }
  if (depth >= MAX_JSON_DEPTH) fail("JSON value exceeds maximum depth");
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_CONTAINER_ENTRIES) fail("JSON array has too many entries");
    for (const entry of value) assertJsonValue(entry, depth + 1);
    return;
  }
  if (!isPlainRecord(value)) fail("value is not JSON");
  const entries = Object.entries(value);
  if (entries.length > MAX_JSON_CONTAINER_ENTRIES) fail("JSON object has too many entries");
  for (const [key, entry] of entries) {
    assertUntrustedString(key, "JSON key");
    assertJsonValue(entry, depth + 1);
  }
}

function encodeJson(value: unknown): Uint8Array {
  assertJsonValue(value);
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail("value is not JSON");
  return textEncoder.encode(encoded);
}

export function encodedEnvelopeBytes(value: unknown): number {
  return encodeJson(value).byteLength;
}

export function assertContextEnvelope<T>(value: T): T {
  if (encodedEnvelopeBytes(value) > MAX_CONTEXT_ENVELOPE_BYTES) fail("aggregate envelope exceeds its hard bound");
  return value;
}

function assertExecuteEnvelope<T extends Record<string, unknown>>(value: T): T {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || textEncoder.encode(encoded).byteLength > MAX_EXECUTE_ENVELOPE_BYTES) {
    fail("execute envelope exceeds its hard bound");
  }
  return value;
}

export function assertCellFrame(value: unknown): CellFrame {
  if (!isPlainRecord(value) || typeof value.type !== "string") fail("cell frame must be an object");
  switch (value.type) {
    case "text":
    case "notification": {
      assertExactKeys(value, ["type", "text"]);
      assertUntrustedString(value.text, "cell text");
      return assertContextEnvelope(value as CellFrame);
    }
    case "image": {
      assertExactKeys(value, ["type", "dataUrl", "detail"]);
      assertMediaDataUrl(value.dataUrl, "image");
      assertImageDetail(value.detail);
      return assertContextEnvelope(value as CellFrame);
    }
    case "audio": {
      assertExactKeys(value, ["type", "dataUrl"]);
      assertMediaDataUrl(value.dataUrl, "audio");
      return assertContextEnvelope(value as CellFrame);
    }
    case "yield":
      assertExactKeys(value, ["type"]);
      return assertContextEnvelope(value as CellFrame);
    case "error": {
      assertExactKeys(value, ["type", "code", "message"]);
      assertIdentifier(value.code, "error code");
      assertUntrustedString(value.message, "error message");
      return assertContextEnvelope(value as CellFrame);
    }
    default:
      fail("cell frame type is invalid");
  }
}

export function assertParentToWorkerFrame(value: unknown): ParentToWorkerFrame {
  if (!isPlainRecord(value) || typeof value.type !== "string") fail("parent frame must be an object");
  switch (value.type) {
    case "execute":
      assertExactKeys(value, ["type", "cellId", "source"]);
      assertIdentifier(value.cellId, "cellId");
      assertFunctionsExecSource(value.source);
      return assertExecuteEnvelope(value) as ParentToWorkerFrame;
    case "tool_result":
      assertExactKeys(value, ["type", "cellId", "callId", "result", "isError"]);
      assertIdentifier(value.cellId, "cellId");
      assertIdentifier(value.callId, "callId");
      assertJsonValue(value.result);
      if (typeof value.isError !== "boolean") fail("isError must be a boolean");
      return assertContextEnvelope(value as ParentToWorkerFrame);
    case "abort":
      assertExactKeys(value, ["type", "cellId"]);
      assertIdentifier(value.cellId, "cellId");
      return assertContextEnvelope(value as ParentToWorkerFrame);
    case "shutdown":
      assertExactKeys(value, ["type"]);
      return assertContextEnvelope(value as ParentToWorkerFrame);
    default:
      fail("parent frame type is invalid");
  }
}

export function assertWorkerToParentFrame(value: unknown): WorkerToParentFrame {
  if (!isPlainRecord(value) || typeof value.type !== "string") fail("worker frame must be an object");
  switch (value.type) {
    case "ready":
      assertExactKeys(value, ["type"]);
      return assertContextEnvelope(value as WorkerToParentFrame);
    case "call":
      assertExactKeys(value, ["type", "cellId", "callId", "name", "args"]);
      assertIdentifier(value.cellId, "cellId");
      assertIdentifier(value.callId, "callId");
      if (!nestedToolNames.has(value.name as NestedToolName)) fail("nested tool name is invalid");
      assertJsonValue(value.args);
      return assertContextEnvelope(value as WorkerToParentFrame);
    case "cell":
      assertExactKeys(value, ["type", "cellId", "frame"]);
      assertIdentifier(value.cellId, "cellId");
      assertCellFrame(value.frame);
      return assertContextEnvelope(value as WorkerToParentFrame);
    case "completed":
      assertExactKeys(value, ["type", "cellId"]);
      assertIdentifier(value.cellId, "cellId");
      return assertContextEnvelope(value as WorkerToParentFrame);
    case "fatal":
      assertExactKeys(value, ["type", "code", "message"]);
      if (!fatalCodes.has(value.code as FunctionsExecFatalCode)) fail("fatal code is invalid");
      assertUntrustedString(value.message, "fatal message");
      return assertContextEnvelope(value as WorkerToParentFrame);
    default:
      fail("worker frame type is invalid");
  }
}

export function assertWireFrame(value: unknown): ParentToWorkerFrame | WorkerToParentFrame {
  if (!isPlainRecord(value) || typeof value.type !== "string") fail("wire frame must be an object");
  if (["execute", "tool_result", "abort", "shutdown"].includes(value.type)) return assertParentToWorkerFrame(value);
  return assertWorkerToParentFrame(value);
}
