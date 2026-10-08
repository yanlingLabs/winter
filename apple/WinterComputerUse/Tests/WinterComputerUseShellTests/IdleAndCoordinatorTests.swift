import CoreGraphics
import Foundation
import WinterComputerUseShell
import WinterCUPresentation
import XCTest

@MainActor
final class IdleQuitTimerTests: XCTestCase {
    func testItQuitsAfterTenMinutesContinuouslyIdle() {
        let clock = FakeIdleScheduler()
        var quits = 0
        let timer = IdleQuitTimer(interval: 600, scheduler: clock) { quits += 1 }
        timer.update(busy: false)
        XCTAssertTrue(timer.isCountingDown)
        clock.advance(by: 599)
        XCTAssertEqual(quits, 0)
        clock.advance(by: 1)
        XCTAssertEqual(quits, 1)
    }

    func testBecomingBusyStopsTheCountdownAndIdlingAgainStartsItOver() {
        let clock = FakeIdleScheduler()
        var quits = 0
        let timer = IdleQuitTimer(interval: 600, scheduler: clock) { quits += 1 }
        timer.update(busy: false)
        clock.advance(by: 500)
        timer.update(busy: true)
        XCTAssertFalse(timer.isCountingDown)
        clock.advance(by: 200)
        XCTAssertEqual(quits, 0)
        timer.update(busy: false)
        clock.advance(by: 599)
        XCTAssertEqual(quits, 0, "the countdown restarted from zero")
        clock.advance(by: 1)
        XCTAssertEqual(quits, 1)
    }

    func testRepeatedIdleUpdatesDoNotPushTheDeadlineBack() {
        let clock = FakeIdleScheduler()
        var quits = 0
        let timer = IdleQuitTimer(interval: 600, scheduler: clock) { quits += 1 }
        timer.update(busy: false)
        clock.advance(by: 300)
        timer.update(busy: false)
        timer.update(busy: false)
        XCTAssertEqual(clock.pendingCount, 1)
        clock.advance(by: 300)
        XCTAssertEqual(quits, 1)
    }

    func testTheCoordinatorCountsConnectionsAndBoundTargetsAsBusy() {
        let clock = FakeIdleScheduler()
        let rig = Rig()
        var quits = 0
        rig.coordinator.attach(idleTimer: IdleQuitTimer(interval: 600, scheduler: clock) { quits += 1 })
        XCTAssertEqual(clock.pendingCount, 1, "a helper nobody connects to still quits")

        rig.coordinator.connectionOpened(1)
        XCTAssertEqual(clock.pendingCount, 0)
        rig.coordinator.targetBound(sessionId: "s_1", pid: 10, windowID: 20, appName: "Notes", mirror: false)
        rig.coordinator.connectionClosed(1)
        clock.advance(by: 700)
        XCTAssertEqual(quits, 0, "a bound target keeps the helper up")

        rig.coordinator.targetReleased(sessionId: "s_1", pid: 10, windowID: 20)
        clock.advance(by: 600)
        XCTAssertEqual(quits, 1)
    }

    func testAnEndedSessionDropsItsBoundTargets() {
        let rig = Rig()
        rig.coordinator.targetBound(sessionId: "s_1", pid: 10, windowID: 20, appName: "Notes", mirror: true)
        rig.coordinator.targetBound(sessionId: "s_2", pid: 11, windowID: 21, appName: "Mail", mirror: false)
        XCTAssertEqual(rig.coordinator.boundTargetCount, 2)
        rig.coordinator.sessionEnded(sessionId: "s_1")
        XCTAssertEqual(rig.coordinator.boundTargetCount, 1)
    }
}

@MainActor
final class CoordinatorTests: XCTestCase {
    private let notes = CUWindowRef(pid: 10, windowID: 20, appName: "Notes")

    func testMirrorsStayGloballyEnabledAndFollowEachBindsFlag() {
        let rig = Rig()
        XCTAssertTrue(rig.presentation.mirrorsEnabled)
        rig.coordinator.targetBound(sessionId: "s_1", pid: 10, windowID: 20, appName: "Notes", mirror: true)
        rig.coordinator.targetBound(sessionId: "s_1", pid: 11, windowID: 21, appName: "Mail", mirror: false)
        XCTAssertEqual(rig.presentation.calls, [.show("s_1", notes)])
    }

    func testReleaseHidesTheMirrorByTheBoundWindowExactlyOnce() {
        let rig = Rig()
        rig.coordinator.targetBound(sessionId: "s_1", pid: 10, windowID: 20, appName: "Notes", mirror: true)
        rig.coordinator.targetBound(sessionId: "s_1", pid: 11, windowID: 21, appName: "Mail", mirror: false)
        // A lost target: the engine reports targetLost and targetReleased; a repeat release changes nothing.
        rig.coordinator.targetLost(targetId: "t1", reason: "app_quit")
        rig.coordinator.targetReleased(sessionId: "s_1", pid: 10, windowID: 20)
        rig.coordinator.targetReleased(sessionId: "s_1", pid: 10, windowID: 20)
        rig.coordinator.targetReleased(sessionId: "s_1", pid: 11, windowID: 21)
        XCTAssertEqual(rig.presentation.calls, [.show("s_1", notes), .hide("s_1", notes)], "one hide, and none for a target never mirrored")
        XCTAssertEqual(rig.notifications, [.targetLost(targetId: "t1", reason: "app_quit")])
    }

    func testTheEnginesReleasesAfterSessionEndedHideNothingTwice() {
        let rig = Rig()
        rig.coordinator.targetBound(sessionId: "s_1", pid: 10, windowID: 20, appName: "Notes", mirror: true)
        rig.coordinator.sessionEnded(sessionId: "s_1")
        rig.coordinator.targetReleased(sessionId: "s_1", pid: 10, windowID: 20)
        XCTAssertEqual(rig.presentation.calls, [.show("s_1", notes), .sessionEnded("s_1")])
    }

    func testActionsBecomeCursorMovesWithTheirKind() {
        let rig = Rig()
        rig.coordinator.targetBound(sessionId: "s_1", pid: 10, windowID: 20, appName: "Notes", mirror: true)
        let p = CGPoint(x: 5, y: 6), q = CGPoint(x: 50, y: 60)
        for kind in ["move", "press", "type", "scroll"] {
            rig.coordinator.actionAt(sessionId: "s_1", pid: 10, windowID: 20, point: p, kind: kind, dragTo: nil)
        }
        rig.coordinator.actionAt(sessionId: "s_1", pid: 10, windowID: 20, point: p, kind: "drag", dragTo: q)
        rig.coordinator.actionAt(sessionId: "s_1", pid: 10, windowID: 20, point: p, kind: "drag", dragTo: nil)
        XCTAssertEqual(Array(rig.presentation.calls.dropFirst()), [
            .cursor("s_1", notes, p, .move), .cursor("s_1", notes, p, .press), .cursor("s_1", notes, p, .type),
            .cursor("s_1", notes, p, .scroll), .cursor("s_1", notes, p, .drag(to: q)), .cursor("s_1", notes, p, .drag(to: p)),
        ])
    }

    func testEscNamesEverySessionWithAnActiveScript() {
        let rig = Rig()
        rig.tap.onEscape?()
        XCTAssertEqual(rig.notifications, [], "Esc with nothing running reports nothing")
        rig.coordinator.setScriptActive(sessionId: "s_2", active: true)
        rig.coordinator.setScriptActive(sessionId: "s_1", active: true)
        rig.tap.onEscape?()
        XCTAssertEqual(rig.notifications, [.escPressed(sessionIds: ["s_1", "s_2"])])
        XCTAssertEqual(rig.tap.armedCalls, [true])
    }

    func testTheHelpersOwnEscapeOpensTheSyntheticWindow() {
        let rig = Rig()
        rig.coordinator.willSendEscape()
        XCTAssertEqual(rig.tap.syntheticWindows, [0.5])
    }

    func testTargetLostIsForwardedToTheDaemon() {
        let rig = Rig()
        rig.coordinator.targetLost(targetId: "t1", reason: "window_closed")
        XCTAssertEqual(rig.notifications, [.targetLost(targetId: "t1", reason: "window_closed")])
    }

    func testTheEnginesPermissionChangesReachTheDaemonOncePerChange() {
        let rig = Rig()
        rig.coordinator.permissionsChanged(accessibility: true, screenRecording: false)
        rig.coordinator.permissionsChanged(accessibility: true, screenRecording: false)
        rig.coordinator.permissionsChanged(accessibility: true, screenRecording: true)
        XCTAssertEqual(rig.notifications, [.permissionsChanged(accessibility: true, screenRecording: false),
                                           .permissionsChanged(accessibility: true, screenRecording: true)])
    }

    func testTurnEndedOnlyFadesThatSessionsMirrors() {
        let rig = Rig()
        rig.coordinator.turnEnded(sessionId: "s_1")
        XCTAssertEqual(rig.presentation.calls, [.turnEnded("s_1")])
    }
}
