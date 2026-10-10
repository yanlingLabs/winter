import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// One desktop visit at a time, helper-wide: an async acquire (a capture awaits between the switch and the
/// return), a synchronous release.
final class CUVisitGate: @unchecked Sendable {
    private let lock = NSLock()
    private var busy = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func acquire() async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            lock.lock()
            if busy {
                waiters.append(c)
                lock.unlock()
            } else {
                busy = true
                lock.unlock()
                c.resume()
            }
        }
    }

    func release() {
        lock.lock()
        if waiters.isEmpty {
            busy = false
            lock.unlock()
        } else {
            let next = waiters.removeFirst()
            lock.unlock()
            next.resume()
        }
    }
}

/// The background attempt of an act needs the window on screen, its window is on another desktop, and the
/// request carries the user's say (`desktopVisit`): the act is done once more inside a visit. Internal — never
/// on the wire.
struct CUVisitNeeded: Error {}

/// A DESKTOP VISIT (user ruling 2026-10-10): when an act can't land, or a live picture can't be had, without
/// taking the user to the window's desktop, and the user allowed it (the daemon's prompt — its own card and the
/// helper's on-screen panel): the user's place is recorded (their desktop, their front app and its window), the
/// window's desktop is brought forward, the window is waited for until it is on screen and has painted, EXACTLY
/// the one primitive runs, and the user is brought back at once — under `SLSDisableUpdate`, verified, retried
/// once, and said loudly when it failed. The guardian treats the switch and the return as the agent's own
/// (neither undone nor adopted), so a failed return can still be put right; a user who moved somewhere of their
/// own during it is left where they went. Nothing ever holds the user there past the primitive.
extension CUCore {
    struct VisitState {
        let targetId: String
        let pid: pid_t
        let windowID: CGWindowID
        let appName: String
        let why: CUError.DesktopVisitWhy
        /// The user's place before the visit, and their front app's focused window then (raised on the way back:
        /// by then that app's focused window can be the target's, when the user's app IS the target app).
        let before: CUUserView
        let userWindow: AXUIElement?
        let startedMs: Double
        let startedAt: TimeInterval
        /// Where the visit took the user (the window's desktop), once it arrived.
        var arrived: CUUserView?
    }

    /// Whether `t` is being visited now (the per-act guard and `inForeground` read it).
    func isVisiting(_ t: CUTarget) -> Bool { visitLock.withLock { visitingTargetId == t.id } }

    /// When the visit in progress began, or nil when there is none.
    func visitStart() -> TimeInterval? { visitLock.withLock { visitingTargetId == nil ? nil : visitStartedAt } }

    /// Hardware input after `start`: the listen-only tap's last hardware event, or the HID state.
    func hardwareInputSince(_ start: TimeInterval, now: TimeInterval) -> Bool {
        let last = guardianLock.withLock { lastHardwareInputAt }
        if last >= 0, last > start { return true }
        return secondsSinceUserInput < max(0, now - start)
    }

    /// During a visit, the guardian's "user input" is only input that came AFTER the visit began (the click on the
    /// panel's "Switch now" a moment before must never make the visit's own switch the user's). Nil: no visit.
    func visitInput(now: TimeInterval) -> Bool? {
        guard let start = visitStart() else { return nil }
        return hardwareInputSince(start, now: now)
    }

    // MARK: there

    /// Takes the user to `t`'s desktop and waits until its window is on screen and has painted. Runs on the
    /// target's pid queue. If the window never comes on screen, the user is brought back and it throws.
    func visitArrive(_ t: CUTarget, why: CUError.DesktopVisitWhy) throws -> VisitState {
        let before = userView()
        let userWindow = before.front.flatMap { ax.element(ax.application($0), kAXFocusedWindowAttribute) }
        var s = VisitState(targetId: t.id, pid: t.pid, windowID: t.windowID, appName: t.appName, why: why, before: before,
                           userWindow: userWindow, startedMs: clock.nowMs(), startedAt: clock.nowSeconds())
        visitLock.withLock {
            visitingTargetId = t.id
            visitStartedAt = s.startedAt
        }
        guardianLock.withLock { guardianCore.beginVisit(app: t.pid, now: s.startedAt) }
        CULog.act.notice("visit (\(why.rawValue, privacy: .public)): taking the user to \(t.appName, privacy: .public)'s desktop for window \(t.windowID, privacy: .public)")
        noteSyntheticActivation()
        let window = try? windowElement(t)
        if let window { try? ax.perform(window, kAXRaiseAction) }
        _ = sys.activate(pid: t.pid)
        if let window { try? ax.perform(window, kAXRaiseAction) }
        // The window on screen (its desktop came forward), bounded.
        let deadline = clock.nowMs() + visitArriveMs
        var arrived = sys.window(id: t.windowID)?.onScreen == true
        while !arrived, clock.nowMs() < deadline {
            usleep(20_000)
            arrived = sys.window(id: t.windowID)?.onScreen == true
        }
        guard arrived else {
            let report = visitReturn(s, t)
            CULog.act.error("visit: \(t.appName, privacy: .public)'s window never came on screen — nothing was done there")
            throw Self.withVisit(CUError.unsupported("macOS did not show \(t.appName)'s desktop — nothing was done there"),
                                 report, app: t.appName)
        }
        s.arrived = userView()
        let painted = waitForFreshFrame(t)
        CULog.act.debug("visit: \(t.appName, privacy: .public) on screen after \(Int(self.clock.nowMs() - s.startedMs), privacy: .public) ms (\(painted, privacy: .public))")
        return s
    }

    /// The window is on screen: wait for a picture it painted THERE, bounded — a repaint landed (the picture
    /// changed from the first sample), or it has stayed the same `visitFreshStableMs` (nothing to repaint), or
    /// `visitFreshMaxMs` ran out. With no way to sample a picture (the private path is off), a short fixed wait.
    /// Returns how it ended, for the log.
    @discardableResult
    func waitForFreshFrame(_ t: CUTarget) -> String {
        let start = clock.nowMs()
        guard let first = visitFrameDigest(t) else {
            if visitNoProbeWaitMs > 0 { usleep(UInt32(visitNoProbeWaitMs * 1000)) }
            return "no sample"
        }
        while clock.nowMs() - start < visitFreshMaxMs {
            usleep(UInt32(max(1, visitFrameIntervalMs) * 1000))
            guard let d = visitFrameDigest(t) else { continue }
            if d != first { return "repainted" }
            if clock.nowMs() - start >= visitFreshStableMs { return "unchanged" }
        }
        return "at the bound"
    }

    /// A digest of the window's picture now: the window server's image, sampled on a stride (a whole window's
    /// pixels every 50 ms would cost more than the wait). Nil when it can't be read.
    func visitFrameDigest(_ t: CUTarget) -> Int? {
        if let o = visitFrameDigestOverride { return o(t) }
        guard t.privatePath, skyLight.canCaptureWindows, let frame = sys.window(id: t.windowID)?.frame,
              let image = try? privateWindowImage(t.windowID, globalRect: frame),
              let data = image.dataProvider?.data as Data? else { return nil }
        return Self.sampledDigest(data)
    }

    /// FNV-1a over every 61st byte (and the length). Pure.
    static func sampledDigest(_ data: Data) -> Int {
        var h: UInt64 = 0xcbf2_9ce4_8422_2325 ^ UInt64(data.count)
        data.withUnsafeBytes { raw in
            var i = 0
            while i < raw.count {
                h = (h ^ UInt64(raw[i])) &* 0x0000_0100_0000_01B3
                i += 61
            }
        }
        return Int(bitPattern: UInt(truncatingIfNeeded: h))
    }

    // MARK: back

    /// Brings the user back to where they were before the visit, AS SOON AS POSSIBLE, and verifies it — unless
    /// they moved somewhere of their own during it (hardware input, and they are now neither on the window's
    /// desktop nor back where they were): then they are left there. Never throws; runs on the pid queue.
    func visitReturn(_ s: VisitState, _ t: CUTarget) -> CUVisitReport {
        defer {
            visitLock.withLock { if visitingTargetId == s.targetId { visitingTargetId = nil; visitStartedAt = -1 } }
            // Shown on its desktop and repainted there: the next off-screen picture's freshness is unknown again.
            t.forgetOffScreenShot()
        }
        let now = userView()
        let sawInput = guardianLock.withLock { guardianCore.visitSawUserInput }
            || hardwareInputSince(s.startedAt, now: clock.nowSeconds())
        if sawInput, now != s.before, s.arrived == nil || now != s.arrived {
            // The user went somewhere of their own during the visit: theirs, never fought.
            guardianLock.withLock {
                guardianCore.endVisit()
                guardianCore.adoptUserView(CUGuardedView(app: now.front, space: now.space))
            }
            let ms = Int(clock.nowMs() - s.startedMs)
            CULog.act.notice("visit (\(s.why.rawValue, privacy: .public)) to \(s.appName, privacy: .public)'s desktop: the user moved elsewhere during it — left there (\(ms, privacy: .public) ms)")
            return CUVisitReport(ms: ms, returned: false, userMoved: true,
                                 detail: "the user moved somewhere else during the visit, so Winter left them there")
        }
        var back = now == s.before
        if !back, let user = s.before.front {
            back = returnOnce(s, user: user, window: s.userWindow) == s.before
            if !back {
                // Once more, the way the guardian restores (the app's focused window, the activation retried).
                CULog.guardian.notice("visit: not back after the first return — trying once more")
                back = returnOnce(s, user: user, window: nil) == s.before
            }
        } else if !back {
            // No front app to bring back (unreadable before): back when the desktop is.
            back = s.before.space == nil || userView().space == s.before.space
        }
        // The guardian's view was never changed by the visit: if the user is not back, it still knows where they
        // belong, and the next activation or Space change puts them there.
        guardianLock.withLock { _ = guardianCore.endVisit() }
        let ms = Int(clock.nowMs() - s.startedMs)
        if back {
            CULog.act.notice("visit (\(s.why.rawValue, privacy: .public)) to \(s.appName, privacy: .public)'s desktop: \(ms, privacy: .public) ms, the user is back")
        } else {
            CULog.act.fault("visit (\(s.why.rawValue, privacy: .public)) to \(s.appName, privacy: .public)'s desktop: \(ms, privacy: .public) ms, the user could NOT be brought back (space \(s.before.space.map(String.init) ?? "?", privacy: .public), front \(s.before.front.map(String.init) ?? "?", privacy: .public))")
        }
        return CUVisitReport(ms: ms, returned: back, detail: back ? nil
            : "Winter could not bring the user back from \(s.appName)'s desktop — they may still be there")
    }

    /// One return attempt under `SLSDisableUpdate` (the switch back is not drawn as a flash): the recorded window
    /// raised, the user's app re-activated and retried within the restore deadline. Returns the view it ends on.
    private func returnOnce(_ s: VisitState, user: pid_t, window: AXUIElement?) -> CUUserView {
        noteSyntheticActivation()
        let cid = skyLight.disableUpdate()
        defer { if let cid { skyLight.reenableUpdate(cid) } }
        return restoreUserView(s.before, user: user, window: window)
    }

    // MARK: scoped

    /// Runs `body` — exactly ONE primitive — inside a visit to `t`'s desktop (on its pid queue). The user is
    /// brought back on every exit path; a failure carries the visit in its `data.visit`.
    func inDesktopVisit<T>(_ t: CUTarget, why: CUError.DesktopVisitWhy, token: CUCancellation.Token?,
                           _ body: () throws -> T) throws -> (T, CUVisitReport) {
        let s = try visitArrive(t, why: why)
        let result: Result<T, Error>
        do {
            try token?.check()
            result = .success(try body())
        } catch {
            result = .failure(error)
        }
        let report = visitReturn(s, t)
        switch result {
        case .success(let value): return (value, report)
        case .failure(let error): throw Self.withVisit(error, report, app: t.appName)
        }
    }

    /// A failure after (or during) a visit, carrying the visit (`data.visit`) — and saying so when the user could
    /// not be brought back.
    static func withVisit(_ error: Error, _ r: CUVisitReport, app: String) -> Error {
        guard var e = error as? CUError else { return error }
        var data = e.data ?? [:]
        var v: [String: CUJSON] = ["ms": .int(r.ms), "returned": .bool(r.returned)]
        if r.userMoved == true { v["userMoved"] = .bool(true) }
        if let d = r.detail { v["detail"] = .string(d) }
        data["visit"] = .object(v)
        e.data = data
        if !r.returned, r.userMoved != true {
            e.message += " — and Winter could not bring the user back from \(app)'s desktop"
        }
        return e
    }

    /// The helper errors a visit could get past, when the window is on another desktop: the foreground it needs,
    /// a window it can't reach from here, or the foreground rung finding it elsewhere.
    static func visitCouldHelp(_ e: CUError) -> Bool {
        ["needs_foreground", "window_elsewhere", "needs_desktop_visit"].contains(e.code)
    }
}
