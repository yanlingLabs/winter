/**
 * Vendors the PROVEN headless LibreOffice macOS arm64 product-set into
 * apple/Norma/vendor/libreoffice/ (gitignored -- ~488MB unpacked, ~154MiB compressed) the way
 * scripts/fetch-cef.ts and scripts/fetch-monaco.ts vendor their own dependencies: pinned,
 * hash-verified, extracted, stamped for idempotency.
 *
 * =====================================================================================
 * GO. This is a from-scratch rewrite of an earlier version of this script that vendored the
 * OFFICIAL LibreOffice mac dmg and was a confirmed NO-GO (see git history for that investigation
 * if it is ever needed again): the official dmg ships the desktop Aqua VCL backend only, and
 * LibreOfficeKit's lok_init_2() crashes on it -- AppKit's "NSWindow only on the main thread"
 * rule, hit from LOK's own internally-spawned worker thread. That was a fact about ONE PACKAGING
 * of LibreOffice, not about the source tree: a from-scratch native build with --enable-headless
 * (the svp/headless VCL backend, the same shape iOS's own LibreOffice port uses) builds and runs
 * cleanly on macOS arm64 from stock upstream `LibreOffice/core` master, with ZERO source
 * patches. See the release notes at
 * https://github.com/yanlingLabs/norma/releases/tag/vendor-libreoffice-20260819 for the full
 * probe, the six-fixture pixel-hash proof, and the licensing inventory this script's LICENSES/
 * bundle is sourced from. scripts/build-libreoffice.ts documents the from-source recipe that
 * produced the artifact this script fetches (informational -- not run in CI).
 * =====================================================================================
 *
 * Usage: bun run scripts/fetch-libreoffice.ts          (or: bun run libreoffice:fetch)
 *        bun run scripts/fetch-libreoffice.ts --force   (re-fetch even if the stamp matches)
 *
 * --- Source: a GitHub release asset in THIS repo, not upstream ---
 * Unlike fetch-cef.ts (upstream CEF builds) and fetch-monaco.ts (the npm registry), there is no
 * upstream distributor of a headless macOS LibreOffice build -- TDF's own dmg doesn't ship one
 * (see the GO header above). The artifact this script fetches was built and packaged by hand
 * (per scripts/build-libreoffice.ts's documented recipe) and uploaded as a release asset on a
 * dedicated, non-app `vendor-libreoffice-20260819` GitHub release in this repo (yanlingLabs/norma)
 * -- deliberately NOT part of the v#.#.### app-release lineage scripts/release.ts manages, and
 * created with --latest=false so it never displaces an app release as the repo's "Latest".
 *
 * --- Verification: single pin, not belt-and-braces ---
 * Unlike fetch-cef.ts (index.json) or the old dmg-fetching version of this script (a live
 * .sha256 sidecar), there is no independent live manifest to cross-check the pin against before
 * downloading -- same shape as fetch-monaco.ts's npm integrity pin. IMPORTANT DIFFERENCE from
 * that comparison, though: an npm tarball URL is immutable by the registry's own guarantee (a
 * republish mints a new version, never new bytes at the same URL) -- a GitHub release asset is
 * NOT: a maintainer can delete and re-upload an asset under the same name at the same URL. So
 * PINNED_SHA256 below is not "redundant with an immutable source," it is the ENTIRE trust root.
 * A mismatch means investigate before touching the pin -- never chase the error by copying in
 * whatever the new value is.
 *
 * --- Artifact shape: product-set/ + LICENSES/ + VERSION-PIN, exactly three top-level entries ---
 * The tarball unpacks to exactly those three things, placed directly under VENDOR_DIR:
 *   apple/Norma/vendor/libreoffice/product-set/{Frameworks,Resources}/   -- the LOK installPath
 *     is product-set/Frameworks/ (the directory CONTAINING libmergedlo.dylib) -- Resources/ must
 *     stay Frameworks/'s literal sibling on disk, with NO symlinks anywhere in that ancestry:
 *     dyld resolves a dlopen'd library through directory symlinks to its REAL path before LOK's
 *     ${ORIGIN}-relative bootstrap (fundamentalrc's BRAND_BASE_DIR=${ORIGIN}/.. chain) ever
 *     runs, so a symlinked installPath silently loads the WRONG Resources/ instead of failing
 *     loudly (bit the productization gate twice -- see the release notes linked above). ditto (below)
 *     preserves real-directory placement the same way fetch-cef.ts's framework copies do.
 *   apple/Norma/vendor/libreoffice/LICENSES/            -- per-project license texts + MANIFEST.md
 *   apple/Norma/vendor/libreoffice/VERSION-PIN            -- commit/flags/recipe-hash/engine facts
 *
 * --- Idempotency ---
 * Same shape as fetch-cef.ts / fetch-monaco.ts: a stamp file records the exact (tag, assetName,
 * sha256) a previous run verified; a second run whose stamp matches, with the expected marker
 * paths still on disk, does no network I/O. --force skips this and re-fetches unconditionally.
 * A real run always starts by wiping VENDOR_DIR, so a stale pre-rewrite tree (the old dmg-harvest
 * shape: program/, LICENSE-MPL.txt, the old NO-GO VERSION-PIN) cannot linger alongside the new one.
 *
 * --- Build-gate message ---
 * This vendor tree IS wired into an Xcode preBuildScripts gate, same as vendor/cef and
 * vendor/monaco: project.yml's "Check LibreOffice vendored" phase (added office-plumbing Task 2)
 * fails the build loudly, naming this exact command, if product-set/{Frameworks,Resources},
 * libmergedlo.dylib, or .vendored-version is missing. This script's own success/failure output
 * is written to match fetch-monaco.ts's tone regardless, so a direct run and a build failure
 * that shells out to it read the same way.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAssetUrl, isValidSha256Hex, parseStampJson, stampSatisfies, type Stamp } from "./fetch-libreoffice-lib";
import { ROOT } from "./version-lib";

// ---------------------------------------------------------------------------
// Pinned artifact. Do not float to "latest" -- see header comment.
// ---------------------------------------------------------------------------
// RE-CUT (2026-08-19): the original vendor-libreoffice-20260818 release was DELETED after a
// privacy leak was found by measurement in its product-set (builder account name plaintext in
// 8/66 dylibs' compiled-in build paths, plus Resources/versionrc and Resources/registry/main.xcd's
// vendor fields) -- see that replacement release's own page for the scrub applied and the
// zero-hit re-scan proof. The -r2 asset was a straight re-cut from the same pinned commit/flags,
// nothing else about the engine changed (six-fixture pixel hashes are identical to the original).
//
// RE-CUT (2026-08-22, Office Stage B Task 11): -r3 adds ONE dylib on top of -r2's own product-set
// (from the same instdir, no rebuild) -- `libsal_textenclo.dylib`, absent from -r2's 66-dylib
// closure because it is reached only via a runtime `dlopen` on the xlsx export path (never a
// link-time dependency the closure recipe's trace+otool safety net could see). Fixes the crash on
// `saveAs` to `.xlsx` (SIGABRT in sal's text-encoding subsystem, `abort()`-ing when the lazy
// dlopen fails); see .superpowers/sdd/2026-08-20-office-editable/ooxml-export-investigation.md
// and this release's own VERSION-PIN R3 ADDENDUM for the full mechanism, the empirical proof, and
// the honest per-format result (`.pptx` already worked and is unaffected; `.docx` still does not
// save, but via a different, non-crashing engine defect unrelated to this fix). -r3 also fixes a
// privacy gap -r2 did NOT have: -r2's tarball container itself (not its file contents) recorded
// the packaging account's username/group in every entry's tar header (bsdtar's default owner
// recording) -- confirmed by measurement against the live, cold-downloaded -r2 asset. -r3's tar is
// built with explicit owner/group suppression and re-scanned uncompressed before upload. The live
// -r2 asset was left published, unmodified (a GitHub release asset is maintainer-replaceable at
// the same URL -- re-publishing scrubbed bytes under the same name is exactly the silent-swap
// hazard the ASSET_URL comment below warns about); flagged on both release pages as an open item.
const GH_REPO = "yanlingLabs/norma";
const RELEASE_TAG = "vendor-libreoffice-20260822";
const ASSET_NAME = "libreoffice-headless-macos-arm64-11482c8f-r3.tar.zst";
const ASSET_URL = buildAssetUrl({ repo: GH_REPO, tag: RELEASE_TAG, assetName: ASSET_NAME });
// Hand-pinned at package time from an independent `shasum -a 256` of the actual uploaded file,
// then re-verified against a fresh public download before being transcribed here (see the
// release notes at https://github.com/yanlingLabs/norma/releases/tag/vendor-libreoffice-20260822
// for that verification run). See header comment for why this single pin (not a belt-and-braces
// live check) is nonetheless load-bearing here.
const PINNED_SHA256 = "02e73e7e3caab598d0e47cb40ce835920e9ebc78eff5a01aafd4cf3bccd13945";
if (!isValidSha256Hex(PINNED_SHA256)) {
  throw new Error(`PINNED_SHA256 is not a well-formed 64-char lowercase hex string: ${PINNED_SHA256}`);
}
// The LibreOffice/core commit the product-set was built from -- informational here (this script
// does not clone source), recorded so a future re-package/re-pin has the exact commit to hand.
// Full provenance (configure flags, closure recipe) travels inside the artifact as VERSION-PIN.
const LIBREOFFICE_CORE_COMMIT = "11482c8f71bc76ed6260bc03b1576a52a788ab4f";

const VENDOR_DIR = join(ROOT, "apple", "Norma", "vendor", "libreoffice");
const PRODUCT_SET_DIR = join(VENDOR_DIR, "product-set");
const LICENSES_DIR = join(VENDOR_DIR, "LICENSES");
const VERSION_PIN_PATH = join(VENDOR_DIR, "VERSION-PIN");
const STAMP_PATH = join(VENDOR_DIR, ".vendored-version");
// The single file lok_init_2()/dlopen actually need present to succeed, plus the two metadata
// markers -- a marker-only check on just the dylib would false-pass a tree a prior run left
// partial (copied product-set/, died before LICENSES/), same reasoning as fetch-monaco.ts's
// vendoredPathsPresent() checking both the loader AND the licence file.
const MERGED_LIB_REL = join("product-set", "Frameworks", "libmergedlo.dylib");
const FUNDAMENTALRC_REL = join("product-set", "Resources", "fundamentalrc");
const LICENSES_MANIFEST_REL = join("LICENSES", "MANIFEST.md");

const FORCE = process.argv.includes("--force");

function fail(msg: string): never {
  console.error(`\nFAIL: ${msg}\n`);
  process.exit(1);
}

function vendoredPathsPresent(): boolean {
  return (
    existsSync(join(VENDOR_DIR, MERGED_LIB_REL)) &&
    existsSync(join(VENDOR_DIR, FUNDAMENTALRC_REL)) &&
    existsSync(join(VENDOR_DIR, LICENSES_MANIFEST_REL)) &&
    existsSync(VERSION_PIN_PATH)
  );
}

/** Network-free, fast. */
function alreadyVendored(): Stamp | null {
  if (!existsSync(STAMP_PATH)) return null;
  const stamp = parseStampJson(readFileSync(STAMP_PATH, "utf8"));
  if (!stampSatisfies(stamp, { tag: RELEASE_TAG, assetName: ASSET_NAME, sha256: PINNED_SHA256 })) return null;
  if (!vendoredPathsPresent()) return null;
  return stamp;
}

// ---------------------------------------------------------------------------
// Idempotency gate.
// ---------------------------------------------------------------------------
if (FORCE) {
  console.log("--force: skipping idempotency check, re-fetching unconditionally...");
} else {
  const existing = alreadyVendored();
  if (existing) {
    console.log(
      `LibreOffice product-set (${RELEASE_TAG}) already vendored and verified at ${VENDOR_DIR}\n` +
        `  sha256:  ${existing.sha256}\n` +
        `  fetched: ${existing.fetchedAt}\n` +
        `Nothing to do. (--force to re-fetch anyway.)`,
    );
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// zstd preflight -- fail loudly and specifically rather than let `tar` fail confusingly later.
// This IS this script's fetch-monaco-style build-gate message: named command, no guessing.
// ---------------------------------------------------------------------------
let zstdPath: string;
try {
  zstdPath = execFileSync("which", ["zstd"], { encoding: "utf8" }).trim();
  if (!zstdPath) throw new Error("empty");
} catch {
  fail(
    `zstd is required to unpack ${ASSET_NAME} and was not found on PATH.\n` +
      `  Install it, then re-run this command:\n` +
      `    brew install zstd\n` +
      `    bun run scripts/fetch-libreoffice.ts`,
  );
}

// ---------------------------------------------------------------------------
// Download, verify, extract, place. Everything transient lives under one temp dir that is
// always removed on the way out, success or failure (mirrors fetch-cef.ts / fetch-monaco.ts).
// ---------------------------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "norma-libreoffice-"));
// fail() calls process.exit(), which does NOT unwind the stack -- the `finally` below never
// runs on that path (same trap fetch-cef.ts/fetch-monaco.ts document). Every fail() called from
// inside this try must go through here first, or a failure leaks a temp dir with a partial
// download/extract.
const failTmp = (msg: string): never => {
  rmSync(tmp, { recursive: true, force: true });
  fail(msg);
};
function execOrFail(context: string, cmd: string, args: string[], inheritStdio = false): void {
  try {
    execFileSync(cmd, args, inheritStdio ? { stdio: "inherit" } : undefined);
  } catch (e) {
    failTmp(`${context}\n  command: ${cmd} ${args.map((a) => `"${a}"`).join(" ")}\n  ${e}`);
  }
}

try {
  const archivePath = join(tmp, ASSET_NAME);
  console.log(`Downloading ${ASSET_URL}\n  -> ${archivePath}`);
  // stdio: inherit -- this is a ~154MiB download; let curl's own progress meter and any error
  // output reach the terminal directly rather than buffering it (mirrors fetch-cef.ts).
  execOrFail(
    "download failed -- check your network connection and try again",
    "curl",
    ["-fL", "-o", archivePath, ASSET_URL],
    true,
  );

  console.log("Verifying sha256 against the pinned value (the trust root -- see header comment)...");
  const actualSha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  if (actualSha256 !== PINNED_SHA256) {
    failTmp(
      `sha256 mismatch for ${ASSET_NAME}\n` +
        `  expected (pinned):   ${PINNED_SHA256}\n` +
        `  actual (downloaded): ${actualSha256}\n` +
        `Refusing to extract a corrupted, tampered, or silently-replaced download. GitHub release\n` +
        `assets ARE maintainer-replaceable (unlike an npm tarball URL) -- investigate before\n` +
        `updating PINNED_SHA256 to match, don't chase this error by blindly copying the new value in.`,
    );
  }
  console.log(`sha256 OK: ${actualSha256}`);

  console.log("Extracting (zstd -d, then tar -x)...");
  const extractDir = join(tmp, "extract");
  mkdirSync(extractDir, { recursive: true });
  // Two separate steps, not `tar --use-compress-program zstd -xf` piped directly: confirmed
  // empirically (2026-08-18) that macOS's bundled bsdtar (libarchive) mishandles that pipe --
  // zstd exits with "error 70: Write error: cannot write block: Broken pipe" partway through,
  // even though the exact same archive decompresses and extracts cleanly via these two plain
  // steps. Not investigated further (GNU tar's --use-compress-program works fine with zstd;
  // this is specifically a bsdtar quirk) -- the two-step form is simple, robust, and costs one
  // extra ~488MB temp file, which the surrounding tmp-dir cleanup already handles.
  const tarPath = join(tmp, `${ASSET_NAME.replace(/\.zst$/, "")}`);
  execOrFail(
    "decompression failed -- the archive already passed sha256 verification, so this is more likely disk space or a broken zstd than corruption",
    zstdPath,
    ["-d", "-f", "-o", tarPath, archivePath],
  );
  execOrFail("tar extraction failed after successful decompression -- check disk space and permissions", "tar", [
    "-xf",
    tarPath,
    "-C",
    extractDir,
  ]);

  // Exactly three top-level entries expected -- asserted rather than assumed, mirroring
  // fetch-monaco.ts's defensive check against an unexpected archive layout.
  const topLevel = readdirSync(extractDir).sort();
  const expectedTopLevel = ["LICENSES", "VERSION-PIN", "product-set"];
  if (topLevel.join(",") !== expectedTopLevel.join(",")) {
    failTmp(
      `expected exactly these top-level entries in the archive: ${expectedTopLevel.join(", ")}\n` +
        `  found: ${topLevel.join(", ") || "(none)"}`,
    );
  }

  for (const [label, rel] of [
    ["product-set/Frameworks/libmergedlo.dylib", MERGED_LIB_REL],
    ["product-set/Resources/fundamentalrc", FUNDAMENTALRC_REL],
    ["LICENSES/MANIFEST.md", LICENSES_MANIFEST_REL],
  ] as const) {
    if (!existsSync(join(extractDir, rel))) {
      failTmp(`extracted archive is missing ${label} -- the artifact's internal layout may have changed.`);
    }
  }
  if (!existsSync(join(extractDir, "VERSION-PIN"))) {
    failTmp("extracted archive is missing VERSION-PIN.");
  }

  console.log(`Placing vendored tree at ${VENDOR_DIR}...`);
  // Wipe first -- this is what makes a re-run converge to exactly the new shape even if
  // VENDOR_DIR currently holds a stale pre-rewrite tree (the old dmg-harvest's program/,
  // LICENSE-MPL.txt, NOTICE, and NO-GO VERSION-PIN).
  rmSync(VENDOR_DIR, { recursive: true, force: true });
  mkdirSync(VENDOR_DIR, { recursive: true });
  // ditto, not a plain recursive copy -- preserves real-directory placement (no symlinks
  // introduced) and exact permissions/attrs, same reason fetch-cef.ts / fetch-monaco.ts and
  // release.ts use it for every framework/bundle copy in this codebase. Symlinks INSIDE
  // product-set/ itself (Versions/Current-style, if any) are preserved as symlinks by ditto --
  // it is the *ancestry* of installPath that must stay symlink-free, not variables within it.
  execOrFail(`failed to copy product-set/ -- check disk space and permissions at ${VENDOR_DIR}`, "ditto", [
    join(extractDir, "product-set"),
    PRODUCT_SET_DIR,
  ]);
  execOrFail(`failed to copy LICENSES/ -- Norma.app is required to ship these notices`, "ditto", [
    join(extractDir, "LICENSES"),
    LICENSES_DIR,
  ]);
  execOrFail(`failed to copy VERSION-PIN`, "ditto", [join(extractDir, "VERSION-PIN"), VERSION_PIN_PATH]);

  const stamp: Stamp = {
    tag: RELEASE_TAG,
    assetName: ASSET_NAME,
    sha256: PINNED_SHA256,
    fetchedAt: new Date().toISOString(),
  };
  writeFileSync(STAMP_PATH, JSON.stringify(stamp, null, 2) + "\n");

  const productSetBytes =
    Number(execFileSync("du", ["-sk", PRODUCT_SET_DIR], { encoding: "utf8" }).trim().split(/\s+/)[0]) * 1024;
  // T1v2 review F6: `productSetBytes / 1e6` (decimal mega) rendered "~512 MB" for a tree every
  // other measurement in this project's own history calls "488MB" (`du -sk`'s own KiB blocks, the
  // binary/1024-based unit) -- technically defensible for its OWN label but inconsistent with
  // every other size this codebase quotes for the identical tree (this file's own header comment
  // included). Dividing by 1024*1024 instead renders the number everyone already means.
  console.log(
    `\nVendored LibreOffice product-set (${RELEASE_TAG}, LibreOffice/core @ ${LIBREOFFICE_CORE_COMMIT}) at ${VENDOR_DIR}\n` +
      `  product-set/: ~${(productSetBytes / (1024 * 1024)).toFixed(0)} MB (du -sk, block-rounded)\n` +
      `  stamp:        ${STAMP_PATH}\n\n` +
      `LOK installPath = ${PRODUCT_SET_DIR}/Frameworks (the directory containing libmergedlo.dylib).\n` +
      `Read ${VERSION_PIN_PATH} before wiring this up -- it has the engine facts embedders need:\n` +
      `dlopen entry point, the _Exit(0) teardown mitigation for Writer formats, the three\n` +
      `fontconfig <dir> lines for correct system-font rendering, and why libskialo.dylib ships\n` +
      `unconditionally. This tree is wired into project.yml's "Check LibreOffice vendored"\n` +
      `preBuildScripts gate.\n`,
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
