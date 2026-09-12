import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { appendHistory, loadHistory, makeHistoryNav } from "../../src/tui/history-store";

const tmpFile = (name = "history.jsonl"): string => join(mkdtempSync(join(tmpdir(), "winter-history-")), name);

describe("history-store", () => {
  describe("appendHistory + loadHistory round-trip", () => {
    test("appended entries load back newest-first", () => {
      const path = tmpFile();
      appendHistory(path, { display: "first", ts: 1, sessionId: "s1" });
      appendHistory(path, { display: "second", ts: 2, sessionId: "s1" });
      appendHistory(path, { display: "third", ts: 3, sessionId: "s1" });

      expect(loadHistory(path, "s1")).toEqual(["third", "second", "first"]);
    });

    test("missing file loads as empty, never throws", () => {
      const path = join(mkdtempSync(join(tmpdir(), "winter-history-")), "does-not-exist.jsonl");
      expect(loadHistory(path, "s1")).toEqual([]);
    });

    test("appendHistory never throws even against an unwritable path", () => {
      const path = join(tmpdir(), "winter-history-missing-dir", "nested", "history.jsonl");
      expect(() => appendHistory(path, { display: "x", ts: 1, sessionId: "s1" })).not.toThrow();
    });

    test("max caps the returned count", () => {
      const path = tmpFile();
      for (let i = 0; i < 10; i++) appendHistory(path, { display: `entry-${i}`, ts: i, sessionId: "s1" });
      expect(loadHistory(path, "s1", 3)).toEqual(["entry-9", "entry-8", "entry-7"]);
    });
  });

  describe("session priority", () => {
    test("this session's entries come before other sessions', each group newest-first", () => {
      const path = tmpFile();
      appendHistory(path, { display: "other-1", ts: 1, sessionId: "other" });
      appendHistory(path, { display: "mine-1", ts: 2, sessionId: "mine" });
      appendHistory(path, { display: "other-2", ts: 3, sessionId: "other" });
      appendHistory(path, { display: "mine-2", ts: 4, sessionId: "mine" });

      expect(loadHistory(path, "mine")).toEqual(["mine-2", "mine-1", "other-2", "other-1"]);
    });
  });

  describe("corrupt-line tolerance", () => {
    test("skips garbled JSON, blank lines, and wrong-shape entries without throwing", () => {
      const path = tmpFile();
      const lines = [
        JSON.stringify({ display: "ok-1", ts: 1, sessionId: "s1" }),
        "not json at all {{{",
        "",
        "   ",
        JSON.stringify({ ts: 2, sessionId: "s1" }), // missing `display`
        JSON.stringify(42), // not an object
        JSON.stringify({ display: "ok-2", ts: 3, sessionId: "s1" }),
      ];
      writeFileSync(path, lines.join("\n"));

      expect(() => loadHistory(path, "s1")).not.toThrow();
      expect(loadHistory(path, "s1")).toEqual(["ok-2", "ok-1"]);
    });
  });

  describe("makeHistoryNav", () => {
    test("up() from live input saves the draft and returns the newest entry", () => {
      const nav = makeHistoryNav(["c", "b", "a"]); // newest-first
      expect(nav.up("my draft")).toBe("c");
    });

    test("subsequent up() calls walk older entries", () => {
      const nav = makeHistoryNav(["c", "b", "a"]);
      nav.up("draft");
      expect(nav.up("draft")).toBe("b");
      expect(nav.up("draft")).toBe("a");
    });

    test("up() past the oldest entry returns null (no move)", () => {
      const nav = makeHistoryNav(["c", "b", "a"]);
      nav.up("draft");
      nav.up("draft");
      nav.up("draft"); // now at "a", the oldest
      expect(nav.up("draft")).toBeNull();
    });

    test("up() with no entries always returns null", () => {
      const nav = makeHistoryNav([]);
      expect(nav.up("draft")).toBeNull();
    });

    test("down() with no prior up() returns null (nothing to move from)", () => {
      const nav = makeHistoryNav(["c", "b", "a"]);
      expect(nav.down()).toBeNull();
    });

    test("down() walks newer, then restores the saved draft, then null beyond", () => {
      const nav = makeHistoryNav(["c", "b", "a"]);
      nav.up("my draft"); // -> "c"
      nav.up("my draft"); // -> "b"
      expect(nav.down()).toBe("c");
      expect(nav.down()).toBe("my draft"); // past the newest — restores the draft
      expect(nav.down()).toBeNull(); // already at the draft — no further move
    });

    test("a fresh up() after returning to the draft starts over at the newest entry", () => {
      const nav = makeHistoryNav(["c", "b", "a"]);
      nav.up("draft-1");
      expect(nav.down()).toBe("draft-1");
      expect(nav.up("draft-2")).toBe("c");
    });
  });
});
