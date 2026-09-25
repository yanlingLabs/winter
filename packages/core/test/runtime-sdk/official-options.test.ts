// M7 — `official-options.ts` was untested; this pins its four load-bearing, pure(-ish) pieces:
// the six-valued permission-mode mapping (D14/P8c-2's "never bypassPermissions on this leg"), the
// minimal-OS-environment allowlist (§3), the project-key-too-deep refusal (§14's own guard, even
// though the pinned `transcriptProjectKey` self-truncates so no REAL path reaches it today — see
// that test's own comment), and the auto-memory-directory equality with the Winter leg's own MEMDIR
// helper (WS-14 §2: "identical for both branches").
import { afterEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installMockModuleTripwire } from "../mock-module-tripwire";
import * as winterAgentSdk from "@yanlinglabs/winter-agent-sdk";
import type { CanUseTool } from "@yanlinglabs/winter-agent-sdk";
import type { RuntimeSelection } from "@yanlinglabs/winter-runtime-sdk";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { ApprovalBroker } from "../../src/agent/approvals";
import { ContextAssembler } from "../../src/agent/context";
import { PermissionGate } from "../../src/agent/gate";
import { QuestionBroker } from "../../src/agent/questions";
import { SkillStore } from "../../src/agent/skills";
import { TrustStore } from "../../src/agent/trust";
import type { SessionApprovalPolicy } from "../../src/agent/gate";
import { assistantMemoryDirFor, memoryDirFor } from "../../src/agent/memory-dir";
import { buildWinterOptions, controlPlaneDenyRules, disallowedToolsFor, GLOBAL_READ_ALLOW_RULES, childSandboxConfigFor, sandboxConfigFor, WEB_BUILTIN_ALLOW_RULES, type WinterOptionsInput } from "../../src/runtime-sdk/mode-options";
import { winterSystemPromptFor } from "../../src/runtime-sdk/system-prompt";
import { Settings } from "../../src/settings";
import {
  ANTHROPIC_PROFILE_NAME,
  anthropicConfigDirFor,
  autoMemoryDirectoryFor,
  effectiveOfficialAuthFor,
  ensureOfficialConfigDir,
  FORBIDDEN_CHILD_ENV,
  minimalOsEnvironment,
  officialAuthArmFor,
  officialAuthChildEnvFor,
  officialConfigDirFor,
  officialInputFor,
  officialPermissionModeFor,
  officialWireModelFor,
  OfficialConsoleProfileMissing,
  OfficialNoWireModel,
  OfficialConsoleRouterUnsupported,
  OfficialProjectKeyTooDeep,
  type OfficialInputDeps,
  type OfficialPermissionMode,
  type OfficialSessionInput,
} from "../../src/runtime-sdk/official-options";
import { CONSOLE_AUTH_ROUTER_MIN, REQUIRED_WINTER_RUNTIME_SDK, versionAtLeast } from "../../src/runtime-sdk/versions";
import { storeProjectsDir } from "../../src/agent/paths";

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
//
// autoMemoryDirectoryFor used to re-derive this path BY HAND (`assistantMemoryDirFor`/`memoryDirFor`
// called fresh, with only `{winterHome: home}`) instead of asking `ContextAssembler.memoryDirFor` —
// the SAME method `winterSystemPromptFor`'s own `assemble()` call now uses to build the system
// prompt's own MEMDIR section. Re-deriving by hand silently dropped three things: the user's
// `settings.memory.directory` override, the WS-16 §17 memory-key relocation, and `workdirLess` — so
// the official leg's child could be told, via `autoMemoryDirectory`, to write memory to a directory
// OTHER than the one its own system prompt had just named it. These tests exercise a REAL
// `ContextAssembler`, wired the same shape `daemon.ts` wires it in production, so they fail before
// the fix (proving the drift) and pin the fix (both routes now share one authority).

// realpathSync'd (macOS's own /tmp -> /private/tmp, /var -> /private/var symlinks would otherwise
// make a RAW mkdtempSync path compare unequal to the SAME directory once `memory-dir.ts`'s own
// `canon()` has resolved it — every path built from this helper needs to agree with what the code
// under test itself canonicalizes to).
function realDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "winter-official-mem-")));
}

/** A real `ContextAssembler`, wired the SAME shape `daemon.ts` wires it in production:
 *  `dirFor` (the project bucket) honours `directory`/`relocatedKey`; `assistantDir` deliberately
 *  does NOT (see `assistantMemoryDirFor`'s own doc — honouring the override there would leak dream
 *  memories into code sessions). Exercises the real `memoryDirFor`/`assistantMemoryDirFor` free
 *  functions, not a hand-rolled stand-in for them. */
function realAssembler(
  home: string,
  memoryOpts: { directory?: string; relocatedKey?: (todaysKey: string) => string | undefined; enabled?: boolean } = {},
): ContextAssembler {
  const trust = new TrustStore(join(home, "trust.json"));
  const skills = new SkillStore({ winterHome: home, trust });
  return new ContextAssembler({
    winterHome: home, trust, skills,
    memory: {
      enabled: () => memoryOpts.enabled ?? true,
      dirFor: (cwd) => memoryDirFor(cwd, { winterHome: home, directory: memoryOpts.directory, relocatedKey: memoryOpts.relocatedKey }),
      assistantDir: () => assistantMemoryDirFor({ winterHome: home }),
    },
  });
}

describe("autoMemoryDirectoryFor", () => {
  const base = (mode: OfficialSessionInput["mode"], cwd: string): OfficialSessionInput => ({ sessionId: "s_1", mode, cwd, primary: cwd, spendEffort: undefined });

  test("code -> the SAME per-project MEMDIR the Winter leg's memoryDirFor resolves to", () => {
    const home = realDir();
    const cwd = realDir();
    const assembler = realAssembler(home);
    const input = base("code", cwd);
    expect(autoMemoryDirectoryFor(input, assembler, home)).toBe(memoryDirFor(cwd, { winterHome: home }));
  });

  test("dispatch and chat -> the SAME shared _assistant bucket assistantMemoryDirFor resolves to", () => {
    const home = realDir();
    const cwd = realDir();
    const assembler = realAssembler(home);
    expect(autoMemoryDirectoryFor(base("dispatch", cwd), assembler, home)).toBe(assistantMemoryDirFor({ winterHome: home }));
    expect(autoMemoryDirectoryFor(base("chat", cwd), assembler, home)).toBe(assistantMemoryDirFor({ winterHome: home }));
  });

  test("dispatch/chat and code resolve to DIFFERENT directories (the split is real, not accidental equality)", () => {
    const home = realDir();
    const cwd = realDir();
    const assembler = realAssembler(home);
    expect(autoMemoryDirectoryFor(base("code", cwd), assembler, home)).not.toBe(autoMemoryDirectoryFor(base("dispatch", cwd), assembler, home));
  });

  test("a settings.memory.directory override reaches autoMemoryDirectory (previously silently dropped)", () => {
    const home = realDir();
    const cwd = realDir();
    const override = realDir(); // stands in for the user's `settings.memory.directory` pin
    const assembler = realAssembler(home, { directory: override });
    const input = base("code", cwd);
    expect(autoMemoryDirectoryFor(input, assembler, home)).toBe(override);
    // and it actually MOVED the answer — not a coincidental match with the un-overridden default.
    expect(autoMemoryDirectoryFor(input, assembler, home)).not.toBe(memoryDirFor(cwd, { winterHome: home }));
  });

  test("the directory override STILL reaches autoMemoryDirectory even while settings.memory.enabled is OFF (the router forces its own auto-memory on regardless, with no daemon-side way to turn it off — see autoMemoryDirectoryFor's own doc)", () => {
    const home = realDir();
    const cwd = realDir();
    const override = realDir();
    // `enabled: false` here mirrors a user who both pinned a custom MEMDIR AND turned Winter's own
    // memory feature off — a naive "fall back to the plain free functions whenever memory is
    // disabled" implementation would silently drop the override right back, which is the bug this
    // test pins shut.
    const assembler = realAssembler(home, { directory: override, enabled: false });
    const input = base("code", cwd);
    expect(autoMemoryDirectoryFor(input, assembler, home)).toBe(override);
  });

  test("a recorded WS-16 §17 memory-key relocation reaches autoMemoryDirectory (previously silently dropped)", () => {
    const home = realDir();
    const cwd = realDir();
    const relocatedTo = "some-relocated-key";
    const assembler = realAssembler(home, { relocatedKey: () => relocatedTo });
    const input = base("code", cwd);
    const expected = join(storeProjectsDir(home), relocatedTo, "memory"); // the store home: sdk/ on a run-home build
    expect(autoMemoryDirectoryFor(input, assembler, home)).toBe(expected);
    // and it actually MOVED the answer off the pre-relocation (OLD key) directory — the exact
    // failure mode P8b-17's own doc warns about: "the agent reads an empty directory at the old
    // key and starts a fresh MEMORY.md beside the user's own".
    expect(autoMemoryDirectoryFor(input, assembler, home)).not.toBe(memoryDirFor(cwd, { winterHome: home }));
  });

  test("a workdir-less code session gets the assistant bucket in BOTH routes (autoMemoryDirectory and the system prompt agree)", () => {
    const home = realDir();
    const cwd = realDir(); // session-driver.ts still defaults `cwd` to a session tmp dir even when workdir-less
    const assembler = realAssembler(home);
    const input: OfficialSessionInput = { sessionId: "s_1", mode: "code", cwd, primary: undefined, spendEffort: undefined }; // `primary: undefined` STATED: workdir-less
    const expected = assistantMemoryDirFor({ winterHome: home });
    expect(autoMemoryDirectoryFor(input, assembler, home)).toBe(expected);
    // the system prompt names the SAME directory (the protocol block always discloses its path,
    // workdir-less or not — see context.ts's memoryProtocol()).
    const prompt = winterSystemPromptFor(assembler, { mode: "code", primary: undefined, cwd });
    expect(prompt).toContain(`lives at the absolute path \`${expected}\``);
  });

  test("chat/dispatch's assistant bucket still IGNORES the directory override — the deliberate asymmetry assistantMemoryDirFor's own doc states", () => {
    const home = realDir();
    const cwd = realDir();
    const override = realDir();
    const assembler = realAssembler(home, { directory: override });
    expect(autoMemoryDirectoryFor(base("dispatch", cwd), assembler, home)).toBe(assistantMemoryDirFor({ winterHome: home }));
    expect(autoMemoryDirectoryFor(base("chat", cwd), assembler, home)).toBe(assistantMemoryDirFor({ winterHome: home }));
    expect(autoMemoryDirectoryFor(base("dispatch", cwd), assembler, home)).not.toBe(override);
    expect(autoMemoryDirectoryFor(base("chat", cwd), assembler, home)).not.toBe(override);
  });

  // ── the strongest test: pin agreement with the REAL system prompt text, not a second hand-written
  // expectation — a matrix over every (mode × workdirLess × override) combination this leg can spawn
  // into. `memDirNamedByPrompt` parses the directory straight out of `winterSystemPromptFor`'s own
  // output (the protocol block's disclosed path for the project bucket; the assistant index's
  // "auto-loaded from" path for the assistant bucket, which requires a MEMORY.md to exist — so the
  // assistant-bucket rows pre-create one at the ONE formula that bucket can ever resolve to,
  // `assistantMemoryDirFor`, regardless of override).
  function memDirNamedByPrompt(prompt: string): string {
    const project = prompt.match(/lives at the absolute path `([^`]+)`/);
    if (project) return project[1]!;
    const assistant = prompt.match(/Assistant memory index \(auto-loaded from (.+?); capped/);
    if (assistant) return assistant[1]!.replace(/\/MEMORY\.md$/, "");
    throw new Error(`no memory directory disclosed in prompt:\n${prompt}`);
  }

  test("matrix: autoMemoryDirectory EQUALS the directory winterSystemPromptFor's own assemble() call discloses, for every (mode × workdirLess × override) combination", () => {
    for (const mode of ["code", "dispatch", "chat"] as const) {
      for (const workdirLess of [false, true]) {
        for (const overridePresent of [false, true]) {
          const home = realDir();
          const cwd = realDir();
          const override = overridePresent ? realDir() : undefined;
          const assembler = realAssembler(home, { directory: override });
          const isAssistantBucket = mode === "dispatch" || mode === "chat";
          if (isAssistantBucket) {
            // the assistant bucket only discloses its path in the prompt when MEMORY.md exists —
            // pre-create it at the one directory that bucket can ever resolve to.
            const dir = assistantMemoryDirFor({ winterHome: home });
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "MEMORY.md"), "- [marker](marker.md) — matrix fixture\n");
          }
          const primary = workdirLess ? undefined : cwd;
          const input: OfficialSessionInput = { sessionId: "s_1", mode, cwd, primary, spendEffort: undefined };

          const prompt = winterSystemPromptFor(assembler, { mode, primary, cwd });
          const expected = memDirNamedByPrompt(prompt);

          expect(autoMemoryDirectoryFor(input, assembler, home)).toBe(expected);
        }
      }
    }
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
    // Every test in THIS describe block's minimalDeps() is about something other than the memory
    // directory (the control-plane fence, credential plans, auth arms, …) — a trivial stub that
    // reports "no memory config wired" is honest (the SAME answer a real assembler with no `memory`
    // dep gives) and keeps those tests undisturbed. `autoMemoryDirectoryFor`'s own describe block
    // above uses a REAL `ContextAssembler` instead, because that IS what it is testing.
    assembler: { assemble: () => "", memoryDirFor: () => undefined },
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

// The live approval-mode change, the DAEMON's own half (router 0.0.10). `createApprovalBridge`'s §10
// `dontAsk` arm answers ALLOW without consulting Winter's broker at all — correct while a session's
// mode could not change, and the widest hole in this whole change once it can: a session spawned
// `dont-ask` and switched to `ask` kept auto-allowing EVERY tool call, with no card and no event,
// because the bridge held the literal it was built with. The mode is now a getter over the same live
// policy the broker's gate reads, so both halves move together.
//
// Measured through the bridge the session would actually run (`input.options.canUseTool`), by calling
// it — `plan` is the destination policy because the gate denies under it SYNCHRONOUSLY, so the test
// needs no approval answer to tell "the broker was consulted" from "the bridge short-circuited".
describe("officialInputFor — the approval bridge's mode follows a live session.setPolicy", () => {
  const ask = async (bridge: unknown, toolName: string) =>
    (bridge as (name: string, input: Record<string, unknown>, rest: Record<string, unknown>) => Promise<{ behavior: string }>)(
      toolName,
      { file_path: "/repo/x.txt", content: "x" },
      { signal: new AbortController().signal, requestId: "r1", toolUseID: "t1" },
    );

  test("a dont-ask session switched to plan stops auto-allowing, on the SAME bridge", async () => {
    const policy: { current: "dont-ask" | "plan" } = { current: "dont-ask" };
    const deps = minimalDeps({
      policy: "dont-ask",
      canUseToolDeps: { approvals: new ApprovalBroker(), questions: new QuestionBroker(), gate: new PermissionGate(), policy: () => policy.current, emit: () => {} },
    });
    const result = officialInputFor({ sessionId: "s_1", mode: "code", cwd: "/repo", primary: "/repo", spendEffort: undefined }, deps);
    if (!("input" in result)) throw new Error(`officialInputFor unexpectedly refused: ${String((result as { message?: string }).message)}`);
    const bridge = (result.input.options as { canUseTool?: unknown }).canUseTool;
    expect(bridge).toBeDefined();
    // `dontAsk`: allowed, and the broker was never asked (§10).
    expect((await ask(bridge, "Write")).behavior).toBe("allow");
    // …and after the live switch the SAME bridge consults the broker, whose gate denies under `plan`.
    policy.current = "plan";
    expect((await ask(bridge, "Write")).behavior).toBe("deny");
  });

  test("a bare-value policy (no getter) keeps the captured behaviour exactly", async () => {
    const deps = minimalDeps({
      policy: "dont-ask",
      canUseToolDeps: { approvals: new ApprovalBroker(), questions: new QuestionBroker(), gate: new PermissionGate(), policy: "dont-ask", emit: () => {} },
    });
    const result = officialInputFor({ sessionId: "s_1", mode: "code", cwd: "/repo", primary: "/repo", spendEffort: undefined }, deps);
    if (!("input" in result)) throw new Error("officialInputFor unexpectedly refused");
    const bridge = (result.input.options as { canUseTool?: unknown }).canUseTool;
    expect((await ask(bridge, "Write")).behavior).toBe("allow");
  });
});

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
      const input: OfficialSessionInput = { sessionId: "s_1", mode: "code", cwd: "/Users/x/repo", primary: "/Users/x/repo", spendEffort: undefined };
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
    const input: OfficialSessionInput = { sessionId: "s_1", mode: "code", cwd: "/Users/x/repo", primary: "/Users/x/repo", spendEffort: undefined };
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
    const input: OfficialSessionInput = { sessionId: "s_1", mode, cwd: "/Users/x/repo", primary: "/Users/x/repo", spendEffort: undefined };
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

  // USER RULING 2026-09-18: reads are globally allowed on BOTH legs, stated the same way on both.
  // Before this neither leg carried an allow rule — an out-of-cwd read was asked, bridged to
  // `canUseTool`, and allowed by the gate as read-only: correct, but a host round trip per call and
  // pinned by nothing on this leg. The DENY list must survive alongside it, because deny-before-allow
  // is the only reason a bare `Read` allow cannot reach `<home>/run` or `<home>/runtimes`.
  test("settings.permissions.allow is the shared global-read list, and the deny fence rides beside it", () => {
    const home = "/Users/x/.winter-test-home";
    const settings = optionsFor("code", home).settings as { permissions?: { allow?: string[]; deny?: string[] } } | undefined;
    expect(settings?.permissions?.allow).toEqual([...GLOBAL_READ_ALLOW_RULES]);
    expect(settings?.permissions?.allow).toEqual(["Read", "Glob", "Grep"]);
    expect(settings?.permissions?.deny).toEqual(controlPlaneDenyRules(home));
  });

  test("both legs send the IDENTICAL read-allow list — one constant, never two copies (the WEB pair is Winter-only)", () => {
    const home = "/Users/x/.winter-test-home";
    const official = (optionsFor("code", home).settings as { permissions?: { allow?: string[] } } | undefined)?.permissions?.allow;
    const winter = buildWinterOptions({
      mode: "code", policy: "ask", sessionId: "11111111-2222-3333-4444-555555555555", home, cwd: "/repo",
      credentials: { byProvider: {} }, spawn: { pathToClaudeCodeExecutable: "/opt/winter" },
      canUseTool: (async () => ({ behavior: "allow" as const })) as CanUseTool, abort: new AbortController(),
      baseEnv: { PATH: "/usr/bin", HOME: "/Users/x", TMPDIR: "/tmp", LANG: "en_US.UTF-8" },
    }).permissions?.allow;
    // The READ rules are one constant on both legs, as they always were.
    expect(official).toEqual([...GLOBAL_READ_ALLOW_RULES]);
    expect(winter?.slice(0, GLOBAL_READ_ALLOW_RULES.length)).toEqual([...GLOBAL_READ_ALLOW_RULES]);
    // 0.0.17: the Winter leg additionally carries a bare allow for its two web built-ins, and this
    // leg deliberately does NOT — `WEB_BUILTIN_ALLOW_RULES`' own doc has the reason on both sides: the
    // Winter runtime denies an unresolved call under `dontAsk` without ever consulting `canUseTool`,
    // while claude asks per DOMAIN and the 2026-09-18 ruling keeps that behaviour verbatim.
    expect(winter).toEqual([...GLOBAL_READ_ALLOW_RULES, ...WEB_BUILTIN_ALLOW_RULES]);
    expect(official).not.toContain("WebFetch");
    expect(official).not.toContain("WebSearch");
  });

  test("settings.sandbox is EXACTLY childSandboxConfigFor(home, cwd) — sandboxConfigFor's real paths, spelled for the sandbox glob grammar", () => {
    const home = "/Users/x/.winter-test-home";
    const options = optionsFor("code", home);
    const settings = options.settings as { sandbox?: { filesystem?: { denyWrite?: string[] } } } | undefined;
    expect(settings?.sandbox).toEqual(childSandboxConfigFor(home, "/Users/x/repo"));
    // No `[` anywhere in these paths, so the spelling changes nothing: the literal list, entry for entry —
    // plus (R.3 I-4) the five any-depth `.winter/<kind>` globs for the cwd, which only the child's form has.
    const literal = sandboxConfigFor(home, "/Users/x/repo");
    const denyWrite = settings?.sandbox?.filesystem?.denyWrite ?? [];
    expect(denyWrite.filter((e) => !e.includes("**"))).toEqual(literal.filesystem!.denyWrite!);
    expect(denyWrite.filter((e) => e.includes("**"))).toEqual(["skills", "commands", "rules", "output-styles", "agents"].map((k) => `/Users/x/repo/**/.winter/${k}`));
    // Whole-branch review: the trust record and the session's project agent definitions are on it.
    expect(settings?.sandbox?.filesystem?.denyWrite).toContain(`${home}/trust.json`);
    expect(settings?.sandbox?.filesystem?.denyWrite).toContain("/Users/x/repo/.winter/agents");
  });

  // Router 3279a1d: claude reads a sandbox entry holding `[` as a GLOB, so a raw `[`-named home is a
  // character class that fences nothing; it is spelled `[[]`. Agent SDK 5e37898: the Winter runtime reads
  // the same grammar (measured by `sandbox-glob-escape-measure.e2e.test.ts`), so BOTH legs are sent the
  // spelled list; `sandboxConfigFor` stays literal for the consumers that compare real paths.
  test("a `[`-named home: BOTH legs' sandbox spell every `[` as `[[]`; sandboxConfigFor itself stays literal", () => {
    const home = "/Users/x/[wip] homes/.winter";
    const options = optionsFor("code", home);
    const denyWrite = (options.settings as { sandbox?: { filesystem?: { denyWrite?: string[]; denyRead?: string[] } } }).sandbox!.filesystem!.denyWrite!;
    const denyRead = (options.settings as { sandbox?: { filesystem?: { denyWrite?: string[]; denyRead?: string[] } } }).sandbox!.filesystem!.denyRead!;
    expect(denyWrite).toContain("/Users/x/[[]wip] homes/.winter/trust.json");
    expect(denyWrite).toContain("/Users/x/[[]wip] homes/.winter/run");
    expect(denyRead).toContain("/Users/x/[[]wip] homes/.winter/run");
    for (const entry of [...denyWrite, ...denyRead]) expect(entry.replace(/\[\[\]/g, "")).not.toContain("["); // every `[` spelled
    const literal = sandboxConfigFor(home, "/Users/x/repo").filesystem!;
    expect(literal.denyWrite).toContain("/Users/x/[wip] homes/.winter/trust.json"); // the real-path list: literal
    expect(denyWrite.filter((e) => !e.includes("**")).length).toBe(literal.denyWrite!.length); // same fence, entry for entry (+ R.3 I-4's globs)
    // The Winter leg is sent the SAME spelled list.
    const winterSandbox = buildWinterOptions({
      mode: "code", policy: "ask", sessionId: "11111111-2222-3333-4444-555555555555", home, cwd: "/Users/x/repo",
      credentials: { byProvider: {} }, spawn: { pathToClaudeCodeExecutable: "/opt/winter" },
      canUseTool: (async () => ({ behavior: "allow" as const })) as CanUseTool, abort: new AbortController(),
      baseEnv: { PATH: "/usr/bin", HOME: "/Users/x", TMPDIR: "/tmp", LANG: "en_US.UTF-8" },
    }).sandbox;
    expect(winterSandbox).toEqual(childSandboxConfigFor(home, "/Users/x/repo"));
    expect((options.settings as { sandbox?: unknown }).sandbox).toEqual(winterSandbox);
    // …and a `[`-named PROJECT: its `.winter/agents` and protected item fences are spelled too (a lone `]`
    // stays literal) — on the Winter spawn's `Options.sandbox` exactly as on the official flag settings.
    expect(childSandboxConfigFor("/h", "/p/[a]b").filesystem!.denyWrite).toContain("/p/[[]a]b/.winter/agents");
    const winterProject = buildWinterOptions({
      mode: "code", policy: "ask", sessionId: "11111111-2222-3333-4444-555555555555", home: "/h", cwd: "/p/[a]b",
      credentials: { byProvider: {} }, spawn: { pathToClaudeCodeExecutable: "/opt/winter" },
      canUseTool: (async () => ({ behavior: "allow" as const })) as CanUseTool, abort: new AbortController(),
      baseEnv: { PATH: "/usr/bin", HOME: "/Users/x", TMPDIR: "/tmp", LANG: "en_US.UTF-8" },
    }).sandbox!.filesystem!.denyWrite!;
    expect(winterProject).toEqual(expect.arrayContaining(["/p/[[]a]b/.winter/agents", "/p/[[]a]b/.winter/skills", "/p/[[]a]b/.winter/settings.json"]));
    expect(winterProject).not.toContain("/p/[a]b/.winter/skills");
  });

  // R.3 I-4: sandboxed Bash could plant `.winter/<kind>` under a SUBDIRECTORY of the cwd (an assembled path
  // or `git show --output=…` slips the Bash detector), and a later session there loads it. Both runtimes read
  // a glob-shaped deny entry as a regex, so the spelled list carries the any-depth form: five entries per
  // working directory (`<escaped dir>/**/.winter/<kind>`), on both legs; `sandboxConfigFor` stays literal.
  test("R.3 I-4: both legs' sandbox carry `<dir>/**/.winter/<kind>` for the cwd and each extra working directory", () => {
    const kinds = ["skills", "commands", "rules", "output-styles", "agents"];
    const child = childSandboxConfigFor("/h", "/p/[a]b", ["/q/extra"]).filesystem!.denyWrite!;
    for (const k of kinds) {
      expect(child).toContain(`/p/[[]a]b/**/.winter/${k}`);
      expect(child).toContain(`/q/extra/**/.winter/${k}`);
    }
    expect(child.filter((e) => e.includes("**"))).toHaveLength(10);
    expect(sandboxConfigFor("/h", "/p/[a]b").filesystem!.denyWrite!.some((e) => e.includes("**"))).toBe(false);
    // the official leg, from `OfficialSessionInput.extraDirs`
    const input: OfficialSessionInput = { sessionId: "s_1", mode: "code", cwd: "/Users/x/repo", primary: "/Users/x/repo", extraDirs: ["/Users/x/other"], spendEffort: undefined };
    const result = officialInputFor(input, minimalDeps({ home: "/h" }));
    if (!("input" in result)) throw new Error("officialInputFor refused");
    const official = ((result.input.options as unknown as { settings: { sandbox: { filesystem: { denyWrite: string[] } } } }).settings.sandbox);
    for (const k of kinds) {
      expect(official.filesystem.denyWrite).toContain(`/Users/x/repo/**/.winter/${k}`);
      expect(official.filesystem.denyWrite).toContain(`/Users/x/other/**/.winter/${k}`);
    }
    // …and the Winter spawn is sent the SAME list, from `WinterOptionsInput.extraDirs`
    const winter = buildWinterOptions({
      mode: "code", policy: "ask", sessionId: "11111111-2222-3333-4444-555555555555", home: "/h", cwd: "/Users/x/repo", extraDirs: ["/Users/x/other"],
      credentials: { byProvider: {} }, spawn: { pathToClaudeCodeExecutable: "/opt/winter" },
      canUseTool: (async () => ({ behavior: "allow" as const })) as CanUseTool, abort: new AbortController(),
      baseEnv: { PATH: "/usr/bin", HOME: "/Users/x", TMPDIR: "/tmp", LANG: "en_US.UTF-8" },
    } as WinterOptionsInput).sandbox;
    expect(winter).toEqual(official as unknown as typeof winter);
  });

  test("additionalDisallowedTools is EXACTLY disallowedToolsFor(mode, {leg:\"official\"}) — claude's own web pair stays", () => {
    const codeOptions = optionsFor("code");
    const chatOptions = optionsFor("chat");
    expect(codeOptions.additionalDisallowedTools).toEqual(disallowedToolsFor("code", { leg: "official" }));
    expect(chatOptions.additionalDisallowedTools).toEqual(disallowedToolsFor("chat", { leg: "official" }));
    // 0.0.17 / the 2026-09-18 ruling: NEITHER `WebFetch` nor `WebSearch` is withheld on this leg, in
    // any mode — claude's native pair, with claude's own per-domain approval behaviour, is what the
    // user asked to keep. The daemon used to disallow both here in every mode (P8b-33).
    for (const options of [codeOptions, chatOptions]) {
      expect(options.additionalDisallowedTools as string[]).not.toContain("WebFetch");
      expect(options.additionalDisallowedTools as string[]).not.toContain("WebSearch");
    }
    // Chat's list is still a strict superset (chat additionally excludes the SDK's own fs/shell
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

// HIGH (fix wave, pre-merge review, finding 2a): the official leg's own `disableBypassPermissionsMode`
// clamp — `Settings.permissions.disableBypassPermissionsMode` is a `'disable'` LITERAL on this leg
// (`sdk.d.ts`'s `Settings` interface), not a boolean, so it must be OMITTED rather than set `false`
// for the one policy where the daemon's own top-level mode legitimately reaches something other than
// the clamp's target — `bypass`, which `officialPermissionModeFor` already downgrades to
// `acceptEdits` for the SESSION itself, but a subagent DEFINITION's own `permissionMode:
// bypassPermissions` is a separate lever this clamp closes regardless of that downgrade.
describe("officialInputFor — disableBypassPermissionsMode (finding 2a)", () => {
  function settingsPermissionsFor(policy: SessionApprovalPolicy): { deny?: string[]; disableBypassPermissionsMode?: string } | undefined {
    const input: OfficialSessionInput = { sessionId: "s_1", mode: "code", cwd: "/Users/x/repo", primary: "/Users/x/repo", spendEffort: undefined };
    const result = officialInputFor(input, minimalDeps({ home: "/Users/x/.winter-test-home", policy }));
    if (!("input" in result)) throw new Error(`officialInputFor unexpectedly refused: ${String((result as { message?: string }).message)}`);
    const options = result.input.options as unknown as Record<string, unknown>;
    return (options.settings as { permissions?: { deny?: string[]; disableBypassPermissionsMode?: string } } | undefined)?.permissions;
  }

  test("set to the 'disable' literal for every policy except bypass", () => {
    for (const policy of ["plan", "dont-ask", "ask", "accept-edits", "auto", "chat"] as const) {
      expect(settingsPermissionsFor(policy)?.disableBypassPermissionsMode).toBe("disable");
    }
  });

  test("omitted (never 'disable') when the session's own policy is bypass", () => {
    expect(settingsPermissionsFor("bypass")?.disableBypassPermissionsMode).toBeUndefined();
  });
});

// F1 (live gate, 2026-09-24): the session's model rides the FLAG-SETTINGS layer. MEASURED on the real
// 0.3.250 child through a real daemon: the router's official door (0.0.11 and the WS-21 build alike)
// never forwards the query's top-level `Options.model` — the child was spawned with no `--model` and no
// settings `model`, so every official session ran claude's own default (`claude-opus-5`) whatever the
// session asked for. `OptionsTemplatePolicy.settings` is the door the router's own template names and
// measures (`test/official/runtime-options.test.ts`: "a session given `settings: { model: … }` … sent
// that model on its first request"). The value is the tag's BARE modelId, never the provider-qualified tag.
describe("officialInputFor — the session's model rides the flag-settings layer (F1)", () => {
  function settingsModelFor(modelRef: string): unknown {
    const input: OfficialSessionInput = { sessionId: "s_1", mode: "code", cwd: "/Users/x/repo", primary: "/Users/x/repo", spendEffort: undefined };
    const base = minimalDeps();
    const result = officialInputFor(input, minimalDeps({ selection: { ...base.selection, providerId: modelRef.slice(0, modelRef.indexOf("/")), modelRef } }));
    if (!("input" in result)) throw new Error(`officialInputFor unexpectedly refused: ${String((result as { message?: string }).message)}`);
    return ((result.input.options as unknown as Record<string, unknown>).settings as Record<string, unknown> | undefined)?.["model"];
  }

  test("settings.model is the selection tag's bare modelId", () => {
    expect(settingsModelFor("anthropic/claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(settingsModelFor("anthropic/claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001");
    expect(settingsModelFor("console/claude-opus-5")).toBe("claude-opus-5");
  });

  test("officialWireModelFor is the one spelling the settings layer and the init assertion share", () => {
    expect(settingsModelFor("anthropic/claude-haiku-4.5")).toBe(officialWireModelFor({ modelRef: "anthropic/claude-haiku-4.5" }) as string);
  });
});

// F1 follow-on (2026-09-24): the WIRE id for every Claude row the official leg can run. The pinned
// catalog carries 14 DOTTED rows (`anthropic/claude-haiku-4.5`, `…/claude-opus-4.8`, their `console/*`
// twins) whose bare modelId Anthropic's API does not accept. MEASURED by the coordinator against the
// real API with the user's key (read-only `GET /v1/models/<id>`):
//   404: claude-haiku-4.5, claude-sonnet-4.6 ("Did you mean claude-sonnet-4-6?"), claude-3-7-sonnet, claude-3.7-sonnet
//   200: claude-haiku-4-5 (→ claude-haiku-4-5-20251001), claude-opus-4-5 (→ claude-opus-4-5-20251101),
//        claude-opus-4-6/4-7/4-8, claude-sonnet-4-5 (→ claude-sonnet-4-5-20250929), claude-sonnet-4-6,
//        claude-opus-5, claude-sonnet-5, claude-fable-5, claude-fable-5-1, claude-haiku-4-5-20251001
// So a dotted version segment maps to the dashed id; dated and already-dashed ids pass through; an id
// with NO accepted spelling refuses typed before the first turn — never a fallback to another model.
// The table is keyed by the bare modelId and is EXHAUSTIVE over the pinned catalog's anthropic/console
// Claude rows: a new row fails this test until its wire id is measured and added here.
describe("officialWireModelFor — the Claude wire id per catalog row (F1 follow-on)", () => {
  const MEASURED_WIRE_ID: Readonly<Record<string, string>> = {
    "claude-fable-5": "claude-fable-5",
    "claude-fable-5-1": "claude-fable-5-1",
    "claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001",
    "claude-haiku-4.5": "claude-haiku-4-5",
    "claude-opus-4.5": "claude-opus-4-5",
    "claude-opus-4.6": "claude-opus-4-6",
    "claude-opus-4.7": "claude-opus-4-7",
    "claude-opus-4.8": "claude-opus-4-8",
    "claude-opus-5": "claude-opus-5",
    "claude-sonnet-4.5": "claude-sonnet-4-5",
    "claude-sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-5": "claude-sonnet-5",
    // SDK 0.0.23 (2026-09-25): Opus 5.5, already dashed, passes through. The API answered 200 for
    // `claude-opus-5-5` in the 0.0.24 Anthropic-adapter live gate (2026-09-25).
    "claude-opus-5-5": "claude-opus-5-5",
  };
  const ACCEPTED_BY_THE_API = new Set(["claude-opus-5-5", "claude-haiku-4-5", "claude-opus-4-5", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-4-5", "claude-sonnet-4-6", "claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-fable-5-1", "claude-haiku-4-5-20251001"]);
  /** Wire ids taken from Anthropic's own models overview but not yet answered by a live 200 — kept apart so
   *  "measured" keeps meaning measured. Move an id to ACCEPTED_BY_THE_API once a probe answers it. */
  const DOCUMENTED_NOT_MEASURED = new Set<string>();
  const claudeRows = loadCatalog().models.filter((row) => (row.providerId === "anthropic" || row.providerId === "console") && row.modelFamily === "claude");

  test("the pinned catalog's anthropic/console Claude rows are the 26 this table covers", () => {
    expect(claudeRows.map((row) => row.key).sort()).toEqual(
      Object.keys(MEASURED_WIRE_ID).flatMap((id) => [`anthropic/${id}`, `console/${id}`]).sort(),
    );
  });

  test("every row maps to its measured wire id, and every wire id is one the API answered 200 for", () => {
    for (const row of claudeRows) {
      const modelId = row.key.slice(row.key.indexOf("/") + 1);
      const wire: unknown = officialWireModelFor({ modelRef: row.key });
      expect({ row: row.key, wire }).toEqual({ row: row.key, wire: MEASURED_WIRE_ID[modelId] });
      expect(ACCEPTED_BY_THE_API.has(wire as string) || DOCUMENTED_NOT_MEASURED.has(wire as string)).toBe(true);
    }
  });

  test("a dotted id with NO accepted spelling refuses typed — runtime_selection_refused, naming the model", () => {
    for (const modelRef of ["anthropic/claude-3.7-sonnet", "console/claude-3.7-sonnet"]) {
      const wire = officialWireModelFor({ modelRef });
      expect(wire).toBeInstanceOf(OfficialNoWireModel);
      const refusal = wire as OfficialNoWireModel;
      expect(refusal.code).toBe("runtime_selection_refused");
      expect(refusal.reason).toBe("no-wire-model");
      expect(refusal.message).toContain(modelRef);
      expect(refusal.message).toContain("no wire id");
    }
  });

  test("officialInputFor refuses the same row before anything is built", () => {
    const input: OfficialSessionInput = { sessionId: "s_1", mode: "code", cwd: "/Users/x/repo", primary: "/Users/x/repo", spendEffort: undefined };
    const base = minimalDeps();
    const result = officialInputFor(input, minimalDeps({ selection: { ...base.selection, providerId: "anthropic", modelRef: "anthropic/claude-3.7-sonnet" } }));
    expect(result).toBeInstanceOf(OfficialNoWireModel);
  });

  test("officialInputFor reports the mapped id it sent, beside the settings layer that carries it", () => {
    const input: OfficialSessionInput = { sessionId: "s_1", mode: "code", cwd: "/Users/x/repo", primary: "/Users/x/repo", spendEffort: undefined };
    const base = minimalDeps();
    const result = officialInputFor(input, minimalDeps({ selection: { ...base.selection, providerId: "console", modelRef: "console/claude-opus-4.8" } }));
    if (!("input" in result)) throw new Error(`officialInputFor unexpectedly refused: ${String((result as { message?: string }).message)}`);
    expect(result.wireModel).toBe("claude-opus-4-8");
    expect(((result.input.options as unknown as Record<string, unknown>).settings as Record<string, unknown>)["model"]).toBe("claude-opus-4-8");
  });

  test("a provider whose wire is NOT Anthropic's own API keeps its own spelling (the measurement covers anthropic/console only)", () => {
    expect(officialWireModelFor({ modelRef: "someproxy/claude-opus-4.8" })).toBe("claude-opus-4.8");
    expect(officialWireModelFor({ modelRef: "someproxy/anthropic/claude-3.7-sonnet" })).toBe("anthropic/claude-3.7-sonnet");
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
  const input: OfficialSessionInput = { sessionId: "s_1", mode: "code", cwd: "/Users/x/repo", primary: "/Users/x/repo", spendEffort: undefined };
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

  // Pre-release hardening (P9c-1 amendment): the settings flag ALONE can no longer widen this —
  // `OFFICIAL_SUBSCRIPTION_AUTH_APPROVED` (versions.ts) stays `false` until Anthropic approves
  // subscription auth, so `subscriptionAuth: true` with NO override is now the SAME as off.
  test("subscriptionAuth true, with NO approval override -> spool is STILL officialConfigDirFor(home) (the compile-time gate stays closed)", () => {
    const built = build({ settings: settingsWith(true) });
    expect(built.input.spool).toBe(officialConfigDirFor(HOME));
  });

  // The only way to reach the widened behaviour is the injectable test seam — never by editing
  // the real constant.
  test("subscriptionAuth true WITH the approval override -> spool is left undefined (the router's own default applies instead)", () => {
    const built = build({ settings: settingsWith(true), officialSubscriptionAuthApproved: true });
    expect(built.input.spool).toBeUndefined();
  });

  test("the override alone (no flag) changes nothing -> approval without the flag never widens", () => {
    const built = build({ settings: settingsWith(false), officialSubscriptionAuthApproved: true });
    expect(built.input.spool).toBe(officialConfigDirFor(HOME));
  });

  test("flipping the flag between two calls with the SAME deps object otherwise, BOTH under the approval override -> spool changes with no other field touched (hot, no restart)", () => {
    const off = build({ settings: settingsWith(false), officialSubscriptionAuthApproved: true });
    const on = build({ settings: settingsWith(true), officialSubscriptionAuthApproved: true });
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
  const input: OfficialSessionInput = { sessionId: "s_1", mode: "code", cwd: "/Users/x/repo", primary: "/Users/x/repo", spendEffort: undefined };
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

  // Pre-release hardening (P9c-1 amendment): see the api-key family's own matrix above — the
  // settings flag alone no longer widens this; the approval override is required.
  test("subscriptionAuth true, with NO approval override -> spool is STILL officialConfigDirFor(home), same as the api-key family", () => {
    const built = build({ settings: settingsWith(true) });
    expect(built.input.spool).toBe(officialConfigDirFor(HOME));
  });

  test("subscriptionAuth true WITH the approval override -> spool is left undefined, same as the api-key family", () => {
    const built = build({ settings: settingsWith(true), officialSubscriptionAuthApproved: true });
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
  const input: OfficialSessionInput = { sessionId: "s_1", mode: "code", cwd: "/Users/x/repo", primary: "/Users/x/repo", spendEffort: undefined };
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
  const input: OfficialSessionInput = { sessionId: "s_1", mode: "code", cwd: "/Users/x/repo", primary: "/Users/x/repo", spendEffort: undefined };
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
  const input: OfficialSessionInput = { sessionId: "s_1", mode: "code", cwd: "/Users/x/repo", primary: "/Users/x/repo", spendEffort: undefined };
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

// WS-20: the M-C 'anthropic ref must never drift with live settings' fix wave is now
// STRUCTURAL, not a regression this suite needs to reproduce — `providerFor`/`credentialRefFor`
// never consult settings for the arm decision at all (the arm is the tag's own prefix), so
// there is no live-settings drift left to happen. See `officialAuthArmFor`'s own test above.
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

// WS-20: `officialAuthFamilyFor` (settings-driven) is DELETED — the arm is now `officialAuthArmFor`,
// a pure read of the tag's own prefix, no settings, no on-disk probe.
describe("WS-20: the auth arm is the tag's prefix", () => {
  const BASE_SELECTION: RuntimeSelection = {
    runtimeKind: "claude-agent", providerId: "anthropic", modelRef: "anthropic/claude-sonnet-5",
    family: "claude", authFamily: "api-key", sdkVersion: "0.0.4", reason: "test", decidedAt: new Date().toISOString(),
  };

  test("the auth arm is the tag's prefix", () => {
    const consoleSel = { ...BASE_SELECTION, providerId: "console", modelRef: "console/claude-sonnet-5", authFamily: "console-profile" as const };
    const apiSel = { ...BASE_SELECTION, providerId: "anthropic", modelRef: "anthropic/claude-sonnet-5", authFamily: "api-key" as const };
    expect(officialAuthArmFor(consoleSel)).toBe("console");
    expect(officialAuthArmFor(apiSel)).toBe("api-key");
    expect(officialAuthChildEnvFor("console", "/tmp/h")).toMatchObject({ ANTHROPIC_PROFILE: "winter" });
    expect(officialAuthChildEnvFor("api-key", "/tmp/h")).toEqual({});
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

// WS-20: `effectiveOfficialAuthFor` no longer takes an `auth` pin — presence alone, and gains
// "both" for the case neither arm needs to be guessed (a session's own tag decides).
describe("effectiveOfficialAuthFor (O6, provider.status; WS-20: presence alone)", () => {
  test("both present -> \"both\"", () => {
    expect(effectiveOfficialAuthFor(true, true)).toBe("both");
  });
  test("exactly one present -> that one", () => {
    expect(effectiveOfficialAuthFor(true, false)).toBe("api-key");
    expect(effectiveOfficialAuthFor(false, true)).toBe("console");
  });
  test("neither present -> \"none\"", () => {
    expect(effectiveOfficialAuthFor(false, false)).toBe("none");
  });
});

// Daemon settings surface batch 3 (item 2): `settings.permissions.deny` must reach this leg's
// `options.settings.permissions.deny` too — `permissionDenyRulesFor` is the ONE function both
// `buildWinterOptions` (mode-options.ts) and this leg's construction site call, so a divergence here
// would mean the two legs enforce DIFFERENT deny lists for the identical settings.json.
describe("officialInputFor — item 2: the user's deny rules reach this leg too", () => {
  test("a Skill(<name>) deny rule (or any hand-written rule) rides alongside the fixed control-plane fence", () => {
    const home = "/Users/x/.winter-test-home";
    // WS-21: the user tier's deny rules are `sdk/settings.json` `permissions.deny` (`userDeny`); a stale
    // copy on `settings` is never read.
    const settings = Settings.parse({
      schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" },
      permissions: { deny: ["Skill(stale)"] },
    });
    const input: OfficialSessionInput = { sessionId: "s_1", mode: "code", cwd: "/Users/x/repo", primary: "/Users/x/repo", spendEffort: undefined };
    const result = officialInputFor(input, minimalDeps({ home, settings, userDeny: ["Skill(writing-skills)", "Agent(fork)"] }));
    if (!("input" in result)) throw new Error(`officialInputFor unexpectedly refused: ${String((result as { message?: string }).message)}`);
    const deny = (result.input.options as { settings?: { permissions?: { deny?: string[] } } }).settings?.permissions?.deny ?? [];
    expect(deny).toEqual([...controlPlaneDenyRules(home), "Skill(writing-skills)", "Agent(fork)"]);
  });

  test("an absent settings block changes nothing — just the fixed control-plane fence", () => {
    const home = "/Users/x/.winter-test-home";
    const input: OfficialSessionInput = { sessionId: "s_1", mode: "code", cwd: "/Users/x/repo", primary: "/Users/x/repo", spendEffort: undefined };
    const result = officialInputFor(input, minimalDeps({ home, settings: undefined }));
    if (!("input" in result)) throw new Error(`officialInputFor unexpectedly refused: ${String((result as { message?: string }).message)}`);
    const deny = (result.input.options as { settings?: { permissions?: { deny?: string[] } } }).settings?.permissions?.deny ?? [];
    expect(deny).toEqual(controlPlaneDenyRules(home));
  });
});

// Daemon settings surface batch 3 (item 3): closes the pre-existing gap where a
// user/project-configured MCP server reached the Winter leg only (`extraMcpServers`,
// `external-mcp.ts`) — `configuredMcpServers` on `OfficialInputDeps` is threaded onto this leg's own
// `mcpServers`, capability servers LAST so they can never be shadowed (the collision itself is
// refused, typed, by `session-driver.ts`'s `inputDeps()` BEFORE this deps object is ever built).
describe("officialInputFor — item 3: configured MCP servers (HTTP/SSE/stdio) reach this leg too", () => {
  test("an HTTP server and an SSE server configured in settings.mcpServers land in this leg's mcpServers, unchanged", () => {
    // `configuredMcpServers` is handed straight to `officialInputFor` as a pre-built dep here —
    // it deliberately never goes through `Settings.parse`, so the ruling (fix wave item 6, refuses
    // a credential-shaped header at the SETTINGS door) does not apply to this fixture; in
    // production this value is always `configuredMcpServersFor`'s OUTPUT, which can only ever have
    // come from an already-validated `Settings`. This test is about passthrough, not validation.
    const configuredMcpServers = {
      httpOne: { type: "http" as const, url: "https://example.com/mcp", headers: { Authorization: "Bearer t" } },
      sseOne: { type: "sse" as const, url: "https://example.com/sse" },
    };
    const input: OfficialSessionInput = { sessionId: "s_1", mode: "code", cwd: "/Users/x/repo", primary: "/Users/x/repo", spendEffort: undefined };
    // `officialPeer` must be non-undefined for `mcpServers` to be assembled at all (see this
    // function's own `deps.officialPeer === undefined ? {} : …` branch) — an EMPTY `capabilities`
    // record means `officialCapabilityServersFor` never actually touches the peer object, so a bare
    // placeholder is enough here; this test is about the CONFIGURED side, not the capability side.
    const result = officialInputFor(input, minimalDeps({ officialPeer: {} as never, capabilities: {}, configuredMcpServers }));
    if (!("input" in result)) throw new Error(`officialInputFor unexpectedly refused: ${String((result as { message?: string }).message)}`);
    expect(result.input.mcpServers).toEqual(configuredMcpServers);
  });

  test("absent configuredMcpServers is byte-identical to before item 3 (empty mcpServers when there are no capability servers either)", () => {
    const input: OfficialSessionInput = { sessionId: "s_1", mode: "code", cwd: "/Users/x/repo", primary: "/Users/x/repo", spendEffort: undefined };
    const result = officialInputFor(input, minimalDeps({ officialPeer: {} as never, capabilities: {} }));
    if (!("input" in result)) throw new Error(`officialInputFor unexpectedly refused: ${String((result as { message?: string }).message)}`);
    expect(result.input.mcpServers).toEqual({});
  });
});

// Daemon settings surface batch 3 (router 0.0.9): the SDK-surface wall this block used to pin is
// CLOSED — `OptionsTemplatePolicy` gained `agents?: Readonly<Record<string, unknown>>`
// (`dist/official/options-template.d.ts`), and `official-options.ts`'s construction site forwards
// `OfficialInputDeps.agents` onto it verbatim. This replaces the old version-pin tripwire with a
// REAL assertion: the identical merged definition map, fed to BOTH legs' builders
// (`buildWinterOptions` for Winter, `officialInputFor` for official), produces the identical
// `options.agents` value on both — proving one owner/one merge actually reaches both legs, not just
// that the router version moved.
describe("officialInputFor — agents (router 0.0.9) reach both legs identically", () => {
  const AGENTS = {
    "code-reviewer": { description: "Reviews code for bugs", prompt: "You are a careful reviewer." },
    "project-planner": { description: "Plans project work", prompt: "You plan work carefully." },
  };

  function winterOptionsInput(agents?: Record<string, unknown>): WinterOptionsInput {
    return {
      mode: "code",
      policy: "ask",
      sessionId: "11111111-2222-3333-4444-555555555555",
      home: "/tmp/winter-home",
      cwd: "/repo",
      credentials: { byProvider: {} },
      spawn: { pathToClaudeCodeExecutable: "/opt/winter" },
      canUseTool: (async () => ({ behavior: "allow" as const })) as CanUseTool,
      abort: new AbortController(),
      baseEnv: { PATH: "/usr/bin", HOME: "/Users/x", TMPDIR: "/tmp", LANG: "en_US.UTF-8" },
      ...(agents === undefined ? {} : { agents: agents as WinterOptionsInput["agents"] }),
    };
  }

  test("the router version agents support was measured against", () => {
    // AT OR ABOVE, not equal (the pin moved to 0.0.10 for the live permission-mode change): what this
    // block depends on is `OptionsTemplatePolicy.agents`, which landed in 0.0.9 and does not move
    // with every later router release. An equality assertion here would fail every bump for a reason
    // that has nothing to do with agents.
    expect(versionAtLeast(REQUIRED_WINTER_RUNTIME_SDK, "0.0.9")).toBe(true);
  });

  test("a non-empty agents map reaches this leg's options.agents, byte-identical to what the Winter leg's buildWinterOptions carries for the SAME map", () => {
    const winterAgents = buildWinterOptions(winterOptionsInput(AGENTS)).agents;
    expect(winterAgents).toEqual(AGENTS);

    const input: OfficialSessionInput = { sessionId: "s_1", mode: "code", cwd: "/Users/x/repo", primary: "/Users/x/repo", spendEffort: undefined };
    const result = officialInputFor(input, minimalDeps({ officialPeer: {} as never, capabilities: {}, agents: AGENTS }));
    if (!("input" in result)) throw new Error(`officialInputFor unexpectedly refused: ${String((result as { message?: string }).message)}`);
    const officialAgents = (result.input.options as { agents?: Record<string, unknown> }).agents;
    expect(officialAgents).toEqual(AGENTS);
    // Both legs carry the SAME map for the SAME input — the actual "one owner, one merge, both
    // legs" property, not just "each leg independently has SOME agents key".
    expect(officialAgents).toEqual(winterAgents);
  });

  test("an empty/absent agents map omits options.agents entirely on THIS leg too — matching the Winter leg's own 'empty is absent' rule", () => {
    expect(buildWinterOptions(winterOptionsInput({})).agents).toBeUndefined();
    expect(buildWinterOptions(winterOptionsInput()).agents).toBeUndefined();

    const input: OfficialSessionInput = { sessionId: "s_1", mode: "code", cwd: "/Users/x/repo", primary: "/Users/x/repo", spendEffort: undefined };
    const emptyResult = officialInputFor(input, minimalDeps({ officialPeer: {} as never, capabilities: {}, agents: {} }));
    if (!("input" in emptyResult)) throw new Error(`officialInputFor unexpectedly refused`);
    expect((emptyResult.input.options as { agents?: unknown }).agents).toBeUndefined();

    const absentResult = officialInputFor(input, minimalDeps({ officialPeer: {} as never, capabilities: {} }));
    if (!("input" in absentResult)) throw new Error(`officialInputFor unexpectedly refused`);
    expect((absentResult.input.options as { agents?: unknown }).agents).toBeUndefined();
  });
});

// Minor 4 (whole-branch review, adopting m6): placed AFTER every `describe` above — including
// `officialInputFor — official_project_key_too_deep`'s own restoring `afterEach` — per this
// tripwire's own header: it must be the LAST lifecycle hook the file registers so its `afterAll`
// (deferred to a microtask) sees this file's truly final `mock.module` state.
installMockModuleTripwire();
