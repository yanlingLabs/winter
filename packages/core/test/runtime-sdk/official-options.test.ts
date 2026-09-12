// M7 — `official-options.ts` was untested; this pins its four load-bearing, pure(-ish) pieces:
// the six-valued permission-mode mapping (D14/P8c-2's "never bypassPermissions on this leg"), the
// minimal-OS-environment allowlist (§3), the project-key-too-deep refusal (§14's own guard, even
// though the pinned `transcriptProjectKey` self-truncates so no REAL path reaches it today — see
// that test's own comment), and the auto-memory-directory equality with the Winter leg's own MEMDIR
// helper (WS-14 §2: "identical for both branches").
import { afterEach, describe, expect, mock, test } from "bun:test";
import { installMockModuleTripwire } from "../mock-module-tripwire";
import * as winterAgentSdk from "@yanlinglabs/winter-agent-sdk";
import type { RuntimeSelection } from "@yanlinglabs/winter-runtime-sdk";
import { ApprovalBroker } from "../../src/agent/approvals";
import { PermissionGate } from "../../src/agent/gate";
import { QuestionBroker } from "../../src/agent/questions";
import type { SessionApprovalPolicy } from "../../src/agent/gate";
import { assistantMemoryDirFor, memoryDirFor } from "../../src/agent/memory-dir";
import { controlPlaneDenyRules, disallowedToolsFor, sandboxConfigFor } from "../../src/runtime-sdk/mode-options";
import {
  autoMemoryDirectoryFor,
  minimalOsEnvironment,
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
      NORMA_HOME: "/Users/x/.norma",
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
  const HOME = "/Users/x/.norma-test-home";
  const base = (mode: OfficialSessionInput["mode"]): OfficialSessionInput => ({ sessionId: "s_1", mode, cwd: "/Users/x/repo" });

  test("code -> the SAME per-project MEMDIR the Winter leg's memoryDirFor resolves to", () => {
    const input = base("code");
    expect(autoMemoryDirectoryFor(input, HOME)).toBe(memoryDirFor(input.cwd, { normaHome: HOME }));
  });

  test("dispatch and chat -> the SAME shared _assistant bucket assistantMemoryDirFor resolves to", () => {
    expect(autoMemoryDirectoryFor(base("dispatch"), HOME)).toBe(assistantMemoryDirFor({ normaHome: HOME }));
    expect(autoMemoryDirectoryFor(base("chat"), HOME)).toBe(assistantMemoryDirFor({ normaHome: HOME }));
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
    home: "/Users/x/.norma-test-home",
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
  function optionsFor(mode: OfficialSessionInput["mode"], home = "/Users/x/.norma-test-home"): Record<string, unknown> {
    const input: OfficialSessionInput = { sessionId: "s_1", mode, cwd: "/Users/x/repo" };
    const result = officialInputFor(input, minimalDeps({ home }));
    if (!("input" in result)) throw new Error(`officialInputFor unexpectedly refused: ${String((result as { message?: string }).message)}`);
    return result.input.options as unknown as Record<string, unknown>;
  }

  test("settings.permissions.deny is EXACTLY controlPlaneDenyRules(home) — the same builder Winter uses", () => {
    const home = "/Users/x/.norma-test-home";
    const options = optionsFor("code", home);
    const settings = options.settings as { permissions?: { deny?: string[] } } | undefined;
    expect(settings?.permissions?.deny).toEqual(controlPlaneDenyRules(home));
    // Non-vacuous: this is a real list of rules, not an accidentally-empty array satisfying `toEqual`.
    expect(settings?.permissions?.deny?.length).toBeGreaterThan(0);
  });

  test("settings.sandbox is EXACTLY sandboxConfigFor(home) — same real directory paths, no globs", () => {
    const home = "/Users/x/.norma-test-home";
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
    const a = optionsFor("code", "/Users/x/.norma-test-home");
    const b = optionsFor("code", "/Users/y/.norma-other-home");
    const denyA = (a.settings as { permissions?: { deny?: string[] } }).permissions?.deny;
    const denyB = (b.settings as { permissions?: { deny?: string[] } }).permissions?.deny;
    expect(denyA).not.toEqual(denyB);
  });
});

// Minor 4 (whole-branch review, adopting m6): placed AFTER every `describe` above — including
// `officialInputFor — official_project_key_too_deep`'s own restoring `afterEach` — per this
// tripwire's own header: it must be the LAST lifecycle hook the file registers so its `afterAll`
// (deferred to a microtask) sees this file's truly final `mock.module` state.
installMockModuleTripwire();
