import CoreGraphics
import Foundation

// `cu-live-tool session` and the monitor's `locked`/`onConsole` fields: is the screen usable by a live run at all?
// CGSessionCopyCurrentDictionary needs no TCC grant and no run loop. A locked Mac (or one whose console belongs to
// another user) shows the login window: every fixture would open behind it and every result would be meaningless, so
// the runner treats "locked or not on the console" like real input — it never starts, and it stops a run in progress.

enum SessionState {
    struct Reading: Equatable {
        var locked: Bool
        var onConsole: Bool

        /// `{"locked":<bool>,"onConsole":<bool>}` — the `session` command's line.
        var json: String { "{\"locked\":\(locked),\"onConsole\":\(onConsole)}" }
    }

    /// The undocumented key CGSession sets (to 1) only while the screen is locked.
    static let lockedKey = "CGSSessionScreenIsLocked"
    static let onConsoleKey = kCGSessionOnConsoleKey as String

    /// Pure: a session dictionary → a reading. No dictionary (no GUI session at all, e.g. over ssh) is "not on the
    /// console"; a missing console key is read as not on the console too (never as "fine").
    static func parse(_ dictionary: [String: Any]?) -> Reading {
        guard let dictionary else { return Reading(locked: false, onConsole: false) }
        func flag(_ key: String) -> Bool {
            if let n = dictionary[key] as? NSNumber { return n.boolValue }
            if let b = dictionary[key] as? Bool { return b }
            return false
        }
        return Reading(locked: flag(lockedKey), onConsole: flag(onConsoleKey))
    }

    static func read() -> Reading {
        parse(CGSessionCopyCurrentDictionary() as? [String: Any])
    }

    // The monitor samples every 20 ms; the lock state changes on a human timescale, so it is re-read at most this
    // often (main run loop only).
    private static let maxAgeMs = 200
    private static var cachedAt = 0
    private static var cached: Reading?

    @MainActor
    static func cachedReading() -> Reading {
        let now = Sampling.nowMs()
        if let cached, now - cachedAt < maxAgeMs { return cached }
        let fresh = read()
        cached = fresh
        cachedAt = now
        return fresh
    }
}
