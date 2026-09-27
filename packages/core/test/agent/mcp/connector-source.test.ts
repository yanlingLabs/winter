// WS-26 (review r1, minors 4/6/7): the daemon's connector-permission source — which scope's listing answers
// read-only for a session, the held write, and a background kick that never spawns anything.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpManager } from "../../../src/agent/mcp/manager";
import { daemonConnectorSource, pluginMcpServerNames } from "../../../src/agent/mcp/connector-source";
import { connectorFactsFor } from "../../../src/agent/mcp/connector-permissions";
import type { TrustStore } from "../../../src/agent/trust";
import { Settings, setConnectorToolPermission } from "../../../src/settings";

function git(dir: string): void {
  Bun.spawnSync(["git", "init", "-q", dir]);
}

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "winter-conn-src-")));
  const project = realpathSync(mkdtempSync(join(tmpdir(), "winter-conn-proj-")));
  const localOnly = realpathSync(mkdtempSync(join(tmpdir(), "winter-conn-local-")));
  git(project);
  git(localOnly);
  mkdirSync(join(home, "sdk"), { recursive: true });
  writeFileSync(join(home, "sdk", ".winter.json"), JSON.stringify({
    mcpServers: { cf: { type: "stdio", command: "cf" }, remote: { type: "http", url: "https://example.test/mcp" } },
    projects: { [localOnly]: { mcpServers: { cf: { type: "stdio", command: "cf-local" } } } },
  }));
  mkdirSync(join(project, ".winter"), { recursive: true });
  writeFileSync(join(project, ".winter", "mcp.json"), JSON.stringify({ mcpServers: { cf: { type: "stdio", command: "cf-project" } } }));
  const trust = { isTrusted: (d: string) => d === project } as unknown as TrustStore;
  const connects: string[] = [];
  const manager = new McpManager({
    trust, stdioCwd: home,
    remote: { oauthStore: () => ({}) as never },
    connect: async (opts) => {
      connects.push(`${opts.name}:${"command" in opts.config ? opts.config.command : "http"}`);
      // the user cf marks `list` read-only; the PROJECT's cf does not.
      const ro = "command" in opts.config && opts.config.command === "cf";
      return { serverName: opts.name, listTools: async () => [
        { name: "list", inputSchema: {}, annotations: { readOnlyHint: ro } },
        { name: "prod__delete", inputSchema: {}, annotations: { readOnlyHint: ro } },
      ], close: async () => {} } as never;
    },
  });
  let settings: Settings = Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } });
  let t = 0;
  const source = daemonConnectorSource({ home, trust, settings: () => settings, manager: () => manager, now: () => t });
  return { home, project, localOnly, manager, connects, source, setSettings: (s: Settings) => { settings = s; }, getSettings: () => settings, advance: (ms: number) => { t += ms; } };
}

describe("which listing answers read-only", () => {
  test("user by default; a trusted project's own server answers only from its listing; a local-scope server never", async () => {
    const f = fixture();
    await f.manager.startAll({ cf: { command: "cf" } });
    expect(f.source.scopeFor("cf", undefined)).toBe("user");
    expect(f.source.readOnly("cf", "list")).toBe(true);
    // The project defines its own `cf`: not borrowed from the user listing — unknown until the project is listed.
    expect(f.source.scopeFor("cf", f.project)).toEqual({ project: f.project });
    expect(f.source.readOnly("cf", "list", f.project)).toBeUndefined();
    await f.manager.ensureProject(f.project);
    expect(f.source.readOnly("cf", "list", f.project)).toBe(false);
    // A local-scope `cf` shadows both and is never probed by the daemon: toward ask.
    expect(f.source.scopeFor("cf", f.localOnly)).toBe("local");
    expect(f.source.readOnly("cf", "list", f.localOnly)).toBeUndefined();
    // A name the project does not define resolves to the user scope even from the project.
    expect(f.source.scopeFor("remote", f.project)).toBe("user");
    // configured: in any scope that resolves for the session; nowhere else.
    expect(f.source.configured?.("cf", f.localOnly)).toBe(true);
    expect(f.source.configured?.("cf", f.project)).toBe(true);
    expect(f.source.configured?.("remote")).toBe(true);
    expect(f.source.configured?.("cf__prod", f.project)).toBe(false);
  });

  test("the call-path kick probes an unprobed http USER server at most once a minute — and never spawns a project's servers", async () => {
    const f = fixture();
    expect(f.source.readOnly("remote", "list", f.project)).toBeUndefined();
    await Bun.sleep(20);
    expect(f.connects).toEqual(["remote:http"]);
    // no project server was started by the miss on `cf` in the project, nor any user stdio server
    expect(f.source.readOnly("cf", "list", f.project)).toBeUndefined();
    expect(f.source.readOnly("cf", "nope")).toBeUndefined();
    await Bun.sleep(20);
    expect(f.connects).toEqual(["remote:http"]);
  });
});

describe("the table", () => {
  test("a write is served at once and superseded by the watcher's swap", () => {
    const f = fixture();
    expect(f.source.table()).toEqual({});
    f.source.noteWritten(setConnectorToolPermission(f.getSettings(), "cf", "list", "deny"));
    expect(f.source.table()).toEqual({ cf: { list: "deny" } });
    f.setSettings(setConnectorToolPermission(f.getSettings(), "cf", "list", "allow"));   // the watcher's swap
    expect(f.source.table()).toEqual({ cf: { list: "allow" } });
  });
});


describe("final review: a PLUGIN's server is configured too", () => {
  const DEL = "mcp__cf__prod__delete";

  function installPlugin(home: string, servers: Record<string, unknown>, where: ".mcp.json" | "manifest" = ".mcp.json"): void {
    const installPath = join(home, "sdk", "plugins", "cache", "mkt", "p", "1.0.0");
    mkdirSync(join(installPath, ".claude-plugin"), { recursive: true });
    if (where === ".mcp.json") writeFileSync(join(installPath, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
    else writeFileSync(join(installPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "p", mcpServers: servers }));
    writeFileSync(join(home, "sdk", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "p@mkt": [{ scope: "user", installPath }] } }));
  }

  test("the names are read from .mcp.json and from the manifest", () => {
    const f = fixture();
    expect(pluginMcpServerNames(f.home).size).toBe(0);
    installPlugin(f.home, { cf__prod: { command: "x" } });
    expect([...pluginMcpServerNames(f.home)]).toEqual(["cf__prod"]);
    installPlugin(f.home, { other: { command: "y" } }, "manifest");
    expect(pluginMcpServerNames(f.home).has("other")).toBe(true);
  });

  test("cf's `*` allow and cf's read-only listed `prod__delete`: with a plugin `cf__prod` it is the default and NOT read-only; without, cf decides", async () => {
    const f = fixture();
    await f.manager.startAll({ cf: { command: "cf" } });
    f.setSettings(setConnectorToolPermission(f.getSettings(), "cf", "*", "allow"));
    // No cf__prod anywhere: an ordinary tool name containing `__` — cf's allow and cf's read-only stand.
    expect(connectorFactsFor(f.source, DEL)).toMatchObject({ server: "cf", setting: "allow", readOnly: true });
    installPlugin(f.home, { cf__prod: { command: "x" } });
    f.advance(10_000);   // past the plugin-names cache
    const facts = connectorFactsFor(f.source, DEL);
    expect(facts?.setting).toBeUndefined();
    expect(facts?.readOnly).toBe(false);
    // …and with no stored value at all, still not read-only.
    f.setSettings(Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } }));
    expect(connectorFactsFor(f.source, DEL)?.readOnly).toBe(false);
  });
});
