import { describe, expect, test } from "bun:test";
import { ClaudeExecutableUnavailable, resolveClaudeExecutable } from "../../src/runtime-sdk/official-executable";
import { bundleRuntimePath } from "../../src/runtime-sdk/bundle-layout";
import { REQUIRED_CLAUDE_AGENT_SDK, REQUIRED_WINTER_AGENT_SDK, REQUIRED_WINTER_RUNTIME_SDK } from "../../src/runtime-sdk/versions";

const exists = (set: string[]) => (p: string) => set.includes(p);
const base = { env: {}, execPath: "/bundle/Contents/MacOS/norma-core" };
// P8d-1: the bundle rung moved under `Resources/runtimes/claude-official/` — this is that exact
// path (and its VERSIONS.json sibling) for `base`.
const BUNDLE_CLAUDE = bundleRuntimePath(base.execPath, "claude");
const BUNDLE_VERSIONS = bundleRuntimePath(base.execPath, "versions");

const sha = "a".repeat(64);
const goodVersionsJson = JSON.stringify({
  schema: 1,
  winterAgentSdk: REQUIRED_WINTER_AGENT_SDK,
  winterRuntimeSdk: REQUIRED_WINTER_RUNTIME_SDK,
  officialSdk: REQUIRED_CLAUDE_AGENT_SDK,
  claudeCode: "2.1.250",
  checksums: { winterPreSign: sha, claude: sha },
  stagedAt: "2026-09-12T00:00:00Z",
});
/** A seam that only answers for the exact VERSIONS.json path this build's ladder reads — a
 *  read for anything else is a bug in the ladder, not a fixture gap, so it throws loudly. */
const readVersions = (text: string) => (p: string) => {
  if (p !== BUNDLE_VERSIONS) throw new Error(`unexpected VERSIONS.json read: ${p}`);
  return text;
};

describe("resolveClaudeExecutable (P8c-3 ladder, P8d-1 bundle layout + VERSIONS.json gate)", () => {
  test("setting wins over everything", () => {
    const r = resolveClaudeExecutable({ ...base, setting: "/s/claude", env: { NORMA_CLAUDE_EXECUTABLE: "/e/claude" }, exists: exists(["/s/claude", "/e/claude"]) });
    expect(r).toEqual({ path: "/s/claude", source: "setting" });
  });

  test("env beats bundle and the package door", () => {
    const r = resolveClaudeExecutable({ ...base, env: { NORMA_CLAUDE_EXECUTABLE: "/e/claude" }, exists: exists(["/e/claude", BUNDLE_CLAUDE]), resolvePackage: () => "/pkg" });
    expect(r).toEqual({ path: "/e/claude", source: "env" });
  });

  test("bundle rung is <dirname(execPath)>/runtimes/claude-official/claude, gated on a valid VERSIONS.json, then the package door", () => {
    expect(
      resolveClaudeExecutable({ ...base, exists: exists([BUNDLE_CLAUDE]), resolvePackage: () => "/pkg", readVersions: readVersions(goodVersionsJson) }),
    ).toEqual({ path: BUNDLE_CLAUDE, source: "bundle" });
    expect(resolveClaudeExecutable({ ...base, exists: exists(["/pkg/claude"]), resolvePackage: () => "/pkg" })).toEqual({ path: "/pkg/claude", source: "package" });
  });

  test("a bundled claude with a MISMATCHED VERSIONS.json is refused — a mixed pair is not the pinned artifact (WS-02 §6)", () => {
    const badVersionsJson = JSON.stringify({
      schema: 1,
      winterAgentSdk: REQUIRED_WINTER_AGENT_SDK,
      winterRuntimeSdk: REQUIRED_WINTER_RUNTIME_SDK,
      officialSdk: "0.3.251",
      claudeCode: "2.1.250",
      checksums: { winterPreSign: sha, claude: sha },
      stagedAt: "2026-09-12T00:00:00Z",
    });
    const r = resolveClaudeExecutable({ ...base, exists: exists([BUNDLE_CLAUDE]), readVersions: readVersions(badVersionsJson) });
    expect(r).toBeInstanceOf(ClaudeExecutableUnavailable);
    if (r instanceof ClaudeExecutableUnavailable) {
      expect(r.code).toBe("claude_executable_unavailable");
      expect(r.message).toContain("0.3.251");
      expect(r.tried).toEqual([BUNDLE_CLAUDE]);
    }
  });

  test("a bundled claude with NO VERSIONS.json (or unparseable) is refused, never a silent pass-through of an unpinned binary", () => {
    const r = resolveClaudeExecutable({
      ...base,
      exists: exists([BUNDLE_CLAUDE]),
      readVersions: () => { throw new Error("ENOENT: no such file or directory"); },
    });
    expect(r).toBeInstanceOf(ClaudeExecutableUnavailable);
    if (r instanceof ClaudeExecutableUnavailable) expect(r.message).toContain("ENOENT");
  });

  test("a configured path that does not exist is NOT skipped silently — it is the failure", () => {
    const r = resolveClaudeExecutable({ ...base, setting: "/gone/claude", exists: exists([BUNDLE_CLAUDE]) });
    expect(r).toBeInstanceOf(ClaudeExecutableUnavailable);
    if (r instanceof ClaudeExecutableUnavailable) { expect(r.code).toBe("claude_executable_unavailable"); expect(r.tried).toEqual(["/gone/claude"]); }
  });

  test("an ENV path that does not exist is the failure too — not just the setting branch", () => {
    const r = resolveClaudeExecutable({ ...base, env: { NORMA_CLAUDE_EXECUTABLE: "/gone/claude" }, exists: exists([BUNDLE_CLAUDE]), resolvePackage: () => "/pkg" });
    expect(r).toBeInstanceOf(ClaudeExecutableUnavailable);
    if (r instanceof ClaudeExecutableUnavailable) expect(r.tried).toEqual(["/gone/claude"]);
  });

  test("nothing found → typed failure, never a throw", () => {
    const r = resolveClaudeExecutable({ ...base, exists: () => false, resolvePackage: () => undefined });
    expect(r).toBeInstanceOf(ClaudeExecutableUnavailable);
  });

  test("a whitespace-only setting or env value is treated as UNSET, not as a missing path", () => {
    const r = resolveClaudeExecutable({ ...base, setting: "   ", env: { NORMA_CLAUDE_EXECUTABLE: "\t\n" }, exists: exists([BUNDLE_CLAUDE]), readVersions: readVersions(goodVersionsJson) });
    expect(r).toEqual({ path: BUNDLE_CLAUDE, source: "bundle" });
  });

  test("a bare command name is refused — WS-14 §5.1: never the user's own install", () => {
    const r = resolveClaudeExecutable({ ...base, setting: "claude", exists: () => true });
    expect(r).toBeInstanceOf(ClaudeExecutableUnavailable);
    if (r instanceof ClaudeExecutableUnavailable) expect(r.message).toContain("bare command name");
  });

  test("a bare env value is refused too", () => {
    const r = resolveClaudeExecutable({ ...base, env: { NORMA_CLAUDE_EXECUTABLE: "claude" }, exists: () => true });
    expect(r).toBeInstanceOf(ClaudeExecutableUnavailable);
  });

  test("the package door not installed (optional dep absent) is a plain, quiet miss", () => {
    const r = resolveClaudeExecutable({ ...base, exists: () => false, resolvePackage: () => undefined });
    expect(r).toBeInstanceOf(ClaudeExecutableUnavailable);
    if (r instanceof ClaudeExecutableUnavailable) expect(r.tried).toEqual([BUNDLE_CLAUDE]);
  });

  test("a version-mismatched platform package THROWS from the door and is surfaced as the typed refusal, never a raw throw", () => {
    const r = resolveClaudeExecutable({
      ...base,
      exists: () => false,
      resolvePackage: () => { throw new Error("the platform runtime is 0.3.265 but the wrapper is 0.3.250 — a mixed pair is not the pinned artifact (WS-02 §6)"); },
    });
    expect(r).toBeInstanceOf(ClaudeExecutableUnavailable);
    if (r instanceof ClaudeExecutableUnavailable) expect(r.message).toContain("0.3.265");
  });

  test("the real (non-injected) package door resolves the installed platform package end to end", () => {
    // No `resolvePackage` override: exercises the real dual-`createRequire` resolution against
    // whatever `bun install` actually put in `node_modules` for THIS machine — real for CI's
    // darwin/linux runners, a quiet miss on a machine with no matching platform package. The
    // bundle rung is deliberately unsatisfiable here so a hit can only come from the package door.
    const r = resolveClaudeExecutable({ ...base, exists: (p) => p !== BUNDLE_CLAUDE && p.endsWith("/claude") });
    // Either it resolved through the package door, or the platform package genuinely is not
    // installed for this platform/arch — both are legitimate; a throw is not.
    if (r instanceof ClaudeExecutableUnavailable) {
      expect(r.code).toBe("claude_executable_unavailable");
    } else {
      expect(r.source).toBe("package");
      expect(r.path.endsWith("/claude")).toBe(true);
    }
  });
});
