import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTIVE_DEMOTION_MS,
  activityFor,
  makeActivityDeriver,
  participatesInActivity,
  type Activity,
  type ActivitySignals,
} from "../../src/sessions/activity";
import { SessionStore, type SessionRow } from "../../src/sessions/store";

// session-activity-hygiene T2 (spec §1, §5 "Derivation table: signals × flags → state, exhaustive").
//
// `activityFor` is a PURE function — that is the whole point of extracting it: the state machine
// that later tasks hang ENFORCEMENT off (T5 aborts a running turn at last-detach) is decided here,
// where every combination can be enumerated, rather than inline at a call site where only the
// combinations someone thought of get covered.

const NOW = 1_770_000_000_000;

function row(over: Partial<SessionRow> = {}): SessionRow {
  // `approvalPolicy` is REQUIRED on SessionRow (mac-chat-parity T4) and irrelevant to the activity
  // derivation — `ActivityRow` narrows to mode/backgrounded/archived, so no case below reads it.
  // Stated here only because a complete `SessionRow` needs it; "ask" is the store's own default.
  return { sessionId: "s_abc", scope: "global", createdAt: NOW - 60_000, lastSeq: 3, approvalPolicy: "ask", ...over };
}

function signals(over: Partial<ActivitySignals> = {}): ActivitySignals {
  return { turnRunning: false, attachedCount: 0, bgWork: false, lastEventTs: NOW - 5_000, ...over };
}

/** The exhaustive table, hand-written rather than computed. The key is the six decisive bits in
 *  order `A B T N W O`:
 *    A = archived flag, B = backgrounded flag, T = a turn is running, N = attachedCount > 0,
 *    W = background work (bg bash task / detached agent thread), O = continuously active > 24 h.
 *
 *  Every one of the 64 combinations is listed. A table COMPUTED from the same rules the
 *  implementation uses would prove nothing (it would be the implementation, twice); these are
 *  written out from spec §1's prose priority — archived → background → active → idle. */
const TABLE: Record<string, Activity> = {
  // ---- A=0, B=0: the only block where the live signals actually decide anything -------------
  "000000": "idle",       // nothing running, nothing attached — the overwhelmingly common row
  "000001": "background", // >24h continuously active demotes even a quiet session (spec §1.2)
  "000010": "background", // bg work with nobody attached — the invisible-runner this spec exists for
  "000011": "background",
  "000100": "active",     // a harness is attached
  "000101": "background", // demotion outranks attachment (priority: background before active)
  "000110": "active",     // bg work WITH a harness attached is just an active session
  "000111": "background",
  "001000": "background", // running turn, nobody attached
  "001001": "background",
  "001010": "background",
  "001011": "background",
  "001100": "active",     // running turn WITH a harness attached
  "001101": "background",
  "001110": "active",
  "001111": "background",
  // ---- A=0, B=1: the backgrounded flag wins over every live signal ---------------------------
  "010000": "background",
  "010001": "background",
  "010010": "background",
  "010011": "background",
  "010100": "background", // flagged AND attached: still background (the flag is the user's choice)
  "010101": "background",
  "010110": "background",
  "010111": "background",
  "011000": "background",
  "011001": "background",
  "011010": "background",
  "011011": "background",
  "011100": "background",
  "011101": "background",
  "011110": "background",
  "011111": "background",
  // ---- A=1: archived is the top of the priority order, full stop ------------------------------
  "100000": "archived",
  "100001": "archived",
  "100010": "archived",
  "100011": "archived",
  "100100": "archived",
  "100101": "archived",
  "100110": "archived",
  "100111": "archived",
  "101000": "archived",
  "101001": "archived",
  "101010": "archived",
  "101011": "archived",
  "101100": "archived",
  "101101": "archived",
  "101110": "archived",
  "101111": "archived",
  "110000": "archived",
  "110001": "archived",
  "110010": "archived",
  "110011": "archived",
  "110100": "archived",
  "110101": "archived",
  "110110": "archived",
  "110111": "archived",
  "111000": "archived",
  "111001": "archived",
  "111010": "archived",
  "111011": "archived",
  "111100": "archived",
  "111101": "archived",
  "111110": "archived",
  "111111": "archived",
};

/** All 64 six-bit keys, in counting order. */
const KEYS = Array.from({ length: 64 }, (_, i) => i.toString(2).padStart(6, "0"));

function caseFor(key: string, mode?: string): { row: SessionRow; signals: ActivitySignals } {
  const [a, b, t, n, w, o] = key.split("").map((c) => c === "1");
  return {
    row: row({ mode, ...(a ? { archived: true } : {}), ...(b ? { backgrounded: true } : {}) }),
    signals: signals({
      turnRunning: t!,
      attachedCount: n! ? 1 : 0,
      bgWork: w!,
      // `activeSince` is a SIGNAL, not a stored flag: absent means "nothing is tracking a
      // continuously-active span for this session", which must never read as ">24h".
      ...(o! ? { activeSince: NOW - ACTIVE_DEMOTION_MS - 1 } : {}),
    }),
  };
}

describe("activityFor — the exhaustive derivation table (spec §1)", () => {
  test("the table itself covers all 64 signal×flag combinations", () => {
    expect(Object.keys(TABLE).sort()).toEqual([...KEYS].sort());
  });

  // Every participating mode gets the FULL table, not a sample: "absent = code" is a convention
  // (`sync.ts`, `session-mode.ts`'s `isCodeMode`), and a convention that only holds for the rows
  // someone happened to spot-check is how it stops holding.
  for (const mode of [undefined, "code", "cowork"] as const) {
    test(`mode ${mode ?? "(absent → code)"} derives every combination per spec §1's priority`, () => {
      for (const key of KEYS) {
        const c = caseFor(key, mode);
        expect(`${key} → ${activityFor(c.row, c.signals, NOW)}`).toBe(`${key} → ${TABLE[key]}`);
      }
    });
  }

  // Chat and dispatch do not participate AT ALL (spec §1: "absent = none"). Asserted over the same
  // 64 combinations rather than one row, because the mode gate has to outrank every flag — an
  // archived chat session, or a dispatch session with a turn running, must still report nothing.
  for (const mode of ["chat", "dispatch"] as const) {
    test(`mode ${mode} is undefined for every combination (absent = none)`, () => {
      for (const key of KEYS) {
        const c = caseFor(key, mode);
        expect(`${key} → ${activityFor(c.row, c.signals, NOW)}`).toBe(`${key} → undefined`);
      }
    });
  }

  test("an unknown/future mode does not silently acquire the lifecycle", () => {
    // Participation is an ALLOWLIST, not "everything except chat/dispatch": the state carries
    // enforcement teeth from T5 on (last-detach aborts a running turn), so a mode that ships later
    // opts IN deliberately rather than inheriting a turn-killing lifecycle by omission.
    expect(activityFor(row({ mode: "voice" }), signals({ attachedCount: 1 }), NOW)).toBeUndefined();
    expect(participatesInActivity("voice")).toBe(false);
    expect(participatesInActivity(undefined)).toBe(true);
    expect(participatesInActivity("code")).toBe(true);
    expect(participatesInActivity("cowork")).toBe(true);
    expect(participatesInActivity("chat")).toBe(false);
    expect(participatesInActivity("dispatch")).toBe(false);
  });
});

describe("activityFor — signal edges", () => {
  test("the 24h demotion is strictly GREATER than the window, and undefined is never over it", () => {
    const exactly = signals({ activeSince: NOW - ACTIVE_DEMOTION_MS });
    const overBy1 = signals({ activeSince: NOW - ACTIVE_DEMOTION_MS - 1 });
    expect(activityFor(row(), exactly, NOW)).toBe("idle");
    expect(activityFor(row(), overBy1, NOW)).toBe("background");
    expect(activityFor(row(), signals({ activeSince: undefined }), NOW)).toBe("idle");
    // A future activeSince (clock skew between the setter and this read) is not "over 24h".
    expect(activityFor(row(), signals({ activeSince: NOW + 60_000 }), NOW)).toBe("idle");
  });

  test("attachedCount > 1 behaves exactly like 1 (any attachment is an attachment)", () => {
    expect(activityFor(row(), signals({ attachedCount: 7 }), NOW)).toBe("active");
    expect(activityFor(row(), signals({ attachedCount: 7, turnRunning: true }), NOW)).toBe("active");
  });

  test("lastEventTs does not participate in the derivation today", () => {
    // Declared on ActivitySignals because the cleaner (spec §3: "idle ∧ ≥24h since last event")
    // is the next consumer and the signal-building call site should populate it honestly from the
    // start. Pinned so a future rule that starts READING it has to change this test deliberately.
    const ancient = signals({ lastEventTs: 0 });
    const fresh = signals({ lastEventTs: NOW });
    expect(activityFor(row(), ancient, NOW)).toBe(activityFor(row(), fresh, NOW));
  });

  test("is pure: no mutation of its inputs, same answer twice", () => {
    const r = row({ backgrounded: true });
    const s = signals({ turnRunning: true, attachedCount: 2 });
    const rBefore = JSON.stringify(r);
    const sBefore = JSON.stringify(s);
    expect(activityFor(r, s, NOW)).toBe("background");
    expect(activityFor(r, s, NOW)).toBe("background");
    expect(JSON.stringify(r)).toBe(rBefore);
    expect(JSON.stringify(s)).toBe(sBefore);
  });

  test("ACTIVE_DEMOTION_MS is 24 hours (spec §1.2's auto-demotion)", () => {
    expect(ACTIVE_DEMOTION_MS).toBe(24 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------------------------
// The two STORED flags. Index columns on exactly the `model`/`effort` terms: additive ALTER TABLE,
// index-only metadata (they do NOT ride the event log), so they reset on a full index rebuild.
// ---------------------------------------------------------------------------------------------

function makeStore(): { store: SessionStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "norma-activity-"));
  return { store: new SessionStore(dir), dir };
}

describe("SessionStore — backgrounded/archived flags", () => {
  test("both default to absent (never false) and round-trip through list()", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    expect(store.list().find((r) => r.sessionId === id)?.backgrounded).toBeUndefined();
    expect(store.list().find((r) => r.sessionId === id)?.archived).toBeUndefined();

    store.setBackgrounded(id, true);
    expect(store.list().find((r) => r.sessionId === id)?.backgrounded).toBe(true);
    expect(store.list().find((r) => r.sessionId === id)?.archived).toBeUndefined();

    store.setArchived(id, true);
    expect(store.list().find((r) => r.sessionId === id)?.archived).toBe(true);

    // Clearing returns to ABSENT, not `false` — same "absent means default" shape as every other
    // optional SessionRow field, so a cleared flag is indistinguishable from one never set.
    store.setBackgrounded(id, false);
    store.setArchived(id, false);
    expect(store.list().find((r) => r.sessionId === id)?.backgrounded).toBeUndefined();
    expect(store.list().find((r) => r.sessionId === id)?.archived).toBeUndefined();
    store.close();
  });

  test("the two flags are independent (one is not the other's column)", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    store.setArchived(id, true);
    expect(store.list().find((r) => r.sessionId === id)?.backgrounded).toBeUndefined();
    store.setBackgrounded(id, true);
    store.setArchived(id, false);
    expect(store.list().find((r) => r.sessionId === id)?.backgrounded).toBe(true);
    expect(store.list().find((r) => r.sessionId === id)?.archived).toBeUndefined();
    store.close();
  });

  test("setters throw on an unknown session (setModel/setEffort precedent → NOT_FOUND)", () => {
    const { store } = makeStore();
    expect(() => store.setBackgrounded("s_nope", true)).toThrow(/unknown session/);
    expect(() => store.setArchived("s_nope", true)).toThrow(/unknown session/);
    store.close();
  });

  test("both flags reset on an index rebuild (index-only metadata, `model`/`effort` class)", () => {
    const { store, dir } = makeStore();
    const id = store.createSession("global");
    store.setBackgrounded(id, true);
    store.setArchived(id, true);
    store.close();
    rmSync(join(dir, "sessions", "index.db"));
    for (const ext of ["-wal", "-shm"]) {
      try { rmSync(join(dir, "sessions", "index.db" + ext)); } catch { /* not present */ }
    }
    const reopened = new SessionStore(dir);
    const rebuilt = reopened.list().find((r) => r.sessionId === id);
    expect(rebuilt?.backgrounded).toBeUndefined();
    expect(rebuilt?.archived).toBeUndefined();
    reopened.close();
  });
});

describe("SessionStore.lastEventTs", () => {
  test("tracks the log's last append and never predates creation", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const atCreate = store.lastEventTs(id);
    const created = store.list().find((r) => r.sessionId === id)!.createdAt;
    expect(atCreate).toBeGreaterThanOrEqual(created);

    Bun.sleepSync(12); // mtime granularity: enough for a strictly-later stamp on APFS
    store.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "x", clientName: "t" });
    expect(store.lastEventTs(id)).toBeGreaterThan(atCreate);
    store.close();
  });

  test("throws on an unknown session", () => {
    const { store } = makeStore();
    expect(() => store.lastEventTs("s_nope")).toThrow(/unknown session/);
    store.close();
  });
});

// session-activity-hygiene T8: the transcript path dispatch's `list_sessions` shows per row — the
// public form of the private `logPath` the store's own appends/reads use, so the surface that
// displays it cannot compose a second guess at the layout.
describe("SessionStore.transcriptPath", () => {
  test("is the file the store actually appends to, and throws on an unknown session", () => {
    const { store, dir } = makeStore();
    const id = store.createSession("global");
    const path = store.transcriptPath(id);
    expect(path).toBe(join(dir, "sessions", "global", `${id}.jsonl`));
    // Not a composed guess: this is the file the session's own events land in.
    store.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "hello", clientName: "t" });
    expect(readFileSync(path, "utf8")).toContain("hello");
    expect(() => store.transcriptPath("s_nope")).toThrow(/unknown session/);
    store.close();
  });
});

// ---------------------------------------------------------------------------------------------
// session-activity-hygiene T8: `makeActivityDeriver` — the ONE assembly of `ActivitySignals` from
// the daemon's live sources, extracted from `startIpcServer`'s own `deriveActivity` closure so the
// dispatch management tool (`list_sessions`) reads a session's state through EXACTLY the function
// `session.list` stamps rows with, rather than a third hand-assembled copy of the same five reads.
// ---------------------------------------------------------------------------------------------

describe("makeActivityDeriver (T8)", () => {
  const sources = (over: Partial<Parameters<typeof makeActivityDeriver>[0]> = {}) => ({
    attachedCount: () => 0,
    turnRunning: () => false,
    bgWork: () => false,
    lastEventTs: () => NOW - 5_000,
    ...over,
  });

  test("assembles every signal from its sources and answers exactly what activityFor would", () => {
    const derive = makeActivityDeriver(sources({ attachedCount: () => 1 }));
    expect(derive(row(), "s_abc", NOW)).toBe("active");
    expect(makeActivityDeriver(sources({ turnRunning: () => true }))(row(), "s_abc", NOW)).toBe("background");
    expect(makeActivityDeriver(sources({ bgWork: () => true }))(row(), "s_abc", NOW)).toBe("background");
    expect(makeActivityDeriver(sources())(row({ archived: true }), "s_abc", NOW)).toBe("archived");
    expect(makeActivityDeriver(sources())(row(), "s_abc", NOW)).toBe("idle");
  });

  test("the OPTIONAL enforcement signals ride through when wired, and are absent (never 0/false-y stand-ins) when not", () => {
    // activeSince: the >24h demotion only fires when the source is wired AND over the window.
    const long = makeActivityDeriver(sources({
      attachedCount: () => 1,
      activeSince: () => NOW - ACTIVE_DEMOTION_MS - 1,
    }));
    expect(long(row(), "s_abc", NOW)).toBe("background");
    // Unwired → `undefined`, which must read as "nothing is tracking a span", NOT as epoch 0
    // (which would demote every session on earth — activity.ts's own warning).
    expect(makeActivityDeriver(sources({ attachedCount: () => 1 }))(row(), "s_abc", NOW)).toBe("active");
    // autoBackground: the post-turn grace window.
    expect(makeActivityDeriver(sources({ autoBackground: () => true }))(row(), "s_abc", NOW)).toBe("background");
  });

  test("short-circuits a non-participating mode BEFORE reading any signal source", () => {
    let reads = 0;
    const count = () => { reads++; return 0; };
    const derive = makeActivityDeriver({
      attachedCount: count,
      turnRunning: () => { reads++; return false; },
      bgWork: () => { reads++; return false; },
      lastEventTs: () => { reads++; return NOW; },
    });
    // A chat row is nothing to this lifecycle — and, load-bearing for `session.list`, it must not
    // pay the per-session `lastEventTs` filesystem stat to learn that.
    expect(derive(row({ mode: "chat" }), "s_abc", NOW)).toBeUndefined();
    expect(derive(row({ mode: "dispatch" }), "s_abc", NOW)).toBeUndefined();
    expect(reads).toBe(0);
  });
});
