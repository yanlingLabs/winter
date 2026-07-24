/**
 * Norma release pipeline (release-pipeline T2 core + T3 DMG/appcast/cask/publish). Chains:
 *   preflight -> [version bump] -> build (Developer ID + hardened runtime, T1's canonical
 *   override invocation) -> verify nested signatures -> zip -> notarize -> staple -> re-zip
 *   the stapled app -> spctl/stapler gates -> DMG (stage+hdiutil+codesign+notarize+staple+
 *   gates) -> appcast enclosure signing + item insertion -> cask render -> --dry-run stops
 *   here (skip-list only) -> publish tail (gh release, appcast commit/push, git tag/push).
 *
 * Usage: bun run scripts/release.ts --dry-run [--beta] [--no-bump] [--resume-publish]
 *
 * `--beta` threads into `appcastItem`'s `<sparkle:channel>beta</sparkle:channel>` element.
 * `--dry-run` NEVER publishes (no gh release/upload, no appcast commit/push, no tags) — it
 * still builds, notarizes (app AND dmg — two real submissions), staples, signs the appcast
 * enclosure (falling back to an ephemeral test key when the production one is absent, loudly
 * labeled), and renders the cask, so everything up to publish is exercised for real. It
 * downgrades the production-Sparkle-key and gh-auth preflight checks to warnings; every other
 * check (identity, notary profile, clean tree, tag collision) still hard-fails regardless of
 * --dry-run. `--resume-publish` (non-dry-run only): an existing release is expected — upload
 * only assets missing from it and skip the appcast commit/tag if already done.
 *
 * Whole-branch review fix (F1/F2, see .superpowers/sdd/progress-release.md): the appcast
 * `<item>` insert decision is `appcastInsertPlan` (release-lib.ts, unit-tested) — under
 * --dry-run it writes ONLY a preview at out/release/<v>/appcast-preview.xml, mirroring the
 * cask's out/ render; the TRACKED releases/appcast.xml is written only from inside the
 * publish tail's `if (!DRY_RUN)` block, never before. The insert is also idempotent: an
 * `<item>` whose `<sparkle:version>` already matches the release version is skipped rather than
 * duplicated, so --resume-publish after a partial failure (or a stray re-run) can't double-
 * insert or get blocked by a self-inflicted dirty tree.
 *
 * T1 findings this script carries (see .superpowers/sdd/task-11-report.md):
 *  - CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO is REQUIRED — without it Xcode injects
 *    get-task-allow=true and notarization silently auto-rejects.
 *  - The "Embed norma-core" postCompileScript now signs with --options runtime --timestamp
 *    (apple/Norma/project.yml, committed) so the nested binary carries hardened runtime too.
 *  - NormaHelper's embedded codesign identifier becomes "NormaHelper" (not "com.norma.helper")
 *    under this override set — confirmed harmless (Label-based launchd matching, team-based
 *    peer trust) — not fixed here, out of scope.
 *
 * T2 finding (this task, empirical — only surfaces on a REAL notarization submission, which is
 * why T1's audit couldn't have caught it): Sparkle.framework's own bundle gets correctly
 * re-signed by Xcode's "Embed Frameworks" copy-and-sign step (TeamIdentifier=37N77U9RSZ, per
 * T1), but that step does not recurse into the framework's OWN nested code. Sparkle's SPM
 * binary distribution ships Autoupdate, Updater.app, and the two XPCServices helpers ad-hoc
 * signed (flags=0x10002(adhoc,runtime), TeamIdentifier=not set, no secure timestamp) — the
 * first real `notarytool submit` rejected the build on exactly these four paths ("not signed
 * with a valid Developer ID certificate" + "signature does not include a secure timestamp").
 * Fixed below by re-signing each nested helper ourselves (deepest-first — codesign requires
 * inside-out signing since signing a container after its contents change invalidates the
 * container's own seal), preserving each one's existing entitlements as-is (extracted then
 * reapplied; Autoupdate is the only one with a real entitlement — see resignPreserving below),
 * then re-signing Sparkle.framework and finally the outer Norma.app so their seals pick up the
 * changed nested content.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FORMAT, ROOT, readCanonical } from "./version-lib";
import {
  GH_REPO,
  appcastInsertPlan,
  appcastItem,
  caskFrom,
  dmgStagePlan,
  preflight,
  publishGuard,
  resolveSigningIdentity,
} from "./release-lib";

const TEAM_ID = "37N77U9RSZ";
const NOTARY_PROFILE = "norma-notary";
const APPLE_DIR = join(ROOT, "apple", "Norma");
// Matches apple/Norma/project.yml's deploymentTarget / LSMinimumSystemVersion / MACOSX_DEPLOYMENT_TARGET.
const MIN_SYSTEM = "26.0";
// Sparkle CLI tools (sign_update, generate_keys) — same dist + version as scripts/sparkle-feed-gate.ts
// (T6's adaptation note: must match Package.resolved, not project.yml's `from:` floor).
const SPARKLE_VERSION = "2.9.4";
const SPARKLE_TOOLS = join(ROOT, ".tools", "sparkle");

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const BETA = argv.includes("--beta");
const NO_BUMP = argv.includes("--no-bump");
const RESUME_PUBLISH = argv.includes("--resume-publish");

function fail(msg: string): never {
  console.error(`\nFAIL: ${msg}\n`);
  process.exit(1);
}

// Throwing shell helper for steps that should abort the whole run on any nonzero exit —
// mirrors scripts/sparkle-feed-gate.ts's `sh` idiom.
const sh = (cmd: string, cwd = ROOT): string =>
  execSync(cmd, { cwd, stdio: "pipe", encoding: "utf8" });

// Non-throwing probe — used ONLY by preflight checks, which must run to completion and
// aggregate every failure rather than aborting on the first shell error.
function probe(cmd: string, cwd = ROOT): { ok: boolean; stdout: string } {
  try {
    return { ok: true, stdout: execSync(cmd, { cwd, stdio: "pipe", encoding: "utf8" }) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, stdout: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

// ---------------------------------------------------------------------------
// 1. Preflight — abort listing ALL failures at once, never just the first one hit.
// ---------------------------------------------------------------------------
const preVersion = readCanonical();
const pre = preflight({
  checks: {
    identity: () => {
      const out = probe(`security find-identity -v -p codesigning`).stdout;
      if (out.includes("Developer ID Application") && out.includes(TEAM_ID)) return null;
      return `missing Developer ID identity for team ${TEAM_ID} — create it in Xcode > Settings > Accounts > Manage Certificates`;
    },
    notary: () => {
      // `notarytool history` exits 0 for both "No submission history." and a populated list;
      // it exits nonzero (observed: 69) on an invalid/missing keychain profile.
      const r = probe(`xcrun notarytool history --keychain-profile ${NOTARY_PROFILE}`);
      if (r.ok) return null;
      return `notary profile '${NOTARY_PROFILE}' missing/invalid — run: xcrun notarytool store-credentials ${NOTARY_PROFILE} --apple-id <email> --team-id ${TEAM_ID}`;
    },
    prodKey: () => {
      const r = probe(`security find-generic-password -s "https://sparkle-project.org"`);
      if (r.ok) return null;
      const line = `production Sparkle key missing — run: .tools/sparkle/bin/generate_keys   (60 seconds; back it up with -x)`;
      if (DRY_RUN) {
        console.warn(
          `WARNING: ${line}\n  (dry-run: downgraded to a warning — a real release still needs it for appcast signing)`,
        );
        return null;
      }
      return line;
    },
    gh: () => {
      const r = probe(`gh auth status`);
      if (r.ok) return null;
      const line = `gh not authenticated — run: gh auth login`;
      if (DRY_RUN) {
        console.warn(`WARNING: ${line}`);
        return null;
      }
      return line;
    },
    tree: () => {
      const out = probe(`git status --porcelain`).stdout.trim();
      return out === "" ? null : `working tree not clean — commit or stash changes before releasing`;
    },
    tag: () => {
      // Check the tag for the version this run will actually RELEASE: preVersion under
      // --no-bump, else the post-bump next patch. Checking v<preVersion> unconditionally made
      // every second bumping release fail — after a successful release the tree legitimately
      // sits at the last-released version, whose tag always exists. (Patch 999 rollover is
      // bump-version's concern; the guard then re-checks conservatively on the raw string.)
      const m = preVersion.match(FORMAT);
      const releasing =
        NO_BUMP || !m ? preVersion : `${m[1]}.${m[2]}.${String(Number(m[3]) + 1).padStart(3, "0")}`;
      const out = probe(`git tag -l v${releasing}`).stdout.trim();
      return out === "" ? null : `tag v${releasing} already exists — bump the version or delete the stale tag`;
    },
  },
});

if (!pre.ok) {
  console.error("Preflight failed:");
  for (const line of pre.failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log("Preflight: OK");

// ---------------------------------------------------------------------------
// 1b. Resolve the signing identity ONCE, up front — every codesign --sign call below (app
//     resign, its nested/embedded binaries, DMG) uses this same resolved SHA-1 hash, never a
//     display name, so no legal/company name needs to live in this repo and every signature
//     comes from the exact same, unambiguous identity. `NORMA_SIGN_IDENTITY` is an escape hatch
//     (e.g. a differently-provisioned keychain in CI) that skips the `security find-identity`
//     lookup entirely.
// ---------------------------------------------------------------------------
const signIdentityEnv = process.env.NORMA_SIGN_IDENTITY;
const SIGN_IDENTITY = resolveSigningIdentity({
  envOverride: signIdentityEnv,
  identitiesOutput: signIdentityEnv ? "" : sh(`security find-identity -v -p codesigning`),
  teamId: TEAM_ID,
});
console.log(
  `Signing identity resolved: ${SIGN_IDENTITY}${signIdentityEnv ? " (NORMA_SIGN_IDENTITY override)" : ""}`,
);

// ---------------------------------------------------------------------------
// 2. Version bump (unless --no-bump).
// ---------------------------------------------------------------------------
if (!NO_BUMP) {
  console.log("Bumping version...");
  console.log(sh(`bun run version:bump`).trim());
  if (!DRY_RUN) {
    // Commit the bump immediately (v0.2.003 postmortem: a real bumping release left VERSION +
    // stamped files dirty on main through publish — repo/artifact version drift until noticed).
    // Safe to add -A: preflight guarantees the tree was clean, so the only dirt IS the bump.
    sh(`git add -A`);
    sh(`git commit -m "chore(release): v${readCanonical()}"`);
  }
} else {
  console.log(`--no-bump: staying on ${preVersion}`);
}
const version = readCanonical();
console.log(`Releasing version ${version}${BETA ? " (beta)" : ""}`);

// ---------------------------------------------------------------------------
// 3. Build — T1's canonical override invocation, -derivedDataPath out/release/<v>/dd.
// ---------------------------------------------------------------------------
const OUT = join(ROOT, "out", "release", version);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const dd = join(OUT, "dd");

console.log("Generating Xcode project (xcodegen)...");
sh(`xcodegen generate`, APPLE_DIR);

console.log("Building Release (Developer ID, org team 37N77U9RSZ, hardened runtime)...");
sh(
  `xcodebuild -project Norma.xcodeproj -scheme Norma -destination 'platform=macOS' -configuration Release ` +
    // arm64-only: IrohLib ships no x86_64 slice (universal link fails), and the macOS 26 floor
    // leaves no supported Intel audience anyway.
    `ARCHS=arm64 ` +
    `DEVELOPMENT_TEAM=${TEAM_ID} CODE_SIGN_IDENTITY="Developer ID Application" CODE_SIGN_STYLE=Manual ` +
    `OTHER_CODE_SIGN_FLAGS="--timestamp" ENABLE_HARDENED_RUNTIME=YES CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO ` +
    `-derivedDataPath "${dd}" build`,
  APPLE_DIR,
);
const app = join(dd, "Build", "Products", "Release", "Norma.app");
if (!existsSync(app)) fail(`build did not produce ${app}`);
console.log(`Built: ${app}`);

// ---------------------------------------------------------------------------
// 3b. Re-sign Sparkle.framework's nested helper binaries (T2 finding, see header comment) —
//     the SPM binary distribution ships them ad-hoc, which Apple's notary service rejects.
//     Preserves each target's existing entitlements as-is (extract, then reapply).
// ---------------------------------------------------------------------------
function resignPreservingEntitlements(path: string) {
  const entPlist = join(OUT, `.ent-${path.replace(/[^a-zA-Z0-9]/g, "_")}.plist`);
  rmSync(entPlist, { force: true });
  probe(`codesign -d --entitlements ":${entPlist}" "${path}"`); // best-effort; not every target has one
  const entFlag = existsSync(entPlist) ? `--entitlements "${entPlist}"` : "";
  sh(`codesign --force --options runtime --timestamp ${entFlag} --sign "${SIGN_IDENTITY}" "${path}"`);
}
const sparkleFramework = join(app, "Contents", "Frameworks", "Sparkle.framework");
const sparkleVersionsB = join(sparkleFramework, "Versions", "B");
const nestedSparkleHelpers = [
  join(sparkleVersionsB, "Autoupdate"),
  join(sparkleVersionsB, "Updater.app"),
  join(sparkleVersionsB, "XPCServices", "Downloader.xpc"),
  join(sparkleVersionsB, "XPCServices", "Installer.xpc"),
];
console.log("Re-signing Sparkle.framework's nested helper binaries (shipped ad-hoc by the SPM distribution)...");
for (const target of nestedSparkleHelpers) {
  if (!existsSync(target)) {
    console.log(`  (skip — not present in this Sparkle version: ${target})`);
    continue;
  }
  resignPreservingEntitlements(target);
}
// Re-sign the enclosing framework so its own seal picks up the freshly-signed nested content,
// then the outer app so ITS seal picks up the changed nested framework.
resignPreservingEntitlements(sparkleFramework);
resignPreservingEntitlements(app);
console.log("Sparkle.framework nested helpers + framework + outer app re-signed.");

// ---------------------------------------------------------------------------
// 4. Verify signatures BEFORE spending a notarization submission on a bad build.
// ---------------------------------------------------------------------------
console.log("Verifying signatures...");
try {
  sh(`codesign --verify --deep --strict "${app}"`);
} catch {
  fail(`codesign --verify --deep --strict failed on ${app}`);
}
function assertSigned(path: string, label: string) {
  if (!existsSync(path)) fail(`${label} not found at ${path} — build did not embed it as expected`);
  const out = probe(`codesign -dvv "${path}" 2>&1`).stdout;
  if (!out.includes(`TeamIdentifier=${TEAM_ID}`)) {
    fail(`${label}: TeamIdentifier mismatch (expected ${TEAM_ID}):\n${out}`);
  }
  if (!/^Timestamp=/m.test(out)) {
    fail(`${label}: missing secure timestamp (notarization will reject this):\n${out}`);
  }
}
assertSigned(app, "Norma.app");
assertSigned(join(app, "Contents", "Resources", "norma-core"), "norma-core");
assertSigned(join(app, "Contents", "MacOS", "NormaHelper"), "NormaHelper");
assertSigned(sparkleFramework, "Sparkle.framework");
for (const target of nestedSparkleHelpers) {
  if (existsSync(target)) assertSigned(target, `Sparkle.framework nested helper (${target.split("/").pop()})`);
}
console.log(
  "Signatures verified: codesign --verify --deep --strict PASS; TeamIdentifier + secure timestamp confirmed on app + norma-core + NormaHelper + Sparkle.framework + its nested helpers.",
);

// ---------------------------------------------------------------------------
// 5. ditto zip for notarization submission.
// ---------------------------------------------------------------------------
console.log("Creating zip for notarization submission...");
const zipPath = join(OUT, `Norma-${version}.zip`);
rmSync(zipPath, { force: true });
sh(`ditto -c -k --sequesterRsrc --keepParent "${app}" "${zipPath}"`);

// ---------------------------------------------------------------------------
// 6. Notarize. `--wait` blocks until Apple finishes processing; `--output-format json` gives
//    a single parseable blob at the end instead of a progress stream.
// ---------------------------------------------------------------------------
interface NotarizeResult {
  id?: string;
  status?: string;
  message?: string;
}
function notarizeSubmit(path: string): NotarizeResult {
  const cmd = `xcrun notarytool submit "${path}" --keychain-profile ${NOTARY_PROFILE} --wait --output-format json`;
  try {
    const raw = execSync(cmd, { cwd: ROOT, stdio: "pipe", encoding: "utf8" });
    return JSON.parse(raw) as NotarizeResult;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    try {
      return JSON.parse(err.stdout ?? "") as NotarizeResult;
    } catch {
      fail(`notarytool submit failed:\n${err.stdout ?? ""}${err.stderr ?? ""}`);
    }
  }
}
console.log("Submitting for notarization (can take 1-15 minutes; --wait blocks until done)...");
const submission = notarizeSubmit(zipPath);
console.log(`Submission ${submission.id}: ${submission.status}`);
if (submission.status !== "Accepted") {
  if (submission.id) {
    console.error(`notarytool log ${submission.id}:`);
    try {
      console.error(sh(`xcrun notarytool log ${submission.id} --keychain-profile ${NOTARY_PROFILE}`));
    } catch (e) {
      console.error(`(failed to fetch notarization log: ${e})`);
    }
  }
  fail(`notarization did not succeed: status=${submission.status} message=${submission.message ?? ""}`);
}

// ---------------------------------------------------------------------------
// 7. Staple the ticket to the app, then RE-ZIP the stapled app as the final enclosure —
//    replaces the pre-staple zip (the enclosure Sparkle/humans download must be the stapled
//    bundle, so a plain online Gatekeeper check works even fully offline).
// ---------------------------------------------------------------------------
console.log("Stapling notarization ticket...");
sh(`xcrun stapler staple "${app}"`);

console.log("Re-zipping the stapled app as the final enclosure (replaces the pre-staple zip)...");
rmSync(zipPath, { force: true });
sh(`ditto -c -k --sequesterRsrc --keepParent "${app}" "${zipPath}"`);

// ---------------------------------------------------------------------------
// 8. Gates: spctl must now PASS (it correctly failed pre-notarization per T1's baseline);
//    stapler validate confirms the ticket is actually attached, not just requested.
// ---------------------------------------------------------------------------
console.log("Gate: spctl --assess --type execute...");
const spctl = probe(`spctl --assess --type execute "${app}" 2>&1`);
console.log(`  ${spctl.stdout.trim()}`);
if (!spctl.ok) fail(`spctl --assess rejected ${app} even after stapling`);

console.log("Gate: stapler validate...");
const staplerValidate = probe(`xcrun stapler validate "${app}" 2>&1`);
console.log(`  ${staplerValidate.stdout.trim()}`);
if (!staplerValidate.ok) fail(`stapler validate failed on ${app}`);

console.log("Gates passed: spctl --assess PASS, stapler validate PASS.");

// ---------------------------------------------------------------------------
// 9. DMG: stage the (already stapled) app + /Applications symlink, build with hdiutil, sign,
//    notarize (a SECOND, independent submission — the DMG is its own Gatekeeper-checked
//    artifact), staple, gate. Runs regardless of --dry-run (only the PUBLISH tail, section 12,
//    is skipped under --dry-run).
// ---------------------------------------------------------------------------
console.log("Staging DMG contents (app + /Applications symlink)...");
const dmgStage = join(OUT, "dmg-stage");
rmSync(dmgStage, { recursive: true, force: true });
mkdirSync(dmgStage, { recursive: true });
for (const op of dmgStagePlan(app)) {
  const dest = join(dmgStage, op.destName);
  // `ditto` (not Node's cpSync) — preserves resource forks / extended attributes exactly, the
  // same reason it's used everywhere else in this pipeline for the app bundle (zip step,
  // above); a plain byte copy risks silently dropping the stapled notarization ticket.
  if (op.kind === "copy") sh(`ditto "${op.source}" "${dest}"`);
  else symlinkSync(op.source, dest);
}

const dmgPath = join(OUT, `Norma-${version}.dmg`);
rmSync(dmgPath, { force: true });
console.log("Creating DMG (hdiutil)...");
sh(`hdiutil create -volname "Norma" -srcfolder "${dmgStage}" -ov -format UDZO "${dmgPath}"`);

console.log("Signing DMG...");
sh(`codesign --sign "${SIGN_IDENTITY}" --timestamp "${dmgPath}"`);
assertSigned(dmgPath, "Norma.dmg");

console.log("Submitting DMG for notarization (second submission this release; can take 1-15 minutes)...");
const dmgSubmission = notarizeSubmit(dmgPath);
console.log(`DMG submission ${dmgSubmission.id}: ${dmgSubmission.status}`);
if (dmgSubmission.status !== "Accepted") {
  if (dmgSubmission.id) {
    console.error(`notarytool log ${dmgSubmission.id}:`);
    try {
      console.error(sh(`xcrun notarytool log ${dmgSubmission.id} --keychain-profile ${NOTARY_PROFILE}`));
    } catch (e) {
      console.error(`(failed to fetch notarization log: ${e})`);
    }
  }
  fail(`DMG notarization did not succeed: status=${dmgSubmission.status} message=${dmgSubmission.message ?? ""}`);
}

console.log("Stapling DMG...");
sh(`xcrun stapler staple "${dmgPath}"`);

console.log("Gate: spctl --assess --type open --context context:primary-signature (DMG)...");
const spctlDmg = probe(`spctl --assess --type open --context context:primary-signature "${dmgPath}" 2>&1`);
console.log(`  ${spctlDmg.stdout.trim()}`);
if (!spctlDmg.ok) fail(`spctl --assess rejected the DMG even after stapling`);

console.log("Gate: stapler validate (DMG)...");
const staplerValidateDmg = probe(`xcrun stapler validate "${dmgPath}" 2>&1`);
console.log(`  ${staplerValidateDmg.stdout.trim()}`);
if (!staplerValidateDmg.ok) fail(`stapler validate failed on the DMG`);

console.log(`DMG built + notarized + stapled: ${dmgPath}`);

// ---------------------------------------------------------------------------
// 10. Appcast: EdDSA-sign the (already notarized+stapled) Sparkle enclosure zip with the
//     production Keychain key when present; else — --dry-run ONLY — fall back to a throwaway
//     ephemeral test key (never the production account), loudly labeled non-publishable. The
//     preflight `prodKey` check already hard-fails a non-dry-run run before this point if the
//     production key is absent, so reaching here without it means --dry-run.
// ---------------------------------------------------------------------------
if (!existsSync(join(SPARKLE_TOOLS, "bin", "sign_update"))) {
  console.log("Fetching Sparkle CLI tools (sign_update/generate_keys)...");
  mkdirSync(SPARKLE_TOOLS, { recursive: true });
  const url = `https://github.com/sparkle-project/Sparkle/releases/download/${SPARKLE_VERSION}/Sparkle-${SPARKLE_VERSION}.tar.xz`;
  sh(`curl -sL "${url}" -o "${SPARKLE_TOOLS}/sparkle.tar.xz" && tar -xf "${SPARKLE_TOOLS}/sparkle.tar.xz" -C "${SPARKLE_TOOLS}"`);
}
const SIGN_UPDATE = join(SPARKLE_TOOLS, "bin", "sign_update");
const GENERATE_KEYS = join(SPARKLE_TOOLS, "bin", "generate_keys");
const DRY_RUN_TEST_KEY_ACCOUNT = "norma-release-dry-run-test";

function signAppcastEnclosure(zipFile: string): { edSignature: string; length: number; testKey: boolean } {
  const hasProdKey = probe(`security find-generic-password -s "https://sparkle-project.org"`).ok;
  let testKeyFile: string | null = null;
  if (!hasProdKey) {
    if (!DRY_RUN) fail("production Sparkle key missing — cannot sign the release appcast enclosure");
    console.warn(
      "WARNING: production Sparkle key missing — signing the appcast enclosure with an EPHEMERAL test key.\n" +
        "  [DRY-RUN: test key — NOT publishable]",
    );
    testKeyFile = join(OUT, "dry-run-test-eddsa.key");
    rmSync(testKeyFile, { force: true });
    sh(`"${GENERATE_KEYS}" --account ${DRY_RUN_TEST_KEY_ACCOUNT}`);
    sh(`"${GENERATE_KEYS}" --account ${DRY_RUN_TEST_KEY_ACCOUNT} -x "${testKeyFile}"`);
  }
  const cmd = testKeyFile
    ? `"${SIGN_UPDATE}" -f "${testKeyFile}" "${zipFile}"`
    : `"${SIGN_UPDATE}" "${zipFile}"`;
  // Cleanup lives in `finally` around ONLY the signing call (not the whole function) because
  // `fail()` below calls process.exit(), which — unlike a thrown error — does not unwind the
  // stack, so any finally wrapping a fail() would never actually run. Wrapping just `sh(cmd)`
  // guarantees the ephemeral Keychain item is deleted even if sign_update itself fails.
  let out: string;
  try {
    out = sh(cmd).trim();
  } finally {
    if (testKeyFile) {
      // Ephemeral means ephemeral — delete the Keychain item now that signing is done (mirrors
      // scripts/sparkle-feed-gate.ts's cleanup; best-effort, item may already be gone).
      try {
        sh(`security delete-generic-password -a "${DRY_RUN_TEST_KEY_ACCOUNT}" -s "https://sparkle-project.org"`);
      } catch {
        // already absent — fine.
      }
    }
  }
  const m = out.match(/sparkle:edSignature="([^"]+)"\s+length="(\d+)"/);
  if (!m) fail(`unexpected sign_update output for ${zipFile}: ${out}`);
  return { edSignature: m[1]!, length: Number(m[2]), testKey: testKeyFile !== null };
}

console.log("Signing the Sparkle enclosure (zip) with EdDSA...");
const signResult = signAppcastEnclosure(zipPath);

function assertValidXml(xml: string, label: string) {
  const tmpFile = join(OUT, `.xmllint-check-${Date.now()}.xml`);
  writeFileSync(tmpFile, xml);
  try {
    sh(`xmllint --noout "${tmpFile}"`);
  } catch {
    fail(`${label} failed xmllint validation`);
  } finally {
    rmSync(tmpFile, { force: true });
  }
}

// appcastPath is the ONE tracked file this whole script may ever mutate — reading it here is
// safe (read-only) under any flag combination, but WRITING it must never happen before the
// --dry-run boundary (section 12's `if (!DRY_RUN)`). F1 fix (release whole-branch review): the
// previous code wrote here unconditionally, so a --dry-run permanently dirtied the committed
// appcast with a test-key-signed item — never reverted, and a second dry-run then failed its
// own tree-clean preflight. `appcastInsertPlan` (release-lib.ts, unit-tested) decides target +
// action; only `preview` is ever actually written here — the `repo` write is deferred to the
// publish tail below.
const appcastPath = join(ROOT, "releases", "appcast.xml");
const appcastPreviewPath = join(OUT, "appcast-preview.xml");
const appcastXml = readFileSync(appcastPath, "utf8");
const item = appcastItem({
  version,
  zipName: `Norma-${version}.zip`,
  edSignature: signResult.edSignature,
  length: signResult.length,
  beta: BETA,
  minSystem: MIN_SYSTEM,
});
let appcastPlan: ReturnType<typeof appcastInsertPlan>;
try {
  appcastPlan = appcastInsertPlan({ dryRun: DRY_RUN, version, appcastXml, item });
} catch (e) {
  fail(`${appcastPath}: ${(e as Error).message}`);
}
if (appcastPlan.action === "insert") {
  assertValidXml(appcastPlan.updatedXml!, "appcast (with new item)");
}
if (appcastPlan.target === "preview") {
  // --dry-run: releases/appcast.xml is NEVER touched (F1) — preview only, mirroring the cask's
  // out/ render (section 11, below).
  if (appcastPlan.action === "insert") {
    writeFileSync(appcastPreviewPath, appcastPlan.updatedXml!);
    console.log(
      `Appcast entry previewed at ${appcastPreviewPath} (dry-run: ${appcastPath} NOT touched)` +
        `${signResult.testKey ? " [DRY-RUN: test key — NOT publishable]" : ""}.`,
    );
  } else {
    console.log(`Appcast already carries ${version} — skipping insert (dry-run: ${appcastPath} NOT touched).`);
  }
}
// appcastPlan.target === "repo" (a real, non-dry-run run): the actual releases/appcast.xml
// write is deferred to the publish tail (section 12, inside `if (!DRY_RUN)`) — see F1 above.

// ---------------------------------------------------------------------------
// 11. Cask: render packaging/norma.rb.tmpl with this release's version/sha256(DMG)/url into
//     out/release/<v>/norma.rb — per-release build output; only the .tmpl is committed.
// ---------------------------------------------------------------------------
console.log("Rendering Homebrew cask...");
const dmgSha256 = sh(`shasum -a 256 "${dmgPath}"`).trim().split(/\s+/)[0]!;
const caskTmplPath = join(ROOT, "packaging", "norma.rb.tmpl");
const caskTmpl = readFileSync(caskTmplPath, "utf8");
const caskRendered = caskFrom(caskTmpl, {
  version,
  sha256: dmgSha256,
  url: `https://github.com/${GH_REPO}/releases/download/v${version}/Norma-${version}.dmg`,
});
const caskOutPath = join(OUT, "norma.rb");
writeFileSync(caskOutPath, caskRendered);
console.log(`Cask rendered: ${caskOutPath} (sha256 ${dmgSha256})`);

// ---------------------------------------------------------------------------
// 12. Publish tail. Guards run FIRST (tag + gh release existence, re-checked HERE against the
//     actual post-bump `version` — not preflight's pre-bump snapshot — so a version bump
//     landing on a stale tag/release still aborts loudly instead of double-publishing).
//     --dry-run is checked first and is NEVER reachable past this point: the entire publish
//     tail lives inside `if (!DRY_RUN)`; the dry-run branch only prints the skip-list.
// ---------------------------------------------------------------------------
const tagExists = probe(`git tag -l v${version}`).stdout.trim() !== "";
const releaseExists = probe(`gh release view v${version}`).ok;
const guard = publishGuard({ dryRun: DRY_RUN, resumePublish: RESUME_PUBLISH, tagExists, releaseExists, version });

if (DRY_RUN) {
  console.log(`
Artifacts:
  App: ${app}
  Zip: ${zipPath}
  DMG: ${dmgPath}
  Cask: ${caskOutPath}
  Appcast preview: ${appcastPlan.action === "insert" ? appcastPreviewPath : `(skipped — ${version} already in ${appcastPath})`}
  Version: ${version}
  App notarization: ${submission.id} (${submission.status})
  DMG notarization: ${dmgSubmission.id} (${dmgSubmission.status})
  Appcast enclosure signature: ${signResult.testKey ? "EPHEMERAL TEST KEY [DRY-RUN: test key — NOT publishable]" : "production key"}

DRY RUN: publish skipped —
${guard.lines.map((l) => `  - ${l}`).join("\n")}
`);
  process.exit(0);
}

if (guard.action === "abort") {
  console.error("\nPublish aborted:");
  for (const line of guard.lines) console.error(`  - ${line}`);
  process.exit(1);
}

// Tag BEFORE `gh release create` (both publish AND resume paths): gh auto-creates a missing
// tag at the default-branch HEAD, which races the appcast commit pushed below — the v0.2.002
// release failed its own final tag push against gh's auto-created one. Creating and pushing
// the tag first pins the release to exactly this checkout's commit. Resume-safe: an existing
// tag is just re-pushed (no-op when identical).
if (!tagExists) sh(`git tag v${version}`);
sh(`git push origin v${version}`);

if (guard.action === "publish") {
  console.log(`Publishing v${version}...`);
  const notes = `Norma ${version}${BETA ? " (beta)" : ""}\n\nSigned Sparkle appcast entry: releases/appcast.xml.`;
  const notesPath = join(OUT, "release-notes.md");
  writeFileSync(notesPath, notes);
  sh(`gh release create v${version} --title "Norma ${version}" --notes-file "${notesPath}" "${zipPath}" "${dmgPath}"`);
} else {
  // guard.action === "resume": upload only whatever assets aren't already on the release.
  console.log(`Resuming publish of v${version}...`);
  const existingAssets = JSON.parse(sh(`gh release view v${version} --json assets`)) as {
    assets: { name: string }[];
  };
  const haveNames = new Set(existingAssets.assets.map((a) => a.name));
  for (const p of [zipPath, dmgPath]) {
    const name = p.split("/").pop()!;
    if (haveNames.has(name)) {
      console.log(`  (resume) asset already uploaded: ${name}`);
    } else {
      console.log(`  (resume) uploading missing asset: ${name}`);
      sh(`gh release upload v${version} "${p}"`);
    }
  }
}

// Appcast write + commit+push. The actual releases/appcast.xml write lives HERE — inside
// `!DRY_RUN`, past every abort/exit above (F1 fix, see section 10) — never earlier. Resume-safe
// both ways: `appcastPlan.action === "skip"` means a prior attempt already wrote this version's
// <item> (F2 fix — re-running never appends a duplicate), so nothing to write here either; the
// git dirty-check below still catches an already-written-but-not-yet-committed file from a run
// that crashed between the write and the commit.
if (appcastPlan.action === "insert") {
  writeFileSync(appcastPath, appcastPlan.updatedXml!);
  console.log(`Appcast entry inserted into ${appcastPath}.`);
} else {
  console.log(`Appcast already carries ${version} — skipping insert (resume-safe).`);
}
const appcastDirty = probe(`git status --porcelain -- releases/appcast.xml`).stdout.trim() !== "";
if (appcastDirty) {
  sh(`git add releases/appcast.xml`);
  sh(`git commit -m "chore(releases): appcast entry for v${version}"`);
  sh(`git push`);
} else {
  console.log("  (resume) releases/appcast.xml already committed — nothing to do");
}

// Tag creation moved BEFORE `gh release create` (see comment there) — by this point the tag is
// already on origin; nothing left to do for it here.

console.log(`\nPublished v${version}: https://github.com/${GH_REPO}/releases/tag/v${version}\n`);
