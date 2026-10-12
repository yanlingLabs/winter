# RAW block fixture prelaunch checkpoint

Implemented and built, **not launched**. The accepted0004+0005 source remains preserved;0006 adds bounded metadata instrumentation and an explicit25 ms post-I/O owned-completion hold. This hold is fixture-only, not a blocked OS syscall or a production timing policy. Independent source/fixture review must precede any VM run.

## Exact review inputs

- Native source: `out/libkrun-block-reclaim`, pinned libkrun227b2de6. Compose frozen0004,0005 and0006 selected by `block-candidate.json`; `prepare_block.py` proves the exact differential/full source and byte-identical shared modules.
- 0006 SHA256: `00e169fb7e5c527d348269cc8211afc99daa800622bce6140a4b2b42c204951d`.
- Full composed source diff SHA256: `356ea78c37bc4467d9e6cb425f97fc574deafbfb4ed8e7bd77fd7cfc942dfcc6`.
- Exact build receipt `out/raw-block/build.json` SHA256: `8fa206aecb01a8db275718d0a6d9f5b56d282fe68e7ab94552ed11720508ec1f`. The durable copy under results has identical bytes; it pins the signed library/worker, static PID1/initramfs, measured kernel and all launch/receipt source files.
- Worker identity: `dev.cowork.hvf.raw-block-fixture-worker`. Development ad-hoc signature/HVF entitlement only; production hardened/library-validation admission remains open.

Run preparation/validation without a VM:

```sh
python3 spikes/cowork-hvf/test_block.py
python3 spikes/cowork-hvf/test_block_receipts.py
python3 spikes/cowork-hvf/build_block.py
python3 spikes/cowork-hvf/run_block.py --sandbox-check
```

51 same-code tests and the native blk check pass without warnings. Four receipt tests pass, including every-word host RAW pattern verification and a one-byte tamper. Sandbox-only worker exit0 was observed with same64 MiB disk inode/identity, direct child reaped, allowed actual RAW pwrite/pread/fsync/F_FULLFSYNC and denied public host read, outbound loopback and unrelated fixture write. No libkrun context or VM was created in sandbox-only mode. The run command without a review receipt refuses before launching anything. No owned fixture worker remained afterwards.

## Changed native behavior

`block_trace.rs` caps metadata rows at 60,000 and fails closed on overflow. Request receipts contain command/head/sector/length/generation, runtime-generated request/pin IDs and GPA/length values; no payload, guest bytes, host paths or credentials. Ring pins log after their short construction lease drops. Request capture logs after the copy lease drops; disk begin/end, optional hold, deferred completion and used ACK log against owned values outside guest RAM leases. Freeze logs copy pin ID/device-generation/ranges from the already sealed snapshot. Existing mapping/ACK/exclusion receipts remain unchanged.

The actual guarded epoll loop selects `service_next_fixture` with 25 ms hold after `perform` has returned. It polls Stop during that hold and retains only owned Completion/pins. This is deliberately explicit in every hold receipt (`osSyscallBlocked:false`). It increases the chance of observing an outstanding pinned request during reclaim; OS syscall overlap is separately derived from begin/end timestamps and never inferred from the hold. Stop/mapping serialization, queue bounds, admission and retained-HVA behavior are otherwise the accepted code.

## Guest/host fixture

`block_init.c` preserves the original three 256 MiB allocation/free/zero/reuse checks, 32 MiB retained every-word sentinel and one-second heartbeat. Two concurrent guest threads each own one aligned 256 KiB buffer and disjoint 4 MiB disk extent. They use O_DIRECT pwrite/pread, compare every word, periodically fsync and report progress, then stop/join before poweroff. Each has at most 1,400 iterations, so read/write plus periodic/final flush operations remain below 6,000. No buffered fallback, external binaries, network or keys exist. The guest locates vda through guest sysfs and creates only its private guest block node. A guest failure powers off and fails host checks.

`block_worker.c` admits only the canonical fixture directory and exact `fixture.raw` path, requiring a regular single-link 64 MiB mode 0600 file owned by its UID and matching inode across no-follow opens. Seatbelt permits write only to that literal disk; other fixture writes stay denied. The measured external kernel and static initramfs, output-only PL011 earlycon/RNG/balloon and exactly one raw/Writeback/Full-sync block device are configured explicitly; implicit vsock/console are disabled. No share/network/DAX/GPU/audio/input/firmware/nested VM is admitted. There is no encryption claim.

`run_block.py` verifies frozen candidate and all artifact/source hashes, strict signature, shared ownership lock and absence of stale owned workers. It creates only an exclusive private fixture and sparse synthetic disk, supplies an empty credential environment and /dev/null stdin, captures raw channels, and kills/reaps only its own direct child after 130 seconds. Worker alarm is 120 seconds. It refuses launch without an independent review receipt binding the exact build SHA and acknowledged heavy-compile quiescence, refuses observed compiler processes and performs only `memory_pressure -Q` (never a pressure generator). A current read-only preflight observed45% free; it must be rechecked at actual launch. The crypto-kernel owner separately reported its heavy build/container cleaned up; this fixture still uses the measured old kernel.

The host checks exact device inventory, all guest cycles/retained/reuse/progress, per-free-window disk receipts from both threads, successful block stages/ACK order, captured/frozen pin equality and exclusion coverage, outstanding pin lifetime/overlap, existing epoch/mapping audit, final disk inode/size and independently every word of both synthetic4 MiB extents after exit. It records per-cycle footprint samples. Stage `activeReturnVerified:false` explicitly means independent root raw audit is still pending for this new scope; preserve this stage result if a subsequent scoped audited conclusion is true. No production/full-resource claim follows.

## Review/launch handoff

Reviewers should inspect native0006, shared access/bounce/trace copies, fixture C code and build/runner/receipt code against the exact build above. `results/2026-10-12-raw-block-prelaunch-*` retain the test/build/sandbox/pressure/refusal evidence. Original local outputs and sandbox-only fixtures remain ignored under out; no guest disk fixture has booted.

After review, root supplies a private JSON receipt with `accepted:true`, `buildSha256` equal to the exact build hash and `heavyCompileQuiescent:true`. Then the explicit command is:

```sh
python3 spikes/cowork-hvf/run_block.py --run-raw-block-fixture --review-receipt PATH
```

Root must independently inspect raw events, footprint and retained/reuse/disk evidence before any expanded active-return claim. Crypto/bootstrap, authenticated storage/crash semantics, trusted key delivery, other asynchronous devices, guest confinement, cold SDK continuity, automatic admission and full Cowork integration remain open.


## Bounded runner revision: prelaunch review fixes

The original 03606058 build/receipts remain historical and unchanged. Its complete artifact directory was copied to ignored `out/raw-block-review-03606058`; native library, worker, PID1/initramfs and measured kernel hashes match exactly. Only Python capture/termination/audit/dependency binding changed. Native 0006 remains accepted and unchanged; its broad 51-test suite was not rerun without a source change.

Current build receipt SHA256: `99162c0f198d128f80cf5c6a0a57af964df924c60e162e050cf0a523320adf55`, at `out/raw-block/build.json` and identical durable `results/2026-10-12-raw-block-bounded-build.json`. It supersedes the original build hash for the required launch-review receipt. `build_block.py --receipt-only` verified prior candidate, every binary/artifact and unchanged compiled C sources before binding updated Python dependencies; no native/kernel build ran.

`block_capture.py` is the actual runner capture/termination implementation. It reads binary chunks capped at 16 KiB, uses a 64-item bounded queue, limits each channel to 32 MiB and combined captured logs to 48 MiB, limits a line to 64 KiB and parsed rows to 80,000. Partial-line buffers exceed their bound by at most one read chunk before failure. Overflow/pipe failure/capture timeout fails closed and attempts kill of only the direct Popen child. No readline or unbounded output/row list exists. Raw logs remain bounded even on newline-free output; captured rows and errors persist.

Capture has a 130-second limit, normal exit wait 2 seconds, post-kill reap wait 3 seconds and reader joins 0.2 seconds each. No child.wait() without timeout remains. On unconfirmed exit, the actual runner persists `terminationUncertain:true`, `ownedChildReaped:false`, `diskAuditSkipped:true` and null disk hash, without even post-run lstat or any disk read/hash/integrity/audit. It preserves the uncertain fixture for follow-up and cannot claim VM-gone. Background readers are daemon threads with finite joins; their joined state is reported separately. A reap deadline is a bounded attempt, not a guarantee that the OS will terminate an unresponsive process.

The old `osSyscallOverlap` label is superseded by `ownedIoIntervalOverlap`. Native perform intervals include allocation, loops, separate syscalls and gaps. `blockedSyscallOverlapVerified:false` remains explicit; the 25 ms owned-completion hold still says `osSyscallBlocked:false`. This instrumentation cannot establish a blocked syscall. `activeReturnVerified:false` still marks independent expanded-scope host audit pending. The parser retains global command counts and both-thread freed-window progress; root must independently audit per-window read/write/flush counts before crediting that workload.

The receipt now binds all custom launch/audit imports, including `block_capture.py`, `reclaim_receipts.py` and `build.py`, plus preparer/pins/entitlements/candidate. The runner requires its mandatory dependency set, so an omitted or changed imported audit helper is rejected before spawn.

Eight focused no-VM capture/termination/dependency tests pass: bounded success, flood channel/total overflow, newline-free/terminated oversized lines, parsed-row cap, finite unreapable-child handling, omitted/changed dependencies and actual runner skip-disk behavior after uncertain exit. Five receipt tests pass, including honest owned-interval labeling and every-word RAW tamper detection. The unchanged signed native worker's new bounded sandbox-only run exits 0, keeps disk identity, reaps its child and passes all prior RAW full-sync/denial checks. `results/2026-10-12-raw-block-bounded-*` preserve this evidence. No disk-bearing VM has run. The crypto owner reports its offline toolset compile/containers quiescent; ordinary pressure/compile preflight must still run at actual launch after root accepts this new build.
