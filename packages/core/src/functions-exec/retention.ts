import { MAX_CONTEXT_ENVELOPE_BYTES, assertJsonValue, assertUntrustedString, type JsonValue } from "./protocol";

export const TRANSIENT_MEDIA_RETENTION = 0;
export const COMPLETED_CELL_FRAME_RETENTION = 0;
export const RESULT_CHECKPOINT_RETENTION = 1;
export const MAX_PENDING_NOTIFICATIONS = 4;

const encoder = new TextEncoder();

function positiveOrZero(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return value;
}

function bytes(value: JsonValue): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

/** Returns a new bounded tail. Passing zero intentionally retains nothing. */
export function retainTail<T>(items: readonly T[], next: T, maxItems: number): T[] {
  positiveOrZero(maxItems, "maxItems");
  if (maxItems === 0) return [];
  const retainedExisting = maxItems - 1;
  return [...items.slice(items.length - retainedExisting), next];
}

/**
 * The future engine may project text, results, and notifications into one context item. This
 * shared meter makes that aggregate finite rather than treating each channel as an independent
 * budget. Its default uses the same 512-byte worst-case token guard as a single wire envelope.
 */
export class CellQuota {
  private readonly maxBytes: number;
  private readonly maxNotifications: number;
  private usedBytes = 0;
  private notifications = 0;

  constructor(options?: { maxBytes?: number; maxNotifications?: number }) {
    this.maxBytes = Math.min(
      positiveOrZero(options?.maxBytes ?? MAX_CONTEXT_ENVELOPE_BYTES, "maxBytes"),
      MAX_CONTEXT_ENVELOPE_BYTES,
    );
    this.maxNotifications = Math.min(
      positiveOrZero(options?.maxNotifications ?? MAX_PENDING_NOTIFICATIONS, "maxNotifications"),
      MAX_PENDING_NOTIFICATIONS,
    );
  }

  get remainingBytes(): number {
    return this.maxBytes - this.usedBytes;
  }

  get notificationCount(): number {
    return this.notifications;
  }

  tryConsumeText(text: string): boolean {
    assertUntrustedString(text, "text");
    return this.tryConsume({ type: "text", text }, false);
  }

  tryConsumeResult(result: JsonValue): boolean {
    return this.tryConsume({ type: "result", result }, false);
  }

  tryConsumeNotification(text: string): boolean {
    assertUntrustedString(text, "notification");
    return this.tryConsume({ type: "notification", text }, true);
  }

  private tryConsume(value: JsonValue, notification: boolean): boolean {
    assertJsonValue(value);
    if (notification && this.notifications >= this.maxNotifications) return false;
    const size = bytes(value);
    if (size > this.remainingBytes) return false;
    this.usedBytes += size;
    if (notification) this.notifications += 1;
    return true;
  }
}

/** A finite delivery buffer; the comparison deliberately rejects the first item after capacity. */
export class BoundedNotifications {
  private readonly values: string[] = [];

  constructor(private readonly capacity = MAX_PENDING_NOTIFICATIONS) {
    positiveOrZero(capacity, "capacity");
  }

  push(value: string): boolean {
    assertUntrustedString(value, "notification");
    if (this.values.length >= this.capacity) return false;
    this.values.push(value);
    return true;
  }

  drain(): string[] {
    return this.values.splice(0, this.values.length);
  }
}
