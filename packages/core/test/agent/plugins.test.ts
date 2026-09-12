import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginStore, consentComplete, pluginMcpEligible, pluginHooksEligible, pluginSpawnEligible, type PluginInfo } from "../../src/agent/plugins";
import { execPayloadLines, loadManifest, requiredConsentClasses, type WinterManifest } from "../../src/agent/plugin-manifest";

function home(): string { return mkdtempSync(join(tmpdir(), "winter-plugins-")); }
function plugin(h: string, name: string, opts: { manifest?: unknown; skills?: string[]; mcp?: boolean } = {}) {
  const dir = join(h, "plugins", name); mkdirSync(dir, { recursive: true });
  if (opts.manifest !== undefined) writeFileSync(join(dir, "plugin.json"), typeof opts.manifest === "string" ? opts.manifest : JSON.stringify(opts.manifest));
  for (const s of opts.skills ?? []) { mkdirSync(join(dir, "skills", s), { recursive: true }); writeFileSync(join(dir, "skills", s, "SKILL.md"), `---\nname: ${s}\ndescription: d\n---\nbody`); }
  if (opts.mcp) writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { fake: { command: "true" } } }));
  return dir;
}
function winterPlugin(h: string, name: string, manifest: unknown, opts: { skills?: string[] } = {}) {
  const dir = join(h, "plugins", name); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "winter-plugin.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  for (const s of opts.skills ?? []) { mkdirSync(join(dir, "skills", s), { recursive: true }); writeFileSync(join(dir, "skills", s, "SKILL.md"), `---\nname: ${s}\ndescription: d\n---\nbody`); }
  return dir;
}
/** Minimal valid WinterManifest, id/tier defaulted, everything else overridable. */
function mkManifest(overrides: Partial<WinterManifest> = {}): WinterManifest {
  return { id: "p", tier: "capability", ...overrides };
}
/** Minimal valid PluginInfo (legacy-shaped defaults), everything overridable — for pure
 *  consentComplete/pluginMcpEligible table tests that don't need a real PluginStore fixture. */
function mkPluginInfo(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    name: "p", skills: [], hasMcp: false, mcpEnabled: false, disabled: false,
    requiredConsents: [], consented: [], legacy: true, hasManifestMcp: false,
    execPayload: [], tccPermissions: [], hardwarePermissions: [],
    ...overrides,
  };
}

describe("PluginStore", () => {
  test("missing plugins dir → []", () => { expect(new PluginStore({ winterHome: home() }).list()).toEqual([]); });
  test("manifest parsed; dir name canonical; skills + hasMcp listed", () => {
    const h = home(); plugin(h, "demo", { manifest: { name: "other-name", version: "0.1.0", description: "d" }, skills: ["greet", "bye"], mcp: true });
    const [p] = new PluginStore({ winterHome: h }).list();
    if (!p) throw new Error("expected one plugin");
    expect(p.name).toBe("demo");                 // DIR NAME canonical, not manifest.name
    expect(p.version).toBe("0.1.0");
    expect(p.skills.sort()).toEqual(["bye", "greet"]);
    expect(p.hasMcp).toBe(true);
    expect(p.mcpEnabled).toBe(false); expect(p.disabled).toBe(false);
    // Phase 4a additions — no winter-plugin.json present, so this is the legacy path.
    expect(p.legacy).toBe(true);
    expect(p.tier).toBeUndefined();
    expect(p.requiredConsents).toEqual([]);
    expect(p.consented).toEqual([]);
    expect(p.hasManifestMcp).toBe(false);
    // Task 3 additions — legacy plugins carry no consent-block display data.
    expect(p.execPayload).toEqual([]);
    expect(p.tccPermissions).toEqual([]);
    expect(p.hardwarePermissions).toEqual([]);
  });
  test("manifest-less + malformed-manifest plugins still load", () => {
    const h = home(); plugin(h, "bare", { skills: ["s1"] }); plugin(h, "broken", { manifest: "{not json", skills: ["s2"] });
    const list = new PluginStore({ winterHome: h }).list();
    expect(list.map((p) => p.name).sort()).toEqual(["bare", "broken"]);
    for (const p of list) {
      expect(p.legacy).toBe(true);
      expect(p.tier).toBeUndefined();
      expect(p.requiredConsents).toEqual([]);
      expect(p.consented).toEqual([]);
      expect(p.hasManifestMcp).toBe(false);
    }
  });
  test("mcpEnabled/disabled from settings; disabled beats enabled", () => {
    const h = home(); plugin(h, "a", { mcp: true }); plugin(h, "b", { mcp: true });
    const l = new PluginStore({ winterHome: h, plugins: { enabled: ["a", "b"], disabled: ["b"] } }).list();
    expect(l.find((p) => p.name === "a")!.mcpEnabled).toBe(true);
    const b = l.find((p) => p.name === "b")!;
    expect(b.disabled).toBe(true); expect(b.mcpEnabled).toBe(false);
  });
});

describe("PluginStore + winter-plugin.json", () => {
  test("valid manifest → tier/requiredConsents populated, legacy:false, hasManifestMcp:true", () => {
    const h = home();
    winterPlugin(h, "demo", {
      id: "demo", tier: "platform", description: "manifest desc", version: "1.0.0",
      permissions: { exec: true, tcc: ["accessibility"] },
      contributes: { mcpServers: [{ name: "srv", command: "node", args: ["server.js"] }] },
      entry: { command: "node", args: ["index.js"] },
    }, { skills: ["greet"] });
    const [p] = new PluginStore({ winterHome: h }).list();
    if (!p) throw new Error("expected one plugin");
    expect(p.name).toBe("demo"); // dir name still canonical
    expect(p.description).toBe("manifest desc");
    expect(p.version).toBe("1.0.0");
    expect(p.tier).toBe("platform");
    expect(p.requiredConsents.sort()).toEqual(["exec", "tcc"]);
    expect(p.consented).toEqual([]);
    expect(p.legacy).toBe(false);
    expect(p.hasManifestMcp).toBe(true);
    expect(p.skills).toEqual(["greet"]); // skill discovery stays directory-based regardless of manifest
    // Task 3 additions — consent-block display data, filled from the manifest.
    expect(p.execPayload).toEqual(["mcp: node server.js", "entry: node index.js"]);
    expect(p.tccPermissions).toEqual(["accessibility"]);
    expect(p.hardwarePermissions).toEqual([]);
    // manifestServers is filled from the SAME loadManifest call — daemon.ts reads this directly
    // instead of re-parsing winter-plugin.json a second time (final-review fix).
    expect(p.manifestServers).toEqual([{ name: "srv", command: "node", args: ["server.js"] }]);
    // Phase 4b Task 3 addition — entry carried the same way (daemon.ts's PluginSupervisor wiring
    // reads p.entry directly, no second manifest read).
    expect(p.entry).toEqual({ command: "node", args: ["index.js"] });
  });

  test("contributes.hooks → manifestHooks carried verbatim (Phase 4f Task 2)", () => {
    const h = home();
    winterPlugin(h, "demo", {
      id: "demo", tier: "capability",
      contributes: { hooks: [{ event: "pre-tool", command: "./deny.sh", timeoutMs: 500 }, { event: "post-tool", command: "./observe.sh" }] },
    });
    const [p] = new PluginStore({ winterHome: h }).list();
    if (!p) throw new Error("expected one plugin");
    expect(p.manifestHooks).toEqual([
      { event: "pre-tool", command: "./deny.sh", timeoutMs: 500 },
      { event: "post-tool", command: "./observe.sh" },
    ]);
  });

  test("no contributes.hooks → manifestHooks undefined", () => {
    const h = home();
    winterPlugin(h, "demo", { id: "demo", tier: "capability", contributes: { skills: true } });
    const [p] = new PluginStore({ winterHome: h }).list();
    if (!p) throw new Error("expected one plugin");
    expect(p.manifestHooks).toBeUndefined();
  });

  test("legacy plugin (no winter-plugin.json) → manifestHooks undefined", () => {
    const h = home(); plugin(h, "demo", { mcp: true });
    const [p] = new PluginStore({ winterHome: h }).list();
    if (!p) throw new Error("expected one plugin");
    expect(p.manifestHooks).toBeUndefined();
  });

  test("no entry declared → PluginInfo.entry undefined (capability-tier / skills-only plugins)", () => {
    const h = home();
    winterPlugin(h, "demo", { id: "demo", tier: "capability", contributes: { skills: true } });
    const [p] = new PluginStore({ winterHome: h }).list();
    if (!p) throw new Error("expected one plugin");
    expect(p.entry).toBeUndefined();
  });

  test("legacy plugin (no winter-plugin.json) → entry undefined", () => {
    const h = home(); plugin(h, "demo", { mcp: true });
    const [p] = new PluginStore({ winterHome: h }).list();
    if (!p) throw new Error("expected one plugin");
    expect(p.entry).toBeUndefined();
  });

  test("no contributes.mcpServers → hasManifestMcp false, manifestServers undefined", () => {
    const h = home();
    winterPlugin(h, "demo", { id: "demo", tier: "capability", contributes: { skills: true } });
    const [p] = new PluginStore({ winterHome: h }).list();
    if (!p) throw new Error("expected one plugin");
    expect(p.hasManifestMcp).toBe(false);
    expect(p.manifestServers).toBeUndefined();
  });

  test("legacy plugin (no winter-plugin.json) → manifestServers undefined", () => {
    const h = home(); plugin(h, "demo", { mcp: true });
    const [p] = new PluginStore({ winterHome: h }).list();
    if (!p) throw new Error("expected one plugin");
    expect(p.legacy).toBe(true);
    expect(p.manifestServers).toBeUndefined();
  });

  test("id mismatch → directory name wins + warning logged", () => {
    const h = home();
    winterPlugin(h, "demo", { id: "other-id", tier: "capability" });
    const logs: string[] = [];
    const [p] = new PluginStore({ winterHome: h, log: (m) => logs.push(m) }).list();
    if (!p) throw new Error("expected one plugin");
    expect(p.name).toBe("demo");
    expect(logs.some((m) => m.includes("demo") && m.includes("other-id"))).toBe(true);
  });

  test("malformed winter-plugin.json → legacy:true + warning, never bricks", () => {
    const h = home();
    winterPlugin(h, "demo", "{not json");
    const logs: string[] = [];
    const [p] = new PluginStore({ winterHome: h, log: (m) => logs.push(m) }).list();
    if (!p) throw new Error("expected one plugin");
    expect(p.legacy).toBe(true);
    expect(p.name).toBe("demo");
    expect(p.tier).toBeUndefined();
    expect(logs.some((m) => m.includes("demo"))).toBe(true);
  });

  test("schema-invalid winter-plugin.json (bad tier) → legacy:true + warning", () => {
    const h = home();
    winterPlugin(h, "demo", { id: "demo", tier: "not-a-tier" });
    const logs: string[] = [];
    const [p] = new PluginStore({ winterHome: h, log: (m) => logs.push(m) }).list();
    if (!p) throw new Error("expected one plugin");
    expect(p.legacy).toBe(true);
    expect(logs.length).toBeGreaterThan(0);
  });

  test("winter-plugin.json takes precedence over legacy plugin.json when both present", () => {
    const h = home();
    const dir = join(h, "plugins", "demo"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ description: "legacy-desc", version: "0.0.1" }));
    writeFileSync(join(dir, "winter-plugin.json"), JSON.stringify({ id: "demo", tier: "capability", description: "manifest-desc", version: "2.0.0" }));
    const [p] = new PluginStore({ winterHome: h }).list();
    if (!p) throw new Error("expected one plugin");
    expect(p.description).toBe("manifest-desc");
    expect(p.version).toBe("2.0.0");
    expect(p.legacy).toBe(false);
  });
});

describe("PluginStore + consent-block display data (Task 3)", () => {
  test("hardware-only manifest → hardwarePermissions populated, tcc/execPayload empty", () => {
    const h = home();
    winterPlugin(h, "demo", { id: "demo", tier: "platform", permissions: { hardware: ["battery"] } });
    const [p] = new PluginStore({ winterHome: h }).list();
    if (!p) throw new Error("expected one plugin");
    expect(p.hardwarePermissions).toEqual(["battery"]);
    expect(p.tccPermissions).toEqual([]);
    expect(p.execPayload).toEqual([]);
  });

  test("manifest with no exec/tcc/hardware content → all three display arrays empty", () => {
    const h = home();
    winterPlugin(h, "demo", { id: "demo", tier: "capability", contributes: { skills: true } });
    const [p] = new PluginStore({ winterHome: h }).list();
    if (!p) throw new Error("expected one plugin");
    expect(p.requiredConsents).toEqual([]);
    expect(p.execPayload).toEqual([]);
    expect(p.tccPermissions).toEqual([]);
    expect(p.hardwarePermissions).toEqual([]);
  });
});

describe("PluginStore + consents (Task 2)", () => {
  // Legacy-unchanged case FIRST: a legacy plugin's requiredConsents is always [], so enabling it
  // is exactly as sufficient as it was before consent records existed — no consents dep, no
  // record, still eligible.
  test("legacy plugin: enable alone is eligible — no consents involved (UNCHANGED baseline)", () => {
    const h = home(); plugin(h, "demo", { mcp: true });
    const [p] = new PluginStore({ winterHome: h, plugins: { enabled: ["demo"] } }).list();
    if (!p) throw new Error("expected one plugin");
    expect(p.legacy).toBe(true);
    expect(p.requiredConsents).toEqual([]);
    expect(p.consented).toEqual([]); // no consents dep supplied at all
    expect(consentComplete(p)).toBe(true); // vacuously true — requiredConsents is []
    expect(pluginMcpEligible(p)).toBe(true); // enable alone suffices, exactly like pre-4a
  });

  test("consented fills from settings.plugins.consents[name] — one entry per present class", () => {
    const h = home();
    winterPlugin(h, "demo", {
      id: "demo", tier: "capability",
      permissions: { tcc: ["accessibility"] },
      contributes: { mcpServers: [{ name: "srv", command: "node" }] },
    });
    const [p] = new PluginStore({ winterHome: h, consents: { demo: { exec: 1000, tcc: 2000 } } }).list();
    if (!p) throw new Error("expected one plugin");
    expect(p.requiredConsents.sort()).toEqual(["exec", "tcc"]);
    expect(p.consented.sort()).toEqual(["exec", "tcc"]);
  });

  test("consents present for a DIFFERENT plugin id → this plugin's consented stays []", () => {
    const h = home();
    winterPlugin(h, "demo", { id: "demo", tier: "capability", permissions: { exec: true } });
    const [p] = new PluginStore({ winterHome: h, consents: { other: { exec: 1 } } }).list();
    if (!p) throw new Error("expected one plugin");
    expect(p.consented).toEqual([]);
  });

  test("partial consent — only some required classes recorded", () => {
    const h = home();
    winterPlugin(h, "demo", {
      id: "demo", tier: "platform",
      permissions: { tcc: ["accessibility"], hardware: ["battery"] },
      entry: { command: "node" },
    });
    const [p] = new PluginStore({ winterHome: h, consents: { demo: { exec: 1 } } }).list();
    if (!p) throw new Error("expected one plugin");
    expect(p.requiredConsents.sort()).toEqual(["exec", "hardware", "tcc"]);
    expect(p.consented).toEqual(["exec"]);
  });
});

describe("consentComplete", () => {
  test("legacy (requiredConsents []) → always true regardless of consented", () => {
    expect(consentComplete(mkPluginInfo())).toBe(true);
  });
  test("manifest requiring exec, nothing consented → false", () => {
    expect(consentComplete(mkPluginInfo({ requiredConsents: ["exec"], consented: [] }))).toBe(false);
  });
  test("manifest requiring exec+tcc, only exec consented → false", () => {
    expect(consentComplete(mkPluginInfo({ requiredConsents: ["exec", "tcc"], consented: ["exec"] }))).toBe(false);
  });
  test("manifest requiring exec+tcc, both consented → true", () => {
    expect(consentComplete(mkPluginInfo({ requiredConsents: ["exec", "tcc"], consented: ["exec", "tcc"] }))).toBe(true);
  });
  test("extra unrelated consented classes don't matter", () => {
    expect(consentComplete(mkPluginInfo({ requiredConsents: ["tcc"], consented: ["exec", "tcc", "hardware"] }))).toBe(true);
  });
});

describe("pluginMcpEligible", () => {
  test("legacy: enabled + hasMcp + not disabled → eligible (no consent needed) [UNCHANGED]", () => {
    expect(pluginMcpEligible(mkPluginInfo({ mcpEnabled: true, hasMcp: true }))).toBe(true);
  });
  test("legacy: not enabled → not eligible", () => {
    expect(pluginMcpEligible(mkPluginInfo({ mcpEnabled: false, hasMcp: true }))).toBe(false);
  });
  test("disabled beats enabled → not eligible", () => {
    expect(pluginMcpEligible(mkPluginInfo({ mcpEnabled: true, disabled: true, hasMcp: true }))).toBe(false);
  });
  test("no MCP content at all (hasMcp false, hasManifestMcp false) → not eligible even if enabled", () => {
    expect(pluginMcpEligible(mkPluginInfo({ mcpEnabled: true, hasMcp: false, hasManifestMcp: false }))).toBe(false);
  });
  test("hasManifestMcp alone (no legacy .mcp.json) counts as MCP content", () => {
    expect(pluginMcpEligible(mkPluginInfo({ mcpEnabled: true, hasMcp: false, hasManifestMcp: true, legacy: false }))).toBe(true);
  });
  test("manifest+exec: enabled but unconsented → not eligible", () => {
    expect(pluginMcpEligible(mkPluginInfo({
      mcpEnabled: true, hasManifestMcp: true, legacy: false, requiredConsents: ["exec"], consented: [],
    }))).toBe(false);
  });
  test("manifest+exec: enabled + consented → eligible", () => {
    expect(pluginMcpEligible(mkPluginInfo({
      mcpEnabled: true, hasManifestMcp: true, legacy: false, requiredConsents: ["exec"], consented: ["exec"],
    }))).toBe(true);
  });

  // CARRIED from T1's review: entry/mcpServers present + permissions.exec:false is an
  // OR-derivation, not AND — requiredConsentClasses still requires exec (see the
  // requiredConsentClasses table below), so the filter must still exclude an unconsented plugin
  // in that combo, end-to-end through a real PluginStore fixture (not just the pure predicate).
  test("CARRIED: mcpServers present + permissions.exec:false, enabled, no record → excluded", () => {
    const h = home();
    winterPlugin(h, "demo", {
      id: "demo", tier: "capability",
      permissions: { exec: false },
      contributes: { mcpServers: [{ name: "srv", command: "node" }] },
    });
    const [p] = new PluginStore({ winterHome: h, plugins: { enabled: ["demo"] } }).list();
    if (!p) throw new Error("expected one plugin");
    expect(p.requiredConsents).toContain("exec");
    expect(pluginMcpEligible(p)).toBe(false);
  });
  test("CARRIED: same plugin, once exec-consented → included", () => {
    const h = home();
    winterPlugin(h, "demo", {
      id: "demo", tier: "capability",
      permissions: { exec: false },
      contributes: { mcpServers: [{ name: "srv", command: "node" }] },
    });
    const [p] = new PluginStore({
      winterHome: h, plugins: { enabled: ["demo"] }, consents: { demo: { exec: Date.now() } },
    }).list();
    if (!p) throw new Error("expected one plugin");
    expect(pluginMcpEligible(p)).toBe(true);
  });
});

describe("pluginHooksEligible (Phase 4f Task 2)", () => {
  const oneHook = [{ event: "pre-tool" as const, command: "./deny.sh" }];

  test("enabled + manifestHooks + not disabled + no consent required → eligible", () => {
    expect(pluginHooksEligible(mkPluginInfo({ mcpEnabled: true, manifestHooks: oneHook, legacy: false }))).toBe(true);
  });
  test("not enabled → not eligible", () => {
    expect(pluginHooksEligible(mkPluginInfo({ mcpEnabled: false, manifestHooks: oneHook, legacy: false }))).toBe(false);
  });
  test("disabled beats enabled → not eligible", () => {
    expect(pluginHooksEligible(mkPluginInfo({ mcpEnabled: true, disabled: true, manifestHooks: oneHook, legacy: false }))).toBe(false);
  });
  test("no hooks declared (manifestHooks undefined) → not eligible even if enabled", () => {
    expect(pluginHooksEligible(mkPluginInfo({ mcpEnabled: true, manifestHooks: undefined, legacy: false }))).toBe(false);
  });
  test("empty hooks array → not eligible", () => {
    expect(pluginHooksEligible(mkPluginInfo({ mcpEnabled: true, manifestHooks: [], legacy: false }))).toBe(false);
  });
  test("hooks require exec: enabled but unconsented → not eligible", () => {
    expect(pluginHooksEligible(mkPluginInfo({
      mcpEnabled: true, manifestHooks: oneHook, legacy: false, requiredConsents: ["exec"], consented: [],
    }))).toBe(false);
  });
  test("hooks require exec: enabled + consented → eligible", () => {
    expect(pluginHooksEligible(mkPluginInfo({
      mcpEnabled: true, manifestHooks: oneHook, legacy: false, requiredConsents: ["exec"], consented: ["exec"],
    }))).toBe(true);
  });

  test("end-to-end through a real PluginStore fixture: hooks present, unconsented → excluded", () => {
    const h = home();
    winterPlugin(h, "demo", { id: "demo", tier: "capability", contributes: { hooks: [{ event: "pre-tool", command: "./deny.sh" }] } });
    const [p] = new PluginStore({ winterHome: h, plugins: { enabled: ["demo"] } }).list();
    if (!p) throw new Error("expected one plugin");
    expect(p.requiredConsents).toContain("exec");
    expect(pluginHooksEligible(p)).toBe(false);
  });
  test("end-to-end: same plugin, once exec-consented → included", () => {
    const h = home();
    winterPlugin(h, "demo", { id: "demo", tier: "capability", contributes: { hooks: [{ event: "pre-tool", command: "./deny.sh" }] } });
    const [p] = new PluginStore({
      winterHome: h, plugins: { enabled: ["demo"] }, consents: { demo: { exec: Date.now() } },
    }).list();
    if (!p) throw new Error("expected one plugin");
    expect(pluginHooksEligible(p)).toBe(true);
  });
});

describe("pluginSpawnEligible (Phase 4b Task 3 — PluginSupervisor eligibility)", () => {
  const platformWithEntry = { tier: "platform" as const, entry: { command: "bun", args: ["index.ts"] } };

  test("platform + entry + enabled + consented → eligible", () => {
    expect(pluginSpawnEligible(mkPluginInfo({ ...platformWithEntry, mcpEnabled: true, legacy: false }))).toBe(true);
  });
  test("not enabled → not eligible", () => {
    expect(pluginSpawnEligible(mkPluginInfo({ ...platformWithEntry, mcpEnabled: false, legacy: false }))).toBe(false);
  });
  test("disabled beats enabled → not eligible", () => {
    expect(pluginSpawnEligible(mkPluginInfo({ ...platformWithEntry, mcpEnabled: true, disabled: true, legacy: false }))).toBe(false);
  });
  test("capability tier, even with entry+enabled → not eligible (Tier-2 supervision is platform-only)", () => {
    expect(pluginSpawnEligible(mkPluginInfo({
      tier: "capability", entry: { command: "bun" }, mcpEnabled: true, legacy: false,
    }))).toBe(false);
  });
  test("no tier at all (legacy plugin) → not eligible", () => {
    expect(pluginSpawnEligible(mkPluginInfo({ entry: { command: "bun" }, mcpEnabled: true, legacy: true }))).toBe(false);
  });
  test("platform tier but no entry declared → not eligible (nothing to spawn)", () => {
    expect(pluginSpawnEligible(mkPluginInfo({ tier: "platform", mcpEnabled: true, legacy: false }))).toBe(false);
  });
  test("platform + entry + enabled but unconsented (requiredConsents exec) → not eligible", () => {
    expect(pluginSpawnEligible(mkPluginInfo({
      ...platformWithEntry, mcpEnabled: true, legacy: false, requiredConsents: ["exec"], consented: [],
    }))).toBe(false);
  });
  test("platform + entry + enabled + exec-consented → eligible", () => {
    expect(pluginSpawnEligible(mkPluginInfo({
      ...platformWithEntry, mcpEnabled: true, legacy: false, requiredConsents: ["exec"], consented: ["exec"],
    }))).toBe(true);
  });

  test("end-to-end through a real PluginStore fixture: entry+tier from winter-plugin.json, enable+consent flip eligibility", () => {
    const h = home();
    winterPlugin(h, "demo", {
      id: "demo", tier: "platform",
      permissions: { exec: true },
      entry: { command: "bun", args: ["index.ts"] },
    });
    const notEnabled = new PluginStore({ winterHome: h }).list()[0]!;
    expect(pluginSpawnEligible(notEnabled)).toBe(false); // not enabled yet

    const enabledUnconsented = new PluginStore({ winterHome: h, plugins: { enabled: ["demo"] } }).list()[0]!;
    expect(enabledUnconsented.requiredConsents).toEqual(["exec"]);
    expect(pluginSpawnEligible(enabledUnconsented)).toBe(false); // enabled but missing exec consent

    const consented = new PluginStore({
      winterHome: h, plugins: { enabled: ["demo"] }, consents: { demo: { exec: Date.now() } },
    }).list()[0]!;
    expect(pluginSpawnEligible(consented)).toBe(true);
    expect(consented.entry).toEqual({ command: "bun", args: ["index.ts"] });
  });
});

describe("loadManifest", () => {
  test("missing winter-plugin.json → legacy:true, no manifest, no log", () => {
    const h = home(); const dir = join(h, "plugins", "x"); mkdirSync(dir, { recursive: true });
    const logs: string[] = [];
    const r = loadManifest(dir, "x", (m) => logs.push(m));
    expect(r).toEqual({ legacy: true });
    expect(logs).toEqual([]);
  });
  test("valid manifest with matching id → legacy:false, manifest returned as-is", () => {
    const h = home();
    const dir = winterPlugin(h, "x", { id: "x", tier: "capability", name: "X Plugin" });
    const logs: string[] = [];
    const r = loadManifest(dir, "x", (m) => logs.push(m));
    expect(r.legacy).toBe(false);
    expect(r.manifest?.id).toBe("x");
    expect(r.manifest?.name).toBe("X Plugin");
    expect(logs).toEqual([]);
  });
  test("mismatched id is coerced to dirName", () => {
    const h = home();
    const dir = winterPlugin(h, "x", { id: "y", tier: "capability" });
    const r = loadManifest(dir, "x", () => {});
    expect(r.manifest?.id).toBe("x");
  });

  test("final-review Fix 3: a pluginId (dirName) containing \"__\" logs a warning — legacy plugin, no manifest required", () => {
    const h = home(); const dir = join(h, "plugins", "foo__evil"); mkdirSync(dir, { recursive: true });
    const logs: string[] = [];
    const r = loadManifest(dir, "foo__evil", (m) => logs.push(m));
    expect(r).toEqual({ legacy: true }); // "__" is a warning, never a hard reject — never bricks the plugin
    expect(logs.some((m) => m.includes("foo__evil") && m.includes("__"))).toBe(true);
  });

  test("final-review Fix 3: a pluginId (dirName) containing \"__\" logs a warning even with a valid manifest", () => {
    const h = home();
    const dir = winterPlugin(h, "foo__evil", { id: "foo__evil", tier: "capability" });
    const logs: string[] = [];
    const r = loadManifest(dir, "foo__evil", (m) => logs.push(m));
    expect(r.legacy).toBe(false);
    expect(logs.some((m) => m.includes("foo__evil"))).toBe(true);
  });

  test("a pluginId (dirName) without \"__\" never logs the collision warning", () => {
    const h = home(); const dir = join(h, "plugins", "sample-echo"); mkdirSync(dir, { recursive: true });
    const logs: string[] = [];
    loadManifest(dir, "sample-echo", (m) => logs.push(m));
    expect(logs).toEqual([]);
  });
});

describe("requiredConsentClasses", () => {
  test("no permissions/contributes/entry → []", () => { expect(requiredConsentClasses(mkManifest())).toEqual([]); });
  test("entry-only → exec", () => {
    expect(requiredConsentClasses(mkManifest({ entry: { command: "node" } }))).toEqual(["exec"]);
  });
  test("mcpServers-only → exec", () => {
    expect(requiredConsentClasses(mkManifest({ contributes: { mcpServers: [{ name: "s", command: "node" }] } }))).toEqual(["exec"]);
  });
  test("hooks-only → exec", () => {
    expect(requiredConsentClasses(mkManifest({ contributes: { hooks: [{ event: "session-start", command: "notify" }] } }))).toEqual(["exec"]);
  });
  test("permissions.exec-only → exec", () => {
    expect(requiredConsentClasses(mkManifest({ permissions: { exec: true } }))).toEqual(["exec"]);
  });
  test("permissions.exec:false with no other exec source → []", () => {
    expect(requiredConsentClasses(mkManifest({ permissions: { exec: false } }))).toEqual([]);
  });
  // CARRIED from T1's review: entry/mcpServers presence is an OR-derivation, not gated by
  // permissions.exec — an author declaring permissions.exec:false cannot suppress the exec
  // consent requirement while also shipping an entry point or mcpServers.
  test("CARRIED: entry present + permissions.exec:false → still requires exec (OR, not AND)", () => {
    expect(requiredConsentClasses(mkManifest({
      entry: { command: "node" }, permissions: { exec: false },
    }))).toEqual(["exec"]);
  });
  test("CARRIED: mcpServers present + permissions.exec:false → still requires exec (OR, not AND)", () => {
    expect(requiredConsentClasses(mkManifest({
      contributes: { mcpServers: [{ name: "s", command: "node" }] }, permissions: { exec: false },
    }))).toEqual(["exec"]);
  });
  test("tcc-only → tcc", () => {
    expect(requiredConsentClasses(mkManifest({ permissions: { tcc: ["accessibility"] } }))).toEqual(["tcc"]);
  });
  test("hardware-only → hardware", () => {
    expect(requiredConsentClasses(mkManifest({ permissions: { hardware: ["battery"] } }))).toEqual(["hardware"]);
  });
  test("empty permission arrays → no class", () => {
    expect(requiredConsentClasses(mkManifest({ permissions: { tcc: [], hardware: [] } }))).toEqual([]);
  });
  test("combination: entry + tcc + hardware → all three, in exec/tcc/hardware order", () => {
    expect(requiredConsentClasses(mkManifest({
      entry: { command: "node" },
      permissions: { tcc: ["screen-recording"], hardware: ["battery"] },
    }))).toEqual(["exec", "tcc", "hardware"]);
  });
});

describe("execPayloadLines", () => {
  test("mcpServers → mcp: <command> <args…> lines", () => {
    expect(execPayloadLines(mkManifest({
      contributes: { mcpServers: [{ name: "srv", command: "node", args: ["server.js", "--port", "1234"] }] },
    }))).toEqual(["mcp: node server.js --port 1234"]);
  });
  test("mcpServer without args → no trailing space", () => {
    expect(execPayloadLines(mkManifest({
      contributes: { mcpServers: [{ name: "srv", command: "node" }] },
    }))).toEqual(["mcp: node"]);
  });
  test("hooks → hook(<event>): <command> lines", () => {
    expect(execPayloadLines(mkManifest({
      contributes: { hooks: [{ event: "pre-tool", command: "guard.sh" }, { event: "turn-end", command: "notify.sh" }] },
    }))).toEqual(["hook(pre-tool): guard.sh", "hook(turn-end): notify.sh"]);
  });
  test("entry → entry: <command> <args…> line", () => {
    expect(execPayloadLines(mkManifest({ entry: { command: "python3", args: ["main.py"] } })))
      .toEqual(["entry: python3 main.py"]);
  });
  test("combination — mcpServers, then hooks, then entry, in that order", () => {
    expect(execPayloadLines(mkManifest({
      contributes: {
        mcpServers: [{ name: "s", command: "node", args: ["s.js"] }],
        hooks: [{ event: "session-start", command: "hi.sh" }],
      },
      entry: { command: "node", args: ["index.js"] },
    }))).toEqual(["mcp: node s.js", "hook(session-start): hi.sh", "entry: node index.js"]);
  });
  test("no exec-class contributes/entry → []", () => { expect(execPayloadLines(mkManifest())).toEqual([]); });
});
