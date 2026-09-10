import { describe, expect, test } from "bun:test";
import { buildChildAddress, buildSessionAddress, serializeRuntimeAddress } from "@yanlinglabs/winter-agent-sdk/messaging";
import type { DeliveryRecord, GlobalAgentMessage, RuntimeDirectoryEntry, RuntimeDirectoryStore, SerializedRuntimeAddress } from "@yanlinglabs/winter-runtime-sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ProjectionCheckpoints, RuntimeChildren, RuntimeLeases, RuntimeSessionRecords, archiveSession,
  createSqliteRuntimeDirectoryStore, deleteSessionRuntimeState, openRuntimeStateDb, retentionFromSettings,
  sweepRetention, type RuntimeStateDb,
} from "../../src/runtime-state";
import { Settings } from "../../src/settings";
import { ISO, withTempHome } from "./support";

const DAY = 86_400_000;
const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

const addr = (id: string): SerializedRuntimeAddress => serializeRuntimeAddress(buildSessionAddress(id));
const childAddr = (parent: string, child: string): SerializedRuntimeAddress => serializeRuntimeAddress(buildChildAddress(parent, child));

const message = (messageId: string, to: SerializedRuntimeAddress): GlobalAgentMessage => ({
  messageId,
  from: buildSessionAddress("s_sender"),
  fromGeneration: 1,
  to: to.startsWith("agent:")
    ? buildChildAddress(to.split(":")[1]!, to.split(":")[2]!)
    : buildSessionAddress(to.slice("session:".length)),
  toGeneration: 1,
  body: "hi",
  notifyWhenIdle: false,
  createdAt: Date.now(),
  expiresAt: Date.now() + DAY,
  hopCount: 0,
  senderPermissionClass: "prompts",
});

const delivery = (messageId: string, to: SerializedRuntimeAddress, extra: Partial<DeliveryRecord> = {}): DeliveryRecord => ({
  messageId, message: message(messageId, to), toGeneration: 1, updatedAt: ISO(), ...extra,
});

const entry = (address: SerializedRuntimeAddress): RuntimeDirectoryEntry => ({
  address, objectKind: address.startsWith("agent:") ? "agent" : "session", runtimeKind: "winter-agent",
  status: "idle", mode: "code", capabilities: { message: true, resume: true, notifyWhenIdle: true, reply: true },
  updatedAt: ISO(),
} as RuntimeDirectoryEntry);

function counts(rs: RuntimeStateDb): Record<string, number> {
  const tables = (rs.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = (rs.db.query(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
  return out;
}

const baseSettings = { schemaVersion: 2 as const, provider: { type: "codex-oauth" as const, model: "gpt-5.4" } };

/** A full runtime-state footprint for one session, on every table §16 names. */
async function seedSession(rs: RuntimeStateDb, store: RuntimeDirectoryStore, id: string): Promise<void> {
  const records = new RuntimeSessionRecords(rs);
  records.create({
    winterSessionId: id, runtimeKind: "winter-agent", backendSessionId: `uuid-${id}`, providerId: "codex-oauth",
    modelRef: "gpt-5.4", backendRoot: `/tmp/${id}`, transcriptProjectKey: `-tmp-${id}`, memoryProjectKey: `tmp-${id}`,
    tempProjectKey: `-tmp-${id}`, transcriptHealth: "unsupported", compatibilityLevel: "conversation",
    conformanceCorpusVersion: "legacy", versionProvenance: "legacy-unknown", capabilities: ["import-conversation"],
    selection: { runtimeKind: "winter-agent", providerId: "codex-oauth", modelRef: "gpt-5.4", family: "legacy", authFamily: "custom", sdkVersion: "unknown", reason: "backfill", decidedAt: ISO() },
  });
  records.transition(id, "ready");
  const { generation } = records.bumpGeneration(id, { runtimeKind: "winter-agent" });
  records.recordHandoff({ winterSessionId: id, from: "winter-agent", to: "claude-agent", fromGeneration: generation, outcome: "blocked" });
  records.recordDialect(id, { dialect: "claude-code-jsonl", corpusVersion: "legacy" });
  new RuntimeLeases(rs, { pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z" }).acquire(id, generation);
  new RuntimeChildren(rs).upsert({
    parentWinterSessionId: id, childId: "c1", agentType: "explore", providerId: "codex-oauth", modelRef: "gpt-5.4",
    providerCatalogVersion: "1", providerAdapterVersion: "1", status: "running", transcriptRef: `/tmp/${id}/c1.jsonl`,
    startedAt: ISO(), generation,
  });
  const checkpoints = new ProjectionCheckpoints(rs);
  checkpoints.begin({ winterSessionId: id, generation, sourceId: "src-1" });
  checkpoints.complete({ winterSessionId: id, generation, sourceId: "src-1" }, { runtimeKind: "winter-agent", backendCursor: "10", lastWinterSeq: 4 }, { first: 1, last: 4 });

  await store.upsert(entry(addr(id)));
  await store.upsert(entry(childAddr(id, "c1")));
  await store.cursors.set(addr(id), "cur-1");
  await store.cursors.set(childAddr(id, "c1"), "cur-2");
  await store.mailboxes.hold({ receiver: addr(id), messageId: `held-${id}`, reason: "busy", kind: "default", heldAt: Date.now(), message: message(`held-${id}`, addr(id)) });
  await store.subscriptions.add({ messageId: `sub-${id}`, subscriber: addr("s_other"), target: addr(id), targetGeneration: 1, createdAt: Date.now(), expiresAt: Date.now() + DAY });
  // Receipted, so the delete also has a `global_message_receipts` row to reach — an unreceipted
  // delivery would leave that table untouched and the reach assertion would be quietly weaker.
  await store.deliveries.put(delivery(`del-${id}`, addr(id), { claimedBy: "winter-agent", outcome: { status: "delivered", messageId: `del-${id}` } }));
  await store.names.claim({ name: `name-${id}`, address: addr(id), generation, claimedAt: ISO() });
}

describe("retentionFromSettings", () => {
  test("absent settings are 30 days of deliveries and 7 of released name leases", () => {
    expect(retentionFromSettings(undefined)).toEqual({ deliveriesMs: 30 * DAY, nameLeasesMs: 7 * DAY });
  });

  test("the shipped schema defaults match the absent-settings answer", () => {
    expect(retentionFromSettings(Settings.parse(baseSettings))).toEqual({ deliveriesMs: 30 * DAY, nameLeasesMs: 7 * DAY });
  });

  test("configured values win", () => {
    const s = Settings.parse({ ...baseSettings, runtimes: { retention: { deliveriesDays: 1, nameLeasesDays: 90 } } });
    expect(retentionFromSettings(s)).toEqual({ deliveriesMs: DAY, nameLeasesMs: 90 * DAY });
  });
});

describe("sweepRetention", () => {
  test("prunes what has been settled long enough and never what is still evidence", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const store = createSqliteRuntimeDirectoryStore(rs);

        // A receipted delivery, older than the window.
        await store.deliveries.put(delivery("old-receipted", addr("s_a"), { updatedAt: iso(40 * DAY), outcome: { status: "delivered", messageId: "old-receipted" } }));
        // A receipted delivery inside the window.
        await store.deliveries.put(delivery("fresh-receipted", addr("s_a"), { updatedAt: iso(1 * DAY), outcome: { status: "delivered", messageId: "fresh-receipted" } }));
        // Claimed but never receipted — WS-15 §6.4's ONLY evidence for `delivery_uncertain`, and so
        // immortal at any age.
        await store.deliveries.put(delivery("ancient-claimed", addr("s_a"), { updatedAt: iso(999 * DAY), claimedBy: "winter-agent" }));
        // BETWEEN the two windows (14 d): inside the 30-day delivery window, outside the 7-day lease
        // one. This pair is what pins each cutoff to its OWN table — with only same-side fixtures,
        // swapping the two windows would pass unnoticed.
        await store.deliveries.put(delivery("mid-window-receipted", addr("s_a"), { updatedAt: iso(14 * DAY), outcome: { status: "delivered", messageId: "mid-window-receipted" } }));

        await store.names.claim({ name: "old-released", address: addr("s_a"), generation: 1, claimedAt: iso(60 * DAY), releasedAt: iso(30 * DAY) });
        await store.names.claim({ name: "fresh-released", address: addr("s_b"), generation: 1, claimedAt: iso(3 * DAY), releasedAt: iso(1 * DAY) });
        await store.names.claim({ name: "mid-window-released", address: addr("s_d"), generation: 1, claimedAt: iso(20 * DAY), releasedAt: iso(14 * DAY) });
        // Held: the live answer to "who owns this name", never pruned at any age.
        await store.names.claim({ name: "still-held", address: addr("s_c"), generation: 1, claimedAt: iso(999 * DAY) });

        expect(await sweepRetention(store, retentionFromSettings(undefined))).toEqual({ deliveriesPruned: 1, leasesPruned: 2 });

        expect(await store.deliveries.get("old-receipted")).toBeUndefined();
        expect(await store.deliveries.get("fresh-receipted")).toBeDefined();
        expect(await store.deliveries.get("ancient-claimed")).toBeDefined();
        expect(await store.deliveries.get("mid-window-receipted")).toBeDefined();   // 14 d < 30 d
        expect((await store.names.lookup("mid-window-released")).length).toBe(0);   // 14 d > 7 d
        expect((await store.names.lookup("old-released")).length).toBe(0);
        expect((await store.names.lookup("fresh-released")).length).toBe(1);
        expect((await store.names.lookup("still-held")).length).toBe(1);
      } finally {
        rs.close();
      }
    });
  });

  test("a sweep on an empty store prunes nothing", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        expect(await sweepRetention(createSqliteRuntimeDirectoryStore(rs), retentionFromSettings(undefined)))
          .toEqual({ deliveriesPruned: 0, leasesPruned: 0 });
      } finally {
        rs.close();
      }
    });
  });

  test("the cutoff is read from the retention it was handed, not from a fixed window", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const store = createSqliteRuntimeDirectoryStore(rs);
        await store.deliveries.put(delivery("two-days", addr("s_a"), { updatedAt: iso(2 * DAY), outcome: { status: "delivered", messageId: "two-days" } }));
        expect(await sweepRetention(store, retentionFromSettings(undefined))).toEqual({ deliveriesPruned: 0, leasesPruned: 0 });
        expect(await sweepRetention(store, { deliveriesMs: DAY, nameLeasesMs: DAY })).toEqual({ deliveriesPruned: 1, leasesPruned: 0 });
      } finally {
        rs.close();
      }
    });
  });
});

describe("deleteSessionRuntimeState", () => {
  test("removes every row for the session and nothing for a sibling", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const store = createSqliteRuntimeDirectoryStore(rs);
        const records = new RuntimeSessionRecords(rs);
        const leases = new RuntimeLeases(rs, { pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z" });
        const children = new RuntimeChildren(rs);
        await seedSession(rs, store, "s_doomed");
        await seedSession(rs, store, "s_sibling");
        const before = counts(rs);

        const { removed } = await deleteSessionRuntimeState({ rs, records, leases, children, directory: store }, "s_doomed");

        // Every table §16 names is reported, so an operator can audit what a delete reached.
        expect(removed).toEqual([
          "runtime_sessions", "runtime_children", "directory_entries", "directory_cursors",
          "idle_subscriptions", "held_messages", "global_messages", "global_message_receipts",
          "name_leases", "runtime_projection_cursors", "projection_applied", "transcript_dialects",
          "runtime_handoffs", "runtime_generations",
        ]);

        expect(records.get("s_doomed")).toBeUndefined();
        expect(children.list("s_doomed")).toEqual([]);
        expect(new ProjectionCheckpoints(rs).latest("s_doomed")).toBeUndefined();
        expect((await store.load()).map((e) => e.address)).toEqual([addr("s_sibling"), childAddr("s_sibling", "c1")].sort());
        expect(await store.cursors.get(addr("s_doomed"))).toBeUndefined();
        expect(await store.mailboxes.listHeld(addr("s_doomed"))).toEqual([]);
        expect(await store.deliveries.get("del-s_doomed")).toBeUndefined();
        expect((await store.subscriptions.list()).map((s) => s.target)).toEqual([addr("s_sibling")]);

        // Name leases are RELEASED, not deleted: WS-10 §11 rule 5 needs a released row to answer
        // "that name referred to something that has gone" rather than "no such agent". Retention's
        // 7-day sweep is what finally removes it.
        const lease = await store.names.lookup("name-s_doomed");
        expect(lease.length).toBe(1);
        expect(lease[0]!.releasedAt).toBeTruthy();

        // Exactly the doomed session's rows left, table by table — the sibling's are all still there.
        const after = counts(rs);
        const delta = (table: string): number => (after[table] ?? 0) - (before[table] ?? 0);
        expect(records.get("s_sibling")).toBeDefined();
        expect(children.list("s_sibling").length).toBe(1);
        expect(delta("runtime_sessions")).toBe(-1);
        expect(delta("runtime_generations")).toBe(-1);
        expect(delta("runtime_children")).toBe(-1);
        expect(delta("runtime_projection_cursors")).toBe(-1);
        expect(delta("projection_applied")).toBe(-1);
        expect(delta("runtime_handoffs")).toBe(-1);
        expect(delta("transcript_dialects")).toBe(-1);
        expect(delta("global_messages")).toBe(-1);
        expect(delta("global_message_receipts")).toBe(-1);
        expect(delta("held_messages")).toBe(-1);
        expect(delta("idle_subscriptions")).toBe(-1);
        expect(delta("directory_entries")).toBe(-2); // the session and its child
        expect(delta("directory_cursors")).toBe(-2);
        expect(delta("name_leases")).toBe(0); // released, never deleted
      } finally {
        rs.close();
      }
    });
  });

  test("a claimed-but-unreceipted delivery to the doomed session SURVIVES it, and is reported", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const store = createSqliteRuntimeDirectoryStore(rs);
        const records = new RuntimeSessionRecords(rs);
        const leases = new RuntimeLeases(rs, { pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z" });
        const children = new RuntimeChildren(rs);
        await seedSession(rs, store, "s_doomed"); // seeds `del-s_doomed`, receipted
        await seedSession(rs, store, "s_sibling");

        // The three shapes a delivery to this session can be in, side by side.
        await store.deliveries.put(delivery("m-claimed", addr("s_doomed"), { claimedBy: "winter-agent" }));
        await store.deliveries.put(delivery("m-unclaimed", addr("s_doomed")));
        await store.deliveries.put(delivery("m-sibling", addr("s_sibling"), { claimedBy: "winter-agent" }));
        expect((await store.deliveries.claimedWithoutReceipt()).map((d) => d.messageId).sort()).toEqual(["m-claimed", "m-sibling"]);

        const { retainedUnreceipted } = await deleteSessionRuntimeState({ rs, records, leases, children, directory: store }, "s_doomed");

        // (claimed, no receipt) is WS-15 §6.4 step 5's whole evidence for `delivery_uncertain`, and
        // it belongs to the SENDER — deleting the target must not answer the sender's question for
        // it. Receipted and never-claimed rows carry no such evidence and go.
        expect(retainedUnreceipted).toEqual(["m-claimed"]);
        expect(await store.deliveries.get("m-claimed")).toBeDefined();
        expect(await store.deliveries.get("m-unclaimed")).toBeUndefined();
        expect(await store.deliveries.get("del-s_doomed")).toBeUndefined();
        expect((await store.deliveries.claimedWithoutReceipt()).map((d) => d.messageId).sort()).toEqual(["m-claimed", "m-sibling"]);
      } finally {
        rs.close();
      }
    });
  });

  test("project memory is never touched", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const store = createSqliteRuntimeDirectoryStore(rs);
        await seedSession(rs, store, "s_doomed");
        const memory = join(home, "projects", "tmp-s_doomed", "memory");
        mkdirSync(memory, { recursive: true });
        writeFileSync(join(memory, "MEMORY.md"), "the user's own writing");

        await deleteSessionRuntimeState({
          rs, records: new RuntimeSessionRecords(rs),
          leases: new RuntimeLeases(rs, { pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z" }),
          children: new RuntimeChildren(rs), directory: store,
        }, "s_doomed");

        expect(existsSync(memory)).toBe(true);
        expect(readFileSync(join(memory, "MEMORY.md"), "utf8")).toBe("the user's own writing");
      } finally {
        rs.close();
      }
    });
  });

  test("deleting an unknown session is a no-op, not a throw", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const store = createSqliteRuntimeDirectoryStore(rs);
        await seedSession(rs, store, "s_kept");
        const before = counts(rs);
        const { removed } = await deleteSessionRuntimeState({
          rs, records: new RuntimeSessionRecords(rs),
          leases: new RuntimeLeases(rs, { pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z" }),
          children: new RuntimeChildren(rs), directory: store,
        }, "s_never-existed");
        expect(removed).toEqual([]);
        expect(counts(rs)).toEqual(before);
      } finally {
        rs.close();
      }
    });
  });

  test("a second delete of the same session is idempotent", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const store = createSqliteRuntimeDirectoryStore(rs);
        await seedSession(rs, store, "s_doomed");
        const deps = {
          rs, records: new RuntimeSessionRecords(rs),
          leases: new RuntimeLeases(rs, { pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z" }),
          children: new RuntimeChildren(rs), directory: store,
        };
        await deleteSessionRuntimeState(deps, "s_doomed");
        const after = counts(rs);
        expect((await deleteSessionRuntimeState(deps, "s_doomed")).removed).toEqual([]);
        expect(counts(rs)).toEqual(after);
      } finally {
        rs.close();
      }
    });
  });
});

describe("archiveSession", () => {
  test("sets archived and deletes nothing at all", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const store = createSqliteRuntimeDirectoryStore(rs);
        const records = new RuntimeSessionRecords(rs);
        await seedSession(rs, store, "s_old");
        records.transition("s_old", "exited");
        const before = counts(rs);

        archiveSession(records, "s_old");

        expect(records.get("s_old")!.state).toBe("archived");
        expect(counts(rs)).toEqual(before);
      } finally {
        rs.close();
      }
    });
  });

  test("archiving an already-archived session is a no-op, not a refusal", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const store = createSqliteRuntimeDirectoryStore(rs);
        const records = new RuntimeSessionRecords(rs);
        await seedSession(rs, store, "s_retired");
        records.transition("s_retired", "exited");
        archiveSession(records, "s_retired");
        const after = records.get("s_retired")!;

        // A legacy session the user retired BEFORE the runtime spine existed is backfilled straight
        // into `archived` (§17 phase 4), so "archive this" arrives at a record that is already
        // there. `archived → archived` is not an edge in the lifecycle table, so a second call has
        // to be a no-op rather than an `IllegalStateTransitionError` — the caller asked for a state
        // the record is already in.
        expect(() => archiveSession(records, "s_retired")).not.toThrow();
        expect(records.get("s_retired")).toEqual(after); // not even `updated_at` moves
      } finally {
        rs.close();
      }
    });
  });

  test("archiving refuses from a state the lifecycle does not allow it from", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const store = createSqliteRuntimeDirectoryStore(rs);
        const records = new RuntimeSessionRecords(rs);
        await seedSession(rs, store, "s_live");
        records.transition("s_live", "running");
        // A running session is not retired behind its own back; it is stopped first.
        expect(() => archiveSession(records, "s_live")).toThrow(/running → archived/);
        expect(records.get("s_live")!.state).toBe("running");
      } finally {
        rs.close();
      }
    });
  });
});
