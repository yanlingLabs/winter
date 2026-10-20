import ApplicationServices
import CoreGraphics
import Foundation

// I6 in flight, at ONE chokepoint (round 17, the review of round 16's H1): once the user works in the target, nothing of
// an act already running reaches it. Round 16 checked the work mark before each focus placement, key and paste; the review
// found a dozen writes between those checks (a caret-placing selection write after a 400 ms web wait, `typeText`'s
// accessibility insert, `setValue`'s writes and its ⌘A, the selection holds, the End/Home fallback, a menu press after a
// second of preparation). So the check moved under them all: every accessibility write or action on the target's elements
// and every input event the act posts is refused while the user works in the target — whatever path the act took to it.

/// The act running on this thread: its target, and what the guard stopped (the act then ends refused, `user_working`).
final class CUActScope {
    let pid: pid_t
    let appName: String
    /// The first write or event the guard stopped, for the log; nil while none was.
    var stopped: String?
    /// Button and key downs this act sent: once it is stopped, an up goes only for a down that went (nothing left held
    /// down in the app, and no lone up for a down that never went).
    var buttonsDown = 0
    var keysDown = 0
    /// How many times the user's work mark had landed on the target when the act began (`CUFocusGuardianCore.workMarks`):
    /// a count that moved since means they worked in it during the act — even if they have left it since (the review of
    /// round 17, M1).
    let workMarksAtStart: Int
    init(pid: pid_t, appName: String, workMarksAtStart: Int = 0) {
        self.pid = pid
        self.appName = appName
        self.workMarksAtStart = workMarksAtStart
    }

    private static let key = "WinterCUCore.actScope"
    /// The act running on the current thread, if any (an act runs synchronously on its target's pid queue, start to end).
    static var current: CUActScope? { Thread.current.threadDictionary[key] as? CUActScope }
    static func swap(_ s: CUActScope?) -> CUActScope? {
        let d = Thread.current.threadDictionary
        let old = d[key] as? CUActScope
        d[key] = s
        return old
    }
}

/// The core the guarded backends ask (set once the core is built; weak — the core owns them).
final class CUActWriteGuard: @unchecked Sendable {
    weak var core: CUCore?

    /// When the helper last posted an input event of its own (`clock` seconds): the HID counters may hold it, so
    /// `markRecentUserWork` never reads them as the user's input that soon after.
    private let postLock = NSLock()
    private var lastPost: TimeInterval = -.infinity
    var lastPostAt: TimeInterval { postLock.withLock { lastPost } }
    func notePost() {
        guard let now = core?.clock.nowSeconds() else { return }
        postLock.withLock { lastPost = now }
    }

    /// May the act running on this thread write to (or post to) `owner` now? `owner` nil: not known — the target's
    /// (fail closed). For an event, `owner` is the process it is posted to (the target, or a content process of it).
    /// STICKY (the review of round 17, M1): once the act was stopped, or the user worked in the target at any moment since
    /// the act began, every later write or start event aimed at the target is refused for the rest of the act — the user
    /// leaving the target meanwhile reopens nothing.
    func allows(owner: pid_t?, _ what: @autoclosure () -> String) -> Bool {
        guard let scope = CUActScope.current, let core else { return true }
        if let owner, owner != scope.pid, !core.sys.isContentProcess(owner, of: scope.pid) { return true }  // another app's: a restore
        if scope.stopped != nil { return false }
        // (A granted requestForeground is no exemption here: the grant lifted the mark that was there then
        // (`holdForegroundNow`), so what this sees is the user's work since — which stops the act like any other.)
        guard core.userIsWorking(in: scope.pid) || core.workMarks(scope.pid) != scope.workMarksAtStart else { return true }
        if scope.stopped == nil {
            scope.stopped = what()
            CULog.act.notice("act in \(scope.appName, privacy: .public): the user started working in it — \(scope.stopped ?? "", privacy: .public) not sent, the act stops")
        }
        return false
    }
}

/// The accessibility backend every act uses, with the guard in front of its writes.
final class CUActGuardedAX: CUAXBackend {
    let inner: CUAXBackend
    let guardian: CUActWriteGuard
    init(inner: CUAXBackend, guardian: CUActWriteGuard) {
        self.inner = inner
        self.guardian = guardian
    }

    func isTrusted() -> Bool { inner.isTrusted() }
    func application(_ pid: pid_t) -> AXUIElement { inner.application(pid) }
    func attribute(_ e: AXUIElement, _ name: String) -> CFTypeRef? { inner.attribute(e, name) }
    func copyMultiple(_ e: AXUIElement, _ names: [String]) -> [String: CFTypeRef]? { inner.copyMultiple(e, names) }
    func attributeNames(_ e: AXUIElement) -> [String]? { inner.attributeNames(e) }
    func actions(_ e: AXUIElement) -> [String] { inner.actions(e) }
    func isSettable(_ e: AXUIElement, _ name: String) -> Bool { inner.isSettable(e, name) }
    func set(_ e: AXUIElement, _ name: String, _ value: CFTypeRef) throws {
        guard guardian.allows(owner: inner.ownerPid(e), "the accessibility write \(name)") else { throw CUActWriteGuard.refusal }
        try inner.set(e, name, value)
    }
    func perform(_ e: AXUIElement, _ action: String) throws {
        guard guardian.allows(owner: inner.ownerPid(e), "the accessibility action \(action)") else { throw CUActWriteGuard.refusal }
        try inner.perform(e, action)
    }
    func isAlive(_ e: AXUIElement) -> Bool { inner.isAlive(e) }
    func windowID(_ e: AXUIElement) -> CGWindowID? { inner.windowID(e) }
    func remoteWindows(pid: pid_t, windowIDs: [CGWindowID]) -> [CGWindowID: AXUIElement] { inner.remoteWindows(pid: pid, windowIDs: windowIDs) }
    func ownerPid(_ e: AXUIElement) -> pid_t? { inner.ownerPid(e) }
    func elementAt(pid: pid_t, _ point: CGPoint) -> AXUIElement? { inner.elementAt(pid: pid, point) }
}

/// The event poster every act uses, with the guard in front of the events that START something (a key down, a button down,
/// a scroll, a pointer move): the matching up of one already sent always goes, so nothing is left held down in the app.
struct CUActGuardedPoster: CUEventPoster {
    let inner: CUEventPoster
    let guardian: CUActWriteGuard

    static func starts(_ type: CGEventType) -> Bool {
        switch type {
        case .keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel, .mouseMoved: return true
        default: return false
        }
    }

    func post(_ event: CGEvent, pid: pid_t, route: CURoute, authenticate: Bool) -> CURoute {
        let type = event.type
        if Self.starts(type), !guardian.allows(owner: pid, Self.words(type)) { return route }  // not sent (the target's, or its own process's)
        // A drag's moves are checked like a start (the review of round 17, H1: they kept dragging after the user started
        // working, and the act said it was done): once stopped, only the release goes.
        if Self.drags(type), !guardian.allows(owner: pid, "a drag") { return route }
        if let scope = CUActScope.current {
            switch type {
            case .leftMouseDown, .rightMouseDown, .otherMouseDown: scope.buttonsDown += 1
            case .keyDown: scope.keysDown += 1
            case .leftMouseUp, .rightMouseUp, .otherMouseUp:
                if scope.stopped != nil, scope.buttonsDown == 0 { return route }  // its down never went
                scope.buttonsDown = max(0, scope.buttonsDown - 1)
            case .keyUp:
                if scope.stopped != nil, scope.keysDown == 0 { return route }
                scope.keysDown = max(0, scope.keysDown - 1)
            default: break
            }
        }
        guardian.notePost()
        return inner.post(event, pid: pid, route: route, authenticate: authenticate)
    }

    static func drags(_ type: CGEventType) -> Bool {
        type == .leftMouseDragged || type == .rightMouseDragged || type == .otherMouseDragged
    }

    static func words(_ type: CGEventType) -> String {
        switch type {
        case .keyDown: return "a key"
        case .scrollWheel: return "a scroll"
        case .mouseMoved: return "a pointer move"
        default: return "a click"
        }
    }
}

extension CUActWriteGuard {
    static var refusal: CUError {
        CUError.refused(.userWorking, "the user started working in the app while the act ran — the rest was not sent; ask the user to switch away from the app for a moment, or to say go ahead (their next message, or their answer to a question you ask them, lets you act)")
    }
}

extension CUAXBackend {
    /// The process an element belongs to (the live backend: `AXUIElementGetPid`); nil when it can't be told.
    func ownerPid(_ e: AXUIElement) -> pid_t? {
        var pid: pid_t = 0
        guard AXUIElementGetPid(e, &pid) == .success, pid > 0 else { return nil }
        return pid
    }
}

extension CUCore {
    /// Runs one act's body under the write guard for `t`: from the moment the user works in `t`, no write or event of it
    /// reaches `t`, and the act ends refused (`user_working`) — its own sentence kept when it said so itself (a burst's
    /// "typed N of M"), the guard's otherwise.
    func withActWriteGuard<T>(_ t: CUTarget, _ body: () throws -> T) throws -> T {
        let scope = CUActScope(pid: t.pid, appName: t.appName, workMarksAtStart: workMarks(t.pid))
        let outer = CUActScope.swap(scope)
        defer { _ = CUActScope.swap(outer) }
        let result: T
        do {
            result = try body()
        } catch let e as CUError where scope.stopped != nil && !Self.isUserWorkingRefusal(e) && e.code != "cancelled" {
            // (Whatever the path made of a refused write — a fallback's failure, "the field did not take it" — the reason is
            // the user's work.)
            throw Self.stoppedRefusal(t)
        }
        if scope.stopped != nil { throw Self.stoppedRefusal(t) }
        return result
    }

    /// How many times the user's work mark has landed on `pid` (sticky in-flight checks compare it with an act's start).
    func workMarks(_ pid: pid_t) -> Int {
        let front = sys.frontmostPid()
        let now = clock.nowSeconds()
        return guardianLock.withLock { () -> Int in
            _ = guardianCore.userIsWorking(in: pid, front: front, now: now)  // (a pending click's mark lands here first)
            return guardianCore.workMarks[pid, default: 0]
        }
    }

    static func stoppedRefusal(_ t: CUTarget) -> CUError {
        CUError.refused(.userWorking, "the user started working in \(t.appName) while the act ran, so the rest of it was not sent — ask the user to switch away from \(t.appName) for a moment, or to say go ahead (their next message, or their answer to a question you ask them, lets you act)")
    }

    static func isUserWorkingRefusal(_ e: CUError) -> Bool {
        e.code == "refused" && e.data?["reason"] == .string("user_working")
    }
}
