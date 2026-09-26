// Winter Phase 8d (ruling P8d-1): the ONE place the Release bundle's runtime layout is spelled.
//
// `Winter.app/Contents/Resources/` holds `winter-core` (the daemon — `process.execPath` in a compiled
// build), so `dirname(execPath)` is that directory and every runtime payload sits under its
// `runtimes/` subtree (WS-02 §7.1's placement; final subpaths owned by the app project):
//
//   runtimes/winter             # the pinned-tag `winter` build, re-signed under Winter's team identity
//   runtimes/VERSIONS.json      # the runtimes record: { schema: 2, winterAgentSdk, winterRuntimeSdk, checksums: { winterPreSign }, stagedAt, winterSource }
//   runtimes/ant/ant            # Winter Phase 10a (L1-L4): Anthropic's Platform CLI — the Console's one
//                               # login and token-refresh door — vendored from vendor/ant/<tag>/ant
//                               # (scripts/fetch-ant.ts) and RE-SIGNED under Winter's own team identity
//                               # (--identifier com.winter.ant). See scripts/embed-runtimes.sh.
//   runtimes/ant/VERSIONS.json  # ant's OWN record: { schema: 1, tag, checksums: { antPreSign }, stagedAt }
//
// WS-23: `runtimes/claude-official/` (Anthropic's `claude` binary and the record that lived beside it)
// is gone with the official leg. The record it carried was two records in one — the Winter runtime's
// and, since Phase 10a, `ant`'s pre-sign checksum — so it is now split: the runtimes record moved up
// to `runtimes/VERSIONS.json` (schema 2: the claude fields gone), and `ant` has its own beside its
// binary, written by the one step that stages it.
//
// The winter ladder (`executable.ts`) probes its "bundle" rung through `bundleRuntimePath`;
// `scripts/stage-runtimes.ts` writes this exact layout; the compiled probe (`runtimes-probe.ts`) and
// `release.ts` verify it. Nothing else re-derives these strings.
import { accessSync, constants } from "node:fs";
import { join, dirname } from "node:path";
import { REQUIRED_WINTER_AGENT_SDK, REQUIRED_WINTER_RUNTIME_SDK } from "./versions";

export const RUNTIME_BUNDLE_LAYOUT = {
  root: "runtimes",
  winter: "runtimes/winter",
  versions: "runtimes/VERSIONS.json",
  ant: "runtimes/ant/ant",
  antVersions: "runtimes/ant/VERSIONS.json",
} as const;

export type RuntimeBundleEntry = keyof typeof RUNTIME_BUNDLE_LAYOUT;

/** `<dirname(execPath)>/<layout entry>` — the bundle rung of the ladders. */
export function bundleRuntimePath(execPath: string, entry: RuntimeBundleEntry): string {
  return join(dirname(execPath), RUNTIME_BUNDLE_LAYOUT[entry]);
}

/** `<dirname(execPath)>/runtimes/ant/ant` — Winter Phase 10a Interfaces' own named helper (rather
 *  than callers spelling `bundleRuntimePath(execPath, "ant")` themselves) for `resolveAntExecutable`'s
 *  bundle rung, below. */
export function antExecutablePath(execPath: string): string {
  return bundleRuntimePath(execPath, "ant");
}

/** P8d-3's record, schema 2 (WS-23). Versions and checksums ONLY — never a path under a home, never a
 *  credential. P9a-8: `winterSource` names WHICH ladder rung produced the embedded `winter` — the
 *  installed npm platform package (the strong row-16 identity check, `row16IdentityCheck`) or a
 *  from-source build of the pinned-tag checkout (the weaker `row16ProvenanceCheck`, rehearsal/dry-run
 *  only). Optional so a record written without it still parses. */
export interface VersionsJson {
  schema: 2;
  winterAgentSdk: string;
  winterRuntimeSdk: string;
  checksums: { winterPreSign: string };
  stagedAt: string;
  winterSource?: "platform-package" | "checkout-build";
}

/** `ant`'s own record (WS-23; the checksum used to ride `claude-official/VERSIONS.json` as
 *  `checksums.ant`). `antPreSign` is the sha256 of the staged `runtimes/ant/ant` computed immediately
 *  after the copy, BEFORE `codesign` mutates the file — the same "hash before signing" shape as
 *  `winterPreSign`. `release-lib.ts`'s `verifyAntEmbed` compares it against the repo-root
 *  VERSIONS.json's git-committed `ant.binarySha256` pin. `tag` is the pinned release it was vendored
 *  from, for a reader. */
export interface AntVersionsJson {
  schema: 1;
  tag: string;
  checksums: { antPreSign: string };
  stagedAt: string;
}

const WINTER_SOURCES = ["platform-package", "checkout-build"] as const;

/** An absent `winterSource` is a record from before this field existed — those were ALWAYS a
 *  from-source build (there was no other rung yet), so `"checkout-build"` is the correct default,
 *  never `"platform-package"`. */
export function winterSourceOf(v: VersionsJson): "platform-package" | "checkout-build" {
  return v.winterSource ?? "checkout-build";
}

const SHA256_RE = /^[0-9a-f]{64}$/;

function parseObject(text: string, name: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${name} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${name}: expected an object`);
  return raw as Record<string, unknown>;
}

function fieldReaders(v: Record<string, unknown>, name: string): { str: (k: string) => string; sha: (k: string) => string } {
  const str = (k: string): string => {
    const x = v[k];
    if (typeof x !== "string" || x.length === 0) throw new Error(`${name}: missing string field '${k}'`);
    return x;
  };
  const checksumsRaw = v.checksums;
  const sha = (k: string): string => {
    if (typeof checksumsRaw !== "object" || checksumsRaw === null) throw new Error(`${name}: missing 'checksums'`);
    const x = (checksumsRaw as Record<string, unknown>)[k];
    if (typeof x !== "string" || !SHA256_RE.test(x)) throw new Error(`${name}: checksums.${k} must be lowercase sha256 hex`);
    return x;
  };
  return { str, sha };
}

/**
 * Parses and VALIDATES `runtimes/VERSIONS.json` against this build's pins (`REQUIRED_*`). A bundle
 * whose recorded versions disagree with the daemon that reads it is not the pinned artifact
 * (WS-02 §6/§8.1) — throw, never coerce. Checksums must be lowercase sha256 hex. Schema 1 — the
 * pre-WS-23 `claude-official/VERSIONS.json` shape — is refused by name: it describes a bundle that
 * still carries the official leg, which is not this build's layout.
 */
export function parseVersionsJson(text: string): VersionsJson {
  const v = parseObject(text, "VERSIONS.json");
  if (v.schema === 1) throw new Error("VERSIONS.json: schema 1 is the pre-WS-23 claude-official record — this build's runtimes record is schema 2");
  if (v.schema !== 2) throw new Error(`VERSIONS.json: unsupported schema ${String(v.schema)} (expected 2)`);
  const { str, sha } = fieldReaders(v, "VERSIONS.json");
  let winterSource: VersionsJson["winterSource"];
  if (v.winterSource !== undefined) {
    if (typeof v.winterSource !== "string" || !(WINTER_SOURCES as readonly string[]).includes(v.winterSource)) {
      throw new Error(`VERSIONS.json: winterSource must be one of ${WINTER_SOURCES.join(", ")} (got ${JSON.stringify(v.winterSource)})`);
    }
    winterSource = v.winterSource as VersionsJson["winterSource"];
  }
  const out: VersionsJson = {
    schema: 2,
    winterAgentSdk: str("winterAgentSdk"),
    winterRuntimeSdk: str("winterRuntimeSdk"),
    checksums: { winterPreSign: sha("winterPreSign") },
    stagedAt: str("stagedAt"),
    ...(winterSource === undefined ? {} : { winterSource }),
  };
  const mismatches: string[] = [];
  if (out.winterAgentSdk !== REQUIRED_WINTER_AGENT_SDK) mismatches.push(`winterAgentSdk ${out.winterAgentSdk} (pinned ${REQUIRED_WINTER_AGENT_SDK})`);
  if (out.winterRuntimeSdk !== REQUIRED_WINTER_RUNTIME_SDK) mismatches.push(`winterRuntimeSdk ${out.winterRuntimeSdk} (pinned ${REQUIRED_WINTER_RUNTIME_SDK})`);
  if (mismatches.length > 0) throw new Error(`VERSIONS.json disagrees with this build's pins: ${mismatches.join("; ")}`);
  return out;
}

/** Parses and validates `runtimes/ant/VERSIONS.json` (shape only — the pin comparison is
 *  `release-lib.ts`'s `verifyAntEmbed`, against the repo-root VERSIONS.json the release is cut from). */
export function parseAntVersionsJson(text: string): AntVersionsJson {
  const v = parseObject(text, "ant/VERSIONS.json");
  if (v.schema !== 1) throw new Error(`ant/VERSIONS.json: unsupported schema ${String(v.schema)} (expected 1)`);
  const { str, sha } = fieldReaders(v, "ant/VERSIONS.json");
  return { schema: 1, tag: str("tag"), checksums: { antPreSign: sha("antPreSign") }, stagedAt: str("stagedAt") };
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
 * `ant auth login`/`ant auth print-credentials` is shelled out to for the Console's bearer material.
 *
 * UNLIKE `resolveWinterExecutable`, a miss here is never a typed refusal — `ant` is OPTIONAL to the
 * daemon: only the Console login and its bearer refresh depend on it, and the broker already has its
 * own typed failure for "no ant available" at the point that actually matters. So this ladder just
 * returns `undefined` on a total miss.
 *
 * The ladder, exactly (Interfaces): `settings.runtimes.antExecutable` → `$WINTER_ANT_EXECUTABLE` →
 * the bundle path (`antExecutablePath`, gated on existing AND being executable) → `which ant`
 * (dev-only) → `undefined`.
 *
 * Winter Phase 10a fix wave (M6): the `which ant` rung used to be dev-only in EFFECT ONLY ("a
 * Release bundle's own rung above always succeeds, so this is only ever reached when nothing was
 * embedded") rather than by construction — a `Bun.which`/PATH search works identically whether this
 * process is compiled or not. A staging bug
 * or a tampered Release install missing its embedded `ant` would previously fall through to
 * whatever `ant` happened to sit on the real machine's `$PATH` — a binary this daemon never
 * vetted, in an app bundle that otherwise embeds and re-signs everything it runs. This rung is now
 * gated: `isCompiledBinary()`
 * (overridable via `isCompiled`, the same test-seam shape as every other rung here) skips it
 * entirely for a compiled process, so a Release binary with a missing/corrupt embedded `ant`
 * reports "not found" (the broker's own typed failure), never a silent substitution.
 *
 * An explicit setting/env value is trusted as given, with NO existence check — unlike the winter
 * ladder's "an explicit-but-missing path IS the failure" rule. There is no typed
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
