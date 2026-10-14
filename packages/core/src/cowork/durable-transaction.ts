import type { RuntimeStateDb } from "../runtime-state/db";
import { CoworkError } from "./types";

type Setting = "synchronous" | "fullfsync" | "checkpoint_fullfsync";
function settings(rs: RuntimeStateDb) {
  const read = (name: Setting): number => {
    const value = rs.db.query<Record<string, number>, []>(`PRAGMA main.${name}`).get()?.[name];
    if (!Number.isSafeInteger(value)) throw new CoworkError("recovery_required");
    return value!;
  };
  return { synchronous: read("synchronous"), fullfsync: read("fullfsync"), checkpoint_fullfsync: read("checkpoint_fullfsync") };
}

/** Scoped canonical Cowork write durability. Ordinary Code's connection settings
 * are restored before returning; no async work or nested caller transaction.
 * WAL FULL adds commit sync; Darwin fullfsync asks SQLite's VFS for F_FULLFSYNC.
 * A read-back confirms configuration, not that a storage device honored it.
 * https://www.sqlite.org/pragma.html#pragma_synchronous
 * https://www.sqlite.org/pragma.html#pragma_fullfsync */
export function durableCoworkTransaction<T>(rs: RuntimeStateDb, body: () => T): T {
  if (rs.db.inTransaction) throw new CoworkError("authority_denied");
  const previous = settings(rs);
  if (previous.synchronous < 0 || previous.synchronous > 3 || ![0, 1].includes(previous.fullfsync) || ![0, 1].includes(previous.checkpoint_fullfsync)) throw new CoworkError("recovery_required");
  try {
    rs.db.run("PRAGMA main.synchronous = FULL");
    rs.db.run("PRAGMA main.fullfsync = ON");
    rs.db.run("PRAGMA main.checkpoint_fullfsync = ON");
    const current = settings(rs);
    if (current.synchronous !== 2 || current.fullfsync !== 1 || current.checkpoint_fullfsync !== 1) throw new CoworkError("recovery_required");
    return rs.transaction(() => {
      const result = body();
      if (result !== null && (typeof result === "object" || typeof result === "function") && typeof (result as { then?: unknown }).then === "function") throw new CoworkError("authority_denied");
      return result;
    }, { mode: "immediate" });
  } finally {
    // Only previously validated internal integers enter SQL, never user text.
    rs.db.run(`PRAGMA main.synchronous = ${previous.synchronous}`);
    rs.db.run(`PRAGMA main.fullfsync = ${previous.fullfsync}`);
    rs.db.run(`PRAGMA main.checkpoint_fullfsync = ${previous.checkpoint_fullfsync}`);
    const restored = settings(rs);
    if (JSON.stringify(restored) !== JSON.stringify(previous)) throw new CoworkError("recovery_required");
  }
}
