# Linux RAW-plus-stream result and scope

Two bounded nonsecret stream runs occurred. The first (`39021332`, fixture
`stream-fixture-v3-p4m_1bcp`) booted and failed the guest's assumption that one HVC
class entry meant one connected console. It transferred no stream bytes and
receives no reclaim credit. Its unchanged logs/result and failure audit remain
under `spikes/cowork-hvf/results/2026-10-12-stream-fixture-failed-hvc-*`.

After source-grounded discovery correction `396ab84f` and root review, build
`b4e5b6908ecfa6eb220f478c4d0c27e59e28900c4d697ef9527d30b52e93d139`
ran once as `stream-fixture-v3-o32btt1i`, worker 12667. It completed all guest work,
exited 0 and was reaped; telemetry and oracle threads joined with EOF, no timeout
or overflow. The aggregate checker remains **false**, solely for missing guest TX
EAGAIN/readiness-wait coverage. Its original result is not rewritten.

## Independently verified positive evidence

Root checked all 1,048,576 final disk words (8 MiB), all 1,589 ordered RAW request
completions, 18 parked/remap/ACK/resume epochs and 299 mapping replacements.
Replacement spans avoid frozen exclusions; 38 stream-device pin observations
are included. Every freed interval contains both disk threads, both communication
directions and 10 heartbeats, with retained-data and zero-fill/reuse checks.

| Cycle | Worker footprint returned |
| --- | ---: |
| 1 | 238.406 MiB |
| 2 | 236.281 MiB |
| 3 | 236.063 MiB |

Root and Astra separately regenerated and checked both captured byte patterns:
12,451,840 bytes guest-to-host and 10,948,608 bytes sent host-to-guest. The guest
validated the 10,158,080-byte consumed prefix; a 790,528-byte sent suffix is not
claimed delivered. Host instrumentation observed 115 WouldBlock writes and
2,005 short writes. Actual raw captures are preserved losslessly as small gzip
artifacts with raw/compressed hashes in `2026-10-12-stream-raw-captures.json`.

The root audit is `spikes/cowork-hvf/results/2026-10-12-stream-root-audit.py` with
its separate JSON receipt. It is read-only and accepts the retained fixture
directory; it starts no process/VM and mutates no evidence. Astra's separate
script/receipt use `2026-10-12-stream-postrun-independent-audit.*`; its
[review](2026-10-12-cowork-stream-postrun-independent-review.md) checks raw log
correspondence and explains the Linux driver behavior.

## Remaining limits and next integration

HVC can spin inside the kernel until a host ACK and then return a full successful
write. A zero guest EAGAIN count is therefore not a necessary indication of
absent backpressure. The fixture's userspace frame clock cannot preempt that
syscall. No direct native TX-capacity wait or guest syscall duration was measured;
normal poweroff/EOF is not live MMIO Stop/reset proof. RAW request holds remain
explicit post-I/O holds, not a blocked host disk syscall.

These results verify active RAM return during this restricted RAW-plus-stream
workload. They do not pass the full resource or production gate. No guest Winter
runtime, folder sharing, network, credentials, schedules or product UI ran.
Separate workspace encryption is deferred from the first version.

The next transport implementation uses one generic non-console port with the
minimum MULTIPORT/control handshake, preserving the same guarded backend and
memory ownership rules. It selects Linux's asynchronous data path; new control
queues need their own bounded parsing, pin/reset and failure tests. Control
handshakes can still wait for host ACKs, so independent whole-worker recovery
remains necessary. Do not extend the two-queue console evidence to the new port
without validation. No repeat of the console run is needed merely to make its
aggregate checker green.
