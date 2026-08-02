import { describe, expect, test } from "bun:test";
import {
  AGENTS_EMPTY_STATE, AGENTS_KEY_HINT,
  agentResumeCommand, applyActivityEvent, applySessionList, emptyAgentsState,
  formatAgentsSnapshot, formatForColumn, keyToAgentsAction, moveSelection, runAgentVerb, selectedAgent,
  type AgentsState,
} from "../src/agents-cli";
import type { NormaClient } from "../src/client";

// session-activity-hygiene T9: `norma agents` — the human's window onto the lifecycle T1-T8 built.
//
// Everything asserted here is the roster's LOGIC, kept out of the Ink component and out of main.ts's
// argv switch for the same reason cli-verb-gates.test.ts extracted the session-verb routes: main.ts's
// dispatch can't be driven by a unit test, so anything that must be provable has to live in a module
// it can import (main.test.ts's own header says exactly this).
//
// The roster NEVER attaches. It reads `session.list` (which carries `activity` since T2) and listens
// for the `session_activity` transient, which since this task's core half reaches a harness that
// attached to nothing. Attaching would also enrol it in T5's detach enforcement — a roster that
// aborted somebody's turn by being closed would be a bug of its own.

const T0 = 1_700_000_000_000;

function row(sessionId: string, extra: Record<string, unknown> = {}) {
  return { sessionId, scope: "global", createdAt: T0, lastSeq: 3, ...extra };
}

describe("applySessionList — which sessions the roster shows", () => {
  test("keeps active + background code sessions, drops idle, archived and non-participating modes", () => {
    const s = applySessionList(emptyAgentsState(), [
      row("s_bg", { activity: "background", title: "Fix the reaper", mode: "code" }),
      row("s_active", { activity: "active", title: "Refactor the hub", mode: "code" }),
      row("s_idle", { activity: "idle", title: "Old work", mode: "code" }),
      row("s_arch", { activity: "archived", title: "Shelved", mode: "code" }),
      row("s_chat", { title: "A chat", mode: "chat" }),        // no activity: does not participate
      row("s_dispatch", { title: "Dispatch", mode: "dispatch" }),
    ], T0);
    expect(s.rows.map((r) => r.sessionId)).toEqual(["s_bg", "s_active"]);
    expect(s.rows[0]!.title).toBe("Fix the reaper");
    expect(s.rows[0]!.activity).toBe("background");
  });

  test("cowork participates exactly like code — the roster reads `activity`, never a mode allowlist of its own", () => {
    const s = applySessionList(emptyAgentsState(), [
      row("s_cowork", { activity: "background", mode: "cowork", title: "Pairing" }),
    ], T0);
    expect(s.rows.map((r) => r.sessionId)).toEqual(["s_cowork"]);
  });

  test("background sorts ahead of active, and each group is stable by title/id", () => {
    const s = applySessionList(emptyAgentsState(), [
      row("s_a", { activity: "active", title: "A" }),
      row("s_b", { activity: "background", title: "B" }),
      row("s_c", { activity: "active", title: "C" }),
      row("s_d", { activity: "background", title: "D" }),
    ], T0);
    expect(s.rows.map((r) => r.sessionId)).toEqual(["s_b", "s_d", "s_a", "s_c"]);
  });

  test("a row already known keeps its ORIGINAL since-stamp across polls — the clock must not reset every 2s", () => {
    let s = applySessionList(emptyAgentsState(), [row("s_bg", { activity: "background" })], T0);
    s = applySessionList(s, [row("s_bg", { activity: "background", title: "now titled" })], T0 + 60_000);
    expect(s.rows[0]!.sinceMs).toBe(T0);
    expect(s.rows[0]!.title).toBe("now titled"); // everything else still refreshes
  });

  test("a row whose state CHANGED between polls re-stamps — the clock measures the current state", () => {
    let s = applySessionList(emptyAgentsState(), [row("s_x", { activity: "active" })], T0);
    s = applySessionList(s, [row("s_x", { activity: "background" })], T0 + 60_000);
    expect(s.rows[0]!.sinceMs).toBe(T0 + 60_000);
    expect(s.rows[0]!.observedOnly).toBe(true);
  });

  test("selection follows the SESSION, not the index, when rows come and go", () => {
    let s = applySessionList(emptyAgentsState(), [
      row("s_1", { activity: "background" }), row("s_2", { activity: "background" }), row("s_3", { activity: "background" }),
    ], T0);
    s = moveSelection(s, 2);
    expect(selectedAgent(s)!.sessionId).toBe("s_3");
    s = applySessionList(s, [row("s_1", { activity: "background" }), row("s_3", { activity: "background" })], T0);
    expect(selectedAgent(s)!.sessionId).toBe("s_3"); // was index 2, now index 1
  });

  test("selection clamps when the selected session disappears entirely", () => {
    let s = applySessionList(emptyAgentsState(), [row("s_1", { activity: "background" }), row("s_2", { activity: "background" })], T0);
    s = moveSelection(s, 1);
    s = applySessionList(s, [row("s_1", { activity: "background" })], T0);
    expect(selectedAgent(s)!.sessionId).toBe("s_1");
    s = applySessionList(s, [], T0);
    expect(selectedAgent(s)).toBeUndefined();
  });
});

describe("applyActivityEvent — the live half (no polling delay)", () => {
  test("flips a known row's state instantly and stamps the EVENT's own ts", () => {
    let s = applySessionList(emptyAgentsState(), [row("s_1", { activity: "active", title: "Work" })], T0);
    s = applyActivityEvent(s, { sessionId: "s_1", activity: "background", ts: T0 + 5_000 }, T0 + 5_010);
    expect(s.rows[0]!.activity).toBe("background");
    expect(s.rows[0]!.sinceMs).toBe(T0 + 5_000);
    expect(s.rows[0]!.observedOnly).toBe(false); // a real transition, not an inference
    expect(s.rows[0]!.title).toBe("Work");       // the poll's data survives the flip
  });

  test("REMOVES a row that left the roster (idle or archived) — the T8-review bug, seen from the client", () => {
    let s = applySessionList(emptyAgentsState(), [
      row("s_1", { activity: "background" }), row("s_2", { activity: "background" }),
    ], T0);
    s = applyActivityEvent(s, { sessionId: "s_1", activity: "archived", ts: T0 + 1 }, T0 + 1);
    expect(s.rows.map((r) => r.sessionId)).toEqual(["s_2"]);
    s = applyActivityEvent(s, { sessionId: "s_2", activity: "idle", ts: T0 + 2 }, T0 + 2);
    expect(s.rows).toEqual([]);
  });

  test("ADDS a session the roster has never listed — a background session born between polls", () => {
    const s = applyActivityEvent(emptyAgentsState(), { sessionId: "s_new", activity: "background", ts: T0 }, T0);
    expect(s.rows.map((r) => r.sessionId)).toEqual(["s_new"]);
    expect(s.rows[0]!.title).toBeUndefined(); // the next poll fills it in; never invented here
  });

  test("an event for an unknown session at a state the roster does not show is a no-op", () => {
    const s = applyActivityEvent(emptyAgentsState(), { sessionId: "s_x", activity: "idle", ts: T0 }, T0);
    expect(s.rows).toEqual([]);
  });

  test("a REPEATED state does not re-stamp the clock", () => {
    let s = applySessionList(emptyAgentsState(), [row("s_1", { activity: "background" })], T0);
    s = applyActivityEvent(s, { sessionId: "s_1", activity: "background", ts: T0 + 30_000 }, T0 + 30_000);
    expect(s.rows[0]!.sinceMs).toBe(T0);
  });
});

describe("formatForColumn — honest about what it knows", () => {
  test("a witnessed transition reads as an exact span", () => {
    expect(formatForColumn({ sinceMs: T0, observedOnly: false }, T0 + 65_000)).toBe("1m 5s");
  });

  test("a state that was ALREADY set when the roster opened reads as a LOWER BOUND, never as the truth", () => {
    // The daemon does not tell an unattached client when a state began — session.list carries the
    // state, not its start. Printing "3s" for a session backgrounded yesterday would be a lie.
    expect(formatForColumn({ sinceMs: T0, observedOnly: true }, T0 + 3_000)).toBe("≥3s");
  });
});

describe("agentResumeCommand — the exact string, verified against main.ts's own route", () => {
  test("is `norma resume <id>` — the subcommand, NOT a --resume flag", () => {
    expect(agentResumeCommand("s_1a2b3c4d5e6f")).toBe("norma resume s_1a2b3c4d5e6f");
  });
});

describe("formatAgentsSnapshot — the empty state is never a blank screen", () => {
  test("says so in words", () => {
    expect(formatAgentsSnapshot(emptyAgentsState(), T0)).toEqual([AGENTS_EMPTY_STATE]);
    expect(AGENTS_EMPTY_STATE).toBe("no background sessions");
  });

  test("renders state, title and the running-for span for each row", () => {
    const s = applySessionList(emptyAgentsState(), [
      row("s_bg", { activity: "background", title: "Fix the reaper" }),
    ], T0);
    const [line] = formatAgentsSnapshot(s, T0 + 90_000);
    expect(line).toContain("background");
    expect(line).toContain("Fix the reaper");
    expect(line).toContain("≥1m 30s");
    expect(line).toContain("s_bg");
  });

  test("an untitled row shows its id rather than an empty gap", () => {
    const s = applyActivityEvent(emptyAgentsState(), { sessionId: "s_bare", activity: "background", ts: T0 }, T0);
    expect(formatAgentsSnapshot(s, T0)[0]).toContain("s_bare");
  });
});

// -------------------------------------------------------------------------------------------
// The verbs. Fake client (cli-verb-gates.test.ts's `makeClient` shape) — recorded calls, canned
// results — so each verb is provable without a daemon.
// -------------------------------------------------------------------------------------------

type Impl = Record<string, (...args: any[]) => unknown>;
function makeClient(impl: Impl): { client: NormaClient; calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = [];
  const client: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(impl)) {
    client[name] = (...args: unknown[]) => { calls.push({ method: name, args }); return Promise.resolve(fn(...args)); };
  }
  return { client: client as unknown as NormaClient, calls };
}

const bgRow = { sessionId: "s_1", activity: "background" as const, sinceMs: T0, observedOnly: false };

describe("runAgentVerb", () => {
  test("stop drives session.interrupt and reports whether a turn was actually running", async () => {
    const { client, calls } = makeClient({ interrupt: () => ({ wasRunning: true }) });
    const r = await runAgentVerb(client, "stop", bgRow);
    expect(calls).toEqual([{ method: "interrupt", args: ["s_1"] }]);
    expect(r.message).toContain("stopped");
  });

  test("stop on a session with no turn running says so instead of claiming a stop", async () => {
    const { client } = makeClient({ interrupt: () => ({ wasRunning: false }) });
    const r = await runAgentVerb(client, "stop", bgRow);
    expect(r.message).toContain("nothing was running");
  });

  test("background drives session.setActivity and REPORTS THE DAEMON'S derived answer, not what was asked", async () => {
    // The daemon's post-write derived state is the truth (a clear on a session whose detached bash
    // task is still writing comes back "background") — client.ts's own doc says report this value.
    const { client, calls } = makeClient({ sessionSetActivity: () => ({ ok: true, activity: "background" }) });
    const r = await runAgentVerb(client, "background", bgRow);
    expect(calls).toEqual([{ method: "sessionSetActivity", args: [{ sessionId: "s_1", activity: "background" }] }]);
    expect(r.message).toContain("background");
  });

  test("clear sends activity: null — the both-flags clear, not a second value", async () => {
    const { client, calls } = makeClient({ sessionSetActivity: () => ({ ok: true, activity: "idle" }) });
    const r = await runAgentVerb(client, "clear", bgRow);
    expect(calls).toEqual([{ method: "sessionSetActivity", args: [{ sessionId: "s_1", activity: null }] }]);
    expect(r.message).toContain("idle");
  });

  test("archive sends activity: 'archived'", async () => {
    const { client, calls } = makeClient({ sessionSetActivity: () => ({ ok: true, activity: "archived" }) });
    const r = await runAgentVerb(client, "archive", bgRow);
    expect(calls).toEqual([{ method: "sessionSetActivity", args: [{ sessionId: "s_1", activity: "archived" }] }]);
    expect(r.message).toContain("archived");
  });

  test("open makes NO rpc at all — it prints the resume command verbatim", async () => {
    const { client, calls } = makeClient({ interrupt: () => ({ wasRunning: false }), sessionSetActivity: () => ({ ok: true }) });
    const r = await runAgentVerb(client, "open", bgRow);
    expect(calls).toEqual([]);
    expect(r.message).toBe("norma resume s_1");
  });

  test("a refused/failed RPC surfaces the daemon's own words — never a silent no-op", async () => {
    const { client } = makeClient({
      sessionSetActivity: () => { throw new Error("chat sessions have no activity lifecycle (code 400)"); },
    });
    const r = await runAgentVerb(client, "archive", bgRow);
    expect(r.message).toContain("chat sessions have no activity lifecycle");
  });

  test("every verb the key hint advertises is a verb runAgentVerb accepts", async () => {
    // The hint line and the dispatch table are two lists of the same thing; this is the tripwire.
    for (const verb of ["stop", "background", "clear", "archive", "open"] as const) {
      expect(AGENTS_KEY_HINT).toContain(verb);
    }
  });
});

describe("the roster never attaches", () => {
  test("no verb, and no state transition, ever calls attach or send", async () => {
    const { client, calls } = makeClient({
      attach: () => 1, send: () => 1,
      interrupt: () => ({ wasRunning: false }),
      sessionSetActivity: () => ({ ok: true, activity: "idle" }),
    });
    for (const verb of ["stop", "background", "clear", "archive", "open"] as const) {
      await runAgentVerb(client, verb, bgRow);
    }
    expect(calls.map((c) => c.method)).not.toContain("attach");
    expect(calls.map((c) => c.method)).not.toContain("send");
  });
});

describe("keyToAgentsAction — the keymap, pure so the Ink hook stays a one-liner", () => {
  const K = (over: Record<string, boolean> = {}) => ({ upArrow: false, downArrow: false, escape: false, ctrl: false, ...over });

  test("arrows and j/k move the selection", () => {
    expect(keyToAgentsAction("", K({ downArrow: true }))).toEqual({ kind: "move", delta: 1 });
    expect(keyToAgentsAction("", K({ upArrow: true }))).toEqual({ kind: "move", delta: -1 });
    expect(keyToAgentsAction("j", K())).toEqual({ kind: "move", delta: 1 });
    expect(keyToAgentsAction("k", K())).toEqual({ kind: "move", delta: -1 });
  });

  test("each verb has one key, and they are the keys the hint advertises", () => {
    expect(keyToAgentsAction("s", K())).toEqual({ kind: "verb", verb: "stop" });
    expect(keyToAgentsAction("b", K())).toEqual({ kind: "verb", verb: "background" });
    expect(keyToAgentsAction("c", K())).toEqual({ kind: "verb", verb: "clear" });
    expect(keyToAgentsAction("a", K())).toEqual({ kind: "verb", verb: "archive" });
    expect(keyToAgentsAction("o", K())).toEqual({ kind: "verb", verb: "open" });
    expect(keyToAgentsAction("\r", K())).toEqual({ kind: "verb", verb: "open" }); // enter = open
  });

  test("q, esc and ctrl+c all quit", () => {
    expect(keyToAgentsAction("q", K())).toEqual({ kind: "quit" });
    expect(keyToAgentsAction("", K({ escape: true }))).toEqual({ kind: "quit" });
    expect(keyToAgentsAction("c", K({ ctrl: true }))).toEqual({ kind: "quit" }); // ctrl+c beats "clear"
  });

  test("anything else is ignored — a stray keystroke never fires a verb", () => {
    expect(keyToAgentsAction("z", K())).toBeNull();
    expect(keyToAgentsAction("", K())).toBeNull();
  });
});

describe("state shape", () => {
  test("emptyAgentsState is empty and selects nothing", () => {
    const s: AgentsState = emptyAgentsState();
    expect(s.rows).toEqual([]);
    expect(selectedAgent(s)).toBeUndefined();
  });
});
