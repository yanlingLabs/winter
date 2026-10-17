# Cowork native worker: wire contract and host adapter

Status: contract, N2 slice S1, 2026-10-16 (round 3, 2026-10-17: conversation-set delivery, runtime streams, guest faults, `halting`, the layered stop timeline). SOURCE ONLY. Nothing in this document or in `packages/core/src/cowork/native/`
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

* JSON texts are UTF-8, exactly one line, last byte `\n`, no whitespace, integers only, `null` only where a table says so. Control and bootstrap payloads (the mux classes, section 6) are printable ASCII only: a character outside 0x20 to 0x7e makes the payload malformed, and the guest's helper refuses it too.
* Keys appear in EXACTLY the order of the tables below (`v`, then `t`, then the table order). A parser builds the typed value and
  re-serializes it; the result must equal the input byte for byte. That one comparison refuses duplicate keys, reordered keys,
  alternate escapes, alternate number spellings, and trailing data. Every positive vector exercises the order; the negative
  vectors include reordered keys, whitespace, duplicate keys and float spellings.
* A UTF-8 byte order mark is malformed: it is never skipped, on an L1 line or in a mux payload (negative vectors `bom-line`, `bom-mux`, `bom-mux-bootstrap`).
* Free-form nested objects (a filesystem plan or receipt inside a bootstrap frame) use recursively SORTED keys (UTF-16 code unit order).
* Binary formats are little-endian. Every reserved byte is zero. All endpoints (macOS arm64 host, Linux arm64 guest) are
  little-endian, which is why no byte-swapping is specified.
* Identifier tokens are `[A-Za-z0-9][A-Za-z0-9_-]{0,62}` (at most 63 characters, so they fit a NUL-padded 64 byte field). Label
  tokens additionally allow `.` and `:`. A digest is 64 lowercase hex characters, a stop nonce 32 lowercase hex characters
  (16 random bytes).
* `device` and `inode` are decimal strings, because they are `u64` and JSON numbers are not. Capacities are JSON integers.
* Limits: control line 16 KiB; mux carrier line 1,572,864 bytes; mux payload control 4 KiB, bootstrap 256 KiB (the `conversations` message at most 20 KiB), runtime 1 MiB (the 4 byte stream prefix included)
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
| `worker_state` | `state` | informational: `sandboxed volumes_accepted vm_running guest_hello draining drain_acked exited halting guest_fault`. `halting` and `guest_fault` mirror the L2 statuses of section 5 (the guest said it is halting; the guest said it is failing). Never evidence of a release; a daemon that has seen `guest_fault` refuses an orderly receipt for that run (section 7). |
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
  7 `guest_halted`, 8 `exiting`, 9 `halting`, 10 `guest_fault`), `u32 reserved`, then `u64 requested, u64 completed` flush counters for data and environment.
  `halting` is reported when the guest's control-up `halting` arrives AFTER its `drain_ack` and carries the drain's nonce; `guest_fault` when a control-up `fault` arrives (section 6).
  `guest_halted` comes from the libkrun exit hook and from nowhere else (section 8); the worker reports it ONLY when the hook's reason is `off` and both attached disks
  show `final_sync_completed = 1`. Otherwise it reports `exiting` alone, and the launcher must not issue a Class A.
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
  stop and is never used by the worker. Only `0` can accompany a Class A receipt, and `0` alone proves nothing: libkrun's exit watchdog ends the process with the
  same status after skipping the hook, so a Class A also needs the hook-originated `guest_halted` status with its counters (section 7).
* `runtimeImageDigest` covers the guest boot artifacts and nothing else: the SHA-256 (lowercase hex) of the 64 bytes
  `SHA-256(kernel) || SHA-256(initramfs.cpio)`, each part the RAW 32 byte digest of that file. The data and environment disks are not
  covered. The daemon never hashes files: it learns the value from the image-pin port, and a launcher or worker that recomputes it and
  finds another value refuses the scope (`code_identity_mismatch` for the launcher, exit `71` for the worker). Pinned by `runtime-image.json`.

### The stop timeline (layered)

Every figure is measured from the moment the worker receives the DRAIN envelope. A figure may never be smaller than the one before it; `COWORK_NATIVE_LIMITS`
and the two functions beside it in `protocol.ts` hold the numbers, and a test pins their order.

| Layer | Name | Value | Meaning |
| --- | --- | --- | --- |
| G | guest budget | `budgetMs` of the DRAIN (default 30 s, at most 120 s) | the guest powers off within it; PID 1 spends it on the supervisor, the helper, the unmounts and the final `halting`. The worker exits `75` (`drain_timeout`) at G if the guest has not powered off. |
| X | VMM exit path | up to 20 s after the power-off | libkrun's `cowork_exit` runs every exit observer (both disks' final flush) and then the exit hook; a watchdog thread ends the process after 20 s with the same status and skips what is left, the hook included. |
| K | launcher kill | G + 20 s + 5 s | the launcher kills only the handle of the worker it owns, never before X's watchdog could have fired. A worker that is still alive at K is Class B. |
| H | daemon wait | K + 10 s | how long the daemon waits for the verdict of one `stop`. A wait that ends sooner leaves the workspace `uncertain` and the launcher's retained receipt for boot reconcile. |

For the default budget: G 30 s, K 55 s, H 65 s. The launcher's owner-loss drain follows the same table.

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
| control, up | `fault` | `code` (`unmount_failed supervisor_lost protocol_violation internal`), `stopNonce` (the drain it belongs to, or `null`) |
| bootstrap, up | `hello` | `guestBootId`, `dataSerial` (`winter-data`), `environmentSerial` (`winter-environment`) |
| bootstrap, down | `plan` | `operationId`, `nonce`, `plan` (a protocol 3 `VolumeFilesystemPlan`, sorted keys) |
| bootstrap, up | `receipt` | `operationId`, `nonce`, `receipt` (a `VolumeFilesystemReceipt`, sorted keys) |
| bootstrap, up | `fault` | `operationId`, `nonce`, `code` (`bad_plan probe_failed format_failed replay_failed mount_failed internal bad_conversations supervisor_failed second_conversations`) |
| bootstrap, down | `ready` | `operationId`, `nonce` |
| bootstrap, up | `mounted` | `operationId`, `nonce` |
| bootstrap, down | `conversations` | `operationId`, `nonce`, `incarnationId`, `profile`, `conversations` (section 6.1) |
| bootstrap, up | `runtime_ready` | `operationId`, `nonce`, `conversations` (how many the supervisor now serves, 1 to 16) |

On L1 a mux frame travels as `{"v":1,"t":"mux_down","frame":"<base64>"}` or `mux_up`: the base64 is canonical (re-encoding must
reproduce it) and the frame inside must itself be exact. A carrier holds a bootstrap or runtime frame only.

The control-up `fault` terminates at the worker like every control frame: the guest is failing (`unmount_failed` an unmount did not complete clean, `supervisor_lost` the tool
supervisor died after it was ready, `protocol_violation` the guest refused something the host sent, `internal`). The worker reports it as the L2 status `guest_fault` (state 10)
and from then on treats any `halting` as a violation: **after a `fault`, no Class A can exist for that run.** The guest powers off afterwards; the host never has to read the code.
The bootstrap `fault` is different: it answers one bootstrap exchange (a plan, or the conversation set) and reaches the daemon, which treats the start as failed. After either fault the
guest stays up and waits for `drain`.

The `nonce` of a bootstrap exchange is 16 fresh random bytes chosen by the host per plan. A receipt that does not echo the
operation and nonce of the plan in flight is not that plan's receipt. The mux payload bound for `runtime` is the existing
`GUEST_RUNTIME_TRANSPORT_LIMITS.frameBytes`, the 4 byte stream prefix of section 6.2 included.

### 6.1 The conversation set (bootstrap, host to guest)

The guest's tool supervisor (`packages/runtime/src/guest/linux-supervisor.py` of the agent SDK, main `093fb3ea`) refuses an empty conversation set, so PID 1 starts it
only when a set has been delivered. The set is one bootstrap-class message, **sent at most once per incarnation**, after `mounted` (hence after `ready`), echoing the
plan's `operationId` and `nonce` and naming the incarnation. The guest answers `runtime_ready` (the trusted config is written, the supervisor reached ready, runtime frames are
delivered now) or a bootstrap `fault`: `bad_conversations` (the set does not match the plan the guest holds, or the supervisor refused it), `supervisor_failed` (it did not
reach ready), `second_conversations` (a second set arrived: it is ignored and the first stands, as a second DRAIN is). **The set is fixed for the incarnation in N2**; it
cannot be re-sent, extended or replaced while the guest runs. A host that wants another conversation stops the workspace and starts the next incarnation.

`profile` is `null` (tools only: every conversation has `runtime: null`), `host-query-v1` or `host-query-guided-v1` (every conversation has a `runtime`; `guided` is non-null
exactly for the guided profile). The `fresh` profile is not carried: it has no duplex transport. The message holds at most 16 conversations and is at most 20 KiB (20,480 bytes).

**N2 limit (D10): at most ONE host-query conversation per guest.** A message with a non-null `profile` holds exactly one conversation (`coworkNativeConversationsAreBound` and the parser refuse
more); the runtime class has a single duplex stream set, and the guest's supervisor (agent SDK PR 30, `cowork/n2-guest-relay`, head `ed228f39`) exits 64 on a second host-query conversation. The runtime stream
index is therefore always 0 (`CoworkNativeRuntimeStreams` takes exactly 1). The prefix keeps the index byte so a later version can lift the limit without changing the frame.

**Authentication and binding.** There is no signature: the channel is the authority (the mux link is the guest's only host path, and its far end is the launcher's worker). The message is accepted only if it echoes the
`operationId` and `nonce` of the plan the guest holds, and only after `ready` was answered by `mounted`, so a guest that never received a plan, or a replay of an older set, cannot be started. The acknowledgement is
`runtime_ready` (below) bound to the same pair, or a bootstrap `fault`.

**The supervisor's command line and ready line are the SDK's, not a second spelling:** PID 1 starts `linux-supervisor.py --trusted-config-fd N [--runtime-ports-fds IN,OUT,ERR]` in that order and no other,
the numbers canonical decimals at least 3 and distinct (anything else exits 64); `IN` is a FIFO the supervisor reads, `OUT` and `ERR` FIFOs it writes, the relay owning the virtio-console port is their far end. With no
host-query conversation the port descriptors are not passed. The supervisor's ready line is exactly `{"fullGuestExecutionEnabled":false,"ready":true}`; the guest sends `runtime_ready` only after reading it.

**The environment disk is NOT mounted in N2.** It is attached, probed and formatted like the data disk, and its flushes and final sync are in the receipt, so a Class A covers both disks; but nothing consumes it under D10
(the supervisor's `/opt/winter/environment/base` is a static read-only base inside the initramfs, not this disk), so PID 1 mounts nothing at `/opt/winter/environment/disk`. The mount is added in the slice that has a consumer.

**Payload ceiling.** The guest's relay refuses a bootstrap-down payload above 20,480 bytes (guest-local); the class ceiling stays 262,144 for the guest's own receipts. A plan is about 1.7 KiB and its schema caps it at 16 KiB,
so the conversation set is the only message with a cap of its own.

| Conversation key | Value |
| --- | --- |
| `logicalSessionId` | the supervisor's id: `[A-Za-z0-9][A-Za-z0-9_.-]{0,127}` |
| `authority` | `workspaceId, sessionId` (the backend session), `incarnationId, leaseEpoch` (1 to 2^32-1), `configRevision, grantRevision, policyRevision` |
| `runtimeUid`, `toolUid`, `workspaceGid` | 1000 to 65535; every `runtimeUid` and `toolUid` of the set distinct, and no `workspaceGid` equal to any `runtimeUid` (the supervisor's own rules) |
| `policy` | `auto plan ask accept-edits dont-ask bypass` |
| `roots` | 1 to 16 of `id, guestPath, source, readOnly`; ids and views distinct, no view inside another; `guestPath` is one of `/workspace/folders/<name>[/...]`, `/workspace/repos/<name>[/...]`, `/workspace/.winter/memory`, `/workspace/.winter/scratch/<logicalSessionId>`, `/workspace/outputs/<logicalSessionId>`; `source` is a canonical absolute path under `/workspace/` (no `.`, `..` or empty component, at most 1024 bytes) |
| `runtime` | `null`, or `model` (1 to 256 characters), `timeoutMs` (1 to 600000), `toolClasses` (a subset of `read write execute`, in that order), `provider`, `guided` (`null`, or `bindingId` a version 4 UUID and `generation` 1 or more) |

`provider` is public metadata only: `{scope, selection}` with recursively sorted keys, at most 4 KiB. `scope` has exactly `accountRevision backendSessionId bootId grantRevision homeId
incarnationId leaseEpoch modelRevision sessionId taskId workspaceId`; `selection` has `capabilities family modelKey protocol providerId providerModelId` and optionally
`continuationDomain`. Its `workspaceId`, `sessionId` (= `logicalSessionId`), `backendSessionId` (= `authority.sessionId`), `incarnationId`, `leaseEpoch` and `grantRevision` equal the conversation's, its `modelKey` equals
`model`, and `bootId` is the guest's live boot id from its `hello` (the same in every conversation). No key at any depth may contain `authref`, `url`, `header`, `secret`, `token` or `credential` (any case).
A host-query conversation sees folders, repos and outputs only (never the `.winter` tree), and under `plan` every root is read-only.

The wire carries what the host decides or knows. **PID 1 adds what only the guest knows** and splices the result into its trusted config: `guestBootId`, the artifact pins, the control
and environment directories, and per conversation `storeDirectory` = `/workspace/.winter/conversations/<logicalSessionId>` and `runhomeDirectory` = `/run/winter/conversations/<logicalSessionId>`
(created root-side, owned by `runtimeUid`, mode 0700). The uids and the gid are the host's pick inside the supervisor's range; the supervisor remains the admission authority and re-checks
all of it (this message is a shape and consistency check, not an admission).

Binding: the sender refuses to send, and the guest to start, unless `operationId` and `nonce` are the plan's, `incarnationId` is the incarnation, every `authority.{workspaceId, incarnationId, leaseEpoch}`
is the scope's, and the providers' `bootId` is the guest's `hello`. `coworkNativeConversationsAreBound` is that comparison.

### 6.2 Runtime streams

A runtime-class payload is a 4 byte prefix and then the stream's bytes. The prefix is in the PAYLOAD, not the header: the header's flags stay zero and the launcher and worker, which relay runtime
frames without reading them, change nothing.

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | `conversation`: index into the delivered `conversations` list, 0 to 15 |
| 1 | 1 | `stream`: 1 = IN (host to guest), 2 = OUT (guest to host), 3 = ERR (guest to host); 0 and 4 or more are refused |
| 2 | 1 | flags: bit 0 = this is the end of that stream after these bytes; every other bit zero |
| 3 | 1 | reserved, zero |

A conversation's three streams are the supervisor's `RuntimeDuplexPorts` input, stdout and stderr (ERR is carried, not dropped). IN travels only down; OUT and ERR only up (anything else is `bad_direction`). An empty data section
is valid only with the end flag. After a stream's end nothing more may arrive on it, and a conversation index outside the delivered set is refused (`CoworkNativeRuntimeStreams` is that state). Data is
limited by the payload bound, 1 MiB minus 4 bytes; a sender uses chunks of at most 256 KiB (the host's own chunk limit). Frames of this class are delivered only after `runtime_ready`.

## 7. Stop evidence

Two classes, kept apart by type. Both are single canonical JSON lines (the exact text the launcher fsyncs and embeds in `stopped`
and `uncertain`).

**Class A, orderly**: keys `v, class("A"), confirmationId, stopNonce, origin(host-stop | owner-loss-drain), launcherInstanceId, admissionId,
homeId, workspaceId, incarnationId, leaseEpoch, controllerInstanceId, workerInstanceId, runtimeImageDigest, hostBootId, guest{drain,halting,powerOff},
worker{pid,startToken,exit("code"),status(0),reaped(true)}, volumes[2]{purpose,device,inode,capacityBytes,attached,flushRequested,flushCompleted,finalFlush},
issuedAtMs`. The chain it attests: the guest halted through a `drain` frame and a power-off, libkrun exited, the launcher's
`waitpid` confirmed the exit of the process it owns, and the worker's flush receipt shows every requested flush completed and a
final flush after power-off. It is valid only when all of these hold (`classAInvariantsHold`): the worker exited by itself with code 0 and
was reaped (`exit = code`, `status = 0`, `reaped = true`; the libkrun exit hook reported reason `off`, never `reset`, `vcpu-error` or
`terminal-fault`); `guest.drain = acked`, `guest.halting = observed` and `guest.powerOff = observed` stand or fall together (all three, or `not-booted` for all three); both volumes attached or neither; an attached entry has `finalFlush = completed`, `flushRequested = flushCompleted`,
a non-zero `capacityBytes`, and zero counters when the guest never booted (it wrote nothing); an unattached entry has `finalFlush = not-attached`,
both counters zero, and `device`, `inode` and `capacityBytes` all `0` (the launcher cannot name a file it never received). An attached entry names
the exact file the daemon sent. **`not-booted` means "the worker never sent a `vm_running` status"**, and `unattached` means "the worker never
accepted the two descriptors". A daemon that observed either event (`worker_state vm_running`, `volumes_accepted`, or the guest `hello`) refuses
a live receipt that says the opposite (`not_orderly`): the receipt cannot know less than the daemon saw. A launcher that cannot state
all of this emits Class B instead.

**`halting` and the guest's part of a stop (round 3).** `guest.drain = acked` means the guest's control-up `drain_ack` AND `halting` both arrived, in that order, carrying the drain's nonce;
`guest.halting = observed` is the second of them on its own, so a receipt cannot claim an acknowledgement it did not see. **A bare power-off is Class B** (an uncertain disk state: ownership is retained and nothing is released, as for every Class B): a guest that powers off without
`halting` could not prove its filesystems unmounted clean (S5: any failed step, a dirty superblock, a mount that would not go) and is `guest-fault`; so is a `guest_fault` status at any time
(after one, no Class A can exist for the run), a power-off after `drain_ack` but before `halting`, a power-off with no `drain_ack`, and an exit reason of `reset` or `vcpu-error`. A drain that never
reached `drain_ack` is `drain-timeout`. A worker that exited without reporting `guest_halted` (the exit watchdog skipped the hook), a `terminal-fault` or `none` reason are `flush-uncertain`. The one
decision procedure is `coworkNativeGuestStopVerdict` in `protocol.ts` and the vectors in `guest-stop.json`; S2 and S3 carry their own drift test against them. **The launcher rule is normative:** `guest.drain = acked` exactly when `guest.powerOff = observed` (and `halting` with them). A worker may send `guest_halted` after a mux quarantine (exit 74) or without any `drain_ack`; the launcher must then
classify the stop as Class B (`guest-fault`), never Class A. The L2 `exiting` counters (flush requested and completed) are meaningful ONLY alongside `guest_halted`; in every uncertain stop they are informational and never feed a Class A.
Vectors: `guest-halted-after-mux-quarantine`, `guest-halted-without-drain-ack` in `guest-stop.json`. **A worker exit with status 0 proves
none of it.** A daemon that has seen `worker_state guest_fault` refuses an orderly receipt for that run (`not_orderly`) as it refuses one that knows less than it saw. `stopNonce` is the daemon's nonce from `stop` (`origin = host-stop`) or a launcher-minted one
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
struct krun_cowork_flush_device_v1 { uint64_t requested; uint64_t completed; uint64_t final_sync_attempted; uint64_t final_sync_completed; }
struct krun_cowork_flush_counters_v1 { uint32_t size; uint32_t device_count; struct krun_cowork_flush_device_v1 device[2]; }
struct krun_cowork_pin_counters_v1 { uint32_t size; uint32_t reserved; uint64_t max_pins; uint64_t max_pinned_bytes; uint64_t high_water_pins; uint64_t high_water_bytes; uint64_t budget_refusals; }
#define KRUN_COWORK_EXIT_NONE 0, KRUN_COWORK_EXIT_OFF 1, KRUN_COWORK_EXIT_RESET 2, KRUN_COWORK_EXIT_VCPU_ERROR 3, KRUN_COWORK_EXIT_TERMINAL_FAULT 4
typedef void (*krun_cowork_exit_hook_v1)(void *user_data, uint32_t reason)

int32_t krun_cowork_enable_profile_v1(uint32_t ctx_id)
int32_t krun_cowork_set_workspace_disks_v1(uint32_t ctx_id, int32_t data_fd, const struct krun_cowork_volume_identity *data, int32_t environment_fd, const struct krun_cowork_volume_identity *environment)
int32_t krun_cowork_create_runtime_port_v1(uint32_t ctx_id)
int32_t krun_cowork_validate_profile_v1(uint32_t ctx_id)
int32_t krun_cowork_get_flush_counters_v1(struct krun_cowork_flush_counters_v1 *out)
int32_t krun_cowork_set_exit_hook_v1(uint32_t ctx_id, krun_cowork_exit_hook_v1 hook, void *user_data)
int32_t krun_cowork_get_pin_counters_v1(struct krun_cowork_pin_counters_v1 *out)
```

| New symbol | Replaces | Notes |
| --- | --- | --- |
| `krun_cowork_enable_profile_v1` | `krun_enable_cowork_block_fixture_reclaim` | refuses anything outside 2 vCPU and 768 to 1024 MiB (the reviewed gate) |
| `krun_cowork_set_workspace_disks_v1` | `krun_set_cowork_workspace_disks` | same atomic two-disk intake: 16 MiB to 256 GiB, 4096-aligned, same-inode aliases refused |
| `krun_cowork_create_runtime_port_v1` | `krun_create_cowork_runtime_stream` | ONE generic virtio-console port, a BYTE stream; the caller owns only the returned opposite peer. The mux framing (section 6) sits above libkrun's byte port, in the worker, so no libkrun symbol is named after a mux |
| `krun_cowork_validate_profile_v1` | none | MANDATORY preflight: the side-effect-free application of the admission `krun_start_enter` applies. The worker calls it after all configuration and before `krun_start_enter`, and starts no VM on a non-zero result |
| `krun_cowork_get_flush_counters_v1` | none | the counters behind the receipt. Process-global (the context leaves the library's table when the VM starts; one VM runs per process), so it takes no context: `size` in and out, `device_count` 2, `device[0]` = `winter-data`, `device[1]` = `winter-environment`. A disk's `finalFlush` is `completed` only when its `final_sync_attempted` and `final_sync_completed` are both 1 |
| `krun_cowork_set_exit_hook_v1` | none | called once, on the exiting thread, after every other exit observer (the final flush of both disks included) and immediately before the process exits. It must not block and must not call any `krun_*` function except the counter getters. The reason is an ENUM (S4's header): `NONE` 0 is the unknown default and means "the hook never ran or no reason was recorded": it is never delivered in practice, never a power-off and never Class A (a zero-initialised or never-set reason must not read as orderly), and the type is `uint32_t`; `OFF` 1 a guest power-off; `RESET` 2; `VCPU_ERROR` 3; `TERMINAL_FAULT` 4. **A hook that tests `reason != 0` instead of `reason == OFF` treats every reason as orderly; only `OFF` can lead to a Class A receipt.** Hard crashes (a fatal signal) exit without observers or the hook |
| `krun_cowork_get_pin_counters_v1` | none | **optional diagnostics** (G4 reads the pin high-water mark with it). Process-global, `size` in and out. It feeds no receipt, no verdict and no decision of the worker, the launcher or the daemon, and a worker built without it still starts |

The exit path is bounded: every way a started VM ends goes through `cowork_exit`, which runs the observers once and then `_exit`s, and a watchdog thread ends the process with the same status after
**20 s**, skipping whatever is left, the hook included. That 20 s is layer X of the stop timeline (section 5): the launcher's kill (G + 25 s) is later than any moment the watchdog can fire, and
a guest that stopped cleanly (`off` or `reset`) exits with status 0 even if a late fault fires, which is why the exit code proves nothing about the receipt.

**A final-flush failure does not change libkrun's exit status.** The worker therefore reads `krun_cowork_get_flush_counters_v1` after the exit sequence (it stays readable after the hook) and the verdict
(`coworkNativeGuestStopVerdict`, with its `counters` input) is `uncertain` / `flush-uncertain`, never Class A, when any disk shows `completed < requested`, a `final_sync_attempted` or `final_sync_completed`
other than 1, or the counters could not be read. "Exit status 0 and no hook observed" (the 20 s watchdog fired after a clean power-off with a hung observer) is the same verdict: the worker reports `exiting`, never
`guest_halted`. **Contract invariant:** the guest's drain budget (default 30 s) is above the exit watchdog (20 s), and the launcher's kill (budget + 20 s + 5 s) is above both; `protocol.test.ts` pins the order.

Retired with no production equivalent: `krun_enable_cowork_runtime_port_fixture_trace`, `krun_create_cowork_bootstrap_stream`,
`krun_set_cowork_bootstrap_stream`. **Not admitted: `krun_get_shutdown_eventfd`** (the PL061 GPIO shutdown device). The device
inventory is unchanged: two virtio-blk disks, one generic virtio-console port, PL011 output; no network device, no vsock, no
virtiofs, no GPU, no input device. Stop is a `drain` control frame, then a guest power-off.

## 9. Sequences

Start: `beginIncarnation` (stopped to starting, epoch + 1); admission `reserve`; spawn the launcher; `hello`; `begin`; `begun`;
`claim` (owner persisted BEFORE any descriptor exists); `prepareFilesystems` (intent committed); `open` data and environment;
`volumes` line with the two descriptors; `volumes_accepted`; close the daemon's copies (closing is not release); guest `hello`;
`plan` with a fresh nonce; guest `receipt`; `confirmFilesystems` with a sealed receipt proof; `ready`; guest `mounted`; when the incarnation has conversations: `conversations` (once, bound to the plan's operation and nonce), the guest starts the
supervisor and answers `runtime_ready` (or a bootstrap `fault`), then runtime frames flow; power `running`, admission `running`.

Stop: `stop` with a fresh nonce; DRAIN envelope; `drain` control frame; guest `drain_ack`, then `halting` (only after every filesystem is unmounted and verified clean), power-off; exit hook; worker
`status guest_halted` with counters (only for reason `off` and a completed final sync on every attached disk); worker exit 0; Class A receipt; `stopped`; the daemon verifies it, calls `volumes.release`, then
admission `release`, then moves power to `stopped`, then `receipt_retire`.

Owner loss (the daemon vanished): the launcher sees EOF on L1, sends a DRAIN envelope with `origin = owner-loss` and its own nonce,
waits at most the stop timeline's kill deadline (section 5: the 30 second budget plus the 25 second exit allowance), then kills ONLY the handle of the worker it owns (never a recorded PID) and writes Class B; if the
drain completed it writes a Class A with `origin = owner-loss-drain`. Either way the receipt is durable. The next daemon decides.

## 10. What is deliberately not decided here

* D4 (who owns the agent-SDK relay), D7 (where the libkrun patches live), D10 (host-backed shares and the provider bridge) are open.
  Nothing in this contract needs one particular answer; the provider class is reserved and empty.
* The `allocate` action of `CoworkVolumeAuthority` is refused by the native authority: provisioning is not on the launch path.
* Authentication of a retained receipt that is read back from the launcher's durable store is the launcher slice's design (S2). The
  adapter accepts such a receipt only through a port that must attest it; file presence alone is never proof.
* Whether the host's `running` waits for `runtime_ready`: the contract defines the signal and the host adapter does not send the conversation set yet (REVIEW NEEDED; a host decision).
* A conversation set is fixed for the incarnation. Re-sending, adding or replacing conversations while the guest runs is not in N2.
* The `fresh` runtime profile is not carried by the conversation set (no duplex transport for it).
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
