import { describe, expect, test } from "bun:test";
import { buildAssetUrl, isValidSha256Hex, parseStampJson, stampSatisfies } from "./fetch-libreoffice-lib";

const PIN = {
  tag: "vendor-libreoffice-20260818",
  assetName: "libreoffice-headless-macos-arm64-11482c8f.tar.zst",
  sha256: "cf7f29e2babc53d4b772fefae1a00ffe7c9db984cacc79a6aa1287f9a5fd34af",
};

describe("stampSatisfies", () => {
  test("true when tag, assetName, and sha256 all match", () => {
    expect(stampSatisfies({ ...PIN, fetchedAt: "2026-08-18T00:00:00.000Z" }, PIN)).toBe(true);
  });

  test("false when sha256 differs -- a swapped or corrupted asset must force a re-fetch", () => {
    const stamp = { ...PIN, sha256: "0".repeat(64), fetchedAt: "2026-08-18T00:00:00.000Z" };
    expect(stampSatisfies(stamp, PIN)).toBe(false);
  });

  test("false when tag differs -- a version bump not yet re-pinned must force a re-fetch", () => {
    const stamp = { ...PIN, tag: "vendor-libreoffice-99999999", fetchedAt: "2026-08-18T00:00:00.000Z" };
    expect(stampSatisfies(stamp, PIN)).toBe(false);
  });

  test("false when assetName differs", () => {
    const stamp = { ...PIN, assetName: "something-else.tar.zst", fetchedAt: "2026-08-18T00:00:00.000Z" };
    expect(stampSatisfies(stamp, PIN)).toBe(false);
  });

  test("false for a null or undefined stamp (no prior fetch)", () => {
    expect(stampSatisfies(null, PIN)).toBe(false);
    expect(stampSatisfies(undefined, PIN)).toBe(false);
  });
});

describe("parseStampJson", () => {
  test("parses a well-formed stamp", () => {
    const raw = JSON.stringify({ ...PIN, fetchedAt: "2026-08-18T00:00:00.000Z" });
    expect(parseStampJson(raw)).toEqual({ ...PIN, fetchedAt: "2026-08-18T00:00:00.000Z" });
  });

  test("returns null for invalid JSON rather than throwing", () => {
    expect(parseStampJson("{not json")).toBeNull();
  });

  test("returns null for valid JSON that isn't an object", () => {
    expect(parseStampJson("42")).toBeNull();
    expect(parseStampJson("null")).toBeNull();
    expect(parseStampJson('"a string"')).toBeNull();
  });

  test("returns null when a required field is missing", () => {
    expect(parseStampJson(JSON.stringify({ tag: PIN.tag, assetName: PIN.assetName }))).toBeNull();
  });

  test("returns null when a field has the wrong type", () => {
    const raw = JSON.stringify({ ...PIN, fetchedAt: "2026-08-18T00:00:00.000Z", sha256: 12345 });
    expect(parseStampJson(raw)).toBeNull();
  });
});

describe("buildAssetUrl", () => {
  test("builds the exact GitHub release-asset download URL", () => {
    expect(buildAssetUrl({ repo: "yanlingLabs/norma", tag: PIN.tag, assetName: PIN.assetName })).toBe(
      `https://github.com/yanlingLabs/norma/releases/download/${PIN.tag}/${PIN.assetName}`,
    );
  });
});

describe("isValidSha256Hex", () => {
  test("accepts a 64-char lowercase hex string", () => {
    expect(isValidSha256Hex(PIN.sha256)).toBe(true);
  });

  test("rejects uppercase hex (a hand-transcription slip)", () => {
    expect(isValidSha256Hex(PIN.sha256.toUpperCase())).toBe(false);
  });

  test("rejects the wrong length", () => {
    expect(isValidSha256Hex(PIN.sha256.slice(0, 63))).toBe(false);
    expect(isValidSha256Hex(PIN.sha256 + "0")).toBe(false);
  });

  test("rejects non-hex characters", () => {
    expect(isValidSha256Hex("g".repeat(64))).toBe(false);
  });
});
