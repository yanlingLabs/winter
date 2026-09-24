// WS-21 L3.7 (spec §4.1, §4.2, §8): the settings split — the runtime-facing keys of `settings.json`
// copied ONCE into the shared runtime home's claude-format files. It runs automatically at every boot on
// every home and build (L3.2 already reads those keys from `sdk/` only), and as Migration C's step 5.
//
//   copy a key only when (a) settings.json states it, (b) the per-key marker has not recorded it, and
//   (c) the sdk file does not hold it yet — so a key the user later deletes from sdk/ is never re-copied.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitSettingsToSdk, settingsSplitMarkerPath } from "../../src/migration/settings-split";
import { readSdkGlobalConfig, readSdkSettings, updateSdkSettings } from "../../src/sdk-files";

function home(settings?: Record<string, unknown>): string {
  const h = mkdtempSync(join(tmpdir(), "winter-split-"));
  mkdirSync(join(h, "sdk"), { recursive: true });
  if (settings !== undefined) writeFileSync(join(h, "settings.json"), JSON.stringify({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" }, ...settings }));
  return h;
}

describe("splitSettingsToSdk", () => {
  test("every moved key lands in its claude-format home; settings.json is never modified", () => {
    const h = home({
      permissions: { allow: ["Bash(git status)", "Edit", "Computer", "WebFetch(domain:docs.x.com)"], deny: ["Skill(noisy)"], additionalDirectories: ["/data"], dangerousDomains: { added: ["evil.test"] } },
      outputStyle: "terse",
      memory: { enabled: false, directory: "/mem" },
      mcpServers: { local: { type: "stdio", command: "node", args: ["s.js"] }, remote: { type: "http", url: "https://m.test/mcp", headers: { Authorization: "Bearer secret", "X-Team": "t" } } },
    });
    const before = readFileSync(join(h, "settings.json"), "utf8");
    const report = splitSettingsToSdk(h);
    const sdk = readSdkSettings(h) as Record<string, any>;
    expect(sdk.permissions.allow).toEqual(["Bash(git status)", "Edit", "Write", "mcp__winter__computer__computer", "WebFetch(domain:docs.x.com)"]);
    expect(sdk.permissions.deny).toEqual(["Skill(noisy)"]);
    expect(sdk.permissions.additionalDirectories).toEqual(["/data"]);
    expect(sdk.permissions.dangerousDomains).toBeUndefined(); // stays in settings.json
    expect(sdk.outputStyle).toBe("terse");
    expect(sdk.autoMemoryEnabled).toBe(false);
    expect(sdk.autoMemoryDirectory).toBe("/mem");
    const cfg = readSdkGlobalConfig(h) as Record<string, any>;
    expect(cfg.mcpServers.local).toEqual({ type: "stdio", command: "node", args: ["s.js"] });
    // a credential-shaped header is never copied (secrets never on disk in a model-readable file)
    expect(cfg.mcpServers.remote.headers).toEqual({ "X-Team": "t" });
    expect(JSON.stringify(cfg)).not.toContain("secret");
    expect([...report.copied].sort() as string[]).toEqual(["mcpServers", "memory.directory", "memory.enabled", "outputStyle", "permissions.additionalDirectories", "permissions.allow", "permissions.deny"].sort());
    expect(readFileSync(join(h, "settings.json"), "utf8")).toBe(before);
  });

  test("idempotent, and a key the user deleted from sdk/ is NOT re-copied (the per-key marker)", () => {
    const h = home({ outputStyle: "terse", permissions: { allow: ["Bash(ls)"] } });
    splitSettingsToSdk(h);
    const second = splitSettingsToSdk(h);
    expect(second.copied).toEqual([]);
    updateSdkSettings(h, (cur) => { const { outputStyle: _o, ...rest } = cur as Record<string, unknown>; return rest; });
    const third = splitSettingsToSdk(h);
    expect(third.copied).toEqual([]);
    expect((readSdkSettings(h) as Record<string, unknown>).outputStyle).toBeUndefined();
    expect(JSON.parse(readFileSync(settingsSplitMarkerPath(h), "utf8")).keys).toHaveProperty("outputStyle");
  });

  test("an sdk file that already states a key wins — never overwritten, and marked", () => {
    const h = home({ outputStyle: "terse" });
    updateSdkSettings(h, (cur) => ({ ...cur, outputStyle: "explanatory" }));
    const r = splitSettingsToSdk(h);
    expect(r.copied).toEqual([]);
    expect(r.alreadyPresent).toContain("outputStyle");
    expect((readSdkSettings(h) as Record<string, unknown>).outputStyle).toBe("explanatory");
  });

  test("untranslatable allow rules are archived to migration/c-<ts>/untranslated-rules.json, never widened", () => {
    const h = home({ permissions: { allow: ["Bash(rm *)", "Edit(/data)", "WebFetch", "Bash(ls)"] } });
    const r = splitSettingsToSdk(h, { now: () => new Date("2026-09-23T10:00:00Z") });
    expect((readSdkSettings(h) as Record<string, any>).permissions.allow).toEqual(["Bash(ls)"]);
    expect(r.untranslated.sort()).toEqual(["Bash(rm *)", "Edit(/data)", "WebFetch"].sort());
    expect(r.untranslatedFile).toBeDefined();
    expect(JSON.parse(readFileSync(r.untranslatedFile!, "utf8")).rules.sort()).toEqual(r.untranslated.sort());
    expect(r.untranslatedFile!.startsWith(join(h, "migration", "c-"))).toBe(true);
  });

  test("the [\"Computer\"] default is written only when a settings.json exists and states NO allow (not [])", () => {
    const absent = home({});
    splitSettingsToSdk(absent);
    expect((readSdkSettings(absent) as Record<string, any>).permissions.allow).toEqual(["mcp__winter__computer__computer"]);
    const empty = home({ permissions: { allow: [] } });
    splitSettingsToSdk(empty);
    expect((readSdkSettings(empty) as Record<string, any>).permissions.allow).toEqual([]);
    const fresh = home(); // no settings.json at all: nothing is written
    const r = splitSettingsToSdk(fresh);
    expect(r.copied).toEqual([]);
    expect(existsSync(join(fresh, "sdk", "settings.json"))).toBe(false);
  });

  test("the plugin pair is left to the plugin lane (L4), and the keys that stay are never copied", () => {
    const h = home({ plugins: { enabled: ["p"], disabled: ["q"] }, mcp: { disabled: ["x"] }, hooks: { enabled: true } });
    splitSettingsToSdk(h);
    const sdk = readSdkSettings(h) as Record<string, unknown>;
    expect(sdk.enabledPlugins).toBeUndefined();
    expect(sdk.mcp).toBeUndefined();
    expect(sdk.hooks).toBeUndefined();
  });

  test("an unparseable settings.json or sdk file copies nothing and throws nothing", () => {
    const h = home();
    writeFileSync(join(h, "settings.json"), "{ nope");
    expect(splitSettingsToSdk(h).copied).toEqual([]);
    const h2 = home({ outputStyle: "terse" });
    writeFileSync(join(h2, "sdk", "settings.json"), "{ broken");
    const r = splitSettingsToSdk(h2);
    expect(r.copied).toEqual([]);
    expect(readFileSync(join(h2, "sdk", "settings.json"), "utf8")).toBe("{ broken"); // never clobbered
    expect(existsSync(join(h2, "migration")) ? readdirSync(join(h2, "migration")) : []).not.toContain("settings-split.json");
  });
});
