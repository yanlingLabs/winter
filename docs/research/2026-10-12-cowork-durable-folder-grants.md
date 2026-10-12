# Durable Mac folder grant implementation — 2026-10-12

Implemented on `cowork/durable-folder-grants`, isolated worktree `.worktrees/durable-folder-grants`, from output integration `4b104b62f533ee068b8b9e38f1568e5ce283e023`. This report describes source implementation and disposable host tests. It is not native provisioning, worker admission, TCC acceptance or production startup evidence. The parent explicitly assigned exclusive schema11 migration ownership for this slice.

## Implemented behavior

`packages/core/src/cowork/schema.ts:132` adds `cowork_folder_grants` to the existing protected runtime-state database, not a second authority store. Each grant binds its opaque grant/root/selection identity to exact home, workspace, source and issuing principal, root device/inode, access mode, canonical host path and bounded bookmark bytes. Source foreign keys and a unique active root per workspace prevent cross-source attachment and same-root aliases. The table admits at most 4096 records through the host store, including revoked tombstones; bookmarks have a SQL-enforced 64KiB bound. A full table refuses additional consumption instead of forgetting consumed identifiers.

`packages/core/src/cowork/folder-grants.ts:20` reads only current canonical source/workspace/home bindings. Metadata mismatch, removed or revoked sources, changed access, deleted/deleting workspace and malformed bookmark/root identity refuse resolution. Returned bookmark buffers are private copies, cleared after native use. Neither stored paths nor bookmarks enter public DTOs or the guest. Logical scrubbing on revocation is not a promise of secure erasure from SQLite/WAL/backups.

`packages/core/src/cowork/folder-selections.ts:120` prepares consumption outside the source transaction, resolving the current bookmark, protected-root policy, root access and descriptor-relative nofollow directory identity. Binding performs a held-FD identity/expiry check and current protected-policy check inside the source IMMEDIATE transaction, then inserts the source-bound grant. Native CoreFoundation bookmark resolution is outside that lock. `packages/core/src/cowork/repository.ts:155` and `:163` invoke this binding alongside source creation/addition, desired state, operation receipt and outbox. A failure anywhere rolls back all source/grant records; the pending preparation remains available until ordinary expiry/disconnect. Only a successfully committed binding releases its held descriptor and scoped bookmark. Source creation/addition reject pre-existing caller transactions before native preflight, so an outer rollback cannot undo accepted grant ownership after ephemeral cleanup.

The existing `CoworkHostPorts.selection` and folder grant adapter remain the selection/authority route. `packages/core/src/cowork/service.ts:215` and `:269` bind the normalized closed client request into idempotency before resolving ephemeral preparations. Exact request replay can therefore return an immutable original receipt after daemon restart or disconnect. It first authorizes the current workspace and current recorded sources and performs fresh grant resolution. A previously successful create/add request never inserts, restores or widens a grant. Changed requests conflict; removed/revoked/replaced roots refuse the old replay. Later policy narrowing does not turn an old recorded receipt into live authority.

`packages/core/src/cowork/folder-selections.ts:139` reopens durable grants without caching native authority: resolve the current bookmark, require the same canonical path, walk every directory component with nofollow descriptor-relative opens, compare device/inode, check required access, then reopen/compare after intake work. Every successful and failed lookup closes temporary descriptors/scopes. Missing roots, stale/relocated bookmarks, replacement inodes, denied native access or newly protected roots refuse instead of choosing another directory. Failed native validation invokes canonical source security revocation. `packages/core/src/cowork/repository.ts:178` scrubs bookmark/path and preserves a revoked tombstone in the same transaction as source trust/revision/config/grant changes and outbox. Security revocation still permits narrowing the last source; ordinary last-source removal still refuses. UI cleanup of an already consumed preparation is inert; source removal/revocation is the durable authority operation.

`packages/core/src/cowork/mac-host.ts:12` accepts the existing runtime-state handle. `packages/core/src/daemon.ts:2913` passes that handle into the default adapter. Migration11 is additive, preserves schema10 source/volume records, creates no grants for legacy source rows, rejects incompatible older writers through the existing version discipline and participates in empty-only explicit rollback. Populated authority, including tombstones, cannot be discarded by rollback. The only existing fixture change is its expected current version 10→11.

## Validation

Bun 1.3.14. All commands ran from this isolated worktree with the repository test preload, which sets disposable per-process temp roots, coordination, config and legacy-home paths. No production home, real picker, TCC permission change, real credential, VM, native mount or disk formatting was used. Existing folder-selection tests include a noninteractive CoreFoundation bookmark round trip for a disposable directory; the new durable tests inject the bookmark resolver and access failure.

```
bun test packages/core/test/cowork/folder-grants.test.ts
# 19 pass, 0 fail, 212 assertions

bun test packages/core/test/cowork/folder-grants.test.ts \
  packages/core/test/cowork/folder-selections.test.ts \
  packages/core/test/cowork/repository.test.ts \
  packages/core/test/ipc/cowork-workspace-api.test.ts \
  packages/core/test/cowork/volumes.test.ts \
  packages/core/test/cowork/volume-filesystem.test.ts \
  packages/core/test/runtime-state/db.test.ts \
  packages/core/test/runtime-state/db-run-folder.test.ts
# 138 pass, 0 fail, 1404 assertions, 8 files

bunx tsc -p packages/core --noEmit
# exit 0

git diff --check
# exit 0
```

The new tests prove exact binding/DTO privacy and descriptor/scoped-access cleanup; committed grant persistence over disconnect and independently reopened DB/class instances; create/add request replay without ephemeral entries; changed-request conflict; source revoke/remove tombstones and refusal of historical successful requests; rollback and preserved preparation; pre-existing transaction/principal/expiry/disconnect refusals; same-root aliases, reused selections and finite table/SQL bookmark bounds; native access failure, missing/replaced/relocated roots and live protected-root changes; current metadata match; schema10 upgrades preserving legacy rows without inventing grants; future-schema refusal; populated rollback refusal and empty rollback; default host admission refusal. The multi-source regression instruments the real store binder to prove the first grant was inserted before the second binding fails and the transaction removes both source/grant effects.

Retained evidence under the worktree's ignored `out/durable-folder-grants/`:

| File | SHA256 |
| --- | --- |
| `tests.log` | `63efb76f986b225878d57bb3aa3c47523d02f1d7e2fee9500c8722186489ebfc` |
| `focused-final.log` | `843b2134dcecd457455c488b57e6f230963d1b587666fa5deb40a6441a520df8` |
| `core-typecheck.log` (empty, successful exit) | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

Dependency inputs were temporary links to the existing output-integration installation; no install or dependency mutation occurred. The Core protocol link pointed to this worktree's own protocol sources. Links are removed before freezing. To recreate the exact lookup layout without changing the input installation:

```python
# Run from .worktrees/durable-folder-grants.
import os
base = os.path.abspath('../output-integration')
os.symlink(base + '/node_modules', 'node_modules')
os.makedirs('packages/core/node_modules/@yanlinglabs', exist_ok=True)
core = base + '/packages/core/node_modules'
for name in os.listdir(core):
    if name != '@yanlinglabs':
        os.symlink(core + '/' + name, 'packages/core/node_modules/' + name)
for name in os.listdir(core + '/@yanlinglabs'):
    target = os.path.abspath('packages/protocol') if name == 'winter-protocol' else core + '/@yanlinglabs/' + name
    os.symlink(target, 'packages/core/node_modules/@yanlinglabs/' + name)
os.symlink(base + '/packages/protocol/node_modules', 'packages/protocol/node_modules')
```

## Acceptance limits

Default host `requireProvisioning` still refuses, and creation ceiling remains unavailable. Capability projection still reports provisioning/execution false and repository preparation false. Tests admit source CRUD only through an explicit disposable fixture host. An accepted source remains preparing/untrusted; no new mount-ready producer or Cowork conversation activation is added.

Durable bookmarks are location/access evidence under the existing authenticated Mac control principal. They do not prove a UI gesture or signed-client identity, establish external HomeIdentity admission, admit copied homes, or authorize a sandboxed worker. A future native share adapter must consume current source-bound grant authority and keep the actual worker scope/descriptor lifetime tied to effective revocation; this metadata lookup alone is not that adapter. Native provisioning, full worker admission/stop and guest detach/ready acknowledgment remain separate gates. Real restart behavior under macOS TCC/security-scoped bookmarks has not been exercised here.

This v1 host state uses the accepted existing protected plaintext database/permissions model; it introduces no encryption requirement or same-user confidentiality claim. No push, SDK release/pin or activation was performed. Independent source review is requested separately.
