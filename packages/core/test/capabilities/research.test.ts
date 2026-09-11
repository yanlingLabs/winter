import { afterEach, describe, expect, test } from "bun:test";
import { isWinterMcpServerInstance, type WinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";
import { ToolRegistry, type ToolContext } from "../../src/agent/tools/registry";
import { registerSearchTool, EXA_API_KEY_SECRET } from "../../src/agent/tools/search";
import { registerReadPageTool } from "../../src/agent/tools/read-page";
import { PageCache } from "../../src/agent/tools/page-core";
import { researchCapability } from "../../src/capabilities/research";
import type { CapabilitySession } from "../../src/capabilities/server";

/**
 * The `research` capability server (C-6 / P8b-12) — `Search` + `ReadPage`.
 *
 * THE SECURITY PROPERTY THIS FILE EXISTS FOR: the Exa key is daemon state that must never leave the
 * daemon. It is read via `secret(...)` at CALL time, never at construction, and it must never appear
 * in the tool list the router serializes into a spawned child — which is a wire message crossing a
 * process boundary. Both halves are asserted below, plus the dangerous-domain/SSRF floor.
 *
 * No real network: `Search` runs against a fake Exa on `127.0.0.1:0`; the SSRF case is a literal
 * metadata IP, which needs no DNS.
 */

const SID = "s_research";
const KEY = "exa_test_key_do_not_leak";

const servers: Array<{ stop(closeActive?: boolean): void }> = [];
afterEach(() => { for (const s of servers.splice(0)) s.stop(true); });

interface Harness {
  registry: ToolRegistry;
  instance: WinterMcpServerInstance;
  session: CapabilitySession | undefined;
  secretCalls: string[];
}

function harness(over: { searchFetch?: typeof fetch } = {}): Harness {
  const h = { registry: new ToolRegistry(), secretCalls: [] as string[] } as Harness;
  h.session = { sessionId: SID, mode: "chat", cwd: "/tmp", roots: ["/tmp"] };
  const secret = async (name: string): Promise<string | null> => { h.secretCalls.push(name); return KEY; };
  const searchDeps = { secret, fetchFn: over.searchFetch };
  const readPageDeps = { cache: new PageCache() };
  registerSearchTool(h.registry, searchDeps);
  registerReadPageTool(h.registry, readPageDeps);
  h.instance = researchCapability({
    currentSession: () => h.session,
    search: searchDeps,
    readPage: readPageDeps,
  }).instance as WinterMcpServerInstance;
  return h;
}

function ctx(): ToolContext {
  return { cwd: "/tmp", roots: ["/tmp"], sessionId: SID, mode: "chat" } as ToolContext;
}

describe("researchCapability: the server shape", () => {
  test("is an `sdk` server named `research` carrying Search and ReadPage", () => {
    const h = harness();
    const server = researchCapability({
      currentSession: () => h.session, search: {}, readPage: { cache: new PageCache() },
    });
    expect(server.type).toBe("sdk");
    expect(server.name).toBe("research");
    expect(isWinterMcpServerInstance(server.instance)).toBe(true);
    expect((server.instance as WinterMcpServerInstance).listTools().map((t) => t.name).sort())
      .toEqual(["ReadPage", "Search"]);
  });

  test("schema parity with the registry door, and both are JSON-Schema objects", () => {
    const h = harness();
    for (const tool of h.instance.listTools()) {
      const spec = h.registry.specFor(tool.name, undefined, "dispatch")!;
      expect(tool.description).toBe(spec.description);
      expect(tool.inputSchema).toEqual(spec.parameters as Record<string, unknown>);
      expect(tool.inputSchema["type"]).toBe("object");
    }
  });
});

describe("researchCapability: the Exa key never leaves the daemon (C-6 / P8b-12)", () => {
  test("the serialized listTools() output contains no key, and nothing read one to build it", () => {
    const h = harness();
    const serialized = JSON.stringify(h.instance.listTools());
    expect(serialized).not.toContain(KEY);
    expect(serialized.toLowerCase()).not.toContain("x-api-key");
    // Constructing the server and listing its tools must not have touched the secret store at all.
    expect(h.secretCalls).toEqual([]);
  });

  test("a fake Exa on 127.0.0.1:0 receives the key header — read at CALL time", async () => {
    const seen: Array<{ key: string | null; body: string }> = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        seen.push({ key: req.headers.get("x-api-key"), body: await req.text() });
        return new Response(JSON.stringify({ results: [{ title: "T", url: "https://example.com", text: "excerpt" }] }), { status: 200 });
      },
    });
    servers.push(server);
    const local = `http://127.0.0.1:${server.port}/search`;
    // The tool builds the request (url is Exa's, headers are the tool's); the injected fetch only
    // re-points the destination, so what the fake sees is exactly what the tool constructed.
    const searchFetch = ((_url: string, init?: RequestInit) => fetch(local, init)) as unknown as typeof fetch;

    const h = harness({ searchFetch });
    expect(h.secretCalls).toEqual([]); // still nothing, before the call
    const res = await h.instance.callTool("Search", { query: "exa pricing" });
    expect(res.isError).toBe(false);
    expect(h.secretCalls).toEqual([EXA_API_KEY_SECRET]); // read at CALL time, exactly once
    expect(seen.length).toBe(1);
    expect(seen[0]!.key).toBe(KEY);
    expect(seen[0]!.body).toContain("exa pricing");
    // And the key is nowhere in what the model gets back.
    expect(JSON.stringify(res.content)).not.toContain(KEY);
  });
});

describe("researchCapability: the SSRF / dangerous-domain floor is today's", () => {
  test("a metadata-IP URL is refused, with the registry door's own message", async () => {
    const url = "http://169.254.169.254/";
    const viaRegistryH = harness();
    const viaRegistry = await viaRegistryH.registry.execute("ReadPage", { pages: [{ url }] }, ctx());
    const viaCapabilityH = harness();
    const viaCapability = await viaCapabilityH.instance.callTool("ReadPage", { pages: [{ url }] });
    expect(viaRegistry.isError).toBe(true);
    expect(viaCapability.isError).toBe(true);
    expect(viaCapability.content).toEqual([{ type: "text", text: viaRegistry.output }]);
  });

  test("a dangerous-domain URL is refused identically on both doors", async () => {
    const dangerousDomainsAdded = (): string[] => ["evil.example"];
    const registry = new ToolRegistry();
    const cache = new PageCache();
    const deps = { cache, dangerousDomainsAdded };
    registerReadPageTool(registry, deps);
    const instance = researchCapability({
      currentSession: () => ({ sessionId: SID, mode: "chat", cwd: "/tmp", roots: ["/tmp"] }),
      search: {}, readPage: deps,
    }).instance as WinterMcpServerInstance;

    const args = { pages: [{ url: "https://evil.example/x" }] };
    const viaRegistry = await registry.execute("ReadPage", args, ctx());
    const viaCapability = await instance.callTool("ReadPage", args);
    expect(viaRegistry.isError).toBe(true);
    expect(viaCapability.content).toEqual([{ type: "text", text: viaRegistry.output }]);
    expect(String((viaCapability.content[0] as { text: string }).text)).toContain("evil.example");
  });

  test("a `research` runner supplied by a GETTER is read at CALL time, not at construction", async () => {
    // THE DAEMON'S OWN SHAPE, proven rather than hoped: `daemon.ts` builds this server ABOVE the
    // `if (agentProvider)` gate, so the ephemeral research runner does not exist yet and is handed
    // over as `get research() { return researchRunner; }`. Were `read-page.ts` to copy `deps.research`
    // at factory scope, every Winter-leg `query` entry would answer "research is not available in
    // this session yet" forever — with nothing failing anywhere.
    let runner: { run(): Promise<string> } | undefined;
    const readPage = { cache: new PageCache(), get research() { return runner as never; } };
    const instance = researchCapability({
      currentSession: () => ({ sessionId: SID, mode: "chat", cwd: "/tmp", roots: ["/tmp"] }),
      search: {}, readPage,
    }).instance as WinterMcpServerInstance;

    // Before the gate opens: the tool's own "not available yet" answer.
    const before = await instance.callTool("ReadPage", { pages: [{ url: "https://example.com", query: "q" }] });
    expect(String((before.content[0] as { text: string }).text)).toContain("research is not available in this session yet");

    // The gate opens (daemon.ts assigns `researchRunner`) — no server is rebuilt.
    let ran = 0;
    runner = { run: async () => { ran++; return "a cited report"; } };
    const after = await instance.callTool("ReadPage", { pages: [{ url: "https://example.com", query: "q" }] });
    expect(ran).toBe(1);
    expect(String((after.content[0] as { text: string }).text)).toContain("a cited report");
  });

  test("no bound session refuses without reading the key or touching the network", async () => {
    const h = harness({ searchFetch: (() => { throw new Error("network must not be reached"); }) as unknown as typeof fetch });
    h.session = undefined;
    const res = await h.instance.callTool("Search", { query: "anything" });
    expect(res.isError).toBe(true);
    expect(h.secretCalls).toEqual([]);
  });
});
