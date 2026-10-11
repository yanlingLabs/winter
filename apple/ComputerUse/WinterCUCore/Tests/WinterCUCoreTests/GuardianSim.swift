import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

// The honest model-based test's WORLD and ORACLE (round 9). The world is a simulated Mac — apps, windows on desktops and
// a second display, the window server's click routing and key focus, activation latency and refusals, NSWorkspace's
// delayed notifications — in simulated time. The ORACLE never reads the engine to decide what is right: every change of
// the user's front app or desktop carries the cause the world itself scheduled (the user, with where they meant to go;
// the agent directly or indirectly; an app on its own; the engine's own activation), and the expected outcome of each
// cause is the contract's (PROTOCOL.md §4.12), computed from the world's own facts (the agent's own record of what it
// did and when, the user's hardware input as the session tap could see it). Where the contract leaves the engine more
// than one right answer (the engine cannot see the difference by design), the oracle keeps every right answer as a
// CANDIDATE and holds the engine to the first one it commits to — nothing is ever switched off.

// MARK: - the cast

enum SimPid {
    /// U — the user's app (Terminal: with Secure Keyboard Entry on, Secure Event Input is on while it is in front).
    static let user: pid_t = 1
    /// T — session s1's bound app (Finder: a click on the empty desktop activates it).
    static let target: pid_t = 5252
    /// X — an app the agent never touches.
    static let third: pid_t = 700
    /// S — opens a link the agent clicks in T (the agent's indirect effect).
    static let safari: pid_t = 710
    /// P — opens a file the agent's AppleScript opens (the agent's indirect effect).
    static let preview: pid_t = 720
    /// Y — an app on the second display.
    static let side: pid_t = 770
    /// T2 — session s2's target on desktop 300 (desktop visits).
    static let visited: pid_t = 6000
    /// T3 — session s2's target held in front (the consented foreground, rung 4).
    static let held: pid_t = 6100
    static let notifications: pid_t = 730
    static let systemUI: pid_t = 740
    static let pip: pid_t = 750
    /// CoreServicesUIAgent: a dialog the agent's AppleScript raises (the agent's indirect effect).
    static let coreServices: pid_t = 760
    static let dock: pid_t = 900
    static let own: pid_t = getpid()

    static func name(_ pid: pid_t) -> String {
        if pid > 950 && pid < 1000 { return "UL\(pid - 950)" }
        switch pid {
        case user: return "U"
        case target: return "T"
        case third: return "X"
        case safari: return "S"
        case preview: return "P"
        case side: return "Y"
        case visited: return "T2"
        case held: return "T3"
        case notifications: return "NC"
        case systemUI: return "SUI"
        case pip: return "PiP"
        case coreServices: return "CSUIA"
        case dock: return "Dock"
        case own: return "helper"
        default: return pid >= 800 && pid < 900 ? "L\(pid)" : "pid \(pid)"
        }
    }
}

/// Where the user is: the front app and the active desktop.
struct SPlace: Hashable, CustomStringConvertible {
    var app: pid_t
    var space: UInt64
    var description: String { "\(SimPid.name(app))@\(space)" }
}

/// The consented foreground while it lasts: the app held, and where the user was before it (their place, and what was in
/// front — a give-back may go to either).
struct SimHeld: Hashable {
    var app: pid_t
    var pre: SPlace
    var preSeen: SPlace
}

/// One right answer still open: where the user belongs (every restore goes there), where the world must settle, and the
/// consented foreground in progress.
struct SimCand: Hashable, CustomStringConvertible {
    var place: SPlace
    var expected: SPlace
    var held: SimHeld?
    /// During a desktop visit: what was in front when it began (its return may go back there, or to their place).
    var visitPre: SPlace? = nil
    var description: String {
        "place \(place), settles at \(expected)" + (held.map { ", \(SimPid.name($0.app)) held (before: \($0.pre))" } ?? "")
            + (visitPre.map { ", visit from \($0)" } ?? "")
    }
}

/// What an activation the engine asked for is, by the engine operation that asked (the world knows which it is running).
enum SimEngineKind: Equatable, CustomStringConvertible {
    case restore, giveBack, visitReturn, visitThere, consented(pid_t), userClick(SPlace)
    var description: String {
        switch self {
        case .restore: return "a restore"
        case .giveBack: return "a give-back after the consented foreground"
        case .visitReturn: return "a desktop visit's return"
        case .visitThere: return "a desktop visit's way there"
        case .consented(let p): return "the consented foreground of \(SimPid.name(p))"
        case .userClick(let d): return "the activation for the user's click into \(d)"
        }
    }
}

/// What made a change — the WORLD's record, never the engine's.
indirect enum SimCause: CustomStringConvertible {
    /// The user's own move, to where they meant to go.
    case user(SPlace, String)
    /// An app the agent touched came forward by itself: the agent's — undone (I4).
    case agentDirect(pid_t, String)
    /// An app the agent never touched came forward (on its own, or as an indirect effect of the agent's action): the
    /// user's place (I1: `.adopt`); with no input of the user's since the agent acted while it was active, the agent's
    /// indirect effect (`.undone`, like a theft — the user's ruling, round 9) — or, for a system dialog, left in front for
    /// the user to answer (`.leftAlone`).
    case untouched(pid_t, SimUntouched, indirect: Bool, String)
    /// The engine's own activation landing.
    case engine(SimEngineKind)
    /// More than one answer is right (the engine can't see the difference by design): every one is kept.
    case either([SimCause], String)

    var description: String {
        switch self {
        case .user(let d, let why): return "the user's (\(why), to \(d))"
        case .agentDirect(let p, let why): return "the agent's (\(SimPid.name(p)) by itself: \(why))"
        case .untouched(let p, let v, let indirect, let why):
            return "\(SimPid.name(p)) untouched\(indirect ? " (truly the agent's indirect effect)" : ""): \(v.rawValue) — \(why)"
        case .engine(let k): return "the engine's: \(k)"
        case .either(let o, let why): return "EITHER (\(why)): " + o.map(\.description).joined(separator: " | ")
        }
    }

    var ambiguous: Bool { if case .either = self { return true } else { return false } }

    /// The agent's own doing (in at least one right answer).
    var isTheft: Bool {
        switch self {
        case .agentDirect, .untouched(_, .undone, _, _): return true
        case .either(let o, _): return o.contains { $0.isTheft }
        default: return false
        }
    }
}

/// What the agent clicks in T.
enum SimClickWhat: String { case field = "a field", link = "a link (an AX link)", opener = "a button that opens Safari" }

/// What becomes of an app the agent never touched coming forward.
enum SimUntouched: String { case adopt = "the user's place (I1)", undone = "undone (the agent's indirect effect)", leftAlone = "left in front (a system dialog), not their place" }

/// One input of the user's that can switch apps or desktops, and where they meant to go with it.
struct SimSwitch {
    var at: Double
    var app: Bool
    var desktop: Bool
    /// A click on that app's window (it explains only that app).
    var target: pid_t?
    /// A click INTO a window (a claim: nothing else competes for it).
    var claim = false
    /// Where they meant to go (nil: nowhere — a status item, a ⌘C that looks like a ⌘-Tab under Secure Event Input).
    var dest: pid_t?
    /// When their switch landed (nil: not yet, or it changed nothing).
    var landedAt: Double?
    /// Under Secure Event Input: true — the tap saw the modifiers (measured, run107); false — it saw nothing.
    var secureFlags: Bool?
    /// How long it can explain a change.
    var lifeMs: Double = 1000
    var keyboard = false
    /// A ⌃ hold whose arrows the engine can't count: it may explain any desktop change heard until then, landed or not.
    var countlessUntil: Double?
    /// A ⌘-Tab whose ⌘ is still down: it switches (and explains anything) only from its release.
    var pending = false
    /// The engine sees it at all.
    var visible: Bool { secureFlags != false }
}

/// The checks' tallies.
struct SimStats {
    var changes = 0
    var decided = 0
    var ambiguous = 0
    var ambiguousWhy: [String: Int] = [:]
    var unchecked = 0
    var uncheckedWhy: [String: Int] = [:]
    /// Engine activations (restores, a visit's return) checked against more than one right answer: issued before the engine
    /// had heard of a change, they decide nothing between that change's answers.
    /// Acts refused because the user was working in the app (round 10).
    var handsOff = 0
    var activationsOpen = 0
    var activationsOpenWhy: [String: Int] = [:]
    var settleChecks = 0
    var restoresChecked = 0
    var keysChecked = 0
    var userKeysRerouted = 0
    var undone = 0
    var userMovesKept = 0
    var leftAlone = 0
    var agentActs = 0
    var s2Ops = 0
    mutating func add(_ o: SimStats) {
        changes += o.changes; decided += o.decided; ambiguous += o.ambiguous; unchecked += o.unchecked
        settleChecks += o.settleChecks; restoresChecked += o.restoresChecked; keysChecked += o.keysChecked
        userKeysRerouted += o.userKeysRerouted; undone += o.undone; userMovesKept += o.userMovesKept; leftAlone += o.leftAlone
        agentActs += o.agentActs; s2Ops += o.s2Ops; activationsOpen += o.activationsOpen; handsOff += o.handsOff
        for (k, v) in o.activationsOpenWhy { activationsOpenWhy[k, default: 0] += v }
        for (k, v) in o.ambiguousWhy { ambiguousWhy[k, default: 0] += v }
        for (k, v) in o.uncheckedWhy { uncheckedWhy[k, default: 0] += v }
    }
    var words: String {
        let amb = ambiguousWhy.sorted { $0.value > $1.value }.map { "\($0.value) \($0.key)" }.joined(separator: "; ")
        let unc = uncheckedWhy.sorted { $0.value > $1.value }.map { "\($0.value) \($0.key)" }.joined(separator: "; ")
        return """
            \(changes) changes of the user's view: \(decided) with ONE right outcome (\(pct(decided))), \(ambiguous) with \
            several right outcomes, all kept and the engine held to the one it took (\(pct(ambiguous)): \(amb)), \
            \(unchecked) unchecked (\(pct(unchecked))\(unc.isEmpty ? "" : ": " + unc)); \(settleChecks) settle checks, \
            \(restoresChecked) engine activations checked (\(activationsOpen) of them against several answers: \(activationsOpenWhy.sorted { $0.value > $1.value }.map { "\($0.value) \($0.key)" }.joined(separator: "; "))), \(keysChecked) user keys checked (\(userKeysRerouted) through the \
            reroute); \(agentActs) agent operations, \(s2Ops) of session s2 (visits, holds, rung 4); \(undone) thefts undone, \
            \(userMovesKept) user moves kept, \(leftAlone) changes left alone (neither adopted nor undone), \(handsOff) acts refused while the \
            user worked in the app
            """
    }
    func pct(_ n: Int) -> String { changes == 0 ? "0%" : String(format: "%.1f%%", 100 * Double(n) / Double(changes)) }
}

// MARK: - the clock

final class SimClock: CUClock, @unchecked Sendable {
    private let lock = NSRecursiveLock()
    private var ms: Double = 1_000_000
    weak var world: SimWorld?
    func nowMs() -> Double { lock.withLock { ms } }
    /// An async sleep (a timeout racing an operation on its own task): it never moves the world — only the run's own
    /// thread does, so nothing runs twice at once — it waits for simulated time to pass, a bounded while.
    func sleep(ms d: Double) async throws {
        let until = nowMs() + d
        for _ in 0..<2_000 where nowMs() < until { try await Task.sleep(nanoseconds: 1_000_000) }
    }
    func pause(ms d: Double) {
        if let world { world.advance(by: max(0, d)) } else { lock.withLock { ms += max(0, d) } }
    }
    func set(_ v: Double) { lock.withLock { ms = max(ms, v) } }
}

struct SimRNG {
    var state: UInt64
    init(_ seed: UInt64) { state = seed &* 0x9E37_79B9_7F4A_7C15 | 1 }
    mutating func next() -> UInt64 {
        state ^= state << 13; state ^= state >> 7; state ^= state << 17
        return state
    }
    mutating func int(_ n: Int) -> Int { Int(next() % UInt64(max(n, 1))) }
    mutating func double(_ lo: Double, _ hi: Double) -> Double { lo + (hi - lo) * Double(next() % 1_000_000) / 1_000_000 }
    mutating func chance(_ p: Double) -> Bool { double(0, 1) < p }
}

// MARK: - the world

struct SimWin {
    var id: UInt32
    var pid: pid_t
    var frame: CGRect
    /// nil: on every desktop (and display).
    var space: UInt64?
    var layer = 0
    /// The window server routes clicks through it (the helper's cursor overlay and mirror).
    var clickThrough = false
    var shown = true
}

/// What the engine is doing that asked for an activation (pushed around the call; cleared for nested events).
enum SimCtx { case userClick(SPlace), hold(pid_t), rung4(pid_t), holdRelease, visitArrive(pid_t), visitFinish }

final class SimWorld: CUSystemBackend, @unchecked Sendable {
    let lock = NSRecursiveLock()
    let clock: SimClock
    weak var core: CUCore?
    var installer: FakeKeyTapInstaller!
    var rng: SimRNG
    /// Whether the session tap sees the modifiers under Secure Event Input (measured for posted events: yes, run107).
    let flagsSeenUnderSecure: Bool

    // MARK: state
    var wins: [UInt32: SimWin] = [:]
    var running: Set<pid_t> = Set(SimPid.mainCast)
    var startedAt: [pid_t: Double] = [:]
    var bundles: [pid_t: String] = [SimPid.target: "com.apple.finder", SimPid.user: "com.apple.Terminal", SimPid.third: "sim.third",
                                    SimPid.safari: "com.apple.Safari", SimPid.preview: "com.apple.Preview", SimPid.side: "sim.side",
                                    SimPid.visited: "sim.visited", SimPid.held: "sim.held", SimPid.coreServices: "com.apple.coreservices.uiagent"]
    var front: pid_t = SimPid.user
    var space1: UInt64 = 100
    var focusDisplay = 1
    var space: UInt64 { focusDisplay == 2 ? 400 : space1 }
    var keyFocus: pid_t = SimPid.user
    /// Apps front to back.
    var zOrder: [pid_t] = [SimPid.user, SimPid.target, SimPid.third, SimPid.safari, SimPid.preview, SimPid.held, SimPid.visited,
                           SimPid.side, SimPid.coreServices]
    var mainWin: [pid_t: UInt32] = [SimPid.user: 31, SimPid.target: 77, SimPid.third: 71, SimPid.safari: 81, SimPid.preview: 91,
                                    SimPid.side: 41, SimPid.visited: 61, SimPid.held: 66, SimPid.coreServices: 761]
    var onMainWindow: ((pid_t, UInt32) -> Void)?
    /// The desktop changed: accessibility lists each app's windows on the desktops shown now (not those on another Space).
    var onDesktop: (() -> Void)?
    /// U's Secure Keyboard Entry: Secure Event Input is on while U is in front.
    var secureEntry = false
    var secure: Bool { secureEntry && front == SimPid.user }
    var held: CGEventFlags = []
    /// The app the banner on screen is about, how long the AppleScript running takes, and when an indirect effect of
    /// the agent's came forward (for the report it owes).
    var bannerSubject: pid_t?
    /// Apps the user launched (Spotlight, the Finder), and when: their first activation is theirs.
    var userLaunches: [pid_t: Double] = [:]
    var backgroundOpens = 0
    /// An untouched app's coming forward the engine must SAY (sent back, or a system dialog left in front): owed from
    /// the change, due once its notification found it still in front.
    var owedNote: (pid: pid_t, episode: Int, at: Double)?
    var dueNotes: [(pid: pid_t, at: Double)] = []
    var notedAt: Double = -.infinity
    /// The late alternative of the untouched change being classified (taken by `change`).
    var nextWiden: (fact: LateFact, alt: SimCause, why: String)?
    var pendingWiden: Int?
    var scriptMs: Double = 0
    var indirectSince: [pid_t: Double] = [:]

    // MARK: the oracle
    var cands: Set<SimCand> = [SimCand(place: SPlace(app: SimPid.user, space: 100), expected: SPlace(app: SimPid.user, space: 100))]
    var frontCause: SimCause = .user(SPlace(app: SimPid.user, space: 100), "the start")
    var switches: [SimSwitch] = []
    /// The last change that was not the landing of a user's own switch (it may have used up their switch input).
    var lastOtherChangeAt: Double = -.infinity
    /// The last landing of a switch of the user's (two inputs before two landings: the engine may pair them either way).
    var lastUserChangeAt: Double = -.infinity
    /// Round 10 (user ruling): the agent target the user is WORKING in — they clicked into its window, or typed while it
    /// was in front (keys the tap can see) — until it leaves the front; a click into it while it is not in front counts
    /// once its activation lands (within 0.5 s).
    var userWorkingIn: pid_t?
    var pendingWork: (app: pid_t, until: Double)?
    /// The world's answer: is the user working in `pid` now?
    func userWorks(in pid: pid_t) -> Bool {
        lock.withLock {
            if let p = pendingWork, front == p.app, now <= p.until { userWorkingIn = p.app; pendingWork = nil }
            return userWorkingIn == pid && front == pid
        }
    }
    func userInteracted(_ app: pid_t) {
        lock.withLock {
            guard SimPid.agentTargets.contains(app) else { return }
            if front == app { userWorkingIn = app; pendingWork = nil } else { pendingWork = (app, now + 500) }
        }
    }
    /// The world's own record of the agent: operations running per app, the last thing it did to each app (a cause, or
    /// an operation's end), its last cause on any app (the earliest the engine may count) and its last posted event (the
    /// latest), and its last action that can raise a window or a desktop.
    var opsRunning: [pid_t: Int] = [:]
    var lastTouchAt: [pid_t: Double] = [:]
    var lastCauseAt: [pid_t: Double] = [:]
    var lastPostAt: Double = -.infinity
    var raiseAt: [pid_t: Double] = [:]
    /// The engine's restores issued to each app (an app it restored may come forward late).
    var restoreIssuedAt: [pid_t: Double] = [:]
    /// The user's hardware input: any, and what the session tap could see.
    var lastHardwareAt: Double = -.infinity
    var lastObservableHardwareAt: Double = -.infinity
    /// The agent's last action that can open apps (a click, a press, an AppleScript, a launch, an open): round 10.
    var lastOpenerAt: Double = -.infinity
    var visiting = false
    var visitStartedAt: Double = -.infinity
    /// The app in front when the visit began (the visit's way back is the agent's too).
    var visitUserApp: pid_t?
    var holding = false
    /// The engine judges a change when it HEARS of it (NSWorkspace, up to ~0.4 s here): facts that arrive in between (the
    /// agent's next cause, the user's input) can rightly change its answer for an app the agent never touched — the other
    /// answer, added if such a fact arrives before the change is heard.
    enum LateFact { case agentCause, hardware }
    var widen: (episode: Int, until: Double, fact: LateFact, alt: Set<SimCand>, why: String)?
    /// Changes the engine has not heard of yet: a restore issued meanwhile may go to the place from before them.
    var unheard: [(until: Double, places: Set<SPlace>, from: SPlace)] = []
    var episode = 0
    var judgedUsers: Set<String> = []
    var actEpisode = 0
    var actStartFront: pid_t = 0
    var agentEventsAfterFront = 0
    var stepsRetiredAtStart = 0
    var targetForwardDuringOp = false
    var ctx: [SimCtx] = []
    var inUserClick = 0

    // MARK: scheduling
    struct Event { var at: Double; var seq: Int; var name: String; var run: () -> Void }
    var events: [Event] = []
    var seq = 0
    var depth = 0
    var pendingLandings = 0
    var pendingNotes = 0
    var lastActivationNoteAt: Double = 0
    var lastSpaceNoteAt: Double = 0
    var settleSeq = 0
    var lastReroute: pid_t?

    // MARK: results
    var trace: [String] = []
    var violation: String?
    var stats = SimStats()
    var notes: [String] = []

    init(clock: SimClock, seed: UInt64, flagsSeen: Bool) {
        self.clock = clock
        rng = SimRNG(seed ^ 0x5151)
        flagsSeenUnderSecure = flagsSeen
        let all: [SimWin] = [
            SimWin(id: 31, pid: SimPid.user, frame: CGRect(x: 0, y: 40, width: 400, height: 300), space: 100),
            SimWin(id: 77, pid: SimPid.target, frame: CGRect(x: 500, y: 40, width: 400, height: 300), space: 100),
            SimWin(id: 78, pid: SimPid.target, frame: CGRect(x: 500, y: 400, width: 400, height: 300), space: 300),
            SimWin(id: 71, pid: SimPid.third, frame: CGRect(x: 1000, y: 40, width: 400, height: 300), space: 100),
            SimWin(id: 72, pid: SimPid.third, frame: CGRect(x: 1000, y: 400, width: 400, height: 300), space: 200),
            SimWin(id: 81, pid: SimPid.safari, frame: CGRect(x: 0, y: 400, width: 400, height: 300), space: 100),
            SimWin(id: 91, pid: SimPid.preview, frame: CGRect(x: 500, y: 720, width: 300, height: 200), space: 100),
            SimWin(id: 66, pid: SimPid.held, frame: CGRect(x: 1000, y: 720, width: 300, height: 200), space: 100),
            SimWin(id: 61, pid: SimPid.visited, frame: CGRect(x: 0, y: 400, width: 400, height: 300), space: 300),
            SimWin(id: 41, pid: SimPid.side, frame: CGRect(x: 1700, y: 100, width: 400, height: 300), space: 400),
            // X's non-activating floating panel (a HUD): a click on it activates nothing.
            SimWin(id: 711, pid: SimPid.third, frame: CGRect(x: 1200, y: 420, width: 200, height: 100), space: 100, layer: 3),
            // Picture in Picture: on every desktop, floating.
            SimWin(id: 801, pid: SimPid.pip, frame: CGRect(x: 1300, y: 800, width: 200, height: 120), space: nil, layer: 3),
            // A menu-bar status item.
            SimWin(id: 601, pid: SimPid.systemUI, frame: CGRect(x: 1300, y: 0, width: 30, height: 24), space: nil, layer: 25),
            // A Notification Center banner (shown when a notification arrives).
            SimWin(id: 701, pid: SimPid.notifications, frame: CGRect(x: 1350, y: 30, width: 240, height: 70), space: nil, layer: 23, shown: false),
            SimWin(id: 9, pid: SimPid.dock, frame: CGRect(x: 0, y: 950, width: 1600, height: 50), space: nil, layer: 20),
            // The helper's own: the agent cursor's overlay — a floating click-through panel the size of T's window — and
            // the mirror's panel over its traffic lights (both on every desktop); the desktop-switch prompt takes clicks.
            SimWin(id: 501, pid: SimPid.own, frame: CGRect(x: 500, y: 40, width: 400, height: 300), space: nil, layer: 3, clickThrough: true),
            SimWin(id: 502, pid: SimPid.own, frame: CGRect(x: 500, y: 40, width: 80, height: 30), space: nil, layer: 3, clickThrough: true),
            SimWin(id: 503, pid: SimPid.own, frame: CGRect(x: 600, y: 400, width: 360, height: 160), space: nil, layer: 25, shown: false),
            // CoreServicesUIAgent's dialog (shown when the agent's AppleScript raises it).
            SimWin(id: 761, pid: SimPid.coreServices, frame: CGRect(x: 600, y: 300, width: 400, height: 200), space: 100, layer: 8, shown: false),
        ]
        for w in all { wins[w.id] = w }
    }

    var now: Double { clock.nowMs() }
    func log(_ s: String) { lock.withLock { trace.append("\(Int(now - 1_000_000)) ms: \(s)") } }

    func fail(_ s: String) {
        lock.withLock {
            guard violation == nil else { return }
            violation = s
            trace.append("VIOLATION: \(s)")
            trace.append("  candidates: \(cands.map(\.description).sorted().joined(separator: " / "))")
        }
    }

    // MARK: scheduling

    func schedule(after ms: Double, _ name: String, _ run: @escaping () -> Void) {
        lock.withLock {
            seq += 1
            events.append(Event(at: now + max(0, ms), seq: seq, name: name, run: run))
        }
    }

    /// Simulated time passes: due events run in time order — also INSIDE a pause of an engine operation (the main queue,
    /// the user and the apps go on while a restore waits on its own queue), up to a depth.
    func advance(by ms: Double) { advance(to: now + ms) }

    func advance(to target: Double) {
        let deep = lock.withLock { () -> Bool in
            if depth >= 10 { return true }
            depth += 1
            return false
        }
        if deep { clock.set(target); return }
        defer { lock.withLock { depth -= 1 } }
        while true {
            let next = lock.withLock { () -> Event? in
                guard let i = events.indices.min(by: { (events[$0].at, events[$0].seq) < (events[$1].at, events[$1].seq) }),
                      events[i].at <= target else { return nil }
                return events.remove(at: i)
            }
            guard let e = next else { break }
            clock.set(e.at)
            // An event runs on its own: the operation that paused is not what asks for what it does.
            let saved = lock.withLock { () -> ([SimCtx], Int) in
                defer { ctx = []; inUserClick = 0 }
                return (ctx, inUserClick)
            }
            e.run()
            lock.withLock { ctx = saved.0; inUserClick = saved.1 }
        }
        clock.set(target)
    }

    func within<R>(_ c: SimCtx, _ body: () throws -> R) rethrows -> R {
        lock.withLock { ctx.append(c) }
        defer { lock.withLock { _ = ctx.popLast() } }
        return try body()
    }

    // MARK: windows

    func onScreen(_ w: SimWin) -> Bool { w.shown && (w.space == nil || w.space == space1 || w.space == 400) }

    func appWindow(_ pid: pid_t, onSpace s: UInt64? = nil) -> SimWin? {
        wins.values.sorted { $0.id < $1.id }.first { $0.pid == pid && $0.layer == 0 && $0.space != nil && (s == nil || $0.space == s) }
    }

    /// On-screen windows front to back, as the window server lists them.
    func stack() -> [SimWin] {
        let shown = wins.values.filter(onScreen)
        let rank = Dictionary(uniqueKeysWithValues: zOrder.enumerated().map { ($1, $0) })
        return shown.sorted {
            if $0.layer != $1.layer { return $0.layer > $1.layer }
            let a = rank[$0.pid] ?? 999, b = rank[$1.pid] ?? 999
            return a != b ? a < b : $0.id < $1.id
        }
    }

    /// The window a click at `p` reaches (click-through windows are skipped by the window server), or nil (the desktop).
    func clickTarget(at p: CGPoint) -> SimWin? { stack().first { !$0.clickThrough && $0.frame.contains(p) } }

    // MARK: the agent's own record

    func agentBegins(_ pid: pid_t, raise: Bool = false) {
        lock.withLock {
            opsRunning[pid, default: 0] += 1
            agentCause(pid, raise: raise)
        }
    }

    func agentEnds(_ pid: pid_t) {
        lock.withLock {
            opsRunning[pid, default: 1] -= 1
            if opsRunning[pid] == 0 { opsRunning[pid] = nil }
            lastTouchAt[pid] = max(lastTouchAt[pid] ?? -.infinity, now)
        }
    }

    func agentCause(_ pid: pid_t, raise: Bool = false) {
        lock.withLock {
            lateFact(.agentCause)
            lastCauseAt[pid] = now
            lastTouchAt[pid] = max(lastTouchAt[pid] ?? -.infinity, now)
            if raise { raiseAt[pid] = now }
        }
    }

    enum Touch { case yes, no, edge }

    /// Whether the agent touched `pid` recently enough that its coming forward is the agent's doing (the contract's
    /// 1.5 s causal window, or an operation running on it) — from the world's record alone.
    func touched(_ pid: pid_t, at: Double? = nil) -> Touch {
        let t = at ?? now
        if (opsRunning[pid] ?? 0) > 0 { return .yes }
        if visiting, pid == SimPid.visited || pid == visitUserApp { return .yes }
        guard let last = lastTouchAt[pid] else { return .no }
        let d = t - last
        // The causal window is 1.5 s from the cause to when the engine HEARS of the change (its notification, later).
        if d + (at == nil ? nextHearing() : 0) <= 1_420 { return .yes }
        if d >= 1_580 { return .no }
        return .edge
    }

    /// Whether the agent did anything to any app recently (an operation running, or within the causal window).
    func agentRecent(at t: Double) -> Touch {
        if opsRunning.values.contains(where: { $0 > 0 }) || visiting { return .yes }
        let last = lastTouchAt.values.max() ?? -.infinity
        let d = t - last
        if d + nextHearing() <= 1_420 { return .yes }
        if d >= 1_580 { return .no }
        return .edge
    }

    // MARK: the user's input, as the tap sees it

    func hardware(observable: Bool) {
        lock.withLock {
            lastHardwareAt = now
            if observable { lateFact(.hardware); lastObservableHardwareAt = now }
        }
    }

    /// A fact arrived before the engine heard of the last change: its other right answer is added.
    func lateFact(_ f: LateFact) {
        guard let w = widen, w.fact == f, w.episode == episode, now <= w.until else { return }
        widen = nil
        cands.formUnion(w.alt)
        // Another right answer now: what the engine must say is no longer one thing.
        if let o = owedNote, o.episode == episode { owedNote = nil }
        // (No change since that one: what is in front is the app it brought forward.)
        let changed = front
        dueNotes.removeAll { $0.pid == changed }
        stats.ambiguous += 1
        stats.decided -= 1
        stats.ambiguousWhy[w.why, default: 0] += 1
        log("  (\(w.why): the other answer kept too)")
    }

    func press(_ m: CGEventFlags) { let f = lock.withLock { held.insert(m); return held }; flags(f) }
    func release(_ m: CGEventFlags) { let f = lock.withLock { held.remove(m); return held }; flags(f) }

    /// A modifier change: the tap sees it — under Secure Event Input only when it sees the modifiers.
    func flags(_ f: CGEventFlags) {
        let seen = !secure || flagsSeenUnderSecure
        hardware(observable: seen)
        guard seen else { log("    the tap: (nothing — secure input, modifiers unseen)"); return }
        log("    the tap: flags \(f.contains(.maskCommand) ? "⌘" : "")\(f.contains(.maskControl) ? "⌃" : "")\(f.isEmpty ? "none" : "")\(secure ? " (secure input)" : "")")
        core?.noteTapEvent(type: .flagsChanged, sourcePid: 0, userData: 0, flags: f, now: now / 1000)
    }

    /// A key: the tap sees none under Secure Event Input.
    func key(_ type: CGEventType, flags f: CGEventFlags = [], keycode: Int64 = 0) {
        hardware(observable: !secure)
        guard !secure else { return }
        // A key the tap sees (typing — no ⌘/⌃ chord) while an agent target is in front: the contract counts it as work in
        // it (round 10's I6), wherever the key lands (Spotlight's panel too: the engine can't tell).
        if type == .keyDown, !f.contains(.maskCommand), !f.contains(.maskControl) { userInteracted(lock.withLock { front }) }
        core?.noteTapEvent(type: type, sourcePid: 0, userData: 0, flags: f, keycode: keycode, now: now / 1000)
    }

    func gesture(_ raw: UInt32) {
        hardware(observable: true)
        core?.noteTapEvent(type: CGEventType(rawValue: raw)!, sourcePid: 0, userData: 0, now: now / 1000)
    }

    func scrollTap() {
        hardware(observable: true)
        core?.noteTapEvent(type: CGEventType(rawValue: 29)!, sourcePid: 0, userData: 0, now: now / 1000)
        core?.noteTapEvent(type: .scrollWheel, sourcePid: 0, userData: 0, now: now / 1000)
    }

    @discardableResult
    func addSwitch(_ s: SimSwitch) -> Int {
        lock.withLock {
            switches.append(s)
            return switches.count - 1
        }
    }

    /// Two landings of the user's before the engine heard of the first (one change, as far as it can see): it pairs that
    /// change with one of the two inputs, so the other may still explain a change within its life.
    var lastLanding: (index: Int, at: Double)?
    func mergeLandings(_ i: Int) {
        if let l = lastLanding, l.index != i, pendingNotes > 0, now - l.at < 150 {
            switches[l.index].landedAt = nil
            switches[i].landedAt = nil
        }
        lastLanding = (i, now)
    }

    /// A user's switch input that may explain a change of `pid` (an app change and/or a desktop change) now, as far as the
    /// engine can tell: visible to it, alive, not used in truth by the change it was for (it has not landed, or changed
    /// nothing, or landed only just now), fitting.
    func competingSwitch(for pid: pid_t, app: Bool, desktop: Bool, excluding: Int? = nil) -> SimSwitch? {
        let t = now
        let fits = { (i: Int) -> Bool in
            let s = self.switches[i]
            // A click into a window that activated nothing (a drag out of a background window) still claims that app's
            // activation for the claim's window (the contract: the engine can't tell a drag at the mouse-down).
            let dragClaim = s.claim && s.dest == nil && s.target == pid && t - s.at <= 1_500 + self.nextHearing()
            guard i != excluding, s.visible, !s.claim || dragClaim, !s.pending, dragClaim || t - s.at <= s.lifeMs, t >= s.at else { return false }
            if let target = s.target, target != pid { return false }
            return (s.app && app) || (s.desktop && desktop)
        }
        let window = switches.indices.filter(fits)
        // Not used in truth (not landed, or changed nothing, or landed only just now) — or more than one input in the
        // window: the engine pairs inputs with changes oldest first, and may have used another one for that landing.
        if let i = window.reversed().first(where: { switches[$0].landedAt.map { t - $0 <= 150 } ?? true }) { return switches[i] }
        if desktop, let i = window.reversed().first(where: { switches[$0].countlessUntil.map { t <= $0 + self.nextHearing() } ?? false }) {
            return switches[i]
        }
        if window.count >= 2 { return switches[window.last!] }
        return nil
    }

    // MARK: how a change is classified (the world's facts only)

    /// An app the agent never touched coming forward now: the contract's rule on the world's facts (I1 and its indirect
    /// effects, round 9).
    func untouchedCause(_ pid: pid_t, indirect: Bool, why: String, newPlace n: SPlace) -> SimCause {
        let adopt = SimCause.untouched(pid, .adopt, indirect: indirect, why)
        // Back to their place (their own app coming forward again): nothing to undo, nothing to say.
        if !cands.isEmpty, cands.allSatisfy({ $0.place == n }) { return .user(n, "back to their place") }
        // A system dialog is left for the user to answer; any other app is undone.
        let systemUI = isRegularApp(pid) == false
        let notTheirs = SimCause.untouched(pid, systemUI ? .leftAlone : .undone, indirect: indirect, why)
        // The first activation after a launch of the user's own: theirs.
        if let l = userLaunches[pid], now - l < 60_000 { return adopt }
        // During a desktop visit an app coming forward is the visit's (left in front until it ends) — unless a switch input
        // of the user's since the visit began explains it.
        if visiting {
            let left = SimCause.untouched(pid, .leftAlone, indirect: indirect, why + " (during a desktop visit)")
            if let s = competingSwitch(for: pid, app: movedSinceHeard(n).app, desktop: movedSinceHeard(n).desktop), s.at >= visitStartedAt {
                return .either([left, adopt], "a switch input of the user's during a desktop visit")
            }
            return left
        }
        var base: SimCause
        // Round 10 (the user's ruling): sent back only when CLEARLY the agent's — no input of the user's the tap saw in the
        // last 2.5 s, an action of the agent's that can open apps within 1.5 s, no Secure Event Input; otherwise, with the
        // agent active, left in front (never adopted — only their switch input does that), said.
        let left = SimCause.untouched(pid, .leftAlone, indirect: indirect, why + " (not clearly the agent's)")
        let quiet = now - lastObservableHardwareAt, opener = now - lastOpenerAt
        let clearly: Touch = secure ? .no
            : (quiet > 2_600 && opener <= 1_400) ? .yes
            : (quiet < 2_400 || opener > 1_600) ? .no : .edge
        switch agentRecent(at: now) {
        case .no:
            base = clearly == .yes ? notTheirs : adopt
        case .edge:
            base = .either([adopt, left, notTheirs], "at the edge of the causal window")
        case .yes:
            switch clearly {
            case .yes: base = notTheirs
            case .no: base = left
            case .edge: base = .either([left, notTheirs], "at the edge of 'clearly the agent's' (2.5 s quiet, 1.5 s opener)")
            }
        }
        // Heard later: the agent's next action, or the user's input, can tip it either way.
        if case .untouched(_, .adopt, _, _) = base {
            nextWiden = (.agentCause, left, "the agent acted before the engine heard of an untouched app's coming forward")
        } else if case .untouched(_, .undone, _, _) = base {
            nextWiden = (.hardware, left, "input of the user's arrived before the engine heard of an untouched app's coming forward")
        }
        if case .untouched(_, .adopt, _, _) = base { return base }
        if competingSwitch(for: pid, app: movedSinceHeard(n).app, desktop: movedSinceHeard(n).desktop) != nil {
            return .either([base, adopt], "a switch input of the user's it may have been")
        }
        return base
    }

    /// What a change to `n` moved, as the engine judges it — from the last state it HEARD of (a change it has not heard
    /// of yet is folded into this one: the model-based test).
    func movedSinceHeard(_ n: SPlace) -> (app: Bool, desktop: Bool) {
        let prior = unheard.filter { now <= $0.until }.map(\.from)
        return (n.app != front || prior.contains { $0.app != n.app }, n.space != space || prior.contains { $0.space != n.space })
    }

    /// The agent has not touched `pid` (the world's own record).
    func untouched(_ pid: pid_t) -> Bool { touched(pid) == .no && restoreIssuedAt[pid].map { now - $0 >= 950 } ?? true }

    /// An app coming forward by itself now.
    func selfCause(_ pid: pid_t, newPlace n: SPlace) -> SimCause {
        let base: SimCause
        switch touched(pid) {
        case .no:
            // (The contract's restore-late window: 0.8 s after the restore's last attempt, plus the hearing — review of
            // round 9, LOW: it was 2.5 s here.)
            if let r = restoreIssuedAt[pid], now - r < 950 {
                return .either([untouchedCause(pid, indirect: false, why: "on its own", newPlace: n), .agentDirect(pid, "a restore of the engine's toward it")],
                               "it was being restored a moment ago")
            }
            return untouchedCause(pid, indirect: false, why: "on its own", newPlace: n)
        case .edge:
            base = .either([.agentDirect(pid, "at the edge"), untouchedCause(pid, indirect: false, why: "at the edge", newPlace: n)],
                           "at the edge of the causal window")
        case .yes:
            base = .agentDirect(pid, "the agent touched it")
        }
        if let s = competingSwitch(for: pid, app: movedSinceHeard(n).app, desktop: movedSinceHeard(n).desktop) {
            let why = s.secureFlags == true ? "a modifier tap under Secure Event Input, a moment before"
                : s.dest == nil || s.dest == front ? "a switch input of the user's that changed nothing, a moment before"
                : "a switch input of the user's not landed yet"
            return .either([base, .user(n, "taken for their switch")], why)
        }
        return base
    }

    /// The user's own switch landing (their dest coming forward).
    func userLandingCause(_ sw: Int, dest n: SPlace, why: String) -> SimCause {
        let s = switches[sw]
        let mine = SimCause.user(n, why)
        // During a desktop visit: a switch of theirs begun before it, or one into the visited app, lands where the visit
        // takes them or on what it shows — the engine can't tell it from the visit's own (it may return them after).
        if visiting, s.at < visitStartedAt || n.app == SimPid.visited {
            return .either([mine, .engine(.visitThere)], s.at < visitStartedAt ? "a switch of the user's begun before a desktop visit, landing during it"
                                                                          : "the user's switch into the visited app during a desktop visit")
        }
        let touchedDest = touched(n.app) != .no || (n.app == front && n.space != space)
        if !s.visible {
            // Nothing the engine can see: a touched app is undone, an untouched one follows the I1 rule.
            stats.unchecked += 1
            stats.uncheckedWhy["the user's switch under Secure Event Input with the modifiers unseen", default: 0] += 1
            let other: SimCause = touchedDest ? .agentDirect(n.app, "no input it can see")
                : untouchedCause(n.app, indirect: false, why: "no input it can see", newPlace: n)
            return .either([mine, other], "the user's switch under Secure Event Input, modifiers unseen")
        }
        if s.claim { return mine }
        if touchedDest {
            if let r = raiseAt[n.app], r > s.at {
                // The app being held in front (session s2's consented foreground) raised after their input: the engine may
                // take it for the consent's own landing.
                if holding, n.app == SimPid.held {
                    return .either([mine, .engine(.consented(n.app))], "the consented foreground raised it after their input")
                }
                return .either([mine, .agentDirect(n.app, "raised by the agent after their input")], "the agent raised it after their input")
            }
            // Their app stayed in front while the desktop changed, and the agent raised a window shown on the new desktop
            // after their input: that raise may have switched it (the engine can't tell).
            if n.app == front, n.space != space,
               raiseAt.contains(where: { p, r in p != n.app && r > s.at && now - r <= 1_500 && appWindow(p, onSpace: n.space) != nil }) {
                return .either([mine, .agentDirect(n.app, "a window the agent raised after their input is on that desktop")],
                               "the agent raised a window on that desktop after their input")
            }
            if lastOtherChangeAt > s.at || lastUserChangeAt > s.at {
                return .either([mine, .agentDirect(n.app, "their input used by another change")], "another change came between their input and their switch")
            }
        } else if lastOtherChangeAt > s.at {
            // An app that came forward between their input and their switch may have used it: their own untouched app is
            // then judged without it (the input rule).
            let without = untouchedCause(n.app, indirect: false, why: "their input used by another change", newPlace: n)
            if case .untouched(_, .adopt, _, _) = without { return mine }
            return .either([mine, without], "another change came between their input and their switch")
        }
        return mine
    }

    // MARK: the world's changes

    /// Where an activation of `pid` lands: its main window's desktop (macOS follows it there), or `onSpace`.
    func landingPlace(_ pid: pid_t, onSpace: UInt64? = nil) -> SPlace {
        if let onSpace { return SPlace(app: pid, space: onSpace) }
        if let m = mainWin[pid], let w = wins[m], w.shown, let s = w.space { return SPlace(app: pid, space: s) }
        if appWindow(pid, onSpace: space1) != nil { return SPlace(app: pid, space: space1) }
        if let w = appWindow(pid), let s = w.space { return SPlace(app: pid, space: s) }
        return SPlace(app: pid, space: space)
    }

    /// The front app or desktop changes to `n`, for `cause`.
    func change(to n: SPlace, cause: SimCause, why: String) {
        lock.withLock {
            let oldFront = front, oldSpace = space
            if let p = pendingWork, n.app == p.app, now <= p.until { userWorkingIn = p.app; pendingWork = nil }
            if let w = userWorkingIn, n.app != w { userWorkingIn = nil }  // they left the app they were working in
            if n.space == 400 { focusDisplay = 2 } else { focusDisplay = 1; space1 = n.space }
            if let w = appWindow(n.app, onSpace: n.space), mainWin[n.app] != w.id {
                mainWin[n.app] = w.id
                onMainWindow?(n.app, w.id)
            }
            let oldSpace1 = space1
            front = n.app
            keyFocus = n.app
            zOrder.removeAll { $0 == n.app }
            zOrder.insert(n.app, at: 0)
            FocusSPI.frontPid = n.app
            core?.secureInputOverride = secure
            if space != oldSpace { onDesktop?() }
            guard n.app != oldFront || space != oldSpace else { nextWiden = nil; return }
            if case .engine(.consented(let h)) = cause, space1 != oldSpace1 {
                fail("the consented foreground of \(SimPid.name(h)) switched the user's desktop (\(oldSpace1) → \(space1)) — it is only ever on their own desktop")
            }
            let before = cands
            episode += 1
            stats.changes += 1
            if cause.ambiguous {
                stats.ambiguous += 1
                if case .either(_, let w) = cause { stats.ambiguousWhy[w, default: 0] += 1 }
            } else {
                stats.decided += 1
            }
            if case .user = cause { lastUserChangeAt = now } else if case .engine = cause {} else { lastOtherChangeAt = now }
            userLaunches[n.app] = nil  // its first activation, done
            frontCause = cause
            if n.app == SimPid.target { targetForwardDuringOp = true }
            switch cause {
            case .untouched(_, .undone, _, _) where !visiting, .untouched(_, .leftAlone, _, _) where !visiting: owedNote = (n.app, episode, now)
            default: owedNote = nil
            }
            let next = Set(cands.flatMap { transform($0, cause, n: n) })
            cands = next
            if let w = nextWiden {
                let alt = Set(before.flatMap { transform($0, w.alt, n: n) }).subtracting(cands)
                widen = alt.isEmpty ? nil : (episode, now + 450, w.fact, alt, w.why)
            } else {
                widen = nil
            }
            nextWiden = nil
            unheard.removeAll { now > $0.until }
            log("\(why) → \(n) [\(cause)]")
            log("  candidates: \(cands.map(\.description).sorted().joined(separator: " / "))")
            // NSWorkspace's notifications: each kind in order, delayed; the two kinds independent of each other.
            let pid = n.app
            let a = max(drawnNoteDelay ?? noteDelay(), lastActivationNoteAt - now + 0.1)
            drawnNoteDelay = nil
            lastActivationNoteAt = now + a
            pendingNotes += 1
            schedule(after: a, "the activation notification of \(SimPid.name(pid))") { [weak self] in self?.notifyActivation(pid) }
            var heardBy = now + a
            if space != oldSpace {
                let d = max(noteDelay(), lastSpaceNoteAt - now + 0.1)
                lastSpaceNoteAt = now + d
                pendingNotes += 1
                schedule(after: d, "the desktop notification (\(space))") { [weak self] in self?.notifySpace() }
                heardBy = max(heardBy, now + d)
            }
            unheard.append((heardBy, Set(before.map(\.place)), SPlace(app: oldFront, space: oldSpace)))
            scheduleSettle()
        }
    }

    /// The next activation notification's delay, drawn ahead (the classification of a change uses it: the engine judges a
    /// change when it hears of it).
    var drawnNoteDelay: Double?
    /// NSWorkspace's notification delay. Measured (run108, 41 activations): within 0–13 ms of the window server's front
    /// change, the desktop change 6–11 ms — so the default world allows up to 120 ms (~10× the worst seen), reordering the
    /// two kinds; WINTER_CU_SIM_STRESS=1 goes to 400 ms (a busy main queue), reported apart as a stress sweep.
    static let stress = ProcessInfo.processInfo.environment["WINTER_CU_SIM_STRESS"] == "1"
    func noteDelay() -> Double {
        if Self.stress { return rng.chance(0.7) ? rng.double(3, 90) : rng.double(90, 400) }
        return rng.chance(0.85) ? rng.double(1, 20) : rng.double(20, 120)
    }
    func nextHearing() -> Double {
        if let d = drawnNoteDelay { return d }
        let d = max(noteDelay(), lastActivationNoteAt - now + 0.1)
        drawnNoteDelay = d
        return d
    }

    func transform(_ c: SimCand, _ cause: SimCause, n: SPlace) -> [SimCand] {
        switch cause {
        case .user(let d, _):
            return [SimCand(place: d, expected: d, held: nil)]
        case .agentDirect:
            return [SimCand(place: c.place, expected: c.visitPre == nil ? c.place : c.expected, held: c.held, visitPre: c.visitPre)]
        case .untouched(_, .adopt, _, _):
            return [SimCand(place: n, expected: n, held: nil)]
        case .untouched(_, .undone, _, _):
            return [SimCand(place: c.place, expected: c.visitPre == nil ? c.place : c.expected, held: c.held, visitPre: c.visitPre)]
        case .untouched(_, .leftAlone, _, _):
            return [SimCand(place: c.place, expected: n, held: c.held, visitPre: c.visitPre)]
        case .engine(let k):
            switch k {
            case .restore, .giveBack:
                return [SimCand(place: c.place, expected: c.place, held: c.held, visitPre: c.visitPre)]
            case .visitReturn:
                // The way back landing where it was going (their place, or where the visit began): that is where they are
                // now — even over an app that came forward during the way back (the visit's end returns them).
                let back = n.app == c.place.app || n.app == c.visitPre?.app
                return [SimCand(place: c.place, expected: back ? n : c.expected, held: c.held)]
            case .consented(let h):
                return [SimCand(place: n, expected: n, held: SimHeld(app: h, pre: c.held?.pre ?? c.place, preSeen: c.held?.preSeen ?? c.expected))]
            case .visitThere:
                return [SimCand(place: c.place, expected: n, held: c.held, visitPre: c.visitPre ?? c.expected)]
            case .userClick(let d):
                return [SimCand(place: d, expected: d, held: nil)]
            }
        case .either(let options, _):
            return options.flatMap { transform(c, $0, n: n) }
        }
    }

    func notifyActivation(_ pid: pid_t) {
        lock.withLock {
            pendingNotes -= 1
            if let o = owedNote, o.pid == pid, o.episode == episode, front == pid { dueNotes.append((pid, o.at)); owedNote = nil }
        }
        core?.onActivation(pid: pid)
    }

    func notifySpace() {
        lock.withLock { pendingNotes -= 1 }
        core?.onSpaceChange()
    }

    // MARK: the engine asks for an activation

    /// The engine activates `pid` (NSRunningApplication's activate — refusable — or AXFrontmost, or a window brought
    /// forward). Checked at once against every right answer (I2: a restore goes to the user's place), then landed after
    /// macOS's latency (~0.3 s across desktops).
    func engineActivates(_ pid: pid_t, how: String, refusable: Bool) {
        lock.withLock {
            let kind: SimEngineKind
            switch ctx.last {
            case .userClick(let d)?: kind = .userClick(d)
            case .hold(let h)?, .rung4(let h)?: kind = pid == h ? .consented(h) : .giveBack
            case .holdRelease?: kind = .giveBack
            case .visitArrive(let v)?: kind = pid == v ? .visitThere : .visitReturn
            case .visitFinish?: kind = .visitReturn
            case nil: kind = .restore
            }
            stats.restoresChecked += 1
            switch kind {
            case .restore:
                restoreIssuedAt[pid] = now
                if visiting {
                    fail("I5 (#6): the engine restored to \(SimPid.name(pid)) during session s2's desktop visit (\(how)) — a visit's own switch is neither undone nor adopted")
                }
                let ok = cands.filter { $0.place.app == pid }
                let beforeUnheard = unheard.contains(where: { now <= $0.until && $0.places.contains { $0.app == pid } })
                if !ok.isEmpty, beforeUnheard, ok.count < cands.count {
                    // A restore to the place from before a change the engine has not heard of yet: it decides nothing
                    // between that change's right answers (the engine will judge it when it hears of it).
                    stats.activationsOpen += 1
                    stats.activationsOpenWhy["a restore to the place from before a change the engine had not heard of yet", default: 0] += 1
                    log("  (a restore to \(SimPid.name(pid)), the place before a change not heard of yet)")
                } else if !ok.isEmpty {
                    cands = ok
                } else if beforeUnheard {
                    // A change the engine has not heard of yet moved the place: a restore to the one before it is all it can
                    // do now (the world must still settle where the user belongs).
                    stats.activationsOpen += 1
                    stats.activationsOpenWhy["a restore to the place from before a change the engine had not heard of yet", default: 0] += 1
                    log("  (a restore to \(SimPid.name(pid)), the place before a change not heard of yet)")
                } else {
                    fail("I2: the engine restored to \(SimPid.name(pid)) (\(how)), but the user's place is \(Set(cands.map(\.place)).map(\.description).sorted().joined(separator: " or "))")
                }
            case .giveBack:
                restoreIssuedAt[pid] = now  // an activation of the engine's toward it: it may come forward late, by itself
                var next: Set<SimCand> = []
                for c in cands {
                    // Back to where they were before the consented foreground — or, when it never came forward, nowhere new
                    // (only where they are: a give-back must never pull them out of what is in front now).
                    let targets: [SPlace] = c.held.map { [$0.pre, $0.preSeen] } ?? [c.expected]
                    if let t = targets.first(where: { $0.app == pid }) { next.insert(SimCand(place: c.held?.pre ?? c.place, expected: t, held: nil)) }
                }
                if next.isEmpty {
                    fail("I2: the consented foreground gave the front back to \(SimPid.name(pid)) (\(how)), but the user's place is \(Set(cands.map(\.place)).map(\.description).sorted().joined(separator: " or "))")
                } else {
                    cands = next
                }
            case .visitReturn:
                restoreIssuedAt[pid] = now
                // Back to their place, or to what was in front when it began (where they were looking).
                var ok: Set<SimCand> = []
                for c in cands {
                    for t in [c.place, c.visitPre].compactMap({ $0 }) where t.app == pid {
                        ok.insert(SimCand(place: c.place, expected: t, held: c.held, visitPre: c.visitPre))
                    }
                }
                if ok.isEmpty, unheard.contains(where: { now <= $0.until && $0.places.contains { $0.app == pid } }) {
                    // A move of theirs the engine has not heard of yet: the return goes where they were before it.
                    stats.activationsOpen += 1
                    stats.activationsOpenWhy["a visit's return to the place from before a change the engine had not heard of yet", default: 0] += 1
                    log("  (a visit's return to \(SimPid.name(pid)), the place before a change not heard of yet)")
                } else if ok.isEmpty {
                    fail("I2: a desktop visit brought the user back to \(SimPid.name(pid)) (\(how)), but their place is \(Set(cands.map(\.place)).map(\.description).sorted().joined(separator: " or ")) — they moved during it")
                } else {
                    cands = ok
                }
            case .visitThere, .consented:
                // The visit's way there and the consented foreground are the agent's own causes (session s2's).
                agentCause(pid, raise: true)
            case .userClick:
                break
            }
            if refusable, kind != .visitThere, rng.chance(0.35) {
                log("  the engine activates \(SimPid.name(pid)) (\(how), \(kind)) — refused by macOS")
                return
            }
            let target = landingPlace(pid)
            let across = target.space != space && target.space != 400
            let ms: Double = {
                if case .userClick = kind { return rng.double(1, 10) }
                return across ? rng.double(250, 350) : rng.double(2, 20)
            }()
            log("  the engine activates \(SimPid.name(pid)) (\(how), \(kind)) — lands in \(Int(ms)) ms")
            pendingLandings += 1
            schedule(after: ms, "\(SimPid.name(pid))'s activation lands (\(kind))") { [weak self] in
                guard let self else { return }
                self.lock.withLock { self.pendingLandings -= 1 }
                self.land(pid, kind: kind)
            }
        }
    }

    func land(_ pid: pid_t, kind: SimEngineKind) {
        lock.withLock {
            guard running.contains(pid) else { return }
            let n = landingPlace(pid)
            if case .restore = kind, n.app != front || n.space != space { stats.undone += 1 }
            var cause = SimCause.engine(kind)
            // An activation of the engine's landing while a switch of the user's is pending: it may be taken for theirs.
            switch kind {
            case .restore, .giveBack, .visitReturn:
                // Judged by the engine from the last state it HEARD: a change it has not heard of yet (the user's swipe
                // landing 11 ms before) is folded into this one.
                let prior = unheard.filter { now <= $0.until }.map(\.from)
                let appMoved = n.app != front || prior.contains { $0.app != n.app }
                let deskMoved = n.space != space || prior.contains { $0.space != n.space }
                if competingSwitch(for: pid, app: appMoved, desktop: deskMoved) != nil {
                    cause = .either([cause, .user(n, "taken for their switch")], "an activation of the engine's landing while a switch of the user's is pending")
                }
                // The app session s2 holds in front coming forward (a restore of ours landing late) is the consented
                // foreground's while the hold lasts (the contract's rule 9): the hold's end gives the place back.
                if holding, pid == SimPid.held {
                    cause = .either([cause, .engine(.consented(pid))], "the held app came forward while it is held")
                }
            case .userClick(let d) where visiting && d.app == SimPid.visited:
                // Their click into the visited app during a desktop visit: no move away (the contract) — the visit's end
                // may bring them back, or leave them there.
                cause = .either([cause, .engine(.visitThere)], "the user's click into the visited app during a desktop visit")
            default: break
            }
            change(to: n, cause: cause, why: "\(SimPid.name(pid)) activated by the engine (\(kind))")
        }
    }

    // MARK: settling

    func scheduleSettle() {
        settleSeq += 1
        let s = settleSeq
        schedule(after: 1_800, "a settle check") { [weak self] in self?.settleCheck(s, tries: 0) }
    }

    /// Once nothing has changed for a while (no landing, no notification pending, no visit): the world must be where one
    /// right answer says, and the engine's place must be that answer's place (I2, I4).
    func settleCheck(_ s: Int, tries: Int) {
        lock.withLock {
            guard s == settleSeq else { return }
            if pendingLandings > 0 || pendingNotes > 0 || visiting {
                if tries < 20 { schedule(after: 300, "a settle check, again") { [weak self] in self?.settleCheck(s, tries: tries + 1) } }
                return
            }
            settleNow()
        }
    }

    func settleNow() {
        lock.withLock {
            guard violation == nil, let core else { return }
            let w = SPlace(app: front, space: space)
            // A place no activation can bring back exactly (Finder on a desktop where it has no window — the user clicked
            // the empty desktop): any desktop of that app.
            let byWorld = cands.filter { $0.expected == w || ($0.expected.app == w.app && appWindow(w.app, onSpace: $0.expected.space) == nil) }
            if byWorld.isEmpty {
                // Left in front by the agent's own doing: I4; anything else (the user moved away, or brought back over their
                // move): I2.
                fail("\(frontCause.isTheft ? "I4" : "I2"): the world settled at \(w), but it should have settled at \(Set(cands.map(\.expected)).map(\.description).sorted().joined(separator: " or ")) (last change: \(frontCause))")
                return
            }
            cands = byWorld
            let v = core.guardianLock.withLock { core.guardianCore.view }
            let byView = cands.filter {
                $0.place.app == v.app && (v.space == nil || v.space == $0.place.space || appWindow($0.place.app, onSpace: $0.place.space) == nil)
            }
            if byView.isEmpty {
                fail("I2: the engine takes the user's place for \(v.app.map(SimPid.name) ?? "?")@\(v.space.map(String.init) ?? "?"), but it is \(Set(cands.map(\.place)).map(\.description).sorted().joined(separator: " or "))")
                return
            }
            cands = byView
            // An untouched app's coming forward the engine judged while it was in front: said in the next result.
            // (By time, not by name: the engine names an app by its real process when a pid of ours is a real one.)
            // (Once for a burst: the same app coming back within seconds of a note is the same story.)
            for d in dueNotes where notedAt < d.at - 5_000 {
                fail("I1: \(SimPid.name(d.pid)) came forward after the agent's action and the engine did not say so")
                return
            }
            dueNotes = []
            stats.settleChecks += 1
            if case .user = frontCause { stats.userMovesKept += 1 }
            if case .untouched(_, .leftAlone, _, _) = frontCause { stats.leftAlone += 1 }
            log("  settled: \(w), the engine's place \(v.app.map(SimPid.name) ?? "?")@\(v.space.map(String.init) ?? "?") — ok")
        }
    }

    // MARK: the user's keys (I3)

    func userKey(flags f: CGEventFlags = []) {
        key(.keyDown, flags: f)

        lock.withLock {
            let to = keyFocus
            var landed = to
            if to == SimPid.target, installer.isInstalled, let h = installer.handler {
                lastReroute = nil
                let e = keyEvent(stamped: false)
                landed = h(e) != nil ? to : (lastReroute ?? -1)
                stats.userKeysRerouted += 1
                stats.keysChecked += 1
                // During a visit, what is in front may be the visit's or a theft it leaves be: the key may go there too.
                let allowed = cands.filter { $0.expected.app == landed || (visiting && ($0.place.app == landed || front == landed)) }
                if allowed.isEmpty {
                    fail("I3: the user's key went to \(SimPid.name(landed)), but they are at \(Set(cands.map(\.expected)).map(\.description).sorted().joined(separator: " or "))")
                } else {
                    cands = allowed
                }
            } else if to == SimPid.target, front != SimPid.target {
                fail("I3: the user's key went into T with no reroute while T is in the background (the key focus left with it)")
            }
            log("the user's key → \(SimPid.name(landed))")
        }
        key(.keyUp, flags: f)
    }

    // MARK: CUSystemBackend

    func appRunning(_ pid: pid_t) -> Bool { lock.withLock { running.contains(pid) } }
    func bundleId(pid: pid_t) -> String? { lock.withLock { bundles[pid] } }
    func processName(pid: pid_t) -> String? { SimPid.name(pid) }
    func window(id: UInt32) -> CUWindowServerWindow? { lock.withLock { wins[id].map(serverWindow) } }
    func windows(pid: pid_t) -> [CUWindowServerWindow] {
        lock.withLock { wins.values.filter { $0.pid == pid && $0.shown }.sorted { $0.id < $1.id }.map(serverWindow) }
    }
    func serverWindow(_ w: SimWin) -> CUWindowServerWindow {
        CUWindowServerWindow(id: w.id, pid: w.pid, ownerName: w.pid == SimPid.dock ? "Dock" : SimPid.name(w.pid), title: "",
                             frame: w.frame, layer: w.layer, onScreen: onScreen(w), alpha: 1)
    }
    func windowStack() -> [CUWindowServerWindow] { lock.withLock { stack().map(serverWindow) } }
    func moveWindowToActiveSpace(_ id: UInt32) -> Bool { false }
    func frontmostPid() -> pid_t? { lock.withLock { front } }
    func activeSpace() -> UInt64? { lock.withLock { space } }

    func activate(pid: pid_t) -> Bool {
        let forClick = lock.withLock { () -> Bool in if case .userClick? = ctx.last { return true }; return false }
        engineActivates(pid, how: "activate", refusable: !forClick)
        return true
    }

    func bringForward(pid: pid_t, windowID: UInt32, window: AXUIElement?, makeMain: Bool) -> Bool {
        lock.withLock {
            if wins[windowID]?.pid == pid { mainWin[pid] = windowID }
        }
        engineActivates(pid, how: "its window brought forward", refusable: false)
        return true
    }

    /// Accessibility raised a window: its app's main window now (no desktop change by itself).
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
    func windowSpaces(_ id: UInt32) -> Set<UInt64>? {
        lock.withLock { wins[id].map { w in w.space.map { [$0] } ?? [space1, 400] } }
    }
    func displaySpaces() -> [String: UInt64]? { nil }
    func cursorLocation() -> CGPoint? { CGPoint(x: 5, y: 5) }
    func warpCursor(to: CGPoint) {}
    func processAge(pid: pid_t) -> TimeInterval? { lock.withLock { startedAt[pid].map { (now - $0) / 1000 } } }
    func isRegularApp(_ pid: pid_t) -> Bool? {
        ![SimPid.notifications, SimPid.systemUI, SimPid.pip, SimPid.dock, SimPid.coreServices, SimPid.own].contains(pid)
    }
    func runningPid(bundleId: String) -> pid_t? { lock.withLock { bundles.first { $0.value == bundleId }?.key } }
    /// The Dock tile under the pointer: the app the user is clicking in the Dock (the world knows its own Dock).
    var dockTileApp: pid_t?
    func dockItemApp(at point: CGPoint, dockPid: pid_t) -> pid_t? { lock.withLock { dockTileApp } }
}

extension SimPid {
    static let mainCast: [pid_t] = [user, target, third, safari, preview, side, visited, held, notifications, systemUI, pip,
                                    coreServices, dock]
    static let agentTargets: Set<pid_t> = [target, visited, held]
}
