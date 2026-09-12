// Winter Phase 8d (P8d-1/P8d-2) — the STANDALONE proof of `embed-runtimes.sh` (the body of
// project.yml's "Embed runtimes" postCompileScript), run exactly the way the section brief
// prescribes: BUILT_PRODUCTS_DIR=<mkdtemp>, CONTENTS_FOLDER_PATH=Winter.app/Contents,
// CONFIGURATION=Release, EXPANDED_CODE_SIGN_IDENTITY=- (ad-hoc — this is the build-phase proof,
// not release.ts's own gate, which requires a real Developer ID team identity).
//
// The claude-verify step needs the REAL @anthropic-ai/claude-agent-sdk platform package (an
// optional dependency bun install may or may not have resolved on this machine/arch) — SKIP with a
// printed reason when it is absent, UNLESS WINTER_CLAUDE_REQUIRE_RUNTIME=1, in which case that is a
// hard failure (the same CI-honesty shape `test/helpers/claude-runtime.ts` already uses).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveClaudeAgentSdkPackageDir } from "../packages/core/src/runtime-sdk/official-executable";

const SCRIPT = join(import.meta.dir, "embed-runtimes.sh");
const REPO_ROOT = join(import.meta.dir, "..");
const PINNED_DIST_WINTER = join(REPO_ROOT, "dist", "winter");

function claudePlatformAvailable(): boolean {
  try {
    return resolveClaudeAgentSdkPackageDir() !== undefined;
  } catch {
    return false;
  }
}

describe("embed-runtimes.sh (P8d-1/P8d-2 postCompileScript body, standalone)", () => {
  test("CONFIGURATION != Release skips immediately — no other env required, exit 0", () => {
    const r = spawnSync("bash", [SCRIPT], { encoding: "utf8", env: { ...process.env, CONFIGURATION: "Debug" } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("skip runtimes embed (non-Release)");
  });

  test("Release: stages the P8d-1 layout, re-signs winter with a stable identifier, and verifies the REAL claude binary untouched", () => {
    if (!existsSync(PINNED_DIST_WINTER)) {
      // Not a skip: the working rules name this exact pinned binary as always available for
      // tests in this lane's worktree — its absence is itself a setup problem worth failing on.
      throw new Error(`this test needs the pinned dist/winter at ${PINNED_DIST_WINTER} (never rebuild it — see the brief's working rules)`);
    }
    if (!claudePlatformAvailable()) {
      if (process.env.WINTER_CLAUDE_REQUIRE_RUNTIME === "1") {
        throw new Error("WINTER_CLAUDE_REQUIRE_RUNTIME=1 and the @anthropic-ai/claude-agent-sdk platform package is not installed on this machine");
      }
      console.log("SKIP: @anthropic-ai/claude-agent-sdk platform package not installed on this machine/arch — cannot exercise the claude verify step here");
      return;
    }

    const builtProducts = mkdtempSync(join(tmpdir(), "embed-runtimes-"));
    try {
      const r = spawnSync("bash", [SCRIPT], {
        encoding: "utf8",
        timeout: 60_000,
        env: {
          ...process.env,
          CONFIGURATION: "Release",
          BUILT_PRODUCTS_DIR: builtProducts,
          CONTENTS_FOLDER_PATH: "Winter.app/Contents",
          EXPANDED_CODE_SIGN_IDENTITY: "-",
          WINTER_STAGE_RUNTIME_PATH: PINNED_DIST_WINTER,
        },
      });
      if (r.status !== 0) throw new Error(`embed-runtimes.sh exited ${r.status}:\n[stderr]\n${r.stderr}\n[stdout]\n${r.stdout}`);

      const dest = join(builtProducts, "Winter.app", "Contents", "Resources", "runtimes");
      expect(existsSync(join(dest, "winter"))).toBe(true);
      expect(existsSync(join(dest, "claude-official", "claude"))).toBe(true);
      expect(existsSync(join(dest, "claude-official", "VERSIONS.json"))).toBe(true);

      // winter: re-signed with the stable identifier, ad-hoc identity accepted (this is the
      // build-phase proof, not release.ts's real-team-identity gate).
      const winterDvv = spawnSync("codesign", ["-dvv", join(dest, "winter")], { encoding: "utf8" });
      expect(`${winterDvv.stdout}${winterDvv.stderr}`).toContain("Identifier=com.winter.runtime");

      // claude: untouched, still verifies as the real Anthropic-signed artifact.
      const claudeVerify = spawnSync("codesign", ["--verify", "--strict", join(dest, "claude-official", "claude")], { encoding: "utf8" });
      expect(claudeVerify.status).toBe(0);
      const claudeDvv = spawnSync("codesign", ["-dvv", join(dest, "claude-official", "claude")], { encoding: "utf8" });
      expect(`${claudeDvv.stdout}${claudeDvv.stderr}`).toContain("TeamIdentifier=Q6L2SF6YDW");

      expect(r.stdout).toContain("runtimes embedded + verified");
    } finally {
      rmSync(builtProducts, { recursive: true, force: true });
    }
  }, 60_000);
});
