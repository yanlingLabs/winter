/*
 * The database half of a bundle's content binding: what `cowork_exports` holds about a generation's bundle so that a restore
 * can refuse one that was rewritten and re-indexed, and can map the bundle's opaque output ids back to session folders.
 *
 * It needs migration 20 (DOOR's), which adds one nullable column and one table:
 *
 *   ALTER TABLE cowork_exports ADD COLUMN content_digest TEXT CHECK (content_digest IS NULL OR (length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'));
 *   CREATE TABLE cowork_export_output_ids (
 *     export_id TEXT NOT NULL REFERENCES cowork_exports(export_id),
 *     opaque_id TEXT NOT NULL CHECK (length(opaque_id) = 17 AND opaque_id GLOB 's*' AND substr(opaque_id, 2) NOT GLOB '*[^0-9a-f]*'),
 *     session_id TEXT NOT NULL,
 *     PRIMARY KEY (export_id, opaque_id), UNIQUE (export_id, session_id));
 *
 * Nothing constructs this class in production: the restorer is unbuildable without a binding, and the binding is unbuildable
 * until the migration exists.
 */
import type { RuntimeStateDb } from "../runtime-state/db";
import { durableCoworkTransaction } from "./durable-transaction";
import { OPAQUE_OUTPUT_ID } from "./export-bundle";
import type { CoworkExportContentBinding } from "./export-writer";
import { HEX64, lifecycleFail, lifecycleId } from "./storage-lifecycle";

type Row = Record<string, string | null>;
export class SqliteExportContentBinding implements CoworkExportContentBinding {
  constructor(private readonly rs: RuntimeStateDb) {}

  /** Once per generation, while it is `prepared`: a second record, or a record for a completed or failed row, refuses. */
  record(exportId: string, binding: { readonly contentDigest: string; readonly outputIds: Readonly<Record<string, string>> }): void {
    const id = lifecycleId(exportId);
    if (typeof binding?.contentDigest !== "string" || !HEX64.test(binding.contentDigest)) return lifecycleFail("invalid_request");
    const entries = Object.entries(binding.outputIds ?? {});
    for (const [opaque, session] of entries) if (!OPAQUE_OUTPUT_ID.test(opaque) || typeof session !== "string" || session.length === 0 || session.length > 4096) return lifecycleFail("invalid_request");
    if (new Set(entries.map(([, session]) => session)).size !== entries.length) return lifecycleFail("invalid_request");
    durableCoworkTransaction(this.rs, () => {
      const changed = this.rs.db.run("UPDATE cowork_exports SET content_digest=? WHERE export_id=? AND state='prepared' AND content_digest IS NULL", [binding.contentDigest, id]).changes;
      if (changed !== 1) return lifecycleFail("invalid_request");
      for (const [opaque, session] of entries) this.rs.db.run("INSERT INTO cowork_export_output_ids(export_id,opaque_id,session_id) VALUES(?,?,?)", [id, opaque, session]);
    });
  }

  /** The binding of a generation, or null while none was recorded (the column is NULL, or there is no such row). */
  read(exportId: string): { readonly contentDigest: string; readonly outputIds: Readonly<Record<string, string>> } | null {
    const row = this.rs.db.query<Row, [string]>("SELECT content_digest FROM cowork_exports WHERE export_id=?").get(lifecycleId(exportId));
    const digest = row?.content_digest;
    if (typeof digest !== "string" || !HEX64.test(digest)) return null;
    const outputIds: Record<string, string> = {};
    for (const entry of this.rs.db.query<Row, [string]>("SELECT opaque_id,session_id FROM cowork_export_output_ids WHERE export_id=?").all(exportId)) outputIds[entry.opaque_id!] = entry.session_id!;
    return { contentDigest: digest, outputIds };
  }
}
