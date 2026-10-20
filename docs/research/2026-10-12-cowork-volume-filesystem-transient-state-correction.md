# Filesystem transient journal-state correction

2026-10-12. Targeted implementation response to the independent source review of `823f7003a218b92b45e1cfcaea27d9698efc5b9c`, on `cowork/volume-filesystems`. Original823 and its v2 evidence remain retained in history. This correction is pending root re-review before any push or Linux CI; no format, replay, mount or VM ran here.

The original probe compared dumpe2fs's entire live feature list to persistent format capabilities. Ext4's `needs_recovery` bit is live journal state: Linux sets it for journaled read-write use and clears it after successful journal cleanup. The original normal AND explicit full-read-only routes therefore refused `filesystem_features` before the checker could run. An independent zero-I/O mock of the actual probe reproduced that error with otherwise identical UUID, geometry, pinned features and clean state. [Linux ext4 superblock code](https://raw.githubusercontent.com/torvalds/linux/v6.18/fs/ext4/super.c), [ext4 superblock fields](https://docs.kernel.org/filesystems/ext4/super.html).

## Corrected observation and readiness semantics

`bootstrap.py` separates the exact twelve persistent features from a separately allowlisted transient feature list. Only `needs_recovery` is allowed. Duplicate or unknown features remain refused. A normal header probe can report journal replay pending without forcing e2fsck; `full-read-only` remains explicit and runs its read-only checker while retaining the observed flag. Neither mode clears a flag, replays a journal, repairs bytes, changes UUID/features, or implies a clean mount. Normal error-state detection is retained.

Each new per-volume receipt includes required `transientFilesystemFeatures`, either `[]` or `["needs_recovery"]`. `checked` means the declared header/check observation completed, not permission to mount or start tools. Core verifies the exact receipt and protected proof, then refuses confirmation with typed `journal_recovery_required` if either disk reports pending recovery. Both rows remain unconfirmed and writable ownership is retained. A failed/read-only probe can keep confirmed format history and acquire a fresh explicit check/probe nonce without ever regaining format-new authority.

An approved immutable native recovery/mount path must perform actual journal replay before a fresh clean observation can confirm readiness. That native producer/mount path remains unimplemented. Even a successful full read-only checker cannot mint ready while the flag remains. Stale pre-recovery/full-check receipts cannot confirm a later nonce.

Older v2 receipts lacking the new observation field are accepted only as retained history. Their original exact-live-feature check excluded this flag, so their existing feature/zero/mount contract stays readable; current-owner readiness and new confirmation require a fresh explicit-state observation. V1 compatibility refusal, schema9 recovery/ineligibility, UUID/file/creation/owner binding, single native ownership/stop ledger, sparse-zero/noinit_itable contract and formatter argv are unchanged. Missing/unknown/duplicate new state cannot masquerade as a current clean receipt.

## Verification

```sh
bun test packages/core/test/cowork/volume-filesystem.test.ts
bun test packages/core/test/cowork/volume-filesystem.test.ts packages/core/test/cowork/volumes.test.ts packages/core/test/cowork/repository.test.ts packages/core/test/cowork/admission.test.ts packages/core/test/runtime-state/db-run-folder.test.ts
python3 -I -S spikes/cowork-filesystem-bootstrap/test_bootstrap.py
pnpm typecheck:core
git diff --check
```

Results: **25 focused host tests /102 expect calls pass**; **98 tests /771 expect calls across five host suites pass**; **six Mac protocol/mock tests pass and nine actual Linux cases skip**; Core typecheck and diff check pass. The transient mock exercises the actual parser in normal/full modes without descriptor or helper I/O. Host regressions verify pending recovery never confirms ready, retained history/new nonce/explicit full-check stay usable, late receipts refuse, missing/duplicate/unknown state refuses, and old v2 history requires a fresh observation. Native authority/ready receipts in these tests remain injected fixture proof, not production evidence.

A new opt-in Linux-only case formats a disposable regular-file pair, uses debugfs to set the actual recovery bit, verifies that bit independently from superblock bytes, then asserts normal probing reports it without e2fsck or digest changes. It was **not run here**; root source review must precede isolated Linux CI. This test performs no mount, loop device, sudo or host Mac formatting. Existing dependency symlinks and bootstrap __pycache__ were left untouched.

No formatter/repair/replay/VM/worker, Mac disk tool, live Winter app/daemon/home, Keychain, credential, SDK pin, release or push was used. The broader host suite's real tmutil check applies only disposable item exclusions, never global backup policy. This source correction does not prove actual Linux transient-state handling, signed native bootstrap authority, block-device/mount confinement, cold continuation, physical disk pressure/compaction or active RAM return with persistent two-volume storage.
