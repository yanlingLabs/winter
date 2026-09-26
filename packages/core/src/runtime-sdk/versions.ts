import { SDK_VERSION } from "@yanlinglabs/winter-agent-sdk";
import { readResolvedManifestVersion } from "@yanlinglabs/winter-runtime-sdk";

/** The exact peer versions this daemon was written against (P8b-3). The ^ ranges in package.json
 *  are what INSTALLS; these are what the tests PROVE installed. Bump together with the pins. */
export const REQUIRED_WINTER_AGENT_SDK = "0.0.27";
/** Bumped to 0.0.27 (2026-09-26, WS-23; 0.0.25 and 0.0.26 were tagged but their release CI stopped at the
 *  test step, so neither was published): every model on the Winter SDK (xAI Responses, MCP v2, hooks, the
 *  Anthropic hardening + caching, per-message effort, mid-conversation tool changes, the reasoning-state
 *  sidecar, and the embedded runtime `@yanlinglabs/winter-agent-runtime`).
 *  Before that, bumped to 0.0.24 (2026-09-25; 0.0.23 was published the same day but never pinned here): 0.0.23's
 *  first-party provider/model catalog refresh — 213 providers, 1000
 *  models, 22 families (China-region and plan/dialect twins as separate providers, GPT-6 Sol/Luna,
 *  Opus 5.5, Xiaomi MiMo, Tencent TokenHub, the Meta Model API, …); the `gpt` family's sol/luna slots
 *  move to GPT-6 and the `claude` opus slot (+ `opus` alias) to Opus 5.5 — plus 0.0.24's audit fixes and
 *  the Winter-leg Anthropic adapter fix (effort via `output_config.effort` + adaptive thinking on Claude 4.5+,
 *  per-row thinking/tool_choice rewrites, the block-binding opt-in on Opus 5.5 / Fable 5.1, and dotted
 *  Claude ids sent as their dashed wire id). */
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
 *  Winter leg gets. A router below this still names the project dir itself, so this pin is also the
 *  floor.
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
export const REQUIRED_WINTER_RUNTIME_SDK = "0.0.14";
// WS-23: `REQUIRED_CLAUDE_AGENT_SDK`, `installedClaudeAgentSdkVersion` (and the embedded manifest it
// read) and `OFFICIAL_SUBSCRIPTION_AUTH_APPROVED` are gone with the official `claude` leg; the daemon
// no longer depends on `@anthropic-ai/claude-agent-sdk` at all.

/**
 * Daemon settings surface (2026-09-17 plan, item 3): the installed `@yanlinglabs/winter-runtime-sdk`
 * (the router)'s own declared version, or `undefined` when it cannot be resolved — a compiled
 * `$bunfs` binary, per `readResolvedManifestVersion`'s own doc (it walks up from the resolved entry
 * file to find a `package.json`, which does not exist inside the bundle), never a throw. This is
 * NOT `WINTER_PEER_VERSIONS.winterAgentSdk` (the WRAPPER's own `SDK_VERSION`, re-exported by that
 * package) — it is the ROUTER package's own manifest, the second installed peer `versions.get`
 * reports.
 */
export function installedWinterRuntimeSdkVersion(): string | undefined {
  try {
    return readResolvedManifestVersion("@yanlinglabs/winter-runtime-sdk");
  } catch {
    return undefined;
  }
}

/** Host-declared peer versions (router 0.0.2 consults these FIRST — the only answer that works
 *  inside a compiled $bunfs binary, where createRequire cannot resolve a manifest). P8b-4. WS-23: the
 *  Winter peer is the only one. */
export const WINTER_PEER_VERSIONS: { winterAgentSdk: string } = {
  winterAgentSdk: SDK_VERSION,
};

/**
 * Winter Phase 10a fix wave (F2 corrected design, M-A): the `@yanlinglabs/winter-agent-sdk` floor
 * the console login/logout doors need. Below this floor (measured against the installed 0.0.7) the
 * SDK's `startAnthropicConsoleBrokerLogin`/`logoutAnthropicConsole` spawn `claude auth login
 * --console`/`claude auth logout` — which was measured NOT to write the profile file at all (it
 * mints a Console API key into `CLAUDE_CONFIG_DIR` instead) — rather than the single intended door,
 * `ant auth login --profile winter`. Compared against the COMPILE-TIME PIN
 * (`REQUIRED_WINTER_AGENT_SDK`, above), never a runtime probe of the installed package (F1: that
 * probe always answers `undefined` inside a compiled `$bunfs` binary), so the refusal flips off
 * automatically the moment a pin bump actually raises `REQUIRED_WINTER_AGENT_SDK` to this floor or
 * above.
 */
export const CONSOLE_BROKER_SDK_MIN = "0.0.9";

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
