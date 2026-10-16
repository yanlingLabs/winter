# Cowork same-Project peer-message receipt ledger (unwired)

Status: source and tests only. Nothing in `src/` imports `packages/core/src/cowork/peer-inbox.ts`, there is no
SQLite table, no schema change, no RPC and no protocol event. Cowork creation and the guest topology stay
refused. The ledger is a state machine over an injected `PeerInboxStore` port; the only implementation is an
in-memory store used to prove the semantics.

This slice implements the receipt rules of the specification's "Same-Project SendMessage" section and the
"Session messaging and creation boundaries" contract. It replaces nothing: `agent/session-messaging.ts` still
does the host Code-to-Code delivery with its process-local, ten-minute dedupe, untouched.

Two different "incarnations" appear and must not be confused. `senderIncarnation` names the SENDER's runtime
child and is part of the send identity (the same rule as `session-messaging.ts`: a restarted sender's `msg-1` is
a new message). `PeerEpoch` is the RECIPIENT workspace's guest incarnation plus lease epoch and is the fence on
`offer`, `ack` and `block`.

## What the ledger guarantees

| Spec requirement | Where it is enforced |
| --- | --- |
| "Persist acceptance and assign a stable receipt before returning accepted/queued success" | `accept` writes through `store.append` and returns only afterwards. A store that throws makes `accept` throw `recovery_required` with no store-supplied text; nothing is returned as success and nothing is left behind. |
| Receipt states accepted, delivered, blocked, refused | `PeerReceiptState`. `delivered` and `refused` are terminal; `accepted` and `blocked` are unresolved. |
| "Retries with the same send identity return the retained receipt; conflicting reuse is refused" | Identity is `(sender session, sender runtime incarnation, send id)`. A retry returns `retained` with the existing receipt. A different recipient or text for the same identity throws the existing `request_conflict` code. The compare is on a versioned sha256 over `(recipient, text)`. |
| Same-Project only, host-owned records | `mayContactCoworkPeer` is called at accept, for every unresolved record in each `settle`/`offer` sweep, and at ack. Authority is decided before any cap, so an outsider never learns that an inbox is full. |
| "Archived: refuse automatic wake"; "Deleted or unknown: refuse; do not recreate" | An archived or unknown recipient is refused at accept, with no record and no body. The ledger imports no session table, driver or wake path, so it cannot wake or create anything; `offer` only hands work to whoever runs delivery. |
| "Delivered means the recipient durably acknowledged the input" | `ack` is the only way to `delivered`, and it needs the epoch the message was offered under. |
| "Wake and delivery obey ... incarnation/lease epochs" | `offer`, `ack` and `block` compare against the recipient workspace's current `incarnationId` and `leaseEpoch`, and require the guest to be `starting` or `running` in a `retained` workspace (the predicate of `CoworkRepository.refreshEpoch`). A stale epoch throws the existing `stale_acknowledgment` code and changes nothing. |
| "Retain unresolved/uncertain records until resolved or explicitly canceled" | Unresolved records are never pruned. Growth is bounded by three caps decided inside the store's atomic append (below), and three exits end a record that would otherwise sit: `cancel` (the sender), `discard` (the user, or the host for a provably damaged body) and the automatic `sender_gone` / `not_found` endings. |
| "Bounded retention for terminal deduplication records" | `prune` removes only terminal records: older than a day, then the oldest beyond 100 per recipient (the outbox correction's delivered-receipt figure). The store refuses to remove a non-terminal record. |
| "Runnable queued delivery participates in occupancy; blocked host-only inbox records do not" | `owed(recipient)` counts a record as runnable only while its sender may still send to the recipient right now and it is `accepted` (or parked for authority alone). An archived recipient or sender, and any delivery-owner block, are `blocked`. |
| "Do not promise exactly-once execution" | Not promised. An offer that is never acked is offered again, so delivery is at-least-once until the ack; once acked, a message is never offered again, including after a restart. A pruned send identity is forgotten, and a sender that restarts and replays a message with a new runtime incarnation sends a NEW message (at-least-once across a sender restart, the same as today's in-memory dedupe). |

No new `CoworkErrorCode` was added. Used: `invalid_request`, `request_conflict`, `recovery_required`,
`stale_acknowledgment`, `authority_denied`, `not_found`, `revision_conflict` (store compare-and-set).

## State machine

```
(none) --accept--> accepted --offer--> accepted (attempts+1, offered = recipient epoch)
accepted --ack (epoch == offered == current, authority ok)--> delivered              [terminal]
accepted --block (owner of the current offer: grants | resources | recovery)--> blocked
accepted | blocked --sweep: authority lost--> blocked (authority)
accepted | blocked --sweep: recipient deleted or unknown--> refused (not_found)        [terminal]
accepted | blocked --sweep: sender deleted or unknown--> refused (sender_gone)         [terminal]
accepted | blocked --cancel (the sender)--> refused (canceled)                         [terminal]
accepted | blocked --discard (user)--> refused (discarded)                             [terminal]
blocked (recovery) --discard (host, body provably damaged)--> refused (unrecoverable)  [terminal]
blocked --offer (authority back / retry)--> accepted
delivered | refused --prune (ttl or count)--> removed (dedupe forfeited)
```

A "sweep" is `settle(recipient)` (epoch-free, safe while the workspace is stopped) and the first thing `offer`
does. It evaluates `mayContactCoworkPeer` once per (sender, recipient) pair per pass, so a transient read failure
parks the whole pair and cannot let a later message of the pair overtake an earlier one.

- Refusals at accept (unknown, archived, not permitted, any cap) are returned as `{ outcome: "refused" }` and are
  not persisted. A refused attempt creates no durable state, a denied caller cannot fill the store, and a
  refusal is not sticky: after an explicit restore the same send identity is accepted.
- FIFO is the store-assigned per-recipient sequence, never a timestamp, and it is never reused after pruning or
  a restart. One message is in flight per recipient: `offer` returns the oldest eligible unresolved message, and
  an unacked one is simply offered again.
- Which records are skipped and which hold the queue. Authority is a property of the sender-to-recipient pair, so
  a record parked for lost authority is skipped without reordering that pair and without stalling other
  senders. Every other head holds the queue: a head the delivery owner blocked (grants, resources or recovery)
  is retried first by every `offer` and nothing is offered past it, and a head whose body is missing or fails its
  digest is parked `blocked: recovery` (once; later offers do not rewrite it) with nothing delivered past it. The
  way out of a held head is the delivery owner fixing the cause, the sender's `cancel`, or `discard`.
- Revocation is `blocked`, not `refused`: the record is retained and visible, is not delivered, and is delivered
  later only if authority returns. Archived is not deleted. A deleted or unknown recipient (which can never
  receive it) and a deleted or unknown sender (which can never cancel it) end the record and release its body,
  so a vanished sender cannot leave a record that fills the inbox forever. When both are gone the recipient's
  reason wins. A transient read error is never "gone".
- An ack that finds authority revoked answers `authority_denied`, parks the record and delivers nothing. That is
  the signal for the recipient runtime to discard the input it was holding: the ack is the commit point.
- `block(receiptId, epoch, reason)` is fenced. The record must be `accepted` and offered under `epoch`, and
  `epoch` must still be current; otherwise `stale_acknowledgment`. A stale delivery owner therefore cannot
  un-offer a message the current epoch holds (which used to make the current epoch's ack fail and re-offer in a
  loop). A terminal or already-blocked record is returned unchanged for any caller.
- `discard(receiptId, by)`: `{ kind: "user", principalId }` ends any unresolved record as `discarded` (for a
  sender that stays archived indefinitely); `{ kind: "host", reason: "unrecoverable_body" }` ends a record only
  if its body is provably missing or damaged, as `unrecoverable`. The ledger cannot authenticate a user: the
  wired surface must supply the principal from an authenticated local client, and peers and runtime principals
  must never reach this door.

## Exhaustion bounds

Three caps ride into the store's atomic `append(entry, body, caps)`, so the check and the write are one
operation (the ledger deliberately does not read the queue first, and a test pins that):

| Cap | Default | Refusal |
| --- | --- | --- |
| Unresolved from one sender session to one recipient (any sender incarnation) | 32 | `sender_quota` |
| Unresolved to one recipient | 256 | `inbox_full` |
| Summed body bytes of unresolved to one recipient | 4 MiB | `inbox_bytes_full` |

Checked in that order, after authority. A message is at most 64 KiB, and ill-formed UTF-16 (a lone surrogate)
and blank text are `invalid_request` before anything else, because a UTF-8 store would turn a lone surrogate
into a replacement character and its digest check would then park the head forever. NUL and every other
well-formed character are stored byte-exactly. The caps bound one sender and one recipient's total; many Project
members acting together can still fill one recipient's inbox, which the user clears with `discard`. The numbers
are named constants, not measurements.

## The store port

`PeerInboxStore` is synchronous, like `CoworkRepository` over bun:sqlite, so "persisted before success" is a
property of call order rather than of an `await`. Each method is one atomic step; if it throws, none of it is
visible.

**Durability class: returns means committed.** When a mutating method returns, its effect survives a process kill
and an OS crash or power loss, the class `durableCoworkTransaction` gets from SQLite `synchronous=FULL` with
`fullfsync` and `checkpoint_fullfsync` on Darwin, or stronger. A crash mid-method leaves all of it or none of it:
no torn record, no orphan body. The in-memory store proves the state machine and only the atomicity half of this;
it must never back a production ledger. A unit case cannot show the fsync half, and a hard crash mid-append is the
durable store's own transaction property and needs its own kill test.

- `append(entry, body, caps)` atomically: returns the existing record for the same send identity unchanged
  (no body stored, no cap applied); otherwise checks the caps, then stores the record and the body together,
  assigning the next per-recipient sequence, a body handle and version 1. `size` must equal the body's UTF-8 length.
  A rejected or `full` append leaves no record, body or sequence gap.
- `update` is compare-and-set on `version`. A move to a terminal state releases the body in the same step. A
  terminal record is final.
- `remove` accepts terminal records only. The recipient's sequence counter survives removal and a restart.
- `audit()` reports what a healthy store never has: unresolved records without a body (torn), terminal records
  that still hold a body (leaked) and bodies no record references (orphans). The ledger does not call it; a
  durable store should run it at open, and it is the cleanup hook for stray bodies.
- Returned records are copies.

`test/cowork/peer-inbox-conformance.ts` exports `peerInboxStoreConformanceCases()`: sixteen cases a durable store
must pass, run today against the in-memory store with a `reopen` that models a restart. They cover the above plus
body fidelity (multibyte text, NUL, 64 KiB, also after a reopen), caps inside `append`, an append that fails at
every internal write leaving no torn record, orphan body or sequence gap (via the required `failAppendAtStep`
hook, which a SQLite store supplies by throwing inside its transaction after the n-th statement), the sequence never being reused after remove, reopen and append, and two live instances interleaving
appends, identities, compare-and-set and caps over one state. A future SQLite store adds one line to its own test
file; the ledger tests then run unchanged over it.

## Owner decision 1: a new table, or reuse `cowork_operations` idempotency

Read of the current schema: `cowork_operations` is `UNIQUE(principal_id, method, scope, request_id)` with a
`request_digest`, a workspace id, a status in `pending | applied | blocked | failed | superseded` and an
immutable `result_json`. It is written only by `CoworkRepository.mutate`, which also requires
`expectedRevision == configRevision` and publishes a `cowork_outbox` change to every conversation of the workspace.
PR #46 takes the schema to 16, so a new table would be schema 17.

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

What adopting the table drags in, which PR #46 establishes and this slice must not forget:

- The table joins `COWORK_TABLES` in `cowork/schema.ts`. That list drives Migration B's `cowork_storage_present`
  refusal (a populated Cowork table in a legacy source refuses the copy) and the schema downgrade rule ("a v8..v16
  store may roll back only while every Cowork table is empty; populated authority must be retained"). A populated
  inbox is owed delivery and must be retained the same way, so the downgrade function and its type need the new
  version, and the migration ladder and `RUNTIME_STATE_SCHEMA_VERSION` move to 17.
- Message bodies need a backup decision of their own. The runtime-state database is an ordinary backup target;
  bodies are other agents' prompts, and the storage contract already excludes the private VM images from Time
  Machine. If bodies live in that database they are backed up with it unless they are kept in an excluded file;
  either way the exclusion, and whether a restored backup may replay an old owed message, must be decided with
  the store (a restored database could redeliver a message the recipient already acknowledged).

The migration should land with the store that uses it, not before: this slice deliberately ships no DDL. Reuse
the repository's idempotency idea (key plus versioned digest), not its table. The decision for the owner is
also whether the table lives in the Cowork repository transaction (preferred: acceptance and the `owed` occupancy
count then commit with other Cowork state, and `durableCoworkTransaction` fsync rules apply) or in a store of
its own.

## Owner decision 2: how the message text is persisted

The specification already requires owed delivery to be durable ("peer delivery survives a stopped recipient and
daemon restart without creating a new identity", `cowork-spec.md` line 310, plus "Accepted means the daemon owes
delivery"), and the sender does not retransmit, so the text has to exist durably while it is owed. Whether to
persist it is therefore settled; what remains open is placement, encryption at rest, backup exclusion and cleanup.
This slice keeps all four with the store and constrains only the shape:

- the record holds a digest and a size only;
- the body goes through the port in the same atomic `append` and is addressed by an opaque store-issued handle;
- the body is released in the same step that makes the record terminal, so terminal dedupe records hold no text;
- reading the body back verifies the digest, so a damaged body parks the head rather than delivering wrong text;
- `audit()` finds a leaked or orphaned body for cleanup;
- the receipt returned to the sender carries no text, digest, handle or queue position.

**Recommendation: persist the body only while the message is owed**, as above, with the 64 KiB cap and the byte
budget, never in terminal records. Open for the owner at the store: whether the body sits in the same database as
the record or in a separate protected file (the handle supports both), whether it is encrypted at rest, how it is
excluded from backups (see decision 1) and what sweeps an orphan. The conversation transcript of the recipient
will hold the text after delivery regardless.

## Other judgments for the reviewer

- Send identity includes the sender's runtime incarnation, as the existing dedupe does. If runtime message ids
  are globally unique the incarnation is harmless; if they are counters, dropping it would make a restarted
  sender's first message look like a retry. Needs confirmation of how the runtime mints `messageId`. Consequence:
  a sender that restarts and replays a message gets a second delivery (at-least-once across a sender restart).
- When the SDK's optional `summary` and `notifyWhenIdle` request fields are wired through (`session-messaging.ts`
  carries both), they are part of the message: they must be added to the persisted payload and to the digest
  under a new `DIGEST_VERSION`, or a retry that changes them would be silently deduped. The digest today covers
  `(recipient, text)` only.
- The ledger authorizes SENDING; it does not know who is calling its other methods. At the wired surface,
  `lookup` and `cancel` must be tied to the authenticated sender, while
  `pending`, `owed`, `settle`, `offer`, `ack` and `block` belong to the delivery owner and the recipient's user
  client, and `discard` to an authenticated local user. Each of these takes caller-supplied ids and needs its own
  authority check there.
- Ordering is FIFO per recipient among messages that are eligible, which is a per-(sender, recipient) FIFO in
  practice: a message parked for lost authority is skipped, so when that sender's authority returns its older
  message is delivered after a later message from another sender. Strict whole-queue FIFO would let one revoked
  sender stall the recipient indefinitely.
- A retry of an already-accepted message is answered from the retained receipt even if the sender has since
  lost authority (it discloses nothing new to the sender). New accepts always re-check.
- `recipient_archived` is disclosed only to a current active member of the same Project and workspace; everyone
  else gets the uniform `not_found`, matching host messaging's uniform not-found.
- Revocation is `blocked`, archived-at-deliver is `blocked`, and a deleted recipient or sender is `refused`. The
  spec says "refuse automatic wake"; retaining the message and refusing the wake is this slice's reading.
- `settle` and `offer` park lost-authority records before they check the caller's epoch, so a stale delivery
  owner can still cause lost-authority records to be parked (never delivered). Parking is a fact about host
  records, not about the caller's epoch, and `settle` needs no epoch at all.
- The conformance suite is a test helper, not an export of `peer-inbox.ts`, because it uses `bun:test`'s `expect`.
- Limits (64 KiB, 32 / 256 / 4 MiB, 100 terminal, one day) are named constants, not measured numbers.
- The `cowork_delivery_updated` event in the host protocol has no producer yet; the receipt view is shaped to
  feed it (state, reason, attempts) without leaking the body.

## Not covered

Wake and restore of the recipient workspace, the SDK mailbox and steer/fold delivery into a running turn,
guest caller transport, the runtime channel that authenticates sender and incarnation, `cowork_delivery_updated`
events, transcript/output fences, a durable store, the schema migration and any RPC. The delivery owner will
call `offer` once it holds a current epoch, hand the body to the recipient and relay the recipient's ack to
`ack`.

## Evidence

`packages/core/test/cowork/peer-inbox.test.ts` (43 tests: 26 ledger tests, the sixteen store conformance cases
and the anti-wiring pin), with real `CoworkRepository` records so the real `mayContactCoworkPeer` runs. Mutation
checks (apply, run, see the named test fail, revert) are recorded in the pull request.
