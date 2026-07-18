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
 * Usage: bun scripts/publish-iroh-xcframework.ts
 *
 * Idempotent: if the release tag already exists, uploads with --clobber instead of failing.
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
const ZIP_PATH = "/tmp/IrohLib.xcframework.zip";
const ASSET_NAME = "IrohLib.xcframework.zip";

function readIrohVersion(): string {
  const src = readFileSync(FETCH_SCRIPT, "utf8");
  const m = src.match(/^IROH_VERSION="([^"]+)"/m);
  if (!m) throw new Error(`could not find IROH_VERSION in ${FETCH_SCRIPT}`);
  return m[1];
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

function publish(tag: string, version: string): void {
  if (releaseExists(tag)) {
    console.log(`Release ${tag} already exists — uploading asset with --clobber...`);
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
}

function main(): void {
  const version = readIrohVersion();
  const tag = `iroh-xcframework-${version}`;

  ensureXcframework();
  zipXcframework();
  const checksum = computeSpmChecksum();
  publish(tag, version);

  const url = `https://github.com/${GH_REPO}/releases/download/${tag}/${ASSET_NAME}`;

  console.log("\n--- iroh xcframework published ---");
  console.log(`tag:      ${tag}`);
  console.log(`url:      ${url}`);
  console.log(`checksum: ${checksum}`);
  console.log("-----------------------------------");
}

main();
