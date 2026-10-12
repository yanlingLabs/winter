# Signed generic-port fixture: prepared, not launched

This fixture prepares actual Linux generic-driver validation on the accepted0010 backend. The new signed artifact has passed sandbox-only preflight; neither normal nor terminal-close VM scenario has launched. Prior HVC/RAW sources, all runs/results and the accepted generic0010 source remain unchanged. No encryption, key delivery, credentials, live Winter home/daemon/app, real shares or network are used.

Exact build receipt: `out/generic-fixture/build.json`, SHA-256 `821c5f7341f760bb0e5f1e584115bf5e247438d13f5c7883d0e143e4c164e9d3`; identical durable copy: `results/2026-10-12-generic-fixture-prelaunch-build.json`. Worker SHA-256 `9c40eb0bdcf8cb3232fd6af91d89a108dd33950b887180ec7f111dc18892cc45`; guest init `afd6b543b53e506efcaabeb80dc332acd4059b6c9a86dbb90aa63d21523395c8`. Every custom launch/audit import and compiled source/header is bound. The unchanged measured kernel is `fb2cfb79eb1ae19447a85d75682d7fa5cfec97e24beb2609a492b806e8072c8d`.

## Separate fixture-only trace candidate

`runtime-port-trace-candidate.json` selects new `out/libkrun-runtime-port-trace` and incremental0011, leaving0010 intact. Patch SHA-256 `fe41eb3b7891d4c7bb7fa61d43508d4173d9e72a27b9476bb4de0c64ea5815c0`; full composed diff `c39d78098ca2a994182a2361e8fe21aac956ef8a943d1cffe7ed49df4eab306c`. `prepare_runtime_port_trace.py` verifies private-index composition, module mirrors and frozen inherited source equality.

New `krun_enable_cowork_runtime_port_fixture_trace` requires the existing generic runtime factory plus RAW/reclaim opt-in. Trace defaults off. When enabled, it records only control used-ACK metadata: row, queue, ID, event, value and usedAck. It is called after actual generation-checked used ACK, outside RAM leases, before pending phase/response disposal. No data-lane payload, name, message or credentials are logged. A shared atomic counter caps the whole device lifetime, including reactivations, at64 rows; overflow fails terminally. Native tests prove exact fields/cap, wrong queue/size refusal, opt-in requirements and zero trace rows during freeze until actual ACK after resume. Logging is fixture instrumentation and adds no real-time service guarantee.

`generic_fixture_worker.c` statically links this source, is ad-hoc signed with hardened runtime, and retains library validation with exactly the hypervisor entitlement and no debugger exception. Its runtime dependency closure is Hypervisor/libiconv/libSystem. It installs the purpose-built sandbox, verifies actual fork/exec EPERM before pair creation, creates the runtime stream through the closed factory, enables trace, and transfers only the opposite peer over an unnamed control socketpair. All inherited RAW full-sync/identity and host read/network/unrelated-write checks passed in this actual signed process. No VM starts in sandbox-check mode; context destruction produced peer EOF and verified child reaping/quiescent owners.

## Prepared guest and host boundary

`generic_port_discovery.h` requires exactly one virtio-console device bound to virtio_console, exact VERSION_1+MULTIPORT features, one port0 with the matching canonical parent, positive dynamic character major and minor0. The guest creates only that private node and validates its type/rdev before and after no-follow/nonblocking open. Successful generic open is followed by non-TTY and exclusive-owner checks (second open must return EBUSY). Queue identity0/1/2/3 comes from the checked single-port feature/driver plus frozen native configuration. PL011 remains the only kernel console; no console=hvc* option or TTY mode is used for runtime data. The supervisor retains one FD shared by the two data threads.

The host's deliberate six-second read stall starts after the first verified guest bytes, with periodic probes of its own Popen child to establish worker liveness. It continues host-to-guest writes independently. An initial4 MiB guest TX burst fills the asynchronous generic data queue; an EAGAIN receipt is counted as saturated backpressure only after at least1 MiB accepted, excluding initial host-connect pacing. Guest and host record byte counts and readiness/short-operation metadata; these are not blocked-host-syscall evidence. Audits require heartbeat, both disk threads and worker-alive receipts during the stall. The startup/open control ACK is separately recorded; control close under a stalled data lane belongs to the separate terminal scenario below.

Normal mode preserves the prior three256 MiB allocation/free/zero/reuse cycles,32 MiB retained every-word sentinel, one-second heartbeat, two bounded256 KiB O_DIRECT disk threads,64 MiB synthetic disk and per-thread4 MiB extents. Stream threads own64 KiB each, at most256 frames/16 MiB per direction, with absolute ten-second monotonic frame deadlines on every I/O attempt. After they join, a two-second drain grace precedes disk-thread join/final fsync. The supervisor port remains open through poweroff; it sends no guest-close control message. Normal exit77 is a failure and is not hidden.

`generic_fixture_oracle.py` validates/captures every received/sent byte, with16 KiB calls and16 MiB per direction. Known normal owner exit drops pending host writes and overrides the pause to drain queued bytes through EOF within the bounded oracle lifetime. Terminal-close exit deliberately retains partial capture/EOF uncertainty. The supervisor retains immediate post-Popen cleanup for startup faults, partial reader start and interruption; uncertain child/reader/oracle ownership skips disk/raw inspection.

## Deliberate terminal-close scenario

A distinct worker/kernel mode waits for saturated TX EAGAIN and four heartbeat ticks while the host sink is stalled. It requests/join-stops the two userspace stream threads (partial accepted bytes are explicitly recorded), then closes the supervisor FD while kernel/native data remains backpressured. Joining first prevents fd reuse and userspace EBADF races. The native close used-ACK must appear as the sixth exact control receipt, with the oracle still reporting an active stalled sink. Exit77 and confirmed owned-child reaping are expected; effects remain UNCERTAIN. Guest close-return telemetry is optional observation, distinct from host-published used ACK. Disk hash/integrity/resource-return audits are deliberately skipped for this scenario. It adds no graceful-close or exactly-once/replay guarantee.

## Bounds, verification and review handoff

Budgets remain2 vCPUs,768 MiB guest ceiling,120-second worker alarm and130-second capture limit. RAW threads remain at most1,400 iterations each/<6,000 read/write/flush operations. Telemetry retains32 MiB/channel,48 MiB total,64 KiB lines,80,000 rows,16 KiB reads and64 queue items. Raw binary capture adds at most32 MiB total; oracle has125-second deadline,8,192 event rows and finite joins. Control transfer is ten seconds with a three-second worker ACK deadline. Only the direct owned Popen child can be killed/reaped. Normal and close scenarios retain separate checks/outcomes.

104 native test executions/101 distinct names pass on0011;25 Python tests pass (7 compiled C discovery,10 lifecycle/deadline,8 actual oracle/receipt/runner regressions). Tests include normal-owner exit during pause with pending bytes/EPIPE risk, terminal partial capture, actual normal runner aggregate, startup/interruption cleanup, uncertainty skips, exact dependency/artifact binding and malformed identity/receipt refusal. The actual signed sandbox-only worker passes. Both real-run modes without review receipts refuse before spawn. Durable evidence uses `results/2026-10-12-generic-fixture-*`; log/test personal path prefixes are normalized, while original local logs stay under out.

```sh
python3 spikes/cowork-hvf/test_runtime_port_trace.py
python3 spikes/cowork-hvf/build_generic_fixture.py
python3 spikes/cowork-hvf/run_generic_fixture.py --sandbox-check
python3 -m unittest discover -s spikes/cowork-hvf -p 'test_generic*.py' -v
```

Root and independent review must accept0011 and the complete fixture before any VM. A private manually supervised review receipt binds accepted:true, this exact buildSha256, heavyCompileQuiescent:true and scenario:"normal" or "terminal-close". The isolated worker lock, stale-worker check, compiler quiescence and ordinary memory-pressure query (minimum15% free) remain enforced. That receipt is not a replay-proof production capability. Each scenario requires its own explicit authorization:

```sh
python3 spikes/cowork-hvf/run_generic_fixture.py --run-runtime-port-fixture --review-receipt PATH
python3 spikes/cowork-hvf/run_generic_fixture.py --run-runtime-port-close-fixture --review-receipt PATH
```

Guest boot, actual generic backpressure/control service, live pin/mapping exclusions, active RAM return, terminal recovery and persistent Winter runtime integration remain unverified. Successful future stage checks still retain activeReturnVerified:false until independent raw/binary/disk/footprint audit. Storage encryption and key delivery remain deferred.
