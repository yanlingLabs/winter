import type { CoworkHeldInputReconcileContext } from "./session-driver";
import { CoworkHeldInputRefusal, type CoworkHeldInputVerbs } from "./held-input";

/*
 * #92 4.5 rule 1, the PEER-INBOX half: reconcile a starting Cowork runtime's `system/held_inputs` with the receipt ledger
 * BEFORE the driver publishes its epoch. Every entry is answered:
 *   held          `inbox.verdict`: `commit` under the ledger's `ackedHoldToken` (and confirm), or `discard` under the token the
 *                 RUNTIME reported for that record.
 *   committed     the runtime feeds it itself; the host only confirms it when the ledger lists it unconfirmed.
 *   in_transcript the same confirmation; then the tombstone is forgotten (best effort).
 * A verdict that cannot be read, or a verb that fails, THROWS: the epoch stays unpublished and nothing is guessed. An
 * `unknown_input` answer to a commit is terminal (`lost`), as in the drain.
 *
 * GATED like the verbs: it is the `reconcile` of `CoworkSessionDriverDeps.heldInput`, which no production composition supplies.
 */
export type CoworkCommitOutcome = "folded" | "queued" | "started" | "already" | "lost";
/** The slice of the receipt ledger used here, structurally (this module never names the ledger). */
export interface CoworkHeldInputInbox {
  verdict(receiptId: string, recipientSessionId: string): { action: "commit"; ackedHoldToken: string } | { action: "discard" };
  confirmCommitted(receiptId: string, outcome: CoworkCommitOutcome): unknown;
  deliveredUnconfirmed(recipientSessionId: string): Array<{ receiptId: string; ackedHoldToken: string }>;
}

/** Runs `work` in the recipient's drain chain (so no drain interleaves with it). Absent: runs it directly. */
export type CoworkRecipientChain = (recipientSessionId: string, work: () => Promise<void>) => Promise<void>;

export function coworkHeldInputReconciler(inbox: CoworkHeldInputInbox, chain?: CoworkRecipientChain): (context: CoworkHeldInputReconcileContext) => Promise<void> {
  return async context => {
    const work = async () => {
      const unconfirmed = new Map(inbox.deliveredUnconfirmed(context.sessionId).map(entry => [entry.receiptId, entry.ackedHoldToken]));
      for (const entry of context.inputs) {
        if (entry.state === "held") {
          const verdict = inbox.verdict(entry.inputId, context.sessionId); // a throw leaves the epoch unpublished
          if (verdict.action === "commit") await commitAndConfirm(inbox, context.verbs, entry.inputId, verdict.ackedHoldToken);
          else await context.verbs.discard(entry.inputId, entry.holdToken);
        } else if (unconfirmed.has(entry.inputId)) {
          inbox.confirmCommitted(entry.inputId, "already");
          if (entry.state === "in_transcript") await context.verbs.forget(entry.inputId, unconfirmed.get(entry.inputId)!).catch(() => undefined);
        }
      }
    };
    await (chain === undefined ? work() : chain(context.sessionId, work));
  };
}

/** Commits a delivered input under its ack token and records how the guest took it; returns that outcome. `unknown_input` is
 *  terminal (`lost`, confirmed and never retried): returned so the caller can surface it. Any other failure throws (the
 *  input stays delivered-unconfirmed and the next drain repeats the commit). */
export async function commitAndConfirm(inbox: Pick<CoworkHeldInputInbox, "confirmCommitted">, verbs: CoworkHeldInputVerbs, receiptId: string, token: string): Promise<CoworkCommitOutcome> {
  let outcome: "folded" | "queued" | "started" | "already";
  try { outcome = (await verbs.commit(receiptId, token)).outcome; }
  catch (error) {
    if (error instanceof CoworkHeldInputRefusal && error.code === "unknown_input") { inbox.confirmCommitted(receiptId, "lost"); return "lost"; }
    throw error;
  }
  inbox.confirmCommitted(receiptId, outcome);
  await verbs.forget(receiptId, token).catch(() => undefined); // best effort: the tombstone is harmless
  return outcome;
}
