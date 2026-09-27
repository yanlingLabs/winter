// WS-26: `winter mcp permissions` — `mcp-cli.ts`'s route, with a scripted daemon door, and the no-daemon
// path against a temp WINTER_HOME's settings.json (never the user's).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { METHODS } from "@yanlinglabs/winter-protocol";
import { parseMcpPermissionsArgs, renderMcpPermissionsOutcome, runMcpPermissionsRoute, type McpAuthRpcDoor } from "../src/mcp-cli";

function scriptedDoor(handler: (method: string, params: any) => unknown): McpAuthRpcDoor & { calls: Array<{ method: string; params: any }> } {
  const calls: Array<{ method: string; params: any }> = [];
  return {
    calls,
    async request(method, params) {
      calls.push({ method, params });
      const r = handler(method, params);
      if (r instanceof Error) throw r;
      return r;
    },
    close() {},
  };
}

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "winter-cli-mcp-perms-"));
  writeFileSync(join(home, "settings.json"), JSON.stringify({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } }));
  return home;
}

describe("parseMcpPermissionsArgs", () => {
  test("list, one action, a verb for one action, a verb for every action", () => {
    expect(parseMcpPermissionsArgs(["cf"])).toEqual({ kind: "ok", parsed: { server: "cf" } });
    expect(parseMcpPermissionsArgs(["cf", "workers_list"])).toEqual({ kind: "ok", parsed: { server: "cf", tool: "workers_list" } });
    expect(parseMcpPermissionsArgs(["cf", "workers_list", "deny"])).toEqual({ kind: "ok", parsed: { server: "cf", tool: "workers_list", verb: "deny" } });
    expect(parseMcpPermissionsArgs(["cf", "ask"])).toEqual({ kind: "ok", parsed: { server: "cf", tool: "*", verb: "ask" } });
    expect(parseMcpPermissionsArgs(["cf", "*", "deny"])).toEqual({ kind: "ok", parsed: { server: "cf", tool: "*", verb: "deny" } });
  });

  test("usage errors: nothing, too much, an unknown verb, any flag", () => {
    for (const args of [[], ["a", "b", "c", "d"], ["cf", "x", "always"], ["cf", "-y"], ["cf", "*", "deny", "--reset"]]) {
      expect(parseMcpPermissionsArgs(args).kind).toBe("usageError");
    }
  });
});

describe("through the daemon", () => {
  test("a server-wide value clears per-action values (as the Mac's All actions does) and says so; one action does not", async () => {
    const door = scriptedDoor(() => ({ ok: true }));
    const out = await runMcpPermissionsRoute(["cf", "deny"], { door, winterHome: "/nowhere", cwd: "/work" });
    expect(door.calls).toEqual([{ method: METHODS.mcpSetToolPermission, params: { server: "cf", tool: "*", permission: "deny", resetTools: true } }]);
    expect(out).toEqual({ ok: true, kind: "set", via: "daemon", server: "cf", tool: "*", permission: "deny", reset: true });
    expect(renderMcpPermissionsOutcome(out)).toContain("every action of cf: Always deny (per-action values cleared)");
    await runMcpPermissionsRoute(["cf", "x", "allow"], { door, winterHome: "/nowhere", cwd: "/work" });
    expect(door.calls[1]).toEqual({ method: METHODS.mcpSetToolPermission, params: { server: "cf", tool: "x", permission: "allow" } });
    // Clearing the server-wide value leaves the per-action values alone, and says what then applies.
    const cleared = await runMcpPermissionsRoute(["cf", "*", "default"], { door, winterHome: "/nowhere", cwd: "/work" });
    expect(door.calls[2]).toEqual({ method: METHODS.mcpSetToolPermission, params: { server: "cf", tool: "*", permission: "default" } });
    expect(renderMcpPermissionsOutcome(cleared)).toContain("cf's all-actions value cleared — each action follows its own value");
  });

  test("a list renders each action with what applies and why", async () => {
    const door = scriptedDoor(() => ({ ok: true, servers: [{ name: "cf", status: "connected", listed: true, allTools: "ask", tools: [
      { name: "workers_list", toolName: "mcp__cf__workers_list", readOnly: true, permission: "allow", source: "default" },
      { name: "d1_delete", toolName: "mcp__cf__d1_delete", readOnly: false, permission: "deny", source: "rule", rules: [{ behavior: "deny", rule: "mcp__cf__d1_*" }, { behavior: "allow", rule: "mcp__cf__*" }] },
      { name: "kv_put", toolName: "mcp__cf__kv_put", readOnly: false, permission: "ask", source: "server" },
    ] }] }));
    const out = await runMcpPermissionsRoute(["cf"], { door, winterHome: "/nowhere", cwd: "/work" });
    expect(door.calls[0]).toEqual({ method: METHODS.mcpTools, params: { server: "cf", cwd: "/work" } });
    const text = renderMcpPermissionsOutcome(out);
    expect(text).toContain("cf  (connected)  all actions: Always ask");
    expect(text).toContain("workers_list  allow  — default: read-only");
    expect(text).toContain("d1_delete  deny  — deny rule in sdk/settings.json (mcp__cf__d1_*)");
    expect(text).toContain("sdk/settings.json allow rule mcp__cf__* (code sessions only)");
    expect(text).toContain("kv_put  ask  — set for all actions");
  });

  test("an unlisted server's sign-in hint names the command actually in use", async () => {
    const door = scriptedDoor(() => ({ ok: true, servers: [{ name: "cf", status: "failed", listed: false, tools: [] }] }));
    const out = await runMcpPermissionsRoute(["cf"], { door, winterHome: "/nowhere", cwd: "/work" });
    expect(renderMcpPermissionsOutcome(out)).toContain("needs a sign-in: winter mcp login cf)");
    expect(renderMcpPermissionsOutcome(out, "winter-dev")).toContain("needs a sign-in: winter-dev mcp login cf)");
  });

  test("a daemon refusal is reported, not thrown", async () => {
    const door = scriptedDoor(() => Object.assign(new Error("bad"), { rpc: { message: "\"winter\" names Winter's own capability servers, not a connector", data: {} } }));
    const out = await runMcpPermissionsRoute(["winter", "x", "deny"], { door, winterHome: "/nowhere", cwd: "/work" });
    expect(out.ok).toBe(false);
    expect(renderMcpPermissionsOutcome(out)).toContain("Winter's own capability servers");
  });
});

describe("with no daemon", () => {
  test("a set writes settings.json with the daemon's own transform; a list shows the stored values only", async () => {
    const home = tempHome();
    expect((await runMcpPermissionsRoute(["cf", "workers_delete", "deny"], { winterHome: home, cwd: "/work" })).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).mcp.toolPermissions).toEqual({ cf: { workers_delete: "deny" } });
    expect((await runMcpPermissionsRoute(["gh", "ask"], { winterHome: home, cwd: "/work" })).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).mcp.toolPermissions).toEqual({ cf: { workers_delete: "deny" }, gh: { "*": "ask" } });
    const list = await runMcpPermissionsRoute(["cf"], { winterHome: home, cwd: "/work" });
    const text = renderMcpPermissionsOutcome(list);
    expect(text).toContain("no daemon running");
    expect(text).toContain("workers_delete  deny  — set for this action");
    await runMcpPermissionsRoute(["cf", "deny"], { winterHome: home, cwd: "/work" });
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).mcp.toolPermissions).toEqual({ cf: { "*": "deny" }, gh: { "*": "ask" } });
  });

  test("Winter's own namespace is refused here too", async () => {
    const out = await runMcpPermissionsRoute(["winter", "x", "deny"], { winterHome: tempHome(), cwd: "/work" });
    expect(out.ok).toBe(false);
  });
});
