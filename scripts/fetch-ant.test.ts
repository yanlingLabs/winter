// Winter Phase 10a (Task L2, fix round 1) — fetch-ant.ts's own unit tests. Network I/O is a
// loopback fake server (127.0.0.1:0, Bun.serve) serving a REAL, small zip archive built with the
// system `zip` CLI — the same tool `extractAntFromZipReal`'s `unzip` counterpart decompresses in
// production — so the happy path exercises real extraction, never a mocked one. Never touches the
// real vendor/ant/ tree or the real repo-root VERSIONS.json: every test writes to its own mkdtemp
// dir and builds its own pin.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  AntChecksumMismatch,
  AntDownloadTooLarge,
  AntEntryIsSymlink,
  antAssetUrl,
  checkDeclaredContentLength,
  extractAntFromZipReal,
  fetchAnt,
  MAX_DOWNLOAD_BYTES,
  parseAntPin,
  sha256Hex,
  type AntPin,
} from "./fetch-ant";

let server: ReturnType<typeof Bun.serve> | null = null;
const cleanups: Array<() => void> = [];
afterEach(() => {
  server?.stop(true);
  server = null;
  while (cleanups.length > 0) cleanups.pop()!();
});

/** Builds a real zip (via the system `zip` CLI, same family as production's `unzip`) whose only
 *  entry is `ant` with the given content — mirrors the real asset's shape closely enough for the
 *  extractor (it also carries completions/a man page in production; `-j` ignores anything besides
 *  the named entry either way). Returns the zip's bytes, the zip's own sha256, and the sha256 of
 *  the extracted content (a distinct digest — a zip and its decompressed contents never hash the
 *  same), i.e. a ready-to-use `AntPin`'s `{ sha256, binarySha256 }` pair. */
function buildFixtureZip(antContent: string): { bytes: Uint8Array; sha256: string; binarySha256: string } {
  const dir = mkdtempSync(join(tmpdir(), "fetch-ant-fixture-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "ant"), antContent);
  const zipPath = join(dir, "fixture.zip");
  execFileSync("zip", ["-j", zipPath, join(dir, "ant")], { stdio: "pipe" });
  const bytes = new Uint8Array(readFileSync(zipPath));
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    binarySha256: createHash("sha256").update(antContent).digest("hex"),
  };
}

const TAG = "v1.32.0";
const ASSET = "ant_1.32.0_macos_arm64.zip";

describe("parseAntPin", () => {
  test("accepts a well-formed VERSIONS.json ant entry", () => {
    const pin = parseAntPin(JSON.stringify({ ant: { tag: TAG, asset: ASSET, sha256: "a".repeat(64), binarySha256: "b".repeat(64) } }));
    expect(pin).toEqual({ tag: TAG, asset: ASSET, sha256: "a".repeat(64), binarySha256: "b".repeat(64) });
  });
  test("refuses invalid JSON", () => {
    expect(() => parseAntPin("{")).toThrow(/valid JSON/);
  });
  test("refuses a missing 'ant' entry", () => {
    expect(() => parseAntPin(JSON.stringify({}))).toThrow(/missing 'ant' entry/);
  });
  test("refuses a missing/blank field", () => {
    expect(() => parseAntPin(JSON.stringify({ ant: { tag: TAG, asset: "", sha256: "a".repeat(64), binarySha256: "b".repeat(64) } }))).toThrow(/ant\.asset/);
    expect(() => parseAntPin(JSON.stringify({ ant: { tag: TAG, sha256: "a".repeat(64), binarySha256: "b".repeat(64) } }))).toThrow(/ant\.asset/);
    expect(() => parseAntPin(JSON.stringify({ ant: { tag: TAG, asset: ASSET, sha256: "a".repeat(64) } }))).toThrow(/ant\.binarySha256/);
  });
  test("refuses a malformed sha256 or binarySha256", () => {
    expect(() => parseAntPin(JSON.stringify({ ant: { tag: TAG, asset: ASSET, sha256: "nope", binarySha256: "b".repeat(64) } }))).toThrow(/sha256 hex/);
    expect(() => parseAntPin(JSON.stringify({ ant: { tag: TAG, asset: ASSET, sha256: "A".repeat(64), binarySha256: "b".repeat(64) } }))).toThrow(/sha256 hex/);
    expect(() => parseAntPin(JSON.stringify({ ant: { tag: TAG, asset: ASSET, sha256: "a".repeat(64), binarySha256: "nope" } }))).toThrow(/binarySha256 must be lowercase sha256 hex/);
  });
});

describe("antAssetUrl", () => {
  test("joins baseUrl/tag/asset, URL-encoded", () => {
    expect(antAssetUrl({ tag: "v1.0.0", asset: "a b.zip", sha256: "x", binarySha256: "y" }, "http://example.test")).toBe(
      "http://example.test/v1.0.0/a%20b.zip",
    );
  });
});

describe("fetchAnt (loopback fake server)", () => {
  test("happy path: downloads, verifies BOTH digests, extracts the real zip, chmod 755s the result", async () => {
    const { bytes, sha256, binarySha256 } = buildFixtureZip("#!/bin/sh\necho fixture-ant\n");
    const pin: AntPin = { tag: TAG, asset: ASSET, sha256, binarySha256 };
    let requestedPath: string | undefined;
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        requestedPath = new URL(req.url).pathname;
        return new Response(bytes, { status: 200 });
      },
    });
    const outDir = mkdtempSync(join(tmpdir(), "fetch-ant-out-"));
    cleanups.push(() => rmSync(outDir, { recursive: true, force: true }));

    const result = await fetchAnt({ pin, outDir, baseUrl: `http://127.0.0.1:${server.port}` });

    expect(requestedPath).toBe(`/${pin.tag}/${pin.asset}`);
    expect(result.sha256).toBe(sha256);
    expect(result.binarySha256).toBe(binarySha256);
    expect(result.binarySha256).not.toBe(result.sha256); // zip vs. extracted content never match
    expect(result.path).toBe(join(outDir, "ant"));
    expect(readFileSync(result.path, "utf8")).toBe("#!/bin/sh\necho fixture-ant\n");
    // chmod 755
    const mode = statSync(result.path).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  test("asset-level wrong-digest refusal: a zip checksum mismatch throws AntChecksumMismatch(stage='asset'), extraction never runs, outDir untouched", async () => {
    const { bytes, binarySha256 } = buildFixtureZip("#!/bin/sh\necho should-never-land\n");
    const pin: AntPin = { tag: TAG, asset: ASSET, sha256: "0".repeat(64), binarySha256 }; // asset sha256 deliberately wrong
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(bytes, { status: 200 });
      },
    });
    const outDir = mkdtempSync(join(tmpdir(), "fetch-ant-out-"));
    cleanups.push(() => rmSync(outDir, { recursive: true, force: true }));
    let extractCalled = false;

    let caught: unknown;
    try {
      await fetchAnt({
        pin,
        outDir,
        baseUrl: `http://127.0.0.1:${server.port}`,
        extractAntFromZip: () => {
          extractCalled = true;
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AntChecksumMismatch);
    if (caught instanceof AntChecksumMismatch) expect(caught.stage).toBe("asset");
    expect(extractCalled).toBe(false);
    expect(() => readFileSync(join(outDir, "ant"))).toThrow();
  });

  test("binary-level wrong-digest refusal: the ZIP verifies fine but the EXTRACTED binary mismatches binarySha256 — outDir stays untouched", async () => {
    const { bytes, sha256 } = buildFixtureZip("#!/bin/sh\necho should-never-land\n");
    const pin: AntPin = { tag: TAG, asset: ASSET, sha256, binarySha256: "f".repeat(64) }; // binarySha256 deliberately wrong
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(bytes, { status: 200 }) });
    const outDir = mkdtempSync(join(tmpdir(), "fetch-ant-out-"));
    cleanups.push(() => rmSync(outDir, { recursive: true, force: true }));

    let caught: unknown;
    try {
      await fetchAnt({ pin, outDir, baseUrl: `http://127.0.0.1:${server.port}` });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AntChecksumMismatch);
    if (caught instanceof AntChecksumMismatch) {
      expect(caught.stage).toBe("binary");
      expect(caught.expected).toBe("f".repeat(64));
    }
    expect(() => readFileSync(join(outDir, "ant"))).toThrow();
  });

  test("AntChecksumMismatch names both the expected and actual digests", async () => {
    const { bytes, sha256: actual, binarySha256 } = buildFixtureZip("x");
    const pin: AntPin = { tag: TAG, asset: ASSET, sha256: "f".repeat(64), binarySha256 };
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(bytes) });
    const outDir = mkdtempSync(join(tmpdir(), "fetch-ant-out-"));
    cleanups.push(() => rmSync(outDir, { recursive: true, force: true }));

    try {
      await fetchAnt({ pin, outDir, baseUrl: `http://127.0.0.1:${server.port}` });
      throw new Error("expected fetchAnt to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(AntChecksumMismatch);
      if (err instanceof AntChecksumMismatch) {
        expect(err.expected).toBe("f".repeat(64));
        expect(err.actual).toBe(actual);
        expect(err.code).toBe("ant_checksum_mismatch");
      }
    }
  });

  test("a non-2xx response is a plain, named failure — never a silent empty extraction", async () => {
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("nope", { status: 404 }) });
    const outDir = mkdtempSync(join(tmpdir(), "fetch-ant-out-"));
    cleanups.push(() => rmSync(outDir, { recursive: true, force: true }));
    const pin: AntPin = { tag: TAG, asset: ASSET, sha256: "a".repeat(64), binarySha256: "b".repeat(64) };
    await expect(fetchAnt({ pin, outDir, baseUrl: `http://127.0.0.1:${server.port}` })).rejects.toThrow(/HTTP 404/);
  });

  // Fix round 1, item 3: the download cap. `checkDeclaredContentLength` is unit-tested directly,
  // below — Bun.serve's `Response` always recomputes `Content-Length` from the ACTUAL bytes it
  // sends (measured: a manually-set oversized header is silently corrected to the real, small
  // body's length), so a server that LIES about its declared length cannot be simulated through a
  // real loopback round trip; the end-to-end test here instead proves the OTHER half — a genuinely
  // oversized, unheadered body is still caught by the streamed-byte-count path.
  test("a response with NO Content-Length header that streams more than the cap is refused (the streamed-byte check)", async () => {
    const oversized = new Uint8Array(MAX_DOWNLOAD_BYTES + 1024);
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        // No content-length header at all — forces the streamed-byte-count path.
        return new Response(oversized, { status: 200 });
      },
    });
    const outDir = mkdtempSync(join(tmpdir(), "fetch-ant-out-"));
    cleanups.push(() => rmSync(outDir, { recursive: true, force: true }));
    const pin: AntPin = { tag: TAG, asset: ASSET, sha256: "a".repeat(64), binarySha256: "b".repeat(64) };

    await expect(fetchAnt({ pin, outDir, baseUrl: `http://127.0.0.1:${server.port}` })).rejects.toBeInstanceOf(AntDownloadTooLarge);
  }, 15_000);

  test("a response at/under the cap downloads fine (the cap does not clip legitimate downloads)", async () => {
    const { bytes, sha256, binarySha256 } = buildFixtureZip("#!/bin/sh\necho fine\n");
    expect(bytes.byteLength).toBeLessThan(MAX_DOWNLOAD_BYTES);
    const pin: AntPin = { tag: TAG, asset: ASSET, sha256, binarySha256 };
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(bytes, { status: 200, headers: { "content-length": String(bytes.byteLength) } }) });
    const outDir = mkdtempSync(join(tmpdir(), "fetch-ant-out-"));
    cleanups.push(() => rmSync(outDir, { recursive: true, force: true }));

    const result = await fetchAnt({ pin, outDir, baseUrl: `http://127.0.0.1:${server.port}` });
    expect(result.sha256).toBe(sha256);
  });

  // Fix round 1, item 4: refuse a symlinked extracted entry.
  test("an extracted 'ant' entry that is a symlink is refused (AntEntryIsSymlink), never followed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fetch-ant-symlink-fixture-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const realTarget = join(dir, "real-target");
    writeFileSync(realTarget, "not actually vendored\n");
    const zipPath = join(dir, "fixture.zip");
    execFileSync("zip", ["-j", zipPath, realTarget], { stdio: "pipe" }); // any valid zip; content irrelevant — extractor is stubbed below
    const bytes = new Uint8Array(readFileSync(zipPath));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const pin: AntPin = { tag: TAG, asset: ASSET, sha256, binarySha256: "b".repeat(64) };
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(bytes, { status: 200 }) });
    const outDir = mkdtempSync(join(tmpdir(), "fetch-ant-out-"));
    cleanups.push(() => rmSync(outDir, { recursive: true, force: true }));

    let caught: unknown;
    try {
      await fetchAnt({
        pin,
        outDir,
        baseUrl: `http://127.0.0.1:${server.port}`,
        // Simulate an extractor whose output entry is a symlink — real `unzip -j` on this repo's
        // trusted asset never produces one, but a future/compromised archive could.
        extractAntFromZip: (_zipPath, destDir) => {
          mkdirSync(destDir, { recursive: true });
          symlinkSync(realTarget, join(destDir, "ant"));
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AntEntryIsSymlink);
    expect(() => readFileSync(join(outDir, "ant"))).toThrow();
  });
});

describe("extractAntFromZipReal (real unzip, no network)", () => {
  test("extracts exactly the 'ant' entry, ignoring anything else in the archive", () => {
    const dir = mkdtempSync(join(tmpdir(), "fetch-ant-extract-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "ant"), "binary-content");
    writeFileSync(join(dir, "README.md"), "not the binary");
    const zipPath = join(dir, "fixture.zip");
    execFileSync("zip", ["-j", zipPath, join(dir, "ant"), join(dir, "README.md")], { stdio: "pipe" });
    const destDir = join(dir, "dest");
    extractAntFromZipReal(zipPath, destDir);
    expect(readFileSync(join(destDir, "ant"), "utf8")).toBe("binary-content");
    expect(() => readFileSync(join(destDir, "README.md"))).toThrow();
  });
});

describe("sha256Hex", () => {
  test("matches node's own crypto digest", () => {
    const bytes = new TextEncoder().encode("hello ant");
    expect(sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
  });
});

describe("checkDeclaredContentLength (fix round 1, item 3 — the declared-length fast path, unit-tested directly)", () => {
  test("a header over the cap throws AntDownloadTooLarge, naming the limit", () => {
    expect(() => checkDeclaredContentLength("http://x/y", String(MAX_DOWNLOAD_BYTES + 1))).toThrow(AntDownloadTooLarge);
    try {
      checkDeclaredContentLength("http://x/y", String(MAX_DOWNLOAD_BYTES + 1));
    } catch (err) {
      expect(err).toBeInstanceOf(AntDownloadTooLarge);
      if (err instanceof AntDownloadTooLarge) expect(err.limit).toBe(MAX_DOWNLOAD_BYTES);
    }
  });
  test("a header exactly at the cap does not throw", () => {
    expect(() => checkDeclaredContentLength("http://x/y", String(MAX_DOWNLOAD_BYTES))).not.toThrow();
  });
  test("a header under the cap does not throw", () => {
    expect(() => checkDeclaredContentLength("http://x/y", "1024")).not.toThrow();
  });
  test("no header (null) does not throw — the streamed-byte check is what covers this case", () => {
    expect(() => checkDeclaredContentLength("http://x/y", null)).not.toThrow();
  });
  test("an unparseable header does not throw here — never a false positive on odd server output", () => {
    expect(() => checkDeclaredContentLength("http://x/y", "not-a-number")).not.toThrow();
  });
});
