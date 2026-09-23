// WS-21 L3.5 (spec §4.4): `winter mcp add` = `claude mcp add` — three scopes, claude's default:
//   local    `sdk/.winter.json` → `projects[<canonical project root>].mcpServers`   (the default)
//   user     `sdk/.winter.json` → `mcpServers`
//   project  `<project root>/.winter/mcp.json`                                     (the repo-root `.mcp.json` is never read)
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { Settings, saveSettings, sdkLocalMcpServers, sdkUserMcpServers } from "../../src/settings";
import { McpManager } from "../../src/agent/mcp/manager";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { TrustStore } from "../../src/agent/trust";
import { configuredMcpServersFor } from "../../src/runtime-sdk/external-mcp";

const tmp = (p: string): string => realpathSync(mkdtempSync(join(tmpdir(), p)));

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
            if (msg.id !== undefined && c.pending.has(msg.id)) { c.pending.get(msg.id)!(msg); c.pending.delete(msg.id); }
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
  close(): void { this.socket.end(); }
}

describe("mcp.add / remove / get over the three scopes", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot() {
    const home = tmp("winter-mcpscope-home-");
    const project = tmp("winter-mcpscope-proj-");
    saveSettings(join(home, "settings.json"), Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } }));
    const trust = new TrustStore(join(home, "trust.json"));
    const mcp = new McpManager({ registry: new ToolRegistry(), trust });
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, winterHome: home, secrets: new FileSecretStore(join(home, "s2")), mcp });
    const c = await TestClient.connect(socketPath);
    await c.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token: tokens.harness, clientName: "cli" });
    stop = () => { c.close(); server.stop(); store.close(); };
    const config = (): Record<string, any> => { const p = join(home, "sdk", ".winter.json"); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {}; };
    return { home, project, c, config };
  }
  const stdio: { type: "stdio"; command: string; args: string[] } = { type: "stdio", command: "node", args: ["srv.js"] };

  test("mcp.add defaults to LOCAL: sdk/.winter.json projects[<root>].mcpServers", async () => {
    const { home, project, c, config } = await boot();
    const add = await c.request(METHODS.mcpAdd, { name: "loc", entry: stdio, cwd: project });
    expect(add.result).toEqual({ ok: true, name: "loc", transport: "stdio", started: false, scope: "local" });
    expect(config().projects[project].mcpServers).toEqual({ loc: stdio });
    expect(config().mcpServers).toBeUndefined();
    expect(sdkLocalMcpServers(home, project).loc).toEqual(stdio);
    const got = await c.request(METHODS.mcpGet, { name: "loc", cwd: project });
    expect(got.result).toMatchObject({ found: true, scope: "local", command: "node" });
    expect((await c.request(METHODS.mcpRemove, { name: "loc", cwd: project })).result).toEqual({ ok: true, name: "loc", removed: true, scope: "local" });
    expect(config().projects[project].mcpServers).toEqual({});
  });

  test("local and project scopes need a cwd — refused typed without one", async () => {
    const { c } = await boot();
    for (const scope of ["local", "project"] as const) {
      const res = await c.request(METHODS.mcpAdd, { name: "x", entry: stdio, scope });
      expect(res.error?.data?.code).toBe("mcp_scope_needs_cwd");
    }
  });

  test("scope project writes <root>/.winter/mcp.json (claude's .mcp.json format) and never the repo root's .mcp.json", async () => {
    const { project, c } = await boot();
    const add = await c.request(METHODS.mcpAdd, { name: "team", entry: stdio, scope: "project", cwd: project });
    expect(add.result.scope).toBe("project");
    expect(JSON.parse(readFileSync(join(project, ".winter", "mcp.json"), "utf8"))).toEqual({ mcpServers: { team: stdio } });
    expect(existsSync(join(project, ".mcp.json"))).toBe(false);
    expect((await c.request(METHODS.mcpGet, { name: "team", scope: "project", cwd: project })).result.found).toBe(true);
    expect((await c.request(METHODS.mcpRemove, { name: "team", scope: "project", cwd: project })).result.removed).toBe(true);
  });

  test("a project entry keeps a credential-shaped header (claude parity); the user's own file refuses one", async () => {
    const { project, c } = await boot();
    const http = { type: "http", url: "https://team.test/mcp", headers: { Authorization: "Bearer team" } } as const;
    expect((await c.request(METHODS.mcpAdd, { name: "shared", entry: http, scope: "project", cwd: project })).result.ok).toBe(true);
    const local = await c.request(METHODS.mcpAdd, { name: "mine", entry: http, scope: "local", cwd: project });
    expect(local.error?.message).toMatch(/credential-shaped/);
    expect(local.error?.message).not.toContain("Bearer team");
  });

  test("the scopes are independent: the same name in two scopes is two entries", async () => {
    const { home, project, c } = await boot();
    await c.request(METHODS.mcpAdd, { name: "dup", entry: stdio, scope: "user" });
    expect((await c.request(METHODS.mcpAdd, { name: "dup", entry: stdio, scope: "local", cwd: project })).result.ok).toBe(true);
    expect(sdkUserMcpServers(home).dup).toBeDefined();
    expect(sdkLocalMcpServers(home, project).dup).toBeDefined();
    const again = await c.request(METHODS.mcpAdd, { name: "dup", entry: stdio, scope: "local", cwd: project });
    expect(again.error?.message).toMatch(/already exists in local config/);
  });
});

// What reaches a child on a build whose router does not apply run homes (the run folder carries the same
// fold on one that does): claude's precedence local > project > user, the project file only when trusted,
// and the repo-root `.mcp.json` never.
describe("configuredMcpServersFor (WS-21 scopes)", () => {
  const cmd = (command: string) => ({ type: "stdio" as const, command });

  test("a repo-root .mcp.json is ignored; <root>/.winter/mcp.json is read (trusted only)", () => {
    const project = tmp("winter-mcpscope-cfg-");
    writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { legacy: { command: "old" } } }));
    mkdirSync(join(project, ".winter"), { recursive: true });
    writeFileSync(join(project, ".winter", "mcp.json"), JSON.stringify({ mcpServers: { team: { command: "new" } } }));
    const trusted = configuredMcpServersFor({ settings: null, cwd: project, trusted: () => true });
    expect(Object.keys(trusted)).toEqual(["team"]);
    expect(configuredMcpServersFor({ settings: null, cwd: project, trusted: () => false })).toEqual({});
  });

  test("precedence: local > project > user; mcp.disabled withholds from every tier", () => {
    const project = tmp("winter-mcpscope-prec-");
    mkdirSync(join(project, ".winter"), { recursive: true });
    writeFileSync(join(project, ".winter", "mcp.json"), JSON.stringify({ mcpServers: { a: { command: "project-a" }, b: { command: "project-b" } } }));
    const out = configuredMcpServersFor({
      settings: { mcp: { disabled: ["gone"] } } as never,
      userMcpServers: { a: cmd("user-a"), b: cmd("user-b"), c: cmd("user-c"), gone: cmd("user-gone") },
      localMcpServers: { a: cmd("local-a") },
      cwd: project, trusted: () => true,
    });
    expect(out.a).toEqual({ type: "stdio", command: "local-a" });
    expect(out.b).toEqual({ type: "stdio", command: "project-b" });
    expect(out.c).toEqual({ type: "stdio", command: "user-c" });
    expect(out.gone).toBeUndefined();
  });
});
