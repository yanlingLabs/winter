import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SqlitePeerInboxStore } from "../../src/cowork/peer-inbox-sqlite";
import type { PeerInboxCaps, PeerInboxEntry } from "../../src/cowork/peer-inbox";
import { CoworkRepository } from "../../src/cowork/repository";
import { COWORK_BACKUP_EXCLUDED_TABLES, COWORK_TABLES } from "../../src/cowork/schema";
import { inspectCoworkSource } from "../../src/migration/cowork-exclusion";
import { downgradeCoworkRuntimeStateToV7, downgradeRuntimeStateToV6, openRuntimeStateDb, RUNTIME_STATE_SCHEMA_VERSION, type RuntimeStateDb } from "../../src/runtime-state/db";
import { runPeerInboxStoreConformance, type PeerInboxStoreHarness } from "./peer-inbox-conformance";
import { definePeerInboxLedgerTests } from "./peer-inbox-ledger-cases";

/*
 * The SQLite store under the store-generic conformance suite and the ledger behavior tests, plus what is specific to
 * a durable store: the open-time sweep, a real kill -9, backup and export exclusion, the schema-17 migration and
 * downgrade, the workspace purge, and body non-disclosure. Every literal is synthetic.
 */

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) { try { fn(); } catch { /* best effort */ } } });

/** The SQLite store with the two test seams: a failure after the n-th statement of an append, and one unreadable body. */
class FaultySqliteStore extends SqlitePeerInboxStore {
  private failAt = 0; private statements = 0;
  constructor(rs: RuntimeStateDb, private readonly unreadable: Set<string>) { super(rs); }
  arm(step: number) { this.failAt = step; this.statements = 0; }
  protected override step() { if (this.failAt > 0 && ++this.statements === this.failAt) { this.failAt = 0; throw new Error("injected write failure"); } }
  protected override beforeBodyRead(handle: string) { if (this.unreadable.has(handle)) throw new Error("injected read failure"); }
}
function tempHome(prefix = "winter-peer-inbox-sqlite-"): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
}
function sqliteHarness(): PeerInboxStoreHarness {
  const home = tempHome(), unreadable = new Set<string>();
  let last: FaultySqliteStore | undefined;
  return {
    open: () => {
      const db = openRuntimeStateDb(home);
      cleanup.push(() => { try { db.close(); } catch { /* already closed */ } });
      return (last = new FaultySqliteStore(db, unreadable));
    },
    failAppendAtStep: step => last!.arm(step),
    makeBodyUnreadable: handle => { unreadable.add(handle); },
  };
}

definePeerInboxLedgerTests("ledger over the SQLite store", sqliteHarness);
runPeerInboxStoreConformance("sqlite", sqliteHarness);

// ---------------------------------------------------------------- helpers for the durable-store cases

const DIGEST = "d".repeat(64);
const WIDE: PeerInboxCaps = { maxUnresolvedPerRecipient: 1_000, maxUnresolvedPerSenderRecipient: 1_000, maxUnresolvedBytesPerRecipient: 64 * 1024 * 1024 };
const MARKER = "PEER-BODY-MARKER-7f3a";
const entry = (n: number, over: Partial<PeerInboxEntry> = {}): Omit<PeerInboxEntry, "size"> => ({ receiptId: `r${n}`, senderSessionId: "s_a", senderIncarnation: "inc-1", sendId: `m${n}`, recipientSessionId: "s_r", digest: DIGEST, acceptedAt: 1_000 + n, ...over });
const put = (store: SqlitePeerInboxStore, n: number, body = `${MARKER}-${n}`, over: Partial<PeerInboxEntry> = {}) => store.append({ ...entry(n, over), size: Buffer.byteLength(body) }, body, WIDE);
function opened(home = tempHome()) {
  const rs = openRuntimeStateDb(home);
  cleanup.push(() => { try { rs.close(); } catch { /* already closed */ } });
  return { home, rs, store: new SqlitePeerInboxStore(rs) };
}
const rawRows = (rs: RuntimeStateDb, sql: string) => rs.db.query(sql).all();
const codeOf = (operation: () => unknown): string | undefined => { try { operation(); } catch (error) { return (error as { code?: string }).code ?? `other:${(error as Error).name}`; } return undefined; };

// ---------------------------------------------------------------- the schema-17 migration

test("schema 17: the version, the tables, the Cowork table list and the closed column set", () => {
  const { rs } = opened();
  expect(RUNTIME_STATE_SCHEMA_VERSION).toBe(17);
  expect(rs.schemaVersion()).toBe(17);
  expect(COWORK_TABLES).toContain("cowork_peer_inbox"); expect(COWORK_TABLES).toContain("cowork_peer_inbox_sequences");
  expect([...COWORK_BACKUP_EXCLUDED_TABLES].sort()).toEqual(["cowork_peer_inbox", "cowork_peer_inbox_sequences"]);
  for (const table of COWORK_TABLES) expect(rs.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)).not.toBeNull();
  const columns = rs.db.query<{ name: string }, []>("PRAGMA table_info(cowork_peer_inbox)").all().map(row => row.name).sort();
  expect(columns).toEqual(["accepted_at", "attempts", "body", "delivered_incarnation", "delivered_lease_epoch", "digest", "discarded_by", "offered_incarnation", "offered_lease_epoch", "receipt_id", "reason", "recipient_session_id", "send_id", "sender_incarnation", "sender_session_id", "sequence", "size", "state", "updated_at", "version"].sort());
});

test("the migration is idempotent: rewinding user_version to 16 and reopening keeps the rows and the table", () => {
  const { home, rs, store } = opened();
  put(store, 1);
  rs.db.run("PRAGMA user_version=16"); rs.close();
  const again = openRuntimeStateDb(home); cleanup.push(() => again.close());
  expect(again.schemaVersion()).toBe(17);
  expect(rawRows(again, "SELECT receipt_id FROM cowork_peer_inbox")).toEqual([{ receipt_id: "r1" }]);
  expect(again.integrity().ok).toBe(true);
});

test("a v16 store (no inbox tables) upgrades to 17 in place and the store works", () => {
  const home = tempHome();
  const first = openRuntimeStateDb(home);
  first.db.run("DROP TABLE cowork_peer_inbox"); first.db.run("DROP TABLE cowork_peer_inbox_sequences"); first.db.run("PRAGMA user_version=16"); first.close();
  const second = openRuntimeStateDb(home); cleanup.push(() => second.close());
  expect(second.schemaVersion()).toBe(17);
  expect(put(new SqlitePeerInboxStore(second), 1).status).toBe("created");
});

function userVersion(home: string): number {
  const raw = new Database(join(home, "runtimes", "runtime-state.db"), { readonly: true });
  try { return raw.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version; } finally { raw.close(); }
}
function tablesOf(home: string): string[] {
  const raw = new Database(join(home, "runtimes", "runtime-state.db"), { readonly: true });
  try { return raw.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name); } finally { raw.close(); }
}

test("downgrade from 17 drops the inbox tables cleanly when empty (counters alone do not block it), then upgrades again", () => {
  const home = tempHome();
  const { rs, store } = opened(home);
  put(store, 1, "x"); store.update("r1", 1, { state: "delivered", reason: null, updatedAt: 5 }); store.remove("r1"); // empty inbox, one surviving counter
  expect(rawRows(rs, "SELECT * FROM cowork_peer_inbox_sequences")).toHaveLength(1);
  rs.close();
  expect(userVersion(home)).toBe(17);
  expect(downgradeCoworkRuntimeStateToV7(home)).toEqual({ from: 17, to: 7 });
  expect(userVersion(home)).toBe(7);
  expect(tablesOf(home).filter(name => name.startsWith("cowork_"))).toEqual([]);
  const again = openRuntimeStateDb(home); expect(again.schemaVersion()).toBe(17); expect(again.integrity().ok).toBe(true);
  expect(rawRows(again, "SELECT * FROM cowork_peer_inbox")).toEqual([]); again.close();
  expect(downgradeRuntimeStateToV6(home)).toEqual({ from: 17, to: 6 });
  expect(tablesOf(home).filter(name => name.startsWith("cowork_peer"))).toEqual([]);
  const last = openRuntimeStateDb(home); expect(last.schemaVersion()).toBe(17); last.close();
});

test("an owed or retained inbox row is Cowork authority: both downgrades refuse and the row survives", () => {
  for (const finish of [false, true]) {
    const home = tempHome();
    const { rs, store } = opened(home);
    put(store, 1, `${MARKER}-owed`);
    if (finish) store.update("r1", 1, { state: "delivered", reason: null, updatedAt: 5 }); // a terminal dedupe record is retained too
    rs.close();
    expect(() => downgradeCoworkRuntimeStateToV7(home)).toThrow("Cowork authority");
    expect(() => downgradeRuntimeStateToV6(home)).toThrow("Cowork authority");
    expect(userVersion(home)).toBe(17);
    const raw = new Database(join(home, "runtimes", "runtime-state.db"), { readonly: true });
    try { expect(raw.query("SELECT count(*) AS n FROM cowork_peer_inbox").get()).toEqual({ n: 1 }); } finally { raw.close(); }
  }
});

test("a schema newer than 17 is refused by the downgrade ladder", () => {
  const home = tempHome();
  const { rs } = opened(home); rs.db.run("PRAGMA user_version=18"); rs.close();
  expect(() => downgradeCoworkRuntimeStateToV7(home)).toThrow("newer-schema");
  expect(() => downgradeRuntimeStateToV6(home)).toThrow("newer-schema");
});

// ---------------------------------------------------------------- lifecycle: the body lives only while owed

test("the body is released by every terminal move, in the same statement; a non-terminal move keeps it", () => {
  const { rs, store } = opened();
  const length = (n: number) => rs.db.query<{ n: number }, [string]>("SELECT length(body) AS n FROM cowork_peer_inbox WHERE receipt_id=?").get(`r${n}`)!.n;
  for (const n of [1, 2, 3, 4]) put(store, n, `${MARKER}-${n}`);
  store.update("r1", 1, { state: "blocked", reason: "grants", updatedAt: 2 });
  expect(length(1)).toBe(Buffer.byteLength(`${MARKER}-1`));
  store.update("r1", 2, { state: "accepted", reason: null, updatedAt: 3 });
  expect(length(1)).toBeGreaterThan(0);
  store.update("r1", 3, { state: "delivered", reason: null, updatedAt: 4 }); // delivery
  store.update("r2", 1, { state: "refused", reason: "canceled", updatedAt: 4 });
  store.update("r3", 1, { state: "refused", reason: "sender_gone", updatedAt: 4 });
  store.update("r4", 1, { state: "refused", reason: "discarded", discardedBy: "u1", updatedAt: 4 });
  for (const n of [1, 2, 3, 4]) expect(rs.db.query("SELECT body FROM cowork_peer_inbox WHERE receipt_id=?").get(`r${n}`)).toEqual({ body: null });
  for (const n of [1, 2, 3, 4]) expect(store.readBody(`pib_r${n}`)).toBeUndefined();
});

test("the table itself forbids a terminal row that holds a body, and a row whose size is not its body length", () => {
  const { rs, store } = opened();
  put(store, 1, "abc");
  expect(() => rs.db.run("UPDATE cowork_peer_inbox SET state='delivered' WHERE receipt_id='r1'")).toThrow();
  expect(() => rs.db.run("UPDATE cowork_peer_inbox SET size=99 WHERE receipt_id='r1'")).toThrow();
  expect(store.get("r1")!.state).toBe("accepted");
});

test("no body reaches a record, a view, an error or the result of any record query", () => {
  const { store } = opened();
  const secret = `${MARKER}-secret-é-日本`;
  const created = put(store, 1, secret);
  const everything = JSON.stringify([created, store.get("r1"), store.find({ senderSessionId: "s_a", senderIncarnation: "inc-1", sendId: "m1" }), store.unresolved("s_r"), store.terminal("s_r"), store.audit(), store.recipients()]);
  expect(everything).not.toContain(MARKER);
  const errors: string[] = [];
  for (const attempt of [() => put(store, 2, secret, { receiptId: "r1" }), () => store.update("r1", 7, { state: "blocked", updatedAt: 1 }), () => store.update("missing", 1, { updatedAt: 1 }), () => store.remove("r1"), () => put(store, 2, secret, { sendId: "" }), () => store.append({ ...entry(3), size: 1 }, secret, WIDE)]) {
    try { attempt(); } catch (error) { errors.push(String((error as Error).message) + String((error as Error).stack ?? "")); }
  }
  expect(errors.length).toBe(6);
  expect(errors.join("\n")).not.toContain(MARKER);
  // The derived handle names the receipt, never the text.
  expect(created.status === "created" && created.record.bodyHandle).toBe("pib_r1");
});

test("readBody throws on a body that is not valid UTF-8 and on a closed database, and is undefined only for absence", () => {
  const { rs, store } = opened();
  put(store, 1, "fine"); put(store, 2, "other");
  rs.db.run("PRAGMA ignore_check_constraints=ON");
  rs.db.run("UPDATE cowork_peer_inbox SET body=x'ff' , size=1 WHERE receipt_id='r2'");
  rs.db.run("PRAGMA ignore_check_constraints=OFF");
  expect(() => store.readBody("pib_r2")).toThrow(); // decode error: damage is an error, never absence
  expect(store.readBody("pib_r1")).toBe("fine");
  expect(store.readBody("pib_nope")).toBeUndefined(); expect(store.readBody("other")).toBeUndefined();
  rs.close();
  expect(() => store.readBody("pib_r1")).toThrow();
});

test("a body that begins with a byte-order mark round-trips unchanged", () => {
  const { store } = opened();
  const result = put(store, 1, "﻿starts with a BOM");
  expect(result.status === "created" && store.readBody(result.record.bodyHandle!)).toBe("﻿starts with a BOM");
});

// ---------------------------------------------------------------- the open-time sweep

test("opening releases a leaked body on a terminal row, reports (and never sweeps) an unresolved row without a body, and has no orphans", () => {
  // The current table's CHECK makes a terminal row with a body unrepresentable (and quick_check refuses such a file),
  // so the leak is staged on a copy of the table WITHOUT that one CHECK, the shape a store built before it would have.
  const home = tempHome();
  const { rs, store } = opened(home);
  const ddl = rs.db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name='cowork_peer_inbox'").get()!.sql;
  const relaxed = ddl.replace(/,\s*CHECK\(state IN \('accepted','blocked'\) OR body IS NULL\)/, "");
  expect(relaxed).not.toBe(ddl);
  rs.db.run("DROP TABLE cowork_peer_inbox"); rs.db.run(relaxed);
  put(store, 1); put(store, 2); put(store, 3);
  rs.db.run("UPDATE cowork_peer_inbox SET state='delivered' WHERE receipt_id='r1'"); // a terminal row that still holds its body
  rs.db.run("UPDATE cowork_peer_inbox SET body=NULL WHERE receipt_id='r2'"); // an unresolved row whose body is lost
  expect(store.audit()).toEqual({ unresolvedWithoutBody: ["r2"], terminalWithBody: ["r1"], orphanBodies: 0 });
  rs.close();
  const again = openRuntimeStateDb(home); cleanup.push(() => again.close());
  const reopened = new SqlitePeerInboxStore(again);
  expect(reopened.audit()).toEqual({ unresolvedWithoutBody: ["r2"], terminalWithBody: [], orphanBodies: 0 });
  expect(reopened.get("r1")!.bodyHandle).toBeNull();
  expect(reopened.get("r2")!.state).toBe("accepted"); // untouched: the ledger fails closed on it
  expect(reopened.readBody("pib_r3")).toBe(`${MARKER}-3`);
});

test("a file whose rows violate the terminal-body CHECK does not open at all (quick_check refuses it)", () => {
  const home = tempHome();
  const { rs, store } = opened(home);
  put(store, 1);
  rs.db.run("PRAGMA ignore_check_constraints=ON");
  rs.db.run("UPDATE cowork_peer_inbox SET state='delivered' WHERE receipt_id='r1'");
  rs.close();
  expect(() => openRuntimeStateDb(home)).toThrow("corrupt");
});

// ---------------------------------------------------------------- the workspace purge

function workspaceFixture() {
  const { home, rs, store } = opened();
  const repo = new CoworkRepository(rs);
  let n = 0;
  const context = () => ({ principalId: "fixture-user", requestId: `req-${++n}` });
  const project = () => {
    const made = repo.create(context(), { ownership: "project", title: "Purge", ceiling: { toolClasses: [], hostServices: [], connectors: [], network: "none" }, sources: [{ kind: "folder", label: "Fixture", access: "read-write", detail: { grantRef: "grant", rootIdentity: "root" } }] });
    return { workspaceId: made.workspaceId, sourceId: made.value.sources[0]!.sourceId };
  };
  const bind = (ws: { workspaceId: string; sourceId: string }, sessionId: string) => {
    rs.db.run("INSERT INTO cowork_conversations(session_id,workspace_id,project_id,source_id,relative_cwd,policy,restrictions_json,revision,state,created_at) VALUES(?,?,NULL,?,'.','ask','{}',1,'active','t')", [sessionId, ws.workspaceId, ws.sourceId]);
  };
  return { home, rs, store, project, bind };
}

test("deleting a workspace purges the rows addressed to its sessions (counter included) and ends the rows it sent", () => {
  const f = workspaceFixture();
  const doomed = f.project(), live = f.project();
  f.bind(doomed, "s_doomed"); f.bind(doomed, "s_doomed2"); f.bind(live, "s_live"); f.bind(live, "s_live2");
  put(f.store, 1, `${MARKER}-to-doomed`, { senderSessionId: "s_live", recipientSessionId: "s_doomed" });
  put(f.store, 2, `${MARKER}-from-doomed`, { senderSessionId: "s_doomed2", recipientSessionId: "s_live" });
  put(f.store, 3, `${MARKER}-unrelated`, { senderSessionId: "s_live", recipientSessionId: "s_live2" });
  f.store.update("r1", 1, { state: "delivered", reason: null, updatedAt: 2 }); // even a terminal record to a doomed recipient goes
  put(f.store, 4, `${MARKER}-retained-terminal`, { senderSessionId: "s_doomed", recipientSessionId: "s_live2" });
  f.store.update("r4", 1, { state: "delivered", reason: null, updatedAt: 2 });
  expect(f.store.purgeWorkspace(doomed.workspaceId, 9_000)).toBe(2); // r1 deleted, r2 ended; r4 was already terminal
  expect(f.store.get("r1")).toBeUndefined();
  expect(rawRows(f.rs, "SELECT * FROM cowork_peer_inbox_sequences WHERE recipient_session_id='s_doomed'")).toEqual([]);
  expect(f.store.get("r2")).toMatchObject({ state: "refused", reason: "sender_gone", bodyHandle: null, updatedAt: 9_000, version: 2 });
  expect(rawRows(f.rs, "SELECT body FROM cowork_peer_inbox WHERE receipt_id='r2'")).toEqual([{ body: null }]);
  expect(f.store.get("r3")!.state).toBe("accepted"); expect(f.store.readBody("pib_r3")).toBe(`${MARKER}-unrelated`);
  expect(f.store.get("r4")!.state).toBe("delivered");
  expect(f.store.purgeWorkspace(doomed.workspaceId, 9_001)).toBe(0); // idempotent
  expect(f.store.audit()).toEqual({ unresolvedWithoutBody: [], terminalWithBody: [], orphanBodies: 0 });
  expect(codeOf(() => f.store.purgeWorkspace("", 1))).toBe("invalid_request");
});

test("a purge inside the caller's transaction commits and rolls back with it", () => {
  const f = workspaceFixture();
  const ws = f.project(); f.bind(ws, "s_gone");
  put(f.store, 1, `${MARKER}-x`, { recipientSessionId: "s_gone" });
  expect(() => f.rs.db.transaction(() => { f.store.purgeWorkspace(ws.workspaceId, 5); throw new Error("abort"); })()).toThrow("abort");
  expect(f.store.get("r1")!.state).toBe("accepted");
  f.rs.db.transaction(() => { f.store.purgeWorkspace(ws.workspaceId, 5); })();
  expect(f.store.get("r1")).toBeUndefined();
});

// ---------------------------------------------------------------- excluded from backups, export and migration

test("a backup never carries a body, a record or a counter, and the copy opens at schema 17", () => {
  for (const readonly of [false, true]) {
    const home = tempHome();
    const { rs, store } = opened(home);
    for (const n of [1, 2, 3]) put(store, n, `${MARKER}-${n}-${"y".repeat(5_000)}`);
    store.update("r3", 1, { state: "delivered", reason: null, updatedAt: 3 });
    let handle = rs;
    if (readonly) { rs.db.run("PRAGMA wal_checkpoint(TRUNCATE)"); handle = openRuntimeStateDb(home, { readonly: true }); cleanup.push(() => handle.close()); }
    const copy = handle.backup(join(home, "bk"));
    const raw = new Database(copy, { readonly: true });
    try {
      for (const table of COWORK_BACKUP_EXCLUDED_TABLES) expect(raw.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      expect(raw.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(17);
      expect(raw.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
    } finally { raw.close(); }
    // Not in the file at all: the freed pages are vacuumed away, so the marker is not recoverable from the backup bytes.
    expect(readFileSync(copy).includes(MARKER)).toBe(false);
    expect(readdirSync(join(home, "bk"))).toEqual([basename(copy)]); // no sidecar, no leftover
    // The live store is untouched by taking a backup.
    expect(store.unresolved("s_r")).toHaveLength(2);
    expect(store.readBody("pib_r1")?.startsWith(MARKER)).toBe(true);
  }
});

test("a backup fails closed: if the exclusion cannot be proven the copy is deleted and the backup throws", () => {
  const home = tempHome();
  const { rs, store } = opened(home);
  put(store, 1);
  // A trigger that refuses to let the inbox be emptied models an exclusion that cannot complete.
  rs.db.run("CREATE TRIGGER block_purge BEFORE DELETE ON cowork_peer_inbox BEGIN SELECT RAISE(ABORT,'blocked'); END");
  expect(() => rs.backup(join(home, "bk"))).toThrow();
  expect(readdirSync(join(home, "bk"))).toEqual([]);
});

test("a backup whose exclusion silently does nothing is caught by the verification and refused", () => {
  const home = tempHome();
  const { rs, store } = opened(home);
  put(store, 1);
  // RAISE(IGNORE) skips the row without an error: only the post-condition check can notice.
  rs.db.run("CREATE TRIGGER skip_purge BEFORE DELETE ON cowork_peer_inbox BEGIN SELECT RAISE(IGNORE); END");
  expect(() => rs.backup(join(home, "bk"))).toThrow("backup exclusion failed");
  expect(readdirSync(join(home, "bk"))).toEqual([]);
});

test("a store that has no inbox tables (a pre-17 shape) still backs up", () => {
  const home = tempHome();
  const { rs } = opened(home);
  rs.db.run("DROP TABLE cowork_peer_inbox"); rs.db.run("DROP TABLE cowork_peer_inbox_sequences");
  expect(readdirSync(join(rs.backup(join(home, "bk")), ".."))).toHaveLength(1);
});

test("Migration B treats a populated inbox as Cowork authority and refuses the copy, without echoing a body", () => {
  const home = tempHome();
  const { rs, store } = opened(home);
  expect(inspectCoworkSource(home)).toEqual({ present: false });
  put(store, 1);
  rs.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  const finding = inspectCoworkSource(home);
  expect(finding).toMatchObject({ present: true, kind: "authority-records" });
  expect(JSON.stringify(finding)).not.toContain(MARKER);
});

// ---------------------------------------------------------------- a real kill -9

const childScript = join(import.meta.dir, "fixtures", "peer-inbox-kill-child.ts");
async function killMidway(mode: "append" | "terminal" | "remove"): Promise<{ home: string; done: number }> {
  const home = tempHome("winter-peer-inbox-kill-");
  const child = Bun.spawn([process.execPath, childScript, home, mode], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, WINTER_HOME: home } });
  const reader = child.stdout.getReader(), decoder = new TextDecoder();
  let text = "", done = 0;
  const deadline = Date.now() + 90_000;
  while (done < 4 && Date.now() < deadline) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
    done = (text.match(/^done \d+$/gm) ?? []).length;
  }
  child.kill(9);
  await child.exited;
  expect(done).toBeGreaterThanOrEqual(4); // the child really was running operations when it was killed
  return { home, done };
}
function assertSound(home: string) {
  const rs = openRuntimeStateDb(home); cleanup.push(() => rs.close()); // a WAL left by the killed process is recovered here
  const store = new SqlitePeerInboxStore(rs);
  expect(rs.integrity().ok).toBe(true);
  expect(store.audit()).toEqual({ unresolvedWithoutBody: [], terminalWithBody: [], orphanBodies: 0 }); // no record without its body, no leftover to sweep
  const counter = rs.db.query<{ last_sequence: number }, []>("SELECT last_sequence FROM cowork_peer_inbox_sequences WHERE recipient_session_id='s_r'").get()?.last_sequence ?? 0;
  const highest = rs.db.query<{ n: number | null }, []>("SELECT max(sequence) AS n FROM cowork_peer_inbox").get()!.n ?? 0;
  expect(counter).toBeGreaterThanOrEqual(highest); // a sequence number is never behind a row that holds it
  return { store, rs, counter };
}
test("kill -9 mid-append: every committed message is whole, nothing is torn, and the next append continues the sequence", async () => {
  const { home, done } = await killMidway("append");
  const { store, rs, counter } = assertSound(home);
  const count = rs.db.query<{ n: number }, []>("SELECT count(*) AS n FROM cowork_peer_inbox").get()!.n;
  expect(count).toBeGreaterThanOrEqual(done); expect(count).toBeLessThanOrEqual(done + 1 + 50); // the in-flight appends either committed whole or are absent
  expect(counter).toBe(count);
  for (const row of rawRows(rs, "SELECT receipt_id, size FROM cowork_peer_inbox") as Array<{ receipt_id: string; size: number }>) expect(Buffer.byteLength(store.readBody(`pib_${row.receipt_id}`)!)).toBe(row.size);
  expect(put(store, 99_999, "after the kill").status).toBe("created");
  expect(store.get("r99999")!.sequence).toBe(counter + 1);
}, 120_000);
test("kill -9 mid-terminal-update: a terminal row has no body, an unresolved row keeps its whole body", async () => {
  const { home, done } = await killMidway("terminal");
  const { store, rs } = assertSound(home);
  const terminal = rs.db.query<{ n: number }, []>("SELECT count(*) AS n FROM cowork_peer_inbox WHERE state='delivered'").get()!.n;
  expect(terminal).toBeGreaterThanOrEqual(done);
  for (const record of store.unresolved("s_r")) expect(store.readBody(record.bodyHandle!)).toMatch(/^kill-test-body-\d+-x{2000}$/);
}, 120_000);
test("kill -9 mid-remove: only terminal rows go, the counter never falls back", async () => {
  const { home, done } = await killMidway("remove");
  const { rs, counter } = assertSound(home);
  const remaining = rs.db.query<{ n: number }, []>("SELECT count(*) AS n FROM cowork_peer_inbox").get()!.n;
  expect(remaining).toBeLessThanOrEqual(120 - done);
  expect(counter).toBe(120);
}, 120_000);
