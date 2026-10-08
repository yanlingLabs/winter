import CoreGraphics
import XCTest
@testable import WinterCUPresentation

/// Stacking (≤2, newest first), fades at turn end and after 30 s idle, revival by a later action, cursor timers.
final class PresentationStateTests: XCTestCase {
    func key(_ session: String, _ window: CGWindowID) -> TargetKey {
        TargetKey(sessionId: session, target: CUWindowRef(pid: 100 + pid_t(window), windowID: window, appName: "App\(window)"))
    }

    func testAtMostTwoMirrorsNewestFirst() {
        var s = PresentationState()
        s.showMirror(key("s", 1), now: 0)
        XCTAssertEqual(s.visibleMirrors(), [key("s", 1)])
        s.showMirror(key("s", 2), now: 1)
        s.showMirror(key("s", 3), now: 2)
        XCTAssertEqual(s.visibleMirrors(), [key("s", 3), key("s", 2)])
    }

    func testAnActionMakesItsTargetTheMostRecent() {
        var s = PresentationState()
        s.showMirror(key("s", 1), now: 0)
        s.showMirror(key("s", 2), now: 1)
        s.showMirror(key("s", 3), now: 2)
        s.noteCursor(key("s", 1), fraction: nil, now: 3)
        XCTAssertEqual(s.visibleMirrors(), [key("s", 1), key("s", 3)])
        // Showing again also counts.
        s.showMirror(key("s", 2), now: 4)
        XCTAssertEqual(s.visibleMirrors(), [key("s", 2), key("s", 1)])
    }

    func testIdleFadeAfterThirtySecondsFromTheLastAction() {
        var s = PresentationState()
        s.showMirror(key("s", 1), now: 100)
        XCTAssertFalse(s.tick(now: 129.9))
        XCTAssertEqual(s.visibleMirrors().count, 1)
        s.noteCursor(key("s", 1), fraction: nil, now: 120)
        s.tick(now: 149.9)
        XCTAssertEqual(s.visibleMirrors().count, 1, "the action at 120 restarted the 30 s")
        XCTAssertTrue(s.tick(now: 150))
        XCTAssertEqual(s.visibleMirrors(), [])
        XCTAssertEqual(s.entries[key("s", 1)]?.mirrorFaded, true, "faded, still wanted, so it can come back")
    }

    func testEachTargetFadesOnItsOwnClock() {
        var s = PresentationState()
        s.showMirror(key("s", 1), now: 0)
        s.showMirror(key("s", 2), now: 1)
        s.showMirror(key("s", 3), now: 2)
        s.tick(now: 31)
        XCTAssertEqual(s.visibleMirrors(), [key("s", 3)])
    }

    func testTurnEndFadesOnlyThatSessionsMirrors() {
        var s = PresentationState()
        s.showMirror(key("a", 1), now: 0)
        s.showMirror(key("b", 2), now: 1)
        s.turnEnded(sessionId: "a")
        XCTAssertEqual(s.visibleMirrors(), [key("b", 2)])
    }

    func testTheNextActionBringsAFadedMirrorBack() {
        var s = PresentationState()
        s.showMirror(key("s", 1), now: 0)
        s.turnEnded(sessionId: "s")
        XCTAssertEqual(s.visibleMirrors(), [])
        s.noteCursor(key("s", 1), fraction: CGPoint(x: 0.5, y: 0.5), now: 10)
        XCTAssertEqual(s.visibleMirrors(), [key("s", 1)])
    }

    func testAnActionNeverCreatesAMirrorThatWasNotAskedFor() {
        var s = PresentationState()
        s.noteCursor(key("s", 1), fraction: nil, now: 0)
        XCTAssertEqual(s.visibleMirrors(), [])
        XCTAssertEqual(s.activeCursors(now: 1), [key("s", 1)])
    }

    func testHideMirrorDropsIt() {
        var s = PresentationState()
        s.showMirror(key("s", 1), now: 0)
        s.hideMirror(key("s", 1))
        XCTAssertEqual(s.visibleMirrors(), [])
        XCTAssertNil(s.entries[key("s", 1)])
        // An action after hiding does not bring it back.
        s.noteCursor(key("s", 1), fraction: nil, now: 1)
        XCTAssertEqual(s.visibleMirrors(), [])
    }

    func testMirrorsDisabledShowsNoneButKeepsCursors() {
        var s = PresentationState()
        s.showMirror(key("s", 1), now: 0)
        s.noteCursor(key("s", 1), fraction: nil, now: 1)
        s.mirrorsEnabled = false
        XCTAssertEqual(s.visibleMirrors(), [])
        XCTAssertEqual(s.activeCursors(now: 2), [key("s", 1)])
        s.mirrorsEnabled = true
        XCTAssertEqual(s.visibleMirrors(), [key("s", 1)])
    }

    func testCursorShowsForFourSecondsAfterItsLastActionAndHidesAtTurnEnd() {
        var s = PresentationState()
        s.noteCursor(key("s", 1), fraction: nil, now: 10)
        XCTAssertEqual(s.activeCursors(now: 13.9), [key("s", 1)])
        s.tick(now: 14)
        XCTAssertEqual(s.activeCursors(now: 14), [])
        XCTAssertNil(s.entries[key("s", 1)], "a cursor-only entry is dropped once its cursor hides")

        s.noteCursor(key("s", 2), fraction: nil, now: 20)
        s.turnEnded(sessionId: "s")
        XCTAssertEqual(s.activeCursors(now: 20.5), [])
    }

    func testSessionEndForgetsEverythingOfThatSession() {
        var s = PresentationState()
        s.showMirror(key("a", 1), now: 0)
        s.noteCursor(key("a", 2), fraction: nil, now: 0)
        s.showMirror(key("b", 3), now: 0)
        XCTAssertEqual(Set(s.sessionEnded(sessionId: "a")), [key("a", 1), key("a", 2)])
        XCTAssertEqual(Set(s.entries.keys), [key("b", 3)])
    }

    func testPendingTimers() {
        var s = PresentationState()
        XCTAssertFalse(s.hasPendingTimers)
        s.showMirror(key("s", 1), now: 0)
        XCTAssertTrue(s.hasPendingTimers)
        s.turnEnded(sessionId: "s")
        XCTAssertFalse(s.hasPendingTimers, "a faded mirror waits for an action, not a timer")
        s.noteCursor(key("s", 2), fraction: nil, now: 1)
        XCTAssertTrue(s.hasPendingTimers)
    }

    func testDisabledMirrorsNeedNoTimerAndFadeLazily() {
        var s = PresentationState()
        s.showMirror(key("s", 1), now: 0)
        s.mirrorsEnabled = false
        XCTAssertFalse(s.hasPendingTimers, "nothing on screen can change on its own")
        // Switched back on after the 30 s: the next tick fades it before it could show.
        s.mirrorsEnabled = true
        s.tick(now: 31)
        XCTAssertEqual(s.visibleMirrors(), [])
        // Switched back on in time: it shows.
        var t = PresentationState()
        t.showMirror(key("s", 1), now: 0)
        t.mirrorsEnabled = false
        t.mirrorsEnabled = true
        t.tick(now: 10)
        XCTAssertEqual(t.visibleMirrors(), [key("s", 1)])
    }

    func testCursorFractionIsRemembered() {
        var s = PresentationState()
        s.noteCursor(key("s", 1), fraction: CGPoint(x: 0.2, y: 0.8), now: 0)
        s.noteCursor(key("s", 1), fraction: nil, now: 1)
        XCTAssertEqual(s.entries[key("s", 1)]?.cursorFraction, CGPoint(x: 0.2, y: 0.8))
    }

    // MARK: - Cursor motion

    func testGlideDurationGrowsWithDistanceWithinACalmRange() {
        XCTAssertEqual(CursorMotion.duration(from: nil, to: CGPoint(x: 10, y: 10)), 0, "first appearance does not glide")
        XCTAssertEqual(CursorMotion.duration(from: .zero, to: CGPoint(x: 0.5, y: 0)), 0)
        XCTAssertEqual(CursorMotion.duration(from: .zero, to: CGPoint(x: 20, y: 0)), CursorMotion.minDuration)
        XCTAssertEqual(CursorMotion.duration(from: .zero, to: CGPoint(x: 540, y: 0)), 0.3, accuracy: 1e-9)
        XCTAssertEqual(CursorMotion.duration(from: .zero, to: CGPoint(x: 3000, y: 0)), CursorMotion.maxDuration)
    }

    func testEaseOutStartsFastAndArrivesExactly() {
        XCTAssertEqual(CursorMotion.ease(0), 0)
        XCTAssertEqual(CursorMotion.ease(1), 1)
        XCTAssertGreaterThan(CursorMotion.ease(0.5), 0.5)
        var last = -1.0
        for i in 0...20 {
            let v = CursorMotion.ease(Double(i) / 20)
            XCTAssertGreaterThanOrEqual(v, last)
            last = v
        }
        XCTAssertEqual(CursorMotion.position(from: .zero, to: CGPoint(x: 100, y: 50), progress: 1), CGPoint(x: 100, y: 50))
        XCTAssertEqual(CursorMotion.position(from: .zero, to: CGPoint(x: 100, y: 50), progress: 0), .zero)
    }
}
