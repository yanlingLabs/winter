import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  installNeedsConsentHint,
  installPlugin,
  revokePluginTokenBestEffort,
} from "../src/plugin-cli";

/** A local git repo with a minimal plugin layout, suitable for `git clone` off a plain path. */
function makePluginFixtureRepo(): string {
  const src = mkdtempSync(join(tmpdir(), "winter-plugin-src-"));
  mkdirSync(join(src, "skills", "greet"), { recursive: true });
  writeFileSync(join(src, "skills", "greet", "SKILL.md"), "---\nname: greet\ndescription: hi\n---\nbody");
  writeFileSync(join(src, "plugin.json"), JSON.stringify({ name: "ignored-manifest-name", version: "1.0.0" }));
  writeFileSync(join(src, ".mcp.json"), JSON.stringify({ mcpServers: { fake: { command: "true" } } }));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com" };
  Bun.spawnSync(["git", "init", "-q"], { cwd: src, env });
  Bun.spawnSync(["git", "add", "-A"], { cwd: src, env });
  const commit = Bun.spawnSync(["git", "commit", "-q", "-m", "init"], { cwd: src, env });
  if (commit.exitCode !== 0) throw new Error(`fixture commit failed: ${commit.stderr.toString()}`);
  return src;
}

describe("installPlugin", () => {
  test("clones a local fixture repo into <pluginsRoot>/<name>; a second install of the same name is refused", () => {
    const repo = makePluginFixtureRepo();
    const pluginsRoot = mkdtempSync(join(tmpdir(), "winter-plugins-root-"));

    const result = installPlugin({ url: repo, pluginsRoot });
    expect(result.name).toBe(basename(repo)); // derived from the repo's dirname (no override given)
    expect(existsSync(join(result.target, "skills", "greet", "SKILL.md"))).toBe(true);
    expect(existsSync(join(result.target, ".mcp.json"))).toBe(true);

    expect(() => installPlugin({ url: repo, name: result.name, pluginsRoot })).toThrow(/already exists/);
  });

  test("an explicit name is honored and NEVER touches settings.json", () => {
    const repo = makePluginFixtureRepo();
    const pluginsRoot = mkdtempSync(join(tmpdir(), "winter-plugins-root-"));
    const settingsPath = join(pluginsRoot, "..", "settings.json"); // sibling of pluginsRoot, mirrors ~/.winter layout

    const result = installPlugin({ url: repo, name: "demo", pluginsRoot });
    expect(result.name).toBe("demo");
    expect(existsSync(join(pluginsRoot, "demo"))).toBe(true);
    expect(existsSync(settingsPath)).toBe(false); // install created no settings file at all
  });

  test("a traversal name is refused before any clone is attempted", () => {
    const repo = makePluginFixtureRepo();
    const pluginsRoot = mkdtempSync(join(tmpdir(), "winter-plugins-root-"));
    expect(() => installPlugin({ url: repo, name: "../escaped", pluginsRoot })).toThrow(/invalid plugin name/);
    expect(existsSync(join(pluginsRoot, "..", "escaped"))).toBe(false);
  });
});

describe("installNeedsConsentHint (final-review fix: manifest-only install disclosure)", () => {
  test("neither hasMcp nor requiredConsents → no hint (legacy plugin, no MCP at all)", () => {
    expect(installNeedsConsentHint({ hasMcp: false, requiredConsents: [] })).toBe(false);
  });
  test("legacy .mcp.json plugin (hasMcp true, no manifest) → hint", () => {
    expect(installNeedsConsentHint({ hasMcp: true, requiredConsents: [] })).toBe(true);
  });
  test("manifest-only plugin (contributes.mcpServers, no .mcp.json) → hasMcp false but requiredConsents non-empty → hint", () => {
    // This is exactly the gap the fix closes: a manifest plugin with contributes.mcpServers and
    // no .mcp.json file has hasMcp:false, so checking hasMcp alone (the pre-fix behavior) printed
    // nothing — the plugin installed with zero mention of the code it can execute.
    expect(installNeedsConsentHint({ hasMcp: false, requiredConsents: ["exec"] })).toBe(true);
  });
  test("manifest requiring only tcc/hardware (no exec) still hints — any consent-gated content counts", () => {
    expect(installNeedsConsentHint({ hasMcp: false, requiredConsents: ["tcc"] })).toBe(true);
    expect(installNeedsConsentHint({ hasMcp: false, requiredConsents: ["hardware"] })).toBe(true);
  });
  test("both hasMcp and requiredConsents present → still just true (no double-counting concern)", () => {
    expect(installNeedsConsentHint({ hasMcp: true, requiredConsents: ["exec"] })).toBe(true);
  });
});

// Phase 4b Task 2: disable/remove's best-effort daemon-side token revoke. `revoke` is injected
// (see plugin-cli.ts) so this stays a pure unit test — no real socket/daemon involved.
describe("revokePluginTokenBestEffort", () => {
  test("a successful revoke resolves ok:true with no note", async () => {
    const calls: string[] = [];
    const result = await revokePluginTokenBestEffort(async (pluginId) => { calls.push(pluginId); }, "demo");
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(["demo"]);
  });

  test("a rejected revoke (daemon down, timeout, etc.) is tolerated: ok:false with a note, never throws", async () => {
    const result = await revokePluginTokenBestEffort(async () => { throw new Error("connect ECONNREFUSED"); }, "demo");
    expect(result.ok).toBe(false);
    expect(result.note).toContain("connect ECONNREFUSED");
  });
});
