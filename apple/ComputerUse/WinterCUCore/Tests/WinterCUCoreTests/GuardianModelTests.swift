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
/// THE FROZEN REFERENCE (the user's process ruling, round 17): this oracle — GuardianSim*, GuardianSimRun, these
/// expectation lists — and its world's fakes (FakeAX, RecordingPoster, the fakes' user key) change only in commits of their
/// own, each citing a ruling, never together with engine code; the ratchet below holds the whole surveyed ranges.
final class GuardianModelTests: XCTestCase {
    static let seeds = Int(ProcessInfo.processInfo.environment["WINTER_CU_SIM_SEEDS"] ?? "") ?? 20
    static let steps = Int(ProcessInfo.processInfo.environment["WINTER_CU_SIM_STEPS"] ?? "") ?? 250
    /// WINTER_CU_SIM_SURVEY=1: every seed runs to its first violation, none minimized, and they are counted (a report).
    static let survey = ProcessInfo.processInfo.environment["WINTER_CU_SIM_SURVEY"] == "1"
    /// WINTER_CU_SIM_TARGET=<bundle id>: T is that app instead of Finder — its acts open only T, the default browser and
    /// the mail app (round 14's queue item 1).
    static let targetBundle = ProcessInfo.processInfo.environment["WINTER_CU_SIM_TARGET"]

    func testTheInvariantsHoldOverRandomInterleavings() async throws {
        var totals = SimStats()
        var surveyed = 0
        let only = Int(ProcessInfo.processInfo.environment["WINTER_CU_SIM_ONLY_SEED"] ?? "")
        // WINTER_CU_SIM_FIRST_SEED: a sweep of seeds first…first+seeds−1 (a long run in parallel processes).
        let first = Int(ProcessInfo.processInfo.environment["WINTER_CU_SIM_FIRST_SEED"] ?? "") ?? 1
        for seed in only.map({ [$0] }) ?? Array(first..<(first + Self.seeds)) {
            // (The ratchet runner's own probes — a child that crashes, a child that hangs, on that seed: test-only hooks.)
            let env = ProcessInfo.processInfo.environment
            if env["WINTER_CU_SIM_CRASH_SEED"] == "\(seed)" { abort() }
            if env["WINTER_CU_SIM_HANG_SEED"] == "\(seed)" { while true { sleep(60) } }
            var plan = SimPlan.generate(seed: UInt64(seed), count: Self.steps)
            if let b = Self.targetBundle { plan.targetBundle = b }
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
        // (Round 18, round 17's H1: the in-flight invariant had chances to fail — not vacuous.)
        XCTAssertGreaterThan(totals.inFlightChances, 0, "the user began working in T while an act on it ran")
        XCTAssertLessThan(Double(totals.unchecked), Double(totals.changes) * 0.05, "unchecked: \(totals.words)")
    }

    /// Seeds KNOWN to fail (round 11's first item), pinned so CI meets them: each must still fail (an expected failure,
    /// shown as such), and a seed that passes is reported, to come off the list. Each is pinned to its violation CLASS —
    /// the invariant its `what` begins with (round 18): failing another way is a new failure.
    static let knownFailing: [(seed: Int, what: String)] = [
        (338, "I3: a user key reached T with no reroute while T was in the background (a blip ending during a theft)"),
        (508, "I2: the engine's place U, the user's P — Secure Event Input with the modifiers unseen"),
        (556, "I2: the engine's place U, the user's X — Secure Event Input with the modifiers unseen"),
        // Round 11's sweep of seeds 1000–1079 (each failed on round 10's engine too; 10 more of its failures are gone):
        (1018, "I4: settled at U, should be X@200 — an untouched U sent back as the agent's indirect effect after the user moved"),
        (1022, "I2: the engine's place T@200, the user's T@100 — the same app on two desktops"),
        // Round 16: pinned per the review of round 15 (LOW) — still failing there.
        (1062, "I1: S came forward as the user clicked into it, 4 ms later — the engine took the click as theirs and said nothing"),
    ]

    /// The ordinary target's (`sim.editor`, round 14's standing second check) known-failing seeds in its surveyed range
    /// 1–60 (the ratchet below runs the whole range).
    static let ordinaryTargetKnownFailing: Set<Int> = []

    /// (Round 16's fixed-seed lists — 1008, 1011, 1017, 1038, 1049, 1051, 1055, 1057, 1059, 1063, 1067, 1073 and, with an
    /// ordinary target, 36, 49, 51, 58 — and the ordinary target's seeds 1–12 are subsumed by the ratchet's whole ranges.)

    /// The known-failing seeds outside the ratchet's range (inside it, the ratchet holds them).
    func testKnownFailingSeedsAreStillKnown() async {
        for (seed, what) in Self.knownFailing where !Self.ratchetRange.contains(seed) {
            let r = await SimRun.execute(SimPlan.generate(seed: UInt64(seed), count: Self.steps))
            if let v = r.violation {
                // (Pinned to its violation class, round 18: failing another way is a new failure.)
                if Self.violationClass(v) != Self.violationClass(what) {
                    XCTFail("seed \(seed) is known to fail with \(Self.violationClass(what) ?? "?"), but now fails with: \(v)")
                    continue
                }
                XCTExpectFailure("KNOWN, round 12: seed \(seed) — \(what)", strict: true) { XCTFail("seed \(seed): \(v)") }
            } else {
                XCTFail("seed \(seed) passes now — take it off GuardianModelTests.knownFailing")
            }
        }
    }

    // MARK: THE RATCHET (the user's process ruling, round 17)

    /// The surveyed ranges, WHOLE: every seed passes but for the known-failing ones, a list that can only shrink — the
    /// default target's seeds 1000–1079 (round 11's sweep; `knownFailing`) and the ordinary target's (`sim.editor`) seeds
    /// 1–60 (round 14's; `ordinaryTargetKnownFailing`). (The review of round 16: 1020 and 1036 passed in round 15's survey
    /// and failed in round 16's — the hand-picked seed lists missed both. They are subsumed here.)
    static let ratchetRange = 1000...1079
    static let ordinaryRatchetRange = 1...60

    /// The default random test's own seeds (1–20, what `testTheInvariantsHoldOverRandomInterleavings` runs by default):
    /// a checked range of the ratchet too (round 18).
    static let defaultRatchetRange = 1...20

    func testTheRatchetTheWholeSurveyedRangesPassButForTheKnownFailing() throws {
        // (A seed takes ~8 s, mostly waiting: the ranges run as child processes of this bundle, in parallel.)
        let known = Dictionary(Self.knownFailing.map { ($0.seed, $0.what) }, uniquingKeysWith: { a, _ in a })
        let ordinary = Dictionary(Self.ordinaryTargetKnownFailing.map { ($0, "") }, uniquingKeysWith: { a, _ in a })
        for (target, range, known) in [(nil, Self.ratchetRange, known), (nil, Self.defaultRatchetRange, known),
                                       ("sim.editor", Self.ordinaryRatchetRange, ordinary)] as [(String?, ClosedRange<Int>, [Int: String])] {
            let what = target.map { "with an ordinary target (\($0))" } ?? "with Finder as the target"
            let failing = try Self.surveyInChildren(target: target, seeds: range)
            // (R18 L6: the in-flight invariant had chances across the whole range — summed over its children.)
            XCTAssertGreaterThan(Self.lastSurveyInFlightChances, 0, "RATCHET: \(what), seeds \(range): the user never began working in T during an act")
            for (seed, v) in failing.sorted(by: { $0.key < $1.key }) {
                guard let pinned = known[seed] else {
                    XCTFail("RATCHET: seed \(seed) \(what) fails and is not known-failing — a regression: \(v)")
                    continue
                }
                // Pinned to its violation CLASS (round 18): a known-failing seed failing another way is a new failure.
                if !pinned.isEmpty, Self.violationClass(v) != Self.violationClass(pinned) {
                    XCTFail("RATCHET: seed \(seed) \(what) is known to fail with \(Self.violationClass(pinned) ?? "?"), but now fails with: \(v)")
                }
            }
            for seed in known.keys.filter(range.contains).sorted() where failing[seed] == nil {
                XCTFail("RATCHET: seed \(seed) \(what) passes now — take it off its known-failing list (the list only shrinks)")
            }
        }
    }

    /// A violation's class: the invariant it names ("I1" … "I6"), as the oracle words it ("I2: the engine takes …").
    static func violationClass(_ v: String) -> String? {
        let head = v.prefix { $0 != ":" }
        return head.hasPrefix("I") && head.count <= 3 ? String(head) : nil
    }

    /// A child of the survey that has not finished by then is HUNG: killed, and the survey fails naming its seeds.
    /// The in-flight chances the last survey's children reported, summed (R18 L6).
    nonisolated(unsafe) static var lastSurveyInFlightChances = 0

    static let childDeadline = TimeInterval(ProcessInfo.processInfo.environment["WINTER_CU_SIM_CHILD_DEADLINE"] ?? "") ?? 900

    /// Runs the random test's survey over `seeds` in child processes of this test bundle (`chunk` seeds each, all at once);
    /// returns the failing seeds and their violations. Every child must report its survey line — a child that crashed or
    /// was cut short is a failure, never a pass.
    static func surveyInChildren(target: String?, seeds: ClosedRange<Int>, chunk: Int = 6, deadline: TimeInterval = childDeadline,
                                 extraEnv: [String: String] = [:]) throws -> [Int: String] {
        let chunks = stride(from: seeds.lowerBound, through: seeds.upperBound, by: chunk).map { start in
            (target: target, seeds: start...min(start + chunk - 1, seeds.upperBound))
        }
        let failing = try surveyInChildren(chunks, deadline: deadline, extraEnv: extraEnv, naming: "\(seeds)")
        return Dictionary(failing.map { ($0.key.seed, $0.value) }, uniquingKeysWith: { a, _ in a })
    }

    /// The same over any list of chunks, each with its own target (round 19, M3: the named regression tests' seeds, one
    /// child each, all at once). A failing seed's key is its target (nil: Finder) and its number.
    static func surveyInChildren(_ chunks: [(target: String?, seeds: ClosedRange<Int>)], deadline: TimeInterval = childDeadline,
                                 extraEnv: [String: String] = [:], naming: String) throws -> [SurveyKey: String] {
        let seeds = naming
        let bundle = Bundle(for: GuardianModelTests.self).bundlePath
        var children: [(process: Process, out: Pipe, err: Pipe, seeds: ClosedRange<Int>, target: String?)] = []
        for c in chunks {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
            p.arguments = ["xctest", "-XCTest", "WinterCUCoreTests.GuardianModelTests/testTheInvariantsHoldOverRandomInterleavings", bundle]
            var env = ProcessInfo.processInfo.environment
            env["WINTER_CU_SIM_SURVEY"] = "1"
            env["WINTER_CU_SIM_FIRST_SEED"] = "\(c.seeds.lowerBound)"
            env["WINTER_CU_SIM_SEEDS"] = "\(c.seeds.count)"
            env["WINTER_CU_SIM_STEPS"] = "\(steps)"
            env["WINTER_CU_SIM_TARGET"] = c.target
            env["WINTER_CU_SIM_ONLY_SEED"] = nil
            for (k, v) in extraEnv { env[k] = v }
            p.environment = env
            let out = Pipe(), err = Pipe()
            p.standardOutput = out
            p.standardError = err
            try p.run()
            children.append((p, out, err, c.seeds, c.target))
        }
        let lock = NSLock()
        var texts: [(target: String?, text: String)] = []
        var broken: [String] = []
        let group = DispatchGroup()
        for c in children {
            group.enter()
            // A per-child deadline: a hung child is killed, and the survey fails naming its seeds.
            let hung = DispatchWorkItem { lock.withLock { broken.append("seeds \(c.seeds) HUNG (no end within \(Int(deadline)) s)") }; c.process.terminate() }
            DispatchQueue.global().asyncAfter(deadline: .now() + deadline, execute: hung)
            DispatchQueue.global().async {
                // (stderr read alongside, so a chatty child never blocks on a full pipe.)
                var errData = Data()
                let errDone = DispatchSemaphore(value: 0)
                DispatchQueue.global().async { errData = c.err.fileHandleForReading.readDataToEndOfFile(); errDone.signal() }
                let data = c.out.fileHandleForReading.readDataToEndOfFile()
                c.process.waitUntilExit()
                errDone.wait()
                hung.cancel()
                let text = String(decoding: data, as: UTF8.self)
                lock.withLock {
                    texts.append((c.target, text))
                    // Every child must report its own survey line and exit cleanly; one that crashed or was cut short is a
                    // failure — with its stderr kept, for the report.
                    let reported = text.split(separator: "\n").contains { $0.hasPrefix("SURVEY: ") }
                    if !reported || c.process.terminationReason != .exit || c.process.terminationStatus != 0 {
                        let tail = String(decoding: errData.suffix(2_000), as: UTF8.self)
                        broken.append("seeds \(c.seeds) ended \(c.process.terminationReason == .exit ? "with status \(c.process.terminationStatus)" : "by signal \(c.process.terminationStatus)")\(reported ? "" : " without reporting") — stderr: \(tail)")
                    }
                }
                group.leave()
            }
        }
        group.wait()
        let lines = texts.flatMap { $0.text.split(separator: "\n").map(String.init) }
        lastSurveyInFlightChances = lines.compactMap { l -> Int? in
            guard let r = l.range(of: " times the user began working in T during an act") else { return nil }
            return Int(l[..<r.lowerBound].split(separator: " ").last ?? "")
        }.reduce(0, +)
        guard broken.isEmpty else {
            throw CUError.unsupported("the survey of seeds \(seeds): \(broken.sorted().joined(separator: "; "))")
        }
        var failing: [SurveyKey: String] = [:]
        for t in texts {
            for l in t.text.split(separator: "\n") where l.hasPrefix("SURVEY seed ") {
                let rest = l.dropFirst("SURVEY seed ".count)
                guard let colon = rest.firstIndex(of: ":"), let seed = Int(rest[..<colon]) else { continue }
                failing[SurveyKey(target: t.target, seed: seed)] = String(rest[rest.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            }
        }
        return failing
    }

    struct SurveyKey: Hashable { var target: String?; var seed: Int }

    /// The ratchet's runner itself (the review of round 17's probe): a child that crashes mid-chunk fails the survey — never
    /// a pass — and so does a child that hangs (killed at its deadline, naming its seeds).
    func testTheSurveyRunnerFailsOnACrashedChild() throws {
        XCTAssertThrowsError(try Self.surveyInChildren(target: nil, seeds: 1000...1002, chunk: 3,
                                                       extraEnv: ["WINTER_CU_SIM_CRASH_SEED": "1001"])) { e in
            XCTAssertTrue("\(e)".contains("1000...1002"), "names the crashed child's seeds: \(e)")
        }
    }

    func testTheSurveyRunnerFailsOnAHungChild() throws {
        XCTAssertThrowsError(try Self.surveyInChildren(target: nil, seeds: 1000...1001, chunk: 1, deadline: 20,
                                                       extraEnv: ["WINTER_CU_SIM_HANG_SEED": "1001"])) { e in
            XCTAssertTrue("\(e)".contains("1001...1001 HUNG"), "names the hung child's seed: \(e)")
        }
    }

    // MARK: the reviewer's findings, as plans (each over a dozen seeds: the world's own timing varies)

    /// Runs `plan` with seeds 1…`seeds`; returns the first violation (with its trace) or nil.
    func run(_ name: String, seeds: Int = 12, flagsSeen: Bool = true, targetBundle: String = "com.apple.finder",
             _ steps: [(Double, SimKind)]) async -> String? {
        for seed in 1...seeds {
            let r = await SimRun.execute(SimPlan.scripted(seed: UInt64(seed), flagsSeen: flagsSeen, targetBundle: targetBundle, steps))
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

    /// Round 14's queue item 1: T is an ordinary app (not Finder) — a third party's app (X, Terminal: another agent
    /// session's) coming forward right after the agent's act, with no input of the user's, is outside what the act can
    /// open: left in front and said, never undone; what the act can open (S, the default browser) is still sent back.
    func testAThirdPartysActivationRightAfterAnActIsNeverUndone() async {
        // A click in T (an opener act), X comes forward 250 ms later, no input of the user's for seconds before.
        let steps: [(Double, SimKind)] = [(300, .typing(5)), (3_300, .agentClick(.field)), (3_550, .selfActivate(SimPid.third)), (6_500, .quiet)]
        let left = await run("r14-third-party", targetBundle: "sim.editor", steps)
        XCTAssertNil(left, left ?? "")
        // Not vacuous: the same steps with T as Finder (whose acts open any app) send X back; with T an ordinary app,
        // X is left in front.
        for seed in 1...4 {
            let finder = await SimRun.execute(SimPlan.scripted(seed: UInt64(seed), steps))
            let editor = await SimRun.execute(SimPlan.scripted(seed: UInt64(seed), targetBundle: "sim.editor", steps))
            XCTAssertTrue(finder.trace.contains { $0.contains("X activates itself") && $0.contains("undone") }, "seed \(seed): Finder")
            XCTAssertTrue(editor.trace.contains { $0.contains("X activates itself") && $0.contains("left in front") }, "seed \(seed): an ordinary app")
        }
        let opened = await run("r14-in-scope", targetBundle: "sim.editor",
                               [(300, .agentClick(.opener, ms: 400)), (3_000, .agentType(3)), (6_500, .quiet)])
        XCTAssertNil(opened, opened ?? "")
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
