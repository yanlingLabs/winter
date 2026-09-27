// WS-26 (review r1, minors 4/6/7): the daemon's connector-permission source — which scope's listing answers
// read-only for a session, the held write, and a background kick that never spawns anything.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpManager } from "../../../src/agent/mcp/manager";
import { daemonConnectorSource } from "../../../src/agent/mcp/connector-source";
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
      return { serverName: opts.name, listTools: async () => [{ name: "list", inputSchema: {}, annotations: { readOnlyHint: ro } }], close: async () => {} } as never;
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
