import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { RuntimeSelection } from "@yanlinglabs/winter-runtime-sdk";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../src/runtime-state/db";
import { RuntimeSessionRecords, type NewRuntimeSessionRecord } from "../../src/runtime-state/records";
import {
  identityMatches,
  LeaseHeldError,
  processIsAlive,
  processStartedAt,
  RuntimeLeases,
  UnknownRuntimeGenerationError,
  type ProcessIdentity,
} from "../../src/runtime-state/leases";
import { ISO, withTempHome } from "./support";

/** A pid that cannot exist on either supported platform (macOS caps at 99998, Linux's default
 *  pid_max is 4194304 but the test never assumes a live one) — the "process is gone" fixture. */
const DEAD_PID = 999999;

const newRecord = (home: string, id: string): NewRuntimeSessionRecord => ({
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
  selection: {
    runtimeKind: "winter-agent",
    providerId: "openai",
    modelRef: "gpt-5.6-sol",
    family: "openai",
    authFamily: "api-key",
    sdkVersion: "0.0.2",
    reason: "test",
    decidedAt: ISO(),
  } satisfies RuntimeSelection,
});

const self = (): ProcessIdentity => ({ pid: process.pid, startedAt: processStartedAt(process.pid) });

/** Opens the db, seeds one session with `generations` attached generations, and always closes. */
const use = (
  home: string,
  fn: (ctx: { rs: RuntimeStateDb; records: RuntimeSessionRecords; leases: RuntimeLeases; id: string }) => void,
  generations = 1,
): void => {
  const rs = openRuntimeStateDb(home);
  try {
    const records = new RuntimeSessionRecords(rs);
    const id = "s_lease";
    records.create(newRecord(home, id));
    for (let i = 0; i < generations; i++) records.bumpGeneration(id, { runtimeKind: "winter-agent" });
    fn({ rs, records, leases: new RuntimeLeases(rs, self()), id });
  } finally {
    rs.close();
  }
};

describe("process identity", () => {
  test.skipIf(process.platform === "win32")("processStartedAt reads this process's real start time", () => {
    const at = processStartedAt(process.pid);
    expect(at).not.toBe("unknown");
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    // A start time is always in the past — and this is the timezone regression: `ps` renders wall
    // clock, so a reader in another timezone (Bun's test runner runs at UTC) would otherwise read
    // this process as having started in the future, i.e. as a DIFFERENT process.
    expect(new Date(at).getTime()).toBeLessThanOrEqual(Date.now());
  });

  test("a pid that cannot exist has no start identity and is not alive", () => {
    expect(processStartedAt(DEAD_PID)).toBe("unknown");
    expect(processIsAlive(DEAD_PID)).toBe(false);
    expect(processIsAlive(process.pid)).toBe(true);
  });

  test("identityMatches needs an equal pid AND two known, equal start times", () => {
    const a: ProcessIdentity = { pid: 42, startedAt: "2026-09-10T00:00:00.000Z" };
    expect(identityMatches(a, { ...a })).toBe(true);
    expect(identityMatches(a, { pid: 43, startedAt: a.startedAt })).toBe(false);
    expect(identityMatches(a, { pid: 42, startedAt: "2026-09-10T00:00:01.000Z" })).toBe(false);
    // "unknown" never matches — not even itself (WS-16 §11: never break on a PID alone)
    expect(identityMatches({ pid: 42, startedAt: "unknown" }, { pid: 42, startedAt: "unknown" })).toBe(false);
    expect(identityMatches(a, { pid: 42, startedAt: "unknown" })).toBe(false);
  });
});

describe("RuntimeLeases", () => {
  test("acquire records this process as the holder", () =>
    withTempHome((home) =>
      use(home, ({ rs, leases, id }) => {
        const lease = leases.acquire(id, 1);
        expect(lease.winterSessionId).toBe(id);
        expect(lease.generation).toBe(1);
        expect(lease.holder).toEqual(self());
        expect(lease.renewedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
        expect(lease.releasedAt).toBeUndefined();
        expect(leases.holder(id)).toEqual(lease);
        // the lease lives on the generation row, and never disturbs its owner's columns
        expect(rs.db.query("SELECT lease_holder_pid AS pid, started_at, ended_at FROM runtime_generations WHERE winter_session_id = ? AND generation = 1").get(id)).toMatchObject({
          pid: process.pid,
          ended_at: null,
        });
        expect(leases.holder("s_nobody")).toBeUndefined();
      })));

  test("a second live holder is refused, and the recorded holder is untouched", () =>
    withTempHome((home) =>
      use(home, ({ leases, rs, id }) => {
        const first = leases.acquire(id, 1);
        const other = new RuntimeLeases(rs, { pid: process.pid, startedAt: processStartedAt(process.pid) });
        let caught: unknown;
        try {
          other.acquire(id, 1);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(LeaseHeldError);
        expect((caught as LeaseHeldError).winterSessionId).toBe(id);
        expect((caught as LeaseHeldError).holder).toEqual(first.holder);
        expect(leases.holder(id)).toEqual(first);
      })));

  test("one live lease refuses a second writer on any generation of the same session", () =>
    withTempHome(
      (home) =>
        use(
          home,
          ({ leases, id }) => {
            leases.acquire(id, 1);
            expect(() => leases.acquire(id, 2)).toThrow(LeaseHeldError);
            leases.release(id, 1);
            expect(leases.acquire(id, 2).generation).toBe(2);
          },
          2,
        ),
    ));

  test("a lease whose holder is provably gone is stale, breakable, and then re-acquirable", () =>
    withTempHome((home) =>
      use(home, ({ rs, leases, id }) => {
        const dead = new RuntimeLeases(rs, { pid: DEAD_PID, startedAt: "2020-01-01T00:00:00.000Z" });
        const planted = dead.acquire(id, 1);
        expect(leases.holder(id)?.holder.pid).toBe(DEAD_PID);

        expect(leases.revalidate(planted, { alive: () => false, startedAt: () => "unknown" })).toBe("stale");
        expect(leases.breakStale(id, 1, "daemon restart")).toBe(true);
        expect(leases.holder(id)).toBeUndefined();
        // breaking is idempotent: nothing left to break
        expect(leases.breakStale(id, 1, "daemon restart")).toBe(false);

        const mine = leases.acquire(id, 1);
        expect(mine.holder).toEqual(self());
      })));

  test("a pid that is alive with a different start time is a reused pid, not our holder", () =>
    withTempHome((home) =>
      use(home, ({ rs, leases, id }) => {
        new RuntimeLeases(rs, { pid: process.pid, startedAt: "2020-01-01T00:00:00.000Z" }).acquire(id, 1);
        const planted = leases.holder(id);
        expect(planted).toBeDefined();
        expect(leases.revalidate(planted!)).toBe("stale");
        // acquire revalidates before it refuses, so a lease that is PROVABLY stale (and only such a
        // lease) is taken over in place — breakStale stays the door recovery uses to record why.
        expect(leases.acquire(id, 1).holder).toEqual(self());
        expect(leases.holder(id)?.holder.startedAt).not.toBe("2020-01-01T00:00:00.000Z");
      })));

  test("an unknown start identity is never broken on a PID alone", () =>
    withTempHome((home) =>
      use(home, ({ rs, leases, id }) => {
        new RuntimeLeases(rs, { pid: process.pid, startedAt: "unknown" }).acquire(id, 1);
        const planted = leases.holder(id);
        expect(planted?.holder.startedAt).toBe("unknown");
        expect(leases.revalidate(planted!, { alive: () => true, startedAt: () => ISO() })).toBe("unknown");
        expect(leases.revalidate(planted!)).toBe("unknown");
        expect(leases.breakStale(id, 1, "restart")).toBe(false);
        expect(leases.holder(id)?.holder.pid).toBe(process.pid);
        expect(() => leases.acquire(id, 1)).toThrow(LeaseHeldError);
      })));

  test("release clears the holder; releasing someone else's lease does nothing", () =>
    withTempHome((home) =>
      use(home, ({ rs, leases, id }) => {
        leases.acquire(id, 1);
        leases.release(id, 1);
        expect(leases.holder(id)).toBeUndefined();
        expect(leases.acquire(id, 1).holder).toEqual(self());

        const stranger = new RuntimeLeases(rs, { pid: DEAD_PID, startedAt: "2020-01-01T00:00:00.000Z" });
        stranger.release(id, 1);
        expect(leases.holder(id)?.holder).toEqual(self());
      })));

  test("renew moves renewedAt, and only the holder may renew", () =>
    withTempHome((home) =>
      use(home, ({ rs, id }) => {
        let tick = 0;
        const mine = new RuntimeLeases(rs, self(), () => `2026-09-10T00:00:0${tick++}.000Z`);
        const lease = mine.acquire(id, 1);
        expect(lease.renewedAt).toBe("2026-09-10T00:00:00.000Z");
        mine.renew(id, 1);
        expect(mine.holder(id)?.renewedAt).toBe("2026-09-10T00:00:01.000Z");

        const stranger = new RuntimeLeases(rs, { pid: DEAD_PID, startedAt: "2020-01-01T00:00:00.000Z" });
        expect(() => stranger.renew(id, 1)).toThrow(LeaseHeldError);
        mine.release(id, 1);
        expect(() => mine.renew(id, 1)).toThrow(UnknownRuntimeGenerationError);
      })));

  test("a generation that was never recorded cannot be leased", () =>
    withTempHome((home) =>
      use(home, ({ leases, id }) => {
        let caught: unknown;
        try {
          leases.acquire(id, 7);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(UnknownRuntimeGenerationError);
        expect((caught as UnknownRuntimeGenerationError).generation).toBe(7);
        expect((caught as UnknownRuntimeGenerationError).winterSessionId).toBe(id);
        expect(leases.holder(id)).toBeUndefined();
      })));
});
