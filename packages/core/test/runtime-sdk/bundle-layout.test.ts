import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUNTIME_BUNDLE_LAYOUT,
  antExecutablePath,
  bundleRuntimePath,
  isCompiledBinary,
  parseAntVersionsJson,
  parseVersionsJson,
  resolveAntExecutable,
  winterSourceOf,
  type AntVersionsJson,
  type VersionsJson,
} from "../../src/runtime-sdk/bundle-layout";
import { REQUIRED_WINTER_AGENT_SDK, REQUIRED_WINTER_RUNTIME_SDK } from "../../src/runtime-sdk/versions";

const sha = "a".repeat(64);
const good: VersionsJson = {
  schema: 2, winterAgentSdk: REQUIRED_WINTER_AGENT_SDK, winterRuntimeSdk: REQUIRED_WINTER_RUNTIME_SDK,
  checksums: { winterPreSign: sha }, stagedAt: "2026-09-25T00:00:00Z",
};
const goodAnt: AntVersionsJson = { schema: 1, tag: "v1.32.0", checksums: { antPreSign: "b".repeat(64) }, stagedAt: "2026-09-25T00:00:00Z" };

describe("bundle-layout (P8d-1; WS-23 split the record)", () => {
  test("the bundle rung is dirname(execPath) + the layout entry", () => {
    expect(bundleRuntimePath("/Applications/Winter.app/Contents/Resources/winter-core", "winter")).toBe("/Applications/Winter.app/Contents/Resources/runtimes/winter");
    expect(bundleRuntimePath("/x/Resources/winter-core", "versions")).toBe("/x/Resources/runtimes/VERSIONS.json");
    expect(bundleRuntimePath("/x/Resources/winter-core", "antVersions")).toBe("/x/Resources/runtimes/ant/VERSIONS.json");
    expect(RUNTIME_BUNDLE_LAYOUT.root).toBe("runtimes");
  });
  // WS-23: the official leg's `claude-official/` subtree is gone from the layout.
  test("the layout names no claude-official entry", () => {
    expect(Object.values(RUNTIME_BUNDLE_LAYOUT).some((p) => p.includes("claude"))).toBe(false);
  });
  test("parseVersionsJson accepts a record matching this build's pins", () => {
    expect(parseVersionsJson(JSON.stringify(good))).toEqual(good);
  });
  test("parseVersionsJson refuses a pin mismatch, a bad checksum, and a bad schema", () => {
    expect(() => parseVersionsJson(JSON.stringify({ ...good, winterAgentSdk: "0.0.1" }))).toThrow(/disagrees with this build's pins/);
    expect(() => parseVersionsJson(JSON.stringify({ ...good, winterRuntimeSdk: "0.0.1" }))).toThrow(/disagrees with this build's pins/);
    expect(() => parseVersionsJson(JSON.stringify({ ...good, checksums: { winterPreSign: "nope" } }))).toThrow(/sha256/);
    expect(() => parseVersionsJson(JSON.stringify({ ...good, schema: 3 }))).toThrow(/schema/);
    expect(() => parseVersionsJson("{")).toThrow(/valid JSON/);
  });
  test("the pre-WS-23 schema-1 claude-official record is refused by name", () => {
    const legacy = { schema: 1, winterAgentSdk: REQUIRED_WINTER_AGENT_SDK, winterRuntimeSdk: REQUIRED_WINTER_RUNTIME_SDK, officialSdk: "0.3.250", claudeCode: "2.1.250", checksums: { winterPreSign: sha, claude: sha }, stagedAt: "x" };
    expect(() => parseVersionsJson(JSON.stringify(legacy))).toThrow(/schema 1 is the pre-WS-23 claude-official record/);
  });

  // P9a-8: VersionsJson.winterSource, the checksum equality's own provenance label.
  test("winterSourceOf defaults an absent field to checkout-build", () => {
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

  // WS-23: ant's pre-sign checksum moved out of the claude-official record into its own.
  test("parseAntVersionsJson accepts ant's own record", () => {
    expect(parseAntVersionsJson(JSON.stringify(goodAnt))).toEqual(goodAnt);
  });
  test("parseAntVersionsJson refuses a malformed checksum, a missing tag and a bad schema — never a silent drop", () => {
    expect(() => parseAntVersionsJson(JSON.stringify({ ...goodAnt, checksums: { antPreSign: "nope" } }))).toThrow(/checksums\.antPreSign must be lowercase sha256 hex/);
    expect(() => parseAntVersionsJson(JSON.stringify({ ...goodAnt, checksums: {} }))).toThrow(/antPreSign/);
    const { tag: _tag, ...noTag } = goodAnt;
    expect(() => parseAntVersionsJson(JSON.stringify(noTag))).toThrow(/tag/);
    expect(() => parseAntVersionsJson(JSON.stringify({ ...goodAnt, schema: 2 }))).toThrow(/schema/);
  });
});

// Winter Phase 10a (P10a-4/L4): resolveAntExecutable's ladder. `ant` is OPTIONAL — a total miss is
// `undefined`, never a typed refusal (unlike resolveWinterExecutable).
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

  // Winter Phase 10a fix wave (M6): the `which ant` rung must be UNREACHABLE from a compiled
  // binary, by construction — never merely "in effect" because the bundle rung above usually
  // succeeds first. A missing/corrupt embedded `ant` in a Release build must never fall through to
  // whatever happens to sit on the real machine's $PATH.
  describe("M6 — the which-ant rung is gated by construction on a compiled binary", () => {
    test("isCompiled: () => true skips which() ENTIRELY, even when it would resolve — reports undefined", () => {
      let whichCalled = false;
      const r = resolveAntExecutable({
        ...base, isExecutableFile: () => false, isCompiled: () => true,
        which: () => { whichCalled = true; return "/usr/local/bin/ant"; },
      });
      expect(r).toBeUndefined();
      expect(whichCalled).toBe(false);
    });

    test("isCompiled: () => false (dev/test) still reaches which() exactly as before", () => {
      const r = resolveAntExecutable({ ...base, isExecutableFile: () => false, isCompiled: () => false, which: () => "/usr/local/bin/ant" });
      expect(r).toEqual({ path: "/usr/local/bin/ant", source: "path" });
    });

    test("the compiled gate never blocks the setting/env/bundle rungs — only the which() fallback", () => {
      const settingResult = resolveAntExecutable({ ...base, setting: "/s/ant", isCompiled: () => true, which: () => "/nope" });
      expect(settingResult).toEqual({ path: "/s/ant", source: "setting" });
      const bundleResult = resolveAntExecutable({ ...base, isExecutableFile: (p) => p === BUNDLE_ANT, isCompiled: () => true, which: () => "/nope" });
      expect(bundleResult).toEqual({ path: BUNDLE_ANT, source: "bundle" });
    });

    test("isCompiledBinary() itself reflects Bun.main — false under bun test, which never runs as a compiled $bunfs binary", () => {
      expect(isCompiledBinary()).toBe(false);
    });

    test("the default resolveAntExecutable() call (no isCompiled override) uses the REAL isCompiledBinary() — false under bun test, so which() still fires", () => {
      // No `isCompiled` override at all: proves the default wiring (not just the test seam) reaches
      // which() under the real (uncompiled) `bun test` process.
      const r = resolveAntExecutable({ ...base, isExecutableFile: () => false, which: () => "/usr/local/bin/ant" });
      expect(r).toEqual({ path: "/usr/local/bin/ant", source: "path" });
    });
  });
});
