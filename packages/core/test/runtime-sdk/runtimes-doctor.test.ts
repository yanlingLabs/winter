// Winter Phase 8d (fix round 1, Major-1) — `diagnoseRuntimes` against real fs in a mkdtemp tree,
// same shape as `runtimes-probe.test.ts` (the spine contract is `{ execPath, home, env, settings }`,
// plus — P9a fix wave, M1 collateral — the optional `resolvePlatformPackageBin` seam threaded
// through to `resolveWinterExecutable`'s P9a-9 rung, so "nothing staged" assertions never depend on
// this tree's ambient node_modules). READ-ONLY: never spawns anything real; a fake `winter` is plain
// chmod'd text (never executed by the doctor).
//
// WS-23: the official `claude` ladder is gone from the doctor; the bundle carries two records now —
// `runtimes/VERSIONS.json` and `ant`'s own `runtimes/ant/VERSIONS.json`.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnoseRuntimes } from "../../src/runtime-sdk/runtimes-doctor";
import type { Settings } from "../../src/settings";
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

/** Builds `<resources>/winter-core` + `<resources>/runtimes/{winter,VERSIONS.json,ant/VERSIONS.json}`,
 *  returning the `execPath` a real daemon would report. Fake, non-executable content throughout —
 *  the doctor is READ-ONLY and never spawns a binary. */
function bundleFixture(opts: { versionsJson?: string | null; antVersionsJson?: string | null } = {}): { execPath: string } {
  const resources = tempDir("runtimes-doctor-resources-");
  const execPath = join(resources, "winter-core");
  writeFileSync(execPath, "not a real daemon\n");
  const runtimesDir = join(resources, "runtimes");
  mkdirSync(join(runtimesDir, "ant"), { recursive: true });
  writeFileSync(join(runtimesDir, "winter"), "fake winter\n");
  chmodSync(join(runtimesDir, "winter"), 0o755);
  if (opts.versionsJson !== null) writeFileSync(join(runtimesDir, "VERSIONS.json"), opts.versionsJson ?? goodVersionsJson());
  if (opts.antVersionsJson !== null) writeFileSync(join(runtimesDir, "ant", "VERSIONS.json"), opts.antVersionsJson ?? GOOD_ANT_VERSIONS);
  return { execPath };
}

describe("diagnoseRuntimes (winter doctor's runtimes section, fix round 1 Major-1)", () => {
  test("the setting rung wins for winter, over bundle/env/home/package", async () => {
    const { execPath } = bundleFixture(); // a bundle exists but must be ignored — setting wins
    const home = tempDir("runtimes-doctor-home-");
    const settingWinter = join(tempDir("runtimes-doctor-setwinter-"), "winter-setting");
    writeFileSync(settingWinter, "fake\n");
    chmodSync(settingWinter, 0o755);

    const settings = { runtimes: { winterExecutable: settingWinter } } as unknown as Settings;
    const report = await diagnoseRuntimes({ execPath, home, env: {}, settings });

    expect(report.winter.resolved).toEqual({ path: settingWinter, source: "setting" });
    // The bundle records are read independently of the ladder outcome — still reported here.
    expect(report.bundle?.versions?.winterAgentSdk).toBe(REQUIRED_WINTER_AGENT_SDK);
  });

  test("no setting/env configured: the bundle rung resolves, and both records are parsed", async () => {
    const { execPath } = bundleFixture();
    const home = tempDir("runtimes-doctor-home2-");
    const report = await diagnoseRuntimes({ execPath, home, env: {}, settings: undefined });

    expect(report.winter.resolved?.source).toBe("bundle");
    expect(report.bundle?.versions?.winterAgentSdk).toBe(REQUIRED_WINTER_AGENT_SDK);
    expect(report.bundle?.antVersions?.tag).toBe("v1.32.0");
    expect(report.bundle?.error).toBeUndefined();
    // WS-23: nothing about the retired leg is reported at all.
    expect("claude" in report).toBe(false);
  });

  test("a stale `runtimes.claudeExecutable` setting is ignored — the doctor reports winter alone", async () => {
    const { execPath } = bundleFixture();
    const home = tempDir("runtimes-doctor-home-stale-");
    const settings = { runtimes: { claudeExecutable: "/nowhere/claude" } } as unknown as Settings;
    const report = await diagnoseRuntimes({ execPath, home, env: {}, settings });
    expect(report.winter.resolved?.source).toBe("bundle");
    expect(JSON.stringify(report)).not.toContain("/nowhere/claude");
  });

  test("nothing configured and nothing staged anywhere: a typed reason, never a throw, bundle omitted", async () => {
    const home = tempDir("runtimes-doctor-home-empty-");
    const execPath = join(tempDir("runtimes-doctor-resources-empty-"), "winter-core");
    // P9a fix wave, M1 collateral: never depend on this tree's ambient node_modules for a test titled
    // "nothing staged anywhere" — inject the miss.
    const report = await diagnoseRuntimes({ execPath, home, env: {}, settings: undefined, resolvePlatformPackageBin: () => undefined });

    expect(report.winter.resolved).toBeUndefined();
    expect(report.winter.error).toContain("winter runtime executable not found");
    expect(report.bundle).toBeUndefined();
  });

  test("a MISMATCHED runtimes record: bundle.error names it, and winter still resolves", async () => {
    const { execPath } = bundleFixture({ versionsJson: goodVersionsJson({ winterRuntimeSdk: "0.0.999" }) });
    const home = tempDir("runtimes-doctor-home-mismatch-");
    const report = await diagnoseRuntimes({ execPath, home, env: {}, settings: undefined });

    expect(report.bundle?.versions).toBeUndefined();
    expect(report.bundle?.error).toContain("0.0.999");
    // ant's own record is independent of the runtimes record's verdict.
    expect(report.bundle?.antVersions?.tag).toBe("v1.32.0");
    expect(report.winter.resolved?.source).toBe("bundle");
  });

  test("a pre-WS-23 bundle (only the schema-1 record, at the NEW path) is reported as an error, never parsed as current", async () => {
    const legacy = JSON.stringify({ schema: 1, winterAgentSdk: REQUIRED_WINTER_AGENT_SDK, winterRuntimeSdk: REQUIRED_WINTER_RUNTIME_SDK, officialSdk: "0.3.250", claudeCode: "2.1.250", checksums: { winterPreSign: "a".repeat(64), claude: "b".repeat(64) }, stagedAt: "x" });
    const { execPath } = bundleFixture({ versionsJson: legacy, antVersionsJson: null });
    const report = await diagnoseRuntimes({ execPath, home: tempDir("runtimes-doctor-home-legacy-"), env: {}, settings: undefined });
    expect(report.bundle?.versions).toBeUndefined();
    expect(report.bundle?.error).toContain("schema 1");
  });

  test("a malformed ant record: bundle.error names it without dropping the runtimes record", async () => {
    const { execPath } = bundleFixture({ antVersionsJson: JSON.stringify({ schema: 1, tag: "v1", checksums: { antPreSign: "nope" }, stagedAt: "x" }) });
    const report = await diagnoseRuntimes({ execPath, home: tempDir("runtimes-doctor-home-badant-"), env: {}, settings: undefined });
    expect(report.bundle?.versions?.winterAgentSdk).toBe(REQUIRED_WINTER_AGENT_SDK);
    expect(report.bundle?.antVersions).toBeUndefined();
    expect(report.bundle?.error).toContain("antPreSign");
  });
});
