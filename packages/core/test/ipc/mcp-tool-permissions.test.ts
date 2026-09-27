// WS-26: the connector-permission RPCs — `mcp.tools` (each server's actions, the stored value, what applies
// and where it came from) and `mcp.setToolPermission` (the write door) — over a bare IPC server harness, the
// shape `mcp-enable-disable.test.ts` uses. The probe is a real `McpManager` over a fake SDK connect, so the
// read-only answers come from a `tools/list` exactly as production's do.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, McpToolsResult, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { startIpcServer, REMOTE_ALLOWED_METHODS } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { Settings, saveSettings } from "../../src/settings";
import { McpManager } from "../../src/agent/mcp/manager";
import { TrustStore } from "../../src/agent/trust";
import type { ConnectorPermissionSource } from "../../src/agent/mcp/connector-permissions";

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

const CF_TOOLS = [
  { name: "workers_list", description: "List Workers", annotations: { readOnlyHint: true } },
  { name: "workers_delete", description: "Delete a Worker", annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: "kv_put" },
];

describe("mcp.tools / mcp.setToolPermission", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(opts: { settings?: Record<string, unknown>; sdkSettings?: Record<string, unknown>; connectorPermissions?: ConnectorPermissionSource } = {}) {
    const home = mkdtempSync(join(tmpdir(), "winter-mcp-tools-"));
    saveSettings(join(home, "settings.json"), Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" }, ...opts.settings }));
    mkdirSync(join(home, "sdk"), { recursive: true });
    writeFileSync(join(home, "sdk", ".winter.json"), JSON.stringify({ mcpServers: { cf: { type: "stdio", command: "cf-mcp" } } }, null, 2));
    if (opts.sdkSettings) writeFileSync(join(home, "sdk", "settings.json"), JSON.stringify(opts.sdkSettings, null, 2));
    const trust = new TrustStore(join(home, "trust.json"));
    const mcp = new McpManager({
      trust, stdioCwd: home,
      connect: async () => ({ serverName: "cf", listTools: async () => CF_TOOLS.map((t) => ({ inputSchema: {}, ...t })), close: async () => {} }) as never,
    });
    await mcp.startAll({ cf: { command: "cf-mcp" } });
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const secrets = new FileSecretStore(join(home, "secrets"));
    const authority = new TokenAuthority(secrets);
    const tokens = await authority.ensureTokens();
    const saved: unknown[] = [];
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, winterHome: home, secrets, mcp, onConnectorPermissionsSaved: (next) => { saved.push(next.mcp?.toolPermissions); }, ...(opts.connectorPermissions ? { connectorPermissions: opts.connectorPermissions } : {}) });
    stop = () => { server.stop(); store.close(); };
    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "cli");
    return { home, c, saved };
  }

  test("each action with its description, read-only mark and default (read-only → allow, else ask)", async () => {
    const { c } = await boot();
    const r = await c.request(METHODS.mcpTools, {});
    expect(McpToolsResult.parse(r.result)).toBeTruthy();
    const cf = r.result.servers.find((s: { name: string }) => s.name === "cf");
    expect(cf).toMatchObject({ name: "cf", status: "connected", source: "user", listed: true });
    expect(cf.tools).toEqual([
      { name: "workers_list", toolName: "mcp__cf__workers_list", description: "List Workers", readOnly: true, permission: "allow", source: "default" },
      { name: "workers_delete", toolName: "mcp__cf__workers_delete", description: "Delete a Worker", readOnly: false, permission: "ask", source: "default" },
      { name: "kv_put", toolName: "mcp__cf__kv_put", readOnly: false, permission: "ask", source: "default" },
    ]);
    c.close();
  });

  test("setToolPermission writes settings.mcp.toolPermissions; mcp.tools reports the stored value and its source", async () => {
    const { home, c, saved } = await boot();
    expect((await c.request(METHODS.mcpSetToolPermission, { server: "cf", tool: "*", permission: "deny" })).result).toEqual({ ok: true, server: "cf", tool: "*", permission: "deny" });
    expect((await c.request(METHODS.mcpSetToolPermission, { server: "cf", tool: "workers_list", permission: "allow" })).result.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).mcp.toolPermissions).toEqual({ cf: { "*": "deny", workers_list: "allow" } });
    // The daemon hook fired with what was written (the next decision sees it with no watcher wait).
    expect(saved.at(-1)).toEqual({ cf: { "*": "deny", workers_list: "allow" } });
    const cf = (await c.request(METHODS.mcpTools, { server: "cf" })).result.servers[0];
    expect(cf.allTools).toBe("deny");
    expect(cf.tools.map((t: Record<string, unknown>) => [t.name, t.setting, t.permission, t.source])).toEqual([
      ["workers_list", "allow", "allow", "tool"],
      ["workers_delete", undefined, "deny", "server"],
      ["kv_put", undefined, "deny", "server"],
    ]);
    // "default" clears one; the all-actions value with resetTools clears every per-action value.
    await c.request(METHODS.mcpSetToolPermission, { server: "cf", tool: "workers_list", permission: "default" });
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).mcp.toolPermissions).toEqual({ cf: { "*": "deny" } });
    await c.request(METHODS.mcpSetToolPermission, { server: "cf", tool: "kv_put", permission: "ask" });
    await c.request(METHODS.mcpSetToolPermission, { server: "cf", tool: "*", permission: "allow", resetTools: true });
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).mcp.toolPermissions).toEqual({ cf: { "*": "allow" } });
    await c.request(METHODS.mcpSetToolPermission, { server: "cf", tool: "*", permission: "default" });
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).mcp.toolPermissions).toBeUndefined();
    c.close();
  });

  test("sdk/settings.json rules are reported; a deny rule is what applies (it binds natively in every mode)", async () => {
    const { c } = await boot({ sdkSettings: { permissions: { deny: ["mcp__cf__workers_delete"], allow: ["mcp__cf__*", "mcp__cf"] } } });
    await c.request(METHODS.mcpSetToolPermission, { server: "cf", tool: "workers_delete", permission: "allow" });
    const tools = (await c.request(METHODS.mcpTools, { server: "cf" })).result.servers[0].tools;
    const del = tools.find((t: { name: string }) => t.name === "workers_delete");
    expect(del).toMatchObject({ setting: "allow", permission: "deny", source: "rule", rules: [{ behavior: "deny", rule: "mcp__cf__workers_delete" }, { behavior: "allow", rule: "mcp__cf__*" }] });
    const put = tools.find((t: { name: string }) => t.name === "kv_put");
    expect(put).toMatchObject({ permission: "ask", source: "default", rules: [{ behavior: "allow", rule: "mcp__cf__*" }] });
    c.close();
  });

  test("a stored value for a server or tool nobody lists is still shown (so it can be cleared)", async () => {
    const { c } = await boot({ settings: { mcp: { toolPermissions: { gone: { old_tool: "deny" }, cf: { retired: "ask" } } } } });
    const servers = (await c.request(METHODS.mcpTools, {})).result.servers;
    expect(servers.find((s: { name: string }) => s.name === "gone")).toEqual({
      name: "gone", status: "unknown", listed: false,
      tools: [{ name: "old_tool", toolName: "mcp__gone__old_tool", readOnly: false, setting: "deny", permission: "deny", source: "tool" }],
    });
    expect(servers.find((s: { name: string }) => s.name === "cf").tools.at(-1)).toMatchObject({ name: "retired", setting: "ask", readOnly: false });
    c.close();
  });

  test("validation: the permission vocabulary, whitespace, Winter's own namespace, resetTools on one action", async () => {
    const { home, c } = await boot();
    for (const params of [
      { server: "cf", tool: "x", permission: "always" },
      { server: "cf", tool: "x" },
      { server: "c f", tool: "x", permission: "deny" },
      { server: "cf", tool: "", permission: "deny" },
      { server: "winter", tool: "x", permission: "deny" },
      { server: "winter__research", tool: "*", permission: "deny" },
      { server: "cf", tool: "x", permission: "deny", resetTools: true },
    ]) {
      const r = await c.request(METHODS.mcpSetToolPermission, params);
      expect(r.error?.code).toBe(-32602);
    }
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).mcp?.toolPermissions).toBeUndefined();
    c.close();
  });

  test("review r1 minor 4: mcp.tools reports what enforcement reads — the daemon's live table and its scope-aware read-only answers", async () => {
    // Disk says nothing; the live source (what the hook and the bridge decide on) says deny, and read-only false.
    const live: ConnectorPermissionSource = { table: () => ({ cf: { workers_list: "deny" } }), readOnly: () => false };
    const { c } = await boot({ connectorPermissions: live });
    const tools = (await c.request(METHODS.mcpTools, { server: "cf" })).result.servers[0].tools;
    expect(tools.find((t: { name: string }) => t.name === "workers_list")).toMatchObject({ setting: "deny", permission: "deny", source: "tool", readOnly: false });
    expect(tools.find((t: { name: string }) => t.name === "kv_put")).toMatchObject({ permission: "ask", source: "default" });
    c.close();
  });

  test("re-review minor: a value stored under ANOTHER server name says whose (`from`)", async () => {
    // cf's own `workers_list` is only cf's; a cf tool whose name starts `prod__` is ALSO cf__prod's.
    const table = { cf__prod: { "*": "deny" as const }, cf: { prod__x: "ask" as const } };
    const live: ConnectorPermissionSource = { table: () => table, readOnly: () => undefined };
    const { c: c2 } = await boot({ settings: { mcp: { toolPermissions: table } }, connectorPermissions: live });
    const tools = (await c2.request(METHODS.mcpTools, { server: "cf" })).result.servers[0].tools;
    expect(tools.find((t: { name: string }) => t.name === "prod__x")).toMatchObject({ setting: "ask", permission: "deny", source: "server", from: "cf__prod" });
    expect(tools.find((t: { name: string }) => t.name === "workers_list").from).toBeUndefined();
    c2.close();
  });

  test("WS-27: a subagent definition's inline server is listed (mcp.list source agent) and its values set by config name", async () => {
    const { home, c } = await boot();
    mkdirSync(join(home, "sdk", "agents"), { recursive: true });
    writeFileSync(join(home, "sdk", "agents", "helper.md"), "---\nname: helper\ndescription: helps\nmcpServers:\n  - cf\n  - db:\n      command: db-mcp\n---\nHelp.\n");
    const list = (await c.request(METHODS.mcpList, {})).result.servers;
    expect(list.find((s: { name: string }) => s.name === "db")).toEqual({ name: "db", status: "unmanaged", toolNames: [], source: "agent" });
    // `cf` is also referenced by name — the user server's row stands, no duplicate agent row.
    expect(list.filter((s: { name: string }) => s.name === "cf").map((s: { source: string }) => s.source)).toEqual(["user"]);
    await c.request(METHODS.mcpSetToolPermission, { server: "db", tool: "query", permission: "deny" });
    const r = await c.request(METHODS.mcpTools, { server: "db" });
    expect(McpToolsResult.parse(r.result)).toBeTruthy();
    expect(r.result.servers).toEqual([{ name: "db", status: "unknown", source: "agent", listed: false, tools: [
      { name: "query", toolName: "mcp__db__query", readOnly: false, setting: "deny", permission: "deny", source: "tool" },
    ] }]);
    c.close();
  });

  test("not remote-allowed — local role only", () => {
    expect(REMOTE_ALLOWED_METHODS.has(METHODS.mcpTools)).toBe(false);
    expect(REMOTE_ALLOWED_METHODS.has(METHODS.mcpSetToolPermission)).toBe(false);
  });
});
