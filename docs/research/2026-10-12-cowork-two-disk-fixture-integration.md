# Native two-disk fixture integration

This completes the bounded worker/guest/launcher slice after the narrow FD review
of `bfc67e48` and draft `4d76a00b`. It does not authorize a VM launch or enable
Cowork. The accepted native source/archive from `6b54d533` is unchanged. The
reviewed native startup correction already registers data/environment as access
devices 0/1 and the runtime stream as device 2.

The worker admits an unnamed connected datagram and restores CLOEXEC before any
volume intake. It installs its purpose-built no-network/share/fork/exec sandbox
before receiving the fixed 72-byte pair envelope. Truncated ancillary data still
forces immediate `_exit(79)` without acknowledging or releasing canonical
ownership. Pair metadata corroborates the independent native setter; it is not
production daemon/workspace/signed-worker authentication. Sampler/control alias
checks remain in the shared sampler admission, and wrong-type/named controls
refuse before consuming a queued envelope.

The launcher creates two disposable 0600 sparse files, with distinct 64/80 MiB
capacities, and retains its own descriptors through bounded supervision. Only the
control and sampler descriptors inherit across exec. The pair transfers through
SCM_RIGHTS; the worker receives only after sandbox installation, passes it to the
native setter, then closes its borrowed intake FDs. It never reopens disk paths.
The existing direct-child/capture/raw-stream supervision owns spawn failures,
interruptions, finite cleanup and uncertainty. An uncertain owner skips all disk
and raw inspection. Kill, EOF or sampler closure is never a native volume-release
receipt. This is a disposable fixture, not the production volume journal adapter.

Before either first write, Linux verifies vda/vdb serials `winter-data` and
`winter-environment`, sysfs sector counts, actual block-node rdev and BLKGETSIZE64,
and distinct opened block devices. Each disk has its own direct-I/O thread and
counters. Final per-disk receipts follow thread join and fsync/close. The host
oracle checks every word in each disk's intended cyclic region, and every byte
of the untouched remainder, so corruption, swapped roles and writes on the
wrong backing disk refuse. Generic stream audits receive only native device-2
freeze pins through the frozen single-disk audit's classification; environment
device-1 pins cannot masquerade as runtime coverage. Original raw rows remain
unchanged.

## Frozen source/artifact evidence

The final artifact namespace is `spikes/cowork-hvf/out/workspace-fixture-v2`.
The initial v1 cache and receipts remain preserved as an unadmitted draft; no
old generic/native cache or result was overwritten. The new worker is linked to
the hash-checked existing native static archive, ad-hoc signed with hardened
runtime and only the hypervisor entitlement. Library validation remains on,
debugger entitlement is absent, and only platform libraries are dynamically
linked. The guest init cross-compiles statically for ARM64 Linux. Both compile
with warnings as errors. Neither worker nor init was executed.

The final build receipt SHA-256 is
`4eb061c0e2549fd1ef7b39e27613d037ee076144c0ab74503f5ed9e9500b84ea`.
The exact archive, worker, init, initramfs, kernel and all launcher/capture/audit
sources are pinned by that receipt. Every launch rechecks them. Both sandbox-only
and VM modes require an independent receipt matching the exact build and mode;
VM mode additionally checks heavy compiler quiescence and ordinary host pressure.
No review receipt was created by this author.

Evidence files:

- `spikes/cowork-hvf/results/2026-10-12-workspace-fixture-v2-build.json`
- `spikes/cowork-hvf/results/2026-10-12-workspace-fixture-v2-artifact-check.json`
- `spikes/cowork-hvf/results/2026-10-12-workspace-fixture-handoff-tests.json`
- `spikes/cowork-hvf/results/2026-10-12-workspace-fixture-v2-final-test-receipt.json`
- `spikes/cowork-hvf/results/2026-10-12-workspace-fixture-v2-final-python-tests.log`

Verification: **60 Python tests pass**, including ten new real-FD bridge/oracle/
receipt/lifecycle regressions. Two strict-C handoff binaries pass: capacity 256
and the subprocess-isolated reduced-capacity 16 terminal truncation path. Named
controls refuse without consuming a queued byte; missing CLOEXEC/wrong type
refuse. The new lifecycle test uses one ordinary sleeping Python child (no native
worker/VM), confirms disk FDs never inherit, and verifies bounded reaping on
handoff refusal while preserving sender ownership. Artifact hashes and static
signature/entitlements/dependencies pass validation without running the worker.

The unchanged generic artifact-binding test could not run because this fresh
worktree lacks its frozen `out/generic-fixture-sampler/build.json`; it is explicitly
excluded from the final 60-test receipt. A first discovery attempt also named a
nonexistent test module; its raw diagnostic remains under the ignored new
`out/workspace-fixture-initial-diagnostics`. Neither limitation is claimed as a
passing check or a Linux/VM result.

## Runnable commands and next admission

From this checkout, building requires the existing reviewed native source/archive
root and the existing hash-pinned Zig/kernel cache root; no downloads, global
installation or native archive rebuild occur:

```sh
python3 -B spikes/cowork-hvf/build_workspace_fixture.py \
  --native-root <native-workspace-disks>/spikes/cowork-hvf \
  --cache-root <existing-winter-cache>/spikes/cowork-hvf
python3 -B spikes/cowork-hvf/test_workspace_fixture.py
python3 -B spikes/cowork-hvf/run_workspace_fixture.py \
  --sandbox-check --review-receipt <independent-two-disk-sandbox.json>
python3 -B spikes/cowork-hvf/run_workspace_fixture.py \
  --run-workspace-fixture --review-receipt <independent-two-disk-normal.json>
```

A full build refuses an existing final artifact directory rather than refreshing
a frozen receipt. Independent sandbox/source/artifact review and a separately
approved bounded VM run remain next. Two-disk active memory return, ext4 readiness,
production signed native admission/volume ownership, selected-source mounts,
actual SDK engine/store/provider boot and cold durable continuation remain open.
No credentials, live Winter state, Keychain, VM, shares, network or SDK pin/release
were touched. First-version encryption remains deferred as selected by the user.
