// Persisted allow rules reach the runtime child on BOTH legs (lane B, 2026-09-22, from lane C's finding).
//
// A card's "Allow … everywhere" / "in this project" writes a rule through `approval.respond`'s
// `PermissionRules.append` — `<home>/settings.json`'s `permissions.allow` (global) or
// `<projectRoot>/.winter/permissions.local.json` (project) — and a TRUSTED project's own
// `.winter/settings.json` `permissions.allow` unions in through `ProjectSettingsResolver`. Nothing read
// any of it on the way to a child: `buildWinterOptions` sent only Winter's fixed read/web allow rules,
// so a saved rule lasted exactly as long as the live bridge that answered the card. claude applies its
// settings files' `permissions.allow` natively; this is the host half of that parity.
//
// Pinned here: the translation from Winter's rule grammar to the runtimes' (`sdkAllowRulesFor`), the
// trust-gated reader (`persistedAllowRulesFor`), and both legs' Options. Deny-before-allow on the real
// binary is `persisted-allow-measure.e2e.test.ts`.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanUseTool } from "@yanlinglabs/winter-agent-sdk";
import type { RuntimeSelection } from "@yanlinglabs/winter-runtime-sdk";
import { ApprovalBroker } from "../../src/agent/approvals";
import { PermissionGate } from "../../src/agent/gate";
import { QuestionBroker } from "../../src/agent/questions";
import { PermissionRules } from "../../src/agent/permission-rules";
import { TrustStore } from "../../src/agent/trust";
import { ProjectSettingsResolver } from "../../src/project-settings";
import { Settings } from "../../src/settings";
import {
  buildWinterOptions, controlPlaneDenyRules, GLOBAL_READ_ALLOW_RULES, persistedAllowRulesFor, sdkAllowRulesFor,
  WEB_BUILTIN_ALLOW_RULES, type WinterOptionsInput,
} from "../../src/runtime-sdk/mode-options";
import { officialInputFor, type OfficialInputDeps, type OfficialSessionInput } from "../../src/runtime-sdk/official-options";

function realDir(prefix: string): string { return realpathSync(mkdtempSync(join(tmpdir(), prefix))); }

function winterInput(over: Partial<WinterOptionsInput> = {}): WinterOptionsInput {
  return {
    mode: "code", policy: "ask", sessionId: "11111111-2222-3333-4444-555555555555", home: "/h", cwd: "/repo",
    credentials: { byProvider: {} }, spawn: { pathToClaudeCodeExecutable: "/opt/winter" },
    canUseTool: (async () => ({ behavior: "allow" as const })) as CanUseTool, abort: new AbortController(), baseEnv: {},
    ...over,
  };
}

describe("sdkAllowRulesFor — Winter's saved-rule grammar, as the runtimes read it", () => {
  test("bash exact/prefix/any keep their meaning; BashUnsandboxed becomes Bash (claude: the flag only removes the sandbox auto-allow)", () => {
    expect(sdkAllowRulesFor(["Bash(git status)", "Bash(gh repo:*)", "Bash", "BashUnsandboxed(curl:*)"]))
      .toEqual(["Bash(git status)", "Bash(gh repo:*)", "Bash", "Bash(curl:*)"]);
  });

  test("Edit, Edit(<abs dir>), Computer, Worktree and WebFetch(domain:) map onto the runtimes' own names", () => {
    // `Edit` covers `Write` too, as it always did in Winter — the SDK matches a bare rule's tool name
    // literally, so both are stated (measured: `persisted-allow-measure.e2e.test.ts`).
    expect(sdkAllowRulesFor(["Edit", "Edit(/Users/x/scratch)", "Computer", "Worktree", "WebFetch(domain:example.com)"])).toEqual([
      "Edit", "Write",
      "Edit(//Users/x/scratch/**)", "Write(//Users/x/scratch/**)",
      "mcp__winter__computer__computer",
      "EnterWorktree", "ExitWorktree",
      "WebFetch(domain:example.com)",
    ]);
  });

  test("a value containing `*` is NOT forwarded: in the runtimes' grammar it is a glob, i.e. a WIDER rule than the one saved", () => {
    expect(sdkAllowRulesFor(["Bash(*)", "Bash(ls *.txt)", "Bash(rm *:*)", "Edit(/tmp/*)"])).toEqual([]);
  });

  test("a Winter-grammar string Winter itself refuses stays refused; a foreign (runtime-grammar) rule is forwarded verbatim", () => {
    // Bare `WebFetch` would silence every fetch card; `Computer(x)`/relative `Edit` never parse.
    expect(sdkAllowRulesFor(["WebFetch", "Computer(x)", "Edit(src/**)", "Bash()"])).toEqual([]);
    expect(sdkAllowRulesFor(["WebSearch", "mcp__github__get_issue", "Write(//Users/x/notes/**)"]))
      .toEqual(["WebSearch", "mcp__github__get_issue", "Write(//Users/x/notes/**)"]);
  });

  test("duplicates collapse", () => {
    expect(sdkAllowRulesFor(["Bash(a)", "Bash(a)", "BashUnsandboxed(a)"])).toEqual(["Bash(a)"]);
  });
});

describe("persistedAllowRulesFor — global always, the project halves only when the project is TRUSTED", () => {
  function world() {
    const home = realDir("winter-allow-home-");
    const repo = realDir("winter-allow-repo-");
    writeFileSync(join(home, "settings.json"), JSON.stringify({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" }, permissions: { allow: ["Bash(gh repo:*)"] } }));
    mkdirSync(join(repo, ".winter"), { recursive: true });
    writeFileSync(join(repo, ".winter", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(make test)"] } }));
    writeFileSync(join(repo, ".winter", "permissions.local.json"), JSON.stringify({ allow: ["Bash(npm run lint:*)"] }));
    const trust = new TrustStore(join(home, "trust.json"));
    const base = Settings.parse(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")));
    const resolver = new ProjectSettingsResolver({ base: () => base, trust });
    const rules = new PermissionRules({ globalAllow: (root) => resolver.effective(root)?.permissions?.allow ?? ["Computer"], winterHome: home });
    const read = (cwd: string) => persistedAllowRulesFor(cwd, {
      projectRootOf: () => repo,
      effectiveSettings: (root) => resolver.effective(root),
      projectRules: (root) => rules.rulesFor(root).project,
      isTrusted: (dir) => trust.isTrusted(dir),
    });
    return { home, repo, trust, read };
  }

  test("an UNTRUSTED project contributes nothing — neither its settings overlay nor its permissions.local.json", () => {
    const w = world();
    expect(w.read(join(w.repo, "sub"))).toEqual(["Bash(gh repo:*)"]);
  });

  test("a TRUSTED project's overlay and its saved project rules join the global ones", () => {
    const w = world();
    w.trust.trust(w.repo);
    expect(w.read(w.repo)).toEqual(["Bash(gh repo:*)", "Bash(make test)", "Bash(npm run lint:*)"]);
  });

  test("nothing configured anywhere → nothing (the engine-era `[\"Computer\"]` getter default is NOT a saved rule)", () => {
    const home = realDir("winter-allow-empty-");
    expect(persistedAllowRulesFor("/nowhere", {
      projectRootOf: () => null, effectiveSettings: () => null, isTrusted: () => false,
    })).toEqual([]);
    expect(home.length).toBeGreaterThan(0);
  });
});

describe("both legs' Options carry the saved rules — after Winter's fixed ones, with the deny fence intact", () => {
  test("Winter leg, code: fixed allow + translated saved rules; the control-plane deny list is unchanged", () => {
    const o = buildWinterOptions(winterInput({ persistedAllow: ["Bash(gh repo:*)", "Edit"] }));
    expect(o.permissions?.allow).toEqual([...GLOBAL_READ_ALLOW_RULES, ...WEB_BUILTIN_ALLOW_RULES, "Bash(gh repo:*)", "Edit", "Write"]);
    // Deny-before-allow is the runtimes' own evaluation order; the fence a saved `Edit` must not beat
    // is still stated in full (the binary proof is the e2e sibling).
    expect(o.permissions?.deny).toEqual(controlPlaneDenyRules("/h"));
    expect(o.permissions?.deny).toContain("Write(//h/settings.json)");
  });

  test("Winter leg: chat and dispatch get no saved rules (chat's policy is fixed; dispatch never cards)", () => {
    for (const mode of ["chat", "dispatch"] as const) {
      const o = buildWinterOptions(winterInput({ mode, policy: mode === "chat" ? "chat" : "auto", persistedAllow: ["Bash(gh repo:*)"] }));
      expect(o.permissions?.allow).toBeUndefined();
    }
  });

  test("official leg: the same translated rules ride the flag-settings `permissions.allow`", () => {
    const deps = minimalOfficialDeps({ persistedAllow: ["Bash(gh repo:*)", "Worktree"] });
    const input: OfficialSessionInput = { sessionId: "s_1", mode: "code", cwd: "/Users/x/repo", primary: "/Users/x/repo", spendEffort: undefined };
    const result = officialInputFor(input, deps);
    if (!("input" in result)) throw new Error(`officialInputFor unexpectedly refused: ${String((result as { message?: string }).message)}`);
    const perms = (result.input.options as { settings?: { permissions?: { allow?: string[]; deny?: string[] } } }).settings?.permissions;
    expect(perms?.allow).toEqual([...GLOBAL_READ_ALLOW_RULES, "Bash(gh repo:*)", "EnterWorktree", "ExitWorktree"]);
    expect(perms?.deny).toEqual(controlPlaneDenyRules(deps.home));
  });
});

// The same shape official-options.test.ts's own `minimalDeps` builds.
function minimalOfficialDeps(over: Partial<OfficialInputDeps>): OfficialInputDeps {
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
    assembler: { assemble: () => "", memoryDirFor: () => undefined },
    capabilities: {},
    canUseToolDeps: { approvals: new ApprovalBroker(), questions: new QuestionBroker(), gate: new PermissionGate(), policy: "auto", emit: () => {} },
    policy: "auto",
    consoleProfileExists: () => true,
    ...over,
  };
}
