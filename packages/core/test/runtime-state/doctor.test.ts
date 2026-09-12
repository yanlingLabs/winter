import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeSelection } from "@yanlinglabs/winter-runtime-sdk";
import { openRuntimeStateDb, RUNTIME_STATE_SCHEMA_VERSION, type RuntimeStateDb } from "../../src/runtime-state/db";
import { RuntimeSessionRecords, type NewRuntimeSessionRecord } from "../../src/runtime-state/records";
import { RuntimeChildren, type PersistedWinterChild } from "../../src/runtime-state/children";
import { RuntimeLeases } from "../../src/runtime-state/leases";
import { diagnoseRuntimeState, latestRecoveryAttempts, repairRuntimeState, type Finding } from "../../src/runtime-state/doctor";
import { restampStep } from "../../src/runtime-state/recovery";
import { SessionStore } from "../../src/sessions/store";
import { ISO, withTempHome } from "./support";

const UUID = "11111111-2222-4333-8444-555555555555";
const OTHER_UUID = "99999999-8888-4777-8666-555555555555";
/** Beyond macOS's pid ceiling, so `kill(pid, 0)` is ESRCH forever. */
const DEAD_PID = 4194304;

const selection = (): RuntimeSelection => ({
  runtimeKind: "winter-agent",
  providerId: "openai",
  modelRef: "gpt-5.6-sol",
  family: "openai",
  authFamily: "api-key",
  sdkVersion: "0.0.2",
  reason: "test",
  decidedAt: ISO(),
});

const newRecord = (home: string, id: string, over: Partial<NewRuntimeSessionRecord> = {}): NewRuntimeSessionRecord => ({
  winterSessionId: id,
  runtimeKind: "winter-agent",
  providerId: "openai",
  modelRef: "gpt-5.6-sol",
  backendRoot: join(home, "projects", "-tmp-work"),
  transcriptProjectKey: "-tmp-work",
  memoryProjectKey: "-tmp-work",
  tempProjectKey: "-tmp-work",
  transcriptHealth: "clean",
  compatibilityLevel: "conversation",
  conformanceCorpusVersion: "2026-09",
  versionProvenance: "recorded",
  sdkVersion: "0.0.2",
  engineVersion: "0.0.2",
  providerCatalogVersion: "0.0.2",
  providerAdapterVersion: "0.0.2",
  capabilities: [],
  selection: selection(),
  ...over,
});

const newChild = (parent: string, childId: string, over: Partial<PersistedWinterChild> = {}): PersistedWinterChild => ({
  parentWinterSessionId: parent,
  childId,
  agentType: "general-purpose",
  providerId: "openai",
  modelRef: "gpt-5.6-sol",
  providerCatalogVersion: "0.0.2",
  providerAdapterVersion: "0.0.2",
  status: "running",
  transcriptRef: "agent-1.jsonl",
  startedAt: ISO(),
  generation: 1,
  ...over,
});

/** Open the runtime-state db, do something, close it — no handle survives into the assertions, so a
 *  test that deletes the file afterwards is not fighting a live -wal sidecar. */
const withDb = (home: string, fn: (rs: RuntimeStateDb, records: RuntimeSessionRecords) => void): void => {
  const rs = openRuntimeStateDb(home);
  try {
    fn(rs, new RuntimeSessionRecords(rs));
  } finally {
    rs.close();
  }
};

/** A real product session, so the index and the log on disk are the genuine article. */
const seedProductSession = (home: string, opts: { cwd?: string } = {}): string => {
  const store = new SessionStore(home);
  try {
    return store.createSession("global", opts);
  } finally {
    store.close();
  }
};

const transcriptPath = (home: string, uuid: string): string => join(home, "projects", "-tmp-work", `${uuid}.jsonl`);

const writeTranscript = (home: string, uuid: string): void => {
  mkdirSync(join(home, "projects", "-tmp-work"), { recursive: true });
  writeFileSync(transcriptPath(home, uuid), "");
};

const kinds = (findings: Finding[]): string[] => findings.map((f) => f.kind);

describe("diagnoseRuntimeState — WS-16 §15 read-only diagnostics", () => {
  test("a healthy home reports nothing", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      const id = seedProductSession(home, { cwd: home });
      withDb(home, (_rs, records) => {
        records.create(newRecord(home, id));
      });

      expect(await diagnoseRuntimeState(home)).toEqual([]);
    });
  });

  test("a missing runtime-state.db is the one finding, and nothing else is guessed from the index", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      seedProductSession(home);
      const db = join(home, "runtimes", "runtime-state.db");
      for (const p of [db, `${db}-wal`, `${db}-shm`]) rmSync(p, { force: true });

      const findings = await diagnoseRuntimeState(home);
      expect(kinds(findings)).toEqual(["db-missing"]);
      // §14: refuse runtime resume/routing until restored — never infer a runtime kind or backend id
      // from the rebuildable index.
      expect(findings[0]!.repairable).toEqual(["restore-backup"]);
    });
  });

  test("a home that has never run a daemon says so, and offers no backup to restore", async () => {
    await withTempHome(async (home) => {
      rmSync(join(home, "runtimes"), { recursive: true, force: true });

      const findings = await diagnoseRuntimeState(home);
      expect(kinds(findings)).toEqual(["db-missing"]);
      expect(findings[0]!.detail).toContain("never run a daemon");
      // There is no backups directory either — sending the operator after one would be a wild goose.
      expect(findings[0]!.repairable).toEqual([]);
    });
  });

  test("a runtime-state.db that is not a database at all is db-corrupt", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      const db = join(home, "runtimes", "runtime-state.db");
      for (const p of [`${db}-wal`, `${db}-shm`]) rmSync(p, { force: true });
      writeFileSync(db, "SQLite format 3 says hello and then lies");

      const findings = await diagnoseRuntimeState(home);
      expect(kinds(findings)).toEqual(["db-corrupt"]);
      expect(findings[0]!.repairable).toEqual(["restore-backup"]);
    });
  });

  test("a store that predates the schema folds into db-corrupt, naming the reason", async () => {
    await withTempHome(async (home) => {
      mkdirSync(join(home, "runtimes"), { recursive: true });
      // A real, healthy sqlite file that has simply never been migrated — a readonly handle cannot
      // migrate it, so refusing is the only honest answer (db.ts's `unmigrated` reason).
      new Database(join(home, "runtimes", "runtime-state.db")).close();

      const findings = await diagnoseRuntimeState(home);
      expect(kinds(findings)).toEqual(["db-corrupt"]);
      expect(findings[0]!.detail).toContain("unmigrated");
    });
  });

  test("an index older than the cwd column reads fine and is not called unopenable", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      const id = seedProductSession(home, { cwd: home });
      withDb(home, (_rs, records) => {
        records.create(newRecord(home, id));
      });
      // `cwd` is ALTER-added, and a readonly handle cannot run that migration. A pre-cwd index is
      // READABLE — claiming the daemon will not start would be false (review r1, minor 5).
      const index = new Database(join(home, "sessions", "index.db"));
      const rows = index.query("SELECT session_id, scope, created_at, last_seq FROM sessions").all();
      index.run("DROP TABLE sessions");
      index.run("CREATE TABLE sessions (session_id TEXT PRIMARY KEY, scope TEXT NOT NULL, created_at INTEGER NOT NULL, last_seq INTEGER NOT NULL)");
      for (const r of rows as { session_id: string; scope: string; created_at: number; last_seq: number }[]) {
        index.run("INSERT INTO sessions (session_id, scope, created_at, last_seq) VALUES (?, ?, ?, ?)", [r.session_id, r.scope, r.created_at, r.last_seq]);
      }
      index.close();

      expect(await diagnoseRuntimeState(home)).toEqual([]);
    });
  });

  test("a schema newer than this build refuses rather than guessing", async () => {
    await withTempHome(async (home) => {
      withDb(home, (rs) => {
        rs.db.run("PRAGMA user_version = 99");
      });

      expect(kinds(await diagnoseRuntimeState(home))).toEqual(["db-newer-schema"]);
    });
  });

  test("a workspace that has disappeared is reported against its session", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      const id = seedProductSession(home, { cwd: join(home, "gone-away") });
      withDb(home, (_rs, records) => {
        records.create(newRecord(home, id));
      });

      const findings = await diagnoseRuntimeState(home);
      expect(kinds(findings)).toEqual(["missing-workspace"]);
      expect(findings[0]!.winterSessionId).toBe(id);
      // §14: keep history visible, refuse a new tool turn — there is no repair a doctor can apply.
      expect(findings[0]!.repairable).toEqual([]);
    });
  });

  test("a projection cursor past the product log's end is a cursor mismatch", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      const id = seedProductSession(home, { cwd: home });
      withDb(home, (rs, records) => {
        records.create(newRecord(home, id));
        records.transition(id, "ready");
        records.bumpGeneration(id, { runtimeKind: "winter-agent" });
        rs.db.run(
          `INSERT INTO runtime_projection_cursors (winter_session_id, generation, runtime_kind, backend_cursor, last_winter_seq, updated_at)
           VALUES (?, 1, 'winter-agent', 'line:9', 999, ?)`,
          [id, ISO()],
        );
      });

      const findings = await diagnoseRuntimeState(home);
      expect(kinds(findings)).toEqual(["cursor-mismatch"]);
      expect(findings[0]!.detail).toContain("999");
    });
  });

  test("a child whose resume context is gone is reported", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      const id = seedProductSession(home, { cwd: home });
      withDb(home, (rs, records) => {
        records.create(newRecord(home, id));
        new RuntimeChildren(rs).upsert(newChild(id, "c1", { resumeContextRef: join(home, "children", "c1.json") }));
      });

      const findings = await diagnoseRuntimeState(home);
      expect(kinds(findings)).toEqual(["missing-child-resume-context"]);
      expect(findings[0]!.detail).toContain("c1");
    });
  });

  test("a mapped backend transcript that is not on disk is reported, with both repairs offered", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      const id = seedProductSession(home, { cwd: home });
      withDb(home, (_rs, records) => {
        records.create(newRecord(home, id, { backendSessionId: UUID }));
      });

      const findings = await diagnoseRuntimeState(home);
      expect(kinds(findings)).toEqual(["transcript-missing"]);
      expect(findings[0]!.repairable).toEqual(["relink-backend", "detach-backend"]);
    });
  });

  test("a lease whose holder is gone is a stale live registration", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      const id = seedProductSession(home, { cwd: home });
      withDb(home, (rs, records) => {
        records.create(newRecord(home, id));
        records.transition(id, "ready");
        records.bumpGeneration(id, { runtimeKind: "winter-agent" });
        new RuntimeLeases(rs, { pid: DEAD_PID, startedAt: ISO() }).acquire(id, 1);
      });

      const findings = await diagnoseRuntimeState(home);
      expect(kinds(findings)).toEqual(["stale-live-registration"]);
      expect(findings[0]!.detail).toContain(String(DEAD_PID));
    });
  });

  test("a reused PID is stale to the doctor exactly as it is to recovery", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      const alive = seedProductSession(home, { cwd: home });
      const unknown = seedProductSession(home, { cwd: home });
      withDb(home, (rs, records) => {
        for (const id of [alive, unknown]) {
          records.create(newRecord(home, id));
          records.transition(id, "ready");
          records.bumpGeneration(id, { runtimeKind: "winter-agent" });
        }
        // This pid is very much alive — it is us — but the recorded start time says it is a
        // DIFFERENT process. A bare liveness check calls that healthy; pid + start identity does not
        // (review r1, minor 3).
        new RuntimeLeases(rs, { pid: process.pid, startedAt: "1999-01-01T00:00:00.000Z" }).acquire(alive, 1);
        // …while a live pid with no start identity is §11's third answer: neither proven live nor
        // proven stale, so it is NOT reported. Naming it here would invite the break §11 forbids.
        new RuntimeLeases(rs, { pid: process.pid, startedAt: "unknown" }).acquire(unknown, 1);
      });

      const findings = await diagnoseRuntimeState(home);
      expect(kinds(findings)).toEqual(["stale-live-registration"]);
      expect(findings[0]!.winterSessionId).toBe(alive);
    });
  });

  test("a generation with no session behind it, and a backend id two sessions disagree about", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      const a = seedProductSession(home, { cwd: home });
      const b = seedProductSession(home, { cwd: home });
      writeTranscript(home, UUID);
      withDb(home, (rs, records) => {
        records.create(newRecord(home, a, { backendSessionId: UUID }));
        records.create(newRecord(home, b));
        records.transition(b, "ready");
        records.bumpGeneration(b, { runtimeKind: "winter-agent" });
        // b's generation claims a uuid the runtime_sessions row says belongs to a.
        rs.db.run("UPDATE runtime_generations SET backend_session_id = ? WHERE winter_session_id = ?", [UUID, b]);
        // A generation whose session no longer exists at all. The FK makes this unreachable through
        // every typed door, which is the point: an orphan generation can only have arrived from
        // somewhere else (a restore, a hand edit), so the fixture has to arrive the same way.
        rs.db.run("PRAGMA foreign_keys = OFF");
        rs.db.run(
          `INSERT INTO runtime_generations (winter_session_id, generation, runtime_kind, started_at) VALUES ('s_ghost', 1, 'winter-agent', ?)`,
          [ISO()],
        );
        rs.db.run("PRAGMA foreign_keys = ON");
      });

      const findings = await diagnoseRuntimeState(home);
      expect(kinds(findings).sort()).toEqual(["duplicate-backend-id", "orphan-generation"]);
      // §4: an ambiguous backend-ID mapping is REJECTED, never resolved by picking a file — and no
      // repair here can honestly clear it, so none is offered.
      expect(findings.find((f) => f.kind === "duplicate-backend-id")!.repairable).toEqual([]);
    });
  });

  test("an index whose last_seq disagrees with the log tail is drift, and the tail repair is offered", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      const id = seedProductSession(home, { cwd: home });
      withDb(home, (_rs, records) => {
        records.create(newRecord(home, id));
      });
      // A torn trailing frame: the bytes a crash mid-append leaves behind.
      const log = join(home, "sessions", "global", `${id}.jsonl`);
      writeFileSync(log, `${readFileSync(log, "utf8")}{"type":"assistant_mess`);

      const findings = await diagnoseRuntimeState(home);
      expect(kinds(findings)).toEqual(["index-drift"]);
      expect(findings[0]!.repairable).toEqual(["quarantine-tail", "rebuild-index"]);
    });
  });

  test("an index.db that cannot be opened is reported, not read as an empty one", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      const id = seedProductSession(home, { cwd: home });
      withDb(home, (_rs, records) => {
        records.create(newRecord(home, id));
      });
      // The state in which the daemon will not boot at all: SessionStore's constructor throws on
      // this file. Answering "no findings" here would be the worst possible lie.
      writeFileSync(join(home, "sessions", "index.db"), "not a database");

      const findings = await diagnoseRuntimeState(home);
      expect(kinds(findings)).toEqual(["index-drift"]);
      expect(findings[0]!.winterSessionId).toBeUndefined();
      expect(findings[0]!.repairable).toEqual(["rebuild-index"]);
    });
  });

  test("diagnosis is read-only: it never mutates the db it inspects", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      const id = seedProductSession(home, { cwd: home });
      withDb(home, (_rs, records) => {
        records.create(newRecord(home, id, { backendSessionId: UUID }));
      });
      const before = dumpSessions(home);

      await diagnoseRuntimeState(home);

      expect(dumpSessions(home)).toBe(before);
    });
  });
});

/** `SELECT *` of the authoritative tables, ordered — the byte-identity witness Task 11 reuses.
 *  Three tables, not one (review r1, minor 6): a mutation that spared `runtime_sessions` and moved
 *  a generation or a child would otherwise pass the read-only pin. */
const dumpSessions = (home: string): string => {
  const rs = openRuntimeStateDb(home, { readonly: true });
  try {
    return JSON.stringify({
      sessions: rs.db.query("SELECT * FROM runtime_sessions ORDER BY winter_session_id").all(),
      generations: rs.db.query("SELECT * FROM runtime_generations ORDER BY winter_session_id, generation").all(),
      children: rs.db.query("SELECT * FROM runtime_children ORDER BY parent_winter_session_id, child_id").all(),
    });
  } finally {
    rs.close();
  }
};

describe("repairRuntimeState — WS-16 §15 explicit, recoverable repairs", () => {
  test("rebuild-index deletes and rebuilds index.db, and leaves runtime_sessions byte-identical", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      const id = seedProductSession(home, { cwd: home });
      withDb(home, (_rs, records) => {
        records.create(newRecord(home, id, { backendSessionId: UUID }));
      });
      const before = dumpSessions(home);
      const index = join(home, "sessions", "index.db");
      expect(existsSync(index)).toBe(true);

      const result = await repairRuntimeState(home, { kind: "rebuild-index" });

      expect(result.applied).toBe(true);
      expect(existsSync(index)).toBe(true);
      // The authoritative store is NOT touched by a product-index repair.
      expect(dumpSessions(home)).toBe(before);
      // …and the rebuilt index still knows the session, off the JSONL alone.
      const store = new SessionStore(home);
      try {
        expect(store.list().map((s) => s.sessionId)).toEqual([id]);
      } finally {
        store.close();
      }
    });
  });

  test("relink-backend refuses a uuid another record already holds", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      const a = seedProductSession(home, { cwd: home });
      const b = seedProductSession(home, { cwd: home });
      writeTranscript(home, UUID);
      withDb(home, (_rs, records) => {
        records.create(newRecord(home, a, { backendSessionId: UUID }));
        records.create(newRecord(home, b));
      });

      const result = await repairRuntimeState(home, { kind: "relink-backend", winterSessionId: b, backendSessionId: UUID });

      expect(result.applied).toBe(false);
      expect(result.detail).toContain(a);
      withDb(home, (_rs, records) => {
        expect(records.get(b)?.backendSessionId).toBeUndefined();
      });
    });
  });

  test("relink-backend refuses when the transcript for the uuid is not on disk, and links when it is", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      const id = seedProductSession(home, { cwd: home });
      withDb(home, (_rs, records) => {
        records.create(newRecord(home, id));
      });

      const missing = await repairRuntimeState(home, { kind: "relink-backend", winterSessionId: id, backendSessionId: UUID });
      expect(missing.applied).toBe(false);
      expect(missing.detail).toContain("no transcript");

      writeTranscript(home, UUID);
      const linked = await repairRuntimeState(home, { kind: "relink-backend", winterSessionId: id, backendSessionId: UUID });
      expect(linked.applied).toBe(true);
      withDb(home, (_rs, records) => {
        expect(records.get(id)?.backendSessionId).toBe(UUID);
        // A relink patches the mapping and nothing else — the lifecycle state is not a repair's business.
        expect(records.get(id)?.state).toBe("creating");
      });
    });
  });

  test("relink-backend refuses a uuid that is not a uuid — it is about to become a path component", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      const id = seedProductSession(home, { cwd: home });
      withDb(home, (_rs, records) => {
        records.create(newRecord(home, id));
      });

      const result = await repairRuntimeState(home, { kind: "relink-backend", winterSessionId: id, backendSessionId: "../../../etc/passwd" });

      expect(result.applied).toBe(false);
      expect(result.detail).toContain("not a backend session uuid");
    });
  });

  test("detach-backend keeps the product history and marks the transcript unsupported", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      const id = seedProductSession(home, { cwd: home });
      withDb(home, (_rs, records) => {
        records.create(newRecord(home, id, { backendSessionId: OTHER_UUID }));
        records.transition(id, "ready");
      });

      const result = await repairRuntimeState(home, { kind: "detach-backend", winterSessionId: id });

      expect(result.applied).toBe(true);
      withDb(home, (_rs, records) => {
        const record = records.get(id)!;
        expect(record.backendSessionId).toBeUndefined();
        expect(record.transcriptHealth).toBe("unsupported");
        expect(record.state).toBe("exited");
      });
      // The product log is untouched: history stays visible, read-only.
      const store = new SessionStore(home);
      try {
        expect(store.read(id).length).toBeGreaterThan(0);
      } finally {
        store.close();
      }
    });
  });

  test("quarantine-tail moves only the torn trailing frame, and the log keeps every earlier event", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      const id = seedProductSession(home, { cwd: home });
      const log = join(home, "sessions", "global", `${id}.jsonl`);
      const good = readFileSync(log, "utf8");
      writeFileSync(log, `${good}{"type":"assistant_mess`);

      const result = await repairRuntimeState(home, { kind: "quarantine-tail", winterSessionId: id });

      expect(result.applied).toBe(true);
      expect(readFileSync(log, "utf8")).toBe(good);
      // OUTSIDE the sessions tree: `SessionStore.recoverAll` enumerates `sessions/<scope>/*.jsonl`
      // and derives a session id from each filename, so a sidecar living there was a candidate
      // session that only ever got skipped because its lines do not parse (M2).
      const quarantine = join(home, "runtimes", "quarantine", "global", `${id}.jsonl`);
      expect(existsSync(quarantine)).toBe(true);
      expect(readFileSync(quarantine, "utf8")).toBe('{"type":"assistant_mess\n');
      expect(existsSync(join(home, "sessions", "global", `${id}.quarantine.jsonl`))).toBe(false);
      // The detail names bytes and a path, never the bytes themselves.
      expect(result.detail).not.toContain("assistant_mess");

      const again = await repairRuntimeState(home, { kind: "quarantine-tail", winterSessionId: id });
      expect(again.applied).toBe(false);
      expect(again.detail).toContain("no incomplete trailing frame");
    });
  });

  test("EVERY repair refuses while the daemon holds the lock, not just restore-backup", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      const id = seedProductSession(home, { cwd: home });
      withDb(home, (_rs, records) => records.create(newRecord(home, id)));
      const indexPath = join(home, "sessions", "index.db");

      writeFileSync(join(home, "run", "core.lock"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      // `repairRuntimeState` is exported on the package barrel, so the CLI's own probe is not the
      // only door: a programmatic caller could unlink the index a live daemon holds open, or write
      // the store it is reading.
      for (const op of [
        { kind: "rebuild-index" },
        { kind: "quarantine-tail", winterSessionId: id },
        { kind: "relink-backend", winterSessionId: id, backendSessionId: "11111111-2222-4333-8444-555555555555" },
        { kind: "detach-backend", winterSessionId: id },
        { kind: "restore-backup", backupPath: join(home, "runtimes", "backups", "nope.db") },
        { kind: "memory-keys-rollback" },
      ] as const) {
        const refused = await repairRuntimeState(home, op);
        expect(refused.applied).toBe(false);
        expect(refused.detail).toBe("daemon is running; stop it first");
      }
      // Nothing was touched on the way to those refusals.
      expect(existsSync(indexPath)).toBe(true);

      rmSync(join(home, "run", "core.lock"));
      expect((await repairRuntimeState(home, { kind: "rebuild-index" })).applied).toBe(true);
    });
  });

  test("restore-backup rolls the authoritative store back, and refuses while the daemon holds the lock", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      const id = seedProductSession(home, { cwd: home });
      let backup = "";
      withDb(home, (rs, records) => {
        records.create(newRecord(home, id));
        backup = rs.backup();
      });
      withDb(home, (_rs, records) => {
        records.create(newRecord(home, "s_after_backup"));
      });

      writeFileSync(join(home, "run", "core.lock"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      const refused = await repairRuntimeState(home, { kind: "restore-backup", backupPath: backup });
      expect(refused.applied).toBe(false);
      expect(refused.detail).toBe("daemon is running; stop it first");

      rmSync(join(home, "run", "core.lock"));
      const restored = await repairRuntimeState(home, { kind: "restore-backup", backupPath: backup });
      expect(restored.applied).toBe(true);
      withDb(home, (_rs, records) => {
        expect(records.get(id)).toBeDefined();
        expect(records.get("s_after_backup")).toBeUndefined();
      });
      // The one irreversible repair, made reversible: what it overwrote is still on disk.
      const snapshot = /the replaced file is at (\S+)/.exec(restored.detail)?.[1];
      expect(snapshot).toBeDefined();
      expect(existsSync(snapshot!)).toBe(true);
      const rolledBack = openRuntimeStateDb(home, { readonly: true });
      try {
        expect(new RuntimeSessionRecords(rolledBack).get("s_after_backup")).toBeUndefined();
      } finally {
        rolledBack.close();
      }
      const undone = await repairRuntimeState(home, { kind: "restore-backup", backupPath: snapshot! });
      expect(undone.applied).toBe(true);
      withDb(home, (_rs, records) => {
        expect(records.get("s_after_backup")).toBeDefined();
      });
    });
  });

  test("restore-backup refuses a backup written by a newer Norma", async () => {
    await withTempHome(async (home) => {
      let backup = "";
      withDb(home, (rs) => {
        backup = rs.backup();
      });
      const newer = new Database(backup);
      newer.run("PRAGMA user_version = 99");
      newer.close();

      const result = await repairRuntimeState(home, { kind: "restore-backup", backupPath: backup });

      // It would pass quick_check and then refuse to OPEN — a restore that "succeeds" into an
      // unusable store, caught while the current file is still intact (review r1, minor 7).
      expect(result.applied).toBe(false);
      expect(result.detail).toContain("newer Norma");
    });
  });

  test("restore-backup refuses a source outside the home's own backup directory", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      const outside = join(home, "elsewhere.db");
      writeFileSync(outside, "");

      const result = await repairRuntimeState(home, { kind: "restore-backup", backupPath: outside });

      expect(result.applied).toBe(false);
      expect(result.detail).toContain("outside");
    });
  });

  test("a repair against a store that will not open returns a refusal, never a stack trace", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      const id = seedProductSession(home, { cwd: home });
      writeTranscript(home, UUID);
      const db = join(home, "runtimes", "runtime-state.db");
      for (const p of [`${db}-wal`, `${db}-shm`]) rmSync(p, { force: true });
      writeFileSync(db, "not a database");

      // `openRuntimeStateDb` refuses by THROWING, and the CLI does `if (!result.applied)` — so a
      // repair that raises instead of returning is a raw stack trace in exactly the broken-home
      // state the verb exists for (review r1, important 2).
      for (const op of [
        { kind: "relink-backend", winterSessionId: id, backendSessionId: UUID },
        { kind: "detach-backend", winterSessionId: id },
      ] as const) {
        const result = await repairRuntimeState(home, op);
        expect(result.applied).toBe(false);
        expect(result.detail).toContain("RuntimeStateUnavailableError");
      }
    });
  });

  test("an unknown session is refused, never invented", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});

      const result = await repairRuntimeState(home, { kind: "detach-backend", winterSessionId: "s_nope" });

      expect(result.applied).toBe(false);
      expect(result.detail).toContain("s_nope");
    });
  });
});

// ── Fix round 2 (re-review NEW-1): an OLDER schema is not a fault ─────────────────────────────────
describe("diagnoseRuntimeState / restore-backup — a store written by an older build of this schema", () => {
  test("a healthy older-schema store is reported as unmigrated, never corrupt, and offers no restore", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      const id = seedProductSession(home, { cwd: home });
      withDb(home, (_rs, records) => { records.create(newRecord(home, id)); });
      // Exactly what every 8a-era home looks like until a newer daemon opens it read-write: a
      // complete, healthy store whose `user_version` is simply behind this build's.
      const db = new Database(join(home, "runtimes", "runtime-state.db"));
      db.run("PRAGMA user_version = 1");
      db.close();

      const findings = await diagnoseRuntimeState(home);
      expect(kinds(findings)).toContain("db-unmigrated");
      expect(kinds(findings)).not.toContain("db-corrupt");
      const unmigrated = findings.find((f) => f.kind === "db-unmigrated")!;
      // NOT repairable by this tool: restoring a backup would restore the same older version, which
      // is advice that loops. The daemon fixes it by starting.
      expect(unmigrated.repairable).toEqual([]);
      expect(unmigrated.detail).toContain("the next daemon boot migrates it in place");
      // And the diagnosis CONTINUES rather than returning early — the session-level checks still ran.
      expect(kinds(findings)).not.toContain("index-drift");
    });
  });

  test("the daemon's own read-write open migrates that same store in place", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      const db = new Database(join(home, "runtimes", "runtime-state.db"));
      db.run("PRAGMA user_version = 1");
      db.close();

      const rs = openRuntimeStateDb(home);
      try {
        expect(rs.schemaVersion()).toBe(RUNTIME_STATE_SCHEMA_VERSION);
        expect(rs.integrity().ok).toBe(true);
      } finally {
        rs.close();
      }
      expect(await diagnoseRuntimeState(home)).toEqual([]);
    });
  });

  test("the byte-copy snapshot carries the store's WAL, so the tool's own probe can read it back", async () => {
    // RE-REVIEW NEW-9. The byte-copy door runs when this build cannot OPEN the current store — a
    // downgrade (`newer-schema`) being the healthy case. Copying the main file alone produced a
    // snapshot that `restore-backup`'s own probe (a readonly open) refuses as "not a readable
    // database", and the committed-but-uncheckpointed tail that lived only in the `-wal` was then
    // deleted by the sidecar removal.
    await withTempHome(async (home) => {
      withDb(home, () => {});
      const id = seedProductSession(home, { cwd: home });
      let backup = "";
      withDb(home, (rs, records) => { records.create(newRecord(home, id)); backup = rs.backup(); });

      const dest = join(home, "runtimes", "runtime-state.db");
      // A committed row that is still only in the WAL: the connection stays open, so nothing
      // checkpoints it, and `-wal` is where the value actually lives.
      const live = new Database(dest);
      try {
        live.run("INSERT INTO schema_meta(key, value) VALUES ('wal_tail', 'TAIL')");
        // A version this build will not open readonly — the healthy store / door-1-refuses case.
        live.run("PRAGMA user_version = 99");
        expect(existsSync(`${dest}-wal`)).toBe(true);

        const result = await repairRuntimeState(home, { kind: "restore-backup", backupPath: backup });
        expect(result.applied).toBe(true);
        const snapshot = /the replaced file is at (\S+)/.exec(result.detail)?.[1];
        expect(snapshot).toBeDefined();
        expect(existsSync(`${snapshot!}-wal`)).toBe(true);

        // The probe's own shape — a plain readonly open — and the tail is there.
        const probe = new Database(snapshot!, { readonly: true });
        try {
          expect(probe.query("SELECT value FROM schema_meta WHERE key='wal_tail'").get()).toEqual({ value: "TAIL" });
        } finally {
          probe.close();
        }
        // And `restore-backup` itself gets far enough to READ it: the refusal it gives is about the
        // snapshot's schema version, never "not a readable database".
        const back = await repairRuntimeState(home, { kind: "restore-backup", backupPath: snapshot! });
        expect(back.detail).not.toContain("not a readable database");
      } finally {
        live.close();
      }
    });
  });

  test("re-review NEW-10: a restore FROM a WAL-carrying backup carries the tail — the restored store reads the committed-but-uncheckpointed row", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      const id = seedProductSession(home, { cwd: home });
      withDb(home, (_rs, records) => { records.create(newRecord(home, id)); });
      // A WAL-carrying backup under `backups/` — the shape the byte-copy door leaves behind — whose
      // committed tail lives ONLY in its `-wal` (the writer stays open so nothing checkpoints).
      const dest = join(home, "runtimes", "runtime-state.db");
      const dir = join(home, "runtimes", "backups");
      mkdirSync(dir, { recursive: true });
      const backup = join(dir, "wal-carrying.db");
      copyFileSync(dest, backup);
      const writer = new Database(backup);
      try {
        writer.run("PRAGMA journal_mode = WAL");
        writer.run("INSERT INTO schema_meta(key, value) VALUES ('wal_tail', 'TAIL')");
        expect(existsSync(`${backup}-wal`)).toBe(true);
        const result = await repairRuntimeState(home, { kind: "restore-backup", backupPath: backup });
        expect(result.applied).toBe(true);
        // the source's sidecars came along...
        expect(existsSync(`${dest}-wal`)).toBe(true);
        // ...and the restored store READS THE TAIL — before NEW-10 the main file alone was copied,
        // `applied: true` was reported, and this row was silently gone.
        const restored = new Database(dest);
        try {
          expect(restored.query("SELECT value FROM schema_meta WHERE key='wal_tail'").get()).toEqual({ value: "TAIL" });
        } finally { restored.close(); }
      } finally { writer.close(); }
    });
  });

  test("re-review NEW-11: a sidecar that cannot be snapshotted refuses with the WAL-specific wording, and leaves NO partial pre-restore file behind", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      console.warn("skipped: running as root, where chmod 000 cannot close the sidecar door");
      return;
    }
    await withTempHome(async (home) => {
      withDb(home, () => {});
      const id = seedProductSession(home, { cwd: home });
      let backup = "";
      withDb(home, (rs, records) => { records.create(newRecord(home, id)); backup = rs.backup(); });
      const dest = join(home, "runtimes", "runtime-state.db");
      const backups = join(home, "runtimes", "backups");
      const live = new Database(dest);
      try {
        // door 1 (`VACUUM INTO`) refuses: a version this build will not open readonly; the tail is
        // in the `-wal`, and THAT file is the one made uncopyable
        live.run("INSERT INTO schema_meta(key, value) VALUES ('wal_tail', 'TAIL')");
        live.run("PRAGMA user_version = 99");
        expect(existsSync(`${dest}-wal`)).toBe(true);
        const before = readFileSync(dest);
        const filesBefore = readdirSync(backups).sort();
        chmodSync(`${dest}-wal`, 0o000);
        try {
          const result = await repairRuntimeState(home, { kind: "restore-backup", backupPath: backup });
          expect(result.applied).toBe(false);
          // the DEDICATED refusal — reachable now (it was dead code behind the generic catch)
          expect(result.detail).toContain("write-ahead log could not be snapshotted");
          expect(result.detail).toContain("Move the store and its -wal aside");
        } finally { chmodSync(`${dest}-wal`, 0o600); }
        // nothing partial: no main-only `pre-restore-*.db` (the sidecar-less file the probe refuses)
        expect(readdirSync(backups).sort()).toEqual(filesBefore);
        // and the store — main file AND its wal — is untouched
        expect(readFileSync(dest)).toEqual(before);
        expect(existsSync(`${dest}-wal`)).toBe(true);
      } finally { live.close(); }
    });
  });

  test("a restore whose pre-overwrite snapshot fails is ABORTED, and the store it would have overwritten is untouched", async () => {
    // `chmod 000` does not stop root, so as root this test would assert nothing at all rather than
    // fail — say so out loud instead of passing vacuously.
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      console.warn("skipped: running as root, where chmod 000 cannot close either snapshot door");
      return;
    }
    await withTempHome(async (home) => {
      withDb(home, () => {});
      const id = seedProductSession(home, { cwd: home });
      let backup = "";
      withDb(home, (rs, records) => { records.create(newRecord(home, id)); backup = rs.backup(); });
      withDb(home, (_rs, records) => { records.create(newRecord(home, "s_after_backup")); });

      const dest = join(home, "runtimes", "runtime-state.db");
      const before = readFileSync(dest);
      // Neither snapshot door can work: the file opens for nobody and copies for nobody.
      chmodSync(dest, 0o000);
      try {
        const result = await repairRuntimeState(home, { kind: "restore-backup", backupPath: backup });
        expect(result.applied).toBe(false);
        expect(result.detail).toContain("could not be snapshotted first");
        expect(result.detail).toContain("Move it aside by hand");
      } finally {
        chmodSync(dest, 0o600);
      }
      // The one irreversible repair did not run: the current store is byte-for-byte what it was.
      expect(readFileSync(dest)).toEqual(before);
      withDb(home, (_rs, records) => { expect(records.get("s_after_backup")).toBeDefined(); });
    });
  });
});

describe("latestRecoveryAttempts — P8d-11's attempt view", () => {
  const seedAttempt = (rs: RuntimeStateDb, over: { daemonStartedAt: string; step: number; outcome: string; detail?: unknown; winterSessionId?: string | null }): number => {
    const result = rs.db.run(
      `INSERT INTO runtime_recovery_attempts (started_at, finished_at, daemon_pid, daemon_started_at, step, winter_session_id, outcome, detail_json)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
      [ISO(), ISO(), over.daemonStartedAt, over.step, over.winterSessionId ?? null, over.outcome, JSON.stringify(over.detail ?? {})],
    );
    return typeof result.lastInsertRowid === "bigint" ? Number(result.lastInsertRowid) : result.lastInsertRowid;
  };

  test("returns only the MOST RECENT boot's step-summary rows, in step order", async () => {
    await withTempHome(async (home) => {
      withDb(home, (rs) => {
        seedAttempt(rs, { daemonStartedAt: "2026-09-01T00:00:00.000Z", step: 10, outcome: "skipped" });
        seedAttempt(rs, { daemonStartedAt: "2026-09-12T00:00:00.000Z", step: 12, outcome: "ok", detail: { sessionsSeen: 2 } });
        seedAttempt(rs, { daemonStartedAt: "2026-09-12T00:00:00.000Z", step: 10, outcome: "skipped", detail: { heldMessages: 0 } });
        // A session-scoped row (step 2's per-session corrupt note) must never appear in the view —
        // it is not one of the twelve step-summary rows.
        seedAttempt(rs, { daemonStartedAt: "2026-09-12T00:00:00.000Z", step: 2, outcome: "failed", winterSessionId: "s_corrupt" });
      });

      const attempts = latestRecoveryAttempts(home);
      expect(attempts.map((a) => a.step)).toEqual([10, 12]);
      expect(attempts.find((a) => a.step === 10)?.outcome).toBe("skipped");
      expect(attempts.every((a) => a.step !== 2)).toBe(true);
    });
  });

  test("a restamped step 10 shows the restamped outcome, not the original `skipped` one", async () => {
    await withTempHome(async (home) => {
      let id = 0;
      withDb(home, (rs) => {
        id = seedAttempt(rs, { daemonStartedAt: "2026-09-12T00:00:00.000Z", step: 10, outcome: "skipped", detail: { heldMessages: 0 } });
      });
      withDb(home, (rs) => {
        restampStep(rs.db, id, 10, "ok", { entriesLoaded: 4, staleMarked: 0 });
      });

      const attempts = latestRecoveryAttempts(home);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ step: 10, outcome: "ok", detail: { entriesLoaded: 4, staleMarked: 0 } });
    });
  });

  test("a home with no runtime spine reports no attempts, never throws", async () => {
    await withTempHome(async (home) => {
      expect(latestRecoveryAttempts(home)).toEqual([]);
    });
  });
});

describe("memory-keys-migration finding + memory-keys-rollback repair (P8d-11)", () => {
  /** A `moved` manifest row plus the file layout it describes — the destination holds the entry,
   *  the source does not — without going through `planMemoryKeyMigration`/`applyMemoryKeyMigration`
   *  at all: those are exhaustively covered by `memory-keys.test.ts`, and this file's own job is
   *  `doctor.ts`'s wiring (the finding's counts, the repair's door, the daemon-lock gate above). */
  function seedMovedEntry(home: string, oldKey: string, newKey: string, entry = "memory"): void {
    mkdirSync(join(home, "projects", newKey, entry), { recursive: true });
    writeFileSync(join(home, "projects", newKey, entry, "MEMORY.md"), "alpha");
    withDb(home, (rs) => {
      rs.db.run(
        "INSERT INTO memory_key_manifest (old_key, entry, new_key, status, planned_at, moved_at, record_ids) VALUES (?, ?, ?, 'moved', ?, ?, '[]')",
        [oldKey, entry, newKey, ISO(), ISO()],
      );
    });
  }

  test("diagnoseRuntimeState reports the manifest state, repairable only while something is `moved`", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      seedMovedEntry(home, "old-a", "new-a");

      const findings = await diagnoseRuntimeState(home);
      const finding = findings.find((f) => f.kind === "memory-keys-migration");
      expect(finding?.detail).toContain("1 moved");
      expect(finding?.repairable).toEqual(["memory-keys-rollback"]);
    });
  });

  test("a home that never touched the migration reports no memory-keys-migration finding at all", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      const findings = await diagnoseRuntimeState(home);
      expect(findings.find((f) => f.kind === "memory-keys-migration")).toBeUndefined();
    });
  });

  test("memory-keys-rollback rolls the entry back, is idempotent, and the finding's repairable set empties once nothing is `moved`", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      seedMovedEntry(home, "old-b", "new-b");

      const result = await repairRuntimeState(home, { kind: "memory-keys-rollback" });
      expect(result.applied).toBe(true);
      expect(result.detail).toContain("1 entrie(s) rolled back");
      expect(existsSync(join(home, "projects", "old-b", "memory", "MEMORY.md"))).toBe(true);
      expect(existsSync(join(home, "projects", "new-b", "memory"))).toBe(false);

      const again = await repairRuntimeState(home, { kind: "memory-keys-rollback" });
      expect(again).toEqual({ applied: false, detail: "no relocated memory-key entries to roll back" });

      const findings = await diagnoseRuntimeState(home);
      const finding = findings.find((f) => f.kind === "memory-keys-migration")!;
      expect(finding.detail).toContain("1 rolled back");
      expect(finding.repairable).toEqual([]);
    });
  });

  test("a torn rollback (a′) is surfaced as a mid-undo count, never silently dropped", async () => {
    await withTempHome(async (home) => {
      withDb(home, () => {});
      seedMovedEntry(home, "old-c", "new-c");
      withDb(home, (rs) => {
        rs.db.run("UPDATE memory_key_manifest SET status = 'undoing', undo_target = 'rolled-back' WHERE old_key = 'old-c'");
      });

      const findings = await diagnoseRuntimeState(home);
      const finding = findings.find((f) => f.kind === "memory-keys-migration")!;
      expect(finding.detail).toContain("mid-undo");
      // Never offered as a repair here — that row belongs to the next daemon boot, not to this
      // read-only-by-design diagnosis.
      expect(finding.repairable).toEqual([]);
    });
  });
});
