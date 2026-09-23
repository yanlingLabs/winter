// WS-21 L3.6 (spec §7.2): the protected paths, and the §7.1 hook rows that sit beside them.
//
//   protected  the trusted project's `.winter/{skills,commands,rules,output-styles}/**`,
//              `sdk/{skills,commands,rules,output-styles}/**` and `sdk/WINTER.md`
//   a write    code → a card under every policy; chat and dispatch → a typed deny
//
// The set is pinned against the LITERAL list spec §7.2 names, spelled the way L2's
// `protectedPathRules` (`winter-runtime-sdk` `src/run-home/types.ts` at 53784ad) spells it — claude's
// absolute form, `//` + the absolute path, built with the daemon's own `fsRootAnchored` (ruling 2).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  protectedPathsFor, protectedReadDenial, protectedWriteDecision, storeWriteDenial,
} from "../../src/runtime-sdk/protected-paths";

const real = (p: string): string => realpathSync(mkdtempSync(join(tmpdir(), p)));

describe("protectedPathsFor — spec §7.2's literal set, in claude's absolute spelling", () => {
  test("no trusted project: the sdk tier alone", () => {
    expect(protectedPathsFor("/Users/x/.winter", null)).toEqual([
      "//Users/x/.winter/sdk/skills/**",
      "//Users/x/.winter/sdk/commands/**",
      "//Users/x/.winter/sdk/rules/**",
      "//Users/x/.winter/sdk/output-styles/**",
      "//Users/x/.winter/sdk/WINTER.md",
    ]);
  });

  test("a trusted project adds its .winter/{skills,commands,rules,output-styles}; <root>/WINTER.md stays ordinary", () => {
    const set = protectedPathsFor("/Users/x/.winter", "/Users/x/code/app");
    expect(set).toEqual([
      "//Users/x/.winter/sdk/skills/**",
      "//Users/x/.winter/sdk/commands/**",
      "//Users/x/.winter/sdk/rules/**",
      "//Users/x/.winter/sdk/output-styles/**",
      "//Users/x/.winter/sdk/WINTER.md",
      "//Users/x/code/app/.winter/skills/**",
      "//Users/x/code/app/.winter/commands/**",
      "//Users/x/code/app/.winter/rules/**",
      "//Users/x/code/app/.winter/output-styles/**",
    ]);
    expect(set).not.toContain("//Users/x/code/app/WINTER.md");
  });

  test("as Edit/Write rules it is exactly the router's protectedPathRules output (hand mirror at 53784ad)", () => {
    const rules = ["Edit", "Write"].flatMap((t) => protectedPathsFor("/h", "/r").map((p) => `${t}(${p})`));
    const routerMirror = ["Edit", "Write"].flatMap((t) => [
      "//h/sdk/skills/**", "//h/sdk/commands/**", "//h/sdk/rules/**", "//h/sdk/output-styles/**", "//h/sdk/WINTER.md",
      "//r/.winter/skills/**", "//r/.winter/commands/**", "//r/.winter/rules/**", "//r/.winter/output-styles/**",
    ].map((p) => `${t}(${p})`));
    expect(rules).toEqual(routerMirror);
  });
});

describe("protectedWriteDecision", () => {
  const home = "/Users/x/.winter";
  const root = "/Users/x/code/app";
  const set = protectedPathsFor(home, root);

  test("code → ask, whatever the policy (the hook knows no policy: accept-edits and bypass reach it the same)", () => {
    for (const [tool, input] of [
      ["Write", { file_path: `${root}/.winter/skills/deploy/SKILL.md`, content: "x" }],
      ["Edit", { file_path: `${home}/sdk/WINTER.md`, old_string: "a", new_string: "b" }],
      ["MultiEdit", { file_path: "/tmp/ok.txt", edits: [{ file_path: `${home}/sdk/rules/style.md` }] }],
      ["NotebookEdit", { notebook_path: `${root}/.winter/commands/n.ipynb` }],
      ["write", { path: `${root}/.winter/output-styles/terse.md` }],
    ] as const) {
      expect(protectedWriteDecision(tool, input, { mode: "code", protected: set, cwd: root })).toEqual({ decision: "ask" });
    }
  });

  test("chat and dispatch → a typed deny naming the path", () => {
    for (const mode of ["chat", "dispatch"] as const) {
      const d = protectedWriteDecision("Write", { file_path: `${root}/.winter/rules/a.md` }, { mode, protected: set, cwd: root });
      expect(d?.decision).toBe("deny");
      expect((d as { reason: string }).reason).toContain(".winter/rules/a.md");
    }
  });

  test("an .envrc-named protected file is still an ask (claude's own sensitive-file check must not swallow it — F16)", () => {
    expect(protectedWriteDecision("Write", { file_path: `${root}/.winter/skills/x/.envrc` }, { mode: "code", protected: set, cwd: root })).toEqual({ decision: "ask" });
  });

  test("a relative target resolves against the cwd", () => {
    expect(protectedWriteDecision("Write", { file_path: ".winter/skills/a/SKILL.md" }, { mode: "code", protected: set, cwd: root })).toEqual({ decision: "ask" });
  });

  test("case-folded (a default macOS volume is case-insensitive)", () => {
    expect(protectedWriteDecision("Write", { file_path: `${root}/.WINTER/Skills/a.md` }, { mode: "code", protected: set, cwd: root })).toEqual({ decision: "ask" });
  });

  test("not protected: <root>/WINTER.md, an untrusted project's .winter/skills, reads, the memory dir", () => {
    const untrusted = protectedPathsFor(home, null);
    expect(protectedWriteDecision("Write", { file_path: `${root}/WINTER.md` }, { mode: "code", protected: set, cwd: root })).toBeNull();
    expect(protectedWriteDecision("Write", { file_path: `${root}/.winter/skills/a.md` }, { mode: "code", protected: untrusted, cwd: root })).toBeNull();
    expect(protectedWriteDecision("Read", { file_path: `${root}/.winter/skills/a.md` }, { mode: "code", protected: set, cwd: root })).toBeNull();
    expect(protectedWriteDecision("Write", { file_path: `${home}/sdk/projects/k/memory/MEMORY.md` }, { mode: "code", protected: set, cwd: root })).toBeNull();
    expect(protectedWriteDecision("Write", { file_path: `${home}/sdk/skillset/a.md` }, { mode: "code", protected: set, cwd: root })).toBeNull();
  });

  test("a write through a link INTO a protected directory is caught on its canonical spelling", () => {
    const h = real("winter-prot-home-");
    const r = real("winter-prot-root-");
    mkdirSync(join(r, ".winter", "skills"), { recursive: true });
    const alias = join(real("winter-prot-alias-"), "sneaky");
    symlinkSync(join(r, ".winter", "skills"), alias);
    const d = protectedWriteDecision("Write", { file_path: join(alias, "evil", "SKILL.md") }, { mode: "code", protected: protectedPathsFor(h, r), cwd: "/" });
    expect(d).toEqual({ decision: "ask" });
  });
});

describe("storeWriteDenial — spec §7.1: sdk/projects/** is written by the runtimes, never by a tool, except */memory/**", () => {
  const home = "/Users/x/.winter";
  test("a transcript or anything else under sdk/projects is denied, in every mode", () => {
    for (const p of [`${home}/sdk/projects/-Users-x-app/abc.jsonl`, `${home}/sdk/projects/k/subagents/a.jsonl`, `${home}/sdk/projects`]) {
      const d = storeWriteDenial("Write", { file_path: p }, { home, cwd: "/" });
      expect(d).toBeDefined();
      expect(d).toContain("sdk/projects");
    }
  });
  test("the memory directory stays writable", () => {
    expect(storeWriteDenial("Write", { file_path: `${home}/sdk/projects/k/memory/MEMORY.md` }, { home, cwd: "/" })).toBeUndefined();
    expect(storeWriteDenial("Edit", { file_path: `${home}/sdk/projects/k/memory/notes/a.md` }, { home, cwd: "/" })).toBeUndefined();
  });
  test("reads are not this function's business; neither is anything outside sdk/projects", () => {
    expect(storeWriteDenial("Read", { file_path: `${home}/sdk/projects/k/a.jsonl` }, { home, cwd: "/" })).toBeUndefined();
    expect(storeWriteDenial("Write", { file_path: `${home}/outputs/s_1/report.md` }, { home, cwd: "/" })).toBeUndefined();
  });
});

describe("protectedReadDenial — spec §7.1's read row (hook half)", () => {
  const home = "/Users/x/.winter";
  const tmp = tmpdir();
  test("sdk/.winter.json and the three config files in any run folder or staging root", () => {
    for (const p of [
      `${home}/sdk/.winter.json`,
      `${home}/cache/runs/2b1c/.winter.json`,
      `${home}/cache/runs/2b1c/.claude.json`,
      `${home}/cache/runs/2b1c/.credentials.json`,
      join(tmp, "claude-resume-8f2a", ".claude.json"),
      join(tmp, "claude-resume-8f2a", ".credentials.json"),
    ]) {
      for (const tool of ["Read", "Grep", "Glob"]) {
        const field = tool === "Read" ? "file_path" : "path";
        expect(protectedReadDenial(tool, { [field]: p }, { home, cwd: "/" })).toBeDefined();
      }
    }
  });
  test("a Grep rooted inside a run folder or at sdk/ is refused too (it would read them)", () => {
    expect(protectedReadDenial("Grep", { path: `${home}/cache/runs/2b1c`, pattern: "token" }, { home, cwd: "/" })).toBeDefined();
    expect(protectedReadDenial("Grep", { path: `${home}/sdk`, pattern: "token" }, { home, cwd: "/" })).toBeDefined();
  });
  test("ordinary reads stay free", () => {
    expect(protectedReadDenial("Read", { file_path: `${home}/sdk/settings.json` }, { home, cwd: "/" })).toBeUndefined();
    expect(protectedReadDenial("Read", { file_path: `${home}/cache/runs/2b1c/skills/a/SKILL.md` }, { home, cwd: "/" })).toBeUndefined();
    expect(protectedReadDenial("Read", { file_path: "/Users/x/code/app/.winter.json" }, { home, cwd: "/" })).toBeUndefined();
    expect(protectedReadDenial("Grep", { path: "/Users/x/code/app", pattern: "x" }, { home, cwd: "/" })).toBeUndefined();
    expect(protectedReadDenial("Write", { file_path: `${home}/sdk/.winter.json` }, { home, cwd: "/" })).toBeUndefined();
  });
});
