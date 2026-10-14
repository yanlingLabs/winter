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
The daemon drains at startup, every second, and after workspace RPCs. No
conversation is fabricated for an unbound workspace; its canonical journal stays
in the workspace database for explicit snapshot/watch handling later.

For each logical conversation, the consumer reads actual JSONL and reconciles
`workspaceChangeId` before appending through SessionHub. It checks an existing
event's safe payload against the immutable change, flushes the log with `fsync`,
then ACKs that exact event sequence in the canonical delivery record. A crash
before append leaves the delivery pending. A crash after append but before ACK
reuses that same event on the next drain/restart. No repeated live announcement
is needed: attached/reconnecting clients replay the durable event with normal
sequence deduplication. Session index rebuild recovers display events and never
recreates canonical conversation bindings or broader workspace grants.

Each conversation delivers at most 100 pending changes in a pass. A missing
session, payload mismatch or append/flush/ACK failure keeps that conversation's
first failed delivery pending and prevents later changes overtaking it. Other
conversations can continue. Host errors are not copied into events. A read/index
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

All five variants are durable history and remote-stream control metadata. They
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
remain later integration work; old phone transports decode event envelopes
opaquely and their existing unknown-event behavior remains unchanged.

## Verification

Pure headless validation uses disposable homes, real SQLite, file-backed session
stores, SessionHub, actual host service mutations and an isolated Unix IPC socket.
Crash injection is confined to the before-append/after-append windows. Coverage
includes tied timestamps with reverse-sorting IDs, two Project conversations,
restart and index rebuild, safe hostile-payload projection, source request/ACK
separation, denied runtime/import authorship, and revoked remote scope.

`pnpm protocol:generate` emits 89 fixtures. Core, protocol and CLI typechecks pass.
The combined affected headless suite passes 404 tests across 15 files. Swift
round-trip/reducer test sources are present but Swift builds, GUI/test-host runs,
compiled-daemon verification, native/VM execution and release/activation were not
performed under this source task's restrictions.
