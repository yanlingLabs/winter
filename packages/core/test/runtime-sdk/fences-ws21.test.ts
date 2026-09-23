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
    // a staging root is read-denied whole already
    expect(rules.some((r) => r.startsWith("Read(") && r.includes(`${RESUME_STAGING_PREFIX}*`))).toBe(true);
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
