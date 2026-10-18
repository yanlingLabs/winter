# Durable folder grants independent review — 2026-10-12

Current disposition: **accepted for the bounded durable-grant metadata scope at `ebd76deff7575b12d19c302838f0571d59ec648a`**, following the correction re-review below. The initial findings are retained as history.

Reviewed frozen `6b0425ee3d1d88405dded30d0f58f0d6903e5c82` in `.worktrees/durable-folder-grants`, against parent `4b104b62f533ee068b8b9e38f1568e5ce283e023`. Read-only source review and disposable metadata tests only. No VM, network, privileged operation, picker, live home or real Keychain was used. Temporary dependency links were recreated from the author's documented layout and removed after verification; the reviewed worktree is clean.

## Finding: P2 — schema 10 operation receipts lose exact replay after upgrade

`packages/core/src/cowork/service.ts:215` and `:269` now set `requestDigestInput` to the parsed client request. `packages/core/src/cowork/repository.ts:110` compares its hash against the stored receipt; `:115` uses that new representation for new writes. The previous service instead passed normalized resolved source details (and creation ceiling/default policy for create) into repository hashing. Migration 11 (`packages/core/src/runtime-state/db.ts:236`) adds only the grant table and neither versions nor translates the existing receipt representation.

Consequently an unchanged, still-authorized repository create/add request with a schema 10 receipt is rejected as `request_conflict` after schema 11 opens the database. This also affects repository-only workspaces, independently of legacy folders intentionally receiving no invented durable grant. No duplicate workspace was created, but the durable idempotency contract is broken for existing receipts.

Reproduction used a disposable runtime-state DB, a local fixture principal, a readable/writable injected GitHub grant, and exactly the previous service's `records.create` / `records.addSource` arguments and context (RPC method, principal, request ID and expected revision, without `requestDigestInput`). Exact repository replay before migration returned the same operation ID. The fixture then dropped the new empty grant table, set schema version 10, reopened through the real migration, and submitted the unchanged original client requests to the new service. Actual output:

```json
{"oldRepositoryReplaySame":true,"schema":11,"errors":{"workspace.create":"request_conflict","workspace.source.addRepository":"request_conflict"}}
```

Preserve a versioned compatibility path for prior receipt digests, with current authorization checks and no grant reconstruction. Add migration/retry regressions for create and add, alongside changed-request conflicts. Acceptance is pending this correction.

## Validation observation: process-wide FD equality is unstable

The independently rerun documented eight-file suite produced **137 passed, 1 failed, 1394 assertions**. `packages/core/test/cowork/folder-grants.test.ts:43` expected `/dev/fd` count 597 and received 594. A process-wide count can decrease as unrelated test/runtime descriptors close; this failure does not demonstrate a grant leak. Prefer checking the particular owned descriptor or an isolated-process fixture rather than exact global equality. The focused new test file independently passed **19 tests, 212 assertions**. `bun run typecheck:core` exited 0. Local evidence: `/tmp/cowork-durable-independent-tests.log` and `/tmp/cowork-durable-independent-focused.log`.

## Inspected mechanisms and limits

The new grant/source writes and revoke tombstones are inside the repository's immediate transaction. Failed binding/receipt validation rolls back source, grant, operation and outbox together; successful cleanup follows repository commit, and service calls reject pre-existing transactions for create/add. Grant bindings carry home/workspace/source/root/access identity; fresh durable lookup resolves the bookmark and checks current path, device/inode, access and protected roots. Replay reauthorizes current sources without reinserting grants. Expired/disconnected unconsumed preparations cannot become new grants. Public DTO projection omits host paths, bookmarks and grant/root references. Schema 11 preserves existing sources without inventing authority and prevents populated downgrade.

These findings concern metadata persistence only. Default provisioning/execution remain refused, and no actual native share lifetime, sandboxed worker authorization, TCC restart, or VM acceptance is established by this review.

## Correction re-review — ebd76def

Independently inspected `6b0425ee..ebd76deff7575b12d19c302838f0571d59ec648a`. Both initial findings are resolved; no remaining material finding in this scoped review.

`packages/core/src/cowork/repository.ts:35` tags new client-request digests with `v2:`. Legacy 64-hex digests take an explicit resolver path at `:124`, using the same normalized creation/selection functions as the old write contract; new digests do not call that resolver. `packages/core/src/cowork/service.ts:216` and `:274` freshly resolve the supplied selection and current authority for legacy receipts, then reauthorize the recorded workspace/sources before returning the original receipt. Missing legacy preparations are denied without inventing authority. No grant/source writes occur during successful replay. This deliberately does not recover the unmerged first candidate's unversioned client-request digests or lost legacy selection authority.

The revised descriptor test observes the actual preparation's FD/device/inode rather than a global count. Added schema10 create/add migration regressions cover the reproduced failure, changed resolved payloads, unavailable selections, current grant revocation, and lost legacy folder preparations. Existing new-version restart/revocation/rollback tests remain covered.

Independent rerun of the documented eight-file suite: **142 passed, 0 failed, 1432 assertions**. `bun run typecheck:core` exited 0. Evidence: `/tmp/cowork-durable-independent-correction-tests.log`. Temporary dependency links were removed; the reviewed worktree remains clean at the accepted SHA. No privileged/native/VM activation or push was performed.
