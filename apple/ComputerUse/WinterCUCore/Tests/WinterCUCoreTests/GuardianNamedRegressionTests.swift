import XCTest
@testable import WinterCUCore

/// NAMED REGRESSION TESTS (the user's process ruling, round 17 — the ratchet; round 18's item 5): each scenario a review
/// or a round's survey found, by the model-based test's seed that reproduced it, as its own test — so a regression names
/// the scenario, not just a seed in a range. Every one passes on the current engine; the ratchet (GuardianModelTests)
/// holds the whole ranges too. The scenarios are worded as the round that fixed them stated them.
final class GuardianNamedRegressionTests: XCTestCase {
    /// Runs the random test's `seed` (Finder as T, or an ordinary app — round 14's second check) and fails with the trace
    /// around the violation.
    private func holds(_ seed: Int, ordinaryTarget: Bool = false, _ scenario: String, file: StaticString = #filePath, line: UInt = #line) async {
        var plan = SimPlan.generate(seed: UInt64(seed), count: GuardianModelTests.steps)
        if ordinaryTarget { plan.targetBundle = "sim.editor" }
        let run = await SimRun.execute(plan)
        if let v = run.violation {
            let at = run.trace.firstIndex { $0.hasPrefix("VIOLATION") } ?? run.trace.count
            XCTFail("REGRESSION — \(scenario) (seed \(seed)\(ordinaryTarget ? ", ordinary target" : "")): \(v)\n"
                    + run.trace[max(0, at - 60)..<min(run.trace.count, at + 2)].joined(separator: "\n"), file: file, line: line)
        }
    }

    // MARK: rounds 13–15

    /// Round 13: a click into the app already in front is input for that app — should the user's desktop move before the
    /// click lands, the app coming back is theirs.
    func testSeed1067_AClickIntoTheAppInFrontIsInputForThatApp() async {
        await holds(1067, "a click into the app in front, the desktop moving before it lands")
    }

    /// Round 13's pins for the visit exception and the quiet instant.
    func testSeeds1011_1038_1055_1059_TheVisitExceptionAndTheQuietInstant() async {
        for s in [1011, 1038, 1055, 1059] { await holds(s, "the visit exception and the quiet instant") }
    }

    /// Round 15: the "started right after an opener act" fact holds for every judgment of that app, not only its first
    /// sighting; a left verdict widens when the user's input arrives before the engine heard of the change.
    func testSeeds26_33_35_StartedRightAfterAnOpenerHoldsForEveryJudgment() async {
        for s in [26, 33, 35] { await holds(s, ordinaryTarget: true, "the opener fact on every judgment of the app") }
    }

    // MARK: round 16

    /// A launch left in front has had its first activation: a later coming forward (a visit's return) is never read as
    /// the first activation of a launch of the user's; a launch notice heard after the first sighting re-arms nothing.
    func testSeed1049_ALeftLaunchIsNeverAdoptedOnALaterComingForward() async {
        await holds(1049, "a left launch adopted on a later coming forward")
    }

    /// Secure Event Input on at ANY moment of the 2.5 s quiet window is never quiet: the user typed in their Secure
    /// Keyboard Entry Terminal a moment before an app came forward, and the act was undone as clearly the agent's.
    func testSeed1051_SecureEventInputAtAnyMomentOfTheQuietWindowIsNeverQuiet() async {
        await holds(1051, "Secure Event Input over the quiet window")
    }

    /// The ordinary target: the target stole the front mid-burst, the user's keys went to their app, and the in-flight
    /// check stopped the burst as "the user started working in it" — a key the reroute sends to their place is no work.
    func testSeed51Ordinary_TheReroutesKeyToTheirPlaceIsNoWorkInTheTarget() async {
        await holds(51, ordinaryTarget: true, "a rerouted key taken for work in the target")
    }

    /// The ordinary target: a drag out of T's window was later taken as "they clicked into its window", and the agent
    /// refused "user working" — a drag's button-down claims nothing.
    func testSeed54Ordinary_ADragOutOfTheTargetsWindowClaimsNothing() async {
        await holds(54, ordinaryTarget: true, "a drag taken for a click into the target")
    }

    /// Round 16's fixed lists (the default target's and the ordinary target's), each a scenario its round fixed.
    func testRound16sFixedSeeds() async {
        for s in [1008, 1063, 1073] { await holds(s, "round 16's fixed seed") }
        for s in [36, 49, 58] { await holds(s, ordinaryTarget: true, "round 16's fixed seed") }
    }

    // MARK: round 17

    /// R17-a: Secure Event Input on at any moment of the 2.5 s window means "not quiet" — the oracle's reading too.
    func testSeed1036_R17a_SecureEventInputIsReadOverTheWholeWindow() async {
        await holds(1036, "R17-a — Secure Event Input over the whole quiet window")
    }

    /// R17-b: a click on the FRONT app's Dock tile is their place at the click (the click on T's tile while T was in
    /// front, an earlier restore of P landing 11 ms on, and the engine's place stayed P).
    func testSeed1020_R17b_AClickOnTheFrontAppsDockTileIsTheirPlace() async {
        await holds(1020, "R17-b — a click on the front app's Dock tile")
    }

    /// R17-b's oracle broke these until the engine took the click on the front app's tile as their place.
    func testR17bSeeds_TheFrontAppsTileOnBothTargets() async {
        for s in [1006, 1009, 1024, 1057, 1061] { await holds(s, "R17-b — the front app's tile") }
        for s in [12, 14, 22, 32] { await holds(s, ordinaryTarget: true, "R17-b — the front app's tile") }
    }

    /// R17-c: "a left app the user types in is their place" holds also after a desktop visit returned them there.
    func testSeed50Ordinary_R17c_TypingInALeftAppAfterAVisitsReturnIsTheirPlace() async {
        await holds(50, ordinaryTarget: true, "R17-c — typing in a left app after a visit's return")
    }

    /// Round 17's I6 in flight: a restore to T after they had left it is the guardian's, never the act's write; their key
    /// that went to P during a theft of T's is no work in T.
    func testSeed1043_ARestoreToTIsNeverTheActsWriteNorAReroutedKeyWork() async {
        await holds(1043, "a restore counted as the act's write; a rerouted key counted as work")
    }

    // MARK: round 18 (R17-d)

    /// R17-d: a launch whose only input between the act and the start was a ⌘ release with no key seen is no launch of
    /// theirs; the gated first sighting, judged again a moment later, keeps the table's verdict — never the running app's
    /// "clearly" rule (an app launched 0.5 s after the user's drag, judged quiet 3 s later).
    func testSeed10_R17d_AGatedFirstSightingNeverFallsToClearlyTheAgents() async {
        await holds(10, "R17-d — a gated first sighting falling to clearlyTheAgents")
    }

    /// R17-d: a launched app that came forward 3 ms before the user's ⌘-Tab release, heard after it — the seen ⌘-Tab
    /// lands on it (a targeted switch).
    func testSeed1017_R17d_ASeenCommandTabReleasedAfterTheLaunchedAppCameForward() async {
        await holds(1017, "R17-d — a seen ⌘-Tab released as the launched app came forward")
    }

    /// R17-d (ii): a Spotlight launch typed under Secure Keyboard Entry — the tap saw no Return, so nothing can tell it
    /// was theirs: left in front and said.
    func testSeed1047_R17d_ASpotlightLaunchTheTapCouldNotSeeIsLeft() async {
        await holds(1047, "R17-d (ii) — a Spotlight launch under Secure Event Input")
    }

    /// R17-d: the first sighting is judged as of when the state was first seen — a re-judgment 1.2 s later keeps the gate
    /// (seeds 3 and 19 on both targets; 19: an activation heard late replayed the launched app's state).
    func testSeeds3_19_R17d_TheFirstSightingIsAsOfWhenTheStateWasFirstSeen() async {
        for s in [3, 19] {
            await holds(s, "R17-d — the first sighting as of the state's first sight")
            await holds(s, ordinaryTarget: true, "R17-d — the first sighting as of the state's first sight")
        }
    }
}
