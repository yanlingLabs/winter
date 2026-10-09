// ComputerV2: the tool on the child's surface — the `computer_v2` capability server (per-incarnation description,
// ordered MCP content, concurrency-safe with no lane), and the fail-closed wiring around it: the gate class, the
// host-name pair, disallowedTools/toolSurfaceViolations, the explicit PreToolUse allow.
import { describe, expect, test } from "bun:test";
import type { WinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";
import { PermissionGate, isGateClassified, type SessionApprovalPolicy } from "../../src/agent/gate";
import { computerV2Capability, visionFor, type CapabilitySession } from "../../src/capabilities";
import type { ScriptResult } from "../../src/computer-use/service";
import { CAPABILITY_PLAIN_NAMES, disallowedToolsFor, toolSurfaceViolations, toolsFor } from "../../src/runtime-sdk/mode-options";
import { gateToolNameFor, hostToolNameFor } from "../../src/runtime-sdk/tool-names";
import { sessionHooksFor } from "../../src/runtime-sdk/hooks";

const SESSION: CapabilitySession = { sessionId: "s_cv2", mode: "code", cwd: "/tmp", roots: ["/tmp"] };
const TEXT_ONLY_MODEL = "deepseek/deepseek-v4-pro";

function instanceOf(session: CapabilitySession, service?: { run: (...a: never[]) => Promise<ScriptResult> }) {
  const cfg = computerV2Capability(session, service === undefined ? {} : { service: service as never });
  return { cfg, instance: cfg.instance as WinterMcpServerInstance };
}

describe("the computer_v2 capability server", () => {
  test("one tool, `script`, shown as ComputerV2, concurrency-safe with no lane, deferred (no alwaysLoad)", () => {
    const { cfg, instance } = instanceOf(SESSION);
    expect(cfg.name).toBe("winter__computer_v2");
    const tools = instance.listTools();
    expect(tools.map((t) => t.name)).toEqual(["script"]);
    expect((cfg as { toolNames?: Record<string, string> }).toolNames).toEqual({ script: "ComputerV2" });
    expect((cfg as { concurrentTools?: string[] }).concurrentTools).toEqual(["script"]);
    expect((cfg as { toolLanes?: unknown }).toolLanes).toBeUndefined();
    expect((tools[0] as { _meta?: unknown })._meta).toBeUndefined();
    expect(tools[0]!.inputSchema).toMatchObject({ required: ["code"], additionalProperties: false });
  });

  test("the description follows the incarnation's model: no screenshot/show/Point without image input", () => {
    expect(visionFor(TEXT_ONLY_MODEL)).toBe(false);
    expect(visionFor("anthropic/claude-opus-5-5")).toBe(true);
    expect(visionFor("winter-test/calls")).toBe(true);
    const withVision = instanceOf({ ...SESSION, model: "anthropic/claude-opus-5-5" }).instance.listTools()[0]!.description;
    const without = instanceOf({ ...SESSION, model: TEXT_ONLY_MODEL }).instance.listTools()[0]!.description;
    expect(withVision).toContain("screenshot(");
    expect(withVision).toContain("show(image");
    expect(without).not.toContain("screenshot(");
    expect(without).not.toContain("show(");
    expect(without).not.toContain("Point");
  });

  test("a call reaches the service with the session, the vision fact and the signal; its content arrives IN ORDER", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const service = {
      run: async (call: Record<string, unknown>, input: Record<string, unknown>): Promise<ScriptResult> => {
        seen.push({ ...call, ...input });
        return { content: [{ type: "text", text: "a\n" }, { type: "image", data: "QUJD", mimeType: "image/jpeg" }, { type: "text", text: "b\n" }], isError: true };
      },
    };
    const { instance } = instanceOf({ ...SESSION, model: TEXT_ONLY_MODEL }, service as never);
    const out = await instance.callTool("script", { code: "print(1)", timeoutMs: 5000, title: "Notes" });
    expect(out).toEqual({ content: [{ type: "text", text: "a\n" }, { type: "image", data: "QUJD", mimeType: "image/jpeg" }, { type: "text", text: "b\n" }], isError: true });
    expect(seen[0]).toMatchObject({ sessionId: "s_cv2", vision: false, model: TEXT_ONLY_MODEL, code: "print(1)", timeoutMs: 5000, title: "Notes" });
  });

  test("bad arguments are refused by the schema before anything runs; a chat session has no such tool", async () => {
    let ran = false;
    const service = { run: async () => { ran = true; return { content: [], isError: false }; } };
    const { instance } = instanceOf(SESSION, service as never);
    expect((await instance.callTool("script", { code: "x", timeoutMs: 10 })).isError).toBe(true);
    expect((await instance.callTool("script", { code: "x", other: 1 })).isError).toBe(true);
    expect(ran).toBe(false);
    const chat = instanceOf({ ...SESSION, mode: "chat" }, service as never).instance;
    expect(chat.listTools()).toEqual([]);
    expect((await chat.callTool("script", { code: "x" })).isError).toBe(true);
  });
});

describe("the fail-closed wiring", () => {
  test("the gate: the call itself is allowed under every code/dispatch policy (the policy is per app, inside); chat denied", () => {
    const gate = new PermissionGate();
    for (const p of ["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"] as SessionApprovalPolicy[]) expect(gate.evaluate("computer_v2", p)).toBe("allow");
    expect(gate.evaluate("computer_v2", "chat")).toBe("deny");
    expect(isGateClassified("computer_v2")).toBe(true);
  });

  test("names: ComputerV2 ↔ computer_v2, both spellings; the MCP spelling only while the key is live", () => {
    expect(hostToolNameFor("ComputerV2")).toBe("computer_v2");
    expect(hostToolNameFor("mcp__winter__computer_v2__script")).toBe("computer_v2");
    expect(hostToolNameFor("mcp__winter__computer_v2__script", new Set(["computer_v2"]))).toBe("computer_v2");
    expect(hostToolNameFor("mcp__winter__computer_v2__script", new Set(["computer"]))).toBeUndefined();
    expect(hostToolNameFor("mcp__winter__computer_v2__other")).toBeUndefined();
    expect(gateToolNameFor("ComputerV2")).toBe("computer_v2");
  });

  test("disallowedTools and the init check: ComputerV2 is code + dispatch, never chat", () => {
    expect(disallowedToolsFor("chat")).toContain("ComputerV2");
    expect(disallowedToolsFor("code")).not.toContain("ComputerV2");
    expect(disallowedToolsFor("dispatch")).not.toContain("ComputerV2");
    expect(CAPABILITY_PLAIN_NAMES.has("ComputerV2")).toBe(true);
    // A dispatch child offering ComputerV2 is honest; a built-in outside the allowed list is not.
    expect(toolSurfaceViolations(["ComputerV2", "Bash"], toolsFor("dispatch", {}), CAPABILITY_PLAIN_NAMES)).toEqual([]);
    expect(toolSurfaceViolations(["ComputerV2", "Edit"], toolsFor("dispatch", {}), CAPABILITY_PLAIN_NAMES)).toEqual(["Edit"]);
  });

  test("the PreToolUse allow: explicit for ComputerV2 under every code/dispatch policy; nothing in chat or when the key is not live", async () => {
    const groupFor = (deps: Parameters<typeof sessionHooksFor>[0]) =>
      (sessionHooksFor(deps).winter?.PreToolUse ?? []).find((m) => m.matcher === "ComputerV2|mcp__winter__computer_v2__script");
    const invoke = async (deps: Parameters<typeof sessionHooksFor>[0], toolName: string) => {
      const group = groupFor(deps);
      expect(group).toBeDefined();
      return await group!.hooks[0]!({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: { code: "x" } } as never, "toolu_1", { signal: new AbortController().signal });
    };
    const base = { sessionId: "s1", roots: ["/tmp"] };
    const allow = await invoke({ ...base, mode: "code", policy: () => "dont-ask", capabilityKeys: () => new Set(["computer_v2"]) }, "ComputerV2");
    expect(allow).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
    const mcpSpelling = await invoke({ ...base, mode: "dispatch", capabilityKeys: () => new Set(["computer_v2"]) }, "mcp__winter__computer_v2__script");
    expect(mcpSpelling).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });
    expect(await invoke({ ...base, mode: "chat", capabilityKeys: () => new Set(["computer_v2"]) }, "ComputerV2")).toEqual({});
    expect(await invoke({ ...base, mode: "code", capabilityKeys: () => new Set(["computer"]) }, "ComputerV2")).toEqual({});
    expect(await invoke({ ...base, mode: "code", capabilityKeys: () => new Set(["computer_v2"]) }, "Bash")).toEqual({});
  });
});
