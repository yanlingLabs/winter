import CoreGraphics
import Foundation
import WinterComputerUseShell
import XCTest

/// The view stream's costs: the idle throttle, unchanged frames, one line per frame, and the cached window origin.
@MainActor
final class ViewThrottleTests: XCTestCase {
    private func notes() -> ViewTarget {
        ViewTarget(sessionId: "s_1", targetId: "t1", pid: 123, windowId: 77, appName: "Notes", bundleId: "com.apple.Notes",
                   windowFrame: CGRect(x: 100, y: 50, width: 800, height: 600), mirror: true)
    }

    private func act(_ rig: Rig) {
        rig.viewHub.cursor(sessionId: "s_1", pid: 123, windowId: 77, point: CGPoint(x: 110, y: 60), kind: "press", dragTo: nil,
                           frame: nil, text: nil, count: 1, button: "left")
    }

    private func frame(_ byte: UInt8) -> ViewFrame {
        ViewFrame(jpeg: Data(repeating: byte, count: 64), width: 720, height: 540, windowSize: CGSize(width: 800, height: 600))
    }

    private var fps: (Rig) -> Int? { { $0.capture.live.first?.maxFps } }

    // MARK: Idle throttle

    func testAWindowWithNoActionDropsToOneFrameASecondAfterThreeSeconds() {
        let rig = Rig()
        rig.viewHub.bound(notes())
        _ = rig.viewHub.subscribe(connection: 1, ViewSubscribeParams(sessionId: "s_1", frames: true))
        XCTAssertEqual(fps(rig), 10, "a fresh bind is an action")
        rig.clock.advance(by: 2.9)
        XCTAssertEqual(fps(rig), 10)
        rig.clock.advance(by: 0.1)
        XCTAssertEqual(fps(rig), 1, "3 s with no action")
        XCTAssertFalse(rig.viewHub.isActive("t1"))
        XCTAssertEqual(rig.capture.live.count, 1, "one capture, restarted slower")
    }

    func testTheNextActionRestoresTheFullRateAndEachActionExtendsIt() {
        let rig = Rig()
        rig.viewHub.bound(notes())
        _ = rig.viewHub.subscribe(connection: 1, ViewSubscribeParams(sessionId: "s_1", frames: true, maxFps: 15))
        rig.clock.advance(by: 3)
        XCTAssertEqual(fps(rig), 1)
        act(rig)
        XCTAssertEqual(fps(rig), 15, "an action wakes it at once")
        rig.clock.advance(by: 2)
        act(rig)
        rig.clock.advance(by: 2)
        XCTAssertEqual(fps(rig), 15, "3 s are counted from the LAST action")
        let starts = rig.capture.started.count
        act(rig)
        XCTAssertEqual(rig.capture.started.count, starts, "an action while already at full rate restarts nothing")
        rig.clock.advance(by: 3)
        XCTAssertEqual(fps(rig), 1)
    }

    func testAnActionOnAnotherWindowDoesNotWakeThisOne() {
        let rig = Rig()
        rig.viewHub.bound(notes())
        _ = rig.viewHub.subscribe(connection: 1, ViewSubscribeParams(sessionId: "s_1", frames: true))
        rig.clock.advance(by: 3)
        rig.viewHub.cursor(sessionId: "s_1", pid: 123, windowId: 999, point: .zero, kind: "move", dragTo: nil, frame: nil, text: nil, count: nil, button: nil)
        XCTAssertEqual(fps(rig), 1)
    }

    func testAReleaseCancelsTheThrottleTimer() {
        let rig = Rig()
        rig.viewHub.bound(notes())
        rig.viewHub.release(targetId: "t1")
        XCTAssertEqual(rig.clock.pendingCount, 0)
    }

    // MARK: Unchanged frames

    func testAFrameIdenticalToTheLastSentIsNotSent() {
        let rig = Rig()
        rig.viewHub.bound(notes())
        _ = rig.viewHub.subscribe(connection: 1, ViewSubscribeParams(sessionId: "s_1", frames: true))
        let capture = rig.capture.live[0]
        capture.onFrame(frame(1))
        capture.onFrame(frame(1))
        capture.onFrame(frame(1))
        capture.onFrame(frame(2))
        capture.onFrame(frame(2))
        capture.onFrame(frame(1))
        XCTAssertEqual(rig.sink.frames[1]?.compactMap { $0["params"]?["seq"] }, [.number(1), .number(2), .number(3)], "only changes, numbered without gaps")
    }

    func testTheFirstFrameAfterARestartIsSkippedWhenNothingChanged() {
        let rig = Rig()
        rig.viewHub.bound(notes())
        _ = rig.viewHub.subscribe(connection: 1, ViewSubscribeParams(sessionId: "s_1", frames: true))
        rig.capture.live[0].onFrame(frame(1))
        rig.clock.advance(by: 3) // throttled: a new capture
        rig.capture.live[0].onFrame(frame(1))
        XCTAssertEqual(rig.sink.frames[1]?.count, 1)
    }

    func testANewFramesSubscriberGetsTheLastFrameAtOnce() {
        let rig = Rig()
        rig.viewHub.bound(notes())
        _ = rig.viewHub.subscribe(connection: 1, ViewSubscribeParams(sessionId: "s_1", frames: true))
        rig.capture.live[0].onFrame(frame(1))
        _ = rig.viewHub.subscribe(connection: 2, ViewSubscribeParams(sessionId: "s_1", frames: false))
        XCTAssertNil(rig.sink.frames[2], "not to a subscriber without frames")
        _ = rig.viewHub.subscribe(connection: 2, ViewSubscribeParams(sessionId: "s_1", frames: true))
        XCTAssertEqual(rig.sink.frames[2]?.count, 1, "an unchanged window would otherwise never send it one")
        XCTAssertEqual(rig.sink.frames[2]?.first, rig.sink.frames[1]?.first)
        _ = rig.viewHub.subscribe(connection: 2, ViewSubscribeParams(sessionId: "s_1", frames: true, maxFps: 5))
        XCTAssertEqual(rig.sink.frames[2]?.count, 1, "a repeat subscription is not a new subscriber")
    }

    // MARK: One line per frame

    func testTheHandBuiltFrameLineIsTheSameJSONAsTheEncodersAndBuiltOncePerFrame() throws {
        let jpeg = Data((0..<3000).map { UInt8(truncatingIfNeeded: $0 &* 31) })
        let frame = ViewFrame(jpeg: jpeg, width: 720, height: 540, windowSize: CGSize(width: 800.5, height: 600))
        let line = try XCTUnwrap(ViewHub.frameLine(sessionId: "s_\"1", targetId: "t1", seq: 7, frame: frame))
        XCTAssertEqual(line.last, 0x0A)
        XCTAssertEqual(line.filter { $0 == 0x0A }.count, 1)
        let parsed = try JSONDecoder().decode(JSONValue.self, from: line)
        let expected: JSONValue = .object(["jsonrpc": .string("2.0"), "method": .string("view.frame"), "params": .object([
            "sessionId": .string("s_\"1"), "targetId": .string("t1"), "seq": .number(7), "width": .number(720), "height": .number(540),
            "windowSize": .array([.number(800.5), .number(600)]), "jpeg": .string(jpeg.base64EncodedString()),
        ])])
        XCTAssertEqual(parsed, expected)

        let rig = Rig()
        rig.viewHub.bound(notes())
        for c in 1...3 { _ = rig.viewHub.subscribe(connection: c, ViewSubscribeParams(sessionId: "s_1", frames: true)) }
        rig.capture.live[0].onFrame(frame)
        let lines = (1...3).compactMap { rig.sink.frames[$0]?.first }
        XCTAssertEqual(lines.count, 3)
        XCTAssertEqual(lines.map { $0["params"]?["seq"] }, [.number(1), .number(1), .number(1)], "one frame, one line, every subscriber")
        XCTAssertEqual(lines[0], lines[1])
    }

    // MARK: The cached window origin

    func testCursorBurstsAskTheWindowServerAtMostTwiceASecond() {
        let rig = Rig()
        _ = rig.viewHub.subscribe(connection: 1, ViewSubscribeParams(sessionId: "s_1", frames: false))
        rig.viewHub.bound(notes())
        rig.geometry.frames[77] = CGRect(x: 100, y: 50, width: 800, height: 600)
        for _ in 0..<50 { act(rig) }
        XCTAssertEqual(rig.geometry.calls, 1)
        rig.geometry.frames[77] = CGRect(x: 200, y: 50, width: 800, height: 600) // the window moved
        rig.clock.advance(by: 0.5)
        act(rig)
        XCTAssertEqual(rig.geometry.calls, 2)
        XCTAssertEqual(rig.sink.events[1]?.last?["params"]?["point"], .array([.number(-90), .number(10)]), "the new origin is used")
    }
}
