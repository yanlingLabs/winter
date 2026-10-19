# WinterCoworkLibkrun

The libkrun patch queue and reproducible build for the Cowork Mac VM worker's **production profile**. It
produces one hash-pinned static archive, `libkrun-production.a` (the stripped one is what the worker links).

Status: **source and offline build only. No VM has ever run this profile**, no worker is built here, and nothing in the repository
imports this directory (a test pins that). A VM run needs an independent review of the exact commit and the owner's approval
(gate G4: three-cycle reclaim on real ext4 at 2 vCPU and 768..1024 MiB). Review history of the queue: PR #55 (`cowork/n2-libkrun-profile`)
and its two review rounds (a rejected first round, a rejected delta round, then accepted at `3a8f24d2a`).

## What is pinned

| Pin | Where | Value |
|---|---|---|
| Upstream libkrun | `upstream-pin.json` | v1.19.6, commit `227b2de6ed323fe180e02f871c5f325a90c13cc2`, source archive SHA-256 `373bed12b9d8b59dd8cb526cf91aa4ea4d94b468c761b98eb8fd3f345aee0050`, git tree `16c2ac4cdd03e394e813b244e4be3b6325215f0b`, `Cargo.lock` SHA-256 `a73d2ee0e4f2d2b63c7b4a00d2639076e4f7884a40cec495d5d82eed14dcd873` |
| Rust toolchain | `upstream-pin.json` | 1.90.0 (`1159e78c4747b02ef996e55082b704c09b970588`), aarch64-apple-darwin, archive SHA-256 `9772d20d5cd736079a0ee84d00e6697cf2084f0fc4621b011e24e6f2d08d2d7f` |
| Patch queue | `patch-queue.json` | 22 patches, 0004-0025, each SHA-256 pinned (table below) |
| Composed source | `expected-hashes.json` | `git diff` of the pristine tree after the whole queue: `bcb22a3e52db00e6f2d75d9e0b7c24df2f0cca9a0c793ec0693259599cf993ce` |
| Production archive | `expected-hashes.json` | features `blk,cowork-production-only`; raw `630dfb7da04cd7b78b884c0dcf8fea517fb11ffed625524ff21be0c31492f82e`, stripped `bc6a243df25de71e57791715d1162fff56ff29d292f15ee3540c3c19c2b0b12d` |
| Exports | `expected-hashes.json` | 72 `krun_*` symbols: the 62 upstream ones for this feature set plus 10 `krun_cowork_*_v1`; no `fixture` symbol |

No downloads happen except in `scripts/fetch_inputs.py`. The build is rebuilt only when a patch, the upstream pin or the build
recipe changes: `scripts/build_archive.py` keeps a build key in `out/` and reuses a matching archive, and it fails if a rebuild
differs from `expected-hashes.json` (review the change, then update that file on purpose).

## Layout

```
upstream-pin.json      libkrun + Rust pins          patch-queue.json   patch hashes, declared file scope, limits, inventory
expected-hashes.json   composed / archive / exports  patches/           0004-0025 (git-diff format, applied in order)
scripts/               fetch_inputs.py  prepare_queue.py  build_archive.py  run_cargo_tests.py  libkrun_common.py  abi_smoke.c
tests/                 test_queue_guards.py (pure Python: no network, no cargo, no VM)
out/                   git-ignored: fetched inputs, composed source, archives
```

## Rebuild

```sh
cd apple/Cowork/WinterCoworkLibkrun
python3 -I -B tests/test_queue_guards.py       # guards only: offline, no cargo (the composition test also needs out/libkrun)
python3 -I -B scripts/fetch_inputs.py          # the only networked step: pinned source archive, toolchain, crates
python3 -I -B scripts/prepare_queue.py         # compose and prove the queue (hashes, per-patch deltas, scope, no-VM audit)
python3 -I -B scripts/build_archive.py         # reproducible archive; checks the expected hashes; rebuilds at a second path
python3 -I -B scripts/run_cargo_tests.py       # the native suites, one thread, never --ignored (664 test executions, 3 ignored)
```

The build uses fixed release-profile settings, `--remap-path-prefix` for the source, cargo home and toolchain, and
`ZERO_AR_DATE=1 strip -S`. A `strings` scan requires that no builder path survives in the stripped archive or in a linked Mach-O.
The raw archive carries one path from the Rust project's own prebuilt `compiler_builtins`; link the **stripped** archive.

## Patch queue

Every patch applies to the previous composed state, so the queue is a stack. Patches 0001-0003 of the original spike
(instrumentation and the first drafts of reclaim and the guarded block) are not carried: 0004 applies to pristine libkrun and
supersedes them. 0004-0013 are the admitted two-disk fixture queue, unchanged.

| Patch | Purpose | Production or fixture | SHA-256 |
|---|---|---|---|
| `0004-proposed-guarded-block-reviewed-fixes.patch` | guarded block device with active reclaim, the reviewed fixes | production (block path, pins, reclaim barrier) | `8d4dc9165f5fab67985280fc70e06054ccf62b43a0fd46f595aa63ebe7caf481` |
| `0005-proposed-guarded-block-producer-progress.patch` | block producer progress | production | `0a70eaae09b1b6db09b804c7983b455731deec069b82bf88b0565b1bfe381775` |
| `0006-proposed-raw-block-trace.patch` | raw block trace rows (`block_*`) | FIXTURE evidence code; compiled out of production by 0016 and 0020; kept because later patches edit its files | `00e169fb7e5c527d348269cc8211afc99daa800622bce6140a4b2b42c204951d` |
| `0007-proposed-guarded-stream.patch` | guarded stream | MIXED: the stream I/O core is used by the runtime port; the bootstrap/runtime stream entry points are oracle-only | `4acf7d82622d98ca1265e6a57bcd167f6df1fd5efb6a63cc65a9f6b24f35e044` |
| `0008-proposed-guarded-stream-reviewed-fixes.patch` | guarded stream, reviewed fixes | MIXED (as 0007) | `43331eedec8e73f735830932b56c28cb3eb311f1c9bcbf3535f497063a369378` |
| `0009-proposed-guarded-stream-closed-factory.patch` | guarded stream, closed factory | MIXED (as 0007) | `ae46b3d1732cf6e00b3cb451334be04b222093cd78418b91b706d2a33a4f35c4` |
| `0010-proposed-generic-runtime-port.patch` | generic runtime port | production (`krun_cowork_create_runtime_port_v1` is built on it) | `62298de5d9176725d6a4bf0f79183a141de6d3162ff6085bce42ecd43f235752` |
| `0011-proposed-runtime-port-fixture-trace.patch` | runtime-port fixture trace | FIXTURE evidence code (entry point exists only with `cowork-fixture-oracle`); kept because later patches edit its files | `fe41eb3b7891d4c7bb7fa61d43508d4173d9e72a27b9476bb4de0c64ea5815c0` |
| `0012-proposed-admitted-workspace-disks.patch` | admitted workspace disks (RAW pair intake) | production | `c956cfcedc99dcebee26784873fd22f7efd3fa1fb22b3beb937b974756efcba7` |
| `0013-proposed-workspace-disks-startup-phases.patch` | workspace disks start-up phases | production | `f70c5b11586211c81b88a0acc27bdc357ed4437418bdffbf8cae0a2217c152ae` |
| `0014-proposed-krun-vmm-unit-harness.patch` | krun-vmm unit harness fix; VM-reaching tests are `#[ignore]` | test only | `b5bda53c97f86c1b130639340f3d97c9a96d37765a63820a6ca9c86664c88844` |
| `0015-proposed-cowork-production-profile.patch` | production profile gate, limits, fixture entry points behind cfg / the oracle feature | production | `e3c6c42ab5e30f33586f8d07e5a6c5e6fcc38e5a5e20393c824d08edf5f90daf` |
| `0016-proposed-production-block-trace-off.patch` | block trace compiled out of production | production hardening | `97708943e9ac82db658fe0c322d5140f66966cab201bae4b33e3e56e334fbdf8` |
| `0017-proposed-production-abi-v1-names.patch` | canonical `_v1` names | production | `628c88a57fbb7216132eba089d1fd028ea706d7a1658ba3fe4c7765950d8a529` |
| `0018-proposed-production-gate-matrix-tests.patch` | device-inventory gate matrix tests | tests | `311e58b4695d91703519c6173a484077b15977a5930eef453510cf7111a84d45` |
| `0019-proposed-production-start-admission.patch` | mandatory preflight enforced at start; `cowork-production-only` feature | production | `805356bdf1f74146b0daa92d7c502107702d6b0520c9eb814fdf6c3bef30c82a` |
| `0020-proposed-production-quiet-block-and-reclaim-paths.patch` | no completion hold, no reclaim rows on stderr in production | production hardening | `8f395ba2db2cec9b7ba0551e3497ce5664c62ee85a76597ded93e52abb418590` |
| `0021-proposed-production-flush-and-pin-counters.patch` | flush counters per disk, pin high-water counters | production | `f3341cea82ea205507b7fc533674493c4c91b39ecf7b22e844f0017ea6c9cc3a` |
| `0022-proposed-production-exit-path-final-flush-and-hook.patch` | one exit path, final flush of both volumes, exit hook | production | `965d43e3c06f5f73f249c4a808600ab378464e5e1e5cd13b11f82196fc8c397a` |
| `0023-proposed-production-exit-and-final-flush-pins.patch` | running pins for the exit path and the final flush | tests (plus `finish` takes its budget as a parameter) | `0877eaec2bfce5a0b59915c1eb3c61f29fdf20e06ce83cfead1e44eb66ab83fc` |
| `0024-proposed-confined-virtiofs-server-core.patch` | the confined virtio-fs server core for Cowork shares (R0-R13 server half): closed opcode allowlist, checked names, descriptor-relative host calls, read-only, bounds, revoke flag; FUSE-message harness tests | production code, not wired yet (the device, ABI and gate come in later patches) | `4cb81b56ee3da01eb9bc3c66d9cda529ae12ed5f77c7201bee6d5f05e13b18f5` |
| `0025-proposed-guarded-fs-device-shares-abi-gate.patch` | the guarded fs device of the shares (one device per share, reclaim pins, freeze, chain bounds, revocation by the device thread, exit-path join), the budget from the share count, `krun_cowork_add_share_v1` / `revoke_share_v1` / `next_share_event_v1`, the gate clause for `r.fs` and gate-matrix rows with shares present | production | `953a5e2858ef1e18faa5baf255d790602be8a2952a8970473f0eef8e2fd7fb9c` |

**Fixture-only code.** Nothing could be dropped. 0006 and 0011 add fixture evidence rows and 0007-0009 contain the oracle-only stream
entry points, but later patches (0007 onward, 0016, 0020) edit the files they create, so leaving one out means rewriting the stack and
changing the reviewed hashes. The production profile contains none of that code at run time: the fixture entry points exist only with the
cargo feature `cowork-fixture-oracle` (or `cfg(test)`), the trace and reclaim rows are compiled out, and the archive exports no
fixture symbol and carries no trace-row string (both checked on every build). The feature `cowork-production-only` and
`cowork-fixture-oracle` are mutually exclusive (`compile_error!`); the production recipe never enables the oracle.

## Confined virtio-fs server (0024)

`src/devices/src/virtio/fs/macos/confined/` serves one Cowork share from a root descriptor, and `Server::handle_confined_message`
(`server.rs`) dispatches a closed opcode list to it; every other opcode answers `ENOSYS`, INIT negotiates only
`ASYNC_READ | BIG_WRITES | AUTO_INVAL_DATA | MAX_PAGES` with `max_pages` 256, and a revoke flag answers `EACCES` before anything
else. Host calls are `*at` on held directory descriptors with `O_NOFOLLOW_ANY | O_RESOLVE_BENEATH` (or the `AT_`/`RENAME_`
equivalents), confirmed by (dev, ino); `O_UNIQUE`/`AT_UNIQUE` on the Winter shares. Limits: 4,096 handles (`ENFILE`), a directory
LRU of 1,024, 1 s timeouts, modes masked to `0o755`. The constants the pinned `libc` crate lacks are defined with their SDK header
lines. It adds no device, export or gate change itself; 0025 serves it.

## Guarded fs device and shares (0025)

`src/devices/src/virtio/fs/cowork.rs` is the device of one share: the stock `Fs` transport with `enable_cowork_share`, and a worker
that serves the share's `ConfinedFs` the way the guarded block device serves a volume. The device registers with the reclaim
`Access` (as `3 + i`), pins both rings for the activation and each request's descriptor ranges from pop to used entry, and touches
guest memory only under a lease: the request is copied out, the server runs on a private bounce copy laid out descriptor for
descriptor with no lease held, and the reply is copied back; a freeze defers either lease. A chain of more than 260 descriptors or
1,056,768 bytes (4,096 on the high-priority queue) is refused before anything is pinned (terminal, as a malformed block chain). One
thread per device, no shared-memory region, no `EVENT_IDX`. The budget is built from the actual share count S:
`3 + S` devices, `48 + 4 S` pins, `8,388,608 + 1,114,136 S` bytes (15 / 96 / 21,758,240 at S = 12), and
`krun_cowork_get_pin_counters_v1` reports it once a VM was built. Revocation sets the share's flag; a running device thread is woken
through its request queue event and closes its own descriptors (at once when idle, otherwise at its next request boundary), a share
with no running thread is closed by the revoker under the slot lock; only then is `REVOKED` queued for the worker's
`share_revoked{tag}`. The exit path stops and joins every share worker before the exit hook. `share_notice` events go through a
`NoticeSink` (the R15/R16 hooks of the next patch report through it) onto the same queue, once per tag and kind.

## Production ABI (`include/libkrun.h` after the queue)

| Entry point | Purpose |
|---|---|
| `krun_cowork_enable_profile_v1(ctx)` | marks the context as the production profile; refuses a context with any fixture opt-in; once |
| `krun_cowork_create_runtime_port_v1(...)` | generic runtime port; only the opposite peer fd (>=3, CLOEXEC) leaves the library |
| `krun_cowork_set_workspace_disks_v1(...)` | the two admitted RAW volumes: borrowed fds, identity checks, no path opens |
| `krun_cowork_validate_profile_v1(ctx)` | **mandatory** preflight; `krun_start_enter` refuses a production context that never passed it |
| `krun_cowork_get_flush_counters_v1(out)` | process-global per-disk `requested`, `completed`, `final_sync_attempted`, `final_sync_completed` |
| `krun_cowork_set_exit_hook_v1(ctx, hook, user_data)` | optional, once; called last, on the exiting thread, with a reason |
| `krun_cowork_get_pin_counters_v1(out)` | **seventh entry point, beyond the canonical six**: pin budget (48 pins, 8 MiB; with S shares the built budget) and high-water marks |
| `krun_cowork_add_share_v1(ctx, tag, root_fd, flags, guest_path)` | one host-backed share (SH2): tag `[a-z0-9-]{1,32}` distinct, a borrowed directory fd, flags bits 0-2 only, a canonical guest path under `/workspace/` or `/run/winter/`; at most 12, each root and mount point once; production contexts only |
| `krun_cowork_revoke_share_v1(ctx, tag)` | R11 from any thread; the share's device thread closes its descriptors, then the revocation is queued |
| `krun_cowork_next_share_event_v1(ctx, out, timeout_ms)` | drains `REVOKED` (send `share_revoked{tag}`) and `NOTICE` (send `share_notice{tag, kind}`) events; 1, or 0 on timeout (at most 60,000 ms) |

Exit reasons (`uint32_t`): `KRUN_COWORK_EXIT_NONE` 0, `OFF` 1 (PSCI SYSTEM_OFF), `RESET` 2 (PSCI SYSTEM_RESET), `VCPU_ERROR` 3,
`TERMINAL_FAULT` 4 (exit status 77). The hook type is `void (*krun_cowork_exit_hook_v1)(void *user_data, uint32_t reason)`.
Flush counters: `int32_t krun_cowork_get_flush_counters_v1(struct krun_cowork_flush_counters_v1 *out)` with
`{ uint32_t size; uint32_t device_count; struct krun_cowork_flush_device_v1 device[2]; }`; `device[0]` is `winter-data`, `device[1]` is
`winter-environment`. `struct krun_cowork_volume_identity` stays unsuffixed. Fixture names (`krun_*_cowork_*`) are declared only under
`#ifdef KRUN_COWORK_FIXTURE_ORACLE`. Call order: `krun_create_ctx`, the non-device setters, `krun_cowork_enable_profile_v1`,
`krun_cowork_create_runtime_port_v1`, `krun_cowork_set_workspace_disks_v1`, `krun_cowork_add_share_v1` per share, optionally the exit hook, `krun_cowork_validate_profile_v1`, `krun_start_enter`.
Share event: `struct krun_cowork_share_event_v1 { uint32_t size; uint32_t kind; uint32_t notice; uint32_t reserved; char tag[36]; }` (52 bytes); kinds
`KRUN_COWORK_SHARE_EVENT_REVOKED` 1 and `NOTICE` 2; notices `ENVRC` 1, `VSCODE_TASKS` 2, `VSCODE_SETTINGS` 3, `CODE_WORKSPACE` 4, `IDEA_PROJECT` 5, `GIT_PROTECTED` 6.

Limits and inventory: exactly 2 vCPUs and 768..=1024 MiB (`KRUN_COWORK_PRODUCTION_*`); devices: the admitted inventory
(`0x0002` x2, `0x0003`, `0x0004`, `0x0005`) plus one virtio-fs device (`0x001a`) per share from `krun_cowork_add_share_v1` (at most 12;
the gate admits `r.fs` only as that function builds it, so `krun_add_virtiofs*` and `krun_set_root` still refuse the context), no GPIO
shutdown device (the gate refuses the shutdown eventfd that would attach it).
Stop is a guest drain frame followed by guest power-off. Every setter that can add a device is classified by a running test.

## Exit and flush semantics (what a worker may conclude)

* Every stop goes through one exit path: it records a reason once (first writer wins), runs the exit observers once in registration order
  (the block devices' final flush, then the hook last), then `_exit`s. A watchdog bounds the whole sequence at 20 s.
* The final flush stops and joins each block worker, then flushes and `sync_all`s the volume, and records the true result per disk.
* A guest that stopped cleanly (off or reset) exits 0 even if a late fault fires.
* **Exit status 0 does not prove a final flush.** If the watchdog fires over a hung observer, the process exits 0 and the hook never ran.
  Treat "exit 0 with no hook observed", and any `completed < requested`, as an **uncertain final flush, never Class A**. A clean-shutdown
  claim needs the hook with `OFF`, both disks' `final_sync_completed == final_sync_attempted == 1`, and `completed == requested`.
* Hard crashes (SIGSEGV, SIGBUS, SIGILL, SIGSYS, abort) are not handled: no signal handler is installed, so the process dies by its
  default disposition with no observer and no hook. Also uncertain.
* The pin budget is 48 pins / 8 MiB, plus 4 pins and 1,114,136 bytes per share; overflow is fatal (exit 77). The structural maximum
  is 12 pins and 4,289,930 bytes, plus each share's 4 pins and 1,114,136 bytes (a test holds 12 shares at their chain maximum at once). The block trace,
  its row cap and the 25 ms completion hold are absent from production; the counters replace the trace for G4.
* Guest console output goes to the file descriptor the worker supplies; bounded capture belongs to the worker.

## REVIEW NEEDED

1. S1's contract aligns to these `_v1` names, enum values and structures; `krun_cowork_get_pin_counters_v1` is an addition (adopt or fold into the counters).
2. The 20 s exit budget and "a failed final flush does not change the exit status" are the owner's to confirm.
3. 0016/0020 change the production block and reclaim paths (a production guest no longer ends itself after about 12,000 block requests); 0022/0023 change how the process exits for every stop, the oracle included.
4. Fatal-stop policy: pin overflow, a stale queue, a long freeze all stop the worker with 77; decide whether a failed request should degrade to `EIO`.
5. The shipped release profile has overflow checks on and debug assertions off; G4 should run on it.
6. Independent code review of all 22 patches before any run; every VM or live gate needs the owner's approval.
7. 0024 (the confined virtio-fs server core) is reached only through 0025's share devices. Its decisions (ownership changes refused, MKNOD always `EPERM`, the revoke answer for requests that take no reply,
   `O_NOFOLLOW_ANY` in place of `O_NOFOLLOW`) are listed in its pull request and need review with it.
8. 0025 (the share devices): an over-bound or malformed fs chain is terminal (exit 77), as a malformed block chain; a revocation
   before the start, or while the device is reset, is closed by the revoking thread under the share's slot lock; no `EVENT_IDX`;
   the decisions are listed in its pull request. The R15/R16 hooks (their own patch) report `share_notice` through the device
   layer's `NoticeSink`.

## Licences

libkrun's own crates are Apache-2.0; files adapted from Firecracker and crosvm keep their headers (Apache-2.0, BSD-3-Clause). The production
dependency graph for `aarch64-apple-darwin` with `blk` is MIT, MIT OR Apache-2.0, Apache-2.0 (OR/AND BSD-3-Clause for `vm-memory`, `vm-fdt`,
`virtio-bindings`, `linux-loader`, `vmm-sys-util`), BSD-2-Clause OR Apache-2.0 OR MIT (`zerocopy`), ISC (`libloading`), Zlib / 0BSD / Unlicense
alternatives (`foldhash`, `miniz_oxide`, `adler2`, `aho-corasick`, `memchr`, `jiff`) and `(MIT OR Apache-2.0) AND Unicode-3.0` (`unicode-ident`);
`imago` (MIT) is the storage layer behind the RAW pair. The archive also embeds the Rust standard library and `compiler_builtins` of the pinned
toolchain. The kernel the guest boots (GPL-2.0) is a separate artifact and Hypervisor.framework is a system framework; neither is linked into the archive.
The release notices file must list these; it is not generated here. The queue adds no dependency.
