import { Buffer } from "node:buffer";
import { CoworkRepository } from "./repository";
import { CoworkError, type WorkspaceSource } from "./types";

export interface StoredFolderGrant {
  grantRef: string;
  selectionId: string;
  principalId: string;
  homeId: string;
  workspaceId: string;
  sourceId: string;
  rootIdentity: string;
  path: string;
  identity: string;
  bookmark: Buffer;
  access: "read-only" | "read-write";
}
/** Protected runtime-state DB only. Native preflight stays outside transactions; binding and
 * source narrowing share the repository's exact transaction and idempotency boundary. */
export class CoworkFolderGrants {
  constructor(readonly records: CoworkRepository, readonly limit = 4096) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4096) throw new CoworkError("invalid_request");
  }
  private query(sql: string, ...values: any[]): any { return this.records.rs.db.query(sql).get(...values); }
  bind(source: WorkspaceSource, principalId: string, selectionId: string, value: { bookmark: Buffer; path: string; identity: string; rootIdentity: string; grantRef: string; access: string }): void {
    if (!this.records.rs.db.inTransaction || source.kind !== "folder" || source.detail.grantRef !== value.grantRef
      || source.detail.rootIdentity !== value.rootIdentity || source.access !== value.access
      || value.bookmark.length < 1 || value.bookmark.length > 65536) throw new CoworkError("authority_denied");
    if (this.query("SELECT 1 FROM cowork_folder_grants WHERE selection_id=? OR grant_ref=?", selectionId, value.grantRef)) throw new CoworkError("authority_denied");
    // Tombstones count too: never evict a consumed selection into becoming reusable authority.
    if (this.query("SELECT count(*) AS count FROM cowork_folder_grants").count >= this.limit) throw new CoworkError("authority_denied");
    const match = /^([0-9]{1,30}):([0-9]{1,30})$/.exec(value.identity);
    if (!match || !value.path.startsWith("/") || value.path.length > 4096 || value.path.includes("\0")) throw new CoworkError("authority_denied");
    const device = match[1]!, inode = match[2]!;
    if (this.query("SELECT 1 FROM cowork_folder_grants WHERE workspace_id=? AND root_device=? AND root_inode=? AND state='active'", source.workspaceId, device, inode)) throw new CoworkError("authority_denied");
    const homeId = this.records.homeIdentity(), at = new Date().toISOString();
    this.records.rs.db.run(`INSERT INTO cowork_folder_grants(
      grant_ref,home_id,workspace_id,source_id,principal_id,selection_id,root_identity,
      root_device,root_inode,root_path,access,bookmark,state,revision,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'active',1,?,?)`,
    [value.grantRef, homeId, source.workspaceId, source.sourceId, principalId, selectionId, value.rootIdentity,
      device, inode, value.path, value.access, value.bookmark, at, at]);
  }
  get(grantRef: string): StoredFolderGrant | undefined {
    const row = this.query(`SELECT g.*,s.kind,s.detail_json,s.desired,s.state AS source_state,s.trust,
      s.access AS source_access,w.state AS workspace_state,h.home_id AS current_home
      FROM cowork_folder_grants g
      JOIN cowork_sources s ON s.source_id=g.source_id AND s.workspace_id=g.workspace_id
      JOIN cowork_workspaces w ON w.workspace_id=g.workspace_id
      JOIN cowork_home_identity h ON h.singleton=1 WHERE g.grant_ref=?`, grantRef);
    if (!row || row.state !== "active" || row.home_id !== row.current_home || row.kind !== "folder"
      || row.desired !== "present" || row.trust === "revoked" || ["removing", "detached"].includes(row.source_state)
      || ["deleting", "deleted"].includes(row.workspace_state) || row.source_access !== row.access) return undefined;
    let detail;
    try { detail = JSON.parse(row.detail_json); } catch { return undefined; }
    if (!detail || typeof detail !== "object" || detail.grantRef !== row.grant_ref || detail.rootIdentity !== row.root_identity
      || !(row.bookmark instanceof Uint8Array) || row.bookmark.length < 1 || row.bookmark.length > 65536
      || typeof row.root_path !== "string" || !row.root_path.startsWith("/") || row.root_path.length > 4096 || row.root_path.includes("\0")
      || !/^[0-9]{1,30}$/.test(row.root_device) || !/^[0-9]{1,30}$/.test(row.root_inode)
      || !["read-only", "read-write"].includes(row.access)) return undefined;
    return {
      grantRef: row.grant_ref, selectionId: row.selection_id, principalId: row.principal_id, homeId: row.home_id,
      workspaceId: row.workspace_id, sourceId: row.source_id, rootIdentity: row.root_identity, path: row.root_path,
      identity: `${row.root_device}:${row.root_inode}`, bookmark: Buffer.from(row.bookmark), access: row.access,
    };
  }
  consumed(selectionId: string): boolean {
    return !!this.query("SELECT 1 FROM cowork_folder_grants WHERE selection_id=?", selectionId);
  }
  invalidate(grant: StoredFolderGrant): void {
    // Current source narrowing, grant tombstone and durable fanout use the same authoritative DB.
    const source = this.records.source(grant.workspaceId, grant.sourceId), workspace = this.records.get(grant.workspaceId);
    if (source.trust !== "revoked" && workspace.state !== "deleted") {
      this.records.removeSource({ principalId: "host-folder-grant", requestId: `invalidate-${grant.grantRef}`, expectedRevision: workspace.configRevision }, grant.workspaceId, grant.sourceId, true);
    }
  }
}
