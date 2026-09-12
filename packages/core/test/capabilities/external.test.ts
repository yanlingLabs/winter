// Phase 8c Lane 3, Task 3.4 — the `external` capability server: plugin-contributed tools, forwarded
// to the owning plugin over a fake stand-in for `PluginSupervisor.invoke`.
import { describe, expect, test } from "bun:test";
import type { WinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";
import { capabilityServerName, capabilityToolName } from "../../src/capabilities/names";
import { externalCapability, type ExternalToolSource } from "../../src/capabilities/external";
import type { CapabilitySession } from "../../src/capabilities/server";

const SESSION: CapabilitySession = { sessionId: "s_ext", mode: "code", cwd: "/tmp", roots: ["/tmp"] };

function instanceOf(sources: ExternalToolSource[], session: CapabilitySession = SESSION): WinterMcpServerInstance {
  const server = externalCapability(session, { tools: () => sources });
  return server.instance as WinterMcpServerInstance;
}

describe("externalCapability", () => {
  test("no tools() dep at all ⇒ registers with zero tools (inert, not broken)", () => {
    const server = externalCapability(SESSION, {});
    expect(server.name).toBe(capabilityServerName("external"));
    expect((server.instance as WinterMcpServerInstance).listTools()).toEqual([]);
  });

  test("a fake plugin's contributed tool appears under the P8b-35 wire name mcp__norma__external__<tool>", () => {
    const source: ExternalToolSource = {
      pluginId: "battery-limiter", name: "set_limit", description: "Sets the charge limit.",
      parameters: { type: "object", properties: { percent: { type: "number" } } },
      async invoke() { return { ok: true, resultJson: "limit set" }; },
    };
    const instance = instanceOf([source]);
    const tools = instance.listTools();
    expect(tools).toEqual([{ name: "set_limit", description: "Sets the charge limit.", inputSchema: { type: "object", properties: { percent: { type: "number" } } } }]);
    // The router builds `mcp__<server.name>__<tool.name>` (capabilities/names.ts's own convention);
    // `server.name` is `capabilityServerName("external")` ("norma__external"), so the wire name a
    // child actually sees is exactly `capabilityToolName("external", "set_limit")`.
    expect(`mcp__${capabilityServerName("external")}__set_limit`).toBe(capabilityToolName("external", "set_limit"));
  });

  test("a call round-trips to the plugin's invoke() and back as a text result", async () => {
    let received = "";
    const source: ExternalToolSource = {
      pluginId: "p1", name: "echo", description: "echoes",
      async invoke(argsJson) { received = argsJson; return { ok: true, resultJson: "echoed: hi" }; },
    };
    const instance = instanceOf([source]);
    const result = await instance.callTool("echo", { text: "hi" });
    expect(received).toBe(JSON.stringify({ text: "hi" }));
    expect(result).toEqual({ content: [{ type: "text", text: "echoed: hi" }], isError: false });
  });

  test("an invoke() failure becomes an isError tool_result, not a thrown transport fault", async () => {
    const source: ExternalToolSource = {
      pluginId: "p1", name: "flaky", description: "sometimes fails",
      async invoke() { return { ok: false, message: "plugin timed out" }; },
    };
    const instance = instanceOf([source]);
    const result = await instance.callTool("flaky", {});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("plugin timed out");
  });

  test("an unknown tool name reads exactly as every other capability server words it", async () => {
    const instance = instanceOf([]);
    const result = await instance.callTool("does_not_exist", {});
    expect(result).toEqual({ content: [{ type: "text", text: "unknown tool: does_not_exist" }], isError: true });
  });

  test("mode default is code — absent from a dispatch/chat session's tool list", () => {
    const source: ExternalToolSource = { pluginId: "p1", name: "code_only", description: "d", async invoke() { return { ok: true, resultJson: "" }; } };
    expect(instanceOf([source], { ...SESSION, mode: "code" }).listTools().map((t) => t.name)).toEqual(["code_only"]);
    expect(instanceOf([source], { ...SESSION, mode: "dispatch" }).listTools().map((t) => t.name)).toEqual([]);
    expect(instanceOf([source], { ...SESSION, mode: "chat" }).listTools().map((t) => t.name)).toEqual([]);
  });

  test("an explicit modes declaration widens/narrows exposure per the plugin's own manifest", () => {
    const source: ExternalToolSource = { pluginId: "p1", name: "chatty", description: "d", modes: ["chat", "dispatch"], async invoke() { return { ok: true, resultJson: "" }; } };
    expect(instanceOf([source], { ...SESSION, mode: "code" }).listTools()).toEqual([]);
    expect(instanceOf([source], { ...SESSION, mode: "chat" }).listTools().map((t) => t.name)).toEqual(["chatty"]);
    expect(instanceOf([source], { ...SESSION, mode: "dispatch" }).listTools().map((t) => t.name)).toEqual(["chatty"]);
  });

  test("a plugin registered AFTER the server was built is absent from that already-built snapshot (documented)", () => {
    const live: ExternalToolSource[] = [];
    const server = externalCapability(SESSION, { tools: () => live }); // snapshot taken NOW, at build time
    live.push({ pluginId: "p1", name: "late", description: "d", async invoke() { return { ok: true, resultJson: "" }; } });
    // The ALREADY-BUILT server's instance still reflects the empty list it was constructed from —
    // `tools()` is called ONCE by `externalCapability`, matching every other capability's
    // "built once at session start" contract. A FRESH `externalCapability(...)` call picks it up.
    expect((server.instance as WinterMcpServerInstance).listTools()).toEqual([]);
    const fresh = externalCapability(SESSION, { tools: () => live });
    expect((fresh.instance as WinterMcpServerInstance).listTools().map((t) => t.name)).toEqual(["late"]);
  });
});
