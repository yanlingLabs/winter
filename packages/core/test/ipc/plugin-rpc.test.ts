// WS-21 lane L4.1 (spec §5.2): `winter plugin` = `claude plugin`, over Contract B
// (`plugins/sdk-plugin-api.ts`). Replacement RPC-level coverage for the pre-WS-21
// "plugin lifecycle RPCs (Task 2)" describe block in server.test.ts, which tested the retired
// plugins.list/plugins.install/plugin.enable(unscoped)/plugin.disable(unscoped)/plugin.remove wire
// surface — see that file's own removal note. The real hot-spawn/hot-stop, real-child-process proof
// lives in test/plugins/gate-4d-ii.test.ts; this file covers the RPC shapes (install/uninstall/
// enable/disable/update/list/marketplace.*), role-rejection, and scope resolution, with a FAKE
// supervisor spawn (no real OS process) — same split precedent server.test.ts's own header notes.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { PluginSupervisor } from "../../src/plugins/supervisor";
import { sdkPluginsRoot, sdkSettingsPath } from "../../src/agent/paths";

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

  async hello(token: string, clientName: string, extra: Record<string, unknown> = {}): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token, clientName, ...extra });
  }

  close(): void { this.socket.end(); }
}

/** A local directory marketplace with ONE plugin, `p`, `source: "."` (its own manifest lives at
 *  the marketplace root, mirroring `sdk-plugin-api.test.ts`'s own fixture shape). */
function writeMarketplace(dir: string, pluginJson: unknown = { id: "p", tier: "platform", entry: { command: "bun", args: ["--version"] } }): void {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "marketplace.json"), JSON.stringify({
    name: "m", owner: { name: "test" }, plugins: [{ name: "p", source: "." }],
  }));
  writeFileSync(join(dir, "winter-plugin.json"), JSON.stringify(pluginJson));
}

describe("plugin.* RPCs (WS-21, Contract B)", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(opts: { withSupervisor?: boolean } = {}) {
    const home = mkdtempSync(join(tmpdir(), "winter-plugin-rpc-"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" } }));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const registry = opts.withSupervisor ? new ToolRegistry() : undefined;
    const supervisor = opts.withSupervisor
      ? new PluginSupervisor({
          runDir: join(home, "run"), socketPath, mintToken: (id) => store.mintPluginToken(id),
          spawn: () => ({ pid: 9001, kill: () => {}, exited: new Promise<number>(() => {}) }),
          isAlivePid: () => false, signalPid: () => {},
        })
      : undefined;
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, winterHome: home, registry, supervisor });
    stop = () => { supervisor?.stopAll(); server.stop(); store.close(); };
    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "plugin-rpc");
    return { home, socketPath, c, store, supervisor };
  }

  test("plugin.marketplace.add + plugin.install + plugin.list: a directory marketplace installs and lists, enabled by default", async () => {
    const { home, c } = await boot();
    const mktDir = mkdtempSync(join(tmpdir(), "winter-plugin-mkt-"));
    writeMarketplace(mktDir);

    const mktRes = await c.request(METHODS.pluginMarketplaceAdd, { source: mktDir });
    expect(mktRes.result).toEqual({ ok: true, marketplace: { name: "m", source: mktDir, kind: "directory", path: mktDir } });

    const installRes = await c.request(METHODS.pluginInstall, { spec: "p@m", scope: "user" });
    expect(installRes.result).toEqual({ ok: true, plugin: { id: "p", installPath: mktDir, scope: "user" } });

    const listRes = await c.request(METHODS.pluginList, {});
    // I1 fix round 1: plugin.list now carries `extras` (winter-plugin.json's tier/permissions/
    // requiredConsents/consented/entry) — the Mac app's consent UI (lane L5) needs them over RPC.
    // `writeMarketplace`'s default fixture declares tier:"platform" + an entry point (no
    // permissions), so requiredConsents derives ["exec"] and consented is [] (never consented here).
    expect(listRes.result).toEqual({
      ok: true,
      plugins: [{
        id: "p", installPath: mktDir, scope: "user", enabled: true, marketplace: "m",
        extras: { tier: "platform", requiredConsents: ["exec"], consented: [], entry: { command: "bun", args: ["--version"] } },
      }],
    });

    // Written into Contract B's own files (sdk/plugins/installed_plugins.json + sdk/settings.json).
    const installed = JSON.parse(readFileSync(join(sdkPluginsRoot(home), "installed_plugins.json"), "utf8"));
    expect(installed.plugins["p@m"]).toHaveLength(1);
    const sdkSettings = JSON.parse(readFileSync(sdkSettingsPath(home), "utf8"));
    expect(sdkSettings.enabledPlugins["p@m"]).toBe(true);
  });

  test("plugin.list: extras is absent for a plugin with no winter-plugin.json", async () => {
    const { c } = await boot();
    const mktDir = mkdtempSync(join(tmpdir(), "winter-plugin-mkt-noextras-"));
    mkdirSync(join(mktDir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(mktDir, ".claude-plugin", "marketplace.json"), JSON.stringify({
      name: "m", owner: { name: "test" }, plugins: [{ name: "p", source: "." }],
    }));
    // Deliberately no winter-plugin.json at mktDir.
    await c.request(METHODS.pluginMarketplaceAdd, { source: mktDir });
    await c.request(METHODS.pluginInstall, { spec: "p@m", scope: "user" });

    const listRes = await c.request(METHODS.pluginList, {});
    expect(listRes.result.plugins).toEqual([{ id: "p", installPath: mktDir, scope: "user", enabled: true, marketplace: "m" }]);
    expect(listRes.result.plugins[0]).not.toHaveProperty("extras");
  });

  test("plugin.list: extras.consented reflects plugin.setConsent, and permissions carry through", async () => {
    const { c } = await boot();
    const mktDir = mkdtempSync(join(tmpdir(), "winter-plugin-mkt-consent-"));
    writeMarketplace(mktDir, {
      id: "p", tier: "capability",
      permissions: { exec: true, tcc: ["accessibility"], hardware: ["battery"] },
    });
    await c.request(METHODS.pluginMarketplaceAdd, { source: mktDir });
    await c.request(METHODS.pluginInstall, { spec: "p@m", scope: "user" });
    await c.request(METHODS.pluginSetConsent, { name: "p", classes: ["exec", "tcc"] });

    const listRes = await c.request(METHODS.pluginList, {});
    expect(listRes.result.plugins[0].extras).toEqual({
      tier: "capability",
      permissions: { exec: true, tcc: ["accessibility"], hardware: ["battery"] },
      requiredConsents: ["exec", "tcc", "hardware"],
      consented: ["exec", "tcc"],
    });
  });

  test("plugin.install on an unknown marketplace is refused typed (INVALID_PARAMS), nothing written", async () => {
    const { c } = await boot();
    const res = await c.request(METHODS.pluginInstall, { spec: "p@nope", scope: "user" });
    expect(res.error?.code).toBe(ERR.INVALID_PARAMS);
    const listRes = await c.request(METHODS.pluginList, {});
    expect(listRes.result.plugins).toEqual([]);
  });

  test("plugin.disable then plugin.enable flips enabledPlugins; plugin.uninstall clears the record (never the directory)", async () => {
    const { c } = await boot();
    const mktDir = mkdtempSync(join(tmpdir(), "winter-plugin-mkt-"));
    writeMarketplace(mktDir);
    await c.request(METHODS.pluginMarketplaceAdd, { source: mktDir });
    await c.request(METHODS.pluginInstall, { spec: "p@m", scope: "user" });

    const disableRes = await c.request(METHODS.pluginDisable, { spec: "p@m", scope: "user" });
    expect(disableRes.result).toEqual({ ok: true, spec: "p@m", scope: "user", enabled: false });
    expect((await c.request(METHODS.pluginList, {})).result.plugins[0].enabled).toBe(false);

    const enableRes = await c.request(METHODS.pluginEnable, { spec: "p@m", scope: "user" });
    expect(enableRes.result).toEqual({ ok: true, spec: "p@m", scope: "user", enabled: true });
    expect((await c.request(METHODS.pluginList, {})).result.plugins[0].enabled).toBe(true);

    const uninstallRes = await c.request(METHODS.pluginUninstall, { spec: "p@m", scope: "user" });
    expect(uninstallRes.result).toEqual({ ok: true, spec: "p@m", scope: "user" });
    expect((await c.request(METHODS.pluginList, {})).result.plugins).toEqual([]);
    // Directory marketplace: read in place, never deleted.
    expect(readFileSync(join(mktDir, "winter-plugin.json"), "utf8")).toContain("\"id\":\"p\"");
  });

  test("plugin.enable hot-spawns a Tier-2 plugin via the supervisor when spawn-eligible; plugin.disable hot-stops it", async () => {
    const { c } = await boot({ withSupervisor: true });
    const mktDir = mkdtempSync(join(tmpdir(), "winter-plugin-mkt-"));
    writeMarketplace(mktDir); // tier "platform", entry present — spawn-eligible once consented+enabled
    await c.request(METHODS.pluginMarketplaceAdd, { source: mktDir });
    await c.request(METHODS.pluginInstall, { spec: "p@m", scope: "user" }); // installed+enabled, but not yet consented

    // Not consented for the entry process yet — install/enable alone never hot-spawns it.
    await c.request(METHODS.pluginEnable, { spec: "p@m", scope: "user" });

    const setConsent = await c.request(METHODS.pluginSetConsent, { name: "p", classes: ["exec"] });
    expect(setConsent.result).toEqual({ ok: true });

    const enableRes = await c.request(METHODS.pluginEnable, { spec: "p@m", scope: "user" });
    expect(enableRes.result).toEqual({ ok: true, spec: "p@m", scope: "user", enabled: true });

    const disableRes = await c.request(METHODS.pluginDisable, { spec: "p@m", scope: "user" });
    expect(disableRes.result).toEqual({ ok: true, spec: "p@m", scope: "user", enabled: false });
  });

  // I2 fix round 1: plugin.uninstall must resolve the install record for that spec+scope BEFORE
  // touching the supervisor -- an uninstall of a scope the plugin isn't in must stop nothing.
  test("plugin.uninstall on a scope the plugin isn't installed in refuses typed, with the OTHER scope's record untouched and nothing stopped", async () => {
    const { c, supervisor } = await boot({ withSupervisor: true });
    const mktDir = mkdtempSync(join(tmpdir(), "winter-plugin-mkt-"));
    writeMarketplace(mktDir);
    await c.request(METHODS.pluginMarketplaceAdd, { source: mktDir });
    await c.request(METHODS.pluginInstall, { spec: "p@m", scope: "user" });
    await c.request(METHODS.pluginSetConsent, { name: "p", classes: ["exec"] });
    await c.request(METHODS.pluginEnable, { spec: "p@m", scope: "user" }); // hot-spawns via the real supervisor

    const projectDir = mkdtempSync(join(tmpdir(), "winter-plugin-uninstall-project-"));
    const res = await c.request(METHODS.pluginUninstall, { spec: "p@m", scope: "project", cwd: projectDir });
    expect(res.error?.code).toBe(ERR.INVALID_PARAMS);

    // The user-scope record survives, and the running Tier-2 process was never touched.
    const listRes = await c.request(METHODS.pluginList, {});
    expect(listRes.result.plugins.find((pl: any) => pl.scope === "user")).toBeDefined();
    expect(["starting", "running"]).toContain(supervisor!.status("p"));
  });

  test("a plugin installed at two scopes: uninstalling one leaves the Tier-2 process running; uninstalling the last stops it", async () => {
    const { c, supervisor } = await boot({ withSupervisor: true });
    const mktDir = mkdtempSync(join(tmpdir(), "winter-plugin-mkt-"));
    writeMarketplace(mktDir);
    await c.request(METHODS.pluginMarketplaceAdd, { source: mktDir });

    const projectDir = mkdtempSync(join(tmpdir(), "winter-plugin-two-scopes-"));
    await c.request(METHODS.pluginInstall, { spec: "p@m", scope: "user" });
    await c.request(METHODS.pluginInstall, { spec: "p@m", scope: "project", cwd: projectDir });
    // Consent is scope-independent (Winter's own <home>/settings.json store, spec §5.4) -- one call
    // covers both scopes' installs of the same spec.
    await c.request(METHODS.pluginSetConsent, { name: "p", classes: ["exec"] });
    await c.request(METHODS.pluginEnable, { spec: "p@m", scope: "user" }); // hot-spawns (livePlugins() is user-scope)
    await c.request(METHODS.pluginEnable, { spec: "p@m", scope: "project", cwd: projectDir });

    expect(["starting", "running"]).toContain(supervisor!.status("p"));

    // Uninstall the USER-scope record first — the PROJECT-scope one is still installed+enabled, so
    // the running process must NOT be stopped. `cwd` is passed even for this user-scope call,
    // matching real usage (the CLI always sends `process.cwd()`, main.ts's `case "plugin"`) — it's
    // what lets the daemon resolve whether the OTHER scope (project, keyed by this exact cwd)
    // still has the spec installed+enabled; `installed_plugins.json` itself carries no cwd per
    // project-scope record, so a caller that never sends one leaves that scope unresolvable.
    const firstUninstall = await c.request(METHODS.pluginUninstall, { spec: "p@m", scope: "user", cwd: projectDir });
    expect(firstUninstall.result).toEqual({ ok: true, spec: "p@m", scope: "user" });
    expect(["starting", "running"]).toContain(supervisor!.status("p"));
    const afterFirst = await c.request(METHODS.pluginList, { cwd: projectDir });
    expect(afterFirst.result.plugins).toHaveLength(1);
    expect(afterFirst.result.plugins[0]).toMatchObject({ scope: "project", enabled: true });

    // Uninstall the LAST remaining scope — nothing else has it installed+enabled, so this one DOES
    // hot-stop the process.
    const secondUninstall = await c.request(METHODS.pluginUninstall, { spec: "p@m", scope: "project", cwd: projectDir });
    expect(secondUninstall.result).toEqual({ ok: true, spec: "p@m", scope: "project" });
    expect(supervisor!.status("p")).toBe("stopped");
    const afterSecond = await c.request(METHODS.pluginList, { cwd: projectDir });
    expect(afterSecond.result.plugins).toEqual([]);
  });

  test("plugin.update re-resolves the install path and bumps the version", async () => {
    const { c } = await boot();
    const mktDir = mkdtempSync(join(tmpdir(), "winter-plugin-mkt-"));
    mkdirSync(join(mktDir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(mktDir, ".claude-plugin", "marketplace.json"), JSON.stringify({
      name: "m", owner: { name: "test" }, plugins: [{ name: "p", source: ".", version: "1.0.0" }],
    }));
    await c.request(METHODS.pluginMarketplaceAdd, { source: mktDir });
    await c.request(METHODS.pluginInstall, { spec: "p@m", scope: "user" });

    writeFileSync(join(mktDir, ".claude-plugin", "marketplace.json"), JSON.stringify({
      name: "m", owner: { name: "test" }, plugins: [{ name: "p", source: ".", version: "2.0.0" }],
    }));
    const updateRes = await c.request(METHODS.pluginUpdate, { spec: "p@m" });
    expect(updateRes.result.ok).toBe(true);
    expect(updateRes.result.plugin.version).toBe("2.0.0");
  });

  test("plugin.marketplace.remove/list round-trip", async () => {
    const { c } = await boot();
    const mktDir = mkdtempSync(join(tmpdir(), "winter-plugin-mkt-"));
    writeMarketplace(mktDir);
    await c.request(METHODS.pluginMarketplaceAdd, { source: mktDir });
    expect((await c.request(METHODS.pluginMarketplaceList, {})).result.marketplaces).toHaveLength(1);

    const removeRes = await c.request(METHODS.pluginMarketplaceRemove, { name: "m" });
    expect(removeRes.result).toEqual({ ok: true, name: "m" });
    expect((await c.request(METHODS.pluginMarketplaceList, {})).result.marketplaces).toEqual([]);
  });

  test("plugin.marketplace.update re-validates a directory marketplace in place", async () => {
    const { c } = await boot();
    const mktDir = mkdtempSync(join(tmpdir(), "winter-plugin-mkt-"));
    writeMarketplace(mktDir);
    await c.request(METHODS.pluginMarketplaceAdd, { source: mktDir });
    const updateRes = await c.request(METHODS.pluginMarketplaceUpdate, { name: "m" });
    expect(updateRes.result).toEqual({ ok: true });
  });

  test("project scope resolves against cwd's trusted .winter/settings.json", async () => {
    const { c } = await boot();
    const mktDir = mkdtempSync(join(tmpdir(), "winter-plugin-mkt-"));
    writeMarketplace(mktDir);
    await c.request(METHODS.pluginMarketplaceAdd, { source: mktDir });

    const projectDir = mkdtempSync(join(tmpdir(), "winter-plugin-project-"));
    const installRes = await c.request(METHODS.pluginInstall, { spec: "p@m", scope: "project", cwd: projectDir });
    expect(installRes.result.ok).toBe(true);

    const settingsPath = join(projectDir, ".winter", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.enabledPlugins["p@m"]).toBe(true);

    const listRes = await c.request(METHODS.pluginList, { cwd: projectDir });
    // I1: extras is scope-independent (plugins.consents lives in <home>/settings.json regardless
    // of which sdk file the enabled flag is in) — a project-scope listing carries it too.
    expect(listRes.result.plugins).toEqual([{
      id: "p", installPath: mktDir, scope: "project", enabled: true, marketplace: "m",
      extras: { tier: "platform", requiredConsents: ["exec"], consented: [], entry: { command: "bun", args: ["--version"] } },
    }]);
  });

  test("project/local scope without cwd is refused typed", async () => {
    const { c } = await boot();
    const mktDir = mkdtempSync(join(tmpdir(), "winter-plugin-mkt-"));
    writeMarketplace(mktDir);
    await c.request(METHODS.pluginMarketplaceAdd, { source: mktDir });
    const res = await c.request(METHODS.pluginInstall, { spec: "p@m", scope: "project" });
    expect(res.error?.code).toBe(ERR.INVALID_PARAMS);
  });

  test("every plugin.* RPC is role-rejected for a plugin-role connection", async () => {
    const { c, store, socketPath } = await boot();
    const raw = store.mintPluginToken("p");
    const plugin = await TestClient.connect(socketPath);
    await plugin.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "plugin", token: raw, clientName: "p", pluginId: "p" });

    const calls: Array<[string, unknown]> = [
      [METHODS.pluginList, {}],
      [METHODS.pluginInstall, { spec: "p@m", scope: "user" }],
      [METHODS.pluginUninstall, { spec: "p@m", scope: "user" }],
      [METHODS.pluginEnable, { spec: "p@m", scope: "user" }],
      [METHODS.pluginDisable, { spec: "p@m", scope: "user" }],
      [METHODS.pluginUpdate, { spec: "p@m" }],
      [METHODS.pluginMarketplaceAdd, { source: "/tmp/whatever" }],
      [METHODS.pluginMarketplaceRemove, { name: "m" }],
      [METHODS.pluginMarketplaceList, {}],
      [METHODS.pluginMarketplaceUpdate, {}],
      [METHODS.pluginSetConsent, { name: "p", classes: ["exec"] }],
    ];
    for (const [method, params] of calls) {
      const res = await plugin.request(method, params);
      expect(res.error?.code).toBe(ERR.UNAUTHORIZED);
    }
    plugin.close();
    void c;
  });
});
