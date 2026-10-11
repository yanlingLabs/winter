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

## Safe active-return implementation plan

The following is a plan, not implemented reclaim behavior. The untouched library's reporting queue calls `mem.get_host_address(desc.addr).unwrap()` and passes the descriptor's full length to `madvise`; macOS uses `MADV_FREE` and ignores the return code (`src/devices/src/virtio/balloon/device.rs:88-106`). Start-address translation does not validate the entire span. Do not replace that advice with unmap/discard syscalls.

1. Introduce a guest-RAM ownership registry with checked integer conversion/addition, nonzero full-span containment in one owned anonymous RAM mapping, host/GPA alignment, and host-page granularity. macOS has 16 KiB pages while this guest has 4 KiB pages: reclaim only complete aligned host pages proved reported together, never round an arbitrary descriptor outwards. Reject overlaps, duplicate extents, gaps, wrapping lengths, and non-RAM/device/shared mappings. Hold report ownership until used-ring completion.
2. Implement a real macOS vCPU pause/resume epoch with bounded acknowledgments from every vCPU, including CPUs waiting for boot/WFE. `src/vmm/src/macos/vstate.rs:463` currently does not consume `VcpuEvent::Pause`; `wait_for_resume` at line 512 is empty, and `src/vmm/src/lib.rs:266` implements resume as a no-op. `hv_vcpus_exit` only requests an exit; an acknowledged barrier must keep each CPU parked. VM teardown and reclaim must share an ownership/lifecycle state machine.
3. Quiesce device workers, queue processing and host accesses to guest RAM before remapping. Track or exclude every queue ring, descriptor/used buffer, pending I/O/DMA buffer, DAX window and transient host slice. The baseline's no-disk/no-net topology reduces this inventory but still has console, RNG and balloon accesses. Do not hold a lock while waiting for a vCPU that needs it to reach its barrier. The coordinator must prevent new device references while draining existing references.
4. Only with ownership and quiescence established, perform checked HVF unmap, discard/recreate anonymous backing **at the same host address**, and HVF remap. Keep the guest-memory object valid; pin mapping ownership so unrelated mmap users cannot take the hole. Verify zero fill and every return code. On any partial failure keep CPUs parked and fail the worker; do not acknowledge the report or resume a VM with missing mappings. Release the reporting queue to Linux only after success, then resume with acknowledgments.
5. Validate malformed descriptors against real queue parsing, cross-region spans, 4 KiB partial host pages, overlap/DMA exclusions, repeated cycles, remap failure, teardown races, and two or more active vCPUs. Then run bounded real Linux reporting/reuse while concurrent live work continues; show worker `phys_footprint` reduction, bounded host-wide memory evidence without pressure generation, zero-fill on reuse and retained-range integrity. Reclaim latency and pause budget must be measured. Production page ownership/DMA coordination and workload-wide concurrency are separate acceptance evidence.

This baseline records `activeReturnVerified: false` deliberately. A successful guest free or reporting feature negotiation is not RAM-return proof. Crypto is also outside this slice: the cached kernel has `CONFIG_MD` disabled; no private data disk is created, and no plaintext disk is represented as production encryption.
