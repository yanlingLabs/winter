# Guarded bootstrap stream v3: closed socketpair factory

Status: frozen no-VM candidate for root and independent review. The selected direction creates the private device endpoint inside libkrun and returns only its opposite peer. It uses public socket APIs and no private Darwin MSG_NBIO flag. This is construction safety, not a hostile-same-process or credential authority boundary.

The prior v2 checkpoint `020e1547586c26a95c9a8fe83ee84e064758e3c2`, its 0008 patch, private-ABI evidence, source checkout, manifests and receipts remain unchanged. V2 is historical and must not be used for a VM experiment. V3 also corrects v2's MMIO evidence: its old test wrote queue registers before FEATURES_OK, so it demonstrated nonready activation failure rather than the claimed ready cross-region descriptor-table rejection.

## Exact candidate

Pinned libkrun revision: `227b2de6ed323fe180e02f871c5f325a90c13cc2`, composed with preserved patches 0004–0008 plus `patches/0009-proposed-guarded-stream-closed-factory.patch`.

| Item | Value |
| --- | --- |
| Incremental patch SHA-256 | `ae46b3d1732cf6e00b3cb451334be04b222093cd78418b91b706d2a33a4f35c4` |
| Canonical composed native diff SHA-256 | `7ad027f83b8b51a5e0ec62da2546ad01b2dc5c111937be63874d5bd2278d03bd` |
| Manifest | `stream-candidate-v3.json` |
| Isolated source | `out/libkrun-stream-reclaim-v3` |
| Shared transport mirror | `stream_io_v3.rs` |
| Access mirror, unchanged | `stream_reclaim_access.rs` |

## Closed factory and ownership contract

The new C API `krun_create_cowork_bootstrap_stream(ctx_id)` requires explicit guarded RAW block/reclaim fixture admission. It creates a connected unnamed AF_UNIX SOCK_STREAM socketpair, establishes CLOEXEC on both descriptors and nonblocking/SO_NOSIGPIPE on the private device endpoint before publication, then retains the device object in the context. It returns only the opposite PEER descriptor, numbered at least3. The caller owns that returned peer and must close it. Peer blocking mode may be changed by the caller. A failed call returns negative errno, publishes no descriptor and closes all endpoints created by that call. Missing context, absent prerequisite admission and duplicate creation are refused before socket creation.

The old caller-FD setter `krun_set_cowork_bootstrap_stream` always refuses with `-EINVAL`, including named/unconnected/unnamed sockets and stdio. It consumes no caller descriptor. There is no replacement arbitrary-FD intake, connect API or public device-FD getter. Private device-end duplicates remain owned by Context/Device/Worker; their internal raw accessor is restricted to the device crate. No device descriptor is sent through SCM_RIGHTS. Both per-call public MSG_DONTWAIT and MSG_NOSIGNAL remain defense in depth; construction keeps the device endpoint's own nonblocking state independent of the peer.

Before a **production** worker creates the pair, its purpose-built sandbox must already deny process-fork and exec; the worker must never fork afterward. Threads remain allowed. CLOEXEC covers exec only and does not prevent bare fork inheritance. The library does not install a global atfork registry or prove this launch policy. A signed-worker fixture must later demonstrate actual process-fork denial before any secret-bearing guest run. No hostile code may execute inside the trusted VMM worker; this factory does not enforce that boundary by itself.

## Actual implementation and tests

| Source | Verification |
| --- | --- |
| `src/devices/src/stream_io.rs` | Actual factory/normalization/internal duplicate code. Tests prove both endpoint ownership/CLOEXEC, private nonblocking mode, internal duplicate closure and caller peer lifetime. An injected configuration failure exercises actual pair ownership and closes both endpoints before any publication. |
| `src/libkrun/src/lib.rs`, `include/libkrun.h` | Actual closed factory and refused setter, with C ownership/error contract. Native API tests verify prerequisite/duplicate/missing-context refusal, peer CLOEXEC, private-to-peer endpoint identity, peer ownership after context disposal, EOF after private endpoint disposal, and caller-FD refusals. Double C++ inclusion and LLVM symbol checks verify factory/setter C linkage. |
| `src/devices/src/stream_io.rs` adversarial subprocess | Creates the actual factory pair, duplicates only the public peer, toggles peer O_NONBLOCK and Darwin SO_NOSIGPIPE, and verifies private endpoint flags remain unchanged. It restores and verifies SIGPIPE SIG_DFL, observes empty read and full-buffer send WouldBlock, then survives closed-peer send. The owned subprocess has finite kill/reap control; no private ABI flag is used. |
| `src/devices/src/virtio/mmio.rs` | Actual MMIO statuses1,3,11 precede queue register writes. Tests verify queue ready/size/table/avail/used fields and read back ready state before status15. Separate nonready and valid-ready adjacent-region descriptor-table cases both reach guarded BadActivate and prove terminal Stop/wake77, FAILED, no poisoned mutex, no activation and no retained pins. The ready case also proves the historical endpoint-only Queue.is_valid would admit the table. |
| `src/devices/src/virtio/console/cowork_stream.rs` | All actual worker/lifecycle/reset/freeze tests now use the same closed factory. Short-send exact byte ordering/no replay, old-generation no ACK, RX bounds/cross-region rejection, pin retention and actual EventManager notify-before-finished retirement remain covered. Scoped deadline-preserving lifecycle polling and interrupted-wait regressions are preserved unchanged. |

From the Winter checkout:

```sh
python3 spikes/cowork-hvf/prepare_stream_v3.py
python3 spikes/cowork-hvf/test_stream_v3.py
```

The preparer checks exact patch composition, mirror/core correspondence and all source bytes. A separate clean clone from the local pristine source cache reproduced all 29 modified/added files and the canonical diff hash. The harness passed 73 executions covering 70 distinct test names: 23 outer stream cases, two real subprocess helper executions, inherited RNG/access/FRQ/block/bounce tests and two public stream API cases plus admission tests. One access case appears in two filters; two helper names are inert in the outer filter and execute for real only in their owned children. Native libkrun check passed without warnings using locked offline dependencies and two build jobs. The durable metadata-only receipts are `results/2026-10-12-guarded-stream-v3-tests.json`, `.log` and `-header.json`; stream payloads are not logged.

The historical 0006, 0007 and v2 preparers still match their preserved source hashes. The incremental native delta touches only the header, public stream API, stream construction/I/O tests, console test fixtures and corrected MMIO tests; RNG, reclaim access/control/barrier/coordinator, block and scoped EventManager polling implementations remain unchanged from their prior candidates.

## Remaining gates

No VM, guest driver boot, resource measurement, key, unlock, encryption, pressure, live Winter or production daemon operation occurred. Root and independent review must accept this exact source before a separately authorized guest experiment. Factory endpoint independence does not grant host credential authority or authenticate future packet framing. Terminal exit77 remains UNCERTAIN. Block reset still joins synchronously in MMIO, so no production reset/recovery claim follows. The signed-worker sandbox/no-fork gate remains untested here. Other asynchronous devices, encrypted storage, automatic resource policy and complete Cowork integration remain open. Deliberate readiness/backend stalls remain distinct from proof of a blocked OS syscall.
