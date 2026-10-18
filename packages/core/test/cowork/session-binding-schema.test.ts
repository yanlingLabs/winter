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
import { migrateCoworkSessionBindingSchema } from "../../src/cowork/schema";
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

const V18_COLUMNS = ["session_id", "workspace_id", "project_id", "location_kind", "source_id", "relative_cwd", "policy", "restrictions_json", "revision", "state", "created_at", "backend_session_id"];
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
    CREATE INDEX IF NOT EXISTS cowork_conversations_workspace ON cowork_conversations(workspace_id);
    PRAGMA user_version=17;`);
  db.db.run("PRAGMA foreign_keys=ON");
}

test("schema 18 is current, and a fresh store has the binding columns in order with their defaults", () => {
  expect(RUNTIME_STATE_SCHEMA_VERSION).toBe(18);
  const db = openDb(tempHome());
  expect(db.schemaVersion()).toBe(18);
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
  expect(second.schemaVersion()).toBe(18);
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

test("idempotent: rewinding user_version to 17 and reopening, or calling the migration again, changes nothing", () => {
  const home = tempHome(), first = openDb(home);
  bound(first);
  first.db.run("UPDATE cowork_conversations SET backend_session_id='backend-one' WHERE session_id='s_bound'");
  const before = { sql: tableSql(first.db), rows: first.db.query("SELECT * FROM cowork_conversations").all() };
  migrateCoworkSessionBindingSchema(first.db);
  expect({ sql: tableSql(first.db), rows: first.db.query("SELECT * FROM cowork_conversations").all() }).toEqual(before);
  first.db.run("PRAGMA user_version=17"); first.close();
  const second = openDb(home);
  expect(second.schemaVersion()).toBe(18);
  expect({ sql: tableSql(second.db), rows: second.db.query("SELECT * FROM cowork_conversations").all() }).toEqual(before);
});

test("the downgrade ladder: an empty v18 store rolls back to 7 and to 6 and upgrades again; a bound conversation refuses both", () => {
  const empty = tempHome();
  openDb(empty).close();
  expect(userVersion(empty)).toBe(18);
  expect(downgradeCoworkRuntimeStateToV7(empty)).toEqual({ from: 18, to: 7 });
  let db = openDb(empty); expect(db.schemaVersion()).toBe(18); expect(columns(db.db).map(column => column.name)).toEqual(V18_COLUMNS); db.close();
  expect(downgradeRuntimeStateToV6(empty)).toEqual({ from: 18, to: 6 });
  db = openDb(empty); expect(db.schemaVersion()).toBe(18); db.close();

  const populated = tempHome(), withRow = openDb(populated); bound(withRow); withRow.close();
  expect(() => downgradeCoworkRuntimeStateToV7(populated)).toThrow("Cowork authority");
  expect(() => downgradeRuntimeStateToV6(populated)).toThrow("Cowork authority");
  expect(userVersion(populated)).toBe(18);

  const newer = tempHome(); openDb(newer).close();
  const raw = new Database(rawPath(newer)); raw.run("PRAGMA user_version=19"); raw.close();
  expect(() => downgradeCoworkRuntimeStateToV7(newer)).toThrow("newer-schema");
  expect(() => downgradeRuntimeStateToV6(newer)).toThrow("newer-schema");
});
