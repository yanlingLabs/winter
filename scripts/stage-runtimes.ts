/**
 * Winter Phase 8d (P8d-1..3), P9a-8 — stages the Release bundle's runtime payload: `winter`, the
 * platform `claude` binary, and the `VERSIONS.json` record that lets both executable ladders (and
 * `release.ts`'s gates) prove the pair is the pinned artifact.
 *
 *   bun run runtimes:stage                              # -> dist/runtimes/{winter,claude-official/*}
 *   bun run runtimes:stage --out <dir>
 *   bun run runtimes:stage --winter <path>               # skip winter resolution, use an already-built one
 *   bun run runtimes:stage --sdk-checkout <path>          # forwarded to buildWinter() (checkout-build only)
 *   bun run runtimes:stage --winter-source platform-package   # fail loudly rather than fall back
 *   bun run runtimes:stage --winter-source checkout-build     # always build from the pinned-tag checkout
 *
 * P9a-8/P9a-9: `winter`'s source is now a LADDER, same posture as the daemon's own
 * `resolveWinterExecutable` — the installed npm platform package first (the strong row-16 check,
 * `row16IdentityCheck`), falling BACK — loudly, a printed WARNING — to a from-source
 * `buildWinter()` of the pinned-tag checkout (the weaker `row16ProvenanceCheck`) only when nothing
 * was requested explicitly and the package is not installed. `VERSIONS.json.winterSource` records
 * which rung actually ran.
 *
 * project.yml's "Embed runtimes" postCompileScript calls this SAME script with
 * `--out "${BUILT_PRODUCTS_DIR}/${CONTENTS_FOLDER_PATH}/Resources/runtimes"`, staging directly
 * into the app bundle — this file and the embed script are the ONE place either binary is copied.
 *
 * Layout (RUNTIME_BUNDLE_LAYOUT, bundle-layout.ts — the one place the subpaths are spelled):
 *   <out>/winter
 *   <out>/claude-official/claude
 *   <out>/claude-official/VERSIONS.json
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildWinter } from "./build-winter";
import { RUNTIME_BUNDLE_LAYOUT, type VersionsJson } from "../packages/core/src/runtime-sdk/bundle-layout";
import { resolvePlatformPackageWinter } from "../packages/core/src/runtime-sdk/executable";
import { resolveClaudeAgentSdkPackageDir } from "../packages/core/src/runtime-sdk/official-executable";
import { REQUIRED_CLAUDE_AGENT_SDK, REQUIRED_WINTER_AGENT_SDK, REQUIRED_WINTER_RUNTIME_SDK } from "../packages/core/src/runtime-sdk/versions";

/** `RUNTIME_BUNDLE_LAYOUT` entries are spelled relative to the bundle's `runtimes/` root
 *  (`dirname(execPath)`-relative); `--out` here IS that root, so the caller-facing paths are the
 *  layout's own strings with the leading `runtimes/` segment stripped — never re-spelled. */
function relativeToRuntimesRoot(entry: "winter" | "claude" | "versions"): string {
  return RUNTIME_BUNDLE_LAYOUT[entry].slice(RUNTIME_BUNDLE_LAYOUT.root.length + 1);
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const MH_MAGIC_64 = 0xfeedfacf;
const CPU_TYPE_ARM64 = 0x0100000c;

/**
 * P9a-8's Mach-O check on the winter binary resolved through the platform-package door: a plain
 * 8-byte magic+cputype read (measured against the real packed `bin/winter`: `magicLE=feedfacf`,
 * `cputypeLE@4=100000c`) — no shell-out to `file`/`codesign`, so it stays fast and trivially
 * fixturable. Deliberately NARROW (64-bit non-fat Mach-O, arm64 only) — this package is declared
 * `os:["darwin"], cpu:["arm64"]`, so anything else resolving through this door is already wrong.
 */
export function assertMachOArm64(path: string): void {
  const header = readFileSync(path).subarray(0, 8);
  if (header.length < 8) throw new Error(`stage-runtimes: ${path} is too small to be a Mach-O binary (${header.length} bytes)`);
  const magic = header.readUInt32LE(0);
  if (magic !== MH_MAGIC_64) throw new Error(`stage-runtimes: ${path} is not a 64-bit Mach-O binary (magic 0x${magic.toString(16)})`);
  const cpuType = header.readUInt32LE(4);
  if (cpuType !== CPU_TYPE_ARM64) throw new Error(`stage-runtimes: ${path} is a Mach-O binary but not arm64 (cputype 0x${cpuType.toString(16)})`);
}

export interface InstalledWinterPackage {
  binPath: string;
  version: string;
}

/**
 * P9a-8/P9a-9: resolves the installed platform package through the SAME door the daemon's own
 * ladder uses (`resolvePlatformPackageWinter`, `executable.ts`) — so staging can never pick up a
 * different copy than a live daemon would — and reads the package's own declared `version`
 * alongside the bin path, for the version-equality assertion `stageRuntimes` makes below. Returns
 * `undefined` when the optional dependency is not installed at all (a legitimate skip: a non-
 * darwin/arm64 host, or simply no `bun install` yet).
 */
export function resolveInstalledWinterPackage(): InstalledWinterPackage | undefined {
  const binPath = resolvePlatformPackageWinter();
  if (binPath === undefined) return undefined;
  // `<packageRoot>/bin/winter` — the package.json this bin path came from sits two levels up.
  const packageJsonPath = join(dirname(dirname(binPath)), "package.json");
  const version = (JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string }).version;
  return { binPath, version };
}

/** Extracts the leading version token from `claude --version`'s stdout (controller measurement
 *  M1: `"2.1.250 (Claude Code)"`). */
export function parseClaudeVersionOutput(text: string): string {
  const m = text.trim().match(/^(\S+)/);
  if (!m) throw new Error(`stage-runtimes: could not parse a version out of claude --version output: ${JSON.stringify(text)}`);
  return m[1]!;
}

/** P8d-3's record, built from this build's own pins (never re-typed by a caller) plus the three
 *  staging-time measurements. Exported so it is unit-testable without a real `claude` binary.
 *  P9a-8: `winterSource` is OPTIONAL here too (kept absent when not given) — an 8d-era caller that
 *  never learned about the field still gets a valid record, defaulting through `winterSourceOf`
 *  to `"checkout-build"` exactly as it always effectively was. */
export function buildVersionsJson(input: { claudeCode: string; winterPreSignSha256: string; claudeSha256: string; now?: Date; winterSource?: VersionsJson["winterSource"] }): VersionsJson {
  return {
    schema: 1,
    winterAgentSdk: REQUIRED_WINTER_AGENT_SDK,
    winterRuntimeSdk: REQUIRED_WINTER_RUNTIME_SDK,
    officialSdk: REQUIRED_CLAUDE_AGENT_SDK,
    claudeCode: input.claudeCode,
    checksums: { winterPreSign: input.winterPreSignSha256, claude: input.claudeSha256 },
    stagedAt: (input.now ?? new Date()).toISOString(),
    ...(input.winterSource === undefined ? {} : { winterSource: input.winterSource }),
  };
}

/**
 * THE CI STEP'S EXACT CHAIN, by DELEGATION rather than re-implementation: `official-executable.ts`
 * exports `resolveClaudeAgentSdkPackageDir` precisely so this script (and anything else outside
 * `packages/core`) resolves the platform package through the SAME `createRequire(import.meta.url)`
 * — rooted at THAT module's own location — as the real daemon ladder and
 * `.github/workflows/ci.yml`'s "Verify the official runtime platform package installed" step.
 *
 * Rooting matters: bun's isolated linker nests this optional dependency under `packages/core`'s
 * own `node_modules`, never hoisted to the repo root, so a `createRequire` rooted at THIS script's
 * own location (`<repo>/scripts/`) would walk right past it — measured empirically staging this
 * very script before this fix (`stage-runtimes: no claude binary found` on a machine where the
 * package plainly IS installed, one directory over). Returns `undefined` when the optional
 * platform package is not installed at all (a legitimate skip on a non-darwin/arm64 host); a
 * version-mismatched platform package THROWS (WS-02 §6) — surfaced by `stageRuntimes` as-is, since
 * staging on top of a mismatched pair is exactly the failure this must not paper over.
 */
export function resolveInstalledClaudeBinary(): string | undefined {
  const dir = resolveClaudeAgentSdkPackageDir();
  if (dir === undefined) return undefined;
  const bin = join(dir, "claude");
  return existsSync(bin) ? bin : undefined;
}

function realGetClaudeVersion(bin: string): string {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (r.status !== 0) throw new Error(`stage-runtimes: "${bin} --version" exited ${r.status ?? `signal ${r.signal}`}: ${r.stderr || r.stdout}`);
  return parseClaudeVersionOutput(r.stdout);
}

export interface StageRuntimesResult {
  winterPath: string;
  claudePath: string;
  versionsPath: string;
  versions: VersionsJson;
}

export interface StageRuntimesOpts {
  /** Root directory the layout is written into (a bundle's `Resources/runtimes/`, or `dist/runtimes` for dev/CI). */
  out: string;
  /** Skip winter resolution entirely and copy from an already-built binary instead (`--winter
   *  <path>`). Labelled by `winterSource` when given (default `"checkout-build"` — the historical
   *  meaning of "an already-built path", e.g. a prior `bun run build:winter`). */
  winterPath?: string;
  /** Forwarded to `buildWinter()` when staging falls through to a from-source build. */
  sdkCheckout?: string;
  /**
   * P9a-8/`--winter-source`: which rung produces the embedded `winter`. Explicit
   * `"platform-package"` FAILS (never silently falls back) when the package is not installed —
   * an explicit choice this ladder cannot honor is the failure, same posture as every other
   * explicit-beats-implicit door in this codebase. Explicit `"checkout-build"` always calls
   * `buildWinter()`. Omitted (the default): try the platform package first; if it is not
   * installed, fall BACK to `checkout-build` — loudly (a printed WARNING line), since that is the
   * weaker row-16 path (`row16ProvenanceCheck`, never the strong `row16IdentityCheck`). Ignored
   * when `winterPath` is given (that door bypasses resolution entirely).
   */
  winterSource?: VersionsJson["winterSource"];
  /** Test seam for the P9a-9 platform-package door; defaults to `resolveInstalledWinterPackage`
   *  (never a real install dependency in tests). */
  resolveWinterPackage?: () => InstalledWinterPackage | undefined;
  /** Test seam for the Mach-O/arch assertion on a package-resolved winter binary; defaults to
   *  `assertMachOArm64`. Throws to refuse, same contract as the real one. */
  checkWinterMachO?: (path: string) => void;
  /** Test/CI seam: an already-resolved `claude` binary, bypassing `resolveInstalledClaudeBinary()`. */
  claudeBinaryPath?: string;
  /** Test seam for `resolveInstalledClaudeBinary` (never spawns the real dual-`createRequire` chain). */
  resolveClaudeBinary?: () => string | undefined;
  /** Test seam: avoids spawning a (possibly fake, non-executable) `claude --version` in tests. */
  getClaudeVersion?: (bin: string) => string;
  /** Test seam for the from-source fallback build; defaults to the real `buildWinter` (a two-
   *  minute `bun build --compile`) — injected so the checkout-build FALLBACK path is unit-testable
   *  with a fake binary, never a real build (this file's own tests never pay for one). */
  buildWinterFn?: (opts: { checkout?: string }) => Promise<string>;
}

export async function stageRuntimes(opts: StageRuntimesOpts): Promise<StageRuntimesResult> {
  mkdirSync(opts.out, { recursive: true });
  const winterDest = join(opts.out, relativeToRuntimesRoot("winter"));
  const claudeDest = join(opts.out, relativeToRuntimesRoot("claude"));
  const versionsDest = join(opts.out, relativeToRuntimesRoot("versions"));
  mkdirSync(dirname(claudeDest), { recursive: true });

  // (1) winter — P9a-8's ladder: an explicit `winterPath` bypasses resolution entirely; otherwise
  // the platform package is tried first (strong row-16 path) unless `checkout-build` was asked
  // for explicitly, and only falls BACK to a from-source `buildWinter()` — loudly — when nothing
  // else was requested and the package is simply not installed.
  const buildWinterFn = opts.buildWinterFn ?? buildWinter;
  let winterSrc: string;
  let winterSource: VersionsJson["winterSource"];
  if (opts.winterPath !== undefined) {
    winterSrc = opts.winterPath;
    winterSource = opts.winterSource ?? "checkout-build";
  } else if (opts.winterSource === "checkout-build") {
    console.log("stage-runtimes: winterSource=checkout-build requested explicitly — building winter from the pinned-tag SDK checkout.");
    winterSrc = await buildWinterFn({ checkout: opts.sdkCheckout });
    winterSource = "checkout-build";
  } else {
    const resolveWinterPackage = opts.resolveWinterPackage ?? resolveInstalledWinterPackage;
    const pkg = resolveWinterPackage();
    if (pkg !== undefined) {
      if (pkg.version !== REQUIRED_WINTER_AGENT_SDK) {
        throw new Error(`stage-runtimes: the installed platform package is winter ${pkg.version} but this build is pinned to ${REQUIRED_WINTER_AGENT_SDK} — a mixed pair is not the pinned artifact`);
      }
      const checkWinterMachO = opts.checkWinterMachO ?? assertMachOArm64;
      checkWinterMachO(pkg.binPath);
      winterSrc = pkg.binPath;
      winterSource = "platform-package";
    } else if (opts.winterSource === "platform-package") {
      throw new Error(
        "stage-runtimes: winterSource=platform-package was requested explicitly but the optional " +
          "@yanlinglabs/winter-agent-sdk-darwin-arm64 platform package is not installed (`bun install`)",
      );
    } else {
      console.log(
        "WARNING: stage-runtimes: the @yanlinglabs/winter-agent-sdk-darwin-arm64 platform package is not installed " +
          "(dated 2026-09-12, P9a-8) — falling BACK to building winter from the pinned-tag SDK checkout. This is the " +
          "WEAKER row-16 path (row16ProvenanceCheck, never the strong checksum-equality row16IdentityCheck). Run " +
          "`bun install` once the platform package is published, or pass --winter-source platform-package to fail loudly instead.",
      );
      winterSrc = await buildWinterFn({ checkout: opts.sdkCheckout });
      winterSource = "checkout-build";
    }
  }
  copyFileSync(winterSrc, winterDest);
  chmodSync(winterDest, 0o755);

  // (2) claude — through the wrapper's own createRequire, or an injected path for tests/CI.
  const resolveClaudeBinary = opts.resolveClaudeBinary ?? resolveInstalledClaudeBinary;
  const claudeSrc = opts.claudeBinaryPath ?? resolveClaudeBinary();
  if (!claudeSrc) {
    throw new Error(
      "stage-runtimes: no claude binary found — install the optional @anthropic-ai/claude-agent-sdk " +
        "platform package (`bun install`) or pass a claudeBinaryPath",
    );
  }
  copyFileSync(claudeSrc, claudeDest);
  chmodSync(claudeDest, 0o755);

  // (3) SHA-256 both. `winterPreSign` is the PRE-SIGN payload (P8d-2's row-16 check compares
  // against exactly this value — `winter` is re-signed at embed time; `claude` never is, so its
  // checksum is simply of the byte-copied binary).
  const winterPreSignSha256 = sha256File(winterDest);
  const claudeSha256 = sha256File(claudeDest);

  // (4) claude --version -> claudeCode.
  const getClaudeVersion = opts.getClaudeVersion ?? realGetClaudeVersion;
  const claudeCode = getClaudeVersion(claudeDest);

  // (5) VERSIONS.json — winterSource names WHICH rung produced winterSrc above (P9a-8).
  const versions = buildVersionsJson({ claudeCode, winterPreSignSha256, claudeSha256, winterSource });
  writeFileSync(versionsDest, `${JSON.stringify(versions, null, 2)}\n`);

  return { winterPath: winterDest, claudePath: claudeDest, versionsPath: versionsDest, versions };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const ix = args.indexOf(name);
    return ix >= 0 ? args[ix + 1] : undefined;
  };
  const out = resolve(flag("--out") ?? resolve(import.meta.dir, "../dist/runtimes"));
  const winterSourceArg = flag("--winter-source");
  if (winterSourceArg !== undefined && winterSourceArg !== "platform-package" && winterSourceArg !== "checkout-build") {
    console.error(`stage-runtimes: --winter-source must be "platform-package" or "checkout-build" (got ${JSON.stringify(winterSourceArg)})`);
    process.exit(1);
  }
  const result = await stageRuntimes({
    out,
    winterPath: flag("--winter"),
    sdkCheckout: flag("--sdk-checkout"),
    winterSource: winterSourceArg as VersionsJson["winterSource"] | undefined,
  });
  // (6) print the JSON.
  console.log(JSON.stringify(result, null, 2));
}
