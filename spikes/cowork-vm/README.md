# Cowork offline native probe

This is the first **feasibility slice**, not Cowork mode and not a passed gate 1.
It loads a pinned Containerization/VZ Swift library into a compiled Bun process,
prepares public digest-pinned images, and tests a disposable Linux guest. No
Winter app/daemon, real Winter home, Keychain, production admission ledger or
user-selected folder is used.

```sh
# No VM: compile/sign the local probe and cross-compile its guest helpers.
bun run spikes/cowork-vm/build.ts

# No VM: evidence validation and native boundary/lifecycle unit tests.
bun test spikes/cowork-vm/evidence.test.ts spikes/cowork-vm/claims.test.ts
swift test --package-path spikes/cowork-vm/native --jobs 4

# Explicit real-VM opt-in, using only freshly created temporary fixture files.
bun run spikes/cowork-vm/run.ts --run-vm

# Same fresh-fixture safety; confinement/share, cold persistence and direct checks only.
bun run spikes/cowork-vm/run.ts --run-vm --confinement-only
```

Requires Apple Silicon, macOS 26, Xcode/Swift 6.2+ and Bun. The first build fetches
the pinned Swift dependencies, a roughly 277 MiB upstream Kata archive and a
roughly 44 MiB official Zig archive into ignored build directories. Asset hashes
and provenance are in [pins.json](pins.json); OCI manifests/layers are addressed
by digest. The Kata kernel is an upstream-supported test input, not a measured
optimized Winter kernel. The runner checks free disk space before provisioning.

All native executables/libraries are ad-hoc signed for this isolated experiment.
The probe's entitlement file explicitly permits local FFI library loading; it
is not the production app's signing configuration. No global container CLI,
Docker service or globally installed compiler is required. The guest has **no
network interface**; public image provisioning happens on the host before boot.

The default runner uses one bounded 1 GiB guest at a time, with two virtual CPUs.
These are fixture limits, not the planned product's automatic allocation policy.
It runs separate compiled host processes for preparation, confinement/share
checks, cold persistence and memory observations. The private read-only payload
share contains the trusted fixture supervisor and helpers; the writable source
share contains only disposable test data. The native exec ABI is a privileged
test supervisor door and must never be exposed to a model.

The guest suite tests separate tool identities/namespaces, inaccessible control
state, read-only plan views, capability/descriptor/vsock restrictions, and direct
host-share writes. The host requires complete successful structured evidence and
exact file contents, not just exit zero. A later process boots the same retained
disk and verifies both a changed kernel boot identity and preserved content.

Denied writes record a recognized failure class and a successful positive control
using the same command shape against writable scratch. Missing commands, syntax
errors and missing target files do not establish a read-only boundary. Both the
general and direct-share suites validate named checks and summary counts. Separate
host-backed guidance/memory fixtures exercise guest RO binds over configured
host-read-only and writable exports; the built VZ share configuration is checked
before startup. A separate trusted-supervisor check must remove guest bind RO
and prove both mountinfo option sets writable before attributing a denial to
VZ host-side enforcement. Guest UID/GID permissions do not provide
per-conversation access isolation on these host shares.

A separate owner-only source fixture keeps normal host modes (directory 0755,
files 0644). Two distinct guest tool UIDs edit/create/reopen those files; the Mac
independently verifies unchanged ownership/modes, and the plan view cannot write.
Guest-reported ownership varied across observed contexts and is recorded
as an observation, not mistaken for authoritative Mac ownership. Landlock is
optional and unavailable in the tested kernel; the exercised boundary uses
namespaces, restricted mounts, capability removal and seccomp.

The memory phase touches a bounded anonymous allocation, confirms free while
the process remains alive, requests balloon inflation/deflation and reallocates.
Reports include guest meminfo, host compressor/swap counters, controller/Apple
service process observations and available footprint summaries. A target setter
or RSS change alone does not prove useful reclaim. Other running VMs and host
pressure may confound measurements; inspect the baseline and report that limit.
The second memory condition compacts the disposable guest through a trusted
supervisor proc mount before ballooning. That privileged action is not exposed
to the confined tools. Reports keep `reclaimVerified: false`; a sustained backing
footprint decrease is reported as a separate observation. The initial measured
run did **not** demonstrate host memory return, even after guest compaction.
Passive full footprint categories and `vmmap -summary` are retained for the
single candidate backing service when ownership is unambiguous. This does not
generate host memory pressure; pressure experiments require separate approval.

The runner prints its temp fixture path and writes `out/latest-fixture.txt`.
Per-phase JSON reports, image disks, boot logs and `owner.json` remain in that
fixture for inspection. A fixture-local exclusive claim prevents simultaneous
phase reuse. Uncertain termination leaves the claim and refuses automatic reuse;
**a dead controller PID is not permission to remove the claim or reattach disks**.
Nothing automatically deletes retained fixture data. Remove it only after
termination is established and the evidence is no longer needed.

The public runner always creates a fresh fixture; there is no old-fixture
restaging option. Every compiled phase requires its parent orchestrator's claim
and token. Host executables, libraries and guest helper builds get unique output
directories so another build cannot overwrite a running artifact. Cold restart
still reuses the fixture disk across phases under that same orchestrator.

Use `bun run spikes/cowork-vm/summarize.ts <fixture> <summary.json>` to produce a
shareable summary without host paths, unrelated process details or process IDs.
The checked-in [full-run summary](results/2026-10-11-reviewed-offline-probe.json),
[targeted host-enforcement summary](results/2026-10-11-host-enforcement-probe.json) and
[measurement record](../../docs/research/2026-10-11-cowork-gate1-results.md) separate
observed success from the unresolved gate requirements.

Still unproven here: production Node-API/daemon integration and signing,
authenticated authority channels, actual host-network enforcement, real folder
picker/TCC/revocation, multiple-daemon admission, hard-crash recovery,
multi-guest resource policy and complete SDK/Cowork execution. See the accepted
[specification](../../docs/cowork-spec.md) and [native ABI notes](native/README.md).
