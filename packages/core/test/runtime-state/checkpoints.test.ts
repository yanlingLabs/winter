import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../src/runtime-state/db";
import { ProjectionCheckpoints, ProjectionCursorMismatchError, type ProjectionCheckpoint, type ProjectionMark } from "../../src/runtime-state/checkpoints";
import { SessionStore } from "../../src/sessions/store";
import { withTempHome } from "./support";

const S = "s_alpha";
/**
 * `lastWinterSeq` is a REQUIRED argument here because `complete` now refuses a cursor that disagrees
 * with the appended range (fix round 1, minor 2) — a helper that defaulted it would quietly hide the
 * very disagreement the check exists to surface.
 */
const CURSOR = (lastWinterSeq: number, over: Partial<Omit<ProjectionCheckpoint, "winterSessionId" | "generation" | "updatedAt">> = {}) => ({
  runtimeKind: "claude-agent" as const, backendSessionId: "be_1", backendCursor: "line:42", lastWinterSeq,
  sourceDigest: "sha256:abc", ...over,
});

/** A checkpoints instance with a frozen clock, so `updatedAt` is an assertion and not a wobble. */
const at = (rs: RuntimeStateDb, stamp = "2026-09-10T12:00:00.000Z") => new ProjectionCheckpoints(rs, () => stamp);

describe("ProjectionCheckpoints — the begin/append/complete contract", () => {
  test("begin twice for the same source is 'pending-elsewhere' — never a second projection", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const cp = at(rs);
        expect(cp.begin({ winterSessionId: S, generation: 1, sourceId: "toolu_01" })).toBe("begun");
        expect(cp.begin({ winterSessionId: S, generation: 1, sourceId: "toolu_01" })).toBe("pending-elsewhere");
      } finally { rs.close(); }
    });
  });

  test("begin after complete is 'already-committed' — the replay-safety property", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const cp = at(rs);
        expect(cp.begin({ winterSessionId: S, generation: 1, sourceId: "toolu_01" })).toBe("begun");
        cp.complete({ winterSessionId: S, generation: 1, sourceId: "toolu_01" }, CURSOR(9), { first: 7, last: 9 });
        expect(cp.begin({ winterSessionId: S, generation: 1, sourceId: "toolu_01" })).toBe("already-committed");
        // A DIFFERENT source in the same generation is untouched by that.
        expect(cp.begin({ winterSessionId: S, generation: 1, sourceId: "toolu_02" })).toBe("begun");
        // So is the SAME source in a different generation — a new incarnation re-projects.
        expect(cp.begin({ winterSessionId: S, generation: 2, sourceId: "toolu_01" })).toBe("begun");
      } finally { rs.close(); }
    });
  });

  test("complete marks the source committed and advances the cursor in ONE transaction", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const cp = at(rs);
        cp.begin({ winterSessionId: S, generation: 1, sourceId: "toolu_01" });
        const checkpoint = cp.complete({ winterSessionId: S, generation: 1, sourceId: "toolu_01" }, CURSOR(9), { first: 7, last: 9 });
        expect(checkpoint).toEqual({
          winterSessionId: S, generation: 1, runtimeKind: "claude-agent", backendSessionId: "be_1",
          backendCursor: "line:42", lastWinterSeq: 9, sourceDigest: "sha256:abc", updatedAt: "2026-09-10T12:00:00.000Z",
        });
        expect(cp.get(S, 1)).toEqual(checkpoint);
        expect(cp.pending()).toEqual([]);
        const [mark] = rs.db.query<{ state: string; first_winter_seq: number; last_winter_seq: number }, []>("SELECT state, first_winter_seq, last_winter_seq FROM projection_applied").all();
        expect(mark).toEqual({ state: "committed", first_winter_seq: 7, last_winter_seq: 9 });
      } finally { rs.close(); }
    });
  });

  test("when the cursor write fails, NEITHER row changes — the mark stays pending", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const cp = at(rs);
        cp.begin({ winterSessionId: S, generation: 1, sourceId: "toolu_01" });
        // `backend_cursor` is NOT NULL: this is the write half failing after the mark half ran.
        expect(() => cp.complete({ winterSessionId: S, generation: 1, sourceId: "toolu_01" }, CURSOR(9, { backendCursor: null as unknown as string }), { first: 7, last: 9 })).toThrow();
        expect(cp.get(S, 1)).toBeUndefined();
        expect(cp.pending()).toEqual([{ winterSessionId: S, generation: 1, sourceId: "toolu_01", state: "pending", updatedAt: "2026-09-10T12:00:00.000Z" }]);
        // And the pending mark is still a mark: `begin` refuses a second projection of the source.
        expect(cp.begin({ winterSessionId: S, generation: 1, sourceId: "toolu_01" })).toBe("pending-elsewhere");
      } finally { rs.close(); }
    });
  });

  test("pending() lists pending marks, optionally scoped to one session", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const cp = at(rs);
        cp.begin({ winterSessionId: S, generation: 1, sourceId: "toolu_01" });
        cp.begin({ winterSessionId: S, generation: 1, sourceId: "toolu_02" });
        cp.begin({ winterSessionId: "s_beta", generation: 4, sourceId: "uuid_x" });
        cp.complete({ winterSessionId: S, generation: 1, sourceId: "toolu_02" }, CURSOR(2), { first: 1, last: 2 });
        expect(cp.pending().map((m) => `${m.winterSessionId}/${m.generation}/${m.sourceId}`)).toEqual([`${S}/1/toolu_01`, "s_beta/4/uuid_x"]);
        expect(cp.pending(S)).toEqual([{ winterSessionId: S, generation: 1, sourceId: "toolu_01", state: "pending", updatedAt: "2026-09-10T12:00:00.000Z" }]);
        expect(cp.pending("s_gamma")).toEqual([]);
      } finally { rs.close(); }
    });
  });

  test("resolvePending: the tail proves it landed → committed; it does not → reset, and begin is 'begun' again", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const cp = at(rs);
        cp.begin({ winterSessionId: S, generation: 1, sourceId: "landed" });
        cp.begin({ winterSessionId: S, generation: 1, sourceId: "lost" });

        const [landed, lost] = cp.pending() as [ProjectionMark, ProjectionMark];
        expect(cp.resolvePending(landed, () => true)).toBe("committed");
        expect(cp.begin({ winterSessionId: S, generation: 1, sourceId: "landed" })).toBe("already-committed");

        expect(cp.resolvePending(lost, () => false)).toBe("reset");
        expect(cp.pending()).toEqual([]);
        expect(cp.begin({ winterSessionId: S, generation: 1, sourceId: "lost" })).toBe("begun");
      } finally { rs.close(); }
    });
  });

  test("a STALE pending mark can never erase a committed one — it reports 'already-resolved'", async () => {
    // Fix round 1, important 1. A ProjectionMark is a VALUE read at an earlier instant. If the
    // source is completed between the `pending()` read and the resolve, a `false` predicate keyed
    // only on (session, generation, source) would DELETE the committed mark — after which `begin`
    // says "begun" and the projector re-appends events already in the product log.
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const cp = at(rs);
        const key = { winterSessionId: S, generation: 1, sourceId: "toolu_01" };
        cp.begin(key);
        const stale = cp.pending()[0] as ProjectionMark;   // read while still pending…
        cp.complete(key, CURSOR(3), { first: 1, last: 3 }); // …and completed by someone else meanwhile

        expect(cp.resolvePending(stale, () => false)).toBe("already-resolved");
        expect(cp.begin(key)).toBe("already-committed");
        expect(cp.get(S, 1)?.lastWinterSeq).toBe(3);
        expect(rs.db.query<{ state: string }, []>("SELECT state FROM projection_applied").all()).toEqual([{ state: "committed" }]);

        // The `true` branch must not lie either: it changed no row, so it claims no transition.
        expect(cp.resolvePending(stale, () => true)).toBe("already-resolved");
        // Nor may a mark that was already RESET report a second reset.
        cp.begin({ ...key, sourceId: "gone" });
        const goneMark = cp.pending()[0] as ProjectionMark;
        expect(cp.resolvePending(goneMark, () => false)).toBe("reset");
        expect(cp.resolvePending(goneMark, () => false)).toBe("already-resolved");
      } finally { rs.close(); }
    });
  });

  test("complete refuses a cursor whose lastWinterSeq disagrees with the appended range", async () => {
    // Fix round 1, minor 2: the field used to be silently discarded, which hid projector bugs.
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const cp = at(rs);
        const key = { winterSessionId: S, generation: 1, sourceId: "toolu_01" };
        cp.begin(key);
        expect(() => cp.complete(key, CURSOR(4), { first: 1, last: 9 })).toThrow(ProjectionCursorMismatchError);
        expect(() => cp.complete(key, CURSOR(4), { first: 1, last: 9 })).toThrow(/cursor\.lastWinterSeq=4, seqs\.last=9/);
        // It throws BEFORE anything is written: no cursor row, and the mark is untouched.
        expect(cp.get(S, 1)).toBeUndefined();
        expect(cp.pending()).toHaveLength(1);
        // And agreement is all it wants.
        expect(cp.complete(key, CURSOR(9), { first: 1, last: 9 }).lastWinterSeq).toBe(9);
      } finally { rs.close(); }
    });
  });

  test("resolvePending hands the predicate the mark's own seq range", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const cp = at(rs);
        cp.begin({ winterSessionId: S, generation: 1, sourceId: "toolu_01" });
        const seen: ProjectionMark[] = [];
        cp.resolvePending(cp.pending()[0] as ProjectionMark, (m) => { seen.push(m); return true; });
        expect(seen).toEqual([{ winterSessionId: S, generation: 1, sourceId: "toolu_01", state: "pending", updatedAt: "2026-09-10T12:00:00.000Z" }]);
      } finally { rs.close(); }
    });
  });

  test("latest() returns the highest generation's checkpoint, and survives a reopen", async () => {
    await withTempHome(async (home) => {
      const first = openRuntimeStateDb(home);
      const cp = at(first);
      cp.complete({ winterSessionId: S, generation: 1, sourceId: "a" }, CURSOR(1, { backendCursor: "line:1" }), { first: 1, last: 1 });
      cp.complete({ winterSessionId: S, generation: 3, sourceId: "b" }, CURSOR(5, { backendCursor: "line:3" }), { first: 2, last: 5 });
      cp.complete({ winterSessionId: S, generation: 2, sourceId: "c" }, CURSOR(6, { backendCursor: "line:2" }), { first: 6, last: 6 });
      cp.complete({ winterSessionId: "s_beta", generation: 9, sourceId: "d" }, CURSOR(1, { backendCursor: "other" }), { first: 1, last: 1 });
      expect(cp.latest(S)?.generation).toBe(3);
      expect(cp.latest(S)?.backendCursor).toBe("line:3");
      expect(cp.latest("s_gamma")).toBeUndefined();
      first.close();

      const second = openRuntimeStateDb(home);
      try {
        const reopened = at(second);
        expect(reopened.latest(S)?.backendCursor).toBe("line:3");
        expect(reopened.get(S, 2)?.backendCursor).toBe("line:2");
      } finally { second.close(); }
    });
  });

  test("a re-complete of the same generation upserts the cursor rather than duplicating it", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const cp = at(rs);
        cp.complete({ winterSessionId: S, generation: 1, sourceId: "a" }, CURSOR(1, { backendCursor: "line:1" }), { first: 1, last: 1 });
        cp.complete({ winterSessionId: S, generation: 1, sourceId: "b" }, CURSOR(4, { backendCursor: "line:2" }), { first: 2, last: 4 });
        expect(rs.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runtime_projection_cursors").get()?.n).toBe(1);
        expect(cp.get(S, 1)).toEqual({ winterSessionId: S, generation: 1, runtimeKind: "claude-agent", backendSessionId: "be_1", backendCursor: "line:2", lastWinterSeq: 4, sourceDigest: "sha256:abc", updatedAt: "2026-09-10T12:00:00.000Z" });
      } finally { rs.close(); }
    });
  });

  test("optional cursor fields are absent, not null, when the caller omits them", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const cp = at(rs);
        cp.complete({ winterSessionId: S, generation: 1, sourceId: "a" }, { runtimeKind: "winter-agent", backendCursor: "seq:12", lastWinterSeq: 3 }, { first: 1, last: 3 });
        const got = cp.get(S, 1);
        expect(got).toEqual({ winterSessionId: S, generation: 1, runtimeKind: "winter-agent", backendCursor: "seq:12", lastWinterSeq: 3, updatedAt: "2026-09-10T12:00:00.000Z" });
        expect("backendSessionId" in (got as object)).toBe(false);
        expect("sourceDigest" in (got as object)).toBe(false);
      } finally { rs.close(); }
    });
  });
});

describe("ProjectionCheckpoints — cursors are opaque", () => {
  test("a cursor that LOOKS like a timestamp is stored and returned byte-for-byte", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const cp = at(rs, "NOW-STAMP");
        cp.complete({ winterSessionId: S, generation: 1, sourceId: "a" }, CURSOR(1, { backendCursor: "2026-09-10T00:00:00.000Z" }), { first: 1, last: 1 });
        expect(cp.get(S, 1)?.backendCursor).toBe("2026-09-10T00:00:00.000Z");
        // The clock reaches `updatedAt` and NOTHING else — a cursor is never a wall-clock reading.
        expect(cp.get(S, 1)?.updatedAt).toBe("NOW-STAMP");
        expect(rs.db.query<{ backend_cursor: string }, []>("SELECT backend_cursor FROM runtime_projection_cursors").get()?.backend_cursor).toBe("2026-09-10T00:00:00.000Z");
      } finally { rs.close(); }
    });
  });

  test("the API contains exactly one clock reading, and it is the injectable `now` default", () => {
    // The docstring promise ("never a wall-clock cursor") is only worth what a tripwire makes it
    // worth: any second `new Date(` in this file is a candidate for having generated a cursor.
    const source = readFileSync(join(import.meta.dir, "../../src/runtime-state/checkpoints.ts"), "utf8");
    const clockLines = source.split("\n").filter((l) => l.includes("new Date(") || l.includes("Date.now("));
    expect(clockLines.length).toBe(1);
    expect(clockLines[0]).toContain("now");
  });
});

describe("ProjectionCheckpoints — the documented begin → append → complete cycle", () => {
  test("a crash between append and complete leaves a pending mark the product log can resolve", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      const sessions = new SessionStore(home);
      try {
        const cp = at(rs);
        const sessionId = sessions.createSession("global");

        // Turn 1: the full cycle. begin → append → complete.
        expect(cp.begin({ winterSessionId: sessionId, generation: 1, sourceId: "toolu_01" })).toBe("begun");
        const first = sessions.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "toolu_01 landed" });
        cp.complete({ winterSessionId: sessionId, generation: 1, sourceId: "toolu_01" }, CURSOR(first.seq, { backendCursor: "line:1" }), { first: first.seq, last: first.seq });

        // Turn 2: the crash window — begin and append ran, `complete` never did.
        expect(cp.begin({ winterSessionId: sessionId, generation: 1, sourceId: "toolu_02" })).toBe("begun");
        const second = sessions.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "toolu_02 landed" });

        // Turn 3: begin ran, the append did NOT.
        expect(cp.begin({ winterSessionId: sessionId, generation: 1, sourceId: "toolu_03" })).toBe("begun");

        // Recovery: 8b's real predicate inspects the product log tail for the mark's source id.
        const tail = sessions.read(sessionId, 0);
        const tailContains = (mark: ProjectionMark) => tail.some((e) => e.type === "assistant_message" && e.text.includes(mark.sourceId));
        const outcomes = cp.pending(sessionId).map((m) => [m.sourceId, cp.resolvePending(m, tailContains)]);
        expect(outcomes).toEqual([["toolu_02", "committed"], ["toolu_03", "reset"]]);

        // The one that landed is never re-applied; the one that did not is projected again.
        expect(cp.begin({ winterSessionId: sessionId, generation: 1, sourceId: "toolu_02" })).toBe("already-committed");
        expect(cp.begin({ winterSessionId: sessionId, generation: 1, sourceId: "toolu_03" })).toBe("begun");
        expect(second.seq).toBeGreaterThan(first.seq);
      } finally { rs.close(); sessions.close(); }
    });
  });
});
