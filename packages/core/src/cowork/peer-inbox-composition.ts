import type { SessionEvent } from "@yanlinglabs/winter-protocol";
import { coworkHeldInputReconciler, type CoworkHeldInputInbox } from "./held-input-reconcile";
import { coworkLostInputNotice, coworkStalledInboxNotice } from "./held-input";
import type { CoworkSessionDriverDeps } from "./session-driver";

/*
 * The composition seam for Cowork peer messaging (N2 S7B, b4), the three pieces #92 4.5 leaves to the composition:
 *   - the driver's `heldInput` gate (reconcile in the recipient's drain chain, then drain what is owed once the epoch is published),
 *   - `noteLostPeerMessage`  -> a `continuity_warning` on the recipient's conversation (`coworkLostInputNotice`),
 *   - `noteStalledPeerInbox` -> a `continuity_warning` on the recipient's conversation (`coworkStalledInboxNotice`).
 *
 * GATED OFF: nothing in production calls these (the daemon builds no Cowork driver and passes no peer inbox to `SessionMessaging`), and
 * `session.create {mode:"cowork"}` keeps answering `unsupported_topology`. Tests and an injected composition supply the ports.
 */
export interface CoworkNoticeSink { append(sessionId: string, input: Omit<Extract<SessionEvent, { type: "continuity_warning" }>, "seq" | "ts">): unknown }
export interface CoworkRecipientMessaging {
  runInRecipientChain(recipientSessionId: string, work: () => Promise<void>): Promise<void>;
  drainCoworkInbox(recipientSessionId: string): Promise<void>;
}

/** The two `SessionMessagingDeps` hooks. Each appends a `continuity_warning` (main thread) with the fixed notice text; a failed append is swallowed (the ledger already says what happened). */
export function coworkPeerInboxNotes(sink: CoworkNoticeSink): { noteLostPeerMessage: (recipientSessionId: string) => void; noteStalledPeerInbox: (recipientSessionId: string) => void } {
  const show = (sessionId: string, notice: { warning: string; text: string }): void => {
    try { sink.append(sessionId, { type: "continuity_warning", sessionId, threadId: "main", warning: notice.warning, text: notice.text }); } catch { /* best effort */ }
  };
  return { noteLostPeerMessage: sessionId => show(sessionId, coworkLostInputNotice()), noteStalledPeerInbox: sessionId => show(sessionId, coworkStalledInboxNotice()) };
}

/** `CoworkSessionDriverDeps.heldInput`: reconcile inside the recipient's drain chain; once the epoch is published, drain the inbox. `messaging` is a thunk because the messaging service is built after (and with) the hooks above. */
export function coworkHeldInputGate(deps: { inbox: CoworkHeldInputInbox; messaging: () => CoworkRecipientMessaging | undefined }): NonNullable<CoworkSessionDriverDeps["heldInput"]> {
  const chain = (sessionId: string, work: () => Promise<void>): Promise<void> => {
    const messaging = deps.messaging();
    return messaging === undefined ? work() : messaging.runInRecipientChain(sessionId, work);
  };
  return {
    enabled: true,
    reconcile: coworkHeldInputReconciler(deps.inbox, chain),
    published: sessionId => { void deps.messaging()?.drainCoworkInbox(sessionId); },
  };
}
