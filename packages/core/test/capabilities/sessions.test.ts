import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWinterMcpServerInstance, type WinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerListSessionsTools, LIST_SESSIONS_TOOL } from "../../src/agent/tools/list-sessions";
import { registerSessionSpawnTool } from "../../src/agent/tools/session-spawn";
import { makeActivityDeriver } from "../../src/sessions/activity";
import { SessionStore } from "../../src/sessions/store";
import { sessionsCapability } from "../../src/capabilities/sessions";
import type { CapabilitySession } from "../../src/capabilities/server";

/**
 * The `sessions` capability server (P8b Task 6).
 *
 * Both doors are built over ONE temp-home `SessionStore` and ONE set of deps, so "the capability
 * answers what the registry answers" is checked against the real other door rather than a
 * transcribed expectation. Never touches `~/.winter` — every store lives in a `mkdtemp` home.
 */

const NOW = 1_770_000_000_000;
const MODELS = ["gpt-5.6-terra", "terra"];

const homes: string[] = [];
afterEach(() => { for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }); });

interface Harness {
  home: string;
  store: SessionStore;
  registry: ToolRegistry;
  instance: WinterMcpServerInstance;
  session: CapabilitySession;
  deps: { models: string[]; sessions: never };
}

function harness(): Harness {
  const home = mkdtempSync(join(tmpdir(), "winter-cap-sessions-"));
  homes.push(home);
  const store = new SessionStore(home);
  const registry = new ToolRegistry();
  const h = {
    home, store, registry,
  } as Harness;
  h.session = {
    sessionId: "s_dispatch", mode: "dispatch", cwd: home, roots: [home],
  };
  const derive = makeActivityDeriver({
    attachedCount: () => 0,
    turnRunning: () => false,
    bgWork: () => false,
    lastEventTs: (id) => store.lastEventTs(id),
  });
  const sessionsDeps = {
    store,
    derive,
    turnStartedAt: () => undefined,
    now: () => NOW,
  };
  // Door 1 — the daemon's shared registry, wired exactly as `daemon.ts` wires it.
  registerSessionSpawnTool(registry, { models: MODELS });
  registerListSessionsTools(registry, sessionsDeps as never);
  // Door 2 — the capability server, over the SAME deps, built FOR THIS SESSION.
  h.deps = { models: MODELS, sessions: sessionsDeps as never };
  const server = sessionsCapability(h.session, h.deps);
  h.instance = server.instance as WinterMcpServerInstance;
  return h;
}

describe("sessionsCapability: the server shape", () => {
  test("is an `sdk` server named `sessions` with a callable instance", () => {
    const h = harness();
    const server = sessionsCapability(h.session, {
      models: MODELS,
      sessions: { store: h.store, derive: () => undefined, turnStartedAt: () => undefined } as never,
    });
    expect(server.type).toBe("sdk");
    // P8b-35: the BRAND rides the server name, so the router's `mcp__<server>__<tool>` comes out as
    // P8b-12's literal. `wire-names.test.ts` derives that rather than asserting it.
    expect(server.name).toBe("winter__sessions");
    // The router refuses a capability server whose instance is not duck-type callable, and the SDK
    // would forward it as wire-safe-but-inert. This is the exact predicate both use.
    expect(isWinterMcpServerInstance(server.instance)).toBe(true);
  });

  test("listTools names the two tools — manage_session was removed (user ruling 2026-10-02)", () => {
    const h = harness();
    expect(h.instance.listTools().map((t) => t.name).sort())
      .toEqual(["list_sessions", "session_spawn"]);
  });

  test("every advertised inputSchema is a JSON-Schema object (the router's construction gate)", () => {
    const h = harness();
    for (const tool of h.instance.listTools()) {
      expect(tool.inputSchema["type"]).toBe("object");
    }
  });

  test("listTools' schema and description are byte-identical to the registry's spec", () => {
    const h = harness();
    for (const tool of h.instance.listTools()) {
      const spec = h.registry.specFor(tool.name, undefined, "dispatch");
      expect(spec, `${tool.name} is not on the shared registry`).toBeDefined();
      expect(tool.description).toBe(spec!.description);
      expect(tool.inputSchema).toEqual(spec!.parameters as Record<string, unknown>);
    }
  });
});

describe("sessionsCapability: callTool", () => {
  test("list_sessions returns the SAME text the registry path returns, for two sessions", async () => {
    const h = harness();
    const one = h.store.createSession("global", { cwd: h.home, mode: "code" });
    const two = h.store.createSession("global", { cwd: h.home, mode: "code" });
    // The default listing shows what is going on — background sessions are.
    h.store.setBackgrounded(one, true);
    h.store.setBackgrounded(two, true);

    const viaRegistry = await h.registry.execute(LIST_SESSIONS_TOOL, {}, {
      cwd: h.home, roots: [h.home], sessionId: "s_dispatch", mode: "dispatch",
    });
    const viaCapability = await h.instance.callTool(LIST_SESSIONS_TOOL, {});

    expect(viaRegistry.isError).toBe(false);
    expect(viaCapability.isError).toBe(false);
    expect(viaCapability.content).toEqual([{ type: "text", text: viaRegistry.output }]);
    expect(viaRegistry.output).toContain(one);
    expect(viaRegistry.output).toContain(two);
  });

  test("session_spawn answers with its placeholder — the engine bridge is Task 13's", async () => {
    const h = harness();
    const res = await h.instance.callTool("session_spawn", { dir: "/tmp", prompt: "do a thing" });
    expect(res.isError).toBe(false);
    expect(res.content).toEqual([{ type: "text", text: "SpawnSession is only available in the dispatch session." }]);
  });

  test("an unknown tool is an isError result, never a throw", async () => {
    const h = harness();
    const res = await h.instance.callTool("no_such_tool", {});
    expect(res.isError).toBe(true);
    expect(res.content).toEqual([{ type: "text", text: "unknown tool: no_such_tool" }]);
  });

  test("invalid arguments are an isError result with the registry's own wording", async () => {
    const h = harness();
    const viaRegistry = await h.registry.execute(LIST_SESSIONS_TOOL, { query: 42 }, {
      cwd: h.home, roots: [h.home], sessionId: "s_dispatch", mode: "dispatch",
    });
    const viaCapability = await h.instance.callTool(LIST_SESSIONS_TOOL, { query: 42 });
    expect(viaRegistry.isError).toBe(true);
    expect(viaCapability.isError).toBe(true);
    expect(viaCapability.content).toEqual([{ type: "text", text: viaRegistry.output }]);
  });

  test("a tool that throws is an isError result (the registry's throw→isError conversion)", async () => {
    const h = harness();
    // A store that cannot be read → the tool throws inside; the server answers an error result.
    const broken = sessionsCapability(h.session, { models: MODELS, sessions: { store: { list: () => { throw new Error("index unreadable"); } }, derive: () => undefined, turnStartedAt: () => undefined } as never });
    const res = await (broken.instance as WinterMcpServerInstance).callTool(LIST_SESSIONS_TOOL, {});
    expect(res.isError).toBe(true);
    expect(res.content.length).toBe(1);
    // And the retired tool is simply unknown.
    expect((await h.instance.callTool("manage_session", { sessionId: "s_x", action: "stop" })).content).toEqual([{ type: "text", text: "unknown tool: manage_session" }]);
  });
});
