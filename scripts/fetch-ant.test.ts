// Winter Phase 10a (Task L2) — fetch-ant.ts's own unit tests. Network I/O is a loopback fake
// server (127.0.0.1:0, Bun.serve) serving a REAL, small zip archive built with the system `zip`
// CLI — the same tool `extractAntFromZipReal`'s `unzip` counterpart decompresses in production —
// so the happy path exercises real extraction, never a mocked one. Never touches the real
// vendor/ant/ tree or the real repo-root VERSIONS.json: every test writes to its own mkdtemp dir.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  AntChecksumMismatch,
  antAssetUrl,
  extractAntFromZipReal,
  fetchAnt,
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
 *  the named entry either way). Returns the zip's bytes and its sha256. */
function buildFixtureZip(antContent: string): { bytes: Uint8Array; sha256: string } {
  const dir = mkdtempSync(join(tmpdir(), "fetch-ant-fixture-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "ant"), antContent);
  const zipPath = join(dir, "fixture.zip");
  execFileSync("zip", ["-j", zipPath, join(dir, "ant")], { stdio: "pipe" });
  const bytes = new Uint8Array(readFileSync(zipPath));
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

const TAG = "v1.32.0";
const ASSET = "ant_1.32.0_macos_arm64.zip";

describe("parseAntPin", () => {
  test("accepts a well-formed VERSIONS.json ant entry", () => {
    const pin = parseAntPin(JSON.stringify({ ant: { tag: TAG, asset: ASSET, sha256: "a".repeat(64) } }));
    expect(pin).toEqual({ tag: TAG, asset: ASSET, sha256: "a".repeat(64) });
  });
  test("refuses invalid JSON", () => {
    expect(() => parseAntPin("{")).toThrow(/valid JSON/);
  });
  test("refuses a missing 'ant' entry", () => {
    expect(() => parseAntPin(JSON.stringify({}))).toThrow(/missing 'ant' entry/);
  });
  test("refuses a missing/blank field", () => {
    expect(() => parseAntPin(JSON.stringify({ ant: { tag: TAG, asset: "", sha256: "a".repeat(64) } }))).toThrow(/ant\.asset/);
    expect(() => parseAntPin(JSON.stringify({ ant: { tag: TAG, sha256: "a".repeat(64) } }))).toThrow(/ant\.asset/);
  });
  test("refuses a malformed sha256", () => {
    expect(() => parseAntPin(JSON.stringify({ ant: { tag: TAG, asset: ASSET, sha256: "nope" } }))).toThrow(/sha256 hex/);
    expect(() => parseAntPin(JSON.stringify({ ant: { tag: TAG, asset: ASSET, sha256: "A".repeat(64) } }))).toThrow(/sha256 hex/);
  });
});

describe("antAssetUrl", () => {
  test("joins baseUrl/tag/asset, URL-encoded", () => {
    expect(antAssetUrl({ tag: "v1.0.0", asset: "a b.zip", sha256: "x" }, "http://example.test")).toBe(
      "http://example.test/v1.0.0/a%20b.zip",
    );
  });
});

describe("fetchAnt (loopback fake server)", () => {
  test("happy path: downloads, verifies sha256, extracts the real zip, chmod 755s the result", async () => {
    const { bytes, sha256 } = buildFixtureZip("#!/bin/sh\necho fixture-ant\n");
    const pin: AntPin = { tag: TAG, asset: ASSET, sha256 };
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
    expect(result.path).toBe(join(outDir, "ant"));
    expect(readFileSync(result.path, "utf8")).toBe("#!/bin/sh\necho fixture-ant\n");
    // chmod 755
    const mode = statSync(result.path).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  test("wrong-digest refusal: a checksum mismatch throws AntChecksumMismatch, extraction never runs, outDir untouched", async () => {
    const { bytes } = buildFixtureZip("#!/bin/sh\necho should-never-land\n");
    const pin: AntPin = { tag: TAG, asset: ASSET, sha256: "0".repeat(64) }; // deliberately wrong
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

    await expect(
      fetchAnt({
        pin,
        outDir,
        baseUrl: `http://127.0.0.1:${server.port}`,
        extractAntFromZip: () => {
          extractCalled = true;
        },
      }),
    ).rejects.toBeInstanceOf(AntChecksumMismatch);

    expect(extractCalled).toBe(false);
    expect(() => readFileSync(join(outDir, "ant"))).toThrow();
  });

  test("AntChecksumMismatch names both the expected and actual digests", async () => {
    const { bytes, sha256: actual } = buildFixtureZip("x");
    const pin: AntPin = { tag: TAG, asset: ASSET, sha256: "f".repeat(64) };
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
    const pin: AntPin = { tag: TAG, asset: ASSET, sha256: "a".repeat(64) };
    await expect(fetchAnt({ pin, outDir, baseUrl: `http://127.0.0.1:${server.port}` })).rejects.toThrow(/HTTP 404/);
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
