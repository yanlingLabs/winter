// Winter Phase 8d (P8d-1..3) — `stage-runtimes.ts` with FAKE binaries in a mkdtemp dir. Never
// touches a real `winter`/`claude` build: `winterPath`/`claudeBinaryPath` bypass `buildWinter()`
// and `resolveInstalledClaudeBinary()` entirely, and `getClaudeVersion` bypasses spawning the
// (non-executable) fake `claude` file — the version step is injectable by design.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertMachOArm64, buildVersionsJson, parseClaudeVersionOutput, sha256File, stageRuntimes } from "./stage-runtimes";
import { parseVersionsJson } from "../packages/core/src/runtime-sdk/bundle-layout";
import { REQUIRED_CLAUDE_AGENT_SDK, REQUIRED_WINTER_AGENT_SDK, REQUIRED_WINTER_RUNTIME_SDK } from "../packages/core/src/runtime-sdk/versions";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

/** A minimal fixture matching the REAL packed `bin/winter`'s own first 8 bytes, measured directly
 *  off the local pack (magicLE=feedfacf, cputypeLE@4=100000c) — never a real 66MB binary. */
function fakeMachOArm64(): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
  header.writeUInt32LE(0x0100000c, 4); // CPU_TYPE_ARM64
  return Buffer.concat([header, Buffer.from("...rest of a real winter binary would follow...")]);
}

describe("parseClaudeVersionOutput (M1 shape)", () => {
  test("extracts the leading version token", () => {
    expect(parseClaudeVersionOutput("2.1.250 (Claude Code)\n")).toBe("2.1.250");
  });
  test("a bare version with no trailer still parses", () => {
    expect(parseClaudeVersionOutput("2.1.250")).toBe("2.1.250");
  });
  test("empty output throws rather than returning garbage", () => {
    expect(() => parseClaudeVersionOutput("   \n")).toThrow(/could not parse/);
  });
});

describe("buildVersionsJson (P8d-3)", () => {
  test("stamps this build's own pins, never a re-typed literal", () => {
    const v = buildVersionsJson({ claudeCode: "2.1.250", winterPreSignSha256: "a".repeat(64), claudeSha256: "b".repeat(64), now: new Date("2026-09-12T00:00:00Z") });
    expect(v).toEqual({
      schema: 1,
      winterAgentSdk: REQUIRED_WINTER_AGENT_SDK,
      winterRuntimeSdk: REQUIRED_WINTER_RUNTIME_SDK,
      officialSdk: REQUIRED_CLAUDE_AGENT_SDK,
      claudeCode: "2.1.250",
      checksums: { winterPreSign: "a".repeat(64), claude: "b".repeat(64) },
      stagedAt: "2026-09-12T00:00:00.000Z",
    });
  });
  test("round-trips through parseVersionsJson (the ladder's own gate) without throwing", () => {
    const v = buildVersionsJson({ claudeCode: "2.1.250", winterPreSignSha256: "a".repeat(64), claudeSha256: "b".repeat(64) });
    expect(parseVersionsJson(JSON.stringify(v))).toEqual(v);
  });
});

describe("stageRuntimes (fake binaries, mkdtemp — no real winter/claude build)", () => {
  test("writes the P8d-1 layout, byte-copies both binaries mode 0755, and VERSIONS.json parses clean", async () => {
    const srcDir = tempDir("stage-runtimes-src-");
    const winterSrc = join(srcDir, "winter-fake");
    const claudeSrc = join(srcDir, "claude-fake");
    writeFileSync(winterSrc, "fake winter binary bytes\n");
    writeFileSync(claudeSrc, "fake claude binary bytes\n");

    const out = tempDir("stage-runtimes-out-");
    const result = await stageRuntimes({
      out,
      winterPath: winterSrc,
      claudeBinaryPath: claudeSrc,
      getClaudeVersion: () => "2.1.250",
    });

    // Layout
    expect(result.winterPath).toBe(join(out, "winter"));
    expect(result.claudePath).toBe(join(out, "claude-official", "claude"));
    expect(result.versionsPath).toBe(join(out, "claude-official", "VERSIONS.json"));
    expect(existsSync(result.winterPath)).toBe(true);
    expect(existsSync(result.claudePath)).toBe(true);
    expect(existsSync(result.versionsPath)).toBe(true);

    // Byte-identical copies
    expect(readFileSync(result.winterPath, "utf8")).toBe("fake winter binary bytes\n");
    expect(readFileSync(result.claudePath, "utf8")).toBe("fake claude binary bytes\n");

    // mode 0755
    expect(statSync(result.winterPath).mode & 0o777).toBe(0o755);
    expect(statSync(result.claudePath).mode & 0o777).toBe(0o755);

    // VERSIONS.json: this build's pins, real checksums, and it parses through the ladder's own gate.
    expect(result.versions.claudeCode).toBe("2.1.250");
    expect(result.versions.checksums.winterPreSign).toBe(sha256File(result.winterPath));
    expect(result.versions.checksums.claude).toBe(sha256File(result.claudePath));
    const onDisk = JSON.parse(readFileSync(result.versionsPath, "utf8"));
    expect(onDisk).toEqual(result.versions);
    expect(parseVersionsJson(readFileSync(result.versionsPath, "utf8"))).toEqual(result.versions);
  });

  test("no claude binary resolvable (no path, no injected resolver hit) refuses with a clear message, never a silent skip", async () => {
    const srcDir = tempDir("stage-runtimes-src2-");
    const winterSrc = join(srcDir, "winter-fake");
    writeFileSync(winterSrc, "fake winter binary bytes\n");
    const out = tempDir("stage-runtimes-out2-");
    await expect(
      stageRuntimes({ out, winterPath: winterSrc, resolveClaudeBinary: () => undefined }),
    ).rejects.toThrow(/no claude binary found/);
  });

  // P9a-8: winterSource — a fake claude resolver throughout (never the real dual-createRequire
  // chain) so every test below is about the WINTER ladder in isolation.
  const fakeClaudeSrc = (dir: string): string => {
    const p = join(dir, "claude-fake");
    writeFileSync(p, "fake claude binary bytes\n");
    return p;
  };

  test("winterPath given, no winterSource -> defaults to checkout-build (the historical meaning of an already-built path)", async () => {
    const srcDir = tempDir("stage-runtimes-ws1-src-");
    const winterSrc = join(srcDir, "winter-fake");
    writeFileSync(winterSrc, "fake winter binary bytes\n");
    const out = tempDir("stage-runtimes-ws1-out-");
    const result = await stageRuntimes({ out, winterPath: winterSrc, claudeBinaryPath: fakeClaudeSrc(srcDir), getClaudeVersion: () => "2.1.250" });
    expect(result.versions.winterSource).toBe("checkout-build");
  });

  test("winterPath given WITH an explicit winterSource -> that label wins (verify-runtimes-compiled's own use)", async () => {
    const srcDir = tempDir("stage-runtimes-ws2-src-");
    const winterSrc = join(srcDir, "winter-fake");
    writeFileSync(winterSrc, "fake winter binary bytes\n");
    const out = tempDir("stage-runtimes-ws2-out-");
    const result = await stageRuntimes({ out, winterPath: winterSrc, winterSource: "platform-package", claudeBinaryPath: fakeClaudeSrc(srcDir), getClaudeVersion: () => "2.1.250" });
    expect(result.versions.winterSource).toBe("platform-package");
  });

  test("no winterPath, no winterSource, the injected package resolver hits -> platform-package, version+Mach-O both asserted, no buildWinter() call", async () => {
    const srcDir = tempDir("stage-runtimes-ws3-src-");
    const pkgBin = join(srcDir, "pkg-winter");
    writeFileSync(pkgBin, fakeMachOArm64());
    const out = tempDir("stage-runtimes-ws3-out-");
    const result = await stageRuntimes({
      out,
      resolveWinterPackage: () => ({ binPath: pkgBin, version: REQUIRED_WINTER_AGENT_SDK }),
      claudeBinaryPath: fakeClaudeSrc(srcDir),
      getClaudeVersion: () => "2.1.250",
    });
    expect(result.versions.winterSource).toBe("platform-package");
    expect(readFileSync(result.winterPath).equals(fakeMachOArm64())).toBe(true);
  });

  test("the package resolver hits but the version disagrees with this build's pin -> throws, never stages a mixed pair", async () => {
    const srcDir = tempDir("stage-runtimes-ws4-src-");
    const pkgBin = join(srcDir, "pkg-winter");
    writeFileSync(pkgBin, fakeMachOArm64());
    const out = tempDir("stage-runtimes-ws4-out-");
    await expect(
      stageRuntimes({ out, resolveWinterPackage: () => ({ binPath: pkgBin, version: "9.9.9" }), claudeBinaryPath: fakeClaudeSrc(srcDir), getClaudeVersion: () => "2.1.250" }),
    ).rejects.toThrow(/mixed pair is not the pinned artifact/);
  });

  test("the package resolver hits but the binary is not a Mach-O arm64 -> throws (the injected checkWinterMachO seam)", async () => {
    const srcDir = tempDir("stage-runtimes-ws5-src-");
    const pkgBin = join(srcDir, "pkg-winter");
    writeFileSync(pkgBin, "not a mach-o binary\n");
    const out = tempDir("stage-runtimes-ws5-out-");
    await expect(
      stageRuntimes({
        out,
        resolveWinterPackage: () => ({ binPath: pkgBin, version: REQUIRED_WINTER_AGENT_SDK }),
        checkWinterMachO: (p) => assertMachOArm64(p), // the REAL checker, on a deliberately fake file
        claudeBinaryPath: fakeClaudeSrc(srcDir),
        getClaudeVersion: () => "2.1.250",
      }),
    ).rejects.toThrow(/not a 64-bit Mach-O binary/);
  });

  test("no winterPath, package resolver misses, no explicit winterSource -> falls BACK to buildWinterFn (checkout-build) with a WARNING line", async () => {
    const srcDir = tempDir("stage-runtimes-ws6-src-");
    const winterSrc = join(srcDir, "winter-fallback-fake");
    writeFileSync(winterSrc, "fake fallback winter binary bytes\n");
    const out = tempDir("stage-runtimes-ws6-out-");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(" ")); origLog(...a); };
    let buildWinterFnCalled = 0;
    try {
      const result = await stageRuntimes({
        out,
        resolveWinterPackage: () => undefined,
        buildWinterFn: async () => { buildWinterFnCalled += 1; return winterSrc; },
        claudeBinaryPath: fakeClaudeSrc(srcDir),
        getClaudeVersion: () => "2.1.250",
      });
      expect(buildWinterFnCalled).toBe(1);
      expect(result.versions.winterSource).toBe("checkout-build");
      expect(readFileSync(result.winterPath, "utf8")).toBe("fake fallback winter binary bytes\n");
      expect(logs.some((l) => l.includes("WARNING") && l.includes("falling BACK to building winter"))).toBe(true);
    } finally {
      console.log = origLog;
    }
  });

  test("no winterPath, winterSource=checkout-build explicit -> buildWinterFn runs directly, the package door is never even consulted", async () => {
    const srcDir = tempDir("stage-runtimes-ws8-src-");
    const winterSrc = join(srcDir, "winter-explicit-fake");
    writeFileSync(winterSrc, "fake explicit checkout-build winter bytes\n");
    const out = tempDir("stage-runtimes-ws8-out-");
    let packageDoorConsulted = false;
    const result = await stageRuntimes({
      out,
      winterSource: "checkout-build",
      resolveWinterPackage: () => { packageDoorConsulted = true; return { binPath: "/should/not/be/used", version: REQUIRED_WINTER_AGENT_SDK }; },
      buildWinterFn: async () => winterSrc,
      claudeBinaryPath: fakeClaudeSrc(srcDir),
      getClaudeVersion: () => "2.1.250",
    });
    expect(packageDoorConsulted).toBe(false);
    expect(result.versions.winterSource).toBe("checkout-build");
    expect(readFileSync(result.winterPath, "utf8")).toBe("fake explicit checkout-build winter bytes\n");
  });

  test("no winterPath, package resolver misses, winterSource=platform-package explicit -> throws loudly instead of falling back", async () => {
    const srcDir = tempDir("stage-runtimes-ws7-src-");
    const out = tempDir("stage-runtimes-ws7-out-");
    await expect(
      stageRuntimes({
        out,
        winterSource: "platform-package",
        resolveWinterPackage: () => undefined,
        claudeBinaryPath: fakeClaudeSrc(srcDir),
        getClaudeVersion: () => "2.1.250",
      }),
    ).rejects.toThrow(/platform-package was requested explicitly but.*not installed/);
  });
});

describe("assertMachOArm64 (P9a-8)", () => {
  test("accepts the exact 8-byte shape measured off the real packed bin/winter", () => {
    const p = join(tempDir("mach-o-ok-"), "winter-fake");
    writeFileSync(p, fakeMachOArm64());
    expect(() => assertMachOArm64(p)).not.toThrow();
  });
  test("refuses a plain text file", () => {
    const p = join(tempDir("mach-o-text-"), "winter-fake");
    writeFileSync(p, "#!/bin/sh\necho not a binary\n");
    expect(() => assertMachOArm64(p)).toThrow(/not a 64-bit Mach-O binary/);
  });
  test("refuses a non-arm64 Mach-O (right magic, wrong cputype)", () => {
    const header = Buffer.alloc(8);
    header.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
    header.writeUInt32LE(0x01000007, 4); // CPU_TYPE_X86_64
    const p = join(tempDir("mach-o-wrong-arch-"), "winter-fake");
    writeFileSync(p, header);
    expect(() => assertMachOArm64(p)).toThrow(/not arm64/);
  });
  test("refuses a too-short file", () => {
    const p = join(tempDir("mach-o-short-"), "winter-fake");
    writeFileSync(p, Buffer.from([0, 1, 2]));
    expect(() => assertMachOArm64(p)).toThrow(/too small/);
  });
});
