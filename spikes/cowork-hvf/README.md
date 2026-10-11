# Bounded Linux/HVF feasibility fixture

This slice builds libkrun 1.19.6 at `227b2de6ed323fe180e02f871c5f325a90c13cc2` and boots one real Linux guest in a self-sandboxed, test-only C worker. The unpatched profile establishes the baseline. The independently reviewed patch demonstrates active memory return in the restricted PL011/RNG/balloon fixture. It does not enable Cowork, provide a production Swift wrapper, implement disk encryption, or pass the full resource gate.

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

`reclaim_ranges.rs` is a pure planner prerequisite used by the prepared candidate; the unpatched baseline does not use it. Ten tests pass for complete containment, adjacent-region crossing, integer overflow, partial host pages, duplicates/overlap, one-byte DMA/ring intersection, shared/alias/unaligned registries, and bounded report limits. It performs no memory or HVF operations and establishes no pause/device safety by itself.

## Safe active-return implementation plan

`patches/0002-proposed-active-reclaim.patch` applies to pristine `227b2de6ed323fe180e02f871c5f325a90c13cc2`, independently of the instrumentation patch. Its SHA-256 is `a6e26d15693007d42df5c60155055b09c69897584665d227c8ee9c720d3cfb31`. The prepared source checkout is `out/libkrun-reclaim`. A `cargo check -p libkrun --locked --no-default-features --jobs 4` passes without warnings. Astra cleared this exact frozen patch for the bounded experiment, and Root independently audited the completed Linux run. The default build/worker does not apply or enable it. `results/2026-10-11-reclaim-candidate.json` and `-simulations.txt` record exact commands and bounded test results.

The candidate's C API opt-in is `krun_enable_cowork_fixture_reclaim`. Admission rejects default/optional device features, firmware/borrowed kernel bundles, host shares, implicit or explicit vsock, virtio consoles and nested virtualization, and requires an external kernel, exactly two vCPUs, one legacy serial device and at most 1 GiB. A future test wrapper must disable the implicit console, add the ARM PL011 serial device and use `console=ttyAMA0` before enabling this API. Its free-page event handler only coalesces a pending flag; the VMM coordinator runs on the event thread with no device callback mutex held. A sealed allocation registry is captured directly after known anonymous guest-RAM allocation. The coordinator parks the exact HVF roster using epoch-tagged ACKs (with control selection in boot/WFE waits), snapshots every RNG/balloon ring and outstanding non-report buffer, validates every reported full span, then replaces backing atomically at retained HVA. Every HVF/mmap result is recorded; replacement failure exits 77 without acknowledgment or resume. Valid chains rejected by planning are acknowledged as a no-op, and valid empty/stale FRQ notifications resume with zero mappings and no invented used entries. Malformed/nonready FRQ remains fatal with neither mappings nor ACK. Parsing and ACK independently require FRQ ready, full desc/avail/used containment and bounded pending count before len/pop. Used-ring ACK for successful replacement is deferred until all spans are mapped, followed by exact resume ACKs and pause-duration receipts. Native code must still be reviewed for races and supported lifecycle behavior.

```sh
python3 spikes/cowork-hvf/prepare_reclaim.py
python3 spikes/cowork-hvf/test_reclaim.py
```

All 45 focused tests pass: six tests run the actual pinned FRQ Queue methods and 39 tests cover the extracted implementation, its integration and bounded simulations. The native adapter now calls the same `reclaim_control.rs` boot/WFE/emulation-step functions and `reclaim_coordinator.rs` report transaction exercised by those tests. Actual control tests cover boot arrival while parked, IRQ arrival while parked, an expired WFE deadline, MMIO guard release before ACK and Stop bypassing a queued pause. Real Queue-to-transaction integration tests verify nonready/nonzero metadata with ring overlap causes neither maps nor ACK; valid unaligned/unowned/ring-overlap reports ACK as a no-op; two kicks for one batch produce exactly one used entry; and malformed chains or partial replacements cannot ACK or resume. Replacement tests inject failure at every unmap/replace/map transition of the same operation sequence used by the native adapter. The region-derived budget is exposed through `plan_with_limit`; the 384 MiB cap remains an explicit bounded-fixture policy, not a production admission constant.

The sticky-cancellation test remains a model of documented SDK behavior and does not call HVF. Those unit tests do not run the complete native vCPU/HVF loop or perform real remaps. The separate restricted Linux experiment below does. General race/device/timer coverage remains incomplete. `prepare_reclaim.py` verifies the exact source/patch and extracted module correspondence; it does not compile or start a VM. The default builder still does not apply or enable this candidate.

## Independently verified restricted Linux active return

```sh
python3 spikes/cowork-hvf/build.py --reclaim
python3 spikes/cowork-hvf/run.py --sandbox-check --reclaim
python3 spikes/cowork-hvf/run.py --run-reclaim-fixture
```

The reclaim worker accepts only the explicit `--run-reclaim-fixture` mode. It uses the exact reviewed native patch, 768 MiB/2 vCPUs, PL011 output-only serial, RNG and balloon. There is no virtio console, NIC, vsock, disk, share, GPU/audio/input or host-pressure generator. Source/patch hashes, built library/worker/initramfs hashes and kernel pin are recorded. Each run has private fixture storage and an empty credential environment. The worker refuses an unsandboxed launch, retains the normal sandbox denial probes and exits/gets killed only through its own fixture lifetime. All owned guests exited naturally; no other VM was shut down.

The final fixture completed all three 256 MiB allocation/free/reuse cycles alongside a 32 MiB retained sentinel and guest heartbeat. Every allocated word was initially zero and then verified after writing; every retained word survived. Each freed interval contained ten continued heartbeats. Linux boot ID was `ada13c5b-2a0b-4795-8dcc-f31f0ff76cf6`. Root independently checked the raw event stream and exact artifacts: 20 epochs with the exact `[0,1]` park/resume roster, 296 successful aligned unmap/retained-HVA replacement/RWX remap sequences, no overlap or protected-range intersection, and used ACK only after remapping. Cumulative replacement was 1,210,056,704 bytes across repeated ranges; it is not a unique returned-byte total.

| Cycle | Touched worker footprint | Footprint 8–10 seconds after free | Observed reduction |
| --- | ---: | ---: | ---: |
| 1 | 429,245,376 bytes | 183,960,368 bytes | 233.922 MiB |
| 2 | 429,540,336 bytes | 144,966,424 bytes | 271.391 MiB |
| 3 | 396,788,744 bytes | 147,096,344 bytes | 238.125 MiB |

`results/2026-10-11-linux-active-reclaim.json` records **`activeReturnVerified: true`** with explicit restricted Linux/HVF/PL011-earlycon+RNG+balloon scope, **`fullResourceGatePassed: false`** and **`productionReady: false`**. The raw stage result and guest-complete event originally carried `activeReturnVerified: false`; they are preserved as historical stage outputs. The host-side independent audit supplies the scoped conclusion. Raw stdout/stderr, the event stream, original stage result, Root audit and exploratory attempt dispositions are committed alongside the summary. No global host-memory admission/rebalancing or production-device result is implied.

Observed maximum park-to-resume duration was 10.217 ms and maximum ACK collection was 1.769 ms. These are receipts, not timer/latency guarantees. An open WFE issue remains: the native loop can pause after computing a relative timeout but before the extracted WFE function establishes its deadline, extending it by the intervening pause. Capture an absolute deadline and add a regression before making timer guarantees; that change is deliberately outside this exact reviewed experiment.

The pinned backend's PL011 regular console did not bind in this kernel, although its early console works. Fixture telemetry therefore writes bounded JSON to guest `/dev/kmsg`, carried by the same PL011 early console; `keep_bootcon` and `printk.devkmsg=on` retain that path and disable only fixture log rate limiting. The first attempt lacked guest stdout, and the second lost burst records to kmsg rate limiting; neither was credited. The third captured complete telemetry and passed. This does not validate production stdio: that and the async-device memory-access/drain contract remain required. The cached kernel still has `CONFIG_MD` disabled, so a pinned crypto-capable kernel/initramfs and encrypted private disks remain separate blocking work.

The following acceptance requirements remain pending native review and real validation. The untouched library's reporting queue calls `mem.get_host_address(desc.addr).unwrap()` and passes the descriptor's full length to `madvise`; macOS uses `MADV_FREE` and ignores the return code (`src/devices/src/virtio/balloon/device.rs:88-106`). Start-address translation does not validate the entire span. Do not replace that advice with unmap/discard syscalls.

1. Introduce a guest-RAM ownership registry with checked integer conversion/addition, nonzero full-span containment in one owned anonymous RAM mapping, host/GPA alignment, and host-page granularity. macOS has 16 KiB pages while this guest has 4 KiB pages: reclaim only complete aligned host pages proved reported together, never round an arbitrary descriptor outwards. Reject overlaps, duplicate extents, gaps, wrapping lengths, and non-RAM/device/shared mappings. Hold report ownership until used-ring completion.
2. Implement a real macOS vCPU pause/resume epoch with bounded acknowledgments from every vCPU, including CPUs waiting for boot/WFE. `src/vmm/src/macos/vstate.rs:463` currently does not consume `VcpuEvent::Pause`; `wait_for_resume` at line 512 is empty, and `src/vmm/src/lib.rs:266` implements resume as a no-op. `hv_vcpus_exit` only requests an exit; an acknowledged barrier must keep each CPU parked. VM teardown and reclaim must share an ownership/lifecycle state machine.
3. Quiesce device workers, queue processing and host accesses to guest RAM before remapping. Track or exclude every queue ring, descriptor/used buffer, pending I/O/DMA buffer, DAX window and transient host slice. The baseline's no-disk/no-net topology reduces this inventory but still has console, RNG and balloon accesses. Do not hold a lock while waiting for a vCPU that needs it to reach its barrier. The coordinator must prevent new device references while draining existing references.
4. Only with ownership and quiescence established, perform checked HVF unmap, atomically replace anonymous backing **at the same host address** with `MAP_FIXED`, and HVF remap. Keep the guest-memory object valid and preserve original HVF mapping flags; do not create a standalone `munmap` gap that unrelated mmap users could take. Verify zero fill and every return code. On any partial failure keep CPUs parked and fail the worker; do not acknowledge the report or resume a VM with missing mappings. Release the reporting queue to Linux only after success, then resume with acknowledgments.
5. Validate malformed descriptors against real queue parsing, cross-region spans, 4 KiB partial host pages, overlap/DMA exclusions, repeated cycles, remap failure, teardown races, and two or more active vCPUs. Then run bounded real Linux reporting/reuse while concurrent live work continues; show worker `phys_footprint` reduction, bounded host-wide memory evidence without pressure generation, zero-fill on reuse and retained-range integrity. Reclaim latency and pause budget must be measured. Production page ownership/DMA coordination and workload-wide concurrency are separate acceptance evidence.

This baseline records `activeReturnVerified: false` deliberately. A successful guest free or reporting feature negotiation is not RAM-return proof. Crypto is also outside this slice: the cached kernel has `CONFIG_MD` disabled; no private data disk is created, and no plaintext disk is represented as production encryption.

## Guarded block follow-on and crypto preparation

`block-readiness.md` records the separate no-VM block candidate, actual worker/access tests and review limits. Run `python3 spikes/cowork-hvf/test_block.py` to check exact source correspondence, 49 actual-source tests and the reduced native build. This does not alter the verified A6 profile or add a block launch option. See `kernel/README.md` for verified source/config inputs and the explicit offline Linux builder entry point; neither a crypto kernel nor a trusted unlock initramfs has been built.
