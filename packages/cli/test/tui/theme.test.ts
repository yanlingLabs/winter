import { describe, expect, test } from "bun:test";
import { theme, type ThemeKey } from "../../src/tui/theme";

const EXPECTED_KEYS: ThemeKey[] = [
  "accent",
  "text",
  "subtle",
  "inactive",
  "success",
  "error",
  "warning",
  "permission",
  "promptBorder",
  "userMessageBackground",
  "planMode",
  "autoAccept",
  "dangerMode",
  "diffAdded",
  "diffRemoved",
];

describe("theme.ts", () => {
  test("every expected semantic key exists", () => {
    for (const key of EXPECTED_KEYS) {
      expect(theme[key]).toBeDefined();
    }
  });

  test("has no unexpected extra keys", () => {
    expect(Object.keys(theme).sort()).toEqual([...EXPECTED_KEYS].sort());
  });

  test("accent is Norma's blue, not CC's burnt-orange brand color", () => {
    expect(theme.accent).toBe("#73BFFF");
  });

  test("every value is a 6-digit uppercase hex string", () => {
    for (const key of EXPECTED_KEYS) {
      expect(theme[key]).toMatch(/^#[0-9A-F]{6}$/);
    }
  });
});
