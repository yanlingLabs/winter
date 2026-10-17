import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { InMemoryPeerInboxStore, createPeerInboxMemoryState, type PeerInboxCaps } from "../../src/cowork/peer-inbox";
import * as peerInboxModule from "../../src/cowork/peer-inbox";
import { runPeerInboxStoreConformance, type PeerInboxStoreHarness } from "./peer-inbox-conformance";
import { definePeerInboxLedgerTests } from "./peer-inbox-ledger-cases";

/*
 * The in-memory store is the only PeerInboxStore implementation. It runs BOTH suites any future durable store must
 * pass: the store conformance cases (the port contract) and the ledger behavior tests (the state machine over a
 * store). The tests below are specific to the in-memory class, plus the anti-wiring pin.
 */

// ---------------------------------------------------------------- the in-memory store under both suites

/** The in-memory store with a failure seam inside append, so the failure-atomicity cases are not vacuous. */
class FaultyMemoryStore extends InMemoryPeerInboxStore {
  private failAt = 0; private writes = 0;
  arm(step: number) { this.failAt = step; this.writes = 0; }
  protected override beforeWrite() { if (this.failAt > 0 && ++this.writes === this.failAt) { this.failAt = 0; throw new Error("injected write failure"); } }
}
function memoryHarness(): PeerInboxStoreHarness {
  const root = new FaultyMemoryStore(createPeerInboxMemoryState());
  let last: FaultyMemoryStore = root;
  return { open: () => (last = root.reopen()), failAppendAtStep: step => last.arm(step) };
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
test("anti-wiring: no src file imports the ledger, it has no barrel export, no SQLite table, no transport, and the in-memory store is its only implementation", () => {
  const packages = sourceDirectory(), module = join(packages, "core", "src", "cowork", "peer-inbox.ts");
  expect(existsSync(module)).toBe(true);
  const sources = readdirSync(packages, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(packages, entry.name, "src"))).flatMap(entry => sourceFiles(join(packages, entry.name, "src")));
  expect(sources.length).toBeGreaterThan(100); expect(sources).toContain(module);
  for (const file of sources.filter(candidate => candidate !== module)) {
    const text = readFileSync(file, "utf8");
    for (const needle of ["peer-inbox", "CoworkPeerInbox", "PeerInboxStore", "InMemoryPeerInboxStore", "PeerInboxRecord", "peerSendDigest", "PEER_INBOX_LIMITS", "isTerminalPeerState", "createPeerInboxMemoryState", "PeerInboxCaps", "PeerInboxAudit"])
      expect(`${basename(file)}:${needle}:${text.includes(needle)}`).toBe(`${basename(file)}:${needle}:false`);
    expect(text).not.toMatch(/implements\s+PeerInboxStore/);
  }
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
  // No table: the schema and the runtime-state DB do not mention the inbox at all.
  for (const file of [join(packages, "core", "src", "cowork", "schema.ts"), join(packages, "core", "src", "runtime-state", "db.ts")])
    expect(readFileSync(file, "utf8")).not.toMatch(/peer_inbox|peer-inbox|cowork_peer|PeerInbox/i);
});
