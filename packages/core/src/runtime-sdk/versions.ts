import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { SDK_VERSION } from "@yanlinglabs/winter-agent-sdk";

/** The exact peer versions this daemon was written against (P8b-3). The ^ ranges in package.json
 *  are what INSTALLS; these are what the tests PROVE installed. Bump together with the pins. */
export const REQUIRED_WINTER_AGENT_SDK = "0.0.7";
export const REQUIRED_WINTER_RUNTIME_SDK = "0.0.4";
/** P8c-3/versions: the official peer is pinned EXACT (`"0.3.250"` in package.json, no `^`) — the
 *  ladder's package door and the router's own `assertVersionMatrix` both key off this string
 *  matching the installed wrapper's manifest, never a range. */
export const REQUIRED_CLAUDE_AGENT_SDK = "0.3.250";

/**
 * The installed `@anthropic-ai/claude-agent-sdk`'s own declared version, or `undefined` when the
 * optional peer is not installed at all (Winter-only host — never a throw).
 *
 * `createRequire` resolves against a REAL `node_modules`, which is exactly the doorway
 * `official-executable.ts`'s package door already depends on and exactly what does NOT exist inside
 * a compiled `$bunfs` binary (P8b-4's own reasoning) — so this answers `undefined` there too, and
 * `create.ts`'s own installed===REQUIRED check (Task 1.1) is what refuses the OFFICIAL leg on a
 * mismatch, never the daemon as a whole.
 */
export function installedClaudeAgentSdkVersion(): string | undefined {
  try {
    const pkgJsonPath = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk/package.json");
    return (JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { version: string }).version;
  } catch {
    return undefined;
  }
}

/** Host-declared peer versions (router 0.0.2 consults these FIRST — the only answer that works
 *  inside a compiled $bunfs binary, where createRequire cannot resolve a manifest). P8b-4.
 *  `claudeAgentSdk` is OMITTED (never `undefined`-valued) when the optional peer is not installed —
 *  a Winter-only host must not carry a stray key the router's version matrix would try to satisfy. */
export const WINTER_PEER_VERSIONS: { winterAgentSdk: string; claudeAgentSdk?: string } = {
  winterAgentSdk: SDK_VERSION,
  ...(installedClaudeAgentSdkVersion() === undefined ? {} : { claudeAgentSdk: installedClaudeAgentSdkVersion()! }),
};

/**
 * Winter Phase 10a fix wave (C1-interim): the router version the console auth arm needs. The
 * PINNED `@yanlinglabs/winter-runtime-sdk@0.0.3` forwards only `MINIMAL_OS_VARIABLES` from `base`
 * and runs `officialCredentialPlan` itself regardless of arm — so a console child spawned against
 * it would get the OAuth bearer profile injected as `ANTHROPIC_API_KEY` by the router's own
 * api-key-family logic, not read the profile file at all. `official-options.ts`'s
 * `officialInputFor` compares the INSTALLED router version (never `REQUIRED_WINTER_RUNTIME_SDK`,
 * the daemon's own pin) against this constant, so the refusal flips off automatically the moment a
 * future pin bump actually installs a matching router — no second edit required here.
 */
export const CONSOLE_AUTH_ROUTER_MIN = "0.0.4";

/**
 * The installed `@yanlinglabs/winter-runtime-sdk`'s own declared version — same `createRequire`
 * doorway as `installedClaudeAgentSdkVersion` above, for the identical reason (works from a real
 * `node_modules`; answers `undefined` inside a compiled `$bunfs` binary, where this required
 * dependency's own manifest cannot be resolved either).
 */
export function installedWinterRuntimeSdkVersion(): string | undefined {
  try {
    const pkgJsonPath = createRequire(import.meta.url).resolve("@yanlinglabs/winter-runtime-sdk/package.json");
    return (JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { version: string }).version;
  } catch {
    return undefined;
  }
}

/**
 * A plain per-component numeric comparison (`"0.0.10"` sorts ABOVE `"0.0.4"`, unlike a
 * lexicographic string compare) — every version this function ever sees is a bare
 * `MAJOR.MINOR.PATCH` triplet (this repo's own pins, the router's own releases), never a
 * pre-release/build-metadata suffix, so nothing fancier is needed. `undefined` (the peer's version
 * could not be resolved at all) is never "at least" anything.
 */
export function versionAtLeast(installed: string | undefined, min: string): boolean {
  if (installed === undefined) return false;
  const a = installed.split(".").map((n) => Number.parseInt(n, 10));
  const b = min.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai !== bi) return ai > bi;
  }
  return true;
}
