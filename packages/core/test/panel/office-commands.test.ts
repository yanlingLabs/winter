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

  test("24 verbs: 12 sheets + 7 slides + 5 docs, spec §2's tables plus office-finish's two batch verbs", () => {
    const byKind: Record<"sheets" | "slides" | "docs", number> = {
      sheets: OFFICE_COMMAND_ACTIONS.filter((a) => a.startsWith("office.sheets.")).length,
      slides: OFFICE_COMMAND_ACTIONS.filter((a) => a.startsWith("office.slides.")).length,
      docs: OFFICE_COMMAND_ACTIONS.filter((a) => a.startsWith("office.docs.")).length,
    };
    expect(byKind).toEqual({ sheets: 12, slides: 7, docs: 5 });
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

  // Fix round 1 (review I-1 + M-2) — replaces a weaker "clears one 30s handshake" floor check that
  // missed the retry loop AND the per-request timeout entirely (the original 35s/45s numbers passed
  // that check while being genuinely unsafe — see office-commands.ts's own doc for the failure mode:
  // a too-short deadline reports "timed out" while the app is still honestly working, and an agent
  // retry of a non-idempotent write then double-mutates the document).
  //
  // **Cross-language anchor, made explicit rather than merely asserted (M-2).** These four numbers
  // are HAND-COPIED from Swift source — there is no automated cross-language check for a single
  // scalar constant like this repo has for shared fixtures (dangerous-domains.json,
  // cleaner-vectors.json), so this comment names EXACTLY what to re-read if that ever changes:
  //   verify with: grep -n "handshakeTimeout\|maxAttempts\|backoff" \
  //     apple/Norma/Sources/AppShell/OfficeHelperSupervisor.swift        (Configuration, lines 399-401)
  //   verify with: grep -n "requestTimeout: configuration.handshakeTimeout" \
  //     apple/Norma/Sources/AppShell/OfficeHelperSupervisor.swift        (line 658)
  // If any of those four values changes, this test's constants below must be updated BY HAND to
  // match — nothing enforces that automatically, which is exactly why the citation is precise enough
  // to re-check by hand too.
  test("both deadlines cover the REAL worst case: a 3-attempt handshake plus every request the verb sends, each independently timed", () => {
    // Leg 1 — the handshake, WITH its retry loop (OfficeHelperSupervisor.Configuration, lines 399-401).
    const HANDSHAKE_TIMEOUT_S = 30.0; // handshakeTimeout — one attempt's bound
    const MAX_ATTEMPTS = 3;           // maxAttempts
    const BACKOFF_S = 0.25;           // backoff — between attempts only, none after the last
    const H_MS = Math.round((MAX_ATTEMPTS * HANDSHAKE_TIMEOUT_S + (MAX_ATTEMPTS - 1) * BACKOFF_S) * 1000);
    expect(H_MS).toBe(90_500); // 3×30s + 2×0.25s

    // Leg 2 — every subsequent request's own timeout (same file, line 658: `requestTimeout:
    // configuration.handshakeTimeout`), separate from H.
    const REQUEST_TIMEOUT_MS = 30_000;

    // Leg 3 — request COUNT per verb, cold: every verb opens (1); a read/info verb then queries (2
    // total); a write verb additionally saves, on top of open + its own edit request (3 total) —
    // "open + edit + save, not one" (office-commands.ts's own doc, citing OfficeRuntime.Driver.open
    // at OfficeRuntime.swift:1415 and .save at :1431 as the two request/reply calls that already
    // exist; the read query and the edit request are not yet built but ride the same R-bounded
    // client once they are).
    const readMinimumMs = H_MS + 2 * REQUEST_TIMEOUT_MS;   // 150 500
    // office-live-edit R3 — FOUR, not three. A write on an ADOPTED document brackets the engine's
    // undo-stack depth around its edit (`OfficeAgentBroker.runOnce`), which is two more R-bounded
    // requests, so the counted worst case is open/adopt + depth + edit + depth + save. See
    // `office-commands.ts` §A item 4 for the full argument, including why the NOT-adopted path is
    // still three and why requirement 2's batch does not move this again.
    const writeMinimumMs = H_MS + 4 * REQUEST_TIMEOUT_MS;  // 210 500
    expect(readMinimumMs).toBe(150_500);
    expect(writeMinimumMs).toBe(210_500);

    // The shipped constants must never fall below the real worst case (unsafe — see the failure
    // mode above) and must not drift absurdly far above it either (a margin band, not an unbounded
    // one, so a stray extra digit is still caught): 0-30s of headroom past the computed minimum.
    for (const [actual, minimum, label] of [
      [OFFICE_READ_DEADLINE_MS, readMinimumMs, "read"],
      [OFFICE_WRITE_DEADLINE_MS, writeMinimumMs, "write"],
    ] as const) {
      expect(actual, `${label} deadline must cover the real worst case`).toBeGreaterThanOrEqual(minimum);
      expect(actual - minimum, `${label} deadline's margin over the real worst case`).toBeLessThanOrEqual(30_000);
    }
  });
});

// ================================================================================================
// Fix round 1 (review M-3) — the read/write split, pinned LITERALLY rather than checked only against
// itself. `OFFICE_READ_ACTIONS`/`OFFICE_WRITE_ACTIONS` are suffix-derived (office-commands.ts) and
// stay that way — fail-safe (an unrecognized suffix defaults to "write", the safe direction once
// Task 4 gates the approval flow on `OFFICE_WRITE_ACTIONS`) — but fail-safe is not the same as
// CORRECT. This table is the independent ground truth: every one of the 24 verbs, named by hand, not
// derived by any filter or regex. A verb added to `OFFICE_COMMAND_ACTIONS` without a matching entry
// here fails on the membership check below; a verb whose SIDE this table and the real derivation
// disagree on fails on the per-action check — either way, before Task 4 ever reads the split.
// ================================================================================================

describe("office-commands: the read/write split, pinned literally (Task 4 gates approvals on this)", () => {
  const EXPECTED_SIDE: Record<string, "read" | "write"> = {
    "office.sheets.info": "read",
    "office.sheets.read": "read",
    "office.sheets.set": "write",
    "office.sheets.insert_rows": "write",
    "office.sheets.insert_cols": "write",
    "office.sheets.delete_rows": "write",
    "office.sheets.delete_cols": "write",
    "office.sheets.add_sheet": "write",
    "office.sheets.delete_sheet": "write",
    "office.sheets.rename_sheet": "write",
    "office.sheets.format": "write",
    // office-finish Job 2 — the batch verbs. They land on the WRITE side through the suffix rule
    // (`.batch` is neither `.info` nor `.read`), which is what this table exists to confirm rather
    // than assume: a batch applies add/delete/rename operations and saves, so "write" is not merely
    // the fail-safe default here, it is the correct answer.
    "office.sheets.batch": "write",
    "office.slides.info": "read",
    "office.slides.read": "read",
    "office.slides.set_text": "write",
    "office.slides.add_slide": "write",
    "office.slides.delete_slide": "write",
    "office.slides.reorder": "write",
    "office.slides.batch": "write",
    "office.docs.info": "read",
    "office.docs.read": "read",
    "office.docs.replace": "write",
    "office.docs.insert": "write",
    "office.docs.append": "write",
  };

  test("the table names every verb OFFICE_COMMAND_ACTIONS has — no more, no fewer", () => {
    expect(Object.keys(EXPECTED_SIDE).sort()).toEqual([...OFFICE_COMMAND_ACTIONS].sort());
  });

  test("the real derivation agrees with the hand-spelled table for every verb", () => {
    const readSet = new Set<string>(OFFICE_READ_ACTIONS);
    for (const [action, side] of Object.entries(EXPECTED_SIDE)) {
      const actual = readSet.has(action) ? "read" : "write";
      expect(actual, `${action} should be "${side}"`).toBe(side);
    }
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
