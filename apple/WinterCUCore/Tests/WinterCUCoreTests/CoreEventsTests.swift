import CoreGraphics
import XCTest
@testable import WinterCUCore

/// Events reach the shell on the main actor, in the order the core emitted them.
final class CoreEventsTests: XCTestCase {
    @MainActor final class Recorder: CUCoreEvents {
        var log: [String] = []
        let done: XCTestExpectation
        let expected: Int
        init(expected: Int, done: XCTestExpectation) { self.expected = expected; self.done = done }
        private func add(_ s: String) {
            XCTAssertTrue(Thread.isMainThread)
            log.append(s)
            if log.count == expected { done.fulfill() }
        }
        func targetBound(sessionId: String, pid: pid_t, windowID: CGWindowID, appName: String, mirror: Bool) { add("bound \(windowID)") }
        func targetReleased(sessionId: String, pid: pid_t, windowID: CGWindowID) { add("released \(windowID)") }
        func actionAt(sessionId: String, pid: pid_t, windowID: CGWindowID, point: CGPoint, kind: String, dragTo: CGPoint?) {
            add("\(kind) \(Int(point.x))")
        }
        func targetLost(targetId: String, reason: String) { add("lost \(targetId)") }
        func permissionsChanged(accessibility: Bool, screenRecording: Bool) { add("perms") }
        func willSendEscape() { add("esc") }
    }

    @MainActor func testEventsArriveInOrderOnMain() async {
        let done = expectation(description: "all events")
        let recorder = Recorder(expected: 202, done: done)
        let core = CUCore(events: recorder, clock: CUSystemClock(), skyLight: .none, startMonitors: false)
        let expected: [String] = ["released 1", "bound 2"] + (0..<200).map { "press \($0)" }
        DispatchQueue.global().async {
            core.emit { $0.targetReleased(sessionId: "s", pid: 1, windowID: 1) }
            core.emit { $0.targetBound(sessionId: "s", pid: 1, windowID: 2, appName: "A", mirror: true) }
            for i in 0..<200 {
                core.emit { $0.actionAt(sessionId: "s", pid: 1, windowID: 2, point: CGPoint(x: i, y: 0), kind: "press", dragTo: nil) }
            }
        }
        await fulfillment(of: [done], timeout: 5)
        XCTAssertEqual(recorder.log, expected)
        withExtendedLifetime(core) {}
    }
}
