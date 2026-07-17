import XCTest
import os
import NormaProtocol
import IrohLib
@testable import NormaKit

/// SP2a Task 3 — focused unit test for `IrohListener`, the real iroh transport behind
/// SP1's `RemoteListener` seam. Two iroh endpoints in ONE process (no daemon, no real
/// network): a bare dialer endpoint dials the `IrohListener`, and we assert that
///   - the listener emits exactly one `RemoteConn` for the accepted connection,
///   - its `peerID` is the AUTHENTICATED dialer EndpointID (not a stub),
///   - a `LengthPrefix`-framed frame round-trips through `inbound` / `send(_:)` as one
///     whole frame each way, and
///   - a dialer negotiating a different ALPN is rejected (the listener accepts ONLY
///     `computer.norma.rpc/1`).
///
/// Both endpoints bind loopback (`127.0.0.1:0`) with relay disabled, so the test never
/// depends on real network reachability — matching Task 0's finding that wildcard-bind +
/// `addr()` enrichment hangs in sandboxed build environments (see task-0-report.md).
///
/// Every network step runs under `withTimeout`: iroh's `acceptNext` / `connect` /
/// `acceptBi` have NO wall-clock bound, so a regression that deadlocks would otherwise
/// hang CI forever — the guard turns a hang into a loud, fast failure (Task 0 review Minor).
final class IrohListenerTests: XCTestCase {
    static let alpn = "computer.norma.rpc/1"
    static let alpnData = "computer.norma.rpc/1".data(using: .utf8)!

    func testAcceptEmitsAuthenticatedConnWithFramedRoundTrip() async throws {
        try await withTimeout(20) {
            // Listener: the Mac side. Binds loopback, advertises only our ALPN.
            let listener = try await IrohListener.start(
                secret: SecretKey.generate().toBytes(),
                alpn: Self.alpn,
                relayURLs: [],
                bindAddr: "127.0.0.1:0"
            )
            defer { listener.stop() }

            // Dialer: a bare phone-side endpoint that only dials.
            let dialer = try await Endpoint.bind(options: EndpointOptions(
                preset: presetN0(),
                bindAddr: "127.0.0.1:0",
                secretKey: SecretKey.generate().toBytes(),
                relayMode: RelayMode.disabled()
            ))
            defer { Task { try? await dialer.close() } }

            // Dial the listener by its EndpointAddr on the shared ALPN, open a bi-stream,
            // and write ONE LengthPrefix-framed request (stand-in for a WireEnvelope frame).
            let connA = try await dialer.connect(addr: listener.endpointAddr, alpn: Self.alpnData)
            let biA = try await connA.openBi()
            let sendA = biA.send()
            let recvA = biA.recv()
            let requestFrame = Data("client-hello-frame".utf8)
            try await sendA.writeAll(buf: LengthPrefix.wrap(requestFrame))

            // The listener accepts and emits exactly one RemoteConn for this connection.
            var connIter = listener.connections.makeAsyncIterator()
            guard let serverConn = await connIter.next() else {
                XCTFail("listener emitted no RemoteConn")
                return
            }

            // peerID is the authenticated dialer EndpointID — not a stub.
            XCTAssertEqual(
                serverConn.peerID, dialer.id().description,
                "peerID must be the authenticated dialer EndpointID"
            )

            // inbound de-frames the QUIC byte stream into whole frames: the first element
            // is exactly the request frame's payload (length prefix already stripped).
            var inboundIter = serverConn.inbound.makeAsyncIterator()
            let received = await inboundIter.next()
            XCTAssertEqual(received, requestFrame, "inbound must yield one whole de-framed frame")

            // send(_:) wraps + writes; the dialer reads it back as one LengthPrefix frame.
            let replyFrame = Data("server-ack-frame".utf8)
            await serverConn.send(replyFrame)

            var buffer = Data()
            let reply = try await Self.readFrame(recvA, buffer: &buffer)
            XCTAssertEqual(reply, replyFrame, "send(_:) must deliver one whole framed frame")

            // Keep FFI objects alive until the exchange is fully verified (Task 0 ARC finding:
            // dropping a Connection/BiStream drops the underlying QUIC connection mid-flight).
            withExtendedLifetime((connA, biA, sendA, recvA, serverConn)) {}
        }
    }

    /// A dialer negotiating a DIFFERENT ALPN must be rejected: the listener advertises only
    /// `computer.norma.rpc/1`, so the QUIC handshake fails ALPN negotiation and `connect`
    /// throws — no RemoteConn is ever emitted.
    func testForeignAlpnIsRejected() async throws {
        try await withTimeout(20) {
            let listener = try await IrohListener.start(
                secret: SecretKey.generate().toBytes(),
                alpn: Self.alpn,
                relayURLs: [],
                bindAddr: "127.0.0.1:0"
            )
            defer { listener.stop() }

            let dialer = try await Endpoint.bind(options: EndpointOptions(
                preset: presetN0(),
                bindAddr: "127.0.0.1:0",
                secretKey: SecretKey.generate().toBytes(),
                relayMode: RelayMode.disabled()
            ))
            defer { Task { try? await dialer.close() } }

            let foreignAlpn = "computer.norma.rpc/DIFFERENT".data(using: .utf8)!
            do {
                let conn = try await dialer.connect(addr: listener.endpointAddr, alpn: foreignAlpn)
                withExtendedLifetime(conn) {}
                XCTFail("connect with a foreign ALPN should have been rejected")
            } catch {
                // Expected: ALPN negotiation failure.
            }
        }
    }

    // MARK: - Helpers

    /// Reads `LengthPrefix`-framed bytes off `recv`, accumulating raw reads into `buffer`
    /// until one whole frame is buffered (mirrors the gateway's own de-framing).
    private static func readFrame(_ recv: RecvStream, buffer: inout Data, maxBytes: Int = 1 << 20) async throws -> Data {
        while true {
            if let frame = try LengthPrefix.unwrap(&buffer, maxBytes: maxBytes) {
                return frame
            }
            let chunk = try await recv.read(sizeLimit: 4096)
            guard !chunk.isEmpty else { throw TestError.streamEndedMidFrame }
            buffer.append(chunk)
        }
    }

    private enum TestError: Error { case streamEndedMidFrame }
}

/// Runs `op` with a hard wall-clock bound: iroh's accept/connect/stream calls have no
/// timeout of their own, so a deadlock regression becomes a loud, fast test failure
/// instead of a hung CI job (Task 0 review Minor).
///
/// Deliberately NOT a `withThrowingTaskGroup` race: iroh-ffi's generated async calls
/// ignore Swift task cancellation (`uniffiRustCallAsync` polls via
/// `withUnsafeContinuation` with no cancellation handler — verified in
/// vendor/IrohLibSwift/IrohLib.swift), and a task group awaits ALL of its children on
/// scope exit — so a hung FFI await would keep the "timed-out" group alive forever and
/// the test would still hang. Instead this is a first-wins race between two unstructured
/// tasks: on timeout the test throws immediately and the hung op task is ABANDONED
/// (it leaks until the test process exits — exactly the acceptable cost of failing
/// loudly instead of hanging).
private struct TimeoutError: Error {}
private func withTimeout(_ seconds: Double, _ op: @escaping @Sendable () async throws -> Void) async throws {
    let resumed = OSAllocatedUnfairLock(initialState: false)
    let result: Result<Void, Error> = await withCheckedContinuation { cont in
        let timer = Task {
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            if resumed.withLock({ let was = $0; $0 = true; return !was }) {
                cont.resume(returning: .failure(TimeoutError()))
            }
        }
        Task {
            let r: Result<Void, Error>
            do { try await op(); r = .success(()) } catch { r = .failure(error) }
            timer.cancel()
            if resumed.withLock({ let was = $0; $0 = true; return !was }) {
                cont.resume(returning: r)
            }
        }
    }
    try result.get()
}
