/**
 * Winter Phase 10a (Task L1/L2, fix round 1) — vendors Anthropic's Platform CLI `ant` (darwin-arm64)
 * into `vendor/ant/<tag>/ant` (gitignored). `ant` is what the daemon's console-profile broker
 * (P10a-4, `packages/core/src/auth/console-profile-broker.ts`, Lane O) shells out to for
 * `ant auth print-credentials` — Winter never implements OAuth token refresh itself.
 *
 * L1's licence finding (github.com/anthropics/anthropic-cli): MIT ("Permission is hereby granted
 * ... to deal in the Software without restriction, including ... distribute ... copies") —
 * verified via `gh api repos/anthropics/anthropic-cli` (`license.key === "mit"`) AND the repo's own
 * LICENSE file (`gh api repos/anthropics/anthropic-cli/license`, base64-decoded), both fetched
 * 2026-09-13. Redistribution inside Winter.app is permitted — P10a-5's "bundle" ruling stands.
 *
 * Usage: bun run scripts/fetch-ant.ts
 *
 * The pin lives in the repo-root VERSIONS.json's `ant` entry (`{ tag, asset, sha256, binarySha256 }`,
 * both hashes git-committed, real values — never floated to "latest"; bumping either is a
 * deliberate edit there). This script:
 *   1. reads + validates that pin (`parseAntPin`),
 *   2. downloads the named GitHub release asset (a `.zip` — Anthropic's own darwin-arm64 archive
 *      also bundles shell completions + a man page alongside the `ant` binary) with a hard byte cap
 *      (`MAX_DOWNLOAD_BYTES`) enforced against both a declared `Content-Length` and the actual
 *      streamed byte count — a compromised/misconfigured host serving something enormous is
 *      refused before it is ever fully buffered into memory,
 *   3. hashes the RAW DOWNLOADED BYTES (before any extraction) and REFUSES on a sha256 mismatch
 *      against `pin.sha256` — never extracts unverified bytes, mirroring `scripts/fetch-cef.ts`'s
 *      "verify before extract" shape,
 *   4. extracts just the `ant` entry (`unzip -j`, present on every macOS dev/CI machine this repo
 *      targets — no new dependency), refusing if the extracted entry is a symlink (never a plain
 *      regular file) rather than trusting the archive's own claimed type,
 *   5. hashes the EXTRACTED BINARY and REFUSES on a mismatch against `pin.binarySha256` — a zip's
 *      sha256 and its extracted content's sha256 are necessarily different digests, so this is a
 *      SECOND, independent verification, not a restatement of step 3, and
 *   6. copies it to `<outDir>/ant`, chmod 755.
 *
 * Measured 2026-09-13 (L1): tag v1.32.0, asset `ant_1.32.0_macos_arm64.zip` (9,209,262 bytes),
 * asset sha256 f542fc99af185b197458e4b672f77fe91fe610b436acb9675b6839ce3f02bfeb — corroborated
 * three ways: the GitHub release asset's own `digest` field, the release's published
 * `ant_1.32.0_checksums.txt`, and a local `shasum -a 256` of the actual download. The EXTRACTED
 * `ant` binary's own sha256 is 89a972752b2dc2d80c93a3ce5e4a9e304acf720e5853c76e94836dab510cef5b
 * (a local `shasum -a 256` of the unzipped file — a necessarily different digest than the zip's own,
 * since a zip and its decompressed contents never hash the same). The extracted `ant` binary itself
 * is a thin arm64 Mach-O, Developer-ID-signed by TeamIdentifier=Q6L2SF6YDW (Anthropic PBC — the
 * same team that signs the embedded `claude` binary, P8d-2).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./version-lib";

export const VERSIONS_JSON_PATH = join(ROOT, "VERSIONS.json");
export const VENDOR_ANT_ROOT = join(ROOT, "vendor", "ant");
/** GitHub's own release-asset download URL shape: `.../releases/download/<tag>/<asset>`. */
export const GITHUB_ANT_RELEASE_BASE_URL = "https://github.com/anthropics/anthropic-cli/releases/download";

/** Fix round 1, item 3: the real asset is ~9.2MB; 64MiB is generous headroom for a future ant
 *  release growing (more platform tooling, a bigger man page, etc.) while still refusing a wildly
 *  oversized or malicious response LONG before it is fully buffered into memory. */
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

export interface AntPin {
  tag: string;
  asset: string;
  /** sha256 of the DOWNLOADED ASSET (the `.zip`), verified BEFORE extraction. */
  sha256: string;
  /** sha256 of the EXTRACTED `ant` BINARY itself — a different digest than `sha256` above (a zip
   *  and its decompressed contents never hash the same) — verified AFTER extraction, and what
   *  `release-lib.ts`'s `verifyAntEmbed` re-checks the vendored/embedded file against at release
   *  time, without ever needing to re-download or re-extract. */
  binarySha256: string;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

/** Parses and validates the repo-root VERSIONS.json's `ant` entry. Throws (never coerces) on a
 *  missing file, bad JSON, a missing/blank field, or a malformed checksum — an unpinned or
 *  half-pinned `ant` must never resolve to "just fetch whatever". */
export function parseAntPin(versionsJsonText: string): AntPin {
  let raw: unknown;
  try {
    raw = JSON.parse(versionsJsonText);
  } catch (err) {
    throw new Error(`VERSIONS.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof raw !== "object" || raw === null) throw new Error("VERSIONS.json: expected an object");
  const antRaw = (raw as Record<string, unknown>).ant;
  if (typeof antRaw !== "object" || antRaw === null) throw new Error("VERSIONS.json: missing 'ant' entry");
  const a = antRaw as Record<string, unknown>;
  const str = (k: string): string => {
    const v = a[k];
    if (typeof v !== "string" || v.length === 0) throw new Error(`VERSIONS.json: ant.${k} must be a non-empty string`);
    return v;
  };
  const sha = (k: string): string => {
    const v = str(k);
    if (!SHA256_RE.test(v)) throw new Error(`VERSIONS.json: ant.${k} must be lowercase sha256 hex`);
    return v;
  };
  return { tag: str("tag"), asset: str("asset"), sha256: sha("sha256"), binarySha256: sha("binarySha256") };
}

/** `<baseUrl>/<tag>/<asset>` — GitHub's own shape for the real default; a test loopback server
 *  implements the same join so the client code under test never branches on which host it's
 *  talking to. */
export function antAssetUrl(pin: AntPin, baseUrl: string): string {
  return `${baseUrl}/${encodeURIComponent(pin.tag)}/${encodeURIComponent(pin.asset)}`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The typed refusal — a downloaded asset or extracted binary whose bytes do not match the
 *  relevant pin. `stage` names WHICH of the two independent checks failed (never conflated in one
 *  message — a zip-level mismatch and a binary-level mismatch point at very different problems). */
export class AntChecksumMismatch extends Error {
  readonly code = "ant_checksum_mismatch" as const;
  constructor(
    readonly stage: "asset" | "binary",
    readonly url: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `fetch-ant: ${stage === "asset" ? "downloaded asset" : "extracted binary"} checksum mismatch (refusing to ${stage === "asset" ? "extract" : "vendor"})\n` +
        `  url: ${url}\n  expected sha256 (VERSIONS.json pin ant.${stage === "asset" ? "sha256" : "binarySha256"}): ${expected}\n` +
        `  actual sha256:                                                        ${actual}`,
    );
    this.name = "AntChecksumMismatch";
  }
}

/** Fix round 1, item 3: enforced against a declared `Content-Length` up front (when the server
 *  sends one) AND against the actual streamed byte count as it arrives — a response lying about
 *  its own length (or sending none at all) is caught by the second check regardless. Refuses
 *  before the oversized response is ever fully buffered into memory. */
export class AntDownloadTooLarge extends Error {
  readonly code = "ant_download_too_large" as const;
  constructor(
    readonly url: string,
    readonly limit: number,
    readonly detail: string,
  ) {
    super(`fetch-ant: refusing to download ${url} — ${detail} (limit ${limit} bytes)`);
    this.name = "AntDownloadTooLarge";
  }
}

/**
 * Fix round 1, item 3's fast-path check, pulled out as its own pure function so it is directly
 * unit-testable: a real HTTP round trip (Bun.serve's `Response`) always recomputes `Content-Length`
 * from the ACTUAL bytes it sends, which means a server that LIES about a huge declared length while
 * streaming few real bytes cannot be simulated end-to-end through a loopback server — the streamed-
 * byte-count check in `downloadCapped` below is what catches that shape for real (its own test
 * sends a genuinely oversized body with NO length header). This function is what a well-behaved
 * server's honest, oversized `Content-Length` gets checked against, BEFORE a single body byte is
 * read. Throws `AntDownloadTooLarge`; does nothing on a missing, unparseable, or in-bounds header.
 */
export function checkDeclaredContentLength(url: string, declaredLength: string | null): void {
  if (declaredLength === null) return;
  const n = Number(declaredLength);
  if (Number.isFinite(n) && n > MAX_DOWNLOAD_BYTES) {
    throw new AntDownloadTooLarge(url, MAX_DOWNLOAD_BYTES, `declared Content-Length ${n} exceeds the limit`);
  }
}

/** Downloads `url` via `fetchImpl`, enforcing `MAX_DOWNLOAD_BYTES` two ways: a declared
 *  `Content-Length` over the cap is refused immediately via `checkDeclaredContentLength` (no body
 *  read at all), and the actual streamed bytes are counted chunk-by-chunk and refused the moment
 *  the running total exceeds the cap — never after buffering the whole (potentially huge) body
 *  first. Falls back to a single `arrayBuffer()` read only when the response carries no readable
 *  stream (never expected from a real `fetch`, but keeps this honest about what it actually
 *  guarantees on an exotic `fetchImpl`).
 */
async function downloadCapped(url: string, fetchImpl: typeof fetch): Promise<Uint8Array> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`fetch-ant: GET ${url} -> HTTP ${res.status}`);

  checkDeclaredContentLength(url, res.headers.get("content-length"));

  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new AntDownloadTooLarge(url, MAX_DOWNLOAD_BYTES, `downloaded ${buf.byteLength} bytes exceeds the limit`);
    }
    return buf;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_DOWNLOAD_BYTES) {
      await reader.cancel().catch(() => {});
      throw new AntDownloadTooLarge(url, MAX_DOWNLOAD_BYTES, `streamed ${total} bytes exceeds the limit`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** The default extractor: `unzip -o -j <zip> ant -d <destDir>` — junks the archive's internal
 *  paths (`-j`) so only the `ant` binary itself lands in `destDir`, ignoring the completions/man
 *  page the real asset also bundles. Injectable so tests never need a real `unzip` on the fake
 *  server's response bytes — most tests exercise the mismatch-refusal path, which never reaches
 *  this at all. */
export function extractAntFromZipReal(zipPath: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  execFileSync("unzip", ["-o", "-j", zipPath, "ant", "-d", destDir], { stdio: "pipe" });
}

/** The typed refusal — the extracted `ant` entry is a symlink rather than a plain regular file.
 *  `lstatSync` (never `statSync`, which follows the link) is what makes this check meaningful:
 *  a symlink inside the archive could point anywhere on the extracting machine, and this repo's
 *  chmod-755-and-embed pipeline must never blindly follow one. */
export class AntEntryIsSymlink extends Error {
  readonly code = "ant_entry_is_symlink" as const;
  constructor(readonly path: string) {
    super(`fetch-ant: extracted "ant" entry at ${path} is a symlink, not a regular file — refusing to vendor it`);
    this.name = "AntEntryIsSymlink";
  }
}

export interface FetchAntOpts {
  pin: AntPin;
  /** Final destination directory — the extracted binary lands at `<outDir>/ant`. */
  outDir: string;
  /** Defaults to the real GitHub release-download base; a test points this at a loopback server. */
  baseUrl?: string;
  /** Test seam for the network call; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam for extraction; defaults to `extractAntFromZipReal`. */
  extractAntFromZip?: (zipPath: string, destDir: string) => void;
}

export interface FetchAntResult {
  path: string;
  /** sha256 of the DOWNLOADED ASSET (the .zip) — matches `pin.sha256`. */
  sha256: string;
  /** sha256 of the EXTRACTED BINARY itself — matches `pin.binarySha256`. */
  binarySha256: string;
}

/**
 * Downloads the pinned asset (size-capped — see `downloadCapped`/`MAX_DOWNLOAD_BYTES`), verifies
 * its sha256 BEFORE touching disk with anything but the already-hashed bytes, extracts the `ant`
 * binary (refusing a symlink entry), verifies the EXTRACTED BINARY's own sha256 against the pin's
 * `binarySha256`, and chmod 755s it at `<outDir>/ant`. Either checksum mismatch throws
 * `AntChecksumMismatch` and never writes `outDir` at all — refusing on a mismatch means nothing
 * downstream ever sees unverified bytes.
 */
export async function fetchAnt(opts: FetchAntOpts): Promise<FetchAntResult> {
  const baseUrl = opts.baseUrl ?? GITHUB_ANT_RELEASE_BASE_URL;
  const url = antAssetUrl(opts.pin, baseUrl);
  const fetchImpl = opts.fetchImpl ?? fetch;

  const bytes = await downloadCapped(url, fetchImpl);

  const actualAssetSha256 = sha256Hex(bytes);
  if (actualAssetSha256 !== opts.pin.sha256) throw new AntChecksumMismatch("asset", url, opts.pin.sha256, actualAssetSha256);

  const tmp = mkdtempSync(join(tmpdir(), "winter-fetch-ant-"));
  try {
    const zipPath = join(tmp, opts.pin.asset);
    writeFileSync(zipPath, bytes);
    const extract = opts.extractAntFromZip ?? extractAntFromZipReal;
    const extractDir = join(tmp, "extracted");
    extract(zipPath, extractDir);
    const extractedBin = join(extractDir, "ant");
    if (!existsSync(extractedBin)) {
      throw new Error(`fetch-ant: extraction did not produce an "ant" binary at ${extractedBin}`);
    }
    // Fix round 1, item 4: lstat (never stat, which follows the link) — refuse a symlink entry
    // outright rather than trusting the archive's own claimed type.
    if (!lstatSync(extractedBin).isFile()) {
      throw new AntEntryIsSymlink(extractedBin);
    }
    const binaryBytes = readFileSync(extractedBin);
    const actualBinarySha256 = sha256Hex(binaryBytes);
    if (actualBinarySha256 !== opts.pin.binarySha256) {
      throw new AntChecksumMismatch("binary", url, opts.pin.binarySha256, actualBinarySha256);
    }
    mkdirSync(opts.outDir, { recursive: true });
    const finalPath = join(opts.outDir, "ant");
    writeFileSync(finalPath, binaryBytes);
    chmodSync(finalPath, 0o755);
    return { path: finalPath, sha256: actualAssetSha256, binarySha256: actualBinarySha256 };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const pin = parseAntPin(readFileSync(VERSIONS_JSON_PATH, "utf8"));
  const outDir = join(VENDOR_ANT_ROOT, pin.tag);
  console.log(`fetch-ant: fetching ${pin.asset} @ ${pin.tag} -> ${outDir}/ant`);
  fetchAnt({ pin, outDir }).then(
    (result) => console.log(`fetch-ant: OK — asset sha256 ${result.sha256} verified, binary sha256 ${result.binarySha256} verified, wrote ${result.path}`),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
