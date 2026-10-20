# Guest file channel, read side: DTOs and a fenced Core client

**Date:** 2026-10-16 · **Status:** source slice, unwired · **Base:** `cowork/output-integration` · **Contract:** [`docs/cowork-execution-contracts.md`](../cowork-execution-contracts.md), "Guest router, file channel and immutable runtime".

This slice adds `packages/core/src/cowork/guest-file-channel.ts`: versioned request and response DTOs for `stat`, `read` and `readRange` of guest files, a strict closed frame parser, and a Core client over two injected ports. It enables no Cowork execution. Nothing under `src/` imports it, it has no barrel export, and neither port has an implementation anywhere in `src/` (an anti-wiring test pins all three). There is no guest implementation: whoever builds the guest component supplies the frame port, and the host composition supplies the authority port.

## What is in, what stays refused

| In this slice | Not in this slice |
| --- | --- |
| `stat`, `read` (first chunk) and `readRange` DTOs, version 1 | `list`, bounded image upload, explicit export (the contract's other operations) |
| Strict closed parser for requests and responses | Any guest-side implementation, path resolution, symlink or size enforcement |
| Core client: input validation, authority before, authority and incarnation and source revision again after, abort | A frame port, an authority port, a daemon or RPC method, a wake path |
| Existing `CoworkErrorCode` values only | A new error code, a protocol type, a schema or a status-ledger edit |
| Drift pins against the host-backed output read bounds | Any consumer (diffs, LSP, `session_files`, image staging, file browser, export) |

## Decision: Core owns the wire schema

**Recommendation (implemented): Core owns the schema.** The module is the single definition: constants, key sets, bounds, parser and error mapping. The guest component copies the values it needs when it is written and carries its own drift test against Core's pinned literals, exactly as `guided-reader-adapter.ts` copies the SDK's reader frame and pins it (there the SDK is the source of truth; here the direction is reversed because the host is the authority and the guest is the untrusted peer).

Why Core, and why not the alternatives:

- **The host is the trust anchor.** The guest is the party whose bytes are untrusted. A schema the guest defines and Core copies would let the untrusted side move the definition of "valid".
- **Guest-owned schema, Core copy** (the guided-reader direction). Right when the SDK is an independent product with its own release train. The file channel is Cowork-only and ships with the guest supervisor Core launches, so there is no independent consumer to protect.
- **A shared package or generated IDL.** Premature: one definition, one peer, three flat message shapes. It also needs a new package or edits under `packages/protocol/`, which is the client-facing RPC contract and a different audience. If a second implementation (a non-TypeScript guest) appears, a neutral schema can be generated from the key tables in this module without changing the wire.
- **Why not `packages/protocol`.** It is the client RPC surface. This is a host-to-guest internal wire. The host-backed `workspace.file.*` methods and these frames share bounds on purpose (a drift test pins it), not a type.

**Versioning.** Every frame carries `version: 1` and both sides require an exact match; there is no negotiation inside a frame. Frames are closed (unknown keys are refused), so any additive change is a version bump, not a quiet extension. Which versions a guest build speaks should be advertised once at the supervisor handshake (the existing `runtimeCapability` shape on the supervisor deps is the natural place), and a mismatch is a recoverable refusal, never a Mac fallback. The drift test in `guest-file-channel.test.ts` pins the version, operations, key sets, bounds and the exported surface against independent literals: changing the wire means changing the module and that test together.

**Later, on the guest side.** Mirror the pinned literals, add an opt-in drift test that reads this module's text when a checkout is available (the adapter's `WINTER_AGENT_SDK_SOURCE_DIR` pattern, reversed), and add a round-trip test that feeds the guest's frames through `parseCoworkGuestFileResponse` and Core's frames through its own request parser (`parseCoworkGuestFileRequest` is exported for exactly that).

## Wire format

One frame is one line: a single JSON object and a newline, in canonical `JSON.stringify` spelling. A parsed frame is re-serialized and must equal its own text, which refuses duplicate keys (JSON.parse keeps the last), whitespace, alternate escapes and alternate number spellings. The newline is the terminator: it must be the last character, and any other newline is JSON whitespace and fails the same compare.

**Key order.** Core emits the key order in the table below. The parser accepts the keys in any order (it reads the listed keys by name, and the re-serialization compare preserves whatever order was sent), so a guest need not match Core's order.

**Canonical JSON for a guest that is not TypeScript.** What the parser accepts is exactly what `JSON.stringify` produces for these frames, in any key order:

- compact separators: `,` and `:` with no whitespace anywhere, and no pretty-printing;
- no ASCII escaping: non-ASCII text (including U+2028 and U+2029) is written as raw UTF-8; only `"`, `\` and control characters below U+0020 are escaped (`\b \f \n \r \t`, others as lowercase `\u00xx`), and `/` and DEL are not escaped;
- integers only: plain decimal digits, no fraction, no exponent, no leading zeros, no `-0`; every number is a safe integer (at most 2^53-1);
- `true` and `false` literals, no `null` except where a field allows it (none of these frames do).

Python: `json.dumps(frame, separators=(",", ":"), ensure_ascii=False)` plus `"\n"`, with integer values only (a float such as `1.0` is refused). Go's `encoding/json` and Swift's `JSONEncoder` do not match by default: Go escapes `<`, `>` and `&` unless `SetEscapeHTML(false)` and always escapes U+2028 and U+2029, and Swift writes `/` as `\/` unless `.withoutEscapingSlashes` is set. A guest in either language needs non-default settings or a hand-written string encoder, and should be checked by feeding its output through `parseCoworkGuestFileResponse` (and Core's request frames through `parseCoworkGuestFileRequest`).

Every operation binds `workspaceId`, `sessionId`, `locationId`, `relativePath`, `incarnationId` and `sourceRevision`. Every response echoes all six and the request's `requestId` and `op`.

| Frame | Keys (the order Core emits; any order is accepted) |
| --- | --- |
| `stat` request | `version, requestId, op, <binding>` |
| `read` request (first chunk, offset 0) | `... , expectedGeneration, maxBytes` |
| `readRange` request | `... , expectedGeneration, offset, maxBytes` |
| `stat` response | `version, requestId, op, ok:true, <binding>, generation, bytes, kind:"file"` |
| chunk response | stat keys `+ offset, nextOffset, eof, contentBase64, encoding:"base64"` |
| error response | `version, requestId, op, ok:false, code` |

`generation` is an opaque 64-hex token from the guest; equal tokens mean the guest saw an unchanged file. It is the torn-read defence for multi-chunk reads (stat, then read with that token; a changed file is `stale_file` and the reader restarts), mirroring the host-backed reader. It is not a content digest and not a snapshot.

### Bounds (named constants in `COWORK_GUEST_FILE_LIMITS`)

| Bound | Value | Note |
| --- | --- | --- |
| Relative path | 4096 UTF-8 bytes, 32 components, 255 bytes per component | Same as the host-backed output reads |
| Chunk, decoded | 256 KiB max, 64 KiB default | Same as `COWORK_FILE_CHUNK_MAX_BYTES` and `..._DEFAULT_BYTES` (drift test) |
| Base64 text | 349528 characters | `4 * ceil(262144 / 3)`; checked from the length before anything is decoded, and against the size this request asked for |
| Request frame | 16 KiB | Ids plus a path of at most 4096 bytes (8192 escaped) |
| Response frame | 384 KiB | The host-backed file response budget (read from `service.ts` by the drift test); under the 1 MiB guest transport frame |
| Nesting | 1 | Frames are flat; checked on the raw text before `JSON.parse` |

Relative paths are well-formed UTF-16 only, with no absolute path, no empty, `.` or `..` component and no NUL or other control character (C0, DEL, C1). That is strictly tighter than the protocol's `CoworkOutputPath`, which does not refuse control characters other than NUL; a drift test pins that nothing accepted here is rejected there. The guest still resolves the path itself and applies its own traversal, symlink and size limits; this check only stops Core from sending a path it would not want interpreted.

### Offset and eof

The guest returns exactly `min(maxBytes, bytes - offset)` bytes starting at the requested offset: `offset` equals the requested offset, `nextOffset = offset + length`, and `eof` is true exactly when `nextOffset === bytes`. A shorter chunk that is not the end, a longer one, a shifted one, a zero-length chunk with no end, or an `eof` flag that disagrees is `file_incomplete` and nothing is returned. Reading at `offset === bytes` is an empty `eof` chunk. An offset beyond the file is the guest's `invalid_request`.

## Authority sandwich and error mapping

The client is `createCoworkGuestFileClient({ frames, authority, requestId? })`.

1. Validate the input (closed keys, own data properties only, the strict request parser as the single validator). Nothing leaves the client and the authority is not asked for an invalid input (`invalid_request`).
2. Abort check, then `authority.check(scope)` where `scope` is the bound operation. The whole call and every read of its answer sit in one try, so a throw, a Proxy trap or a getter that throws, a promise or other thenable (its eventual rejection is absorbed so it never surfaces as an unhandled rejection) or a malformed answer is `authority_denied`; a live incarnation or source revision that differs from the bound one is `stale_file`; a workspace with no running incarnation (`incarnationId: null`) is `file_unavailable` (guest-only data needs a wake; the wake itself is the consumer's business).
3. Send one request line; race the reply against the abort signal.
4. **Recheck** the same port when the reply arrives, before one byte is parsed or returned. Revoked is `authority_denied`; a changed incarnation or source revision (or an incarnation that vanished) is `stale_file`. This wins over everything about the reply, including a guest error and a transport failure, so nothing about the guest's files is learned after revocation. **An abort still wins over the recheck**: the abort check comes first, so a call that was aborted answers `file_unavailable` even if the scope was also revoked.
5. Parse. The echo must match the request: another workspace, session, location or path is `authority_denied` (a reply meant for another scope is never delivered); another incarnation, source revision or generation is `stale_file`.

| Condition | Code |
| --- | --- |
| Bad path, bad `maxBytes`/`offset`, unknown input key, bad options | `invalid_request` |
| Revoked, authority throws or answers garbage, reply bound to another scope | `authority_denied` (see the caveat below) |
| Incarnation, source revision or generation changed (before, during or per the reply) | `stale_file` |
| Workspace not running before the call; any frame that is not exactly the closed frame; abort; transport failure (message dropped) | `file_unavailable` |
| Frame, base64 text or decoded body over its bound | `response_too_large` |
| Offset, length and eof do not add up | `file_incomplete` |
| Guest-reported | `file_missing`, `file_unavailable`, `stale_file`, `file_incomplete`, `response_too_large`, `invalid_request`; any other code, including `authority_denied`, is `file_unavailable` |

**`authority_denied` from this client is not proof that the host revoked anything.** A guest can provoke it by echoing another workspace, session, location or path in its reply. Consumers must not treat it as a host-side revocation signal (for example, must not drop grants, mark a workspace revoked or tell the user access was withdrawn because of it); the host's own records are the only source for that. It means only "do not use this reply".

No code is added to `CoworkErrorCode`. A transport failure keeps only a read-failure code if it is a `CoworkError` with one; every other failure is a bare `file_unavailable`, so no message or path leaks.

**No per-call deadline.** The client imposes no timeout of its own: a reply that never comes is waited for forever, and so is a port that never answers. Consumers must pass a deadline as the call's signal (for example `{ signal: AbortSignal.timeout(ms) }`, or an `AbortSignal.any` of that and a session-teardown signal). The abort listener is removed when the call settles, so one long-lived signal can be reused across many calls without growing.

**Optional chunk size.** `maxBytes` is the one optional input. Absent, or explicitly `undefined` (an optional property passed straight through), it is the 64 KiB default; every other `undefined` or `null` input is `invalid_request`.

**Abort.** An abort before the call, while the reply is pending, or in the gap after the reply settled but before the call continues answers `file_unavailable` with no result. A late reply or late transport failure is dropped unparsed and never becomes an unhandled rejection. The caller's signal is passed to the port so a real transport can stop work.

## Decisions a reviewer should judge

- **Abort answers `file_unavailable`.** The taxonomy has no "cancelled" code and none was added. The caller knows it aborted.
- **A reply bound to another workspace, session, location or path is `authority_denied`,** not `file_unavailable`. It is a cross-scope reply, treated as an authority fact rather than a parse fault.
- **A vanished incarnation after the call is `stale_file`; before the call it is `file_unavailable`.** Before: nothing was sent, the workspace is simply stopped. After: the bytes may belong to an incarnation that no longer exists.
- **The guest may report `invalid_request`** (offset beyond the end, a path it rejects). The brief's minimal allowlist was the four file codes plus oversize; `invalid_request` lets a caller bug be told apart from unavailability. The guest can never say `authority_denied`.
- **Exact chunk length** (`min(maxBytes, bytes - offset)`) instead of "any non-empty prefix": loops stay predictable and a guest cannot dribble. A guest that cannot supply the bytes answers `file_incomplete`.
- **`read` always needs `expectedGeneration`** (stat first), like the host-backed reader.
- **Canonical JSON only** (exact re-serialization). Strict, cheap, and the TypeScript guest satisfies it for free.
- **Authority and incarnation come from one synchronous port.** Asynchronous host records would reopen the window the recheck exists to close.

## What the consumers will need next

| Consumer (contract row) | What it needs beyond this slice |
| --- | --- |
| Before/after file diffs | Guest-side snapshot capture for the authenticated tool call (the guest computes bounded diffs and the host stores events); `read` of both sides with one generation each; a total-size ceiling per diff, since this channel only bounds a chunk |
| LSP / diagnostics | Mostly guest-internal (confined Linux server and guest path resolver); the host needs only `stat` and bounded `read` for editor surfaces. Document-sync change notifications are a separate, later operation |
| Bash edited-file inference and `session_files` | `stat` facts (size, existence, generation) per candidate path, plus `list`/`lstat`-style kind (file, directory, symlink) that this slice deliberately lacks (`kind` is `"file"` only). The host index stores location id and guest cwd and keeps the inference-uncertainty flag |
| Composer images | The write direction: a bounded, host-validated upload that returns a guest-readable path and identity. This slice is read-only, so the write op needs its own authority sandwich (the same pre/post recheck, plus a commit acknowledgement) |
| File browser and exports | `list` (paged, bounded, no recursion by default); the visible-wake policy when `incarnationId` is null (`file_unavailable` is the signal, the consumer decides to wake); an explicit export op that moves only requested bytes; a whole-file reader helper that loops `readRange` under the consumer's own total ceiling and restarts on `stale_file` |

Also open before any consumer: the frame port (supervisor channel multiplexing, per-call correlation by `requestId`, back-pressure and a concurrency cap, which this client deliberately does not impose); the authority port (current workspace/session binding, source revision and recorded incarnation from the repository, plus the separate host grant check for any translated Mac access; the guest path is never handed to a privileged Mac API); the mapping from a stable location id to the source the guest path lives under; and the capability advertisement of the supported channel versions at the supervisor handshake.

## Validation

`packages/core/test/cowork/guest-file-channel.test.ts` uses an in-memory fake guest and fake authority only. It proves this module's logic: closed parse, bounds (including the exact 4096-byte path edge and the per-request base64 bound), offset/eof consistency, the authority sandwich (including hostile and asynchronous authority answers), stale incarnation/revision/generation, abort and listener hygiene, path validation, input hygiene, drift pins and the anti-wiring pin. It does not prove frame authenticity, guest confinement, transport behaviour, native admission or any real guest filesystem. No VM, worker, live home, Keychain, GUI or native test runs. Mutation checks (each applied, run, shown to fail the named test, reverted) are recorded in the pull request.
