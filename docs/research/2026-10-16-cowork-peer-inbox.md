# Cowork same-Project peer-message receipt ledger (unwired)

Status: source and tests only. Nothing in `src/` imports `packages/core/src/cowork/peer-inbox.ts`, there is no
SQLite table, no schema change, no RPC and no protocol event. Cowork creation and the guest topology stay
refused. The ledger is a state machine over an injected `PeerInboxStore` port; the only implementation is an
in-memory store used to prove the semantics.

This slice implements the receipt rules of the specification's "Same-Project SendMessage" section and the
"Session messaging and creation boundaries" contract. It replaces nothing: `agent/session-messaging.ts` still
does the host Code-to-Code delivery with its process-local, ten-minute dedupe, untouched.

## What the ledger guarantees

| Spec requirement | Where it is enforced |
| --- | --- |
| "Persist acceptance and assign a stable receipt before returning accepted/queued success" | `accept` writes through `store.append` and returns only afterwards. A store that throws makes `accept` throw `recovery_required` with no store-supplied text; nothing is returned as success and nothing is left behind. |
| Receipt states accepted, delivered, blocked, refused | `PeerReceiptState`. `delivered` and `refused` are terminal; `accepted` and `blocked` are unresolved. |
| "Retries with the same send identity return the retained receipt; conflicting reuse is refused" | Identity is `(sender session, sender runtime incarnation, send id)`, the same scoping as the existing in-memory dedupe. A retry returns `retained` with the existing receipt. A different recipient or text for the same identity throws the existing `request_conflict` code. The compare is on a versioned sha256 over `(recipient, text)`. |
| Same-Project only, host-owned records | `mayContactCoworkPeer` is called at accept, at every deliver candidate (`offer`) and at ack. The caller's identity is a host-derived argument, never read from the message. |
| "Archived: refuse automatic wake"; "Deleted or unknown: refuse; do not recreate" | An archived or unknown recipient is refused at accept, with no record and no body. The ledger imports no session table, driver or wake path, so it cannot wake or create anything; `offer` only hands work to whoever runs delivery. |
| "Delivered means the recipient durably acknowledged the input" | `ack` is the only way to `delivered`, and it needs the epoch the message was offered under (see below). |
| "Wake and delivery obey ... incarnation/lease epochs" | `offer` and `ack` both compare against the recipient workspace's current `incarnationId` and `leaseEpoch` (same predicate as `CoworkRepository.refreshEpoch`). A stale epoch throws the existing `stale_acknowledgment` code and changes nothing. |
| "Retain unresolved/uncertain records until resolved or explicitly canceled" | Unresolved records are never pruned. Growth is bounded by refusing new sends at 256 unresolved per recipient (`inbox_full`), and `cancel` is the sender's explicit exit. |
| "Bounded retention for terminal deduplication records" | `prune` removes only terminal records: older than a day, then the oldest beyond 100 per recipient (the outbox correction's delivered-receipt figure). The store refuses to remove a non-terminal record. |
| "Runnable queued delivery participates in occupancy; blocked host-only inbox records do not" | `owed(recipient)` reports `runnable` and `blocked` separately. |
| "Do not promise exactly-once execution" | Not promised. An offer that is never acked is offered again, so delivery is at-least-once until the ack; once acked, a message is never offered again, including after a restart. A pruned send identity is forgotten. |

No new `CoworkErrorCode` was added. Used: `invalid_request`, `request_conflict`, `recovery_required`,
`stale_acknowledgment`, `authority_denied`, `not_found`, `revision_conflict` (store compare-and-set).

## State machine

```
(none) --accept--> accepted --offer--> accepted (attempts+1, offered = recipient epoch)
accepted --ack (epoch == offered == current, authority ok)--> delivered   [terminal]
accepted --block (deliverer: grants | resources | recovery)--> blocked
accepted | blocked --offer finds authority lost--> blocked (authority)
accepted | blocked --offer/ack finds the recipient gone--> refused (not_found)   [terminal]
accepted | blocked --cancel (sender)--> refused (canceled)                      [terminal]
blocked --offer (authority back / retry)--> accepted
delivered | refused --prune (ttl or count)--> removed (dedupe forfeited)
```

- Refusals at accept (unknown, archived, not permitted, inbox full) are returned as `{ outcome: "refused" }`
  and are not persisted. A refused attempt therefore creates no durable state, a denied caller cannot fill
  the store, and a refusal is not sticky: after an explicit restore the same send identity is accepted.
- FIFO is the store-assigned per-recipient sequence, never a timestamp, and it is never reused after pruning.
  One message is in flight per recipient: `offer` returns the oldest eligible unresolved message, and an
  unacked one is simply offered again. Authority is a property of the sender-to-recipient pair, so a message
  parked for lost authority is skipped without reordering that pair and without stalling other senders.
  Anything else that goes wrong with a message (a missing or digest-mismatched body) blocks and stops the
  queue, so nothing is ever delivered past a damaged record.
- Revocation is `blocked`, not `refused`: the message is retained and visible, is not delivered, and is
  delivered later only if authority returns. Only a deleted/unknown recipient (which can never receive it) or
  an explicit cancel ends it.
- An ack that finds authority revoked answers `authority_denied`, parks the record and delivers nothing. That
  is the signal for the recipient runtime to discard the input it was holding: the ack is the commit point.

## The store port

`PeerInboxStore` is synchronous, like `CoworkRepository` over bun:sqlite, so "persisted before success" is a
property of call order rather than of an `await`. Each method is one atomic step; if it throws, none of it is
visible.

- `append(entry, body)` atomically stores the record and the body, assigns the next per-recipient sequence and
  a body handle, or returns the existing record for the same send identity without storing anything.
- `update` is compare-and-set on `version`. A move to a terminal state releases the body in the same step. A
  terminal record is final.
- `remove` accepts terminal records only. The recipient's sequence counter survives removal.
- Returned records are copies.

`test/cowork/peer-inbox-conformance.ts` exports `peerInboxStoreConformanceCases()`: ten cases a durable store
must pass, run today against the in-memory store with a `reopen` that models a restart. A future SQLite store
adds one line to its own test file; the ledger tests then run unchanged over it.

## Owner decision 1: a new table, or reuse `cowork_operations` idempotency

Read of the current schema: `cowork_operations` is `UNIQUE(principal_id, method, scope, request_id)` with a
`request_digest`, a workspace id, a status in `pending | applied | blocked | failed | superseded` and an
immutable `result_json`. It is written only by `CoworkRepository.mutate`, which also requires
`expectedRevision == configRevision` and publishes a `cowork_outbox` change to every conversation of the workspace. PR #46 takes the schema to 16, so a new table would be schema 17.

Reuse looks attractive because the conflict rule matches (same key, different digest, `request_conflict`) and
the status names map (`pending` = accepted, `applied` = delivered). It does not fit the rest:

1. No ordering key. FIFO per recipient needs a durable, gap-tolerant sequence that survives pruning
   (`cowork_outbox` has an `AUTOINCREMENT` sequence; `cowork_operations` has no sequence column and only the
   repository clock's ISO-8601 text timestamps, which can tie within a millisecond). Ties would reorder messages.
2. The wrong write path. A peer message is not a workspace configuration mutation. Pushing it through `mutate`
   makes every message demand the workspace's current config revision (a concurrent source edit would
   `revision_conflict` a chat message) and fan an outbox change out to every conversation.
3. Receipts there are immutable ("retried mutation receipts remain immutable; current status is separately
   queryable"). The ledger's record changes state (accepted to delivered), carries the offered epoch and a body
   handle, and must release the body at the terminal state. Those are updates, not receipts.
4. No retention. Nothing deletes from `cowork_operations`. The spec requires bounded terminal retention, so the
   table would need its own pruning rules with a terminal/non-terminal split it does not have.
5. Wrong principal. The idempotency scope there is a user principal and a request id. The peer identity is a
   session, its runtime incarnation and a send id, and the lookup that matters is per recipient. Encoding that
   into `scope`/`request_id` strings would leave the recipient queue unindexed.
6. Message traffic would share a table and its backup/export surface with workspace configuration receipts,
   and `workspace.operation.get` would have to learn to hide message records.

**Recommendation: a new table at schema 17**, one row per accepted send, with:

- `UNIQUE(sender_session_id, sender_incarnation, send_id)` for the identity;
- a recipient index over `(recipient_session_id, sequence)` with the sequence from a per-recipient counter
  row (not `MAX(sequence)+1`, which reuses a number after a prune);
- the columns of `PeerInboxRecord`;
- the body in a separate table or file keyed by the handle, so it can be dropped without touching the receipt.

The migration should land with the store that uses it, not before: this slice deliberately ships no DDL.
Reuse the repository's idempotency idea (key plus versioned digest), not its table. The decision for the owner
is whether the table lives in the Cowork repository transaction (preferred: acceptance and the `owed`
occupancy count then commit with other Cowork state, and `durableCoworkTransaction` fsync rules apply) or in
a store of its own.

## Owner decision 2: is the message text persisted

The specification is silent on persisting the text. "Accepted means the daemon owes delivery" cannot survive a
daemon restart without it, because the sender does not retransmit; the text must exist somewhere durable until
delivery. This slice therefore treats the text as owed-delivery state, not as a record:

- the record holds a digest and a size only;
- the body goes through the port in the same atomic `append` and is addressed by an opaque store-issued handle;
- the body is released in the same step that makes the record terminal, so terminal dedupe records hold no text;
- reading the body back verifies the digest, so a damaged body blocks the queue rather than delivering wrong text;
- the receipt returned to the sender carries no text, digest, handle or queue position.

**Recommendation: persist the body only while the message is owed, as above**, with a hard 64 KiB cap, and
never keep it in terminal records. The alternative of never persisting the text means an accepted message is
lost on restart, which contradicts "durable peer delivery survives a stopped recipient and daemon restart".
Open question the owner may want to decide at the store: whether the body sits in the same database as the
record or in a separate protected file (the handle supports both), and whether it is encrypted at rest. The
conversation transcript of the recipient will hold the text after delivery regardless.

## Other judgments for the reviewer

- Ordering is FIFO per recipient among messages that are eligible, which is a per-(sender, recipient) FIFO in
  practice: a message parked for lost authority is skipped, so when that sender's authority returns its older
  message is delivered after a later message from another sender. Strict whole-queue FIFO would let one
  revoked sender stall the recipient indefinitely. A damaged body is the one case that still stops the queue.
- The store conformance suite is a test helper (`test/cowork/peer-inbox-conformance.ts`), not an export of
  `peer-inbox.ts`, because it uses `bun:test`'s `expect`. A durable store's test imports it from there.
- `block(receiptId, reason)` is the delivery owner's door and carries no sender or epoch check (unlike `cancel`,
  which needs the sender identity). It must stay an internal, host-only call; whether it should also be fenced
  by the epoch is for the reviewer.
- `offer` re-checks authority for each candidate before it checks the caller's epoch, so a stale delivery owner
  can still cause lost-authority records to be parked. That is a fact about host records, not about the
  caller's epoch, and parking never delivers anything.
- Send identity includes the sender's runtime incarnation, as the existing dedupe does ("a restarted
  coordinator's `msg-1` is a NEW message"). If runtime message ids are globally unique, the incarnation is
  harmless; if they are counters, dropping it would make a restarted sender's first message look like a
  retry. Needs confirmation of how the runtime mints `messageId`.
- A retry of an already-accepted message is answered from the retained receipt even if the sender has since
  lost authority (it discloses nothing new to the sender). New accepts always re-check.
- `recipient_archived` is disclosed only to a current active member of the same Project; everyone else gets
  the uniform `not_found`, matching host messaging's uniform not-found.
- Revocation is `blocked`, archived-at-deliver is `blocked`, and a deleted recipient is `refused`. The spec
  says "refuse automatic wake"; retaining the message and refusing the wake is this slice's reading.
- Limits (64 KiB, 256 unresolved, 100 terminal, one day) are named constants, not measured numbers.
- The `cowork_delivery_updated` event in the host protocol has no producer yet; the receipt view is shaped to
  feed it (state, reason, attempts) without leaking the body.

## Not covered

Wake and restore of the recipient workspace, the SDK mailbox and steer/fold delivery into a running turn,
guest caller transport, the runtime channel that authenticates sender and incarnation, `cowork_delivery_updated`
events, transcript/output fences, a durable store, the schema migration and any RPC. The delivery owner will
call `offer` once it holds a current epoch, hand the body to the recipient and relay the recipient's ack to
`ack`.

## Evidence

`packages/core/test/cowork/peer-inbox.test.ts` (25 tests: 14 ledger tests, the ten store conformance cases and the
anti-wiring pin), with real `CoworkRepository` records so the real `mayContactCoworkPeer` runs.
Mutation checks (apply, run, see the named test fail, revert) are recorded in the pull request.
