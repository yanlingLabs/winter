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

    /// The wire vocabulary, in frame-declaration order. A test walks this list the same way
    /// `EditorBridgeInbound.wireTypes`'s own test does — one fixture per name, decode, assert the
    /// case names itself the same way — so this array and `decode`/`wireType` cannot drift apart
    /// unnoticed.
    public static let wireTypes: [String] = [
        "hello", "ping", "open", "close",
        "helloOk", "refused", "pong", "opened", "openFailed", "closed", "error", "documentEvent",
    ]

    public var wireType: String {
        switch self {
        case .hello: return "hello"
        case .ping: return "ping"
        case .open: return "open"
        case .close: return "close"
        case .helloOk: return "helloOk"
        case .refused: return "refused"
        case .pong: return "pong"
        case .opened: return "opened"
        case .openFailed: return "openFailed"
        case .closed: return "closed"
        case .error: return "error"
        case .documentEvent: return "documentEvent"
        }
    }

    public var seq: UInt64 {
        switch self {
        case .hello(let seq, _, _): return seq
        case .ping(let seq): return seq
        case .open(let seq, _, _): return seq
        case .close(let seq, _): return seq
        case .helloOk(let seq, _): return seq
        case .refused(let seq, _): return seq
        case .pong(let seq): return seq
        case .opened(let seq, _, _, _, _): return seq
        case .openFailed(let seq, _, _): return seq
        case .closed(let seq, _): return seq
        case .error(let seq, _): return seq
        case .documentEvent(let seq, _, _): return seq
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
        case .close(_, let docId), .closed(_, let docId):
            payload["docId"] = docId
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
}

/// `hello`'s role field. `agent` is the daemon (Stage C consumer; the handshake alone lands now).
public enum OfficeWireRole: String, Equatable, Sendable {
    case app
    case agent
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

/// The result of trying to read one NDJSON line as a frame a HELPER must answer. Three-way so the
/// helper can always echo the caller's real `seq` when it has one, and only fall back to the
/// seq-unknown sentinel when the line gave it no seq at all.
public enum OfficeWireInbound: Equatable, Sendable {
    /// Decoded completely.
    case frame(OfficeWireFrame)
    /// The envelope decoded (a JSON object with a string `type` and a recoverable non-negative
    /// integer `seq`), but the frame itself didn't: either `type` is not one of
    /// `OfficeWireFrame.wireTypes` (reason `"unknown"` — the brief's literal pin) or it IS a known
    /// type whose required fields are missing or mistyped (reason `"malformed"`).
    case rejected(seq: UInt64, reason: String)
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
