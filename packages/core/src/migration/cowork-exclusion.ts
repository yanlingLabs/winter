// Cowork storage is never an input to Migration B. docs/cowork-execution-contracts.md, "Host storage
// authority, fences and migration": the Cowork tree and its canonical database may move only through a
// coordinated, quiescent migration of both homes, and a blanket filename skip (`index.db`, `*.db-wal`,
// `*.db-shm`) is not a consistent database backup. That coordinated migration does not exist in this
// build, so the plain copy REFUSES, visibly, instead of copying a split-brain home: volumes without
// their records, or records (including the home identity) duplicated into a second home. Nothing here
// writes to the source home: the runtime-state database is inspected through a private temporary copy.
import { Database } from "bun:sqlite";
import { copyFileSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { COWORK_TABLES } from "../cowork/schema";

/** Home-relative root of every Cowork backing, control and shared-file tree. */
export const COWORK_HOME_ROOT = "cowork";

/** `rel` is slash-separated and relative to a home. The root itself and everything beneath it. */
export function isCoworkStorageRel(rel: string): boolean {
  return rel === COWORK_HOME_ROOT || rel.startsWith(`${COWORK_HOME_ROOT}/`);
}

/** Where does `p` really live? A lexical `cowork/` prefix check is bypassed by a symlinked parent
 * (`home/innocent` -> `home/cowork/workspaces/ws`) and, on a case-insensitive volume, by a different
 * spelling (`home/COWORK/...`), and `..` after a symlinked parent lands elsewhere than its lexical form. This
 * resolves the deepest existing ancestor through the filesystem (the path itself may not exist yet), walks `..`
 * with kernel semantics, and compares the first segment under the resolved home, case-insensitively. It
 * is deliberately over-inclusive on a case-sensitive volume (a `Cowork/` directory counts): a guard that
 * refuses or keeps is the safe direction. Keep `isCoworkStorageRel` as the cheap first check. */
export function resolvesIntoCoworkStorage(home: string, p: string): boolean {
  const resolve = (q: string): string => {
    // `..` after a symlinked parent: the kernel applies it to the symlink's TARGET (`innocent/../ws2` with
    // `innocent` -> `cowork/workspaces/ws` is `cowork/workspaces/ws2`), but `realpath` here collapses `..`
    // lexically first (`<home>/ws2`). So walk the components with kernel semantics instead of trusting it.
    if (q.split(sep).includes("..")) {
      let at = isAbsolute(q) ? sep : process.cwd();
      for (const part of q.split(sep)) {
        if (part === "" || part === ".") continue;
        if (part === "..") { at = dirname(at); continue; }
        const next = join(at, part);
        try { at = realpathSync.native(next); } catch { at = next; }
      }
      return at;
    }
    const tail: string[] = []; let cur = q;
    for (;;) {
      try { return join(realpathSync.native(cur), ...tail.reverse()); }
      catch { const up = dirname(cur); if (up === cur) return q; tail.push(basename(cur)); cur = up; }
    }
  };
  return relative(resolve(home), resolve(p)).split(sep)[0]?.toLowerCase() === COWORK_HOME_ROOT;
}

export type CoworkSourceFinding =
  | { present: false }
  | { present: true; kind: "storage-tree" | "authority-records" | "uninspectable"; detail: string };

const errno = (error: unknown): string => (error as NodeJS.ErrnoException | undefined)?.code ?? (error as Error | undefined)?.name ?? "error";

const isOsLitter = (name: string): boolean => name === ".DS_Store" || name === ".localized" || name.startsWith("._");

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
    // OS litter (Finder and AppleDouble files) is written by the system into any folder the user has looked at; it carries no
    // workspace data, so a `cowork/` holding only litter is not Cowork storage. Anything else, however small, still counts.
    const first = readdirSync(root).filter(name => !isOsLitter(name)).sort()[0];
    return first === undefined ? { present: false } : { present: true, kind: "storage-tree", detail: `${COWORK_HOME_ROOT}/${first}` };
  } catch (error) { return { present: true, kind: "uninspectable", detail: `${COWORK_HOME_ROOT}/ (${errno(error)})` }; }
}

/** A readonly connection cannot open a WAL database that has no sidecars, and opening one in place
 * could create sidecars in the source. Inspect a private copy (main file plus any WAL/SHM) instead. */
function inspectAuthority(home: string, removeScratch: (path: string) => void): CoworkSourceFinding {
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
    // The finding is already decided; a cleanup failure must never turn it into a throw (the boot hook calls this).
    if (scratch !== undefined) { try { removeScratch(scratch); } catch { /* a temp directory is left behind, nothing more */ } }
  }
}

/** Fail closed: a tree, a populated Cowork table, or anything that cannot be inspected is "present".
 * `io.removeScratch` is a test seam for the temp-copy cleanup; production always removes the directory. */
export function inspectCoworkSource(home: string, io: { removeScratch?: (path: string) => void } = {}): CoworkSourceFinding {
  const tree = inspectTree(home);
  return tree.present ? tree : inspectAuthority(home, io.removeScratch ?? ((path) => rmSync(path, { recursive: true, force: true })));
}
