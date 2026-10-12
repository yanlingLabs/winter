# NONSECRET guarded stream fixture: prepared, not booted

This fixture prepares the independently accepted frozen v3 native source for one bounded Linux/HVF run. No VM has launched. The prior restricted reclaim and RAW disk results, sources, native patches and artifacts remain unchanged. This is not key transport, encrypted storage, production signing or completed Cowork integration.

Replacement review build receipt (v2 cleanup/deadline corrections): `out/stream-fixture-v3/build.json`, SHA-256 `390213327256cdd23390b9ae84fe1da8c8ca9aaf180083c5fb3b1a6691ead1c6`. Identical durable copy: `results/2026-10-12-stream-fixture-v2-build.json`. The build binds frozen `stream-candidate-v3.json`, every artifact and every custom launch/audit import. `prepare_stream_v3.py` verifies the unchanged composed native diff and shared modules. No new native patch or crypto kernel is introduced.

The original reviewed `b5a4f8b0` receipt remains held; its artifact directory is preserved at `out/stream-fixture-v3-held-b5a4f8b0`, and all original durable results remain unchanged. Review findings and the launch hold are recorded in `docs/research/2026-10-12-cowork-stream-fixture-review.md`.

The user has deferred separate private-disk encryption for the first usable version. That design uses plaintext private images with FileVault/file permissions and accepts the same-user/copied-image residual. VM isolation, host credential protection and active RAM return remain required. This fixture does not verify the host FileVault configuration.

## Actual no-VM evidence

`stream_fixture_worker.c` installs a deny-default Seatbelt profile with explicit process-fork/exec denials before calling `krun_create_cowork_bootstrap_stream`. The actual hardened, ad-hoc signed worker passes sandbox state checks, fork/exec EPERM, fixture RAW read/write/full-sync, denial of unrelated writes, `/etc/hosts` reads and a loopback outbound connection. It proves the closed library factory succeeds inside this profile, transfers only the opposite peer over an inherited unnamed control socketpair, closes its returned peer, performs a bounded parent acknowledgement, and creates/joins a thread. Context destruction produces EOF on the transferred peer. No private device FD leaves the native library.

The initial hardened ad-hoc dylib launch was refused by dyld before main because library validation requires matching Team IDs. Its exact rejected receipt/binaries remain under ignored `out/stream-fixture-v3-rejected-adhoc-dylib`; durable failure metadata is `results/2026-10-12-stream-fixture-rejected-adhoc-dylib.json`. The selected build statically links unchanged libkrun, retaining hardened runtime and library validation. Preflight verifies strict signature, runtime flag, exactly the hypervisor entitlement, no debugger/library-validation exception, and system-only dynamic dependencies: Hypervisor, libiconv and libSystem. No Keychain identity or signing keys were used.

Nineteen no-VM tests pass. Ten added lifecycle/deadline tests use real sleeping direct children and actual socket transfer: failures after ACK, interruption after ACK, oracle start failure, failure after actual oracle thread start, partial telemetry reader start, interruption inside capture, finite unreapable-child uncertainty, actual runner refusal to inspect disk/raw files under uncertain ownership, and compiled nanosecond/positive-progress deadline checks. The original nine tests cover: all-byte/offset oracle, real SCM_RIGHTS duplex peer transfer/CLOEXEC, malformed transfer refusal, raw duplex capture, tamper evidence, byte cap, finite deadline, missing guest/backpressure rejection and full source/artifact dependency binding. Actual run mode without an independent review receipt refuses before spawn. Replacement no-VM receipts and raw sandbox logs use `results/2026-10-12-stream-fixture-v2-*`. Personal absolute prefixes in durable build/refusal/dyld logs are normalized to `${REPOSITORY_ROOT}`; original local output remains ignored under out. Artifact/source hashes are unchanged.

## Prepared Linux workload and budgets

`stream_fixture_init.c` preserves the RAW guest's two direct-I/O threads, three 256 MiB allocation/free/zero/reuse cycles, 32 MiB retained every-word sentinel and one-second heartbeat. The 64 MiB synthetic RAW disk and per-thread 4 MiB extents are unchanged. Each disk thread remains bounded at 1,400 iterations with 256 KiB owned buffers; read/write/flush operations remain below 6,000.

The measured Apple 6.18.35 kernel is reused (hash `fb2cfb79eb1ae19447a85d75682d7fa5cfec97e24beb2609a492b806e8072c8d`). Its base configuration enables HVC and virtio-console; actual guest discovery/boot is still unperformed. The prepared guest requires exactly one `hvc0`, discovers its major/minor from sysfs, sets raw termios, reads back the non-transforming flags and starts separate binary RX/TX threads. Each owns 64 KiB, has at most 256 frames (16 MiB per direction) and an absolute ten-second monotonic frame deadline, checked before and after every I/O attempt, including positive short operations and the final successful operation; equality expires and nanoseconds are compared. Every aligned 256-byte span includes all values, including NUL/CR/LF/DEL; offsets and directions determine the expected byte. Both threads finish and join before poweroff, followed by a one-second bounded output grace.

`stream_fixture_oracle.py` captures actual sent/received bytes to separate binary files (16 MiB per direction, 32 MiB total). Individual peer calls are at most 16 KiB; no line decoding or TTY is applied to these captures. Host input begins only after verified guest bytes, proving raw mode was established before host input. The three-second initial host read pause can exercise guest TX readiness. The two-second initial guest RX sleep is pacing only: it ends before host input normally begins and does not force initial host TX backpressure. Later 250 ms guest RX pacing and the small public peer send buffer can produce host WouldBlock; the real run must observe it rather than assume it. Host WouldBlock and short-write counts and guest wait/short-operation counts are metadata. Readiness stalls do not establish a blocked OS syscall.

The worker has two vCPUs, 768 MiB guest ceiling and 120-second alarm. Telemetry uses corrected stream-only `stream_capture_v2.py` with the original byte/time bounds: 130-second limit, 32 MiB/channel, 48 MiB total, 64 KiB lines, 80,000 parsed rows, 16 KiB reads and 64 queued chunks. Peer transfer has a ten-second parent timeout and three-second worker ACK timeout. Raw oracle has a 125-second deadline, 8,192 metadata rows and two one-second joins. The `stream_lifecycle.py` guard surrounds Popen and every subsequent operation, including metadata, ACK, oracle startup and capture. Any exception/cancellation finitely kills/reaps only its direct child, closes control/peer ownership and stops/joins an actually started oracle. The capture revision places reader startup inside cleanup and joins only started readers. Uncertain child/reader/oracle ownership skips disk/raw reads, hashes and integrity audit; metadata records that uncertainty. Frozen `block_capture.py` and RAW artifacts/results remain unchanged.

Only PL011, balloon, bounded RNG, one RAW block and one two-queue guarded console are admitted. No shares, network/vsock/DAX/GPU/audio/input/firmware/nested VM, credentials, keys or host pressure generation exist.

## Review and launch gate

Root must inspect the fixture before issuing a private manually supervised receipt with `accepted:true`, the exact current `buildSha256`, and `heavyCompileQuiescent:true`. Launch also checks compiler quiescence, normal memory pressure (`memory_pressure -Q`, minimum 15% free), shared isolated worker ownership lock and no stale owned fixture. Source preparation and sandbox checks are available without that receipt:

```sh
python3 spikes/cowork-hvf/build_stream_fixture.py
python3 spikes/cowork-hvf/run_stream_fixture.py --sandbox-check
python3 -m unittest discover -s spikes/cowork-hvf -p test_stream_fixture.py -v
python3 -m unittest discover -s spikes/cowork-hvf -p test_stream_lifecycle.py -v
```

The receipt is not a replay-proof single-use or production authority token. After source/preflight review, root may authorize the intended single bounded run:

```sh
python3 spikes/cowork-hvf/run_stream_fixture.py --run-stream-fixture --review-receipt PATH
```

The actual libkrun EventManager/coordinator are used on that run. Checks require exact virtio inventory, both raw directions during every freed interval, binary integrity/count agreement, actual stream device-1 frozen pins/exclusion coverage, RAW capture/completion/ACK and disk integrity, reclaim epoch/mapping order, heartbeat and retained/reuse checks. Root must independently audit captures, footprint drops, all-byte oracle and pin/mapping receipts. The stage deliberately retains `activeReturnVerified:false` until that independent audit.

Normal poweroff/EOF is not an MMIO Stop/reset proof: `streamStopVerified:false` remains explicit. The unchanged native v3 tests supply separately scoped actual EventManager Stop/reset evidence; this guest fixture does not add live guest reset testing. It also does not establish genuinely blocked host disk syscalls; the inherited 25 ms hold remains post-I/O. Signed production authority, guest runtime confinement and full resource/integration gates remain open.

## Deferred encryption-specific gates

The accepted public stream is only a transport prerequisite. If private-disk encryption is introduced later, before keys: host-initiated one-shot delivery with no guest key requests; immutable initramfs receiver before user code; exclusive port, unbind/remove/drop-access before switch_root; ordinary-user and post-switch-root-root negative checks; generation/workspace/volume/boot-nonce binding; per-volume authenticated authority and broker custody. None is implemented or tested by this NONSECRET fixture.
