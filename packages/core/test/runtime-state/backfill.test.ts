import { describe, expect, test } from "bun:test";
import { transcriptProjectKey } from "@yanlinglabs/winter-agent-sdk";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { repoRootFor, sanitizeProjectKey, _clearRepoRootCacheForTests } from "../../src/agent/memory-dir";
import { openRuntimeStateDb, RuntimeSessionRecords, backfillNativeSessions } from "../../src/runtime-state";
import { SessionStore } from "../../src/sessions/store";
import { withTempHome } from "./support";

const SYNCED_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

/** A cwd that exists on disk — `repoRootFor` canonicalizes through `realpathSync`, and the whole
 *  point of Task 10 is that the two key algorithms disagree about the SAME directory. */
function workdir(home: string, name: string): string {
  const dir = join(home, "work", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("backfillNativeSessions", () => {
  test("every native session without a record becomes a legacy winter-agent record", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const cwdA = workdir(home, "a");
      const cwdB = workdir(home, "b");
      const a = store.createSession("work", { cwd: cwdA, model: "gpt-5.4" });
      const b = store.createSession("work", { cwd: cwdB });
      store.append(a, { type: "user_message", sessionId: a, threadId: "main", text: "hello", clientName: "test" });
      store.append(b, { type: "user_message", sessionId: b, threadId: "main", text: "hello", clientName: "test" });

      const rs = openRuntimeStateDb(home);
      try {
        const report = backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        expect(report.created.sort()).toEqual([a, b].sort());
        expect(report.alreadyPresent).toEqual([]);
        expect(report.errors).toEqual([]);

        const records = new RuntimeSessionRecords(rs);
        const ra = records.get(a)!;
        expect(ra.runtimeKind).toBe("winter-agent");
        // No compatibility transcript exists for a legacy session — the mapping must stay empty
        // rather than point at a file nobody wrote (WS-16 §17 step 4).
        expect(ra.backendSessionId).toBeUndefined();
        expect(ra.providerId).toBe("codex-oauth");
        expect(ra.modelRef).toBe("gpt-5.4");
        expect(ra.versionProvenance).toBe("legacy-unknown");
        expect(ra.transcriptHealth).toBe("unsupported");
        expect(ra.transcriptDialect).toBe("claude-code-jsonl");
        expect(ra.compatibilityLevel).toBe("conversation");
        expect(ra.conformanceCorpusVersion).toBe("legacy");
        expect(ra.capabilities).toContain("import-conversation");
        expect(ra.generation).toBe(0);

        // The two key algorithms, both spelled from their own source of truth.
        expect(ra.transcriptProjectKey).toBe(transcriptProjectKey(cwdA));
        expect(ra.memoryProjectKey).toBe(sanitizeProjectKey(repoRootFor(cwdA)));
        expect(ra.tempProjectKey).toBe(ra.transcriptProjectKey);
        expect(ra.transcriptProjectKey).not.toBe(ra.memoryProjectKey);

        // A session with no recorded model is honest about it rather than inheriting a plausible one.
        expect(records.get(b)!.modelRef).toBe("unknown");
      } finally {
        rs.close();
      }
    });
  });

  test("the backfilled selection records honest values, never a borrowed auth family", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const oauth = store.createSession("work", { cwd: workdir(home, "oauth"), model: "gpt-5.4" });
      const rs = openRuntimeStateDb(home);
      try {
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const selection = new RuntimeSessionRecords(rs).get(oauth)!.selection;
        expect(selection.runtimeKind).toBe("winter-agent");
        expect(selection.providerId).toBe("codex-oauth");
        expect(selection.modelRef).toBe("gpt-5.4");
        expect(selection.family).toBe("legacy");
        // An OAuth-backed provider is NOT an api-key provider — 8b's reviewPersistedSelection
        // refuses a record that says otherwise.
        expect(selection.authFamily).toBe("custom");
        expect(selection.sdkVersion).toBe("unknown");
        expect(selection.reason).toBe("backfill");
        expect(typeof selection.decidedAt).toBe("string");
      } finally {
        rs.close();
      }
    });
  });

  test("an openai-compatible provider backfills as api-key", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const id = store.createSession("work", { cwd: workdir(home, "keyed") });
      const rs = openRuntimeStateDb(home);
      try {
        backfillNativeSessions({ rs, store, home, providerId: "openai-compatible" });
        expect(new RuntimeSessionRecords(rs).get(id)!.selection.authFamily).toBe("api-key");
      } finally {
        rs.close();
      }
    });
  });

  test("a session whose last event is terminal settles as exited; anything else is unavailable", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const done = store.createSession("work", { cwd: workdir(home, "done") });
      const midflight = store.createSession("work", { cwd: workdir(home, "mid") });
      store.append(done, { type: "user_message", sessionId: done, threadId: "main", text: "hi", clientName: "test" });
      store.append(done, { type: "turn_completed", sessionId: done, threadId: "main", stopReason: "end_turn", inputTokens: 1, outputTokens: 1 });
      store.append(midflight, { type: "user_message", sessionId: midflight, threadId: "main", text: "hi", clientName: "test" });
      store.append(midflight, { type: "turn_started", sessionId: midflight, threadId: "main" });

      const rs = openRuntimeStateDb(home);
      try {
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const records = new RuntimeSessionRecords(rs);
        expect(records.get(done)!.state).toBe("exited");
        expect(records.get(midflight)!.state).toBe("unavailable");
        // Neither is ever visible as a live runtime, at any point (WS-16 §14).
        expect(records.list({ state: ["ready", "running", "idle", "creating"] })).toEqual([]);
      } finally {
        rs.close();
      }
    });
  });

  test("a session the user archived backfills as an archived runtime record", async () => {
    // WS-16 §16's "archive is not delete" applies to legacy sessions too: 8b refuses messaging to an
    // archived session, and that refusal must cover the ones a user archived before the spine existed.
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const finished = store.createSession("work", { cwd: workdir(home, "done") });
      const midflight = store.createSession("work", { cwd: workdir(home, "mid") });
      store.append(finished, { type: "turn_completed", sessionId: finished, threadId: "main", stopReason: "end_turn", inputTokens: 1, outputTokens: 1 });
      store.append(midflight, { type: "turn_started", sessionId: midflight, threadId: "main" });
      store.setArchived(finished, true);
      store.setArchived(midflight, true);

      const rs = openRuntimeStateDb(home);
      try {
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const records = new RuntimeSessionRecords(rs);
        // Both settle first and are then retired — `archived` is reachable from `exited` and from
        // `unavailable` alike, so neither has to pretend it ended the way the other did.
        expect(records.get(finished)!.state).toBe("archived");
        expect(records.get(midflight)!.state).toBe("archived");
      } finally {
        rs.close();
      }
    });
  });

  test("a second run creates nothing and reports both sessions as already present", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = store.createSession("work", { cwd: workdir(home, "a") });
      const b = store.createSession("work", { cwd: workdir(home, "b") });
      const rs = openRuntimeStateDb(home);
      try {
        expect(backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" }).created.length).toBe(2);
        const second = backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        expect(second.created).toEqual([]);
        expect(second.alreadyPresent.sort()).toEqual([a, b].sort());
        expect(rs.db.query("SELECT COUNT(*) AS c FROM runtime_sessions").get()).toEqual({ c: 2 });
      } finally {
        rs.close();
      }
    });
  });

  test("a phone-synced session is skipped, never backfilled", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const native = store.createSession("work", { cwd: workdir(home, "native") });
      store.createSynced(SYNCED_ID, { scope: "global" });
      const rs = openRuntimeStateDb(home);
      try {
        const report = backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        expect(report.created).toEqual([native]);
        expect(report.skipped).toEqual([SYNCED_ID]);
        expect(new RuntimeSessionRecords(rs).get(SYNCED_ID)).toBeUndefined();
      } finally {
        rs.close();
      }
    });
  });

  test("a session whose metadata cannot be read lands in errors and never stops the others", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const good1 = store.createSession("work", { cwd: workdir(home, "g1") });
      const broken = store.createSession("work", { cwd: workdir(home, "broken") });
      const good2 = store.createSession("work", { cwd: workdir(home, "g2") });

      // A store whose `meta` refuses for exactly one session — deterministic, and it exercises the
      // real failure mode (an unreadable index row), which deleting the JSONL would NOT: `meta`
      // reads sqlite, so a missing log file leaves it perfectly happy.
      const faulty = new Proxy(store, {
        get(target, prop, receiver) {
          if (prop === "meta") {
            return (id: string) => {
              if (id === broken) throw new Error("index row unreadable");
              return target.meta(id);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as SessionStore;

      const rs = openRuntimeStateDb(home);
      try {
        const report = backfillNativeSessions({ rs, store: faulty, home, providerId: "codex-oauth" });
        expect(report.created.sort()).toEqual([good1, good2].sort());
        expect(report.errors.map((e) => e.winterSessionId)).toEqual([broken]);
        expect(report.errors[0]!.error).toMatch(/index row unreadable/);
        expect(new RuntimeSessionRecords(rs).get(broken)).toBeUndefined();
      } finally {
        rs.close();
      }
    });
  });

  test("a session with no cwd keys off the winter home rather than inventing a path", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const id = store.createSession("work", {});
      const rs = openRuntimeStateDb(home);
      try {
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const record = new RuntimeSessionRecords(rs).get(id)!;
        expect(record.transcriptProjectKey).toBe(transcriptProjectKey(home));
        expect(record.memoryProjectKey).toBe(sanitizeProjectKey(repoRootFor(home)));
      } finally {
        rs.close();
      }
    });
  });

  test("a partial run leaves no half-built record behind", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      store.createSession("work", { cwd: workdir(home, "a") });
      const rs = openRuntimeStateDb(home);
      try {
        // `now` throwing on the settling transition tears the whole per-session unit down: a record
        // stranded in `creating` would be reported `alreadyPresent` by every later run and never
        // repaired.
        let calls = 0;
        const report = backfillNativeSessions({
          rs, store, home, providerId: "codex-oauth",
          now: () => {
            calls += 1;
            if (calls > 2) throw new Error("clock failed mid-settle");
            return new Date().toISOString();
          },
        });
        expect(report.created).toEqual([]);
        expect(report.errors.length).toBe(1);
        expect(rs.db.query("SELECT COUNT(*) AS c FROM runtime_sessions").get()).toEqual({ c: 0 });
      } finally {
        rs.close();
      }
    });
  });

  test("a home with no sessions at all reports nothing and touches nothing", async () => {
    await withTempHome(async (home) => {
      const store = new SessionStore(home);
      const rs = openRuntimeStateDb(home);
      try {
        expect(backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" }))
          .toEqual({ created: [], skipped: [], alreadyPresent: [], errors: [] });
      } finally {
        rs.close();
      }
      rmSync(join(home, "sessions"), { recursive: true, force: true });
    });
  });
});
