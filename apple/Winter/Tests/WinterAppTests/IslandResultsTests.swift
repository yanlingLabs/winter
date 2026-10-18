import XCTest
import WinterKit
@testable import Winter

/// The island's turn-result cards: which are born (host focused or not, Dispatch with its pill visible, a stale one),
/// the queue's own clock (self-dismissal, the hover hold), and the PRECEDENCE of everything born from the housing —
/// a card needing an answer over a result over the computer-use pill.
@MainActor
final class IslandResultsTests: XCTestCase {
    private var now: TimeInterval = 100
    private var wall: TimeInterval = 1_000
    private var wakes: [TimeInterval?] = []

    private func makeStore(focus: IslandFocus = IslandFocus()) -> IslandActivityStore {
        let store = IslandActivityStore()
        store.clock = { [unowned self] in self.now }
        store.wallClock = { [unowned self] in self.wall }
        store.scheduleWake = { [unowned self] in self.wakes.append($0) }
        store.focus = { focus }
        return store
    }

    private func result(_ id: String, session: String = "s_code", facts: IslandSessionFacts = IslandSessionFacts(mode: "code", title: "Fix the build"),
                        hosts: [IslandHost] = [], ageSeconds: Double = 2) -> IslandResultItem {
        IslandResultItem(id: id, sessionId: session, summary: "All tests pass now.", at: Int((wall - ageSeconds) * 1000),
                         session: facts, hosts: hosts)
    }

    private func cu(_ sid: String) -> IslandComputerUseItem {
        IslandComputerUseItem(sessionId: sid, startedAt: 1, lastAt: 1, running: true, apps: ["Notes"])
    }

    // MARK: Firing rules

    func testAResultIsBornWhenItsHostIsNotInFrontAndNotWhenItIs() {
        let away = makeStore()
        away.apply(IslandActivitySnapshot(results: [result("r1")]))
        XCTAssertEqual(away.currentResult?.id, "r1")
        XCTAssertEqual(islandResultTitle(away.currentResult!), "Fix the build")

        // Its Winter window is key with Winter in front: no card.
        let focused = makeStore(focus: IslandFocus(winterFrontmost: true, keyOrMainWindowSessionIds: ["s_code"]))
        focused.apply(IslandActivitySnapshot(results: [result("r1")]))
        XCTAssertNil(focused.currentResult)
        XCTAssertTrue(focused.results.seen.contains("r1"), "dropped, never deferred")

        // Its exact terminal is in front: no card; another terminal: the card.
        let tui = [IslandHost(clientName: "tui", role: "harness", tty: "/dev/ttys004")]
        let terminal = makeStore()
        terminal.apply(IslandActivitySnapshot(results: [result("r2", hosts: tui)]), terminals: ["/dev/ttys004": .front])
        XCTAssertNil(terminal.currentResult)
        let other = makeStore()
        other.apply(IslandActivitySnapshot(results: [result("r2", hosts: tui)]), terminals: ["/dev/ttys004": .notFront])
        XCTAssertEqual(other.currentResult?.id, "r2")
    }

    func testDispatchWhileItsPillIsVisibleIsNotShownAndAStaleOneIsNot() {
        let dispatch = IslandSessionFacts(mode: "dispatch")
        let child = IslandSessionFacts(mode: "code", origin: "dispatch-child", parentSessionId: "s_disp")
        let pill = makeStore(focus: IslandFocus(dispatchPillVisible: true, dispatchSessionIds: ["s_disp"]))
        pill.apply(IslandActivitySnapshot(results: [result("r1", session: "s_disp", facts: dispatch),
                                                    result("r2", session: "s_child", facts: child)]))
        XCTAssertNil(pill.currentResult)
        XCTAssertNil(pill.results.held)

        let noPill = makeStore(focus: IslandFocus(dispatchPillVisible: false, dispatchSessionIds: ["s_disp"]))
        noPill.apply(IslandActivitySnapshot(results: [result("r1", session: "s_disp", facts: dispatch)]))
        XCTAssertEqual(noPill.currentResult?.id, "r1", "the pill hidden: the island shows Dispatch's result")
        XCTAssertEqual(islandResultTitle(noPill.currentResult!), "Dispatch")

        let stale = makeStore()
        stale.apply(IslandActivitySnapshot(results: [result("old", ageSeconds: IslandResultQueue.maxAgeAtBirth + 1)]))
        XCTAssertNil(stale.currentResult, "an old one (the app just connected) is not born")
    }

    func testIntermediateTurnsAreTheDaemonsCallAndAResultGoesWhenItsSessionMovesOn() {
        // The daemon publishes only turns that ended IDLE; a result it stops listing (the session's next turn began)
        // goes from the island, and the same id is never born twice.
        let store = makeStore()
        store.apply(IslandActivitySnapshot(results: [result("r1")]))
        XCTAssertEqual(store.currentResult?.id, "r1")
        store.apply(IslandActivitySnapshot(results: []))
        XCTAssertNil(store.currentResult)
        store.apply(IslandActivitySnapshot(results: [result("r1")]))
        XCTAssertNil(store.currentResult, "seen once")
        // A newer result replaces the older one.
        store.apply(IslandActivitySnapshot(results: [result("r2"), result("r3", session: "s_two")]))
        XCTAssertEqual(store.currentResult?.id, "r3")
    }

    func testAResultSelfDismissesUnhoveredAndTheHoverHoldsIt() {
        let store = makeStore()
        store.apply(IslandActivitySnapshot(results: [result("r1")]))
        XCTAssertEqual(wakes.last ?? nil, now + IslandResultQueue.showFor)
        store.hoverResult(true)
        XCTAssertEqual(wakes.last ?? 0, nil, "hovered: no clock")
        now += IslandResultQueue.showFor + 5
        store.tick()
        XCTAssertEqual(store.currentResult?.id, "r1")
        store.hoverResult(false)
        XCTAssertEqual(wakes.last ?? nil, now + IslandResultQueue.hoverLeaveGrace)
        now += IslandResultQueue.hoverLeaveGrace
        store.tick()
        XCTAssertNil(store.currentResult)
        XCTAssertEqual(wakes.last ?? 0, nil)
    }

    func testOpenMovesTheViewToTheSessionAndDismissJustGoes() {
        let store = makeStore()
        var opened: [String] = []
        var asked: [(hosts: [IslandHost], isDispatch: Bool)] = []
        store.openSession = { sid, hosts, isDispatch in opened.append(sid); asked.append((hosts, isDispatch)) }
        store.apply(IslandActivitySnapshot(results: [result("r1")]))
        store.openResult("r1")
        XCTAssertEqual(opened, ["s_code"])
        XCTAssertNil(store.currentResult)
        store.apply(IslandActivitySnapshot(results: [result("r2", session: "s2")]))
        store.dismissResult("r2")
        XCTAssertNil(store.currentResult)
        XCTAssertEqual(opened, ["s_code"])
        XCTAssertTrue(store.resultItems.isEmpty)
        XCTAssertEqual(asked.first?.isDispatch, false)
    }

    func testAFiredPlanAlarmIsBornOnTopShowsLongerAndOpensTheUsageTab() {
        let store = makeStore()
        var usageOpened = 0
        store.openUsageTab = { usageOpened += 1 }
        let alarm = IslandUsageAlarmItem(id: "al-1", provider: "claude-code", windowKey: "weekly", kind: "weekly", windowMinutes: 10_080,
                                         thresholdPercent: 80, usedPercent: 81, resetsAt: (wall + 86_400) * 1000, at: Int((wall - 2) * 1000))
        store.apply(IslandActivitySnapshot(usageAlarms: [alarm]))
        XCTAssertEqual(store.currentAlarm, alarm)
        XCTAssertNil(store.currentResult)
        XCTAssertEqual(IslandActivityArbiter.decide(cardOnTop: false, islandOpen: false, result: store.currentAlarm?.id, computerUse: nil,
                                                   mirrorOpen: false).slot, .result("al-1"))
        XCTAssertEqual(wakes.last ?? nil, now + IslandResultQueue.alarmShowFor, "it shows longer than a turn's result")
        // A second listing never bears it again; one first seen long after it fired is not born.
        store.apply(IslandActivitySnapshot(usageAlarms: [alarm]))
        store.openResult("al-1")
        XCTAssertEqual(usageOpened, 1)
        XCTAssertNil(store.currentAlarm)
        XCTAssertTrue(store.alarmItems.isEmpty)
        let old = IslandUsageAlarmItem(id: "al-2", provider: "codex", windowKey: "five_hour", kind: "five_hour", thresholdPercent: 50,
                                       usedPercent: 50, at: Int((wall - IslandResultQueue.maxAgeAtBirth - 1) * 1000))
        store.apply(IslandActivitySnapshot(usageAlarms: [alarm, old]))
        XCTAssertNil(store.currentAlarm)
        // A card needing an answer on top holds it; it is born when the top frees.
        let held = IslandUsageAlarmItem(id: "al-3", provider: "codex", windowKey: "weekly", kind: "weekly", thresholdPercent: 90,
                                        usedPercent: 92, at: Int(wall * 1000))
        store.setCardOnTop(true)
        store.apply(IslandActivitySnapshot(usageAlarms: [held]))
        XCTAssertNil(store.currentAlarm)
        store.setCardOnTop(false)
        XCTAssertEqual(store.currentAlarm?.id, "al-3")
        XCTAssertEqual(store.results.current?.dismissAt, now + IslandResultQueue.alarmShowFor)
    }

    func testOpenGoesExactlyWhereASessionsRowsClickGoes() {
        let sessions = IslandSessionsModel()
        var targets: [IslandSessionTarget] = []
        sessions.reveal = { targets.append($0) }
        sessions.windows = { IslandWindowFacts(appWindowSessionId: "s_app", detachedSessionIds: ["s_det"]) }
        let tty = [IslandHost(clientName: "tui", role: "harness", tty: "/dev/ttys004")]
        sessions.setHostsForTesting(["s_cli": tty])
        sessions.openFromIsland("s_app", hosts: [], isDispatch: false)
        sessions.openFromIsland("s_det", hosts: [], isDispatch: false)
        sessions.openFromIsland("s_cli", hosts: [], isDispatch: false)       // the tab's own hosts
        sessions.openFromIsland("s_new", hosts: tty, isDispatch: false)      // the result's hosts
        sessions.openFromIsland("s_disp", hosts: [], isDispatch: true)
        let w = sessions.windows()
        XCTAssertEqual(targets, [
            IslandSessionsBuilder.target(of: "s_app", hosts: [], windows: w, isDispatch: false),
            IslandSessionsBuilder.target(of: "s_det", hosts: [], windows: w, isDispatch: false),
            IslandSessionsBuilder.target(of: "s_cli", hosts: tty, windows: w, isDispatch: false),
            IslandSessionsBuilder.target(of: "s_new", hosts: tty, windows: w, isDispatch: false),
            IslandSessionsBuilder.target(of: "s_disp", hosts: [], windows: w, isDispatch: true),
        ])
        XCTAssertEqual(targets.first, .appWindow(sessionId: "s_app"))
    }

    // MARK: Precedence

    func testTheArbitersRuleTable() {
        typealias A = IslandActivityArbiter
        // A card needing an answer, or the open island, owns everything.
        XCTAssertEqual(A.decide(cardOnTop: true, islandOpen: false, result: "r", computerUse: "s", mirrorOpen: true), .none)
        XCTAssertEqual(A.decide(cardOnTop: false, islandOpen: true, result: "r", computerUse: "s", mirrorOpen: false), .none)
        // A result over the pill.
        XCTAssertEqual(A.decide(cardOnTop: false, islandOpen: false, result: "r", computerUse: "s", mirrorOpen: false),
                       IslandActivityDecision(slot: .result("r")))
        // The pill; opened into its mirror (compacted cards change nothing here: they draw nothing under the housing).
        XCTAssertEqual(A.decide(cardOnTop: false, islandOpen: false, result: nil, computerUse: "s", mirrorOpen: false),
                       IslandActivityDecision(slot: .computerUse(sessionId: "s", expanded: false)))
        XCTAssertEqual(A.decide(cardOnTop: false, islandOpen: false, result: nil, computerUse: "s", mirrorOpen: true),
                       IslandActivityDecision(slot: .computerUse(sessionId: "s", expanded: true)))
        XCTAssertEqual(A.decide(cardOnTop: false, islandOpen: false, result: "r", computerUse: nil, mirrorOpen: false),
                       IslandActivityDecision(slot: .result("r")))
        XCTAssertEqual(A.decide(cardOnTop: false, islandOpen: false, result: nil, computerUse: nil, mirrorOpen: false), .none)
        // The agent's hardware pointer (rung 4): nothing of the island's in its way.
        XCTAssertEqual(A.decide(cardOnTop: false, islandOpen: false, result: "r", computerUse: "s", mirrorOpen: true,
                                realMouse: true), .none)
    }

    func testACardOnTopHoldsAResultAndItIsBornWhenTheTopFrees() {
        let store = makeStore()
        store.setCardOnTop(true)
        store.apply(IslandActivitySnapshot(results: [result("r1")]))
        XCTAssertNil(store.currentResult, "an approval owns the top")
        XCTAssertEqual(store.results.held?.id, "r1")
        store.setCardOnTop(false)
        XCTAssertEqual(store.currentResult?.id, "r1")
        // One showing yields to a card, and comes back after.
        store.setCardOnTop(true)
        XCTAssertNil(store.currentResult)
        now += 5
        store.setCardOnTop(false)
        XCTAssertEqual(store.currentResult?.id, "r1")
        // Held too long: dropped.
        store.setCardOnTop(true)
        now += IslandResultQueue.holdAtMost + 1
        store.tick()
        store.setCardOnTop(false)
        XCTAssertNil(store.currentResult)
        XCTAssertNil(store.results.held)
    }

    func testThePillsMirrorClosesWhenThePillHasNothingLeftToShow() {
        let store = makeStore()
        store.apply(IslandActivitySnapshot(computerUse: [cu("s1")]))
        store.setMirrorOpen(true)
        XCTAssertTrue(store.mirrorOpen)
        store.apply(IslandActivitySnapshot())
        XCTAssertTrue(store.mirrorOpen, "lingering: still open")
        now += IslandCUState.linger
        store.tick()
        XCTAssertFalse(store.mirrorOpen)
        store.setMirrorOpen(true)
        XCTAssertFalse(store.mirrorOpen, "nothing to open")
    }

    func testTheMirrorClosesWhenThePillMovesToAnotherSessionInsteadOfSwitchingPictures() {
        let store = makeStore()
        store.apply(IslandActivitySnapshot(computerUse: [cu("s1"), cu("s2")]))
        let first = store.cuPresentation?.sessionId
        store.setMirrorOpen(true)
        XCTAssertEqual(store.mirrorSessionId, first)
        // The same session acting keeps it open.
        store.cursor(sessionId: first!, kind: "type", text: nil, appName: "Notes")
        XCTAssertTrue(store.mirrorOpen)
        // The other session becomes the most recent: back to the pill, never its pictures.
        let other = first == "s1" ? "s2" : "s1"
        store.cursor(sessionId: other, kind: "type", text: nil, appName: "Mail")
        XCTAssertEqual(store.cuPresentation?.sessionId, other)
        XCTAssertFalse(store.mirrorOpen)
        XCTAssertNil(store.mirrorSessionId)
        // Its host coming to the front hides it: the mirror on it closes too.
        store.setMirrorOpen(true)
        XCTAssertEqual(store.mirrorSessionId, other)
        let hiding = IslandActivityStore()
        hiding.clock = { [unowned self] in self.now }
        hiding.apply(IslandActivitySnapshot(computerUse: [cu("s1")]))
        hiding.setMirrorOpen(true)
        hiding.focus = { IslandFocus(winterFrontmost: true, keyOrMainWindowSessionIds: ["s1"]) }
        hiding.apply(IslandActivitySnapshot(computerUse: [cu("s1")]))
        XCTAssertFalse(hiding.mirrorOpen)
    }

    func testTheHelpersLossEndsTheRealMouseStepAside() {
        let store = makeStore()
        store.apply(IslandActivitySnapshot(computerUse: [cu("s1")]))
        store.cursor(sessionId: "s1", kind: "foreground", text: "on", appName: "Notes")
        XCTAssertTrue(store.usingRealMouse)
        store.helperConnectionLost()
        XCTAssertFalse(store.usingRealMouse)
    }

    func testThePillHidesWhileItsSessionsHostIsInFrontButNotBehindTheDispatchPill() {
        let store = makeStore(focus: IslandFocus(dispatchPillVisible: true, dispatchSessionIds: ["s_disp"], winterFrontmost: true,
                                                 keyOrMainWindowSessionIds: ["s_front"]))
        let child = IslandComputerUseItem(sessionId: "s_child", startedAt: 1, lastAt: 1, running: true,
                                          session: IslandSessionFacts(origin: "dispatch-child", parentSessionId: "s_disp"))
        store.apply(IslandActivitySnapshot(computerUse: [cu("s_front"), child]))
        XCTAssertEqual(store.hiddenSessions, ["s_front"])
        XCTAssertEqual(store.cuPresentation?.sessionId, "s_child", "the Dispatch pill does not say what the computer does")
        var followed: [Set<String>] = []
        store.onCursorSessionsChange = { followed.append($0) }
        store.apply(IslandActivitySnapshot(computerUse: [cu("s_front")]))
        XCTAssertEqual(followed, [["s_front"]], "the cursor is followed for every session at work, shown or not")
    }
}
