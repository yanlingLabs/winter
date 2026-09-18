// Daemon settings surface (2026-09-17 plan, item 3): the daemon's own `<home>/agents/*.md` parser
// (agent-definitions.ts) — a reimplementation of the winter-agent-sdk runtime's internal
// (unexported) frontmatter parser, since the official leg has no way to see the directory itself.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadUserAgentDefinitions, loadProjectAgentDefinitions, mergeAgentDefinitionTiers, parseAgentDefinitionFile,
} from "../../src/agent/agent-definitions";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "winter-agent-defs-"));
}

function writeAgentFile(home: string, filename: string, content: string): void {
  const dir = join(home, "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content);
}

function writeProjectAgentFile(cwd: string, filename: string, content: string): void {
  const dir = join(cwd, ".winter", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content);
}

function agentMd(name: string, description = "d"): string {
  return ["---", `name: ${name}`, `description: ${description}`, "---", "", "Body."].join("\n");
}

describe("parseAgentDefinitionFile", () => {
  test("a valid file parses to {name, definition}", () => {
    const raw = [
      "---",
      "name: code-reviewer",
      "description: Reviews code for bugs and style issues",
      "tools: Read, Grep, Glob",
      "model: sonnet",
      "---",
      "",
      "You are a careful code reviewer.",
    ].join("\n");
    const result = parseAgentDefinitionFile(raw, "/h/agents/code-reviewer.md");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.name).toBe("code-reviewer");
    expect(result.definition.description).toBe("Reviews code for bugs and style issues");
    expect(result.definition.prompt).toBe("You are a careful code reviewer.");
    expect(result.definition.tools).toEqual(["Read", "Grep", "Glob"]);
    // model is carried through VERBATIM — never split at a tag boundary (item 3's own design note).
    expect(result.definition.model).toBe("sonnet");
  });

  test("missing name: is rejected with its own reason, never silently keyed by basename", () => {
    const raw = ["---", "description: A helper with no name", "---", "", "Body text."].join("\n");
    const result = parseAgentDefinitionFile(raw, "/h/agents/no-name.md");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain('"name"');
    expect(result.path).toBe("/h/agents/no-name.md");
  });

  test("missing description: is rejected with its own, DIFFERENT reason", () => {
    const raw = ["---", "name: no-description", "---", "", "Body text."].join("\n");
    const result = parseAgentDefinitionFile(raw, "/h/agents/no-description.md");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain('"description"');
  });

  test("a name starting with '-' is rejected", () => {
    const raw = ["---", "name: -bad", "description: x", "---", "", "Body."].join("\n");
    const result = parseAgentDefinitionFile(raw, "/h/agents/bad.md");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("invalid agent name");
  });

  test("a name containing ':' is rejected", () => {
    const raw = ["---", "name: foo:bar", "description: x", "---", "", "Body."].join("\n");
    const result = parseAgentDefinitionFile(raw, "/h/agents/bad2.md");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("invalid agent name");
  });

  test("an empty body (nothing after frontmatter) is rejected", () => {
    const raw = ["---", "name: empty-body", "description: x", "---", ""].join("\n");
    const result = parseAgentDefinitionFile(raw, "/h/agents/empty.md");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("no prompt body");
  });

  test("optional fields map through: disallowedTools, skills, maxTurns, background, memory, effort, permissionMode, isolation, color", () => {
    const raw = [
      "---",
      "name: full",
      "description: everything",
      "disallowedTools: Bash, Write",
      "skills: [skill-a, skill-b]",
      "maxTurns: 5",
      "background: true",
      "memory: project",
      "effort: high",
      "permissionMode: plan",
      "isolation: worktree",
      "color: blue",
      "---",
      "",
      "Prompt body.",
    ].join("\n");
    const result = parseAgentDefinitionFile(raw, "/h/agents/full.md");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.definition.disallowedTools).toEqual(["Bash", "Write"]);
    expect(result.definition.skills).toEqual(["skill-a", "skill-b"]);
    expect(result.definition.maxTurns).toBe(5);
    expect(result.definition.background).toBe(true);
    expect(result.definition.memory).toBe("project");
    expect(result.definition.effort).toBe("high");
    expect(result.definition.permissionMode).toBe("plan");
    expect(result.definition.isolation).toBe("worktree");
    expect(result.definition.color).toBe("blue");
  });

  test("an unrecognized permissionMode/memory/isolation value is dropped, not mis-typed through", () => {
    const raw = ["---", "name: typo", "description: x", "permissionMode: bogus", "memory: bogus", "isolation: bogus", "---", "", "Body."].join("\n");
    const result = parseAgentDefinitionFile(raw, "/h/agents/typo.md");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.definition.permissionMode).toBeUndefined();
    expect(result.definition.memory).toBeUndefined();
    expect(result.definition.isolation).toBeUndefined();
  });

  test("effort as a bare number string parses to a number", () => {
    const raw = ["---", "name: numeric-effort", "description: x", "effort: 3", "---", "", "Body."].join("\n");
    const result = parseAgentDefinitionFile(raw, "/h/agents/n.md");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.definition.effort).toBe(3);
  });

  test("unterminated frontmatter treats the whole file as body — never throws", () => {
    const raw = "---\nname: x\nno closing fence here";
    expect(() => parseAgentDefinitionFile(raw, "/h/agents/unterminated.md")).not.toThrow();
    const result = parseAgentDefinitionFile(raw, "/h/agents/unterminated.md");
    expect(result.ok).toBe(false); // treated as body-only -> no frontmatter -> missing name
  });
});

describe("loadUserAgentDefinitions", () => {
  test("a missing agents/ directory yields zero definitions and zero rejections, never an error", () => {
    const home = tmpHome();
    const { definitions, rejected } = loadUserAgentDefinitions(home);
    expect(definitions).toEqual({});
    expect(rejected).toEqual([]);
  });

  test("valid files are keyed by their OWN frontmatter name, not the filename", () => {
    const home = tmpHome();
    writeAgentFile(home, "whatever-filename.md", ["---", "name: real-name", "description: d", "---", "", "Body."].join("\n"));
    const { definitions } = loadUserAgentDefinitions(home);
    expect(Object.keys(definitions)).toEqual(["real-name"]);
    expect(definitions["real-name"]!.description).toBe("d");
  });

  test("a file missing name: and one missing description: are each rejected with their OWN reason, and neither reaches definitions", () => {
    const home = tmpHome();
    writeAgentFile(home, "no-name.md", ["---", "description: d", "---", "", "Body."].join("\n"));
    writeAgentFile(home, "no-description.md", ["---", "name: nodesc", "---", "", "Body."].join("\n"));
    writeAgentFile(home, "valid.md", ["---", "name: valid-one", "description: d", "---", "", "Body."].join("\n"));
    const { definitions, rejected } = loadUserAgentDefinitions(home);
    expect(Object.keys(definitions)).toEqual(["valid-one"]);
    expect(rejected).toHaveLength(2);
    const byPath = Object.fromEntries(rejected.map((r) => [r.path.split("/").pop(), r.reason]));
    expect(byPath["no-name.md"]).toContain('"name"');
    expect(byPath["no-description.md"]).toContain('"description"');
  });

  test("non-.md files are ignored entirely (not even a rejection)", () => {
    const home = tmpHome();
    mkdirSync(join(home, "agents"), { recursive: true });
    writeFileSync(join(home, "agents", "README.txt"), "not an agent file");
    const { definitions, rejected } = loadUserAgentDefinitions(home);
    expect(definitions).toEqual({});
    expect(rejected).toEqual([]);
  });

  test("a fresh scan picks up a file added AFTER the first call — no caching", () => {
    const home = tmpHome();
    expect(Object.keys(loadUserAgentDefinitions(home).definitions)).toEqual([]);
    writeAgentFile(home, "late.md", ["---", "name: late-arrival", "description: d", "---", "", "Body."].join("\n"));
    expect(Object.keys(loadUserAgentDefinitions(home).definitions)).toEqual(["late-arrival"]);
  });
});

describe("loadProjectAgentDefinitions", () => {
  test("a missing .winter/agents directory yields zero definitions, never an error", () => {
    const cwd = tmpHome();
    const { definitions, rejected } = loadProjectAgentDefinitions(cwd);
    expect(definitions).toEqual({});
    expect(rejected).toEqual([]);
  });

  test("valid project files are keyed by frontmatter name, same as the user tier", () => {
    const cwd = tmpHome();
    writeProjectAgentFile(cwd, "reviewer.md", agentMd("project-reviewer", "reviews from the project"));
    const { definitions } = loadProjectAgentDefinitions(cwd);
    expect(Object.keys(definitions)).toEqual(["project-reviewer"]);
    expect(definitions["project-reviewer"]!.description).toBe("reviews from the project");
  });

  test("a symlinked .winter is refused — treated as no project agents at all", () => {
    const real = tmpHome();
    const decoy = mkdtempSync(join(tmpdir(), "winter-agent-defs-decoy-"));
    writeProjectAgentFile(decoy, "sneaky.md", agentMd("sneaky"));
    symlinkSync(join(decoy, ".winter"), join(real, ".winter"));
    const { definitions, rejected } = loadProjectAgentDefinitions(real);
    expect(definitions).toEqual({});
    expect(rejected).toEqual([]);
  });

  test("a symlinked .winter/agents directory is refused the same way", () => {
    const cwd = tmpHome();
    const decoyAgents = mkdtempSync(join(tmpdir(), "winter-agent-defs-decoy-agents-"));
    writeFileSync(join(decoyAgents, "sneaky.md"), agentMd("sneaky"));
    mkdirSync(join(cwd, ".winter"), { recursive: true });
    symlinkSync(decoyAgents, join(cwd, ".winter", "agents"));
    const { definitions } = loadProjectAgentDefinitions(cwd);
    expect(definitions).toEqual({});
  });

  test("a symlinked individual .md file inside a real agents/ dir is skipped, not followed", () => {
    const cwd = tmpHome();
    const outside = tmpHome();
    writeFileSync(join(outside, "planted.md"), agentMd("planted"));
    mkdirSync(join(cwd, ".winter", "agents"), { recursive: true });
    symlinkSync(join(outside, "planted.md"), join(cwd, ".winter", "agents", "planted.md"));
    const { definitions, rejected } = loadProjectAgentDefinitions(cwd);
    expect(definitions).toEqual({});
    expect(rejected).toEqual([]); // skipped silently, same as any other unreadable entry — never a rejection
  });
});

describe("mergeAgentDefinitionTiers", () => {
  test("a project definition wins over a same-named user one — the SDK's own precedence, restored", () => {
    const home = tmpHome();
    const cwd = tmpHome();
    writeAgentFile(home, "shared.md", agentMd("shared", "from the USER tier"));
    writeProjectAgentFile(cwd, "shared.md", agentMd("shared", "from the PROJECT tier"));
    const user = loadUserAgentDefinitions(home);
    const project = loadProjectAgentDefinitions(cwd);
    const { optionsMap, sources } = mergeAgentDefinitionTiers(user, project);
    expect(optionsMap["shared"]!.description).toBe("from the PROJECT tier");
    const shared = sources.filter((s) => s.name === "shared");
    expect(shared).toHaveLength(2);
    const projectRow = shared.find((s) => s.tier === "project")!;
    const userRow = shared.find((s) => s.tier === "user")!;
    expect(projectRow.shadowed).toBeUndefined();
    expect(userRow.shadowed).toBe(true);
  });

  test("a user-only and a project-only definition both survive the merge untouched", () => {
    const home = tmpHome();
    const cwd = tmpHome();
    writeAgentFile(home, "u.md", agentMd("user-only"));
    writeProjectAgentFile(cwd, "p.md", agentMd("project-only"));
    const { optionsMap, sources } = mergeAgentDefinitionTiers(loadUserAgentDefinitions(home), loadProjectAgentDefinitions(cwd));
    expect(Object.keys(optionsMap).sort()).toEqual(["project-only", "user-only"]);
    expect(sources.every((s) => s.shadowed === undefined)).toBe(true);
  });

  test("an untrusted project (never scanned by the caller) contributes nothing — its agents are entirely absent from both optionsMap and sources", () => {
    const home = tmpHome();
    const cwd = tmpHome();
    writeAgentFile(home, "u.md", agentMd("user-only"));
    writeProjectAgentFile(cwd, "p.md", agentMd("would-be-project-agent"));
    // The caller never calls loadProjectAgentDefinitions for an untrusted cwd — simulated here by
    // just not calling it, passing the empty-scan shape a gate would produce.
    const emptyProject = { definitions: {}, sources: [], rejected: [] };
    const { optionsMap, sources } = mergeAgentDefinitionTiers(loadUserAgentDefinitions(home), emptyProject);
    expect(Object.keys(optionsMap)).toEqual(["user-only"]);
    expect(sources.map((s) => s.name)).toEqual(["user-only"]);
  });

  test("rejections from both tiers are surfaced, each tagged with its own tier", () => {
    const home = tmpHome();
    const cwd = tmpHome();
    writeAgentFile(home, "bad-user.md", ["---", "description: no name here", "---", "", "Body."].join("\n"));
    writeProjectAgentFile(cwd, "bad-project.md", ["---", "description: no name here either", "---", "", "Body."].join("\n"));
    const { rejected } = mergeAgentDefinitionTiers(loadUserAgentDefinitions(home), loadProjectAgentDefinitions(cwd));
    expect(rejected).toHaveLength(2);
    expect(rejected.find((r) => r.path.endsWith("bad-user.md"))!.tier).toBe("user");
    expect(rejected.find((r) => r.path.endsWith("bad-project.md"))!.tier).toBe("project");
  });
});
