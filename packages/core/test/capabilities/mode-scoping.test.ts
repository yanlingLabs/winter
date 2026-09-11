import { describe, expect, test } from "bun:test";
import type { WinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";
import { PageCache } from "../../src/agent/tools/page-core";
import {
  CAPABILITY_SERVER_KEYS, NORMA_CAPABILITY_TOOLS,
  buildCapabilitiesFor, capabilityServerName, capabilityToolName,
  type CapabilityDeps, type CapabilityServerRecord, type CapabilitySession, type SessionMode,
} from "../../src/capabilities";

/**
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * P8b-37 — each per-session server serves ONLY the tools this session's mode is offered
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * P8b-12 assigned mode scoping to Task 9's per-mode `disallowedTools`, on the premise of a
 * construction-time, mode-blind capability set. P8b-36 retired that premise, and C1 showed why a
 * string list alone is not enough: a `disallowedTools` entry naming a tool the child never
 * registered denies nothing, silently, with every test green.
 *
 * So the filter is structural, and this file is its proof — for every server, in every mode, in both
 * directions (advertised AND executable). The sharpest case is the first one: without the filter a
 * CHAT session's `sessions` server would serve `manage_session`, which can background, archive or
 * interrupt any session on the Mac by id.
 */

const SESSION: CapabilitySession = { sessionId: "s_mode", mode: "code", cwd: "/tmp", roots: ["/tmp"] };

function deps(): CapabilityDeps {
  const panel = { dispatch: () => ({ commandId: "c", settled: Promise.resolve({ kind: "timeout" as const, deadlineMs: 1 }) }), harnesses: () => [] };
  return {
    sessions: { models: [], sessions: { store: { list: () => [], lastEventTs: () => 0, transcriptPath: () => "" } } as never },
    computer: { computerUse: () => undefined },
    computerUseEnabled: () => true,
    browser: { browser: { tabs: () => ({ tabs: [], activeTabId: undefined }) as never, openTab: () => "t", ...panel } },
    office: { office: { ...panel, dirsOf: () => [] as never } },
    research: { search: {}, readPage: { cache: new PageCache() } },
    web: { web: {} },
    lsp: { lsp: () => undefined },
  };
}

function serversFor(mode: SessionMode): CapabilityServerRecord {
  return buildCapabilitiesFor({ ...SESSION, mode }, deps());
}

function toolsOf(record: CapabilityServerRecord, key: string): string[] {
  const server = record[capabilityServerName(key)];
  expect(server, `no server for key "${key}"`).toBeDefined();
  return (server!.instance as WinterMcpServerInstance).listTools().map((t) => t.name).sort();
}

/** What the TABLE says this key serves in this mode — the same source `capabilityServer` filters on
 *  and Task 9 derives `CAPABILITY_TOOL_MODES` from. Derived, never pasted. */
function expectedToolsOf(key: string, mode: SessionMode): string[] {
  return Object.entries(NORMA_CAPABILITY_TOOLS)
    .filter(([name, facts]) => name.startsWith(`mcp__norma__${key}__`) && (facts.modes as readonly string[]).includes(mode))
    .map(([name]) => name.slice(`mcp__norma__${key}__`.length))
    .sort();
}

describe("P8b-37: what each server ADVERTISES follows the session's mode", () => {
  test("a chat session's `sessions` server lists nothing — manage_session is unreachable", () => {
    expect(toolsOf(serversFor("chat"), "sessions")).toEqual([]);
    expect(toolsOf(serversFor("code"), "sessions")).toEqual([]);
    // Dispatch is the mode that actually owns the fleet surface.
    expect(toolsOf(serversFor("dispatch"), "sessions")).toEqual(["list_sessions", "manage_session", "session_spawn"]);
  });

  test("a chat session's `web` server lists nothing; `research` lists Search and ReadPage", () => {
    expect(toolsOf(serversFor("chat"), "web")).toEqual([]);
    expect(toolsOf(serversFor("chat"), "research")).toEqual(["ReadPage", "Search"]);
    // And the mirror image: code gets the web pair and none of the chat research surface.
    expect(toolsOf(serversFor("code"), "web")).toEqual(["web_fetch", "web_search"]);
    expect(toolsOf(serversFor("code"), "research")).toEqual([]);
  });

  test("`computer` and `office` are code+dispatch only; `browser` is in all three", () => {
    for (const mode of ["code", "dispatch"] as const) {
      expect(toolsOf(serversFor(mode), "computer")).toEqual(["computer"]);
      expect(toolsOf(serversFor(mode), "office")).toEqual(["docs", "sheets", "slides"]);
    }
    expect(toolsOf(serversFor("chat"), "computer")).toEqual([]);
    expect(toolsOf(serversFor("chat"), "office")).toEqual([]);
    for (const mode of ["code", "dispatch", "chat"] as const) {
      expect(toolsOf(serversFor(mode), "browser")).toEqual(["browser"]);
    }
  });

  test("every server in every mode advertises exactly what the table says it should", () => {
    for (const mode of ["code", "dispatch", "chat"] as const) {
      for (const key of CAPABILITY_SERVER_KEYS) {
        expect(toolsOf(serversFor(mode), key), `${key} in ${mode}`).toEqual(expectedToolsOf(key, mode));
      }
    }
  });
});

describe("P8b-37: what each server EXECUTES follows the session's mode", () => {
  async function call(mode: SessionMode, key: string, tool: string, args: Record<string, unknown> = {}) {
    const server = serversFor(mode)[capabilityServerName(key)]!;
    return (server.instance as WinterMcpServerInstance).callTool(tool, args);
  }

  test("a chat session cannot EXECUTE manage_session, even naming it directly", async () => {
    // Advertisement is not the gate — the model can send any name it likes. A filtered-out tool must
    // be indistinguishable from one that does not exist, which is what the registry tells a mode
    // that was never offered it.
    const res = await call("chat", "sessions", "manage_session", { sessionId: "s_victim", action: "stop" });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual([{ type: "text", text: "unknown tool: manage_session" }]);
  });

  test("a chat session cannot EXECUTE web_fetch, and a code session cannot execute Search", async () => {
    const fetched = await call("chat", "web", "web_fetch", { url: "https://example.com" });
    expect(fetched.isError).toBe(true);
    expect(fetched.content).toEqual([{ type: "text", text: "unknown tool: web_fetch" }]);
    const searched = await call("code", "research", "Search", { query: "anything" });
    expect(searched.isError).toBe(true);
    expect(searched.content).toEqual([{ type: "text", text: "unknown tool: Search" }]);
  });

  test("a dispatch session CAN execute the sessions surface — the filter is not a blanket deny", async () => {
    const res = await call("dispatch", "sessions", "list_sessions", {});
    expect(res.isError).toBe(false);
  });

  test("no tool is executable in a mode the table does not grant it", async () => {
    for (const mode of ["code", "dispatch", "chat"] as const) {
      for (const key of CAPABILITY_SERVER_KEYS) {
        for (const [wire, facts] of Object.entries(NORMA_CAPABILITY_TOOLS)) {
          const prefix = `mcp__norma__${key}__`;
          if (!wire.startsWith(prefix)) continue;
          const tool = wire.slice(prefix.length);
          if ((facts.modes as readonly string[]).includes(mode)) continue;
          const res = await call(mode, key, tool);
          expect(res.isError, `${wire} was executable in ${mode}`).toBe(true);
          expect((res.content[0] as { text: string }).text).toBe(`unknown tool: ${tool}`);
        }
      }
    }
  });
});

describe("P8b-37: the filter and the name table cannot disagree", () => {
  test("the union over all three modes is exactly the table", () => {
    const seen = new Set<string>();
    for (const mode of ["code", "dispatch", "chat"] as const) {
      for (const key of CAPABILITY_SERVER_KEYS) {
        for (const tool of toolsOf(serversFor(mode), key)) seen.add(capabilityToolName(key, tool));
      }
    }
    expect([...seen].sort()).toEqual(Object.keys(NORMA_CAPABILITY_TOOLS).sort());
  });

  test("every server key still exists in every mode, even when it serves nothing", () => {
    // The record's key set depends only on `CAPABILITY_SERVER_KEYS` and the computer-use setting, so
    // Task 16 and the tests never have to special-case a missing server. An empty one is inert.
    for (const mode of ["code", "dispatch", "chat"] as const) {
      expect(Object.keys(serversFor(mode)).sort())
        .toEqual(CAPABILITY_SERVER_KEYS.map(capabilityServerName).sort());
    }
  });
});
