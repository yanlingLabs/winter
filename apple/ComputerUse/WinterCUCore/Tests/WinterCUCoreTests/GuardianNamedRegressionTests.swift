import XCTest
@testable import WinterCUCore

/// NAMED REGRESSION TESTS (the user's process ruling, round 17 — the ratchet; round 18's item 5): each scenario a review
/// or a round's survey found, by the model-based test's seed that reproduced it, as its own test — so a regression names
/// the scenario, not just a seed in a range. Every one passes on the current engine; the ratchet (GuardianModelTests)
/// holds the whole ranges too. The scenarios are worded as the round that fixed them stated them.
final class GuardianNamedRegressionTests: XCTestCase {
    /// Every seed a test below names, with its target (round 19, M3): they run once, all at once, one child process of
    /// this bundle each (the ratchet's runner) — the serial in-process runs took most of the suite's time.
    static let namedSeeds: [(seed: Int, ordinary: Bool)] =
        [1067, 1011, 1038, 1055, 1059, 1049, 1051, 1008, 1063, 1073, 1036, 1020, 1006, 1009, 1024, 1057, 1061, 1043, 10, 1017,
         1047, 3, 19].map { ($0, false) }
        + [26, 33, 35, 51, 54, 36, 49, 58, 12, 14, 22, 32, 50, 3, 19].map { ($0, true) }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var survey: Result<[GuardianModelTests.SurveyKey: String], Error>?

    /// The named seeds' survey, run once per process.
    static func namedSurvey() -> Result<[GuardianModelTests.SurveyKey: String], Error> {
        lock.withLock {
            if let survey { return survey }
            let chunks = namedSeeds.map { (target: $0.ordinary ? "sim.editor" : nil as String?, seeds: $0.seed...$0.seed) }
            let r = Result { try GuardianModelTests.surveyInChildren(chunks, naming: "the named regression tests' seeds") }
            survey = r
            return r
        }
    }

    /// The random test's `seed` (Finder as T, or an ordinary app — round 14's second check) holds: fails naming the
    /// scenario with the violation (run the seed alone with WINTER_CU_SIM_ONLY_SEED for its trace).
    private func holds(_ seed: Int, ordinaryTarget: Bool = false, _ scenario: String, file: StaticString = #filePath, line: UInt = #line) {
        guard Self.namedSeeds.contains(where: { $0.seed == seed && $0.ordinary == ordinaryTarget }) else {
            return XCTFail("seed \(seed) is not in GuardianNamedRegressionTests.namedSeeds", file: file, line: line)
        }
        switch Self.namedSurvey() {
        case .failure(let e):
            XCTFail("the named seeds' survey: \(e)", file: file, line: line)
        case .success(let failing):
            if let v = failing[GuardianModelTests.SurveyKey(target: ordinaryTarget ? "sim.editor" : nil, seed: seed)] {
                XCTFail("REGRESSION — \(scenario) (seed \(seed)\(ordinaryTarget ? ", ordinary target" : "")): \(v)", file: file, line: line)
            }
        }
    }

    // MARK: rounds 13–15

    /// Round 13: a click into the app already in front is input for that app — should the user's desktop move before the
    /// click lands, the app coming back is theirs.
    func testSeed1067_AClickIntoTheAppInFrontIsInputForThatApp() {
        holds(1067, "a click into the app in front, the desktop moving before it lands")
    }

    /// Round 13's pins for the visit exception and the quiet instant.
    func testSeeds1011_1038_1055_1059_TheVisitExceptionAndTheQuietInstant() {
        for s in [1011, 1038, 1055, 1059] { holds(s, "the visit exception and the quiet instant") }
    }

    /// Round 15: the "started right after an opener act" fact holds for every judgment of that app, not only its first
    /// sighting; a left verdict widens when the user's input arrives before the engine heard of the change.
    func testSeeds26_33_35_StartedRightAfterAnOpenerHoldsForEveryJudgment() {
        for s in [26, 33, 35] { holds(s, ordinaryTarget: true, "the opener fact on every judgment of the app") }
    }

    // MARK: round 16

    /// A launch left in front has had its first activation: a later coming forward (a visit's return) is never read as
    /// the first activation of a launch of the user's; a launch notice heard after the first sighting re-arms nothing.
    func testSeed1049_ALeftLaunchIsNeverAdoptedOnALaterComingForward() {
        holds(1049, "a left launch adopted on a later coming forward")
    }

    /// Secure Event Input on at ANY moment of the 2.5 s quiet window is never quiet: the user typed in their Secure
    /// Keyboard Entry Terminal a moment before an app came forward, and the act was undone as clearly the agent's.
    func testSeed1051_SecureEventInputAtAnyMomentOfTheQuietWindowIsNeverQuiet() {
        holds(1051, "Secure Event Input over the quiet window")
    }

    /// The ordinary target: the target stole the front mid-burst, the user's keys went to their app, and the in-flight
    /// check stopped the burst as "the user started working in it" — a key the reroute sends to their place is no work.
    func testSeed51Ordinary_TheReroutesKeyToTheirPlaceIsNoWorkInTheTarget() {
        holds(51, ordinaryTarget: true, "a rerouted key taken for work in the target")
    }

    /// The ordinary target: a drag out of T's window was later taken as "they clicked into its window", and the agent
    /// refused "user working" — a drag's button-down claims nothing.
    func testSeed54Ordinary_ADragOutOfTheTargetsWindowClaimsNothing() {
        holds(54, ordinaryTarget: true, "a drag taken for a click into the target")
    }

    /// Round 16's fixed lists (the default target's and the ordinary target's), each a scenario its round fixed.
    func testRound16sFixedSeeds() {
        for s in [1008, 1063, 1073] { holds(s, "round 16's fixed seed") }
        for s in [36, 49, 58] { holds(s, ordinaryTarget: true, "round 16's fixed seed") }
    }

    // MARK: round 17

    /// R17-a: Secure Event Input on at any moment of the 2.5 s window means "not quiet" — the oracle's reading too.
    func testSeed1036_R17a_SecureEventInputIsReadOverTheWholeWindow() {
        holds(1036, "R17-a — Secure Event Input over the whole quiet window")
    }

    /// R17-b: a click on the FRONT app's Dock tile is their place at the click (the click on T's tile while T was in
    /// front, an earlier restore of P landing 11 ms on, and the engine's place stayed P).
    func testSeed1020_R17b_AClickOnTheFrontAppsDockTileIsTheirPlace() {
        holds(1020, "R17-b — a click on the front app's Dock tile")
    }

    /// R17-b's oracle broke these until the engine took the click on the front app's tile as their place.
    func testR17bSeeds_TheFrontAppsTileOnBothTargets() {
        for s in [1006, 1009, 1024, 1057, 1061] { holds(s, "R17-b — the front app's tile") }
        for s in [12, 14, 22, 32] { holds(s, ordinaryTarget: true, "R17-b — the front app's tile") }
    }

    /// R17-c: "a left app the user types in is their place" holds also after a desktop visit returned them there.
    func testSeed50Ordinary_R17c_TypingInALeftAppAfterAVisitsReturnIsTheirPlace() {
        holds(50, ordinaryTarget: true, "R17-c — typing in a left app after a visit's return")
    }

    /// Round 17's I6 in flight: a restore to T after they had left it is the guardian's, never the act's write; their key
    /// that went to P during a theft of T's is no work in T.
    func testSeed1043_ARestoreToTIsNeverTheActsWriteNorAReroutedKeyWork() {
        holds(1043, "a restore counted as the act's write; a rerouted key counted as work")
    }

    // MARK: round 18 (R17-d)

    /// R17-d: a launch whose only input between the act and the start was a ⌘ release with no key seen is no launch of
    /// theirs; the gated first sighting, judged again a moment later, keeps the table's verdict — never the running app's
    /// "clearly" rule (an app launched 0.5 s after the user's drag, judged quiet 3 s later).
    func testSeed10_R17d_AGatedFirstSightingNeverFallsToClearlyTheAgents() {
        holds(10, "R17-d — a gated first sighting falling to clearlyTheAgents")
    }

    /// R17-d: a launched app that came forward 3 ms before the user's ⌘-Tab release, heard after it — the seen ⌘-Tab
    /// lands on it (a targeted switch).
    func testSeed1017_R17d_ASeenCommandTabReleasedAfterTheLaunchedAppCameForward() {
        holds(1017, "R17-d — a seen ⌘-Tab released as the launched app came forward")
    }

    /// R17-d (ii): a Spotlight launch typed under Secure Keyboard Entry — the tap saw no Return, so nothing can tell it
    /// was theirs: left in front and said.
    func testSeed1047_R17d_ASpotlightLaunchTheTapCouldNotSeeIsLeft() {
        holds(1047, "R17-d (ii) — a Spotlight launch under Secure Event Input")
    }

    /// R17-d: the first sighting is judged as of when the state was first seen — a re-judgment 1.2 s later keeps the gate
    /// (seeds 3 and 19 on both targets; 19: an activation heard late replayed the launched app's state).
    func testSeeds3_19_R17d_TheFirstSightingIsAsOfWhenTheStateWasFirstSeen() {
        for s in [3, 19] {
            holds(s, "R17-d — the first sighting as of the state's first sight")
            holds(s, ordinaryTarget: true, "R17-d — the first sighting as of the state's first sight")
        }
    }

    // MARK: rounds 10–12, as hand-written plans with their trace signatures (round 19, M3)

    /// Runs `steps` over `seeds` (the world's own timing varies by seed); every run must hold, and is returned for its
    /// signature. With WINTER_CU_SIM_TRACES=<dir> every run's trace is written there.
    private func scenario(_ name: String, seeds: ClosedRange<Int> = 1...8, targetBundle: String = "com.apple.finder",
                          _ steps: [(Double, SimKind)], file: StaticString = #filePath, line: UInt = #line) async -> [SimRun] {
        var runs: [SimRun] = []
        for seed in seeds {
            let r = await SimRun.execute(SimPlan.scripted(seed: UInt64(seed), targetBundle: targetBundle, steps))
            GuardianModelTests.saveTrace("named-" + name, seed: seed, r.violation ?? "none", r.trace)
            if let v = r.violation {
                let at = r.trace.firstIndex { $0.hasPrefix("VIOLATION") } ?? r.trace.count
                XCTFail("REGRESSION — \(name) (seed \(seed)): \(v)\n" + r.trace[max(0, at - 50)..<min(r.trace.count, at + 2)].joined(separator: "\n"),
                        file: file, line: line)
            }
            runs.append(r)
        }
        return runs
    }

    /// The trace's lines from the first one containing `from` on.
    private func after(_ r: SimRun, _ from: String) -> ArraySlice<String> {
        guard let i = r.trace.firstIndex(where: { $0.contains(from) }) else { return [] }
        return r.trace[i...]
    }

    /// Round 10's review, HIGH #1 (fixed in round 11): an app the agent's own act COLD-LAUNCHES is not the user's launch —
    /// judged at its process start, sent back when clearly the agent's (no input of theirs for 2.5 s, an opener act, no
    /// secure input). Signature: the app starts as "clearly the agent's", comes forward, and is not in front at the end.
    func testRound10High1_AnAppTheAgentsActColdLaunchesIsSentBack() async {
        let runs = await scenario("r10-high1-cold-launch", seeds: 1...24, [(300, .typing(3)), (3_300, .agentClick(.opener)), (9_000, .quiet)])
        let cold = runs.filter { $0.trace.contains { $0.contains("the agent's action opened it; clearly the agent's: yes") } }
        XCTAssertGreaterThanOrEqual(cold.count, 2, "the plan cold-launched an app clearly the agent's on some seeds")
        for r in cold {
            let since = after(r, "the agent's click launched it")
            XCTAssertTrue(since.contains { $0.contains("the agent's indirect effect: an app the agent's action launched came forward") },
                          r.trace.suffix(60).joined(separator: "\n"))
            XCTAssertTrue(since.contains { $0.contains("came forward after your action and was sent back") }, "said")
            XCTAssertTrue(since.contains { $0.contains("the engine activates U") && $0.contains("a restore") }, "the user put back")
        }
    }

    /// Round 10's review, MEDIUM #2: a system dialog started on demand (CoreServicesUIAgent) by the agent's AppleScript is
    /// never the user's own launch and never sent back — left for them to answer, and said.
    func testRound10Medium2_ASystemDialogStartedOnDemandIsLeftAndSaid() async {
        let runs = await scenario("r10-medium2-system-dialog", [(300, .agentAppleScript(1.5, opens: true, opensMs: 600, dialog: true)), (4_000, .quiet)])
        for r in runs {
            let since = after(r, "comes forward — what the agent's AppleScript opened")
            XCTAssertTrue(since.contains { $0.contains("left alone, not the user's place: a system dialog came up after the agent's action") },
                          r.trace.suffix(60).joined(separator: "\n"))
            XCTAssertTrue(since.contains { $0.contains("(a system dialog) came up after your action — it was left in front for the user") }, "said")
            XCTAssertFalse(since.contains { $0.contains("a restore") }, "never sent back")
        }
    }

    /// Round 10's review, MEDIUM #5 (the pending click): a click of theirs into T's window while another app is in front is
    /// work in T once T's own activation lands — the agent's next act on it is refused, typed.
    func testRound10Medium5_AClickIntoTheTargetIsWorkOnceItsActivationLands() async {
        let runs = await scenario("r10-medium5-pending-click", [(300, .click(77)), (2_000, .agentType(2)), (4_000, .quiet)])
        for r in runs { XCTAssertGreaterThanOrEqual(r.world.stats.handsOff, 1, r.trace.suffix(60).joined(separator: "\n")) }
    }

    /// Round 12's review, MEDIUM #2: the agent's own activation of another app it touched (a blip into B, heard while B is
    /// in front or late, with A back) never ends the user's work in A; an app the agent never touched, brought forward, does.
    /// (Core-level: in the simulated world the user works only in T, and every activation of the agent's there takes T out
    /// of the front — which ends the work by I6's own words; seed-checked by `testRound12Medium2_LeavingTheFrontEndsTheWork`.)
    func testRound12Medium2_TheAgentsOwnActivationNeverEndsTheUsersWork() {
        let a: pid_t = 500, b: pid_t = 600, c: pid_t = 700
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: a, space: 100))
        g.userInteracted(a, front: a, now: 10)
        g.noteCause(b, now: 10.2)
        g.otherAppActivated(b, front: b, now: 10.25)  // heard while B is in front
        g.otherAppActivated(b, front: a, now: 10.4)   // and late, A back in front
        XCTAssertTrue(g.userIsWorking(in: a, front: a, now: 10.5), "the agent's own activation ended nothing")
        g.otherAppActivated(c, front: c, now: 20)     // an app the agent never touched: they went there
        XCTAssertFalse(g.userIsWorking(in: a, front: a, now: 21), "another app's activation ended it")
    }

    /// The simulated world's side of it: session s2's rung 4 takes T (where the user typed) out of the front and gives it
    /// back — T left the front, so the work there is over (I6): the next act on T is NOT refused, and no invariant breaks.
    func testRound12Medium2_LeavingTheFrontEndsTheWork() async {
        let runs = await scenario("r12-medium2-rung4", [(300, .commandTab(SimPid.target, tabSeen: true)), (1_000, .typing(3)),
                                                        (1_500, .rung4(200)), (2_600, .agentType(2)), (4_500, .quiet)])
        for r in runs {
            XCTAssertEqual(r.world.stats.handsOff, 0, r.trace.suffix(60).joined(separator: "\n"))
            XCTAssertTrue(r.trace.contains { $0.contains("a give-back after the consented foreground") }, "rung 4 gave T back")
        }
    }

    /// Round 12's review, its LOW (the keys carry the process they go to): a key is work in T only when it reaches T — typed
    /// while T is in front, the act is refused; typed while their own app is in front (T in the background), it is not.
    func testRound12Low_AKeyIsWorkOnlyInTheAppItReaches() async {
        let inT = await scenario("r12-low-key-in-t", [(300, .commandTab(SimPid.target, tabSeen: true)), (1_000, .typing(3)), (1_600, .agentType(2)), (4_000, .quiet)])
        for r in inT { XCTAssertGreaterThanOrEqual(r.world.stats.handsOff, 1, r.trace.suffix(60).joined(separator: "\n")) }
        let elsewhere = await scenario("r12-low-key-elsewhere", [(300, .typing(3)), (900, .agentType(2)), (3_500, .quiet)])
        for r in elsewhere { XCTAssertEqual(r.world.stats.handsOff, 0, r.trace.suffix(60).joined(separator: "\n")) }
    }

    /// Round 11's review, LOW #10: a launch notice heard long after the process started judges nothing "clearly" (the facts
    /// from its start are gone) — the same launch heard on time is undone. (Core-level: the simulated world draws its notice
    /// delays within NSWorkspace's measured latency and has no step that delays one by seconds.)
    func testRound11Low10_ALateLaunchNoticeJudgesNothingClearly() {
        for (heardAt, undoes) in [(20.45, true), (32.0, false)] {
            var g = CUFocusGuardianCore()
            g.begin(view: CUGuardedView(app: 1, space: 100))
            g.noteCause(500, now: 20)
            g.noteOpenerCause(now: 20)
            g.appLaunched(906, startedAt: 20.4, now: heardAt)
            let o = g.judge(CUMoveQuery(app: 906, space: 100, appStartedAt: 20.4), now: max(heardAt + 0.5, 23))
            XCTAssertEqual(o.undoes, undoes, "the notice heard at \(heardAt): \(o)")
            XCTAssertFalse(o.isUsers, "never adopted: \(o)")
        }
    }

    /// R18-a's Finder legs (round 19; the review of round 19, MEDIUM 2 — the test must DISCRIMINATE): the agent presses a link in
    /// T (Finder: its act reaches any app), the user double-clicks an item in Finder's window, then the agent's bind
    /// launches an app of its own (an opener act reaching only that app), and an app of the user's starts 350 ms after
    /// the double-click. No input of theirs came between the agent's LATEST act and the start, so the launch rule's (1)
    /// is decided by the interactive launcher alone — after the latest act that reaches the app (R18-a): an application or
    /// a document makes the launch THEIRS (adopted); a folder launches nothing and is no launcher — the app is left in
    /// front and said, never adopted.
    func testR18a_TheFinderLegsOfTheInteractiveLauncher() async {
        func legs(_ item: Int) async -> [SimRun] {
            await scenario("r18a-finder-leg-\(item)", [(300, .typing(2)), (3_000, .agentClick(.link)),
                                                       (3_800, .finderLaunch(item, startAfter: 350, forwardAfter: 600)),
                                                       (3_950, .agentBindLaunch(5_000)), (9_000, .quiet)])
        }
        func verdicts(_ runs: [SimRun]) -> [String] {
            runs.map { r in
                r.trace.first { $0.contains("UL1 activated: front UL1") }.map { $0.contains("— the user's:") ? "theirs" : $0.contains("left alone") ? "left" : "other: " + $0 } ?? "never seen"
            }
        }
        for item in [0, 1] {
            let v = verdicts(await legs(item))
            XCTAssertEqual(Set(v), ["theirs"], "a double-click on \(["an application", "a document"][item]) launches: their launch — \(v)")
        }
        let folder = verdicts(await legs(2))
        XCTAssertEqual(Set(folder), ["left"], "a folder launches nothing and is no launcher: left in front and said — \(folder)")
    }

    /// The review of round 19, H1, in the simulated world: the user clicks T's background window (the helper brings it,
    /// T@100 lands — theirs); 400 ms later the agent's act in flight raises T's window on desktop 300 and macOS moves
    /// there — the agent's (I4: undone), never "the window they clicked into", which counts only on the clicked window's
    /// desktop, once, and never after a raise of the agent's since the click.
    func testH1_TheClicksBringNeverCoversTheAgentsRaiseOnAnotherDesktop() async {
        let runs = await scenario("r19-h1-bring-other-desktop", seeds: 1...12, [(300, .agentBusy(8, gapMs: 60)), (500, .click(77)),
                                                                              (900, .targetRaisedOnItsOtherDesktop), (4_000, .quiet)])
        XCTAssertTrue(runs.allSatisfy { $0.trace.contains { $0.contains("raises T's window on desktop 300 → T@300") } }, "the raise happened")
    }
}
