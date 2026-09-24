// Router 3279a1d (Contract A `escapeSandboxGlobPath`) — does the daemon's sandbox fence hold under a
// directory whose name holds `[`, on BOTH real binaries?
//
// claude reads a `sandbox.filesystem` entry holding any of `* ? [ ]` as a GLOB (a seatbelt regex), so a
// raw `[wip] app` entry is a character class that misses the literal directory. `childSandboxConfigFor`
// spells it `[[]wip] app`. Measured with a sandboxed Bash write into the fenced directory: the spelled
// entry must stop it; the raw entry is recorded as the control (the gap the spelling closes).
//
// The Winter leg: MEASURED at agent SDK 5e37898 (claude's `Li`/`Rt` port — a glob-shaped deny renders as
// an SBPL regex clause), the Winter runtime reads the same grammar: a raw `[wip] app` deny let the write
// through, the spelled one held, and a plain-named directory's raw deny held (the fence itself works).
// That is why the daemon sends the spelled list on both legs.
//
// Same hermetic beds as the sibling measurements. GATED by `describeWithClaudeRuntime` /
// `describeWithWinterBinary`.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { query as winterQuery } from "@yanlinglabs/winter-agent-sdk";
import { anthropicFake, startFake } from "@yanlinglabs/winter-provider-conformance";
import { escapeSandboxGlobPath } from "@yanlinglabs/winter-runtime-sdk";
import { claudeRuntimeForTests, describeWithClaudeRuntime, LOOPBACK_MODEL_ID } from "../helpers/claude-runtime";
import { describeWithWinterBinary } from "../helpers/winter-binary";

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

describeWithWinterBinary("agent SDK 5e37898 — the Winter-leg sandbox fence under a `[`-named directory", (bin) => {
  async function winterWriteLands(dirName: string, spelled: boolean): Promise<boolean> {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "winter-sbx-glob-w-")));
    const home = join(root, "home");
    const cwd = join(root, "cwd");
    const fenced = join(cwd, dirName);
    for (const dir of [home, join(home, "tmp"), cwd, fenced]) mkdirSync(dir, { recursive: true });
    const target = join(fenced, "f.txt");
    let served = false;
    const fake = await startFake({
      routes: [{
        path: "*",
        handler: async (_req, recorded) => {
          if (!(recorded.path === "/v1/messages" && recorded.method === "POST")) return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
          if (!served && !recorded.body.includes("tool_result")) {
            served = true;
            return anthropicFake.anthropicTurnResponse({ blocks: [{ type: "tool_use", id: "call_bash_1", name: "Bash", jsonChunks: [JSON.stringify({ command: `echo measured > '${target}'; true`, description: "write into the fenced dir" })] }], stopReason: "tool_use" });
          }
          return anthropicFake.anthropicTurnResponse({ blocks: [{ type: "text", chunks: ["done"] }], stopReason: "end_turn" });
        },
      }],
    });
    try {
      const q = winterQuery({
        prompt: "write the file you were scripted to write",
        options: {
          pathToClaudeCodeExecutable: bin,
          model: "anthropic/claude-sonnet-5",
          provider: { providerId: "anthropic", authRef: { kind: "inline", value: "sk-ant-loopback" }, connection: { baseUrl: fake.url, local: true } },
          cwd,
          sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, filesystem: { denyWrite: [spelled ? escapeSandboxGlobPath(fenced) : fenced] } },
          canUseTool: async (_tool: string, input: Record<string, unknown>) => ({ behavior: "allow", updatedInput: input }),
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: `${join(home, "tmp")}/`, WINTER_HOME: home, WINTER_PROFILE: "test" },
        } as never,
      });
      for await (const m of q) if ((m as { type?: string }).type === "result") break;
      return existsSync(target);
    } finally {
      await fake.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("a plain-named directory's deny holds; under `[wip] app` the spelled deny holds and the raw one is the recorded control", async () => {
    const plain = await winterWriteLands("plain app", false);
    const spelled = await winterWriteLands("[wip] app", true);
    const raw = await winterWriteLands("[wip] app", false);
    console.error(`sandbox glob escape (winter): plain raw deny -> landed=${plain}; [wip] spelled deny -> landed=${spelled}; [wip] raw deny -> landed=${raw}`);
    expect(plain).toBe(false);
    expect(spelled).toBe(false);
  }, 120_000);
});
