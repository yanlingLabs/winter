import XCTest
import AppKit
import SwiftUI
import WinterKit
import WinterProtocol
@testable import Winter

/// The user's report (2026-10-20): Enter compresses the typing pill, then the pill "flashes a few times very
/// quickly" before it settles into the plume. The send's answer usually reaches the pill BEFORE the turn's
/// `turn_started` (the event rides the session feed's reader task and drain; the answer resumes the submit
/// directly), and for that gap the pill drew the IDLE compact pill — the "Type here" placeholder, the voice glyph,
/// the empty composer — between the typing pill and the working one: send → voice → stop on the circle, the
/// placeholder in and out. These drive a real pill (its SwiftUI tree mounted) through Enter and the first events of
/// a turn in both orders, sample what it draws every few milliseconds, and require ONE monotonic change: typing →
/// working, nothing in between.
@MainActor
final class DispatchPillSendFlickerTests: XCTestCase {
    private let visible = CGRect(x: 100, y: 80, width: 1440, height: 820)
    private var controllers: [DispatchPillController] = []
    private var suites: [String] = []

    override func setUp() async throws {
        try await super.setUp()
        PlumeLayerView.runsInUnshownWindows = true
    }

    override func tearDown() async throws {
        controllers.forEach { $0.hide() }
        controllers.removeAll()
        suites.forEach { UserDefaults().removePersistentDomain(forName: $0) }
        suites.removeAll()
        PlumeLayerView.runsInUnshownWindows = false
        try await super.tearDown()
    }

    private func makePill(_ session: SessionModel) -> DispatchPillController {
        let suite = "WinterTests.DispatchPillSendFlicker.\(UUID().uuidString)"
        suites.append(suite)
        let pill = DispatchPillController(session: session,
                                          settings: DispatchPillSettings(defaults: UserDefaults(suiteName: suite)!))
        pill.visibleFrameOverrideForTesting = visible
        controllers.append(pill)
        return pill
    }

    private func event(_ fields: [String: Any]) -> SessionEvent { ReplayBufferTests.event(fields, session: "s_d") }

    private func plumes(in view: NSView?) -> [PlumeLayerView] {
        guard let view else { return [] }
        if let plume = view as? PlumeLayerView { return [plume] }
        return view.subviews.flatMap { plumes(in: $0) }
    }

    /// One sample of what the pill draws.
    private struct Frame: Equatable {
        let presentation: DispatchPillPresentation
        let look: DispatchPillBarLook
        /// The working plume's view (nil: none mounted) — one identity for the whole turn, never rebuilt.
        let plume: ObjectIdentifier?
        /// The AppKit composer's alpha (the typed text): 1 shown, 0 hidden under the plume.
        let composerAlpha: CGFloat
    }

    /// Records every change in what the pill draws while `pump` runs the main run loop.
    private final class Recorder {
        var frames: [Frame] = []
        func note(_ frame: Frame) { if frames.last != frame { frames.append(frame) } }
        /// The distinct successive values of one aspect, from the first recorded frame on.
        func steps<T: Equatable>(_ key: (Frame) -> T) -> [T] {
            var out: [T] = []
            for frame in frames where out.last != key(frame) { out.append(key(frame)) }
            return out
        }
    }

    private func frame(_ pill: DispatchPillController) -> Frame {
        Frame(presentation: pill.presentation, look: pill.barLookForTesting,
              plume: plumes(in: pill.hostingViewForTesting).first.map(ObjectIdentifier.init),
              composerAlpha: pill.composerTextViewForTesting?.enclosingScrollView?.alphaValue ?? -1)
    }

    private func pump(_ pill: DispatchPillController, _ recorder: Recorder?, for seconds: Double) {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            RunLoop.main.run(until: Date().addingTimeInterval(0.004))
            recorder?.note(frame(pill))
        }
    }

    private func pump(_ pill: DispatchPillController, _ recorder: Recorder?, until condition: () -> Bool,
                      timeout: Double = 2) {
        let end = Date().addingTimeInterval(timeout)
        while !condition(), Date() < end {
            RunLoop.main.run(until: Date().addingTimeInterval(0.004))
            recorder?.note(frame(pill))
        }
    }

    private enum Order { case answerFirst, eventsFirst }

    private struct Run {
        let session: SessionModel
        let pill: DispatchPillController
        let recorder: Recorder
    }

    /// A pill typed into, then Enter; the send's answer and the turn's opening events (`user_message`,
    /// `turn_started`, as the daemon appends them before answering) reach it in `order`, `gap` apart; then the turn
    /// thinks (`thinking_delta` start and deltas, `thinking_block`) and calls its first tool, as the projector emits
    /// them. Recording starts at Enter.
    private func send(order: Order, gap: Double = 0.03, turnStarts: Bool = true,
                      grace: TimeInterval? = nil, session given: SessionModel? = nil, seqBase: Int = 0,
                      beforeFirstTool: ((DispatchPillController) -> Void)? = nil) -> Run {
        let session = given ?? SessionModel()
        let pill = makePill(session)
        pill.turnStartGraceOverrideForTesting = grace
        var answered = false
        pill.onSubmit = { _ in
            while !answered { try? await Task.sleep(nanoseconds: 2_000_000) }
            return true
        }
        pill.show()
        pill.adapter.composerDraft = "ship it"
        pump(pill, nil, until: { pill.presentation == .expanded && pill.isSpringIdleForTesting })
        XCTAssertEqual(pill.presentation, .expanded, "typing opened the pill")

        let recorder = Recorder()
        recorder.note(frame(pill))
        pill.submit("ship it")
        let opening = {
            session.apply(self.event(["type": "user_message", "seq": seqBase + 1, "ts": 1, "threadId": "main", "text": "ship it",
                                      "clientName": "orb"]))
            session.apply(self.event(["type": "turn_started", "seq": seqBase + 2, "ts": 2, "threadId": "main"]))
        }
        switch order {
        case .answerFirst:
            answered = true
            pump(pill, recorder, until: { pill.adapter.composerDraft.isEmpty })
            pump(pill, recorder, for: gap)
            if turnStarts { opening() }
        case .eventsFirst:
            opening()
            pump(pill, recorder, for: gap)
            answered = true
            pump(pill, recorder, until: { pill.adapter.composerDraft.isEmpty })
        }
        guard turnStarts else { return Run(session: session, pill: pill, recorder: recorder) }
        pump(pill, recorder, for: 0.05)
        session.apply(event(["type": "thinking_delta", "seq": seqBase + 3, "ts": 3, "threadId": "main", "blockId": "b1",
                             "kind": "summary", "phase": "start"]))
        pump(pill, recorder, for: 0.03)
        for i in 0..<4 {
            session.apply(event(["type": "thinking_delta", "seq": seqBase + 4 + i, "ts": 3, "threadId": "main", "blockId": "b1",
                                 "kind": "summary", "phase": "delta", "text": "step \(i) "]))
            pump(pill, recorder, for: 0.02)
        }
        session.apply(event(["type": "thinking_block", "seq": seqBase + 10, "ts": 4, "threadId": "main", "blockId": "b1",
                             "kind": "summary", "text": "thought it through"]))
        pump(pill, recorder, for: 0.03)
        beforeFirstTool?(pill)
        session.apply(event(["type": "tool_call", "seq": seqBase + 11, "ts": 5, "threadId": "main", "callId": "c1", "name": "bash",
                             "argsJson": #"{"command":"ls"}"#]))
        pump(pill, recorder, until: { pill.isSpringIdleForTesting })
        pump(pill, recorder, for: 0.3)
        return Run(session: session, pill: pill, recorder: recorder)
    }

    /// Typing → working, once, and nothing in between.
    private func assertMonotonic(_ run: Run, file: StaticString = #filePath, line: UInt = #line) {
        let r = run.recorder
        XCTAssertEqual(r.steps(\.presentation), [.expanded, .compact], "compress once", file: file, line: line)
        XCTAssertEqual(r.steps(\.look.working), [false, true], "the working look comes once and stays",
                       file: file, line: line)
        XCTAssertEqual(r.steps(\.look.circle), [.send, .stop], "the circle goes send → stop, never through the voice glyph",
                       file: file, line: line)
        XCTAssertEqual(r.steps(\.look.placeholder), [nil], "no placeholder flashes in after Enter",
                       file: file, line: line)
        XCTAssertEqual(r.steps(\.composerAlpha), [1, 0], "the composer hides once, never comes back empty",
                       file: file, line: line)
        let plumes = r.steps(\.plume)
        XCTAssertEqual(plumes.count, 2, "no plume, then ONE plume for good: \(plumes)", file: file, line: line)
        XCTAssertNil(plumes.first ?? nil, file: file, line: line)
    }

    // MARK: - Enter → working, in both orders

    func testTheAnswerBeforeTheTurnGoesStraightFromTypingToWorking() {
        let run = send(order: .answerFirst)
        assertMonotonic(run)
        XCTAssertTrue(run.session.state.turnRunning)
        XCTAssertFalse(run.pill.awaitingTurnStart, "the session's own turn carries the look once it shows")
    }

    func testTheTurnBeforeTheAnswerGoesStraightFromTypingToWorking() {
        let run = send(order: .eventsFirst)
        assertMonotonic(run)
        XCTAssertFalse(run.pill.awaitingTurnStart, "a turn already running needs no hold")
    }

    /// A slow hop from the answer to the turn's first event still never shows the idle pill.
    func testALongGapBeforeTheTurnShowsHoldsTheWorkingLook() {
        let run = send(order: .answerFirst, gap: 1.0)
        assertMonotonic(run)
    }

    /// A session with a past turn that used tools: the plume mounted while the new turn is on its way must not throw
    /// the PAST turn's tiles (the last exchange is still the old one until `user_message` lands).
    func testThePlumeThrowsNothingOfThePreviousTurnWhileTheNewOneIsOnItsWay() {
        let session = SessionModel()
        session.apply(event(["type": "user_message", "seq": 1, "ts": 1, "threadId": "main", "text": "before", "clientName": "orb"]))
        session.apply(event(["type": "turn_started", "seq": 2, "ts": 2, "threadId": "main"]))
        session.apply(event(["type": "tool_call", "seq": 3, "ts": 3, "threadId": "main", "callId": "old", "name": "bash",
                             "argsJson": #"{"command":"ls"}"#]))
        session.apply(event(["type": "tool_result", "seq": 4, "ts": 4, "threadId": "main", "callId": "old", "output": "ok",
                             "isError": false]))
        session.apply(event(["type": "assistant_message", "seq": 5, "ts": 5, "threadId": "main", "text": "Done."]))
        session.apply(event(["type": "turn_completed", "seq": 6, "ts": 6, "threadId": "main", "stopReason": "end_turn",
                             "inputTokens": 1, "outputTokens": 1]))
        var tilesBeforeTheNewTool = -1
        let run = send(order: .answerFirst, gap: 0.6, session: session, seqBase: 100, beforeFirstTool: { pill in
            tilesBeforeTheNewTool = self.plumes(in: pill.hostingViewForTesting).first?.activeTileCount ?? -1
        })
        assertMonotonic(run)
        XCTAssertEqual(tilesBeforeTheNewTool, 0, "no tile of the previous turn left the nozzle")
    }

    // MARK: - The hold ends

    /// A send whose turn never shows up (the daemon held it) gives the idle pill back after the grace.
    func testAHeldSendGivesTheIdlePillBackAfterTheGrace() {
        let run = send(order: .answerFirst, turnStarts: false, grace: 0.3)
        XCTAssertTrue(run.pill.awaitingTurnStart)
        XCTAssertTrue(run.pill.barLookForTesting.working)
        pump(run.pill, nil, until: { !run.pill.awaitingTurnStart })
        XCTAssertFalse(run.pill.awaitingTurnStart)
        XCTAssertEqual(run.pill.barLookForTesting,
                       DispatchPillBarLook(working: false, circle: .blocked(""), placeholder: "Type here"))
    }

    /// The turn failed before it ever ran (`agent_error` with no `turn_started`): the hold ends with it.
    func testAnErrorBeforeTheTurnRunsEndsTheHold() {
        let run = send(order: .answerFirst, turnStarts: false)
        XCTAssertTrue(run.pill.awaitingTurnStart)
        run.session.apply(event(["type": "agent_error", "seq": 3, "ts": 3, "threadId": "main", "message": "no model",
                                 "code": "internal"]))
        pump(run.pill, nil, for: 0.05)
        XCTAssertFalse(run.pill.awaitingTurnStart)
        XCTAssertFalse(run.pill.barLookForTesting.working)
    }

    /// A turn that came and went before the answer landed is not waited for.
    func testATurnThatEndedBeforeTheAnswerIsNotWaitedFor() {
        let session = SessionModel()
        let pill = makePill(session)
        var answered = false
        pill.onSubmit = { _ in
            while !answered { try? await Task.sleep(nanoseconds: 2_000_000) }
            return true
        }
        pill.show()
        pill.adapter.composerDraft = "quick"
        pump(pill, nil, until: { pill.presentation == .expanded })
        pill.submit("quick")
        session.apply(event(["type": "user_message", "seq": 1, "ts": 1, "threadId": "main", "text": "quick", "clientName": "orb"]))
        session.apply(event(["type": "turn_started", "seq": 2, "ts": 2, "threadId": "main"]))
        session.apply(event(["type": "turn_completed", "seq": 3, "ts": 3, "threadId": "main", "stopReason": "end_turn",
                             "inputTokens": 1, "outputTokens": 1]))
        answered = true
        pump(pill, nil, until: { pill.adapter.composerDraft.isEmpty })
        pump(pill, nil, for: 0.05)
        XCTAssertFalse(pill.awaitingTurnStart)
        XCTAssertFalse(pill.barLookForTesting.working)
    }

    /// The turn's end still returns the pill to the idle compact pill.
    func testTheTurnsEndReturnsToTheIdlePill() {
        let run = send(order: .answerFirst)
        run.session.apply(event(["type": "assistant_message", "seq": 12, "ts": 6, "threadId": "main", "text": "Done."]))
        run.session.apply(event(["type": "turn_completed", "seq": 13, "ts": 7, "threadId": "main", "stopReason": "end_turn",
                                 "inputTokens": 1, "outputTokens": 1]))
        pump(run.pill, nil, for: 0.1)
        XCTAssertFalse(run.pill.awaitingTurnStart)
        XCTAssertFalse(run.pill.barLookForTesting.working)
    }

    /// A steer (the turn already running) holds nothing: the running turn is the look.
    func testASteerHoldsNothing() {
        let session = SessionModel()
        let pill = makePill(session)
        pill.onSubmit = { _ in true }
        session.apply(event(["type": "user_message", "seq": 1, "ts": 1, "threadId": "main", "text": "go", "clientName": "orb"]))
        session.apply(event(["type": "turn_started", "seq": 2, "ts": 2, "threadId": "main"]))
        pill.show()
        pill.openComposer()
        pill.adapter.composerDraft = "also this"
        pump(pill, nil, for: 0.05)
        pill.submit("also this")
        pump(pill, nil, until: { pill.adapter.composerDraft.isEmpty })
        pump(pill, nil, for: 0.05)
        XCTAssertFalse(pill.awaitingTurnStart)
        XCTAssertEqual(pill.presentation, .compact)
        XCTAssertTrue(pill.barLookForTesting.working)
    }

    // MARK: - The look (pure)

    func testTheBarLook() {
        XCTAssertEqual(dispatchPillBarLook(expanded: false, running: false, draft: "", cardShown: false, verbText: ""),
                       DispatchPillBarLook(working: false, circle: .blocked(""), placeholder: "Type here"))
        XCTAssertEqual(dispatchPillBarLook(expanded: false, running: true, draft: "", cardShown: false, verbText: "Pondering…"),
                       DispatchPillBarLook(working: true, circle: .stop, placeholder: nil),
                       "no placeholder under the plume")
        XCTAssertEqual(dispatchPillBarLook(expanded: true, running: true, draft: "", cardShown: false, verbText: "Pondering…"),
                       DispatchPillBarLook(working: false, circle: .stop, placeholder: "Pondering…"),
                       "the typing pill over a running turn keeps its verb")
        XCTAssertEqual(dispatchPillBarLook(expanded: true, running: false, draft: "hi", cardShown: false, verbText: ""),
                       DispatchPillBarLook(working: false, circle: .send, placeholder: nil))
        XCTAssertEqual(dispatchPillBarLook(expanded: false, running: true, draft: "", cardShown: true, verbText: "x").working,
                       false, "a card is never the plume")
    }
}
