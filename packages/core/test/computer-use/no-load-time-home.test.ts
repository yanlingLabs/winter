import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import ts from "typescript";

// Every process of the `winter-core` binary loads the whole daemon graph at start — the sandboxed automation worker
// (`computer-use/worker-host.ts`) too, whose environment is `{ PATH }` only and whose seatbelt refuses the user
// lookup. A `homedir()` (or `userInfo()`) evaluated at module load throws there (`ENOENT … uv_os_homedir`) and the
// worker never starts: every ComputerV2 call fails `HelperUnavailable` (2026-10-19, `usage/wiring.ts`'s install
// lists). `verify:automation-worker` catches it on a real compile; this catches it in `bun test`, on any host.

const REPO = join(import.meta.dir, "..", "..", "..", "..");
const ROOTS = ["packages/core/src", "packages/cli/src", "packages/protocol/src"];
const USER_LOOKUPS = new Set(["homedir", "userInfo"]);

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.(test|d)\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Runs only when called: inside a function, or an instance field (set at construction). */
function deferred(node: ts.Node): boolean {
  for (let p = node.parent; p !== undefined; p = p.parent) {
    if (ts.isFunctionLike(p)) return true;
    if (ts.isPropertyDeclaration(p) && !(ts.getCombinedModifierFlags(p) & ts.ModifierFlags.Static)) return true;
  }
  return false;
}

function loadTimeLookups(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
      if (name !== undefined && USER_LOOKUPS.has(name) && !deferred(node)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        hits.push(`${relative(REPO, file)}:${line + 1} ${name}()`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe("no module looks up the user's home at load (the automation worker has none)", () => {
  test("every homedir()/userInfo() in the daemon, CLI and protocol sources runs only when called", () => {
    const hits = ROOTS.flatMap((r) => sources(join(REPO, r))).flatMap(loadTimeLookups);
    expect(hits).toEqual([]);
  });

  test("the scan sees a load-time call, and not one behind a function or a default parameter", () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-no-load-time-home-"));
    const bad = join(dir, "bad.ts");
    const good = join(dir, "good.ts");
    writeFileSync(bad, `import { homedir } from "node:os";\nexport const A = [homedir()];\nclass K { static s = homedir(); }\n`);
    writeFileSync(good, `import os, { homedir } from "node:os";\nexport const a = (h = homedir()) => h;\nexport function b() { return os.homedir(); }\nclass K { i = os.userInfo(); }\n`);
    try {
      expect(loadTimeLookups(bad).map((h) => h.replace(/^.*bad\.ts/, "bad.ts"))).toEqual(["bad.ts:2 homedir()", "bad.ts:3 homedir()"]);
      expect(loadTimeLookups(good)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
