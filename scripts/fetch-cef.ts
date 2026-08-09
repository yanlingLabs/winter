/**
 * Vendors CEF (Chromium Embedded Framework)'s prebuilt macOS arm64 distribution into
 * apple/Norma/vendor/cef/ (gitignored -- ~332MB uncompressed). Run once after cloning, or
 * whenever CEF_VERSION below is deliberately bumped. `apple/Norma/project.yml`'s Norma target
 * carries a preBuildScripts check that fails the Xcode build loudly, naming this exact command,
 * if the vendored tree is missing.
 *
 * Usage: bun run scripts/fetch-cef.ts   (or: bun run cef:fetch)
 *
 * Version is pinned deliberately (see CEF_VERSION below) -- never floated to "latest". Bumping
 * it is a one-line edit here; the stamp file (below) makes a bump self-invalidating, so the
 * next run re-fetches automatically instead of silently keeping stale bits.
 *
 * --- Artifact choice: MINIMAL, not standard ---
 * Plan B1's design doc says "develop against standard, ship minimal's Release framework" --
 * i.e. assumed this script would need the 284MB standard distribution. That assumption does
 * not survive contact with what's actually inside the distributions (measured in
 * docs/research/2026-08-09-cef-spike.md, Q1): minimal's own layout already contains `include/`
 * (every CEF header, C++ and C `capi/` alike) and `libcef_dll/` (the libcef_dll_wrapper
 * SOURCE -- no distribution ships a prebuilt `.a`, confirmed there by `find -name "*.a"`
 * turning up nothing in either one) alongside the `Release/` framework itself. The only things
 * standard adds are `tests/` (cefsimple/cefclient/ceftests sample sources -- read for Task 1's
 * spike/pump research, but Plan B1 explicitly VENDORS the ~100 lines of pump code it needs
 * into NormaCEF rather than depending on `tests/` living on disk) and a second `Debug/`
 * framework copy Norma never ships. Nothing downstream of this script -- the wrapper build,
 * the ObjC++ bridge, the app's own headers -- touches `tests/`. So minimal is the only artifact
 * this script, or any future contributor, needs: 125MB compressed instead of 284MB.
 *
 * --- Verification ---
 * Fetches https://cef-builds.spotifycdn.com/index.json fresh on every run that isn't already
 * satisfied, and checks the downloaded artifact's actual sha1 against the sha1 index.json
 * publishes for this exact (version, platform, type) triple -- catching transit corruption or
 * a CDN cache serving the wrong bytes for the filename. This is a integrity check, not a trust
 * root: CEF_VERSION below is what decides which build we trust; index.json only proves we
 * received what CEF's own manifest says that pinned build looks like.
 *
 * --- Idempotency ---
 * A stamp file (VENDOR_DIR/.vendored-version) records the exact (version, type, sha1) a
 * previous run verified and extracted. A second run whose stamp matches the constants below,
 * with the expected directories still present on disk, does NO network I/O at all -- downloading
 * 125MB on every build is not acceptable, and this can run once per Xcode build (see
 * project.yml's preBuildScripts).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./version-lib";

// ---------------------------------------------------------------------------
// Pinned version. Do not float to "latest" -- see header comment.
// ---------------------------------------------------------------------------
const CEF_VERSION = "151.3.16+gbe1e15d+chromium-151.0.7922.109";
const PLATFORM = "macosarm64";
const ARTIFACT_TYPE = "minimal";
// Pinned independently of the live index.json fetch below -- belt AND braces (Task 2 whole-
// branch review, Minor): index.json alone would let a CDN-level compromise able to swap the
// tarball also swap the manifest's sha1 to match, defeating that check silently. Recorded from
// docs/research/2026-08-09-cef-spike.md's own verified download of this exact artifact; matches
// apple/NormaKit/vendor/fetch-iroh.sh's IROH_ZIP_SHA256 convention (a literal, not a live fetch).
// Checked against index.json's live value BEFORE downloading (the "belt"); the actual download
// is then checked against index.json's value same as before (the "braces") -- two independent
// layers, not collapsed into one, so a mismatch names which layer disagreed.
const PINNED_SHA1 = "9686f8f6ef1343aa813af2c200db29f8b95abe7f";
const BASE_URL = "https://cef-builds.spotifycdn.com";
const INDEX_URL = `${BASE_URL}/index.json`;

const VENDOR_DIR = join(ROOT, "apple", "Norma", "vendor", "cef");
const STAMP_PATH = join(VENDOR_DIR, ".vendored-version");
// Top-level dirs copied verbatim from the extracted distribution into VENDOR_DIR: the
// idempotency check (vendoredPathsPresent, below) and the extraction step key off this same
// list, so they can't drift apart from EACH OTHER. "Vendored" as a whole concept is stricter
// than this list, though: it's these dirs present AND STAMP_PATH present with a matching
// version/type (see alreadyVendored) -- a run killed mid-copy can leave dirs complete-looking
// but no stamp, and only the stamp proves the copy that produced them finished and was
// verified. apple/Norma/project.yml's build-gate script is hand-kept in sync with BOTH halves
// of that (dirs + stamp) since YAML can't import this list directly -- if either list changes,
// update the other by hand (Task 2 whole-branch review, Important: the gate originally checked
// dirs only and false-passed exactly this partial-tree state).
const COPY_DIRS = ["Release", "include", "libcef_dll"];
const COPY_FILES = ["LICENSE.txt"];
// The specific marker inside Release/ that proves the framework itself (not just an empty
// directory) is present -- what Tasks 3-6's Xcode build will actually link/embed against.
const FRAMEWORK_REL = join("Release", "Chromium Embedded Framework.framework");

function fail(msg: string): never {
  console.error(`\nFAIL: ${msg}\n`);
  process.exit(1);
}

function expectedFileName(): string {
  return `cef_binary_${CEF_VERSION}_${PLATFORM}_${ARTIFACT_TYPE}.tar.bz2`;
}

function vendoredPathsPresent(): boolean {
  if (!existsSync(join(VENDOR_DIR, FRAMEWORK_REL))) return false;
  return COPY_DIRS.every((d) => existsSync(join(VENDOR_DIR, d)));
}

interface Stamp {
  version: string;
  type: string;
  sha1: string;
  fetchedAt: string;
}

/** Network-free, fast -- safe to call once per Xcode build. */
function alreadyVendored(): Stamp | null {
  if (!existsSync(STAMP_PATH)) return null;
  let stamp: Stamp;
  try {
    stamp = JSON.parse(readFileSync(STAMP_PATH, "utf8"));
  } catch {
    return null;
  }
  if (stamp.version !== CEF_VERSION || stamp.type !== ARTIFACT_TYPE) return null;
  if (!vendoredPathsPresent()) return null;
  return stamp;
}

// ---------------------------------------------------------------------------
// Idempotency gate.
// ---------------------------------------------------------------------------
const existing = alreadyVendored();
if (existing) {
  console.log(
    `CEF ${CEF_VERSION} (${ARTIFACT_TYPE}) already vendored and verified at ${VENDOR_DIR}\n` +
      `  sha1: ${existing.sha1}\n` +
      `  fetched: ${existing.fetchedAt}\n` +
      `Nothing to do.`,
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Resolve the pinned artifact against CEF's manifest.
// ---------------------------------------------------------------------------
interface IndexFile {
  name: string;
  sha1: string;
  size: number;
  type: string;
}
interface IndexVersion {
  cef_version: string;
  files: IndexFile[];
}
type Index = Record<string, { versions: IndexVersion[] }>;

console.log(`Fetching CEF manifest (${INDEX_URL})...`);
let index: Index;
try {
  // index.json is ~10MB (812+ version entries per platform) — Node's execFileSync default
  // maxBuffer (1MB) truncates that silently into an ENOBUFS throw; raise it generously.
  const raw = execFileSync("curl", ["-fsS", INDEX_URL], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  index = JSON.parse(raw);
} catch (e) {
  fail(`could not fetch/parse ${INDEX_URL}: ${e}`);
}

const platformEntry = index[PLATFORM];
if (!platformEntry) fail(`index.json has no "${PLATFORM}" platform`);
const versionEntry = platformEntry.versions.find((v) => v.cef_version === CEF_VERSION);
if (!versionEntry) {
  fail(
    `index.json's "${PLATFORM}" platform has no entry for pinned CEF_VERSION\n  "${CEF_VERSION}"\n` +
      `Has upstream removed this build? Bumping the pin requires updating CEF_VERSION in this\n` +
      `script deliberately (and re-reading docs/research/2026-08-09-cef-spike.md's assumptions\n` +
      `for the new version) -- not chasing this error blindly.`,
  );
}
const fileEntry = versionEntry.files.find((f) => f.type === ARTIFACT_TYPE);
if (!fileEntry) {
  fail(`index.json's entry for ${CEF_VERSION}/${PLATFORM} has no "${ARTIFACT_TYPE}" file`);
}
if (fileEntry.name !== expectedFileName()) {
  fail(
    `index.json's ${ARTIFACT_TYPE} filename "${fileEntry.name}" does not match the expected\n` +
      `"${expectedFileName()}" -- naming scheme may have changed upstream.`,
  );
}
// The "belt": index.json's LIVE sha1 must agree with the pin recorded from the original,
// independently-verified download (see PINNED_SHA1 above) before we trust it enough to even
// download the tarball it names. The download-vs-index.json comparison below (the "braces")
// is a separate, later check -- this one exists so the two never collapse into a single point
// of failure that a compromised/rotated CDN response could satisfy by itself.
if (fileEntry.sha1 !== PINNED_SHA1) {
  fail(
    `index.json's sha1 for ${fileEntry.name} does not match the pinned value\n` +
      `  pinned (this script, from the spike's verified download): ${PINNED_SHA1}\n` +
      `  index.json (live, just fetched):                          ${fileEntry.sha1}\n` +
      `Refusing to trust a manifest that disagrees with the recorded pin. If CEF genuinely\n` +
      `re-published this exact version's bytes, investigate before updating PINNED_SHA1 to match\n` +
      `-- don't chase this error by blindly copying the new value in.`,
  );
}
console.log(
  `Resolved: ${fileEntry.name}\n  size: ${(fileEntry.size / 1e6).toFixed(1)} MB\n  sha1: ${fileEntry.sha1}`,
);

// ---------------------------------------------------------------------------
// Download, verify, extract, place. Everything transient lives under one temp dir that is
// always removed on the way out, success or failure (mirrors apple/NormaKit/vendor/fetch-iroh.sh).
// ---------------------------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "norma-cef-"));
// fail() calls process.exit(), which does NOT unwind the stack -- the `finally` below never
// runs on that path (release.ts's signAppcastEnclosure documents the same trap). Every fail()
// called from inside this try must go through here first, or a failure leaks up to ~125MB of
// downloaded/extracted CEF into the OS temp dir.
const failTmp = (msg: string): never => {
  rmSync(tmp, { recursive: true, force: true });
  fail(msg);
};
// Wraps an external command so a failure gets this script's own curated message (+ tmp
// cleanup via failTmp) instead of a raw Node stack trace -- same reasoning as failTmp itself,
// applied to the download/extract/copy calls below that didn't already have a custom check
// (Task 2 whole-branch review, Minor: these were the only calls in the happy path still
// unwrapped once the sha1-mismatch and missing-subdirectory checks were added).
function execOrFail(context: string, cmd: string, args: string[], inheritStdio = false): void {
  try {
    execFileSync(cmd, args, inheritStdio ? { stdio: "inherit" } : undefined);
  } catch (e) {
    failTmp(`${context}\n  command: ${cmd} ${args.map((a) => `"${a}"`).join(" ")}\n  ${e}`);
  }
}
try {
  const archivePath = join(tmp, fileEntry.name);
  const url = `${BASE_URL}/${encodeURIComponent(fileEntry.name)}`;
  console.log(`Downloading ${url}\n  -> ${archivePath}`);
  // stdio: inherit -- this is a ~125MB download (spike measured ~18s); let curl's own
  // progress meter and any error output reach the terminal directly rather than buffering it.
  execOrFail("download failed -- check your network connection and try again", "curl", ["-fL", "-o", archivePath, url], true);

  console.log("Verifying sha1 against the manifest...");
  const actualSha1 = createHash("sha1").update(readFileSync(archivePath)).digest("hex");
  if (actualSha1 !== fileEntry.sha1) {
    failTmp(
      `sha1 mismatch for ${fileEntry.name}\n` +
        `  expected (index.json): ${fileEntry.sha1}\n` +
        `  actual (downloaded):   ${actualSha1}\n` +
        `Refusing to extract a corrupted or tampered download.`,
    );
  }
  console.log(`sha1 OK: ${actualSha1}`);

  console.log("Extracting...");
  const extractDir = join(tmp, "extract");
  mkdirSync(extractDir, { recursive: true });
  execOrFail(
    "extraction failed -- the archive already passed sha1 verification, so this is more likely disk space or permissions than corruption",
    "tar",
    ["-xf", archivePath, "-C", extractDir],
  );
  const topLevel = readdirSync(extractDir);
  if (topLevel.length !== 1) {
    failTmp(`expected exactly one top-level directory in the archive, found: ${topLevel.join(", ") || "(none)"}`);
  }
  const distRoot = join(extractDir, topLevel[0]!);

  for (const d of COPY_DIRS) {
    if (!existsSync(join(distRoot, d))) {
      failTmp(
        `extracted ${ARTIFACT_TYPE} distribution is missing "${d}/" -- CEF's minimal layout may\n` +
          `have changed upstream (docs/research/2026-08-09-cef-spike.md's Q1 measured it present).`,
      );
    }
  }
  if (!existsSync(join(distRoot, FRAMEWORK_REL))) {
    failTmp(`extracted distribution is missing "${FRAMEWORK_REL}"`);
  }

  console.log(`Placing vendored tree at ${VENDOR_DIR}...`);
  rmSync(VENDOR_DIR, { recursive: true, force: true });
  mkdirSync(VENDOR_DIR, { recursive: true });
  // ditto, not a plain recursive copy -- preserves the framework's versioned-bundle symlink
  // structure (Versions/Current -> A, etc.) exactly, the same reason release.ts and
  // fetch-iroh.sh use it for every app-bundle/framework copy in this codebase.
  for (const d of COPY_DIRS) {
    execOrFail(
      `failed to copy "${d}/" into the vendored tree -- check disk space and permissions at ${VENDOR_DIR}`,
      "ditto",
      [join(distRoot, d), join(VENDOR_DIR, d)],
    );
  }
  for (const f of COPY_FILES) {
    const src = join(distRoot, f);
    if (existsSync(src)) {
      execOrFail(
        `failed to copy "${f}" into the vendored tree -- check disk space and permissions at ${VENDOR_DIR}`,
        "ditto",
        [src, join(VENDOR_DIR, f)],
      );
    }
  }

  const stamp: Stamp = {
    version: CEF_VERSION,
    type: ARTIFACT_TYPE,
    sha1: actualSha1,
    fetchedAt: new Date().toISOString(),
  };
  writeFileSync(STAMP_PATH, JSON.stringify(stamp, null, 2) + "\n");

  const frameworkBytes = Number(
    execFileSync("du", ["-sk", join(VENDOR_DIR, FRAMEWORK_REL)], { encoding: "utf8" })
      .trim()
      .split(/\s+/)[0],
  ) * 1024;
  console.log(
    `\nVendored CEF ${CEF_VERSION} (${ARTIFACT_TYPE}) at ${VENDOR_DIR}\n` +
      `  framework: ~${(frameworkBytes / 1e6).toFixed(0)} MB (du -sk, block-rounded)\n` +
      `  stamp:     ${STAMP_PATH}\n`,
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
