// WS-21 (spec §5.2): `winter plugin` = `claude plugin`, over Contract B. Covers the CLI-LAYER
// concerns unique to this file — scope parsing, the door-vs-adapter branch (a fake door stands in
// for the daemon), and the "install from a folder" convenience's daemon-path two-step
// (marketplace.add then install, resolved off the CLI's OWN filesystem read of the folder). The
// underlying Contract B write discipline (installed_plugins.json, enabledPlugins, …) is already
// covered in packages/core's test/plugins/ws21-plugins.test.ts and test/ipc/plugin-rpc.test.ts;
// this file does not re-prove it.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensurePluginScope,
  pluginManagerOptionsFor,
  revokePluginTokenBestEffort,
  runPluginInstallRoute,
  runPluginListRoute,
  runPluginMarketplaceAddRoute,
  runPluginMarketplaceListRoute,
  runPluginMarketplaceRemoveRoute,
  runPluginMarketplaceUpdateRoute,
  runPluginSetEnabledRoute,
  runPluginUninstallRoute,
  renderPluginInstallOutcome,
  renderPluginListOutcome,
  type PluginDoor,
  type PluginRouteDeps,
} from "../src/plugin-cli";

function writeMarketplace(dir: string, plugins: Array<{ name: string; source: string; version?: string }>): void {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "m", owner: { name: "t" }, plugins }));
}

describe("ensurePluginScope", () => {
  test("no flag defaults to user", () => { expect(ensurePluginScope(undefined)).toEqual({ kind: "ok", scope: "user" }); });
  test("user/project/local are all accepted", () => {
    expect(ensurePluginScope("user")).toEqual({ kind: "ok", scope: "user" });
    expect(ensurePluginScope("project")).toEqual({ kind: "ok", scope: "project" });
    expect(ensurePluginScope("local")).toEqual({ kind: "ok", scope: "local" });
  });
  test("an unrecognized scope is refused typed", () => {
    expect(ensurePluginScope("nope").kind).toBe("invalid");
  });
});

// R.3 I-2: the no-daemon path writes the LOCAL scope where the run home reads it (`localScopeKeyFor`, a linked
// worktree's own top) — never `repoRootFor`'s main checkout. The project scope is unchanged.
describe("pluginManagerOptionsFor — the local scope's file", () => {
  test("from a linked worktree, local is the worktree's .winter/settings.local.json", () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "winter-cli-i2-repo-")));
    const git = (args: string[], cwd: string) => expect(Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
    git(["init", "-q"], repo);
    git(["-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "i"], repo);
    const wt = join(realpathSync(mkdtempSync(join(tmpdir(), "winter-cli-i2-wt-"))), "wt");
    git(["worktree", "add", "-q", "-b", `i2-${Math.random().toString(16).slice(2)}`, wt], repo);
    const opts = pluginManagerOptionsFor(mkdtempSync(join(tmpdir(), "winter-cli-i2-home-")), wt);
    expect(opts.settingsPathFor("local")).toBe(join(wt, ".winter", "settings.local.json"));
  });

  // R.3 residual (controller ruling): the PROJECT scope is the worktree's own top too (claude's `--scope
  // project` writes at the cwd's git top-level; the run home reads the project tier there). From the main
  // checkout both scopes stay where they were.
  test("R.3 residual: from a linked worktree, project is the worktree's .winter/settings.json; from main, main's", () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "winter-cli-r3p-repo-")));
    const git = (args: string[], cwd: string) => expect(Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
    git(["init", "-q"], repo);
    git(["-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "i"], repo);
    const wt = join(realpathSync(mkdtempSync(join(tmpdir(), "winter-cli-r3p-wt-"))), "wt");
    git(["worktree", "add", "-q", "-b", `r3p-${Math.random().toString(16).slice(2)}`, wt], repo);
    const home = mkdtempSync(join(tmpdir(), "winter-cli-r3p-home-"));
    expect(pluginManagerOptionsFor(home, wt).settingsPathFor("project")).toBe(join(wt, ".winter", "settings.json"));
    expect(pluginManagerOptionsFor(home, repo).settingsPathFor("project")).toBe(join(repo, ".winter", "settings.json"));
    expect(pluginManagerOptionsFor(home, repo).settingsPathFor("local")).toBe(join(repo, ".winter", "settings.local.json"));
  });
});

describe("no-daemon path (the adapter directly)", () => {
  function deps(winterHome: string): PluginRouteDeps {
    return { cwd: process.cwd(), winterHome, door: undefined };
  }

  test("install <name>@<marketplace> after marketplace add; list reflects it enabled", async () => {
    const winterHome = mkdtempSync(join(tmpdir(), "winter-plugin-cli-"));
    const mktDir = mkdtempSync(join(tmpdir(), "winter-plugin-cli-mkt-"));
    writeMarketplace(mktDir, [{ name: "p", source: ".", version: "1.0.0" }]);

    const mktOutcome = await runPluginMarketplaceAddRoute(deps(winterHome), mktDir);
    expect(mktOutcome.ok).toBe(true);

    const installOutcome = await runPluginInstallRoute(deps(winterHome), "p@m", "user");
    expect(installOutcome.ok).toBe(true);
    expect(renderPluginInstallOutcome(installOutcome)).toContain("installed p v1.0.0");

    const listOutcome = await runPluginListRoute(deps(winterHome));
    expect(listOutcome.ok).toBe(true);
    if (listOutcome.ok) {
      expect(listOutcome.plugins).toEqual([{ id: "p", version: "1.0.0", installPath: mktDir, scope: "user", enabled: true, marketplace: "m" }]);
      expect(renderPluginListOutcome(listOutcome)).toContain("p@m v1.0.0");
    }
  });

  test("install from a bare folder (no @marketplace): registers the folder as a marketplace and installs its one plugin", async () => {
    const winterHome = mkdtempSync(join(tmpdir(), "winter-plugin-cli-"));
    const dir = mkdtempSync(join(tmpdir(), "winter-plugin-cli-folder-"));
    writeMarketplace(dir, [{ name: "solo", source: "." }]);

    const outcome = await runPluginInstallRoute(deps(winterHome), dir, undefined);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.plugin).toEqual({ id: "solo", installPath: dir, scope: "user" });

    const listOutcome = await runPluginListRoute(deps(winterHome));
    expect(listOutcome.ok && listOutcome.plugins[0]?.enabled).toBe(true);
  });

  test("install from a multi-plugin folder is refused, naming the marketplace add fallback", async () => {
    const winterHome = mkdtempSync(join(tmpdir(), "winter-plugin-cli-"));
    const dir = mkdtempSync(join(tmpdir(), "winter-plugin-cli-multi-"));
    writeMarketplace(dir, [{ name: "a", source: "." }, { name: "b", source: "." }]);

    const outcome = await runPluginInstallRoute(deps(winterHome), dir, undefined);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("2 plugin(s)");
  });

  test("enable/disable round trip; uninstall clears the record", async () => {
    const winterHome = mkdtempSync(join(tmpdir(), "winter-plugin-cli-"));
    const mktDir = mkdtempSync(join(tmpdir(), "winter-plugin-cli-mkt2-"));
    writeMarketplace(mktDir, [{ name: "p", source: "." }]);
    await runPluginMarketplaceAddRoute(deps(winterHome), mktDir);
    await runPluginInstallRoute(deps(winterHome), "p@m", "user");

    const disableOutcome = await runPluginSetEnabledRoute(deps(winterHome), "p@m", "user", false);
    expect(disableOutcome).toEqual({ ok: true, spec: "p@m", scope: "user", enabled: false });

    const enableOutcome = await runPluginSetEnabledRoute(deps(winterHome), "p@m", "user", true);
    expect(enableOutcome).toEqual({ ok: true, spec: "p@m", scope: "user", enabled: true });

    const uninstallOutcome = await runPluginUninstallRoute(deps(winterHome), "p@m", "user");
    expect(uninstallOutcome).toEqual({ ok: true, spec: "p@m", scope: "user" });
    const listOutcome = await runPluginListRoute(deps(winterHome));
    expect(listOutcome.ok && listOutcome.plugins).toEqual([]);
  });

  test("marketplace remove/list round trip", async () => {
    const winterHome = mkdtempSync(join(tmpdir(), "winter-plugin-cli-"));
    const mktDir = mkdtempSync(join(tmpdir(), "winter-plugin-cli-mkt3-"));
    writeMarketplace(mktDir, [{ name: "p", source: "." }]);
    await runPluginMarketplaceAddRoute(deps(winterHome), mktDir);
    expect((await runPluginMarketplaceListRoute(deps(winterHome))).ok).toBe(true);
    const removeOutcome = await runPluginMarketplaceRemoveRoute(deps(winterHome), "m");
    expect(removeOutcome).toEqual({ ok: true, name: "m" });
  });
});

describe("daemon path (a fake door)", () => {
  function fakeDoor(): PluginDoor & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      async pluginList() { calls.push("list"); return { ok: true, plugins: [] }; },
      async pluginInstall(spec, scope) { calls.push(`install:${spec}:${scope}`); return { ok: true, plugin: { id: spec.split("@")[0]!, installPath: "/tmp/x", scope } }; },
      async pluginUninstall(spec, scope) { calls.push(`uninstall:${spec}:${scope}`); return { ok: true, spec, scope }; },
      async pluginSetEnabled(spec, scope, enabled) { calls.push(`setEnabled:${spec}:${scope}:${enabled}`); return { ok: true, spec, scope, enabled }; },
      async pluginUpdate(spec) { calls.push(`update:${spec}`); return { ok: true, plugin: { id: spec.split("@")[0]!, installPath: "/tmp/x", scope: "user" } }; },
      async pluginMarketplaceAdd(source) { calls.push(`marketplaceAdd:${source}`); return { ok: true, marketplace: { name: "m", source, kind: "directory", path: source } }; },
      async pluginMarketplaceRemove(name) { calls.push(`marketplaceRemove:${name}`); return { ok: true, name }; },
      async pluginMarketplaceList() { calls.push("marketplaceList"); return { ok: true, marketplaces: [] }; },
      async pluginMarketplaceUpdate(name) { calls.push(`marketplaceUpdate:${name ?? ""}`); return { ok: true }; },
    };
  }

  test("install <name>@<marketplace> goes straight through the door, no local marketplace read", async () => {
    const door = fakeDoor();
    const outcome = await runPluginInstallRoute({ cwd: process.cwd(), winterHome: "/tmp/unused", door }, "p@m", "user");
    expect(outcome.ok).toBe(true);
    expect(door.calls).toEqual(["install:p@m:user"]);
  });

  test("install from a bare folder resolves the plugin name LOCALLY, then calls marketplaceAdd + install on the door", async () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-plugin-cli-door-folder-"));
    writeMarketplace(dir, [{ name: "solo", source: "." }]);
    const door = fakeDoor();
    const outcome = await runPluginInstallRoute({ cwd: process.cwd(), winterHome: "/tmp/unused", door }, dir, "project", "/some/project");
    expect(outcome.ok).toBe(true);
    expect(door.calls).toEqual([`marketplaceAdd:${dir}`, "install:solo@m:project"]);
  });

  test("enable/disable/uninstall/update/marketplace.* all route through the door", async () => {
    const door = fakeDoor();
    const deps = { cwd: process.cwd(), winterHome: "/tmp/unused", door };
    await runPluginSetEnabledRoute(deps, "p@m", "user", true);
    await runPluginSetEnabledRoute(deps, "p@m", "user", false);
    await runPluginUninstallRoute(deps, "p@m", "user");
    await runPluginMarketplaceRemoveRoute(deps, "m");
    await runPluginMarketplaceListRoute(deps);
    await runPluginMarketplaceUpdateRoute(deps);
    expect(door.calls).toEqual([
      "setEnabled:p@m:user:true",
      "setEnabled:p@m:user:false",
      "uninstall:p@m:user",
      "marketplaceRemove:m",
      "marketplaceList",
      "marketplaceUpdate:",
    ]);
  });
});

// Phase 4b Task 2 (kept, unchanged): disable/remove's best-effort daemon-side token revoke.
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
