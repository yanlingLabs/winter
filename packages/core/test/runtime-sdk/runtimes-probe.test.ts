// Winter Phase 8d — `runRuntimesProbe` runs outside a daemon (`{ execPath, home, env }`), so this
// exercises it against REAL files on disk in a mkdtemp tree — fake, non-Mach-O `winter`/`ant`
// "binaries" (chmod'd text files, since the probe NEVER spawns either — M2). No real winter build, no
// Keychain, no real home.
//
// P9a fix wave (M1 collateral): the ONE seam it does carry, `resolvePlatformPackageBin`, is
// threaded straight through to `resolveWinterExecutable`'s own P9a-9 rung — added so this file's
// own "nothing staged" assertions never depend on whether THIS tree's ambient node_modules happens
// to carry the winter platform package.
//
// WS-23: the official `claude` ladder is gone from the probe; the bundle carries two records now —
// `runtimes/VERSIONS.json` and `ant`'s own `runtimes/ant/VERSIONS.json`.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRuntimesProbe } from "../../src/runtime-sdk/runtimes-probe";
import { antExecutablePath } from "../../src/runtime-sdk/bundle-layout";
import { REQUIRED_WINTER_AGENT_SDK, REQUIRED_WINTER_RUNTIME_SDK } from "../../src/runtime-sdk/versions";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

function goodVersionsJson(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    schema: 2,
    winterAgentSdk: REQUIRED_WINTER_AGENT_SDK,
    winterRuntimeSdk: REQUIRED_WINTER_RUNTIME_SDK,
    checksums: { winterPreSign: "a".repeat(64) },
    stagedAt: "2026-09-25T00:00:00Z",
    ...overrides,
  });
}

const GOOD_ANT_VERSIONS = JSON.stringify({ schema: 1, tag: "v1.32.0", checksums: { antPreSign: "c".repeat(64) }, stagedAt: "2026-09-25T00:00:00Z" });

/** Builds `<resources>/winter-core` + `<resources>/runtimes/{winter,VERSIONS.json,ant/{ant,VERSIONS.json}}`
 *  under a fresh mkdtemp "Resources" dir, returns the `execPath` (the `winter-core` path) a real
 *  daemon would report. `winter`/`ant` are plain chmod'd files (the probe must never spawn either). */
function bundleFixture(opts: { versionsJson?: string | null; ant?: boolean } = {}): { execPath: string; resources: string } {
  const resources = tempDir("runtimes-probe-resources-");
  const execPath = join(resources, "winter-core");
  writeFileSync(execPath, "not a real daemon\n");
  const runtimesDir = join(resources, "runtimes");
  mkdirSync(runtimesDir, { recursive: true });
  writeFileSync(join(runtimesDir, "winter"), "fake winter, never spawned\n");
  chmodSync(join(runtimesDir, "winter"), 0o755);
  if (opts.versionsJson !== null) writeFileSync(join(runtimesDir, "VERSIONS.json"), opts.versionsJson ?? goodVersionsJson());
  if (opts.ant !== false) {
    const antDir = join(runtimesDir, "ant");
    mkdirSync(antDir, { recursive: true });
    writeFileSync(join(antDir, "ant"), "fake ant, never spawned\n");
    chmodSync(join(antDir, "ant"), 0o755);
    writeFileSync(join(antDir, "VERSIONS.json"), GOOD_ANT_VERSIONS);
  }
  return { execPath, resources };
}

describe("runRuntimesProbe (P8d-1 bundle layout, real fs, no daemon)", () => {
  test("a fully staged bundle: winter and ant resolve via 'bundle', ok=true, both records parsed", async () => {
    const { execPath } = bundleFixture();
    const home = tempDir("runtimes-probe-home-");
    const result = await runRuntimesProbe({ execPath, home, env: {} });

    expect(result.winter.source).toBe("bundle");
    expect(result.winter.executable).toBe(true);
    expect(result.versions?.winterAgentSdk).toBe(REQUIRED_WINTER_AGENT_SDK);
    expect(result.antVersions?.tag).toBe("v1.32.0");
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    // WS-23: nothing about the retired leg is probed or reported.
    expect("claude" in result).toBe(false);

    // Winter Phase 10a (P10a-4): ant resolves via the bundle rung too — OPTIONAL, so its absence
    // (tested separately below) never affects `ok`/`errors`.
    expect(result.ant.source).toBe("bundle");
    expect(result.ant.executable).toBe(true);
    expect(result.ant.path).toBe(antExecutablePath(execPath));
  });

  test("ant absent entirely (no bundle, no PATH ant): reported as not executable, but ok/errors are UNAFFECTED — ant is optional", async () => {
    const { execPath } = bundleFixture({ ant: false });
    const home = tempDir("runtimes-probe-home-noant-");
    const result = await runRuntimesProbe({ execPath, home, env: {}, resolveAntWhich: () => null });

    expect(result.ant.path).toBeUndefined();
    expect(result.ant.executable).toBe(false);
    expect(result.antVersions).toBeUndefined();
    expect(result.winter.source).toBe("bundle");
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("nothing staged anywhere → winter is refused (no bundle, no home), errors name what was tried, never a throw", async () => {
    const home = tempDir("runtimes-probe-home-empty-");
    const execPath = join(tempDir("runtimes-probe-resources-empty-"), "winter-core");
    const result = await runRuntimesProbe({ execPath, home, env: {}, resolvePlatformPackageBin: () => undefined });

    expect(result.winter.path).toBeUndefined();
    expect(result.winter.executable).toBe(false);
    expect(result.errors.some((e) => e.includes("winter runtime executable not found"))).toBe(true);
    expect(result.ok).toBe(false);
  }, 15_000);

  test("winter resolves through the HOME rung", async () => {
    const home = tempDir("runtimes-probe-home-winter-");
    mkdirSync(join(home, "runtimes", "bin"), { recursive: true });
    writeFileSync(join(home, "runtimes", "bin", "winter"), "fake\n");
    chmodSync(join(home, "runtimes", "bin", "winter"), 0o755);
    const execPath = join(tempDir("runtimes-probe-resources-homewinter-"), "winter-core");

    const result = await runRuntimesProbe({ execPath, home, env: {} });
    expect(result.winter.source).toBe("home");
    expect(result.winter.executable).toBe(true);
    expect(result.ok).toBe(true);
  }, 15_000);

  test("the env override wins for winter, and a leftover WINTER_CLAUDE_EXECUTABLE is ignored", async () => {
    const { execPath: unusedExecPath } = bundleFixture();
    const envWinter = join(tempDir("runtimes-probe-env-winter-"), "winter-env");
    writeFileSync(envWinter, "fake\n");
    chmodSync(envWinter, 0o755);

    const home = tempDir("runtimes-probe-home-env-");
    const result = await runRuntimesProbe({
      execPath: unusedExecPath,
      home,
      env: { WINTER_RUNTIME_EXECUTABLE: envWinter, WINTER_CLAUDE_EXECUTABLE: "/nowhere/claude" },
    });
    expect(result.winter.path).toBe(envWinter);
    expect(result.winter.source).toBe("env");
    expect(result.winter.executable).toBe(true);
    expect(JSON.stringify(result)).not.toContain("/nowhere/claude");
  });

  test("a MISMATCHED runtimes record: the error names it, never a silent pass — and winter still resolves", async () => {
    const { execPath } = bundleFixture({ versionsJson: goodVersionsJson({ winterRuntimeSdk: "0.0.999" }) });
    const home = tempDir("runtimes-probe-home-mismatch-");
    const result = await runRuntimesProbe({ execPath, home, env: {} });

    expect(result.versions).toBeUndefined();
    expect(result.errors.some((e) => e.includes("0.0.999"))).toBe(true);
    expect(result.winter.source).toBe("bundle");
  });

  test("no runtimes record at all: versions omitted, never an error by itself", async () => {
    const { execPath } = bundleFixture({ versionsJson: null });
    const home = tempDir("runtimes-probe-home-noversions-");
    const result = await runRuntimesProbe({ execPath, home, env: {} });

    expect(result.versions).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  test("never spawns winter (M2): a winter 'binary' that is not a valid executable format still reports executable=true (X_OK only) with no crash", async () => {
    const { execPath } = bundleFixture();
    const home = tempDir("runtimes-probe-home-neverspawn-");
    const result = await runRuntimesProbe({ execPath, home, env: {} });
    expect(result.winter.executable).toBe(true);
    expect(result.winter.signature === undefined || typeof result.winter.signature === "string").toBe(true);
  });
});
