# Cowork VM architecture options

Research cutoff: 2026-10-10. Prepared from an Astra review of primary Apple and upstream documentation. This is a comparison for choosing the architecture, not an implementation decision or a benchmark. No VM was launched and no new virtualization package was installed.

The user wants standalone Cowork workspaces per conversation, reusable Project workspaces, direct access to selected host folders or GitHub repositories cloned into guest storage, guest Winter/subagents, and durable state across cold restarts. A key preference is to avoid starting another Winter host process for each Cowork conversation.

## Multiple VMs and Apple service processes

One application can own multiple `VZVirtualMachine` controllers. Apple's WWDC26 example constructs a second VM with the same network object; moving controllers into separate application processes is an optional arrangement. This is different from the lower-level Hypervisor API, which permits only one VM per calling process. The latter is not a one-VM-per-Virtualization-app limit. [Apple multiple-VM networking explanation](https://developer.apple.com/videos/play/wwdc2026/224/), [Hypervisor](https://developer.apple.com/documentation/Hypervisor)

The controller objects could live inside the existing Winter daemon through a native bridge. Apple-managed backing execution services are another layer; putting controller objects in the daemon does not guarantee that all VM execution occupies that daemon's PID. Exact service-process counts have not been measured. This architecture can avoid an additional Winter runtime or controller executable per conversation while still running several independent guests.

Three choices should be evaluated separately: the VM backend, the location of its controller, and which conversations share a guest kernel. A pool or Project workspace is an ownership/allocation policy, not a different hypervisor.

## Comparison

| Option | Host integration | Isolation and persistence | Assessment |
| --- | --- | --- | --- |
| Containerization library with dedicated Linux VMs | Native bridge loaded by `winter-core`; no Winter controller process per conversation | Separate guest kernel per VM; persistent workspace storage independent of running VM | First shortlist candidate: image, init, process and vsock support already exist. Native integration remains to prove. |
| Direct Virtualization.framework with dedicated Linux VMs | Native bridge loaded by `winter-core` | Same hardware VM boundary; explicit device/disk/mount configuration | Second shortlist candidate: more control, but more guest provisioning and execution machinery to build. |
| One shared native helper managing many VMs | One extra Winter process overall, rather than one per conversation | Same per-VM boundaries as the first two options | Integration fallback if loading native VM code into Bun is unsuitable. Separates native failures from the daemon. |
| Helper executable per VM | A manager starts a process per VM | Independent VM/controller lifetime | Straightforward with existing tools, but conflicts with the process preference. |
| Containerization LinuxPod | One VM, several guest containers | Separate container roots/processes; shared guest kernel/resources | Experimental resource-saving option. Current macOS hot-add limitation is material. |
| Custom shared Linux VM with containerd/runc-style orchestration | One VM supervisor, separate conversation environments inside the guest | Shared guest kernel; Winter owns container lifecycle and access boundaries | More mature architectural pattern, more guest orchestration work. A deliberate isolation tradeoff. |
| VM per Project | One active VM for a reusable Project workspace, optionally subdivided internally | Conversations in that Project share a failure/security boundary | Useful middle ground if shared trust and concurrent-write rules are accepted. |
| Bounded dedicated-VM pool | Limit active dedicated guests; allocate on demand | Hardware boundary per active assignment; workspace identity survives slot reassignment | Resource policy usable with either shortlisted backend. Reassignment must clear previous session authority/state. |
| QEMU/HVF or custom Hypervisor/libkrun VMM | Native VMM library or executable; HVF still has one VM per process | Hardware VM boundary plus VMM-specific device/confinement design | Consider only for requirements Apple VZ cannot meet; does not eliminate per-VM VMM processes for many independent VMs. |
| Existing external managers | Apple `container`, vfkit, Lima/Colima, Tart, Docker Desktop, OrbStack, Multipass | Depends on selected manager/backend | Useful prototypes, references or optional external backends. They add another product's lifecycle and policy assumptions. |

The first two can use controllers in the same daemon. The shared-helper arrangement changes packaging and failure containment, not the underlying VM isolation. [Containerization](https://github.com/apple/containerization), [pinned VZ backend](https://github.com/apple/containerization/blob/bc994b88df46207fad7775b0eabc51947e315881/Sources/Containerization/VZVirtualMachineInstance.swift#L129-L140), [Virtualization framework](https://developer.apple.com/documentation/virtualization)

## Constraints that affect the choice

**LinuxPod is not yet a proven elastic pool on macOS.** The pinned 0.47.0 source marks it experimental. Adding a container after boot uses VM hotplug; the VZ implementation throws when no hotplug provider is installed, and its standard manager does not install one. Pre-registering containers before boot is a different case. A custom hotplug provider or guest-side orchestration needs investigation before promising arbitrary new conversations in an already-running pod. [LinuxPod](https://github.com/apple/containerization/blob/bc994b88df46207fad7775b0eabc51947e315881/Sources/Containerization/LinuxPod.swift#L24-L29), [VZ manager](https://github.com/apple/containerization/blob/bc994b88df46207fad7775b0eabc51947e315881/Sources/Containerization/VZVirtualMachineManager.swift#L49-L66), [hotplug implementation](https://github.com/apple/containerization/blob/bc994b88df46207fad7775b0eabc51947e315881/Sources/Containerization/VZVirtualMachineInstance.swift#L318-L325)

**libkrun needs additional host confinement.** It exposes an embeddable C API and macOS/arm64 support, but its own security model warns that its virtio-fs implementation alone does not constrain the guest to the named directory. That makes embedding it in a daemon with broad host access a poor default for selected-folder containment. Current development and stable API branches also need to be distinguished. [libkrun](https://github.com/libkrun/libkrun)

**Managers do not remove the underlying process boundary.** vfkit offers useful virtio-fs, vsock and REST control facilities. Lima supplies lifecycle orchestration around VZ/QEMU and has a hostagent per instance. OrbStack explicitly shares a Linux kernel; its machines are not independent hardware VMs. Docker Desktop offers VZ and a container-oriented VMM. These are useful alternatives or references, but not equivalent in-process libraries. [vfkit](https://github.com/crc-org/vfkit), [Lima VM types](https://lima-vm.io/docs/config/vmtype/), [Lima internals](https://lima-vm.io/docs/dev/internals/), [OrbStack architecture](https://docs.orbstack.dev/architecture), [Docker VMM](https://docs.docker.com/desktop/features/vmm/)

**Native Firecracker does not run on macOS.** Upstream requires Linux/KVM. Nested use inside a Linux guest adds another virtualization layer and is not a compelling baseline here. [Firecracker prerequisites](https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md)

**Linux and macOS guests serve different workloads.** Linux supports the proposed general tool/repository environment, but cannot supply Xcode or native macOS application execution. macOS guests are another backend with larger provisioning/storage costs and additional license terms to review, not a general requirement for Cowork. Any macOS guest license limit must not be described as a Linux VM limit. [Apple macOS guest guide](https://developer.apple.com/documentation/virtualization/running-macos-in-a-virtual-machine-on-apple-silicon), [macOS license](https://www.apple.com/legal/sla/docs/macOSTahoe.pdf)

**The platform floor remains macOS 26.** Containerization documents that support level. macOS 27 additions such as DiskImageKit overlays and custom Virtio devices must not become assumed dependencies of the current design; vmnet integration is available in 26. [Containerization requirements](https://github.com/apple/containerization#requirements), [WWDC26 capabilities](https://developer.apple.com/videos/play/wwdc2026/224/)

**Boot, provisioning and logical restoration are separate timings.** Apple's lightweight-guest startup claim does not include downloading/extracting images, cloning repositories, installing packages, or reconstructing Winter and its subagents. Pause retains execution state; cold stop retains files only if storage is persistent. Durable VM RAM save/restore depends on the exact supported device configuration and is not part of the pinned Containerization VM interface. [Containerization design](https://github.com/apple/containerization#design), [VM interface](https://github.com/apple/containerization/blob/bc994b88df46207fad7775b0eabc51947e315881/Sources/Containerization/VirtualMachineInstance.swift), [Apple saved-state validation](https://developer.apple.com/documentation/virtualization/vzvirtualmachineconfiguration/validatesaverestoresupport())

**Concurrency needs admission control.** No universal practical Linux VM-count limit was established. CPU, RAM and I/O budgets must be measured across concurrent guests. A reusable Project workspace also needs a writer policy; do not concurrently mount one ordinary writable filesystem disk image into multiple VMs.

## Recommended shortlist and questions

Compare embedded Containerization against embedded direct VZ first. Keep a single shared native helper as a fallback, not a helper per conversation. Dedicated VMs provide the clearest boundary between unrelated conversations; a VM per Project or a shared guest can be an explicit resource-saving mode if weaker separation is acceptable.

Before selecting the backend, settle:

1. Whether Apple-managed backing VM service processes are acceptable when Winter itself starts no host process per conversation.
2. Whether Project conversations may share a live writable environment concurrently, or must queue for a writer lease.
3. Whether hardware isolation between unrelated conversations is required or a shared guest kernel is acceptable.
4. The maximum active guest resource budget and how users should experience queued work.

The existing [research and decision draft](2026-10-10-cowork-vm-research.md) records accepted workspace/direct-write behavior. Subagent continuation after parent restart is being fixed separately in the SDK; that work does not require choosing or implementing a VM backend.
