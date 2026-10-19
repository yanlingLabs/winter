# N2 extensions: host-backed shares, cold resume, guest-side messaging (design, no code)

Status: DESIGN ONLY, 2026-10-18 (written 2026-10-19; review fold and owner decisions 2026-10-19, section 9). Nothing in this document is built, and no code changes with it. `session.create {mode: "cowork"}` still answers `unsupported_topology`, and nothing here changes that. No VM, Hypervisor call, libkrun run, worker, launcher or `sandbox_init` was started to write it. The provider path (mux class 3, the provider bridge) is out of scope and was not designed or analysed; section 10 says where a piece touches it and stops there.

Sources, read at these revisions:

| Abbreviation | Revision |
| --- | --- |
| OI | `cowork/output-integration` at `f55ea4bd` (this branch's base) |
| SDK | `yanlingLabs/winter-agent-sdk` main at `5183d3a9` (`packages/runtime/src/guest/`, `packages/runtime/src/engine.ts`, `packages/runtime/src/messaging/`, `packages/sdk/src/`). First written against `68e57c64`; every SDK line number below was re-checked at `5183d3a9` |
| LK | upstream libkrun v1.19.6, commit `227b2de6ed323fe180e02f871c5f325a90c13cc2`, the pin in `apple/Cowork/WinterCoworkLibkrun/upstream-pin.json`. I read an extracted copy whose git tree hash I recomputed and found equal to the pinned `16c2ac4cdd03e394e813b244e4be3b6325215f0b` |
| DOOR | `docs/research/2026-10-18-cowork-session-door-design.md` (PR #79, merged; read on `cowork/output-integration` at `23d1925e`) |
| #83 | `cowork/peer-inbox-wiring` at `543b208c` (draft): `drainCoworkInbox` (`drainOnce`, `session-messaging.ts` about lines 460-512) |
| #84 | `cowork/approvals-projection` at `cc995f27` (draft): the Cowork approval route |
| #91 | `cowork/file-channel-port` at `dc6d4565` (draft): the guest file channel's host transport port, streams 4 and 5 (section 4b) |
| L | `cowork/n2-launcher-receipt-mac` (PR #85, stacked on #57): the Swift launcher |

The N2 contract is `docs/cowork-native-worker.md` plus `packages/core/src/cowork/native/protocol.ts` and its vectors. Every wire change below is a proposed change to that contract, to be made by its owner (section 8).

## 0. Summary

**Owner decisions, 2026-10-19 (section 9 has the full table).** D10 is lifted: shares (the Winter-owned server, as reviewed) and cold resume are built now, and G7 and G8 join the end-of-arc live gate batch. D7: the libkrun patches stay in the winter repo's patch queue (`apple/Cowork/WinterCoworkLibkrun`). M6: dangerous guest writes into read-write folders are blocked, every guest-created file there is quarantine-tagged, and the UI says when a folder is guest-writable (2.3 R15-R17, 2.7 T17-T20). The review of PR #92 (ACCEPT with conditions, no HIGH) is folded in throughout; nothing it raised is deferred.

1. **libkrun's virtio-fs is turned off by construction in the production profile.** Patch 0018 lists the virtio-fs device (`r.fs`) as a refused clause. Every `krun_add_virtiofs*` and `krun_set_root` call "flips" the context out of the profile. Patch 0019 says the stock device set "can never start". Turning shares on is therefore a patch-queue change (0024 onward) plus a G4 re-run, not a setting.
2. **Upstream virtio-fs on macOS cannot be confined as written, and must not be re-enabled as is.**
   - The upstream README says virtio-fs gives "**no** protection against the guest attempting to access other directories in the same filesystem, or even other filesystems in the host".
   - The macOS passthrough builds `/.vol/<dev>/<ino>/<name>` strings from guest-supplied names (`name_to_path`). The FUSE server checks only for an interior NUL (`bytes_to_cstr`), so a `..` or `/` in a name walks out of the share.
   - `open_inode` strips `O_NOFOLLOW`.
3. **Shares design (piece 1).**
   - **The server.** A Winter-owned "confined passthrough" replaces it. It works relative to descriptors (`openat` with `O_NOFOLLOW_ANY` and `O_RESOLVE_BENEATH`, both in the macOS 26 SDK), never builds a `/.vol` path, and validates every name.
   - **Options.** A closed FUSE opcode allowlist (R0), no DAX, no guest xattrs, `LinuxSimplified` ownership, a host mode mask, no special files, and `O_UNIQUE`/`AT_UNIQUE` (no hard-link aliases) on the three Winter shares.
   - **Devices.** One device per share. Read-only is enforced in three layers: the server, the open flags and the sandbox.
   - **Read-write folders (owner, M6).** Writes under `.git/hooks/**` and of risky `.git/config` keys are refused; every guest-created file gets `com.apple.quarantine`, set by the server only; the UI marks guest-writable folders.
4. **How a share reaches the worker.**
   - The daemon resolves the folder grant and opens each share root as a directory descriptor.
   - The launcher receives those descriptors on a new L1 line and spawns the worker with one sandbox parameter per share.
   - The worker installs its sandbox first and receives the descriptors afterwards. The share paths therefore never come from guest input.
5. **Shares are fixed for each incarnation, because libkrun has no hotplug.** Adding a source is a pending restart. Revoking one is immediate (an L1 `share_revoke` line; the worker answers `share_revoked{tag}` only after the device's own thread has closed every descriptor, and a missing answer within 2 s is a fail-closed stop) and is completed by a restart. Both are behaviours the spec already allows.
6. **Shares make a folder source honestly `ready` for the first time.** The guest mounts it and acknowledges, and the host calls `acknowledgeSource`. That resolves DOOR's blocker A (G1) for folder sources, and DOOR G11: guest outputs land in the host `shared/outputs` folder.
7. **Cold resume (piece 2) is blocked at five exact points today**, all in the SDK:
   - `resume` is not in the host-query profile's `configKeys`;
   - the bootstrap record requires `freshOnly: true`;
   - the supervisor refuses `runtime_fresh_store_required` and `runtime_fresh_only`;
   - `previousBootTermination` is hard-wired to `() => null`, so every lease from an earlier guest boot reads as alive.

   `store-bootstrap.ts` already accepts `resume === sessionId`.
8. **Cold resume design.**
   - The conversation set gains `continuation: fresh | resume` and `endedGuestBoots`.
   - `endedGuestBoots` is a host-attested list: the guest boot ids the host recorded at `hello`, whose disks were later released by real D1 proof. The owner library mints previous-boot evidence only for those ids. A guest-written marker is never evidence.
9. **Resume is always a new incarnation.** It starts only from `stopped` with ownership released. Every revision is re-read, so authority can never grow back.
   - A stable `runtimeUid`/`toolUid` per conversation is recorded on the host, so files and the store keep their owners.
   - A store whose data volume was lost or reformatted is refused visibly. It is never started fresh.
10. **The supervisor's `timeoutMs` (at most 600 s) is a wall-clock cap on each runtime run.** Without a fix, ten minutes is the effective conversation lifetime, even inside one incarnation. Accepted fix (O7): the 600 s cap goes for host-query runtimes only together with three bounds that compose: a host per-turn bound (2 h of turn time, paused while an approval or question card is open), an idle cold stop after DOOR's two minutes of quiescence (active once CR4 ships), and a guest backstop of 24 h per runtime run (`timeoutMs` up to 86,400,000 for host-query profiles; the fresh fixture keeps 600,000).
11. **Resume also needs the guidance load on resume:** the guided profile plus the instructions share. It is therefore ordered after shares slice SH6 and Track A, or the owner accepts a resume without guidance (O8).
12. **Guest messaging (piece 3) needs no mux change.**
    - `host_message_send`, `host_message_list` and `host_session_stop` are runtime control requests. They already travel up OUT on runtime class 2, and their answers come back down IN.
    - The SDK change has four parts: the profile admits `hostMessaging` and the extra tools; `allowedSubtypes` grows; the confined-guest registry gate grows; and `checkLinuxHostQueryFrame` must accept host-message answers.
    - Today nothing waits: the registry refuses the tool (`guest_tool_unsupported`), and the bridge refuses the subtype (`unsupported_subtype`). But the checker DROPS every non-permission answer (`engine.ts:6592` through `checkLinuxSessionFrame`, `linux-session-admission.ts:153-156`), so once the subtype is allowed, every answer would be dropped and every call would fail only at its request timeout: 180 s for a send, 15 s for a list (`messaging/host-port.ts:20,22`), or earlier on abort. GM1 must therefore change the subtypes and the checker together.
    - Host-to-runtime `host_input_*` frames are gated on a runtime capability (`held-input-v1`). An older runtime's checker refuses an unknown subtype, and a refusal is a `hardStop` (`engine.ts:6596`), so a newer host never sends one unasked. The runtime always emits `system/held_inputs`, even when empty.
13. **AskUserQuestion needs no new transport.** It already rides the `permission` subtype with `updatedInput.answers`, which the frame checker admits. Only the tool allowlists and the host bridge are missing, which contradicts part of DOOR's G4.
14. **Task tools.**
    - TaskCreate, TaskGet, TaskList and TaskUpdate run in-process, with no transport. Their graph is in memory, so it is lost on cold resume (parity with Code).
    - TaskOutput needs guest background Bash, which refuses `background_unsupported` today.
    - TaskStop has nothing of its own to stop in the guest.

    Recommendation: offer the first four and withhold the last two (O10).
15. **The coordinator's requirement, end to end.** Delivery INTO a guest recipient becomes two-phase:
    1. offer, then **hold** under a per-hold token: the guest records the input durably, outside the model's queue;
    2. `inbox.ack`, which records that token atomically with the delivery;
    3. then **commit**, or **discard** on `authority_denied`. On any other ack throw the host reads the ledger's `verdict()` first and commits or discards from it, never blindly.

    "Committed" means durably in the transcript: the runtime appends the attributed message, tagged with its `inputId`, before it answers, and on restart dedupes its held-input journal against the transcript by `inputId`. The runtime reports undecided holds at start (always, even an empty list) and the host resolves each through the ledger. Three rules keep it exact:
    - the driver publishes its epoch only after that reconciliation finishes;
    - every commit and discard names its hold token, so a verdict can only act on the hold it is about, whatever order frames arrive in;
    - each drain re-commits delivered-but-unconfirmed receipts before offering anything new, and an `unknown_input` answer is a terminal, surfaced disposition, so one lost record never blocks a recipient.

    With this, a revocation between push and ack delivers nothing, a re-grant delivers exactly once, and a crash or a lost answer anywhere in the sequence neither loses nor duplicates a message (section 4.5 has every window).
16. **Biggest functional gap: N2 serves one host-query conversation per guest, and same-Project peers share one guest.** A guest sender's peer can therefore never run while the sender runs. Its messages stay owed until the sender's incarnation ends. Guest-to-guest messaging has real value only after the one-conversation limit is lifted (O12, a separate contract slice).
17. **PR #84 denies SendMessage, ListAgents and Task\* as unmapped tools.** They need a class row: read-only for ListAgents and Task\*, coordination for SendMessage (allowed, except under `plan`, where it asks). That is listed as NEEDS FROM APPROVALS.
18. **Slices.**

    | Piece | Slices | Size |
    | --- | --- | --- |
    | Shares | SH1–SH6 | XL in total (SH2, the libkrun server, is the long pole) |
    | Cold resume | CR1–CR6 | L |
    | Messaging | GM1–GM4 | L |
    | Guest file channel (section 4b, coordinator addition) | FC1–FC5 | M–L |

    The contract slices and the agent-SDK slices can start now in parallel.

    **The file channel and the shares divide the work by location, one reader per location.**
    - Shares: folders, guidance, memory and outputs, read on the host, even while the VM is stopped.
    - The channel (#91's streams 4 and 5): repos and scratch on `data.ext4`, while the VM runs.

    The guest file service refuses any root that is not on the data volume (an `fstatfs` ext4 check plus the data volume's device) and walks below it with `RESOLVE_NO_XDEV`, so it can never answer for a share.

    **Two corrections to #91's note.**
    - FILE_IN must NOT share the runtime IN counter. A busy file service would otherwise "prove" a stalled runtime is reading, and the guest's 4 MiB runtime ring could overflow.
    - The worker and launcher change no source, but their vendored vector copies must be re-pinned: `runtime-stream-four` becomes `bad_direction`, and the counts and hashes change.
19. **New gates.**
    - Amendments: G0-S, G1-S/R, G2-S/M and G4-S.
    - Three new live gates: G7 (share confinement in a VM), G8 (cold resume) and G9 (guest messaging). G7 and G8 join the end-of-arc live gate batch (owner, 2026-10-19).
    - Every one needs a review of the exact commit and the owner's approval. None is run by an agent.

    **The guest file browser has no capability (owner, O14).** A per-workspace browse uid in the workspace group reads through group permissions on setgid roots (`umask(0002)`, as the tool compartment already sets); files a tool made 0600 stay unreadable to it, which is accepted. `open_by_handle_at` and `name_to_handle_at` stay denied in browse mode, held by a mutation test.
20. **Provider path.** A model-driven `SendMessage` or subagent continuation in G8 and G9 needs one of two things:
    - a stand-in that can emit tool calls (the merged stub is text-only), never selectable in production (O13), or
    - the provider bridge, which is HELD.

    I stopped there (section 10).

## 1. What the source says today

| Fact | Where |
| --- | --- |
| Production profile refuses any virtio-fs device; `krun_add_virtiofs`, `2`, `3`, `4` and `krun_set_root` flip the context | `apple/Cowork/WinterCoworkLibkrun/patches/0018-proposed-production-gate-matrix-tests.patch` (clause "virtiofs device (r.fs)", setter table); `0019` ("the stock libkrun device set (implicit vsock, virtiofs, ...) can never start") |
| Admitted inventory: two virtio-blk, one generic console port, rng, balloon, PL011; "no virtiofs" | `docs/cowork-native-worker.md` section 8; `WinterCoworkLibkrun/README.md` |
| Every guest-memory device registers with the reclaim `Access` (`MAX_DEVICES` 3: data, environment, runtime) and pins its ranges; 48 pins / 8 MiB, overflow is fatal (exit 77) | patches 0004 (`reclaim_access.rs`), 0012 (`workspace_disks::MAX_DEVICES`) |
| virtio-fs: "libkrun **does not** provide any protection against the guest attempting to access other directories ... or even other filesystems in the host" | LK `README.md`, "Security model / virtio-fs" |
| macOS passthrough addresses inodes as `/.vol/<dev>/<ino>` and children as `/.vol/<dev>/<ino>/<name>` | LK `src/devices/src/virtio/fs/macos/passthrough.rs` `inode_to_handle`, `name_to_path` |
| `lookup` formats the guest name without checking it; the server's `bytes_to_cstr` checks only for an interior NUL | `passthrough.rs` `lookup`; `src/devices/src/virtio/fs/server.rs` `bytes_to_cstr` |
| `open_inode` opens the volfs path with `O_NOFOLLOW` removed | `passthrough.rs` `open_inode` |
| `LinuxComplete` (the default) stores guest uid/gid/mode in the xattr `user.containers.override_stat` on the host file; `init` sets the process umask to 0 | `passthrough.rs` (`XATTR_KEY`, `PermissionSemantics`, `init`) |
| DAX: `setupmapping` `mmap`s the host file `MAP_SHARED` (writable if the guest asks) and maps it into guest physical memory through HVF | `passthrough.rs` `setupmapping` |
| One worker thread per fs device, two queues of 1024, request bound 1 MiB | LK `virtio/fs/worker.rs`, `virtio/fs/mod.rs`, `server.rs` `MAX_BUFFER_SIZE` |
| Read-only wrapper refuses mutating ops with `EROFS` | LK `virtio/fs/read_only.rs` |
| Guest kernel has `CONFIG_FUSE_FS`, `CONFIG_VIRTIO_FS`, `CONFIG_FUSE_DAX`, `CONFIG_FS_DAX` | `scripts/cowork-guest-artifact/kernel/base-apple-6.18.35.config` |
| Worker sandbox: deny default, no `file-write*` at all, `file-read*` only under `/System`, `/usr/lib` and the `GUESTDIR` parameter; installed before anything is read | `apple/Cowork/WinterCoworkHVFWorker/Sources/WorkerNative/Sandbox.c` |
| Worker argv is exactly `[path]`; descriptors 3 (L2) and 4 (L3) | `docs/cowork-native-worker.md` section 5 |
| `SCM_RIGHTS` is allowed on the L1 `volumes` line and nowhere else | `docs/cowork-native-worker.md` section 4.3 |
| PID 1 creates `/workspace/.winter/{conversations,scratch,memory}`, `outputs`, `folders`, `repos` on `data.ext4` and an empty `/run/winter/shared-instructions`; the environment disk is attached but not mounted | `docs/research/2026-10-17-cowork-n2-guest-boot.md` section 2; `docs/cowork-native-worker.md` section 6.1 |
| The host-query profile's `configKeys` has no `resume` | SDK `guest/linux-host-query-profile.ts:9` |
| The bootstrap record requires `freshOnly: true` | SDK `guest/linux-session-admission.ts:32,50` |
| The admission's owner returns `previousBootTermination: () => null` | SDK `guest/linux-session-admission.ts:124` |
| A lease from another boot counts as alive unless `confirmPreviousBootTerminated` returns true | SDK `packages/sdk/src/store/leases.ts` `isLeaseHolderAlive`; `guest/store-bootstrap.ts:169-176` |
| The store bootstrap already accepts `config.resume === scope.sessionId` | SDK `guest/store-bootstrap.ts:100,142` |
| Supervisor refuses a non-empty store or run home (`runtime_fresh_store_required`: `os.listdir` of either is non-empty) and a second launch (`runtime_fresh_only`) | SDK `guest/linux-supervisor.py:1152,1211` |
| Runtime run killed after `timeoutMs` (default and maximum 600000, validated `1..600000`) of wall-clock time, mid-turn or not | SDK `guest/linux-supervisor.py:1141-1142` (validation), `:1257` (the kill in `_run_runtime`) |
| Host-query runtime mode is `default` or `plan` only; bypass is never produced; `plan` forces read-only roots | SDK `guest/linux-supervisor.py:322-330` (`host_query_config`) |
| Engine allows only `permission` (host-query) or `permission` + `runtime_context` (guided) outbound | SDK `runtime/src/engine.ts:3037-3040` |
| Host messaging rides the run's control bridge (`host_message_send` / `host_message_list`) when `config.hostMessaging === true` | SDK `engine.ts:3847-3853`; `packages/sdk/src/protocol/config.ts`; `packages/sdk/src/query.ts` |
| A host-message request fails at its own timeout: 180 s for a send, 15 s for a list | SDK `runtime/src/messaging/host-port.ts:20,22` |
| Confined-guest executor refuses every tool but Read, Write, Edit, Bash (`guest_tool_unsupported`) | SDK `runtime/src/tools/registry.ts:1851` |
| `checkLinuxHostQueryFrame` accepts `user`, `end_input`/`interrupt`, and `control_response` only for ids `ownsPermission` claims; any other answer is DROPPED; any other control subtype is REFUSED | SDK `guest/linux-host-query-profile.ts:36-61` (the drop at `:48`) |
| The engine's one call site: a `drop` is skipped, a refusal ends the run (`hardStop`) | SDK `engine.ts:6592` (via `checkLinuxSessionFrame`, `guest/linux-session-admission.ts:153-156`), `:6596` |
| The tool compartment joins the workspace group as its one supplementary group, clears every capability, and sets `umask(0002)`; the shared seccomp filter denies `open_by_handle_at` and `name_to_handle_at` | SDK `guest/linux-tool-compartment.c:258-264`; `guest/linux-compartment.h:78` |
| AskUserQuestion is answered through `canUseTool` with `updatedInput.answers` (the `permission` subtype) | SDK `runtime/src/tools/impl/ask-user-question.ts` header; `permissions/evaluator.ts` |
| TaskCreate/Get/List/Update use an in-memory, session-keyed graph | SDK `runtime/src/tools/task-graph-store.ts` header |
| Guest Bash refuses `run_in_background` (`background_unsupported`) | SDK `guest/process-tools.ts` |
| `drainCoworkInbox`: offer, then `deliverInto` (steer or send into the recipient's turn), then `inbox.ack` | #83 `packages/core/src/agent/session-messaging.ts` `drainOnce` |
| The ledger: "An ack that finds authority revoked answers `authority_denied`, parks the record and delivers nothing. That is the signal for the recipient runtime to discard the input it was holding: the ack is the commit point." | `docs/research/2026-10-16-cowork-peer-inbox.md`, state machine notes |
| #84 routes AskUserQuestion and ExitPlanMode to their own bridges and denies unmapped tools (SendMessage, Task\*) | #84 body, "REVIEW NEEDED 1" |
| Both host-query root checks refuse every `/workspace/.winter` root, while the native contract allows `/workspace/.winter/memory` | SDK `guest/linux-host-query-profile.ts` `assertLinuxHostQueryRoots`; `guest/linux-supervisor.py:330` (`host_query_roots`); `native/protocol.ts` `allowedView` |
| Runtime, tool and group ids are distinct across the conversation set | `native/protocol.ts:489-490`; SDK `linux-supervisor.py:852,861,1171` |
| The host already fixes each data volume's filesystem UUID in the plan (`expectedFilesystemUUID`); the guest refuses a mismatch (`filesystem_mismatch`) | `apple/Cowork/WinterCoworkGuest/bootstrap/guest_bootstrap.py:565,621,894` |

## 2. Piece 1: host-backed shares

### 2.1 What is shared

| Share | Host root (canonical, opened by the daemon) | Guest mount | Mode | Device tag |
| --- | --- | --- | --- | --- |
| Folder source | the user's granted folder (`cowork_folder_grants`: bookmark, `root_device:root_inode`, access) | `/workspace/folders/<grantId>` | per grant: `ro` or `rw` | `src-<n>` (n 0 to 8) |
| Shared guidance | `<home>/cowork/workspaces/<id>/shared/instructions/` | `/run/winter/shared-instructions`, with the supervisor alias `/workspace/.winter/WINTER.md` | `ro` | `winter-guidance` |
| Project memory | `<home>/cowork/workspaces/<id>/shared/memory/` | `/workspace/.winter/memory` | `rw` | `winter-memory` |
| Outputs | `<home>/cowork/workspaces/<id>/shared/outputs/` | `/workspace/outputs` (each conversation's tool view sees only `/workspace/outputs/<sid>`) | `rw` | `winter-outputs` |

At most 12 shares per incarnation: nine folder sources plus three Winter shares. That fits one `recvmsg` (the launcher's `LC_MAX_RIGHTS` is 17) and keeps the pin budget sizeable (2.4).

**One device per share, never a multiplexed root.** All three Winter shares sit on one APFS volume. Suppose one device served several roots. A guest `link` or `rename` from the read-only `instructions` root into the writable `memory` root would then make `WINTER.md` writable, bypassing the approval rule for shared guidance.

With one device per share, two things stop that:
- every device has its own inode table, so a node id from another share is unknown to it;
- the guest kernel answers `EXDEV` across mounts.

The confined server also refuses cross-root `link` and `rename` outright (R5), in case a later change ever multiplexes roots.

### 2.2 Why virtio-fs, and why not the stock server

| Option | Verdict |
| --- | --- |
| Stock libkrun virtio-fs (`krun_add_virtiofs*`) | **No.** Unconfined by its own README; the `..` and `/` escape and the symlink-following open (section 1). It is also refused by the production gate, correctly. |
| A Winter-owned confined passthrough on the libkrun virtio-fs transport (this design) | **Recommended.** It reuses the virtio-fs device model, the queues and the guest's in-kernel FUSE client, and replaces only the host filesystem server. It keeps the "live direct files" property the spec requires ("Shares are direct files, not periodically synchronized replicas"). |
| A file service over the runtime streams (FUSE in the guest, served by the daemon) | **No.** It puts a guest-facing filesystem parser in `winter-core`, which the spec forbids ("No raw guest packet parser belongs in the credential daemon"). Every operation would also cross worker, launcher and daemon, which is too slow for repositories and builds. |
| Copy-in/copy-out on boot and stop | **No.** The spec rules out synchronization loops. |
| virtio-9p, vsock or network filesystems | **No.** libkrun has no 9p, and vsock or a NIC is excluded. |

### 2.3 The confined passthrough: requirements

A new server under `src/devices/src/virtio/fs/macos/` (patches 0024 onward). The stock `PassthroughFs` stays unreachable from the production profile. Each requirement below is one reviewable clause with its own VM-free test (2.9).

- **R0. Closed opcode allowlist.**
  - The server dispatches only a closed list of FUSE opcodes: `INIT`, `DESTROY`, `LOOKUP`, `FORGET`, `BATCH_FORGET`, `GETATTR`, `SETATTR` (mode, size, times only), `READLINK`, `SYMLINK`, `MKDIR`, `UNLINK`, `RMDIR`, `RENAME`, `RENAME2` (`RENAME_NOREPLACE` and `RENAME_EXCHANGE` only), `LINK`, `OPEN`, `READ`, `WRITE`, `STATFS`, `RELEASE`, `FSYNC`, `FLUSH`, `OPENDIR`, `READDIR`, `READDIRPLUS`, `RELEASEDIR`, `FSYNCDIR`, `ACCESS`, `CREATE`, `INTERRUPT`, `LSEEK`, `FALLOCATE` (mode 0 only).
  - Every other opcode, present or future (the xattr family, `MKNOD` for anything but the R9 refusal, `IOCTL`, `POLL`, `GETLK`/`SETLK`/`SETLKW`, `BMAP`, `NOTIFY_REPLY`, `SETUPMAPPING`, `REMOVEMAPPING`, `COPY_FILE_RANGE`, `TMPFILE`, `SYNCFS`), answers `ENOSYS` by default. The default is the `match` fallthrough, so a new upstream opcode is refused until a reviewed patch adds it.
  - `INIT` negotiates no flag the server does not implement: no `DAX`, no `WRITEBACK_CACHE`, no `POSIX_ACL`, no `SUBMOUNTS`, no `HANDLE_KILLPRIV_V2`, and `max_pages` exactly 256 (R14).
- **R1. Names.**
  - On every name-taking operation, refuse with `EINVAL`: an empty name, `.`, `..`, any `/`, NUL, more than 255 bytes, or invalid UTF-8.
  - The operations are `lookup`, `create`, `mkdir`, `mknod`, `symlink` (the new name), `link` (the new name), `rename` (both names), `unlink` and `rmdir`.
- **R2. Descriptor-relative only.**
  - Each directory inode holds an `O_RDONLY | O_DIRECTORY | O_NOFOLLOW` descriptor; the root's is the descriptor the worker received.
  - Every host operation is `*at(dirfd, name, ...)`. Opens use `O_NOFOLLOW_ANY | O_RESOLVE_BENEATH` (`sys/fcntl.h:158,128`). Other `*at` calls take `AT_SYMLINK_NOFOLLOW_ANY | AT_RESOLVE_BENEATH` (`:184,185`) wherever the call accepts flags. Renames use `renameatx_np(..., RENAME_NOFOLLOW_ANY | RENAME_RESOLVE_BENEATH [| RENAME_EXCL | RENAME_SWAP])` (`sys/stdio.h:39-40`), never `renameat`.
  - Once an inode is open, operations are descriptor-based: `fstat`, `fchmod`, `futimens`, `ftruncate`, `fsync`/`fcntl(F_FULLFSYNC)` on the held descriptor, never a path call.
  - A reopen never carries `O_TRUNC` or `O_CREAT`. A truncating open is an open, the (dev, ino) check, then `ftruncate` on that descriptor. A create is `O_CREAT | O_EXCL` on the parent descriptor, so it can never land on an existing node.
  - Every reopen carries `O_NONBLOCK` (cleared by `fcntl` after the `fstat` type check on a regular file), so a node swapped for a FIFO between lookup and open cannot block the device thread.
  - The server never formats a `/.vol` path, never opens an absolute path and never calls `realpath`.
  - A non-directory inode is reopened through its parent's descriptor and its last name. It is then confirmed by `fstat` (dev, ino) before any use; a mismatch is `ESTALE`.
  - Directory descriptors are bounded: an LRU of 1,024 per device. An evicted directory is re-resolved from its parent chain and confirmed by (dev, ino), never through volfs.
- **R3. Symlinks are data.**
  - `readlink` returns the text and `symlink` creates one, so repositories keep working.
  - The server never follows one; the guest kernel resolves them inside the guest's own namespace.
  - A guest-planted link in a user folder is a host-side hazard only for host readers that follow links (2.7, T3).
- **R4. Mount points.**
  - A lookup that lands on a different `st_dev` than the share root is refused with `EXDEV`. A disk image mounted inside a granted folder therefore never becomes reachable.
  - `ATTR_SUBMOUNT` is never announced.
- **R5. Links and renames.**
  - Both inodes must belong to this device's table. Cross-device is impossible by construction.
  - `link` of a directory is refused.
  - **Winter shares (guidance, memory, outputs; owner O4):** every open adds `O_UNIQUE` (`sys/fcntl.h:129`) and every flag-taking `*at` adds `AT_UNIQUE` (`:187`), so a node with more than one link is never served, and `LINK` is refused (`EPERM`). Winter's own storage never needs hard links, so this costs nothing.
  - **Folder sources:** hard links stay allowed, because repositories, package stores and build tools make them. The trade-off, documented: a user's pre-existing hard link from inside a share to a file outside it cannot be told apart, and a guest write through it reaches that outside file (T4). A guest cannot create such a link itself (both names must be in this device's table).
- **R6. No DAX.**
  - The device is built with no shared-memory region.
  - `setupmapping` and `removemapping` answer `ENOSYS` unconditionally.
  - The production gate refuses `shm_size` on a Cowork share.
  - Defence in depth: a kernel fragment `CONFIG_FUSE_DAX=n` at the next kernel pin.
- **R7. Ownership and modes.**
  - `PermissionSemantics::LinuxSimplified` and `xattr = false`, so the guest can never read or write a host xattr (R0 refuses the whole xattr family).
  - The one carve-out is R16: the server itself, never the guest, sets exactly `com.apple.quarantine` by `fsetxattr` on a descriptor it has just created. Whether Seatbelt can scope `file-write-xattr` to that one name is a G0-S item; if it cannot, the worker gets `file-write-xattr` on read-write folder shares only and R0 keeps the guest out of it.
  - The process umask is never changed; the stock `init` sets it to 0.
  - Modes created or changed on the host are masked: `& ~0o022`, and never `S_ISUID`, `S_ISGID` or `S_ISVTX`.
  - Under Simplified the guest sees every file as owned by the calling uid. That matches the spec: "guest UID/GID/modes are not an access boundary on host-backed virtiofs".
- **R8. Read-only shares.** Read-only is enforced in three layers:
  - the read-only wrapper refuses every mutating op with `EROFS`;
  - opens are `O_RDONLY`;
  - the sandbox grants `file-read*` only (2.4).
- **R9. No special files.**
  - `mknod` is refused for FIFOs, sockets and devices; only regular files can be created, through `create`.
  - An existing FIFO in a user folder is opened `O_NONBLOCK` (every reopen is, R2), so a substituted FIFO cannot hang the worker; `OPEN` of anything but a regular file or directory is `EACCES`.
- **R10. Bounds.**
  - At most 4,096 open handles per device; beyond that the answer is `ENFILE`.
  - Request size stays at 1 MiB.
  - One worker thread per device processes one request at a time.
  - A full handle table refuses; it never evicts a live handle.
- **R11. Revoke switch.**
  - A per-device atomic flag in the server, set by the worker from an L2 `share_revoke` envelope (which the launcher forwards from the new L1 `share_revoke` line, 2.4).
  - The device thread checks the flag at the entry of every request. From the first request after the flag is set, every request on that device answers `EACCES`.
  - **Only the device's own thread closes its descriptors** (root, the directory LRU, every open handle). It does so at its next request boundary, or at once if it is idle (the worker wakes it through its queue event). No other thread ever closes a descriptor the device thread might be using, so there is no close-while-in-use race and no fd-number reuse.
  - Then the device thread tells the worker, and the worker sends an L2 status `share_revoked{tag}`, which the launcher relays as an L1 status of the same name.
  - **What "immediate" means:** no request that starts after the flag is set touches the host. At most the one request already executing on that device (bounded by R10: one request, at most 1 MiB) completes. The daemon reports the cutoff only on `share_revoked{tag}`.
  - **Fail-closed timeout:** if `share_revoked{tag}` does not arrive within 2 s of the line, the daemon stops the workspace (the existing stop and D1 path) and records the revocation as completed by that stop.
  - This is cutoff, not "revocation complete" (2.6).
- **R12. Caching.**
  - `CachePolicy::Auto`, with entry and attribute timeouts of 1 s, because the Mac side edits the same files.
  - Writeback cache off; the stock code itself warns against it without exclusive access.
- **R13. Durability.**
  - A guest `fsync` maps to `F_FULLFSYNC` on the Winter shares (memory, outputs) and to `fsync` on folder sources, the same as Mac apps.
  - The exit path stops and joins every fs worker before the exit hook, so no write completes after the receipt's facts are read.
- **R14. Guest memory and reclaim.**
  - Each fs device registers with the reclaim `Access` and pins its descriptor ranges for each request.
  - It honours `freeze`, in the same way as the guarded block device and the runtime port.
  - `MAX_DEVICES` grows from 3 to 3 + shares.
  - **The pin budget, computed.** A pin in patch 0004 is one request's whole range list (`Access::pin(&[Range])`); the budget counts pins and pinned bytes (`Access::new(max_devices, max_pins, max_pinned_bytes)`). Today the workspace profile's budget is `MAX_PINS = 48` and `MAX_PINNED_BYTES = 8 MiB` across `MAX_DEVICES = 3` (patch 0012, `workspace_disks`), against a structural maximum of 12 pins and 4,289,930 bytes (`WinterCoworkLibkrun/README.md`).
    - The server negotiates `max_pages = 256` in its `INIT` reply (R0), so the guest never builds a READ or WRITE payload above 256 × 4 KiB = 1,048,576 bytes.
    - The fs device refuses (never pins) a descriptor chain longer than `max_pages + 4` descriptors, or with more than 1,048,576 + 8,192 bytes in total (payload plus the FUSE in and out headers).
    - Each fs device has one worker thread and therefore at most one request in flight on the request queue, plus at most one on the high-priority queue (`FORGET` and `INTERRUPT`, at most 4,096 bytes). So each fs device needs at most 2 pins and 1,048,576 + 8,192 + 4,096 = 1,060,864 bytes.
    - For S shares the structural maximum becomes 12 + 2·S pins and 4,289,930 + 1,060,864·S bytes (at S = 12: 36 pins and 17,020,298 bytes). The budget keeps today's headroom and adds each fs device's maximum: `max_pins = 48 + 2·S` and `max_pinned_bytes = 8,388,608 + 1,060,864·S`. At the maximum S = 12 that is **72 pins and 21,118,976 bytes (about 20.1 MiB)**; `MAX_DEVICES` = 3 + S = 15.
    - The budget is set from the actual S at context build, never larger. As today an overflow is fatal (exit 77); with these caps it is structurally impossible, which a VM-free test pins by driving S devices at their chain maximum at once (SH2). G4-S measures the high-water mark.
- **R15. Host-executed configuration in read-write folders (owner, M6: block).** Enforced in the server, on read-write folder-source devices only (the Winter shares never hold repositories).
  - **Git directories.** The server knows each held directory's name chain from the root (R2 re-resolves through it). A *git directory* is a directory named `.git`, or a directory below one that holds a `HEAD` file and an `objects` or `commondir` entry (submodule gitdirs under `.git/modules/**`, worktree gitdirs under `.git/worktrees/*`).
  - **Git directories cannot be moved or faked.**
    - `RENAME`/`RENAME2` of a git directory (out, in, or an exchange), and `RMDIR` of one, are `EPERM`. Without this a guest could move `.git` aside and build a new one around a config of its choosing.
    - A regular file named `.git` (a *gitfile*: `gitdir: <path>`, what worktrees and submodules use) is content-checked. git writes it in place (`write_file`, not a lock and rename), so the server does not let its bytes reach the host until they are checked:
      - `CREATE` makes it empty on the host (an empty gitfile only makes git fail);
      - `WRITE`s to it are buffered in the server (at most 4 KiB in total; more is `EPERM`);
      - on `FLUSH` or `RELEASE` the buffered content must be exactly one `gitdir: <path>` line. The path, relative to the file's directory or absolute under the share's guest mount path (passed in the ABI, below), must resolve inside the share, with no symlink, to an existing git directory under some `.git/worktrees/` or `.git/modules/`. Only then does the server `pwrite` it through its descriptor. Otherwise the call is `EPERM` and the host file stays empty;
      - a later open for writing, a truncate, a `SYMLINK` or `LINK` named `.git`, a rename onto `.git`, and any entry named `.git` of another type (a symlink, a FIFO) are refused.

      That accepts exactly what `git worktree add` and submodule checkouts write, and a gitfile can never point git at a guest-built bare repository.
  - **Hooks: every mutation refused.**
    - Inside a git directory, an entry named `hooks` of ANY type (directory, symlink, file) cannot be created, linked, renamed in, renamed out or removed (`CREATE`, `MKDIR`, `SYMLINK`, `LINK`, `RENAME`/`RENAME2`, `UNLINK`, `RMDIR` all answer `EPERM`). A symlink named `hooks`, which git would follow, is therefore impossible.
    - Below an existing `hooks` directory, every mutating opcode answers `EPERM`: `CREATE`, `MKDIR`, `SYMLINK`, `LINK`, `UNLINK`, `RMDIR`, `RENAME`/`RENAME2` into, out of or within it, `SETATTR`, `FALLOCATE`, and `OPEN` or `WRITE` for writing.
    - **Consequence for git itself.** `git init`, `git clone` and submodule clones copy the template directory into the new `.git`, including `hooks/*.sample`, and git dies when a template entry cannot be created. So the guest image's system gitconfig sets `init.templateDir` to an empty, root-owned directory (N2 guest lane). With that setting no `hooks` directory is ever made and every clone into a read-write folder works. An SH2 test and a G7 row prove that a clone, a worktree add and a submodule update succeed in a read-write folder.
  - **Config: risky keys refused.**
    - Inside a git directory, the names `config` and `config.worktree` cannot be created by `CREATE`, `SYMLINK` or `LINK`, opened for writing, truncated by `SETATTR`, or renamed away. `UNLINK` is allowed only for `config.worktree`. The ONLY way to change them is git's own `config.lock` and then rename, and the rename source must be a regular file (`S_ISREG`).
    - On a `RENAME` onto one of these names, the server reads the source through its descriptor (at most 1 MiB; larger is `EPERM`) and parses it with a strict git-config parser: sections, subsections, quoting and continuation lines; any parse error is `EPERM`.
    - It refuses the rename with `EPERM` if the new file sets any of the following to a value that the current file does not already carry exactly:
    - owner's list: `core.fsmonitor`, `core.hooksPath`, `core.sshCommand`, `core.editor`, `core.pager`, any `filter.<name>.*`, `diff.<name>.*` and `merge.<name>.*` driver key, `include.path`, `includeIf.<cond>.path`, and any `alias.<name>` whose value starts with `!`;
    - added by the same rule, recommended because each names a program git runs: `core.askPass`, `core.gitProxy`, `core.alternateRefsCommand`, `credential.helper` and `credential.<url>.helper`, `diff.external`, `difftool.<tool>.cmd`, `mergetool.<tool>.cmd`, `sequence.editor`, `pager.<cmd>`, `gpg.program`, `gpg.<format>.program`, `gpg.ssh.defaultKeyCommand`, `gpg.format`, `commit.gpgSign`, `tag.gpgSign`, `push.gpgSign`, `uploadpack.packObjectsHook`, `remote.<name>.uploadpack`, `remote.<name>.receivepack`, `protocol.ext.allow`, `protocol.allow`, and `submodule.<name>.update` whose value starts with `!`.
    - Section and key names are compared case-insensitively, as git does. Removing a risky key is allowed, because that only takes a host program away.
    - This is a denylist, and a denylist leaves a residual: a git key added in a future git version that runs a program would pass until the list is updated (T17). The stricter alternative is an allowlist. The guest would then add or change only the keys git itself writes in ordinary work (`core.*` repository-format keys, `remote.<name>.url`/`fetch`/`pushurl`, `branch.<name>.*`, `submodule.<name>.url`/`path`/`active`, `extensions.*`, `user.name`/`user.email`, `worktree`-related keys). Every other key change would be refused. I recommend the denylist for v1, because the allowlist breaks tools that write their own keys (for example `lfs.*`, `pull.rebase`). The allowlist is an owner choice (section 9, M6 follow-up).
    - The check cannot be raced. The device thread handles one request at a time. The rename is refused if the source has `st_nlink > 1`, or if any open handle on the source inode is writable (the server tracks handles by inode). After the rename the inode's name is protected, so no new write open succeeds.
  - **Not covered (T17b, owner question):** hooks a repository keeps in tracked files through an existing `core.hooksPath` (husky, lefthook), and in-share `include.path` targets. Until the owner answers, the server only reports writes to them (`share_notice`, kind `hooks_path`).
  - **Watched names: allowed, reported.** Writes to `.envrc`, `.vscode/tasks.json`, `.vscode/settings.json`, `*.code-workspace` and `.idea/runConfigurations/**` are allowed (editing them is ordinary work). The server reports the first change per name per incarnation to the worker, which sends a rate-limited L2 status `share_notice{tag, kind}` (one per tag and kind, at most one per second); the daemon shows it on the conversation (T19).
- **R16. Quarantine on guest-created files (owner, M6: tag).** Enforced in the server, on every read-write share (folders, memory, outputs).
  - Every regular file created by `CREATE` gets `com.apple.quarantine` by `fsetxattr` on the new descriptor, before the reply, with a fixed value `0081;<creation time, hex seconds>;Winter Cowork;` (the exact flag word is an SH2 decision checked at G7: Gatekeeper must treat an executable, an app bundle's binary and a script with an exec bit as downloaded).
  - A `SETATTR` that adds any execute bit to a regular file also sets the tag, so a user file the guest rewrote and made executable is caught.
  - A tag failure fails the operation (`EIO`, and the new file is unlinked through its parent descriptor). It is never skipped.
  - Residual, documented: content written in place into a file that was already executable and untagged is not tagged.
- **R17. The UI says when a folder is guest-writable (owner, M6).** Not a server rule: the daemon marks each folder source `rw` in the source list, on the conversation and in the grant picker ("the workspace can change files here"), from the grant's access. The share's `rw` mode in the L1 record comes from the same grant field, so the two cannot differ.

The new ABI follows the S1 pattern: borrowed descriptors and no path opens.

```c
/* flags: bit 0 = read-only, bit 1 = Winter share (R5 O_UNIQUE), bit 2 = folder rules (R15); every other bit zero.
   tag: [a-z0-9-]{1,32}, distinct. root_fd: a directory, borrowed. guest_path: the canonical guest mount path (R15 gitfiles only). */
int32_t krun_cowork_add_share_v1(uint32_t ctx_id, const char *tag, int32_t root_fd, uint32_t flags, const char *guest_path);
```

The production gate admits `r.fs` only when every entry came from this function: confined server, no shared memory, Simplified, no xattr. `krun_add_virtiofs*` and `krun_set_root` keep flipping the context out of the profile, and the gate matrix test (0018) gains the new clauses.

### 2.4 How a share reaches the worker

The worker's sandbox is installed before it reads anything, so the share paths cannot come from the L2 envelope. They must already be fixed when the worker is spawned.

```
daemon (grant authority)                        launcher (signed, unsandboxed)              worker (sandbox first)
resolve bookmark (folder-bookmark.ts)
open root O_DIRECTORY|O_NOFOLLOW_ANY  ──L1 `shares` (N fds, after hello, before begin)──►  fstat + F_GETPATH each fd,
check (dev,ino) = grant identity                                                            compare with the line
                                                                    spawn suspended: argv [path, "--shares-v1", N, mode₀, path₀, ...]
                                                                    ◄── sandbox installed with SHARE_RO_n / SHARE_RW_n
                                                          ──L2 `shares` envelope (N fds)──►  fstat + F_GETPATH = param, S_ISDIR
                                                                                              krun_cowork_add_share_v1 × N
```

- **L1 `shares` (new line type; contract text version 3).**
  - Daemon to launcher. It is sent at most once, after `hello` and before `begin`.
  - Keys `v, t, id, shares`. `shares` holds 1 to 12 records `{tag, kind (folder|guidance|memory|outputs), mode (ro|rw), device, inode, path, guestPath}`, in descriptor order. `guestPath` must equal the mount point the bootstrap `shares` message names for that tag (2.5).
  - `SCM_RIGHTS` with exactly N directory descriptors, on one `sendmsg`, under the same rules as `volumes` (`recvmsg`, wrong count is `bad_rights`, `MSG_CTRUNC` is fatal).
  - The launcher refuses with the new `shares_rejected` code if any of these holds:
    - a descriptor's `fstat` differs from its record, or it is not a directory;
    - `F_GETPATH` differs from `path`;
    - `path` is not canonical (absolute; no `.`, `..` or empty component; at most 1024 bytes; printable);
    - two paths are equal or nested;
    - tags are not distinct.
  - It holds the descriptors until it forwards them.
- **Worker argv (contract change).**
  - With shares: `[path, "--shares-v1", "<N>", ("ro"|"rw", "<path>")×N]`. Without shares: `[path]` as today.
  - The worker parses this strictly before the sandbox, under these rules: a canonical decimal N from 1 to 12, closed tokens, and the same path rules as above. Any deviation exits 2 (usage).
  - This is the one input read before the sandbox. It comes from the signed launcher, which spawned the worker suspended and validated its image, never from the guest or the envelope.
  - The alternative is sandbox extension tokens, which are more Apple SPI (O2).
- **Sandbox profile (a sketch; the exact operation names are a G0-S item).**

  ```
  (allow file-read* (subpath (param "SHARE_0")))                                   ; every share
  (allow file-write-data file-write-create file-write-unlink file-write-mode
         file-write-times (subpath (param "SHARE_0")))                             ; rw shares only
  ; no file-write-setugid, no file-write-flags, no process-*, no network-*
  ; file-write-xattr only on rw shares, and only if it can be limited to com.apple.quarantine (G0-S; R7, R16)
  ```

  - Deny-default stays, so nothing outside the share subpaths opens, `/.vol` included.
  - Explicit denies for the Winter home, the coordination directory and the user's keychains (each a parameter) are optional defence in depth. They must not shadow the Winter shares, which live under the home; their precedence is a G0-S check.
  - Whether Seatbelt matches a firmlinked spelling (`/Users/...` against `/System/Volumes/Data/Users/...`) is unverified. It is a G0-S item, not a design dependency, because the server never uses a path.
- **L2 `shares` envelope (kind 6).**
  - Launcher to worker, after the worker's `sandboxed` status and before `volumes_accepted` matters.
  - Header plus N 308-byte records `{tag[32], u64 device, u64 inode, u32 flags (the ABI's three bits), guest_path[256] (NUL-padded, canonical, under `/workspace/` or `/run/winter/`)}`.
  - Exactly N descriptors, which the worker checks against its argv parameters by `F_GETPATH` and `fstat`.
- **L1 `share_revoke` line (new, daemon to launcher).** Keys `v, t, id, tag`; legal only after `shares` and only for a tag that line carried; no rights. The launcher forwards it at once as the L2 envelope below. A repeat for the same tag is ignored (no second status).
- **L2 `share_revoke` envelope (kind 7).** `{tag[32]}`; it sets R11. A second one for the same tag is ignored.
- **Worker status `share_revoked{tag}` (new L2 status; the launcher relays it as an L1 status of the same name).** Sent once per tag, only after the device's own thread has closed every descriptor of that device (R11). The daemon reports the cutoff on it, and stops the workspace fail-closed if it has not arrived within 2 s of the line.
- **Worker status `share_notice{tag, kind}` (new, R15).** `kind` is one of `envrc`, `vscode_tasks`, `vscode_settings`, `code_workspace`, `idea_run_config`, `hooks_path`; at most one per tag and kind per incarnation.
- **Daemon side.**
  - A new `packages/core/src/cowork/native/shares.ts` prepares the records. It depends on `folder-grants.ts` (identity, access) and `folder-bookmark.ts` (resolution), and opens through the existing `bun:ffi` `openat` pattern (`output-fs.ts`).
  - It refuses four kinds of grant (O5, owner: both directions):
    - **outward:** a grant whose root contains a protected root (the Winter home, the coordination directory, the workspace's image directory, `~/Library/Keychains`), porting `SharePolicy.swift:116` (the share's identity is a protected root or one of its ancestors);
    - **inward:** a read-write grant whose root lies inside the Winter home (`~/.winter`, including `sdk`, `settings`, `plugins`), the coordination directory or `~/Library/Keychains`, porting `SharePolicy.swift:125` (a private root among the share's ancestors). A read-only grant inside the Winter home is refused too, except the three Winter shares, which are host-made records and never user grants;
    - aliases, found by (dev, ino) and by the firmlink-free spelling, porting the ancestry walk of `apple/Cowork/WinterCoworkVM/Sources/WinterCoworkPrimitives/SharePolicy.swift`;
    - a root whose (dev, ino) no longer matches the grant.
  - Both directions are checked at grant time and again at every start, by identity, so a later rename or move cannot carry a grant across the line. SH5 tests port the Swift cases one by one.

### 2.5 The guest side

After `mounted`, and before `conversations`, the host sends a new bootstrap-class message:

`shares {operationId, nonce, shares: [{tag, guestPath, readOnly, kind}]}`

It must echo the plan's operation and nonce, as `conversations` does. PID 1 then does the following, in order:

1. It reads the virtio-fs tag inventory from sysfs. The inventory must equal the declared tags exactly; an extra or missing device is the bootstrap fault `share_inventory`.
2. It mounts each tag with `mount("<tag>", guestPath, "virtiofs", MS_NOSUID|MS_NODEV [|MS_RDONLY] [|MS_NOEXEC], "dax=never")`:
   - `noexec` on guidance, memory and outputs;
   - folder sources keep exec, because builds run there.
3. It checks `/proc/self/mountinfo` for each mount.
4. It creates the `/workspace/.winter/WINTER.md` alias for the guidance share.
5. It answers `shares_mounted`, or the bootstrap fault `share_mount_failed`.

The host waits for `shares_mounted` and only then sends the conversation set. That is the moment a folder source becomes honestly `ready` for this incarnation (`CoworkRepository.acknowledgeSource(epoch, sourceId, revision, "ready")`).

- **Drain.** PID 1 unmounts the virtiofs mounts before the ext4 volumes. `halting` keeps meaning "every filesystem this boot mounted is unmounted".
- **Supervisor roots.**
  - Folder roots keep today's shape (`source` = the mount point).
  - Outputs keep `/workspace/outputs/<sid>`.
  - Memory: both SDK host-query root checks refuse every `/workspace/.winter` root (`assertLinuxHostQueryRoots`, and the supervisor's `host_query_config` at `linux-supervisor.py:330`), although the native contract allows `/workspace/.winter/memory`. The memory share therefore needs that one exact path admitted in both, together (SDK, slice SH6b, spec gap X5).

### 2.6 Lifecycle, revocation and TCC

- **Fixed per incarnation.** libkrun has no virtio-mmio hotplug. The share set is part of the start, like the disks.
- **Adding a source** while running records it and shows "pending restart". At a safe boundary (no turn, approval or tool in flight; the spec's "coordinated checkpoint/restart") the workspace restarts with the new share.
  - Before cold resume exists, such a restart ends the conversation (`cold_resume_unavailable`). So live source addition should ship after CR4 (O6).
- **Revoking a source** takes two steps:
  1. The daemon sends the L1 `share_revoke` line at once. Every FUSE operation that starts after the switch fails, so no new byte crosses; the cutoff is reported on `share_revoked{tag}`, or the workspace is stopped fail-closed after 2 s (R11).
  2. Then the stop/start without the share. The spec's "revocation complete" is reported only after that restart, because the guest page cache can still hold content.

  Other Project conversations see the interruption reason (spec).
- **The minimum-source rule** is unchanged and never blocks a security revocation (spec).
- **TCC.**
  - The daemon resolves the bookmark and opens the root, so the consent attaches where the grant was made.
  - The worker is a separate signed identity, spawned through the launcher. Whether its `openat` under a protected location (Desktop, Documents, iCloud Drive, removable or network volumes) is attributed to the responsible app or prompts again is unverified. That is a G7 item; the spec already requires "Validate actual picker/bookmark/TCC handoff".

### 2.7 Threat analysis (shares)

| # | Threat | Mitigation | Residual | Proof |
| --- | --- | --- | --- | --- |
| T1 | A compromised guest kernel sends crafted FUSE requests (`..`, `/`, absolute names, forged node ids) | R1, R2, per-device inode tables, deny-default sandbox scoped to the share subpaths | none known | VM-free server tests with crafted messages (SH2); G0-S; G7 |
| T2 | Symlink following on the host (`open` of a link inode, `create` through a dangling link) | `O_NOFOLLOW`, `O_RESOLVE_BENEATH`, R3 | none in the server | SH2 tests: dangling link create, link inode open, rename race with a host-side mutator |
| T3 | A host reader follows a guest-planted link (confused deputy: Winter host readers, Dreamer, artifact bridge, Mac apps) | Winter readers already use held `O_NOFOLLOW` directories (`output-fs.ts`, `instruction-fs.ts`); every new reader of a share does the same | the user's own Mac apps follow links in their own folders | reader tests; spec text "Host reads of guest-writable shared data must reject traversal and symlink escapes" |
| T4 | Hard link from inside to outside | the server cannot reach outside inodes; R5; `O_UNIQUE`/`AT_UNIQUE` and no `LINK` on the Winter shares | on folder sources, a link the USER made before granting the folder (hard links stay allowed there, O4) | documented; SH2 test that a two-link file on a Winter share is never served |
| T5 | Mount-point crossing inside a granted folder | R4 | none | SH2 test with a nested device (no VM: a disk image is not needed, a second APFS volume fixture is) |
| T6 | Cross-share write into read-only guidance | one device per share; R5; RO in three layers | none | SH2; G7 |
| T7 | DAX: guest-chosen host `mmap` | R6 (gate, server, guest mount option, kernel fragment) | none if all four hold | gate matrix test; SH6 mount-option test |
| T8 | Ownership forgery and host xattr pollution | R7 (Simplified, no xattr) | the guest sees every file as its own (accepted by spec) | SH2 |
| T9 | World-writable or setuid files planted in user folders | R7 mask | none | SH2 |
| T10 | Worker descriptor or thread exhaustion | R10; one thread per device | the workspace's own worker fails, not the daemon | SH2 |
| T11 | Disk filling through a writable share | the S6 pressure guard covers "host-backed memory/outputs" and "selected writable host sources" (`docs/cowork-execution-contracts.md`, disk pressure) | in-flight overshoot (accepted by spec) | G5 extended |
| T12 | Host path disclosure: `readlink` of the user's existing links and Mac error texts | none in the server (rewriting link text would break repositories) | the guest and the model can learn the user's home path and name from existing links | documented as residual |
| T13 | Winter control state exposed by a broad grant (for example the home folder), or made guest-writable by a grant inside it (`~/.winter/sdk`, `settings`, `plugins`) | O5 in both directions (`SharePolicy.swift:116,125` ported); optional sandbox denies | none | SH5 tests, one per Swift case |
| T14 | Revocation bypass through open guest handles or the page cache | R11 switch, then restart | content already read (accepted by spec: "cannot recall it") | G7 |
| T15 | TCC prompt misattributed or bypassed | the daemon opens roots under its consent; the worker inherits descriptors | unknown until measured | G7 |
| T16 | A guest-visible share after the worker's owner is lost | the drain unmounts; the worker exits on owner loss (existing timeline) | none new | G2-S |
| T17 | Guest-written git configuration that the HOST runs: a hook in `.git/hooks`, or `core.fsmonitor`, `core.hooksPath`, `core.sshCommand`, an editor, pager, filter, diff or merge driver, an include, or a `!` alias in `.git/config`, run the next time the user (or a host Code session, or a Mac git client) runs git in that folder | R15 (owner: block): hooks immutable to the guest, in any entry type; config changes only through lock and rename, refused when a risky key is added or changed; git directories cannot be moved; gitfiles content-checked; applies to submodule and worktree gitdirs | a risky value the user's config ALREADY had stays (the guest cannot add or change one); a program-running key that a future git adds passes the denylist until the list is updated (the allowlist alternative closes this, section 9); a repository whose gitdir lives outside the share is not reachable by the guest at all | SH2 tests: every key in the list, case variants, includes, continuation lines, a hooks directory or symlink built elsewhere and renamed in, `.git` renamed aside and rebuilt, a gitfile pointing at a guest-made bare repository, `config` unlinked and re-created, an open-handle write after rename, a hard-linked lock file; a clone, worktree add and submodule update that succeed |
| T17b | Hooks the repository itself keeps in tracked files: a config that ALREADY sets `core.hooksPath` to an in-tree directory (husky's `.husky/_`, lefthook, a `githooks/` folder), or an `include.path` whose target file lives in the share. The guest can edit those files freely, and the host's next git command runs them | not covered by R15: the owner's ruling names `.git/hooks` and `.git/config`, and blocking writes to `.husky/*` or an included file would also block ordinary edits to versioned files | open (owner question, section 9 M6 follow-up) | recommendation: R15 also refuses guest writes to the directory an existing `core.hooksPath` names and to existing `include.path` targets inside the share, resolved when the share starts and re-resolved when the config changes, and reports each refusal with `share_notice`; until the owner answers, only report them (`share_notice`, kind `hooks_path`) |
| T18 | Guest-written `.envrc` run by direnv when the user enters the folder | allowed and reported (R15 watched names, `share_notice`); the file is quarantine-tagged (R16); direnv itself refuses to run a changed `.envrc` until the user runs `direnv allow` again, because it keys approval to the file's content | a user who re-allows without reading it | recommended handling: no block (editing `.envrc` is normal work), report plus tag; G7 checks direnv's re-approval on a guest-changed file |
| T19 | Guest-written IDE task files that run on open: `.vscode/tasks.json` (`runOptions.runOn: "folderOpen"`), `.vscode/settings.json` (interpreter, terminal or tool paths), `*.code-workspace`, `.idea/runConfigurations/**` | allowed and reported (`share_notice`), tagged (R16), and the folder is marked guest-writable (R17); VS Code's Workspace Trust keeps an untrusted folder in restricted mode (no tasks run); in a trusted folder, whether a `folderOpen` task runs without a prompt depends on its `task.allowAutomaticTasks` setting | a folder the user already trusts in the IDE, if automatic tasks are allowed there | recommended handling: report and tag in v1; G7 measures VS Code's behaviour on a trusted folder with a guest-changed `tasks.json`. If it runs without a prompt, `.vscode/tasks.json` joins R15 under the same rename check (refuse `folderOpen`) |
| T20 | A guest-made executable, script or app bundle run on the Mac without Gatekeeper, because it carries no quarantine | R16: every guest-created file on a read-write share is tagged, and a file the guest makes executable is tagged | in-place content changes to a file that was already executable and untagged | SH2 test that every `CREATE` and exec-bit `SETATTR` leaves the tag and a tag failure fails the call; G7 checks Gatekeeper's prompt on a tagged binary, a script and an app bundle |

### 2.8 Files and repos (shares)

| Repo | Files | Owner lane |
| --- | --- | --- |
| winter | `apple/Cowork/WinterCoworkLibkrun/patches/0024…` (confined server, guarded fs device, `krun_cowork_add_share_v1`, gate clauses), `patch-queue.json`, `expected-hashes.json`, `README.md`, `tests/test_queue_guards.py` | the libkrun lane (S4 lineage) |
| winter | `apple/Cowork/WinterCoworkHVFWorker/Sources/WorkerNative/{WorkspaceWorker,Sandbox,Envelope}.c` and headers, `CoworkAbi.h`, tests (`test_sandbox_profile.c`, `test_envelope.c`, new `test_shares.c`), `pins.json` | worker (S3 lineage) |
| winter | `apple/Cowork/WinterCoworkLauncher/Sources/LauncherCore/{Wire,Session,Launcher}/*`, `LauncherNative/native.c` (argv), tests, vectors | launcher (S2 lineage, PR #57 and #85) |
| winter | `docs/cowork-native-worker.md`, `packages/core/src/cowork/native/protocol.ts`, `test/cowork/native/vectors/*` | contract owner (S7B under wave 4) |
| winter | new `packages/core/src/cowork/native/shares.ts` and tests; `native/host.ts` sends `shares` and `share_revoke` | S7B (`host.ts`) |
| winter | `apple/Cowork/WinterCoworkGuest/init/{boot,init_linux,mounts}.c`, `bootstrap/guest_bootstrap.py`, `vectors/*`, `scripts/cowork-guest-artifact/kernel/` (optional fragment) | N2 guest lane |
| winter | `cowork/repository.ts` caller of `acknowledgeSource` at `shares_mounted` | DOOR (`repository.ts`) |
| winter | the source list and grant picker marker (R17) and the `share_notice` line on the conversation (`apple/Winter/Sources/…` Cowork views; the projector) | DOOR (projector), Mac app |
| agent SDK | `packages/runtime/src/guest/linux-host-query-profile.ts` (admit the exact memory root) | SDK lane |

### 2.9 Slices (shares)

| Slice | What | Size | Depends on | Tests (no VM) |
| --- | --- | --- | --- | --- |
| SH1 | Contract text version 3: L1 `shares`, `share_revoke`, `shares_rejected`; L2 kinds 6 and 7; statuses `share_revoked{tag}` and `share_notice{tag, kind}`; worker argv; bootstrap `shares`, `shares_mounted`, faults `share_inventory` and `share_mount_failed`; vectors | M | none | vectors round-trip in TS, Swift, C and Python |
| SH2 | libkrun confined passthrough + guarded fs device + ABI + gate clauses; R0–R16, as patches 0024 onward in the winter repo's queue (owner D7) | XL | SH1 for names only | `cargo test`, one thread, never `--ignored`: a FUSE-message harness drives the server in-process against temp trees (opcode allowlist with an unknown-opcode case, escape suite, race suite with a host mutator thread, RO suite, `O_UNIQUE` on Winter shares, R15 git suite, R16 tag suite, bounds, the pin-budget maximum); gate matrix rows that keep every TSI and vsock refusal passing with shares present; ABI smoke; independent review before any run |
| SH3 | Worker: argv parse, per-share sandbox parameters, L2 intake, `krun_cowork_add_share_v1`, revoke and `share_revoked` after the device thread's own close, `share_notice` | M | SH1; SH2's header | strict-C tests; profile text tests; the `sandbox_init` stub stays aborting |
| SH4 | Launcher: L1 `shares` and `share_revoke`, identity checks, argv, L2 forward, status relay | M | SH1 | `swift test` with the FakeWorker |
| SH5 | Daemon `shares.ts`: grant to descriptor, protected-root refusal in both directions, alias dedupe; `host.ts` sends `shares` and `share_revoke`, and stops fail-closed on a missing `share_revoked` | M | SH1 | `bun test` with the fake launcher |
| SH6 | Guest: inventory check, mounts, alias, drain unmount, `init.templateDir` empty in the system gitconfig; SDK memory root in both root checks (SH6b) | M | SH1 | native tool tests, `python3 -I -S -B -m unittest`, SDK `bun test` |
| SH7 | Mac and daemon UI: the guest-writable marker on folder sources (R17), `share_notice` shown on the conversation | S | SH5 | `bun test`; Swift view-model tests |

## 3. Piece 2: cold resume

### 3.1 What persists across a stop

| State | Where | Survives a cold stop | Notes |
| --- | --- | --- | --- |
| SDK session store (transcripts, subagent transcripts, lease file) | `data.ext4`: `/workspace/.winter/conversations/<sid>` | yes | each append is fsynced by the SDK store; a Class A stop also proves the final flush |
| Repositories, worktrees, dirty files | `data.ext4`: `/workspace/repos` | yes | |
| Conversation scratch | `data.ext4`: `/workspace/.winter/scratch/<sid>` | yes | |
| Held peer inputs (piece 3, new) | inside the store directory | yes | 4.5 |
| Installed tools and packages | `env.ext4` | **only once CR5 mounts it** | N2 attaches and formats it but mounts nothing (`docs/cowork-native-worker.md` section 6.1) |
| Guidance, memory, outputs | host shares (piece 1) | yes, and readable while stopped | before piece 1 they live on `data.ext4` |
| Run homes | `/run/winter/conversations/<sid>` (tmpfs) | no; rebuilt each boot | spec: run homes are materialized, not restored |
| Task graph (TaskCreate…) | runtime memory | **no** | same as Code (spec gap X9) |
| Processes, sockets, RAM, `/tmp` | | no | spec: "Arbitrary processes, sockets and RAM are not promised to survive" |
| Host event log, bindings, epochs, peer inbox, launcher receipts | host | yes | |

### 3.2 The design

**Wire (contract, CR1).** A conversation's `runtime` object gains two keys:

| Key | Values | Meaning |
| --- | --- | --- |
| `continuation` | `"fresh"`, `"resume"` or `"either"` | chosen from the host's `store_state` (below); `resume` only when the host log has a completed turn |
| `endedGuestBoots` | 0 to 4 guest boot ids (UUID text) | boots that the host attests have ended |

The host lists a boot id only when both hold:
- the host recorded it from that incarnation's bootstrap `hello`, durably, BEFORE it sent that incarnation's conversation set;
- that incarnation's ownership was released by real D1 proof: a Class A receipt, a changed host boot id, or the owner's Recover.

Two new bootstrap fault codes: `resume_store_missing` and `fresh_store_not_empty`.

**The `store_state` predicate (one definition for the host and the supervisor).** The supervisor's own test is emptiness: a store is fresh exactly when `os.listdir` of the store directory and of the run home are both empty (`linux-supervisor.py:1152`; the run home is tmpfs and always empty at a new boot). DOOR's rule is that `identity().resume` becomes true when the host log has a completed turn (DOOR section 2.4). The two can disagree in one window: a run that reached `runtime_ready` (so the SDK bootstrap has written its lease and skeleton, and the store is no longer empty) but finished no turn. The host therefore keeps four states, and each maps to exactly one supervisor test:

| `store_state` | Recorded when (durably, on the host) | `continuation` sent | Supervisor test |
| --- | --- | --- | --- |
| `none` | the binding is made | `fresh` | store and run home empty, else `runtime_fresh_store_required` |
| `started` | BEFORE the first conversation set that carries this conversation is sent (write-ahead) | `either` | run home empty; an empty store runs as `fresh`, a non-empty one as `resume`. `runtime_ready` echoes which (`continuation: "fresh" \| "resume"`), and the host passes `resume: backendSessionId` to `query()` only on `resume` |
| `created` | the host log records the conversation's first completed turn (DOOR section 2.4) | `resume` | store non-empty, owned by `runtimeUid`, mode 0700; run home empty; else `runtime_resume_store_missing`, and the host moves to `lost` |
| `lost` | `runtime_resume_store_missing`, or the data volume's `filesystem_mismatch` (CR4 step 9) | none: refused `cold_resume_unavailable` | never sent |

`either` exists only for the window between the first set and the first completed turn; nothing a user saw can be lost in it, because no turn completed.

**Guest (CR3).** PID 1 splices `continuation` and `endedGuestBoots` into the trusted config untouched. It creates nothing in an existing store directory; the skeleton already "creates or adopts" component by component. The guest adds nothing of its own to either field.

**SDK (CR2).**
- `linux-host-query-profile.ts`, in `configKeys` and `assertLinuxHostQueryConfig`:
  - admit `resume`, but only equal to `sessionId`;
  - keep refusing `continue`, `forkSession`, `resumeSessionAt` and `resumeDropsTurn`.

  The guided profile inherits this through `assertLinuxHostQueryConfig`.
- `linux-session-admission.ts`:
  - `freshOnly: true` becomes `continuation: "fresh" | "resume"` (closed; the supervisor resolves `either` to one of the two before it writes the record);
  - `resume` requires `runtimeConfig.resume === scope.sessionId`;
  - `previousBootTermination(bootId)` returns `{scope, ownerToken, previousBootId: bootId}` exactly when `bootId` is in the record's `endedGuestBoots` and differs from `currentBootId`, and `null` otherwise. The lease logic in `store-bootstrap.ts` and `leases.ts` stays unchanged.
- `linux-supervisor.py` `_configure_runtime` and `_runtime_record`:
  - `hostQueryRuntime.continuation` and `endedGuestBoots`;
  - for `fresh`, today's empty-store rule (`:1152`);
  - for `resume`, the store must be a non-empty directory owned by `runtimeUid` with mode 0700, and the run home must be empty. Otherwise `runtime_resume_store_missing`;
  - for `either`, the run home must be empty, and the store's emptiness picks `fresh` or `resume`, under the same `flock` (`:1150-1151`) so the test and the launch cannot race;
  - the `timeoutMs` validator (`:1141-1142`) admits up to 86,400,000 for host-query profiles only (O7); the fresh profile keeps `1..600000`.
  - The `flock` exclusivity stays.
  - The record carries `continuation` and `endedGuestBoots` instead of `freshOnly`.
- The fresh fixture profile keeps `freshOnly` semantics.

**Host (CR4).** The driver's `ensure(sessionId)` on a `stopped` workspace:

1. Refuse `recovery_required` unless the workspace is `stopped` with ownership released.
2. Read `store_state` and the stored identity (the table above):
   - `none` → `fresh`;
   - `started` → `either`;
   - `created` → `resume`;
   - `lost` → refuse `cold_resume_unavailable`, reason "the conversation's store is gone", and never start fresh.
3. `native.start(workspaceId, {conversations})` with a new incarnation (`beginIncarnation`: epoch + 1) and a `probe-existing` plan, or `replay-journal-then-probe` after a Class B.
4. On `hello`, durably record `(workspaceId, incarnationId, leaseEpoch, guestBootId)` before the set is sent.
5. Build the set with the conversation's stable `runtimeUid`/`toolUid`, current revisions, `continuation` and `endedGuestBoots` (that conversation's last incarnation, when released by proof).
6. On `runtime_ready`, build `WinterSession` with `query({resume: backendSessionId})`. This already exists: `guest-runtime.ts` passes `resume` when `identity.resume`.
7. Before the first user frame:
   - reconcile held peer inputs (4.5);
   - deliver current guidance (guided profile, `runtime_context`), as the spec requires on resume.
8. Mark `store_state = started` before the first set is sent, and `created` when the host log records the first completed turn (the table above).
9. The data volume's UUID is the host's own: it already fixes `expectedFilesystemUUID` in each volume plan, and the guest refuses a mismatch with `filesystem_mismatch` (`guest_bootstrap.py:565,621,894`). The host keeps that UUID per workspace (`store_volume_uuid`) and sends the same value in every later `probe-existing` plan. A `filesystem_mismatch` fault, or any plan that would `format-new` a workspace with a `started` or `created` store, moves every such conversation to `lost`.

### 3.3 Incarnation and lease rules

| # | Rule | Enforced by |
| --- | --- | --- |
| L1 | A resume is always a NEW incarnation (new `incarnationId`, `leaseEpoch` + 1). No live adoption of a guest from an earlier daemon. | `beginIncarnation`, spec |
| L2 | A start begins only from `stopped` with the disks released by D1 proof. `uncertain` refuses `recovery_required`. | native host, `stop-proof.ts` |
| L3 | Exactly one valid incarnation: one start mutex per workspace in the driver, plus the `stopped → starting` compare-and-set. A second `ensure` waits for the in-flight start. Input arriving after shutdown commits is queued for the next incarnation (host send queue, peer inbox). | DOOR driver, `power.ts` |
| L4 | Every host callback carries the epoch: approval answers, peer `offer`/`ack`, `hold`, schedule claims. A stale epoch refuses (`stale_acknowledgment`) and changes nothing. A held input's `commit`, `discard` and `forget` carry its hold token, which is itself derived from the epoch (4.3). | ledger, approval bridge, driver |
| L5 | Authority is re-read at every start (`configRevision`, `grantRevision`, `policyRevision`). The guest's stored authority snapshot cannot raise it; the SDK checks current authority on continuation (agent SDK PR #2). | supervisor admission, SDK |
| L6 | Previous-boot evidence is minted only for host-attested boot ids. A lease from an unlisted boot reads as alive, so the runtime refuses, and the host shows `recovery_required` (the owner's Recover with its two guards). A guest-written marker never counts (`docs/research/2026-10-17-cowork-n2-guest-boot.md` section 10). | CR2, CR4 |
| L7 | `runtimeUid` and `toolUid` are stable per conversation, recorded on the host at bind. Store and file ownership on `data.ext4` therefore match across incarnations. The N2 builder uses fixed picks for index 0, which is stable only by accident. A uid is never reused while any file of a deleted conversation it owned may remain on the data volume: a deleted conversation's uids are retired (kept in the workspace's allocation table) until its store, scratch and tool-owned files are proven removed, and the browse uid (4b.3) is drawn from the same table. | DOOR schema (section 8) |
| L8 | A lost or reformatted data volume (UUID mismatch, or a `format-new` plan for a workspace with a created store) never yields a fresh conversation under the old identity. | CR4 |
| L9 | Pending approval callbacks keep the guest occupied (spec), so a cold stop never strands one. A crash withdraws the card, and the SDK's interrupted-history repair marks the call interrupted on resume. | #84 bridge, SDK |

### 3.4 The 600 s cap and relaunch in place

`_run_runtime` kills the runtime `timeoutMs` after launch (default and maximum 600,000), whether or not a turn is running (`linux-supervisor.py:1257`). The supervisor also refuses a second launch (`runtime_fresh_only`). So today a host-query conversation lives at most ten minutes per incarnation, and the next send refuses. Two ways out (O7):

1. **Accepted (owner, O7).** For host-query profiles the 600 s cap goes, but only together with three bounds, which compose so that the host always acts before the guest:

   | Bound | Value | Where | What happens |
   | --- | --- | --- | --- |
   | Host per-turn bound | 2 h of turn time. The clock PAUSES while an approval or question card for that turn is open (L9 keeps the guest occupied while a card waits, so an open card must not count) | DOOR driver | `interrupt`; the turn ends with a visible note "stopped after 2 hours"; the conversation stays usable |
   | Idle cold stop | DOOR's two minutes of quiescence (no turn, approval, question, tool or peer delivery in flight; DOOR section 2.4 and its O4) | DOOR driver | an orderly Class A stop; the next send cold-resumes. Active only once CR4 ships; before that the driver keeps today's no-idle-end rule |
   | Guest backstop | 24 h per runtime run (`timeoutMs` 86,400,000; the validator's maximum is raised for host-query profiles only, CR2) | SDK supervisor | today's kill; recovered by cold resume as a crash (interrupted-history repair) |

   The backstop is 12 times the per-turn bound, and a run is cold-stopped after two idle minutes, so it fires only if the host has failed to govern the run, or if a conversation stayed busy for 24 h without two idle minutes; then it resumes as after a crash. A turn that waits on a card longer than the backstop is ended by the backstop; that is accepted, because a 24 h unanswered card is itself a stalled conversation. The fixture `fresh` profile keeps its 600 s cap.
2. **Alternative.** Relaunch in place with `continuation: resume`. That needs:
   - a supervisor re-launch after `cleanupConfirmed`;
   - re-armable `RuntimeDuplexPorts`;
   - a contract message that resets the conversation's runtime streams. Today a stream that ended can never carry bytes again, so this would be `runtime_relaunch` / `runtime_relaunched`, bound to the plan's operation and nonce and carrying a generation.

   It costs CR6 (M). It is also the only way to survive a runtime crash without a VM restart.

### 3.5 The environment disk (CR5)

The spec says "Retain installed tools/packages across normal cold stops", and that the writable environment is pinned to its base-image digest. That needs four things:

1. PID 1 mounts `env.ext4` at `/opt/winter/environment/disk`.
2. An overlay of the read-only base with an upper directory on that disk.
3. The supervisor's `environment` pointing at the merged view.
4. A base-digest stamp on the disk. A mismatch keeps the old environment and refuses, until migration or an explicit rebuild ("retain the previous environment until migration or explicit rebuild succeeds").

Tool installs then run as the tool identity inside its compartment ("Any user-namespace root used for installation remains confined to tool-owned storage"). Size L, because it touches the SDK's compartment.

### 3.6 Threat analysis (cold resume)

| # | Threat | Mitigation |
| --- | --- | --- |
| C1 | A guest tool forges "the previous boot ended" to steal a live lease | Evidence comes only from the root-owned trusted config, through the native owner record. Tools cannot write either (L6). |
| C2 | A stale incarnation acts after the new one starts | Epoch fences (L4); the old worker cannot hold the disks (D1) |
| C3 | Two incarnations run at once (a wake/stop race) | L3, plus D1 disk ownership |
| C4 | Authority grows back through the stored snapshot | L5 |
| C5 | A silent fresh start after data loss | L8 |
| C6 | A resume without current guidance | ordering: CR4 activates only with the guided profile and the guidance share (O8) |
| C7 | A replayed external effect (an interrupted Bash, a push) | SDK interrupted-history repair; spec: "mark uncertain effects for reconciliation", never blind replay |

### 3.7 Files and repos (cold resume)

| Repo | Files | Owner lane |
| --- | --- | --- |
| agent SDK | `packages/runtime/src/guest/{linux-host-query-profile,linux-session-admission,linux-supervisor.py}` and tests (CR2); CR5 environment option; CR6 relaunch, if chosen | SDK lane (D4 says N2 owns these SDK pieces) |
| winter | `docs/cowork-native-worker.md` section 6.1, `native/protocol.ts`, vectors (CR1) | contract owner |
| winter | `apple/Cowork/WinterCoworkGuest/init/trusted_config.c`, `bootstrap/guest_bootstrap.py` (CR3); `init/{boot,mounts}.c` (CR5) | N2 guest lane |
| winter | DOOR's `cowork/session-driver.ts`, `conversation-set.ts` (CR4); `native/host.ts` records the guest boot id (S7B); schema columns (DOOR) | DOOR, S7B |
| winter | `scripts/cowork-guest-artifact/{pins.json,image.py}` re-pin to the SDK commit that carries CR2, and the host↔guest SDK pairing test (DOOR G8) | N2 guest lane |

### 3.8 Slices (cold resume)

| Slice | What | Size | Depends on |
| --- | --- | --- | --- |
| CR1 | Contract: `continuation`, `endedGuestBoots`, two faults, vectors | S | none (can share a PR with SH1) |
| CR2 | SDK: profile `resume`, record `continuation`, evidence from `endedGuestBoots`, supervisor store checks for `fresh`, `resume` and `either`, the host-query `timeoutMs` maximum (O7) | M | none |
| CR3 | Guest PID 1 passes the two keys through | S | CR1 |
| CR4 | Host: driver resume path, the four-state `store_state`, guest boot id record, stable and never-reused uids, `expectedFilesystemUUID` kept and re-sent, reconciliation hook, the per-turn bound and the idle cold stop (O7) | M | CR1, DOOR D3/D4, S7B |
| CR5 | Environment disk overlay and base-digest stamp | L | CR3, SDK |
| CR6 | Relaunch in place (only if O7 picks it) | M | CR2 |

## 4. Piece 3: guest-side messaging, questions and task tools

### 4.1 What each tool needs

| Tool | Transport | SDK change | Host change |
| --- | --- | --- | --- |
| SendMessage | runtime → host `host_message_send` (OUT); answer `control_response` (IN) | profile admits the tool and `hostMessaging: true`; `allowedSubtypes` adds it; registry gate; frame checker accepts the answer | DOOR binds `Options.hostMessaging` to `SessionMessaging.handlerFor(binding.sessionId, incarnation)`; #83 Cowork branch; #84 class row |
| ListAgents | `host_message_list` | the same | the same; the host lists own descendants and same-Project peers only (contract table) |
| AskUserQuestion | `permission` with `updatedInput.answers` (already admitted) | profile and registry gate only | #84's AskUserQuestion bridge on the Cowork route (question card, phone answer); unattended → typed deny or timeout |
| TaskCreate/Get/List/Update | none (in-process graph) | profile and registry gate | #84 read-only class row |
| TaskStop | in-process, or `host_session_stop` | **withheld** (O10): no guest background tasks or subagents to stop, and Project membership does not authorize stopping a sibling (contract) | none |
| TaskOutput | in-process | **withheld** (O10): guest Bash refuses `run_in_background` | none |

### 4.2 How the calls travel

```
guest runtime (host-query)                    relay / worker / launcher                     daemon
SendMessage → messaging runtime → host port
  control_request{subtype:"host_message_send", requestId, payload}
  ── runtime class 2, conversation i, stream OUT ──►  (opaque bytes; relayed blind)  ──► query() control dispatcher
                                                                                           Options.hostMessaging.send(request)
                                                                                           = SessionMessaging(caller = the binding's
                                                                                             session, incarnation = the driver's)
  ◄── stream IN ── control_response{requestId, ok, payload: HostMessageSendAnswer} ◄───────
checkLinuxHostQueryFrame: accept only if requestId is an outstanding host-message request
```

- No new mux class and no network: these are SDK frames inside the existing runtime streams (contract section 6.2). Class 3 stays reserved and refused.
- Flow control is unchanged: every IN answer follows an OUT request, so the 1 MiB unanswered-IN bound holds. Host-initiated `hold`, `commit`, `discard` and `forget` (4.5) are each answered with OUT bytes and are serialized per conversation by the driver (correctness rests on the hold token, not on that order).
- The sender is taken from the channel, never from the payload. `fromAgentId` is information only (SDK `config.ts`), as for Code.

### 4.3 The agent-SDK change (GM1, GM2)

GM1 (profile and transport):

- `linux-host-query-profile.ts`:
  - `tools` may be a subset of `Read, Write, Edit, Bash, SendMessage, ListAgents, AskUserQuestion, TaskCreate, TaskGet, TaskList, TaskUpdate` (the cap of four is raised accordingly).
  - Add `hostMessaging` to `configKeys`, allowed only as `true` and only with SendMessage or ListAgents present.
  - `checkLinuxHostQueryFrame(frame, ownsPermission, ownsHostRequest)`: a `control_response` whose id `ownsHostRequest` claims is checked against the closed answer shapes (`isHostMessageSendAnswer`, `normaliseHostMessageListAnswer`). Anything else stays `drop`. This must land in the same change as the `allowedSubtypes` addition below: allowing the subtype without it makes every answer a drop, and every call fails only at its request timeout (180 s for a send, 15 s for a list, `messaging/host-port.ts:20,22`) or on abort.
  - The call sites change with it: `checkLinuxSessionFrame` (`linux-session-admission.ts:153-156`) passes the new predicate through for both host-query profiles, and the engine's one caller (`engine.ts:6592`) passes `id => bridge.ownsRequest(id, "host_message_send") || bridge.ownsRequest(id, "host_message_list")`. A test drives an answer through `engine.ts:6592` itself, not only the checker.
- `engine.ts:3037-3040`: for both host-query profiles, `allowedSubtypes` adds `host_message_send` and `host_message_list`, and `host_session_stop` only if TaskStop is ever offered.
- `tools/registry.ts:1851`: the confined-guest allowlist becomes the same closed set. Grep, Glob, NotebookEdit, Workflow and TaskOutput keep `guestToolUnsupported`.
- `linux-supervisor.py` `host_query_config`: `toolClasses` gains a `coordinate` class that maps to SendMessage, ListAgents and the Task\* graph tools. AskUserQuestion is always present when any prompt-capable policy is set.

GM2 (held input; 4.5) adds Winter-only host → runtime control subtypes and one runtime → host system message. Every one names a **hold token**, never only an epoch, so a verdict can act only on the exact hold it is about, whatever order frames arrive in. The token is derived, not stored first: `holdToken` = lowercase hex SHA-256 of `"hold-v1|" receiptId "|" incarnationId "|" leaseEpoch "|" offerCount`, where `offerCount` is the ledger's per-receipt counter that `inbox.offer` increments in the same transaction. The host can therefore recompute it after a crash, and `inbox.ack` also records it (`ackedHoldToken`) atomically with the delivery.

**The runtime's held-input journal** is a store-owned file in the protected store directory (fsync, then a directory fsync, on every change). Each record has one state:

| State | Meaning | Leaves it |
| --- | --- | --- |
| `held` | durable, invisible to the model, undecided | `commit` (→ `committed`), `discard` (deleted), a re-hold (token replaced) |
| `committed` | the input belongs to the conversation; it will reach the transcript exactly once | its transcript append, tagged with `inputId` (→ `in_transcript`) |
| `in_transcript` | a tombstone: the transcript holds it | `host_input_forget` with the same token, which the host sends only after `confirmCommitted` |

"Committed" therefore means durably part of the conversation, with the transcript as the final authority: the append happens at the next point the SDK may add a user message (the fold at a tool boundary, the queue, or a new turn), because a user message cannot be written between a tool call and its result. On every runtime start, before `system/held_inputs` is emitted, the journal is deduped against the transcript by `inputId`: a `held` or `committed` record whose `inputId` is already in the transcript becomes `in_transcript`; a `committed` one that is not is fed first, before any other input.

| Subtype | Payload | Runtime effect | Answer |
| --- | --- | --- | --- |
| `host_input_hold` | `inputId` (the ledger `receiptId`), `holdToken`, `epoch {incarnationId, leaseEpoch}`, `text`, `clientName` | refuse unless the epoch equals the admitted scope; write a `held` record with this token | `{held: true}`. The same id and digest while `held` → `{held: true, again: true}`, and the token is REPLACED by this one (fsync). The same id and another digest → error `conflict`. The id already `committed` or `in_transcript` → `{held: false, state}`, changing nothing |
| `host_input_commit` | `inputId`, `holdToken` (the ledger's `ackedHoldToken`) | only if the record is `held` with exactly this token: → `committed` (fsync), then into the host-input path (fold, else queue, else start a turn); emit `system/host_input_committed {inputId, outcome}` | `{outcome: "folded" \| "queued" \| "started"}`; `committed` or `in_transcript` with this token → `{outcome: "already"}`; `held` with another token → error `superseded`, changing nothing; no record at all → error `unknown_input` |
| `host_input_discard` | `inputId`, `holdToken` | only if the record is `held` with exactly this token: delete it (fsync) | `{discarded: true}`; idempotent for an unknown id; another token → `{discarded: false, reason: "superseded"}`, changing nothing; `committed` or `in_transcript` → error `committed` |
| `host_input_forget` | `inputId`, `holdToken` | only for an `in_transcript` record with this token: delete the tombstone | `{forgotten: true}`; idempotent |
| (runtime → host) `system/held_inputs` | `[{inputId, digest, holdToken, state}]` for every `held` and every not-yet-appended `committed` record, after the dedupe | emitted exactly once after `init`, ALWAYS, even as an empty list, before the first input is read; nothing held starts a turn until the host decides | none |

- **Capability gate.** The runtime offers `held-input-v1` (beside the image's other runtime capabilities), and the host sends `host_input_*` only to a runtime that offers it. An older runtime's checker refuses an unknown control subtype, and a refusal is a `hardStop` of the run (`engine.ts:6596`), so without the gate a newer host would kill an older guest's conversation. A host that sees no `system/held_inputs` from a `held-input-v1` runtime treats the runtime as faulty (it never publishes the epoch, rule 1).
- `checkLinuxHostQueryFrame` admits exactly these four new control subtypes (closed payloads, size-bounded to the 64 KiB message cap plus the envelope), through the same call sites as GM1 (`linux-session-admission.ts:153-156`, `engine.ts:6592`).
- The host `Query` gains `holdInput`, `commitInput`, `discardInput` and `forgetInput`.
- **`clearQueuedInput` caveat.** `Query.clearQueuedInput()` drops the host inputs still waiting, and #83's TaskStop path clears what was queued behind a stopped turn. A `committed` peer input waiting in that queue must survive it: otherwise the ledger says `delivered` and the model never sees the message. So `clearQueuedInput` never removes `held` or `committed` journal inputs, its count excludes them, and a test pins that a committed input queued behind a running turn still reaches the transcript after a clear.

### 4.4 Guest to host: reaching the peer inbox

1. SendMessage in the guest becomes `host_message_send`. The host `query()` calls the handler that DOOR's driver bound at construction: `SessionMessaging.handlerFor(binding.sessionId, "<incarnationId>:<leaseEpoch>:<launch>")`. The incarnation string makes a restarted sender's `messageId` a new message, which #83 requires: "no incarnation is refused".
2. #83's `deliverViaPeerInbox`:
   - `inbox.accept` (same-Project authority, caps, dedupe), then `drainCoworkInbox(recipient)`;
   - the truthful answer is `delivered` only if acked, else `queued` with the receipt;
   - a Cowork-to-host target is uniform `not_found`.
3. ListAgents becomes `host_message_list`. The host answers with own descendants and same-Project peers. No host Code or Dispatch rows are listed (contract table).

### 4.5 Host to guest: hold until ack, then commit or discard

This is the coordinator's requirement, and it is the ledger's own rule ("the ack is the commit point"). Today `drainOnce` (#83 at `543b208c`) calls `deliverInto` (steer or send into the recipient's turn) and only then `inbox.ack`; an ack failure logs "it stays owed" and returns, although the input is already in the turn. If authority is revoked in between:
- the message is already in the model's input;
- the ack answers `authority_denied`, so the sender is told `not_found`;
- after a re-grant, the record is offered and delivered again.

For a Cowork recipient, the delivery becomes this:

```
drainOnce(recipient):                                                   // ONE chain per recipient (#83 already serializes it)
  epoch = driver.coworkEpoch                                            // published only AFTER reconciliation (rule 1)
  // Rule 3: finish what is already delivered before offering anything new (keeps FIFO, repairs lost commit answers).
  for r in inbox.deliveredUnconfirmed(recipient), oldest first:
      try   outcome = await driver.commitInput(r.receiptId, r.ackedHoldToken)   // "already" counts as confirmed
      catch unknown_input → inbox.confirmCommitted(r.receiptId, "lost"); surface it (4.5, terminal); continue
      catch any other     → return                                      // nothing newer is offered past an unconfirmed commit
      inbox.confirmCommitted(r.receiptId, outcome); driver.forgetInput(r.receiptId, r.ackedHoldToken) (best effort)
  offer   = inbox.offer(recipient, epoch)                               // increments offerCount
  token   = holdToken(offer)                                            // derived (4.3)
  try     await driver.holdInput(offer.receiptId, token, epoch, text)   // guest: durable, invisible to the model
  catch   → return                                                      // stays owed; an unacked offer is offered again
  try     inbox.ack({receiptId, recipient, epoch, holdToken: token})    // THE commit point; records ackedHoldToken
  catch e:
      if e is authority_denied or stale_acknowledgment:                 // typed refusals: the ledger changed nothing
          await driver.discardInput(receiptId, token) (best effort); return
      v = try inbox.verdict(receiptId) catch → return                   // the hold stays undecided; see the table
      if v.action == "commit": token = v.ackedHoldToken                 // the ack did land: fall through to commit
      else: await driver.discardInput(receiptId, token) (best effort); return
  try     outcome = await driver.commitInput(receiptId, token)          // guest: into the conversation
  catch   → return                                                      // rule 3 retries it on the next drain
  inbox.confirmCommitted(receiptId, outcome); driver.forgetInput(receiptId, token) (best effort)
  record outcome for the sender's answer
```

Three rules make this exact.

1. **Reconciliation before any offer.** When a Cowork runtime starts (a new incarnation, or a relaunch), its driver does NOT publish `coworkEpoch` until the reconciliation has finished: every entry of `system/held_inputs` has been answered. A `held` entry gets `inbox.verdict()`: `commit` with the ledger's `ackedHoldToken`, or `discard` with the token the runtime REPORTED for that record. A `committed` entry needs no verdict (the runtime feeds it itself); the host confirms it if the ledger still lists it as unconfirmed. Reconciliation runs inside the same per-recipient drain chain. While `coworkEpoch` is unpublished, `drainOnce` returns at once (#83 already treats an absent epoch as "stays owed"), so no new offer and no new hold can overtake a verdict. If a verdict cannot be read, the epoch stays unpublished and the reconciliation is retried; the recipient's messages stay owed, nothing is guessed.
2. **Token-exact verdicts.** Every `commit`, `discard` and `forget` names the hold token it is about, and the runtime acts only on a record carrying exactly that token. A re-hold replaces the token, so a late verdict for an earlier hold answers `superseded` and changes nothing. The driver does serialize frames per conversation, but correctness no longer depends on arrival order.
3. **Delivered first, and terminal outcomes.** Each drain first re-sends `commit` for this recipient's delivered-but-unconfirmed receipts, oldest first, and offers nothing newer until they are confirmed. A commit answer lost in transport is therefore repaired at the next drain; the sender's `delivered` stays true, and the recipient's input order is the ledger's order. An `unknown_input` answer is TERMINAL: the runtime has no record, no tombstone and no transcript entry for it (only possible after a guest fault or a data-volume loss, which CR4 separately turns into `lost`). The host confirms the receipt with outcome `lost`, never retries it, and the projector writes a visible note on the recipient's conversation ("a message from <sender> was accepted but could not be delivered"). One lost record therefore never blocks the recipient's later messages.

**Tombstones outlive every unconfirmed receipt.** The runtime deletes an `in_transcript` tombstone only on `host_input_forget`, which the host sends only after `confirmCommitted`, and the ledger's prune skips delivered records until they are confirmed. So for as long as the host may still send `commit` for a receipt, the runtime can still answer `already`; and even a lost forget leaves the transcript itself, deduped by `inputId`, as the last word.

Why each window is safe:

| Failure point | Ledger state | Guest state | What happens next | Delivered to the model |
| --- | --- | --- | --- | --- |
| Hold fails or the guest dies before holding | accepted (offered) | nothing, or a `held` record | re-offer under the live epoch (a new token re-holds it), or reconciliation discards it | 0 so far |
| Authority revoked between hold and ack | blocked (authority); ack answered `authority_denied` | `held` | `discard` now, or reconciliation discards later; on re-grant: re-offer, hold (`again`, new token), ack, commit | **exactly 1, after the re-grant** |
| Ack throws a typed refusal (`authority_denied`, `stale_acknowledgment`) | unchanged (accepted or blocked) | `held` | discard; the next drain re-offers if still owed | 0, then 1 |
| Ack throws anything else, and the ack did NOT land (store contract: "if it throws, none of it is visible") | accepted | `held` | `verdict()` says discard; discard; the next drain re-offers | 0, then 1 |
| Ack throws anything else, but the ack DID land | delivered, `ackedHoldToken` recorded | `held` | `verdict()` says commit; commit with that token now | exactly 1 |
| Ack throws and `verdict()` also throws | accepted or delivered | `held` | nothing is decided. If accepted, the next drain re-offers and re-holds (the token is replaced). If delivered, rule 3 commits it with `ackedHoldToken`. After a runtime restart, reconciliation decides it | exactly 1 |
| Host dies after ack, before commit | **delivered** (body deleted), not commit-confirmed | `held` (the body is in the guest's journal) | the next drain re-commits it first (rule 3); if the runtime restarted, reconciliation commits it before any offer (rule 1) | exactly 1 |
| Commit answer lost in transport; the runtime keeps running | delivered, not commit-confirmed | `committed` or `in_transcript`, or `held` if the request never arrived | the next drain re-sends `commit` with `ackedHoldToken`: `already`, or the commit happens now | exactly 1 (idempotent by id and token) |
| Commit sent and the guest dies before journaling it | delivered, not commit-confirmed | `held` (the commit fsync did not happen) | reconciliation → commit, before the new epoch is published | exactly 1 |
| Guest dies after journaling `committed`, before the transcript append | delivered | `committed` | at restart the dedupe finds no transcript entry and feeds it first; `held_inputs` lists it as `committed`; the host only confirms | exactly 1 |
| Guest dies after the transcript append, before the journal says `in_transcript` | delivered | `committed` (stale) | at restart the dedupe finds the `inputId` in the transcript and marks it `in_transcript`; it is not fed again | exactly 1 |
| Guest restarts with a new epoch while holding; the ledger record is still accepted | accepted | `held` with the old token | reconciliation discards it (its reported token), and only then is the new epoch published; re-offer, hold, ack and commit under a new token | exactly 1 |
| A stale discard or commit (an old token) arrives after a re-hold | accepted (offered again) | `held`, new token | answers `superseded`, changes nothing; ack and commit proceed under the new token | exactly 1 |
| `clearQueuedInput` or a TaskStop clear while a committed input waits in the queue | delivered | `committed` | the clear skips journal inputs (4.3); the input still reaches the transcript | exactly 1 |
| Commit answered `unknown_input` (guest fault or volume loss) | delivered | nothing | terminal: confirmed `lost`, surfaced on the recipient's conversation, never retried; later messages flow | 0, visibly |
| `host_input_forget` lost | delivered, confirmed | `in_transcript` tombstone | harmless: the tombstone stays (a few bytes); a later forget or the next reconciliation clears it | exactly 1 |

Four ledger additions make the reconciliation decidable and rule 3 possible (NEEDS FROM PEER-INBOX):

1. `offer` increments a per-receipt `offerCount` in the same transaction, and `ack` takes the `holdToken` and stores it as `ackedHoldToken` atomically with the delivery.
2. `verdict(receiptId, recipientSessionId): {action: "commit", ackedHoldToken} | {action: "discard"}`:
   - `delivered` → commit, with the token it was acked under;
   - `accepted`, `blocked` or `refused` → discard.
   - An unknown id cannot be delivered-but-unconfirmed, because of item 3, so it is a discard.
3. `confirmCommitted(receiptId, outcome)` sets a `commitConfirmed` mark (`outcome` includes `lost`). `prune` skips delivered records without it. Otherwise a long-stopped recipient (beyond the one-day / 100-record retention) would hold an input whose verdict the host can no longer give.
4. `deliveredUnconfirmed(recipientSessionId)`: delivered receipts without the mark, in ledger order. This is rule 3's work list.

The body still lives on the host only while owed (the owner's 2026-10-16 decision). After the ack the only copy is the guest's journal record (and, once appended, the transcript). That record is durable on `data.ext4` by the hold's fsync, and covered by the Class A final flush on an orderly stop.

The rendered text is still `renderAttributedTurn` from the receipt. The commit makes the runtime emit `system/host_input_committed`, and the host projector records the attributed agent message from it (DOOR's projector, section 8).

### 4.6 Approvals and questions

- **#84's table has no cell for SendMessage, ListAgents or Task\*.** All three are denied today as unknown classes. Recommended rows (NEEDS FROM APPROVALS):
  - ListAgents and TaskCreate, TaskGet, TaskList and TaskUpdate: read-only class, allowed under every policy;
  - SendMessage: a `coordination` class, allowed under every policy except `plan`, where it **asks**.

  Outside `plan`, SendMessage gets no prompt, because the messaging contract, not the approval policy, decides who may be reached. The recipient executes under its own policy ("Messages and returned results do not confer authority on their recipient"). Under `plan` it asks (review fold): a message can start work in another conversation, which a plan-mode turn should not do unseen, even though it mutates no workspace file. The SDK runtime mode is `plan` there (`linux-supervisor.py:322-330`), so the ask reaches the host matrix through `canUseTool`.
- **AskUserQuestion keeps #84's own bridge.** The card is a question card on the conversation's log, answerable from the Mac and the phone. Under `dont-ask` and for unattended turns it is a typed deny or timeout, never an auto-answer.

### 4.7 The one-conversation limit

N2 serves at most ONE host-query conversation per guest (`docs/cowork-native-worker.md` section 6.1), and a Project's conversations share one guest. So a guest sender's same-Project peer can never be running at the same time:
- the message is accepted and stays owed;
- the peer's next `ensure` refuses `conversation_limit` while the sender's guest runs.

Delivery happens only after the sender's incarnation ends and the peer's starts. Same-Project messaging is truly useful only after the limit is lifted (O12). That needs:
- a conversation-set change while running (an add-only `conversation_add` bootstrap message bound like `conversations`, or a restart at a safe boundary);
- the supervisor's limit raised from one host-query conversation;
- the runtime stream index above 0 (the prefix already carries it).

That is a separate contract slice. GM1–GM3 can be built and tested with fakes before it.

### 4.8 Threat analysis (messaging)

| # | Threat | Mitigation |
| --- | --- | --- |
| M1 | A guest forges the sender (`fromAgentId`, `to` tricks) | the sender comes from the driver binding; `fromAgentId` is information only; host-side caller/target/workspace check (#83, contract) |
| M2 | A guest reaches host Code/Dispatch sessions or other Projects | uniform `not_found` (#83); ListAgents lists only own descendants and same-Project peers |
| M3 | A guest floods the inbox | the ledger's caps (32 per sender pair, 256 / 4 MiB per recipient) |
| M4 | A forged `control_response` or a forged answer to a host request | the guest frame checker accepts only ids it owns, with closed shapes |
| M5 | Duplicate or lost delivery across revocation and crashes | 4.5 (hold, ack, token-exact commit or discard, verdict before any discard after an untyped ack throw; reconciliation before the epoch; transcript dedupe; tombstones until confirmed; terminal `unknown_input`; prune guard) |
| M8 | A newer host's `host_input_*` frame kills an older guest's run | the `held-input-v1` capability gate (4.3); `system/held_inputs` always emitted |
| M6 | A held record tampered with by tools | it lives in the protected store directory, omitted from tool views (the contract's protected store rules) |
| M7 | A question card spoofed by a peer | cards belong to the target conversation; only authorized user clients answer (contract, #84) |

### 4.9 Files and repos (messaging)

| Repo | Files | Owner lane |
| --- | --- | --- |
| agent SDK | `packages/runtime/src/guest/linux-host-query-profile.ts`, `runtime/src/engine.ts` (allowed subtypes; host-input subtypes), `runtime/src/tools/registry.ts`, `guest/linux-supervisor.py` (`host_query_config`, the `coordinate` class), the store's held-input journal and its transcript dedupe (`guest/store-bootstrap.ts` or a sibling), `linux-session-admission.ts` (`checkLinuxSessionFrame`), the `engine.ts:6592` caller, `clearQueuedInput` skipping journal inputs, `packages/sdk/src/query.ts` (`holdInput`, `commitInput`, `discardInput`, `forgetInput`), tests | SDK lane |
| winter | `agent/session-messaging.ts` `drainOnce` reorder; `MessagingDriverHandle` gains `holdInput`, `commitInput`, `discardInput`, `forgetInput` | PEER-INBOX |
| winter | `cowork/peer-inbox.ts` (`offerCount`, `ackedHoldToken`, `verdict`, `confirmCommitted`, `deliveredUnconfirmed`, the prune guard) and `peer-inbox-sqlite.ts` (columns, through DOOR's migration) | PEER-INBOX; DOOR for the schema |
| winter | `runtime-sdk/cowork-approval.ts` and `approval-bridge.ts` class rows | APPROVALS |
| winter | `cowork/session-profile.ts` `COWORK_GUEST_PROFILE_TOOLS`, the driver's `hostMessaging` binding, the projector for `host_input_committed` | DOOR |

### 4.10 Slices (messaging)

| Slice | What | Size | Depends on |
| --- | --- | --- | --- |
| GM1 | SDK: profile tools and `hostMessaging`, allowed subtypes, registry gate, frame checker for host answers and its two call sites | M | none |
| GM2 | SDK: held input (hold, commit, discard, forget; token-exact), the journal states and transcript dedupe, `system/held_inputs` always emitted, the `held-input-v1` capability, `clearQueuedInput` skipping journal inputs, `Query` methods; a release | M–L | GM1 |
| GM3 | Winter host: the driver binding and `hold`/`commit`/`discard`/`forget` on the Cowork driver behind the capability gate (DOOR); the `drainOnce` reorder, verdict-before-discard, the terminal `lost` outcome, `offerCount`/`ackedHoldToken`, `verdict` and prune guard (PEER-INBOX); class rows (APPROVALS); reconciliation at runtime start | M | GM2 pinned, #83, #84, DOOR D3 |
| GM4 | Prompt and tool-surface text for the newly offered tools (DOOR's generated blocks) | S | GM3 |
| (MC) | Lift the one-conversation limit (separate contract slice; O12) | L | CR4 |

## 4b. The guest file channel: Mac readers see guest-only files (coordinator addition)

The host half is draft PR #91 (`cowork/file-channel-port`, at `dc6d4565`; note `docs/research/2026-10-18-cowork-guest-file-channel-transport.md`).

- It carries the merged channel grammar (`cowork/guest-file-channel.ts`: `stat`, `read` and `readRange`, with closed request and response keys, and six error codes).
- It uses two new streams in the existing RUNTIME mux class, on conversation 0:
  - `FILE_IN = 4`, host to guest, request lines of at most 16 KiB;
  - `FILE_OUT = 5`, guest to host, response lines of at most 384 KiB.
- There is no NIC, vsock or network, and no class 3. The coordinator accepted this choice (O-F1).
- The host port (`guest-file-port.ts`) is built and unwired. It allows four requests outstanding and fails closed on any unattributable line.

What is missing is (a) the N2 contract extension and (b) the guest-side file service. This section designs both.

### 4b.1 How the file channel and the shares divide the work

The spec wants both:
- **Shares** for guidance, memory and outputs: "readable through the artifact bridge while the VM is stopped".
- **The channel** for guest-only browsing: "guest-only repos/scratch require file channel and visible wake when necessary".

The rule is **one reader per location, never both**:

| Location | Lives on | Mac reader | VM must run |
| --- | --- | --- | --- |
| Folder source (`/workspace/folders/<id>`) | the user's Mac folder (share, piece 1) | the host reads the host path directly (the user's own files; the Mac app or a host Code session) | no |
| Shared guidance, memory, outputs | `<home>/cowork/workspaces/<id>/shared/…` (shares) | the existing host readers (`workspace.output.list`, `workspace.file.read`, `instruction-fs.ts`, `output-fs.ts`), descriptor-relative with `O_NOFOLLOW` | no |
| Cloned repositories (`/workspace/repos/<id>`), conversation scratch, anything else on `data.ext4` | the guest data volume | **the file channel** (streams 4 and 5) | yes (a visible wake, per the spec) |

This rule is enforced structurally:
- The guest file service checks the ROOT's device before it walks (4b.3, step 2): the root must be on the data volume (`fstatfs` reports ext4, and its `st_dev` is the data volume's). A folder or outputs root IS the virtiofs mount point, so its root fd already sits on the FUSE mount. `RESOLVE_NO_XDEV` alone would not stop that; it refuses only crossings below the root, and it still guards those. So the service can never answer for a share.
- The host's authority composition (#91's NEEDS for DOOR) maps a share-backed `locationId` to the host reader and never to the channel.
- The two paths never give two views of the same bytes.

**Interim.** Until SH6 lands, outputs live on `data.ext4` (DOOR G11). The channel could serve them while the VM runs, as a stopgap.
- Recommendation: do not build that stopgap. Ship the outputs share before activation instead. No production Cowork data exists yet, so no migration of outputs from `data.ext4` to the share is needed.
- If the order changes and activation comes first, PID 1 must refuse to mount the outputs share over a non-empty `/workspace/outputs`. A migration step is then owed.

### 4b.2 (a) The N2 contract extension

| Contract item | Change |
| --- | --- |
| `docs/cowork-native-worker.md` section 6.2, the stream byte | `1` IN (down), `2` OUT (up), `3` ERR (up), **`4` FILE_IN (down), `5` FILE_OUT (up)**; `0` and `6` or more stay `bad_field` |
| Direction rule | `(stream ∈ {IN, FILE_IN}) == (direction == down)`, else `bad_direction` |
| Conversation index | streams 4 and 5 are legal on conversation **0 only**, in N2 and after MC. A request names its own `sessionId`; the guest resolves it against that conversation's delivered roots. The index is transport, not authority. Streams 4 and 5 on any other index are `bad_field` |
| End state | as for the other streams: an empty data section only with the end flag; nothing after an end. `FILE_IN` end = the host closed its port (the channel is over, never "this reply is done", as #91 says); `FILE_OUT` end = the guest file service exited (drain, or a fault). After either end the channel stays closed for the incarnation; #91's port fails closed and the next incarnation builds a new one |
| Ordering | file frames only after `runtime_ready`, like every runtime frame |
| Capability gate | the host sends streams 4 and 5 only when the pinned image declares `file-channel-v1` in `CoworkGuestRuntimeOffer.runtimeCapability.capabilities`. An older guest relay refuses stream 4 as `bad_field`, which would end its stream. That makes this an additive capability, not a mux version bump |
| **IN accounting (a correction to #91's recommendation)** | **Two counters, not one.** The runtime IN rule (at most 1 MiB with no OUT or ERR payload byte since) stays exactly as it is: only OUT and ERR bytes clear it, and FILE_IN bytes do not join it. FILE_IN gets its own bound: at most 4 outstanding requests of at most 16 KiB (64 KiB), cleared request by request when the response line's newline arrives on FILE_OUT. FILE_OUT bytes never clear the runtime counter |
| Vectors | `mux-frames.json`: positives for stream 4 down and stream 5 up (bytes and end); negatives for stream 4 up and stream 5 down (`bad_direction`), stream 6 (`bad_field`) and streams 4 and 5 on conversation 1 (`bad_field`). **`runtime-stream-four` changes its expected error from `bad_field` to `bad_direction`** (it travels up), so every copy must be re-pinned. `runtime-flow.json`: cases showing that FILE_OUT bytes do not clear the runtime IN counter, and that the fifth outstanding file request is refused |
| `native/protocol.ts` | `COWORK_NATIVE_RUNTIME_STREAMS` gains `file_in` and `file_out`; the direction rule; the conversation-0 rule; `CoworkNativeRuntimeStreams` tracks the two end states and the separate file counter; `COWORK_NATIVE_LIMITS` gains `fileInFlightRequests: 4` and `fileRequestBytes: 16384` (the channel's own literals, pinned equal by a test) |
| `native/host.ts` (S7B) | route `file_out` to the incarnation's `CoworkGuestFileStreamLink`; send `file_in` from it; end both on stop or fault |

**Why two counters.** The guest relay gives FILE_IN its own small ring (4b.3) and keeps its 4 MiB ring for runtime IN.

Suppose one counter served both, and any FILE_OUT byte cleared it. Then a busy file service would "prove" the runtime was reading while the runtime's 4 MiB ring was in fact filling. Four such cycles would overflow it, and an overflow stops the whole guest (contract section 6.2).

With separate counters, each stream's own reader is the only proof of its own progress.

**Does the worker or the launcher change? Source no; pinned test fixtures yes.**
- **The worker** never reads a runtime payload (`Mux.c`: "bootstrap and runtime: blind by design"). But its test carries a byte-for-byte copy of `mux-frames.json`:
  - pinned by SHA-256 in `Tests/fixtures/PINS.json`;
  - `MUX_VECTOR_COUNT == 145` in `Tests/test_mux.c`;
  - a `relayBlind` name list whose members must pass the header check.

  The re-pin (FC2) updates the copy, the hash, the count and the `relayBlind` list: every new stream vector is payload-level, so the worker passes it through. `gen_vectors.py` regenerates `vectors.h`. No `Sources/` change.
- **The launcher** reads only the 16-byte header (`Wire/Mux.swift`: "The launcher RELAYS BLIND"). Its `Tests/LauncherCoreTests/Vectors/` copy, `PINS.json` and the counts in `GoldenVectorTests.swift` are re-pinned the same way. No `Sources/` change.
- **The guest relay DOES parse the stream byte** (`common/wmx.c` `wmx_parse_runtime_payload` refuses `stream > ERR`), so it changes in code (FC3).

### 4b.3 (b) The guest-side file service

**Where it runs.**
- The relay is winter's (`apple/Cowork/WinterCoworkGuest/relay/relay.c`), not the SDK's. It owns the port and routes the streams.
- The service is the SDK supervisor's (`linux-supervisor.py`), which owns roots, identities and compartments.
- The path walk runs in a compartmented helper: the SDK's `file-worker.c`, gaining two operations.

**Relay (winter, FC3).**
- Stream 4 frames (conversation 0, after `G`) go into a separate FILE_IN ring of 256 KiB. That is four times the 64 KiB bound, the same safety factor as the runtime ring, and is held by a `_Static_assert`.
- The ring drains to a FILE_IN FIFO. A frame that would overflow it is `oversize`, which ends the stream, exactly as for the runtime ring.
- A FILE_OUT FIFO is read into stream 5 frames, in chunks of at most 64 KiB.
- It is read only under the same upstream reserve gate (`RUNTIME_GATE`) as OUT and ERR, so `drain_ack`, `halting` and `fault` always fit.
- It is serviced round-robin with OUT, so a large read cannot starve a turn's output.
- PID 1 creates the two FIFOs (anonymous pipes, root-owned, one link) and passes them as `--file-channel-fds IN,OUT` beside `--runtime-ports-fds`. The supervisor checks them like `RuntimeDuplexPorts` (`S_ISFIFO`, owner, access mode, distinct inodes).

**Service (SDK supervisor, FC4).**
- A thread started after the supervisor's ready line. It handles at most 4 requests at once and stops reading FILE_IN while 4 are unanswered.
- Each request line (at most 16 KiB) is parsed by a strict Python port of `parseCoworkGuestFileRequest`. That means the same key tables, bounds, ID grammar, path rules (4096 bytes, 32 components, 255 per component; no absolute path, no `.` or `..` or empty component, no control characters) and canonical spelling. A drift test compares its literals with winter's (copied JSON tables, hash-pinned, as the native vectors are).
- Binding checks against the trusted config (#91 section 4):
  - `workspaceId` and `sessionId` must name a delivered conversation;
  - `incarnationId` must equal the set's, else `stale_file`;
  - `locationId` must equal one of that conversation's root `id`s exactly;
  - `sourceRevision` is echoed, never checked (it is a host fence).
- For each request the supervisor launches the file worker in a **browse compartment**:
  - a dedicated per-workspace **browse uid**, distinct from every runtime, tool and group id, never the tool uid (#91). It is a set-level value (one per workspace), so the conversation set carries it beside the conversations, and every distinctness rule extends to it: `native/protocol.ts:489-490`, the supervisor's identity checks (`linux-supervisor.py:852,861,1171`), and DOOR's allocation table (L7: never reused while files it could own remain);
  - its one group is the workspace group (`setgroups(1, &workspaceGid)`, exactly as the tool compartment does at `linux-tool-compartment.c:258`);
  - a private mount view of only that conversation's admitted roots, every one bound **read-only** whatever the policy, with no `.winter` tree, no run homes, no sockets and no provider socket;
  - `no_new_privs`, and the shared `install_filter` seccomp filter, which already denies `open_by_handle_at` and `name_to_handle_at` (`linux-compartment.h:78`). Browse mode must use that same filter, and a mutation test removes those two DENY entries and expects a test that calls them in browse mode to fail;
  - **no capability at all (owner, O14).** The capability set is cleared as for the tool compartment (`linux-tool-compartment.c:263`), so the worker's existing empty-set self-check applies unchanged.
  - **How it reads other members' files.** Group permission, not privilege. Every admitted root on the data volume is created by PID 1 or the supervisor owned by `root:workspaceGid` with mode `2770` (setgid, so new files and directories inherit the workspace group), and every tool compartment already writes with `umask(0002)` (`linux-tool-compartment.c:264`), so files are group-readable by default. Nothing creates a setgid root today (no `S_ISGID` anywhere in the supervisor), so that is new work in FC4 and the guest lane (FC3, PID 1's `/workspace/repos` and scratch skeleton). A file a tool deliberately made `0600` stays unreadable to the browser; that is accepted (owner), and it answers `file_unavailable`.
  - The existing compartment launcher gains a `browse` mode with the browse uid, the workspace group and the read-only view.
- The service writes exactly one canonical response line per request:
  - the echo of every binding field, `requestId` and `op`;
  - `kind: "file"`;
  - `bytes`;
  - the `generation`;
  - for reads: `offset`, `nextOffset`, `eof` (true exactly at the end), `contentBase64` and `encoding: "base64"`.

  Its lines never interleave, are at most 384 KiB, and are written to FILE_OUT in pieces of at most 256 KiB.

**The path walk (file worker, new `stat` and `browse-read` operations).**

1. `root = openat2(AT_FDCWD, guestPath, {O_PATH|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC, RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS})`. There is no `RESOLVE_NO_XDEV` here: `/workspace` is itself a mount, so that open would always fail.
2. **Root-device check:** `fstatfs(root).f_type == EXT4_SUPER_MAGIC`, and `fstat(root).st_dev` equals the data volume's device, which PID 1 passes to the service from its own mount of `/workspace`. Otherwise `file_unavailable`. This is what keeps a share root (a virtiofs mount point, so the root fd is ON the FUSE mount) out of the channel; `RESOLVE_NO_XDEV` in the next step only refuses crossings below the root.
3. `file = openat2(root, relativePath, {O_RDONLY|O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC, RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS|RESOLVE_NO_XDEV})`. This is the kernel-enforced form of a component-by-component `O_NOFOLLOW` walk: any symlink in any component, any `..` escape, any mount crossing and any magic link is refused.
4. `fstat`:
   - it must be `S_ISREG`;
   - `st_nlink == 1` (defence in depth: the browser has no capability, so a link only reaches what its group could read anyway, but refusing aliases keeps the reply's identity unambiguous and keeps the rule correct if the browser's identity ever widens);
   - `st_dev` must equal the root's.

   PID 1 also sets `fs.protected_hardlinks=1`, so a tool cannot even create a link to a file it cannot write.
5. `generation` = lowercase hex SHA-256 of `"v1|" incarnationId "|" dev "|" ino "|" size "|" mtime_ns "|" ctime_ns "|" mode "|" nlink "|" uid`. It is opaque to the host (64 hex, the channel's grammar), and bound to the incarnation, so a token never carries across a boot.
6. A read compares the request's `expectedGeneration` first (mismatch → `stale_file`), then `pread(offset, min(maxBytes, size − offset))`, then `fstat` again:
   - changed generation → `stale_file`;
   - size now below the bytes promised → `file_incomplete`.
7. The worker never returns a guest path; the reply echoes the relative path only.

**Error codes (the channel's six, and nothing else).**

| Condition | Code |
| --- | --- |
| A well-formed line whose values are out of range (`maxBytes` outside 1 to 262,144, `offset` beyond the file) | `invalid_request` |
| A line too broken to echo (not JSON, no `requestId`, over 16 KiB) | no reply: the service ends FILE_OUT. #91's port then fails closed (`file_unavailable` for every call), so a slot can never leak. The host port parses every line before sending, so this needs a host bug |
| `ENOENT`, `ENOTDIR` on a component | `file_missing` |
| A root not on the data volume (a share root), a symlink anywhere (`ELOOP`), a mount crossing (`EXDEV`), not a regular file, `st_nlink > 1`, `EACCES`, an unknown `locationId`, a `workspaceId`/`sessionId` that is not delivered, the browse compartment unavailable | `file_unavailable` |
| `incarnationId` differs, `expectedGeneration` differs, the file changed during the read | `stale_file` |
| The file shrank under the read | `file_incomplete` |
| A response line that would pass 384 KiB (unreachable with `maxBytes` at most 256 KiB, kept as a guard) | `response_too_large` |

Never `authority_denied`: revocation is a host fact (channel note).

**Drain.** On `drain` PID 1 closes the service's FILE_IN first. The service finishes the line in progress, writes nothing more, closes FILE_OUT and exits. The relay frames FILE_OUT's end flag before `halting`, and nothing is answered after `drain_ack`.

### 4b.4 Threat analysis (file channel)

| # | Threat | Mitigation |
| --- | --- | --- |
| F1 | A tool plants a symlink or hard link so the browser reads a protected file (another conversation's store, a run home, the trusted config) | the browser has no capability, so it reads only what the workspace group may read; the mount view holds only the conversation's admitted roots, read-only; the root-device check; `RESOLVE_NO_SYMLINKS`, `RESOLVE_BENEATH`, `RESOLVE_NO_XDEV`; `nlink == 1` (defence in depth); `fs.protected_hardlinks=1`; `open_by_handle_at` denied; the browse uid owns nothing |
| F2 | The browser writes or executes | read-only view, `O_RDONLY`, seccomp without write or exec syscalls on files, no capability |
| F3 | A tool tampers with the browser (ptrace, signals) | a separate uid and its own PID namespace per launch |
| F4 | A flood of requests or huge reads starves turns or overflows a ring | 4 outstanding requests; separate FILE_IN ring and counter; FILE_OUT under the reserve gate, round-robin with OUT |
| F5 | The guest forges replies (wrong scope, generation or length) | #91's port and the channel parser judge every reply; any unattributable line closes the port |
| F6 | A guest path reaches a Mac filesystem API | never: the host maps `locationId` to a share or to the channel, and a guest path never leaves the guest (#91 section 4) |
| F7 | The same bytes are read through two paths with different views | 4b.1's one-reader rule, held by three checks: the root-device check (only data-volume roots), `RESOLVE_NO_XDEV` below the root, and the host's location mapping |

### 4b.5 Files and slices (file channel)

| Slice | What | Repo and files | Size | Depends on | Owner lane |
| --- | --- | --- | --- | --- | --- |
| FC1 | Contract: streams 4 and 5, the direction, conversation-0 and end rules, two IN counters, the capability gate, vectors (`mux-frames.json`, `runtime-flow.json`) | winter: `docs/cowork-native-worker.md` section 6.2, `native/protocol.ts`, `test/cowork/native/vectors/*`, `test/cowork/native/protocol.test.ts` | S–M | none (joins the SH1 + CR1 contract PR) | contract owner (S7B) |
| FC2 | Re-pin the vector copies (no source change) | winter: `apple/Cowork/WinterCoworkHVFWorker/Tests/{fixtures/mux-frames.json,fixtures/runtime-flow.json,fixtures/PINS.json,test_mux.c,gen_vectors.py output}`; `apple/Cowork/WinterCoworkLauncher/Tests/LauncherCoreTests/{Vectors/*,GoldenVectorTests.swift}` | S | FC1 | worker, launcher lanes |
| FC3 | Guest relay: stream routing, FILE_IN ring, FILE_OUT gate and fairness, PID 1 FIFOs and `--file-channel-fds`, the drain order, `protected_hardlinks` | winter: `apple/Cowork/WinterCoworkGuest/{relay/relay.c,common/wmx.c,common/wmx.h,init/boot.c,init/init_linux.c,vectors/*,tests/test_relay.py}` | M | FC1 | N2 guest lane |
| FC4 | SDK file service and browse compartment: request parser with a drift test, binding checks, the `browse` mode, file worker `stat` and `browse-read`, canonical responses, drain | agent SDK: `packages/runtime/src/guest/{linux-supervisor.py,file-worker.c,linux-tool-compartment.c,linux-compartment.h}` and tests | M–L | none to start (the grammar is merged); final wire after FC1 | SDK lane |
| FC5 | Host routing and composition | winter: `native/host.ts` (S7B); `cowork/session-ports.ts` `files` link and the authority composition (DOOR); #91 merges | S–M | FC1, #91 | S7B, DOOR |

## 5. Combined order

| Wave | Slices (in parallel inside a wave) | Why this order |
| --- | --- | --- |
| A, now | SH1 + CR1 + FC1 (one contract PR, text version 3); SH2 (long pole, independent review); CR2, GM1, GM2, FC4 (agent SDK, separate draft PRs into SDK main) | no dependencies; the SDK and libkrun work is the longest |
| B | SH3, SH4, SH5, SH6, SH7; FC2 (re-pin the vector copies), FC3 (guest relay), FC5 (host routing, once #91 merges) | they all code against the contract PR |
| C | CR3, CR4 (with DOOR D3/D4), CR5 | needs CR1 and CR2; CR4 waits for the instructions share (SH6) and the guided profile before activation (O8) |
| D | GM3, GM4 | needs GM2 released and pinned, #83 and #84 merged, DOOR D3 |
| E | MC; CR6 if chosen | after CR4 |
| Gates | G0-S after SH3; G1-F after FC2–FC5; G4-S after SH2–SH6; G7 and G8 in the end-of-arc live gate batch (owner, 2026-10-19), after SH2–SH7 and wave C; G9 after D and MC | each needs a review of the exact commit and the owner's approval |

No slice is waiting on an owner decision: D10 is lifted, D7 places SH2 in the winter repo's patch queue, and the M6 policy is R15–R17 (all 2026-10-19). Shares and cold resume are built now, not only designed.

The SDK image re-pin happens once, after CR2, GM1, GM2 and FC4. It collects every SDK change, so the guest image is rebuilt one time (an image build is an owner-approved run).

## 6. Gates added to G0–G6

None of these is run by an agent. Each needs a review of the exact commit, the owner's approval, and a disposable `WINTER_HOME` with no credentials.

| Gate | Exact run | What it proves |
| --- | --- | --- |
| **G0-S** (amends G0) | `--sandbox-check` of the production worker with two share parameters (one `ro`, one `rw`) on disposable fixture folders, plus a protected fixture | reads inside both shares; writes inside `rw` only; denial outside, of `/.vol/...` spellings, of xattr and setugid writes, and in a protected subtree; firmlink spelling behaviour; whether the operation names in 2.4 suffice; no VM starts |
| **G1-S** (amends G1) | G1's sequence with the three Winter shares and one folder fixture | inventory check, mounts, `shares_mounted`, alias, the drain unmounts the shares before `halting` |
| **G1-F** (amends G1) | G1's sequence plus file-channel reads of a cloned-repo fixture: `stat`, whole `read` and `readRange` across chunk sizes; a tool-planted symlink, hard link, FIFO and an out-of-root `..`; a read through a folder or outputs root (must be refused by the root-device check), and a bind or nested mount below a repo root (refused by `RESOLVE_NO_XDEV`); a file changed mid-read; four outstanding plus a fifth; a drain mid-read | the guest service's walk and codes in a real kernel; that FILE_OUT never clears the runtime counter (a stalled runtime with an active browser keeps its ring bounded); the drain order (FILE_OUT end before `halting`) |
| **G2-S/M** (amends G2) | forged L1 `shares` lines (wrong identity, nested paths, too many fds, a fd that is not a directory), a forged argv, a second revoke, a `share_revoke` for an unknown tag, a worker that never answers `share_revoked`; forged `host_input_*` frames and answers, a stale hold token; a `host_input_*` frame to a runtime without `held-input-v1` (must not be sent) | the launcher and the worker refuse; nothing is mounted; the daemon stops fail-closed after 2 s without `share_revoked`; the guest refuses foreign ids and answers `superseded` to an old token |
| **G4-S** (amends G4) | the three-cycle reclaim on ext4 PLUS sustained share I/O on every device at the production profile | reclaim holds with fs devices registered; the pin high-water stays under the re-sized budget; no exit 77 |
| **G7** (new; end-of-arc batch) | a hostile-guest share suite: a test-only guest tool image issues raw FUSE requests (`..`, `/`, absolute and dangling links, mknod, `setupmapping`, an unlisted opcode, the xattr family, cross-share link and rename, handle exhaustion, a two-link file on a Winter share); a Mac-side mutator renames and swaps directories during resolution; **the user renames or moves a granted folder while the workspace runs, and between runs** (the descriptor keeps serving the moved folder until restart; the next start refuses on the grant's identity and path check, or follows the bookmark); host-read-only exports re-mounted writable in the guest; the revoke switch mid-read and `share_revoked`; R15: a guest hook write, each risky config key through `git config`, an include, a hooks directory renamed in, a rebuilt `.git` and a forged gitfile; a clone, `git worktree add` and a submodule update into a read-write folder succeed, and the host's git then runs no guest-written program; R16: Gatekeeper on a guest-made binary, script and app bundle; `.envrc` with direnv and a guest-changed `.vscode/tasks.json` in a trusted VS Code folder (T18, T19); TCC on Documents and Desktop, an iCloud Drive folder and a removable volume; case-insensitivity and many-small-file timing | confinement against a hostile guest; three-layer RO ("a denial behind a guest RO bind proves only guest enforcement"); immediate cutoff; the git and quarantine rules; folder rename behaviour; the TCC attribution |
| **G8** (new; end-of-arc batch) | conversation turn, Class A stop, resume of the same conversation; a stop between the first set and the first completed turn (`either`); the idle cold stop and the per-turn bound with an open card; `kill -9` of the worker mid-turn, then Recover (or a host reboot), then resume with interrupted-history repair; a reformatted data volume; a stale-epoch callback; a wake/stop race | transcript and subagent continuity after a real VM restart; L1–L9; refusal on data loss; exactly one incarnation. A model-driven `SendMessage` to a resumed child needs section 10 |
| **G9** (new) | two Project conversations (needs MC); `SendMessage` and `ListAgents` from the guest; revoke between hold and ack, then re-grant; host SIGKILL after ack and before commit; a guest SIGKILL between the commit journal and the transcript append; a TaskStop clear while a committed input waits; AskUserQuestion answered from the Mac and the phone; TaskCreate/List | the coordinator's case delivers nothing and then exactly once; the reconciliation commits exactly once; question cards. Model-driven tool calls need section 10 |

## 7. Spec gaps, each with a recommendation

| # | Gap | Recommendation |
| --- | --- | --- |
| X1 | The spec and the execution contracts describe shares in VZ terms (`VZMultipleDirectoryShare`, VZ `EACCES`, VZ live share replacement). The selected backend is libkrun, whose virtio-fs is unconfined by its own statement. | Restate the share contract for the libkrun confined server (2.3) and record that libkrun has no hotplug. |
| X2 | "Use a live share update ... when the backend supports and validates it": libkrun cannot. | Every source addition is a pending restart at a safe boundary. Ship it after cold resume (O6), so a restart does not end the conversation. |
| X3 | "Validate macOS access for the actual signed worker/share accessor" has no mechanism. | Daemon-opened root descriptors (2.4); measure the attribution at G7. |
| X4 | Grants that contain Winter's own control storage, or that sit inside it: the spec says "refuse grants whose required exclusions cannot be enforced". | Refuse in both directions (O5, owner): a grant containing a protected root, and a grant inside the Winter home or the coordination directory (`SharePolicy.swift:116,125` ported to SH5). |
| X5 | The memory share has no admitted tool view in the host-query profile: both SDK root checks (`assertLinuxHostQueryRoots`, and `host_query_config` at `linux-supervisor.py:330`) refuse every `/workspace/.winter` root, while the native contract allows `/workspace/.winter/memory`. | Admit exactly `/workspace/.winter/memory` in both, together, when the memory share is present (SH6b). |
| X6 | The supervisor's wall-clock `timeoutMs` (at most 10 minutes) contradicts long-lived Cowork conversations, and kills mid-turn. | O7 (owner): no 600 s cap for host-query, replaced by a 2 h host per-turn bound (paused while a card is open), DOOR's two-minute idle cold stop, and a 24 h guest backstop; relaunch in place only for crashes. |
| X7 | Stable guest uids per conversation are not specified, but `data.ext4` file and store ownership depend on them. | Record `runtimeUid`/`toolUid` per binding on the host (L7). |
| X8 | "On parent or child resume, load current workspace guidance before the first model request" cannot hold in `host-query-v1` (DOOR G3). | Activate cold resume together with the guided profile and the instructions share (O8). Build it behind the refusal now. |
| X9 | Durability of the Task\* graph across cold stop is not stated. It is in memory in the SDK, and so lost. | Accept parity with Code for v1 and document it. Persisting the graph in the store is a later SDK option. |
| X10 | Same-Project messaging and concurrent Project conversations need more than one host-query conversation per guest (DOOR G5). | O12: a separate contract slice (4.7). Until then, guest-sent peer messages are honestly `queued`. |
| X11 | The ledger's ack is the commit point, but the host path pushes before the ack (#83 review), and pruning can make a held input's verdict unknowable. | Two-phase hold, ack, then token-exact commit or discard; "committed" made durable through the journal and the transcript; verdict before any discard after an untyped ack throw; terminal `unknown_input`; tombstones until confirmed; the prune guard (4.5). |
| X12 | Mode bits on user files: guest modes would apply verbatim (0777, setuid). | Host mask `~0o022`, no special bits (R7). |
| X13 | Host path disclosure: existing links in user folders show the user's home path and name to the guest and the model. | Document as a residual; do not rewrite link text. |
| X14 | DAX is not mentioned anywhere. | Off in v1 at four points (R6). |
| X15 | Previous-boot termination evidence for the SDK store lease has no producer (the guest cannot know). | The host-attested `endedGuestBoots` (3.2, L6). |
| X16 | The spec wants both host-backed shares and a guest file channel, but does not say which serves which location. | One reader per location (4b.1): shares for folders, guidance, memory and outputs; the channel for `data.ext4`-only locations. This is enforced by the guest's root-device check, `RESOLVE_NO_XDEV` below the root, and the host's location mapping. |
| X17 | #91 recommends one IN counter for runtime and file streams. That can let a busy file service mask a stalled runtime and overflow the guest's runtime ring. | Two counters (4b.2). |
| X18 | The file channel refuses hard-linked files (`nlink > 1`), so files that package managers hard-link (for example a pnpm store) are not browsable; and files a tool made `0600` are not browsable either (O14). | Accept both in v1. The browser has no capability, so the link refusal is defence in depth, not the boundary: it keeps each reply's file identity unambiguous. Revisit the link rule only if users need to browse package stores. |
| X19 | Host-executed configuration written by the guest into read-write folders (git hooks and config, `.envrc`, IDE tasks) and missing quarantine on guest-made executables are not mentioned. Writable folder sources make the guest an author of files the Mac later runs. | The owner's policy (M6, 2026-10-19): block git hooks and risky git config keys (R15), quarantine-tag every guest-created file on read-write shares (R16), report watched auto-run files (R15, T18, T19), and mark guest-writable folders in the UI (R17). |
| X20 | The store's freshness has two definitions: the supervisor's directory emptiness and DOOR's completed-turn rule. They disagree after a run that reached `runtime_ready` but finished no turn. | The four-state `store_state` with the `either` continuation (3.2). |

## 8. NEEDS FROM OTHER LANE

| Lane | Need |
| --- | --- |
| Contract owner (S7B; owner of `docs/cowork-native-worker.md` and `native/protocol.ts`, confirmed by the coordinator 2026-10-19) | Text version 3 for SH1 and CR1: L1 `shares` (rights allowed on `volumes` and `shares`) and `share_revoke`, the refusal `shares_rejected`; L2 kinds 6 `shares` and 7 `share_revoke`; statuses `share_revoked{tag}` and `share_notice{tag, kind}` on L2 and L1; worker argv `--shares-v1`; bootstrap `shares`, `shares_mounted`, faults `share_inventory`, `share_mount_failed`, `resume_store_missing`, `fresh_store_not_empty`; conversation `runtime.continuation` (`fresh`, `resume`, `either`) and `runtime.endedGuestBoots`, and the `continuation` echo on `runtime_ready`; the set-level browse uid and its distinctness rule (extending `protocol.ts:489-490`); the `held-input-v1` runtime capability; vectors. Optionally `runtime_relaunch` (CR6). |
| S7B (`native/host.ts`) | Send `shares` before `begin` and `share_revoke` on revocation; report the cutoff on `share_revoked{tag}` and stop fail-closed when it has not arrived within 2 s; relay `share_notice`; wait for `shares_mounted` before `conversations`; durably record `(workspaceId, incarnationId, leaseEpoch, guestBootId)` at `hello` and keep it after release; build `endedGuestBoots` from released incarnations; send the stored `expectedFilesystemUUID` in every `probe-existing` plan and map `filesystem_mismatch` to `lost`. |
| DOOR (`cowork/schema.ts`, migration 18 or later) | Table definitions, sent here rather than built: `cowork_conversations` gains `runtime_uid`, `tool_uid` (allocated once at bind, distinct per workspace), `store_state` (`none`, `started`, `created`, `lost`), `last_incarnation_id`. `cowork_workspaces` gains `store_volume_uuid` and `browse_uid`. A new `cowork_guest_uids(workspace_id, uid, role, session_id NULL, retired_at NULL, released_at NULL)` allocation table: a uid is never reused until its owner's files are proven removed (L7). A new `cowork_guest_boots(workspace_id, incarnation_id, lease_epoch, guest_boot_id, recorded_at, ended_proof NULL, ended_at NULL)`. The `peer_inbox` record gains `offer_count`, `acked_hold_token NULL`, `commit_confirmed_at NULL` and `commit_outcome NULL`. |
| DOOR (`repository.ts`, driver) | Call `acknowledgeSource(epoch, sourceId, revision, "ready")` at `shares_mounted`. The resume branch of `ensure` (3.2), with the four-state `store_state`. The O7 bounds: the 2 h per-turn bound paused while a card is open, and the two-minute idle cold stop once CR4 ships. `hostMessaging` bound to `handlerFor(binding.sessionId, incarnation)`. `holdInput(id, token, epoch, text)`, `commitInput(id, token)`, `discardInput(id, token)` and `forgetInput(id, token)` on the Cowork `MessagingDriverHandle`, sent only to a `held-input-v1` runtime. `coworkEpoch` published only after the runtime-start reconciliation has finished (4.5, rule 1). The projector consumes `system/host_input_committed`, the `lost` disposition note, and `share_notice`. The guest-writable marker (R17). `COWORK_GUEST_PROFILE_TOOLS` grows to GM1's set once the pinned image carries it. |
| PEER-INBOX (`agent/session-messaging.ts`, `cowork/peer-inbox.ts`) | `drainOnce` for a Cowork recipient (4.5): first re-commit `deliveredUnconfirmed` oldest first with `ackedHoldToken`, treating `unknown_input` as terminal (`lost`, surfaced, never retried); then `offer`, `holdInput`, `ack` with the hold token, then `commitInput(receiptId, token)`. On `authority_denied` or `stale_acknowledgment` discard; on any other ack throw read `verdict()` first and commit or discard from it; if that also throws, decide nothing. Never `deliverInto` for a Cowork driver. Ledger `offerCount` (incremented by `offer`), `ackedHoldToken` (stored by `ack` atomically), `verdict`, `confirmCommitted(receiptId, outcome)`, `deliveredUnconfirmed`, and `prune` skipping delivered records without the mark. The TaskStop clear never removes committed peer inputs (4.3). Reconciliation at runtime start runs in the same per-recipient chain, before the driver publishes `coworkEpoch` (rule 1). |
| APPROVALS (`runtime-sdk/cowork-approval.ts`, `approval-bridge.ts`) | Class rows: ListAgents and Task\* read-only (allowed under every policy); SendMessage as `coordination` (allowed, except `plan`, where it asks). The AskUserQuestion bridge on the Cowork route with `mode: "cowork"` cards. |
| N2 guest lane | SH6 (including `init.templateDir` set to an empty root-owned directory in the image's system gitconfig, so git never creates `.git/hooks`, R15), CR3, CR5, FC3 (relay streams 4 and 5, PID 1 FIFOs, `protected_hardlinks`, setgid `root:workspaceGid` 2770 skeleton roots for repos and scratch); an image re-pin to the SDK commit carrying CR2, GM1, GM2 and FC4; the optional `CONFIG_FUSE_DAX=n` fragment at the next kernel pin. |
| libkrun lane | SH2 as patches 0024 onward in the winter repo's vendored queue (`apple/Cowork/WinterCoworkLibkrun`, owner D7), R0–R16, the computed pin budget, gate rows that keep the TSI and vsock refusals passing with shares present, with the independent review the README requires. |
| Contract owner (S7B), file channel | FC1: streams 4 and 5 in section 6.2 and `native/protocol.ts`, the direction, conversation-0 and end rules, a SEPARATE file IN counter (not #91's shared one), the `file-channel-v1` capability gate, and vectors (with `runtime-stream-four` now `bad_direction`). |
| Worker and launcher lanes | FC2: re-pin their vector copies (hashes, counts, the worker's `relayBlind` list, the launcher's `GoldenVectorTests`). No source change. |
| S7B and DOOR, file channel | FC5: `native/host.ts` routes `file_out` to and `file_in` from the incarnation's `CoworkGuestFileStreamLink`; DOOR's spine and the authority composition, as #91 lists. The composition maps a share-backed `locationId` to the host reader and never to the channel (4b.1). |
| SDK lane | CR2 (with the `either` continuation and the host-query `timeoutMs` maximum), GM1 (with its two call sites), GM2 (journal states, transcript dedupe, tokens, `held-input-v1`, `clearQueuedInput`), SH6b (the memory root in both root checks). |
| SDK lane, file channel | FC4: the supervisor file service, the `browse` compartment mode with NO capability (workspace group, the shared seccomp filter, a mutation test on its `open_by_handle_at`/`name_to_handle_at` denies), setgid `root:workspaceGid` 2770 data-volume roots, the browse uid in the supervisor's identity checks, file worker `stat` and `browse-read`, and a drift test against winter's channel literals. |

## 9. Owner decisions (each with my recommendation and the ruling)

Rulings of 2026-10-19: the owner's on D10, D7 and the M6 policy; the coordinator's on O1–O16, accepting my recommendations except where the ruling column says otherwise.

| # | Decision | My recommendation | Ruling (2026-10-19) |
| --- | --- | --- | --- |
| D10 | Shares and cold resume were out of N2's first slice | Build them as designed | **Lifted (owner).** Build both host-backed shares (the Winter-owned server, as reviewed) and cold resume now. G7 and G8 join the end-of-arc live gate batch. |
| D7 | Where the libkrun patches live | The winter repo's patch queue | **The winter repo's patch queue (owner)**, `apple/Cowork/WinterCoworkLibkrun`, patches 0024 onward. |
| M6 | Guest-written host-executed files in read-write folders | Block the dangerous writes, tag the rest, flag in UI | **Block and tag (owner).** Refuse `.git/hooks/**` writes and the risky `.git/config` keys; quarantine every guest-created file on a read-write share; the UI says when a folder is guest-writable. Enforcement: R15, R16 (server), R17 (daemon and UI); threats T17–T20. `.envrc` and IDE task files: report and tag, as recommended in T18 and T19. **Follow-up questions for the owner (do not block wave A):** (a) keep the R15 denylist (my recommendation) or switch to the stricter allowlist of keys git itself writes; (b) T17b: also refuse guest writes to an existing `core.hooksPath` directory (husky, lefthook) and in-share `include.path` targets (my recommendation), or only report them (the current text). |
| O1 | Re-enable virtio-fs at all, given libkrun's own "no protection" statement | Yes, but only as the Winter confined server (2.3) with its own independent review and G4-S. Never the stock server. | Accepted. |
| O2 | How the worker's sandbox learns the share paths | Launcher argv parameters (`--shares-v1`), from the signed launcher, checked against the received descriptors. The alternative, sandbox extension tokens, is more Apple SPI. | Accepted. |
| O3 | DAX | Off permanently in v1, at four points (R6). | Accepted. |
| O4 | Ownership semantics on host shares | `LinuxSimplified`, no guest xattrs, host mask `~0o022`, no setuid/setgid/sticky, no special files. | **Accepted, plus `O_UNIQUE`/`AT_UNIQUE` on the Winter shares** (memory, outputs, guidance). Folder sources keep hard links, with the trade-off documented (R5, T4). |
| O5 | Grants that touch a protected root | Refuse grants containing one in v1. | **Refuse in both directions:** a grant containing a protected root, and a read-write grant inside `~/.winter` (`sdk`, `settings`, `plugins`), porting `SharePolicy.swift:116,125` into SH5 (2.4). |
| O6 | Source changes while running | Restart at a safe boundary, after cold resume ships; an immediate worker-side revoke switch; "revocation complete" only after the restart. | Accepted, with M5's mechanics: L1 `share_revoke`, `share_revoked{tag}` after the device thread's own close, a 2 s fail-closed stop (R11). |
| O7 | The supervisor's 600 s wall-clock cap on host-query runtimes | Remove it for host-query profiles; relaunch in place (CR6) later, for crash recovery only. | **Remove it only together with three bounds:** a 2 h host per-turn bound (paused while a card is open), DOOR's two-minute idle cold stop (active with CR4), and a 24 h guest backstop (3.4). |
| O8 | May cold resume activate before guidance-on-resume exists | No. Build CR1–CR4 now; activate with the guided profile and the instructions share. | Accepted. |
| O9 | Stable per-conversation guest uids | Yes, recorded on the host at bind (L7). | Accepted, plus: a uid is never reused while a deleted conversation's files may remain (L7). |
| O10 | The guest tool set | Offer SendMessage, ListAgents, AskUserQuestion and TaskCreate/Get/List/Update. Withhold TaskStop and TaskOutput until guest background work and guest subagents exist. | Accepted. SendMessage asks under `plan` (4.6). |
| O11 | Peer delivery into a guest | Two-phase hold, ack, then commit or discard, plus the prune guard (4.5). | **Accepted, applying only with the M1 fixes:** committed means durably in the conversation (journal plus transcript dedupe by `inputId`), verdict before any discard after an untyped ack throw, per-hold tokens, tombstones until confirmed, terminal `unknown_input`, the `clearQueuedInput` rule, and every window in the failure table (4.3, 4.5). |
| O12 | More than one host-query conversation per guest | Yes, as a separate contract slice after CR4. | Accepted. |
| O13 | The gate stand-in for model-driven tool calls (G8, G9) | Extend the runtime-sdk stub to emit tool calls, under the same reserved stand-in selection as DOOR's O2. Otherwise those parts of G8 and G9 wait for the held provider bridge. | **Accepted, with a pin:** the stand-in must be impossible to select in production. Its selection exists only in the gate fixture's own configuration, never from settings, a model id or a provider route a user can choose; a test pins that a production `ensure` with every route and model the catalog offers never resolves to it, and that the production build refuses its selector outright. |
| O14 | The identity of the guest file browser | A per-workspace browse uid with exactly `CAP_DAC_READ_SEARCH`. | **The zero-capability alternative:** the browse uid in the workspace group, setgid `root:workspaceGid` roots, `umask(0002)` as in `linux-tool-compartment.c:258-264`, no capability. A file made `0600` stays unreadable to it (accepted). `open_by_handle_at` and `name_to_handle_at` stay denied in browse mode, held by a mutation test. The browse uid joins DOOR's NEEDS and the uid-distinctness rule (`protocol.ts:489-490`) (4b.3). |
| O15 | The IN accounting for the file streams | Separate counters (4b.2), correcting #91's single-counter recommendation. | Accepted. |
| O16 | Outputs before the outputs share | Do not route outputs through the file channel as a stopgap; ship the outputs share (SH6) before activation, so no migration is ever needed. | Accepted. |

## 10. Provider path: where I stopped

None of the three pieces carries model traffic: shares are a device, resume is a restart, and messaging uses runtime streams. Two parts of the gates still need a model that calls tools:
- G8's "SDK SendMessage continues the same child after actual process/VM restart";
- G9's model-driven `SendMessage` and `ListAgents`.

The merged runtime-sdk stub answers text only (DOOR section 5.4). A model that calls tools therefore needs one of two things:
- an extended stand-in (O13), which is a guest-side image change and no network, and which a test pins as impossible to select in production;
- the provider bridge (mux class 3), which is HELD by the owner.

I did not design or analyse the bridge. The rest of G8 and G9 (stop and resume continuity, the hold, ack and commit windows, question cards answered by a user) needs no model call beyond the stand-in's text turns.

## 11. Docs owed (for the controller's doc pass)

- `docs/claude/cowork.md`:
  - This design exists. Nothing in it is built.
  - Shares need the confined server, because libkrun's own virtio-fs is unconfined.
  - Cold resume is blocked at the five SDK points in section 1.
  - Guest messaging delivery into a guest is two-phase, with per-hold tokens.
  - Read-write folders: git hooks and risky git config keys are refused to the guest, guest-created files are quarantined, and the UI marks guest-writable folders (owner, 2026-10-19).
- `docs/cowork-status.md`, under "Still open":
  - shares (SH1–SH7) and cold resume (CR1–CR6) are designed and approved to build (D10 lifted, 2026-10-19); guest messaging (GM1–GM4) is designed; none is built yet;
  - the 600 s supervisor cap (X6, replaced by the O7 bounds) and the one-conversation limit (X10) are blockers for long and concurrent conversations.
- `docs/cowork-spec.md` and `docs/cowork-execution-contracts.md` (a later spec pass, not this lane): X1, X2, X4, X5, X12, X14 and X19.
- `docs/cowork-native-worker.md`: text version 3, after SH1, CR1 and FC1 land, by its owner. Section 6.2 gains streams 4 and 5 and the separate file IN counter.
- `docs/claude/cowork.md`, the file channel: one reader per location (shares versus channel); streams 4 and 5 are runtime-class streams on conversation 0; the guest browser is a read-only, zero-capability compartment in the workspace group that refuses symlinks, hard links and mount crossings.
