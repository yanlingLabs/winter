// Router 3279a1d (Contract A `escapeSandboxGlobPath`) — does the daemon's OFFICIAL-leg sandbox fence hold
// under a directory whose name holds `[`, on the real, pinned `claude` binary?
//
// claude reads a `sandbox.filesystem` entry holding any of `* ? [ ]` as a GLOB (a seatbelt regex), so a
// raw `[wip] app` entry is a character class that misses the literal directory. `officialSandboxConfigFor`
// spells it `[[]wip] app`. Measured with a sandboxed Bash write into the fenced directory: the spelled
// entry must stop it; the raw entry is recorded as the control (the gap the spelling closes).
//
// Same hermetic bed as the sibling official measurements. GATED by `describeWithClaudeRuntime`.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { anthropicFake, startFake } from "@yanlinglabs/winter-provider-conformance";
import { escapeSandboxGlobPath } from "@yanlinglabs/winter-runtime-sdk";
import { claudeRuntimeForTests, describeWithClaudeRuntime, LOOPBACK_MODEL_ID } from "../helpers/claude-runtime";

async function sandboxedWriteLands(spelled: boolean): Promise<{ landed: boolean; messages: string[] }> {
  const bed = claudeRuntimeForTests();
  if (bed === undefined) throw new Error("unreachable: the suite is skipped without a bed");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "winter-sbx-glob-")));
  const home = join(root, "home");
  const cfg = join(root, "cfg");
  const cwd = join(root, "cwd");
  const fenced = join(cwd, "[wip] app");
  for (const dir of [home, cfg, cwd, fenced, join(home, "tmp")]) mkdirSync(dir, { recursive: true });
  const target = join(fenced, "f.txt");
  let served = false;
  const fake = await startFake({
    routes: [{
      path: "*",
      handler: async (_req, recorded) => {
        if (!(recorded.path === "/v1/messages" && recorded.method === "POST")) return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        if (!served && !recorded.body.includes("tool_result")) {
          served = true;
          return anthropicFake.anthropicTurnResponse({ blocks: [{ type: "tool_use", id: "call_bash_1", name: "Bash", jsonChunks: [JSON.stringify({ command: `echo measured > '${target}'`, description: "write into the fenced dir" })] }], stopReason: "tool_use" });
        }
        return anthropicFake.anthropicTurnResponse({ blocks: [{ type: "text", chunks: ["done"] }], stopReason: "end_turn" });
      },
    }],
  });
  const messages: string[] = [];
  try {
    const q = query({
      prompt: "write the file you were scripted to write",
      options: {
        pathToClaudeCodeExecutable: bed.executable,
        model: LOOPBACK_MODEL_ID,
        cwd,
        settingSources: [],
        settings: { sandbox: { enabled: true, filesystem: { denyWrite: [spelled ? escapeSandboxGlobPath(fenced) : fenced] } } },
        maxTurns: 4,
        canUseTool: async (_tool, input) => ({ behavior: "allow", updatedInput: input }),
        env: {
          HOME: home, USER: "winter-measure", LOGNAME: "winter-measure", SHELL: "/bin/zsh", LANG: "en_US.UTF-8",
          TMPDIR: `${join(home, "tmp")}/`, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", CLAUDE_CONFIG_DIR: cfg,
          ANTHROPIC_BASE_URL: fake.url, ANTHROPIC_API_KEY: "sk-ant-fake-sandbox-glob-measurement-0000",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_MAX_RETRIES: "0",
        },
      },
    });
    for await (const message of q as AsyncIterable<SDKMessage>) {
      const m = message as { type: string; subtype?: string };
      messages.push(m.subtype === undefined ? m.type : `${m.type}/${m.subtype}`);
      if (m.type === "result") break;
    }
    return { landed: existsSync(target), messages };
  } finally {
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describeWithClaudeRuntime("router 3279a1d — the official-leg sandbox fence under a `[`-named directory", () => {
  test("the escapeSandboxGlobPath-spelled denyWrite stops a sandboxed Bash write; the raw spelling is the recorded control", async () => {
    const spelled = await sandboxedWriteLands(true);
    const raw = await sandboxedWriteLands(false);
    console.error(`sandbox glob escape (official): spelled deny -> write landed=${spelled.landed}; raw deny -> write landed=${raw.landed}; ${spelled.messages.join(",")}`);
    expect(spelled.landed).toBe(false);
  }, 90_000);
});
