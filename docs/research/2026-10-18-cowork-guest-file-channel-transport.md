# Guest file channel transport in N2: how stat, read and ranged read travel host, guest, host

**Date:** 2026-10-18 · **Status:** host side built and unwired, guest side and native routing owed · **Builds on** [`2026-10-16-cowork-guest-file-channel.md`](./2026-10-16-cowork-guest-file-channel.md) (the DTOs, parser and fenced client, merged) and the session door design (G11: in N2 a session's outputs live on the VM disk, so Mac readers cannot see them).

**Rule for this note:** no NIC, no vsock, no network, and no use of mux class 3 (`provider`, reserved and refused at every header). Everything below rides the one libkrun virtio-console byte port that already carries the mux.

## 1. Decision: two more streams in the runtime class

**Recommendation: add two byte streams to the runtime class's existing stream byte, `FILE_IN = 4` (host to guest) and `FILE_OUT = 5` (guest to host), on conversation index 0.** Same L3/L4 mux, same 16 byte header, same `seq` rule, same 4 byte payload prefix (`conversation, stream, flags, reserved`), same virtio-console port, same relays.

| Option | Verdict |
| --- | --- |
| Streams 4 and 5 of the runtime class | **Chosen.** The launcher and worker relay runtime frames without reading them, so only the host parser (`native/protocol.ts`) and the guest relay change. No header, class, port or device change. |
| Mux class 3 (`provider`) | Forbidden here. It is the reserved provider class; it stays refused. |
| A new mux class | Touches the header table in every parser, the launcher and the worker relays. Larger than a stream value for no benefit. |
| Inside streams 1 and 2 (the SDK query transport) | The guest runtime reads those as the SDK protocol; a foreign line type collides with `checkLinuxHostQueryFrame` and head-of-line blocks a turn behind a file read. Rejected. |
| Bootstrap class | A fixed handshake table (`plan`, `receipt`, `conversations`, ...) with a 256 KiB cap and nonce-per-exchange semantics. Wrong tool. |
| NIC, vsock, a network share | Out of the N2 device inventory. Not designed. |

Today a runtime payload with stream byte 0 or 4 and above is `bad_field`, so this needs a change in the native host and in the guest. Both are other lanes' (see NEEDS FROM OTHER LANE); this lane built everything on the Core side of that seam.

## 2. Framing and bounds

The file streams carry the channel's own lines, unchanged from the channel note: **host to guest, one request line per `send`** (a canonical JSON object plus a newline, at most 16 KiB; `parseCoworkGuestFileRequest` is the exact grammar), **guest to host, response lines** (at most 384 KiB; `parseCoworkGuestFileResponse`). The runtime `end` flag is used once per stream, at close: it means the channel is over, never "this reply is done". A response line may be split across any number of `FILE_OUT` frames (the guest uses chunks of at most 256 KiB) and several short lines may share one frame; a line ends at its newline.

| Bound | Value | Why |
| --- | --- | --- |
| Request line | 16 KiB | channel bound; one `send`, far under the 256 KiB host chunk |
| Response line | 384 KiB | channel bound; plus the 4 byte prefix it fits one 1 MiB runtime payload, and at most two 256 KiB chunks |
| Decoded bytes per read | 256 KiB (64 KiB default) | channel bound, equal to the host-backed output reads |
| Requests outstanding | 4 (`COWORK_GUEST_FILE_TRANSPORT_LIMITS.maxInFlight`) | at most 64 KiB of requests unanswered; a pin test keeps it at or under an eighth of the runtime IN rule |
| Reply assembly | one line, at most 384 KiB | oversize closes the channel (below) |

**IN flow control.** The runtime IN rule (at most 1 MiB of IN payload bytes with no OUT or ERR payload byte received since) protects the guest relay's 4 MiB IN ring. File requests are tiny and bounded by the four-slot limit, so they cannot approach it on their own, but the native host must state whether `FILE_IN` bytes join that counter and whether `FILE_OUT` payload bytes clear it. Recommendation: yes to both (one counter for the conversation), which is conservative: a reply proves the guest is reading.

## 3. The host side (built in this slice, unwired)

`packages/core/src/cowork/guest-file-port.ts`:

- `CoworkGuestFileStreamLink { send(bytes); onData(handler(bytes, end)) }` is the seam: the file stream pair of one incarnation. **No implementation in `src/`**; the native host supplies it once it carries streams 4 and 5.
- `createCoworkGuestFilePort({ link, scope })` is the channel's `CoworkGuestFileFramePort`. It parses each outgoing line with the channel's own request parser, refuses anything bound to another workspace or session (`authority_denied`) or another incarnation (`stale_file`) without sending a byte, bounds the outstanding requests, reassembles reply lines in linear time, and routes each reply by `requestId` to its caller **unparsed**. The client's strict parser remains the only judge of a reply's content.
- An aborted request detaches its caller but **keeps its slot until the guest answers**, so aborts cannot grow the guest's backlog; a late reply for it is dropped and is not a fault.
- **Fail closed.** A reply line that cannot be attributed to an outstanding request (garbage, not JSON, no or unknown `requestId`, not UTF-8), a line longer than the response bound (`response_too_large`), a stream end (even mid-line) or a failed `send` closes the port: every outstanding call and every later call answers `file_unavailable`. There is no resynchronization or retry. The owner builds a new port for the next incarnation; the port is bound to one incarnation and cannot outlive it.
- `createCoworkGuestFileClientOverLink({ link, scope, authority })` composes the port with the channel client. The authority port stays the host's: it is called before the request leaves and again when the reply arrives, exactly as before.

Not wired: nothing imports the module (anti-wiring pin), `session.create {mode:"cowork"}` is untouched and still answers `unsupported_topology`, and tests exercise the whole stack only with a fake guest over an in-memory link.

### The guided reader adapter

Not wired onto this port, deliberately. The adapter's frame is the guest guided reader's `reader_result` instruction snapshot, produced by the SDK on behalf of a guided callback (`CoworkGuidedFramePort.readFrame(signal)`; one read per signal, an echo of owner, views and limits, single-use read ids, a 320 KiB bound). It is not a file read: no request of this channel could produce it, and mapping it onto `stat` or `read` would invent a protocol. The two do share a need (an attributable, bounded line reader on a byte stream). Once Track A decides which stream the guided frame rides, the right move is to factor the port's line assembler into a shared helper and give the guided port its own stream; that is a separate slice with its own guest producer.

## 4. How the binding is enforced at both ends

| Field | Host | Guest |
| --- | --- | --- |
| `workspaceId`, `sessionId` | Client: authority port before and after; port: refuses another scope, sends nothing; parser: a reply echoing another scope is `authority_denied` | Must equal the trusted conversation config the supervisor received from PID 1 / the `conversations` message (`authority.workspaceId`, `authority.sessionId`); anything else is `file_unavailable` |
| `incarnationId` | Port bound to one incarnation; client compares the live incarnation before and after, and the reply's echo | Must equal the incarnation of the conversation set; else `stale_file` |
| `sourceRevision` | Client compares the live source revision before and after, and the reply's echo | **Not checkable in the guest**: the conversation set carries no source revision. The guest echoes the value it was given; revision is a host-side fence only. If a guest-side check is ever wanted, `roots[]` would have to carry it (a contract change) |
| `locationId` | Authority port maps it to a ready source | The guest resolves it by exact match to a delivered root `id`. **The host must set each root's `id` to the location id** (minted `location_<uuid>` ids satisfy both id grammars; pinned by a test) |
| `relativePath` | Validated before send (no absolute, `..`, empty or `.` component, control characters, well-formed UTF-16, 4096 bytes, 32 components, 255 per component) | Resolves under the root's `guestPath` component by component with `openat` and `O_NOFOLLOW`; only a regular file; refuses a symlink, a special file, a different device from the root and a hard-link alias; never returns an absolute guest path (the reply echoes the relative path only). The host never passes a guest path to a Mac filesystem API |
| `generation` | Reads compare the reply's generation with the caller's | An opaque token over `dev, ino, size, mtime, ctime, mode, nlink, uid`; a read whose generation differs answers `stale_file`; the guest re-stats after reading and answers `stale_file` if it changed, `file_incomplete` if it shrank |

## 5. NEEDS FROM OTHER LANE

**S7B / native (`native/protocol.ts`, `native/host.ts`, `docs/cowork-native-worker.md` section 6.2 and vectors):**

```diff
-export const COWORK_NATIVE_RUNTIME_STREAMS = Object.freeze(["in", "out", "err"] as const);
+export const COWORK_NATIVE_RUNTIME_STREAMS = Object.freeze(["in", "out", "err", "file_in", "file_out"] as const);
 // runtimeFrame / runtimePayload: stream = COWORK_NATIVE_RUNTIME_STREAMS[payload[1] - 1]  (1..5; 0 and 6+ stay bad_field)
-  if ((stream === "in") !== (direction === "down")) return fail("bad_direction");
+  if ((stream === "in" || stream === "file_in") !== (direction === "down")) return fail("bad_direction");
```

`CoworkNativeRuntimeStreams` tracks the end state of the two new streams like the others (an empty data section only with the end flag, nothing after an end, conversation index inside the delivered set). The host routes `file_out` frames to the file stream pair instead of dropping them, delivers `file_in` bytes from the link's `send`, accounts both in the runtime IN counter (section 2), and ends the file pair when the incarnation stops or faults. Add vectors for streams 4 and 5 in both directions, the wrong-direction refusals and stream 6.

**DOOR (`cowork/session-ports.ts`, the spine):** `CoworkGuestRuntimeLink` gains `readonly files: CoworkGuestFileStreamLink` (a structural copy there, as the other native-facing types are, since the native pin allows no import; the existing assignability test pins it against this module's interface). The conversation set builder sets each root's `id` to its location id. The composition that supplies the authority port for a live incarnation: `check(scope)` reads the conversation's active binding for `scope.sessionId` in `scope.workspaceId`, resolves `scope.locationId` to a source of that workspace, throws on a deleted or deleting workspace, a revoked grant or an unknown location, returns `{ incarnationId: null, ... }` while the workspace is not running, and otherwise `{ incarnationId: workspace.incarnationId, sourceRevision: source.revision }`. It must be synchronous.

**Agent SDK (repo `winter-agent-sdk`, the guest supervisor and relay; separate draft PR, not edited here):**

1. The relay presents the two new streams like the existing ones (two more FIFOs, or one socket) to a **file service** the supervisor starts after `runtime_ready`. Frames of stream 4 on any conversation index other than 0, a stream 5 frame from the host, or a prefix with the reserved byte set are protocol violations (fault code `protocol_violation`).
2. The service reads request lines (at most 16 KiB, canonical JSON, exactly the grammar of `parseCoworkGuestFileRequest`; copy the key tables and bounds and carry a drift test against this repo's literals) and answers each with exactly one response line in the grammar of `parseCoworkGuestFileResponse`: canonical `JSON.stringify` spelling (compact, no ASCII escaping, integers only; see the channel note for Python, Go and Swift recipes), the echo of every binding field, `requestId` and `op`, the exact chunk length `min(maxBytes, bytes - offset)`, `eof` true exactly at the end, and for reads the generation it saw. Errors use only `file_missing`, `file_unavailable`, `stale_file`, `file_incomplete`, `response_too_large`, `invalid_request`; never anything else.
3. It answers requests in any order but never interleaves two lines, never exceeds 384 KiB a line, and splits writes into chunks of at most 256 KiB. It handles at most 4 requests at once and may stop reading while it has 4 unanswered.
4. It runs with read access to the workspace roots only: never as the tool uid, never with write access, never with the provider socket or any host-visible path. Path resolution as in section 4.
5. On `drain` it finishes the line in progress, ends `FILE_OUT` with the end flag and exits; it answers nothing after the drain was acknowledged.

**Owner decisions:** none required to proceed with this slice. **O-F1 (recommendation: accept):** extend the runtime stream table with streams 4 and 5 as above, rather than a new mux class. If the owner prefers a new class instead, only `guest-file-port.ts`'s documentation changes; the link seam is the same.

## 6. Docs owed

- `docs/claude/cowork.md`: the guest file channel now has a Core transport port (unwired, behind the seam); its stream ids, bounds and fail-closed rules as in sections 1 to 3; the guided reader adapter is not on it; the guest file service is owed in the SDK.
- `docs/cowork-native-worker.md` section 6.2: streams 4 and 5 (S7B, with the protocol change).
- `docs/cowork-status.md` and the implementation ledger: G11 stays open until the native routing, the SDK file service and the authority composition exist; outputs on the VM disk remain unreadable from the Mac until then.

## 7. Validation

`packages/core/test/cowork/guest-file-port.test.ts` uses a fake guest over an in-memory link only: whole-file reads across reply chunkings of one byte to whole, request wire bytes, the authority sandwich through the port, the scope fence, the slot limit, abort and listener hygiene, every fail-closed branch, the exact reply bound, and pins (bounds, anti-wiring, no network or provider-class mention). It proves this module's logic and nothing about the native relay, the guest file service or confinement. No VM, worker, live home, Keychain, GUI or native run.
