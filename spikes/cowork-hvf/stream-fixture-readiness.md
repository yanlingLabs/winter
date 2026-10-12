# NONSECRET guarded stream fixture: prepared, not booted

This fixture prepares the independently accepted frozen v3 native source for one bounded Linux/HVF run. No VM has launched. The prior restricted reclaim and RAW disk results, sources, native patches and artifacts remain unchanged. This is not key transport, encrypted storage, production signing or completed Cowork integration.

Current review build receipt: `out/stream-fixture-v3/build.json`, SHA-256 `b5a4f8b0b53dc856c5bb787e0d8f5aa21494ea1d1f02830baf8f75681823d2f9`. Identical durable copy: `results/2026-10-12-stream-fixture-prelaunch-build.json`. The build binds frozen `stream-candidate-v3.json`, every artifact and every custom launch/audit import. `prepare_stream_v3.py` verifies the unchanged composed native diff and shared modules. No new native patch or crypto kernel is introduced.

## Actual no-VM evidence

`stream_fixture_worker.c` installs a deny-default Seatbelt profile with explicit process-fork/exec denials before calling `krun_create_cowork_bootstrap_stream`. The actual hardened, ad-hoc signed worker passes sandbox state checks, fork/exec EPERM, fixture RAW read/write/full-sync, denial of unrelated writes, `/etc/hosts` reads and a loopback outbound connection. It proves the closed library factory succeeds inside this profile, transfers only the opposite peer over an inherited unnamed control socketpair, closes its returned peer, performs a bounded parent acknowledgement, and creates/joins a thread. Context destruction produces EOF on the transferred peer. No private device FD leaves the native library.

The initial hardened ad-hoc dylib launch was refused by dyld before main because library validation requires matching Team IDs. Its exact rejected receipt/binaries remain under ignored `out/stream-fixture-v3-rejected-adhoc-dylib`; durable failure metadata is `results/2026-10-12-stream-fixture-rejected-adhoc-dylib.json`. The selected build statically links unchanged libkrun, retaining hardened runtime and library validation. Preflight verifies strict signature, runtime flag, exactly the hypervisor entitlement, no debugger/library-validation exception, and system-only dynamic dependencies: Hypervisor, libiconv and libSystem. No Keychain identity or signing keys were used.

Nine no-VM tests pass: all-byte/offset oracle, real SCM_RIGHTS duplex peer transfer/CLOEXEC, malformed transfer refusal, raw duplex capture, tamper evidence, byte cap, finite deadline, missing guest/backpressure rejection and full source/artifact dependency binding. Actual run mode without an independent review receipt refuses before spawn. Durable no-VM receipts and raw sandbox logs use `results/2026-10-12-stream-fixture-*`. Personal absolute prefixes in durable build/refusal/dyld logs are normalized to `${REPOSITORY_ROOT}`; original local output remains ignored under out. Artifact/source hashes are unchanged.

## Prepared Linux workload and budgets

`stream_fixture_init.c` preserves the RAW guest's two direct-I/O threads, three 256 MiB allocation/free/zero/reuse cycles, 32 MiB retained every-word sentinel and one-second heartbeat. The 64 MiB synthetic RAW disk and per-thread 4 MiB extents are unchanged. Each disk thread remains bounded at 1,400 iterations with 256 KiB owned buffers; read/write/flush operations remain below 6,000.

The measured Apple 6.18.35 kernel is reused (hash `fb2cfb79eb1ae19447a85d75682d7fa5cfec97e24beb2609a492b806e8072c8d`). Its base configuration enables HVC and virtio-console; actual guest discovery/boot is still unperformed. The prepared guest requires exactly one `hvc0`, discovers its major/minor from sysfs, sets raw termios, reads back the non-transforming flags and starts separate binary RX/TX threads. Each owns 64 KiB, has at most 256 frames (16 MiB per direction) and a ten-second frame deadline. Every aligned 256-byte span includes all values, including NUL/CR/LF/DEL; offsets and directions determine the expected byte. Both threads finish and join before poweroff, followed by a one-second bounded output grace.

`stream_fixture_oracle.py` captures actual sent/received bytes to separate binary files (16 MiB per direction, 32 MiB total). Individual peer calls are at most 16 KiB; no line decoding or TTY is applied to these captures. Host input begins only after verified guest bytes, proving raw mode was established before host input. A three-second initial host read pause and two-second guest RX pause exercise readiness backpressure. Host WouldBlock and short-write counts and guest wait/short-operation counts are metadata. Readiness stalls do not establish a blocked OS syscall.

The worker has two vCPUs, 768 MiB guest ceiling and 120-second alarm. Telemetry uses the unchanged bounded capture: 130-second limit, 32 MiB/channel, 48 MiB total, 64 KiB lines, 80,000 parsed rows, 16 KiB reads and 64 queued chunks. Peer transfer has a ten-second parent timeout and three-second worker ACK timeout. Raw oracle has a 125-second deadline, 8,192 metadata rows and two one-second joins. Only the owned direct child is killed/reaped. Uncertain child exit skips all disk reads/hashes; uncertain oracle completion skips raw-file hashes.

Only PL011, balloon, bounded RNG, one RAW block and one two-queue guarded console are admitted. No shares, network/vsock/DAX/GPU/audio/input/firmware/nested VM, credentials, keys or host pressure generation exist.

## Review and launch gate

Root must inspect the fixture before issuing a private one-run receipt with `accepted:true`, the exact current `buildSha256`, and `heavyCompileQuiescent:true`. Launch also checks compiler quiescence, normal memory pressure (`memory_pressure -Q`, minimum 15% free), shared isolated worker ownership lock and no stale owned fixture. Source preparation and sandbox checks are available without that receipt:

```sh
python3 spikes/cowork-hvf/build_stream_fixture.py
python3 spikes/cowork-hvf/run_stream_fixture.py --sandbox-check
python3 -m unittest discover -s spikes/cowork-hvf -p test_stream_fixture.py -v
```

After source/preflight review, the separately authorized one-run command is:

```sh
python3 spikes/cowork-hvf/run_stream_fixture.py --run-stream-fixture --review-receipt PATH
```

The actual libkrun EventManager/coordinator are used on that run. Checks require exact virtio inventory, both raw directions during every freed interval, binary integrity/count agreement, actual stream device-1 frozen pins/exclusion coverage, RAW capture/completion/ACK and disk integrity, reclaim epoch/mapping order, heartbeat and retained/reuse checks. Root must independently audit captures, footprint drops, all-byte oracle and pin/mapping receipts. The stage deliberately retains `activeReturnVerified:false` until that independent audit.

Normal poweroff/EOF is not an MMIO Stop/reset proof: `streamStopVerified:false` remains explicit. The unchanged native v3 tests supply separately scoped actual EventManager Stop/reset evidence; this guest fixture does not add live guest reset testing. It also does not establish genuinely blocked host disk syscalls; the inherited 25 ms hold remains post-I/O. Signed production authority, guest runtime confinement and full resource/integration gates remain open.

## Separate later key gates

The accepted public stream is only a transport prerequisite. Before keys: host-initiated one-shot delivery with no guest key requests; immutable initramfs receiver before user code; exclusive port, unbind/remove/drop-access before switch_root; ordinary-user and post-switch-root-root negative checks; generation/workspace/volume/boot-nonce binding; per-volume authenticated authority and broker custody. None is implemented or tested by this NONSECRET fixture.
