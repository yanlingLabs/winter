# Durable grant receipt compatibility correction — 2026-10-12

Correction to frozen `6b0425ee3d1d88405dded30d0f58f0d6903e5c82` in the same isolated `cowork/durable-folder-grants` branch. Independent source review reproduced an exact schema10 create/add retry returning `request_conflict` after upgrade: schema10 digests bound normalized resolved source/ceiling input, while the initial schema11 service used closed client parameters without a discriminator. The reviewer also reproduced a process-wide `/dev/fd` assertion failing when unrelated descriptors closed. Original author evidence and the independent report remain separate, retained history.

## Correction

New source CRUD requests store `v2:<sha256>` in the existing `cowork_operations.request_digest`. Other repository operations that retain their original normalized input contract remain unchanged. The schema stays11; no second DB or migration rewrite is needed. The digest prefix makes the two contracts unambiguous.

Repository `replayCreation`/`replaySourceAddition` first locate a principal/method/scope/request-ID receipt. For a v2 digest they verify the closed normalized client input and expected revision directly, preserving restart replay without consuming another preparation. For a legacy 64-hex digest they invoke a host-only callback outside the mutation transaction. The callback freshly resolves the **supplied** selection through the existing selection adapter and current authority. Creation also requires a current host creation ceiling. Shared normalization functions reconstruct the exact schema10 payload (bounded selected source details/access/labels, normalized ceiling, title/ownership/default policy and expected revision). Only an exact old payload hash match permits returning the immutable receipt; current workspace/source/grant authorization is then checked again. No provisioning effect or source/grant write occurs on a verified retry, even if new provisioning is unavailable.

Legacy payloads never stored the original opaque selection IDs or closed client request. The fallback does not derive or invent them from receipt contents. An unavailable original selection, revoked current grant or missing current host ceiling refuses; changed resolved selection or ceiling conflicts. A supplied selection that cannot be proven current is not replaced with a recorded source. In particular, old folder preparations lost on restart cannot be converted into durable grants or safely replayed by guessing their IDs/bookmarks. Existing workspace/history remain intact. This is bounded compatibility, not a promise to reconstruct missing legacy authority. The unmerged initial candidate's unversioned client-input hashes are likewise not silently reinterpreted as verified legacy normalized payloads.

The descriptor regression now observes the exact FD held by the tested preparation and its device/inode. After commit it asserts that FD no longer refers to that owned directory, accepting either closure or unrelated FD-number reuse. Scoped-access cleanup remains checked separately. Process-wide descriptor count is not used as evidence in this new durable test.

## Validation

All new tests use disposable homes and injected authority/bookmark resolvers; production gates remain false. Added schema10 upgrade regressions exercise the original normalized `records.create` and `records.addSource` contexts and service retries for both methods. They prove exact replay, unchanged operation/workspace/source counts, changed title/source/ceiling refusal, missing selection refusal, live grant revocation refusal, explicit v2 digest and replay without a consumed selection, and lost legacy folder preparation refusal with no invented grant. Existing rollback/restart/revocation/privacy tests continue to pass.

Commands and temporary dependency-link recreation are in the [initial report](2026-10-12-cowork-durable-folder-grants.md). Current validation runs the same eight files plus the four new regressions in `folder-grants.test.ts`:

- Focused durable suite: 23 passed, zero failed, 240 assertions.
- Grant/selection/repository/IPC/volume/filesystem/runtime-state eight-file suite: 142 passed, zero failed, 1432 assertions.
- `bunx tsc -p packages/core --noEmit`: exit0.
- `git diff --check`: exit0.

Logs are retained in ignored `out/durable-folder-grants/correction-focused.log`, `correction-tests.log` and `correction-typecheck.log`. 

| File | SHA256 |
| --- | --- |
| `correction-focused.log` | `a516fdc30f4d89589951c4ab5a5418fe7a32971f1a41aaf6a5381b0f235959a2` |
| `correction-tests.log` | `5c422482e044f1a8962514b8c813f05ef1973b7ff3a109973236a8461ec3bb4c` |
| `correction-typecheck.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

The empty typecheck log corresponds to successful exit0. Original logs are preserved. No push, VM/native activation, mount, formatting, real picker/TCC change, release or SDK pin was performed. Re-review of this correction is requested independently.
