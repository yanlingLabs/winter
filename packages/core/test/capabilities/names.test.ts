import { describe, expect, test } from "bun:test";
import { CORE_BRAND } from "../../src/runtime-sdk/brand";
import type { ToolDefinition } from "../../src/agent/tools/registry";
import { browserToolDefs } from "../../src/agent/tools/browser";
import { computerToolDefs } from "../../src/agent/tools/computer";
import { docsToolDefs } from "../../src/agent/tools/docs";
import { listSessionsToolDefs } from "../../src/agent/tools/list-sessions";
import { sessionSpawnToolDefs } from "../../src/agent/tools/session-spawn";
import { sheetsToolDefs } from "../../src/agent/tools/sheets";
import { slidesToolDefs } from "../../src/agent/tools/slides";
import { lspToolDefs } from "../../src/agent/tools/lsp";
import {
  CAPABILITY_SERVER_KEYS,
  RETIRED_CAPABILITY_SERVER_KEYS,
  WINTER_CAPABILITY_TOOLS,
  capabilityAdvertisedName,
  capabilityServerName,
  capabilityToolName,
  reservedMcpServerNames,
  type CapabilityToolFacts,
} from "../../src/capabilities/names";

/**
 * P8b-12 — the canonical capability tool names, and (the 2026-10-01 tool-surface ruling) the plain names
 * the model sees them under and which of them load up front.
 *
 * The literals below are PASTED, not derived: this file's whole job is to prove that the table in
 * `names.ts` and the function that builds a name agree, so deriving the expectation from the thing
 * under test would prove nothing. `mcpToolName` is two-arg (Task 5's measurement), so the
 * `<server>__<tool>` join happens in `capabilityToolName` — which is exactly the step that could
 * silently produce `mcp__winter__list_sessions` instead.
 */

/** WS-06 §5's names for the P8b-12 servers. Spelled out, never derived. `ReadPage` and the `web`
 *  server's `web_fetch`/`web_search` left on 2026-09-18; the `research` server's `Search` on 2026-10-01
 *  (it is the agent SDK's built-in now). */
const CANONICAL_NAMES = [
  // WS-06 §5 `mcp__winter__sessions` → R-1 re-brands the namespace, C-6 splits the three verbs out.
  "mcp__winter__sessions__session_spawn",
  "mcp__winter__sessions__list_sessions",
  // WS-06 §5 `mcp__winter__computer`.
  "mcp__winter__computer__computer",
  // WS-06 §5 `mcp__winter__browser`.
  "mcp__winter__browser__browser",
  // WS-06 §5 `mcp__winter__docs` / `sheets` / `slides`, folded onto ONE `office` server (P8b-12).
  "mcp__winter__office__docs",
  "mcp__winter__office__sheets",
  "mcp__winter__office__slides",
  // Fix wave (review F7): the single multi-purpose `lsp` tool, reinstated as a capability.
  "mcp__winter__lsp__lsp",
] as const;

describe("capabilityToolName (P8b-12)", () => {
  test("builds the literal mcp__winter__<key>__<tool> form", () => {
    expect(capabilityToolName("sessions", "session_spawn")).toBe("mcp__winter__sessions__session_spawn");
    expect(capabilityToolName("computer", "computer")).toBe("mcp__winter__computer__computer");
    expect(capabilityToolName("research", "Search")).toBe("mcp__winter__research__Search");
  });

  // Since P9b-7 the daemon's own MCP namespace IS `winter` (`CORE_BRAND.mcpServerName`). What still has
  // to hold (R-1, `capabilityServerName`'s own doc) is narrower: a capability SERVER's `winter__<key>`
  // name can never equal the BARE brand name `"winter"` itself, which the router reserves for its
  // standing messaging server — the `__<key>` suffix is what guarantees that.
  test("is branded `winter`; a capability server name never collides with the bare brand (R-1)", () => {
    expect(CORE_BRAND.mcpServerName).toBe("winter");
    for (const key of CAPABILITY_SERVER_KEYS) {
      expect(capabilityServerName(key)).not.toBe(CORE_BRAND.mcpServerName);
    }
    for (const name of Object.keys(WINTER_CAPABILITY_TOOLS)) {
      expect(name.startsWith("mcp__winter__")).toBe(true);
    }
  });

  test("the RETIRED server names stay reserved: their old tool spellings still strip to host names", () => {
    expect([...RETIRED_CAPABILITY_SERVER_KEYS].sort()).toEqual(["research", "web"]);
    for (const key of RETIRED_CAPABILITY_SERVER_KEYS) {
      expect(CAPABILITY_SERVER_KEYS as readonly string[]).not.toContain(key);
      expect(reservedMcpServerNames().has(capabilityServerName(key))).toBe(true);
    }
  });
});

describe("WINTER_CAPABILITY_TOOLS", () => {
  test("every name matches the P8b-12 shape", () => {
    for (const name of Object.keys(WINTER_CAPABILITY_TOOLS)) {
      expect(name).toMatch(/^mcp__winter__[a-z]+__[A-Za-z_]+$/);
    }
  });

  test("every key equals capabilityToolName(serverKey, tool) for a declared server key", () => {
    for (const name of Object.keys(WINTER_CAPABILITY_TOOLS)) {
      const rest = name.slice("mcp__winter__".length);
      const key = CAPABILITY_SERVER_KEYS.find((k) => rest.startsWith(`${k}__`));
      expect(key, `${name} names no declared capability server`).toBeDefined();
      const tool = rest.slice(`${key!}__`.length);
      expect(capabilityToolName(key!, tool)).toBe(name);
    }
  });

  test("carries exactly the canonical names — no more, no fewer", () => {
    expect(Object.keys(WINTER_CAPABILITY_TOOLS).sort()).toEqual([...CANONICAL_NAMES].sort());
  });

  test("every declared server key with a STATIC tool set is represented, and every name names a declared key", () => {
    const keysUsed = new Set(Object.keys(WINTER_CAPABILITY_TOOLS).map((n) => n.slice("mcp__winter__".length).split("__")[0]));
    // `external` is a declared server key with NO row here, deliberately — its tool set is per-plugin
    // and runtime-defined, so mode-scoping for it lives on each `ExternalToolSource.modes` instead.
    const staticKeys = CAPABILITY_SERVER_KEYS.filter((k) => k !== "external");
    expect([...keysUsed].sort()).toEqual([...staticKeys].sort());
  });

  test("m1: modes are pinned against the REAL ToolDefinitions, not against comments", () => {
    // The table is the exposure source Task 9 derives `disallowedTools` from, and the one the servers
    // filter by. Pinned against pasted literals it desyncs SILENTLY the day someone edits a tool's own
    // `modes`, so the defs are built here and compared field for field. (The defs' engine-era
    // `deferred` fields are not compared: deferral is the table's `eager`, read by the servers.)
    const panel = { dispatch: () => ({ commandId: "c", settled: Promise.resolve({ kind: "timeout" as const, deadlineMs: 1 }) }), harnesses: () => [] };
    const defsByKey: Record<string, readonly ToolDefinition[]> = {
      sessions: [...sessionSpawnToolDefs(), ...listSessionsToolDefs({ store: { list: () => [], lastEventTs: () => 0, transcriptPath: () => "" } } as never)],
      computer: computerToolDefs(),
      browser: browserToolDefs({ tabs: () => ({ tabs: [], activeTabId: undefined }) as never, openTab: () => "t", ...panel }),
      office: [
        ...docsToolDefs({ ...panel, dirsOf: () => [] as never }),
        ...sheetsToolDefs({ ...panel, dirsOf: () => [] as never }),
        ...slidesToolDefs({ ...panel, dirsOf: () => [] as never }),
      ],
      lsp: lspToolDefs({ lsp: () => undefined, cwdOf: () => undefined, rootsOf: () => [] }),
    };
    const t = WINTER_CAPABILITY_TOOLS as Readonly<Record<string, CapabilityToolFacts>>;
    let checked = 0;
    for (const [key, defs] of Object.entries(defsByKey)) {
      for (const def of defs) {
        const name = capabilityToolName(key, def.name);
        const facts = t[name];
        expect(facts, `${name} is missing from WINTER_CAPABILITY_TOOLS`).toBeDefined();
        // `modes` absent on a def means `["code"]` (registry.ts's own documented default).
        expect([...facts!.modes].sort()).toEqual([...(def.modes ?? ["code"])].sort());
        checked++;
      }
    }
    // Every row was reached — a def that stopped being built would otherwise pass by absence.
    expect(checked).toBe(Object.keys(WINTER_CAPABILITY_TOOLS).length);
  });

  test("the 2026-10-01 ruling: plain names, the eager sessions trio, everything else deferred, office code-only", () => {
    const t = WINTER_CAPABILITY_TOOLS as Readonly<Record<string, CapabilityToolFacts>>;
    expect(t["mcp__winter__sessions__session_spawn"]).toEqual({ modes: ["dispatch"], plainName: "SpawnSession", eager: true });
    expect(t["mcp__winter__sessions__list_sessions"]).toEqual({ modes: ["dispatch"], plainName: "ListSessions", eager: true });
    // ManageSession was removed from Dispatch (user ruling 2026-10-02).
    expect(t["mcp__winter__sessions__manage_session"]).toBeUndefined();
    expect(t["mcp__winter__computer__computer"]).toEqual({ modes: ["code", "dispatch"], plainName: "Computer" });
    expect(t["mcp__winter__browser__browser"]).toEqual({ modes: ["code", "dispatch", "chat"], plainName: "Browser" });
    for (const tool of ["docs", "sheets", "slides"]) {
      expect(t[`mcp__winter__office__${tool}`]).toEqual({ modes: ["code"] });
    }
    expect(t["mcp__winter__lsp__lsp"]).toEqual({ modes: ["code"] });
    // …and the retired rows are GONE, which is the half a positive assertion cannot state.
    for (const gone of ["mcp__winter__research__Search", "mcp__winter__research__ReadPage", "mcp__winter__web__web_fetch", "mcp__winter__web__web_search"]) {
      expect(t[gone], `${gone} is retired and must not be in the table`).toBeUndefined();
    }
    // The name the child knows each by.
    expect(capabilityAdvertisedName("mcp__winter__browser__browser")).toBe("Browser");
    expect(capabilityAdvertisedName("mcp__winter__office__docs")).toBe("mcp__winter__office__docs");
  });

  test("is a plain data table Task 9 can diff (no functions, no getters)", () => {
    for (const [name, facts] of Object.entries(WINTER_CAPABILITY_TOOLS as Readonly<Record<string, CapabilityToolFacts>>)) {
      expect(Object.getOwnPropertyDescriptor(WINTER_CAPABILITY_TOOLS, name)?.get).toBeUndefined();
      expect(Array.isArray(facts.modes)).toBe(true);
      for (const mode of facts.modes) expect(["code", "dispatch", "chat"]).toContain(mode);
    }
  });
});
