// Host-side records of a workspace export. This module is the RECORD half only: it decides whether an
// export of a stopped workspace may be taken, mints and records one export generation with its manifest
// descriptor, and validates a presented descriptor against canonical host state before any restore could
// use it. It copies no image and no shared file, takes no snapshot, adds no RPC and starts no restore:
// those parts have no concrete format or mechanism in the docs yet (see the PR's decisions list).
//
// Document sentences followed:
//  - cowork-execution-contracts.md, "Host storage authority, fences and migration": "Explicit exports require a
//    consistent quiescent generation and disclose that exported images are plaintext."; "Provide a
//    consistent export of stopped/checkpointed volumes plus manifest, shared-file snapshot and required
//    image/runtime digests, bound to one recorded export generation".
//  - cowork-host-protocol.md: `manifest.json` "stores only owned relative backing locations, format versions,
//    digests and checkpoint/export descriptors. Authority remains in the DB. Imports are recovery inputs
//    requiring validation and current user authorization, never a route to reconstruct permissions from
//    JSON. Distinguish relocation/ownership transfer from making a second clone: copied IDs must not permit
//    two owners to attach the same workspace."; "user-facing exports omit the raw authority DB, bookmarks and
//    unrelated records."
//  - cowork-execution-contracts.md: "Validate it against the host database and owned storage roots before
//    attaching anything; a mismatch is recovery-required."
//  - cowork-storage-security.md: "Unknown formats refuse."
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { RuntimeStateDb } from "../runtime-state/db";
import { durableCoworkTransaction } from "./durable-transaction";
import { canonicalJson, lifecycleFail, lifecycleId, sha256Hex, assertAtRest, readWorkspaceFacts, type CoworkLifecycleAuthority, type LifecycleAction, type WorkspaceFacts } from "./storage-lifecycle";

export const EXPORT_MANIFEST_MAX_BYTES = 64 * 1024;
export const EXPORT_PLAINTEXT_DISCLOSURE = "Exported disk images are plaintext raw ext4 volumes. Winter does not encrypt them: anyone who can read the exported files can read the workspace's files.";

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const FILES = { data: "data.ext4", environment: "env.ext4" } as const;
const Volume = z.object({
  volumeId: Id, creationId: Id, purpose: z.enum(["data", "environment"]),
  format: z.literal("raw-ext4-v1"), formatVersion: z.literal(1), relativePath: z.enum(["data.ext4", "env.ext4"]),
  capacityBytes: z.number().int().min(16 * 1024 ** 2).max(256 * 1024 ** 3).refine(n => n % 4096 === 0),
  filesystemUuid: Uuid,
}).strict();
/** Closed on purpose. No grants, policies, sources, bookmarks, credentials, titles, session ids or
 * host file identity (device/inode are host-local and are re-recorded by recovery, never carried).
 * A field added later is a new `formatVersion`; this version refuses any extra key. */
export const CoworkExportManifest = z.object({
  formatVersion: z.literal(1),
  kind: z.literal("cowork-workspace-export"),
  plaintextImages: z.literal(true),
  homeId: Id,
  workspace: z.object({ workspaceId: Id, ownership: z.enum(["standalone", "project"]) }).strict(),
  generation: z.object({ exportId: Id, number: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), preparedAt: z.string().max(40) }).strict(),
  images: z.object({ baseImageDigest: Digest, runtimeImageDigest: Digest }).strict(),
  volumes: z.array(Volume).length(2),
}).strict().refine(m => m.volumes.map(v => v.purpose).sort().join() === "data,environment" && m.volumes.every(v => v.relativePath === FILES[v.purpose]), { message: "volumes" });
export type CoworkExportManifest = z.infer<typeof CoworkExportManifest>;

export interface CoworkExportRecord { exportId: string; workspaceId: string; generation: number; state: "prepared" | "complete" | "failed"; manifestDigest: string; createdAt: string; updatedAt: string }
export interface PreparedExport { exportId: string; generation: number; manifest: CoworkExportManifest; manifestJson: string; manifestDigest: string; disclosure: string }
export interface ValidatedImport { exportId: string; generation: number; latest: boolean }
type Row = Record<string, any>;

function record(row: Row): CoworkExportRecord {
  if (!["prepared", "complete", "failed"].includes(row.state)) return lifecycleFail("recovery_required");
  return { exportId: row.export_id, workspaceId: row.workspace_id, generation: row.generation, state: row.state, manifestDigest: row.manifest_digest, createdAt: row.created_at, updatedAt: row.updated_at };
}

export class CoworkExports {
  constructor(private readonly rs: RuntimeStateDb, private readonly authority: CoworkLifecycleAuthority,
    private readonly now: () => string = () => new Date().toISOString(), private readonly mintId: () => string = () => `export_${randomUUID()}`) {}

  get(exportId: string): CoworkExportRecord | null {
    const row = this.rs.db.query<Row, [string]>("SELECT * FROM cowork_exports WHERE export_id=?").get(lifecycleId(exportId));
    return row ? record(row) : null;
  }

  /** Record one export generation for a stopped, unowned workspace whose volumes are ready and whose images
   * are pinned. The manifest is derived from canonical rows inside this one transaction, so it describes one
   * state. Only one generation may be in flight per workspace. */
  prepare(workspaceId: string, proof: unknown): PreparedExport {
    const id = lifecycleId(workspaceId);
    return durableCoworkTransaction(this.rs, () => {
      const facts = this.admit("export.prepare", id, proof);
      if (this.rs.db.query("SELECT 1 FROM cowork_exports WHERE workspace_id=? AND state='prepared'").get(id)) lifecycleFail("export_in_progress");
      const generation = (this.rs.db.query<Row, [string]>("SELECT coalesce(max(generation),0) AS n FROM cowork_exports WHERE workspace_id=?").get(id)!.n as number) + 1;
      const exportId = lifecycleId(this.mintId()), preparedAt = this.now();
      const manifest = this.derive(facts, exportId, generation, preparedAt);
      const manifestJson = canonicalJson(manifest), manifestDigest = sha256Hex(manifestJson);
      this.rs.db.run("INSERT INTO cowork_exports(export_id,workspace_id,generation,state,manifest_json,manifest_digest,created_at,updated_at) VALUES(?,?,?,'prepared',?,?,?,?)", [exportId, id, generation, manifestJson, manifestDigest, preparedAt, preparedAt]);
      return { exportId, generation, manifest, manifestJson, manifestDigest, disclosure: EXPORT_PLAINTEXT_DISCLOSURE };
    });
  }

  /** The (future) capture finished. It only counts if canonical state is still exactly what the manifest
   * described: an owner, a pin change or any volume change in between marks the generation failed. */
  complete(exportId: string, proof: unknown): CoworkExportRecord {
    const id = lifecycleId(exportId);
    const outcome = durableCoworkTransaction(this.rs, () => {
      const row = this.rs.db.query<Row, [string]>("SELECT * FROM cowork_exports WHERE export_id=?").get(id);
      if (!row) return lifecycleFail("not_found");
      const facts = this.admit("export.complete", row.workspace_id, proof);
      if (row.state === "complete") return { stale: false as const };
      if (row.state !== "prepared") return lifecycleFail("invalid_request");
      const recorded = JSON.parse(row.manifest_json) as CoworkExportManifest;
      let stale = false;
      try { stale = sha256Hex(canonicalJson(this.derive(facts, recorded.generation.exportId, recorded.generation.number, recorded.generation.preparedAt))) !== row.manifest_digest; }
      catch { stale = true; }
      this.rs.db.run("UPDATE cowork_exports SET state=?,updated_at=? WHERE export_id=? AND state='prepared'", [stale ? "failed" : "complete", this.now(), id]);
      return { stale };
    });
    if (outcome.stale) lifecycleFail("generation_stale");
    return this.get(id)!;
  }

  /** Abandon an in-flight generation so another can be prepared. A completed generation is history. */
  fail(exportId: string, proof: unknown): CoworkExportRecord {
    const id = lifecycleId(exportId);
    return durableCoworkTransaction(this.rs, () => {
      const row = this.rs.db.query<Row, [string]>("SELECT * FROM cowork_exports WHERE export_id=?").get(id);
      if (!row) return lifecycleFail("not_found");
      this.admit("export.fail", row.workspace_id, proof);
      if (row.state === "complete") return lifecycleFail("invalid_request");
      if (row.state === "prepared") this.rs.db.run("UPDATE cowork_exports SET state='failed',updated_at=? WHERE export_id=?", [this.now(), id]);
      return this.get(id)!;
    });
  }

  /** Is this descriptor a recovery input this home can act on? It grants nothing. A pass means only that the
   * descriptor is the recorded, completed generation of a workspace this home owns, and that canonical
   * state still matches it. A foreign home, an unknown workspace (imports never reconstruct records), an
   * unrecorded generation, an owner already attached, or any identity/digest mismatch is a refusal. */
  validateImport(input: string | Uint8Array, proof: unknown): ValidatedImport {
    const text = typeof input === "string" ? input : Buffer.from(input).toString("utf8");
    if (Buffer.byteLength(text) > EXPORT_MANIFEST_MAX_BYTES) lifecycleFail("manifest_invalid");
    let raw: any;
    try { raw = JSON.parse(text); } catch { return lifecycleFail("manifest_invalid"); }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) lifecycleFail("manifest_invalid");
    // Unknown formats refuse before any shape judgement: a newer version is not "invalid", it is unsupported.
    if ((raw.formatVersion !== undefined && raw.formatVersion !== 1) || (Array.isArray(raw.volumes) && raw.volumes.some((v: any) => v && typeof v === "object" && ((v.format !== undefined && v.format !== "raw-ext4-v1") || (v.formatVersion !== undefined && v.formatVersion !== 1))))) lifecycleFail("unknown_format");
    const parsed = CoworkExportManifest.safeParse(raw);
    if (!parsed.success) return lifecycleFail("manifest_invalid");
    const manifest = parsed.data;
    const home = this.rs.db.query<Row, []>("SELECT home_id FROM cowork_home_identity WHERE singleton=1").get();
    if (!home) return lifecycleFail("authority_denied");
    // Authority before any existence check, so an unauthorized caller learns nothing about workspaces.
    if (this.authority.authorize("export.validateImport", manifest.workspace.workspaceId, home.home_id, proof) !== true) lifecycleFail("authority_denied");
    if (manifest.homeId !== home.home_id) lifecycleFail("foreign_home");
    let facts: WorkspaceFacts;
    try { facts = readWorkspaceFacts(this.rs, manifest.workspace.workspaceId); }
    catch (error) { if ((error as { code?: string }).code === "not_found") return lifecycleFail("workspace_unknown"); throw error; }
    if (["deleting", "deleted"].includes(facts.workspace.state)) lifecycleFail("authority_denied");
    const recorded = this.rs.db.query<Row, [string, string]>("SELECT * FROM cowork_exports WHERE export_id=? AND workspace_id=?").get(manifest.generation.exportId, manifest.workspace.workspaceId);
    if (!recorded || recorded.state !== "complete" || recorded.generation !== manifest.generation.number || recorded.manifest_digest !== sha256Hex(canonicalJson(manifest))) lifecycleFail("generation_unknown");
    // A second owner must never attach: ownership is judged before identity.
    if (facts.volumes.some(volume => volume.owner_json !== null)) lifecycleFail("volume_busy");
    let derived: CoworkExportManifest;
    try { derived = this.derive(facts, manifest.generation.exportId, manifest.generation.number, manifest.generation.preparedAt); }
    catch { return lifecycleFail("recovery_required"); }
    if (canonicalJson(derived) !== canonicalJson(manifest)) lifecycleFail("recovery_required"); // "a mismatch is recovery-required"
    const latest = this.rs.db.query<Row, [string]>("SELECT max(generation) AS n FROM cowork_exports WHERE workspace_id=? AND state='complete'").get(manifest.workspace.workspaceId)!.n;
    return { exportId: manifest.generation.exportId, generation: manifest.generation.number, latest: latest === manifest.generation.number };
  }

  private admit(action: LifecycleAction, workspaceId: string, proof: unknown): WorkspaceFacts {
    const facts = readWorkspaceFacts(this.rs, workspaceId);
    if (!["retained", "archived"].includes(facts.workspace.state)) lifecycleFail("authority_denied");
    if (this.authority.authorize(action, workspaceId, facts.homeId, proof) !== true) lifecycleFail("authority_denied");
    return facts;
  }

  /** The manifest canonical state implies. Throws unless the workspace is exportable now. */
  private derive(facts: WorkspaceFacts, exportId: string, generation: number, preparedAt: string): CoworkExportManifest {
    assertAtRest(facts);
    if (facts.volumes.length !== 2) lifecycleFail("export_not_ready");
    for (const v of facts.volumes) {
      if (v.format !== "raw-ext4-v1" || v.format_version !== 1) lifecycleFail("unknown_format");
      if (v.state !== "allocated" || v.filesystem_state !== "ready" || typeof v.filesystem_uuid !== "string") lifecycleFail("export_not_ready");
    }
    const pin = this.rs.db.query<Row, [string]>("SELECT * FROM cowork_workspace_images WHERE workspace_id=?").get(facts.workspace.workspace_id);
    if (!pin) lifecycleFail("image_unpinned");
    if (pin!.pending_update_json !== null) lifecycleFail("update_pending");
    const manifest = {
      formatVersion: 1 as const, kind: "cowork-workspace-export" as const, plaintextImages: true as const, homeId: facts.homeId,
      workspace: { workspaceId: facts.workspace.workspace_id, ownership: facts.workspace.ownership },
      generation: { exportId, number: generation, preparedAt },
      images: { baseImageDigest: pin!.base_image_digest, runtimeImageDigest: pin!.runtime_image_digest },
      volumes: facts.volumes.map(v => ({ volumeId: v.volume_id, creationId: v.creation_id, purpose: v.purpose, format: v.format, formatVersion: v.format_version, relativePath: FILES[v.purpose as keyof typeof FILES], capacityBytes: v.capacity_bytes, filesystemUuid: v.filesystem_uuid })),
    };
    const parsed = CoworkExportManifest.safeParse(manifest);
    if (!parsed.success) return lifecycleFail("recovery_required");
    return parsed.data;
  }
}
