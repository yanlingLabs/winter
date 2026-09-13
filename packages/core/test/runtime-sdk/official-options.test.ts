// M7 — `official-options.ts` was untested; this pins its four load-bearing, pure(-ish) pieces:
// the six-valued permission-mode mapping (D14/P8c-2's "never bypassPermissions on this leg"), the
// minimal-OS-environment allowlist (§3), the project-key-too-deep refusal (§14's own guard, even
// though the pinned `transcriptProjectKey` self-truncates so no REAL path reaches it today — see
// that test's own comment), and the auto-memory-directory equality with the Winter leg's own MEMDIR
// helper (WS-14 §2: "identical for both branches").
import { afterEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installMockModuleTripwire } from "../mock-module-tripwire";
import * as winterAgentSdk from "@yanlinglabs/winter-agent-sdk";
import type { RuntimeSelection } from "@yanlinglabs/winter-runtime-sdk";
import { ApprovalBroker } from "../../src/agent/approvals";
import { PermissionGate } from "../../src/agent/gate";
import { QuestionBroker } from "../../src/agent/questions";
import type { SessionApprovalPolicy } from "../../src/agent/gate";
import { assistantMemoryDirFor, memoryDirFor } from "../../src/agent/memory-dir";
import { controlPlaneDenyRules, disallowedToolsFor, sandboxConfigFor } from "../../src/runtime-sdk/mode-options";
import { Settings } from "../../src/settings";
import { FileSecretStore } from "../../src/auth/secret-store";
import { writeCredentialMaterial } from "../../src/auth/credential-material";
import { keychainService } from "../../src/profile";
import {
  ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME,
  ANTHROPIC_CREDENTIAL_SECRET_NAME,
  credentialPresenceFrom,
  keychainSeamFromSecretStore,
} from "../../src/runtime-sdk/keychain";
import { providerSelectionFor } from "../../src/runtime-sdk/provider-selection";
import {
  ANTHROPIC_PROFILE_NAME,
  anthropicConfigDirFor,
  autoMemoryDirectoryFor,
  effectiveOfficialAuthFor,
  ensureOfficialConfigDir,
  FORBIDDEN_CHILD_ENV,
  minimalOsEnvironment,
  officialAuthChildEnvFor,
  officialAuthFamilyFor,
  officialConfigDirFor,
  officialInputFor,
  officialPermissionModeFor,
  OfficialConsoleProfileMissing,
  OfficialConsoleRouterUnsupported,
  OfficialProjectKeyTooDeep,
  type OfficialInputDeps,
  type OfficialPermissionMode,
  type OfficialSessionInput,
} from "../../src/runtime-sdk/official-options";
import { CONSOLE_AUTH_ROUTER_MIN } from "../../src/runtime-sdk/versions";

// ⚠️ Bun's `mock.module` overwrites properties on the ALREADY-LOADED module's own namespace object
// IN PLACE (its own doc comment: "exports are overwritten") — so `winterAgentSdk.transcriptProjectKey`
// itself becomes the fake the instant a mock is installed, and `{ ...winterAgentSdk }` in a later
// "restore" call would just spread the fake right back. The real function is captured HERE, before
// anything in this file ever mocks the module, so restoring means naming this constant — never
// re-reading the (by-then-mutated) namespace import.
const REAL_TRANSCRIPT_PROJECT_KEY = winterAgentSdk.transcriptProjectKey;

// ── officialPermissionModeFor ───────────────────────────────────────────────────────────────────

describe("officialPermissionModeFor", () => {
  const cases: Array<[SessionApprovalPolicy, OfficialPermissionMode]> = [
    ["plan", "plan"],
    ["dont-ask", "dontAsk"],
    ["ask", "default"],
    ["accept-edits", "acceptEdits"],
    ["auto", "default"],
    ["chat", "default"],
    // D14/P8c-2: the one deliberate divergence from `mode-options.ts`'s Winter mapping — this leg's
    // own `assertOptionsInvariants` refuses `bypassPermissions` outright, so `bypass` maps to the
    // closest non-bypass floor instead of the Winter leg's literal `bypassPermissions`.
    ["bypass", "acceptEdits"],
  ];
  for (const [policy, expected] of cases) {
    test(`${policy} -> ${expected}`, () => {
      expect(officialPermissionModeFor(policy)).toBe(expected);
    });
  }

  test("bypass NEVER maps to bypassPermissions (D14/P8c-2's own ban)", () => {
    expect(officialPermissionModeFor("bypass")).not.toBe("bypassPermissions");
  });
});

// ── minimalOsEnvironment ─────────────────────────────────────────────────────────────────────────

describe("minimalOsEnvironment", () => {
  test("only the allowlisted names pass; everything else in a real process env is dropped", () => {
    const env = {
      HOME: "/Users/x",
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TERM: "xterm-256color",
      // None of these belong in a supervised child's environment (§3: "a REPLACEMENT built from an
      // allowlist; nothing is inherited").
      SECRET_TOKEN: "sk-should-never-appear",
      // Pre-rename this set two distinct env keys — the daemon's own home var, and WINTER_HOME (the SDK's
      // brand-derived home); the rename makes them the same key, so it is written once now.
      WINTER_HOME: "/Users/x/.winter",
      ANTHROPIC_API_KEY: "sk-also-never",
      RANDOM_VAR: "whatever",
    };
    const out = minimalOsEnvironment(env);
    expect(out).toEqual({ HOME: "/Users/x", PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", TERM: "xterm-256color" });
    expect(Object.keys(out).sort()).toEqual(["HOME", "LANG", "LC_ALL", "PATH", "TERM"]);
  });

  test("an absent optional name is never invented", () => {
    const out = minimalOsEnvironment({ HOME: "/Users/x", PATH: "/usr/bin" });
    expect(out).toEqual({ HOME: "/Users/x", PATH: "/usr/bin" });
    expect("LANG" in out).toBe(false);
    expect("LC_ALL" in out).toBe(false);
    expect("TERM" in out).toBe(false);
  });

  test("HOME/PATH fall back (never absent) even from a bare env", () => {
    const out = minimalOsEnvironment({});
    expect(out.PATH).toBe("/usr/bin:/bin");
    expect(typeof out.HOME).toBe("string");
    expect(out.HOME!.length).toBeGreaterThan(0);
  });
});

// ── autoMemoryDirectoryFor ───────────────────────────────────────────────────────────────────────

describe("autoMemoryDirectoryFor", () => {
  const HOME = "/Users/x/.winter-test-home";
  const base = (mode: OfficialSessionInput["mode"]): OfficialSessionInput => ({ sessionId: "s_1", mode, cwd: "/Users/x/repo" });

  test("code -> the SAME per-project MEMDIR the Winter leg's memoryDirFor resolves to", () => {
    const input = base("code");
    expect(autoMemoryDirectoryFor(input, HOME)).toBe(memoryDirFor(input.cwd, { winterHome: HOME }));
  });

  test("dispatch and chat -> the SAME shared _assistant bucket assistantMemoryDirFor resolves to", () => {
    expect(autoMemoryDirectoryFor(base("dispatch"), HOME)).toBe(assistantMemoryDirFor({ winterHome: HOME }));
    expect(autoMemoryDirectoryFor(base("chat"), HOME)).toBe(assistantMemoryDirFor({ winterHome: HOME }));
  });

  test("dispatch/chat and code resolve to DIFFERENT directories (the split is real, not accidental equality)", () => {
    expect(autoMemoryDirectoryFor(base("code"), HOME)).not.toBe(autoMemoryDirectoryFor(base("dispatch"), HOME));
  });
});

// ── officialInputFor: the official_project_key_too_deep refusal ────────────────────────────────

/** Minimal `officialInputFor` deps — mirrors `official-leg.e2e.test.ts`'s own `buildWorld` shape,
 *  narrowed to what a call needs when `officialPeer` is absent (no MCP servers to materialize). */
function minimalDeps(overrides: Partial<OfficialInputDeps> = {}): OfficialInputDeps {
  const selection: RuntimeSelection = {
    runtimeKind: "claude-agent", providerId: "test", modelRef: "claude-test/echo", family: "claude",
    authFamily: "custom", sdkVersion: "0.0.3", reason: "unit test", decidedAt: new Date(0).toISOString(),
  };
  return {
    home: "/Users/x/.winter-test-home",
    selection,
    explicitCredentials: [],
    explicitConnectionEnv: {},
    officialPeer: undefined,
    claudeExecutableFor: () => ({ path: "/usr/bin/true" }),
    assembler: { assemble: () => "" },
    capabilities: {},
    canUseToolDeps: { approvals: new ApprovalBroker(), questions: new QuestionBroker(), gate: new PermissionGate(), policy: "auto", emit: () => {} },
    policy: "auto",
    // Fix wave (F3): every test in this file uses a symbolic, never-filesystem-backed `home`
    // (above) — default the console arm's live profile-existence guard to "present" so every
    // EXISTING console-arm test (env shape, router-version gate, …) keeps testing what it already
    // tests, undisturbed by a guard those tests are not about. F3's own describe block overrides
    // this explicitly to `() => false` to test the guard itself.
    consoleProfileExists: () => true,
    ...overrides,
  };
}

describe("officialInputFor — official_project_key_too_deep", () => {
  afterEach(async () => {
    // Belt: every test in this block restores its own mock inline (in a `finally`), but a thrown
    // assertion before that point must never leave a later file reading a fake `transcriptProjectKey`.
    await mock.module("@yanlinglabs/winter-agent-sdk", () => ({ ...winterAgentSdk, transcriptProjectKey: REAL_TRANSCRIPT_PROJECT_KEY }));
  });

  test("a >64-char transcript key refuses typed, never silently truncated into the launch", async () => {
    // The pinned `transcriptProjectKey` (WS-14 §14) self-truncates to its own 64-char ceiling with a
    // hash suffix, so no REAL cwd reaches this branch today — `officialInputFor`'s own guard
    // (`isVendorCompliantProjectKey`) is defence in depth against a FUTURE vendor change, not a path
    // this daemon can construct. Mocking the export is what makes the guard itself observable; see
    // `official-session.test.ts`'s own header for why `mock.module` is the right tool here (it
    // overwrites the already-loaded module's own export in place, so this file's later, unmocked
    // static import of `officialInputFor` still calls through to whatever this test set at the time
    // it runs).
    await mock.module("@yanlinglabs/winter-agent-sdk", () => ({ ...winterAgentSdk, transcriptProjectKey: () => "x".repeat(65) }));
    try {
      const input: OfficialSessionInput = { sessionId: "s_1", mode: "code", cwd: "/Users/x/repo" };
      const result = officialInputFor(input, minimalDeps());
      expect(result).toBeInstanceOf(OfficialProjectKeyTooDeep);
      if (result instanceof OfficialProjectKeyTooDeep) {
        expect(result.code).toBe("official_project_key_too_deep");
        expect(result.cwd).toBe(input.cwd);
        expect(result.key).toBe("x".repeat(65));
      }
    } finally {
      await mock.module("@yanlinglabs/winter-agent-sdk", () => ({ ...winterAgentSdk, transcriptProjectKey: REAL_TRANSCRIPT_PROJECT_KEY }));
    }
  });

  test("a real, ordinary cwd never refuses (the guard is not reachable on the real, self-truncating key)", () => {
    const input: OfficialSessionInput = { sessionId: "s_1", mode: "code", cwd: "/Users/x/repo" };
    const result = officialInputFor(input, minimalDeps());
    expect(result).not.toBeInstanceOf(OfficialProjectKeyTooDeep);
  });
});

// ── officialInputFor — the control-plane fence (fix wave C1) ──────────────────────────────────
//
// C1 (whole-branch review): `officialInputFor`'s built `options` carried NO `settings.permissions
// .deny`, NO `settings.sandbox`, and NO `additionalDisallowedTools` — the router's own containment
// floor guards only the vendor `.claude` dir, so an official child could read `<home>/run` and
// `<home>/runtimes` and write into `<home>/runtimes` with nothing on this leg refusing it, unlike
// `mode-options.ts`'s `buildWinterOptions`. These tests pin that the SAME shared builders
// (`controlPlaneDenyRules`/`sandboxConfigFor`/`disallowedToolsFor` — never a second, hand-copied
// implementation) now reach `options`, so the two legs cannot drift apart silently.
//
// The MEASURED half of C1 — whether the official runtime's own `Tool(specifier)` rule matcher
// actually honors `controlPlaneDenyRules`'s `//`-anchored absolute forms — is NOT re-provable as a
// pure unit test (there is no in-process matcher to call, per `mode-options.ts`'s own comment on
// `fsRootAnchored`: "the matcher is not exported from the installed package"). That proof lives in
// `official-leg.e2e.test.ts`'s "C1: ..." tests, against the real 0.3.250 binary: a Read of
// `<home>/run/probe.txt` is denied, an ordinary cwd Read still works, and a Write into
// `<home>/runtimes/` is denied under both `auto` and `dont-ask` — all with `controlPlaneDenyRules`'s
// rules UNCHANGED, no second anchoring scheme needed (measured, not assumed).
describe("officialInputFor — the control-plane fence (C1)", () => {
  function optionsFor(mode: OfficialSessionInput["mode"], home = "/Users/x/.winter-test-home"): Record<string, unknown> {
    const input: OfficialSessionInput = { sessionId: "s_1", mode, cwd: "/Users/x/repo" };
    const result = officialInputFor(input, minimalDeps({ home }));
    if (!("input" in result)) throw new Error(`officialInputFor unexpectedly refused: ${String((result as { message?: string }).message)}`);
    return result.input.options as unknown as Record<string, unknown>;
  }

  test("settings.permissions.deny is EXACTLY controlPlaneDenyRules(home) — the same builder Winter uses", () => {
    const home = "/Users/x/.winter-test-home";
    const options = optionsFor("code", home);
    const settings = options.settings as { permissions?: { deny?: string[] } } | undefined;
    expect(settings?.permissions?.deny).toEqual(controlPlaneDenyRules(home));
    // Non-vacuous: this is a real list of rules, not an accidentally-empty array satisfying `toEqual`.
    expect(settings?.permissions?.deny?.length).toBeGreaterThan(0);
  });

  test("settings.sandbox is EXACTLY sandboxConfigFor(home) — same real directory paths, no globs", () => {
    const home = "/Users/x/.winter-test-home";
    const options = optionsFor("code", home);
    const settings = options.settings as { sandbox?: unknown } | undefined;
    expect(settings?.sandbox).toEqual(sandboxConfigFor(home));
  });

  test("additionalDisallowedTools is EXACTLY disallowedToolsFor(mode) — varies per mode like the Winter leg", () => {
    const codeOptions = optionsFor("code");
    const chatOptions = optionsFor("chat");
    expect(codeOptions.additionalDisallowedTools).toEqual(disallowedToolsFor("code"));
    expect(chatOptions.additionalDisallowedTools).toEqual(disallowedToolsFor("chat"));
    // Chat's list is a strict superset (chat additionally excludes the SDK's own web/fs/shell
    // built-ins) — a real, mode-sensitive difference, not two copies of the same literal.
    expect((chatOptions.additionalDisallowedTools as string[]).length).toBeGreaterThan((codeOptions.additionalDisallowedTools as string[]).length);
  });

  test("a DIFFERENT home produces DIFFERENT rules — the fence is keyed off the real session home, not a constant", () => {
    const a = optionsFor("code", "/Users/x/.winter-test-home");
    const b = optionsFor("code", "/Users/y/.winter-other-home");
    const denyA = (a.settings as { permissions?: { deny?: string[] } }).permissions?.deny;
    const denyB = (b.settings as { permissions?: { deny?: string[] } }).permissions?.deny;
    expect(denyA).not.toEqual(denyB);
  });
});

// ── Phase 9c (P9c-1): the env shape + CLAUDE_CONFIG_DIR pin ────────────────────────────────────
//
// `officialConfigDirFor(home)` = `<home>/runtimes/claude-config` is a real path this file's own
// `minimalDeps()` fixture's symbolic `home` (`/Users/x/.winter-test-home`) is never meant to touch
// on disk — `officialInputFor` only COMPUTES the path (never creates it); `ensureOfficialConfigDir`
// is exercised separately below, against a real `mkdtempSync` root.
describe("officialInputFor — the env shape + spool (P9c-1)", () => {
  const apiKeySelection: RuntimeSelection = {
    runtimeKind: "claude-agent", providerId: "anthropic", modelRef: "anthropic/claude-sonnet-5",
    family: "claude", authFamily: "api-key", sdkVersion: "0.0.3", reason: "unit test", decidedAt: new Date(0).toISOString(),
  };
  const HOME = "/Users/x/.winter-test-home";
  const input: OfficialSessionInput = { sessionId: "s_1", mode: "code", cwd: "/Users/x/repo" };
  const settingsWith = (subscriptionAuth: boolean): Settings => ({ runtimes: { official: { subscriptionAuth } } }) as unknown as Settings;

  function build(overrides: Partial<OfficialInputDeps> = {}): { input: import("@yanlinglabs/winter-runtime-sdk").RouterOfficialInput } {
    const result = officialInputFor(input, minimalDeps({ home: HOME, selection: apiKeySelection, ...overrides }));
    if (!("input" in result)) throw new Error(`officialInputFor unexpectedly refused: ${String((result as { message?: string }).message)}`);
    return result;
  }

  test("base is EXACTLY the minimalOsEnvironment allowlist — no FORBIDDEN_CHILD_ENV name leaks through, even when the host env carries every one of them as a sentinel", () => {
    const hostEnv: Record<string, string> = { HOME: "/Users/x", PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", TERM: "xterm-256color" };
    for (const name of FORBIDDEN_CHILD_ENV) hostEnv[name] = `SENTINEL_${name}`;
    const built = build({ env: hostEnv });
    for (const name of FORBIDDEN_CHILD_ENV) expect(built.input.base?.[name]).toBeUndefined();
    expect(built.input.base).toEqual({ HOME: "/Users/x", PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", TERM: "xterm-256color" });
  });

  test("no settings (absent block) -> subscriptionAuth defaults OFF -> spool is officialConfigDirFor(home)", () => {
    const built = build({});
    expect(built.input.spool).toBe(officialConfigDirFor(HOME));
  });

  test("subscriptionAuth explicitly false -> the SAME spool as the absent-block default", () => {
    const built = build({ settings: settingsWith(false) });
    expect(built.input.spool).toBe(officialConfigDirFor(HOME));
  });

  test("subscriptionAuth true -> spool is left undefined (the router's own default applies instead)", () => {
    const built = build({ settings: settingsWith(true) });
    expect(built.input.spool).toBeUndefined();
  });

  test("flipping the flag between two calls with the SAME deps object otherwise -> spool changes with no other field touched (hot, no restart)", () => {
    const off = build({ settings: settingsWith(false) });
    const on = build({ settings: settingsWith(true) });
    expect(off.input.spool).toBe(officialConfigDirFor(HOME));
    expect(on.input.spool).toBeUndefined();
    // Nothing else about the assembled input moved with the flag.
    expect(off.input.base).toEqual(on.input.base);
    expect(off.input.projectKey).toEqual(on.input.projectKey);
  });

  test("a DIFFERENT home produces a DIFFERENT officialConfigDirFor path — never a constant", () => {
    expect(officialConfigDirFor("/Users/x/.winter-test-home")).not.toBe(officialConfigDirFor("/Users/y/.winter-other-home"));
  });

  test("the credential plan still injects exactly ANTHROPIC_API_KEY for the api-key family (router behaviour, unaffected by the flag)", () => {
    const provider = { providerId: "anthropic", authRef: { kind: "inline" as const, value: "sk-test-unit" } };
    const built = officialInputFor(input, minimalDeps({
      home: HOME, selection: apiKeySelection, provider, explicitCredentials: undefined, settings: settingsWith(false),
    }));
    if (!("input" in built)) throw new Error("unexpectedly refused");
    expect(built.input.credentials).toEqual([{ variable: "ANTHROPIC_API_KEY", ref: provider.authRef }]);
  });
});

// Minor (review r0): the api-key family's own matrix above proved base/spool/flag behaviour for
// ONE family — brief Step 1 asked for BOTH families (`console-oauth` expects `ANTHROPIC_AUTH_TOKEN`
// instead of the key, `apiKeySource: "none"`, and is exempt from the Step 3 assertion elsewhere in
// this suite). This block pins that the base/spool/flag machinery is IDENTICAL across the two —
// `officialInputFor` never branches on family for any of it — while the credential VARIABLE NAME
// genuinely differs, which is the one thing the router's own `officialCredentialPlan` does branch on.
describe("officialInputFor — the env shape + spool, console-oauth family (P9c-1)", () => {
  const consoleOauthSelection: RuntimeSelection = {
    runtimeKind: "claude-agent", providerId: "anthropic", modelRef: "anthropic/claude-sonnet-5",
    family: "claude", authFamily: "console-oauth", sdkVersion: "0.0.3", reason: "unit test", decidedAt: new Date(0).toISOString(),
  };
  const HOME = "/Users/x/.winter-test-home";
  const input: OfficialSessionInput = { sessionId: "s_1", mode: "code", cwd: "/Users/x/repo" };
  const settingsWith = (subscriptionAuth: boolean): Settings => ({ runtimes: { official: { subscriptionAuth } } }) as unknown as Settings;

  function build(overrides: Partial<OfficialInputDeps> = {}): { input: import("@yanlinglabs/winter-runtime-sdk").RouterOfficialInput } {
    const result = officialInputFor(input, minimalDeps({ home: HOME, selection: consoleOauthSelection, ...overrides }));
    if (!("input" in result)) throw new Error(`officialInputFor unexpectedly refused: ${String((result as { message?: string }).message)}`);
    return result;
  }

  test("base is EXACTLY the minimalOsEnvironment allowlist — no FORBIDDEN_CHILD_ENV name leaks through, even when the host env carries every one of them as a sentinel", () => {
    const hostEnv: Record<string, string> = { HOME: "/Users/x", PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", TERM: "xterm-256color" };
    for (const name of FORBIDDEN_CHILD_ENV) hostEnv[name] = `SENTINEL_${name}`;
    const built = build({ env: hostEnv });
    for (const name of FORBIDDEN_CHILD_ENV) expect(built.input.base?.[name]).toBeUndefined();
    expect(built.input.base).toEqual({ HOME: "/Users/x", PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", TERM: "xterm-256color" });
  });

  test("no settings (absent block) -> subscriptionAuth defaults OFF -> spool is officialConfigDirFor(home), same as the api-key family", () => {
    const built = build({});
    expect(built.input.spool).toBe(officialConfigDirFor(HOME));
  });

  test("subscriptionAuth true -> spool is left undefined, same as the api-key family", () => {
    const built = build({ settings: settingsWith(true) });
    expect(built.input.spool).toBeUndefined();
  });

  test("the credential plan injects ANTHROPIC_AUTH_TOKEN — NEVER the api-key family's ANTHROPIC_API_KEY — for console-oauth", () => {
    const provider = { providerId: "anthropic", authRef: { kind: "inline" as const, value: "oauth-test-unit" } };
    const built = officialInputFor(input, minimalDeps({
      home: HOME, selection: consoleOauthSelection, provider, explicitCredentials: undefined, settings: settingsWith(false),
    }));
    if (!("input" in built)) throw new Error("unexpectedly refused");
    expect(built.input.credentials).toEqual([{ variable: "ANTHROPIC_AUTH_TOKEN", ref: provider.authRef }]);
    expect(built.input.credentials).not.toContainEqual(expect.objectContaining({ variable: "ANTHROPIC_API_KEY" }));
  });
});

// Winter Phase 10a (fix round 2, P10a-2/3): `officialAuthChildEnvFor` was UNIT-tested (O2) but
// never actually wired into the env `officialInputFor` hands the SDK — this closes that gap and
// proves BOTH arms of the real env the official child receives, the same way the console-oauth
// block above proves its own family's `credentials` shape.
describe("officialInputFor — the console arm's real env (fix round 2, P10a-2; router 0.0.4 wiring)", () => {
  const apiKeySelection: RuntimeSelection = {
    runtimeKind: "claude-agent", providerId: "anthropic", modelRef: "anthropic/claude-sonnet-5",
    family: "claude", authFamily: "api-key", sdkVersion: "0.0.3", reason: "unit test", decidedAt: new Date(0).toISOString(),
  };
  // Winter Phase 10a (router 0.0.4, C1): the console arm is now carried on the `RuntimeSelection`
  // itself (`authFamily: "console-profile"`, the literal router 0.0.4 published) — never a parallel
  // `officialAuthArm` field. `session-driver.ts`'s `assembleOfficial` is what actually widens a
  // session's persisted `"api-key"` selection to this; this suite builds the widened selection
  // directly, exactly the shape that widening produces.
  const consoleSelection: RuntimeSelection = { ...apiKeySelection, authFamily: "console-profile" };
  const HOME = "/Users/x/.winter-test-home";
  const input: OfficialSessionInput = { sessionId: "s_1", mode: "code", cwd: "/Users/x/repo" };
  // A REAL anthropic authRef present on the provider — the strongest proof that the console arm's
  // ANTHROPIC_API_KEY omission is structural (the credential plan is never even asked), not an
  // accident of no credential existing to inject in the first place.
  const provider = { providerId: "anthropic", authRef: { kind: "keychain" as const, account: "anthropic:default" } };
  // Fix wave (F1): the router-version gate now compares the PINNED `REQUIRED_WINTER_RUNTIME_SDK`
  // ("0.0.4") against `CONSOLE_AUTH_ROUTER_MIN` ("0.0.4"), never a runtime probe of the installed
  // package — so no override is needed here at all any more; this block's own job is the console
  // arm's ENV SHAPE, never the gate itself (that has its own describe block below).

  function build(selection: RuntimeSelection): { input: import("@yanlinglabs/winter-runtime-sdk").RouterOfficialInput; anthropicConfigDirToEnsure?: string } {
    const result = officialInputFor(input, minimalDeps({
      home: HOME, selection, provider, explicitCredentials: undefined,
    }));
    if (!("input" in result)) throw new Error(`officialInputFor unexpectedly refused: ${String((result as { message?: string }).message)}`);
    return result;
  }

  test("console arm: ANTHROPIC_PROFILE + ANTHROPIC_CONFIG_DIR are set in connectionEnv (never base), ANTHROPIC_API_KEY is absent from base, connectionEnv AND credentials", () => {
    const built = build(consoleSelection);
    expect(built.input.connectionEnv?.ANTHROPIC_PROFILE).toBe(ANTHROPIC_PROFILE_NAME);
    expect(built.input.connectionEnv?.ANTHROPIC_CONFIG_DIR).toBe(anthropicConfigDirFor(HOME));
    expect(built.input.base?.ANTHROPIC_PROFILE).toBeUndefined();
    expect(built.input.base?.ANTHROPIC_CONFIG_DIR).toBeUndefined();
    expect(built.input.base?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(built.input.connectionEnv?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(built.input.credentials ?? []).toEqual([]);
    expect(built.input.credentials ?? []).not.toContainEqual(expect.objectContaining({ variable: "ANTHROPIC_API_KEY" }));
  });

  test("console arm: anthropicConfigDirToEnsure is set so official-session.ts's open() hardens it 0700", () => {
    const built = build(consoleSelection);
    expect(built.anthropicConfigDirToEnsure).toBe(anthropicConfigDirFor(HOME));
  });

  test("api-key arm (selection.authFamily === \"api-key\"): base/connectionEnv carry neither console var; ANTHROPIC_API_KEY IS injected via the credential plan", () => {
    const built = build(apiKeySelection);
    expect(built.input.base?.ANTHROPIC_PROFILE).toBeUndefined();
    expect(built.input.base?.ANTHROPIC_CONFIG_DIR).toBeUndefined();
    expect(built.input.connectionEnv?.ANTHROPIC_PROFILE).toBeUndefined();
    expect(built.input.connectionEnv?.ANTHROPIC_CONFIG_DIR).toBeUndefined();
    expect(built.input.credentials).toEqual([{ variable: "ANTHROPIC_API_KEY", ref: provider.authRef }]);
    expect(built.anthropicConfigDirToEnsure).toBeUndefined();
  });

  // The scrub matrix stays green THROUGH this real door too, not just at officialAuthChildEnvFor's
  // own unit level (official-options.test.ts's earlier describe block covers that unit level).
  test("scrub matrix: every FORBIDDEN_CHILD_ENV sentinel is gone from the console arm's real base; the door's own two ride connectionEnv instead", () => {
    const hostEnv: Record<string, string> = { HOME: "/Users/x", PATH: "/usr/bin:/bin" };
    for (const name of FORBIDDEN_CHILD_ENV) hostEnv[name] = `SENTINEL_${name}`;
    const result = officialInputFor(input, minimalDeps({
      home: HOME, selection: consoleSelection, provider, explicitCredentials: undefined, env: hostEnv,
    }));
    if (!("input" in result)) throw new Error("unexpectedly refused");
    for (const name of FORBIDDEN_CHILD_ENV) {
      expect(result.input.base?.[name]).not.toBe(`SENTINEL_${name}`);
      expect(result.input.base?.[name]).toBeUndefined();
    }
    expect(result.input.connectionEnv?.ANTHROPIC_PROFILE).toBe(ANTHROPIC_PROFILE_NAME);
    expect(result.input.connectionEnv?.ANTHROPIC_CONFIG_DIR).toBe(anthropicConfigDirFor(HOME));
  });
});

// Winter Phase 10a fix wave (F1): against a router BELOW `CONSOLE_AUTH_ROUTER_MIN` the console arm
// could not work — a pre-upgrade router forwards only its own minimal OS environment and runs its
// api-key credential plan itself regardless of arm, so a console child would get the OAuth bearer
// profile injected as ANTHROPIC_API_KEY. `officialAuthFamilyFor(...) === "console"` therefore
// refuses typed BEFORE anything is spawned, gated on a single constant (`CONSOLE_AUTH_ROUTER_MIN`)
// compared against the COMPILE-TIME PIN (`REQUIRED_WINTER_RUNTIME_SDK`) — never a runtime probe of
// the installed package, which is exactly what made the gate dead inside a compiled `$bunfs`
// Release binary (the OLD `installedWinterRuntimeSdkVersion()` probe always answered `undefined`
// there, and `versionAtLeast(undefined, …)` is always `false`, so every Release console session
// refused permanently — that probe is now deleted, fix wave 3 Minor 3). This suite simulates a pin
// below/at/above the floor via `OfficialInputDeps.requiredWinterRuntimeSdkVersion` fakes to keep
// proving the gate itself still exists and still refuses below the floor.
describe("officialInputFor — the console arm refuses until the router pin supports it (F1)", () => {
  const apiKeySelection: RuntimeSelection = {
    runtimeKind: "claude-agent", providerId: "anthropic", modelRef: "anthropic/claude-sonnet-5",
    family: "claude", authFamily: "api-key", sdkVersion: "0.0.3", reason: "unit test", decidedAt: new Date(0).toISOString(),
  };
  // Winter Phase 10a (router 0.0.4, C1): `session-driver.ts`'s `assembleOfficial` is the one that
  // widens `authFamily` to `"console-profile"` — this suite builds the widened selection directly.
  const consoleSelection: RuntimeSelection = { ...apiKeySelection, authFamily: "console-profile" };
  const HOME = "/Users/x/.winter-test-home";
  const input: OfficialSessionInput = { sessionId: "s_1", mode: "code", cwd: "/Users/x/repo" };
  const provider = { providerId: "anthropic", authRef: { kind: "keychain" as const, account: "anthropic:default" } };

  test("a stubbed pin below the floor (0.0.3) refuses the console arm typed", () => {
    const result = officialInputFor(input, minimalDeps({
      home: HOME, selection: consoleSelection, provider, explicitCredentials: undefined,
      requiredWinterRuntimeSdkVersion: "0.0.3",
    }));
    expect(result).toBeInstanceOf(OfficialConsoleRouterUnsupported);
    expect((result as OfficialConsoleRouterUnsupported).code).toBe("official_console_router_unsupported");
    expect((result as OfficialConsoleRouterUnsupported).installedRouterVersion).toBe("0.0.3");
    expect((result as OfficialConsoleRouterUnsupported).requiredRouterVersion).toBe(CONSOLE_AUTH_ROUTER_MIN);
    expect((result as Error).message).toContain(CONSOLE_AUTH_ROUTER_MIN);
  });

  test("the refusal fires BEFORE any credential is read — the router is never consulted at all", () => {
    // A REAL anthropic authRef present on the provider: if the refusal fired late (after the
    // credential plan already ran), this would still pass by accident. Asserting the RETURN TYPE
    // (never `"input" in result`) is what actually proves nothing downstream ran.
    const result = officialInputFor(input, minimalDeps({
      home: HOME, selection: consoleSelection, provider, explicitCredentials: undefined,
      requiredWinterRuntimeSdkVersion: "0.0.3",
    }));
    expect("input" in result).toBe(false);
  });

  test("the REAL pin (0.0.4, no override) does not refuse the console arm", () => {
    const result = officialInputFor(input, minimalDeps({
      home: HOME, selection: consoleSelection, provider, explicitCredentials: undefined,
    }));
    expect("input" in result).toBe(true);
  });

  test("the api-key arm is completely unaffected by the router-version gate", () => {
    const result = officialInputFor(input, minimalDeps({
      home: HOME, selection: apiKeySelection, provider, explicitCredentials: undefined,
    }));
    expect("input" in result).toBe(true);
  });

  test("a stubbed pin AT the floor (0.0.4) lets the console arm build normally", () => {
    const result = officialInputFor(input, minimalDeps({
      home: HOME, selection: consoleSelection, provider, explicitCredentials: undefined,
      requiredWinterRuntimeSdkVersion: "0.0.4",
    }));
    expect("input" in result).toBe(true);
  });

  test("a stubbed pin ABOVE the floor (0.0.10 — numeric, never lexicographic, comparison) also lets it build", () => {
    const result = officialInputFor(input, minimalDeps({
      home: HOME, selection: consoleSelection, provider, explicitCredentials: undefined,
      requiredWinterRuntimeSdkVersion: "0.0.10",
    }));
    expect("input" in result).toBe(true);
  });

  // Fix wave 3 (Minor 3): `installedWinterRuntimeSdkVersion()` (the runtime probe this gate used
  // to read, before F1) is DELETED from versions.ts now that nothing but this file's own test ever
  // called it — the gate has read only the compile-time pin since F1, so there is no runtime probe
  // left in this file to simulate the compiled-$bunfs case against. The pin-based coverage above
  // (below/at/above the floor, plus "no override uses the real pin") is the complete proof; the
  // compiled-binary scenario specifically is that the pin resolves at COMPILE time, so it can never
  // be `undefined` the way a `createRequire`-based runtime probe could.

  test("an unresolvable STUBBED pin (undefined override, falls back to the real pin) does not refuse", () => {
    const result = officialInputFor(input, minimalDeps({
      home: HOME, selection: consoleSelection, provider, explicitCredentials: undefined,
      requiredWinterRuntimeSdkVersion: undefined,
    }));
    expect("input" in result).toBe(true);
  });

  // even once the router pin DOES support the console arm, the console arm must never hand
  // `credentials` containing an anthropic key to the router — kept as a standing guard, not retired
  // when the gate above stops firing.
  test("even with a supported pin, the console arm NEVER hands the router credentials containing an anthropic key", () => {
    const result = officialInputFor(input, minimalDeps({
      home: HOME, selection: consoleSelection, provider, explicitCredentials: undefined,
    }));
    if (!("input" in result)) throw new Error(`officialInputFor unexpectedly refused: ${String((result as { message?: string }).message)}`);
    expect(result.input.credentials ?? []).toEqual([]);
    expect(result.input.credentials ?? []).not.toContainEqual(expect.objectContaining({ variable: "ANTHROPIC_API_KEY" }));
    expect(result.input.base?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.input.connectionEnv?.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

// Winter Phase 10a fix wave (F3, load-bearing guard): the console arm's own subscription guard —
// see `OfficialConsoleProfileMissing`'s own doc for the measured precedence fact this check exists
// to enforce ("an explicit profile outranks a stored claude.ai login; a MISSING profile falls back
// to it instead of refusing"). `minimalDeps()` defaults `consoleProfileExists` to `() => true`
// (its own comment explains why); this block is the one place that flips it to prove the guard.
describe("officialInputFor — the console arm's own subscription guard: console_profile_missing (F3)", () => {
  const apiKeySelection: RuntimeSelection = {
    runtimeKind: "claude-agent", providerId: "anthropic", modelRef: "anthropic/claude-sonnet-5",
    family: "claude", authFamily: "api-key", sdkVersion: "0.0.3", reason: "unit test", decidedAt: new Date(0).toISOString(),
  };
  const consoleSelection: RuntimeSelection = { ...apiKeySelection, authFamily: "console-profile" };
  const HOME = "/Users/x/.winter-test-home";
  const input: OfficialSessionInput = { sessionId: "s_1", mode: "code", cwd: "/Users/x/repo" };
  const provider = { providerId: "anthropic", authRef: { kind: "keychain" as const, account: "anthropic:default" } };

  test("an explicit console pin with no profile yet refuses typed console_profile_missing", () => {
    const result = officialInputFor(input, minimalDeps({
      home: HOME, selection: consoleSelection, provider, explicitCredentials: undefined,
      consoleProfileExists: () => false,
    }));
    expect(result).toBeInstanceOf(OfficialConsoleProfileMissing);
    expect((result as OfficialConsoleProfileMissing).code).toBe("console_profile_missing");
    expect((result as OfficialConsoleProfileMissing).home).toBe(HOME);
  });

  test("the refusal fires BEFORE any credential is read — the router is never consulted at all", () => {
    // A REAL anthropic authRef present on the provider, same proof shape as the F1 gate's own
    // identical test: if the refusal fired late, this would still pass by accident.
    const result = officialInputFor(input, minimalDeps({
      home: HOME, selection: consoleSelection, provider, explicitCredentials: undefined,
      consoleProfileExists: () => false,
    }));
    expect("input" in result).toBe(false);
  });

  test("a resume after winter logout --anthropic-console deleted the profile also refuses — the check is LIVE, not a cached decision from an earlier call", () => {
    // Simulates the exact scenario the guard's own doc names: the SAME deps shape a resume would
    // rebuild, but the profile is now gone. A single mutable flag proves this is re-read on every
    // call, never memoized from an earlier "yes" (e.g. the very login that opened this session).
    let present = true;
    const deps = minimalDeps({
      home: HOME, selection: consoleSelection, provider, explicitCredentials: undefined,
      consoleProfileExists: () => present,
    });
    const beforeLogout = officialInputFor(input, deps);
    expect("input" in beforeLogout).toBe(true);
    present = false; // `winter logout --anthropic-console` ran between the two calls
    const afterLogout = officialInputFor(input, deps);
    expect(afterLogout).toBeInstanceOf(OfficialConsoleProfileMissing);
  });

  test("the api-key arm is completely unaffected by this guard", () => {
    const result = officialInputFor(input, minimalDeps({
      home: HOME, selection: apiKeySelection, provider, explicitCredentials: undefined,
      consoleProfileExists: () => false,
    }));
    expect("input" in result).toBe(true);
  });

  test("a present profile (the default) builds normally", () => {
    const result = officialInputFor(input, minimalDeps({
      home: HOME, selection: consoleSelection, provider, explicitCredentials: undefined,
    }));
    expect("input" in result).toBe(true);
  });

  test("with no override at all, the REAL existsSync check runs against the symbolic home and refuses (never silently treated as present)", () => {
    // No `consoleProfileExists` override — proves the REAL `existsSync(consoleProfileCredentialFile(home))`
    // path is what runs by default, and that a never-filesystem-backed home reads as "missing", not
    // "present" (the opposite default would silently defeat the guard for every caller that forgot
    // to wire the override).
    const deps = minimalDeps({ home: HOME, selection: consoleSelection, provider, explicitCredentials: undefined });
    delete (deps as { consoleProfileExists?: unknown }).consoleProfileExists;
    const result = officialInputFor(input, deps);
    expect(result).toBeInstanceOf(OfficialConsoleProfileMissing);
  });
});

// Winter Phase 10a fix wave 4 (Major M-C, Opus review, reproduced): the official leg's own
// "anthropic" credential ref must NEVER move with live settings mid-session — only the session's
// own FIXED `RuntimeSelection.authFamily` (decided once, at assembly, by `session-driver.ts`'s
// `assembleOfficial`) may decide it. `session-driver.ts`'s `inputDeps()` is a private per-`open()`
// closure this file cannot import directly, so this suite reproduces its exact call shape against
// a REAL `FileSecretStore`-backed home: `providerSelectionFor(live.model, credentials, deps.home
// [, deps.settings()])` — the literal expression at `session-driver.ts`'s `inputDeps()` (search
// "Winter Phase 10a fix wave 4 (M-C)" there for the fixed call site) — then feeds the result into
// the REAL, unmodified `officialInputFor` to prove the end-to-end credential plan.
//
// THE SCENARIO (the review's own words): (1) a user with an API key has a live official session
// assembled on the api-key arm in "auto" mode; (2) they sign in with Console — the profile file and
// the `anthropic:console` bearer both appear; (3) the child exits, leaving the session resumable;
// (4) the next send re-opens it. Before the fix, step 4's credential build (still threading live
// `settings` into `providerSelectionFor`) re-points `provider.authRef` at `anthropic:console` even
// though `selection.authFamily` is still the assembly-time `"api-key"` — and the router's own
// `officialCredentialPlan` derives `ANTHROPIC_API_KEY` from `provider.authRef` for the api-key
// family regardless of which account that ref names, so the child receives
// `ANTHROPIC_API_KEY=<the Console OAuth bearer>`.
describe("the official leg's own anthropic ref must never drift with live settings mid-session (P10a fix wave 4, M-C)", () => {
  const MODEL = "anthropic/claude-fable-5"; // a real pinned-catalog qualified anthropic key
  const API_KEY_MATERIAL = "sk-test-real-api-key-material";
  const CONSOLE_BEARER_MATERIAL = "CONSOLE-OAUTH-BEARER-must-never-reach-ANTHROPIC_API_KEY";
  const fixedApiKeySelection: RuntimeSelection = {
    runtimeKind: "claude-agent", providerId: "anthropic", modelRef: MODEL,
    family: "claude", authFamily: "api-key", sdkVersion: "0.0.3", reason: "unit test", decidedAt: new Date(0).toISOString(),
  };
  const input: OfficialSessionInput = { sessionId: "s_mc", mode: "code", cwd: "/repo" };

  function fixture(): { home: string; store: FileSecretStore } {
    const home = mkdtempSync(join(tmpdir(), "winter-official-mc-"));
    return { home, store: new FileSecretStore(join(home, "secrets")) };
  }

  /** Writes the console profile's own presence marker (content is never validated — presence
   *  only, per `officialAuthFamilyFor`'s own doc) and seeds the console broker's bearer material,
   *  reproducing "the user signs in with Console" between the two calls a test makes. */
  async function signInWithConsole(home: string, store: FileSecretStore): Promise<void> {
    const profileDir = join(anthropicConfigDirFor(home), "credentials");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, `${ANTHROPIC_PROFILE_NAME}.json`), JSON.stringify({ ok: true }));
    await writeCredentialMaterial(store, ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME, { kind: "bearer", token: CONSOLE_BEARER_MATERIAL });
  }

  test("REPRODUCTION (fails before the fix): the old call shape (WITH live settings) re-points ANTHROPIC_API_KEY at the Console bearer after a Console sign-in", async () => {
    const { home, store } = fixture();
    try {
      await writeCredentialMaterial(store, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: API_KEY_MATERIAL });
      const settings = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "x" } }); // "auto" — no runtimes.official.auth override

      // Session assembly time: no console profile yet -> the api-key arm, exactly what
      // `officialAuthFamilyFor` + `assembleOfficial` decide when the session is first created.
      // This is the session's FIXED selection (`fixedApiKeySelection`) — never recomputed below.
      expect(officialAuthFamilyFor(home, settings, false)).toBe("api-key");

      // Sanity: before the Console sign-in, even the OLD (settings-threaded) call shape agrees.
      const credentialsBefore = await credentialPresenceFrom(store);
      const providerBefore = providerSelectionFor(MODEL, credentialsBefore, home, settings);
      expect(providerBefore?.authRef).toEqual({ kind: "keychain", account: ANTHROPIC_CREDENTIAL_SECRET_NAME, service: keychainService(undefined, home) });

      // The drift: nothing about `fixedApiKeySelection.authFamily` changes.
      await signInWithConsole(home, store);

      // "The next send re-opens it" — the OLD `inputDeps()` call shape, reproduced verbatim.
      const credentialsAfter = await credentialPresenceFrom(store);
      const providerAfterWithSettings = providerSelectionFor(MODEL, credentialsAfter, home, settings);

      // THE BUG: `selection.authFamily` is still "api-key" (untouched), but the live-settings call
      // now names the CONSOLE account.
      expect(providerAfterWithSettings?.authRef).toEqual({ kind: "keychain", account: ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME, service: keychainService(undefined, home) });

      // Feeding that into the REAL router-facing `officialInputFor`, against the session's own
      // FIXED api-key selection, shows the actual leak.
      const builtBuggy = officialInputFor(input, minimalDeps({
        home, selection: fixedApiKeySelection, provider: providerAfterWithSettings, explicitCredentials: undefined,
      }));
      if (!("input" in builtBuggy)) throw new Error("unexpectedly refused");
      const leakedRef = builtBuggy.input.credentials?.find((c) => c.variable === "ANTHROPIC_API_KEY")?.ref;
      expect(leakedRef).toEqual({ kind: "keychain", account: ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME, service: keychainService(undefined, home) });
      const leakedValue = leakedRef === undefined ? undefined : await keychainSeamFromSecretStore(store, home).read(leakedRef);
      expect(leakedValue).toBe(CONSOLE_BEARER_MATERIAL); // the OAuth bearer, injected as ANTHROPIC_API_KEY — the leak
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("THE FIX: the settings-independent call session-driver.ts now makes stays on anthropic:default after the SAME Console sign-in — the api-key material, never the bearer", async () => {
    const { home, store } = fixture();
    try {
      await writeCredentialMaterial(store, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: API_KEY_MATERIAL });
      const settings = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "x" } });
      expect(officialAuthFamilyFor(home, settings, false)).toBe("api-key");

      await signInWithConsole(home, store);

      // `session-driver.ts`'s `inputDeps()`, post-fix: `providerSelectionFor(live.model,
      // credentials, deps.home)` — no `settings` argument, ever.
      const credentialsAfter = await credentialPresenceFrom(store);
      const providerFixed = providerSelectionFor(MODEL, credentialsAfter, home);
      expect(providerFixed?.authRef).toEqual({ kind: "keychain", account: ANTHROPIC_CREDENTIAL_SECRET_NAME, service: keychainService(undefined, home) });

      const built = officialInputFor(input, minimalDeps({
        home, selection: fixedApiKeySelection, provider: providerFixed, explicitCredentials: undefined,
      }));
      if (!("input" in built)) throw new Error("unexpectedly refused");
      const injectedRef = built.input.credentials?.find((c) => c.variable === "ANTHROPIC_API_KEY")?.ref;
      expect(injectedRef).toEqual({ kind: "keychain", account: ANTHROPIC_CREDENTIAL_SECRET_NAME, service: keychainService(undefined, home) });
      const injectedValue = injectedRef === undefined ? undefined : await keychainSeamFromSecretStore(store, home).read(injectedRef);
      expect(injectedValue).toBe(API_KEY_MATERIAL); // the user's own api-key material — never the bearer
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("ensureOfficialConfigDir", () => {
  test("creates the directory 0700, and re-hardens an already-existing, more-permissive one", () => {
    const root = mkdtempSync(join(tmpdir(), "winter-official-config-dir-"));
    try {
      const dir = join(root, "runtimes", "claude-config");
      expect(existsSync(dir)).toBe(false);
      ensureOfficialConfigDir(dir);
      expect(existsSync(dir)).toBe(true);
      expect(statSync(dir).mode & 0o777).toBe(0o700);

      // A stale, more permissive mode (e.g. from an older daemon version) is corrected, not left alone.
      chmodSync(dir, 0o755);
      expect(statSync(dir).mode & 0o777).toBe(0o755);
      ensureOfficialConfigDir(dir);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Winter Phase 10a (O2, P10a-2/P10a-3): the console-login building blocks — `anthropicConfigDirFor`,
// `officialAuthFamilyFor`, and the env builder for the two auth arms. These are standalone, pure(-ish)
// helpers exercised directly here; they are NOT wired into `officialInputFor`'s own spawn decision in
// this lane (that decision is `session-driver.ts`'s, out of this file cluster) — see this describe
// block's own header in the lane report for why.

describe("anthropicConfigDirFor / ANTHROPIC_PROFILE_NAME", () => {
  test("is <home>/runtimes/anthropic-config — a sibling of officialConfigDirFor's claude-config, never the same directory", () => {
    const home = "/Users/x/.winter-test-home";
    expect(anthropicConfigDirFor(home)).toBe(join(home, "runtimes", "anthropic-config"));
    expect(anthropicConfigDirFor(home)).not.toBe(officialConfigDirFor(home));
  });

  test("a different home produces a different path — never a constant", () => {
    expect(anthropicConfigDirFor("/a")).not.toBe(anthropicConfigDirFor("/b"));
  });

  test("the profile name is the literal \"winter\" (P10a-2: one profile, one config dir)", () => {
    expect(ANTHROPIC_PROFILE_NAME).toBe("winter");
  });
});

describe("officialAuthFamilyFor (P10a-3)", () => {
  const home = mkdtempSync(join(tmpdir(), "winter-official-auth-family-"));
  const settingsWith = (auth?: "auto" | "api-key" | "console"): Settings =>
    ({ schemaVersion: 2, provider: { type: "codex-oauth", model: "x" }, ...(auth === undefined ? {} : { runtimes: { official: { auth } } }) }) as unknown as Settings;

  test("explicit \"api-key\" always wins, profile or no profile", () => {
    expect(officialAuthFamilyFor(home, settingsWith("api-key"), true)).toBe("api-key");
    expect(officialAuthFamilyFor(home, settingsWith("api-key"), false)).toBe("api-key");
  });

  test("explicit \"console\" always wins, api-key material or none", () => {
    expect(officialAuthFamilyFor(home, settingsWith("console"), true)).toBe("console");
    expect(officialAuthFamilyFor(home, settingsWith("console"), false)).toBe("console");
  });

  test("\"auto\" (absent settings, absent block, or explicit \"auto\") picks api-key when no console profile file exists", () => {
    expect(officialAuthFamilyFor(home, null, true)).toBe("api-key");
    expect(officialAuthFamilyFor(home, settingsWith(), true)).toBe("api-key");
    expect(officialAuthFamilyFor(home, settingsWith("auto"), true)).toBe("api-key");
  });

  test("\"auto\" picks console once <dir>/credentials/winter.json exists on disk", () => {
    const dir = join(anthropicConfigDirFor(home), "credentials");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${ANTHROPIC_PROFILE_NAME}.json`), "{}");
    try {
      expect(officialAuthFamilyFor(home, settingsWith("auto"), true)).toBe("console");
      expect(officialAuthFamilyFor(home, settingsWith("auto"), false)).toBe("console");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("officialAuthChildEnvFor — the scrub matrix (P10a-2)", () => {
  const home = "/Users/x/.winter-test-home";

  test("console arm sets ANTHROPIC_PROFILE + ANTHROPIC_CONFIG_DIR and nothing else", () => {
    expect(officialAuthChildEnvFor("console", home)).toEqual({
      ANTHROPIC_PROFILE: ANTHROPIC_PROFILE_NAME,
      ANTHROPIC_CONFIG_DIR: anthropicConfigDirFor(home),
    });
  });

  test("api-key arm sets nothing — no ANTHROPIC_PROFILE, no ANTHROPIC_CONFIG_DIR", () => {
    expect(officialAuthChildEnvFor("api-key", home)).toEqual({});
  });

  test("neither arm ever sets ANTHROPIC_API_KEY (the credential plan's own variable, never this door's)", () => {
    expect(officialAuthChildEnvFor("console", home)).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(officialAuthChildEnvFor("api-key", home)).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  // The scrub matrix proper: for EVERY name in FORBIDDEN_CHILD_ENV, seed a sentinel into the host
  // env, run it through minimalOsEnvironment + the FORBIDDEN_CHILD_ENV strip exactly as
  // `officialInputFor` does, THEN merge in this arm's own env — the two intentionally-forbidden
  // names this door itself sets (ANTHROPIC_PROFILE, CLAUDE_CONFIG_DIR is untouched by this door)
  // must come back from THIS call, never from a leaked host sentinel.
  test("console arm: every FORBIDDEN_CHILD_ENV sentinel is scrubbed from base; ANTHROPIC_PROFILE/CONFIG_DIR come from this door only", () => {
    const hostEnv: Record<string, string> = { HOME: "/Users/x", PATH: "/usr/bin" };
    for (const name of FORBIDDEN_CHILD_ENV) hostEnv[name] = `SENTINEL_${name}`;
    const base: Record<string, string> = minimalOsEnvironment(hostEnv);
    for (const name of FORBIDDEN_CHILD_ENV) delete base[name];
    const merged = { ...base, ...officialAuthChildEnvFor("console", home) };
    for (const name of FORBIDDEN_CHILD_ENV) {
      if (name === "ANTHROPIC_PROFILE") { expect(merged[name]).toBe(ANTHROPIC_PROFILE_NAME); continue; }
      if (name === "CLAUDE_CONFIG_DIR") { expect(merged[name]).toBeUndefined(); continue; } // this door never sets it
      expect(merged[name]).not.toBe(`SENTINEL_${name}`);
      expect(merged[name]).toBeUndefined();
    }
  });

  test("api-key arm: every FORBIDDEN_CHILD_ENV sentinel is scrubbed, and none of them comes back (this arm sets nothing)", () => {
    const hostEnv: Record<string, string> = { HOME: "/Users/x", PATH: "/usr/bin" };
    for (const name of FORBIDDEN_CHILD_ENV) hostEnv[name] = `SENTINEL_${name}`;
    const base: Record<string, string> = minimalOsEnvironment(hostEnv);
    for (const name of FORBIDDEN_CHILD_ENV) delete base[name];
    const merged = { ...base, ...officialAuthChildEnvFor("api-key", home) };
    for (const name of FORBIDDEN_CHILD_ENV) expect(merged[name]).toBeUndefined();
  });
});

describe("effectiveOfficialAuthFor (O6, provider.status)", () => {
  test("explicit \"console\" is effective ONLY when the profile actually exists — never falls back to api-key", () => {
    expect(effectiveOfficialAuthFor("console", true, true)).toBe("console");
    expect(effectiveOfficialAuthFor("console", true, false)).toBe("none");
    expect(effectiveOfficialAuthFor("console", false, false)).toBe("none");
  });

  test("explicit \"api-key\" is effective ONLY when the key material actually exists — never falls back to console", () => {
    expect(effectiveOfficialAuthFor("api-key", true, true)).toBe("api-key");
    expect(effectiveOfficialAuthFor("api-key", false, true)).toBe("none");
    expect(effectiveOfficialAuthFor("api-key", false, false)).toBe("none");
  });

  test("\"auto\" prefers console, then api-key, then none", () => {
    expect(effectiveOfficialAuthFor("auto", true, true)).toBe("console");
    expect(effectiveOfficialAuthFor("auto", true, false)).toBe("api-key");
    expect(effectiveOfficialAuthFor("auto", false, true)).toBe("console");
    expect(effectiveOfficialAuthFor("auto", false, false)).toBe("none");
  });
});

// Minor 4 (whole-branch review, adopting m6): placed AFTER every `describe` above — including
// `officialInputFor — official_project_key_too_deep`'s own restoring `afterEach` — per this
// tripwire's own header: it must be the LAST lifecycle hook the file registers so its `afterAll`
// (deferred to a microtask) sees this file's truly final `mock.module` state.
installMockModuleTripwire();
