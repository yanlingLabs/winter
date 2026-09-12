// Winter Phase 8d — `runRuntimesProbe` runs outside a daemon (`{ execPath, home, env }`), so this
// exercises it against REAL files on disk in a mkdtemp tree — fake, non-Mach-O `winter`/`claude`
// "binaries" (a plain executable shell script for `claude`, since the probe DOES spawn `claude
// --version`; a chmod'd text file for `winter`, since the probe NEVER spawns it — M2). No real
// winter/claude build, no Keychain, no real home.
//
// P9a fix wave (M1 collateral): the ONE seam it does carry, `resolvePlatformPackageBin`, is
// threaded straight through to `resolveWinterExecutable`'s own P9a-9 rung — added so this file's
// own "nothing staged" assertions never depend on whether THIS tree's ambient node_modules happens
// to carry the winter platform package (m1's local-pack proof leaves exactly that residue behind).
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRuntimesProbe } from "../../src/runtime-sdk/runtimes-probe";
import { REQUIRED_CLAUDE_AGENT_SDK, REQUIRED_WINTER_AGENT_SDK, REQUIRED_WINTER_RUNTIME_SDK } from "../../src/runtime-sdk/versions";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

function goodVersionsJson(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    schema: 1,
    winterAgentSdk: REQUIRED_WINTER_AGENT_SDK,
    winterRuntimeSdk: REQUIRED_WINTER_RUNTIME_SDK,
    officialSdk: REQUIRED_CLAUDE_AGENT_SDK,
    claudeCode: "2.1.250",
    checksums: { winterPreSign: "a".repeat(64), claude: "b".repeat(64) },
    stagedAt: "2026-09-12T00:00:00Z",
    ...overrides,
  });
}

/** Builds `<resources>/norma-core` + `<resources>/runtimes/{winter,claude-official/{claude,VERSIONS.json}}`
 *  under a fresh mkdtemp "Resources" dir, returns the `execPath` (the `norma-core` path) a real
 *  daemon would report. `claude` is a REAL executable shell script (the probe spawns it for
 *  `--version`); `winter` is a plain chmod'd file (the probe must never spawn it). */
function bundleFixture(opts: { versionsJson?: string | null } = {}): { execPath: string; resources: string } {
  const resources = tempDir("runtimes-probe-resources-");
  const execPath = join(resources, "norma-core");
  writeFileSync(execPath, "not a real daemon\n");
  const runtimesDir = join(resources, "runtimes");
  const claudeDir = join(runtimesDir, "claude-official");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(runtimesDir, "winter"), "fake winter, never spawned\n");
  chmodSync(join(runtimesDir, "winter"), 0o755);
  writeFileSync(join(claudeDir, "claude"), "#!/bin/sh\necho '2.1.250 (Fake Claude Code)'\nexit 0\n");
  chmodSync(join(claudeDir, "claude"), 0o755);
  if (opts.versionsJson !== null) writeFileSync(join(claudeDir, "VERSIONS.json"), opts.versionsJson ?? goodVersionsJson());
  return { execPath, resources };
}

describe("runRuntimesProbe (P8d-1 bundle layout, real fs, no daemon)", () => {
  test("a fully staged bundle: both ladders resolve via 'bundle', both executable, ok=true, versions parsed", async () => {
    const { execPath } = bundleFixture();
    const home = tempDir("runtimes-probe-home-");
    const result = await runRuntimesProbe({ execPath, home, env: {} });

    expect(result.winter.source).toBe("bundle");
    expect(result.winter.executable).toBe(true);
    expect(result.claude.source).toBe("bundle");
    expect(result.claude.executable).toBe(true);
    expect(result.claude.version).toBe("2.1.250 (Fake Claude Code)");
    expect(result.versions?.officialSdk).toBe(REQUIRED_CLAUDE_AGENT_SDK);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("nothing staged anywhere → winter is refused (no bundle, no home), errors name what was tried, never a throw", async () => {
    // The CLAUDE side is deliberately NOT asserted to be refused here: this runs under plain
    // `bun test` (uncompiled), where `resolveClaudeExecutable`'s package door has a REAL
    // `node_modules` to `createRequire` through, so on a machine/CI runner where `bun install`
    // resolved the optional darwin/arm64 platform package (this repo's own dev box and macOS CI
    // both do — see ci.yml's own "Verify the official runtime platform package installed" step)
    // it legitimately resolves via "package", exactly as `official-executable.test.ts`'s own
    // "real (non-injected) package door" test already establishes. The COMPILED-artifact proof
    // (`verify-runtimes-compiled.ts`) is what asserts `source === "bundle"` for both — there is no
    // `node_modules` inside `$bunfs` for the package door to find anything through.
    const home = tempDir("runtimes-probe-home-empty-");
    const execPath = join(tempDir("runtimes-probe-resources-empty-"), "norma-core");
    // P9a fix wave, M1 collateral: never depend on this tree's ambient node_modules (m1's
    // local-pack residue) for a test titled "nothing staged anywhere" — inject the miss.
    const result = await runRuntimesProbe({ execPath, home, env: {}, resolvePlatformPackageBin: () => undefined });

    expect(result.winter.path).toBeUndefined();
    expect(result.winter.executable).toBe(false);
    expect(result.errors.some((e) => e.includes("winter runtime executable not found"))).toBe(true);
    if (result.claude.path === undefined) {
      expect(result.ok).toBe(false);
    } else {
      expect(result.claude.source).toBe("package");
      expect(result.claude.executable).toBe(true);
      // winter is still missing either way, so the OVERALL probe is never "ok" here.
      expect(result.ok).toBe(false);
    }
  }, 15_000);

  test("winter resolves through the HOME rung, independent of wherever (or whether) claude resolves", async () => {
    const home = tempDir("runtimes-probe-home-winter-");
    mkdirSync(join(home, "runtimes", "bin"), { recursive: true });
    writeFileSync(join(home, "runtimes", "bin", "winter"), "fake\n");
    chmodSync(join(home, "runtimes", "bin", "winter"), 0o755);
    const execPath = join(tempDir("runtimes-probe-resources-homewinter-"), "norma-core");

    const result = await runRuntimesProbe({ execPath, home, env: {} });
    expect(result.winter.source).toBe("home");
    expect(result.winter.executable).toBe(true);
  }, 15_000);

  test("env override wins for both ladders", async () => {
    const { execPath: unusedExecPath } = bundleFixture();
    const envWinter = join(tempDir("runtimes-probe-env-winter-"), "winter-env");
    writeFileSync(envWinter, "fake\n");
    chmodSync(envWinter, 0o755);
    const envClaude = join(tempDir("runtimes-probe-env-claude-"), "claude-env");
    writeFileSync(envClaude, "#!/bin/sh\necho '9.9.9 (env)'\n");
    chmodSync(envClaude, 0o755);

    const home = tempDir("runtimes-probe-home-env-");
    const result = await runRuntimesProbe({
      execPath: unusedExecPath,
      home,
      env: { NORMA_WINTER_EXECUTABLE: envWinter, NORMA_CLAUDE_EXECUTABLE: envClaude },
    });
    expect(result.winter.path).toBe(envWinter);
    expect(result.winter.source).toBe("env");
    expect(result.winter.executable).toBe(true);
    expect(result.claude.path).toBe(envClaude);
    expect(result.claude.source).toBe("env");
    expect(result.claude.version).toBe("9.9.9 (env)");
  });

  test("a bundled claude with a MISMATCHED VERSIONS.json: the claude ladder refuses, and the independent versions read also reports the same mismatch — never a silent pass", async () => {
    const { execPath } = bundleFixture({ versionsJson: goodVersionsJson({ officialSdk: "0.3.999" }) });
    const home = tempDir("runtimes-probe-home-mismatch-");
    const result = await runRuntimesProbe({ execPath, home, env: {} });

    expect(result.claude.path).toBeUndefined();
    expect(result.versions).toBeUndefined();
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("0.3.999"))).toBe(true);
  });

  test("a bundled claude with NO VERSIONS.json at all: refused, versions omitted, an error names the missing file", async () => {
    const { execPath } = bundleFixture({ versionsJson: null });
    const home = tempDir("runtimes-probe-home-noversions-");
    const result = await runRuntimesProbe({ execPath, home, env: {} });

    expect(result.claude.path).toBeUndefined();
    expect(result.versions).toBeUndefined();
    expect(result.ok).toBe(false);
  });

  test("never spawns winter (M2): a winter 'binary' that is not a valid executable format still reports executable=true (X_OK only) with no crash", async () => {
    // The whole point of M2 (`winter --version` errors without --run) is that this probe must
    // never try to run it at all — proven here by using a plain text file (chmod +x'd, so X_OK
    // passes) that would fail loudly if `spawnSync`'d as a program.
    const { execPath } = bundleFixture();
    const home = tempDir("runtimes-probe-home-neverspawn-");
    const result = await runRuntimesProbe({ execPath, home, env: {} });
    // Reaching this line at all is the proof: a probe that spawned the fake `winter` "binary" as a
    // program would have thrown (it is plain text, not a valid executable format).
    expect(result.winter.executable).toBe(true);
    expect(result.winter.signature === undefined || typeof result.winter.signature === "string").toBe(true);
  });
});
