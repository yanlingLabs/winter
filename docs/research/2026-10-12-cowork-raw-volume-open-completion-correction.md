# RAW volume open transaction-completion cleanup

Date: 2026-10-12. Narrow follow-up to `2ba89506d86966a74528136ad2dbf5e6456fc069`. The accepted R1 caller-transaction guards remain intact. This change addresses an additional failed-open resource/accounting path and makes no native-worker or production acceptance claim.

Before this fix, `CoworkVolumes.open` opened a real image descriptor and incremented its local outstanding-handle count inside the transaction callback. If transaction completion threw after that callback, the method threw without returning a handle, but neither the descriptor nor the local count was cleaned up. A disposable regression injected that exact boundary by wrapping the real runtime-state transaction, running its callback, then throwing before successful completion. The backup verification seam observed the real image descriptor. The pre-fix test independently found that `fstatSync` still succeeded and later release refused with `stop_unconfirmed`:

```text
descriptorClosed: false
releaseError: CoworkVolumeError: stop_unconfirmed
```

Canonical ownership remained the previously committed owner; this is a descriptor leak and false local ownership debt, distinct from R1's rolled-back ownership escape. The intentionally failing test closed its leaked descriptor afterwards.

`open` now retains the pending handle outside the transaction callback, closes it when the transaction call throws, and increments local handle accounting only after the transaction successfully returns. The original error propagates. Successful opens keep their existing idempotent close and persisted ownership behavior. No ownership is silently cleared by error cleanup.

The regression verifies the image descriptor reports `EBADF` after the injected completion failure, canonical ownership stays unchanged, valid fixture stop release succeeds rather than finding stale handle debt, and the next owner can claim/open/write/read back data normally. Stop authority is injected fixture policy, not proof of actual native termination.

Validation from the isolated worktree:

```sh
bun test packages/core/test/cowork/volumes.test.ts -t 'failed transaction completion'
ln -s '../output-integration/node_modules' node_modules
ln -s '../../../output-integration/packages/core/node_modules' packages/core/node_modules
pnpm typecheck:core
bun test packages/core/test/cowork/volumes.test.ts packages/core/test/cowork/repository.test.ts packages/core/test/cowork/admission.test.ts packages/core/test/runtime-state/db-run-folder.test.ts
rm node_modules packages/core/node_modules
git diff --check
```

The new regression failed before the fix (**0 pass, 1 fail**) and passed afterwards (**1 pass, 0 fail, 5 expect calls**). Focused coverage passed: **68 tests, 0 failures, 484 expect calls across 4 files**, Bun `1.3.14 (0d9b296a)`, approximately 3.62 seconds. Core typecheck and diff check passed. Dependency links reused the existing isolated installation, then were removed; no package/lockfile/pin changes were made. No wider suite rerun, native build, VM, live app/daemon/home, real Keychain, global backup configuration, push, merge or release was performed. Real tmutil coverage still touched only disposable image item exclusions. Native descriptor transfer/stop verification, formatting/readiness and production resource/security gates remain separate work.
