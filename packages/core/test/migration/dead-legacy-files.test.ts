import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEAD_LEGACY_TOP_LEVEL_FILES, describeDeadLegacyFiles, findDeadLegacyFiles } from "../../src/migration/dead-legacy-files";

const dirs: string[] = [];
function home(): string {
  const d = mkdtempSync(join(tmpdir(), "winter-dead-legacy-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("DEAD_LEGACY_TOP_LEVEL_FILES", () => {
  test("is exactly the five files no current reader opens", () => {
    expect([...DEAD_LEGACY_TOP_LEVEL_FILES].sort()).toEqual(["app-state.json", "mcp.json", "permissions.json", "tools.json", "toolsets.json"]);
  });
});

describe("findDeadLegacyFiles", () => {
  test("an ordinary home has none", () => {
    const h = home();
    writeFileSync(join(h, "settings.json"), "{}");
    mkdirSync(join(h, "app-state"));
    expect(findDeadLegacyFiles(h)).toEqual([]);
  });

  test("finds the present ones, in a stable order, and never modifies them", () => {
    const h = home();
    writeFileSync(join(h, "toolsets.json"), '{"a":1}');
    writeFileSync(join(h, "tools.json"), "[]");
    const found = findDeadLegacyFiles(h);
    expect(found.map((f) => f.name)).toEqual(["tools.json", "toolsets.json"]);
    expect(readFileSync(join(h, "toolsets.json"), "utf8")).toBe('{"a":1}');
  });

  test("counts the servers an mcp.json declares — wrapped or bare-map shape", () => {
    const h1 = home();
    writeFileSync(join(h1, "mcp.json"), JSON.stringify({ mcpServers: { a: { command: "npx" }, b: { url: "https://x" } } }));
    expect(findDeadLegacyFiles(h1)).toEqual([{ name: "mcp.json", path: join(h1, "mcp.json"), mcpServers: 2 }]);
    const h2 = home();
    writeFileSync(join(h2, "mcp.json"), JSON.stringify({ youtube: { command: "npx", args: ["-y", "yt-mcp"] } }));
    expect(findDeadLegacyFiles(h2)[0]!.mcpServers).toBe(1);
  });

  test("an empty or garbage mcp.json declares zero servers and never throws", () => {
    const h1 = home();
    writeFileSync(join(h1, "mcp.json"), "");
    expect(findDeadLegacyFiles(h1)[0]!.mcpServers).toBe(0);
    const h2 = home();
    writeFileSync(join(h2, "mcp.json"), "{not json");
    expect(findDeadLegacyFiles(h2)[0]!.mcpServers).toBe(0);
    const h3 = home();
    writeFileSync(join(h3, "mcp.json"), JSON.stringify({ mcpServers: {} }));
    expect(findDeadLegacyFiles(h3)[0]!.mcpServers).toBe(0);
  });

  test("a directory or a symlink by one of those names is not reported", () => {
    const h = home();
    mkdirSync(join(h, "tools.json"));
    writeFileSync(join(h, "elsewhere.json"), "{}");
    symlinkSync(join(h, "elsewhere.json"), join(h, "toolsets.json"));
    expect(findDeadLegacyFiles(h)).toEqual([]);
  });

  test("a missing home is simply none", () => {
    expect(findDeadLegacyFiles(join(tmpdir(), "winter-dead-legacy-does-not-exist-xyz"))).toEqual([]);
  });
});

describe("describeDeadLegacyFiles — the one boot/doctor line", () => {
  test("nothing found: no line", () => {
    expect(describeDeadLegacyFiles([], "/h")).toBeUndefined();
  });

  test("names the files, says they are not read and were left untouched", () => {
    const line = describeDeadLegacyFiles([
      { name: "tools.json", path: "/h/tools.json" },
      { name: "toolsets.json", path: "/h/toolsets.json" },
    ], "/h")!;
    expect(line).toContain("tools.json");
    expect(line).toContain("toolsets.json");
    expect(line).toContain("not read");
    expect(line).toContain("untouched");
    expect(line.includes("\n")).toBe(false);
  });

  test("an mcp.json that declares servers says plainly where MCP servers belong", () => {
    const line = describeDeadLegacyFiles([{ name: "mcp.json", path: "/h/mcp.json", mcpServers: 1 }], "/h")!;
    expect(line).toContain("mcp.json declares 1 MCP server");
    expect(line).toContain("settings.json → mcpServers");
    expect(line).toContain(".mcp.json");
  });
});
