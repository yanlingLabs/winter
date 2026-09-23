// Post-merge round: installing/enabling/disabling a plugin at LOCAL scope writes
// `<root>/.winter/settings.local.json` -- a personal overlay, never meant to be committed (claude
// parity, F21). `plugins/sdk-plugin-api.ts#setEnabledInSettings` (the one shared write path
// install/uninstall/enable/disable all funnel through) now calls `ensureGlobalGitExclude` right
// after that write, exactly like `agent/saved-answers.ts` does for its own
// `.winter/settings.local.json` writes (L3's own precedent). `project` scope (`.winter/settings.json`,
// team-shared, meant to be committed) and `user` scope (never touches the project's git tree at all)
// must NOT trigger it.
//
// Every test sandboxes HOME/XDG_CONFIG_HOME/GIT_CONFIG_GLOBAL exactly like
// agent/git-exclude.test.ts does -- the developer's own real global git config is never read or
// written.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_SETTINGS_EXCLUDE } from "../../src/agent/git-exclude";
import { addMarketplace, installPlugin, setPluginEnabled, uninstallPlugin, type PluginManagerOptions } from "../../src/plugins/sdk-plugin-api";

const tmp = (p: string): string => realpathSync(mkdtempSync(join(tmpdir(), p)));
const ENV_KEYS = ["HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL"] as const;
let saved: Record<string, string | undefined> = {};
let home: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  home = tmp("winter-gitx-plugin-home-");
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  process.env.GIT_CONFIG_GLOBAL = join(home, ".gitconfig");
  writeFileSync(join(home, ".gitconfig"), "");
});
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

function repo(): string {
  const dir = tmp("winter-gitx-plugin-repo-");
  const p = Bun.spawnSync(["git", "-C", dir, "init", "-q"], { env: process.env });
  if (p.exitCode !== 0) throw new Error("git init failed");
  return dir;
}

const excludeLines = (): string[] => {
  const path = join(home, ".config", "git", "ignore");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
};

/** A one-plugin directory marketplace, registered under `winterHome`; returns the spec to install. */
async function registerOnePlugin(winterHome: string): Promise<{ options: PluginManagerOptions; spec: string }> {
  const mktDir = tmp("winter-gitx-plugin-mkt-");
  mkdirSync(join(mktDir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(mktDir, ".claude-plugin", "marketplace.json"), JSON.stringify({
    name: "m", owner: { name: "test" }, plugins: [{ name: "p", source: "." }],
  }));
  writeFileSync(join(mktDir, "winter-plugin.json"), JSON.stringify({ id: "p", tier: "capability" }));
  const pluginsRoot = join(winterHome, "sdk", "plugins");
  const options: PluginManagerOptions = {
    pluginsRoot,
    settingsPathFor: (scope) => {
      if (scope === "user") return join(winterHome, "sdk", "settings.json");
      throw new Error("this test always threads a project-scoped settingsPathFor directly");
    },
  };
  await addMarketplace(options, mktDir);
  return { options, spec: "p@m" };
}

describe("plugins/sdk-plugin-api.ts: local scope writes trigger ensureGlobalGitExclude, project/user never do", () => {
  test("installPlugin at LOCAL scope (inside a git repo) appends the exclude pattern", async () => {
    const winterHome = tmp("winter-gitx-plugin-wh-");
    const root = repo();
    const { options: base, spec } = await registerOnePlugin(winterHome);
    const options: PluginManagerOptions = {
      ...base,
      settingsPathFor: (scope) => scope === "local" ? join(root, ".winter", "settings.local.json") : base.settingsPathFor(scope),
    };

    await installPlugin(options, spec, "local");

    expect(excludeLines()).toEqual([LOCAL_SETTINGS_EXCLUDE]);
  });

  test("setPluginEnabled/uninstallPlugin at LOCAL scope also trigger it (idempotent — one line, however many calls)", async () => {
    const winterHome = tmp("winter-gitx-plugin-wh-");
    const root = repo();
    const { options: base, spec } = await registerOnePlugin(winterHome);
    const options: PluginManagerOptions = {
      ...base,
      settingsPathFor: (scope) => scope === "local" ? join(root, ".winter", "settings.local.json") : base.settingsPathFor(scope),
    };
    await installPlugin(options, spec, "local");
    await setPluginEnabled(options, spec, "local", false);
    await setPluginEnabled(options, spec, "local", true);
    await uninstallPlugin(options, spec, "local");

    expect(excludeLines()).toEqual([LOCAL_SETTINGS_EXCLUDE]);
  });

  test("installPlugin at USER scope never touches the project's git tree — no exclude write at all", async () => {
    const winterHome = tmp("winter-gitx-plugin-wh-");
    repo(); // a real repo exists, but user scope never resolves against it
    const { options, spec } = await registerOnePlugin(winterHome);

    await installPlugin(options, spec, "user");

    expect(excludeLines()).toEqual([]);
  });

  test("installPlugin at PROJECT scope (team-shared .winter/settings.json) never excludes it", async () => {
    const winterHome = tmp("winter-gitx-plugin-wh-");
    const root = repo();
    const { options: base, spec } = await registerOnePlugin(winterHome);
    const options: PluginManagerOptions = {
      ...base,
      settingsPathFor: (scope) => scope === "project" ? join(root, ".winter", "settings.json") : base.settingsPathFor(scope),
    };

    await installPlugin(options, spec, "project");

    expect(excludeLines()).toEqual([]);
  });
});
