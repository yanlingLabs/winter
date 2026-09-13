// Winter Phase 10a (fix round 1 item 1 CRITICAL, fix round 2) — release.ts itself cannot be
// exercised under `bun test`: it shells out to `codesign`/`notarytool`/`gh`, requires a real signed
// `.app` bundle on disk, and running it (even --dry-run) is explicitly controller-only per this
// repo's working rules. So unlike release-lib.ts's pure functions (which get real behavioral
// tests), the proof available here is SOURCE-LEVEL: that release.ts actually calls the FULL
// content-identity chain for `ant` — `verifyAntEmbed` against the STAGED pre-sign hash (never the
// vendor source alone, and never a re-hash of the post-sign embedded file) PLUS a real
// `codesign --verify --strict` + `Identifier=com.winter.ant` check on the embedded copy itself —
// in the same place and the same way the pre-existing winter/claude embedded-runtime checks run.
// A future edit that silently drops, weakens, or reorders the wiring fails a test instead of only
// ever being caught by a human re-reading a 1300+ line script during a real release.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RELEASE_TS_PATH = join(import.meta.dir, "release.ts");
const source = readFileSync(RELEASE_TS_PATH, "utf8");

describe("release.ts wires the full ant content-identity chain into the embedded-runtime gate sequence (fix round 2)", () => {
  test("imports verifyAntEmbed from ./release-lib and parseAntPin (+ fetchAnt, fix wave F5) from ./fetch-ant", () => {
    expect(source).toMatch(/import\s*\{[^}]*verifyAntEmbed[^}]*\}\s*from\s*"\.\/release-lib"/);
    expect(source).toMatch(/import\s*\{[^}]*\bfetchAnt\b[^}]*\}\s*from\s*"\.\/fetch-ant"/);
    expect(source).toMatch(/import\s*\{[^}]*\bparseAntPin\b[^}]*\}\s*from\s*"\.\/fetch-ant"/);
  });

  test("asserts the embedded ant binary's TeamIdentifier/timestamp via the SAME generic assertSigned() winter uses (never claude's separate 'verify untouched' shape)", () => {
    expect(source).toContain("assertSigned(embeddedAntPath");
  });

  test("calls verifyAntEmbed with the repo-root VERSIONS.json text and the STAGED pre-sign hash (embeddedVersions.checksums.ant) — never a hash of the vendor source or the post-sign embedded file — and fails the release on a bad result", () => {
    expect(source).toMatch(/verifyAntEmbed\(\{\s*versionsJsonText:\s*rootVersionsJsonText,\s*stagedAntPreSignSha256:\s*embeddedVersions\.checksums\.ant\s*\}\)/);
    expect(source).toMatch(/if \(!antEmbedCheck\.ok\)\s*\{\s*fail\(/);
  });

  test("independently verifies the CURRENTLY EMBEDDED file with codesign --verify --strict AND checks Identifier=com.winter.ant — the proof that today's on-disk bytes are unchanged since embed-runtimes.sh's own signing, closing the gap a staged-hash check alone would leave open", () => {
    expect(source).toMatch(/codesign --verify --strict "\$\{embeddedAntPath\}"/);
    expect(source).toContain('antDvv.includes("Identifier=com.winter.ant")');
  });

  test("the vendor-path hash is an EARLY SUPPLEMENTARY check only — the release still fails if it mismatches, but it is not the sole/final proof (the staged+embedded checks above are)", () => {
    expect(source).toMatch(/vendoredAntSha256 !== antPin\.binarySha256/);
    // Must appear BEFORE the authoritative staged/embedded checks, and neither `fail()` call for it
    // may be the ONLY ant-related failure path in the file.
    const vendorCheckIdx = source.indexOf("vendoredAntSha256 !== antPin.binarySha256");
    const stagedCheckIdx = source.indexOf("verifyAntEmbed({");
    expect(vendorCheckIdx).toBeGreaterThan(-1);
    expect(stagedCheckIdx).toBeGreaterThan(vendorCheckIdx);
  });

  // Fix wave (F5): a missing vendor/ant/<tag>/ant used to be a hard release-preflight failure — but
  // `embed-runtimes.sh` (the Xcode build's own postCompileScript) needs it to already exist, so
  // that failure fired only AFTER xcodebuild had already aborted the build for the same reason, and
  // the post-build "vendoredAntPath" sanity check below never even ran. release.ts now auto-fetches
  // it (via the already-verifying `fetchAnt`) BEFORE the build starts, instead of hard-failing.
  test("auto-fetches the vendored ant BEFORE the build when it is missing, via the existing verifying fetchAnt (F5)", () => {
    expect(source).toMatch(/if \(!existsSync\(vendoredAntPath\)\)\s*\{[\s\S]{0,400}?fetchAnt\(\{\s*pin:\s*antPin,\s*outDir:/);
    // One line, printed before the fetch actually runs.
    expect(source).toMatch(/console\.log\(`vendor\/ant\/\$\{antPin\.tag\}\/ant not found — fetching it now/);
  });

  test("the auto-fetch check sits BEFORE the xcodebuild invocation, not after (fix wave F5) — the earlier the post-build vendoredAntPath check never runs otherwise", () => {
    const autoFetchIdx = source.indexOf("fetchAnt({ pin: antPin, outDir:");
    const xcodebuildIdx = source.indexOf("xcodebuild -project Winter.xcodeproj");
    expect(autoFetchIdx).toBeGreaterThan(-1);
    expect(xcodebuildIdx).toBeGreaterThan(-1);
    expect(autoFetchIdx).toBeLessThan(xcodebuildIdx);
  });

  // The post-build "vendoredAntPath" check (below) is now a SUPPLEMENTARY safety net, not the
  // primary handling of a missing file — with the pre-build auto-fetch above, it should never
  // actually fire in practice, but it still refuses loudly (never a silent skip) if it somehow
  // does (e.g. something removed the file mid-build).
  test("still refuses loudly (never a silent skip) if the vendored ant is somehow still missing post-build, naming fetch-ant.ts", () => {
    expect(source).toMatch(/if \(!existsSync\(vendoredAntPath\)\)\s*\{\s*fail\(/);
    expect(source).toContain("bun run scripts/fetch-ant.ts");
  });

  test("documents that the root VERSIONS.json (the ant vendoring pin) is a different file from the staged runtimes/claude-official/VERSIONS.json", () => {
    expect(source).toContain("runtimes/claude-official/VERSIONS.json");
    expect(source.toLowerCase()).toContain("different file");
  });

  test("the ant gate (vendor check -> staged-hash check -> embedded codesign check) sits AFTER the claude embedded-runtime check and BEFORE the Row 16 winter-source section — the same sequence position as the winter/claude checks it mirrors", () => {
    const claudeGateIdx = source.indexOf("Embedded runtimes verified: winter re-signed");
    const antAssertSignedIdx = source.indexOf("assertSigned(embeddedAntPath");
    const antStagedCheckIdx = source.indexOf("verifyAntEmbed({");
    const antCodesignVerifyIdx = source.indexOf('codesign --verify --strict "${embeddedAntPath}"');
    const row16Idx = source.indexOf("Row 16 STRONG (P9a-8)");
    for (const idx of [claudeGateIdx, antAssertSignedIdx, antStagedCheckIdx, antCodesignVerifyIdx, row16Idx]) expect(idx).toBeGreaterThan(-1);
    expect(antAssertSignedIdx).toBeGreaterThan(claudeGateIdx);
    expect(antStagedCheckIdx).toBeGreaterThan(antAssertSignedIdx);
    expect(antCodesignVerifyIdx).toBeGreaterThan(antStagedCheckIdx);
    expect(antCodesignVerifyIdx).toBeLessThan(row16Idx);
  });

  test("ant is RE-SIGNED like winter (not verified-untouched like claude) — HARDENING_PINS enrolls it in the same no-entitlements-relaxation posture", () => {
    expect(source).toContain('{ path: embeddedAntPath, label: "ant (embedded runtime)", expect: [] }');
  });

  test("this file's own regex/substring checks actually match against a KNOWN-GOOD fixture shape — a canary against a checker that always vacuously passes", () => {
    const fixture = `
import { verifyAntEmbed } from "./release-lib";
import { parseAntPin } from "./fetch-ant";
assertSigned(embeddedAntPath, "ant (embedded runtime)");
if (vendoredAntSha256 !== antPin.binarySha256) {
  fail("stale vendor");
}
const antEmbedCheck = verifyAntEmbed({ versionsJsonText: rootVersionsJsonText, stagedAntPreSignSha256: embeddedVersions.checksums.ant });
if (!antEmbedCheck.ok) {
  fail("x");
}
if (!existsSync(vendoredAntPath)) {
  fail("y");
}
sh(\`codesign --verify --strict "\${embeddedAntPath}"\`);
if (!antDvv.includes("Identifier=com.winter.ant")) {
  fail("z");
}
`;
    expect(fixture).toMatch(/import\s*\{[^}]*verifyAntEmbed[^}]*\}\s*from\s*"\.\/release-lib"/);
    expect(fixture).toContain("assertSigned(embeddedAntPath");
    expect(fixture).toMatch(/verifyAntEmbed\(\{\s*versionsJsonText:\s*rootVersionsJsonText,\s*stagedAntPreSignSha256:\s*embeddedVersions\.checksums\.ant\s*\}\)/);
    expect(fixture).toMatch(/if \(!antEmbedCheck\.ok\)\s*\{\s*fail\(/);
    expect(fixture).toMatch(/if \(!existsSync\(vendoredAntPath\)\)\s*\{\s*fail\(/);
    expect(fixture).toMatch(/vendoredAntSha256 !== antPin\.binarySha256/);
    expect(fixture).toMatch(/codesign --verify --strict "\$\{embeddedAntPath\}"/);
    expect(fixture).toContain('antDvv.includes("Identifier=com.winter.ant")');
  });
});
