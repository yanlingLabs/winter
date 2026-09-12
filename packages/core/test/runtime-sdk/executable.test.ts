import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePlatformPackageWinter, resolveWinterExecutable, WinterExecutableUnavailable } from "../../src/runtime-sdk/executable";
import { bundleRuntimePath } from "../../src/runtime-sdk/bundle-layout";
import { REQUIRED_WINTER_AGENT_SDK } from "../../src/runtime-sdk/versions";

const exists = (set: string[]) => (p: string) => set.includes(p);
const base = { env: {}, execPath: "/bundle/Contents/MacOS/winter-core", home: "/tmp/h" };
// P8d-1: the bundle rung moved under `Resources/runtimes/` — this is that exact path for `base`.
const BUNDLE_WINTER = bundleRuntimePath(base.execPath, "winter");

describe("resolveWinterExecutable (P8b-2 ladder, P8d-1 bundle layout)", () => {
  test("setting wins over everything", () => {
    const r = resolveWinterExecutable({ ...base, setting: "/s/winter", env: { WINTER_RUNTIME_EXECUTABLE: "/e/winter" }, exists: exists(["/s/winter", "/e/winter"]) });
    expect(r).toEqual({ ok: true, path: "/s/winter", source: "setting" });
  });
  test("env beats bundle and home", () => {
    const r = resolveWinterExecutable({ ...base, env: { WINTER_RUNTIME_EXECUTABLE: "/e/winter" }, exists: exists(["/e/winter", BUNDLE_WINTER]) });
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
    // P9a fix wave, M1: this is a pre-existing P8b-2 test about the FILESYSTEM ladder only — it
    // must not become environment-dependent on whether this tree happens to have the platform
    // package installed (it does, once m1's local-pack proof stages one). Inject the miss
    // explicitly so this test is about the fs rungs, never the package rung.
    const r = resolveWinterExecutable({ ...base, exists: () => false, resolvePlatformPackageBin: () => undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.tried).toEqual([BUNDLE_WINTER, "/tmp/h/runtimes/bin/winter"]);
  });

  // Review F-8: two ladder behaviours the brief's five tests left unpinned.

  test("a whitespace-only setting or env value is treated as UNSET, not as a missing path", () => {
    // Both spellings of "configured with nothing": a blank `winterExecutable` in settings.json and
    // an exported-but-empty env var. Neither may become the authoritative-and-missing failure —
    // they fall through to the implicit locations like the absent values they are.
    const r = resolveWinterExecutable({ ...base, setting: "   ", env: { WINTER_RUNTIME_EXECUTABLE: "\t\n" }, exists: exists([BUNDLE_WINTER]) });
    expect(r).toEqual({ ok: true, path: BUNDLE_WINTER, source: "bundle" });
  });

  test("an ENV path that does not exist is the failure too — not just the setting branch", () => {
    const r = resolveWinterExecutable({ ...base, env: { WINTER_RUNTIME_EXECUTABLE: "/gone/winter" }, exists: exists([BUNDLE_WINTER, "/tmp/h/runtimes/bin/winter"]) });
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
    test("the injected resolver reporting absent is the same refusal a real miss would produce (never ambient — M1)", () => {
      // P9a fix wave, M1: this test USED TO omit `resolvePlatformPackageBin` entirely and rely on
      // the real `resolvePlatformPackageWinter()` finding nothing in this dev tree — which is
      // exactly the ambient-environment dependency that went RED the moment a local-pack proof (or
      // m1's staged residue) put a real package in this worktree's node_modules. The "real resolver,
      // planted fixture" half of that coverage now lives in the `resolvePlatformPackageWinter`
      // describe block below (which roots the resolution in a throwaway fixture instead of the
      // ambient tree); this test stays about the ladder's own refusal wiring, injected like every
      // other test in this block.
      const r = resolveWinterExecutable({ ...base, exists: () => false, resolvePlatformPackageBin: () => undefined });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/nor the installed platform package/);
    });
  });
});

// P9a fix wave, C1/M1/M2: `resolvePlatformPackageWinter` is exercised against PLANTED fixture
// roots via its `fromUrl` parameter — never against the ambient tree (M1's "never against the
// ambient tree" instruction) — so these tests pass identically in a tree with the platform
// package installed and in one without, regardless of what m1's local-pack proof leaves behind.
describe("resolvePlatformPackageWinter (P9a-9, fix wave C1/M2)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()!();
  });

  /** A module location with no `node_modules` ancestry at all (a fresh mkdtemp root with only the
   *  probe module's own directory created) — the "not installed at all" legitimate-skip shape,
   *  proven through a real fixture rather than by trusting the ambient dev tree. */
  function emptyFixture(): string {
    const root = mkdtempSync(join(tmpdir(), "winter-p9a-empty-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const probeDir = join(root, "packages", "core", "src", "runtime-sdk");
    mkdirSync(probeDir, { recursive: true });
    return pathToFileURL(join(probeDir, "probe.ts")).href;
  }

  /**
   * Bun's ISOLATED-LINKER shape (C1's exact production layout, copied from the real
   * `node_modules/.bun/@anthropic-ai+claude-agent-sdk@…/` store entry): the platform package is an
   * optional dependency of the WRAPPER, nested under the wrapper's OWN store entry —
   * `<root>/node_modules/.bun/@yanlinglabs+winter-agent-sdk@<ver>/node_modules/@yanlinglabs/{winter-agent-sdk,winter-agent-sdk-darwin-arm64}`
   * — with only the wrapper itself (never the platform package) linked at the top-level
   * `<root>/node_modules/@yanlinglabs/winter-agent-sdk`. A single-hop `createRequire` rooted at the
   * probe module walks straight past the platform package here; only the dual hop reaches it.
   */
  function nestedFixture(opts: { wrapperVersion?: string; platformVersion?: string; binPresent?: boolean } = {}): string {
    const wrapperVersion = opts.wrapperVersion ?? REQUIRED_WINTER_AGENT_SDK;
    const platformVersion = opts.platformVersion ?? REQUIRED_WINTER_AGENT_SDK;
    const binPresent = opts.binPresent ?? true;
    const root = mkdtempSync(join(tmpdir(), "winter-p9a-nested-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const storeScope = join(root, "node_modules", ".bun", `@yanlinglabs+winter-agent-sdk@${wrapperVersion}`, "node_modules", "@yanlinglabs");
    const wrapperDir = join(storeScope, "winter-agent-sdk");
    const platformDir = join(storeScope, "winter-agent-sdk-darwin-arm64");
    mkdirSync(join(platformDir, "bin"), { recursive: true });
    mkdirSync(wrapperDir, { recursive: true });
    writeFileSync(join(wrapperDir, "package.json"), JSON.stringify({ name: "@yanlinglabs/winter-agent-sdk", version: wrapperVersion }));
    writeFileSync(join(platformDir, "package.json"), JSON.stringify({ name: "@yanlinglabs/winter-agent-sdk-darwin-arm64", version: platformVersion }));
    if (binPresent) writeFileSync(join(platformDir, "bin", "winter"), "#!/bin/sh\necho fixture\n", { mode: 0o755 });
    // The top-level node_modules/@yanlinglabs/ holds ONLY the wrapper (bun's real isolated-linker
    // shape: a direct dependency is linked at the top level, an optional dependency of THAT
    // dependency is not) — a symlink back into the store entry, exactly as `readlink` on the real
    // installed tree shows.
    const topScope = join(root, "node_modules", "@yanlinglabs");
    mkdirSync(topScope, { recursive: true });
    symlinkSync(wrapperDir, join(topScope, "winter-agent-sdk"), "dir");
    const probeDir = join(root, "packages", "core", "src", "runtime-sdk");
    mkdirSync(probeDir, { recursive: true });
    return pathToFileURL(join(probeDir, "probe.ts")).href;
  }

  /** The single-hop DIRECT-install dev shape (Lane N's local-pack procedure: `bun add
   *  ./<tarball> --optional` run directly IN packages/core) — the platform package sits at the
   *  top level of `node_modules`, no wrapper store entry involved at all. */
  function directFixture(opts: { platformVersion?: string; binPresent?: boolean } = {}): string {
    const platformVersion = opts.platformVersion ?? REQUIRED_WINTER_AGENT_SDK;
    const binPresent = opts.binPresent ?? true;
    const root = mkdtempSync(join(tmpdir(), "winter-p9a-direct-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const platformDir = join(root, "node_modules", "@yanlinglabs", "winter-agent-sdk-darwin-arm64");
    mkdirSync(join(platformDir, "bin"), { recursive: true });
    writeFileSync(join(platformDir, "package.json"), JSON.stringify({ name: "@yanlinglabs/winter-agent-sdk-darwin-arm64", version: platformVersion }));
    if (binPresent) writeFileSync(join(platformDir, "bin", "winter"), "#!/bin/sh\necho fixture\n", { mode: 0o755 });
    const probeDir = join(root, "packages", "core", "src", "runtime-sdk");
    mkdirSync(probeDir, { recursive: true });
    return pathToFileURL(join(probeDir, "probe.ts")).href;
  }

  test("an empty fixture root (no node_modules ancestry) -> undefined, never a throw", () => {
    expect(resolvePlatformPackageWinter(emptyFixture())).toBeUndefined();
  });

  test("C1: the nested bun-isolated-linker shape (platform package under the WRAPPER's own store entry) resolves via the dual hop", () => {
    const fromUrl = nestedFixture();
    const bin = resolvePlatformPackageWinter(fromUrl);
    expect(bin).toBeDefined();
    expect(bin).toMatch(/winter-agent-sdk-darwin-arm64[\\/]bin[\\/]winter$/);
  });

  test("C1: a direct top-level install (no wrapper store entry at all) still resolves via the single-hop fallback", () => {
    const fromUrl = directFixture();
    const bin = resolvePlatformPackageWinter(fromUrl);
    expect(bin).toBeDefined();
    expect(bin).toMatch(/winter-agent-sdk-darwin-arm64[\\/]bin[\\/]winter$/);
  });

  test("the nested shape with no bin/winter file -> undefined (package present, binary absent — M1 measurement)", () => {
    const fromUrl = nestedFixture({ binPresent: false });
    expect(resolvePlatformPackageWinter(fromUrl)).toBeUndefined();
  });

  test("M2: a nested platform package whose version disagrees with REQUIRED_WINTER_AGENT_SDK throws, naming both versions", () => {
    const fromUrl = nestedFixture({ platformVersion: "9.9.9" });
    expect(() => resolvePlatformPackageWinter(fromUrl)).toThrow(
      new RegExp(`winter 9\\.9\\.9 but this build is pinned to ${REQUIRED_WINTER_AGENT_SDK.replace(/\./g, "\\.")}`),
    );
  });

  test("M2: a direct-install platform package whose version disagrees with the pin throws too — not just the nested door", () => {
    const fromUrl = directFixture({ platformVersion: "0.0.1" });
    expect(() => resolvePlatformPackageWinter(fromUrl)).toThrow(/winter 0\.0\.1 but this build is pinned to/);
  });

  test("M2: a version-mismatched platform package surfaces through resolveWinterExecutable as the typed refusal naming both versions", () => {
    const fromUrl = nestedFixture({ platformVersion: "1.2.3" });
    const r = resolveWinterExecutable({ ...base, exists: () => false, resolvePlatformPackageBin: () => resolvePlatformPackageWinter(fromUrl) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(WinterExecutableUnavailable);
      expect(r.error.code).toBe("winter_executable_unavailable");
      expect(r.error.message).toMatch(new RegExp(`winter 1\\.2\\.3 but this build is pinned to ${REQUIRED_WINTER_AGENT_SDK.replace(/\./g, "\\.")}`));
    }
  });

  test("this dev tree's own ambient default (no fromUrl override) never throws — belt-and-suspenders, not the door's real coverage", () => {
    // The real coverage for "installed" vs "not installed" lives in the fixture tests above (M1:
    // never assert against the ambient tree). This just proves the zero-arg default keeps working
    // as a function signature (fromUrl defaults to import.meta.url) without asserting what it
    // finds — this worktree's ambient node_modules may or may not carry m1's staged residue.
    expect(() => resolvePlatformPackageWinter()).not.toThrow();
  });
});
