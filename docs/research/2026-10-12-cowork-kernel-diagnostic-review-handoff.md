# Kernel diagnostic correction: independent-review handoff

Candidate source: **a4edf8d2b2e70142d8937e70bd16542569d72130**, diagnostic base **32003e7658992ec75f04c30bafa641f15d1b674c**, execution base9dce95ab. This is an author handoff, not source/artifact acceptance or privileged execution approval. The independent review found J1 at32003; the new leaf requires independent re-review.

**Exact changes:** kernel-journal-replay.c:21 adds fixed scalar stage/errno diagnostics before kernel I/O; fixture-loop-replay.c:9 reports retained stage/errno and numeric association mismatches. Its detach observer makes read-only observations after one clear request and owner close. Only actual status-ioctl ENXIO on the exact block device succeeds; open-ENXIO is pending, foreign backing/device and unknown errors refuse. The J1 leaf checks budget before attempts/status I/O and after results, refusing4000ms late ENXIO against the3000ms budget. Kernel calls are not interruptible by that budget; the unchanged outer20s timeout retains the actual live/uncertain helper and files. No mount/replay/clear effect repeats. Python kernel_replay.py:12 snapshots at most4096bytes per channel using pread; timeout prints/attaches those bytes without moving the live writer's position or treating diagnostics as cleanup proof. The strict corruption failure-class oracle remains unchanged.

**Tests:**11bootstrap protocol,5kernel no-effect,11staging tests pass;9ordinary Linux and2privileged kernel cases skip. The exact extracted C observer harness passes9injected syscall/clock scenarios, including late-success rejection and no new attempt after the prior sleep consumes the budget. These are source/no-effect checks, not real kernel/loop/helper execution. x86-64/ARM64 static helpers cross-compile with warnings as errors.

**Current artifacts:** `out/kernel-replay-deadline-review/{x64,arm64}`. Hashes below were rechecked locally; independent artifact admission is still required.

| SHA256 | x64 | ARM64 |
| --- | --- | --- |
| build.json | 69ceb8a5f2f27f6e4200a3dc56d75a5bf4269438bf596c0b32decc95f40ca3ab | ba1e887ba23b9d60a827afbbb83765cc97ff6c89d8dab436fc8599bec50252ea |
| kernel-journal-replay | a383edcde968afbf81ef1ab2a3c3dff3620f63a483b4e69532019fb6d3821fb6 | f20cc2d7b4de31e08b2f5fcdbaba35b61db2663d9b22cecc6013f7b78f11042d |
| fixture-loop-replay | 7875010f9e7282e27be2f1aa58280341f5e2ed15121d7b93181827a9d50b3cf0 | 5b2b9b81b3070f3230d493e0823a8ff41226ada1831d167acd35f725a58d351a |

**Evidence retained:** [38268479494/job114876585334](https://github.com/yanlinglabs/winter/actions/runs/38268479494/job/114876585334) timed out both actual cases. The old run did not capture the retain stage, so the cause remains unknown; transient detach is only a hypothesis. Original failed runs,32003artifacts/receipts and earlier failed e2fsck evidence remain intact. Workflow pins remain unchanged and reject the new closure before effects. No push or privileged rerun occurred. Mac VM/native-egress holds remain untouched.

## Smallest next user-flow step, contingent on recovery acceptance

This checkout's workspace/project creation still calls `requireProvisioning` at packages/core/src/cowork/service.ts:196; its default at:28 refuses. Guest runtime admission at guest-runtime.ts:106 requires genuine confined capability and a native port. `CoworkVolumes.filesystemsReady` at volumes.ts:433 requires both current-owner/current-plan receipts. Kernel fixture success alone cannot lift any of those gates.

The smallest execution-bearing next slice is a **Linux bootstrap mount/admission bridge**: consume the existing confirmed data/environment pair, mount fixed workspace/protected-store/run-home paths from admitted descriptors, then start one fresh actual SDK session through the existing supervisor/private native capability. The isolated Linux test should drive a selected-source prompt through real tools/provider/store and verify durable transcript bytes in data.ext4. Keep unsupported routes/general Cowork creation refused; do not synthesize native host proof, duplicate storage records or touch the held Mac/egress adapters. This advances the first selected-folder conversation toward execution, but is not itself a complete Mac user flow.

A smaller immediately visible slice could expose canonical preparing/recovery-required state in existing workspace/project detail. It helps users understand blocked work but does not establish the first actual Cowork turn. Root should choose scope against newer composition; this read-only trace is limited to the frozen journal checkout.
