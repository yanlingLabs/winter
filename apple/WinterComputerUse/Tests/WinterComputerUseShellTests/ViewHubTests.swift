import CoreGraphics
import Foundation
import WinterComputerUseShell
import XCTest

/// Winter.app's view stream: who hears what, when a window is captured and at what rate, and the
/// window-relative cursor points.
@MainActor
final class ViewHubTests: XCTestCase {
    private func notes(_ session: String = "s_1", id: String = "t1", window: UInt32 = 77, mirror: Bool = true) -> ViewTarget {
        ViewTarget(sessionId: session, targetId: id, pid: 123, windowId: window, appName: "Notes", bundleId: "com.apple.Notes",
                   windowFrame: CGRect(x: 100, y: 50, width: 800, height: 600), mirror: mirror)
    }

    private func subscribe(_ rig: Rig, _ connection: Int, _ session: String = "s_1", frames: Bool, fps: Int? = nil, width: Int? = nil) -> [ViewTarget] {
        rig.viewHub.subscribe(connection: connection, ViewSubscribeParams(sessionId: session, frames: frames, maxFps: fps, maxWidth: width))
    }

    // MARK: Capture start/stop rules

    func testNothingIsCapturedWithoutAFramesSubscription() {
        let rig = Rig()
        rig.viewHub.bound(notes())
        XCTAssertTrue(rig.capture.started.isEmpty, "bound, nobody watching")
        _ = subscribe(rig, 1, frames: false)
        XCTAssertTrue(rig.capture.started.isEmpty, "watching without frames (bound/cursor info only)")
        _ = subscribe(rig, 2, "s_2", frames: true)
        XCTAssertTrue(rig.capture.started.isEmpty, "frames for another session")
    }

    func testAFramesSubscriptionCapturesTheBoundWindowAtTheDefaults() {
        let rig = Rig()
        _ = subscribe(rig, 1, frames: true)
        XCTAssertTrue(rig.capture.started.isEmpty, "nothing bound yet")
        rig.viewHub.bound(notes())
        XCTAssertEqual(rig.capture.live.map(\.windowID), [77])
        XCTAssertEqual(rig.capture.live.first?.maxFps, 10)
        XCTAssertEqual(rig.capture.live.first?.maxWidth, 720)
    }

    func testTheLowestRateAndWidthAnySubscriberAskedForWins() {
        let rig = Rig()
        rig.viewHub.bound(notes())
        _ = subscribe(rig, 1, frames: true, fps: 15, width: 1000)
        _ = subscribe(rig, 2, frames: true, fps: 5, width: 1200)
        _ = subscribe(rig, 3, frames: false, fps: 1, width: 100) // not asking for frames: no say in the rate
        XCTAssertEqual(rig.capture.live.count, 1)
        XCTAssertEqual(rig.capture.live.first.map { [$0.maxFps, $0.maxWidth] }, [5, 1000])
        rig.viewHub.unsubscribe(connection: 2, sessionId: "s_1")
        XCTAssertEqual(rig.capture.live.first.map { [$0.maxFps, $0.maxWidth] }, [15, 1000], "updated to the remaining subscriber's rate")
        XCTAssertEqual(rig.capture.started.count, 1, "one stream: lowered and raised in place — never restarted")
        XCTAssertEqual(rig.capture.started.first.map { $0.updates.map(\.maxFps) }, [5, 15], "a frames:false subscriber has no say")
    }

    func testOutOfRangeRequestsAreClamped() {
        let rig = Rig()
        rig.viewHub.bound(notes())
        _ = subscribe(rig, 1, frames: true, fps: 500, width: 10)
        XCTAssertEqual(rig.capture.live.first.map { [$0.maxFps, $0.maxWidth] }, [30, 64])
    }

    func testCaptureStopsWhenTheLastFramesSubscriberLeavesOrTheTargetIsReleased() {
        let rig = Rig()
        rig.viewHub.bound(notes())
        _ = subscribe(rig, 1, frames: true)
        rig.viewHub.unsubscribe(connection: 1, sessionId: "s_1")
        XCTAssertEqual(rig.capture.live.count, 1, "kept for the stop grace")
        rig.clock.advance(by: ViewHub.stopGrace)
        XCTAssertTrue(rig.capture.live.isEmpty)

        _ = subscribe(rig, 1, frames: true)
        XCTAssertEqual(rig.capture.live.count, 1)
        rig.viewHub.connectionClosed(1)
        rig.clock.advance(by: ViewHub.stopGrace)
        XCTAssertTrue(rig.capture.live.isEmpty, "the app went away")

        _ = subscribe(rig, 2, frames: true)
        rig.viewHub.release(targetId: "t1")
        XCTAssertTrue(rig.capture.live.isEmpty, "the target went away")
    }

    func testABindWithMirrorFalseIsNeverCaptured() {
        let rig = Rig()
        _ = subscribe(rig, 1, frames: true)
        rig.viewHub.bound(notes(mirror: false))
        XCTAssertTrue(rig.capture.started.isEmpty, "computerUse.mirror=false → no frames, ever")
        XCTAssertEqual(rig.sink.methods(1), ["view.bound"], "bound/cursor info still flows")
    }

    func testUseWindowMovesTheCaptureToTheNewWindowAndReannounces() {
        let rig = Rig()
        _ = subscribe(rig, 1, frames: true)
        rig.viewHub.bound(notes())
        rig.viewHub.windowChanged(targetId: "t1", windowId: 78, windowFrame: CGRect(x: 0, y: 0, width: 400, height: 300))
        XCTAssertEqual(rig.capture.live.map(\.windowID), [78])
        XCTAssertEqual(rig.sink.methods(1), ["view.bound", "view.bound"])
        XCTAssertEqual(rig.sink.events[1]?.last?["params"]?["windowSize"], json("[400,300]"))
    }

    func testAFailedCaptureStaysStoppedUntilSomethingChanges() {
        struct Boom: Error {}
        let rig = Rig()
        rig.viewHub.bound(notes())
        _ = subscribe(rig, 1, frames: true)
        rig.capture.live.first?.onError(Boom())
        XCTAssertTrue(rig.capture.live.isEmpty)
        XCTAssertTrue(rig.viewHub.capturing.isEmpty)
        _ = subscribe(rig, 1, frames: true, fps: 5)
        XCTAssertEqual(rig.capture.live.count, 1, "a new subscription tries again")
    }

    // MARK: Fan-out

    func testSubscribingAnswersTheSessionsBoundTargets() {
        let rig = Rig()
        rig.viewHub.bound(notes())
        rig.viewHub.bound(notes("s_2", id: "t9", window: 90))
        let targets = subscribe(rig, 1, frames: false)
        XCTAssertEqual(targets.map(\.targetId), ["t1"])
    }

    func testBoundReleasedAndCursorReachEverySubscriberOfThatSessionOnly() {
        let rig = Rig()
        _ = subscribe(rig, 1, frames: false)
        _ = subscribe(rig, 2, frames: true)
        _ = subscribe(rig, 3, "s_2", frames: true)
        rig.viewHub.bound(notes())
        rig.viewHub.cursor(sessionId: "s_1", pid: 123, windowId: 77, point: CGPoint(x: 150, y: 70), kind: "move", dragTo: nil,
                           frame: nil, text: nil, count: nil, button: nil)
        rig.viewHub.released(sessionId: "s_1", pid: 123, windowId: 77)
        rig.viewHub.release(targetId: "t1") // a second door for the same release: silent
        for connection in [1, 2] {
            XCTAssertEqual(rig.sink.methods(connection), ["view.bound", "view.cursor", "view.released"], "connection \(connection)")
        }
        XCTAssertEqual(rig.sink.methods(3), [])
        XCTAssertEqual(rig.sink.events[1]?.first?["params"],
                       json(#"{"sessionId":"s_1","targetId":"t1","pid":123,"windowId":77,"appName":"Notes","bundleId":"com.apple.Notes","windowSize":[800,600]}"#))
    }

    func testFramesGoToFramesSubscribersWithASeqAndNeverWithoutABoundTarget() {
        let rig = Rig()
        _ = subscribe(rig, 1, frames: false)
        _ = subscribe(rig, 2, frames: true)
        rig.viewHub.bound(notes())
        let capture = rig.capture.live[0]
        let frame = ViewFrame(jpeg: Data([0xFF, 0xD8, 0xFF]), width: 720, height: 540, windowSize: CGSize(width: 800, height: 600))
        var changed = frame
        changed.jpeg = Data([0xFF, 0xD8, 0xFE])
        capture.onFrame(frame)
        capture.onFrame(changed)
        XCTAssertNil(rig.sink.frames[1], "frames:false hears no frames")
        XCTAssertEqual(rig.sink.frames[2]?.count, 2)
        XCTAssertEqual(rig.sink.frames[2]?.first,
                       json(#"{"jsonrpc":"2.0","method":"view.frame","params":{"sessionId":"s_1","targetId":"t1","seq":1,"jpeg":"/9j/","width":720,"height":540,"windowSize":[800,600]}}"#))
        XCTAssertEqual(rig.sink.frames[2]?.last?["params"]?["seq"], .number(2))

        rig.viewHub.release(targetId: "t1")
        capture.onFrame(ViewFrame(jpeg: Data([1, 2, 3]), width: 1, height: 1, windowSize: .zero)) // a late frame from the stopped capture
        XCTAssertEqual(rig.sink.frames[2]?.count, 2, "nothing after the release")
    }

    func testALateFrameFromAReplacedCaptureIsDropped() {
        let rig = Rig()
        rig.viewHub.bound(notes())
        _ = subscribe(rig, 1, frames: true, fps: 10)
        let first = rig.capture.live[0]
        rig.viewHub.windowChanged(targetId: "t1", windowId: 78, windowFrame: CGRect(x: 0, y: 0, width: 400, height: 300)) // a new stream
        first.onFrame(ViewFrame(jpeg: Data([1]), width: 1, height: 1, windowSize: .zero))
        XCTAssertNil(rig.sink.frames[1])
        XCTAssertEqual(rig.viewHub.captureStats.restarts, 1)
    }

    func testSessionEndedReleasesEveryTargetOfTheSession() {
        let rig = Rig()
        _ = subscribe(rig, 1, frames: true)
        rig.viewHub.bound(notes())
        rig.viewHub.bound(notes(id: "t2", window: 88))
        rig.viewHub.bound(notes("s_2", id: "t3", window: 99))
        rig.viewHub.sessionEnded(sessionId: "s_1")
        XCTAssertEqual(Set(rig.viewHub.targets.keys), ["t3"])
        XCTAssertEqual(rig.sink.methods(1).filter { $0 == "view.released" }.count, 2)
        XCTAssertTrue(rig.capture.live.isEmpty)
    }

    // MARK: Window-relative points

    func testWindowRelativeConversion() {
        let origin = CGPoint(x: 100, y: 50)
        XCTAssertEqual(WindowRelative.point(CGPoint(x: 150, y: 70), origin: origin), CGPoint(x: 50, y: 20))
        XCTAssertEqual(WindowRelative.point(CGPoint(x: 90, y: 40), origin: origin), CGPoint(x: -10, y: -10), "outside the window stays outside")
        XCTAssertEqual(WindowRelative.rect(CGRect(x: 110, y: 60, width: 30, height: 10), origin: origin), CGRect(x: 10, y: 10, width: 30, height: 10))
        XCTAssertEqual(ViewTarget.rect([1, 2, 3, 4]), CGRect(x: 1, y: 2, width: 3, height: 4))
        XCTAssertEqual(ViewTarget.rect([1, 2]), .zero)
    }

    func testCursorPointsAreRelativeToWhereTheWindowIsNowElseWhereItWasBound() {
        let rig = Rig()
        _ = subscribe(rig, 1, frames: false)
        rig.viewHub.bound(notes()) // bound at (100, 50)
        rig.viewHub.cursor(sessionId: "s_1", pid: 123, windowId: 77, point: CGPoint(x: 150, y: 70), kind: "target", dragTo: nil,
                           frame: CGRect(x: 140, y: 60, width: 30, height: 20), text: nil, count: nil, button: nil)
        rig.geometry.frames[77] = CGRect(x: 300, y: 200, width: 800, height: 600) // the user moved the window
        rig.clock.advance(by: ViewHub.originTTL) // (the origin is re-read at most every half second)
        rig.viewHub.cursor(sessionId: "s_1", pid: 123, windowId: 77, point: CGPoint(x: 310, y: 210), kind: "drag",
                           dragTo: CGPoint(x: 400, y: 260), frame: nil, text: nil, count: nil, button: nil)
        rig.viewHub.cursor(sessionId: "s_1", pid: 123, windowId: 77, point: CGPoint(x: 310, y: 210), kind: "key", dragTo: nil,
                           frame: nil, text: "cmd+s", count: nil, button: nil)
        let params = (rig.sink.events[1] ?? []).dropFirst().map { $0["params"]! }
        XCTAssertEqual(params, [
            json(#"{"sessionId":"s_1","targetId":"t1","kind":"target","point":[50,20],"frame":[40,10,30,20]}"#),
            json(#"{"sessionId":"s_1","targetId":"t1","kind":"drag","point":[10,10],"dragTo":[100,60]}"#),
            json(#"{"sessionId":"s_1","targetId":"t1","kind":"key","point":[10,10],"text":"cmd+s"}"#),
        ])
    }

    func testACursorEventForAnUnknownWindowOrWithNoSubscriberSaysNothing() {
        let rig = Rig()
        rig.viewHub.bound(notes())
        rig.viewHub.cursor(sessionId: "s_1", pid: 123, windowId: 77, point: .zero, kind: "move", dragTo: nil, frame: nil, text: nil, count: nil, button: nil)
        _ = subscribe(rig, 1, frames: false)
        rig.viewHub.cursor(sessionId: "s_1", pid: 123, windowId: 999, point: .zero, kind: "move", dragTo: nil, frame: nil, text: nil, count: nil, button: nil)
        XCTAssertEqual(rig.sink.methods(1), [])
    }

    // MARK: Through the coordinator (the engine's events)

    func testTheEnginesEventsReachTheViewStream() {
        let rig = Rig()
        _ = subscribe(rig, 1, frames: true)
        rig.viewHub.bound(notes())
        rig.coordinator.targetBound(sessionId: "s_1", pid: 123, windowID: 77, appName: "Notes", mirror: true)
        rig.coordinator.actionAt(sessionId: "s_1", pid: 123, windowID: 77, point: CGPoint(x: 110, y: 60), kind: "press", dragTo: nil,
                                 frame: nil, text: nil, count: 2, button: "left")
        rig.coordinator.targetLost(targetId: "t1", reason: "app_quit")
        rig.coordinator.targetReleased(sessionId: "s_1", pid: 123, windowID: 77)
        XCTAssertEqual(rig.sink.methods(1), ["view.bound", "view.cursor", "view.released"])
        XCTAssertTrue(rig.capture.live.isEmpty)
        XCTAssertEqual(rig.notifications, [.targetLost(targetId: "t1", reason: "app_quit")])
    }
}
