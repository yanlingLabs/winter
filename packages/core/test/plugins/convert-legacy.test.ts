// WS-21 lane L4, Task L4.1: `convertLegacyPlugins(home)` — copies (never moves) every legacy
// `<home>/plugins/<id>` into a claude-shaped install under one "winter-legacy" directory
// marketplace, mapping fields and hook events (spec §8 step 6). Migration C (L3-owned) calls this
// as its own step 6; this file tests the function directly.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertLegacyPlugins } from "../../src/plugins/convert-legacy";
import { listPlugins } from "../../src/plugins/sdk-plugin-api";
import { sdkHomeFor, sdkPluginsRoot } from "../../src/agent/paths";
import { PluginStore } from "../../src/agent/plugins";

function home(): string {
  return mkdtempSync(join(tmpdir(), "winter-convert-legacy-"));
}

function legacyPlugin(h: string, id: string, manifest: unknown): string {
  const dir = join(h, "plugins", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "winter-plugin.json"), JSON.stringify(manifest));
  return dir;
}

describe("convertLegacyPlugins: no legacy plugins", () => {
  test("a home with no <home>/plugins directory converts nothing", async () => {
    const h = home();
    const result = await convertLegacyPlugins(h);
    expect(result).toEqual({ converted: [], skipped: [] });
  });
});

describe("convertLegacyPlugins: maps fields and hook events; the original stays in place", () => {
  test("mcpServers, hooks, tier/permissions/entry all convert; the legacy dir is untouched (copy, never move)", async () => {
    const h = home();
    const legacyDir = legacyPlugin(h, "demo", {
      id: "demo", name: "Demo", description: "a demo plugin", version: "1.2.3", author: "t",
      tier: "platform",
      permissions: { exec: true, tcc: ["accessibility"], hardware: ["battery"] },
      contributes: {
        skills: true,
        mcpServers: [{ name: "srv", command: "true", args: ["--flag"], env: { X: "1" } }],
        agents: true,
        hooks: [{ event: "session-start", command: "echo hi", timeoutMs: 5000 }, { event: "pre-tool", command: "echo pre" }],
        tools: true, tile: true,
      },
      entry: { command: "bun", args: ["index.ts"] },
    });
    // Legacy skills/ dir, already claude-shaped — must come along in the copy untouched.
    mkdirSync(join(legacyDir, "skills", "greet"), { recursive: true });
    writeFileSync(join(legacyDir, "skills", "greet", "SKILL.md"), "---\nname: greet\ndescription: hi\n---\nbody");
    writeFileSync(join(h, "settings.json"), JSON.stringify({
      schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" },
      plugins: { enabled: ["demo"], disabled: [], consents: { demo: { exec: 111, tcc: 222, hardware: 333 } } },
    }));

    const result = await convertLegacyPlugins(h);

    expect(result.skipped).toEqual([]);
    expect(result.converted).toHaveLength(1);
    expect(result.converted[0]?.id).toBe("demo");
    expect(result.converted[0]?.enabled).toBe(true);

    const targetDir = result.converted[0]!.installPath;
    // Skills carried over verbatim.
    expect(readFileSync(join(targetDir, "skills", "greet", "SKILL.md"), "utf8")).toContain("name: greet");
    // .claude-plugin/plugin.json written from the legacy manifest's own metadata.
    const claudeManifest = JSON.parse(readFileSync(join(targetDir, ".claude-plugin", "plugin.json"), "utf8"));
    expect(claudeManifest).toEqual({ name: "Demo", description: "a demo plugin", version: "1.2.3", author: "t" });
    // .mcp.json built from contributes.mcpServers.
    const mcp = JSON.parse(readFileSync(join(targetDir, ".mcp.json"), "utf8"));
    expect(mcp).toEqual({ mcpServers: { srv: { command: "true", args: ["--flag"], env: { X: "1" } } } });
    // hooks/hooks.json: events renamed, timeoutMs -> timeout in SECONDS.
    const hooks = JSON.parse(readFileSync(join(targetDir, "hooks", "hooks.json"), "utf8"));
    expect(hooks).toEqual({
      SessionStart: [{ hooks: [{ type: "command", command: "echo hi", timeout: 5 }] }],
      PreToolUse: [{ hooks: [{ type: "command", command: "echo pre" }] }],
    });
    // The narrowed winter-plugin.json keeps only tier/permissions/contributes.{tools,tile}/entry.
    const narrowed = JSON.parse(readFileSync(join(targetDir, "winter-plugin.json"), "utf8"));
    expect(narrowed).toEqual({
      id: "demo", tier: "platform",
      permissions: { exec: true, tcc: ["accessibility"], hardware: ["battery"] },
      contributes: { tools: true, tile: true },
      entry: { command: "bun", args: ["index.ts"] },
    });

    // THE ORIGINAL STAYS IN PLACE — copy, never move.
    expect(existsSync(join(legacyDir, "winter-plugin.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(legacyDir, "winter-plugin.json"), "utf8")).contributes.mcpServers).toBeDefined();
    expect(existsSync(join(legacyDir, "skills", "greet", "SKILL.md"))).toBe(true);

    // Registered through Contract B: listed, enabled, at the "winter-legacy" marketplace.
    const options = { pluginsRoot: sdkPluginsRoot(h), settingsPathFor: () => join(sdkHomeFor(h), "settings.json") };
    const listing = await listPlugins(options);
    expect(listing).toEqual([{ id: "demo", installPath: targetDir, scope: "user", enabled: true, marketplace: "winter-legacy" }]);

    // Consent record re-keyed to the qualified spec, same file, same field.
    const settings = JSON.parse(readFileSync(join(h, "settings.json"), "utf8"));
    expect(settings.plugins.consents).toEqual({ "demo@winter-legacy": { exec: 111, tcc: 222, hardware: 333 } });

    // PluginStore (the daemon's own sync reader) sees the converted, enabled plugin with its extras.
    const store = new PluginStore({ winterHome: h, consents: settings.plugins.consents });
    const [info] = store.list();
    expect(info?.name).toBe("demo");
    expect(info?.tier).toBe("platform");
    expect(info?.disabled).toBe(false);
    expect(info?.consented).toEqual(["exec", "tcc", "hardware"]);
  });

  test("a plugin NOT in the legacy enabled list converts but stays disabled", async () => {
    const h = home();
    legacyPlugin(h, "off", { id: "off", tier: "capability", contributes: { tools: true } });
    writeFileSync(join(h, "settings.json"), JSON.stringify({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, plugins: {} }));

    const result = await convertLegacyPlugins(h);
    expect(result.converted[0]?.enabled).toBe(false);

    const options = { pluginsRoot: sdkPluginsRoot(h), settingsPathFor: () => join(sdkHomeFor(h), "settings.json") };
    const [listing] = await listPlugins(options);
    expect(listing?.enabled).toBe(false);
  });

  test("a legacy plugin.json-only (no winter-plugin.json) plugin converts with metadata only", async () => {
    const h = home();
    const dir = join(h, "plugins", "legacy-meta");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name: "Legacy Meta", version: "0.0.1" }));
    writeFileSync(join(h, "settings.json"), JSON.stringify({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, plugins: { enabled: ["legacy-meta"] } }));

    const result = await convertLegacyPlugins(h);
    expect(result.converted).toHaveLength(1);
    const targetDir = result.converted[0]!.installPath;
    expect(existsSync(join(targetDir, "winter-plugin.json"))).toBe(false); // no extras to narrow
    const claudeManifest = JSON.parse(readFileSync(join(targetDir, ".claude-plugin", "plugin.json"), "utf8"));
    expect(claudeManifest).toEqual({ name: "Legacy Meta", version: "0.0.1" });
  });
});
