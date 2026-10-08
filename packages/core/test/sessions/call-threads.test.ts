// The reviewing pill: the daemon's index of which thread each live tool call is on (`sessions/call-threads.ts`).
import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@yanlinglabs/winter-protocol";
import { CallThreads } from "../../src/sessions/call-threads";

const call = (sessionId: string, callId: string, threadId: string) =>
  ({ type: "tool_call", sessionId, threadId, seq: 1, ts: 1, callId, name: "Bash", argsJson: "{}" }) as unknown as SessionEvent;
const result = (sessionId: string, callId: string) =>
  ({ type: "tool_result", sessionId, threadId: "main", seq: 2, ts: 2, callId, output: "", isError: false }) as unknown as SessionEvent;

describe("CallThreads", () => {
  test("a call's thread from its tool_call, per session; main for one never seen; forgotten at its result", () => {
    const t = new CallThreads();
    t.observe(call("s1", "toolu_a", "main"));
    t.observe(call("s1", "toolu_b", "toolu_agent"));
    t.observe(call("s2", "toolu_b", "main"));
    expect(t.threadOf("s1", "toolu_b")).toBe("toolu_agent");
    expect(t.threadOf("s2", "toolu_b")).toBe("main");
    expect(t.threadOf("s1", "nope")).toBe("main");
    t.observe(result("s1", "toolu_b"));
    expect(t.threadOf("s1", "toolu_b")).toBe("main");
    expect(t.threadOf("s1", "toolu_a")).toBe("main");
  });

  test("bounded per session: the oldest unanswered call goes first", () => {
    const t = new CallThreads();
    for (let i = 0; i < 600; i++) t.observe(call("s1", `c${i}`, "th"));
    expect(t.threadOf("s1", "c0")).toBe("main");
    expect(t.threadOf("s1", "c599")).toBe("th");
  });
});
