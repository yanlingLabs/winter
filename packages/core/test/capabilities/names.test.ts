import { describe, expect, test } from "bun:test";
import { NORMA_BRAND } from "../../src/runtime-sdk/brand";
import type { ToolDefinition } from "../../src/agent/tools/registry";
import { browserToolDefs } from "../../src/agent/tools/browser";
import { computerToolDefs } from "../../src/agent/tools/computer";
import { docsToolDefs } from "../../src/agent/tools/docs";
import { listSessionsToolDefs } from "../../src/agent/tools/list-sessions";
import { PageCache } from "../../src/agent/tools/page-core";
import { readPageToolDefs } from "../../src/agent/tools/read-page";
import { searchToolDefs } from "../../src/agent/tools/search";
import { sessionSpawnToolDefs } from "../../src/agent/tools/session-spawn";
import { sheetsToolDefs } from "../../src/agent/tools/sheets";
import { slidesToolDefs } from "../../src/agent/tools/slides";
import { webToolDefs } from "../../src/agent/tools/web";
import {
  CAPABILITY_SERVER_KEYS,
  NORMA_CAPABILITY_TOOLS,
  capabilityToolName,
  type CapabilityToolFacts,
} from "../../src/capabilities/names";

/**
 * P8b-12 — the canonical capability tool names.
 *
 * The literals below are PASTED, not derived: this file's whole job is to prove that the table in
 * `names.ts` and the function that builds a name agree, so deriving the expectation from the thing
 * under test would prove nothing. `mcpToolName` is two-arg (Task 5's measurement), so the
 * `<server>__<tool>` join happens in `capabilityToolName` — which is exactly the step that could
 * silently produce `mcp__norma__list_sessions` instead.
 */

/** WS-06 §5's names for the five P8b-12 servers, plus the C-6 amendment (`Search`/`ReadPage` under
 *  `research`) and ruling P8b-33's sixth server (`web`). Spelled out, never derived. */
const CANONICAL_NAMES = [
  // WS-06 §5 `mcp__winter__sessions` → R-1 re-brands the namespace, C-6 splits the three verbs out.
  "mcp__norma__sessions__session_spawn",
  "mcp__norma__sessions__list_sessions",
  "mcp__norma__sessions__manage_session",
  // WS-06 §5 `mcp__winter__computer`.
  "mcp__norma__computer__computer",
  // WS-06 §5 `mcp__winter__browser`.
  "mcp__norma__browser__browser",
  // WS-06 §5 `mcp__winter__docs` / `sheets` / `slides`, folded onto ONE `office` server (P8b-12).
  "mcp__norma__office__docs",
  "mcp__norma__office__sheets",
  "mcp__norma__office__slides",
  // C-6 AMENDMENT to WS-06 §5: Search/ReadPage are daemon-owned capability tools (they carry the
  // Exa key and the dangerous-domain floor), NOT the SDK's WebSearch/WebFetch.
  "mcp__norma__research__Search",
  "mcp__norma__research__ReadPage",
  // P8b-33: every mode disallows the SDK's built-in web tools, so code keeps its own pair.
  "mcp__norma__web__web_fetch",
  "mcp__norma__web__web_search",
] as const;

describe("capabilityToolName (P8b-12)", () => {
  test("builds the literal mcp__norma__<key>__<tool> form", () => {
    expect(capabilityToolName("sessions", "session_spawn")).toBe("mcp__norma__sessions__session_spawn");
    expect(capabilityToolName("computer", "computer")).toBe("mcp__norma__computer__computer");
    expect(capabilityToolName("research", "ReadPage")).toBe("mcp__norma__research__ReadPage");
  });

  test("is branded `norma`, never `winter` (R-1)", () => {
    expect(NORMA_BRAND.mcpServerName).toBe("norma");
    for (const name of Object.keys(NORMA_CAPABILITY_TOOLS)) {
      expect(name.startsWith("mcp__norma__")).toBe(true);
      expect(name).not.toContain("winter");
    }
  });
});

describe("NORMA_CAPABILITY_TOOLS", () => {
  test("every name matches the P8b-12 shape", () => {
    for (const name of Object.keys(NORMA_CAPABILITY_TOOLS)) {
      expect(name).toMatch(/^mcp__norma__[a-z]+__[A-Za-z_]+$/);
    }
  });

  test("every key equals capabilityToolName(serverKey, tool) for a declared server key", () => {
    for (const name of Object.keys(NORMA_CAPABILITY_TOOLS)) {
      const rest = name.slice("mcp__norma__".length);
      const key = CAPABILITY_SERVER_KEYS.find((k) => rest.startsWith(`${k}__`));
      expect(key, `${name} names no declared capability server`).toBeDefined();
      const tool = rest.slice(`${key!}__`.length);
      expect(capabilityToolName(key!, tool)).toBe(name);
    }
  });

  test("carries exactly the canonical names — no more, no fewer", () => {
    expect(Object.keys(NORMA_CAPABILITY_TOOLS).sort()).toEqual([...CANONICAL_NAMES].sort());
  });

  test("every declared server key is represented, and every name names a declared key", () => {
    const keysUsed = new Set(Object.keys(NORMA_CAPABILITY_TOOLS).map((n) => n.slice("mcp__norma__".length).split("__")[0]));
    expect([...keysUsed].sort()).toEqual([...CAPABILITY_SERVER_KEYS].sort());
  });

  test("m1: modes and deferral are pinned against the REAL ToolDefinitions, not against comments", () => {
    // The table is the exposure source Task 9 derives `disallowedTools` from. Pinned against pasted
    // literals it desyncs SILENTLY the day someone edits a tool's own `modes`. So the defs are built
    // here — the same factories both doors use — and compared field for field.
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
      research: [...searchToolDefs(), ...readPageToolDefs({ cache: new PageCache() })],
      web: webToolDefs(),
    };

    // `computer`'s `deferred` is the ONE row that is not on the def: `computer.ts` leaves the field
    // to its caller and `daemon.ts` passes `["dispatch"]` at the registration site. It stays a
    // literal here, and this comment is why.
    const DEFERRED_FROM_THE_CALL_SITE = new Set(["mcp__norma__computer__computer"]);

    const t = NORMA_CAPABILITY_TOOLS as Readonly<Record<string, CapabilityToolFacts>>;
    let checked = 0;
    for (const [key, defs] of Object.entries(defsByKey)) {
      for (const def of defs) {
        const name = capabilityToolName(key, def.name);
        const facts = t[name];
        expect(facts, `${name} is missing from NORMA_CAPABILITY_TOOLS`).toBeDefined();
        // `modes` absent on a def means `["code"]` (registry.ts's own documented default).
        expect([...facts!.modes].sort()).toEqual([...(def.modes ?? ["code"])].sort());
        if (!DEFERRED_FROM_THE_CALL_SITE.has(name)) {
          const fromDef = def.deferred === undefined || def.deferred === false ? undefined
            : def.deferred === true ? true
            : [...def.deferred].sort();
          const fromTable = facts!.deferred === undefined ? undefined
            : facts!.deferred === true ? true
            : [...facts!.deferred].sort();
          expect(fromTable, `${name}'s deferred disagrees with its ToolDefinition`).toEqual(fromDef as never);
        }
        checked++;
      }
    }
    // Every row was reached — a def that stopped being built would otherwise pass by absence.
    expect(checked).toBe(Object.keys(NORMA_CAPABILITY_TOOLS).length);
    // The one literal row, spelled out because it comes from `daemon.ts:registerComputerTool`.
    expect(t["mcp__norma__computer__computer"]!.deferred).toEqual(["dispatch"]);
  });

  test("modes and deferral mirror today's registrations", () => {
    const t = NORMA_CAPABILITY_TOOLS as Readonly<Record<string, CapabilityToolFacts>>;
    // `modes: ["dispatch"]` on all three session tools (list-sessions.ts / session-spawn.ts).
    expect(t["mcp__norma__sessions__session_spawn"]).toEqual({ modes: ["dispatch"] });
    expect(t["mcp__norma__sessions__list_sessions"]).toEqual({ modes: ["dispatch"], deferred: true });
    expect(t["mcp__norma__sessions__manage_session"]).toEqual({ modes: ["dispatch"], deferred: true });
    // computer.ts declares `modes: ["code","dispatch"]`; daemon.ts passes `deferred: ["dispatch"]`.
    expect(t["mcp__norma__computer__computer"]).toEqual({ modes: ["code", "dispatch"], deferred: ["dispatch"] });
    // browser.ts: `modes: ["code","dispatch","chat"]`, `deferred: ["code","dispatch"]`.
    expect(t["mcp__norma__browser__browser"]).toEqual({ modes: ["code", "dispatch", "chat"], deferred: ["code", "dispatch"] });
    // docs/sheets/slides.ts: `modes: ["code","dispatch"]`, no deferral.
    for (const tool of ["docs", "sheets", "slides"]) {
      expect(t[`mcp__norma__office__${tool}`]).toEqual({ modes: ["code", "dispatch"] });
    }
    // search.ts / read-page.ts: `modes: ["chat","dispatch"]`, deliberately NOT deferred.
    expect(t["mcp__norma__research__Search"]).toEqual({ modes: ["chat", "dispatch"] });
    expect(t["mcp__norma__research__ReadPage"]).toEqual({ modes: ["chat", "dispatch"] });
    // web.ts: `modes: ["code"]`, `deferred: true` on both.
    expect(t["mcp__norma__web__web_fetch"]).toEqual({ modes: ["code"], deferred: true });
    expect(t["mcp__norma__web__web_search"]).toEqual({ modes: ["code"], deferred: true });
  });

  test("is a plain data table Task 9 can diff (no functions, no getters)", () => {
    for (const [name, facts] of Object.entries(NORMA_CAPABILITY_TOOLS as Readonly<Record<string, CapabilityToolFacts>>)) {
      expect(Object.getOwnPropertyDescriptor(NORMA_CAPABILITY_TOOLS, name)?.get).toBeUndefined();
      expect(Array.isArray(facts.modes)).toBe(true);
      for (const mode of facts.modes) expect(["code", "dispatch", "chat"]).toContain(mode);
    }
  });
});
