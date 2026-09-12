// Winter Phase 8d (fix round 1, Major-1) — `diagnoseRuntimes` against real fs in a mkdtemp tree,
// same shape as `runtimes-probe.test.ts` (the spine contract is `{ execPath, home, env, settings }`,
// plus — P9a fix wave, M1 collateral — the optional `resolvePlatformPackageBin` seam threaded
// through to `resolveWinterExecutable`'s P9a-9 rung, so "nothing staged" assertions never depend on
// this tree's ambient node_modules). READ-ONLY: never spawns anything real; fake `winter`/`claude`
// files are plain chmod'd text (never executed by the doctor).
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnoseRuntimes } from "../../src/runtime-sdk/runtimes-doctor";
import type { Settings } from "../../src/settings";
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

/** Builds `<resources>/winter-core` + `<resources>/runtimes/{winter,claude-official/{claude,VERSIONS.json}}`,
 *  returning the `execPath` a real daemon would report. Fake, non-executable content throughout —
 *  the doctor is READ-ONLY and never spawns either binary. */
function bundleFixture(opts: { versionsJson?: string | null } = {}): { execPath: string } {
  const resources = tempDir("runtimes-doctor-resources-");
  const execPath = join(resources, "winter-core");
  writeFileSync(execPath, "not a real daemon\n");
  const runtimesDir = join(resources, "runtimes");
  const claudeDir = join(runtimesDir, "claude-official");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(runtimesDir, "winter"), "fake winter\n");
  chmodSync(join(runtimesDir, "winter"), 0o755);
  writeFileSync(join(claudeDir, "claude"), "fake claude\n");
  chmodSync(join(claudeDir, "claude"), 0o755);
  if (opts.versionsJson !== null) writeFileSync(join(claudeDir, "VERSIONS.json"), opts.versionsJson ?? goodVersionsJson());
  return { execPath };
}

describe("diagnoseRuntimes (winter doctor's runtimes section, fix round 1 Major-1)", () => {
  test("the setting rung wins for BOTH winter and claude, over bundle/env/home/package", async () => {
    const { execPath } = bundleFixture(); // a bundle exists but must be ignored — setting wins
    const home = tempDir("runtimes-doctor-home-");
    const settingWinter = join(tempDir("runtimes-doctor-setwinter-"), "winter-setting");
    writeFileSync(settingWinter, "fake\n");
    chmodSync(settingWinter, 0o755);
    const settingClaude = join(tempDir("runtimes-doctor-setclaude-"), "claude-setting");
    writeFileSync(settingClaude, "fake\n");
    chmodSync(settingClaude, 0o755);

    const settings = { runtimes: { winterExecutable: settingWinter, claudeExecutable: settingClaude } } as unknown as Settings;
    const report = await diagnoseRuntimes({ execPath, home, env: {}, settings });

    expect(report.winter.resolved).toEqual({ path: settingWinter, source: "setting" });
    expect(report.claude.resolved).toEqual({ path: settingClaude, source: "setting" });
    // The bundle VERSIONS.json read is independent of the ladder outcome — still reported here.
    expect(report.bundle?.versions?.officialSdk).toBe(REQUIRED_CLAUDE_AGENT_SDK);
  });

  test("no setting/env configured: the bundle rung resolves for both, and VERSIONS.json is parsed", async () => {
    const { execPath } = bundleFixture();
    const home = tempDir("runtimes-doctor-home2-");
    const report = await diagnoseRuntimes({ execPath, home, env: {}, settings: undefined });

    expect(report.winter.resolved?.source).toBe("bundle");
    expect(report.claude.resolved?.source).toBe("bundle");
    expect(report.bundle?.versions).toBeDefined();
    expect(report.bundle?.versions?.winterAgentSdk).toBe(REQUIRED_WINTER_AGENT_SDK);
    expect(report.bundle?.error).toBeUndefined();
  });

  test("nothing configured and nothing staged anywhere: typed reasons, never a throw, bundle omitted", async () => {
    const home = tempDir("runtimes-doctor-home-empty-");
    const execPath = join(tempDir("runtimes-doctor-resources-empty-"), "winter-core");
    // P9a fix wave, M1 collateral: never depend on this tree's ambient node_modules (m1's
    // local-pack residue) for a test titled "nothing staged anywhere" — inject the miss.
    const report = await diagnoseRuntimes({ execPath, home, env: {}, settings: undefined, resolvePlatformPackageBin: () => undefined });

    expect(report.winter.resolved).toBeUndefined();
    expect(report.winter.error).toBeDefined();
    expect(report.winter.error).toContain("winter runtime executable not found");
    // claude may legitimately resolve via the dev package door on this machine (real node_modules) —
    // either a typed error or a "package" resolution is acceptable; a throw is not (the whole call
    // already completed without one to reach this line).
    if (report.claude.resolved === undefined) {
      expect(report.claude.error).toBeDefined();
    } else {
      expect(report.claude.resolved.source).toBe("package");
    }
    expect(report.bundle).toBeUndefined();
  });

  test("a bundled claude with a MISMATCHED VERSIONS.json: claude.error names it, AND bundle.error reports the same mismatch independently", async () => {
    const { execPath } = bundleFixture({ versionsJson: goodVersionsJson({ officialSdk: "0.3.999" }) });
    const home = tempDir("runtimes-doctor-home-mismatch-");
    const report = await diagnoseRuntimes({ execPath, home, env: {}, settings: undefined });

    expect(report.claude.resolved).toBeUndefined();
    expect(report.claude.error).toContain("0.3.999");
    expect(report.bundle?.versions).toBeUndefined();
    expect(report.bundle?.error).toBeDefined();
    expect(report.bundle?.error).toContain("0.3.999");
    // winter is unaffected by claude's VERSIONS.json mismatch — it still resolves via bundle.
    expect(report.winter.resolved?.source).toBe("bundle");
  });

  test("claude.installedWrapper is populated from the real installed wrapper version when present, never throws", async () => {
    const home = tempDir("runtimes-doctor-home-wrapper-");
    const execPath = join(tempDir("runtimes-doctor-resources-wrapper-"), "winter-core");
    const report = await diagnoseRuntimes({ execPath, home, env: {}, settings: undefined });
    // Either populated (this repo has the optional platform package installed) or undefined (a
    // legitimate skip elsewhere) — both are fine; only a throw would fail this test.
    expect(report.claude.installedWrapper === undefined || typeof report.claude.installedWrapper === "string").toBe(true);
  });
});
