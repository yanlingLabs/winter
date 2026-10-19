// Migration 18 (Cowork session door, D1; design doc gaps G1 and G9): `cowork_conversations` is rebuilt to carry the
// binding's location kind (`source` for every existing row, `outputs` for the conversation's own outputs location, the
// first-session working root) and the guest runtime's backend identity (NULL until a later slice mints it at bind).
// Records only: no door creates a row, nothing reads either column yet. Pinned here: the fresh and the upgraded shape are
// the same, rows and their dependents survive the rebuild, the CHECKs make every other combination unrepresentable, the
// migration is idempotent, and the downgrade ladder still holds (an empty store rolls back, a bound conversation refuses).
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoworkRepository } from "../../src/cowork/repository";
import { COWORK_TABLES, migrateCoworkSessionBindingSchema } from "../../src/cowork/schema";
import { downgradeCoworkRuntimeStateToV7, downgradeRuntimeStateToV6, openRuntimeStateDb, RUNTIME_STATE_SCHEMA_VERSION, type RuntimeStateDb } from "../../src/runtime-state/db";
import { authorityFixtureSessions } from "./committed-sessions";

const homes: string[] = [], open: RuntimeStateDb[] = [];
afterEach(() => { open.splice(0).forEach(db => { try { db.close(); } catch { /* closed */ } }); homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true })); });
const tempHome = () => { const home = mkdtempSync(join(tmpdir(), "winter-cowork-binding-schema-")); homes.push(home); return home; };
const openDb = (home: string) => { const db = openRuntimeStateDb(home); open.push(db); return db; };
const rawPath = (home: string) => join(home, "runtimes", "runtime-state.db");
const userVersion = (home: string) => { const raw = new Database(rawPath(home), { readonly: true }); try { return raw.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version; } finally { raw.close(); } };
const columns = (db: Database) => db.query<{ name: string; notnull: number; dflt_value: string | null }, []>("PRAGMA table_info(cowork_conversations)").all();
const tableSql = (db: Database) => db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type='table' AND name='cowork_conversations'").get()!.sql;

const V18_COLUMNS = ["session_id", "workspace_id", "project_id", "location_kind", "source_id", "relative_cwd", "policy", "restrictions_json", "revision", "state", "created_at", "backend_session_id", "runtime_uid", "tool_uid", "store_state", "last_incarnation_id"]; // + v21 (#92)
/** The table exactly as v8 created it and v17 left it. */
const V17_TABLE = `CREATE TABLE cowork_conversations (
      session_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES cowork_workspaces(workspace_id),
      project_id TEXT REFERENCES cowork_projects(project_id), source_id TEXT NOT NULL,
      relative_cwd TEXT NOT NULL, policy TEXT NOT NULL CHECK(policy IN ('plan','dont-ask','ask','accept-edits','auto','bypass')),
      restrictions_json TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
      state TEXT NOT NULL CHECK(state IN ('active','archived','deleted')), created_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id,source_id) REFERENCES cowork_sources(workspace_id,source_id)
    )`;

/** A project workspace with one ready source and one bound conversation, through the repository (the only writer). */
function bound(db: RuntimeStateDb, sessionId = "s_bound") {
  const records = new CoworkRepository(db);
  const made = records.create({ principalId: "fixture", requestId: `create-${sessionId}` }, { ownership: "project", title: "Binding fixture",
    ceiling: { toolClasses: ["read"], hostServices: [], connectors: [], network: "none" },
    sources: [{ kind: "folder", label: "Binding fixture", access: "read-write", detail: { grantRef: "grant", rootIdentity: "root" } }] });
  const source = records.sources(made.workspaceId)[0]!, epoch = records.beginIncarnation(made.workspaceId, `incarnation-${sessionId}`, 1);
  records.acknowledgeSource(epoch, source.sourceId, source.revision, "ready");
  records.bindConversation({ principalId: "fixture", requestId: `bind-${sessionId}`, expectedRevision: 1 }, made.workspaceId, { sessionId, sourceId: source.sourceId, relativeCwd: "repo/sub" }, authorityFixtureSessions(sessionId));
  return { records, workspaceId: made.workspaceId, sourceId: source.sourceId };
}
/** Rewrite a current store's conversations table to the v17 shape (rows carried over) and rewind to 17. */
function rewindToV17(db: RuntimeStateDb): void {
  db.db.run("PRAGMA foreign_keys=OFF");
  db.db.exec(`${V17_TABLE.replace("CREATE TABLE cowork_conversations", "CREATE TABLE cowork_conversations_old")};
    INSERT INTO cowork_conversations_old SELECT session_id,workspace_id,project_id,source_id,relative_cwd,policy,restrictions_json,revision,state,created_at FROM cowork_conversations;
    DROP TABLE cowork_conversations; ALTER TABLE cowork_conversations_old RENAME TO cowork_conversations;
    DROP TABLE IF EXISTS cowork_home_binding;
    CREATE INDEX IF NOT EXISTS cowork_conversations_workspace ON cowork_conversations(workspace_id);
    PRAGMA user_version=17;`);
  db.db.run("PRAGMA foreign_keys=ON");
}

test("schema 18 is current, and a fresh store has the binding columns in order with their defaults", () => {
  expect(RUNTIME_STATE_SCHEMA_VERSION).toBe(21);
  const db = openDb(tempHome());
  expect(db.schemaVersion()).toBe(21);
  expect(columns(db.db).map(column => column.name)).toEqual(V18_COLUMNS);
  const byName = Object.fromEntries(columns(db.db).map(column => [column.name, column]));
  expect(byName.location_kind).toMatchObject({ notnull: 1, dflt_value: "'source'" });
  expect(byName.source_id!.notnull).toBe(0);
  expect(byName.backend_session_id!.notnull).toBe(0);
  expect(db.db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='cowork_conversations_workspace'").get()).toEqual({ name: "cowork_conversations_workspace" });
  expect(db.db.query("SELECT name FROM sqlite_master WHERE name='cowork_conversations_v18'").get()).toBeNull();
});

test("a bind through the repository writes a source row with no backend identity, and reads back unchanged", () => {
  const db = openDb(tempHome()), { records, workspaceId, sourceId } = bound(db);
  expect(db.db.query("SELECT location_kind, source_id, relative_cwd, backend_session_id FROM cowork_conversations WHERE session_id='s_bound'").get())
    .toEqual({ location_kind: "source", source_id: sourceId, relative_cwd: "repo/sub", backend_session_id: null });
  expect(records.binding("s_bound")).toMatchObject({ sessionId: "s_bound", workspaceId, sourceId, relativeCwd: "repo/sub", revision: 1, state: "active" });
});

test("the CHECKs: an outputs row has no source and the root cwd; a source row has a source; the identity is bounded and unique", () => {
  const db = openDb(tempHome()), { workspaceId, sourceId } = bound(db);
  const insert = (sessionId: string, kind: string, source: string | null, cwd: string, backend: string | null = null) =>
    db.db.run("INSERT INTO cowork_conversations(session_id,workspace_id,project_id,location_kind,source_id,relative_cwd,policy,restrictions_json,revision,state,created_at,backend_session_id) VALUES(?,?,NULL,?,?,?,'auto','{}',1,'active','t',?)",
      [sessionId, workspaceId, kind, source, cwd, backend]);
  insert("s_outputs", "outputs", null, ".");
  insert("s_backend", "source", sourceId, ".", "b".repeat(128));
  insert("s_nullbackend", "source", sourceId, "."); // NULL is never a duplicate
  for (const [label, run] of [
    ["outputs with a source", () => insert("s_x1", "outputs", sourceId, ".")],
    ["outputs below the root", () => insert("s_x2", "outputs", null, "sub")],
    ["source without a source", () => insert("s_x3", "source", null, ".")],
    ["an unknown kind", () => insert("s_x4", "folder", sourceId, ".")],
    ["an empty identity", () => insert("s_x5", "source", sourceId, ".", "")],
    ["an identity over 128", () => insert("s_x6", "source", sourceId, ".", "b".repeat(129))],
    ["a duplicate identity", () => insert("s_x7", "source", sourceId, ".", "b".repeat(128))],
  ] as const) expect([label, (() => { try { run(); return "accepted"; } catch (err) { return /constraint/i.test(String(err)) ? "refused" : String(err); } })()]).toEqual([label, "refused"]);
  // A NULL location kind is refused too (NOT NULL), and an omitted one takes the default.
  expect(() => db.db.run("INSERT INTO cowork_conversations(session_id,workspace_id,location_kind,source_id,relative_cwd,policy,restrictions_json,revision,state,created_at) VALUES('s_x8',?,NULL,?,'.','auto','{}',1,'active','t')", [workspaceId, sourceId])).toThrow();
  db.db.run("INSERT INTO cowork_conversations(session_id,workspace_id,source_id,relative_cwd,policy,restrictions_json,revision,state,created_at) VALUES('s_default',?,?,'.','auto','{}',1,'active','t')", [workspaceId, sourceId]);
  expect(db.db.query("SELECT location_kind FROM cowork_conversations WHERE session_id='s_default'").get()).toEqual({ location_kind: "source" });
  expect(db.db.query("SELECT count(*) AS n FROM cowork_conversations").get()).toEqual({ n: 5 });
  expect(db.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("a v17 store upgrades in place: rows, their dependents and the index survive, and the new shape is the fresh one", () => {
  const home = tempHome(), first = openDb(home), { workspaceId, sourceId } = bound(first);
  const freshSql = tableSql(first.db);
  // A dependent row (cowork_output_locations references cowork_conversations(session_id)).
  const homeId = new CoworkRepository(first).homeIdentity();
  first.db.run("INSERT INTO cowork_output_directories(relative_path,home_id,identity_json) VALUES('out/s_bound',?,'{}')", [homeId]);
  first.db.run("INSERT INTO cowork_output_locations(location_id,home_id,workspace_id,session_id,relative_path,revision,created_at) VALUES('loc_1',?,?,'s_bound','out/s_bound',1,'t')", [homeId, workspaceId]);
  const before = first.db.query("SELECT session_id,workspace_id,project_id,source_id,relative_cwd,policy,restrictions_json,revision,state,created_at FROM cowork_conversations").all();
  rewindToV17(first);
  expect(columns(first.db).map(column => column.name)).not.toContain("location_kind");
  first.close();
  expect(userVersion(home)).toBe(17);

  const second = openDb(home);
  expect(second.schemaVersion()).toBe(21);
  expect(columns(second.db).map(column => column.name)).toEqual(V18_COLUMNS);
  expect(second.db.query("SELECT session_id,workspace_id,project_id,source_id,relative_cwd,policy,restrictions_json,revision,state,created_at FROM cowork_conversations").all()).toEqual(before);
  expect(second.db.query("SELECT location_kind, backend_session_id FROM cowork_conversations").all()).toEqual([{ location_kind: "source", backend_session_id: null }]);
  expect(second.db.query("SELECT session_id FROM cowork_output_locations").all()).toEqual([{ session_id: "s_bound" }]);
  expect(second.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(second.integrity().ok).toBe(true);
  expect(second.db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='cowork_conversations_workspace'").get()).not.toBeNull();
  // The renamed table reads back with the same columns and constraints as a fresh one (quoting aside).
  const normalized = (sql: string) => sql.replace(/^CREATE TABLE "?cowork_conversations(?:_v18)?"?/, "CREATE TABLE cowork_conversations");
  expect(normalized(tableSql(second.db))).toBe(normalized(freshSql));
  expect(new CoworkRepository(second).binding("s_bound")).toMatchObject({ sessionId: "s_bound", workspaceId, sourceId, relativeCwd: "repo/sub" });
});

/** What SQLite itself reports about a table's foreign keys (independent of how the DDL is spelled). */
const foreignKeys = (db: Database) => db.query<{ id: number; seq: number; table: string; from: string; to: string }, []>("SELECT id, seq, \"table\", \"from\", \"to\" FROM pragma_foreign_key_list('cowork_conversations') ORDER BY \"table\", seq").all()
  .map(({ table, from, to, seq }) => ({ table, from, to, seq }));
/** Each `CHECK(...)` clause of a DDL text, whitespace-normalised. */
const checksOf = (sql: string) => [...sql.matchAll(/CHECK\((?:[^()]|\([^()]*\))*\)/g)].map(match => match[0].replace(/\s+/g, " "));

test("the rebuild keeps EVERY v17 constraint, judged against the v17 text itself: its foreign keys and CHECKs exist and refuse, fresh and upgraded", () => {
  const v17 = new Database(":memory:"); v17.exec(V17_TABLE);
  const v17Keys = foreignKeys(v17), v17Checks = checksOf(V17_TABLE); v17.close();
  expect(v17Keys).toEqual([
    { table: "cowork_projects", from: "project_id", to: "project_id", seq: 0 },
    { table: "cowork_sources", from: "workspace_id", to: "workspace_id", seq: 0 },
    { table: "cowork_sources", from: "source_id", to: "source_id", seq: 1 },
    { table: "cowork_workspaces", from: "workspace_id", to: "workspace_id", seq: 0 },
  ]);
  expect(v17Checks).toHaveLength(3); // policy, revision, state

  const fresh = openDb(tempHome()), freshFixture = bound(fresh, "s_fresh");
  const upgradedHome = tempHome(), first = openDb(upgradedHome), upgradedFixture = bound(first, "s_upgraded");
  rewindToV17(first); first.close();
  const upgraded = openDb(upgradedHome);
  expect(upgraded.schemaVersion()).toBe(21);
  for (const [label, db, { workspaceId, sourceId }] of [["fresh", fresh, freshFixture], ["upgraded", upgraded, upgradedFixture]] as const) {
    expect([label, foreignKeys(db.db)]).toEqual([label, v17Keys]);
    const sql = tableSql(db.db).replace(/\s+/g, " ");
    for (const check of v17Checks) expect([label, check, sql.includes(check)]).toEqual([label, check, true]);
    const insert = (sessionId: string, over: Partial<Record<"workspace" | "source" | "policy" | "state" | "revision", unknown>> = {}) => db.db.run(
      "INSERT INTO cowork_conversations(session_id,workspace_id,project_id,location_kind,source_id,relative_cwd,policy,restrictions_json,revision,state,created_at) VALUES(?,?,NULL,'source',?,'.',?,'{}',?,?,'t')",
      [sessionId, (over.workspace ?? workspaceId) as string, (over.source ?? sourceId) as string, (over.policy ?? "ask") as string, (over.revision ?? 1) as number, (over.state ?? "active") as string]);
    const outcome = (run: () => unknown) => { try { run(); return "accepted"; } catch (error) { return /constraint/i.test(String(error)) ? "refused" : String(error); } };
    expect([label, outcome(() => insert(`s_ok_${label}`))]).toEqual([label, "accepted"]);
    for (const [name, over] of [
      ["a bad policy", { policy: "yolo" }], ["a bad state", { state: "gone" }], ["a zero revision", { revision: 0 }],
      ["a dangling source", { source: "source_missing" }], ["a dangling workspace", { workspace: "workspace_missing" }],
    ] as const) expect([label, name, outcome(() => insert(`s_${name.replace(/\W/g, "_")}_${label}`, over))]).toEqual([label, name, "refused"]);
    expect(db.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  }
});

test("idempotent: rewinding user_version to 17 and reopening, or calling the migration again, changes nothing", () => {
  const home = tempHome(), first = openDb(home);
  bound(first);
  first.db.run("UPDATE cowork_conversations SET backend_session_id='backend-one' WHERE session_id='s_bound'");
  const before = { sql: tableSql(first.db), rows: first.db.query("SELECT * FROM cowork_conversations").all() };
  migrateCoworkSessionBindingSchema(first.db);
  expect({ sql: tableSql(first.db), rows: first.db.query("SELECT * FROM cowork_conversations").all() }).toEqual(before);
  first.db.run("PRAGMA user_version=17"); first.close();
  const second = openDb(home);
  expect(second.schemaVersion()).toBe(21);
  expect({ sql: tableSql(second.db), rows: second.db.query("SELECT * FROM cowork_conversations").all() }).toEqual(before);
});

test("the downgrade ladder: an empty current store rolls back to 7 and to 6 and upgrades again; a bound conversation refuses both", () => {
  const empty = tempHome();
  openDb(empty).close();
  expect(userVersion(empty)).toBe(21);
  expect(downgradeCoworkRuntimeStateToV7(empty)).toEqual({ from: 21, to: 7 });
  let db = openDb(empty); expect(db.schemaVersion()).toBe(21); expect(columns(db.db).map(column => column.name)).toEqual(V18_COLUMNS); db.close();
  expect(downgradeRuntimeStateToV6(empty)).toEqual({ from: 21, to: 6 });
  db = openDb(empty); expect(db.schemaVersion()).toBe(21); db.close();

  const populated = tempHome(), withRow = openDb(populated); bound(withRow); withRow.close();
  expect(() => downgradeCoworkRuntimeStateToV7(populated)).toThrow("Cowork authority");
  expect(() => downgradeRuntimeStateToV6(populated)).toThrow("Cowork authority");
  expect(userVersion(populated)).toBe(21);

  const newer = tempHome(); openDb(newer).close();
  const raw = new Database(rawPath(newer)); raw.run("PRAGMA user_version=22"); raw.close();
  expect(() => downgradeCoworkRuntimeStateToV7(newer)).toThrow("newer-schema");
  expect(() => downgradeRuntimeStateToV6(newer)).toThrow("newer-schema");
});

// ---------------------------------------------------------------------------------------------------- cowork_home_binding (S7B)
const BINDING_COLUMNS = ["singleton", "home_id", "canonical_path", "volume_id", "directory_id", "origin_machine_id", "origin_installation_id", "created_at"];
const bindingColumns = (db: Database) => db.query<{ name: string; notnull: number; pk: number }, []>("PRAGMA table_info(cowork_home_binding)").all();
const insertBinding = (db: Database, homeId: string, singleton = 1) => db.run(
  "INSERT INTO cowork_home_binding(singleton,home_id,canonical_path,volume_id,directory_id,origin_machine_id,origin_installation_id,created_at) VALUES(?,?,'/fixture/home','vol-1','dir-1','machine-1','install-1','t')", [singleton, homeId]);

test("migration 18 creates S7B's cowork_home_binding: a singleton, every column required, bound to the home identity", () => {
  const db = openDb(tempHome());
  expect(bindingColumns(db.db).map(column => column.name)).toEqual(BINDING_COLUMNS);
  expect(bindingColumns(db.db).filter(column => column.name !== "singleton").every(column => column.notnull === 1)).toBe(true);
  expect(bindingColumns(db.db).find(column => column.pk === 1)?.name).toBe("singleton");
  expect(db.db.query("SELECT \"table\", \"from\", \"to\" FROM pragma_foreign_key_list('cowork_home_binding')").all()).toEqual([{ table: "cowork_home_identity", from: "home_id", to: "home_id" }]);
  const homeId = new CoworkRepository(db).homeIdentity();
  expect(() => insertBinding(db.db, "home-unknown")).toThrow(); // no such home identity
  expect(() => insertBinding(db.db, homeId, 2)).toThrow(); // only the singleton row
  insertBinding(db.db, homeId);
  expect(() => insertBinding(db.db, homeId)).toThrow(); // written once
  // ...and never rewritten or removed: the schema's own triggers abort both.
  expect(() => db.db.run("UPDATE cowork_home_binding SET canonical_path='/elsewhere'")).toThrow("written once");
  expect(() => db.db.run("UPDATE cowork_home_binding SET created_at=created_at")).toThrow("written once");
  expect(() => db.db.run("DELETE FROM cowork_home_binding")).toThrow("written once");
  expect(() => db.db.run("INSERT OR REPLACE INTO cowork_home_binding(singleton,home_id,canonical_path,volume_id,directory_id,origin_machine_id,origin_installation_id,created_at) VALUES(1,?,'/x','v','d','m','i','t')", [homeId])).toThrow();
  expect(db.db.query("SELECT canonical_path FROM cowork_home_binding").get()).toEqual({ canonical_path: "/fixture/home" });
  expect(db.db.query("SELECT count(*) AS n FROM cowork_home_binding").get()).toEqual({ n: 1 });
  expect(db.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("cowork_home_binding is Cowork authority: listed before the identity it references, a populated binding refuses both downgrades, an empty one rolls back", () => {
  expect(COWORK_TABLES).toContain("cowork_home_binding");
  expect(COWORK_TABLES.indexOf("cowork_home_binding")).toBeLessThan(COWORK_TABLES.indexOf("cowork_home_identity")); // drop order: child first
  const populated = tempHome(), db = openDb(populated);
  insertBinding(db.db, new CoworkRepository(db).homeIdentity()); db.close();
  expect(() => downgradeCoworkRuntimeStateToV7(populated)).toThrow("Cowork authority");
  expect(() => downgradeRuntimeStateToV6(populated)).toThrow("Cowork authority");
  const raw = new Database(rawPath(populated), { readonly: true });
  try { expect(raw.query("SELECT count(*) AS n FROM cowork_home_binding").get()).toEqual({ n: 1 }); } finally { raw.close(); }
  const empty = tempHome(); openDb(empty).close();
  expect(downgradeCoworkRuntimeStateToV7(empty)).toEqual({ from: 21, to: 7 });
  const rolled = new Database(rawPath(empty), { readonly: true });
  try { expect(rolled.query("SELECT name FROM sqlite_master WHERE name='cowork_home_binding'").get()).toBeNull(); } finally { rolled.close(); }
  const again = openDb(empty); expect(bindingColumns(again.db).map(column => column.name)).toEqual(BINDING_COLUMNS);
});

test("a v17 store gains the table on upgrade, and a recorded binding survives a rewound replay unchanged", () => {
  const home = tempHome(), first = openDb(home);
  rewindToV17(first);
  expect(first.db.query("SELECT name FROM sqlite_master WHERE name='cowork_home_binding'").get()).toBeNull();
  first.close();
  const second = openDb(home);
  expect(second.schemaVersion()).toBe(21);
  expect(bindingColumns(second.db).map(column => column.name)).toEqual(BINDING_COLUMNS);
  insertBinding(second.db, new CoworkRepository(second).homeIdentity());
  const before = second.db.query("SELECT * FROM cowork_home_binding").all();
  second.db.run("PRAGMA user_version=17"); second.close();
  const third = openDb(home);
  expect(third.db.query("SELECT * FROM cowork_home_binding").all()).toEqual(before);
});
