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
import { localScopeKeyFor, runHomeInputFor } from "../../src/runtime-sdk/run-home-input";
import { buildRunHome } from "@yanlinglabs/winter-runtime-sdk";

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

// Review I5 (controller ruling): ONE key for the local scope — `localScopeKeyFor(cwd)`, exactly the
// `RunHomeInput.gitRoot` the daemon hands the router (a worktree's OWN top, realpathed), else the realpathed
// cwd. `repoRootFor` follows a linked worktree to its MAIN checkout, so a server added from a worktree used
// to be written under a key the run home never reads.
describe("review I5: localScopeKeyFor", () => {
  function repoWithWorktree(): { main: string; wt: string } {
    const main = tmp("winter-i5-main-");
    const git = (...args: string[]) => expect(Bun.spawnSync(["git", "-C", main, ...args]).exitCode).toBe(0);
    git("init", "-q");
    writeFileSync(join(main, "f"), "x");
    git("add", "f");
    git("commit", "-q", "-m", "init");
    const wt = join(tmp("winter-i5-wtparent-"), "wt");
    git("worktree", "add", "-q", "-b", "side", wt);
    return { main, wt: realpathSync(wt) };
  }

  test("a linked worktree keys by its own top-level, exactly the run home's gitRoot", () => {
    const { main, wt } = repoWithWorktree();
    const sub = join(wt, "pkg");
    mkdirSync(sub, { recursive: true });
    expect(localScopeKeyFor(sub)).toBe(wt);
    expect(localScopeKeyFor(sub)).not.toBe(main);
    const input = runHomeInputFor({ home: "/h", trust: { isTrusted: () => false }, settings: () => null, reservedMcpServerNames: [] }, { mode: "code", dispatchChild: false, leg: "winter", cwd: sub });
    expect(localScopeKeyFor(sub)).toBe(input.gitRoot ?? realpathSync(input.cwd));
  });

  test("outside a repository: the realpathed cwd (the router's fallback)", () => {
    const dir = tmp("winter-i5-norepo-");
    expect(localScopeKeyFor(dir)).toBe(dir);
  });

  test("mcp.add local from a worktree writes under that key; the child reading it is configuredMcpServersFor's local tier", async () => {
    const { wt } = repoWithWorktree();
    const home = tmp("winter-i5-home-");
    saveSettings(join(home, "settings.json"), Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } }));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, winterHome: home, secrets: new FileSecretStore(join(home, "s2")), mcp: new McpManager({ registry: new ToolRegistry(), trust: new TrustStore(join(home, "trust.json")) }) });
    try {
      const c = await TestClient.connect(socketPath);
      await c.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token: tokens.harness, clientName: "cli" });
      const add = await c.request(METHODS.mcpAdd, { name: "wtsrv", entry: { type: "stdio", command: "node" }, cwd: wt });
      expect(add.result?.ok).toBe(true);
      expect(Object.keys(sdkLocalMcpServers(home, localScopeKeyFor(wt)))).toEqual(["wtsrv"]);
      c.close();
    } finally { server.stop(); store.close(); }
  });
});

// R.3 residual (controller ruling): the PROJECT scope is the cwd's own git top — a linked worktree's own top,
// what claude's `--scope project` writes at and the run home reads the project tier from — for every
// project-scope reader and writer; trust stays keyed on `repoRootFor(cwd)` (a worktree of a trusted repo is
// trusted). From the main checkout nothing changes.
describe("R.3 residual: MCP project scope from a linked worktree of a trusted repo", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  function bed() {
    const main = tmp("winter-r3p-main-");
    const git = (...args: string[]) => expect(Bun.spawnSync(["git", "-C", main, ...args], { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
    git("init", "-q");
    git("-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "i");
    const wt = join(tmp("winter-r3p-wtparent-"), "wt");
    git("worktree", "add", "-q", "-b", `r3p-${Math.random().toString(16).slice(2)}`, wt);
    const home = tmp("winter-r3p-home-");
    mkdirSync(join(home, "sdk"), { recursive: true });
    saveSettings(join(home, "settings.json"), Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } }));
    const trust = new TrustStore(join(home, "trust.json"));
    trust.trust(main);
    return { main, wt: realpathSync(wt), home, trust };
  }
  async function serve(home: string, trust: TrustStore) {
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, winterHome: home, secrets: new FileSecretStore(join(home, "s2")), trust, mcp: new McpManager({ registry: new ToolRegistry(), trust }) });
    const c = await TestClient.connect(socketPath);
    await c.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token: tokens.harness, clientName: "cli" });
    stop = () => { c.close(); server.stop(); store.close(); };
    return c;
  }
  /** Every MCP server name a BUILT run home for `cwd` hands its child (`<run>/.winter.json`). */
  async function runHomeServers(home: string, trust: TrustStore, cwd: string): Promise<string[]> {
    const rh = await buildRunHome(runHomeInputFor({ home, trust, settings: () => null, reservedMcpServerNames: [] }, { mode: "code", dispatchChild: false, leg: "winter", cwd }));
    try {
      const config = JSON.parse(readFileSync(join(rh.dir, ".winter.json"), "utf8")) as { mcpServers?: Record<string, unknown>; projects?: Record<string, { mcpServers?: Record<string, unknown> }> };
      return [...new Set([...Object.keys(config.mcpServers ?? {}), ...Object.values(config.projects ?? {}).flatMap((p) => Object.keys(p.mcpServers ?? {}))])].sort();
    } finally { await rh.dispose(); }
  }
  const stdio = { type: "stdio" as const, command: "node", args: ["srv.js"] };

  test("mcp.add --scope project writes the WORKTREE's .winter/mcp.json, and the worktree's built run home lists the server", async () => {
    const b = bed();
    const c = await serve(b.home, b.trust);
    expect((await c.request(METHODS.mcpAdd, { name: "wtsrv", entry: stdio, scope: "project", cwd: b.wt })).result?.ok).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(join(b.wt, ".winter", "mcp.json"), "utf8")).mcpServers)).toEqual(["wtsrv"]);
    expect(existsSync(join(b.main, ".winter", "mcp.json"))).toBe(false);
    expect((await c.request(METHODS.mcpGet, { name: "wtsrv", scope: "project", cwd: b.wt })).result.found).toBe(true);
    expect(await runHomeServers(b.home, b.trust, b.wt)).toContain("wtsrv");
    // the daemon's own reader of the project tier (a session with no run home) reads the same file
    expect(Object.keys(configuredMcpServersFor({ settings: null, cwd: b.wt, trusted: (d) => b.trust.isTrusted(d) }))).toEqual(["wtsrv"]);
    expect((await c.request(METHODS.mcpRemove, { name: "wtsrv", scope: "project", cwd: b.wt })).result.removed).toBe(true);
  });

  test("from the MAIN checkout nothing changes: its own .winter/mcp.json, its own run home", async () => {
    const b = bed();
    const c = await serve(b.home, b.trust);
    expect((await c.request(METHODS.mcpAdd, { name: "mainsrv", entry: stdio, scope: "project", cwd: b.main })).result?.ok).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(join(b.main, ".winter", "mcp.json"), "utf8")).mcpServers)).toEqual(["mainsrv"]);
    expect(existsSync(join(b.wt, ".winter", "mcp.json"))).toBe(false);
    expect(await runHomeServers(b.home, b.trust, b.main)).toContain("mainsrv");
    expect(await runHomeServers(b.home, b.trust, b.wt)).not.toContain("mainsrv");
    expect(Object.keys(configuredMcpServersFor({ settings: null, cwd: b.main, trusted: (d) => b.trust.isTrusted(d) }))).toEqual(["mainsrv"]);
  });
});
