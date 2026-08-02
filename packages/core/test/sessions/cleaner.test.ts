import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider, ProviderEvent, TurnRequest } from "../../src/providers/types";
import { FakeProvider } from "../../src/agent/fake-provider";
import { SessionStore } from "../../src/sessions/store";
import {
  SessionCleaner, CLEANER_MODEL, CLEANER_EFFORT, CLEANER_INSTRUCTION,
  CLEANER_MAX_JUDGMENTS_PER_PASS, CLEANER_MIN_IDLE_MS, CLEANER_TRANSCRIPT_MAX_CHARS,
  type CleanerDeps, type CleanerStore,
} from "../../src/sessions/cleaner";

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

// ---------------------------------------------------------------------------------------------
// The cleaner itself.
// ---------------------------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

/** A judge that votes DELETE on everything. Every rail test below faces THIS provider: a railed
 *  session must survive it, with its `judged` stamp still NULL (railed ⇒ never judged ⇒ it
 *  re-qualifies the day the rail lifts, which is exactly what a rail means). */
function deleteVotingJudge(): FakeProvider {
  return new FakeProvider([[
    { type: "text_delta", delta: '{"verdict":"delete","reason":"trivial exchange"}' },
    { type: "done", stopReason: "end_turn" },
  ]]);
}

function keepVotingJudge(): FakeProvider {
  return new FakeProvider([[
    { type: "text_delta", delta: '{"verdict":"keep","reason":"real work"}' },
    { type: "done", stopReason: "end_turn" },
  ]]);
}

/** The cleaner under test, wired to a REAL store in a temp home with nothing attached, no turn
 *  running and no background work — i.e. every candidate derives `idle` unless a test says else. */
function makeCleaner(
  store: SessionStore,
  home: string,
  provider: Provider,
  over: Partial<CleanerDeps> = {},
): SessionCleaner {
  return new SessionCleaner({
    provider: { provider, model: "ignored" },
    store,
    attachedCount: () => 0,
    turnRunning: () => false,
    bgWork: () => false,
    home,
    enabled: () => true,
    now: () => Date.now(),
    ...over,
  });
}

/** A session that is a plausible junk candidate: one user message, one assistant reply, aged past
 *  the 24h gate. Every rail test starts from this and adds exactly ONE railing fact. */
function junkSession(store: SessionStore, opts: { mode?: "code" | "chat" | "dispatch" } = {}): string {
  const id = store.createSession("global", opts.mode ? { mode: opts.mode } : {});
  store.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "hey", clientName: "cli" });
  store.append(id, { type: "assistant_message", sessionId: id, threadId: "main", text: "Hi! What can I do for you?" });
  backdateCreatedAt(store, id, DAY + 60_000);
  return id;
}

/** A FIXED `now`, far enough ahead of this process's real clock that a just-written log's mtime is
 *  comfortably past the 24h gate. Fixed (not a `Date.now()`-relative function) so an audit line's
 *  `date` and a `judged` stamp are exact-matchable rather than drifting between two reads. */
const AGED_NOW = Date.now() + DAY + 60_000;
const agedNow = () => AGED_NOW;

function cleanerLines(home: string): any[] {
  const path = join(home, "cleaner.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("SessionCleaner — the happy path (session-activity-hygiene T7)", () => {
  test("a delete verdict deletes the session and audits it with the JUDGE's reason", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store);
    const provider = deleteVotingJudge();

    await makeCleaner(store, home, provider, { now: agedNow }).runPass();

    expect(store.list().some((r) => r.sessionId === id)).toBe(false);
    expect(cleanerLines(home)).toEqual([
      { sessionId: id, reason: "trivial exchange", date: new Date(agedNow()).toISOString() },
    ]);
    store.close();
  });

  test("a keep verdict stamps `judged` and deletes nothing", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store);
    const provider = keepVotingJudge();

    await makeCleaner(store, home, provider, { now: agedNow }).runPass();

    expect(store.list().some((r) => r.sessionId === id)).toBe(true);
    expect(store.judgedAt(id)).toBe(agedNow());
    expect(cleanerLines(home)).toEqual([]);
    store.close();
  });

  test("the judge is asked exactly once, on the pinned Dreaming model at low effort, with the transcript rendered role-labeled", async () => {
    const { home, store } = freshStore();
    junkSession(store);
    const provider = keepVotingJudge();

    await makeCleaner(store, home, provider, { now: agedNow }).runPass();

    expect(provider.requests).toHaveLength(1);
    const req = provider.requests[0]!;
    expect(req.model).toBe(CLEANER_MODEL);
    expect(req.reasoningEffort).toBe(CLEANER_EFFORT);
    expect(req.instructions).toBe(CLEANER_INSTRUCTION);
    const content = (req.input[0] as { content: string }).content;
    expect(content).toContain("[user] hey");
    expect(content).toContain("[norma] Hi! What can I do for you?");
    store.close();
  });

  // The brief's decision-plumbing fixtures: the SAME cleaner, the SAME session shape, opposite
  // scripted verdicts — what is pinned is that the verdict drives the outcome, never that a model
  // would actually answer either way.
  test("fixtures: a 'hey'-shaped session is deleted on a delete verdict and kept on a keep verdict", async () => {
    for (const [provider, expectAlive] of [[deleteVotingJudge(), false], [keepVotingJudge(), true]] as const) {
      const { home, store } = freshStore();
      const id = junkSession(store);
      await makeCleaner(store, home, provider, { now: agedNow }).runPass();
      expect(store.list().some((r) => r.sessionId === id)).toBe(expectAlive);
      store.close();
    }
  });
});

/** A `CleanerStore` that delegates to a real store, with any member overridable — used for the
 *  belt-and-suspenders rails (a real store's own query would never OFFER the dispatch session as a
 *  candidate, so the cleaner's independent rail can only be exercised by handing it one anyway) and
 *  for failure paths a real sqlite/fs store won't produce on demand (the `ReaperStore` precedent). */
function delegatingStore(store: SessionStore, over: Partial<CleanerStore> = {}): CleanerStore {
  return {
    cleanerCandidateIds: (c) => store.cleanerCandidateIds(c),
    meta: (id) => store.meta(id),
    read: (id) => store.read(id),
    lastEventTs: (id) => store.lastEventTs(id),
    judgedAt: (id) => store.judgedAt(id),
    markJudged: (id, at) => store.markJudged(id, at),
    isForkRelated: (id) => store.isForkRelated(id),
    getTitle: (id) => store.getTitle(id),
    deleteSession: (id) => store.deleteSession(id),
    ...over,
  };
}

/** THE rail assertion (the brief's non-negotiable shape): the session faces a judge that votes
 *  DELETE on everything and must come through it
 *    - still there,
 *    - with `judged` still NULL — a railed session is never JUDGED, only skipped, so it re-qualifies
 *      the day its rail lifts,
 *    - and with the judge never even asked (a rail is categorical: it precedes the provider call),
 *    - and with nothing written to the audit log. */
async function expectRailed(
  store: SessionStore, home: string, id: string, over: Partial<CleanerDeps> = {},
): Promise<void> {
  const provider = deleteVotingJudge();
  await makeCleaner(store, home, provider, { now: agedNow, ...over }).runPass();
  expect(store.list().some((r) => r.sessionId === id)).toBe(true);
  expect(store.judgedAt(id)).toBeNull();
  expect(provider.requests).toHaveLength(0);
  expect(cleanerLines(home)).toEqual([]);
}

describe("SessionCleaner rails — a railed session survives a delete-voting judge, UNSTAMPED", () => {
  test("rail: the dispatch session — independent of both the candidate query AND deleteSession's own refusal", async () => {
    const { home, store } = freshStore();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    // Deliberately NOT hung-shaped (a user message AND a reply): a lone-user-message fixture would
    // take the no-LLM hung path and be stopped by `deleteSession`'s in-store guard instead, so the
    // test would pass with the cleaner's own dispatch rail deleted — proven by a mutation probe that
    // removed every rail and left this one test green. What is pinned here is the CLEANER's rail.
    store.append(dispatchId, { type: "user_message", sessionId: dispatchId, threadId: "main", text: "hey", clientName: "cli" });
    store.append(dispatchId, { type: "assistant_message", sessionId: dispatchId, threadId: "main", text: "on it" });
    backdateCreatedAt(store, dispatchId, DAY + 60_000);
    // The real query already excludes it, so hand it over anyway: this pins the CLEANER's own rail,
    // not the store's.
    expect(store.cleanerCandidateIds(agedNow() - CLEANER_MIN_IDLE_MS)).toEqual([]);
    const provider = deleteVotingJudge();
    const injected = delegatingStore(store, { cleanerCandidateIds: () => [dispatchId] });
    await makeCleaner(store, home, provider, { now: agedNow, store: injected }).runPass();
    expect(store.list().some((r) => r.sessionId === dispatchId)).toBe(true);
    expect(store.judgedAt(dispatchId)).toBeNull();
    expect(provider.requests).toHaveLength(0);
    store.close();
  });

  test("rail: a phone-synced session (its id matches SYNCED_SESSION_ID_RE)", async () => {
    const { home, store } = freshStore();
    const id = "11111111-2222-4333-8444-555555555555";
    store.createSynced(id, { scope: "global" });
    store.appendSynced(id, [{
      raw: JSON.stringify({ type: "user_message", sessionId: id, threadId: "main", text: "hey", clientName: "phone", seq: 1, ts: Date.now() }),
      event: { type: "user_message", sessionId: id, threadId: "main", text: "hey", clientName: "phone", seq: 1, ts: Date.now() },
    }]);
    backdateCreatedAt(store, id, DAY + 60_000);
    await expectRailed(store, home, id);
    store.close();
  });

  test("rail: a fork CHILD", async () => {
    const { home, store } = freshStore();
    const parent = store.createSession("other-scope");
    const id = junkSession(store);
    (store as any).db.run("UPDATE sessions SET forked_from_session_id = ?, forked_from_at_seq = 2 WHERE session_id = ?", [parent, id]);
    await expectRailed(store, home, id);
    store.close();
  });

  test("rail: a fork PARENT (the reverse lookup)", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store);
    const child = store.createSession("global");
    (store as any).db.run("UPDATE sessions SET forked_from_session_id = ?, forked_from_at_seq = 2 WHERE session_id = ?", [id, child]);
    await expectRailed(store, home, id);
    store.close();
  });

  test("rail: activity 'active' — a harness is attached", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store);
    await expectRailed(store, home, id, { attachedCount: () => 1 });
    store.close();
  });

  test("rail: activity 'background' — the stored backgrounded flag", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store);
    store.setBackgrounded(id, true);
    await expectRailed(store, home, id);
    store.close();
  });

  test("rail: activity 'background' — an unattended running turn", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store);
    await expectRailed(store, home, id, { turnRunning: () => true });
    store.close();
  });

  test("rail: activity 'background' — unattended background work outliving the turn", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store);
    await expectRailed(store, home, id, { bgWork: () => true });
    store.close();
  });

  test("rail: activity 'archived'", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store);
    store.setArchived(id, true);
    await expectRailed(store, home, id);
    store.close();
  });

  test("rail: last event newer than 24h", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store);
    // The real clock: the log was written milliseconds ago, so the idle gate has not opened.
    await expectRailed(store, home, id, { now: () => Date.now() });
    store.close();
  });

  test("rail: a successful file write in the transcript", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store);
    store.append(id, { type: "tool_call", sessionId: id, threadId: "main", callId: "c1", name: "write", argsJson: "{}" });
    store.append(id, { type: "tool_result", sessionId: id, threadId: "main", callId: "c1", output: "ok", isError: false });
    await expectRailed(store, home, id);
    store.close();
  });

  test("rail: a write tool_call with NO result at all — an unknown outcome counts as a write", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store);
    store.append(id, { type: "tool_call", sessionId: id, threadId: "main", callId: "c1", name: "edit", argsJson: "{}" });
    await expectRailed(store, home, id);
    store.close();
  });

  test("rail: a user-set title (a session_titled event in the transcript)", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store);
    store.append(id, { type: "session_titled", sessionId: id, threadId: "main", title: "Kept on purpose" });
    await expectRailed(store, home, id);
    store.close();
  });

  test("rail: already judged — PERMANENT immunity, even after the session grows fresh junk", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store);
    store.markJudged(id, 1_754_000_000_000);
    // ...and now it accumulates exactly the kind of content a judge would vote to delete.
    store.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "lol", clientName: "cli" });
    store.append(id, { type: "assistant_message", sessionId: id, threadId: "main", text: "😄" });

    const provider = deleteVotingJudge();
    // Handed to the cleaner directly, past the SQL pre-filter, so what is pinned is that the CLEANER
    // refuses to re-examine it — not merely that the query no longer lists it.
    const injected = delegatingStore(store, { cleanerCandidateIds: () => [id] });
    await makeCleaner(store, home, provider, { now: agedNow, store: injected }).runPass();

    expect(store.list().some((r) => r.sessionId === id)).toBe(true);
    expect(store.judgedAt(id)).toBe(1_754_000_000_000); // untouched — never re-stamped either
    expect(provider.requests).toHaveLength(0);
    store.close();
  });
});

describe("SessionCleaner — what is NOT railed (each rail's negative)", () => {
  test("a chat session IS a candidate — `undefined` activity means 'no lifecycle', not 'railed'", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store, { mode: "chat" });
    const provider = deleteVotingJudge();
    await makeCleaner(store, home, provider, { now: agedNow }).runPass();
    expect(provider.requests).toHaveLength(1);
    expect(store.list().some((r) => r.sessionId === id)).toBe(false);
    store.close();
  });

  test("a FAILED write does not rail — nothing was written", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store);
    store.append(id, { type: "tool_call", sessionId: id, threadId: "main", callId: "c1", name: "write", argsJson: "{}" });
    store.append(id, { type: "tool_result", sessionId: id, threadId: "main", callId: "c1", output: "denied", isError: true });
    const provider = deleteVotingJudge();
    await makeCleaner(store, home, provider, { now: agedNow }).runPass();
    expect(store.list().some((r) => r.sessionId === id)).toBe(false);
    store.close();
  });

  test("a non-write tool (read) does not rail", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store);
    store.append(id, { type: "tool_call", sessionId: id, threadId: "main", callId: "c1", name: "read", argsJson: "{}" });
    store.append(id, { type: "tool_result", sessionId: id, threadId: "main", callId: "c1", output: "contents", isError: false });
    const provider = deleteVotingJudge();
    await makeCleaner(store, home, provider, { now: agedNow }).runPass();
    expect(store.list().some((r) => r.sessionId === id)).toBe(false);
    store.close();
  });
});
