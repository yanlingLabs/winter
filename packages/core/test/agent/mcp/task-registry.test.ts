import { describe, expect, test } from "bun:test";
import { McpTaskRegistry } from "../../../src/agent/mcp/task-registry";

const input = { sessionId: "s1", server: "pix", tool: "render", taskId: "t1" };

describe("McpTaskRegistry", () => {
  test("a registered task is running and not yet claimable", () => {
    const r = new McpTaskRegistry();
    r.register(input);
    expect(r.get("pix:t1")?.status).toBe("running");
    expect(r.takeForNotification("pix:t1")).toBeUndefined();
  });

  test("a completed task is claimable EXACTLY once", () => {
    const r = new McpTaskRegistry();
    r.register(input);
    r.complete("pix:t1", { ok: true, result: "done" });
    const first = r.takeForNotification("pix:t1");
    expect(first?.status).toBe("completed");
    expect(first?.result).toBe("done");
    expect(r.takeForNotification("pix:t1")).toBeUndefined();
  });

  test("failure and cancellation are distinct terminal states", () => {
    const r = new McpTaskRegistry();
    r.register(input);
    r.complete("pix:t1", { ok: false, result: "boom", status: "failed" });
    expect(r.takeForNotification("pix:t1")?.status).toBe("failed");

    const r2 = new McpTaskRegistry();
    r2.register({ ...input, taskId: "t2" });
    r2.complete("pix:t2", { ok: false, result: "", status: "cancelled" });
    expect(r2.takeForNotification("pix:t2")?.status).toBe("cancelled");
  });

  test("a second complete() never overwrites the first terminal state", () => {
    const r = new McpTaskRegistry();
    r.register(input);
    r.complete("pix:t1", { ok: false, result: "", status: "cancelled" });
    r.complete("pix:t1", { ok: true, result: "late result" });
    expect(r.get("pix:t1")?.status).toBe("cancelled");
    expect(r.get("pix:t1")?.result).toBe("");
  });

  test("unknown ids are total functions, never throws", () => {
    const r = new McpTaskRegistry();
    expect(r.get("nope:x")).toBeUndefined();
    expect(r.takeForNotification("nope:x")).toBeUndefined();
    expect(() => r.complete("nope:x", { ok: true, result: "" })).not.toThrow();
    expect(r.list("s1")).toEqual([]);
  });

  test("list is per-session", () => {
    const r = new McpTaskRegistry();
    r.register(input);
    r.register({ sessionId: "s2", server: "pix", tool: "render", taskId: "t9" });
    expect(r.list("s1").map((e) => e.taskId)).toEqual(["t1"]);
    expect(r.list("s2").map((e) => e.taskId)).toEqual(["t9"]);
  });

  test("the same taskId from two different servers does not collide", () => {
    const r = new McpTaskRegistry();
    r.register({ sessionId: "s1", server: "a", tool: "x", taskId: "1" });
    r.register({ sessionId: "s1", server: "b", tool: "y", taskId: "1" });
    r.complete("a:1", { ok: true, result: "from a" });
    expect(r.get("a:1")?.status).toBe("completed");
    expect(r.get("b:1")?.status).toBe("running");
  });
});
