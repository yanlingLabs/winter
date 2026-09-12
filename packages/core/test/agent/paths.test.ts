import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWithinAny, resolveWithin, canonicalizeForWrite, resolveLeafSymlinks } from "../../src/agent/paths";

function realDir(): string { return realpathSync(mkdtempSync(join(tmpdir(), "winter-paths-"))); }

describe("resolveWithinAny", () => {
  test("allows a path inside any of the roots", () => {
    const a = realDir(); const b = realDir();
    writeFileSync(join(a, "x.txt"), ""); writeFileSync(join(b, "y.txt"), "");
    expect(resolveWithinAny([a, b], join(a, "x.txt"))).toBe(join(a, "x.txt"));
    expect(resolveWithinAny([a, b], join(b, "y.txt"))).toBe(join(b, "y.txt"));
    expect(resolveWithinAny([a, b], "x.txt")).toBe(join(a, "x.txt")); // relative → roots[0]
  });

  test("rejects a path outside every root", () => {
    const a = realDir(); const outside = realDir();
    expect(() => resolveWithinAny([a], join(outside, "z.txt"))).toThrow(/outside the allowed directories/);
    expect(() => resolveWithinAny([a], "/etc/passwd")).toThrow(/outside the allowed directories/);
  });

  test("prefix-collision roots are not confused (/tmp/foo vs /tmp/foobar)", () => {
    const base = realDir();
    mkdirSync(join(base, "foo")); mkdirSync(join(base, "foobar"));
    const foo = join(base, "foo");
    expect(() => resolveWithinAny([foo], join(base, "foobar", "f.txt"))).toThrow(/outside/);
  });

  test("resolveWithin remains a single-root wrapper", () => {
    const a = realDir();
    expect(resolveWithin(a, "q.txt")).toBe(join(a, "q.txt"));
    expect(() => resolveWithin(a, "/etc/hosts")).toThrow(/outside/);
  });

  // Regression (S1): exit_worktree {remove} deletes the worktree dir from disk but it lingers in
  // SessionDirectories' `added` set (no remove() existed). A naive `roots.map(realpathSync)` up
  // front then throws ENOENT for that one vanished root — bricking resolution against every OTHER
  // (still-valid) root, i.e. every fs tool for the rest of the session. A vanished root must be
  // skipped, not fatal.
  test("a vanished/nonexistent root does not break resolution against the other, valid roots", () => {
    const a = realDir();
    writeFileSync(join(a, "x.txt"), "");
    const ghost = join(a, "..", "winter-vanished-root-" + Date.now());
    expect(() => resolveWithinAny([a, ghost], "x.txt")).not.toThrow();
    expect(resolveWithinAny([a, ghost], "x.txt")).toBe(join(a, "x.txt"));
    expect(resolveWithinAny([a, ghost], join(a, "x.txt"))).toBe(join(a, "x.txt"));
    // order shouldn't matter — the ghost root can be first too
    expect(resolveWithinAny([ghost, a], join(a, "x.txt"))).toBe(join(a, "x.txt"));
  });

  // task-24 review F4 (pre-existing fence hole): a DANGLING in-root symlink whose target is a
  // nonexistent file in an EXISTING outside directory used to pass containment — realpathSync on
  // the leaf threw ENOENT, so canonAncestor retreated to the link's (in-root) parent and never
  // looked at where the link points; the subsequent write then followed the link and landed
  // OUTSIDE every root, reviewer-less and card-less. The leaf's link chain is now resolved first.
  describe("dangling-symlink leaf hardening (task-24 review F4)", () => {
    test("in-root dangling symlink → existing OUTSIDE dir: REJECTED (the exact escape repro)", () => {
      const root = realDir(); const outside = realDir();
      symlinkSync(join(outside, "pwned.txt"), join(root, "innocent.txt")); // dangling: pwned.txt doesn't exist
      expect(() => resolveWithinAny([root], join(root, "innocent.txt"))).toThrow(/outside the allowed directories/);
      expect(() => resolveWithinAny([root], "innocent.txt")).toThrow(/outside the allowed directories/); // relative spelling too
    });

    test("in-root dangling symlink → in-root nonexistent target: still allowed (unchanged)", () => {
      const root = realDir();
      symlinkSync(join(root, "not-yet.txt"), join(root, "link.txt"));
      expect(resolveWithinAny([root], join(root, "link.txt"))).toBe(join(root, "link.txt"));
    });

    test("in-root NON-dangling symlink → in-root existing target: still allowed (unchanged)", () => {
      const root = realDir();
      writeFileSync(join(root, "real.txt"), "");
      symlinkSync(join(root, "real.txt"), join(root, "alias.txt"));
      expect(resolveWithinAny([root], join(root, "alias.txt"))).toBe(join(root, "alias.txt"));
    });

    test("link CHAIN to an outside dangling target is followed hop by hop and rejected; a chain past the depth cap is rejected outright (fail-closed)", () => {
      const root = realDir(); const outside = realDir();
      // 3-hop chain ending in a dangling link out of root:
      symlinkSync(join(outside, "gone.txt"), join(root, "c2"));
      symlinkSync(join(root, "c2"), join(root, "c1"));
      symlinkSync(join(root, "c1"), join(root, "c0"));
      expect(() => resolveWithinAny([root], join(root, "c0"))).toThrow(/outside the allowed directories/);
      // 9-hop chain (cap is 8) — every hop in-root, so ONLY the cap can reject it:
      symlinkSync(join(root, "deep-missing.txt"), join(root, "d8"));
      for (let i = 7; i >= 0; i--) symlinkSync(join(root, `d${i + 1}`), join(root, `d${i}`));
      expect(() => resolveWithinAny([root], join(root, "d0"))).toThrow(/too many levels of symbolic links/);
      // link CYCLE: a→b→a — terminated by the same cap, not an infinite loop:
      symlinkSync(join(root, "cycle-b"), join(root, "cycle-a"));
      symlinkSync(join(root, "cycle-a"), join(root, "cycle-b"));
      expect(() => resolveWithinAny([root], join(root, "cycle-a"))).toThrow(/too many levels of symbolic links/);
    });

    test("resolveLeafSymlinks: non-links and wholly nonexistent paths pass through unchanged; relative link text resolves against the link's own directory", () => {
      const root = realDir();
      writeFileSync(join(root, "plain.txt"), "");
      expect(resolveLeafSymlinks(join(root, "plain.txt"))).toBe(join(root, "plain.txt"));
      expect(resolveLeafSymlinks(join(root, "never-existed.txt"))).toBe(join(root, "never-existed.txt"));
      mkdirSync(join(root, "sub"));
      symlinkSync(join("..", "target.txt"), join(root, "sub", "rel-link")); // relative link text
      expect(resolveLeafSymlinks(join(root, "sub", "rel-link"))).toBe(join(root, "target.txt"));
    });
  });
});

// 5e T3 review fix: canonical location for a possibly-not-yet-existing WRITE target. A bare
// realpathSync throws on a missing file; a raw fallback keeps the PRE-symlink text — this must
// return where the bytes would actually land.
describe("canonicalizeForWrite", () => {
  test("existing file → plain realpath", () => {
    const a = realDir();
    writeFileSync(join(a, "x.txt"), "");
    expect(canonicalizeForWrite(join(a, "x.txt"))).toBe(join(a, "x.txt"));
  });

  test("new file under an existing dir → realpathed dir + raw tail", () => {
    const a = realDir();
    expect(canonicalizeForWrite(join(a, "new.txt"))).toBe(join(a, "new.txt"));
    // multiple missing tail segments re-appended in order:
    expect(canonicalizeForWrite(join(a, "sub", "deeper", "new.txt"))).toBe(join(a, "sub", "deeper", "new.txt"));
  });

  test("new file through a symlinked dir → symlink RESOLVED, tail re-appended (the review-bypass case)", () => {
    const a = realDir(); const b = realDir();
    symlinkSync(b, join(a, "link"));
    expect(canonicalizeForWrite(join(a, "link", "new.txt"))).toBe(join(b, "new.txt"));
    expect(canonicalizeForWrite(join(a, "link", "sub", "new.txt"))).toBe(join(b, "sub", "new.txt"));
  });

  test("existing file through a symlinked dir → fully resolved", () => {
    const a = realDir(); const b = realDir();
    writeFileSync(join(b, "cfg.txt"), "");
    symlinkSync(b, join(a, "link"));
    expect(canonicalizeForWrite(join(a, "link", "cfg.txt"))).toBe(join(b, "cfg.txt"));
  });
});
