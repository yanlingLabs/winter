// Shared pieces of the host-storage lifecycle records (image pins, export generations). Trusted-controller
// code only: no RPC, guest message, manifest or availability switch reaches it, and every operation takes a
// mandatory authority port with no permissive default (docs/cowork-storage-security.md: "Manifest/imported
// descriptors cannot grant authority: validate against canonical host records").
import { createHash } from "node:crypto";
import type { RuntimeStateDb } from "../runtime-state/db";

export type LifecycleFailure =
  | "invalid_request" | "authority_denied" | "not_found" | "volume_busy" | "recovery_required"
  | "image_unpinned" | "image_digest_mismatch" | "update_pending" | "no_update_pending" | "incompatible_image"
  | "export_not_ready" | "export_in_progress" | "generation_stale" | "generation_unknown"
  | "manifest_invalid" | "unknown_format" | "foreign_home" | "workspace_unknown"
  // Export writer and restore flow (export-bundle.ts, export-writer.ts, restore-bundle.ts).
  | "bundle_invalid" | "bundle_unsafe" | "bundle_exists" | "destination_invalid" | "restore_unconfirmed" | "restore_conflict" | "backup_exclusion_unavailable" | "integration_unavailable";

export class CoworkLifecycleError extends Error {
  constructor(readonly code: LifecycleFailure) { super(code); this.name = "CoworkLifecycleError"; }
}
export function lifecycleFail(code: LifecycleFailure): never { throw new CoworkLifecycleError(code); }

export type LifecycleAction =
  | "image.pin" | "image.beginUpdate" | "image.confirmUpdate" | "image.abandonUpdate"
  | "export.prepare" | "export.complete" | "export.fail" | "export.validateImport";

/** Mandatory. The real implementation authenticates the native controller / local user principal and the
 * registered canonical home; a manifest, PID or released admission row does not satisfy it. */
export interface CoworkLifecycleAuthority {
  authorize(action: LifecycleAction, workspaceId: string, homeId: string, proof: unknown): boolean;
}

export const HEX64 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
export const lifecycleId = (value: unknown): string => typeof value === "string" && ID.test(value) ? value : lifecycleFail("invalid_request");
export const lifecycleDigest = (value: unknown): string => typeof value === "string" && HEX64.test(value) ? value : lifecycleFail("invalid_request");

/** Deterministic JSON: object keys sorted at every depth. A digest of this is the identity of a record. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, (item as Record<string, unknown>)[key]])) : item);
}
export const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

type Row = Record<string, any>;
export interface WorkspaceFacts { homeId: string; workspace: Row; volumes: Row[] }

/** Canonical facts for one workspace, read inside the caller's transaction. */
export function readWorkspaceFacts(rs: RuntimeStateDb, workspaceId: string): WorkspaceFacts {
  const home = rs.db.query<Row, []>("SELECT home_id FROM cowork_home_identity WHERE singleton=1").get();
  const workspace = rs.db.query<Row, [string]>("SELECT * FROM cowork_workspaces WHERE workspace_id=?").get(workspaceId);
  if (!workspace) return lifecycleFail("not_found");
  if (!home) return lifecycleFail("authority_denied");
  const volumes = rs.db.query<Row, [string]>("SELECT * FROM cowork_volumes WHERE workspace_id=? ORDER BY purpose").all(workspaceId);
  return { homeId: home.home_id, workspace, volumes };
}

/** "Image/runtime updates occur while stopped": the guest is stopped, no volume records a writable owner
 * (an uncertain termination keeps ownership), and no format/probe operation is in flight or uncertain.
 * This reads canonical rows only. It does not open an image, so it proves nothing about the file's current
 * identity, mode or backup exclusion: any future byte copy or attach must re-verify those on a pinned descriptor. */
export function assertAtRest(facts: WorkspaceFacts): void {
  if (facts.workspace.power !== "stopped" || facts.volumes.some(volume => volume.owner_json !== null)) lifecycleFail("volume_busy");
  if (facts.volumes.some(volume => ["formatting", "probing", "recovery-required"].includes(volume.filesystem_state))) lifecycleFail("recovery_required");
}
