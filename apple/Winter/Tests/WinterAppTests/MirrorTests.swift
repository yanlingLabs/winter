import Combine
import XCTest
import WinterKit
@testable import Winter

/// The live mirror inside Winter's windows (spine §11b): the rules that decide where it shows, the
/// coordinator's subscriptions and connection policy against a fake helper, and the per-session model of
/// bound targets, frames and cursors. No window and no socket is created — the child panel
/// itself is AppKit and is the live gate's.
@MainActor
final class MirrorTests: XCTestCase {
    /// `eventually` as an assertion (an `await` cannot sit inside XCTAssert's autoclosure).
    private func expect(_ condition: @MainActor () -> Bool, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) async {
        let ok = await eventually(2, condition)
        XCTAssertTrue(ok, message, file: file, line: line)
    }

    // MARK: - The rule table

    private func window(_ kind: MirrorWindowKind, session: String? = "s1", width: CGFloat = 900, id: String = "w1") -> MirrorWindow {
        MirrorWindow(id: id, kind: kind, sessionId: session, width: width)
    }

    func testTheMainWindowShowsItWhenItHasASessionAtAnyWidth() {
        for width in [320, 480, 900, 2000] as [CGFloat] {
            XCTAssertTrue(MirrorRules.isEligible(window(.shell, width: width), wasEligible: false), "\(width)")
        }
        XCTAssertFalse(MirrorRules.isEligible(window(.shell, session: nil), wasEligible: false), "no session open: nothing shows")
        XCTAssertFalse(MirrorRules.isEligible(window(.shell, session: ""), wasEligible: true))
    }

    func testADetachedWindowNeedsSevenHundredTwentyPoints() {
        XCTAssertFalse(MirrorRules.isEligible(window(.detached, width: 719), wasEligible: false))
        XCTAssertTrue(MirrorRules.isEligible(window(.detached, width: 720), wasEligible: false))
        XCTAssertTrue(MirrorRules.isEligible(window(.detached, width: 1400), wasEligible: false))
        XCTAssertFalse(MirrorRules.isEligible(window(.detached, session: nil, width: 1400), wasEligible: true))
    }

    /// Dragging an edge across the line must not subscribe and unsubscribe on every pixel.
    func testADetachedWindowKeepsItUntilItIsClearlyNarrower() {
        XCTAssertTrue(MirrorRules.isEligible(window(.detached, width: 719), wasEligible: true))
        XCTAssertTrue(MirrorRules.isEligible(window(.detached, width: 700), wasEligible: true))
        XCTAssertFalse(MirrorRules.isEligible(window(.detached, width: 699), wasEligible: true))
        XCTAssertFalse(MirrorRules.isEligible(window(.detached, width: 710), wasEligible: false), "it must first reach 720")
    }

    func testThePillNeverShowsIt() {
        for width in [300, 720, 2000] as [CGFloat] {
            XCTAssertFalse(MirrorRules.isEligible(window(.pill, width: width), wasEligible: true))
            XCTAssertFalse(MirrorRules.isEligible(window(.pill, width: width), wasEligible: false))
        }
    }

    func testSubscriptionsAreTheSessionsOfEligibleWindows() {
        let windows = [window(.shell, session: "a", id: "1"), window(.detached, session: "a", id: "2"), window(.detached, session: "b", id: "3")]
        XCTAssertEqual(MirrorRules.subscriptions(eligible: windows), ["a", "b"])
        XCTAssertEqual(MirrorRules.subscriptions(eligible: []), [])
    }

    func testASubscriptionAlsoCoversTheSessionsAWindowShowsTheWorkOf() {
        let main = MirrorWindow(id: "1", kind: .shell, sessionId: "dispatch", relatedSessionIds: ["c1", "c2", "dispatch", "c1"], width: 900)
        XCTAssertEqual(main.allSessionIds, ["dispatch", "c1", "c2"], "the window's own first, no repeats")
        XCTAssertEqual(MirrorRules.subscriptions(eligible: [main]), ["dispatch", "c1", "c2"])
        let narrow = MirrorWindow(id: "2", kind: .detached, sessionId: "x", relatedSessionIds: ["c3"], width: 500)
        XCTAssertFalse(MirrorRules.isEligible(narrow, wasEligible: false))
        XCTAssertEqual(MirrorRules.subscriptions(eligible: [main]), ["dispatch", "c1", "c2"], "an ineligible window is not passed in, so it adds nothing")
    }

    func testADispatchSessionListsTheNewestChildrenItShowsTheWorkOf() {
        var state = OrbSessionState()
        XCTAssertEqual(mirrorChildSessionIds(of: state), [])
        state.children = (1...12).map { ChildItem(sessionId: "c\($0)", title: "t", status: "running") }
        XCTAssertEqual(mirrorChildSessionIds(of: state), (5...12).map { "c\($0)" }, "capped at the newest eight")
    }

    /// The session's state is republished on every streamed chunk; the window's watch of its children must cost
    /// next to nothing per change and say something only when the children themselves change.
    func testTheChildrenStreamSpeaksOnlyWhenTheChildrenChange() {
        let subject = CurrentValueSubject<OrbSessionState, Never>(OrbSessionState())
        var seen: [[String]] = []
        let watch = subject.mirrorChildren.sink { seen.append($0) }
        XCTAssertEqual(seen, [[]])
        for i in 0..<1000 {
            var state = subject.value
            state.tasks = [TaskItem(id: "t\(i)", subject: "t\(i)", status: "pending")]
            subject.send(state)
        }
        XCTAssertEqual(seen, [[]], "a thousand changes to anything else: silence")
        var state = subject.value
        state.children = [ChildItem(sessionId: "c1", title: "a", status: "running")]
        subject.send(state)
        state.children[0].status = "completed"
        subject.send(state)
        XCTAssertEqual(seen, [[], ["c1"]], "a child's status change leaves the list of ids alone")
        withExtendedLifetime(watch) {}
    }

    // MARK: - The panel's geometry

    func testThePanelFollowsTheWindowsAspectWithinBounds() {
        XCTAssertEqual(mirrorPanelSize(windowSize: CGSize(width: 800, height: 600)).width, 320)
        XCTAssertEqual(mirrorPanelSize(windowSize: CGSize(width: 800, height: 600)).height, ((320 - 16) * 0.75 + 40).rounded())
        XCTAssertEqual(mirrorPanelSize(windowSize: CGSize(width: 1000, height: 100)).height, mirrorPanelMinHeight, "a thin window is not thinner than the floor")
        XCTAssertEqual(mirrorPanelSize(windowSize: CGSize(width: 300, height: 900)).height, mirrorPanelMaxHeight, "a tall one is capped")
        XCTAssertEqual(mirrorPanelSize(windowSize: .zero), CGSize(width: 320, height: mirrorPanelMinHeight))
    }

    func testThePanelSitsAtTheWindowsTopLeft() {
        let parent = NSRect(x: 100, y: 200, width: 900, height: 700)
        let frame = mirrorPanelFrame(parent: parent, size: CGSize(width: 320, height: 240))
        XCTAssertEqual(frame.minX, parent.minX + mirrorPanelInset)
        XCTAssertEqual(frame.maxY, parent.maxY - mirrorPanelInset, "its top edge is just under the window's top")
        XCTAssertEqual(frame.size, CGSize(width: 320, height: 240))
    }

    // MARK: - Targets

    func testTheAgentActingInATargetMakesItTheShownOne() {
        var tracker = MirrorTargetTracker()
        tracker.seed([.fake("a"), .fake("b"), .fake("c")])
        XCTAssertEqual(tracker.shown?.targetId, "c")
        XCTAssertTrue(tracker.activity(in: "a"))
        XCTAssertEqual(tracker.shown?.targetId, "a")
        XCTAssertEqual(tracker.targets.map(\.targetId), ["b", "c", "a"], "least recently active first")
        XCTAssertFalse(tracker.activity(in: "a"), "already on show")
        XCTAssertFalse(tracker.activity(in: "zzz"), "not a bound target")
        XCTAssertEqual(tracker.shown?.targetId, "a")
        XCTAssertTrue(tracker.released("a"))
        XCTAssertEqual(tracker.shown?.targetId, "c", "the target active before it takes over")
    }

    func testASizeThatReadsZeroKeepsTheLastRealOne() {
        var tracker = MirrorTargetTracker()
        tracker.seed([.fake("a", size: CGSize(width: 800, height: 600))])
        tracker.resize("a", to: .zero)
        XCTAssertEqual(tracker.shown?.windowSize, CGSize(width: 800, height: 600))
        tracker.resize("a", to: CGSize(width: 0, height: 300))
        XCTAssertEqual(tracker.shown?.windowSize, CGSize(width: 800, height: 600))
        tracker.bound(.fake("a", size: .zero))
        XCTAssertEqual(tracker.shown?.windowSize, CGSize(width: 800, height: 600), "bound again from another Space")
        tracker.resize("a", to: CGSize(width: 400, height: 300))
        XCTAssertEqual(tracker.shown?.windowSize, CGSize(width: 400, height: 300))
        tracker.bound(.fake("b", size: .zero))
        XCTAssertEqual(tracker.shown?.windowSize, .zero, "a target never seen with a size has none to keep")
    }

    func testANewTargetTakesTheMirrorAndOneAlreadyKnownOnlyRefreshes() {
        var tracker = MirrorTargetTracker()
        tracker.seed([.fake("a"), .fake("b")])
        XCTAssertEqual(tracker.shown?.targetId, "b", "subscribe's targets are read oldest first")
        tracker.bound(.fake("c"))
        XCTAssertEqual(tracker.shown?.targetId, "c", "a target bound for the first time is the one to watch")
        tracker.bound(.fake("a", app: "Mail"))
        XCTAssertEqual(tracker.shown?.targetId, "c", "the helper re-announces known targets on every bind: that moves nothing")
        XCTAssertEqual(tracker.targets.map(\.targetId), ["a", "b", "c"])
        XCTAssertEqual(tracker.targets.first?.appName, "Mail", "…but their facts are kept current")
        XCTAssertFalse(tracker.released("zzz"))
        XCTAssertTrue(tracker.released("c"))
        XCTAssertEqual(tracker.shown?.targetId, "b", "a released shown target falls back to the previous one")
        tracker.reset()
        XCTAssertNil(tracker.shown)
    }

    func testTheHelpersAnswerKeepsTheOrderAlreadyKnown() {
        var tracker = MirrorTargetTracker()
        tracker.seed([.fake("a"), .fake("b"), .fake("c")])
        XCTAssertTrue(tracker.activity(in: "a"))
        tracker.seed([.fake("a"), .fake("b"), .fake("c")]) // the helper answers sorted by id
        XCTAssertEqual(tracker.targets.map(\.targetId), ["b", "c", "a"], "the target the agent works in stays on show")
        tracker.seed([.fake("a"), .fake("c"), .fake("d")])
        XCTAssertEqual(tracker.targets.map(\.targetId), ["c", "a", "d"], "b is gone, d is new and goes last")
    }

    func testOnlyActionKindsCountAsTheAgentActing() {
        for kind in ["target", "press", "click", "doubleClick", "rightClick", "type", "paste", "setValue", "key", "scroll", "drag"] {
            XCTAssertTrue(MirrorTargetTracker.isActivity(kind: kind), kind)
        }
        for kind in ["idle", "done", "move", "waitBegin", "waitEnd", "caption", "refused", "foreground", "teleport", ""] {
            XCTAssertFalse(MirrorTargetTracker.isActivity(kind: kind), kind)
        }
    }

    func testASwitchNeedsTheOtherToActTwiceInARow() {
        var debounce = MirrorDebounce()
        XCTAssertFalse(debounce.act("b", leader: "a", now: 0), "one action somewhere else moves nothing")
        XCTAssertTrue(debounce.act("b", leader: "a", now: 0.1), "the second one does")
        XCTAssertFalse(debounce.act("b", leader: "a", now: 0.2), "and starts counting again")
        XCTAssertFalse(debounce.act("a", leader: "a", now: 0.3), "an action by the one on show…")
        XCTAssertFalse(debounce.act("b", leader: "a", now: 0.4), "…starts it over")
        XCTAssertFalse(debounce.act("c", leader: "a", now: 0.5), "a third thing is a new candidate")
        XCTAssertFalse(debounce.act("b", leader: "a", now: 0.6))
        XCTAssertFalse(debounce.act("b", leader: "a", now: 0.6 + MirrorDebounce.staleAfter + 1), "an old action does not count")
        XCTAssertTrue(debounce.act("b", leader: "a", now: 0.6 + MirrorDebounce.staleAfter + 1.5))
    }

    // MARK: - One session's model

    private final class TestClock {
        var t: TimeInterval = 100
    }

    private func state(targets: [HelperTarget] = [], clock: TestClock = TestClock()) -> (MirrorSessionState, RecordingSink) {
        let sink = RecordingSink()
        let state = MirrorSessionState(sessionId: "s1", sink: sink, focus: MirrorFocus(clock: { clock.t }))
        state.seed(targets)
        return (state, sink)
    }

    private func act(_ state: MirrorSessionState, _ target: String, _ kind: String = "press", at point: CGPoint = CGPoint(x: 1, y: 2)) {
        state.cursor(HelperCursor(sessionId: state.sessionId, targetId: target, kind: kind, point: point))
    }

    func testTheMirrorComesUpTheMomentATargetIsBound() {
        let (state, sink) = state()
        XCTAssertFalse(state.isVisible)
        state.bound(.fake("t1", app: "Notes"))
        XCTAssertTrue(state.isVisible, "no turn is needed: it shows whenever the session has an app bound")
        XCTAssertEqual(sink.log, ["show:Notes:800x600"])
    }

    // MARK: - Frames stopping, or the window reading size zero, never take it down

    func testFramesStoppingLeavesTheLastOneOnScreen() {
        let (state, sink) = state(targets: [.fake("a")])
        state.frame(.fake("s1", "a", seq: 1, bytes: 5))
        state.frame(.fake("s1", "a", seq: 2, bytes: 6))
        // …the target moves to another Space: no more frames, for as long as it takes.
        XCTAssertTrue(state.isVisible)
        XCTAssertNotNil(state.shownTarget)
        XCTAssertEqual(sink.log, ["show:Notes:800x600", "frame:5:720x540", "frame:6:720x540"], "no clear, nothing replaced")
    }

    func testAFrameThatReadsSizeZeroKeepsThePanelAndThePicture() {
        let (state, sink) = state(targets: [.fake("a", size: CGSize(width: 800, height: 600))])
        let before = state.panelSize
        state.frame(.fake("s1", "a", bytes: 8, size: .zero))
        XCTAssertEqual(state.shownTarget?.windowSize, CGSize(width: 800, height: 600))
        XCTAssertEqual(state.panelSize, before, "the panel does not jump to the default size")
        XCTAssertTrue(state.isVisible)
        XCTAssertEqual(sink.log, ["show:Notes:800x600", "frame:8:720x540"])
    }

    func testATargetBoundAgainWithSizeZeroKeepsTheSizeAndTheMirror() {
        let (state, sink) = state(targets: [.fake("a", size: CGSize(width: 800, height: 600))])
        let before = state.panelSize
        state.bound(.fake("a", size: .zero))
        XCTAssertTrue(state.isVisible)
        XCTAssertEqual(state.panelSize, before)
        XCTAssertEqual(sink.log, ["show:Notes:800x600"], "nothing told the sink to clear or resize")
    }

    func testATargetWhoseWindowIsOnAnotherSpaceStillShowsFromTheStart() {
        let (state, sink) = state(targets: [.fake("a", size: .zero)])
        XCTAssertTrue(state.isVisible)
        XCTAssertEqual(state.panelSize, CGSize(width: mirrorPanelWidth, height: mirrorPanelMinHeight))
        XCTAssertEqual(sink.log, ["show:Notes:0x0"])
        state.frame(.fake("s1", "a", bytes: 4, size: CGSize(width: 640, height: 480)))
        XCTAssertEqual(state.shownTarget?.windowSize, CGSize(width: 640, height: 480), "its real size arrives with the first frame")
    }

    func testFramesAndCursorsForTheShownTargetAreApplied() {
        let (state, sink) = state(targets: [.fake("old", app: "Mail"), .fake("new", app: "Notes")])
        XCTAssertEqual(sink.log, ["show:Notes:800x600", "others:1"], "the last of the seeded targets is the one shown")
        state.frame(.fake("s1", "new", bytes: 9))
        act(state, "new", "press", at: CGPoint(x: 5, y: 6))
        act(state, "old", "idle")
        XCTAssertEqual(sink.log, ["show:Notes:800x600", "others:1", "frame:9:720x540", "cursor:press:5,6"],
                       "a rest in the other target neither switches nor draws")
    }

    func testOneActionInAnotherTargetMovesNothingButTwoInARowDo() {
        let (state, sink) = state(targets: [.fake("a", app: "Mail"), .fake("b", app: "Notes")])
        state.frame(.fake("s1", "a", bytes: 7))
        let before = state.recency
        let count = sink.log.count
        act(state, "a", "press")
        XCTAssertEqual(state.shownTarget?.targetId, "b", "one action is not enough")
        XCTAssertEqual(sink.log.count, count)
        act(state, "a", "type", at: CGPoint(x: 5, y: 6))
        XCTAssertEqual(state.shownTarget?.targetId, "a")
        XCTAssertEqual(sink.log.suffix(4), ["show:Mail:800x600", "reset", "frame:7:720x540", "cursor:type:5,6"],
                       "the previous app's picture is dropped, a's own newest frame is up at once, the cursor lands in it")
        XCTAssertFalse(sink.log.contains("clear"), "a switch never takes the panel down")
        XCTAssertEqual(state.recency, before, "it already led the window: changing target inside it re-stamps nothing")
        XCTAssertTrue(state.isVisible)
    }

    func testWaitsCaptionsAndRestsNeverMoveTheMirror() {
        let (state, sink) = state(targets: [.fake("a", app: "Mail"), .fake("b", app: "Notes")])
        let count = sink.log.count
        for _ in 0..<4 {
            for kind in ["waitBegin", "waitEnd", "caption", "idle", "done", "move", "refused", "foreground"] { act(state, "a", kind) }
        }
        XCTAssertEqual(state.shownTarget?.targetId, "b")
        XCTAssertEqual(sink.log.count, count, "and they are not drawn for a target that is not on show")
    }

    func testItStaysOnATargetUntilAnotherBoundTargetActsTwice() {
        let (state, sink) = state(targets: [.fake("a", app: "Mail"), .fake("b", app: "Notes")])
        act(state, "a"); act(state, "a")
        XCTAssertEqual(state.shownTarget?.targetId, "a")
        let count = sink.log.count
        for kind in ["idle", "done", "waitBegin"] { act(state, "b", kind) }
        XCTAssertEqual(state.shownTarget?.targetId, "a", "the other app resting or waiting does not take it back")
        XCTAssertEqual(sink.log.count, count)
        act(state, "b", "key")
        act(state, "a", "type") // the one on show acts in between: b starts over
        act(state, "b", "key")
        XCTAssertEqual(state.shownTarget?.targetId, "a")
        act(state, "b", "scroll")
        XCTAssertEqual(state.shownTarget?.targetId, "b", "now it is working in b")
    }

    func testASwitchToATargetThatNeverHadAFrameShowsGreyNotTheOldPicture() {
        let (state, sink) = state(targets: [.fake("a", app: "Mail"), .fake("b", app: "Notes")])
        state.frame(.fake("s1", "b", bytes: 9))
        act(state, "a"); act(state, "a")
        XCTAssertEqual(sink.log.suffix(3), ["show:Mail:800x600", "reset", "cursor:press:1,2"], "reset, and no frame to put up")
        XCTAssertFalse(sink.log.contains("clear"))
    }

    func testTheNewestFrameOfEachTargetIsTheOneItShowsWhenItTakesOver() {
        let (state, sink) = state(targets: [.fake("a", app: "Mail"), .fake("b", app: "Notes")])
        state.frame(.fake("s1", "a", seq: 1, bytes: 5))
        state.frame(.fake("s1", "a", seq: 2, bytes: 6))
        state.frame(.fake("s1", "b", seq: 1, bytes: 9))
        act(state, "a"); act(state, "a")
        XCTAssertEqual(sink.log.filter { $0.hasPrefix("frame:") }, ["frame:9:720x540", "frame:6:720x540"])
        act(state, "b", "type"); act(state, "b", "type")
        XCTAssertEqual(sink.log.filter { $0.hasPrefix("frame:") }.last, "frame:9:720x540", "and back to b's own")
    }

    func testACursorOrFrameForATargetThatIsNotBoundChangesNothing() {
        let (state, sink) = state(targets: [.fake("a")])
        act(state, "ghost"); act(state, "ghost")
        state.frame(.fake("s1", "ghost", bytes: 3))
        XCTAssertEqual(sink.log, ["show:Notes:800x600"])
    }

    func testTheCaptionSaysHowManyOtherTargetsAreBound() {
        let (state, sink) = state()
        state.bound(.fake("a", app: "Notes"))
        XCTAssertEqual(sink.log, ["show:Notes:800x600"], "one target: no badge")
        XCTAssertEqual(state.otherTargets, 0)
        state.bound(.fake("b", app: "Mail"))
        XCTAssertEqual(state.otherTargets, 1)
        XCTAssertEqual(sink.log.suffix(3), ["show:Mail:800x600", "reset", "others:1"], "the newly bound app is on show, with +1")
        state.bound(.fake("c", app: "Finder"))
        XCTAssertEqual(state.otherTargets, 2)
        XCTAssertEqual(sink.log.last, "others:2")
        state.released("a")
        XCTAssertEqual(state.otherTargets, 1)
        XCTAssertEqual(sink.log.last, "others:1", "releasing one that was not on show")
        state.released("c")
        XCTAssertEqual(state.otherTargets, 0)
        XCTAssertEqual(sink.log.suffix(3), ["show:Mail:800x600", "reset", "others:0"], "c was on show; b, active before it, takes over with no badge left")
        XCTAssertFalse(sink.log.contains("clear"))
    }

    func testReleasingTheShownTargetFallsBackThenClears() {
        let (state, sink) = state(targets: [.fake("a", app: "Mail"), .fake("b", app: "Notes")])
        state.released("b")
        XCTAssertEqual(state.shownTarget?.targetId, "a")
        XCTAssertTrue(state.isVisible)
        XCTAssertEqual(sink.log, ["show:Notes:800x600", "others:1", "show:Mail:800x600", "reset", "others:0"],
                       "the previous target takes over, with no badge left")
        XCTAssertEqual(state.otherTargets, 0)
        state.released("a")
        XCTAssertFalse(state.isVisible)
        XCTAssertEqual(sink.log.last, "clear")
        state.released("a")
        XCTAssertEqual(sink.log.filter { $0 == "clear" }.count, 1, "releasing nothing changes nothing")
    }

    func testReleasingAnotherTargetLeavesTheShownOne() {
        let (state, sink) = state(targets: [.fake("a"), .fake("b")])
        state.released("a")
        XCTAssertEqual(state.shownTarget?.targetId, "b")
        XCTAssertEqual(sink.log, ["show:Notes:800x600", "others:1", "others:0"])
    }

    // MARK: - Frames and cursors invalidate nothing

    /// A burst of frames and cursor events that change what is SHOWN nowhere: the sink takes every one, and
    /// nothing `@Published` on the state moves — so nothing that observes it is invalidated per frame.
    func testFramesAndCursorsPublishNothingOnTheState() {
        let (state, sink) = state(targets: [.fake("a", app: "Mail"), .fake("b", app: "Notes")])
        var publishes = 0
        let watch = state.objectWillChange.sink { publishes += 1 }
        for i in 1...100 {
            state.frame(.fake("s1", "b", seq: i, bytes: 8))
            state.frame(.fake("s1", "a", seq: i, bytes: 8)) // kept, not drawn
            act(state, "b", ["move", "press", "type", "waitBegin", "idle"][i % 5])
            act(state, "a", ["waitBegin", "idle", "caption", "move"][i % 4]) // never moves the mirror
        }
        XCTAssertEqual(publishes, 0)
        XCTAssertEqual(sink.log.filter { $0.hasPrefix("frame:") }.count, 100, "one apply per frame of the shown target, none for the other")
        withExtendedLifetime(watch) {}
    }

    func testOneFrameOfUnchangedSizeIsExactlyOneApplyAndNoPublish() {
        let (state, sink) = state(targets: [.fake("a", size: CGSize(width: 800, height: 600))])
        var publishes = 0
        let watch = state.objectWillChange.sink { publishes += 1 }
        let before = sink.log.count
        state.frame(.fake("s1", "a", bytes: 5, size: CGSize(width: 800, height: 600)))
        XCTAssertEqual(sink.log.count, before + 1)
        XCTAssertEqual(publishes, 0)
        state.frame(.fake("s1", "a", bytes: 5, size: CGSize(width: 640, height: 480)))
        XCTAssertEqual(publishes, 1, "a real resize is the one frame that changes what is shown")
        withExtendedLifetime(watch) {}
    }

    /// The helper re-announces `view.bound` on every call it makes: for a target already known, with nothing different,
    /// that is nothing — no call on the sink, no publish, no change of who has the window.
    func testARepeatBindOfTheSameTargetIsANoOp() {
        let (state, sink) = state(targets: [.fake("a", app: "Mail"), .fake("b", app: "Notes")])
        let log = sink.log
        let recency = state.recency
        var publishes = 0
        let watch = state.objectWillChange.sink { publishes += 1 }
        for _ in 0..<20 {
            state.bound(.fake("b", app: "Notes"))
            state.bound(.fake("a", app: "Mail")) // the other one, announced again, is no more a switch
        }
        XCTAssertEqual(sink.log, log)
        XCTAssertEqual(publishes, 0)
        XCTAssertEqual(state.recency, recency)
        XCTAssertEqual(state.shownTarget?.targetId, "b")
        withExtendedLifetime(watch) {}
    }

    /// A new size for the same target: the mirror resizes where it stands — one `show` with the new size, never a clear
    /// or a reset (which would put the grey placeholder up) — and a size that reads zero changes nothing.
    func testASizeChangeIsAnInPlaceResizeWithNoClear() {
        let (state, sink) = state(targets: [.fake("a", size: CGSize(width: 800, height: 600))])
        state.frame(.fake("s1", "a", bytes: 5))
        let before = state.panelSize
        state.bound(.fake("a", size: CGSize(width: 1000, height: 400)))
        XCTAssertEqual(sink.log, ["show:Notes:800x600", "frame:5:720x540", "show:Notes:1000x400"])
        XCTAssertFalse(sink.log.contains("clear"))
        XCTAssertFalse(sink.log.contains("reset"))
        XCTAssertNotEqual(state.panelSize, before)
        state.bound(.fake("a", size: .zero))
        XCTAssertEqual(sink.log.count, 3, "a size that reads zero is a no-op")
        XCTAssertEqual(state.shownTarget?.windowSize, CGSize(width: 1000, height: 400))
    }

    func testAFramesNewWindowSizeResizesThePanel() {
        let (state, _) = state(targets: [.fake("a", size: CGSize(width: 800, height: 600))])
        let before = state.panelSize
        state.frame(.fake("s1", "a", size: CGSize(width: 800, height: 300)))
        XCTAssertEqual(state.shownTarget?.windowSize, CGSize(width: 800, height: 300))
        XCTAssertNotEqual(state.panelSize, before)
    }

    func testResetClearsTheMirror() {
        let (state, sink) = state(targets: [.fake("a")])
        state.reset()
        XCTAssertNil(state.shownTarget)
        XCTAssertFalse(state.isVisible)
        XCTAssertEqual(sink.log.last, "clear")
    }

    // MARK: - The coordinator

    private struct Rig {
        let coordinator: MirrorCoordinator
        let client: FakeHelperClient
        let sinks: SinkBook
        let sleeps: SleepLog
        let clock: TestClock
    }

    private final class SinkBook {
        var byId: [String: RecordingSink] = [:]
    }

    private final class SleepLog: @unchecked Sendable {
        private let lock = NSLock()
        private var _delays: [Double] = []
        var delays: [Double] { lock.withLock { _delays } }
        func add(_ d: Double) { lock.withLock { _delays.append(d) } }
    }

    private func rig(clock: TestClock = TestClock()) -> Rig {
        let client = FakeHelperClient()
        let sinks = SinkBook()
        let sleeps = SleepLog()
        let coordinator = MirrorCoordinator(
            client: client,
            makeSink: { id in let sink = RecordingSink(); sinks.byId[id] = sink; return sink },
            sleep: { duration in
                let (s, a) = duration.components
                sleeps.add(Double(s) + Double(a) / 1e18)
                await Task.yield()
            },
            now: { clock.t })
        return Rig(coordinator: coordinator, client: client, sinks: sinks, sleeps: sleeps, clock: clock)
    }

    func testAnOpenWindowSubscribesOnceAndNothingIsConnectedBefore() async {
        let r = rig()
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertTrue(r.client.calls.isEmpty, "no window, no connection")

        r.coordinator.setWindow(window(.shell, session: "s1", id: "shell"))
        let done = await eventually { r.client.calls == ["connect", "subscribe:s1"] }
        XCTAssertTrue(done, "\(r.client.calls)")
        XCTAssertTrue(r.coordinator.isConnected)
        XCTAssertEqual(r.coordinator.applied, ["s1"])
    }

    func testTwoWindowsOnOneSessionShareOneSubscriptionAndTheLastCloseDisconnects() async {
        let r = rig()
        r.coordinator.setWindow(window(.shell, session: "s1", id: "shell"))
        r.coordinator.setWindow(window(.detached, session: "s1", width: 900, id: "det"))
        await expect({ r.client.count("subscribe:s1") == 1 })
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(r.client.count("subscribe:s1"), 1)
        XCTAssertEqual(r.client.count("connect"), 1)

        r.coordinator.removeWindow(id: "det")
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(r.client.count("unsubscribe:s1"), 0, "another window still shows the session")
        XCTAssertTrue(r.coordinator.isConnected)

        r.coordinator.removeWindow(id: "shell")
        await expect({ r.client.calls.contains("disconnect") }, "\(r.client.calls)")
        XCTAssertFalse(r.coordinator.isConnected)
        XCTAssertTrue(r.coordinator.applied.isEmpty)
    }

    func testSwitchingSessionUnsubscribesTheOldAndSubscribesTheNew() async {
        let r = rig()
        r.coordinator.setWindow(window(.shell, session: "a", id: "shell"))
        await expect({ r.client.count("subscribe:a") == 1 })
        r.coordinator.setWindow(window(.shell, session: "b", id: "shell"))
        await expect({ r.client.count("subscribe:b") == 1 && r.client.count("unsubscribe:a") == 1 }, "\(r.client.calls)")
        XCTAssertEqual(r.coordinator.applied, ["b"])
        XCTAssertEqual(r.client.count("connect"), 1, "a switch keeps the connection")

        r.coordinator.setWindow(window(.shell, session: nil, id: "shell"))
        await expect({ r.client.count("unsubscribe:b") == 1 && r.client.count("disconnect") == 1 })
    }

    func testResizingADetachedWindowAcrossTheThresholdSubscribesAndUnsubscribes() async {
        let r = rig()
        r.coordinator.setWindow(window(.detached, session: "s1", width: 600, id: "det"))
        try? await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertTrue(r.client.calls.isEmpty, "too narrow: nothing is even connected")

        r.coordinator.setWindow(window(.detached, session: "s1", width: 720, id: "det"))
        await expect({ r.client.count("subscribe:s1") == 1 })

        r.coordinator.setWindow(window(.detached, session: "s1", width: 705, id: "det"))
        try? await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertEqual(r.client.count("unsubscribe:s1"), 0, "inside the hysteresis band it holds")

        r.coordinator.setWindow(window(.detached, session: "s1", width: 699, id: "det"))
        await expect({ r.client.count("unsubscribe:s1") == 1 && r.client.count("disconnect") == 1 })

        r.coordinator.setWindow(window(.detached, session: "s1", width: 715, id: "det"))
        try? await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertEqual(r.client.count("subscribe:s1"), 1, "and it must reach 720 again")
        r.coordinator.setWindow(window(.detached, session: "s1", width: 720, id: "det"))
        await expect({ r.client.count("subscribe:s1") == 2 })
    }

    func testThePillNeverSubscribes() async {
        let r = rig()
        r.coordinator.setWindow(window(.pill, session: "s1", width: 1200, id: "pill"))
        try? await Task.sleep(nanoseconds: 80_000_000)
        XCTAssertTrue(r.client.calls.isEmpty)
        XCTAssertFalse(r.coordinator.isEligible(windowId: "pill"))
    }

    func testAMissingSocketIsRetriedQuietlyWithBackoffAndNeverLaunchesAnything() async {
        let r = rig()
        r.client.scriptConnect([.socketMissing, .socketMissing, .socketMissing, .socketMissing, .socketMissing, .socketMissing, .socketMissing, .socketMissing, nil])
        r.coordinator.setWindow(window(.shell, session: "s1", id: "shell"))
        await expect({ r.client.count("subscribe:s1") == 1 }, "\(r.client.calls)")
        XCTAssertEqual(r.client.count("connect"), 9)
        XCTAssertEqual(r.sleeps.delays.prefix(8).map { $0 }, [0.5, 1, 2, 4, 8, 10, 10, 10], "doubling, capped at ten seconds")
        XCTAssertEqual(r.client.count("subscribe:s1"), 1, "nothing is subscribed before the connection")
    }

    func testRetryingStopsWhenTheWindowGoesAway() async {
        let r = rig()
        r.client.scriptConnect(Array(repeating: HelperClientError.socketMissing, count: 500))
        r.coordinator.setWindow(window(.shell, session: "s1", id: "shell"))
        await expect({ r.client.count("connect") >= 3 })
        r.coordinator.removeWindow(id: "shell")
        try? await Task.sleep(nanoseconds: 100_000_000)
        let settled = r.client.count("connect")
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(r.client.count("connect"), settled, "no window wants the mirror: no more attempts")
    }

    func testAMismatchIsNotRetried() async {
        let r = rig()
        r.client.scriptConnect([.protocolMismatch(helper: 2, client: 1)])
        r.coordinator.setWindow(window(.shell, session: "s1", id: "shell"))
        await expect({ r.coordinator.isBlocked })
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(r.client.count("connect"), 1)
        XCTAssertTrue(r.sleeps.delays.isEmpty, "a mismatch is not waited out")
        XCTAssertEqual(r.client.count("subscribe:s1"), 0)
    }

    func testALostConnectionReconnectsAndSubscribesEverythingAgain() async {
        let r = rig()
        r.client.setTargets([.fake("t1", app: "Notes")], for: "a")
        r.coordinator.setWindow(window(.shell, session: "a", id: "shell"))
        r.coordinator.setWindow(window(.detached, session: "b", width: 900, id: "det"))
        await expect({ r.coordinator.applied == ["a", "b"] })
        await expect({ r.sinks.byId["a"]?.log == ["show:Notes:800x600"] })

        r.client.push(.connectionLost)
        await expect({ r.client.count("connect") == 2 && r.coordinator.applied == ["a", "b"] }, "\(r.client.calls)")
        XCTAssertEqual(r.client.count("subscribe:a"), 2)
        XCTAssertEqual(r.client.count("subscribe:b"), 2)
        // The helper re-sent its bound targets with the new subscription, so the mirror is back.
        XCTAssertEqual(r.sinks.byId["a"]?.log, ["show:Notes:800x600", "clear", "show:Notes:800x600"])
    }

    func testASubscribeFailureStartsOverFromTheConnection() async {
        let r = rig()
        r.client.failSubscribe(with: .notConnected)
        r.coordinator.setWindow(window(.shell, session: "s1", id: "shell"))
        await expect({ r.client.count("connect") >= 2 }, "\(r.client.calls)")
        r.client.failSubscribe(with: nil)
        await expect({ r.coordinator.applied == ["s1"] })
    }

    // MARK: - The main window needs no other window

    /// A target bound for `session`, the main window open on it — no turn, no detached window, no pill.
    private func mainWindowAlone(_ r: Rig, session: String = "s1", related: [String] = [], targets: [HelperTarget] = [.fake("t1")], visible: Bool = true) async {
        r.client.setTargets(targets, for: session)
        r.coordinator.setWindow(MirrorWindow(id: "shell", kind: .shell, sessionId: session, relatedSessionIds: related, width: 900, isVisible: visible))
        await expect({ r.coordinator.applied.contains(session) && (targets.isEmpty || r.coordinator.state(for: session).isVisible) }, "\(r.client.calls)")
    }

    func testTheMainWindowAloneShowsTheMirrorOfItsSessionWithFrames() async {
        let r = rig()
        await mainWindowAlone(r, targets: [.fake("t1", app: "Notes")])
        XCTAssertEqual(r.coordinator.desiredSessions, ["s1"])
        XCTAssertEqual(r.coordinator.shownSession(forWindow: "shell"), "s1")
        XCTAssertEqual(r.sinks.byId["s1"]?.log, ["show:Notes:800x600"], "up with a target bound — no turn was ever started")
        await expect({ r.coordinator.isReceivingFrames(sessionId: "s1") })
        XCTAssertEqual(r.client.frameFlags(for: "s1").last, true)
        XCTAssertEqual(r.client.count("connect"), 1)

        r.client.push(.frame(.fake("s1", "t1", bytes: 9)))
        await expect({ r.sinks.byId["s1"]?.log.last == "frame:9:720x540" }, "\(r.sinks.byId["s1"]?.log ?? [])")
    }

    func testItAsksForFramesFromTheFirstSubscribeSoNothingWaitsOnAResubscribe() async {
        let r = rig()
        r.coordinator.setWindow(window(.shell, session: "s1", id: "shell"))
        await expect({ r.coordinator.applied == ["s1"] })
        XCTAssertEqual(r.client.frameFlags(for: "s1"), [true], "visible and nothing bound yet: ready for the first target")
        r.client.push(.bound(sessionId: "s1", target: .fake("t1")))
        await expect({ r.coordinator.shownSession(forWindow: "shell") == "s1" })
        try? await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertEqual(r.client.frameFlags(for: "s1"), [true], "binding a target changes nothing about what was asked")
    }

    func testBetweenTurnsTheMirrorStaysUpAndFramesKeepComing() async {
        let r = rig()
        await mainWindowAlone(r)
        r.client.push(.frame(.fake("s1", "t1", seq: 1, bytes: 5)))
        // …the turn ends here; the window is told nothing, because it never was told about turns.
        try? await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertTrue(r.coordinator.state(for: "s1").isVisible)
        XCTAssertTrue(r.coordinator.isReceivingFrames(sessionId: "s1"))
        r.client.push(.frame(.fake("s1", "t1", seq: 2, bytes: 6)))
        await expect({ r.sinks.byId["s1"]?.log.last == "frame:6:720x540" })
    }

    func testOnlyTheHelperReleasingTheTargetTakesTheMirrorDown() async {
        let r = rig()
        await mainWindowAlone(r)
        r.client.push(.released(sessionId: "s1", targetId: "t1"))
        await expect({ r.coordinator.shownSession(forWindow: "shell") == nil })
        XCTAssertEqual(r.sinks.byId["s1"]?.log.last, "clear")
        await expect({ !r.coordinator.isReceivingFrames(sessionId: "s1") || r.coordinator.wantsFrames("s1") })
        r.client.push(.bound(sessionId: "s1", target: .fake("t2", app: "Mail")))
        await expect({ r.coordinator.shownSession(forWindow: "shell") == "s1" })
        XCTAssertEqual(r.sinks.byId["s1"]?.log.last, "show:Mail:800x600", "and the next app brings it back")
    }

    func testAHiddenWindowShowsNothingAndGetsNoFramesAnExposedOneDoes() async {
        let r = rig()
        await mainWindowAlone(r, visible: false)
        try? await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertFalse(r.coordinator.isReceivingFrames(sessionId: "s1"), "minimized, ordered out or covered: no frames")

        r.coordinator.setWindow(MirrorWindow(id: "shell", kind: .shell, sessionId: "s1", width: 900, isVisible: true))
        await expect({ r.coordinator.isReceivingFrames(sessionId: "s1") })
        r.coordinator.setWindow(MirrorWindow(id: "shell", kind: .shell, sessionId: "s1", width: 900, isVisible: false))
        await expect({ !r.coordinator.isReceivingFrames(sessionId: "s1") })
        XCTAssertEqual(r.client.count("connect"), 1)
        XCTAssertTrue(r.coordinator.isConnected, "bound and cursor are still wanted")
    }

    func testClosingTheMainWindowOrSwitchingSessionTakesItDown() async {
        let r = rig()
        await mainWindowAlone(r, session: "a")
        r.client.setTargets([], for: "b")
        r.coordinator.setWindow(MirrorWindow(id: "shell", kind: .shell, sessionId: "b", width: 900))
        await expect({ r.coordinator.applied == ["b"] }, "\(r.client.calls)")
        XCTAssertNil(r.coordinator.shownSession(forWindow: "shell"), "the new session has nothing bound")
        r.coordinator.removeWindow(id: "shell")
        await expect({ !r.coordinator.isConnected })
        XCTAssertNil(r.coordinator.shownSession(forWindow: "shell"))
    }

    func testANarrowDetachedWindowDoesNotGetItButTheMainWindowBesideItDoes() async {
        let r = rig()
        r.coordinator.setWindow(window(.detached, session: "s1", width: 500, id: "det"))
        await mainWindowAlone(r)
        XCTAssertEqual(r.coordinator.shownSession(forWindow: "shell"), "s1")
        XCTAssertNil(r.coordinator.shownSession(forWindow: "det"), "too narrow")
        XCTAssertTrue(r.coordinator.isReceivingFrames(sessionId: "s1"))
    }

    func testAFloatingWindowOnTheSameSessionChangesNothingForTheMainWindow() async {
        let r = rig()
        await mainWindowAlone(r)
        r.coordinator.setWindow(window(.detached, session: "s1", width: 900, id: "det"))
        r.coordinator.setWindow(window(.pill, session: "s1", width: 900, id: "pill"))
        try? await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertEqual(r.coordinator.shownSession(forWindow: "shell"), "s1")
        r.coordinator.removeWindow(id: "det")
        r.coordinator.removeWindow(id: "pill")
        try? await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertEqual(r.coordinator.shownSession(forWindow: "shell"), "s1", "and closing them takes nothing away")
        XCTAssertTrue(r.coordinator.isReceivingFrames(sessionId: "s1"))
        XCTAssertEqual(r.client.count("subscribe:s1"), 1)
        XCTAssertEqual(r.client.count("connect"), 1)
    }

    // MARK: - A Dispatch window shows its children's mirrors

    func testAReconnectBringsTheMirrorBackWithFrames() async {
        let r = rig()
        await mainWindowAlone(r)
        r.client.push(.connectionLost)
        await expect({ r.client.count("connect") == 2 && r.coordinator.applied == ["s1"] }, "\(r.client.calls)")
        await expect({ r.coordinator.state(for: "s1").isVisible && r.coordinator.isReceivingFrames(sessionId: "s1") })
        XCTAssertEqual(r.sinks.byId["s1"]?.log, ["show:Notes:800x600", "clear", "show:Notes:800x600"])
    }

    func testADispatchMainWindowShowsTheMirrorOfTheChildThatUsesTheComputer() async {
        let r = rig()
        r.client.setTargets([.fake("t1", app: "Safari")], for: "child1")
        r.coordinator.setWindow(MirrorWindow(id: "shell", kind: .shell, sessionId: "dispatch", relatedSessionIds: ["child1"], width: 900))
        await expect({ r.coordinator.applied == ["dispatch", "child1"] }, "\(r.client.calls)")
        await expect({ r.coordinator.shownSession(forWindow: "shell") == "child1" })
        XCTAssertEqual(r.sinks.byId["child1"]?.log, ["show:Safari:800x600"])
        XCTAssertEqual(r.client.frameFlags(for: "child1"), [true], "the first request already asks for frames")
        XCTAssertEqual(r.client.frameFlags(for: "dispatch"), [true])
        r.client.push(.frame(.fake("child1", "t1", bytes: 8)))
        await expect({ r.sinks.byId["child1"]?.log.last == "frame:8:720x540" })
    }

    func testEverySessionAVisibleWindowWatchesIsAskedForFramesFromTheFirstSubscribe() async {
        let r = rig()
        r.coordinator.setWindow(MirrorWindow(id: "shell", kind: .shell, sessionId: "d", relatedSessionIds: ["c1", "c2"], width: 900, isVisible: false))
        await expect({ r.coordinator.applied == ["d", "c1", "c2"] })
        for id in ["d", "c1", "c2"] { XCTAssertEqual(r.client.frameFlags(for: id), [false], "covered: bound and cursor only") }
        r.coordinator.setWindow(MirrorWindow(id: "shell", kind: .shell, sessionId: "d", relatedSessionIds: ["c1", "c2"], width: 900, isVisible: true))
        await expect({ ["d", "c1", "c2"].allSatisfy { r.coordinator.isReceivingFrames(sessionId: $0) } })
        for id in ["d", "c1", "c2"] { XCTAssertEqual(r.client.frameFlags(for: id), [false, true], id) }
        XCTAssertEqual(r.client.count("connect"), 1)
    }

    func testTheNewestBoundChildIsOnShowAndWhichOneIsNeverARestartOnTheHelper() async {
        let r = rig()
        r.coordinator.setWindow(MirrorWindow(id: "shell", kind: .shell, sessionId: "dispatch", relatedSessionIds: ["c1", "c2"], width: 900))
        await expect({ r.coordinator.applied == ["dispatch", "c1", "c2"] })
        r.client.push(.bound(sessionId: "c1", target: .fake("a", app: "Mail")))
        await expect({ r.coordinator.shownSession(forWindow: "shell") == "c1" })
        r.client.push(.bound(sessionId: "c2", target: .fake("b", app: "Notes")))
        await expect({ r.coordinator.shownSession(forWindow: "shell") == "c2" }, "the newest one is on show")
        r.client.push(.released(sessionId: "c2", targetId: "b"))
        await expect({ r.coordinator.shownSession(forWindow: "shell") == "c1" })
        r.client.push(.released(sessionId: "c1", targetId: "a"))
        await expect({ r.coordinator.shownSession(forWindow: "shell") == nil })
        try? await Task.sleep(nanoseconds: 60_000_000)
        for id in ["dispatch", "c1", "c2"] { XCTAssertEqual(r.client.count("subscribe:\(id)"), 1, "\(id): changing hands re-subscribes nobody") }
    }

    func testAChildSpawnedLaterIsSubscribedWithoutDisturbingTheMirrorOnShow() async {
        let r = rig()
        r.client.setTargets([.fake("t1")], for: "c1")
        r.coordinator.setWindow(MirrorWindow(id: "shell", kind: .shell, sessionId: "dispatch", relatedSessionIds: ["c1"], width: 900))
        await expect({ r.coordinator.shownSession(forWindow: "shell") == "c1" })
        r.coordinator.setWindow(MirrorWindow(id: "shell", kind: .shell, sessionId: "dispatch", relatedSessionIds: ["c1", "c2"], width: 900))
        await expect({ r.coordinator.applied == ["dispatch", "c1", "c2"] })
        XCTAssertEqual(r.coordinator.shownSession(forWindow: "shell"), "c1")
        XCTAssertEqual(r.client.count("subscribe:c1"), 1)
        XCTAssertEqual(r.client.frameFlags(for: "c2"), [true])
    }

    func testAChildActingTwiceInARowTakesTheWindowAndOneActionDoesNot() async {
        let r = rig()
        r.coordinator.setWindow(MirrorWindow(id: "shell", kind: .shell, sessionId: "dispatch", relatedSessionIds: ["c1", "c2"], width: 900))
        await expect({ r.coordinator.applied == ["dispatch", "c1", "c2"] })
        r.client.push(.bound(sessionId: "c1", target: .fake("a", app: "Mail")))
        await expect({ r.coordinator.shownSession(forWindow: "shell") == "c1" })
        r.client.push(.bound(sessionId: "c2", target: .fake("b", app: "Notes")))
        await expect({ r.coordinator.shownSession(forWindow: "shell") == "c2" })

        r.client.push(.cursor(HelperCursor(sessionId: "c1", targetId: "a", kind: "waitBegin", point: CGPoint(x: 1, y: 2))))
        r.client.push(.cursor(HelperCursor(sessionId: "c1", targetId: "a", kind: "waitBegin", point: CGPoint(x: 1, y: 2))))
        r.client.push(.cursor(HelperCursor(sessionId: "c1", targetId: "a", kind: "press", point: CGPoint(x: 1, y: 2))))
        try? await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertEqual(r.coordinator.shownSession(forWindow: "shell"), "c2", "waits and a single action move nothing")

        r.client.push(.cursor(HelperCursor(sessionId: "c1", targetId: "a", kind: "type", point: CGPoint(x: 1, y: 2))))
        await expect({ r.coordinator.shownSession(forWindow: "shell") == "c1" }, "c1 is where the work is now")

        r.client.push(.cursor(HelperCursor(sessionId: "c2", targetId: "b", kind: "idle", point: CGPoint(x: 1, y: 2))))
        r.client.push(.cursor(HelperCursor(sessionId: "c2", targetId: "b", kind: "key", point: CGPoint(x: 1, y: 2))))
        try? await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertEqual(r.coordinator.shownSession(forWindow: "shell"), "c1", "a rest and one action are not a switch")
        r.client.push(.cursor(HelperCursor(sessionId: "c2", targetId: "b", kind: "scroll", point: CGPoint(x: 1, y: 2))))
        await expect({ r.coordinator.shownSession(forWindow: "shell") == "c2" })
        XCTAssertEqual(r.client.count("subscribe:c1"), 1, "and not one of those moves restarted anything on the helper")
        XCTAssertEqual(r.client.count("subscribe:c2"), 1)
    }

    func testTwoAppsInOneSessionFollowTheAgentThroughTheCoordinator() async {
        let r = rig()
        await mainWindowAlone(r, targets: [.fake("a", app: "Mail"), .fake("b", app: "Notes")])
        XCTAssertEqual(r.sinks.byId["s1"]?.log, ["show:Notes:800x600", "others:1"])
        r.client.push(.frame(.fake("s1", "a", bytes: 7)))
        r.client.push(.frame(.fake("s1", "b", bytes: 9)))
        r.client.push(.cursor(HelperCursor(sessionId: "s1", targetId: "a", kind: "press", point: CGPoint(x: 5, y: 6))))
        r.client.push(.cursor(HelperCursor(sessionId: "s1", targetId: "a", kind: "type", point: CGPoint(x: 5, y: 6))))
        await expect({ r.sinks.byId["s1"]?.log.last == "cursor:type:5,6" }, "\(r.sinks.byId["s1"]?.log ?? [])")
        XCTAssertEqual(r.coordinator.state(for: "s1").shownTarget?.targetId, "a")
        XCTAssertEqual(r.coordinator.shownSession(forWindow: "shell"), "s1")
        XCTAssertTrue(r.coordinator.isReceivingFrames(sessionId: "s1"), "still one subscription, still asking for frames")
        XCTAssertEqual(r.client.count("subscribe:s1"), 1)
        r.client.push(.frame(.fake("s1", "a", seq: 2, bytes: 8)))
        await expect({ r.sinks.byId["s1"]?.log.last == "frame:8:720x540" })
    }

    func testASubscribeFailureWaitsLongerEachTimeBeforeStartingOver() async {
        let r = rig()
        r.client.failSubscribe(with: .rpc(code: -32602, message: "no"))
        r.coordinator.setWindow(window(.shell, session: "s1", id: "shell"))
        await expect({ r.client.count("connect") >= 5 }, "\(r.client.calls)")
        XCTAssertEqual(r.sleeps.delays.prefix(4).map { $0 }, [0.5, 1, 2, 4], "doubling, so a helper that refuses forever is not hammered")
        r.client.failSubscribe(with: nil)
        await expect({ r.coordinator.applied == ["s1"] })
    }

    // MARK: - Nothing keeps publishing once the events stop

    private func offscreenWindow() -> NSWindow {
        NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 700), styleMask: [.titled], backing: .buffered, defer: true)
    }

    private let visibleFacts = { (_: NSWindow) in
        MirrorWindowFacts(frame: NSRect(x: 0, y: 0, width: 900, height: 700), isVisible: true, isOnScreen: true)
    }

    /// The whole chain — helper events, coordinator, states, the window's binder — driven with a burst of everything
    /// the helper sends. Once it stops, nothing may keep ticking: no publish, no refresh, no panel call, no helper
    /// call, no sink call.
    func testNothingKeepsWorkingOnceTheEventsStop() async {
        let r = rig()
        let host = RecordingPanelHost()
        let window = offscreenWindow()
        let binder = MirrorWindowBinder(coordinator: r.coordinator, windowId: "shell", kind: .shell, window: window, sessionId: "dispatch",
                                        host: host, facts: visibleFacts)
        binder.update(sessionId: "dispatch", related: ["c1", "c2"])
        r.client.setTargets([.fake("a", app: "Mail"), .fake("b", app: "Notes")], for: "c1")
        r.client.setTargets([.fake("x", app: "Safari")], for: "c2")
        await expect({ r.coordinator.applied == ["dispatch", "c1", "c2"] && r.coordinator.shownSession(forWindow: "shell") != nil })

        // A burst of everything: frames for every target, cursors of every kind, a rebind, a release and a bind.
        let kinds = ["move", "press", "type", "waitBegin", "waitEnd", "idle", "done", "caption", "key", "scroll", "drag", "target", "refused"]
        for i in 1...120 {
            for (session, target) in [("c1", "a"), ("c1", "b"), ("c2", "x")] {
                r.client.push(.frame(.fake(session, target, seq: i, bytes: 6)))
                r.client.push(.cursor(HelperCursor(sessionId: session, targetId: target, kind: kinds[i % kinds.count], point: CGPoint(x: 3, y: 4),
                                                   dragTo: CGPoint(x: 9, y: 9), frame: CGRect(x: 1, y: 1, width: 5, height: 5))))
            }
            if i % 40 == 0 {
                r.client.push(.bound(sessionId: "c1", target: .fake("a", app: "Mail")))
                r.client.push(.released(sessionId: "c2", targetId: "x"))
                r.client.push(.bound(sessionId: "c2", target: .fake("x", app: "Safari")))
            }
        }
        try? await Task.sleep(nanoseconds: 500_000_000) // the stream drains

        func counters() -> [Int] {
            [binder.refreshCount, binder.presentCount, host.presented.count, host.dismissals, r.client.calls.count,
             r.sinks.byId.values.map(\.log.count).reduce(0, +)]
        }
        var coordinatorPublishes = 0
        var statePublishes = 0
        let watch = r.coordinator.objectWillChange.sink { coordinatorPublishes += 1 }
        let watches = ["dispatch", "c1", "c2"].map { id in r.coordinator.state(for: id).objectWillChange.sink { statePublishes += 1 } }
        let before = counters()
        try? await Task.sleep(nanoseconds: 500_000_000)
        XCTAssertEqual(counters(), before, "refreshes, panel calls, helper calls and sink calls have all stopped")
        XCTAssertEqual(coordinatorPublishes, 0)
        XCTAssertEqual(statePublishes, 0)
        withExtendedLifetime((watch, watches, window)) {}
        binder.close()
    }

    /// Frames and cursors of the target on show touch the sink and nothing else: no coordinator publish, no binder
    /// refresh, no panel call, no helper call — whatever their number.
    func testFramesAndCursorsNeverReachTheWindowOrTheBinder() async {
        let r = rig()
        let host = RecordingPanelHost()
        let window = offscreenWindow()
        let binder = MirrorWindowBinder(coordinator: r.coordinator, windowId: "shell", kind: .shell, window: window, sessionId: "s1",
                                        host: host, facts: visibleFacts)
        r.client.setTargets([.fake("t1", app: "Notes")], for: "s1")
        await expect({ r.coordinator.shownSession(forWindow: "shell") == "s1" && host.presented.count >= 1 }, "\(host.presented)")
        try? await Task.sleep(nanoseconds: 100_000_000)

        var coordinatorPublishes = 0
        var statePublishes = 0
        let watch = r.coordinator.objectWillChange.sink { coordinatorPublishes += 1 }
        let stateWatch = r.coordinator.state(for: "s1").objectWillChange.sink { statePublishes += 1 }
        let refreshes = binder.refreshCount, presents = binder.presentCount, calls = r.client.calls.count
        let applied = r.sinks.byId["s1"]?.log.count ?? 0

        for i in 1...300 {
            r.client.push(.frame(.fake("s1", "t1", seq: i, bytes: 8)))
            r.client.push(.cursor(HelperCursor(sessionId: "s1", targetId: "t1", kind: i % 2 == 0 ? "move" : "press", point: CGPoint(x: 5, y: 6))))
        }
        await expect({ (r.sinks.byId["s1"]?.log.count ?? 0) >= applied + 20 })
        try? await Task.sleep(nanoseconds: 300_000_000)

        XCTAssertGreaterThan(r.sinks.byId["s1"]?.log.count ?? 0, applied, "they reached the sink")
        XCTAssertEqual(coordinatorPublishes, 0, "the coordinator was not told")
        XCTAssertEqual(statePublishes, 0)
        XCTAssertEqual(binder.refreshCount, refreshes, "the window's binder did not even refresh")
        XCTAssertEqual(binder.presentCount, presents)
        XCTAssertEqual(r.client.calls.count, calls, "and the helper was asked for nothing")
        withExtendedLifetime((watch, stateWatch, window)) {}
        binder.close()
    }

    /// A helper that announces the same target on every call, to the whole chain: nothing publishes, nothing refreshes,
    /// the panel is not touched and nothing is asked of the helper.
    func testRepeatedBindsReachNothingBeyondTheState() async {
        let r = rig()
        let host = RecordingPanelHost()
        let window = offscreenWindow()
        let binder = MirrorWindowBinder(coordinator: r.coordinator, windowId: "shell", kind: .shell, window: window, sessionId: "s1",
                                        host: host, facts: visibleFacts)
        r.client.setTargets([.fake("t1", app: "Notes")], for: "s1")
        await expect({ r.coordinator.shownSession(forWindow: "shell") == "s1" && host.presented.count >= 1 })
        try? await Task.sleep(nanoseconds: 100_000_000)
        var coordinatorPublishes = 0
        let watch = r.coordinator.objectWillChange.sink { coordinatorPublishes += 1 }
        let refreshes = binder.refreshCount, presents = binder.presentCount, calls = r.client.calls.count
        let log = r.sinks.byId["s1"]?.log ?? []
        for _ in 0..<50 { r.client.push(.bound(sessionId: "s1", target: .fake("t1", app: "Notes"))) }
        try? await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(coordinatorPublishes, 0)
        XCTAssertEqual(binder.refreshCount, refreshes)
        XCTAssertEqual(binder.presentCount, presents)
        XCTAssertEqual(r.client.calls.count, calls)
        XCTAssertEqual(r.sinks.byId["s1"]?.log ?? [], log, "and the mirror never blinked")
        // A resize of the same target is the one thing that moves the panel — once, in place.
        r.client.push(.bound(sessionId: "s1", target: .fake("t1", app: "Notes", size: CGSize(width: 1200, height: 500))))
        await expect({ host.presented.count == presents + 1 })
        XCTAssertFalse((r.sinks.byId["s1"]?.log ?? []).contains("clear"))
        withExtendedLifetime((watch, window)) {}
        binder.close()
    }

    /// The binder touches AppKit only when what is on screen changes, and a hidden window is a dismissal, once.
    func testTheBinderPutsThePanelUpOnceAndTakesItDownOnce() async {
        let r = rig()
        let host = RecordingPanelHost()
        let window = offscreenWindow()
        var visible = true
        let binder = MirrorWindowBinder(coordinator: r.coordinator, windowId: "shell", kind: .shell, window: window, sessionId: "s1", host: host,
                                        facts: { _ in MirrorWindowFacts(frame: NSRect(x: 0, y: 0, width: 900, height: 700), isVisible: visible, isOnScreen: visible) })
        r.client.setTargets([.fake("t1")], for: "s1")
        await expect({ host.presented.count == 1 }, "\(host.presented)")
        for _ in 0..<5 { binder.refresh() }
        XCTAssertEqual(host.presented.count, 1, "refreshing again with nothing changed is not another presentation")
        XCTAssertEqual(host.dismissals, 0)
        visible = false
        for _ in 0..<5 { binder.refresh() }
        XCTAssertEqual(host.dismissals, 1)
        XCTAssertEqual(host.presented.count, 1)
        visible = true
        binder.refresh()
        XCTAssertEqual(host.presented.count, 2, "and it comes back once")
        withExtendedLifetime(window) {}
        binder.close()
    }

    // MARK: - Following the app the agent works in, through the coordinator

    func testFramesStoppingForAWhileLeavesTheMirrorAndTheSubscriptionAlone() async {
        let r = rig()
        await mainWindowAlone(r)
        r.client.push(.frame(.fake("s1", "t1", bytes: 5)))
        await expect({ r.sinks.byId["s1"]?.log.last == "frame:5:720x540" })
        // The window goes to another Space: the helper sends nothing for a long moment.
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertTrue(r.coordinator.state(for: "s1").isVisible)
        XCTAssertEqual(r.coordinator.shownSession(forWindow: "shell"), "s1")
        XCTAssertEqual(r.sinks.byId["s1"]?.log, ["show:Notes:800x600", "frame:5:720x540"], "nothing cleared")
        XCTAssertTrue(r.coordinator.isReceivingFrames(sessionId: "s1"))
        XCTAssertEqual(r.client.count("subscribe:s1"), 1)
        XCTAssertEqual(r.client.count("unsubscribe:s1"), 0)
        // …and when it is back, the next frame just replaces the old one.
        r.client.push(.frame(.fake("s1", "t1", seq: 2, bytes: 6, size: .zero)))
        r.client.push(.frame(.fake("s1", "t1", seq: 3, bytes: 7)))
        await expect({ r.sinks.byId["s1"]?.log.last == "frame:7:720x540" })
        XCTAssertEqual(r.coordinator.state(for: "s1").shownTarget?.windowSize, CGSize(width: 800, height: 600))
    }

    // MARK: - Events through the coordinator

    func testEventsReachTheRightSessionsMirror() async {
        let r = rig()
        r.client.setTargets([.fake("t1", app: "Notes")], for: "a")
        r.coordinator.setWindow(window(.shell, session: "a", id: "shell"))
        r.coordinator.setWindow(window(.detached, session: "b", width: 900, id: "det"))
        await expect({ r.coordinator.applied == ["a", "b"] })

        r.client.push(.frame(.fake("a", "t1", bytes: 11)))
        r.client.push(.frame(.fake("b", "nope", bytes: 5)))
        r.client.push(.bound(sessionId: "b", target: .fake("tb", app: "Finder")))
        r.client.push(.cursor(HelperCursor(sessionId: "b", targetId: "tb", kind: "move", point: CGPoint(x: 3, y: 4))))
        r.client.push(.released(sessionId: "a", targetId: "t1"))
        await expect({ r.sinks.byId["a"]?.log.last == "clear" })
        XCTAssertEqual(r.sinks.byId["a"]?.log, ["show:Notes:800x600", "frame:11:720x540", "clear"])
        XCTAssertEqual(r.sinks.byId["b"]?.log, ["show:Finder:800x600", "cursor:move:3,4"], "b's stray frame for an unknown target was dropped")
    }

    func testAnEventForASessionNoWindowShowsIsIgnored() async {
        let r = rig()
        r.coordinator.setWindow(window(.shell, session: "a", id: "shell"))
        await expect({ r.coordinator.applied == ["a"] })
        r.client.push(.bound(sessionId: "ghost", target: .fake("t")))
        r.client.push(.frame(.fake("ghost", "t")))
        try? await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertNil(r.sinks.byId["ghost"], "no state is made for a session nobody shows")
    }

    func testAClosedWindowsSessionStateIsDropped() async {
        let r = rig()
        r.coordinator.setWindow(window(.shell, session: "a", id: "shell"))
        await expect({ r.coordinator.applied == ["a"] })
        let first = r.sinks.byId["a"]
        XCTAssertNotNil(first)
        r.coordinator.removeWindow(id: "shell")
        await expect({ r.client.calls.contains("disconnect") })
        _ = r.coordinator.state(for: "a")
        XCTAssertFalse(r.sinks.byId["a"] === first, "the old state was dropped; asking again made a fresh one")
    }
}
