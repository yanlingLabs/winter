// Winter Phase 8d (P8d-1/P8d-2) — the STANDALONE proof of `embed-runtimes.sh` (the body of
// project.yml's "Embed runtimes" postCompileScript), run exactly the way the section brief
// prescribes: BUILT_PRODUCTS_DIR=<mkdtemp>, CONTENTS_FOLDER_PATH=Winter.app/Contents,
// CONFIGURATION=Release, EXPANDED_CODE_SIGN_IDENTITY=- (ad-hoc — this is the build-phase proof,
// not release.ts's own gate, which requires a real Developer ID team identity).
//
// WS-23: the step that verified the vendored `claude` binary is gone with the official leg, so this
// proof no longer depends on the claude platform package; it pins that nothing under
// `runtimes/claude-official/` is staged, and that `ant`'s checksum lands in ant's own record.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAntPin } from "./fetch-ant";
import { parseAntVersionsJson, parseVersionsJson } from "../packages/core/src/runtime-sdk/bundle-layout";

const SCRIPT = join(import.meta.dir, "embed-runtimes.sh");
const REPO_ROOT = join(import.meta.dir, "..");
const PINNED_DIST_WINTER = join(REPO_ROOT, "dist", "winter");
const VERSIONS_JSON_PATH = join(REPO_ROOT, "VERSIONS.json");
// Winter Phase 10a (Task L3): the vendored `ant` this repo's own VERSIONS.json pin names —
// `bun run scripts/fetch-ant.ts` populates it (gitignored; never committed). Absent on a fresh
// checkout that hasn't run that command yet, same "pre-staged build input" shape as
// PINNED_DIST_WINTER above.
function pinnedVendoredAnt(): string | undefined {
  try {
    const pin = parseAntPin(readFileSync(VERSIONS_JSON_PATH, "utf8"));
    const p = join(REPO_ROOT, "vendor", "ant", pin.tag, "ant");
    return existsSync(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

describe("embed-runtimes.sh (P8d-1/P8d-2 postCompileScript body, standalone)", () => {
  test("CONFIGURATION != Release skips immediately — no other env required, exit 0", () => {
    const r = spawnSync("bash", [SCRIPT], { encoding: "utf8", env: { ...process.env, CONFIGURATION: "Debug" } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("skip runtimes embed (non-Release)");
  });

  test("Release: stages the P8d-1 layout and re-signs winter+ant with a stable identifier — no claude-official/ at all (WS-23)", () => {
    if (!existsSync(PINNED_DIST_WINTER)) {
      // Not a skip: the working rules name this exact pinned binary as always available for
      // tests in this lane's worktree — its absence is itself a setup problem worth failing on.
      throw new Error(`this test needs the pinned dist/winter at ${PINNED_DIST_WINTER} (never rebuild it — see the brief's working rules)`);
    }

    const builtProducts = mkdtempSync(join(tmpdir(), "embed-runtimes-"));
    // Winter Phase 10a (Task L3): a self-contained `ant` fixture via WINTER_STAGE_ANT_PATH — this
    // test never depends on `bun run scripts/fetch-ant.ts` having been run (a real vendored `ant`
    // is exercised separately below, best-effort). Plain re-sign-ability is all this step needs:
    // `codesign --force --sign -` accepts any file, Mach-O or not (measured).
    const antFixtureDir = mkdtempSync(join(tmpdir(), "embed-runtimes-ant-fixture-"));
    const antFixture = join(antFixtureDir, "ant");
    writeFileSync(antFixture, "#!/bin/sh\necho fixture-ant\n", { mode: 0o755 });
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
          WINTER_STAGE_ANT_PATH: antFixture,
        },
      });
      if (r.status !== 0) throw new Error(`embed-runtimes.sh exited ${r.status}:\n[stderr]\n${r.stderr}\n[stdout]\n${r.stdout}`);

      const dest = join(builtProducts, "Winter.app", "Contents", "Resources", "runtimes");
      expect(existsSync(join(dest, "winter"))).toBe(true);
      expect(existsSync(join(dest, "VERSIONS.json"))).toBe(true);
      expect(existsSync(join(dest, "ant", "ant"))).toBe(true);
      expect(existsSync(join(dest, "ant", "VERSIONS.json"))).toBe(true);
      // WS-23: the official runtime is not embedded.
      expect(existsSync(join(dest, "claude-official"))).toBe(false);

      // winter: re-signed with the stable identifier, ad-hoc identity accepted (this is the
      // build-phase proof, not release.ts's real-team-identity gate).
      const winterDvv = spawnSync("codesign", ["-dvv", join(dest, "winter")], { encoding: "utf8" });
      expect(`${winterDvv.stdout}${winterDvv.stderr}`).toContain("Identifier=com.winter.runtime");
      // A2: exactly the JIT entitlement on winter (a bun binary); none on ant (Go).
      const csKeys = (path: string): string[] => {
        const xml = spawnSync("codesign", ["-d", "--entitlements", "-", "--xml", path], { encoding: "utf8" }).stdout ?? "";
        return [...xml.matchAll(/<key>(com\.apple\.security\.cs\.[^<]+)<\/key>/g)].map((m) => m[1]!);
      };
      expect(csKeys(join(dest, "winter"))).toEqual(["com.apple.security.cs.allow-jit"]);
      expect(csKeys(join(dest, "ant", "ant"))).toEqual([]);

      // ant: RE-SIGNED with Winter's own stable identifier, same shape as winter.
      const antDvv = spawnSync("codesign", ["-dvv", join(dest, "ant", "ant")], { encoding: "utf8" });
      expect(`${antDvv.stdout}${antDvv.stderr}`).toContain("Identifier=com.winter.ant");
      expect(readFileSync(join(dest, "ant", "ant"), "utf8")).toBe("#!/bin/sh\necho fixture-ant\n");
      const antMode = statSync(join(dest, "ant", "ant")).mode & 0o777;
      expect(antMode).toBe(0o755);

      // Fix round 2 / WS-23: ant's own record carries the PRE-SIGN hash — computed on the fixture's
      // bytes BEFORE codesign mutated the file — so it must equal a fresh hash of the ORIGINAL
      // fixture content, never of the (now re-signed, different) file at dest. It parses through
      // the daemon's own reader, and the runtimes record carries no ant field.
      const antRecord = parseAntVersionsJson(readFileSync(join(dest, "ant", "VERSIONS.json"), "utf8"));
      const expectedPreSignSha256 = createHash("sha256").update(readFileSync(antFixture)).digest("hex");
      expect(antRecord.checksums.antPreSign).toBe(expectedPreSignSha256);
      expect(antRecord.tag).toBe(parseAntPin(readFileSync(VERSIONS_JSON_PATH, "utf8")).tag);
      const runtimesRecord = parseVersionsJson(readFileSync(join(dest, "VERSIONS.json"), "utf8"));
      expect(runtimesRecord.schema).toBe(2);
      expect(Object.keys(runtimesRecord.checksums)).toEqual(["winterPreSign"]);

      expect(r.stdout).toContain("runtimes embedded + verified");
      expect(r.stdout).toContain("ant re-signed (Identifier=com.winter.ant)");
    } finally {
      rmSync(builtProducts, { recursive: true, force: true });
      rmSync(antFixtureDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("a missing vendored ant fails the build loudly, naming the fetch command — never a silent skip", () => {
    if (!existsSync(PINNED_DIST_WINTER)) {
      // The winter staging step runs BEFORE the ant step and would fail first on a
      // machine without this — this test is specifically about the ant-missing message, so skip
      // rather than assert a different failure reason.
      console.log("SKIP: no pinned dist/winter available to reach the ant staging step in this environment");
      return;
    }
    const builtProducts = mkdtempSync(join(tmpdir(), "embed-runtimes-noant-"));
    try {
      const r = spawnSync("bash", [SCRIPT], {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          CONFIGURATION: "Release",
          BUILT_PRODUCTS_DIR: builtProducts,
          CONTENTS_FOLDER_PATH: "Winter.app/Contents",
          EXPANDED_CODE_SIGN_IDENTITY: "-",
          WINTER_STAGE_RUNTIME_PATH: PINNED_DIST_WINTER,
          WINTER_STAGE_ANT_PATH: "/nonexistent/path/to/ant",
        },
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("no vendored ant at");
      expect(r.stderr).toContain("bun run scripts/fetch-ant.ts");
    } finally {
      rmSync(builtProducts, { recursive: true, force: true });
    }
  }, 30_000);

  test("the real (non-injected) production path: VERSIONS.json's pinned ant.tag resolves the vendored vendor/ant/<tag>/ant", () => {
    const vendoredAnt = pinnedVendoredAnt();
    if (!vendoredAnt) {
      console.log(
        "SKIP: no vendored ant at the VERSIONS.json-pinned vendor/ant/<tag>/ant — run `bun run scripts/fetch-ant.ts` to exercise this path for real",
      );
      return;
    }
    if (!existsSync(PINNED_DIST_WINTER)) {
      throw new Error(`this test needs the pinned dist/winter at ${PINNED_DIST_WINTER} (never rebuild it — see the brief's working rules)`);
    }
    const builtProducts = mkdtempSync(join(tmpdir(), "embed-runtimes-real-ant-"));
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
          // deliberately NOT setting WINTER_STAGE_ANT_PATH — proves the default (VERSIONS.json
          // tag -> vendor/ant/<tag>/ant) resolution path, not the test seam.
        },
      });
      if (r.status !== 0) throw new Error(`embed-runtimes.sh exited ${r.status}:\n[stderr]\n${r.stderr}\n[stdout]\n${r.stdout}`);
      const dest = join(builtProducts, "Winter.app", "Contents", "Resources", "runtimes");
      const antDvv = spawnSync("codesign", ["-dvv", join(dest, "ant", "ant")], { encoding: "utf8" });
      expect(`${antDvv.stdout}${antDvv.stderr}`).toContain("Identifier=com.winter.ant");

      // Fix round 2: the staged pre-sign hash matches the REAL vendored file's own sha256 (the
      // vendored file itself is never mutated by this script — only the staged bundle copy is).
      const antRecord = parseAntVersionsJson(readFileSync(join(dest, "ant", "VERSIONS.json"), "utf8"));
      const expectedPreSignSha256 = createHash("sha256").update(readFileSync(vendoredAnt)).digest("hex");
      expect(antRecord.checksums.antPreSign).toBe(expectedPreSignSha256);
    } finally {
      rmSync(builtProducts, { recursive: true, force: true });
    }
  }, 60_000);
});
