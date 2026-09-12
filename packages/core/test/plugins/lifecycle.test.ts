import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings } from "../../src/settings";
import {
  applyFreshPluginConsent,
  buildConsentBlock,
  deriveInstallName,
  grantPluginConsents,
  installPluginFromDir,
  missingConsents,
  removePluginDir,
  removePluginFromSettings,
  resolvePluginTarget,
  setPluginEnabled,
  stripPluginConsents,
  type ConsentBlockPlugin,
} from "../../src/plugins/lifecycle";

function baseSettings(overrides: Partial<Settings> = {}): Settings {
  return { schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, ...overrides } as Settings;
}

describe("deriveInstallName", () => {
  test("derives from the git URL basename, stripping .git and trailing slashes", () => {
    expect(deriveInstallName("https://example.com/org/my-plugin.git")).toBe("my-plugin");
    expect(deriveInstallName("https://example.com/org/my-plugin.git/")).toBe("my-plugin");
    expect(deriveInstallName("/local/path/to/plugin")).toBe("plugin");
  });
  test("an explicit override wins over the derived name", () => {
    expect(deriveInstallName("https://example.com/org/my-plugin.git", "custom")).toBe("custom");
  });
});

describe("resolvePluginTarget (path containment)", () => {
  const root = "/tmp/winter-plugins-root";
  test("a plain name resolves under the root", () => {
    expect(resolvePluginTarget(root, "demo")).toBe(join(root, "demo"));
  });
  test("traversal names are refused", () => {
    expect(() => resolvePluginTarget(root, "../x")).toThrow(/invalid plugin name/);
    expect(() => resolvePluginTarget(root, "../../etc")).toThrow(/invalid plugin name/);
  });
  test("an absolute path escaping the root is refused", () => {
    expect(() => resolvePluginTarget(root, "/etc/passwd")).toThrow(/invalid plugin name/);
  });
  test("the empty name or the root itself is refused", () => {
    expect(() => resolvePluginTarget(root, "")).toThrow(/invalid plugin name/);
    expect(() => resolvePluginTarget(root, ".")).toThrow(/invalid plugin name/);
  });
});

/** A local plugin directory (manifest + a trivial skill), suitable for `installPluginFromDir`. */
function makePluginFixtureDir(opts: { manifest?: "winter-plugin.json" | "plugin.json" | "none" } = {}): string {
  const src = mkdtempSync(join(tmpdir(), "winter-plugin-src-"));
  mkdirSync(join(src, "skills", "greet"), { recursive: true });
  writeFileSync(join(src, "skills", "greet", "SKILL.md"), "---\nname: greet\ndescription: hi\n---\nbody");
  const manifest = opts.manifest ?? "winter-plugin.json";
  if (manifest === "winter-plugin.json") {
    writeFileSync(join(src, "winter-plugin.json"), JSON.stringify({ id: "demo", version: "1.0.0" }));
  } else if (manifest === "plugin.json") {
    writeFileSync(join(src, "plugin.json"), JSON.stringify({ name: "demo", version: "1.0.0" }));
  }
  return src;
}

describe("installPluginFromDir", () => {
  test("copies a fixture dir with a winter-plugin.json manifest into <pluginsRoot>/<name>; never touches settings", () => {
    const src = makePluginFixtureDir();
    const pluginsRoot = mkdtempSync(join(tmpdir(), "winter-plugins-root-"));

    const result = installPluginFromDir(src, "demo", pluginsRoot);

    expect(result).toEqual({ name: "demo", target: join(pluginsRoot, "demo") });
    expect(existsSync(join(result.target, "winter-plugin.json"))).toBe(true);
    expect(existsSync(join(result.target, "skills", "greet", "SKILL.md"))).toBe(true);
  });

  test("copies a fixture dir with a legacy plugin.json manifest too", () => {
    const src = makePluginFixtureDir({ manifest: "plugin.json" });
    const pluginsRoot = mkdtempSync(join(tmpdir(), "winter-plugins-root-"));

    const result = installPluginFromDir(src, "demo", pluginsRoot);

    expect(existsSync(join(result.target, "plugin.json"))).toBe(true);
  });

  test("refuses a traversal name before copying anything", () => {
    const src = makePluginFixtureDir();
    const pluginsRoot = mkdtempSync(join(tmpdir(), "winter-plugins-root-"));

    expect(() => installPluginFromDir(src, "../escaped", pluginsRoot)).toThrow(/invalid plugin name/);
    expect(existsSync(join(pluginsRoot, "..", "escaped"))).toBe(false);
  });

  test("refuses when the target already exists", () => {
    const src = makePluginFixtureDir();
    const pluginsRoot = mkdtempSync(join(tmpdir(), "winter-plugins-root-"));
    mkdirSync(join(pluginsRoot, "demo"), { recursive: true });

    expect(() => installPluginFromDir(src, "demo", pluginsRoot)).toThrow(/already exists/);
  });

  test("refuses a sourceDir with no manifest (neither winter-plugin.json nor plugin.json)", () => {
    const src = makePluginFixtureDir({ manifest: "none" });
    const pluginsRoot = mkdtempSync(join(tmpdir(), "winter-plugins-root-"));

    expect(() => installPluginFromDir(src, "demo", pluginsRoot)).toThrow(/no winter-plugin\.json or plugin\.json/);
    expect(existsSync(join(pluginsRoot, "demo"))).toBe(false);
  });
});

describe("setPluginEnabled (fresh-consent rule)", () => {
  test("enable adds to enabled and ensures it's not in disabled", () => {
    const s = setPluginEnabled(baseSettings({ plugins: { enabled: [], disabled: ["demo"] } }), "demo", true);
    expect(s.plugins?.enabled).toEqual(["demo"]);
    expect(s.plugins?.disabled).toEqual([]);
  });
  test("disable adds to disabled and removes from enabled — re-enabling later requires a fresh `enable`", () => {
    let s = setPluginEnabled(baseSettings(), "demo", true);
    expect(s.plugins?.enabled).toEqual(["demo"]);
    s = setPluginEnabled(s, "demo", false);
    expect(s.plugins?.enabled).toEqual([]);
    expect(s.plugins?.disabled).toEqual(["demo"]);
  });
  test("starting from settings with no `plugins` key at all still works", () => {
    const s = setPluginEnabled(baseSettings(), "demo", true);
    expect(s.plugins).toEqual({ enabled: ["demo"], disabled: [] });
  });
  test("Task 3: preserves plugins.consents untouched (previously silently dropped)", () => {
    const s = setPluginEnabled(
      baseSettings({ plugins: { enabled: [], disabled: [], consents: { demo: { exec: 1000 }, other: { tcc: 2000 } } } }),
      "demo",
      true,
    );
    expect(s.plugins?.enabled).toEqual(["demo"]);
    expect(s.plugins?.consents).toEqual({ demo: { exec: 1000 }, other: { tcc: 2000 } });
  });
});

describe("missingConsents", () => {
  test("nothing required → []", () => { expect(missingConsents([], [])).toEqual([]); });
  test("nothing consented → all required are missing", () => {
    expect(missingConsents(["exec", "tcc"], [])).toEqual(["exec", "tcc"]);
  });
  test("partial consent → only the ungranted classes", () => {
    expect(missingConsents(["exec", "tcc"], ["exec"])).toEqual(["tcc"]);
  });
  test("fully consented → []", () => {
    expect(missingConsents(["exec", "tcc"], ["exec", "tcc"])).toEqual([]);
  });
  test("unrelated extra consented classes don't matter", () => {
    expect(missingConsents(["tcc"], ["exec", "tcc", "hardware"])).toEqual([]);
  });
});

describe("applyFreshPluginConsent (final-review fix: consent write reads settings fresh, not the pre-prompt snapshot)", () => {
  test("applies grant + enable to whatever readSettings() returns at call time — a concurrent edit survives", () => {
    // Simulates the real bug's shape: the CLI's pre-prompt `loadSettings()` result is never passed
    // to this function at all — the ONLY settings source is readSettings(), invoked after "yes".
    // Here readSettings() stands in for a settings.json that picked up a concurrent edit (a
    // DIFFERENT plugin, `other`, got enabled + consented) during the prompt's human-scale wait.
    const freshAtWriteTime = baseSettings({
      plugins: { enabled: ["other"], consents: { other: { exec: 111 } } },
    });
    let reads = 0;
    const readSettings = () => { reads++; return freshAtWriteTime; };

    const result = applyFreshPluginConsent(readSettings, "demo", ["exec"], 999);

    expect(reads).toBe(1); // read exactly once, at write time
    // The concurrent edit (other's enabled state + consent) survives in the result — proving the
    // write was built on the fresh read, not on some snapshot taken before the prompt.
    expect(result.plugins?.enabled?.sort()).toEqual(["demo", "other"]);
    expect(result.plugins?.consents).toEqual({ other: { exec: 111 }, demo: { exec: 999 } });
  });

  test("grants every listed class and flips mcpEnabled, same as grantPluginConsents + setPluginEnabled composed directly", () => {
    const settings = baseSettings({ plugins: { consents: { demo: { exec: 1000 } } } });
    const result = applyFreshPluginConsent(() => settings, "demo", ["exec", "tcc"], 5000);
    expect(result.plugins?.consents).toEqual({ demo: { exec: 5000, tcc: 5000 } });
    expect(result.plugins?.enabled).toEqual(["demo"]);
  });
});

describe("buildConsentBlock (exact strings — spec §1: full exec-payload disclosure)", () => {
  function mkInfo(overrides: Partial<ConsentBlockPlugin> = {}): ConsentBlockPlugin {
    return { name: "demo", requiredConsents: [], execPayload: [], tccPermissions: [], hardwarePermissions: [], ...overrides };
  }

  test("no required consents → header only", () => {
    expect(buildConsentBlock(mkInfo())).toEqual(["plugin demo requests:"]);
  });

  test("exec only → header + every execPayload line verbatim, no extra prefix", () => {
    expect(buildConsentBlock(mkInfo({
      requiredConsents: ["exec"],
      execPayload: ["mcp: node server.js --port 1234", "hook(pre-tool): guard.sh", "entry: node index.js"],
    }))).toEqual([
      "plugin demo requests:",
      "mcp: node server.js --port 1234",
      "hook(pre-tool): guard.sh",
      "entry: node index.js",
    ]);
  });

  test("tcc only → header + one 'will request macOS permission: <perm>' line per entry", () => {
    expect(buildConsentBlock(mkInfo({
      requiredConsents: ["tcc"],
      tccPermissions: ["accessibility", "screen-recording"],
    }))).toEqual([
      "plugin demo requests:",
      "will request macOS permission: accessibility",
      "will request macOS permission: screen-recording",
    ]);
  });

  test("hardware only → header + one 'hardware access via Winter.app helper: <perm>' line per entry", () => {
    expect(buildConsentBlock(mkInfo({
      requiredConsents: ["hardware"],
      hardwarePermissions: ["battery"],
    }))).toEqual([
      "plugin demo requests:",
      "hardware access via Winter.app helper: battery",
    ]);
  });

  test("exec + tcc + hardware combo → fixed exec, tcc, hardware order regardless of requiredConsents order", () => {
    expect(buildConsentBlock(mkInfo({
      name: "kitchen-sink",
      requiredConsents: ["hardware", "exec", "tcc"], // deliberately out of order — output order is NOT input order
      execPayload: ["mcp: node s.js"],
      tccPermissions: ["input-monitoring"],
      hardwarePermissions: ["battery"],
    }))).toEqual([
      "plugin kitchen-sink requests:",
      "mcp: node s.js",
      "will request macOS permission: input-monitoring",
      "hardware access via Winter.app helper: battery",
    ]);
  });

  test("a required class with no display entries contributes no lines (defensive — shouldn't happen in practice)", () => {
    expect(buildConsentBlock(mkInfo({ requiredConsents: ["exec", "tcc"], execPayload: [], tccPermissions: [] })))
      .toEqual(["plugin demo requests:"]);
  });
});

describe("grantPluginConsents", () => {
  test("writes a fresh timestamp for every listed class", () => {
    const s = grantPluginConsents(baseSettings(), "demo", ["exec", "tcc"], 5000);
    expect(s.plugins?.consents).toEqual({ demo: { exec: 5000, tcc: 5000 } });
  });
  test("merges with this plugin's already-granted classes rather than clobbering them", () => {
    const s = grantPluginConsents(
      baseSettings({ plugins: { consents: { demo: { exec: 1000 } } } }),
      "demo",
      ["tcc"],
      2000,
    );
    expect(s.plugins?.consents).toEqual({ demo: { exec: 1000, tcc: 2000 } });
  });
  test("leaves OTHER plugins' consent records untouched", () => {
    const s = grantPluginConsents(
      baseSettings({ plugins: { consents: { other: { exec: 111 } } } }),
      "demo",
      ["exec"],
      222,
    );
    expect(s.plugins?.consents).toEqual({ other: { exec: 111 }, demo: { exec: 222 } });
  });
  test("re-granting an already-consented class overwrites the timestamp", () => {
    const s = grantPluginConsents(
      baseSettings({ plugins: { consents: { demo: { exec: 1000 } } } }),
      "demo",
      ["exec"],
      9999,
    );
    expect(s.plugins?.consents).toEqual({ demo: { exec: 9999 } });
  });
  test("empty classes list → an (empty) record is still created for the plugin", () => {
    const s = grantPluginConsents(baseSettings(), "demo", [], 1);
    expect(s.plugins?.consents).toEqual({ demo: {} });
  });
});

describe("stripPluginConsents (disable = fresh-consent semantics)", () => {
  test("deletes the plugin's whole consent record", () => {
    const s = stripPluginConsents(baseSettings({ plugins: { consents: { demo: { exec: 1, tcc: 2 } } } }), "demo");
    expect(s.plugins?.consents).toEqual({});
  });
  test("leaves OTHER plugins' consent records untouched", () => {
    const s = stripPluginConsents(
      baseSettings({ plugins: { consents: { demo: { exec: 1 }, other: { tcc: 2 } } } }),
      "demo",
    );
    expect(s.plugins?.consents).toEqual({ other: { tcc: 2 } });
  });
  test("a no-op (same reference) when there's nothing to strip", () => {
    const s = baseSettings({ plugins: { enabled: ["demo"] } });
    expect(stripPluginConsents(s, "demo")).toBe(s);
  });
  test("a no-op when settings has no plugins key at all", () => {
    const s = baseSettings();
    expect(stripPluginConsents(s, "demo")).toBe(s);
  });
});

describe("removePluginFromSettings", () => {
  test("strips the name from both enabled and disabled lists", () => {
    const s = removePluginFromSettings(baseSettings({ plugins: { enabled: ["a", "demo"], disabled: ["demo", "b"] } }), "demo");
    expect(s.plugins).toEqual({ enabled: ["a"], disabled: ["b"] });
  });
  test("a no-op when settings has no plugins key", () => {
    const s = baseSettings();
    expect(removePluginFromSettings(s, "demo")).toBe(s);
  });
  test("removing A leaves B's consents intact", () => {
    const s = removePluginFromSettings(
      baseSettings({ plugins: { enabled: ["demo"], disabled: [], consents: { demo: { exec: 1000 }, other: { tcc: 2000 } } } }),
      "demo",
    );
    expect(s.plugins?.consents?.other).toEqual({ tcc: 2000 });
  });
  test("removing A deletes A's consent record", () => {
    const s = removePluginFromSettings(
      baseSettings({ plugins: { enabled: ["demo"], disabled: [], consents: { demo: { exec: 1000 }, other: { tcc: 2000 } } } }),
      "demo",
    );
    expect(s.plugins?.consents?.demo).toBeUndefined();
  });
});

describe("removePluginDir", () => {
  test("deletes an existing plugin directory and returns its path", () => {
    const pluginsRoot = mkdtempSync(join(tmpdir(), "winter-plugins-root-"));
    const dir = join(pluginsRoot, "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), "{}");
    const removed = removePluginDir(pluginsRoot, "demo");
    expect(removed).toBe(join(pluginsRoot, "demo"));
    expect(existsSync(dir)).toBe(false);
  });
  test("a traversal name is refused", () => {
    const pluginsRoot = mkdtempSync(join(tmpdir(), "winter-plugins-root-"));
    expect(() => removePluginDir(pluginsRoot, "../x")).toThrow(/invalid plugin name/);
  });
  test("a nonexistent (but validly-scoped) name is refused", () => {
    const pluginsRoot = mkdtempSync(join(tmpdir(), "winter-plugins-root-"));
    expect(() => removePluginDir(pluginsRoot, "ghost")).toThrow(/no such plugin/);
  });
});
