import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { RuntimeSelection } from "@yanlinglabs/winter-runtime-sdk";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../src/runtime-state/db";
import {
  ALLOWED_TRANSITIONS,
  DuplicateBackendSessionError,
  IllegalStateTransitionError,
  RuntimeSessionRecords,
  UnknownRuntimeGenerationError,
  UnknownRuntimeSessionError,
  VersionProvenanceError,
  type NewRuntimeSessionRecord,
} from "../../src/runtime-state/records";
import { ISO, withTempHome } from "./support";

/** WS-15 §1's persisted choice, as the D13 selector would have stamped it. */
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

const UUID = "11111111-2222-4333-8444-555555555555";

/** Every test opens its own db under its own temp home; `use` guarantees the handle is closed even
 *  when an assertion throws (a leaked handle keeps -wal sidecars alive under the home being rm'd). */
const use = (home: string, fn: (rs: RuntimeStateDb, records: RuntimeSessionRecords) => void): void => {
  const rs = openRuntimeStateDb(home);
  try {
    fn(rs, new RuntimeSessionRecords(rs));
  } finally {
    rs.close();
  }
};

describe("RuntimeSessionRecords", () => {
  test("ALLOWED_TRANSITIONS is pinned literally, as a drift tripwire", () => {
    // Review r1 minor 4: the whole table, not just `.archived` — a typo inside any one list would
    // otherwise pass the suite. This literal IS the brief's table (WS-16 §4/§16).
    expect(ALLOWED_TRANSITIONS).toEqual({
      creating: ["ready", "failed"],
      ready: ["running", "idle", "exited", "failed", "unavailable", "archived"],
      running: ["idle", "exited", "failed", "unavailable"],
      idle: ["running", "exited", "failed", "unavailable", "archived"],
      exited: ["running", "archived", "unavailable"],
      failed: ["archived", "unavailable"],
      unavailable: ["ready", "running", "idle", "exited", "failed", "archived"],
      archived: ["idle", "exited"],
    });
  });

  test("create stamps creating/generation 0 and round-trips the selection", () =>
    withTempHome((home) =>
      use(home, (_rs, records) => {
        const sel = selection();
        const rec = records.create(newRecord(home, "s_aaa", { selection: sel }));
        expect(rec.state).toBe("creating");
        expect(rec.generation).toBe(0);
        expect(rec.createdAt).toBe(rec.updatedAt);
        expect(rec.transcriptDialect).toBe("claude-code-jsonl");
        const read = records.get("s_aaa");
        expect(read).toEqual(rec);
        expect(read?.selection).toEqual(sel);
        expect(read?.capabilities).toEqual([]);
        expect(records.get("s_nope")).toBeUndefined();
      })));

  test("capabilities and the optional columns survive a round-trip", () =>
    withTempHome((home) =>
      use(home, (_rs, records) => {
        const rec = records.create(
          newRecord(home, "s_opt", {
            capabilities: ["messaging", "handoff"],
            connectionRef: "conn_1",
            effectiveTempDir: "/private/tmp/norma-501/s_opt",
            parentWinterSessionId: "s_parent",
            lastVerifiedClaudeConsumer: "2.0.1",
          }),
        );
        expect(records.get("s_opt")).toEqual(rec);
        expect(rec.capabilities).toEqual(["messaging", "handoff"]);
        expect(rec.connectionRef).toBe("conn_1");
        expect(rec.parentWinterSessionId).toBe("s_parent");
        expect(rec.backendSessionId).toBeUndefined();
      })));

  test("byBackendSessionId resolves the mapping, and a second claim on the same uuid is typed", () =>
    withTempHome((home) =>
      use(home, (_rs, records) => {
        records.create(newRecord(home, "s_a"));
        records.create(newRecord(home, "s_b"));
        records.transition("s_a", "ready", { backendSessionId: UUID });
        expect(records.byBackendSessionId(UUID)?.winterSessionId).toBe("s_a");
        expect(records.byBackendSessionId("00000000-0000-4000-8000-000000000000")).toBeUndefined();

        let caught: unknown;
        try {
          records.transition("s_b", "ready", { backendSessionId: UUID });
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(DuplicateBackendSessionError);
        expect((caught as DuplicateBackendSessionError).backendSessionId).toBe(UUID);
        expect((caught as DuplicateBackendSessionError).existingWinterSessionId).toBe("s_a");
        // the refused transition left s_b exactly as it was — never half-applied
        expect(records.get("s_b")?.state).toBe("creating");
        expect(records.get("s_b")?.backendSessionId).toBeUndefined();

        expect(() => records.create(newRecord(home, "s_c", { backendSessionId: UUID }))).toThrow(DuplicateBackendSessionError);
        expect(records.get("s_c")).toBeUndefined();
      })));

  test("transition enforces the WS-16 §4 table, and archive re-enters only deliberately", () =>
    withTempHome((home) =>
      use(home, (_rs, records) => {
        records.create(newRecord(home, "s_t"));
        expect(() => records.transition("s_t", "running")).toThrow(IllegalStateTransitionError);
        expect(records.get("s_t")?.state).toBe("creating");

        for (const to of ["ready", "running", "idle", "archived"] as const) records.transition("s_t", to);
        expect(records.get("s_t")?.state).toBe("archived");
        expect(() => records.transition("s_t", "running")).toThrow(IllegalStateTransitionError);
        // "archive is not delete": the unarchive door is idle/exited, and it is open
        expect(ALLOWED_TRANSITIONS.archived).toEqual(["idle", "exited"]);
        records.transition("s_t", "idle");
        expect(records.get("s_t")?.state).toBe("idle");

        let caught: unknown;
        try {
          records.transition("s_t", "creating");
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(IllegalStateTransitionError);
        expect((caught as IllegalStateTransitionError).from).toBe("idle");
        expect((caught as IllegalStateTransitionError).to).toBe("creating");

        expect(() => records.transition("s_missing", "ready")).toThrow(UnknownRuntimeSessionError);
      })));

  test("transition patches only the named fields and moves updatedAt", () =>
    withTempHome((home) =>
      use(home, (rs) => {
        let tick = 0;
        const clocked = new RuntimeSessionRecords(rs, () => `2026-09-10T00:00:0${tick++}.000Z`);
        clocked.create(newRecord(home, "s_p"));
        const patched = clocked.transition("s_p", "ready", {
          backendSessionId: UUID,
          activeLocalWriteRoot: "/private/tmp/spool/s_p",
          activeLocalWriteRootKind: "official-spool",
          transcriptHealth: "mirror-lagging",
          lastProjectedCursor: "42",
          capabilities: ["resume"],
        });
        expect(patched.createdAt).toBe("2026-09-10T00:00:00.000Z");
        expect(patched.updatedAt).toBe("2026-09-10T00:00:01.000Z");
        expect(patched.backendSessionId).toBe(UUID);
        expect(patched.activeLocalWriteRootKind).toBe("official-spool");
        expect(patched.transcriptHealth).toBe("mirror-lagging");
        expect(patched.capabilities).toEqual(["resume"]);
        // untouched fields keep their creation values
        expect(patched.modelRef).toBe("gpt-5.6-sol");
        expect(patched.compatibilityLevel).toBe("conversation");
      })));

  test("an explicit undefined clears a nullable column and is ignored for a NOT NULL one", () =>
    withTempHome((home) =>
      use(home, (_rs, records) => {
        // Review r1 minor 6: `transcript_health` and `capabilities_json` are NOT NULL, so an
        // explicit `undefined` there must be "no change" rather than a raw SQLite refusal.
        records.create(newRecord(home, "s_u", { activeLocalWriteRoot: "/private/tmp/spool/s_u", capabilities: ["resume"] }));
        const patched = records.transition("s_u", "ready", {
          activeLocalWriteRoot: undefined,
          transcriptHealth: undefined,
          capabilities: undefined,
        });
        expect(patched.activeLocalWriteRoot).toBeUndefined();
        expect(patched.transcriptHealth).toBe("clean");
        expect(patched.capabilities).toEqual(["resume"]);
      })));

  test("list filters by state, runtime kind and parent", () =>
    withTempHome((home) =>
      use(home, (_rs, records) => {
        records.create(newRecord(home, "s_1"));
        records.create(newRecord(home, "s_2", { runtimeKind: "claude-agent" }));
        records.create(newRecord(home, "s_3", { parentWinterSessionId: "s_1" }));
        records.transition("s_2", "ready");
        records.transition("s_3", "ready");
        records.transition("s_3", "running");

        expect(records.list().map((r) => r.winterSessionId).sort()).toEqual(["s_1", "s_2", "s_3"]);
        expect(records.list({ state: "creating" }).map((r) => r.winterSessionId)).toEqual(["s_1"]);
        expect(records.list({ state: ["ready", "running"] }).map((r) => r.winterSessionId).sort()).toEqual(["s_2", "s_3"]);
        expect(records.list({ runtimeKind: "claude-agent" }).map((r) => r.winterSessionId)).toEqual(["s_2"]);
        expect(records.list({ parentWinterSessionId: "s_1" }).map((r) => r.winterSessionId)).toEqual(["s_3"]);
        expect(records.list({ state: "archived" })).toEqual([]);
      })));

  test("bumpGeneration appends a generation row per attach and endGeneration closes one", () =>
    withTempHome((home) =>
      use(home, (rs, records) => {
        records.create(newRecord(home, "s_g"));
        const first = records.bumpGeneration("s_g", {
          runtimeKind: "winter-agent",
          backendSessionId: UUID,
          localWriteRoot: "/private/tmp/spool/s_g",
          localWriteRootKind: "official-spool",
          configDir: join(home, "runtimes", "official-agent-spool"),
        });
        expect(first.generation).toBe(1);
        const second = records.bumpGeneration("s_g", { runtimeKind: "claude-agent" });
        expect(second.generation).toBe(2);
        expect(second.record.generation).toBe(2);
        expect(records.get("s_g")?.generation).toBe(2);

        const rows = records.generations("s_g");
        expect(rows.map((r) => r.generation)).toEqual([1, 2]);
        expect(rows[0]?.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
        expect(rows[1]?.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
        expect(rows[0]?.runtimeKind).toBe("winter-agent");
        expect(rows[1]?.runtimeKind).toBe("claude-agent");
        expect(rows[0]?.localWriteRootKind).toBe("official-spool");
        expect(rows[0]?.endedAt).toBeUndefined();

        records.endGeneration("s_g", 1, "handoff");
        const closed = records.generations("s_g");
        expect(closed[0]?.endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(closed[0]?.endReason).toBe("handoff");
        expect(closed[1]?.endedAt).toBeUndefined();

        // Task 5 owns the lease_* columns; nothing here may write them.
        expect(rs.db.query("SELECT count(*) AS n FROM runtime_generations WHERE lease_holder_pid IS NOT NULL OR lease_renewed_at IS NOT NULL").get()).toEqual({ n: 0 });
        expect(() => records.bumpGeneration("s_missing", { runtimeKind: "winter-agent" })).toThrow(UnknownRuntimeSessionError);
        // Review r1 minor 10: closing a generation that does not exist is a typed refusal, not a
        // zero-row UPDATE reported as success — the same type the lease half of this table uses.
        let caught: unknown;
        try {
          records.endGeneration("s_g", 9, "handoff");
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(UnknownRuntimeGenerationError);
        expect((caught as UnknownRuntimeGenerationError).generation).toBe(9);
        expect(() => records.endGeneration("s_missing", 1, "handoff")).toThrow(UnknownRuntimeGenerationError);
      })));

  test("the handoff history is append-only and ordered", () =>
    withTempHome((home) =>
      use(home, (rs, records) => {
        records.create(newRecord(home, "s_h"));
        records.create(newRecord(home, "s_other"));
        const first = records.recordHandoff({
          winterSessionId: "s_h",
          from: "winter-agent",
          to: "claude-agent",
          fromGeneration: 1,
          toGeneration: 2,
          outcome: "resumed",
          detail: { note: "certified corpus" },
        });
        const second = records.recordHandoff({ winterSessionId: "s_h", from: "claude-agent", to: "winter-agent", fromGeneration: 2, outcome: "blocked" });
        records.recordHandoff({ winterSessionId: "s_other", from: "winter-agent", to: "claude-agent", fromGeneration: 0, outcome: "failed" });
        expect(second).toBeGreaterThan(first);

        const entries = records.handoffs("s_h");
        expect(entries.map((e) => e.outcome)).toEqual(["resumed", "blocked"]);
        expect(entries[0]?.detail).toEqual({ note: "certified corpus" });
        expect(entries[0]?.toGeneration).toBe(2);
        expect(entries[1]?.toGeneration).toBeUndefined();
        expect(rs.db.query("SELECT count(*) AS n FROM runtime_handoffs").get()).toEqual({ n: 3 });

        // "never overwrite the only evidence of the previous producer": there is no mutating door.
        expect((records as unknown as Record<string, unknown>).deleteHandoff).toBeUndefined();
        expect((records as unknown as Record<string, unknown>).updateHandoff).toBeUndefined();
      })));

  test("setTranscriptHealth and recordDialect write their own rows", () =>
    withTempHome((home) =>
      use(home, (rs, records) => {
        records.create(newRecord(home, "s_d"));
        records.setTranscriptHealth("s_d", "repair-required");
        expect(records.get("s_d")?.transcriptHealth).toBe("repair-required");

        records.recordDialect("s_d", { dialect: "claude-code-jsonl", corpusVersion: "2026-09", producer: "winter-agent@0.0.2" });
        records.recordDialect("s_d", { dialect: "claude-code-jsonl", corpusVersion: "2026-10", consumer: "claude-agent@2.0.1" });
        const row = rs.db.query("SELECT dialect, corpus_version, producer, consumer FROM transcript_dialects WHERE winter_session_id = 's_d'").get();
        expect(row).toEqual({ dialect: "claude-code-jsonl", corpus_version: "2026-10", producer: null, consumer: "claude-agent@2.0.1" });
        expect(rs.db.query("SELECT count(*) AS n FROM transcript_dialects").get()).toEqual({ n: 1 });
        expect(() => records.setTranscriptHealth("s_missing", "clean")).toThrow(UnknownRuntimeSessionError);
      })));

  // Migration A phase 5's record-side half: the key names a DIRECTORY, and several sessions in one
  // repo share it, so the door is keyed by the old key rather than by a session id.
  test("rekeyMemoryProjectKey moves every record under one memory key and touches nothing else", () =>
    withTempHome((home) =>
      use(home, (_rs, records) => {
        records.create(newRecord(home, "s_a", { memoryProjectKey: "shared-old" }));
        records.create(newRecord(home, "s_b", { memoryProjectKey: "shared-old" }));
        records.create(newRecord(home, "s_c", { memoryProjectKey: "other-old" }));

        expect(records.rekeyMemoryProjectKey("shared-old", "shared-new")).toBe(2);
        expect(records.get("s_a")?.memoryProjectKey).toBe("shared-new");
        expect(records.get("s_b")?.memoryProjectKey).toBe("shared-new");
        expect(records.get("s_c")?.memoryProjectKey).toBe("other-old");
        // The transcript/temp layout is a different algorithm and is deliberately left alone.
        expect(records.get("s_a")?.transcriptProjectKey).toBe("-tmp-work");
        expect(records.get("s_a")?.tempProjectKey).toBe("-tmp-work");

        // A key nothing is stored under is a no-op, never a throw: the migration re-runs.
        expect(records.rekeyMemoryProjectKey("shared-old", "shared-new")).toBe(0);
      })));

  test("recorded provenance requires the versions it claims to have recorded", () =>
    withTempHome((home) =>
      use(home, (_rs, records) => {
        expect(() => records.create(newRecord(home, "s_v1", { sdkVersion: undefined }))).toThrow(VersionProvenanceError);
        expect(() => records.create(newRecord(home, "s_v2", { engineVersion: undefined }))).toThrow(VersionProvenanceError);
        // a winter-agent record also owes the catalog/adapter versions (WS-13)
        expect(() => records.create(newRecord(home, "s_v3", { providerCatalogVersion: undefined }))).toThrow(VersionProvenanceError);
        expect(() => records.create(newRecord(home, "s_v4", { providerAdapterVersion: undefined }))).toThrow(VersionProvenanceError);
        expect(records.list()).toEqual([]);

        // legacy-unknown is the one shape allowed to omit them
        records.create(
          newRecord(home, "s_legacy", {
            versionProvenance: "legacy-unknown",
            sdkVersion: undefined,
            engineVersion: undefined,
            providerCatalogVersion: undefined,
            providerAdapterVersion: undefined,
          }),
        );
        expect(records.get("s_legacy")?.versionProvenance).toBe("legacy-unknown");
        expect(records.get("s_legacy")?.sdkVersion).toBeUndefined();

        // a claude-agent record owes sdk+engine only
        records.create(newRecord(home, "s_official", { runtimeKind: "claude-agent", providerCatalogVersion: undefined, providerAdapterVersion: undefined }));
        expect(records.get("s_official")?.sdkVersion).toBe("0.0.2");
      })));

  test("authRef stores the locator only — never credential material", () =>
    withTempHome((home) =>
      use(home, (rs, records) => {
        records.create(newRecord(home, "s_auth", { authRef: "keychain:openai-api-key" }));
        expect(rs.db.query("SELECT auth_ref FROM runtime_sessions WHERE winter_session_id = 's_auth'").get()).toEqual({ auth_ref: "keychain:openai-api-key" });
        expect(records.get("s_auth")?.authRef).toBe("keychain:openai-api-key");
        expect(JSON.stringify(rs.db.query("SELECT * FROM runtime_sessions").all())).not.toContain("sk-");
      })));
});
