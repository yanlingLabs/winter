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
    /// Track a document as open. Stage A has no LibreOfficeKit loaded (Task 3's job) — this is
    /// bookkeeping only, feeding the helper's idle-exit accounting ("zero documents AND zero
    /// clients"). Idempotent: opening an already-open `docId` updates its `path` and re-acks
    /// rather than erroring (a disclosed choice — Task 2 has no real per-doc state whose
    /// re-opening could be unsafe; Task 3 may need to tighten this once LOK documents are real).
    case open(seq: UInt64, docId: String, path: String)
    /// Stop tracking a document. Idempotent for the same reason `open` is: closing an untracked
    /// `docId` still acks `closed` rather than erroring.
    case close(seq: UInt64, docId: String)

    // MARK: Responses (helper -> client)

    /// `hello` succeeded: `token` matched. `lokVersion` is Stage A's honest placeholder — see
    /// `officeWireStageALOKVersionPlaceholder` below — because no LibreOfficeKit is loaded yet.
    case helloOk(seq: UInt64, lokVersion: String)
    /// `hello` failed (token mismatch, or a malformed hello) — always the LAST frame the helper
    /// sends before it closes the connection; see `OfficeHelperServer`'s pre-auth gate.
    case refused(seq: UInt64, reason: String)
    /// Answers `ping`.
    case pong(seq: UInt64)
    /// Answers a successful `open`.
    case opened(seq: UInt64, docId: String)
    /// Answers a successful `close`.
    case closed(seq: UInt64, docId: String)
    /// Answers anything the helper refuses post-auth: an unknown frame type (`reason:"unknown"`,
    /// the brief's literal pin), a known type whose fields don't decode (`reason:"malformed"`),
    /// or a structurally valid frame that is never legal for a client to SEND (a reply shape —
    /// `reason:"unexpected"`).
    case error(seq: UInt64, reason: String)

    /// The wire vocabulary, in frame-declaration order. A test walks this list the same way
    /// `EditorBridgeInbound.wireTypes`'s own test does — one fixture per name, decode, assert the
    /// case names itself the same way — so this array and `decode`/`wireType` cannot drift apart
    /// unnoticed.
    public static let wireTypes: [String] = [
        "hello", "ping", "open", "close",
        "helloOk", "refused", "pong", "opened", "closed", "error",
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
        case .closed: return "closed"
        case .error: return "error"
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
        case .opened(let seq, _): return seq
        case .closed(let seq, _): return seq
        case .error(let seq, _): return seq
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
        case .close(_, let docId), .opened(_, let docId), .closed(_, let docId):
            payload["docId"] = docId
        case .helloOk(_, let lokVersion):
            payload["lokVersion"] = lokVersion
        case .refused(_, let reason), .error(_, let reason):
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
}

/// `hello`'s role field. `agent` is the daemon (Stage C consumer; the handshake alone lands now).
public enum OfficeWireRole: String, Equatable, Sendable {
    case app
    case agent
}

/// Stage A has no LibreOfficeKit loaded — Task 3's job. `helloOk.lokVersion` cannot yet report a
/// real LOK version string, and an empty string or a guessed value would both be a lie a test
/// could pin without anyone noticing it was fake. This sentinel makes the placeholder explicit
/// and greppable; Task 3 replaces both this constant's use in `OfficeHelperServer` and its value.
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
            guard let docId = object["docId"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.opened(seq: seq, docId: docId))
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
