// Winter Phase 10a (fix round 1, item 1 CRITICAL) — release.ts itself cannot be exercised under
// `bun test`: it shells out to `codesign`/`notarytool`/`gh`, requires a real signed `.app` bundle
// on disk, and running it (even --dry-run) is explicitly controller-only per this repo's working
// rules. So unlike release-lib.ts's pure functions (which get real behavioral tests), the proof
// available here is SOURCE-LEVEL: that release.ts actually calls `verifyAntEmbed` (release-lib.ts)
// and `assertSigned` on the embedded `ant` path, in the same place and the same way the pre-existing
// winter/claude embedded-runtime checks run — so a future edit that silently drops or reorders the
// wiring fails a test instead of only ever being caught by a human re-reading a 1300+ line script
// during a real release.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RELEASE_TS_PATH = join(import.meta.dir, "release.ts");
const source = readFileSync(RELEASE_TS_PATH, "utf8");

describe("release.ts wires verifyAntEmbed into the embedded-runtime gate sequence", () => {
  test("imports verifyAntEmbed from ./release-lib and parseAntPin from ./fetch-ant", () => {
    expect(source).toMatch(/import\s*\{[^}]*verifyAntEmbed[^}]*\}\s*from\s*"\.\/release-lib"/);
    expect(source).toMatch(/import\s*\{\s*parseAntPin\s*\}\s*from\s*"\.\/fetch-ant"/);
  });

  test("asserts the embedded ant binary's signature via the SAME generic assertSigned() winter uses (never claude's separate 'verify untouched' shape)", () => {
    expect(source).toContain("assertSigned(embeddedAntPath");
  });

  test("calls verifyAntEmbed with the repo-root VERSIONS.json text and a real actualSha256, and fails the release on a bad result", () => {
    expect(source).toMatch(/verifyAntEmbed\(\{\s*versionsJsonText:\s*rootVersionsJsonText,\s*actualSha256:\s*vendoredAntSha256\s*\}\)/);
    expect(source).toMatch(/if \(!antEmbedCheck\.ok\)\s*\{\s*fail\(/);
  });

  test("refuses loudly (never a silent skip) when the vendored ant source is missing, naming fetch-ant.ts", () => {
    expect(source).toMatch(/if \(!existsSync\(vendoredAntPath\)\)\s*\{\s*fail\(/);
    expect(source).toContain("bun run scripts/fetch-ant.ts");
  });

  test("the ant gate sits AFTER the claude embedded-runtime check and BEFORE the Row 16 winter-source section — the same sequence position as the winter/claude checks it mirrors", () => {
    const claudeGateIdx = source.indexOf("Embedded runtimes verified: winter re-signed");
    const antGateIdx = source.indexOf("verifyAntEmbed({");
    const row16Idx = source.indexOf("Row 16 STRONG (P9a-8)");
    expect(claudeGateIdx).toBeGreaterThan(-1);
    expect(antGateIdx).toBeGreaterThan(-1);
    expect(row16Idx).toBeGreaterThan(-1);
    expect(antGateIdx).toBeGreaterThan(claudeGateIdx);
    expect(antGateIdx).toBeLessThan(row16Idx);
  });

  test("ant is RE-SIGNED like winter (not verified-untouched like claude) — HARDENING_PINS enrolls it in the same no-entitlements-relaxation posture", () => {
    expect(source).toContain('{ path: embeddedAntPath, label: "ant (embedded runtime)", expect: [] }');
  });

  test("this file's own regex/substring checks actually match against a KNOWN-GOOD fixture shape — a canary against a checker that always vacuously passes", () => {
    const fixture = `
import { verifyAntEmbed } from "./release-lib";
import { parseAntPin } from "./fetch-ant";
assertSigned(embeddedAntPath, "ant (embedded runtime)");
const antEmbedCheck = verifyAntEmbed({ versionsJsonText: rootVersionsJsonText, actualSha256: vendoredAntSha256 });
if (!antEmbedCheck.ok) {
  fail("x");
}
if (!existsSync(vendoredAntPath)) {
  fail("y");
}
`;
    expect(fixture).toMatch(/import\s*\{[^}]*verifyAntEmbed[^}]*\}\s*from\s*"\.\/release-lib"/);
    expect(fixture).toContain("assertSigned(embeddedAntPath");
    expect(fixture).toMatch(/verifyAntEmbed\(\{\s*versionsJsonText:\s*rootVersionsJsonText,\s*actualSha256:\s*vendoredAntSha256\s*\}\)/);
    expect(fixture).toMatch(/if \(!antEmbedCheck\.ok\)\s*\{\s*fail\(/);
    expect(fixture).toMatch(/if \(!existsSync\(vendoredAntPath\)\)\s*\{\s*fail\(/);
  });
});
