# Local workspace subscriptions — source and disposable RPC evidence

Implemented against accepted `docs/cowork-host-protocol.md` subscription/table
contract, on `cowork/workspace-watch-local` based on verified merged
`f60298bb90efe103a54265a1f7dca8518a61f891` in
`.worktrees/core-workspace-watch-local`. This is local Unix RPC and a TypeScript
consumer. Cowork execution/provisioning and paired subscription transport remain
unavailable. No session mode, availability flag, SDK pin, native/VM or held path
was changed. Kernel worktree checkpoint `70cbb813` remains frozen.

`workspace.watch` takes 1–32 distinct workspace IDs; no wildcard, client-authored
principal or session ID is accepted. It returns an opaque subscription ID, lease
expiry and 20,000ms recommended renewal interval. Notifications use the separate
JSON-RPC method `workspace.watch`, with `snapshot`, `change` and `ended` phases and
an independent ephemeral sequence starting at 1. Snapshot is emitted once per ID
and carries the same safe complete/summary projection as `workspace.get`.
Changes are coalesced by a 100 ms trailing window and become eligible after
500 ms of continuous dirty state; a dirty scope remains pending
through later commits and slow-writer pauses. The clean-to-dirty timestamp is
retained until canonical delivery/no-change resolution, and an already armed
earlier timer is kept. Snapshot/read attempts stay at least 100 ms apart, including
after transient read failure; the 500 ms eligibility threshold does not weaken authorization
or discharge dirty state after a blocked send. Idle drain calls return before safe
snapshot/authorization reads when no dirty state or initial snapshot is pending.
Changes carry only current workspace revisions; consumers refetch canonical
`workspace.get`/detail pages, even for lifecycle/operation changes whose desired
config revision has not advanced. Raw outbox records, global outbox positions,
bookmarks, host roots, backing paths, grant/account/repository authority handles
and guest incarnation identifiers are never sent.

Snapshots/revisions/outbox positions are read together inside a canonical
runtime-state.db transaction. Successful outer `transaction()` writes through that daemon-owned
`RuntimeStateDb` handle notify watchers after commit. A rolled-back outer transaction and pure reads do not emit; nested transactions
are observed only through their successful outer commit. Multiple repository instances sharing that handle are
covered, including source ACK and operation changes without a configRevision
advance. Direct SQL/autocommit calls through raw `db`, including the same handle, and
external-process writers are invisible to this observer and are not supported live
watch producers; reconnect always snapshots current canonical state. There is no
workspace polling, fake conversation, transcript use or `$system` replay.
SQLite `total_changes()` counts writes later rolled back to a savepoint. If an
outer transaction catches that rollback and commits, it can cause a spurious
advisory signal; snapshot/signature filtering prevents a fabricated change frame.
While a watch exists, an outer `transaction()` performs two `total_changes()`
queries (before/after); there is no such observer-query cost without active watches.
Periodic maintenance checks current workspace authorization and leases only.
The commit observer is registered only while at least one watch exists; an idle
registry adds no commit queries. Each timer checks its own lease rather than
repeatedly scanning all subscriptions.

A subscription captures host-derived local principal ID plus connection ID/role;
current per-workspace authorization is rechecked at enrollment, each stream
delivery, renewal and maintenance. Unknown/unsupported records, deleting/deleted
workspaces, disappeared access and a changed principal fail closed for the whole
subscription. Local detach remains available for the original connection after
access revocation. Remote/plugin/runtime cannot use this local stream.

Each connection can own four watches. The existing IPC `maxConnections` bounds
all registry subscriptions: at the default 64 connections, at most 256 watches and
8,192 enrolled ID/signature entries. An explicit host increase to that existing
connection cap increases this bound proportionally; no new product quota is added. Each watch stores at most 32 IDs/signatures,
an initial snapshot-ID queue of at most 32, and one saturating commit counter.
It never queues outbox payloads or historical frames. More than 128 coalesced write
notifications before delivery marks overflow. It emits `refetchRequired=true`
only for subscribed workspaces whose current signature differs from the delivered
signature. An unrelated burst does not create hints for unchanged workspaces. A slow writer pauses delivery above 128KiB buffered bytes;
its socket drain resumes from current safe DB state after the coalescing deadline.
An oversized frame ends the subscription with a bounded `ended/unavailable` frame
instead of silently dropping the server lease. Transient read errors preserve
pending state/refetch requirement and schedule at most two 100 ms retry timers;
after that, the next commit/drain/renew can retry, and normal lease expiry applies.
Only authority/not-found refusal ends on a read error; no stale snapshot is sent. Fully encoded local JSON-RPC
notifications are checked against 256KiB; existing bounded workspace projections
leave frame overhead room. The paired 512KiB outer WireEnvelope contract is not
claimed or implemented by this lane.

A 60,000ms monotonic lease is enforced independently of displayed wall-clock expiry.
The TS `WinterClient.watchWorkspaces` consumer installs separate watch notification
handling and automatically renews after 20,000ms. Automatic renewal requests do not overlap;
detach, terminal notification or disconnect cancels further automatic renewal.
Malformed watch frames and renewal failures are reported through
`onWorkspaceWatchError`, with sanitized parser errors. Transient renewal failures
have at most two retries, after 1 second and 2 seconds, bounded by a conservative
monotonic lease deadline captured before the accepted request. Authority refusal,
terminal/disconnect, exhaustion or expiry cancels renewal. Retries use the same
subscription ID; they never open a replacement or resurrect an expired server
lease. The real 20-second timer test remains distinct from accelerated retry tests. Close,
expiry, access revocation and daemon shutdown release all server lease state.
Reconnect uses a new connection/subscription ID and fresh sequence/snapshot; old
IDs cannot control the new stream. Shutdown releases watches before closing the
Unix listener; terminal delivery is best effort if the transport is already lost.

All three methods deliberately remain absent from `COWORK_REMOTE_METHODS` and the
four paired allowlist mirrors. The Gateway `workspace_watch` wire kind, negotiation,
phone transport-generation cleanup and paired consumers are a separate reviewed
slice. There is no claim of full remote support or phone E2E.

Tests use disposable homes, FileSecretStore, isolated coordination injected by the
core test preload, and `agentProvider:null`. Existing records are created through
the canonical repository only; provisioning is explicitly refused. No real
credentials, GUI, live app/daemon/home/Keychain, VM or worker is involved.

Validation commands (from packages/core unless noted):

```sh
bun test ./test/cowork/watch.test.ts \
  ./test/ipc/cowork-workspace-watch.test.ts \
  ./test/ipc/cowork-workspace-api.test.ts \
  ./test/ipc/remote-allowlist-parity.test.ts \
  ./test/cowork/repository.test.ts \
  ./test/runtime-state/db.test.ts ./test/runtime-state/leases.test.ts
# Protocol package: bun test
# CLI package: bun test ./test/cowork-cli.test.ts
# Repository root:
bun node_modules/typescript/bin/tsc --noEmit -p packages/core
bun node_modules/typescript/bin/tsc --noEmit -p packages/protocol
bun node_modules/typescript/bin/tsc --noEmit -p packages/cli
git diff --check
```

Baseline145 verification: 91 focused Core tests / 980 assertions, 241 protocol
tests / 1,087 assertions and 13 existing Cowork CLI tests / 141 assertions pass,
with no skips in these commands. The focused set includes the real 20-second
client timer/Unix renewal, disconnect/detach-before-acceptance race, independently
scoped concurrent Projects and maximum JSON escaping/legacy summary bounds.
Core/protocol/CLI TypeScript checks and diff whitespace check pass. This is local
RPC/source evidence, not a full Core suite, compiled release or phone/VM E2E.
Receipts and logs are retained under `out/workspace-watch/`.

The existing frozen pnpm lockfile is stale against the base manifest. Offline
installation was attempted without scripts or lockfile edits and could not
resolve a missing cached tarball. Validation uses source-bound workspace links to
existing cached Bun 1.3.14/TypeScript 5.9.3 dependencies, with worktree protocol/Core
imports resolving into this exact worktree. No dependency pin or lockfile changed,
and no package/artifact download or install script ran.

Root independent verification and Claude45 SOURCE review remain required before
ordinary feature-branch publication. No push or release is part of this checkpoint.


## W1–W7 review correction

Parent-relayed exact SOURCE acceptance conditions are implemented over the preserved
`145d3eaf3c257a9e047ee91f098ac2b0a4d8e82b` baseline. The narrow successor changes
watch coalescing, error handling, consumer retries/tests and this evidence record.
Paired support, VM/worker execution and production activation remain unavailable;
no PR/push is part of the correction. Fresh exact re-review is required.

Correction verification: 100 focused Core tests / 1,012 assertions and 13 existing
Cowork CLI tests / 141 assertions pass with no skips. Core/CLI TypeScript and
whitespace checks pass; the protocol source is unchanged from the baseline241-test
pass. Corrected tests cover trailing delay/idle reads, bounded oversize termination,
transient-read retention and two retry timers, unrelated overflow, raw autocommit
and savepoint semantics, malformed-frame errors, transient renewal retries and
permanent refusal. The real 20-second Unix renewal test also passes. Accelerated
retry tests exercise client scheduling/failure classification against the actual
isolated Unix lease; the malformed decoder test is a bounded local socket double,
not canonical daemon execution evidence. Logs/receipts are retained under
`out/workspace-watch/w-correction-*`.


## W1b fair delivery correction

The pure trailing debounce at `b19198ea1b52130cf6b63aaf1e8f13d560b16fb4`
could defer hints indefinitely under sustained commits. This narrow successor
preserves `145d3eaf` and `b19198ea`, captures `firstDirtyAt` on clean-to-dirty,
keeps already armed wakeups, and permits a read at trailing quiet or after
500 ms from first dirty. The 100 ms callback cadence can place delivery on the next
tick: within 600 ms in a healthy, unblocked scope, before ordinary host scheduler
and transport delay. Read failures/backpressure retain debt and can extend observed
delivery; this is not a universal wall-clock latency guarantee. Every actual safe read still checks current authority
and is spaced by at least 100 ms; backpressure/transient errors retain pending
state/refetch debt. W2–W7 behavior and authority/transport limits are preserved.

The fairness regression uses the production timer callbacks with a controlled
monotonic clock and actual canonical DB writes every 50 ms for 2 seconds. It
asserts delivery by 500 ms in that aligned schedule while writes continue, minimum read/
delivery spacing, and final revision delivery. A separate real-time Unix RPC
regression also writes every 50 ms for 2 seconds and checks delivery during the
burst (650 ms observation bound includes ordinary host scheduler/RPC slack). These
are local source/RPC checks; paired transport, VM and activation remain unproven.

W1b verification: 102 focused Core tests / 1,028 assertions pass without skips,
including controlled and live Unix fairness and the actual 20-second renewal.
Core TypeScript and whitespace checks pass. Other source/consumer/protocol files
are unchanged from the accepted b191 correction. The live fairness log retains
its measured first-hint delay and count during the burst; target timing is not a
hard host scheduler latency guarantee. No PR/push or activation occurred.

A retained separate live run observed firstHintMs=513.395, four hints during a
2,124.150 ms burst of 40 writes; the controlled callback test separately proves
the aligned 500 ms delivery and 100 ms minimum canonical read spacing.


## Phase-offset precision follow-up

No production code changes. The aligned fairness regression still requires delivery
by 500 ms in its particular schedule. A separate controlled regression preserves
the initial snapshot backpressure and queued timer phase: start at 0, blocked snapshot
at 100, commit at 150 arms 250, drain at 200 sends the snapshot and clears dirty state,
then new dirty state at 225. Sustained 50 ms commits retain callbacks at 250, 350,
450, 550, 650, 750. The first change arrives at 750: 525 ms after first dirty, within
the 600 ms healthy/unblocked cadence bound. Minimum 100 ms read/delivery spacing,
per-delivery authorization and all W1–W7 controls remain unchanged. OS scheduling,
read failure and transport backpressure are separate sources of delay.

Follow-up validation: all 21 watch regressions / 190 assertions pass without
skips, including the retained aligned 500 ms test and the new 525 ms phase-offset
case. Core TypeScript and whitespace checks pass. Production blobs are unchanged
from the accepted `44967c257c769db112ce0c61213af9c6b3d1daf0` source.
