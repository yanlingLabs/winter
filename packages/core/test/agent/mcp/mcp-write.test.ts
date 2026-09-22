// `winter mcp add/remove` (CLI parity with `claude mcp add/remove`) — the ONE validated write door
// (`src/agent/mcp/mcp-write.ts`) both `ipc/server.ts`'s `mcp.add`/`mcp.remove` RPC handlers and the
// CLI's no-daemon fallback share. Pure functions, no I/O — the daemon-live path (RPC + real
// settings.json) is covered separately in `test/ipc/mcp-add-remove-get.test.ts`.
import { describe, expect, test } from "bun:test";
import {
  validateMcpServerName, addUserMcpServer, removeUserMcpServer, addProjectMcpServer, removeProjectMcpServer,
} from "../../../src/agent/mcp/mcp-write";
import { Settings } from "../../../src/settings";
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
