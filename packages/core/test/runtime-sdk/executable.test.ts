import { describe, expect, test } from "bun:test";
import { resolvePlatformPackageWinter, resolveWinterExecutable, WinterExecutableUnavailable } from "../../src/runtime-sdk/executable";
import { bundleRuntimePath } from "../../src/runtime-sdk/bundle-layout";

const exists = (set: string[]) => (p: string) => set.includes(p);
const base = { env: {}, execPath: "/bundle/Contents/MacOS/norma-core", home: "/tmp/h" };
// P8d-1: the bundle rung moved under `Resources/runtimes/` — this is that exact path for `base`.
const BUNDLE_WINTER = bundleRuntimePath(base.execPath, "winter");

describe("resolveWinterExecutable (P8b-2 ladder, P8d-1 bundle layout)", () => {
  test("setting wins over everything", () => {
    const r = resolveWinterExecutable({ ...base, setting: "/s/winter", env: { NORMA_WINTER_EXECUTABLE: "/e/winter" }, exists: exists(["/s/winter", "/e/winter"]) });
    expect(r).toEqual({ ok: true, path: "/s/winter", source: "setting" });
  });
  test("env beats bundle and home", () => {
    const r = resolveWinterExecutable({ ...base, env: { NORMA_WINTER_EXECUTABLE: "/e/winter" }, exists: exists(["/e/winter", BUNDLE_WINTER]) });
    expect(r).toEqual({ ok: true, path: "/e/winter", source: "env" });
  });
  test("bundle rung is <dirname(execPath)>/runtimes/winter, then <home>/runtimes/bin/winter", () => {
    expect(resolveWinterExecutable({ ...base, exists: exists([BUNDLE_WINTER]) })).toEqual({ ok: true, path: BUNDLE_WINTER, source: "bundle" });
    expect(resolveWinterExecutable({ ...base, exists: exists(["/tmp/h/runtimes/bin/winter"]) })).toEqual({ ok: true, path: "/tmp/h/runtimes/bin/winter", source: "home" });
  });
  test("a configured path that does not exist is NOT skipped silently — it is the failure", () => {
    const r = resolveWinterExecutable({ ...base, setting: "/gone/winter", exists: exists([BUNDLE_WINTER]) });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toBeInstanceOf(WinterExecutableUnavailable); expect(r.error.code).toBe("winter_executable_unavailable"); expect(r.error.tried).toEqual(["/gone/winter"]); }
  });
  test("nothing found → typed failure listing every path tried, never a throw", () => {
    const r = resolveWinterExecutable({ ...base, exists: () => false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.tried).toEqual([BUNDLE_WINTER, "/tmp/h/runtimes/bin/winter"]);
  });

  // Review F-8: two ladder behaviours the brief's five tests left unpinned.

  test("a whitespace-only setting or env value is treated as UNSET, not as a missing path", () => {
    // Both spellings of "configured with nothing": a blank `winterExecutable` in settings.json and
    // an exported-but-empty env var. Neither may become the authoritative-and-missing failure —
    // they fall through to the implicit locations like the absent values they are.
    const r = resolveWinterExecutable({ ...base, setting: "   ", env: { NORMA_WINTER_EXECUTABLE: "\t\n" }, exists: exists([BUNDLE_WINTER]) });
    expect(r).toEqual({ ok: true, path: BUNDLE_WINTER, source: "bundle" });
  });

  test("an ENV path that does not exist is the failure too — not just the setting branch", () => {
    const r = resolveWinterExecutable({ ...base, env: { NORMA_WINTER_EXECUTABLE: "/gone/winter" }, exists: exists([BUNDLE_WINTER, "/tmp/h/runtimes/bin/winter"]) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(WinterExecutableUnavailable);
      // Only the path the user named — the two implicit locations were never probed.
      expect(r.error.tried).toEqual(["/gone/winter"]);
    }
  });

  // P9a-9: the ladder's fifth, LAST rung — the installed platform package.
  describe("the platform-package rung (P9a-9)", () => {
    test("every earlier rung absent + the injected resolver returns a path -> ok, source platform-package", () => {
      const r = resolveWinterExecutable({ ...base, exists: () => false, resolvePlatformPackageBin: () => "/pkg/bin/winter" });
      expect(r).toEqual({ ok: true, path: "/pkg/bin/winter", source: "platform-package" });
    });
    test("an earlier rung (bundle) still wins over the platform package", () => {
      const r = resolveWinterExecutable({ ...base, exists: exists([BUNDLE_WINTER]), resolvePlatformPackageBin: () => "/pkg/bin/winter" });
      expect(r).toEqual({ ok: true, path: BUNDLE_WINTER, source: "bundle" });
    });
    test("home still wins over the platform package", () => {
      const r = resolveWinterExecutable({ ...base, exists: exists(["/tmp/h/runtimes/bin/winter"]), resolvePlatformPackageBin: () => "/pkg/bin/winter" });
      expect(r).toEqual({ ok: true, path: "/tmp/h/runtimes/bin/winter", source: "home" });
    });
    test("an explicit setting/env still wins over the platform package even when it too is configured", () => {
      const r = resolveWinterExecutable({ ...base, setting: "/s/winter", exists: exists(["/s/winter"]), resolvePlatformPackageBin: () => "/pkg/bin/winter" });
      expect(r).toEqual({ ok: true, path: "/s/winter", source: "setting" });
    });
    test("the resolver returning undefined is the typed refusal, naming the platform-package rung", () => {
      const r = resolveWinterExecutable({ ...base, exists: () => false, resolvePlatformPackageBin: () => undefined });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBeInstanceOf(WinterExecutableUnavailable);
        expect(r.error.code).toBe("winter_executable_unavailable");
        // `.tried` stays pure filesystem paths (the package door has no fixed path to report on a
        // miss) — the rung is named in the message text instead.
        expect(r.error.tried).toEqual([BUNDLE_WINTER, "/tmp/h/runtimes/bin/winter"]);
        expect(r.error.message).toMatch(/nor the installed platform package \(@yanlinglabs\/winter-agent-sdk-darwin-arm64\)/);
      }
    });
    test("with no injected resolver, the real resolvePlatformPackageWinter is used and (no package installed in this dev tree) reports the typed refusal", () => {
      // Never depends on a real install — this worktree's dev tree has no
      // `@yanlinglabs/winter-agent-sdk-darwin-arm64` optional dependency installed, which is
      // exactly the "not installed at all" case the real resolver treats as a legitimate skip.
      const r = resolveWinterExecutable({ ...base, exists: () => false });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/nor the installed platform package/);
    });
  });
});

describe("resolvePlatformPackageWinter (P9a-9)", () => {
  test("this dev tree has no @yanlinglabs/winter-agent-sdk-darwin-arm64 optional dependency installed -> undefined, never a throw", () => {
    // The measured M1/M3 shape: on darwin-arm64 the package is only ever present after
    // `bun install` resolves a REAL optional dependency of the wrapper (not published until the
    // v0.0.5 tag) — packages/core carries no such install here, so this exercises the "legitimate
    // skip", never a fixture (per the local-pack procedure's own constraint: tests never depend
    // on the real install).
    expect(resolvePlatformPackageWinter()).toBeUndefined();
  });
});
