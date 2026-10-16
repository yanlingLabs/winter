import { expect } from "bun:test";
import { CoworkError } from "../../src/cowork/types";
import type { PeerInboxEntry, PeerInboxStore } from "../../src/cowork/peer-inbox";

/*
 * Conformance cases every PeerInboxStore must pass: the in-memory store today, any durable store tomorrow
 * (`test("conformance: …", () => run(harness))` over each case, with a fresh harness per case).
 *
 * `open()` must return a store INSTANCE over the harness's one durable state, so calling it twice models a
 * process restart: a second `open()` must see everything the first one committed.
 */
export interface PeerInboxStoreHarness { open(): PeerInboxStore }
export interface PeerInboxConformanceCase { name: string; run(harness: PeerInboxStoreHarness): void }

const DIGEST = "d".repeat(64);
const entry = (n: number, over: Partial<PeerInboxEntry> = {}): PeerInboxEntry => ({
  receiptId: `r${n}`, senderSessionId: "s_a", senderIncarnation: "inc-1", sendId: `m${n}`, recipientSessionId: "s_r", digest: DIGEST, size: 4, acceptedAt: 1_000 + n, ...over,
});
function codeOf(operation: () => unknown): string | undefined {
  try { operation(); } catch (error) { return error instanceof CoworkError ? error.code : `non-cowork:${String(error)}`; }
  return undefined;
}

export function peerInboxStoreConformanceCases(): PeerInboxConformanceCase[] {
  return [
    { name: "append assigns a strictly increasing sequence per recipient and a readable body handle", run: ({ open }) => {
      const store = open();
      const a = store.append(entry(1), "one"), b = store.append(entry(2), "two"), other = store.append(entry(3, { recipientSessionId: "s_q" }), "three");
      expect(a.created).toBe(true);
      expect([a.record.sequence, b.record.sequence, other.record.sequence]).toEqual([1, 2, 1]);
      expect([a.record.state, a.record.version, a.record.attempts, a.record.offered, a.record.deliveredUnder]).toEqual(["accepted", 1, 0, null, null]);
      expect(store.readBody(a.record.bodyHandle!)).toBe("one");
      expect(store.readBody(b.record.bodyHandle!)).toBe("two");
      expect(a.record.bodyHandle).not.toBe(b.record.bodyHandle);
      expect(store.readBody("no-such-handle")).toBeUndefined();
    } },
    { name: "append of an existing send identity returns the existing record and stores nothing", run: ({ open }) => {
      const store = open();
      const first = store.append(entry(1), "original");
      const again = store.append(entry(2, { sendId: "m1", digest: "e".repeat(64) }), "different");
      expect(again.created).toBe(false);
      expect(again.record).toEqual(first.record);
      expect(store.unresolved("s_r")).toHaveLength(1);
      expect(store.readBody(first.record.bodyHandle!)).toBe("original");
      // The rejected duplicate neither consumed a sequence number nor left a record behind.
      expect(store.append(entry(3), "next").record.sequence).toBe(2);
      expect(store.get("r2")).toBeUndefined();
    } },
    { name: "identity is (sender, sender incarnation, send id)", run: ({ open }) => {
      const store = open();
      store.append(entry(1), "x");
      expect(store.append(entry(2, { sendId: "m1", senderIncarnation: "inc-2" }), "x").created).toBe(true);
      expect(store.append(entry(3, { sendId: "m1", senderSessionId: "s_b" }), "x").created).toBe(true);
      expect(store.find({ senderSessionId: "s_a", senderIncarnation: "inc-1", sendId: "m1" })?.receiptId).toBe("r1");
      expect(store.find({ senderSessionId: "s_a", senderIncarnation: "inc-1", sendId: "nope" })).toBeUndefined();
    } },
    { name: "returned records are copies, never live handles", run: ({ open }) => {
      const store = open();
      const created = store.append(entry(1), "x").record as unknown as Record<string, unknown>;
      created.state = "delivered"; created.sequence = 99;
      (store.get("r1") as unknown as Record<string, unknown>).state = "refused";
      expect(store.get("r1")!.state).toBe("accepted");
      expect(store.get("r1")!.sequence).toBe(1);
      expect(store.unresolved("s_r")[0]!.state).toBe("accepted");
    } },
    { name: "a rejected append leaves no record, body or sequence gap", run: ({ open }) => {
      const store = open();
      expect(codeOf(() => store.append(entry(1, { recipientSessionId: "" }), "x"))).toBe("invalid_request");
      expect(codeOf(() => store.append(entry(1, { size: -1 }), "x"))).toBe("invalid_request");
      expect(store.recipients()).toEqual([]);
      expect(store.find({ senderSessionId: "s_a", senderIncarnation: "inc-1", sendId: "m1" })).toBeUndefined();
      expect(store.append(entry(1), "x").record.sequence).toBe(1);
    } },
    { name: "update is compare-and-set on the version", run: ({ open }) => {
      const store = open();
      const record = store.append(entry(1), "x").record;
      const moved = store.update("r1", 1, { state: "blocked", reason: "grants", updatedAt: 2_000 });
      expect([moved.state, moved.reason, moved.version, moved.updatedAt, moved.sequence]).toEqual(["blocked", "grants", 2, 2_000, record.sequence]);
      expect(codeOf(() => store.update("r1", 1, { state: "accepted", reason: null, updatedAt: 3_000 }))).toBe("revision_conflict");
      expect(store.get("r1")).toEqual(moved);
      expect(codeOf(() => store.update("missing", 1, { updatedAt: 1 }))).toBe("not_found");
    } },
    { name: "a non-terminal update keeps the body; a terminal one releases it atomically and is final", run: ({ open }) => {
      const store = open();
      const record = store.append(entry(1), "secret-body").record, handle = record.bodyHandle!;
      store.update("r1", 1, { state: "blocked", reason: "resources", updatedAt: 2 });
      expect(store.readBody(handle)).toBe("secret-body");
      const done = store.update("r1", 2, { state: "refused", reason: "canceled", updatedAt: 3 });
      expect(done.bodyHandle).toBeNull();
      expect(store.readBody(handle)).toBeUndefined();
      expect(store.get("r1")!.bodyHandle).toBeNull();
      expect(codeOf(() => store.update("r1", 3, { state: "accepted", reason: null, updatedAt: 4 }))).toBe("invalid_request");
      expect(store.get("r1")!.state).toBe("refused");
    } },
    { name: "unresolved and terminal partition a recipient's records in sequence order", run: ({ open }) => {
      const store = open();
      for (const n of [1, 2, 3, 4]) store.append(entry(n), `t${n}`);
      store.update("r2", 1, { state: "delivered", reason: null, updatedAt: 5 });
      store.update("r4", 1, { state: "blocked", reason: "recovery", updatedAt: 5 });
      store.update("r1", 1, { state: "refused", reason: "canceled", updatedAt: 5 });
      expect(store.unresolved("s_r").map(record => record.receiptId)).toEqual(["r3", "r4"]);
      expect(store.terminal("s_r").map(record => record.receiptId)).toEqual(["r1", "r2"]);
      expect(store.unresolved("s_other")).toEqual([]);
      expect(store.recipients()).toEqual(["s_r"]);
    } },
    { name: "remove deletes only terminal records and never reuses a sequence number", run: ({ open }) => {
      const store = open();
      const first = store.append(entry(1), "x").record, second = store.append(entry(2), "y").record;
      expect(codeOf(() => store.remove("r2"))).toBe("invalid_request");
      expect(store.get("r2")).toBeDefined();
      expect(store.readBody(second.bodyHandle!)).toBe("y");
      store.update("r2", 1, { state: "delivered", reason: null, updatedAt: 3 });
      store.remove("r2");
      expect(store.get("r2")).toBeUndefined();
      expect(store.find({ senderSessionId: "s_a", senderIncarnation: "inc-1", sendId: "m2" })).toBeUndefined();
      expect(codeOf(() => store.remove("r2"))).toBe("not_found");
      // The removed record held the highest sequence; the next append must still go beyond it.
      expect(store.append(entry(3), "z").record.sequence).toBeGreaterThan(second.sequence);
      expect(first.sequence).toBe(1);
      // A removed identity can be accepted afresh.
      expect(store.append(entry(4, { sendId: "m2" }), "again").created).toBe(true);
    } },
    { name: "a second open() sees every committed record, body, identity and sequence counter", run: ({ open }) => {
      const first = open();
      const a = first.append(entry(1), "kept").record;
      first.update("r1", 1, { state: "blocked", reason: "grants", attempts: 2, offered: { incarnationId: "boot-1", leaseEpoch: 3 }, updatedAt: 9 });
      const second = open();
      expect(second.get("r1")).toEqual(first.get("r1"));
      expect(second.get("r1")!.offered).toEqual({ incarnationId: "boot-1", leaseEpoch: 3 });
      expect(second.readBody(a.bodyHandle!)).toBe("kept");
      expect(second.append(entry(2, { sendId: "m1" }), "dup").created).toBe(false);
      expect(second.append(entry(3), "next").record.sequence).toBe(2);
      expect(open().unresolved("s_r").map(record => record.receiptId)).toEqual(["r1", "r3"]);
    } },
  ];
}
