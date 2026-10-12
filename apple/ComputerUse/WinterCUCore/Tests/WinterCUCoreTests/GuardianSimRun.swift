import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

// The honest model-based test's PLAN and RUN: the user's, the apps', session s2's and the agent's (session s1's) steps,
// the real engine wired into the simulated world, a seeded generator, and a delta-debugging minimizer.

enum SimKind {
    // the user
    case click(UInt32)
    case cmdClick(UInt32)
    case drag(UInt32)
    case clickDesktop
    case clickStatusItem
    case clickBanner
    case clickPiP
    case clickPanel
    case clickPrompt
    case dock(pid_t)
    /// ⌘ held `holdMs` (nil: 60–350), the switcher landing `landMs` after the release (nil: 10–70).
    case commandTab(pid_t, tabSeen: Bool, holdMs: Double? = nil, landMs: Double? = nil)
    case commandChord
    case controlArrow(UInt64, seen: Bool)
    case swipe(UInt64)
    case typing(Int)
    case scroll
    case secureEntry(Bool)
    // the apps and the system
    /// The app's main window becomes `window` (it opened or raised one there): its next activation goes there.
    case mainWindow(pid_t, UInt32)
    case selfActivate(pid_t)
    /// Round 10: the user opens a RUNNING app with no switch input (Spotlight, a launcher, a link, `open`): a key, then
    /// it comes forward this many ms later.
    case userOpens(pid_t, Double)
    /// The user launches an app themselves (Spotlight: the keys, then Return); it comes forward `after` ms later.
    case userLaunch(Double)
    case banner(pid_t)
    case prompt(Bool)
    // session s2 (inside the world's events)
    case visit(Double)
    case hold(Double)
    case rung4(Double)
    // session s1: the agent (awaited in turn)
    case agentType(Int)
    /// A click in T on a field, on a LINK (an AX link with its URL: the engine opens it in the background), or on a
    /// button whose action brings S forward `ms` (nil: 150–900) after the act began — an indirect effect no source fix
    /// catches.
    case agentClick(SimClickWhat, ms: Double? = nil)
    /// An AppleScript run in T for `seconds`; `opens`: it opens a file in P (or raises CoreServicesUIAgent's dialog)
    /// `opensMs` in (nil: 200 ms – 1 s).
    case agentAppleScript(Double, opens: Bool, opensMs: Double? = nil, dialog: Bool? = nil)
    case agentBindLaunch(Double)
    /// `count` quick acts on T, `gapMs` apart (nil: 100–300).
    case agentBusy(Int, gapMs: Double? = nil)
    case quiet

    var isAgent: Bool {
        switch self {
        case .agentType, .agentClick, .agentAppleScript, .agentBindLaunch, .agentBusy: return true
        default: return false
        }
    }

    var words: String {
        let n = SimPid.name
        switch self {
        case .click(let w): return "the user clicks window \(w)"
        case .cmdClick(let w): return "the user ⌘-clicks window \(w)"
        case .drag(let w): return "the user drags something out of window \(w)"
        case .clickDesktop: return "the user clicks the empty desktop"
        case .clickStatusItem: return "the user clicks a menu-bar status item"
        case .clickBanner: return "the user clicks the notification banner"
        case .clickPiP: return "the user clicks the Picture in Picture window"
        case .clickPanel: return "the user clicks X's non-activating panel"
        case .clickPrompt: return "the user clicks the helper's prompt panel"
        case .dock(let a): return "the user clicks \(n(a)) in the Dock"
        case .commandTab(let a, let seen, let h, let l):
            return "the user ⌘-Tabs to \(n(a)) (Tab \(seen ? "seen" : "swallowed")\(h.map { ", ⌘ held \(Int($0)) ms" } ?? "")\(l.map { ", lands \(Int($0)) ms after the release" } ?? ""))"
        case .commandChord: return "the user presses ⌘S"
        case .controlArrow(let s, let seen): return "the user ⌃-arrows to desktop \(s) (arrow \(seen ? "seen" : "swallowed"))"
        case .swipe(let s): return "the user swipes to desktop \(s)"
        case .typing(let k): return "the user types \(k) keys"
        case .scroll: return "the user scrolls"
        case .secureEntry(let on): return "Terminal's Secure Keyboard Entry \(on ? "on" : "off")"
        case .mainWindow(let a, let id): return "\(n(a))'s main window becomes \(id)"
        case .selfActivate(let a): return "\(n(a)) activates itself"
        case .userOpens(let a, let ms): return "the user opens \(n(a)) (Spotlight, a launcher, a link — no switch input), it comes forward \(Int(ms)) ms later"
        case .userLaunch(let ms): return "the user launches an app (Spotlight), which comes forward \(Int(ms)) ms later"
        case .banner(let a): return "a notification banner about \(n(a)) appears"
        case .prompt(let on): return "the helper's prompt panel \(on ? "shows" : "hides")"
        case .visit(let ms): return "session s2 visits T2's desktop for \(Int(ms)) ms"
        case .hold(let ms): return "session s2 holds T3 in front for \(Int(ms)) ms"
        case .rung4(let ms): return "session s2 brings T3 forward for one action (rung 4, \(Int(ms)) ms)"
        case .agentType(let k): return "the agent types \(k) characters into T"
        case .agentClick(let what, let ms): return "the agent clicks \(what.rawValue) in T\(what == .opener ? " (S comes forward\(ms.map { " \(Int($0)) ms" } ?? "") after)" : "")"
        case .agentAppleScript(let s, let opens, let ms, _): return "the agent runs an AppleScript in T for \(String(format: "%.1f", s)) s\(opens ? " that opens something\(ms.map { " at \(Int($0)) ms" } ?? "")" : "")"
        case .agentBindLaunch(let ms): return "the agent binds an app it launches (it activates \(Int(ms)) ms in)"
        case .agentBusy(let k, let gap): return "the agent runs \(k) quick acts on T\(gap.map { " \(Int($0)) ms apart" } ?? "")"
        case .quiet: return "nothing (a pause)"
        }
    }
}

struct SimStep {
    var at: Double
    var kind: SimKind
    var seed: UInt64
    var words: String { "\(Int(at)) ms: \(kind.words)" }
}

struct SimPlan {
    var seed: UInt64
    var flagsSeen = true
    var steps: [SimStep]
    /// T's bundle: Finder by default (its acts can open any app); another one makes T's acts open only T, the default
    /// browser (S, Safari) and the mail app — X (Terminal) is then outside every act's reach (round 14's queue item 1).
    var targetBundle = "com.apple.finder"

    /// Hand-authored: steps at fixed times (their random details from `seed`).
    static func scripted(seed: UInt64, flagsSeen: Bool = true, targetBundle: String = "com.apple.finder",
                         _ steps: [(Double, SimKind)]) -> SimPlan {
        var r = SimRNG(seed)
        return SimPlan(seed: seed, flagsSeen: flagsSeen, steps: steps.map { SimStep(at: $0.0, kind: $0.1, seed: r.next()) },
                       targetBundle: targetBundle)
    }

    static func generate(seed: UInt64, count: Int) -> SimPlan {
        var r = SimRNG(seed)
        var t = 300.0
        var steps: [SimStep] = []
        var modsFreeAt = 0.0
        var s2FreeAt = 0.0
        let flagsSeen = r.chance(0.85)
        let windows: [UInt32] = [31, 77, 71, 81, 91, 66, 41, 72, 78, 61]
        let apps: [pid_t] = [SimPid.user, SimPid.target, SimPid.third, SimPid.safari, SimPid.preview, SimPid.side, SimPid.held]
        for _ in 0..<count {
            // A quiet stretch now and then: the world must settle (and is checked).
            t += r.chance(0.1) ? r.double(2_200, 3_200) : r.double(20, 900)
            let k: SimKind
            switch r.int(100) {
            case 0..<10: k = .click(windows[r.int(windows.count)])
            case 10..<11: k = r.chance(0.5) ? .cmdClick(windows[r.int(windows.count)]) : .drag(windows[r.int(windows.count)])
            case 11..<12: k = .clickDesktop
            case 12..<15: k = [.clickStatusItem, .clickBanner, .clickPiP, .clickPanel, .clickPrompt][r.int(5)]
            case 15..<19: k = .dock(apps[r.int(apps.count)])
            case 19..<28: k = .commandTab(apps[r.int(apps.count)], tabSeen: r.chance(0.5))
            case 28..<30: k = .commandChord
            case 30..<34: k = .controlArrow([100, 200, 300][r.int(3)], seen: r.chance(0.5))
            case 34..<37: k = .swipe([100, 200, 300][r.int(3)])
            case 37..<45: k = .typing(1 + r.int(6))
            case 45..<47: k = .scroll
            case 47..<48: k = .secureEntry(r.chance(0.6))
            case 48..<55:
                let who: [pid_t] = [SimPid.target, SimPid.target, SimPid.target, SimPid.target, SimPid.third, SimPid.safari, SimPid.preview, SimPid.user]
                k = .selfActivate(who[r.int(who.count)])
            case 55..<57:
                let who: [pid_t] = [SimPid.third, SimPid.safari, SimPid.preview, SimPid.user]
                k = .userOpens(who[r.int(who.count)], r.double(100, 2_000))
            case 57..<58: k = r.chance(0.5) ? .banner(r.chance(0.6) ? SimPid.target : SimPid.third) : .userLaunch(r.double(300, 3_000))
            case 58..<59: k = .prompt(r.chance(0.5))
            case 59..<62:
                guard t >= s2FreeAt else { k = .quiet; break }
                let ms = r.double(400, 2_500)
                k = [SimKind.visit(ms), .hold(ms), .rung4(r.double(80, 400))][r.int(3)]
                s2FreeAt = t + ms + 600
            case 62..<74: k = .agentType(1 + r.int(8))
            case 74..<81: k = .agentClick([SimClickWhat.field, .field, .link, .opener][r.int(4)])
            case 81..<86: k = .agentAppleScript(r.double(0.2, 4), opens: r.chance(0.3))
            case 86..<88: k = .agentBindLaunch(r.double(30, 3_000))
            default: k = .agentBusy(2 + r.int(6))
            }
            if case .agentType = k, r.chance(0.5) {
                steps.append(SimStep(at: t + r.double(0, 400), kind: .typing(2 + r.int(6)), seed: r.next()))
            }
            var at = t
            switch k {
            case .commandTab, .controlArrow, .commandChord:
                at = max(t, modsFreeAt)
                modsFreeAt = at + 800
            default:
                break
            }
            steps.append(SimStep(at: at, kind: k, seed: r.next()))
        }
        return SimPlan(seed: seed, flagsSeen: flagsSeen, steps: steps)
    }
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
    let visited: CUTarget
    let heldTarget: CUTarget
    let field = fakeElement(97_002)
    let link = fakeElement(97_030)
    let opener = fakeElement(97_031)
    var launchSeq: pid_t = 800
    var userLaunchSeq: pid_t = 0
    var coldSeq: pid_t = 0
    var openVisit: CUOpenVisit?

    var trace: [String] { world.trace }
    var violation: String? { world.violation }
    var stats: SimStats { world.stats }

    init(_ plan: SimPlan) {
        self.plan = plan
        world = SimWorld(clock: clock, seed: plan.seed, flagsSeen: plan.flagsSeen)
        clock.world = world
        world.installer = installer
        let ax = self.ax
        let w = world
        // Accessibility: each app's windows, its focused window; T's window has a field.
        var elements: [UInt32: AXUIElement] = [:]
        var byToken: [String: UInt32] = [:]
        func win(_ id: UInt32, _ pid: pid_t, _ token: Int32) -> AXUIElement {
            let el = fakeElement(token)
            let frame = w.wins[id]?.frame ?? .zero
            ax.add(el, role: kAXWindowRole, title: "\(SimPid.name(pid)) \(id)", frame: frame)
            ax.windowIDs[AXIdentity(element: el)] = id
            elements[id] = el
            byToken["\(token)"] = id
            return el
        }
        let tWindow = win(77, SimPid.target, 97_001)
        ax.put(tWindow, [kAXChildrenAttribute: [field, link, opener]])
        ax.add(link, role: "AXLink", title: "a link", frame: CGRect(x: 520, y: 100, width: 120, height: 20),
               extra: [kAXWindowAttribute: tWindow, "AXURL": URL(string: "https://example.com/page")! as CFURL])
        ax.setActions(link, [kAXPressAction])
        ax.add(opener, role: kAXButtonRole, title: "Open in Safari", frame: CGRect(x: 520, y: 140, width: 120, height: 24),
               extra: [kAXWindowAttribute: tWindow])
        ax.setActions(opener, [kAXPressAction])
        ax.makeSettable(tWindow, kAXMainAttribute)
        ax.add(field, role: kAXTextFieldRole, frame: CGRect(x: 520, y: 60, width: 200, height: 24), extra: [kAXWindowAttribute: tWindow])
        ax.put(ax.application(SimPid.target), [kAXWindowsAttribute: [tWindow]])
        ax.focus(pid: SimPid.target, on: field)
        _ = win(78, SimPid.target, 97_008)
        let vWindow = win(61, SimPid.visited, 97_010)
        ax.put(ax.application(SimPid.visited), [kAXWindowsAttribute: [vWindow], kAXFocusedWindowAttribute: vWindow])
        let hWindow = win(66, SimPid.held, 97_011)
        ax.put(ax.application(SimPid.held), [kAXWindowsAttribute: [hWindow], kAXFocusedWindowAttribute: hWindow])
        for (pid, ids, token) in [(SimPid.user, [UInt32(31)], Int32(97_003)), (SimPid.third, [71, 72], 97_004), (SimPid.safari, [81], 97_012),
                                  (SimPid.preview, [91], 97_014), (SimPid.side, [41], 97_016), (SimPid.coreServices, [761], 97_018)] {
            let els = ids.enumerated().map { win($1, pid, token + Int32($0)) }
            ax.put(ax.application(pid), [kAXFocusedWindowAttribute: els[0], kAXWindowsAttribute: els])
        }
        world.onMainWindow = { pid, id in
            if let el = elements[id], pid != SimPid.target { ax.put(ax.application(pid), [kAXFocusedWindowAttribute: el]) }
        }
        // A window on another desktop is reachable by its id (a remote token: each was shown on the active desktop once).
        ax.remoteWindows = elements
        // Accessibility lists an app's windows on the desktops shown (a window on another Space is not listed — what tells
        // the engine a window is "off this desktop").
        world.onDesktop = {
            var apps: [pid_t: [AXUIElement]] = [:]
            for (id, el) in elements.sorted(by: { $0.key < $1.key }) {
                guard let win = w.wins[id], win.layer == 0 else { continue }
                if w.onScreen(win) { apps[win.pid, default: []].append(el) } else { apps[win.pid, default: []] += [] }
            }
            for (pid, els) in apps { ax.put(ax.application(pid), [kAXWindowsAttribute: els]) }
        }
        ax.onPerform = { what in
            let parts = what.split(separator: ":")
            guard parts.count == 2 else { return }
            // A raise (a restore's or an act's: no cause either way — the engine counts the act itself); an action on an
            // agent target's element: an event of the agent's (the latest its last cause can be).
            if parts[1] == "AXRaise", let id = byToken[String(parts[0])] { w.raised(id) }
            else if let id = byToken[String(parts[0])], let p = w.wins[id]?.pid, SimPid.agentTargets.contains(p) {
                w.lock.withLock { w.lastPostAt = w.now }
            }
        }
        ax.onSet = { what in
            let parts = what.split(separator: ":")
            guard parts.count == 2 else { return }
            if parts[1] == "AXFrontmost", let pid = pid_t(parts[0]) {
                w.engineActivates(pid, how: "AXFrontmost", refusable: false)
            } else if parts[1] == "AXMain", let id = byToken[String(parts[0])] {
                w.raised(id)
                // The agent's main-window write on its target: it can bring the window's desktop forward — a raise of the
                // agent's (the engine counts it so too).
                if let p = w.lock.withLock({ w.wins[id]?.pid }), SimPid.agentTargets.contains(p) { w.agentCause(p, raise: true) }
            }
        }
        core = CUCore(events: nil, clock: clock, skyLight: focusSkyLight(), poster: poster, ax: ax, sys: world,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        world.core = core
        target = CUTarget(id: "tsim", sessionId: "s", pid: SimPid.target, bundleId: plan.targetBundle, appName: "Finder",
                          isChromium: false, mirror: false, windowID: 77, windowTitle: "Docs")
        core.registerForTesting(target, windowElement: tWindow)
        if plan.targetBundle != "com.apple.finder" {
            // T is an ordinary app (round 14's queue item 1): its acts open T, the default browser (S) and the mail app
            // only; X is Terminal — a third party's app, outside every act's reach.
            world.bundles[SimPid.safari] = "com.apple.Safari"
            world.bundles[SimPid.third] = "com.apple.Terminal"
            world.targetScope = [plan.targetBundle, "com.apple.Safari", "com.apple.mail"]
            core.isWebBrowserOverride = { _ in false }
            core.defaultHandlerOverride = { ["http": "com.apple.Safari", "https": "com.apple.Safari", "mailto": "com.apple.mail"][$0] }
        }
        target.refs.beginGeneration()
        visited = CUTarget(id: "t2sim", sessionId: "s2", pid: SimPid.visited, bundleId: "sim.visited", appName: "Visited",
                           isChromium: false, mirror: false, windowID: 61, windowTitle: "Far", privatePath: true)
        core.registerForTesting(visited, windowElement: vWindow)
        heldTarget = CUTarget(id: "t3sim", sessionId: "s2", pid: SimPid.held, bundleId: "sim.held", appName: "Held",
                              isChromium: false, mirror: false, windowID: 66, windowTitle: "Near", privatePath: true)
        core.registerForTesting(heldTarget, windowElement: hWindow)
        core.keyTapInstaller = installer
        core.switchInputObservableOverride = true
        core.secureInputOverride = false
        core.keyFocusPidOverride = { w.lock.withLock { w.keyFocus } }
        core.keyReroutePost = { _, pid in w.lastReroute = pid }
        core.blipSchedule = { ms, work in w.schedule(after: ms, "a focus blip's bound", work) }
        core.guardianTailSchedule = { _, _ in nil }
        // As live: the guardian's restore runs off the observer (a moment later, on its own), the act's late check 300 ms
        // on; a visit the user left closes on its own, too.
        core.guardianRestoreSync = true  // the click's activation of a target stays inline (in its context)
        core.guardianRestoreDispatch = { work in
            let ms = w.lock.withLock { w.rng.double(0, 20) }
            w.schedule(after: ms, "a restore") { work() }
        }
        core.userViewLateCheck = true
        core.lateCheckSchedule = { ms, work in w.schedule(after: ms, "an act's late check") { work() } }
        core.visitSchedule = { _, _ in DispatchWorkItem {} }
        core.visitGraceMs = 600_000
        core.visitCapMs = 600_000
        core.visitArriveMs = 1_500
        // Time passes in the engine's own waits, so the world moves under it.
        core.blipKeySettleMs = 20
        core.blipDrainMs = 30
        core.stepSettleMs = 8
        core.userViewSettleMs = 20
        core.restoreDeadlineMs = 2_000
        core.restoreRetryMs = 120
        core.appleScriptOverride = { _, _ in
            var left = w.lock.withLock { w.scriptMs }
            while left > 0 { let d = min(left, 50); w.advance(by: d); left -= d }
            return "ok"
        }
        core.automationPermissionOverride = { _ in OSStatus(noErr) }
        // T (Finder) is no web browser: a link pressed in it opens in the background (no app comes forward).
        core.isWebBrowserOverride = { _ in false }
        core.openDocumentsOverride = { p in
            w.log("  the engine opens \(p.urls.joined(separator: ", ")) in the background (activates: false — nothing comes forward)")
            w.lock.withLock { w.backgroundOpens += 1 }
            return OpenDocumentsResult(app: CUBoundApp(name: "S", bundleId: "com.apple.Safari", pid: SimPid.safari), windowID: nil)
        }
        let enforcer = FakeFocusEnforcer()
        enforcer.onForce = { w.agentCause(SimPid.target); w.advance(by: 2) }
        enforcer.onDeactivate = { w.agentCause(SimPid.target); w.advance(by: 2) }
        core.focusEnforcerFactory = { _ in enforcer }
        poster.onPost = { e in
            guard e.type == .keyDown || e.type == .leftMouseDown else { return }
            w.lock.withLock {
                w.lastPostAt = w.now
                // A change during this act that brought T forward (by itself, or by the user's own move): at most the one
                // event in flight goes after it (I4).
                guard e.pid == SimPid.target, w.front == SimPid.target, w.episode != w.actEpisode, w.actStartFront != SimPid.target else { return }
                var why: String?
                switch w.frontCause {
                case .agentDirect: why = "after it came forward by itself"
                case .user(let d, _) where d.app == SimPid.target: why = "after the user moved into it"
                case .engine(.userClick): why = "after the user clicked into it"
                default: break
                }
                guard let why else { return }
                w.agentEventsAfterFront += 1
                if w.agentEventsAfterFront > 1 { w.fail("I4: the agent kept sending events to T \(why) (\(w.agentEventsAfterFront) events)") }
            }
            w.log("the agent posts \(e.type == .keyDown ? "a key" : "a click") to \(SimPid.name(e.pid))")
            w.advance(by: e.type == .keyDown ? 45 : 10)
        }
        FocusSPI.reset()
        FocusSPI.frontPid = SimPid.user
        FocusSPI.onFocus = {
            guard let last = FocusSPI.calls.last, last.hasPrefix("focus pid ") else { return }
            let p = pid_t(last.split(separator: " ")[2])!
            w.lock.withLock {
                w.keyFocus = p
                if p == SimPid.target {
                    w.agentCause(SimPid.target)
                } else {
                    // The hand-back: to where the user is.
                    w.stats.keysChecked += 1
                    // (During a visit, what is in front may be the visit's or a theft it leaves be: there too.)
                    let ok = w.cands.filter { $0.expected.app == p || $0.place.app == p || (w.visiting && w.front == p) }
                    if ok.isEmpty {
                        w.fail("I3: the key focus was handed to \(SimPid.name(p)), but the user is at \(Set(w.cands.map(\.expected)).map(\.description).sorted().joined(separator: " or "))")
                    } else {
                        w.cands = ok
                    }
                }
            }
            w.log("focus record → \(SimPid.name(p))")
            w.advance(by: 3)
        }
        core.moveJudged = { [unowned core] path, v, owner in
            w.log("  \(path): front \(SimPid.name(v.front ?? 0)), desktop \(v.space ?? 0) — \(owner.words)")
            if ProcessInfo.processInfo.environment["WINTER_CU_SIM_DEBUG"] == "1" {
                // Diagnostics for a reader of the trace only — never read by the oracle.
                let ins = core.guardianLock.withLock { core.guardianCore.input.instants.map { "\(Int($0.at * 1000 - 1_000_000))\($0.kind == .app ? "a" : "d")\($0.target.map { "→\(SimPid.name($0))" } ?? "")" } }
                let more = core.guardianLock.withLock { core.guardianCore.input.debugState + " | place \(core.guardianCore.view.app.map(SimPid.name) ?? "?")@\(core.guardianCore.view.space ?? 0)" }
                w.log("    (engine instants: \(ins.joined(separator: " ")) \(more))")
            }
            w.lock.withLock {
                // One change, one verdict: a state judged the user's MOVE is never judged the agent's later (their place —
                // nothing moved as far as the engine knew — may be judged again once a late notification shows something
                // came between).
                let key = "\(w.episode):\(v.front ?? 0):\(v.space ?? 0)"
                if case .user = owner { w.judgedUsers.insert(key) } else if case .agent = owner, w.judgedUsers.contains(key) {
                    w.fail("I5: \(path) judged the agent's a state already judged the user's (front \(SimPid.name(v.front ?? 0)), desktop \(v.space ?? 0))")
                }
            }
        }
        core.guardianNoted = { note in w.lock.withLock { w.notes.append(note); w.notedAt = w.now }; w.log("  the guardian says: \(note)") }
        core.visitCloseDispatch = { [unowned self] v, reason in
            w.schedule(after: 1, "the visit closes (\(reason.rawValue))") { self.closeVisit(v, reason) }
        }
        world.onDesktop?()
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
        for step in plan.steps where !step.kind.isAgent {
            world.schedule(after: base + step.at - clock.nowMs(), step.words) { [unowned self] in self.user(step) }
        }
        for step in plan.steps where step.kind.isAgent {
            if world.violation != nil { break }
            world.advance(to: max(clock.nowMs(), base + step.at))
            await agent(step)
        }
        let end = (plan.steps.last?.at ?? 0) + base + 4_000
        world.advance(to: max(end, clock.nowMs() + 4_000))
        if let v = openVisit { closeVisit(v, .requested); world.advance(by: 3_000) }
        world.settleCheck(world.settleSeq, tries: 99)
        core.stopGuardian()
        FocusSPI.onFocus = nil
    }

    // MARK: the user, the apps, the system

    func user(_ step: SimStep) {
        var r = SimRNG(step.seed)
        let w = world
        switch step.kind {
        case .click(let id):
            guard let win = w.lock.withLock({ w.wins[id].flatMap { w.onScreen($0) ? $0 : nil } }) else { return }
            click(at: CGPoint(x: win.frame.midX, y: win.frame.midY + 20), r: &r)
        case .cmdClick(let id):
            guard let win = w.lock.withLock({ w.wins[id].flatMap { w.onScreen($0) ? $0 : nil } }) else { return }
            click(at: CGPoint(x: win.frame.midX, y: win.frame.midY + 20), flags: .maskCommand, r: &r)
        case .drag(let id):
            guard let win = w.lock.withLock({ w.wins[id].flatMap { w.onScreen($0) ? $0 : nil } }) else { return }
            click(at: CGPoint(x: win.frame.midX, y: win.frame.midY + 20), drag: true, r: &r)
        case .clickDesktop: click(at: CGPoint(x: 300, y: 860), r: &r)
        case .clickStatusItem: click(at: CGPoint(x: 1310, y: 10), r: &r)
        case .clickBanner:
            guard w.lock.withLock({ w.wins[701]?.shown == true }) else { return }
            click(at: CGPoint(x: 1450, y: 60), r: &r)
        case .clickPiP: click(at: CGPoint(x: 1400, y: 860), r: &r)
        case .clickPanel:
            guard w.lock.withLock({ w.space1 == 100 }) else { return }
            click(at: CGPoint(x: 1300, y: 470), r: &r)
        case .clickPrompt:
            guard w.lock.withLock({ w.wins[503]?.shown == true }) else { return }
            click(at: CGPoint(x: 780, y: 480), r: &r)
        case .dock(let a):
            w.hardware(observable: true)
            w.log("the user clicks \(SimPid.name(a)) in the Dock")
            core.noteTapEvent(type: .leftMouseDown, sourcePid: 0, userData: 0, now: clock.nowSeconds())
            // A click on that app's Dock tile: input for THAT app, claimed (the contract).
            let i = w.addSwitch(SimSwitch(at: w.now, app: true, desktop: false, target: a, claim: true, dest: a))
            w.lock.withLock { w.dockTileApp = a }
            _ = core.onPhysicalClick(at: CGPoint(x: 800, y: 975), userData: 0, now: clock.nowSeconds())
            w.lock.withLock { w.dockTileApp = nil }
            w.schedule(after: r.double(20, 200), "the Dock activates \(SimPid.name(a))") { [unowned self] in
                self.landSwitch(i, a, why: "the user clicked \(SimPid.name(a)) in the Dock")
            }
        case .commandTab(let a, let tabSeen, let holdMs, let landMs):
            w.press(.maskCommand)
            let secure = w.lock.withLock { w.secure }
            let tabAt = w.now + 30
            // The Tab the tap sees (no secure input then): the switch input is there from it (the engine's instant).
            var tabSwitch: Int?
            if tabSeen, !secure {
                w.schedule(after: 30, "Tab (⌘ held)") {
                    let stillVisible = w.lock.withLock { !w.secure }
                    w.key(.keyDown, flags: .maskCommand, keycode: 48); w.key(.keyUp, flags: .maskCommand, keycode: 48)
                    if stillVisible { tabSwitch = w.addSwitch(SimSwitch(at: w.now, app: true, desktop: false, dest: a, keyboard: true, pending: true)) }
                }
            }
            let hold = holdMs ?? r.double(60, 350)
            let land = landMs ?? r.double(10, 70)
            w.schedule(after: hold, "⌘ released") { [unowned self] in
                let secureNow = w.lock.withLock { w.secure }
                w.release(.maskCommand)
                let seen: Bool? = secureNow ? w.flagsSeenUnderSecure : nil
                // The switcher switches at the release: a Tab seen counts from there when the release is seen (the contract).
                if let t = tabSwitch { w.lock.withLock { if seen != false { w.switches[t].at = w.now }; w.switches[t].pending = false } }
                let at = tabSeen && !secure ? tabAt : w.now
                // A release with no Tab seen explains only a change heard within 0.7 s of it (the contract).
                let i = tabSwitch ?? w.addSwitch(SimSwitch(at: at, app: true, desktop: false, dest: a, secureFlags: seen,
                                                           lifeMs: 700, keyboard: true))
                w.schedule(after: land, "the switcher activates \(SimPid.name(a))") { [unowned self] in
                    self.landSwitch(i, a, why: "the user ⌘-Tabbed to \(SimPid.name(a))")
                }
            }
        case .commandChord:
            w.press(.maskCommand)
            w.schedule(after: 50, "⌘S") { w.userKey(flags: .maskCommand) }
            w.schedule(after: 120, "⌘ released") {
                let secure = w.lock.withLock { w.secure }
                w.release(.maskCommand)
                // Under Secure Event Input the tap saw the modifier but not the S: it looks like a ⌘-Tab's release.
                if secure, w.flagsSeenUnderSecure {
                    w.addSwitch(SimSwitch(at: w.now, app: true, desktop: false, dest: nil, secureFlags: true, lifeMs: 700, keyboard: true))
                }
            }
        case .controlArrow(let s, let seen):
            let secure = w.lock.withLock { w.secure }
            w.press(.maskControl)
            let downAt = w.now
            let releaseAfter = r.double(100, 600)
            var sw = SimSwitch(at: downAt, app: false, desktop: true, dest: nil,
                               secureFlags: secure ? w.flagsSeenUnderSecure : nil, lifeMs: 1_600, keyboard: true)
            // The arrow unseen (swallowed, or Secure Event Input): the engine can't count the desktops the hold passed —
            // every desktop change heard during it and up to 450 ms after its release may be one of them (the contract).
            if !seen || secure {
                sw.countlessUntil = downAt + releaseAfter + 450
                // Its release explains only a change heard within 0.7 s of it (the contract).
                sw.lifeMs = releaseAfter + 700
            }
            let i = w.addSwitch(sw)
            w.schedule(after: 40, "the arrow") {
                if seen, !secure { w.key(.keyDown, flags: .maskControl, keycode: 124); w.key(.keyUp, flags: .maskControl, keycode: 124) }
                w.schedule(after: r.double(150, 400), "the desktop switches") { [unowned self] in
                    self.landDesktop(i, s, why: "the user ⌃-arrowed to desktop \(s)")
                }
            }
            w.schedule(after: releaseAfter, "⌃ released") { w.release(.maskControl) }
        case .swipe(let s):
            w.log("the user swipes")
            w.gesture(31)
            let i = w.addSwitch(SimSwitch(at: w.now, app: false, desktop: true, dest: nil))
            w.schedule(after: r.double(150, 350), "the desktop switches") { [unowned self] in
                self.landDesktop(i, s, why: "the user swiped to desktop \(s)")
            }
        case .typing(let n):
            for k in 0..<n { w.schedule(after: Double(k) * r.double(40, 90), "a key of the user's") { w.userKey() } }
        case .scroll:
            w.scrollTap()
        case .secureEntry(let on):
            w.lock.withLock {
                w.secureEntry = on
                core.secureInputOverride = w.secure
            }
            w.log("Terminal's Secure Keyboard Entry \(on ? "on" : "off")")
        case .userLaunch(let after):
            // Spotlight: ⌘-Space, a few keys, Return (the tap sees them), then the app starts and later comes forward.
            w.press(.maskCommand)
            w.key(.keyDown, flags: .maskCommand, keycode: 49)
            w.release(.maskCommand)
            for k in 0..<3 { w.schedule(after: 60 + Double(k) * 50, "a Spotlight key") { w.key(.keyDown); w.key(.keyUp) } }
            w.schedule(after: 260, "Return") { [unowned self] in
                w.key(.keyDown, keycode: 36)
                let pid = w.lock.withLock { () -> pid_t in
                    self.userLaunchSeq += 1
                    let pid = 950 + self.userLaunchSeq
                    let wid = UInt32(9_500 + Int(pid))
                    w.running.insert(pid)
                    w.bundles[pid] = "sim.user.launched.\(pid)"
                    w.startedAt[pid] = w.now
                    w.wins[wid] = SimWin(id: wid, pid: pid, frame: CGRect(x: 300, y: 600, width: 300, height: 200), space: w.space1)
                    w.mainWin[pid] = wid
                    w.zOrder.append(pid)
                    w.userLaunches[pid] = w.now
                    return pid
                }
                w.log("the user's app \(SimPid.name(pid)) starts")
                w.schedule(after: 30, "NSWorkspace: \(SimPid.name(pid)) launched") { [unowned self] in self.core.onAppLaunched(pid: pid) }
                w.schedule(after: after, "\(SimPid.name(pid)) comes forward (the user's launch)") {
                    w.lock.withLock {
                        let n = w.landingPlace(pid)
                        guard n.app != w.front || n.space != w.space else { return }
                        w.change(to: n, cause: w.untouchedCause(pid, indirect: false, why: "the user's own launch", newPlace: n),
                                 why: "\(SimPid.name(pid)) comes forward (the user launched it)")
                    }
                }
            }
        case .mainWindow(let a, let id):
            w.lock.withLock {
                w.mainWin[a] = id
                w.onMainWindow?(a, id)
            }
            w.log("\(SimPid.name(a))'s main window becomes \(id)")
        case .selfActivate(let a):
            w.lock.withLock {
                // An app already in front does not activate itself again (nothing moves).
                guard w.running.contains(a), a != w.front else { return }
                let n = w.landingPlace(a)
                guard n.app != w.front || n.space != w.space else { return }
                let cause = w.selfCause(a, newPlace: n)
                w.change(to: n, cause: cause, why: "\(SimPid.name(a)) activates itself")
            }
        case .userOpens(let a, let ms):
            // A key of theirs (Return in Spotlight or a launcher; the tap sees it unless Secure Event Input is on), no
            // switch input — the app comes forward later. The contract: never sent back with input of theirs that recent;
            // adopted only when their switch input explains it, else left in front.
            w.log("the user opens \(SimPid.name(a)) (no switch input)")
            w.key(.keyDown, keycode: 36); w.key(.keyUp, keycode: 36)
            w.schedule(after: ms, "\(SimPid.name(a)) comes forward (the user opened it)") {
                w.lock.withLock {
                    guard w.running.contains(a), a != w.front else { return }
                    let n = w.landingPlace(a)
                    guard n.app != w.front || n.space != w.space else { return }
                    let cause = w.untouched(a) ? w.untouchedCause(a, indirect: false, why: "the user opened it", newPlace: n)
                                               : w.selfCause(a, newPlace: n)
                    w.change(to: n, cause: cause, why: "\(SimPid.name(a)) comes forward — the user opened it")
                }
            }
        case .banner(let a):
            w.lock.withLock { w.wins[701]?.shown = true; w.bannerSubject = a }
            w.log("a notification banner about \(SimPid.name(a)) appears")
            w.schedule(after: 5_000, "the banner goes") { w.lock.withLock { w.wins[701]?.shown = false } }
        case .prompt(let on):
            w.lock.withLock { w.wins[503]?.shown = on }
        case .visit(let ms):
            s2Visit(ms)
        case .hold(let ms):
            s2Hold(ms)
        case .rung4(let ms):
            s2Rung4(ms)
        default:
            break
        }
    }

    /// A physical click at `p`: the tap sees it (and the guardian's click handler runs), then the window server delivers
    /// it — activating the app whose window takes it, or nothing (a status item, a banner — whose app activates the
    /// subject a moment later —, Picture in Picture, a non-activating panel, the helper's own panel, a ⌘-click, a drag).
    func click(at p: CGPoint, flags: CGEventFlags = [], drag: Bool = false, r: inout SimRNG) {
        let w = world
        let (hit, dest, sw, subject) = w.lock.withLock { () -> (SimWin?, SPlace?, SimSwitch?, pid_t?) in
            let hit = w.clickTarget(at: p)
            let t = w.now
            guard let h = hit else {
                // The empty desktop: Finder comes forward on this desktop.
                guard p.x < 1600 else { return (nil, nil, nil, nil) }
                let d = SPlace(app: SimPid.target, space: w.space1)
                return (nil, d, SimSwitch(at: t, app: true, desktop: false, target: SimPid.target, claim: true, dest: SimPid.target), nil)
            }
            if h.pid == SimPid.own { return (h, nil, nil, nil) }
            if h.id == 701 {
                return (h, nil, SimSwitch(at: t, app: true, desktop: false, dest: w.bannerSubject), w.bannerSubject)
            }
            if h.layer != 0 { return (h, nil, SimSwitch(at: t, app: true, desktop: false, dest: nil), nil) }
            if flags.contains(.maskCommand) { return (h, nil, nil, nil) }
            let elsewhere = h.space == 400 ? w.focusDisplay != 2 : false
            if drag { return (h, nil, SimSwitch(at: t, app: true, desktop: elsewhere, target: h.pid, claim: true, dest: nil), nil) }
            let d = SPlace(app: h.pid, space: h.space ?? w.space)
            return (h, d, SimSwitch(at: t, app: true, desktop: elsewhere, target: h.pid, claim: true, dest: h.pid), nil)
        }
        w.hardware(observable: true)
        // A click into an agent target's ordinary window (not a ⌘-click): they are working in it (round 10).
        if let h = hit, h.layer == 0, h.pid != SimPid.own, !flags.contains(.maskCommand) { w.userInteracted(h.pid) }
        w.log("the user \(flags.contains(.maskCommand) ? "⌘-" : "")\(drag ? "drags from" : "clicks") (\(Int(p.x)), \(Int(p.y))) — \(hit.map { "\(SimPid.name($0.pid))'s window \($0.id)" } ?? "the desktop")")
        core.noteTapEvent(type: .leftMouseDown, sourcePid: 0, userData: 0, flags: flags, now: clock.nowSeconds())
        let i = sw.map { w.addSwitch($0) }
        let here = w.lock.withLock { SPlace(app: hit?.pid ?? w.front, space: w.space) }
        if drag {
            // A drag brings nothing forward (review of round 9, #8): its button comes up elsewhere, and nothing the engine
            // does in it passes for the user's click (no `userClick` label — that masked the activation on the mouse-down).
            _ = core.onPhysicalClick(at: p, userData: 0, flags: flags, now: clock.nowSeconds())
            core.onPhysicalMouseUp(at: CGPoint(x: p.x + 40, y: p.y + 30), userData: 0, now: clock.nowSeconds())
        } else {
            _ = w.within(.userClick(dest ?? here)) {
                let r = core.onPhysicalClick(at: p, userData: 0, flags: flags, now: clock.nowSeconds())
                core.onPhysicalMouseUp(at: p, userData: 0, now: clock.nowSeconds())
                return r
            }
        }
        if hit?.id == 701 {
            w.lock.withLock { w.wins[701]?.shown = false }
            if let subject, let i {
                w.schedule(after: r.double(100, 300), "Notification Center activates \(SimPid.name(subject))") { [unowned self] in
                    self.landSwitch(i, subject, why: "the user clicked the banner about \(SimPid.name(subject))")
                }
            }
            return
        }
        guard let d = dest, let i else { return }
        w.schedule(after: r.double(1, 15), "the window server activates \(SimPid.name(d.app))") { [unowned self] in
            self.landSwitch(i, d.app, onSpace: d.space, why: "the user clicked into \(SimPid.name(d.app))")
        }
    }

    /// The user's switch `i` lands: `app` comes forward (on `onSpace`, or where its main window is).
    func landSwitch(_ i: Int, _ app: pid_t, onSpace: UInt64? = nil, why: String) {
        let w = world
        w.lock.withLock {
            let n = w.landingPlace(app, onSpace: onSpace)
            guard n.app != w.front || n.space != w.space else {
                // Their switch to what is in front already: it is now their choice — if the engine sees it (it judges
                // nothing new unless a path looks again).
                let cur = SPlace(app: w.front, space: w.space)
                if w.cands.contains(where: { $0.place != cur || $0.held != nil }) {
                    w.cands.formUnion(w.cands.map { _ in SimCand(place: cur, expected: cur, held: nil) })
                    w.log("\(why) — already there, nothing changes (their place may now be \(cur))")
                } else {
                    w.log("\(why) — already there, nothing changes")
                }
                return
            }
            let cause = w.userLandingCause(i, dest: n, why: why)
            // A landing the engine may take for the agent's (the consented foreground, a raise of its own) uses up no input
            // of theirs (the contract: only a verdict of theirs uses one): it may still explain a change within its life.
            if !cause.isTheft { w.switches[i].landedAt = w.now }
            w.mergeLandings(i)
            w.change(to: n, cause: cause, why: why)
        }
    }

    /// The user's desktop switch `i` lands: desktop `s`, the topmost app there in front.
    func landDesktop(_ i: Int, _ s: UInt64, why: String) {
        let w = world
        w.lock.withLock {
            // Already on that desktop: the switch does nothing — it confirms where they are, if the engine looks again.
            guard s != w.space1 || w.focusDisplay != 1 else {
                let cur = SPlace(app: w.front, space: w.space)
                if w.cands.contains(where: { $0.place != cur || $0.held != nil }) {
                    w.cands.formUnion(w.cands.map { _ in SimCand(place: cur, expected: cur, held: nil) })
                    w.log("\(why) — already there (their place may now be \(cur))")
                } else {
                    w.log("\(why) — already there")
                }
                return
            }
            let app = w.zOrder.first { p in w.appWindow(p, onSpace: s) != nil } ?? w.front
            w.switches[i].dest = app
            let n = SPlace(app: app, space: s)
            guard n.app != w.front || n.space != w.space else { return }
            let cause = w.userLandingCause(i, dest: n, why: why)
            if !cause.isTheft { w.switches[i].landedAt = w.now }
            w.mergeLandings(i)
            w.change(to: n, cause: cause, why: why)
        }
    }

    /// The agent's action starts an app that was not running (a link opening the default browser): its process starts
    /// `startAfter` ms later (NSWorkspace's notice 30 ms after, unless missed), and it comes forward `forwardAfter` ms after
    /// its start — the world records whether the start was clearly the agent's (round 11, HIGH #1).
    func coldLaunch(startAfter: Double, forwardAfter: Double, noticed: Bool) {
        let w = world
        w.schedule(after: startAfter, "an app the agent's action opened starts") { [unowned self] in
            let pid = w.lock.withLock { () -> pid_t in
                self.coldSeq += 1
                let pid = 970 + self.coldSeq
                let wid = UInt32(9_700 + Int(pid))
                w.running.insert(pid)
                w.bundles[pid] = "sim.cold.\(pid)"
                w.startedAt[pid] = w.now
                w.wins[wid] = SimWin(id: wid, pid: pid, frame: CGRect(x: 320, y: 620, width: 300, height: 200), space: w.space1)
                w.mainWin[pid] = wid
                w.zOrder.append(pid)
                w.agentColdLaunches[pid] = (w.now, w.clearlyNow(for: pid))
                return pid
            }
            w.log("\(SimPid.name(pid)) starts (the agent's action opened it; clearly the agent's: \(w.lock.withLock { w.agentColdLaunches[pid].map { "\($0.clearly)" } ?? "?" }))")
            if noticed { w.schedule(after: 30, "NSWorkspace: \(SimPid.name(pid)) launched") { [unowned self] in self.core.onAppLaunched(pid: pid) } }
            w.schedule(after: forwardAfter, "\(SimPid.name(pid)) comes forward (the agent's action opened it)") {
                w.lock.withLock {
                    guard w.running.contains(pid), pid != w.front else { return }
                    let n = w.landingPlace(pid)
                    guard n.app != w.front || n.space != w.space else { return }
                    w.change(to: n, cause: w.untouchedCause(pid, indirect: true, why: "what the agent's click opened, freshly launched", newPlace: n),
                             why: "\(SimPid.name(pid)) comes forward — the agent's click launched it")
                    w.indirectSince[pid] = w.now
                }
            }
        }
    }

    /// An app the agent never touched comes forward because of what the agent did (a link it clicked, a file its
    /// AppleScript opened, a dialog its action raised).
    func indirect(_ pid: pid_t, after ms: Double, why: String) {
        let w = world
        w.schedule(after: ms, "\(SimPid.name(pid)) comes forward (\(why))") {
            w.lock.withLock {
                // CoreServicesUIAgent starts on demand: a dialog not on screen is a fresh process (review of round 10,
                // MEDIUM #2 — never "the user's own launch").
                if pid == SimPid.coreServices {
                    if w.wins[761]?.shown != true { w.startedAt[pid] = w.now }
                    w.wins[761]?.shown = true; w.wins[761]?.space = w.space1
                }
                let n = w.landingPlace(pid)
                guard n.app != w.front || n.space != w.space else { return }
                var cause = w.untouchedCause(pid, indirect: true, why: why, newPlace: n)
                // The engine was restoring the user to it a moment ago (their place since moved away): its coming forward
                // may be that restore landing late — the engine can't tell (the contract's restore-late rule, 0.8 s).
                if let r = w.restoreIssuedAt[pid], w.now - r < 950, !w.cands.contains(where: { $0.place.app == pid }) {
                    cause = .either([cause, .agentDirect(pid, "a restore of the engine's toward it, landing late")], "it was being restored a moment ago")
                }
                w.change(to: n, cause: cause, why: "\(SimPid.name(pid)) comes forward — \(why)")
                w.indirectSince[pid] = w.now
            }
        }
    }

    // MARK: session s2 (synchronous, inside the world's events)

    func s2Visit(_ ms: Double) {
        let w = world
        guard !w.lock.withLock({ w.visiting || w.holding }), core.visitLock.withLock({ core.openVisit == nil }) else { return }
        w.lock.withLock { w.visiting = true; w.visitStartedAt = w.now; w.visitUserApp = w.front; w.stats.s2Ops += 1 }
        w.log("— session s2 opens a desktop visit to T2")
        let v = try? w.within(.visitArrive(SimPid.visited)) {
            try core.visitArrive(visited, why: .act, privatePath: true, sessionId: "s2", callId: "v\(w.now)", maxMs: nil, made: VisitBox())
        }
        guard let v else {
            w.log("  the visit did not open (refused, or never arrived)")
            w.lock.withLock {
                w.visiting = false
                // A visit that never arrived brought them back as any visit does: to their place, or to what was in front
                // when it began (a dialog left in front for them to answer).
                w.cands = Set(w.cands.map { c in
                    // (A return that landed set the expectation to where it went; anything still on the visited app is not.)
                    let returned = c.expected.app != SimPid.visited && (c.visitPre == nil || c.expected == c.place || c.expected == c.visitPre)
                    return SimCand(place: c.place, expected: returned ? c.expected : c.place, held: c.held)
                })
                w.scheduleSettle()
            }
            return
        }
        openVisit = v
        w.schedule(after: ms, "session s2's visit closes") { [unowned self] in self.closeVisit(v, .requested) }
    }

    func closeVisit(_ v: CUOpenVisit, _ reason: CUCore.VisitCloseReason) {
        let w = world
        let claimed: Bool = core.visitLock.withLock {
            guard core.openVisit === v, !v.closing else { return false }
            v.closing = true
            return true
        }
        guard claimed else { return }
        w.log("— session s2's visit closes (\(reason.rawValue))")
        let report = w.within(.visitFinish) { core.finishVisit(v, reason: reason) }
        // Its target stays touched for the causal window after it (the engine's visit end says so too).
        w.lock.withLock { w.lastTouchAt[SimPid.visited] = w.now }
        core.recordClosed(v, report)
        if openVisit === v { openVisit = nil }
        w.log("  the visit's report: returned \(report.returned), userMoved \(report.userMoved.map(String.init) ?? "nil")")
        w.lock.withLock {
            w.visiting = false
            // Back where they belong: where a return went (their place, or what was in front when the visit began), else
            // their place.
            w.cands = Set(w.cands.map { c in
                let returned = c.visitPre == nil || c.expected == c.place || c.expected == c.visitPre
                return SimCand(place: c.place, expected: returned ? c.expected : c.place, held: c.held)
            })
            w.scheduleSettle()
        }
    }

    func s2Hold(_ ms: Double) {
        let w = world
        guard !w.lock.withLock({ w.visiting || w.holding }) else { return }
        w.lock.withLock { w.holding = true; w.stats.s2Ops += 1 }
        w.log("— session s2 holds T3 in front")
        let r = w.within(.hold(SimPid.held)) { core.holdForegroundNow(heldTarget) }
        w.log("  the hold: front \(r.front)")
        w.schedule(after: ms, "session s2's script ends (the hold is released)") { [unowned self] in self.s2Release() }
    }

    func s2Release() {
        let w = world
        w.log("— session s2's hold ends")
        w.within(.holdRelease) { core.releaseHeldForeground(sessionId: "s2") }
        afterConsent()
        w.lock.withLock { w.holding = false }
    }

    func s2Rung4(_ ms: Double) {
        let w = world
        guard !w.lock.withLock({ w.visiting || w.holding }) else { return }
        w.lock.withLock { w.stats.s2Ops += 1 }
        w.log("— session s2 brings T3 forward for one action (rung 4)")
        do {
            try w.within(.rung4(SimPid.held)) { try core.inForeground(heldTarget) { w.advance(by: ms) } }
        } catch {
            w.log("  rung 4: \((error as? CUError)?.message ?? "\(error)")")
        }
        afterConsent()
    }

    /// The consented foreground is over: where nothing was given back, the user's place is the one from before it.
    func afterConsent() {
        let w = world
        w.lock.withLock {
            w.cands = Set(w.cands.map { c in
                guard let h = c.held else { return c }
                return SimCand(place: h.pre, expected: c.expected == c.place ? h.pre : c.expected, held: nil)
            })
            w.scheduleSettle()
        }
    }

    // MARK: the agent (session s1)

    func agent(_ step: SimStep) async {
        let w = world
        var r = SimRNG(step.seed)
        let tpid = SimPid.target
        w.lock.withLock {
            w.stats.agentActs += 1
            w.targetForwardDuringOp = false
            w.stepsRetiredAtStart = core.retiredStepsLock.withLock { core.retiredSteps.count }
        }
        w.log("— \(step.kind.words)")
        func act(_ action: CUAction, _ id: String) async {
            // I4 is per act: a change during THIS act that brought T forward.
            w.lock.withLock {
                w.agentEventsAfterFront = 0
                w.actEpisode = w.episode
                w.actStartFront = w.front
            }
            // I6 (round 10): an act on the app the user is working in is refused at once; any other act is not refused for it.
            // A refused act is no operation on the app and no opener act (round 11 — the review of round 10, LOW #9).
            let working = w.userWorks(in: tpid)
            if !working { w.agentBegins(tpid) }
            defer { if !working { w.agentEnds(tpid) } }
            let opener = CUCore.actCanOpenApps(action) && !working
            if opener { w.lock.withLock { w.noteOpener(w.targetScope) } }
            defer { if opener { w.lock.withLock { w.noteOpener(w.targetScope) } } }
            do {
                _ = try await core.targetAct(TargetActParams(targetId: "tsim", sessionId: "s", callId: id, action: action, access: .full,
                                                             allowForeground: false, privatePath: true))
                if working { w.lock.withLock { w.fail("I6: the agent acted on T while the user was working in it (they clicked or typed in it, and it is still in front)") } }
            } catch {
                let e = error as? CUError
                w.log("the act: \(e?.message ?? "\(error)")")
                let refusedForWork = e?.code == "refused" && e?.data?["reason"] == .string("user_working")
                if refusedForWork, !working {
                    w.lock.withLock { w.fail("I6: the act was refused as \"the user is working in it\", but they are not (only switched there, or left it)") }
                } else if refusedForWork {
                    w.lock.withLock { w.stats.handsOff += 1 }
                }
            }
        }
        switch step.kind {
        case .agentType(let n):
            await act(.type(CUTypeAction(text: String(repeating: "x", count: n))), "c\(step.seed)")
        case .agentClick(let what, let ms):
            // (An act refused because the user works in T opens nothing.)
            if what == .opener, !w.userWorks(in: tpid) {
                // (Its own generator, so the seeds' other draws stay as they were.) Sometimes the app it opens was not
                // running: the agent's action cold-launches it (round 11, HIGH #1).
                var c = SimRNG(step.seed ^ 0xC01D_1A57)
                if c.chance(0.3) {
                    coldLaunch(startAfter: c.double(30, 600), forwardAfter: c.double(200, 3_500), noticed: c.chance(0.8))
                } else {
                    indirect(SimPid.safari, after: ms ?? r.double(150, 900), why: "the button the agent clicked in T opened it")
                }
            }
            let el = what == .link ? link : what == .opener ? opener : field
            let ref = target.refs.ref(for: AXIdentity(element: el))
            await act(.click(CUClickAction(ref: ref)), "c\(step.seed)")
        case .agentAppleScript(let seconds, let opens, let ms, let dialog):
            w.lock.withLock { w.scriptMs = seconds * 1000 }
            if opens, !w.userWorks(in: tpid) {  // (a script refused because the user works in T opens nothing)
                let app = (dialog ?? !r.chance(0.7)) ? SimPid.coreServices : SimPid.preview
                indirect(app, after: ms ?? r.double(200, min(1_000, seconds * 1000)), why: "what the agent's AppleScript opened")
            }
            // (Refused at once while the user works in T: no operation on the app, no opener act — as the engine.)
            let working = w.userWorks(in: tpid)
            if !working {
                w.agentBegins(tpid, raise: true)
                w.lock.withLock { w.noteOpener(w.targetScope) }
            }
            defer { if !working { w.agentEnds(tpid); w.lock.withLock { w.noteOpener(w.targetScope) } } }
            do {
                _ = try await core.targetAppleScript(TargetAppleScriptParams(targetId: "tsim", source: "tell application \"Finder\" to get name"))
            } catch { w.log("the script: \((error as? CUError)?.message ?? "\(error)")") }
        case .agentBindLaunch(let after):
            launchSeq += 1
            let pid = launchSeq
            let wid = UInt32(8000 + pid)
            let bundle = "sim.launched.\(pid)"
            w.agentBegins(pid, raise: true)
            w.lock.withLock { w.noteOpener([bundle]) }  // a launch opens the app it launches (round 14: never any app)
            w.lock.withLock {
                w.running.insert(pid)
                w.bundles[pid] = bundle
                w.startedAt[pid] = clock.nowMs()
                w.wins[wid] = SimWin(id: wid, pid: pid, frame: CGRect(x: 200, y: 600, width: 300, height: 200), space: w.space1)
                w.mainWin[pid] = wid
                w.zOrder.append(pid)
            }
            let el = fakeElement(Int32(60_000 + pid))
            ax.add(el, role: kAXWindowRole, title: "New", frame: CGRect(x: 200, y: 600, width: 300, height: 200))
            ax.windowIDs[AXIdentity(element: el)] = wid
            ax.put(ax.application(pid), [kAXWindowsAttribute: [el], kAXFocusedWindowAttribute: el])
            w.schedule(after: after, "\(SimPid.name(pid)) activates itself (its launch)") {
                w.lock.withLock {
                    let n = w.landingPlace(pid)
                    guard n.app != w.front || n.space != w.space else { return }
                    w.change(to: n, cause: w.selfCause(pid, newPlace: n), why: "the launched app activates itself")
                }
            }
            // NSWorkspace says the app launched, a moment in (its bundle was named before: the agent's own launch).
            w.schedule(after: 25, "NSWorkspace: \(SimPid.name(pid)) launched") { [unowned self] in self.core.onAppLaunched(pid: pid) }
            core.resolveBindApp = { _, core in
                core.noteGuardianLaunchBundle(bundle)
                return CUCore.BindApp(pid: pid, bundleIdentifier: bundle, name: "Launched", executableName: "Launched",
                                      isChromium: false, launched: true, running: nil)
            }
            do {
                _ = try await core.targetBind(TargetBindParams(sessionId: "s", app: bundle, mirror: false))
            } catch { w.log("the bind: \((error as? CUError)?.message ?? "\(error)")") }
            w.agentEnds(pid); w.lock.withLock { w.noteOpener([bundle]) }
        case .agentBusy(let n, let gap):
            for k in 0..<n {
                if w.violation != nil { break }
                let ref = target.refs.ref(for: AXIdentity(element: field))
                await act(.click(CUClickAction(ref: ref)), "b\(step.seed)-\(k)")
                w.advance(by: gap ?? r.double(100, 300))
            }
        default:
            break
        }
        // #6: a background step retired only when its own target came forward.
        w.lock.withLock {
            let retired = core.retiredStepsLock.withLock { core.retiredSteps }
            if retired.count > w.stepsRetiredAtStart, !w.targetForwardDuringOp {
                w.fail("I5 (#6): \(retired.map(\.rawValue).sorted().joined(separator: ", ")) retired for the helper's life, though T never came forward during the act")
            }
        }
    }

    // MARK: minimizing

    /// Delta debugging (ddmin) over the steps, keeping the same invariant failing, then one pass over single steps;
    /// bounded in time.
    static func minimize(_ plan: SimPlan) async -> SimPlan {
        let kind = (await execute(plan)).violation.map { String($0.prefix(3)) }
        let deadline = Date().addingTimeInterval(120)
        func fails(_ steps: [SimStep]) async -> Bool {
            guard let v = (await execute(SimPlan(seed: plan.seed, flagsSeen: plan.flagsSeen, steps: steps, targetBundle: plan.targetBundle))).violation else { return false }
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
        return SimPlan(seed: plan.seed, flagsSeen: plan.flagsSeen, steps: cur)
    }
}
