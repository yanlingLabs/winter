import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { InMemoryPeerInboxStore, createPeerInboxMemoryState, type PeerInboxCaps, type PeerInboxMemoryState } from "../../src/cowork/peer-inbox";
import * as peerInboxModule from "../../src/cowork/peer-inbox";
import { runPeerInboxStoreConformance, type PeerInboxStoreHarness } from "./peer-inbox-conformance";
import { definePeerInboxLedgerTests } from "./peer-inbox-ledger-cases";

/*
 * The in-memory store is the only PeerInboxStore implementation. It runs BOTH suites any future durable store must
 * pass: the store conformance cases (the port contract) and the ledger behavior tests (the state machine over a
 * store). The tests below are specific to the in-memory class, plus the anti-wiring pin.
 */

// ---------------------------------------------------------------- the in-memory store under both suites

const unreadableHandles = new WeakMap<PeerInboxMemoryState, Set<string>>();
/** The in-memory store with a failure seam inside append, so the failure-atomicity cases are not vacuous, and a seam that
 * makes one body unreadable (the in-memory store has no real I/O to fail). */
class FaultyMemoryStore extends InMemoryPeerInboxStore {
  private failAt = 0; private writes = 0;
  private readonly unreadable: Set<string>;
  constructor(state: PeerInboxMemoryState) {
    super(state);
    this.unreadable = unreadableHandles.get(state) ?? new Set();
    unreadableHandles.set(state, this.unreadable);
  }
  arm(step: number) { this.failAt = step; this.writes = 0; }
  protected override beforeWrite() { if (this.failAt > 0 && ++this.writes === this.failAt) { this.failAt = 0; throw new Error("injected write failure"); } }
  override readBody(handle: string): string | undefined {
    if (this.unreadable.has(handle)) throw new Error("injected read failure");
    return super.readBody(handle);
  }
  markUnreadable(handle: string) { this.unreadable.add(handle); }
}
function memoryHarness(): PeerInboxStoreHarness {
  const root = new FaultyMemoryStore(createPeerInboxMemoryState());
  let last: FaultyMemoryStore = root;
  return { open: () => (last = root.reopen()), failAppendAtStep: step => last.arm(step), makeBodyUnreadable: handle => last.markUnreadable(handle) };
}
definePeerInboxLedgerTests("ledger over the in-memory store", memoryHarness);
runPeerInboxStoreConformance("in-memory", memoryHarness);

// ---------------------------------------------------------------- in-memory only

test("the in-memory audit sees a torn record, a leaked body and an orphan body", () => {
  const state = createPeerInboxMemoryState(), store = new InMemoryPeerInboxStore(state);
  const clean = { unresolvedWithoutBody: [], terminalWithBody: [], orphanBodies: 0 };
  const caps: PeerInboxCaps = { maxUnresolvedPerRecipient: 10, maxUnresolvedPerSenderRecipient: 10, maxUnresolvedBytesPerRecipient: 1_000 };
  const entry = (n: number) => ({ receiptId: `r${n}`, senderSessionId: "s_a", senderIncarnation: "inc-1", sendId: `m${n}`, recipientSessionId: "s_r", digest: "d".repeat(64), size: 3, acceptedAt: n });
  expect(store.audit()).toEqual(clean);
  state.bodies.set("body_orphan", "left behind"); // an orphan body
  expect(store.audit()).toEqual({ ...clean, orphanBodies: 1 });
  const first = store.append(entry(1), "one", caps), second = store.append(entry(2), "two", caps);
  if (first.status !== "created" || second.status !== "created") throw new Error("expected created");
  state.bodies.delete(first.record.bodyHandle!); // a torn record: unresolved with no body
  state.records.set(second.record.receiptId, { ...second.record, state: "delivered" }); // a leaked body: terminal that still holds its handle
  expect(store.audit()).toEqual({ unresolvedWithoutBody: ["r1"], terminalWithBody: ["r2"], orphanBodies: 1 });
});

// ---------------------------------------------------------------- anti-wiring

const sourceDirectory = (...parts: string[]) => join(import.meta.dir, "..", "..", "..", ...parts);
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)).map(entry => join(entry.parentPath, entry.name));
}
test("anti-wiring: no src file imports the ledger, it has no barrel export, no transport, and the in-memory store is the only implementation inside it", () => {
  const packages = sourceDirectory(), module = join(packages, "core", "src", "cowork", "peer-inbox.ts");
  expect(existsSync(module)).toBe(true);
  const sources = readdirSync(packages, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(packages, entry.name, "src"))).flatMap(entry => sourceFiles(join(packages, entry.name, "src")));
  expect(sources.length).toBeGreaterThan(100); expect(sources).toContain(module);
  // The SQLite store is the one other module allowed to name the ledger's types; nothing else may, and nothing may name the store.
  const sqliteStore = join(packages, "core", "src", "cowork", "peer-inbox-sqlite.ts");
  expect(sources).toContain(sqliteStore);
  for (const file of sources.filter(candidate => candidate !== module)) {
    const text = readFileSync(file, "utf8");
    // Whole identifiers: schema.ts and db.ts legitimately name the table and its migration (migrateCoworkPeerInboxSchema).
    const ledgerNames = ["CoworkPeerInbox", "PeerInboxStore", "InMemoryPeerInboxStore", "PeerInboxRecord", "peerSendDigest", "PEER_INBOX_LIMITS", "isTerminalPeerState", "createPeerInboxMemoryState", "PeerInboxCaps", "PeerInboxAudit"];
    const needles = file === sqliteStore ? ["CoworkPeerInbox", "InMemoryPeerInboxStore", "peerSendDigest", "PEER_INBOX_LIMITS", "createPeerInboxMemoryState"]
      : ["peer-inbox", "peer-inbox-sqlite", "SqlitePeerInboxStore", ...ledgerNames];
    for (const needle of needles) {
      const found = new RegExp(`(?<![\\w-])${needle}(?![\\w-])`).test(text);
      expect(`${basename(file)}:${needle}:${found}`).toBe(`${basename(file)}:${needle}:false`);
    }
    if (file !== sqliteStore) expect(text).not.toMatch(/implements\s+PeerInboxStore/);
  }
  const sqliteSource = readFileSync(sqliteStore, "utf8");
  expect([...sqliteSource.matchAll(/implements\s+PeerInboxStore/g)]).toHaveLength(1);
  expect([...sqliteSource.matchAll(/from "([^"]+)"/g)].map(match => match[1]!).sort()).toEqual(["../runtime-state/db", "./durable-transaction", "./peer-inbox", "./peer-inbox", "./types"]);
  expect(existsSync(join(packages, "core", "src", "cowork", "index.ts"))).toBe(false);
  expect(readFileSync(join(packages, "core", "src", "index.ts"), "utf8")).not.toMatch(/peer-inbox|from "\.\/cowork/);
  const own = readFileSync(module, "utf8");
  expect([...own.matchAll(/implements\s+PeerInboxStore/g)]).toHaveLength(1);
  expect(own).toContain("class InMemoryPeerInboxStore implements PeerInboxStore");
  // Only these three imports: the authority predicate, the shared types/errors and node:crypto. No repository, session table, driver, SDK or SQLite.
  expect([...own.matchAll(/from "([^"]+)"/g)].map(match => match[1]!).sort()).toEqual(["./messaging-authority", "./types", "node:crypto"]);
  const code = own.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, ""); // comments may name what the module is NOT
  for (const forbidden of ["bun:sqlite", "CREATE TABLE", "cowork_peer", "session-messaging", "SessionMessaging", "@yanlinglabs", "daemon", "ensure(", "wake(", "resume("]) expect(`${forbidden}:${code.includes(forbidden)}`).toBe(`${forbidden}:false`);
  expect(Object.keys(peerInboxModule).sort()).toEqual(["CoworkPeerInbox", "InMemoryPeerInboxStore", "PEER_INBOX_LIMITS", "createPeerInboxMemoryState", "isTerminalPeerState", "peerSendDigest"]);
  // The schema may name the table; the ledger module itself never does (the SQLite store is a separate module).
  expect(own).not.toMatch(/cowork_peer_inbox/);
});
