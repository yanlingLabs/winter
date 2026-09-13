import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUNTIME_BUNDLE_LAYOUT,
  antExecutablePath,
  bundleRuntimePath,
  parseVersionsJson,
  resolveAntExecutable,
  winterSourceOf,
  type VersionsJson,
} from "../../src/runtime-sdk/bundle-layout";
import { REQUIRED_CLAUDE_AGENT_SDK, REQUIRED_WINTER_AGENT_SDK, REQUIRED_WINTER_RUNTIME_SDK } from "../../src/runtime-sdk/versions";

const sha = "a".repeat(64);
const good: VersionsJson = {
  schema: 1, winterAgentSdk: REQUIRED_WINTER_AGENT_SDK, winterRuntimeSdk: REQUIRED_WINTER_RUNTIME_SDK,
  officialSdk: REQUIRED_CLAUDE_AGENT_SDK, claudeCode: "2.1.250", checksums: { winterPreSign: sha, claude: sha }, stagedAt: "2026-09-12T00:00:00Z",
};

describe("bundle-layout (P8d-1)", () => {
  test("the bundle rung is dirname(execPath) + the layout entry", () => {
    expect(bundleRuntimePath("/Applications/Winter.app/Contents/Resources/winter-core", "winter")).toBe("/Applications/Winter.app/Contents/Resources/runtimes/winter");
    expect(bundleRuntimePath("/x/Resources/winter-core", "claude")).toBe("/x/Resources/runtimes/claude-official/claude");
    expect(bundleRuntimePath("/x/Resources/winter-core", "versions")).toBe("/x/Resources/runtimes/claude-official/VERSIONS.json");
    expect(RUNTIME_BUNDLE_LAYOUT.root).toBe("runtimes");
  });
  test("parseVersionsJson accepts a record matching this build's pins", () => {
    expect(parseVersionsJson(JSON.stringify(good)).claudeCode).toBe("2.1.250");
  });
  test("parseVersionsJson refuses a pin mismatch, a bad checksum, and a bad schema", () => {
    expect(() => parseVersionsJson(JSON.stringify({ ...good, officialSdk: "0.3.251" }))).toThrow(/disagrees with this build's pins/);
    expect(() => parseVersionsJson(JSON.stringify({ ...good, checksums: { winterPreSign: "nope", claude: sha } }))).toThrow(/sha256/);
    expect(() => parseVersionsJson(JSON.stringify({ ...good, schema: 2 }))).toThrow(/schema/);
    expect(() => parseVersionsJson("{")).toThrow(/valid JSON/);
  });

  // P9a-8: VersionsJson.winterSource, the checksum equality's own provenance label.
  test("winterSourceOf defaults an absent field to checkout-build (an 8d-staged bundle predates this field)", () => {
    expect(winterSourceOf(good)).toBe("checkout-build");
    expect(winterSourceOf({ ...good, winterSource: "platform-package" })).toBe("platform-package");
    expect(winterSourceOf({ ...good, winterSource: "checkout-build" })).toBe("checkout-build");
  });
  test("parseVersionsJson accepts both winterSource spellings and preserves an absent field as absent", () => {
    expect(parseVersionsJson(JSON.stringify({ ...good, winterSource: "platform-package" })).winterSource).toBe("platform-package");
    expect(parseVersionsJson(JSON.stringify({ ...good, winterSource: "checkout-build" })).winterSource).toBe("checkout-build");
    expect(parseVersionsJson(JSON.stringify(good)).winterSource).toBeUndefined();
  });
  test("parseVersionsJson rejects any winterSource spelling other than the two", () => {
    expect(() => parseVersionsJson(JSON.stringify({ ...good, winterSource: "npm" }))).toThrow(/winterSource must be one of/);
    expect(() => parseVersionsJson(JSON.stringify({ ...good, winterSource: 1 }))).toThrow(/winterSource must be one of/);
  });

  // Winter Phase 10a (P10a-4/L4): the `ant` bundle-layout entry + path helper.
  test("antExecutablePath is dirname(execPath)/runtimes/ant/ant, same shape as bundleRuntimePath(execPath, 'ant')", () => {
    expect(antExecutablePath("/Applications/Winter.app/Contents/Resources/winter-core")).toBe(
      "/Applications/Winter.app/Contents/Resources/runtimes/ant/ant",
    );
    expect(antExecutablePath("/x/Resources/winter-core")).toBe(bundleRuntimePath("/x/Resources/winter-core", "ant"));
    expect(RUNTIME_BUNDLE_LAYOUT.ant).toBe("runtimes/ant/ant");
  });

  // Winter Phase 10a (fix round 2): checksums.ant — the STAGE-TIME pre-sign hash embed-runtimes.sh
  // records for ant, mirroring winterPreSign's own shape. Optional so a pre-fix-round-2 bundle (or
  // one with no vendored ant) still parses.
  test("parseVersionsJson accepts an optional checksums.ant and preserves its absence as absence", () => {
    const antSha = "b".repeat(64);
    expect(parseVersionsJson(JSON.stringify(good)).checksums.ant).toBeUndefined();
    expect(parseVersionsJson(JSON.stringify({ ...good, checksums: { ...good.checksums, ant: antSha } })).checksums.ant).toBe(antSha);
  });
  test("parseVersionsJson refuses a malformed checksums.ant without silently dropping it", () => {
    expect(() => parseVersionsJson(JSON.stringify({ ...good, checksums: { ...good.checksums, ant: "nope" } }))).toThrow(/checksums\.ant must be lowercase sha256 hex/);
    expect(() => parseVersionsJson(JSON.stringify({ ...good, checksums: { ...good.checksums, ant: 123 } }))).toThrow(/checksums\.ant must be lowercase sha256 hex/);
  });
});

// Winter Phase 10a (P10a-4/L4): resolveAntExecutable's ladder. `ant` is OPTIONAL — a total miss is
// `undefined`, never a typed refusal (unlike resolveWinterExecutable/resolveClaudeExecutable).
describe("resolveAntExecutable (P10a-4 ladder)", () => {
  const base = { env: {}, execPath: "/bundle/Contents/MacOS/winter-core" };
  const BUNDLE_ANT = antExecutablePath(base.execPath);

  test("setting wins over everything, trusted as given (no existence check)", () => {
    const r = resolveAntExecutable({ ...base, setting: "/s/ant", env: { WINTER_ANT_EXECUTABLE: "/e/ant" }, isExecutableFile: () => true, which: () => "/usr/local/bin/ant" });
    expect(r).toEqual({ path: "/s/ant", source: "setting" });
  });

  test("env beats the bundle rung and the PATH lookup", () => {
    const r = resolveAntExecutable({ ...base, env: { WINTER_ANT_EXECUTABLE: "/e/ant" }, isExecutableFile: () => true, which: () => "/usr/local/bin/ant" });
    expect(r).toEqual({ path: "/e/ant", source: "env" });
  });

  test("the bundle rung is <dirname(execPath)>/runtimes/ant/ant, gated on exists-and-executable", () => {
    const r = resolveAntExecutable({ ...base, isExecutableFile: (p) => p === BUNDLE_ANT, which: () => null });
    expect(r).toEqual({ path: BUNDLE_ANT, source: "bundle" });
  });

  test("a bundle file that exists but is NOT executable is treated as absent — falls through to which", () => {
    const r = resolveAntExecutable({ ...base, isExecutableFile: () => false, which: (cmd) => (cmd === "ant" ? "/opt/homebrew/bin/ant" : null) });
    expect(r).toEqual({ path: "/opt/homebrew/bin/ant", source: "path" });
  });

  test("which ant is the last rung, only reached when the bundle rung misses", () => {
    const r = resolveAntExecutable({ ...base, isExecutableFile: () => false, which: () => "/usr/local/bin/ant" });
    expect(r).toEqual({ path: "/usr/local/bin/ant", source: "path" });
  });

  test("the bundle rung still wins over which, even when both would resolve", () => {
    const r = resolveAntExecutable({ ...base, isExecutableFile: (p) => p === BUNDLE_ANT, which: () => "/usr/local/bin/ant" });
    expect(r).toEqual({ path: BUNDLE_ANT, source: "bundle" });
  });

  test("nothing resolves anywhere -> undefined, never a throw", () => {
    const r = resolveAntExecutable({ ...base, isExecutableFile: () => false, which: () => null });
    expect(r).toBeUndefined();
  });

  test("a whitespace-only setting or env value is treated as UNSET, not as a configured path", () => {
    const r = resolveAntExecutable({ ...base, setting: "   ", env: { WINTER_ANT_EXECUTABLE: "\t\n" }, isExecutableFile: (p) => p === BUNDLE_ANT, which: () => null });
    expect(r).toEqual({ path: BUNDLE_ANT, source: "bundle" });
  });

  test("the real (non-injected) filesystem check: an actual mkdtemp'd executable file resolves via the bundle rung", () => {
    const root = mkdtempSync(join(tmpdir(), "winter-ant-bundle-"));
    try {
      const execPath = join(root, "Contents", "Resources", "winter-core");
      const antPath = antExecutablePath(execPath);
      mkdirSync(join(root, "Contents", "Resources", "runtimes", "ant"), { recursive: true });
      writeFileSync(antPath, "#!/bin/sh\necho fixture-ant\n");
      chmodSync(antPath, 0o755);
      const r = resolveAntExecutable({ env: {}, execPath, which: () => null });
      expect(r).toEqual({ path: antPath, source: "bundle" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the real (non-injected) filesystem check: an mkdtemp'd file that exists but is NOT chmod executable is treated as absent", () => {
    const root = mkdtempSync(join(tmpdir(), "winter-ant-bundle-"));
    try {
      const execPath = join(root, "Contents", "Resources", "winter-core");
      const antPath = antExecutablePath(execPath);
      mkdirSync(join(root, "Contents", "Resources", "runtimes", "ant"), { recursive: true });
      writeFileSync(antPath, "#!/bin/sh\necho fixture-ant\n");
      chmodSync(antPath, 0o644); // NOT executable
      const r = resolveAntExecutable({ env: {}, execPath, which: () => null });
      expect(r).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
