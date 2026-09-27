// WS-27 — `mcp.remove` clears a name's connector permissions once nothing else defines it, and `mcp.rename`
// renames within one scope, carrying the permissions and `mcp.disabled`; a sign-in (keyed by URL) follows by
// itself. Over the bare IPC harness `mcp-add-remove-get.test.ts` uses.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, McpRenameResult, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { createMemoryMcpOAuthStore, encodeMcpOAuthTokenRecord, mcpOAuthTokenAccount } from "@yanlinglabs/winter-agent-runtime/mcp-auth";
import { startIpcServer, REMOTE_ALLOWED_METHODS } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { Settings, saveSettings } from "../../src/settings";
import { McpManager } from "../../src/agent/mcp/manager";
import { TrustStore } from "../../src/agent/trust";

class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;

  static async connect(socketPath: string): Promise<TestClient> {
    const c = new TestClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && c.pending.has(msg.id)) {
              c.pending.get(msg.id)!(msg);
              c.pending.delete(msg.id);
            }
          }
        },
        drain(_s) { c.writer.onDrain(); },
      },
    });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    return c;
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  async hello(token: string, clientName: string, role = "harness"): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role, token, clientName });
  }

  close(): void { this.socket.end(); }
}

describe("mcp.remove / mcp.rename and the connector settings", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(config: Record<string, unknown>, settings: Record<string, unknown> = {}, live: string[] = []) {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "winter-mcp-rename-")));
    saveSettings(join(home, "settings.json"), Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" }, ...settings }));
    mkdirSync(join(home, "sdk"), { recursive: true });
    writeFileSync(join(home, "sdk", ".winter.json"), JSON.stringify(config));
    const trust = new TrustStore(join(home, "trust.json"));
    const probed: string[] = [];
    const mcp = new McpManager({ trust, stdioCwd: home, connect: async (o) => { probed.push(o.name); return { serverName: o.name, listTools: async () => [], close: async () => {} } as never; } });
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const secrets = new FileSecretStore(join(home, "secrets"));
    const authority = new TokenAuthority(secrets);
    const tokens = await authority.ensureTokens();
    const oauth = createMemoryMcpOAuthStore();
    const saved: unknown[] = [];
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, winterHome: home, secrets, mcp, trust, mcpOAuth: { store: oauth }, winter: { list: () => [{ mcpServerNames: () => live }] } as never, onConnectorPermissionsSaved: (next) => { saved.push(next.mcp?.toolPermissions); } });
    stop = () => { server.stop(); store.close(); };
    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "cli");
    return { home, c, oauth, saved, probed, trust };
  }
  const settingsOf = (home: string): Record<string, any> => JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
  const configOf = (home: string): Record<string, any> => {
    const path = join(home, "sdk", ".winter.json");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  };

  test("remove clears the name's permissions when nothing else defines it", async () => {
    const { home, c, saved } = await boot({ mcpServers: { cf: { type: "stdio", command: "cf" } } }, { mcp: { toolPermissions: { cf: { "*": "deny" }, other: { x: "allow" } } } });
    const r = await c.request(METHODS.mcpRemove, { name: "cf", scope: "user" });
    expect(r.result).toEqual({ ok: true, name: "cf", removed: true, scope: "user", permissionsCleared: true });
    expect(settingsOf(home).mcp.toolPermissions).toEqual({ other: { x: "allow" } });
    expect(saved.at(-1)).toEqual({ other: { x: "allow" } });
    c.close();
  });

  test("remove keeps the permissions while another scope still defines the name", async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "winter-mcp-rename-proj-")));
    const { home, c } = await boot({ mcpServers: { cf: { type: "stdio", command: "cf" } }, projects: { [project]: { mcpServers: { cf: { type: "stdio", command: "cf-local" } } } } }, { mcp: { toolPermissions: { cf: { "*": "deny" } } } });
    const r = await c.request(METHODS.mcpRemove, { name: "cf", scope: "user" });
    expect(r.result).toMatchObject({ removed: true, permissionsCleared: false });
    expect(settingsOf(home).mcp.toolPermissions).toEqual({ cf: { "*": "deny" } });
    c.close();
  });

  test("remove keeps the permissions while a trusted project's .winter/mcp.json defines the name", async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "winter-mcp-rename-proj-")));
    mkdirSync(join(project, ".winter"), { recursive: true });
    writeFileSync(join(project, ".winter", "mcp.json"), JSON.stringify({ mcpServers: { cf: { type: "stdio", command: "cf-p" } } }));
    const { home, c, trust } = await boot({ mcpServers: { cf: { type: "stdio", command: "cf" } } }, { mcp: { toolPermissions: { cf: { "*": "ask" } } } });
    trust.trust(project);
    expect((await c.request(METHODS.mcpRemove, { name: "cf", scope: "user" })).result).toMatchObject({ permissionsCleared: false });
    expect(settingsOf(home).mcp.toolPermissions).toEqual({ cf: { "*": "ask" } });
    c.close();
  });

  test("rename moves the entry in place, carries the permissions and mcp.disabled, and re-probes the stdio server", async () => {
    const { home, c, saved, probed } = await boot(
      { numStartups: 3, mcpServers: { a: { type: "stdio", command: "a" }, cf: { type: "stdio", command: "cf" }, z: { type: "stdio", command: "z" } } },
      { mcp: { toolPermissions: { cf: { list: "allow", "*": "ask" } }, disabled: ["other"] } },
    );
    const r = await c.request(METHODS.mcpRename, { name: "cf", newName: "cloudflare", scope: "user" });
    expect(McpRenameResult.parse(r.result)).toEqual({ ok: true, name: "cf", newName: "cloudflare", scope: "user", carried: true, keptOld: false, rulesCarried: 0, rulesNotFollowed: [] });
    const config = configOf(home);
    expect(Object.keys(config.mcpServers)).toEqual(["a", "cloudflare", "z"]);
    expect(config.mcpServers.cloudflare).toEqual({ type: "stdio", command: "cf" });
    expect(config.numStartups).toBe(3);
    expect(settingsOf(home).mcp.toolPermissions).toEqual({ cloudflare: { list: "allow", "*": "ask" } });
    expect(saved.at(-1)).toEqual({ cloudflare: { list: "allow", "*": "ask" } });
    expect(probed).toContain("cloudflare");
    const list = (await c.request(METHODS.mcpList, {})).result.servers.map((s: { name: string }) => s.name);
    expect(list).toContain("cloudflare");
    expect(list).not.toContain("cf");
    c.close();
  });

  test("rename carries a disabled server's disabled flag (and does not re-probe it)", async () => {
    const { home, c, probed } = await boot({ mcpServers: { cf: { type: "stdio", command: "cf" } } }, { mcp: { disabled: ["cf"] } });
    await c.request(METHODS.mcpRename, { name: "cf", newName: "cf2", scope: "user" });
    expect(settingsOf(home).mcp.disabled).toEqual(["cf2"]);
    expect(probed).not.toContain("cf2");
    c.close();
  });

  test("refused typed, writing nothing: a taken name, a missing name, an invalid name, a target with stored values", async () => {
    const config = { mcpServers: { cf: { type: "stdio", command: "cf" }, gh: { type: "stdio", command: "gh" } } };
    const { home, c } = await boot(config, { mcp: { toolPermissions: { cf: { "*": "deny" }, stale: { x: "ask" } } } });
    const before = readFileSync(join(home, "sdk", ".winter.json"), "utf8");
    expect((await c.request(METHODS.mcpRename, { name: "cf", newName: "gh", scope: "user" })).error?.data?.code).toBe("mcp_server_exists");
    expect((await c.request(METHODS.mcpRename, { name: "nope", newName: "x", scope: "user" })).error?.data?.code).toBe("mcp_server_not_found");
    expect((await c.request(METHODS.mcpRename, { name: "cf", newName: "bad name", scope: "user" })).error?.data?.code).toBe("mcp_invalid_name");
    expect((await c.request(METHODS.mcpRename, { name: "cf", newName: "stale", scope: "user" })).error?.data?.code).toBe("mcp_rename_target_has_permissions");
    expect(readFileSync(join(home, "sdk", ".winter.json"), "utf8")).toBe(before);
    expect(settingsOf(home).mcp.toolPermissions).toEqual({ cf: { "*": "deny" }, stale: { x: "ask" } });
    c.close();
  });

  test("rename in the local scope keeps the old name's permissions while the user scope still defines it", async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "winter-mcp-rename-proj-")));
    const { home, c } = await boot({ mcpServers: { cf: { type: "stdio", command: "cf" } }, projects: { [project]: { mcpServers: { cf: { type: "stdio", command: "cf-local" } } } } }, { mcp: { toolPermissions: { cf: { "*": "deny" } } } });
    const r = await c.request(METHODS.mcpRename, { name: "cf", newName: "cf_local", scope: "local", cwd: project });
    expect(r.result).toMatchObject({ carried: true, keptOld: true });
    expect(configOf(home).projects[project].mcpServers).toEqual({ cf_local: { type: "stdio", command: "cf-local" } });
    expect(settingsOf(home).mcp.toolPermissions).toEqual({ cf: { "*": "deny" }, cf_local: { "*": "deny" } });
    c.close();
  });

  test("a signed-in http server keeps its sign-in across a rename (the sign-in is keyed by URL)", async () => {
    const URL_ = "https://mcp.example.test/mcp";
    const { c, oauth } = await boot({ mcpServers: { linear: { type: "http", url: URL_ } } });
    await oauth.write(mcpOAuthTokenAccount(URL_), encodeMcpOAuthTokenRecord({ v: 1, kind: "mcp-oauth", serverUrl: URL_, issuer: "https://as.example.test", accessToken: "a", generation: 1 }));
    const auth = async (name: string) => (await c.request(METHODS.mcpList, {})).result.servers.find((s: { name: string }) => s.name === name)?.auth;
    expect(await auth("linear")).toBe("signed-in");
    expect((await c.request(METHODS.mcpRename, { name: "linear", newName: "linear-work", scope: "user" })).result.ok).toBe(true);
    expect(await auth("linear-work")).toBe("signed-in");
    expect(await oauth.read(mcpOAuthTokenAccount(URL_))).not.toBeNull();
    c.close();
  });

  test("review 2: a name a LIVE session still has connected keeps its permissions on remove and on rename", async () => {
    const { home, c } = await boot({ mcpServers: { cf: { type: "stdio", command: "cf" }, gh: { type: "stdio", command: "gh" } } }, { mcp: { toolPermissions: { cf: { "*": "deny" }, gh: { "*": "ask" } } } }, ["cf", "gh"]);
    expect((await c.request(METHODS.mcpRemove, { name: "cf", scope: "user" })).result).toMatchObject({ removed: true, permissionsCleared: false });
    expect((await c.request(METHODS.mcpRename, { name: "gh", newName: "github", scope: "user" })).result).toMatchObject({ carried: true, keptOld: true });
    expect(settingsOf(home).mcp.toolPermissions).toEqual({ cf: { "*": "deny" }, gh: { "*": "ask" }, github: { "*": "ask" } });
    c.close();
  });

  test("review 3: rename into a name another scope defines, or a live session uses, is refused and writes nothing", async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "winter-mcp-rename-proj-")));
    const { home, c } = await boot({ mcpServers: { cf: { type: "stdio", command: "cf" } }, projects: { [project]: { mcpServers: { taken: { type: "stdio", command: "t" } } } } }, { mcp: { toolPermissions: { cf: { "*": "deny" } } } }, ["busy"]);
    const before = readFileSync(join(home, "sdk", ".winter.json"), "utf8");
    expect((await c.request(METHODS.mcpRename, { name: "cf", newName: "taken", scope: "user" })).error?.data?.code).toBe("mcp_server_name_in_use");
    expect((await c.request(METHODS.mcpRename, { name: "cf", newName: "busy", scope: "user" })).error?.data?.code).toBe("mcp_server_name_in_use");
    expect(readFileSync(join(home, "sdk", ".winter.json"), "utf8")).toBe(before);
    expect(settingsOf(home).mcp.toolPermissions).toEqual({ cf: { "*": "deny" } });
    c.close();
  });

  test("review 4: rename rewrites sdk/settings.json rules naming the server, and lists the ones in files Winter does not edit", async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "winter-mcp-rename-proj-")));
    mkdirSync(join(project, ".winter"), { recursive: true });
    writeFileSync(join(project, ".winter", "settings.json"), JSON.stringify({ permissions: { allow: ["mcp__cf__list", "Bash(ls)"] } }));
    const { home, c, trust } = await boot({ mcpServers: { cf: { type: "stdio", command: "cf" } } });
    trust.trust(project);
    writeFileSync(join(home, "sdk", "settings.json"), JSON.stringify({ permissions: { allow: ["mcp__cf__list", "mcp__cf__*", "mcp__cfx__a", "Read"], deny: ["mcp__cf"], ask: ["mcp__cf__prod(*)"] } }));
    mkdirSync(join(home, "permissions"), { recursive: true });
    writeFileSync(join(home, "permissions", "projects.json"), JSON.stringify({ version: 1, projects: { [project]: ["mcp__cf__write", "Bash(npm test)"] } }));
    const r = await c.request(METHODS.mcpRename, { name: "cf", newName: "cloudflare", scope: "user", cwd: project });
    expect(r.result).toMatchObject({ rulesCarried: 4, keptOld: false });
    expect(JSON.parse(readFileSync(join(home, "sdk", "settings.json"), "utf8")).permissions).toEqual({
      allow: ["mcp__cloudflare__list", "mcp__cloudflare__*", "mcp__cfx__a", "Read"], deny: ["mcp__cloudflare"], ask: ["mcp__cloudflare__prod(*)"],
    });
    expect(r.result.rulesNotFollowed.sort()).toEqual([
      `${join(home, "permissions", "projects.json")}: mcp__cf__write`,
      `${join(project, ".winter", "settings.json")}: mcp__cf__list`,
    ].sort());
    // The repository file and the record are untouched.
    expect(JSON.parse(readFileSync(join(project, ".winter", "settings.json"), "utf8")).permissions.allow).toEqual(["mcp__cf__list", "Bash(ls)"]);
    c.close();
  });

  test("review 4: while the old name stays in use, the rules are COPIED (both spellings kept)", async () => {
    const { home, c } = await boot({ mcpServers: { cf: { type: "stdio", command: "cf" } } }, {}, ["cf"]);
    writeFileSync(join(home, "sdk", "settings.json"), JSON.stringify({ permissions: { deny: ["mcp__cf__drop"] } }));
    expect((await c.request(METHODS.mcpRename, { name: "cf", newName: "cf2", scope: "user" })).result).toMatchObject({ rulesCarried: 1, keptOld: true });
    expect(JSON.parse(readFileSync(join(home, "sdk", "settings.json"), "utf8")).permissions.deny).toEqual(["mcp__cf__drop", "mcp__cf2__drop"]);
    c.close();
  });

  test("round 2 N1: a rule that may name another in-use server (cf__prod) is neither copied nor dropped, and is listed", async () => {
    const { home, c } = await boot({ mcpServers: { cf: { type: "stdio", command: "cf" }, cf__prod: { type: "stdio", command: "p" } } });
    const sdk = join(home, "sdk", "settings.json");
    writeFileSync(sdk, JSON.stringify({ permissions: { allow: ["mcp__cf__list"], ask: ["mcp__cf__prod(*)"] } }));
    const r = await c.request(METHODS.mcpRename, { name: "cf", newName: "cloudflare", scope: "user" });
    expect(r.result).toMatchObject({ rulesCarried: 1, keptOld: false });
    expect(JSON.parse(readFileSync(sdk, "utf8")).permissions).toEqual({ allow: ["mcp__cloudflare__list"], ask: ["mcp__cf__prod(*)"] });
    expect(r.result.rulesNotFollowed).toEqual([`${sdk}: mcp__cf__prod(*) (ambiguous — it may name server "cf__prod", which is in use; left as it is)`]);
    c.close();
  });

  test("round 2 N1: a stored toolPermissions row makes a candidate in use too; unambiguous rules still move", async () => {
    const { home, c } = await boot({ mcpServers: { cf: { type: "stdio", command: "cf" } } }, { mcp: { toolPermissions: { cf__prod: { "*": "deny" } } } });
    const sdk = join(home, "sdk", "settings.json");
    writeFileSync(sdk, JSON.stringify({ permissions: { deny: ["mcp__cf__prod__drop", "mcp__cf__list"] } }));
    const r = await c.request(METHODS.mcpRemove, { name: "cf", scope: "user" });
    expect(r.result).toMatchObject({ removed: true, rulesDropped: 1 });
    expect(r.result.rulesNotFollowed[0]).toContain('may name server "cf__prod"');
    expect(JSON.parse(readFileSync(sdk, "utf8")).permissions.deny).toEqual(["mcp__cf__prod__drop"]);
    c.close();
  });

  test("round 2 N2: remove, once the name is unused, drops its sdk/settings.json rules and lists the repository ones", async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "winter-mcp-rename-proj-")));
    mkdirSync(join(project, ".winter"), { recursive: true });
    writeFileSync(join(project, ".winter", "settings.local.json"), JSON.stringify({ permissions: { allow: ["mcp__cf__write"] } }));
    const { home, c, trust } = await boot({ mcpServers: { cf: { type: "stdio", command: "cf" } } });
    trust.trust(project);
    const sdk = join(home, "sdk", "settings.json");
    writeFileSync(sdk, JSON.stringify({ permissions: { allow: ["mcp__cf__list", "Read"], deny: ["mcp__cf"] } }));
    const r = await c.request(METHODS.mcpRemove, { name: "cf", scope: "user" });
    expect(r.result).toMatchObject({ removed: true, rulesDropped: 2, rulesNotFollowed: [`${join(project, ".winter", "settings.local.json")}: mcp__cf__write`] });
    expect(JSON.parse(readFileSync(sdk, "utf8")).permissions).toEqual({ allow: ["Read"], deny: [] });
    c.close();
  });

  test("round 2 N2: rename refuses a target that rules already name — sdk/settings.json, a trusted project, the approved record", async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "winter-mcp-rename-proj-")));
    const { home, c, trust } = await boot({ mcpServers: { cf: { type: "stdio", command: "cf" } } });
    const sdk = join(home, "sdk", "settings.json");
    const code = async () => (await c.request(METHODS.mcpRename, { name: "cf", newName: "neo", scope: "user" })).error?.data?.code;
    writeFileSync(sdk, JSON.stringify({ permissions: { ask: ["mcp__neo__x"] } }));
    expect(await code()).toBe("mcp_rename_target_has_permissions");
    writeFileSync(sdk, JSON.stringify({}));
    trust.trust(project);
    mkdirSync(join(project, ".winter"), { recursive: true });
    writeFileSync(join(project, ".winter", "settings.json"), JSON.stringify({ permissions: { deny: ["mcp__neo"] } }));
    expect(await code()).toBe("mcp_rename_target_has_permissions");
    writeFileSync(join(project, ".winter", "settings.json"), JSON.stringify({}));
    mkdirSync(join(home, "permissions"), { recursive: true });
    writeFileSync(join(home, "permissions", "projects.json"), JSON.stringify({ version: 1, projects: { [project]: ["mcp__neo__y"] } }));
    expect(await code()).toBe("mcp_rename_target_has_permissions");
    expect(Object.keys(configOf(home).mcpServers)).toEqual(["cf"]);
    rmSync(join(home, "permissions", "projects.json"));
    expect((await c.request(METHODS.mcpRename, { name: "cf", newName: "neo", scope: "user" })).result.ok).toBe(true);
    c.close();
  });

  test("not remote-allowed — local role only", () => {
    expect(REMOTE_ALLOWED_METHODS.has(METHODS.mcpRename)).toBe(false);
  });
});
