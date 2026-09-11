import { describe, expect, test } from "bun:test";
import { isWinterMcpServerInstance, type WinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerComputerTool } from "../../src/agent/tools/computer";
import type { ComputerUseService, CuActResult } from "../../src/agent/computer-use";
import { computerCapability } from "../../src/capabilities/computer";
import type { CapabilitySession } from "../../src/capabilities/server";

/**
 * The `computer` capability server (P8b Task 6), over the SAME fake `ComputerUseService`
 * `test/agent/computer-tool.test.ts` uses — no real peripheral broker, no leases, no Norma.app.
 */

function fakeCu(result: CuActResult): { calls: Array<{ sid: string; cls: string; payload: string }>; service: ComputerUseService } {
  const calls: Array<{ sid: string; cls: string; payload: string }> = [];
  const act = async (sid: string, cls: string, payload: string): Promise<CuActResult> => {
    calls.push({ sid, cls, payload });
    return result;
  };
  return { calls, service: { act } as unknown as ComputerUseService };
}

function session(over: Partial<CapabilitySession> = {}): CapabilitySession {
  return { sessionId: "s_code", mode: "code", cwd: "/tmp", roots: ["/tmp"], ...over };
}

describe("computerCapability: the server shape", () => {
  test("is an `sdk` server named `computer` with a callable instance", () => {
    const server = computerCapability(session(), { computerUse: () => undefined });
    expect(server.type).toBe("sdk");
    expect(server.name).toBe("norma__computer");
    expect(isWinterMcpServerInstance(server.instance)).toBe(true);
  });

  test("listTools advertises `computer` with the REGISTRY'S schema (rawParameters, not zod)", () => {
    const registry = new ToolRegistry();
    registerComputerTool(registry);
    const server = computerCapability(session(), { computerUse: () => undefined });
    const tools = (server.instance as WinterMcpServerInstance).listTools();
    expect(tools.map((t) => t.name)).toEqual(["computer"]);
    const spec = registry.specFor("computer", undefined, "code")!;
    expect(tools[0]!.description).toBe(spec.description);
    expect(tools[0]!.inputSchema).toEqual(spec.parameters as Record<string, unknown>);
    // The router's construction gate: the schema must be a JSON-Schema object.
    expect(tools[0]!.inputSchema["type"]).toBe("object");
  });
});

describe("computerCapability: callTool", () => {
  test("a screenshot returns the SAME content the registry path returns", async () => {
    const dataUrl = "data:image/png;base64,ABC";
    const result: CuActResult = { ok: true, resultJson: JSON.stringify({ dataUrl, width: 1512, height: 982 }) } as CuActResult;

    const registry = new ToolRegistry();
    registerComputerTool(registry);
    const viaRegistryCu = fakeCu(result);
    const viaRegistry = await registry.execute("computer", { action: "screenshot" }, {
      cwd: "/tmp", roots: ["/tmp"], sessionId: "s_code", mode: "code",
      computerUse: viaRegistryCu.service, visionCapable: true,
    });

    const capCu = fakeCu(result);
    const server = computerCapability(session({ computerUse: capCu.service, visionCapable: true }), {
      computerUse: () => undefined,
    });
    const viaCapability = await (server.instance as WinterMcpServerInstance).callTool("computer", { action: "screenshot" });

    expect(viaRegistry.isError).toBe(false);
    expect(viaCapability.isError).toBe(false);
    expect(viaCapability.content).toEqual([{ type: "text", text: viaRegistry.output }]);
    expect(capCu.calls[0]!.cls).toBe("screenshot");
    // The session identity the call was bound to — not a guess, not a default.
    expect(capCu.calls[0]!.sid).toBe("s_code");
  });

  test("the daemon's service getter supplies the ComputerUseService when the session does not", async () => {
    const cu = fakeCu({ ok: true, resultJson: JSON.stringify({ text: "#0 window" }) } as CuActResult);
    const server = computerCapability(session(), { computerUse: () => cu.service });
    const res = await (server.instance as WinterMcpServerInstance).callTool("computer", { action: "ax_snapshot" });
    expect(res.isError).toBe(false);
    expect(cu.calls[0]!.cls).toBe("ax-read");
  });

  test("computer use turned off at runtime → the tool's own refusal, as an isError result", async () => {
    const server = computerCapability(session(), { computerUse: () => undefined });
    const res = await (server.instance as WinterMcpServerInstance).callTool("computer", { action: "ax_snapshot" });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain("computer use is not available in this session");
  });

  test("screenshotMaxDim is read PER CALL, so the hot setting needs no daemon restart", async () => {
    const cu = fakeCu({ ok: true, resultJson: JSON.stringify({ dataUrl: "data:image/png;base64,A", width: 100, height: 100 }) } as CuActResult);
    let maxDim: number | undefined = 800;
    const server = computerCapability(session({ computerUse: cu.service, visionCapable: true }), {
      computerUse: () => undefined,
      screenshotMaxDim: () => maxDim,
    });
    const instance = server.instance as WinterMcpServerInstance;
    await instance.callTool("computer", { action: "screenshot" });
    expect(JSON.parse(cu.calls[0]!.payload)).toEqual({ op: "screenshot", maxDim: 800 });
    maxDim = 1600;
    await instance.callTool("computer", { action: "screenshot" });
    expect(JSON.parse(cu.calls[1]!.payload)).toEqual({ op: "screenshot", maxDim: 1600 });
  });

  test("invalid arguments and unknown tools are isError results, never throws", async () => {
    const server = computerCapability(session(), { computerUse: () => undefined });
    const instance = server.instance as WinterMcpServerInstance;
    const bad = await instance.callTool("computer", { action: "teleport" });
    expect(bad.isError).toBe(true);
    expect((bad.content[0] as { text: string }).text).toContain("invalid arguments for computer");
    const unknown = await instance.callTool("keyboard", {});
    expect(unknown.isError).toBe(true);
    expect((unknown.content[0] as { text: string }).text).toBe("unknown tool: keyboard");
  });

  test("the capability never rides ToolSearch deferral (a dispatch call is not refused)", async () => {
    const cu = fakeCu({ ok: true, resultJson: JSON.stringify({ text: "#0 window" }) } as CuActResult);
    const server = computerCapability(session({ mode: "dispatch", computerUse: cu.service }), {
      computerUse: () => undefined,
    });
    const res = await (server.instance as WinterMcpServerInstance).callTool("computer", { action: "ax_snapshot" });
    expect(res.isError).toBe(false);
    expect((res.content[0] as { text: string }).text).not.toContain("ToolSearch");
  });
});
