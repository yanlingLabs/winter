// WS-21 lane L4.4 (spec §5.5: "Converted: both examples"): `examples/battery-limiter` and
// `examples/sample-echo` are claude plugins (a `.claude-plugin/plugin.json` each) plus their own
// `winter-plugin.json` extras (tier/permissions/contributes/entry — already the narrowed,
// extras-only shape, spec §5.1), listed by one directory marketplace at `examples/` itself
// (`.claude-plugin/marketplace.json`). This proves both install through it, over Contract B, and
// that `listPlugins` surfaces each one's extras via `agent/plugin-manifest.ts#loadManifest`.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addMarketplace, installPlugin, listPlugins, type PluginManagerOptions } from "../../src/plugins/plugin-manager";
import { loadManifest } from "../../src/agent/plugin-manifest";

const EXAMPLES_DIR = join(import.meta.dir, "../../../..", "examples");

function options(): PluginManagerOptions {
  const home = mkdtempSync(join(tmpdir(), "winter-examples-mkt-"));
  return { pluginsRoot: join(home, "sdk", "plugins"), settingsPathFor: () => join(home, "sdk", "settings.json") };
}

describe("examples/ as one directory marketplace", () => {
  test("addMarketplace reads examples/.claude-plugin/marketplace.json, listing both plugins", async () => {
    const o = options();
    const marketplace = await addMarketplace(o, EXAMPLES_DIR);
    expect(marketplace).toEqual({ name: "winter-examples", source: EXAMPLES_DIR, kind: "directory", path: EXAMPLES_DIR });
  });

  test("battery-limiter installs through it, and list shows its winter-plugin.json extras", async () => {
    const o = options();
    await addMarketplace(o, EXAMPLES_DIR);
    const installed = await installPlugin(o, "battery-limiter@winter-examples", "user");
    expect(installed).toEqual({ id: "battery-limiter", version: "0.0.1", installPath: join(EXAMPLES_DIR, "battery-limiter"), scope: "user" });

    const [listing] = await listPlugins(o);
    expect(listing).toEqual({ id: "battery-limiter", version: "0.0.1", installPath: join(EXAMPLES_DIR, "battery-limiter"), scope: "user", enabled: true, marketplace: "winter-examples" });

    const { manifest, legacy } = loadManifest(installed.installPath, "battery-limiter");
    expect(legacy).toBe(false);
    expect(manifest?.tier).toBe("platform");
    expect(manifest?.permissions).toEqual({ exec: true, hardware: ["battery"] });
    expect(manifest?.contributes).toEqual({ tools: true, tile: true });
    expect(manifest?.entry).toEqual({ command: "bun", args: ["index.ts"] });
  });

  test("sample-echo installs through it, and list shows its winter-plugin.json extras", async () => {
    const o = options();
    await addMarketplace(o, EXAMPLES_DIR);
    const installed = await installPlugin(o, "sample-echo@winter-examples", "user");
    expect(installed).toEqual({ id: "sample-echo", version: "0.0.1", installPath: join(EXAMPLES_DIR, "sample-echo"), scope: "user" });

    const [listing] = await listPlugins(o);
    expect(listing).toEqual({ id: "sample-echo", version: "0.0.1", installPath: join(EXAMPLES_DIR, "sample-echo"), scope: "user", enabled: true, marketplace: "winter-examples" });

    const { manifest, legacy } = loadManifest(installed.installPath, "sample-echo");
    expect(legacy).toBe(false);
    expect(manifest?.tier).toBe("platform");
    expect(manifest?.contributes).toEqual({ tools: true, tile: true, shortcuts: [{ id: "bump", description: "Bump the echo counter" }] });
    expect(manifest?.entry).toEqual({ command: "bun", args: ["index.ts"] });
  });

  test("both install together with no name clash", async () => {
    const o = options();
    await addMarketplace(o, EXAMPLES_DIR);
    await installPlugin(o, "battery-limiter@winter-examples", "user");
    await installPlugin(o, "sample-echo@winter-examples", "user");
    const listing = await listPlugins(o);
    expect(listing.map((p) => p.id).sort()).toEqual(["battery-limiter", "sample-echo"]);
  });
});
