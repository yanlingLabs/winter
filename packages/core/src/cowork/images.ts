// Workspace image pins. docs/cowork-spec.md, "Persistent storage": "Pin the writable environment to its
// base-image digest; a new base cannot silently replace the lower layer beneath an old installation
// overlay." and "Image/runtime updates occur while stopped. Validate compatibility, retain the previous
// environment until migration or explicit rebuild succeeds, and preserve workspace data."
//
// This is bookkeeping only. It records which base image and runtime image a workspace is pinned to and
// walks a two-phase update through begin -> confirm | abandon. It copies, replaces and deletes nothing:
// keeping the previous environment's bytes until the update is confirmed is the native controller's job,
// and the pin deliberately stays on the OLD digests until it confirms, so a crash mid-update leaves the
// workspace pinned to the environment that still exists. Nothing here enrols a digest into a launch: the
// worker admission (`CoworkVolumeOwner.runtimeImageDigest`) is unchanged.
import type { RuntimeStateDb } from "../runtime-state/db";
import { durableCoworkTransaction } from "./durable-transaction";
import { assertAtRest, canonicalJson, lifecycleDigest, lifecycleFail, lifecycleId, readWorkspaceFacts, type CoworkLifecycleAuthority, type LifecycleAction } from "./storage-lifecycle";

export interface CoworkImageDigests { baseImageDigest: string; runtimeImageDigest: string }
export interface CoworkImagePin extends CoworkImageDigests {
  workspaceId: string; revision: number;
  /** The update begun but not yet confirmed or abandoned. The pinned digests above are still the live ones. */
  pendingUpdate: { next: CoworkImageDigests; startedAt: string } | null;
  pinnedAt: string; updatedAt: string;
}
/** Mandatory, synchronous. "Validate compatibility": which base/runtime pairs can host an existing
 * environment is image knowledge this host layer does not have, so there is no default. Anything other
 * than exactly `true` (including a promise) refuses. */
export interface CoworkImageCompatibility {
  compatible(workspaceId: string, current: CoworkImageDigests, next: CoworkImageDigests): boolean;
}
type Row = Record<string, any>;
const digests = (value: CoworkImageDigests): CoworkImageDigests => ({ baseImageDigest: lifecycleDigest(value?.baseImageDigest), runtimeImageDigest: lifecycleDigest(value?.runtimeImageDigest) });
const same = (a: CoworkImageDigests, b: CoworkImageDigests) => a.baseImageDigest === b.baseImageDigest && a.runtimeImageDigest === b.runtimeImageDigest;

function toPin(row: Row): CoworkImagePin {
  const current = digests({ baseImageDigest: row.base_image_digest, runtimeImageDigest: row.runtime_image_digest });
  let pending: CoworkImagePin["pendingUpdate"] = null;
  if (row.pending_update_json !== null) {
    try {
      const parsed = JSON.parse(row.pending_update_json);
      if (typeof parsed?.startedAt !== "string" || Object.keys(parsed).sort().join() !== "next,startedAt") return lifecycleFail("recovery_required");
      pending = { next: digests(parsed.next), startedAt: parsed.startedAt };
    } catch { return lifecycleFail("recovery_required"); }
  }
  return { workspaceId: row.workspace_id, ...current, revision: row.revision, pendingUpdate: pending, pinnedAt: row.pinned_at, updatedAt: row.updated_at };
}

export class CoworkImagePins {
  constructor(private readonly rs: RuntimeStateDb, private readonly authority: CoworkLifecycleAuthority,
    private readonly compatibility: CoworkImageCompatibility, private readonly now: () => string = () => new Date().toISOString()) {}

  get(workspaceId: string): CoworkImagePin | null {
    const row = this.rs.db.query<Row, [string]>("SELECT * FROM cowork_workspace_images WHERE workspace_id=?").get(lifecycleId(workspaceId));
    return row ? toPin(row) : null;
  }

  /** Pure comparison against the live pin; the check a launch or an import runs. A pending update never
   * counts: only the confirmed digests are live. */
  assertPinned(workspaceId: string, expected: CoworkImageDigests): void {
    const current = this.get(workspaceId);
    if (!current) lifecycleFail("image_unpinned");
    if (!same(current!, digests(expected))) lifecycleFail("image_digest_mismatch");
  }

  /** First pin, or an identical repeat. A different digest is a mismatch, never a quiet re-pin: change a
   * pin only through `beginUpdate`/`confirmUpdate` while stopped. */
  pin(workspaceId: string, value: CoworkImageDigests, proof: unknown): CoworkImagePin {
    const id = lifecycleId(workspaceId), wanted = digests(value);
    return durableCoworkTransaction(this.rs, () => {
      this.admit("image.pin", id, proof, ["retained", "archived"]);
      const existing = this.get(id);
      if (existing) {
        if (!same(existing, wanted)) lifecycleFail("image_digest_mismatch");
        return existing;
      }
      const at = this.now();
      this.rs.db.run("INSERT INTO cowork_workspace_images(workspace_id,base_image_digest,runtime_image_digest,pending_update_json,revision,pinned_at,updated_at) VALUES(?,?,?,NULL,1,?,?)", [id, wanted.baseImageDigest, wanted.runtimeImageDigest, at, at]);
      return this.get(id)!;
    });
  }

  beginUpdate(workspaceId: string, next: CoworkImageDigests, proof: unknown): CoworkImagePin {
    const id = lifecycleId(workspaceId), wanted = digests(next);
    return durableCoworkTransaction(this.rs, () => {
      const facts = this.admit("image.beginUpdate", id, proof, ["retained", "archived"]);
      const current = this.get(id);
      if (!current) lifecycleFail("image_unpinned");
      if (current!.pendingUpdate) lifecycleFail("update_pending");
      if (same(current!, wanted)) lifecycleFail("invalid_request"); // not an update
      assertAtRest(facts);
      if (this.compatibility.compatible(id, { baseImageDigest: current!.baseImageDigest, runtimeImageDigest: current!.runtimeImageDigest }, wanted) !== true) lifecycleFail("incompatible_image");
      this.rs.db.run("UPDATE cowork_workspace_images SET pending_update_json=?,revision=revision+1,updated_at=? WHERE workspace_id=?", [canonicalJson({ next: wanted, startedAt: this.now() }), this.now(), id]);
      return this.get(id)!;
    });
  }

  /** The native controller reports the migration or rebuild succeeded: the pending digests become live. */
  confirmUpdate(workspaceId: string, proof: unknown): CoworkImagePin {
    const id = lifecycleId(workspaceId);
    return durableCoworkTransaction(this.rs, () => {
      const facts = this.admit("image.confirmUpdate", id, proof, ["retained", "archived"]);
      const current = this.get(id);
      if (!current) lifecycleFail("image_unpinned");
      if (!current!.pendingUpdate) lifecycleFail("no_update_pending");
      assertAtRest(facts);
      const next = current!.pendingUpdate!.next;
      this.rs.db.run("UPDATE cowork_workspace_images SET base_image_digest=?,runtime_image_digest=?,pending_update_json=NULL,revision=revision+1,updated_at=? WHERE workspace_id=?", [next.baseImageDigest, next.runtimeImageDigest, this.now(), id]);
      return this.get(id)!;
    });
  }

  /** The update failed or was cancelled: the previous environment, still pinned, remains the live one. */
  abandonUpdate(workspaceId: string, proof: unknown): CoworkImagePin {
    const id = lifecycleId(workspaceId);
    return durableCoworkTransaction(this.rs, () => {
      const facts = this.admit("image.abandonUpdate", id, proof, ["retained", "archived"]);
      const current = this.get(id);
      if (!current) lifecycleFail("image_unpinned");
      if (!current!.pendingUpdate) lifecycleFail("no_update_pending");
      assertAtRest(facts);
      this.rs.db.run("UPDATE cowork_workspace_images SET pending_update_json=NULL,revision=revision+1,updated_at=? WHERE workspace_id=?", [this.now(), id]);
      return this.get(id)!;
    });
  }

  private admit(action: LifecycleAction, workspaceId: string, proof: unknown, states: readonly string[]) {
    const facts = readWorkspaceFacts(this.rs, workspaceId);
    if (!states.includes(facts.workspace.state)) lifecycleFail("authority_denied");
    if (this.authority.authorize(action, workspaceId, facts.homeId, proof) !== true) lifecycleFail("authority_denied");
    return facts;
  }
}
