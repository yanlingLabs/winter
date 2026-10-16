// Cowork storage is never an input to Migration B. docs/cowork-execution-contracts.md, "Host storage
// authority, fences and migration": the Cowork tree and its canonical database may move only through a
// coordinated, quiescent migration of both homes, and a blanket filename skip (`index.db`, `*.db-wal`,
// `*.db-shm`) is not a consistent database backup. That coordinated migration does not exist in this
// build, so the plain copy REFUSES, visibly, instead of copying a split-brain home: volumes without
// their records, or records (including the home identity) duplicated into a second home. Nothing here
// writes to the source home: the runtime-state database is inspected through a private temporary copy.
import { Database } from "bun:sqlite";
import { copyFileSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COWORK_TABLES } from "../cowork/schema";

/** Home-relative root of every Cowork backing, control and shared-file tree. */
export const COWORK_HOME_ROOT = "cowork";

/** `rel` is slash-separated and relative to a home. The root itself and everything beneath it. */
export function isCoworkStorageRel(rel: string): boolean {
  return rel === COWORK_HOME_ROOT || rel.startsWith(`${COWORK_HOME_ROOT}/`);
}

export type CoworkSourceFinding =
  | { present: false }
  | { present: true; kind: "storage-tree" | "authority-records" | "uninspectable"; detail: string };

const errno = (error: unknown): string => (error as NodeJS.ErrnoException | undefined)?.code ?? (error as Error | undefined)?.name ?? "error";

/** Any entry at all beneath `cowork/` (even an empty directory) counts: a workspace directory is the
 * first thing storage creates, and this check must not depend on recognising what is inside it. */
function inspectTree(home: string): CoworkSourceFinding {
  const root = join(home, COWORK_HOME_ROOT);
  let stat;
  try { stat = lstatSync(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { present: false };
    return { present: true, kind: "uninspectable", detail: `${COWORK_HOME_ROOT}/ (${errno(error)})` };
  }
  if (!stat.isDirectory()) return { present: true, kind: "storage-tree", detail: `${COWORK_HOME_ROOT} is not a plain directory` };
  try {
    const first = readdirSync(root).sort()[0];
    return first === undefined ? { present: false } : { present: true, kind: "storage-tree", detail: `${COWORK_HOME_ROOT}/${first}` };
  } catch (error) { return { present: true, kind: "uninspectable", detail: `${COWORK_HOME_ROOT}/ (${errno(error)})` }; }
}

/** A readonly connection cannot open a WAL database that has no sidecars, and opening one in place
 * could create sidecars in the source. Inspect a private copy (main file plus any WAL/SHM) instead. */
function inspectAuthority(home: string): CoworkSourceFinding {
  const source = join(home, "runtimes", "runtime-state.db");
  try {
    if (!lstatSync(source).isFile()) return { present: true, kind: "uninspectable", detail: "runtimes/runtime-state.db is not a regular file" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { present: false };
    return { present: true, kind: "uninspectable", detail: `runtimes/runtime-state.db (${errno(error)})` };
  }
  let scratch: string | undefined;
  let db: Database | undefined;
  try {
    scratch = mkdtempSync(join(tmpdir(), "winter-cowork-inspect-"));
    copyFileSync(source, join(scratch, "runtime-state.db"));
    for (const suffix of ["-wal", "-shm"]) {
      try { copyFileSync(`${source}${suffix}`, join(scratch, `runtime-state.db${suffix}`)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    db = new Database(join(scratch, "runtime-state.db"));
    const tables = new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    for (const table of COWORK_TABLES) {
      if (tables.has(table) && db.query(`SELECT 1 FROM ${table} LIMIT 1`).get()) return { present: true, kind: "authority-records", detail: `runtimes/runtime-state.db holds ${table} records` };
    }
    return { present: false };
  } catch (error) {
    return { present: true, kind: "uninspectable", detail: `runtimes/runtime-state.db could not be inspected (${errno(error)})` };
  } finally {
    try { db?.close(); } catch { /* the copy is discarded below */ }
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  }
}

/** Fail closed: a tree, a populated Cowork table, or anything that cannot be inspected is "present". */
export function inspectCoworkSource(home: string): CoworkSourceFinding {
  const tree = inspectTree(home);
  return tree.present ? tree : inspectAuthority(home);
}
