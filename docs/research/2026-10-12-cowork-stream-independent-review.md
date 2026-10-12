# Independent native review: guarded stream candidate

Date: 2026-10-12. **Disposition: hold the next VM pending the two scoped corrections below and review of their new frozen candidate.** No additional RAM-lease, pinned-range or asynchronous console-reset ownership blocker was found in the inspected source. This does not approve a guest key channel, encrypted disk, production teardown or resource-return result.

Reviewed frozen source: base `227b2de6ed323fe180e02f871c5f325a90c13cc2` plus accepted patches 0004–0006 and stream patch 0007. Patch SHA-256: `4acf7d82622d98ca1265e6a57bcd167f6df1fd5efb6a63cc65a9f6b24f35e044`. Composed source diff SHA-256: `0358d69bb472f5d7fb632d466298240c2025742fd47858f53be21bc344cb183b`. Native paths below are relative to `spikes/cowork-hvf/out/libkrun-stream-reclaim`; the two reviewed root mirrors are `spikes/cowork-hvf/stream_io.rs` and `stream_reclaim_access.rs`.

## 1. Blocking: owned duplication does not make nonblocking or SIGPIPE flags immutable

`src/devices/src/stream_io.rs:19` duplicates the descriptor with `F_DUPFD_CLOEXEC`; it does not create an independent open-file description. Admission sets `O_NONBLOCK` at `:66–68`, but `read_owned` calls plain `read` at `:100–101` and macOS `write_owned` calls `send` with flags zero at `:114–117`.

The caller retains the original descriptor, and any alias can clear the shared `O_NONBLOCK` later. The next read with no data or write under backpressure can then block inside the syscall, where polling `stopfd` cannot interrupt it. Console reset correctly retains that worker and its pins, but retirement/reactivation can consequently remain pending indefinitely. A documented future caller-close convention is not enforcement of the current API's bounded-I/O claim.

The same concern applies to the shared socket option `SO_NOSIGPIPE` set at admission. An alias can clear it, after which a closed-peer macOS send may raise SIGPIPE instead of returning the expected terminal I/O fault. The installed Apple SDK's primary `sys/socket.h` declares both per-call flags: `MSG_DONTWAIT` at line 578 and `MSG_NOSIGNAL` at line 594.

Use `recv(..., MSG_DONTWAIT)` and `send(..., MSG_DONTWAIT | MSG_NOSIGNAL)` on supported targets, retaining admission-time flags as defense in depth. Regression coverage must clear `O_NONBLOCK` through the original/alias after admission and show empty receive and saturated send return WouldBlock promptly. On macOS also clear `SO_NOSIGPIPE` through an alias and show closed-peer send returns an error without signal termination. Check actual Worker stop/pin behavior after this change, not only the leaf helper.

## 2. Required integration correction: malformed activation reaches an MMIO panic

`src/devices/src/virtio/console/cowork_stream.rs:483–487` stops access and returns `ActivateError::BadActivate` when queue admission fails. The real transport, `src/devices/src/virtio/mmio.rs:317–320`, unconditionally calls `.expect("Failed to activate device")` while holding the device mutex.

Consequently a malformed guest queue at DRIVER_OK can panic the vCPU thread and poison the console mutex. VMM exit cleanup also uses `.expect("Poisoned mutex for exit observer")` at `src/vmm/src/lib.rs:388–392`, so the claimed wake/exit-77 path is not established for this input. This finding is about terminal/lifecycle behavior, not a demonstrated RAM escape. An unexpected process abort must remain UNCERTAIN and cannot become clean completion.

Handle guarded-console activation failure without unwinding through the device lock, preserving the terminal notifier and refusal. Add a same-source no-VM regression that drives malformed queue readiness/full-ring spans through the actual MMIO status/activation path and checks no panic, no used ACK, stopped access and retained/cleanly disposed ownership as appropriate. Direct tests of `capture` or `VirtioDevice::activate` do not exercise this transport behavior. The old guarded block shares the upstream panic pattern; this report neither changes nor upgrades its historical acceptance.

## Inspected memory and lifecycle boundary

`cowork_stream.rs:104–166` acquires a lease and runs queue inspection/TX copying inside `Lease::operation`. Returned state contains copied descriptor scalars/ranges and owned buffers; no guest pointer, VolatileSlice or DescriptorChain escapes into host I/O. The request pin is published before the lease drops. RX limits its owned allocation to 16 KiB while pinning the full admitted destination, and TX limits the copied request to 64 KiB.

`stream_reclaim_access.rs:299–314` serializes the short operation with generation retirement using the access-state mutex. Its inspected stream closures perform bounded queue validation/copies/used-ring writes and contain no readiness, trace or host I/O waits. Existing leases can finish and publish pins after admission closes; freeze waits for their count to become zero before snapshotting exclusions. Completion obtains a fresh checked lease, so frozen completion defers with its request pin retained and retired generations cannot resume copying or ACKing.

`cowork_stream.rs:224–341` performs socket operations and poll with owned buffers after the memory leaf returns. Partial TX progress is retained as an offset. The permanent ring pins remain owned by `StreamQueues`; request pins remain in `Frame`. Local reset can allow an already-started owned I/O operation or short fenced copy to finish before retirement takes the state lock, as the readiness document states. This is not exactly-once framing.

Reset at `cowork_stream.rs:503–515` sets Stop, wakes the worker and logically retires its generation without joining in MMIO. The thread return packet owns the complete `Worker`, including queues, pins and pending data, until the finished-thread join in `progress_lifecycle`. A staged replacement owns its new ring pins immediately and starts only after the prior owner is joined. `cowork_stream_tick` clones the console reference under the VMM lock and releases that lock before lifecycle work. The outer event loop uses the 5 ms timeout while retirement/reactivation is pending, so an early done notification is not the only opportunity to reap.

General destructor/exit behavior is a separate boundary: `GuardedConsole::drop` requests stop and drops its JoinHandle rather than proving a join; the owned worker/memory references then live until the thread finishes. The normal VMM stop ends the process with `_exit`. Do not extend the explicit reset/join guarantee to a general reusable in-process VMM destructor or a production custody receipt. Existing synchronous block reset remains unchanged and can still hit the CPU-park timeout.

## Admission, RNG and test gaps

The public setter checks guarded-block opt-in before accepting a stream. The owned duplicate is validated for SOCK_STREAM, connected local/peer AF_UNIX identities and zero name bytes; duplicate registration, stdio descriptors and datagrams refuse. The fixed builder adds one console token to the same Access instance used by block token 0, with two-device/32-pin/8 MiB bounds. It does not instantiate upstream multiport/control/volatile console workers. The broader profile still rejects the unproved device families before VM allocation.

Only the stream profile enables bounded RNG. Its complete chain validation precedes entropy production, guest length is capped at 64 KiB, scratch is 4 KiB, and one event turn handles at most 32 heads. This path remains serialized on the main event thread with reclaim coordination; no new independent RNG DMA worker was found. Do not describe those byte/iteration bounds as a universal syscall wall-clock deadline.

The required regressions for findings 1–2 should be included in the corrected candidate's no-VM suite. Additional targeted gaps worth closing before relying on the stated behavior in the next fixture are:

- Actual event-manager lifecycle progress after a deliberately early done notification while the worker is not yet finished. Current reset tests directly call `progress_lifecycle`; they do not execute the main-loop timeout path.
- Positive partial-TX/backpressure recovery with a multi-chunk request, verifying byte order/no duplication through freeze/resume. Current backpressure tests establish WouldBlock/Stop, but not a successful short-write continuation followed by completion.
- Specific RX maximum/cross-region admission cases and named/unconnected stream-FD refusals. Source checks are present; current distinct tests concentrate on TX malformed spans, stdio/datagram rejection and the unnamed positive control.

These do not substitute for the next VM's actual Linux console-driver/TTY behavior, signed worker sandbox compatibility or active memory-return measurements. Before an encrypted run, the block backend still needs the documented deliberate stall **inside** `perform`; a post-I/O hold or nonblocking readiness stall is different evidence.

A safe byte stream alone does not authenticate a home/workspace/volume or authorize key release. Future keys require exact launch/descriptor custody, a framed generation/nonce protocol, raw guest terminal configuration, a protected trusted receiver and stale-byte/reset handling. None is implemented or accepted here. No payload logging or packet parsing was found in this native stream candidate.

## Independent verification

Ran `python3 spikes/cowork-hvf/test_stream.py` against the frozen candidate. Its preparation verified the patch, base patches, lockfile, exact composed diff, private-index incremental diff and actual/mirrored source correspondence. All **59 test executions / 58 distinct tests passed**, followed by a successful native `cargo check`. The duplicated execution is the access retirement test included by two filters. No VM, key, guest format, pressure workload or live Winter home was used.

The historical header-smoke receipt was inspected but not independently rerun. No implementation file was edited or pushed. The script's generated ignored test receipt and this report are the only intentional output artifacts from this review. Preserve 0007 and record the corrections as a new exact candidate before re-review.
