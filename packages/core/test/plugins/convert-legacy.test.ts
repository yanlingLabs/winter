// WS-21 lane L4, Task L4.1: `convertLegacyPlugins(home)` — copies (never moves) every legacy
// `<home>/plugins/<id>` into a claude-shaped install under one "winter-legacy" directory
// marketplace, mapping fields and hook events (spec §8 step 6). Migration C (L3-owned) calls this
// as its own step 6; this file tests the function directly.
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertLegacyPlugins } from "../../src/plugins/convert-legacy";
import { listPlugins, setPluginEnabled } from "../../src/plugins/plugin-manager";
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
    // "winter-legacy" marketplace through addMarketplace's own locked writer (the agent SDK's `manage.ts`),
    // never a hand-rolled write that could drift from what `plugin.marketplace.list` reads.
    const knownMarketplaces = JSON.parse(readFileSync(join(sdkPluginsRoot(h), "known_marketplaces.json"), "utf8"));
    expect(knownMarketplaces["winter-legacy"]).toMatchObject({
      source: { source: "directory", path: join(sdkPluginsRoot(h), "marketplaces", "winter-legacy") },
      installLocation: join(sdkPluginsRoot(h), "marketplaces", "winter-legacy"),
    });

    // Consent record ADDED at the qualified spec, same file, same field — finding 2 (post-merge fix
    // round, Opus review): the bare "demo" record stays EXACTLY as it was (byte-identical — a 0.116
    // downgrade after a rollback still reads it; Migration C's rollback never touches settings.json,
    // DECISION 15), the qualified "demo@winter-legacy" record is ADDED beside it, never replacing it.
    // I3 fix round 1: the QUALIFIED record's own `exec` is DROPPED (pre-WS-21 it was granted because
    // the plugin shipped skills, which enabling a plugin now covers, spec §5.4) — the BARE record's
    // `exec` is untouched, since the bare record isn't touched at all. C1 fix round 2: the added
    // record is FINGERPRINTED (`{classes, fingerprint}`), computed off the converted install path +
    // the SAME entry the narrowed winter-plugin.json ended up with — so it reads as consented from
    // the start, never forcing a needless re-consent right after migration.
    const settings = JSON.parse(readFileSync(join(h, "settings.json"), "utf8"));
    const demoFingerprint = pluginConsentFingerprint(targetDir, {
      entry: { command: "bun", args: ["index.ts"] },
      tcc: ["accessibility"], hardware: ["battery"], requiredConsents: ["exec", "tcc", "hardware"],
    });
    expect(settings.plugins.consents).toEqual({
      demo: { exec: 111, tcc: 222, hardware: 333 }, // byte-identical to the legacy record
      "demo@winter-legacy": { classes: ["tcc", "hardware"], fingerprint: demoFingerprint },
    });

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
    expect(settings.plugins.consents).toEqual({
      solo: { exec: 999, tcc: 111, hardware: 222 }, // finding 2: the bare record is untouched
      "solo@winter-legacy": { classes: ["tcc", "hardware"], fingerprint: soloFingerprint },
    });
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
    expect(settings.plugins.consents).toEqual({
      onlyexec: { exec: 1 }, // finding 2: the bare record is untouched
      "onlyexec@winter-legacy": { classes: [], fingerprint: onlyExecFingerprint },
    });
  });

  // Post-merge fix round, finding 2 (Opus review): rekeyConsents used to REPLACE the bare-id record
  // with its qualified rewrite -- after a rollback (which never touches settings.json, DECISION 15)
  // and a downgrade to 0.116, the plugin's own consent had silently vanished, since 0.116 only ever
  // read the bare key. This is the dedicated, minimal regression test for that ruling: additive,
  // never destructive.
  test("finding 2: rekeyConsents is additive -- the bare-id record survives byte-identical, the qualified record is added beside it", async () => {
    const h = home();
    legacyPlugin(h, "carry", { id: "carry", tier: "capability", permissions: { hardware: ["battery"] } });
    const legacyRecord = { hardware: 555 };
    writeFileSync(join(h, "settings.json"), JSON.stringify({
      schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" },
      plugins: { enabled: ["carry"], consents: { carry: legacyRecord } },
    }));

    await convertLegacyPlugins(h);

    const settings = JSON.parse(readFileSync(join(h, "settings.json"), "utf8"));
    // Byte-identical: the exact same value, not just a structurally-equal copy.
    expect(settings.plugins.consents.carry).toEqual(legacyRecord);
    // The qualified record is present too, both coexisting in the same file.
    expect(settings.plugins.consents["carry@winter-legacy"]).toBeDefined();
    expect(Object.keys(settings.plugins.consents).sort()).toEqual(["carry", "carry@winter-legacy"]);

    // A downgrade to 0.116 (reading only the bare key, the pre-WS-21 shape) still sees its consent.
    expect(settings.plugins.consents.carry.hardware).toBe(555);
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

// Post-merge fix round, finding 4 (Opus review, data safety): when `<home>/plugins/<id>` is a
// SYMLINK (a dev checkout linked in, for instance), the OLD converter copied the LINK itself
// (cpSync's own default, dereference:false) -- so every write convertOnePlugin makes (deleting the
// stale manifests, writing the narrowed ones) landed THROUGH it, modifying the user's own folder in
// place. Fixed: the top-level link is dereferenced before copying, a NESTED symlink pointing outside
// the resolved plugin folder refuses the whole plugin (never even attempting to write anything), and
// the copy itself is fully dereferenced so the converted output is plain files, never links.
describe("finding 4: a symlinked legacy plugin directory is dereferenced, never written through", () => {
  test("a top-level symlink to a real plugin folder converts successfully, and the REAL folder is byte-unchanged", async () => {
    const h = home();
    // The REAL plugin content lives OUTSIDE <home>/plugins entirely -- e.g. a dev checkout.
    const realDir = mkdtempSync(join(tmpdir(), "winter-convert-legacy-devcheckout-"));
    const manifestJson = JSON.stringify({ id: "linked", tier: "capability", permissions: { hardware: ["battery"] } });
    writeFileSync(join(realDir, "winter-plugin.json"), manifestJson);
    mkdirSync(join(realDir, "skills", "greet"), { recursive: true });
    writeFileSync(join(realDir, "skills", "greet", "SKILL.md"), "---\nname: greet\n---\nhi");

    mkdirSync(join(h, "plugins"), { recursive: true });
    symlinkSync(realDir, join(h, "plugins", "linked"));
    writeFileSync(join(h, "settings.json"), JSON.stringify({
      schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, plugins: { enabled: ["linked"] },
    }));

    const result = await convertLegacyPlugins(h);
    expect(result.skipped).toEqual([]);
    expect(result.converted).toHaveLength(1);
    const targetDir = result.converted[0]!.installPath;

    // The converted OUTPUT is a plain, symlink-free real directory with its own written manifests.
    expect(lstatSync(targetDir).isSymbolicLink()).toBe(false);
    expect(existsSync(join(targetDir, ".claude-plugin", "plugin.json"))).toBe(true);

    // <home>/plugins/linked is STILL a symlink -- copy, never move, never converted in place.
    expect(lstatSync(join(h, "plugins", "linked")).isSymbolicLink()).toBe(true);

    // The REAL folder the symlink points to is BYTE-UNCHANGED -- the converter never deleted its
    // original winter-plugin.json or wrote anything new into it.
    expect(readFileSync(join(realDir, "winter-plugin.json"), "utf8")).toBe(manifestJson);
    expect(existsSync(join(realDir, ".claude-plugin"))).toBe(false); // no claude-plugin dir was ever added here
    expect(existsSync(join(realDir, "skills", "greet", "SKILL.md"))).toBe(true); // untouched
  });

  test("a NESTED symlink escaping the plugin folder makes it unconvertible, with a clear reason, and the original is untouched", async () => {
    const h = home();
    const outsideDir = mkdtempSync(join(tmpdir(), "winter-convert-legacy-outside-"));
    writeFileSync(join(outsideDir, "secret.txt"), "do not touch");

    const legacyDir = legacyPlugin(h, "escapee", { id: "escapee", tier: "capability" });
    symlinkSync(outsideDir, join(legacyDir, "escape-hatch"));

    writeFileSync(join(h, "settings.json"), JSON.stringify({
      schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, plugins: { enabled: ["escapee"] },
    }));

    const result = await convertLegacyPlugins(h);
    expect(result.converted).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.id).toBe("escapee");
    expect(result.skipped[0]?.reason).toContain("nested symlink");
    expect(result.skipped[0]?.reason).toContain("outside");

    // The original legacy plugin folder (and the nested symlink itself) are completely untouched.
    expect(existsSync(join(legacyDir, "winter-plugin.json"))).toBe(true);
    expect(realpathSync(join(legacyDir, "escape-hatch"))).toBe(realpathSync(outsideDir));
    // Nothing was ever written into the outside folder the escaping symlink pointed to.
    expect(readFileSync(join(outsideDir, "secret.txt"), "utf8")).toBe("do not touch");
    expect(existsSync(join(sdkPluginsRoot(h), "marketplaces", "winter-legacy", "plugins", "escapee"))).toBe(false);
  });
});

// Post-merge fix round, minor 2 (promoted, Opus review): re-migrating after a rollback (which never
// undoes this lane's own SDK-side writes -- only `settings.json` is untouched, DECISION 15) must not
// blow away and rebuild an already-converted `winter-legacy` copy. A re-run SKIPS any id whose
// "<id>@winter-legacy" install record already exists AND whose install folder still exists on disk.
describe("minor 2: a re-run never overwrites an already-converted plugin", () => {
  test("re-running convertLegacyPlugins on an already-installed plugin skips it, and its converted folder is byte-unchanged", async () => {
    const h = home();
    legacyPlugin(h, "demo", { id: "demo", tier: "capability", contributes: { tools: true } });
    writeFileSync(join(h, "settings.json"), JSON.stringify({
      schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, plugins: { enabled: ["demo"] },
    }));

    const first = await convertLegacyPlugins(h);
    expect(first.converted).toHaveLength(1);
    const targetDir = first.converted[0]!.installPath;

    // Simulate something the user (or a later daemon run) changed in the converted copy since the
    // first run -- a re-run must never touch it.
    writeFileSync(join(targetDir, "marker.txt"), "left alone");

    const second = await convertLegacyPlugins(h);
    expect(second.converted).toEqual([]);
    expect(second.skipped).toHaveLength(1);
    expect(second.skipped[0]?.id).toBe("demo");
    expect(second.skipped[0]?.reason).toContain("already installed");

    // The converted folder is exactly as the first run (plus the test's own marker) left it.
    expect(existsSync(join(targetDir, "marker.txt"))).toBe(true);
    expect(existsSync(join(targetDir, ".claude-plugin", "plugin.json"))).toBe(true);

    // Still listed in the marketplace manifest -- resolvePluginSourcePath needs it there for any
    // FUTURE fresh install of the same id, since the folder genuinely is still there.
    const marketplaceJson = JSON.parse(readFileSync(
      join(sdkPluginsRoot(h), "marketplaces", "winter-legacy", ".claude-plugin", "marketplace.json"), "utf8",
    )) as { plugins: Array<{ name: string }> };
    expect(marketplaceJson.plugins.map((p) => p.name)).toContain("demo");

    // Still exactly one install record for it -- the registration loop never re-ran installPlugin.
    const listing = await listPlugins({ pluginsRoot: sdkPluginsRoot(h), settingsPathFor: () => join(sdkHomeFor(h), "settings.json") });
    expect(listing.filter((p) => p.id === "demo" && p.marketplace === "winter-legacy")).toHaveLength(1);
  });

  test("if the previously-converted folder was removed, a re-run converts the plugin again (only the FOLDER's existence gates the skip)", async () => {
    const h = home();
    legacyPlugin(h, "demo", { id: "demo", tier: "capability", contributes: { tools: true } });
    writeFileSync(join(h, "settings.json"), JSON.stringify({
      schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, plugins: { enabled: ["demo"] },
    }));

    const first = await convertLegacyPlugins(h);
    const targetDir = first.converted[0]!.installPath;
    rmSync(targetDir, { recursive: true, force: true });

    const second = await convertLegacyPlugins(h);
    expect(second.skipped).toEqual([]);
    expect(second.converted).toHaveLength(1);
    expect(existsSync(join(targetDir, ".claude-plugin", "plugin.json"))).toBe(true);
  });
});

// Reviewer round, item 1 (Opus review): installPlugin (in the fresh-conversion path) defaults a
// brand-new install to enabled:true; the disable that corrects an UNCONSENTED plugin back to false
// is a SEPARATE call right after it. A crash between the two -- or anywhere later in the
// registration loop, since rekeyConsents runs only ONCE, at the very end -- leaves the install
// record + folder in place with the plugin still enabled and its qualified consent record never
// written. Minor 2's own "don't overwrite" skip path must still finish that interrupted work on
// every resume, not silently accept the half-finished state as done.
describe("reviewer round, item 1: a crash between install and disable doesn't leave an unconsented plugin enabled forever", () => {
  function pluginOptionsFor(h: string) {
    return { pluginsRoot: sdkPluginsRoot(h), settingsPathFor: () => join(sdkHomeFor(h), "settings.json") };
  }

  test("simulating a crash after install (enabled:true) and before the disable: re-running fixes the enabled state AND writes the qualified consent record", async () => {
    const h = home();
    // Requires BOTH tcc and hardware consent, but the legacy record only ever covered tcc --
    // partially consented, so wasFullyConsented is false and the plugin must convert disabled.
    legacyPlugin(h, "partial", { id: "partial", tier: "capability", permissions: { tcc: ["accessibility"], hardware: ["battery"] } });
    writeFileSync(join(h, "settings.json"), JSON.stringify({
      schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" },
      plugins: { enabled: ["partial"], consents: { partial: { tcc: Date.now() } } },
    }));

    // A normal, uninterrupted first run: converts, installs DISABLED (unconsented), writes the
    // qualified consent record (carrying forward tcc, not hardware) via rekeyConsents.
    const first = await convertLegacyPlugins(h);
    expect(first.converted).toHaveLength(1);
    expect(first.converted[0]?.enabled).toBe(false);
    const settingsPath = join(h, "settings.json");
    const beforeCrashSim = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(beforeCrashSim.plugins.consents["partial@winter-legacy"]).toEqual({ classes: ["tcc"], fingerprint: expect.any(String) });

    // Reconstruct the EXACT state a crash between installPlugin (default enabled:true) and the
    // disable call would leave: enabled flipped back to true, and the qualified consent record --
    // which only rekeyConsents, at the very END of the run, ever writes -- deleted as if it never
    // landed.
    const pluginOptions = pluginOptionsFor(h);
    await setPluginEnabled(pluginOptions, "partial@winter-legacy", "user", true);
    const corrupted = JSON.parse(readFileSync(settingsPath, "utf8"));
    delete corrupted.plugins.consents["partial@winter-legacy"];
    writeFileSync(settingsPath, JSON.stringify(corrupted));

    // Confirm the simulated crash state actually represents "enabled, unconsented" before resuming.
    const beforeResume = await listPlugins(pluginOptions);
    expect(beforeResume.find((p) => p.id === "partial" && p.marketplace === "winter-legacy")?.enabled).toBe(true);
    const beforeResumeSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(beforeResumeSettings.plugins.consents["partial@winter-legacy"]).toBeUndefined();

    // The "resumed" run: this id is already installed (minor 2's skip path) -- must still finish
    // the interrupted disable + consent-record write.
    const second = await convertLegacyPlugins(h);
    expect(second.converted).toEqual([]);
    expect(second.skipped.map((s) => s.id)).toContain("partial");

    const afterResume = await listPlugins(pluginOptions);
    expect(afterResume.find((p) => p.id === "partial" && p.marketplace === "winter-legacy")?.enabled).toBe(false);

    const settingsAfter = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settingsAfter.plugins.consents["partial@winter-legacy"]).toEqual({ classes: ["tcc"], fingerprint: expect.any(String) });
    // The bare legacy record is still there too -- this fix only ADDS, never touches it (finding 2).
    expect(settingsAfter.plugins.consents.partial).toEqual({ tcc: expect.any(Number) });
  });

  test("a crash-resumed FULLY CONSENTED plugin is left enabled -- the disable only applies when consent didn't cover everything", async () => {
    const h = home();
    legacyPlugin(h, "trusted", { id: "trusted", tier: "capability", permissions: { tcc: ["accessibility"] } });
    writeFileSync(join(h, "settings.json"), JSON.stringify({
      schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" },
      plugins: { enabled: ["trusted"], consents: { trusted: { tcc: Date.now() } } },
    }));

    const first = await convertLegacyPlugins(h);
    expect(first.converted[0]?.enabled).toBe(true); // fully consented -- converts enabled, no disable call made

    // Simulate a crash strictly BEFORE rekeyConsents ran (the only thing left to finish for an
    // already-correctly-enabled plugin): delete the qualified consent record it would have written.
    const settingsPath = join(h, "settings.json");
    const corrupted = JSON.parse(readFileSync(settingsPath, "utf8"));
    delete corrupted.plugins.consents["trusted@winter-legacy"];
    writeFileSync(settingsPath, JSON.stringify(corrupted));

    const pluginOptions = pluginOptionsFor(h);
    const second = await convertLegacyPlugins(h);
    expect(second.skipped.map((s) => s.id)).toContain("trusted");

    // Never force-disabled: wasFullyConsented was true, so the disable branch never applies.
    const afterResume = await listPlugins(pluginOptions);
    expect(afterResume.find((p) => p.id === "trusted" && p.marketplace === "winter-legacy")?.enabled).toBe(true);

    // The qualified consent record is still completed on resume.
    const settingsAfter = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settingsAfter.plugins.consents["trusted@winter-legacy"]).toEqual({ classes: ["tcc"], fingerprint: expect.any(String) });
  });
});

// Reviewer round, item 2: legacyShipsSkills now follows symlinks (statSync-based isDirectory, not
// Dirent.isDirectory(), which reports a symlink entry's OWN type -- "symbolic link" -- never the
// target's). A shipped skill that is itself a symlinked directory (a shared skill package linked
// in, for instance) was silently missed, under-reporting the pre-WS-21 exec requirement.
describe("reviewer round, item 2: legacyShipsSkills follows symlinks", () => {
  test("a plugin whose ONLY skill is a SYMLINKED directory under skills/ still requires (and lacks) exec consent -- converts disabled", async () => {
    const h = home();
    // No entry, no permissions.exec, no mcpServers/hooks -- shipsSkills is the ONLY thing that can
    // make execNeeded true here.
    const legacyDir = legacyPlugin(h, "skilled", { id: "skilled", tier: "capability" });
    mkdirSync(join(legacyDir, "real-skill-storage", "greet"), { recursive: true });
    writeFileSync(join(legacyDir, "real-skill-storage", "greet", "SKILL.md"), "---\nname: greet\n---\nhi");
    mkdirSync(join(legacyDir, "skills"), { recursive: true });
    // An INTERNAL symlink (stays inside the plugin's own folder, so finding 4's escaping-symlink
    // guard does not refuse the conversion) -- but still a symlink, which is the point.
    symlinkSync(join(legacyDir, "real-skill-storage", "greet"), join(legacyDir, "skills", "greet"));
    writeFileSync(join(h, "settings.json"), JSON.stringify({
      schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, plugins: { enabled: ["skilled"] }, // no consent record at all
    }));

    const result = await convertLegacyPlugins(h);
    expect(result.converted).toHaveLength(1);
    expect(result.converted[0]?.enabled).toBe(false);
  });
});
