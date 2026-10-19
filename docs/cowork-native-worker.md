# Cowork native worker: wire contract and host adapter

Status: contract, N2 slice S1, 2026-10-16 (round 3, 2026-10-17: conversation-set delivery, runtime streams, guest faults, `halting`, the layered stop timeline; **text version 2, 2026-10-18: the retained-receipt MAC**, section 7.1; **contract revision 3, 2026-10-19: host-backed shares, cold resume and the guest file channel**, section 12). SOURCE ONLY. Nothing in this document or in `packages/core/src/cowork/native/`
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
* **Text version.** Every L1 line and every stop receipt carries `"v":2` (it was 1 before the receipt MAC). The binary headers (the L2 envelope `WEV1`, the L3/L4 mux `WMX1`, both `version = 1`) are unchanged. A launcher or daemon that sees `"v":1` on an L1 line refuses it (`version`; vector `begin-version-one`).
* **Payload versions (contract revision 3).** Control-class JSON stays `"v":1`. **Bootstrap-class JSON is `"v":2`**: the conversation set and `runtime_ready` gained required keys, and `shares` and `shares_mounted` are new (section 12). A payload with any other `v` is refused as `version` before its schema is read (vectors `bootstrap-version-one`, `bootstrap-version-three`). L1 lines and receipts did not change shape (revision 3 adds new L1 types, which a revision-2 peer refuses as `unknown_type`, and one refusal code), so they stay at text version 2; see section 12 for that choice.
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
* Limits (revision 3 adds the file channel's: request line 16 KiB, response line 384 KiB, 4 requests outstanding; section 6.2): control line 16 KiB; mux carrier line 1,572,864 bytes; mux payload control 4 KiB, bootstrap 256 KiB (the `conversations` message at most 20 KiB), runtime 1 MiB (the 4 byte stream prefix included)
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
| `refused` | `id`, `code` | one of `bad_request busy not_begun worker_spawn_failed code_identity_mismatch sandbox_failed volumes_rejected internal shares_rejected` (`shares_rejected`, revision 3: a `shares` line whose descriptors do not match its records) |
| `worker_state` | `state` | informational: `sandboxed volumes_accepted vm_running guest_hello draining drain_acked exited halting guest_fault`. `halting` and `guest_fault` mirror the L2 statuses of section 5 (the guest said it is halting; the guest said it is failing). Never evidence of a release; a daemon that has seen `guest_fault` refuses an orderly receipt for that run (section 7). |
| `mux_up` | `frame` | one bootstrap or runtime mux frame, base64 of the whole frame |
| `stopped` | `id` (or `null`), `receipt` | a Class A receipt (section 7). `id` is the `stop` request it answers, `null` for an owner-loss drain. |
| `uncertain` | `receipt` | a Class B receipt (section 7) |
| `pong` | `id` | answer to `ping` |
| `fault` | `code` | the channel is no longer trustworthy: `parent_unverified protocol_violation worker_channel_lost internal` |
| `share_revoked` | `tag` | revision 3: the worker's device thread for that share has closed every descriptor it held; the cutoff is complete (section 12.1). Sent once per tag. |
| `share_notice` | `tag`, `kind` | revision 3: `envrc vscode_tasks vscode_settings code_workspace idea_project` (an allowed write to a watched auto-run name) or `git_protected` (a refused git write); at most one per tag and kind per incarnation |

### 4.2 Daemon to launcher

| `t` | Keys after `v`,`t` | Meaning |
| --- | --- | --- |
| `begin` | `id`, `homeId`, `workspaceId`, `incarnationId`, `leaseEpoch`, `admissionId`, `controllerInstanceId`, `workerInstanceId`, `runtimeImageDigest`, `vcpus`, `memoryMiB`, `receiptKey` | the owner scope, and the installation's receipt MAC key (section 7.1). `receiptKey` is the LAST key: the canonical padded base64 of exactly 32 bytes (44 characters); hex, unpadded, 31 or 33 bytes, `null` or an empty string are refused (`bad_field`) and a key placed anywhere else fails the byte-for-byte compare (`malformed`). It is a secret: the launcher keeps it in memory only and never writes it anywhere. `vcpus` is 2, `memoryMiB` 768 to 1024 (D8; 768 is the floor the library admits). `homeId` is the ONE source of the home identity: the launcher stamps it into every receipt, and it has no other input (no spawn argument). It does not travel on L2. |
| `volumes` (**two descriptors**) | `id`, `scopeDigest`, `volumes` | `scopeDigest` is the SHA-256 of the 512 byte SCOPE payload (section 5). `volumes` is exactly two records `purpose, device, inode, uid, mode, capacityBytes`, data first then environment; `mode` is 384 (`0600`); the same file may not back both. |
| `mux_down` | `frame` | one bootstrap or runtime frame |
| `stop` | `id`, `stopNonce`, `reason`, `budgetMs` | `reason` one of `user shutdown restart update failed-start`; `budgetMs` at most 120000 (the documented budget is 30000) |
| `receipt_retire` | `confirmationId` | the daemon finished with that receipt; the launcher may delete its durable copy |
| `ping` | `id` | liveness probe |
| `shares` (**one descriptor per record**) | `id`, `shares` | revision 3, at most once, after `hello` and before `begin`: 1 to 12 records `tag, kind, mode, device, inode, path, guestPath` in descriptor order (section 12.1) |
| `share_revoke` | `id`, `tag` | revision 3: cut one share off now (section 12.1); a repeat for the same tag is ignored |

### 4.3 Descriptors on L1

`SCM_RIGHTS` is allowed on `volumes` and `shares` and nowhere else. The sender attaches exactly two descriptors (data, environment) to a
SINGLE `sendmsg` that carries the whole `volumes` line, and exactly one directory descriptor per record to the single `sendmsg` of a `shares` line. The receiver reads every chunk with `recvmsg` and a control buffer, and applies
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
| 6 | `shares` | launcher to worker | 3,704 bytes | exactly one per share (1 to 12) |
| 7 | `share_revoke` | launcher to worker | 32 bytes | none |
| 8 | `share_event` | worker to launcher | 40 bytes | none |

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
* `shares` payload (revision 3): `u32 recordVersion = 1`, `u32 count` (1 to 12), then twelve 308 byte slots; the first `count` hold
  `tag[32]` (NUL-padded, `[a-z0-9-]{1,32}`), `u64 device`, `u64 inode`, `u32 flags`, `guestPath[256]` (NUL-padded), and every other slot is zero.
  `flags` are the ABI's: bit 0 read-only, bit 1 Winter share, bit 2 folder rules; exactly one of bits 1 and 2, nothing else. A Winter share's guest path
  and mode are fixed by its kind, a folder's guest path is `/workspace/folders/<name>` (section 12.1). Sent after the worker's `sandboxed` status; the
  worker compares each descriptor with its argv parameter by `F_GETPATH` and `fstat`.
* `share_revoke` payload: `tag[32]`. `share_event` payload: `tag[32]`, `u32 event` (1 `share_revoked`, 2 `share_notice`), `u32 notice` (0 for
  `share_revoked`; for `share_notice` 1 `envrc`, 2 `vscode_tasks`, 3 `vscode_settings`, 4 `code_workspace`, 5 `idea_project`, 6 `git_protected`).

### The worker process (final for N2)

* argv is exactly `[path]`, or with host-backed shares (revision 3) `[path, "--shares-v1", "<N>", ("ro"|"rw", "<path>") x N]` with N a canonical decimal
  from 1 to 12 and the paths canonical, distinct and never nested; the worker turns each pair into the sandbox parameter `SHARE_RO_<n>` or `SHARE_RW_<n>` and
  exits `2` on any deviation. It is the one input read before the sandbox, and it comes from the signed launcher that spawned the worker suspended. The
  environment is the launcher's two variables (`LC_ALL=C`, `LANG=C`).
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
| bootstrap, up | `fault` | `operationId`, `nonce`, `code` (`bad_plan probe_failed format_failed replay_failed mount_failed internal bad_conversations supervisor_failed second_conversations share_inventory share_mount_failed resume_store_missing fresh_store_not_empty`) |
| bootstrap, down | `ready` | `operationId`, `nonce` |
| bootstrap, up | `mounted` | `operationId`, `nonce` |
| bootstrap, down | `shares` | `operationId`, `nonce`, `shares` (revision 3: 1 to 12 of `tag, guestPath, readOnly, kind`; section 12.1) |
| bootstrap, up | `shares_mounted` | `operationId`, `nonce` |
| bootstrap, down | `conversations` | `operationId`, `nonce`, `incarnationId`, `profile`, `browseUid` (revision 3), `conversations` (section 6.1) |
| bootstrap, up | `runtime_ready` | `operationId`, `nonce`, `conversations` (how many the supervisor now serves, 1 to 16), `continuations` (revision 3: for each host-query conversation, `fresh` or `resume`, as the supervisor ran it) |

On L1 a mux frame travels as `{"v":2,"t":"mux_down","frame":"<base64>"}` or `mux_up`: the base64 is canonical (re-encoding must
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

**Host behavior (clarification, no wire change).** The host adapter sends the set through an injected provider, once, after `mounted`; a host-query profile with other than one conversation, a set not bound to the incarnation and guest boot id, and a set the strict serializer refuses (including one above 20,480 bytes) are refused BEFORE anything is sent and fail the start. The host's `running` (power `running`, admission `running`) waits for `runtime_ready`, for at most 60 seconds from the send (`runtimeReadyMs`, pinned by a test). A bootstrap `fault`, a `runtime_ready` that does not echo the plan's operation and nonce or does not count the delivered conversations, a `runtime_ready` that arrives BEFORE the set was sent (out of order), and the timeout all fail the start; the stop that follows is the ordinary orderly failed-start stop. A duplicate `runtime_ready` after the first is ignored (the first stands, as a second DRAIN is). The duplicate still passes the up-sequence check (`nextBootstrapUpSequence` counts it), so a later bootstrap-up consumer sees no gap; it moves nothing else (`coworkNativeBootstrapOrder` reports it as `duplicate_runtime_ready`). **Where "once per incarnation" is enforced:** `protocol.ts` parses one frame at a time and is stateless; the two ends enforce it (the host sender sends one set per start, the guest answers a second with `second_conversations`), and `coworkNativeBootstrapOrder` with the vectors in `bootstrap-order.json` is the shared oracle for the ordering (`conversations` only after `mounted`, `runtime_ready` only after a set). With no set there is no supervisor and nothing waits.

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
| `runtimeUid`, `toolUid`, `workspaceGid` | 1000 to **65533** (65534 is `nobody` and 65535 the invalid id; nothing requires them); every `runtimeUid` and `toolUid` of the set distinct, and no `workspaceGid` equal to any `runtimeUid` (the supervisor's own rule) **or any `toolUid`** (a group id equal to a uid is that user's private group). `workspaceGid` need NOT equal a uid: PID 1 gives each runtime and tool process the primary gid equal to its own uid (the supervisor does not check that, so the contract does not carry it), and `workspaceGid` is the one extra, shared group. |
| `policy` | `auto plan ask accept-edits dont-ask bypass` |
| `roots` | 1 to 16 of `id, guestPath, source, readOnly`; ids and views distinct, no view inside another; `guestPath` is one of `/workspace/folders/<name>[/...]`, `/workspace/repos/<name>[/...]`, `/workspace/.winter/memory`, `/workspace/.winter/scratch/<logicalSessionId>`, `/workspace/outputs/<logicalSessionId>`; `source` is a canonical absolute path under `/workspace/` (no `.`, `..` or empty component, at most 1024 bytes) |
| `runtime` | `null`, or `model` (1 to 256 characters), `timeoutMs` (1 to 86400000 for the host-query profiles; revision 3, see section 12.2; the fixture `fresh` profile is never carried and keeps its 600 s ceiling), `toolClasses` (a subset of `read write execute coordinate`, in that order), `provider`, `guided` (`null`, or `bindingId` a version 4 UUID and `generation` 1 or more), `continuation` (revision 3: `fresh`, `resume` or `either`), `endedGuestBoots` (revision 3: 0 to 4 distinct lowercase guest boot UUIDs, never the live boot, empty for `fresh`) |

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
| 1 | 1 | `stream`: 1 = IN (host to guest), 2 = OUT (guest to host), 3 = ERR (guest to host), 4 = FILE_IN (host to guest), 5 = FILE_OUT (guest to host); 0 and 6 or more are refused, and 4 and 5 only on conversation 0 (revision 3) |
| 2 | 1 | flags: bit 0 = this is the end of that stream after these bytes; every other bit zero |
| 3 | 1 | reserved, zero |

A conversation's three streams are the supervisor's `RuntimeDuplexPorts` input, stdout and stderr (ERR is carried, not dropped). IN and FILE_IN travel only down; OUT, ERR and FILE_OUT only up (anything else is `bad_direction`; `runtime-stream-four` travelling up is therefore `bad_direction` since revision 3). An empty data section
is valid only with the end flag. After a stream's end nothing more may arrive on it, and a conversation index outside the delivered set is refused (`CoworkNativeRuntimeStreams` is that state). Data is
limited by the payload bound, 1 MiB minus 4 bytes; a sender uses chunks of at most 256 KiB (the host's own chunk limit). Frames of this class are delivered only after `runtime_ready`.

**Runtime IN flow control (normative, host side).** The guest relay's IN ring is 4 MiB and an overflow stops the whole guest, so the contract bounds the host: the runtime IN payload bytes sent with no OUT or ERR byte received since stay **at or below 1 MiB** (`COWORK_NATIVE_LIMITS.runtimeInFlightBytes`, 1,048,576, a quarter of the ring). Any OUT or ERR frame that carries payload BYTES proves the guest is reading and clears the count; an empty OUT or ERR frame (the end flag alone) clears nothing. Host-query is request/response, so this needs no credit frame: one request (at most 1 MiB, in chunks of at most 256 KiB) is in flight and its first output byte acknowledges it; a longer request is not possible in N2. `CoworkNativeRuntimeStreams` applies the same rule to both ends (the sender must not send a frame that would exceed it, the receiver refuses it as `oversize`), and `runtime-flow.json` pins the cases. A credit or window frame stays a later option if streaming requests larger than 1 MiB are ever needed.

**The guest file channel (revision 3, normative).** FILE_IN and FILE_OUT (`file_in`, `file_out` in `protocol.ts`) carry the guest file channel's request and response lines (`packages/core/src/cowork/guest-file-channel.ts`) on conversation 0 only; a request names its own `sessionId`, so the index is transport, not authority. The host opens them only for an image that declares the runtime capability `file-channel-v1`: a revision-2 guest relay refuses stream 4 and would end its stream. Their end flags follow the other streams' rules; FILE_IN's end means the host closed its port for the incarnation, FILE_OUT's end that the guest file service exited (a drain or a fault), and neither is ever "this reply is done". **FILE_IN has its own bound and never joins the runtime IN count:** at most 4 request lines outstanding (`COWORK_NATIVE_LIMITS.fileInFlightRequests`), each at most 16 KiB with its newline (`fileRequestBytes`), a request answered when a FILE_OUT response line's newline arrives, each response line at most 384 KiB (`fileResponseBytes`); a response byte with no request outstanding cannot be attributed and is `bad_field`. FILE_IN bytes never add to the runtime IN count and FILE_OUT bytes never clear it, so a busy file service can never "prove" that a stalled runtime is reading. `CoworkNativeRuntimeStreams` applies the rule, all or nothing per frame, and `runtime-flow.json` (`fileCases`) pins it. The guest relay keeps a separate 256 KiB FILE_IN ring (four times the most the host may have outstanding).

## 7. Stop evidence

Two classes, kept apart by type. Both are single canonical JSON lines (the exact text the launcher fsyncs and embeds in `stopped`
and `uncertain`).

**Class A, orderly**: keys `v, class("A"), confirmationId, stopNonce, origin(host-stop | owner-loss-drain), launcherInstanceId, admissionId,
homeId, workspaceId, incarnationId, leaseEpoch, controllerInstanceId, workerInstanceId, runtimeImageDigest, hostBootId, guest{drain,halting,powerOff},
worker{pid,startToken,exit("code"),status(0),reaped(true)}, volumes[2]{purpose,device,inode,capacityBytes,attached,flushRequested,flushCompleted,finalFlush},
issuedAtMs, mac`. `mac` is the LAST key (section 7.1). The chain it attests: the guest halted through a `drain` frame and a power-off, libkrun exited, the launcher's
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

### 7.1 The receipt MAC (text version 2)

Owner ruling 2026-10-18. The key is 32 random bytes in the daemon's Keychain service (the dist, dev or test-throwaway service resolved exactly as for other
slots), account `cowork-native-receipt-mac-v1`, created on the first start that needs it and read (never created) at boot. It is never written anywhere
else and never logged. The daemon hands it to the launcher once, in the L1 `begin` line (L1 is the authenticated socketpair, so it never touches disk); the
launcher keeps it in memory only. There is no rotation API: losing or replacing the key turns every retained receipt into Class B, and the user clicks Recover.

* **MAC input.** The UTF-8 bytes of the receipt's canonical JSON text WITHOUT the `mac` key and without the trailing newline: schema key order, no
  whitespace, integers only, `"v":2`. Equivalently: the receipt line with `,"mac":"<44 characters>"` removed before the closing `}` and the `\n` dropped.
* **MAC.** HMAC-SHA256(key, input), the 32 raw bytes, written as canonical padded base64 (44 characters) in the last key `mac`. Verification is a
  constant-time compare of the 32 bytes; a `mac` that is not the canonical base64 of 32 bytes does not even parse.
* **What is signed.** Everything in the receipt: the binding fields (workspace, incarnation, epoch, owner tuple, admission, home, boot id, launcher, worker),
  the guest and volume facts, `issuedAtMs`, the confirmation id and the nonce.
* **Class B** carries no MAC: nothing in it can release anything.
* **Where it is verified.** Only on the retained path (`stop-proof.ts`, source `retained`). A receipt received live on L1 in answer to a stop the daemon
  issued is bound by the channel, the nonce and the launcher instance, as before; the launcher signs it anyway.

Vectors (`stop-receipts.json`, `macVectors`; `launcher-lines.json`): a SYNTHETIC key (`synthetic-receipt-key-0123456789`, shown as UTF-8, hex and base64),
for each positive receipt the exact MAC input text, the MAC in base64 and in hex, and negatives (wrong MAC with the right shape, a MAC copied from another
receipt, signed under another key, edited after signing, missing, null, 31 or 33 bytes, hex, unpadded, not last). `begin` carries the same key; negatives
cover a missing key, `null`, 31 and 33 bytes, hex, unpadded, empty, a misplaced key and `"v":1`.

**Class B, uncertain**: keys `v, class("B"), launcherInstanceId, admissionId, workspaceId, incarnationId, leaseEpoch, workerInstanceId, reason,
worker{pid,startToken,exit(code|signal|unknown),status}, attachedVolumes, issuedAtMs`, with `reason` one of `daemon-lost drain-timeout
worker-killed worker-crashed guest-fault flush-uncertain channel-eof launcher-fault`. It has no confirmation id, no nonce and no
volume list: nothing in it can be turned into a release.

Release policy (decision D1, conservative default). Ownership of the two disks is retained after ANY crash. Only these can release:

1. a Class A receipt that parses, satisfies its invariants and binds to the exact owner, volumes, nonce and live (or retained) launcher;
2. a changed host boot id that the host probe confirms really ended the previous boot;
3. an explicit owner `recover` input behind a port (`CoworkNativeOwnerRecoverPort`, unwired), plus two agreeing guard probes
   (process absent by pid, start token and boot id; images unlocked). The guards are never load-bearing on their own for an owner recover.

The launcher's retained-receipt store is same-user writable, so item 1 differs for a RETAINED receipt (read back from that store rather than
received live on the authenticated L1 channel). **A retained Class A receipt counts only if its MAC verifies (section 7.1) AND both guard probes
pass at that moment**, checked in that order: a forged file never reaches the question about the old worker. The MAC and the probes are part of the
proof's source, so no code path mints a retained proof without them. A missing, unreadable or malformed key, a missing or malformed `mac`, and a MAC
that does not verify all make the receipt Class B: nothing releases, and the owner's Recover is the way out. With no guard port a retained Class A
receipt is likewise treated as Class B. Release stays automatic once both hold. The daemon deletes a retained receipt file only after the disk is
settled by real proof; a file for a disk that stays held is left in place.

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
| `krun_cowork_enable_profile_v1` | `krun_enable_cowork_block_fixture_reclaim` | opts the context in to the production profile (accepted once, only on a context with no fixture opt-in). It checks NO geometry: 2 vCPUs and 768 to 1024 MiB are enforced at start-time admission (inside `krun_start_enter`) and by the pre-construction phase that `krun_cowork_validate_profile_v1` previews |
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
`guest_halted`. **Contract invariant:** the guest's drain budget (default 30 s) is above the exit watchdog (20 s), and the launcher's kill (budget + 20 s + 5 s) is above both; `protocol.test.ts` pins the order. **The worker's deadline is exactly G** (the DRAIN's `budgetMs`): a final flush that starts just before G is cut short when the worker exits `75` (`drain_timeout`) at G, the disks' final sync is then incomplete, and the stop is Class B. G is the guest's whole budget and X is spent only after a power-off that happened inside it.

Retired with no production equivalent: `krun_enable_cowork_runtime_port_fixture_trace`, `krun_create_cowork_bootstrap_stream`,
`krun_set_cowork_bootstrap_stream`. **Not admitted: `krun_get_shutdown_eventfd`** (the PL061 GPIO shutdown device). The device
inventory is S4's admitted one: two virtio-blk disks, one generic virtio-console port, the entropy device (rng), the memory balloon, PL011 output; no network device, no vsock, no
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

* D4 (who owns the agent-SDK relay) is open. D7 is decided (owner 2026-10-19: the libkrun patches stay in the winter repo's queue), and D10 is lifted for
  host-backed shares and cold resume (owner 2026-10-19; section 12). The provider bridge stays HELD: the provider class is reserved and empty.
* The `allocate` action of `CoworkVolumeAuthority` is refused by the native authority: provisioning is not on the launch path.
* Authentication of a retained receipt that is read back from the launcher's durable store is the launcher slice's design (S2). The
  adapter accepts such a receipt only through a port that must attest it; file presence alone is never proof.
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
with the two descriptors, the bootstrap exchange (`plan` with a fresh nonce, `receipt`), `confirmFilesystems`, `ready`, `mounted`, then, when the incarnation has conversations, the conversation set (`conversations`, once, bound to the plan's operation and nonce) and the guest's `runtime_ready` (a bootstrap `fault`, a wrong echo or count, a `runtime_ready` before the set, or 60 seconds without it fails the start), then `power`
`running` and admission `running`. The host refuses a stop wait shorter than the contract's H at construction (a test-only switch exists for the harness). A failure after the worker exists is answered with a `stop`; only a valid orderly receipt for THAT request
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

## 12. Contract revision 3: host-backed shares, cold resume, the guest file channel (2026-10-19)

The design is `docs/research/2026-10-18-n2-extensions-design.md` (PR #92). Revision 3 is ADDITIVE on every link: a new L1 type is refused by a revision-2 peer as `unknown_type`, a new envelope kind as `unknown_type`, a new bootstrap message or key by the bootstrap `v` (now 2) as `version`, and the new runtime streams are offered only to an image that declares `file-channel-v1`. Nothing here is wired: `session.create {mode: "cowork"}` still answers `unsupported_topology`.

**Why L1 stays at text version 2.** The text version guards the shape of existing L1 lines and receipts, as the 1 to 2 bump did when `begin` and the Class A receipt changed shape. Revision 3 changes neither: it adds L1 types and one refusal code, and a revision-2 launcher refuses the new types. Bumping it would re-key every receipt MAC vector and every launcher copy for no added refusal. A bump is a mechanical follow-up if the contract owner prefers one (`COWORK_NATIVE_TEXT_VERSION`).

### 12.1 Host-backed shares

A share is a host directory served to the guest by a Winter-owned virtio-fs server in libkrun (design section 2.3). Kinds: `folder` (a granted user folder, at `/workspace/folders/<name>`, read-only or read-write by its grant; at most 9), `guidance` (`/run/winter/shared-instructions`, always read-only), `memory` (`/workspace/.winter/memory`, read-write) and `outputs` (`/workspace/outputs`, read-write), at most one of each Winter kind, at most 12 in all, tags `[a-z0-9-]{1,32}` distinct.

1. **L1 `shares`** (daemon to launcher, at most once, after `hello`, before `begin`): one record per share, `tag, kind, mode (ro|rw), device, inode, path, guestPath`, with one directory descriptor per record on the line's single `sendmsg`. `path` is canonical (absolute, no `.`, `..` or empty component, not `/`, well-formed UTF-8 of at most 1024 bytes, no control character); paths are pairwise neither equal nor nested and (device, inode) pairs distinct. The line stays inside the 16 KiB control-line bound; a sender refuses a set that does not fit. The launcher refuses with `shares_rejected` when a descriptor's `fstat` differs from its record, is not a directory, or its `F_GETPATH` differs from `path`.
2. **Worker argv** `[path, "--shares-v1", "<N>", ("ro"|"rw", "<path>") x N]` (section 5): one sandbox parameter per share, installed before anything is read.
3. **L2 `shares`** (kind 6, section 5) after the worker's `sandboxed` status, carrying the descriptors; the worker checks each against its argv by `F_GETPATH` and `fstat` and attaches each with the proposed ABI (below).
4. **Bootstrap `shares`** (host to guest, after `mounted`, before `conversations`, echoing the plan's operation and nonce): `tag, guestPath, readOnly, kind` per share. The guest checks the virtio-fs tag inventory against it (`share_inventory` on any difference), mounts each tag `nosuid,nodev` (`noexec` on the Winter shares, `ro` where read-only, `dax=never`), and answers `shares_mounted` or `share_mount_failed`. The set waits for `shares_mounted` (`coworkNativeBootstrapOrder`).
5. **Revocation.** L1 `share_revoke` → L2 `share_revoke` (kind 7): the server refuses every request that starts after it. Only the device's own thread closes the device's descriptors, then the worker sends L2 `share_event` `share_revoked` and the launcher the L1 line of the same name. A daemon that has not seen `share_revoked` within 2 s of its line stops the workspace (fail closed). "Revocation complete" is reported only after the following restart.
6. **Notices.** The server reports writes to watched auto-run names and refused git writes as L2 `share_event` `share_notice`, relayed as the L1 line, at most one per tag and kind per incarnation.

Proposed libkrun ABI (SH2; not in `COWORK_LIBKRUN_PRODUCTION_ABI` until the patch lands): `int32_t krun_cowork_add_share_v1(uint32_t ctx_id, const char *tag, int32_t root_fd, uint32_t flags, const char *guest_path)`, `flags` as in the L2 record. `krun_add_virtiofs*` and `krun_set_root` stay forbidden.

### 12.2 Cold resume

Each host-query conversation's `runtime` gains `continuation` and `endedGuestBoots`:

| Host `store_state` | `continuation` | Supervisor test |
| --- | --- | --- |
| `none` (never sent) | `fresh` | store and run home empty, else `runtime_fresh_store_required`; `endedGuestBoots` must be empty |
| `started` (a set was sent, no completed turn yet) | `either` | run home empty; an empty store runs fresh, a non-empty one resumes |
| `created` (a completed turn) | `resume` | store non-empty and owned by `runtimeUid`, mode 0700, else `resume_store_missing` |

`runtime_ready.continuations` says, per host-query conversation, which one the supervisor ran, and the host passes `resume` to the SDK only on `resume`. `endedGuestBoots` lists guest boot ids the HOST recorded at that boot's `hello` and later released by real proof (section 7); it is the only previous-boot evidence the owner library may mint, and never contains the live boot. New bootstrap faults: `resume_store_missing`, `fresh_store_not_empty`. `timeoutMs` admits up to 86,400,000 (the 24 h guest backstop, owner O7) for the host-query profiles only; the fixture `fresh` profile is not carried by the conversation set and its ceiling stays 600,000 (600 s). An agent SDK supervisor before its CR2 release still refuses more than 600,000, which fails the start closed; the host sends 600,000 until the image pins CR2.

`continuation: "either"` is never used once `store_state = created`: from the first completed turn on, the host sends `resume` only, so a store that has gone missing is a `resume_store_missing` fault, never a silent fresh start. `either` exists only for `started`, where the host cannot know whether the guest store was written.

### 12.3 The guest file channel

Streams FILE_IN (4) and FILE_OUT (5), section 6.2. The conversation set gains `browseUid`: `null`, or the workspace's browse uid (1000 to 65533), never any member's runtime or tool uid and never a group id. The guest file service runs each request as that uid in the workspace group with no capability, in a read-only view of the conversation's admitted roots (design section 4b.3).

### 12.3a Revision 3 additions the host implements (S7B, 2026-10-19)

- **`coordinate` tool class.** `toolClasses` is a subset of `read write execute coordinate`, in that order (`coordinate` last): the class of the guest-side coordination tools. Order, repeats and unknown names are refused as before.
- **The plan view.** `/workspace/plan/<logicalSessionId>/<epoch>` is admitted as a root of that conversation only: the conversation's own id, `epoch` a canonical non-negative decimal (no leading zero, at most nine digits), exactly that path (no deeper). It exists only under policy `plan` and at most once, and it is the ONE writable root there: under `plan` every other root is read-only, and a plan view with `readOnly: true`, or any plan view under another policy, is refused. It lies outside `.winter`. PID 1 creates the directory root-side when the set names it (mode 0700 for the runtime uid, no symlink followed, idempotent); the host never writes the data disk. The host sends an epoch only once per conversation going forward: an epoch lower than one already sent for that workspace and conversation is refused before anything is sent (the same epoch is fine).
- **Outputs directory.** `/workspace/outputs/<logicalSessionId>` lives on the outputs share (12.1). Before a set that names it is sent, the host makes `<home>/cowork/workspaces/<id>/shared/outputs/<logicalSessionId>` (owned by the daemon's user, mode 0700, never through a symlink, idempotent). The guest's view of group ownership is the folder server's mapping.
- **Guest boots.** The host records `guestBootId` at `hello` (`cowork_guest_boots`), before it sends the plan. The row's end proof is written only by the evidence that released the disks (an orderly receipt, a changed host boot, an owner recover), never by anything the guest says; `endedGuestBoots` lists only boots with a proof.
- **Store volume.** The data volume's filesystem UUID is kept per workspace (`store_volume_uuid`, write-once) and compared before any start. A different value refuses the start before the incarnation moves, and marks the store lost when a store was expected (`started` or `created`). A store expected over a never-formatted data volume is likewise lost, and the volume is not formatted for it.
- **The continuation echo.** `runtime_ready.continuations` has exactly one entry per host-query conversation; a `fresh` set must echo `fresh`, a `resume` set `resume`, and an `either` set either. Anything else fails the start. The echo is handed to the caller (`CoworkNativeRunning.continuations`).
- **Faults.** `resume_store_missing` marks the conversation's store lost (once) and fails the start; `fresh_store_not_empty` fails the start and marks nothing.

### 12.4 Vector copies

The canonical vectors here moved (bootstrap `v`, the new keys, the new types). The worker's and the launcher's copies of `mux-frames.json` and `runtime-flow.json` are re-pinned with this revision, because both relay runtime and bootstrap frames blind. Their copies of `launcher-lines.json` and `envelopes.json`, and the guest's copies, stay at revision 2 until the slices that implement the new types land (launcher SH4, worker SH3, guest SH6 and FC3); each copy is pinned by its own hash, so a stale copy is visible, never silent.
