import { describe, expect, test } from "bun:test";
import { buildChildAddress, buildSessionAddress, serializeRuntimeAddress } from "@yanlinglabs/winter-agent-sdk/messaging";
import { createInMemoryRuntimeDirectoryStore } from "@yanlinglabs/winter-runtime-sdk";
import type {
  DeliveryRecord, GlobalAgentMessage, HeldMessageRecord, IdleSubscriptionRecord, NameLeaseRecord,
  RuntimeDirectoryEntry, RuntimeDirectoryStore, SerializedRuntimeAddress,
} from "@yanlinglabs/winter-runtime-sdk";
import { openRuntimeStateDb } from "../../src/runtime-state/db";
import { createSqliteRuntimeDirectoryStore } from "../../src/runtime-state/directory-store";
import { withTempHome } from "./support";

// ── The scenario's fixed cast ───────────────────────────────────────────────────────────────────
// Every address, message id and name the scripted scenario ever touches is named here, because the
// snapshot probes a FIXED key set at every step: a snapshot that only listed what happens to exist
// would go quiet exactly where a divergence lives (a receiver the SQLite store forgot to delete, a
// lease the reference kept). Probing the same keys before and after makes absence itself an
// assertion.
const ADDR_A: SerializedRuntimeAddress = serializeRuntimeAddress(buildSessionAddress("s_a"));
const ADDR_B: SerializedRuntimeAddress = serializeRuntimeAddress(buildChildAddress("s_a", "c_1"));
const ADDR_C: SerializedRuntimeAddress = serializeRuntimeAddress(buildSessionAddress("s_c"));
const RECEIVERS = [ADDR_A, ADDR_B, ADDR_C];
const DELIVERY_IDS = ["d_unclaimed", "d_claimed", "d_receipted"];
const SUB_IDS = ["sub_1", "sub_2"];
const NAMES = ["alpha", "beta"];

const SELECTION = {
  runtimeKind: "winter-agent", providerId: "anthropic", modelRef: "anthropic/claude-opus-5", family: "claude",
  authFamily: "api-key", sdkVersion: "0.0.2", engineVersion: "1.2.3", reason: "d13-row-2",
  decidedAt: "2026-09-10T00:00:00.000Z",
} as const;

const ENTRY_A: RuntimeDirectoryEntry = {
  address: ADDR_A, parsed: buildSessionAddress("s_a"), runtimeKind: "winter-agent", objectKind: "session",
  transport: "winter-session", displayName: "alpha", title: "Alpha session", status: "running", mode: "code",
  cwd: "/tmp/alpha", generation: 3, selection: { ...SELECTION },
  backendSessionId: "be_a", configDir: "/tmp/claude-resume-abc",
  processIdentity: { pid: 4242, startedAt: "2026-09-09T23:59:00.000Z" }, remoteConfig: "deny",
  capabilities: { message: true, resume: true, notifyWhenIdle: true, reply: true },
  updatedAt: "2026-09-10T00:00:01.000Z",
};
const ENTRY_B: RuntimeDirectoryEntry = {
  address: ADDR_B, parsed: buildChildAddress("s_a", "c_1"), runtimeKind: "claude-agent", objectKind: "agent",
  transport: "claude-child", status: "idle", mode: "dispatch", generation: 1,
  selection: { ...SELECTION, runtimeKind: "claude-agent", authFamily: "claude-oauth", reason: "d13-row-1" },
  parentAddress: ADDR_A, capabilities: { message: true, resume: false, notifyWhenIdle: true, reply: false },
  updatedAt: "2026-09-10T00:00:02.000Z",
};

const message = (messageId: string): GlobalAgentMessage => ({
  messageId, from: buildSessionAddress("s_a"), fromGeneration: 3, to: buildSessionAddress("s_c"), toGeneration: 1,
  body: `body of ${messageId}`, summary: "a summary", notifyWhenIdle: false,
  createdAt: 1_757_462_400_000, expiresAt: 1_757_462_460_000, hopCount: 1,
  originToolCallId: "toolu_01", senderPermissionClass: "prompts",
});
const heldRecord = (receiver: SerializedRuntimeAddress, messageId: string, extra: Partial<HeldMessageRecord> = {}): HeldMessageRecord => ({
  messageId, receiver, reason: "permission-class prompts", kind: "explicit", heldAt: 1_757_462_400_000,
  message: message(messageId), ...extra,
});
const subscription = (messageId: string, target: SerializedRuntimeAddress): IdleSubscriptionRecord => ({
  messageId, subscriber: ADDR_A, target, targetGeneration: 2,
  createdAt: 1_757_462_400_000, expiresAt: 1_757_505_600_000,
});
const lease = (name: string, address: SerializedRuntimeAddress, generation: number, claimedAt: string): NameLeaseRecord =>
  ({ name, address, generation, claimedAt });

// ── The snapshot ───────────────────────────────────────────────────────────────────────────────
// Arrays come back sorted by their identity column, so the comparison is about CONTENT, not about
// two implementations happening to iterate in the same order. The whole snapshot is round-tripped
// through JSON so an absent field and a present-but-undefined one (which `structuredClone` in the
// reference preserves, and a column read cannot) compare as the same thing.
const byKey = <T>(pick: (v: T) => string) => (a: T, b: T) => pick(a).localeCompare(pick(b));
const leaseKey = (r: NameLeaseRecord) => `${r.name}|${r.address}|${r.claimedAt}`;

async function snapshot(store: RuntimeDirectoryStore) {
  const held: Record<string, HeldMessageRecord[]> = {};
  for (const r of RECEIVERS) held[r] = (await store.mailboxes.listHeld(r)).sort(byKey((h) => h.messageId));
  const deliveries: Record<string, DeliveryRecord | null> = {};
  for (const id of DELIVERY_IDS) deliveries[id] = (await store.deliveries.get(id)) ?? null;
  const leases: Record<string, NameLeaseRecord[]> = {};
  for (const n of NAMES) leases[n] = (await store.names.lookup(n)).sort(byKey(leaseKey));
  return {
    entries: (await store.load()).sort(byKey((e) => e.address)),
    cursors: await store.cursors.all(),
    receivers: (await store.mailboxes.receivers()).sort(),
    held,
    deliveries,
    claimedWithoutReceipt: (await store.deliveries.claimedWithoutReceipt()).sort(byKey((d) => d.messageId)),
    subscriptions: (await store.subscriptions.list()).sort(byKey((s) => s.messageId)),
    leases,
    heldLeases: (await store.names.held()).sort(byKey(leaseKey)),
  };
}

/**
 * The scripted scenario, run against any `RuntimeDirectoryStore`. Each entry records the step's own
 * return value AND the whole store's state after it, so a divergence is localised to one step
 * instead of showing up as "the end states differ".
 */
async function runScenario(store: RuntimeDirectoryStore): Promise<unknown[]> {
  const out: unknown[] = [];
  const run = async (step: string, fn: () => Promise<unknown>) => {
    const result = await fn();
    out.push({ step, result: result ?? null, state: await snapshot(store) });
  };

  await run("upsert A", () => store.upsert(ENTRY_A));
  await run("upsert B", () => store.upsert(ENTRY_B));
  await run("upsert A again (same address, new status)", () => store.upsert({ ...ENTRY_A, status: "idle", updatedAt: "2026-09-10T00:00:09.000Z" }));
  await run("remove A (present)", () => store.remove(ADDR_A));
  await run("remove C (never present)", () => store.remove(ADDR_C));
  await run("upsert A back", () => store.upsert(ENTRY_A));

  await run("cursor set A", () => store.cursors.set(ADDR_A, "cur-a-1"));
  await run("cursor set B", () => store.cursors.set(ADDR_B, "cur-b-1"));
  await run("cursor set A again", () => store.cursors.set(ADDR_A, "cur-a-2"));
  await run("cursor get A", () => store.cursors.get(ADDR_A));
  await run("cursor get C (absent)", () => store.cursors.get(ADDR_C));
  await run("cursor remove B", () => store.cursors.remove(ADDR_B));

  await run("hold m_1 for A", () => store.mailboxes.hold(heldRecord(ADDR_A, "m_1")));
  await run("hold m_2 for A", () => store.mailboxes.hold(heldRecord(ADDR_A, "m_2", { kind: "default", expiresAt: 1_757_462_700_000 })));
  await run("hold m_3 for B", () => store.mailboxes.hold(heldRecord(ADDR_B, "m_3")));
  await run("takeHeld m_1 from A", () => store.mailboxes.takeHeld(ADDR_A, "m_1"));
  await run("takeHeld m_1 from A again", () => store.mailboxes.takeHeld(ADDR_A, "m_1"));
  await run("takeHeld m_3 from A (wrong receiver)", () => store.mailboxes.takeHeld(ADDR_A, "m_3"));
  await run("receivers", () => store.mailboxes.receivers());
  await run("clear B", () => store.mailboxes.clear(ADDR_B));

  await run("put d_unclaimed", () => store.deliveries.put({ messageId: "d_unclaimed", message: message("d_unclaimed"), toGeneration: 1, updatedAt: "2020-01-01T00:00:00.000Z" }));
  await run("put d_claimed", () => store.deliveries.put({ messageId: "d_claimed", message: message("d_claimed"), toGeneration: 2, claimedBy: "winter-agent", updatedAt: "2020-01-01T00:00:00.000Z" }));
  await run("put d_receipted", () => store.deliveries.put({ messageId: "d_receipted", message: message("d_receipted"), toGeneration: 3, claimedBy: "claude-agent", outcome: { status: "delivered", messageId: "d_receipted" }, updatedAt: "2020-01-01T00:00:00.000Z" }));
  await run("get d_claimed", () => store.deliveries.get("d_claimed"));
  await run("get d_missing", () => store.deliveries.get("d_missing"));
  await run("claimedWithoutReceipt", () => store.deliveries.claimedWithoutReceipt());
  await run("prune deliveries", () => store.deliveries.prune("2026-01-01T00:00:00.000Z"));
  await run("prune deliveries again", () => store.deliveries.prune("2026-01-01T00:00:00.000Z"));

  await run("subscribe sub_1", () => store.subscriptions.add(subscription("sub_1", ADDR_B)));
  await run("subscribe sub_2", () => store.subscriptions.add(subscription("sub_2", ADDR_C)));
  await run("list subscriptions", () => store.subscriptions.list());
  await run("unsubscribe sub_1", () => store.subscriptions.remove("sub_1"));
  await run("unsubscribe sub_1 again", () => store.subscriptions.remove("sub_1"));

  await run("claim alpha for A", () => store.names.claim(lease("alpha", ADDR_A, 3, "2026-09-10T00:00:00.000Z")));
  await run("claim alpha for B", () => store.names.claim(lease("alpha", ADDR_B, 1, "2026-09-10T00:00:01.000Z")));
  await run("claim beta for C", () => store.names.claim(lease("beta", ADDR_C, 7, "2026-09-10T00:00:02.000Z")));
  await run("lookup alpha", () => store.names.lookup("alpha"));
  await run("lookup gamma (never claimed)", () => store.names.lookup("gamma"));
  await run("release alpha for A", () => store.names.release("alpha", ADDR_A, "2026-09-10T00:00:03.000Z"));
  await run("release alpha for A again", () => store.names.release("alpha", ADDR_A, "2026-09-10T00:00:04.000Z"));
  await run("held leases", () => store.names.held());
  await run("prune leases", () => store.names.prune("2026-09-10T00:00:05.000Z"));
  await run("prune leases again", () => store.names.prune("2026-09-10T00:00:05.000Z"));

  return JSON.parse(JSON.stringify(out));
}

describe("createSqliteRuntimeDirectoryStore — differential against the router's reference store", () => {
  test("the scripted scenario produces the same state, step by step, as createInMemoryRuntimeDirectoryStore", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const sqlite = await runScenario(createSqliteRuntimeDirectoryStore(rs));
        const reference = await runScenario(createInMemoryRuntimeDirectoryStore());
        expect(sqlite.length).toBe(reference.length);
        for (let i = 0; i < reference.length; i++) expect(sqlite[i]).toEqual(reference[i]);
      } finally { rs.close(); }
    });
  });
});

describe("createSqliteRuntimeDirectoryStore — the invariants the reference cannot have", () => {
  test("every sink survives close and reopen", async () => {
    await withTempHome(async (home) => {
      const first = openRuntimeStateDb(home);
      const a = createSqliteRuntimeDirectoryStore(first);
      await a.upsert(ENTRY_A);
      await a.cursors.set(ADDR_A, "cur-a-1");
      await a.mailboxes.hold(heldRecord(ADDR_A, "m_1"));
      await a.deliveries.put({ messageId: "d_claimed", message: message("d_claimed"), toGeneration: 2, claimedBy: "winter-agent", updatedAt: "2026-09-10T00:00:00.000Z" });
      await a.subscriptions.add(subscription("sub_1", ADDR_B));
      await a.names.claim(lease("alpha", ADDR_A, 3, "2026-09-10T00:00:00.000Z"));
      first.close();

      const second = openRuntimeStateDb(home);
      try {
        const b = createSqliteRuntimeDirectoryStore(second);
        expect(await b.load()).toEqual([ENTRY_A]);
        expect(await b.cursors.all()).toEqual({ [ADDR_A]: "cur-a-1" });
        expect(await b.mailboxes.listHeld(ADDR_A)).toEqual([heldRecord(ADDR_A, "m_1")]);
        expect((await b.deliveries.get("d_claimed"))?.claimedBy).toBe("winter-agent");
        expect(await b.subscriptions.list()).toEqual([subscription("sub_1", ADDR_B)]);
        expect(await b.names.held()).toEqual([lease("alpha", ADDR_A, 3, "2026-09-10T00:00:00.000Z")]);
      } finally { second.close(); }
    });
  });

  test("a claimed-but-unreceipted delivery is never pruned, at any age, and never counted", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const store = createSqliteRuntimeDirectoryStore(rs);
        const uncertain: DeliveryRecord = { messageId: "d_claimed", message: message("d_claimed"), toGeneration: 2, claimedBy: "winter-agent", updatedAt: "2020-01-01T00:00:00.000Z" };
        await store.deliveries.put(uncertain);
        await store.deliveries.put({ messageId: "d_receipted", message: message("d_receipted"), toGeneration: 1, claimedBy: "winter-agent", outcome: { status: "delivered", messageId: "d_receipted" }, updatedAt: "2020-01-01T00:00:00.000Z" });
        expect(await store.deliveries.prune("9999-01-01T00:00:00.000Z")).toBe(1);
        expect(await store.deliveries.get("d_claimed")).toEqual(uncertain);
        expect(await store.deliveries.claimedWithoutReceipt()).toEqual([uncertain]);
        expect(await store.deliveries.prune("9999-01-01T00:00:00.000Z")).toBe(0);
      } finally { rs.close(); }
    });
  });

  test("a held name lease is never pruned, at any age, and never counted", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const store = createSqliteRuntimeDirectoryStore(rs);
        const heldLease = lease("alpha", ADDR_A, 3, "2020-01-01T00:00:00.000Z");
        await store.names.claim(heldLease);
        await store.names.claim(lease("alpha", ADDR_B, 1, "2020-01-01T00:00:00.000Z"));
        await store.names.release("alpha", ADDR_B, "2020-01-02T00:00:00.000Z");
        expect(await store.names.prune("9999-01-01T00:00:00.000Z")).toBe(1);
        expect(await store.names.held()).toEqual([heldLease]);
        expect(await store.names.lookup("alpha")).toEqual([heldLease]);
        expect(await store.names.prune("9999-01-01T00:00:00.000Z")).toBe(0);
      } finally { rs.close(); }
    });
  });

  test("two concurrent takeHeld for the same message resolve to exactly one record", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const store = createSqliteRuntimeDirectoryStore(rs);
        await store.mailboxes.hold(heldRecord(ADDR_A, "m_1"));
        const [first, second] = await Promise.all([store.mailboxes.takeHeld(ADDR_A, "m_1"), store.mailboxes.takeHeld(ADDR_A, "m_1")]);
        const taken = [first, second].filter((r) => r !== undefined);
        expect(taken).toEqual([heldRecord(ADDR_A, "m_1")]);
        expect([first, second].filter((r) => r === undefined).length).toBe(1);
        expect(await store.mailboxes.listHeld(ADDR_A)).toEqual([]);
      } finally { rs.close(); }
    });
  });

  test("an entry round-trips verbatim, including fields this sink knows nothing about", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const store = createSqliteRuntimeDirectoryStore(rs);
        await store.upsert(ENTRY_A);
        const [loaded] = await store.load();
        expect(loaded).toEqual(ENTRY_A);
        expect(loaded?.processIdentity).toEqual({ pid: 4242, startedAt: "2026-09-09T23:59:00.000Z" });
        expect(loaded?.capabilities).toEqual({ message: true, resume: true, notifyWhenIdle: true, reply: true });
        expect(loaded?.selection).toEqual({ ...SELECTION });

        // The sink knows no schema: a field a NEWER router writes must survive a round trip through
        // an OLDER daemon untouched, or an upgrade silently truncates the directory.
        const future = { ...ENTRY_B, unknownFutureField: { nested: [1, "two", null] } } as unknown as RuntimeDirectoryEntry;
        await store.upsert(future);
        const back = (await store.load()).find((e) => e.address === ADDR_B);
        expect(back).toEqual(future);
      } finally { rs.close(); }
    });
  });

  test("a receipts row is appended per outcome TRANSITION, never per put", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const store = createSqliteRuntimeDirectoryStore(rs);
        const receipts = () => rs.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM global_message_receipts").get()?.n ?? 0;
        const base: DeliveryRecord = { messageId: "d_1", message: message("d_1"), toGeneration: 1, claimedBy: "winter-agent", updatedAt: "2026-09-10T00:00:00.000Z" };

        await store.deliveries.put(base);                                                            // claim, no outcome
        expect(receipts()).toBe(0);
        await store.deliveries.put({ ...base, outcome: { status: "delivered", messageId: "d_1" }, updatedAt: "2026-09-10T00:00:01.000Z" });   // first set
        expect(receipts()).toBe(1);
        await store.deliveries.put({ ...base, outcome: { status: "delivered", messageId: "d_1" }, updatedAt: "2026-09-10T00:00:02.000Z" });   // unchanged outcome
        expect(receipts()).toBe(1);
        await store.deliveries.put({ ...base, outcome: { status: "refused", messageId: "d_1", reason: "loop guard" }, updatedAt: "2026-09-10T00:00:03.000Z" }); // changed
        expect(receipts()).toBe(2);

        const rows = rs.db.query<{ outcome_json: string; receipted_at: string }, []>("SELECT outcome_json, receipted_at FROM global_message_receipts ORDER BY id").all();
        expect(rows.map((r) => JSON.parse(r.outcome_json).status)).toEqual(["delivered", "refused"]);
        expect(rows.map((r) => r.receipted_at)).toEqual(["2026-09-10T00:00:01.000Z", "2026-09-10T00:00:03.000Z"]);
      } finally { rs.close(); }
    });
  });
});
