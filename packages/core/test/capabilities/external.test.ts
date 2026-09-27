// Phase 8c Lane 3, Task 3.4 — the `external` capability server: plugin-contributed tools, forwarded
// to the owning plugin over a fake stand-in for `PluginSupervisor.invoke`.
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { WinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";
import { capabilityServerName, capabilityToolName } from "../../src/capabilities/names";
import { externalCapability, externalToolNames, type ExternalCapabilityDeps, type ExternalToolSource } from "../../src/capabilities/external";
import type { CapabilitySession } from "../../src/capabilities/server";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { pluginToolNameParts } from "../../src/daemon";

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

  test("a fake plugin's contributed tool appears under the P8b-35 wire name mcp__winter__external__<tool>", () => {
    const source: ExternalToolSource = {
      pluginId: "battery-limiter", name: "set_limit", description: "Sets the charge limit.",
      parameters: { type: "object", properties: { percent: { type: "number" } } },
      async invoke() { return { ok: true, resultJson: "limit set" }; },
    };
    const instance = instanceOf([source]);
    const tools = instance.listTools();
    expect(tools).toEqual([{ name: "set_limit", description: "Sets the charge limit.", inputSchema: { type: "object", properties: { percent: { type: "number" } } } }]);
    // The router builds `mcp__<server.name>__<tool.name>` (capabilities/names.ts's own convention);
    // `server.name` is `capabilityServerName("external")` ("winter__external"), so the wire name a
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

  // -----------------------------------------------------------------------------------------
  // P8c integration round 2, item 3 — the REAL source: `daemon.ts`'s own `capabilityDeps.external`
  // wiring, exercised here against a REAL `ToolRegistry` (the same class `tool.register`,
  // ipc/server.ts, writes into) rather than a hand-built `ExternalToolSource`. Mirrors daemon.ts's
  // actual closure: `registry.listByPrefix("plugin__")` → `pluginToolNameParts` → `invoke` closing
  // over `registry.execute(...)`.
  // -----------------------------------------------------------------------------------------

  function daemonStyleDeps(registry: ToolRegistry): ExternalCapabilityDeps {
    return {
      tools: (session) => registry.listByPrefix("plugin__").flatMap((spec) => {
        const parsed = pluginToolNameParts(spec.name);
        if (!parsed) return [];
        return [{
          pluginId: parsed.pluginId,
          name: parsed.name,
          description: spec.description,
          ...(spec.parameters === undefined ? {} : { parameters: spec.parameters as Record<string, unknown> }),
          async invoke(argsJson: string) {
            const args = JSON.parse(argsJson) as Record<string, unknown>;
            const outcome = await registry.execute(spec.name, args, {
              cwd: session.cwd, roots: session.roots, sessionId: session.sessionId,
              tmpDir: session.tmpDir, outDir: session.outDir, mode: session.mode,
            });
            return outcome.isError ? { ok: false as const, message: outcome.output } : { ok: true as const, resultJson: outcome.output };
          },
        }];
      }),
    };
  }

  test("after a fake tool.register, a Code session's winter__external server lists mcp__winter__external__<name> and a call executes through the registry", async () => {
    // `tool.register`'s own handler (ipc/server.ts) registers exactly this shape: the namespaced
    // name, a passthrough args schema, and a `run()` closing over the plugin RPC bridge.
    const registry = new ToolRegistry();
    let received: unknown;
    registry.register({
      name: "plugin__battery-limiter__set_limit",
      description: "Sets the charge limit.",
      args: z.object({}).passthrough(),
      rawParameters: { type: "object", properties: { percent: { type: "number" } } },
      async run(args) { received = args; return "limit set to 80"; },
    });

    const server = externalCapability(SESSION, daemonStyleDeps(registry));
    const instance = server.instance as WinterMcpServerInstance;
    const tools = instance.listTools();
    expect(tools).toEqual([{
      name: "set_limit", description: "Sets the charge limit.",
      inputSchema: { type: "object", properties: { percent: { type: "number" } } },
    }]);
    expect(capabilityToolName("external", "set_limit")).toBe(`mcp__${capabilityServerName("external")}__set_limit`);

    const result = await instance.callTool("set_limit", { percent: 80 });
    expect(result).toEqual({ content: [{ type: "text", text: "limit set to 80" }], isError: false });
    expect(received).toEqual({ percent: 80 });

    // A code-only default (registry.register never set `modes`) — dispatch/chat see nothing, the
    // SAME default `ToolDefinition.modes`'s own doc comment names for a dynamically-registered tool.
    const chatServer = externalCapability({ ...SESSION, mode: "chat" }, daemonStyleDeps(registry));
    expect((chatServer.instance as WinterMcpServerInstance).listTools()).toEqual([]);
  });

  test("a plugin tool whose registered run() throws becomes an isError tool_result through the registry's own throw-catch", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "plugin__p2__flaky",
      description: "sometimes fails",
      args: z.object({}).passthrough(),
      async run() { throw new Error("plugin timed out"); },
    });
    const instance = externalCapability(SESSION, daemonStyleDeps(registry)).instance as WinterMcpServerInstance;
    const result = await instance.callTool("flaky", {});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("plugin timed out");
  });
});

describe("externalCapability — two plugins registering one tool name (WS-27)", () => {
  const src = (pluginId: string, name: string, reply = pluginId): ExternalToolSource => ({
    pluginId, name, description: `${name} from ${pluginId}`,
    async invoke() { return { ok: true, resultJson: reply }; },
  });

  test("same-named plugins from two marketplaces: both tools get unique, spec-qualified names; an unclashed tool keeps its bare name", async () => {
    const instance = instanceOf([src("notes@acme", "search"), src("notes@globex", "search"), src("notes@acme", "open")]);
    const names = instance.listTools().map((t) => t.name);
    expect(names).toEqual(["search__notes_acme", "search__notes_globex", "open"]);
    const a = await instance.callTool("search__notes_acme", {}) as { content: Array<{ text: string }> };
    const b = await instance.callTool("search__notes_globex", {}) as { content: Array<{ text: string }> };
    expect(a.content[0]!.text).toBe("notes@acme");
    expect(b.content[0]!.text).toBe("notes@globex");
  });

  test("stable: registration order and the session's mode never change a name", () => {
    const one = externalToolNames([src("notes@acme", "search"), src("notes@globex", "search")]);
    const two = externalToolNames([src("notes@globex", "search"), src("notes@acme", "search")]);
    expect(one).toEqual(["search__notes_acme", "search__notes_globex"]);
    expect(two).toEqual(["search__notes_globex", "search__notes_acme"]);
  });

  test("review 9: the digest form is at most 64 characters on the wire for ANY tool name length, and still unique", () => {
    for (const len of [1, 20, 31, 32, 60, 200]) {
      const tool = "t".repeat(len - 1) + "x";
      const names = externalToolNames([src(`${"p".repeat(50)}@m`, tool), src(`${"q".repeat(50)}@m`, tool)]);
      for (const n of names) expect(`mcp__winter__external__${n}`.length).toBeLessThanOrEqual(64);
      expect(new Set(names).size).toBe(2);
    }
    // One plugin's two long names sharing their first characters, both clashing: still distinct.
    const long = (end: string) => "a".repeat(40) + end;
    const names = externalToolNames([src("p@m", long("1")), src("q@m", long("1")), src("p@m", long("2")), src("q@m", long("2"))]);
    expect(new Set(names).size).toBe(4);
    for (const n of names) expect(`mcp__winter__external__${n}`.length).toBeLessThanOrEqual(64);
  });

  test("specs that sanitise alike, or a name past 64 characters, fall back to a digest", () => {
    const [x, y] = externalToolNames([src("a@b.c", "t"), src("a@b_c", "t")]);
    expect(x).toMatch(/^t__[0-9a-f]{8}$/);
    expect(y).toMatch(/^t__[0-9a-f]{8}$/);
    expect(x).not.toBe(y);
    const long = externalToolNames([src(`${"p".repeat(40)}@m`, "tool"), src("q@m", "tool")]);
    expect(long[0]).toMatch(/^tool__[0-9a-f]{8}$/);
    expect(long[1]).toBe("tool__q_m");
  });
});
