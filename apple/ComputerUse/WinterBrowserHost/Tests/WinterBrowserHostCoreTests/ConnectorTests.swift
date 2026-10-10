import Darwin
import Foundation
import WinterBrowserHostCore
import XCTest

/// The daemon-DR decision with fakes, and the real connector against a real Unix socket served by this test process —
/// verified with the real Security.framework check (this process's code against "always" and "never").
final class ConnectorTests: XCTestCase {
    // MARK: The decision, with fakes

    func testAPeerWhoseTokenCannotBeReadIsRefused() {
        let v = DaemonVerification(readToken: { _ in throw VerificationFailure("LOCAL_PEERTOKEN failed") }, checkCode: { _, _ in })
        XCTAssertEqual(v.refusal(socket: 3, requirement: "x"), "LOCAL_PEERTOKEN failed")
    }

    func testAPeerWhoseCodeFailsTheRequirementIsRefusedNamingItsPid() {
        let token = PeerToken(auditToken: Data(repeating: 1, count: 32), pid: 77)
        final class Asked: @unchecked Sendable { var requirement: String? }
        let asked = Asked()
        let v = DaemonVerification(readToken: { _ in token }, checkCode: { _, req in asked.requirement = req; throw VerificationFailure("not winter-core") })
        XCTAssertEqual(v.refusal(socket: 3, requirement: "identifier \"winter-core\""), "pid 77: not winter-core")
        XCTAssertEqual(asked.requirement, "identifier \"winter-core\"")
        struct Odd: Error {}
        let w = DaemonVerification(readToken: { _ in token }, checkCode: { _, _ in throw Odd() })
        XCTAssertEqual(w.refusal(socket: 3, requirement: "x"), "pid 77: its code failed the requirement")
    }

    func testAPeerThatSatisfiesItIsAccepted() {
        let token = PeerToken(auditToken: Data(repeating: 1, count: 32), pid: 77)
        XCTAssertNil(DaemonVerification(readToken: { _ in token }, checkCode: { _, _ in }).refusal(socket: 3, requirement: "x"))
    }

    // MARK: The real connector

    private var dir: String!
    private var listener: Int32 = -1

    override func setUp() {
        dir = (NSTemporaryDirectory() as NSString).appendingPathComponent("wbh-\(UInt32.random(in: 0 ... .max))")
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        if listener >= 0 { close(listener) }
        try? FileManager.default.removeItem(atPath: dir)
    }

    private var socketPath: String { (dir as NSString).appendingPathComponent("browser.sock") }

    private func listen() {
        listener = socket(AF_UNIX, SOCK_STREAM, 0)
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(socketPath.utf8)
        withUnsafeMutableBytes(of: &address.sun_path) { raw in raw.copyBytes(from: bytes); raw[bytes.count] = 0 }
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        XCTAssertEqual(bound, 0)
        XCTAssertEqual(Darwin.listen(listener, 4), 0)
    }

    /// Accepts one connection on a background thread; returns its fd through the expectation's box.
    private func acceptOne() -> (XCTestExpectation, () -> Int32) {
        let accepted = expectation(description: "accepted")
        var fd: Int32 = -1
        let lock = NSLock()
        Thread {
            let c = accept(self.listener, nil, nil)
            lock.lock(); fd = c; lock.unlock()
            accepted.fulfill()
        }.start()
        return (accepted, { lock.lock(); defer { lock.unlock() }; return fd })
    }

    func testNoDaemonIsUnavailable() {
        let c = UnixDaemonConnector(socketPath: socketPath, requirement: "always", queue: DispatchQueue(label: "t"))
        guard case .unavailable = c.connect(onLine: { _ in }, onClose: {}) else { return XCTFail("expected unavailable") }
    }

    func testAPeerThatIsNotTheDaemonIsClosedWithNothingSent() {
        listen()
        let (accepted, server) = acceptOne()
        let c = UnixDaemonConnector(socketPath: socketPath, requirement: "never", queue: DispatchQueue(label: "t"))
        guard case .unverified = c.connect(onLine: { _ in }, onClose: {}) else { return XCTFail("expected unverified") }
        wait(for: [accepted], timeout: 5)
        var byte: UInt8 = 0
        XCTAssertEqual(read(server(), &byte, 1), 0, "the host closed without writing a byte")
        close(server())
    }

    func testTheVerifiedDaemonGetsLinesAndItsLinesComeBack() throws {
        listen()
        let (accepted, server) = acceptOne()
        let queue = DispatchQueue(label: "t")
        let received = expectation(description: "two lines")
        received.expectedFulfillmentCount = 2
        let closed = expectation(description: "closed")
        var lines: [String] = []
        let c = UnixDaemonConnector(socketPath: socketPath, requirement: "always", queue: queue)
        guard case .connected(let link) = c.connect(onLine: { lines.append(String(decoding: $0, as: UTF8.self)); received.fulfill() },
                                                    onClose: { closed.fulfill() }) else { return XCTFail("expected connected") }
        wait(for: [accepted], timeout: 5)
        XCTAssertTrue(link.send(Data("{\"a\":1}\n".utf8)))
        var buffer = [UInt8](repeating: 0, count: 64)
        let n = read(server(), &buffer, buffer.count)
        XCTAssertEqual(String(decoding: buffer[0 ..< max(n, 0)], as: UTF8.self), "{\"a\":1}\n")
        let reply = Array("{\"b\":2}\n\n{\"c\":3}\n".utf8)
        XCTAssertEqual(write(server(), reply, reply.count), reply.count)
        wait(for: [received], timeout: 5)
        XCTAssertEqual(lines, ["{\"b\":2}", "{\"c\":3}"])
        close(server())
        wait(for: [closed], timeout: 5)
        XCTAssertFalse(link.send(Data("x\n".utf8)))
    }

    func testAnOverlongDaemonLineDropsTheConnection() {
        listen()
        let (accepted, server) = acceptOne()
        let closed = expectation(description: "closed")
        let c = UnixDaemonConnector(socketPath: socketPath, requirement: "always", queue: DispatchQueue(label: "t"))
        guard case .connected = c.connect(onLine: { _ in XCTFail("no line expected") }, onClose: { closed.fulfill() }) else { return XCTFail("expected connected") }
        wait(for: [accepted], timeout: 5)
        let junk = [UInt8](repeating: 0x61, count: 1024 * 1024 + 10)
        var written = 0
        while written < junk.count {
            let n = junk.withUnsafeBufferPointer { write(server(), $0.baseAddress! + written, junk.count - written) }
            if n <= 0 { break }
            written += n
        }
        wait(for: [closed], timeout: 5)
        close(server())
    }
}
