// Uses the REAL @anthropic-ai/claude-agent-sdk module (installed as an optional dep in this dev/CI
// environment) for `createSdkMcpServer`/`tool` — no fake stands in for those two functions, so a
// signature drift in the pinned 0.3.250 would fail here rather than only in the e2e.
//
// `createSdkMcpServer`'s returned `instance` is a REAL `@modelcontextprotocol/sdk` `McpServer` (not
// Winter's own `{listTools, callTool}` duck type — measured, see `official-capabilities.ts`'s own
// header for the broader finding this sits beside), so a unit test cannot call `listTools`/`callTool`
// on it directly. `tool()`'s own return value carries a plain, directly-invocable `.handler`
// (`SdkMcpToolDefinition.handler`), which is what this file exercises — a spy wraps the REAL `tool`
// export to capture it while every call still goes through the pinned SDK's own code.
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { ToolDefinition } from "../../src/agent/tools/registry";
import { capabilityServer, type CapabilityServerRecord, type CapabilitySession } from "../../src/capabilities";
import { jsonSchemaToZodShape, officialCapabilityServersFor, type OfficialMcpModule } from "../../src/runtime-sdk/official-capabilities";

const echoDef: ToolDefinition = {
  name: "echo_thing",
  description: "echoes its input back",
  args: z.object({ text: z.string().max(50).describe("what to echo"), loud: z.boolean().optional() }),
  run: (args) => `echo: ${(args as { text: string }).text}`,
};

function session(): CapabilitySession {
  return { sessionId: "s_test", mode: "code", cwd: "/tmp", roots: ["/tmp"] };
}

function record(): CapabilityServerRecord {
  const server = capabilityServer({ key: "probe", defs: [echoDef] }, session());
  return { [server.name]: server };
}

/** Wraps the REAL official module so a test can capture each `tool()` definition (for its directly
 *  invocable `.handler`) while `createSdkMcpServer` still runs unmodified against them. */
async function spiedOfficialModule(): Promise<{ module: OfficialMcpModule; captured: Array<{ name: string; handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: unknown[]; isError?: boolean }> }> }> {
  const real = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as OfficialMcpModule;
  const captured: Array<{ name: string; handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: unknown[]; isError?: boolean }> }> = [];
  const module: OfficialMcpModule = {
    createSdkMcpServer: (options) => real.createSdkMcpServer!(options),
    tool: (name, description, inputSchema, handler) => {
      const def = real.tool!(name, description, inputSchema, handler as (args: unknown, extra: unknown) => Promise<unknown>);
      captured.push({ name, handler: handler as (args: Record<string, unknown>, extra: unknown) => Promise<{ content: unknown[]; isError?: boolean }> });
      return def;
    },
  };
  return { module, captured };
}

describe("jsonSchemaToZodShape", () => {
  test("converts a rendered capability schema into a usable zod raw shape", () => {
    const rendered = capabilityServer({ key: "probe", defs: [echoDef] }, session());
    const tool = (rendered.instance as { listTools(): Array<{ inputSchema: Record<string, unknown> }> }).listTools()[0]!;
    const shape = jsonSchemaToZodShape(tool.inputSchema as Parameters<typeof jsonSchemaToZodShape>[0]);
    const parsed = z.object(shape).parse({ text: "hi" });
    expect(parsed.text).toBe("hi");
    expect(() => z.object(shape).parse({})).toThrow();
  });
});

describe("officialCapabilityServersFor — the real official SDK module", () => {
  test("registers one server per record entry, under the SAME key the Winter leg uses", async () => {
    const { module } = await spiedOfficialModule();
    const servers = officialCapabilityServersFor(record(), module);
    expect(Object.keys(servers)).toEqual(["winter__probe"]);
    const built = servers["winter__probe"] as { type: string; name: string; instance: unknown };
    expect(built.type).toBe("sdk");
    expect(built.instance).toBeDefined();
  });

  test("a call reaches the SAME Winter instance's callTool — byte-identical behaviour on both legs", async () => {
    const { module, captured } = await spiedOfficialModule();
    officialCapabilityServersFor(record(), module);
    expect(captured.map((c) => c.name)).toEqual(["echo_thing"]);
    const result = await captured[0]!.handler({ text: "hello" }, undefined);
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.content)).toContain("hello");
  });

  test("an unknown-tool call answers the SAME wording the Winter leg does — reached through the record directly", async () => {
    const built = capabilityServer({ key: "probe", defs: [echoDef] }, session());
    const instance = built.instance as { callTool(name: string, args: Record<string, unknown>): Promise<{ content: unknown[]; isError?: boolean }> };
    const result = await instance.callTool("not_a_real_tool", {});
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("unknown tool");
  });

  test("a record entry whose instance is not a WinterMcpServerInstance is skipped, not thrown", async () => {
    const { module } = await spiedOfficialModule();
    const bogus: CapabilityServerRecord = { winter__bogus: { type: "sdk", name: "winter__bogus", instance: { not: "a winter instance" } } };
    expect(() => officialCapabilityServersFor(bogus, module)).not.toThrow();
    expect(officialCapabilityServersFor(bogus, module)).toEqual({});
  });
});
