import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeSelection } from "@yanlinglabs/winter-runtime-sdk";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../src/runtime-state/db";
import { RuntimeSessionRecords, type NewRuntimeSessionRecord } from "../../src/runtime-state/records";
import { RuntimeChildren, type PersistedWinterChild } from "../../src/runtime-state/children";
import { RuntimeLeases } from "../../src/runtime-state/leases";
import { diagnoseRuntimeState, repairRuntimeState, type Finding } from "../../src/runtime-state/doctor";
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
