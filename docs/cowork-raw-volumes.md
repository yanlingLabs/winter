# First-version raw Cowork backing images

Status: host storage primitive implemented on `cowork/v1-raw-volumes`; production
native backend wiring, filesystem formatting and guest readiness remain blocked.
Separate encryption remains deferred under [the accepted storage
boundary](cowork-storage-security.md). These files are plaintext and permission
checks do not provide confidentiality against arbitrary same-user programs.

`CoworkVolumes` in `packages/core/src/cowork/volumes.ts` exposes trusted controller
methods only; no RPC, guest message, path selection or availability toggle invokes
it. Its mandatory authority port must verify the actual authenticated native
controller channel, registered canonical home binding, current workspace authority
and exact worker/incarnation/runtime-image identity. A manifest, PID or released
resource-admission row does not satisfy that port. There is no permissive default.

The runtime-state DB's schema 9 adds canonical `cowork_volumes` and
`cowork_volume_directories`. Each volume records its home/workspace, stable volume
and creation IDs, `raw-ext4-v1`/version 1, purpose, 512-byte sectors, 4096-byte
filesystem blocks, fixed logical capacity, creation state, descriptor-observed
UID/mode/device/inode, and durable writable owner/last native stop receipt ID.
Unknown format/version/state refuses. Geometry is bounded to 16 MiB–256 GiB per
image and aligned to 4096 bytes. These are host primitive bounds; production
capacity defaults, physical disk budget/admission and growth policy remain open.

The controller first calls `plan(request, capacities)` to commit intent without
filesystem effects, then `materialize(request)` to allocate; `allocate` performs
both in order. The only layout is
`<canonical-home>/cowork/workspaces/<workspace-id>/{data.ext4,env.ext4}`. Neither
caller-supplied image paths nor manifest imports can grant image access. Directory
walks use pinned `openat` descriptors with `O_NOFOLLOW`, and images use
`O_EXCL` on creation and `O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC` on reopen. Every checked
directory is UID-owned and exactly 0700; each regular image is exactly 0600,
single-link, with its recorded device/inode. Drift refuses without chmod, rekeying,
automatic enrollment or replacement. Existing shared Cowork parent roots may be
initially enrolled after validation; an existing unrecorded per-workspace backing
directory requires recovery. Creating shared instructions/memory/outputs must use
the established workspace directory, or a future explicit enrollment operation.

Creation progresses `planned → creating → allocated`, with creation intent before
`O_EXCL`, file/directory fsync before identity publication, sticky Time Machine
exclusion before sizing, and file fsync before publishing allocation. Sparse
`ftruncate` allocates the logical capacity without eagerly writing that capacity.
Retries resume only a recorded virgin inode of zero or exact final size. A crash
before recording file/directory identity, or an unexpected pre-existing file,
leaves recovery required; the primitive never deletes/truncates unknown data.
Crash after recorded identity, exclusion or sizing can finish the same allocation.
Allocation effects and public `plan`, `claim`, `open` and `release` reject caller-owned
SQLite transactions before authorization, ownership changes or descriptor opens.
Their internal transaction completion is therefore a top-level commit, and an
outer rollback cannot erase a published claim or restore a previous owner beside
an escaped writable descriptor. Nested savepoints are not durable ownership.
This also prevents transaction rollback from erasing a created image's identity.
Crash/power-loss state is conservative:
a lost DB commit can require recovery, never justify replacing an existing image.
There is no destructive cleanup or automatic replacement operation.

`timeMachineVolumeBackup` invokes `/usr/bin/tmutil addexclusion` without `-p` or
`-v`, then `isexcluded`, and verifies the sticky item metadata on the already
checked vnode descriptor. It touches only the two disposable/new image items,
never parent directories, volumes or global backup settings. The implementation
parses at most 256 bytes of binary plist metadata through CoreFoundation and
requires a root string exactly equal to `com.apple.backupd`. Equivalent ASCII or
Unicode encodings are accepted; malformed data, other root types/values, XML,
oversized metadata and unknown binary-plist versions refuse conservatively.
A named-item operation is bracketed by descriptor-relative identity revalidation;
a persistent path swap refuses. The named tmutil operation still resolves its
path during execution; bracketing is not an atomic guarantee that a transiently
swapped name receives no backup-metadata side effect. Every subsequent
admission/open verifies image exclusion.
Named `tmutil` checks run outside SQLite transactions while the image descriptors
stay pinned. Inside each `IMMEDIATE` transaction, the host reauthorizes, rereads
canonical records and revalidates those descriptors' identity, geometry and sticky
metadata through the cheap `verifyDescriptorExcluded` port, plus a fresh directory
identity walk. That port must never spawn or perform named-item operations. A
change between preflight and the locked operation refuses and closes pending
descriptors. Creation also rechecks sticky metadata before publishing allocation.
Shared instructions, memory and outputs receive no item exclusions and retain
their ordinary backup eligibility (a user's pre-existing exclusions can still
apply). A future explicit replacement path must exclude/verify the new item; this
primitive currently refuses replacement entirely.

`claim(request)` validates both allocated images and stores their owner atomically.
`open(request,purpose)` requires that exact owner and returns a pinned descriptor
with an idempotent `close`, never a raw-path grant. The descriptor is deliberately
close-on-exec; the native controller must transfer it explicitly on its admitted
worker channel. If transaction completion fails after opening an image, the pending
descriptor is closed; local handle accounting is published only after successful
completion. Closing a handle does not free ownership. Both disks remain bound
to controller instance, worker instance, incarnation, lease epoch and runtime image
digest across Core restarts. `release` requires the same owner, no local outstanding
handles and positive protected native stop verification for that owner and both
disks. The verifier must account for all native attachments/controllers; PID death,
heartbeat expiry or resource-ledger release never releases the disks. An unknown
stop preserves ownership. No conversation/Git/memory locking service is added.

`allocated` always has `filesystemState=unformatted`. No ext4 signature, guest
mount, ready-source acknowledgment or guest-start success is invented. The next
integration must build a real native descriptor-consumer, safe immutable guest
bootstrap formatting protocol and verified filesystem/guest readiness transition,
then connect these to authenticated worker launch/stop and active RAM return.
Until those gates pass, normal production provisioning stays disabled.

Schema 9 upgrades old host-only stores additively. Older builds refuse the version;
the existing explicit stopped-daemon rollback to v7/v6 accepts v8 and v9 only when
all Cowork tables are empty. Populated directories, volumes, ownership, home IDs
or other authority refuse rollback, preserving their records and backing data.
No release, publication, package pin, Keychain operation or live-home change is
part of this slice.

Validation: Core typecheck and focused Core Cowork/runtime-state tests, including
real nonprivileged tmutil item exclusions under disposable test homes. The test
preload places these under an already excluded temp root; assertions verify
image-local sticky metadata and absence of shared-directory markers, rather than
claiming the machine's global backup policy includes TMPDIR. Fault tests cover
creation/sizing/exclusion crashes, identity/permission/link/geometry drift, backup
path swaps, lost exclusion, cold owner continuity, stop proof, both outer
transaction rollback reproductions, failed-open descriptor cleanup, backup helper
transaction boundaries, post-preflight revalidation, bounded plist decoding and
schema rollback.
