// WS-21 L3.6 (spec §7.1 "hook" column, §7.2): the path fence as a PreToolUse hook on both legs, and the
// bridge's third layer — a protected write is never auto-allowed, under any policy.
import { describe, expect, test } from "bun:test";
import { realpathSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanUseTool, HookCallback, HookCallbackMatcher } from "@yanlinglabs/winter-agent-sdk";
import { ApprovalBroker } from "../../src/agent/approvals";
import { QuestionBroker } from "../../src/agent/questions";
import { PermissionGate, type SessionApprovalPolicy } from "../../src/agent/gate";
import { canUseToolFor, type BridgeLogger } from "../../src/runtime-sdk/approval-bridge";
import { bashProtectedWriteHit, sessionHooksFor, type SessionHooksDeps } from "../../src/runtime-sdk/hooks";

const real = (p: string): string => realpathSync(mkdtempSync(join(tmpdir(), p)));
const silent: BridgeLogger = { info: () => {}, error: () => {} };

/** The path fence: the unmatched PreToolUse group registered after the plugin group. */
function fenceOf(deps: Partial<SessionHooksDeps> & { home: string }): HookCallback {
  const built = sessionHooksFor({ sessionId: "s_1", roots: [deps.cwd ?? "/tmp"], ...deps });
  const unmatched = (built.winter?.PreToolUse ?? []).filter((g: HookCallbackMatcher) => g.matcher === undefined);
  expect(unmatched).toHaveLength(2); // the plugin group, then the fence
  expect(built.official).toBe(built.winter); // one builder, both legs
  return unmatched[1]!.hooks[0]!;
}
const call = async (hook: HookCallback, tool_name: string, tool_input: Record<string, unknown>) =>
  (await hook({ hook_event_name: "PreToolUse", tool_name, tool_input, session_id: "b", transcript_path: "", cwd: "/" } as never, "tu1", { signal: new AbortController().signal })) as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  };
const decisionOf = (r: Awaited<ReturnType<typeof call>>) => r.hookSpecificOutput?.permissionDecision ?? "none";

describe("the path fence hook", () => {
  const home = "/Users/x/.winter";
  const root = "/Users/x/code/app";

  test("a protected write: ask in code, deny in dispatch and chat", async () => {
    const input = { file_path: `${root}/.winter/skills/deploy/SKILL.md`, content: "x" };
    expect(decisionOf(await call(fenceOf({ home, cwd: root, mode: "code", trustedProjectRoot: () => root }), "Write", input))).toBe("ask");
    for (const mode of ["dispatch", "chat"] as const) {
      expect(decisionOf(await call(fenceOf({ home, cwd: root, mode, trustedProjectRoot: () => root }), "Write", input))).toBe("deny");
    }
    // the sdk tier needs no trusted project
    expect(decisionOf(await call(fenceOf({ home, cwd: root, mode: "code" }), "Edit", { file_path: `${home}/sdk/WINTER.md` }))).toBe("ask");
  });

  test("review C1: the project tier is protected whatever the trust, at any depth (it loads once trusted)", async () => {
    const hook = fenceOf({ home, cwd: root, mode: "code", trustedProjectRoot: () => null });
    expect(decisionOf(await call(hook, "Write", { file_path: `${root}/.winter/rules/a.md` }))).toBe("ask");
    expect(decisionOf(await call(hook, "Write", { file_path: `${root}/packages/app/.winter/skills/x/SKILL.md` }))).toBe("ask");
  });

  test("sdk/projects is denied outside memory/; the memory directory is free", async () => {
    const hook = fenceOf({ home, cwd: root, mode: "code" });
    expect(decisionOf(await call(hook, "Write", { file_path: `${home}/sdk/projects/-Users-x-code-app/abc.jsonl` }))).toBe("deny");
    expect(decisionOf(await call(hook, "Write", { file_path: `${home}/sdk/projects/-Users-x-code-app/memory/MEMORY.md` }))).toBe("none");
  });

  test("a project's .winter/mcp.json and any .winter/settings*.json are denied on every policy", async () => {
    const hook = fenceOf({ home, cwd: root, mode: "code" });
    for (const f of ["mcp.json", "settings.json", "settings.local.json", "settings.team.json"]) {
      const r = await call(hook, "Write", { file_path: `${root}/.winter/${f}` });
      expect(decisionOf(r)).toBe("deny");
    }
    expect((await call(hook, "Write", { file_path: `${root}/.winter/mcp.json` })).hookSpecificOutput?.permissionDecisionReason).toContain("winter mcp add --scope project");
  });

  test("the home fence binds as a hook too: sdk/settings.json, sdk/.winter.json, sdk/plugins, sdk/agents, the cache", async () => {
    const hook = fenceOf({ home, cwd: root, mode: "code" });
    for (const p of [`${home}/sdk/settings.json`, `${home}/sdk/.winter.json`, `${home}/sdk/plugins/x/plugin.json`, `${home}/sdk/agents/a.md`, `${home}/cache/runs/r/settings.json`]) {
      expect(decisionOf(await call(hook, "Write", { file_path: p }))).toBe("deny");
    }
  });

  test("reads: sdk/.winter.json and a run folder's generated config are denied; everything else is free", async () => {
    const hook = fenceOf({ home, cwd: root, mode: "code" });
    expect(decisionOf(await call(hook, "Read", { file_path: `${home}/sdk/.winter.json` }))).toBe("deny");
    expect(decisionOf(await call(hook, "Read", { file_path: `${home}/cache/runs/r1/.claude.json` }))).toBe("deny");
    expect(decisionOf(await call(hook, "Read", { file_path: `${home}/sdk/settings.json` }))).toBe("none");
    expect(decisionOf(await call(hook, "Read", { file_path: `${root}/src/index.ts` }))).toBe("none");
    expect(decisionOf(await call(hook, "Bash", { command: "ls" }))).toBe("none");
  });

  test("no home: no fence group at all (the diff producer's own convention)", () => {
    const built = sessionHooksFor({ sessionId: "s_1", roots: ["/tmp"] });
    expect((built.winter?.PreToolUse ?? []).filter((g: HookCallbackMatcher) => g.matcher === undefined)).toHaveLength(1);
  });
});

describe("the bridge never auto-allows a protected write (spec §7.2, layer 3)", () => {
  const home = real("winter-fence-home-");
  const root = real("winter-fence-root-");
  const ctx = (): Parameters<CanUseTool>[2] => ({ signal: new AbortController().signal, toolUseID: `tu-${Math.random()}`, requestId: "r" } as Parameters<CanUseTool>[2]);
  function bridge(policy: SessionApprovalPolicy, over: { mode?: "code" | "dispatch"; origin?: string; trusted?: boolean } = {}) {
    const approvals = new ApprovalBroker();
    const canUse = canUseToolFor({
      sessionId: "s_1", mode: over.mode ?? "code", ...(over.origin ? { origin: over.origin } : {}), policy,
      approvals, questions: new QuestionBroker(), gate: new PermissionGate(), emit: () => {}, log: silent,
      home, cwd: root, projectTrusted: () => over.trusted ?? true,
    });
    return { canUse, approvals };
  }
  const protectedInput = { file_path: join(root, ".winter", "skills", "a", "SKILL.md"), content: "x" };

  for (const policy of ["bypass", "accept-edits", "auto"] as const) {
    test(`${policy}: a protected write raises a card instead of running`, async () => {
      const { canUse, approvals } = bridge(policy);
      const pending = canUse("Write", protectedInput, ctx());
      await new Promise((r) => setTimeout(r, 10));
      const listed = approvals.list("s_1");
      expect(listed).toHaveLength(1);
      approvals.resolve("s_1", listed[0]!.callId, false, "test");
      expect((await pending)?.behavior).toBe("deny");
      // …while an ordinary write under the same policy still runs without one
      expect((await canUse("Write", { file_path: join(root, "src", "a.ts"), content: "x" }, ctx()))?.behavior).toBe("allow");
    });
  }

  test("dont-ask declines it; a dispatch child gets the never-prompt deny", async () => {
    expect((await bridge("dont-ask").canUse("Write", protectedInput, ctx()))?.behavior).toBe("deny");
    const child = bridge("bypass", { origin: "dispatch-child" });
    expect((await child.canUse("Write", protectedInput, ctx()))?.behavior).toBe("deny");
    expect(child.approvals.list("s_1")).toHaveLength(0);
  });

  test("review C1: at the repo root under bypass, a nested project dir's skill is a card, trusted or not", async () => {
    for (const trusted of [true, false]) {
      const { canUse, approvals } = bridge("bypass", { trusted });
      const pending = canUse("Write", { file_path: join(root, "packages", "app", ".winter", "skills", "x", "SKILL.md"), content: "x" }, ctx());
      await new Promise((r) => setTimeout(r, 10));
      const listed = approvals.list("s_1");
      expect(listed).toHaveLength(1);
      approvals.resolve("s_1", listed[0]!.callId, false, "test");
      expect((await pending)?.behavior).toBe("deny");
    }
  });

  test("the sdk tier is protected whatever the project's trust", async () => {
    const { canUse, approvals } = bridge("bypass", { trusted: false });
    const pending = canUse("Edit", { file_path: join(home, "sdk", "rules", "a.md"), old_string: "a", new_string: "b" }, ctx());
    await new Promise((r) => setTimeout(r, 10));
    const listed = approvals.list("s_1");
    expect(listed).toHaveLength(1);
    approvals.resolve("s_1", listed[0]!.callId, true, "test");
    expect((await pending)?.behavior).toBe("allow");
  });
});

// Fix round 2 (controller ruling on SPEC CONCERN D): the sandbox cannot fence `.winter/<kind>` off the
// walk (real subpaths only), so ANY Bash command — sandboxed or not — that WRITES under a
// `.winter/{skills,commands,rules,output-styles,agents}` segment, at any depth and whatever the trust, is
// asked about: a card in code, a typed deny where nobody can answer. Read-only mentions pass.
describe("fix round 2: Bash writes under .winter/<kind>", () => {
  const writes = [
    "mkdir -p pkg/a/.winter/skills/x",
    "echo evil > pkg/.winter/rules/r.md",
    "cp evil.md sub/.winter/commands/",
    "cd sub/.winter/agents && tee x.md < /dev/null",
    "sed -i 's/a/b/' .winter/output-styles/terse.md",
    "echo x | tee /elsewhere/proj/.WINTER/Skills/a/SKILL.md",
  ];
  const reads = [
    "cat .winter/skills/x/SKILL.md",
    "ls pkg/.winter/rules",
    "grep -r foo .winter/commands",
    "cat .winter/agents/a.md > /tmp/copy.md",
    "sed 's/a/b/' .winter/rules/r.md",
  ];
  const outside = ["mkdir -p pkg/winter/skills/x", "echo x > notes/.winter-skills.md", "cp a.md .winter/other/b.md"];

  test("the detector: writes hit, reads and paths outside the protected kinds do not", () => {
    for (const cmd of writes) expect({ cmd, hit: bashProtectedWriteHit(cmd) !== undefined }).toEqual({ cmd, hit: true });
    for (const cmd of [...reads, ...outside]) expect({ cmd, hit: bashProtectedWriteHit(cmd) }).toEqual({ cmd, hit: undefined });
  });

  // Round 3, minor 10: reads that wrongly got a card. Each shell segment (split on `;`, `&&`, `||`, `|`,
  // newlines — never inside quotes) is judged on its own, a `cd` carried across them; git's read
  // subcommands are no write; for cp/mv/ln/install/rsync only the destination (the last operand, or `-t`)
  // is the write target. Every write case above still gets its card.
  test("round 3, minor 10: each segment judged alone; git reads and a copy's source get no card", () => {
    const noCard = [
      "git status && ls .winter/rules",
      "cat a 2>/dev/null; cat .winter/commands/x.md",
      "mkdir -p build && grep -r foo .winter/rules",
      "git log -- .winter/skills",
      "cp .winter/skills/a/ref.md /tmp/",
      "cd .winter/skills && git status",
      "git diff HEAD~1 -- .winter/rules/r.md | cat",
      "echo 'a; b > .winter/rules/x' && ls",          // a separator and a redirect INSIDE quotes are text
      "cat .winter/agents/a.md 2>&1 | grep name",
    ];
    for (const cmd of noCard) expect({ cmd, hit: bashProtectedWriteHit(cmd) }).toEqual({ cmd, hit: undefined });
    const stillWrites = [
      ...writes,
      "cp -t .winter/rules a.md b.md",
      "cp --target-directory=.winter/commands a.md",
      "git status; echo x > .winter/rules/r.md",
      "ls\ntouch .winter/rules/r.md",
      "cd .winter/skills && touch new/SKILL.md",
      "cd pkg && cd .winter && mkdir commands",
      "rsync -a src/ .winter/agents/",
      "ln -s /tmp/x .winter/commands/x.md",
      "git checkout -- .winter/rules",
      "cat a >> .winter/rules/r.md",
      "echo x >.winter/rules/r.md",
      "true && (cd pkg/.winter/skills && touch x)",
    ];
    for (const cmd of stillWrites) expect({ cmd, hit: bashProtectedWriteHit(cmd) !== undefined }).toEqual({ cmd, hit: true });
  });

  // Round 3, minor 9: write shapes the check missed — an interpreter one-liner (`python`/`python3`/`node`/
  // `bun`/`ruby`/`perl`/`deno` with `-c`, `-e` or `--eval`) that names a protected segment anywhere in its
  // code, and gawk's `-i inplace`. (A path built from variables, `git apply` and `patch <` stay beyond a
  // static check — the code comment says so.)
  test("round 3, minor 9: interpreter one-liners and awk -i inplace naming a protected segment are writes", () => {
    const writes9 = [
      `python3 -c "import os; open('.winter/rules/x.md','w').write('y')"`,
      `python -c "import os; os.makedirs('pkg/.winter/skills', exist_ok=True)"`,
      `python3.12 -c "open('.winter/agents/a.md','w')"`,
      `node -e "require('fs').writeFileSync('.winter/commands/c.md','x')"`,
      `node --eval "require('fs').mkdirSync('.winter/output-styles')"`,
      `bun -e "await Bun.write('.winter/rules/r.md', 'x')"`,
      `ruby -e "File.write('.winter/rules/r.md', 'x')"`,
      `perl -e 'open(my $f, ">", ".winter/rules/r.md")'`,
      `deno eval "Deno.writeTextFileSync('.winter/skills/s/SKILL.md', 'x')"`,
      `cd pkg && python3 -c "open('.winter/rules/r.md','w')"`,
      "awk -i inplace '{print}' .winter/rules/r.md",
    ];
    for (const cmd of writes9) expect({ cmd, hit: bashProtectedWriteHit(cmd) !== undefined }).toEqual({ cmd, hit: true });
    for (const cmd of [
      `python3 -c "print(1)" && cat .winter/rules/r.md`,
      "awk '{print}' .winter/rules/r.md",
      `node -e "console.log(1)"`,
      `python3 -c "open('.winter/rulesets.md','w')"`,
    ]) expect({ cmd, hit: bashProtectedWriteHit(cmd) }).toEqual({ cmd, hit: undefined });
  });

  // Round 4, minor 2: write shapes round 3's per-segment rules had stopped asking about — a short-flag cluster
  // holding `t` and the space-separated `--target-directory`, an option after the destination, `find -exec`
  // (both terminators), and a `cd` inside a command substitution (both spellings).
  test("round 4, minor 2: -t clusters, --target-directory <dir>, trailing options, find -exec and substitutions ask", () => {
    const writes4 = [
      "cp -rt .winter/skills/x src/",
      "cp --target-directory .winter/skills/x a.md",
      "rsync -a src/ .winter/skills/x/ --exclude tmp",
      "find . -name '*.md' -exec cp {} .winter/skills/ +",
      "find . -name '*.md' -exec cp {} .winter/skills/ \;",
      "find src -execdir mv {} ../.winter/rules/ \;",
      "echo $(cd .winter/skills; touch x)",
      "echo `cd .winter/skills; touch x`",
      'echo "$(touch .winter/rules/r.md)"',
    ];
    for (const cmd of writes4) expect({ cmd, hit: bashProtectedWriteHit(cmd) !== undefined }).toEqual({ cmd, hit: true });
    const stillNoCard = [
      "git status && ls .winter/rules",
      "cat a 2>/dev/null; cat .winter/commands/x.md",
      "mkdir -p build && grep -r foo .winter/rules",
      "git log -- .winter/skills",
      "cp .winter/skills/a/ref.md /tmp/",
      "cd .winter/skills && git status",
      "find .winter/skills -name '*.md' -exec cat {} +",
      "echo $(cat .winter/rules/r.md)",
      "rsync -a .winter/skills/ /tmp/backup/ --exclude tmp",
    ];
    for (const cmd of stillNoCard) expect({ cmd, hit: bashProtectedWriteHit(cmd) }).toEqual({ cmd, hit: undefined });
  });

  // Round 5 (regression since round 3): a shell's `-c` string and `eval`'s argument are COMMANDS, not text —
  // `quotedOperatorsAsText` blanked the redirect inside their quotes, so none of these asked. The string is
  // judged as a command of its own, like an interpreter one-liner.
  test("round 5: a shell -c string and eval's argument are judged as commands", () => {
    const writes5 = [
      `bash -c "echo x > .winter/rules/a"`,
      `sh -c 'cat > .winter/skills/x/SKILL.md'`,
      `zsh -c "printf x >> .winter/commands/c.md"`,
      `eval "echo x > .winter/rules/a"`,
      `find . -exec sh -c 'cp "$0" .winter/skills/' {} \;`,
      `bash -lc 'mkdir -p .winter/agents'`,
      `cd pkg && dash -c "touch .winter/output-styles/o.md"`,
      `sudo ksh -c "tee .winter/rules/r.md < x"`,
    ];
    for (const cmd of writes5) expect({ cmd, hit: bashProtectedWriteHit(cmd) !== undefined }).toEqual({ cmd, hit: true });
    for (const cmd of [
      `bash -c "cat .winter/rules/a"`,
      `sh -c 'ls .winter/skills && git status'`,
      `eval "cat .winter/rules/a"`,
      `find . -exec sh -c 'cat "$0"' {} \;`,
      `bash script.sh .winter/rules`,
      `echo 'a; b > .winter/rules/x' && ls`,
    ]) expect({ cmd, hit: bashProtectedWriteHit(cmd) }).toEqual({ cmd, hit: undefined });
  });

  test("the hook asks (both legs, sandboxed or not); a read gets no answer from it", async () => {
    const built = sessionHooksFor({ sessionId: "s_1", roots: ["/r"], home: "/Users/x/.winter", mode: "code" });
    const groups = (built.winter?.PreToolUse ?? []).filter((g: HookCallbackMatcher) => g.matcher === "Bash");
    const run = async (command: string, escape = false) => {
      const answers: string[] = [];
      for (const g of groups) for (const h of g.hooks) {
        const r = await call(h, "Bash", { command, ...(escape ? { dangerouslyDisableSandbox: true } : {}) });
        answers.push(decisionOf(r));
      }
      return answers;
    };
    for (const cmd of writes) expect(await run(cmd)).toContain("ask");
    for (const cmd of [...reads, ...outside]) expect(await run(cmd)).not.toContain("ask");
    expect(built.official).toBe(built.winter);
  });

  test("the bridge never auto-allows one: bypass → card, dont-ask/dispatch → deny; a read runs", async () => {
    const home = real("winter-fr2-home-");
    const root = real("winter-fr2-root-");
    const ctx = (): Parameters<CanUseTool>[2] => ({ signal: new AbortController().signal, toolUseID: `tu-${Math.random()}`, requestId: "r" } as Parameters<CanUseTool>[2]);
    const mk = (policy: SessionApprovalPolicy, mode: "code" | "dispatch" = "code") => {
      const approvals = new ApprovalBroker();
      return { approvals, canUse: canUseToolFor({ sessionId: "s_1", mode, policy, approvals, questions: new QuestionBroker(), gate: new PermissionGate(), emit: () => {}, log: silent, home, cwd: root }) };
    };
    const b = mk("bypass");
    const pending = b.canUse("Bash", { command: "mkdir -p pkg/a/.winter/skills/x" }, ctx());
    await new Promise((r) => setTimeout(r, 10));
    expect(b.approvals.list("s_1")).toHaveLength(1);
    b.approvals.resolve("s_1", b.approvals.list("s_1")[0]!.callId, false, "test");
    expect((await pending)?.behavior).toBe("deny");
    expect((await mk("dont-ask").canUse("Bash", { command: "cp a.md sub/.winter/commands/" }, ctx()))?.behavior).toBe("deny");
    expect((await mk("auto", "dispatch").canUse("Bash", { command: "echo x > .winter/rules/r.md" }, ctx()))?.behavior).toBe("deny");
    expect((await mk("bypass").canUse("Bash", { command: "cat .winter/skills/x/SKILL.md" }, ctx()))?.behavior).toBe("allow");
  });
});

// R.3 C-1: the escape floor (the LAST Bash PreToolUse group, every policy, bypass included, both legs) knows
// the variables WS-21 exports into every child — `$WINTER_STORE_HOME`, both plugin-cache variables,
// `$CLAUDE_CONFIG_DIR` and the Winter child's own `$WINTER_HOME` (its run folder).
describe("R.3 C-1: the escape floor under bypass — the child's own variables", () => {
  const floor = () => {
    const built = sessionHooksFor({ sessionId: "s_1", roots: ["/r"], home: "/Users/x/.winter", mode: "code", policy: () => "bypass" });
    expect(built.official).toBe(built.winter);
    const groups = (built.winter?.PreToolUse ?? []).filter((g: HookCallbackMatcher) => g.matcher === "Bash");
    return groups[groups.length - 1]!.hooks[0]!;
  };
  const escape = async (command: string) => decisionOf(await call(floor(), "Bash", { command, dangerouslyDisableSandbox: true }));

  test("a write-shaped escape through each variable is denied", async () => {
    for (const cmd of [
      "echo x > $WINTER_STORE_HOME/agents/evil.md",
      "echo x > ${WINTER_STORE_HOME}/skills/x/SKILL.md",
      "echo x >> $WINTER_STORE_HOME/projects/k/id.jsonl",
      "echo '{}' > $WINTER_PLUGIN_CACHE_DIR/p/hooks/hooks.json",
      "echo '{}' > ${CLAUDE_CODE_PLUGIN_CACHE_DIR}/p/hooks/hooks.json",
      "echo x > $CLAUDE_CONFIG_DIR/skills/foo/SKILL.md",
      "echo x > $WINTER_HOME/anything",
    ]) expect({ cmd, decision: await escape(cmd) }).toEqual({ cmd, decision: "deny" });
  });
  test("a read-shaped mention passes the floor", async () => {
    for (const cmd of ["cat $WINTER_STORE_HOME/projects/k/x.jsonl", "cat $WINTER_PLUGIN_CACHE_DIR/p/skills/x/SKILL.md", "cat $CLAUDE_CONFIG_DIR/skills/foo/SKILL.md"]) {
      expect({ cmd, decision: await escape(cmd) }).toEqual({ cmd, decision: "none" });
    }
  });
});
