import CoreGraphics
import Foundation
import WinterComputerUseShell
import XCTest

/// An idle bound window — no action for `idleAfter`, a picture unchanged for `pauseAfterUnchanged` — is PAUSED: its
/// live capture stops (off screen: its stills stop), the last frame stays up, and a still every `pausedPeekInterval`
/// checks it for change. An action, a changed picture, a new frames subscriber or the window going off or back on
/// screen resume it. All on fakes: the clock, the capture and the stills are driven by hand.
@MainActor
final class ViewPauseTests: XCTestCase {
    private func safari() -> ViewTarget {
        ViewTarget(sessionId: "s_1", targetId: "t1", pid: 123, windowId: 77, appName: "Safari", bundleId: "com.apple.Safari",
                   windowFrame: CGRect(x: 100, y: 50, width: 800, height: 600), mirror: true)
    }

    private func frame(_ byte: UInt8) -> ViewFrame {
        ViewFrame(jpeg: Data(repeating: byte, count: 32), width: 720, height: 540, windowSize: CGSize(width: 800, height: 600))
    }

    private func act(_ rig: Rig) {
        rig.viewHub.cursor(sessionId: "s_1", pid: 123, windowId: 77, point: CGPoint(x: 110, y: 60), kind: "press", dragTo: nil,
                           frame: nil, text: nil, count: 1, button: "left")
    }

    private func watch(_ rig: Rig, _ connection: Int = 1) {
        _ = rig.viewHub.subscribe(connection: connection, ViewSubscribeParams(sessionId: "s_1", frames: true))
    }

    /// Steps the clock to `until` in `step`s; every still asked for is answered with `answer(now)` at once. The
    /// times stills were asked for.
    @discardableResult
    private func run(_ rig: Rig, until: TimeInterval, step: TimeInterval = 0.25, answer: (TimeInterval) -> ViewFrame?) -> [TimeInterval] {
        var asked: [TimeInterval] = []
        while rig.clock.now + step <= until + 1e-9 {
            rig.clock.advance(by: step)
            if !rig.snapshotter.requests.isEmpty {
                asked.append(rig.clock.now)
                rig.snapshotter.answer(answer(rig.clock.now))
            }
        }
        return asked
    }

    /// Bound and watched at 0 with one frame sent; paused at 5 s (its baseline still answered with frame 1).
    private func pausedRig() -> Rig {
        let rig = Rig()
        watch(rig)
        rig.viewHub.bound(safari())
        rig.capture.live[0].onFrame(frame(1))
        run(rig, until: 5, step: 1) { _ in self.frame(1) }
        return rig
    }

    // MARK: On screen: the stream

    func testAnUnchangedUnworkedInWindowPausesItsStreamAfterFiveSeconds() {
        let rig = Rig()
        watch(rig)
        rig.viewHub.bound(safari())
        rig.capture.live[0].onFrame(frame(1))
        for second in 1...4 {
            rig.clock.advance(by: 1)
            XCTAssertFalse(rig.viewHub.isPaused("t1"), "at \(second) s")
            XCTAssertEqual(rig.capture.live.count, 1)
        }
        rig.clock.advance(by: 1)
        XCTAssertTrue(rig.viewHub.isPaused("t1"))
        XCTAssertTrue(rig.capture.live.isEmpty, "no stream for a window that neither changes nor is worked in")
        XCTAssertEqual(rig.sink.frames[1]?.count, 1, "the last frame stays up: nothing blank or new is sent")
        XCTAssertFalse(rig.sink.methods(1).contains("view.released"))
        XCTAssertEqual(rig.snapshotter.requests.count, 1, "one still now, the baseline the checks compare against")
        XCTAssertNil(rig.snapshotter.requests.first?.unlessDigest)
        XCTAssertTrue(rig.logLines.contains { $0.contains("t1 (Safari window 77) paused") }, "\(rig.logLines)")
        rig.snapshotter.answer(frame(1))
        XCTAssertTrue(rig.viewHub.isPaused("t1"), "the baseline is not a change")
        XCTAssertEqual(rig.sink.frames[1]?.count, 1, "and it is not sent")
    }

    func testAWindowThatKeepsChangingIsNeverPaused() {
        let rig = Rig()
        watch(rig)
        rig.viewHub.bound(safari())
        for second in 0..<30 {
            rig.capture.live.first?.onFrame(frame(UInt8(second)))
            rig.clock.advance(by: 1)
        }
        XCTAssertFalse(rig.viewHub.isPaused("t1"))
        XCTAssertEqual(rig.capture.live.map(\.maxFps), [1], "streaming at the idle rate")
        XCTAssertEqual(rig.capture.started.count, 1)
    }

    func testRepeatedIdenticalFramesDoNotCountAsAChange() {
        let rig = Rig()
        watch(rig)
        rig.viewHub.bound(safari())
        for _ in 0..<6 {
            rig.capture.live.first?.onFrame(frame(4)) // the window redraws the same pixels
            rig.clock.advance(by: 1)
        }
        XCTAssertTrue(rig.viewHub.isPaused("t1"))
    }

    func testAnActionResumesAPausedStreamAtFullRate() {
        let rig = pausedRig()
        run(rig, until: 34, step: 1) { _ in self.frame(1) }
        rig.clock.advance(by: 1) // a check is in flight
        XCTAssertEqual(rig.snapshotter.requests.count, 1)
        XCTAssertTrue(rig.viewHub.isPaused("t1"))
        act(rig)
        XCTAssertFalse(rig.viewHub.isPaused("t1"))
        XCTAssertEqual(rig.capture.live.map(\.maxFps), [10])
        XCTAssertEqual(rig.capture.started.count, 2)
        XCTAssertTrue(rig.logLines.contains { $0.contains("t1 (Safari) resumed — an action") })
        // The late answer to a check made while paused is dropped: the stream owns the picture again.
        rig.snapshotter.answer(frame(9))
        XCTAssertEqual(rig.sink.frames[1]?.count, 1)
    }

    func testAPausedWindowIsCheckedEveryThirtySecondsAndAChangeResumesIt() {
        let rig = pausedRig()
        let asked = run(rig, until: 64, step: 1) { _ in self.frame(1) }
        XCTAssertEqual(asked, [35], "one check 30 s after the baseline; unchanged: still paused")
        XCTAssertTrue(rig.viewHub.isPaused("t1"))
        XCTAssertEqual(rig.snapshotter.requests.count, 0)
        let changed = run(rig, until: 66, step: 1) { _ in self.frame(2) }
        XCTAssertEqual(changed, [65])
        XCTAssertFalse(rig.viewHub.isPaused("t1"), "the picture changed by itself (a page loaded, a video)")
        XCTAssertEqual(rig.capture.live.map(\.maxFps), [1], "streaming again, at the idle rate: nobody acted")
        XCTAssertTrue(rig.logLines.contains { $0.contains("resumed — its picture changed") })
    }

    func testTheChecksPassTheLastDigestSoAnUnchangedStillIsNeverEncoded() {
        let rig = pausedRig()
        run(rig, until: 34, step: 1) { _ in self.frame(1) }
        rig.clock.advance(by: 1)
        XCTAssertEqual(rig.snapshotter.requests.first?.unlessDigest, FakeSnapshotter.digest(frame(1)))
    }

    func testANewFramesSubscriberResumesButARepeatedSubscriptionDoesNot() {
        let rig = pausedRig()
        watch(rig) // the same subscription again, frames still on
        XCTAssertTrue(rig.viewHub.isPaused("t1"))
        watch(rig, 2) // Winter.app opened the view on another connection
        XCTAssertFalse(rig.viewHub.isPaused("t1"))
        XCTAssertEqual(rig.capture.live.count, 1)
        XCTAssertEqual(rig.sink.frames[2]?.count, 1, "and gets the last frame at once, as always")
        XCTAssertTrue(rig.logLines.contains { $0.contains("resumed — a new frames subscriber") })
    }

    func testAPausedWindowStaysBoundAndItsReleaseIsClean() {
        let rig = pausedRig()
        XCTAssertEqual(rig.viewHub.targets.keys.sorted(), ["t1"])
        rig.viewHub.release(targetId: "t1")
        XCTAssertFalse(rig.viewHub.isPaused("t1"))
        XCTAssertEqual(run(rig, until: 60, step: 1) { _ in self.frame(1) }, [], "no checks for a released window")
    }

    // MARK: Off screen: the stills

    func testOffScreenStillsPauseWhenUnchangedAndAChangeResumesThem() {
        let rig = Rig()
        rig.geometry.onScreen[77] = false
        watch(rig)
        rig.viewHub.bound(safari())
        let asked = run(rig, until: 40) { _ in self.frame(1) }
        // Worked in (twice a second, its own timer) until 3 s; idle, on the visibility poll's once-a-second tick;
        // unchanged for 5 s at the 6 s tick: paused, checked on the first tick 30 s after the last still.
        XCTAssertEqual(asked, [0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 4, 5, 36], "\(asked)")
        XCTAssertTrue(rig.viewHub.isPaused("t1"))
        XCTAssertTrue(rig.viewHub.isOffScreen("t1"), "paused, not released: the view stays")
        XCTAssertEqual(rig.sink.frames[1]?.count, 1, "an unchanged still is never sent again")
        let after = run(rig, until: 70) { _ in self.frame(2) }
        XCTAssertEqual(Array(after.prefix(3)), [66, 67, 68], "a changed check resumes the once-a-second stills")
        XCTAssertEqual(rig.sink.frames[1]?.count, 2, "the changed still is sent")
        XCTAssertFalse(rig.viewHub.isPaused("t1"))
    }

    func testAnActionOnAPausedOffScreenWindowAsksForAStillAtOnce() {
        let rig = Rig()
        rig.geometry.onScreen[77] = false
        watch(rig)
        rig.viewHub.bound(safari())
        run(rig, until: 10) { _ in self.frame(1) }
        XCTAssertTrue(rig.viewHub.isPaused("t1"))
        act(rig)
        XCTAssertFalse(rig.viewHub.isPaused("t1"))
        XCTAssertEqual(run(rig, until: 11) { _ in self.frame(2) }, [10.25, 10.75], "twice a second while worked in")
    }

    // MARK: Visibility while paused

    func testAPausedWindowGoingOffScreenIsLookedAtAfresh() {
        let rig = pausedRig()
        rig.snapshotter.answer(frame(1))
        rig.geometry.onScreen[77] = false
        rig.clock.advance(by: 2) // the slow poll
        XCTAssertTrue(rig.viewHub.isOffScreen("t1"))
        XCTAssertFalse(rig.viewHub.isPaused("t1"), "where it went, it is looked at again")
        XCTAssertEqual(rig.snapshotter.requests.count, 1)
    }

    func testAPausedWindowComingBackOnScreenStreamsAgain() {
        let rig = Rig()
        rig.geometry.onScreen[77] = false
        watch(rig)
        rig.viewHub.bound(safari())
        run(rig, until: 10) { _ in self.frame(1) }
        XCTAssertTrue(rig.viewHub.isPaused("t1"))
        rig.geometry.onScreen[77] = true
        rig.clock.advance(by: 2)
        XCTAssertFalse(rig.viewHub.isOffScreen("t1"))
        XCTAssertFalse(rig.viewHub.isPaused("t1"))
        XCTAssertEqual(rig.capture.live.map(\.windowID), [77])
    }

    func testTheVisibilityPollSlowsWhileEverythingWatchedIsPaused() {
        let rig = pausedRig()
        rig.snapshotter.answer(frame(1))
        let before = rig.geometry.visibilityCalls
        run(rig, until: 25, step: 1) { _ in self.frame(1) }
        XCTAssertEqual(rig.geometry.visibilityCalls - before, 10, "every 2 s, not every second")
    }

    // MARK: Counted

    func testTheMinuteLineCountsPausesAndResumes() {
        let rig = pausedRig()
        rig.snapshotter.answer(frame(1))
        act(rig)
        rig.clock.advance(by: 1)
        run(rig, until: 60, step: 1) { _ in self.frame(1) }
        let line = rig.logLines.last { $0.contains("in the last 60 s") }
        XCTAssertEqual(line, "view: in the last 60 s — 2 stream start(s), 0 restart(s), 2 in-place update(s), 2 pause(s), 1 resume(s); "
                       + "0 capturing now, 1 paused")
    }
}
