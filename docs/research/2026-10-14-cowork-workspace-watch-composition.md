# Cowork workspace watch composition — 2026-10-14

This is a NEW source composition on `cowork/workspace-product-watch-composition`
in `.worktrees/core-workspace-product-watch-composition`, based on accepted frozen
`37b68e0aa7ab1cee98c54bfd649253892e52aa81`. The original three-feature branch/ref
remains unchanged. No push, PR, pin, availability or production activation occurs
from this local freeze. Outputs schema15 and CLI stdin/file work remain separate,
uncomposed lanes.

Later status (2026-10-15): this composition merged as PR #36. The output reads lane
then merged its tip, so outputs schema 15 now follows this branch's schema 14. The
statements below describe this branch as it was frozen.

## Accepted leaves and actual local DAG

| Accepted source leaf | Local composition commit | Scope |
| --- | --- | --- |
| `145d3eaf3c257a9e047ee91f098ac2b0a4d8e82b` | `9824ea36` | Local watch leases, stream routing, TS consumer, commit hints |
| `b19198ea1b52130cf6b63aaf1e8f13d560b16fb4` | `4b3b211a` | Coalescing, bounded recovery/backpressure and renewals |
| `44967c257c769db112ce0c61213af9c6b3d1daf0` | `6eb26b13` | Sustained-write hint eligibility max wait |
| `79c1d867cd64de9485d84d0c8cf67e8f824f8500` | `67346d7b` | Documentation and phase-offset tests; no production change |

The correct PR base is `cowork/output-integration`. Its current local origin
tracking ref is `f60298bb90efe103a54265a1f7dca8518a61f891`, the merge-base of frozen37.
The local branch17301e28 is stale; do not use its older head as a new source base.
No local/remote ref refresh or push was needed to establish this ancestry.

## Every conflict resolution

The first watch leaf had four source conflicts against37:

1. Repository: retain all accepted durable HomeIdentity, binding, outbox delivery
   and deletion/pruning code; add only the accepted pure watchPosition lookup.
2. Service: retain schedule/guidance fields and all five prior constructor
   arguments, append watchOptions as the sixth, and initialize the accepted watch
   registry. Keep requireSessionRead's canonical deleted-binding refusal. Combine
   closeConnection/close with watch cleanup and existing schedule/selection cleanup.
3. IPC: add the accepted local watch stream branch, including writer bounds, and
   retain canonical calls followed by accepted outbox drain for non-stream RPCs.
4. Protocol: keep the guidance and schedule/quarantine schemas/methods and add the
   accepted watch schemas/methods. No paired allowlist or capability bit is widened.

The second leaf conflicted only at the deterministic watch fixture constructor.
Keep the sixth watch-options slot and the accepted fake-clock flush wrapper.
The third and timing leaves applied without conflicts.

The old watch observer test assumed a public repository mutation could run inside
another transaction. Accepted37 correctly refuses that nested durability boundary.
The composed test now asserts that refusal, and uses actual fixture SQL for outer
rollback and nested savepoint/commit notification tests. No production mutation
or durability guard was relaxed.

## Preserved component identities

- watch.ts and CLI client.ts are exact449 production blobs (also unchanged by79).
- instructions.ts, schedules.ts, folder-grants.ts and schema.ts match37 exactly.
- Repository differs from37 only by the five-line accepted watchPosition method;
  HomeIdentity seed/pure lookup and all scoped durability methods remain intact.
- Runtime-state DB adds only accepted commit-listener plumbing; schema remains14
  with real12→13→14 migration order. Generic Code NORMAL settings remain unchanged.
- Reviewed helpers remain SHA-256 `97dca732a984827e032fe6df204112b568be1eab5654408e0ecc6f652fbffba5`
  (instruction-fs), `4321ffea8057aa359c1ddbc043b45dd1a38864a0858aee8badfa2f00791743b3`
  (fullsync), and `486ae95a14881cd48038cfca86e33a9da66586149fe73824255a2a8f29cae4f0`
  (scoped SQLite transaction).

## Integration verification changes

The first combined run exposed an unreliable guidance test oracle: process-global
FD count fell450→441 while unrelated asynchronous sockets closed. The revised
fixture captures the root vnode descriptor opened by the specific failing call
at the existing directory-opened checkpoint; after refusal it requires EBADF or
FD-number reuse for a different vnode. Ten actual attempts pass. There is no new
checkpoint argument, instruction owner change, FFI binding or weakened assertion.

A new actual disposable Unix/TS-consumer case subscribes to a canonical workspace,
updates shared guidance through the existing local RPC, observes instruction/config
revision hints, reads the new bytes through the bounded guidance RPC and proves
neither plaintext nor base64 guidance enters watch frames. It creates no logical
conversation, production selection issuer or RPC initialization door.

Timing remains the accepted distinction:500ms is eligibility from first dirty;
healthy automatic maintenance can add up to one100ms phase. The aligned≤500ms
assertion remains; the offset525ms case has an explicit≤600ms assertion. This is
not an exact scheduler deadline under pressure or backpressure.

## Scope and review

Only previously reviewed Darwin arm64 file/directory primitives ran against owned
disposable fixtures. No live Winter home/daemon/app, real Keychain, GUI, Swift,
native test host, VM/native worker, held egress or Mac two-disk lane was executed.
OS flush completion is not hardware power-cut proof. R2 remains deferred host
repair. Cowork provisioning/execution capability bits and guest/context admission
requirements remain unchanged.

Root/Astra/reviewer45 must review the exact composition freeze before push/PR.
Feature-owner acceptance alone does not replace caller-composition review.

## Final freeze validation

Combined Core regression: 677 pass, 2 explicit skips, 0 fail; 5170 assertions across 35
files. The skips are unsupported-host flush on this Darwin arm64 machine and the
existing candidate SDK confined-posture gate. All original 13 guidance file cases
and the new guidance/watch file RPC case ran with the reviewed fixture opt-in.
Focused instruction/watch/Unix-consumer run: 49 pass, 496 assertions,0 fail.
The final specific-descriptor check: 1 pass, 40 assertions,0 fail across ten faults.
Protocol: 241 pass / 1087 assertions across 6 files. CLI Cowork: 15 pass / 152 assertions.
Core/protocol/CLI no-emit typechecks and whitespace checks pass.

Exact Core command from packages/core:

```sh
WINTER_COWORK_INSTRUCTION_FS_FIXTURE=1 bun test test/cowork/repository.test.ts test/cowork/workspace-events.test.ts test/cowork/durable-transaction.test.ts test/cowork/instructions.test.ts test/ipc/cowork-instructions.test.ts test/cowork/schedules.test.ts test/ipc/cowork-schedules.test.ts test/cowork/current-context.test.ts test/cowork/current-context-resolver.test.ts test/cowork/current-context-callback.test.ts test/cowork/structured-instruction-mapper.test.ts test/cowork/session-messaging.test.ts test/cowork/guest-query.test.ts test/cowork/guest-runtime.test.ts test/cowork/git/authority.test.ts test/cowork/git/read-authority.test.ts test/cowork/folder-grants.test.ts test/runtime-state/db.test.ts test/runtime-state/db-run-folder.test.ts test/migration/migrate-c.test.ts test/ipc/cowork-workspace-api.test.ts test/ipc/remote-allowlist-parity.test.ts test/store.test.ts test/hub.test.ts test/sessions/history.test.ts test/sessions/reaper.test.ts test/projector/event-coverage.test.ts test/routines/store.test.ts test/routines/scheduler.test.ts test/routines/runner.test.ts test/cowork/watch.test.ts test/ipc/cowork-workspace-watch.test.ts test/ipc/sync-core.test.ts test/ipc/remote-chat-gate.test.ts test/sessions/remote-stream-thinking.test.ts
```

Protocol uses `cd packages/protocol && bun test`; CLI uses
`cd packages/cli && bun test test/cowork-cli.test.ts`. Typechecks from worktree root
use `./node_modules/.bin/tsc --noEmit -p packages/core`, and corresponding
`-p packages/protocol` / `-p packages/cli`.
