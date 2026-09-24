// WS-21 L3.2 (spec §4.1, §4.5): the runtime-facing settings keys live in `sdk/`. The daemon reads them
// live from there (keep-last-good on a torn file), never from `settings.json`, and writes them there.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MOVED_SETTINGS_KEYS, Settings, loadSettings, sdkAdditionalDirectories, sdkAllowRules, sdkAutoMemory, sdkDenyRules,
  sdkEnabledPlugins, sdkLocalMcpServers, sdkOutputStyle, sdkUserMcpServers, setSkillDenied, withoutMovedKeys,
} from "../../src/settings";
import { ProjectSettingsResolver } from "../../src/project-settings";
import { persistedAllowRulesFor, winterGateRulesFromSdk, sdkAllowRulesFor } from "../../src/runtime-sdk/mode-options";
import { SettingsWatcher, namesWatchedFile, watchViaParentDir } from "../../src/settings-watcher";
import { liveSdkSettings, readSdkSettingsDetailed, updateSdkSettings } from "../../src/sdk-files";
import { sdkSettingsPath } from "../../src/agent/paths";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { FileSecretStore } from "../../src/auth/secret-store";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION } from "@yanlinglabs/winter-protocol";

const tmpHome = (): string => realpathSync(mkdtempSync(join(tmpdir(), "winter-sdk-split-")));
const writeSdkSettings = (home: string, value: unknown): void => {
  mkdirSync(join(home, "sdk"), { recursive: true });
  writeFileSync(sdkSettingsPath(home), JSON.stringify(value));
};

describe("the moved keys (spec §4.1)", () => {
  test("MOVED_SETTINGS_KEYS names exactly the §4.1 moves", () => {
    expect([...MOVED_SETTINGS_KEYS].sort()).toEqual([
      "mcpServers", "memory.directory", "memory.enabled", "outputStyle", "permissions.additionalDirectories",
      "permissions.allow", "permissions.deny", "plugins.disabled", "plugins.enabled",
    ]);
  });

  test("withoutMovedKeys strips them from a live holder, keeping everything that stayed (and the plugin pair, lane L4's)", () => {
    const s = Settings.parse({
      schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" },
      permissions: { allow: ["Bash(ls)"], deny: ["Skill(x)"], additionalDirectories: ["/d"], dangerousDomains: { added: ["evil.test"] } },
      mcpServers: { srv: { type: "stdio", command: "node" } },
      mcp: { disabled: ["srv"] },
      outputStyle: "Explanatory",
      memory: { enabled: false, directory: "/m" },
      plugins: { enabled: ["p"], disabled: ["q"], consents: { p: { exec: 1 } } },
    });
    const out = withoutMovedKeys(s);
    expect(out.permissions).toEqual({ dangerousDomains: { added: ["evil.test"] } });
    expect(out.mcpServers).toBeUndefined();
    expect(out.outputStyle).toBeUndefined();
    expect(out.memory).toBeUndefined();
    expect(out.mcp).toEqual({ disabled: ["srv"] });
    expect(out.plugins).toEqual({ enabled: ["p"], disabled: ["q"], consents: { p: { exec: 1 } } });
    expect(out.provider).toEqual(s.provider);
    // Never mutates its argument (the holder it came from, the file on disk for a downgrade).
    expect(s.permissions?.allow).toEqual(["Bash(ls)"]);
  });

  test("a stale permissions.allow in ~/.winter/settings.json is ignored: the only allow door is sdk/settings.json", () => {
    const home = tmpHome();
    writeFileSync(join(home, "settings.json"), JSON.stringify({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" }, permissions: { allow: ["Bash(rm -rf /:*)"] } }));
    const live = withoutMovedKeys(loadSettings(join(home, "settings.json")));
    // The resolver's base is the live holder (daemon.ts), so the stale rule cannot reach a child…
    const resolver = new ProjectSettingsResolver({ base: () => live, trust: { isTrusted: () => false } as never });
    const project = persistedAllowRulesFor("/some/cwd", {
      projectRootOf: () => "/some/cwd", effectiveSettings: (root) => resolver.effective(root), isTrusted: () => false,
    });
    expect(project).toEqual([]);
    // …and the user tier comes from sdk/settings.json alone.
    expect(sdkAllowRules(home)).toBeUndefined();
    writeSdkSettings(home, { permissions: { allow: ["Bash(git status)"] } });
    expect(sdkAllowRules(home)).toEqual(["Bash(git status)"]);
  });

  test("every sdk… reader reads its claude key (and claude's defaults)", () => {
    const home = tmpHome();
    expect(sdkAutoMemory(home)).toEqual({ enabled: true, directory: undefined });
    expect(sdkDenyRules(home)).toEqual([]);
    expect(sdkOutputStyle(home)).toBeUndefined();
    writeSdkSettings(home, {
      permissions: { deny: ["Skill(a)", 3], additionalDirectories: ["/x"] },
      outputStyle: "Learning",
      autoMemoryEnabled: false,
      autoMemoryDirectory: "/mem",
      enabledPlugins: { "fmt@local": true, "old@local": false, bad: "yes" },
    });
    expect(sdkDenyRules(home)).toEqual(["Skill(a)"]); // a non-string entry is dropped, never coerced
    expect(sdkAdditionalDirectories(home)).toEqual(["/x"]);
    expect(sdkOutputStyle(home)).toBe("Learning");
    expect(sdkAutoMemory(home)).toEqual({ enabled: false, directory: "/mem" });
    expect(sdkEnabledPlugins(home)).toEqual({ "fmt@local": true, "old@local": false });
  });

  test("sdkUserMcpServers / sdkLocalMcpServers read sdk/.winter.json, dropping a credential-shaped header", () => {
    const home = tmpHome();
    mkdirSync(join(home, "sdk"), { recursive: true });
    writeFileSync(join(home, "sdk", ".winter.json"), JSON.stringify({
      mcpServers: {
        a: { command: "node" },
        h: { type: "http", url: "https://x.test/mcp", headers: { Authorization: "Bearer sk-NEVER", "X-Id": "1" } },
        broken: { type: "stdio" },
      },
      projects: { "/repo": { mcpServers: { l: { type: "stdio", command: "local" } } } },
    }));
    const user = sdkUserMcpServers(home);
    expect(user.a).toEqual({ type: "stdio", command: "node" });
    expect(user.h).toEqual({ type: "http", url: "https://x.test/mcp", headers: { "X-Id": "1" } });
    expect(user.broken).toBeUndefined();
    expect(JSON.stringify(user)).not.toContain("sk-NEVER");
    expect(sdkLocalMcpServers(home, "/repo")).toEqual({ l: { type: "stdio", command: "local" } });
    expect(sdkLocalMcpServers(home, "/elsewhere")).toEqual({});
  });
});

describe("settings.setSkillDenied writes sdk/settings.json permissions.deny", () => {
  test("the transform, applied through updateSdkSettings, preserves the user's other keys", () => {
    const home = tmpHome();
    writeSdkSettings(home, { theme: "dark", permissions: { deny: ["Agent(fork)"], allow: ["Bash(ls)"] } });
    updateSdkSettings(home, (s) => setSkillDenied(s, "writing-skills", true));
    const onDisk = JSON.parse(readFileSync(sdkSettingsPath(home), "utf8"));
    expect(onDisk).toEqual({ theme: "dark", permissions: { deny: ["Agent(fork)", "Skill(writing-skills)"], allow: ["Bash(ls)"] } });
    expect(sdkDenyRules(home)).toEqual(["Agent(fork)", "Skill(writing-skills)"]); // the live read sees the write at once
  });
});

describe("live reads: an on-disk edit shows up; a torn edit keeps the last good version", () => {
  let watcher: SettingsWatcher<Record<string, unknown>> | undefined;
  afterEach(() => { watcher?.stop(); watcher = undefined; });

  test("an on-disk edit of sdk/settings.json reaches the watcher after the debounce, and the readers", async () => {
    const home = tmpHome();
    writeSdkSettings(home, { permissions: { deny: ["Skill(one)"] } });
    expect(sdkDenyRules(home)).toEqual(["Skill(one)"]);
    const applied: Array<Record<string, unknown>> = [];
    watcher = new SettingsWatcher<Record<string, unknown>>({
      path: sdkSettingsPath(home),
      load: (p) => {
        const r = readSdkSettingsDetailed(home);
        if (r.state === "invalid") throw new Error(`invalid ${p}`);
        return r.state === "ok" ? r.value : {};
      },
      apply: (_prev, next) => { applied.push(next); },
      debounceMs: 50,
      watch: watchViaParentDir,
    });
    watcher.start(liveSdkSettings(home));
    // Round 6 (a flake in a shared process): wait on CONDITIONS, never a fixed sleep. fs.watch gives no
    // "armed" signal, so the atomic replace — the way the daemon's own `updateSdkSettings` saves (a
    // `<file>.<pid>.<hex>.tmp` renamed over the file) — is repeated until the watcher applies it; an
    // event dropped by a stream not yet live costs one more round, never the test.
    const want = { permissions: { deny: ["Skill(two)"] } };
    const until = Date.now() + 8000;
    while (!applied.some((a) => JSON.stringify(a) === JSON.stringify(want)) && Date.now() < until) {
      const tmp = `${sdkSettingsPath(home)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
      writeFileSync(tmp, JSON.stringify(want));
      require("node:fs").renameSync(tmp, sdkSettingsPath(home));
      const round = Date.now() + 600;
      while (!applied.some((a) => JSON.stringify(a) === JSON.stringify(want)) && Date.now() < round) await Bun.sleep(10);
    }
    expect(applied.at(-1)).toEqual(want);
    expect(sdkDenyRules(home)).toEqual(["Skill(two)"]);
  });

  // Round 6 — the ROOT CAUSE of the flake: after an atomic replace, macOS reported the parent-directory
  // event under the TEMP file's name only (measured in the shared-process run: `rename settings.json.tmp`,
  // never `settings.json`), which the filter ignored — the test passed only when a stale event from the
  // setup write happened to fire the reload after the rename. The watcher now takes a temp spelling of the
  // file (its name plus a suffix) as the file's own event.
  test("the parent-directory filter takes the file's temp spellings as its own; other files are not it", () => {
    for (const f of ["settings.json", "settings.json.tmp", "settings.json.4242.a1b2c3.tmp", "settings.json~", null, undefined]) {
      expect({ f, hit: namesWatchedFile(f, "settings.json") }).toEqual({ f, hit: true });
    }
    for (const f of ["settings.local.json", ".winter.json", "history.jsonl", "xsettings.json"]) {
      expect({ f, hit: namesWatchedFile(f, "settings.json") }).toEqual({ f, hit: false });
    }
    expect(namesWatchedFile(".winter.json.99.ff.tmp", ".winter.json")).toBe(true);
  });

  test("a half-written edit keeps the last good version (readers and watcher alike)", async () => {
    const home = tmpHome();
    writeSdkSettings(home, { permissions: { deny: ["Skill(good)"] } });
    expect(sdkDenyRules(home)).toEqual(["Skill(good)"]);
    writeFileSync(sdkSettingsPath(home), '{"permissions": {"deny": ["Skill(to');
    expect(sdkDenyRules(home)).toEqual(["Skill(good)"]);
    writeSdkSettings(home, { permissions: { deny: ["Skill(fixed)"] } });
    expect(sdkDenyRules(home)).toEqual(["Skill(fixed)"]);
  });
});

describe("the gate reads the user's claude-grammar rules back in its own grammar, never wider", () => {
  test("winterGateRulesFromSdk inverts sdkAllowRulesFor", () => {
    const winter = ["Bash(git status)", "Bash(npm test:*)", "Edit", "Computer", "Worktree", "WebFetch(domain:docs.test)"];
    expect(winterGateRulesFromSdk(sdkAllowRulesFor(winter)).sort()).toEqual([...winter].sort());
  });

  test("one half of a pair is not enough — never wider than what was saved", () => {
    expect(winterGateRulesFromSdk(["Edit"])).toEqual([]);            // claude Edit alone ≠ Winter Edit (edit + write)
    expect(winterGateRulesFromSdk(["Write"])).toEqual([]);
    expect(winterGateRulesFromSdk(["EnterWorktree"])).toEqual([]);
    expect(winterGateRulesFromSdk(["Edit(//repo/**)"])).toEqual([]);  // a claude path rule is not Winter's directory grant
    expect(winterGateRulesFromSdk(["mcp__srv__tool", "Read"])).toEqual([]); // the child applies these natively
  });
});

// A daemon booted on a home whose settings.json still carries the moved keys (a downgrade's copy)
// never acts on them.
describe("the daemon ignores a stale copy of a moved key in settings.json", () => {
  let daemon: RunningDaemon | undefined;
  afterEach(async () => { const d = daemon; daemon = undefined; await d?.stop(); });

  test("a settings.json mcpServers entry is not a configured server; sdk/.winter.json's is", async () => {
    const home = tmpHome();
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" },
      mcpServers: { stale: { type: "http", url: "https://stale.test/mcp" } },
    }));
    mkdirSync(join(home, "sdk"), { recursive: true });
    writeFileSync(join(home, "sdk", ".winter.json"), JSON.stringify({ mcpServers: { fresh: { type: "http", url: "https://fresh.test/mcp" } } }));
    daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")), agentProvider: null, loginShellPath: false });
    const sock = await Bun.connect({
      unix: daemon.socketPath,
      socket: { data(_s, chunk) { for (const line of decoder.push(chunk)) replies.push(JSON.parse(line)); } },
    });
    const decoder = new LineDecoder();
    const replies: any[] = [];
    const call = async (id: number, method: string, params: unknown): Promise<any> => {
      sock.write(encodeLine({ jsonrpc: "2.0", id, method, params }));
      const until = Date.now() + 5000;
      while (!replies.some((r) => r.id === id) && Date.now() < until) await Bun.sleep(10);
      return replies.find((r) => r.id === id);
    };
    await call(1, METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token: daemon.tokens.harness, clientName: "t" });
    const list = await call(2, METHODS.mcpList, {});
    const names = (list.result.servers as Array<{ name: string }>).map((s) => s.name);
    expect(names).toContain("fresh");
    expect(names).not.toContain("stale");
    sock.end();
  });
});
