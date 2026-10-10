// Winter Phase 10a (fix round 1 item 1 CRITICAL, fix round 2) — release.ts itself cannot be
// exercised under `bun test`: it shells out to `codesign`/`notarytool`/`gh`, requires a real signed
// `.app` bundle on disk, and running it (even --dry-run) is explicitly controller-only per this
// repo's working rules. So unlike release-lib.ts's pure functions (which get real behavioral
// tests), the proof available here is SOURCE-LEVEL: that release.ts actually calls the FULL
// content-identity chain for `ant` — `verifyAntEmbed` against the STAGED pre-sign hash (never the
// vendor source alone, and never a re-hash of the post-sign embedded file) PLUS a real
// `codesign --verify --strict` + `Identifier=com.winter.ant` check on the embedded copy itself —
// in the same place and the same way the pre-existing winter embedded-runtime check runs.
// A future edit that silently drops, weakens, or reorders the wiring fails a test instead of only
// ever being caught by a human re-reading a 1300+ line script during a real release.
import { describe, expect, test } from "bun:test";
import { keychainFfiProbeOk } from "./release-lib";
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

  test("asserts the embedded ant binary's TeamIdentifier/timestamp via the SAME generic assertSigned() winter uses", () => {
    expect(source).toContain("assertSigned(embeddedAntPath");
  });

  test("calls verifyAntEmbed with the repo-root VERSIONS.json text and ant's STAGED record (runtimes/ant/VERSIONS.json, WS-23) — never a hash of the vendor source or the post-sign embedded file — and fails the release on a bad result", () => {
    expect(source).toMatch(/verifyAntEmbed\(\{\s*versionsJsonText:\s*rootVersionsJsonText,\s*stagedAntVersionsText:\s*existsSync\(embeddedAntVersionsPath\)\s*\?\s*readFileSync\(embeddedAntVersionsPath,\s*"utf8"\)\s*:\s*undefined,?\s*\}\)/);
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

  test("documents that the root VERSIONS.json (the ant vendoring pin) is a different file from the staged runtimes/ant/VERSIONS.json", () => {
    expect(source).toContain("runtimes/ant/VERSIONS.json");
    expect(source.toLowerCase()).toContain("different file");
  });

  test("the ant gate (vendor check -> staged-hash check -> embedded codesign check) sits AFTER the winter embedded-runtime check and BEFORE the Row 16 winter-source section — the same sequence position as the winter check it mirrors", () => {
    const winterGateIdx = source.indexOf("Embedded runtimes verified: winter re-signed");
    const antAssertSignedIdx = source.indexOf("assertSigned(embeddedAntPath");
    const antStagedCheckIdx = source.indexOf("verifyAntEmbed({");
    const antCodesignVerifyIdx = source.indexOf('codesign --verify --strict "${embeddedAntPath}"');
    const row16Idx = source.indexOf("Row 16 STRONG (P9a-8)");
    for (const idx of [winterGateIdx, antAssertSignedIdx, antStagedCheckIdx, antCodesignVerifyIdx, row16Idx]) expect(idx).toBeGreaterThan(-1);
    expect(antAssertSignedIdx).toBeGreaterThan(winterGateIdx);
    expect(antStagedCheckIdx).toBeGreaterThan(antAssertSignedIdx);
    expect(antCodesignVerifyIdx).toBeGreaterThan(antStagedCheckIdx);
    expect(antCodesignVerifyIdx).toBeLessThan(row16Idx);
  });

  test("ant is RE-SIGNED like winter — HARDENING_PINS enrolls it in the same no-entitlements-relaxation posture", () => {
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
const antEmbedCheck = verifyAntEmbed({
  versionsJsonText: rootVersionsJsonText,
  stagedAntVersionsText: existsSync(embeddedAntVersionsPath) ? readFileSync(embeddedAntVersionsPath, "utf8") : undefined,
});
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
    expect(fixture).toMatch(/verifyAntEmbed\(\{\s*versionsJsonText:\s*rootVersionsJsonText,\s*stagedAntVersionsText:\s*existsSync\(embeddedAntVersionsPath\)\s*\?\s*readFileSync\(embeddedAntVersionsPath,\s*"utf8"\)\s*:\s*undefined,?\s*\}\)/);
    expect(fixture).toMatch(/if \(!antEmbedCheck\.ok\)\s*\{\s*fail\(/);
    expect(fixture).toMatch(/if \(!existsSync\(vendoredAntPath\)\)\s*\{\s*fail\(/);
    expect(fixture).toMatch(/vendoredAntSha256 !== antPin\.binarySha256/);
    expect(fixture).toMatch(/codesign --verify --strict "\$\{embeddedAntPath\}"/);
    expect(fixture).toContain('antDvv.includes("Identifier=com.winter.ant")');
  });
});

// A2 (2026-09-22): the bun-compiled binaries Winter signs itself carry EXACTLY the JIT entitlement.
// Under the hardened runtime without `com.apple.security.cs.allow-jit`, JavaScriptCore runs JIT-less:
// `SharedArrayBuffer` does not exist (the retired official peer's top-level `new SharedArrayBuffer(4)`
// threw `ReferenceError` in every shipped daemon on exactly that) and everything else runs ~5x slower (measured: 228 ms -> 1179 ms on one loop+JSON bench;
// 206 ms with the entitlement). The signing sites and the release gate's expectation must agree, so
// all of them are pinned here against the ONE entitlements file.
describe("A2: winter-core and winter are signed with their bun entitlements, and the release gate expects exactly those", () => {
  const REPO_ROOT = join(import.meta.dir, "..");
  const entitlementsPath = join(REPO_ROOT, "scripts", "bun-jit.entitlements");
  const projectYml = readFileSync(join(REPO_ROOT, "apple", "Winter", "project.yml"), "utf8");

  test("scripts/bun-jit.entitlements grants exactly com.apple.security.cs.allow-jit", () => {
    const text = readFileSync(entitlementsPath, "utf8");
    const keys = [...text.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
    expect(keys).toEqual(["com.apple.security.cs.allow-jit"]);
    expect(text).toMatch(/<key>com\.apple\.security\.cs\.allow-jit<\/key>\s*<true\/>/);
  });

  // 0.120.1: winter-core runs `bun:ffi` (the app-token access lists), which the hardened runtime kills
  // without `allow-unsigned-executable-memory` — 0.120.0's daemon crash-looped at boot on exactly that. So
  // winter-core has its OWN file with that one more key; the embedded `winter` runtime keeps bun-jit.
  test("scripts/winter-core.entitlements grants exactly allow-jit + allow-unsigned-executable-memory", () => {
    const text = readFileSync(join(REPO_ROOT, "scripts", "winter-core.entitlements"), "utf8");
    const keys = [...text.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
    expect(keys).toEqual(["com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory"]);
  });

  test("project.yml's Embed winter-core re-sign passes winter-core's own entitlements file", () => {
    const line = projectYml.split("\n").find((l) => l.includes("codesign --force") && l.includes('"${DEST_RES}/winter-core"'));
    expect(line).toBeDefined();
    expect(line).toContain("--options runtime");
    expect(line).toContain('--entitlements "${SRCROOT}/../../scripts/winter-core.entitlements"');
  });

  test("release.ts's HARDENING_PINS expects exactly allow-jit + allow-unsigned-executable-memory on winter-core", () => {
    expect(source).toContain('{ path: join(app, "Contents", "Resources", "winter-core"), label: "winter-core", expect: [JIT, UNSIGNED_EXEC_MEMORY] }');
  });

  test("release.ts runs the signed winter-core's __keychain-ffi-probe and fails the release when it does not print ok", () => {
    expect(source).toContain('__keychain-ffi-probe 2>&1`');
    expect(source).toContain("if (!probed.ok || !keychainFfiProbeOk(probed.stdout)) {");
  });

  test("WS-27: the probe passes only when BOTH ffi libraries answered — the keychain status AND sysctl's start time", () => {
    expect(keychainFfiProbeOk("keychain-ffi: ok (default keychain unlocked; process start 1790538364)\n")).toBe(true);
    expect(keychainFfiProbeOk("keychain-ffi: ok (default keychain locked; process start 1790538364)")).toBe(true);
    // 0.120.x's line (no sysctl answer), a zero start, and the probe's own failure line are all refusals.
    expect(keychainFfiProbeOk("keychain-ffi: ok (default keychain unlocked)")).toBe(false);
    expect(keychainFfiProbeOk("keychain-ffi: ok (default keychain unlocked; process start 0)")).toBe(false);
    expect(keychainFfiProbeOk("keychain-ffi: FAILED (sysctl kern.proc.pid gave no start time)")).toBe(false);
    // The route prints that exact shape.
    const main = readFileSync(join(REPO_ROOT, "packages", "cli", "src", "main.ts"), "utf8");
    expect(main).toContain("keychain-ffi: ok (default keychain ${unlocked ? \"unlocked\" : \"locked\"}; process start ${started})");
  });

  // The embedded `winter` runtime is a bun binary too (measured: `Bun v1.4.2` in the shipped
  // `runtimes/winter`, flags=0x10000(runtime), no entitlements) — the same JIT-less posture. `ant` is
  // Go and needs nothing, so it stays at none.
  const embedScript = readFileSync(join(REPO_ROOT, "scripts", "embed-runtimes.sh"), "utf8");
  test("embed-runtimes.sh re-signs winter (and only winter, not ant) with the same entitlements file", () => {
    const winterSign = embedScript.split("\n").find((l) => l.startsWith("codesign --force") && l.includes('"${WINTER}"'));
    const antSign = embedScript.split("\n").find((l) => l.startsWith("codesign --force") && l.includes('"${ANT}"'));
    expect(winterSign).toContain('--entitlements "${SCRIPT_DIR}/bun-jit.entitlements"');
    expect(winterSign).toContain("--identifier com.winter.runtime");
    expect(antSign).toBeDefined();
    expect(antSign).not.toContain("--entitlements");
  });

  test("release.ts's HARDENING_PINS expects exactly allow-jit on the embedded winter runtime, and none on ant", () => {
    expect(source).toContain('{ path: embeddedWinterPath, label: "winter (embedded runtime)", expect: [JIT] }');
    expect(source).toContain('{ path: embeddedAntPath, label: "ant (embedded runtime)", expect: [] }');
  });
});

// ComputerV2: Winter Computer Use, the helper app with its own TCC grants, is embedded, signed and checked like
// every other component Winter signs — plus the facts TCC and the daemon key on (scripts/computer-helper-lib.ts).
describe("ComputerV2: release.ts signs, verifies and scans the Winter Computer Use helper", () => {
  const REPO_ROOT = join(import.meta.dir, "..");
  const projectYml = readFileSync(join(REPO_ROOT, "apple", "Winter", "project.yml"), "utf8");
  const embedScript = readFileSync(join(REPO_ROOT, "scripts", "embed-computer-helper.sh"), "utf8");

  test("project.yml embeds it through embed-computer-helper.sh, Release only, after the WinterComputerUse target builds", () => {
    expect(projectYml).toContain('"${SRCROOT}/../../scripts/embed-computer-helper.sh"');
    expect(projectYml).toMatch(/- target: WinterComputerUse\n\s+embed: false/);
    expect(embedScript).toMatch(/if \[ "\$\{CONFIGURATION:-\}" != "Release" \]; then/);
  });

  test("the embed re-signs with the hardened runtime, a timestamp, the stable identifier, the STATED requirement — and the Apple Events entitlement only", () => {
    const sign = embedScript.split("\n").findIndex((l) => l.startsWith("codesign --force") && l.includes('"${IDENTIFIER}"'));
    const line = `${embedScript.split("\n")[sign]} ${embedScript.split("\n")[sign + 1]}`;
    expect(line).toContain('--identifier "${IDENTIFIER}"');
    expect(line).toContain("--options runtime");
    expect(line).toContain("--timestamp");
    expect(line).toContain('"-r=designated => ${REQUIREMENT}"');
    expect(line).toContain('--entitlements "${ENTITLEMENTS_FILE}"');
    expect(embedScript).toContain('ENTITLEMENT="com.apple.security.automation.apple-events"');
    expect(projectYml).toContain("CODE_SIGN_ENTITLEMENTS: ../ComputerUse/WinterComputerUse/Support/WinterComputerUse.entitlements");
    expect(projectYml).toContain("NSAppleEventsUsageDescription:");
    expect(embedScript).toContain('REQUIREMENT="identifier \\"${IDENTIFIER}\\" and anchor apple generic and certificate leaf[subject.OU] = \\"${TEAM}\\""');
  });

  test("release.ts asserts its team + timestamp, runs checkSignedHelper on it, and checks the stated requirement is satisfied", () => {
    expect(source).toMatch(/import \{[^}]*checkSignedHelper[^}]*\} from "\.\/computer-helper-lib"/);
    expect(source).toContain("const computerHelperApp = join(app, HELPER_EMBED_RELATIVE);");
    expect(source).toContain('assertSigned(computerHelperApp, "Winter Computer Use");');
    // At the helper's OWN version (apple/ComputerUse/VERSION), not this release's.
    expect(source).toContain("const helperVersion = readHelperVersion();");
    expect(source).toContain('checkSignedHelper("dist", TEAM_ID, helperVersion, {');
    expect(source).toMatch(/codesign --verify --strict -R='\$\{stated\}' "\$\{computerHelperApp\}"/);
  });

  test("HARDENING_PINS enrolls it with exactly no cs.* entitlement", () => {
    expect(source).toContain('{ path: computerHelperApp, label: "Winter Computer Use", expect: [] }');
    expect(source).toContain('{ path: browserHostPath, label: "winter-browser-host", expect: [] }');
  });

  test("winter-browser-host: the embed signs it FIRST with its own identity, stated requirement, runtime, timestamp and no entitlements", () => {
    const lines = embedScript.split("\n");
    const host = lines.findIndex((l) => l.startsWith("codesign --force") && l.includes('"${HOST_IDENTIFIER}"'));
    const helper = lines.findIndex((l) => l.startsWith("codesign --force") && l.includes('"${IDENTIFIER}"'));
    expect(host).toBeGreaterThan(-1);
    expect(host).toBeLessThan(helper);
    const line = `${lines[host]} ${lines[host + 1]}`;
    expect(line).toContain("--options runtime");
    expect(line).toContain("--timestamp");
    expect(line).toContain('"-r=designated => ${HOST_REQUIREMENT}"');
    expect(line).not.toContain("--entitlements");
    expect(embedScript).toContain('HOST_IDENTIFIER="com.winter.browserhost"');
    expect(embedScript).toContain('HOST_REQUIREMENT="identifier \\"${HOST_IDENTIFIER}\\" and anchor apple generic and certificate leaf[subject.OU] = \\"${TEAM}\\""');
    expect(embedScript).not.toMatch(/codesign[^\n]*--deep[^\n]*--sign/);
  });

  test("release.ts verifies the host it ships: team + timestamp, checkSignedBrowserHost, its stated requirement satisfied", () => {
    expect(source).toContain("const browserHostPath = browserHostExecutable(computerHelperApp);");
    expect(source).toContain('assertSigned(browserHostPath, "winter-browser-host");');
    expect(source).toContain('checkSignedBrowserHost("dist", TEAM_ID, {');
    expect(source).toMatch(/codesign --verify --strict -R='\$\{stated\}' "\$\{browserHostPath\}"/);
  });

  test("the identity scan covers it whole: release.ts refuses any exclusion reaching into Contents/Helpers", () => {
    expect(source).toContain('scan.excluded.some((p) => p.slice(app.length + 1).startsWith("Contents/Helpers"))');
  });

  test("the standalone Release build product is dropped from LaunchServices", () => {
    expect(source).toMatch(/probe\(`"\$\{LSREGISTER\}" -u "\$\{join\(dd, "Build", "Products", "Release", `\$\{HELPER\.dist\.name\}\.app`\)\}"`\);/);
  });
});
