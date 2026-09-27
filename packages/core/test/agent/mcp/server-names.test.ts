// WS-27 — the MCP server names outside the three config scopes (`agent/mcp/server-names.ts`): the plugins a
// session can load (a trusted project's own enabled keys from a directory marketplace included) and the
// servers subagent definitions declare inline — and `mcpServerNameDefined`, which `mcp.remove`/`mcp.rename`
// consult before dropping a name's connector permissions.
import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentFileInlineServerNames, agentInlineMcpServers, mcpServerNameDefined, pluginMcpServerNames, trustedProjectRoots,
} from "../../../src/agent/mcp/server-names";
import { daemonConnectorSource } from "../../../src/agent/mcp/connector-source";
import { connectorFactsFor } from "../../../src/agent/mcp/connector-permissions";
import { McpManager } from "../../../src/agent/mcp/manager";
import type { TrustStore } from "../../../src/agent/trust";
import { Settings, setConnectorToolPermission } from "../../../src/settings";

const dir = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
const write = (path: string, body: unknown): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
};
const agentFile = (servers: string): string => `---\nname: helper\ndescription: helps\nmcpServers:\n${servers}\n---\nDo the thing.\n`;

function fixture() {
  const home = dir("winter-srvnames-home-");
  const project = dir("winter-srvnames-proj-");
  const other = dir("winter-srvnames-other-");
  Bun.spawnSync(["git", "init", "-q", project]);
  Bun.spawnSync(["git", "init", "-q", other]);
  mkdirSync(join(home, "sdk", "plugins"), { recursive: true });
  // A directory marketplace `mkt` with one plugin `p`, never installed (no installed_plugins.json record).
  const market = dir("winter-srvnames-mkt-");
  write(join(market, ".claude-plugin", "marketplace.json"), { name: "mkt", plugins: [{ name: "p", source: "./p" }, { name: "escape", source: "../../etc" }] });
  write(join(market, "p", ".mcp.json"), { mcpServers: { "cf__prod": { command: "x" } } });
  write(join(market, "p", "agents", "planner.md"), agentFile("  - cf\n  - plugin_inline:\n      command: y"));
  write(join(home, "sdk", "plugins", "known_marketplaces.json"), { mkt: { source: { source: "directory", path: market }, installLocation: market } });
  const trusted = new Set([project]);
  const trust = { isTrusted: (d: string) => trusted.has(d), list: () => [...trusted] } as unknown as TrustStore;
  return { home, project, other, market, trust, trusted };
}

describe("plugins a trusted project enables from a directory marketplace, with no install record", () => {
  test("a project-scope enabled key counts only for that trusted project; the local tier counts too", () => {
    const f = fixture();
    expect(pluginMcpServerNames(f.home).has("cf__prod")).toBe(false);
    write(join(f.project, ".winter", "settings.json"), { enabledPlugins: { "p@mkt": true } });
    expect(pluginMcpServerNames(f.home, trustedProjectRoots({ cwd: f.project, trust: f.trust })).has("cf__prod")).toBe(true);
    // The same key in an UNTRUSTED project is not read.
    write(join(f.other, ".winter", "settings.local.json"), { enabledPlugins: { "p@mkt": true } });
    expect(trustedProjectRoots({ cwd: f.other, trust: f.trust })).toEqual([]);
    f.trusted.add(f.other);
    expect(pluginMcpServerNames(f.home, trustedProjectRoots({ cwd: f.other, trust: f.trust })).has("cf__prod")).toBe(true);
  });

  test("a marketplace source that escapes the marketplace is refused, as the runtime refuses it", () => {
    const f = fixture();
    write(join(f.project, ".winter", "settings.json"), { enabledPlugins: { "escape@mkt": true } });
    expect(pluginMcpServerNames(f.home, [f.project]).size).toBe(0);
  });
});

describe("subagent definitions' inline servers", () => {
  test("frontmatter: object entries declare a server; a string only names one the session already has", () => {
    expect(agentFileInlineServerNames(agentFile("  - github\n  - cf:\n      command: cf\n  - { db: { type: http, url: 'https://db.test/mcp' } }"))).toEqual(["cf", "db"]);
    expect(agentFileInlineServerNames("no frontmatter at all")).toEqual([]);
    expect(agentFileInlineServerNames("---\nname: x\n---\nbody")).toEqual([]);
    expect(agentFileInlineServerNames("---\nmcpServers: [unterminated\n---\nbody")).toEqual([]);
  });

  test("user, trusted-project and plugin tiers, each named by its CONFIG name", () => {
    const f = fixture();
    write(join(f.home, "sdk", "agents", "a.md"), agentFile("  - user_inline:\n      command: u"));
    write(join(f.project, ".winter", "agents", "b.md"), agentFile("  - project_inline:\n      command: p"));
    write(join(f.project, ".winter", "settings.json"), { enabledPlugins: { "p@mkt": true } });
    const roots = trustedProjectRoots({ cwd: f.project, trust: f.trust });
    const found = agentInlineMcpServers(f.home, roots, f.project).map((s) => `${s.scope}:${s.name}`).sort();
    expect(found).toEqual(["plugin:plugin_inline", "project:project_inline", "user:user_inline"]);
    // An untrusted project's agents are not read.
    expect(agentInlineMcpServers(f.home, [], f.project).map((s) => s.name)).toEqual(["user_inline"]);
  });
});

describe("mcpServerNameDefined — is the name still defined anywhere?", () => {
  test("the user scope, any project's local scope, any trusted project's file, a plugin, an agent definition", () => {
    const f = fixture();
    expect(mcpServerNameDefined(f.home, "cf", { trust: f.trust })).toBe(false);
    write(join(f.home, "sdk", ".winter.json"), { projects: { [f.other]: { mcpServers: { cf: { type: "stdio", command: "cf" } } } } });
    expect(mcpServerNameDefined(f.home, "cf", { trust: f.trust })).toBe(true);
    write(join(f.home, "sdk", ".winter.json"), {});
    write(join(f.project, ".winter", "mcp.json"), { mcpServers: { cf: { type: "stdio", command: "cf" } } });
    expect(mcpServerNameDefined(f.home, "cf", { trust: f.trust })).toBe(true);
    expect(mcpServerNameDefined(f.home, "cf", { trust: { isTrusted: () => false, list: () => [] } as unknown as TrustStore })).toBe(false);
    write(join(f.home, "sdk", "agents", "a.md"), agentFile("  - agent_only:\n      command: a"));
    expect(mcpServerNameDefined(f.home, "agent_only", { trust: f.trust })).toBe(true);
    write(join(f.home, "sdk", "settings.json"), { enabledPlugins: { "p@mkt": true } });
    expect(mcpServerNameDefined(f.home, "cf__prod", { trust: f.trust })).toBe(true);
  });
});

describe("configured(): an agent-inline or project-enabled plugin server votes in an ambiguous split", () => {
  test("cf's blanket allow and a read-only `prod__delete` listing: an inline cf__prod makes it the default, not read-only", async () => {
    const f = fixture();
    write(join(f.home, "sdk", ".winter.json"), { mcpServers: { cf: { type: "stdio", command: "cf" } } });
    const manager = new McpManager({
      trust: f.trust, stdioCwd: f.home,
      connect: async (opts) => ({ serverName: opts.name, listTools: async () => [{ name: "prod__delete", inputSchema: {}, annotations: { readOnlyHint: true } }], close: async () => {} }) as never,
    });
    await manager.startAll({ cf: { command: "cf" } });
    let t = 0;
    const settings = setConnectorToolPermission(Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } }), "cf", "*", "allow");
    const source = daemonConnectorSource({ home: f.home, trust: f.trust, settings: () => settings, manager: () => manager, now: () => t });
    expect(connectorFactsFor(source, "mcp__cf__prod__delete", f.project)).toMatchObject({ server: "cf", setting: "allow", readOnly: true });
    write(join(f.project, ".winter", "agents", "b.md"), agentFile("  - cf__prod:\n      command: p"));
    t += 10_000;   // past the names cache
    const facts = connectorFactsFor(source, "mcp__cf__prod__delete", f.project);
    expect(facts?.setting).toBeUndefined();
    expect(facts?.readOnly).toBe(false);
  });
});

describe("review 8: a trusted repository's LINKED WORKTREES count", () => {
  test("a server only a linked worktree's .winter/mcp.json defines is still defined", () => {
    const f = fixture();
    const git = (args: string[]) => expect(Bun.spawnSync(["git", "-C", f.project, ...args], { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
    git(["-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "i"]);
    const wt = join(dir("winter-srvnames-wt-"), "wt");
    git(["worktree", "add", "-q", "-b", `r8-${Math.random().toString(16).slice(2)}`, wt]);
    expect(mcpServerNameDefined(f.home, "wt_only", { trust: f.trust })).toBe(false);
    write(join(wt, ".winter", "mcp.json"), { mcpServers: { wt_only: { type: "stdio", command: "w" } } });
    expect(mcpServerNameDefined(f.home, "wt_only", { trust: f.trust })).toBe(true);
  });

  test("read from git's own files, no git process: trusting a LINKED worktree still sees the main checkout's servers", () => {
    const f = fixture();
    const git = (args: string[]) => expect(Bun.spawnSync(["git", "-C", f.project, ...args], { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
    git(["-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "i"]);
    const wt = realpathSync(join(dir("winter-srvnames-wt2-"))) + "/wt";
    git(["worktree", "add", "-q", "-b", `r8b-${Math.random().toString(16).slice(2)}`, wt]);
    write(join(f.project, ".winter", "mcp.json"), { mcpServers: { main_only: { type: "stdio", command: "m" } } });
    const onlyWorktree = { isTrusted: (d: string) => d === realpathSync(wt), list: () => [realpathSync(wt)] } as unknown as TrustStore;
    const spawn = spyOn(Bun, "spawnSync");
    try {
      expect(mcpServerNameDefined(f.home, "main_only", { trust: onlyWorktree })).toBe(true);
      expect(spawn).not.toHaveBeenCalled();
    } finally { spawn.mockRestore(); }
  });

  test("fail-safe: a trusted repository git cannot list reads as defined; a plain directory has no worktrees", () => {
    const f = fixture();
    const broken = dir("winter-srvnames-broken-");
    writeFileSync(join(broken, ".git"), "gitdir: /nonexistent/place\n");   // a .git git cannot use
    f.trusted.add(broken);
    expect(mcpServerNameDefined(f.home, "anything", { trust: f.trust })).toBe(true);
    f.trusted.delete(broken);
    f.trusted.add(dir("winter-srvnames-plain-"));
    expect(mcpServerNameDefined(f.home, "anything", { trust: f.trust })).toBe(false);
  });
});

describe("round 3: submodules and --separate-git-dir checkouts", () => {
  const run = (cwd: string, args: string[]) => expect(Bun.spawnSync(["git", "-C", cwd, "-c", "user.email=t@t.test", "-c", "user.name=t", "-c", "protocol.file.allow=always", ...args], { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);

  test("a trusted SUBMODULE (its .git file points into the superproject's modules/, no commondir) is read, not 'unknown'", () => {
    const f = fixture();
    const upstream = dir("winter-srvnames-sub-up-");
    run(upstream, ["init", "-q"]);
    run(upstream, ["commit", "--allow-empty", "-q", "-m", "i"]);
    run(f.project, ["commit", "--allow-empty", "-q", "-m", "i"]);
    run(f.project, ["submodule", "add", "-q", upstream, "sub"]);
    const sub = realpathSync(join(f.project, "sub"));
    const onlySub = { isTrusted: (d: string) => d === sub, list: () => [sub] } as unknown as TrustStore;
    expect(mcpServerNameDefined(f.home, "nowhere", { trust: onlySub })).toBe(false);
    write(join(sub, ".winter", "mcp.json"), { mcpServers: { in_sub: { type: "stdio", command: "s" } } });
    expect(mcpServerNameDefined(f.home, "in_sub", { trust: onlySub })).toBe(true);
  });

  test("a --separate-git-dir checkout, and a worktree entry with no gitdir file, are read", () => {
    const f = fixture();
    const work = dir("winter-srvnames-sep-work-");
    const gitdir = join(dir("winter-srvnames-sep-git-"), "repo.git");
    expect(Bun.spawnSync(["git", "init", "-q", `--separate-git-dir=${gitdir}`, work], { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
    const trust = { isTrusted: (d: string) => d === work, list: () => [work] } as unknown as TrustStore;
    expect(mcpServerNameDefined(f.home, "nowhere", { trust })).toBe(false);
    mkdirSync(join(gitdir, "worktrees", "stale"), { recursive: true });   // no gitdir file: skipped
    expect(mcpServerNameDefined(f.home, "nowhere", { trust })).toBe(false);
    write(join(work, ".winter", "mcp.json"), { mcpServers: { sep: { type: "stdio", command: "s" } } });
    expect(mcpServerNameDefined(f.home, "sep", { trust })).toBe(true);
  });
});
