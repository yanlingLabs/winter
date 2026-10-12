import ApplicationServices
import CoreGraphics
import Foundation
import os

extension CULog {
    /// The wake triggers' watches: arm, fire, loss, the click tap (never a point, a value or a title).
    static let watch = Logger(subsystem: "com.winter.computeruse", category: "watch")
}

/// `CUWatcher.ownInputBegan`'s token: the app it counted for (nil = every app), and whether it counted at all.
public struct CUOwnInputToken: Sendable, Equatable {
    public let pid: pid_t?
    public let counted: Bool
    public init(pid: pid_t?, counted: Bool) {
        self.pid = pid
        self.counted = counted
    }
}

/// The notifications a watch reacts to (live: `CUWatchAXObserver`, an `AXObserver` per watched pid).
protocol CUWatchNotifying: AnyObject {
    /// Starts observing `pid` (idempotent); false when it can't (no grant, the app gone).
    @discardableResult func watch(pid: pid_t) -> Bool
    func unwatch(pid: pid_t)
    var onNotification: (@Sendable (pid_t) -> Void)? { get set }
}

/// The click tap (live: `CUWatchClickTap`, a listen-only session tap for the left mouse-down only).
protocol CUWatchTapping: AnyObject {
    /// Installs it (idempotent); false when it can't be created. `onMouseDown(point, sourcePid, userData)` runs on the
    /// tap's own thread and must return at once.
    @discardableResult func start(onMouseDown: @escaping @Sendable (CGPoint, Int64, Int64) -> Void) -> Bool
    func stop()
    var running: Bool { get }
}

protocol CUWatchCancellable: AnyObject { func cancel() }

/// One-shot timers (live: a utility queue's timers WITH leeway, so an armed watch costs the CPU almost no wake-ups).
protocol CUWatchScheduling: AnyObject {
    func after(ms: Double, _ work: @escaping @Sendable () -> Void) -> CUWatchCancellable
}

/// What a click landed on, for one watch.
enum CUWatchHit: Equatable {
    /// The watched element, or something inside it.
    case element
    /// The watched element's window, elsewhere — and the element is GONE right after the click (the click closed the
    /// sheet it was in, before the hit test could ask): the engine counts it as the element's when no fresh frame of
    /// the element says otherwise.
    case goneAfterClick
    /// The bound window, elsewhere.
    case window
    case none
}

/// THE WATCHES (wake triggers, PROTOCOL.md §4.13). One registry for the helper: `watch.arm` checks the target and the
/// condition and records a baseline; the watch then lives ON ITS OWN — it holds the target (pid, window, element) itself,
/// so a `target.release`, a `session.ended` or the 10-minute idle quit of the script's binding never ends it — until:
/// `watch.cancel`; its event (`fired`, or `lost` when the app quit, the window closed or the element went); the daemon
/// connection that armed it closing (dropped silently: the daemon reads the close as "Winter Computer Use quit"); or a
/// backstop a little after its `expiresAt` (the daemon's own expiry always comes first).
///
/// What drives a decision: the app's accessibility notifications (debounced 250 ms, at most 1 s apart while they keep
/// coming; a text watch's tree is read at most once per 2 s), a 10 s fallback look, and — for `clicked` and `changed` — a
/// listen-only left-mouse-down tap that runs only while such a watch is armed. A change is dated by the FIRST
/// notification of its burst, so Winter's own input explains only what landed while it was in flight or within its
/// 500 ms grace. Nothing typed, no coordinates and no screen text leave the helper beyond the arm's labels and the
/// event's few words.
public final class CUWatcher: @unchecked Sendable {
    /// A watch's fixed facts, captured at arming.
    struct Subject: @unchecked Sendable {
        let watchId: String
        let connection: Int
        let sessionId: String
        let pid: pid_t
        let windowID: UInt32
        let appName: String
        let condition: CUWatchCondition
        /// The target as it was bound; nil in tests.
        let target: CUTarget?
        /// The watched element (ref kinds).
        let element: AXUIElement?
        /// The window the element is in (a sheet's own window), when it could be read; else the bound window.
        let elementWindowID: UInt32?
        /// The element's own label, for the pill.
        let label: String?
    }

    /// What arming found (the live probe's answer, or a test's).
    struct Prepared: @unchecked Sendable {
        var pid: pid_t
        var windowID: UInt32
        var appName: String
        var sessionId: String
        var target: CUTarget?
        var element: AXUIElement?
        var elementInfo: CUWatchElement?
        var targetLabel: String
        /// State kinds: whether the condition holds now (arming refuses `true`).
        var met: Bool?
        /// `changed`: the value's digest now.
        var valueDigest: Int?
        /// Where the element and its window are now (screen points), and the element's own window.
        var elementFrame: CGRect?
        var windowFrame: CGRect?
        var elementWindowID: UInt32?
    }

    private final class Watch: @unchecked Sendable {
        let subject: Subject
        var judge: CUWatchJudge
        /// The start of the interval the next look covers when no notification dates the change.
        var lastLookMs: Double
        /// When the watch is dropped silently (a backstop past the daemon's expiry).
        let dropAtMs: Double
        var userClickOnElementMs = -Double.infinity
        var userClickInWindowMs = -Double.infinity
        var settleTimer: CUWatchCancellable?
        /// A text watch's last tree read, and the look deferred to the end of its 2 s.
        var lastTreeReadMs = -Double.infinity
        var deferredTimer: CUWatchCancellable?
        /// The element's and window's frames as last read, and when (a click inside a fresh element frame is the
        /// element's with no accessibility round trip; one outside the window's frame never asks the window server).
        var elementFrame: CGRect?
        var windowFrame: CGRect?
        var framesAtMs = -Double.infinity
        init(subject: Subject, judge: CUWatchJudge, armedMs: Double, dropAtMs: Double) {
            self.subject = subject
            self.judge = judge
            lastLookMs = armedMs
            self.dropAtMs = dropAtMs
        }
    }

    // Tunables (ms).
    static let debounceMs: Double = 250
    static let debounceMaxMs: Double = 1_000
    static let fallbackMs: Double = 10_000
    /// A text watch (`appeared`, `gone` with a text) reads the window's tree at most this often.
    static let treeReadMinGapMs: Double = 2_000
    /// How often the ring follows its element while it is on screen.
    static let presentPollMs: Double = 500
    /// How old a cached element frame may be and still decide a click by itself.
    static let frameTrustMs: Double = 1_500
    /// The backstop after the daemon's `expiresAt`, and the longest watch with none (the daemon's 8 h, and a margin).
    static let expiryBackstopMs: Double = 10_000
    static let maxLifetimeMs: Double = 8 * 60 * 60_000 + 60_000
    /// `changed`: a hardware click on the field explains a change for this long; one in its window, for this long.
    static let clickOnElementEvidenceMs: Double = 30_000
    static let clickInWindowEvidenceMs: Double = 3_000
    /// The most watches one helper holds (the daemon allows 32).
    static let maxWatches = 64

    /// Where events go (the shell broadcasts `watchEvent`). Called from any thread.
    public var onEvent: (@Sendable (CUWatchEvent) -> Void)?
    /// How many watches are armed, at every change (the shell's idle accounting). Called in order, from any thread.
    public var onArmedCount: (@Sendable (Int) -> Void)?
    /// What to draw now: every armed watch whose bound window is frontmost on the active Space. Called from any thread.
    public var onPresent: (@Sendable ([CUWatchShown]) -> Void)?
    /// LIVE-TEST INSTANCES ONLY (the shell sets it from the helper's identity): the live suite's own test click
    /// (`CUWatchTestStamp`) counts as the user's. Never set in a dev or release helper serving a real home.
    public var countsTestInput = false

    let clock: CUClock
    let wallMs: @Sendable () -> Double
    let notifier: CUWatchNotifying
    let tap: CUWatchTapping
    let scheduler: CUWatchScheduling
    let ledger = CUOwnInputLedger()

    // The seams over the live engine (`CUWatcher+Live.swift` fills them from `CUCore`).
    var prepare: (WatchArmParams, CUWatchCondition) async throws -> Prepared
    var read: (Subject) async throws -> CUWatchObservation
    /// The app and window that would take a click at the point (the helper's own click-through panels let it through).
    var windowAt: (CGPoint) -> (pid: pid_t, windowID: UInt32)?
    var hit: (Subject, CGPoint) async -> CUWatchHit
    var present: (Subject) async -> CUWatchShown?
    /// A target id's app (the own-input ledger's key), when that target is bound.
    var pidOfTarget: (String) -> pid_t?

    /// A watch ended, or an arm was refused after its probe: the live seams drop what they keep for it.
    var forget: (String) -> Void = { _ in }
    /// Called with `true` when the first watch is armed and `false` when the last one goes (the live seams hold off App
    /// Nap meanwhile: an LSUIElement helper with no window on screen is napped, and a napped helper's timers — the
    /// debounce, the fallback — were seen to slip by tens of seconds while a watch waited).
    var keepResponsive: (Bool) -> Void = { _ in }
    /// The live seams' own state (`CUWatcher.live`).
    let liveStateLock = NSLock()
    var _liveState: CUWatchLiveState?

    private let lock = NSLock()
    private var watches: [String: Watch] = [:]
    private var debounce: [pid_t: (timer: CUWatchCancellable?, firstMs: Double, lastMs: Double)] = [:]
    /// The first notification time of the bursts a look of that app has yet to take (the change's date).
    private var changeSince: [pid_t: Double] = [:]
    private var evaluating = Set<pid_t>()
    private var evaluateAgain = Set<pid_t>()
    /// Daemon connections that have closed: an arm still probing for one of them arms nothing.
    private var closedConnections = Set<Int>()
    private var presentTimer: CUWatchCancellable?
    private var presenting = false
    private var presentAgain = false
    private var lastShown: [CUWatchShown] = []

    /// THE RECONCILE (decided and done under one lock, review M3): the apps observed, the click tap, the fallback timer
    /// and the count the shell is told always follow the watches as they are when it runs — a concurrent arm and cancel
    /// can never leave an observer, a running tap or a stale count behind.
    private let reconcileLock = NSLock()
    private var observedPids = Set<pid_t>()
    private var lastSentCount: Int?

    init(clock: CUClock, wallMs: @escaping @Sendable () -> Double, notifier: CUWatchNotifying, tap: CUWatchTapping,
         scheduler: CUWatchScheduling,
         prepare: @escaping (WatchArmParams, CUWatchCondition) async throws -> Prepared,
         read: @escaping (Subject) async throws -> CUWatchObservation,
         windowAt: @escaping (CGPoint) -> (pid: pid_t, windowID: UInt32)?,
         hit: @escaping (Subject, CGPoint) async -> CUWatchHit,
         present: @escaping (Subject) async -> CUWatchShown?,
         pidOfTarget: @escaping (String) -> pid_t?) {
        self.clock = clock
        self.wallMs = wallMs
        self.notifier = notifier
        self.tap = tap
        self.scheduler = scheduler
        self.prepare = prepare
        self.read = read
        self.windowAt = windowAt
        self.hit = hit
        self.present = present
        self.pidOfTarget = pidOfTarget
        notifier.onNotification = { [weak self] pid in self?.noted(pid) }
    }

    // MARK: - The wire

    /// `watch.arm`. `connection`: the daemon connection that armed it (its close drops the watch).
    public func arm(_ p: WatchArmParams, connection: Int) async throws -> WatchArmResult {
        guard !p.watchId.isEmpty, p.watchId.count <= 64 else { throw CUError.invalidParams("params.watchId is required (at most 64 characters)") }
        guard !p.targetId.isEmpty else { throw CUError.invalidParams("params.targetId is required") }
        let condition = try CUWatchCondition.parse(p.condition)
        try lock.withLock {
            if watches[p.watchId] != nil { throw CUError.invalidParams("watch \(p.watchId) is already armed") }
            if watches.count >= Self.maxWatches { throw CUError.busy("this helper already holds \(Self.maxWatches) watches — cancel one first") }
        }
        let ready = try await prepare(p, condition)
        do {
            if ready.met == true, let sentence = CUWatchJudge.alreadyMet(condition, app: ready.appName) {
                throw CUError.notAllowed("already_met", sentence)
            }
            let now = clock.nowMs()
            let wallNow = wallMs()
            let lifetime = p.expiresAt.map { min(max(0, $0 - wallNow), Self.maxLifetimeMs) } ?? Self.maxLifetimeMs
            let subject = Subject(watchId: p.watchId, connection: connection, sessionId: ready.sessionId, pid: ready.pid,
                                  windowID: ready.windowID, appName: ready.appName, condition: condition, target: ready.target,
                                  element: ready.element, elementWindowID: ready.elementWindowID,
                                  label: ready.elementInfo.map { $0.name.isEmpty ? $0.role : $0.name })
            let watch = Watch(subject: subject, judge: CUWatchJudge(condition, baselineValue: ready.valueDigest), armedMs: now,
                              dropAtMs: now + lifetime + Self.expiryBackstopMs)
            watch.elementFrame = ready.elementFrame
            watch.windowFrame = ready.windowFrame
            watch.framesAtMs = now
            try lock.withLock {
                // The connection that asked closed while the window was being read (review M1): nobody would ever cancel
                // this watch — it is not armed. Likewise a request the shell already gave up.
                if closedConnections.contains(connection) || Task.isCancelled { throw CUError.cancelled }
                // A concurrent arm of the same id won the race meanwhile.
                if watches[p.watchId] != nil { throw CUError.invalidParams("watch \(p.watchId) is already armed") }
                watches[p.watchId] = watch
            }
        } catch {
            forget(p.watchId)  // a refused arm keeps nothing its probe made (review L1)
            throw error
        }
        CULog.watch.notice("watch \(p.watchId, privacy: .public) armed on \(ready.appName, privacy: .public): \(condition.kind, privacy: .public)")
        reconcile()
        refreshPresentation()
        return WatchArmResult(element: ready.elementInfo, targetLabel: ready.targetLabel)
    }

    /// `watch.cancel`: idempotent.
    public func cancel(watchId: String) {
        guard let w = remove(watchId) else { return }
        CULog.watch.notice("watch \(watchId, privacy: .public) cancelled (\(w.subject.appName, privacy: .public))")
        afterRemoval()
    }

    /// The daemon connection that armed them closed: its watches end silently (nobody is there to hear an event; the
    /// daemon reads its connection's close as "Winter Computer Use quit" and ends each one `lost` itself). An arm of that
    /// connection still probing arms nothing.
    public func connectionClosed(_ connection: Int) {
        let ids: [String] = lock.withLock {
            closedConnections.insert(connection)
            return watches.values.filter { $0.subject.connection == connection }.map(\.subject.watchId)
        }
        guard !ids.isEmpty else { return }
        for id in ids { _ = remove(id) }
        CULog.watch.notice("\(ids.count, privacy: .public) watch(es) ended: the daemon connection that armed them closed")
        afterRemoval()
    }

    /// How many watches are armed.
    public var armedCount: Int { lock.withLock { watches.count } }
    /// The armed watch ids (tests, logs).
    public var armedIds: [String] { lock.withLock { watches.keys.sorted() } }

    // MARK: - Winter's own input (the shell reports every request that can send some)

    /// A request that can send input to `targetId`'s app began; nil target = "every app" (a bind, an open, whose app
    /// is not known until it answers). Returns the token `ownInputEnded` takes.
    public func ownInputBegan(targetId: String?) -> CUOwnInputToken {
        guard let targetId else {
            ledger.begin(nil, nowMs: clock.nowMs())
            return CUOwnInputToken(pid: nil, counted: true)
        }
        // A target this helper does not know sends nothing anywhere.
        guard let pid = pidOfTarget(targetId) else { return CUOwnInputToken(pid: nil, counted: false) }
        ledger.begin(pid, nowMs: clock.nowMs())
        return CUOwnInputToken(pid: pid, counted: true)
    }

    public func ownInputEnded(_ token: CUOwnInputToken) {
        guard token.counted else { return }
        ledger.end(token.pid, nowMs: clock.nowMs())
    }

    // MARK: - Notifications, the fallback, settle and deferred looks

    /// An accessibility notification of `pid` (any thread): look again 250 ms after they stop, at most 1 s apart. The
    /// burst's FIRST notification dates the change.
    func noted(_ pid: pid_t) {
        let now = clock.nowMs()
        let schedule: Bool = lock.withLock {
            guard watches.values.contains(where: { $0.subject.pid == pid }) else { return false }
            if debounce[pid] != nil {
                debounce[pid]!.lastMs = now
                return false
            }
            debounce[pid] = (nil, now, now)
            return true
        }
        guard schedule else { return }
        let timer = scheduler.after(ms: Self.debounceMs) { [weak self] in self?.debounceFired(pid) }
        let kept: Bool = lock.withLock {
            guard debounce[pid] != nil else { return false }
            debounce[pid]!.timer = timer
            return true
        }
        if !kept { timer.cancel() }
    }

    private func debounceFired(_ pid: pid_t) {
        let now = clock.nowMs()
        let wait: Double? = lock.withLock {
            guard let d = debounce[pid] else { return nil }
            let quietFor = now - d.lastMs
            if quietFor < Self.debounceMs, now - d.firstMs < Self.debounceMaxMs {
                return min(Self.debounceMs - quietFor, Self.debounceMaxMs - (now - d.firstMs))
            }
            debounce[pid] = nil
            changeSince[pid] = min(changeSince[pid] ?? .infinity, d.firstMs)
            return 0
        }
        guard let wait else { return }
        if wait > 0 {
            let timer = scheduler.after(ms: wait) { [weak self] in self?.debounceFired(pid) }
            let kept: Bool = lock.withLock {
                guard debounce[pid] != nil else { return false }
                debounce[pid]!.timer = timer
                return true
            }
            if !kept { timer.cancel() }
            return
        }
        Task.detached(priority: .utility) { [weak self] in await self?.evaluate(pid: pid) }
    }

    private func fallbackFired() {
        reconcileLock.withLock { fallbackTimer = nil }
        Task.detached(priority: .utility) { [weak self] in
            guard let self else { return }
            await self.tick()
            self.reconcile()
        }
    }

    /// The fallback look: drop what is past its backstop, look at every watched app, redraw.
    func tick() async {
        let now = clock.nowMs()
        let expired: [String] = lock.withLock { watches.values.filter { now >= $0.dropAtMs }.map(\.subject.watchId) }
        for id in expired {
            _ = remove(id)
            CULog.watch.notice("watch \(id, privacy: .public) dropped past its expiry (the daemon ended it first)")
        }
        if !expired.isEmpty { afterRemoval() }
        let pids: Set<pid_t> = lock.withLock { Set(watches.values.map(\.subject.pid)) }
        for pid in pids { await evaluate(pid: pid) }
        refreshPresentation()
    }

    // MARK: - Looking

    /// Looks at every watch of `pid` once (one look at a time per app; a request meanwhile makes one more after it).
    func evaluate(pid: pid_t) async {
        let first: Bool = lock.withLock {
            if evaluating.contains(pid) { evaluateAgain.insert(pid); return false }
            evaluating.insert(pid)
            return true
        }
        guard first else { return }
        while true {
            let (mine, since): ([Watch], Double?) = lock.withLock {
                (watches.values.filter { $0.subject.pid == pid }, changeSince.removeValue(forKey: pid))
            }
            for w in mine { await look(w, changeSince: since) }
            let again: Bool = lock.withLock {
                if evaluateAgain.remove(pid) != nil { return true }
                evaluating.remove(pid)
                return false
            }
            if !again { break }
        }
        refreshPresentation()
    }

    /// One look. `changeSince`: the first notification of the burst that asked for it (nil: a fallback, a settle or a
    /// deferred look — the interval since the last look is judged then).
    private func look(_ w: Watch, changeSince: Double?) async {
        let s = w.subject
        let start = clock.nowMs()
        if s.condition.readsTree, let since = changeSince {
            // A text watch's tree at most once per 2 s in a storm: the rest wait for the 2 s to end (with their date).
            enum Plan { case read, deferTo(Double), alreadyDeferred }
            let plan: Plan = lock.withLock {
                guard start - w.lastTreeReadMs < Self.treeReadMinGapMs else { return .read }
                return w.deferredTimer != nil ? .alreadyDeferred : .deferTo(w.lastTreeReadMs + Self.treeReadMinGapMs)
            }
            switch plan {
            case .read: break
            case .alreadyDeferred:
                lock.withLock { self.changeSince[s.pid] = min(self.changeSince[s.pid] ?? .infinity, since) }
                return
            case .deferTo(let at):
                deferLook(w, at: at, changeSince: since)
                return
            }
        }
        var o: CUWatchObservation
        do {
            o = try await read(s)
        } catch let e as CUError where e.code == "permission_missing" {
            finish(w, .lost(reason: "Winter Computer Use lost its Accessibility permission"), atWall: wallMs())
            return
        } catch let e as CUError where e.code == "target_lost" {
            let quit = e.data?["reason"] == .string(CUTargetLostReason.appQuit.rawValue)
            finish(w, .lost(reason: quit ? CUWatchJudge.appQuit : CUWatchJudge.windowClosed), atWall: wallMs())
            return
        } catch {
            return  // the app did not answer this time: the next look tries again
        }
        let now = clock.nowMs()
        let decision: CUWatchDecision = lock.withLock {
            guard watches[s.watchId] === w else { return .none }
            if s.condition.readsTree { w.lastTreeReadMs = start }
            if o.windowFrame != nil || o.elementFrame != nil {
                if let f = o.windowFrame { w.windowFrame = f }
                if let f = o.elementFrame { w.elementFrame = f }
                w.framesAtMs = now
            }
            o.userEvidence = o.userEvidence
                || now - w.userClickOnElementMs <= Self.clickOnElementEvidenceMs
                || now - w.userClickInWindowMs <= Self.clickInWindowEvidenceMs
            // The change happened at or after its burst's first notification (review M2); with no notification to date
            // it, anywhere since the last look.
            let from = changeSince.map { max(w.lastLookMs, $0) } ?? w.lastLookMs
            let own = ledger.touched(s.pid, fromMs: from)
            let d = w.judge.judge(o, ownInput: own, nowMs: now)
            w.lastLookMs = now
            return d
        }
        switch decision {
        case .none: return
        case .fire, .lost: finish(w, decision, atWall: wallMs())
        case .lookAgain(let atMs):
            let timer = scheduler.after(ms: max(0, atMs - now)) { [weak self] in
                Task.detached(priority: .utility) { await self?.evaluate(pid: s.pid) }
            }
            let kept: Bool = lock.withLock {
                guard watches[s.watchId] === w else { return false }
                w.settleTimer?.cancel()
                w.settleTimer = timer
                return true
            }
            if !kept { timer.cancel() }
        }
    }

    /// A text watch's look put off to the end of its 2 s, keeping the change's date.
    private func deferLook(_ w: Watch, at: Double, changeSince: Double) {
        let pid = w.subject.pid
        let timer = scheduler.after(ms: max(0, at - clock.nowMs())) { [weak self] in
            guard let self else { return }
            self.lock.withLock {
                w.deferredTimer = nil
                self.changeSince[pid] = min(self.changeSince[pid] ?? .infinity, changeSince)
            }
            Task.detached(priority: .utility) { await self.evaluate(pid: pid) }
        }
        let kept: Bool = lock.withLock {
            guard watches[w.subject.watchId] === w, w.deferredTimer == nil else { return false }
            w.deferredTimer = timer
            return true
        }
        if !kept { timer.cancel() }
    }

    // MARK: - Clicks

    /// The tap saw a left mouse-down (its thread): the user's only — hardware input — is looked at; the point is handed
    /// to a task and dropped once judged.
    func mouseDown(at point: CGPoint, sourcePid: Int64, userData: Int64) {
        guard CUWatchInput.isUsers(sourcePid: sourcePid, userData: userData, countsTestInput: countsTestInput) else { return }
        let now = clock.nowMs()
        let wall = wallMs()
        Task.detached(priority: .userInitiated) { [weak self] in await self?.judgeClick(at: point, nowMs: now, wall: wall) }
    }

    /// A hardware click is the user's by its source alone (no source process, no stamp): Winter's own input in flight
    /// never drops one (review L3).
    func judgeClick(at point: CGPoint, nowMs: Double, wall: Double) async {
        // Only watches whose window could be under the point: a click outside a watch's window (as last read) never asks
        // the window server anything (review M5).
        let candidates: [Watch] = lock.withLock {
            watches.values.filter { $0.subject.condition.isInput && ($0.windowFrame.map { $0.contains(point) } ?? true) }
        }
        guard !candidates.isEmpty, let under = windowAt(point) else { return }
        for w in candidates where w.subject.pid == under.pid {
            let fresh: (frame: CGRect?, trusted: Bool) = lock.withLock {
                (w.elementFrame, nowMs - w.framesAtMs <= Self.frameTrustMs && w.elementFrame != nil)
            }
            let inWindow = under.windowID == (w.subject.elementWindowID ?? w.subject.windowID)
            var h: CUWatchHit
            if fresh.trusted, inWindow, let f = fresh.frame, f.contains(point) {
                // A fresh frame of the element decides it: no round trip that a busy app or a sheet closing could lose.
                h = .element
            } else {
                h = await hit(w.subject, point)
                if h == .goneAfterClick { h = fresh.trusted ? .window : .element }
            }
            let decision: CUWatchDecision = lock.withLock {
                guard watches[w.subject.watchId] === w else { return .none }
                switch w.subject.condition {
                case .clicked:
                    return h == .element ? w.judge.clicked() : .none
                case .changed:
                    if h == .element { w.userClickOnElementMs = nowMs }
                    if h != .none || under.windowID == w.subject.windowID { w.userClickInWindowMs = nowMs }
                    return .none
                default:
                    return .none
                }
            }
            if case .fire = decision { finish(w, decision, atWall: wall) }
        }
    }

    // MARK: - Ending

    private func finish(_ w: Watch, _ decision: CUWatchDecision, atWall: Double) {
        guard remove(w.subject.watchId, only: w) != nil else { return }
        let event: CUWatchEvent
        switch decision {
        case .fire(let detail):
            event = CUWatchEvent(watchId: w.subject.watchId, outcome: .fired, at: atWall, detail: detail)
            CULog.watch.notice("watch \(w.subject.watchId, privacy: .public) fired in \(w.subject.appName, privacy: .public): \(w.subject.condition.kind, privacy: .public)")
        case .lost(let reason):
            event = CUWatchEvent(watchId: w.subject.watchId, outcome: .lost, at: atWall, reason: reason)
            CULog.watch.notice("watch \(w.subject.watchId, privacy: .public) lost in \(w.subject.appName, privacy: .public): \(reason, privacy: .public)")
        default:
            return
        }
        onEvent?(event)
        afterRemoval()
    }

    private func remove(_ id: String, only: Watch? = nil) -> Watch? {
        let w: Watch? = lock.withLock {
            guard let w = watches[id], only == nil || only === w else { return nil }
            watches[id] = nil
            w.settleTimer?.cancel()
            w.settleTimer = nil
            w.deferredTimer?.cancel()
            w.deferredTimer = nil
            return w
        }
        if w != nil { forget(id) }
        return w
    }

    /// After any removal: the debounces of apps nobody watches go; the reconcile does the rest; the drawing follows.
    private func afterRemoval() {
        lock.withLock {
            let left = Set(watches.values.map(\.subject.pid))
            for pid in debounce.keys where !left.contains(pid) { debounce.removeValue(forKey: pid)?.timer?.cancel() }
            for pid in changeSince.keys where !left.contains(pid) { changeSince[pid] = nil }
            if watches.isEmpty {
                presentTimer?.cancel()
                presentTimer = nil
            }
        }
        reconcile()
        refreshPresentation()
    }

    /// Makes the observers, the click tap, the fallback and the count the shell was told match the watches NOW — decided
    /// and done under one lock (review M3), so concurrent arms and cancels apply in order and the last one leaves the
    /// truth: no observer of an app nobody watches, no tap with no click or change watch, no stale count holding the
    /// idle quit.
    func reconcile() {
        reconcileLock.withLock {
            let (count, pids, wantTap): (Int, Set<pid_t>, Bool) = lock.withLock {
                (watches.count, Set(watches.values.map(\.subject.pid)), watches.values.contains { $0.subject.condition.isInput })
            }
            for pid in pids.subtracting(observedPids) { notifier.watch(pid: pid) }
            for pid in observedPids.subtracting(pids) { notifier.unwatch(pid: pid) }
            observedPids = pids
            if wantTap, !tap.running {
                if tap.start(onMouseDown: { [weak self] point, source, userData in self?.mouseDown(at: point, sourcePid: source, userData: userData) }) {
                    CULog.watch.notice("the click tap is on (a click or change watch is armed)")
                } else {
                    CULog.watch.notice("the click tap could not start (no event tap)")
                }
            } else if !wantTap, tap.running {
                tap.stop()
                CULog.watch.notice("the click tap is off (no click or change watch is armed)")
            }
            if count == 0 {
                fallbackTimer?.cancel()
                fallbackTimer = nil
            } else if fallbackTimer == nil {
                fallbackTimer = scheduler.after(ms: Self.fallbackMs) { [weak self] in self?.fallbackFired() }
            }
            if count != lastSentCount {
                if (lastSentCount ?? 0 > 0) != (count > 0) { keepResponsive(count > 0) }
                lastSentCount = count
                onArmedCount?(count)
            }
        }
    }

    /// The fallback timer (under `reconcileLock`).
    private var fallbackTimer: CUWatchCancellable?

    // MARK: - The ring and the pill

    /// Redraws every watch whose bound window is frontmost on the active Space; follows them every 0.5 s while any is
    /// shown, and stops when none is.
    func refreshPresentation() {
        Task.detached(priority: .utility) { [weak self] in await self?.presentNow() }
    }

    func presentNow() async {
        // One drawing pass at a time, so the shell gets the lists in the order they were made (a stale one drawn last
        // would stay); a request meanwhile makes one more pass after it.
        let first: Bool = lock.withLock {
            if presenting { presentAgain = true; return false }
            presenting = true
            return true
        }
        guard first else { return }
        while true {
            await presentPass()
            let again: Bool = lock.withLock {
                if presentAgain { presentAgain = false; return true }
                presenting = false
                return false
            }
            if !again { break }
        }
    }

    private func presentPass() async {
        let watched: [Watch] = lock.withLock { watches.values.sorted { $0.subject.watchId < $1.subject.watchId } }
        var shown: [CUWatchShown] = []
        for w in watched {
            guard let v = await present(w.subject) else { continue }
            shown.append(v)
            // What the ring read is the freshest frame a click can be judged by.
            let now = clock.nowMs()
            lock.withLock {
                w.windowFrame = v.windowFrame
                if let f = v.elementFrame { w.elementFrame = f }
                w.framesAtMs = now
            }
        }
        let (changed, poll): (Bool, Bool) = lock.withLock {
            let live = Set(watches.keys)
            shown = shown.filter { live.contains($0.watchId) }
            let changed = shown != lastShown
            lastShown = shown
            let poll = !shown.isEmpty && presentTimer == nil
            return (changed, poll)
        }
        if changed { onPresent?(shown) }
        if poll {
            let t = scheduler.after(ms: Self.presentPollMs) { [weak self] in
                guard let self else { return }
                self.lock.withLock { self.presentTimer = nil }
                Task.detached(priority: .utility) { await self.presentNow() }
            }
            let kept: Bool = lock.withLock {
                guard presentTimer == nil, !watches.isEmpty else { return false }
                presentTimer = t
                return true
            }
            if !kept { t.cancel() }
        }
    }

    /// An app came to the front or quit (the live workspace observers): redraw, and look at a quit app at once.
    func appActivated() { refreshPresentation() }

    func appTerminated(_ pid: pid_t) {
        guard lock.withLock({ watches.values.contains { $0.subject.pid == pid } }) else { return }
        Task.detached(priority: .utility) { [weak self] in await self?.evaluate(pid: pid) }
    }
}
