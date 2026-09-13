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
import { isVendorCompliantProjectKey, transcriptProjectKey, type CredentialRef, type PermissionResult, type ProviderSelection } from "@yanlinglabs/winter-agent-sdk";
import { createApprovalBridge, officialConnectionEnv, officialCredentialPlan, type ApprovalRequest, type OfficialPermissionMode as RouterOfficialPermissionMode, type RouterOfficialInput, type RuntimeSelection } from "@yanlinglabs/winter-runtime-sdk";
import type { ContextAssembler } from "../agent/context";
import type { SessionApprovalPolicy } from "../agent/gate";
import type { Mode as SessionMode } from "../agent/tools/registry";
import { assistantMemoryDirFor, memoryDirFor, type MemoryDirOptions } from "../agent/memory-dir";
import type { CapabilityServerRecord } from "../capabilities";
import { officialAuthModeSetting, officialSubscriptionAuthEnabled, type Settings } from "../settings";
import { canUseToolFor, type CanUseToolDeps } from "./approval-bridge";
import { CORE_BRAND } from "./brand";
import { controlPlaneDenyRules, disallowedToolsFor, sandboxConfigFor } from "./mode-options";
import { officialCapabilityServersFor, type OfficialMcpModule } from "./official-capabilities";
import { winterSystemPromptFor } from "./system-prompt";
import { ClaudeExecutableUnavailable } from "./official-executable";
import type { OfficialPeer } from "./create";
import { CONSOLE_AUTH_ROUTER_MIN, installedWinterRuntimeSdkVersion, versionAtLeast } from "./versions";

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
 * Winter Phase 10a (P10a-2): "one profile, one config dir" — the Anthropic Platform CLI (`ant`)
 * and the embedded `claude` binary's `auth login --console` both read/write profiles under this
 * SAME directory (`ANTHROPIC_CONFIG_DIR`), a sibling of `officialConfigDirFor`'s own
 * `claude-config` directory rather than the same one: `CLAUDE_CONFIG_DIR` (the vendor CLI's own
 * session-transcript spool) and `ANTHROPIC_CONFIG_DIR` (the profile-credential store both `claude
 * auth login --console` and `ant` read) are two different vendor-defined roots that happen to be
 * set on the same child at once (P10a-2) — collapsing them into one directory would let a future
 * vendor CLI change have the transcript spool and the credential store collide.
 *
 * Hardened 0700 at `login()`'s own call site (`console-profile-broker.ts`), the SAME
 * `ensureOfficialConfigDir` helper above — that function is already dir-path-agnostic, so this
 * door does not need its own copy.
 */
export function anthropicConfigDirFor(home: string): string {
  return join(home, "runtimes", "anthropic-config");
}

/** P10a-2: the ONE profile name every login/refresh/logout call names — `claude auth login
 *  --console` writes `<anthropicConfigDirFor(home)>/credentials/${ANTHROPIC_PROFILE_NAME}.json`,
 *  and `ant auth print-credentials --profile ${ANTHROPIC_PROFILE_NAME}` reads the identical file.
 *  Winter never supports more than one Anthropic Console profile — a literal, not a setting. */
export const ANTHROPIC_PROFILE_NAME = "winter";

/** The console profile's own credential file — `officialAuthFamilyFor`'s "auto" arm probes this
 *  path's existence, and nothing else (presence, never validity — same "presence is not validity"
 *  discipline `keychain.ts`'s `credentialPresenceFrom` documents for the Keychain-backed rows). */
function consoleProfileCredentialFile(home: string): string {
  return join(anthropicConfigDirFor(home), "credentials", `${ANTHROPIC_PROFILE_NAME}.json`);
}

/** The official leg's two shippable, mutually-exclusive auth arms (P10a-3) — a NARROWER type than
 *  the router's own `RuntimeSelection["authFamily"]` (which also has `console-oauth`/`bedrock`/
 *  `vertex`/`claude-oauth`/`local-none`, none of which this decision touches): this door decides
 *  only "does THIS session's child read a Console profile off disk, or an env-injected API key",
 *  never which router-level credential family carries it. */
export type OfficialAuthFamily = "api-key" | "console";

/**
 * Winter Phase 10a (P10a-3): `settings.runtimes.official.auth` resolved against the console
 * profile's own on-disk presence. `"api-key"`/`"console"` are explicit pins — honoured even when
 * the pinned arm's own credential is not actually there yet (a user who picked "console" before
 * finishing `winter login --anthropic-console` gets a real, typed refusal further down the launch
 * path, never a silent substitution of the other arm). `"auto"` (the default) is the ruling's own
 * literal rule: the console profile wins when its credential file exists, otherwise API key —
 * unconditionally, regardless of `hasApiKey`.
 *
 * `hasApiKey` is accepted (not merely tolerated) as part of this door's PINNED signature because
 * the caller building `provider.status`'s `effective` field needs it to tell "this arm was
 * DECIDED" apart from "this arm's own credential actually EXISTS" — e.g. `auto` with no console
 * profile and no API key material still decides `"api-key"` here, and the caller is the one who
 * turns that into `effective: "none"` by combining this result with the presence booleans it
 * already has (`ipc/server.ts`'s `provider.status` handler). Kept as a real parameter (not
 * dropped) so that combination stays a one-function read rather than a second, independently
 * drifting copy of this same decision.
 */
export function officialAuthFamilyFor(home: string, settings: Settings | null | undefined, hasApiKey: boolean): OfficialAuthFamily {
  void hasApiKey; // see this function's own doc comment — accepted for the caller's use, not consulted here
  const mode = officialAuthModeSetting(settings);
  if (mode === "api-key" || mode === "console") return mode;
  return existsSync(consoleProfileCredentialFile(home)) ? "console" : "api-key";
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
 * Winter Phase 10a (O6): `provider.status`'s own "which credential will actually be used right
 * now" decision — WIDER than `officialAuthFamilyFor` above (which always picks an arm to attempt
 * and never answers `"none"`), because only a caller holding both presence booleans can tell
 * "this arm was decided" apart from "this arm's own credential doesn't actually exist yet". An
 * explicit `auth` pin (`"api-key"`/`"console"`) is only "effective" when ITS OWN credential is
 * present — it never silently falls back to the other arm, matching `officialAuthFamilyFor`'s own
 * "honoured even when not there yet" stance for the SPAWN decision. Only `"auto"` falls back
 * (console first, per P10a-3's literal rule), and answers `"none"` when neither exists.
 */
export function effectiveOfficialAuthFor(
  auth: "auto" | "api-key" | "console",
  apiKey: boolean,
  consoleProfile: boolean,
): "api-key" | "console" | "none" {
  if (auth === "console") return consoleProfile ? "console" : "none";
  if (auth === "api-key") return apiKey ? "api-key" : "none";
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
 * Winter Phase 10a fix wave (C1-interim): the console auth arm refuses typed, before anything is
 * spawned, while the installed `@yanlinglabs/winter-runtime-sdk` is older than
 * `CONSOLE_AUTH_ROUTER_MIN` (`versions.ts`'s own doc explains why: the pinned 0.0.3 router would
 * inject the OAuth bearer profile as `ANTHROPIC_API_KEY`, which is exactly the leak `officialAuthChildEnvFor`'s
 * console arm exists to prevent). This refusal is a STANDING guard, not a one-time migration note —
 * it re-evaluates the installed version on every call (or the test-injected
 * `OfficialInputDeps.installedWinterRuntimeSdkVersion` override) and stops refusing automatically
 * the moment a router upgrade actually lands.
 */
export class OfficialConsoleRouterUnsupported extends Error {
  readonly code = "official_console_router_unsupported" as const;
  constructor(readonly installedRouterVersion: string | undefined, readonly requiredRouterVersion: string) {
    super(
      `the console auth arm needs @yanlinglabs/winter-runtime-sdk >= ${requiredRouterVersion} (the pinned router forwards ` +
      `only its own minimal OS environment and runs its api-key credential plan unconditionally, which would inject the ` +
      `console profile's OAuth bearer as ANTHROPIC_API_KEY); installed ${installedRouterVersion ?? "unknown"} — sign in with ` +
      `an API key instead, or wait for the router upgrade`,
    );
    this.name = "OfficialConsoleRouterUnsupported";
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
  assembler: Pick<ContextAssembler, "assemble">;
  /** This session's already-built per-session Winter capability servers (`buildCapabilitiesFor`'s
   *  own output) — mirrored onto the official leg by `officialCapabilityServersFor` (P8c-4). */
  capabilities: CapabilityServerRecord;
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
  /** Winter Phase 10a fix wave (C1-interim): test-only override of `versions.ts`'s
   *  `installedWinterRuntimeSdkVersion` — lets a test simulate a router upgrade (`() => "0.0.4"`)
   *  without a real second package install. `undefined` (every production caller, and every test
   *  that does not need to touch this gate) means "read the real installed version". */
  installedWinterRuntimeSdkVersion?: () => string | undefined;
}

/** `winterSystemPromptFor`'s memory-bucket choice, verbatim (chat/dispatch share `_assistant`; code
 *  is per-project) — so the official leg's `autoMemoryDirectory` is the SAME directory the Winter
 *  leg's MEMDIR resolves to for this session (WS-14 §2: "identical for both branches"). */
export function autoMemoryDirectoryFor(input: OfficialSessionInput, home: string): string {
  const opts: MemoryDirOptions = { winterHome: home };
  return input.mode === "dispatch" || input.mode === "chat" ? assistantMemoryDirFor(opts) : memoryDirFor(input.cwd, opts);
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
): OfficialInput | ClaudeExecutableUnavailable | OfficialProjectKeyTooDeep | OfficialCredentialPlanRefused | OfficialConsoleRouterUnsupported {
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

  // Fix wave (C1-interim): the router-version gate — checked BEFORE anything else in this function
  // builds a bridge, reads a credential, or touches disk, so a session refuses typed the instant
  // the console arm is decided, never partway through assembling an input nothing could safely
  // launch with. See `OfficialConsoleRouterUnsupported`'s own doc for why this is standing, not
  // one-time.
  if (officialAuthArm === "console") {
    const installedRouterVersion = (deps.installedWinterRuntimeSdkVersion ?? installedWinterRuntimeSdkVersion)();
    if (!versionAtLeast(installedRouterVersion, CONSOLE_AUTH_ROUTER_MIN)) {
      return new OfficialConsoleRouterUnsupported(installedRouterVersion, CONSOLE_AUTH_ROUTER_MIN);
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
    primary: input.cwd,
    cwd: input.cwd,
    ...(input.outDir === undefined ? {} : { outDir: input.outDir }),
    ...(input.extraDirs === undefined ? {} : { extraDirs: input.extraDirs }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
  });

  const mcpServers = deps.officialPeer === undefined
    ? {}
    : officialCapabilityServersFor(deps.capabilities, deps.officialPeer as unknown as OfficialMcpModule);

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
  const subscriptionAuth = officialSubscriptionAuthEnabled(deps.settings);
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
      autoMemoryDirectory: autoMemoryDirectoryFor(input, deps.home),
      projectKey,
      sharedTempRoot,
      ...(spool === undefined ? {} : { spool }),
      mcpServers,
      ...(credentials.length === 0 ? {} : { credentials }),
      ...(Object.keys(connectionEnv).length === 0 ? {} : { connectionEnv }),
      remoteConfig: "deny",
      advertisesHandoff: true,
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
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
        settings: { permissions: { deny: controlPlaneDenyRules(deps.home) }, sandbox: sandboxConfigFor(deps.home) },
        additionalDisallowedTools: disallowedToolsFor(input.mode),
        ...(deps.hooks === undefined ? {} : { hooks: deps.hooks }),
      } as RouterOfficialInput["options"],
    },
  };
}
