# Native Cowork VM probe

This is an isolated gate-1 feasibility adapter, not a shipped Cowork backend.
It links Apple's Containerization revision
`bc994b88df46207fad7775b0eabc51947e315881` into an in-process Swift dynamic
library. `Package.resolved` locks the resolved transitive dependencies. The
upstream package requires Swift 6.2 and macOS 15; this probe deliberately targets
Winter's macOS 26 ARM64 platform. It does not invoke the `container` CLI, launch
a Winter daemon, use ImageStore.default, read Keychain or mount a user folder.

Build from this directory:

```sh
swift build --jobs 4
swift test --jobs 4
nm -gU .build/debug/libWinterCoworkVM.dylib | rg winter_cowork_vm_
```

The output is `.build/debug/libWinterCoworkVM.dylib`. Signing the host executable
and this dylib, providing the virtualization entitlement, and proving loading
inside a compiled Bun executable are the parent harness's responsibilities.
An ad-hoc signature is local feasibility evidence, not a production signing or
notarization gate. Do not unload the dylib while native tasks or guests exist.

## ABI version 1

The declarations are in `include/winter_cowork_vm.h`. There are no JavaScript
callbacks and no separate Winter-owned controller process. Submit copies a
bounded request synchronously, returns a positive operation ID, and schedules
work on the Swift concurrency runtime. VZ device access is dispatched to its
own VM queue. Poll returns one terminal event as a caller-owned C string; free
it exactly once with `winter_cowork_vm_string_free`. Null means no terminal
event is ready. Operation completion order may differ from submission order.

At most 128 operations may be in flight or have unconsumed terminal events.
Submit returns zero for null input/backpressure. Accepted operations always
produce a terminal event unless the embedding process crashes or the native
operation never completes. Rejected input is an asynchronous failed event.
Requests are at most 64 KiB; each captured stdout/stderr stream is capped at
128 KiB with explicit truncation flags. Poll allocation failure leaves the
terminal event and its reservation queued for retry. Polling is required; there is no FD
wakeup channel in this C ABI prototype. This is a deliberate feasibility
fallback from the spec's preferred Node-API binding.

```json
{"schema":1,"opId":1,"method":"capabilities","status":"completed","result":{}}
```

Failures have `status:"failed"` and `error:{code,message,nativeChain}`. The bounded
chain includes NSError domain/code and sanitized descriptions (plus explicit
Containerization causes); arbitrary userInfo is omitted and paths outside the
admitted fixture and URLs are redacted. Malformed JSON may
omit `method`. All methods below return one terminal event; submit itself does
not mean the action succeeded.

| Method | Request fields | Result/behavior |
| --- | --- | --- |
| `capabilities` | `method` | Pin, ABI, PID, network mode and explicit limitations; no VM |
| `prepareRootfs` | `fixtureRoot`, `imageReference`, `outputPath` | Pull a public digest-pinned Linux ARM64 OCI image into an explicitly fixture-local ImageStore and unpack into a 1 GiB ext4 image |
| `unpackArchive` | `fixtureRoot`, `archivePath`, `outputPath` | Convert a local gzip tar filesystem archive to a 1 GiB ext4 image, without network |
| `create` | `id`, `fixtureRoot`, `kernelPath`, `initfsPath`, `rootfsPath`, `sourcePath`, `payloadPath`, `sharedReadOnlyPath`, `sharedReadWritePath`, optional `memoryBytes` | Boot one LinuxContainer; writable rootfs retained; mutable source at `/workspace/source`; read-only payload at `/opt/cowork-fixture`; read-only/writable guidance and memory fixtures at `/workspace/host-ro` and `/workspace/host-rw`; two vCPUs, default 1 GiB VM ceiling, optional 512 MiB–2 GiB MiB-aligned test ceiling |
| `exec` | `id`, `args`, optional `cwd`, `timeoutSeconds` | Start an additional process through vminitd; stdout/stderr/exitCode; timeout defaults 30 s, range 1–300 s |
| `stats` | `id` | VZ state, configured memory ceiling, balloon requested target, attached NIC count, active exec count, controller PID; `reclaimVerified:false` |
| `balloon` | `id`, `targetBytes` | Request a MiB-aligned traditional balloon target from 256 MiB to configured ceiling; target is not evidence of guest compliance/reclaim |
| `stop` | `id` | Invite init SIGTERM, wait up to 5 s, run Containerization kill/unmount/sync/stop; observe VZ stopped; release lease; keep image files; report cleanup error and flush status separately |

`create` requires `WINTER_COWORK_VM_TESTS=1` in the embedding process. The
fixtureRoot must be a canonical directory beneath the current user's temporary
directory, named `winter-cowork-vm-*`, containing the regular, nonsymlink marker
`.winter-cowork-vm-fixture` with exact contents
`winter-cowork-vm-disposable-v1\n`. Every input path must resolve to an existing
regular file or directory beneath that root; outputs must be unused paths
with admitted parents. Preparation does not require VM opt-in, but
`prepareRootfs` performs public HTTPS registry fetches on the host. No credential
resolver is installed. Kernel/init compatibility and artifact hashes must be
recorded by the fixture provisioner; this adapter cannot infer compatibility
from a downloaded image's name.

Kernel/initfs/rootfs must have distinct device/inode identities and link count
one. This rejects an image alias inside the mutable source even when canonical
path strings differ. All four share directories must have distinct device/inode
identities and must not overlap or contain backing files. Read-only payload and
shared fixtures permit ordinary files/directories only, with no symlinks or
hardlinked files; stage independent host copies before create. The read-only
share cannot protect a payload aliased into a writable source.

The pinned Containerization backend combines directory shares into one
`VZMultipleDirectoryShare` keyed by source-path hash, derives each directory's
`isReadOnly` from `Mount.options`, then invokes VZ extension hooks. The adapter
checks the actual built VZ graph (canonical source URL and per-source read-only
flag), exact source count, and source-to-guest mount destinations against the
host declaration before VZ validation/start. Conflicting source aliases or
silently collapsed dictionary entries refuse. `builtSharePolicyVerified:true`
and the declared share list in create record this preboot check; it does not
prove tool-view isolation or remount denial without guest checks. The raw
`/run/virtiofs` view belongs only to the trusted fixture supervisor and must
never enter a confined tool view; the native adapter does not build tool
namespaces.

The supervisor `exec` door is intentionally privileged to allow the disposable
fixture launcher to construct mount/PID namespaces and drop capabilities/UIDs
on its tool side. **Never expose this ABI to model tools or a guest.** The
native adapter alone does not implement protected runtime/config/store
confinement, task policy, a trusted guest authority channel or Cowork grants.
No host networking interface is attached, rather than silently selecting NAT;
this establishes only a networkless fixture, not the spec's outbound host
endpoint or destination enforcement. No production source/TCC/bookmark path
is exercised.

An owner-only fixture-local `.disk-leases/<device>-<inode>.lock` sidecar holds
a nonblocking exclusive `flock`, so a second participating controller sharing
the fixture cannot claim the same writable inode even through a hardlink.
The image descriptor itself is closed before VZ attachment and never flocked
by the probe: VZ owns image storage locking. Create rejects multi-link backing
files, preventing aliases into a different fixture. Sidecars are left in place
until explicit fixture cleanup so their lock inode cannot be replaced between
owners. This is a disposable probe lease, not production disk ownership.
The record/lease is retained when create fails or termination is uncertain.
The isolated controller caps retained guest records at two; this test-only cap
does not implement automatic production resource admission.
`stop` refuses while execs are active. Concurrent execs are allowed. VZ's
reported stopped state is recorded; it is not a proof of crash recovery or all
Apple backing-service termination. A dead host PID does not authorize
reattachment. Native create/stop/library provisioning do not yet have bounded
timeout/cancellation; harness timeouts must leave evidence/fixtures intact and
report uncertain termination. No live dylib unloading, forced process stop,
automatic fixture cleanup, sleep/wake reconciliation or multi-daemon resource
admission exists here.

Start, wait and delete failures all trigger kill/wait/delete cleanup. If wait
or delete cannot establish cleanup, the guest records `uncertainExecs` in stats
and refuses subsequent exec with `exec_cleanup_uncertain`. Stop remains
available, and confirmed VM stop clears that record. A failed exec is never
reported as successful merely because cleanup succeeds.

Stop closes device-operation admission and drains already queued stats/balloon
work before shutdown. New stats/balloon calls during stop refuse. Only that
narrow device queue is drained: a long exec never holds a global perform lock,
so other exec/stat/balloon requests retain concurrency.
After `termination_uncertain`, the retained guest keeps that device-operation
gate closed: stats and balloon calls refuse rather than reopening admission.
Its disk lease remains retained pending established termination/recovery.

Production integration still needs a Node-API-versus-FFI decision, a wakeup/event
channel, bounded create/stop/cancel semantics, task-scoped process cancellation
and durable uncertain-effect/ownership recovery. Operation IDs and host Promise
timeouts do not themselves cancel native work.

The no-VM native tests cover malformed ABI input, unknown methods, event
backpressure/concurrent reservation uniqueness, output bounds, marker/path
validation (including escaping/dangling symlinks and /private/var output aliases), image/payload aliases,
hardlink sidecar ownership without locking the image, safe native diagnostics,
partial-start cleanup, unreaped-process refusal, allocation-failure completion
retention, built VZ read-only/alias policy, and pending-device-operation drain.
Real VM boot, durable data, simultaneous exec, fixture confinement, balloon
compliance/host footprint, controller death and graceful cleanup remain
integrated opt-in measurements; none is implied by these tests.

Primary API references:

- [Pinned package requirements](https://github.com/apple/containerization/blob/bc994b88df46207fad7775b0eabc51947e315881/Package.swift)
- [Pinned VZ queue/extension hooks](https://github.com/apple/containerization/blob/bc994b88df46207fad7775b0eabc51947e315881/Sources/Containerization/VZVirtualMachineInstance.swift)
- [Pinned LinuxContainer lifecycle/exec](https://github.com/apple/containerization/blob/bc994b88df46207fad7775b0eabc51947e315881/Sources/Containerization/LinuxContainer.swift)
- [Balloon request semantics](https://developer.apple.com/documentation/virtualization/vzvirtiotraditionalmemoryballoondevice/targetvirtualmachinememorysize)
