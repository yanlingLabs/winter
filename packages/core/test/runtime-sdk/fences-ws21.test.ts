// WS-21 L3.6 (spec §7.1): every row of the enforcement table × every mechanism it names.
//
//   deny rules   `controlPlaneDenyRules(home)` — claude-grammar `Tool(//abs)` rules on both legs
//   sandbox      `sandboxConfigFor(home, cwd).filesystem` — real paths (a file is its own subpath)
//   escape floor `escapeFloorHit(command, home)` — any mention, or write-shaped only
//   hook         the path fence (`protected-paths.ts`; driven end to end in `path-fence.test.ts`)
//
// The table's "real path + regex denyRead" for the run-folder files has no regex channel in either
// SDK's `SandboxSettingsConfig` (string subpaths only); the rule and hook layers carry that row
// (DECISION 12 / SPEC CONCERN in the lane report).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESUME_STAGING_PREFIX } from "@yanlinglabs/winter-runtime-sdk";
import { escapeRulePath } from "@yanlinglabs/winter-runtime-sdk";
import { controlPlaneDenyRules, sandboxConfigFor } from "../../src/runtime-sdk/mode-options";
import { escapeFloorHit } from "../../src/runtime-sdk/hooks";
import { homeFencedDirs } from "../../src/runtime-sdk/home-fence";
import { storeWriteDenial, protectedReadDenial } from "../../src/runtime-sdk/protected-paths";
import { controlPlaneTargetForCall } from "../../src/runtime-sdk/control-plane";
import { homeFenceFor } from "../../src/runtime-sdk/home-fence";

const H = "/Users/x/.winter";
const rules = controlPlaneDenyRules(H);
const writeRule = (target: string) => ["Edit", "Write", "MultiEdit", "NotebookEdit"].every((t) => rules.includes(`${t}(${target})`));
const readRule = (target: string) => ["Read", "Glob", "Grep"].every((t) => rules.includes(`${t}(${target})`));

function project(): { cwd: string; root: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "winter-fences-root-")));
  Bun.spawnSync(["git", "-C", root, "init", "-q"]);
  const cwd = join(root, "packages", "app");
  mkdirSync(cwd, { recursive: true });
  return { cwd, root };
}

describe("writes: sdk/settings.json, sdk/.winter.json, sdk/agents/** — rules ✓, sandbox real path, floor any mention", () => {
  test("deny rules", () => {
    expect(writeRule(`/${H}/sdk/settings.json`)).toBe(true);
    expect(writeRule(`/${H}/sdk/.winter.json`)).toBe(true);
    expect(writeRule(`/${H}/sdk/agents/**`)).toBe(true);
  });
  test("sandbox denyWrite (real paths, with or without a cwd)", () => {
    for (const cfg of [sandboxConfigFor(H), sandboxConfigFor(H, "/Users/x/code")]) {
      const w = cfg.filesystem!.denyWrite!;
      expect(w).toEqual(expect.arrayContaining([`${H}/sdk/settings.json`, `${H}/sdk/.winter.json`, `${H}/sdk/agents`]));
    }
  });
  test("escape floor: ANY mention", () => {
    expect(escapeFloorHit(`cat ${H}/sdk/settings.json`, H)).toBeDefined();
    expect(escapeFloorHit("cat ~/.winter/sdk/.winter.json", H)).toBeDefined();
    expect(escapeFloorHit(`ls ${H}/sdk/agents`, H)).toBeDefined();
    expect(escapeFloorHit(`cd ${H}/sdk && cat .winter.json`, H)).toBeDefined();
  });
});

describe("writes: sdk/plugins/** — rules ✓, sandbox real path, floor write-shaped only", () => {
  test("deny rules and sandbox", () => {
    expect(writeRule(`/${H}/sdk/plugins/**`)).toBe(true);
    expect(sandboxConfigFor(H).filesystem!.denyWrite).toContain(`${H}/sdk/plugins`);
  });
  test("escape floor: a read or a skill script runs; a write-shaped use is refused (multi-segment prefix)", () => {
    expect(escapeFloorHit(`cat ${H}/sdk/plugins/p/skills/a/SKILL.md`, H)).toBeUndefined();
    expect(escapeFloorHit(`bash ${H}/sdk/plugins/p/skills/a/run.sh`, H)).toBeUndefined();
    expect(escapeFloorHit(`cp evil.json ${H}/sdk/plugins/p/.claude-plugin/plugin.json`, H)).toBeDefined();
    expect(escapeFloorHit(`echo x > ~/.winter/sdk/plugins/p/hooks.json`, H)).toBeDefined();
  });
  test("the home fence (write tools) derives it from the sandbox list", () => {
    expect(homeFencedDirs(H)).toEqual(expect.arrayContaining([`${H}/sdk/plugins`, `${H}/sdk/settings.json`, `${H}/sdk/.winter.json`, `${H}/sdk/agents`]));
  });
});

describe("writes: sdk/projects/** except */memory/** — no rule, not allowlisted, floor write-shaped outside memory/, hook deny", () => {
  test("no deny rule over the store (memory must stay writable), and the sandbox does not deny it wholesale", () => {
    expect(rules.some((r) => r.includes("/sdk/projects"))).toBe(false);
    expect(sandboxConfigFor(H).filesystem!.denyWrite!.some((p) => p.startsWith(`${H}/sdk/projects`))).toBe(false);
  });
  test("escape floor", () => {
    expect(escapeFloorHit(`echo x >> ${H}/sdk/projects/-Users-x-app/abc.jsonl`, H)).toBeDefined();
    expect(escapeFloorHit(`rm -rf ~/.winter/sdk/projects`, H)).toBeDefined();
    expect(escapeFloorHit(`echo note >> ${H}/sdk/projects/-Users-x-app/memory/MEMORY.md`, H)).toBeUndefined();
    expect(escapeFloorHit(`cat ${H}/sdk/projects/-Users-x-app/abc.jsonl`, H)).toBeUndefined();
  });
  test("review M2: the compat-link spelling <home>/projects is the same store", () => {
    expect(escapeFloorHit("echo x >> ~/.winter/projects/-Users-x-app/abc.jsonl", H)).toBeDefined();
    expect(escapeFloorHit(`rm -rf ${H}/projects`, H)).toBeDefined();
    expect(escapeFloorHit("echo note >> ~/.winter/projects/-Users-x-app/memory/MEMORY.md", H)).toBeUndefined();
    expect(escapeFloorHit("cat ~/.winter/projects/-Users-x-app/abc.jsonl", H)).toBeUndefined();
  });
  test("hook", () => {
    expect(storeWriteDenial("Write", { file_path: `${H}/sdk/projects/k/a.jsonl` }, { home: H })).toBeDefined();
    expect(storeWriteDenial("Write", { file_path: `${H}/sdk/projects/k/memory/a.md` }, { home: H })).toBeUndefined();
  });
});

describe("writes: **/.winter/mcp.json, **/.winter/settings*.json, **/.winter/agents/** — rules ✓, sandbox <cwd>+<root>, floor write-shaped, hook ✓", () => {
  test("deny rules, at any depth", () => {
    expect(writeRule("//**/.winter/mcp.json")).toBe(true);
    expect(writeRule("//**/.winter/settings*.json")).toBe(true);
    expect(writeRule("//**/.winter/agents/**")).toBe(true);
  });
  test("sandbox: real paths for the session's cwd AND its project root", () => {
    const { cwd, root } = project();
    const w = sandboxConfigFor(H, cwd).filesystem!.denyWrite!;
    for (const base of [cwd, root]) {
      for (const f of ["mcp.json", "settings.json", "settings.local.json", "agents"]) expect(w).toContain(join(base, ".winter", f));
    }
  });
  test("sandbox: the protected project subdirectories too, so a Bash write has to go through a tool and its card (§7.2)", () => {
    const { cwd, root } = project();
    const w = sandboxConfigFor(H, cwd).filesystem!.denyWrite!;
    for (const base of [cwd, root]) {
      for (const d of ["skills", "commands", "rules", "output-styles"]) expect(w).toContain(join(base, ".winter", d));
    }
    // <root>/WINTER.md stays ordinary, as claude treats CLAUDE.md
    expect(w).not.toContain(join(root, "WINTER.md"));
  });
  test("escape floor: write-shaped for mcp.json and settings*.json; the two claude settings files stay ANY-mention", () => {
    expect(escapeFloorHit("echo '{}' > .winter/mcp.json", H)).toBeDefined();
    expect(escapeFloorHit("cp x.json app/.winter/settings.team.json", H)).toBeDefined();
    expect(escapeFloorHit("cat .winter/mcp.json", H)).toBeUndefined();
    expect(escapeFloorHit("cat .winter/settings.local.json", H)).toBeDefined(); // unchanged, stricter than the table
    expect(escapeFloorHit("ls .winter/agents", H)).toBeDefined();               // unchanged, stricter than the table
  });
  test("hook: the write-tool fence names them", () => {
    for (const f of ["mcp.json", "settings.json", "settings.local.json", "settings.x.json", "agents/a.md"]) {
      expect(controlPlaneTargetForCall("Write", { file_path: `/Users/x/code/app/.winter/${f}` }, "/", homeFenceFor(H))).not.toBeNull();
    }
    expect(controlPlaneTargetForCall("Write", { file_path: "/Users/x/code/app/.winter/rules/a.md" }, "/", homeFenceFor(H))).toBeNull();
  });
});

describe("writes: <home>/cache/** — rules ✓, sandbox real path, floor write-shaped only", () => {
  test("all three, unchanged from before WS-21", () => {
    expect(writeRule(`/${H}/cache/**`)).toBe(true);
    expect(sandboxConfigFor(H).filesystem!.denyWrite).toContain(`${H}/cache`);
    expect(escapeFloorHit(`cat ${H}/cache/runs/r/settings.json`, H)).toBeDefined(); // settings.json: any-mention filename
    expect(escapeFloorHit(`ls ${H}/cache/runs`, H)).toBeUndefined();
    expect(escapeFloorHit(`rm -rf ${H}/cache/quarantine`, H)).toBeDefined();
  });
});

describe("writes: claude-resume-* roots — rule glob, not writable by the sandbox, floor write-shaped, hook ✓", () => {
  const staging = join(tmpdir(), `${RESUME_STAGING_PREFIX}8f2a`);
  test("deny rule glob", () => {
    expect(rules.some((r) => r.startsWith("Write(") && r.includes(`${RESUME_STAGING_PREFIX}*`))).toBe(true);
  });
  test("escape floor: write-shaped", () => {
    expect(escapeFloorHit(`echo x >> ${staging}/projects/k/a.jsonl`, H)).toBeDefined();
    expect(escapeFloorHit(`ls ${tmpdir()}`, H)).toBeUndefined();
  });
  test("hook", () => {
    expect(storeWriteDenial("Write", { file_path: join(staging, "projects", "k", "a.jsonl") }, { home: H })).toBeDefined();
  });
});

describe("reads: sdk/.winter.json and the run-folder/staging config files — rule glob, sandbox real path, hook ✓", () => {
  test("deny rules", () => {
    expect(readRule(`/${H}/sdk/.winter.json`)).toBe(true);
    for (const f of [".winter.json", ".claude.json", ".credentials.json"]) expect(readRule(`/${H}/cache/runs/*/${f}`)).toBe(true);
    // round 6: a staging root's config files (and `backups/`) are read-denied — no longer the whole root
    for (const f of [".winter.json", ".claude.json", ".credentials.json"]) expect(readRule(`/${join(tmpdir(), `${RESUME_STAGING_PREFIX}*`, f)}`)).toBe(true);
  });
  test("sandbox denyRead: sdk/.winter.json as a real path (the regex half has no SDK channel — DECISION 12)", () => {
    expect(sandboxConfigFor(H).filesystem!.denyRead).toContain(`${H}/sdk/.winter.json`);
  });
  test("hook", () => {
    expect(protectedReadDenial("Read", { file_path: `${H}/cache/runs/r/.credentials.json` }, { home: H })).toBeDefined();
  });
});

describe("reads: run/, runtimes/ — unchanged", () => {
  test("rules and sandbox", () => {
    expect(readRule(`/${H}/run/**`)).toBe(true);
    expect(readRule(`/${H}/runtimes/**`)).toBe(true);
    expect(sandboxConfigFor(H).filesystem!.denyRead).toEqual(expect.arrayContaining([`${H}/run`, `${H}/runtimes`]));
  });
});

// Review I7: Bash could write the protected paths with no card — `sdk/{skills,commands,rules,output-styles}`
// and `sdk/WINTER.md` were in neither the sandbox nor the escape floor, and a project's `.winter/<kind>`
// only in the sandbox. A SEPARATE list feeds only the sandbox's denyWrite and a write-shaped floor, so the
// write TOOLS keep the spec's card (the shared list feeds `controlPlaneTargetForCall`'s hard deny).
describe("review I7: protected paths vs Bash", () => {
  const kinds = ["skills", "commands", "rules", "output-styles"];
  test("the sandbox denies them (a sandboxed Bash whose cwd is $HOME included)", () => {
    const w = sandboxConfigFor(H, "/Users/x").filesystem!.denyWrite!;
    for (const k of kinds) expect(w).toContain(`${H}/sdk/${k}`);
    expect(w).toContain(`${H}/sdk/WINTER.md`);
  });
  test("…but NOT through the shared self-grant list: the write tools still get a card, not a hard deny", () => {
    for (const k of kinds) expect(homeFencedDirs(H)).not.toContain(`${H}/sdk/${k}`);
    expect(homeFencedDirs(H)).not.toContain(`${H}/sdk/WINTER.md`);
    expect(controlPlaneTargetForCall("Write", { file_path: `${H}/sdk/skills/x/SKILL.md` }, "/", homeFenceFor(H))).toBeNull();
    expect(controlPlaneTargetForCall("Write", { file_path: `${H}/sdk/WINTER.md` }, "/", homeFenceFor(H))).toBeNull();
  });
  test("the escape floor refuses a write-shaped use; reads and skill scripts still run", () => {
    for (const cmd of [
      `echo x > ${H}/sdk/skills/evil/SKILL.md`,
      `cp r.md ~/.winter/sdk/rules/r.md`,
      `echo hi >> ${H}/sdk/WINTER.md`,
      "mkdir -p packages/app/.winter/skills/x && echo y > packages/app/.winter/skills/x/SKILL.md",
      "tee /elsewhere/proj/.winter/commands/deploy.md < x",
      `cp s.md ${H}/skills/self/s/SKILL.md`, // the old path (a compat link on a migrated home)
    ]) expect({ cmd, hit: escapeFloorHit(cmd, H) !== undefined }).toEqual({ cmd, hit: true });
    for (const cmd of [`cat ${H}/sdk/skills/a/SKILL.md`, `bash ${H}/sdk/skills/a/run.sh`, "ls packages/app/.winter/rules", `cat ${H}/sdk/WINTER.md`]) {
      expect({ cmd, hit: escapeFloorHit(cmd, H) }).toEqual({ cmd, hit: undefined });
    }
  });
  // Round 3, minor 4: the home's basename (`.winter`) is one of the floor's home spellings, so the WINTER.md
  // needle matched EVERY project's `.winter/WINTER.md` — which the spec leaves ordinary. The needle is the
  // home's own now: a full spelling of the home, or the bare basename only from the home's parent directory.
  test("round 3, minor 4: a project's .winter/WINTER.md is ordinary; the home's own WINTER.md is still refused", () => {
    for (const cmd of ["echo x > .winter/WINTER.md", "cp notes.md packages/app/.winter/WINTER.md", "cd /Users/x/proj && echo x >> .winter/WINTER.md"]) {
      expect({ cmd, hit: escapeFloorHit(cmd, H, "/Users/x/proj") }).toEqual({ cmd, hit: undefined });
    }
    // from the home's parent, the bare spelling counts only as a word of its own — a project below it is not the home
    expect(escapeFloorHit("echo x > proj/.winter/WINTER.md", H, "/Users/x")).toBeUndefined();
    expect(escapeFloorHit("echo x > ./.winter/WINTER.md", H, "/Users/x")).toBeDefined();
    for (const [cmd, cwd] of [
      [`echo x > ${H}/WINTER.md`, "/Users/x/proj"],
      [`echo x > ${H}/sdk/WINTER.md`, "/Users/x/proj"],
      ["echo x > .winter/WINTER.md", "/Users/x"],                  // run from the home's parent: it IS the home's
      ["cd /Users/x && echo x > .winter/sdk/WINTER.md", "/Users/x/proj"],
    ] as const) expect({ cmd, hit: escapeFloorHit(cmd, H, cwd) !== undefined }).toEqual({ cmd, hit: true });
  });
});

// Round 4, minor 4 (controller item): both legs read permission-rule paths in gitignore-style grammar, where
// `[x]` is a character class and `*`/`\` are special — so a home (or tmpdir) whose path holds `[`, `]`, `*`
// or `\` got deny rules that never matched it. Every filesystem PATH the daemon writes into a rule is spelled
// with `escapeRulePath` (the router's own measured rule: `[ ] * \` backslash-escaped, `?` left raw); the glob
// parts (`**`, `settings*.json`, `claude-resume-*`) stay the rule's own. `gitignoreMatch` below emulates the
// measured semantics: `\c` is a literal c, `[…]` a class, `**` any depth, `*`/`?` within one segment.
describe("round 4, minor 4: glob metacharacters in the daemon's own rule paths", () => {
  const gitignoreMatch = (rule: string, path: string): boolean => {
    const pattern = rule.replace(/^[A-Za-z]+\(/, "").replace(/\)$/, "").replace(/^\/\//, "/");
    let re = "";
    for (let i = 0; i < pattern.length; i += 1) {
      const c = pattern[i]!;
      if (c === "\\" && i + 1 < pattern.length) { re += `\\${pattern[++i]!}`; continue; }
      if (c === "*" && pattern[i + 1] === "*") { re += ".*"; i += 1; continue; }
      if (c === "*") { re += "[^/]*"; continue; }
      if (c === "?") { re += "[^/]"; continue; }
      if (c === "[") { const end = pattern.indexOf("]", i + 1); if (end > i) { re += `[${pattern.slice(i + 1, end)}]`; i = end; continue; } }
      re += c.replace(/[.+^${}()|]/g, "\\$&");
    }
    return new RegExp(`^${re}$`).test(path);
  };
  // R.1 ruling 2: the router's `escapeRulePath` (now imported, the one source). `[`, `]`, `*` escaped once
  // and `?` raw are measured on both legs; the BACKSLASH spelling is the router's to make claude-correct
  // (`rule-path-escape-measure.e2e.test.ts` measures it on both real binaries), so it is not pinned here.
  test("escapeRulePath escapes [ ] * and leaves ? raw", () => {
    expect(escapeRulePath("/u/[wip]*a?c")).toBe("/u/\\[wip\\]\\*a?c");
    expect(escapeRulePath("/u/a\\b")).not.toBe("/u/a\\b"); // a backslash is escaped, never passed raw
  });
  test("a home containing [x] still has its control-plane deny rules applied — glob parts intact", () => {
    const home = "/Users/x/[wip] homes/.winter";
    const rules = controlPlaneDenyRules(home);
    const writes = rules.filter((r) => r.startsWith("Write("));
    const reads = rules.filter((r) => r.startsWith("Read("));
    for (const target of [`${home}/run/core.sock`, `${home}/runtimes/bin/winter`, `${home}/settings.json`, `${home}/sdk/settings.json`, `${home}/sdk/agents/a.md`, `${home}/cache/runs/r1/x`, `${home}/plugins/p/plugin.json`, `${home}/trust.json`]) {
      expect({ target, denied: writes.some((r) => gitignoreMatch(r, target)) }).toEqual({ target, denied: true });
    }
    for (const target of [`${home}/run/core.sock`, `${home}/runtimes/runtime-state.db`, `${home}/sdk/.winter.json`, `${home}/cache/runs/r1/.claude.json`]) {
      expect({ target, denied: reads.some((r) => gitignoreMatch(r, target)) }).toEqual({ target, denied: true });
    }
    // the project-independent glob rules are untouched, and still match
    expect(writes.some((r) => gitignoreMatch(r, "/p/app/.winter/settings.local.json"))).toBe(true);
    // the old spelling (unescaped) is what failed: `[wip]` read as a one-character class
    expect(gitignoreMatch(`Write(//${home}/run/**)`, `${home}/run/core.sock`)).toBe(false);
  });
});

// Round 6 (the router's measurement of what claude writes): claude saves a large tool output to
// `<configDir>/projects/<key>/<sid>/tool-results/<id>.txt` and tells the model to `Read` it. A resumed
// generation runs in a `claude-resume-*` staging root, which was read-denied WHOLE — so the model could not
// read its own large outputs there. The read fence is narrowed to what needs protecting, as for run folders:
// the generated config files and `backups/` (claude's `.claude.json.backup.*` copies — missed by the
// run-folder rules until now). The WRITE fence on staging roots is unchanged.
describe("round 6: staging roots and run folders — config files and backups/ read-denied, tool results readable", () => {
  const glob = (rule: string, path: string): boolean => {
    const pattern = rule.replace(/^[A-Za-z]+\(/, "").replace(/\)$/, "").replace(/^\/\//, "/");
    let re = "";
    for (let i = 0; i < pattern.length; i += 1) {
      const c = pattern[i]!;
      if (c === "\\" && i + 1 < pattern.length) { re += `\\${pattern[++i]!}`; continue; }
      if (c === "*" && pattern[i + 1] === "*") { re += ".*"; i += 1; continue; }
      if (c === "*") { re += "[^/]*"; continue; }
      re += c.replace(/[.+?^${}()|[\]]/g, "\\$&");
    }
    return new RegExp(`^${re}$`).test(path);
  };
  const staging = join(tmpdir(), `${RESUME_STAGING_PREFIX}8f2a`);
  const runFolder = `${H}/cache/runs/r1`;
  const toolResult = join(staging, "projects", "k", "sid", "tool-results", "x.txt");
  const deniedFor = (tool: string, path: string): boolean => rules.some((r) => r.startsWith(`${tool}(`) && glob(r, path));

  test("deny rules: a tool result inside a staging root is readable; config files and backups are not, in both containers", () => {
    for (const tool of ["Read", "Glob", "Grep"]) expect({ tool, denied: deniedFor(tool, toolResult) }).toEqual({ tool, denied: false });
    for (const root of [staging, runFolder]) {
      for (const f of [".claude.json", ".credentials.json", ".winter.json", "backups/.claude.json.backup.123"]) {
        const target = `${root}/${f}`;
        expect({ target, denied: deniedFor("Read", target) }).toEqual({ target, denied: true });
      }
    }
  });
  test("…and writes to the staging root stay denied (the whole root, as before)", () => {
    for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) expect({ tool, denied: deniedFor(tool, toolResult) }).toEqual({ tool, denied: true });
    expect(storeWriteDenial("Write", { file_path: toolResult }, { home: H })).toBeDefined();
  });
  test("the path fence hook agrees: a tool result reads, config and backups do not; a Grep rooted at a container root or its backups/ is refused", () => {
    expect(protectedReadDenial("Read", { file_path: toolResult }, { home: H })).toBeUndefined();
    expect(protectedReadDenial("Grep", { pattern: "x", path: join(staging, "projects") }, { home: H })).toBeUndefined();
    for (const root of [staging, runFolder]) {
      for (const f of [".claude.json", ".credentials.json", "backups/.claude.json.backup.123"]) {
        expect({ f, root, denied: protectedReadDenial("Read", { file_path: `${root}/${f}` }, { home: H }) !== undefined }).toEqual({ f, root, denied: true });
      }
      expect(protectedReadDenial("Grep", { pattern: "x", path: root }, { home: H })).toBeDefined();
      expect(protectedReadDenial("Grep", { pattern: "x", path: `${root}/backups` }, { home: H })).toBeDefined();
      expect(protectedReadDenial("Glob", { pattern: "*", path: `${root}/backups` }, { home: H })).toBeDefined();
    }
  });
  test("the Bash sandbox's denyRead names no staging root (it never did) and can express no per-root glob", () => {
    const denyRead = sandboxConfigFor(H).filesystem!.denyRead!;
    expect(denyRead.some((p) => p.includes(RESUME_STAGING_PREFIX))).toBe(false);
  });
});
