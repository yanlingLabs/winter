# Kernel journal replay independent review — 2026-10-12

Current disposition: **source/artifact/execution-scope review accepted at `1964382ee21020ad6c5af440218899cf69056b28` for the exact proposed disposable Linux CI workflow identified below**. All findings are corrected; historical findings remain preserved. The parent agent decides whether to commit/push/run that workflow. This is not a claim that privileged staging, journal replay, mount/loop cleanup or production activation has passed.

Reviewed `771c24169c375c352ca5b92cee4b79dac089a613` against `2d1b031d` in `.worktrees/journal-replay-pr`. Source and no-effect checks only; no Linux helper, privileged operation, mount, loop configuration, VM, network or live-home access. Acceptance for privileged Linux admission is pending the findings below.

## P1 — privileged fixture executable source closure is not bound

`spikes/cowork-filesystem-bootstrap/build_kernel_replay.py:5` omits `test_bootstrap.py` from `SOURCES`. Yet `test_kernel_replay.py:40` dynamically executes that module during the README's default Root unittest invocation. Changes to this executed dependency do not invalidate the purported closed source/artifact receipt.

Both local x64/arm64 build receipts validate against their listed sources and artifacts. A no-effect reproduction copied the listed source files into a disposable directory, wrote different `test_bootstrap.py` bytes there, pointed the validator at that directory and validated the original receipt successfully: `changedImportedTestBootstrapStillAccepted=true`. No changed code or helper was executed.

Bind every executed fixture dependency, or remove the extra dependency from the privileged entrypoint. Also preserve the actual pre-execution admission boundary: `test_kernel_replay.py:11` imports/executes bootstrap, replay and builder modules before receipt validation at `:55`. A later hash check cannot establish that the Python code already executed was admitted. Stage and verify the exact reviewed source closure before privileged execution/import; do not rely on this in-process late check as that boundary.

## P2 — unavailable replay adapter can be discovered after an earlier disk write

`spikes/cowork-filesystem-bootstrap/bootstrap.py:198` checks for the required replay adapter inside the per-target write loop, after `:194` may have formatted an earlier target. A valid mixed plan with data=`format-new` and environment=`replay-journal-then-probe`, pending recovery on environment, and no adapter passes both read-only preflights, invokes `mke2fs` on data, then refuses `kernel_replay_adapter_required`.

A no-effect reproduction used the existing disposable `Pair`, mocked probes and `run_tool`, and received:

```json
{"error":"kernel_replay_adapter_required","toolCallsBeforeRefusal":["mke2fs"],"actualHelperExecuted":false}
```

This contradicts the replacement report's no-writable-helper refusal for an absent port and needlessly leaves partial effects. Check all required execution capabilities after both preflights and before the first write. Add a mixed-action regression; the existing absent-port test sets both targets to replay and misses this ordering.

## Independently verified evidence and scope

- Kernel Python suite: 4 no-effect tests passed; 2 privileged tests skipped.
- Bootstrap Python suite: 9 protocol tests passed; 9 Linux tests skipped.
- Validated source/artifact hashes in `out/kernel-replay-source-review/{x64,arm64}/build.json`; `file` identifies all four helper artifacts as statically linked Linux ELF for the stated architectures. No binary was executed; independent compilation was not repeated.
- Inspected private mount-namespace creation, fixed mount options, syncfs and normal unmount, retain-on-uncertainty behavior, independent image open-description/flock, atomic unused-loop configuration, backing identity checks, and fresh ENXIO checks after close and helper reap. These are source observations, not successful Linux lifecycle evidence.
- The privileged tests exercise one constructed journal image per test through the loop port. The two-target orchestration is covered by mocked protocol tests; actual paired kernel replay and power-loss recovery are not established.

The reviewed worktree remains clean. These findings do not concern or authorize the separately held Mac two-disk or native egress tasks.

## Correction re-review — 6775497a

The eight-source closure now includes the dynamic `test_bootstrap.py` dependency. The README's literal stdlib gate hashes the parent bytes before compiling/executing those bytes. The parent captures all receipt-bound bytes before staging; direct privileged checkout-runner invocation refuses before repository imports. The mixed-plan barrier at `bootstrap.py:189` now checks all needed replay adapters before either target's write loop. Both original reproductions are addressed.

### P1 — root-owned leaves do not establish trusted staging ancestry

`stage_kernel_replay.py:35` uses `tempfile.mkdtemp(..., dir=parent)` with `parent=None` by default and no validation of the selected parent or its ancestors. Python may choose inherited `TMPDIR`, `TEMP` or `TMP`. Its isolated `-I -S -B` mode does not remove those environment inputs. `verify_staged` at `:49` checks the staged directory and leaf ownership/modes/hashes only; `run_staged` at `:66` later executes the runner through its absolute path.

If that tree sits below an unprivileged-owned or otherwise renamable ancestor, its owner can rename the verified root-owned 0500 tree (or an ancestor) and substitute another path after verification. Root ownership and read-only leaf modes do not prevent directory-entry renames by the parent owner. The substituted entrypoint executes before its own defensive checks could help. Staging's path-based writes/chmod calls likewise depend on stable ancestry.

Use a fixed staging parent whose complete ancestry is established as root-owned and not replaceable by unprivileged writers, with appropriate no-follow/identity validation, or an equivalent descriptor-pinned execution/import design. Reject unsafe inherited/default/explicit parents before staging or running. Add a no-effect regression for an unprivileged-writable parent and a rename/substitution attempt; checking the leaf's UID/mode alone is insufficient. No privileged reproduction was run.

A nonprivileged subprocess running exactly `python -I -S -B` with `TMPDIR` set to a disposable owned directory independently returned that directory from `tempfile.gettempdir()`. This confirms the environment-selection premise without invoking the stager or any helper.

### Correction evidence

Independently reran 6 stager no-effect tests, 11 bootstrap protocol tests and 4 kernel no-effect tests: **21 passed**, with 9 Linux and 2 privileged tests skipped. Read/captured all 11 receipt-bound entries (8 source files, 2 native artifacts, receipt) for each architecture, without executing them:

- `out/kernel-replay-source-closure-review/x64/build.json`: `6850a9690966d10c2571808817ed8a77052ed7d646d3220fb9166db611d238bf`.
- `out/kernel-replay-source-closure-review/arm64/build.json`: `39f842ec5c43804ff1fe80dc12bd9fe34723ec05e6bd109cab6966a6f3d98c47`.

Inspected retained-owner behavior: replay timeouts/malformed receipts retain the child and descriptors in the running fixture, C mounted-uncertainty paths retain the namespace/device, and fixture failure does not automatically remove backing files. The source update adds no kill-based cleanup proof. Actual cross-process retention, mount, loop detach and recovery remain unexecuted/unverified Linux gates. The checkout remains clean; neither held task was resumed.

## Fixed-parent correction re-review — 52071937

Independently reviewed `6775497a..52071937fe243a53bc1175196ed5470dcba24eae`. The remaining P1 is resolved, with no further material source finding in this scoped review.

`stage_kernel_replay.py:33` now validates the full, fixed staging ancestry: `/` and `/tmp` must be real root-owned directories, `/` cannot be group/other writable, and a group/other-writable `/tmp` must be sticky. `:43` admits only the expected direct child beneath `/tmp`. `:48` passes `dir='/tmp'` explicitly, so inherited temporary-directory variables and arbitrary caller parents cannot redirect the stage. `verify_staged` calls the same ancestry check before validating the owned tree; `run_staged` invokes that verification immediately before runner launch. Under these checks, an unprivileged parent owner cannot rename the root-owned stage or its ancestors between verification and execution. Existing whole-closure hashes, leaf checks and root-owned modes remain in place.

Independently reran **25 passing no-effect tests** (10 staging, 11 bootstrap protocol, 4 kernel bridge), with 9 Linux and 2 privileged tests skipped. Coverage includes fixed-parent selection despite hostile TMPDIR, unsafe owner/nonsticky writable/symlink parent refusal, and a real rename/substitution in a disposable unprivileged-owned parent refused before runner invocation. No Root-owned staging was performed.

Independently captured and verified all 11 receipt-bound entries for each architecture and the parent bytes:

- Parent SHA256: `04966aa34daedaf6184d27141568bbc01b6a22c3bc85b0a453d6dd7bea0887aa`.
- `out/kernel-replay-fixed-parent-review/x64/build.json`: `71041d761f1bf8f82c2c273445068743169720288a87604b0e231cf5dd073a91`.
- `out/kernel-replay-fixed-parent-review/arm64/build.json`: `a3e3b4b0811e098113a7e0bfb042c5097f9f5ee43dc297fe9aff32aa71341a4f`.

The pre-existing untracked `spikes/cowork-filesystem-bootstrap/__pycache__/` was preserved; the review created no source changes in the candidate. No privileged staging, helper execution, mount, loop operation, VM, network or held-task work occurred. Actual Linux execution and cleanup evidence remain to be obtained under a separately scoped disposable fixture plan.

## Exact Linux CI scope review — 1964382e

Reviewed source `52071937..1964382ee21020ad6c5af440218899cf69056b28`, the downloaded `out/kernel-replay-ci-38267412916/` artifacts, and the uncommitted `.github/workflows/cowork-kernel-replay-reviewed.yml`. **Ready for the exact proposed disposable Linux CI scope; no remaining material finding.** No workflow was launched by this reviewer.

The C changes only split UUID parser declarations onto separate lines for the Linux compiler. Corrupt-journal testing now requires the specific completed helper failure class instead of accepting timeout/receipt/admission uncertainty. The parent gate and captured leaf opens add `O_NONBLOCK`, with a FIFO-refusal regression, before regular-file identity/hash validation.

The reviewed workflow is restricted to same-repository PRs on `cowork/journal-only-recovery`, triggered by changes to its own file. It uses hosted Ubuntu 24.04, read-only contents/actions permissions, checkout without persisted credentials, the fixed artifact name/run ID `38267412916`, and the exact approved parent/receipt hashes. It checks existing facilities without installation/modprobe, then uses the literal isolated stdlib hash gate before root source execution, the accepted fixed-parent stage, and only the owned disposable fixture. Concurrency cancellation is disabled; the job retains a five-minute platform timeout. A timeout/failure must remain failed or uncertain, never proof of helper/mount/loop cleanup. Hosted runner disposal is not production storage recovery evidence.

The workflow bytes reviewed have SHA256 `591be8a04e545de8a47ba414056a771f4acfcc50c341dab579599e0b7783aa66`. Changes to those bytes or the pinned closure require reevaluation; this acceptance does not extend to an arbitrary future artifact/run, native Mac fixture, egress task or production mount.

Independently captured and validated all eight source files plus two artifacts and receipt, and checked both binaries' ELF64 little-endian x86-64 headers:

| Input | SHA256 |
| --- | --- |
| Build receipt | `9e0e0f1540ccd9e024d62e89192297a3aaa680dd870d8c77381a6b4be5d20188` |
| Hash-admitted parent | `452218acb0e3cb9c1e9ac6c911ba1b3544a1e8e07d08e773aa77c7739e3ddd3b` |
| kernel-journal-replay | `4a7442a0993f51f0048080ea70ae150e5502eeefaf285fd0475130ecf5026946` |
| fixture-loop-replay | `c25c98b133366fe4c86e090e6473f66d500317d8fb42b4a64f3dba6a4917a100` |

Independent local tests: **26 no-effect cases passed** (11 staging, 11 protocol, 4 kernel bridge), with 9 Linux and 2 privileged cases skipped. The reported green build/regular-file CI run was not re-queried because this review prohibited network; downloaded bytes were independently verified, and no kernel execution result is inferred from them. Existing untracked workflow and bytecode-cache files were preserved. No commit, push, privileged staging, native helper, mount, loop, VM, network or held-task execution occurred.
