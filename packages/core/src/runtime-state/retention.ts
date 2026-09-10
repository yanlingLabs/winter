// WS-16 §16: how runtime state ENDS — pruned when it is merely old, deleted in a defined order when
// a session goes, archived when a user retires one.
//
// THE THREE DOORS ARE NOT INTERCHANGEABLE, and conflating them is the failure mode this file exists
// to prevent:
//
//   sweepRetention             shortens the tail of things that are ALREADY SETTLED. It can never
//                              reach a claimed-but-unreceipted delivery or a held name lease, at
//                              any age — those are live evidence, and `directory-store.ts`'s two
//                              `prune` doors filter on the receipt/release column, never on age.
//   deleteSessionRuntimeState  removes ONE session's runtime state, in the order §16 gives, and
//                              never touches project memory or the product event log.
//   archiveSession             retires a session and deletes NOTHING. "Archive is not delete."
//
// WHAT THIS FILE NEVER TOUCHES. `<home>/projects/<key>/memory` is the user's own writing; the
// session JSONL is the product's own history and belongs to `SessionStore.deleteSession`. A runtime
// record is metadata ABOUT an execution; destroying it must never destroy what was executed.
import { parseRuntimeAddress } from "@yanlinglabs/winter-agent-sdk/messaging";
import type { GlobalAgentMessage, RuntimeDirectoryStore, SerializedRuntimeAddress } from "@yanlinglabs/winter-runtime-sdk";
import type { RuntimeChildren } from "./children";
import type { RuntimeStateDb } from "./db";
import type { RuntimeLeases } from "./leases";
import { IllegalStateTransitionError, type RuntimeSessionRecords } from "./records";
import type { Settings } from "../settings";

const DAY_MS = 86_400_000;

/** The shipped windows, in one place. Mirrored by `settings.ts`'s zod defaults, and re-stated here
 *  because `retentionFromSettings(undefined)` must answer even when no settings file was loaded. */
export const DEFAULT_DELIVERIES_DAYS = 30;
export const DEFAULT_NAME_LEASES_DAYS = 7;

export interface RuntimeRetention {
  deliveriesMs: number;
  nameLeasesMs: number;
}

/**
 * Read the live retention windows.
 *
 * CALL THIS ON EVERY SWEEP, never once at boot: `settings.json` is hot-swapped
 * (`settings-watcher.ts`), and no setting in this daemon may require a restart to take effect. The
 * function is pure and cheap precisely so the scheduler can re-read it each pass.
 */
export function retentionFromSettings(s: Settings | undefined): RuntimeRetention {
  const retention = s?.runtimes?.retention;
  return {
    deliveriesMs: (retention?.deliveriesDays ?? DEFAULT_DELIVERIES_DAYS) * DAY_MS,
    nameLeasesMs: (retention?.nameLeasesDays ?? DEFAULT_NAME_LEASES_DAYS) * DAY_MS,
  };
}

/**
 * One retention pass over the router's durable sinks.
 *
 * Both cutoffs are ISO-8601 strings because both columns are: `global_messages.receipted_at` is the
 * record's own `updatedAt` at the moment its outcome existed, and `name_leases.released_at` is the
 * instant the router released the name. Comparing the stored text is therefore comparing the same
 * clock reading the writer made — no re-derivation, and no timezone anywhere in the comparison.
 */
export async function sweepRetention(
  store: RuntimeDirectoryStore,
  retention: RuntimeRetention,
  now: () => Date = () => new Date(),
): Promise<{ deliveriesPruned: number; leasesPruned: number }> {
  const at = now().getTime();
  const deliveriesPruned = await store.deliveries.prune(new Date(at - retention.deliveriesMs).toISOString());
  const leasesPruned = await store.names.prune(new Date(at - retention.nameLeasesMs).toISOString());
  return { deliveriesPruned, leasesPruned };
}

export interface DeleteSessionRuntimeStateDeps {
  rs: RuntimeStateDb;
  records: RuntimeSessionRecords;
  leases: RuntimeLeases;
  children: RuntimeChildren;
  directory: RuntimeDirectoryStore;
}

/** Does this address belong to the session — either as the session itself, or as one of its
 *  children? `parseRuntimeAddress` sets `winterSessionId` to the PARENT for an `agent:` address, so
 *  one comparison covers both; an address this daemon cannot parse is left strictly alone. */
function addressBelongsTo(address: SerializedRuntimeAddress, winterSessionId: string): boolean {
  const parsed = parseRuntimeAddress(address);
  if (!parsed) return false;
  return parsed.winterSessionId === winterSessionId || parsed.parentWinterSessionId === winterSessionId;
}

/**
 * WS-16 §16's deletion order for ONE session's runtime state.
 *
 * THE ORDER IS THE CRASH SAFETY, which is why this is a sequence of committed steps and not one
 * transaction (it cannot be one anyway — the directory seam is async). The `runtime_sessions` row
 * goes LAST, so a crash at any earlier point leaves the record still present and a re-run picks the
 * job back up. Every step is idempotent (`DELETE … WHERE` on rows that may already be gone), so
 * that re-run costs nothing and reports nothing.
 *
 * `removed` names every table a row actually left — an operator auditing a delete needs to see the
 * reach, not a boolean. Two deliberate notes on that list:
 *
 *   - `name_leases` rows are RELEASED, not deleted. WS-10 §11 rule 5 needs a released row to answer
 *     "that name referred to something that has gone" instead of "no such agent"; retention's
 *     7-day window is what finally removes it.
 *   - `runtime_recovery_attempts` is deliberately absent. It is the daemon's own audit of recovery
 *     runs (its `winter_session_id` is nullable), not this session's state, and an audit trail that
 *     deletes itself when the thing it describes is deleted is not an audit trail.
 *
 * The product's own history (the session JSONL and `sessions/index.db`) stays with
 * `SessionStore.deleteSession`, and project memory is never touched by any door here.
 */
export async function deleteSessionRuntimeState(
  deps: DeleteSessionRuntimeStateDeps,
  winterSessionId: string,
): Promise<{ removed: string[] }> {
  const { rs, records, leases, children, directory } = deps;
  const removed: string[] = [];
  const touched = (table: string, changes: number): void => {
    if (changes > 0 && !removed.includes(table)) removed.push(table);
  };

  const record = records.get(winterSessionId);
  if (!record) return { removed };
  removed.push("runtime_sessions");

  // 1. Mark unavailable — the honest state while the rest of this runs. Two lifecycle states have
  //    no edge to `unavailable` (`creating`, `archived`); for those the mark is skipped rather than
  //    allowed to abort a deletion the user asked for.
  try {
    if (record.state !== "unavailable") records.transition(winterSessionId, "unavailable");
  } catch (e) {
    if (!(e instanceof IllegalStateTransitionError)) throw e;
  }

  // 2. Release every runtime lease. `release` is a no-op for a lease this process does not hold, so
  //    the remaining rows are cleared directly — they are about to be deleted outright, and leaving
  //    a live holder behind would make the row look like a writer that never let go.
  for (const generation of records.generations(winterSessionId)) leases.release(winterSessionId, generation.generation);
  rs.db.run(
    `UPDATE runtime_generations SET lease_released_at = ? WHERE winter_session_id = ? AND lease_holder_pid IS NOT NULL AND lease_released_at IS NULL`,
    [new Date().toISOString(), winterSessionId],
  );

  // 3. Child rows. `RuntimeChildren` owns this table but has no delete door — nothing before now
  //    needed one, and a child row is evidence of what happened rather than state to rewrite — so
  //    the removal is a raw DELETE while the repository stays the READ door that says what was there.
  const childRows = children.list(winterSessionId);
  rs.db.run("DELETE FROM runtime_children WHERE parent_winter_session_id = ?", [winterSessionId]);
  touched("runtime_children", childRows.length);

  // 4. Directory entries, cursors and idle subscriptions for `session:<id>` and `agent:<id>:*`.
  for (const entry of await directory.load()) {
    if (!addressBelongsTo(entry.address, winterSessionId)) continue;
    await directory.remove(entry.address);
    touched("directory_entries", 1);
  }
  for (const address of Object.keys(await directory.cursors.all())) {
    if (!addressBelongsTo(address, winterSessionId)) continue;
    await directory.cursors.remove(address);
    touched("directory_cursors", 1);
  }
  for (const subscription of await directory.subscriptions.list()) {
    if (!addressBelongsTo(subscription.target, winterSessionId) && !addressBelongsTo(subscription.subscriber, winterSessionId)) continue;
    await directory.subscriptions.remove(subscription.messageId);
    touched("idle_subscriptions", 1);
  }

  // 5. Held messages for those receivers.
  for (const receiver of await directory.mailboxes.receivers()) {
    if (!addressBelongsTo(receiver, winterSessionId)) continue;
    const held = await directory.mailboxes.listHeld(receiver);
    await directory.mailboxes.clear(receiver);
    touched("held_messages", held.length);
  }

  // 6. Delivery records whose message TARGETS this session, and the receipts that audit them. The
  //    seam has no "list every delivery" door (nothing else needs one), so the target is read out
  //    of the stored envelope here — the same JSON the seam wrote, parsed, never re-shaped.
  const deliveries = rs.db.query("SELECT message_id, message_json FROM global_messages").all() as Array<{ message_id: string; message_json: string }>;
  for (const row of deliveries) {
    let to: GlobalAgentMessage["to"] | undefined;
    try { to = (JSON.parse(row.message_json) as GlobalAgentMessage).to; } catch { continue; }
    if (to?.winterSessionId !== winterSessionId && to?.parentWinterSessionId !== winterSessionId) continue;
    touched("global_messages", rs.db.run("DELETE FROM global_messages WHERE message_id = ?", [row.message_id]).changes);
    touched("global_message_receipts", rs.db.run("DELETE FROM global_message_receipts WHERE message_id = ?", [row.message_id]).changes);
  }

  // 7. Name leases: released, never deleted (see this function's own note).
  const releasedAt = new Date().toISOString();
  for (const lease of await directory.names.held()) {
    if (!addressBelongsTo(lease.address, winterSessionId)) continue;
    await directory.names.release(lease.name, lease.address, releasedAt);
    touched("name_leases", 1);
  }

  // 8. Projection state.
  touched("runtime_projection_cursors", rs.db.run("DELETE FROM runtime_projection_cursors WHERE winter_session_id = ?", [winterSessionId]).changes);
  touched("projection_applied", rs.db.run("DELETE FROM projection_applied WHERE winter_session_id = ?", [winterSessionId]).changes);
  touched("transcript_dialects", rs.db.run("DELETE FROM transcript_dialects WHERE winter_session_id = ?", [winterSessionId]).changes);

  // 9. Generations and handoffs by explicit DELETE, then the record itself. `runtime_generations`
  //    carries a foreign key onto `runtime_sessions` and `PRAGMA foreign_keys` is ON, so the order
  //    inside this last step is a constraint, not a preference.
  rs.transaction(() => {
    touched("runtime_handoffs", rs.db.run("DELETE FROM runtime_handoffs WHERE winter_session_id = ?", [winterSessionId]).changes);
    touched("runtime_generations", rs.db.run("DELETE FROM runtime_generations WHERE winter_session_id = ?", [winterSessionId]).changes);
    rs.db.run("DELETE FROM runtime_sessions WHERE winter_session_id = ?", [winterSessionId]);
  }, { mode: "immediate" });

  return { removed };
}

/**
 * Retire a session without deleting anything — WS-16 §16's "archive is not delete".
 *
 * Every row stays exactly where it is; only the lifecycle state moves. `archived` is reachable from
 * `ready`/`idle`/`exited`/`failed`/`unavailable` and NOT from `creating` or `running`: a session
 * that is still executing is stopped first, and one whose mapping never committed is settled first.
 * That refusal comes from `ALLOWED_TRANSITIONS` itself, so there is no second copy of the rule here.
 *
 * 8b's messaging surface must refuse an archived session as a target; this door is what makes that
 * state exist to be refused.
 *
 * IDEMPOTENT, and that is not a convenience. `archived → archived` is deliberately not an edge in
 * `ALLOWED_TRANSITIONS` (nothing should be able to re-archive its way around the table), but §17
 * phase 4's backfill settles a session the user retired BEFORE the runtime spine existed straight
 * INTO `archived` — so "archive this" routinely arrives at a record that is already there, through
 * no fault of the caller. Answering that with a throw would make retiring a legacy session an error
 * exactly once per legacy session. A record already in the requested state is left completely
 * alone: no transition, no `updated_at` bump, nothing to observe.
 */
export function archiveSession(records: RuntimeSessionRecords, winterSessionId: string): void {
  if (records.get(winterSessionId)?.state === "archived") return;
  records.transition(winterSessionId, "archived");
}
