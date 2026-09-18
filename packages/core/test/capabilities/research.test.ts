import { afterEach, describe, expect, test } from "bun:test";
import { isWinterMcpServerInstance, type WinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerSearchTool, EXA_API_KEY_SECRET } from "../../src/agent/tools/search";
import { researchCapability } from "../../src/capabilities/research";
import type { CapabilitySession } from "../../src/capabilities/server";

/**
 * The `research` capability server — **`Search`, and nothing else** since the 2026-09-18 web-tools
 * ruling retired `ReadPage` (the child's own `WebFetch` reads pages now, claude's way).
 *
 * THE SECURITY PROPERTY THIS FILE EXISTS FOR: the Exa key is daemon state that must never leave the
 * daemon. It is read via `secret(...)` at CALL time, never at construction, and it must never appear
 * in the tool list the router serializes into a spawned child — which is a wire message crossing a
 * process boundary. Both halves are asserted below.
 *
 * The SSRF and dangerous-domain floors that `ReadPage` carried here did not vanish with it: the URL
 * guard's own corpus lives in `test/agent/tools/ssrf-resolver-sweep.test.ts` and
 * `test/agent/tools/page-core.test.ts`, and `Search`'s floor — now applied to CITED urls — is pinned in
 * `test/agent/tools/search.test.ts` and, through this door, by the last test here.
 *
 * No real network: the one live-ish case runs against a fake Exa on `127.0.0.1:0`.
 */

const SID = "s_research";
const KEY = "exa_test_key_do_not_leak";

const servers: Array<{ stop(closeActive?: boolean): void }> = [];
afterEach(() => { for (const s of servers.splice(0)) s.stop(true); });

interface Harness {
  registry: ToolRegistry;
  instance: WinterMcpServerInstance;
  session: CapabilitySession;
  secretCalls: string[];
}

function harness(over: { searchFetch?: typeof fetch; dangerousDomainsAdded?: () => string[] } = {}): Harness {
  const h = { registry: new ToolRegistry(), secretCalls: [] as string[] } as Harness;
  h.session = { sessionId: SID, mode: "chat", cwd: "/tmp", roots: ["/tmp"] };
  const secret = async (name: string): Promise<string | null> => { h.secretCalls.push(name); return KEY; };
  const searchDeps = { secret, fetchFn: over.searchFetch, dangerousDomainsAdded: over.dangerousDomainsAdded };
  registerSearchTool(h.registry, searchDeps);
  h.instance = researchCapability(h.session, { search: searchDeps }).instance as WinterMcpServerInstance;
  return h;
}

describe("researchCapability: the server shape", () => {
  test("is an `sdk` server named `research` carrying Search alone", () => {
    const h = harness();
    const server = researchCapability(h.session, { search: {} });
    expect(server.type).toBe("sdk");
    expect(server.name).toBe("winter__research");
    expect(isWinterMcpServerInstance(server.instance)).toBe(true);
    // `ReadPage` is retired — its ABSENCE is the assertion, not just Search's presence.
    expect((server.instance as WinterMcpServerInstance).listTools().map((t) => t.name)).toEqual(["Search"]);
  });

  test("schema parity with the registry door, and it is a JSON-Schema object", () => {
    const h = harness();
    for (const tool of h.instance.listTools()) {
      const spec = h.registry.specFor(tool.name, undefined, "dispatch")!;
      expect(tool.description).toBe(spec.description);
      expect(tool.inputSchema).toEqual(spec.parameters as Record<string, unknown>);
      expect(tool.inputSchema["type"]).toBe("object");
    }
  });
});

describe("researchCapability: Search's PRESENCE follows the Exa key (2026-09-18 ruling)", () => {
  // The capability-build half of the gate. `mode-options.ts`'s `disallowedToolsFor` makes the
  // complementary decision from the same value; both are needed, because a `disallowedTools` entry for
  // a tool the server never advertised denies nothing and a server advertising a tool the list withheld
  // offers nothing — silently, either way.
  const deps = { search: {} };
  const session = (over: Partial<CapabilitySession>): CapabilitySession =>
    ({ sessionId: SID, mode: "chat", cwd: "/tmp", roots: ["/tmp"], ...over });

  test("exaKeyPresent: false → the server advertises NOTHING (Search would be permanently uncallable)", () => {
    const instance = researchCapability(session({ exaKeyPresent: false }), deps).instance as WinterMcpServerInstance;
    expect(instance.listTools()).toEqual([]);
  });

  test("exaKeyPresent: true, and ABSENT, both advertise it — absent reads as PRESENT, as ToolExposure does", () => {
    for (const over of [{ exaKeyPresent: true }, {}]) {
      const instance = researchCapability(session(over), deps).instance as WinterMcpServerInstance;
      expect(instance.listTools().map((t) => t.name)).toEqual(["Search"]);
    }
  });

  test("the server itself is still built and still named — only its tool list narrows", () => {
    const server = researchCapability(session({ exaKeyPresent: false }), deps);
    expect(server.name).toBe("winter__research");
    expect(isWinterMcpServerInstance(server.instance)).toBe(true);
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
        return new Response(JSON.stringify({
          answer: "Exa charges per request.",
          citations: [{ title: "Pricing", url: "https://example.com/pricing" }],
        }), { status: 200 });
      },
    });
    servers.push(server);
    const local = `http://127.0.0.1:${server.port}/answer`;
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
    // The answer and its source reach the model; the key does not.
    expect(JSON.stringify(res.content)).toContain("Exa charges per request.");
    expect(JSON.stringify(res.content)).toContain("https://example.com/pricing");
    expect(JSON.stringify(res.content)).not.toContain(KEY);
  });
});

describe("researchCapability: the dangerous-domain floor reaches the capability door too", () => {
  test("a floor-listed CITATION is withheld through the MCP door exactly as through the registry door", async () => {
    // The deps object is the SAME one both doors are built from (`daemon.ts` hands one to each), so
    // this proves the floor is not a registry-only courtesy.
    const searchFetch = (async () => new Response(JSON.stringify({
      answer: "An answer.",
      citations: [{ title: "Bad", url: "https://evil.example/x" }, { title: "Good", url: "https://example.com/ok" }],
    }), { status: 200 })) as unknown as typeof fetch;
    const h = harness({ searchFetch, dangerousDomainsAdded: () => ["evil.example"] });

    const viaCapability = await h.instance.callTool("Search", { query: "q" });
    const text = String((viaCapability.content[0] as { text: string }).text);
    expect(viaCapability.isError).toBe(false);
    expect(text).not.toContain("evil.example");
    expect(text).toContain("https://example.com/ok");
    expect(text).toContain("withheld");

    const viaRegistry = await h.registry.execute("Search", { query: "q" }, { cwd: "/tmp", roots: ["/tmp"], sessionId: SID, mode: "chat" } as never);
    expect(viaCapability.content).toEqual([{ type: "text", text: viaRegistry.output }]);
  });
});
