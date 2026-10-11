import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// The guardian's MODEL-BASED test (round 8, part B): the real engine — the one rule, the observers, the focus blip and
/// its keyboard reroute, a background click's preparation, the act's after-checks, a bind that launches, an AppleScript
/// that runs for seconds — driven in SIMULATED time over a simulated world (front app, desktops, the window server's key
/// focus, delayed activation and desktop notifications), with seeded random interleavings of the user's actions and the
/// agent's and apps' own. After every event the invariants of PROTOCOL.md §4.12 are checked against the world's GROUND
/// TRUTH (who really made each change):
/// - I1/I2: the engine never activates over a place the user chose (or an app the agent never touched brought them to),
///   and every restore goes to their CURRENT place;
/// - I3: every key the user types while the reroute is on reaches their place, and a key-focus hand-back never goes to
///   an app they left;
/// - I4: a touched app that came forward by itself is undone once the guardian sees it, and at most the one key in flight
///   is typed into it;
/// - I5: once a state was judged the user's it is never judged the agent's.
/// Changes the rule cannot attribute by design (a mark of the agent's between the user's input and the change, a
/// self-activation at the edge of the causal window, a ⌘-Tab under Secure Event Input) are SKIPPED, counted, and the
/// skipped share is held small. A failure prints the seed and a minimized list of steps.
final class GuardianModelTests: XCTestCase {
    static let seeds = Int(ProcessInfo.processInfo.environment["WINTER_CU_SIM_SEEDS"] ?? "") ?? 20
    static let steps = Int(ProcessInfo.processInfo.environment["WINTER_CU_SIM_STEPS"] ?? "") ?? 300

    func testTheInvariantsHoldOverRandomInterleavings() async throws {
        var totals = SimStats()
        let only = Int(ProcessInfo.processInfo.environment["WINTER_CU_SIM_ONLY_SEED"] ?? "")
        for seed in only.map({ [$0] }) ?? Array(1...Self.seeds) {
            let plan = SimPlan.generate(seed: UInt64(seed), count: Self.steps)
            let run = await SimRun.execute(plan)
            totals.add(run.stats)
            if let v = run.violation, only != nil {
                let at = run.trace.firstIndex { $0.hasPrefix("VIOLATION") } ?? run.trace.count
                XCTFail("seed \(seed): \(v)\n\(run.trace[max(0, at - 70)..<min(run.trace.count, at + 8)].joined(separator: "\n"))")
                return
            }
            if let v = run.violation {
                let minimal = await SimRun.minimize(plan)
                XCTFail("""
                    seed \(seed): \(v)
                    minimized to \(minimal.steps.count) of \(plan.steps.count) steps:
                    \(minimal.steps.map { "  " + $0.words }.joined(separator: "\n"))
                    trace of the minimized run:
                    \((await SimRun.execute(minimal)).trace.suffix(60).joined(separator: "\n"))
                    """)
                return
            }
        }
        print("guardian model: \(Self.seeds) seeds × \(Self.steps) steps — \(totals.words)")
        XCTAssertGreaterThan(totals.checked, 0)
        XCTAssertLessThan(Double(totals.skipped), Double(totals.changes) * 0.25, "too many changes the rule can't attribute: \(totals.words)")
        XCTAssertGreaterThan(totals.userKeysRerouted, 0, "the user's keys met the reroute")
        XCTAssertGreaterThan(totals.undone, 0, "thefts were undone")
        XCTAssertGreaterThan(totals.userMovesKept, 0, "user moves were kept")
    }
}

// MARK: - the plan

struct SimRNG {
    var state: UInt64
    init(_ seed: UInt64) { state = seed &* 0x9E3779B97F4A7C15 | 1 }
    mutating func next() -> UInt64 {
        state ^= state << 13; state ^= state >> 7; state ^= state << 17
        return state
    }
    mutating func int(_ n: Int) -> Int { Int(next() % UInt64(max(n, 1))) }
    mutating func double(_ lo: Double, _ hi: Double) -> Double { lo + (hi - lo) * Double(next() % 1_000_000) / 1_000_000 }
    mutating func chance(_ p: Double) -> Bool { double(0, 1) < p }
}

enum SimApp: Int, CaseIterable, CustomStringConvertible {
    case user = 1, target = 5252, third = 700
    var pid: pid_t { pid_t(rawValue) }
    var description: String {
        switch self {
        case .user: return "U"
        case .target: return "T"
        case .third: return "X"
        }
    }
}

enum SimKind {
    // the user
    case click(SimApp)
    case dock(SimApp)
    case commandTab(SimApp)
    case controlArrow(UInt64, seen: Bool)
    case swipe(UInt64)
    case typing(Int)
    case shortcut
    case secure(Bool)
    case scroll
    // the apps
    case selfActivate(SimApp)
    // the agent
    case agentType(Int)
    case agentClick
    case agentAppleScript(Double)
    case agentBindLaunch(activateAfterMs: Double)

    var isAgent: Bool {
        switch self {
        case .agentType, .agentClick, .agentAppleScript, .agentBindLaunch: return true
        default: return false
        }
    }

    var words: String {
        switch self {
        case .click(let a): return "the user clicks \(a)'s window"
        case .dock(let a): return "the user clicks \(a) in the Dock"
        case .commandTab(let a): return "the user ⌘-Tabs to \(a)"
        case .controlArrow(let s, let seen): return "the user ⌃-arrows to desktop \(s) (arrow \(seen ? "seen" : "swallowed"))"
        case .swipe(let s): return "the user swipes to desktop \(s)"
        case .typing(let n): return "the user types \(n) keys"
        case .shortcut: return "the user presses ⌘S"
        case .secure(let on): return "Secure Event Input \(on ? "on" : "off")"
        case .scroll: return "the user scrolls (two fingers)"
        case .selfActivate(let a): return "\(a) activates itself"
        case .agentType(let n): return "the agent types \(n) characters into T"
        case .agentClick: return "the agent clicks T's field (a background click)"
        case .agentAppleScript(let s): return "the agent runs an AppleScript in T for \(String(format: "%.1f", s)) s"
        case .agentBindLaunch(let ms): return "the agent binds an app it launches (it activates \(Int(ms)) ms in)"
        }
    }
}

struct SimStep {
    var at: Double  // ms from the start
    var kind: SimKind
    var seed: UInt64
    var words: String { "\(Int(at)) ms: \(kind.words)" }
}

struct SimPlan {
    var seed: UInt64
    var steps: [SimStep]

    static func generate(seed: UInt64, count: Int) -> SimPlan {
        var r = SimRNG(seed)
        var t = 200.0
        var steps: [SimStep] = []
        let apps = SimApp.allCases
        var modsFreeAt = 0.0  // one ⌘/⌃ gesture of the user's at a time (a hand on the keyboard)
        for _ in 0..<count {
            t += r.double(20, 900)
            let k: SimKind
            switch r.int(100) {
            case 0..<12: k = .click(apps[r.int(apps.count)])
            case 12..<16: k = .dock(apps[r.int(apps.count)])
            case 16..<26: k = .commandTab(apps[r.int(apps.count)])
            case 26..<31: k = .controlArrow([100, 200, 300][r.int(3)], seen: r.chance(0.5))
            case 31..<35: k = .swipe([100, 200, 300][r.int(3)])
            case 35..<45: k = .typing(1 + r.int(6))
            case 45..<48: k = .shortcut
            case 48..<50: k = .secure(r.chance(0.4))
            case 50..<53: k = .scroll
            case 53..<63: k = .selfActivate(r.chance(0.7) ? .target : (r.chance(0.5) ? .third : .user))
            case 63..<80: k = .agentType(1 + r.int(8))
            case 80..<88: k = .agentClick
            case 88..<94: k = .agentAppleScript(r.double(0.2, 4))
            default: k = .agentBindLaunch(activateAfterMs: r.double(30, 3000))
            }
            if case .agentType = k, r.chance(0.5) {
                steps.append(SimStep(at: t + r.double(0, 400), kind: .typing(2 + r.int(6)), seed: r.next()))
            }
            var at = t
            switch k {
            case .commandTab, .controlArrow, .shortcut:
                at = max(t, modsFreeAt)
                modsFreeAt = at + 800
            default:
                break
            }
            steps.append(SimStep(at: at, kind: k, seed: r.next()))
        }
        return SimPlan(seed: seed, steps: steps)
    }
}

struct SimStats {
    var skippedWhy: [String: Int] = [:]
    var changes = 0
    var skipped = 0
    var checked = 0
    var userKeysRerouted = 0
    var undone = 0
    var userMovesKept = 0
    var agentActs = 0
    mutating func add(_ o: SimStats) {
        changes += o.changes; skipped += o.skipped; checked += o.checked; userKeysRerouted += o.userKeysRerouted
        undone += o.undone; userMovesKept += o.userMovesKept; agentActs += o.agentActs
        for (k, v) in o.skippedWhy { skippedWhy[k, default: 0] += v }
    }
    var words: String {
        "\(changes) changes of the user's view (\(skipped) not attributable, skipped: \(skippedWhy.sorted { $0.value > $1.value }.map { "\($0.value) \($0.key)" }.joined(separator: ", "))), \(checked) checks, \(agentActs) agent acts, \(undone) thefts undone, \(userMovesKept) user moves kept, \(userKeysRerouted) user keys through the reroute"
    }
}

// MARK: - the simulated clock and world

final class SimClock: CUClock, @unchecked Sendable {
    private let lock = NSRecursiveLock()
    private var ms: Double = 1_000_000
    weak var world: SimWorld?
    func nowMs() -> Double { lock.withLock { ms } }
    func sleep(ms d: Double) async throws { pause(ms: d) }
    func pause(ms d: Double) {
        if let world { world.advance(by: max(0, d)) } else { lock.withLock { ms += max(0, d) } }
    }
    func set(_ v: Double) { lock.withLock { ms = max(ms, v) } }
}

/// Who made the world's current front app and desktop what they are (the ground truth).
enum SimOrigin: Equatable {
    case start
    case user(String)
    /// An app the agent did not touch coming forward by itself: the user's (I1).
    case untouched(pid_t)
    /// A touched app coming forward by itself: the agent's (must be undone).
    case agentSelf(pid_t)
    /// A launched app coming forward by itself, inside its launch's window: the agent's.
    case launch(pid_t)
    /// The engine's own activation (a restore, a return).
    case engine
    /// A change the rule cannot attribute by design.
    case ambiguous(String)

    var isUsers: Bool {
        switch self {
        case .start, .user, .untouched: return true
        default: return false
        }
    }
    var theft: pid_t? {
        switch self {
        case .agentSelf(let p), .launch(let p): return p
        default: return nil
        }
    }
}

final class SimWorld: CUSystemBackend, @unchecked Sendable {
    struct Win { var id: UInt32; var pid: pid_t; var frame: CGRect; var space: UInt64 }

    let lock = NSRecursiveLock()
    let clock: SimClock
    weak var core: CUCore?
    var installer: FakeKeyTapInstaller!
    var poster: RecordingPoster!
    var rng: SimRNG

    var wins: [UInt32: Win] = [:]
    var running: Set<pid_t> = [SimApp.user.pid, SimApp.target.pid, SimApp.third.pid]
    var startedAt: [pid_t: Double] = [:]
    var bundles: [pid_t: String] = [SimApp.target.pid: "com.apple.finder", SimApp.user.pid: "sim.user", SimApp.third.pid: "sim.third"]
    var front: pid_t = SimApp.user.pid
    var space: UInt64 = 100
    var keyFocus: pid_t = SimApp.user.pid
    /// Apps front to back (for which app a desktop change brings to the front).
    var zOrder: [pid_t] = [SimApp.user.pid, SimApp.target.pid, SimApp.third.pid]
    /// Each app's main (key) window: what an activation of it brings forward — macOS follows it to its desktop.
    var mainWin: [pid_t: UInt32] = [SimApp.user.pid: 31, SimApp.target.pid: 77, SimApp.third.pid: 71]
    /// Accessibility's focused window follows the main window.
    var onMainWindow: ((pid_t, UInt32) -> Void)?
    var secure = false

    // the ground truth
    var origin: SimOrigin = .start
    var userPlace: (app: pid_t, space: UInt64) = (SimApp.user.pid, 100)
    /// After a change the rule can't attribute, where the user belongs is unknown until their next own move.
    var placeKnown = true
    /// The agent's own record of what it did to each app: an operation running (+inf), else when it ended.
    var agentActivity: [pid_t: Double] = [:]
    var agentRunning: [pid_t: Int] = [:]
    var inUserAction = 0
    /// Bumped on every change of the world's front app or desktop.
    var episode = 0
    var judgedUsers: Set<String> = []
    var helperKeysIntoThief = 0
    var helperKeysIntoUsersApp = 0
    /// The episode an agent act began in, and the front app then: only a change during it that put T in front counts.
    var actEpisode = 0
    var actStartFront: pid_t = 0
    /// How long the AppleScript being run takes.
    var scriptMs: Double = 0
    /// The user's last input that can switch apps or desktops by itself (a ⌘/⌃ release with no chord, a swipe, a Dock
    /// click, a click on another app's window), and whether a ⌃ is held: a touched app coming forward right after it
    /// looks exactly like the user's own switch to it — not attributable by design.
    var lastSwitchInputAt: Double = -.infinity {
        didSet { switchInputBeforeObserved() }
    }
    var controlHeld = false
    /// The last episode a path of the engine judged (it has seen the world's current change).
    var observedEpisode = 0
    /// When an app the agent touched last came forward by itself: a switch of the user's begun before it, landing after
    /// it, may have had its input taken by that change (the engine can't tell which of the two the input was for).
    var lastTouchedSelfChangeAt: Double = -.infinity
    var touchedSelfEpisode = -1

    /// The user's switch input arrived after a change of the agent's but before the guardian heard of it: the guardian
    /// learns of a change only when told, with no time on it, so that change and the user's own switch can't be told
    /// apart (their switch lands right after it anyway).
    func switchInputBeforeObserved() {
        // A touched app's own change the guardian has not heard of yet competes for this input (whatever it is).
        if observedEpisode != episode, touchedSelfEpisode == episode { lastTouchedSelfChangeAt = max(lastTouchedSelfChangeAt, now + 0.001) }
        guard origin.theft != nil, observedEpisode != episode else { return }
        // That change may take this input: the user's own switch it was for, landing next, then competes for it.
        lastTouchedSelfChangeAt = max(lastTouchedSelfChangeAt, now + 0.001)
        origin = .ambiguous("the user's switch input came before the guardian heard of the change")
        placeKnown = false
        stats.skipped += 1
        stats.skippedWhy[origin == .ambiguous("") ? "" : "the user's switch input came before the guardian heard of the change", default: 0] += 1
        log("  (ambiguous now: the user's switch input came before the guardian heard of the change)")
    }
    var launched: [pid_t: (bundle: String, until: Double)] = [:]

    // scheduling
    struct Event { var at: Double; var seq: Int; var name: String; var run: () -> Void }
    var events: [Event] = []
    var seq = 0
    var delivering = 0
    var lastReroute: pid_t?
    var lastNotifyAt: Double = 0

    // results
    var trace: [String] = []
    var violation: String?
    var stats = SimStats()

    init(clock: SimClock, seed: UInt64) {
        self.clock = clock
        rng = SimRNG(seed)
        let windows: [Win] = [
            Win(id: 31, pid: SimApp.user.pid, frame: CGRect(x: 0, y: 0, width: 400, height: 300), space: 100),
            Win(id: 77, pid: SimApp.target.pid, frame: CGRect(x: 500, y: 0, width: 400, height: 300), space: 100),
            Win(id: 71, pid: SimApp.third.pid, frame: CGRect(x: 1000, y: 0, width: 400, height: 300), space: 100),
            Win(id: 72, pid: SimApp.third.pid, frame: CGRect(x: 1000, y: 400, width: 400, height: 300), space: 200),
            Win(id: 78, pid: SimApp.target.pid, frame: CGRect(x: 500, y: 400, width: 400, height: 300), space: 300),
        ]
        for w in windows { wins[w.id] = w }
    }

    var now: Double { clock.nowMs() }
    func log(_ s: String) { lock.withLock { trace.append("\(Int(now - 1_000_000)) ms: \(s)") } }

    func fail(_ s: String) {
        lock.withLock {
            guard violation == nil else { return }
            violation = s
            trace.append("VIOLATION: \(s)")
        }
    }

    // MARK: scheduling

    func schedule(after ms: Double, _ name: String, _ run: @escaping () -> Void) {
        lock.withLock {
            seq += 1
            events.append(Event(at: now + max(0, ms), seq: seq, name: name, run: run))
        }
    }

    /// Simulated time passes: due events run in time order (never one inside another — a pause inside an event only
    /// moves the clock; what fell due then runs after).
    func advance(by ms: Double) { advance(to: now + ms) }

    func advance(to target: Double) {
        let nested = lock.withLock { () -> Bool in
            if delivering > 0 { return true }
            delivering += 1
            return false
        }
        if nested { clock.set(target); return }
        defer { lock.withLock { delivering -= 1 } }
        while true {
            let next = lock.withLock { () -> Event? in
                guard let i = events.indices.min(by: { (events[$0].at, events[$0].seq) < (events[$1].at, events[$1].seq) }),
                      events[i].at <= target else { return nil }
                return events.remove(at: i)
            }
            guard let e = next else { break }
            clock.set(e.at)
            e.run()
        }
        clock.set(target)
    }

    /// A hook inside the engine (a key it posts, a focus record, a synthetic event): a moment passes.
    func hook(_ ms: Double) { advance(by: ms) }

    // MARK: the world's changes

    func onScreen(_ w: Win) -> Bool { w.space == space }

    /// The world's state is a place the user chose (by their move, or an untouched app they let come forward), and that
    /// place is known.
    var known: Bool { placeKnown && origin.isUsers }

    func appWindow(_ pid: pid_t, onSpace s: UInt64? = nil) -> Win? {
        wins.values.sorted { $0.id < $1.id }.first { $0.pid == pid && (s == nil || $0.space == s) }
    }

    /// The front app or desktop changes. Notifications follow a little later, as NSWorkspace's do.
    func change(front newFront: pid_t, space newSpace: UInt64? = nil, origin o: SimOrigin, why: String) {
        lock.withLock {
            let oldSpace = space
            var s = newSpace ?? space
            // An activation brings the app's main window forward: macOS follows it to its desktop. Coming forward on a
            // desktop (newSpace given), its window there becomes its main one.
            if newSpace == nil {
                if let m = mainWin[newFront], let w = wins[m] { s = w.space } else if appWindow(newFront, onSpace: space) == nil, let w = appWindow(newFront) { s = w.space }
            } else if let w = appWindow(newFront, onSpace: s), mainWin[newFront] != w.id {
                mainWin[newFront] = w.id
                onMainWindow?(newFront, w.id)
            }
            let moved = newFront != front || s != space
            front = newFront
            keyFocus = newFront
            space = s
            zOrder.removeAll { $0 == newFront }
            zOrder.insert(newFront, at: 0)
            FocusSPI.frontPid = newFront
            guard moved else { return }
            episode += 1
            origin = o
            stats.changes += 1
            if case .ambiguous(let why) = o { stats.skipped += 1; stats.skippedWhy[why, default: 0] += 1; placeKnown = false }
            if o.isUsers { userPlace = (newFront, s); placeKnown = true }
            log("\(why) → front \(name(newFront)), desktop \(s) [\(o)]")
            // NSWorkspace posts its notifications in order on one queue: delayed, never reordered.
            let pid = newFront
            let a = max(rng.double(3, 90), lastNotifyAt - now + 0.1)
            lastNotifyAt = now + a
            schedule(after: a, "activation of \(name(pid))") { [weak self] in self?.notifyActivation(pid) }
            if s != oldSpace {
                let d = max(rng.double(3, 120), lastNotifyAt - now + 0.1)
                lastNotifyAt = now + d
                schedule(after: d, "desktop \(s)") { [weak self] in self?.notifySpace() }
            }
        }
    }

    /// The desktop changes; the topmost app with a window there comes to the front.
    func changeSpace(_ s: UInt64, origin o: SimOrigin, why: String) {
        let app = lock.withLock { zOrder.first { p in appWindow(p, onSpace: s) != nil } ?? front }
        change(front: app, space: s, origin: o, why: why)
    }

    func notifyActivation(_ pid: pid_t) {
        guard let core else { return }
        core.onActivation(pid: pid)
        afterObserver()
    }

    func notifySpace() {
        guard let core else { return }
        core.onSpaceChange()
        afterObserver()
    }

    /// After the guardian saw a change: a theft is undone (I4), and its idea of the user's place is the truth (I2).
    func afterObserver() {
        let view = core.map { c in c.guardianLock.withLock { c.guardianCore.view } }
        lock.withLock {
            stats.checked += 1
            if let thief = origin.theft, front == thief, placeKnown, userPlace.app != thief {
                fail("I4: \(name(thief)) came forward by itself (the agent's: \(origin)) and the guardian left it in front")
            }
            if known, front == userPlace.app, let view {
                if view.app != userPlace.app {
                    fail("I2: the user is in \(name(userPlace.app)) by their own move, but the guardian takes their place for \(view.app.map(name) ?? "nothing")")
                }
                if case .user = origin { stats.userMovesKept += 1 }
            }
        }
    }

    // MARK: the agent's own record (for the ground truth of a self-activation)

    func agentBegins(_ pid: pid_t) { lock.withLock { agentRunning[pid, default: 0] += 1; agentActivity[pid] = .infinity } }
    func agentEnds(_ pid: pid_t) {
        lock.withLock {
            agentRunning[pid, default: 1] -= 1
            if agentRunning[pid] == 0 { agentActivity[pid] = now }
        }
    }
    func agentTouches(_ pid: pid_t) {
        lock.withLock { if agentRunning[pid, default: 0] == 0 { agentActivity[pid] = max(agentActivity[pid] ?? -.infinity, now) } }
    }

    /// Whether the rule would read the world becoming (pid, space) as a change that brought forward an app the agent
    /// touched (I1) — computed before the world changes, from the engine's own facts.
    func engineTouches(_ pid: pid_t, space s: UInt64) -> Bool {
        guard let core else { return false }
        let at = now / 1000
        let shown: [pid_t] = core.guardianLock.withLock { core.guardianCore.raiseTouchedApps(now: at) }.filter { p in
            p != pid && wins.values.contains { $0.pid == p && $0.space == s }
        }
        let q = CUMoveQuery(app: pid, space: s, appStartedAt: startedAt[pid].map { $0 / 1000 }, appBundle: bundleId(pid: pid),
                            shown: s != space ? shown : [])
        return core.guardianLock.withLock { core.guardianCore.touches(q, now: at) }
    }

    func activationSpace(_ pid: pid_t) -> UInt64 { mainWin[pid].flatMap { wins[$0]?.space } ?? space }

    func noteSelfChange(_ pid: pid_t) {
        if engineTouches(pid, space: activationSpace(pid)) {
            lock.withLock {
                lastTouchedSelfChangeAt = now
                touchedSelfEpisode = episode + 1  // the change about to happen
            }
        }
    }

    /// Whether `pid` coming forward by itself now is the agent's, the user's (untouched), or can't be told.
    func selfOrigin(_ pid: pid_t) -> SimOrigin {
        // Back to the user's own place (their app came forward again over something else): no theft.
        if pid == userPlace.app, (mainWin[pid].flatMap { wins[$0]?.space } ?? space) == userPlace.space {
            return placeKnown ? .untouched(pid) : .ambiguous("back to the user's last known place, after a change that can't be told")
        }
        // Input of the user's that could explain it (unused, after the agent's last cause on it, of a kind that fits): the
        // rule can't tell this change from their own switch to it.
        let engineTouched = engineTouches(pid, space: activationSpace(pid))
        if let core, engineTouched {
            let at = now / 1000
            let space = mainWin[pid].flatMap { wins[$0]?.space } ?? self.space
            let could = core.guardianLock.withLock {
                core.guardianCore.input.explains(from: at - CUFocusGuardianCore.switchWindow, after: core.guardianCore.lastCause(pid),
                                                 now: at, app: pid != front, desktop: space != self.space, front: pid)
            }
            if could { return .ambiguous("right after input of the user's that can switch") }
        }
        // In the middle of the user's own ⌘-Tab (⌘ held): its release, a moment later, is the switch the guardian sees
        // before it hears of this change — the two can't be told apart (their own switch lands right after anyway).
        if held.contains(.maskCommand) { return .ambiguous("while the user held ⌘ to switch") }
        // Where the user belongs is unknown (a change the rule could not attribute came before): can't be told.
        if !placeKnown { return .ambiguous("the user's place unknown after a change that can't be told") }
        if let l = launched[pid], now <= l.until { return .launch(pid) }
        guard let a = agentActivity[pid] else { return .untouched(pid) }
        if a == .infinity || now - a <= 1_200 { return .agentSelf(pid) }
        if now - a >= 2_000 { return .untouched(pid) }
        return .ambiguous("at the edge of the causal window")
    }

    // MARK: the user

    func userMove(to pid: pid_t, input: Double, why: String) {
        // The rule takes switch input only after the agent's last cause on that app: a cause between their input and the
        // change can't be told from the agent's own doing — not attributable by design.
        let cause = core.map { c in c.guardianLock.withLock { c.guardianCore.lastCause(pid) } } ?? -.infinity
        let interloper = lock.withLock { lastTouchedSelfChangeAt >= input }
        let o: SimOrigin = cause >= input / 1000 ? .ambiguous("a mark of the agent's on \(name(pid)) after the user's input")
            : interloper ? .ambiguous("another app came forward by itself between their input and their switch")
            : .user(why)
        change(front: pid, origin: o, why: why)
    }

    /// The modifier keys the user holds (a flags-changed event carries them all).
    var held: CGEventFlags = []

    func press(_ m: CGEventFlags) { let f = lock.withLock { held.insert(m); return held }; tap(.flagsChanged, flags: f) }
    func release(_ m: CGEventFlags) { let f = lock.withLock { held.remove(m); return held }; tap(.flagsChanged, flags: f) }

    func tap(_ type: CGEventType, flags: CGEventFlags = [], keycode: Int64 = -1) {
        let keyboard = type == .keyDown || type == .keyUp
        lock.withLock {
            if type == .flagsChanged {
                if flags.contains(.maskControl) { controlHeld = true } else { controlHeld = false }
                if flags.isEmpty { lastSwitchInputAt = now }
            }
            if type.rawValue == 31 { lastSwitchInputAt = now }
            if type == .keyDown, flags.contains(.maskControl) || flags.contains(.maskCommand) { lastSwitchInputAt = now }
        }
        if keyboard, secure { return }  // Secure Event Input: the tap sees no keys
        if type == .flagsChanged || type.rawValue == 31 || type == .leftMouseDown {
            log("    the tap: \(type == .flagsChanged ? "flags \(flags.contains(.maskCommand) ? "⌘" : "")\(flags.contains(.maskControl) ? "⌃" : "")\(flags.isEmpty ? "none" : "")" : type.rawValue == 31 ? "a swipe" : "a mouse down")")
        }
        core?.noteTapEvent(type: type, sourcePid: 0, userData: 0, flags: flags, keycode: keycode, now: now / 1000)
    }

    /// One key the user types: where it lands (the window server's key focus, through the reroute when it is on).
    func userKey(flags: CGEventFlags = []) {
        tap(.keyDown, flags: flags, keycode: 0)
        lock.withLock {
            let to = keyFocus
            var landed = to
            if to == SimApp.target.pid, installer.isInstalled, let h = installer.handler {
                lastReroute = nil
                let e = keyEvent(stamped: false)
                landed = h(e) != nil ? to : (lastReroute ?? -1)
                stats.userKeysRerouted += 1
                if placeKnown, landed != userPlace.app {
                    fail("I3: the user's key went to \(name(landed)), their place is \(name(userPlace.app))")
                }
            } else if to == SimApp.target.pid, userPlace.app != SimApp.target.pid, placeKnown, origin.isUsers || origin == .engine {
                fail("I3: the user's key went into T with no reroute while their place is \(name(userPlace.app))")
            }
            log("the user's key → \(name(landed))")
        }
    }

    func name(_ pid: pid_t) -> String {
        if let a = SimApp(rawValue: Int(pid)) { return a.description }
        return launched[pid] != nil ? "L\(pid)" : "pid \(pid)"
    }

    // MARK: CUSystemBackend

    func appRunning(_ pid: pid_t) -> Bool { lock.withLock { running.contains(pid) } }
    func bundleId(pid: pid_t) -> String? { lock.withLock { bundles[pid] ?? launched[pid]?.bundle } }
    func processName(pid: pid_t) -> String? { name(pid) }
    func window(id: UInt32) -> CUWindowServerWindow? { lock.withLock { wins[id].map(serverWindow) } }
    func windows(pid: pid_t) -> [CUWindowServerWindow] {
        lock.withLock { wins.values.filter { $0.pid == pid }.sorted { $0.id < $1.id }.map(serverWindow) }
    }
    func serverWindow(_ w: Win) -> CUWindowServerWindow {
        CUWindowServerWindow(id: w.id, pid: w.pid, ownerName: name(w.pid), title: "", frame: w.frame, layer: 0,
                             onScreen: onScreen(w), alpha: 1)
    }
    func windowStack() -> [CUWindowServerWindow] {
        lock.withLock {
            var out: [CUWindowServerWindow] = []
            var dock = CUWindowServerWindow(id: 9, pid: 900, ownerName: "Dock", title: "", frame: CGRect(x: 0, y: 950, width: 1600, height: 50),
                                            layer: 20, onScreen: true, alpha: 1)
            dock.ownerName = "Dock"
            out.append(dock)
            for p in zOrder { out += wins.values.filter { $0.pid == p && onScreen($0) }.map(serverWindow) }
            return out
        }
    }
    func moveWindowToActiveSpace(_ id: UInt32) -> Bool { false }
    func frontmostPid() -> pid_t? { lock.withLock { front } }
    func activeSpace() -> UInt64? { lock.withLock { space } }

    /// The engine activates an app: never over a place the user chose (I1/I2), and only ever to their current place.
    func activate(pid: pid_t) -> Bool {
        lock.withLock {
            if inUserAction > 0 {
                // The target activated for the user's own click into its window: their move.
                change(front: pid, origin: .user("their click into its window"), why: "the engine activates \(name(pid)) for the user's click")
                return
            }
            // The engine's activations here are restores (bringing the user back never touches their app — the rule's own
            // reading); the sim's agent never activates an app of its own.
            if placeKnown, front == userPlace.app, space == userPlace.space, pid != front {
                fail("I2: the engine activated \(name(pid)) over the user's own place \(name(userPlace.app)) (\(origin))")
            }
            if placeKnown, origin.theft != nil, pid != userPlace.app {
                fail("I2: a theft was put back to \(name(pid)), not to the user's place \(name(userPlace.app))")
            }
            if origin.theft != nil, front == origin.theft { stats.undone += 1 }
            change(front: pid, origin: .engine, why: "the engine activates \(name(pid))")
        }
        return true
    }
    func bringForward(pid: pid_t, windowID: UInt32, window: AXUIElement?, makeMain: Bool) -> Bool { _ = activate(pid: pid); return true }

    /// Accessibility raised a window: it is its app's main window now (no desktop change by itself).
    func raised(_ id: UInt32) {
        lock.withLock {
            guard let w = wins[id] else { return }
            mainWin[w.pid] = id
            onMainWindow?(w.pid, id)
        }
    }
    func spacesFollowActivation() -> Bool? { true }
    func isContentProcess(_ pid: pid_t, of appPid: pid_t) -> Bool { false }
    func stageManagerEnabled() -> Bool { false }
    func windowOnAnySpace(_ id: UInt32) -> Bool? { true }
    func windowSpaces(_ id: UInt32) -> Set<UInt64>? { lock.withLock { wins[id].map { [$0.space] } } }
    func displaySpaces() -> [String: UInt64]? { nil }
    func cursorLocation() -> CGPoint? { CGPoint(x: 5, y: 5) }
    func warpCursor(to: CGPoint) {}
    func processAge(pid: pid_t) -> TimeInterval? { lock.withLock { startedAt[pid].map { (now - $0) / 1000 } } }
}

// MARK: - one run

final class SimRun {
    let plan: SimPlan
    let clock = SimClock()
    let world: SimWorld
    let core: CUCore
    let ax = FakeAX()
    let poster = RecordingPoster()
    let installer = FakeKeyTapInstaller()
    let target: CUTarget
    let window = fakeElement(97_001)
    let field = fakeElement(97_002)
    var launchSeq: pid_t = 800

    var trace: [String] { world.trace }
    var violation: String? { world.violation }
    var stats: SimStats { world.stats }

    init(_ plan: SimPlan) {
        self.plan = plan
        world = SimWorld(clock: clock, seed: plan.seed)
        clock.world = world
        world.installer = installer
        world.poster = poster
        let tpid = SimApp.target.pid
        ax.put(ax.application(tpid), [kAXWindowsAttribute: [window]])
        ax.add(window, role: kAXWindowRole, title: "Docs", frame: CGRect(x: 500, y: 0, width: 400, height: 300),
               extra: [kAXChildrenAttribute: [field]])
        ax.windowIDs[AXIdentity(element: window)] = 77
        ax.makeSettable(window, kAXMainAttribute)
        ax.add(field, role: kAXTextFieldRole, frame: CGRect(x: 520, y: 20, width: 200, height: 24), extra: [kAXWindowAttribute: window])
        ax.focus(pid: tpid, on: field)
        var elements: [UInt32: AXUIElement] = [77: window]
        for (app, token, id) in [(SimApp.user, Int32(97_003), UInt32(31)), (.third, 97_004, 71), (.third, 97_005, 72), (.target, 97_006, 78)] {
            let el = fakeElement(token)
            ax.add(el, role: kAXWindowRole, title: "\(app) \(id)", frame: CGRect(x: 0, y: 0, width: 400, height: 300))
            ax.windowIDs[AXIdentity(element: el)] = id
            elements[id] = el
        }
        ax.put(ax.application(SimApp.user.pid), [kAXFocusedWindowAttribute: elements[31]!, kAXWindowsAttribute: [elements[31]!]])
        ax.put(ax.application(SimApp.third.pid), [kAXFocusedWindowAttribute: elements[71]!, kAXWindowsAttribute: [elements[71]!, elements[72]!]])
        let ax = self.ax
        world.onMainWindow = { pid, id in if let el = elements[id], pid != tpid { ax.put(ax.application(pid), [kAXFocusedWindowAttribute: el]) } }
        let byToken = Dictionary(uniqueKeysWithValues: elements.map { (id, el) -> (String, UInt32) in
            var p: pid_t = 0; AXUIElementGetPid(el, &p); return ("\(p)", id)
        })
        ax.onPerform = { [world] what in
            let parts = what.split(separator: ":")
            if parts.count == 2, parts[1] == "AXRaise", let id = byToken[String(parts[0])] { world.raised(id) }
        }
        core = CUCore(events: nil, clock: clock, skyLight: focusSkyLight(), poster: poster, ax: ax, sys: world,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        world.core = core
        target = CUTarget(id: "tsim", sessionId: "s", pid: tpid, bundleId: "com.apple.finder", appName: "Finder",
                          isChromium: false, mirror: false, windowID: 77, windowTitle: "Docs")
        core.registerForTesting(target, windowElement: window)
        target.refs.beginGeneration()
        core.keyTapInstaller = installer
        core.switchInputObservableOverride = true
        core.secureInputOverride = false
        core.keyFocusPidOverride = { [world] in world.lock.withLock { world.keyFocus } }
        core.keyReroutePost = { [world] _, pid in world.lastReroute = pid }
        core.blipSchedule = { [world] ms, work in world.schedule(after: ms, "a focus blip's bound", work) }
        core.guardianTailSchedule = { _, _ in nil }
        // Some time passes in the engine's own waits, so the world can move under it.
        core.blipKeySettleMs = 20
        core.blipDrainMs = 30
        core.stepSettleMs = 8
        core.userViewSettleMs = 20
        core.restoreDeadlineMs = 300
        core.restoreRetryMs = 60
        core.appleScriptOverride = { [world] _, _ in
            let ms = world.lock.withLock { world.scriptMs }
            var left = ms
            while left > 0 { let d = min(left, 50); world.advance(by: d); left -= d }
            return "ok"
        }
        core.automationPermissionOverride = { _ in OSStatus(noErr) }
        let enforcer = FakeFocusEnforcer()
        enforcer.onForce = { [world] in world.agentTouches(tpid); world.hook(2) }
        enforcer.onDeactivate = { [world] in world.agentTouches(tpid); world.hook(2) }
        core.focusEnforcerFactory = { _ in enforcer }
        poster.onPost = { [world] e in
            guard e.type == .keyDown || e.type == .leftMouseDown else { return }
            world.lock.withLock {
                // A change during this act that put T in front: at most the one event in flight goes after it.
                guard e.pid == tpid, world.front == tpid, world.episode != world.actEpisode, world.actStartFront != tpid else { return }
                if world.origin.theft == tpid {
                    world.helperKeysIntoThief += 1
                    if world.helperKeysIntoThief > 1 {
                        world.fail("I4: the agent kept typing into T after it came forward by itself (\(world.helperKeysIntoThief) events)")
                    }
                }
                if case .user = world.origin, world.userPlace.app == tpid {
                    world.helperKeysIntoUsersApp += 1
                    if world.helperKeysIntoUsersApp > 1 {
                        world.fail("I4: the agent kept typing into T after the user moved into it (\(world.helperKeysIntoUsersApp) events)")
                    }
                }
            }
            world.log("the agent posts \(e.type == .keyDown ? "a key" : "a click") to \(world.name(e.pid))")
            world.hook(e.type == .keyDown ? 45 : 10)
        }
        FocusSPI.reset()
        FocusSPI.frontPid = SimApp.user.pid
        FocusSPI.onFocus = { [world] in
            guard let last = FocusSPI.calls.last, last.hasPrefix("focus pid ") else { return }
            let p = pid_t(last.split(separator: " ")[2])!
            world.lock.withLock {
                world.keyFocus = p
                if p == tpid { world.agentTouches(tpid) }
                if p != tpid, world.placeKnown, p != world.userPlace.app {
                    world.fail("I3: the key focus was handed to \(world.name(p)), an app the user left (their place: \(world.name(world.userPlace.app)))")
                }
            }
            world.log("focus record → \(world.name(p))")
            world.hook(3)
        }
        core.moveJudged = { [world] path, v, owner in
            world.log("  \(path): front \(world.name(v.front ?? 0)), desktop \(v.space ?? 0) — \(owner.words)")
            world.lock.withLock {
                if v.front == world.front, v.space == world.space { world.observedEpisode = world.episode }
                let key = "\(world.episode):\(v.front ?? 0):\(v.space ?? 0)"
                if owner.isUsers { world.judgedUsers.insert(key) } else if case .agent = owner, world.judgedUsers.contains(key) {
                    world.fail("I5: \(path) judged the agent's a state already judged the user's (front \(world.name(v.front ?? 0)), desktop \(v.space ?? 0))")
                }
            }
        }
        core.noteGuardianPrivatePath(true)
        _ = core.startGuardian(privatePath: true)
    }

    static func execute(_ plan: SimPlan) async -> SimRun {
        let run = SimRun(plan)
        await run.go()
        return run
    }

    func go() async {
        let base = clock.nowMs()
        // Every user and app event is scheduled at its time; the agent's acts run when the clock reaches theirs.
        for step in plan.steps where !step.kind.isAgent {
            world.schedule(after: base + step.at - clock.nowMs(), step.words) { [unowned self] in self.user(step) }
        }
        for step in plan.steps where step.kind.isAgent {
            if world.violation != nil { break }
            world.advance(to: max(clock.nowMs(), base + step.at))
            await agent(step)
        }
        let end = (plan.steps.last?.at ?? 0) + base + 3_000
        world.advance(to: max(end, clock.nowMs() + 3_000))
        core.stopGuardian()
        FocusSPI.onFocus = nil
    }

    // MARK: the user's and the apps' events

    func user(_ step: SimStep) {
        var r = SimRNG(step.seed)
        let w = world
        func click(_ pid: pid_t) {
            guard let win = w.lock.withLock({ w.appWindow(pid, onSpace: w.space) }) else { return }
            w.lock.withLock { w.inUserAction += 1; if pid != w.front { w.lastSwitchInputAt = w.now } }
            w.tap(.leftMouseDown)
            _ = core.onPhysicalClick(at: CGPoint(x: win.frame.midX, y: win.frame.midY), userData: 0, now: clock.nowSeconds())
            w.lock.withLock { w.inUserAction -= 1 }
            // The window server activates the clicked app as it handles the mouse down: before any later input of theirs.
            w.userMove(to: pid, input: clock.nowMs(), why: "the user clicked \(w.name(pid))")
        }
        switch step.kind {
        case .click(let a):
            click(a.pid)
        case .dock(let a):
            w.lock.withLock { w.lastSwitchInputAt = w.now }
            w.tap(.leftMouseDown)
            _ = core.onPhysicalClick(at: CGPoint(x: 800, y: 970), userData: 0, now: clock.nowSeconds())
            let at = clock.nowMs()
            w.schedule(after: r.double(20, 200), "the Dock activates \(a)") {
                w.userMove(to: a.pid, input: at, why: "the user clicked \(a) in the Dock")
            }
        case .commandTab(let a):
            w.press(.maskCommand)
            w.schedule(after: r.double(60, 350), "⌘ released") {
                w.release(.maskCommand)
                let at = self.clock.nowMs()
                let secure = w.secure
                w.schedule(after: r.double(10, 70), "the switcher activates \(a)") {
                    if secure, w.engineTouches(a.pid, space: w.activationSpace(a.pid)) {
                        w.change(front: a.pid, origin: .ambiguous("a ⌘-Tab under Secure Event Input"), why: "the user ⌘-Tabbed to \(a) (secure input)")
                    } else {
                        w.userMove(to: a.pid, input: at, why: "the user ⌘-Tabbed to \(a)")
                    }
                }
            }
        case .controlArrow(let s, let seen):
            w.press(.maskControl)
            let downAt = clock.nowMs()
            w.schedule(after: 40, "the arrow") {
                if seen { w.tap(.keyDown, flags: .maskControl, keycode: 124) }
                w.schedule(after: r.double(150, 400), "the desktop switches") {
                    self.userSpace(s, input: downAt, keyboard: true, why: "the user ⌃-arrowed to desktop \(s)")
                }
            }
            w.schedule(after: r.double(100, 600), "⌃ released") { w.release(.maskControl) }
        case .swipe(let s):
            w.tap(CGEventType(rawValue: 31)!)
            let at = clock.nowMs()
            w.schedule(after: r.double(150, 350), "the desktop switches") {
                self.userSpace(s, input: at, why: "the user swiped to desktop \(s)")
            }
        case .typing(let n):
            for i in 0..<n { w.schedule(after: Double(i) * r.double(40, 90), "a key of the user's") { w.userKey() } }
        case .shortcut:
            w.press(.maskCommand)
            w.schedule(after: 50, "⌘S") { w.userKey(flags: .maskCommand) }
            w.schedule(after: 120, "⌘ released") { w.release(.maskCommand) }
        case .secure(let on):
            w.lock.withLock { w.secure = on }
            core.secureInputOverride = on
            w.log("Secure Event Input \(on ? "on" : "off")")
        case .scroll:
            w.tap(CGEventType(rawValue: 29)!)
            w.tap(.scrollWheel)
        case .selfActivate(let a):
            let o = w.selfOrigin(a.pid)
            w.noteSelfChange(a.pid)
            w.change(front: a.pid, origin: o, why: "\(a) activates itself")
        default:
            break
        }
    }

    /// A desktop change of the user's: the topmost app there comes forward.
    func userSpace(_ s: UInt64, input: Double, keyboard: Bool = false, why: String) {
        let w = world
        let app = w.lock.withLock { w.zOrder.first { p in w.appWindow(p, onSpace: s) != nil } ?? w.front }
        let cause = core.guardianLock.withLock { max(core.guardianCore.lastCause(app), core.guardianCore.lastCause(SimApp.target.pid)) }
        let touched = w.engineTouches(app, space: s)
        let interloper = w.lock.withLock { w.lastTouchedSelfChangeAt >= input }
        let o: SimOrigin = cause >= input / 1000 ? .ambiguous("a mark of the agent's after the user's desktop switch began")
            : interloper ? .ambiguous("another app came forward by itself between their input and their switch")
            : keyboard && w.secure && touched ? .ambiguous("a ⌃-arrow under Secure Event Input")
            : .user(why)
        w.change(front: app, space: s, origin: o, why: why)
    }

    // MARK: the agent

    func agent(_ step: SimStep) async {
        let w = world
        let tpid = SimApp.target.pid
        w.stats.agentActs += 1
        w.lock.withLock { w.helperKeysIntoThief = 0; w.helperKeysIntoUsersApp = 0; w.actEpisode = w.episode; w.actStartFront = w.front }
        w.log("— \(step.kind.words)")
        switch step.kind {
        case .agentType(let n):
            w.agentBegins(tpid)
            defer { w.agentEnds(tpid) }
            let text = String(repeating: "x", count: n)
            do {
                _ = try await core.targetAct(TargetActParams(targetId: "tsim", sessionId: "s", callId: "c\(step.seed)",
                                                             action: .type(CUTypeAction(text: text)), access: .full,
                                                             allowForeground: false, privatePath: true))
            } catch { w.log("the act: \((error as? CUError)?.message ?? "\(error)")") }
        case .agentClick:
            w.agentBegins(tpid)
            defer { w.agentEnds(tpid) }
            do {
                let ref = target.refs.ref(for: AXIdentity(element: field))
                _ = try await core.targetAct(TargetActParams(targetId: "tsim", sessionId: "s", callId: "c\(step.seed)",
                                                             action: .click(CUClickAction(ref: ref)), access: .full,
                                                             allowForeground: false, privatePath: true))
            } catch { w.log("the click: \((error as? CUError)?.message ?? "\(error)")") }
        case .agentAppleScript(let seconds):
            w.lock.withLock { w.scriptMs = seconds * 1000 }
            w.agentBegins(tpid)
            defer { w.agentEnds(tpid) }
            do {
                _ = try await core.targetAppleScript(TargetAppleScriptParams(targetId: "tsim", source: "tell application \"Finder\" to get name"))
            } catch { w.log("the script: \((error as? CUError)?.message ?? "\(error)")") }
        case .agentBindLaunch(let after):
            launchSeq += 1
            let pid = launchSeq
            let wid = UInt32(8000 + pid)
            let bundle = "sim.launched.\(pid)"
            w.agentBegins(pid)
            w.lock.withLock {
                w.launched[pid] = (bundle, .infinity)
                w.running.insert(pid)
                w.startedAt[pid] = clock.nowMs()
                w.wins[wid] = SimWorld.Win(id: wid, pid: pid, frame: CGRect(x: 200, y: 600, width: 300, height: 200), space: w.space)
                w.mainWin[pid] = wid
                w.zOrder.append(pid)
            }
            let el = fakeElement(Int32(60_000 + pid))
            ax.add(el, role: kAXWindowRole, title: "New", frame: CGRect(x: 200, y: 600, width: 300, height: 200))
            ax.windowIDs[AXIdentity(element: el)] = wid
            ax.put(ax.application(pid), [kAXWindowsAttribute: [el], kAXFocusedWindowAttribute: el])
            // It activates itself a while into the launch — maybe after the bind returned.
            w.schedule(after: after, "\(pid) activates itself (its launch)") {
                let o = w.selfOrigin(pid)
                w.noteSelfChange(pid)
                w.change(front: pid, origin: o, why: "the launched app activates itself")
            }
            core.resolveBindApp = { _, core in
                core.noteGuardianLaunchBundle(bundle)
                return CUCore.BindApp(pid: pid, bundleIdentifier: bundle, name: "Launched", executableName: "Launched",
                                      isChromium: false, launched: true, running: nil)
            }
            do {
                _ = try await core.targetBind(TargetBindParams(sessionId: "s", app: bundle, mirror: false))
            } catch { w.log("the bind: \((error as? CUError)?.message ?? "\(error)")") }
            w.agentEnds(pid)
            // Inside its causal window the launched app's own activation is still the agent's.
            w.lock.withLock { w.launched[pid]?.until = clock.nowMs() + 1_200 }
        default:
            break
        }
    }

    // MARK: minimizing

    /// Delta debugging (ddmin) over the steps, keeping the same invariant failing, then one pass over single steps;
    /// bounded in time.
    static func minimize(_ plan: SimPlan) async -> SimPlan {
        let kind = (await execute(plan)).violation.map { String($0.prefix(3)) }
        let deadline = Date().addingTimeInterval(120)
        func fails(_ steps: [SimStep]) async -> Bool {
            guard let v = (await execute(SimPlan(seed: plan.seed, steps: steps))).violation else { return false }
            return String(v.prefix(3)) == kind
        }
        var cur = plan.steps
        var n = 2
        while cur.count >= 2, Date() < deadline {
            let chunk = Int((Double(cur.count) / Double(n)).rounded(.up))
            var reduced = false
            for i in 0..<n {
                let lo = i * chunk, hi = min(cur.count, lo + chunk)
                guard lo < hi else { break }
                var trial = cur
                trial.removeSubrange(lo..<hi)
                if await fails(trial) { cur = trial; n = max(n - 1, 2); reduced = true; break }
            }
            if !reduced {
                if n >= cur.count { break }
                n = min(cur.count, n * 2)
            }
        }
        var i = 0
        while i < cur.count, Date() < deadline {
            var trial = cur
            trial.remove(at: i)
            if await fails(trial) { cur = trial } else { i += 1 }
        }
        return SimPlan(seed: plan.seed, steps: cur)
    }
}
