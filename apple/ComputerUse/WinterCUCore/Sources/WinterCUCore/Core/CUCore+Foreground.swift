import ApplicationServices
import Foundation

/// `target.foreground` (the script's `app.requestForeground(reason)`, after the user's card): the app comes to the
/// front and stays there until the session's script ends — then the front goes back to the app that had it, if the
/// held app still has it (a switch the user made meanwhile is left alone). Acts meanwhile run with the app in
/// front, so they land the way they do for a person; the user-view guard and the Focus Guardian leave it alone.
extension CUCore {
    struct HeldForeground {
        var sessionId: String
        var pid: pid_t
        var appName: String
        var previous: pid_t?
    }

    /// The longest a hold lasts if its script's end is never heard (the daemon's longest script, with room).
    static let holdForegroundMaxSeconds: TimeInterval = 330

    public func targetForeground(_ p: TargetForegroundParams) async throws -> TargetForegroundResult {
        let t = try target(p.targetId)
        try ensureAlive(t)
        return try await queues.run(t.pid) { [self] in
            let previous = sys.frontmostPid()
            let first = holdLock.withLock { () -> Bool in
                if heldForeground[t.id] != nil { return false }
                heldForeground[t.id] = HeldForeground(sessionId: t.sessionId, pid: t.pid, appName: t.appName,
                                                      previous: previous == t.pid ? nil : previous)
                return true
            }
            guardianLock.withLock { guardianCore.exempt(t.pid, until: clock.nowSeconds() + Self.holdForegroundMaxSeconds) }
            if sys.frontmostPid() != t.pid {
                noteSyntheticActivation()
                _ = sys.activate(pid: t.pid)
                if let w = try? windowElement(t) { try? ax.perform(w, kAXRaiseAction) }
            }
            var front = false
            for _ in 0..<50 {
                if sys.frontmostPid() == t.pid { front = true; break }
                usleep(20_000)
            }
            CULog.act.notice("foreground in \(t.appName, privacy: .public): \(front ? "held in front" : "could not be brought forward", privacy: .public)\(first ? "" : " (already held)", privacy: .public)")
            return TargetForegroundResult(front: front, detail: front ? nil
                : "macOS did not bring \(t.appName) to the front (it may be busy, or on a desktop it can't leave) — nothing was done in front")
        }
    }

    /// Whether `t` is held in front for its session's script.
    func holdsForeground(_ t: CUTarget) -> Bool { holdLock.withLock { heldForeground[t.id] != nil } }

    /// The session's script ended: every app held in front for it gives the front back.
    func releaseHeldForeground(sessionId: String) {
        let held = holdLock.withLock { () -> [HeldForeground] in
            let mine = heldForeground.filter { $0.value.sessionId == sessionId }
            for k in mine.keys { heldForeground[k] = nil }
            return Array(mine.values)
        }
        for h in held {
            guardianLock.withLock { guardianCore.endExempt(h.pid) }
            if sys.frontmostPid() == h.pid, let prev = h.previous, sys.appRunning(prev) {
                _ = sys.activate(pid: prev)
                CULog.act.notice("foreground in \(h.appName, privacy: .public): the front given back")
            }
        }
    }
}
