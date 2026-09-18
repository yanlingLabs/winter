// P8c Task 1.2 — `officialInputFor`: THE `RouterOfficialInput` for one official-leg session,
// re-built on every incarnation (mirrors `mode-options.ts`'s `buildWinterOptions`'s own "re-read the
// session's LIVE facts" posture — nothing here is snapshotted at session creation).
//
// Fix round 1 (item 0): router 0.0.3 publishes `createApprovalBridge`/`minimalOsEnvironmentFrom`
// at the package root. `minimalOsEnvironment` below stays Winter's own hand-built version (`HOME`/
// `PATH`/`LANG`/`LC_ALL`/`TERM`) rather than switching to `minimalOsEnvironmentFrom` — the two do
// the identical §3 job and Winter's own version is what every existing test already pins; recorded
// as a deliberate "no functional gap, no reason to churn a passing seam" choice, not an oversight.
// The REAL fix this round makes is `officialBrokerFor`: it now builds the router's own
// `ApprovalBroker` shape (`(request: ApprovalRequest) => Promise<PermissionResult>`) and
// `officialInputFor` wraps it with the router's real `createApprovalBridge({broker, brand, mode,
// containment})` at construction — the 0.0.2-era fail-closed-default workaround and its
// `P8c-L1-BLOCKER` note are DELETED.
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isVendorCompliantProjectKey, transcriptProjectKey, type CredentialRef, type McpServerConfig, type PermissionResult, type ProviderSelection } from "@yanlinglabs/winter-agent-sdk";
import { createApprovalBridge, officialConnectionEnv, officialCredentialPlan, type ApprovalRequest, type OfficialPermissionMode as RouterOfficialPermissionMode, type RouterOfficialInput, type RuntimeSelection } from "@yanlinglabs/winter-runtime-sdk";
import type { ContextAssembler } from "../agent/context";
import type { SessionApprovalPolicy } from "../agent/gate";
import type { Mode as SessionMode } from "../agent/tools/registry";
import { assistantMemoryDirFor, memoryDirFor, type MemoryDirOptions } from "../agent/memory-dir";
import type { CapabilityServerRecord } from "../capabilities";
import { officialSubscriptionAuthEnabled, type Settings } from "../settings";
import { canUseToolFor, type CanUseToolDeps } from "./approval-bridge";
import { CORE_BRAND } from "./brand";
import { GLOBAL_READ_ALLOW_RULES, permissionDenyRulesFor, disallowedToolsFor, sandboxConfigFor } from "./mode-options";
import { officialCapabilityServersFor, type OfficialMcpModule } from "./official-capabilities";
import { winterSystemPromptFor } from "./system-prompt";
import { ClaudeExecutableUnavailable } from "./official-executable";
import type { OfficialPeer } from "./create";
import { CONSOLE_AUTH_ROUTER_MIN, REQUIRED_WINTER_RUNTIME_SDK, versionAtLeast } from "./versions";
import { splitTag } from "./model-tag";

/**
 * Phase 9c (P9c-1, WS-00 §8 #1): env names the official leg's spawned child must NEVER inherit
 * from the daemon's own process — the credential plan (`officialCredentialPlan`, above) alone
 * injects the ONE variable it names for this session's family, and this leg sets its own
 * `CLAUDE_CONFIG_DIR` (`officialConfigDirFor`, below) rather than letting the daemon's own value
 * (a developer's shell, say) leak through. `minimalOsEnvironment`'s allowlist already excludes
 * every one of these (none overlaps `HOME`/`PATH`/`LANG`/`LC_ALL`/`TERM`), so the explicit strip in
 * `officialInputFor` is defence in depth against a FUTURE change to that allowlist, never a gap in
 * it today — this constant is what a test iterates to prove the strip is exhaustive, and what a
 * later change to the allowlist has to keep in mind.
 */
export const FORBIDDEN_CHILD_ENV = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "CLAUDE_CONFIG_DIR",
] as const satisfies readonly string[];

/**
 * Phase 9c (P9c-1): the Winter-owned `CLAUDE_CONFIG_DIR` (the router's own
 * `RouterOfficialInput.spool` — WS-14 §1 profile 1) this leg spawns every session against while
 * `runtimes.official.subscriptionAuth` is off (the shipped default, and the only value P9c-1
 * allows before Anthropic approves subscription auth for this integration).
 *
 * NEVER the vendor's own `~/.claude` — the router's own `VENDOR_HOME_SEGMENT_RE` refuses ANY
 * config dir under a `.claude` path segment outright, unconditionally, regardless of this setting
 * (WS-14 §1/§3, WS-17 row 4; measured against the installed router package, `index-mfd2rg7x.js`'s
 * `validateObservedConfigDir`) — so this name is deliberately `claude-config` (a hyphen, never a
 * dot) rather than anything that could ever collide with that guard. Also never the router's own
 * default spool name (`officialSpoolRoot`, `<home>/runtimes/official-agent-spool` — already
 * provisioned 0700 at boot by `winter-dir.ts` for the router to fall back on when this leg
 * deliberately does NOT override `spool`, i.e. while the flag is on): this leg names, creates and
 * hardens ITS OWN directory for the audited, API-key-only default, rather than depending on a
 * third-party package's own default nobody here pins.
 */
export function officialConfigDirFor(home: string): string {
  return join(home, "runtimes", "claude-config");
}

/**
 * `officialConfigDirFor`'s own directory, created lazily (0700) the first time a session actually
 * spawns against it — never at import time, and never by a boot-time sweep this file does not own
 * (`winter-dir.ts`'s own `SUBDIRS` is Lane M's, not this one's). `chmodSync` runs even when the
 * directory already existed, so a stale, more permissive mode is corrected on every spawn, not just
 * the first.
 *
 * CALLED FROM `official-session.ts`'s `open()`, NEVER from `officialInputFor` itself — so
 * `officialInputFor` stays a pure(-ish) path computation, and disk is touched only by a caller that
 * is actually about to spawn (or fake-spawn) a session.
 *
 * WHO ACTUALLY REACHES `open()` (fix round 1, review r0's Major — corrected from an earlier,
 * inaccurate claim that no test here touches disk at all): `official-options.test.ts`'s OWN tests
 * call `officialInputFor` directly and never `open()`, so its `minimalDeps()`'s symbolic
 * `/Users/x/.winter-test-home` is genuinely never filesystem-backed. `official-session.test.ts`'s
 * `harness()` DOES call `open()` (over a fake `OfficialQuery`, never a real child) and so DOES
 * create/chmod a real directory — its own `home` is `testHome()`, a fresh `mkdtempSync` root per
 * `harness()` call, cleaned in that file's own `afterAll`. `official-leg.e2e.test.ts`'s
 * `buildWorld`/`makeSession` DO call `open()` against a real spawned `claude` child and a real
 * `mkdtempSync`-rooted `WINTER_HOME`, cleaned in that file's own `afterEach`/`finally` blocks.
 */
export function ensureOfficialConfigDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
}

/**
 * Winter Phase 10a (P10a-2, corrected fix wave 3 M-A): "one profile, one config dir" — the
 * Anthropic Platform CLI (`ant`) reads/writes its login profile under this directory
 * (`ANTHROPIC_CONFIG_DIR`), a sibling of `officialConfigDirFor`'s own `claude-config` directory
 * rather than the same one: `CLAUDE_CONFIG_DIR` (the vendor `claude` CLI's own session-transcript
 * spool) and `ANTHROPIC_CONFIG_DIR` (the profile-credential store `ant` reads/writes) are two
 * different vendor-defined roots, still both set on an official-leg child at once (P10a-2) —
 * collapsing them into one directory would let a future vendor CLI change have the transcript
 * spool and the credential store collide. MEASURED (2026-09-13): `claude auth login --console`
 * does NOT write anything under this directory at all — it mints a Console API key into
 * `CLAUDE_CONFIG_DIR` instead — so `claude` is never a second writer here; the single login/logout
 * door is `ant auth login`/`logout --profile winter` (`console-profile-broker.ts`, fix wave 3 M-A).
 *
 * Hardened 0700 at `login()`'s own call site AND the watcher's own `startWatcher()`
 * (`console-profile-broker.ts`), the SAME `ensureOfficialConfigDir` helper above — that function
 * is already dir-path-agnostic, so neither door needs its own copy.
 */
// WS-20: `anthropicConfigDirFor`/`ANTHROPIC_PROFILE_NAME`/`consoleProfileCredentialFile` moved to
// `./anthropic-paths` (a pure module settings.ts's migration can import without a cycle) — re-exported
// here so every existing importer of this module keeps working unchanged.
export { anthropicConfigDirFor, ANTHROPIC_PROFILE_NAME, consoleProfileCredentialFile } from "./anthropic-paths";
import { anthropicConfigDirFor, ANTHROPIC_PROFILE_NAME, consoleProfileCredentialFile } from "./anthropic-paths";

/** The official leg's two shippable, mutually-exclusive auth arms (P10a-3) — a NARROWER type than
 *  the router's own `RuntimeSelection["authFamily"]` (which also has `console-oauth`/`bedrock`/
 *  `vertex`/`claude-oauth`/`local-none`, none of which this decision touches): this door decides
 *  only "does THIS session's child read a Console profile off disk, or an env-injected API key",
 *  never which router-level credential family carries it. */
export type OfficialAuthFamily = "api-key" | "console";

/**
 * WS-20: the official leg's auth arm is the tag's OWN PREFIX — `console/*` selections run the
 * Console profile arm, every other provider (`anthropic/*`, and any future non-Claude provider
 * that somehow lands here) runs the api-key arm. No settings read, no live on-disk probe, no
 * "auto" fallback: `runtimes.official.auth` and `officialAuthFamilyFor` (the settings-driven
 * decision this replaces) are REMOVED, not deprecated — the arm was already decided the moment
 * the router picked `selection.providerId`/`modelRef`, so re-deciding it here from live state
 * could only ever disagree with the session's own recorded selection, never improve on it.
 */
export function officialAuthArmFor(selection: { modelRef: string }): OfficialAuthFamily {
  return splitTag(selection.modelRef).providerId === "console" ? "console" : "api-key";
}

/**
 * Winter Phase 10a (P10a-2): the child-env contribution for ONE auth arm, on top of
 * `minimalOsEnvironment`'s allowlist and the `FORBIDDEN_CHILD_ENV` strip — never a substitute for
 * either. The console arm sets exactly `ANTHROPIC_PROFILE` + `ANTHROPIC_CONFIG_DIR` (P10a-2: "one
 * profile, one config dir") and NEVER `ANTHROPIC_API_KEY` (that variable belongs to the api-key
 * arm's own credential plan, `officialCredentialPlan`'s `AUTH_FAMILY_VARIABLES["api-key"]`, which
 * this door has nothing to do with); the api-key arm sets nothing at all — no `ANTHROPIC_PROFILE`,
 * so a stray on-disk console profile can never outrank the pinned API key at the vendor CLI's own
 * precedence order.
 *
 * A plain, pure `(family, home) -> env` function rather than a branch inlined into
 * `officialInputFor` — the plan's own O2 task tests this door directly, independent of the
 * `RuntimeSelection`-keyed spawn decision `officialInputFor`/`session-driver.ts` make (out of this
 * lane's file cluster; see this module's own header for the split).
 */
export function officialAuthChildEnvFor(family: OfficialAuthFamily, home: string): Record<string, string> {
  if (family === "console") {
    return { ANTHROPIC_PROFILE: ANTHROPIC_PROFILE_NAME, ANTHROPIC_CONFIG_DIR: anthropicConfigDirFor(home) };
  }
  return {};
}

/**
 * WS-20: `provider.status`'s own "which credentials actually exist" report — presence ALONE, no
 * `auth` pin to consult any more (there is no standing arm SETTING left; the arm is decided per
 * session by the tag's own prefix, `officialAuthArmFor`). `"both"` when the api-key material AND
 * the console profile both exist — a session's own tag decides which one it actually uses, and
 * this function does not guess on the caller's behalf.
 */
export function effectiveOfficialAuthFor(
  apiKey: boolean,
  consoleProfile: boolean,
): "both" | "api-key" | "console" | "none" {
  if (apiKey && consoleProfile) return "both";
  if (consoleProfile) return "console";
  if (apiKey) return "api-key";
  return "none";
}

/** P8c-2: the six-valued mapping `mode-options.ts`'s `permissionModeFor` already has, adapted for
 *  the official leg's OWN enum — same literal spellings (`default`/`plan`/`acceptEdits`/`dontAsk`),
 *  EXCEPT `bypass`, which `mode-options.ts` maps to Winter's `bypassPermissions` and which the
 *  official door's own `assertOptionsInvariants` REFUSES outright (D14/P8c-2: never
 *  `bypassPermissions` on this leg). `acceptEdits` is the closest non-bypass floor — every edit is
 *  pre-approved but every OTHER tool still reaches `canUseTool`, which is strictly more
 *  conservative than what `bypass` asked for, never less. */
export type OfficialPermissionMode = "default" | "plan" | "acceptEdits" | "dontAsk";

export function officialPermissionModeFor(policy: SessionApprovalPolicy): OfficialPermissionMode {
  switch (policy) {
    case "plan": return "plan";
    case "dont-ask": return "dontAsk";
    case "ask": return "default";
    case "accept-edits": return "acceptEdits";
    case "auto": return "default";
    case "bypass": return "acceptEdits"; // never bypassPermissions on this leg (D14/P8c-2)
    case "chat": return "default";
  }
}

/**
 * The router's own `ApprovalBroker` (`(request: ApprovalRequest) => Promise<PermissionResult>`),
 * built on 8b's `canUseToolFor` bridge so approval semantics — cards, policy gating, control-plane
 * denial — are byte-identical on both legs. `canUseToolFor`'s own signature is `(toolName, input,
 * ctx)`; `ApprovalRequest` carries both plus the ctx fields under ONE object, so this is a field
 * reshuffle, never a translation of MEANING. `PermissionResult` is never `null` on this door
 * (`canUseToolFor`'s own contract already guarantees a typed result), so no `?? deny` fallback is
 * needed the way the router's OWN default broker (for a session with none configured) has one.
 */
export function officialBrokerFor(deps: CanUseToolDeps): (request: ApprovalRequest) => Promise<PermissionResult> {
  const bridge = canUseToolFor(deps);
  return async (request: ApprovalRequest) => {
    const result = await bridge(request.toolName, request.input, {
      signal: request.signal,
      toolUseID: request.toolUseID,
      requestId: request.requestId,
      ...(request.agentID === undefined ? {} : { agentID: request.agentID }),
      ...(request.suggestions === undefined ? {} : { suggestions: request.suggestions }),
      ...(request.blockedPath === undefined ? {} : { blockedPath: request.blockedPath }),
    });
    // `CanUseTool`'s own type allows `null` (the SDK's "transport escape") — `canUseToolFor`'s own
    // header says its bridge "never uses the null transport escape", so this never actually fires;
    // it exists only so this function's return type can be the router's own non-null `ApprovalBroker`.
    return result ?? { behavior: "deny", message: "the host callback returned no decision", toolUseID: request.toolUseID };
  };
}

/** §3's minimal OS environment, by hand (the router's own `minimalOsEnvironmentFrom` is not
 *  reachable from the package root — see this file's header). `HOME`/`PATH` are load-bearing for a
 *  spawned child; `LANG`/`LC_ALL`/`TERM` are carried through only when the host process actually has
 *  them, never invented. */
export function minimalOsEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = { HOME: env.HOME ?? homedir(), PATH: env.PATH ?? "/usr/bin:/bin" };
  for (const name of ["LANG", "LC_ALL", "TERM"] as const) { const v = env[name]; if (v) out[name] = v; }
  return out;
}

/** The router's own `officialCredentialPlan` throws `RuntimeLaunchInputError` (unexported, so it is
 *  not `instanceof`-checkable here) when a non-`custom` family has no credential ref and no explicit
 *  plan — surfaced as a Winter-typed refusal rather than an uncaught throw out of this function. */
export class OfficialCredentialPlanRefused extends Error {
  readonly code = "official_credential_plan_refused" as const;
  constructor(detail: string) {
    super(`the official leg's credential plan could not be built: ${detail}`);
    this.name = "OfficialCredentialPlanRefused";
  }
}

export class OfficialProjectKeyTooDeep extends Error {
  readonly code = "official_project_key_too_deep" as const;
  constructor(readonly cwd: string, readonly key: string) {
    super(`the transcript project key for "${cwd}" ("${key}") exceeds the official runtime's own length limit; move the project to a shorter path or set a shorter WINTER_TMPDIR (WS-14 §3/R-4)`);
    this.name = "OfficialProjectKeyTooDeep";
  }
}

/**
 * Winter Phase 10a fix wave (F1): the console auth arm refuses typed, before anything is spawned,
 * while the PINNED `@yanlinglabs/winter-runtime-sdk` (`versions.ts`'s `REQUIRED_WINTER_RUNTIME_SDK`
 * — the compile-time constant, never a runtime probe of the installed package) is older than
 * `CONSOLE_AUTH_ROUTER_MIN` (`versions.ts`'s own doc explains why: a pre-upgrade router would
 * inject the OAuth bearer profile as `ANTHROPIC_API_KEY`, which is exactly the leak
 * `officialAuthChildEnvFor`'s console arm exists to prevent).
 *
 * Fix wave F1: this USED to compare the runtime-resolved `installedWinterRuntimeSdkVersion()`
 * against the floor — but that resolver depends on `createRequire` finding a real `node_modules`
 * manifest, which does not exist inside a compiled `$bunfs` binary (`versions.ts:57`'s own doc), so
 * it always answered `undefined` there and `versionAtLeast(undefined, …)` is always `false`
 * (`versions.ts:76`): every Release console session refused typed, permanently. The pin is the
 * right thing to compare in the first place — `bundle-layout.ts`'s `parseAndValidateVersionsJson`
 * (asserted by the pins test) already refuses to stage a Release bundle whose `VERSIONS.json`
 * disagrees with `REQUIRED_WINTER_RUNTIME_SDK`, so the pin and the actually-installed/staged router
 * are guaranteed equal in every environment that matters — no runtime probe is needed at all. This
 * refusal is still a STANDING guard, not a one-time migration note: it re-evaluates the pin on every
 * call (or the test-injected `OfficialInputDeps.requiredWinterRuntimeSdkVersion` override, used only
 * to simulate a pin below/at/above the floor) and stops refusing automatically the moment a pin bump
 * actually lands.
 */
export class OfficialConsoleRouterUnsupported extends Error {
  readonly code = "official_console_router_unsupported" as const;
  constructor(readonly installedRouterVersion: string | undefined, readonly requiredRouterVersion: string) {
    super(
      `the console auth arm needs @yanlinglabs/winter-runtime-sdk >= ${requiredRouterVersion} (the pinned router forwards ` +
      `only its own minimal OS environment and runs its api-key credential plan unconditionally, which would inject the ` +
      `console profile's OAuth bearer as ANTHROPIC_API_KEY); pinned ${installedRouterVersion ?? "unknown"} — sign in with ` +
      `an API key instead, or wait for the router upgrade`,
    );
    this.name = "OfficialConsoleRouterUnsupported";
  }
}

/**
 * Winter Phase 10a fix wave (F3, load-bearing guard): the console arm's OWN pre-spawn refusal when
 * `consoleProfileCredentialFile(home)` does not exist. This is NOT a convenience check — it is the
 * console arm's actual subscription guard. Measured (controller, 2026-09-13): a spawn's PRECEDENCE
 * is "the explicit profile outranks a stored claude.ai login" (an `ANTHROPIC_PROFILE`/
 * `ANTHROPIC_CONFIG_DIR` pair pointed at a real Console profile reports `authMethod: "oauth_token"`
 * even when a subscription login sits in the SAME config dir), but a MISSING profile silently FALLS
 * BACK to whatever claude.ai login is already stored there instead of refusing — so without this
 * check, `officialInputFor` would still assemble a spawn (`ANTHROPIC_PROFILE`/`ANTHROPIC_CONFIG_DIR`
 * set unconditionally on the console arm) that authenticates via a subscription Winter never
 * intended it to use. `CONSOLE_API_KEY_SOURCE`'s own doc explains why `apiKeySource` alone cannot
 * catch this after the fact (a subscription login reports the identical `"none"`) — THIS check,
 * run BEFORE that spawn, is what actually keeps P9c-1's "no subscription auth" rule while
 * `runtimes.official.subscriptionAuth` is off.
 *
 * MUST STAY A LIVE `existsSync` CALL ON EVERY SPAWN, never a cached/memoized answer or a decision
 * reused from an earlier call (e.g. `officialAuthFamilyFor`'s own arm SELECTION, computed once when
 * "auto" first resolves) — the profile can disappear between calls (`winter logout
 * --anthropic-console` deleting it out from under an already-open, about-to-resume session is
 * exactly the case this guard exists for), and reusing a stale "yes" would silently re-open the
 * same fallback-to-subscription hole this check exists to close.
 */
export class OfficialConsoleProfileMissing extends Error {
  readonly code = "console_profile_missing" as const;
  constructor(readonly home: string) {
    super(
      `the console auth arm has no on-disk profile at "${consoleProfileCredentialFile(home)}" — a missing profile falls ` +
      `back to any claude.ai login already stored in the same config dir instead of refusing, so this session refuses ` +
      `before spawning rather than risk authenticating as that login; sign in with \`winter login --anthropic-console\` ` +
      `(or \`ant auth login --profile ${ANTHROPIC_PROFILE_NAME}\` directly) first`,
    );
    this.name = "OfficialConsoleProfileMissing";
  }
}

export interface OfficialSessionInput {
  sessionId: string;
  parentSessionId?: string;
  mode: SessionMode;
  cwd: string;
  outDir?: string;
  extraDirs?: string[];
  effort?: string;
  /** `SessionMeta.origin` — `"dispatch-child"` skips the output style, same as the Winter leg. */
  origin?: string;
  displayName?: string;
  /** `WinterSystemPromptInput.primary`/`engine.ts`'s `primaryDir(sessionId)`, verbatim: the live
   *  `cwd` column, else the first `dirs` row — `undefined` for a genuinely workdir-less session.
   *  Distinct from `cwd` above (which the caller (`session-driver.ts`'s `sessionInput()`) already
   *  defaults to a session tmp dir when this is absent, exactly like the Winter leg's own `cwd`):
   *  collapsing the two before they reach this file would make a workdir-less session
   *  indistinguishable from a real single-directory one, which is what fed `autoMemoryDirectoryFor`
   *  the wrong bucket for that case before this field existed.
   *
   *  REQUIRED-but-possibly-undefined, deliberately not `primary?:` — the same shape
   *  `WinterSystemPromptInput.primary` uses. An OPTIONAL field would let a construction site simply
   *  forget it, and "forgot" would read as "workdir-less": a silent default deciding which memory
   *  bucket a session writes to, which is the exact class of bug this field was added to end. Every
   *  site must now SAY which it is, and the compiler checks that it did. */
  primary: string | undefined;
  /** The effort this session SPENDS — `session-driver.ts`'s `spendEffortFor`, the same function the
   *  Winter leg's `Options.effort` comes from. Distinct from `effort` above (the RAW stored value,
   *  possibly Winter's `ultra` tier, which only the system prompt reads). `official-session.ts` puts
   *  this on the query's top-level `Options.effort`, which the router forwards untouched.
   *
   *  Required-but-possibly-undefined for the same reason `primary` is: an optional field a
   *  construction site could forget is exactly how this leg came to send no effort at all. */
  spendEffort: import("@yanlinglabs/winter-agent-sdk").EffortLevel | undefined;
}

export interface OfficialInputDeps {
  /** WINTER_HOME. */
  home: string;
  /** This session's persisted/decided `RuntimeSelection` (P8c-12) — `officialCredentialPlan`'s
   *  own family-derivation key. */
  selection: RuntimeSelection;
  /** `provider-selection.ts`'s `providerSelectionFor(model, credentials)` result — carries the
   *  `authRef` a non-`custom` family's credential plan is auto-derived from. `undefined` is valid
   *  only for `custom`/`claude-oauth`/`local-none` families, or when the caller supplies BOTH
   *  `explicitCredentials` and (if needed) `explicitConnectionEnv` directly (the hermetic test
   *  bed's own shape — WS-14's `custom` family names its own variables). */
  provider?: ProviderSelection;
  /** Test/host escape hatch: names each variable and its ref directly, bypassing
   *  `officialCredentialPlan`'s family-derivation (the router's OWN `custom`-family precedent —
   *  `officialCredentialPlan` returns `explicit` immediately when it is set, for ANY family). */
  explicitCredentials?: readonly { variable: string; ref: CredentialRef }[];
  explicitConnectionEnv?: Readonly<Record<string, string>>;
  /** The already-resolved official peer (`runtime.officialPeer()`'s result) — `undefined` refuses
   *  typed rather than building an input nothing can launch with. */
  officialPeer: OfficialPeer | undefined;
  /** `runtime.claudeExecutableFor()` — re-resolved live, PER SESSION (door.ts: "a per-query
   *  `Options` value wins over" the constructor-time default), so a `runtimes.claudeExecutable`
   *  edit takes effect for the very next turn with no daemon restart. */
  claudeExecutableFor: () => { path: string } | ClaudeExecutableUnavailable;
  /** `"memoryDirFor"` is what `autoMemoryDirectoryFor` (below) calls to compute `autoMemoryDirectory`
   *  — the SAME method `winterSystemPromptFor`'s own `assemble()` call uses to build the system
   *  prompt's MEMDIR section, so this leg's child can no longer be told to write memory somewhere
   *  other than what its own prompt just named (see `ContextAssembler.memoryDirFor`'s own doc). */
  assembler: Pick<ContextAssembler, "assemble" | "memoryDirFor">;
  /** This session's already-built per-session Winter capability servers (`buildCapabilitiesFor`'s
   *  own output) — mirrored onto the official leg by `officialCapabilityServersFor` (P8c-4). */
  capabilities: CapabilityServerRecord;
  /** Daemon settings surface batch 3 (item 3): the SAME configured-server map the Winter leg's
   *  `extraMcpServers` produces (`external-mcp.ts`'s `configuredMcpServersFor` — `settings.
   *  mcpServers` + a trusted project's `.mcp.json`, minus anything in `settings.mcp.disabled`) —
   *  closes a pre-existing gap where user/project-configured MCP servers reached the Winter leg
   *  only. `session-driver.ts`'s `inputDeps()` already ran `assertNoCapabilityCollision` against it
   *  before this deps object was built, so this function trusts it collision-free and only decides
   *  merge ORDER (capability servers win, same precedence the Winter leg's own `{ ...extra,
   *  ...capabilities }` establishes). `undefined`/empty ⇒ byte-identical to before item 3. */
  configuredMcpServers?: Readonly<Record<string, McpServerConfig>>;
  /** Router 0.0.9: the daemon's merged (project-over-user) subagent definition map
   *  (`agent-definitions.ts`'s `mergeAgentDefinitionTiers`), the SAME map the Winter leg carries via
   *  `mode-options.ts`'s `buildWinterOptions` — one owner, one merge, both legs. Absent/empty means
   *  no `options.agents` key at all (see the construction site's own "empty is treated the same as
   *  absent" note), byte-identical to a session before this field existed. */
  agents?: Readonly<Record<string, unknown>>;
  /** Everything `officialBrokerFor`/`canUseToolFor` needs, MINUS the three fields this function
   *  fills from `OfficialSessionInput` itself (never let a caller's stale `sessionId`/`mode`/`cwd`
   *  silently win over the session actually being opened). */
  canUseToolDeps: Omit<CanUseToolDeps, "sessionId" | "mode" | "cwd">;
  policy: SessionApprovalPolicy;
  /** `Options.hooks` for the official leg, once lane 3 merges (`hooksFor(session).official`);
   *  `undefined` until then (P8c-7's own gate). */
  hooks?: unknown;
  env?: Readonly<Record<string, string | undefined>>;
  /** Phase 9c (P9c-1): the LIVE settings snapshot for this incarnation — `officialSubscriptionAuthEnabled`
   *  reads it to decide whether this spawn gets `officialConfigDirFor(home)` as its `spool` (flag
   *  off, the default) or none at all (flag on: the router's own default applies instead). Re-read
   *  fresh on every call (`official-session.ts`'s `open()` builds this deps object per incarnation,
   *  from `runtime.settings()` — never a boot snapshot), so a settings edit takes effect on the next
   *  incarnation with no daemon restart. `undefined`/`null` behaves exactly like an absent block
   *  (`officialSubscriptionAuthEnabled`'s own default: off). */
  settings?: Settings | null;
  /** Pre-release hardening (P9c-1 amendment): test-only override of `versions.ts`'s
   *  `OFFICIAL_SUBSCRIPTION_AUTH_APPROVED` compile-time approval gate — lets a test exercise the
   *  "approved" branch of `officialSubscriptionAuthEnabled` (widened spool, `official-session.ts`'s
   *  assertion skipped) without ever editing the real constant, which stays `false` until Anthropic
   *  approves subscription auth for this integration. `undefined` (every production caller) means
   *  "use the real compile-time constant" — same shape as `requiredWinterRuntimeSdkVersion` below. */
  officialSubscriptionAuthApproved?: boolean;
  /** Winter Phase 10a fix wave (F1): test-only override of `versions.ts`'s
   *  `REQUIRED_WINTER_RUNTIME_SDK` compile-time pin — lets a test simulate a pin below/at/above
   *  `CONSOLE_AUTH_ROUTER_MIN` (e.g. `"0.0.3"`) without editing the real constant. `undefined`
   *  (every production caller, and every test that does not need to touch this gate) means "use the
   *  real pin". */
  requiredWinterRuntimeSdkVersion?: string;
  /** Winter Phase 10a fix wave (F3): test-only override of the console arm's LIVE
   *  `existsSync(consoleProfileCredentialFile(home))` check — official-options.test.ts's own
   *  `minimalDeps()` uses a symbolic, never-filesystem-backed `home`, so every console-arm test
   *  that isn't specifically about this guard needs a way to say "the profile is present" without
   *  actually writing one to disk. `undefined` (every production caller) means "read the real
   *  file"; this is consulted FRESH on every call, exactly like the real check, so a test can still
   *  flip it between calls to prove the guard is live rather than memoized. */
  consoleProfileExists?: () => boolean;
}

/** The official leg's `autoMemoryDirectory` — this function USED TO re-derive the path by hand
 *  (`assistantMemoryDirFor`/`memoryDirFor` called fresh, with only `{winterHome: home}`), which
 *  silently dropped three things `assembler.memoryDirFor` (the SAME decision `winterSystemPromptFor`
 *  makes for this session's system prompt, `agent/context.ts`) actually accounts for:
 *  `settings.memory.directory` (the user's relocation override), the WS-16 §17 memory-key
 *  relocation (`relocatedKey`), and `workdirLess` (a workdir-less CODE session's prompt names the
 *  shared `_assistant` bucket, not a per-cwd one). That drift meant this leg's child could be told,
 *  via `autoMemoryDirectory`, to write memory somewhere OTHER than the directory its own system
 *  prompt had just disclosed. Routing through the assembler is what makes the two agree by
 *  construction rather than by two independent authors staying in sync by hand.
 *
 *  `input.primary === undefined` is the SAME "workdir-less" test `winterSystemPromptFor` runs
 *  (`WinterSystemPromptInput.primary`) — see `OfficialSessionInput.primary`'s own doc for why it is
 *  a separate field from `cwd`.
 *
 *  The router's `RouterOfficialInput.autoMemoryDirectory` is a required field with no "no MEMDIR"
 *  representation — and the router currently hardcodes `autoMemoryEnabled: true` for this leg with
 *  no daemon-side setting able to turn it off (a separate, router-side gap; not this function's to
 *  fix) — so a value must always be sent, EVEN WHEN Winter's own `memory.enabled` setting is off for
 *  this incarnation. `{evenIfDisabled: true}` is what asks the assembler for that value: "what
 *  directory WOULD this be" rather than "what directory IS this, or nothing" — still honouring
 *  `settings.memory.directory`/`relocatedKey` (see `ContextAssembler.memoryDirFor`'s own doc for why
 *  skipping `enabled()` alone, without also skipping the override, is the point: the on/off switch
 *  and the relocation are orthogonal settings, and a naive "just use the plain free functions
 *  whenever memory is disabled" fallback would silently drop the override again for exactly the
 *  users who both pinned a custom MEMDIR AND turned Winter's own memory feature off — the same class
 *  of bug this function exists to fix). The free-function fallback below fires ONLY when
 *  `assembler.memoryDirFor` still answers `undefined` even with that flag — which, per its own doc,
 *  means there is no `memory` dep wired AT ALL (a harness/test double that never supplied one; every
 *  production caller does), not "disabled". */
export function autoMemoryDirectoryFor(
  input: OfficialSessionInput,
  assembler: Pick<ContextAssembler, "memoryDirFor">,
  home: string,
): string {
  const isAssistantBucket = input.mode === "dispatch" || input.mode === "chat";
  const resolved = assembler.memoryDirFor(
    {
      cwd: input.cwd,
      memoryBucket: isAssistantBucket ? "assistant" : "project",
      workdirLess: input.primary === undefined,
    },
    { evenIfDisabled: true },
  );
  if (resolved !== undefined) return resolved;
  const opts: MemoryDirOptions = { winterHome: home };
  return isAssistantBucket ? assistantMemoryDirFor(opts) : memoryDirFor(input.cwd, opts);
}

/** `officialInputFor`'s success shape: the `RouterOfficialInput` AND, separately, the executable
 *  path it resolved with — `pathToClaudeCodeExecutable` is NOT a field of `OptionsTemplatePolicy`
 *  (measured: `dist/official/options-template.d.ts`'s `OptionsTemplatePolicy` has no such member;
 *  only `RuntimeSdkOptions.vendoredOfficialRuntime`, set ONCE at construction, and — per
 *  `dist/sdk.d.ts`'s own comment on that field — the top-level `Options.pathToClaudeCodeExecutable`
 *  a caller passes to `sdk.query({ options })` itself, forwarded like the rest of `Options` via the
 *  router's own `forwardableOptions`). So the caller (`official-session.ts`) sets it at the OUTER
 *  `options` level, not inside `runtime.official.options` — this is what keeps `runtimes.
 *  claudeExecutable` hot (P8c-3) despite the constructor-time value being fixed at boot. */
export interface OfficialInput {
  input: RouterOfficialInput;
  pathToClaudeCodeExecutable: string;
  /** Winter Phase 10a (fix round 2): set to `anthropicConfigDirFor(deps.home)` ONLY on the console
   *  arm — `official-session.ts`'s `open()` hardens it 0700 right beside `input.spool`, the SAME
   *  "not created here, only computed here" split `ensureOfficialConfigDir`'s own doc states for
   *  that field (disk is touched only by a caller actually about to spawn). `undefined` on the
   *  api-key arm (or when `officialAuthArm` was never threaded at all) — nothing to ensure. */
  anthropicConfigDirToEnsure?: string;
}

/**
 * Builds this session's `RouterOfficialInput`, or the typed refusal that stops the session before
 * anything is spawned.
 */
export function officialInputFor(
  input: OfficialSessionInput,
  deps: OfficialInputDeps,
): OfficialInput | ClaudeExecutableUnavailable | OfficialProjectKeyTooDeep | OfficialCredentialPlanRefused | OfficialConsoleRouterUnsupported | OfficialConsoleProfileMissing {
  const executable = deps.claudeExecutableFor();
  if (executable instanceof ClaudeExecutableUnavailable) return executable;

  const projectKey = transcriptProjectKey(input.cwd);
  if (!isVendorCompliantProjectKey(projectKey)) return new OfficialProjectKeyTooDeep(input.cwd, projectKey);

  const env = deps.env ?? process.env;
  const permissionMode: RouterOfficialPermissionMode = officialPermissionModeFor(deps.policy);
  // Winter Phase 10a (router 0.0.4, C1): the console arm now reads directly off
  // `deps.selection.authFamily` (the union the router 0.0.4 itself grew a `"console-profile"`
  // literal for — `session-driver.ts`'s `assembleOfficial` widens the session's persisted selection
  // to it) — the C1-interim `officialAuthArm` field on `OfficialInputDeps` is gone; the family alone
  // now carries what that parallel field used to.
  const officialAuthArm: "api-key" | "console" = deps.selection.authFamily === "console-profile" ? "console" : "api-key";

  // Fix wave (F1): the router-version gate — checked BEFORE anything else in this function builds a
  // bridge, reads a credential, or touches disk, so a session refuses typed the instant the console
  // arm is decided, never partway through assembling an input nothing could safely launch with.
  // Compared against the COMPILE-TIME PIN (`REQUIRED_WINTER_RUNTIME_SDK`), never a runtime probe of
  // the installed package — see `OfficialConsoleRouterUnsupported`'s own doc for why the pin alone
  // is sufficient and why the old runtime probe was dead in every compiled Release binary.
  if (officialAuthArm === "console") {
    const pinnedRouterVersion = deps.requiredWinterRuntimeSdkVersion ?? REQUIRED_WINTER_RUNTIME_SDK;
    if (!versionAtLeast(pinnedRouterVersion, CONSOLE_AUTH_ROUTER_MIN)) {
      return new OfficialConsoleRouterUnsupported(pinnedRouterVersion, CONSOLE_AUTH_ROUTER_MIN);
    }
    // Fix wave (F3, load-bearing guard): a LIVE existence check, on EVERY console-arm spawn — see
    // `OfficialConsoleProfileMissing`'s own doc for why this is the console arm's actual
    // subscription guard, not a convenience check, and why it must never be memoized/cached.
    const consoleProfilePresent = (deps.consoleProfileExists ?? (() => existsSync(consoleProfileCredentialFile(deps.home))))();
    if (!consoleProfilePresent) {
      return new OfficialConsoleProfileMissing(deps.home);
    }
  }

  // Fix round 1 (item 0): the REAL bridge (router 0.0.3) — never the fail-closed default a bare
  // broker used to fall through to. `mode` here is the SAME `permissionMode` this session's
  // `options.permissionMode` carries below, so the containment floor and the broker agree on it.
  const canUseTool = createApprovalBridge({
    broker: officialBrokerFor({ ...deps.canUseToolDeps, sessionId: input.sessionId, mode: input.mode, cwd: input.cwd }),
    brand: CORE_BRAND,
    mode: permissionMode,
  });
  const systemPromptAppend = winterSystemPromptFor(deps.assembler, {
    mode: input.mode,
    ...(input.origin === undefined ? {} : { origin: input.origin }),
    primary: input.primary,
    cwd: input.cwd,
    ...(input.outDir === undefined ? {} : { outDir: input.outDir }),
    ...(input.extraDirs === undefined ? {} : { extraDirs: input.extraDirs }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
  });

  // Batch 3 (item 3): configured servers FIRST, Winter's own capability servers LAST — the same
  // precedence order `session-driver.ts`'s Winter-leg builder uses (`{ ...extra, ...capabilities }`),
  // so a configured server can never shadow a daemon-owned `winter__<key>` one on this leg either
  // (the collision itself was already refused, typed, before this deps object was built).
  const mcpServers = deps.officialPeer === undefined
    ? {}
    : { ...(deps.configuredMcpServers ?? {}), ...officialCapabilityServersFor(deps.capabilities, deps.officialPeer as unknown as OfficialMcpModule) };

  const base: Record<string, string> = minimalOsEnvironment(env);
  // Phase 9c (P9c-1): defence in depth (see `FORBIDDEN_CHILD_ENV`'s own doc) — a no-op today given
  // `minimalOsEnvironment`'s allowlist, but load-bearing against a future change to it.
  for (const name of FORBIDDEN_CHILD_ENV) delete base[name];
  // Winter Phase 10a (router 0.0.4, C1): `ANTHROPIC_PROFILE`/`ANTHROPIC_CONFIG_DIR` now ride
  // `RouterOfficialInput.connectionEnv`, NEVER `base` — the router's own `openOfficialLeg` re-derives
  // credentials/connectionEnv from `Options.runtime.selection` at spawn (measured:
  // `officialCredentialPlan`/`officialConnectionEnv` are called a SECOND time inside the router,
  // keyed on the REAL selection, not on whatever this function pre-computes), so the pairing rule
  // ("`console-profile`'s ANTHROPIC_PROFILE/ANTHROPIC_CONFIG_DIR travel in `connectionEnv` exactly
  // like `console-oauth`'s base URL") is the router's own contract, not a Winter-side convenience —
  // stuffing them into `base` instead would leave the router's own env builder never seeing them at
  // all. `CLAUDE_CONFIG_DIR` is unaffected: it still rides `spool`, below, unchanged.
  // Phase 9c (P9c-1): the flag's ONLY shipped value is `false` — this branch is what runs in
  // production. `spool` left `undefined` (flag on) is NOT "no isolation": the router's own
  // `officialSpoolRoot(home)` default still applies, and `VENDOR_HOME_SEGMENT_RE` still refuses
  // `~/.claude` outright either way (see `officialConfigDirFor`'s own doc) — flipping the flag only
  // widens which directory this leg is willing to authenticate FROM, never lets it reach the
  // vendor's own home.
  // The directory itself is NOT created here (see `ensureOfficialConfigDir`'s own doc) — the
  // caller (`official-session.ts`'s `open()`) ensures it exists right before the real spawn.
  const subscriptionAuth = officialSubscriptionAuthEnabled(deps.settings, deps.officialSubscriptionAuthApproved);
  const spool: string | undefined = subscriptionAuth ? undefined : officialConfigDirFor(deps.home);
  const sharedTempRoot = env.WINTER_TMPDIR?.trim() ? env.WINTER_TMPDIR : tmpdir();
  // WS-14 §12: the router derives ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN for console-oauth)
  // from `provider.authRef` for every family it can — `explicitCredentials`/`explicitConnectionEnv`
  // are the `custom`-family escape hatch a hermetic loopback bed needs (WS-14's own precedent: name
  // each variable and its ref). Neither call ever touches a `SecretStore` — the read happens at
  // spawn, through the router's own `KeychainSeam`.
  // Winter Phase 10a (router 0.0.4, C1): `officialCredentialPlan` is now called UNCONDITIONALLY, for
  // every family including `console-profile` — the router's own table (`AUTH_FAMILY_VARIABLES`)
  // documents that family as one of the three that "inject nothing" (alongside `claude-oauth` and
  // `local-none`), so this call returns `[]` on its own for the console arm; no special-case branch
  // is needed to keep `ANTHROPIC_API_KEY` out (the "even with a supported router, the console arm
  // NEVER hands credentials containing an anthropic key" guard below is now the router's own
  // contract, not a Winter-side skip).
  let credentials: readonly { variable: string; ref: CredentialRef }[];
  try {
    credentials = officialCredentialPlan({ selection: deps.selection, provider: deps.provider, explicit: deps.explicitCredentials as never }) as never;
  } catch (err) {
    return new OfficialCredentialPlanRefused(err instanceof Error ? err.message : String(err));
  }
  // The console arm's own non-secret pair rides `explicit` here exactly like `console-oauth`'s base
  // URL does (router 0.0.4's own doc on `officialConnectionEnv`: "they ride through `explicit` here
  // unchanged") — `officialAuthChildEnvFor` still produces the literal object, just as `connectionEnv`
  // input rather than a `base` mutation now.
  const connectionEnv = officialConnectionEnv({
    selection: deps.selection,
    provider: deps.provider,
    explicit: officialAuthArm === "console" ? officialAuthChildEnvFor("console", deps.home) : deps.explicitConnectionEnv,
  });

  return {
    pathToClaudeCodeExecutable: executable.path,
    ...(officialAuthArm === "console" ? { anthropicConfigDirToEnsure: anthropicConfigDirFor(deps.home) } : {}),
    input: {
      sessionId: input.sessionId,
      ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
      base,
      autoMemoryDirectory: autoMemoryDirectoryFor(input, deps.assembler, deps.home),
      projectKey,
      sharedTempRoot,
      ...(spool === undefined ? {} : { spool }),
      mcpServers,
      ...(credentials.length === 0 ? {} : { credentials }),
      ...(Object.keys(connectionEnv).length === 0 ? {} : { connectionEnv }),
      remoteConfig: "deny",
      advertisesHandoff: true,
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      // Daemon settings surface batch 3 (router 0.0.9): the SDK-surface wall this comment used to
      // describe is CLOSED. `OptionsTemplatePolicy` (`@yanlinglabs/winter-runtime-sdk`, pinned at
      // `versions.ts`'s `REQUIRED_WINTER_RUNTIME_SDK`, now "0.0.9") gained `agents?: Readonly<
      // Record<string, unknown>>` — "the daemon's subagent definitions, handed to BOTH runtime legs
      // from one owner" (the field's own doc, `dist/official/options-template.d.ts`) — and
      // `buildOfficialOptions` forwards it verbatim into the official runtime's own pinned
      // `Options.agents?: Record<string, AgentDefinition>`. `deps.agents` below is the SAME merged
      // map (`agent-definitions.ts`'s `mergeAgentDefinitionTiers`, project-over-user) the Winter leg
      // carries via `mode-options.ts`'s `buildWinterOptions` — one owner, one merge, both legs.
      // `official-options.test.ts`'s "agents reach both legs" block proves this with a real
      // assertion on the built `options.agents`, not a version-pin tripwire.
      options: {
        // Structural assignment onto `OptionsTemplatePolicy` — the router 0.0.3 exports the type by
        // name now, but `RouterOfficialInput["options"]` is already the precise shape this object
        // must satisfy, so there is nothing an explicit import would add here.
        //
        // Fix round 1 (item 0): the REAL bridge. `createApprovalBridge` (router 0.0.3) wraps
        // `officialBrokerFor`'s plain `ApprovalBroker` with the containment floor + mode gate, and
        // `assertOptionsInvariants`'s tail check (`isOurApprovalBridge`) now passes — a capability
        // tool call reaches Winter's own approval flow (cards, policy gating, control-plane denial),
        // identically to the Winter leg, instead of the router's fixed fail-closed default.
        canUseTool,
        permissionMode,
        systemPromptAppend,
        // Fix wave (whole-branch review C1): the router's own containment floor guards only the
        // vendor `.claude` dir, and `createApprovalBridge` allows reads through under `dontAsk`
        // without ever asking — so, before this, an official child could read `<home>/run` and
        // `<home>/runtimes` and write into `<home>/runtimes` (8a's model-denied runtime store) with
        // NOTHING on this leg refusing it, unlike the Winter leg's `buildWinterOptions`, which has
        // carried `permissions.deny`/`sandbox`/`disallowedTools` since P8b-27.
        //
        // `mode-options.ts`'s builders are REUSED verbatim (same exported functions, same home/mode
        // inputs) rather than re-implemented, so the fence is provably the SAME fence on both legs —
        // never a second, independently-drifting copy. `settings.permissions.deny` and
        // `settings.sandbox` ride the flag-settings layer (`OptionsTemplatePolicy.settings`, spread
        // by the router's own `brandedFlagSettings`) rather than a dedicated top-level field — the
        // router's `options-template.d.ts` exposes no `sandbox` member of its own, and flag settings
        // sit above every filesystem-backed settings source regardless of `settingSources` (the SDK's
        // own doc on `Options.settings`), so this is not weakened by `settingSources: []`.
        //
        // MEASURED against the real 0.3.250 CLI (`official-leg.e2e.test.ts`, "C1: the control-plane
        // fence"): the official runtime's own `Settings.sandbox.filesystem.denyWrite`/`denyRead`
        // field names are IDENTICAL to Winter's `SandboxSettingsConfig` shape (both real DIRECTORY
        // paths, never globs — `sandboxConfigFor`'s own doc), so `sandboxConfigFor(home)` is reused
        // with NO translation. `permissions.deny`'s `Tool(specifier)` grammar, however, is NOT the
        // same matcher as Winter's private reimplementation: the real CLI denied a target with
        // `controlPlaneDenyRules`'s `//`-anchored absolute forms UNCHANGED — no second anchoring
        // scheme was needed — confirmed by the same e2e denying a real `<home>/run/probe.txt` Read
        // and a real `<home>/runtimes/` Write while an ordinary cwd file Read still succeeds.
        //
        // Batch 3 (item 2): `permissionDenyRulesFor` (not `controlPlaneDenyRules` directly) so this
        // leg's deny list ALSO carries `settings.permissions.deny` (today's `Skill(<name>)` toggles)
        // — the exact same combined list the Winter leg's `buildWinterOptions` now sends, never a
        // second copy that could drift.
        // HIGH (fix wave, pre-merge review, finding 2a): same rationale as `mode-options.ts`'s
        // `buildWinterOptions` — the pinned SDK's own `Settings.permissions.disableBypassPermissionsMode`
        // (a `'disable'` literal on THIS leg, not a boolean — `sdk.d.ts`'s `Settings.permissions`)
        // rides the flag-settings layer alongside `deny`/`sandbox` above, unless the session's own
        // policy IS `bypass` — a case the top of this function already downgrades to `acceptEdits`
        // for the SESSION itself (`officialPermissionModeFor`, "never bypassPermissions on this leg",
        // D14/P8c-2), but a subagent DEFINITION's own `permissionMode: bypassPermissions` is a
        // separate lever this clamp closes regardless of that downgrade.
        settings: {
          permissions: {
            // The SAME constant the Winter leg sends (`mode-options.ts`'s `GLOBAL_READ_ALLOW_RULES`,
            // whose doc carries the ruling and the deny-before-allow argument) — one list, two legs,
            // never a second copy that could drift. This leg only ever runs code-mode sessions, but
            // the guard is kept so the two call sites read identically.
            ...(input.mode === "code" ? { allow: [...GLOBAL_READ_ALLOW_RULES] } : {}),
            deny: permissionDenyRulesFor(deps.home, deps.settings),
            ...(deps.policy === "bypass" ? {} : { disableBypassPermissionsMode: "disable" as const }),
          },
          sandbox: sandboxConfigFor(deps.home),
        },
        additionalDisallowedTools: disallowedToolsFor(input.mode),
        ...(deps.hooks === undefined ? {} : { hooks: deps.hooks }),
        // Router 0.0.9: `deps.agents` is the SAME merged (project-over-user) definition map the
        // Winter leg carries — see this construction site's own header comment. Omitted entirely
        // when empty, mirroring `mode-options.ts`'s own "empty is treated the same as absent" rule
        // for `Options.agents` (an explicit `{}` would tell the runtime "zero subagents are
        // defined" rather than "the host declared none").
        ...(deps.agents !== undefined && Object.keys(deps.agents).length > 0 ? { agents: deps.agents } : {}),
      } as RouterOfficialInput["options"],
    },
  };
}
