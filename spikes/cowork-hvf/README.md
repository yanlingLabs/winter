# Bounded Linux/HVF feasibility fixture

This slice builds unmodified libkrun 1.19.6 at `227b2de6ed323fe180e02f871c5f325a90c13cc2` and boots one real Linux guest in a self-sandboxed, test-only C worker. It establishes a Linux baseline for the approved one-worker-per-workspace topology. It does not enable Cowork, provide a production Swift wrapper, implement disk encryption, or pass the active memory-return gate.

Run from the Winter checkout:

```sh
python3 spikes/cowork-hvf/build.py
python3 spikes/cowork-hvf/run.py --sandbox-check
python3 spikes/cowork-hvf/run.py --run-fixture
```

All downloaded tools, source, binaries, and private fixtures stay under ignored `out/`. The build requires the checksum-pinned cached kernel and Zig from `spikes/cowork-vm/out`; it never installs globally. Rust archive and libkrun revision/lockfile checks are in `pins.json`. Crate resolution is locked. Toolchain archive checks establish correspondence to the downloaded upstream checksum, not an independent signature audit.

The kernel is the existing Apple-recommended Kata `6.18.35` arm64 Image. A small static musl PID 1 is packed into a deterministic `newc` initramfs; no disk, root host filesystem, or host share is attached. The guest gets two vCPUs and a fixed 768 MiB ceiling. At most 256 MiB workload allocation plus 32 MiB retained data is live. Three allocation/free/reuse cycles run alongside a guest heartbeat and verify every allocated and retained 64-bit word. This is a bounded workload, with no host-pressure generator.

The worker installs Seatbelt before creating a libkrun context. It checks sandbox state and actual denial of an `/etc/hosts` read, fixture write, and loopback connection. Socket creation itself is permitted on this macOS build; connection authority is denied. The worker refuses to boot on a failed denial. `sandbox_init_with_parameters` and `sandbox_check` are macOS SPI, with declarations matching the existing OfficeHelper bridge; this is a feasibility choice requiring production review. System libraries and its own canonical fixture directory are readable. It has no filesystem write grant, process-exec/fork grant, or network grant. Production sandbox/HVF compatibility across supported macOS versions remains unverified.

`krun_disable_implicit_vsock` is called explicitly. Compilation uses **no default features**, excluding net, blk, GPU, snd, input and EFI. No explicit vsock mapping or IPC is needed: the guest console is the fixture channel. The runner provides an empty credential environment, private HOME/TMPDIR, `/dev/null` stdin and captured stdout/stderr. An advisory fixture-owner lock and an existing-worker process check refuse overlap; this lock protects fixture ownership and adds no conversation edit lock. Timeout kills only the direct child it created. The runner never shuts down another VM or touches Winter.app, its daemon, real Winter homes, coordination, or Keychain.

## Recorded baseline, 2026-10-11

The final run's committed result and event stream are under `results/2026-10-11-baseline*`. Exit code was 0; Linux boot, sandbox denials, all three allocation/free/integrity cycles and continued heartbeat passed. The three guest devices were console (`0x0003`), RNG (`0x0004`), and balloon (`0x0005`). Reporting feature bit 5 was negotiated, with no NIC or vsock device present. A separate lock-owner test refused overlap before launching a worker; the process inventory was empty after completion.

| Cycle | Touched worker footprint | Footprint 8–10 seconds after free |
| --- | ---: | ---: |
| 1 | 432,309,184 bytes | 432,407,488 bytes |
| 2 | 684,196,992 bytes | 684,196,992 bytes |
| 3 | 701,727,872 bytes | 701,727,872 bytes |

These observations show no meaningful worker-footprint return during active work in this bounded baseline. They do not prove a universal impossibility or isolate all host accounting. No host-pressure generator was used. Device negotiation alone does not prove which descriptors Linux reported or that the library reclaimed them. Host-wide available-memory sampling and instrumented reporting descriptors are future validation requirements. The first exploratory run's harness could not parse libkrun's prefixed console JSON; it exited 1 although the raw log showed guest completion. The parser was corrected and the recorded final run passes its explicit gates.

## API and execution ownership

`api-inventory.json` records symbols from the actual built dylib and its link dependencies. The external payload API is `krun_set_kernel(ctx, kernel, KRUN_KERNEL_FORMAT_RAW, initramfs, cmdline)` (`include/libkrun.h:875`). Configuration includes `krun_create_ctx`, `krun_set_vm_config`, and `krun_disable_implicit_vsock` (`include/libkrun.h:1215`). No public runtime memory-target/reclaim API is exported. `krun_start_enter` consumes the context and takes control of the process, exiting when the VM shuts down (`include/libkrun.h:1376`). That ownership is why the slice uses a worker, and why a future Swift wrapper must be worker-local while daemon orchestration remains outside it.

## Reporting instrumentation

```sh
python3 spikes/cowork-hvf/build.py --instrument-reports
python3 spikes/cowork-hvf/run.py --run-fixture --instrument-reports
spikes/cowork-hvf/out/rust/bin/rustc --edition=2021 --test spikes/cowork-hvf/reclaim_ranges.rs -o spikes/cowork-hvf/out/reclaim-range-tests
spikes/cowork-hvf/out/reclaim-range-tests
```

`patches/0001-report-instrumentation.patch` adds descriptor receipts to a separate pinned source checkout; it preserves the original advice and queue disposition. `--instrument-reports` builds into `out/instrumented`, so it does not replace the unpatched baseline artifacts. PID 1 additionally emits selected `/proc/vmstat` counters after touching, immediately after freeing, and after the 10-second reporting window. `reporting.py` summarizes actual receipts; cumulative reported bytes may include repeated ranges and **are not returned-byte claims**.

`results/2026-10-11-report-instrumentation*` records a passing bounded run with 18 batches and 299 descriptors: 285 of 4 MiB and 14 of 2 MiB. Every observed HVA/GPA/length was aligned to the 16 KiB host page, and all `MADV_FREE` calls returned 0. During cycles two and three, the guest reported 270,532,608 and 268,435,456 bytes after the free, beginning 2.018 and 2.017 seconds later. Guest `nr_free_pages` rose from roughly 103,000 to 169,000–170,000; `pgscan_kswapd` stayed 0 at the recorded phases. This proves useful free-page reports reached the host handler.

Worker footprint changed from 431,227,840 to 398,541,736 bytes in cycle one (a partial reduction), and remained 646,202,472 and 676,136,064 bytes across frees in cycles two and three. The ratchet persists despite actual reporting and successful advice; this remains a failed active-return gate. The guest continued its heartbeat and passed every retained-range integrity check. The worker exited naturally, with no fixture worker left running.

`reclaim_ranges.rs` is a pure planner prerequisite, presently **not wired into libkrun**. Nine tests pass for complete containment, adjacent-region crossing, integer overflow, partial host pages, duplicates/overlap, one-byte DMA/ring intersection, shared/alias/unaligned registries, and bounded report limits. It performs no memory or HVF operations and establishes no pause/device safety by itself.

## Safe active-return implementation plan

`patches/0002-proposed-active-reclaim.patch` is now a **review candidate**, applying to pristine `227b2de6ed323fe180e02f871c5f325a90c13cc2`, independently of the instrumentation patch. Its SHA-256 is `353e6676f2b9bddde82748b43e210fe6c4d43adec6bf7246c98af894433b598e`. The prepared source checkout is `out/libkrun-reclaim`. A `cargo check -p libkrun --locked --no-default-features --jobs 4` passes without warnings. The default build/worker does not apply or enable it, and **no patched VM has run**. `results/2026-10-11-reclaim-candidate.json` and `-simulations.txt` record exact commands and bounded test results.

The candidate's C API opt-in is `krun_enable_cowork_fixture_reclaim`. Admission rejects default/optional device features, firmware/borrowed kernel bundles, host shares, implicit or explicit vsock, virtio consoles and nested virtualization, and requires an external kernel, exactly two vCPUs, one legacy serial device and at most 1 GiB. A future test wrapper must disable the implicit console, add the ARM PL011 serial device and use `console=ttyAMA0` before enabling this API. Its free-page event handler only coalesces a pending flag; the VMM coordinator runs on the event thread with no device callback mutex held. A sealed allocation registry is captured directly after known anonymous guest-RAM allocation. The coordinator parks the exact HVF roster using epoch-tagged ACKs (with control selection in boot/WFE waits), snapshots every RNG/balloon ring and outstanding non-report buffer, validates every reported full span, then replaces backing atomically at retained HVA. Every HVF/mmap result is recorded; failure exits 77 without continuing. Used-ring ACK is deferred until all spans are mapped, followed by exact resume ACKs and pause-duration receipts. Native code must still be reviewed for races and supported lifecycle behavior.

```sh
spikes/cowork-hvf/out/rust/bin/rustc --edition=2021 --test spikes/cowork-hvf/reclaim_tests.rs -o spikes/cowork-hvf/out/reclaim-tests
spikes/cowork-hvf/out/reclaim-tests
```

All 23 bounded tests pass. They cover the range planner; exact roster/epoch, stale/duplicate/missing ACK and Stop precedence; the **same replacement sequence used by the candidate** with failure injected at every unmap/replace/map step; retained HVA/order and delayed acknowledgment; and simulations of running/WFE/boot control delivery, the documented sticky-cancellation race, and a vCPU blocked on a device mutex. The sticky-cancellation test models the SDK behavior and does not call HVF. These tests do not execute the native vCPU loop, prove real device quiescence, exercise real partial-remap failures or demonstrate Linux memory return. Actual code review plus a bounded patched Linux run with heartbeat, retained sentinels, zero/reuse checks, pause receipts and memory evidence remain required.

The following acceptance requirements remain pending native review and real validation. The untouched library's reporting queue calls `mem.get_host_address(desc.addr).unwrap()` and passes the descriptor's full length to `madvise`; macOS uses `MADV_FREE` and ignores the return code (`src/devices/src/virtio/balloon/device.rs:88-106`). Start-address translation does not validate the entire span. Do not replace that advice with unmap/discard syscalls.

1. Introduce a guest-RAM ownership registry with checked integer conversion/addition, nonzero full-span containment in one owned anonymous RAM mapping, host/GPA alignment, and host-page granularity. macOS has 16 KiB pages while this guest has 4 KiB pages: reclaim only complete aligned host pages proved reported together, never round an arbitrary descriptor outwards. Reject overlaps, duplicate extents, gaps, wrapping lengths, and non-RAM/device/shared mappings. Hold report ownership until used-ring completion.
2. Implement a real macOS vCPU pause/resume epoch with bounded acknowledgments from every vCPU, including CPUs waiting for boot/WFE. `src/vmm/src/macos/vstate.rs:463` currently does not consume `VcpuEvent::Pause`; `wait_for_resume` at line 512 is empty, and `src/vmm/src/lib.rs:266` implements resume as a no-op. `hv_vcpus_exit` only requests an exit; an acknowledged barrier must keep each CPU parked. VM teardown and reclaim must share an ownership/lifecycle state machine.
3. Quiesce device workers, queue processing and host accesses to guest RAM before remapping. Track or exclude every queue ring, descriptor/used buffer, pending I/O/DMA buffer, DAX window and transient host slice. The baseline's no-disk/no-net topology reduces this inventory but still has console, RNG and balloon accesses. Do not hold a lock while waiting for a vCPU that needs it to reach its barrier. The coordinator must prevent new device references while draining existing references.
4. Only with ownership and quiescence established, perform checked HVF unmap, atomically replace anonymous backing **at the same host address** with `MAP_FIXED`, and HVF remap. Keep the guest-memory object valid and preserve original HVF mapping flags; do not create a standalone `munmap` gap that unrelated mmap users could take. Verify zero fill and every return code. On any partial failure keep CPUs parked and fail the worker; do not acknowledge the report or resume a VM with missing mappings. Release the reporting queue to Linux only after success, then resume with acknowledgments.
5. Validate malformed descriptors against real queue parsing, cross-region spans, 4 KiB partial host pages, overlap/DMA exclusions, repeated cycles, remap failure, teardown races, and two or more active vCPUs. Then run bounded real Linux reporting/reuse while concurrent live work continues; show worker `phys_footprint` reduction, bounded host-wide memory evidence without pressure generation, zero-fill on reuse and retained-range integrity. Reclaim latency and pause budget must be measured. Production page ownership/DMA coordination and workload-wide concurrency are separate acceptance evidence.

This baseline records `activeReturnVerified: false` deliberately. A successful guest free or reporting feature negotiation is not RAM-return proof. Crypto is also outside this slice: the cached kernel has `CONFIG_MD` disabled; no private data disk is created, and no plaintext disk is represented as production encryption.
