import CoreGraphics
import Foundation

// The wake triggers' DECISIONS, pure (no AX, no clock of its own): what a condition is, whether an observation of the
// window fires it, whose input an event was, and when Winter's own input to an app explains a change.
//
// The controller's ruling (2026-10-12): a condition already true at arming is refused; only a false→true transition
// after arming fires. INPUT conditions (`clicked`, `changed`) need the user's own input — hardware input. STATE
// conditions (`appeared`, `gone`, `titled`) fire on any transition Winter's own input did not cause: one landing while
// any session's input to that app is in flight, or within 500 ms after it, is Winter's (the new state becomes the
// baseline — it never fires).

/// A validated condition (the wire's `CUWatchConditionWire`).
public enum CUWatchCondition: Equatable, Sendable {
    case clicked(ref: Int)
    case appeared(text: String)
    case goneRef(ref: Int)
    case goneText(text: String)
    /// `settleMs`: how long the value must stay the same before it fires.
    case changed(ref: Int, settleMs: Double)
    case titled(title: String)

    /// The wire's kind word.
    public var kind: String {
        switch self {
        case .clicked: return "clicked"
        case .appeared: return "appeared"
        case .goneRef, .goneText: return "gone"
        case .changed: return "changed"
        case .titled: return "titled"
        }
    }

    /// The element the condition is about, when it is one.
    public var ref: Int? {
        switch self {
        case .clicked(let r), .goneRef(let r), .changed(let r, _): return r
        case .appeared, .goneText, .titled: return nil
        }
    }

    /// Needs the user's own input (hardware), not just a change Winter did not cause.
    public var isInput: Bool {
        switch self {
        case .clicked, .changed: return true
        default: return false
        }
    }

    /// `changed`'s default quiet period (the daemon's `WAKE_LIMITS.defaultSettleMs`).
    public static let defaultSettleMs: Double = 1_500
    /// A text or title to wait for: at most this many characters.
    public static let textMax = 500

    /// The kinds only a browser tab can watch: refused here, naming why.
    public static let tabOnlyKinds: Set<String> = ["submitted", "navigated"]

    public static func parse(_ w: CUWatchConditionWire) throws -> CUWatchCondition {
        func text(_ s: String?, _ field: String) throws -> String {
            guard let s, !CUFinder.fold(s).isEmpty else { throw CUError.invalidParams("\(w.kind) needs a non-empty \(field)") }
            guard s.count <= textMax else { throw CUError.invalidParams("\(field) is at most \(textMax) characters") }
            return s
        }
        func ref(_ r: Int?) throws -> Int {
            guard let r, r > 0 else { throw CUError.invalidParams("\(w.kind) needs a ref (a number from state())") }
            return r
        }
        switch w.kind {
        case "clicked": return .clicked(ref: try ref(w.ref))
        case "appeared": return .appeared(text: try text(w.text, "text"))
        case "gone":
            if w.ref != nil, w.text != nil { throw CUError.invalidParams("gone takes a ref or a text, not both") }
            if w.ref != nil { return .goneRef(ref: try ref(w.ref)) }
            return .goneText(text: try text(w.text, "text"))
        case "changed":
            let settle = w.settleMs.map { Double(min(max($0, 0), 60_000)) } ?? defaultSettleMs
            return .changed(ref: try ref(w.ref), settleMs: settle)
        case "titled": return .titled(title: try text(w.title ?? w.text, "title"))
        case let k where tabOnlyKinds.contains(k):
            throw CUError.invalidParams("\(k) is for browser tabs only — an app can't be watched for it")
        default:
            throw CUError.invalidParams("unknown watch kind \(w.kind)")
        }
    }
}

/// One look at the watched window, taken on the app's queue (live) or written by a test.
struct CUWatchObservation: Equatable {
    var appRunning = true
    var windowAlive = true
    /// The watched element still exists (ref kinds; nil for the window-wide ones).
    var elementAlive: Bool?
    /// A state condition holds now (`appeared`, `gone`, `titled`); nil for the others.
    var met: Bool?
    /// `changed`: a digest of the field's value (never the value itself).
    var valueDigest: Int?
    /// `changed`: the user's own input explains a change now — the field holds the keyboard focus in the bound window
    /// while it is frontmost (their typing: keys are invisible without Input Monitoring, which is never asked for), or
    /// their hardware click on the field came shortly before.
    var userEvidence = false
    /// `titled`: the title now (the fired detail).
    var title: String?
}

/// What one look at the window decided.
enum CUWatchDecision: Equatable {
    case none
    case fire(detail: String)
    case lost(reason: String)
    /// `changed`: a user's change is settling — look again at this clock time.
    case lookAgain(atMs: Double)
}

/// Per watch, the decisions over time (one-shot: once it fires or is lost it decides nothing more).
struct CUWatchJudge: Equatable {
    let condition: CUWatchCondition
    /// State kinds: the condition's truth as last attributed (false at arming — arming refuses a true one).
    private(set) var lastMet = false
    /// `changed`: the value the user's change is measured against, the last value seen, when it last changed, and
    /// since when a change of the user's is pending.
    private(set) var baseline: Int?
    private(set) var lastSeen: Int?
    private(set) var lastChangeMs: Double?
    private(set) var pendingSinceMs: Double?
    private(set) var ended = false

    init(_ condition: CUWatchCondition, baselineValue: Int? = nil) {
        self.condition = condition
        baseline = baselineValue
        lastSeen = baselineValue
    }

    static let appQuit = "the app quit"
    static let windowClosed = "the window closed"
    static let elementGone = "the element is gone (the window changed under it)"
    static let elementGoneOwnInput = "the element went away while Winter was acting in the app"

    /// `ownInput`: Winter's own input to the app overlapped the interval this look covers (in flight, or within the grace
    /// after it).
    mutating func judge(_ o: CUWatchObservation, ownInput: Bool, nowMs: Double) -> CUWatchDecision {
        guard !ended else { return .none }
        if !o.appRunning { return end(.lost(reason: Self.appQuit)) }
        if !o.windowAlive { return end(.lost(reason: Self.windowClosed)) }
        switch condition {
        case .clicked:
            if o.elementAlive == false { return end(.lost(reason: Self.elementGone)) }
            return .none
        case .goneRef:
            guard o.elementAlive == false else { return .none }
            return end(ownInput ? .lost(reason: Self.elementGoneOwnInput) : .fire(detail: "gone"))
        case .appeared, .goneText, .titled:
            guard let met = o.met else { return .none }
            defer { lastMet = met }
            guard met, !lastMet else { return .none }
            // A transition Winter's own input explains becomes the baseline: it must go away and come back to fire.
            if ownInput { return .none }
            return end(.fire(detail: Self.detail(condition, title: o.title)))
        case .changed(_, let settleMs):
            if o.elementAlive == false {
                // A change of the user's that was settling when the field went (Return closed the sheet): it happened.
                if pendingSinceMs != nil, lastSeen != baseline { return end(.fire(detail: "changed")) }
                return end(.lost(reason: Self.elementGone))
            }
            guard let v = o.valueDigest else { return .none }
            if v != lastSeen {
                lastSeen = v
                lastChangeMs = nowMs
                if ownInput || !o.userEvidence {
                    // Winter's change, or one no input of the user's explains: the new value is the baseline.
                    baseline = v
                    pendingSinceMs = nil
                    return .none
                }
                if pendingSinceMs == nil { pendingSinceMs = nowMs }
            }
            guard pendingSinceMs != nil, let last = lastChangeMs else { return .none }
            if v == baseline {
                pendingSinceMs = nil  // changed back: nothing changed
                return .none
            }
            if nowMs - last >= settleMs { return end(.fire(detail: "changed")) }
            return .lookAgain(atMs: last + settleMs)
        }
    }

    /// The user's hardware click on the watched element (the click tap's hit). Only `clicked` fires on it.
    mutating func clicked(ownInput: Bool) -> CUWatchDecision {
        guard !ended, case .clicked = condition, !ownInput else { return .none }
        return end(.fire(detail: "clicked"))
    }

    private mutating func end(_ d: CUWatchDecision) -> CUWatchDecision {
        ended = true
        return d
    }

    static func detail(_ c: CUWatchCondition, title: String?) -> String {
        switch c {
        case .appeared: return "appeared"
        case .goneRef, .goneText: return "gone"
        case .titled:
            guard let t = title.map({ CUWatchText.oneLine($0, max: 120) }), !t.isEmpty else { return "title changed" }
            return "title now \u{201C}\(t)\u{201D}"
        case .changed: return "changed"
        case .clicked: return "clicked"
        }
    }

    /// The sentence that refuses arming a state condition that already holds (the controller's ruling).
    static func alreadyMet(_ c: CUWatchCondition, app: String) -> String? {
        switch c {
        case .appeared(let text):
            return "\u{201C}\(CUWatchText.oneLine(text, max: 80))\u{201D} is already shown in \(app) — nothing to wait for; check state()"
        case .goneText(let text):
            return "\u{201C}\(CUWatchText.oneLine(text, max: 80))\u{201D} is not shown in \(app) — nothing to wait for; check state()"
        case .goneRef(let ref):
            return "[\(ref)] is already gone from \(app) — nothing to wait for; check state()"
        case .titled(let title):
            return "\(app)'s window title already contains \u{201C}\(CUWatchText.oneLine(title, max: 80))\u{201D} — nothing to wait for; check state()"
        case .clicked, .changed:
            return nil
        }
    }
}

/// Whose input one mouse-down was. Pure.
enum CUWatchInput {
    /// The user's: hardware input (no source process, not the helper's stamp) — or, on a live-test instance only, the
    /// live suite's own test click (`CUWatchTestStamp`).
    static func isUsers(sourcePid: Int64, userData: Int64, countsTestInput: Bool) -> Bool {
        if CUEventStamp.isOurs(userData) { return false }
        if sourcePid == 0 { return true }
        return countsTestInput && userData == CUWatchTestStamp.value
    }

    /// The mask of the click tap: the three mouse-down buttons, nothing else (no keys, no moves).
    static let tapMask: CGEventMask = {
        let types: [CGEventType] = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        return types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << CGEventMask($1.rawValue)) }
    }()
}

/// Winter's own input to each app, as the shell reports it around every request that can send some (an act, an
/// AppleScript, a foreground hold) — and, for a request whose app is not known until it answers (a bind, an open),
/// "every app" while it runs. A change that lands while one is in flight, or within `graceMs` after, is Winter's.
final class CUOwnInputLedger: @unchecked Sendable {
    /// `WAKE_LIMITS.ownInputGraceMs`.
    static let graceMs: Double = 500
    private struct Mark { var inFlight = 0; var lastBeginMs = -Double.infinity; var lastEndMs = -Double.infinity }
    private let lock = NSLock()
    private var byPid: [pid_t: Mark] = [:]
    private var any = Mark()

    /// nil = every app (the request's app is not known yet).
    func begin(_ pid: pid_t?, nowMs: Double) {
        lock.withLock {
            if let pid {
                var m = byPid[pid] ?? Mark()
                m.inFlight += 1
                m.lastBeginMs = nowMs
                byPid[pid] = m
            } else {
                any.inFlight += 1
                any.lastBeginMs = nowMs
            }
        }
    }

    func end(_ pid: pid_t?, nowMs: Double) {
        lock.withLock {
            if let pid {
                var m = byPid[pid] ?? Mark()
                m.inFlight = max(0, m.inFlight - 1)
                m.lastEndMs = nowMs
                byPid[pid] = m
            } else {
                any.inFlight = max(0, any.inFlight - 1)
                any.lastEndMs = nowMs
            }
        }
    }

    /// Winter's input to `pid` (or to every app) explains a change that happened in `[fromMs, nowMs]`: one was in flight,
    /// began during it, or ended less than the grace before its start.
    func touched(_ pid: pid_t, fromMs: Double) -> Bool {
        lock.withLock {
            for m in [byPid[pid] ?? Mark(), any] {
                if m.inFlight > 0 || m.lastBeginMs >= fromMs || m.lastEndMs >= fromMs - Self.graceMs { return true }
            }
            return false
        }
    }
}

/// The few display rules the watch's strings follow. Pure.
enum CUWatchText {
    /// One line: control and format characters (bidi overrides included) become spaces, white space runs one space,
    /// trimmed, cut to `max` characters with an ellipsis.
    static func oneLine(_ s: String, max: Int) -> String {
        var out = ""
        for scalar in s.unicodeScalars {
            switch scalar.properties.generalCategory {
            case .control, .format, .lineSeparator, .paragraphSeparator, .surrogate, .privateUse, .unassigned:
                out.unicodeScalars.append(" ")
            default:
                out.unicodeScalars.append(scalar)
            }
        }
        let line = out.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        guard line.count > max else { return line }
        return String(line.prefix(Swift.max(0, max - 1))) + "…"
    }

    /// "Mail — Inbox" (the app alone for an untitled window).
    static func targetLabel(app: String, title: String?) -> String {
        let t = oneLine(title ?? "", max: 160)
        return oneLine(t.isEmpty ? app : "\(app) — \(t)", max: 200)
    }

    /// FNV-1a of a value: compared, never sent.
    static func digest(_ s: String?) -> Int {
        guard let s else { return 0 }
        var h: UInt64 = 0xcbf2_9ce4_8422_2325
        for b in s.utf8 { h = (h ^ UInt64(b)) &* 0x0000_0100_0000_01B3 }
        return Int(bitPattern: UInt(truncatingIfNeeded: h))
    }
}
