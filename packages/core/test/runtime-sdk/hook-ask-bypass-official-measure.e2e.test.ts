// WS-21 R.2 carry (L3 fix round 2) — the OFFICIAL-leg half of `hook-ask-bypass-measure.e2e.test.ts`.
//
// Under `bypassPermissions`, does a `PreToolUse` hook answering `ask` on a SANDBOXED Bash call still
// reach `canUseTool` on the real, pinned `claude` binary? The daemon's protected-path Bash check
// (`hooks.ts`'s `bashProtectedWriteHook`) answers `ask` on both legs and relies on the approval bridge
// turning it into a card (code) or a typed deny (dispatch/chat) — which only works if the binary asks
// the host at all. L3 measured the Winter leg; the official leg rested on the pinned fact ("claude's
// evaluator checks a hook's ask before its bypass step"). This measures it, with the sandbox ON and
// `autoAllowBashIfSandboxed` at its default (true) — the combination most likely to skip the host.
//
// Same hermetic bed as the sibling official measurements: the vendor's own `query()`, `env` replacing
// the child's whole environment, fresh `HOME`/`CLAUDE_CONFIG_DIR`, a fake key and a loopback base URL.
// GATED by `describeWithClaudeRuntime` (skips without the pinned platform package).
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type HookCallback, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { anthropicFake, startFake } from "@yanlinglabs/winter-provider-conformance";
import { claudeRuntimeForTests, describeWithClaudeRuntime, LOOPBACK_MODEL_ID } from "../helpers/claude-runtime";

function countToolResults(raw: string): number {
  try {
    const body = JSON.parse(raw) as { messages?: Array<{ content?: unknown }> };
    let n = 0;
    for (const message of body.messages ?? []) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content as Array<Record<string, unknown>>) if (block["type"] === "tool_result") n += 1;
    }
    return n;
  } catch {
    return 0;
  }
}

describeWithClaudeRuntime("R.2 carry — a hook `ask` on a sandboxed Bash call under bypassPermissions, official leg", () => {
  test("the ask reaches canUseTool (and its deny is honoured): the command never runs", async () => {
    const bed = claudeRuntimeForTests();
    if (bed === undefined) throw new Error("unreachable: the suite is skipped without a bed");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "winter-ask-bypass-official-")));
    const home = join(root, "home");
    const cfg = join(root, "cfg");
    const cwd = join(root, "cwd");
    for (const dir of [home, cfg, cwd, join(home, "tmp")]) mkdirSync(dir, { recursive: true });
    const marker = join(cwd, "marker.txt");

    const fake = await startFake({
      routes: [
        {
          path: "*",
          handler: async (_req, recorded) => {
            if (!(recorded.path === "/v1/messages" && recorded.method === "POST")) return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
            if (countToolResults(recorded.body) === 0) {
              return anthropicFake.anthropicTurnResponse({
                blocks: [{ type: "tool_use", id: "call_bash_1", name: "Bash", jsonChunks: [JSON.stringify({ command: `echo measured > ${marker}`, description: "write the marker" })] }],
                stopReason: "tool_use",
              });
            }
            return anthropicFake.anthropicTurnResponse({ blocks: [{ type: "text", chunks: ["done"] }], stopReason: "end_turn" });
          },
        },
      ],
    });

    const hookCalls: string[] = [];
    const canUseCalls: string[] = [];
    const askHook: HookCallback = async (input) => {
      hookCalls.push(String((input as { tool_name?: unknown }).tool_name));
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "R.2 measurement: ask" } };
    };
    const messages: string[] = [];
    try {
      const q = query({
        prompt: "write the marker you were scripted to write",
        options: {
          pathToClaudeCodeExecutable: bed.executable,
          model: LOOPBACK_MODEL_ID,
          cwd,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          settingSources: [],
          sandbox: { enabled: true },
          maxTurns: 4,
          hooks: { PreToolUse: [{ matcher: "Bash", hooks: [askHook] }] },
          canUseTool: async (toolName) => {
            canUseCalls.push(toolName);
            return { behavior: "deny", message: "R.2 measurement: the bridge said no" };
          },
          env: {
            HOME: home,
            USER: "winter-measure",
            LOGNAME: "winter-measure",
            SHELL: "/bin/zsh",
            LANG: "en_US.UTF-8",
            TMPDIR: `${join(home, "tmp")}/`,
            PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
            CLAUDE_CONFIG_DIR: cfg,
            ANTHROPIC_BASE_URL: fake.url,
            ANTHROPIC_API_KEY: "sk-ant-fake-ask-bypass-measurement-0000",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            DISABLE_AUTOUPDATER: "1",
            CLAUDE_CODE_MAX_RETRIES: "0",
          },
        },
      });
      for await (const message of q as AsyncIterable<SDKMessage>) {
        const m = message as { type: string; subtype?: string };
        messages.push(m.subtype === undefined ? m.type : `${m.type}/${m.subtype}`);
        if (m.type === "result") break;
      }
    } finally {
      await fake.close();
    }
    const ran = existsSync(marker);
    rmSync(root, { recursive: true, force: true });
    // The measurement, printed so a run records it whichever way it falls.
    console.error(`R.2 official ask-under-bypass: hook=${JSON.stringify(hookCalls)} canUseTool=${JSON.stringify(canUseCalls)} commandRan=${ran} messages=${messages.join(",")}`);
    expect(hookCalls).toEqual(["Bash"]);
    expect(canUseCalls).toEqual(["Bash"]);
    expect(ran).toBe(false);
  }, 60_000);
});
