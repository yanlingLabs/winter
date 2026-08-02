import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";

// session-activity-hygiene T7: the session cleaner — the SECOND (and last) sanctioned deletion
// path, and the only one that deletes sessions a user has SEEN. Every rail below is load-bearing.
//
// No real sleeps and no network anywhere: the 24h gate and the pass scheduling take an injectable
// clock (the T5/T6 precedent), and every judgment runs against FakeProvider.

function freshStore(): { home: string; store: SessionStore } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "norma-cleaner-test-")));
  return { home, store: new SessionStore(home) };
}

/** Test-only backdoor (reaper.test.ts's `backdateCreatedAt` precedent): pushes a session's stored
 *  `created_at` back by `ms` so the SQL pre-filter sees a genuinely old row without a real wait. */
function backdateCreatedAt(store: SessionStore, sessionId: string, ms: number): void {
  (store as unknown as { db: { run(sql: string, params: unknown[]): void } }).db.run(
    "UPDATE sessions SET created_at = created_at - ? WHERE session_id = ?", [ms, sessionId],
  );
}

describe("SessionStore judged stamp (session-activity-hygiene T7)", () => {
  test("a fresh session is unjudged", () => {
    const { store } = freshStore();
    const id = store.createSession("global");
    expect(store.judgedAt(id)).toBeNull();
    store.close();
  });

  test("markJudged stamps the epoch-ms it is given, readable back", () => {
    const { store } = freshStore();
    const id = store.createSession("global");
    store.markJudged(id, 1_754_000_000_000);
    expect(store.judgedAt(id)).toBe(1_754_000_000_000);
    store.close();
  });

  test("the stamp is write-ONCE: a second markJudged never overwrites the first", () => {
    const { store } = freshStore();
    const id = store.createSession("global");
    store.markJudged(id, 1_754_000_000_000);
    store.markJudged(id, 1_755_000_000_000);
    expect(store.judgedAt(id)).toBe(1_754_000_000_000);
    store.close();
  });

  test("markJudged/judgedAt throw on an unknown session (the setModel/setEffort precedent)", () => {
    const { store } = freshStore();
    expect(() => store.markJudged("s_nope", 1)).toThrow(/unknown session/);
    expect(() => store.judgedAt("s_nope")).toThrow(/unknown session/);
    store.close();
  });

  test("the stamp survives a re-open of the same index.db", () => {
    const { home, store } = freshStore();
    const id = store.createSession("global");
    store.markJudged(id, 1_754_000_000_000);
    store.close();
    const reopened = new SessionStore(home);
    expect(reopened.judgedAt(id)).toBe(1_754_000_000_000);
    reopened.close();
  });
});

describe("SessionStore.cleanerCandidateIds (session-activity-hygiene T7)", () => {
  test("an old, unjudged session IS a candidate", () => {
    const { store } = freshStore();
    const id = store.createSession("global");
    backdateCreatedAt(store, id, 60_000);
    expect(store.cleanerCandidateIds(Date.now())).toEqual([id]);
    store.close();
  });

  test("a session created AFTER the cutoff is not a candidate — created_at is a sound pre-filter for the last-event gate", () => {
    const { store } = freshStore();
    store.createSession("global");
    expect(store.cleanerCandidateIds(Date.now() - 60_000)).toEqual([]);
    store.close();
  });

  test("an already-judged session is never a candidate again", () => {
    const { store } = freshStore();
    const id = store.createSession("global");
    backdateCreatedAt(store, id, 60_000);
    store.markJudged(id, Date.now());
    expect(store.cleanerCandidateIds(Date.now())).toEqual([]);
    store.close();
  });

  test("the dispatch session is excluded by the query itself (belt — the cleaner rails it again)", () => {
    const { store } = freshStore();
    const id = store.createSession("global", { mode: "dispatch" });
    backdateCreatedAt(store, id, 60_000);
    expect(store.cleanerCandidateIds(Date.now())).toEqual([]);
    store.close();
  });
});

describe("SessionStore.isForkRelated (session-activity-hygiene T7)", () => {
  const CHILD = "11111111-2222-4333-8444-555555555555";

  test("a plain session is not fork-related in either direction", () => {
    const { store } = freshStore();
    const id = store.createSession("global");
    expect(store.isForkRelated(id)).toBe(false);
    store.close();
  });

  test("a fork CHILD (its own forkedFrom is set) is fork-related", () => {
    const { store } = freshStore();
    const parent = store.createSession("global");
    store.createSynced(CHILD, { scope: "global", forkedFrom: { sessionId: parent, atSeq: 3 } });
    expect(store.isForkRelated(CHILD)).toBe(true);
    store.close();
  });

  test("a fork PARENT is fork-related — the reverse lookup, not just the row's own column", () => {
    const { store } = freshStore();
    const parent = store.createSession("global");
    store.createSynced(CHILD, { scope: "global", forkedFrom: { sessionId: parent, atSeq: 3 } });
    expect(store.isForkRelated(parent)).toBe(true);
    store.close();
  });

  test("an unrelated third session stays unrelated while a fork pair exists", () => {
    const { store } = freshStore();
    const parent = store.createSession("global");
    const other = store.createSession("global");
    store.createSynced(CHILD, { scope: "global", forkedFrom: { sessionId: parent, atSeq: 3 } });
    expect(store.isForkRelated(other)).toBe(false);
    store.close();
  });
});
