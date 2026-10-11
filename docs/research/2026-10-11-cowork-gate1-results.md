# Cowork gate 1: initial offline measurements

The user authorized implementation after the specification review. This first
slice implements an opt-in native/guest feasibility probe under
[`spikes/cowork-vm`](../../spikes/cowork-vm/README.md). **Gate 1 is not complete and
Cowork is not enabled.** It does not contain a running Winter agent inside the
guest or demonstrate SDK conversation/subagent restoration.

## Tested configuration

- Apple Silicon Mac, 24 GiB RAM, macOS 26.6.1, Xcode 26.4.1 / Swift 6.3.1,
  Bun 1.3.14. The host had other active workloads and existing compression/swap.
- Containerization revision `bc994b88df46207fad7775b0eabc51947e315881`, a native
  Swift dynamic library loaded in-process by a compiled Bun executable through
  an asynchronous C ABI and bounded polling. This proves local embedding, not
  the final Node-API binding or actual winter-core integration.
- Ad-hoc signed fixture executable, explicit virtualization/JIT/FFI entitlements.
  Production Developer ID, library validation and TCC packaging remain untested.
- Kata 3.17.0 ARM64 kernel `6.12.28`, digest-pinned upstream vminit and Alpine
  images. The [asset record](../../spikes/cowork-vm/pins.json) records provenance.
  This kernel follows the pinned Makefile's downloadable input but is below the
  README's stated tested kernel baseline of 6.14.9; do not generalize its results
  to every Containerization/kernel configuration.
- One guest at a time, two virtual CPUs, 1 GiB configured ceiling; no guest NIC.
  Only newly created temporary fixture folders/disks were attached. No live
  Winter home, app/daemon, Keychain or real user source folder was used.

The [sanitized JSON evidence](../../spikes/cowork-vm/results/2026-10-11-offline-probe.json)
is derived from the actual per-phase reports, which remain in the local fixture
named by the runner. No large VM images or build outputs are checked in.

## Observed behavior

| Check | Observation | Limit |
| --- | --- | --- |
| In-process control | Native VZ controller and Bun share the probe process; a new Apple VM backing service was observed per boot | Not the signed production daemon; no claim that Apple's backing service disappears from the process topology |
| Prepared guest readiness | Five final-run boots took approximately 314–339 ms from create submission through guest init/shell start | Excludes image download/unpack, library loading, a real Winter runtime and model readiness; not a statistical performance benchmark |
| Tool confinement | 44 assertions for each of two distinct auto tool UIDs and 52 for the plan UID passed, plus host/driver checks | Identities ran sequentially; not proof of concurrent Project sessions, every future tool integration or a complete security audit |
| Protected control state | Tool views could not access/change the fixture's supervisor/config/SDK state, replace shared guidance or create vsock sockets; capability sets were zero with no_new_privs enabled | Uses synthetic control files and a fixed test suite, not production authenticated channels |
| Direct folder edits | Guest writes appeared directly in host fixture files; a separate 0755/0644 owner-only fixture allowed both tool UIDs to edit/create/reopen | Mac ownership/modes remained unchanged; mixed owners, ACLs, TCC, revocation, watchers and broad filesystem compatibility remain untested |
| Plan view | Read-only source/memory views rejected the tested direct/indirect/alias/rename/create/chmod writes | Not yet wired to Winter approval-policy transitions or real file tools |
| Cold persistence | A new compiled host process and different guest boot ID read the exact marker written by the previous guest | Ordinary durable-file proof only; not a VM RAM snapshot or SDK parent/child continuation |
| Graceful stop | All final-run phases reported guest flush success and observed VZ stopped state | Not a hard-crash/backing-service termination/recovery proof |
| Event-loop sampling | Small millisecond-scale heartbeat delays were observed while native operations and asynchronous metrics ran | Offline single-guest workload; no network/provider/UI concurrent-load proof |

Guest UID/GID presentation is not treated as host ownership evidence. Apple
documents effective-host-user file access and ignored guest ownership changes;
the observed guest stat projections were not stable across tool contexts, while
independent Mac metadata checks remained unchanged. [Apple shared filesystem
device](https://developer.apple.com/documentation/virtualization/vzvirtiofilesystemdevice?language=objc)

## Memory return remains an open gate

The workload touched 384 MiB of anonymous guest pages, freed them while its process
stayed alive, requested a balloon target, then deflated and successfully allocated
again. Both plain and compact-before-balloon conditions ran successfully.

In the final plain condition, the candidate owning Apple service's physical
footprint was about 121 MB initially, 508 MB after allocation and 508 MB after
free; it stayed at about 509 MB throughout four balloon samples. In the compact
condition, footprint was 506 MB after free and about 507 MB while inflated
(units as reported by macOS `footprint`).
Guest balloon counters reached 196608 inflated pages for the 256 MiB target;
compaction scan counters changed in the compact condition. An earlier 512 MiB
target also showed guest compliance without a sustained host-footprint decrease.

**Guest allocation release, balloon inflation/deflation, compaction and later
allocation succeeded. A sustained decrease in the candidate owning Apple VM
service's physical footprint was not observed. Host memory-return feasibility
remains open for this configuration.** Target readback and lower guest available
memory are not proof that macOS got memory back. Other host activity makes global
free-memory or swap changes unsuitable as a substitute.

The next isolated diagnostic should retain full `footprint -f bytes --swapped
--wired -p <owned-pid>` and `vmmap -summary <owned-pid>` category output, without
permission escalation or generating host memory pressure. Total footprint can
hide offsetting allocation/accounting changes. If that remains flat, compare a
matched kernel at or above the package's tested baseline, changing one variable
at a time. This result is not a claim that every Apple VM backend fails reclaim.

## Validation and remaining scope

Native unit tests, TypeScript evidence/claim tests, strict TypeScript checking,
static ARM64 C builds with warnings as errors, shell syntax checks and the real
offline fixture pipeline were run. Evidence validation requires named control
properties and complete per-view summaries; unsupported mandatory checks cannot
be relabeled as passes. Optional Landlock absence is reported separately.

No full monorepo, release, staging or production-readiness result is claimed.
Next gate-1 work includes actual memory-return diagnosis, production native
binding/signing, host-owned network enforcement, real folder authorization and
revocation, crash ownership, multi-daemon admission and concurrent-load latency.
Gate 2's immutable Linux Winter runtime and durable SDK resumption remain later
work. The availability placeholders remain disabled.
