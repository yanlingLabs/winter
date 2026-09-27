// `winter mcp add/remove` (CLI parity with `claude mcp add/remove`) — the ONE validated write door
// (`src/agent/mcp/mcp-write.ts`) both `ipc/server.ts`'s `mcp.add`/`mcp.remove` RPC handlers and the
// CLI's no-daemon fallback share. Pure functions, no I/O — the daemon-live path (RPC + real
// settings.json) is covered separately in `test/ipc/mcp-add-remove-get.test.ts`.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateMcpServerName, addUserMcpServer, removeUserMcpServer, addProjectMcpServer, removeProjectMcpServer,
  removeMcpServerForgettingPermissions, renameMcpServerCarryingSettings,
} from "../../../src/agent/mcp/mcp-write";
import { Settings, saveSettings } from "../../../src/settings";
import type { ModelTag } from "../../../src/runtime-sdk/model-tag";

/** Same cast-through-a-named-helper convention `settings.test.ts` uses for a branded `ModelTag`
 *  literal — `.toBe`/`.toEqual` both require the RHS to already carry the brand. */
const tag = (s: string): ModelTag => s as ModelTag;

function baseSettings(overrides?: Record<string, unknown>): Settings {
  return Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" }, ...overrides });
}

describe("validateMcpServerName", () => {
  test("accepts letters, numbers, hyphens, underscores", () => {
    expect(validateMcpServerName("my-server_1")).toBeUndefined();
  });
  test("refuses a name with disallowed characters", () => {
    expect(validateMcpServerName("my server!")).toMatch(/letters, numbers, hyphens, and underscores/);
  });
  test("refuses the bare brand name", () => {
    expect(validateMcpServerName("winter")).toMatch(/reserved/);
  });
  test("refuses every daemon-owned capability server name", () => {
    for (const key of ["sessions", "computer", "browser", "office", "research", "lsp", "external"]) {
      expect(validateMcpServerName(`winter__${key}`)).toMatch(/reserved/);
    }
  });
  test("does not refuse a name that merely CONTAINS a reserved segment", () => {
    expect(validateMcpServerName("my-winter__browser-fork")).toBeUndefined();
  });
});

describe("addUserMcpServer / removeUserMcpServer", () => {
  test("adds a stdio entry", () => {
    const next = addUserMcpServer(baseSettings(), "my-server", { type: "stdio", command: "npx", args: ["my-mcp"] });
    expect(next.mcpServers?.["my-server"]).toEqual({ type: "stdio", command: "npx", args: ["my-mcp"] });
  });

  test("refuses a reserved name before ever touching mcpServers", () => {
    expect(() => addUserMcpServer(baseSettings(), "winter__browser", { type: "stdio", command: "x" }))
      .toThrow(/reserved/);
  });

  test("refuses an invalid-shaped name", () => {
    expect(() => addUserMcpServer(baseSettings(), "bad name!", { type: "stdio", command: "x" }))
      .toThrow(/letters, numbers, hyphens, and underscores/);
  });

  test("refuses to silently overwrite an existing name in user scope", () => {
    const withOne = baseSettings({ mcpServers: { existing: { type: "stdio", command: "x" } } });
    expect(() => addUserMcpServer(withOne, "existing", { type: "stdio", command: "y" }))
      .toThrow(/already exists in user config/);
  });

  test("preserves every OTHER top-level settings key", () => {
    const withRunTimes = baseSettings({ runtimes: { advisorModel: "codex-oauth/gpt-5.6-luna" } });
    const next = addUserMcpServer(withRunTimes, "my-server", { type: "stdio", command: "x" });
    expect(next.runtimes?.advisorModel).toBe("codex-oauth/gpt-5.6-luna");
    expect(next.provider.model).toBe(tag("codex-oauth/gpt-5.6-sol"));
  });

  test("preserves every OTHER configured mcpServers entry", () => {
    const withOne = baseSettings({ mcpServers: { existing: { type: "stdio", command: "x" } } });
    const next = addUserMcpServer(withOne, "new-one", { type: "stdio", command: "y" });
    expect(next.mcpServers?.existing).toEqual({ type: "stdio", command: "x" });
    expect(next.mcpServers?.["new-one"]).toEqual({ type: "stdio", command: "y" });
  });

  test("removeUserMcpServer reports removed:true and drops the entry", () => {
    const withOne = baseSettings({ mcpServers: { existing: { type: "stdio", command: "x" } } });
    const { settings: next, removed } = removeUserMcpServer(withOne, "existing");
    expect(removed).toBe(true);
    expect(next.mcpServers?.existing).toBeUndefined();
  });

  test("removeUserMcpServer on an absent name is a no-op reporting removed:false", () => {
    const settings = baseSettings();
    const { settings: next, removed } = removeUserMcpServer(settings, "never-added");
    expect(removed).toBe(false);
    expect(next).toEqual(settings);
  });
});

describe("addProjectMcpServer / removeProjectMcpServer (operate on the RAW `mcpServers` map — never the typed ProjectMcpConfig, see mcp-write.ts's own header)", () => {
  test("adds a stdio entry to an empty servers map", () => {
    const next = addProjectMcpServer({}, "my-server", { command: "npx", args: ["my-mcp"] });
    expect(next["my-server"]).toEqual({ command: "npx", args: ["my-mcp"] });
  });

  test("refuses a reserved or invalid name the same way as user scope", () => {
    expect(() => addProjectMcpServer({}, "winter", { command: "x" })).toThrow(/reserved/);
    expect(() => addProjectMcpServer({}, "bad name!", { command: "x" })).toThrow(/letters, numbers, hyphens, and underscores/);
  });

  test("refuses to silently overwrite an existing project-scope name", () => {
    const servers = { existing: { command: "x" } };
    expect(() => addProjectMcpServer(servers, "existing", { command: "y" })).toThrow(/already exists in this project's \.mcp\.json/);
  });

  test("preserves every OTHER configured project server, in WHATEVER shape it was read in (not just the stdio shape)", () => {
    const servers = { existing: { command: "x" }, foreignShape: { type: "http", url: "https://example.com/mcp" } };
    const next = addProjectMcpServer(servers, "new-one", { command: "y" });
    expect(next.existing).toEqual({ command: "x" });
    expect(next.foreignShape).toEqual({ type: "http", url: "https://example.com/mcp" });
  });

  test("removeProjectMcpServer reports removed:true/false correctly and preserves siblings", () => {
    const servers = { existing: { command: "x" }, keep: { command: "y" } };
    const removedOne = removeProjectMcpServer(servers, "existing");
    expect(removedOne.removed).toBe(true);
    expect(removedOne.servers.existing).toBeUndefined();
    expect(removedOne.servers.keep).toEqual({ command: "y" });
    const removedNone = removeProjectMcpServer({}, "absent");
    expect(removedNone.removed).toBe(false);
  });
});

describe("WS-27 review 7: write order and honest results", () => {
  const base = { schemaVersion: 3 as const, provider: { model: "codex-oauth/gpt-5.6-sol" } };
  function home(servers: Record<string, unknown>, settings: Record<string, unknown> = {}): string {
    const h = realpathSync(mkdtempSync(join(tmpdir(), "winter-mcp-write-r7-")));
    mkdirSync(join(h, "sdk"), { recursive: true });
    writeFileSync(join(h, "sdk", ".winter.json"), JSON.stringify({ mcpServers: servers }));
    saveSettings(join(h, "settings.json"), Settings.parse({ ...base, ...settings }));
    return h;
  }

  test("remove reports the server removed even when clearing its permissions fails afterwards", () => {
    const h = realpathSync(mkdtempSync(join(tmpdir(), "winter-mcp-write-r7-")));
    mkdirSync(join(h, "sdk"), { recursive: true });
    writeFileSync(join(h, "sdk", ".winter.json"), JSON.stringify({ mcpServers: { cf: { type: "stdio", command: "cf" } } }));
    mkdirSync(join(h, "settings.json"));   // unreadable as a settings file
    const r = removeMcpServerForgettingPermissions({ home: h, scope: "user" }, "cf", {});
    expect(r.removed).toBe(true);
    expect(r.permissionsCleared).toBe(false);
    expect(r.permissionsNote).toContain("could not be cleared");
    expect(JSON.parse(readFileSync(join(h, "sdk", ".winter.json"), "utf8")).mcpServers).toEqual({});
  });

  test("a live-names probe that throws keeps the permissions (cannot tell → in use)", () => {
    const h = home({ cf: { type: "stdio", command: "cf" } }, { mcp: { toolPermissions: { cf: { "*": "deny" } } } });
    const r = removeMcpServerForgettingPermissions({ home: h, scope: "user" }, "cf", { liveNames: () => { throw new Error("boom"); } });
    expect(r).toMatchObject({ removed: true, permissionsCleared: false });
    expect(JSON.parse(readFileSync(join(h, "settings.json"), "utf8")).mcp.toolPermissions).toEqual({ cf: { "*": "deny" } });
  });

  test("rename copies BEFORE it renames: a rename that fails at the scope write takes the copies back and leaves the old name governed", () => {
    const h = home({ cf: { type: "stdio", command: "cf" } }, { mcp: { toolPermissions: { cf: { "*": "deny" } } } });
    writeFileSync(join(h, "sdk", "settings.json"), JSON.stringify({ permissions: { deny: ["mcp__cf__x"] } }));
    const sdkDir = join(h, "sdk");
    // Make the scope write fail after the checks: sdk/.winter.json's directory refuses new files (atomic write).
    const original = readFileSync(join(sdkDir, ".winter.json"), "utf8");
    const settingsJson = readFileSync(join(sdkDir, "settings.json"), "utf8");
    chmodSync(sdkDir, 0o500);
    try {
      expect(() => renameMcpServerCarryingSettings({ home: h, scope: "user" }, "cf", "cf2", {})).toThrow();
    } finally {
      chmodSync(sdkDir, 0o700);
    }
    expect(readFileSync(join(sdkDir, ".winter.json"), "utf8")).toBe(original);
    expect(readFileSync(join(sdkDir, "settings.json"), "utf8")).toBe(settingsJson);
    expect(JSON.parse(readFileSync(join(h, "settings.json"), "utf8")).mcp.toolPermissions).toEqual({ cf: { "*": "deny" } });
  });

  test("a successful rename leaves only the new name's settings, in the same file position", () => {
    const h = home({ a: { type: "stdio", command: "a" }, cf: { type: "stdio", command: "cf" } }, { mcp: { toolPermissions: { cf: { "*": "deny" } }, disabled: ["cf"] } });
    const r = renameMcpServerCarryingSettings({ home: h, scope: "user" }, "cf", "cf2", {});
    expect(r).toMatchObject({ carried: true, keptOld: false });
    const s = JSON.parse(readFileSync(join(h, "settings.json"), "utf8"));
    expect(s.mcp.toolPermissions).toEqual({ cf2: { "*": "deny" } });
    expect(s.mcp.disabled).toEqual(["cf2"]);
    expect(Object.keys(JSON.parse(readFileSync(join(h, "sdk", ".winter.json"), "utf8")).mcpServers)).toEqual(["a", "cf2"]);
  });
});

describe("WS-27 round 3: ruleCouldNameMcpServer — which rules a rename or a remove lists", () => {
  test("literal rules name the server at every `__` split; globs when their server part can match", async () => {
    const { ruleCouldNameMcpServer } = await import("../../../src/agent/mcp/mcp-write");
    // Literal: the server itself, or any tool under it (so `mcp__cf__prod__x` for both `cf` and `cf__prod`).
    expect(ruleCouldNameMcpServer("mcp__cf", "cf")).toBe(true);
    expect(ruleCouldNameMcpServer("mcp__cf__list", "cf")).toBe(true);
    expect(ruleCouldNameMcpServer("mcp__cf__prod__x", "cf__prod")).toBe(true);
    expect(ruleCouldNameMcpServer("mcp__cf__prod__x", "cf")).toBe(true);
    expect(ruleCouldNameMcpServer("mcp__cf__admin__delete(*)", "cf")).toBe(true);
    expect(ruleCouldNameMcpServer("mcp__cfx__a", "cf")).toBe(false);
    expect(ruleCouldNameMcpServer("Bash(npm test)", "cf")).toBe(false);
    // Globs: `mcp__cf__*` also matches `cf__prod`'s tools; `mcp__*` any server; `mcp__c*__list` a `cf` tool.
    expect(ruleCouldNameMcpServer("mcp__cf__*", "cf__prod")).toBe(true);
    expect(ruleCouldNameMcpServer("mcp__*", "gh")).toBe(true);
    expect(ruleCouldNameMcpServer("mcp__c*__list", "cf")).toBe(true);
    expect(ruleCouldNameMcpServer("mcp__c*", "cf")).toBe(true);
    expect(ruleCouldNameMcpServer("mcp__d*", "cf")).toBe(false);
    expect(ruleCouldNameMcpServer("mcp__cf__prod__*", "cf")).toBe(true);
    expect(ruleCouldNameMcpServer("mcp__gh__*", "cf")).toBe(false);
  });
});
