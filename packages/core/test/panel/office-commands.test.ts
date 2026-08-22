import { describe, expect, test } from "bun:test";
import type { NewSessionEvent } from "@norma/protocol";
import { OFFICE_COMMAND_ACTIONS } from "@norma/protocol";
import { PanelCommandRegistry } from "../../src/panel/commands";
import {
  OFFICE_COMMAND_ACTIONS as REEXPORTED_OFFICE_COMMAND_ACTIONS,
  OFFICE_DEADLINES_MS, OFFICE_READ_ACTIONS, OFFICE_WRITE_ACTIONS,
  OFFICE_READ_DEADLINE_MS, OFFICE_WRITE_DEADLINE_MS,
  officeCommandArgs,
} from "../../src/panel/office-commands";

type NewPanelCommand = Extract<NewSessionEvent, { type: "panel_command" }>;

/**
 * office-agent-tools T1 — the wire and a routing shell that refuses every verb, so the bridge is
 * proven end-to-end before a single office verb exists (task-1-brief.md).
 *
 * This file owns the OFFICE half of the exact-equality tripwire the task brief demands:
 * `browser.test.ts` now asserts `BROWSER_DEADLINES_MS` covers `BROWSER_COMMAND_ACTIONS` exactly;
 * this asserts the identical shape for `OFFICE_DEADLINES_MS` / `OFFICE_COMMAND_ACTIONS`. Written
 * FIRST, against a module that did not exist yet — it failed on the import before it failed on any
 * assertion, which is the honest RED this task's TDD step calls for.
 */

describe("office-commands: the verb list", () => {
  test("office-commands.ts re-exports the protocol's OFFICE_COMMAND_ACTIONS verbatim", () => {
    expect(REEXPORTED_OFFICE_COMMAND_ACTIONS).toBe(OFFICE_COMMAND_ACTIONS);
  });

  test("22 verbs: 11 sheets + 6 slides + 5 docs, spec §2's tables exactly", () => {
    const byKind: Record<"sheets" | "slides" | "docs", number> = {
      sheets: OFFICE_COMMAND_ACTIONS.filter((a) => a.startsWith("office.sheets.")).length,
      slides: OFFICE_COMMAND_ACTIONS.filter((a) => a.startsWith("office.slides.")).length,
      docs: OFFICE_COMMAND_ACTIONS.filter((a) => a.startsWith("office.docs.")).length,
    };
    expect(byKind).toEqual({ sheets: 11, slides: 6, docs: 5 });
    // Every verb was counted under exactly one kind — catches a stray fourth namespace the three
    // startsWith checks above would otherwise undercount silently rather than fail on.
    expect(byKind.sheets + byKind.slides + byKind.docs).toBe(OFFICE_COMMAND_ACTIONS.length);
  });

  test("every verb is office.<kind>.<verb> — flat, namespaced, three segments", () => {
    for (const action of OFFICE_COMMAND_ACTIONS) {
      expect(action).toMatch(/^office\.(sheets|slides|docs)\.[a-z_]+$/);
    }
  });

  test("no duplicate verbs", () => {
    expect(new Set(OFFICE_COMMAND_ACTIONS).size).toBe(OFFICE_COMMAND_ACTIONS.length);
  });
});

describe("office-commands: the read/write partition and the deadline tripwire", () => {
  test("OFFICE_READ_ACTIONS is exactly each kind's info + read", () => {
    const expected = OFFICE_COMMAND_ACTIONS.filter((a) => /\.(info|read)$/.test(a));
    // Widened to `string[]` on the receiver: `OFFICE_READ_ACTIONS`'s own type is the NARROW 6-member
    // union (its `filter` in office-commands.ts uses a type predicate on purpose, for callers who
    // want that precision); `expected` here is deliberately the wider `OfficeCommandAction[]` a plain
    // predicate produces. The cast is test-only plumbing — bun:test's `toEqual` requires both sides
    // to share a type, and this test's whole point is comparing two independently-derived VALUES.
    expect(([...OFFICE_READ_ACTIONS] as string[]).sort()).toEqual([...expected].sort());
  });

  test("OFFICE_READ_ACTIONS and OFFICE_WRITE_ACTIONS partition OFFICE_COMMAND_ACTIONS exactly", () => {
    const readSet = new Set(OFFICE_READ_ACTIONS);
    for (const v of OFFICE_WRITE_ACTIONS) expect(readSet.has(v as never)).toBe(false);
    expect([...OFFICE_READ_ACTIONS, ...OFFICE_WRITE_ACTIONS].sort())
      .toEqual([...OFFICE_COMMAND_ACTIONS].sort());
  });

  // THE TRIPWIRE — the task brief's own words: "office gets the identical exact-equality tripwire
  // over OFFICE_COMMAND_ACTIONS". Exact equality, not `toContain`/subset: an orphan deadline (a key
  // with no verb) and an unbounded verb (a verb with no deadline) are both bugs this must catch.
  test("every OFFICE_COMMAND_ACTIONS value has a deadline, and no orphan deadlines exist", () => {
    expect(Object.keys(OFFICE_DEADLINES_MS).sort()).toEqual([...OFFICE_COMMAND_ACTIONS].sort());
  });

  test("read verbs get the read deadline, write verbs get the write deadline, and read < write", () => {
    expect(OFFICE_READ_DEADLINE_MS).toBeLessThan(OFFICE_WRITE_DEADLINE_MS);
    for (const v of OFFICE_READ_ACTIONS) expect(OFFICE_DEADLINES_MS[v]).toBe(OFFICE_READ_DEADLINE_MS);
    for (const v of OFFICE_WRITE_ACTIONS) expect(OFFICE_DEADLINES_MS[v]).toBe(OFFICE_WRITE_DEADLINE_MS);
  });

  // Anchored to the real helper handshake timeout (OfficeHelperSupervisor.Config.handshakeTimeout =
  // 30.0, apple/Norma/Sources/AppShell/OfficeHelperSupervisor.swift) rather than a round number
  // picked from nowhere: every office verb may have to wait through a cold helper handshake before
  // it can even open a document (spec §3 step 2's open-or-adopt applies to every verb, not just
  // `info`), so any deadline shorter than that handshake would time out honest, in-progress work.
  test("both deadlines clear the office helper's own 30s handshake timeout with margin", () => {
    const HANDSHAKE_MS = 30_000;
    expect(OFFICE_READ_DEADLINE_MS).toBeGreaterThan(HANDSHAKE_MS);
    expect(OFFICE_WRITE_DEADLINE_MS).toBeGreaterThan(HANDSHAKE_MS);
  });
});

describe("office-commands: officeCommandArgs", () => {
  test("carries path alone when no fields are given", () => {
    expect(officeCommandArgs("/tmp/fixture.ods")).toEqual({ path: "/tmp/fixture.ods" });
  });

  test("adds named fields alongside path", () => {
    expect(officeCommandArgs("/tmp/fixture.ods", { sheet: "Sheet1", range: "A1:B2" }))
      .toEqual({ path: "/tmp/fixture.ods", sheet: "Sheet1", range: "A1:B2" });
  });

  test("path is owned by this function — a fields.path cannot override it", () => {
    expect(officeCommandArgs("/tmp/real.ods", { path: "/tmp/spoofed.ods", sheet: "S" }))
      .toEqual({ path: "/tmp/real.ods", sheet: "S" });
  });
});

// ================================================================================================
// THE ROUND TRIP, TS HALF — proves the WIRE, not just the constants: a real PanelCommandRegistry
// accepts an office action exactly as it accepts a browser one, with no office-specific carve-out
// anywhere in the daemon's dispatch path. The Swift half of the round trip — the app actually
// decoding this exact shape and answering "not implemented" — is OfficeCommandConsumerTests.swift;
// combined, the two prove the full loop except the literal socket hop, which is the live gate's job
// (spec §8), not this task's.
// ================================================================================================

describe("office-commands: the round trip, TS half", () => {
  test("PanelCommandRegistry.dispatch accepts an office action with no office-specific carve-out", () => {
    const emitted: NewPanelCommand[] = [];
    const registry = new PanelCommandRegistry({ emit: (e) => emitted.push(e as NewPanelCommand) });

    const { commandId } = registry.dispatch({
      sessionId: "s-office",
      action: "office.sheets.read",
      args: officeCommandArgs("/tmp/fixture.ods", { sheet: "Sheet1", range: "A1:B2" }),
      deadlineMs: OFFICE_DEADLINES_MS["office.sheets.read"],
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "panel_command", sessionId: "s-office", commandId,
      action: "office.sheets.read",
      args: { path: "/tmp/fixture.ods", sheet: "Sheet1", range: "A1:B2" },
      deadlineMs: OFFICE_READ_DEADLINE_MS,
    });
    // No tabId: office commands address a document by path, not an existing panel tab (spec §3) —
    // unlike every browser fixture, which always carries one. `tabId` stays optional on the wire for
    // exactly this reason (events.ts's `PanelCommandEvent.tabId`, unchanged by this task).
    expect(emitted[0]).not.toHaveProperty("tabId");
  });

  test("resolving it the way the app's refusal will settles the pending promise honestly", async () => {
    const registry = new PanelCommandRegistry({ emit: () => {} });
    const { commandId, settled } = registry.dispatch({
      sessionId: "s-office",
      action: "office.docs.info",
      args: officeCommandArgs("/tmp/fixture.odt"),
      deadlineMs: OFFICE_DEADLINES_MS["office.docs.info"],
    });
    const resolution = registry.resolve({
      sessionId: "s-office", commandId, ok: false,
      result: "the Mac app does not yet implement the office verb `docs.info`",
    });
    expect(resolution).toBe("accepted");
    expect(await settled).toEqual({
      kind: "result", ok: false,
      result: "the Mac app does not yet implement the office verb `docs.info`",
    });
  });
});
