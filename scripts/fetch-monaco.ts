/**
 * Vendors Monaco (the code editor VS Code is built on) into apple/Norma/vendor/monaco/
 * (gitignored -- ~13MB uncompressed) the way scripts/fetch-cef.ts vendors CEF: pinned,
 * hash-verified, extracted, stamped for idempotency. Run once after cloning, or whenever
 * MONACO_VERSION below is deliberately bumped. apple/Norma/project.yml's Norma target carries
 * a preBuildScripts check that fails the Xcode build loudly, naming this exact command, if the
 * vendored tree is missing.
 *
 * Usage: bun run scripts/fetch-monaco.ts          (or: bun run monaco:fetch)
 *        bun run scripts/fetch-monaco.ts --force   (re-fetch even if the stamp already matches)
 *
 * Version is pinned deliberately -- never floated to "latest". Bumping it is a one-line edit
 * here; the stamp file (below) makes a bump self-invalidating, so the next run re-fetches
 * automatically instead of silently keeping stale bits.
 *
 * --- Source: the npm REGISTRY TARBALL, not the npm client ---
 * monaco-editor is an npm package, but this repo has no npm client and no lockfile -- so this
 * pulls the exact same bytes `npm install monaco-editor@0.52.2` would, directly from the
 * registry's tarball URL. That URL is stable and immutable per-version: npm never mutates a
 * published version's tarball in place, a republish mints a new version, not new bytes at the
 * same URL. That immutability is what makes a single hash pin sufficient here -- unlike
 * fetch-cef.ts, there is no live manifest (CEF's index.json) mediating which file this version
 * resolves to, so there is no live value to cross-check the pin against before downloading (the
 * "belt" half of that script's two-layer check). The pin below IS the trust root on its own,
 * checked once, directly against the download (the "braces" half, unchanged in spirit).
 *
 * --- Artifact choice: min/vs only, not esm/dev/min-maps ---
 * The published package contains several build shapes (esm/, dev/, min/, min-maps/). Only
 * min/vs/ is vendored here: the minified AMD build that runs from static files via vs/loader.js
 * -- what a WKWebView-hosted local page loads, no bundler in between. package/LICENSE travels
 * with it for the same reason CEF's LICENSE.txt does: a licence obligation, not a convenience
 * (see the "Embed Monaco editor assets" phase in project.yml).
 *
 * --- Verification ---
 * The tarball's sha512 (base64, in the same `sha512-<base64>` shape as npm's own
 * `dist.integrity` field) is checked against MONACO_INTEGRITY below, pinned by hand at
 * implement time from:
 *   curl -s https://registry.npmjs.org/monaco-editor | jq -r '.versions["0.52.2"].dist.integrity'
 * and cross-checked against an independent recomputation of an actual downloaded tarball's
 * bytes before being transcribed here. A mismatch hard-fails rather than extracting a corrupted
 * or tampered download.
 *
 * --- Idempotency ---
 * A stamp file (VENDOR_DIR/.vendored-version) records the exact (version, integrity) a previous
 * run verified and extracted. A second run whose stamp matches the constants below, with the
 * expected files still present on disk, does NO network I/O at all. --force skips this check
 * and re-fetches unconditionally (fetch-cef.ts has no such flag -- deleting its stamp file is
 * its equivalent -- but an explicit flag is cheap and this script's usage comment advertises it).
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
const MONACO_VERSION = "0.52.2";
const MONACO_URL = `https://registry.npmjs.org/monaco-editor/-/monaco-editor-${MONACO_VERSION}.tgz`;
// sha512, base64 -- the exact `sha512-<base64>` shape npm publishes as `dist.integrity`, pinned
// by hand at implement time (see header comment for the exact curl+jq command and the
// independent-recomputation cross-check performed before transcribing this).
const MONACO_INTEGRITY =
  "sha512-GEQWEZmfkOGLdd3XK8ryrfWz3AIP8YymVXiPHEdewrUq7mh0qrKrfHLNCXcbB6sTnMLnOZ3ztSiKcciFUkIJwQ==";

const VENDOR_DIR = join(ROOT, "apple", "Norma", "vendor", "monaco");
const STAMP_PATH = join(VENDOR_DIR, ".vendored-version");
const VS_MARKER = join(VENDOR_DIR, "vs", "loader.js");
const LICENSE_PATH = join(VENDOR_DIR, "LICENSE");

const FORCE = process.argv.includes("--force");

function fail(msg: string): never {
  console.error(`\nFAIL: ${msg}\n`);
  process.exit(1);
}

// Both the loader marker AND the licence file matter, same reasoning as fetch-cef.ts's
// vendoredPathsPresent: a marker-only check would false-pass a tree left partial by a run that
// died mid-copy (copied vs/, never reached LICENSE), and the licence file is as load-bearing as
// the code once project.yml embeds it and a future gate comes to check for it in the built app.
function vendoredPathsPresent(): boolean {
  return existsSync(VS_MARKER) && existsSync(LICENSE_PATH);
}

interface Stamp {
  version: string;
  integrity: string;
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
  if (stamp.version !== MONACO_VERSION || stamp.integrity !== MONACO_INTEGRITY) return null;
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
      `Monaco ${MONACO_VERSION} already vendored and verified at ${VENDOR_DIR}\n` +
        `  integrity: ${existing.integrity}\n` +
        `  fetched:   ${existing.fetchedAt}\n` +
        `Nothing to do. (--force to re-fetch anyway.)`,
    );
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Download, verify, extract, place. Everything transient lives under one temp dir that is
// always removed on the way out, success or failure (mirrors scripts/fetch-cef.ts).
// ---------------------------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "norma-monaco-"));
// fail() calls process.exit(), which does NOT unwind the stack -- the `finally` below never
// runs on that path (same trap fetch-cef.ts documents). Every fail() called from inside this
// try must go through here first, or a failure leaks a temp dir with a partial download.
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
  const archivePath = join(tmp, "monaco-editor.tgz");
  console.log(`Downloading ${MONACO_URL}\n  -> ${archivePath}`);
  execOrFail(
    "download failed -- check your network connection and try again",
    "curl",
    ["-fL", "-o", archivePath, MONACO_URL],
    true,
  );

  console.log("Verifying sha512 integrity against the pinned value...");
  const actualIntegrity = `sha512-${createHash("sha512").update(readFileSync(archivePath)).digest("base64")}`;
  if (actualIntegrity !== MONACO_INTEGRITY) {
    failTmp(
      `integrity mismatch for ${MONACO_URL}\n` +
        `  expected (pinned in this script): ${MONACO_INTEGRITY}\n` +
        `  actual (downloaded):              ${actualIntegrity}\n` +
        `Refusing to extract a corrupted or tampered download. If npm genuinely re-published\n` +
        `this exact version's bytes, investigate before updating MONACO_INTEGRITY to match --\n` +
        `don't chase this error by blindly copying the new value in.`,
    );
  }
  console.log(`integrity OK: ${actualIntegrity}`);

  console.log("Extracting...");
  const extractDir = join(tmp, "extract");
  mkdirSync(extractDir, { recursive: true });
  execOrFail(
    "extraction failed -- the archive already passed integrity verification, so this is more likely disk space or permissions than corruption",
    "tar",
    ["-xf", archivePath, "-C", extractDir],
  );
  // npm tarballs deterministically wrap their contents in a single "package/" top-level dir --
  // asserted rather than assumed, mirroring fetch-cef.ts's defensive check against an
  // unexpected upstream layout change.
  const topLevel = readdirSync(extractDir);
  if (topLevel.length !== 1 || topLevel[0] !== "package") {
    failTmp(
      `expected exactly one top-level directory named "package" in the archive, found: ` +
        `${topLevel.join(", ") || "(none)"}`,
    );
  }
  const pkgRoot = join(extractDir, "package");

  const vsSrc = join(pkgRoot, "min", "vs");
  const licenseSrc = join(pkgRoot, "LICENSE");
  if (!existsSync(join(vsSrc, "loader.js"))) {
    failTmp(
      `extracted package is missing "min/vs/loader.js" -- monaco-editor's published layout may\n` +
        `have changed upstream.`,
    );
  }
  if (!existsSync(licenseSrc)) {
    failTmp(
      `extracted package is missing "LICENSE" -- Norma.app is required to ship this notice.\n` +
        `Do not work around this by dropping the copy.`,
    );
  }

  console.log(`Placing vendored tree at ${VENDOR_DIR}...`);
  rmSync(VENDOR_DIR, { recursive: true, force: true });
  mkdirSync(VENDOR_DIR, { recursive: true });
  // ditto, not a plain recursive copy -- matches every other vendor/bundle copy in this
  // codebase (fetch-cef.ts, project.yml's embed phases, apple/NormaKit/vendor/fetch-iroh.sh).
  execOrFail(
    `failed to copy "min/vs/" into the vendored tree -- check disk space and permissions at ${VENDOR_DIR}`,
    "ditto",
    [vsSrc, join(VENDOR_DIR, "vs")],
  );
  execOrFail(
    `failed to copy "LICENSE" into the vendored tree -- check disk space and permissions at ${VENDOR_DIR}`,
    "ditto",
    [licenseSrc, LICENSE_PATH],
  );

  const stamp: Stamp = {
    version: MONACO_VERSION,
    integrity: MONACO_INTEGRITY,
    fetchedAt: new Date().toISOString(),
  };
  writeFileSync(STAMP_PATH, JSON.stringify(stamp, null, 2) + "\n");

  const vsBytes =
    Number(
      execFileSync("du", ["-sk", join(VENDOR_DIR, "vs")], { encoding: "utf8" })
        .trim()
        .split(/\s+/)[0],
    ) * 1024;
  console.log(
    `\nVendored Monaco ${MONACO_VERSION} at ${VENDOR_DIR}\n` +
      `  vs/:   ~${(vsBytes / 1e6).toFixed(0)} MB (du -sk, block-rounded)\n` +
      `  stamp: ${STAMP_PATH}\n`,
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
