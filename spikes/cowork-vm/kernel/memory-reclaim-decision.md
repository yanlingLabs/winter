# Memory-return decision after acknowledged page-group evidence

Research date: 2026-10-11. Active-work return is required by the user's subsequent
explicit decision. A replacement backend/topology has not been accepted.
This note adds no implementation, VM run, host-pressure test or backend adoption.

## What the latest experiment establishes

The [sanitized record](../results/2026-10-11-page-groups-memory.json) uses
Containerization `bc994b88df46207fad7775b0eabc51947e315881`, the pinned Apple-recommended
Kata 6.18.35 kernel, 1 GiB guest RAM, a 384 MiB touched allocation, and disposable
fixtures. The raw reports were independently read from fixture
`winter-cowork-vm-ooqfgQ` under the current user's temporary directory.

| Condition | Newly full, aligned 16 KiB groups before witness | Bytes in those groups | Minimum overlap with touched memory | Backing footprint, freed then balloon samples |
| --- | ---: | ---: | ---: | --- |
| Plain | 49,038 | 803,438,592 | 132,349,952 bytes / 126.21875 MiB | 590 then 591, 591, 591, 591 MB |
| Compacted | 49,022 | 803,176,448 | 132,087,808 bytes / 125.96875 MiB | 617 then 618, 618, 618, 618 MB |

Both scans covered all 262,144 guest PFNs, with no baseline OFFLINE pages,
NOPAGE holes or partial edge groups. Three samples at the 257 MiB target had
identical bitmap digests and inflation counters. Moving to 256 MiB advanced
inflation from 196,352 to 196,608 pages without deflation. Both runs subsequently
flushed and observed VZ stopped; their identified backing PIDs were absent from
their own post-stop process snapshots. This is selected normal-stop evidence,
not a completed production idle/recovery/admission implementation.

The read bound is 2 MiB per snapshot, in 64 KiB chunks, at `8 * PFN` offsets
discovered from merged `/proc/iomem` System RAM ranges, not a scan from PFN zero.
The diagnostic checks 4 KiB guest pages, complete coverage, fixed range identity,
read failures and overflow. A full group contains four newly OFFLINE PFNs at an
absolute four-PFN boundary. Linux exposes OFFLINE as bit 23 and NOPAGE as bit 20.
[Page-flag definitions](https://github.com/torvalds/linux/blob/v6.18/include/uapi/linux/kernel-page-flags.h),
[proc reader](https://github.com/torvalds/linux/blob/v6.18/fs/proc/page.c).

Linux marks pages OFFLINE and increments inflation before submitting a batch.
`tell_host()` then waits for a used-buffer acknowledgment. Consequently, the
subsequent inflation step witnesses acknowledgment of the previously observed
set; a stable counter alone would leave the final batch uncertain. Acknowledgment
means the device consumed the donation, not that macOS discarded its backing.
For group bytes `F`, the conservative touched overlap is
`max(0, F + 384 MiB - 1 GiB)`. The scans are observations, not atomic snapshots.
[Driver: fill_balloon, tell_host, update_balloon_size_func](https://github.com/torvalds/linux/blob/v6.18/drivers/virtio/virtio_balloon.c),
[OFFLINE marking](https://github.com/torvalds/linux/blob/v6.18/include/linux/balloon_compaction.h).

**Stop blind 16 KiB kernel builds.** Incomplete 16 KiB groups cannot reasonably
explain the entire missing return in these runs. A different kernel could still
change undocumented backend behavior, but there is no concrete evidence that
page size is the fix. `BALLOON_COMPACTION` controls balloon-page movability; enabling
it or `PAGE_REPORTING` cannot force a device feature that VZ did not negotiate.
This conclusion concerns the tested configuration, not every VZ version.

## Product decision and remaining backend gate

Continue independent host/SDK work. The user explicitly selected **Require RAM
return during active work**. Idle-only return is insufficient and cannot close
gate 1. The tested VZ backend does not currently meet this requirement. Implement
automatic boot-ceiling selection, pressure-aware admission, safe ceiling changes
at restart boundaries, complete occupancy tracking, durable cold continuation,
and automatic stop only after verified workspace quiescence. Advertise live RAM
return as unavailable for the tested backend. Do not keep inflating a live guest
to reduce its usable RAM when no host-return benefit is established. Occupied
workspaces can retain their touched-memory cost until idle; do not secretly stop
them to admit another workspace.

Those mechanisms are still necessary automatic resource management without manual
allocations, but do **not** close the accepted resource gate: the
[specification](../../../docs/cowork-spec.md#resource-policy-and-product-surfaces)
calls automatic return a blocking feasibility question and gate 1 explicitly
requires genuine reclaim. The user's decision excludes idle-only substitution.
Evaluate a bounded live-reclaim backend experiment, then present any conflict
with the accepted in-daemon topology as a concrete separate decision. Approval
of active return alone does not authorize silently changing that topology.

## Alternatives for the mandatory live-return requirement

* **Direct VZ:** changing the wrapper does not change Apple's memory-owning
  backing service or expose a public page-discard operation. It is not an
  evidence-backed escape from the observed behavior. Apple's maintainer describes
  partial balloon support as a macOS limitation.
  [Apple issue](https://github.com/apple/containerization/issues/65#issuecomment-3293475472).
* **libkrun/HVF:** a concrete candidate, not a verified drop-in. At inspected
  revision `713866b80514097967b1f4a7d6908a11b2c0a104`, its free-page reporting handler
  calls `madvise(MADV_FREE)` on macOS. It does not show immediate reusable-ledger
  release or an HVF unmap/remap cycle in that handler. Its README warns that
  default virtio-fs does not confine host path access and that TSI automatically
  supplies networking when no NIC is added. Neither behavior fits Cowork without
  explicit replacement/confinement.
  [Mac reporting handler](https://github.com/containers/libkrun/blob/713866b80514097967b1f4a7d6908a11b2c0a104/src/devices/src/virtio/balloon/device.rs),
  [security/network contract](https://github.com/containers/libkrun/blob/713866b80514097967b1f4a7d6908a11b2c0a104/README.md).
* **A controlled HVF backend:** host-owned guest mappings make a real discard
  path possible. ArcBox's published primary reproduction reports footprint
  reduction using `hv_vm_unmap -> MADV_FREE_REUSABLE -> hv_vm_map`; this is external
  experimental evidence, not Winter validation or a production memory protocol.
  A candidate must prove safe guest reuse, vCPU/device coordination, remapping,
  live data integrity and repeated return before adoption. No pressure-generating
  reproduction command was run for this review.
  [Reproduction source and results](https://github.com/arcboxlabs/macos-vm-memory-ratchet).

Apple explicitly permits only **one HVF VM per host process**. Preserving one
independent VM per workspace therefore needs a VMM worker per workspace, while
the daemon may still own orchestration. Embedding several HVF VMs directly in the
existing daemon is not a supported alternative; sharing one guest kernel would
instead change the accepted isolation model. This process/security tradeoff is
why a backend change needs a focused user decision, not an unnoticed library swap.
[Apple Hypervisor virtual-resource mapping](https://developer.apple.com/documentation/hypervisor).

## Local bounded HVF primitive, after the active-return decision

The independent [C fixture](hvf-reclaim.c) and [bare-metal guest](hvf-reclaim-guest.S)
ran on this Apple Silicon Mac on 2026-10-11. It uses no Linux kernel, filesystem,
network device, credentials, pressure generator or private reusable-accounting
advice. Maximum touched RAM is 384 MiB. Five cycles write and check every 64-bit
word through a real vCPU, hand off the middle 256 MiB at an MMIO exit, and reclaim
it in 2 MiB extents using `hv_vm_unmap`, `munmap`, fresh anonymous `mmap`, and
`hv_vm_map`. The vCPU is at its explicit ownership handoff during replacement.
The VM remains instantiated; it then checks the other 128 MiB, checks the
discarded range is zero, refills it and verifies all words again.

The [raw bounded results](../results/2026-10-11-hvf-reclaim-primitive.jsonl) show
268,566,720 bytes of footprint reduction in every cycle, with reclaim lasting
4.06–6.02 ms. Refilling returns footprint to its earlier value each time. Final
vCPU and VM destruction succeeded; final footprint was about 1.6 MiB.

This proves only the host reclaim primitive and explicit guest handoff on this
machine. It does **not** prove Linux reporting/balloon ownership, device-DMA
synchronization, concurrent vCPU integrity, a production VMM sandbox, startup
latency, or the complete active-work resource gate. Those need the real Linux
backend and live-workload checks before adoption. A separate user decision about
the required per-workspace worker process is pending; active-return approval
alone does not change the earlier in-daemon preference.

Build and run only the opt-in bounded fixture:

```sh
clang -O2 -Wall -Wextra -Werror -framework Hypervisor \
  spikes/cowork-vm/kernel/hvf-reclaim.c \
  spikes/cowork-vm/kernel/hvf-reclaim-guest.S \
  -o spikes/cowork-vm/out/hvf-reclaim
codesign --force -s - --identifier com.winter.cowork.reclaim-fixture \
  --entitlements spikes/cowork-vm/kernel/hvf-reclaim.entitlements \
  spikes/cowork-vm/out/hvf-reclaim
spikes/cowork-vm/out/hvf-reclaim --run-fixture
```
