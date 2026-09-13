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
import type { Settings } from "../../src/settings";
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
  OfficialProjectKeyTooDeep,
  type OfficialInputDeps,
  type OfficialPermissionMode,
  type OfficialSessionInput,
} from "../../src/runtime-sdk/official-options";

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
