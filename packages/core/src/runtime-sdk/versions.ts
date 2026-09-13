import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { SDK_VERSION } from "@yanlinglabs/winter-agent-sdk";

/** The exact peer versions this daemon was written against (P8b-3). The ^ ranges in package.json
 *  are what INSTALLS; these are what the tests PROVE installed. Bump together with the pins. */
export const REQUIRED_WINTER_AGENT_SDK = "0.0.9";
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
 * Winter Phase 10a fix wave (C1-interim; F1 corrected the comparison target): the router version
 * the console auth arm needs. A router below this floor forwards only `MINIMAL_OS_VARIABLES` from
 * `base` and runs `officialCredentialPlan` itself regardless of arm — so a console child spawned
 * against it would get the OAuth bearer profile injected as `ANTHROPIC_API_KEY` by the router's own
 * api-key-family logic, not read the profile file at all. `official-options.ts`'s
 * `officialInputFor` compares the COMPILE-TIME PIN (`REQUIRED_WINTER_RUNTIME_SDK`, above) against
 * this constant — never a runtime probe of the installed package (F1: that probe always answers
 * `undefined` inside a compiled `$bunfs` binary) — so the refusal flips off automatically the
 * moment a future pin bump actually raises `REQUIRED_WINTER_RUNTIME_SDK` to this floor or above.
 */
export const CONSOLE_AUTH_ROUTER_MIN = "0.0.4";

/**
 * Winter Phase 10a fix wave (F2 corrected design, M-A): the `@yanlinglabs/winter-agent-sdk` floor
 * the console login/logout doors need. Below this floor (measured against the installed 0.0.7) the
 * SDK's `startAnthropicConsoleBrokerLogin`/`logoutAnthropicConsole` spawn `claude auth login
 * --console`/`claude auth logout` — which was measured NOT to write the profile file at all (it
 * mints a Console API key into `CLAUDE_CONFIG_DIR` instead) — rather than the single intended door,
 * `ant auth login --profile winter`. Compared against the COMPILE-TIME PIN
 * (`REQUIRED_WINTER_AGENT_SDK`, above), same F1 pattern as `CONSOLE_AUTH_ROUTER_MIN`: never a
 * runtime probe of the installed package, so the refusal flips off automatically the moment a pin
 * bump actually raises `REQUIRED_WINTER_AGENT_SDK` to this floor or above.
 */
export const CONSOLE_BROKER_SDK_MIN = "0.0.9";

/**
 * Pre-release hardening (P9c-1 amendment): the compile-time approval gate on
 * `runtimes.official.subscriptionAuth` — same posture as the router's own
 * `D14_CLAUDE_OAUTH_APPROVED_DEFAULT` (a compile-time approval constant kept separate from any
 * runtime setting; `runtime-sdk/create.ts` reads it, never a settings key, at its own two call
 * sites). The official Claude leg must never authenticate with a claude.ai subscription until
 * Anthropic approves it for this integration — so the settings flag ALONE must never be able to
 * open that door. `officialSubscriptionAuthEnabled` (`../settings.ts`) ANDs the flag against this
 * constant; flipping the flag in settings.json while this constant stays `false` is INERT (logged
 * once per settings change, `settings-apply.ts`/`daemon.ts`), never a silent widen. Only a reviewed
 * code change to THIS constant — never a test, never a settings override in production — may flip
 * it. Tests that need to exercise the "approved" branch use the injectable override parameter
 * `officialSubscriptionAuthEnabled`/`OfficialInputDeps.officialSubscriptionAuthApproved` accept,
 * never by editing this constant.
 */
export const OFFICIAL_SUBSCRIPTION_AUTH_APPROVED = false;

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
