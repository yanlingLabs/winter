// ComputerV2 — a type/paste's expected time, and what the daemon does when it outlasts the run's time left.
import { describe, expect, test } from "bun:test";
import { PASTE_FIXED_MS, PER_KEY_MS, TYPE_FIXED_MS, TYPE_KEYS_MAX, typingEstimateMs, typingFit } from "../../src/computer-use/typing-estimate";

describe("typingEstimateMs mirrors the helper's routes", () => {
  test("short single-line text is typed as keys", () => {
    expect(typingEstimateMs("type", "hello")).toBe(TYPE_FIXED_MS + 5 * PER_KEY_MS);
    expect(typingEstimateMs("type", "x".repeat(TYPE_KEYS_MAX))).toBe(TYPE_FIXED_MS + TYPE_KEYS_MAX * PER_KEY_MS);
  });
  test("multi-line or longer text is pasted: a fixed cost, not per character", () => {
    expect(typingEstimateMs("type", "a\nb")).toBe(TYPE_FIXED_MS + PASTE_FIXED_MS);
    expect(typingEstimateMs("type", "x".repeat(3_000))).toBe(TYPE_FIXED_MS + PASTE_FIXED_MS);
    expect(typingEstimateMs("paste", "x".repeat(3_000))).toBe(PASTE_FIXED_MS);
  });
  test("a short paste may be typed instead, so it counts its characters", () => {
    expect(typingEstimateMs("paste", "note")).toBe(PASTE_FIXED_MS + 4 * PER_KEY_MS);
  });
  test("characters, not UTF-16 units", () => {
    expect(typingEstimateMs("type", "日本😀")).toBe(TYPE_FIXED_MS + 3 * PER_KEY_MS);
  });
});

describe("typingFit", () => {
  test("fits in the time left", () => {
    expect(typingFit(2_000, 30_000, 30_000, 300_000)).toEqual({ kind: "fits" });
  });
  test("extends by the estimate (and a margin) when the time left is too short", () => {
    expect(typingFit(4_000, 1_500, 30_000, 300_000)).toEqual({ kind: "extend", byMs: 5_000 });
  });
  test("the extension is capped at the 300 s maximum", () => {
    expect(typingFit(4_000, 3_500, 299_000, 300_000)).toEqual({ kind: "extend", byMs: 1_000 });
  });
  test("a tight fit at the maximum still runs", () => {
    expect(typingFit(4_000, 4_500, 300_000, 300_000)).toEqual({ kind: "fits" });
  });
  test("refuses up front when even the maximum is too little", () => {
    const r = typingFit(40_000, 2_000, 290_000, 300_000);
    expect(r).toEqual({ kind: "refuse", message: "this text would take ~40 s to type — pass timeoutMs or paste it" });
  });
});
