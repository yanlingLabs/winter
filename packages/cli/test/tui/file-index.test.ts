/** Phase 3d Task 3 — `fuzzyMatch` (pure ranking) + `buildFileIndex` (the one fs-touching piece)
 *  backing the composer's "@"-file mention menu. `buildFileIndex`'s suite builds real fixture
 *  trees under a fresh `mkdtemp` scratch dir per test (same convention as plugin-cli.test.ts /
 *  composer.test.tsx's `historyPath()`), always cleaned up in a `finally` so a failing assertion
 *  never leaks a temp dir. */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFileIndex, fuzzyMatch } from "../../src/tui/file-index";

describe("fuzzyMatch", () => {
  test("empty query returns the first `limit` candidates, unranked and in their original order", () => {
    expect(fuzzyMatch("", ["z.ts", "a.ts", "m.ts"], 2)).toEqual(["z.ts", "a.ts"]);
  });

  test("filters out candidates that aren't a subsequence of the query", () => {
    const candidates = ["src/tui/composer.tsx", "src/tui/footer.tsx", "readme.md"];
    expect(fuzzyMatch("cmp", candidates)).toEqual(["src/tui/composer.tsx"]);
  });

  test("a basename PREFIX match outranks a basename CONTAINS match, which outranks neither", () => {
    const bonus2 = "src/tui/app.tsx"; // basename "app.tsx" starts with "app"
    const bonus1 = "src/tui/wrapper-app.ts"; // basename contains "app", not a prefix
    const bonus0 = "src/mapping/util.ts"; // basename "util.ts" has no "app" at all
    expect(fuzzyMatch("app", [bonus0, bonus1, bonus2])).toEqual([bonus2, bonus1, bonus0]);
  });

  test("within the same basename-bonus tier, the longer contiguous run ranks first", () => {
    // Both basenames lack "tui" entirely (bonus 0 for both) — one only matches as a scattered
    // subsequence (run length 1), the other has "tui" as one unbroken run (run length 3).
    const scattered = "packages/t-u-i-ish/thing.ts";
    const contiguous = "packages/tui/extra/random.ts";
    expect(fuzzyMatch("tui", [scattered, contiguous])).toEqual([contiguous, scattered]);
  });

  test("equal bonus and run: the shorter overall path ranks first", () => {
    const shorter = "a/log.ts";
    const longer = "aa/bb/log.ts";
    expect(fuzzyMatch("log", [longer, shorter])).toEqual([shorter, longer]);
  });

  test("a true tie (equal bonus, run, and length) preserves the candidates' original relative order", () => {
    const candidates = ["x/log1.ts", "y/log2.ts", "z/log3.ts"]; // identical shape, same length
    expect(fuzzyMatch("log", candidates)).toEqual(candidates);
  });

  test("limit caps the result to the top-ranked N, dropping lower-ranked (and non-matching) entries", () => {
    const top = "a/run.ts"; // basename prefix — bonus 2
    const mid = "b/prerun.ts"; // basename contains, not prefix — bonus 1
    const low = "c/x/r-u-n.ts"; // scattered subsequence only — bonus 0, run 1
    const noMatch = "d/nomatch.ts"; // no "r" at all — filtered out entirely
    expect(fuzzyMatch("run", [low, noMatch, mid, top], 2)).toEqual([top, mid]);
  });
});

describe("buildFileIndex", () => {
  function makeFixtureRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "winter-file-index-"));
    writeFileSync(join(root, "a.ts"), "");
    writeFileSync(join(root, "b.md"), "");
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "c.ts"), "");
    mkdirSync(join(root, "sub", "deeper"));
    writeFileSync(join(root, "sub", "deeper", "d.ts"), "");
    // Everything below must be skipped entirely — neither their names nor their contents appear.
    for (const skippedDir of ["node_modules", ".git", "dist", ".build", "DerivedData", ".hidden"]) {
      mkdirSync(join(root, skippedDir));
      writeFileSync(join(root, skippedDir, "skip.ts"), "");
    }
    return root;
  }

  test("walks a nested tree, skipping .git/node_modules/dist/.build/DerivedData + any dot-directory", async () => {
    const root = makeFixtureRoot();
    try {
      const files = await buildFileIndex(root);
      expect(files).toEqual(["a.ts", "b.md", "sub/c.ts", "sub/deeper/d.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the returned list is sorted, regardless of on-disk creation order", async () => {
    const root = mkdtempSync(join(tmpdir(), "winter-file-index-sort-"));
    try {
      writeFileSync(join(root, "zeta.ts"), "");
      writeFileSync(join(root, "alpha.ts"), "");
      mkdirSync(join(root, "mid"));
      writeFileSync(join(root, "mid", "beta.ts"), "");
      const files = await buildFileIndex(root);
      expect(files).toEqual(["alpha.ts", "mid/beta.ts", "zeta.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("caps at maxEntries and stops walking once the cap is hit", async () => {
    const root = mkdtempSync(join(tmpdir(), "winter-file-index-cap-"));
    try {
      for (let i = 0; i < 10; i++) writeFileSync(join(root, `f${i}.ts`), "");
      const files = await buildFileIndex(root, { maxEntries: 3 });
      expect(files).toHaveLength(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("default maxEntries (2000) doesn't truncate an ordinary small tree", async () => {
    const root = makeFixtureRoot();
    try {
      const files = await buildFileIndex(root);
      expect(files).toHaveLength(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not follow a symlinked directory (loop safety) — its contents never appear", async () => {
    const root = mkdtempSync(join(tmpdir(), "winter-file-index-symlink-"));
    try {
      mkdirSync(join(root, "real"));
      writeFileSync(join(root, "real", "x.ts"), "");
      symlinkSync(join(root, "real"), join(root, "linked"), "dir");
      const files = await buildFileIndex(root);
      expect(files).toEqual(["real/x.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("never throws on an unreadable subdirectory — skips it and still returns the rest of the tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "winter-file-index-unreadable-"));
    const blocked = join(root, "blocked");
    mkdirSync(blocked);
    writeFileSync(join(blocked, "secret.ts"), "");
    writeFileSync(join(root, "visible.ts"), "");
    // Running as root (some CI containers) ignores directory permission bits entirely — the "never
    // throws" guarantee is still exercised unconditionally below, but the "secret.ts is excluded"
    // assertion only holds when permissions are actually enforced.
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    try {
      if (!isRoot) chmodSync(blocked, 0o000);
      let files: string[] = [];
      let threw = false;
      try {
        files = await buildFileIndex(root);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(files).toContain("visible.ts");
      if (!isRoot) expect(files).not.toContain("blocked/secret.ts");
    } finally {
      chmodSync(blocked, 0o755); // restore so the recursive rmSync below can actually clean up
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("never throws when the root itself doesn't exist", async () => {
    const missing = join(tmpdir(), "winter-file-index-does-not-exist-", String(Math.random()));
    let files: string[] = [];
    let threw = false;
    try {
      files = await buildFileIndex(missing);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(files).toEqual([]);
  });
});
