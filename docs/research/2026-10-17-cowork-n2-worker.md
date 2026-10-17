# Cowork N2 slice S3: the production C worker

Status: source, build and VM-free tests. 2026-10-17. **No worker and no VM was run.** `winter-cowork-worker` was compiled, linked, ad-hoc signed inside a scratch directory and inspected with `codesign`, `otool`, `nm` and `strings`. It was never executed. The test binaries were executed: they use in-process socketpairs, temp files and a poisoned stand-in for the sandbox SPI. No `sandbox_init*` call, no Hypervisor.framework call, no `krun_start_enter`, no `pmset` and no signing identity were used anywhere.

Every gate G0 to G6 needs a review of the exact commit and the owner's approval first. **G0 (`--sandbox-check`) is the first run this code can safely get, and nothing here has asked for it.**

Package: `apple/Cowork/WinterCoworkHVFWorker/`. Nothing outside it and this document refers to it (pinned, see "Anti-wiring").

The contract is S1's (`docs/cowork-native-worker.md`, `packages/core/src/cowork/native/protocol.ts` and the golden vectors on `cowork/n2-host-adapter`, PR #56, head `6c1f04e8`, contract round 3, commits `abb2f361`, `7b87df80`, `1313040a`, `86a0629f` and `6c1f04e8`; the four older vector files changed after `86a0629f` only by additions, checked entry by entry). The eight vector files are pinned by SHA-256 in `Tests/fixtures/PINS.json`; a newer contract commit means re-copying them. Where the contract is silent this document says so and picks the narrowest behaviour; it does not diverge from the contract anywhere.

## 1. What is in the package

| File | What it is |
| --- | --- |
| `Sources/WorkerNative/WorkspaceWorker.c` | `main`, the VM setup, the exit hook, the console thread, the relay thread, `--sandbox-check`. The only file that calls libkrun or the sandbox. |
| `Sources/WorkerNative/Envelope.{h,c}` | The L2 envelope codec (SCOPE 512 B, VOLUMES 104 B plus two descriptors, DRAIN 28 B, STATUS 40 B, FAULT 8 B), the `recvmsg` receiver, and the outbound sender with its one sequence counter. |
| `Sources/WorkerNative/Mux.{h,c}` | The mux frame codec, the strict control-message grammar, the per-(class, direction) sequence tracker and the exact-frame stream reader. |
| `Sources/WorkerNative/OwnedStop.{h,c}` | The stop as a pure `(state, event) -> action` machine with an injected clock. |
| `Sources/WorkerNative/Relay.{h,c}` | The L2/L3/L4 pump: blind relay of bootstrap and runtime frames, termination of control frames, owner-loss watchdog, quarantine. |
| `Sources/WorkerNative/AdmittedVolumes.{h,c}` | Channel admission, the sandbox-first intake of SCOPE and VOLUMES, descriptor checks against the identity records, the advisory lock. |
| `Sources/WorkerNative/ConsoleRing.{h,c}` | Bounded console capture: a 64 KiB ring, redaction of host virtual addresses, ASCII-only output. |
| `Sources/WorkerNative/Sandbox.{h,c}` | The Seatbelt profile text and the two functions that install it and prove its denials. |
| `Sources/WorkerNative/Rights.{h,c}` | The bounded collector of `SCM_RIGHTS` descriptors both receivers use (section 4). |
| `Sources/WorkerNative/RuntimeImage.{h,c}` | `runtimeImageDigest` recomputed from the two guest artifacts, opened `O_NOFOLLOW` (section 4). |
| `Sources/WorkerNative/CoworkAbi.h` | The ONE file that knows the libkrun production ABI as the linked header declares it, with the exit-reason and flush-counter translation. |
| `Sources/WorkerNative/WorkerCommon.h` | Descriptor numbers, exit codes, limits. |
| `worker.entitlements` | Exactly `com.apple.security.hypervisor`. |
| `pins.json`, `build.py` | The pinned libkrun inputs; the offline build, test and inspection driver. |
| `Tests/*.c`, `Tests/test_guards.py` | Strict-C test binaries and the Python source guards. |
| `Tests/fixtures/` | S1's eight vector files (`envelopes`, `mux-frames`, `runtime-image`, `guest-stop`, `launcher-lines`, `stop-receipts`, and the host-side `bootstrap-order`, `runtime-flow`), byte for byte, pinned by SHA-256 with the source commit. |
| `Tests/abi/` | Four tiny sources: one exit hook with the library's type (must compile), three with another signature (must be refused). |

## 2. What changed from the fixture worker

Starting point: `workspace_fixture_worker.c`, `workspace_fd_handoff.{h,c}` and `workspace_fd_handoff_test.c` at `cowork/two-disk-fixture` 9a588735.

| Removed | How |
| --- | --- |
| The fixed argv layout | `argc` must be 1, or 2 with `--sandbox-check`. The contract says argv is exactly `[path]`; `--sandbox-check` is outside it on purpose: it is a G0-only mode that the launcher never passes, and a launcher that did would only get a worker that exits before any VM. Nothing else is read from the caller. A guard pins `argv[1]` as the only use. |
| `alarm(120)` | Gone. A long-lived guest is not timed; only a stop, an owner loss or a violation arms a deadline (section 6). A guard refuses `alarm(`. |
| The 2 vCPU / 768 MiB constants | `vcpus` and `memoryMiB` come from SCOPE and are validated against the library's production gate (section 4). A guard refuses a literal `768`. |
| The `file-write*` allow on the two disk literals | Not carried over. **That it was vestigial is an unverified premise** (the fixture's allow may be what lets `fstat`, `pread` or `pwrite` on the received descriptors work under deny-default; Seatbelt checks file operations against the vnode's path, not only at `open`). The profile has no path rule for the disks and allows no write of any kind; a test pins the exact allow list. See section 8 and the G0 I/O variant. |
| The fixture opt-ins and trace | `krun_enable_cowork_block_fixture_reclaim`, `krun_enable_cowork_runtime_port_fixture_trace`, the bootstrap stream: none is referenced. `build.py` lists every `krun_*` the worker references and refuses any outside the reviewed list; with `-Wl,-dead_strip` the final binary defines exactly 13 libkrun entry points, all referenced. |
| The sampler pipe | Gone. |

| Kept | |
| --- | --- |
| Sandbox first, then intake | `cw_intake_run` calls the sandbox hook before it reads one byte; a test proves the SCOPE datagram is still the first thing queued when the hook runs. |
| Fail-closed `_exit(79)` | On a truncated control buffer or any descriptor nobody asked for. Closes everything visible, acknowledges nothing. |
| The sandbox's own denial probes | Host file read, outbound network, an unrelated write, fork, exec; each must be refused with EPERM (a DAC refusal does not count). |
| An unnamed inherited control socket | `cw_channel_admit`: `SOCK_DGRAM` for L2, `SOCK_STREAM` for L3, both unnamed, `FD_CLOEXEC` restored, descriptor 3 or higher. |
| The device inventory | Two virtio-blk disks, one generic virtio-console port, PL011 output, empty environment, implicit console and vsock disabled. No NIC, no vsock, no GPIO shutdown device. The kernel command line is the fixture's, minus its fixture-only close marker. |

Added: the envelopes and the mux (sections 3 and 5), the advisory lock, `OwnedStop`, flush-counter plumbing for the Class A receipt, the owner-loss watchdog, bounded console capture.

## 3. Process shape

```
winter-cowork-launcher --posix_spawn--> winter-cowork-worker
   fd 3  L2  unnamed AF_UNIX SOCK_DGRAM   envelopes (SCOPE, VOLUMES, DRAIN down; STATUS, FAULT up)
   fd 4  L3  unnamed AF_UNIX SOCK_STREAM  mux frames, bootstrap and runtime classes only
   L4        the libkrun generic virtio-console port (a SOCK_STREAM peer fd the library hands back)
```

Order inside the worker: close every other descriptor and refill 0 to 2 with `/dev/null`; ignore SIGPIPE; restore `FD_CLOEXEC` on 3 and 4 and admit them; resolve the guest artifacts and make the console pipe (all before the sandbox); **install the sandbox and prove its denials, then report `sandboxed`**; read SCOPE (sequence 1), then VOLUMES (sequence 2, exactly two descriptors); check, lock, report `volumes_accepted`; point stderr at the console pipe; configure libkrun; start the relay thread; report `vm_running`; `krun_start_enter`, which never returns. Everything that must keep running (the L2/L3/L4 pump, control-frame termination, the watchdog, the console reader, every outbound STATUS and FAULT) lives on threads started before it. One mutex-protected sender owns the outbound L2 sequence counter (the relay thread and the VMM exit hook both send).

`--sandbox-check` runs the same sequence up to and including the lock, then reports `exiting` and exits 0. It never creates a libkrun context. This is gate G0.

## 4. Intake

* The S1 parser and the library gate now agree: 768 to 1024 MiB, 2 vCPUs. The floor is in the parser too (`CW_SCOPE_MIN_MEMORY_MIB`), and `_Static_assert`s in `CoworkAbi.h` tie the parser's bounds to the library's `KRUN_COWORK_PRODUCTION_*`. SCOPE is also validated against the library's constants separately, and a test proves that second check is not shadowed by the parser (it runs against a narrower gate).
* `volumes.scopeDigest` must equal the SHA-256 of the SCOPE payload exactly as received (CommonCrypto `CC_SHA256`, part of libSystem).
* **`runtimeImageDigest` is recomputed**: `SHA-256( SHA-256(kernel) || SHA-256(initramfs.cpio) )`, each inner digest the raw 32 bytes, from descriptors opened `O_RDONLY|O_NOFOLLOW|O_CLOEXEC`, regular files only, read with `pread` in 1 MiB pieces, refused above 4 GiB, and refused when the size or mtime changes while it is read. S1's golden vectors (`runtime-image.json`) pin the construction. A mismatch is `fault bad_scope`, exit 71, before VOLUMES is read. **Hash-then-load window (reported, not closed):** libkrun opens the same paths itself later (`krun_set_kernel` stats the initramfs path, `krun_start_enter` reads both), so the digest proves what was on disk when it was hashed, not what libkrun loads. The files sit in the signed bundle next to the worker and the sandbox gives the process read access only, but the window exists. **Proposal for G0:** if libkrun accepts `/dev/fd/N` paths, hand it the hashed descriptors (rewound) with `(allow file-read* (subpath "/dev/fd"))` in the profile; that would close it. Not enabled here.
* Each received descriptor is checked against its identity record with the same list libkrun's own setter applies, so a refusal is `bad_volumes` at intake: regular file, one link, owned by the effective user and by the record's uid, mode exactly 0600 (all of 07777), `O_RDWR` and not `O_APPEND`, the recorded device, inode and size. `st_dev` is read **sign-extended**, as the daemon (libuv) and libkrun (Rust `st_dev as u64`) read it. Both descriptors or neither.
* Then `flock(LOCK_EX | LOCK_NB)` on both: an extra guard, **never** release evidence. It is `flock`, not `fcntl(F_SETLK)`: a POSIX lock is dropped by any close of the file in the process, whereas a `flock` belongs to the open file description, which libkrun's duplicates keep alive. A test shows a duplicate's close does not release it.
* **Receiving descriptors (`Rights.c`).** macOS leaves `cmsg_len` at the SENDER's length when the control buffer was too small, and installs every descriptor anyway. A walk that trusts `cmsg_len` reads past the buffer and `close()`s whatever it finds (the #58 review measured 20 sent into a 16-slot buffer: `cmsg_len` 92 against a 76-byte buffer). Both receivers (`Envelope.c`, `Mux.c`) therefore call one collector that bounds every header by `msg_control + msg_controllen`, never reads outside, stores at most the capacity and closes the rest, and reports a header that claims more than the buffer holds as TRUNCATED. `MSG_CTRUNC` or a truncated header is terminal. The two checks overlap on macOS, so each survives alone as a mutant and the pair is killed (section 11); the descriptors the kernel installed but could not show cannot be closed by anyone, which is why truncation ends the process.
* **Rights policy, exactly.** SILENT `_exit(79)` (nothing is acknowledged): a truncated control buffer on L2, L3 or L4; a descriptor on SCOPE or on any envelope after intake; a descriptor on a datagram that was refused for another reason; a VOLUMES with any count but two, zero included; a descriptor on a mux stream (L3 or L4) is NOT silent: it is closed and is a mux violation (section 5). FAULT with an acknowledgement: everything that carries no descriptor problem (a bad SCOPE, a bad VOLUMES body, an identity or lock failure). The parser itself still returns `bad_rights` for a wrong descriptor count, matching the vectors; the worker maps that to the silent exit. This is stricter than contract section 5 and is the brief's rule.
* **Stray descriptors**: everything at or above 3 except L2 and L3 is closed up to `max(getdtablesize(), RLIMIT_NOFILE soft limit)`; there is no fixed cap. Descriptors 0 to 2 are refilled from `/dev/null` if closed.
* A DRAIN envelope that arrives before the VM exists (sequence 1 or 2) ends the worker cleanly: nothing was started and no disk was held. An L2 close before the VM exists is the same.

## 5. The mux

Header, per-class ceilings (control 4 KiB, bootstrap 256 KiB, runtime 1 MiB), the provider class refused at the header in both directions, and sequence continuity per (class, direction) are enforced at both hops. A stream reader reads exactly one frame at a time and never past its end, and judges the header the moment its 16 bytes are in, so an oversized or reserved frame is refused before any payload is buffered.

* **Control** frames terminate at the worker. A control frame arriving on L3 is a violation; from the guest it is parsed with a fixed grammar (keys in the contract's order, no whitespace, no escapes, canonical integers) and then re-encoded and compared byte for byte, as the contract prescribes.
* **Bootstrap and runtime are relayed blind**: header and sequence only. Five S1 negative vectors are refused by the TypeScript parser for their *payload* and are **passed through** by the worker, on purpose, and the C test asserts exactly that: `plan-protocol-2`, `plan-unsorted-nested-keys`, `hello-wrong-serial`, `bootstrap-invalid-utf8`, `plan-travelling-up`. A mutant that adds any payload check to the worker fails that assertion. The first bootstrap frame from the guest reports `guest_hello` without being read.
* **A violation ends the stream, not the VM.** `fault mux_violation`, both mux directions stop being read, frames already validated finish, the worker's own control frames (a drain) still flow, and if nobody stops the VM within 30 s the worker ends itself (exit 74).
* **Round 3, runtime streams.** A runtime payload is a 4 byte prefix {conversation, stream IN/OUT/ERR, end flag, 0} and then the stream's bytes, with at most one host-query conversation per guest. The contract puts the prefix in the PAYLOAD and says launcher and worker relay runtime frames without reading them, so **the worker neither validates nor rewrites it**: the TypeScript endpoints are the validators, and a test sends a valid prefix for each stream, an end flag and a garbage prefix and requires all three to arrive byte for byte. The bootstrap `conversations` (at most 20,480 bytes, guest-local), `runtime_ready` and the three new bootstrap fault codes are bootstrap payloads and likewise pass through (78 relay-blind negatives from round 3 are pinned in `PINS.json`, 4 of them added by contract 6c1f04e8). Frames of the runtime class are delivered only after `runtime_ready`: that is the launcher's rule, not the worker's. The environment disk is not mounted in N2; nothing in the worker changes for that. **Runtime IN flow control** (contract 6c1f04e8: at most 1 MiB of runtime IN payload in flight with no OUT or ERR byte since, applied by the host and the guest) needs nothing from the worker: it relays runtime frames blind, adds no buffering beyond one frame per direction, and a test relays frames of every stream kind and a garbage prefix untouched; `runtime-flow.json` and `bootstrap-order.json` are host-side and are pinned and carried only so a drift is caught.
* The control-up **`fault`** `{"v":1,"t":"fault","code":<unmount_failed|supervisor_lost|protocol_violation|internal>,"stopNonce":<nonce|null>}` IS the worker's: parsed with the same fixed grammar and the same re-encode compare as the other control messages, up only (a `fault` travelling down is `unknown_type`).
* A **descriptor on a mux stream** is closed and is a violation; a truncated control buffer there is `exit 79`.

## 6. Stop, owner loss and the watchdog

`OwnedStop` is a pure machine. Two things start a stop: a DRAIN envelope from the launcher (`host-stop`, or the launcher's own `owner-loss`), and the worker's own owner-loss path.

* DRAIN: the worker queues a control `drain {stopNonce, budgetMs, origin}` toward the guest and reports `draining`. The guest must answer `drain_ack` with **that** nonce (reported as `drain_acked`) and then `halting` with that nonce; any other order, nonce or an unsolicited message is a violation. A second DRAIN (any nonce, including while the worker's own owner-loss drain is running) is answered with `fault second_drain` (code 8) and **ignored**: the first nonce and budget stand and a later one can neither replace nor extend them. A test sends a second DRAIN with a larger budget and checks the deadline did not move.
* Power-off: the VMM exit hook (`void (*)(void *user, uint32_t reason)`; the reason is compared only through the header's named constant `KRUN_COWORK_EXIT_OFF`) reports `guest_halted` with the flush counters, then `exiting`. **`guest_halted` is withheld (a `fault vm_failed` plus the real counters on `exiting`) whenever the final flush is uncertain**: reason NONE, reset, vcpu error, terminal fault or unknown; no counters (or counters of another size or device count); the final flush not both attempted and completed on both volumes; `completed != requested` on either volume (fewer is an unfinished flush, more is counters that cannot be believed; an exhaustive truth table pins that exactly one combination is halted). **"libkrun exited 0 and the hook never ran"** (a hung observer after a clean off) and **a crash signal** (default disposition, no hook) produce no hook observation at all: the worker says nothing and the launcher, which sees only the process exit, must treat it as uncertain; a test pins that a relay with no exit report claims nothing.
* **Owner loss** (L2 closed, L3 closed, the parent pid changed, **or the parent was already gone when the worker started**, `getppid() == 1`; in that last case `main` exits 0 before any disk is held and the relay also treats a recorded parent of 1 as lost): the worker starts its own drain (`origin owner-loss`, 30 s, a nonce it mints with `arc4random_buf`). L2 or L3 EOF is detected by `recvmsg`; macOS reports a closed datagram peer as `ECONNRESET` exactly once, so the worker latches it (measured: poll shows `POLLIN` but not `POLLHUP`, one `ECONNRESET`, then `EAGAIN`).
* **Deadline**: budget plus 5 s grace without a power-off: exit 75. The launcher kills at the budget; the worker's own deadline only matters when the launcher is gone. An idle healthy guest is never timed. The clock is `CLOCK_UPTIME_RAW`, which does not count host sleep (a sleep/wake question for G3, not decided here).
* **Quarantine ack limit.** After a mux violation neither L3 nor L4 is read, so the guest's `drain_ack` and `halting` are never seen: a drain delivered during quarantine can end only by a power-off (the exit hook) or the deadline, no `drain_acked` is ever reported for it, and a quarantined stop is never a Class A candidate through the acknowledgement path.
* A malformed, out-of-sequence or unexpected post-intake envelope from the launcher (the contract has no code for it): `fault internal`, L2 is no longer read, and the worker starts the same owner-loss drain.

* **Round 3 statuses.** `halting` (9) is reported when the guest's control-up `halting` arrives AFTER its `drain_ack` with the drain's nonce; `guest_fault` (10) when a control-up `fault` arrives, once per run. A `fault` that names a nonce must name the running drain's (a nonce with no drain running, or another drain's, is a mux violation); a null nonce is accepted at any time. **After a `fault`, a `halting` is a mux violation and is not reported**, so no Class A can follow for the run. The worker does not decide Class A: it reports the statuses in the order they happened, `guest_halted` only from the exit hook, and the launcher's verdict (`coworkNativeGuestStopVerdict`) needs `vm_running, draining, drain_acked, halting, guest_halted` in that order with reason off and no `guest_fault`. A bare power-off, a power-off after `drain_ack` but before `halting`, and any exit with a withheld `guest_halted` are therefore Class B.
* **`guest_halted` only, or `exiting` alone.** Contract section 5: the worker reports `guest_halted` ONLY when the hook's reason is `off` and both disks show `final_sync_completed = 1` (the worker also withholds unless `completed == requested` on both disks); otherwise it reports `exiting` ALONE, with the real counters. The round 2 `fault vm_failed` that accompanied a withheld halt is removed. **An accepted guest `fault` or a mux quarantine also withholds `guest_halted`.** The relay sets two atomic flags (`guest_fault_seen`, `quarantine_seen`) BEFORE it tries to send the corresponding status, and the exit hook reads them without the relay lock, so a `guest_fault` or `mux_violation` status lost to a full L2 cannot reopen the way to a `guest_halted` that the launcher would read as orderly (found by the third review: `halting`, then `fault`, with L2 full for more than 2 s, then a clean OFF). **The hook never blocks** (libkrun's header says it must not): the relay lock is only tried, and each of `guest_halted` and `exiting` gets ONE non-blocking attempt on L2, no retry loop (the first version retried 20 x 100 ms per status under both locks, up to several seconds with an unread L2). A lost `guest_halted` is only Class B. Tests: a full L2 socket, a held sender lock and a held relay lock each return in under 150 ms and lose only statuses.
* **Layered stop timeline** (contract section 5): G, the DRAIN's `budgetMs` (default 30 s, at most 120 s), measured from the DRAIN's arrival; X, up to 20 s of libkrun exit path after the power-off (its own watchdog); K, the launcher kill at G + 25 s; H, the daemon wait at K + 10 s. The worker's own piece is G: **it exits 75 at G, with no grace** (`CW_STOP_GRACE_MS` is now 0; it was 5 s). A test pins the deadline to the budget, and a guard pins the zero. REVIEW NEEDED below on one consequence.

None of this is release evidence. Process exit, EOF and a closed descriptor are cleanup.

## 7. Console capture

libkrun's stderr (including the fixture-era `eprintln!` reclaim rows, which S4's review item 7 says carry host virtual addresses in `reclaim_unmap` rows) and the PL011 output go into one pipe. A reader thread keeps a 64 KiB ring. Every line is redacted before it is stored: the integer after `"hva":` (decimal, hex, quoted, spaced) becomes `0`. Output is printable ASCII only. A line longer than 2 KiB is cut and the rest dropped to the newline. The reader never blocks on anything but its own read, because a stalled reader would stall the VMM thread that is printing into the pipe, and `eprintln!` panics when stderr cannot be written. The ring is written out (bounded, pipe-atomic pieces, each only after `poll` says there is room, at most 1 s) to a saved copy of the launcher's stderr **only on an abnormal exit**. The libkrun log tail is bounded, redacted and ASCII; the guest's console is written only if the guest never reached its hello (nothing of the workspace can have been mounted yet), at most 16 KiB of the tail, redacted the same way, and is dropped otherwise because it can carry user content. Worker diagnostics are fixed strings; nothing from an envelope, a path or the guest goes through them.

## 8. The sandbox profile

```
(version 1)(deny default)(deny process-fork)(deny process-exec)
(allow sysctl-read)(allow process-info* (target self))
(allow file-read* (literal "/usr/bin/true"))
(allow file-read* (subpath "/System") (subpath "/usr/lib") (subpath (param "GUESTDIR")))
(allow file-read* (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))
```

The fixture's profile minus the write allow (see the open question below), with the worker's whole directory replaced by the guest-artifact directory (`<worker directory>/cowork-guest/`, holding `kernel` and `initramfs.cpio`). `sandbox_init_with_parameters` is Apple SPI, tested only on macOS 26.6.1 and only by the fixture. A test pins the text (no write, no network, no mach, no `file-lock`, balanced, no baked path) and the test binary replaces the three SPI entry points with stubs that `_exit(99)`. D5 (keep Seatbelt SPI) follows the plan's recommendation; nothing else about it was decided here.

**Open question (not run).** The brief called the fixture's `file-write*` on the two disk literals vestigial; that is unverified. Seatbelt can check `fstat`, `pread` and `pwrite` on an inherited descriptor against the vnode's path, and the received disks are opened by the daemon, outside the sandbox. The profile therefore carries no path rule for the disks and the question stays open in this note and the PR body. **G0 I/O variant (to add to the gate plan; do not run):** under the installed profile, on a throwaway image created for the gate, `fstat` the descriptor, `pread` one block and `pwrite` the same one byte with the same value back, and record whether each succeeds. If the write is denied, the profile needs a narrow rule and S2/S7 need to know before any disk is used.

**`file-lock` is deliberately not allowed.** Whether `flock` needs it under deny-default is unverified (plan risk 8) and no system sandbox profile on this machine mentions the operation either way, so a blind allow would widen the profile on no evidence. A lock failure is `bad_volumes`; **the lock is the first named G0 item.** G0 should also show: the profile compiles with its `GUESTDIR` parameter, `recvmsg` on the inherited sockets works, `arc4random_buf` and `/dev/urandom` work, and thread creation works.

## 9. The libkrun ABI

S4's library (PR #55; the patch queue 0004 to 0023 now lives in PR #62 at `apple/Cowork/WinterCoworkLibkrun/`) exports the contract's `_v1` names, so no mapping remains. `CoworkAbi.h` is the one file that knows the header as linked, and `pins.json` records where the header differs from the contract text (`abi.differences`); the build stops if the header changes. Call order: `krun_create_ctx`, the non-device setters, `krun_cowork_enable_profile_v1`, `krun_cowork_create_runtime_port_v1` (before the disks), `krun_cowork_set_workspace_disks_v1`, `krun_cowork_set_exit_hook_v1`, **`krun_cowork_validate_profile_v1` as the mandatory last preflight** (a non-zero result starts no VM), `krun_start_enter`. A guard pins this order.

| | Contract (1313040a) | Library header, followed by the worker |
| --- | --- | --- |
| exit hook | `krun_cowork_exit_hook_v1`: `void (*)(void *user_data, uint32_t reason)`; NONE=0 OFF=1 RESET=2 VCPU_ERROR=3 TERMINAL_FAULT=4 | the same |
| `get_flush_counters_v1` | `(struct krun_cowork_flush_counters_v1 *out)`: `{size, device_count, device[2]{requested, completed, final_sync_attempted, final_sync_completed}}`, process-global, carries the FINAL flush | the same |
| pin counters | `krun_cowork_get_pin_counters_v1`: optional diagnostics, feeds no decision | the same; read by gate G4, never called by the worker |

Since contract round 3 the two agree and `pins.json` records no difference. The worker uses only the header's symbolic constants, never a number, so the shifted values cannot swap off and reset; only `KRUN_COWORK_EXIT_OFF` may lead to `guest_halted`. A hook with any other signature is refused at compile time twice (`_Generic` in `CW_ASSERT_EXIT_HOOK_SIGNATURE` and the call itself under `-Werror`); `build.py` compiles one correct and three wrong hooks and requires 1 success and 3 refusals (C has no link-time type, so "refuse to link" is "refuse to compile"). `CW_ABI_FLUSH_EVIDENCE` is on; there is no fallback.

## 10. Build and static checks

`python3 -I build.py all --out <dir outside the repo> --libkrun-include <S4 include dir> --libkrun-archive <S4 stripped archive>`.

* `/usr/bin/clang -std=c11 -O2 -Wall -Wextra -Wpedantic -Wshadow -Wformat=2 -Wstrict-prototypes -Wmissing-prototypes -Wundef -Wcast-qual -Werror`, `-ffile-prefix-map` and `-fdebug-prefix-map` for the repository, the output directory and the home directory, `-Wl,-dead_strip`, `strip -x`. Links `-framework Hypervisor -liconv -lSystem -lc -lm` and the archive, nothing else. No network, a cleaned environment for every child, `python3 -I`.
* **The libkrun inputs are S4's prebuilt, not rebuilt here.** The stripped production archive `e4433efe447fd123bb72989d024013d9c913d380d2a1190bc3e181d1f69a89b3` (patch queue 0004 to 0023; raw `ca876b12...`; PR #62, `apple/Cowork/WinterCoworkLibkrun/`, whose `build_archive.py` and `expected-hashes.json` are the reference) was taken from that package's build output; its `expected-hashes.json` records this hash, reproduced at two locations. The vendored package records no header hash, so the header hash in `pins.json` (`6b4d0408...`) is DERIVED, not self-attested: `build.py verify-header` applies the `include/libkrun.h` hunks of S4's committed patch queue (each patch file pinned by SHA-256) to the pristine upstream v1.19.6 header, and the result is also byte-identical to the header in S4's build output. `build.py` refuses to build unless both hashes match. The header is a build input and is not vendored (D7 is open).
* Linking the **stripped** archive matters: the raw one carries the Rust project's own CI Xcode path in its debug stabs.
* Ad-hoc signed inside the scratch directory, `--options runtime`, identifier `com.winter.cowork.worker`:

```
$ codesign -dvv --entitlements - winter-cowork-worker.signed
Identifier=com.winter.cowork.worker
Format=Mach-O thin (arm64)
CodeDirectory v=20500 size=6489 flags=0x10002(adhoc,runtime) hashes=192+7 location=embedded
Signature=adhoc
TeamIdentifier=not set
[Dict]  [Key] com.apple.security.hypervisor  [Value] [Bool] true

$ otool -L winter-cowork-worker.signed
	/System/Library/Frameworks/Hypervisor.framework/Versions/A/Hypervisor
	/usr/lib/libiconv.2.dylib
	/usr/lib/libSystem.B.dylib
```

* Entitlements are exactly `com.apple.security.hypervisor`; no `allow-jit`, no `disable-library-validation`, no debugger entitlement, no `com.apple.vm.networking`. Only platform dylibs. `strings` over 6.7 k strings finds no builder path, no home directory and no user name (the crate paths appear as `/cargo-home/...`, `/libkrun/...`). Binary size about 3.1 MB.
* The final binary defines **15** libkrun entry points, all referenced by the worker: `krun_init_log`, `krun_create_ctx`, `krun_set_vm_config`, `krun_disable_implicit_vsock`, `krun_set_env`, `krun_disable_implicit_console`, `krun_add_serial_console_default`, `krun_set_kernel`, `krun_start_enter`, `krun_cowork_enable_profile_v1`, `krun_cowork_create_runtime_port_v1`, `krun_cowork_set_workspace_disks_v1`, `krun_cowork_validate_profile_v1`, `krun_cowork_get_flush_counters_v1`, `krun_cowork_set_exit_hook_v1`. **Not exported** (so not callable from anything the worker defines): `krun_add_vsock*`, `krun_add_virtiofs*`, the GPU, display, input and port-map calls, `krun_get_shutdown_eventfd`. **Present but unreachable behind S4's gate:** the archive still contains the vsock, virtiofs and GPU code as Rust code and its libSystem imports; the production profile refuses to enable those devices and the worker has no way to ask for them. This replaces the earlier wording "no vsock/virtiofs/GPU in the binary", which was too strong.
* **Imported by the archive's code, not called by the worker's own source** (`nm -u`, 12): `accept`, `bind`, `connect`, `dlopen`, `dlsym`, `execve`, `fork`, `listen`, `sendto`, `setgid`, `setuid`, `socket`. The worker's own source calls `fork` and `exec` only in the sandbox denial probe (a guard pins that). The sandbox denies network, fork and exec in any case.

## 11. Tests

13 strict-C binaries, **48,644 checks** (the 16-slot builds counted; the AddressSanitizer + UndefinedBehaviorSanitizer rerun executes the same 48,644 again; the previous round's figure was 27,904, which a reviewer re-added as 27,906), and 24 Python source guards. In-process socketpairs, temp files and fakes only. `build.py asan` builds every binary, the 16-slot ones included, with `-fsanitize=address,undefined`; all pass.

| Binary | Checks | What it pins |
| --- | --- | --- |
| `test_envelope` | 345 | S1's envelope vectors decoded and re-encoded byte for byte; every field boundary; the SCOPE digest; the outbound sender; fault code 8. |
| `test_mux` | 22,124 | S1's mux vectors (the 84 relay-blind ones asserted to pass through; none is a control frame); the control-up `fault` message code by code; the control grammar including whole-word origins; ceilings; sequence; the stream reader. |
| `test_stop` | 73 | The OwnedStop machine under a fake clock: the deadline is exactly the budget; `guest_fault` once, bound to the running drain's nonce (a zero nonce included), and a `halting` after it refused. |
| `test_ring` | 21 | Redaction under any chunking, ring bound and accounting, long lines. |
| `test_rights` | 89 | The bounded collector on synthetic buffers: wrong level or type, payload not a multiple of an int, over capacity (stored, closed, counted), a header longer than the buffer, degenerate lengths, many headers. |
| `test_runtime_image` | 103 | S1's image vectors; hashing across chunk boundaries; `O_NOFOLLOW`; a file that shrinks, is touched, grows, or grows with its mtime put back during the read; the size cap (inclusive); the verify step. |
| `test_intake` | 665 | Sandbox hook ordering, gate, digest check, every volume check, lock, descriptor leaks, stray-descriptor hygiene, timeouts. |
| `test_handoff[256]`, `[16]` | 58, 58 | The fixture harness extended: named local or peer sockets refused (both directions), the real unnamed pair admitted, and the truncation case. |
| `test_relay[256]`, `[16]` | 12,368, 12,374 | The pump, control termination, drain and `second_drain`, owner loss including a parent already gone, quarantine, deadlines, backpressure, exit reports (`reason == OFF` only, uncertain cases, no hook observed), the 11,664-combination truth table of the halted decision (the 2,916 report combinations times an accepted fault and a quarantine; exactly one is halted), an accepted fault after `halting` with L2 full and a quarantine (with and without its own status lost), a second DRAIN after the stop has ended, the exit hook returning promptly on a full L2, a held sender lock and a held relay lock, the `halting` and `guest_fault` statuses, and runtime frames relayed byte for byte whatever their prefix. |
| `test_sandbox_profile` | 296 | The profile as text; the SPI is poisoned. |
| `test_abi` | 70 | The translation from the library's exit reason and flush counters to the worker's record, and the halted decision, against the real header with no library; S1's `guest-stop.json` drift test (the exit-reason numbers equal the header's constants, an orderly case is halted, every withheld case is not orderly, the two quarantine and no-`drain_ack` cases are halted at the worker and Class B at the launcher). |

**The 16-descriptor measurement.** The handoff harness is built with capacities 256 and 16. With 16, the 20-descriptor datagram is `MSG_CTRUNC`: 16 are visible and closed, the open-descriptor count in the process **still rose from 6 to 10**, i.e. the kernel installed descriptors nobody can see. That is the evidence for the HARD rule (a plain `read` or `recv` installs rights, and truncation cannot be recovered from) and for why the truncation exit is terminal.

**Mutation.** Mutants live in a scratch driver (not in the tree): each edit is applied to a throwaway copy of the package, the named test is run, and a failing check is required (a compile error is retried with warnings non-fatal so it cannot count as a kill; a test that hangs for 120 s is killed and counts as a kill). The set is the predecessor's 201, the reviewer's 62 (13 of them replaced because the code they edited was restructured; the replacements are the `N-` mutants on `Rights.c`, `Relay.c`, `CoworkAbi.h`), the round 3 guards (control-up fault grammar and binding, `guest_fault`/`halting` statuses, the stop deadline, status values, pin and vector tampering) and the delta review's (`completed == requested` in all its forms, the exit hook that must not block): the third review's (an accepted fault or a quarantine and the two atomic flags read by the hook; the text-pin-only kills T05 `exit 75` and S01 `drain_seen` converted to behaviour tests): 334 source mutants in the final set.

* **313 of 334 killed**, including every guard mutant and every one of the reviewer's earlier survivors (I19, I23, I24, I25, I25b, I31, I33 to I35 through their replacements, X06). Both flags of the third review's Medium are killed (`Q-01` to `Q-09`: not set, set only after a successful send, ignored by the hook, ignored by the gate). The delta review's blocking item is covered twice: the 2,916-combination truth table asserts that exactly one combination is halted, and the `!=`, `<`, `>`, `==` and off-by-one forms of the check (`H-01` to `H-09`) are all killed by it.
* **21 survive, each explained.** Double-guarded, with the pair (both guards removed) killed: `E01`, `E07`, `E34`, `X13`, `X19`, `X20` (explicit check plus the re-encode compare) and `N-E37a/b/c`, `N-X25a/b` (the `MSG_CTRUNC` flag and the collector's truncated report overlap on macOS; `N-E37ab` and `N-X25ab` remove both and are killed). Shadowed or equivalent: `E09`, `E23`, `X14`, `R04`, `N-RT08` (`CMSG_NXTHDR` already keeps the next header inside the buffer), `N-R16c` (the stop machine answers the same `second_drain` fault), `N-I34b` (the soft limit exceeds `getdtablesize()` only when raised at run time). `B06` (the bounded sender without `MSG_DONTWAIT`) is equivalent on macOS, where a full AF_UNIX datagram socket returns an error instead of blocking: no test can tell the flag from its absence, so it stays as a defence pinned by a source guard, and the sender's behaviour (never waits, spends no sequence number) is tested on a blocking socket. **Two sandbox-probe survivors, `Q01` and `Q02`**: the probe logic (outbound network refused, a sandbox is in force) needs the sandbox installed, so **it is first exercised at G0**, not before. (An earlier draft of this paragraph counted three; there are two. `N-A08` is not a survivor: it is a source-guard mutant and it is killed.) The earlier note's survivor `E42` is retired: it was reported as "unreachable", which was wrong on macOS (the kernel installs all descriptors and reports the sender's length, which is what the out-of-bounds read was); the capacity overflow is now `N-RT03/04/05`, all killed.
* Build-level: an extra entitlement, an extra non-platform dylib and a builder path in the binary each make `build.py inspect` fail; the unmutated control and the same path with the prefix map in force pass.

## 12. Anti-wiring

`Tests/test_guards.py::AntiWiring` greps the whole repository (tracked and untracked) and fails if any file outside the package and this document names `WinterCoworkHVFWorker`, `winter-cowork-worker`, `WorkerNative` or `com.winter.cowork.worker`. It also pins that tests never call the sandbox, libkrun or a Hypervisor function and that the build is offline. **This is not the TypeScript anti-wiring pin** (the package adds no TypeScript), so CI cannot see it; it runs from `build.py guards`. S2 and S7 must extend `ANTI_WIRING_ALLOWED` in the commit that first wires the worker.

## 13. REVIEW NEEDED

1. **The `file-write*` premise** (section 8): the profile has no path rule for the disks, and whether `fstat`, `pread` and `pwrite` on the received descriptors work under it is unverified. G0 I/O variant to be added to the gate plan.
2. **The worker exits 75 at G with no grace, as the contract's timeline says.** If the guest powers off shortly before G, libkrun's exit path (up to X = 20 s: final flushes, then the hook) is still running, and the worker's own deadline can end the process in the middle of it; that is a Class B (no `guest_halted`), never a Class A on a half-flushed disk, but it makes a slow flush at the very end of the budget uncertain. The worker cannot see the power-off before the hook runs. Options for S1: let the worker's deadline be G + X once `halting` has been seen, or leave it.
3. **Contract notes for S1** (not decisions made here): the worker may send `guest_halted` after a mux quarantine or without `drain_ack`, and the launcher's drain rule then makes it Class B; `exiting` carries counters that are meaningful only alongside `guest_halted`.
4. **Hash-then-load window** (section 4): libkrun reopens the artifacts by path. `/dev/fd/N` proposal for G0.
5. **Not in the contract, chosen narrowly:** fd 3 is L2 and fd 4 is L3; the guest artifacts live at `<worker directory>/cowork-guest/{kernel,initramfs.cpio}`; the exit codes (70 to 79); the intake timeouts (10 s for SCOPE, 120 s for VOLUMES); `fault internal` for a bad post-intake envelope, followed by an owner-loss drain; stderr is used only for fixed diagnostics and the bounded abnormal-exit tails. S2 must install exactly this, or the contract should name it.
6. **Rights policy** is stricter than contract section 5 (section 4 lists exactly which cases are silent).
7. **`flock` under deny-default is unverified.** First G0 item.
8. **`-Wl,-dead_strip` on a Rust staticlib** is how rustc links on macOS, but this binary has never run.
9. **Console path.** The reclaim hot path prints into a pipe the reader thread must drain; whether `krun_add_serial_console_default` takes ownership of the descriptor it is given is unverified.
10. **Quarantine and owner-loss timings** (30 s, and 30 s plus 5 s), the quarantine ack limit and the choice that a mux violation ends the stream but not the VM are judgment calls.
11. **Sleep and wake.** The deadlines use `CLOCK_UPTIME_RAW`.
12. **The libkrun archive is S4's prebuilt, not rebuilt here**, and its header hash is derived, not attested by S4.
13. **CI proves nothing about this package.** `ci.yml` runs the TypeScript workspaces; this PR changes none.
14. **D5** follows the plan.

### What the contract must still pin (for S1)

* **Hook mapping**: settled in round 3 (the contract's ABI section is the library's header). Listed for completeness.
* **Digest race**: that `runtimeImageDigest` proves the bytes at hash time only, and who closes the window (`/dev/fd/N` paths or a copy owned by the worker).
* **Counters are valid only in `guest_halted`/`exiting`**, and what the launcher does when `completed != requested`, when libkrun exits 0 with no hook, and on a crash signal (all uncertain, never Class A).
* **Bounded launcher stderr**: the worker's diagnostics and abnormal-exit tails are fixed or redacted text of bounded size; the launcher must bound what it keeps.
* **Call order**: runtime port before disks, exit hook before the mandatory validate, validate last.
* The descriptor numbers, the guest-artifact path, and the exit codes (item 4 above).

## 14. Not done

No worker run, no VM, no sandbox application, no signing identity, no notarization, no release script. No change to the contract, the launcher, S4's patches, the daemon, the app, `ci.yml` or any existing file.
