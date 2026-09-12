import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginStore, pluginMcpEligible, type PluginConsentRecord } from "../../src/agent/plugins";

/**
 * Phase 4a gate (design spec §9): "legacy plugin untouched; a manifest plugin with exec consents
 * installs/enables with the full consent block." ONE chained flow, tmp-home fixtures, three parts:
 *
 *   (1) a legacy plugin.json-only plugin (skills + .mcp.json, no winter-plugin.json) — skills
 *       listed, MCP inert until enabled, enabling flips mcpEnabled/pluginMcpEligible true with
 *       ZERO consents involved anywhere in the chain; the shared PluginInfo fields match the
 *       exact pre-4a shape (see git show 9f941eb^:packages/core/src/agent/plugins.ts).
 *   (2) a winter-plugin.json manifest plugin (tier capability, contributes.mcpServers, a tcc
 *       permission) — requiredConsents derives to ["exec","tcc"]; enabled-without-consent is
 *       excluded from MCP eligibility; writing both consent records flips it eligible AND
 *       produces the manifestServers the daemon would hand to McpManager.startPlugins; deleting
 *       the consent record (what `winter plugin disable` does — Task 3) flips it back off.
 *   (3) a plugin shipping a malformed winter-plugin.json — falls back to the legacy load path with
 *       a warning logged, and still loads (never bricks).
 *
 * This file pins the PluginStore / pluginMcpEligible CONTRACT the daemon's real wiring runs on
 * top of. Full daemon-boot coverage (a real child-process McpManager.startPlugins,
 * .mcp.json-vs-manifest precedence, the "missing consent" log line) already lives in
 * server.test.ts's Task 2 ("CONSENT (Task 2): ...") and Task 4 ("Task 4: ...") tests — this gate
 * re-derives the daemon's enabledPlugins filter (daemon.ts's `allPlugins.filter(pluginMcpEligible)
 * .map(p => ({ name, dir, manifestServers: p.manifestServers }))`) directly against
 * pluginMcpEligible so the same claim is pinned without paying for a daemon boot. manifestServers
 * comes straight off PluginInfo (filled by PluginStore.list()'s single loadManifest call) — no
 * second manifest read here, matching daemon.ts (final-review fix: single manifest read).
 */

function home(): string {
  return mkdtempSync(join(tmpdir(), "winter-4a-gate-"));
}

/** Mirrors daemon.ts's enabledPlugins derivation exactly (source of truth: daemon.ts) — the list
 *  of { name, manifestServers } McpManager.startPlugins would actually receive. */
function wouldStartPlugins(winterHome: string, plugins: ReturnType<PluginStore["list"]>) {
  return plugins.filter(pluginMcpEligible).map((p) => ({ name: p.name, manifestServers: p.manifestServers }));
}

describe("4a gate (spec §9): legacy plugin untouched; manifest plugin consent lifecycle", () => {
  // ---------------------------------------------------------------------------------------
  // (1) legacy plugin (plugin.json only) — byte-identical pre-4a shape, zero consents ever.
  // ---------------------------------------------------------------------------------------
  describe("(1) legacy plugin.json-only plugin", () => {
    let h: string;
    const name = "legacy-demo";

    beforeAll(() => {
      h = home();
      const dir = join(h, "plugins", name);
      mkdirSync(join(dir, "skills", "greet"), { recursive: true });
      writeFileSync(join(dir, "skills", "greet", "SKILL.md"), "---\nname: greet\ndescription: hi\n---\nbody");
      writeFileSync(join(dir, "plugin.json"), JSON.stringify({ description: "legacy plugin", version: "1.0.0" }));
      writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { fake: { command: "true" } } }));
    });

    test("skills listed, MCP inert until enabled — no consents dep supplied anywhere", () => {
      const [p] = new PluginStore({ winterHome: h }).list();
      if (!p) throw new Error("expected one plugin");
      expect(p.skills).toEqual(["greet"]);
      expect(p.hasMcp).toBe(true);
      expect(p.mcpEnabled).toBe(false); // not in settings.plugins.enabled — inert
      expect(pluginMcpEligible(p)).toBe(false);
      expect(wouldStartPlugins(h, [p])).toEqual([]);
    });

    test("enable -> mcpEnabled + pluginMcpEligible true, ZERO consents involved", () => {
      const [p] = new PluginStore({ winterHome: h, plugins: { enabled: [name] } }).list();
      if (!p) throw new Error("expected one plugin");
      expect(p.mcpEnabled).toBe(true);
      expect(p.requiredConsents).toEqual([]); // legacy: nothing is ever required
      expect(p.consented).toEqual([]); // no consents dep supplied at all — still fine
      expect(pluginMcpEligible(p)).toBe(true); // enable alone suffices, exactly pre-4a
      expect(wouldStartPlugins(h, [p])).toEqual([{ name, manifestServers: undefined }]);
    });

    test("PluginInfo shared fields equal the pre-4a shape (name/skills/hasMcp/mcpEnabled/disabled)", () => {
      const [p] = new PluginStore({ winterHome: h, plugins: { enabled: [name] } }).list();
      if (!p) throw new Error("expected one plugin");
      // Pre-4a PluginInfo was exactly { name, description?, version?, skills, hasMcp, mcpEnabled,
      // disabled } (git show 9f941eb^:packages/core/src/agent/plugins.ts) — these five fields
      // must be byte-identical for a legacy plugin under 4a.
      expect({ name: p.name, skills: p.skills, hasMcp: p.hasMcp, mcpEnabled: p.mcpEnabled, disabled: p.disabled }).toEqual({
        name, skills: ["greet"], hasMcp: true, mcpEnabled: true, disabled: false,
      });
      expect(p.description).toBe("legacy plugin");
      expect(p.version).toBe("1.0.0");
      // 4a additions carry the "nothing here" defaults for a legacy plugin.
      expect(p.legacy).toBe(true);
      expect(p.tier).toBeUndefined();
      expect(p.hasManifestMcp).toBe(false);
      expect(p.execPayload).toEqual([]);
      expect(p.tccPermissions).toEqual([]);
      expect(p.hardwarePermissions).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------------------
  // (2) winter-plugin.json manifest plugin: tier capability, contributes.mcpServers,
  //     permissions.tcc — full consent lifecycle (unconsented -> consented -> disabled).
  // ---------------------------------------------------------------------------------------
  describe("(2) winter-plugin.json manifest plugin — consent lifecycle", () => {
    let h: string;
    const name = "manifest-demo";
    const server = { name: "srv", command: "node", args: ["server.js"] };

    beforeAll(() => {
      h = home();
      const dir = join(h, "plugins", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "winter-plugin.json"), JSON.stringify({
        id: name, tier: "capability",
        permissions: { tcc: ["accessibility"] },
        contributes: { mcpServers: [server] },
      }));
    });

    test("requiredConsents derives to [exec, tcc]", () => {
      const [p] = new PluginStore({ winterHome: h }).list();
      if (!p) throw new Error("expected one plugin");
      expect(p.tier).toBe("capability");
      expect(p.legacy).toBe(false);
      expect(p.requiredConsents.sort()).toEqual(["exec", "tcc"]);
    });

    test("enabled WITHOUT consent -> pluginMcpEligible FALSE (daemon excludes it from MCP start)", () => {
      const [p] = new PluginStore({ winterHome: h, plugins: { enabled: [name] } }).list();
      if (!p) throw new Error("expected one plugin");
      expect(p.mcpEnabled).toBe(true);
      expect(p.consented).toEqual([]);
      expect(pluginMcpEligible(p)).toBe(false);
      expect(wouldStartPlugins(h, [p])).toEqual([]); // never reaches McpManager.startPlugins
    });

    test("consent records written for BOTH classes -> pluginMcpEligible TRUE, daemon would receive manifestServers", () => {
      const consents: Record<string, PluginConsentRecord> = { [name]: { exec: Date.now(), tcc: Date.now() } };
      const [p] = new PluginStore({ winterHome: h, plugins: { enabled: [name] }, consents }).list();
      if (!p) throw new Error("expected one plugin");
      expect(p.consented.sort()).toEqual(["exec", "tcc"]);
      expect(pluginMcpEligible(p)).toBe(true);
      expect(wouldStartPlugins(h, [p])).toEqual([{ name, manifestServers: [server] }]);
    });

    test("disable-equivalent (consent record deleted) -> pluginMcpEligible FALSE again", () => {
      // `winter plugin disable` deletes the plugin's whole consent record (plugin-cli.ts's
      // stripPluginConsents, Task 3's fresh-consent rule) — simulated here at the settings shape
      // this core-only test file can see directly: no entry for `name` in consents at all.
      const consents: Record<string, PluginConsentRecord> = {};
      const [p] = new PluginStore({ winterHome: h, plugins: { enabled: [name] }, consents }).list();
      if (!p) throw new Error("expected one plugin");
      expect(p.consented).toEqual([]);
      expect(pluginMcpEligible(p)).toBe(false);
      expect(wouldStartPlugins(h, [p])).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------------------
  // (3) malformed winter-plugin.json -> legacy load + warning, never bricks.
  // ---------------------------------------------------------------------------------------
  describe("(3) malformed winter-plugin.json", () => {
    test("falls back to legacy load with a warning logged; the plugin still loads (skills live)", () => {
      const h = home();
      const name = "malformed-demo";
      const dir = join(h, "plugins", name);
      mkdirSync(join(dir, "skills", "hi"), { recursive: true });
      writeFileSync(join(dir, "skills", "hi", "SKILL.md"), "---\nname: hi\ndescription: hi\n---\nbody");
      writeFileSync(join(dir, "winter-plugin.json"), "{not json");
      const logs: string[] = [];
      const [p] = new PluginStore({ winterHome: h, log: (m) => logs.push(m) }).list();
      if (!p) throw new Error("expected one plugin");
      expect(p.legacy).toBe(true);
      expect(p.name).toBe(name);
      expect(p.skills).toEqual(["hi"]); // plugin still loads — skills live
      expect(p.tier).toBeUndefined();
      expect(p.requiredConsents).toEqual([]);
      expect(logs.some((m) => m.includes(name))).toBe(true); // warning logged
    });
  });
});
