# Cowork native worker: wire contract and host adapter

Status: contract, N2 slice S1, 2026-10-16. SOURCE ONLY. Nothing in this document or in `packages/core/src/cowork/native/`
is wired into the daemon, no VM was started to produce it, and every live gate (G0 to G6) still needs a review of the exact
commit and the owner's approval. The executable twin of this document is
[`protocol.ts`](../packages/core/src/cowork/native/protocol.ts); the golden vectors in
`packages/core/test/cowork/native/vectors/` are the cross-language oracle. The Swift launcher (S2), the C worker (S3) and the
guest (S5) copy this contract and carry their own drift test against those vectors, never the other way round.

There is no NIC and no vsock anywhere in this contract. Provider traffic is a RESERVED mux class with no implementation.

## 1. What this contract is for

The existing host primitives are complete and have no production caller:

| Primitive | What it needs from native code |
| --- | --- |
| `CoworkVolumes.claim / open / prepareFilesystems / confirmFilesystems / release` | `CoworkVolumeAuthority` and `CoworkVolumeFilesystemAuthority` implementations; a worker that actually receives two descriptors |
| `CoworkAdmissionLedger.reserve / transition / release / reconcile` | a producer of `StopReceipt`s and a `verifyStopReceipt` probe |
| `CoworkRepository.beginIncarnation` | nothing ever moves `power` on to `running`, `draining`, `stopped` or `uncertain` |

S1 supplies the three things that were missing: a closed wire contract, an adapter (`CoworkNativeHost`) that drives the
sequence over an injected launcher port, and sealed authority objects. The launcher, the worker and the guest are other slices.

## 2. Process chain and links

```
winter-core (daemon) --L1--> winter-cowork-launcher (Swift, signed, daemon child) --L2,L3--> winter-cowork-worker (C, self-sandboxed) --L4--> guest
```

| Link | Transport | Content |
| --- | --- | --- |
| L1 daemon and launcher | `AF_UNIX SOCK_STREAM` socketpair; the daemon makes it and hands the launcher end to the child as fd 3 | NDJSON lines; `SCM_RIGHTS` on exactly one line type |
| L2 launcher and worker | unnamed `AF_UNIX SOCK_DGRAM` socketpair | fixed-layout little-endian ENVELOPES, one datagram each |
| L3 launcher and worker | unnamed `AF_UNIX SOCK_STREAM` socketpair | MUX FRAMES of the bootstrap and runtime classes, relayed blind by the launcher |
| L4 worker and guest | the libkrun generic virtio-console port | MUX FRAMES of every class |

Trust rule, repeated because every later review will ask: **a parse is never an authentication.** The daemon knows who is on
L1 because it created the socketpair and spawned the launcher; the launcher knows who its parent is from the kernel peer
token and the signing requirement (S2). No field in any frame can vouch for itself.

Control-class frames terminate at the worker. They never cross L3 or L1: the daemon learns about guest lifecycle only through
`worker_state` and through the stop receipts.

## 3. Common wire rules

* JSON texts are UTF-8, exactly one line, last byte `\n`, no whitespace, integers only, `null` only where a table says so.
* Keys appear in EXACTLY the order of the tables below (`v`, then `t`, then the table order). A parser builds the typed value and
  re-serializes it; the result must equal the input byte for byte. That one comparison refuses duplicate keys, reordered keys,
  alternate escapes, alternate number spellings, and trailing data. Every positive vector exercises the order; the negative
  vectors include reordered keys, whitespace, duplicate keys and float spellings.
* Free-form nested objects (a filesystem plan or receipt inside a bootstrap frame) use recursively SORTED keys (UTF-16 code unit order).
* Binary formats are little-endian. Every reserved byte is zero. All endpoints (macOS arm64 host, Linux arm64 guest) are
  little-endian, which is why no byte-swapping is specified.
* Identifier tokens are `[A-Za-z0-9][A-Za-z0-9_-]{0,62}` (at most 63 characters, so they fit a NUL-padded 64 byte field). Label
  tokens additionally allow `.` and `:`. A digest is 64 lowercase hex characters, a stop nonce 32 lowercase hex characters
  (16 random bytes).
* `device` and `inode` are decimal strings, because they are `u64` and JSON numbers are not. Capacities are JSON integers.
* Limits: control line 16 KiB; mux carrier line 1,572,864 bytes; mux payload control 4 KiB, bootstrap 256 KiB, runtime 1 MiB
  (the existing guest runtime transport frame); one stop receipt 8 KiB; nesting depth 4 on L1.

## 4. L1: daemon and launcher (NDJSON)

`id` is a request correlation token chosen by the sender. Directions are enforced: a launcher-only type received on the
launcher-bound side is refused as `bad_direction`.

### 4.1 Launcher to daemon

| `t` | Keys after `v`,`t` | Meaning |
| --- | --- | --- |
| `hello` | `launcherInstanceId`, `hostBootId`, `parentVerified` (literal `true`) | first line. The launcher states that it verified its parent; the daemon treats it as a gate, never as proof. |
| `begun` | `id`, `workerInstanceId`, `workerPid`, `workerStartToken` | worker spawned suspended, executed image validated, SCOPE delivered, sandbox installed. PID and token are diagnostics only. |
| `volumes_accepted` | `id` | the worker received two descriptors after its sandbox and validated them against the SCOPE |
| `refused` | `id`, `code` | one of `bad_request busy not_begun worker_spawn_failed code_identity_mismatch sandbox_failed volumes_rejected internal` |
| `worker_state` | `state` | informational: `sandboxed volumes_accepted vm_running guest_hello draining drain_acked exited`. Never evidence. |
| `mux_up` | `frame` | one bootstrap or runtime mux frame, base64 of the whole frame |
| `stopped` | `id` (or `null`), `receipt` | a Class A receipt (section 7). `id` is the `stop` request it answers, `null` for an owner-loss drain. |
| `uncertain` | `receipt` | a Class B receipt (section 7) |
| `pong` | `id` | answer to `ping` |
| `fault` | `code` | the channel is no longer trustworthy: `parent_unverified protocol_violation worker_channel_lost internal` |

### 4.2 Daemon to launcher

| `t` | Keys after `v`,`t` | Meaning |
| --- | --- | --- |
| `begin` | `id`, `homeId`, `workspaceId`, `incarnationId`, `leaseEpoch`, `admissionId`, `controllerInstanceId`, `workerInstanceId`, `runtimeImageDigest`, `vcpus`, `memoryMiB` | the owner scope. `vcpus` is 2, `memoryMiB` 768 to 1024 (D8; 768 is the floor the library admits). `homeId` is the ONE source of the home identity: the launcher stamps it into every receipt, and it has no other input (no spawn argument). It does not travel on L2. |
| `volumes` (**two descriptors**) | `id`, `scopeDigest`, `volumes` | `scopeDigest` is the SHA-256 of the 512 byte SCOPE payload (section 5). `volumes` is exactly two records `purpose, device, inode, uid, mode, capacityBytes`, data first then environment; `mode` is 384 (`0600`); the same file may not back both. |
| `mux_down` | `frame` | one bootstrap or runtime frame |
| `stop` | `id`, `stopNonce`, `reason`, `budgetMs` | `reason` one of `user shutdown restart update failed-start`; `budgetMs` at most 120000 (the documented budget is 30000) |
| `receipt_retire` | `confirmationId` | the daemon finished with that receipt; the launcher may delete its durable copy |
| `ping` | `id` | liveness probe |

### 4.3 Descriptors on L1

`SCM_RIGHTS` is allowed on `volumes` and nowhere else. The sender attaches exactly two descriptors (data, environment) to a
SINGLE `sendmsg` that carries the whole line. The receiver reads every chunk with `recvmsg` and a control buffer, and applies
this rule: descriptors arriving with any other data are a protocol violation; the wrong count is `bad_rights`; a truncated
control buffer (`MSG_CTRUNC`) is fatal because the kernel may already have installed descriptors nobody will see. In every
refusal the receiver closes everything it was handed. **The launcher never sends descriptors to the daemon.**

Daemon-side mechanics, measured with Bun 1.3.14 on macOS 26 (arm64) and pinned by tests:

* `Bun.spawn(argv, { stdio: ["ignore", "ignore", "ignore", fd] })` DOES pass a descriptor above 2: each numeric entry is dup2'd into that slot
  of the child, and every other descriptor of the daemon stays closed in it. The daemon makes the socketpair through `bun:ffi`, passes the
  launcher end as fd 3 and **closes its own copy of that end immediately**; only then does the launcher's death produce EOF on the daemon side.
* **A plain `read()` installs rights on macOS.** Descriptors a peer attaches to a stream socket are installed in the reader's table by an
  ordinary `read()`, by `fs.read` and by `Bun.file(fd).stream()` alike, invisibly (reproduced with a C program and with Bun). Every reader of
  every link, in every language, must use `recvmsg` with a control buffer and close what it did not ask for. The daemon therefore never reads
  L1 any other way: every `FdReceiver` is served by ONE shared hub thread that runs `poll` and `recvmsg`, and `net.Socket({ fd })` and
  `Bun.connect` are not used.
* `sendmsg` and `recvmsg` go through `bun:ffi` against libSystem (struct layouts checked against clang). Ancillary truncation (`MSG_CTRUNC`)
  can leave descriptors installed that the reader cannot see, so it is fatal for the channel.
* Bun leaves one descriptor open per Worker it ever starts (a Worker that does nothing reproduces it), so the receiver is ONE Worker for the whole
  daemon, created on first use and unref'd: one descriptor in total, not one per launched workspace.
* Rights attach to the FIRST `sendmsg` of a message only. If the kernel accepts just part of a line, the rest is sent without rights, so on a
  stream the descriptors belong to the first byte of their line and to nothing after it. The receiver attributes them to the line that starts at the
  first byte of the chunk they arrived with. (macOS refuses to send two rights items in one message; a receiver refuses a second one anyway.)
* The child of `spawnWithChannel` gets two locale variables (`LC_ALL=C`, `LANG=C`) and nothing of the daemon's environment.

## 5. L2: launcher and worker (envelopes)

16 byte header: `"WEV1"`, `u8 version = 1`, `u8 kind`, `u16 flags = 0`, `u32 seq` (from 1, +1 per direction), `u32 payload length`.

| kind | name | direction | payload | descriptors |
| --- | --- | --- | --- | --- |
| 1 | `scope` | launcher to worker | 512 bytes | none |
| 2 | `volumes` | launcher to worker | 104 bytes | exactly 2 |
| 3 | `drain` | launcher to worker | 28 bytes | none |
| 4 | `status` | worker to launcher | 40 bytes | none |
| 5 | `fault` | worker to launcher | 8 bytes | none |

* `scope` payload: five 64-byte NUL-padded ASCII fields `workspaceId, incarnationId, controllerInstanceId, workerInstanceId,
  admissionId` (offsets 0, 64, 128, 192, 256); `runtimeImageDigest` as 32 raw bytes at 320; `u64 leaseEpoch` at 352;
  `u32 vcpus` at 360; `u32 memoryMiB` at 364; reserved zero from 368 to 511. A name that fills its field (no NUL), is empty or has
  any non-zero byte after its NUL is refused.
* `volumes` payload: `u32 recordVersion = 1`, `u32 reserved = 0`, `scopeDigest` 32 raw bytes, then two 32 byte identity records
  (data at 40, environment at 72): `u64 device`, `u64 inode`, `u64 capacityBytes`, `u32 uid`, `u32 mode`. This generalises the
  fixture's 72 byte pair record (commit `9a588735`), which had no scope binding.
* `drain` payload: `stopNonce` 16 raw bytes, `u32 budgetMs`, `u32 origin` (1 `host-stop`, 2 `owner-loss`), `u32 reserved`.
* `status` payload: `u32 state` (1 `sandboxed`, 2 `volumes_accepted`, 3 `vm_running`, 4 `guest_hello`, 5 `draining`, 6 `drain_acked`,
  7 `guest_halted`, 8 `exiting`), `u32 reserved`, then `u64 requested, u64 completed` flush counters for data and environment.
* `fault` payload: `u32 code` (1 `bad_scope`, 2 `bad_volumes`, 3 `sandbox_failed`, 4 `vm_failed`, 5 `mux_violation`,
  6 `truncated_rights`, 7 `internal`, 8 `second_drain`), `u32 reserved`. A second DRAIN envelope is answered with FAULT `second_drain` and
  otherwise ignored: the first DRAIN's nonce and budget stand, and a later one can neither replace nor extend them.

### The worker process (final for N2)

* argv is exactly `[path]`; the environment is the launcher's two variables (`LC_ALL=C`, `LANG=C`).
* Descriptor **3** is the L2 end (an unnamed `AF_UNIX SOCK_DGRAM` socketpair), descriptor **4** is the L3 end (an unnamed
  `AF_UNIX SOCK_STREAM` socketpair). Descriptors 0 to 2 are the launcher's business; every other descriptor is closed at start.
* The guest boot artifacts are `<directory of the worker executable>/cowork-guest/kernel` and `.../cowork-guest/initramfs.cpio`.
* Exit codes: `0` ok, `2` usage, `70` sandbox, `71` bad scope, `72` bad volumes, `73` VM failed, `74` mux quarantine, `75` drain timeout,
  `76` intake timeout, `78` internal, `79` rights (a truncated or unexpected descriptor: terminal and silent). `77` is libkrun's own fatal
  stop and is never used by the worker. Only `0` can accompany a Class A receipt.
* `runtimeImageDigest` covers the guest boot artifacts and nothing else: the SHA-256 (lowercase hex) of the 64 bytes
  `SHA-256(kernel) || SHA-256(initramfs.cpio)`, each part the RAW 32 byte digest of that file. The data and environment disks are not
  covered. The daemon never hashes files: it learns the value from the image-pin port, and a launcher or worker that recomputes it and
  finds another value refuses the scope (`code_identity_mismatch` for the launcher, exit `71` for the worker). Pinned by `runtime-image.json`.

The worker keeps the fixture's fail-closed intake: it admits only an unnamed inherited `SOCK_DGRAM` control socket, installs its
sandbox BEFORE it reads anything, accepts exactly one rights item with exactly two descriptors, and on a truncated control buffer
exits at once without acknowledging. Process exit is descriptor cleanup, never a release.

## 6. Mux frames (L3 and L4)

16 byte header: `"WMX1"`, `u8 version = 1`, `u8 class`, `u16 flags = 0`, `u32 seq`, `u32 payload length`. `seq` starts at 1 and
rises by exactly 1 per (class, direction); a gap, a repeat or a rewind is a protocol violation and ends the stream.

| class | value | payload | who terminates it |
| --- | --- | --- | --- |
| `control` | 0 | JSON, at most 4 KiB | worker and guest only |
| `bootstrap` | 1 | JSON, at most 256 KiB | daemon and guest (relayed blind by launcher and worker) |
| `runtime` | 2 | opaque bytes, at most 1 MiB | daemon and guest; the guest runtime transport rides here |
| `provider` | 3 | none: **RESERVED** | nobody. A frame of this class is refused at the header by every parser, in both directions. |

Control and bootstrap payloads are the JSON object WITHOUT a trailing newline, keys `v`, `t`, then:

| class, direction | `t` | keys after `v`,`t` |
| --- | --- | --- |
| control, down | `drain` | `stopNonce`, `budgetMs`, `origin` (`host-stop` or `owner-loss`) |
| control, down | `ping` | `n` |
| control, up | `drain_ack` | `stopNonce` |
| control, up | `halting` | `stopNonce` |
| control, up | `pong` | `n` |
| bootstrap, up | `hello` | `guestBootId`, `dataSerial` (`winter-data`), `environmentSerial` (`winter-environment`) |
| bootstrap, down | `plan` | `operationId`, `nonce`, `plan` (a protocol 3 `VolumeFilesystemPlan`, sorted keys) |
| bootstrap, up | `receipt` | `operationId`, `nonce`, `receipt` (a `VolumeFilesystemReceipt`, sorted keys) |
| bootstrap, up | `fault` | `operationId`, `nonce`, `code` (`bad_plan probe_failed format_failed replay_failed mount_failed internal`) |
| bootstrap, down | `ready` | `operationId`, `nonce` |
| bootstrap, up | `mounted` | `operationId`, `nonce` |

On L1 a mux frame travels as `{"v":1,"t":"mux_down","frame":"<base64>"}` or `mux_up`: the base64 is canonical (re-encoding must
reproduce it) and the frame inside must itself be exact. A carrier holds a bootstrap or runtime frame only.

The `nonce` of a bootstrap exchange is 16 fresh random bytes chosen by the host per plan. A receipt that does not echo the
operation and nonce of the plan in flight is not that plan's receipt. The mux payload bound for `runtime` is the existing
`GUEST_RUNTIME_TRANSPORT_LIMITS.frameBytes`.

## 7. Stop evidence

Two classes, kept apart by type. Both are single canonical JSON lines (the exact text the launcher fsyncs and embeds in `stopped`
and `uncertain`).

**Class A, orderly**: keys `v, class("A"), confirmationId, stopNonce, origin(host-stop | owner-loss-drain), launcherInstanceId, admissionId,
homeId, workspaceId, incarnationId, leaseEpoch, controllerInstanceId, workerInstanceId, runtimeImageDigest, hostBootId, guest{drain,powerOff},
worker{pid,startToken,exit("code"),status(0),reaped(true)}, volumes[2]{purpose,device,inode,capacityBytes,attached,flushRequested,flushCompleted,finalFlush},
issuedAtMs`. The chain it attests: the guest halted through a `drain` frame and a power-off, libkrun exited, the launcher's
`waitpid` confirmed the exit of the process it owns, and the worker's flush receipt shows every requested flush completed and a
final flush after power-off. It is valid only when all of these hold (`classAInvariantsHold`): the worker exited by itself with code 0 and
was reaped (`exit = code`, `status = 0`, `reaped = true`; the libkrun exit hook reported reason `off`, never `reset`, `vcpu-error` or
`terminal-fault`); `guest.drain = acked` exactly when `guest.powerOff = observed`; both volumes attached or neither; an attached entry has `finalFlush = completed`, `flushRequested = flushCompleted`,
a non-zero `capacityBytes`, and zero counters when the guest never booted (it wrote nothing); an unattached entry has `finalFlush = not-attached`,
both counters zero, and `device`, `inode` and `capacityBytes` all `0` (the launcher cannot name a file it never received). An attached entry names
the exact file the daemon sent. **`not-booted` means "the worker never sent a `vm_running` status"**, and `unattached` means "the worker never
accepted the two descriptors". A daemon that observed either event (`worker_state vm_running`, `volumes_accepted`, or the guest `hello`) refuses
a live receipt that says the opposite (`not_orderly`): the receipt cannot know less than the daemon saw. A launcher that cannot state
all of this emits Class B instead. `stopNonce` is the daemon's nonce from `stop` (`origin = host-stop`) or a launcher-minted one
(`origin = owner-loss-drain`). The launcher writes the receipt to its durable store and fsyncs BEFORE sending it, and keeps it until
the daemon sends `receipt_retire`.

**Class B, uncertain**: keys `v, class("B"), launcherInstanceId, admissionId, workspaceId, incarnationId, leaseEpoch, workerInstanceId, reason,
worker{pid,startToken,exit(code|signal|unknown),status}, attachedVolumes, issuedAtMs`, with `reason` one of `daemon-lost drain-timeout
worker-killed worker-crashed guest-fault flush-uncertain channel-eof launcher-fault`. It has no confirmation id, no nonce and no
volume list: nothing in it can be turned into a release.

Release policy (decision D1, conservative default). Ownership of the two disks is retained after ANY crash. Only these can release:

1. a Class A receipt that parses, satisfies its invariants and binds to the exact owner, volumes, nonce and live (or retained) launcher;
2. a changed host boot id that the host probe confirms really ended the previous boot;
3. an explicit owner `recover` input behind a port (`CoworkNativeOwnerRecoverPort`, unwired), plus two agreeing guard probes
   (process absent by pid, start token and boot id; images unlocked). The guards are never load-bearing on their own.

A PID that vanished, a socket EOF, a closed descriptor, a launcher that exited, a worker that exited with any status and a Class B
receipt NEVER release. All of the above live in one table in `stop-proof.ts`, so a different D1 ruling is a small change.

## 8. Libkrun production ABI (names and signatures only)

These replace the `*_fixture_*` entry points of the pinned fixture library (commit `9a588735`, libkrun `227b2de`). S3 links them,
S4 exports them. The fixture names stay behind a cfg in S4 as a regression oracle and are unreachable from the production worker.

```c
struct krun_cowork_volume_identity { uint64_t device; uint64_t inode; uint64_t capacity_bytes; uint32_t uid; uint32_t mode; }
struct krun_cowork_flush_counters_v1 { uint64_t data_requested; uint64_t data_completed; uint64_t environment_requested; uint64_t environment_completed; }
enum krun_cowork_exit_reason { KRUN_COWORK_EXIT_OFF = 0, KRUN_COWORK_EXIT_RESET = 1, KRUN_COWORK_EXIT_VCPU_ERROR = 2, KRUN_COWORK_EXIT_TERMINAL_FAULT = 3 }

int32_t krun_cowork_enable_profile_v1(uint32_t ctx_id)
int32_t krun_cowork_set_workspace_disks_v1(uint32_t ctx_id, int32_t data_fd, const struct krun_cowork_volume_identity *data, int32_t environment_fd, const struct krun_cowork_volume_identity *environment)
int32_t krun_cowork_create_runtime_port_v1(uint32_t ctx_id)
int32_t krun_cowork_validate_profile_v1(uint32_t ctx_id)
int32_t krun_cowork_get_flush_counters_v1(uint32_t ctx_id, struct krun_cowork_flush_counters_v1 *out)
int32_t krun_cowork_set_exit_hook_v1(uint32_t ctx_id, void (*hook)(void *user, int32_t reason), void *user)
```

| New symbol | Replaces | Notes |
| --- | --- | --- |
| `krun_cowork_enable_profile_v1` | `krun_enable_cowork_block_fixture_reclaim` | refuses anything outside 2 vCPU and 768 to 1024 MiB (the reviewed gate) |
| `krun_cowork_set_workspace_disks_v1` | `krun_set_cowork_workspace_disks` | same atomic two-disk intake: 16 MiB to 256 GiB, 4096-aligned, same-inode aliases refused |
| `krun_cowork_create_runtime_port_v1` | `krun_create_cowork_runtime_stream` | ONE generic virtio-console port, a BYTE stream; the caller owns only the returned opposite peer. The mux framing (section 6) sits above libkrun's byte port, in the worker, so no libkrun symbol is named after a mux |
| `krun_cowork_validate_profile_v1` | none | MANDATORY preflight: the side-effect-free application of the admission `krun_start_enter` applies. The worker calls it after all configuration and before `krun_start_enter`, and starts no VM on a non-zero result |
| `krun_cowork_get_flush_counters_v1` | none | the counters behind the receipt |
| `krun_cowork_set_exit_hook_v1` | none | called on the VMM exit path after the block devices' final flush and before the process exits, with the reason the VMM is leaving: `off` (a guest power-off), `reset`, `vcpu-error` or `terminal-fault`. Only `off` can lead to a Class A receipt |

Retired with no production equivalent: `krun_enable_cowork_runtime_port_fixture_trace`, `krun_create_cowork_bootstrap_stream`,
`krun_set_cowork_bootstrap_stream`. **Not admitted: `krun_get_shutdown_eventfd`** (the PL061 GPIO shutdown device). The device
inventory is unchanged: two virtio-blk disks, one generic virtio-console port, PL011 output; no network device, no vsock, no
virtiofs, no GPU, no input device. Stop is a `drain` control frame, then a guest power-off.

## 9. Sequences

Start: `beginIncarnation` (stopped to starting, epoch + 1); admission `reserve`; spawn the launcher; `hello`; `begin`; `begun`;
`claim` (owner persisted BEFORE any descriptor exists); `prepareFilesystems` (intent committed); `open` data and environment;
`volumes` line with the two descriptors; `volumes_accepted`; close the daemon's copies (closing is not release); guest `hello`;
`plan` with a fresh nonce; guest `receipt`; `confirmFilesystems` with a sealed receipt proof; `ready`; guest `mounted`; power
`running`, admission `running`.

Stop: `stop` with a fresh nonce; DRAIN envelope; `drain` control frame; guest `drain_ack`, `halting`, power-off; exit hook; worker
`status guest_halted` with counters; worker exit 0; Class A receipt; `stopped`; the daemon verifies it, calls `volumes.release`, then
admission `release`, then moves power to `stopped`, then `receipt_retire`.

Owner loss (the daemon vanished): the launcher sees EOF on L1, sends a DRAIN envelope with `origin = owner-loss` and its own nonce,
waits at most the 30 second budget, then kills ONLY the handle of the worker it owns (never a recorded PID) and writes Class B; if the
drain completed it writes a Class A with `origin = owner-loss-drain`. Either way the receipt is durable. The next daemon decides.

## 10. What is deliberately not decided here

* D4 (who owns the agent-SDK relay), D7 (where the libkrun patches live), D10 (host-backed shares and the provider bridge) are open.
  Nothing in this contract needs one particular answer; the provider class is reserved and empty.
* The `allocate` action of `CoworkVolumeAuthority` is refused by the native authority: provisioning is not on the launch path.
* Authentication of a retained receipt that is read back from the launcher's durable store is the launcher slice's design (S2). The
  adapter accepts such a receipt only through a port that must attest it; file presence alone is never proof.
* Sleep and wake have NO L1 line in this version (controller ruling): the launcher records power events and sends nothing. Free-space admission and the guest side are other slices.

## 11. The host adapter

`packages/core/src/cowork/native/` holds the TypeScript side: `protocol.ts` (this contract), `host.ts` (`CoworkNativeHost`: start, stop, recover),
`authority.ts` (both volume authority ports over sealed proofs minted from a live channel binding), `power.ts` (compare-and-set `power`
transitions), `stop-proof.ts` (the D1 release policy and the sealed stop proofs), `recovery.ts` (boot reconcile and the shared release
flow), `fd-channel.ts` and `fd-receiver-worker.ts` (descriptor passing). Every collaborator is an injected port: the launcher (`CoworkLauncherPort`),
the image pin (`CoworkNativeImagePins`, to be bound to `CoworkImagePins.assertPinned`), the host boot (`CoworkNativeHostBoot`), the launcher's
retained receipts (`CoworkNativeDurableReceiptPort`) and the owner's recover input (`CoworkNativeOwnerRecoverPort`, with its two guard probes).
Nothing in `src/` implements or imports them; an anti-wiring test pins that.

The host runs: `beginIncarnation`, admission `reserve`, launcher spawn, `begin`, `claim`, `prepareFilesystems`, `open` x 2, the `volumes` line
with the two descriptors, the bootstrap exchange (`plan` with a fresh nonce, `receipt`), `confirmFilesystems`, `ready`, `mounted`, then `power`
`running` and admission `running`. A failure after the worker exists is answered with a `stop`; only a valid orderly receipt for THAT request
releases, anything else leaves the workspace and its admission `uncertain` with the owner retained. Release order is volumes, admission,
power, then the proof is spent; each step is idempotent and re-derives its evidence, so a crash between any two is finished by the next run.
While a launch lives the host keeps the admission row alive with a heartbeat from the reserve until the run is disposed (the ledger expires a silent
owner after 30 s), and a stop reads the row's REAL state before it moves it, so a row the ledger marked lapsed is revived rather than wedging the stop.
A stop request is always sent and the run always disposed, whatever the bookkeeping did. A receipt may not know less than the daemon saw: after
`volumes_accepted` an `unattached` receipt, and after a running VM or a guest `hello` a `not-booted` one, is refused on the live path.

The **launch journal** (`CoworkNativeLaunchJournalPort`, durable, outside the runtime-state schema) records, keyed by (workspace, incarnation, epoch): the
host boot id, then before the spawn that a launch started, then the launcher's pid, start token and instance id, then the worker's pid and start token
from `begun`. Owner recovery hands it to the guard probes as `subject.processes`, because a pid alone is reused after a daemon crash and absence has to be
shown for an identity. A journal entry with no launcher identity (the spawn was requested and its result never written) makes owner recovery refuse; no
entry at all means this daemon started no launcher for that incarnation. The entry is forgotten after the release.

**Retained receipts and the launcher's store (S2).** The launcher keeps a Class A receipt in a write-once, 0600 file per scope,
`<workspaceId>.<incarnationId>.<epoch>.receipt`, in a user-level directory outside the Winter home that the daemon names with `--receipt-dir`, until
`receipt_retire`. `CoworkNativeDurableReceiptPort` is the daemon's reading end of exactly that store: `load(scope)` returns the file's text
(the exact receipt line) and `retire(scope)` removes it, both keyed by the same triple. The port must also say `attested`; a file in a same-user directory
proves nothing by itself, and the open question of how the launcher's store is attested (S2's options: the owner-recover guard probes also for a
retained receipt, a MAC with a Keychain key, or a launcher-served read) stays with the controller. The adapter ignores any record the port does not attest.

Boot reconcile runs `CoworkAdmissionLedger.reconcile()` first, then settles every workspace that is not `stopped`. A replay debt (an interrupted
journal replay) names a previous writer; the next incarnation proves THAT writer stopped from memory, from the boot id inside its owner tuple, or
from the launcher's retained receipt, which is therefore kept until the debt is settled.
