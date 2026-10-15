# Local reads of canonical workspace outputs

Source slice on `cowork/workspace-output-reads`, based on accepted Core
`37b68e0aa7ab1cee98c54bfd649253892e52aa81`. This does not enable Cowork execution,
provision a production workspace, launch a worker, change availability or SDK pins,
or implement a file browser/export UI. Native VM/egress and GUI/testhost holds remain.

## Canonical ownership and initialization

Schema15 adds `cowork_output_directories` (recorded HomeIdentity and actual directory
identity), `cowork_output_locations` (opaque location, home/workspace/conversation,
exact owned relative root and immutable location revision1) and
`cowork_output_directory_intents` (an initialization journal, below; not authority). The only layout is
`<canonical-home>/cowork/workspaces/<workspace-id>/shared/outputs/<session-id>`.
Neither ordinary `<home>/outputs/<session-id>` nor cwd-derived MEMDIR is a fallback.

`CoworkOutputs.initialize(workspaceId, sessionId, committedSessions)` is a trusted
future storage-owner API, never an RPC. The caller first commits the actual
SessionStore session/header, then canonically binds that conversation, then calls
initialization synchronously with that same open trusted store. No await/reentrancy,
caller-owned index transaction, caller-owned authority transaction or lifecycle
change may intervene. The mandatory committed-session dependency has no optional
or default-true path. Source fixtures use the actual SessionStore.

The future production owner must establish the already required registered host
storage protections before materializing backing content. This slice supplies no
production initialization caller and does not activate those protections or native
admission. Reads work only for explicitly recorded backing; ordinary daemon boot
constructs the optional reader and catches unsupported topology without changing
Code behavior. There is no initialization method in the RPC table.

Initialization walks every absolute home ancestor using held O_NOFOLLOW directory
descriptors. The supplied home and recorded backing directories must be user-owned
0700. New directories are synced with the unchanged reviewed file/directory helper
before one scoped durable SQLite owner commit. An existing ancestor may be reused
only when an independent canonical instruction/volume identity matches it, or when
it is the journaled leftover of an earlier attempt (next section). Any other
preexisting workspace/output/session directory is refused. Missing identity or a
replaced root requires recovery; the reader never enrolls/recreates anything.
Separate conversation deletion retains its tombstone and outputs; workspace
deletion/deleting state denies reads. Archived workspace content remains available
to the local user.

### Initialization intent journal

Directory creation precedes the owner commit, so any failure between the first mkdir
and that commit (an fsync error, a refused recheck, SQLITE_BUSY, a full disk, a
constraint abort, a crash) used to leave unrecorded directories that every later
initialization refused forever, including the shared `cowork/workspaces/<id>/shared/
outputs` ancestors of every other session in the workspace. The journal follows the
guidance-mutation pattern (journal commit, filesystem effect, finishing commit):

1. After the unchanged preflight, a read-only pre-walk of the canonical chain runs
   from the home down through the same held O_NOFOLLOW descriptors, with no mkdir,
   no sync and no checkpoint, applying the walk's own owner/mode/device/record/
   admission checks. A directory that exists unrecorded with no recorded or admitted
   identity and no intent committed by an earlier call is foreign: the call refuses
   with `file_unavailable` BEFORE any intent is written. The first component that
   does not exist (ENOENT) and everything below it are the "absent" paths. Then one
   scoped durable transaction rechecks workspace, active binding, the committed
   session, HomeIdentity and retained state and inserts a
   `cowork_output_directory_intents` row only for those absent paths that have no
   `cowork_output_directories` record and no intent yet (`cowork` through
   `…/shared/outputs/<session-id>`). The home itself keeps its existing handling.
   A path that has a `cowork_output_directories` record but is missing on disk (for
   example `shared/outputs` removed after another conversation recorded it) can never
   match its recorded identity again: the pre-walk refuses it, and the journal
   transaction refuses any path that is both recorded and absent, before any intent
   is written or any replacement directory is made. The intent insert is a plain
   `INSERT` after the existence check, so a primary-key collision with a row of
   another home identity fails loudly instead of being ignored.
2. The walk is otherwise unchanged. A directory that already exists UNRECORDED is
   admitted only if all hold: an intent row for exactly that relative path and the
   current HomeIdentity was committed by an EARLIER call (an intent inserted by the
   current call never blesses a directory that was already standing, so an unknown
   preexisting directory is still refused); it was opened through the held parent
   descriptor with O_NOFOLLOW; it is owned by the daemon user with mode exactly 0700;
   it is on its held parent's device; and the existing instruction/volume admission is
   otherwise unchanged. Its parent is already held and recorded or admitted by the
   same walk. Admitted directories are synced again (the failed attempt may have
   failed at that very sync), join the new entries and are rechecked by the same final
   tree assertion as created ones. Symlinks, non-directories, 0755 or other modes,
   foreign owners and cross-device entries remain `file_unavailable`.
3. The owner commit inserts the directory and location rows as before and deletes the
   intent rows of every now-recorded path, in the same transaction.
4. If the call fails, the in-memory set of directories it created is known: intents it
   inserted for directories it never created are removed (database only, best effort),
   because a leftover intent could otherwise bless a foreign directory that appears
   there later. Intents for directories it did create stay, so the retry (same
   session, a restarted process or another session in the workspace) adopts them.
   Because only absent paths are ever journaled, a foreign directory that already
   exists is never given an intent, even if the process dies before the cleanup runs.
   The pre-walk refusal and the absent-only journal each independently keep that
   invariant; both are kept. The residual is narrower: a hard crash AFTER the journal
   commit leaves intents for paths that were absent at that time, and a same-user
   process that later creates a 0700 same-device directory at exactly such an internal
   path would have it adopted by the next call. A same-user racer that wins before the
   mkdir of a live call is refused and its fresh intent forgotten. The journal records
   intent, not the created inode, so this is documented, not eliminated. Two more
   documented residuals: initialization assumes a single writer process (the
   pre-walk, journal transaction and owner commit are not serialized against a second
   process; the create walk's checks and the final rechecks, including the
   location-conflict recheck, remain the authority), and a development store already
   stamped schema version 15 before this table existed does not re-run migration 15,
   so initialization fails closed with `file_unavailable` until the table is created
   (rewind `user_version` to 14 so the idempotent migration re-runs).

Nothing is ever deleted or renamed on disk. The reader never consults the journal.
A non-empty journal makes the explicit schema downgrade refuse like any populated
Cowork table.

## Local API and bounds

- `workspace.output.list`: paginated canonical location records only, at most100;
  no filesystem enumeration, content names, backing paths, or availability claim.
  Inventory cursors bind the owning workspace/home and current record generation.
- `workspace.file.stat`: opaque location, expected location revision and relative
  path; returns file byte size and an opaque generation token.
- `workspace.file.read`: requires that generation and returns the first bounded
  chunk. It does not promise the whole file in one response.
- `workspace.file.readRange`: explicit offset, expected generation and bounded
  chunk. Responses contain base64, offset, nextOffset and EOF.

Paths are at most4096 UTF-8 bytes/32 components, with each component at most255
UTF-8 bytes; absolute paths, empty/dot/traversal/NUL components and invalid Unicode
encodings are rejected. Reads allocate at most256 KiB of decoded bytes per call
(default64 KiB). Output file responses use a384 KiB inner JSON budget; existing
metadata methods retain128 KiB. Protocol tests bound worst path escaping plus a
256 KiB binary chunk and an encoded outer wrapper below512 KiB. That test is budget
evidence, not paired admission: all four remote mirrors still exclude these methods.

The reader admits ordinary single-link regular files owned by the host user under
held roots, including binary content and legitimate names such as `index.db` or
`manifest.json`. Symlinks, hard-link aliases, special files, unexpected devices and
unsafe parents are refused before returning content. Untrusted output text is not
executed or scrubbed. The generation is an optimistic kernel metadata version,
not a content SHA-256 or immutable snapshot: it hashes the location revision and
vnode/size/mtimeNs/ctimeNs/mode/link/owner facts. Every stat/read rechecks the held
file, its current directory entry, all held ancestors and current canonical user/
workspace/location ownership before returning. A changed file/generation refuses;
callers must stat again, discard earlier chunks and restart the read. This is no
whole-workspace synchronization loop or hardware power-loss proof.

Typed errors distinguish `file_missing`, `file_unavailable`, `stale_file`,
`file_incomplete`, revision conflict, invalid request and authority denial. Missing
recorded roots remain unavailable; a missing content entry is distinct. Unknown
locations cannot infer or grant file access. Every service call requires a current
host-derived local-user principal; runtime/plugin/paired callers are excluded.

## Helper review and validation

The exact reviewed helper freeze is:

| File | SHA-256 |
| --- | --- |
| output-fs.ts | d5f7d5770ebcd99b046915db4d0688ef0abc9ab5d26371d0b76cbc5df9ca04de |
| computer-use/browser/fd-fs.ts | 525b55363e5d64547245c24e22b549108d0986fd0d13ad081dded04aa770d4a3 |
| output-fs.test.ts | fc831816b0977e64b974fa3e5b03fb8329422a48f064a48ba6ba626b1d811e84 |

Reviewer45 accepted the narrow helper conditionally on preventing i32 descriptor
wrapping; Root verified the correction before disposable invocation. It reuses the
existing three-fixed-argument Darwin arm64 openat ABI with only O_RDONLY,
O_NOFOLLOW, O_NONBLOCK and O_CLOEXEC. Descriptor bounds are0..0x7fffffff. There are no
mode flags/new ABI, path-based read fallback or changed reviewed instruction/sync
leaves. The only existing fd-fs delta exports its already-bound errno reader,
captured before the syscall; the output helper exposes closed Cowork errors only.

Actual disposable owned file/SQLite/Unix-RPC tests use
`WINTER_COWORK_OUTPUT_FS_FIXTURE=1` on Darwin arm64. They cover binary/max-size
chunks, reopen, special/link/traversal refusal, missing/replaced roots, file and
ancestor races, truncation, stale generations, cross-scope inventory, canonical
commit rollback, journaled-leftover adoption, retained conversation data and final authority checks
against a second SQLite connection. The FIFO fixture invokes `/usr/bin/mkfifo`
only under its disposable root; no worker/VM/native admission runs.

Swift DTOs and typed request factories plus source regressions are included.
Swift builds/tests, Mac UI/testhost and phone release/pins remain deferred. No
SessionEvent variants were added; RPCs do not require event fixture regeneration.
Directory file listing, memory CRUD/Dreamer, guest repositories/scratch, explicit
exports, writes/deletes and the production storage-owner caller remain outside
this slice. Full service/authority/range source acceptance remains required.

Final source validation:509 pass,1 skip,0 fail across26 files /3497 assertions;
ordinary memory regressions56 pass /109 assertions across4 further files. The
single skip is an unsupported-host-only existing outbox case on this Darwin host.
Core/protocol/CLI no-emit typechecks and whitespace checks pass. The final small
initializer dependency-negative correction is additionally covered by the focused
output run. No package install, lock/pin edit, Swift execution, live home, Keychain,
GUI, VM, worker, release, push or production activation occurred.

Broad command from worktree root:

```sh
WINTER_COWORK_OUTPUT_FS_FIXTURE=1 WINTER_COWORK_INSTRUCTION_FS_FIXTURE=1 bun test packages/core/test/cowork/outputs.test.ts packages/core/test/cowork/output-fs.test.ts packages/core/test/ipc/cowork-outputs.test.ts packages/core/test/cowork/repository.test.ts packages/core/test/cowork/durable-transaction.test.ts packages/core/test/cowork/instructions.test.ts packages/core/test/ipc/cowork-instructions.test.ts packages/core/test/cowork/schedules.test.ts packages/core/test/ipc/cowork-schedules.test.ts packages/core/test/cowork/workspace-events.test.ts packages/core/test/cowork/folder-grants.test.ts packages/core/test/runtime-state/db.test.ts packages/core/test/runtime-state/db-run-folder.test.ts packages/core/test/migration/migrate-c.test.ts packages/core/test/ipc/cowork-workspace-api.test.ts packages/core/test/ipc/remote-allowlist-parity.test.ts packages/core/test/runtime-sdk/cowork-host-fences.test.ts packages/core/test/sessions/outdir.test.ts packages/protocol/test packages/cli/test/cowork-cli.test.ts
```

Ordinary-memory command:

```sh
bun test packages/core/test/agent/memory-dir.test.ts packages/core/test/agent/memory-dir-assistant.test.ts packages/core/test/agent/context-memory-dir.test.ts packages/core/test/agent/memory-file-ops.test.ts
```

## Device-anchor correction after the original source freeze

The original `3a866384` compared the file device against its last nested directory
and checked nested-directory owner only. Injected metadata D1 canonical root →D2
nested directory/file therefore passed. The successor captures the canonical
output-root device immediately after its recorded tree walk, requires every nested
directory to match that same anchor and compares the final file against it.

The service regression spies on fstat metadata for exact actual nested/file inodes,
substituting D1+1 for both nested/file or for the file only. It performs no mount,
cross-filesystem operation, privileged action, new helper ABI or production fault
port. The regression fails against the unchanged original3a production file and
passes against the correction; the restored real-file stat/read positive also
passes. Focused output/helper/RPC/protocol suite:22 pass,0 fail,256 assertions.
Core no-emit typecheck passes. Original helper/fullsync/durable hashes remain exact.
Initialization/orphan behavior was unchanged at this point; the intent journal above
supersedes the original conservative-orphan behavior (review finding O-W1).

## Initialization intent journal correction (review finding O-W1)

The original initializer created directories before the owner commit, so any
non-crash failure in that window left unrecorded directories that every later
initialization (same conversation or any other in the workspace) refused with
`file_unavailable`. The two source tests asserted that permanent refusal. They now
assert the opposite: after the injected fault clears, a retry succeeds (the
before-owner-commit fault and the owner-insert trigger abort), also from a restarted
owner instance, and a second conversation in the same workspace initializes after a
failed first attempt. New regressions cover a crash between the intent commit and
the first mkdir, a crash after a partial walk, an unrecorded directory with no intent
(still refused and not blessed by a retry), and, with an intent, a 0755 directory, a
symlink, a regular file and a different-device entry (all refused), intents removed
after success, and the journal transaction rechecking the committed-session gate.
The cross-device case substitutes the fstat device for the exact inode, as the
existing device-anchor regression does; it performs no mount. A foreign-owner case is
not testable without a second user and relies on the unchanged uid check.

Hardening: the journal only ever contains paths that were absent when a read-only
pre-walk looked, so a hard crash can no longer leave an intent at a path where a
foreign directory already stood (regressions with the cleanup blocked by a SQLite
trigger assert zero intent rows, including a foreign directory below a journaled
ancestor, and a racer directory that appears after the pre-walk is refused and its
fresh intent forgotten).

Schema15 is still unreleased, so the journal table is part of migration 15 (head of
the reverse-dependency table list). `output-fs.ts` and `fd-fs.ts` are byte-identical
to the freeze above; no ABI, protocol, read-path or RPC change.
