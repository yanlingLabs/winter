import XCTest
@testable import WinterCUCore

/// The launch rule's decision table (PROTOCOL.md §4.12, the user's ruling in round 16): every row reached by a named
/// case, and the ruling's properties over every combination of the facts.
final class LaunchRuleTableTests: XCTestCase {
    private func facts(act: Bool = true, between: Bool = false, launcher: Bool = false, reach: Bool = false, quiet: Bool = false,
                       first: Bool = true, hidden: Bool = false, system: Bool = false, visit: Bool = false,
                       since: Bool = false) -> CULaunchFacts {
        CULaunchFacts(afterAgentAct: act, userInputBetween: between, launcherBefore: launcher, withinReach: reach,
                      quietBeforeStart: quiet, firstSighting: first, keysHidden: hidden, systemUI: system, visit: visit,
                      inputSinceStart: since)
    }

    /// One named case per row, in the table's order: each row is reachable and gives its verdict.
    func testEveryRowIsReachedByItsCase() {
        let cases: [(CULaunchFacts, CULaunchVerdict)] = [
            (facts(reach: true, quiet: true, visit: true), .ordinary),
            (facts(reach: true, quiet: true, first: false), .ordinary),
            (facts(act: false, reach: true, quiet: true), .ordinary),
            (facts(between: true, system: true), .leftAndSaid),
            (facts(between: true, reach: true), .theirs),
            (facts(reach: true, quiet: true), .undo),
            (facts(), .leftAndSaid),
        ]
        XCTAssertEqual(cases.count, CULaunchRule.rows.count, "one case per row")
        // (Row (1)'s other clause, R17-d (ii): an interactive launcher before the start.)
        XCTAssertEqual(CULaunchRule.decide(facts(launcher: true, reach: true)).verdict, .theirs)
        for (i, (f, v)) in cases.enumerated() {
            let d = CULaunchRule.decide(f)
            XCTAssertEqual(d.verdict, v, "row \(i): \(CULaunchRule.rows[i].name)")
            XCTAssertEqual(d.row, CULaunchRule.rows[i].name, "case \(i) is decided by its own row")
        }
    }

    /// The ruling's properties over all 1024 combinations.
    func testTheRulingHoldsForEveryCombination() {
        for f in CULaunchFacts.allCases {
            let v = CULaunchRule.decide(f).verdict
            let inRule = f.afterAgentAct && f.firstSighting && !f.visit
            guard inRule else { XCTAssertEqual(v, .ordinary, "\(f)"); continue }
            // (1) theirs only on their launch-capable input between the act and the start or an interactive launcher before
            // it (R17-d), and never a system dialog.
            let theirInput = f.userInputBetween || f.launcherBefore
            if v == .theirs { XCTAssertTrue(theirInput && !f.systemUI, "\(f)") }
            if theirInput && !f.systemUI { XCTAssertEqual(v, .theirs, "\(f)") }
            // (2) undone only within reach, quiet, keys visible, no input between, never a system dialog: "any reach"
            // never widens undo.
            if v == .undo {
                XCTAssertTrue(f.withinReach && f.quietBeforeStart && !f.keysHidden && !theirInput && !f.systemUI && !f.inputSinceStart, "\(f)")
            }
            if !f.withinReach { XCTAssertNotEqual(v, .undo, "\(f)") }
            // (3) everything else in the rule is left and said — never adopted, never 'ordinary'.
            if !theirInput || f.systemUI { XCTAssertNotEqual(v, .theirs, "\(f)"); XCTAssertNotEqual(v, .ordinary, "\(f)") }
        }
    }

    /// The guardian's never-adopt gate agrees with the table: an opener act right before a start with no input between
    /// is never adopted; input of theirs between makes it theirs.
    func testTheGuardiansGateReadsTheTable() {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 90, space: 1))
        g.noteOpenerCause(now: 10.0, scope: .apps(["com.apple.Safari"]))
        let q = CUMoveQuery(app: 777, space: 1, appStartedAt: 10.2, appBundle: "com.example.third")
        XCTAssertTrue(g.openerBeforeStart(q, now: 10.4), "no input between: never adopted, whatever the reach")
        var h = CUFocusGuardianCore()
        h.begin(view: CUGuardedView(app: 90, space: 1))
        h.noteOpenerCause(now: 10.0, scope: .apps(["com.apple.Safari"]))
        h.noteHardwareAction(now: 10.1)  // typing, a scroll: no launch (R17-d (i))
        XCTAssertTrue(h.openerBeforeStart(q, now: 10.4), "input that can't launch between: still never adopted")
        h.noteLaunchCapableInput(now: 10.1)  // a click, Return, a chord
        XCTAssertFalse(h.openerBeforeStart(q, now: 10.4), "their launch-capable input between: theirs")
    }

    // MARK: the table's real wiring (round 18: the review of round 16 found 6 of 8 facts hard-coded)

    /// The world the fact-flip test starts from: the agent's opener act (reach: the app) at 10.0, the app's process start
    /// at 10.2, no input of the user's, judged at 10.4 — every fact read from the guardian's own records.
    private func world(_ change: (inout CUFocusGuardianCore) -> Void = { _ in }) -> CUFocusGuardianCore {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 90, space: 1))
        g.noteOpenerCause(now: 10.0, scope: .apps(["com.example.new"]))
        change(&g)
        return g
    }
    private func query(systemUI: Bool = false, observable: Bool = true) -> CUMoveQuery {
        CUMoveQuery(app: 777, space: 1, appStartedAt: 10.2, appBundle: "com.example.new", inputObservable: observable,
                    appIsSystemUI: systemUI)
    }

    /// THE FACT-FLIP TEST: for each fact of the table, flipping it IN THE WORLD (the guardian's records — the user's input,
    /// the agent's acts and launches, Secure Event Input, a sighting, a visit, the process) flips that fact alone in the
    /// guardian's `launchVerdict`, and the verdict changes as the table says. A fact hard-coded anywhere fails here.
    func testFlippingEachFactInTheWorldChangesTheVerdictAsTheTableSays() {
        let base = world()
        guard let b = base.launchVerdict(query(), now: 10.4) else { return XCTFail("no verdict for a fresh start") }
        XCTAssertEqual(b.facts, facts(reach: true, quiet: true), "the base world's facts, every one read")
        XCTAssertEqual(b.verdict, .undo)
        let flips: [(fact: String, g: CUFocusGuardianCore, q: CUMoveQuery, now: TimeInterval)] = [
            ("afterAgentAct", { var g = CUFocusGuardianCore(); g.begin(view: CUGuardedView(app: 90, space: 1)); return g }(), query(), 10.4),
            ("userInputBetween", world { $0.noteLaunchCapableInput(now: 10.1) }, query(), 10.4),
            ("launcherBefore", world { $0.noteLauncherInput(now: 10.1) }, query(), 10.4),
            ("withinReach", { var g = CUFocusGuardianCore(); g.begin(view: CUGuardedView(app: 90, space: 1))
                              g.noteOpenerCause(now: 10.0, scope: .apps(["com.other"])); return g }(), query(), 10.4),
            ("quietBeforeStart", world { $0.noteHardwareAction(now: 9.0) }, query(), 10.4),
            ("firstSighting", world { g in _ = g.judge(CUMoveQuery(app: 777, space: 1, appStartedAt: 10.2, appBundle: "com.example.new"), now: 10.4) },
             query(), 12.0),
            ("keysHidden", world { $0.noteSecureInput(true, now: 9.5) }, query(), 10.4),
            ("systemUI", world(), query(systemUI: true), 10.4),
            ("visit", world { $0.beginVisit(app: 4242, now: 10.3) }, query(), 10.4),
            ("inputSinceStart", world { $0.noteHardwareAction(now: 10.3) }, query(), 10.4),
        ]
        XCTAssertEqual(Set(flips.map(\.fact)), Set(CULaunchFacts.names), "every fact flipped")
        for f in flips {
            guard let v = f.g.launchVerdict(f.q, now: f.now) else { XCTFail("\(f.fact): no verdict"); continue }
            var expected = b.facts
            expected[f.fact] = !expected[f.fact]
            // (The reach is that act's: with no act, nothing is within reach.)
            if f.fact == "afterAgentAct" { expected.withinReach = false }
            XCTAssertEqual(v.facts, expected, "\(f.fact): that fact alone flips")
            XCTAssertEqual(v.verdict, CULaunchRule.decide(expected).verdict, "\(f.fact): the table's verdict")
            XCTAssertNotEqual(v.verdict, b.verdict, "\(f.fact): the verdict changes")
        }
        // R18 L4: the same flips through the launch notice's SNAPSHOT of the start's facts (appLaunched), not only the
        // facts read at the judgment.
        for f in flips where !["firstSighting", "systemUI", "visit", "inputSinceStart"].contains(f.fact) {
            var g = f.g
            g.appLaunched(777, startedAt: 10.2, bundle: "com.example.new", now: 10.25)
            guard let v = g.launchVerdict(CUMoveQuery(app: 777, space: 1, appBundle: "com.example.new"), now: f.now) else {
                XCTFail("\(f.fact): no verdict from the snapshot"); continue
            }
            var expected = b.facts
            expected[f.fact] = !expected[f.fact]
            if f.fact == "afterAgentAct" { expected.withinReach = false }
            XCTAssertEqual(v.facts, expected, "\(f.fact) through the snapshot")
        }
        // And no input observable at all hides the keys as Secure Event Input does.
        XCTAssertEqual(base.launchVerdict(query(observable: false), now: 10.4)?.facts.keysHidden, true)
    }

    /// The undo and the adoption decide through the same verdict: (2) — undone and said; (1) — adopted; (3) — left, said;
    /// the gate binds the user's switch input — an untargeted one (a swipe) never adopts, a targeted one (a click on the
    /// app's window) does (R17-d, the controller's ruling).
    func testTheUndoAndTheAdoptionDecideThroughTheTable() {
        func judged(_ change: (inout CUFocusGuardianCore) -> Void) -> CUMoveOwner {
            var g = world(change)
            return g.judge(CUMoveQuery(app: 777, space: 1, appStartedAt: 10.2, appBundle: "com.example.new"), now: 10.4)
        }
        if case .indirect = judged({ _ in }) {} else { XCTFail("(2): undone") }
        XCTAssertTrue(judged { $0.noteLaunchCapableInput(now: 10.1) }.isUsers, "(1): theirs")
        XCTAssertTrue(judged { $0.noteLauncherInput(now: 10.1) }.isUsers, "(1), an interactive launcher: theirs")
        XCTAssertFalse(judged { $0.noteLauncherInput(now: 9.9) }.isUsers, "a launcher BEFORE the act (R18-a): not theirs")
        if case .unexplained = judged({ $0.noteHardwareAction(now: 9.0) }) {} else { XCTFail("(3): left and said") }
        // An untargeted app switch (a click on a status item, a banner, a panel — no known app) after the start: it would
        // explain an untouched app's coming forward, but never adopts under the gate.
        let untargeted = judged { $0.noteHardwareAction(now: 9.0); $0.noteSwitch(now: 10.3, .app) }
        if case .unexplained = untargeted {} else { XCTFail("an untargeted switch under the gate: left — \(untargeted)") }
        // A ⌘ release with no Tab seen: untargeted too.
        let bare = judged { g in
            g.noteHardwareAction(now: 9.0)
            g.inputEvent(type: .flagsChanged, flags: .maskCommand, now: 10.25)
            g.inputEvent(type: .flagsChanged, flags: [], now: 10.35)
        }
        if case .unexplained = bare {} else { XCTFail("a bare ⌘ release under the gate: left — \(bare)") }
        // A click on its window (targeted): theirs.
        XCTAssertTrue(judged { $0.noteHardwareAction(now: 9.0); $0.noteSwitch(now: 10.3, .app, target: 777) }.isUsers,
                      "a targeted switch under the gate: theirs")
        // A ⌘-Tab whose Tab the tap saw, released before the app is heard of: it lands on it — theirs.
        XCTAssertTrue(judged { g in
            g.noteHardwareAction(now: 9.0)
            g.inputEvent(type: .flagsChanged, flags: .maskCommand, now: 10.25)
            g.inputEvent(type: .keyDown, flags: .maskCommand, keycode: 48, now: 10.28)
            g.inputEvent(type: .flagsChanged, flags: [], now: 10.35)
        }.isUsers, "a seen ⌘-Tab under the gate: theirs")
    }
}
