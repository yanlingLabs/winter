import { afterEach, describe, expect, test } from "bun:test";
import { isWinterMcpServerInstance, type WinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";
import { ToolRegistry, type ToolContext } from "../../src/agent/tools/registry";
import { registerWebTools, WEB_SEARCH_API_KEY_SECRET } from "../../src/agent/tools/web";
import { webCapability } from "../../src/capabilities/web";
import type { CapabilitySession } from "../../src/capabilities/server";

/**
 * The `web` capability server (ruling P8b-33) — `web_fetch` + `web_search`: CODE's web surface once
 * every mode disallows the SDK's built-in WebSearch/WebFetch.
 *
 * Same obligations as `research`: the Brave key is read at CALL time, never at construction and
 * never into `listTools()`; `ssrfGuard` and the dangerous-domain floor are today's, proven by
 * comparing the two doors' output rather than by transcribing a message.
 */

const SID = "s_web";
const KEY = "brave_test_key_do_not_leak";

const servers: Array<{ stop(closeActive?: boolean): void }> = [];
afterEach(() => { for (const s of servers.splice(0)) s.stop(true); });

interface Harness {
  registry: ToolRegistry;
  instance: WinterMcpServerInstance;
  session: CapabilitySession | undefined;
  secretCalls: string[];
  audits: Array<Record<string, unknown>>;
}

function harness(over: { fetchFn?: typeof fetch } = {}): Harness {
  const h = { registry: new ToolRegistry(), secretCalls: [] as string[], audits: [] as Array<Record<string, unknown>> } as Harness;
  h.session = { sessionId: SID, mode: "code", cwd: "/tmp", roots: ["/tmp"] };
  const deps = {
    secret: async (name: string): Promise<string | null> => { h.secretCalls.push(name); return KEY; },
    audit: (line: Record<string, unknown>) => { h.audits.push(line); },
    ...(over.fetchFn === undefined ? {} : { fetchFn: over.fetchFn }),
  };
  registerWebTools(h.registry, deps);
  h.instance = webCapability({ currentSession: () => h.session, web: deps }).instance as WinterMcpServerInstance;
  return h;
}

function ctx(): ToolContext {
  return { cwd: "/tmp", roots: ["/tmp"], sessionId: SID, mode: "code" } as ToolContext;
}

describe("webCapability: the server shape", () => {
  test("is an `sdk` server named `web` carrying web_fetch and web_search", () => {
    const h = harness();
    const server = webCapability({ currentSession: () => h.session, web: {} });
    expect(server.type).toBe("sdk");
    expect(server.name).toBe("web");
    expect(isWinterMcpServerInstance(server.instance)).toBe(true);
    expect((server.instance as WinterMcpServerInstance).listTools().map((t) => t.name).sort())
      .toEqual(["web_fetch", "web_search"]);
  });

  test("schema parity with the registry door, and both are JSON-Schema objects", () => {
    const h = harness();
    for (const tool of h.instance.listTools()) {
      const spec = h.registry.specFor(tool.name, undefined, "code")!;
      expect(tool.description).toBe(spec.description);
      expect(tool.inputSchema).toEqual(spec.parameters as Record<string, unknown>);
      expect(tool.inputSchema["type"]).toBe("object");
    }
  });

  test("the deferral on the registry door does NOT make the capability refuse", async () => {
    const h = harness();
    // `web_fetch`/`web_search` are `deferred: true`; the private registry never sets
    // `builtinDeferral`, so a capability call is served rather than told to load a schema first.
    expect(h.registry.isDeferredBuiltin("web_search", true)).toBe(true);
    const res = await h.instance.callTool("web_search", { query: "x" });
    expect(String((res.content[0] as { text: string }).text)).not.toContain("ToolSearch");
  });
});

describe("webCapability: the Brave key never leaves the daemon (P8b-33)", () => {
  test("the serialized listTools() output contains no key, and nothing read one to build it", () => {
    const h = harness();
    const serialized = JSON.stringify(h.instance.listTools());
    expect(serialized).not.toContain(KEY);
    expect(h.secretCalls).toEqual([]);
  });

  test("a fake search backend on 127.0.0.1:0 receives the key header — read at CALL time", async () => {
    const seen: Array<{ key: string | null; url: string }> = [];
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        seen.push({ key: req.headers.get("x-subscription-token"), url: req.url });
        return new Response(JSON.stringify({ web: { results: [{ title: "T", url: "https://example.com", description: "d" }] } }), { status: 200 });
      },
    });
    servers.push(server);
    const local = `http://127.0.0.1:${server.port}/res/v1/web/search`;
    const fetchFn = ((url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      return fetch(`${local}${u.search}`, init);
    }) as unknown as typeof fetch;

    const h = harness({ fetchFn });
    expect(h.secretCalls).toEqual([]);
    const res = await h.instance.callTool("web_search", { query: "norma daemon" });
    expect(h.secretCalls).toEqual([WEB_SEARCH_API_KEY_SECRET]); // read at CALL time
    expect(seen.length).toBe(1);
    expect(seen[0]!.key).toBe(KEY);
    expect(seen[0]!.url).toContain("q=norma%20daemon");
    expect(JSON.stringify(res.content)).not.toContain(KEY);
    // The audit line names the query and the outcome — never the key.
    expect(JSON.stringify(h.audits)).not.toContain(KEY);
  });
});

describe("webCapability: the SSRF floor is today's", () => {
  test("a metadata-IP fetch is refused identically on both doors", async () => {
    const url = "http://169.254.169.254/latest/meta-data/";
    const viaRegistryH = harness();
    const viaRegistry = await viaRegistryH.registry.execute("web_fetch", { url }, ctx());
    const viaCapabilityH = harness();
    const viaCapability = await viaCapabilityH.instance.callTool("web_fetch", { url });
    expect(viaRegistry.isError).toBe(true);
    expect(viaCapability.isError).toBe(true);
    expect(viaCapability.content).toEqual([{ type: "text", text: viaRegistry.output }]);
  });

  test("web_fetch HARD-REQUIRES the session's tmpDir — a Task 16 obligation, not an optional field", async () => {
    // `web_fetch` saves the converted page under `ctx.tmpDir` and throws when it is unset, so a
    // `CapabilitySession` without one makes every code-mode fetch fail. Recorded as a test rather
    // than a comment because the session driver is a LATER task and this is the field it must set.
    const h = harness();
    const withoutTmp = await h.instance.callTool("web_fetch", { url: "https://example.com" });
    expect(withoutTmp.isError).toBe(true);
    expect(String((withoutTmp.content[0] as { text: string }).text)).toContain("ctx.tmpDir is unset");
    // With one bound, the fence check is passed and the call proceeds to the network layer.
    h.session = { ...h.session!, tmpDir: "/tmp/norma-cap-web" };
    const withTmp = await h.instance.callTool("web_fetch", { url: "http://169.254.169.254/" });
    expect(String((withTmp.content[0] as { text: string }).text)).not.toContain("ctx.tmpDir is unset");
  });

  test("no bound session refuses without reading the key", async () => {
    const h = harness({ fetchFn: (() => { throw new Error("network must not be reached"); }) as unknown as typeof fetch });
    h.session = undefined;
    const res = await h.instance.callTool("web_search", { query: "anything" });
    expect(res.isError).toBe(true);
    expect(h.secretCalls).toEqual([]);
  });
});
