import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { McpManager } from "../../../src/agent/mcp/manager";
import { ToolRegistry, type ToolContext } from "../../../src/agent/tools/registry";
import { TrustStore } from "../../../src/agent/trust";

const FIXTURE = join(import.meta.dir, "fake-mcp-server.ts");
const ctx = (): ToolContext => ({ cwd: "/tmp", roots: ["/tmp"], sessionId: "s1" });
const isMac = process.platform === "darwin";
function realDir(): string { return realpathSync(mkdtempSync(join(tmpdir(), "mcp-mgr-"))); }

describe.if(isMac)("McpManager", () => {
  test("startAll registers mcp__fake__echo; execute dispatches to the server", async () => {
    const registry = new ToolRegistry();
    const mgr = new McpManager({ registry, trust: new TrustStore(join(realDir(), "trust.json")) });
    await mgr.startAll({ fake: { command: "bun", args: ["run", FIXTURE] } });
    expect(registry.has("mcp__fake__echo")).toBe(true);
    const out = await registry.execute("mcp__fake__echo", { msg: "hi" }, ctx());
    expect(out.isError).toBe(false);
    expect(out.output).toBe("echo: hi");
    expect(mgr.list()).toEqual([{ name: "fake", status: "connected", toolNames: ["echo"], source: "user" }]);
    mgr.stopAll();
  });

  test("a bad-command server is skipped; a good one still registers (one bad ≠ dead)", async () => {
    const registry = new ToolRegistry();
    const mgr = new McpManager({ registry, trust: new TrustStore(join(realDir(), "trust.json")) });
    await mgr.startAll({ good: { command: "bun", args: ["run", FIXTURE] }, bad: { command: "this-command-does-not-exist-xyz" } });
    expect(registry.has("mcp__good__echo")).toBe(true);
    expect(mgr.list().find((s) => s.name === "bad")!.status).toBe("failed");
    expect(mgr.list().find((s) => s.name === "good")!.status).toBe("connected");
    mgr.stopAll();
  });

  test("a server with duplicate tool names (register throws) is skipped; a sibling good server still registers (one bad ≠ dead)", async () => {
    const registry = new ToolRegistry();
    const mgr = new McpManager({ registry, trust: new TrustStore(join(realDir(), "trust.json")) });
    await mgr.startAll({
      good: { command: "bun", args: ["run", FIXTURE] },
      dup: { command: "bun", args: ["run", FIXTURE], env: { WINTER_FAKE_DUP: "1" } },
    });
    // startAll must never throw regardless of one server's registration failure.
    expect(registry.has("mcp__good__echo")).toBe(true);
    expect(mgr.list().find((s) => s.name === "good")!.status).toBe("connected");
    expect(mgr.list().find((s) => s.name === "dup")!.status).toBe("failed");
    mgr.stopAll();
  });
});

function projDir(withServer = true): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-proj-")));
  if (withServer) writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { proj: { command: "bun", args: ["run", FIXTURE] } } }));
  return dir;
}

describe.if(isMac)("McpManager.ensureProject", () => {
  test("UNTRUSTED project .mcp.json → nothing starts/registers (SECURITY)", async () => {
    const dir = projDir();
    const registry = new ToolRegistry();
    const trust = new TrustStore(join(realDir(), "trust.json"));
    const mgr = new McpManager({ registry, trust });
    await mgr.ensureProject(dir);
    expect(registry.has("mcp__proj__echo")).toBe(false); // not spawned/registered while untrusted
    // and NOT recorded — retries after trust:
    trust.trust(dir);
    await mgr.ensureProject(dir);
    expect(registry.has("mcp__proj__echo")).toBe(true);
    mgr.stopAll();
  });

  test("TRUSTED project → tool registered with scope=dir + callable", async () => {
    const dir = projDir();
    const registry = new ToolRegistry();
    const trust = new TrustStore(join(realDir(), "trust.json")); trust.trust(dir);
    const mgr = new McpManager({ registry, trust });
    await mgr.ensureProject(dir);
    expect(registry.has("mcp__proj__echo")).toBe(true);
    const out = await registry.execute("mcp__proj__echo", { msg: "hi" }, { cwd: dir, roots: [dir], sessionId: "s" });
    expect(out.output).toBe("echo: hi");
    // scope enforced: a call from another cwd is rejected
    const other = realDir();
    expect((await registry.execute("mcp__proj__echo", { msg: "x" }, { cwd: other, roots: [other], sessionId: "s" })).isError).toBe(true);
    mgr.stopAll();
  });

  test("malformed .mcp.json → skip, no throw; idempotent 2nd call", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-bad-")));
    writeFileSync(join(dir, ".mcp.json"), "{ not json");
    const registry = new ToolRegistry();
    const trust = new TrustStore(join(realDir(), "trust.json")); trust.trust(dir);
    const mgr = new McpManager({ registry, trust });
    await expect(mgr.ensureProject(dir)).resolves.toBeUndefined();
    await mgr.ensureProject(dir); // idempotent
    mgr.stopAll();
  });

  test("concurrent ensureProject for the same dir shares one in-flight run (no double-spawn)", async () => {
    const dir = projDir();
    const registry = new ToolRegistry();
    const trust = new TrustStore(join(realDir(), "trust.json")); trust.trust(dir);
    const mgr = new McpManager({ registry, trust });
    const p1 = mgr.ensureProject(dir);
    const p2 = mgr.ensureProject(dir);
    expect(p2).toBe(p1); // second call JOINS the first (in-flight guard) — RED without the fix
    await Promise.all([p1, p2]);
    expect(registry.has("mcp__proj__echo")).toBe(true);
    expect(mgr.list(dir).filter((s) => s.name === "proj").length).toBe(1); // exactly one project server, not duplicated
    mgr.stopAll();
  });

  // MEDIUM (fix wave, pre-merge review, finding 3): `ensureProject` is called merely to RENDER
  // `mcp.list {cwd}` (`ipc/server.ts`'s `mcpList` handler) — before this fix that unconditionally
  // spawned every configured project server, disabled or not.
  test("a name in settings.mcp.disabled is NEVER spawned by ensureProject, even in a trusted project", async () => {
    const dir = projDir();
    const registry = new ToolRegistry();
    const trust = new TrustStore(join(realDir(), "trust.json")); trust.trust(dir);
    const mgr = new McpManager({ registry, trust, disabled: () => new Set(["proj"]) });
    await mgr.ensureProject(dir);
    expect(registry.has("mcp__proj__echo")).toBe(false); // never spawned/registered
    // Still reported, so mcp.list's own settings overlay has a row to rewrite to "disabled" —
    // never started, so never "connected".
    const row = mgr.list(dir).find((s) => s.name === "proj");
    expect(row?.status).not.toBe("connected");
    mgr.stopAll();
  });

  test("a name NOT in settings.mcp.disabled still starts normally (the filter is name-specific)", async () => {
    const dir = projDir();
    const registry = new ToolRegistry();
    const trust = new TrustStore(join(realDir(), "trust.json")); trust.trust(dir);
    const mgr = new McpManager({ registry, trust, disabled: () => new Set(["some-other-server"]) });
    await mgr.ensureProject(dir);
    expect(registry.has("mcp__proj__echo")).toBe(true);
    expect(mgr.list(dir).find((s) => s.name === "proj")?.status).toBe("connected");
    mgr.stopAll();
  });
});

describe.if(isMac)("McpManager.stopServer (finding 3)", () => {
  test("stops a running USER-tier server and removes its tools from the registry", async () => {
    const registry = new ToolRegistry();
    const mgr = new McpManager({ registry, trust: new TrustStore(join(realDir(), "trust.json")) });
    await mgr.startAll({ fake: { command: "bun", args: ["run", FIXTURE] } });
    expect(registry.has("mcp__fake__echo")).toBe(true);
    mgr.stopServer("fake");
    expect(registry.has("mcp__fake__echo")).toBe(false);
    expect(mgr.list().find((s) => s.name === "fake")).toBeUndefined(); // status dropped too, not just tools
    mgr.stopAll();
  });

  test("stops a running PROJECT-tier server and removes its tools from the registry", async () => {
    const dir = projDir();
    const registry = new ToolRegistry();
    const trust = new TrustStore(join(realDir(), "trust.json")); trust.trust(dir);
    const mgr = new McpManager({ registry, trust });
    await mgr.ensureProject(dir);
    expect(registry.has("mcp__proj__echo")).toBe(true);
    mgr.stopServer("proj");
    expect(registry.has("mcp__proj__echo")).toBe(false);
    expect(mgr.list(dir).find((s) => s.name === "proj")).toBeUndefined();
    mgr.stopAll();
  });

  test("a name with no running client anywhere is a no-op — never throws", () => {
    const registry = new ToolRegistry();
    const mgr = new McpManager({ registry, trust: new TrustStore(join(realDir(), "trust.json")) });
    expect(() => mgr.stopServer("never-existed")).not.toThrow();
  });
});

// MEDIUM (fix wave, pre-merge review, finding 3, symmetry) — regression coverage caught by a
// second review pass: `startOneUserServer` used to stop the old client WITHOUT unregistering its
// tools, so re-registering under `startOne`'s "throw" collision mode hit a duplicate-name
// `registry.register` and turned an ordinary `mcp.enable` (on an ALREADY-running, or never-disabled,
// name) into a dead process with a "failed" status. `startOneUserServer` now calls `this.
// stopServer(name)` first, which unregisters too.
describe.if(isMac)("McpManager.startOneUserServer (finding 3, symmetry — regression)", () => {
  test("enabling an ALREADY-RUNNING server (never disabled) does not kill it — connects clean, no collision", async () => {
    const registry = new ToolRegistry();
    const mgr = new McpManager({ registry, trust: new TrustStore(join(realDir(), "trust.json")) });
    const cfg = { command: "bun", args: ["run", FIXTURE] };
    await mgr.startAll({ fake: cfg });
    expect(registry.has("mcp__fake__echo")).toBe(true);
    expect(mgr.list().find((s) => s.name === "fake")?.status).toBe("connected");

    // The regression: calling startOneUserServer on a name that was never stopped/disabled.
    await mgr.startOneUserServer("fake", cfg);
    expect(registry.has("mcp__fake__echo")).toBe(true);
    expect(mgr.list().find((s) => s.name === "fake")?.status).toBe("connected"); // NOT "failed"
    const out = await registry.execute("mcp__fake__echo", { msg: "hi" }, ctx());
    expect(out.output).toBe("echo: hi"); // the tool actually still works, not a stale registration
    mgr.stopAll();
  });

  test("enabling a genuinely stopped/disabled server restarts it clean", async () => {
    const registry = new ToolRegistry();
    const mgr = new McpManager({ registry, trust: new TrustStore(join(realDir(), "trust.json")) });
    const cfg = { command: "bun", args: ["run", FIXTURE] };
    await mgr.startAll({ fake: cfg });
    mgr.stopServer("fake");
    expect(registry.has("mcp__fake__echo")).toBe(false);

    await mgr.startOneUserServer("fake", cfg);
    expect(registry.has("mcp__fake__echo")).toBe(true);
    expect(mgr.list().find((s) => s.name === "fake")?.status).toBe("connected");
    mgr.stopAll();
  });
});

describe.if(isMac)("McpManager.list(cwd) + stopAll", () => {
  test("list(trusted cwd) includes the project server (source project); list() only user", async () => {
    const dir = projDir();
    const registry = new ToolRegistry();
    const trust = new TrustStore(join(realDir(), "trust.json")); trust.trust(dir);
    const mgr = new McpManager({ registry, trust });
    await mgr.startAll({}); // no user servers
    await mgr.ensureProject(dir);
    expect(mgr.list().some((s) => s.source === "project")).toBe(false); // no cwd → no project
    const withCwd = mgr.list(dir);
    expect(withCwd.find((s) => s.name === "proj")).toMatchObject({ status: "connected", source: "project" });
    mgr.stopAll();
    expect(registry.has("mcp__proj__echo")).toBe(false); // stopAll unregistered project tools
  });
});

function pluginDir(mcpJson?: string | object): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-plugin-")));
  if (mcpJson !== undefined) {
    writeFileSync(join(dir, ".mcp.json"), typeof mcpJson === "string" ? mcpJson : JSON.stringify(mcpJson));
  }
  return dir;
}

describe.if(isMac)("McpManager.startPlugins", () => {
  test("enabled plugin's .mcp.json servers start; tools mcp__<plugin>_<server>__*; list source plugin; stopAll unregisters", async () => {
    const dir = pluginDir({ mcpServers: { fake: { command: "bun", args: ["run", FIXTURE] } } });
    const registry = new ToolRegistry();
    const trust = new TrustStore(join(realDir(), "trust.json"));
    const mgr = new McpManager({ registry, trust });
    await mgr.startPlugins([{ name: "demo", dir }]);
    expect(registry.has("mcp__demo_fake__echo")).toBe(true);
    const st = mgr.list().find((s) => s.name === "demo:fake");
    expect(st?.source).toBe("plugin");
    expect(st?.status).toBe("connected");
    mgr.stopAll();
    expect(registry.has("mcp__demo_fake__echo")).toBe(false); // stopAll unregistered plugin tools
  });

  test("missing/malformed .mcp.json → skipped, no throw", async () => {
    const noMcp = pluginDir(); // no .mcp.json at all
    const badMcp = pluginDir("{ not json");
    const registry = new ToolRegistry();
    const trust = new TrustStore(join(realDir(), "trust.json"));
    const mgr = new McpManager({ registry, trust });
    await expect(mgr.startPlugins([{ name: "nop", dir: noMcp }, { name: "bad", dir: badMcp }])).resolves.toBeUndefined();
    expect(mgr.list().length).toBe(0);
    mgr.stopAll();
  });

  test("one failing server + one FIXTURE sibling → failed status + connected sibling", async () => {
    const dir = pluginDir({ mcpServers: { bad: { command: "/nonexistent" }, good: { command: "bun", args: ["run", FIXTURE] } } });
    const registry = new ToolRegistry();
    const trust = new TrustStore(join(realDir(), "trust.json"));
    const mgr = new McpManager({ registry, trust });
    await mgr.startPlugins([{ name: "demo", dir }]);
    expect(mgr.list().find((s) => s.name === "demo:bad")?.status).toBe("failed");
    expect(mgr.list().find((s) => s.name === "demo:good")?.status).toBe("connected");
    expect(registry.has("mcp__demo_good__echo")).toBe(true);
    mgr.stopAll();
  });

  test("tool-name collision with an existing registration → collision-skipped + logged, no crash", async () => {
    const dir = pluginDir({ mcpServers: { fake: { command: "bun", args: ["run", FIXTURE] } } });
    const registry = new ToolRegistry();
    registry.register({ name: "mcp__demo_fake__echo", description: "pre-existing", args: z.object({}).passthrough(), run: () => "pre-existing" });
    const trust = new TrustStore(join(realDir(), "trust.json"));
    const logs: string[] = [];
    const mgr = new McpManager({ registry, trust, log: (m) => logs.push(m) });
    await expect(mgr.startPlugins([{ name: "demo", dir }])).resolves.toBeUndefined();
    const st = mgr.list().find((s) => s.name === "demo:fake");
    expect(st?.status).toBe("connected"); // server still connects; only the colliding tool is skipped
    expect(st?.toolNames).toEqual([]);
    expect(logs.some((m) => m.includes("collide"))).toBe(true);
    // the pre-existing registration is untouched:
    expect((await registry.execute("mcp__demo_fake__echo", {}, ctx())).output).toBe("pre-existing");
    mgr.stopAll();
  });

  // -------------------------------------------------------------------------------------------
  // Task 4: manifest-declared mcpServers (design spec §2 — "mcpServers may now come from the
  // manifest instead of .mcp.json (both accepted; manifest wins on conflict)"). `manifestServers`
  // is passed by the daemon from winter-plugin.json's `contributes.mcpServers`.
  // -------------------------------------------------------------------------------------------
  test("manifestServers present + .mcp.json also present → manifest list used, .mcp.json ignored entirely", async () => {
    const dir = pluginDir({ mcpServers: { legacy: { command: "/nonexistent-legacy-server" } } });
    const registry = new ToolRegistry();
    const trust = new TrustStore(join(realDir(), "trust.json"));
    const mgr = new McpManager({ registry, trust });
    await mgr.startPlugins([{ name: "demo", dir, manifestServers: [{ name: "fake", command: "bun", args: ["run", FIXTURE] }] }]);
    expect(registry.has("mcp__demo_fake__echo")).toBe(true);
    expect(mgr.list().find((s) => s.name === "demo:fake")?.status).toBe("connected");
    // the .mcp.json-declared server was never even read/started:
    expect(mgr.list().find((s) => s.name === "demo:legacy")).toBeUndefined();
    mgr.stopAll();
  });

  test("manifest-only plugin (no .mcp.json at all) starts from manifestServers", async () => {
    const dir = pluginDir(); // no .mcp.json
    const registry = new ToolRegistry();
    const trust = new TrustStore(join(realDir(), "trust.json"));
    const logs: string[] = [];
    const mgr = new McpManager({ registry, trust, log: (m) => logs.push(m) });
    await mgr.startPlugins([{ name: "demo", dir, manifestServers: [{ name: "fake", command: "bun", args: ["run", FIXTURE] }] }]);
    expect(registry.has("mcp__demo_fake__echo")).toBe(true);
    expect(mgr.list().find((s) => s.name === "demo:fake")?.status).toBe("connected");
    expect(logs.some((m) => m.includes(".mcp.json"))).toBe(false); // legacy path never consulted
    mgr.stopAll();
  });

  test("manifestServers env/args passed through to the spawned server", async () => {
    const dir = pluginDir(); // no .mcp.json — proves the config came from manifestServers
    const registry = new ToolRegistry();
    const trust = new TrustStore(join(realDir(), "trust.json"));
    const logs: string[] = [];
    const mgr = new McpManager({ registry, trust, log: (m) => logs.push(m) });
    // WINTER_FAKE_DUP makes the fixture report two identically-named tools; observing the
    // resulting collision-skip proves `env` reached the spawned process (args already proven by
    // ["run", FIXTURE] resolving to a connected server across every other test in this file).
    await mgr.startPlugins([{
      name: "demo", dir,
      manifestServers: [{ name: "dup", command: "bun", args: ["run", FIXTURE], env: { WINTER_FAKE_DUP: "1" } }],
    }]);
    const st = mgr.list().find((s) => s.name === "demo:dup");
    expect(st?.status).toBe("connected");
    expect(st?.toolNames).toEqual(["echo"]); // only one of the two duplicate tools registered
    expect(logs.some((m) => m.includes("collide"))).toBe(true);
    mgr.stopAll();
  });

  test("manifestServers absent → unchanged legacy .mcp.json path still works", async () => {
    const dir = pluginDir({ mcpServers: { fake: { command: "bun", args: ["run", FIXTURE] } } });
    const registry = new ToolRegistry();
    const trust = new TrustStore(join(realDir(), "trust.json"));
    const mgr = new McpManager({ registry, trust });
    await mgr.startPlugins([{ name: "demo", dir }]); // no manifestServers key at all
    expect(registry.has("mcp__demo_fake__echo")).toBe(true);
    expect(mgr.list().find((s) => s.name === "demo:fake")?.status).toBe("connected");
    mgr.stopAll();
  });
});
