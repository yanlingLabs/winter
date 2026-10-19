// Migrations 20 and 21 (DOOR owns every migration). Records only: nothing in production writes or reads these columns
// and tables yet.
//  - 20, content-out (#97, definitions from that lane): `cowork_exports.content_digest` and `cowork_export_output_ids`.
//  - 21, #92 host side (design section 8): stable guest uids, the four-state store, the data volume UUID, the browse uid,
//    the guest boot record, and the held-input columns of the peer inbox.
// Pinned here: the fresh shape, every CHECK and key, the L7 keep rule, the upgrade from a v19 store (rows survive, the
// store_state backfill never says "none" over a recorded backend), idempotent replay and the downgrade ladder.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoworkRepository } from "../../src/cowork/repository";
import { COWORK_TABLES } from "../../src/cowork/schema";
import { downgradeCoworkRuntimeStateToV7, downgradeRuntimeStateToV6, openRuntimeStateDb, RUNTIME_STATE_SCHEMA_VERSION, type RuntimeStateDb } from "../../src/runtime-state/db";
import { authorityFixtureSessions } from "./committed-sessions";

const homes: string[] = [], open: RuntimeStateDb[] = [];
afterEach(() => { open.splice(0).forEach(db => { try { db.close(); } catch { /* closed */ } }); homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true })); });
const tempHome = () => { const home = mkdtempSync(join(tmpdir(), "winter-cowork-n1-schema-")); homes.push(home); return home; };
const openDb = (home: string) => { const db = openRuntimeStateDb(home); open.push(db); return db; };
const rawPath = (home: string) => join(home, "runtimes", "runtime-state.db");
const userVersion = (home: string) => { const raw = new Database(rawPath(home), { readonly: true }); try { return raw.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version; } finally { raw.close(); } };
const columnsOf = (db: Database, table: string) => db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map(column => column.name);
const HEX = "a".repeat(64), UUID = "0123abcd-4567-89ef-0123-456789abcdef", BOOT = "11111111-2222-4333-8444-555555555555";

function bound(db: RuntimeStateDb, sessionId = "s_bound") {
  const records = new CoworkRepository(db);
  const made = records.create({ principalId: "fixture", requestId: `create-${sessionId}` }, { ownership: "project", title: "N1 fixture",
    ceiling: { toolClasses: ["read"], hostServices: [], connectors: [], network: "none" },
    sources: [{ kind: "folder", label: "N1 fixture", access: "read-write", detail: { grantRef: "grant", rootIdentity: "root" } }] });
  const source = records.sources(made.workspaceId)[0]!, epoch = records.beginIncarnation(made.workspaceId, `incarnation-${sessionId}`, 1);
  records.acknowledgeSource(epoch, source.sourceId, source.revision, "ready");
  records.bindConversation({ principalId: "fixture", requestId: `bind-${sessionId}`, expectedRevision: 1 }, made.workspaceId, { sessionId, sourceId: source.sourceId, relativeCwd: "." }, authorityFixtureSessions(sessionId));
  return { records, workspaceId: made.workspaceId, sourceId: source.sourceId };
}
const addExport = (db: Database, workspaceId: string, exportId = "export_1", generation = 1) =>
  db.run("INSERT INTO cowork_exports(export_id,workspace_id,generation,state,manifest_json,manifest_digest,created_at,updated_at) VALUES(?,?,?,'prepared','{}',?,'t','t')", [exportId, workspaceId, generation, HEX]);
const addInbox = (db: Database, receiptId = "r1") =>
  db.run("INSERT INTO cowork_peer_inbox(receipt_id,sender_session_id,sender_incarnation,send_id,recipient_session_id,digest,size,body,sequence,state,attempts,accepted_at,updated_at,version) VALUES(?,'s_a','inc-1',?,'s_r',?,1,?,1,'accepted',0,1,1,1)", [receiptId, `m-${receiptId}`, HEX, Buffer.from("x")]);
const addUid = (db: Database, workspaceId: string, uid: number, role: string, sessionId: string | null) =>
  db.run("INSERT INTO cowork_guest_uids(workspace_id,uid,role,session_id,allocated_at) VALUES(?,?,?,?,'t')", [workspaceId, uid, role, sessionId]);
const addBoot = (db: Database, workspaceId: string, incarnationId: string, bootId = BOOT, epoch = 1) =>
  db.run("INSERT INTO cowork_guest_boots(workspace_id,incarnation_id,lease_epoch,guest_boot_id,recorded_at) VALUES(?,?,?,?,'t')", [workspaceId, incarnationId, epoch, bootId]);

/** Undo 21 and 20 on a current store (rows carried over), and rewind to 19. */
function rewindToV19(db: Database): void {
  db.exec(`DROP INDEX cowork_conversations_runtime_uid; DROP INDEX cowork_conversations_tool_uid;
    DROP TABLE cowork_guest_boots; DROP TABLE cowork_guest_uids; DROP TABLE cowork_export_output_ids;
    ALTER TABLE cowork_conversations DROP COLUMN last_incarnation_id; ALTER TABLE cowork_conversations DROP COLUMN store_state;
    ALTER TABLE cowork_conversations DROP COLUMN tool_uid; ALTER TABLE cowork_conversations DROP COLUMN runtime_uid;
    ALTER TABLE cowork_workspaces DROP COLUMN browse_uid; ALTER TABLE cowork_workspaces DROP COLUMN store_volume_uuid;
    ALTER TABLE cowork_peer_inbox DROP COLUMN commit_outcome; ALTER TABLE cowork_peer_inbox DROP COLUMN commit_confirmed_at;
    ALTER TABLE cowork_peer_inbox DROP COLUMN acked_hold_token; ALTER TABLE cowork_peer_inbox DROP COLUMN offer_count;
    ALTER TABLE cowork_exports DROP COLUMN content_digest;
    PRAGMA user_version=19;`);
}

test("schema 21 is current; the new tables are Cowork authority, each listed before the table it references", () => {
  expect(RUNTIME_STATE_SCHEMA_VERSION).toBe(21);
  const db = openDb(tempHome());
  expect(db.schemaVersion()).toBe(21);
  const tables: readonly string[] = COWORK_TABLES;
  for (const [child, parent] of [["cowork_export_output_ids", "cowork_exports"], ["cowork_guest_uids", "cowork_workspaces"], ["cowork_guest_boots", "cowork_workspaces"]] as const) {
    expect(tables).toContain(child);
    expect(tables.indexOf(child)).toBeLessThan(tables.indexOf(parent));
  }
  expect(columnsOf(db.db, "cowork_export_output_ids")).toEqual(["export_id", "opaque_id", "session_id"]);
  expect(columnsOf(db.db, "cowork_guest_uids")).toEqual(["workspace_id", "uid", "role", "session_id", "allocated_at", "retired_at", "released_at"]);
  expect(columnsOf(db.db, "cowork_guest_boots")).toEqual(["workspace_id", "incarnation_id", "lease_epoch", "guest_boot_id", "recorded_at", "ended_proof", "ended_at"]);
  expect(columnsOf(db.db, "cowork_exports").at(-1)).toBe("content_digest");
  expect(columnsOf(db.db, "cowork_workspaces").slice(-2)).toEqual(["store_volume_uuid", "browse_uid"]);
  expect(columnsOf(db.db, "cowork_conversations").slice(-4)).toEqual(["runtime_uid", "tool_uid", "store_state", "last_incarnation_id"]);
  expect(columnsOf(db.db, "cowork_peer_inbox").slice(-4)).toEqual(["offer_count", "acked_hold_token", "commit_confirmed_at", "commit_outcome"]);
  expect(db.integrity().ok).toBe(true);
});

test("migration 20 (#97): content_digest is NULL until written, and only lowercase 64-hex; output ids are s+16 hex, keyed per export", () => {
  const db = openDb(tempHome()), { workspaceId } = bound(db);
  addExport(db.db, workspaceId);
  expect(db.db.query("SELECT content_digest FROM cowork_exports").get()).toEqual({ content_digest: null });
  for (const bad of ["A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), ""]) expect(() => db.db.run("UPDATE cowork_exports SET content_digest=?", [bad])).toThrow();
  db.db.run("UPDATE cowork_exports SET content_digest=?", [HEX]);
  const id = (opaque: string, session: string, exportId = "export_1") => db.db.run("INSERT INTO cowork_export_output_ids(export_id,opaque_id,session_id) VALUES(?,?,?)", [exportId, opaque, session]);
  id("s0123456789abcdef", "s_one");
  for (const bad of ["t0123456789abcdef", "s0123456789ABCDEF", "s0123456789abcde", "s0123456789abcdef0", "s0123456789abcdeg"]) expect(() => id(bad, "s_other")).toThrow();
  expect(() => id("s0123456789abcdef", "s_two")).toThrow(); // the primary key
  expect(() => id("sfedcba9876543210", "s_one")).toThrow(); // one opaque id per session folder per export
  expect(() => id("sfedcba9876543210", "s_two", "export_missing")).toThrow(); // the export must exist
  id("sfedcba9876543210", "s_deleted_session"); // no foreign key on the session: a deleted session's export stays valid
  addExport(db.db, workspaceId, "export_2", 2); id("s0123456789abcdef", "s_one", "export_2"); // a different export may reuse both
  expect(db.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("migration 21: a bound conversation starts at store_state none with no uids; the CHECKs keep uids in range and distinct", () => {
  const db = openDb(tempHome()), { workspaceId, sourceId, records } = bound(db);
  expect(db.db.query("SELECT runtime_uid,tool_uid,store_state,last_incarnation_id FROM cowork_conversations").get()).toEqual({ runtime_uid: null, tool_uid: null, store_state: "none", last_incarnation_id: null });
  const set = (sql: string, ...args: (string | number | null)[]) => db.db.run(`UPDATE cowork_conversations SET ${sql} WHERE session_id='s_bound'`, args);
  for (const state of ["none", "started", "created", "lost"]) set("store_state=?", state);
  expect(() => set("store_state=?", "fresh")).toThrow();
  expect(() => set("store_state=NULL")).toThrow();
  for (const uid of [999, 65534, 65535, 0]) { expect(() => set("runtime_uid=?", uid)).toThrow(); expect(() => set("tool_uid=?", uid)).toThrow(); }
  set("runtime_uid=1000, tool_uid=65533");
  expect(() => set("tool_uid=1000")).toThrow(); // never the runtime uid
  records.bindConversation({ principalId: "fixture", requestId: "bind-s_two", expectedRevision: 2 }, workspaceId, { sessionId: "s_two", sourceId, relativeCwd: "." }, authorityFixtureSessions("s_two"));
  const other = (sql: string, ...args: number[]) => db.db.run(`UPDATE cowork_conversations SET ${sql} WHERE session_id='s_two'`, args);
  expect(() => other("runtime_uid=1000, tool_uid=2000")).toThrow(); // another conversation's runtime uid in the same workspace
  expect(() => other("runtime_uid=2000, tool_uid=65533")).toThrow(); // another conversation's tool uid
  other("runtime_uid=2000, tool_uid=2001");
  set("last_incarnation_id='incarnation-s_bound'");
});

test("migration 21: the workspace keeps a lowercase volume UUID and a browse uid in range", () => {
  const db = openDb(tempHome()), { workspaceId } = bound(db);
  expect(db.db.query("SELECT store_volume_uuid,browse_uid FROM cowork_workspaces").get()).toEqual({ store_volume_uuid: null, browse_uid: null });
  const set = (column: string, value: string | number) => db.db.run(`UPDATE cowork_workspaces SET ${column}=? WHERE workspace_id=?`, [value, workspaceId]);
  for (const bad of [UUID.toUpperCase(), `A${UUID.slice(1)}`, UUID.replaceAll("-", ""), `${UUID}0`, UUID.replace("-", "_"), "g".repeat(8) + UUID.slice(8)]) expect(() => set("store_volume_uuid", bad)).toThrow();
  set("store_volume_uuid", UUID);
  for (const bad of [999, 65534]) expect(() => set("browse_uid", bad)).toThrow();
  set("browse_uid", 4242);
});

test("migration 21: the uid table never forgets a uid before its files are proven removed (L7), one owner per role, one browse uid", () => {
  const db = openDb(tempHome()), { workspaceId } = bound(db);
  addUid(db.db, workspaceId, 1000, "runtime", "s_bound");
  addUid(db.db, workspaceId, 1001, "tool", "s_bound");
  addUid(db.db, workspaceId, 1002, "browse", null);
  expect(() => addUid(db.db, workspaceId, 1000, "tool", "s_other")).toThrow(); // a uid is allocated once per workspace
  expect(() => addUid(db.db, workspaceId, 1003, "runtime", "s_bound")).toThrow(); // one runtime uid per conversation
  expect(() => addUid(db.db, workspaceId, 1004, "browse", null)).toThrow(); // one browse uid per workspace
  expect(() => addUid(db.db, workspaceId, 1005, "browse", "s_bound")).toThrow(); // the browse uid belongs to no conversation
  expect(() => addUid(db.db, workspaceId, 1006, "runtime", null)).toThrow(); // a runtime uid belongs to one
  expect(() => addUid(db.db, workspaceId, 1007, "admin", "s_x")).toThrow();
  for (const uid of [999, 65534]) expect(() => addUid(db.db, workspaceId, uid, "runtime", "s_y")).toThrow();
  expect(() => addUid(db.db, "ws_missing", 1008, "runtime", "s_z")).toThrow(); // the workspace must exist
  const where = "WHERE workspace_id=? AND uid=1000";
  expect(() => db.db.run(`UPDATE cowork_guest_uids SET released_at='t' ${where}`, [workspaceId])).toThrow(); // released needs retired
  expect(() => db.db.run(`DELETE FROM cowork_guest_uids ${where}`, [workspaceId])).toThrow("kept until its files are proven removed");
  db.db.run(`UPDATE cowork_guest_uids SET retired_at='t' ${where}`, [workspaceId]);
  expect(() => db.db.run(`DELETE FROM cowork_guest_uids ${where}`, [workspaceId])).toThrow("kept until its files are proven removed"); // retired is not enough
  db.db.run(`UPDATE cowork_guest_uids SET released_at='t' ${where}`, [workspaceId]);
  db.db.run(`DELETE FROM cowork_guest_uids ${where}`, [workspaceId]);
  expect(db.db.query("SELECT uid FROM cowork_guest_uids ORDER BY uid").all()).toEqual([{ uid: 1001 }, { uid: 1002 }]);
});

test("migration 21: a guest boot is recorded once, and its end carries both a proof and a time or neither", () => {
  const db = openDb(tempHome()), { workspaceId } = bound(db);
  addBoot(db.db, workspaceId, "inc-1");
  expect(() => addBoot(db.db, workspaceId, "inc-2")).toThrow(); // a boot id is never recorded twice
  expect(() => addBoot(db.db, workspaceId, "inc-1", "21111111-2222-4333-8444-555555555555")).toThrow(); // one boot per incarnation
  expect(() => addBoot(db.db, workspaceId, "inc-3", "31111111-2222-4333-8444-555555555555", 0)).toThrow(); // a lease epoch is positive
  expect(() => addBoot(db.db, workspaceId, "inc-4", "short")).toThrow();
  expect(() => addBoot(db.db, "ws_missing", "inc-5", "51111111-2222-4333-8444-555555555555")).toThrow();
  const end = (proof: string | null, at: string | null) => db.db.run("UPDATE cowork_guest_boots SET ended_proof=?, ended_at=? WHERE incarnation_id='inc-1'", [proof, at]);
  expect(() => end("orderly-receipt", null)).toThrow();
  expect(() => end(null, "t")).toThrow();
  expect(() => end("guest-marker", "t")).toThrow(); // a guest-written marker is never evidence
  for (const proof of ["orderly-receipt", "new-boot", "owner-recover"]) end(proof, "t");
});

test("migration 21: the held-input inbox columns default to nothing offered, nothing held and nothing confirmed", () => {
  const db = openDb(tempHome());
  addInbox(db.db);
  expect(db.db.query("SELECT offer_count,acked_hold_token,commit_confirmed_at,commit_outcome FROM cowork_peer_inbox").get()).toEqual({ offer_count: 0, acked_hold_token: null, commit_confirmed_at: null, commit_outcome: null });
  const set = (sql: string, ...args: (string | number | null)[]) => db.db.run(`UPDATE cowork_peer_inbox SET ${sql} WHERE receipt_id='r1'`, args);
  expect(() => set("offer_count=-1")).toThrow();
  expect(() => set("offer_count=NULL")).toThrow();
  set("offer_count=3");
  for (const bad of ["A".repeat(64), "a".repeat(63), "z".repeat(64)]) expect(() => set("acked_hold_token=?", bad)).toThrow();
  set("acked_hold_token=?", HEX);
  expect(() => set("commit_outcome='delivered'")).toThrow();
  for (const outcome of ["folded", "queued", "started", "already", "lost"]) set("commit_outcome=?, commit_confirmed_at=1", outcome);
});

test("a v19 store upgrades in place: rows survive, store_state is started exactly where a backend was recorded, and a replay is a no-op", () => {
  const home = tempHome(), first = openDb(home), { workspaceId, sourceId, records } = bound(first);
  records.bindConversation({ principalId: "fixture", requestId: "bind-s_backend", expectedRevision: 2 }, workspaceId, { sessionId: "s_backend", sourceId, relativeCwd: "." }, authorityFixtureSessions("s_backend"));
  addExport(first.db, workspaceId); addInbox(first.db);
  rewindToV19(first.db);
  first.db.run("UPDATE cowork_conversations SET backend_session_id='task-1' WHERE session_id='s_backend'");
  const before = { conversations: first.db.query("SELECT * FROM cowork_conversations ORDER BY session_id").all(), workspaces: first.db.query("SELECT * FROM cowork_workspaces").all() };
  first.close();
  expect(userVersion(home)).toBe(19);

  const second = openDb(home);
  expect(second.schemaVersion()).toBe(21);
  expect(second.db.query("SELECT session_id,store_state,runtime_uid,tool_uid,last_incarnation_id FROM cowork_conversations ORDER BY session_id").all()).toEqual([
    { session_id: "s_backend", store_state: "started", runtime_uid: null, tool_uid: null, last_incarnation_id: null },
    { session_id: "s_bound", store_state: "none", runtime_uid: null, tool_uid: null, last_incarnation_id: null },
  ]);
  const kept = (rows: unknown[], drop: string[]) => rows.map(row => Object.fromEntries(Object.entries(row as object).filter(([key]) => !drop.includes(key))));
  expect(kept(second.db.query("SELECT * FROM cowork_conversations ORDER BY session_id").all(), ["runtime_uid", "tool_uid", "store_state", "last_incarnation_id"])).toEqual(before.conversations as object[]);
  expect(kept(second.db.query("SELECT * FROM cowork_workspaces").all(), ["store_volume_uuid", "browse_uid"])).toEqual(before.workspaces as object[]);
  expect(second.db.query("SELECT content_digest FROM cowork_exports").get()).toEqual({ content_digest: null });
  expect(second.db.query("SELECT offer_count,acked_hold_token FROM cowork_peer_inbox").get()).toEqual({ offer_count: 0, acked_hold_token: null });

  // A rewound user_version replays 20 and 21 over the current shape without effect: the backfill never runs twice.
  second.db.run("UPDATE cowork_conversations SET store_state='lost' WHERE session_id='s_backend'");
  second.db.run("PRAGMA user_version=19"); second.close();
  const third = openDb(home);
  expect(third.schemaVersion()).toBe(21);
  expect(third.db.query("SELECT store_state FROM cowork_conversations WHERE session_id='s_backend'").get()).toEqual({ store_state: "lost" });
  expect(third.integrity().ok).toBe(true);
  expect(third.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("the downgrade ladder: an empty v21 store rolls back to 7 and 6 and upgrades again; populated authority refuses; v22 is newer", () => {
  const empty = tempHome(); openDb(empty).close();
  expect(downgradeCoworkRuntimeStateToV7(empty)).toEqual({ from: 21, to: 7 });
  let db = openDb(empty); expect(db.schemaVersion()).toBe(21); expect(columnsOf(db.db, "cowork_guest_uids")).not.toEqual([]); db.close();
  expect(downgradeRuntimeStateToV6(empty)).toEqual({ from: 21, to: 6 });
  db = openDb(empty); expect(db.schemaVersion()).toBe(21); db.close();

  const populated = tempHome(), withRows = openDb(populated), { workspaceId } = bound(withRows);
  addUid(withRows.db, workspaceId, 1000, "runtime", "s_bound"); addBoot(withRows.db, workspaceId, "inc-1"); withRows.close();
  expect(() => downgradeCoworkRuntimeStateToV7(populated)).toThrow("Cowork authority");
  expect(() => downgradeRuntimeStateToV6(populated)).toThrow("Cowork authority");
  expect(userVersion(populated)).toBe(21);

  const newer = tempHome(); openDb(newer).close();
  const raw = new Database(rawPath(newer)); raw.run("PRAGMA user_version=22"); raw.close();
  expect(() => downgradeCoworkRuntimeStateToV7(newer)).toThrow("newer-schema");
  expect(() => downgradeRuntimeStateToV6(newer)).toThrow("newer-schema");
});
