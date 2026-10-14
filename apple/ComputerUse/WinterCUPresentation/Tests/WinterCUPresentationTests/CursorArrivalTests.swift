import CoreGraphics
import XCTest
@testable import WinterCUPresentation

/// The arrival gate (DESIGN-cursor.md, "Arrival"): the timeline's action moment per kind, and the controller's answer —
/// the wait until the drawn cursor has arrived, capped, and 0 wherever no cursor is seen moving.
@MainActor final class CursorArrivalTests: XCTestCase {
    typealias T = CursorTimeline.Timing
    typealias Fakes = PresentationControllerTests

    // MARK: - The timeline's action moment

    func testAPressActsWhenItsGlideEnds() {
        var t = CursorTimeline()
        t.receive(.idle, at: CGPoint(x: 100, y: 100), now: 0)
        t.receive(.press, at: CGPoint(x: 400, y: 100), now: 1)
        let glide = CursorTimeline.glideDuration(distance: 300)
        XCTAssertEqual(t.actionAt ?? -1, 1 + glide, accuracy: 1e-9)
        XCTAssertTrue(t.frame(at: 1 + glide - 0.01).rings.isEmpty, "no pulse while the arrow is still on its way")
        XCTAssertFalse(t.frame(at: 1 + glide).rings.isEmpty, "the pulse starts at the action moment")
        XCTAssertEqual(t.frame(at: 1 + glide).tip, CGPoint(x: 400, y: 100))
    }

    func testAReticleActsAfterItsDwellAndItsPressRightThen() {
        var t = CursorTimeline()
        let p = CGPoint(x: 400, y: 100)
        t.receive(.idle, at: CGPoint(x: 100, y: 100), now: 0)
        t.receive(.target(frame: CGRect(x: 380, y: 90, width: 40, height: 20)), at: p, now: 1)
        let arrive = 1 + CursorTimeline.glideDuration(distance: 300)
        XCTAssertEqual(t.actionAt ?? -1, arrive + T.reticleDwell, accuracy: 1e-9, "the glide, then the reticle's dwell")
        XCTAssertEqual(t.frame(at: arrive + T.reticleDwell).reticle?.opacity ?? 0, 1, accuracy: 1e-6, "settled")
        // The core waited until then, so the press arrives with nothing left to travel: it acts at once.
        let pressNow = arrive + T.reticleDwell
        t.receive(.press, at: p, now: pressNow)
        XCTAssertEqual(t.actionAt ?? -1, pressNow, accuracy: 1e-9)
        XCTAssertFalse(t.frame(at: pressNow).rings.isEmpty, "the pulse plays with the real click")
    }

    func testEveryPlaceBoundKindSetsItsActionMoment() {
        let from = CGPoint(x: 100, y: 100), to = CGPoint(x: 200, y: 100)
        let glide = CursorTimeline.glideDuration(distance: 100)
        let kinds: [CUCursorKind] = [.press, .doubleClick, .rightClick, .type, .key(combo: "return"), .scroll,
                                     .scrollToward(.down), .drag(to: CGPoint(x: 300, y: 300))]
        for kind in kinds {
            var t = CursorTimeline()
            t.receive(.idle, at: from, now: 0)
            t.receive(kind, at: to, now: 1)
            XCTAssertEqual(t.actionAt ?? -1, 1 + glide, accuracy: 1e-9, "\(kind)")
        }
    }

    func testTheNextGlideStartsWhereTheCursorIs() {
        var t = CursorTimeline()
        t.receive(.idle, at: CGPoint(x: 100, y: 100), now: 0)
        t.receive(.press, at: CGPoint(x: 200, y: 100), now: 1)
        let first = t.actionAt!
        // The core held the act until then; the press's own tail (its squash) is all that's left.
        t.receive(.press, at: CGPoint(x: 300, y: 100), now: first)
        let second = t.actionAt!
        XCTAssertEqual(second, first + 0.16 + CursorTimeline.glideDuration(distance: 100), accuracy: 1e-9)
        XCTAssertEqual(t.position(at: first + 0.16), CGPoint(x: 200, y: 100), "from the first press's place")
    }

    // MARK: - The controller's answer

    var windows: Fakes.FakeWindows!
    var clock: Fakes.FakeClock!
    var accessibility: Fakes.FakeAccessibility!
    var controller: PresentationController!

    override func setUp() async throws {
        await MainActor.run {
            windows = Fakes.FakeWindows()
            clock = Fakes.FakeClock()
            accessibility = Fakes.FakeAccessibility()
            controller = PresentationController(windows: windows, surfaces: Fakes.FakeSurfaces(), clock: clock,
                                                ticker: Fakes.FakeTicker(), frames: Fakes.FakeDriver(),
                                                accessibility: accessibility, ownPID: 4242)
            windows.windows[1] = WindowSnapshot(frame: CGRect(x: 100, y: 100, width: 800, height: 400), isOnScreen: true)
        }
    }

    let ref = CUWindowRef(pid: 500, windowID: 1, appName: "App1")
    func arrival() -> TimeInterval { controller.cursorArrival(sessionId: "s", target: ref) }
    func cursor(_ x: CGFloat, _ y: CGFloat, _ kind: CUCursorKind) {
        controller.cursor(sessionId: "s", target: ref, point: CGPoint(x: x, y: y), kind: kind)
    }

    func testTheWaitIsTheGlideStillToGo() {
        cursor(200, 200, .move)
        clock.now += 1
        cursor(300, 200, .press)
        let glide = CursorTimeline.glideDuration(distance: 100)
        XCTAssertEqual(arrival(), glide, accuracy: 1e-9)
        clock.now += 0.1
        XCTAssertEqual(arrival(), glide - 0.1, accuracy: 1e-9, "counting down")
        clock.now += 1
        XCTAssertEqual(arrival(), 0, "arrived")
    }

    func testTheCapHolds() {
        cursor(110, 110, .move)
        clock.now += 1
        cursor(880, 480, .press)  // ~855 pt: a 0.51 s glide
        XCTAssertGreaterThan(CursorTimeline.glideDuration(distance: 855), CUCursorArrival.cap)
        XCTAssertEqual(arrival(), CUCursorArrival.cap, accuracy: 1e-9)
        // A queue of glides far ahead of the clock: still the cap.
        for x in stride(from: 120, through: 880, by: 190) { cursor(CGFloat(x), 470, .press) }
        XCTAssertEqual(arrival(), CUCursorArrival.cap, accuracy: 1e-9)
    }

    func testNoWaitForACursorAlreadyRestingThere() {
        cursor(300, 200, .move)
        clock.now += 2
        cursor(300, 200, .press)
        XCTAssertEqual(arrival(), 0)
    }

    func testNoWaitWhileTheWindowIsOffScreenOrOnAnotherDesktop() {
        windows.windows[1] = WindowSnapshot(frame: CGRect(x: 100, y: 100, width: 800, height: 400), isOnScreen: false)
        cursor(200, 200, .move)
        clock.now += 1
        cursor(700, 400, .press)
        XCTAssertEqual(arrival(), 0, "no overlay drawn: nothing to wait for")
    }

    func testNoWaitWhileTheCursorIsCovered() {
        windows.above[1] = [StackWindow(id: 9, pid: 600, layer: 0, bounds: CGRect(x: 150, y: 150, width: 300, height: 200))]
        cursor(200, 200, .move)
        clock.now += 1
        cursor(700, 400, .press)
        XCTAssertEqual(arrival(), 0, "another app's window covers the cursor")
    }

    func testNoWaitUnderReduceMotion() {
        accessibility.reduceMotion = true
        cursor(200, 200, .move)
        clock.now += 1
        cursor(700, 400, .target(frame: CGRect(x: 680, y: 390, width: 40, height: 20)))
        XCTAssertEqual(arrival(), 0)
    }

    func testNoWaitForAnUnknownTargetOrAFadedCursor() {
        XCTAssertEqual(arrival(), 0, "never drawn")
        cursor(200, 200, .move)
        clock.now += 1
        cursor(700, 400, .press)
        XCTAssertEqual(controller.cursorArrival(sessionId: "other", target: ref), 0)
        controller.sessionEnded(sessionId: "s")
        XCTAssertEqual(arrival(), 0, "its session ended")
    }
}
