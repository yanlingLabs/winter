/**
 * Winter Phase 8d (P8d-1..3), P9a-8 — stages the Release bundle's runtime payload: `winter` and the
 * `VERSIONS.json` record that lets the executable ladder (and `release.ts`'s gates) prove it is the
 * pinned artifact.
 *
 * WS-23: the official `claude` binary is no longer staged — the official leg is retired, and the
 * record is schema 2 (no claude fields). `ant` is staged by `embed-runtimes.sh`, which writes its own
 * record beside it (`runtimes/ant/VERSIONS.json`).
 *
 *   bun run runtimes:stage                              # -> dist/runtimes/{winter,VERSIONS.json}
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
 * into the app bundle — this file and the embed script are the ONE place a runtime is copied.
 *
 * Layout (RUNTIME_BUNDLE_LAYOUT, bundle-layout.ts — the one place the subpaths are spelled):
 *   <out>/winter
 *   <out>/VERSIONS.json
 */
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildWinter } from "./build-winter";
import { RUNTIME_BUNDLE_LAYOUT, type VersionsJson } from "../packages/core/src/runtime-sdk/bundle-layout";
import { resolvePlatformPackageWinter } from "../packages/core/src/runtime-sdk/executable";
import { REQUIRED_WINTER_AGENT_SDK, REQUIRED_WINTER_RUNTIME_SDK } from "../packages/core/src/runtime-sdk/versions";

/** `RUNTIME_BUNDLE_LAYOUT` entries are spelled relative to the bundle's `runtimes/` root
 *  (`dirname(execPath)`-relative); `--out` here IS that root, so the caller-facing paths are the
 *  layout's own strings with the leading `runtimes/` segment stripped — never re-spelled. */
function relativeToRuntimesRoot(entry: "winter" | "versions"): string {
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

/** P8d-3's record (schema 2, WS-23), built from this build's own pins (never re-typed by a caller)
 *  plus the staging-time measurement. Exported so it is unit-testable without a real build.
 *  P9a-8: `winterSource` is OPTIONAL here too (kept absent when not given), defaulting through
 *  `winterSourceOf` to `"checkout-build"`. */
export function buildVersionsJson(input: { winterPreSignSha256: string; now?: Date; winterSource?: VersionsJson["winterSource"] }): VersionsJson {
  return {
    schema: 2,
    winterAgentSdk: REQUIRED_WINTER_AGENT_SDK,
    winterRuntimeSdk: REQUIRED_WINTER_RUNTIME_SDK,
    checksums: { winterPreSign: input.winterPreSignSha256 },
    stagedAt: (input.now ?? new Date()).toISOString(),
    ...(input.winterSource === undefined ? {} : { winterSource: input.winterSource }),
  };
}

export interface StageRuntimesResult {
  winterPath: string;
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
  /** Test seam for the from-source fallback build; defaults to the real `buildWinter` (a two-
   *  minute `bun build --compile`) — injected so the checkout-build FALLBACK path is unit-testable
   *  with a fake binary, never a real build (this file's own tests never pay for one). */
  buildWinterFn?: (opts: { checkout?: string }) => Promise<string>;
}

export async function stageRuntimes(opts: StageRuntimesOpts): Promise<StageRuntimesResult> {
  mkdirSync(opts.out, { recursive: true });
  const winterDest = join(opts.out, relativeToRuntimesRoot("winter"));
  const versionsDest = join(opts.out, relativeToRuntimesRoot("versions"));

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

  // (2) SHA-256 — the PRE-SIGN payload (P8d-2's row-16 check compares against exactly this value;
  // `winter` is re-signed at embed time).
  const winterPreSignSha256 = sha256File(winterDest);

  // (3) VERSIONS.json — winterSource names WHICH rung produced winterSrc above (P9a-8).
  const versions = buildVersionsJson({ winterPreSignSha256, winterSource });
  writeFileSync(versionsDest, `${JSON.stringify(versions, null, 2)}\n`);

  return { winterPath: winterDest, versionsPath: versionsDest, versions };
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
  // (4) print the JSON.
  console.log(JSON.stringify(result, null, 2));
}
