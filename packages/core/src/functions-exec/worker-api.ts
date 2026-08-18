import {
  ImageDetail,
  MAX_CONTEXT_ENVELOPE_BYTES,
  MAX_JSON_CONTAINER_ENTRIES,
  MAX_JSON_DEPTH,
  MAX_MEDIA_DATA_URL_BYTES,
  assertCellFrame,
  assertContextEnvelope,
  assertImageDetail,
  assertMediaDataUrl,
  assertUntrustedString,
  type CellFrame,
  type JsonValue,
} from "./protocol";
import { CellQuota } from "./retention";

export { ImageDetail, MAX_MEDIA_DATA_URL_BYTES } from "./protocol";

export const MAX_STORE_KEY_CHARS = 64;
export const MAX_STORE_ENTRIES = 16;

export interface ImageInput {
  image_url: string;
  detail?: ImageDetail | "auto" | "low" | "high" | "original";
}

export interface AudioInput {
  audio_url: string;
}

export interface WorkerHelpers {
  text(value: string): void;
  image(value: string | ImageInput): void;
  audio(value: string | AudioInput): void;
  notify(value: string): void;
  store(key: string, value: unknown): void;
  load(key: string): JsonValue | undefined;
  yield(): Promise<void>;
}

export interface WorkerHelperOptions {
  emit(frame: CellFrame): void;
  onYield?(): void | Promise<void>;
  quota?: CellQuota;
}

const own = Object.prototype.hasOwnProperty;

function canonicalMediaCandidate(value: string): string {
  let candidate = value.normalize("NFKC").trim();
  for (let iteration = 0; iteration <= value.length; iteration += 1) {
    const escapedCandidate = candidate.replace(/\\\\+/g, "\\");
    const decodedEscapes = escapedCandidate.replace(/\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi, (_match, codePoint: string | undefined, codeUnit: string | undefined, byte: string | undefined) => {
      const code = Number.parseInt(codePoint ?? codeUnit ?? byte ?? "", 16);
      return Number.isSafeInteger(code) && code <= 0x10ffff ? String.fromCodePoint(code) : _match;
    });
    let percentDecoded = decodedEscapes;
    try {
      percentDecoded = decodeURIComponent(decodedEscapes);
    } catch {
      // Invalid percent escapes cannot turn into a canonical data URL.
    }
    const next = percentDecoded.normalize("NFKC").replace(/[\u0000-\u0020]+/g, "");
    if (next === candidate) return next;
    candidate = next;
  }
  return candidate;
}

function assertNoDurableMedia(value: string, label: string): void {
  if (/data:(?:image|audio)\//i.test(canonicalMediaCandidate(value))) {
    throw new TypeError(`functions-exec store rejects media data URLs in ${label}`);
  }
}

function descriptorValue(descriptor: PropertyDescriptor, label: string): unknown {
  if (!own.call(descriptor, "value")) throw new TypeError(`functions-exec store rejects accessor ${label}`);
  return descriptor.value;
}

function immutable(value: JsonValue): JsonValue {
  if (value !== null && typeof value === "object") Object.freeze(value);
  return value;
}

function snapshotStoreValue(value: unknown, depth = 0): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("functions-exec store only accepts finite JSON numbers");
    return value;
  }
  if (typeof value === "string") {
    assertUntrustedString(value, "store value");
    assertNoDurableMedia(value, "store value");
    return value;
  }
  if (typeof value !== "object" || depth >= MAX_JSON_DEPTH) {
    throw new TypeError("functions-exec store only accepts bounded JSON values");
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError("functions-exec store rejects symbol keys");
  return Array.isArray(value)
    ? snapshotArray(descriptors, depth)
    : snapshotRecord(descriptors, depth);
}

function snapshotArray(descriptors: Record<string, PropertyDescriptor>, depth: number): JsonValue {
  const lengthDescriptor = descriptors.length;
  const length = lengthDescriptor === undefined ? undefined : descriptorValue(lengthDescriptor, "array length");
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > MAX_JSON_CONTAINER_ENTRIES) {
    throw new TypeError("functions-exec store array has too many entries");
  }
  const values: JsonValue[] = [];
  for (const key of Object.keys(descriptors)) {
    if (key === "length") continue;
    assertUntrustedString(key, "store key");
    assertNoDurableMedia(key, "store key");
    if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) {
      throw new TypeError("functions-exec store array has an unsupported property");
    }
    descriptorValue(descriptors[key] as PropertyDescriptor, `array property ${key}`);
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    values.push(descriptor === undefined ? null : snapshotStoreValue(descriptorValue(descriptor, `array property ${index}`), depth + 1));
  }
  return immutable(values);
}

function snapshotRecord(descriptors: Record<string, PropertyDescriptor>, depth: number): JsonValue {
  const keys = Object.keys(descriptors);
  if (keys.length > MAX_JSON_CONTAINER_ENTRIES) throw new TypeError("functions-exec store object has too many entries");
  const snapshot = Object.create(null) as Record<string, JsonValue>;
  for (const key of keys) {
    assertUntrustedString(key, "store key");
    assertNoDurableMedia(key, "store key");
    const descriptor = descriptors[key] as PropertyDescriptor;
    const value = snapshotStoreValue(descriptorValue(descriptor, `property ${key}`), depth + 1);
    if (descriptor.enumerable) {
      Object.defineProperty(snapshot, key, { value, enumerable: true, configurable: false, writable: false });
    }
  }
  return immutable(snapshot);
}

function cloneSnapshot(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneSnapshot);
  const copy: Record<string, JsonValue> = {};
  for (const key of Object.keys(value)) {
    Object.defineProperty(copy, key, { value: cloneSnapshot(value[key] as JsonValue), enumerable: true, configurable: true, writable: true });
  }
  return copy;
}

function assertStoreKey(key: unknown): asserts key is string {
  assertUntrustedString(key, "store key");
  if (key.length === 0 || key.length > MAX_STORE_KEY_CHARS) throw new TypeError("Invalid functions-exec store key");
  assertNoDurableMedia(key, "store key");
}

function imageDetail(value: unknown): ImageDetail {
  if (value === undefined) return ImageDetail.Auto;
  assertImageDetail(value);
  return value as ImageDetail;
}

function emitBounded(options: WorkerHelperOptions, quota: CellQuota, frame: CellFrame): void {
  const validated = assertCellFrame(frame);
  const consumed = validated.type === "notification"
    ? quota.tryConsumeNotification(validated.text)
    : quota.tryConsumeResult(validated);
  if (!consumed) throw new RangeError("functions-exec cell aggregate quota exceeded");
  options.emit(validated);
}

function normalizeImage(value: string | ImageInput): CellFrame {
  if (typeof value === "string") return { type: "image", dataUrl: assertMediaDataUrl(value, "image"), detail: ImageDetail.Auto };
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "image_url" && key !== "detail")) {
    throw new TypeError("Invalid functions-exec image argument");
  }
  return { type: "image", dataUrl: assertMediaDataUrl(value.image_url, "image"), detail: imageDetail(value.detail) };
}

function normalizeAudio(value: string | AudioInput): CellFrame {
  if (typeof value === "string") return { type: "audio", dataUrl: assertMediaDataUrl(value, "audio") };
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "audio_url")) {
    throw new TypeError("Invalid functions-exec audio argument");
  }
  return { type: "audio", dataUrl: assertMediaDataUrl(value.audio_url, "audio") };
}

/**
 * Pure worker-facing helpers. They have no filesystem, network, subprocess, or host-tool access;
 * a later sandbox may inject this object as the only bridge from untrusted JavaScript.
 */
export function createWorkerHelpers(options: WorkerHelperOptions): WorkerHelpers {
  const values = new Map<string, JsonValue>();
  const quota = options.quota ?? new CellQuota({ maxBytes: MAX_CONTEXT_ENVELOPE_BYTES });

  return {
    text(value): void {
      assertUntrustedString(value, "text");
      emitBounded(options, quota, { type: "text", text: value });
    },
    image(value): void {
      emitBounded(options, quota, normalizeImage(value));
    },
    audio(value): void {
      emitBounded(options, quota, normalizeAudio(value));
    },
    notify(value): void {
      assertUntrustedString(value, "notification");
      emitBounded(options, quota, { type: "notification", text: value });
    },
    store(key, value): void {
      assertStoreKey(key);
      const snapshot = snapshotStoreValue(value);
      assertContextEnvelope({ type: "store", key, value: snapshot });
      if (!values.has(key) && values.size >= MAX_STORE_ENTRIES) throw new RangeError("functions-exec store is full");
      values.set(key, snapshot);
    },
    load(key): JsonValue | undefined {
      assertStoreKey(key);
      const value = values.get(key);
      return value === undefined ? undefined : cloneSnapshot(value);
    },
    async yield(): Promise<void> {
      await options.onYield?.();
      emitBounded(options, quota, { type: "yield" });
    },
  };
}
