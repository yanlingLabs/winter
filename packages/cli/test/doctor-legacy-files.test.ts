// A3: `winter doctor`'s legacy-files line. The helper is tested directly on a temp home; the whole
// `doctor` command is NOT run here because its migration section reads the legacy Keychain service
// (a real Keychain), which no test may touch. The wiring into `doctor` is pinned at source level.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyFilesDoctorLine } from "../src/doctor-legacy-files";

const dirs: string[] = [];
function home(): string {
  const d = mkdtempSync(join(tmpdir(), "winter-cli-doctor-legacy-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("winter doctor — the A3 legacy-files line", () => {
  test("a home with an mcp.json declaring a server and a tools.json: one line naming both, saying where MCP servers belong; files untouched", () => {
    const h = home();
    const mcp = JSON.stringify({ mcpServers: { youtube: { command: "npx", args: ["-y", "yt-mcp"] } } });
    writeFileSync(join(h, "mcp.json"), mcp);
    writeFileSync(join(h, "tools.json"), "[]");
    const line = legacyFilesDoctorLine(h);
    expect(line).toBeDefined();
    expect(line!.includes("\n")).toBe(false);
    expect(line).toContain(h);
    expect(line).toContain("mcp.json, tools.json");
    expect(line).toContain("not read by Winter");
    expect(line).toContain("mcp.json declares 1 MCP server");
    expect(line).toContain("settings.json → mcpServers");
    expect(readFileSync(join(h, "mcp.json"), "utf8")).toBe(mcp);
  });

  test("a clean home prints nothing", () => {
    const h = home();
    writeFileSync(join(h, "settings.json"), "{}");
    expect(legacyFilesDoctorLine(h)).toBeUndefined();
  });

  test("a missing home prints nothing and never throws", () => {
    expect(legacyFilesDoctorLine(join(tmpdir(), "winter-cli-doctor-legacy-absent-xyz"))).toBeUndefined();
  });

  test("`winter doctor` prints it (wired into the doctor command's migration section)", () => {
    const main = readFileSync(join(import.meta.dir, "..", "src", "main.ts"), "utf8");
    const doctorCase = main.slice(main.indexOf('case "doctor": {'), main.indexOf("const repair = args.includes(\"--repair\")"));
    expect(doctorCase).toContain("legacyFilesDoctorLine(home)");
  });
});
