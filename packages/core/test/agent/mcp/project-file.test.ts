// `<cwd>/.mcp.json` read/write helpers (`src/agent/mcp/project-file.ts`) — the schema previously
// duplicated in `agent/mcp/manager.ts` and `runtime-sdk/external-mcp.ts`, now shared by both PLUS
// `winter mcp add/remove --scope project` (`mcp-cli.ts`). Uses a real temp dir (this is
// deliberately I/O, not a pure function) — never touches `~/.winter*`.
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readProjectMcpConfig, writeProjectMcpConfig, projectMcpConfigPath, projectMcpConfigExists,
  readRawProjectMcpConfig, writeRawProjectMcpConfig,
} from "../../../src/agent/mcp/project-file";

describe("project-file", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), "winter-mcp-project-file-"));
    dirs.push(d);
    return d;
  }

  describe("readProjectMcpConfig / writeProjectMcpConfig (typed, stdio-only — for a caller that already has a validated shape in hand)", () => {
    test("readProjectMcpConfig on a missing file reads as empty, never throws", () => {
      const dir = tempDir();
      expect(projectMcpConfigExists(dir)).toBe(false);
      expect(readProjectMcpConfig(dir)).toEqual({});
    });

    test("readProjectMcpConfig on a malformed file reads as empty, never throws", () => {
      const dir = tempDir();
      writeFileSync(projectMcpConfigPath(dir), "{ not json");
      expect(readProjectMcpConfig(dir)).toEqual({});
    });

    test("write then read round-trips a stdio entry", () => {
      const dir = tempDir();
      writeProjectMcpConfig(dir, { mcpServers: { "my-server": { command: "npx", args: ["my-mcp"] } } });
      expect(projectMcpConfigExists(dir)).toBe(true);
      expect(readProjectMcpConfig(dir)).toEqual({ mcpServers: { "my-server": { command: "npx", args: ["my-mcp"] } } });
    });

    test("the file on disk is pretty-printed JSON with a trailing newline", () => {
      const dir = tempDir();
      writeProjectMcpConfig(dir, { mcpServers: { "my-server": { command: "npx" } } });
      const raw = readFileSync(projectMcpConfigPath(dir), "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      expect(raw).toContain("\n  \"mcpServers\"");
    });
  });

  describe("readRawProjectMcpConfig / writeRawProjectMcpConfig (the WRITE door's own reader — untyped, never drops a sibling entry it can't parse)", () => {
    test("absent file", () => {
      const dir = tempDir();
      expect(readRawProjectMcpConfig(dir)).toEqual({ kind: "absent" });
    });

    test("malformed JSON is reported malformed, not silently emptied", () => {
      const dir = tempDir();
      writeFileSync(projectMcpConfigPath(dir), "{ not json");
      expect(readRawProjectMcpConfig(dir)).toEqual({ kind: "malformed" });
    });

    test("a non-object top level is malformed", () => {
      const dir = tempDir();
      writeFileSync(projectMcpConfigPath(dir), "[1,2,3]");
      expect(readRawProjectMcpConfig(dir)).toEqual({ kind: "malformed" });
    });

    test("an mcpServers key that isn't a plain object is malformed", () => {
      const dir = tempDir();
      writeFileSync(projectMcpConfigPath(dir), JSON.stringify({ mcpServers: "not an object" }));
      expect(readRawProjectMcpConfig(dir)).toEqual({ kind: "malformed" });
    });

    test("reads every top-level key and every server entry verbatim, whatever shape they are", () => {
      const dir = tempDir();
      const raw = {
        mcpServers: {
          stdioWithType: { type: "stdio", command: "npx", args: ["x"] },
          httpEntry: { type: "http", url: "https://example.com/mcp" },
        },
        someOtherTopLevelKey: "keep-me",
      };
      writeFileSync(projectMcpConfigPath(dir), JSON.stringify(raw));
      const read = readRawProjectMcpConfig(dir);
      expect(read).toEqual({ kind: "ok", raw, servers: raw.mcpServers });
    });

    // THE REGRESSION THIS FILE EXISTS TO PREVENT: a write built on the TYPED `readProjectMcpConfig`
    // (stdio-only, `.parse()`s the whole map at once) would see the http entry below, fail to
    // parse the ENTIRE map, degrade to `{}`, and a subsequent "add one more server" would overwrite
    // the file with ONLY the new entry — silently deleting the http entry and the stdio entry's own
    // `type` field. The raw door must never do that.
    test("adding a new entry via the raw write door preserves an existing http entry AND a stdio entry's own `type` field, byte-for-byte", () => {
      const dir = tempDir();
      const original = {
        mcpServers: {
          httpEntry: { type: "http", url: "https://example.com/mcp", headers: { "X-Foo": "bar" } },
          stdioWithType: { type: "stdio", command: "npx", args: ["existing-pkg"] },
        },
      };
      writeFileSync(projectMcpConfigPath(dir), JSON.stringify(original, null, 2));

      const read = readRawProjectMcpConfig(dir);
      if (read.kind !== "ok") throw new Error("expected ok");
      const nextServers = { ...read.servers, "new-one": { command: "npx", args: ["new-pkg"] } };
      writeRawProjectMcpConfig(dir, read.raw, nextServers);

      const after = JSON.parse(readFileSync(projectMcpConfigPath(dir), "utf8"));
      expect(after.mcpServers.httpEntry).toEqual(original.mcpServers.httpEntry);
      expect(after.mcpServers.stdioWithType).toEqual(original.mcpServers.stdioWithType);
      expect(after.mcpServers["new-one"]).toEqual({ command: "npx", args: ["new-pkg"] });
    });

    test("writeRawProjectMcpConfig preserves every OTHER top-level key, not just mcpServers", () => {
      const dir = tempDir();
      writeRawProjectMcpConfig(dir, { someOtherTopLevelKey: "keep-me" }, { "my-server": { command: "npx" } });
      const after = JSON.parse(readFileSync(projectMcpConfigPath(dir), "utf8"));
      expect(after.someOtherTopLevelKey).toBe("keep-me");
      expect(after.mcpServers["my-server"]).toEqual({ command: "npx" });
    });
  });
});
