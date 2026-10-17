# N2 slice S4: libkrun production profile (patch queue 0014-0022)

Status: source and offline build only. **No VM was run.** No worker, launcher, sandbox check, `krun_start_enter` path or Hypervisor.framework call was executed to produce anything in this document. Any VM run needs an independent review of this exact commit and the owner's approval. Nothing here is production-ready: see "Review needed" and "What a G4 run must show".

This builds on the admitted two-disk fixture (`cowork/two-disk-fixture` at `9a588735`, patches 0001-0013, unchanged) and adds nine patches in the same queue format: 0014-0016 (first round) and 0017-0022 (review round, PR #55). The queue lives under `spikes/cowork-hvf/patches/` for now; see "Where the patch set lives".

## What this slice delivers

| Deliverable | Where |
|---|---|
| A production profile gate, separate from every fixture opt-in, with a mandatory preflight and a production-only build in which a plain context cannot start | patches 0015, 0019 |
| Canonical `_v1` C ABI replacing the `*_fixture_*` entry points; fixture names kept as a regression oracle behind a cfg | patches 0015, 0017; cargo feature `cowork-fixture-oracle` |
| Explicit limits, 2 vCPU and 768..=1024 MiB, inside the reviewed gate (gate not lifted) | patch 0015; "Limits" |
| Device inventory exactly as admitted (`0x0002` x2, `0x0003`, `0x0004`, `0x0005`); no shutdown GPIO device | tests and the patch scope check; "Device inventory" |
| Running tests for every reviewed device-inventory refusal, a table of every device-adding public setter, and exhaustive classification of the config types | patch 0018 |
| `krun-vmm` unit harness fixed; HVF-reaching tests ignored | patch 0014 |
| Production block path and reclaim path free of fixture timing and output (trace rows and their fatal cap, the 25 ms completion hold, reclaim rows with host addresses) | patches 0016, 0020 |
| Flush counters per disk and pin high-water counters readable by the worker and by G4 | patch 0021 |
| One exit path for every stop: reason (off, reset, vcpu error, terminal fault), final flush of both volumes, exit hook registered last | patch 0022 |
| Written analysis of the 48-pin / 8 MiB budget under ext4 journaling (no measurement) | "Pin budget analysis" |
| Reproducible build: `--remap-path-prefix`, strip, pinned toolchain, source pin, `strings` check | "Reproducible build" |

## Patch queue

Applied on pristine libkrun v1.19.6 (`227b2de6ed323fe180e02f871c5f325a90c13cc2`) after patches 0004-0013, in order. SHA-256 of each patch file:

| Patch | Purpose | Files touched | SHA-256 |
|---|---|---|---|
| `0014-proposed-krun-vmm-unit-harness.patch` | krun-vmm unit harness compiles again; tests that create a Hypervisor.framework VM or call krun_start_enter are #[ignore]; no production behavior changes | `src/libkrun/src/lib.rs`, `src/vmm/src/macos/vstate.rs`, `src/vmm/src/resources.rs` | `b5bda53c97f86c1b130639340f3d97c9a96d37765a63820a6ca9c86664c88844` |
| `0015-proposed-cowork-production-profile.patch` | production profile gate separate from the fixture opt-ins, production C ABI names, explicit 2 vCPU / 768..1024 MiB limits inside the reviewed gate, fixture entry points behind cfg(test) or the cowork-fixture-oracle feature | `include/libkrun.h`, `src/libkrun/Cargo.toml`, `src/libkrun/src/cowork_production_profile_tests.rs`, `src/libkrun/src/lib.rs` | `e3c6c42ab5e30f33586f8d07e5a6c5e6fcc38e5a5e20393c824d08edf5f90daf` |
| `0016-proposed-production-block-trace-off.patch` | the fixture-only block trace rows and their 60000-row fatal process cap are compiled out of production builds | `src/devices/Cargo.toml`, `src/devices/src/block_trace.rs`, `src/libkrun/Cargo.toml`, `src/libkrun/src/cowork_production_trace_tests.rs`, `src/libkrun/src/lib.rs` | `97708943e9ac82db658fe0c322d5140f66966cab201bae4b33e3e56e334fbdf8` |
| `0017-proposed-production-abi-v1-names.patch` | mechanical rename of the production entry points to the canonical _v1 names (enable_profile, create_runtime_port, set_workspace_disks, validate_profile) | `include/libkrun.h`, `src/libkrun/src/cowork_production_profile_tests.rs`, `src/libkrun/src/lib.rs` | `628c88a57fbb7216132eba089d1fd028ea706d7a1658ba3fe4c7765950d8a529` |
| `0018-proposed-production-gate-matrix-tests.patch` | running tests for every reviewed device-inventory refusal, a table of every device-adding public setter, exhaustive classification of the context types, the pre-VMM phase, and a start-free split of the normalized-gpu admission test | `src/libkrun/src/cowork_production_gate_matrix_tests.rs`, `src/libkrun/src/cowork_production_profile_tests.rs`, `src/libkrun/src/lib.rs`, `src/vmm/src/resources.rs` | `311e58b4695d91703519c6173a484077b15977a5930eef453510cf7111a84d45` |
| `0019-proposed-production-start-admission.patch` | mandatory preflight recorded on the context and enforced at start; cowork-production-only feature: krun_start_enter refuses any context without the production profile | `include/libkrun.h`, `src/libkrun/Cargo.toml`, `src/libkrun/src/cowork_production_gate_matrix_tests.rs`, `src/libkrun/src/cowork_production_profile_tests.rs`, `src/libkrun/src/cowork_production_start_tests.rs`, `src/libkrun/src/lib.rs` | `805356bdf1f74146b0daa92d7c502107702d6b0520c9eb814fdf6c3bef30c82a` |
| `0020-proposed-production-quiet-block-and-reclaim-paths.patch` | production block requests have no fixture completion hold; the fixture reclaim rows (host virtual addresses) on stderr are compiled out of production builds | `src/devices/src/block_trace.rs`, `src/devices/src/virtio/block/cowork.rs`, `src/libkrun/Cargo.toml`, `src/libkrun/src/cowork_production_quiet_tests.rs`, `src/libkrun/src/lib.rs`, `src/vmm/Cargo.toml`, `src/vmm/src/cowork_fixture.rs`, `src/vmm/src/lib.rs` | `8f395ba2db2cec9b7ba0551e3497ce5664c62ee85a76597ded93e52abb418590` |
| `0021-proposed-production-flush-and-pin-counters.patch` | process-global flush counters per disk and pin high-water counters, with krun_cowork_get_flush_counters_v1 and krun_cowork_get_pin_counters_v1 | `include/libkrun.h`, `src/devices/src/block_bounce.rs`, `src/devices/src/cowork_counters.rs`, `src/devices/src/lib.rs`, `src/devices/src/reclaim_access.rs`, `src/libkrun/src/cowork_production_counters_tests.rs`, `src/libkrun/src/cowork_production_profile_tests.rs`, `src/libkrun/src/lib.rs` | `f3341cea82ea205507b7fc533674493c4c91b39ecf7b22e844f0017ea6c9cc3a` |
| `0022-proposed-production-exit-path-final-flush-and-hook.patch` | one exit path for every stop (reason recorded once: off, reset, vcpu error, terminal fault; PSCI reset distinguished from off), final flush observer for both volumes, exit hook registered last, fatal() routed through the same path | `include/libkrun.h`, `src/devices/src/virtio/block/device.rs`, `src/hvf/src/lib.rs`, `src/libkrun/src/cowork_production_exit_tests.rs`, `src/libkrun/src/cowork_production_profile_tests.rs`, `src/libkrun/src/lib.rs`, `src/vmm/src/builder.rs`, `src/vmm/src/cowork_exit.rs`, `src/vmm/src/cowork_fixture.rs`, `src/vmm/src/lib.rs`, `src/vmm/src/macos/vstate.rs`, `src/vmm/src/resources.rs` | `965d43e3c06f5f73f249c4a808600ab378464e5e1e5cd13b11f82196fc8c397a` |

Composed full source diff (0004-0022 on pristine): `505a68e38b3415e6b503ea06ddc68f15d313ce91066cbb50f69cfc09b9bcbe29`. `Cargo.lock` is untouched (`a73d2ee0e4f2d2b63c7b4a00d2639076e4f7884a40cec495d5d82eed14dcd873`); the cargo features add no dependency.

`production-profile-candidate.json` pins every hash above, the declared file scope of each new patch, the mirrored modules and the status flags (`productionReady`, `vmStarted`, `workerBuilt`, `fullResourceGatePassed` are all `false`).

`prepare_production_profile.py` composes the source from a local pristine clone with no network and refuses unless: every patch hash and the composed diff hash match; each new patch is byte-identical to the git diff between two successive composed states; the mirrored modules at the spike root equal the composed source; each new patch touches only its declared files and adds no `register_mmio_gpio(`, `Gpio::new(`, `add_subscriber(` or `attach_mmio_device(&mut `, and no added line outside the test files contains `attach_`, `register_mmio`, `add_subscriber(` or `Gpio`; and no test reaches `krun_start_enter`, `Vm::new`, `HvfVm::new`, `HvfGicV3::new`, any `hv_*` call, `krun_get_max_vcpus`, `krun_check_nested_virt` or `build_microvm` without `#[ignore]` (string literals and comments are text, not calls).

## Production profile gate

`krun_cowork_enable_profile_v1(ctx)` sets a production marker on the context (a private `ContextConfig` field) and the reduced-device switches the profile shares with the fixture. It is accepted once, and only on a context that carries no fixture opt-in; every fixture entry point refuses a context that carries the marker, and every production entry point refuses a context without it. The two profiles cannot be mixed in either order.

When the marker is set, `cowork_validate_profile_in_phase` runs `cowork_validate_production` first, then the unchanged reviewed checks. It runs at the same three places as before: the start of `krun_start_enter` (before any kernel loader, disk opener or VM allocation), block preparation, and the pre-VMM re-check. A test now runs the pre-VMM phase on a prepared context (mutation R01).

**Start admission (patch 0019).** `krun_start_enter` calls `cowork_start_admission` before anything else:

* A production context must have passed the **mandatory** preflight `krun_cowork_validate_profile_v1`; a successful call is recorded on the context (a failed call clears the record) and the full admission still re-runs at start, so a later setter cannot ride a stale preflight.
* In a build with the cargo feature **`cowork-production-only`** every context must carry the production profile. Without it a plain context passes the gate untouched and runs as stock libkrun (implicit vsock, virtiofs and the like), which is what an earlier review found. The feature is mutually exclusive with `cowork-fixture-oracle` (a compile error). The production recipe builds with `blk,cowork-production-only`; the oracle build is `blk,cowork-fixture-oracle`.

| Production-only check | Also refused by the unchanged reviewed gate? |
|---|---|
| Reduced-device switches (`cowork_fixture_reclaim`, `cowork_guarded_block`) both on | partly (guarded block must match the `blk` feature) |
| Workspace pair set | yes, for pair-less contexts at 768 MiB (path-backed single disk rules) |
| Generic runtime port, not the HVC bootstrap stream | yes (pair branch needs the runtime port) |
| Fixture runtime-port trace off | **no**: the reviewed gate allows trace with a port |
| No shutdown eventfd (it attaches the PL061 GPIO device) | **no**: see below |
| Exactly 2 vCPUs, 768..=1024 MiB | vCPUs and the 1024 MiB ceiling yes; the workspace pair fixes 768 exactly |

Where the reviewed gate also refuses something, the mutation checks mutate both copies together, so a single removed check there is not a surviving mutant by luck.

**Device-inventory tests (patch 0018).** Every clause of the reviewed gate that keeps a device or payload out of the admitted inventory now has a running test (23 clauses: virtiofs, extra virtio console, implicit console, second or missing serial console, missing external kernel, kernel bundle, firmware, nested virtualisation, implicit and explicit vsock, the three public and the three normalised gpu fields, path-backed block, root, data and block-root configs, the runtime-port trace and the shutdown eventfd): each is applied to a valid production context, must be refused by the validator and the preflight, and must be admitted again once undone. A second test applies **every public setter that can add a device** (34 rows) to a valid production context: a setter that is accepted must turn the preflight to `-EINVAL` (20 rows), a setter that refuses must leave the context untouched (12 rows), and the two accepted-but-inert rows (`krun_set_snd_device`, `krun_disable_implicit_init`) are inert only because their device code is not built, which the test asserts. The config types are destructured exhaustively (`ContextConfig` in libkrun, `VmResources` in the vmm crate): adding a field breaks the build until it is classified. The reviewer's mutations R10 (virtiofs), R11 (virtio consoles) and R12 (kernel bundle and firmware) and R07 (normalised gpu fields) now die.

The start-free split of the ignored `cowork_admission_normalized_gpu_resources_rejected` is `cowork_admission_normalized_gpu_resources_rejected_by_validator_without_any_start`: it carries the pure validator assertion over `vmr.gpu_*` (which the earlier companion test did not: that one only covered the public setters), while the original, which also calls `krun_start_enter`, stays ignored.

`krun_cowork_validate_profile_v1(ctx)` is side-effect-free. It previews the **first** (pre-construction) phase only; the later phases run at start.

### Finding: the reviewed gate does not refuse the shutdown eventfd

`krun_get_shutdown_eventfd` stores an eventfd in the context, and `attach_legacy_devices` registers the PL061 GPIO device when it is present. The reviewed fixture gate never looks at it, so a fixture context that asked for the eventfd would start with a device outside the admitted inventory. This slice does not change the fixture profile (it is the oracle). The production gate refuses a context with the eventfd, and the C probe exercises exactly that through the public C API.

## Production ABI (canonical `_v1` set)

Controller ruling: the production entry points carry a `_v1` suffix; the struct `krun_cowork_volume_identity` stays unsuffixed.

| Fixture entry point (exists only under `cfg(test)` or feature `cowork-fixture-oracle`) | Production entry point (always present, macOS arm64 + `blk`) | Note |
|---|---|---|
| `krun_enable_cowork_block_fixture_reclaim` | `krun_cowork_enable_profile_v1` | separate gate, see above |
| `krun_create_cowork_runtime_stream` | `krun_cowork_create_runtime_port_v1` | same closed contract: only the opposite PEER fd (>=3, CLOEXEC) leaves the library |
| `krun_set_cowork_workspace_disks` | `krun_cowork_set_workspace_disks_v1` | same borrowed-fd intake and identity checks; serves production contexts only |
| (none) | `krun_cowork_validate_profile_v1` | **mandatory** preflight, see above |
| (none) | `krun_cowork_get_flush_counters_v1` | process-global per-disk flush accounting |
| (none) | `krun_cowork_set_exit_hook_v1` | optional exit callback with a reason |
| (none) | `krun_cowork_get_pin_counters_v1` | **one addition beyond the canonical six**: pin budget and high-water marks (the only reader for finding F8; S1 should adopt it or fold it into the counters) |
| `krun_enable_cowork_runtime_port_fixture_trace` | none | the trace is fixture only |
| `krun_create_cowork_bootstrap_stream` | none | HVC bootstrap variant |
| `krun_set_cowork_bootstrap_stream` | none | deprecated, always `-EINVAL` |
| `krun_enable_cowork_fixture_reclaim` | none | reclaim-only topology without block devices |
| `struct krun_cowork_volume_identity` (32 bytes) | unchanged | declared outside the oracle block |

Visibility is enforced three ways: the fixture entry points are `#[cfg(any(test, feature = "cowork-fixture-oracle"))]` (the production archive exports none of them, checked with `nm -g`: 69 exports: the 62 upstream ones for this feature set plus the 7 `krun_cowork_*_v1` names, no `fixture` symbol and no other `cowork` symbol; the oracle archive exports 76, the same plus the 7 fixture names); the fixture declarations sit inside `#ifdef KRUN_COWORK_FIXTURE_ORACLE`; and `KRUN_COWORK_PRODUCTION_VCPUS` (2), `..._MIN_MEMORY_MIB` (768) and `..._MAX_MEMORY_MIB` (1024) are in the header and a test requires them to equal the Rust constants.

The header diff against the admitted 0013 composition is `results/2026-10-17-n2-production-profile-libkrun-header.diff`. `api-inventory.json` keeps its unpatched-baseline `exports` list and gains a `productionProfile` block (production and oracle-only export names, archive hash, limits). The six upstream `blk` disk setters stay exported but are refused at start by the gate.

Recommended call order for S3: `krun_create_ctx`, the usual non-device setters (kernel, serial console, `krun_disable_implicit_vsock`, `krun_disable_implicit_console`, `krun_set_vm_config`), `krun_cowork_enable_profile_v1`, `krun_cowork_create_runtime_port_v1`, `krun_cowork_set_workspace_disks_v1`, optionally `krun_cowork_set_exit_hook_v1`, `krun_cowork_validate_profile_v1` (mandatory), `krun_start_enter`.

## Limits

Enforced in `cowork_validate_production`, which runs inside the reviewed `cowork_validate_profile_in_phase`, and again at the two later phases:

* **vCPUs: exactly 2.** "At most 2" is implemented as exactly 2: the reclaim barrier, drain and pin evidence were reviewed for two vCPUs only. One vCPU is refused (tested) and would need its own review.
* **Memory: 768..=1024 MiB.** 1024 is the reviewed ceiling. The floor stays 768 (owner ruling for this round; S1 aligns to it). The fixture profile is unchanged: its workspace pair still needs exactly 768 MiB.
* **The ceilings are doubly enforced.** The reviewed gate keeps its `vcpu_count == 2` and `memory <= 1024` checks, so lifting a production constant alone changes nothing; the mutation checks lift both. Raising either number lifts the gate and needs a fresh drain and pin review.
* **Per-transaction reclaim ceiling stays 384 MiB** (`cowork_ranges::plan`, "bounded-fixture policy"). At 1024 MiB that caps one reclaim transaction to 384 MiB; an oversized report is rejected atomically and the guest resumes. G4 must see whether this matters.

## Device inventory

The production profile adds no device. Across all nine patches, `builder.rs` changes only to register exit observers and the exit hook (patch 0022, no `attach_` call is added), `hvf` gains a PSCI reset variant, and `src/devices` gains an exit observer on the block device, counters and the compile-out of fixture-only behaviour; nothing touches `device_manager` or the arch layer. The inventory stays virtio block x2 (`0x0002`), console/runtime port (`0x0003`), rng (`0x0004`), balloon (`0x0005`), plus the always-present legacy devices. The GPIO shutdown device from the original S4 bullet is **not admitted** (n2-common rule 7): there is no GPIO code in the queue and the production gate refuses the one API that would attach it. Stop remains a guest `drain` frame followed by guest power-off.

A test pins the textual sequence of device attach calls in `build_microvm`, the single `register_mmio_gpio` call site (inside the shutdown-eventfd branch) and the budget constants (3 devices, 48 pins, 8 MiB).

## Exit path, final flush and counters (patches 0021, 0022)

**One exit path.** Every way a started VM ends now goes through `cowork_exit::finish`: it claims the sequence (exactly one thread; any other never returns), runs the registered exit observers once, in registration order, then `_exit`s. A watchdog thread exits the process with the same status after 20 s, so an observer that cannot finish (a join on a worker stuck in host I/O) cannot keep the process alive; what is left, including the hook, is then skipped. `Vmm::stop` calls it. `fatal()` and `checked()` in `cowork_fixture.rs`, which used to `_exit(77)` directly and bypassed every observer, now call `cowork_exit::terminate`, which takes the same path (the published observer list is the same one). A test pins that `_exit` appears nowhere in the fixture module and that `Vmm::stop` uses `finish`.

**Reason.** Recorded once, first writer wins: `KRUN_COWORK_EXIT_OFF` (PSCI SYSTEM_OFF), `KRUN_COWORK_EXIT_RESET` (SYSTEM_RESET, previously indistinguishable from off: both returned `Shutdown`, and `hvf` now has a separate `Reset` exit), `KRUN_COWORK_EXIT_VCPU_ERROR`, `KRUN_COWORK_EXIT_TERMINAL_FAULT` (a pin, lease, reclaim or lifecycle fault; exit status 77). A guest that already stopped cleanly (off or reset) exits with status 0 even if a late stop-wins fault fires while the VMM winds down (previously that race exited 77).

**Final flush.** The block device's exit observer (it was a no-op) stops and joins the disk's worker, then flushes and `sync_all`s the backing volume through the same path a guest FLUSH uses, and records the result per disk. Both volumes are registered when the guarded devices are attached. A text pin requires the join before the sync.

**Exit hook.** `krun_cowork_set_exit_hook_v1(ctx, hook, user_data)` (optional, once, production contexts only, non-null) registers a `void (*)(void *, uint32_t reason)` callback as the **last** exit observer, after every device attach and every other observer (the final flush included), and publishes the list before any vCPU can run (a text pin on `build_microvm`). It runs on the exiting thread immediately before `_exit`; it must not block or call `krun_*` except the counter getters.

**Not covered.** Hard crashes (SIGSEGV, SIGBUS, SIGILL, SIGSYS) exit from a signal handler with `_exit` and cannot run observers or the hook; a panic across an `extern "C"` frame aborts. Those exits are "uncertain" and the owner of the worker must treat them as such. The guest console (PL011) output goes to the file descriptor the worker supplies; a reader that stalls there blocks the vCPU that wrote it, so bounded capture belongs to the worker.

**Counters.** Process-global (the context leaves the library's table when the VM starts; one VM runs per process), plain atomics, no output. `krun_cowork_get_flush_counters_v1` returns per disk (`winter-data`, `winter-environment`): flush requests captured (`requested`, bumped when a Flush is captured in `block_bounce`), flushes whose backing flush and `sync_all` returned success (`completed`), and the final flush attempted and completed at exit. `krun_cowork_get_pin_counters_v1` returns the budget (48 pins, 8 MiB), the high-water marks of pins and pinned bytes, and the number of budget refusals. Both take a caller structure whose `size` is checked.

## Quiet production paths (patches 0016, 0020)

Three fixture-era behaviours were live on every production block request or reclaim and are compiled out of production builds (they stay in test builds and under `cowork-fixture-oracle`):

1. **Block trace rows and their fatal cap** (0016): `emit` printed a JSON row per step to stderr with guest physical addresses and failed after 60,000 rows per process, which stops the worker. At five rows per request (capture, io begin, io end, completion hold, used ack) that is about **12,000** block requests.
2. **25 ms completion hold** (0020, added by 0006 and missed by the first round): `run_guarded_epoll` slept 25 ms (in 5 ms slices) after the host I/O of every block request. That is at least 25 ms of extra pinned time per request and at most about 40 requests per second per disk. `block_trace::COMPLETION_HOLD_MILLIS` is 0 outside test and the oracle.
3. **Reclaim rows on stderr** (0020): `reclaim_parked`, `reclaim_exclusion` (one per exclusion, up to 4096), `reclaim_unmap` (with host virtual addresses), `reclaim_replace`, `reclaim_map`, `reclaim_used_ack`, `reclaim_disposition`, `reclaim_resumed` and `reclaim_failure` were written from inside the parked window, so a stalled reader of the worker's stderr could block the pause/resume path past its 1 s and 2 s deadlines. The strings are removed from the production archive (checked).

## Test harness (patch 0014, completed by 0018)

`cargo test -p krun-vmm` did not compile. Four of the five compile errors are in upstream v1.19.6 itself (`Vcpu::new_aarch64` gained an `ipa_size` argument and `Vm::new` an `ArchMemoryInfo` argument; the tests were never updated); the fifth is ours (the `VmResources` test literal lacked the fixture fields). Fixes: pass a fixed `TEST_IPA_SIZE`, pass an `ArchMemoryInfo`, fill the literal with `..Default::default()`, and drop an unused import.

| Test | Disposition | Why |
|---|---|---|
| `macos::vstate::tests::test_vm_memory_init` | `#[ignore]` | calls `Vm::new`, which calls `hv_vm_create` |
| `cowork_admission_normalized_gpu_resources_rejected` | `#[ignore]` | calls `krun_start_enter` (admission refusal only, but the rule is no `krun_start_enter` path) |
| `cowork_admission_public_gpu_setters_rejected_before_any_vm` | `#[ignore]` | same |
| `..._normalized_gpu_resources_rejected_by_validator_without_any_start` and `..._public_gpu_setters_rejected_by_validator_without_any_start` | new, run | the pure-validator halves of the two ignored tests |

The other `krun-vmm` tests build only fakes, channels, temp files and `DummyIrqChip`; none reaches Hypervisor.framework. `--ignored` and `--include-ignored` are refused by the runner.

Run result (`results/2026-10-17-n2-production-profile-native-tests.json`): 529 test executions passed, 0 failed, 3 distinct tests ignored and never run. They are the admitted fixture's device suites (plus the new counters module), the whole `krun-vmm` suite (59, one ignored), and the whole `libkrun` suite (54, two ignored) run three times (production features, production-only features, oracle features), and the main suites again under the shipped release profile (overflow checks on, debug assertions off, LTO). Cargo test binaries use a short `/tmp` temp root because macOS limits unix socket paths to 104 bytes (the admitted fixture runner does the same).

## Pin budget analysis (48 pins / 8 MiB under real ext4 journaling)

Analysis of the code only. **Nothing here was measured.** Measurement is gate G4.

### What a pin is and what happens on overflow

`Lease::pin(ranges)` registers a list of byte-exact guest-physical ranges as exclusions from reclaim. It fails with `Fault::Limit` when `pins.len() >= max_pins` or `pinned_bytes + bytes > max_pinned_bytes`. The production access object is `Access::new(3 devices, 48 pins, 8 MiB)` (data disk, environment disk, runtime port). A failure inside a device loop calls `access.stop()`, which flags the VMM stopped and fires the terminal notifier (reason `TERMINAL_FAULT`, exit status 77). So **a pin overflow is fatal by design**: the worker exits, and ownership of the volumes is retained until the stop evidence rules say otherwise. Failing the single request with an I/O error instead would be a design change and would hand ext4 an `EIO` (remount read-only or panic depending on `errors=`); the owner should decide that explicitly.

### Who pins, and the structural maximum

| Producer | Pins | Bytes per pin | Held |
|---|---|---|---|
| Block ring, one per disk (queue size 256: 4096 + 518 + 2054) | 2 | 6,668 | queue lifetime |
| Runtime port rings, 4 queues of 32 (512 + 70 + 262) | 4 | 844 | queue lifetime |
| Block request, at most one in flight per disk (`completion` busy rule) | 2 | rings again (6,668) + header 16 + status 1 + data <= 1 MiB | capture until used-ring publish, across host I/O and fsync |
| Port frames, at most one per queue: rx chain <= 1 MiB, control rx <= 1 MiB, tx <= 64 KiB, control tx = 8 B | 4 | descriptor ranges only | while the frame is held |
| rng, balloon | 0 | | |

Structural maximum: **12 pins (25% of 48)** and **4,289,930 bytes, about 4.09 MiB (51% of 8 MiB)**. The data limit comes from what the device advertises: `VIRTIO_BLK_F_SIZE_MAX = 64 KiB` and `seg_max = 16` give 1 MiB, equal to `MAX_REQUEST`; indirect descriptors are not offered and are rejected; `EVENT_IDX`, `DISCARD` and `WRITE_ZEROES` are masked.

### What journaling changes, and what it does not

ext4 with `data=ordered` writes data first, then the jbd2 commit: descriptor blocks, metadata blocks, then a commit block with a pre-flush. For this device that means a higher request rate, many 4 KiB metadata writes, and frequent `FLUSH` requests (each ends in `sync_all` on the backing file). It does **not** add concurrency at the device: the host serves one request per disk at a time whatever queue depth the guest keeps in the avail ring, and only the popped head is pinned. So pin count and pinned bytes are set by request size and by posted receive chains, not by the journal. Under the invariants above the budget has about 4x headroom in count and 2x in bytes.

The invariants are the thing to protect. Changing any of them invalidates the table: queue sizes, `seg_max`/`size_max`, a third disk or second queue, another port, a larger `MAX_CHAIN`. A hostile or buggy guest driver that ignores `size_max`/`seg_max` produces a `Limit` fault on the request and the same fatal stop, which is the intended fail-closed behaviour, not a budget overflow.

### What actually bounds a long-lived guest

Limits other than the pin budget are fatal and scale with ext4 activity or with reclaim time:

1. **Block trace row cap** (fixed by patch 0016): about 12,000 requests (see "Quiet production paths").
2. **The 25 ms completion hold** (fixed by patch 0020) is not a fault but it is a throughput and pin-time effect that the first version of this analysis omitted: every request held its pin 25 ms longer and each disk was capped at about 40 requests per second. With the hold gone the pin-held time is the host I/O time.
3. **Freeze drain, 1 second.** `Access::freeze(epoch, 1 s)` waits for active leases to drop. Leases cover only short copy sections and are never held across host I/O, so a slow `fsync` does not trip this, but a guest that keeps leases busy for a second does.
4. **Completion wait, 2 seconds.** A block thread that finishes a request while admission is closed waits at most 2 s for the freeze to end, then stops the worker. The reclaim transaction (park both vCPUs, unmap, replace, map, resume) must therefore finish well inside 2 s under ext4 load. The vCPU pause acknowledgement has its own 1 s deadline. The reclaim rows that used to be written inside this window are gone (patch 0020).

A smaller effect, not a fault: reclaim is rejected atomically for a whole batch if any reported span overlaps a pinned range, and pinned ranges are byte-exact while reported spans are 16 KiB host pages, so a pinned 844-byte ring excludes its whole page from any batch that reports it.

### What the G4 run must record, and tuning handles

* Pins: `krun_cowork_get_pin_counters_v1` after the run (high-water pins and bytes against 12 and 4,289,930 expected from the structure, and the refusal count, which must be 0). The fixture's `block_freeze_pin` rows exist only in the oracle build.
* Flush accounting: `krun_cowork_get_flush_counters_v1` (every captured flush completed, the final flush completed on both disks) and the exit reason at the hook.
* Per freeze: freeze duration, pause duration and the disposition; per disk: request size distribution and flush rate while the guest runs a journaled write load (small-file churn, large sequential writes, `fsync` storms, a clean unmount and a `kill -9` mid-write with journal replay).
* In the guest: `/sys/block/vd*/queue/{max_sectors_kb,max_segments,max_segment_size,nr_requests}` to confirm the 1 MiB ceiling is what the driver honours.
* PID 1 (S5) can bound request rate with `max_sectors_kb`, `nr_requests` and the `commit=` mount interval if G4 shows pressure. None is needed for the pin budget.
* Success means: pinned count and bytes stay below the structural maximum at every freeze, no refusal, no stop, the freeze and completion waits stay well under 1 s and 2 s, and the three-cycle active RAM return still holds with the real 321 MiB resident root.

## Reproducible build

Everything runs offline against local inputs: `out/libkrun` (a clean clone at the pinned revision), `out/rust` (installed from the checksum-pinned `rust-1.90.0-aarch64-apple-darwin.tar.xz`), `out/cargo-home` (the offline crate cache for the pinned `Cargo.lock`). Nothing is downloaded and a missing input stops the script.

```
cd spikes/cowork-hvf
python3 -B test_production_profile.py          # native tests, dev and release profiles
python3 -B build_production_profile.py --toolchain-archive <local rust archive> --repro-root <a new or empty directory elsewhere>
python3 -B record_production_evidence.py       # normalised receipts into results/
python3 -B test_production_profile_scripts.py  # pure-Python guard tests
```

`--repro-root` is removed after the run, so the script refuses a directory that already holds anything, the home directory, the spike, `out/`, the source, or a location inside the source.

Recipe (`production_profile_lib.release_env`):

* Toolchain: rustc 1.90.0 (`1159e78c4747b02ef996e55082b704c09b970588`), checked by `rustc -vV`, and the 116 installed files of rustc, cargo and rust-std are compared byte for byte with a fresh extraction of the checksum-pinned archive.
* Source pin: libkrun `227b2de6...` plus the hash-checked queue (above); `Cargo.lock` hash checked; the cached crates each match their `Cargo.lock` checksum and their unpacked source equals the archive's contents.
* Command: `cargo rustc -p libkrun --release --locked --offline --no-default-features --features blk,cowork-production-only --crate-type staticlib`.
* Profile: `CARGO_INCREMENTAL=0`, debug 0, LTO, 1 codegen unit, `panic=unwind`, **overflow checks on, debug assertions off**, `SOURCE_DATE_EPOCH`, `LC_ALL=C`, `TZ=UTC`.
* Paths: `CARGO_ENCODED_RUSTFLAGS` (unit-separator encoded, because real paths contain spaces) with three `--remap-path-prefix` entries: source to `/libkrun`, cargo home to `/cargo-home`, toolchain to `/rust-toolchain`.
* Strip: `ZERO_AR_DATE=1 /usr/bin/strip -S` on the archive.

Findings and results:

* **`strip` is not deterministic without `ZERO_AR_DATE=1`.** Apple's `strip` stamps the archive table of contents with the current time. The raw rustc archive is identical across builds; the stripped one differed on every run until `ZERO_AR_DATE=1` was set.
* **Reproducible across locations** (the hashes changed with this round's patches; the previous round's were `460c3829...` and `f6e7beec...`). The raw archive `6050978681a3e525b3e815419cdc59845833f1104c9df11e0a8dd3e42c747713` and the stripped archive `9dbc0474ff9e409b7bfa4dfeaf5c0ad51e23c58490e931a39c015b3aa92faa73` were produced twice, the second time from a copy of the source, toolchain and crate cache at a different absolute path, and are bit-identical.
* **`strings` check.** No home-directory, `/private`, `/var/folders`, `/Volumes`, `/home`, `/Applications`, `/tmp` or builder login/home-name string survives in the stripped archive, in a Mach-O that links it, or in that Mach-O stripped with `strip -x`. The **raw** archive does carry one path: the Rust project's own CI Xcode path in the debug stabs of the toolchain's prebuilt `compiler_builtins` members. `strip -S` removes it, so a worker must link the stripped archive (or strip the final binary) before the release name scan sees it.
* The production archive contains none of the fixture block trace or reclaim row names; the oracle archive contains them all.
* The linked probe depends only on Hypervisor.framework, `libiconv` and `libSystem`. Probes are signed only by the linker (ad hoc); no signing identity, notarisation or `codesign` command was used.

## Licences

libkrun's own crates (`libkrun`, `krun-*`) are Apache-2.0 (`LICENSE` in the repository). Source files adapted from Firecracker and crosvm keep their own headers (Apache-2.0 and BSD-3-Clause). Dependency graph of the production build for `aarch64-apple-darwin` with `blk` (`cargo tree -e normal,build`):

| Licence expression | Notable crates |
|---|---|
| Apache-2.0 | all workspace crates |
| MIT | `imago` 0.2.3 (the storage layer behind the descriptor-backed RAW pair; its `LICENSE` is in the crate) |
| MIT OR Apache-2.0 | most of the ecosystem crates |
| Apache-2.0 OR BSD-3-Clause / Apache-2.0 AND BSD-3-Clause / BSD-3-Clause | `vm-memory`, `vm-fdt`, `virtio-bindings`, `linux-loader`, `vmm-sys-util` |
| BSD-2-Clause OR Apache-2.0 OR MIT | `zerocopy` |
| ISC | `libloading` |
| Zlib; MIT OR Zlib OR Apache-2.0; 0BSD OR MIT OR Apache-2.0 | `foldhash`; `miniz_oxide`; `adler2` |
| Unlicense OR MIT | `aho-corasick`, `memchr`, `jiff` |
| (MIT OR Apache-2.0) AND Unicode-3.0 | `unicode-ident` |

The archive also embeds the Rust standard library and `compiler_builtins` from the pinned toolchain (MIT OR Apache-2.0; `compiler-builtins` carries compiler-rt portions under Apache-2.0 WITH LLVM-exception and similar). The kernel the guest boots (GPL-2.0) is a separate artifact (owner decision D6), and Hypervisor.framework is an Apple system framework; neither is linked into the archive. The release notices file must list the table above; that is not generated here.

## Mutation checks

Each guard was mutated, the named test (or, for the reviewer's set, the whole suite) was run and had to fail, and the file was restored (the tree was re-verified against the pinned hash afterwards). 70 of 70 killed: 45/45 of the author's guards (A01-A45), the reviewer's 20 mutations of PR #55 (R01-R20, re-pointed at this tree: only anchors changed, not meaning) 20/20, and 5/5 Python guards (the `--repro-root` guard and the VM-reach audit regex, killed by `test_production_profile_scripts.py`). R01, R06, R07, R10, R11, R12 and R16, which survived the reviewer's run, now die: R07, R10, R11, R12 and R01 by the new gate-matrix tests, R06 by a test of the production check on its own (the reviewed gate repeats the vCPU ceiling, so only a direct test can see the production copy), R16 by a test of the partial fixture states. R19 (the production feature set silently including the oracle) now also dies at compile time, because `cowork-production-only` and `cowork-fixture-oracle` are mutually exclusive; R19 and R20 are otherwise killed only by the build script's export audit, as the reviewer noted. One lesson recorded here because it hid results: a test that asserts while holding the context-map lock poisons it, and the drop of the test helper then panics during unwinding, which aborts the whole test process and silences every later test; the helpers now tolerate that, and the driver counts an aborted test process as a failure. Results: `results/2026-10-17-n2-production-profile-mutation-checks.json`; the driver lives outside the repository.

## Where the patch set lives (owner decision D7)

Decided by the owner: the libkrun patch set lives in the Winter repository, with an exact upstream pin (libkrun `227b2de6...`, `Cargo.lock` hash) and a reproducible build that runs only when the patches or the version change, hash-pinned and reused. Today the set is under `spikes/cowork-hvf/patches/` and `production-profile-candidate.json` already carries the pins: every patch hash, the composed source hash, the toolchain archive hash and (in the receipt) the raw and stripped archive hashes. The final in-repo location (a `packaging/` or `vendor/` path), the CI or release gate that rebuilds only when a pinned hash changes, and the cache that reuses the hash-pinned archive are an **S7 question**; this slice does not move the files.

## Review needed

1. **Names.** S1's contract must adopt the `_v1` names, including `krun_cowork_get_pin_counters_v1`, the one entry point beyond the canonical six (needed so G4 can read the pin high-water mark that 0016 removed from the trace); or S4 rebases onto the S1 names.
2. **vCPU count.** "At most 2" is exactly 2. Memory floor 768 MiB stays.
3. **0016 and 0020 are behaviour changes** in the production block and reclaim paths (no per-request rows, no row cap, no 25 ms hold, no reclaim rows). They are independently droppable, but then a production guest ends itself after about 12,000 block requests and every request holds its pin 25 ms longer.
4. **0022 changes how the process exits** for every stop, including the fixture oracle: observers now run on `fatal()` (they did not), a clean guest stop wins over a late fault (status 0), and a 20 s watchdog bounds the sequence. The 20 s budget and the decision that a final-flush failure does not change the exit status are the owner's to confirm.
5. **Fatal-stop policy.** Pin overflow, a stale queue, a long freeze (1 s lease drain, 2 s completion wait) all stop the worker with exit 77. Decide whether a failed request should ever degrade to `EIO` instead.
6. **The reviewed fixture gate does not refuse the shutdown eventfd** (a fixture context can attach the PL061 GPIO). Left as is in the oracle; the production gate refuses it.
7. **Release profile.** Shipped profile has overflow checks on and debug assertions off; the reviewed fixture evidence had both on. The main suites also pass under the release profile; G4 should run on the shipped profile.
8. **Hard crashes** (signal handlers, `abort`) do not reach the observers or the hook; the worker's owner must treat them as uncertain.
9. Independent code review of all nine patches before any run.

## What was not done

No VM, worker, launcher or sandbox runtime. No `krun_start_enter`, `hv_*`, `pmset` or signing-identity use. No measurement of any kind: the pin analysis, the 2 s and 1 s deadlines, the 20 s exit budget and the 384 MiB ceiling are code reading. No CI ran: this repository's workflow triggers only on pull requests to `main`, and the draft pull request targets the fixture branch.
