import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// One desktop visit at a time, helper-wide: an async acquire (taken when a visit opens), a synchronous release
/// (when it closes).
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

/// The visit `visitArrive` made, so its caller can give back the gate it holds when the arrival throws.
final class VisitBox: @unchecked Sendable { var visit: CUOpenVisit? }

/// The background attempt of an act needs the window on screen, its window is on another desktop, and the
/// request carries the user's say (`desktopVisit`). Internal — never on the wire.
struct CUVisitNeeded: Error {}

/// An OPEN desktop visit: the user is on a window's desktop for a stretch of work. Its fields after `base` are
/// guarded by `CUCore.visitLock`.
final class CUOpenVisit: @unchecked Sendable {
    let id: String
    let base: CUCore.VisitBase
    /// Where the visit took the user (the window's desktop), once it arrived.
    var arrived: CUUserView?
    /// Primitives running in it now (activity id → its `visitMaxMs`), and the call ids that ran in it.
    var inFlight: [UUID: Int?] = [:]
    var callIds: Set<String> = []
    /// Every target that ran in it (their off-screen baselines are refreshed at the close).
    var targets: [String: CUTarget] = [:]
    var actions = 0
    /// When the last primitive in it finished (the grace close counts from there).
    var lastEndMs: Double = 0
    var closing = false
    /// The helper-wide gate this visit holds was given back (once, by whichever close ran).
    var gateReleased = false
    var graceWork: DispatchWorkItem?
    var capWork: DispatchWorkItem?

    init(id: String, base: CUCore.VisitBase) {
        self.id = id
        self.base = base
    }
}

/// DESKTOP VISITS (user rulings 2026-10-10): when an act can't land, or a live picture can't be had, without taking
/// the user to the window's desktop, and the user allowed it (the daemon's prompt — its card and the helper's
/// panel), the user is taken there ONCE for the whole stretch of work that needs it and brought back right after the
/// last of it — never back and forth between their view and the window's, never held there to the script's end.
///
/// - OPEN: the first primitive that needs the window's desktop records the user's place (their desktop, front app,
///   and that app's window), brings the WINDOW forward (its element raised, then its app made frontmost), waits
///   for it on screen and painted, and leaves the visit open.
/// - WHILE OPEN: every later primitive of that session on a window of the visited desktop runs there, with no
///   further switch (a live shot of it is an on-screen capture) — reads and waits too, which keep it open. One that
///   needs ANOTHER desktop — the user's own, or a third — closes the visit first (the user returned), then runs as
///   ever: no prompt for the user's own desktop, a new visit (with `desktopVisit`) or `needs_desktop_visit` for a
///   third. `needs_desktop_visit` is never answered while the session's visit is open.
/// - CLOSE, at the first of: `visitCloseGraceMs` after the last primitive in it finished with none started since;
///   the script's end, a cancel of a request in it, Esc, the session's end, `visit.close`; another desktop needed;
///   the user moving by themselves (a hardware-attributed activation or Space change — then left there); the
///   safety cap. The user is brought back (their window raised, their app made frontmost), verified, retried once,
///   a fault logged when it failed; each closed visit is reported once (`visit.close`) and announced
///   (`desktopVisited`).
///
/// The guardian treats the whole open visit as the agent's own: neither undone nor adopted.
extension CUCore {
    /// What a visit records when it opens.
    struct VisitBase {
        let sessionId: String
        /// The request that opened it, when it had a call id.
        let callId: String?
        let targetId: String
        let pid: pid_t
        let windowID: CGWindowID
        let appName: String
        let why: CUError.DesktopVisitWhy
        /// The user's place before the visit, and their front app's focused window then (raised on the way back:
        /// by then that app's focused window can be the target's, when the user's app IS the target app).
        let before: CUUserView
        let userWindow: AXUIElement?
        /// That window's id (for the log; the recorded element is what is raised on the way back).
        let userWindowID: CGWindowID?
        /// The private path is on (a capture-only window's element may be found by remote token).
        let privatePath: Bool
        let startedMs: Double
        let startedAt: TimeInterval
    }

    enum VisitCloseReason: String {
        case grace, scriptEnded = "script ended", cancelled, escape, sessionEnded = "session ended", requested,
             otherDesktop = "another desktop needed", userMoved = "the user moved", cap = "safety cap", neverArrived = "never arrived"
    }

    // MARK: what is open

    /// The open visit, if it belongs to `sessionId` (and is not closing).
    func openVisit(of sessionId: String) -> CUOpenVisit? {
        visitLock.withLock { openVisit.flatMap { $0.base.sessionId == sessionId && !$0.closing ? $0 : nil } }
    }

    /// `t`'s window is on the visited desktop now: on screen, with the visited desktop showing.
    func onVisitedDesktop(_ v: CUOpenVisit, _ t: CUTarget) -> Bool {
        guard t.sessionId == v.base.sessionId, sys.window(id: t.windowID)?.onScreen == true else { return false }
        let there = visitLock.withLock { v.arrived?.space }
        guard let there, let now = sys.activeSpace() else { return true }
        return now == there
    }

    /// Whether `t` runs inside its session's open visit now (the per-act guard and `inForeground` read it).
    func isVisiting(_ t: CUTarget) -> Bool {
        guard let v = openVisit(of: t.sessionId) else { return false }
        return onVisitedDesktop(v, t)
    }

    /// When the visit in progress began, or nil when there is none.
    func visitStart() -> TimeInterval? { visitLock.withLock { openVisit?.base.startedAt } }

    /// During a visit, the guardian's "user input" is only a HARDWARE ACTION — a click, a key, a scroll, a gesture
    /// from no process (`eventSourceUnixProcessID` 0) and not the helper's stamp; a pointer move alone never counts
    /// — that came after the visit began AND after the agent's own latest cause (the click on the panel's "Switch
    /// now" a moment before, or the helper's own rung-4 events, must never make the visit's switch the user's).
    /// Never the HID idle state, which counts synthetic events too. Nil: no visit.
    func visitInput(now: TimeInterval) -> Bool? {
        guard let start = visitStart() else { return nil }
        let (action, cause) = guardianLock.withLock { (lastHardwareActionAt, guardianLastCause) }
        return action >= 0 && action > max(start, cause)
    }

    /// The guardian saw the user move by themselves during the visit (a hardware-attributed activation or Space
    /// change): the visit closes now, leaving them where they went.
    func noteVisitUserMove() {
        // Only once the visit has arrived (its own switch there is not the user's doing).
        guard let v = visitLock.withLock({ openVisit.flatMap { $0.arrived != nil && !$0.closing ? $0 : nil } }) else { return }
        Task { [weak self] in _ = await self?.closeVisit(v, reason: .userMoved) }
    }

    /// How long a visit mode lasts for a primitive's deadline (`visitMaxMs`), clamped to 10…330 s. Pure.
    static func visitModeSeconds(maxMs: Int?) -> TimeInterval {
        Double(min(max(maxMs ?? 10_000, 10_000), 330_000)) / 1000
    }

    // MARK: open

    /// Opens a visit to `t`'s desktop (one at a time, helper-wide): the user's place recorded, the window brought
    /// forward and waited for on screen and painted. Refused before anything moves when the window can't be reached
    /// or the user's front app can't be read; a window that never comes on screen brings the user back and throws.
    func openDesktopVisit(_ t: CUTarget, why: CUError.DesktopVisitWhy, privatePath: Bool, sessionId: String,
                          callId: String?, maxMs: Int?) async throws -> CUOpenVisit {
        await visitGate.acquire()
        let made = VisitBox()
        do {
            let v = try await queues.run(t.pid) { [self] in try visitArrive(t, why: why, privatePath: privatePath, sessionId: sessionId,
                                                                            callId: callId, maxMs: maxMs, made: made) }
            rearmVisitTimers(v)
            return v
        } catch {
            // Refused before anything moved (no visit made): the gate back now. A visit made and then closed (never
            // arrived, or a close claimed it) gives its gate back with that close.
            if let v = made.visit { releaseVisitGate(v) } else { visitGate.release() }
            throw error
        }
    }

    /// The way there (on `t`'s pid queue). The WINDOW is brought forward, not merely its app — measured on macOS 26.6
    /// (2026-10-10), with the app also having a window on the user's desktop (the live failure): the window's element
    /// made main and raised, THEN the app made frontmost over accessibility, takes macOS to the window's desktop
    /// (~0.3 s); activating the app alone, or bringing the window to the front by its id (`SetFrontProcess` with the
    /// window and the key-window records), activates it right here and never switches. So the element is what it
    /// takes: the target's own, or — for a window bound capture-only — found now by its id (macOS exposes one once
    /// the window has been shown on its desktop). With none, the app alone comes forward, which reaches the window's
    /// desktop only when the app has no window on the user's; otherwise the visit is refused before anything moves,
    /// as it is when the user's Mac does not follow an app to its desktop (Desktop & Dock).
    func visitArrive(_ t: CUTarget, why: CUError.DesktopVisitWhy, privatePath: Bool, sessionId: String, callId: String?,
                     maxMs: Int?, made: VisitBox) throws -> CUOpenVisit {
        guard sys.spacesFollowActivation() != false else {
            CULog.act.notice("visit (\(why.rawValue, privacy: .public)): macOS is set not to switch to an app's desktop — not visited, nothing moved")
            throw CUError.unsupported("this Mac is set not to switch to an app's desktop when it comes forward (System Settings › Desktop & Dock › \u{201C}When switching to an application, switch to a Space with open windows for the application\u{201D}), so Winter can't take you to \(t.appName)'s window — nothing was moved")
        }
        let element = visitElement(t, privatePath: privatePath)
        if element == nil, appHasWindowHere(t) {
            CULog.act.notice("visit (\(why.rawValue, privacy: .public)): \(t.appName, privacy: .public)'s window has no element and the app has a window on the user's desktop — not reachable, nothing moved")
            throw CUError.unsupported("\(t.appName)'s window can't be brought forward on its desktop: macOS has not exposed it (it has not been shown there since it opened), and \(t.appName) has a window on this desktop, where it would stay — ask the user to show it once; nothing was moved")
        }
        let before = userView()
        // Where to bring the user back: without their front app, nowhere — so they are not taken anywhere.
        guard before.front != nil else {
            CULog.act.notice("visit (\(why.rawValue, privacy: .public)): the user's front app can't be read — not visited, nothing moved")
            throw CUError.refused(.frontUnknown, "Winter can't tell which app you are in, so it could not bring you back — nothing was moved")
        }
        let userWindow = before.front.flatMap { ax.element(ax.application($0), kAXFocusedWindowAttribute) }
        // Nothing to anchor the way back: the return would be the user's app made frontmost ALONE — the very call
        // that takes macOS to a desktop with that app's windows — so with windows of it on other desktops it could
        // land the user on a third one. Refused before anything moves.
        if userWindow == nil, let user = before.front, appHasWindowsElsewhere(user) {
            CULog.act.notice("visit (\(why.rawValue, privacy: .public)): the user's app has no focused window to come back to, and has windows on other desktops — not visited, nothing moved")
            throw CUError.unsupported("Winter can't tell which window you are in, so it could not be sure to bring you back to this desktop afterwards — nothing was moved; ask the user to click into the window they are working in, or to show \(t.appName)'s window themselves")
        }
        let base = VisitBase(sessionId: sessionId, callId: callId, targetId: t.id, pid: t.pid, windowID: t.windowID,
                             appName: t.appName, why: why, before: before, userWindow: userWindow,
                             userWindowID: userWindow.flatMap { ax.windowID($0) }, privatePath: privatePath,
                             startedMs: clock.nowMs(), startedAt: clock.nowSeconds())
        let v: CUOpenVisit = visitLock.withLock {
            visitSeq += 1
            let v = CUOpenVisit(id: "v\(visitSeq)", base: base)
            v.targets[t.id] = t
            openVisit = v
            return v
        }
        made.visit = v
        guardianLock.withLock {
            guardianCore.beginVisit(app: t.pid, now: base.startedAt, maxSeconds: max(Self.visitModeSeconds(maxMs: maxMs), visitCapMs / 1000))
        }
        // The switch is the agent's own cause: only input after it can be the user's.
        noteGuardianCause(t.pid)
        CULog.act.notice("visit \(v.id, privacy: .public) (\(why.rawValue, privacy: .public)): taking the user to \(t.appName, privacy: .public)'s desktop for window \(t.windowID, privacy: .public) (\(element == nil ? "the app alone: no element" : "its element raised", privacy: .public))")
        noteSyntheticActivation()
        _ = sys.bringForward(pid: t.pid, windowID: t.windowID, window: element, makeMain: true)
        // The window on screen AND the desktop changed (when it can be read), bounded. Halfway, once more: by then
        // the app is in front (here, if it stayed), and an active app's window raised takes macOS to its desktop.
        let arrivedNow = { [self] () -> Bool in
            guard sys.window(id: t.windowID)?.onScreen == true else { return false }
            guard let was = before.space, let now = sys.activeSpace() else { return true }
            return now != was
        }
        let start = clock.nowMs()
        let deadline = start + visitArriveMs
        var arrived = arrivedNow()
        var again = false
        while !arrived, clock.nowMs() < deadline {
            usleep(20_000)
            arrived = arrivedNow()
            if !arrived, !again, clock.nowMs() - start >= visitArriveMs / 2 {
                again = true
                CULog.act.notice("visit \(v.id, privacy: .public): not on \(t.appName, privacy: .public)'s desktop yet — bringing the window forward once more")
                noteGuardianCause(t.pid)  // a switch this causes late is still the agent's own
                noteSyntheticActivation()
                _ = sys.bringForward(pid: t.pid, windowID: t.windowID, window: element, makeMain: true)
            }
        }
        guard arrived else {
            CULog.act.error("visit \(v.id, privacy: .public): \(t.appName, privacy: .public)'s window never came on screen — nothing was done there")
            // Its queued raise and activation (a busy app answers AX late) may still switch the desktop: a cause now.
            noteGuardianCause(t.pid)
            let failure = CUError.unsupported("macOS did not show \(t.appName)'s desktop — nothing was done there")
            // Closed here — unless a close (a cancel, the script's end) claimed it meanwhile: that one, queued behind
            // this on the pid queue, brings the user back and reports it.
            let mine: Bool = visitLock.withLock {
                guard !v.closing else { return false }
                v.closing = true
                return true
            }
            guard mine else { throw failure }
            let report = finishVisit(v, reason: .neverArrived)
            recordClosed(v, report)
            throw Self.withVisit(failure, report, app: t.appName)
        }
        let there = userView()
        visitLock.withLock { v.arrived = there }
        let painted = waitForFreshFrame(t)
        CULog.act.debug("visit \(v.id, privacy: .public): \(t.appName, privacy: .public) on screen after \(Int(self.clock.nowMs() - base.startedMs), privacy: .public) ms (\(painted, privacy: .public))")
        return v
    }

    /// The element to raise for a visit to `t`'s window: the target's own; for a target bound capture-only, the
    /// window's element found now by its id — in the app's list, or (with the private path) by remote token, as a
    /// bind would — since macOS exposes one once the window has been shown on its desktop. Nil when there is none.
    func visitElement(_ t: CUTarget, privatePath: Bool) -> AXUIElement? {
        if t.accessible { return try? windowElement(t) }
        if let w = CUAXWindows.list(pid: t.pid, ax: ax, server: sys.windows(pid: t.pid)).first(where: { $0.id == t.windowID }) {
            return w.element
        }
        return privatePath ? remoteWindow(pid: t.pid, windowID: t.windowID) : nil
    }

    /// `t`'s app has another window on screen here (the user's desktop): brought forward alone, it stays here.
    func appHasWindowHere(_ t: CUTarget) -> Bool {
        sys.windows(pid: t.pid).contains { $0.id != t.windowID && $0.onScreen && CUWindowServer.isRealWindow($0) }
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

    // MARK: work in it

    /// A primitive starts running in the visit: the grace close is off while it runs, and the cap extends to its
    /// own deadline. Nil when the visit is closing (the caller runs outside it).
    func beginVisitActivity(_ v: CUOpenVisit, _ t: CUTarget, callId: String?, maxMs: Int?) -> UUID? {
        let id = UUID()
        let ok: Bool = visitLock.withLock {
            guard openVisit === v, !v.closing else { return false }
            v.inFlight[id] = maxMs
            if let callId { v.callIds.insert(callId) }
            v.targets[t.id] = t
            v.actions += 1
            v.graceWork?.cancel()
            v.graceWork = nil
            return true
        }
        guard ok else { return nil }
        rearmVisitTimers(v)
        return id
    }

    /// It finished: with nothing else running, the visit closes `visitGraceMs` from now unless another starts.
    func endVisitActivity(_ v: CUOpenVisit, _ id: UUID?) {
        guard let id else { return }
        let now = clock.nowMs()
        visitLock.withLock {
            _ = v.inFlight.removeValue(forKey: id)
            v.lastEndMs = now
        }
        rearmVisitTimers(v)
    }

    /// The grace close (nothing running) and the safety cap, re-armed after every start and end; the guardian's
    /// visit mode follows the cap.
    func rearmVisitTimers(_ v: CUOpenVisit) {
        let plan: (grace: Bool, capMs: Double)? = visitLock.withLock {
            guard openVisit === v, !v.closing else { return nil }
            v.capWork?.cancel()
            let longest = v.inFlight.values.compactMap { $0 }.max().map(Double.init) ?? 0
            return (v.inFlight.isEmpty, v.inFlight.isEmpty ? visitCapMs : max(visitCapMs, longest))
        }
        guard let plan else { return }
        let cap = visitSchedule(plan.capMs) { [weak self] in
            Task { _ = await self?.closeVisit(v, reason: .cap) }
        }
        var grace: DispatchWorkItem?
        if plan.grace {
            grace = visitSchedule(visitGraceMs) { [weak self] in
                Task { _ = await self?.closeVisit(v, reason: .grace) }
            }
        }
        visitLock.withLock {
            v.capWork = cap
            if let grace { v.graceWork?.cancel(); v.graceWork = grace }
        }
        let until = clock.nowSeconds() + plan.capMs / 1000
        guardianLock.withLock { guardianCore.extendVisit(until: until) }
    }

    /// Runs `body` as a primitive of `t` inside its session's open visit when `t`'s window is on the visited desktop
    /// (it keeps the visit open meanwhile); else as it is. Returns whether it ran inside.
    func inOpenVisit<T>(_ t: CUTarget, callId: String?, maxMs: Int? = nil, _ body: () async throws -> T) async throws -> (T, Bool) {
        guard let v = openVisit(of: t.sessionId), onVisitedDesktop(v, t), let id = beginVisitActivity(v, t, callId: callId, maxMs: maxMs) else {
            return (try await body(), false)
        }
        defer { endVisitActivity(v, id) }
        do { return (try await body(), true) } catch { throw Self.markedInVisit(error) }
    }

    // MARK: close

    /// Closes the session's open visit (if any), returning the user. True when one was closed.
    @discardableResult
    func closeVisit(of sessionId: String, reason: VisitCloseReason) async -> Bool {
        guard let v = openVisit(of: sessionId) else { return false }
        return await closeVisit(v, reason: reason) != nil
    }

    /// Closes every open visit (Esc).
    public func closeAllVisits() async {
        guard let v = visitLock.withLock({ openVisit }) else { return }
        _ = await closeVisit(v, reason: .escape)
    }

    /// Closes `v` once (any later call is nil): the return, run on the visited target's pid queue (after a primitive
    /// still running there), the baselines refreshed, the report kept for `visit.close` and announced. A grace close
    /// that a new primitive overtook does nothing.
    func closeVisit(_ v: CUOpenVisit, reason: VisitCloseReason) async -> CUVisitReport? {
        let claimed: Bool = visitLock.withLock {
            guard openVisit === v, !v.closing else { return false }
            // A grace close a newer primitive overtook (running, or finished less than the grace ago) does nothing.
            if reason == .grace, !v.inFlight.isEmpty || clock.nowMs() - v.lastEndMs < visitGraceMs - 50 { return false }
            v.closing = true
            v.graceWork?.cancel()
            v.capWork?.cancel()
            return true
        }
        guard claimed else { return nil }
        let report: CUVisitReport
        if let r = try? await queues.run(v.base.pid, { [self] in finishVisit(v, reason: reason) }) {
            report = r
        } else {
            report = finishVisit(v, reason: reason)
        }
        recordClosed(v, report)
        releaseVisitGate(v)
        return report
    }

    /// Gives back the helper-wide gate `v` holds — once.
    func releaseVisitGate(_ v: CUOpenVisit) {
        let first: Bool = visitLock.withLock {
            guard !v.gateReleased else { return false }
            v.gateReleased = true
            return true
        }
        if first { visitGate.release() }
    }

    /// The visit is over: `openVisit` cleared, its report kept (bounded) for `visit.close`, and announced.
    func recordClosed(_ v: CUOpenVisit, _ report: CUVisitReport) {
        visitLock.withLock {
            if openVisit === v { openVisit = nil }
            var list = closedVisits[v.base.sessionId] ?? []
            list.append(report)
            if list.count > 32 { list.removeFirst(list.count - 32) }
            closedVisits[v.base.sessionId] = list
        }
        let event = CUDesktopVisitEvent(sessionId: v.base.sessionId, callId: v.base.callId, report: report)
        emit { $0.desktopVisited(event) }
    }

    /// `visit.close`: the session's open visit closed (the user returned), and every closed, unclaimed report of the
    /// session — each exactly once.
    public func visitClose(_ p: VisitCloseParams) async throws -> VisitCloseResult {
        await closeVisit(of: p.sessionId, reason: .requested)
        let reports = visitLock.withLock { closedVisits.removeValue(forKey: p.sessionId) ?? [] }
        return VisitCloseResult(visits: reports)
    }

    /// The session is gone: its open visit closed, its unclaimed reports dropped.
    func endSessionVisits(_ sessionId: String) async {
        await closeVisit(of: sessionId, reason: .sessionEnded)
        visitLock.withLock { _ = closedVisits.removeValue(forKey: sessionId) }
    }

    /// A cancel for a request that ran in the open visit closes it.
    func cancelVisit(callId: String) {
        guard let v = visitLock.withLock({ openVisit.flatMap { $0.callIds.contains(callId) ? $0 : nil } }) else { return }
        Task { [weak self] in _ = await self?.closeVisit(v, reason: .cancelled) }
    }

    /// The return (on the visited target's pid queue): the user brought back AS SOON AS POSSIBLE and verified —
    /// unless they moved somewhere of their own during it (the guardian saw a hardware-attributed activation or
    /// Space change, and they are now neither on the window's desktop nor back where they were): then they are
    /// left there. A visit that never arrived always brings them back. Then, the user already back (their time
    /// away never lengthened), the off-screen baselines of the windows that ran in it are refreshed.
    func finishVisit(_ v: CUOpenVisit, reason: VisitCloseReason) -> CUVisitReport {
        let s = v.base
        let (arrived, actions, targets) = visitLock.withLock { (v.arrived, v.actions, Array(v.targets.values)) }
        let report = { (ms: Int, returned: Bool, userMoved: Bool?, detail: String?) in
            CUVisitReport(visitId: v.id, targetId: s.targetId, app: s.appName, why: s.why.rawValue, actions: actions, ms: ms,
                          returned: returned, userMoved: userMoved, detail: detail)
        }
        let now = userView()
        let sawUserMove = guardianLock.withLock { guardianCore.visitSawUserInput }
        if let arrived, sawUserMove, now != s.before, now != arrived {
            // Theirs, never fought.
            guardianLock.withLock {
                guardianCore.endVisit()
                guardianCore.adoptUserView(CUGuardedView(app: now.front, space: now.space))
            }
            let ms = Int(clock.nowMs() - s.startedMs)
            CULog.act.notice("visit \(v.id, privacy: .public) to \(s.appName, privacy: .public)'s desktop (\(reason.rawValue, privacy: .public)): the user moved elsewhere during it — left there (\(ms, privacy: .public) ms, \(actions, privacy: .public) actions)")
            return report(ms, false, true, "the user moved somewhere else during the visit, so Winter left them there")
        }
        var back = now == s.before && userWindowBack(s)
        if !back, let user = s.before.front {
            back = returnOnce(s, user: user, window: s.userWindow) == s.before && userWindowBack(s)
            if !back {
                // Once more, the way the guardian restores (the app's focused window, the activation retried).
                CULog.guardian.notice("visit \(v.id, privacy: .public): not back after the first return — trying once more")
                back = returnOnce(s, user: user, window: s.userWindow) == s.before && userWindowBack(s)
            }
        }
        // A visit that never arrived: the target's raise and activation are AX calls a busy app answers late (each
        // bounded only by the messaging timeout), so its switch can still land after the deadline — even after the
        // user was put back. Watched for `visitLateSwitchMs`, and undone (at most twice) if it lands.
        if reason == .neverArrived, let user = s.before.front {
            let until = clock.nowMs() + visitLateSwitchMs
            var undone = 0
            while clock.nowMs() < until, undone < 2 {
                usleep(40_000)
                guard userView() != s.before else { continue }
                undone += 1
                CULog.act.notice("visit \(v.id, privacy: .public): the switch to \(s.appName, privacy: .public)'s desktop landed after the arrival deadline — bringing the user back")
                back = returnOnce(s, user: user, window: s.userWindow) == s.before && userWindowBack(s)
            }
            back = userView() == s.before && userWindowBack(s)
        }
        // The guardian's view was never changed by the visit: if the user is not back, it still knows where they
        // belong, and the next activation or Space change puts them there.
        guardianLock.withLock { _ = guardianCore.endVisit() }
        let ms = Int(clock.nowMs() - s.startedMs)
        if back {
            CULog.act.notice("visit \(v.id, privacy: .public) (\(s.why.rawValue, privacy: .public)) to \(s.appName, privacy: .public)'s desktop closed (\(reason.rawValue, privacy: .public)): \(ms, privacy: .public) ms, \(actions, privacy: .public) actions, the user is back")
            for t in targets { refreshOffScreenBaseline(t) }
        } else {
            CULog.act.fault("visit \(v.id, privacy: .public) (\(s.why.rawValue, privacy: .public)) to \(s.appName, privacy: .public)'s desktop closed (\(reason.rawValue, privacy: .public)): \(ms, privacy: .public) ms, the user could NOT be brought back (space \(s.before.space.map(String.init) ?? "?", privacy: .public), front \(s.before.front.map(String.init) ?? "?", privacy: .public))")
        }
        return report(ms, back, nil, back ? nil : "Winter could not bring the user back from \(s.appName)'s desktop — they may still be there")
    }

    /// The window's off-screen picture taken again the way its last off-screen or live shot was (region and budget)
    /// and recorded as the baseline (`noteOffScreenShot`): a later live shot is then served without a visit when the
    /// window server's copy changed since (the app draws there), and visits again when it did not. Kept as it was
    /// when the picture can't be taken.
    func refreshOffScreenBaseline(_ t: CUTarget) {
        guard t.privatePath, let last = t.lastStill, sys.window(id: t.windowID)?.onScreen == false,
              let still = try? offScreenStill(t, last.region, last.budget) else { return }
        _ = t.noteOffScreenShot(digest: Self.contentDigest(still.jpeg), at: clock.nowMs())
    }

    /// One return attempt: the user's recorded window raised and their app made frontmost over accessibility — the
    /// way back measured on macOS 26.6 (~0.3 s across desktops; their app may have windows on several, the raised one
    /// decides) — then the restore's own activation, retried within its deadline. Never a key-window record or any
    /// event into the user's window (they arrive as a click). On the user's own desktop (a visit that never left it)
    /// it runs under `SLSDisableUpdate`, so the switch back is not drawn as a flash; across desktops macOS draws
    /// the switch itself. Returns the view it ends on.
    private func returnOnce(_ s: VisitBase, user: pid_t, window: AXUIElement?) -> CUUserView {
        noteSyntheticActivation()
        let sameDesktop = s.before.space == nil || sys.activeSpace() == s.before.space
        let cid = sameDesktop ? skyLight.disableUpdate() : nil
        defer { if let cid { skyLight.reenableUpdate(cid) } }
        // Made main again too (an AX write, never an event): when the user's app IS the target app, the visit made
        // the target's window main, and the user's own window must be the one keys go to once they are back.
        _ = sys.bringForward(pid: user, windowID: s.userWindowID ?? 0, window: window, makeMain: true)
        return restoreUserView(s.before, user: user, window: window)
    }

    /// The user's app's focused window is the one they were in (when it was recorded and can be read): back means
    /// in THAT window, not merely in that app on that desktop (the user's app may be the target app).
    func userWindowBack(_ s: VisitBase) -> Bool {
        guard let want = s.userWindowID, let user = s.before.front,
              let focused = ax.element(ax.application(user), kAXFocusedWindowAttribute), let id = ax.windowID(focused)
        else { return true }
        return id == want
    }

    /// `pid` has a real window that is not on screen (another desktop, full screen).
    func appHasWindowsElsewhere(_ pid: pid_t) -> Bool {
        sys.windows(pid: pid).contains { !$0.onScreen && CUWindowServer.isRealWindow($0) && sys.windowOnAnySpace($0.id) != false }
    }

    // MARK: errors

    /// A failure that closed a visit (a window that never came on screen), carrying the visit (`data.visit`) — and
    /// saying so when the user could not be brought back. A failure that is not a `CUError` (a Swift cancellation)
    /// becomes the `cancelled` one, so the visit still rides it.
    static func withVisit(_ error: Error, _ r: CUVisitReport, app: String) -> Error {
        var e = asCUError(error)
        var data = e.data ?? [:]
        var v: [String: CUJSON] = ["visitId": .string(r.visitId), "actions": .int(r.actions), "ms": .int(r.ms),
                                   "returned": .bool(r.returned)]
        if r.userMoved == true { v["userMoved"] = .bool(true) }
        if let d = r.detail { v["detail"] = .string(d) }
        data["visit"] = .object(v)
        e.data = data
        if !r.returned, r.userMoved != true {
            e.message += " — and Winter could not bring the user back from \(app)'s desktop"
        }
        return e
    }

    /// A failure of a primitive that ran inside a visit: `data.inVisit` (a Swift cancellation becomes `cancelled`).
    static func markedInVisit(_ error: Error) -> Error {
        if error is CUVisitNeeded { return error }
        var e = asCUError(error)
        var data = e.data ?? [:]
        data["inVisit"] = .bool(true)
        e.data = data
        return e
    }

    static func asCUError(_ error: Error) -> CUError {
        if let c = error as? CUError { return c }
        if error is CancellationError { return .cancelled }
        return CUError.unsupported("the helper failed (\(type(of: error)))")
    }

    /// The helper errors a visit could get past, when the window is on another desktop: the foreground it needs,
    /// a window it can't reach from here, or the foreground rung finding it elsewhere.
    static func visitCouldHelp(_ e: CUError) -> Bool {
        ["needs_foreground", "window_elsewhere", "needs_desktop_visit"].contains(e.code)
    }

    /// The act needs its window's desktop (with the user's say, or without it).
    static func needsItsDesktop(_ error: Error) -> Bool {
        error is CUVisitNeeded || (error as? CUError)?.code == "needs_desktop_visit"
    }
}
