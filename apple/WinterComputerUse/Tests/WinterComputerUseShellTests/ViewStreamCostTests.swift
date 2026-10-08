import CoreGraphics
import Foundation
import WinterComputerUseShell
import XCTest

/// Before/after numbers for the view stream's costs that can be measured without a screen (the capture and the
/// JPEG encoder are faked; what is counted is how often they would run). Printed, and held to the improvement.
@MainActor
final class ViewStreamCostTests: XCTestCase {
    private func notes() -> ViewTarget {
        ViewTarget(sessionId: "s_1", targetId: "t1", pid: 123, windowId: 77, appName: "Notes", bundleId: "com.apple.Notes",
                   windowFrame: CGRect(x: 100, y: 50, width: 800, height: 600), mirror: true)
    }

    /// Captured-and-encoded frames over one minute of an idle bound window, at 10 fps asked: Σ fps × time.
    func testEncodedFramesPerIdleMinute() {
        let rig = Rig()
        rig.viewHub.bound(notes())
        _ = rig.viewHub.subscribe(connection: 1, ViewSubscribeParams(sessionId: "s_1", frames: true))
        var encoded = 0.0
        for _ in 0..<600 { // 100 ms steps
            encoded += Double(rig.capture.live.first?.maxFps ?? 0) * 0.1
            rig.clock.advance(by: 0.1)
        }
        let before = 10.0 * 60
        print("view-cost: encoded frames per idle minute — before \(Int(before)), after \(Int(encoded.rounded()))")
        XCTAssertEqual(encoded, 3 * 10 + 57 * 1, accuracy: 1)
    }

    /// Frames SENT over one minute of an unchanged window at full rate (the window redraws, the pixels do not).
    func testFramesSentForAStaticWindow() {
        let rig = Rig()
        rig.viewHub.bound(notes())
        _ = rig.viewHub.subscribe(connection: 1, ViewSubscribeParams(sessionId: "s_1", frames: true))
        let still = ViewFrame(jpeg: Data(repeating: 7, count: 120_000), width: 720, height: 540, windowSize: CGSize(width: 800, height: 600))
        for _ in 0..<600 { rig.capture.live.first?.onFrame(still) }
        let sent = rig.sink.frames[1]?.count ?? 0
        print("view-cost: frames sent for 600 identical frames — before 600, after \(sent)")
        XCTAssertEqual(sent, 1)
    }

    /// Window-server lookups for a burst of 100 cursor events within one second.
    func testWindowServerLookupsPerCursorBurst() {
        let rig = Rig()
        _ = rig.viewHub.subscribe(connection: 1, ViewSubscribeParams(sessionId: "s_1", frames: false))
        rig.viewHub.bound(notes())
        for _ in 0..<100 {
            rig.viewHub.cursor(sessionId: "s_1", pid: 123, windowId: 77, point: CGPoint(x: 120, y: 70), kind: "move", dragTo: nil,
                               frame: nil, text: nil, count: nil, button: nil)
            rig.clock.advance(by: 0.01)
        }
        print("view-cost: window-server lookups for 100 cursor events in 1 s — before 100, after \(rig.geometry.calls)")
        XCTAssertLessThanOrEqual(rig.geometry.calls, 2)
    }

    /// Building one `view.frame` line for a 120 KB JPEG: the old JSONEncoder path vs the hand-built one.
    func testFrameLineBuildTime() throws {
        let jpeg = Data((0..<120_000).map { UInt8(truncatingIfNeeded: $0 &* 2654435761) })
        let frame = ViewFrame(jpeg: jpeg, width: 720, height: 540, windowSize: CGSize(width: 800, height: 600))
        func time(_ body: () -> Void) -> Double {
            let start = DispatchTime.now().uptimeNanoseconds
            for _ in 0..<40 { body() }
            return Double(DispatchTime.now().uptimeNanoseconds - start) / 40 / 1_000_000
        }
        let old = time {
            let params: JSONValue = .object([
                "sessionId": .string("s_1"), "targetId": .string("t1"), "seq": .number(1), "jpeg": .string(jpeg.base64EncodedString()),
                "width": .number(720), "height": .number(540), "windowSize": .array([.number(800), .number(600)]),
            ])
            _ = RPCOutbound.notification(method: "view.frame", params: AnyEncodable(params))
        }
        let new = time { _ = ViewHub.frameLine(sessionId: "s_1", targetId: "t1", seq: 1, frame: frame) }
        print(String(format: "view-cost: one view.frame line for a 120 KB JPEG — before %.2f ms, after %.2f ms", old, new))
        XCTAssertLessThan(new, old)
    }
}
