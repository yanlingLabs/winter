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
Changes carry only current workspace revisions; consumers refetch canonical
`workspace.get`/detail pages, even for lifecycle/operation changes whose desired
config revision has not advanced. Raw outbox records, global outbox positions,
bookmarks, host roots, backing paths, grant/account/repository authority handles
and guest incarnation identifiers are never sent.

Snapshots/revisions/outbox positions are read together inside a canonical
runtime-state.db transaction. Successful outer writes through that daemon-owned
`RuntimeStateDb` handle notify watchers after commit. Rollback, nested savepoints
and pure reads do not emit. Multiple repository instances sharing that handle are
covered, including source ACK and operation changes without a configRevision
advance. Direct SQL/external-process writers are not a supported live watch
producer; reconnect always snapshots current canonical state. There is no
workspace polling, fake conversation, transcript use or `$system` replay.
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

Each connection can own four watches. Each watch stores at most 32 IDs/signatures,
an initial snapshot-ID queue of at most 32, and one saturating commit counter.
It never queues outbox payloads or historical frames. More than 128 coalesced write
notifications before delivery produces `refetchRequired=true` and current revisions
for the enrolled scope. A slow writer pauses delivery above 128KiB buffered bytes;
its socket drain resumes from current safe DB state. Fully encoded local JSON-RPC
notifications are checked against 256KiB; existing bounded workspace projections
leave frame overhead room. The paired 512KiB outer WireEnvelope contract is not
claimed or implemented by this lane.

A 60,000ms monotonic lease is enforced independently of displayed wall-clock expiry.
The TS `WinterClient.watchWorkspaces` consumer installs separate watch notification
handling and automatically renews after 20,000ms. Automatic renewal requests do not overlap;
detach, terminal notification or disconnect cancels further automatic renewal.
Renewal failure is reported separately through `onWorkspaceWatchError`. Close,
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

Observed final verification: 91 focused Core tests / 980 assertions, 241 protocol
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
