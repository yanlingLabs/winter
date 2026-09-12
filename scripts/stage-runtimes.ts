/**
 * Winter Phase 8d (P8d-1..3) — stages the Release bundle's runtime payload: the pinned-tag
 * `winter` build, the platform `claude` binary, and the `VERSIONS.json` record that lets both
 * executable ladders (and `release.ts`'s gates) prove the pair is the pinned artifact.
 *
 *   bun run runtimes:stage                              # -> dist/runtimes/{winter,claude-official/*}
 *   bun run runtimes:stage --out <dir>
 *   bun run runtimes:stage --winter <path>               # skip buildWinter(), use an already-built one
 *   bun run runtimes:stage --sdk-checkout <path>          # forwarded to buildWinter()
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
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { buildWinter } from "./build-winter";
import { RUNTIME_BUNDLE_LAYOUT, type VersionsJson } from "../packages/core/src/runtime-sdk/bundle-layout";
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

/** Extracts the leading version token from `claude --version`'s stdout (controller measurement
 *  M1: `"2.1.250 (Claude Code)"`). */
export function parseClaudeVersionOutput(text: string): string {
  const m = text.trim().match(/^(\S+)/);
  if (!m) throw new Error(`stage-runtimes: could not parse a version out of claude --version output: ${JSON.stringify(text)}`);
  return m[1]!;
}

/** P8d-3's record, built from this build's own pins (never re-typed by a caller) plus the three
 *  staging-time measurements. Exported so it is unit-testable without a real `claude` binary. */
export function buildVersionsJson(input: { claudeCode: string; winterPreSignSha256: string; claudeSha256: string; now?: Date }): VersionsJson {
  return {
    schema: 1,
    winterAgentSdk: REQUIRED_WINTER_AGENT_SDK,
    winterRuntimeSdk: REQUIRED_WINTER_RUNTIME_SDK,
    officialSdk: REQUIRED_CLAUDE_AGENT_SDK,
    claudeCode: input.claudeCode,
    checksums: { winterPreSign: input.winterPreSignSha256, claude: input.claudeSha256 },
    stagedAt: (input.now ?? new Date()).toISOString(),
  };
}

/**
 * THE CI STEP'S EXACT CHAIN (`.github/workflows/ci.yml`'s "Verify the official runtime platform
 * package installed", the same two-step resolution `official-executable.ts`'s package door and
 * `test/helpers/claude-runtime.ts` already use): resolve the WRAPPER package's own
 * `package.json`, then resolve the platform package AS A DEPENDENCY OF THAT PACKAGE — never a
 * guessed `node_modules` path, so a stray version elsewhere on the machine can never be picked up
 * ahead of the pinned wrapper. Returns `undefined` when the optional platform package is not
 * installed (a legitimate skip on a non-darwin/arm64 host), never a throw.
 */
export function resolveInstalledClaudeBinary(): string | undefined {
  const req = createRequire(import.meta.url);
  let wrapperPkgJson: string;
  try {
    wrapperPkgJson = req.resolve("@anthropic-ai/claude-agent-sdk/package.json");
  } catch {
    return undefined;
  }
  const inside = createRequire(wrapperPkgJson);
  let platformPkgJson: string;
  try {
    platformPkgJson = inside.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
  } catch {
    return undefined;
  }
  const bin = join(dirname(platformPkgJson), "claude");
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
  /** Skip `buildWinter()` and copy from an already-built binary instead (`--winter <path>`). */
  winterPath?: string;
  /** Forwarded to `buildWinter()` when `winterPath` is not given. */
  sdkCheckout?: string;
  /** Test/CI seam: an already-resolved `claude` binary, bypassing `resolveInstalledClaudeBinary()`. */
  claudeBinaryPath?: string;
  /** Test seam for `resolveInstalledClaudeBinary` (never spawns the real dual-`createRequire` chain). */
  resolveClaudeBinary?: () => string | undefined;
  /** Test seam: avoids spawning a (possibly fake, non-executable) `claude --version` in tests. */
  getClaudeVersion?: (bin: string) => string;
}

export async function stageRuntimes(opts: StageRuntimesOpts): Promise<StageRuntimesResult> {
  mkdirSync(opts.out, { recursive: true });
  const winterDest = join(opts.out, relativeToRuntimesRoot("winter"));
  const claudeDest = join(opts.out, relativeToRuntimesRoot("claude"));
  const versionsDest = join(opts.out, relativeToRuntimesRoot("versions"));
  mkdirSync(dirname(claudeDest), { recursive: true });

  // (1) winter — buildWinter() from the pinned-tag SDK checkout unless an already-built path is given.
  const winterSrc = opts.winterPath ?? (await buildWinter({ checkout: opts.sdkCheckout }));
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

  // (5) VERSIONS.json
  const versions = buildVersionsJson({ claudeCode, winterPreSignSha256, claudeSha256 });
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
  const result = await stageRuntimes({ out, winterPath: flag("--winter"), sdkCheckout: flag("--sdk-checkout") });
  // (6) print the JSON.
  console.log(JSON.stringify(result, null, 2));
}
