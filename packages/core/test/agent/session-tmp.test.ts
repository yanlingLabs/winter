import { describe, expect, test, afterEach } from "bun:test";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionTmpDir } from "../../src/agent/session-tmp";

afterEach(() => { delete process.env.WINTER_TMPDIR; });

describe("sessionTmpDir", () => {
  test("creates a stable realpath'd dir per session id", () => {
    const a = sessionTmpDir("s_abc");
    const a2 = sessionTmpDir("s_abc");
    const b = sessionTmpDir("s_def");
    expect(existsSync(a)).toBe(true);
    expect(a).toBe(a2);          // stable
    expect(a).toBe(realpathSync(a)); // canonical
    expect(a).not.toBe(b);
  });

  test("rejects a sessionId with path-traversal characters", () => {
    expect(() => sessionTmpDir("a/../../etc-poc")).toThrow(/invalid sessionId/);
    expect(() => sessionTmpDir("../evil")).toThrow(/invalid sessionId/);
    expect(() => sessionTmpDir("s_ok123")).not.toThrow(); // real session-id shape passes
  });
});

describe("sessionTmpDir WINTER_TMPDIR override", () => {
  test("uses WINTER_TMPDIR as the base when set", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "winter-tmpbase-")));
    process.env.WINTER_TMPDIR = base;
    expect(sessionTmpDir("s1")).toBe(join(base, "winter-session-s1"));
  });
  test("empty WINTER_TMPDIR falls back to os.tmpdir()", () => {
    process.env.WINTER_TMPDIR = "";
    expect(sessionTmpDir("s2")).toBe(join(realpathSync(tmpdir()), "winter-session-s2"));
  });
  test("unset → os.tmpdir()", () => {
    expect(sessionTmpDir("s3")).toBe(join(realpathSync(tmpdir()), "winter-session-s3"));
  });
  test("fix-wave D: whitespace-only WINTER_TMPDIR falls back to os.tmpdir() (blank is treated as unset, not used verbatim)", () => {
    process.env.WINTER_TMPDIR = "   ";
    expect(sessionTmpDir("s4")).toBe(join(realpathSync(tmpdir()), "winter-session-s4"));
  });
});
