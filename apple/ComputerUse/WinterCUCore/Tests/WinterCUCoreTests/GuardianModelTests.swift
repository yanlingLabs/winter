import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// The guardian's MODEL-BASED test (round 9: honest). The real engine — the one rule, the observers and their async
/// restores, the focus blip and its keyboard reroute, a background click's preparation, the act's after-check and late
/// check, a bind that launches, an AppleScript that runs for seconds, session s2's desktop visits, held foreground and
/// rung 4 — driven in SIMULATED time over a simulated Mac (GuardianSim.swift), with seeded random interleavings of the
/// user's actions, the apps' own and the agent's. The oracle decides what is right from the WORLD's own record of who
/// caused each change — never from the engine — and checks, at every engine activation, every user key and every
/// settled moment, PROTOCOL.md §4.12's invariants:
/// - I1/I2: a restore goes to the user's place (one they chose, or an app the agent never touched brought them to with
///   input of theirs — never an app the agent's action brought forward with none), nothing activates over a move of
///   theirs, a visit's return never pulls them back from where they went, and the world settles where they belong;
/// - I3: their keys reach where they are, and a key-focus hand-back never goes to an app they left;
/// - I4: a touched app that came forward by itself is undone, and the agent stops sending it events;
/// - I5: one change, one verdict; a desktop visit or the consented foreground is never undone by another path, and a
///   background step is retired only when its own target came forward.
/// Where the contract leaves more than one right answer (the engine can't see the difference by design), every one is
/// kept and the engine is held to the one it takes; the share is reported. A failure prints the seed and a minimized list
/// of steps.
final class GuardianModelTests: XCTestCase {
    static let seeds = Int(ProcessInfo.processInfo.environment["WINTER_CU_SIM_SEEDS"] ?? "") ?? 20
    static let steps = Int(ProcessInfo.processInfo.environment["WINTER_CU_SIM_STEPS"] ?? "") ?? 250
    /// WINTER_CU_SIM_SURVEY=1: every seed runs to its first violation, none minimized, and they are counted (a report).
    static let survey = ProcessInfo.processInfo.environment["WINTER_CU_SIM_SURVEY"] == "1"

    func testTheInvariantsHoldOverRandomInterleavings() async throws {
        var totals = SimStats()
        var surveyed = 0
        let only = Int(ProcessInfo.processInfo.environment["WINTER_CU_SIM_ONLY_SEED"] ?? "")
        // WINTER_CU_SIM_FIRST_SEED: a sweep of seeds first…first+seeds−1 (a long run in parallel processes).
        let first = Int(ProcessInfo.processInfo.environment["WINTER_CU_SIM_FIRST_SEED"] ?? "") ?? 1
        for seed in only.map({ [$0] }) ?? Array(first..<(first + Self.seeds)) {
            let plan = SimPlan.generate(seed: UInt64(seed), count: Self.steps)
            let run = await SimRun.execute(plan)
            totals.add(run.stats)
            if let v = run.violation, Self.survey {
                let at = run.trace.firstIndex { $0.hasPrefix("VIOLATION") } ?? run.trace.count
                print("SURVEY seed \(seed): \(v)")
                Self.saveTrace("random", seed: seed, v, Array(run.trace[max(0, at - 150)..<min(run.trace.count, at + 2)]))
                surveyed += 1
                continue
            }
            if let v = run.violation, only != nil {
                let at = run.trace.firstIndex { $0.hasPrefix("VIOLATION") } ?? run.trace.count
                XCTFail("seed \(seed) (modifiers under secure input \(plan.flagsSeen ? "seen" : "unseen")): \(v)\n\(run.trace[max(0, at - 90)..<min(run.trace.count, at + 4)].joined(separator: "\n"))")
                return
            }
            if let v = run.violation {
                let minimal = await SimRun.minimize(plan)
                XCTFail("""
                    seed \(seed): \(v)
                    minimized to \(minimal.steps.count) of \(plan.steps.count) steps:
                    \(minimal.steps.map { "  " + $0.words }.joined(separator: "\n"))
                    trace of the minimized run:
                    \((await SimRun.execute(minimal)).trace.suffix(80).joined(separator: "\n"))
                    """)
                return
            }
        }
        print("guardian model: \(Self.seeds) seeds × \(Self.steps) steps — \(totals.words)")
        if Self.survey {
            print("SURVEY: \(surveyed) of \(Self.seeds) seeds found a violation (each run stops at its first)")
            return
        }
        XCTAssertGreaterThan(totals.settleChecks, 0)
        XCTAssertGreaterThan(totals.restoresChecked, 0)
        XCTAssertGreaterThan(totals.userKeysRerouted, 0, "the user's keys met the reroute")
        XCTAssertGreaterThan(totals.undone, 0, "thefts were undone")
        XCTAssertGreaterThan(totals.userMovesKept, 0, "user moves were kept")
        XCTAssertGreaterThan(totals.s2Ops, 0, "session s2 ran")
        XCTAssertLessThan(Double(totals.unchecked), Double(totals.changes) * 0.05, "unchecked: \(totals.words)")
    }

    /// Seeds KNOWN to fail (round 11's first item), pinned so CI meets them: each must still fail (an expected failure,
    /// shown as such), and a seed that passes is reported, to come off the list.
    static let knownFailing: [(seed: Int, what: String)] = [
        (338, "I3: a user key reached T with no reroute while T was in the background (a blip ending during a theft)"),
        (508, "I2: the engine's place U, the user's P — Secure Event Input with the modifiers unseen"),
        (556, "I2: the engine's place U, the user's X — Secure Event Input with the modifiers unseen"),
        // Round 11's sweep of seeds 1000–1079 (each failed on round 10's engine too; 10 more of its failures are gone):
        (1011, "I3: the key focus handed to T2 (a visit's return) while the user is at an app the agent launched, on desktop 200"),
        (1018, "I4: settled at U, should be X@200 — an untouched U sent back as the agent's indirect effect after the user moved"),
        (1022, "I2: the engine's place T@200, the user's T@100 — the same app on two desktops"),
        (1038, "I3: the key focus handed to T2 (a visit's return) while the user is at S"),
        (1055, "I3: the key focus handed to T2 (a visit's return) while the user is at the held app T3"),
        (1059, "I3: the key focus handed to T2 (a visit's return) while the user is at X@200"),
        (1067, "I2: the engine's place T2@300 (the visited app), the user's X@200"),
    ]

    func testKnownFailingSeedsAreStillKnown() async {
        for (seed, what) in Self.knownFailing {
            let r = await SimRun.execute(SimPlan.generate(seed: UInt64(seed), count: Self.steps))
            if let v = r.violation {
                XCTExpectFailure("KNOWN, round 12: seed \(seed) — \(what)", strict: true) { XCTFail("seed \(seed): \(v)") }
            } else {
                XCTFail("seed \(seed) passes now — take it off GuardianModelTests.knownFailing")
            }
        }
    }

    // MARK: the reviewer's findings, as plans (each over a dozen seeds: the world's own timing varies)

    /// Runs `plan` with seeds 1…`seeds`; returns the first violation (with its trace) or nil.
    func run(_ name: String, seeds: Int = 12, flagsSeen: Bool = true, _ steps: [(Double, SimKind)]) async -> String? {
        for seed in 1...seeds {
            let r = await SimRun.execute(SimPlan.scripted(seed: UInt64(seed), flagsSeen: flagsSeen, steps))
            if ProcessInfo.processInfo.environment["WINTER_CU_SIM_TRACE_ALL"] == "1" { Self.saveTrace(name + "-ok", seed: seed, r.violation ?? "none", r.trace) }
            if let v = r.violation {
                let at = r.trace.firstIndex { $0.hasPrefix("VIOLATION") } ?? r.trace.count
                let trace = r.trace[max(0, at - 70)..<min(r.trace.count, at + 2)].joined(separator: "\n")
                Self.saveTrace(name, seed: seed, v, r.trace)
                return "\(name), seed \(seed): \(v)\n\(trace)"
            }
        }
        return nil
    }

    /// With WINTER_CU_SIM_TRACES=<dir>, every failing scenario's whole trace is written there.
    static func saveTrace(_ name: String, seed: Int, _ violation: String, _ trace: [String]) {
        guard let dir = ProcessInfo.processInfo.environment["WINTER_CU_SIM_TRACES"] else { return }
        let url = URL(fileURLWithPath: dir).appendingPathComponent("\(name)-seed\(seed).txt")
        try? (["\(name), seed \(seed): \(violation)", ""] + trace).joined(separator: "\n").write(to: url, atomically: true, encoding: .utf8)
    }

    /// #1: the user clicks into T's window while the helper's own click-through cursor overlay covers it ("take over from
    /// the agent") — their move.
    func testAClickIntoTheTargetUnderTheHelpersOverlayIsTheUsers() async {
        let v = await run("f1-overlay-click", [(300, .agentType(3)), (900, .click(77)), (3_500, .quiet)])
        XCTAssertNil(v, v ?? "")
    }

    /// #2 (the user's ruling: blocked at the source): a link the agent clicks in an app that is not a web browser opens in
    /// the background — nothing comes forward.
    /// Round 10 (the user's ruling from the hands-on test): once the user WORKS in the target (a click into its window, a
    /// key while it is in front) the agent is hands-off it — every act refused at once, typed — until it leaves the front;
    /// merely switching there to look blocks nothing (I6, checked on every act of the random test too).
    func testTheAgentIsHandsOffAnAppTheUserIsWorkingIn() async {
        for seed in 1...8 {
            let r = await SimRun.execute(SimPlan.scripted(seed: UInt64(seed), [
                (300, .commandTab(SimPid.target, tabSeen: true)), (1_000, .agentType(2)),   // only looking: not blocked
                (1_600, .click(77)), (1_900, .agentType(2)),                                 // clicked into it: refused
                (2_500, .typing(3)), (2_900, .agentType(2)),                                 // typing in it: refused
                (3_400, .commandTab(SimPid.user, tabSeen: true)), (4_300, .agentType(2)),    // left it: acts again
                (6_500, .quiet)]))
            XCTAssertNil(r.violation, "seed \(seed): \(r.violation ?? "")\n\(r.trace.suffix(40).joined(separator: "\n"))")
            XCTAssertGreaterThanOrEqual(r.world.stats.handsOff, 2, "seed \(seed): the acts while they worked in it were refused")
        }
    }

    func testALinkTheAgentClickedOpensInTheBackground() async {
        for seed in 1...6 {
            let r = await SimRun.execute(SimPlan.scripted(seed: UInt64(seed), [(300, .agentClick(.link)), (3_000, .quiet)]))
            XCTAssertNil(r.violation, r.violation ?? "")
            XCTAssertEqual(r.world.backgroundOpens, 1, "opened in the background")
            XCTAssertFalse(r.trace.contains { $0.contains("S@") }, "S never came forward")
        }
    }

    /// #2 (the user's ruling: the rest undone): what a button the agent clicked brought forward (an app it never touched,
    /// with no input of the user's since) is sent back at once, the user's place unchanged, and said; a later theft is put
    /// back to THEIR app.
    func testWhatTheAgentsClickBroughtForwardIsSentBack() async {
        let v = await run("f2-opener", [(300, .agentClick(.opener, ms: 400)), (3_000, .agentType(3)), (3_400, .selfActivate(SimPid.target)),
                                        (6_500, .quiet)])
        XCTAssertNil(v, v ?? "")
    }

    /// #2: what the agent's AppleScript opened in Preview: sent back, said.
    func testWhatTheAgentsAppleScriptOpenedIsSentBack() async {
        let v = await run("f2-applescript-open", [(300, .agentAppleScript(1.5, opens: true, opensMs: 600, dialog: false)), (4_000, .quiet)])
        XCTAssertNil(v, v ?? "")
    }

    /// #2: a system dialog (CoreServicesUIAgent) the agent's AppleScript raised is never sent back — the user must be able
    /// to answer it — and it is said.
    func testASystemDialogTheAgentRaisedIsLeftForTheUser() async {
        let v = await run("f2-system-dialog", [(300, .agentAppleScript(1.5, opens: true, opensMs: 600, dialog: true)), (4_000, .quiet)])
        XCTAssertNil(v, v ?? "")
    }

    /// #2, the other side: the user's own app, launched from Spotlight, comes forward for the first time right after an
    /// act of the agent's (no input of theirs since) — theirs, never sent back.
    func testTheUsersOwnLaunchIsNeverSentBack() async {
        let v = await run("f2-user-launch", [(300, .userLaunch(2_700)), (3_000, .agentType(2)), (6_500, .quiet)])
        XCTAssertNil(v, v ?? "")
    }

    /// #2: an already-running app the agent never touched coming forward right after its act, no input of the user's
    /// since: the agent's indirect effect — sent back (the old answer, "the user's", is gone).
    func testARunningAppAfterAnActWithNoInputIsSentBack() async {
        let v = await run("f2-running-app", [(300, .typing(5)), (3_300, .agentType(2)), (3_600, .selfActivate(SimPid.third)), (6_500, .quiet)])
        XCTAssertNil(v, v ?? "")
    }

    /// #3: a click on a status item (or Picture in Picture, or a non-activating panel) switches nothing: a theft right
    /// after is put back to the user's app — never "back" to the status item's process.
    func testAClickOnTheMenuBarOrPiPIsNoPlace() async {
        for (name, click) in [("f3-status-item", SimKind.clickStatusItem), ("f3-pip", .clickPiP), ("f3-panel", .clickPanel)] {
            let v = await run(name, [(300, .agentType(3)), (600, click), (900, .selfActivate(SimPid.target)), (4_000, .quiet)])
            XCTAssertNil(v, v ?? "")
        }
    }

    /// #3: a drag out of X's window in the background activates nothing: a theft right after goes back to the user's app.
    func testADragOutOfABackgroundWindowIsNoMove() async {
        let v = await run("f3-drag", [(300, .agentType(3)), (600, .drag(71)), (800, .selfActivate(SimPid.target)), (4_000, .quiet)])
        XCTAssertNil(v, v ?? "")
    }

    /// #3: clicking a notification about T brings T forward on the user's behalf: theirs.
    func testClickingANotificationOfTheTargetIsTheUsersMove() async {
        let v = await run("f3-banner", [(200, .banner(SimPid.target)), (300, .agentType(3)), (900, .clickBanner), (3_500, .quiet)])
        XCTAssertNil(v, v ?? "")
    }

    /// LOW: a click on the empty desktop brings Finder (the bound target) forward: the user's.
    func testAClickOnTheEmptyDesktopIsTheUsersMoveIntoFinder() async {
        let v = await run("low-desktop-click", [(300, .agentType(3)), (900, .clickDesktop), (3_500, .quiet)])
        XCTAssertNil(v, v ?? "")
    }

    /// #4: the user ⌘-Tabs to X; T, touched, activates itself after X landed — their switch explains X, not T: undone.
    func testOneSwitchInputExplainsOneChange() async {
        let v = await run("f4-one-input-one-change", [(300, .agentType(3)), (800, .commandTab(SimPid.third, tabSeen: false, holdMs: 120, landMs: 30)),
                                                      (1_300, .selfActivate(SimPid.target)), (4_000, .quiet)])
        XCTAssertNil(v, v ?? "")
    }

    /// #5: T steals the front onto its own desktop; the guardian's restore of U takes ~0.3 s to land across desktops; the
    /// user ⌘-Tabs to X meanwhile — the late landing of U is the restore's, never the user's: X is put back.
    func testALateRestoreNeverOverridesTheUsersMove() async {
        let v = await run("f5-late-restore", seeds: 16, [(300, .agentType(3)), (700, .mainWindow(SimPid.target, 78)), (800, .selfActivate(SimPid.target)),
                                                         (1_000, .commandTab(SimPid.third, tabSeen: false, holdMs: 100, landMs: 30)), (4_500, .quiet)])
        XCTAssertNil(v, v ?? "")
    }

    /// #6: session s2 opens a desktop visit while session s1's act runs: s1's paths never undo the visit's switch, and
    /// never retire a background step for it.
    func testAnotherSessionsVisitIsNeverUndoneByAnAct() async {
        let v = await run("f6-visit-during-act", [(300, .agentType(20)), (420, .visit(1_500)), (5_000, .quiet)])
        XCTAssertNil(v, v ?? "")
    }

    /// #6: session s2 holds T3 in front while session s1's act runs.
    func testAnotherSessionsHoldIsNeverUndoneByAnAct() async {
        let v = await run("f6-hold-during-act", [(300, .agentType(20)), (450, .hold(1_500)), (5_000, .quiet)])
        XCTAssertNil(v, v ?? "")
    }

    /// #7: under Secure Event Input (Terminal's Secure Keyboard Entry), the user ⌘-Tabs into T: the tap sees the ⌘ hold
    /// and its release (measured, run107) but not the Tab — their move.
    func testACommandTabUnderSecureInputIsTheUsers() async {
        let v = await run("f7-secure-command-tab", [(100, .secureEntry(true)), (300, .agentType(3)),
                                                    (900, .commandTab(SimPid.target, tabSeen: false, holdMs: 150, landMs: 40)), (3_500, .quiet)])
        XCTAssertNil(v, v ?? "")
    }

    /// #8: a busy script acts on T every ~0.1 s; the user ⌘-Tabs into T and the next act begins 20 ms after their release,
    /// 50 ms before the switcher's activation lands — an act's (non-raising) cause never makes their move the agent's.
    func testABusyScriptNeverOutranksTheUsersSwitch() async {
        let v = await run("f8-busy-script", [(300, .agentBusy(6, gapMs: 60)), (800, .commandTab(SimPid.target, tabSeen: false, holdMs: 100, landMs: 70)),
                                             (920, .agentClick(.field)), (5_000, .quiet)])
        XCTAssertNil(v, v ?? "")
    }

    /// LOW: the held app's give-back never pulls the user out of it once they moved into it themselves.
    func testTheHoldsGiveBackNeverOverridesTheUsersMove() async {
        let v = await run("low-hold-give-back", [(300, .hold(3_000)), (1_000, .click(71)), (1_600, .click(66)), (6_000, .quiet)])
        XCTAssertNil(v, v ?? "")
    }
}
