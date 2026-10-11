# Balloon and matched-kernel comparison

Research/provisioning state: 2026-10-11. No VM is started by kernel preparation
or the no-VM tests. Host memory-return remains an open gate until the integrated
comparison supplies measurements. The first probe's findings remain attached
to its original 6.12.28 input; a newer recommendation does not rewrite them.

## Correct request semantics and the platform limitation

`VZVirtioTraditionalMemoryBalloonDevice.targetVirtualMachineMemorySize` is the
desired physical allowance remaining for the guest, not the balloon's size.
Lowering a 1 GiB ceiling to 256 MiB requests 768 MiB of inflation; Linux's
196608 inflated 4 KiB PFNs in the first probe agree with that direction. The
public property is a request/readback, not an actual-return counter. Apple
requires MiB alignment and clamps between VZ's minimum and configured memory.
The installed macOS 26.4.1 SDK also recommends guest compaction before requesting
balloon changes. [Apple API](https://developer.apple.com/documentation/virtualization/vzvirtiotraditionalmemoryballoondevice/targetvirtualmachinememorysize)

Apple's released/current `container` documentation still describes partial VZ
balloon support and says process-freed Linux pages remain host-backed. The
Containerization maintainer closed the balloon issue as a macOS limitation,
rather than a package-level fix. These are documented limitations, not proof
that every newer OS/kernel combination fails the bounded manual-balloon test.
[Current Apple documentation](https://github.com/apple/container/blob/f70ecbb926d925818a34917529e304b1177ce98c/docs/technical-overview.md#releasing-container-memory-to-macos),
[maintainer explanation](https://github.com/apple/containerization/issues/65#issuecomment-3293475472)

Traditional inflation, free-page hinting and free-page reporting are distinct
virtio mechanisms. Hinting is specified for migration. Reporting permits reuse
after acknowledgment and requires its feature to be negotiated. A compiled
`CONFIG_PAGE_REPORTING=y` is insufficient when the host device does not offer
and negotiate bit 5. The Linux driver conditionally registers its reporting
queue; poisoning/init-on-free can further affect negotiation. No supported
public VZ control to force reporting/discard negotiation or discard arbitrary
guest PFNs was found in the installed public API and inspected backend. Do not
substitute private Apple APIs or host swapping/compression for return evidence.
[Virtio specification](https://docs.oasis-open.org/virtio/virtio/v1.3/virtio-v1.3.html),
[Linux driver](https://github.com/torvalds/linux/blob/v6.18/drivers/virtio/virtio_balloon.c),
[Linux feature definitions](https://github.com/torvalds/linux/blob/v6.18/include/uapi/linux/virtio_balloon.h)

## Matched recommendation and reproducible inputs

Released Apple `container` **1.5.0**, commit
`d265d669ecae041bf338cb3b39c4118316d138f0`, pins **Containerization 0.47.0**,
which is exactly this probe's `bc994b88df46207fad7775b0eabc51947e315881`.
Its kernel configuration recommends **Kata 3.32.0 ARM64
`vmlinux-6.18.35-197-debug`** and records the archive digest. This provides a
matched newer input without changing the library or vminit image.
[Released dependency pin](https://github.com/apple/container/blob/d265d669ecae041bf338cb3b39c4118316d138f0/Package.swift#L26),
[released kernel recommendation](https://github.com/apple/container/blob/d265d669ecae041bf338cb3b39c4118316d138f0/Sources/ContainerPersistence/ContainerSystemConfig.swift#L168),
[Kata release](https://github.com/kata-containers/kata-containers/releases/tag/3.32.0)

The package README says functionality is tested starting at 6.14.9, but its
pinned kernel Makefile now builds 6.18.5. Its separate downloadable fallback is
still Kata 3.17.0 / 6.12.28. These are different inputs, not one guarantee.
[Pinned README](https://github.com/apple/containerization/blob/bc994b88df46207fad7775b0eabc51947e315881/README.md#linux-kernel),
[pinned build source](https://github.com/apple/containerization/blob/bc994b88df46207fad7775b0eabc51947e315881/kernel/Makefile#L15)

`../pins.json` preserves the historical input and adds two allowlisted profiles:

| Profile | Kernel SHA256 | Extracted config SHA256 |
| --- | --- | --- |
| `kata-6.12.28` | `67bac9f416af4cdc9b151e4ba4962d6515e0ad7acc53816761cf964aa6af6ea0` | `1b27ba1ecabb23ae1330dad745acf2660166a82435497f9a0e76140ff9890ab5` |
| `apple-6.18.35` | `fb2cfb79eb1ae19447a85d75682d7fa5cfec97e24beb2609a492b806e8072c8d` | `a5dfc1ee37dcd4bc6d727e4de617bc45a40cf32e7ebc52fb6f0472c8fbf60c21` |

The newer 696573576-byte archive SHA256 is
`8736c054d9223974735394f822000823baef509e1c33405ec798240fa9b6e4b5`.
It matches both Apple's released record and GitHub's release-asset API digest.
Kernel/config hashes were independently measured after extracting only the
named members with `/usr/bin/tar -xOf`; no global package, container CLI, Docker,
installer or existing VM was used. Files live in ignored `out/assets`.

Both extracted Kata configs have `CONFIG_VIRTIO_BALLOON`, `CONFIG_PAGE_REPORTING`,
`CONFIG_MEMORY_BALLOON`, `CONFIG_COMPACTION`, `CONFIG_IKCONFIG_PROC` and ARM64
4 KiB pages enabled. Both disable `CONFIG_BALLOON_COMPACTION`; the pinned
Containerization build config enables it. The newer Kata config enables
Landlock, while the historical one does not. The historical and new kernels
therefore differ in version/build configuration; this is a supported-input
comparison, not a claim that only one individual kernel option changed.

Build/provisioning only, no VM:

```sh
bun run spikes/cowork-vm/build.ts --kernel-profile apple-6.18.35
bun test spikes/cowork-vm/kernel/profiles.test.ts
/bin/sh -n spikes/cowork-vm/kernel/guest-memory-diagnostics.sh
```

`build({kernelProfile})` returns `kernelPath`, `kernelConfigPath`,
`kernelProfileID` and the full hash/provenance record alongside unique signed
host artifacts. Downloads/extractions use unique temporary files, verify
digests before publication and never install into global locations. The default
historical profile still resolves to the old `out/assets/vmlinux` path.

The parent runner owns real-VM opt-in and one-at-a-time coordination. Each
kernel/condition gets a fresh private fixture. Hold library/init/root-image,
1 GiB ceiling, two vCPUs, 384 MiB touched anonymous allocation, sampling windows
and balloon targets constant. Compare plain and compact-before-balloon
conditions. Do not allocate host memory, create deliberate pressure, disturb
another VM or retry by breaking retained ownership claims.

Stage `guest-memory-diagnostics.sh` in the read-only trusted payload and run it
before memory workloads. It reads live kernel/config and balloon negotiation
from sysfs without changing settings. `profiles.ts` decodes the sysfs string
with **bit 0 first**, as Linux actually emits it; reading it as an ordinary
binary integer would reverse feature meanings. Preserve raw output when a
device/config is absent. [Linux sysfs implementation](https://github.com/torvalds/linux/blob/v6.18/drivers/virtio/virtio.c#L43)

Measure attributable backing-service physical footprint, reusable pages,
compression/swap, guest balloon compliance and successful deflation/reallocation
separately. A requested target, feature bit or smaller guest RSS does not pass
reclaim. No candidate/ambiguous ownership means UNKNOWN. `footprint` supports
JSON output and `vmmap`/raw category captures can supplement it; retain both
raw reports and parsed values. Passive background pressure is a confounder to
record, not an input to intentionally manufacture.

## Minimal production controller work still needed

1. Decide Node-API versus supported C ABI/FFI in the actual signed compiled
   daemon, including library validation/runtime loading. The existing polling
   probe is evidence of local embedding only; add a bounded FD/event wakeup
   channel, shutdown draining and safe lifetime management before production.
2. Introduce task-owned asynchronous start/exec/cancel/stop operations with
   explicit uncertain completion, guest incarnation/epoch and typed refusals.
   Promise timeouts do not cancel Swift/VZ work. Stop must close all runtime
   admission, not only the existing stats/balloon gate, and retain disk ownership
   until backing termination is established. Test start/stop/cancel races and
   leaked guest I/O/process cleanup with a fake backend first.
3. Separate the privileged fixture-supervisor ABI from production trusted
   supervisor and confined tool execution. The probe's `.allCapabilities` door
   must never become a model tool. Keep guest authority channels/versioned
   runtime artifacts distinct from editable guidance and host grants.
4. Replace fixture sidecar ownership with the reviewed canonical workspace /
   daemon identity and isolated shared admission contracts. The sidecar is not
   crash-recovery proof. Integrate signed folder access/revocation and the
   host-owned network endpoint independently of the memory comparison.
5. Bound resource requests against real VZ minimum/ceiling, guest demand and
   host pressure; preserve the distinction between allowance, inflated PFNs,
   host reuse/discard and successful future guest allocation. If public VZ
   cannot demonstrate return, keep the gate open and revisit the concrete
   backend/resource tradeoff explicitly rather than advertising elastic RAM.
