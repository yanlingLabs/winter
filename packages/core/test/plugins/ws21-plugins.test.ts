// WS-21 lane L4, Task L4.1: the plugin surface rewritten over Contract B (spec §5).
//
// Three layers, one file:
//  - the adapter (`plugins/sdk-plugin-api.ts`) mirrors L1b's `manage.ts` write discipline (F15) —
//    install from a directory marketplace, enable/disable writes `enabledPlugins`, list shows the
//    installed set;
//  - the narrowed manifest (`agent/plugin-manifest.ts`) parses winter-plugin.json's EXTRAS ONLY
//    (tier, permissions, contributes.{tools,shortcuts,tile,provider}, entry) and warns once, never
//    throws, when a manifest still carries the OLD SDK-level keys (skills, mcpServers, agents, hooks)
//    that now live in claude's own plugin layout;
//  - `agent/plugins.ts`'s `PluginStore` (the daemon's synchronous read of the installed+enabled set,
//    kept sync because `daemon.ts`/`ipc/server.ts` call `.list()` synchronously — see this file's own
//    header comment) reports each installed, enabled plugin's extras.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addMarketplace,
  installPlugin,
  listMarketplaces,
  listPlugins,
  PluginManagerError,
  setPluginEnabled,
  uninstallPlugin,
  type PluginManagerOptions,
} from "../../src/plugins/sdk-plugin-api";
import { installPluginFromDirectory } from "../../src/plugins/lifecycle";
import { loadManifest } from "../../src/agent/plugin-manifest";
import { PluginStore } from "../../src/agent/plugins";

let home: string;
let pluginsRoot: string;
let userSettingsPath: string;
let marketplaceDir: string;
let options: PluginManagerOptions;

function writeMarketplace(dir: string, plugins: Array<{ name: string; source: string; version?: string }>): void {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "m", owner: { name: "test" }, plugins }));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "winter-ws21-plugins-"));
  pluginsRoot = join(home, "sdk", "plugins");
  userSettingsPath = join(home, "sdk", "settings.json");
  marketplaceDir = join(home, "local-marketplace");
  writeMarketplace(marketplaceDir, [{ name: "p", source: "./plugins/p", version: "1.0.0" }]);
  mkdirSync(join(marketplaceDir, "plugins", "p"), { recursive: true });
  options = { pluginsRoot, settingsPathFor: () => userSettingsPath };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("the adapter (Contract B mirror): install from a folder", () => {
  test("addMarketplace + installPlugin installs from a directory marketplace and enables it", async () => {
    const mkt = await addMarketplace(options, marketplaceDir);
    expect(mkt).toEqual({ name: "m", source: marketplaceDir, kind: "directory", path: marketplaceDir });

    const installed = await installPlugin(options, "p@m", "user");
    expect(installed).toEqual({ id: "p", version: "1.0.0", installPath: join(marketplaceDir, "plugins", "p"), scope: "user" });

    const listing = await listPlugins(options);
    expect(listing).toEqual([{ id: "p", version: "1.0.0", installPath: join(marketplaceDir, "plugins", "p"), scope: "user", enabled: true, marketplace: "m" }]);
  });

  test("enable writes enabledPlugins; disable flips it to false without touching the install record", async () => {
    await addMarketplace(options, marketplaceDir);
    await installPlugin(options, "p@m", "user");

    let settings = JSON.parse(readFileSync(userSettingsPath, "utf8")) as { enabledPlugins?: Record<string, boolean> };
    expect(settings.enabledPlugins?.["p@m"]).toBe(true);

    await setPluginEnabled(options, "p@m", "user", false);
    settings = JSON.parse(readFileSync(userSettingsPath, "utf8")) as { enabledPlugins?: Record<string, boolean> };
    expect(settings.enabledPlugins?.["p@m"]).toBe(false);

    const [listing] = await listPlugins(options);
    expect(listing?.enabled).toBe(false);
    expect(listing?.installPath).toBe(join(marketplaceDir, "plugins", "p"));
  });

  test("uninstallPlugin removes the record and clears enabledPlugins", async () => {
    await addMarketplace(options, marketplaceDir);
    await installPlugin(options, "p@m", "user");
    await uninstallPlugin(options, "p@m", "user");
    expect(await listPlugins(options)).toEqual([]);
    await expect(uninstallPlugin(options, "p@m", "user")).rejects.toThrow(PluginManagerError);
  });

  test("listMarketplaces reports the added directory marketplace", async () => {
    await addMarketplace(options, marketplaceDir);
    expect(await listMarketplaces(options)).toEqual([{ name: "m", source: marketplaceDir, kind: "directory", path: marketplaceDir }]);
  });
});

describe("installPluginFromDirectory: 'install means addMarketplace + installPlugin'", () => {
  test("a one-plugin folder installs directly, no separate marketplace-add step", async () => {
    const installed = await installPluginFromDirectory(options, marketplaceDir, "user");
    expect(installed).toEqual({ id: "p", version: "1.0.0", installPath: join(marketplaceDir, "plugins", "p"), scope: "user" });
    const [listing] = await listPlugins(options);
    expect(listing?.enabled).toBe(true);
  });

  test("a multi-plugin folder is refused typed, naming the marketplace to qualify against", async () => {
    writeMarketplace(marketplaceDir, [{ name: "p", source: "./plugins/p", version: "1.0.0" }, { name: "q", source: "./plugins/q", version: "1.0.0" }]);
    await expect(installPluginFromDirectory(options, marketplaceDir, "user")).rejects.toThrow(PluginManagerError);
    // Refused BEFORE anything is installed.
    expect(await listPlugins(options)).toEqual([]);
  });
});

describe("the narrowed manifest: extras only, old SDK-level keys ignored with one warning", () => {
  test("a manifest with only extras parses with no warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-plugin-manifest-"));
    writeFileSync(join(dir, "winter-plugin.json"), JSON.stringify({
      id: "p", tier: "platform", permissions: { exec: true },
      contributes: { tools: true, tile: true }, entry: { command: "bun", args: ["index.ts"] },
    }));
    const warnings: string[] = [];
    const { manifest, legacy } = loadManifest(dir, "p", (m) => warnings.push(m));
    expect(legacy).toBe(false);
    expect(manifest?.tier).toBe("platform");
    expect(manifest?.entry).toEqual({ command: "bun", args: ["index.ts"] });
    expect(warnings).toEqual([]);
  });

  test("a manifest carrying old SDK-level keys (skills, mcpServers, agents, hooks) still parses its extras, with exactly one warning naming the ignored keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-plugin-manifest-"));
    writeFileSync(join(dir, "winter-plugin.json"), JSON.stringify({
      id: "p", tier: "capability",
      contributes: {
        tools: true,
        skills: true,
        mcpServers: [{ name: "x", command: "true" }],
        agents: true,
        hooks: [{ event: "session-start", command: "true" }],
      },
    }));
    const warnings: string[] = [];
    const { manifest, legacy } = loadManifest(dir, "p", (m) => warnings.push(m));
    expect(legacy).toBe(false);
    expect(manifest?.tier).toBe("capability");
    // The extras still parsed: `tools` survives, the old keys do not appear on the parsed manifest.
    expect(manifest?.contributes?.tools).toBe(true);
    expect((manifest?.contributes as Record<string, unknown> | undefined)?.["skills"]).toBeUndefined();
    expect((manifest?.contributes as Record<string, unknown> | undefined)?.["mcpServers"]).toBeUndefined();
    expect((manifest?.contributes as Record<string, unknown> | undefined)?.["hooks"]).toBeUndefined();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("skills");
    expect(warnings[0]).toContain("mcpServers");
    expect(warnings[0]).toContain("agents");
    expect(warnings[0]).toContain("hooks");
  });
});

describe("PluginStore (sync): list shows extras for an installed, enabled plugin", () => {
  test("list() reports the extras winter-plugin.json declares", async () => {
    writeFileSync(join(marketplaceDir, "plugins", "p", "winter-plugin.json"), JSON.stringify({
      id: "p", tier: "platform", permissions: { exec: true, hardware: ["battery"] },
      contributes: { tools: true, tile: true }, entry: { command: "bun", args: ["index.ts"] },
    }));
    await addMarketplace(options, marketplaceDir);
    await installPlugin(options, "p@m", "user");

    const store = new PluginStore({ winterHome: home });
    const [info] = store.list();
    expect(info?.name).toBe("p");
    expect(info?.tier).toBe("platform");
    expect(info?.entry).toEqual({ command: "bun", args: ["index.ts"] });
    expect(info?.disabled).toBe(false);
    expect(info?.mcpEnabled).toBe(true); // explicitly enabled (see agent/plugins.ts's own doc)
  });

  test("a disabled plugin reports disabled:true", async () => {
    await addMarketplace(options, marketplaceDir);
    await installPlugin(options, "p@m", "user");
    await setPluginEnabled(options, "p@m", "user", false);

    const store = new PluginStore({ winterHome: home });
    const [info] = store.list();
    expect(info?.disabled).toBe(true);
    expect(info?.mcpEnabled).toBe(false);
  });
});
