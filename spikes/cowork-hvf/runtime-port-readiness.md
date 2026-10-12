# Generic runtime port: source-only candidate

Prepared one generic non-console virtio port on the selected guarded libkrun/HVF backend. No VM, guest runtime, native worker or kernel was launched/rebuilt for this slice. Existing HVC/RAW sources, measured runs and aggregate results remain unchanged. The preceding HVC run's failed mandatory TX-EAGAIN assertion remains historical evidence; this candidate does not repeat that run or relabel it green.

Current build receipt: `out/runtime-port-candidate/build.json`, SHA-256 `e73dd694bded5a9b05b9d5a7dc553222b97713e44fe126a77256ef09f9825ba5`; identical durable copy: `results/2026-10-12-generic-runtime-port-build.json`. Static archive SHA-256 `a6e0c14231f4b82df82c32632c6c5f8203e7eb748a094ee6833498eb6ea920c2`.

`runtime-port-candidate.json` freezes separate source `out/libkrun-runtime-port`, incremental patch `0010-proposed-generic-runtime-port.patch` SHA-256 `62298de5d9176725d6a4bf0f79183a141de6d3162ff6085bce42ecd43f235752`, and full composed diff `6331d0e07ba4cfab8a318bd31ef52cf1645ffedfee6e46da185c568db0e15c2d`. The patch includes both complete new native modules. Preparation checks source/lock/patch hashes, private-index composition, module correspondence, unexpected files and byte-for-byte inherited HVC/socket/access/RAW/lifecycle modules. Existing frozen checkouts/artifacts stay untouched.

## Pinned Linux protocol and admitted topology

The primary-source basis is the previously hash-verified upstream Linux6.18.35 archive, extracted in `out/stream-hvc-source`, with provenance and member hashes in `results/2026-10-12-stream-hvc-kernel-source-audit.json`. Exact source-build equivalence with the separately measured binary remains unverified.

`virtio_console.c:1810–1855` selects four queues for MULTIPORT/max_ports1: data RX0, data TX1, control RX2, control TX3. `:1990–2058` initializes the control queues and reports DEVICE_READY with BAD_ID. `:1538–1623` adds port0 and applies host-open state; `:1399–1406` leaves MULTIPORT ports generic unless explicitly designated console. `:1034–1040` forbids the generic open path on console ports. `:776–838` honors O_NONBLOCK and uses asynchronous data submission. The inherited HVC callback does not provide that userspace behavior.

New public C variant `krun_create_cowork_runtime_stream(ctx_id)` uses the same closed private socketpair factory. The caller owns only the opposite peer; private descriptors stay library-owned, normalized CLOEXEC/nonblocking/SO_NOSIGPIPE. Prior RAW/reclaim opt-in is mandatory, missing contexts and duplicates are refused, and HVC/generic factories are mutually exclusive. The production caller must install its actual purpose-built no-fork/exec sandbox before factory use. No caller-FD intake, extra devices or host credential authority is added.

The new `GuardedPort` requires negotiated VERSION_1+MULTIPORT, advertises max_ports1, fixes all four queues at32 entries, and registers one guarded device1 alongside RAW device0. Its bounded control state machine accepts only:

1. Guest DEVICE_READY(BAD_ID,1), then host PORT_ADD(0,0).
2. Guest PORT_READY(0,1), then host PORT_OPEN(0,1).
3. Guest PORT_OPEN(0,1), after which data is admitted.
4. Guest PORT_OPEN(0,0), ACKed before terminal/UNCERTAIN recovery.

No CONSOLE_PORT designation, name, resize, remove, dynamic port, additional port or reopen is accepted. Every incoming frame is exactly eight owned bytes; event/ID/value/phase and exact length are checked. Unknown/duplicate/out-of-phase frames fail terminally. State advances only after a fresh generation-checked control-TX used ACK. At most one pending response and one RX/TX control frame exist; each payload is eight bytes (conservative24-byte combined payload ceiling). RX chains may report up to1 MiB but allocate only eight bytes and remain fully pinned. Control TX reports above/below eight bytes are refused. One control RX and one TX head are serviced per turn.

The worker services control before data, independently of the nonblocking data peer. It polls peer/Stop/four kicks with a20 ms retry and preserves bounded partial data writes. The new control queue leaf uses the inherited full ring/span/direction/producer validation, sealed request/ring pins and short generation-fenced copy/ACK leases. No guest-backed pointer reaches host I/O or the control parser. Freeze retains pending buffers/pins; reset retires the generation, keeps the old owner until real completion/join, and stages all four new ring owners. The shared two-device/32-pin/8 MiB budget remains enforced. Actual MMIO BadActivate marks terminal FAILED without mutex poisoning; lifecycle ticks clone device references before releasing the VMM lock.

Linux `__send_control_msg` itself still spins until ACK (`virtio_console.c:540–565`). Generic data is asynchronous; control open/close/bootstrap calls are not thereby proven cancellable. A failed control lane still needs bounded native service and out-of-band owned-worker termination/recovery. The one-boot port lifetime and terminal close behavior are deliberately narrower than hotplug or graceful reconnection.

## Native-only verification and next gate

The native harness passes100 test executions covering97 distinct test names (including nested helper executions). New generic coverage includes the actual four-queue Linux handshake/copy/ACK, host-data gate, control ACK during a filled data socket, control TX/RX pin lifetime through freeze, stale-generation no-ACK, malformed length/direction/span/state rejection, all phase/ID/value combinations, required feature negotiation, actual MMIO failure/no-poison and closed C API ownership/exclusivity. Inherited data/lease/reset tests use explicit test-only opened-state fixtures; the protocol tests exercise the default initial handshake state. HVC/socket/RNG/RAW/access/admission regressions also pass on the composed source. Native libkrun check, static library build and double-include C++ C-linkage header smoke check pass. No full Winter/daemon integration test is claimed.

```sh
python3 spikes/cowork-hvf/prepare_runtime_port.py
python3 spikes/cowork-hvf/test_runtime_port.py
python3 spikes/cowork-hvf/build_runtime_port.py
```

Durable metadata/logs use `results/2026-10-12-generic-runtime-port-*`; personal path prefixes are normalized in logs/test command receipts. The raw local test receipt remains under out with the hash bound by the build receipt.

Root and independent source review precede any new VM. The next separately authorized fixture must use the intended generic device, keep PL011 kernel telemetry separate, avoid console=hvc*, deliberately pause/disconnect the host data sink while the worker remains alive, and demonstrate data-writer backpressure with continued heartbeat/other guest work. It must also validate control ACK progress, pin/mapping exclusions, active RAM return and bounded out-of-band recovery on sink/control failure. Current signed-worker admission, generic Linux boot, live guest reset/cancellation, authenticated runtime framing/replay/cold continuity, trusted guest confinement and production integration remain unproved. Key delivery and separate workspace encryption remain deferred.
