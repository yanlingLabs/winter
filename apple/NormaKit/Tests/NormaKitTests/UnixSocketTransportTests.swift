import XCTest
import Network
@testable import WinterKit

/// Minimal scripted NDJSON server on a real unix socket (Network.framework listener).
final class LoopbackServer: @unchecked Sendable {
    let path: String
    private let listener: NWListener
    private let queue = DispatchQueue(label: "loopback")
    // STABILIZATION vs brief (documented in report): `conns` is appended on the listener queue
    // and read/cleared from the test thread — lock it, and expose `connectionCount` so tests can
    // wait for the (asynchronous) accept before acting on the connection list.
    private let lock = NSLock()
    private var conns: [NWConnection] = []
    var connectionCount: Int { lock.lock(); defer { lock.unlock() }; return conns.count }
    /// Called per received chunk with (line, respond) — line-buffered by the test's own decoder.
    var onLine: ((String, @escaping (String) -> Void) -> Void)?
    private let decoder = LineDecoder()

    init() throws {
        path = NSTemporaryDirectory() + "winter-test-\(UUID().uuidString.prefix(8)).sock"
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.unix(path: path)
        listener = try NWListener(using: params)
        listener.newConnectionHandler = { [weak self] conn in
            guard let self else { return }
            self.lock.lock(); self.conns.append(conn); self.lock.unlock()
            conn.start(queue: self.queue)
            self.receive(conn)
        }
        listener.start(queue: queue)
    }

    private func receive(_ conn: NWConnection) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, done, _ in
            guard let self else { return }
            if let data, let lines = try? self.decoder.push(data) {
                for line in lines {
                    self.onLine?(line) { reply in
                        conn.send(content: Data((reply + "\n").utf8), completion: .contentProcessed { _ in })
                    }
                }
            }
            if !done { self.receive(conn) }
        }
    }

    func dropAllConnections() {
        lock.lock(); let cs = conns; conns.removeAll(); lock.unlock()
        for c in cs { c.cancel() }
    }

    func stop() {
        dropAllConnections()
        listener.cancel()
        try? FileManager.default.removeItem(atPath: path)
    }
}

final class UnixSocketTransportTests: XCTestCase {
    func testOpenSendReceiveEcho() async throws {
        let server = try LoopbackServer()
        defer { server.stop() }
        server.onLine = { line, respond in respond("echo:" + line) }

        let t = UnixSocketTransport(path: server.path)
        try await t.open()
        var iter = t.incoming.makeAsyncIterator()
        try await t.send(Data("ping\n".utf8))

        // collect until we have a full line back
        var buf = ""
        while !buf.contains("\n") {
            guard case .data(let d)? = await iter.next() else { return XCTFail("closed early") }
            buf += String(decoding: d, as: UTF8.self)
        }
        XCTAssertTrue(buf.hasPrefix("echo:ping"))
        t.close()
    }

    func testOpenFailsFastOnMissingSocket() async {
        let t = UnixSocketTransport(path: NSTemporaryDirectory() + "definitely-missing.sock")
        do { try await t.open(); XCTFail("expected failure") } catch { /* expected */ }
    }

    func testClosedYieldedOnServerDrop() async throws {
        let server = try LoopbackServer()
        defer { server.stop() }
        let t = UnixSocketTransport(path: server.path)
        try await t.open()
        var iter = t.incoming.makeAsyncIterator()
        // STABILIZATION vs brief (documented in report): Network.framework accepts asynchronously —
        // the client's .ready fires before the server's newConnectionHandler runs, so an immediate
        // dropAllConnections() is a no-op on an empty conns array and the late-accepted connection
        // lives on; .closed then never arrives and iter.next() hangs the suite (observed on this
        // machine, macOS 26). Minimal fix: wait for the accept before dropping.
        let deadline = Date().addingTimeInterval(2)
        while server.connectionCount == 0 && Date() < deadline {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertGreaterThan(server.connectionCount, 0, "server never accepted the connection")
        server.dropAllConnections()
        // drain until .closed
        for _ in 0..<10 {
            if case .closed = await iter.next() ?? .closed(nil) { return }
        }
        XCTFail("no .closed observed")
    }
}
