# Cowork N2 slice S5: the Linux guest side (PID 1, bootstrap, relay, artifact, kernel pin)

Status: **source only.** Nothing in this change booted a VM, started libkrun, ran the guest programs, mounted a filesystem,
used root, touched the network or downloaded anything. Every live gate (G0 to G6) still needs a review of the exact commit and the
owner's approval. The programs were compiled (natively on macOS with the sanitizers, and for `aarch64-linux-musl` with the pinned
Zig 0.14.1) and unit-tested; the Linux-only paths were never executed.

The contract this implements is S1's: `docs/cowork-native-worker.md`, `protocol.ts` and the golden vectors on
`cowork/n2-host-adapter` (PR #56, the controller-final review round at `e384c5c6`, which added the two BOM vectors), copied here byte for byte and pinned
by SHA-256 (`apple/Cowork/WinterCoworkGuest/vectors/`). The guest copies the contract; nothing here edits it.

## 1. What is in the change

| Path | What |
| --- | --- |
| `apple/Cowork/WinterCoworkGuest/init/` | `init_linux.c` (PID 1: plumbing and the privileged syscalls), `boot.c` (the boot/drain state machine, no I/O of its own), `mounts.c`, `skeleton.c`, `discover.c`, `ext4sb.c`, `trusted_config.c` |
| `apple/Cowork/WinterCoworkGuest/relay/relay.c` | the process that owns the virtio port |
| `apple/Cowork/WinterCoworkGuest/common/` | `wmx.c` (mux framing, control codec), `ctl.c` (private pipe framing), `ring.h` |
| `apple/Cowork/WinterCoworkGuest/bootstrap/guest_bootstrap.py` | the in-guest bootstrap (port of `spikes/cowork-filesystem-bootstrap/bootstrap.py` to block devices) |
| `apple/Cowork/WinterCoworkGuest/build.py` | offline two-pass reproducible cross-build of `init` and `winter-guest-relay` with the pinned Zig |
| `apple/Cowork/WinterCoworkGuest/vectors/` | S1's `mux-frames.json` and the pin that holds it |
| `apple/Cowork/WinterCoworkGuest/tests/`, `bootstrap/test_*.py` | native C tests, relay process tests, state-machine tests, Python tests |
| `scripts/cowork-guest-artifact/{image.py,verify.py,pins.json,test_image.py,README.md}` | the artifact: exactly one startup program, the guest files, D9, the SDK re-pin |
| `scripts/cowork-guest-artifact/kernel/` | the D6 kernel pin and recipe (unbuilt) |
| `packages/core/test/cowork/guest-boot-anti-wiring.test.ts` | nothing that ships references any of this |
| `.github/workflows/cowork-guest-boot.yml` | unprivileged CI (no root, no mount, no container, no install) |

## 2. How the guest is put together

```
kernel -> /init  (static musl, PID 1)
            |  mounts /dev /proc /sys /run /tmp, opens /dev/kmsg (fixed log codes only)
            |  finds the ONE virtio-console port and the TWO virtio-blk disks (by sysfs serial), opens the port once
            |  starts winter-guest-relay (it inherits the port; PID 1 closes its copy)  <-- the only holder of L4 from now on
            |  starts python3 -I -S -B guest_bootstrap.py --channel-fds 3,4 --data NODE:MAJ:MIN --environment NODE:MAJ:MIN
            +- event loop: relay messages, helper messages, children, the supervisor's ready line
```

All links inside the guest are pipes carrying length-prefixed messages (`common/ctl.h`), never AF_UNIX sockets: a pipe cannot carry
`SCM_RIGHTS`, so the host-side hazard "a plain `read` installs descriptors" cannot occur in the guest, and no reader needs a control
buffer. The port itself is a character device, which cannot carry descriptors either; the relay refuses any other kind of file there
(only the native test build, `-DWG_TEST_PORT_SOCKET`, accepts a socket).

**Why the relay owns the port for the whole boot, not only after `mounted`.** Two processes writing frames to one character device
tear them, and per-(class, direction) sequence numbers have one owner only if one process writes. So there is exactly one writer.
PID 1 never touches the port; it exchanges bootstrap payloads, drain requests and acknowledgements with the relay over a pipe pair.
The task brief says "the relay owns the virtio port"; the consequence is that PID 1 "receives the plan over L4" through the relay.

### Boot sequence (all of it is `boot.c` plus the helper)

1. relay: nothing is sent until PID 1 or the helper hands it a payload; `ping` is answered with `pong` at once.
2. helper sends `hello` (live boot id, the two serials) through PID 1 and the relay.
3. host `plan` -> relay -> PID 1 -> helper. The helper validates it (a port of `validFilesystemPlan` for protocol 3), admits both block
   devices (S_ISBLK, major:minor, serial, read-write, capacity, sector size, no partitions, no holders, not mounted), preflights BOTH
   volumes before the first write, formats `format-new` volumes (`mke2fs`, no `-F` on a block device), asks PID 1 for a kernel-mount
   journal replay only where the plan says `replay-journal-then-probe` and `needs_recovery` is really set, fsyncs, probes, and sends the
   nonce-bound `receipt` after checking it against its own port of `matchesFilesystemReceipt`.
4. host `ready` (must echo operation and nonce). The helper re-reads both superblocks (UUID, features, size, no pending recovery, clean),
   closes its descriptors, and asks PID 1 to mount.
5. PID 1 checks both superblocks again in C, mounts the data volume at `/workspace` and the environment volume at
   `/opt/winter/environment/disk` (`nosuid,nodev,noatime`, `noinit_itable,errors=remount-ro`), creates the protected skeleton
   (`/workspace/.winter/{conversations,scratch,memory}`, `repos`, `folders`, `outputs`; `/run/winter/{control,conversations,shared-instructions,trusted}`),
   and only then answers the helper, which sends `mounted`.
6. The supervisor starts **only when** a root-only conversation set exists (section 6, item 1). When it does, PID 1 writes the trusted config
   (live `guestBootId` spliced into the static part from the initramfs) and starts `python3 -I -S -B linux-supervisor.py --trusted-config-fd 3
   --runtime-ports-fds 4,5,6`, waits for its ready line, and sends the relay `G` (runtime frames are now delivered).

### Drain and fail-stop

`drain` -> relay -> PID 1: `drain_ack` first; close the helper's channel and give it half the budget; close the supervisor's stdin and give it
three quarters; kill everything that is left (not PID 1, not the relay, not kernel threads); `sync`; unmount (up to four attempts, killing
holders in between); **read both superblocks again and require the final unmount to have happened** (clean, no recovery); only then `halting`;
wait for the relay to confirm the host consumed it; `sync` again; `reboot(RB_POWER_OFF)`.
`halting` is therefore a claim that every filesystem this boot mounted is unmounted and verified clean. If any step fails the guest still
powers off but sends no `halting`. Fail-stop (relay or supervisor gone, protocol garbage, an out-of-order helper message) is the same
sequence with neither `drain_ack` nor `halting`: the host sees a power-off with no `halting` and must treat it as uncertain (the contract has no
control-up fault frame).

## 3. Decision D9 and the behaviour differences from `bootstrap.py`

The probe no longer calls `blkid -p`. It reads the ext4 superblock directly (magic, 4 KiB blocks, dynamic revision, 256-byte inodes, UUID,
block count, the exact required feature bits with any other bit a refusal, `needs_recovery` as the one transient bit, the metadata checksum, the
state) AND runs `dumpe2fs -h`, and the two must agree on UUID, block size, block count, features and state. The image gains no `util-linux`; `libblkid1`
stays only because `e2fsprogs` depends on it. `/sbin/dumpe2fs` joins the image's required programs; `image.py` refuses a `blkid` in the root.

Every difference from the spike (the host-side oracle), nothing omitted:

1. **Volumes are block devices.** `S_ISREG`/`st_nlink`/`st_uid`/`st_size` and the host file identity checks are replaced by `S_ISBLK`, the major:minor PID 1
   named, sysfs `serial`, `ro=0`, `size*512 == capacity`, `lseek(END) == capacity`, logical block size 512, no partition entries, no holders, absent from
   `/proc/self/mountinfo`, `O_RDWR` and not append. The plan's `identity {device, inode, uid, mode}` is the HOST file's identity: the guest echoes it in the receipt
   and cannot check it; the worker's scope digest covers it on the host.
2. **No `authenticate`/proof.** The authentication is the channel (one port, one peer, the relay its sole owner), the operation id equalling the plan's own id, the
   nonce echo, direction and type tables, and a single-shot operation.
3. **Plan validation** is a port of `volume-filesystem.ts` `validFilesystemPlan` for protocol 3 plus the spike's 16 KiB bound. It adds what the spike lacked: a prior replay debt
   may not coexist with a `format-new` volume.
4. **`blkid` removed** (above). Lost: blkid's `TYPE` classification and its detection of a second, conflicting signature. Replacement for the second: the first 1024 bytes of the device must
   be all zero (ext4 and mke2fs never write there). Added over the spike: superblock checksum, revision and inode-size checks, the `dumpe2fs`/direct-read agreement check.
5. **Virgin scan**: compares against a zero buffer (the spike's `any(chunk)` is far too slow), tells the kernel to drop what it read, and its deadline is `5 s + capacity / 128 MiB/s`
   instead of a flat 5 s (which cannot hold at production capacities); the whole-operation budget is `60 s` plus the scan allowances plus the heavy-tool allowances. Unmeasured: gate G1.
6. **`mke2fs`**: no `-F` on a block device (the single `-F` stays only for the regular files of the unit tests, via `Disk.regular_file`); stdin is `/dev/null`, so a question is a refusal. Its time limit grows with
   the volume (`20 s + capacity / 256 MiB/s`), as does `e2fsck -f -n`'s.
7. **fsync** failure is a refusal (`flush_failed`), not a crash.
8. **Journal replay** is no longer a loop device in a private mount namespace: PID 1 mounts the block device itself at `/run/winter/replay/<purpose>` (`nosuid,nodev,noexec,noatime`,
   `noinit_itable,errors=remount-ro`), `syncfs`, `umount2`, on the helper's request and only before the real mount. A replay that could not unmount is tracked and unmounted at drain.
9. **Re-checks of the descriptor's identity between steps** (the spike's `check_fixture_fd` before and after each effect) have no equivalent beyond the admission and the superblock probes.
10. **New**: a receipt self-check before sending, `verify_before_mount` after `ready` (the spike never mounts), and the mount itself.
11. **Output** is the canonical bootstrap-class message (`receipt` or a `fault` carrying only a closed code), never free text. Non-ASCII anywhere in a message is refused.
12. `e2fsck -f -n`, the check modes, the transient-feature handling and the `dumpe2fs` text parse are unchanged.

## 4. The relay, the FIFOs and the tool devices

* The relay frames and parses WMX1 (`wmx.c`): header magic/version/class/flags/seq/length in the same order as `parseCoworkNativeMuxFrame`; the provider class is refused at the header in
  both directions; sequence numbers per (class, direction) must rise by one; the control class is parsed in the one canonical spelling with the same failure categories as `protocol.ts`
  (all 15 positive and all 25 negative S1 vectors go through the C frame and control parser; five negatives are bootstrap-payload faults that the Python helper refuses with the contract's category, and the C side only checks that those frames are well formed; plus a table of corner cases). Bootstrap payloads are passed to PID 1 byte for byte (cap 20 KiB, stricter than the contract's 256 KiB; a real plan is 1.7 KiB);
  runtime payloads are opaque bytes.
* The three pipes the supervisor receives are `RuntimeDuplexPorts`-shaped: anonymous pipes (so `S_ISFIFO`, owner root, `st_nlink` 1, three distinct inodes), the supervisor's three ends non-blocking.
  Input comes from a 4 MiB queue in the relay (runtime frames that arrive before PID 1 sends `G` wait there; overflow ends the stream), stdout becomes runtime frames of at most 64 KiB, and **stderr is read and dropped**
  because the mux has no stderr stream.
* **Tool devices exclude virtio ports by construction.** The SDK's process-tool compartment mounts exactly five character devices (`null`, `zero`, `full`, `random`, `urandom`) and says it admits no
  block device, kmsg, port, vsock or `/dev` tree. `image.py` now reads that inventory from the very source it compiles and refuses the build if it is anything else (`check_tool_devices`), and the relay is
  the only process that ever holds the port (PID 1 closes its descriptor right after starting it; every descriptor in PID 1 is close-on-exec).

## 5. The artifact, the SDK re-pin and the kernel

* `image.py` allows **exactly one** startup program: `/init`, a regular `0555` file whose bytes equal the digest pinned in `pins.json` (`check_startup`); `sbin/init`, `linuxrc`, `etc/inittab` and anything
  reachable through a root alias are still refused. It builds the guest programs through `build.py` (two passes, byte-identical or refuse), holds them and the bootstrap script to the pinned digests, and adds
  `/init`, `/opt/winter/libexec/{winter-guest-relay,guest_bootstrap.py}` and `/opt/winter/etc/supervisor-base.json` (the static part of the trusted config: helper paths and digests of the exact bytes in the cpio,
  `environment`, `controlDirectory`). `verify.py` reads the cpio back and demands the same.
* `pins.json`: `sdkCommit` moved from `39ba77ec` to SDK main `093fb3ea` (it contains agent-sdk #27 and #28, `cowork/root-guided-bootstrap`; it was `7796dff9` before #28 merged). It does not contain the supervisor change of Part 2, so it must move
  again. **`expectedArtifact` is now `null`** (the old digests belong to the old SDK commit and are kept under `previousExpectedArtifact`): nothing could be rebuilt offline. `image.py` writes every output and the
  receipt and then **exits 3** with `UNPINNED`, so an unpinned artifact is never mistaken for a pinned one. `builderCommit` `180d3eff` is an ancestor of SDK main but whether that builder still compiles the 210-commit-newer
  SDK is unverified.
* The image still contains no runtime launcher, session-owner library or `hostQueryRuntime` artifacts, so the static config is tools-only; building them is outside this slice.
* **Offline readback.** A real 321 MiB pre-init candidate cpio (7,281 entries) was extended with the guest files using `image.py`'s own functions, passed `check_startup`, `refuse_blkid` and the ELF dependency
  check (both new programs are static AArch64; `/sbin/{mke2fs,e2fsck,dumpe2fs}` and `python3.11` resolve; no `blkid` and no `mount` exist in the base), was written with the repo's emitter, and read back by `verify.py`
  with `startupEntries == ["init"]` at the pinned digest. The cpio grew by 185,344 bytes. That is a scratch validation, not an artifact.
* **What the host pins.** After S1's final round `runtimeImageDigest` is the SHA-256 of the 64 bytes `SHA-256(kernel) || SHA-256(initramfs.cpio)` (each a raw 32-byte digest), with the files at
  `<worker directory>/cowork-guest/{kernel,initramfs.cpio}`. The cpio this change builds and the kernel the recipe builds are the two inputs; their output digests do not exist yet, so neither does that value.
* **Kernel (D6).** `scripts/cowork-guest-artifact/kernel/` pins a reproducible build from the cached Apple/Kata `base-apple-6.18.35.config` **without the crypto fragment**, with LLVM 20.1.8 and the same isolated offline
  builder image as the crypto comparison build; the only change from the base is `CONFIG_DEBUG_INFO_BTF=n` (the BTF step ran the builder out of memory). The base already has page poisoning and init-on-alloc/free off. The pin lists
  every symbol the build must end with (virtio console/blk/mmio/balloon, ext4, namespaces, seccomp, landlock, PL011, `BLK_DEV_WRITE_MOUNTED`) and checks the base plus the fragment against them statically. **Unbuilt, unbooted;**
  output digests are `null`. The builder scripts live on the hvf lineage (D7) and need three small edits for a fragment-less build, listed in `RECIPE.md`; they were not made.

## 6. REVIEW NEEDED: contract gaps and judgement calls

1. **No way to deliver a conversation set (headline).** The merged supervisor refuses an empty `conversations` list (`conversation_limit`), and no bootstrap-class message carries uids, gids, roots or runtime config.
   PID 1 therefore completes the boot through `mounted` and starts the supervisor only when `/run/winter/trusted/conversations.json` (root-only, size and shape checked) exists; **nothing writes it.**
   The contract needs a down message (and its acknowledgement), or the SDK must accept an empty set and admit conversations later.
2. **One runtime stream.** The runtime class has no stream id, so only one conversation's transport can be served, while `RuntimeDuplexPorts` is per `logicalSessionId`. The relay maps its one stream to one pipe triple.
3. **No stderr stream** (dropped), **no control-up fault** (a failed unmount can only withhold `halting`), and **no "runtime ready" signal** (frames wait in the relay until PID 1 starts the supervisor). The host side (S2/S3) must not
   treat a bare power-off, or a missing `halting`, as orderly.
4. **PID 1 passes `--runtime-ports-fds 4,5,6` to the supervisor.** SDK main refuses that command line (it accepts exactly `--trusted-config-fd N`); Part 2 adds it.
5. **Identity** is checked by serial and capacity, not by the host file identity (section 3, item 1).
6. **Environment disk.** Mounted at a fixed path and not consumed by anything: the SDK's `environment` root is the immutable base. How the persistent environment layers over it is unspecified.
7. **`/workspace` and the environment mount are not `noexec`** (tools build and run programs; the tool compartments re-mount their own views). `nosuid,nodev,noatime`.
8. **Virgin-scan and tool timeouts** are guesses pending G1 (section 3, items 5 and 6).
9. **The virtio-console port.** The code accepts exactly one console (`0x0003`) bound to `virtio_console` whose negotiated features are exactly VERSION_1 + MULTIPORT and exactly one port `vport<N>p0` with minor 0 (the fixture's proven
   identity). Whether the production device (S4) still matches, and whether "host not connected yet" shows as POLLHUP for as long as the code waits (30 s), is unverified until G1. The final `halting` frame is written with a blocking `write`
   because that is the only acknowledgement the virtio-console driver gives that the host consumed it; also unverified.
10. **One bootstrap per boot.** After a `fault` the guest stays up, mounts nothing and waits for the host's `drain`.
11. `previousBootTermination` (Part 2) is **not** provided by PID 1: see the SDK part below.

## 7. Independent review

A read-only reviewer read the C and Python against the contract and the supervisor and reported nineteen items; none was a blocker. Fixed: `halting` could be claimed with a replay mount or a failed rollback still mounted, or without proof
of the final unmount (now tracked and verified from the superblocks); `umask(077)` leaked into the supervisor's directories (children now get 022 and the default `SIGPIPE`); the forbidden-key check was a substring match (now structural, escapes refused);
a refused plan got no fault frame (now `bad_plan` when the message names a valid operation and nonce); a helper that died after the mount was promoted to a running guest (now a fail-stop); PID 1 writes could spin forever (bounded);
runtime frames before `G` killed the guest (queued); the relay's fatal notice could interleave with a queued message (ordered); fault-code categories; the flat 20 s tool timeout; discovery refusing non-virtio block names; the silent power-off on a
failed pseudo-filesystem mount; the unchecked `halting` flush. Documented rather than changed: items 3 and 15 of the review (the supervisor command line, the port id) and the exact-features check (item 8, section 6.9).

## 8. What the tests are, and what they cannot show

* `bootstrap/test_guest_bootstrap.py`: plan and message parsers against the pinned vectors (every bootstrap positive and negative, and the receipt rebuilt byte for byte from the vector plan), plan validation, superblock parsing against synthetic and
  real `mke2fs` output, the probe, the engine on regular-file images with a fake tool layer, admission against a fake sysfs, the session against a fake channel. A real-e2fsprogs oracle class runs only on Linux with `mke2fs`, `dumpe2fs`
  and `e2fsck` (the CI job); on a Mac it is skipped, not passed.
* `tests/test_native.py`, `test_relay.py`, `test_init_modules.py`, `test_hygiene.py`, `test_boot.c`: every vector through the C codec at every chunk size, the relay as a real process against a socketpair standing in for the port, discovery against fake sysfs trees,
  the superblock, skeleton and config modules, and the whole boot/drain state machine against a recording fake (order of calls, flags and options, every guard). Built with the address and undefined-behaviour sanitizers.
* Not exercisable offline, and therefore **not verified**: `init_linux.c` itself (it compiles for aarch64-musl with `-Wall -Wextra -Werror` and is reviewed, never run), `mount(2)`/`umount2`/`reboot`/`signalfd`, virtio-console semantics, sysfs attribute availability,
  devtmpfs timing, the replay mount, the SDK supervisor accepting the config, and the kernel. One relay test (`a_halting_the_host_could_not_take...`) needs Linux socket semantics and is skipped on macOS.
