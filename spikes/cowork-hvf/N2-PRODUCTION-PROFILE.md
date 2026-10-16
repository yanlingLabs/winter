# N2 slice S4: libkrun production profile (patch queue 0014-0016)

Status: source and offline build only. **No VM was run.** No worker, launcher, sandbox check, `krun_start_enter` path or Hypervisor.framework call was executed to produce anything in this document. Any VM run needs an independent review of this exact commit and the owner's approval. Nothing here is production-ready: see "Review needed" and "What a G4 run must show".

This builds on the admitted two-disk fixture (`cowork/two-disk-fixture` at `9a588735`, patches 0001-0013, unchanged) and adds three patches in the same queue format. The queue is still under `spikes/cowork-hvf/patches/`; where it finally lives is owner decision D7.

## What this slice delivers

| Deliverable | Where |
|---|---|
| A production profile gate, separate from every fixture opt-in | patch 0015, `cowork_validate_production` inside `cowork_validate_profile_in_phase` |
| Production C ABI names replacing the `*_fixture_*` entry points; fixture names kept as a regression oracle behind a cfg | patch 0015, `include/libkrun.h`, cargo feature `cowork-fixture-oracle`; table below |
| Explicit limits, 2 vCPU and at most 1024 MiB, inside the reviewed gate (gate not lifted) | patch 0015; "Limits" |
| Device inventory exactly as admitted (`0x0002` x2, `0x0003`, `0x0004`, `0x0005`); no shutdown GPIO device | pinned by a test and by the patch scope check; "Device inventory" |
| Non-compiling `krun-vmm` unit harness fixed; HVF-reaching tests ignored | patch 0014; "Test harness" |
| Written analysis of the 48-pin / 8 MiB budget under ext4 journaling (no measurement) | "Pin budget analysis"; it found a fatal limit elsewhere, fixed by patch 0016 |
| Reproducible build: `--remap-path-prefix`, strip, pinned toolchain, source pin, `strings` check | "Reproducible build" |

## Patch queue

Applied on pristine libkrun v1.19.6 (`227b2de6ed323fe180e02f871c5f325a90c13cc2`) after patches 0004-0013, in order. SHA-256 of each patch file:

| Patch | Purpose | Files touched | SHA-256 |
|---|---|---|---|
| `0014-proposed-krun-vmm-unit-harness.patch` | `krun-vmm` unit tests compile again; tests that create a Hypervisor.framework VM or call `krun_start_enter` are `#[ignore]`. No production behaviour changes. | `src/libkrun/src/lib.rs`, `src/vmm/src/macos/vstate.rs`, `src/vmm/src/resources.rs` | `b5bda53c97f86c1b130639340f3d97c9a96d37765a63820a6ca9c86664c88844` |
| `0015-proposed-cowork-production-profile.patch` | Production profile gate, production ABI, limits, fixture entry points behind cfg, header, tests | `include/libkrun.h`, `src/libkrun/Cargo.toml`, `src/libkrun/src/lib.rs`, new `src/libkrun/src/cowork_production_profile_tests.rs` | `e3c6c42ab5e30f33586f8d07e5a6c5e6fcc38e5a5e20393c824d08edf5f90daf` |
| `0016-proposed-production-block-trace-off.patch` | Compiles the fixture-only block trace rows (and their 60,000-row fatal cap) out of production builds. **The one patch that changes runtime behaviour of the block path.** Independently droppable. | `src/devices/Cargo.toml`, `src/devices/src/block_trace.rs`, `src/libkrun/Cargo.toml`, `src/libkrun/src/lib.rs`, new `src/libkrun/src/cowork_production_trace_tests.rs` | `97708943e9ac82db658fe0c322d5140f66966cab201bae4b33e3e56e334fbdf8` |

Composed full source diff (0004-0016 on pristine): `e067b60ec68919f85588125475101e63993fb43e4c720561be1f5d9c62da537b`. `Cargo.lock` is untouched (`a73d2ee0e4f2d2b63c7b4a00d2639076e4f7884a40cec495d5d82eed14dcd873`); the new cargo features add no dependency.

`production-profile-candidate.json` pins every hash above, the declared file scope of each new patch, the mirrored modules and the status flags (`productionReady`, `vmStarted`, `workerBuilt`, `fullResourceGatePassed` are all `false`).

`prepare_production_profile.py` composes the source from a local pristine clone with no network and refuses unless: every patch hash and the composed diff hash match; each new patch is byte-identical to the git diff between two successive composed states; the mirrored modules at the spike root (`production_profile_tests.rs`, `production_trace_tests.rs`, `production_block_trace.rs`, plus all inherited mirrors) equal the composed source; each new patch touches only its declared files and adds no `register_mmio_gpio(`, `Gpio::new(`, `add_subscriber(` or `attach_mmio_device(&mut `; and no test reaches `krun_start_enter`, `Vm::new` or an HVF call without `#[ignore]`.

## Production profile gate

`krun_cowork_enable_production_profile(ctx)` sets a production marker on the context (a private `ContextConfig` field) and the reduced-device switches the profile shares with the fixture. It is accepted once, and only on a context that carries no fixture opt-in; every fixture entry point refuses a context that carries the marker, and every production entry point refuses a context without it. The two profiles cannot be mixed in either order.

When the marker is set, `cowork_validate_profile_in_phase` runs `cowork_validate_production` first, then the unchanged reviewed checks. It runs at the same three places as before: the start of `krun_start_enter` (before any kernel loader, disk opener or VM allocation), block preparation, and the pre-VMM re-check.

| Production-only check | Also refused by the unchanged reviewed gate? |
|---|---|
| Reduced-device switches (`cowork_fixture_reclaim`, `cowork_guarded_block`) both on | partly (guarded block must match the `blk` feature) |
| Workspace pair set | yes, for pair-less contexts at 768 MiB (path-backed single disk rules) |
| Generic runtime port, not the HVC bootstrap stream | yes (pair branch needs the runtime port) |
| Fixture runtime-port trace off | **no**: the reviewed gate allows trace with a port |
| No shutdown eventfd (it attaches the PL061 GPIO device) | **no**: see "Finding: the reviewed gate does not refuse the shutdown eventfd" |
| Exactly 2 vCPUs, 768..=1024 MiB | vCPUs and the 1024 MiB ceiling yes; the workspace pair fixes 768 exactly |

Where the reviewed gate also refuses something, the mutation checks mutate both copies together (see "Mutation checks"), so a single removed check there is not a surviving mutant by luck.

`krun_cowork_validate_production_profile(ctx)` is a side-effect-free preflight of the same admission. It is an addition beyond the brief; it lets the worker prove the profile (for the G0 sandbox-only gate, for instance) without calling `krun_start_enter`. Drop it if S3 does not want it.

### Finding: the reviewed gate does not refuse the shutdown eventfd

`krun_get_shutdown_eventfd` stores an eventfd in the context, and `attach_legacy_devices` registers the PL061 GPIO device when it is present. The reviewed fixture gate never looks at it, so a fixture context that asked for the eventfd would start with a device outside the admitted inventory. This slice does not change the fixture profile (it is the oracle). The production gate refuses a context with the eventfd, and `workspace_disks_production_abi_smoke.c` exercises exactly that through the public C API.

## Production ABI names

| Fixture entry point (exists only under `cfg(test)` or feature `cowork-fixture-oracle`) | Production entry point (always present, macOS arm64 + `blk`) | Note |
|---|---|---|
| `krun_enable_cowork_block_fixture_reclaim` | `krun_cowork_enable_production_profile` | separate gate, see above |
| `krun_create_cowork_runtime_stream` | `krun_cowork_create_runtime_port` | same closed contract: only the opposite PEER fd (>=3, CLOEXEC) leaves the library |
| `krun_set_cowork_workspace_disks` | `krun_cowork_set_workspace_disks` | same borrowed-fd intake and identity checks; the production setter serves production contexts only |
| (none) | `krun_cowork_validate_production_profile` | new preflight, optional |
| `krun_enable_cowork_runtime_port_fixture_trace` | none | the trace is fixture only |
| `krun_create_cowork_bootstrap_stream` | none | HVC bootstrap variant |
| `krun_set_cowork_bootstrap_stream` | none | deprecated, always `-EINVAL` |
| `krun_enable_cowork_fixture_reclaim` | none | reclaim-only topology without block devices |
| `struct krun_cowork_volume_identity` (32 bytes) | unchanged | now declared outside the oracle block |

Renaming the two non-`fixture` names (`..._runtime_stream`, `..._workspace_disks`) as well is deliberate: a single symbol whose behaviour depended on which opt-in came first would blur the separation the gate exists for. **S1's contract must adopt these names, or S4 rebases onto the S1 names.** No S1 contract existed when this was written.

Visibility is enforced three ways:

* Rust: the fixture entry points are `#[cfg(any(test, feature = "cowork-fixture-oracle"))]`. The production archive exports none of them (checked with `nm -g`: 66 exports, the 62 upstream ones for this feature set plus the 4 production names, no `fixture` symbol and no other `cowork` symbol). The oracle archive exports 73, the same plus the 7 fixture names.
* C: the fixture declarations sit inside `#ifdef KRUN_COWORK_FIXTURE_ORACLE`; a production consumer cannot see them. Checked by compiling a unit that calls them with and without the macro, and by a Rust test that parses the header.
* Constants: `KRUN_COWORK_PRODUCTION_VCPUS` (2), `KRUN_COWORK_PRODUCTION_MIN_MEMORY_MIB` (768) and `KRUN_COWORK_PRODUCTION_MAX_MEMORY_MIB` (1024) are in the header; a test requires them to equal the Rust constants.

The header diff against the admitted 0013 composition is `results/2026-10-17-n2-production-profile-libkrun-header.diff`. `api-inventory.json` keeps its unpatched-baseline `exports` list and gains a `productionProfile` block with the production and oracle-only export names and the archive hash. (The baseline was built without `blk`; the production archive adds the six upstream `blk` disk setters, which stay exported but are refused at start by the gate, and the four production names.)

Recommended call order for S3: `krun_create_ctx`, the usual non-device setters (kernel, serial console, `krun_disable_implicit_vsock`, `krun_disable_implicit_console`, `krun_set_vm_config`), `krun_cowork_enable_production_profile`, `krun_cowork_create_runtime_port`, `krun_cowork_set_workspace_disks`, optionally the preflight, `krun_start_enter`. `workspace_disks_production_abi_smoke.c` walks this order with the public C API only and shows the preflight passing at 2 vCPUs and 768 MiB.

## Limits

Enforced in `cowork_validate_production`, which runs inside the reviewed `cowork_validate_profile_in_phase`, and again at the two later phases:

* **vCPUs: exactly 2.** The brief says "at most 2". The reclaim barrier, drain and pin evidence were reviewed for two vCPUs only, so two is both the ceiling and the only admitted count. One vCPU is refused (tested) and would need its own review.
* **Memory: 768..=1024 MiB.** 1024 is the reviewed ceiling. The floor is the one size the fixture evidence exists for. The fixture profile is unchanged: its workspace pair still needs exactly 768 MiB.
* **The ceilings are doubly enforced.** The reviewed gate keeps its `vcpu_count == 2` and `memory <= 1024` checks, so lifting a production constant alone changes nothing; the mutation checks lift both. Raising either number lifts the gate and needs a fresh drain and pin review.
* **Per-transaction reclaim ceiling stays 384 MiB** (`cowork_ranges::plan`, "bounded-fixture policy"). At 1024 MiB that caps one reclaim transaction to 384 MiB; an oversized report is rejected atomically and the guest resumes. G4 must see whether this matters.

## Device inventory

The production profile does not touch `builder.rs`, any `device_manager`, or anything under `src/devices` except `block_trace.rs` (patch 0016, trace only). The inventory stays virtio block x2 (`0x0002`), console/runtime port (`0x0003`), rng (`0x0004`), balloon (`0x0005`), plus the always-present legacy devices. The GPIO shutdown device from the original S4 bullet is **not admitted** (n2-common rule 7): there is no GPIO code in the queue and the production gate refuses the one API that would attach it. Stop remains a guest `drain` frame followed by guest power-off.

A test pins the textual sequence of device attach calls in `build_microvm`, the single `register_mmio_gpio` call site (inside the shutdown-eventfd branch) and the budget constants (3 devices, 48 pins, 8 MiB).

## Test harness (patch 0014)

`cargo test -p krun-vmm` did not compile. Four of the five compile errors are in upstream v1.19.6 itself (`Vcpu::new_aarch64` gained an `ipa_size` argument and `Vm::new` an `ArchMemoryInfo` argument; the tests were never updated); the fifth is ours (the `VmResources` test literal lacked the fixture fields). Fixes: pass a fixed `TEST_IPA_SIZE` (the constructor only stores it; it is read when a vCPU runs), pass an `ArchMemoryInfo`, fill the literal with `..Default::default()` so a later field cannot break it again, and drop an unused import.

| Test | Disposition | Why |
|---|---|---|
| `macos::vstate::tests::test_vm_memory_init` | `#[ignore]` | calls `Vm::new`, which calls `hv_vm_create` |
| `cowork_admission_normalized_gpu_resources_rejected` | `#[ignore]` | calls `krun_start_enter` (admission refusal only, but the rule is no `krun_start_enter` path) |
| `cowork_admission_public_gpu_setters_rejected_before_any_vm` | `#[ignore]` | same |
| `cowork_admission_public_gpu_setters_rejected_by_validator_without_any_start` | new, runs | the same refusals through the pure validator |

The other 53 `krun-vmm` tests, read one by one, build only fakes, channels, temp files and `DummyIrqChip`; none reaches Hypervisor.framework. `--ignored` and `--include-ignored` are refused by the runner, and the preparer's audit fails if any `#[test]` containing `krun_start_enter(`, `Vm::new(`, `HvfVm::new(`, `hv_vm_create`, `hv_vcpu_create` or `build_microvm(` lacks `#[ignore]` (Linux-only KVM modules are not compiled on this host and are skipped by the audit).

Run result (`results/2026-10-17-n2-production-profile-native-tests.json`): 331 test executions passed, 0 failed, 3 distinct tests ignored. That is the admitted fixture's own device suites, the whole `krun-vmm` suite (53), the whole `libkrun` suite (30, once with the production features and once with `cowork-fixture-oracle`), and the main suites again under the shipped release profile (overflow checks on, debug assertions off, LTO). Cargo test binaries use a short `/tmp` temp root because macOS limits unix socket paths to 104 bytes (the admitted fixture runner does the same).

## Pin budget analysis (48 pins / 8 MiB under real ext4 journaling)

Analysis of the code only. **Nothing here was measured.** Measurement is gate G4.

### What a pin is and what happens on overflow

`Lease::pin(ranges)` registers a list of byte-exact guest-physical ranges as exclusions from reclaim. It fails with `Fault::Limit` when `pins.len() >= max_pins` or `pinned_bytes + bytes > max_pinned_bytes`. The production access object is `Access::new(3 devices, 48 pins, 8 MiB)` (data disk, environment disk, runtime port). A failure inside a device loop calls `access.stop()`, which flags the VMM stopped and fires the terminal notifier (`exit_code = 77`, exit event). So **a pin overflow is fatal by design**: the worker exits, and ownership of the volumes is retained until the stop evidence rules say otherwise. Failing the single request with an I/O error instead would be a design change and would hand ext4 an `EIO` (remount read-only or panic depending on `errors=`); the owner should decide that explicitly rather than have it slip in.

### Who pins, and the structural maximum

| Producer | Pins | Bytes per pin | Held |
|---|---|---|---|
| Block ring, one per disk (queue size 256: 4096 + 518 + 2054) | 2 | 6,668 | queue lifetime |
| Runtime port rings, 4 queues of 32 (512 + 70 + 262) | 4 | 844 | queue lifetime |
| Block request, at most one in flight per disk (`completion` busy rule) | 2 | rings again (6,668) + header 16 + status 1 + data <= 1 MiB | capture until used-ring publish, across host I/O and fsync |
| Port frames, at most one per queue: rx chain <= 1 MiB, control rx <= 1 MiB, tx <= 64 KiB, control tx = 8 B | 4 | descriptor ranges only | while the frame is held |
| rng, balloon | 0 | | |

Structural maximum: **12 pins (25% of 48)** and **4,289,930 bytes, about 4.09 MiB (51% of 8 MiB)**. The data limit comes from what the device advertises: `VIRTIO_BLK_F_SIZE_MAX = 64 KiB` and `seg_max = 16` give 1 MiB, equal to `MAX_REQUEST`; indirect descriptors are not offered and are rejected (`descriptor chain` error); `EVENT_IDX`, `DISCARD` and `WRITE_ZEROES` are masked.

### What journaling changes, and what it does not

ext4 with `data=ordered` writes data first, then the jbd2 commit: descriptor blocks, metadata blocks, then a commit block with a pre-flush. For this device that means a higher request rate, many 4 KiB metadata writes, and frequent `FLUSH` requests (each ends in `sync_all` on the backing file). It does **not** add concurrency at the device: the host serves one request per disk at a time whatever queue depth the guest keeps in the avail ring, and only the popped head is pinned. So pin count and pinned bytes are set by request size and by posted receive chains, not by the journal. Under the invariants above the budget has about 4x headroom in count and 2x in bytes.

The invariants are the thing to protect. Changing any of them invalidates the table: queue sizes, `seg_max`/`size_max`, a third disk or second queue, another port, a larger `MAX_CHAIN`. A hostile or buggy guest driver that ignores `size_max`/`seg_max` produces a `Limit` fault on the request and the same fatal stop, which is the intended fail-closed behaviour, not a budget overflow.

### What actually bounds a long-lived guest (and a defect found)

Three limits other than the pin budget are fatal and scale with ext4 activity or with reclaim time:

1. **Block trace row cap (defect, fixed by patch 0016).** `block_trace::emit` is called on every block request in the production path, prints a JSON row to stderr (with guest physical addresses, sector and length), and returns `Fault::Limit` after **60,000 rows per process**. A failed `emit` fails the request and stops the worker. Each request emits at least four rows (capture, io begin, io end, used ack), so a production guest would end itself after at most about 15,000 block requests, which real ext4 reaches quickly (a single large checkout does). Patch 0016 compiles the trace out of production builds: `emit` becomes an inert `Ok(())`, the production archive contains none of the row names (checked), and the oracle build (`cowork-fixture-oracle` enables `devices/cowork-fixture-trace`) keeps the trace unchanged. Everything the reclaim path needs (`exclusions()`) is independent of the trace.
2. **Freeze drain, 1 second.** `Access::freeze(epoch, 1 s)` waits for active leases to drop. Leases cover only short copy sections and are never held across host I/O (the pipeline drops them before the disk call), so a slow `fsync` does not trip this, but a guest that keeps leases busy for a second does.
3. **Completion wait, 2 seconds.** A block thread that finishes a request while admission is closed waits at most 2 s for the freeze to end, then stops the worker. The reclaim transaction (park both vCPUs, unmap, replace, map, resume) must therefore finish well inside 2 s under ext4 load. The vCPU pause acknowledgement has its own 1 s deadline.

A smaller effect, not a fault: reclaim is rejected atomically for a whole batch if any reported span overlaps a pinned range, and pinned ranges are byte-exact while reported spans are 16 KiB host pages, so a pinned 844-byte ring excludes its whole page from any batch that reports it.

### What the G4 run must record, and tuning handles

* Per freeze: pinned count and bytes (the existing `block_freeze_pin` rows exist only in the oracle build now; a production high-water-mark counter would be a reviewed addition), the number of requests since start, freeze duration, pause duration and the disposition (`replaced`, `noop`, rejected).
* Per disk: request size distribution and flush rate while the guest runs a journaled write load (small-file churn, large sequential writes, `fsync` storms, a clean unmount and a `kill -9` mid-write with journal replay).
* In the guest: `/sys/block/vd*/queue/{max_sectors_kb,max_segments,max_segment_size,nr_requests}` to confirm the 1 MiB ceiling is what the driver honours.
* PID 1 (S5) can bound request rate with `max_sectors_kb`, `nr_requests` and the `commit=` mount interval if G4 shows pressure. None is needed for the pin budget.
* Success means: pinned count and bytes stay below the structural maximum at every freeze, no `Limit`, no stop, the freeze and completion waits stay well under 1 s and 2 s, and the three-cycle active RAM return still holds with the real 321 MiB resident root.

## Reproducible build

Everything runs offline against local inputs: `out/libkrun` (a clean clone at the pinned revision), `out/rust` (installed from the checksum-pinned `rust-1.90.0-aarch64-apple-darwin.tar.xz`), `out/cargo-home` (the offline crate cache for the pinned `Cargo.lock`). Nothing is downloaded and a missing input stops the script.

```
cd spikes/cowork-hvf
python3 -B test_production_profile.py          # native tests, dev and release profiles
python3 -B build_production_profile.py --toolchain-archive <local rust archive> --repro-root <another absolute directory>
python3 -B record_production_evidence.py       # normalised receipts into results/
python3 -B test_production_profile_scripts.py  # pure-Python guard tests
```

Recipe (`production_profile_lib.release_env`):

* Toolchain: rustc 1.90.0 (`1159e78c4747b02ef996e55082b704c09b970588`), checked by `rustc -vV`, and the 116 installed files of rustc, cargo and rust-std are compared byte for byte with a fresh extraction of the checksum-pinned archive.
* Source pin: libkrun `227b2de6...` plus the hash-checked queue (above); `Cargo.lock` hash checked; 71 cached crates each match their `Cargo.lock` checksum and their unpacked source equals the archive's contents.
* Command: `cargo rustc -p libkrun --release --locked --offline --no-default-features --features blk --crate-type staticlib`.
* Profile: `CARGO_INCREMENTAL=0`, debug 0, LTO, 1 codegen unit, `panic=unwind`, **overflow checks on, debug assertions off**, `SOURCE_DATE_EPOCH`, `LC_ALL=C`, `TZ=UTC`.
* Paths: `CARGO_ENCODED_RUSTFLAGS` (unit-separator encoded, because real paths contain spaces) with three `--remap-path-prefix` entries: source to `/libkrun`, cargo home to `/cargo-home`, toolchain to `/rust-toolchain`.
* Strip: `ZERO_AR_DATE=1 /usr/bin/strip -S` on the archive.

Findings:

* **`strip` is not deterministic without `ZERO_AR_DATE=1`.** Apple's `strip` stamps the archive table of contents with the current time. The raw rustc archive is identical across builds; the stripped one differed on every run until `ZERO_AR_DATE=1` was set. The first reproduction attempt failed on exactly this.
* **Reproducible across locations.** The raw archive `460c3829cd79333ed8bbc556e2ca41ac0ea907e0dcfe7c6d87df24b93aaf1d0b` and the stripped archive `f6e7beec1a11a3abb23007bbfc70354ad3dbe14fd8c8ded85cb887acee810f38` were produced twice, the second time from a copy of the source, toolchain and crate cache at a different absolute path, and are bit-identical.
* **`strings` check.** No home-directory, `/private`, `/var/folders`, `/Volumes`, `/home`, `/Applications`, `/tmp` or builder login/home-name string survives in the stripped archive, in a Mach-O that links it, or in that Mach-O stripped with `strip -x`. The **raw** archive does carry one path: the Rust project's own CI Xcode path (`/Applications/Xcode_15.4.app/...`) in the debug stabs of the toolchain's prebuilt `compiler_builtins` members. It is not the builder's, and `strip -S` removes it, so a worker must link the stripped archive (or strip the final binary) before the release name scan sees it.
* The production archive contains none of the fixture block trace row names; the oracle archive contains all seven.
* The linked probe depends only on Hypervisor.framework, `libiconv` and `libSystem` (`otool -L`). Probes are signed only by the linker (ad hoc); no signing identity, notarisation or `codesign` command was used.

Sizes: stripped production archive 7,269,944 bytes; a release build takes about 33 s on the build host.

## Licences

libkrun's own crates (`libkrun`, `krun-*`) are Apache-2.0 (`LICENSE` in the repository). Source files adapted from Firecracker and crosvm keep their own headers (Apache-2.0 and BSD-3-Clause). Dependency graph of the production build for `aarch64-apple-darwin` with `blk` (96 `cargo tree` lines, `-e normal,build`):

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

Each guard was mutated in the composed source, the named test was run and had to fail, and the file was restored (the tree was re-verified against the pinned hash afterwards). 22 of 22 were killed (`results/2026-10-17-n2-production-profile-mutation-checks.json`; the driver lives outside the repository):

memory ceiling lifted (production and reviewed copy; and production constant alone), vCPU count lifted (both copies), memory floor removed, pair memory rule ignoring the production range, fixture pair accepting the production range, shutdown eventfd allowed, fixture trace allowed, HVC stream allowed (both copies), production enable after a fixture opt-in, fixture enable on a production context, runtime-port factory serving both profiles, pair setter serving both profiles, fixture trace enable on a production context, preflight without the marker, a fixture declaration outside the header macro, a header limit that disagrees with the gate, the pin count budget changed, a device attach site added, the block trace compiled into production, and (Python guards, no cargo run) the `#[ignore]` removed from the HVF-creating test and from a `krun_start_enter` test.

## Review needed

1. **Names.** S1's contract must adopt the production names or S4 rebases onto them. The preflight function is optional.
2. **vCPU count.** "At most 2" is implemented as exactly 2. Confirm.
3. **Memory floor of 768 MiB** and the 384 MiB per-transaction reclaim ceiling at 1024 MiB.
4. **Patch 0016 is a behaviour change** in the block path of the production profile (no per-request stderr rows, no row cap). It is independent of 0014/0015 and can be dropped, but then a production guest ends itself after roughly 15,000 block requests.
5. **Release profile.** The shipped profile has overflow checks on and debug assertions off; the reviewed fixture evidence ran with both on. The main suites pass under the release profile too, but G4 should run on the shipped profile.
6. **Fatal-stop policy.** Pin overflow, a trace/I/O fault, a long freeze and a stale queue all stop the worker with exit 77. Decide whether a failed request should ever degrade to `EIO` instead.
7. **Fixture-era output still in the production path.** `cowork_fixture.rs` prints reclaim JSON to stderr, including host virtual addresses in `reclaim_unmap` rows, and uses `eprintln!`, which panics if stderr cannot be written. Not changed here; bounded capture and redaction belong to the worker (S3), or a follow-up patch.
8. **The fixture gate's shutdown-eventfd hole** is left as is in the oracle (documented above).
9. **Independent code review** of the three patches before any run (XL slice).

## What was not done

No VM, worker, launcher or sandbox runtime. No `krun_start_enter`, `hv_*`, `pmset` or signing-identity use. No measurement of any kind: the pin analysis, the 2 s and 1 s deadlines and the 384 MiB ceiling are code reading. No CI ran: this repository's workflow triggers only on pull requests to `main`, and the draft pull request targets the fixture branch.
