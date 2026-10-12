# Guarded bootstrap stream correction candidate 0008

Status: frozen no-VM candidate for independent re-review. This increment is composed on pinned libkrun `227b2de6ed323fe180e02f871c5f325a90c13cc2` plus the preserved 0004–0007 patches. Historical 0007 remains at checkpoint `176a502d1097fc809ddd486e6459b0cf87722925`, with SHA-256 `4acf7d82622d98ca1265e6a57bcd167f6df1fd5efb6a63cc65a9f6b24f35e044`. Its source, root mirrors, manifest and receipts are unchanged.

The new incremental patch is `patches/0008-proposed-guarded-stream-reviewed-fixes.patch`, SHA-256 `43331eedec8e73f735830932b56c28cb3eb311f1c9bcbf3535f497063a369378`. The composed native diff SHA-256 is `2c54f1a224d8d17be652e160d823c05b1b6bb8fc9da00f305b944a6d5eaac31b`. The manifest is `stream-candidate-v2.json`; the isolated prepared source is `out/libkrun-stream-reclaim-v2`.

## Changes and actual source entry points

| Change | Native files and checks |
| --- | --- |
| Caller aliases cannot restore blocking I/O or expose SIGPIPE | `src/devices/src/stream_io.rs`: `read_owned` uses `recv(MSG_DONTWAIT)`; `write_owned` uses `send(MSG_DONTWAIT|MSG_NOSIGNAL)` on Linux and adds private Darwin `MSG_NBIO` on macOS. Admission flags remain defense in depth. The bounded owned subprocess clears the shared OFD's O_NONBLOCK and Darwin SO_NOSIGPIPE through the original alias, proves SIGPIPE is SIG_DFL, observes an empty read and full-buffer send return WouldBlock, and survives a closed-peer send. |
| Malformed guarded-console activation does not panic under the MMIO mutex | `src/devices/src/virtio/mmio.rs`: only the actual GuardedConsole branch handles BadActivate with terminal Access Stop/wake and FAILED status. The real MMIO queue/status-write test supplies a descriptor table crossing two adjacent RAM regions and verifies exit-code notifier 77, wake, no activation and no poisoned mutex. Historical other-device `.expect` behavior remains unchanged. |
| Retirement retry honors its requested wait | `src/utils/src/macos/epoll.rs`: separate `wait_cowork_lifecycle` uses an absolute deadline and retries EINTR without resetting it. `src/polly/src/event_manager.rs`: `run_cowork_lifecycle_timeout` dispatches that actual poll. `src/libkrun/src/lib.rs` uses it only while guarded-console lifecycle work is pending. Generic historical waits remain unchanged. Exact EventManager tests exercise zero, positive and repeatedly interrupted waits; the signal test runs in an owned subprocess with finite kill/reap control. |
| Lifecycle test shares actual production progress code | `src/devices/src/virtio/console/cowork_stream.rs`: `lifecycle_tick` is called by `src/vmm/src/lib.rs` after dropping the VMM mutex. The actual EventManager test consumes completion notification before the old thread finishes, retains old/new ownership and pins, then joins and starts the pending generation after completion without a second notification. The new generation performs real duplex socket I/O and retires through event dispatch. |
| Adversarial bounded stream coverage | Actual short sends occur with a small socket send buffer. Freeze/resume preserves exact byte order and a single used completion; reset delivers only the already-sent prefix and no old completion/replay. RX tests enforce the 16 KiB owned buffer, 1 MiB reported-chain ceiling and single-region bounds. Named connected Unix sockets and unconnected Unix descriptors are refused; tests create and remove only their private temporary endpoint. |

The prior requested five-millisecond lifecycle retry was **not honored** by 0007's macOS shim: it calculated `_tout` but passed a fixed three-second timespec. The old readiness prose's retry duration is not established timing evidence. 0008 establishes only the scoped native wait behavior and these bounded no-VM tests, not a production scheduler or timing guarantee.


The last pre-freeze adversarial full-buffer regression failed with public `MSG_DONTWAIT|MSG_NOSIGNAL` alone after alias mutation. Its owned three-second watchdog killed and confirmed reaping the test child; metadata and rejected source hashes are retained in `results/2026-10-12-guarded-stream-v2-public-flags-rejected.json` and `.log`. A separate bounded Python socketpair probe reproduced the behavior. Apple XNU [sosendcheck](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/uipc_socket.c#L1959) checks SS_NBIO or MSG_NBIO for the capacity wait, while MSG_DONTWAIT controls socket-buffer lock acquisition. The [private header](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/socket_private.h#L569) defines MSG_NBIO as 0x20000. The candidate explicitly names this macOS-only private ABI and its pinned source. The alias/full-buffer/SIG_DFL native subprocess succeeds with it. Measured host: macOS 26.6.1 build25G76 / Darwin25.6.0. This feasibility dependency requires independent review and target-host regression; it is **not accepted production ABI**. A stable public transport/ownership alternative remains a production prerequisite.

## Reproduction and evidence

From the Winter checkout:

```sh
python3 spikes/cowork-hvf/prepare_stream_v2.py
python3 spikes/cowork-hvf/test_stream_v2.py
```

The preparer verifies every patch, canonical composed diff, unchanged inherited core modules and root/native mirror correspondence. An independent clean clone from the local pristine cache reproduced all 29 modified/added source files and the same canonical diff. The test harness runs the actual device/transport/EventManager implementation plus inherited access, RNG, FRQ, block, bounce and public admission tests, with offline locked dependencies, two build jobs and serial outer tests. Worker/socket/freeze/reset concurrency is real inside the tests.

`results/2026-10-12-guarded-stream-v2-tests.json` binds 12 input files, all 29 changed native files, exact commands and the successful clean composition. Its metadata-only log records 71 test executions covering 68 distinct test names, including two real child executions of env-gated helper names and the access case selected in two filters. Native libkrun check passed without warnings. Tests assert byte equality without logging stream contents; child arguments/env carry only test selection and boolean fixture flags.

Both historical preparers were also checked: `prepare_stream.py` still matches frozen 0007; `prepare_block.py` still matches frozen 0006. No old artifact, evidence or kernel file was altered.

## Remaining scope

There was no VM, key, unlock, encrypted-disk, pressure, live Winter or production daemon operation. The single-port fixed queue/device roster and all 0007 buffer/pin ceilings remain unchanged. Byte transport memory safety supplies no host credential authority or authenticated bootstrap framing. Terminal exit 77 remains UNCERTAIN; it is not a clean recovery receipt. Block reset still synchronously joins in MMIO, so no production reset claim is made. DAX, filesystem, networking/vsock, GPU/audio/input and hotplug remain excluded. Deliberate host poll/backend stalls remain distinct from proof of a genuinely blocked OS syscall. New VM work requires independent review of this exact candidate and separate root authorization.
