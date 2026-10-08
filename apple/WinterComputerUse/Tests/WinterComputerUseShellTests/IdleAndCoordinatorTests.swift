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

    func testAConnectedDaemonAloneDoesNotKeepTheHelperUp() {
        let clock = FakeIdleScheduler()
        let rig = Rig()
        var quits = 0
        rig.coordinator.attach(idleTimer: IdleQuitTimer(interval: 600, scheduler: clock) { quits += 1 })
        XCTAssertEqual(clock.pendingCount, 1, "a helper nobody uses still quits")
        rig.coordinator.connectionOpened(1)
        XCTAssertEqual(clock.pendingCount, 1, "the daemon's persistent connection is not work")
        clock.advance(by: 600)
        XCTAssertEqual(quits, 1, "it quits with the daemon still connected")
    }

    func testABoundTargetKeepsTheHelperUp() {
        let clock = FakeIdleScheduler()
        let rig = Rig()
        var quits = 0
        rig.coordinator.attach(idleTimer: IdleQuitTimer(interval: 600, scheduler: clock) { quits += 1 })
        rig.coordinator.connectionOpened(1)
        rig.coordinator.targetBound(sessionId: "s_1", pid: 10, windowID: 20, appName: "Notes", mirror: true)
        clock.advance(by: 3600)
        XCTAssertEqual(quits, 0, "a bound target (and its mirror) keeps the helper up")

        rig.coordinator.targetReleased(sessionId: "s_1", pid: 10, windowID: 20)
        clock.advance(by: 599)
        XCTAssertEqual(quits, 0)
        clock.advance(by: 1)
        XCTAssertEqual(quits, 1, "ten minutes after the last release")
    }

    func testARunningScriptKeepsTheHelperUp() {
        let clock = FakeIdleScheduler()
        let rig = Rig()
        var quits = 0
        rig.coordinator.attach(idleTimer: IdleQuitTimer(interval: 600, scheduler: clock) { quits += 1 })
        rig.coordinator.setScriptActive(sessionId: "s_1", active: true)
        clock.advance(by: 3600)
        XCTAssertEqual(quits, 0, "a script that binds nothing (screen.screenshot, apps.list) still counts")
        rig.coordinator.setScriptActive(sessionId: "s_1", active: false)
        clock.advance(by: 600)
        XCTAssertEqual(quits, 1)
    }

    func testAnEndedSessionNoLongerKeepsTheHelperUp() {
        let clock = FakeIdleScheduler()
        let rig = Rig()
        var quits = 0
        rig.coordinator.attach(idleTimer: IdleQuitTimer(interval: 600, scheduler: clock) { quits += 1 })
        rig.coordinator.setScriptActive(sessionId: "s_1", active: true)
        rig.coordinator.targetBound(sessionId: "s_1", pid: 10, windowID: 20, appName: "Notes", mirror: false)
        rig.coordinator.sessionEnded(sessionId: "s_1")
        clock.advance(by: 600)
        XCTAssertEqual(quits, 1)
    }

    func testAQuitThatFindsWorkInFlightStartsTheCountdownOver() {
        let clock = FakeIdleScheduler()
        let rig = Rig()
        var attempts = 0
        rig.coordinator.attach(idleTimer: IdleQuitTimer(interval: 600, scheduler: clock) {
            attempts += 1
            rig.coordinator.restartIdleCountdown()
        })
        clock.advance(by: 600)
        XCTAssertEqual(attempts, 1)
        XCTAssertEqual(clock.pendingCount, 1, "a fresh countdown is running")
        clock.advance(by: 600)
        XCTAssertEqual(attempts, 2)
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

    func testTheHelperShowsNoFloatingMirrorAtAll() {
        let rig = Rig()
        XCTAssertFalse(rig.presentation.mirrorsEnabled, "switched off, so a cursor event can never re-show one")
        rig.coordinator.targetBound(sessionId: "s_1", pid: 10, windowID: 20, appName: "Notes", mirror: true)
        rig.coordinator.targetBound(sessionId: "s_1", pid: 11, windowID: 21, appName: "Mail", mirror: false)
        rig.coordinator.targetLost(targetId: "t1", reason: "app_quit")
        rig.coordinator.targetReleased(sessionId: "s_1", pid: 10, windowID: 20)
        rig.coordinator.targetReleased(sessionId: "s_1", pid: 11, windowID: 21)
        XCTAssertEqual(rig.presentation.calls, [], "no showMirror, no hideMirror")
        XCTAssertEqual(rig.notifications, [.targetLost(targetId: "t1", reason: "app_quit")])
        XCTAssertEqual(rig.coordinator.boundTargetCount, 0)
    }

    func testSessionEndedStillReachesThePresentation() {
        let rig = Rig()
        rig.coordinator.targetBound(sessionId: "s_1", pid: 10, windowID: 20, appName: "Notes", mirror: true)
        rig.coordinator.sessionEnded(sessionId: "s_1")
        rig.coordinator.targetReleased(sessionId: "s_1", pid: 10, windowID: 20)
        XCTAssertEqual(rig.presentation.calls, [.sessionEnded("s_1")])
    }

    private func act(_ rig: Rig, _ kind: String, at p: CGPoint, dragTo: CGPoint? = nil, frame: CGRect? = nil, text: String? = nil,
                     count: Int? = nil, button: String? = nil) {
        rig.coordinator.actionAt(sessionId: "s_1", pid: 10, windowID: 20, point: p, kind: kind, dragTo: dragTo, frame: frame,
                                 text: text, count: count, button: button)
    }

    func testThePinnedKindsStillMapAsBefore() {
        let rig = Rig()
        rig.coordinator.targetBound(sessionId: "s_1", pid: 10, windowID: 20, appName: "Notes", mirror: true)
        let p = CGPoint(x: 5, y: 6), q = CGPoint(x: 50, y: 60)
        for kind in ["move", "press", "type", "scroll"] { act(rig, kind, at: p) }
        act(rig, "drag", at: p, dragTo: q)
        XCTAssertEqual(rig.presentation.calls, [
            .cursor("s_1", notes, p, .move), .cursor("s_1", notes, p, .press), .cursor("s_1", notes, p, .type),
            .cursor("s_1", notes, p, .scroll), .cursor("s_1", notes, p, .drag(to: q)),
        ])
    }

    func testEveryCursorStateTheEngineSendsReachesThePresentation() {
        let rig = Rig()
        rig.coordinator.targetBound(sessionId: "s_1", pid: 10, windowID: 20, appName: "Notes", mirror: false)
        let p = CGPoint(x: 5, y: 6), frame = CGRect(x: 1, y: 2, width: 30, height: 10)
        act(rig, "target", at: p, frame: frame)
        act(rig, "press", at: p, count: 1, button: "left")
        act(rig, "press", at: p, count: 2, button: "left")
        act(rig, "press", at: p, count: 1, button: "right")
        act(rig, "type", at: p)
        act(rig, "key", at: p, text: "cmd+s")
        act(rig, "scroll", at: p, text: "down")
        act(rig, "waitBegin", at: p, text: "Saved")
        act(rig, "waitBegin", at: p)
        act(rig, "waitEnd", at: p)
        act(rig, "refused", at: p)
        act(rig, "foreground", at: p, text: "on")
        act(rig, "foreground", at: p, text: "off")
        act(rig, "caption", at: p, text: "Clicking “Save”")
        act(rig, "caption", at: p)
        act(rig, "done", at: p)
        XCTAssertEqual(rig.presentation.calls, [
            .cursor("s_1", notes, p, .target(frame: frame)), .cursor("s_1", notes, p, .press),
            .cursor("s_1", notes, p, .doubleClick), .cursor("s_1", notes, p, .rightClick), .cursor("s_1", notes, p, .type),
            .cursor("s_1", notes, p, .key(combo: "cmd+s")), .cursor("s_1", notes, p, .scrollToward(.down)),
            .cursor("s_1", notes, p, .wait(.begin(label: "Saved"))), .cursor("s_1", notes, p, .wait(.begin(label: nil))),
            .cursor("s_1", notes, p, .wait(.end)), .cursor("s_1", notes, p, .refused),
            .cursor("s_1", notes, p, .foreground(true)), .cursor("s_1", notes, p, .foreground(false)),
            .cursor("s_1", notes, p, .caption("Clicking “Save”")), .cursor("s_1", notes, p, .caption(nil)),
            .cursor("s_1", notes, p, .done),
        ])
    }

    func testAnUnknownKindOrAMissingPayloadIsDropped() {
        let rig = Rig()
        let p = CGPoint(x: 5, y: 6)
        act(rig, "teleport", at: p)
        act(rig, "target", at: p)          // no frame
        act(rig, "key", at: p)             // no combo
        act(rig, "drag", at: p)            // no end
        XCTAssertEqual(rig.presentation.calls, [], "nothing guessed")
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
