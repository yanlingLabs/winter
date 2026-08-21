import Foundation

/// Office Stage A, Task 2 — **the whole vocabulary spoken over the office helper's Unix socket**,
/// compiled into BOTH `Norma` (the app) and `NormaOfficeHelper` (the helper) via two separate
/// xcodegen `sources` entries pointing at this one file — never a framework, per the brief
/// ("NOT a framework — keep it simple").
///
/// ## The transport deviation from the brief — read this before anything else in this file
///
/// The brief's Files section describes an XPC protocol (`OfficeHelperXPC` with
/// `open(docId:path:reply:)` / `close(docId:)` / `ping(reply:)`) for the app↔helper control plane,
/// with a *separate* NDJSON Unix socket reserved for the daemon's agent role. **Controller
/// resolution (pre-dispatch, recorded in the task-2 dispatch note in progress.md) overrides this
/// for Stage A**: an `NSXPCListenerEndpoint` cannot cross a plain Unix socket — it is a mach
/// object — so bootstrapping real XPC between an app and a helper it spawned directly (no
/// launchd, no prior mach handshake) needs a channel to hand the endpoint across in the first
/// place, which begs the question. The ONE constraint that actually forces XPC is IOSurface
/// (mach-port) transfer for tiles, and tiles are Task 4's problem, not this one.
///
/// So for Stage A: **both roles speak the same NDJSON-over-Unix-socket wire**, discriminated by
/// `role` in the `hello` frame. `open`/`close`/`ping` — the brief's app-role XPC methods — are
/// request/response frame PAIRS here instead of XPC calls-with-reply-blocks. The daemon's agent
/// role gets the same `hello` handshake (the "listener + role handshake land now" the plan's
/// architecture note promises); it has no further verbs in Stage A (Stage C is the consumer).
/// Task 4 owns the real surface-transport decision (XPC service target vs. a minimal mach
/// bootstrap vs. an mmap fallback) for IOSurfaces specifically, with a measurement argument.
///
/// ## The frame set
///
/// One flat `OfficeWireFrame` enum for both directions — client→helper requests
/// (`hello`/`ping`/`open`/`close`) and helper→client replies (`helloOk`/`refused`/`pong`/
/// `opened`/`closed`/`error`) — because both ends decode the same wire and a single exhaustive
/// vocabulary is what keeps them from drifting apart (the `wireTypes` parity discipline this
/// repo already uses for `TRANSIENT_EVENT_TYPES` and `EditorBridgeInbound`/`Outbound`).
///
/// **Every frame carries `seq`.** The caller mints it; the callee echoes it. This is how a
/// caller matches a reply to the request that provoked it on a connection that may have several
/// requests in flight (the same anchor discipline `EditorBridgeOutbound.pullContent`'s `seq`
/// documents at length).
///
/// **Refuse, never ignore.** A line the helper cannot map to a known request type gets
/// `error{seq,reason:"unknown"}` back — never silence. This is the `EditorBridgeHub` hub's own
/// rule, applied to a socket instead of a `cefQuery` slot: an unanswered line strands whatever
/// asked for something on the other end of a request/response protocol exactly as an unanswered
/// query strands a CEF callback.
public enum OfficeWireFrame: Equatable, Sendable {
    // MARK: Requests (client -> helper)

    /// Must be the FIRST frame on every connection — the helper refuses anything else as the
    /// opener (see `OfficeHelperServer`). `role` is bookkeeping for Stage A (Stage C's job is
    /// giving the daemon its own distinct credential); Task 2 checks `token` against the ONE
    /// value the helper was launched with, for either role — a disclosed Stage A simplification,
    /// not a security boundary between app and daemon (there is only one client at a time in
    /// Stage A; nothing consumes the agent role's own verbs yet).
    case hello(seq: UInt64, role: OfficeWireRole, token: String)
    /// A bare liveness probe, answerable at any point after a successful `hello`.
    case ping(seq: UInt64)
    /// Track a document as open. Task 3: `open` is now REAL — the helper's `LOKBridge` actually
    /// calls `documentLoad`. **Not idempotent for a docId already open** (a Task 2 simplification
    /// this task retires now that handles are real): a second `open` of the same `docId` gets
    /// `error{reason:"alreadyOpen"}` — see `OfficeHelperServer.handlePostAuthLine`'s own comment
    /// for the reasoning (a silent re-load would leak or double-own a real LOK document handle;
    /// `close` first is the honest way to reload). `path` is a plain filesystem path, converted to
    /// a `file://` URL internally — the caller never constructs the URL itself.
    case open(seq: UInt64, docId: String, path: String)
    /// Stop tracking a document — destroys its LOK handle for real (Task 3). Idempotent (unlike
    /// `open` above): closing an untracked `docId` still acks `closed` rather than erroring —
    /// there is no unsafe double-destruction risk here (a `docId` either has a live handle to
    /// destroy or it doesn't; either way "not open anymore" is true after this).
    case close(seq: UInt64, docId: String)

    /// Office Stage B Task 2 — ask the helper to render `docId`'s CURRENT in-memory state to a
    /// fresh file, in the document's own format, under the helper's own `--state-path` (never at
    /// the real document path — the seatbelt's write fence only ever allows writes under
    /// `--state-path`, Task 1's invariant, unchanged and untouched by this task). The APP is what
    /// places the helper's answer onto the real path afterward (`OfficeRuntime.perform`'s `.save`
    /// effect) — see `saved`'s own header for the two-step split this shape exists to honor, and
    /// why the helper is never asked to write to the real path directly.
    case save(seq: UInt64, docId: String)

    /// Office Stage B Task 4 — **the real edit verb.** LOK's `postKeyEvent(nType, nCharCode,
    /// nKeyCode)` (`LibreOfficeKit.h`), unchanged parameter-for-parameter across the wire. `charCode`
    /// is the Unicode scalar the key produces (0 for a non-printing key — arrows, Delete, bare
    /// modifiers); `keyCode` is a FULL VCL-packed value — `com.sun.star.awt.Key`'s base code (e.g.
    /// `512` for `A`) OR'd with SHIFTED modifier bits (`0x1000`/`0x2000`/`0x4000`/`0x8000` for
    /// Shift/Mod1/Mod2/Mod3), never the bare, unshifted `KeyModifier` group's `1/2/4/8`. This is not
    /// a guess: `SfxLokHelper::postKeyEventAsync` (`sfx2/source/view/lokhelper.cxx`) constructs
    /// `KeyEvent(nCharCode, nKeyCode, nRepeat)`, whose second parameter converts via
    /// `vcl::KeyCode(sal_uInt16 nKey, sal_uInt16 nModifier = 0)` — a SINGLE-argument implicit
    /// conversion (`nModifier` defaults to 0), so the ENTIRE incoming `int` becomes
    /// `nKeyCodeAndModifiers` verbatim (`include/vcl/keycod.hxx`). `OfficeInputCodes` is the one
    /// place that builds this packed value; see its own header for the AppKit-keyCode source and the
    /// cross-check against this repo's own independent `ComputerCapabilities.cuKeyCode` table.
    case keyEvent(seq: UInt64, docId: String, type: OfficeKeyEventType, charCode: Int, keyCode: Int)
    /// Office Stage B Task 4 — LOK's `postMouseEvent(nType, nX, nY, nCount, nButtons, nModifier)`.
    /// `xTwips`/`yTwips` are DOCUMENT-space twips (LOK's own coordinate system for this call —
    /// confirmed against `ScModelObj::postMouseEvent`, `sc/source/ui/unoobj/docuno.cxx`, which
    /// converts them via `GetPPTX()`/`GetPPTY()` the same way every other twips-space input this
    /// wire already carries is converted). `buttons` is VCL's `MOUSE_LEFT`(1)/`MIDDLE`(2)/`RIGHT`(4)
    /// bitmask (`include/vcl/event.hxx`) — UNLIKE `keyEvent`'s `keyCode`, this is NOT combined with
    /// `modifiers`: `MouseEvent`'s own constructor takes `nButtons`/`nModifier` as two SEPARATE
    /// `sal_uInt16` parameters, packed into the same low/high-bit split internally
    /// (`GetButtons()`/`IsShift()` etc. mask the identical field two different ways) but never
    /// combined by a CALLER. `modifiers` uses the SAME shifted encoding `keyEvent.keyCode`'s
    /// modifier half does (`OfficeInputCodes.modifierMask`) — confirmed by `MouseEvent::IsShift()`
    /// checking `mnCode & KEY_SHIFT` (`0x1000`), the identical constant `KeyCode::IsShift()` checks.
    case mouseEvent(seq: UInt64, docId: String, type: OfficeMouseEventType, xTwips: Int64, yTwips: Int64,
                     count: Int, buttons: Int, modifiers: Int)

    /// Task 4 — registers this connection as a tile-push subscriber for `docId` (must already be
    /// open — by ANY connection, not necessarily this one; see `OfficeHelperServer`'s multicast
    /// seam) and reports the tile-set the CURRENT viewport needs, computed via
    /// `TileMath.viewportTileKeys` — bookkeeping only, no painting happens here (the app decides
    /// what to `tileRequest`, lazily, per the brief's own "app re-requests lazily"). Re-subscribing
    /// (same connection, same or a different viewport) is idempotent: it just recomputes and
    /// re-reports the key list; it does not duplicate this connection in the doc's subscriber list.
    case subscribeTiles(seq: UInt64, docId: String, part: Int, zoomPPT: Int, viewportTwips: OfficeTwipsRect)
    /// Task 4 — the inverse of `subscribeTiles`: this connection stops receiving `invalidated`
    /// pushes for `docId`. Independent of `open`/`close` — a connection may unsubscribe from tile
    /// pushes while keeping (or not owning) the document open, and closing a document implicitly
    /// drops every subscriber (including the owner) without a separate `unsubscribe` needed.
    case unsubscribe(seq: UInt64, docId: String)
    /// Task 4 — asks for pixel data for specific tile coordinates. Answered in two stages: an
    /// immediate `tileRequestAccepted`/`error` reply (this frame's own `seq`), then EACH key's
    /// pixels stream separately as `tile`/`tileFailed` PUSHES (helper-minted seq) as they finish
    /// painting on the LOK thread — painting takes real, sometimes-slow time, so it is never made
    /// to block this request's own reply. Does not require an active `subscribeTiles` — a
    /// connection may fetch specific tiles without being a standing subscriber, though in practice
    /// every Stage-A caller subscribes first to learn which keys exist.
    case tileRequest(seq: UInt64, docId: String, keys: [TileKey])

    // MARK: Responses (helper -> client)

    /// `hello` succeeded: `token` matched. `lokVersion` is now (Task 3) the REAL
    /// `getVersionInfo()` `BuildId`, when this connection's peer is a real, LOK-booted helper.
    /// `NormaOfficeHelperFixture` (no real LOK — see `OfficeDocumentBridge`'s fake implementation)
    /// still honestly reports `officeWireStageALOKVersionPlaceholder` — that constant did not
    /// retire, it narrowed: it is now the fixture's own true self-description, not a Stage-A-wide
    /// placeholder.
    case helloOk(seq: UInt64, lokVersion: String)
    /// `hello` failed (token mismatch, or a malformed hello) — always the LAST frame the helper
    /// sends before it closes the connection; see `OfficeHelperServer`'s pre-auth gate.
    case refused(seq: UInt64, reason: String)
    /// Answers `ping`.
    case pong(seq: UInt64)
    /// Answers a successful `open`: the document loaded. Task 3 adds the three fields the brief's
    /// carry names literally (`opened{docId,type,parts,sizeTwips}`) — `type`/`parts`/`sizeTwips`
    /// mirror `OfficeDocumentEvent.opened`'s own payload (see that enum's header for why the two
    /// are not the same Swift case reused: this is a direct, seq-correlated RPC reply;
    /// `OfficeDocumentEvent` is the separate, general vocabulary for asynchronous pushes).
    case opened(seq: UInt64, docId: String, type: OfficeDocumentKind, parts: Int, sizeTwips: OfficeDocumentSize)
    /// Answers a failed `open` (Task 3 — new case; Task 2's `open` could not fail). `docId` echoes
    /// which open this answers (the brief's own shape is bare `openFailed{reason}`; `docId` is
    /// added here for symmetry with every other doc-scoped frame in this file and because a future
    /// pipelined client benefits from not having to track "which seq was which open" — a disclosed,
    /// minor literal deviation, not a semantic one). A garbage/corrupt file, an unreadable path, or
    /// any other `documentLoad` failure lands here — the helper always SURVIVES this (see
    /// `OfficeHelperServer`'s own comment on why a failed `documentLoad` never tears down the LOK
    /// kit, only the one document attempt).
    case openFailed(seq: UInt64, docId: String, reason: String)
    /// Answers a successful `close`.
    case closed(seq: UInt64, docId: String)
    /// Office Stage B Task 2 — answers a successful `save`: `tempPath` is where the helper rendered
    /// the document, ALWAYS under its own `--state-path` (`<state-path>/saves/<docId>-<seq>.<ext>`,
    /// `<ext>` the document's OWN format captured at open — see `LOKBridge`'s own doc). The helper's
    /// write fence has no concept of the real document path, and must never be asked to write
    /// there: placing these bytes onto the real path is entirely the APP's job — fsync+rename,
    /// cross-volume-safe (`OfficeRuntime.perform`'s `.save` case handles the EXDEV case a
    /// state-path-to-document-directory copy can hit, since the two need not share a filesystem).
    case saved(seq: UInt64, docId: String, tempPath: String)
    /// Office Stage B Task 2 — answers a failed `save`: a `saveAs` failure (a real disk problem
    /// under the helper's own `--state-path`, or a LOK internal save error). The helper always
    /// SURVIVES this, the same posture `openFailed` already has for a bad `open`.
    case saveFailed(seq: UInt64, docId: String, reason: String)
    /// Office Stage B Task 4 — answers `keyEvent`: the key was POSTED to LOK — not a claim it
    /// already took effect (`postKeyEvent` is `void` on LOK's own side, exactly as fire-and-forget
    /// as `postUnoCommand` was for the now-removed DEBUG-only `debugEdit` door this replaces — the
    /// "posted, not a claim of effect" wording is that retired reply's own, deliberately repeated
    /// here). The real effect is observed the same way every other Stage A/B async effect is:
    /// through the `documentEvent`/`invalidated` pushes that follow.
    case keyEventOk(seq: UInt64, docId: String)
    /// Office Stage B Task 4 — answers `mouseEvent`, same posture as `keyEventOk` above.
    case mouseEventOk(seq: UInt64, docId: String)
    /// Answers anything the helper refuses post-auth: an unknown frame type (`reason:"unknown"`,
    /// the brief's literal pin), a known type whose fields don't decode (`reason:"malformed"`),
    /// or a structurally valid frame that is never legal for a client to SEND (a reply shape —
    /// `reason:"unexpected"`), or a second `open` of an already-open `docId` (`reason:"alreadyOpen"`).
    case error(seq: UInt64, reason: String)
    /// Task 3 — the ONE new case for everything the helper pushes WITHOUT being asked: `seq` here
    /// is minted by the HELPER itself (a dedicated per-connection `OfficeWireSeqAllocator`, never
    /// the client's), because there is no client request to echo — it identifies wire ordering,
    /// not request/response correlation (contrast every other frame's `seq`, which the caller
    /// mints and the callee echoes). `docId` identifies which open document this is about.
    /// `event` is the payload — see `OfficeDocumentEvent`'s own header for the full vocabulary and
    /// why only two of its five cases are ever actually sent this way in Stage A.
    ///
    /// **Why a separate case instead of routing `invalidated`/`modifiedChanged` through `opened`/
    /// `closed` somehow**: those two are direct, seq-correlated replies consumed by
    /// `OfficeWireConnection`'s single-outstanding-request waiter; `documentEvent` frames are
    /// UNPROMPTED and must never compete for that same waiter slot — see
    /// `OfficeWireConnection.onDocumentEvent`'s own header for the real bug this shape avoids (a
    /// push arriving between two ordinary requests, misdelivered to whichever call is currently
    /// awaiting a reply). Routing by CASE (not by inspecting `seq`) is what lets the connection
    /// layer separate the two streams without knowing anything about outstanding request seqs.
    case documentEvent(seq: UInt64, docId: String, event: OfficeDocumentEvent)

    /// Task 4 — answers `subscribeTiles`: the tile-set the requested viewport currently needs
    /// (`TileMath.viewportTileKeys`, computed at request time — not cached against a future
    /// viewport change; the caller re-`subscribeTiles`s whenever its own viewport moves enough to
    /// matter, same "app decides, lazily" posture as tile fetching itself).
    case subscribed(seq: UInt64, docId: String, keys: [TileKey])
    /// Answers `unsubscribe`.
    case unsubscribed(seq: UInt64, docId: String)
    /// Answers `tileRequest`: the request itself was well-formed and `docId` is open — NOT a claim
    /// that every key will succeed; each key's own outcome arrives later as a `tile`/`tileFailed`
    /// push. A malformed request or an unopened `docId` gets `error{seq,reason}` instead of this.
    case tileRequestAccepted(seq: UInt64, docId: String)
    /// Task 4 — one tile's pixel payload, PUSHED (never a direct reply — see `tileRequest`'s own
    /// header) in response to a `tileRequest` that named this `key`. `seq` is minted by the
    /// receiving CONNECTION's own `OfficeWireSeqAllocator` (F8, T3 review: moved from a single
    /// server-wide allocator to one-per-`ConnectionWriter`, matching this doc comment's own
    /// original claim — see `OfficeHelperServer.ConnectionWriter`). `width`/`height` are always
    /// `TileMath.tilePixelSize` today but are sent explicitly rather than assumed, so a future
    /// change to that constant on one side alone cannot silently misinterpret the other side's
    /// pixel buffer.
    ///
    /// **Task 5.5 — rung 2 of the surface-transport decision (task-4-report.md rung 1; the T4
    /// review's own ruling): `pixels` is the raw RGBA buffer, never base64.** The wire envelope for
    /// THIS ONE frame type is no longer "one NDJSON line" the way every other frame in this file
    /// still is: `encodedLine()` for `.tile` emits only the HEADER (type/seq/docId/key/generation/
    /// width/height/`byteCount`), newline-terminated exactly like any other line; the `byteCount`
    /// raw bytes of `pixels` follow IMMEDIATELY after, with no framing of their own (no length
    /// prefix beyond `byteCount` itself, no trailing delimiter) — see `tilePayload` below, and
    /// `OfficeWireConnection.ingest`'s own header for why a plain newline scan cannot be used to
    /// find where the payload ends (raw RGBA bytes routinely contain `0x0A`). `OfficeHelperServer`'s
    /// `pushFrame`/`writeFrameLocked` write both parts under the SAME connection write-lock hold, so
    /// no other frame (a reply, or another push) can ever land bytes between the header and its
    /// payload. This case's own Swift shape is otherwise unchanged from rung 1 — `pixels` is exactly
    /// what `pixelsBase64` used to decode to, byte-for-byte (the transport envelope changed; the
    /// pixel content did not — the live product-path hash pins are the tripwire for that claim).
    case tile(seq: UInt64, docId: String, key: TileKey, generation: Int, width: Int, height: Int, pixels: Data)
    /// The failure counterpart to `tile` — refuse-never-ignore extended to the per-key granularity
    /// `tileRequest` introduces: every key named in an accepted `tileRequest` gets EITHER a `tile`
    /// OR a `tileFailed` push, never silence, even though the request itself already succeeded.
    case tileFailed(seq: UInt64, docId: String, key: TileKey, reason: String)
    /// Task 4 — pushed to every current subscriber of `docId` (the multicast fan-out —
    /// `OfficeHelperServer`'s `DocEntry.connections`) whenever a real invalidation bumps one or
    /// more cached tile generations (`TileCache.invalidate`'s return value, translated 1:1 into
    /// this frame's `keys`). Deliberately NOT scoped to any one subscriber's own last-known
    /// viewport — the helper reports every bumped key regardless of who currently cares, and each
    /// subscriber filters locally against its own active tile-set (the same "app decides, lazily"
    /// posture `tileRequest` already has) rather than the server tracking per-connection viewports
    /// on an ongoing basis. Shares its base name with `OfficeDocumentEvent.invalidated` by design.
    /// (matching this file's own established precedent of `OfficeWireFrame.opened`/`closed`
    /// sharing names with their `OfficeDocumentEvent` counterparts) — the two are DIFFERENT wire
    /// shapes serving different purposes: `OfficeDocumentEvent.invalidated` carries LOK's raw,
    /// untranslated rects/part (unchanged since Task 3); THIS case carries the already-computed
    /// tile coordinates those rects touched. Both are sent — see `OfficeHelperServer.routeDocumentEvent`.
    case invalidated(seq: UInt64, docId: String, keys: [TileKey])

    /// The wire vocabulary, in frame-declaration order. A test walks this list the same way
    /// `EditorBridgeInbound.wireTypes`'s own test does — one fixture per name, decode, assert the
    /// case names itself the same way — so this array and `decode`/`wireType` cannot drift apart
    /// unnoticed.
    /// Office Stage B Task 4 — reverted to a plain array literal: the DEBUG-only `debugEdit`/
    /// `debugEditOk` entries (which previously forced a closure-building shape, since `#if` cannot
    /// appear directly inside `[...]`'s element list) are gone — real edit verbs replace them.
    /// Order still matches frame-declaration order.
    public static let wireTypes: [String] = [
        "hello", "ping", "open", "close", "save", "keyEvent", "mouseEvent",
        "subscribeTiles", "unsubscribe", "tileRequest",
        "helloOk", "refused", "pong", "opened", "openFailed", "closed", "saved", "saveFailed",
        "keyEventOk", "mouseEventOk",
        "error", "documentEvent",
        "subscribed", "unsubscribed", "tileRequestAccepted", "tile", "tileFailed", "invalidated",
    ]

    public var wireType: String {
        switch self {
        case .hello: return "hello"
        case .ping: return "ping"
        case .open: return "open"
        case .close: return "close"
        case .save: return "save"
        case .keyEvent: return "keyEvent"
        case .mouseEvent: return "mouseEvent"
        case .subscribeTiles: return "subscribeTiles"
        case .unsubscribe: return "unsubscribe"
        case .tileRequest: return "tileRequest"
        case .helloOk: return "helloOk"
        case .refused: return "refused"
        case .pong: return "pong"
        case .opened: return "opened"
        case .openFailed: return "openFailed"
        case .closed: return "closed"
        case .saved: return "saved"
        case .saveFailed: return "saveFailed"
        case .keyEventOk: return "keyEventOk"
        case .mouseEventOk: return "mouseEventOk"
        case .error: return "error"
        case .documentEvent: return "documentEvent"
        case .subscribed: return "subscribed"
        case .unsubscribed: return "unsubscribed"
        case .tileRequestAccepted: return "tileRequestAccepted"
        case .tile: return "tile"
        case .tileFailed: return "tileFailed"
        case .invalidated: return "invalidated"
        }
    }

    public var seq: UInt64 {
        switch self {
        case .hello(let seq, _, _): return seq
        case .ping(let seq): return seq
        case .open(let seq, _, _): return seq
        case .close(let seq, _): return seq
        case .save(let seq, _): return seq
        case .keyEvent(let seq, _, _, _, _): return seq
        case .mouseEvent(let seq, _, _, _, _, _, _, _): return seq
        case .subscribeTiles(let seq, _, _, _, _): return seq
        case .unsubscribe(let seq, _): return seq
        case .tileRequest(let seq, _, _): return seq
        case .helloOk(let seq, _): return seq
        case .refused(let seq, _): return seq
        case .pong(let seq): return seq
        case .opened(let seq, _, _, _, _): return seq
        case .openFailed(let seq, _, _): return seq
        case .closed(let seq, _): return seq
        case .saved(let seq, _, _): return seq
        case .saveFailed(let seq, _, _): return seq
        case .keyEventOk(let seq, _): return seq
        case .mouseEventOk(let seq, _): return seq
        case .error(let seq, _): return seq
        case .documentEvent(let seq, _, _): return seq
        case .subscribed(let seq, _, _): return seq
        case .unsubscribed(let seq, _): return seq
        case .tileRequestAccepted(let seq, _): return seq
        case .tile(let seq, _, _, _, _, _, _): return seq
        case .tileFailed(let seq, _, _, _): return seq
        case .invalidated(let seq, _, _): return seq
        }
    }

    /// One NDJSON line: `type` + `seq` + this case's own fields, `\n`-terminated, nothing else on
    /// the line. `.sortedKeys` for a deterministic byte encoding (useful for eyeballing a capture
    /// or pinning a fixture; not load-bearing for correctness since decode compares structurally).
    public func encodedLine() -> Data {
        var payload: [String: Any] = ["type": wireType, "seq": seq]
        switch self {
        case .hello(_, let role, let token):
            payload["role"] = role.rawValue
            payload["token"] = token
        case .ping, .pong:
            break
        case .open(_, let docId, let path):
            payload["docId"] = docId
            payload["path"] = path
        case .close(_, let docId), .closed(_, let docId), .save(_, let docId):
            payload["docId"] = docId
        case .keyEvent(_, let docId, let type, let charCode, let keyCode):
            payload["docId"] = docId
            payload["eventType"] = type.rawValue
            payload["charCode"] = charCode
            payload["keyCode"] = keyCode
        case .mouseEvent(_, let docId, let type, let xTwips, let yTwips, let count, let buttons, let modifiers):
            payload["docId"] = docId
            payload["eventType"] = type.rawValue
            payload["xTwips"] = xTwips
            payload["yTwips"] = yTwips
            payload["count"] = count
            payload["buttons"] = buttons
            payload["modifiers"] = modifiers
        case .keyEventOk(_, let docId), .mouseEventOk(_, let docId):
            payload["docId"] = docId
        case .saved(_, let docId, let tempPath):
            payload["docId"] = docId
            payload["tempPath"] = tempPath
        case .saveFailed(_, let docId, let reason):
            payload["docId"] = docId
            payload["reason"] = reason
        case .opened(_, let docId, let type, let parts, let size):
            payload["docId"] = docId
            payload["docType"] = type.rawValue
            payload["parts"] = parts
            payload["widthTwips"] = size.widthTwips
            payload["heightTwips"] = size.heightTwips
        case .openFailed(_, let docId, let reason):
            payload["docId"] = docId
            payload["reason"] = reason
        case .helloOk(_, let lokVersion):
            payload["lokVersion"] = lokVersion
        case .refused(_, let reason), .error(_, let reason):
            payload["reason"] = reason
        case .documentEvent(_, let docId, let event):
            payload["docId"] = docId
            for (key, value) in event.encodedFields() { payload[key] = value }
        case .subscribeTiles(_, let docId, let part, let zoomPPT, let viewportTwips):
            payload["docId"] = docId
            payload["part"] = part
            payload["zoomPPT"] = zoomPPT
            payload["viewportTwips"] = Self.encodeRect(viewportTwips)
        case .unsubscribe(_, let docId), .unsubscribed(_, let docId), .tileRequestAccepted(_, let docId):
            payload["docId"] = docId
        case .tileRequest(_, let docId, let keys):
            payload["docId"] = docId
            payload["keys"] = keys.map { $0.jsonObject() }
        case .subscribed(_, let docId, let keys), .invalidated(_, let docId, let keys):
            payload["docId"] = docId
            payload["keys"] = keys.map { $0.jsonObject() }
        case .tile(_, let docId, let key, let generation, let width, let height, let pixels):
            // Task 5.5: the header line carries `byteCount`, never the pixel bytes themselves —
            // see this case's own doc comment. `encodedLine()` for `.tile` is therefore ONLY ever
            // half of the wire envelope; callers that need the other half read `tilePayload` below.
            payload["docId"] = docId
            payload["key"] = key.jsonObject()
            payload["generation"] = generation
            payload["width"] = width
            payload["height"] = height
            payload["byteCount"] = pixels.count
        case .tileFailed(_, let docId, let key, let reason):
            payload["docId"] = docId
            payload["key"] = key.jsonObject()
            payload["reason"] = reason
        }
        let line: String
        if let json = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
           let rendered = String(data: json, encoding: .utf8) {
            line = rendered
        } else {
            // Unreachable — every payload above is strings and a UInt64 — but a frame that fails
            // to render is not silence: fall back to the bare envelope so the seq still crosses.
            line = "{\"type\":\"\(wireType)\",\"seq\":\(seq)}"
        }
        return Data((line + "\n").utf8)
    }

    /// Plain decode: a known frame, or `nil`. Used where the caller only cares "did this parse" —
    /// a client reading a reply, or a round-trip test. Servers wanting the seq-recovering
    /// three-way split (needed to answer an unknown TYPE with its own `seq`) use
    /// `OfficeWireCodec.decodeInbound` instead.
    public static func decode(_ line: String) -> OfficeWireFrame? {
        if case .frame(let frame) = OfficeWireCodec.decodeInbound(line) { return frame }
        return nil
    }

    /// Task 5.5 — the raw bytes that must follow this frame's `encodedLine()` header on the wire,
    /// or `nil` for every frame except `.tile` (the ONE case whose envelope is more than one NDJSON
    /// line — see that case's own doc comment). `OfficeHelperServer.writeFrameLocked` writes
    /// `encodedLine()` then, if this is non-nil, these bytes too, under the SAME connection
    /// write-lock hold — the two writes must never be split across an interleaving push.
    public var tilePayload: Data? {
        if case .tile(_, _, _, _, _, _, let pixels) = self { return pixels }
        return nil
    }

    // MARK: - Task 4 shared field encoders (rects, tile-key arrays)

    static func encodeRect(_ rect: OfficeTwipsRect) -> [String: Any] {
        ["x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height]
    }

    static func decodeRect(_ object: Any?) -> OfficeTwipsRect? {
        guard let dict = object as? [String: Any],
              let x = int64Value(dict["x"]), let y = int64Value(dict["y"]),
              let width = int64Value(dict["width"]), let height = int64Value(dict["height"]) else {
            return nil
        }
        return OfficeTwipsRect(x: x, y: y, width: width, height: height)
    }

    static func decodeTileKeys(_ object: Any?) -> [TileKey]? {
        guard let array = object as? [[String: Any]] else { return nil }
        var keys: [TileKey] = []
        keys.reserveCapacity(array.count)
        for item in array {
            guard let key = TileKey.decode(item) else { return nil }
            keys.append(key)
        }
        return keys
    }
}

/// `hello`'s role field. `agent` is the daemon (Stage C consumer; the handshake alone lands now).
public enum OfficeWireRole: String, Equatable, Sendable {
    case app
    case agent
}

/// LOK's `LibreOfficeKitKeyEventType` (`LibreOfficeKitEnums.h:1076-1080`) — a direct 1:1 mirror
/// (`rawValue` IS the wire integer, no translation table needed, unlike `OfficeDocumentKind`):
/// `LOK_KEYEVENT_KEYINPUT = 0` (implicit first enumerator), `LOK_KEYEVENT_KEYUP = 1`.
public enum OfficeKeyEventType: Int, Equatable, Sendable {
    case keyInput = 0
    case keyUp = 1
}

/// LOK's `LibreOfficeKitMouseEventType` (`LibreOfficeKitEnums.h:1253-1261`) — same direct 1:1
/// mirror as `OfficeKeyEventType`: `LOK_MOUSEEVENT_MOUSEBUTTONDOWN = 0`,
/// `LOK_MOUSEEVENT_MOUSEBUTTONUP = 1`, `LOK_MOUSEEVENT_MOUSEMOVE = 2`.
public enum OfficeMouseEventType: Int, Equatable, Sendable {
    case buttonDown = 0
    case buttonUp = 1
    case move = 2
}

/// LOK's `LibreOfficeKitDocumentType` (`LibreOfficeKitEnums.h:22-27`), transcribed rather than
/// imported — that header is not safely importable outside a C++ translation unit (see
/// `LOKBridge.swift`'s header for the full reason) — restricted to the three kinds the brief names
/// (`documentType (text/spreadsheet/presentation)`) plus `drawing`/`other` for TOTALITY: LOK's
/// `getDocumentType()` returns a plain `int`, and every one of its five values must map to
/// something rather than trap, even though none of Task 3's six fixtures produce `drawing`/`other`.
public enum OfficeDocumentKind: String, Equatable, Sendable {
    case text
    case spreadsheet
    case presentation
    case drawing
    case other

    /// `nType` is LOK's raw `int` from `getDocumentType()`. `LOK_DOCTYPE_TEXT = 0` (implicit
    /// first enumerator), `SPREADSHEET = 1`, `PRESENTATION = 2`, `DRAWING = 3`, `OTHER = 4` —
    /// `LibreOfficeKitEnums.h:22-27`.
    init(lokDocumentType nType: Int32) {
        switch nType {
        case 0: self = .text
        case 1: self = .spreadsheet
        case 2: self = .presentation
        case 3: self = .drawing
        default: self = .other
        }
    }
}

/// A document's page/canvas size in twips (1/1440 inch — LOK's native unit), from
/// `getDocumentSize()`'s two `long*` out-params. `Int64`: C `long` is 64-bit on arm64 Darwin, and
/// this crosses the wire as a JSON number either way, so there is no reason to narrow it.
public struct OfficeDocumentSize: Equatable, Sendable {
    public let widthTwips: Int64
    public let heightTwips: Int64
    public init(widthTwips: Int64, heightTwips: Int64) {
        self.widthTwips = widthTwips
        self.heightTwips = heightTwips
    }
}

/// The metadata a successful `open` reports — `OfficeWireFrame.opened`'s payload, decoupled from
/// the wire type itself so `OfficeDocumentBridge` (`OfficeHelperServer.swift`, helper-side only)
/// doesn't need to depend on wire framing. Lives HERE, not beside `OfficeDocumentBridge` itself,
/// because BOTH sides need it: the app's `OfficeHelperClient.open()` (`AppShell`, compiled into
/// `Norma`) returns it, and `OfficeHelperServer.swift`'s `Sources/OfficeHelper` tree — where
/// `OfficeDocumentBridge` itself lives — is EXCLUDED from `Norma`'s own sources sweep (project.yml:
/// `Sources/OfficeHelper/main.swift` would collide with `Sources/App/main.swift`, so the whole
/// directory is excluded, not just that one file) — a type the app needs cannot live in a file the
/// app never compiles.
public struct OfficeDocumentMetadata: Equatable, Sendable {
    public let type: OfficeDocumentKind
    public let parts: Int
    public let sizeTwips: OfficeDocumentSize
    public init(type: OfficeDocumentKind, parts: Int, sizeTwips: OfficeDocumentSize) {
        self.type = type
        self.parts = parts
        self.sizeTwips = sizeTwips
    }
}

/// One invalidation rectangle in document (twips) coordinates — LOK's `LOK_CALLBACK_INVALIDATE_TILES`
/// payload format, `"x, y, width, height"` (`LibreOfficeKitEnums.h:124-126`).
public struct OfficeTwipsRect: Equatable, Sendable {
    public let x: Int64
    public let y: Int64
    public let width: Int64
    public let height: Int64
    public init(x: Int64, y: Int64, width: Int64, height: Int64) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

/// Task 3 — the callback event vocabulary produced for T4/T5, exactly the five cases the brief
/// names (`opened{type,parts,sizeTwips}`, `openFailed{reason}`, `invalidated{rectsTwips,part}`,
/// `modifiedChanged{Bool}`, `closed`). Lives here (not in `OfficeHelper` or `AppShell`) because
/// BOTH the helper (constructs it from LOK callbacks) and the app (decodes it off the wire) need
/// the same type — the same reason `OfficeWireFrame` itself is shared.
///
/// **Only two cases are ever actually sent this way in Stage A**: `invalidated`/`modifiedChanged`,
/// via `OfficeWireFrame.documentEvent` (the async push case — see its own header). `opened`/
/// `openFailed`/`closed` are covered for Stage A's own `open`/`close` verbs by the DIRECT,
/// seq-correlated reply frames (`OfficeWireFrame.opened`/`.openFailed`/`.closed`), which is simpler
/// and lower-risk than routing a synchronous RPC reply through the same channel as an unprompted
/// push. This enum still declares all five: it is the complete, general vocabulary "everything
/// that can happen to a document" — the brief's own words, "consumed by T4/T5" — and a future
/// multi-client/multicast/replay-on-attach consumer (the T4 carry already anticipates this) has a
/// natural, ALREADY-DEFINED case to push `opened`/`closed` through uniformly once one exists,
/// without a wire-shape change. A disclosed design choice, not an oversight.
public enum OfficeDocumentEvent: Equatable, Sendable {
    case opened(type: OfficeDocumentKind, parts: Int, sizeTwips: OfficeDocumentSize)
    case openFailed(reason: String)
    /// `rectsTwips` is plural/an array (the brief's own field name) even though a single stock LOK
    /// `LOK_CALLBACK_INVALIDATE_TILES` firing carries exactly one rectangle, or the string
    /// `"EMPTY"` meaning "the whole document" — represented here as an EMPTY array, documented at
    /// the one call site that constructs it (`LOKBridge`'s callback trampoline). The array shape is
    /// forward-compatible with a future coalesced/batched-rects producer without another wire
    /// change. `part` is present because `LOK_FEATURE_PART_IN_INVALIDATION_CALLBACK` is enabled at
    /// boot (`LOKBridge`), which appends the part number as the payload's 5th value.
    ///
    /// **Fix round 1, F3 — corrected: `"EMPTY"` DOES carry a part number, always, once the
    /// part-in-invalidation feature is on.** `RectangleAndPart::toString()` (LO core,
    /// `desktop/inc/lib/init.hxx`) is unconditional about this: `if (m_nPart >= -1) return
    /// (isInfinite() ? "EMPTY" : rect) + ", " + part + ", " + mode;` — a whole-document
    /// invalidation is `"EMPTY, <part>, <mode>"` on the wire, not bare `"EMPTY"`, whenever
    /// `isPartInInvalidation()` is true (which `LOKBridge` always sets). `part` for this case can
    /// legitimately be `-1` — LO's own "all parts" sentinel (`init.hxx`'s own `m_nPart(INT_MIN)`/
    /// "-1 is reserved to mean 'all parts'" comment; `SfxLokHelper::notifyInvalidation`'s single-
    /// rectangle overload can be called with an explicit `-1`) — harmless here since the EMPTY case
    /// already bumps every part regardless (`TileCache.invalidate`'s own doc), but a NON-empty rect
    /// can carry `-1` too; see that method's own fix-round doc for how it now honors that.
    case invalidated(rectsTwips: [OfficeTwipsRect], part: Int)
    case modifiedChanged(Bool)
    case closed

    /// This case's own fields, flattened into the SAME single-level JSON object
    /// `OfficeWireFrame.encodedLine()` builds for a `.documentEvent` frame — `kind` is the
    /// discriminant (named `kind`, not `type`, to not collide with the outer frame's own `type`
    /// key, which is always the literal string `"documentEvent"`). Matches this file's established
    /// flat, single-nesting-level style (no case anywhere in `OfficeWireFrame` nests a JSON object).
    func encodedFields() -> [String: Any] {
        switch self {
        case .opened(let type, let parts, let size):
            return ["kind": "opened", "docType": type.rawValue, "parts": parts,
                    "widthTwips": size.widthTwips, "heightTwips": size.heightTwips]
        case .openFailed(let reason):
            return ["kind": "openFailed", "reason": reason]
        case .invalidated(let rects, let part):
            let encodedRects = rects.map { rect -> [String: Any] in
                ["x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height]
            }
            return ["kind": "invalidated", "rectsTwips": encodedRects, "part": part]
        case .modifiedChanged(let modified):
            return ["kind": "modifiedChanged", "modified": modified]
        case .closed:
            return ["kind": "closed"]
        }
    }

    /// The inverse of `encodedFields()`, reading from the SAME flat object a `.documentEvent`
    /// frame decodes (`object` already has `type`/`seq`/`docId` verified by the caller —
    /// `OfficeWireCodec.decodeInbound`'s `"documentEvent"` case). `nil` for any unrecognized
    /// `kind` or missing/mistyped field — the caller folds that into the frame-level `"malformed"`
    /// rejection, same discipline as every other case in this file.
    static func decodeFields(_ object: [String: Any]) -> OfficeDocumentEvent? {
        guard let kind = object["kind"] as? String else { return nil }
        switch kind {
        case "opened":
            guard let typeRaw = object["docType"] as? String, let type = OfficeDocumentKind(rawValue: typeRaw),
                  let parts = intValue(object["parts"]),
                  let widthTwips = int64Value(object["widthTwips"]),
                  let heightTwips = int64Value(object["heightTwips"]) else { return nil }
            return .opened(type: type, parts: parts, sizeTwips: OfficeDocumentSize(widthTwips: widthTwips, heightTwips: heightTwips))
        case "openFailed":
            guard let reason = object["reason"] as? String else { return nil }
            return .openFailed(reason: reason)
        case "invalidated":
            guard let rawRects = object["rectsTwips"] as? [[String: Any]],
                  let part = intValue(object["part"]) else { return nil }
            var rects: [OfficeTwipsRect] = []
            for rawRect in rawRects {
                guard let x = int64Value(rawRect["x"]), let y = int64Value(rawRect["y"]),
                      let width = int64Value(rawRect["width"]), let height = int64Value(rawRect["height"]) else {
                    return nil
                }
                rects.append(OfficeTwipsRect(x: x, y: y, width: width, height: height))
            }
            return .invalidated(rectsTwips: rects, part: part)
        case "modifiedChanged":
            // Same NSNumber-boolean-trap shape as everywhere else in this file, inverted: THIS
            // field must actually BE a boolean (every other use rejects one).
            guard let number = object["modified"] as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
                return nil
            }
            return .modifiedChanged(number.boolValue)
        case "closed":
            return .closed
        default:
            return nil
        }
    }

    // MARK: - LOK raw callback payload parsing

    /// Parses `LOK_CALLBACK_INVALIDATE_TILES`'s raw payload: `"x, y, width, height"` in twips,
    /// `"x, y, width, height, part, mode"` with `LOK_FEATURE_PART_IN_INVALIDATION_CALLBACK` set
    /// (always, in `LOKBridge`), or `"EMPTY"` — with the SAME optional `", part, mode"` suffix —
    /// meaning "the whole document" (`LibreOfficeKitEnums.h:120-129`). `nil` for anything that
    /// doesn't parse as either shape.
    ///
    /// **Fix round 1, F3 (CRITICAL — a real, confirmed bug, not a hardening nice-to-have): a bare
    /// `trimmed == "EMPTY"` exact-match used to be the ONLY accepted whole-document shape.** With
    /// `LOK_FEATURE_PART_IN_INVALIDATION_CALLBACK` on (always, in `LOKBridge`), LO's own writer
    /// (`RectangleAndPart::toString()`, `desktop/inc/lib/init.hxx`, fetched and read directly, not
    /// guessed) NEVER emits bare `"EMPTY"` — it unconditionally appends `", " + part + ", " + mode`
    /// whenever `m_nPart >= -1`, i.e. the real wire shape is `"EMPTY, 0, 0"` (or whatever part/mode
    /// happen to be). The old exact-match rejected that: it fell through to the numeric-rect branch,
    /// `Int64("EMPTY")` failed, and the WHOLE callback was silently dropped — a genuine
    /// whole-document invalidation that never reached `TileCache.invalidate` at all, leaving stale
    /// pixels no scroll/zoom could ever correct (nothing re-marks a key "stale" if the invalidation
    /// that should have done so was never parsed in the first place). Fixed below by matching on
    /// `fields[0] == "EMPTY"` rather than the whole trimmed string, mirroring LO's OWN reader's
    /// leniency (`RectangleAndPart::Create`, same file: part is read if present, mode is optional
    /// even then) — this parser now accepts bare `"EMPTY"`, `"EMPTY, <part>"`, and `"EMPTY, <part>,
    /// <mode>"` alike, discarding mode (`OfficeDocumentEvent.invalidated` carries no mode field).
    ///
    /// Lives here (not on `LOKBridge`, its one real caller) so a test can reach it at all:
    /// `LOKBridge` is a `type: tool` Xcode target no test bundle can import. Task 4's live callback
    /// probe (`OfficeHelperLiveTests.testRealLOKCallbackProbeCapturesRawPayloadsAndCrossChecksThe
    /// Parsers`) DOES now provoke real LOK callbacks over open+paintTile+close, so this parser is no
    /// longer permanently zero-coverage against real firings — but that probe observed **zero**
    /// `LOK_CALLBACK_INVALIDATE_TILES` firings against a view-only document with no edit verb
    /// available (Stage A ships none); Task 4's OWN live edit tests are what first observed a real
    /// firing (the 6-field, non-EMPTY rect shape) — see `OfficeHelperLiveTests`' criterion-1 test.
    /// The EMPTY shape specifically remains cross-checked only against real UPSTREAM SOURCE (this
    /// comment's own citations), not yet against a captured live EMPTY firing — Stage B's own edit
    /// traffic so far has stayed within one already-visible tile range, never triggered a genuine
    /// whole-document invalidation (a format change, a huge paste, a full recalc). Revisit the day
    /// one is captured live.
    ///
    /// **Re-judged leniency (Task 4, debt #1), one clause at a time:**
    /// - `"EMPTY"` and the 4-field shape: both structurally reachable and both covered by the table
    ///   test; no real firing was observed to cross-check either, but neither is a leniency question
    ///   — they're the two documented shapes, not a fallback.
    /// - **The `fields[4] ?? 0` part-defaulting IS the leniency in question, and it stays
    ///   unjudged, honestly**: zero real `INVALIDATE_TILES` firings means zero real 5-field-vs-4-field
    ///   payloads to check the default against. `LOK_FEATURE_PART_IN_INVALIDATION_CALLBACK` is set
    ///   unconditionally in `LOKBridge`, so production should always get 5 fields when this callback
    ///   ever DOES fire — but that claim is a header-doc reading, not something Task 4's probe
    ///   confirmed live. Structurally unreachable until a Stage-B edit verb exists to provoke a real
    ///   invalidation; revisit this comment the day one does. **Fix round 1 update**: Task 4's own
    ///   live edit traffic DID cross-check this — real firings observed 6 fields, always with a
    ///   parseable `fields[4]`, never exercising the default. The default itself (garbage or a
    ///   missing 5th field) is still unexercised by real data.
    static func parseInvalidateTiles(_ payload: String) -> OfficeDocumentEvent? {
        let trimmed = payload.trimmingCharacters(in: .whitespaces)
        let fields = trimmed.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        guard let first = fields.first else { return nil }
        if first == "EMPTY" {
            // Fix round 1, F3: part (and, if present, mode) after "EMPTY" — see this function's own
            // header. `part` can legitimately be `-1` ("all parts") — passed through unchanged;
            // `TileCache.invalidate`'s empty-rects branch already ignores `part` entirely, so `-1`
            // is indistinguishable from any other value there (harmless either way).
            let part = fields.count >= 2 ? (Int(fields[1]) ?? 0) : 0
            return .invalidated(rectsTwips: [], part: part)
        }
        guard fields.count >= 4,
              let x = Int64(fields[0]), let y = Int64(fields[1]),
              let width = Int64(fields[2]), let height = Int64(fields[3]) else {
            return nil
        }
        // `Int` parses a leading "-" natively — `part == -1` ("all parts," the same LO sentinel the
        // EMPTY branch above can carry) survives this unchanged; `TileCache.invalidate`'s own
        // fix-round update is what makes a NON-empty rect actually honor it.
        let part = fields.count >= 5 ? (Int(fields[4]) ?? 0) : 0
        return .invalidated(rectsTwips: [OfficeTwipsRect(x: x, y: y, width: width, height: height)], part: part)
    }

    /// Parses `LOK_CALLBACK_STATE_CHANGED`'s raw payload. That callback fires for many `.uno:*`
    /// state changes (Bold, Italic, ...) — `LibreOfficeKitEnums.h:224-229`'s own doc comment gives
    /// `.uno:Bold=true` as its example. Stage A only cares about `.uno:ModifiedStatus` (dirty
    /// tracking); every other state-changed payload is ignored (returns `nil`, folded into "not a
    /// callback type this vocabulary covers" by the caller). Same test-reachability rationale as
    /// `parseInvalidateTiles` above — UNLIKE that function, this one WAS cross-checked against a
    /// real firing: Task 4's live probe observed a genuine `.uno:ModifiedStatus=false` payload from
    /// opening `gate.xlsx`, and this function parsed it correctly (`.modifiedChanged(false)`).
    ///
    /// **Re-judged leniency (Task 4, debt #1): the `== "true"` fallback-to-false for any non-"true"
    /// suffix.** The one real firing observed was a clean, well-formed `"false"` — the leniency
    /// itself (what happens on garbage after the `=`) remains unexercised by real data. Kept as the
    /// safe default: every real `.uno:ModifiedStatus` firing this codebase's own LOK vendor tree is
    /// documented to emit is exactly `"true"` or `"false"` (`LibreOfficeKitEnums.h`'s own example),
    /// so folding anything else to `false` fails closed (never reports "dirty" on a payload shape
    /// nobody has ever actually seen) rather than crashing or mis-parsing outward.
    static func parseModifiedStatus(_ payload: String) -> OfficeDocumentEvent? {
        let prefix = ".uno:ModifiedStatus="
        guard payload.hasPrefix(prefix) else { return nil }
        return .modifiedChanged(payload.dropFirst(prefix.count) == "true")
    }
}

/// Task 2 introduced this as a Stage-A-wide placeholder (no LibreOfficeKit loaded anywhere yet).
/// Task 3 NARROWS it rather than retiring it: the real `NormaOfficeHelper` now reports the real
/// `getVersionInfo()` `BuildId` (see `OfficeHelperServer`'s `hello` handler and `LOKBridge`), but
/// `NormaOfficeHelperFixture` (`OfficeSupervisorTests`' spy binary) still has no real LOK — see
/// `Tests/OfficeHelperFixtureSources/main.swift`'s fake `OfficeDocumentBridge` — and reporting this
/// exact string remains its own honest self-description, not a stand-in for something realer. Four
/// pinned call sites move together with any future change here: this constant, `OfficeHelperServer`
/// (the fixture's fake bridge), `OfficeHelperLiveSmokeTests` (now real-LOK, no longer uses this
/// constant), and `OfficeSupervisorTests` (still fixture-backed, still uses it) — grep before
/// touching any one of them.
public let officeWireStageALOKVersionPlaceholder = "lok-not-loaded"

/// Task 5.5 — a `.tile` frame's HEADER, decoded from its NDJSON line alone — everything
/// `OfficeWireFrame.tile` carries except the pixel bytes themselves, which are never part of the
/// line (see that case's own doc comment). Lives here, not as a nested type, because both
/// `OfficeWireCodec.decodeInbound` (produces it) and `OfficeWireConnection.ingest` (the one real
/// consumer — combines it with `byteCount` raw bytes read off the stream to synthesize a complete
/// `OfficeWireFrame.tile`) need it, and it is meaningless without the codec that produces it.
public struct TileWireHeader: Equatable, Sendable {
    public let seq: UInt64
    public let docId: String
    public let key: TileKey
    public let generation: Int
    public let width: Int
    public let height: Int
    /// How many raw bytes follow this header line on the wire. Structurally validated here only as
    /// "a non-negative integer" (`OfficeWireCodec.decodeInbound`'s own decode-level contract,
    /// mirroring `unsignedSeq`'s discipline) — the SEMANTIC policy question ("is this a size we are
    /// willing to trust/allocate for") is deliberately NOT this type's job; see
    /// `OfficeWireConnection.ingest`'s own exact-size-or-refuse check, which is where that decision
    /// is made and documented.
    public let byteCount: Int
    public init(seq: UInt64, docId: String, key: TileKey, generation: Int, width: Int, height: Int, byteCount: Int) {
        self.seq = seq
        self.docId = docId
        self.key = key
        self.generation = generation
        self.width = width
        self.height = height
        self.byteCount = byteCount
    }
}

/// The result of trying to read one NDJSON line as a frame a HELPER must answer. Three-way so the
/// helper can always echo the caller's real `seq` when it has one, and only fall back to the
/// seq-unknown sentinel when the line gave it no seq at all.
///
/// **Task 5.5 adds a fourth case, `.tilePending`, for exactly one wire type (`"tile"`)**: unlike
/// every other frame, a `.tile` line alone is never a COMPLETE frame anymore — the pixel bytes
/// that used to live inline (`pixelsBase64`) now follow the line as raw, out-of-band bytes (see
/// `OfficeWireFrame.tile`'s own doc comment). `.frame`'s own contract — "this line, and only this
/// line, decoded to a full, usable value" — would be dishonest for `"tile"`, so it gets its own
/// outcome instead of `.frame(.tile(..., pixels: Data()))` with a fake empty payload. Both server
/// switches over this enum (`OfficeHelperServer.handleOpeningLine`/`.handlePostAuthLine`) gain one
/// new arm each for it — a CLIENT should never legitimately send a `"tile"` line (tile is a
/// PUSH-only, helper->client shape), so both arms simply refuse it exactly like any other
/// helper-only frame a client tried to send (`"not authenticated"` / `"unexpected"`).
/// `OfficeWireFrame.decode(_:)` returns `nil` for a `"tile"` line, consistent with its own
/// documented contract ("did this parse to a full, usable frame") — the one real consumer that
/// needs the header (`OfficeWireConnection.ingest`) calls `OfficeWireCodec.decodeInbound` directly
/// instead, precisely so it can see this case.
public enum OfficeWireInbound: Equatable, Sendable {
    /// Decoded completely.
    case frame(OfficeWireFrame)
    /// A `.tile` header line decoded completely, but the frame it describes is not yet complete —
    /// `header.byteCount` raw bytes must still be read off the stream before a real
    /// `OfficeWireFrame.tile` exists. See this enum's own header for why this cannot simply be
    /// `.frame(.tile(...))`.
    case tilePending(TileWireHeader)
    /// The envelope decoded (a JSON object with a string `type` and a recoverable non-negative
    /// integer `seq`), but the frame itself didn't: either `type` is not one of
    /// `OfficeWireFrame.wireTypes` (reason `"unknown"` — the brief's literal pin) or it IS a known
    /// type whose required fields are missing or mistyped (reason `"malformed"`).
    case rejected(seq: UInt64, reason: String)
    /// **office-plumbing wave fix (T5.5 review Minor-B)** — a `"tile"`-typed line whose OWN
    /// structure failed to decode (a missing/mistyped `docId`/`key`/`generation`/`width`/`height`/
    /// `byteCount`). Deliberately NOT folded into `.rejected`, even though the two carry the same
    /// `(seq, reason)` shape: every OTHER wire type's malformed line is self-contained — nothing on
    /// the wire depends on having decoded it, so `.rejected`'s own "log and keep scanning" handling
    /// (`OfficeWireConnection.ingest`) is safe. A `"tile"` line is different — on a well-formed
    /// stream, raw pixel bytes ALWAYS follow it, whether or not THIS reader could parse the header
    /// naming them. If this case fell through to `.rejected`'s treatment, `ingest` would newline-scan
    /// straight into up to a tile's worth of raw RGBA bytes hunting for `0x0A` — pixel bytes
    /// routinely contain it (~1/256 of a ~1MiB payload, on the order of 4,000 spurious "lines") —
    /// producing thousands of pointless decode-and-log cycles instead of the one honest outcome:
    /// this stream can no longer be trusted to be in sync, exactly the reasoning the byteCount-
    /// mismatch refusal (`ingest`'s own `.tilePending` case) already acts on for a structurally-VALID
    /// header carrying an untrustworthy size.
    case tileHeaderMalformed(seq: UInt64, reason: String)
    /// Not even an envelope: not valid JSON, not a JSON object, no string `type`, or `seq` itself
    /// missing/mistyped/negative. Nothing here is trustworthy enough to echo — a reply, if the
    /// caller chooses to send one, must use the seq-unknown sentinel (`0`) with reason
    /// `"malformed"`.
    case unreadable
}

public enum OfficeWireCodec {
    /// The seq value a helper sends back when the inbound line was `.unreadable` — no real seq
    /// exists to echo. `0` is never a seq a well-behaved client mints (see
    /// `OfficeWireSeqAllocator`, which starts at 1), so a client CAN tell a sentinel-seq error
    /// apart from a genuine echo if it wants to, without that distinction being load-bearing for
    /// the refuse-never-ignore contract itself (a reply was still sent either way).
    public static let unreadableSeqSentinel: UInt64 = 0

    /// The full three-way inbound decode. Total: never throws, always returns one of the three
    /// cases above.
    public static func decodeInbound(_ line: String) -> OfficeWireInbound {
        guard let data = line.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data),
              let object = parsed as? [String: Any],
              let type = object["type"] as? String,
              let seq = unsignedSeq(object["seq"]) else {
            return .unreadable
        }

        switch type {
        case "hello":
            guard let roleRaw = object["role"] as? String,
                  let role = OfficeWireRole(rawValue: roleRaw),
                  let token = object["token"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.hello(seq: seq, role: role, token: token))
        case "ping":
            return .frame(.ping(seq: seq))
        case "open":
            guard let docId = object["docId"] as? String, let path = object["path"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.open(seq: seq, docId: docId, path: path))
        case "close":
            guard let docId = object["docId"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.close(seq: seq, docId: docId))
        case "save":
            guard let docId = object["docId"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.save(seq: seq, docId: docId))
        case "keyEvent":
            guard let docId = object["docId"] as? String,
                  let typeRaw = intValue(object["eventType"]), let type = OfficeKeyEventType(rawValue: typeRaw),
                  let charCode = intValue(object["charCode"]), let keyCode = intValue(object["keyCode"]) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.keyEvent(seq: seq, docId: docId, type: type, charCode: charCode, keyCode: keyCode))
        case "mouseEvent":
            guard let docId = object["docId"] as? String,
                  let typeRaw = intValue(object["eventType"]), let type = OfficeMouseEventType(rawValue: typeRaw),
                  let xTwips = int64Value(object["xTwips"]), let yTwips = int64Value(object["yTwips"]),
                  let count = intValue(object["count"]), let buttons = intValue(object["buttons"]),
                  let modifiers = intValue(object["modifiers"]) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.mouseEvent(seq: seq, docId: docId, type: type, xTwips: xTwips, yTwips: yTwips,
                                       count: count, buttons: buttons, modifiers: modifiers))
        case "keyEventOk":
            guard let docId = object["docId"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.keyEventOk(seq: seq, docId: docId))
        case "mouseEventOk":
            guard let docId = object["docId"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.mouseEventOk(seq: seq, docId: docId))
        case "saved":
            guard let docId = object["docId"] as? String, let tempPath = object["tempPath"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.saved(seq: seq, docId: docId, tempPath: tempPath))
        case "saveFailed":
            guard let docId = object["docId"] as? String, let reason = object["reason"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.saveFailed(seq: seq, docId: docId, reason: reason))
        case "helloOk":
            guard let lokVersion = object["lokVersion"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.helloOk(seq: seq, lokVersion: lokVersion))
        case "refused":
            guard let reason = object["reason"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.refused(seq: seq, reason: reason))
        case "pong":
            return .frame(.pong(seq: seq))
        case "opened":
            guard let docId = object["docId"] as? String,
                  let typeRaw = object["docType"] as? String, let type = OfficeDocumentKind(rawValue: typeRaw),
                  let parts = intValue(object["parts"]),
                  let widthTwips = int64Value(object["widthTwips"]),
                  let heightTwips = int64Value(object["heightTwips"]) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.opened(seq: seq, docId: docId, type: type, parts: parts,
                                   sizeTwips: OfficeDocumentSize(widthTwips: widthTwips, heightTwips: heightTwips)))
        case "openFailed":
            guard let docId = object["docId"] as? String, let reason = object["reason"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.openFailed(seq: seq, docId: docId, reason: reason))
        case "closed":
            guard let docId = object["docId"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.closed(seq: seq, docId: docId))
        case "error":
            guard let reason = object["reason"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.error(seq: seq, reason: reason))
        case "documentEvent":
            guard let docId = object["docId"] as? String,
                  let event = OfficeDocumentEvent.decodeFields(object) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.documentEvent(seq: seq, docId: docId, event: event))
        case "subscribeTiles":
            guard let docId = object["docId"] as? String,
                  let part = intValue(object["part"]), let zoomPPT = intValue(object["zoomPPT"]),
                  let viewportTwips = OfficeWireFrame.decodeRect(object["viewportTwips"]) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.subscribeTiles(seq: seq, docId: docId, part: part, zoomPPT: zoomPPT, viewportTwips: viewportTwips))
        case "unsubscribe":
            guard let docId = object["docId"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.unsubscribe(seq: seq, docId: docId))
        case "tileRequest":
            guard let docId = object["docId"] as? String,
                  let keys = OfficeWireFrame.decodeTileKeys(object["keys"]) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.tileRequest(seq: seq, docId: docId, keys: keys))
        case "subscribed":
            guard let docId = object["docId"] as? String,
                  let keys = OfficeWireFrame.decodeTileKeys(object["keys"]) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.subscribed(seq: seq, docId: docId, keys: keys))
        case "unsubscribed":
            guard let docId = object["docId"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.unsubscribed(seq: seq, docId: docId))
        case "tileRequestAccepted":
            guard let docId = object["docId"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.tileRequestAccepted(seq: seq, docId: docId))
        case "tile":
            // Task 5.5: `byteCount` replaces `pixelsBase64` — this is a HEADER-only decode now
            // (`.tilePending`, never `.frame`), see `OfficeWireInbound`'s own doc comment. Structural
            // validation only: a present, non-negative integer (mirrors `unsignedSeq`'s own
            // NSNumber-boolean-trap discipline one line down, applied to a plain `Int` rather than a
            // `UInt64`). Whether THIS PARTICULAR value is a byte count the reader is willing to
            // trust/buffer for is a separate, semantic question `OfficeWireConnection.ingest` decides
            // — not this decode-level structural check.
            guard let docId = object["docId"] as? String,
                  let key = TileKey.decode(object["key"] as? [String: Any] ?? [:]),
                  let generation = intValue(object["generation"]),
                  let width = intValue(object["width"]), let height = intValue(object["height"]),
                  let byteCount = intValue(object["byteCount"]), byteCount >= 0 else {
                // Wave fix (T5.5 review Minor-B): `.tileHeaderMalformed`, never `.rejected` — see
                // `OfficeWireInbound`'s own header for why "tile" alone needs this distinction.
                return .tileHeaderMalformed(seq: seq, reason: "malformed")
            }
            return .tilePending(TileWireHeader(seq: seq, docId: docId, key: key, generation: generation,
                                                width: width, height: height, byteCount: byteCount))
        case "tileFailed":
            guard let docId = object["docId"] as? String,
                  let key = TileKey.decode(object["key"] as? [String: Any] ?? [:]),
                  let reason = object["reason"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.tileFailed(seq: seq, docId: docId, key: key, reason: reason))
        case "invalidated":
            guard let docId = object["docId"] as? String,
                  let keys = OfficeWireFrame.decodeTileKeys(object["keys"]) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.invalidated(seq: seq, docId: docId, keys: keys))
        default:
            // The type itself is unrecognized — the brief's exact case: error{seq,reason:"unknown"}.
            return .rejected(seq: seq, reason: "unknown")
        }
    }

    /// A non-negative whole number that fits a `UInt64`. Mirrors `EditorBridgeInbound.unsigned`'s
    /// discipline exactly (same file, same reasoning): `NSNumber`'s conditional cast to `UInt64`
    /// is value-preserving, so `-1`/`1.5` already answer `nil` on their own; the boolean check in
    /// front keeps a JSON `true` from arriving as `1`.
    private static func unsignedSeq(_ value: Any?) -> UInt64? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
            return nil
        }
        return number as? UInt64
    }
}

/// Same NSNumber-boolean-trap discipline as `OfficeWireCodec.unsignedSeq` (same file, same
/// reasoning), for a plain (possibly negative) `Int`/`Int64` field — `parts`/twips coordinates are
/// not `seq`s, no non-negative constraint. Free top-level functions (not members of
/// `OfficeWireCodec`) so both `OfficeWireCodec.decodeInbound` and `OfficeDocumentEvent.decodeFields`
/// below can use them without either type reaching into the other's internals.
func intValue(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    return number as? Int
}
func int64Value(_ value: Any?) -> Int64? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    return number as? Int64
}

/// Mints strictly increasing `seq` values for one connection's OUTBOUND frames, starting at 1
/// (never 0 — see `OfficeWireCodec.unreadableSeqSentinel`). Not thread-safe by itself; callers
/// that touch it from more than one queue must serialize (both `OfficeHelperServer`'s
/// per-connection handler and `OfficeWireConnection` already run their own frame traffic on one
/// queue each).
public final class OfficeWireSeqAllocator {
    private var next: UInt64 = 1
    public init() {}
    public func nextSeq() -> UInt64 {
        defer { next += 1 }
        return next
    }
}

/// A tiny `--flag value` CLI parser shared by `NormaOfficeHelper`'s real `main.swift` and the
/// test-only fixture's `main.swift` (`Tests/OfficeHelperFixtureSources`) — one implementation so
/// the two argument grammars cannot drift. Unknown/malformed tokens are ignored rather than
/// fatally erroring: both call sites already validate the specific flags THEY require and report
/// clearly on those (see each `main.swift`), so a stray argument here has somewhere better to be
/// caught than a generic parser.
///
/// A bare flag (no following value, or immediately followed by another `--flag`) maps to nothing
/// — checked explicitly, not merely "whatever happens to be next": every flag this repo's two
/// call sites actually use always carries a value, but a parser that instead swallowed the NEXT
/// flag's own name as if it were this flag's value would silently corrupt parsing the first time
/// either `main.swift` grows a genuine bare/boolean flag.
public enum OfficeWireArgs {
    public static func parse(_ arguments: [String]) -> [String: String] {
        var result: [String: String] = [:]
        var index = 0
        while index < arguments.count {
            let token = arguments[index]
            guard token.hasPrefix("--") else {
                index += 1
                continue
            }
            let key = String(token.dropFirst(2))
            if index + 1 < arguments.count, !arguments[index + 1].hasPrefix("--") {
                result[key] = arguments[index + 1]
                index += 2
            } else {
                index += 1 // bare flag: no value follows (or the next token is itself a flag)
            }
        }
        return result
    }
}
