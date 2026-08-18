/**
 * Vendors an official LibreOffice macOS arm64 build into apple/Norma/vendor/libreoffice/
 * (gitignored -- ~585MB after the mechanical trim below, ~791MB before) the way scripts/
 * fetch-cef.ts and scripts/fetch-monaco.ts vendor their own dependencies: pinned, hash-verified,
 * extracted (here: mounted+copied), stamped for idempotency.
 *
 * =====================================================================================
 * NO-GO, per docs/superpowers/research/2026-08-18-lok-embed-gate.md (Task 1 of the Office
 * Stage A plan). This script is NOT wired into any Xcode build gate (unlike fetch-cef.ts /
 * fetch-monaco.ts), and the tree it produces is NOT usable in-process: LibreOfficeKit's
 * lok_init_2() crashes on macOS before it even returns -- LOK spins the office nucleus on its
 * own internally-spawned worker thread, and that thread hits AppKit's hard "NSWindow only on
 * the main thread" rule the moment VCL's Aqua backend tries to construct a combo-box control
 * (see the gate report for the full stack trace). This is not a bug in Norma's usage: it is a
 * confirmed, currently open, upstream architecture gap -- macOS has no headless VCL
 * implementation (only iOS does, among Apple platforms), and LibreOffice's own build system was
 * patched in January 2025 to hard-error compiling LibreOfficeKit for macOS specifically BECAUSE
 * "the built library won't work as intended" (LibreOffice/core commit
 * 18e5d1ce26ab7a0fb41b8b64a0a732b5f81f3ed8, tdf#145127).
 *
 * This script still exists -- committed, working, kept current -- so that RE-RUNNING the gate is
 * one command instead of a from-scratch investigation, the day tdf#145127 closes (a real
 * headless macOS VCL implementation ships upstream). Until then: do not wire this into a build
 * gate, do not point any app code at vendor/libreoffice/program/, and re-read the gate report
 * before reviving this plan.
 * =====================================================================================
 *
 * Usage: bun run scripts/fetch-libreoffice.ts          (or: bun run libreoffice:fetch)
 *        bun run scripts/fetch-libreoffice.ts --force   (re-fetch even if the stamp matches)
 *
 * --- Source: the official LibreOffice mac arm64 stable dmg ---
 * download.documentfoundation.org's /stable/ index is the authoritative "currently maintained"
 * list -- at pin time it held two release lines, 26.2.x ("Fresh") and 25.8.x ("Still"); 25.8's
 * support window had already closed (endoflife.date, cross-checked against TDF's own release
 * schedule pages), leaving 26.2.5 as the only actively-maintained build. Version is pinned
 * deliberately -- never floated to "latest". Bumping it is a one-line edit here; the stamp file
 * (below) makes a bump self-invalidating, so the next run re-fetches automatically instead of
 * silently keeping stale bits.
 *
 * --- Verification: belt and braces, same shape as fetch-cef.ts ---
 * PINNED_DMG_SHA256 below is hand-pinned at implement time from the dmg's own published
 * `.sha256` sidecar (https://download.documentfoundation.org/.../LibreOffice_*.dmg.sha256),
 * cross-checked against an independent `shasum -a 256` of an actually-downloaded dmg before
 * being transcribed here. Belt: the pin below, checked against the LIVE sidecar before
 * downloading. Braces: the actual download, checked against that same pinned value again after.
 * A mismatch at either layer hard-fails rather than trusting a CDN response -- same two-layer
 * shape as fetch-cef.ts's PINNED_SHA1-vs-index.json check, not collapsed into one.
 *
 * --- Harvest, not extract: hdiutil mount + ditto copy ---
 * Unlike CEF/Monaco's tarballs, the source artifact is a signed Apple disk image containing a
 * full LibreOffice.app. The harvest takes exactly two subtrees -- Contents/Frameworks and
 * Contents/Resources, copied to program/Frameworks and program/Resources -- preserving Apple's
 * own bundle-relative geometry deliberately: LibreOfficeKitInit.h's lok_dlopen() resolves
 * libmergedlo.dylib relative to installPath (== program/Frameworks), and libmergedlo's own
 * bootstrap then finds fundamentalrc via `${ORIGIN}/..` from ITS OWN load path -- i.e. it
 * expects Resources/ to be Frameworks/'s SIBLING, exactly the Contents/{Frameworks,Resources}
 * relationship Apple's own bundle already has. Renaming or flattening either directory breaks
 * that resolution chain (confirmed by reading fundamentalrc/bootstraprc/lounorc directly -- see
 * the gate report). Contents/MacOS is NOT harvested: URE_BIN_DIR points at it, but nothing this
 * vendor tree is used for (LOK-style in-process embedding) execs anything from it.
 *
 * --- Trim: mechanical, NOT runtime-validated (see NO-GO header above) ---
 * The buckets below are the ones the gate's `du` survey identified as unambiguously optional for
 * a document-RENDERING use case (no interactive UI chrome, no scripting, no help viewer) -- cut
 * because they are clearly dead weight BY PURPOSE, not because a passing spike proved them safe
 * to remove (the spike never got far enough to validate anything -- see NO-GO header). Full
 * harvest: ~791MB (428MB Frameworks + 363MB Resources). This trim removes ~206MB, landing
 * ~585MB -- still ~46% over the gate's 400MB hard-fail ceiling on its own, before any deeper
 * (and far riskier -- Frameworks/ is ~130 UNO component libraries with unclear per-format
 * dependency boundaries) trimming of Frameworks/. Getting under the 300MB target was never
 * within reach even setting the fatal criteria-2/3 failure aside.
 *
 * --- Idempotency ---
 * Same shape as fetch-cef.ts / fetch-monaco.ts: a stamp file records the exact (version, sha256)
 * a previous run verified; a second run whose stamp matches, with the expected paths still on
 * disk, does no network I/O and no remounting.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./version-lib";

// ---------------------------------------------------------------------------
// Pinned version. Do not float to "latest" -- see header comment.
// ---------------------------------------------------------------------------
const LIBREOFFICE_VERSION = "26.2.5";
const PLATFORM_DIR = "mac/aarch64";
const DMG_NAME = `LibreOffice_${LIBREOFFICE_VERSION}_MacOS_aarch64.dmg`;
const BASE_URL = `https://download.documentfoundation.org/libreoffice/stable/${LIBREOFFICE_VERSION}/${PLATFORM_DIR}`;
const DMG_URL = `${BASE_URL}/${DMG_NAME}`;
const DMG_SHA256_SIDECAR_URL = `${DMG_URL}.sha256`;
// Hand-pinned at implement time -- see header comment for provenance and the independent
// recomputation cross-check performed before transcribing this.
const PINNED_DMG_SHA256 = "c99fb4fe574437fc4cb820a4ca15271bca325920861f7139858b36d7f9df78ad";
// The LibreOffice/core source tag the vendored LOK headers (apple/Norma/Sources/OfficeKit/
// include/) were pinned to -- informational here (this script does not fetch headers), recorded
// so a version bump reminds whoever bumps LIBREOFFICE_VERSION to re-pin the headers too. Chosen
// by matching commit-date proximity to the dmg's own build date (dmg built 24 Jul 2026; this
// tag's commit is 21 Jul 2026, the closest tag below the dmg date -- libreoffice-26.2.5.1 was a
// month earlier and too early to be this release build's source).
const LIBREOFFICEKIT_HEADERS_CORE_TAG = "libreoffice-26.2.5.2";

const VENDOR_DIR = join(ROOT, "apple", "Norma", "vendor", "libreoffice");
const PROGRAM_DIR = join(VENDOR_DIR, "program");
const STAMP_PATH = join(VENDOR_DIR, ".vendored-version");
const VERSION_PIN_PATH = join(VENDOR_DIR, "VERSION-PIN");
const LICENSE_PATH = join(VENDOR_DIR, "LICENSE-MPL.txt");
const NOTICE_PATH = join(VENDOR_DIR, "NOTICE");
// The single file lok_dlopen() actually needs present to succeed -- the sharpest marker that a
// harvest is real and complete, mirroring fetch-cef.ts's FRAMEWORK_REL marker.
const MERGED_LIB_REL = join("program", "Frameworks", "libmergedlo.dylib");
const FUNDAMENTALRC_REL = join("program", "Resources", "fundamentalrc");

const FORCE = process.argv.includes("--force");

function fail(msg: string): never {
  console.error(`\nFAIL: ${msg}\n`);
  process.exit(1);
}

function vendoredPathsPresent(): boolean {
  return (
    existsSync(join(VENDOR_DIR, MERGED_LIB_REL)) &&
    existsSync(join(VENDOR_DIR, FUNDAMENTALRC_REL)) &&
    existsSync(LICENSE_PATH) &&
    existsSync(NOTICE_PATH)
  );
}

interface Stamp {
  version: string;
  sha256: string;
  fetchedAt: string;
}

/** Network-free, fast. */
function alreadyVendored(): Stamp | null {
  if (!existsSync(STAMP_PATH)) return null;
  let stamp: Stamp;
  try {
    stamp = JSON.parse(readFileSync(STAMP_PATH, "utf8"));
  } catch {
    return null;
  }
  if (stamp.version !== LIBREOFFICE_VERSION || stamp.sha256 !== PINNED_DMG_SHA256) return null;
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
      `LibreOffice ${LIBREOFFICE_VERSION} already vendored and verified at ${VENDOR_DIR}\n` +
        `  sha256:  ${existing.sha256}\n` +
        `  fetched: ${existing.fetchedAt}\n` +
        `Nothing to do. (--force to re-fetch anyway.)\n\n` +
        `Reminder: this tree is NOT usable in-process (NO-GO -- see\n` +
        `docs/superpowers/research/2026-08-18-lok-embed-gate.md).`,
    );
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Belt: pinned sha256 checked against the dmg's own live .sha256 sidecar BEFORE downloading.
// ---------------------------------------------------------------------------
console.log(`Fetching live checksum sidecar (${DMG_SHA256_SIDECAR_URL})...`);
let liveSha256: string;
try {
  const raw = execFileSync("curl", ["-fsS", DMG_SHA256_SIDECAR_URL], { encoding: "utf8" });
  const match = raw.trim().match(/^([0-9a-f]{64})\s+/i);
  if (!match) fail(`could not parse a sha256 out of the sidecar response: ${JSON.stringify(raw)}`);
  liveSha256 = match[1]!.toLowerCase();
} catch (e) {
  fail(`could not fetch/parse ${DMG_SHA256_SIDECAR_URL}: ${e}`);
}
if (liveSha256 !== PINNED_DMG_SHA256) {
  fail(
    `live sidecar sha256 does not match the pinned value\n` +
      `  pinned (this script):             ${PINNED_DMG_SHA256}\n` +
      `  live (${DMG_SHA256_SIDECAR_URL}):\n  ${liveSha256}\n` +
      `Refusing to trust a sidecar that disagrees with the recorded pin. If TDF genuinely\n` +
      `re-published this exact version's bytes, investigate before updating the pin -- don't\n` +
      `chase this error by blindly copying the new value in.`,
  );
}
console.log(`sidecar OK: ${liveSha256}`);

// ---------------------------------------------------------------------------
// Download, verify (braces), mount, harvest, trim, place. Everything transient lives under one
// temp dir that is always removed on the way out; the dmg mount is always detached on the way
// out too (success or failure) -- mirrors fetch-cef.ts's tmp-dir discipline, extended to cover
// the mount point since a leaked `hdiutil attach` is a worse leak than a leaked directory (it
// pins a mounted volume until the next reboot or a manual detach).
// ---------------------------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "norma-libreoffice-"));
const mountPoint = join(tmp, "mnt");
mkdirSync(mountPoint, { recursive: true });
let mounted = false;

function detachIfMounted(): void {
  if (!mounted) return;
  try {
    execFileSync("hdiutil", ["detach", mountPoint, "-quiet"]);
  } catch {
    try {
      execFileSync("hdiutil", ["detach", mountPoint, "-force", "-quiet"]);
    } catch (e) {
      console.error(`warning: failed to detach ${mountPoint}: ${e}`);
    }
  }
  mounted = false;
}

// fail() calls process.exit(), which does NOT unwind the stack -- the `finally` below never runs
// on that path (same trap fetch-cef.ts/fetch-monaco.ts document). Every fail() called from
// inside this try must go through here first, or a failure leaks a mounted volume or a partial
// download.
const failTmp = (msg: string): never => {
  detachIfMounted();
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
  const dmgPath = join(tmp, DMG_NAME);
  console.log(`Downloading ${DMG_URL}\n  -> ${dmgPath}`);
  // stdio: inherit -- this is a ~284MB download; let curl's own progress meter and any error
  // output reach the terminal directly rather than buffering it (mirrors fetch-cef.ts).
  execOrFail("download failed -- check your network connection and try again", "curl", ["-fL", "-o", dmgPath, DMG_URL], true);

  console.log("Verifying sha256 against the pinned value (braces)...");
  const actualSha256 = createHash("sha256").update(readFileSync(dmgPath)).digest("hex");
  if (actualSha256 !== PINNED_DMG_SHA256) {
    failTmp(
      `sha256 mismatch for ${DMG_NAME}\n` +
        `  expected (pinned):    ${PINNED_DMG_SHA256}\n` +
        `  actual (downloaded):  ${actualSha256}\n` +
        `Refusing to mount/harvest a corrupted or tampered download.`,
    );
  }
  console.log(`sha256 OK: ${actualSha256}`);

  console.log(`Mounting ${dmgPath}...`);
  execOrFail("hdiutil attach failed", "hdiutil", [
    "attach",
    dmgPath,
    "-nobrowse",
    "-readonly",
    "-quiet",
    "-mountpoint",
    mountPoint,
  ]);
  mounted = true;

  const appContents = join(mountPoint, "LibreOffice.app", "Contents");
  const srcFrameworks = join(appContents, "Frameworks");
  const srcResources = join(appContents, "Resources");
  const srcLicense = join(appContents, "Resources", "LICENSE");
  const srcNotice = join(appContents, "Resources", "NOTICE");
  for (const [label, p] of [
    ["Contents/Frameworks", srcFrameworks],
    ["Contents/Resources", srcResources],
    ["Contents/Resources/LICENSE", srcLicense],
    ["Contents/Resources/NOTICE", srcNotice],
  ] as const) {
    if (!existsSync(p)) {
      failTmp(
        `mounted dmg is missing ${label} at ${p} -- LibreOffice.app's internal layout may have\n` +
          `changed upstream (docs/superpowers/research/2026-08-18-lok-embed-gate.md's Task 1\n` +
          `measured it present at ${LIBREOFFICE_VERSION}).`,
      );
    }
  }

  console.log(`Placing harvested tree at ${VENDOR_DIR}...`);
  rmSync(VENDOR_DIR, { recursive: true, force: true });
  mkdirSync(PROGRAM_DIR, { recursive: true });
  // ditto, not a plain recursive copy -- preserves the framework's versioned-bundle symlink
  // structure (LibreOfficePython.framework's Versions/Current -> 3.12, etc.) exactly, same
  // reason fetch-cef.ts and release.ts use it for every framework/bundle copy in this codebase.
  execOrFail(`failed to copy Contents/Frameworks -- check disk space and permissions at ${VENDOR_DIR}`, "ditto", [
    srcFrameworks,
    join(PROGRAM_DIR, "Frameworks"),
  ]);
  execOrFail(`failed to copy Contents/Resources -- check disk space and permissions at ${VENDOR_DIR}`, "ditto", [
    srcResources,
    join(PROGRAM_DIR, "Resources"),
  ]);
  execOrFail(`failed to copy LICENSE -- Norma.app is required to ship this notice`, "ditto", [srcLicense, LICENSE_PATH]);
  execOrFail(`failed to copy NOTICE -- Norma.app is required to ship this notice (Apache-2.0 portions)`, "ditto", [
    srcNotice,
    NOTICE_PATH,
  ]);

  detachIfMounted(); // done reading from the volume; detach before the (slower) trim work below

  // -------------------------------------------------------------------------
  // Mechanical trim -- NOT runtime-validated. See NO-GO header comment.
  // -------------------------------------------------------------------------
  const TRIM_PATHS = [
    join("Frameworks", "LibreOfficePython.framework"), // Python scripting -- ~83MB
    join("Resources", "java"), // Java framework support -- ~7.8MB
    join("Resources", "help"), // in-app help content -- ~61MB
    join("Resources", "wizards"), // letter/fax/web wizards -- ~5.6MB
    join("Resources", "gallery"), // clipart gallery -- ~13MB
    join("Resources", "extensions", "dict-es"), // non-English dictionary -- ~23MB (keep dict-en)
    join("Resources", "extensions", "dict-fr"), // non-English dictionary -- ~6.5MB (keep dict-en)
    join("Resources", "extensions", "nlpsolver"), // optimization solver extension -- ~6.4MB
  ];
  console.log("Applying mechanical trim (NOT runtime-validated -- see NO-GO header)...");
  for (const rel of TRIM_PATHS) {
    const p = join(PROGRAM_DIR, rel);
    if (existsSync(p)) {
      rmSync(p, { recursive: true, force: true });
      console.log(`  removed ${rel}`);
    } else {
      console.log(`  (skip -- not present: ${rel})`);
    }
  }

  const versionPin =
    `LIBREOFFICE_VERSION=${LIBREOFFICE_VERSION}\n` +
    `SOURCE_URL=${DMG_URL}\n` +
    `SHA256=${PINNED_DMG_SHA256}\n` +
    `LIBREOFFICEKIT_HEADERS_CORE_TAG=${LIBREOFFICEKIT_HEADERS_CORE_TAG}\n` +
    `FETCHED_AT=${new Date().toISOString()}\n` +
    `\n` +
    `GATE STATUS: NO-GO -- see docs/superpowers/research/2026-08-18-lok-embed-gate.md\n` +
    `LibreOfficeKit's lok_init_2() crashes on macOS (AppKit main-thread violation inside VCL's\n` +
    `Aqua backend, triggered from LOK's own internally-spawned worker thread) -- a confirmed,\n` +
    `currently open upstream gap (tdf#145127; LibreOffice/core commit\n` +
    `18e5d1ce26ab7a0fb41b8b64a0a732b5f81f3ed8 hard-errors compiling LibreOfficeKit for macOS\n` +
    `specifically because "the built library won't work as intended"). This vendor tree is NOT\n` +
    `usable in-process. Do not wire it into a build gate.\n`;
  writeFileSync(VERSION_PIN_PATH, versionPin);

  const stamp: Stamp = {
    version: LIBREOFFICE_VERSION,
    sha256: PINNED_DMG_SHA256,
    fetchedAt: new Date().toISOString(),
  };
  writeFileSync(STAMP_PATH, JSON.stringify(stamp, null, 2) + "\n");

  const programBytes =
    Number(execFileSync("du", ["-sk", PROGRAM_DIR], { encoding: "utf8" }).trim().split(/\s+/)[0]) * 1024;
  console.log(
    `\nVendored (and mechanically trimmed) LibreOffice ${LIBREOFFICE_VERSION} at ${VENDOR_DIR}\n` +
      `  program/: ~${(programBytes / 1e6).toFixed(0)} MB (du -sk, block-rounded)\n` +
      `  stamp:    ${STAMP_PATH}\n\n` +
      `NO-GO: this tree is NOT usable in-process. Read\n` +
      `docs/superpowers/research/2026-08-18-lok-embed-gate.md before doing anything else with it.\n`,
  );
} finally {
  detachIfMounted();
  rmSync(tmp, { recursive: true, force: true });
}
