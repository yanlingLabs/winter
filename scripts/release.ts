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
 * --dry-run it writes ONLY a preview at out/release/<v>-dryrun/appcast-preview.xml, mirroring
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
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { FORMAT, ROOT, readCanonical } from "./version-lib";
import {
  GH_REPO,
  NAME_SCAN_EXCLUSIONS,
  appcastInsertPlan,
  appcastItem,
  caskFrom,
  catalogueStaleness,
  dmgStagePlan,
  preflight,
  nameScanPlan,
  publishGuard,
  resolveSigningIdentity,
} from "./release-lib";
import { CODEX_MODELS_VERIFIED } from "../packages/core/src/providers/codex-config";

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

// execSync's default maxBuffer is 1MB, and the Release build blew straight through it once this
// branch added CEF: `xcodebuild` now compiles CEF's ~700-file libcef_dll wrapper on top of
// everything else, and its output measured **4.33MB** — so the pipeline died with
// `spawnSync /bin/sh ENOBUFS` at the BUILD step, before signing anything, on the first dry run
// after the embed landed. Raised well past that rather than to it: a CEF bump, an added target or
// a warning-heavy compiler release all push this number up, and the failure mode is a confusing
// crash in a 10-minute step rather than anything that names the real cause. Applied to `probe`
// too — same class of trap, and `probe` is what runs `codesign -dvv` on a 224MB Mach-O.
const MAX_BUFFER = 64 * 1024 * 1024;

// Throwing shell helper for steps that should abort the whole run on any nonzero exit —
// mirrors scripts/sparkle-feed-gate.ts's `sh` idiom.
const sh = (cmd: string, cwd = ROOT): string =>
  execSync(cmd, { cwd, stdio: "pipe", encoding: "utf8", maxBuffer: MAX_BUFFER });

// Non-throwing probe — used ONLY by preflight checks, which must run to completion and
// aggregate every failure rather than aborting on the first shell error.
function probe(cmd: string, cwd = ROOT): { ok: boolean; stdout: string } {
  try {
    return { ok: true, stdout: execSync(cmd, { cwd, stdio: "pipe", encoding: "utf8", maxBuffer: MAX_BUFFER }) };
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
      // Under --resume-publish an existing tag is the EXPECTED state, not a failure: the
      // publish tail tags+pushes BEFORE `gh release create` (the 0.2.002 fix), so every
      // partially-completed publish a resume exists to finish has already pushed its tag —
      // this check unconditionally aborting made the resume path unreachable by construction
      // (observed live on 0.2.009: upload EOF after the tag push). publishGuard downstream
      // still owns resume semantics, including aborting when the RELEASE is missing.
      if (RESUME_PUBLISH) return null;
      // Check the tag for the version this run will actually RELEASE: preVersion under
      // --no-bump, else the post-bump next patch. Checking v<preVersion> unconditionally made
      // every second bumping release fail — after a successful release the tree legitimately
      // sits at the last-released version, whose tag always exists. (Patch 999 rollover is
      // bump-version's concern; the guard then re-checks conservatively on the raw string.)
      const m = preVersion.match(FORMAT);
      const releasing =
        NO_BUMP || !m ? preVersion : `${m[1]}.${m[2]}.${String(Number(m[3]) + 1).padStart(3, "0")}`;
      const out = probe(`git tag -l v${releasing}`).stdout.trim();
      if (out === "") return null;
      const line = `tag v${releasing} already exists — bump the version or delete the stale tag`;
      // Downgraded to a warning under --dry-run ONLY, exactly like `prodKey` and `gh` above
      // (panel-cef Task 5). `--dry-run --no-bump` is the documented rehearsal command, and on a
      // tree sitting at the last-released version — the normal state between releases — this
      // check aborted it before a single byte was built, making the rehearsal unreachable
      // precisely when it is most wanted (verifying an unreleased change against the real
      // pipeline). Safe because a dry run never tags anything: it exits inside section 12's
      // `if (DRY_RUN)` before the publish tail, and section 12 independently re-checks
      // `tagExists` against the post-bump version for real releases. The non-dry-run path is
      // unchanged and still hard-fails here.
      if (DRY_RUN) {
        console.warn(`WARNING: ${line}\n  (dry-run: downgraded to a warning — a real release still aborts on this)`);
        return null;
      }
      return line;
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
// 3. Build — T1's canonical override invocation, -derivedDataPath <OUT>/dd (OUT is
//    out/release/<v>, or out/release/<v>-dryrun under --dry-run; see below).
// ---------------------------------------------------------------------------
// A dry run builds into `<version>-dryrun`, NEVER `<version>` (panel-cef Task 5 review, Important).
// The next line wipes this directory, and under `--no-bump` `version` is the version this repo has
// already RELEASED — so with both flags, the command CLAUDE.md advertises as "full rehearsal, never
// publishes" would silently replace a shipped release's zip, DMG, cask and appcast preview with
// same-version artifacts built from whatever branch is checked out. Nothing downstream needs the
// canonical path for a rehearsal: a dry run exits at section 12 before publishing anything, and a
// real release rebuilds OUT from scratch regardless.
//
// This path became reachable in this same task: the preflight tag check (section 1) used to abort
// `--dry-run --no-bump` before it could ever get here, and section 1's dry-run downgrade removed
// that accidental protection. A change that makes a destructive path reachable owes the guard.
//
// The condition is `DRY_RUN` alone, deliberately broader than the reviewer's suggested
// `DRY_RUN && !RESUME_PUBLISH`: `publishGuard` resolves dry-run FIRST, so `--dry-run
// --resume-publish` is still a rehearsal that publishes nothing, and it would otherwise be the one
// remaining flag combination that still wipes the released directory. Checked before widening it:
// `RESUME_PUBLISH` is read at exactly three places (its definition, the preflight tag check, and
// `publishGuard`) and gates neither the build nor this `rmSync` — every resume run rebuilds OUT
// itself, so no resume path depends on artifacts surviving here.
const OUT = join(ROOT, "out", "release", DRY_RUN ? `${version}-dryrun` : version);
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

// --- Office (office-plumbing wave) ------------------------------------------
// NormaOfficeHelper is Norma's own compiled binary (like NormaHelper above), embedded at
// Contents/MacOS/ — TeamIdentifier + secure timestamp checked and enrolled in HARDENING_PINS below,
// same as every other component this repo compiles. The vendored LibreOffice product-set (T2) is
// NOT this repo's own build output — 66 dylibs, individually re-signed depth-first at embed time —
// so it is not walked in full here; libmergedlo.dylib (the LOK entry point every Mach-O in that
// tree dlopens through) gets a single team-ID + timestamp probe as a spot check that the embed
// phase's re-signing actually ran, without duplicating that phase's own full-tree verification.
// NOT added to HARDENING_PINS — that array asserts hardened-runtime ENTITLEMENTS, a decision this
// repo makes only about code IT compiles; LibreOffice's own dylibs carry whatever entitlements the
// from-source build gave them.
assertSigned(join(app, "Contents", "MacOS", "NormaOfficeHelper"), "NormaOfficeHelper");
assertSigned(
  join(app, "Contents", "Resources", "LibreOffice", "Frameworks", "libmergedlo.dylib"),
  "LibreOffice (libmergedlo.dylib, team-ID probe only)",
);
// office-editable Task 1's dispatch note, discharged here: the helper's own sandbox profile,
// verified as its own pin — the release blocker's enforcement point. `office-helper.sb` is a bare
// SBPL text file, never a Mach-O (assertSigned's TeamIdentifier/Timestamp probe does not apply to
// it), embedded by project.yml's "Embed NormaOfficeHelper" postCompileScript at
// Contents/Resources/office-helper.sb — a SIBLING of Contents/Resources/LibreOffice, never inside
// NormaOfficeHelper's own bundle (it is a bare `type: tool` product with no Resources directory of
// its own). This is the EXACT path `main.swift`'s `resolveSandboxProfilePath()` reads by default —
// the only resolution production ever takes (no `--sandbox-profile` override outside DEBUG) — and
// the helper is fail-closed on a missing/unreadable profile (that file's own `fail(...)` call at
// boot, verified live by `OfficeSandboxTests.testHelperRefusesToBootWhenSandboxProfileIsMissing`):
// a release that ships without it does not ship a less-safe office feature, it ships NO office
// feature at all, silently, since the helper refuses to serve any document. Three things a release
// must be able to trust here, all asserted:
//   1. PRESENT — existsSync, deliberately NOT folded into assertSigned's own check above: codesign
//      --verify --deep --strict (already run, unconditionally, earlier in this section) validates
//      that everything the signed manifest RECORDS matches its hash — it has no opinion about a
//      file that was simply never embedded in the first place (an absent postCompileScript step
//      leaves no trace in that manifest to fail against), which is exactly the failure mode this
//      existence check exists to catch and that check cannot.
//   2. UNMODIFIED SINCE SIGNING — already covered: the same "codesign --verify --deep --strict" a
//      few lines above this walks the FULL Resources tree (this file included, once present)
//      against the signed manifest's own recorded hashes and would already have failed this script
//      closed had that check found office-helper.sb tampered or corrupted since it was embedded —
//      re-running it here would only repeat an identical, already-passed check at real pipeline
//      cost, not add coverage.
//   3. RESTRICTIVE — M4 (whole-branch review, fix round 2): (1) and (2) both prove things RELATIVE
//      TO WHAT WAS SIGNED — neither has any opinion on whether the embedded copy equals the
//      repository source at apple/Norma/Sources/OfficeHelper/office-helper.sb. A stale project.yml
//      build-phase reference (e.g. a cached copy, or a bad merge that left a weaker profile on disk
//      pre-embed) would copy happily, sign happily, and pass both checks above while shipping a
//      materially weaker sandbox. Read the embedded file's own content directly, below, and fail on
//      the two load-bearing containment lines. `OfficeSandboxTests.
//      testDenyDefaultAndDenyNetworkArePresentInTheSourceProfile` already pins these two clauses
//      against the SOURCE file; this is the missing embedded-side half of that same pin — turning
//      "a file exists here" into "a restrictive profile ships here."
const officeSandboxProfile = join(app, "Contents", "Resources", "office-helper.sb");
if (!existsSync(officeSandboxProfile)) {
  fail(
    `office-helper.sb not found at ${officeSandboxProfile} — the office helper's own sandbox profile ` +
      `was not embedded into this build. resolveSandboxProfilePath() resolves exactly this path by ` +
      `default in production (no --sandbox-profile override outside DEBUG); NormaOfficeHelper refuses ` +
      `to boot without it (fail-closed, main.swift). A release built this way does not ship a weaker ` +
      `office feature — it ships NO office feature: every open silently fails. Check project.yml's ` +
      `"Embed NormaOfficeHelper" postCompileScript actually ran for this configuration.`,
  );
}
const officeSandboxProfileContent = readFileSync(officeSandboxProfile, "utf8");
for (const requiredClause of ["(deny default)", "(deny network*)"]) {
  if (!officeSandboxProfileContent.includes(requiredClause)) {
    fail(
      `office-helper.sb at ${officeSandboxProfile} is missing the required clause ` +
        `${JSON.stringify(requiredClause)} — the EMBEDDED copy's content does not match what this ` +
        `repository ships. codesign --verify --deep --strict (already run above) only proves this ` +
        `file is unmodified SINCE SIGNING; it has no opinion on whether the embedded copy equals the ` +
        `repo source, so a stale build-phase reference to an old/weaker profile would sign and verify ` +
        `successfully while shipping a containment regression. Check project.yml's "Embed ` +
        `NormaOfficeHelper" postCompileScript is copying from ` +
        `apple/Norma/Sources/OfficeHelper/office-helper.sb, not a stale cached copy.`,
    );
  }
}
console.log(`office-helper.sb present at ${officeSandboxProfile}, unmodified since signing ` +
  `(codesign --verify --deep --strict above), and its embedded content still carries ` +
  `(deny default) and (deny network*).`);

// --- CEF (panel-cef Task 5) -------------------------------------------------
// The framework, its five dlopen'd dylibs, and the five helper bundles. `--deep --strict` above
// already proves the seals nest correctly; this roster proves the two things it does NOT check
// and that notarization rejects outright — a Developer ID TEAM identity and a secure timestamp
// on every one of them. Both matter beyond notarization here: the Team ID is exactly what lets
// the hardened runtime's library validation permit the app and the helpers to dlopen this
// framework at all (see project.yml's "Embed CEF framework"), and libcef_sandbox.dylib is
// dlopen'd separately by every helper's CefScopedSandboxContext, so it needs its own identity
// rather than inheriting the framework's seal.
//
// `existsSync`-tolerant loops are deliberately NOT used here, unlike the Sparkle nested helpers
// above (whose set legitimately varies by Sparkle version): every path below is produced by this
// repo's own build, so a missing one is a broken build, and assertSigned fails closed on it.
const cefFramework = join(app, "Contents", "Frameworks", "Chromium Embedded Framework.framework");
assertSigned(cefFramework, "Chromium Embedded Framework.framework");
for (const lib of ["libEGL.dylib", "libGLESv2.dylib", "libcef_sandbox.dylib", "libvk_swiftshader.dylib", "libvulkan.dylib"]) {
  assertSigned(join(cefFramework, "Libraries", lib), `CEF framework library (${lib})`);
}
const CEF_HELPERS = [
  "Norma Helper",
  "Norma Helper (Alerts)",
  "Norma Helper (GPU)",
  "Norma Helper (Plugin)",
  "Norma Helper (Renderer)",
];
for (const name of CEF_HELPERS) {
  assertSigned(join(app, "Contents", "Frameworks", `${name}.app`), `CEF helper (${name})`);
}
// "Start from nothing" pinned where it SHIPS, across every component this repo signs — not just
// where entitlements are declared. project.yml can hand CODE_SIGN_ENTITLEMENTS to the wrong
// target, or to four of five, without anything failing to build.
//
// The rule is scoped to the HARDENED-RUNTIME family (`com.apple.security.cs.*`), which is the set
// that actually trades away protection, and it is asserted in BOTH directions: exactly
// `allow-jit` on the Renderer, and exactly nothing on everything else. "Applied too widely" is
// checked as carefully as "missing", because that is the direction that silently weakens
// hardening — and `com.apple.security.cs.disable-library-validation` is the specific creep this
// exists to stop. Norma.app is in the list deliberately (Task 5 review, Minor): it `dlopen`s the
// same CEF framework via `LoadInMain` from Task 6 onward, so it is the most plausible place for
// that entitlement to be added "just to make it work" — Task 5 measured that it does not need it.
//
// Non-`cs.*` keys are tolerated: Xcode injects `com.apple.application-identifier` into NormaHelper
// (measured: `37N77U9RSZ.com.norma.helper`), which is identity bookkeeping, not a hardening
// relaxation. Sparkle's own nested helpers are deliberately OUT of scope — they are third-party
// and `resignPreservingEntitlements` preserves whatever they ship with, by design.
const JIT = "com.apple.security.cs.allow-jit";
/// The helpers that legitimately carry `allow-jit` — the two Chromium runs a JIT in. Kept in
/// lockstep with `apple/Norma/project.yml`'s `CEFHelperRenderer`/`CEFHelperGPU` blocks, both of
/// which point at the SAME `Support/CEFHelperJit.entitlements` for the same anti-drift reason.
const CEF_JIT_HELPERS = ["Norma Helper (Renderer)", "Norma Helper (GPU)"];
const HARDENING_PINS: { path: string; label: string; expect: string[] }[] = [
  { path: app, label: "Norma.app", expect: [] },
  { path: join(app, "Contents", "MacOS", "NormaHelper"), label: "NormaHelper", expect: [] },
  { path: join(app, "Contents", "Resources", "norma-core"), label: "norma-core", expect: [] },
  // office-plumbing wave — Norma's own compiled binary, same posture as NormaHelper/norma-core
  // above (no hardened-runtime relaxation of any kind). The vendored LibreOffice product-set is
  // deliberately NOT enrolled here — see the team-ID-only probe on libmergedlo.dylib above this
  // array, and that probe's own comment for why.
  { path: join(app, "Contents", "MacOS", "NormaOfficeHelper"), label: "NormaOfficeHelper", expect: [] },
  // panel-cef Task 6a: the GPU helper joined the Renderer. Chromium routes the GPU process to the
  // `(GPU)` bundle only when it needs the JIT-capable variant — SwiftShader — which a Mac with a
  // working Metal path never reaches, so this was invisible until Task 6a forced the software path
  // with `--use-angle=swiftshader`. Under the hardened runtime and without `allow-jit` it
  // crash-looped, `exit_code=9`, with the crash report reading
  // `"termination": {"namespace":"CODESIGNING","indicator":"Invalid Page"}`. Chrome 151 ships
  // `allow-jit` on both of these helpers and on neither of the other three; so does Norma.
  ...CEF_HELPERS.map((name) => ({
    path: join(app, "Contents", "Frameworks", `${name}.app`),
    label: `CEF helper (${name})`,
    expect: CEF_JIT_HELPERS.includes(name) ? [JIT] : [],
  })),
];
for (const pin of HARDENING_PINS) {
  const ents = probe(`codesign -d --entitlements - --xml "${pin.path}" 2>/dev/null`).stdout;
  const found = [...ents.matchAll(/<key>(com\.apple\.security\.cs\.[^<]+)<\/key>/g)].map((m) => m[1]!).sort();
  const want = [...pin.expect].sort();
  if (found.join(",") !== want.join(",")) {
    fail(
      `${pin.label}: hardened-runtime entitlements are not what this branch decided.\n` +
        `  expected: ${want.length ? want.join(", ") : "(none)"}\n` +
        `  found:    ${found.length ? found.join(", ") : "(none)"}\n` +
        `  Every com.apple.security.cs.* entitlement is a deliberate, evidence-backed decision here —\n` +
        `  see apple/Norma/project.yml's CEFHelperRenderer / CEFHelperGPU blocks. Do not "fix" this by\n` +
        `  editing the expectation; justify the entitlement or remove it.`,
    );
  }
}
console.log(
  "Signatures verified: codesign --verify --deep --strict PASS; TeamIdentifier + secure timestamp confirmed on " +
    "app + norma-core + NormaHelper + NormaOfficeHelper + Sparkle.framework + its nested helpers + CEF framework + " +
    "its 5 libraries + the 5 CEF helpers + the vendored LibreOffice's libmergedlo.dylib (identity probe only — " +
    `not part of the entitlements roster below); hardened-runtime entitlements pinned across all ${HARDENING_PINS.length} ` +
    `components this ` +
    // Both halves derived from HARDENING_PINS rather than typed, so this sentence cannot go stale
    // the way its predecessor did when the pin widened (Task 5 caught that one; Task 6a widened it
    // again by giving the GPU helper allow-jit).
    `repo signs — exactly ${JIT} on ${HARDENING_PINS.filter((p) => p.expect.length).length} of them ` +
    `(${HARDENING_PINS.filter((p) => p.expect.length).map((p) => p.label).join(", ")}), exactly none on ` +
    `the other ${HARDENING_PINS.filter((p) => !p.expect.length).length}.`,
);

// ---------------------------------------------------------------------------
// 4b. Licence notices (panel-cef Task 5). CEF and Chromium are BSD-3-Clause, whose second
//     condition requires a BINARY redistribution to reproduce the copyright notice and
//     disclaimer "in the documentation and/or other materials provided with the distribution".
//     Norma is Apache-2.0 and stays cleanly so by shipping theirs inside the app bundle.
//
//     This gate exists because the alternative is trusting that a postCompileScript ran. That
//     script is `basedOnDependencyAnalysis: false` and its copy is easy to break silently — a
//     renamed vendored file, a reordered phase, a `mkdir -p` racing a clean — and the failure is
//     invisible: the app builds, launches, notarizes, and ships out of compliance. So the check
//     is on the BUILT ARTIFACT, and it is a hard fail, not a warning.
//
//     Content sanity, not bare existence: a zero-byte or truncated file satisfies existsSync and
//     satisfies nothing else. CREDITS.html is ~19.6MB and the floor is set well below that (a
//     partial ditto is the realistic failure, not a shrunken upstream); the licence text is
//     checked for the BSD clause it exists to reproduce.
// ---------------------------------------------------------------------------
console.log("Gate: licence notices present in the built app...");
const licensesDir = join(app, "Contents", "Resources", "Licenses");
const NOTICES: { file: string; label: string; minBytes: number; mustContain: string }[] = [
  {
    file: "CEF-LICENSE.txt",
    label: "CEF BSD-3-Clause notice",
    minBytes: 1000,
    mustContain: "Redistributions in binary form must reproduce",
  },
  {
    file: "CREDITS.html",
    label: "Chromium third-party attributions",
    minBytes: 5_000_000,
    mustContain: "<html",
  },
];
// office-plumbing wave (whole-branch N4) — same reasoning as the CEF pair above: LibreOfficeKit
// ships MPL-2.0 core plus a mix of LGPL/MPL-1.1-licensed externals, whose notices this file
// reproduces. Lives at Contents/Resources/LibreOffice/Resources/, NOT Contents/Resources/Licenses/
// like the CEF pair — that is where project.yml's "Embed LibreOffice (signed)" phase places the
// WHOLE vendored product-set (Frameworks/ + Resources/ as siblings, keeping LOK's own relative
// path assumptions intact — see that phase's own comment); this gate gained a second `licensesDir`
// -relative root rather than moving the file, to avoid disturbing that placement. minBytes measured
// against the real vendored file (378,658 bytes as of the 20260819 asset) with generous headroom
// for a truncated-copy floor, well below the real size.
const officeLicenseDir = join(app, "Contents", "Resources", "LibreOffice", "Resources");
const OFFICE_NOTICES: { file: string; label: string; minBytes: number; mustContain: string; dir: string }[] = [
  {
    file: "LICENSE.html",
    label: "LibreOfficeKit licensing and legal information",
    minBytes: 100_000,
    mustContain: "Mozilla Public License, v. 2.0",
    dir: officeLicenseDir,
  },
];
for (const n of OFFICE_NOTICES) {
  const p = join(n.dir, n.file);
  if (!existsSync(p)) {
    fail(
      `${n.label} missing from the built app at ${p}\n` +
        `  This is an MPL-2.0/LGPL redistribution obligation, not an optional resource.\n` +
        `  Check apple/Norma/project.yml's "Embed LibreOffice (signed)" phase.`,
    );
  }
  const bytes = statSync(p).size;
  if (bytes < n.minBytes) fail(`${n.label} at ${p} is ${bytes} bytes — expected at least ${n.minBytes} (truncated copy?)`);
  const fd = openSync(p, "r");
  const buf = Buffer.alloc(65536);
  const read = readSync(fd, buf, 0, buf.length, 0);
  closeSync(fd);
  const head = buf.subarray(0, read).toString("utf8");
  if (!head.includes(n.mustContain)) fail(`${n.label} at ${p} does not contain ${JSON.stringify(n.mustContain)} — wrong file?`);
  console.log(`  ${n.file}: ${bytes} bytes, content check OK`);
}
for (const n of NOTICES) {
  const p = join(licensesDir, n.file);
  if (!existsSync(p)) {
    fail(
      `${n.label} missing from the built app at ${p}\n` +
        `  This is a BSD-3-Clause redistribution obligation, not an optional resource.\n` +
        `  Check apple/Norma/project.yml's "Embed CEF + Chromium licence notices" phase.`,
    );
  }
  const bytes = statSync(p).size;
  if (bytes < n.minBytes) fail(`${n.label} at ${p} is ${bytes} bytes — expected at least ${n.minBytes} (truncated copy?)`);
  // Read only the head, for real: CREDITS.html is ~19.6MB and nothing here needs the whole file.
  // (`readFileSync(p).subarray(0, N)` would read all 19.6MB and then throw most of it away — the
  // comment described code that had not been written. Task 5 review, Minor.)
  const fd = openSync(p, "r");
  const buf = Buffer.alloc(65536);
  const read = readSync(fd, buf, 0, buf.length, 0);
  closeSync(fd);
  const head = buf.subarray(0, read).toString("utf8");
  if (!head.includes(n.mustContain)) fail(`${n.label} at ${p} does not contain ${JSON.stringify(n.mustContain)} — wrong file?`);
  console.log(`  ${n.file}: ${bytes} bytes, content check OK`);
}
console.log("Licence notices verified in Contents/Resources/Licenses.");

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
    const raw = execSync(cmd, { cwd: ROOT, stdio: "pipe", encoding: "utf8", maxBuffer: MAX_BUFFER });
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
// 11b. Identity gate on the BUILT ARTIFACTS. Git hooks cannot see these — a .app
//      and a rendered cask never enter the repo — and the leaks that actually
//      happened (absolute build paths in Mach-O debug stabs, 0.2.001) lived
//      exactly here. Runs in dry-run too: a rehearsal that skipped the gate would
//      defeat the purpose.
//
//      The patterns deliberately live OUTSIDE this repo, in the local-only guard
//      (~/norma-private/git-hooks/name-guard.sh) — putting them in a tracked file
//      would publish the very strings this gate exists to keep out. Consequence:
//      the gate FAILS CLOSED when the guard is absent. That is intended; a machine
//      without the guard must not cut a release.
// ---------------------------------------------------------------------------
const nameGuard = join(process.env.HOME ?? "", "norma-private/git-hooks/name-guard.sh");
if (!existsSync(nameGuard)) {
  fail(
    `identity gate unavailable: ${nameGuard} not found.\n` +
      `  This machine cannot cut a release without the local-only name guard.\n` +
      `  (It is intentionally not in this repo — see the comment above this check.)`,
  );
}
// panel-cef Task 5 — the app is no longer a ~90MB tree of things this repo compiled; it now
// contains 317MB of prebuilt Chromium, including its translations into ~220 languages. The guard
// reads every byte as text and fails closed on any hit, and Chromium's translations contain a
// natural-language collision with one guarded substring (measured: exactly one file, a Swahili
// UI label in sw.lproj/locale.pak).
//
// The exclusion is expressed HERE, in the repo, rather than in the guard — the guard is
// deliberately local-only and outside every repository, so an exclusion added there would be
// invisible to review and would differ per machine. Instead the guard is handed a target list
// that simply omits the excluded paths; it is unchanged and unaware. What is and is not excluded
// (and why it is this narrow) is documented on NAME_SCAN_EXCLUSIONS in release-lib.ts.
//
// The walk that builds that list is the new risk: a bug in it under-scans the release silently,
// and this repo has already shipped one gate that false-passed on a partial tree. So the
// partition is ASSERTED against the filesystem before the guard runs — every regular file under
// the app must be under exactly one of (emitted targets, excluded paths). `find -type f` matches
// the guard's own traversal exactly, so the counts are comparable by construction.
// lstat + symlink-filtered listing, NOT stat + plain readdir: `find -type f` neither counts
// symlinks nor traverses them, and the embedded CEF framework is a versioned bundle whose root
// is three symlinks into Versions/Current. Following them would walk the same locale packs by a
// second path — one that the exclusion regex (anchored on the Versions segment) does not match —
// and would emit targets the partition assertion below then cannot reconcile.
const scan = nameScanPlan({
  root: app,
  listDir: (p) => readdirSync(p, { withFileTypes: true }).filter((e) => !e.isSymbolicLink()).map((e) => e.name),
  isDir: (p) => lstatSync(p).isDirectory(),
  isExcluded: (rel) => NAME_SCAN_EXCLUSIONS.some((re) => re.test(rel)),
});
const countFiles = (paths: string[]): number =>
  paths.reduce((n, p) => n + Number(sh(`find "${p}" -type f | wc -l`).trim()), 0);
const totalFiles = countFiles([app]);
const scannedFiles = countFiles(scan.targets);
const skippedFiles = scan.excluded.length === 0 ? 0 : countFiles(scan.excluded);
if (scannedFiles + skippedFiles !== totalFiles) {
  fail(
    `identity scan partition is wrong — refusing to run a gate that may not cover the artifact.\n` +
      `  files under the app:        ${totalFiles}\n` +
      `  files under scan targets:   ${scannedFiles}\n` +
      `  files under exclusions:     ${skippedFiles}\n` +
      `  (targets + exclusions must equal the whole bundle; see nameScanPlan in release-lib.ts)`,
  );
}
// Reported per RULE, not per path: the shipped exclusion legitimately matches 220 locale
// directories, and 220 log lines would bury the one number a human should actually check —
// whether a rule started matching more than it was written for.
console.log(
  `Gate: identity scan of built artifacts — ${scannedFiles}/${totalFiles} files scanned across ` +
    `${scan.targets.length} paths, ${skippedFiles} deliberately excluded:`,
);
for (const re of NAME_SCAN_EXCLUSIONS) {
  const hits = scan.excluded.filter((e) => re.test(e.slice(app.length + 1)));
  console.log(`  rule ${re.source} -> ${hits.length} path(s) not scanned`);
  for (const h of hits.slice(0, 3)) console.log(`    e.g. ${h.slice(app.length + 1)}`);
}
sh([`"${nameGuard}" artifacts`, ...scan.targets.map((t) => `"${t}"`), `"${caskOutPath}"`].join(" "));

// ---------------------------------------------------------------------------
// 11c. Provider-catalogue staleness nudge — WARN ONLY, never a gate (T2 review M2).
//      CODEX_MODELS' context windows are hand-held constants re-derived from a live
//      /models call; a stale window does not throw, it silently moves the
//      auto-compaction threshold (a 372_000 transcription for a 272,000 window once
//      put it ABOVE the provider's hard ceiling and killed auto-compaction outright).
//      This is the moment that number SHIPS and a human is watching output, which is
//      why the nudge lives here rather than as a console.warn inside a 3,000-test run.
//      Deliberately not fail-closed like 11b: a date-triggered failure would redden a
//      green pipeline on a day nobody touched code, and the reflexive repair is to bump
//      the date without checking anything.
// ---------------------------------------------------------------------------
const catalogue = catalogueStaleness({ verified: CODEX_MODELS_VERIFIED, now: new Date() });
if (catalogue.line) console.warn(`\n${catalogue.line}\n`);
else console.log(`Catalogue: CODEX_MODELS verified ${CODEX_MODELS_VERIFIED} (${catalogue.ageDays}d ago) — within budget`);

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
