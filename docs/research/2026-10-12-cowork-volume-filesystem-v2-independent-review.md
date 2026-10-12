# Filesystem v2 correction: independent source review

2026-10-12. Reviewed `823f7003a218b92b45e1cfcaea27d9698efc5b9c`, parent `ad016d34`, in `.worktrees/volume-filesystems`. **Changes required: one functional recovery blocker.** This review concerns the closed host journal/receipt protocol and Linux regular-file fixture, not native authority, guest production readiness, mounts or VM acceptance.

Read the current parent AGENTS instructions, repository CLAUDE guidance, the v2 report/raw-volume contract, actual source diff and relevant surrounding state/schema/tests. The reviewed HEAD matched the request. Pre-existing dependency symlinks and bootstrap __pycache__ were left untouched. No source edit, push, CI launch, formatting, VM, mount, Mac disk tool, live app/daemon/home or Keychain operation was performed by this review.

## R1 — Live journal state is mistaken for a format-feature mismatch

`spikes/cowork-filesystem-bootstrap/bootstrap.py:132–133` takes the entire live dumpe2fs feature list and compares it exactly to the twelve pinned compatibility features. A journaled ext4 volume sets the `needs_recovery` incompat flag during normal read-write use and clears it after successful journal cleanup. It can therefore retain that flag after an unclean stop even while the superblock's state still prints `clean`. The source refuses such a volume as `filesystem_features`, before either the normal state decision or explicit full-read-only checker. `packages/core/src/cowork/volume-filesystem.ts:56–58` also requires the observed feature list to equal the pinned list, so returning the live flags without adjusting receipt semantics would not fix it.

Independent source verification: Linux6.18 `fs/ext4/super.c` sets the journal-recovery bit when mounting a journaled filesystem and clears it on successful journal cleanup; the clean-state bit is separately cleared for filesystems without a journal. [Linux ext4 superblock code](https://raw.githubusercontent.com/torvalds/linux/v6.18/fs/ext4/super.c). The ext4 superblock documentation identifies `INCOMPAT_RECOVER` separately from state/error bits. [Ext4 superblock fields](https://docs.kernel.org/filesystems/ext4/super.html). e2fsprogs maps that bit to the feature-list string `needs_recovery`. [e2fsprogs feature decoder](https://raw.githubusercontent.com/tytso/e2fsprogs/master/lib/e2p/feature.c).

A zero-I/O independent probe called the actual `probe` function with mocked descriptor operations and helper output. The in-memory superblock supplied valid magic, UUID, capacity and4096-byte geometry; the dumpe2fs header supplied `Filesystem state: clean`. No file, filesystem or helper was created/executed. Results:

```text
transient=False mode=normal: accepted
transient=False mode=full-read-only: accepted
transient=True mode=normal: refused filesystem_features
transient=True mode=full-read-only: refused filesystem_features
```

The only changed input was adding `needs_recovery` to the otherwise matching live feature set. Thus this is also an obstruction to the explicit full-check route, not merely a policy decision to require a full check after a dirty stop.

Required correction: distinguish pinned persistent compatibility features from explicitly allowed transient recovery state, bind/report the observed state clearly, retain refusal of unknown persistent features and actual error state, and keep a usable explicit recovery/check route. A normal probe must not silently certify an unclean mount. Add a host regression for the parser/state split and an isolated Linux fixture regression for actual recovery-bit metadata; root review must precede its Linux CI run. No automatic reformat, feature upgrade or deletion is an acceptable recovery response.

## Other scoped findings

No additional material blocker was found in the reviewed host correction. `prepareFilesystems` commits one consumed pair plan, rechecks exact owner/admission and descriptor identity, preserves only one previously confirmed history record, and selects probe-existing for ready/probing images. New probe nonces replace old ones; `currentFilesystemPlan` binds current rows/owner/UUID/geometry to the operation and `confirmFilesystems` rejects late receipts. Failed probe history does not itself satisfy current-owner readiness. Format-new uncertainty remains recovery-required and cannot restore eligibility.

Historical plan/receipt identity is checked against home/workspace, volume/creation/purpose, UUID and the actual recorded file identity/geometry before lending the v2 feature/zero/mount contract. Legacy protocol1 history stays readable but refuses v2 readiness/preparation with explicit compatibility-required. Schema9 migration preserves backing identity/owner without minting UUID or virgin provenance. New-format eligibility originates only from new sparse allocation and is burned by prior public writable descriptor exposure. Mandatory host authority and receipt-verifier ports remain injected/trusted obligations.

The formatter pins the feature list, UUID,4096-byte blocks,256-byte inodes, lazy inode initialization and nonlazy journal initialization. The helper preflights both FDs and scans virgin targets before the first formatting effect; probe-existing never formats. The `noinit_itable` receipt value is a required future mount contract, not observed mount enforcement. Exact native/immutable-bootstrap authentication, actual two-block-device mapping, protected receipt production, mount/user confinement and physical-space/write guards remain required separate gates.

The Linux fixture's new multigroup feature/zero-inode-table/sparse assertions require real Linux execution. Helper output files can grow until helper termination despite the retained4096-byte cap, and blocking kernel I/O remains outside Python deadline guarantees; these existing limits remain documented, not newly proved native recovery.

## Independent validation and limits

```sh
bun test packages/core/test/cowork/volume-filesystem.test.ts
python3 -I -S spikes/cowork-filesystem-bootstrap/test_bootstrap.py
git diff --check ad016d34 823f7003
```

Observed: **22 host tests passed,0 failed,87 expect calls**; **4 Mac protocol tests passed,8 actual Linux cases skipped**; diff check passed. These tests use disposable files and injected native authority; they do not execute a formatter on this Mac. The separate zero-I/O transient-state probe above reproduced R1 despite the passing host suite.

The author's broader87-host-test/600-assertion run and typecheck were read as recorded evidence, not rerun independently here. The earlier v1 Linux CI proof is unchanged and does not validate v2. No actual Linux format/probe/mount or guest/worker/VM readiness proof is claimed. Original `823f7003` should not be treated as corrected recovery behavior until R1 is fixed and re-reviewed.
