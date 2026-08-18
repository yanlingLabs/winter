import {
  ImageDetail,
  MAX_CONTEXT_ENVELOPE_BYTES,
  assertCellFrame,
  assertContextEnvelope,
  assertJsonValue,
  assertUntrustedString,
  type CellFrame,
  type JsonValue,
} from "./protocol";
import { CellQuota } from "./retention";

export { ImageDetail } from "./protocol";

export const MAX_STORE_KEY_CHARS = 64;
export const MAX_STORE_ENTRIES = 16;
export const MAX_MEDIA_DATA_URL_BYTES = 256;

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
  store(key: string, value: JsonValue): void;
  load(key: string): JsonValue | undefined;
  yield(): Promise<void>;
}

export interface WorkerHelperOptions {
  emit(frame: CellFrame): void;
  onYield?(): void | Promise<void>;
  quota?: CellQuota;
}

const encoder = new TextEncoder();
const imageMimes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const audioMimes = new Set(["audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4"]);
const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const mediaDataUrl = /^data:(image\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i;

function clone(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function hasDurableMedia(value: JsonValue): boolean {
  if (typeof value === "string") return /^\s*data:(?:image|audio)\//i.test(value);
  if (value === null || typeof value !== "object") return false;
  return Object.values(value).some(hasDurableMedia);
}

function assertStoreKey(key: unknown): asserts key is string {
  assertUntrustedString(key, "store key");
  if (key.length === 0 || key.length > MAX_STORE_KEY_CHARS) throw new TypeError("Invalid functions-exec store key");
}

function parseMediaDataUrl(value: unknown, allowedMimes: ReadonlySet<string>, kind: "image" | "audio"): string {
  assertUntrustedString(value, `${kind} data URL`);
  if (encoder.encode(value).byteLength > MAX_MEDIA_DATA_URL_BYTES) throw new TypeError(`Invalid functions-exec ${kind}: data URL exceeds its hard bound`);
  const match = mediaDataUrl.exec(value);
  if (!match || !match[1] || !match[2] || !allowedMimes.has(match[1].toLowerCase()) || !base64.test(match[2])) {
    throw new TypeError(`Invalid functions-exec ${kind} data URL or base64 payload`);
  }
  return value;
}

function imageDetail(value: unknown): ImageDetail {
  if (value === undefined) return ImageDetail.Auto;
  if (!Object.values(ImageDetail).includes(value as ImageDetail)) throw new TypeError("Invalid functions-exec image detail");
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
  if (typeof value === "string") return { type: "image", dataUrl: parseMediaDataUrl(value, imageMimes, "image"), detail: ImageDetail.Auto };
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "image_url" && key !== "detail")) {
    throw new TypeError("Invalid functions-exec image argument");
  }
  return { type: "image", dataUrl: parseMediaDataUrl(value.image_url, imageMimes, "image"), detail: imageDetail(value.detail) };
}

function normalizeAudio(value: string | AudioInput): CellFrame {
  if (typeof value === "string") return { type: "audio", dataUrl: parseMediaDataUrl(value, audioMimes, "audio") };
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "audio_url")) {
    throw new TypeError("Invalid functions-exec audio argument");
  }
  return { type: "audio", dataUrl: parseMediaDataUrl(value.audio_url, audioMimes, "audio") };
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
      assertJsonValue(value);
      if (hasDurableMedia(value)) throw new TypeError("functions-exec store rejects media data URLs");
      assertContextEnvelope({ type: "store", key, value });
      if (!values.has(key) && values.size >= MAX_STORE_ENTRIES) throw new RangeError("functions-exec store is full");
      values.set(key, clone(value));
    },
    load(key): JsonValue | undefined {
      assertStoreKey(key);
      const value = values.get(key);
      return value === undefined ? undefined : clone(value);
    },
    async yield(): Promise<void> {
      await options.onYield?.();
      emitBounded(options, quota, { type: "yield" });
    },
  };
}
