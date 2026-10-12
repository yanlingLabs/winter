# Independent ordinary journal-only recovery review

Frozen source: `b4bf90db90767eab1b7e92b71d16e4150cc88fdc`, parent `9c48655d`. **Changes required: one confirmed lost-debt blocker.** No formatting, mount, Linux filesystem tool, privileged service, VM, app, live home or Keychain was used. This review does not revisit the separately held native VM fixture task.

**Correction verdict:** `2a6f28f0c866aac36557da44abe4460ada7bc41a` closes the blocker and is accepted for the reviewed host state/protocol scope. The original failure below remains historical evidence; the independent correction verification is appended at the end. Actual Linux replay and native producer/artifact gates remain open.

## Blocker: a malformed current receipt can erase uncertain replay debt

`packages/core/src/cowork/volumes.ts:68` treats any truthy `journal.receipt` as sufficient to take the no-debt branch. It checks only that `replayDebt` is absent, without validating that receipt against the current plan or requiring the atomically confirmed ready state.

`readyFilesystemHistory` in `packages/core/src/cowork/volume-filesystem.ts:90` then falls back to valid `previousReady` when that malformed current receipt does not match. The row remains usable as a previously ready probing volume. `prepareFilesystems` at `volumes.ts:367` observes no debt, skips the old-owner/new-owner and stop-proof requirements at `:370`, and issues another replay-capable intent under the same owner.

Independent disposable-DB reproduction, using the existing unprivileged fixture:

1. Allocate the pair, commit a format intent and confirm its fixture-only protected ready receipt. No actual filesystem is formatted.
2. Prepare an ordinary replay plan; the canonical rows enter probing with replay debt and valid previous-ready history.
3. Replace each recorded journal with the same journal except `receipt: {}` and no `replayDebt`.
4. Make `verifyPreviousReplayStopped` return false and call `prepareFilesystems` with the original owner.
5. Expected: malformed-state refusal before a new effect. Actual: a new `replay-journal-then-probe` pair is returned, with `priorReplay: null` and the same owner.

This is malformed canonical durable-state handling, not a demonstrated guest RPC or arbitrary-DB-write capability. It nevertheless violates the stated fail-closed malformed/missing-debt contract and can lose the evidence needed to fence an uncertain old writer.

**Correction:** if a current receipt field is present, require an exact matching, clean receipt for the current plan and a state consistent with atomic ready confirmation before accepting debt absence. An invalid current receipt must refuse; it must not fall back to previous-ready history to authorize a fresh write. Retain normal previous-ready fallback for genuinely receipt-absent interrupted operations with the required debt. Cover empty/null, stale-operation, dirty/transient and probing-with-current-receipt variants, including byte-for-byte preservation of the original journal on refusal. The author has acknowledged the finding; no correction is pre-accepted by this frozen review.

## Other reviewed behavior

- Replay intent and debt are committed in the same immediate transaction before writable FD handoff. Debt is pair-consistent and binds operation plus exact controller/worker/incarnation/lease/image owner. Ordinary failure retains probing state, owner, previous-ready history and consumed format eligibility. A new replay attempt requires a distinct owner and explicit old-writer stop evidence; raw owner release independently requires its existing stop verifier. Read-only retries retain old uncertain-write debt until it is proved stopped.
- `currentFilesystemPlan` binds both canonical rows and each ready-operation anchor. Current confirmation requires protocol 3, exact receipt shape, current native authorization, protected receipt verification, journal-write authority where applicable and old-debt stop evidence where applicable. Pending transient recovery refuses readiness. Format-new cannot claim a replay result. No source JSON receipt alone is intended to authorize a write.
- The bootstrap checks both descriptor identities and performs both read-only preflights before its first effect. Existing targets require expected UUID, geometry, exact persistent features and normal clean-state headers. Only the separately listed `needs_recovery` transient triggers the fixed `e2fsck -E journal_only` command. There is no preen, full repair, force check or automatic reformat in that branch. A clean target reports no replay. Success accepts only exit 0/1, fsyncs and re-probes; a remaining transient refuses. Non-clean/errors still require the explicit full-check path. The explicit full-read-only path never takes replay.
- Fixture descriptors are pinned regular files, exact identity/size/mode, RW and non-append; probe subprocesses receive separate RO descriptors. External tools have fixed argv/environment and owned subprocess timeout/reap behavior. Retained output is checked at 4096 bytes; temporary output-file growth before that check is not a streaming disk-space cap. Actual immutable-tool/native-envelope admission remains an integration prerequisite.
- Canonical journal JSON has a 16 KiB byte bound before parsing; plan/debt/owner/target fields have closed shapes, bounded tokens and numeric geometry. Previous-ready history is one level rather than recursively appended. Python validates closed bounded fields before copying the plan. TypeScript additionally rejects `priorReplay` combined with format-new; the Python validator does not repeat that specific restriction, so production native-envelope authentication must reject a noncanonical plan rather than trusting the Python shape alone. The frozen Core producer cannot emit that combination.

## Independent verification and limits

Used a disposable archive of the exact commit, with local protocol source and installed dependency links. Added the reproduction only to the archived test copy and removed all scratch files/links afterward. Original source and worktrees were not edited.

- `bun test test/cowork/volume-filesystem.test.ts`: **28 existing tests passed; 1 independent lost-debt regression failed; 114 assertions**. The failure was “Received function did not throw,” followed by the new same-owner replay plan with `priorReplay: null`.
- `python3 -m unittest -v test_bootstrap.py`, with the Linux fixture opt-in removed: **9 no-effect/protocol tests passed; 10 Linux effect tests skipped**. The passing mocks establish both preflights before replay, wrong second-target refusal before writes, no replay for clean targets, and transient/error/header rules. They do not prove Linux journal execution or recovery of real pending journal transactions.

The Linux regression writes retained content and sets the recovery feature on a disposable image before running the journal-only route. It is useful for command selection, clean re-probe and preservation of existing bytes, but does not itself synthesize a nonempty crash journal containing uncommitted transactions. Actual Linux CI and immutable/native producer re-review remain gates. This new protocol also requires a newly bound bootstrap/artifact; the older packaged image cannot be relabeled as supporting it.

Only this requested report was written. No new implementation commit, push, VM launch receipt or production-readiness claim was made.

## Independent correction review: 2a6f28f0

Reviewed the complete `b4bf90db..2a6f28f0c866aac36557da44abe4460ada7bc41a` source/test delta. `volumes.ts:67` now checks receipt **key presence** before the replay-debt branch. Any present receipt requires the ready row phase, a non-null receipt matching the exact current plan, and no pending transient recovery. Empty, null, stale, dirty or clean-but-probing receipts refuse before previous-ready fallback can authorize another plan. Valid legacy ready receipts remain readable history; current readiness still requires protocol 3.

Re-ran the original independent `receipt:{}` plus removed-debt regression **unchanged** in a disposable archive of the correction. It now refuses before a new plan is minted and before the false stop verifier is called. Ran the entire focused file with the author's five additional variants: **34 tests passed, zero failures, 130 assertions**. The five variants also assert that owner, probing state and exact stored journal remain unchanged after refusal. Existing normal-format/probe/retry and protocol-history tests still pass.

This was unprivileged host fixture work using synthetic protected receipts and new disposable regular backing files; no actual filesystem formatting, mount or Linux replay command ran. Local protocol/dependency mappings were isolated and all scratch files removed. The reviewed fix changes neither bootstrap commands nor the previously inspected pair preflight, and no new false-ready or lost-debt path was found in this delta. The Linux-only behavioral cases and actual immutable native authority/stop producer still require their separate verification; this acceptance does not substitute for those gates.
