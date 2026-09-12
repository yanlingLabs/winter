// P8c-7 MEASUREMENT (Lane 3, Task 3.1) — does a real, spawned `winter` child fire a
// `PreToolUse`/`PostToolUse` `Options.hooks` callback back through the wrapper's stdio bridge, and
// does a `PreToolUse` `deny` actually block the call? 8b's completion report named this unmeasured:
// the wrapper (`@yanlinglabs/winter-agent-sdk`'s `index.js`) demonstrably CONVERTS `Options.hooks`
// (real, in-process `HookCallback` functions) into a metadata-only `RuntimeHooksConfig` for the wire
// (`buildRuntimeHooksConfig`) and registers a `"hook"` control-request handler
// (`controlRequestHandlers.set("hook", makeHookHandler(...))`) keyed by a synthesized `hookId` — but
// whether the COMPILED `dist/winter` binary actually sends that control request when it executes a
// matching tool call can only be measured against the real binary, never inferred from the wrapper's
// source.
//
// The scripted `winter-test/lanec` double (`provider/mock.ts`) is used because it makes exactly ONE
// real `Bash` tool call (`echo winter-t8-lanec`) with no side effect to clean up and a
// deterministic, single-line stdout — the same double `transport-equivalence.test.ts` uses for its
// own Lane C representative. `allowedTools: ["Bash"]` + `sandbox: { enabled: false }` mirror that
// scenario's exact configuration: a bare-allowed tool needs no `canUseTool` round-trip and no
// macOS-sandbox-exec dependency, so the ONLY thing standing between the model's tool_use and the
// child actually running it is whatever `Options.hooks` decides — which is precisely the seam this
// file measures.
//
// SKIPS cleanly when `WINTER_RUNTIME_EXECUTABLE` is unset; `WINTER_RUNTIME_REQUIRE_BINARY=1` (CI) makes
// a missing binary a FAILURE (P8b-2 contract, `describeWithWinterBinary`).
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type HookCallback, type HookInput, type Options } from "@yanlinglabs/winter-agent-sdk";
import { createHostPromptQueue } from "../../src/runtime-sdk/prompt-queue";
import { describeWithWinterBinary } from "../helpers/winter-binary";

/** A raw wire message's `message.content` array, when it has one — the shape both
 *  `real-child.test.ts` and `transport-equivalence.test.ts` already key their own assertions off. */
function contentOf(m: unknown): Array<Record<string, unknown>> | undefined {
  const content = (m as { message?: { content?: unknown } } | undefined)?.message?.content;
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : undefined;
}

/** Drives one `winter-test/lanec` turn (a single real `Bash` call) with the given hook config, and
 *  returns every raw SDK message plus every `PreToolUse`/`PostToolUse` callback invocation. Mirrors
 *  `real-child.test.ts`'s `driveChild` — CONSTRUCTED env only, never `process.env` spread, so no
 *  developer home or credential ever reaches the child. */
async function driveWithHooks(bin: string, hooks: Options["hooks"]): Promise<{
  messages: Array<Record<string, unknown>>;
}> {
  const home = mkdtempSync(join(tmpdir(), "winter-hooks-measure-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "winter-hooks-measure-cwd-"));
  const queue = createHostPromptQueue();
  const messages: Array<Record<string, unknown>> = [];

  const q = query({
    prompt: queue,
    options: {
      pathToClaudeCodeExecutable: bin,
      model: "winter-test/lanec",
      cwd,
      allowedTools: ["Bash"],
      sandbox: { enabled: false },
      hooks,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        // Pre-rename this set two distinct env keys — the daemon's own home var, and WINTER_HOME (the SDK's
        // brand-derived home); the rename makes them the same key, so it is written once now.
        HOME: home, TMPDIR: home, WINTER_HOME: home,
        WINTER_PROFILE: "test",
        WINTER_TEST_PROVIDER: "lanec",
      },
    },
  });

  queue.push("go");
  try {
    for await (const m of q) {
      messages.push(m as Record<string, unknown>);
      if ((m as { type?: string }).type === "result") break;
    }
  } finally {
    if (!queue.closed) queue.close();
    for (const dir of [home, cwd]) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
  return { messages };
}

describeWithWinterBinary("P8c-7 measurement — Options.hooks against a real winter child", (bin) => {
  test("PreToolUse and PostToolUse callbacks fire for a real Bash tool call, with the pinned input shapes", async () => {
    const preToolUse: HookInput[] = [];
    const postToolUse: HookInput[] = [];
    const preCallback: HookCallback = async (input) => { preToolUse.push(input); return {}; };
    const postCallback: HookCallback = async (input) => { postToolUse.push(input); return {}; };

    const { messages } = await driveWithHooks(bin, {
      PreToolUse: [{ matcher: "Bash", hooks: [preCallback] }],
      PostToolUse: [{ matcher: "Bash", hooks: [postCallback] }],
    });

    // The call actually ran (undenied): the same trace shape transport-equivalence.test.ts pins.
    expect(messages.map((m) => m.type)).toEqual(["system", "assistant", "user", "assistant", "result"]);
    const toolResultBlock = contentOf(messages[2])?.[0];
    expect(toolResultBlock).toMatchObject({ type: "tool_result" });
    expect(String((toolResultBlock as { content?: unknown })?.content)).toContain("winter-t8-lanec");
    expect((toolResultBlock as { denied?: unknown }).denied).not.toBe(true);

    // THE MEASUREMENT: exactly one callback per event, PINNED `HookInput` shape (WS's own types).
    expect(preToolUse).toHaveLength(1);
    expect(preToolUse[0]).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "Bash" });
    expect((preToolUse[0] as { tool_input?: unknown }).tool_input).toMatchObject({ command: "echo winter-t8-lanec" });
    expect(typeof preToolUse[0]!.session_id).toBe("string");

    expect(postToolUse).toHaveLength(1);
    expect(postToolUse[0]).toMatchObject({ hook_event_name: "PostToolUse", tool_name: "Bash" });
    expect((postToolUse[0] as { tool_input?: unknown }).tool_input).toMatchObject({ command: "echo winter-t8-lanec" });
    expect((postToolUse[0] as { tool_response?: unknown }).tool_response).toBeDefined();
  }, 40_000);

  test("a PreToolUse `deny` actually blocks the Bash call — never runs, never appears in tool_result", async () => {
    const denyCallback: HookCallback = async () => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "P8c-7 measurement: deliberate deny",
      },
    });

    const { messages } = await driveWithHooks(bin, {
      PreToolUse: [{ matcher: "Bash", hooks: [denyCallback] }],
    });

    // A deny inserts an extra `system/permission_denied` message ahead of the `tool_result` (measured
    // above) — the "user" message carrying the tool_result is still the FIRST `user`-typed message.
    const denialNotice = messages.find((m) => m.type === "system" && (m as { subtype?: string }).subtype === "permission_denied");
    expect(denialNotice).toMatchObject({ tool_name: "Bash", decision_reason_type: "hook", message: "P8c-7 measurement: deliberate deny" });
    const toolResultMsg = messages.find((m) => m.type === "user");
    const toolResultBlock = contentOf(toolResultMsg)?.[0] as { type?: string; content?: unknown; denied?: unknown } | undefined;
    expect(toolResultBlock?.type).toBe("tool_result");
    // Denied: the block is marked `denied` and never carries the command's actual stdout — instead
    // it carries the PreToolUse hook's OWN `permissionDecisionReason`, round-tripped end to end.
    expect(toolResultBlock?.denied).toBe(true);
    expect(toolResultBlock?.content).toBe("P8c-7 measurement: deliberate deny");
    expect(String(toolResultBlock?.content)).not.toContain("winter-t8-lanec");
    // The turn still completes (never runs the command) and the model's own next turn proceeds
    // unaffected — a deny blocks the ONE call, not the session.
    expect(messages.at(-1)).toMatchObject({ type: "result", is_error: false });
  }, 40_000);
});
