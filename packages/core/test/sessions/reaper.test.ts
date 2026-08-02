import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, EMPTY_SESSION_GRACE_MS } from "../../src/sessions/store";

// session-activity-hygiene T6: the empty-session reaper + `deleteSession`.
//
// Today (pre-T6) an empty session — created, never sent a message, never touched again — lives
// forever. This file pins the three things that change that:
//   1. `SessionStore.emptySessionIds`  — the candidate query (pure, injectable clock/attach signal)
//   2. `SessionStore.deleteSession`    — full deletion (JSONL + index row), dispatch-guarded
//   3. `appendCleanerLog`/`reapEmptySessions` — the audit trail + the orchestration both real call
//      sites (session.create's mint-time sweep, daemon.ts's boot sweep) share.
//
// No real sleeps anywhere: `emptySessionIds`/`reapEmptySessions` take the clock as a parameter/dep
// (the `activityFor`/`ActivityEnforcementDeps` precedent — see activity-enforcement.test.ts), so
// "10 minutes have passed" is simulated by computing a `nowMs` relative to the session's REAL
// `createdAt` (itself real — `createSession` isn't clock-injectable), never by waiting.

function freshStore() { return new SessionStore(mkdtempSync(join(tmpdir(), "norma-reaper-test-"))); }

/** Every test in this file wants "nobody attached" unless it says otherwise. */
const NOBODY_ATTACHED = () => 0;

function createdAtOf(store: SessionStore, sessionId: string): number {
  return store.list().find((r) => r.sessionId === sessionId)!.createdAt;
}

/** `nowMs` that puts a session exactly `deltaMs` past its own 10-minute grace boundary — negative
 *  `deltaMs` stays inside the grace window. */
function agedNow(store: SessionStore, sessionId: string, deltaMs: number): number {
  return createdAtOf(store, sessionId) + EMPTY_SESSION_GRACE_MS + deltaMs;
}

describe("SessionStore.emptySessionIds (session-activity-hygiene T6)", () => {
  test("a brand-new session is never a candidate — the grace window", () => {
    const store = freshStore();
    const id = store.createSession("global");
    // Still inside the window (1ms before the boundary).
    expect(store.emptySessionIds(NOBODY_ATTACHED, agedNow(store, id, -1))).toEqual([]);
    store.close();
  });

  test("exactly at the 10-minute boundary IS a candidate — '≥ 10 min ago' is inclusive", () => {
    const store = freshStore();
    const id = store.createSession("global");
    expect(store.emptySessionIds(NOBODY_ATTACHED, agedNow(store, id, 0))).toEqual([id]);
    store.close();
  });

  test("a session with a user message is never a candidate, however old", () => {
    const store = freshStore();
    const id = store.createSession("global");
    store.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "hi", clientName: "cli-p" });
    expect(store.emptySessionIds(NOBODY_ATTACHED, agedNow(store, id, 10 * 365 * 24 * 60 * 60_000))).toEqual([]);
    store.close();
  });

  test("an old, empty, unattached session IS a candidate", () => {
    const store = freshStore();
    const id = store.createSession("global");
    expect(store.emptySessionIds(NOBODY_ATTACHED, agedNow(store, id, 1))).toEqual([id]);
    store.close();
  });

  test("an old, empty session that is currently attached is not a candidate", () => {
    const store = freshStore();
    const id = store.createSession("global");
    const attachedCount = (sid: string) => (sid === id ? 1 : 0);
    expect(store.emptySessionIds(attachedCount, agedNow(store, id, 1))).toEqual([]);
    store.close();
  });

  test("the dispatch session is excluded even when empty, old, and unattached", () => {
    const store = freshStore();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    expect(store.emptySessionIds(NOBODY_ATTACHED, agedNow(store, dispatchId, 1))).toEqual([]);
    store.close();
  });

  // The assistant-only edge (ambiguity resolution: verify `first_message` covers it — it does not).
  // `deriveIndexFields` (store.ts) only ever looks at `user_message` events for `first_message`;
  // it has no idea whether `assistant_message` content exists. A session holding only assistant
  // output (no user message ever) therefore reads `first_message IS NULL` — indistinguishable, by
  // the index alone, from a truly empty session. `emptySessionIds` must not call this one empty.
  test("assistant-only content still counts as non-empty even though first_message stays NULL", () => {
    const store = freshStore();
    const id = store.createSession("global");
    expect(store.list().find((r) => r.sessionId === id)?.title).toBeUndefined(); // first_message truly null
    store.append(id, { type: "assistant_message", sessionId: id, threadId: "main", text: "unsolicited output" });
    expect(store.emptySessionIds(NOBODY_ATTACHED, agedNow(store, id, 1))).toEqual([]);
    store.close();
  });

  // The REALISTIC path to the assistant-only edge above: recoverAll's skip-bad-lines repair drops
  // an unparseable line rather than stopping at it (readGoodLines), so a log whose user_message
  // line was corrupted (crash mid-write, disk hiccup) can still carry a perfectly valid
  // assistant_message a few lines later. This proves first_message's blind spot is reachable, not
  // hypothetical.
  test("a recovered log whose user_message line was corrupted (assistant_message survives) is still not a candidate", () => {
    const dir = mkdtempSync(join(tmpdir(), "norma-reaper-test-"));
    const scopeDir = join(dir, "sessions", "global");
    mkdirSync(scopeDir, { recursive: true });
    const id = "s_deadbeef0001";
    const now = Date.now();
    const lines = [
      JSON.stringify({ type: "session_created", sessionId: id, scope: "global", seq: 1, ts: now }),
      "{not valid json at all", // the corrupted user_message line — dropped by readGoodLines
      JSON.stringify({ type: "assistant_message", sessionId: id, threadId: "main", seq: 3, ts: now, text: "hi" }),
    ];
    writeFileSync(join(scopeDir, `${id}.jsonl`), lines.join("\n") + "\n");
    const store = new SessionStore(dir); // recoverAll's pass 2 discovers + repairs this orphan log
    expect(store.list().find((r) => r.sessionId === id)?.title).toBeUndefined(); // first_message IS NULL
    expect(store.emptySessionIds(NOBODY_ATTACHED, agedNow(store, id, 1))).toEqual([]);
    store.close();
  });
});

describe("SessionStore.deleteSession (session-activity-hygiene T6)", () => {
  test("deletes the JSONL file and the index row", () => {
    const dir = mkdtempSync(join(tmpdir(), "norma-reaper-test-"));
    const store = new SessionStore(dir);
    const id = store.createSession("global");
    const logPath = join(dir, "sessions", "global", `${id}.jsonl`);
    expect(existsSync(logPath)).toBe(true);
    store.deleteSession(id);
    expect(existsSync(logPath)).toBe(false);
    expect(store.list().some((r) => r.sessionId === id)).toBe(false);
    expect(() => store.meta(id)).toThrow();
    store.close();
  });

  test("throws on an unknown session id", () => {
    const store = freshStore();
    expect(() => store.deleteSession("s_does_not_exist")).toThrow();
    store.close();
  });

  test("refuses the dispatch session — pinned", () => {
    const dir = mkdtempSync(join(tmpdir(), "norma-reaper-test-"));
    const store = new SessionStore(dir);
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    expect(() => store.deleteSession(dispatchId)).toThrow(/dispatch/);
    // Nothing was destroyed.
    expect(store.list().some((r) => r.sessionId === dispatchId)).toBe(true);
    expect(existsSync(join(dir, "sessions", "global", `${dispatchId}.jsonl`))).toBe(true);
    store.close();
  });
});
