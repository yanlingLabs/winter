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
- The native library and Containerization dependency used Swift's debug build.
  Boots were sequential on a warm host cache; these are probe measurements,
  not release-build performance targets.
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

The [full reviewed-run JSON evidence](../../spikes/cowork-vm/results/2026-10-11-reviewed-offline-probe.json)
and later [targeted host-enforcement evidence](../../spikes/cowork-vm/results/2026-10-11-host-enforcement-probe.json)
are derived from the actual per-phase reports, which remain in the local fixture
named by the runner. No large VM images or build outputs are checked in.

## Full reviewed-run observations

| Check | Observation | Limit |
| --- | --- | --- |
| In-process control | Native VZ controller and Bun share the probe process; a new Apple VM backing service was observed per boot | Not the signed production daemon; no claim that Apple's backing service disappears from the process topology |
| Prepared guest readiness | Five final-run boots took approximately 305–320 ms from create submission through guest init/shell start | Excludes image download/unpack, library loading, a real Winter runtime and model readiness; not a statistical performance benchmark |
| Tool confinement | 78 assertions for each of two distinct auto tool UIDs and 86 for the plan UID passed, plus 64 direct-view assertions and host/driver checks | Identities ran sequentially; not proof of concurrent Project sessions, every future tool integration or a complete security audit |
| Protected control state | Tool views could not access/change the fixture's supervisor/config/SDK state, replace shared guidance or create vsock sockets; capability sets were zero with no_new_privs enabled | Includes guest-local control files and host-backed guidance/memory in both host-RO and RW-to-tool-RO shapes; not production authenticated channels |
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

In the full reviewed-run plain condition, the candidate owning Apple service's physical
footprint was about 121 MB initially, 493 MB after allocation and 493 MB after
free; it stayed at about 494 MB throughout four balloon samples. In the compact
condition, footprint was 508 MB after free and about 508–509 MB while inflated
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

Passive `footprint -f bytes --swapped --wired` and `vmmap -summary` captures
succeeded at each sample. The dominant app-specific tag 1 / Memory Tag 240
category covers eight regions and 1 GiB virtual space. Its allocation response
suggests guest RAM, but that interpretation is an inference rather than an API
guarantee. It remained at zero reclaimable, volatile and empty bytes throughout
ballooning. In the plain condition, approximately 416 MiB became
swapped/compressed while staying charged to the footprint; that is not evidence
of balloon return. The summary includes the corresponding category rows. The
dedicated reusable-page counter was not captured, so these categories do not
prove that every possible lazy-release mechanism is absent.

Next compare a matched kernel at or above the package's tested baseline,
changing one variable at a time. No deliberate host-allocation/pressure test
was run; such an experiment needs separate user approval on this shared Mac.
This result is not a claim that every Apple VM backend fails reclaim.

## Review follow-up

The [original run](../../spikes/cowork-vm/results/2026-10-11-offline-probe.json)
retains the initial 314–339 ms measurements and simpler guest-local checks.
Independent review identified that arbitrary command failure was insufficient
denial evidence and that virtiofs protection needed its own tests. The reviewed
run supersedes those checks:

- Each denied shell operation records a recognized failure class and a successful
  same-shape positive control in writable scratch. Missing files count only for
  named hidden-control checks; EXDEV/EBUSY are limited to the relevant hardlink
  or mountpoint-rename checks. Syscall observations record actual errno per view.
- Both suites require named checks, complete counts and trusted post-checks.
  The new checks demonstrated 130 classified shell denials with successful
  positive controls, including supervisor checks, plus 12 measured syscall denials.
- Intentionally host-writable files were tested through guest RO binds over a
  configured VZ RO export and a configured writable export. This run did not
  remove Containerization's own guest RO bind, so it did not independently test
  VZ's host-side RO enforcement; the configured flag alone does not establish it.
  The same separate
  host-memory file is writable in auto and denied in plan. Host sentinel bytes
  and modes were independently checked after the guest views ran.
- The actual built VZ directory-sharing graph is verified against the four
  distinct source identities and per-source read-only policy. Conflicting aliases
  and overlapping exports refuse before start. Guest group permissions are not
  claimed as an access boundary on VZ shares.
- Both suites check all five capability sets and no_new_privs. Each view gets a
  fresh scratch epoch. The fixture still uses chroot and a syscall denylist;
  production root detachment and broader syscall-policy review remain outstanding.

Two failed development runs were retained: the first caught musl's alternate
EXDEV wording; the second caught a validator ID shared by a positive auto write
and a plan denial. Neither was counted as a pass. The final fresh pipeline
passed, every guest reported a flushed stop, its controller/backing candidates
were absent afterward, and no fixture ownership claim remained.

## Host-side read-only enforcement follow-up

A second review identified that Containerization supplies its own guest read-only
bind over a configured VZ RO export. The earlier supervisor denial therefore
established guest enforcement, not independent VZ enforcement. The targeted
fresh-fixture run above removes that ambiguity:

- The trusted supervisor successfully ran the same bind-remount-to-rw sequence
  on `/workspace/host-ro` and `/workspace/host-rw`. Each raw mountinfo record
  identifies virtiofs, per-mount `rw,relatime` and superblock `rw`. The host
  validator independently parses those records and refuses missing or RO layers.
- After that, append attempts to both guidance and memory files on the VZ RO
  export failed with EACCES. Matching writes on the VZ RW export succeeded and
  restored the exact original bytes. Independent Mac checks found unchanged
  protected sentinel bytes and modes. This demonstrates host-side enforcement
  for the tested append operations in this configuration, not every filesystem
  operation or a complete security audit.
- `/run/virtiofs` was absent even in the container supervisor's namespace. That
  is now a layout observation, not a tool-isolation assertion. Removing that
  assertion from each view leaves 77 + 77 + 85 = 239 confinement checks; all
  passed, together with 64 direct-view checks and supervisor/host checks.
- The scoped run also verified cold-file persistence and graceful flush/stop.
  Its three prepared boots took approximately 299–333 ms, with the same debug,
  warm-cache and sequential limitations. Recorded processes were absent and
  fixture claims released afterward. Memory phases were not repeated.

The native lifecycle documentation also records that `termination_uncertain`
retains the closed device-operation gate: stats/balloon stay refused. This is
not a claim that the adapter implements a complete recovery gate for all execs.

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
