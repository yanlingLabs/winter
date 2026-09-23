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
import { pluginConsentFingerprint } from "../../src/plugins/consent-fingerprint";
import { pluginHooksFor } from "../../src/plugins/plugin-hooks";

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
    // hooks/hooks.json: events renamed, timeoutMs -> timeout in SECONDS, WRAPPED in claude's own
    // top-level "hooks" key (post-merge round fix — plugin-hooks.ts's own reader expects
    // {hooks: {<Event>: [...]}}, not the bare event map; the converter was writing the bare shape).
    const hooks = JSON.parse(readFileSync(join(targetDir, "hooks", "hooks.json"), "utf8"));
    expect(hooks).toEqual({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "echo hi", timeout: 5 }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: "echo pre" }] }],
      },
    });
    // Round-trip: the daemon's own reader (plugin.list's `hooks` field) actually sees these —
    // proving the shapes agree end to end, not just that the file LOOKS right on disk.
    expect(pluginHooksFor(targetDir)).toEqual([
      { event: "SessionStart", type: "command", command: "echo hi" },
      { event: "PreToolUse", type: "command", command: "echo pre" },
    ]);
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

    // Post-merge round ("keep writing known_marketplaces.json"): the conversion registers the
    // "winter-legacy" marketplace through addMarketplace's own locked writer (sdk-plugin-api.ts),
    // never a hand-rolled write that could drift from what `plugin.marketplace.list` reads.
    const knownMarketplaces = JSON.parse(readFileSync(join(sdkPluginsRoot(h), "known_marketplaces.json"), "utf8"));
    expect(knownMarketplaces["winter-legacy"]).toMatchObject({
      source: { source: "directory", path: join(sdkPluginsRoot(h), "marketplaces", "winter-legacy") },
      installLocation: join(sdkPluginsRoot(h), "marketplaces", "winter-legacy"),
    });

    // Consent record re-keyed to the qualified spec, same file, same field — I3 fix round 1: `exec`
    // is DROPPED (pre-WS-21 it was granted because the plugin shipped skills, which enabling a
    // plugin now covers, spec §5.4); `tcc`/`hardware` carry forward unchanged. C1 fix round 2: the
    // carried-forward record is now FINGERPRINTED (`{classes, fingerprint}`), computed off the
    // converted install path + the SAME entry the narrowed winter-plugin.json ended up with — so it
    // reads as consented from the start, never forcing a needless re-consent right after migration.
    const settings = JSON.parse(readFileSync(join(h, "settings.json"), "utf8"));
    const demoFingerprint = pluginConsentFingerprint(targetDir, {
      entry: { command: "bun", args: ["index.ts"] },
      tcc: ["accessibility"], hardware: ["battery"], requiredConsents: ["exec", "tcc", "hardware"],
    });
    expect(settings.plugins.consents).toEqual({ "demo@winter-legacy": { classes: ["tcc", "hardware"], fingerprint: demoFingerprint } });

    // PluginStore (the daemon's own sync reader) sees the converted, enabled plugin with its
    // extras — `consented` no longer includes "exec", so the entry process prompts fresh.
    const store = new PluginStore({ winterHome: h, consents: settings.plugins.consents });
    const [info] = store.list();
    expect(info?.name).toBe("demo");
    expect(info?.tier).toBe("platform");
    expect(info?.disabled).toBe(false);
    expect(info?.consented).toEqual(["tcc", "hardware"]);
  });

  // I3 fix round 1 (ruling): the legacy `exec` consent is DROPPED during conversion, never
  // re-keyed — before WS-21 it was granted because a plugin shipped skills, and enabling a plugin
  // now covers that (spec §5.4, native content needs no separate Winter consent). `tcc`/`hardware`
  // carry forward untouched.
  test("a converted legacy plugin with exec consent has NONE after conversion, and keeps its tcc/hardware consents", async () => {
    const h = home();
    legacyPlugin(h, "solo", { id: "solo", tier: "platform", entry: { command: "bun" }, permissions: { exec: true, tcc: ["accessibility"], hardware: ["battery"] } });
    writeFileSync(join(h, "settings.json"), JSON.stringify({
      schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" },
      plugins: { enabled: ["solo"], consents: { solo: { exec: 999, tcc: 111, hardware: 222 } } },
    }));

    const result = await convertLegacyPlugins(h);
    const targetDir = result.converted[0]!.installPath;

    const settings = JSON.parse(readFileSync(join(h, "settings.json"), "utf8"));
    const soloFingerprint = pluginConsentFingerprint(targetDir, {
      entry: { command: "bun" },
      tcc: ["accessibility"], hardware: ["battery"], requiredConsents: ["exec", "tcc", "hardware"],
    });
    expect(settings.plugins.consents).toEqual({ "solo@winter-legacy": { classes: ["tcc", "hardware"], fingerprint: soloFingerprint } });
    expect(settings.plugins.consents["solo@winter-legacy"].classes).not.toContain("exec");
  });

  // I3 / M5: a consent record with ONLY `exec` (no tcc/hardware) converts to an EMPTY classes array,
  // never dropped from the map entirely (a present-but-empty record is still "no exec consent on
  // file", distinct from "never consented at all" — PluginStore#consentedClasses reads either the
  // same way, but keeping the key means a future re-grant of tcc/hardware finds a record to merge
  // onto). C1 fix round 2: still carries a fingerprint even with `classes: []`.
  test("a consent record with only exec becomes an empty classes array for the qualified spec", async () => {
    const h = home();
    legacyPlugin(h, "onlyexec", { id: "onlyexec", tier: "platform", entry: { command: "bun" }, permissions: { exec: true } });
    writeFileSync(join(h, "settings.json"), JSON.stringify({
      schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" },
      plugins: { enabled: ["onlyexec"], consents: { onlyexec: { exec: 1 } } },
    }));

    const result = await convertLegacyPlugins(h);
    const targetDir = result.converted[0]!.installPath;

    const settings = JSON.parse(readFileSync(join(h, "settings.json"), "utf8"));
    const onlyExecFingerprint = pluginConsentFingerprint(targetDir, { entry: { command: "bun" }, requiredConsents: ["exec"] });
    expect(settings.plugins.consents).toEqual({ "onlyexec@winter-legacy": { classes: [], fingerprint: onlyExecFingerprint } });
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

  // Post-merge fix round, finding 1 (Opus review): before WS-21, a manifest plugin's MCP servers,
  // hooks and skills only ran with its OWN exec consent -- the legacy enabled flag alone was never
  // enough. Converting an enabled-but-unconsented plugin straight to enabled would silently start
  // running commands the user never approved.
  describe("finding 1: enabled state requires the legacy consent to have covered everything required", () => {
    test("enabled in legacy settings but with NO consent record at all converts DISABLED", async () => {
      const h = home();
      legacyPlugin(h, "risky", {
        id: "risky", tier: "platform", entry: { command: "bun", args: ["index.ts"] },
      });
      writeFileSync(join(h, "settings.json"), JSON.stringify({
        schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" },
        plugins: { enabled: ["risky"] }, // enabled, but plugins.consents has no "risky" entry at all
      }));

      const result = await convertLegacyPlugins(h);
      expect(result.converted[0]?.enabled).toBe(false);

      const options = { pluginsRoot: sdkPluginsRoot(h), settingsPathFor: () => join(sdkHomeFor(h), "settings.json") };
      const [listing] = await listPlugins(options);
      expect(listing?.enabled).toBe(false);
    });

    test("enabled with a PARTIAL consent record (missing hardware) converts DISABLED", async () => {
      const h = home();
      legacyPlugin(h, "partial", {
        id: "partial", tier: "capability", permissions: { exec: true, hardware: ["battery"] },
      });
      writeFileSync(join(h, "settings.json"), JSON.stringify({
        schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" },
        plugins: { enabled: ["partial"], consents: { partial: { exec: 1 } } }, // hardware missing
      }));

      const result = await convertLegacyPlugins(h);
      expect(result.converted[0]?.enabled).toBe(false);
    });

    test("enabled with a FULLY consented record converts ENABLED", async () => {
      const h = home();
      legacyPlugin(h, "trusted", {
        id: "trusted", tier: "platform", entry: { command: "bun" }, permissions: { tcc: ["accessibility"] },
      });
      writeFileSync(join(h, "settings.json"), JSON.stringify({
        schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" },
        plugins: { enabled: ["trusted"], consents: { trusted: { exec: 1, tcc: 2 } } },
      }));

      const result = await convertLegacyPlugins(h);
      expect(result.converted[0]?.enabled).toBe(true);

      const options = { pluginsRoot: sdkPluginsRoot(h), settingsPathFor: () => join(sdkHomeFor(h), "settings.json") };
      const [listing] = await listPlugins(options);
      expect(listing?.enabled).toBe(true);
    });

    test("a plugin.json-only (no winter-plugin.json) legacy plugin never needed consent -- enabled state is untouched", async () => {
      const h = home();
      const dir = join(h, "plugins", "meta-only");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name: "Meta Only" }));
      writeFileSync(join(h, "settings.json"), JSON.stringify({
        schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, plugins: { enabled: ["meta-only"] },
      }));

      const result = await convertLegacyPlugins(h);
      expect(result.converted[0]?.enabled).toBe(true);
    });

    test("a manifest with nothing to consent to (no entry/permissions/mcpServers/hooks/skills) stays enabled", async () => {
      const h = home();
      legacyPlugin(h, "harmless", { id: "harmless", tier: "capability", contributes: { tools: true } });
      writeFileSync(join(h, "settings.json"), JSON.stringify({
        schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, plugins: { enabled: ["harmless"] },
      }));

      const result = await convertLegacyPlugins(h);
      expect(result.converted[0]?.enabled).toBe(true);
    });
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
