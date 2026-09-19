// MEASUREMENT (router 0.0.10) — does the REAL, pinned `claude` binary honour a MID-TURN
// `setPermissionMode`, and which mode actually hides a tool call from the host?
//
// WHY THIS FILE EXISTS BESIDE THE DAEMON'S OWN e2e. `official-leg.e2e.test.ts` proves the product
// chain (`session.setPolicy` -> the router's door -> the child -> a real approval card, mid-turn), but
// it cannot isolate WHOSE decision changed: Winter's own `settings` (the control-plane deny rules and
// the filesystem sandbox) make the runtime ask about an edit even in `acceptEdits`, so in that bed a
// card can appear because the daemon's gate started asking rather than because the child's mode moved.
// The claim the whole change rests on is a claim about the BINARY, so it is measured against the
// binary, through the vendor's own `query()`, with nothing of Winter's in the way — the same reasoning
// (and the same shape) as `web-floor-measure.e2e.test.ts`.
//
// WHAT IS MEASURED, in ONE turn, with the loopback held between the two scripted tool calls:
//   1. under `permissionMode: "acceptEdits"` the runtime auto-approves a `Write` and NEVER invokes
//      `canUseTool` — which is the bug in its original form: a host that switched its own policy to
//      `ask` had no way to be consulted, because the mode was fixed at spawn;
//   2. `query.setPermissionMode("default")` mid-turn RESOLVES (it is a control request on the
//      streaming stdin, the same channel `interrupt()` uses, and it needs a streaming prompt — the
//      pin's own doc says "only available in streaming input mode");
//   3. the very NEXT tool call, in the SAME turn, DOES reach `canUseTool`. Not at the next turn, not
//      at the next incarnation.
//
// HERMETICITY, the same rules the sibling measurement files follow: `env` REPLACES the child's whole
// environment, `HOME`/`CLAUDE_CONFIG_DIR` are fresh mkdtemps, the key is a fake string and the base
// URL is a loopback fake. Nothing here can reach the network, `~/.claude`, or a real credential.
//
// GATED: `describeWithClaudeRuntime` skips without the pinned platform package (and THROWS under
// `WINTER_CLAUDE_REQUIRE_RUNTIME=1`, the CI gate), and the measurement itself additionally needs
// `WINTER_MEASURE_LIVE_POLICY=1` because it spawns a real child and takes tens of seconds.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { anthropicFake, startFake } from "@yanlinglabs/winter-provider-conformance";
import { claudeRuntimeForTests, describeWithClaudeRuntime, LOOPBACK_MODEL_ID } from "../helpers/claude-runtime";

const ENABLED = process.env.WINTER_MEASURE_LIVE_POLICY === "1";

/** How many `tool_result` blocks a captured request body already carries — the same conversation-state
 *  rule `withAnthropicLoopback` uses to pick a scripted turn (never a bare request counter, because the
 *  runtime makes side requests of its own). */
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

interface Measured {
  /** `canUseTool` invocations recorded BEFORE the live switch. */
  before: string[];
  /** …and every invocation, in order. */
  all: string[];
  /** Did `setPermissionMode` resolve, or what did it reject with? */
  switchOutcome: string;
  firstWritten: boolean;
  secondWritten: boolean;
  /** `type[/subtype]` per SDK message — the transcript of one turn. */
  messages: string[];
}

async function measureLiveSwitch(opts: { from: "acceptEdits" | "dontAsk" | "plan"; to: "default" | "acceptEdits" }): Promise<Measured> {
  const bed = claudeRuntimeForTests();
  if (bed === undefined) throw new Error("unreachable: the suite is skipped without a bed");
  const root = mkdtempSync(join(tmpdir(), "winter-live-mode-measure-"));
  const home = join(root, "home");
  const cfg = join(root, "cfg");
  const cwd = join(root, "cwd");
  for (const dir of [home, cfg, cwd, join(home, "tmp")]) mkdirSync(dir, { recursive: true });
  const first = join(cwd, "first.txt");
  const second = join(cwd, "second.txt");

  const all: string[] = [];
  let before: string[] = [];
  let switchOutcome = "not attempted";
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });

  // A tool_use id per call: two blocks sharing one id put two identical tool_use ids in one
  // conversation, which the wire does not allow and the child stalls on (measured).
  const writeTurn = (id: string, path: string, content: string) =>
    anthropicFake.anthropicTurnResponse({ blocks: [{ type: "tool_use", id, name: "Write", jsonChunks: [JSON.stringify({ file_path: path, content })] }], stopReason: "tool_use" });

  const fake = await startFake({
    routes: [
      {
        path: "*",
        handler: async (_req, recorded) => {
          if (!(recorded.path === "/v1/messages" && recorded.method === "POST")) return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
          const done = countToolResults(recorded.body);
          if (done === 0) return writeTurn("call_1", first, "first");
          // HELD: the first write has landed and the next tool has not been asked for yet, so the
          // switch below cannot race the child's own round trip.
          if (done === 1) {
            await held;
            return writeTurn("call_2", second, "second");
          }
          return anthropicFake.anthropicTurnResponse({ blocks: [{ type: "text", chunks: ["done"] }], stopReason: "end_turn" });
        },
      },
    ],
  });

  try {
    // A STREAMING prompt that never ends: `setPermissionMode` is a control request, and the pin serves
    // control requests only in streaming input mode.
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      yield { type: "user", message: { role: "user", content: "write the two files you were scripted to write" }, parent_tool_use_id: null, session_id: "measure" } as SDKUserMessage;
      await new Promise<void>(() => undefined);
    }

    const q = query({
      prompt: prompt(),
      options: {
        pathToClaudeCodeExecutable: bed.executable,
        model: LOOPBACK_MODEL_ID,
        cwd,
        permissionMode: opts.from,
        settingSources: [],
        maxTurns: 6,
        canUseTool: async (toolName, input) => {
          all.push(toolName);
          return { behavior: "allow", updatedInput: input };
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
          ANTHROPIC_API_KEY: "sk-ant-fake-live-mode-measurement-0000",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_AUTOUPDATER: "1",
          CLAUDE_CODE_MAX_RETRIES: "0",
        },
      },
    });

    // The switch runs beside the iteration: wait for the first tool call to be over (its file, or its
    // refusal reaching `canUseTool`), snapshot what the host was asked, then switch and release.
    void (async () => {
      const deadline = Date.now() + 30_000;
      while (!existsSync(first) && all.length === 0 && Date.now() < deadline) await Bun.sleep(25);
      before = [...all];
      try {
        await q.setPermissionMode(opts.to);
        switchOutcome = "resolved";
      } catch (err) {
        switchOutcome = `rejected: ${err instanceof Error ? err.message : String(err)}`;
      }
      release?.();
    })();

    const messages: string[] = [];
    for await (const message of q as AsyncIterable<SDKMessage>) {
      const m = message as { type: string; subtype?: string };
      messages.push(m.subtype === undefined ? m.type : `${m.type}/${m.subtype}`);
      if (m.type === "result") break;
    }
    return { before, all, switchOutcome, firstWritten: existsSync(first), secondWritten: existsSync(second), messages };
  } finally {
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describeWithClaudeRuntime("the pinned runtime's live permission-mode change", () => {
  describe.skipIf(!ENABLED)("measured against the real binary (WINTER_MEASURE_LIVE_POLICY=1)", () => {
    test("acceptEdits auto-approves a Write without asking; a MID-TURN switch to default makes the next one ask", async () => {
      const m = await measureLiveSwitch({ from: "acceptEdits", to: "default" });
      console.warn(`[live-mode MEASURED] acceptEdits -> default: ${JSON.stringify(m)}`);
      // 1. THE BUG, in its original form: the edit landed and the host was never consulted.
      expect(m.firstWritten).toBe(true);
      expect(m.before).toEqual([]);
      // 2. the control request is accepted mid-turn…
      expect(m.switchOutcome).toBe("resolved");
      // 3. …and the very next call, in the SAME turn, reaches `canUseTool`.
      expect(m.all).toEqual(["Write"]);
      expect(m.secondWritten).toBe(true);
      // ONE turn: one `result` message closed it, with no second user turn in between.
      expect(m.messages.filter((t) => t.startsWith("result"))).toHaveLength(1);
    }, 180_000);
  });
});
