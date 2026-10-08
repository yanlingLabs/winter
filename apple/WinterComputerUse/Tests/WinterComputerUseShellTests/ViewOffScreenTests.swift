import CoreGraphics
import Foundation
import WinterComputerUseShell
import XCTest

/// A bound window that goes off every screen (another Space or display, minimized) keeps its view: the live
/// capture pauses, one-shot snapshots are tried, the last frame stays — and a session with two bound targets
/// streams both.
@MainActor
final class ViewOffScreenTests: XCTestCase {
    private func target(_ id: String = "t1", window: UInt32 = 77, app: String = "Safari") -> ViewTarget {
        ViewTarget(sessionId: "s_1", targetId: id, pid: 123, windowId: window, appName: app, bundleId: "com.apple.Safari",
                   windowFrame: CGRect(x: 100, y: 50, width: 800, height: 600), mirror: true)
    }

    private func frame(_ byte: UInt8, size: CGSize = CGSize(width: 800, height: 600)) -> ViewFrame {
        ViewFrame(jpeg: Data(repeating: byte, count: 32), width: 720, height: 540, windowSize: size)
    }

    private func act(_ rig: Rig, window: UInt32 = 77) {
        rig.viewHub.cursor(sessionId: "s_1", pid: 123, windowId: window, point: CGPoint(x: 110, y: 60), kind: "press", dragTo: nil,
                           frame: nil, text: nil, count: 1, button: "left")
    }

    private func watched(_ rig: Rig) {
        _ = rig.viewHub.subscribe(connection: 1, ViewSubscribeParams(sessionId: "s_1", frames: true))
    }

    // MARK: The view is kept

    func testAWindowGoingOffScreenKeepsItsViewAndPausesOnlyTheLiveCapture() {
        let rig = Rig()
        rig.viewHub.bound(target())
        watched(rig)
        rig.capture.live[0].onFrame(frame(1))
        rig.geometry.onScreen[77] = false // the user switched Spaces; Safari stayed behind
        rig.clock.advance(by: ViewHub.visibilityPollInterval)
        XCTAssertTrue(rig.viewHub.isOffScreen("t1"))
        XCTAssertTrue(rig.capture.live.isEmpty, "a live stream sees nothing off screen: it is stopped, not restarted on every action")
        XCTAssertFalse(rig.sink.methods(1).contains("view.released"), "never view.released for being off screen")
        XCTAssertEqual(rig.viewHub.targets.keys.sorted(), ["t1"])
        act(rig)
        XCTAssertTrue(rig.capture.live.isEmpty, "the agent acting on it there does not churn a stream either")
        XCTAssertTrue(rig.logLines.contains { $0.contains("is off screen") && $0.contains("view stays") }, "\(rig.logLines)")
    }

    func testTheLastFrameStaysAndANewSubscriberGetsIt() {
        let rig = Rig()
        rig.viewHub.bound(target())
        watched(rig)
        rig.capture.live[0].onFrame(frame(1))
        rig.geometry.onScreen[77] = false
        rig.clock.advance(by: ViewHub.visibilityPollInterval)
        rig.snapshotter.answer(nil) // macOS rendered nothing for it
        _ = rig.viewHub.subscribe(connection: 2, ViewSubscribeParams(sessionId: "s_1", frames: true))
        XCTAssertEqual(rig.sink.frames[2]?.count, 1, "the last frame from before it went off screen")
        XCTAssertEqual(rig.sink.frames[2]?.first?["params"]?["seq"], .number(1))
        XCTAssertEqual(rig.sink.frames[1]?.count, 1, "and nothing blank replaced it for the first subscriber")
        XCTAssertTrue(rig.logLines.contains { $0.contains("no snapshot") && $0.contains("last frame stays") })
    }

    func testABoundWindowThatStartsOffScreenIsNeverStreamedButIsSnapshotted() {
        let rig = Rig()
        rig.geometry.onScreen[77] = false
        watched(rig)
        rig.viewHub.bound(target())
        XCTAssertTrue(rig.viewHub.isOffScreen("t1"))
        XCTAssertTrue(rig.capture.started.isEmpty)
        rig.clock.advance(by: ViewHub.visibilityPollInterval)
        XCTAssertEqual(rig.snapshotter.requests.map(\.windowID), [77])
        XCTAssertEqual(rig.snapshotter.requests.first?.maxWidth, 720)
        rig.snapshotter.answer(frame(9))
        XCTAssertEqual(rig.sink.frames[1]?.count, 1, "a snapshot is a frame like any other")
    }

    // MARK: Snapshots while off screen

    /// Advances in quarter seconds, answering every snapshot asked for with `answer` at once; the requests made.
    private func run(_ rig: Rig, for seconds: Double, answer: ViewFrame?) -> [TimeInterval] {
        var asked: [TimeInterval] = []
        for _ in 0..<Int(seconds * 4) {
            rig.clock.advance(by: 0.25)
            if !rig.snapshotter.requests.isEmpty {
                asked.append(rig.clock.now)
                rig.snapshotter.answer(answer)
            }
        }
        return asked
    }

    func testSnapshotsComeTwiceASecondWhileWorkedInAndOnceASecondOtherwise() {
        let rig = Rig()
        rig.viewHub.bound(target())
        watched(rig)
        rig.geometry.onScreen[77] = false
        rig.clock.advance(by: 1) // detected; the first snapshot is due at once
        XCTAssertEqual(rig.snapshotter.requests.count, 1)
        rig.snapshotter.answer(frame(1))
        // Active until 3 s after the bind: every half second.
        XCTAssertEqual(run(rig, for: 1.75, answer: frame(2)), [1.5, 2.0, 2.5])
        // Idle from then: every second.
        let idle = run(rig, for: 5, answer: frame(3))
        XCTAssertEqual(idle.count, 5, "\(idle)")
        XCTAssertEqual(zip(idle.dropFirst(), idle).map { $0 - $1 }, [1, 1, 1, 1])
        XCTAssertEqual(rig.sink.frames[1]?.count, 3, "an unchanged snapshot is not sent again")
    }

    func testASlowSnapshotIsFollowedByTheNextOneAtOnceNotAFullIntervalLater() {
        let rig = Rig()
        rig.viewHub.bound(target())
        watched(rig)
        rig.geometry.onScreen[77] = false
        rig.clock.advance(by: 1)
        XCTAssertEqual(rig.snapshotter.requests.count, 1)
        rig.clock.advance(by: 0.75) // the capture took 0.75 s, past the 0.5 s cadence
        rig.snapshotter.answer(frame(1))
        rig.clock.advance(by: 0.01)
        XCTAssertEqual(rig.snapshotter.requests.count, 1, "due since 1.5 s: asked for at once")
    }

    func testRepeatedEmptySnapshotsBackOffToThirtySeconds() {
        let rig = Rig()
        rig.viewHub.bound(target())
        watched(rig)
        rig.clock.advance(by: 3) // idle
        rig.geometry.onScreen[77] = false
        rig.clock.advance(by: 1)
        rig.snapshotter.answer(nil)
        let asked = run(rig, for: 60, answer: nil)
        // first at once (4 s), then 5 s, 6 s, then every 30 s
        XCTAssertEqual(asked, [5, 6, 36], "not a capture a second for a window macOS will not render")
    }

    func testAnActionOnAnOffScreenWindowAsksForASnapshotAtOnce() {
        let rig = Rig()
        rig.viewHub.bound(target())
        watched(rig)
        rig.clock.advance(by: 3)
        rig.geometry.onScreen[77] = false
        rig.clock.advance(by: 1)
        rig.snapshotter.answer(nil)
        XCTAssertEqual(run(rig, for: 5, answer: nil), [5, 6]) // backing off to 30 s now
        act(rig)
        rig.clock.advance(by: 0.25)
        XCTAssertEqual(rig.snapshotter.requests.count, 1, "the agent is working there: show what it does")
        rig.snapshotter.answer(frame(1))
        XCTAssertEqual(run(rig, for: 1, answer: frame(2)), [9.75, 10.25], "and twice a second while it does")
    }

    // MARK: Back on screen

    func testBackOnScreenTheLiveCaptureResumes() {
        let rig = Rig()
        rig.viewHub.bound(target())
        watched(rig)
        rig.geometry.onScreen[77] = false
        rig.clock.advance(by: 1)
        XCTAssertTrue(rig.capture.live.isEmpty)
        rig.geometry.onScreen[77] = true
        rig.clock.advance(by: 1)
        XCTAssertFalse(rig.viewHub.isOffScreen("t1"))
        XCTAssertEqual(rig.capture.live.map(\.windowID), [77])
        XCTAssertTrue(rig.logLines.contains { $0.contains("back on screen") })
    }

    func testALateSnapshotAfterTheWindowCameBackIsDropped() {
        let rig = Rig()
        rig.viewHub.bound(target())
        watched(rig)
        rig.geometry.onScreen[77] = false
        rig.clock.advance(by: 1)
        XCTAssertEqual(rig.snapshotter.requests.count, 1)
        rig.geometry.onScreen[77] = true
        rig.clock.advance(by: 1)
        rig.snapshotter.answer(frame(5))
        XCTAssertNil(rig.sink.frames[1], "the live stream owns the picture again")
    }

    // MARK: Two bound targets

    func testEveryBoundTargetOfAWatchedSessionStreamsTheActiveOneAtFullRate() {
        let rig = Rig()
        rig.viewHub.bound(target("t1", window: 77, app: "Safari"))
        rig.viewHub.bound(target("t2", window: 88, app: "Notes"))
        watched(rig)
        XCTAssertEqual(Set(rig.capture.live.map(\.windowID)), [77, 88], "both are captured")
        rig.clock.advance(by: 3)
        XCTAssertEqual(rig.capture.live.map(\.maxFps), [1, 1], "both idle")
        act(rig, window: 88) // the agent works in Notes
        let byWindow = Dictionary(uniqueKeysWithValues: rig.capture.live.map { ($0.windowID, $0) })
        XCTAssertEqual(byWindow[88]?.maxFps, 10)
        XCTAssertEqual(byWindow[77]?.maxFps, 1, "Safari keeps streaming at the idle rate")

        byWindow[77]?.onFrame(frame(1))
        byWindow[88]?.onFrame(frame(2))
        byWindow[77]?.onFrame(frame(1)) // unchanged: skipped
        byWindow[88]?.onFrame(frame(3))
        let sent = (rig.sink.frames[1] ?? []).map { [$0["params"]?["targetId"], $0["params"]?["seq"]] }
        XCTAssertEqual(sent, [[.string("t1"), .number(1)], [.string("t2"), .number(1)], [.string("t2"), .number(2)]],
                       "both reach the app, each with its own seq; the app shows the one with the latest event")
    }

    func testOneTargetOffScreenDoesNotStopTheOther() {
        let rig = Rig()
        rig.viewHub.bound(target("t1", window: 77))
        rig.viewHub.bound(target("t2", window: 88, app: "Notes"))
        watched(rig)
        rig.geometry.onScreen[77] = false
        rig.clock.advance(by: 1)
        XCTAssertEqual(rig.capture.live.map(\.windowID), [88])
        XCTAssertEqual(rig.viewHub.targets.keys.sorted(), ["t1", "t2"])
        XCTAssertFalse(rig.sink.methods(1).contains("view.released"))
    }

    // MARK: Never a window of no size

    func testAFrameReportingNoWindowSizeCarriesTheWindowServersSize() {
        let rig = Rig()
        rig.viewHub.bound(target())
        watched(rig)
        rig.geometry.frames[77] = CGRect(x: 0, y: 0, width: 1211, height: 824)
        rig.capture.live[0].onFrame(frame(1, size: .zero))
        XCTAssertEqual(rig.sink.frames[1]?.last?["params"]?["windowSize"], .array([.number(1211), .number(824)]))
        rig.geometry.frames[77] = nil // the window server does not know it either: the bind-time size
        rig.capture.live[0].onFrame(frame(2, size: .zero))
        XCTAssertEqual(rig.sink.frames[1]?.last?["params"]?["windowSize"], .array([.number(800), .number(600)]))
    }

    func testABindReportingNoWindowSizeAnnouncesTheWindowServersSize() {
        let rig = Rig()
        watched(rig)
        rig.geometry.frames[77] = CGRect(x: 10, y: 20, width: 1211, height: 824)
        var empty = target()
        empty.windowFrame = .zero
        rig.viewHub.bound(empty)
        XCTAssertEqual(rig.sink.events[1]?.first?["params"]?["windowSize"], .array([.number(1211), .number(824)]))
        let listed = rig.viewHub.subscribe(connection: 2, ViewSubscribeParams(sessionId: "s_1", frames: false))
        XCTAssertEqual(listed.first?.windowFrame.size, CGSize(width: 1211, height: 824))
    }

    // MARK: Logs

    func testTheViewLifecycleIsLogged() {
        let rig = Rig()
        watched(rig)
        rig.viewHub.bound(target())
        rig.viewHub.release(targetId: "t1", reason: "target.release from the daemon")
        let joined = rig.logLines.joined(separator: "\n")
        for needle in ["subscribed to s_1", "t1 bound", "capture of t1", "started", "stopped", "released — target.release from the daemon"] {
            XCTAssertTrue(joined.contains(needle), "missing \"\(needle)\" in:\n\(joined)")
        }
    }
}
