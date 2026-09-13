/**
 * Winter Phase 10a (Task L1/L2) — vendors Anthropic's Platform CLI `ant` (darwin-arm64) into
 * `vendor/ant/<tag>/ant` (gitignored). `ant` is what the daemon's console-profile broker
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
 * The pin lives in the repo-root VERSIONS.json's `ant` entry (`{ tag, asset, sha256 }`), never
 * floated to "latest" — bumping it is a deliberate edit there. This script:
 *   1. reads + validates that pin (`parseAntPin`),
 *   2. downloads the named GitHub release asset (a `.zip` — Anthropic's own darwin-arm64 archive
 *      also bundles shell completions + a man page alongside the `ant` binary),
 *   3. hashes the RAW DOWNLOADED BYTES (before any extraction) and REFUSES on a sha256 mismatch —
 *      never extracts unverified bytes, mirroring `scripts/fetch-cef.ts`'s "verify before extract"
 *      shape,
 *   4. extracts just the `ant` entry (`unzip -j`, present on every macOS dev/CI machine this repo
 *      targets — no new dependency), and
 *   5. copies it to `<outDir>/ant`, chmod 755.
 *
 * Measured 2026-09-13 (L1): tag v1.32.0, asset `ant_1.32.0_macos_arm64.zip` (9,209,262 bytes),
 * sha256 f542fc99af185b197458e4b672f77fe91fe610b436acb9675b6839ce3f02bfeb — corroborated three ways:
 * the GitHub release asset's own `digest` field, the release's published `ant_1.32.0_checksums.txt`,
 * and a local `shasum -a 256` of the actual download. The extracted `ant` binary itself is a thin
 * arm64 Mach-O, Developer-ID-signed by TeamIdentifier=Q6L2SF6YDW (Anthropic PBC — the same team
 * that signs the embedded `claude` binary, P8d-2).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./version-lib";

export const VERSIONS_JSON_PATH = join(ROOT, "VERSIONS.json");
export const VENDOR_ANT_ROOT = join(ROOT, "vendor", "ant");
/** GitHub's own release-asset download URL shape: `.../releases/download/<tag>/<asset>`. */
export const GITHUB_ANT_RELEASE_BASE_URL = "https://github.com/anthropics/anthropic-cli/releases/download";

export interface AntPin {
  tag: string;
  asset: string;
  sha256: string;
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
  const sha256 = str("sha256");
  if (!SHA256_RE.test(sha256)) throw new Error("VERSIONS.json: ant.sha256 must be lowercase sha256 hex");
  return { tag: str("tag"), asset: str("asset"), sha256 };
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

/** The typed refusal — a downloaded asset whose bytes do not match the pin. Never extracted. */
export class AntChecksumMismatch extends Error {
  readonly code = "ant_checksum_mismatch" as const;
  constructor(
    readonly url: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `fetch-ant: downloaded asset checksum mismatch (refusing to extract)\n  url: ${url}\n` +
        `  expected sha256 (VERSIONS.json pin): ${expected}\n  actual sha256 (downloaded):           ${actual}`,
    );
    this.name = "AntChecksumMismatch";
  }
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
  sha256: string;
}

/**
 * Downloads the pinned asset, verifies its sha256 BEFORE touching disk with anything but the
 * already-hashed bytes, extracts the `ant` binary, and chmod 755s it at `<outDir>/ant`. A checksum
 * mismatch throws `AntChecksumMismatch` and never calls the extractor or writes `outDir` at all —
 * refusing on a mismatch means nothing downstream ever sees unverified bytes.
 */
export async function fetchAnt(opts: FetchAntOpts): Promise<FetchAntResult> {
  const baseUrl = opts.baseUrl ?? GITHUB_ANT_RELEASE_BASE_URL;
  const url = antAssetUrl(opts.pin, baseUrl);
  const fetchImpl = opts.fetchImpl ?? fetch;

  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`fetch-ant: GET ${url} -> HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  const actual = sha256Hex(bytes);
  if (actual !== opts.pin.sha256) throw new AntChecksumMismatch(url, opts.pin.sha256, actual);

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
    mkdirSync(opts.outDir, { recursive: true });
    const finalPath = join(opts.outDir, "ant");
    writeFileSync(finalPath, readFileSync(extractedBin));
    chmodSync(finalPath, 0o755);
    return { path: finalPath, sha256: actual };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const pin = parseAntPin(readFileSync(VERSIONS_JSON_PATH, "utf8"));
  const outDir = join(VENDOR_ANT_ROOT, pin.tag);
  console.log(`fetch-ant: fetching ${pin.asset} @ ${pin.tag} -> ${outDir}/ant`);
  fetchAnt({ pin, outDir }).then(
    (result) => console.log(`fetch-ant: OK — sha256 ${result.sha256} verified, wrote ${result.path}`),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
