# Workspace disk startup stage correction

2026-10-12. Correction to reviewed `a4856143dffc33389fc24fcdb315657fa996c576`, on `cowork/native-workspace-disks`. Independent re-review remains required. The original0012 candidate, source, scripts and evidence remain unchanged; this correction is a separate0013 patch, `workspace-disks-candidate-v2.json`, and isolated `out/libkrun-workspace-disks-v2` source. No VM or start entrypoint was invoked.

## Reproduced blocker

The original preconstruction validator required an empty block list, then `krun_start_enter` constructed its two owned disks and applied that same rule again immediately before VMM allocation. A valid pair therefore rejected its own construction. The no-VM reproduction used the real prevalidator, the real constructor assigned to `cfg.vmr.block`, and the real second validator. It failed **0 passed / 1 failed** with `actual startup postconstruction validation rejected owned pair`; the normalized red log is retained separately.

## Actual production-path correction

Native source paths below are relative to the new isolated source; source changes are fully captured in committed0013.

- `src/libkrun/src/lib.rs:2873` defines `BeforeConstruction` and `BeforeVmm`. Before construction, the workspace requires an empty list with no retained constructor provenance. Before VMM allocation, it requires the exact normalized owned pair instead. The existing path-backed/legacy/extra-device, geometry, runtime-port and resource refusals remain in both phases.
- `src/libkrun/src/lib.rs:2926` is `cowork_prepare_blocks`, the actual shared startup preparation function. It executes prevalidation, real disk construction/publication, then postvalidation. `krun_start_enter` calls it at `:2990` and uses the postconstruction phase again after normalizing other resources at `:3100`. The regression calls this same closed function and final boundary, with no kernel loader, identity changes, VM allocator or start entrypoint.
- `src/vmm/src/vmm_config/block.rs:46` records private constructor provenance containing immutable expected metadata and the exact two constructed Arc objects. `:90` refuses preconstruction if that provenance remains, even if someone cleared the public list. `:93` requires exactly two entries, original order, pointer identity with the retained owned objects, and matching expected metadata for the current pair. Missing/extra/reordered/equally tagged but substituted/path-backed entries cannot mint provenance.
- `src/devices/src/virtio/block/device.rs:376` corroborates an immutable FD-constructor tag, fixed block ID/capacity/writeback state, no activated device and no existing worker thread. Ordinary path constructors have no tag. `workspace_disks_v2.rs` exposes read-only expected metadata for these internal checks; FD ownership, regular-file/mode/UID/link/identity/size admission and RAW storage remain unchanged.

Provenance is process-local internal corroboration, not authentication of daemon, home, workspace, worker or native stop. Retained Arc references prevent pointer reuse and keep owned resources alive until their owner drops. Failure/context unwind closes owned copies while caller descriptors remain open; no file replacement, truncation, permission repair or ownership-ledger release is added.

## Validation

Four new startup regressions pass. The valid pair reaches the exact final pre-VMM validation boundary; prebuilt/extra/retained provenance refuses before duplication. The postboundary refuses missing/extra/reordered objects, an equally tagged same-inode replacement object, an ordinary path-backed replacement, incompatible memory, metadata drift and a pair from another admission. Each case drops the context and verifies no extra descriptors survive and caller descriptors remain owned by callers.

The v2 API test mirror removes the old even-negative `krun_start_enter` calls. The correction test harness also excludes the old `cowork_admission` group containing those calls. Thus the new focused and regression commands never call start. Counts happen to equal the older run: **19 focused tests (8 devices/storage,11 library/builder/startup),117 primary tests /119 successful test executions, zero failures**. They are different test sets and are not relabeled old evidence. Production VMM/library `cargo check`, static build, C++ repeated-include/C-linkage/layout/export checks and the compiled no-start C ABI intake/cleanup probe pass. The full VMM unit harness remains the separately recorded failing gate from the original candidate and was not rerun or claimed passed.

```sh
python3 spikes/cowork-hvf/prepare_workspace_disks_v2.py
python3 spikes/cowork-hvf/test_workspace_disks_v2.py
python3 spikes/cowork-hvf/build_workspace_disks_v2.py
```

0013 SHA-256: `f70c5b11586211c81b88a0acc27bdc357ed4437418bdffbf8cae0a2217c152ae`. Composed source diff: `1f10f599acb6a29455c0422011aaa851cd598e6a7fee7e3699eb0f6988cfc300`. Static archive: `0d902f302ddc8935f2b993bbb8c96e26dd9f170281a32f791bc71ee8536bb6ca`. A clean pristine clone applying0004–0013 matches the composed diff and every shared source byte. All correction receipts/logs use new `results/2026-10-12-workspace-disks-v2-*` files. Personal prefixes/trailing log whitespace are normalized with raw/normalized hashes preserved; local raw originals remain under `out`.

The descriptor ABI, fixed developer resources, RAW storage/no hidden constructor writes,3 device IDs,48-pin/8MiB budget, same-user plaintext residual, format-once ordering and mandatory signed-worker/native authority gates are unchanged. The future protected producer must commit the format/probe intent before writable FD handoff; this metadata API does not grant that authority or filesystem readiness. No worker, VM, live home/app/daemon, Keychain, SDK pin, release or push occurred. This fixes the reviewed startup source transition, not two-volume Linux boot, active RAM return or production readiness.
