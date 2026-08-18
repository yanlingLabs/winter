import { describe, expect, test } from "bun:test";
import {
  COMPLETED_CELL_FRAME_RETENTION,
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
});
