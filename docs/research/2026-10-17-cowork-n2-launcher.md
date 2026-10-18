# Cowork N2 S2: the signed Swift launcher

Status: SOURCE ONLY, 2026-10-17. Branch `cowork/n2-launcher`, based on `cowork/output-integration`. Nothing here is wired: no daemon,
`project.yml` or `release.ts` reference the launcher, the embed script or the lib (a test pins that). No VM, no Hypervisor.framework call,
no libkrun, no sandbox call, no `pmset`, no app launch, no Keychain, nothing under `~/.winter*`, no Developer ID. The contract is S1's
(`docs/cowork-native-worker.md` plus `protocol.ts` and the vectors on `cowork/n2-host-adapter`, vectors last changed in `6c1f04e80`).

## What it is

`apple/Cowork/WinterCoworkLauncher/` is a Swift package: `LauncherNative` (about 300 lines of C), `LauncherCore` (codec, session state
machine, identity, receipt store, power observer), `launcher-main` (the executable `winter-cowork-launcher`, no entitlements), and
`FakeWorker` (a plain non-HVF child for tests). The launcher serves ONE worker for ONE `begin`.

| Concern | How |
| --- | --- |
| Parent | fd 3 must be an unnamed `AF_UNIX` stream pair; `LOCAL_PEERTOKEN`, the token's pid must equal `getppid()`, then `SecCodeCheckValidity` against the stated requirement. Only then `hello`. A refusal is one `fault parent_unverified` line and exit 67. |
| Worker spawn | `posix_spawn` with `START_SUSPENDED` and `CLOEXEC_DEFAULT`; descriptors 0-2 on `/dev/null`, 3 = L2 (datagram), 4 = L3 (stream), nothing else; two-variable environment. The executed image is validated (strict SecCode, requirement, pinned cdhash) BEFORE resume and AGAIN after READY. |
| Reaping | Sole reaper. The only signal is `lc_kill_owned`, after a fresh `WNOHANG` proof under the ownership mutex; `SIGCONT` for resume is the only other `kill(`. No API takes a pid. SIGCHLD must be at its default or the spawn is refused. |
| Disk pair | `recvmsg` only (control buffer for 17, `MSG_CTRUNC` fatal, everything unasked-for closed); accepted only on a `volumes` line, exactly two; each is `fstat`-checked against the line (regular file, device, inode, size, uid, mode, read-write); forwarded in ONE VOLUMES datagram; the launcher's copies are closed at once. |
| Stop | Class A only if the launcher reaped an `exit(0)` worker after a DRAIN it actually delivered AND the flush chain is complete. Written durably (`F_FULLFSYNC`, `renamex_np(RENAME_EXCL)`, directory sync) BEFORE it is sent; kept until `receipt_retire`. Anything else is Class B. |
| Owner loss | L1 EOF, a protocol violation or SIGTERM/SIGHUP/SIGINT: DRAIN (`owner-loss`, own nonce), at most 30 s (and only ever shortening a longer host stop), then the owned kill; a durable receipt; exit. Nothing is released. |
| Power | `IORegisterForSystemPower`: quiesce and wake are recorded and the change is acknowledged at once. No assertion, no veto. |
| Relay | L3 frames are cut by header (magic, version, class, ceiling, exact length, per-class sequence); control and provider classes never cross; payloads are never read. |

Ported by reading, never by editing: `CleanStopAuthority` (`OrderlyStopAuthority`), `UnstartedReservation` (`WorkerReservation`),
`EventQueue` (`OutboundQueue`, terminal headroom) and `DeviceOperationGate` (`RelayGate`) from `WinterCoworkVM`; `OwnedChild.swift`,
`native.c` (`kb_channel`, `spawn_suspended`, the injectable `wait_locked`) and `FixedFixtureImage` from the key broker.

## Contract pin and what changed in the fix rounds

Pinned to the contract as merged on `cowork/output-integration` (contract round 3 by S1, `cowork/n2-host-adapter` @ `6c1f04e807df3a10579d6f14a15e39652bd1c7a6`, plus the later
fold that says an empty OUT/ERR frame no longer clears the runtime IN count). This branch merges that integration head (merge commit `3463208927fc`); the vectors are copied from the merged
tree, byte-identically, and the last commit touching them is `4f2f0c7258c8`.

**Deliberately NOT here: the receipt MAC and the v2 receipt text.** Integration has since moved on (the daemon side of the receipt MAC: a v2 receipt text and `begin.receiptKey`). This
branch stays on the pre-v2 contract of the merge above. The Swift side (the launcher minting v2 receipts with the MAC key from `begin`, and the vectors for them) is the next slice
after this PR merges; nothing in it is half-done here. Vectors are eight files (`envelopes`, `launcher-lines`, `mux-frames`, `stop-receipts`, `runtime-image`, `guest-stop`, `bootstrap-order`, `runtime-flow`)
with SHA-256 pins in `PINS.json`, which also records the contract document's own SHA-256 at the copied head.

Earlier in this round: `homeId` is on `begin` (after `id`) and is its ONLY source (no `--home-id`); memory floor 768 MiB; WorkerFault code 8 `second_drain`;
the shipped daemon's signing identifier is `winter-core` (`apple/ComputerUse/PROTOCOL.md` section 2.2), dev stays `com.winter.core.dev`.

### Contract round 3 (final pin), as it reaches the launcher

- **L2 STATUS** has `halting` (9) and `guest_fault` (10). Both need a VM (`vm_running` first, else a worker violation: kill, Class B) and are forwarded as
  `worker_state` lines (`halting`, `guest_fault`, informational only). The order of arrival is kept (`WorkerEvidence.order`); a set is no longer enough.
- **A power-off without `halting` is Class B.** The launcher's one decision procedure is `GuestStop.verdict`, a port of `coworkNativeGuestStopVerdict`; every case of
  `guest-stop.json` (29) runs through it unchanged. Orderly needs `vm_running`, `draining`, `drain_acked`, `halting`, `guest_halted` in that order, no `guest_fault`,
  reason `off` and complete flushes (exactly two disks, `completed == requested`, both final syncs done). A `guest_halted` after a mux quarantine or without a `drain_ack` is
  `guest-fault`. The `exiting` counters are informational and never feed a receipt; only those of `guest_halted` do. A `halting` before the drain ack, a `guest_fault` at any time, and a bare power-off are `guest-fault`; a drain never acknowledged
  is `drain-timeout`; no power-off report after `halting` is `flush-uncertain`.
- **What the launcher cannot see.** It sees statuses, not libkrun's exit reason or the final-sync flags. The worker reports `guest_halted` only for reason `off` with a
  completed final sync on both disks, so `GuestStop.observed` feeds the function `off` and complete syncs exactly when `guest_halted` arrived. A test replays every vector
  that way: the CLASS (orderly, not booted, uncertain) always equals the vector's. Only a reason code can differ (a `reset` or `vcpu-error` exit is `flush-uncertain`
  here, `guest-fault` in the vector), and neither is ever Class A. S3 owns the other half of the drift test. (A contract-prose observation, no code change: this `flush-uncertain` versus `guest-fault`
  difference is the only place the launcher's reason code can differ from the TypeScript's; on every input the launcher can actually produce the two agree. The verdict itself matches
  the TypeScript on the full truth table, as the reviewer checked.)
- **Receipt:** `guest` is `{drain, halting, powerOff}`; all three are `acked` / `observed` / `observed` or all `not-booted` (`invariantsHold`).
- **Layered stop timeline**, every figure from the moment the worker is handed the DRAIN: guest budget G (the DRAIN's `budgetMs`, default 30 s), libkrun exit watchdog
  X = 20 s, launcher kill K = G + 20 s + 5 s (55 s by default), daemon wait H = K + 10 s (65 s). The launcher's drain timer is K, for a host stop and for owner loss
  alike (the owner-loss cap on a longer host stop is the owner-loss K). `WireLimits.launcherKillMs` / `hostStopWaitMs` are the contract's two functions; a test pins
  their values and order. `SessionConfig.exitAllowanceMs` (25 s) exists only so FakeWorker tests, which have no VMM exit path to wait for, can shorten it.
- **Bootstrap order and the runtime IN bound** (`bootstrap-order.json`, `runtime-flow.json`) are rules of the endpoints (host sender, guest). The launcher relays L3 blind
  and judges neither: it carries every transcript and flow step whose frame passes the header check, and a test pins that. `conversations` and `runtime_ready` are
  ordinary bootstrap frames to it (bootstrap ceiling 256 KiB; the set is at most 20 KiB). `unixId` 1000 to 65533 is likewise payload content it never reads.
- **Control-up `fault`** terminates at the worker (control frames never cross L3); the launcher sees it as `guest_fault`.
- **Runtime payloads** carry a 4-byte prefix `{conversation, stream, end flag, 0}`. The launcher relays L3 blind and cuts frames by the 16-byte header and the class
  ceiling only (runtime payload ceiling 1 MiB, unchanged and prefix included), so nothing in it depends on the prefix, the one-conversation limit or the
  conversation-set message. The 78 new payload-level mux negatives are accepted by the header check by design; their names are pinned in the vector test.
- **libkrun exit reasons** (`NONE=0 … TERMINAL_FAULT=4`, `uint32_t`) and S4's flush-counter struct are the worker's and S4's; the launcher only models the reason names
  for the verdict function.

## New security logic (REVIEW NEEDED): `runtimeImageDigest`

`GuestArtifacts.swift` recomputes SHA-256(SHA-256(kernel) || SHA-256(initramfs.cpio)) over `<worker dir>/cowork-guest/{kernel,initramfs.cpio}`
and refuses the scope with `code_identity_mismatch` before anything is spawned. The directory and both files are opened with `O_NOFOLLOW` and `O_NONBLOCK`
(a FIFO at either path must be refused, not waited on), judged by `fstat` before any read (regular, singly linked, not group/other writable, at most 1 GiB), then hashed from the descriptors
with blocking reads restored. The 1 GiB cap is the guest's RAM ceiling (`maxMemoryMiB` 1024): a kernel or initramfs the guest could not load is no boot artifact, and an
unbounded file would stall the launcher's serial queue (the real ones are tens of MiB).

**Open item: the hash-then-load window.** libkrun opens the same files BY PATH inside the worker, after this hash. A same-user process that can write `kernel` or `initramfs.cpio`
in that gap wins the race. This is NOT closed here, and the earlier idea of handing the worker `/dev/fd/N` paths is withdrawn: a held read-only descriptor pins the inode, not its
bytes, so an in-place write through any other descriptor or path still changes what is read; on macOS `/dev/fd/N` is a dup that shares the file offset, which libkrun's own reads would
disturb; and it would change the worker's fixed descriptor table (0 to 4). What would close it: the launcher (or the installer) puts the artifacts where a same-user process cannot write
them (a root-owned or immutable location inside the signed bundle's protected path), or the launcher makes a PRIVATE unlinked copy it alone can reach (a copy of `kernel` and
`initramfs.cpio` in an `O_EXCL` 0600 file it hashed after writing, and then passes by descriptor, as the data the worker maps rather than a path). Either is a decision for the owner and S3/S4.

## Where the contract is silent (REVIEW NEEDED)

1. **Worker descriptor layout.** Section 5 says "an unnamed inherited datagram control socket" without a number. Chosen: 3 = L2, 4 = L3, argv =
   `[path]`, environment `LC_ALL=C LANG=C`. S3 must match.
2. **Sleep and wake have no L1 line.** The observer records `will_sleep` / `did_wake` in a bounded ledger behind `PowerReporting` and sends
   nothing. Proposed line, daemon-bound: `{"v":1,"t":"power","event":"will_sleep"|"did_wake"}`.
3. **The worker's identifier** `com.winter.cowork.worker` comes from the plan (section 4), not the contract. S3 confirms.
4. **Boot id.** `hostBootId` is `kern.bootsessionuuid` verbatim; the daemon's `bootId()` must return the same text byte for byte.
5. **Descriptor attribution on L1.** Descriptors belong to the line that starts at the first byte of the chunk they arrived with, only at a
   line boundary, only on `volumes`, exactly two. Anything else is a violation: close them all, one `fault protocol_violation`, owner-loss handling.
6. **Refusal codes the contract leaves open.** READY timeout and worker fault `sandbox_failed` map to `sandbox_failed`; a changed pinned file, a
   failed SecCode or a runtime image mismatch to `code_identity_mismatch`; a digest mismatch, a descriptor that does not name the stated file, a
   worker `bad_volumes` or an unacknowledged transfer to `volumes_rejected`. After a refused `begin` for a spawned worker the launcher also sends
   Class B `uncertain`, so the host's `failStart` wait ends at once.
7. **A worker killed before it held a descriptor cannot be Class A** (the receipt requires `exit:"code"`, `status:0`). Conservative; S1's call
   whether Class A may ever say `signal`.
8. **Worker stdout and stderr go to /dev/null.** Deliberate: the launcher never reads worker output, and a worker log would be an unreviewed
   channel out of the sandbox. Diagnostics travel as typed `fault` frames only. If the owner wants worker logs, it needs a contract line.
9. **S7 must never hand its L1 end to another process.** `LOCAL_PEERTOKEN` reports the LAST process that touched the peer socket, so a daemon that
   passes its end on (fork without exec, helper) changes the identity the launcher authenticates. The launcher also demands that the token's pid
   equal `getppid()`.
10. **Profile selection is not an argument.** The launcher reads which daemon it serves from its OWN code signature (identifier
    `com.winter.cowork.launcher.dev` selects `com.winter.core.dev`; anything else, including unsigned, is production and fails closed). A true
    compile-time switch would need a second build of the binary; the signed identifier is already enforced by the production requirement the
    daemon places on the launcher, so nothing argument-selectable remains. The identifier is read from the KERNEL's copy (`SecTaskCreateFromSelf` +
    `SecTaskCopySigningIdentifier`, i.e. `csops`), not by `SecCodeCopySelf` + `SecCodeCopyStaticCode`, which re-read the executable's path: a file swapped under the
    running process cannot change the profile. It still fails closed to production.
11. **`DEVELOPMENT_TEAM` versus the compiled team.** `apple/Winter/project.yml` builds with `DEVELOPMENT_TEAM: 37N77U9RSZ` while the launcher
    compiles `certificate leaf[subject.OU] = "37N77U9RSZ"` into its requirements. They agree today; they are two copies of one fact, pinned
    equal by `scripts/embed-cowork-native.test.ts`. A team change must move both, and the embed gate checks the recorded requirement.
12. **Exit judging.** A single `WNOHANG` probe at the process-exit event returned 0 in 0.3 to 0.65 percent of exits. A "still running" answer now
    retries on a bounded 10 ms timer (`exitProbeAttempts`), and a coarse 1 s backstop probe runs while a worker exists and re-arms itself, so no
    exit goes unjudged.
13. **Back-pressure, both directions.** DOWN (daemon to worker): the L3 backlog pauses L1 reads at a 4 MiB soft limit and resumes below half of it; a worker that accepts not one
    byte for the stall window (30 s), or any single pause that outlasts the total cap (120 s, progress or not: a trickling worker may not hold `stop` and the daemon's EOF behind the bulk
    for ever), is killed, and so is a backlog over the 32 MiB hard cap. UP (worker to daemon): the outbound L1 queue pauses L3 reads at its 4 MiB soft limit and resumes
    below it. The relay ceiling sits one largest line (1.5 MiB) plus two reads above that threshold, so the pause is reachable: an earlier version put the ceiling AT the threshold, which
    a refused enqueue always reached first, so a slow daemon was treated as lost and a healthy VM got an owner-loss drain. Only the hard cap (ceiling plus the 1 MiB terminal reserve)
    ends the channel now. The terminal lines (`stopped`, `uncertain`, `fault`) keep their reserve.
14. **Retained receipt attestation** (below).

## The retained-receipt path (D1) and a storage proposal

`DurableReceiptStore` is the protocol; `DirectoryReceiptStore` is a file-backed implementation (one `<workspaceId>.<incarnationId>.<epoch>.receipt`
per scope, exactly the receipt line, 0600, directory 0700 and owned by the user, write-once, `st_nlink == 1`, no symlinks). It refuses a location
with a `.winter*` component, judged case-insensitively on the REAL path of the open directory (`fcntl(F_GETPATH)` follows every symlink, so a
symlinked ancestor or `.WINTER-x` is caught). The in-memory double lives in the tests.

Proposed production directory: a user-level directory OUTSIDE the Winter home that survives a home wipe, named per `homeId`, created by the
daemon with mode 0700 and passed as `--receipt-dir`.

**Guard probes are S7's to make mandatory.** For `source: retained`, the two live guard probes (process absent, images unlocked) must run before the daemon releases anything, and a retained
Class A without both is not proof. That is NOT what the code at the integration head does today: `mintOrderlyStopProof` takes `{kind: "retained"}` with no probes, and `recovery.ts` mints from
a port that returns `attested: true` which nothing implements yet. S7 (the production ports) must implement that port with both probes, and solve retire (below). This launcher only writes the file.

**Authenticity.** A file the same user can write is not authentic: any same-user process can forge a retained Class A, and the probes above
are what stands between a forgery and a release. A MAC over the line, with a key held in the Keychain under an access list naming the launcher,
would raise the bar, but Keychain use is forbidden in this slice, so it is an OPEN ITEM that needs an owner ruling. Option (c), asking a freshly
spawned, SecCode-verified launcher to read its own store, needs new L1 lines (a contract change). Recommendation: the probes now, (c) at the next
contract revision.

**Retire gap.** After an owner-loss exit nothing can retire the file over L1 (the socket is gone), and Class B files are never retired. Proposal
(S7, daemon side, no contract line needed): the next daemon, after it has accepted a retained receipt AND the two probes pass AND the disks are
released, deletes the file by its exact scope name, and sweeps Class B files of a scope once a later Class A for the same workspace is accepted or
the owner chooses Recover. Until then the files are inert write-once records; a stale file cannot release a newer incarnation because the name and
content carry the scope and epoch.

## Evidence

Commands (all from the repository root; scratch paths of your choice):

```
swift build --package-path apple/Cowork/WinterCoworkLauncher --scratch-path <scratch>/build
swift test  --package-path apple/Cowork/WinterCoworkLauncher --scratch-path <scratch>/build                         # 214 tests
swift test  --package-path apple/Cowork/WinterCoworkLauncher --scratch-path <scratch>/build-test -Xswiftc -DWINTER_COWORK_TEST_BUILD   # 219 tests
bun test scripts/embed-cowork-native.test.ts                                                                         # 21 tests
```

The flagged run adds the tests that need the compile-time test pin: the real `winter-cowork-launcher` binary as a child of the test host, its
parent verified by `LOCAL_PEERTOKEN` and a pinned cdhash, a whole lifecycle (begin, two real descriptors, the worker writing through them, stop,
Class A, retire, exit 0), loss of the daemon, and SIGTERM. In a normal build the same file proves the pin does not exist: the argument names are
refused, the binary contains no `WINTER_COWORK_TEST_` byte, and the production requirement refuses the test host as a parent. No test starts a VM
or touches HVF; the only child is `FakeWorker`.

Golden vectors: S1's eight files are copied (not edited) under `Tests/LauncherCoreTests/Vectors/`, pinned by SHA-256 in `PINS.json` with the S1
commit. Every positive vector round-trips byte for byte through this encoder and decoder (32 lines, 28 envelopes, 36 mux frames, 8 receipts, 2 runtime image digests, 29 guest-stop cases), and
every negative one fails with the contract's own code. The launcher relays blind, so 13 mux-frame negatives and 1 launcher-line negative that only a
payload parser can refuse are accepted by its header check on purpose; their names are pinned in the test.

Static checks on an ad-hoc signed release build, produced by `embed-cowork-native.sh` with a stand-in worker (a copy of `/usr/bin/true`) in scratch:
`codesign -dvv` gives `Identifier=com.winter.cowork.launcher`, `flags=0x10002(adhoc,runtime)`; `codesign -d -r-` records exactly
`designated => identifier "com.winter.cowork.launcher" and anchor apple generic and certificate leaf[subject.OU] = "37N77U9RSZ"`; no entitlement
key; `codesign --verify --strict` passes; `otool -L` lists only `/usr/lib/...` and `/System/Library/...` (Security, IOKit, Foundation, CryptoKit,
CoreFoundation, libSystem, and the `/usr/lib/swift` runtime). A first release build carried the builder's absolute source paths in the linker's
debug map and the embed gate refused it by name; `-Xswiftc -gnone -Xlinker -S -Xlinker -x` (now in `launcherBuildArgs`) removes them.

Mutation checks (the catalogue and runners are in the author's scratch, not committed): 147 mutations (139 in Swift and C, 8 on `embed-cowork-native.sh`), each applied to the source, run against
the named tests and reverted. 142 are killed (134 in Swift and C, and all 8 on `embed-cowork-native.sh`: marker check, foreign-dylib check, entitlements
set, signing order, `--deep`, the non-Release skip, the recorded-requirement check). Areas: parent authentication (requirement skipped, pid unchecked, unnamed-pair unchecked, token
failure accepted, dev or wrong-team requirement), worker image (check before resume, check after READY, executed cdhash, pinned digest, requirement
ignored), natives (probe before kill, kill after a confirmed exit, sole-reaper policy, suspended spawn, `CLOEXEC_DEFAULT`, colliding child
descriptors, a second signal path), descriptor intake (`MSG_CTRUNC` fatal, `MSG_TRUNC` leak, close-on-exec, extras seen, rights at a boundary, rights
counts on lines and envelopes, rights on L3), codec (re-serialization compare, provider and control classes, oversize, sequence), session (scope
digest, descriptor identity, descriptors kept, nonce echo, persist before send, a non-durable Class A, retire on the wrong confirmation or on EOF,
30 s owner-loss budget and its cap on a host stop, the kill at the budget, drain counted before it is sent, worker violations, frames before the
disks, scope before validation, one `begin`), stop authority (flush, exit status, killed worker, unrequested exit, worker fault, unacknowledged
transfer, invariants), receipt store (write-once, directory mode, `.winter*`, symlinks, name against content), power (veto, assertion), runtime
(ECONNRESET, SIGTERM) and the test pin (present in a normal build).

Five mutations survive on their own BY DESIGN (the three below, plus two defence-in-depth checks: the receipt store's second location vetting after the parent was already vetted and the name checked, and the guest artifact `S_IFREG` test next to the size, link-count and writability tests, which also refuse a FIFO or a directory), each because a second, independent guard covers the same case: a non-canonical base64 carrier
(the line's final re-serialization compare also refuses it, and removing THAT compare is a killed mutation, so the pair is covered but the base64
check alone cannot be isolated), a second `begin` (the phase check and the reservation both refuse it; both dropped is killed), and a flush
shortfall (the stop authority's counter check and the receipt's own `invariantsHold` both produce `flush-uncertain`; both dropped is killed). The first pass also found one real gap (a stray descriptor without
close-on-exec was not proved to stay out of the worker; closed by a test that leaks one on purpose), one dead guard (a second `volumes` offer, already
refused by the phase; deleted) and one wrong reason code (an owner-loss drain started during the disk transfer left the transfer timer armed; fixed).

CI: the `swift` job builds only WinterProtocol, WinterKit, WinterChatKit and WinterBrowserHost, so it does not cover this package. `typecheck ·
cli, plugin-sdk, scripts` typechecks `scripts/cowork-native-lib.ts`; `scripts/*.test.ts` are not run by CI. Both were run locally.

## Not done here

The worker (S3), the libkrun profile (S4), the guest (S5), the daemon-side host and its production ports (S1, S6, S7) and every live gate (G0 to G6)
are other slices or need the owner. The receipt attestation above is a proposal, not a decision.
