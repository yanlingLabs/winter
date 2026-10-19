import XCTest
@testable import LauncherCore

/// The four small shapes ported by reading from apple/Cowork/WinterCoworkVM (never edited there).
final class PrimitivesTests: XCTestCase {
    // MARK: UnstartedReservation -> WorkerReservation

    func testAReservationMayBeAbortedOnlyWhileTheWorkerWasNeverConstructed() throws {
        let r = WorkerReservation()
        XCTAssertEqual(r.state, .idle)
        try r.acquire(); XCTAssertEqual(r.state, .acquired)
        XCTAssertThrowsError(try r.acquire()) { XCTAssertEqual($0 as? WorkerReservation.Failure, .busy) }
        try r.abort(didConstruct: false); XCTAssertEqual(r.state, .idle)
        try r.acquire(); r.markConstructed(); XCTAssertEqual(r.state, .constructed)
        XCTAssertThrowsError(try r.abort(didConstruct: false), "a constructed worker needs termination proof, not an abort — whatever the caller says") { XCTAssertEqual($0 as? WorkerReservation.Failure, .abortDenied) }
        XCTAssertThrowsError(try r.abort(didConstruct: true)) { XCTAssertEqual($0 as? WorkerReservation.Failure, .abortDenied) }
        XCTAssertEqual(r.state, .constructed)
    }

    // MARK: DeviceOperationGate -> RelayGate

    func testTheRelayGateAdmitsUntilClosedAndLetsWhatBeganFinish() throws {
        let gate = RelayGate()
        try gate.begin(); try gate.begin(); XCTAssertEqual(gate.active, 2)
        gate.close(); XCTAssertTrue(gate.isClosing)
        XCTAssertThrowsError(try gate.begin()) { XCTAssertEqual($0 as? RelayGate.Closed, RelayGate.Closed()) }
        gate.finish(); gate.finish(); XCTAssertEqual(gate.active, 0)
    }

    // MARK: EventQueue -> OutboundQueue

    func testTerminalLinesAlwaysHaveHeadroomThatRelayTrafficCannotConsume() {
        var queue = OutboundQueue(softLimit: 100, terminalReserve: 40)
        XCTAssertTrue(queue.enqueue([UInt8](repeating: 1, count: 100), kind: .relay))
        XCTAssertTrue(queue.isBackpressured, "reads from the worker pause at the soft limit")
        XCTAssertFalse(queue.enqueue([UInt8](repeating: 1, count: 1), kind: .relay), "relay may not eat the terminal reserve")
        XCTAssertTrue(queue.enqueue([UInt8](repeating: 2, count: 40), kind: .terminal), "a refusal, receipt or fault still fits")
        XCTAssertFalse(queue.enqueue([UInt8](repeating: 2, count: 1), kind: .terminal), "and nothing fits past the hard limit")
        XCTAssertEqual(queue.next()?.count, 100); XCTAssertEqual(queue.next()?.count, 40); XCTAssertNil(queue.next())
        XCTAssertEqual(queue.bytes, 0); XCTAssertTrue(queue.isEmpty); XCTAssertFalse(queue.isBackpressured)
    }
    func testControlLinesUseTheTerminalHeadroomToo() {
        var queue = OutboundQueue(softLimit: 10, terminalReserve: 10)
        XCTAssertTrue(queue.enqueue([UInt8](repeating: 1, count: 10), kind: .relay))
        XCTAssertTrue(queue.enqueue([UInt8](repeating: 1, count: 10), kind: .control))
    }
}
