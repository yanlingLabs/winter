import { expect, test } from "bun:test";
import { CoworkError } from "../../src/cowork/types";
import type { PeerAppendResult, PeerInboxCaps, PeerInboxEntry, PeerInboxRecord, PeerInboxStore } from "../../src/cowork/peer-inbox";

/*
 * Conformance cases every PeerInboxStore must pass: the in-memory store today, any durable store tomorrow
 * (`test("conformance: …", () => run(harness))` over each case, with a fresh harness per case).
 *
 * `open()` must return a store INSTANCE over the harness's one durable state. Calling it twice models a process
 * restart (a second `open()` must see everything the first one committed); holding two instances at once models
 * two live connections to one database, which must serialize their appends and compare-and-set updates.
 *
 * `failAppendAtStep` is REQUIRED: it arms the most recently opened instance so that its NEXT append throws at
 * its n-th internal write (a store with fewer writes simply succeeds). A SQLite store supplies it by throwing
 * inside its transaction body after the n-th statement. It proves failure atomicity (no torn record, no orphan
 * body, no sequence gap). `makeBodyUnreadable` makes ONE body fail to read, so `readBody` is shown to THROW for it
 * and to return `undefined` only for a handle that names no body. A hard crash mid-append is the store's own transaction property and needs its own
 * kill test; the durability class itself ("returns means committed", fsync-backed) is stated on
 * `PeerInboxStore` and cannot be shown by a unit case.
 */
export interface PeerInboxStoreHarness {
  open(): PeerInboxStore;
  failAppendAtStep(step: number): void;
  /** Makes the body behind `handle` unreadable to EVERY instance of this harness: the body store now raises an I/O or
   * permission error for that handle (as opposed to a handle that names no body). */
  makeBodyUnreadable(handle: string): void;
}
export interface PeerInboxConformanceCase { name: string; run(harness: PeerInboxStoreHarness): void }

const DIGEST = "d".repeat(64);
const WIDE: PeerInboxCaps = { maxUnresolvedPerRecipient: 1_000, maxUnresolvedPerSenderRecipient: 1_000, maxUnresolvedBytesPerRecipient: 64 * 1024 * 1024 };
const base = (n: number, over: Partial<PeerInboxEntry> = {}): Omit<PeerInboxEntry, "size"> => ({
  receiptId: `r${n}`, senderSessionId: "s_a", senderIncarnation: "inc-1", sendId: `m${n}`, recipientSessionId: "s_r", digest: DIGEST, acceptedAt: 1_000 + n, ...over,
});
/** Appends with a size that matches the body, as the ledger does. */
const put = (store: PeerInboxStore, n: number, body = `body-${n}`, over: Partial<PeerInboxEntry> = {}, caps: PeerInboxCaps = WIDE): PeerAppendResult =>
  store.append({ ...base(n, over), size: Buffer.byteLength(body, "utf8") }, body, caps);
function created(result: PeerAppendResult): PeerInboxRecord {
  if (result.status !== "created") throw new Error(`expected created, got ${JSON.stringify(result)}`);
  return result.record;
}
const identity = (n: number) => ({ senderSessionId: "s_a", senderIncarnation: "inc-1", sendId: `m${n}` });
const CLEAN = { unresolvedWithoutBody: [], terminalWithBody: [], orphanBodies: 0 };
function codeOf(operation: () => unknown): string | undefined {
  try { operation(); } catch (error) { return error instanceof CoworkError ? error.code : `non-cowork:${String(error)}`; }
  return undefined;
}

export function peerInboxStoreConformanceCases(): PeerInboxConformanceCase[] {
  return [
    { name: "append assigns a strictly increasing sequence per recipient and a readable body handle", run: ({ open }) => {
      const store = open();
      const a = created(put(store, 1, "one")), b = created(put(store, 2, "two")), other = created(put(store, 3, "three", { recipientSessionId: "s_q" }));
      expect([a.sequence, b.sequence, other.sequence]).toEqual([1, 2, 1]);
      expect([a.state, a.version, a.attempts, a.offered, a.deliveredUnder, a.discardedBy, a.reason]).toEqual(["accepted", 1, 0, null, null, null, null]);
      expect([a.updatedAt, a.acceptedAt]).toEqual([1_001, 1_001]); // a new record's updatedAt is its acceptedAt
      expect(store.readBody(a.bodyHandle!)).toBe("one");
      expect(store.readBody(b.bodyHandle!)).toBe("two");
      expect(a.bodyHandle).not.toBe(b.bodyHandle);
      expect(store.readBody("no-such-handle")).toBeUndefined();
    } },
    { name: "append of an existing send identity returns the existing record, stores nothing, and no cap applies to it", run: ({ open }) => {
      const store = open();
      const first = created(put(store, 1, "original"));
      const again = put(store, 2, "different", { sendId: "m1", digest: "e".repeat(64) }, { ...WIDE, maxUnresolvedPerRecipient: 1, maxUnresolvedPerSenderRecipient: 1, maxUnresolvedBytesPerRecipient: 1 });
      expect(again).toEqual({ status: "existing", record: first });
      expect(store.unresolved("s_r")).toHaveLength(1);
      expect(store.readBody(first.bodyHandle!)).toBe("original");
      // The duplicate neither consumed a sequence number nor left a record behind.
      expect(created(put(store, 3, "next")).sequence).toBe(2);
      expect(store.get("r2")).toBeUndefined();
    } },
    { name: "identity is (sender, sender incarnation, send id)", run: ({ open }) => {
      const store = open();
      put(store, 1, "x");
      expect(put(store, 2, "x", { sendId: "m1", senderIncarnation: "inc-2" }).status).toBe("created");
      expect(put(store, 3, "x", { sendId: "m1", senderSessionId: "s_b" }).status).toBe("created");
      expect(store.find(identity(1))?.receiptId).toBe("r1");
      expect(store.find({ ...identity(1), sendId: "nope" })).toBeUndefined();
    } },
    { name: "returned records are copies, never live handles", run: ({ open }) => {
      const store = open();
      const record = created(put(store, 1, "x")) as unknown as Record<string, unknown>;
      record.state = "delivered"; record.sequence = 99;
      (store.get("r1") as unknown as Record<string, unknown>).state = "refused";
      expect(store.get("r1")!.state).toBe("accepted");
      expect(store.get("r1")!.sequence).toBe(1);
      expect(store.unresolved("s_r")[0]!.state).toBe("accepted");
    } },
    { name: "a rejected append leaves no record, body or sequence gap", run: ({ open }) => {
      const store = open();
      expect(codeOf(() => put(store, 1, "x", { recipientSessionId: "" }))).toBe("invalid_request");
      expect(codeOf(() => store.append({ ...base(1), size: -1 }, "x", WIDE))).toBe("invalid_request");
      expect(codeOf(() => store.append({ ...base(1), size: 5 }, "x", WIDE))).toBe("invalid_request"); // size must equal the body's UTF-8 length
      expect(codeOf(() => put(store, 1, "lone \ud83d surrogate"))).toBe("invalid_request");
      expect(codeOf(() => put(store, 1, "x", {}, { ...WIDE, maxUnresolvedPerRecipient: 0 }))).toBe("invalid_request");
      expect(store.recipients()).toEqual([]);
      expect(store.find(identity(1))).toBeUndefined();
      expect(store.audit()).toEqual(CLEAN);
      expect(created(put(store, 1, "x")).sequence).toBe(1);
    } },
    { name: "update is compare-and-set on the version", run: ({ open }) => {
      const store = open();
      const record = created(put(store, 1, "x"));
      const moved = store.update("r1", 1, { state: "blocked", reason: "grants", updatedAt: 2_000 });
      expect([moved.state, moved.reason, moved.version, moved.updatedAt, moved.sequence]).toEqual(["blocked", "grants", 2, 2_000, record.sequence]);
      expect(codeOf(() => store.update("r1", 1, { state: "accepted", reason: null, updatedAt: 3_000 }))).toBe("revision_conflict");
      expect(store.get("r1")).toEqual(moved);
      expect(codeOf(() => store.update("missing", 1, { updatedAt: 1 }))).toBe("not_found");
    } },
    { name: "a non-terminal update keeps the body; a terminal one releases it atomically and is final", run: ({ open }) => {
      const store = open();
      const handle = created(put(store, 1, "secret-body")).bodyHandle!;
      store.update("r1", 1, { state: "blocked", reason: "resources", updatedAt: 2 });
      expect(store.readBody(handle)).toBe("secret-body");
      const done = store.update("r1", 2, { state: "refused", reason: "canceled", updatedAt: 3 });
      expect(done.bodyHandle).toBeNull();
      expect(store.readBody(handle)).toBeUndefined();
      expect(store.get("r1")!.bodyHandle).toBeNull();
      expect(codeOf(() => store.update("r1", 3, { state: "accepted", reason: null, updatedAt: 4 }))).toBe("invalid_request");
      expect(store.get("r1")!.state).toBe("refused");
      expect(store.audit()).toEqual(CLEAN);
    } },
    { name: "unresolved and terminal partition a recipient's records in sequence order", run: ({ open }) => {
      const store = open();
      for (const n of [1, 2, 3, 4]) put(store, n, `t${n}`);
      store.update("r2", 1, { state: "delivered", reason: null, updatedAt: 5 });
      store.update("r4", 1, { state: "blocked", reason: "recovery", updatedAt: 5 });
      store.update("r1", 1, { state: "refused", reason: "canceled", updatedAt: 5 });
      expect(store.unresolved("s_r").map(record => record.receiptId)).toEqual(["r3", "r4"]);
      expect(store.terminal("s_r").map(record => record.receiptId)).toEqual(["r1", "r2"]);
      expect(store.unresolved("s_other")).toEqual([]);
      expect(store.recipients()).toEqual(["s_r"]);
      // A recipient that only has terminal records is still listed: pruning walks recipients().
      put(store, 7, "done", { recipientSessionId: "s_t" });
      store.update("r7", 1, { state: "delivered", reason: null, updatedAt: 6 });
      expect(store.unresolved("s_t")).toEqual([]);
      expect(store.terminal("s_t").map(record => record.receiptId)).toEqual(["r7"]);
      expect([...store.recipients()].sort()).toEqual(["s_r", "s_t"]);
    } },
    { name: "remove deletes only terminal records", run: ({ open }) => {
      const store = open();
      const second = (put(store, 1, "x"), created(put(store, 2, "y")));
      expect(codeOf(() => store.remove("r2"))).toBe("invalid_request");
      expect(store.get("r2")).toBeDefined();
      expect(store.readBody(second.bodyHandle!)).toBe("y");
      store.update("r2", 1, { state: "delivered", reason: null, updatedAt: 3 });
      // A terminal record stays findable (it is the dedupe record) until it is removed, also across a reopen.
      for (const view of [store, open()]) {
        expect(view.get("r2")?.state).toBe("delivered");
        expect(view.find(identity(2))?.receiptId).toBe("r2");
      }
      store.remove("r2");
      expect(store.get("r2")).toBeUndefined();
      expect(store.find(identity(2))).toBeUndefined();
      expect(codeOf(() => store.remove("r2"))).toBe("not_found");
      // A removed identity can be accepted afresh.
      expect(put(store, 4, "again", { sendId: "m2" }).status).toBe("created");
      expect(store.audit()).toEqual(CLEAN);
    } },
    { name: "a sequence number is never reused: remove, reopen, append", run: ({ open }) => {
      const store = open();
      put(store, 1, "x"); const highest = created(put(store, 2, "y"));
      store.update("r2", 1, { state: "delivered", reason: null, updatedAt: 3 });
      store.remove("r2"); // the highest-sequence record is gone, and so is any trace of it in the records
      const restarted = open();
      expect(created(put(restarted, 3, "z")).sequence).toBeGreaterThan(highest.sequence);
      // Drain the recipient entirely, restart again: the counter still does not fall back.
      const third = restarted.get("r3")!;
      restarted.update("r3", 1, { state: "refused", reason: "canceled", updatedAt: 4 });
      restarted.update("r1", 1, { state: "refused", reason: "canceled", updatedAt: 4 });
      restarted.remove("r3"); restarted.remove("r1");
      expect(restarted.unresolved("s_r")).toEqual([]);
      expect(created(put(open(), 5, "w")).sequence).toBeGreaterThan(third.sequence);
    } },
    { name: "a second open() sees every committed record, body, identity and sequence counter", run: ({ open }) => {
      const first = open();
      const a = created(put(first, 1, "kept"));
      first.update("r1", 1, { state: "blocked", reason: "grants", attempts: 2, offered: { incarnationId: "boot-1", leaseEpoch: 3 }, updatedAt: 9 });
      const second = open();
      expect(second.get("r1")).toEqual(first.get("r1"));
      expect(second.get("r1")!.offered).toEqual({ incarnationId: "boot-1", leaseEpoch: 3 });
      expect(second.readBody(a.bodyHandle!)).toBe("kept");
      expect(put(second, 2, "dup", { sendId: "m1" }).status).toBe("existing");
      expect(created(put(second, 3, "next")).sequence).toBe(2);
      expect(open().unresolved("s_r").map(record => record.receiptId)).toEqual(["r1", "r3"]);
    } },
    { name: "the caps are decided inside append, in order, and a full append leaves no trace", run: ({ open }) => {
      const store = open();
      const caps: PeerInboxCaps = { maxUnresolvedPerRecipient: 4, maxUnresolvedPerSenderRecipient: 2, maxUnresolvedBytesPerRecipient: 40 };
      expect(put(store, 1, "aaaa", {}, caps).status).toBe("created");
      expect(put(store, 2, "aaaa", {}, caps).status).toBe("created");
      // sender_quota: a third from the same sender, even from its next incarnation, while another sender still fits.
      expect(put(store, 3, "aaaa", {}, caps)).toEqual({ status: "full", reason: "sender_quota" });
      expect(put(store, 4, "aaaa", { senderIncarnation: "inc-2" }, caps)).toEqual({ status: "full", reason: "sender_quota" });
      expect(put(store, 5, "aaaa", { senderSessionId: "s_b" }, caps).status).toBe("created");
      expect(put(store, 6, "aaaa", { senderSessionId: "s_c" }, caps).status).toBe("created");
      // inbox_full: four unresolved to this recipient; another recipient is unaffected.
      expect(put(store, 7, "aaaa", { senderSessionId: "s_d" }, caps)).toEqual({ status: "full", reason: "inbox_full" });
      expect(put(store, 8, "aaaa", { recipientSessionId: "s_q" }, caps).status).toBe("created");
      // inbox_bytes_full: the summed size, not the count, trips it.
      expect(put(store, 9, "x".repeat(37), { recipientSessionId: "s_q", senderSessionId: "s_b" }, caps)).toEqual({ status: "full", reason: "inbox_bytes_full" });
      expect(put(store, 10, "x".repeat(36), { recipientSessionId: "s_q", senderSessionId: "s_b" }, caps).status).toBe("created");
      // A full append consumed nothing: no record, no body, no sequence.
      for (const n of [3, 4, 7, 9]) expect(store.find({ ...identity(n), senderIncarnation: n === 4 ? "inc-2" : "inc-1", senderSessionId: n === 7 ? "s_d" : n === 9 ? "s_b" : "s_a" })).toBeUndefined();
      expect(store.audit()).toEqual(CLEAN);
      // Terminal records free their capacity (the body is gone); blocked ones keep holding it.
      store.update("r1", 1, { state: "blocked", reason: "grants", updatedAt: 5 });
      expect(put(store, 11, "aaaa", {}, caps)).toEqual({ status: "full", reason: "sender_quota" });
      store.update("r1", 2, { state: "refused", reason: "canceled", updatedAt: 6 });
      expect(created(put(store, 12, "aaaa", {}, caps)).sequence).toBe(5);
      // A blocked record still holds its bytes: the budget counts every unresolved record, not only the accepted ones.
      const small: PeerInboxCaps = { ...WIDE, maxUnresolvedBytesPerRecipient: 10 };
      put(store, 13, "aaaa", { recipientSessionId: "s_z" }, small);
      store.update("r13", 1, { state: "blocked", reason: "resources", updatedAt: 7 });
      expect(put(store, 14, "bbbbbbb", { recipientSessionId: "s_z" }, small)).toEqual({ status: "full", reason: "inbox_bytes_full" });
      expect(put(store, 15, "bbbbbb", { recipientSessionId: "s_z" }, small).status).toBe("created");
    } },
    { name: "bodies round-trip byte-exactly: multibyte text, NUL and 64 KiB, also after a reopen", run: ({ open }) => {
      const store = open();
      const bodies = ["héllo — 日本語 \u{1F600} ✓", "a\u0000b\u0000", "\u0000", "x".repeat(65_536), "é".repeat(32_768), "line1\r\nline2\n\ttabbed end"];
      const handles = bodies.map((body, index) => created(put(store, index + 1, body)).bodyHandle!);
      const restarted = open();
      bodies.forEach((body, index) => {
        expect(restarted.readBody(handles[index]!)).toBe(body);
        expect(restarted.get(`r${index + 1}`)!.size).toBe(Buffer.byteLength(body, "utf8"));
      });
      expect(restarted.audit()).toEqual(CLEAN);
    } },
    { name: "an append that fails part-way leaves nothing: no torn record, no orphan body, no sequence gap", run: ({ open, failAppendAtStep }) => {
      let failures = 0;
      for (let step = 1; step <= 64; step++) {
        const store = open();
        failAppendAtStep(step);
        let threw = false;
        try { put(store, step, `body-${step}`, { sendId: `f${step}`, receiptId: `rf${step}` }); } catch { threw = true; }
        if (!threw) {
          // The append has fewer than `step` writes: it succeeded, and the failed ones before it left no gap.
          expect(store.get(`rf${step}`)!.sequence).toBe(1);
          expect(store.audit()).toEqual(CLEAN);
          expect(failures).toBeGreaterThan(0);
          return;
        }
        failures++;
        // The instance that failed must itself be clean: a store that leaves its body file behind fails here even
        // though the sweep a durable store MUST run at open would clean it for the reopened instance below.
        expect(store.audit()).toEqual(CLEAN);
        const after = open();
        expect(after.get(`rf${step}`)).toBeUndefined();
        expect(after.find({ ...identity(1), sendId: `f${step}` })).toBeUndefined();
        expect(after.recipients()).toEqual([]);
        expect(after.unresolved("s_r")).toEqual([]);
        expect(after.audit()).toEqual(CLEAN);
      }
      throw new Error("append never succeeded within 64 writes");
    } },
    { name: "readBody throws for a body that cannot be read and returns undefined only for a handle that names no body", run: ({ open, makeBodyUnreadable }) => {
      const store = open();
      const bad = created(put(store, 1, "unreadable")), good = created(put(store, 2, "readable"));
      makeBodyUnreadable(bad.bodyHandle!);
      for (const view of [store, open()]) {
        expect(() => view.readBody(bad.bodyHandle!)).toThrow();
        expect(view.readBody(good.bodyHandle!)).toBe("readable");
        expect(view.readBody("no-such-handle")).toBeUndefined();
      }
    } },
    { name: "audit is clean across a whole lifecycle, and finds nothing torn after a failed append", run: ({ open }) => {
      const store = open();
      for (const n of [1, 2, 3]) put(store, n, `t${n}`);
      expect(store.audit()).toEqual(CLEAN);
      store.update("r1", 1, { state: "delivered", reason: null, updatedAt: 5 });
      store.update("r2", 1, { state: "refused", reason: "canceled", updatedAt: 5 });
      expect(store.audit()).toEqual(CLEAN);
      store.remove("r1");
      expect(store.audit()).toEqual(CLEAN);
      expect(open().audit()).toEqual(CLEAN);
    } },
    { name: "update changes only the patchable fields: an explicit null clears, an unspecified field is untouched, extra keys are ignored", run: ({ open }) => {
      const store = open();
      const first = created(put(store, 1, "x")), epoch = { incarnationId: "boot-1", leaseEpoch: 3 };
      const a = store.update("r1", 1, { state: "blocked", reason: "grants", attempts: 2, offered: epoch, deliveredUnder: epoch, discardedBy: "u1", updatedAt: 10 });
      expect([a.state, a.reason, a.attempts, a.offered, a.deliveredUnder, a.discardedBy, a.updatedAt]).toEqual(["blocked", "grants", 2, epoch, epoch, "u1", 10]);
      // Each explicit null clears exactly the field it names; everything not named is untouched.
      const b = store.update("r1", 2, { reason: null, updatedAt: 11 });
      expect([b.reason, b.state, b.attempts, b.offered, b.deliveredUnder, b.discardedBy]).toEqual([null, "blocked", 2, epoch, epoch, "u1"]);
      const c = store.update("r1", 3, { offered: null, updatedAt: 12 });
      expect([c.offered, c.deliveredUnder, c.discardedBy, c.reason, c.attempts]).toEqual([null, epoch, "u1", null, 2]);
      const d = store.update("r1", 4, { deliveredUnder: null, discardedBy: null, updatedAt: 13 });
      expect([d.deliveredUnder, d.discardedBy, d.attempts, d.state, d.offered]).toEqual([null, null, 2, "blocked", null]);
      expect(open().get("r1")).toEqual(d); // and the cleared state is what a reopen sees
      // Fields outside the patch are not writable, even if smuggled in.
      const e = store.update("r1", 5, { updatedAt: 14, sequence: 99, receiptId: "evil", recipientSessionId: "s_evil", digest: "f".repeat(64), size: 999, bodyHandle: "evil", version: 77 } as never);
      expect([e.sequence, e.receiptId, e.recipientSessionId, e.digest, e.size, e.bodyHandle, e.version]).toEqual([1, "r1", "s_r", DIGEST, 1, first.bodyHandle, 6]);
    } },
    { name: "attempts, offered, deliveredUnder and discardedBy survive a reopen, also on a terminal record", run: ({ open }) => {
      const store = open(), epoch = { incarnationId: "boot-9", leaseEpoch: 4 };
      put(store, 1, "x"); put(store, 2, "y");
      store.update("r1", 1, { state: "accepted", attempts: 3, offered: epoch, updatedAt: 5 });
      store.update("r1", 2, { state: "delivered", reason: null, offered: null, deliveredUnder: epoch, updatedAt: 6 });
      store.update("r2", 1, { state: "refused", reason: "discarded", discardedBy: "local-user", updatedAt: 7 });
      for (const view of [store, open()]) {
        expect(view.get("r1")).toMatchObject({ state: "delivered", attempts: 3, offered: null, deliveredUnder: epoch, bodyHandle: null });
        expect(view.get("r2")).toMatchObject({ state: "refused", reason: "discarded", discardedBy: "local-user", bodyHandle: null });
        expect(view.find(identity(1))?.deliveredUnder).toEqual(epoch);
      }
    } },
    { name: "two live instances interleave appends, identities, compare-and-set and caps over one state", run: ({ open }) => {
      const a = open(), b = open();
      // Appends from either instance get distinct, consecutive sequences and each sees the other's record.
      expect(created(put(a, 1, "from a")).sequence).toBe(1);
      expect(created(put(b, 2, "from b")).sequence).toBe(2);
      expect(created(put(a, 3, "from a again")).sequence).toBe(3);
      expect(b.unresolved("s_r").map(record => record.receiptId)).toEqual(["r1", "r2", "r3"]);
      // The same identity appended through the other instance is the existing record.
      expect(put(b, 4, "dup", { sendId: "m1" })).toEqual({ status: "existing", record: a.get("r1")! });
      // Compare-and-set: the loser of a race on one version gets revision_conflict and changes nothing.
      a.update("r2", 1, { state: "blocked", reason: "grants", updatedAt: 9 });
      expect(codeOf(() => b.update("r2", 1, { state: "blocked", reason: "resources", updatedAt: 10 }))).toBe("revision_conflict");
      expect(b.get("r2")!.reason).toBe("grants");
      b.update("r2", 2, { state: "accepted", reason: null, updatedAt: 11 });
      expect(a.get("r2")!.version).toBe(3);
      // A cap is a cross-instance fact: with room for one more, exactly one of two racing appends is created.
      const tight: PeerInboxCaps = { ...WIDE, maxUnresolvedPerRecipient: 4 };
      const first = put(a, 5, "x", { senderSessionId: "s_b" }, tight), second = put(b, 6, "x", { senderSessionId: "s_c" }, tight);
      expect([first.status, second.status]).toEqual(["created", "full"]);
      expect(a.audit()).toEqual(CLEAN);
    } },
  ];
}

/** Registers every conformance case for one store implementation: `runPeerInboxStoreConformance("sqlite", () => harness)`.
 * `makeHarness` is called once per case, so each case gets fresh durable state. */
export function runPeerInboxStoreConformance(label: string, makeHarness: () => PeerInboxStoreHarness): void {
  for (const conformance of peerInboxStoreConformanceCases()) test(`conformance (${label}): ${conformance.name}`, () => conformance.run(makeHarness()));
}
