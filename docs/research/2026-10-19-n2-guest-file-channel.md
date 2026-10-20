# N2: the guest side of the file channel (FC3)

Counterpart to agent-sdk #42 (FC4, the supervisor's file service) and to contract revision 3 (#115, section 6.2 and 12). Source and tests only: no VM, no krun, nothing booted, nothing built in CI.

## 1. Gate

Everything is compiled only with `WG_FILE_CHANNEL_V1`, the build flag of an image that declares the runtime capability `file-channel-v1`. Production passes nothing, so:

* `build.py` (production profile) lists none of the new sources; `--profile file-channel` builds `init-file-channel` and `winter-guest-relay-file-channel` under their own names and refuses `--update-pins`.
* The production `init` and `winter-guest-relay` binaries are byte-identical to the pinned ones (dede7fd9... and eed3a8f2...); only their `sourceSha256` and the helper script's sha256 in `pins.json` moved.
* `test_filechannel.py::ProductionHasNoFileChannelTests` holds that every file-channel name in a production source sits inside `#ifdef WG_FILE_CHANNEL_V1`.
* The bootstrap helper speaks revision 3 only with `--file-channel-v1` (PID 1 passes it only in the gated build); without it, it is the revision-2 helper.

## 2. PID 1

* Two FIFOs, made at start: anonymous pipes, `O_NONBLOCK`, owned by PID 1 (root), single link, close-on-exec. FILE_IN (relay writes, supervisor reads) and FILE_OUT (supervisor writes, relay reads).
* The supervisor gets its two ends as the LAST two arguments: `--file-channel-fds IN,OUT` (7,8 after `--runtime-ports-fds 4,5,6`, otherwise 4,5). Before the fork it re-checks both ends (FIFO, root, one link, non-blocking); after the fork PID 1 closes both whether or not the supervisor was given them.
* Trusted config: `fileChannel: {browseUid, dataDevice}` as the last member, only for a workspace with a browse uid. `dataDevice` is `st_dev` of `/workspace`; the static part of the config may not name `fileChannel`.
* Every data-volume root (a root's `source` below `/workspace`, except the outputs and memory share mount points) is created `root:workspaceGid` mode 02770 before the supervisor starts; the directories above it are root:root 0711. FC4 refuses anything else.
* `fs.protected_hardlinks` is set to 1 at start (a write the kernel refuses stops the boot).
* The relay's go byte gains bit 1: the supervisor has a file service.
* Drain: the relay holds the only write end of FILE_IN and closes it when it receives the drain, before PID 1 hears of it; FILE_OUT's end is framed before `halting`.

## 3. Relay

Streams 4 and 5 on conversation 0 only (codec: another conversation is `bad_field`; FILE_IN up and FILE_OUT down are `bad_direction`). FILE_IN goes through its own 256 KiB ring and the file flow rule of contract v3 (`common/fileflow.c`, replayed against `runtime-flow.json` `fileCases`): at most 4 request lines outstanding, 16 KiB per request line, 384 KiB per response line, a response byte with nothing outstanding is refused; it never touches the runtime IN count. FILE_OUT is read only after `runtime_ready` was framed. FILE_IN's end closes the supervisor's side after what came before it. A response the flow rule refuses is a broken guest (exit 95), not a host violation.

## 4. Bootstrap helper and the contract copies

The three vector copies are re-pinned to PR #115 (488986e8). The helper's revision-3 vocabulary (`v` 2: `browseUid`, `continuation`, `endedGuestBoots`, `timeoutMs` up to 24 h, `continuations`, `shares`) is complete at the message level and passes every bootstrap-class vector. Behaviour is not: this guest has no shares and no resume store, so `shares` is answered with `share_inventory`, `resume` with `resume_store_missing`, `either` runs fresh and `runtime_ready.continuations` says `fresh`. The nine `shares` transcripts of `bootstrap-order.json` therefore wait for SH6. The helper hands PID 1 an extended 'C' payload (profile byte bit 7): the browse uid, per conversation its workspace gid and the `source` of each root.

## 5. Not verified here (G1 and CI)

* The Linux-only tests (`test_pid1_linux.py::FileChannelPid1Tests`, the fcpid1 mutants) are cross-compiled clean for musl and glibc and have not run; CI is their first run.
* Whether the guest kernel exposes `/proc/sys/fs/protected_hardlinks` (CONFIG_PROC_SYSCTL; `kernel/pins.json` pins CONFIG_PROC_FS only).
* Whether `st_dev` from musl `stat(2)` in PID 1 equals the Python `os.stat` value the supervisor compares (same kernel encoding; first boot).
* A root of a workspace whose conversations name different group ids ends up with the later group; the other conversation's file service then refuses it (`file_unavailable`), which fails closed.

## 6. Pins and docs owed

`pins.json`: production `sourceSha256` of both programs and the helper script's sha256 (the cpio changes, `expectedArtifact` was already stale). `docs/claude/cowork.md` and the ledgers: the guest side of the file channel exists, is image-gated and unreleased; G11 stays open until FC5 and the image re-pin.
