// WS-25: `reconnectLiveSessionsFor` — after a sign-in or a sign-out, live children reconnect the server by
// THEIR OWN name for its URL (the live incarnation answers, `WinterSession.mcpServerNamesFor`); never an
// eviction, never a restart.
import { describe, expect, test } from "bun:test";
import { describeReconnectError, reconnectLiveSessionsFor, type ReconnectableSession } from "../../../src/agent/mcp/reconnect";

function session(
  id: string,
  names: (url: string) => string[],
  reconnect: (name: string) => Promise<void>,
  opts: { turnRunning?: boolean; idle?: () => Promise<void> } = {},
): ReconnectableSession {
  return {
    sessionId: id,
    turnRunning: opts.turnRunning ?? false,
    idle: opts.idle ?? (async () => {}),
    mcpServerNamesFor: names,
    reconnectMcpServer: reconnect,
  };
}

describe("reconnectLiveSessionsFor (WS-25)", () => {
  test("each session is asked for ITS names at the URL and reconnects exactly those; sessions naming none are left alone", async () => {
    const calls: string[] = [];
    const asked: string[] = [];
    const url = "https://mcp.example.test/mcp";
    const s1 = session("s1", (u) => { asked.push(`s1:${u}`); return ["linear"]; }, async (n) => { calls.push(`s1:${n}`); });
    const s2 = session("s2", () => ["lin", "lin-2"], async (n) => { calls.push(`s2:${n}`); });
    const s3 = session("s3", () => [], async (n) => { calls.push(`s3:${n}`); });
    const acted = await reconnectLiveSessionsFor({ list: () => [s1, s2, s3] }, url);
    expect(acted).toEqual(["s1", "s2"]);
    expect(asked).toEqual([`s1:${url}`]); // the URL is handed over as given: the session canonicalises it
    expect(calls).toEqual(["s1:linear", "s2:lin", "s2:lin-2"]);
  });

  test("a mid-turn child is reconnected at its idle boundary, never during the turn", async () => {
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const lines: string[] = [];
    const busy = session("busy", () => ["x"], async (n) => { calls.push(n); }, { turnRunning: true, idle: () => gate });
    const acted = await reconnectLiveSessionsFor({ list: () => [busy], log: (l) => lines.push(l) }, "https://mcp.example.test/mcp");
    expect(acted).toEqual(["busy"]);
    expect(calls).toEqual([]);
    expect(lines.some((l) => l.includes("next idle boundary"))).toBe(true);
    release();
    await gate;
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["x"]);
  });

  test("a rejected reconnect (a signed-out server is needs-auth now, or the child ended) is one log line, never a throw", async () => {
    const lines: string[] = [];
    class WinterLegUnsupported extends Error { override name = "WinterLegUnsupported"; }
    const rejecting = session("a", () => ["x"], async () => { throw new Error("needs-auth"); });
    const ended = session("b", () => ["x"], async () => { throw new WinterLegUnsupported("no live child"); });
    const acted = await reconnectLiveSessionsFor({ list: () => [rejecting, ended], log: (l) => lines.push(l) }, "https://mcp.example.test/mcp");
    expect(acted).toEqual(["a", "b"]);
    expect(lines.filter((l) => l.includes("did not connect"))).toHaveLength(2);
    expect(lines.some((l) => l.includes("WinterLegUnsupported"))).toBe(true);
  });

  test("the log line carries the error's code and message, not only its name (the live 2026-09-27 failure logged just 'WinterRpcError')", async () => {
    const lines: string[] = [];
    class WinterRpcError extends Error {
      override name = "WinterRpcError";
      constructor(readonly code: string, message: string) { super(message); }
    }
    const failing = session("s", () => ["github"], async () => { throw new WinterRpcError("mcp_reconnect_failed", "mcp client: the sign-in check exceeded 30000ms"); });
    await reconnectLiveSessionsFor({ list: () => [failing], log: (l) => lines.push(l) }, "https://mcp.example.test/mcp");
    expect(lines).toEqual(["mcp: s reconnected 'github', which did not connect (WinterRpcError mcp_reconnect_failed: mcp client: the sign-in check exceeded 30000ms)"]);
  });

  test("describeReconnectError masks token-shaped text, collapses whitespace and caps the length", () => {
    const masked = describeReconnectError(new Error("401 from https://x.test/cb?code=abc123&state=s1 with Bearer eyJhbGciOi.secret and\n refresh_token=rt-1"));
    expect(masked).not.toContain("abc123");
    expect(masked).not.toContain("eyJhbGciOi");
    expect(masked).not.toContain("rt-1");
    expect(masked).toContain("state=s1");
    expect(masked).not.toContain("\n");
    expect(describeReconnectError(new Error("x".repeat(1000))).length).toBeLessThan(300);
    expect(describeReconnectError("not an error")).toBe("unknown");
    expect(describeReconnectError(Object.assign(new Error(""), { name: "WinterLegUnsupported", code: "not_supported_on_winter_leg" }))).toBe("WinterLegUnsupported not_supported_on_winter_leg");
  });

  test("a session without the two methods (a test double) or whose lookup throws is skipped", async () => {
    const bare: ReconnectableSession = { sessionId: "bare", turnRunning: false, idle: async () => {} };
    const throwing = session("t", () => { throw new Error("gone"); }, async () => {});
    const namesOnly: ReconnectableSession = { sessionId: "n", turnRunning: false, idle: async () => {}, mcpServerNamesFor: () => ["x"] };
    expect(await reconnectLiveSessionsFor({ list: () => [bare, throwing, namesOnly] }, "https://mcp.example.test/mcp")).toEqual([]);
  });
});
