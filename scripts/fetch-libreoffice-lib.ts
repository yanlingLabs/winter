/**
 * Pure, side-effect-free helpers for scripts/fetch-libreoffice.ts, split out so they're
 * `bun test`-able without triggering the parent script's top-level network/filesystem work on
 * import (mirrors this repo's scripts/release-lib.ts + scripts/release-lib.test.ts split, and
 * scripts/version-lib.ts's exported-pure-functions shape more generally).
 */

/** What `.vendored-version` records after a successful fetch. */
export interface Stamp {
  tag: string;
  assetName: string;
  sha256: string;
  fetchedAt: string;
}

/** The exact fields a stamp must match for a re-run to skip re-fetching (network-free check). */
export interface ExpectedPin {
  tag: string;
  assetName: string;
  sha256: string;
}

/**
 * True iff `stamp` was produced by a previous run that fetched exactly the pin `expected`
 * describes. Deliberately does NOT touch the filesystem — callers separately confirm the
 * marker paths (product-set/Frameworks/libmergedlo.dylib etc.) are actually still on disk
 * before trusting this; a stamp alone is not proof the tree wasn't partially deleted since.
 */
export function stampSatisfies(stamp: Stamp | null | undefined, expected: ExpectedPin): boolean {
  if (!stamp) return false;
  return stamp.tag === expected.tag && stamp.assetName === expected.assetName && stamp.sha256 === expected.sha256;
}

/**
 * Safe JSON parse for the stamp file: returns null (never throws) for invalid JSON, a
 * non-object, or an object missing any required string field -- any of which mean "treat this
 * as no stamp, re-fetch," the same way a missing file does.
 */
export function parseStampJson(raw: string): Stamp | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.tag !== "string" ||
    typeof obj.assetName !== "string" ||
    typeof obj.sha256 !== "string" ||
    typeof obj.fetchedAt !== "string"
  ) {
    return null;
  }
  return { tag: obj.tag, assetName: obj.assetName, sha256: obj.sha256, fetchedAt: obj.fetchedAt };
}

/** The download URL for a GitHub release asset -- one string builder, so the format is pinned once. */
export function buildAssetUrl(opts: { repo: string; tag: string; assetName: string }): string {
  return `https://github.com/${opts.repo}/releases/download/${opts.tag}/${opts.assetName}`;
}

/**
 * A downloaded/computed sha256 must be a 64-char lowercase hex string. `shasum`/Node's
 * createHash both already produce lowercase hex, but a pinned constant in source is
 * hand-transcribed -- this catches a stray uppercase letter or truncated copy-paste at the
 * point of comparison rather than failing the compare silently.
 */
export function isValidSha256Hex(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}
