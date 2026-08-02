import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@norma/protocol";
import { SessionStore, EMPTY_SESSION_GRACE_MS } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { appendCleanerLog } from "../../src/sessions/cleaner-log";
import { reapEmptySessions, type ReaperStore } from "../../src/sessions/reaper";
import { startIpcServer } from "../../src/ipc/server";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";

/** Test-only backdoor: pushes a session's stored `created_at` back by `ms`, so a wiring test can
 *  prove the REAL (un-injected) `Date.now()` sweep reaps a genuinely old candidate without a real
 *  10-minute sleep. `createSession` itself has no clock injection (unlike `emptySessionIds`, which
 *  takes `nowMs` as a parameter) — this reaches past the `private` TS-only annotation on
 *  `SessionStore.db` (still a plain runtime property) rather than widening the class's real surface
 *  for a need only this one integration test has. */
function backdateCreatedAt(store: SessionStore, sessionId: string, ms: number): void {
  (store as unknown as { db: { run(sql: string, params: unknown[]): void } }).db.run(
    "UPDATE sessions SET created_at = created_at - ? WHERE session_id = ?", [ms, sessionId],
  );
}

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

  // Controller ruling: "chat sessions ARE reapable when empty — the spec's motivating case is the
  // abandoned New Chat. The code/cowork participation rule limits ACTIVITY states, not the reaper."
  // Pinned explicitly (not just "not excluded by omission") since the activity-participation
  // allowlist (activity.ts's ACTIVITY_MODES = code/cowork only) could otherwise look like a
  // precedent this reaper should mirror — it must not: `emptySessionIds` excludes ONLY the dispatch
  // mode, nothing else.
  test("a chat session IS a candidate when empty — the reaper only excludes dispatch, not chat", () => {
    const store = freshStore();
    const chatId = store.createSession("global", { mode: "chat" });
    expect(store.emptySessionIds(NOBODY_ATTACHED, agedNow(store, chatId, 1))).toEqual([chatId]);
    store.close();
  });

  // Controller ruling: "Phone-synced empties have NO rail here — §2 of the spec has no exclusions
  // beyond the dispatch session; the Task-7 cleaner is where synced sessions get railed." A synced
  // session's id is a UUID (SYNCED_SESSION_ID_RE), created via `createSynced` rather than
  // `createSession` — `emptySessionIds`'s query has no id-shape/origin check at all, so this is
  // exercised directly against the real synced-creation path rather than assumed from the code
  // simply not mentioning it.
  test("a phone-synced session (createSynced, UUID id) IS a candidate when empty — no rail here by design", () => {
    const store = freshStore();
    const syncedId = "11111111-2222-4333-8444-555555555555";
    store.createSynced(syncedId, { scope: "global" });
    expect(store.emptySessionIds(NOBODY_ATTACHED, agedNow(store, syncedId, 1))).toEqual([syncedId]);
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

describe("appendCleanerLog (session-activity-hygiene T6)", () => {
  test("creates the file if missing and appends one NDJSON line matching the spec shape", () => {
    const home = mkdtempSync(join(tmpdir(), "norma-reaper-test-"));
    const logPath = join(home, "cleaner.jsonl");
    expect(existsSync(logPath)).toBe(false);
    appendCleanerLog(home, { sessionId: "s_abc123", title: "Abandoned chat", reason: "reaped: empty", date: "2026-08-02T00:00:00.000Z" });
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      sessionId: "s_abc123", title: "Abandoned chat", reason: "reaped: empty", date: "2026-08-02T00:00:00.000Z",
    });
  });

  test("appends without truncating existing lines", () => {
    const home = mkdtempSync(join(tmpdir(), "norma-reaper-test-"));
    appendCleanerLog(home, { sessionId: "s_1", reason: "reaped: empty", date: "2026-08-02T00:00:00.000Z" });
    appendCleanerLog(home, { sessionId: "s_2", reason: "reaped: empty", date: "2026-08-02T00:01:00.000Z" });
    const lines = readFileSync(join(home, "cleaner.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).sessionId).toBe("s_1");
    expect(JSON.parse(lines[1]!).sessionId).toBe("s_2");
  });

  test("an absent title is omitted from the line entirely, never written as null", () => {
    const home = mkdtempSync(join(tmpdir(), "norma-reaper-test-"));
    appendCleanerLog(home, { sessionId: "s_1", reason: "reaped: empty", date: "2026-08-02T00:00:00.000Z" });
    const parsed = JSON.parse(readFileSync(join(home, "cleaner.jsonl"), "utf8").trim());
    expect("title" in parsed).toBe(false);
  });
});

describe("reapEmptySessions (session-activity-hygiene T6)", () => {
  function tempHome(): string { return mkdtempSync(join(tmpdir(), "norma-reaper-test-")); }
  function cleanerLines(home: string): any[] {
    if (!existsSync(join(home, "cleaner.jsonl"))) return [];
    return readFileSync(join(home, "cleaner.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  test("reaps an eligible candidate: deletes it and appends the audit line with reason 'reaped: empty'", () => {
    const home = tempHome();
    const store = new SessionStore(home);
    const id = store.createSession("global");
    store.append(id, { type: "session_titled", sessionId: id, threadId: "main", title: "Untitled experiment" });
    const nowMs = agedNow(store, id, 1);

    const reaped = reapEmptySessions({ store, attachedCount: NOBODY_ATTACHED, home, now: () => nowMs });

    expect(reaped).toEqual([id]);
    expect(store.list().some((r) => r.sessionId === id)).toBe(false);
    const lines = cleanerLines(home);
    expect(lines).toEqual([
      { sessionId: id, title: "Untitled experiment", reason: "reaped: empty", date: new Date(nowMs).toISOString() },
    ]);
    store.close();
  });

  test("leaves attached empties alone — no delete, no audit line", () => {
    const home = tempHome();
    const store = new SessionStore(home);
    const id = store.createSession("global");
    const nowMs = agedNow(store, id, 1);

    const reaped = reapEmptySessions({ store, attachedCount: () => 1, home, now: () => nowMs });

    expect(reaped).toEqual([]);
    expect(store.list().some((r) => r.sessionId === id)).toBe(true);
    expect(cleanerLines(home)).toEqual([]);
    store.close();
  });

  test("the just-minted session itself is never reaped by its own sweep", () => {
    const home = tempHome();
    const store = new SessionStore(home);
    const id = store.createSession("global");
    const createdAt = createdAtOf(store, id);

    // No time has passed at all — the sweep a `session.create` call triggers runs against the
    // session it JUST minted, at (as close to) the same instant.
    const reaped = reapEmptySessions({ store, attachedCount: NOBODY_ATTACHED, home, now: () => createdAt });

    expect(reaped).toEqual([]);
    expect(store.list().some((r) => r.sessionId === id)).toBe(true);
    store.close();
  });

  test("never reaps the dispatch session, even old/empty/unattached, end-to-end through the sweep", () => {
    const home = tempHome();
    const store = new SessionStore(home);
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    const nowMs = agedNow(store, dispatchId, 1);

    const reaped = reapEmptySessions({ store, attachedCount: NOBODY_ATTACHED, home, now: () => nowMs });

    expect(reaped).toEqual([]);
    expect(store.list().some((r) => r.sessionId === dispatchId)).toBe(true);
    store.close();
  });

  test("defaults `now` to the real clock when omitted", () => {
    const home = tempHome();
    const store = new SessionStore(home);
    const id = store.createSession("global");
    // Just-minted under the REAL clock: still inside the 10-minute grace window.
    const reaped = reapEmptySessions({ store, attachedCount: NOBODY_ATTACHED, home });
    expect(reaped).toEqual([]);
    expect(store.list().some((r) => r.sessionId === id)).toBe(true);
    store.close();
  });

  // ---- Resilience: a narrow structural fake (ReaperStore), not a real SessionStore, since these
  // failure modes (one candidate's delete throwing while another succeeds) aren't easy to provoke
  // deliberately against the real sqlite/fs-backed store on a single call.

  function fakeStore(over: Partial<ReaperStore> = {}): ReaperStore {
    return {
      emptySessionIds: over.emptySessionIds ?? (() => []),
      getTitle: over.getTitle ?? (() => null),
      deleteSession: over.deleteSession ?? (() => {}),
    };
  }

  test("a candidate that fails to delete does not stop the rest of the sweep, and logs a warning", () => {
    const home = tempHome();
    const deleted: string[] = [];
    const store = fakeStore({
      emptySessionIds: () => ["s_bad", "s_good"],
      getTitle: () => null,
      deleteSession: (id) => {
        if (id === "s_bad") throw new Error("simulated delete failure");
        deleted.push(id);
      },
    });

    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const reaped = reapEmptySessions({ store, attachedCount: NOBODY_ATTACHED, home, now: () => 1_700_000_000_000 });
      expect(deleted).toEqual(["s_good"]);
      expect(reaped).toEqual(["s_good"]); // the failed one is never reported reaped
      expect(cleanerLines(home).map((l) => l.sessionId)).toEqual(["s_good"]);
      // "A sweep error is a daemon-log warning, never a thrown error" — pinned, not just implied by
      // the absence of a throw.
      expect(errSpy).toHaveBeenCalled();
      expect(errSpy.mock.calls.some((call) => String(call[0]).includes("s_bad"))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("a failed audit-log append does not undo or retry the delete, and logs a warning", () => {
    // A `home` that is actually a FILE (not a directory) makes appendCleanerLog's mkdirSync/
    // appendFileSync throw — simulating a disk/permissions failure without touching real fs limits.
    const parent = mkdtempSync(join(tmpdir(), "norma-reaper-test-"));
    const bogusHome = join(parent, "not-a-directory");
    writeFileSync(bogusHome, "i am a file, not a directory");
    const deleted: string[] = [];
    const store = fakeStore({
      emptySessionIds: () => ["s_1"],
      deleteSession: (id) => { deleted.push(id); },
    });

    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const reaped = reapEmptySessions({ store, attachedCount: NOBODY_ATTACHED, home: bogusHome, now: () => 1_700_000_000_000 });
      expect(deleted).toEqual(["s_1"]); // the delete happened...
      expect(reaped).toEqual(["s_1"]); // ...and is reported reaped regardless of the audit failure
      expect(errSpy).toHaveBeenCalled();
      expect(errSpy.mock.calls.some((call) => String(call[0]).includes("s_1"))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("a candidate query failure reaps nothing rather than throwing, and logs a warning", () => {
    const home = tempHome();
    const store = fakeStore({
      emptySessionIds: () => { throw new Error("simulated query failure"); },
    });
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => reapEmptySessions({ store, attachedCount: NOBODY_ATTACHED, home, now: () => 1_700_000_000_000 })).not.toThrow();
      expect(reapEmptySessions({ store, attachedCount: NOBODY_ATTACHED, home, now: () => 1_700_000_000_000 })).toEqual([]);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});

/** Minimal raw NDJSON JSON-RPC client (this codebase's convention: no shared test-harness module —
 *  cf. activity-enforcement.test.ts's own copy). Only what these wiring tests need: hello + request. */
class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;

  static async connect(socketPath: string): Promise<TestClient> {
    const c = new TestClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && c.pending.has(msg.id)) {
              c.pending.get(msg.id)!(msg);
              c.pending.delete(msg.id);
            }
          }
        },
        drain(_s) { c.writer.onDrain(); },
      },
    });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    return c;
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  hello(token: string, clientName: string, role = "harness"): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role, token, clientName });
  }

  close(): void { this.socket.end(); }
}

async function waitFor(pred: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("wired: session.create's mint-time sweep (session-activity-hygiene T6)", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(withNormaHome: boolean): Promise<{ store: SessionStore; hub: SessionHub; socketPath: string; harnessToken: string; home: string }> {
    const home = mkdtempSync(join(tmpdir(), "norma-reaper-wire-"));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({
      socketPath, serverVersion: "test", tokens: authority, store, hub,
      normaHome: withNormaHome ? home : undefined,
    });
    stop = () => { server.stop(); store.close(); };
    return { store, hub, socketPath, harnessToken: tokens.harness, home };
  }

  test("session.create replies normally, and the brand-new session is never reaped by its own sweep", async () => {
    const { store, socketPath, harnessToken } = await boot(true);
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "harness");
    const res = await c.request(METHODS.sessionCreate, { scope: "global" });
    expect(res.result.sessionId).toBeTruthy();
    const sessionId = res.result.sessionId as string;

    // Give the fire-and-forget sweep a moment to run (it's deferred, never awaited by the reply).
    await new Promise((r) => setTimeout(r, 20));
    expect(store.list().some((r) => r.sessionId === sessionId)).toBe(true);
    c.close();
  });

  test("an old, empty, unattached candidate is reaped as a side effect of a LATER session.create call", async () => {
    const { store, socketPath, harnessToken, home } = await boot(true);
    const oldId = store.createSession("global");
    backdateCreatedAt(store, oldId, EMPTY_SESSION_GRACE_MS + 1);

    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "harness");
    const res = await c.request(METHODS.sessionCreate, { scope: "global" }); // triggers the sweep
    expect(res.result.sessionId).toBeTruthy();

    await waitFor(() => !store.list().some((r) => r.sessionId === oldId), "the old candidate to be reaped");
    const lines = readFileSync(join(home, "cleaner.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.some((l) => l.sessionId === oldId && l.reason === "reaped: empty")).toBe(true);
    c.close();
  });

  // Leak check (controller instruction): does deleting a session leave a stale timer/listener/map
  // entry behind in the hub or the activity-enforcement module, both of which key private in-memory
  // state off sessionId? `hub.attachedCount === 0` is ALREADY a precondition `emptySessionIds`
  // enforces, so the ONE enforcement hook that can touch bookkeeping for a still-empty session
  // (`onAttached`, which cares only about attachment, never content) is exercised here deliberately
  // — attach then fully detach BEFORE reaping — to prove the paired detach already cleared it, and
  // that the shared hub/enforcement singleton keeps working correctly for a DIFFERENT session
  // afterward.
  test("a reaped session that was attached-then-detached before deletion leaves no stale state behind", async () => {
    const { store, hub, socketPath, harnessToken } = await boot(true);
    const oldId = store.createSession("global");

    const viewer = await TestClient.connect(socketPath);
    await viewer.hello(harnessToken, "orb");
    await viewer.request(METHODS.sessionAttach, { sessionId: oldId });
    expect(hub.attachedCount(oldId)).toBe(1);
    viewer.close();
    await waitFor(() => hub.attachedCount(oldId) === 0, "the detach to land");

    backdateCreatedAt(store, oldId, EMPTY_SESSION_GRACE_MS + 1);
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "harness");
    await c.request(METHODS.sessionCreate, { scope: "global" }); // triggers the sweep
    await waitFor(() => !store.list().some((r) => r.sessionId === oldId), "the old candidate to be reaped");

    // The dead id itself stays a safe, non-throwing default...
    expect(hub.attachedCount(oldId)).toBe(0);
    // ...and — the actual leak check — the shared hub/enforcement singleton is still healthy for a
    // FRESH session: if the deleted id's bookkeeping had wedged shared state, this is where it
    // would misbehave (wrong activity, a hang, a thrown error) rather than in isolation.
    const freshId = store.createSession("global");
    const fresh = await TestClient.connect(socketPath);
    await fresh.hello(harnessToken, "fresh-viewer");
    await fresh.request(METHODS.sessionAttach, { sessionId: freshId });
    const listed = await fresh.request(METHODS.sessionList, {});
    expect(listed.result.sessions.find((s: any) => s.sessionId === freshId)?.activity).toBe("active");
    fresh.close();
    c.close();
  });

  test("with no normaHome wired, session.create still works and never throws over the sweep", async () => {
    const { socketPath, harnessToken } = await boot(false);
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "harness");
    const res = await c.request(METHODS.sessionCreate, { scope: "global" });
    expect(res.result.sessionId).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20)); // nothing should throw/crash in the background either
    c.close();
  });
});

describe("wired: daemon.ts's boot sweep (session-activity-hygiene T6)", () => {
  let daemon: RunningDaemon | undefined;
  afterEach(() => { daemon?.stop(); daemon = undefined; });

  test("an old, empty, unattached session left over from a previous run is gone after the NEXT boot", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-reaper-boot-"));
    // Seed the leftover candidate using a throwaway SessionStore instance, exactly as a previous
    // daemon run would have left it on disk — then close it before startDaemon opens its own (a
    // second live sqlite writer on the same file, even briefly, is unnecessary risk to take on).
    const seed = new SessionStore(home);
    const oldId = seed.createSession("global");
    backdateCreatedAt(seed, oldId, EMPTY_SESSION_GRACE_MS + 1);
    seed.close();

    const secrets = new FileSecretStore(join(home, "test-secrets"));
    daemon = await startDaemon({ home, secrets, agentProvider: null });

    // Verified through the daemon's OWN socket (never a second SessionStore instance opened
    // against the same file while the daemon's is live) — the same convention every other
    // real-daemon test in this codebase uses to observe server-side state.
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(daemon.tokens.harness, "boot-sweep-checker");
    await waitFor(async () => {
      const res = await c.request(METHODS.sessionList, {});
      return !res.result.sessions.some((s: any) => s.sessionId === oldId);
    }, "the leftover candidate to be reaped at boot");
    const lines = readFileSync(join(home, "cleaner.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.some((l) => l.sessionId === oldId && l.reason === "reaped: empty")).toBe(true);
    c.close();
  });
});
