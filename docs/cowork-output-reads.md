# Local reads of canonical workspace outputs

Source slice on `cowork/workspace-output-reads`, based on accepted Core
`37b68e0aa7ab1cee98c54bfd649253892e52aa81`. This does not enable Cowork execution,
provision a production workspace, launch a worker, change availability or SDK pins,
or implement a file browser/export UI. Native VM/egress and GUI/testhost holds remain.

## Canonical ownership and initialization

Schema15 adds `cowork_output_directories` (recorded HomeIdentity and actual directory
identity) and `cowork_output_locations` (opaque location, home/workspace/conversation,
exact owned relative root and immutable location revision1). The only layout is
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
only when an independent canonical instruction/volume identity matches it. Unknown
preexisting workspace/output/session directories are refused. Missing identity,
replaced roots or crash-created unrecorded directories require recovery; the reader
never enrolls/recreates them. Commit failure leaves conservative orphan storage,
not authority. Separate conversation deletion retains its tombstone and outputs;
workspace deletion/deleting state denies reads. Archived workspace content remains
available to the local user.

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
commit rollback/orphans, retained conversation data and final authority checks
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
