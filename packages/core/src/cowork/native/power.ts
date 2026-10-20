import type { RuntimeStateDb } from "../../runtime-state/db";
import { durableCoworkTransaction } from "../durable-transaction";
import type { Workspace } from "../types";
import { releaseTokenState } from "./stop-proof";

/*
 * Compare-and-set `power` transitions for a workspace, in this module so repository.ts stays untouched. The repository owns
 * exactly one move, `stopped` to `starting` (`beginIncarnation`, which also bumps the lease epoch); everything after it lives here.
 *
 * Every write names the incarnation AND the lease epoch it believes current and the power it believes the workspace is in; the UPDATE
 * matches all of them or changes nothing, so a stale controller (an old incarnation, a superseded epoch, a state someone else
 * already moved) can never move the workspace. The move to `stopped` additionally needs a RELEASE TOKEN (stop-proof.ts), minted
 * only after the disks were released, or after the canonical records show both images free of any claim. There is
 * no other way to write `stopped` here.
 */

export type CoworkPower = Workspace["power"];
export type CoworkPowerFailure = "stale" | "illegal" | "needs_release" | "not_found";
export class CoworkNativePowerError extends Error {
  constructor(readonly code: CoworkPowerFailure) { super(code); this.name = "CoworkNativePowerError"; }
}
const refuse = (code: CoworkPowerFailure): never => { throw new CoworkNativePowerError(code); };

/** The transition table. `stopped` has no way out here: only the repository starts a new incarnation. */
export const COWORK_NATIVE_POWER_TRANSITIONS: Readonly<Record<CoworkPower, readonly CoworkPower[]>> = Object.freeze({
  stopped: Object.freeze([]),
  starting: Object.freeze(["running", "draining", "uncertain", "stopped"]),
  running: Object.freeze(["draining", "uncertain"]),
  draining: Object.freeze(["uncertain", "stopped"]),
  uncertain: Object.freeze(["draining", "stopped"]),
}) as Readonly<Record<CoworkPower, readonly CoworkPower[]>>;

export interface CoworkPowerKey { readonly workspaceId: string; readonly incarnationId: string; readonly leaseEpoch: number }
export interface CoworkPowerReading { readonly power: CoworkPower; readonly incarnationId: string | null; readonly leaseEpoch: number; readonly state: Workspace["state"] }
type Row = { power: CoworkPower; incarnation_id: string | null; lease_epoch: number; state: Workspace["state"] };

export class CoworkNativePower {
  constructor(private readonly rs: RuntimeStateDb, private readonly now: () => string = () => new Date().toISOString()) {}

  read(workspaceId: string): CoworkPowerReading {
    const row = this.rs.db.query<Row, [string]>("SELECT power,incarnation_id,lease_epoch,state FROM cowork_workspaces WHERE workspace_id=?").get(workspaceId);
    if (!row) return refuse("not_found");
    return { power: row.power, incarnationId: row.incarnation_id, leaseEpoch: row.lease_epoch, state: row.state };
  }

  /** Move `from` to `to` for exactly this incarnation and epoch, or throw. `release` is required for, and only for, `stopped`. */
  transition(key: CoworkPowerKey, from: CoworkPower, to: CoworkPower, release?: unknown): void {
    if (!COWORK_NATIVE_POWER_TRANSITIONS[from]?.includes(to)) return refuse("illegal");
    if (to === "stopped") {
      const token = releaseTokenState(release);
      if (!token || token.workspaceId !== key.workspaceId || token.incarnationId !== key.incarnationId || token.leaseEpoch !== key.leaseEpoch) return refuse("needs_release");
    } else if (release !== undefined) return refuse("illegal");
    durableCoworkTransaction(this.rs, () => {
      const changed = this.rs.db.run("UPDATE cowork_workspaces SET power=?,updated_at=? WHERE workspace_id=? AND power=? AND incarnation_id=? AND lease_epoch=? AND state='retained'", [to, this.now(), key.workspaceId, from, key.incarnationId, key.leaseEpoch]).changes;
      if (changed !== 1) return refuse("stale");
    });
  }

  /** Mark the workspace `uncertain` from wherever it is. Idempotent for an already-uncertain workspace; refuses `stopped` (nothing
   * to be uncertain about) and a stale incarnation or epoch. Returns true when it wrote. */
  markUncertain(key: CoworkPowerKey): boolean {
    const now = this.read(key.workspaceId);
    if (now.incarnationId !== key.incarnationId || now.leaseEpoch !== key.leaseEpoch || now.state !== "retained") return refuse("stale");
    if (now.power === "uncertain") return false;
    if (now.power === "stopped") return refuse("illegal");
    this.transition(key, now.power, "uncertain");
    return true;
  }
}
