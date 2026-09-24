/// <reference path="./claude-agent-sdk-manifest.ts" />
// (The reference pulls the ambient manifest declaration into EVERY program that compiles this file —
// the CLI's tsconfig reaches core only through its imports, never by globbing core's `src`.)
import { SDK_VERSION } from "@yanlinglabs/winter-agent-sdk";
import { readResolvedManifestVersion } from "@yanlinglabs/winter-runtime-sdk";
// The wrapper's manifest, EMBEDDED by `bun build --compile` (typed by `claude-agent-sdk-manifest.ts`
// — the package's `exports` map does not list `./package.json`, so TypeScript cannot resolve it on
// its own; bun resolves and bundles it regardless, measured in a `--compile` binary). A JSON file,
// not the SDK's code: importing it evaluates nothing of the SDK.
import claudeAgentSdkManifest from "@anthropic-ai/claude-agent-sdk/package.json" with { type: "json" };

/** The exact peer versions this daemon was written against (P8b-3). The ^ ranges in package.json
 *  are what INSTALLS; these are what the tests PROVE installed. Bump together with the pins. */
export const REQUIRED_WINTER_AGENT_SDK = "0.0.22";
/** Bumped to 0.0.22 (R.4, WS-21 publish, 2026-09-24): the shared `~/.winter/sdk` default home and
 *  `$WINTER_STORE_HOME`, plugins in claude's own format (`hooks.json`, directory marketplaces,
 *  `resolvesWithinPluginRoot`), an MCP tool list rebuilt per request with claude's up-to-2s
 *  first-turn connect wait and an unoffered-tool refusal, recursive subagent scope, and (SDK round 24)
 *  `mapChatMessages` merging consecutive same-role assistant entries so chat-completions-shaped
 *  providers (DeepSeek, zai, OpenRouter, …) accept a turn after a parallel-tool-call batch. Tagged
 *  v0.0.21 first; that release's CI run failed on pre-existing, unrelated test/build defects (no
 *  behavioural change), so the fixed build published as v0.0.22 instead — v0.0.21 was never
 *  published and this pin skips straight to it. */
/** Bumped to 0.0.13 (R.4, WS-21 publish, 2026-09-24): 0.0.12 raised the router's own SDK peer floor
 *  to `>=0.0.21 <0.1.0` and shipped the SV-12/F2 fix — a claude turn's parallel tool-call batch is
 *  spliced back together by `tool_use_id` (siblings, then results after the batch's last assistant
 *  entry) in both `rebuildProviderMessages` and `switchFactsFor`, so a same-session Claude → GPT
 *  switch after a parallel-tool-call turn no longer reaches the provider with an unanswered call —
 *  plus a `deepseek/deepseek-reasoner` catalog rename fix. 0.0.12 was tagged but its release CI
 *  failed on a timing-dependent control (a test asserting claude's own scheduler behaviour, not a
 *  containment failure) and was never published; 0.0.13 loosens that control only and republishes
 *  the same behavioural content — this pin skips 0.0.12 straight to it.
 *  Bumped to 0.0.11 (lane B, 2026-09-23): the router no longer names `<cwd>/.winter` as a local plugin
 *  on the official leg — measured by its own tests, a cloned repository's `hooks/hooks.json` ran on a
 *  Code session's first prompt through it, with no trust decision anywhere — and gained
 *  `OptionsTemplatePolicy.plugins`, through which the daemon hands the SAME skills-only plugin views the
 *  Winter leg gets (`official-options.ts`'s `skillPlugins`). A router below this still names the
 *  project dir itself, so this pin is also the floor.
 *
 *  0.0.10 (the official leg's LIVE permission-mode change): the router's `OfficialQuery`
 *  gained `setPermissionMode(mode)`, so `OfficialSession.setPolicy` can tell a RUNNING claude child
 *  about an approval-mode change instead of waiting for its next incarnation. No floor constant of
 *  the `CONSOLE_AUTH_ROUTER_MIN` kind is needed for it: that pattern exists for a feature whose floor
 *  is ABOVE the current pin, and this pin IS the floor — a router below it does not type-check here
 *  at all, and the installed===REQUIRED gate is what proves the running daemon has it.
 *  0.0.9 (daemon settings surface batch 3) added `OptionsTemplatePolicy.agents?:
 *  Readonly<Record<string, unknown>>` — the router-package wall `official-options.ts`'s own comment
 *  on `OfficialInputDeps.agents` used to name (a router version this low has no field to forward the
 *  daemon's merged subagent definitions through) is CLOSED as of that pin. */
export const REQUIRED_WINTER_RUNTIME_SDK = "0.0.13";
/** P8c-3/versions: the official peer is pinned EXACT (`"0.3.250"` in package.json, no `^`) — the
 *  ladder's package door and the router's own `assertVersionMatrix` both key off this string
 *  matching the installed wrapper's manifest, never a range. */
export const REQUIRED_CLAUDE_AGENT_SDK = "0.3.250";

/**
 * The `@anthropic-ai/claude-agent-sdk` wrapper's own declared version — the copy THIS process
 * actually loads — or `undefined` when it cannot be established (never a throw).
 *
 * A2 (2026-09-22): read from the manifest the bundler EMBEDS beside the wrapper's code (the static
 * JSON import above), not from a `createRequire` probe of `node_modules`. That probe answered
 * `undefined` inside every compiled `$bunfs` binary — there is no `node_modules` there — so the
 * shipped daemon handed the router a loaded `claude` peer with no declared version, and the
 * router's version matrix (which then looks for a `package.json` on disk itself) threw
 * `RuntimeSdkVersionError`, failing the whole handle. That was masked in the dist app only because
 * the peer never loaded at all there (the missing JIT entitlement — see `create.ts`). The bundled
 * manifest is the same file in dev and compiled builds, so this is now the one answer everywhere.
 */
export function installedClaudeAgentSdkVersion(): string | undefined {
  const version = (claudeAgentSdkManifest as { version?: unknown } | undefined)?.version;
  return typeof version === "string" && version !== "" ? version : undefined;
}

/**
 * Daemon settings surface (2026-09-17 plan, item 3): the installed `@yanlinglabs/winter-runtime-sdk`
 * (the router)'s own declared version, or `undefined` when it cannot be resolved — a compiled
 * `$bunfs` binary, per `readResolvedManifestVersion`'s own doc (it walks up from the resolved entry
 * file to find a `package.json`, which does not exist inside the bundle), never a throw. This is
 * NOT `WINTER_PEER_VERSIONS.winterAgentSdk` (the WRAPPER's own `SDK_VERSION`, re-exported by that
 * package) — it is the ROUTER package's own manifest, the third installed peer `versions.get` reports
 * alongside it and `installedClaudeAgentSdkVersion()`.
 */
export function installedWinterRuntimeSdkVersion(): string | undefined {
  try {
    return readResolvedManifestVersion("@yanlinglabs/winter-runtime-sdk");
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
