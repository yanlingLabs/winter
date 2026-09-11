import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isWinterMcpServerInstance, type McpSdkServerConfigWithInstance, type Options, type WinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../../src/auth/secret-store";
import { PageCache } from "../../src/agent/tools/page-core";
import { createNormaRuntimeSdk, type NormaRuntimeSdk } from "../../src/runtime-sdk/create";
import {
  CAPABILITY_SERVER_KEYS, NORMA_CAPABILITY_TOOLS,
  assertNoCapabilityCollision, buildCapabilitiesFor, capabilityServerName, capabilityToolName,
  CapabilityNameCollisionError,
  type CapabilityDeps, type CapabilityServerRecord, type CapabilitySession,
} from "../../src/capabilities";

/**
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * C1 / P8b-35 — THE WIRE NAMES, DERIVED RATHER THAN PASTED
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `names.test.ts` asserts that the table and `capabilityToolName` agree with each other. That is not
 * enough, and the reason is the defect this file exists to prevent: two copies of the same WRONG
 * string agree perfectly. The first cut of this batch declared its servers `name: "sessions"`, which
 * a child reaches as `mcp__sessions__list_sessions` — one segment short of every literal in the
 * table — and nothing failed anywhere, because Task 9's planned tripwire diffs
 * `CAPABILITY_TOOL_MODES` against `NORMA_CAPABILITY_TOOLS`, i.e. copy against copy.
 *
 * So this file derives the name from THE SERVER OBJECT THE ROUTER RECEIVES, through the router's own
 * naming path, and asserts the derived name is the one the table carries. It fails on the old code
 * and passes on the new, which is the only property that makes the table trustworthy for Task 9 and
 * for P8b-25's `normaToolNameFor`.
 *
 * THE ROUTER'S PATH, from the installed `winter-runtime-sdk/dist` (primary source):
 *   * `record[server.name] = server` keys the capability record by the server's own name;
 *   * `mergedMcpServers(...)` merges it into the forwarded `Options.mcpServers` under that key;
 *   * `capabilityServerDescriptor` builds `{ name: server.name, tools: [{ tool: tool.name, … }] }`;
 *   * `door.d.ts`: "PER SERVER, UNDER ITS OWN NAME, so `mcp__<server>__<tool>` is the same canonical
 *     name on both legs".
 *
 * The router does not expose its descriptor record, so the last observable step is read through the
 * guard that IS keyed by it: a query whose own `mcpServers` collides with a capability name is
 * refused, naming that capability. That probe runs before the leg is picked and before anything is
 * spawned, so no child process is created anywhere in this file.
 */

let home: string;
let handles: NormaRuntimeSdk[];

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "p8b-wire-names-")); handles = []; });
afterEach(async () => {
  for (const h of handles) await h.dispose();
  rmSync(home, { recursive: true, force: true });
});

const SESSION: CapabilitySession = { sessionId: "s_wire", mode: "code", cwd: "/tmp", roots: ["/tmp"] };

/** Deps that reach no network, no store and no app — this file is about NAMES. */
function deps(): CapabilityDeps {
  const panel = { dispatch: () => ({ commandId: "c", settled: Promise.resolve({ kind: "timeout" as const, deadlineMs: 1 }) }), harnesses: () => [] };
  return {
    sessions: { models: [], sessions: { store: { list: () => [], lastEventTs: () => 0, transcriptPath: () => "" } } as never },
    computer: { computerUse: () => undefined },
    computerUseEnabled: () => true, // every server, so every name is covered
    browser: { browser: { tabs: () => ({ tabs: [], activeTabId: undefined }) as never, openTab: () => "t", ...panel } },
    office: { office: { ...panel, dirsOf: () => [] as never } },
    research: { search: {}, readPage: { cache: new PageCache() } },
    web: { web: {} },
  };
}

function serversFor(mode: CapabilitySession["mode"]): CapabilityServerRecord {
  return buildCapabilitiesFor({ ...SESSION, mode }, deps());
}

/**
 * THE LAST HOP (N1). P8b-36 hands the servers to the child through `Options.mcpServers`, and on that
 * path the wire name comes from the RECORD KEY, not from the config's `name` field:
 * `toWireMcpServers` iterates `Object.entries(servers)` and keys its output by that key, and
 * `makeSdkMcpCallHandler` dispatches `sdk_mcp_call` by `mcpServers[req.server]` — the key again.
 * This walks an `Options` object the way the SDK does, so the derivation covers the path 8b actually
 * takes rather than only the router's `capabilities` path.
 */
function wireNamesFromOptions(options: Pick<Options, "mcpServers">): string[] {
  const out: string[] = [];
  for (const [key, cfg] of Object.entries(options.mcpServers ?? {})) {
    if (cfg.type !== "sdk" || !isWinterMcpServerInstance(cfg.instance)) continue;
    // `toWireMcpServers` sends `tools: cfg.instance.listTools()` under this KEY; the child names
    // each of them `mcp__<key>__<tool>`.
    for (const tool of cfg.instance.listTools()) out.push(`mcp__${key}__${tool.name}`);
  }
  return out;
}

describe("P8b-35: the wire name a child sees is the name the table carries", () => {
  test("every server/tool pair derives to exactly its NORMA_CAPABILITY_TOOLS key", () => {
    const derived = new Set<string>();
    // Across ALL THREE MODES, because P8b-37 now filters each server's tools by the session's mode —
    // no single session sees every tool, and the table describes the union.
    for (const mode of ["code", "dispatch", "chat"] as const) {
      const record = serversFor(mode);
      for (const key of CAPABILITY_SERVER_KEYS) {
        const server = record[capabilityServerName(key)];
        expect(server, `no capability server was built for key "${key}" in ${mode}`).toBeDefined();
        for (const tool of (server!.instance as WinterMcpServerInstance).listTools()) {
          // THE DERIVATION — the router's `mcp__<server>__<tool>`, built from the server object it is
          // handed, with nothing pasted. This is the assertion that fails if the brand segment is
          // not on the server's name.
          const wire = `mcp__${server!.name}__${tool.name}`;
          expect(wire).toBe(capabilityToolName(key, tool.name));
          expect(NORMA_CAPABILITY_TOOLS, `${wire} is not in the table`).toHaveProperty(wire);
          derived.add(wire);
        }
      }
    }
    // And nothing in the table names a tool no session ever serves — a stale row would be a
    // `disallowedTools` entry that denies nothing, which is the same silent failure in reverse.
    expect([...derived].sort()).toEqual(Object.keys(NORMA_CAPABILITY_TOOLS).sort());
  });

  test("N1: the same names come out of the `Options.mcpServers` path, walked as the SDK walks it", () => {
    const derived = new Set<string>();
    for (const mode of ["code", "dispatch", "chat"] as const) {
      // The record IS `Options.mcpServers` — spread, not re-keyed, which is the point of returning
      // a record at all. A driver that re-keyed it would show up right here.
      for (const wire of wireNamesFromOptions({ mcpServers: { ...serversFor(mode) } })) {
        expect(NORMA_CAPABILITY_TOOLS, `${wire} is not in the table`).toHaveProperty(wire);
        derived.add(wire);
      }
    }
    expect([...derived].sort()).toEqual(Object.keys(NORMA_CAPABILITY_TOOLS).sort());
  });

  test("N1: every record KEY equals its config's own name — mis-keying is unrepresentable", () => {
    const record = serversFor("code");
    for (const [key, cfg] of Object.entries(record)) expect(key).toBe(cfg.name);
    expect(Object.keys(record).sort()).toEqual(CAPABILITY_SERVER_KEYS.map(capabilityServerName).sort());
  });

  test("the server name carries the brand, and can never shadow the standing messaging server", () => {
    for (const key of CAPABILITY_SERVER_KEYS) {
      const name = capabilityServerName(key);
      expect(name.startsWith("norma__")).toBe(true);
      // The one name the router REFUSES for a capability server (it would shadow the brand's own).
      expect(name).not.toBe("norma");
    }
  });

  test("a `norma`-less server name would produce the WRONG wire name — the defect this pins", () => {
    // The shape of the regression, stated as an assertion rather than a comment: had the server
    // been declared with the bare key, the derived name would be one segment short of the table's.
    for (const key of CAPABILITY_SERVER_KEYS) {
      expect(`mcp__${key}__x`).not.toBe(capabilityToolName(key, "x"));
    }
  });
});

describe("N2: assertNoCapabilityCollision — the guard the router no longer runs for us", () => {
  test("a caller's server colliding with a daemon-owned name is REFUSED, naming it", () => {
    const owned = serversFor("code");
    const plugin = { "norma__browser": { type: "sdk" as const, name: "norma__browser", instance: {} } };
    expect(() => assertNoCapabilityCollision(plugin, owned)).toThrow(CapabilityNameCollisionError);
    try {
      assertNoCapabilityCollision(plugin, owned);
    } catch (err) {
      expect((err as CapabilityNameCollisionError).server).toBe("norma__browser");
      expect((err as { code?: string }).code).toBe("capability_name_collision");
    }
  });

  test("non-colliding servers, an empty record and `undefined` all pass", () => {
    const owned = serversFor("code");
    expect(() => assertNoCapabilityCollision({ "some-plugin": {} }, owned)).not.toThrow();
    expect(() => assertNoCapabilityCollision({}, owned)).not.toThrow();
    expect(() => assertNoCapabilityCollision(undefined, owned)).not.toThrow();
  });

  test("it accepts a bare name list as well as the record", () => {
    expect(() => assertNoCapabilityCollision({ "norma__web": {} }, ["norma__web"])).toThrow(CapabilityNameCollisionError);
    expect(() => assertNoCapabilityCollision({ "norma__web": {} }, ["norma__browser"])).not.toThrow();
  });
});

describe("P8b-35: the REAL router accepts these servers and keys them by their own name", () => {
  async function handle(capabilities: readonly McpSdkServerConfigWithInstance[]): Promise<NormaRuntimeSdk> {
    const h = await createNormaRuntimeSdk({
      home,
      settings: () => null,
      secrets: new FileSecretStore(join(home, "secrets")),
      capabilities,
    });
    handles.push(h);
    return h;
  }

  /** The router's capability record, read through the guard that is keyed by it. Throws before the
   *  leg is picked, so nothing is spawned. */
  function routerHolds(h: NormaRuntimeSdk, name: string): boolean {
    const abortController = new AbortController();
    abortController.abort();
    try {
      h.sdk.query({ prompt: "unreachable", options: { abortController, mcpServers: { [name]: { type: "sdk", name, instance: {} } } } });
      return false;
    } catch (err) {
      return (err as Error).message.includes("is the name of a capability server this handle forwards");
    }
  }

  test("createRuntimeSdk accepts all six (so every advertised inputSchema passed its validator)", async () => {
    // `capabilityServerDescriptors` runs at CONSTRUCTION even on a Winter-only host: it calls every
    // `instance.listTools()` and refuses any tool whose `inputSchema` is not a JSON-Schema object.
    // Constructing without a throw IS that proof.
    const built = Object.values(serversFor("code"));
    expect(built.length).toBe(CAPABILITY_SERVER_KEYS.length);
    for (const s of built) expect(isWinterMcpServerInstance(s.instance)).toBe(true);
    const h = await handle(built);
    expect(h.sdk.brand.mcpServerName).toBe("norma");
  });

  test("the router keys each capability by `server.name` — the input to the wire name", async () => {
    const h = await handle(Object.values(serversFor("code")));
    for (const key of CAPABILITY_SERVER_KEYS) {
      expect(routerHolds(h, capabilityServerName(key)), `${capabilityServerName(key)} is not in the router's record`).toBe(true);
      // The bare key is NOT what the router holds — which is exactly why it must not be the name.
      expect(routerHolds(h, key)).toBe(false);
    }
  });
});
