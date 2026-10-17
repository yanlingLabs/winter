# Cowork

*Read this before touching `packages/core/src/cowork/**`, `packages/protocol/src/cowork.ts`, `apple/Cowork/**`, the host-storage fence or `home-fence`'s Cowork roots, `refreshForStorage`, or the `workspace.*` / `project.*` methods and events.*

Cowork is not an implemented session mode: no Cowork session can be created or run, and `SpawnSession` refuses `type: "cowork"`. The protocol RECOGNISES the name (`SESSION_MODES`) so every door can refuse it typed: `session.create {mode: "cowork"}` answers `unsupported_topology` for every role, and a stored cowork row is refused rather than read as Code (see [runtime-and-sessions.md](./runtime-and-sessions.md)); there is deliberately no Cowork prompt, tool allowlist or run home. The host side exists: workspace metadata, guidance, schedules and outputs. What exists and what still blocks a functional mode: [cowork-status.md](../cowork-status.md). The design: [cowork-spec.md](../cowork-spec.md).

## Ordinary host execution policy

Accepted 2026-10-12.

- Ordinary native Code, approved shell escapes, plugin hooks, LSP and third-party MCP tools get NO persistent outer Cowork Seatbelt profile. Each tool's own sandbox stays unchanged; never inject sandbox/GPU/Chromium/LSP compatibility overrides.
- Sandboxed Bash gets the protected Cowork, runtime, control and socket roots in the existing `sandboxConfigFor` denyRead/denyWrite arrays, rendered as ONE profile.
- Approved escapes keep main's behavior and no Seatbelt. Cowork escape matching is write-shaped integrity guidance, not confidentiality.
- Core/SDK file tools keep their canonical protected-path checks.
- Actual floors apply only to explicitly Winter-owned Cowork workers and bridges.
- Ordinary child execution history never requires a daemon restart before first activation.

## Storage scope (first version)

Separate per-workspace encryption is DEFERRED (user ruling, 2026-10-12). The contract and its gates: [cowork-storage-security.md](../cowork-storage-security.md).

- Private VM/disk images are plaintext, with owner-only permissions, verified file identity and backup exclusion.
- FileVault protects offline host-volume access when enabled. Same-user processes, approved escaped commands (which run as the user) and authenticated API access can read images; these are explicit residuals.
- Still required: VM isolation, selected-folder boundaries, host credential custody and active RAM return. Key-broker/LUKS work is preserved as deferred research, not an activation gate.

## `refreshForStorage`

The installed SDK has no live sandbox-settings control, so `refreshForStorage` awaits the daemon's policy consumers:

- **Code** holds queued work, lets its current turn finish, then recreates its logical incarnation/run home with the same session/backend identity and the current sandbox paths; held work resumes there.
- **Chat/Dispatch** Workers, with the accepted SDK v1 nine-family context contract, acknowledge live protected-path updates without aborting their turn or recreating the runtime; a cold protected start waits for its own matching acknowledgment. Namespace, version and family checks stay required.
- The unchanged installed SDK pin lacks that contract: its existing Workers must close before activation and its protected Chat/Dispatch launches stay refused.
- A pending or failed refresh blocks provisioning, without claiming third-party descendants were stopped.

Historical persistent-Code-floor reports describe the superseded approach.

## Storage lifecycle (records and guards only)

None of this makes Cowork runnable; there is still no creation door. Sentences followed are quoted in the code and tests.

- **Backup exclusion** is the raw-volume primitive's (`cowork/volumes.ts`, `volume-backup.ts`): a sticky `tmutil addexclusion` (never `-p`) on each image when it is created, re-verified on every claim and open; shared instructions, memory and outputs get none. `test/cowork/volume-backup-adapter.test.ts` pins the real adapter on disposable files.
- **Image pins and export generations** (`cowork/images.ts`, `cowork/exports.ts`, `cowork/storage-lifecycle.ts`, runtime-state schema 16): trusted-controller classes with a mandatory authority port, no RPC. A pin records the base and runtime image digests and walks an update through `beginUpdate` then `confirmUpdate` or `abandonUpdate`, only while stopped and unowned, with a mandatory compatibility port; the live digests do not change until confirmed. An export generation is a recorded, manifest-bound descriptor of a stopped, ready, pinned workspace. `validateImport` judges a presented descriptor against canonical records and grants nothing. No bytes are copied, no snapshot is taken, and no restore runs.
- **Migration B** never copies Cowork storage (`migration/cowork-exclusion.ts`): `cowork/**` is skipped, and a source holding any Cowork tree or populated Cowork table refuses with `cowork_storage_present` (the daemon's boot hook logs one skip line instead). Only the coordinated, quiescent migration the contracts describe could move it, and that does not exist yet.
- **Migration C** never names Cowork storage: its moves are the fixed `SDK_COMPAT_LINKS`, `hostRuntimePredicate` keeps guest sessions out of runtime-state rewrites, a workspace that is not `stopped` or a volume that records an owner refuses it, and a manifest naming a `cowork/` path refuses resume, phase 2 and rollback. A rollback with populated Cowork records is refused by the schema step.
- **Retention**: deleting a standalone workspace's only conversation tombstones its binding and, when the workspace is retained and stopped, archives it in the same transaction ("Detach/archive its workspace for explicit later deletion/export"): wake and disk admission refuse until an explicit restore, and both volumes and every shared file stay untouched. A Project workspace is unaffected, and a workspace that is not stopped stays retained. That transition lives in `abandonConversation`, and every route that retires a session reaches it: through `createCoworkSessionDeletionHook` (the boot reaper in `daemon.ts`, the mint-time reaper in `ipc/server.ts`, the cleaner's `onDelete`, the `session.create` refusal rollbacks, and the dispatch-children spawn-failure rollback) and directly from the missing-session branch of `CoworkWorkspaceEvents.drain`. None of them removes a volume or a shared file; they delete a session, tombstone its binding, and archive a stopped standalone workspace. **Owner decision 2026-10-16: keep archive-on-any-deletion, no behavior change.** The owner treats a workspace's own state (memory dir, temp dir, scratch, the VM disks) as temporary. It is removed only by the explicit, confirmed workspace delete (not built yet); the reapers, the cleaner and retention archive without removing anything, consistent with `cowork-spec.md` ("Scratch and outputs survive ordinary stop/archive"). Connected Mac folders and GitHub repositories are not part of the workspace and are never cleared. Archive is a state flip that deletes nothing, so automatic archive from every trigger above is acceptable. `test/cowork/storage-retention.test.ts` pins the behavior and ratchets the destructive primitives allowed under `src/cowork`.
- **Owner decisions 2026-10-16** (detail in [cowork-storage-security.md](../cowork-storage-security.md#owner-decisions-2026-10-16); the slices are not built): workspace delete removes the VM disks plus the workspace's shared guidance, memory and outputs, only after a confirmation that lists them and offers an export first, never touches connected Mac folders or GitHub remotes, and warns when a GitHub-backed clone on `data.ext4` has unpushed commits or uncommitted changes; an export is a `.winterworkspace` folder bundle (the intended implementation, not part of the decision: the closed manifest plus sparse-copied images, cloned with APFS `clonefile` where possible); VM disks stay excluded from Time Machine and export is the backup path.
- **Still open (technical, not yet built)**: the `.winterworkspace` bundle writer; the shared-file snapshot (a proposal, not contract text: clone where possible, otherwise a double-pass hash, refusing the export if the passes differ); the restore flow (re-recording device/inode after a restore, an approved empty replacement through the existing ApprovalBroker card); the `workspace.archive`/`restore`/`delete` operations and `workspace.export.*` RPCs; wiring the image pin into admission with the native controller slice; and a Cowork-aware Migration B (until then it keeps refusing).

