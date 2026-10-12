# RAW volume R1 transaction correction

Date: 2026-10-12. This is the implementation response to the independent review
of `bcd6ea5ba28168da95cbdbc4d2d185c3ae0da259`, committed on
`cowork/v1-raw-volumes`. Independent re-review remains required; this report does
not claim production, native stop, VM, guest-filesystem or active-RAM acceptance.

The reviewed defect was a nested SQLite transaction escaping a writable descriptor
while a subsequent outer rollback restored or removed canonical disk ownership.
Both the `claim → open` and `release → claim → open` paths reproduced that defect.

Public `CoworkVolumes.claim`, `open` and `release` now inspect `db.inTransaction`
and throw `CoworkVolumeError("invalid_request")` before starting their internal
transaction or performing authorization, owner changes, backup checks or descriptor
opens. This follows the existing allocation/materialization guard. A caller must
invoke these lifecycle operations outside its own transaction; their successful
internal transaction is then a top-level commit rather than a savepoint.

Two disposable regressions exercise the outer rollback scenarios, including
continuing after each refusal inside the outer transaction. They verify that all
three methods refuse independently, no descriptor escapes, no authorization or
stop-verifier callback runs, and canonical ownership remains unchanged after
rollback. Matching previously committed owners cannot open inside an outer
transaction either. Normal committed claim/open/write/read/close/native-proof
release and next-owner claim/open/write remain verified; a different owner still
refuses while the first is held.

Validation in the isolated `.worktrees/v1-raw-volumes` checkout:

```sh
ln -s '../output-integration/node_modules' node_modules
ln -s '../../../output-integration/packages/core/node_modules' packages/core/node_modules
pnpm typecheck:core
bun test packages/core/test/cowork packages/core/test/runtime-state
git diff --check
```

Core typecheck passed. Broader tests passed: **430 passed, 0 failed, 2210 expect
calls across 27 files**, Bun `1.3.14 (0d9b296a)`, approximately 11.18 seconds.
The temporary dependency links reuse the existing isolated output-integration
installation without modifying packages, SDK pins or lockfiles; they are removed
before committing to leave the worktree clean. Recreate those exact links when
independently running the same commands in this worktree. Disposable daemon tests
use file-backed secret stores; no production home/daemon, native VM or live
Keychain operation was performed. The real tmutil test touches only disposable
image item exclusions, without changing global or volume backup settings.

Trusted native authority/stop verification and cross-instance descriptor accounting
remain integration obligations. Descriptor transfer, filesystem formatting and
readiness, production startup and active-RAM gates remain open. Named tmutil
operations still resolve their paths while running; identity bracketing detects
persistent swaps but does not atomically prevent a transiently swapped name from
receiving a backup-metadata side effect. These limits remain explicit in
`docs/cowork-raw-volumes.md`. No gate, encryption decision or production-disabled
provisioning behavior was changed. No push, main update, release or package pin
change is included.
