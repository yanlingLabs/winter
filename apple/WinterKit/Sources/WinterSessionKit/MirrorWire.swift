import CoreGraphics
import Foundation

// -----------------------------------------------------------------------------------------------
// ComputerV2 Phase 1b — the PHONE MIRROR's wire, shared by the Mac's Gateway (which sends it) and the phone
// (which draws it).
//
//   helper ──view.*──▶ Winter.app's mirror (MirrorCoordinator, one helper connection, the Mac's own view
//   subscription) ──▶ RemoteMirrorHub ──▶ Gateway ──WireKind.mirror──▶ WinterSessionClient.mirror ──▶ phone
//
// The phone sees exactly what Winter.app's own mirror shows for the session: the same target on show, the
// same pictures (downscaled for the transport), the same agent cursor. A phone watch is a viewer in its own right:
// while it lasts, Winter.app keeps the session's helper view subscription open with pictures — whether or not a
// Winter window on the Mac shows the session — and nothing of it enters the session log, `session.history` or the
// remote event stream: a mirror update is its own wire kind with no `seq`.
//
// The phone asks with `session.mirror {sessionId, watch: true}` (renewed every `renewEvery`; the Gateway
// drops a watch not renewed within `lease`) and stops with `watch: false` — on leaving the session's screen
// and on backgrounding. It is view-only: nothing on this wire goes from the phone to the Mac.
// -----------------------------------------------------------------------------------------------

/// One update of the phone mirror — the payload of a `WireKind.mirror` envelope.
public enum MirrorUpdate: Sendable, Equatable {
    /// A target is on show: its app's name, its window's size in points, how many OTHER targets the session has
    /// bound, and whether pictures are flowing on the Mac right now (`live`). While a phone watches they are; `false`
    /// only while its subscription is being (re)made — the last picture stays, marked paused.
    case show(app: String, windowSize: CGSize, others: Int, live: Bool)
    /// Another target took over the panel: drop the picture and the cursor, keep the panel up.
    case reset
    /// The newest picture of the target on show.
    case frame(MirrorFrame)
    /// The agent cursor in the target on show.
    case cursor(MirrorCursor)
    /// Nothing to show: no target bound, the session is not open in a Winter window on the Mac, or the watch ended.
    case clear
}

/// A picture of the bound window, already sized for the phone transport (`MirrorWire.maxLongEdge`,
/// `MirrorWire.maxJPEGBytes`).
public struct MirrorFrame: Sendable, Equatable {
    public let seq: Int
    public let jpeg: Data
    /// The JPEG's pixel size.
    public let width: Int
    public let height: Int
    /// The window's size in points (what the cursor's coordinates are relative to).
    public let windowSize: CGSize

    public init(seq: Int, jpeg: Data, width: Int, height: Int, windowSize: CGSize) {
        self.seq = seq
        self.jpeg = jpeg
        self.width = width
        self.height = height
        self.windowSize = windowSize
    }
}

/// The agent cursor, in WINDOW-RELATIVE points (the helper's `view.cursor`, passed through): `kind` is the helper's
/// vocabulary (`move`, `press`, `type`, `key`, `scroll`, `drag`, `target`, `waitBegin`, `waitEnd`, `caption`, …).
public struct MirrorCursor: Sendable, Equatable {
    public let kind: String
    public let point: CGPoint
    public let dragTo: CGPoint?
    public let frame: CGRect?
    public let text: String?
    public let count: Int?
    public let button: String?

    public init(kind: String, point: CGPoint, dragTo: CGPoint? = nil, frame: CGRect? = nil, text: String? = nil, count: Int? = nil, button: String? = nil) {
        self.kind = kind
        self.point = point
        self.dragTo = dragTo
        self.frame = frame
        self.text = text
        self.count = count
        self.button = button
    }
}

/// A mirror update for a session — what `WinterSessionClient.mirror` yields.
public struct MirrorEnvelope: Sendable, Equatable {
    public let sessionID: String
    public let update: MirrorUpdate

    public init(sessionID: String, update: MirrorUpdate) {
        self.sessionID = sessionID
        self.update = update
    }
}

/// The phone mirror's sizes, rates and lease, and its JSON payload.
///
/// **Sized for the phone transport, which hard-fails on an oversized frame** (`WireFrame.decode`'s and
/// `IrohConn`'s 1 MiB cap): the JPEG rides base64 inside this JSON, which rides base64 again inside the envelope
/// (~1.8× all told), so a picture is capped at `maxJPEGBytes` (an envelope of ~175 KB at most) and the Gateway
/// refuses to send any envelope over `maxEnvelopeBytes`. Pictures are cut to `maxLongEdge` pixels on their long
/// edge, at most `activeFps` a second while the agent acts and `idleFps` once it has not for `idleAfter` seconds —
/// and never faster than the link takes them: the Gateway keeps one picture in flight and only the newest waiting.
public enum MirrorWire {
    public static let maxLongEdge = 640
    public static let maxJPEGBytes = 96 * 1024
    public static let maxEnvelopeBytes = 256 * 1024
    public static let activeFps = 5
    public static let idleFps = 1
    public static let idleAfter: TimeInterval = 3
    /// The Gateway drops a watch the phone has not renewed for this long (a suspended phone that never said stop).
    public static let lease: TimeInterval = 30
    /// How often a phone that is showing the mirror renews its watch.
    public static let renewEvery: TimeInterval = 10
    /// The longest cursor text (a caption, a key combo) the wire carries.
    public static let maxTextLength = 200

    /// The cursor kinds that mean the agent ACTS — Winter.app's own `MirrorTargetTracker.actionKinds`. Only these
    /// keep the mirror at its full rate.
    public static let actionKinds: Set<String> = [
        "target", "press", "click", "doubleClick", "rightClick", "type", "paste", "setValue", "key", "scroll", "drag",
    ]

    // MARK: - JSON

    public static func encode(_ update: MirrorUpdate) -> Data {
        var object: [String: Any]
        switch update {
        case .show(let app, let windowSize, let others, let live):
            object = ["type": "show", "app": String(app.prefix(maxTextLength)), "windowSize": pair(windowSize.width, windowSize.height),
                      "others": others, "live": live]
        case .reset:
            object = ["type": "reset"]
        case .frame(let f):
            object = ["type": "frame", "seq": f.seq, "width": f.width, "height": f.height,
                      "windowSize": pair(f.windowSize.width, f.windowSize.height), "jpeg": f.jpeg.base64EncodedString()]
        case .cursor(let c):
            object = ["type": "cursor", "kind": String(c.kind.prefix(64)), "point": pair(c.point.x, c.point.y)]
            if let d = c.dragTo { object["dragTo"] = pair(d.x, d.y) }
            if let r = c.frame { object["frame"] = [Double(r.origin.x), Double(r.origin.y), Double(r.size.width), Double(r.size.height)] }
            if let t = c.text { object["text"] = String(t.prefix(maxTextLength)) }
            if let n = c.count { object["count"] = n }
            if let b = c.button { object["button"] = String(b.prefix(32)) }
        case .clear:
            object = ["type": "clear"]
        }
        return (try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes])) ?? Data("{}".utf8)
    }

    /// `nil` for anything that is not a well-formed update — an unknown `type` from a newer Mac included.
    public static func decode(_ data: Data) -> MirrorUpdate? {
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let type = o["type"] as? String else { return nil }
        func int(_ key: String) -> Int? { (o[key] as? NSNumber)?.intValue }
        switch type {
        case "show":
            guard let app = o["app"] as? String else { return nil }
            return .show(app: app, windowSize: size(o["windowSize"]) ?? .zero, others: max(int("others") ?? 0, 0),
                         live: (o["live"] as? NSNumber)?.boolValue ?? false)
        case "reset":
            return .reset
        case "frame":
            guard let b64 = o["jpeg"] as? String, let jpeg = Data(base64Encoded: b64), !jpeg.isEmpty else { return nil }
            return .frame(MirrorFrame(seq: int("seq") ?? 0, jpeg: jpeg, width: int("width") ?? 0, height: int("height") ?? 0,
                                      windowSize: size(o["windowSize"]) ?? .zero))
        case "cursor":
            guard let kind = o["kind"] as? String, let point = point(o["point"]) else { return nil }
            return .cursor(MirrorCursor(kind: kind, point: point, dragTo: self.point(o["dragTo"]), frame: rect(o["frame"]),
                                        text: o["text"] as? String, count: int("count"), button: o["button"] as? String))
        case "clear":
            return .clear
        default:
            return nil
        }
    }

    private static func pair(_ a: CGFloat, _ b: CGFloat) -> [Double] { [Double(a), Double(b)] }

    private static func numbers(_ v: Any?, count: Int) -> [Double]? {
        guard let items = v as? [Any], items.count == count else { return nil }
        let values = items.compactMap { ($0 as? NSNumber)?.doubleValue }
        guard values.count == count, values.allSatisfy(\.isFinite) else { return nil }
        return values
    }

    private static func size(_ v: Any?) -> CGSize? { numbers(v, count: 2).map { CGSize(width: $0[0], height: $0[1]) } }
    private static func point(_ v: Any?) -> CGPoint? { numbers(v, count: 2).map { CGPoint(x: $0[0], y: $0[1]) } }
    private static func rect(_ v: Any?) -> CGRect? { numbers(v, count: 4).map { CGRect(x: $0[0], y: $0[1], width: $0[2], height: $0[3]) } }
}
