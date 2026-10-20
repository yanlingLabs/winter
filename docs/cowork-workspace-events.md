# Durable workspace notifications

`CoworkWorkspaceEvents` is a daemon-owned source implementation for delivering
canonical workspace outbox rows into each affected logical conversation's real
SessionHub/JSONL stream. It does not activate Cowork creation, guest execution,
mounts, native workers or workspace watches. Existing production admission
refusals and native execution holds remain independent.

## Commit, append and acknowledgement

Workspace mutations commit their authority changes, operation receipt, safe
change snapshot and per-conversation outbox deliveries together in runtime-state
SQLite. `pendingChanges` reads commit sequence, never timestamps or minted IDs.
The daemon drains at startup, every second, and after workspace RPCs. Canonical
binding requires an explicit trusted committed-session port. The actual store
adapter requires a completed initial event/index row outside an open index
transaction; creation must commit before synchronous bind, with the same store
still open and no await/reentrant lifecycle operation in between. This is ordering
across two databases, not a cross-store atomic transaction. The actual production
Cowork session create/bind caller remains unimplemented. No
conversation is fabricated for an unbound workspace; its canonical journal stays
in the workspace database for explicit snapshot/watch handling later.

For each logical conversation, the consumer reads actual JSONL and reconciles
`workspaceChangeId` before appending through SessionHub. It checks an existing
event's safe payload structurally against the immutable change, requests the reviewed
Darwin file and held-directory `F_FULLFSYNC` flushes,
then ACKs that exact event sequence in the canonical delivery record. Canonical
Cowork writes and ACK/cleanup transactions use the shared scoped FULL/fullfsync
wrapper and restore previous connection settings before returning. Ordinary Code
keeps the existing global SQLite defaults. Read-back and completed OS requests are
configuration/ordering evidence, not hardware power-cut proof. A crash
before append leaves the delivery pending. A crash after append but before ACK
reuses that same event on the next drain/restart. No repeated live announcement
is needed: attached/reconnecting clients replay the durable event with normal
sequence deduplication. Session index rebuild recovers display events and never
recreates canonical conversation bindings or broader workspace grants.

Each conversation delivers at most 100 pending changes in a pass. Host session
deletion tombstones its canonical conversation binding and removes its delivery
rows, preserving the workspace, sources, operation receipts and guest data. A
post-recovery missing index row is terminally retired too; a missing or unreadable
log with an existing row is a recovery failure, never grounds to recreate storage.
Deleted conversations cannot accumulate new fanout. A live payload mismatch or
append/flush/ACK failure keeps its first failed delivery pending, prevents later
changes overtaking it, and backs off retries from one second to five minutes.
Retry timing uses a monotonic clock. Drain reports backed-off sessions as
`deferred`, while post-ACK retention failures report `pruneBlocked` independently.
Other conversations continue. Keep the latest 100 delivered receipts per logical
conversation; prune older journal rows only after no conversation delivery still
references them. Journal entries created without any conversation are retained. Host errors are not copied into events. A read/index
sequence inconsistency requires session-store recovery before ACK; the consumer
does not silently repair authority from an event stream.

## Safe event contract

Every event contains `workspaceId`, `workspaceChangeId`, `operationId` and
`workspaceRevision` in the standard `{seq, sessionId, ts}` envelope.

- `workspace_sources_changed` carries source identity/revision, desired and
  recorded readiness, ACK revision, restart requirement and bounded reason.
  `requested` is a metadata mutation; `acknowledged` records the controller's
  accepted exact-source ACK. Neither is independent VM execution evidence.
  Older outbox rows without captured snapshots produce an empty `refetch` hint,
  rather than attributing today's source state to an older change.
- `workspace_policy_changed` carries stored policy/default/publication revisions
  and enums. Its phase is `metadata`; it cannot declare installation of a narrower
  tool view, rewrite a conversation's policy, or enable execution. Canonical
  ceiling details require the explicit workspace policy read.
- `workspace_operation_changed` carries a typed outcome and terminal/replacement
  identity. A superseded operation stays terminal regardless of later source ACKs.
- `workspace_metadata_changed` is a bounded created/display/lifecycle/binding
  change hint. Display text and full records require an explicit authorized read.
- `workspace_instructions_changed` carries instruction revision, digest and
  current/refresh-required/unavailable status. The independent instruction owner
  must commit this payload with its canonical instruction metadata using the same
  repository outbox transaction. This slice supplies delivery/schema/folding;
  it does not implement instruction storage or its mutation API.

No event carries labels, backing paths, bookmarks, credentials, full guidance or
unrestricted configuration. Source/policy snapshots are captured by the host at
mutation commit rather than looked up later by the delivery consumer. The event
schemas bound identities and array size; remote streams also retain their normal
serialized-event caps.

## Client and trust boundaries

All five variants are ordinary durable SessionEvents admitted to history and
remote streams. They are not members of the stream-control event-type set. They
are excluded from model-greppable subagent transcripts and from SDK projection.
`sync.push` and `SessionStore.appendSynced` reject both parsed and raw attempts to
import these host-owned event variants. No RPC methods or remote mode eligibility
were added; the existing four method allowlists remain unchanged.

Remote session reads and list filtering consult the current canonical workspace
scope for bound conversations. Live/replay delivery rechecks that scope for each
frame, including the event's matching workspace identity. Removing scope stops
further delivery and denies subsequent history/attach; having a pairing token
alone is insufficient. Actual Cowork mode admission remains gated separately.

Swift enum mirrors, WinterClient sequence/session accessors and canonical
fixtures are included. The Mac reducer records source/policy/operation/instruction
metadata separately from agent execution state and marks details for refetch.
Workspace UI/watch assembly and the separate iOS application's cache/rendering
remain later integration work. Source inspection confirms the old `v-web-kit1`
phone transport decodes opaque JSONValue envelopes, and current iOS transcript
folds skip unknown types. Current iOS cacheableTypes does not cache these metadata
variants: a history page consisting entirely of them can leave its older-page
cache floor unchanged, causing repeated refetch rather than rendering metadata.
This is a known version-skew limitation, not full old-client feature compatibility.

Strict Swift SessionEvent decoding does throw on an unknown discriminator, but
WinterKit's `parseServerLine` catches that per frame and returns `unknownEvent`;
WinterClient emits unknown without closing the transport. Its transport loop
continues routing subsequent lines. This is source evidence only; Swift tests
remain deferred.

## Verification

Pure headless validation uses disposable homes, real SQLite, file-backed session
stores, SessionHub, actual host service mutations and an isolated Unix IPC socket.
Crash injection is confined to the before-append/after-append windows. The reviewed
file/directory helper succeeds on actual disposable APFS descriptors, not mocked
flush outcomes; successful OS requests are not hardware power-cut proof. Coverage
includes tied timestamps with reverse-sorting IDs, two Project conversations,
restart and index rebuild, safe hostile-payload projection, source request/ACK
separation, denied runtime/import authorship, and revoked remote scope.

`pnpm protocol:generate` emits 89 fixtures. Core, protocol and CLI typechecks pass.
The frozen baseline passed 404 tests across 15 files; durability/review corrections
previously passed 413 tests across 16 files. Follow-up committed-binding and
maintenance review now passes 660 tests with 2 explicit skips across 26 files,
including actual owned-FD flush, scoped SQLite setting restoration,
deleted-session cleanup, monotonic retry metrics, pruning isolation, structural
replay and genuine external-connection context revalidation. Swift
round-trip/reducer test sources are present but Swift builds, GUI/test-host runs,
compiled-daemon verification, native/VM execution and release/activation were not
performed under this source task's restrictions.

The Cowork-only log flush path explicitly refuses hosts other than Darwin/arm64.
It has no filesystem-type check: failed OS flush requests refuse ACK without
fallback. Only actual disposable APFS requests were measured; other filesystems,
including ExFAT/SMB rejection, remain unverified.
