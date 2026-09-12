// Winter Phase 8d (ruling P8d-1): the ONE place the Release bundle's runtime layout is spelled.
//
// `Winter.app/Contents/Resources/` holds `winter-core` (the daemon — `process.execPath` in a compiled
// build), so `dirname(execPath)` is that directory and every runtime payload sits under its
// `runtimes/` subtree (WS-02 §7.1's placement; final subpaths owned by the app project):
//
//   runtimes/winter                         # the pinned-tag `winter` build, re-signed under Winter's team identity
//   runtimes/claude-official/claude         # the UNMODIFIED Anthropic binary (signature preserved, never re-signed)
//   runtimes/claude-official/VERSIONS.json  # { schema, winterAgentSdk, winterRuntimeSdk, officialSdk, claudeCode, checksums, stagedAt }
//
// Both executable ladders (`executable.ts`, `official-executable.ts`) probe their "bundle" rung
// through `bundleRuntimePath`; `scripts/stage-runtimes.ts` writes this exact layout; the compiled
// probe (`runtimes-probe.ts`) and `release.ts` verify it. Nothing else re-derives these strings.
import { join, dirname } from "node:path";
import { REQUIRED_CLAUDE_AGENT_SDK, REQUIRED_WINTER_AGENT_SDK, REQUIRED_WINTER_RUNTIME_SDK } from "./versions";

export const RUNTIME_BUNDLE_LAYOUT = {
  root: "runtimes",
  winter: "runtimes/winter",
  claude: "runtimes/claude-official/claude",
  versions: "runtimes/claude-official/VERSIONS.json",
} as const;

export type RuntimeBundleEntry = keyof typeof RUNTIME_BUNDLE_LAYOUT;

/** `<dirname(execPath)>/<layout entry>` — the bundle rung of both ladders. */
export function bundleRuntimePath(execPath: string, entry: RuntimeBundleEntry): string {
  return join(dirname(execPath), RUNTIME_BUNDLE_LAYOUT[entry]);
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
  checksums: { winterPreSign: string; claude: string };
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
    checksums: { winterPreSign: sha("winterPreSign"), claude: sha("claude") },
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
