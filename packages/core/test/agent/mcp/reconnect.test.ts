// WS-25: `reconnectLiveSessionsFor` — after a sign-in or a sign-out, live children reconnect the server by
// THEIR OWN name for its canonical URL; never an eviction, never a restart.
import { describe, expect, test } from "bun:test";
import { reconnectLiveSessionsFor, type ReconnectableSession } from "../../../src/agent/mcp/reconnect";

function session(id: string, reconnect?: (name: string) => Promise<void>, turnRunning = false): ReconnectableSession & { query?: unknown } {
  return { sessionId: id, turnRunning, idle: async () => {}, ...(reconnect !== undefined ? { query: { reconnectMcpServer: reconnect } } : {}) };
}

describe("reconnectLiveSessionsFor (WS-25)", () => {
  test("matches by CANONICAL URL, per session's own names; stdio and other URLs are left alone", async () => {
    const calls: string[] = [];
    const s1 = session("s1", async (n) => { calls.push(`s1:${n}`); });
    const s2 = session("s2", async (n) => { calls.push(`s2:${n}`); });
    const s3 = session("s3", async (n) => { calls.push(`s3:${n}`); });
    const servers: Record<string, Record<string, { type?: string; url?: string }>> = {
      s1: { linear: { type: "http", url: "https://MCP.example.test/mcp/" } },
      s2: { lin: { type: "sse", url: "https://mcp.example.test:443/mcp" }, other: { type: "http", url: "https://mcp.example.test/other" } },
      s3: { local: { type: "stdio" } },
    };
    const acted = await reconnectLiveSessionsFor({ list: () => [s1, s2, s3], serversFor: (id) => servers[id]! }, "https://mcp.example.test/mcp");
    expect(acted).toEqual(["s1", "s2"]);
    expect(calls).toEqual(["s1:linear", "s2:lin"]);
  });

  test("a rejected reconnect (a signed-out server is needs-auth now) and a child without the method are one log line each, never a throw", async () => {
    const lines: string[] = [];
    const rejecting = session("a", async () => { throw new Error("needs-auth"); });
    const old = session("b");
    const acted = await reconnectLiveSessionsFor({
      list: () => [rejecting, old],
      serversFor: () => ({ x: { type: "http", url: "https://mcp.example.test/mcp" } }),
      log: (l) => lines.push(l),
    }, "https://mcp.example.test/mcp");
    expect(acted).toEqual(["a", "b"]);
    expect(lines.some((l) => l.includes("did not connect"))).toBe(true);
    expect(lines.some((l) => l.includes("next incarnation"))).toBe(true);
  });

  test("a session whose configuration cannot be read is skipped; an unparseable URL acts on nothing", async () => {
    const acted = await reconnectLiveSessionsFor({ list: () => [session("z", async () => {})], serversFor: () => { throw new Error("gone"); } }, "https://mcp.example.test/mcp");
    expect(acted).toEqual([]);
    expect(await reconnectLiveSessionsFor({ list: () => [session("z", async () => {})], serversFor: () => ({}) }, "not a url")).toEqual([]);
  });
});
