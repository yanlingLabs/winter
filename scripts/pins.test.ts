// Winter Phase 8d (P8d-16), P9a-8 — pin-consistency tripwire. `.github/workflows/ci.yml`'s
// retired `winter-binary` job used to hardcode `ref: v0.0.4` (the pinned-tag checkout) AND
// `name: winter-v0.0.4` (the uploaded artifact) as two separate literals — and
// `packages/core/package.json`'s own SDK version ranges are a THIRD place the same pin could
// silently drift from `packages/core/src/runtime-sdk/versions.ts`'s `REQUIRED_*` constants (it
// happened once already, in 8c's spine). This test is the tripwire for both directions.
//
// P9a-8: the uploaded/downloaded ARTIFACT is gone (winter's source is the installed npm platform
// package now) — that derivation test is DROPPED, never made conditional, since there is no
// artifact name left anywhere to derive. The pinned-tag checkout REF still appears, but only
// inside each job's dated FALLBACK block (test-core/test-cli/verify — P9a-8, removed at the
// 0.0.5 pin flip); that test's own comment is updated to say so, never widened or weakened.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REQUIRED_CLAUDE_AGENT_SDK, REQUIRED_WINTER_AGENT_SDK, REQUIRED_WINTER_RUNTIME_SDK } from "../packages/core/src/runtime-sdk/versions";

const REPO_ROOT = join(import.meta.dir, "..");
const CI_YML = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
const CORE_PACKAGE_JSON = JSON.parse(readFileSync(join(REPO_ROOT, "packages", "core", "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};
/** `bun.lock` is JSON with trailing commas allowed (a JSON5-lite dialect bun writes and reads,
 *  never plain JSON) — strip them before `}`/`]` so `JSON.parse` accepts it. No comments to worry
 *  about (measured: this repo's `bun.lock` carries none), so this narrow fixup is sufficient. */
function parseBunLock(text: string): { packages?: Record<string, [string, ...unknown[]]> } {
  return JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));
}
const BUN_LOCK = parseBunLock(readFileSync(join(REPO_ROOT, "bun.lock"), "utf8"));

/** Strips a leading `^`/`~` semver range operator — this repo's own convention for "the pin, as a
 *  range that installs" vs. "the pin, as the exact version the code is written against"
 *  (`versions.ts`'s own doc: "The ^ ranges in package.json are what INSTALLS; these are what the
 *  tests PROVE installed"). */
function bareVersion(range: string): string {
  return range.replace(/^[\^~]/, "");
}

/** `bun.lock`'s own `packages` entries are `"<name>": ["<name>@<version>", ...]` — the RESOLVED
 *  version bun actually installed, as opposed to package.json's own (possibly ranged) pin. The
 *  version always starts with a digit, which is what lets this regex not be fooled by the `@` in
 *  a scoped package name like `@yanlinglabs/winter-agent-sdk@0.0.4`. */
function lockedVersion(name: string): string {
  const entry = BUN_LOCK.packages?.[name];
  if (entry === undefined) throw new Error(`pins.test: bun.lock has no "packages" entry for ${JSON.stringify(name)}`);
  const m = entry[0].match(/@(\d[^@]*)$/);
  if (!m) throw new Error(`pins.test: could not parse a version out of bun.lock entry ${JSON.stringify(entry[0])}`);
  return m[1]!;
}

describe("CI takes winter from the installed platform package ONLY (P9a-8, since the 0.0.5 pin flip)", () => {
  test("no literal 'ref: v<digits>' checkout of winter-agent-sdk, no FALLBACK block, no `versions` job remain", () => {
    expect(CI_YML).not.toMatch(/ref:\s*v\d+\.\d+\.\d+/);
    expect(CI_YML).not.toContain("FALLBACK");
    expect(CI_YML).not.toContain("needs.versions");
    expect(CI_YML).not.toMatch(/^  versions:$/m);
  });
  test("every job that needs winter fails loudly when the platform package did not install (never a silent skip)", () => {
    const checks = CI_YML.match(/did not install — bun install is the ONLY winter source/g) ?? [];
    expect(checks.length).toBe(3);
  });
});

describe("packages/core/package.json's SDK pins agree with versions.ts's REQUIRED_* (P8d-16)", () => {
  test("winter-agent-sdk", () => {
    const range = CORE_PACKAGE_JSON.dependencies?.["@yanlinglabs/winter-agent-sdk"];
    expect(range).toBeDefined();
    expect(bareVersion(range!)).toBe(REQUIRED_WINTER_AGENT_SDK);
  });

  test("winter-runtime-sdk", () => {
    const range = CORE_PACKAGE_JSON.dependencies?.["@yanlinglabs/winter-runtime-sdk"];
    expect(range).toBeDefined();
    expect(bareVersion(range!)).toBe(REQUIRED_WINTER_RUNTIME_SDK);
  });

  test("claude-agent-sdk is pinned EXACT (no ^/~ range) and matches REQUIRED_CLAUDE_AGENT_SDK", () => {
    const range = CORE_PACKAGE_JSON.dependencies?.["@anthropic-ai/claude-agent-sdk"];
    expect(range).toBeDefined();
    expect(range).toBe(REQUIRED_CLAUDE_AGENT_SDK);
    expect(range).not.toMatch(/^[\^~]/);
  });
});

// P9a-8: the ladder's platform-package rung (`resolvePlatformPackageWinter`) and every
// stage-runtimes/release-lib version assertion key off `REQUIRED_WINTER_AGENT_SDK` matching
// WHATEVER `bun install` actually resolved for the wrapper — package.json's `^0.0.4` range is
// what INSTALLS, `bun.lock` is what actually got resolved, and a drift between the two (a `bun
// update` bumping the lockfile without this constant following) would make every "installed
// package version === REQUIRED_WINTER_AGENT_SDK" assertion in this codebase either falsely
// refuse a genuinely-fine install or, worse, silently accept a DIFFERENT version than the one the
// daemon is actually written against.
describe("REQUIRED_WINTER_AGENT_SDK matches the wrapper's ACTUALLY RESOLVED version in bun.lock (P9a-8)", () => {
  test("bun.lock's @yanlinglabs/winter-agent-sdk resolves to exactly REQUIRED_WINTER_AGENT_SDK", () => {
    expect(lockedVersion("@yanlinglabs/winter-agent-sdk")).toBe(REQUIRED_WINTER_AGENT_SDK);
  });
});
