import { describe, expect, test } from "bun:test";
import {
  COMPLETED_CELL_FRAME_RETENTION,
  MAX_PENDING_NOTIFICATIONS,
  TRANSIENT_MEDIA_RETENTION,
  BoundedNotifications,
  CellQuota,
  retainTail,
} from "../../src/functions-exec/retention";

describe("functions-exec finite retention", () => {
  test("keeps media and completed frames at explicit zero retention", () => {
    expect(TRANSIENT_MEDIA_RETENTION).toBe(0);
    expect(COMPLETED_CELL_FRAME_RETENTION).toBe(0);
    expect(retainTail(["old"], "new", 0)).toEqual([]);
  });

  test("retains exactly the requested tail for every integer capacity", () => {
    expect(retainTail(["one", "two"], "three", 1)).toEqual(["three"]);
    expect(retainTail(["one", "two"], "three", 2)).toEqual(["two", "three"]);
    expect(retainTail(["one", "two"], "three", 3)).toEqual(["one", "two", "three"]);
  });

  test("delivers exactly its notification capacity with no off-by-one", () => {
    const notifications = new BoundedNotifications(2);
    expect(notifications.push("first")).toBe(true);
    expect(notifications.push("second")).toBe(true);
    expect(notifications.push("third")).toBe(false);
    expect(notifications.drain()).toEqual(["first", "second"]);
    expect(notifications.drain()).toEqual([]);
    expect(() => notifications.push("x".repeat(257))).toThrow(/string/i);
  });

  test("enforces one aggregate context budget across text, results, and notifications", () => {
    const quota = new CellQuota({ maxBytes: 160, maxNotifications: 1 });
    expect(quota.tryConsumeText("small text")).toBe(true);
    expect(quota.tryConsumeResult({ answer: "small result" })).toBe(true);
    expect(quota.tryConsumeNotification("first")).toBe(true);
    expect(quota.tryConsumeNotification("second")).toBe(false);
    expect(quota.tryConsumeText("x".repeat(160))).toBe(false);
  });

  test("caller quotas can tighten but never expand global text or notification maxima", () => {
    const text = new CellQuota({ maxBytes: 4_096, maxNotifications: 4_096 });
    expect(text.tryConsumeText("x".repeat(250))).toBe(true);
    expect(text.tryConsumeText("y".repeat(250))).toBe(false);

    const notifications = new CellQuota({ maxBytes: 4_096, maxNotifications: 4_096 });
    for (let index = 0; index < MAX_PENDING_NOTIFICATIONS; index += 1) {
      expect(notifications.tryConsumeNotification(`note-${index}`)).toBe(true);
    }
    expect(notifications.tryConsumeNotification("one too many")).toBe(false);
  });
});
