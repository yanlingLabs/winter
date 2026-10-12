import XCTest
@testable import WinterCUCore

/// The launch rule's decision table (PROTOCOL.md §4.12, the user's ruling in round 16): every row reached by a named
/// case, and the ruling's properties over every combination of the facts.
final class LaunchRuleTableTests: XCTestCase {
    private func facts(act: Bool = true, between: Bool = false, reach: Bool = false, quiet: Bool = false, first: Bool = true,
                       hidden: Bool = false, system: Bool = false, visit: Bool = false) -> CULaunchFacts {
        CULaunchFacts(afterAgentAct: act, userInputBetween: between, withinReach: reach, quietBeforeStart: quiet,
                      firstSighting: first, keysHidden: hidden, systemUI: system, visit: visit)
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
        for (i, (f, v)) in cases.enumerated() {
            let d = CULaunchRule.decide(f)
            XCTAssertEqual(d.verdict, v, "row \(i): \(CULaunchRule.rows[i].name)")
            XCTAssertEqual(d.row, CULaunchRule.rows[i].name, "case \(i) is decided by its own row")
        }
    }

    /// The ruling's properties over all 256 combinations.
    func testTheRulingHoldsForEveryCombination() {
        for f in CULaunchFacts.allCases {
            let v = CULaunchRule.decide(f).verdict
            let inRule = f.afterAgentAct && f.firstSighting && !f.visit
            guard inRule else { XCTAssertEqual(v, .ordinary, "\(f)"); continue }
            // (1) theirs only on their input between the act and the start, and never a system dialog.
            if v == .theirs { XCTAssertTrue(f.userInputBetween && !f.systemUI, "\(f)") }
            if f.userInputBetween && !f.systemUI { XCTAssertEqual(v, .theirs, "\(f)") }
            // (2) undone only within reach, quiet, keys visible, no input between, never a system dialog: "any reach"
            // never widens undo.
            if v == .undo {
                XCTAssertTrue(f.withinReach && f.quietBeforeStart && !f.keysHidden && !f.userInputBetween && !f.systemUI, "\(f)")
            }
            if !f.withinReach { XCTAssertNotEqual(v, .undo, "\(f)") }
            // (3) everything else in the rule is left and said — never adopted, never 'ordinary'.
            if !f.userInputBetween || f.systemUI { XCTAssertNotEqual(v, .theirs, "\(f)"); XCTAssertNotEqual(v, .ordinary, "\(f)") }
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
        h.noteHardwareAction(now: 10.1)
        XCTAssertFalse(h.openerBeforeStart(q, now: 10.4), "their input between: theirs")
    }
}
