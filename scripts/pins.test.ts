// Winter Phase 8d (P8d-16): pin-consistency tripwire. `.github/workflows/ci.yml`'s
// `winter-binary` job used to hardcode `ref: v0.0.4` (the pinned-tag checkout) AND
// `name: winter-v0.0.4` (the uploaded artifact) as two separate literals — and
// `packages/core/package.json`'s own SDK version ranges are a THIRD place the same pin could
// silently drift from `packages/core/src/runtime-sdk/versions.ts`'s `REQUIRED_*` constants (it
// happened once already, in 8c's spine). This test is the tripwire for both directions.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REQUIRED_CLAUDE_AGENT_SDK, REQUIRED_WINTER_AGENT_SDK, REQUIRED_WINTER_RUNTIME_SDK } from "../packages/core/src/runtime-sdk/versions";

const REPO_ROOT = join(import.meta.dir, "..");
const CI_YML = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
const CORE_PACKAGE_JSON = JSON.parse(readFileSync(join(REPO_ROOT, "packages", "core", "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};

/** Strips a leading `^`/`~` semver range operator — this repo's own convention for "the pin, as a
 *  range that installs" vs. "the pin, as the exact version the code is written against"
 *  (`versions.ts`'s own doc: "The ^ ranges in package.json are what INSTALLS; these are what the
 *  tests PROVE installed"). */
function bareVersion(range: string): string {
  return range.replace(/^[\^~]/, "");
}

describe("CI's winter-agent-sdk pin is DERIVED from versions.ts, never a bare literal (P8d-16)", () => {
  test("no literal 'ref: v<digits>' checkout of winter-agent-sdk remains — it must be an expression", () => {
    // A bare `ref: v0.0.4`-shaped literal anywhere in the file is exactly the drift class this
    // test exists to catch; the fixed form below is the only way this pin may be spelled.
    expect(CI_YML).not.toMatch(/ref:\s*v\d+\.\d+\.\d+\s*$/m);
  });

  test("no literal 'winter-v<digits>' artifact name remains — it must be an expression", () => {
    expect(CI_YML).not.toMatch(/winter-v\d+\.\d+\.\d+/);
  });

  test("the pinned-tag checkout ref is derived from the SAME versions job output everywhere it appears", () => {
    const refOccurrences = CI_YML.match(/ref:\s*v\$\{\{\s*needs\.versions\.outputs\.winter-agent-sdk\s*\}\}/g) ?? [];
    expect(refOccurrences.length).toBeGreaterThanOrEqual(1);
  });

  test("the uploaded/downloaded artifact name is derived from the SAME versions job output everywhere it appears", () => {
    const nameOccurrences = CI_YML.match(/winter-v\$\{\{\s*needs\.versions\.outputs\.winter-agent-sdk\s*\}\}/g) ?? [];
    // upload (winter-binary) + download (test-core, test-cli, verify) = at least 2, realistically 4.
    expect(nameOccurrences.length).toBeGreaterThanOrEqual(2);
  });

  test("the versions job itself reads REQUIRED_WINTER_AGENT_SDK out of versions.ts, not a re-typed literal", () => {
    expect(CI_YML).toContain("REQUIRED_WINTER_AGENT_SDK");
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
