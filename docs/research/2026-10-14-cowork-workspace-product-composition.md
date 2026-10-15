# Cowork workspace product composition — 2026-10-14

This is a new, isolated source composition on branch
`cowork/workspace-product-composition`, worktree
`.worktrees/core-workspace-product-composition`. It combines the independently
accepted guidance13, schedule14 and outbox corrections. It does not enable Cowork
execution/provisioning, change SDK pins, or include the workspace watch feature.
Frozen owner branches and main were not altered; no push or activation occurred.

## Accepted parents and applied leaves

Base `35f9834498cbacfdb69174f25137c258ac0c5c30` has actual ancestry:

- `6ca56d24cad15f564e225f605170dccfd195cb81`: accepted guidance13 including R1.
- `4766a694`: cherry-picked accepted schedule quarantine correction55 delta;
  migration13 precedes migration14.
- `35f98344`: accepted schedule calendar budget corrections.

The base already contains original outbox 7678 as `1de676a6`, shared reviewed
filesystem/fullsync leaves as `d4b80a01`, and exact scoped SQLite helper bytes.
Outbox 840 descends through 7678 →5086 →bdaa →1e1 →840. Only missing corrections
were cherry-picked:

| Accepted outbox source | Local composition commit | Result |
| --- | --- | --- |
| `bdaab4fba0a5b57b4e9a8974bf2ac1a612357575` | `d51007dc` | Automatic merge; identical helper/test add already present |
| `1e1f226818c9527cce1083f5a4c4db1b85d64ff4` | `36fd8c3b` | One daemon startup conflict resolved as below |
| `840502005e9f4f02f748c117f7e8f13cc03c0ad0` | `4f8a24ae` | Clean missing-log guard delta |

Old schema/schedule/source leaves were not replayed. No direct composition of an
unreviewed workspace watch branch occurred.

## Exact conflict and fixture resolutions

`daemon.ts` had one conflict at construction of CoworkWorkspaceService. Keep the
outbox's already-constructed `coworkRecords` (shared with the deletion hook), the
schedule's hoisted service holder and clock argument, the guidance's canonical
home and existing ApprovalBroker/SessionHub arguments, and schedule recover/tick.
The combined deletion hook and empty-session reaper changes from 1e1 remain intact.
Routine hostTick and schedule shutdown hooks remain intact. The optional guidance
constructor still catches unsupported topology without crashing daemon boot.

B1 requires a mandatory fourth committed-session port for bindConversation; no
production default-true path was introduced. Three new-feature fixture callers
needed adaptations beyond the outbox source's already adapted fixtures:

- Guidance's real SessionStore fixture passes its actual store after creating the
  committed session/header. The production binding API remains host-owned.
- Two schedule authority-only bindings pass the explicit fixture inventory from
  `authorityFixtureSessions`, including the dynamically minted standalone owner
  ID. They are authority-unit fixtures, not session/log admission evidence.

## Preserved source identities and boundaries

Verified Git blobs match their accepted owner source exactly for:

- Guidance `instructions.ts`:6ca; schedule `schedules.ts`:35f98344.
- Outbox `workspace-events.ts`:84050200. Repository initially matched840 exactly;
  the necessary HomeIdentity integration correction below is the sole new delta.
- Schema/runtime-state DB:35f98344, including explicit12→13→14 migration order.

Reviewed source SHA-256 values remain byte-identical:

| Leaf | SHA-256 |
| --- | --- |
| instruction-fs.ts | `97dca732a984827e032fe6df204112b568be1eab5654408e0ecc6f652fbffba5` |
| instruction-fullsync.ts | `4321ffea8057aa359c1ddbc043b45dd1a38864a0858aee8badfa2f00791743b3` |
| durable-transaction.ts | `486ae95a14881cd48038cfca86e33a9da66586149fe73824255a2a8f29cae4f0` |

Guidance uses pure SELECT for existing canonical home identity within its durable
transactions; it does not invoke a wrapped repository mutation as a nested
transaction. Generic Code's SQLite connection settings remain unchanged outside
scoped Cowork commits. R1 abort, schedule 4096/256 budget limits and quarantine14,
B1 committed-session gating, and missing-log refusal remain present.

Reviewed Darwin file/directory calls were authorized only on disposable owned
fixtures, using the existing exact flag/ABI contracts. Completed OS sync requests
are not hardware power-cut proof, other-filesystem admission, a VM/native-worker
proof or production activation. No live Winter app/home/daemon, real Keychain,
GUI, Swift build/test host, VM, held native egress or Mac two-disk lane was used.
R2 crash-plus-editor-plus-retained-temp repair remains explicitly deferred.

## Validation and review freeze

The composition must receive Root/Astra/reviewer45 review of this exact tree.
Feature-owner source acceptance is not automatic acceptance of caller composition.
Workspace watch is excluded until its corrected source is independently accepted.

## Integration failure and narrow correction

The first combined 30-file run found 15 real folder-grant failures. Folder binding
runs inside canonical mutate and called public homeIdentity, whose new durable
wrapper correctly refuses a caller-owned transaction. A pure SELECT alone was
insufficient: first grant admission may establish the first canonical identity.

Repository now has a private transaction-owned identity seed, called only from
the scoped durable public identity entry and canonical mutate before source
binding. Folder bind uses recordedHomeIdentity: a pure existing-row lookup which
refuses missing authority and cannot provision an identity. Public mutation still
refuses planner/caller transactions; no nested wrapper or generic Code durability
setting was weakened. Source, grant, HomeIdentity and operation share the outer
durable commit. The actual receipt-rollback test checks FULL/ON/ON inside binding
and no surviving HomeIdentity/grant/workspace half-commit. A read-transaction test
checks missing identity refusal, existing identity lookup and rejection of public
identity mutation within that transaction.

Creating the identity first consumes the home mint before other canonical IDs.
The current-context fixture assigns home its own explicit fixture namespace so
its existing literal facts/revision golden corpus remains independent of this
additional canonical row. Context production source was not edited. Guidance R1,
schedule budgets/quarantine schema and outbox event consumer source remain exact
accepted bytes; repository/folder-grant integration requires new exact review.

## Final validation

Core combined 30-file regression: 568 pass, 2 skip, 0 fail; 4619 assertions.
The skips are unsupported-host-only log flush on this Darwin arm64 machine and
the existing candidate SDK confined-posture fixture gate. All 13 guidance file
cases ran with WINTER_COWORK_INSTRUCTION_FS_FIXTURE=1. Actual disposable APFS
file/directory sync, SQLite, SessionStore/header, replay, RPC, metadata schedule
and canonical folder-grant tests passed. This is source/file/DB/RPC evidence, not
VM or production integration proof.

Protocol: 241 pass / 1087 assertions across 6 files. CLI Cowork: 15 pass / 152 assertions.
Core/protocol/CLI no-emit typechecks and whitespace checks pass. Ignored dependency
symlink skeletons reuse existing local installations; no install/pin/lock edit.

Exact Core command from packages/core:

```sh
WINTER_COWORK_INSTRUCTION_FS_FIXTURE=1 bun test test/cowork/repository.test.ts test/cowork/workspace-events.test.ts test/cowork/durable-transaction.test.ts test/cowork/instructions.test.ts test/ipc/cowork-instructions.test.ts test/cowork/schedules.test.ts test/ipc/cowork-schedules.test.ts test/cowork/current-context.test.ts test/cowork/current-context-resolver.test.ts test/cowork/current-context-callback.test.ts test/cowork/structured-instruction-mapper.test.ts test/cowork/session-messaging.test.ts test/cowork/guest-query.test.ts test/cowork/guest-runtime.test.ts test/cowork/git/authority.test.ts test/cowork/git/read-authority.test.ts test/cowork/folder-grants.test.ts test/runtime-state/db.test.ts test/runtime-state/db-run-folder.test.ts test/migration/migrate-c.test.ts test/ipc/cowork-workspace-api.test.ts test/ipc/remote-allowlist-parity.test.ts test/store.test.ts test/hub.test.ts test/sessions/history.test.ts test/sessions/reaper.test.ts test/projector/event-coverage.test.ts test/routines/store.test.ts test/routines/scheduler.test.ts test/routines/runner.test.ts
```

Protocol: `cd packages/protocol && bun test`. CLI: `cd packages/cli && bun test test/cowork-cli.test.ts`.
Typechecks from worktree root: `./node_modules/.bin/tsc --noEmit -p packages/core`
and corresponding `-p packages/protocol` / `-p packages/cli`.
