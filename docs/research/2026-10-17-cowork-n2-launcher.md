# Cowork N2 S2: the signed Swift launcher

Status: SOURCE ONLY, 2026-10-17. Branch `cowork/n2-launcher`, based on `cowork/output-integration`. Nothing here is wired: no daemon,
`project.yml` or `release.ts` reference the launcher, the embed script or the lib (a test pins that). No VM, no Hypervisor.framework call,
no libkrun, no sandbox call, no `pmset`, no app launch, no Keychain, nothing under `~/.winter*`, no Developer ID. The contract is S1's
(`docs/cowork-native-worker.md` plus `protocol.ts` and the vectors on `cowork/n2-host-adapter`, vectors last changed in `7fca49f7a`).

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

## Where the contract is silent (REVIEW NEEDED)

1. **`homeId` is not on L1.** Every Class A receipt carries it and `stop-proof.ts` refuses a mismatch, but `begin` has no such field (S1's
   fake launcher takes it as a constructor option). The launcher takes `--home-id` at spawn. S1 should add it to `begin` or bless the argument.
2. **Worker descriptor layout.** Section 5 says "an unnamed inherited datagram control socket" without a number. Chosen: 3 = L2, 4 = L3, argv =
   `[path]`, environment `LC_ALL=C LANG=C`. S3 must match (the fixture passed the number in argv).
3. **Sleep and wake have no L1 line** (section 10: "other slices"). The observer records `will_sleep` / `did_wake` in a bounded ledger behind
   `PowerReporting` and sends nothing. Proposed line, daemon-bound: `{"v":1,"t":"power","event":"will_sleep"|"did_wake"}`.
4. **The daemon's signing identifier.** The brief names `com.winter.core`; the Computer Use helper (`HelperIdentity.swift`,
   `scripts/computer-helper-lib.ts`) records that the SHIPPED daemon carries `winter-core` (signed without `--identifier`) and that changing it
   would change every Keychain access list. Implemented as briefed, one constant. If the helper is right, the launcher refuses the real daemon.
5. **The worker's identifier** `com.winter.cowork.worker` comes from the plan (section 4), not the contract. S3 confirms.
6. **Boot id.** `hello.hostBootId` and every receipt's `hostBootId` are `kern.bootsessionuuid` verbatim (uppercase UUID). The daemon's
   `CoworkNativeHostBoot.bootId()` (S6/S7) must return the same text, byte for byte.
7. **Descriptor attribution on L1.** Descriptors belong to the line that starts at the first byte of the chunk they arrived with, and only at a
   line boundary; anywhere else (or on any line but `volumes`, or a count other than two) is a violation: close them all, one
   `fault protocol_violation`, then owner-loss handling. Later lines coalesced into the same chunk are fine.
8. **Refusal codes the contract leaves open.** READY timeout and a worker fault `sandbox_failed` map to `sandbox_failed`; a changed pinned file or
   a failed SecCode to `code_identity_mismatch`; a digest mismatch, any descriptor that does not name the stated file, a worker `bad_volumes`
   or an unacknowledged transfer to `volumes_rejected`. After a refused `begin` for a worker that WAS spawned the launcher also sends the
   Class B `uncertain`, so the host's `failStart` wait ends at once (S1's inbox serves queued terminal messages first).
9. **A worker killed before it held a descriptor cannot be Class A**, because the receipt requires `exit:"code"`, `status:0`. The host then ends
   such a failed start `uncertain` even though nothing was ever attached. Conservative, and S1's call whether Class A may ever say `signal`.
10. **Retained receipt attestation** (below).

## The retained-receipt path (D1) and a storage proposal

`DurableReceiptStore` is the protocol; `DirectoryReceiptStore` is a file-backed implementation (one `<workspaceId>.<incarnationId>.<epoch>.receipt`
per scope, exactly the receipt line, 0600, directory 0700 and owned by the user, write-once, no symlinks, refuses any `.winter*` component);
the in-memory double lives in the tests. The launcher refuses to start without a store; the directory is created (mode 0700) at start, and no file exists until a verdict does.

Proposed production directory: a user-level directory OUTSIDE the Winter home that survives a home wipe, named per `homeId`, created by the
daemon with mode 0700 and passed as `--receipt-dir` (for example under the user's Application Support, in a `Winter Cowork` folder).

Attestation is the open problem, and the file alone is not it: any process of the same user can write such a file. What the file format
supports today: the daemon-side port can require that name, content, scope, `homeId`, owner tuple and boot id all agree. Stronger options, in
rising cost: (a) additionally require the guard probes S1 already has for owner recovery (process absent, images unlocked) before a RETAINED
Class A may release, because `mintOrderlyStopProof` does not require them today for `source: retained`; (b) a MAC over the line whose key is
held in the Keychain with an access list naming the launcher's requirement (forbidden in this slice, so needs an explicit ruling); (c) the next
daemon asks a freshly spawned, SecCode-verified launcher to read its own store, which needs new L1 lines (a contract change). Recommendation:
(a) now, (c) when the contract is next revised. Residual: a same-user process that forges a retained Class A can release a disk whose VM is still
running (data risk, not secrecy).

## Evidence

Commands (all from the repository root; scratch paths of your choice):

```
swift build --package-path apple/Cowork/WinterCoworkLauncher --scratch-path <scratch>/build
swift test  --package-path apple/Cowork/WinterCoworkLauncher --scratch-path <scratch>/build                         # 161 tests
swift test  --package-path apple/Cowork/WinterCoworkLauncher --scratch-path <scratch>/build-test -Xswiftc -DWINTER_COWORK_TEST_BUILD   # 165 tests
bun test scripts/embed-cowork-native.test.ts                                                                         # 20 tests
```

The flagged run adds the tests that need the compile-time test pin: the real `winter-cowork-launcher` binary as a child of the test host, its
parent verified by `LOCAL_PEERTOKEN` and a pinned cdhash, a whole lifecycle (begin, two real descriptors, the worker writing through them, stop,
Class A, retire, exit 0), loss of the daemon, and SIGTERM. In a normal build the same file proves the pin does not exist: the argument names are
refused, the binary contains no `WINTER_COWORK_TEST_` byte, and the production requirement refuses the test host as a parent. No test starts a VM
or touches HVF; the only child is `FakeWorker`.

Golden vectors: S1's four files are copied (not edited) under `Tests/LauncherCoreTests/Vectors/`, pinned by SHA-256 in `PINS.json` with the S1
commit. Every positive vector round-trips byte for byte through this encoder and decoder (19 lines, 7 envelopes, 15 mux frames, 8 receipts), and
every negative one fails with the contract's own code. The launcher relays blind, so 13 mux-frame negatives and 1 launcher-line negative that only a
payload parser can refuse are accepted by its header check on purpose; their names are pinned in the test.

Static checks on an ad-hoc signed release build, produced by `embed-cowork-native.sh` with a stand-in worker (a copy of `/usr/bin/true`) in scratch:
`codesign -dvv` gives `Identifier=com.winter.cowork.launcher`, `flags=0x10002(adhoc,runtime)`; `codesign -d -r-` records exactly
`designated => identifier "com.winter.cowork.launcher" and anchor apple generic and certificate leaf[subject.OU] = "37N77U9RSZ"`; no entitlement
key; `codesign --verify --strict` passes; `otool -L` lists only `/usr/lib/...` and `/System/Library/...` (Security, IOKit, Foundation, CryptoKit,
CoreFoundation, libSystem, and the `/usr/lib/swift` runtime). A first release build carried the builder's absolute source paths in the linker's
debug map and the embed gate refused it by name; `-Xswiftc -gnone -Xlinker -S -Xlinker -x` (now in `launcherBuildArgs`) removes them.

Mutation checks (the catalogue and runners are in the author's scratch, not committed): 78 mutations, each applied to the source, run against
the named tests and reverted. 75 are killed (71 in Swift and C, and all 7 on `embed-cowork-native.sh`: marker check, foreign-dylib check, entitlements
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

Three mutations survive on their own BY DESIGN, each because a second, independent guard covers the same case: a non-canonical base64 carrier
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
