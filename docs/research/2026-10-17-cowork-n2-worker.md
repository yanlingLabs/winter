# Cowork N2 slice S3: the production C worker

Status: source, build and VM-free tests. 2026-10-17. **No worker and no VM was run.** `winter-cowork-worker` (and a link-check binary built against a stub) was compiled, linked, ad-hoc signed inside a scratch directory and inspected with `codesign`, `otool`, `nm` and `strings`. It was never executed. The test binaries were executed: they use in-process socketpairs, temp files and a poisoned stand-in for the sandbox SPI. No `sandbox_init*` call, no Hypervisor.framework call, no `krun_start_enter`, no `pmset` and no signing identity were used anywhere.

Every gate G0 to G6 needs a review of the exact commit and the owner's approval first. **G0 (`--sandbox-check`) is the first run this code can safely get, and nothing here has asked for it.**

Package: `apple/Cowork/WinterCoworkHVFWorker/`. Nothing outside it and this document refers to it (pinned, see "Anti-wiring").

The contract is S1's (`docs/cowork-native-worker.md`, `packages/core/src/cowork/native/protocol.ts` and the golden vectors on `cowork/n2-host-adapter`, PR #56, head `eeb7618f`). Where the contract is silent this document says so and picks the narrowest behaviour; it does not diverge from the contract anywhere.

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
| `Sources/WorkerNative/CoworkAbi.h` | The ONE file that maps the contract's libkrun names to what the linked archive exports. |
| `Sources/WorkerNative/WorkerCommon.h` | Descriptor numbers, exit codes, limits. |
| `worker.entitlements` | Exactly `com.apple.security.hypervisor`. |
| `pins.json`, `build.py` | The pinned libkrun inputs; the offline build, test and inspection driver. |
| `Tests/*.c`, `Tests/test_guards.py` | Ten strict-C test binaries and the Python source guards. |
| `Tests/fixtures/` | S1's `envelopes.json` and `mux-frames.json`, byte for byte, pinned by SHA-256 with the source commit. |
| `Tests/stubs/krun_contract_stub.c` | A stub of the libkrun surface with the CONTRACT's names, for a link check only. |

## 2. What changed from the fixture worker

Starting point: `workspace_fixture_worker.c`, `workspace_fd_handoff.{h,c}` and `workspace_fd_handoff_test.c` at `cowork/two-disk-fixture` 9a588735.

| Removed | How |
| --- | --- |
| The fixed argv layout | `argc` must be 1, or 2 with `--sandbox-check`. Nothing else is read from the caller. A guard pins `argv[1]` as the only use. |
| `alarm(120)` | Gone. A long-lived guest is not timed; only a stop, an owner loss or a violation arms a deadline (section 6). A guard refuses `alarm(`. |
| The 2 vCPU / 768 MiB constants | `vcpus` and `memoryMiB` come from SCOPE and are validated against the library's production gate (section 4). A guard refuses a literal `768`. |
| The `file-write*` allow on the two disk literals | Gone (the disks arrive as descriptors). The profile now allows no write of any kind; a test pins the exact allow list. |
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

* The S1 parser accepts 256 to 1024 MiB. libkrun's production gate refuses below 768. The worker validates SCOPE against the **library's** constants (`KRUN_COWORK_PRODUCTION_*`, through `CoworkAbi.h`), so 512 MiB faults `bad_scope` at intake rather than `vm_failed` later. Tests prove the gate against a narrower gate than the parser, so it is not shadowed by the parser's own caps.
* `volumes.scopeDigest` must equal the SHA-256 of the SCOPE payload exactly as received (CommonCrypto `CC_SHA256`, part of libSystem).
* Each received descriptor is checked against its identity record with the same list libkrun's own setter applies, so a refusal is `bad_volumes` at intake: regular file, one link, owned by the effective user and by the record's uid, mode exactly 0600 (all of 07777), `O_RDWR` and not `O_APPEND`, the recorded device, inode and size. `st_dev` is read **sign-extended** (`(uint64_t)(int64_t)st_dev`), as the daemon (libuv) and libkrun (Rust `st_dev as u64`) read it. Both descriptors or neither.
* Then `flock(LOCK_EX | LOCK_NB)` on both: an extra guard, **never** release evidence. It is `flock`, not `fcntl(F_SETLK)`: a POSIX lock is dropped by any close of the file in the process, whereas a `flock` belongs to the open file description, which libkrun's duplicates keep alive after the worker closes its own copies. A test shows a duplicate's close does not release it and that only the last close of the description does.
* Rights policy: any descriptor with a non-VOLUMES envelope, a VOLUMES with one, three or more descriptors, a truncated control buffer: close, no acknowledgement, exit 79. VOLUMES with **no** descriptor at all is a launcher mistake and nothing unexpected arrived: `fault bad_volumes`. This is stricter than contract section 5 on the parse side (the parser itself returns `bad_rights`, matching the vectors) and is the brief's rule.
* A DRAIN envelope that arrives before the VM exists (sequence 1 or 2) ends the worker cleanly: nothing was started and no disk was held. An L2 close before the VM exists is the same.

## 5. The mux

Header, per-class ceilings (control 4 KiB, bootstrap 256 KiB, runtime 1 MiB), the provider class refused at the header in both directions, and sequence continuity per (class, direction) are enforced at both hops. A stream reader reads exactly one frame at a time and never past its end, and judges the header the moment its 16 bytes are in, so an oversized or reserved frame is refused before any payload is buffered.

* **Control** frames terminate at the worker. A control frame arriving on L3 is a violation; from the guest it is parsed with a fixed grammar (keys in the contract's order, no whitespace, no escapes, canonical integers) and then re-encoded and compared byte for byte, as the contract prescribes.
* **Bootstrap and runtime are relayed blind**: header and sequence only. Five S1 negative vectors are refused by the TypeScript parser for their *payload* and are **passed through** by the worker, on purpose, and the C test asserts exactly that: `plan-protocol-2`, `plan-unsorted-nested-keys`, `hello-wrong-serial`, `bootstrap-invalid-utf8`, `plan-travelling-up`. A mutant that adds any payload check to the worker fails that assertion. The first bootstrap frame from the guest reports `guest_hello` without being read.
* **A violation ends the stream, not the VM.** `fault mux_violation`, both mux directions stop being read, frames already validated finish, the worker's own control frames (a drain) still flow, and if nobody stops the VM within 30 s the worker ends itself (exit 74).
* A **descriptor on a mux stream** is closed and is a violation; a truncated control buffer there is `exit 79`.

## 6. Stop, owner loss and the watchdog

`OwnedStop` is a pure machine. Two things start a stop: a DRAIN envelope from the launcher (`host-stop`, or the launcher's own `owner-loss`), and the worker's own owner-loss path.

* DRAIN: the worker queues a control `drain {stopNonce, budgetMs, origin}` toward the guest and reports `draining`. The guest must answer `drain_ack` with **that** nonce (reported as `drain_acked`) and then `halting` with that nonce; any other order, nonce or an unsolicited message is a violation. A second DRAIN with the same nonce is ignored; with a different nonce the first stands and the worker reports `fault internal` (the contract has no code for it).
* Power-off: the VMM exit hook reports `guest_halted` with the flush counters, then `exiting`. A guest that powers off without acknowledging is reported as halted and nothing more; the launcher decides what that means.
* **Owner loss** (L2 closed, L3 closed, or the parent pid changed): the worker starts its own drain (`origin owner-loss`, 30 s, a nonce it mints with `arc4random_buf`). L2 or L3 EOF is detected by `recvmsg`; macOS reports a closed datagram peer as `ECONNRESET` exactly once, so the worker latches it (measured: poll shows `POLLIN` but not `POLLHUP`, one `ECONNRESET`, then `EAGAIN`).
* **Deadline**: budget plus 5 s grace without a power-off: exit 75. The launcher kills at the budget; the worker's own deadline only matters when the launcher is gone. An idle healthy guest is never timed. The clock is `CLOCK_UPTIME_RAW`, which does not count host sleep (a sleep/wake question for G3, not decided here).
* A malformed, out-of-sequence or unexpected post-intake envelope from the launcher (the contract has no code for it): `fault internal`, L2 is no longer read, and the worker starts the same owner-loss drain.

None of this is release evidence. Process exit, EOF and a closed descriptor are cleanup.

## 7. Console capture

libkrun's stderr (including the fixture-era `eprintln!` reclaim rows, which S4's review item 7 says carry host virtual addresses in `reclaim_unmap` rows) and the PL011 output go into one pipe. A reader thread keeps a 64 KiB ring. Every line is redacted before it is stored: the integer after `"hva":` (decimal, hex, quoted, spaced) becomes `0`. Output is printable ASCII only. A line longer than 2 KiB is cut and the rest dropped to the newline. The reader never blocks on anything but its own read, because a stalled reader would stall the VMM thread that is printing into the pipe, and `eprintln!` panics when stderr cannot be written. The ring is written out (bounded, pipe-atomic pieces, each only after `poll` says there is room, at most 1 s) to a saved copy of the launcher's stderr **only on an abnormal exit**, because guest console text can carry user content. Worker diagnostics are fixed strings; nothing from an envelope, a path or the guest goes through them.

## 8. The sandbox profile

```
(version 1)(deny default)(deny process-fork)(deny process-exec)
(allow sysctl-read)(allow process-info* (target self))
(allow file-read* (literal "/usr/bin/true"))
(allow file-read* (subpath "/System") (subpath "/usr/lib") (subpath (param "GUESTDIR")))
(allow file-read* (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))
```

The fixture's profile minus the vestigial write allow, with the worker's whole directory replaced by the guest-artifact directory (`<worker directory>/cowork-guest/`, holding `kernel` and `initramfs.cpio`). `sandbox_init_with_parameters` is Apple SPI, tested only on macOS 26.6.1 and only by the fixture. A test pins the text (no write, no network, no mach, no `file-lock`, balanced, no baked path) and the test binary replaces the three SPI entry points with stubs that `_exit(99)`. D5 (keep Seatbelt SPI) follows the plan's recommendation; nothing else about it was decided here.

**`file-lock` is deliberately not allowed.** Whether `flock` needs it under deny-default is unverified (plan risk 8) and no system sandbox profile on this machine mentions the operation either way, so a blind allow would widen the profile on no evidence. A lock failure is `bad_volumes`; **the lock is the first named G0 item.** G0 should also show: the profile compiles with its `GUESTDIR` parameter, `recvmsg` on the inherited sockets works, `arc4random_buf` and `/dev/urandom` work, and thread creation works.

## 9. The libkrun ABI, and what S4 does not have

`CoworkAbi.h` maps the contract's names to the archive's. `build.py` reads `nm` on the archive and sets the mapping; nothing is decided at run time.

| Contract (S1) | Implemented (S4, PR #55) |
| --- | --- |
| `krun_cowork_enable_profile_v1` | `krun_cowork_enable_production_profile` |
| `krun_cowork_set_workspace_disks_v1` | `krun_cowork_set_workspace_disks` |
| `krun_cowork_create_mux_stream_v1` | `krun_cowork_create_runtime_port` |
| `krun_cowork_get_flush_counters_v1` | **none** |
| `krun_cowork_set_exit_hook_v1` | **none** |
| (none) | `krun_cowork_validate_production_profile` (optional preflight, used) |

**The last two are missing from S4's archive.** Without them the Class A receipt cannot be produced (`guest_halted` with counters). In that configuration `CoworkAbi.h` makes both inline refusals returning `-ENOSYS`, and `configure_vm` **refuses to start a VM**: a VM whose orderly stop can never be receipted must not run. There is no `atexit()` stand-in. **S4 must add the pair or the contract must change.**

The contract-name configuration is link-checked against a stub archive that carries all five `_v1` names (`Tests/stubs/krun_contract_stub.c`; every function returns `-ENOSYS`; it is never run), so the rename S4 will make is shown to be the one-file change this header says it is.

## 10. Build and static checks

`python3 -I build.py all --out <dir outside the repo> --libkrun-include <S4 include dir> --libkrun-archive <S4 stripped archive>`.

* `/usr/bin/clang -std=c11 -O2 -Wall -Wextra -Wpedantic -Wshadow -Wformat=2 -Wstrict-prototypes -Wmissing-prototypes -Wundef -Wcast-qual -Werror`, `-ffile-prefix-map` and `-fdebug-prefix-map` for the repository, the output directory and the home directory, `-Wl,-dead_strip`, `strip -x`. Links `-framework Hypervisor -liconv -lSystem -lc -lm` and the archive, nothing else. No network, a cleaned environment for every child, `python3 -I`.
* **The libkrun inputs are S4's prebuilt, not rebuilt here.** The stripped production archive (`f6e7beec1a11a3abb23007bbfc70354ad3dbe14fd8c8ded85cb887acee810f38`) and its composed header (`af65994a309fedc9918e6197b27271ee85d3b4eb957ec5a40503b85c10e8e7b5`) came from S4's `out/` (PR #55, commit `2221528b`). S4 records building the archive twice at different absolute paths and getting a bit-identical result; its hash matches that record. `build.py` refuses to build unless both hashes match `pins.json`. The header is a build input and is not vendored (D7, where the patches live, is open).
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
* The final binary defines **13** libkrun entry points (the 66 upstream exports are otherwise dead-stripped): `krun_init_log`, `krun_create_ctx`, `krun_set_vm_config`, `krun_disable_implicit_vsock`, `krun_set_env`, `krun_disable_implicit_console`, `krun_add_serial_console_default`, `krun_set_kernel`, `krun_start_enter`, `krun_cowork_enable_production_profile`, `krun_cowork_set_workspace_disks`, `krun_cowork_create_runtime_port`, `krun_cowork_validate_production_profile`. `krun_add_vsock*`, `krun_add_virtiofs*`, the GPU, display, input and port-map calls, and `krun_get_shutdown_eventfd` are not in the binary. This is correct by construction and has never been exercised at run time.

## 11. Tests

Ten strict-C binaries, **12,922 checks**, and 21 Python source guards. In-process socketpairs, temp files and fakes only.

| Binary | Checks | What it pins |
| --- | --- | --- |
| `test_envelope` | 204 | All 34 S1 envelope vectors decoded and re-encoded byte for byte; every field boundary; the SCOPE digest against the vector's SHA-256; the outbound sender. |
| `test_mux` | 10,981 | All 40 S1 mux vectors (the five relay-blind ones asserted to pass through); the control grammar; ceilings; sequence; the stream reader byte by byte and with a 1 MiB frame. |
| `test_stop` | 51 | The OwnedStop machine under a fake clock. |
| `test_ring` | 21 | Redaction under any chunking, ring bound and accounting, long lines. |
| `test_intake` | 563 | Sandbox hook ordering, gate, every volume check, lock, descriptor leaks, timeouts. |
| `test_handoff[256]`, `[16]` | 42, 42 | The fixture harness extended (see below). |
| `test_relay[256]`, `[16]` | 358, 364 | The pump, control termination, drain, owner loss, quarantine, deadlines, backpressure. The 16 build also sends 20 descriptors on L2 and L3 after intake. |
| `test_sandbox_profile` | 296 | The profile as text; the SPI is poisoned. |

**The 16-descriptor measurement.** The handoff harness is built with capacities 256 and 16. With 16, the 20-descriptor datagram is `MSG_CTRUNC`: 16 are visible and closed, the open-descriptor count in the process **still rose from 6 to 8**, i.e. the kernel installed descriptors nobody can see. That is the evidence for the HARD rule (a plain `read` or `recv` installs rights, and truncation cannot be recovered from) and for why the truncation exit is terminal.

**Mutation.** `Tests/` mutants live in a scratch driver (not in the tree): each edit is applied to a throwaway copy of the committed package, the named test is run, and a failing check (not a compile error) is required. 201 source mutants, 3 build-level mutants and 2 controls:

* **189 of 201 killed.** All 22 guard mutants (order of `main`, sandbox-after-read, `alarm`, `argv` layout, `getenv`, fixture symbols, a vsock call, S4 names outside the shim, a plain `recv`, a `fork` outside the probe, a network import in `build.py`, a home path, an extra entitlement, a broken fixture pin, a test calling the sandbox) are killed.
* **12 survive, each explained.** `E01` (magic), `E07` (length), `X13` (leading zero), `X19` (trailing byte): each is refused twice, by its explicit check and by the final re-encode compare, so removing one alone survives; the paired mutants `E01+E34`, `E03+E34`, `E07+E34`, `X13+X20`, `X15+X20`, `X19+X20` (the check together with the compare) are all killed. `E34` and `X20` (the compares alone) are the second guards. `E09` is shadowed by the token check that follows (`E11` is killed). `E23` is equivalent (the 256 GiB ceiling already refuses everything above 2^53). `E42` is unreachable (a larger descriptor set is `MSG_CTRUNC` first). `X14` is redundant (the object-end check gives the same code). `A37` is an unreachable defence (`open` returns the standard slot being refilled). `R04` is shadowed (a refused parse zeroes the control, which OwnedStop refuses as well).
* Build-level: an extra entitlement, an extra non-platform dylib and a builder path in the binary each make `build.py inspect` fail; the same path with the prefix map in force is clean, which shows the map is what protects the build.

## 12. Anti-wiring

`Tests/test_guards.py::AntiWiring` greps the whole repository (tracked and untracked) and fails if any file outside the package and this document names `WinterCoworkHVFWorker`, `winter-cowork-worker`, `WorkerNative` or `com.winter.cowork.worker`. It also pins that tests never call the sandbox, libkrun or a Hypervisor function and that the build is offline. **This is not the TypeScript anti-wiring pin** (the package adds no TypeScript), so CI cannot see it; it runs from `build.py guards`. S2 and S7 must extend `ANTI_WIRING_ALLOWED` in the commit that first wires the worker.

## 13. REVIEW NEEDED

1. **S4 exports 3 of the contract's 5 symbols.** `get_flush_counters_v1` and `set_exit_hook_v1` have no target, so the worker refuses to start a VM. S4 must add them or the contract must change. (Section 9.)
2. **Names.** The rename is the one file `CoworkAbi.h`; `build.py` detects which set the archive exports.
3. **Memory floor.** S1's parser 256 to 1024 MiB; S4's gate 768 to 1024. The worker faults `bad_scope` below 768. One of them should move.
4. **Not in the contract, chosen narrowly here:** fd 3 is L2 and fd 4 is L3; the guest artifacts live at `<worker directory>/cowork-guest/{kernel,initramfs.cpio}`; the exit codes (70 to 79); the intake timeouts (10 s for SCOPE, 120 s for VOLUMES); `fault internal` for a second DRAIN or a bad post-intake envelope, followed by an owner-loss drain; the worker's stderr is the launcher's own and is used only for fixed diagnostics and the abnormal-exit console tail. S2 must install exactly this, or the contract should name it.
5. **`runtimeImageDigest` is parsed and shape-checked but not verified.** The contract does not say what it digests, so the worker cannot compare it with the kernel and initramfs it boots, and it does not pretend to. S7 binds the image pins; until then the worker trusts the signed directory next to it.
6. **Rights policy** is stricter than contract section 5 (section 4 above).
7. **`flock` under deny-default is unverified.** First G0 item.
8. **`-Wl,-dead_strip` on a Rust staticlib** is how rustc itself links on macOS, but this binary has never run.
9. **Console path.** The reclaim hot path now prints into a pipe the reader thread must drain; a stalled reader would stall the VMM. Whether `krun_add_serial_console_default` takes ownership of the descriptor it is given is unverified.
10. **Quarantine and owner-loss timings** (30 s and 30 s plus 5 s) and the choice that a mux violation ends the stream but not the VM are judgment calls.
11. **Sleep and wake.** The deadlines use `CLOCK_UPTIME_RAW`.
12. **The 16-descriptor measurement** above, and the S4 archive being consumed prebuilt rather than rebuilt.
13. **CI proves nothing about this package.** `ci.yml` runs the TypeScript workspaces; this PR changes none. Every result in this document is local.
14. **D5** follows the plan; nothing else was decided.

## 14. Not done

No worker run, no VM, no sandbox application, no signing identity, no notarization, no release script. No change to the contract, the launcher, S4's patches, the daemon, the app, `ci.yml` or any existing file.
