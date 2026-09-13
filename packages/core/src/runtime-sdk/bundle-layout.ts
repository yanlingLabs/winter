// Winter Phase 8d (ruling P8d-1): the ONE place the Release bundle's runtime layout is spelled.
//
// `Winter.app/Contents/Resources/` holds `winter-core` (the daemon — `process.execPath` in a compiled
// build), so `dirname(execPath)` is that directory and every runtime payload sits under its
// `runtimes/` subtree (WS-02 §7.1's placement; final subpaths owned by the app project):
//
//   runtimes/winter                         # the pinned-tag `winter` build, re-signed under Winter's team identity
//   runtimes/claude-official/claude         # the UNMODIFIED Anthropic binary (signature preserved, never re-signed)
//   runtimes/claude-official/VERSIONS.json  # { schema, winterAgentSdk, winterRuntimeSdk, officialSdk, claudeCode, checksums, stagedAt }
//   runtimes/ant/ant                        # Winter Phase 10a (L1-L4): Anthropic's Platform CLI, vendored from
//                                            # vendor/ant/<tag>/ant (scripts/fetch-ant.ts) and RE-SIGNED under
//                                            # Winter's own team identity (--identifier com.winter.ant) — the
//                                            # `winter` shape, never claude's "verified untouched" one. See
//                                            # scripts/embed-runtimes.sh.
//
// Both executable ladders (`executable.ts`, `official-executable.ts`) probe their "bundle" rung
// through `bundleRuntimePath`; `scripts/stage-runtimes.ts` writes this exact layout; the compiled
// probe (`runtimes-probe.ts`) and `release.ts` verify it. Nothing else re-derives these strings.
import { accessSync, constants } from "node:fs";
import { join, dirname } from "node:path";
import { REQUIRED_CLAUDE_AGENT_SDK, REQUIRED_WINTER_AGENT_SDK, REQUIRED_WINTER_RUNTIME_SDK } from "./versions";

export const RUNTIME_BUNDLE_LAYOUT = {
  root: "runtimes",
  winter: "runtimes/winter",
  claude: "runtimes/claude-official/claude",
  versions: "runtimes/claude-official/VERSIONS.json",
  ant: "runtimes/ant/ant",
} as const;

export type RuntimeBundleEntry = keyof typeof RUNTIME_BUNDLE_LAYOUT;

/** `<dirname(execPath)>/<layout entry>` — the bundle rung of both ladders. */
export function bundleRuntimePath(execPath: string, entry: RuntimeBundleEntry): string {
  return join(dirname(execPath), RUNTIME_BUNDLE_LAYOUT[entry]);
}

/** `<dirname(execPath)>/runtimes/ant/ant` — Winter Phase 10a Interfaces' own named helper (rather
 *  than callers spelling `bundleRuntimePath(execPath, "ant")` themselves) for `resolveAntExecutable`'s
 *  bundle rung, below. */
export function antExecutablePath(execPath: string): string {
  return bundleRuntimePath(execPath, "ant");
}

/** P8d-3's record. Versions and checksums ONLY — never a path under a home, never a credential.
 *  P9a-8: `winterSource` names WHICH ladder rung produced the embedded `winter` — the installed
 *  npm platform package (the strong row-16 identity check, `row16IdentityCheck`) or a from-source
 *  build of the pinned-tag checkout (the weaker `row16ProvenanceCheck`, rehearsal/dry-run only).
 *  Optional so an 8d-staged bundle (written before this field existed) still parses. */
export interface VersionsJson {
  schema: 1;
  winterAgentSdk: string;
  winterRuntimeSdk: string;
  officialSdk: string;
  claudeCode: string;
  /** Winter Phase 10a (fix round 2): `ant` is OPTIONAL — a bundle staged before embed-runtimes.sh
   *  learned to record it (or one built without a vendored ant at all) still parses. When present,
   *  it is the PRE-SIGN sha256 of the staged `runtimes/ant/ant` — computed immediately after the
   *  copy, before `codesign` mutates the file — the exact same "hash before signing" shape as
   *  `winterPreSign` above, recorded by embed-runtimes.sh directly (ant is never routed through
   *  stage-runtimes.ts's own ladder). `release-lib.ts`'s `verifyAntEmbed` compares this against the
   *  repo-root VERSIONS.json's git-committed `ant.binarySha256` pin. */
  checksums: { winterPreSign: string; claude: string; ant?: string };
  stagedAt: string;
  winterSource?: "platform-package" | "checkout-build";
}

const WINTER_SOURCES = ["platform-package", "checkout-build"] as const;

/** An absent `winterSource` is an 8d-staged bundle, from before this field existed — those were
 *  ALWAYS a from-source build (there was no other rung yet), so `"checkout-build"` is the correct
 *  default, never `"platform-package"`. */
export function winterSourceOf(v: VersionsJson): "platform-package" | "checkout-build" {
  return v.winterSource ?? "checkout-build";
}

const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * Parses and VALIDATES a `VERSIONS.json` text against this build's pins (`REQUIRED_*`). A bundle
 * whose recorded versions disagree with the daemon that reads it is not the pinned artifact
 * (WS-02 §6/§8.1) — throw, never coerce. Checksums must be lowercase sha256 hex.
 */
export function parseVersionsJson(text: string): VersionsJson {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`VERSIONS.json is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null) throw new Error("VERSIONS.json: expected an object");
  const v = raw as Record<string, unknown>;
  if (v.schema !== 1) throw new Error(`VERSIONS.json: unsupported schema ${String(v.schema)} (expected 1)`);
  const str = (k: string): string => {
    const x = v[k];
    if (typeof x !== "string" || x.length === 0) throw new Error(`VERSIONS.json: missing string field '${k}'`);
    return x;
  };
  const checksumsRaw = v.checksums;
  if (typeof checksumsRaw !== "object" || checksumsRaw === null) throw new Error("VERSIONS.json: missing 'checksums'");
  const c = checksumsRaw as Record<string, unknown>;
  const sha = (k: string): string => {
    const x = c[k];
    if (typeof x !== "string" || !SHA256_RE.test(x)) throw new Error(`VERSIONS.json: checksums.${k} must be lowercase sha256 hex`);
    return x;
  };
  // Winter Phase 10a (fix round 2): `checksums.ant` is OPTIONAL — absent entirely on a bundle
  // staged before embed-runtimes.sh recorded it, or one built without a vendored ant. Present-but-
  // malformed still refuses (never silently drop a corrupt pin).
  let antChecksum: string | undefined;
  if (c.ant !== undefined) {
    if (typeof c.ant !== "string" || !SHA256_RE.test(c.ant)) {
      throw new Error("VERSIONS.json: checksums.ant must be lowercase sha256 hex");
    }
    antChecksum = c.ant;
  }
  let winterSource: VersionsJson["winterSource"];
  if (v.winterSource !== undefined) {
    if (typeof v.winterSource !== "string" || !(WINTER_SOURCES as readonly string[]).includes(v.winterSource)) {
      throw new Error(`VERSIONS.json: winterSource must be one of ${WINTER_SOURCES.join(", ")} (got ${JSON.stringify(v.winterSource)})`);
    }
    winterSource = v.winterSource as VersionsJson["winterSource"];
  }
  const out: VersionsJson = {
    schema: 1,
    winterAgentSdk: str("winterAgentSdk"),
    winterRuntimeSdk: str("winterRuntimeSdk"),
    officialSdk: str("officialSdk"),
    claudeCode: str("claudeCode"),
    checksums: { winterPreSign: sha("winterPreSign"), claude: sha("claude"), ...(antChecksum === undefined ? {} : { ant: antChecksum }) },
    stagedAt: str("stagedAt"),
    ...(winterSource === undefined ? {} : { winterSource }),
  };
  const mismatches: string[] = [];
  if (out.winterAgentSdk !== REQUIRED_WINTER_AGENT_SDK) mismatches.push(`winterAgentSdk ${out.winterAgentSdk} (pinned ${REQUIRED_WINTER_AGENT_SDK})`);
  if (out.winterRuntimeSdk !== REQUIRED_WINTER_RUNTIME_SDK) mismatches.push(`winterRuntimeSdk ${out.winterRuntimeSdk} (pinned ${REQUIRED_WINTER_RUNTIME_SDK})`);
  if (out.officialSdk !== REQUIRED_CLAUDE_AGENT_SDK) mismatches.push(`officialSdk ${out.officialSdk} (pinned ${REQUIRED_CLAUDE_AGENT_SDK})`);
  if (mismatches.length > 0) throw new Error(`VERSIONS.json disagrees with this build's pins: ${mismatches.join("; ")}`);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Winter Phase 10a (P10a-4, Interfaces, Lane L Task L4): the `ant` executable ladder.
// ---------------------------------------------------------------------------------------------

export type AntExecutableSource = "setting" | "env" | "bundle" | "path";

/** `existsSync` is not enough for the bundle rung: `fetch-ant.ts` chmod 755s the file it writes,
 *  but a corrupted/partial `vendor/ant` copy that slipped past that (or a hand-placed file that
 *  never got chmod'd) should read as "absent", not "spawn this and see what happens". `accessSync`
 *  with `X_OK` checks both existence and the executable bit in one syscall. */
function realIsExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Winter Phase 10a fix wave (M6): "compiled vs dev", the SAME discriminator
 * `workflows/runtime.ts`'s own `defaultWorkerCommand` already uses (`Bun.main` is the compiled/dev
 * tell; `execPath` is not — it is always the file to spawn either way). Exported as a function
 * (not inlined) so `resolveAntExecutable` below can accept a test seam that overrides it, exactly
 * like every other real-vs-fake probe in this ladder.
 */
export function isCompiledBinary(): boolean {
  return Bun.main.startsWith("/$bunfs/");
}

/**
 * Winter Phase 10a (P10a-4/L4): where the daemon's console-profile broker
 * (`auth/console-profile-broker.ts`, Lane O) finds Anthropic's Platform CLI `ant` — the binary
 * `ant auth print-credentials` is shelled out to for the native provider's bearer material.
 *
 * UNLIKE `resolveWinterExecutable`/`resolveClaudeExecutable`, a miss here is never a typed
 * refusal — `ant` is OPTIONAL. A session's own auth (api-key or console-profile via the official
 * leg) does not depend on it at all; only the native-provider broker's bearer refresh does, and it
 * already has its own typed failure for "no ant available" at the point that actually matters.
 * So this ladder just returns `undefined` on a total miss.
 *
 * The ladder, exactly (Interfaces): `settings.runtimes.antExecutable` → `$WINTER_ANT_EXECUTABLE` →
 * the bundle path (`antExecutablePath`, gated on existing AND being executable) → `which ant`
 * (dev-only) → `undefined`.
 *
 * Winter Phase 10a fix wave (M6): the `which ant` rung used to be dev-only in EFFECT ONLY ("a
 * Release bundle's own rung above always succeeds, so this is only ever reached when nothing was
 * embedded") rather than by construction — unlike the claude ladder's package-door rung, which
 * `createRequire` makes UNREACHABLE from inside a compiled `$bunfs` binary's own module graph, a
 * `Bun.which`/PATH search works identically whether this process is compiled or not. A staging bug
 * or a tampered Release install missing its embedded `ant` would previously fall through to
 * whatever `ant` happened to sit on the real machine's `$PATH` — a binary this daemon never
 * vetted, in a leg (the official app bundle) that otherwise embeds and re-signs everything it
 * runs. This rung is now gated the same way the claude ladder's is IN EFFECT: `isCompiledBinary()`
 * (overridable via `isCompiled`, the same test-seam shape as every other rung here) skips it
 * entirely for a compiled process, so a Release binary with a missing/corrupt embedded `ant`
 * reports "not found" (the broker's own typed failure), never a silent substitution.
 *
 * An explicit setting/env value is trusted as given, with NO existence check — unlike the
 * winter/claude ladders' "an explicit-but-missing path IS the failure" rule. There is no typed
 * refusal type here to carry that distinction through, and the broker's own spawn attempt is what
 * surfaces a genuinely bad explicit path; this resolver's job is only "best guess at where `ant`
 * lives", never a hard gate. (Also unaffected by the compiled gate above — an explicit
 * configuration is never a "guess".)
 */
export function resolveAntExecutable(input: {
  setting?: string;
  env: Record<string, string | undefined>;
  execPath: string;
  /** Test seam for the bundle rung's exists-and-executable check; defaults to a real X_OK probe. */
  isExecutableFile?: (p: string) => boolean;
  /** Test seam for the dev-only PATH lookup; defaults to `Bun.which`. Always injected in this
   *  file's own tests — never exercised against the ambient PATH, which may or may not have `ant`
   *  installed on any given machine. */
  which?: (cmd: string) => string | null;
  /** Test seam (M6) for "is this a compiled binary" — defaults to `isCompiledBinary()`. Real
   *  `bun test` always runs uncompiled, so this file's own tests must inject `true` to exercise
   *  the compiled-gate branch at all. */
  isCompiled?: () => boolean;
}): { path: string; source: AntExecutableSource } | undefined {
  const settingPath = input.setting?.trim() || undefined;
  if (settingPath) return { path: settingPath, source: "setting" };
  const envPath = input.env.WINTER_ANT_EXECUTABLE?.trim() || undefined;
  if (envPath) return { path: envPath, source: "env" };

  const bundlePath = antExecutablePath(input.execPath);
  const isExecutableFile = input.isExecutableFile ?? realIsExecutableFile;
  if (isExecutableFile(bundlePath)) return { path: bundlePath, source: "bundle" };

  const isCompiled = input.isCompiled ?? isCompiledBinary;
  if (isCompiled()) return undefined; // M6: never reach the real system $PATH from a compiled binary

  const which = input.which ?? ((cmd: string) => Bun.which(cmd));
  const found = which("ant");
  if (found) return { path: found, source: "path" };

  return undefined;
}
