# Cowork peer inbox wired into same-Project messaging (host side, behind the refusal)

Status: `agent/session-messaging.ts` routes a SendMessage between two Cowork sessions of one Project through the durable
peer inbox (the receipt ledger `cowork/peer-inbox.ts` over `cowork/peer-inbox-sqlite.ts`, schema 17). It is wired
BEHIND THE REFUSAL: the broker takes the inbox as an injected port (`SessionMessagingDeps.peerInbox`) that production
(`daemon.ts`) does not supply, and no Cowork session can be created (`session.create {mode:"cowork"}` still answers
`unsupported_topology`). Nothing here claims guest-to-guest delivery: the first guest profile withholds the message tools,
so this is the HOST-side path only (ledger, store, delivery into a recipient driver). Code and Dispatch messaging is
byte-identical (their tests are unchanged).

## Flow

1. `resolveTarget` and `mayContact` authorize as before (cross-Project, host-to-Cowork and unknown targets are the uniform
   `not_found`; no row is written). For a Cowork-to-Cowork pair, `deliver` hands over to `deliverViaPeerInbox`.
2. **Accept first.** The message is stored as a versioned envelope `{v:1, message, summary?, notifyWhenIdle}` (never the
   rendered frame, which carries timestamps: a retry must digest identically, and `summary`/`notifyWhenIdle` must survive a
   restart). `CoworkPeerInbox.accept` persists it (body kept only while owed) or refuses: archived recipient, caps
   (`unavailable`, retryable), malformed or oversized (`refused`), same id with other content (`refused`). A sender without a runtime
   incarnation is refused and persists nothing (a restarted sender's `msg-1` would otherwise be swallowed as a retry).
3. **Deliver.** `drainCoworkInbox(recipient)` runs one drain at a time per recipient: `settle` (park or end what authority no longer allows),
   nothing wakes unless runnable work is owed, `ensure` the recipient driver (resuming a stopped one), take the driver's `coworkEpoch`, `offer` under it,
   render the attributed frame deterministically from the receipt (`acceptedAt`, `sendId`), push with the existing `deliverInto` (steer into a
   running turn that folds, queue behind the daemon's own queue, or send), and only then `ack`, which deletes the body. A failed push
   or ack leaves the record owed and stops the drain (at-least-once; the unacked head is offered again). A replaced runtime is retried once under the successor.
4. **Answer truthfully.** `delivered` / `resumed_and_delivered` / `queued` (the note names the receipt) only if THIS message was acknowledged;
   otherwise `queued` with its receipt id. Authority lost between accept and delivery answers the uniform `not_found` while the record stays parked.
   No body text is ever put in an answer, note or log line.
5. **Restart.** Owed messages are in the table. After a restart `drainCoworkInbox` (fresh `SessionMessaging`, fresh store, same database) delivers each exactly once.

## Fail closed

Without an injected inbox a Cowork pair answers `unavailable` (not retryable), delivers nothing and wakes nothing. Production is in that state today.

## Tests

`test/cowork/peer-inbox-wiring.test.ts` (21; includes a runtime replaced on every push retried exactly once, damaged or future-version envelopes parked as recovery with nothing delivered past them, an ack that keeps failing stopping the drain, and the steered / queued-ahead notes; fakes only: real ledger, real SQLite store, real records, fake drivers): delivery with a stopped recipient and body purge, steer into a running turn, queue behind pending sends, cross-Project and host refusals with no row, no-epoch and stale-epoch recipients, restart delivery with summary/notify intact, retry/conflict/new-incarnation identities, empty incarnation, no-inbox fail closed, concurrent sends, failed push then retry, archived recipient and revoked sender, caps, Code messaging never touching the inbox, no wake when nothing runnable is owed, damaged envelope parked.
`test/cowork/session-messaging.test.ts` now gives its fixture a real inbox and a driver epoch; two assertions changed because accept now precedes `ensure` (a tick is awaited) and a replaced push is retried once under the successor whose offer re-checks authority (the revoked sender gets the uniform `not_found`, the record is parked). The anti-wiring pin allows exactly this file to name the ledger, by type only, and forbids any construction of the ledger or store in `src` and any mention in `daemon.ts`. The refusal is still proven by `test/ipc/session-create-cowork.test.ts`, `test/ipc/session-cowork-row-refused.test.ts` and `test/sessions/session-mode.test.ts`.

## Known points

- **This host-side path may deliver once after a revoke: the push precedes the ack. Exact spec semantics (hold-until-ack, discard on authority_denied) are owed by the guest-runtime slice.** Authority can be revoked after the push and before the ack: the input is already in the recipient (at-least-once), so a just-revoked pair may have delivered one message.
- The epoch fence is the recipient driver's `coworkEpoch`; a real Cowork driver must supply it (seam below).
- Nothing in this slice calls `drainCoworkInbox` at boot or on workspace start.

## Needs from other lanes

- DOOR (`CoworkSessionDrivers`, `cowork/session-ports.ts`): the Cowork recipient driver must expose `coworkEpoch: {incarnationId, leaseEpoch}` (the workspace's current guest incarnation and lease epoch) and the same `send`/`steer`/`foldsQueuedInput`/`pendingSends`/`state` shape as `MessagingDriverHandle`. Until D1 merges this file uses that local seam.
- S7B (`daemon.ts`): construct `new SqlitePeerInboxStore(runtimeStateDb)` and `new CoworkPeerInbox({records, store})`, pass it as `peerInbox` only when Cowork is enabled, and call `sessionMessaging.drainCoworkInbox(sessionId)` for every Cowork conversation at boot and whenever a workspace incarnation starts. Also call `purgeWorkspace` from the workspace-delete path (from #70).
