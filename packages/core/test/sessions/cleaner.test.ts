import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider, ProviderEvent, TurnRequest } from "../../src/providers/types";
import { FakeProvider } from "../../src/agent/fake-provider";
import { SessionEvent } from "@norma/protocol";
import { SessionStore } from "../../src/sessions/store";
import {
  SessionCleaner, renderTranscript, hasUserSetTitle, CLEANER_MODEL, CLEANER_EFFORT, CLEANER_INSTRUCTION,
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
function junkSession(store: SessionStore, opts: { mode?: "code" | "chat" | "dispatch"; ageMs?: number } = {}): string {
  const id = store.createSession("global", opts.mode ? { mode: opts.mode } : {});
  store.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "hey", clientName: "cli" });
  store.append(id, { type: "assistant_message", sessionId: id, threadId: "main", text: "Hi! What can I do for you?" });
  backdateCreatedAt(store, id, opts.ageMs ?? DAY + 60_000);
  return id;
}

/** A session with exactly one user message and no reply of any kind — spec §3's hung auto-junk. */
function hungSession(store: SessionStore, opts: { ageMs?: number } = {}): string {
  const id = store.createSession("global");
  store.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "are you there?", clientName: "cli" });
  backdateCreatedAt(store, id, opts.ageMs ?? DAY + 60_000);
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
  test("fixture: a short-but-SUBSTANTIVE exchange, judged keep, is stamped and kept whole", async () => {
    const { home, store } = freshStore();
    const id = store.createSession("global");
    store.append(id, {
      type: "user_message", sessionId: id, threadId: "main", clientName: "cli",
      text: "What's the difference between a rebase and a merge for a long-lived branch?",
    });
    store.append(id, {
      type: "assistant_message", sessionId: id, threadId: "main",
      text: "A merge preserves both histories and records the join; a rebase rewrites your commits onto the new base, which keeps history linear but changes commit ids — avoid it on anything already pushed and shared.",
    });
    backdateCreatedAt(store, id, DAY + 60_000);
    const provider = keepVotingJudge();

    await makeCleaner(store, home, provider, { now: agedNow }).runPass();

    // The judge saw the WHOLE exchange, both roles, before answering.
    const content = (provider.requests[0]!.input[0] as { content: string }).content;
    expect(content).toContain("[user] What's the difference between a rebase and a merge");
    expect(content).toContain("[norma] A merge preserves both histories");
    expect(store.list().some((r) => r.sessionId === id)).toBe(true);
    expect(store.judgedAt(id)).toBe(agedNow());
    expect(cleanerLines(home)).toEqual([]);
    store.close();
  });

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

  // Review Critical (T7): `activityFor` returns `undefined` at its FIRST line for any mode outside
  // {code, cowork} (activity.ts:100), so for a chat session the three liveness signals the cleaner
  // wires up were computed and then thrown away — and nothing else covered the gap (chat has no fs
  // tools, so `hasFileWrite` can never fire; the title rail is vacuous; a Mac-minted chat id is
  // `s_<hex>`, so the phone rail does not apply). The reachable shape was a menu-bar chat window
  // left open over a weekend: attached, live, and fully deletable at the next Dreaming tick, with no
  // `session_deleted` event to tell the open window. The rail now reads the RAW signals, so all
  // three protect ALL modes symmetrically.
  test("rail: an ATTACHED chat session — chat derives no activity state, so the RAW signal must rail it", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store, { mode: "chat" });
    await expectRailed(store, home, id, { attachedCount: () => 1 });
    store.close();
  });

  test("rail: a chat session with a RUNNING TURN", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store, { mode: "chat" });
    await expectRailed(store, home, id, { turnRunning: () => true });
    store.close();
  });

  test("rail: a chat session with BACKGROUND WORK outliving its turn", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store, { mode: "chat" });
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

  // panel-shell T14: the cleaner's own door onto the loss Task 12 closed on the reaper. A
  // browse-only session (no user_message/assistant_message ever) has an EMPTY rendered transcript —
  // exactly what a delete-voting judge sees as worthless junk. Both halves in ONE test, the
  // reaper.test.ts "open tab / truly empty sibling" shape: a fix that railed everything would spare
  // `trulyEmpty` too and pass a one-sided version of this.
  test("rail: a session holding an open panel tab is spared — even with no chat messages at all — while a truly empty sibling is still judged and deleted", async () => {
    const { home, store } = freshStore();
    const withTab = store.createSession("global");
    store.append(withTab, { type: "panel_tab_opened", sessionId: withTab, tabId: "t1", kind: "web" });
    backdateCreatedAt(store, withTab, DAY + 60_000);
    const trulyEmpty = store.createSession("global");
    backdateCreatedAt(store, trulyEmpty, DAY + 60_000);
    const provider = deleteVotingJudge();

    await makeCleaner(store, home, provider, { now: agedNow }).runPass();

    expect(store.list().some((r) => r.sessionId === withTab)).toBe(true);
    expect(store.judgedAt(withTab)).toBeNull();
    expect(store.list().some((r) => r.sessionId === trulyEmpty)).toBe(false);
    // Only the truly-empty one ever reached the judge — the tab-holder was railed BEFORE any call.
    expect(provider.requests).toHaveLength(1);
    expect(cleanerLines(home)).toEqual([
      { sessionId: trulyEmpty, reason: "trivial exchange", date: new Date(agedNow()).toISOString() },
    ]);
    store.close();
  });

  // NOTE: the user-set-title rail has NO test here, deliberately — see the "the title rail is
  // vacuous today" describe block below. It is the one rail that cannot fire, because no user-set
  // title exists in this system to fire it.


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

  // Controller ruling 2026-08-02, after this task's producer sweep found that `session_titled` is
  // never user-authored: the title rail is an explicitly-documented NO-OP. These pin the
  // PRODUCTION-SHAPED behavior, which is the whole point — in a real daemon the auto-titler runs at
  // every depth-0 turn completion and is on by default, so a "hey" session HAS a session_titled
  // event by the time the cleaner ever sees it. Railing on that would make spec §3's own worked
  // example impossible and the plan's close-out live gate ("a 'hey' session deleted by the cleaner
  // next Dreaming cycle") unfailable-by-construction.
  test("an AUTO-TITLED 'hey' session is still judged and still deletable — the production shape", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store);
    // Exactly what agent/titles.ts writes after the first turn completes: a model-written title.
    store.append(id, { type: "session_titled", sessionId: id, threadId: "main", title: "Casual greeting exchange" });
    const provider = deleteVotingJudge();

    await makeCleaner(store, home, provider, { now: agedNow }).runPass();

    expect(provider.requests).toHaveLength(1); // it reached the judge...
    expect(store.list().some((r) => r.sessionId === id)).toBe(false); // ...and the verdict landed
    expect(cleanerLines(home)[0]).toEqual({
      sessionId: id, title: "Casual greeting exchange", reason: "trivial exchange",
      date: new Date(agedNow()).toISOString(),
    });
    store.close();
  });

  test("an auto-titled session judged KEEP is stamped like any other — the title changes nothing either way", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store);
    store.append(id, { type: "session_titled", sessionId: id, threadId: "main", title: "Casual greeting exchange" });

    await makeCleaner(store, home, keepVotingJudge(), { now: agedNow }).runPass();

    expect(store.judgedAt(id)).toBe(agedNow());
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

  // panel-shell T14: the trap named in the task brief. A rail keyed off the raw event's mere
  // PRESENCE ("ever opened one") would make this session permanently un-judgeable even though it
  // holds zero tabs right now. The rail must fold (Task 5's foldPanelTabs), not scan, so a session
  // that closed every tab it ever opened is genuinely empty again and stays eligible.
  //
  // T16 update: the reaper's `emptySessionIds` used to have exactly the presence-scan shape this
  // comment warned about — the two doors disagreed. They now share ONE predicate
  // (`hasOpenPanelTabs`, `panel/store.ts`), so both fold. Note the reaper ORs that predicate with
  // its own message scan rather than replacing it: an assistant-only session holds no tab but is
  // not empty, and swapping the check wholesale would have made it reapable.
  test("a panel tab that was opened and later CLOSED holds none — not railed by 'ever opened', still judged and deletable", async () => {
    const { home, store } = freshStore();
    const id = store.createSession("global");
    store.append(id, { type: "panel_tab_opened", sessionId: id, tabId: "t1", kind: "web" });
    store.append(id, { type: "panel_tab_closed", sessionId: id, tabId: "t1" });
    backdateCreatedAt(store, id, DAY + 60_000);
    const provider = deleteVotingJudge();
    await makeCleaner(store, home, provider, { now: agedNow }).runPass();
    expect(provider.requests).toHaveLength(1); // reached the judge — not railed
    expect(store.list().some((r) => r.sessionId === id)).toBe(false);
    store.close();
  });
});

/** A judge that answers with whatever raw text it is given — for the strict-parse cases. */
function rawJudge(text: string): FakeProvider {
  return new FakeProvider([[{ type: "text_delta", delta: text }, { type: "done", stopReason: "end_turn" }]]);
}

/** A provider whose streamTurn never yields (dreamer-gates.test.ts's own HangingProvider) — proves
 *  the per-judgment timeout fires and that a hung provider means "keep, unstamped", not a wedge. */
class HangingProvider implements Provider {
  readonly id = "hanging";
  readonly requests: TurnRequest[] = [];
  models() { return [{ id: "hang-1", family: "hang", contextWindow: 1000, supportsVision: false }]; }
  async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
    const { signal, ...cloneable } = req;
    this.requests.push({ ...structuredClone(cloneable), ...(signal ? { signal } : {}) });
    await new Promise<never>(() => {});
  }
}

/** Votes DELETE, but MUTATES the world first — the only way to exercise the pre-delete re-check,
 *  which exists precisely because a judgment is an `await` a user can act during. */
class MutatingJudge implements Provider {
  readonly id = "mutating";
  readonly requests: TurnRequest[] = [];
  constructor(private readonly mutate: () => void) {}
  models() { return [{ id: "m-1", family: "m", contextWindow: 1000, supportsVision: false }]; }
  async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
    const { signal, ...cloneable } = req;
    this.requests.push({ ...structuredClone(cloneable), ...(signal ? { signal } : {}) });
    this.mutate();
    yield { type: "text_delta", delta: '{"verdict":"delete","reason":"trivial"}' };
    yield { type: "done", stopReason: "end_turn" };
  }
}

describe("SessionCleaner — hung auto-junk (no LLM)", () => {
  test("one user message, no reply at all, past the gate: deleted with reason 'hung: no reply', judge never asked", async () => {
    const { home, store } = freshStore();
    const id = hungSession(store);
    const provider = deleteVotingJudge();

    const result = await makeCleaner(store, home, provider, { now: agedNow }).runPass();

    expect(result.deleted).toEqual([id]);
    expect(provider.requests).toHaveLength(0); // decided BEFORE any judge call
    expect(store.list().some((r) => r.sessionId === id)).toBe(false);
    expect(cleanerLines(home)).toEqual([
      { sessionId: id, reason: "hung: no reply", date: new Date(agedNow()).toISOString() },
    ]);
    store.close();
  });

  test("a lone user message that DID get tool work is not 'hung' — it goes to the judge", async () => {
    const { home, store } = freshStore();
    const id = hungSession(store);
    store.append(id, { type: "tool_call", sessionId: id, threadId: "main", callId: "c1", name: "read", argsJson: "{}" });
    const provider = keepVotingJudge();

    await makeCleaner(store, home, provider, { now: agedNow }).runPass();

    expect(provider.requests).toHaveLength(1);
    expect(store.judgedAt(id)).toBe(agedNow());
    store.close();
  });

  test("TWO unanswered user messages are not the auto-junk shape — the judge decides", async () => {
    const { home, store } = freshStore();
    const id = hungSession(store);
    store.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "hello?", clientName: "cli" });
    const provider = keepVotingJudge();

    await makeCleaner(store, home, provider, { now: agedNow }).runPass();

    expect(provider.requests).toHaveLength(1);
    expect(store.list().some((r) => r.sessionId === id)).toBe(true);
    store.close();
  });

  test("a hung session is still RAILED like any other — the auto-junk path does not bypass the rails", async () => {
    const { home, store } = freshStore();
    const id = hungSession(store);
    store.setArchived(id, true);
    await expectRailed(store, home, id);
    store.close();
  });
});

describe("SessionCleaner — the judgment budget", () => {
  const OVER = CLEANER_MAX_JUDGMENTS_PER_PASS + 2;

  test(`at most ${CLEANER_MAX_JUDGMENTS_PER_PASS} judgments per pass; the remainder is untouched and unstamped`, async () => {
    const { home, store } = freshStore();
    // Distinct ages so `ORDER BY created_at` is deterministic (index 0 oldest, judged first).
    const ids = Array.from({ length: OVER }, (_, i) => junkSession(store, { ageMs: DAY + 60_000 + (OVER - i) * 1000 }));
    const provider = keepVotingJudge();

    await makeCleaner(store, home, provider, { now: agedNow }).runPass();

    expect(provider.requests).toHaveLength(CLEANER_MAX_JUDGMENTS_PER_PASS);
    const stamped = ids.filter((id) => store.judgedAt(id) !== null);
    expect(stamped).toEqual(ids.slice(0, CLEANER_MAX_JUDGMENTS_PER_PASS));
    store.close();
  });

  test("hung auto-junk is NOT charged to the budget: a hung candidate behind a full budget is still deleted", async () => {
    const { home, store } = freshStore();
    // 10 judgeable candidates (older, so they sort first and consume the whole budget)...
    for (let i = 0; i < CLEANER_MAX_JUDGMENTS_PER_PASS; i++) {
      junkSession(store, { ageMs: DAY + 60_000 + (100 - i) * 1000 });
    }
    // ...then the hung one, last in candidate order.
    const hungId = hungSession(store, { ageMs: DAY + 60_000 });
    const provider = keepVotingJudge();

    const result = await makeCleaner(store, home, provider, { now: agedNow }).runPass();

    expect(provider.requests).toHaveLength(CLEANER_MAX_JUDGMENTS_PER_PASS);
    expect(result.deleted).toEqual([hungId]);
    expect(store.list().some((r) => r.sessionId === hungId)).toBe(false);
    store.close();
  });

  test("the next pass picks up where the budget ran out (the unstamped remainder)", async () => {
    const { home, store } = freshStore();
    const ids = Array.from({ length: OVER }, (_, i) => junkSession(store, { ageMs: DAY + 60_000 + (OVER - i) * 1000 }));
    const provider = keepVotingJudge();
    const cleaner = makeCleaner(store, home, provider, { now: agedNow });

    await cleaner.runPass();
    await cleaner.runPass();

    expect(provider.requests).toHaveLength(OVER);
    expect(ids.every((id) => store.judgedAt(id) !== null)).toBe(true);
    store.close();
  });
});

describe("SessionCleaner — strict verdict parsing (ANY deviation ⇒ keep, NO stamp)", () => {
  const DEVIATIONS: [string, string][] = [
    ["plain prose, no JSON at all", "I think this one should be deleted."],
    ["a missing verdict key", '{"reason":"junk"}'],
    ["an unrecognized verdict value", '{"verdict":"purge","reason":"junk"}'],
    ["a non-string reason", '{"verdict":"delete","reason":42}'],
    ["a blank reason", '{"verdict":"delete","reason":"   "}'],
    ["a truncated/unparseable object", '{"verdict":"delete","reason":'],
    ["an empty answer", ""],
  ];

  for (const [label, text] of DEVIATIONS) {
    test(`${label} ⇒ kept, unstamped, retried next pass`, async () => {
      const { home, store } = freshStore();
      const id = junkSession(store);
      const provider = rawJudge(text);

      await makeCleaner(store, home, provider, { now: agedNow }).runPass();

      expect(provider.requests).toHaveLength(1); // it WAS asked...
      expect(store.list().some((r) => r.sessionId === id)).toBe(true); // ...and survived
      expect(store.judgedAt(id)).toBeNull(); // ...unstamped: unexamined, not judged
      expect(cleanerLines(home)).toEqual([]);
      store.close();
    });
  }

  test("a provider error ⇒ kept, unstamped", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store);
    const provider = new FakeProvider([[{ type: "error", code: "server", message: "upstream 500" }]]);
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await makeCleaner(store, home, provider, { now: agedNow }).runPass();
      expect(store.list().some((r) => r.sessionId === id)).toBe(true);
      expect(store.judgedAt(id)).toBeNull();
      expect(errSpy).toHaveBeenCalled();
    } finally { errSpy.mockRestore(); }
    store.close();
  });

  test("a hung provider times out ⇒ kept, unstamped, and the in-flight call is aborted", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store);
    const provider = new HangingProvider();
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await makeCleaner(store, home, provider, { now: agedNow, timeoutMs: 1 }).runPass();
      expect(store.list().some((r) => r.sessionId === id)).toBe(true);
      expect(store.judgedAt(id)).toBeNull();
      expect(provider.requests[0]!.signal?.aborted).toBe(true);
    } finally { errSpy.mockRestore(); }
    store.close();
  });

  test("the ONE leniency: a well-formed object wrapped in a code fence still counts", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store);
    const provider = rawJudge('```json\n{"verdict":"delete","reason":"a bare greeting"}\n```');

    await makeCleaner(store, home, provider, { now: agedNow }).runPass();

    expect(store.list().some((r) => r.sessionId === id)).toBe(false);
    expect(cleanerLines(home)[0].reason).toBe("a bare greeting");
    store.close();
  });

  test("extra keys are tolerated", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store);
    const provider = rawJudge('{"verdict":"keep","reason":"useful","confidence":0.9}');

    await makeCleaner(store, home, provider, { now: agedNow }).runPass();

    expect(store.judgedAt(id)).toBe(agedNow());
    store.close();
  });

  test("a runaway reason is bounded before it reaches the audit log", async () => {
    const { home, store } = freshStore();
    junkSession(store);
    const provider = rawJudge(JSON.stringify({ verdict: "delete", reason: "x".repeat(5000) }));

    await makeCleaner(store, home, provider, { now: agedNow }).runPass();

    expect(cleanerLines(home)[0].reason.length).toBeLessThanOrEqual(200);
    store.close();
  });
});

describe("SessionCleaner — the pre-delete re-check (the session can change mid-judgment)", () => {
  test("a session that becomes ATTACHED while the judge is thinking is not deleted, and not stamped", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store);
    let attached = 0;
    const provider = new MutatingJudge(() => { attached = 1; });
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await makeCleaner(store, home, provider, { now: agedNow, attachedCount: () => attached }).runPass();
      expect(provider.requests).toHaveLength(1); // it was judged...
      expect(store.list().some((r) => r.sessionId === id)).toBe(true); // ...but not deleted
      expect(store.judgedAt(id)).toBeNull(); // ...and NOT stamped — a dropped delete is not a keep
      expect(cleanerLines(home)).toEqual([]);
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes(id))).toBe(true);
    } finally { errSpy.mockRestore(); }
    store.close();
  });

  test("a session ARCHIVED while the judge is thinking is not deleted", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store);
    const provider = new MutatingJudge(() => { store.setArchived(id, true); });
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await makeCleaner(store, home, provider, { now: agedNow }).runPass();
      expect(store.list().some((r) => r.sessionId === id)).toBe(true);
      expect(store.judgedAt(id)).toBeNull();
    } finally { errSpy.mockRestore(); }
    store.close();
  });

  test("a session that gets STAMPED while the judge is thinking is not deleted — `judged IS NULL` is re-verified", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store);
    const provider = new MutatingJudge(() => { store.markJudged(id, 1_754_000_000_000); });
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await makeCleaner(store, home, provider, { now: agedNow }).runPass();
      expect(store.list().some((r) => r.sessionId === id)).toBe(true);
      expect(store.judgedAt(id)).toBe(1_754_000_000_000); // the other writer's stamp, untouched
      expect(cleanerLines(home)).toEqual([]);
    } finally { errSpy.mockRestore(); }
    store.close();
  });

  test("a session that grows a fresh file WRITE while the judge is thinking is not deleted", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store);
    const provider = new MutatingJudge(() => {
      store.append(id, { type: "tool_call", sessionId: id, threadId: "main", callId: "c9", name: "write", argsJson: "{}" });
      store.append(id, { type: "tool_result", sessionId: id, threadId: "main", callId: "c9", output: "ok", isError: false });
    });
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await makeCleaner(store, home, provider, { now: agedNow }).runPass();
      expect(store.list().some((r) => r.sessionId === id)).toBe(true);
      expect(store.judgedAt(id)).toBeNull();
    } finally { errSpy.mockRestore(); }
    store.close();
  });

  // panel-shell T14: proves the open-tabs rail participates in the PRE-DELETE re-check, not only
  // the pre-judge gate — a user can open a panel tab while the judge is mid-thought exactly as they
  // can attach, archive, or write a file (the four precedents above).
  test("a panel tab opened while the judge is thinking is not deleted — the open-tabs rail applies mid-cycle too", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store);
    const provider = new MutatingJudge(() => {
      store.append(id, { type: "panel_tab_opened", sessionId: id, tabId: "t1", kind: "web" });
    });
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await makeCleaner(store, home, provider, { now: agedNow }).runPass();
      expect(store.list().some((r) => r.sessionId === id)).toBe(true);
      expect(store.judgedAt(id)).toBeNull();
    } finally { errSpy.mockRestore(); }
    store.close();
  });
});

describe("SessionCleaner — `cleaner.enabled` hot-toggles the pass (no restart)", () => {
  test("disabled: nothing is queried, judged or deleted — and flipping it back on mid-life runs the very next pass, same instance", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store);
    let enabled = false;
    const provider = deleteVotingJudge();
    // ONE cleaner instance for the whole test — the setting is read live, per pass, so nothing is
    // ever reconstructed and no daemon restart is involved.
    const cleaner = makeCleaner(store, home, provider, { now: agedNow, enabled: () => enabled });

    await cleaner.runPass();
    expect(provider.requests).toHaveLength(0);
    expect(store.list().some((r) => r.sessionId === id)).toBe(true);

    enabled = true; // the settings watcher's atomic swap, as the live getter sees it
    await cleaner.runPass();
    expect(provider.requests).toHaveLength(1);
    expect(store.list().some((r) => r.sessionId === id)).toBe(false);
    store.close();
  });

  test("disabling mid-life stops the NEXT pass (a running daemon needs no restart in either direction)", async () => {
    const { home, store } = freshStore();
    junkSession(store, { ageMs: DAY + 120_000 });
    const second = junkSession(store, { ageMs: DAY + 60_000 });
    let enabled = true;
    const provider = keepVotingJudge();
    const cleaner = makeCleaner(store, home, provider, { now: agedNow, enabled: () => enabled });

    await cleaner.runPass();
    expect(provider.requests).toHaveLength(2);

    enabled = false;
    // A BRAND-NEW eligible candidate: without it the second pass would find nothing to judge anyway
    // (pass 1 stamped both), and the assertion below would hold with the gate deleted — proven by a
    // mutation probe that removed `enabled()` and left this test green.
    const fresh = junkSession(store, { ageMs: DAY + 30_000 });
    await cleaner.runPass();
    expect(provider.requests).toHaveLength(2); // unchanged — the pass was skipped entirely
    expect(store.judgedAt(fresh)).toBeNull();
    expect(store.list().some((r) => r.sessionId === second)).toBe(true);
    store.close();
  });
});

describe("SessionCleaner — resilience (never throws; one bad candidate never aborts the pass)", () => {
  test("a candidate-query failure cleans nothing rather than throwing, and logs a warning", async () => {
    const { home, store } = freshStore();
    const injected = delegatingStore(store, { cleanerCandidateIds: () => { throw new Error("simulated query failure"); } });
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const cleaner = makeCleaner(store, home, deleteVotingJudge(), { now: agedNow, store: injected });
      await expect(cleaner.runPass()).resolves.toEqual({ deleted: [], kept: [] });
      expect(errSpy).toHaveBeenCalled();
    } finally { errSpy.mockRestore(); }
    store.close();
  });

  test("a candidate whose delete throws does not stop the rest of the pass", async () => {
    const { home, store } = freshStore();
    const bad = hungSession(store, { ageMs: DAY + 120_000 });
    const good = hungSession(store, { ageMs: DAY + 60_000 });
    const injected = delegatingStore(store, {
      deleteSession: (id) => {
        if (id === bad) throw new Error("simulated delete failure");
        store.deleteSession(id);
      },
    });
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await makeCleaner(store, home, deleteVotingJudge(), { now: agedNow, store: injected }).runPass();
      expect(result.deleted).toEqual([good]); // the failed one is never reported deleted
      expect(cleanerLines(home).map((l) => l.sessionId)).toEqual([good]);
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes(bad))).toBe(true);
    } finally { errSpy.mockRestore(); }
    store.close();
  });

  test("a failed audit append does not undo or retry the delete, and logs a warning", async () => {
    const { home, store } = freshStore();
    const id = hungSession(store);
    // A `home` that is a FILE makes appendCleanerLog's mkdirSync/appendFileSync throw (the T6
    // reaper test's own trick) without touching real disk limits.
    const bogusHome = join(home, "not-a-directory");
    writeFileSync(bogusHome, "i am a file, not a directory");
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await makeCleaner(store, bogusHome, deleteVotingJudge(), { now: agedNow }).runPass();
      expect(result.deleted).toEqual([id]);
      expect(store.list().some((r) => r.sessionId === id)).toBe(false); // the delete stands
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes(id))).toBe(true);
    } finally { errSpy.mockRestore(); }
    store.close();
  });

  test("the audit line carries the session's title when it had one", async () => {
    const { home, store } = freshStore();
    const id = hungSession(store);
    store.append(id, { type: "session_titled", sessionId: id, threadId: "main", title: "Unanswered question" });

    await makeCleaner(store, home, deleteVotingJudge(), { now: agedNow }).runPass();

    expect(cleanerLines(home)[0]).toEqual({
      sessionId: id, title: "Unanswered question", reason: "hung: no reply", date: new Date(agedNow()).toISOString(),
    });
    store.close();
  });

  test("defaults `now` to the real clock when omitted — a just-written session is nowhere near the gate", async () => {
    const { home, store } = freshStore();
    const id = junkSession(store);
    const provider = deleteVotingJudge();
    const result = await makeCleaner(store, home, provider, { now: undefined }).runPass();
    expect(result).toEqual({ deleted: [], kept: [] });
    expect(store.list().some((r) => r.sessionId === id)).toBe(true);
    store.close();
  });
});

describe("renderTranscript (the ~4 KB head+tail cap)", () => {
  test("a short transcript is rendered whole, role-labeled, tool calls by name only", () => {
    const events: any[] = [
      { type: "session_created", sessionId: "s", scope: "global", seq: 1, ts: 0 },
      { type: "user_message", sessionId: "s", threadId: "main", text: "hi", clientName: "cli", seq: 2, ts: 0 },
      { type: "tool_call", sessionId: "s", threadId: "main", callId: "c", name: "read", argsJson: '{"path":"/etc/passwd"}', seq: 3, ts: 0 },
      { type: "tool_result", sessionId: "s", threadId: "main", callId: "c", output: "SECRET CONTENTS", isError: false, seq: 4, ts: 0 },
      { type: "assistant_message", sessionId: "s", threadId: "main", text: "hello", seq: 5, ts: 0 },
    ];
    const rendered = renderTranscript(events);
    expect(rendered).toBe("[user] hi\n[tool] read\n[norma] hello");
    // Tool ARGUMENTS and OUTPUT never reach the judge — it only needs to know work happened.
    expect(rendered).not.toContain("SECRET CONTENTS");
    expect(rendered).not.toContain("/etc/passwd");
  });

  test("an over-long transcript keeps the HEAD and the TAIL with an explicit trim marker", () => {
    const events: any[] = Array.from({ length: 400 }, (_, i) => ({
      type: "user_message", sessionId: "s", threadId: "main", clientName: "cli", seq: i + 1, ts: 0,
      text: i === 0 ? "FIRST-LINE-MARKER" : i === 399 ? "LAST-LINE-MARKER" : "x".repeat(40),
    }));
    const rendered = renderTranscript(events);
    expect(rendered).toContain("FIRST-LINE-MARKER");
    expect(rendered).toContain("LAST-LINE-MARKER");
    expect(rendered).toContain("trimmed");
    expect(rendered.length).toBeLessThanOrEqual(CLEANER_TRANSCRIPT_MAX_CHARS + 60);
  });

  test("the judge's prompt is capped for a huge session", async () => {
    const { home, store } = freshStore();
    const id = store.createSession("global");
    for (let i = 0; i < 200; i++) {
      store.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "y".repeat(60), clientName: "cli" });
      store.append(id, { type: "assistant_message", sessionId: id, threadId: "main", text: "z".repeat(60) });
    }
    backdateCreatedAt(store, id, DAY + 60_000);
    const provider = keepVotingJudge();

    await makeCleaner(store, home, provider, { now: agedNow }).runPass();

    const content = (provider.requests[0]!.input[0] as { content: string }).content;
    expect(content.length).toBeLessThanOrEqual(CLEANER_TRANSCRIPT_MAX_CHARS + 60);
    store.close();
  });
});

describe("hasUserSetTitle — the title rail is vacuous today, by verification (controller ruling)", () => {
  test("no transcript rails on a title, because no user-set title exists in this system", () => {
    // Every shape a `session_titled` event actually takes in production, all machine-authored:
    const autoTitled: any[] = [
      { type: "session_titled", sessionId: "s", threadId: "main", title: "Casual greeting exchange", seq: 1, ts: 0 },
    ];
    const routineTitled: any[] = [
      { type: "session_titled", sessionId: "s", threadId: "main", title: "routine/nightly-sweep", seq: 1, ts: 0 },
    ];
    expect(hasUserSetTitle(autoTitled)).toBe(false);
    expect(hasUserSetTitle(routineTitled)).toBe(false);
    expect(hasUserSetTitle([])).toBe(false);
  });

  // THE OBLIGATION, written down where it will be read: this test is the tripwire for whoever
  // builds a user set-title mechanism. `SessionTitledEvent` is `{type, threadId, title}` — it
  // carries no source field, so the day a user can name a session, the event needs a discriminator
  // AND `hasUserSetTitle` needs to read it. Until then, a title is Norma's own guess about a
  // session, never the user's investment in one, and must not spare it from judgment.
  test("the event schema still carries no source discriminator — the reason the rail cannot be honest yet", () => {
    const titled: any = { type: "session_titled", sessionId: "s", threadId: "main", title: "t", seq: 1, ts: 0 };
    const parsed = SessionEvent.parse(titled);
    expect(Object.keys(parsed).sort()).toEqual(["seq", "sessionId", "threadId", "title", "ts", "type"]);
  });
});
