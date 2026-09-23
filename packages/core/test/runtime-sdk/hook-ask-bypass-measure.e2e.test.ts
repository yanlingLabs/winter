// WS-21 L3 fix round 2 MEASUREMENT — under `bypassPermissions`, does a `PreToolUse` hook answering `ask`
// still reach `canUseTool` on the WINTER leg (a real spawned `winter` child)? The protected-path Bash check
// (`hooks.ts`'s `bashProtectedWriteHook`) answers `ask`, and the approval bridge turns that into a card
// (code) or a typed deny (dispatch/chat) — which only works if the child consults `canUseTool` at all.
// Claude's own evaluator checks a hook's ask before its bypass step (the pinned fact); this measures the
// Winter runtime. The scripted `winter-test/lanec` double makes exactly ONE real Bash call
// (`echo winter-t8-lanec`), as in `hooks-measure.e2e.test.ts`.
//
// SKIPS cleanly when `WINTER_RUNTIME_EXECUTABLE` is unset (`describeWithWinterBinary`).
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type CanUseTool, type HookCallback } from "@yanlinglabs/winter-agent-sdk";
import { createHostPromptQueue } from "../../src/runtime-sdk/prompt-queue";
import { describeWithWinterBinary } from "../helpers/winter-binary";

const contentOf = (m: unknown): Array<Record<string, unknown>> | undefined => {
  const content = (m as { message?: { content?: unknown } } | undefined)?.message?.content;
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : undefined;
};

describeWithWinterBinary("fix round 2 measurement — a hook `ask` under bypassPermissions on the Winter leg", (bin) => {
  test("the ask reaches canUseTool (and its deny is honoured): the command never runs", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-ask-bypass-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "winter-ask-bypass-cwd-"));
    const queue = createHostPromptQueue();
    const messages: Array<Record<string, unknown>> = [];
    const canUseCalls: string[] = [];
    const askHook: HookCallback = async () => ({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "fix round 2 measurement: ask" },
    });
    const canUseTool: CanUseTool = async (toolName) => {
      canUseCalls.push(toolName);
      return { behavior: "deny", message: "fix round 2 measurement: the bridge said no" };
    };
    const q = query({
      prompt: queue,
      options: {
        pathToClaudeCodeExecutable: bin,
        model: "winter-test/lanec",
        cwd,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        sandbox: { enabled: false },
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [askHook] }] },
        canUseTool,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: home, WINTER_HOME: home, WINTER_PROFILE: "test", WINTER_TEST_PROVIDER: "lanec" },
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
    // THE MEASUREMENT: under bypass, the hook's ask still consulted canUseTool, exactly once, for Bash…
    expect(canUseCalls).toEqual(["Bash"]);
    // …and its deny held: the command's output never appears.
    const toolResult = messages.flatMap((m) => contentOf(m) ?? []).find((b) => b.type === "tool_result") as { content?: unknown } | undefined;
    expect(toolResult).toBeDefined();
    expect(String(toolResult?.content)).not.toContain("winter-t8-lanec");
  }, 40_000);
});
