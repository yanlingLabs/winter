/**
 * Publishes the vendored iroh-ffi Apple XCFramework (apple/NormaKit/vendor/IrohLib.xcframework)
 * as a checksum'd GitHub release asset on the public repo, so `apple/NormaKit/Package.swift`
 * can consume it via `.binaryTarget(url:checksum:)` — resolvable by a REMOTE SPM consumer (the
 * future iOS app) with no local fetch step, as well as by local Mac builds.
 *
 * This is a BUILD-ASSET release, not a product release: it's tagged `iroh-xcframework-<ver>`
 * (never a `v-*`/`v#.#.###` product tag) where `<ver>` is the iroh-ffi version pinned in
 * vendor/fetch-iroh.sh (IROH_VERSION, e.g. "v1.1.0").
 *
 * Usage: bun scripts/publish-iroh-xcframework.ts [--force]
 *
 * If the release tag already exists, this ABORTS by default, before zipping or uploading
 * anything. That's deliberate, not just politeness: `ditto` zips embed file mtimes, so a
 * re-zip produces different bytes — and a different SPM checksum — even for identical
 * xcframework content. Clobbering the hosted asset while Package.swift still pins the old
 * checksum would hard-fail every future `swift build`, everywhere. Pass --force to replace
 * the asset anyway; the script then prints an old-committed-vs-new checksum warning and you
 * MUST update Package.swift's `.binaryTarget(checksum:)` to the newly printed value.
 *
 * Prints the asset URL and the SPM checksum (from `swift package compute-checksum`, NOT a raw
 * sha256 — that's a different format and SPM will reject it in Package.swift).
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GH_REPO } from "./release-lib";
import { ROOT } from "./version-lib";

const NORMAKIT_DIR = join(ROOT, "apple", "NormaKit");
const VENDOR_DIR = join(NORMAKIT_DIR, "vendor");
const XCFRAMEWORK_DIR = join(VENDOR_DIR, "IrohLib.xcframework");
const FETCH_SCRIPT = join(VENDOR_DIR, "fetch-iroh.sh");
const PACKAGE_SWIFT = join(NORMAKIT_DIR, "Package.swift");
const ZIP_PATH = "/tmp/IrohLib.xcframework.zip";
const ASSET_NAME = "IrohLib.xcframework.zip";

function readIrohVersion(): string {
  const src = readFileSync(FETCH_SCRIPT, "utf8");
  const m = src.match(/^IROH_VERSION="([^"]+)"/m);
  if (!m) throw new Error(`could not find IROH_VERSION in ${FETCH_SCRIPT}`);
  return m[1];
}

/** The checksum currently pinned in Package.swift's `.binaryTarget(checksum:)`, if any. */
function readCommittedChecksum(): string | null {
  const src = readFileSync(PACKAGE_SWIFT, "utf8");
  const m = src.match(/checksum:\s*"([0-9a-f]{64})"/);
  return m ? m[1] : null;
}

function ensureXcframework(): void {
  if (existsSync(XCFRAMEWORK_DIR)) return;
  console.log(`${XCFRAMEWORK_DIR} not found — running fetch-iroh.sh...`);
  execSync(`"${FETCH_SCRIPT}"`, { stdio: "inherit" });
  if (!existsSync(XCFRAMEWORK_DIR)) {
    throw new Error(`fetch-iroh.sh ran but ${XCFRAMEWORK_DIR} still missing`);
  }
}

function zipXcframework(): void {
  console.log(`Zipping ${XCFRAMEWORK_DIR} -> ${ZIP_PATH} (ditto -c -k --keepParent)...`);
  execFileSync(
    "ditto",
    ["-c", "-k", "--keepParent", XCFRAMEWORK_DIR, ZIP_PATH],
    { stdio: "inherit" },
  );
}

function computeSpmChecksum(): string {
  console.log("Computing SPM checksum (swift package compute-checksum)...");
  const out = execFileSync(
    "swift",
    ["package", "compute-checksum", ZIP_PATH],
    { cwd: NORMAKIT_DIR, encoding: "utf8" },
  );
  const checksum = out.trim();
  if (!/^[0-9a-f]{64}$/.test(checksum)) {
    throw new Error(`unexpected 'swift package compute-checksum' output: ${JSON.stringify(out)}`);
  }
  return checksum;
}

function releaseExists(tag: string): boolean {
  try {
    execFileSync("gh", ["release", "view", tag, "--repo", GH_REPO], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function main(): void {
  const force = process.argv.includes("--force");
  const version = readIrohVersion();
  const tag = `iroh-xcframework-${version}`;
  const url = `https://github.com/${GH_REPO}/releases/download/${tag}/${ASSET_NAME}`;
  const exists = releaseExists(tag);

  if (exists && !force) {
    // Abort BEFORE zipping/uploading anything. A ditto re-zip has different bytes (mtimes)
    // even for identical content — clobbering the asset without updating Package.swift's
    // pinned checksum would break `swift build` for every consumer.
    console.error(`error: release ${tag} already exists on ${GH_REPO}:`);
    console.error(`  https://github.com/${GH_REPO}/releases/tag/${tag}`);
    console.error(`  asset: ${url}`);
    console.error("");
    console.error("Aborting without zipping or uploading — replacing the hosted asset would");
    console.error("change its bytes (ditto zips embed mtimes) and invalidate the checksum");
    console.error("pinned in apple/NormaKit/Package.swift, breaking `swift build` everywhere.");
    console.error("");
    console.error("If you really mean to replace it (e.g. after bumping the xcframework");
    console.error("contents without bumping IROH_VERSION), re-run with --force, then update");
    console.error("Package.swift's `.binaryTarget(checksum:)` to the newly printed value.");
    process.exit(1);
  }

  ensureXcframework();
  zipXcframework();
  const checksum = computeSpmChecksum();

  if (exists) {
    // --force path: replace the existing asset, warning loudly about the checksum change.
    const committed = readCommittedChecksum();
    console.warn(`\nwarning: --force replacing the asset on existing release ${tag}.`);
    if (committed === checksum) {
      // Only possible if the new zip is byte-identical to the old one — practically never.
      console.warn("  committed checksum matches the new zip — nothing to update.");
    } else {
      console.warn("  Package.swift's pinned checksum no longer matches the uploaded asset:");
      console.warn(`  - ${committed ?? "(no checksum: found in Package.swift)"}`);
      console.warn(`  + ${checksum}`);
      console.warn("  UPDATE apple/NormaKit/Package.swift's `.binaryTarget(checksum:)` to the");
      console.warn("  `+` value above, or every `swift build` will fail checksum verification.");
    }
    console.log(`Uploading asset with --clobber...`);
    execFileSync(
      "gh",
      ["release", "upload", tag, `${ZIP_PATH}#${ASSET_NAME}`, "--repo", GH_REPO, "--clobber"],
      { stdio: "inherit" },
    );
  } else {
    console.log(`Creating release ${tag}...`);
    execFileSync(
      "gh",
      [
        "release",
        "create",
        tag,
        `${ZIP_PATH}#${ASSET_NAME}`,
        "--repo",
        GH_REPO,
        "--title",
        `iroh xcframework ${version}`,
        "--notes",
        "Vendored iroh-ffi Apple xcframework for SPM binaryTarget",
      ],
      { stdio: "inherit" },
    );
  }

  console.log("\n--- iroh xcframework published ---");
  console.log(`tag:      ${tag}`);
  console.log(`url:      ${url}`);
  console.log(`checksum: ${checksum}`);
  console.log("-----------------------------------");
}

main();
