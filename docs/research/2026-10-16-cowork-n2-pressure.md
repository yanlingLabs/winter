# Cowork N2 S6: persistence, disk pressure and production admission probes

Status: source only and UNWIRED. Nothing in `packages/*/src` imports these modules; an anti-wiring pin
(`packages/core/test/cowork/native/pressure.anti-wiring.test.ts`) enforces that. No VM, Hypervisor.framework, sandbox or
signing step is involved, and no `CoworkErrorCode` was added (`resource_blocked` is a structured result, see "Result
vocabulary"). The live proof of the numbers below is gate G5, which is not run here.

This is the TypeScript half of N2 acceptance item 6 (persistence and pressure) plus the real host-fact probes the admission
ledger has lacked since it was written. It builds on
[raw backing images](../cowork-raw-volumes.md), [private storage](../cowork-storage-security.md) and the resource section of the
[execution contracts](../cowork-execution-contracts.md#daemon-lifetime-sleep-resource-coordination-and-retention).

## The four modules

All under `packages/core/src/cowork/native/`, with tests under `packages/core/test/cowork/native/`.

| Module | What it is |
|---|---|
| `free-space.ts` | Physical free-space admission for claim and launch (`assessFreeSpace`, `preflightImageAdmission`), the `FilesystemSpaceReader` port with a real `bun:ffi` `statfs`/`fstatfs` adapter, the `ImageFootprintReader` port with a read-only `fstat` adapter (allocated bytes), and the sticky Time Machine exclusion re-verification. |
| `pressure.ts` | `CoworkPressureGuard`: the reactive 5 GiB reserve guard with hysteresis, an injected halt-only `WriterHaltPort`, and a fail-closed admission view. |
| `admission-probes.ts` | `createCoworkAdmissionProbes`: production `AdmissionProbes` for IOPlatformUUID, `kern.bootsessionuuid` and `proc_pidinfo` start time, plus `coordinationLedgerPath`. |
| `resource-observer.ts` | `createCoworkResourceObserver`: the synchronous `observeResources()` the ledger asks for, from sysctl memory pressure and the guard's last snapshot. |

The modules define their own small port types and do not import any other `native/` slice (S1 adds different files in the
same directory; there is no `native/index.ts`).

## Result vocabulary

`resource_blocked` is the contract's published outcome for a disk-pressure refusal
([host protocol](../cowork-host-protocol.md): typed operation outcomes). `CoworkErrorCode` lives in the hot `cowork/types.ts`
and gains no member here, so the modules return a structured value instead of throwing:

- `{ outcome: "resource_blocked", reason, requiredBytes, availableBytes, reserveBytes, filesystemId }` with `reason` one of
  `free_space_below_requirement`, `free_space_below_reserve`, `free_space_unavailable`, `free_space_filesystem_changed`,
  `pressure_guard_blocked`;
- `{ outcome: "backup_exclusion_unavailable", image }` (an existing `VolumeFailure` spelling);
- `{ outcome: "invalid_request", detail }` for a malformed call, never an admit and never a throw;
- `{ outcome: "admit", ... }`.

The values carry no host path and no error text. The host maps them to its public outcome later (S7).

## Free-space admission at claim and launch

**Rule.** `min(available bytes over every observed filesystem) >= sum(remaining liability of every image) + reserve`, where
a single image's remaining liability is `provisioned - min(provisioned, allocated)` and `allocated` is `st_blocks * 512` read
with `fstat` on the pinned descriptor. The reserve defaults to `COWORK_FREE_SPACE_RESERVE_BYTES` (5 GiB, the contract's
starting value) and is tunable per call. "Available" is `f_bavail * f_bsize` from `statfs`, which excludes APFS purgeable
space and is therefore the conservative reading.

**Boundary direction.** `available < required` blocks; `available == required` admits. Tests pin `required - 1`, `required`
and `required + 1`, and the same three values around the bare reserve for a one-byte image.

**Sparse images are not reservations.** A raw image is created with `ftruncate`, so its logical size claims no physical
space: a never-written sparse image has `allocated ~ 0` and so needs its full provisioned size. Bytes the image already holds
are credited because they are already missing from the free-space reading; counting them again would lock out a mostly
written image on a disk that still has room for the rest of its growth (a 100 GiB image with 90 GiB written needs 10 GiB
plus the reserve, not 100 GiB plus the reserve). The credit is capped at the provisioned size, so it can never go negative,
and an unreadable or nonsensical allocation (null, a throw, a negative, fractional or non-finite number) earns no credit at all.

**Copy-on-write caveat.** On APFS an overwrite can allocate new blocks without freeing the old ones (clones, local snapshots),
so the real remaining growth can exceed `provisioned - allocated`. Nothing here claims otherwise: the reserve and the reactive
guard below are what cover it, and gate G5 is where the margin is measured.

**Why a MIN and not a per-filesystem group.** On APFS, volumes of one container share the container's free pool and each
reports the container's free space under its own `f_fsid`. Grouping by `f_fsid` and checking each group alone would count the
same bytes twice and under-count demand. Taking the minimum available over all observed filesystems against the total demand
is safe on containers and merely over-conservative on genuinely separate disks. `f_fsid` is reported as a diagnostic and is
never used to partition admission.

**Fail closed.** An unreadable filesystem (`null`, a throw, a negative, fractional or non-finite reading, or a reader whose
property getter throws; every property is read inside a `try`) for any one image blocks with `free_space_unavailable`. A
blocked, unobserved or throwing pressure guard blocks with `pressure_guard_blocked` before any filesystem is read. Only an
exact `true` from the guard admits.

**Caller obligation (S7-facing).** Admission can only count the images it is given. The input therefore has two lists, both
required:

- `images`: the images being admitted (at least one);
- `outstanding`: **every provisioned image of every non-released admission the caller knows of**, that is every other
  workspace of this daemon whether running, draining or uncertain, and never the images in `images` themselves. Pass `[]`
  explicitly when there is none; omitting it is an `invalid_request`.

Leaving an outstanding image out under-counts, because that guest can still grow into the same pool. Outstanding images get
the same remaining-liability credit, and their filesystems are observed too, so the smallest pool decides. The lists are
bounded: `images` at `COWORK_FREE_SPACE_MAX_ADMITTED_IMAGES` (4: one guest admits two, data and environment, and this keeps a
caller from handing over a whole machine's images as "being admitted"), and `images` plus `outstanding` together at
`COWORK_FREE_SPACE_MAX_IMAGES` (8192: two images per guest at the ledger's 4096-guest cap). Admissions of other Winter homes
are invisible to this daemon's databases and cannot be listed; they are covered only by the reserve and the reactive guard.

**Export while stopped must bypass this admission (S7-facing).** The check exists to stop a guest from writing a full disk. An
export or backup of a stopped workspace writes nothing into the images, and refusing it on a nearly full disk would lock the
user out of their own data. S7 needs an export-while-stopped path that does not go through launch admission.

**Where it is called.** One check serves every moment:

- At plan or allocate (`CoworkVolumes.plan` / `materialize`, before any image exists), the host calls `assessFreeSpace`
  with a path target that does exist, the home root, and the planned `capacityBytes` values. A path that does not exist yet
  would read as `free_space_unavailable`, which is the wrong refusal at that moment. A directory has no footprint, so there
  is no credit.
- At claim (the images exist; no descriptor has been handed out), the host calls the same function with path targets for the
  existing image files; the footprint is read with `lstat`, never following a link.
- At launch, after `open` has produced the pinned image descriptors and before any descriptor is transferred to a worker, the
  host calls `preflightImageAdmission`. It reads free space with `fstatfs` and the allocation with `fstat` on each pinned fd
  (never re-resolving a path), then re-verifies the sticky exclusion (below) of the images being admitted. A refusal happens
  before any guest could write; what the host does with the claimed-but-never-started ownership is S1's decision.

The production adapters are `createStatfsReader()` (lazy `bun:ffi` binding to `statfs` and `fstatfs` in libSystem, macOS arm64
only, anything else throws `unsupported_topology` at construction) and `createFstatFootprintReader()` (`fstatSync`/`lstatSync`,
regular files only). The 2168-byte `struct statfs` layout is parsed by a pure function with pinned offsets, and a real-host
test checks the parse against `fs.statfsSync` on the stable fields.

## The reactive reserve guard

`CoworkPressureGuard` samples the filesystems the host `watch`es, when the host calls `evaluate()` (no timer lives in the
module). Per watched key:

| State | Event | Result |
|---|---|---|
| clear | free `< reserve`, or the reading is unreadable | blocked, new episode, `WriterHaltPort.haltWriters` called |
| blocked | halt not yet confirmed | halt retried on every evaluation, same episode number |
| blocked | free `>= reserve + resume margin` AND halt confirmed | clear |
| blocked | anything else | stays blocked, no new halt, no new episode |

- **Boundary direction.** `free < reserve` blocks and `free == reserve` does not: the reserve is the floor to keep free, and at
  the floor nothing has been taken from it yet. Pinned at `reserve - 1`, `reserve`, `reserve + 1`.
- **Hysteresis.** A flapping reading around the reserve blocks once. It clears only at `reserve + COWORK_PRESSURE_RESUME_MARGIN_BYTES`,
  and a dip after that is a new episode with a new halt. A test runs the full sequence and counts halts and transitions.
- **Never delete.** The halt port has exactly one member, `haltWriters`; there is no delete, truncate or resume member, and the
  anti-wiring pin asserts both that and the absence of any filesystem-modifying call in the modules. The guard cannot remove data.
- **A failed halt keeps the key blocked.** A throw, a rejection, `halted !== true`, or no answer within
  `COWORK_PRESSURE_HALT_TIMEOUT_MS` all mean "writers may still be running". The halt is retried every evaluation, and space
  recovering alone never clears the key. **The port must be idempotent per `(key, episode)` and also re-entrant:** a call that
  timed out is not cancelled, so the next evaluation re-issues the same `(key, episode)` while the earlier call may still be
  pending. A late answer from an abandoned call changes nothing. The timer started for each halt is always cleared. The timeout keeps one hung
  writer from stalling the sampling of every other filesystem; all samples are taken before any halt runs.
- **Unreadable space blocks** (reason `free_space_unavailable`) and clears only on a good reading above the resume line.
- **Fail closed at rest.** `admitsNewWork()` is false when nothing is watched, when any watched key has never been evaluated,
  or when any key is blocked. A host must therefore `watch` its home's filesystem at boot before admission can pass.
- **Episodes are guard-wide.** One monotonic counter numbers every blocked episode of every key and survives `unwatch`, so a
  key that is unwatched and watched again can never re-send an earlier `(key, episode)`; `(key, episode)` names exactly one
  episode for the guard's lifetime.
- **Retargeting** (`watch` on an existing key) keeps the blocked state, the episode and the confirmed halt, but makes the key
  unobserved: `admitsNewWork()` is false until the next evaluation, and the key's filesystem identity is learned afresh. A
  retarget made while an evaluation is running (for example from inside another key's halt callback, or the key's own) is
  respected: a sample taken from the old target is discarded rather than applied to the new one, and cannot clear the key.
- **A target that changes filesystem blocks.** The first good sample fixes the key's `f_fsid`. A later sample answering for a
  different one (for example a closed fd number reused for another file) blocks with `free_space_filesystem_changed`, halts
  writers, and does not clear while the target keeps answering for the other filesystem. It clears again if the target returns to
  its original filesystem (then judged on space like any key), or when the host re-watches it.
  The caller owns any fd target for the guard's lifetime and must not close it while watched; path targets avoid the hazard
  altogether. The identity check is a tripwire, not a substitute for that ownership.
- **Resume is the caller's.** "Clear" means the guard stops refusing new work. Restarting a halted writer is the host's step
  after it revalidates pressure and any uncertain operation, as the contract says ("resume only after pressure and uncertain
  operations are revalidated"). The guard never resumes anything. `onTransition` is the publication hook for
  `resource_blocked` and cleared.
- `unwatch(key)` reports whether the key was blocked, so a host dropping a filesystem can keep its writers halted.

### Constants and what gate G5 measures

| Constant | Value | Status |
|---|---|---|
| `COWORK_FREE_SPACE_RESERVE_BYTES` | 5 GiB | The contract's starting value, tunable. |
| `COWORK_PRESSURE_RESUME_MARGIN_BYTES` | 1 GiB | PROVISIONAL. Replaced by a measured value at G5. |
| `COWORK_PRESSURE_HALT_TIMEOUT_MS` | 10 000 | PROVISIONAL. |
| `RESOURCE_OBSERVATION_VALIDITY_MS` | 5 000 | PROVISIONAL. |
| `RESOURCE_DISK_SAMPLE_MAX_AGE_MS` | 15 000 | PROVISIONAL: the oldest guard evaluation the observer trusts. |

This is a reactive guard, not a quota. Bytes written between the sample that sees the crossing and the moment the writers are
actually halted overshoot the reserve; so does unrelated host activity. The contract makes readiness depend on measured
response and overshoot, and none of that is measured here. G5 on a disposable small volume should record: the sample period;
the time from crossing to a confirmed halt; the peak guest write rate under large-sequential, many-small-file and
multi-guest stress; bytes written after the crossing; and what happens to stale handles and to a failed read-only
transition. The reserve must exceed the worst measured overshoot with room to spare, and the resume margin must exceed the
overshoot seen at the clear point so the guard does not re-cross immediately. If adequate protection cannot be shown, the
contract requires quota-capable backing before unrestricted shared writes are exposed.

## DISCARD and punch-hole decision: none in v1

Decision: **do not implement guest DISCARD, WRITE_ZEROES or host-side hole punching in v1.** This closes the
"separate native v1 gate" that [raw backing images](../cowork-raw-volumes.md) left open, for this version.

Reasons:

1. **The guard does not need it.** Admission reserves each image's remaining growth (provisioned size minus what is already
   allocated), so a sparse image's high-water mark can never exceed what admission covered, and the reactive guard handles the
   rest. Reclaiming freed guest blocks is a space-efficiency feature, not a safety property.
2. **It enlarges the VMM surface.** Discard means a new virtio feature bit and host file operations
   (`fcntl(F_PUNCHHOLE)` on the image descriptor) at guest-chosen offsets and lengths, with APFS block alignment, range
   validation and error mapping, inside the sandboxed worker whose device inventory and drain/pin budget are a reviewed
   boundary. A device-set change needs the S4 patch review and a fresh G4 run.
3. **Its semantics cannot be validated without a VM.** The interaction between discards, the ext4 journal after an abrupt stop,
   and when APFS actually returns the space is exactly what a source-only slice cannot establish.
4. **Adding it later is not a format change.** `raw-ext4-v1` is already a sparse-capable raw image; discard would be a later
   device feature behind its own gate.

Cost accepted: an image's physical size is its high-water mark and never shrinks in place. The way back to a smaller image is
the explicit export-and-restore path into a fresh sparse image, not an automatic one. Nothing in this slice, and nothing the
guest bootstrap (S5) needs, asks for discard. Reopen it only if G5 or field evidence shows high-water growth exhausting real
disks; it would then be its own native gate with its own tests.

## Production admission probes

`createCoworkAdmissionProbes(deps)` returns an `AdmissionProbes` for `CoworkAdmissionLedger`. There are no defaults: a test
that builds the probes must inject every adapter, so it cannot reach the host by accident
(`createProductionHostAdapters()` supplies the three real ones).

Real, read-only:

| Fact | Source | Notes |
|---|---|---|
| `machineId` | IOPlatformUUID from `/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice` | Fixed absolute path and arguments through an injected runner (`createHostCommandRunner`: empty environment, stdin `/dev/null`, stderr discarded, a 5 s timeout enforced with SIGKILL so a child that ignores SIGTERM cannot outlive it, 256 KiB cap; behaviour tested against real children, including one that traps SIGTERM and one that floods stderr). Exactly one line may mention the key and it must be a well-formed non-nil UUID. Cached after the first good answer. |
| `bootId` | `kern.bootsessionuuid` via sysctl FFI | Read on every call. Well-formed non-nil UUID or `null`. |
| process identity | `proc_pidinfo(PROC_PIDTBSDINFO)`, 136-byte `proc_bsdinfo` | `startToken` is `<seconds>.<microseconds>`. Only ESRCH proves a process absent (`dead`); a short read, a record for another pid, a zero start or EPERM is `unknown`. A zombie is `dead`. |
| Coordination ledger path | `coordinationLedgerPath({ env, homeDirectory })` | Pure spelling, no IO. `WINTER_COWORK_COORDINATION_DIR` or `~/Library/Application Support/Winter/Coordination`, exactly as the host-storage fence spells it (a test pins the two together). A set-but-invalid override throws; it never falls back to the real path. |

Injected ports (S1 and S7 own them):

- `installationId`, `homeIdentity` and `verifyStopReceipt` are required. `authorizeRelocation` is optional and defaults to deny.
- **`verifyStopReceipt` stays a port.** This slice implements no stop evidence. The tests assert that nothing in the probe
  file ever calls it other than the ledger's `release`, and that a dead or reused PID leaves a real ledger record `uncertain`
  and never `released` (the D1 line: PID or EOF alone never releases).
- `confirmsPreviousBootEnded(previous, current)` returns true only when `previous` is a well-formed boot UUID that differs
  (case-insensitively) from `current.bootId`, and `current` equals the host identity this process reads right now (machine,
  installation and boot). A forged "new boot", an unreadable live host or a malformed id is false. This is the "changed host
  boot id" evidence of D1, bounded by the kernel minting a new `kern.bootsessionuuid` only at boot.

Every probe that cannot observe returns `null` (or `unknown`/`false`), never a guess; the ledger turns `null` into
`probe_unavailable`, and `reconcile` into `uncertain`.

`hostIdentity()` runs inside the ledger's `BEGIN IMMEDIATE`, so the runner's time bound is what keeps a hung `ioreg` from
holding the coordination write lock; because only a good answer is cached, a hang costs at most one timeout per attempt.

### Where the installation id should come from

The probes take `installationId` as a required injected source and mint nothing. The recommended production source, for S7 to
build and review, is:

- a sibling file `installation-id` in the Coordination directory, mode 0600, created with `O_EXCL` (never overwritten), with
  the file and then the directory fsynced;
- minted **only when the ledger is also absent**: an `installation-id` with a surviving ledger, or a ledger with no
  `installation-id`, is a refusal that needs recovery, never a regeneration (the ledger pins the id in `admission_meta` forever,
  so a regenerated id would turn into a permanent `ledger_identity_mismatch`);
- added to the host-fence control list next to `cowork-admission.sqlite{,-wal,-shm}` at `runtime-sdk/control-plane.ts:197`, so
  tools cannot read or rewrite it.

Because it is a new persistent artifact in a fenced directory, it needs its own review; nothing here writes it.

## Resource observer

`createCoworkResourceObserver(options)` returns the synchronous `() => ResourceObservation | null` the ledger calls inside its
reservation transaction. It reads `hw.memsize`, `hw.ncpu` and `kern.memorystatus_vm_pressure_level` (1 normal, 2 elevated,
4 critical, anything else unknown) and the guard's last snapshot; it never samples a filesystem or calls a halt port.

- Disk pressure is `unknown` unless the guard has evaluated, watches at least one key, has observed every key, and the last
  evaluation is no older than `RESOURCE_DISK_SAMPLE_MAX_AGE_MS` (and not from the future); any blocked key is `critical`.
- The reported pressure is the worst of memory and disk (`unknown` over `critical` over `elevated` over `normal`), and
  `admitNew` is true only for `normal` or `elevated`. The ledger refuses `critical`, `unknown` or `admitNew: false` with
  `pressure_refused`; a real-ledger test walks that through the guard.
- An unreadable `hw.memsize` or `hw.ncpu`, or an unusable budget, returns `null` (the ledger's `probe_unavailable`).
- **The budget is not chosen here.** The guest limit and the accounted memory and CPU units are product policy; they are an
  injected function of the host's physical memory and CPU count.

## Sticky Time Machine exclusion at each admission

`reverifyStickyExclusion` and `preflightImageAdmission` re-verify, never apply, and only for the images being admitted (the
caller holds no pinned descriptors for the outstanding ones). The parameter type is
`Pick<CoworkVolumeBackup, "verifyItemExcluded" | "verifyDescriptorExcluded">`, so the enrollment member is not even reachable.
For every image both the cheap pinned-vnode check and the named check must return exactly `true`; a throw is a no, and the
first failing image is named. Enrollment stays in `CoworkVolumes` at creation. This module never runs the backup tool itself:
the injected helper does, and the named check must run outside any SQLite transaction. One real-host test applies the existing
helper to a disposable temp image and then confirms the re-verification accepts only that image; nothing outside a temp
directory is ever touched.

## Unwired, and how that is pinned

The anti-wiring test asserts: nothing in any package (other than its tests), `scripts/` or `extensions/` names the modules or
their exports, and no sibling in `cowork/native/` reaches them by any relative spelling (static import, re-export, dynamic
import or `require`, with or without `.ts`/`.js`; the pattern has its own test); no `native/index.ts`, no `cowork/index.ts`, no
`cowork/native` in `core/src/index.ts`; each module imports only its allowed set, with `../admission`, `../volume-backup` and
`./admission-probes` as type-only imports; the only filesystem access is `fstatSync` and `lstatSync` in `free-space.ts`; the
halt port, the admission view and the space reader have exactly their stated members; no deletion, truncation, rename, write,
open, `process.env`, `homedir`, `pmset`, `hv_`, `krun_`, `sandbox_init` or exclusion-enrollment text appears in the modules; the
only process the probes can start is the fixed ioreg query; and `types.ts` does not mention `resource_blocked`.

Tests that read the real host assert **shape only**: every check reduces to a boolean before it reaches `expect`, so a failing
assertion can only ever print `false`, and no real machine id, boot session id, serial, host name or user name is compared
with a literal, logged, snapshotted or stored (the real-ledger test substitutes synthetic machine and boot ids and uses the
real process table only). All literals in the tests are obviously synthetic.

## REVIEW NEEDED

1. **Installation id.** `admission_meta` pins `installationId` forever, so a lost or regenerated id makes
   `ledger_identity_mismatch` permanent. The probes take it as a required injected source and mint and persist nothing. The
   recommended production source is written above and needs its own review, including the fence list entry.
2. **Remaining-liability credit.** Admission credits `st_blocks * 512` per image (capped at the provisioned size; unreadable
   earns nothing). The APFS copy-on-write and snapshot caveat means it can still under-count growth; the reserve and the
   reactive guard are what cover that, and G5 is where the margin is measured.
3. **`outstanding` is a caller obligation.** The API forces the caller to state it, but cannot check that it is complete.
   Images of other Winter homes cannot be listed by this daemon. S7 must also provide the export-while-stopped path that
   bypasses launch admission.
4. **MIN across filesystems** over-counts images on genuinely separate disks. That is deliberate (APFS containers share a
   pool) and safe; say so if you would rather group by container.
5. **`resource_blocked` as a result, not a code.** S7 must map it to the public outcome vocabulary and decide how it relates
   to the existing `recovery_required`/`source_unavailable` family.
6. **Provisional numbers** (resume margin, halt timeout, observation validity, snapshot age) and the boundary direction
   (`free < reserve` blocks) are for G5 to replace or confirm.
7. **The halt port contract.** It must be idempotent per `(key, episode)` and re-entrant, must not delete, and a host with
   nothing `watch`ed cannot admit anything. Hosts must `watch` at boot, own any fd target for the guard's lifetime, and prefer
   path targets.
8. **Budget policy** (guest limit, accounted memory and CPU) is injected, not chosen. D8's first-run recommendation is 2 vCPU
   and 768 MiB per guest.
9. **Boot-ended evidence** rests on `kern.bootsessionuuid` changing only at boot. A restored VM snapshot that keeps the old id
   reads as "same boot", which is the safe direction; a cloned machine with a different id on another host is out of scope
   (local coordination only, as the contract says).
10. **`homeIdentity`** is a port. What counts as a stable volume id (BSD device numbers are not stable across reboots for every
    volume) is the S1/S7 question; nothing here decides it.
11. **Cost of the named exclusion check.** Re-verification spawns the existing `tmutil` helper once per image per admission.
12. **Real-host tests** beyond the four sanctioned probes (all shape-only, read-only or temp-only): the `statfs`/`fstatfs`
    layout check, the existing `tmutil` helper applied to a `mkdtemp` image and then re-verified, `hw.memsize`/`hw.ncpu`/
    memory-pressure reads, a `/usr/sbin/sysctl -n` cross-check compared as a boolean, a `/bin/sleep` child started and killed by
    the test, and harmless coreutils (`env`, `perl`, `false`, `sh`, `head`) run to test the command runner's bounds.
