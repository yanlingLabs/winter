import CoreGraphics
import Foundation

/// One mirror/cursor subject: a target window as one session sees it.
struct TargetKey: Hashable, Sendable {
    let sessionId: String
    let target: CUWindowRef
}

/// The bookkeeping behind the mirrors and cursors, kept free of AppKit so it can be tested with a fake clock. The
/// controller asks it what should be on screen and draws that.
///
/// Rules:
/// - `showMirror` asks for a mirror; it stays wanted until `hideMirror` or the session ends.
/// - A wanted mirror is *faded* at turn end or `idleFade` after the last activity on its target. A later cursor action
///   on that target (the next turn working on it) brings it back.
/// - At most `maxMirrors` are on screen: the wanted, unfaded ones with the most recent activity. Showing a mirror and
///   acting on a target both count as activity.
/// - The overlay cursor of a target shows from its last action until `cursorIdleHide` passes or the turn ends.
struct PresentationState {
    struct Entry: Equatable {
        var wantsMirror = false
        var mirrorFaded = false
        var lastActivity: TimeInterval
        /// Higher is more recent. Ties never happen: every bump takes a fresh number.
        var recency: UInt64
        var cursorVisibleUntil: TimeInterval?
        /// The last cursor point, as a fraction of the window frame, so it follows the window when it moves.
        var cursorFraction: CGPoint?
    }

    let tuning: PresentationTuning
    private(set) var entries: [TargetKey: Entry] = [:]
    var mirrorsEnabled = true
    private var counter: UInt64 = 0

    init(tuning: PresentationTuning = .standard) {
        self.tuning = tuning
    }

    private mutating func nextRecency() -> UInt64 {
        counter += 1
        return counter
    }

    mutating func showMirror(_ key: TargetKey, now: TimeInterval) {
        let recency = nextRecency()
        var entry = entries[key] ?? Entry(lastActivity: now, recency: recency)
        entry.wantsMirror = true
        entry.mirrorFaded = false
        entry.lastActivity = now
        entry.recency = recency
        entries[key] = entry
    }

    mutating func hideMirror(_ key: TargetKey) {
        guard var entry = entries[key] else { return }
        entry.wantsMirror = false
        entry.mirrorFaded = false
        if entry.cursorVisibleUntil == nil {
            entries[key] = nil
        } else {
            entries[key] = entry
        }
    }

    /// An action (cursor) on a target. `fraction` is the point as a fraction of the window frame, when known.
    mutating func noteCursor(_ key: TargetKey, fraction: CGPoint?, now: TimeInterval) {
        let recency = nextRecency()
        var entry = entries[key] ?? Entry(lastActivity: now, recency: recency)
        entry.lastActivity = now
        entry.recency = recency
        if entry.wantsMirror { entry.mirrorFaded = false }
        entry.cursorVisibleUntil = now + tuning.cursorIdleHide
        if let fraction { entry.cursorFraction = fraction }
        entries[key] = entry
    }

    /// Fades the session's mirrors and hides its cursors. They come back with the next action on the target.
    mutating func turnEnded(sessionId: String) {
        for (key, entry) in entries where key.sessionId == sessionId {
            var e = entry
            if e.wantsMirror { e.mirrorFaded = true }
            e.cursorVisibleUntil = nil
            entries[key] = e
        }
        prune()
    }

    /// Forgets the session entirely. Returns the keys that were removed.
    @discardableResult
    mutating func sessionEnded(sessionId: String) -> [TargetKey] {
        let gone = entries.keys.filter { $0.sessionId == sessionId }
        for key in gone { entries[key] = nil }
        return gone
    }

    /// Applies the timers. Returns true when anything changed.
    @discardableResult
    mutating func tick(now: TimeInterval) -> Bool {
        var changed = false
        for (key, entry) in entries {
            var e = entry
            if e.wantsMirror, !e.mirrorFaded, now - e.lastActivity >= tuning.idleFade {
                e.mirrorFaded = true
            }
            if let until = e.cursorVisibleUntil, now >= until {
                e.cursorVisibleUntil = nil
            }
            if e != entry {
                entries[key] = e
                changed = true
            }
        }
        if changed { prune() }
        return changed
    }

    /// The mirrors to show, newest first, at most `maxMirrors`. Empty when mirrors are disabled.
    func visibleMirrors() -> [TargetKey] {
        guard mirrorsEnabled else { return [] }
        return entries
            .filter { $0.value.wantsMirror && !$0.value.mirrorFaded }
            .sorted { $0.value.recency > $1.value.recency }
            .prefix(tuning.maxMirrors)
            .map(\.key)
    }

    /// Targets whose overlay cursor is due on screen (the controller still checks the window is visible).
    func activeCursors(now: TimeInterval) -> [TargetKey] {
        entries.compactMap { key, entry in
            guard let until = entry.cursorVisibleUntil, now < until else { return nil }
            return key
        }
    }

    /// True while something may still change on its own (a mirror waiting to fade, a cursor waiting to hide), so the
    /// controller keeps its timer running.
    var hasPendingTimers: Bool {
        entries.values.contains { ($0.wantsMirror && !$0.mirrorFaded) || $0.cursorVisibleUntil != nil }
    }

    /// Drops entries that no longer want anything (no mirror, no cursor).
    private mutating func prune() {
        for (key, entry) in entries where !entry.wantsMirror && entry.cursorVisibleUntil == nil {
            entries[key] = nil
        }
    }
}

/// How the agent cursor moves: an ease-out glide whose length grows with the distance, within a calm range.
enum CursorMotion {
    static let minDuration: TimeInterval = 0.14
    static let maxDuration: TimeInterval = 0.42
    /// Points per second of the glide before clamping.
    static let speed: CGFloat = 1800
    /// The press ring's lifetime.
    static let pulseDuration: TimeInterval = 0.35

    static func duration(from: CGPoint?, to: CGPoint) -> TimeInterval {
        guard let from else { return 0 }
        let d = hypot(to.x - from.x, to.y - from.y)
        if d < 1 { return 0 }
        return min(max(TimeInterval(d / speed), minDuration), maxDuration)
    }

    /// Ease-out cubic: fast start, gentle arrival.
    static func ease(_ t: Double) -> Double {
        let c = min(max(t, 0), 1)
        return 1 - pow(1 - c, 3)
    }

    static func position(from: CGPoint, to: CGPoint, progress t: Double) -> CGPoint {
        let e = CGFloat(ease(t))
        return CGPoint(x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e)
    }
}
