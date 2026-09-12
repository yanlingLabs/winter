// Winter Phase 8d (P8d-1..3) — `stage-runtimes.ts` with FAKE binaries in a mkdtemp dir. Never
// touches a real `winter`/`claude` build: `winterPath`/`claudeBinaryPath` bypass `buildWinter()`
// and `resolveInstalledClaudeBinary()` entirely, and `getClaudeVersion` bypasses spawning the
// (non-executable) fake `claude` file — the version step is injectable by design.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVersionsJson, parseClaudeVersionOutput, sha256File, stageRuntimes } from "./stage-runtimes";
import { parseVersionsJson } from "../packages/core/src/runtime-sdk/bundle-layout";
import { REQUIRED_CLAUDE_AGENT_SDK, REQUIRED_WINTER_AGENT_SDK, REQUIRED_WINTER_RUNTIME_SDK } from "../packages/core/src/runtime-sdk/versions";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

describe("parseClaudeVersionOutput (M1 shape)", () => {
  test("extracts the leading version token", () => {
    expect(parseClaudeVersionOutput("2.1.250 (Claude Code)\n")).toBe("2.1.250");
  });
  test("a bare version with no trailer still parses", () => {
    expect(parseClaudeVersionOutput("2.1.250")).toBe("2.1.250");
  });
  test("empty output throws rather than returning garbage", () => {
    expect(() => parseClaudeVersionOutput("   \n")).toThrow(/could not parse/);
  });
});

describe("buildVersionsJson (P8d-3)", () => {
  test("stamps this build's own pins, never a re-typed literal", () => {
    const v = buildVersionsJson({ claudeCode: "2.1.250", winterPreSignSha256: "a".repeat(64), claudeSha256: "b".repeat(64), now: new Date("2026-09-12T00:00:00Z") });
    expect(v).toEqual({
      schema: 1,
      winterAgentSdk: REQUIRED_WINTER_AGENT_SDK,
      winterRuntimeSdk: REQUIRED_WINTER_RUNTIME_SDK,
      officialSdk: REQUIRED_CLAUDE_AGENT_SDK,
      claudeCode: "2.1.250",
      checksums: { winterPreSign: "a".repeat(64), claude: "b".repeat(64) },
      stagedAt: "2026-09-12T00:00:00.000Z",
    });
  });
  test("round-trips through parseVersionsJson (the ladder's own gate) without throwing", () => {
    const v = buildVersionsJson({ claudeCode: "2.1.250", winterPreSignSha256: "a".repeat(64), claudeSha256: "b".repeat(64) });
    expect(parseVersionsJson(JSON.stringify(v))).toEqual(v);
  });
});

describe("stageRuntimes (fake binaries, mkdtemp — no real winter/claude build)", () => {
  test("writes the P8d-1 layout, byte-copies both binaries mode 0755, and VERSIONS.json parses clean", async () => {
    const srcDir = tempDir("stage-runtimes-src-");
    const winterSrc = join(srcDir, "winter-fake");
    const claudeSrc = join(srcDir, "claude-fake");
    writeFileSync(winterSrc, "fake winter binary bytes\n");
    writeFileSync(claudeSrc, "fake claude binary bytes\n");

    const out = tempDir("stage-runtimes-out-");
    const result = await stageRuntimes({
      out,
      winterPath: winterSrc,
      claudeBinaryPath: claudeSrc,
      getClaudeVersion: () => "2.1.250",
    });

    // Layout
    expect(result.winterPath).toBe(join(out, "winter"));
    expect(result.claudePath).toBe(join(out, "claude-official", "claude"));
    expect(result.versionsPath).toBe(join(out, "claude-official", "VERSIONS.json"));
    expect(existsSync(result.winterPath)).toBe(true);
    expect(existsSync(result.claudePath)).toBe(true);
    expect(existsSync(result.versionsPath)).toBe(true);

    // Byte-identical copies
    expect(readFileSync(result.winterPath, "utf8")).toBe("fake winter binary bytes\n");
    expect(readFileSync(result.claudePath, "utf8")).toBe("fake claude binary bytes\n");

    // mode 0755
    expect(statSync(result.winterPath).mode & 0o777).toBe(0o755);
    expect(statSync(result.claudePath).mode & 0o777).toBe(0o755);

    // VERSIONS.json: this build's pins, real checksums, and it parses through the ladder's own gate.
    expect(result.versions.claudeCode).toBe("2.1.250");
    expect(result.versions.checksums.winterPreSign).toBe(sha256File(result.winterPath));
    expect(result.versions.checksums.claude).toBe(sha256File(result.claudePath));
    const onDisk = JSON.parse(readFileSync(result.versionsPath, "utf8"));
    expect(onDisk).toEqual(result.versions);
    expect(parseVersionsJson(readFileSync(result.versionsPath, "utf8"))).toEqual(result.versions);
  });

  test("no claude binary resolvable (no path, no injected resolver hit) refuses with a clear message, never a silent skip", async () => {
    const srcDir = tempDir("stage-runtimes-src2-");
    const winterSrc = join(srcDir, "winter-fake");
    writeFileSync(winterSrc, "fake winter binary bytes\n");
    const out = tempDir("stage-runtimes-out2-");
    await expect(
      stageRuntimes({ out, winterPath: winterSrc, resolveClaudeBinary: () => undefined }),
    ).rejects.toThrow(/no claude binary found/);
  });
});
