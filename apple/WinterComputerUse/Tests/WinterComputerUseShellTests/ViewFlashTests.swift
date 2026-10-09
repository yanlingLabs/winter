import CoreGraphics
import Foundation
import WinterComputerUseShell
import XCTest

/// The in-Winter mirror must not flash on every action: a re-bind of the same window says nothing, rate changes
/// update the running stream in place, the idle drop waits for real quiet, and an unwatched stream lingers.
@MainActor
final class ViewFlashTests: XCTestCase {
    private func safari(size: CGSize = CGSize(width: 1211, height: 824), window: UInt32 = 86498) -> ViewTarget {
        ViewTarget(sessionId: "s_1", targetId: "t1", pid: 123, windowId: window, appName: "Safari", bundleId: "com.apple.Safari",
                   windowFrame: CGRect(origin: CGPoint(x: 100, y: 50), size: size), mirror: true)
    }

    private func act(_ rig: Rig) {
        rig.viewHub.cursor(sessionId: "s_1", pid: 123, windowId: 86498, point: CGPoint(x: 110, y: 60), kind: "press", dragTo: nil,
                           frame: nil, text: nil, count: 1, button: "left")
    }

    private func watch(_ rig: Rig, _ connection: Int = 1) {
        _ = rig.viewHub.subscribe(connection: connection, ViewSubscribeParams(sessionId: "s_1", frames: true))
    }

    // MARK: Idempotent bind

    func testAReBindOfTheSameWindowIsNotReAnnounced() {
        let rig = Rig()
        watch(rig)
        rig.viewHub.bound(safari())
        for _ in 0..<5 { rig.viewHub.bound(safari()) } // every script binds Safari again
        XCTAssertEqual(rig.sink.methods(1), ["view.bound"], "announced once")
        XCTAssertEqual(rig.capture.started.count, 1, "and its stream is never touched")
    }

    func testAReBindAtAnotherSizeIsAnInPlaceResizeNotAnAnnouncement() {
        let rig = Rig()
        watch(rig)
        rig.viewHub.bound(safari(size: CGSize(width: 1211, height: 824)))
        rig.viewHub.bound(safari(size: CGSize(width: 1512, height: 949)))
        rig.viewHub.bound(safari(size: CGSize(width: 1211, height: 824)))
        XCTAssertEqual(rig.sink.methods(1), ["view.bound"])
        XCTAssertEqual(rig.viewHub.targets["t1"]?.windowFrame.size, CGSize(width: 1211, height: 824), "the stored facts follow")
        XCTAssertEqual(rig.capture.started.count, 1)
        // The size reaches Winter.app on the frames, which it applies to the shown mirror in place.
        rig.capture.live[0].onFrame(ViewFrame(jpeg: Data([1]), width: 720, height: 392, windowSize: CGSize(width: 1512, height: 949)))
        XCTAssertEqual(rig.sink.frames[1]?.last?["params"]?["windowSize"], .array([.number(1512), .number(949)]))
    }

    func testAReBindOnAnotherWindowIsAnnouncedAndRestartsTheStream() {
        let rig = Rig()
        watch(rig)
        rig.viewHub.bound(safari())
        rig.viewHub.bound(safari(window: 90000))
        XCTAssertEqual(rig.sink.methods(1), ["view.bound", "view.bound"])
        XCTAssertEqual(rig.capture.live.map(\.windowID), [90000])
        XCTAssertEqual(rig.viewHub.captureStats.restarts, 1)
    }

    func testAReBindCountsAsAnAction() {
        let rig = Rig()
        watch(rig)
        rig.viewHub.bound(safari())
        rig.clock.advance(by: 3)
        XCTAssertEqual(rig.capture.live.first?.maxFps, 1)
        rig.viewHub.bound(safari())
        XCTAssertEqual(rig.capture.live.first?.maxFps, 10, "the next script woke it, in place")
        XCTAssertEqual(rig.capture.started.count, 1)
    }

    // MARK: Rate changes update the running stream

    func testIdleAndWakeAreInPlaceUpdatesNeverRestarts() {
        let rig = Rig()
        watch(rig)
        rig.viewHub.bound(safari())
        for _ in 0..<4 {
            rig.clock.advance(by: 3) // quiet: down
            act(rig)                 // an action: up
        }
        XCTAssertEqual(rig.capture.started.count, 1, "one SCStream for the whole session")
        XCTAssertEqual(rig.capture.started[0].updates.map(\.maxFps), [1, 10, 1, 10, 1, 10, 1, 10])
        XCTAssertEqual(rig.viewHub.captureStats.starts, 1)
        XCTAssertEqual(rig.viewHub.captureStats.restarts, 0)
        XCTAssertEqual(rig.viewHub.captureStats.updates, 8)
    }

    func testNoFlipBackToIdleWithinThreeSecondsOfAnAction() {
        let rig = Rig()
        watch(rig)
        rig.viewHub.bound(safari())
        rig.clock.advance(by: 3)
        act(rig) // up
        rig.clock.advance(by: 0.5)
        // Anything that asks for a refresh meanwhile (another subscriber, a visibility tick) must not drop it.
        _ = rig.viewHub.subscribe(connection: 2, ViewSubscribeParams(sessionId: "s_1", frames: false))
        rig.clock.advance(by: 1)
        XCTAssertEqual(rig.capture.live.first?.maxFps, 10)
        XCTAssertEqual(rig.capture.started[0].updates.map(\.maxFps), [1, 10], "no 10 → 1 within seconds")
        rig.clock.advance(by: 1.5)
        XCTAssertEqual(rig.capture.live.first?.maxFps, 1, "3 s after the last action")
    }

    // MARK: A stream nobody watches lingers

    func testASubscriptionThatGoesAndComesBackReusesTheStream() {
        let rig = Rig()
        watch(rig)
        rig.viewHub.bound(safari())
        rig.viewHub.unsubscribe(connection: 1, sessionId: "s_1")
        rig.clock.advance(by: ViewHub.stopGrace - 1)
        watch(rig)
        // Past the grace: the pending stop was dropped. (The window keeps changing, so it is never paused.)
        for i in 0..<10 {
            rig.capture.live.first?.onFrame(ViewFrame(jpeg: Data([UInt8(i)]), width: 720, height: 392, windowSize: CGSize(width: 1211, height: 824)))
            rig.clock.advance(by: 1)
        }
        XCTAssertEqual(rig.capture.started.count, 1)
        XCTAssertEqual(rig.capture.live.count, 1)
    }

    func testAMirrorFalseBindOrAReleaseStopsAtOnce() {
        let rig = Rig()
        watch(rig)
        rig.viewHub.bound(safari())
        var off = safari()
        off.mirror = false
        rig.viewHub.bound(off) // the user turned the mirror off
        XCTAssertTrue(rig.capture.live.isEmpty)
    }

    // MARK: The minute line

    func testOneLineAMinuteCountsStartsRestartsAndUpdates() {
        let rig = Rig()
        watch(rig)
        rig.viewHub.bound(safari())
        rig.clock.advance(by: 3)
        act(rig)
        rig.clock.advance(by: ViewHub.statsInterval - 3)
        let line = rig.logLines.last { $0.contains("in the last 60 s") }
        XCTAssertEqual(line, "view: in the last 60 s — 1 stream start(s), 0 restart(s), 3 in-place update(s); 1 capturing now")
        XCTAssertEqual(rig.viewHub.captureStats.starts, 0, "counted afresh each minute")
    }

    func testNoMinuteLineWhenNothingIsCaptured() {
        let rig = Rig()
        rig.viewHub.bound(safari())
        rig.clock.advance(by: 120)
        XCTAssertFalse(rig.logLines.contains { $0.contains("in the last 60 s") })
    }
}
