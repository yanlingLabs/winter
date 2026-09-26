// WS-24: the plugin supervisor is keyed by a plugin's SPEC ("<name>@<marketplace>") — the key every other
// plugin surface already used. Before, it was the bare name, so `plugin.enable` of one marketplace's `p`
// and another's `p` shared ONE runtime (the second enable restarted the first's process under the second's
// config), and `plugin.disable` of either stopped both. Over the wire, against a real IPC server and a
// supervisor with an injected (never-OS) spawn.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { PluginSupervisor, type SpawnFn, type SupervisedProcess } from "../../src/plugins/supervisor";
import { addMarketplace, installPlugin, type PluginManagerOptions } from "../../src/plugins/plugin-manager";
import { pluginConsentFingerprint } from "../../src/plugins/consent-fingerprint";
import { PluginStore } from "../../src/agent/plugins";

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

const ENTRY = { command: "bun", args: ["index.ts"] };

describe("two marketplaces' same-named Tier-2 plugins over the wire (WS-24)", () => {
  let home: string;
  let stop: (() => void) | undefined;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "winter-ws24-spec-")); });
  afterEach(() => { stop?.(); stop = undefined; rmSync(home, { recursive: true, force: true }); });

  async function boot() {
    const options: PluginManagerOptions = { pluginsRoot: join(home, "sdk", "plugins"), settingsPathFor: () => join(home, "sdk", "settings.json") };
    const consents: Record<string, unknown> = {};
    for (const mkt of ["m1", "m2"]) {
      const dir = join(home, `mkt-${mkt}`);
      mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
      writeFileSync(join(dir, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: mkt, owner: { name: "t" }, plugins: [{ name: "p", source: "./plugins/p" }] }));
      mkdirSync(join(dir, "plugins", "p"), { recursive: true });
      writeFileSync(join(dir, "plugins", "p", "winter-plugin.json"), JSON.stringify({ id: "p", tier: "platform", permissions: { exec: true }, contributes: { tools: true }, entry: ENTRY }));
      await addMarketplace(options, dir);
      const installed = await installPlugin(options, `p@${mkt}`, "user");
      consents[`p@${mkt}`] = { classes: ["exec"], fingerprint: pluginConsentFingerprint(installed.installPath, { entry: ENTRY, requiredConsents: ["exec"] }) };
    }
    writeFileSync(join(home, "settings.json"), JSON.stringify({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" }, plugins: { consents } }));

    const spawned: Array<{ id: string; cwd: string }> = [];
    let pid = 7000;
    const spawn: SpawnFn = (_cmd, opts) => {
      spawned.push({ id: opts.env.WINTER_PLUGIN_ID!, cwd: opts.cwd });
      const proc: SupervisedProcess = { pid: pid++, exited: new Promise<number>(() => {}), kill: () => {} };
      return proc;
    };
    const store = new SessionStore(home);
    const supervisor = new PluginSupervisor({
      runDir: join(home, "run"), socketPath: join(home, "core.sock"), mintToken: (id) => store.mintPluginToken(id), spawn,
      isAlivePid: () => false, signalPid: () => {}, processStartedAt: () => "t", settings: { registrationTimeoutMs: 60_000 },
    });
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets")));
    const tokens = await authority.ensureTokens();
    const socketPath = join(home, "core.sock");
    const server = startIpcServer({
      socketPath, serverVersion: "test", tokens: authority, store, winterHome: home, secrets: new FileSecretStore(join(home, "s2")),
      supervisor, registry: new ToolRegistry(), plugins: new PluginStore({ winterHome: home, consents }),
    });
    const c = await TestClient.connect(socketPath);
    await c.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token: tokens.harness, clientName: "cli" });
    stop = () => { c.close(); supervisor.stopAll(); server.stop(); store.close(); };
    return { c, supervisor, spawned };
  }

  test("PluginStore names each install by its own spec", async () => {
    await boot();
    const specs = new PluginStore({ winterHome: home }).list().map((p) => [p.name, p.spec]).sort();
    expect(specs).toEqual([["p", "p@m1"], ["p", "p@m2"]]);
  });

  test("enable starts one runtime per spec; disabling one leaves the other running", async () => {
    const { c, supervisor, spawned } = await boot();
    expect((await c.request(METHODS.pluginEnable, { spec: "p@m1", scope: "user" })).result?.ok).toBe(true);
    expect((await c.request(METHODS.pluginEnable, { spec: "p@m2", scope: "user" })).result?.ok).toBe(true);
    expect(supervisor.status("p@m1")).toBe("starting");
    expect(supervisor.status("p@m2")).toBe("starting");
    expect(spawned.map((s) => s.id)).toEqual(["p@m1", "p@m2"]);
    expect(spawned[0]!.cwd).not.toBe(spawned[1]!.cwd); // each from its own install

    expect((await c.request(METHODS.pluginDisable, { spec: "p@m1", scope: "user" })).result?.ok).toBe(true);
    expect(supervisor.status("p@m1")).toBe("stopped");
    expect(supervisor.status("p@m2")).toBe("starting");
  });

  test("plugin.restart takes the spec; a bare name resolves only when it names one plugin", async () => {
    const { c, supervisor } = await boot();
    await c.request(METHODS.pluginEnable, { spec: "p@m1", scope: "user" });
    // One tracked `p`: the bare name (older clients, `winter plugin restart p`) still works.
    expect((await c.request(METHODS.pluginRestart, { pluginId: "p" })).result).toEqual({ ok: true });
    await c.request(METHODS.pluginEnable, { spec: "p@m2", scope: "user" });
    const ambiguous = await c.request(METHODS.pluginRestart, { pluginId: "p" });
    expect(ambiguous.error?.message).toMatch(/more than one marketplace/);
    expect((await c.request(METHODS.pluginRestart, { pluginId: "p@m2" })).result).toEqual({ ok: true });
    expect(supervisor.status("p@m2")).toBe("starting");
    expect((await c.request(METHODS.pluginRestart, { pluginId: "q" })).error).toBeDefined();
  });
});

describe("boot: a bare-name plugin token from the old key is revoked (WS-24)", () => {
  test("a token a pre-WS-24 core minted under the bare name no longer verifies; the spec's own mint still works", async () => {
    const { startDaemon } = await import("../../src/daemon");
    const home = mkdtempSync(join(tmpdir(), "winter-ws24-token-"));
    try {
      const options: PluginManagerOptions = { pluginsRoot: join(home, "sdk", "plugins"), settingsPathFor: () => join(home, "sdk", "settings.json") };
      const dir = join(home, "mkt");
      mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
      writeFileSync(join(dir, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "m", owner: { name: "t" }, plugins: [{ name: "p", source: "./plugins/p" }] }));
      mkdirSync(join(dir, "plugins", "p"), { recursive: true });
      await addMarketplace(options, dir);
      await installPlugin(options, "p@m", "user");
      const before = new SessionStore(home);
      const legacy = before.mintPluginToken("p"); // what a bare-name-keyed core minted
      before.close();

      const daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")), agentProvider: null });
      try {
        expect(daemon.sessions.verifyPluginToken("p", legacy)).toBe(false);
        const fresh = daemon.sessions.mintPluginToken("p@m");
        expect(daemon.sessions.verifyPluginToken("p@m", fresh)).toBe(true);
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
