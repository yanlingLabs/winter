// `plugins/plugin-manager.ts`'s one list-side policy over the agent SDK's `listPlugins`: a record whose
// scope the caller's `settingsPathFor` cannot resolve (it throws for project/local with no cwd) reads
// as NOT enabled instead of failing the whole list. Mutations keep the throw — that is the refusal.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@yanlinglabs/winter-agent-sdk";
import { addMarketplace, installPlugin, listPlugins, setPluginEnabled, type PluginManagerOptions, type PluginScope } from "../../src/plugins/plugin-manager";

const tmp = (p: string): string => realpathSync(mkdtempSync(join(tmpdir(), p)));

async function homeWithProjectAndUserInstall(): Promise<{ withCwd: PluginManagerOptions; noCwd: PluginManagerOptions }> {
  const winterHome = tmp("winter-pm-list-home-");
  const project = tmp("winter-pm-list-project-");
  const mkt = tmp("winter-pm-list-mkt-");
  mkdirSync(join(mkt, ".claude-plugin"), { recursive: true });
  writeFileSync(join(mkt, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "m", owner: { name: "test" }, plugins: [{ name: "p", source: "." }] }));
  const pluginsRoot = join(winterHome, "sdk", "plugins");
  const userSettings = join(winterHome, "sdk", "settings.json");
  const withCwd: PluginManagerOptions = {
    pluginsRoot,
    settingsPathFor: (scope: PluginScope) => (scope === "user" ? userSettings : join(project, ".winter", scope === "local" ? "settings.local.json" : "settings.json")),
  };
  const noCwd: PluginManagerOptions = {
    pluginsRoot,
    settingsPathFor: (scope: PluginScope) => {
      if (scope === "user") return userSettings;
      throw new Error(`scope ${scope} needs a cwd`);
    },
  };
  await addMarketplace(withCwd, mkt);
  await installPlugin(withCwd, "p@m", "project");
  await installPlugin(withCwd, "p@m", "user");
  return { withCwd, noCwd };
}

describe("plugin-manager listPlugins: an unresolvable scope reads as not enabled", () => {
  test("the SDK's own listPlugins throws on it (why the tolerance exists)", async () => {
    const { noCwd } = await homeWithProjectAndUserInstall();
    await expect(sdk.listPlugins(noCwd)).rejects.toThrow("needs a cwd");
  });

  test("the daemon's list keeps every record: the resolvable scope as stored, the other not enabled", async () => {
    const { withCwd, noCwd } = await homeWithProjectAndUserInstall();
    expect((await listPlugins(withCwd)).map((p) => [p.scope, p.enabled]).sort()).toEqual([["project", true], ["user", true]]);
    expect((await listPlugins(noCwd)).map((p) => [p.scope, p.enabled]).sort()).toEqual([["project", false], ["user", true]]);
  });

  test("a mutation at the unresolvable scope still refuses", async () => {
    const { noCwd } = await homeWithProjectAndUserInstall();
    await expect(setPluginEnabled(noCwd, "p@m", "project", false)).rejects.toThrow("needs a cwd");
  });
});
