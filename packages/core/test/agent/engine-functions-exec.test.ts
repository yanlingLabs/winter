import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerToolSearchTool } from "../../src/agent/tools/toolsearch";
import { registerFunctionsExecTools } from "../../src/agent/tools/functions-exec";
import { FakeProvider } from "../../src/agent/fake-provider";
import { setupEngine } from "./engine-steer.test";
import type { FunctionsExecNestedCall, FunctionsExecRuntimeDeps } from "../../src/functions-exec/runtime";
import { ImageDetail } from "../../src/functions-exec/protocol";

const done = (reason: "end_turn" | "tool_calls") => ({ type: "done" as const, stopReason: reason });

function runtimeForNestedCall(nested: Pick<FunctionsExecNestedCall, "name" | "args">) {
  return (deps: Pick<FunctionsExecRuntimeDeps, "callTool" | "onFrame">) => ({
    cancel: () => true,
    async execute(input: { sessionId: string; cellId: string }) {
      if (!deps.callTool || !deps.onFrame) throw new Error("expected engine bridge callbacks");
      const result = await deps.callTool({ ...input, callId: "nested-1", ...nested });
      deps.onFrame(input.sessionId, input.cellId, { type: "text", text: typeof result === "string" ? result : JSON.stringify(result) });
      return { status: "completed" as const, cellId: input.cellId, frames: [] };
    },
  });
}

describe("engine functions.exec integration", () => {
  test("requires ToolSearch and keeps executable source opaque in events and provider input", async () => {
    const registry = new ToolRegistry();
    registerToolSearchTool(registry);
    registerFunctionsExecTools(registry, true);
    const source = "tools.text('private source')";
    const provider = new FakeProvider([
      [{ type: "tool_call", callId: "load", name: "ToolSearch", argsJson: JSON.stringify({ query: "select:functions.exec" }) }, done("tool_calls")],
      [{ type: "tool_call", callId: "run", name: "functions.exec", argsJson: JSON.stringify({ source }) }, done("tool_calls")],
      [{ type: "text_delta", delta: "done" }, done("end_turn")],
    ]);
    const { engine, events, sessionId } = setupEngine(provider, { registry, toolSearch: {} });

    await engine.runTurn(sessionId);

    expect(provider.requests[0]!.tools?.map((tool) => tool.name)).toContain("ToolSearch");
    expect(provider.requests[0]!.tools?.map((tool) => tool.name)).not.toContain("functions.exec");
    expect(provider.requests[1]!.tools?.map((tool) => tool.name)).toContain("functions.exec");
    const storedCall = events.find((event) => event.type === "tool_call" && event.callId === "run");
    if (!storedCall || storedCall.type !== "tool_call") throw new Error("expected functions.exec tool call");
    expect(storedCall.argsJson).toBe(JSON.stringify({ source: "[functions.exec source omitted]" }));
    expect(storedCall.argsJson).not.toContain("private source");
    expect(provider.requests.flatMap((request) => request.input).some((item) => item.type === "function_call" && item.argsJson.includes("private source"))).toBe(false);
  });

  test("routes a nested bash call through the ordinary auto-policy tool execution path", async () => {
    const registry = new ToolRegistry();
    registerToolSearchTool(registry);
    registerFunctionsExecTools(registry, true);
    const calls: string[] = [];
    registry.register({
      name: "bash",
      description: "test bash",
      args: z.object({ command: z.string() }),
      async run({ command }) { calls.push(command); return "bash ran"; },
    });
    const provider = new FakeProvider([
      [{ type: "tool_call", callId: "load", name: "ToolSearch", argsJson: JSON.stringify({ query: "select:functions.exec" }) }, done("tool_calls")],
      [{ type: "tool_call", callId: "run", name: "functions.exec", argsJson: JSON.stringify({ source: "ignored" }) }, done("tool_calls")],
      [{ type: "text_delta", delta: "done" }, done("end_turn")],
    ]);
    const { engine, events, sessionId } = setupEngine(provider, {
      registry,
      toolSearch: {},
      functionsExecRuntimeFactory: runtimeForNestedCall({ name: "bash", args: { command: "pwd" } }),
    });

    await engine.runTurn(sessionId);

    expect(calls).toEqual(["pwd"]);
    expect(events.some((event) => event.type === "tool_call" && event.name === "bash")).toBe(true);
    expect(events.some((event) => event.type === "tool_result" && event.output === "bash ran")).toBe(true);
  });

  test("applies the dangerous-domain floor to nested web_fetch calls", async () => {
    const registry = new ToolRegistry();
    registerToolSearchTool(registry);
    registerFunctionsExecTools(registry, true);
    let fetches = 0;
    registry.register({
      name: "web_fetch",
      description: "test fetch",
      args: z.object({ url: z.string() }),
      async run() { fetches += 1; return "should not run"; },
    });
    const provider = new FakeProvider([
      [{ type: "tool_call", callId: "load", name: "ToolSearch", argsJson: JSON.stringify({ query: "select:functions.exec" }) }, done("tool_calls")],
      [{ type: "tool_call", callId: "run", name: "functions.exec", argsJson: JSON.stringify({ source: "ignored" }) }, done("tool_calls")],
      [{ type: "text_delta", delta: "done" }, done("end_turn")],
    ]);
    const { engine, events, sessionId } = setupEngine(provider, {
      registry,
      policy: "dont-ask",
      toolSearch: {},
      functionsExecRuntimeFactory: runtimeForNestedCall({ name: "web_fetch", args: { url: "https://ngrok.io/collect" } }),
    });

    await engine.runTurn(sessionId);

    expect(fetches).toBe(0);
    expect(events.some((event) => event.type === "tool_result" && event.output.includes("web_fetch denied"))).toBe(true);
    expect(events.some((event) => event.type === "approval_requested")).toBe(false);
  });

  test("interrupt cancels a yielded cell after its outer turn has already settled", async () => {
    const registry = new ToolRegistry();
    registerToolSearchTool(registry);
    registerFunctionsExecTools(registry, true);
    let cancelled = false;
    const provider = new FakeProvider([
      [{ type: "tool_call", callId: "load", name: "ToolSearch", argsJson: JSON.stringify({ query: "select:functions.exec" }) }, done("tool_calls")],
      [{ type: "tool_call", callId: "run", name: "functions.exec", argsJson: JSON.stringify({ source: "ignored" }) }, done("tool_calls")],
      [{ type: "text_delta", delta: "done" }, done("end_turn")],
    ]);
    const { engine, sessionId } = setupEngine(provider, {
      registry,
      toolSearch: {},
      functionsExecRuntimeFactory: (deps) => ({
        cancel: () => { cancelled = true; return true; },
        async execute(input) {
          deps.onFrame?.(input.sessionId, input.cellId, { type: "yield" });
          return await new Promise(() => {});
        },
      }),
    });

    await engine.runTurn(sessionId);

    expect(engine.interrupt(sessionId)).toEqual({ wasRunning: false });
    expect(cancelled).toBe(true);
  });

  test("forwards image and audio only into the next provider request without persisting their data URLs", async () => {
    const registry = new ToolRegistry();
    registerToolSearchTool(registry);
    registerFunctionsExecTools(registry, true);
    const imageUrl = "data:image/png;base64,aGVsbG8=";
    const audioUrl = "data:audio/wav;base64,aGVsbG8=";
    const provider = new FakeProvider([
      [{ type: "tool_call", callId: "load", name: "ToolSearch", argsJson: JSON.stringify({ query: "select:functions.exec" }) }, done("tool_calls")],
      [{ type: "tool_call", callId: "run", name: "functions.exec", argsJson: JSON.stringify({ source: "ignored" }) }, done("tool_calls")],
      [{ type: "text_delta", delta: "done" }, done("end_turn")],
    ]);
    const { engine, events, sessionId } = setupEngine(provider, {
      registry,
      toolSearch: {},
      functionsExecRuntimeFactory: (deps) => ({
        cancel: () => true,
        async execute(input) {
          deps.onFrame?.(input.sessionId, input.cellId, { type: "image", dataUrl: imageUrl, detail: ImageDetail.High });
          deps.onFrame?.(input.sessionId, input.cellId, { type: "audio", dataUrl: audioUrl });
          return { status: "completed", cellId: input.cellId, frames: [] };
        },
      }),
    });

    await engine.runTurn(sessionId);

    expect(provider.requests[2]!.input).toContainEqual({ type: "image", imageUrl, detail: "high" });
    expect(provider.requests[2]!.input).toContainEqual({ type: "audio", dataUrl: audioUrl });
    expect(JSON.stringify(events)).not.toContain(imageUrl);
    expect(JSON.stringify(events)).not.toContain(audioUrl);
  });

  test("delivers notify frames as an immediate task notification", async () => {
    const registry = new ToolRegistry();
    registerToolSearchTool(registry);
    registerFunctionsExecTools(registry, true);
    const provider = new FakeProvider([
      [{ type: "tool_call", callId: "load", name: "ToolSearch", argsJson: JSON.stringify({ query: "select:functions.exec" }) }, done("tool_calls")],
      [{ type: "tool_call", callId: "run", name: "functions.exec", argsJson: JSON.stringify({ source: "ignored" }) }, done("tool_calls")],
      [{ type: "text_delta", delta: "done" }, done("end_turn")],
    ]);
    const { engine, events, sessionId } = setupEngine(provider, {
      registry,
      toolSearch: {},
      functionsExecRuntimeFactory: (deps) => ({
        cancel: () => true,
        async execute(input) {
          deps.onFrame?.(input.sessionId, input.cellId, { type: "notification", text: "cell progress" });
          return { status: "completed", cellId: input.cellId, frames: [] };
        },
      }),
    });

    await engine.runTurn(sessionId);

    expect(events.some((event) => event.type === "notification_requested" && event.message === "cell progress")).toBe(true);
    expect(events.some((event) => event.type === "task_notification" && event.content.includes("cell progress"))).toBe(true);
  });
});
