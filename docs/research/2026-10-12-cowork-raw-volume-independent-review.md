# Independent review: first-version Cowork RAW volumes

Date: 2026-10-12. Current verdict after correction re-review: **accepted within this host-storage-primitive scope at `2ba89506d86966a74528136ad2dbf5e6456fc069`**. The reproduced R1 blocker is closed. The initial findings and evidence below are retained as historical review of `bcd6ea5b`. This is a scoped source and disposable-host-filesystem review, not native VM or production acceptance.

## Exact scope

Reviewed commit `bcd6ea5ba28168da95cbdbc4d2d185c3ae0da259` on `cowork/v1-raw-volumes`, relative to `6e844d35`, in `<workspace>/.worktrees/v1-raw-volumes`. The worktree HEAD matched the reviewed commit and was clean. Read the parent `AGENTS.md`, this repository's `CLAUDE.md`, `docs/cowork-raw-volumes.md`, `docs/cowork-storage-security.md`, related execution/host contracts, all changed source/tests, the descriptor-relative filesystem implementation, and runtime-state transaction/migration code. No implementation changes were made by this review.

The user explicitly deferred separate workspace encryption for v1. Plaintext backing images and the documented same-user residual are accepted scope. This review does not require reinstating encryption, an outer native Code floor, or idle-only RAM management.

## R1 — High: outer transaction rollback loses ownership while a writable descriptor survives (closed at `2ba89506`)

`packages/core/src/cowork/volumes.ts:236` and `:260` accept caller-owned transactions. Their internal `RuntimeStateDb.transaction` calls become nested SQLite transactions/savepoints; their completion does not durably commit a surrounding transaction (`packages/core/src/runtime-state/db.ts:423–426`). `claim` writes the owner at `volumes.ts:245`, and `open` returns a writable descriptor at `:265–270`. An outer rollback can therefore remove that owner after the descriptor has escaped. A subsequent different owner can claim both disks and obtain another writable descriptor without any native stop verification. `claim` does not reject the outstanding handle recorded by the first `open`; that counter is consulted only by `release`.

Independent reproduction used a newly created disposable home, a fixture workspace, injected allow-authority/backup adapters, and a stop verifier that always returned false. It required no native worker, VM, credentials, Keychain, live home, or backup configuration. After normal allocation, the decisive sequence was:

```ts
let first;
try {
  db.transaction(() => {
    store.claim(ownerOneRequest);
    first = store.open(ownerOneRequest, "data");
    throw new Error("outer rollback");
  });
} catch {}
// Canonical owner is now null; first.fd remains open and writable.
store.claim(ownerTwoRequest);
const second = store.open(ownerTwoRequest, "data");
writeSync(first.fd, Buffer.from("owner-one"), 0, 9, 4096);
writeSync(second.fd, Buffer.from("owner-two"), 0, 9, 8192);
```

Observed stdout:

```text
after outer rollback owner: null
both descriptors writable after second claim: owner-one owner-two
```

Both writes were independently read back from the same `data.ext4`. Both handles, the DB, the temporary script and its disposable home were closed/removed afterwards.

The related `release` boundary (`volumes.ts:272–281`) also permits surrounding transactions. A second disposable probe began with owner one committed and no handles, then executed `release(one, fixtureStop)`, `claim(two)` and `open(two)` inside an outer transaction that rolled back. The injected stop verifier returned true only as fixture policy; no real native stop is claimed. The rollback restored canonical owner one while the owner-two descriptor survived. A subsequent `open(one)` and writes through both handles succeeded. Observed stdout was `release/claim/open rollback restored owner: worker1` and `both descriptors writable: restored1 escaped2!`. This is the same transaction-escape defect, not a separate finding. Release-only rollback retains ownership conservatively; the combination with a descriptor handoff causes the integrity failure. Its mandatory real stop verifier and cross-instance attachment accounting remain trusted integration obligations.

Required disposition: reject caller-owned transactions before public ownership/descriptor lifecycle operations, or implement an explicit outer-commit-aware descriptor handoff that cannot expose an uncommitted claim. The existing `db.inTransaction` refusal at `volumes.ts:185–193` protects allocation effects but does not protect this boundary. Add a regression for outer rollback after `claim`/`open`, verifying no second owner can coexist with the first writable handle. Native authority injection alone does not fix it: the owner transition exists only inside the rolled-back DB transaction, and the subsequent claim sees an unowned disk.

## Verified behavior and remaining limits

| Area | Source/observed evidence | Review conclusion |
| --- | --- | --- |
| Schema and rollback | `cowork/schema.ts:75–99`; `runtime-state/db.ts:242–264,281–324`; disposable v7/v8 upgrade and v6/v7 rollback tests | Schema 9 is additive; recorded geometry/format/state constraints and directory IDs are canonical DB records. Populated Cowork tables refuse downgrade. Empty rollback preserves native runtime metadata. No filesystem data is deleted by these changes. |
| Creation and recovery | `volumes.ts:163–232`; allocation/crash tests | Plan commits before file effects; create is exclusive; identity is published only after file/parent fsync; only a recorded zero/final-size creation is resumed. Unknown/pre-existing per-workspace directories and images are refused and preserved. Creation-intent and pre-identity crash windows conservatively require recovery. |
| Sparse allocation | `volumes.ts:223`; disposable stat assertions | `ftruncate` sets logical capacity; tested minimum-sized images consumed fewer allocated blocks than logical size. Physical-space admission, production defaults, growth, ENOSPC during guest writes and export consistency remain open. |
| File admission | `volumes.ts:47–51,94–98,106–159,249–256`; `volume-fs.ts:15–21`; `computer-use/browser/fd-fs.ts:69–95` | Checked directory chain uses no-follow descriptor-relative operations and recorded device/inode/UID/exact 0700. Images require regular files, nlink 1, exact 0600, recorded identity and exact capacity. Symlink/hardlink/permission/geometry/replacement drift refuses without repairing or replacing user data. Open descriptors carry close-on-exec. This is an integrity admission check, not protection against arbitrary same-user mutation after admission. |
| Backup exclusion | `volume-backup.ts:13–23`; `volume-fs.ts:24–32`; `volumes.ts:145–159`; real disposable tmutil test | Adapter uses sticky named-item `tmutil addexclusion` without `-p`/`-v`, verifies `isexcluded` and the exact descriptor-read item xattr, and rewalks identity before/after. Real image-local sticky metadata persisted through rename; shared output directory received no item marker. Tests run under an already excluded temporary ancestor, so they do not prove global backup inclusion of shared content. Named tmutil operations still resolve paths during execution; bracketing detects persistent swaps but is not an atomic guarantee that a concurrently swapped name received no backup-metadata side effect. No global/volume backup setting was changed. |
| Ownership and stop | Original `volumes.ts:13–32,236–281`; cold reopen/stop tests; correction re-review below | Records bind controller/worker/incarnation/lease epoch/runtime digest, and different persisted owners refuse. Closing an ordinary handle does not clear ownership. Release requires exact owner, local handle closure and a positive mandatory stop-verifier result. Production implementation of that verifier must account for every native attachment/controller and cross-instance descriptor; the injected fixture proves the host decision branch only. R1 is closed for this primitive; native verification remains unimplemented integration work. |
| Production wiring | Search of `packages` for `CoworkVolumes`, `cowork_volumes`, `cowork_volume_directories`; raw-volume/storage docs | Primitive is uninvoked outside its own tests/schema. No authenticated native descriptor consumer, production launch/stop adapter, ext4 formatting, filesystem readiness transition, guest acknowledgment, VM attachment or active-RAM integration is implemented by this commit. `allocated` remains explicitly `unformatted`. |

The filesystem checks and sticky exclusion encoding are bounded to the supported Apple-silicon macOS implementation. Unknown marker encoding refuses. Interrupted directory creation has no automatic repair/adoption operation; recovery tooling remains separate work. A stopped-daemon boundary is documented for downgrade but these low-level downgrade helpers do not themselves prove the daemon stopped.

## Independent validation

Commands executed in the reviewed worktree:

```text
git diff --check 6e844d35 bcd6ea5b
cd packages/core
bun test test/cowork/volumes.test.ts test/cowork/repository.test.ts test/cowork/admission.test.ts test/runtime-state/db-run-folder.test.ts
```

Result: **65 passed, 0 failed, 450 expect calls, 4 files**, Bun `1.3.14 (0d9b296a)`, approximately 3.13 seconds. This included the real nonprivileged item-exclusion test, injected fault tests and schema/rollback tests. `git diff --check` passed.

An initial broader `bun test test/cowork test/runtime-state` run produced **65 passes, 23 failures/errors, 450 expect calls across 27 files**. The errors were module-load failures for absent packages such as `@yanlinglabs/winter-agent-sdk`, its messaging export, `@yanlinglabs/winter-protocol`, `@yanlinglabs/winter-provider-catalog` and `@yanlinglabs/winter-runtime-sdk`. That run is not a passing broader gate. The author's reported 82-test/531-assertion run and Core typecheck were not reproduced here, and are not claimed as independent evidence. No heavy native build was run while the generic-port review was using the native build path.

The additional disposable rollback probe reproduced R1 despite the focused suite passing. It used real descriptors/files and injected trusted ports, not a VM or a native-stop claim. No live Winter app/daemon/home, credentials, Keychain, global backup policy, package release/pin, push or merge was touched.

## Acceptance disposition

The initial `bcd6ea5b` submission required the R1 correction. The correction at `2ba89506` is accepted within the scoped host-storage primitive after the independent recheck below. There are no remaining material findings in this reviewed scope. This acceptance cannot satisfy native worker admission, guest formatting/readiness, full worker resource/security gates or Cowork end-to-end implementation.

## Correction re-review at `2ba89506`

Reviewed the actual `bcd6ea5b..2ba89506d86966a74528136ad2dbf5e6456fc069` source/test/documentation diff and `docs/research/2026-10-12-cowork-raw-volume-r1-correction.md`. Worktree HEAD matched the correction and was clean before and after testing. `claim` now checks `db.inTransaction` at `volumes.ts:238`; `open` at `:263`; `release` at `:276`. Each guard precedes the internal transaction and every authority/stop callback, ownership mutation, backup validation and writable descriptor open. Successful standalone lifecycle calls retain their existing top-level transaction behavior.

Inspected and reran the two added regression tests at `packages/core/test/cowork/volumes.test.ts:168` and `:196`. They independently exercise caught refusals for all three methods, matching previously committed owners, outer rollback, absence of authority/stop callbacks and descriptors, competing-owner refusal, and normal committed transfer with retained data.

An additional independent disposable script reran the original uncaught `claim → open → throw` and `release → claim → open → throw` sequences against the correction. Both stop at the first lifecycle call with `CoworkVolumeError("invalid_request")`, no authority or stop callback runs, no descriptor escapes, and canonical ownership remains unchanged. It then performed ordinary committed claim/open/write/close/release/next-owner claim/open/write and read back both owners' data. Observed stdout:

```text
original claim/open rollback: refused before authority, no descriptor, owner null
original release/claim/open rollback: refused before authority/stop, old owner retained
committed transfer: prior data retained, next owner write verified
```

The script used real disposable files and injected authority/backup/stop policy, not a native-stop claim; its descriptors, DB, script and home were removed. Recreated only the exact temporary dependency symlinks from the author's correction report, pointing at the existing isolated `output-integration` installation. No install, lockfile or package-pin changes were needed. Commands independently executed from the correction worktree:

```sh
ln -s '../output-integration/node_modules' node_modules
ln -s '../../../output-integration/packages/core/node_modules' packages/core/node_modules
pnpm typecheck:core
bun test packages/core/test/cowork/volumes.test.ts packages/core/test/cowork/repository.test.ts packages/core/test/cowork/admission.test.ts packages/core/test/runtime-state/db-run-folder.test.ts
rm node_modules packages/core/node_modules
git diff --check bcd6ea5b 2ba89506
git status --short
```

Independent results: **Core typecheck passed; 67 tests passed, 0 failed, 479 expect calls across 4 files**, Bun `1.3.14 (0d9b296a)`, approximately 3.24 seconds; diff check passed; the worktree was clean after removal of the dependency links. The author's broader **430 tests / 2210 assertions / 27 files** report was read but not independently rerun, and remains author evidence. The earlier missing-module errors were environment gaps, not source failures or test passes.

R1 is closed. Required production-native authority and stop verification, cross-instance descriptor accounting, descriptor transfer, immutable guest formatting/readiness, physical-disk admission, full worker confinement and active-RAM integration remain open exactly as before. Named tmutil metadata operations retain the explicitly documented same-user race residual; this correction neither expands that guarantee nor changes the accepted plaintext first-version storage decision. No source edits, VM/native builds, live app/daemon/home, Keychain, push, merge, release or pin changes were performed by this re-review.
