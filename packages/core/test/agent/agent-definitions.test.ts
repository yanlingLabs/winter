// Daemon settings surface (2026-09-17 plan, item 3): the daemon's own `<home>/agents/*.md` parser
// (agent-definitions.ts) — a reimplementation of the winter-agent-sdk runtime's internal
// (unexported) frontmatter parser, since the official leg has no way to see the directory itself.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUserAgentDefinitions, parseAgentDefinitionFile } from "../../src/agent/agent-definitions";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "winter-agent-defs-"));
}

function writeAgentFile(home: string, filename: string, content: string): void {
  const dir = join(home, "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content);
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
