import XCTest
import Darwin
import KeyBrokerNative
@testable import KeyBrokerCore

final class ReadDeadlineTests: XCTestCase {
    func testInterruptedPollsShareOneDeadlineAndClassifyFailures() {
        // An EINTR storm, eventual readiness, clock failure, invalid descriptor,
        // and poll error all use the actual readiness algorithm.
        for scenario in 0...4 {
            XCTAssertEqual(kb_fixture_read_deadline_scenario(Int32(scenario)), 1, "scenario \(scenario)")
        }
    }

    func testPipeLineThenEOFAndCapacityRefusal() throws {
        let (reader, writer) = try fixturePipe()
        try writer.write(Data("READY\nrest".utf8)); writer.close()
        XCTAssertEqual(try reader.line(), Data("READY".utf8))
        XCTAssertEqual(try reader.eofBytes(), Data("rest".utf8))
        let (fullReader, fullWriter) = try fixturePipe()
        try fullWriter.write(Data([1, 2, 3, 4])); fullWriter.close()
        var bytes = [UInt8](repeating: 0, count: 4)
        XCTAssertEqual(kb_read_bounded(fullReader.value, &bytes, bytes.count, 100), -1)
        XCTAssertEqual(errno, EMSGSIZE)
    }

    func testEmptyPipeAndDatagramStopAtTheirDeadline() throws {
        let (reader, writer) = try fixturePipe()
        let (receiver, sender) = try fixturePipe(channel: true)
        // Retain both peer endpoints: these are timeouts, not EOFs.
        defer { writer.close(); sender.close() }
        var bytes = [UInt8](repeating: 0, count: 32)
        let start = ContinuousClock.now
        XCTAssertEqual(kb_read_line(reader.value, &bytes, bytes.count, 20), -1)
        XCTAssertEqual(errno, ETIMEDOUT)
        XCTAssertEqual(kb_recv_packet(receiver.value, &bytes, bytes.count, 20), -1)
        XCTAssertEqual(errno, ETIMEDOUT)
        XCTAssertLessThan(start.duration(to: .now), .seconds(1))
    }

    func testInvalidBudgetsAndOversizedDatagramRefuse() throws {
        let (receiver, sender) = try fixturePipe(channel: true)
        var bytes = [UInt8](repeating: 0, count: 4)
        for budget: Int32 in [-1, 0, 10001] {
            XCTAssertEqual(kb_recv_packet(receiver.value, &bytes, bytes.count, budget), -1)
            XCTAssertEqual(errno, EINVAL)
        }
        try sender.packet(Data([1, 2, 3, 4, 5]))
        XCTAssertEqual(kb_recv_packet(receiver.value, &bytes, bytes.count, 100), -1)
        XCTAssertEqual(errno, EMSGSIZE)
        try sender.packet(Data([5, 6, 7, 8]))
        XCTAssertEqual(kb_recv_packet(receiver.value, &bytes, bytes.count, 100), 4)
        XCTAssertEqual(bytes, [5, 6, 7, 8])
    }
}
