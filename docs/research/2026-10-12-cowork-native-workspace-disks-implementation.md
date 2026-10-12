# Native admitted-FD workspace disks implementation

Date: 2026-10-12. Implementation branch: `cowork/native-workspace-disks`, forked from `1856a1889fefc4a6a9ee84c882e045f9eaaaebb8` in `.worktrees/native-workspace-disks`. This is actual backend code, constructors, native tests and static build evidence. Independent review and a separately authorized new VM are required before transferring live-reclaim or production claims to the two-volume profile.

The pinned libkrun backend previously accepted exactly one path-backed RAW block and shared access IDs0/1 with its generic runtime port. New patch0012 adds atomic FD-based data/environment intake and a separate closed workspace profile. The historical one-disk fixture, frozen0004–0011 patches, candidates and result/build receipts were preserved.

## Source and contract

All source paths below are relative to `spikes/cowork-hvf/`. Ignored native source paths are reconstructed and hash-checked by `prepare_workspace_disks.py`; their changes are fully contained in the committed incremental patch.

| Source | Implemented behavior |
| --- | --- |
| `workspace_disks.rs:30` | Borrowed FD duplication with `F_DUPFD_CLOEXEC`, immediate RAII ownership and cleanup on every subsequent refusal. |
| `workspace_disks.rs:41` | Regular/current-UID/exact0600/nlink1/RW/non-append/expected dev-inode-size checks; bounded/aligned fixed capacities; CLOEXEC on owned copies. |
| `workspace_disks.rs:108` | Atomic pair intake, alias refusal, final revalidation of both pinned descriptors before publication; further typed admitted copies retain the original expected identity. |
| `workspace_raw_storage.rs:31` | Metadata-only, nonmutating constructor; positional fixed-capacity storage without image paths, hidden alignment probes, resize/growth or implicit backing opens. |
| `workspace_raw_storage.rs:39,68,116` | Checked whole-vector offset/length bounds, short/EINTR/zero/error handling and full `File::sync_all()` without relaxed override. |
| `out/libkrun-workspace-disks/src/libkrun/src/lib.rs:2877,3459` | Workspace-specific admission and actual C pair setter; existing one-disk admission remains the default when no pair is present. |
| `out/libkrun-workspace-disks/src/vmm/src/vmm_config/block.rs:64` | Both actual RAW devices constructed locally before list publication; failure drops pending files and a constructed first block. |
| `out/libkrun-workspace-disks/src/devices/src/virtio/block/device.rs:301` | Actual descriptor storage→RAW→Block constructor, fixed IDs/full-sync/cache settings; original path constructor keeps its behavior through the shared initializer. |
| `out/libkrun-workspace-disks/src/vmm/src/builder.rs:963,1010` | Exactly3 reclaim device slots,48 pins,8MiB aggregate pinned bytes and distinct runtime ID2, with ordered data0/environment1. |

The immutable expected metadata is a corroboration check, not daemon/home/workspace/worker authority. The profile requires exactly the FD pair and generic port, refuses path-backed/dormant legacy disks, HVC and incompatible extra devices, and keeps fixed2vCPU/768MiB as developer bounds. Actual signed-worker admission, complete host grants and automatic product resource policy are not implemented by this setter. No host abstraction, RPC caller descriptor grant, image path reopen or production provisioning toggle was added.

## Evidence

- **15 new native tests pass:**8 in devices/storage,7 in libkrun including exact production BlockBuilder cleanup. They test strict intake, no leaked extra FDs, caller ownership, real partial construction failure, context-free, profile refusal before kernel/disk/VM work, actual RAW read/write after rename and caller-close, resize/OOB/overflow refusal, metadata drift, partial/EINTR/zero/EIO behavior and aggregate pin limits/stop retention.
- **117 primary tests / 119 successful test executions pass, zero failures** in the frozen final regression harness. This includes the inherited generic/stream/RNG/access/block/admission coverage. `results/2026-10-12-workspace-disks-test-receipt.json` contains per-command counts. Rust production VMM/library check passes.
- Intake and construction preserve full file bytes, size, nanosecond mtime and allocated-block count before explicit I/O. Renamed admitted inodes remain the RAW backings; unrelated replacements are preserved. No ext4 formatter/readiness is claimed.
- Offline static library build passes. C++ repeated include, C linkage and32-byte identity layout and exported intake symbol checks pass. A compiled C probe calls the real setter and proves failed second/alias intake closes all new copies, successful intake owns exactly two copies and context-free preserves caller FDs, with `vmStarted=false` and `workerStarted=false`.
- Fresh pristine clone +0004–0012 applies cleanly, matches the full diff hash and actual/shared module bytes. The durable build receipt preserves the raw local test hash and separately binds the normalized committed test receipt.

Final patch SHA-256 `c956cfcedc99dcebee26784873fd22f7efd3fa1fb22b3beb937b974756efcba7`; full composed diff `610667ff8cac9325f3358f00234e3bf48174605b089de057ee11df77d46a8517`; archive `8d5941e83ec1595cf0a85dc1d021673cbcf81707bbe210862b19f46624cbb4b9`. Exact commands and receipts are in [readiness and next-adapter design](../../spikes/cowork-hvf/workspace-disks-readiness.md) and new `results/2026-10-12-workspace-disks-*` files.

## Separate failures and limits

The full patched-candidate krun-vmm unit harness does not compile. The failed command was `cargo test --manifest-path <isolated-source>/Cargo.toml -p krun-vmm --locked --offline --no-default-features --features blk --jobs2 workspace_disks --no-run`. Verbatim diagnostics are retained in `results/2026-10-12-workspace-disks-vmm-harness-blocked.log`: the resources test initializer omits Cowork fields, three stale `Vcpu::new_aarch64` calls lack the IPA-size parameter, and a stale `Vm::new` call lacks ArchMemoryInfo. These are candidate harness failures, not a full VMM pass or a claim about upstream main. To exercise the new partial-construction case, the libkrun test harness compiles the exact production block-builder file by path, without copying or reimplementing it. Normal production VMM code still compiles in the successful check/build.

An initial long-TMPDIR harness run failed in the pre-existing named Unix socket test; the final short disposable `/tmp` harness passes. Preliminary compile diagnostics in newly added tests were corrected before the final frozen run. The C probe linker has a recorded duplicate `-lSystem` warning; its exit code and ABI checks pass. No earlier failed result was relabeled a passing run.

The descriptor Storage is a new review boundary. It avoids inspected imago0.2.3's construction-time pread/pwrite alignment probe and retains the full-sync primitive, but is not assumed equivalent to the general path storage implementation or proof of physical-media/power-loss durability. Metadata checks cannot prevent arbitrary same-user concurrent mutation; plaintext v1 storage and encryption deferral remain accepted.

The inherited block reset/join and completion-hold limits remain. FD closure and context removal do not prove every native attachment/device/child stopped; canonical writable ownership must remain on unknown stop. No VM, signed workspace worker, native launch authority, filesystem formatting/mount/readiness, cold guest Winter execution, two-volume active RAM return, actual host disconnect/MMIO-reset recovery or complete production integration is claimed. The concrete proposed worker/FD intake/owned-stop/host-launch files and their admission obligations are recorded in readiness. No live Winter app/daemon/home, Keychain, credential, release, pin or push was touched.
