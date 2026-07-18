import XCTest
import os
import NormaProtocol
import IrohLib
@testable import NormaKit

/// SP2b Task 1 — the binding gate the SP2a whole-branch review left on `IrohConn.close()`:
/// its delivery guarantee must be an actual acknowledgement, not a probabilistic 100ms grace
/// sleep hoping the QUIC driver's background task got a chance to flush before the abrupt
/// `connection.close()` tears the link down. This test proves the guarantee the same way
/// `IrohE2ETests` proves ordering — over a REAL iroh loopback connection, never a scripted
/// double: send exactly one frame immediately followed by `close()` (back-to-back, no delay —
/// the precise race the sleep tried to paper over), on a FRESH connection, 20 times over one
/// listener. The dialer must observe the frame, then a clean EOF, every single time.
///
/// Under the pre-fix sleep this is a flake, not a hang: a fast local loopback usually wins the
/// race anyway, so the failure mode is intermittent frame loss, not a deterministic repro (see
/// task-1-report.md for the actual RED-run evidence). The fix (`SendSerializer
/// .finishAndAwaitAcked`) makes `close()` wait for the peer's stream-stopped ack before ever
/// touching the connection, so there is no window left to lose a race in.
final class IrohCloseDeterminismTests: XCTestCase {
    static let alpn = "computer.norma.rpc/1"
    static let alpnData = Data(alpn.utf8)

    func testSendThenCloseNeverDropsTheFrameAcross20Iterations() async throws {
        let listener = try await IrohListener.start(
            secret: SecretKey.generate().toBytes(),
            relayURLs: [],
            bindAddr: "127.0.0.1:0"
        )
        defer { listener.stop() }
        // One listener for the whole test (brief's own note) — its `connections` stream is
        // long-lived, so a single shared iterator hands us one fresh accepted conn per iteration.
        var serverConns = listener.connections.makeAsyncIterator()

        for i in 0..<20 {
            let frameA = Data("frame-\(i)".utf8)

            let dialer = try await Endpoint.bind(options: EndpointOptions(
                preset: presetN0(), bindAddr: "127.0.0.1:0",
                secretKey: SecretKey.generate().toBytes(), relayMode: RelayMode.disabled()
            ))
            let conn = try await dialer.connect(addr: listener.endpointAddr, alpn: Self.alpnData)
            let bi = try await conn.openBi()
            let recvA = bi.recv()
            let sendA = bi.send()
            // A bidirectional QUIC stream is only visible to the accepting peer once the
            // initiator has actually put a byte on it (mirrors `IrohListenerTests`' own dialer
            // plumbing) — `openBi()` alone reserves the stream locally but does not make the
            // listener's `acceptBi()` resolve. This first frame is otherwise irrelevant to what
            // this test asserts (nothing ever drains the server's `inbound`).
            try await sendA.writeAll(buf: LengthPrefix.wrap(Data("open".utf8)))

            guard let serverConn = await serverConns.next() else {
                XCTFail("iteration \(i): listener emitted no RemoteConn")
                break
            }

            // The exact pattern under test: send immediately followed by close, back-to-back,
            // on the listener side — no delay, no interleaving await in between.
            await serverConn.send(frameA)
            serverConn.close()

            let observed = try await withTimeout(5, "iteration \(i) read") {
                try await Self.readAllFrames(recvA)
            }
            XCTAssertEqual(
                observed, [frameA],
                "iteration \(i): expected exactly [frameA] then EOF, got \(observed.count) frame(s): \(observed.map { String(data: $0, encoding: .utf8) ?? "<binary>" })"
            )

            // Task 0 ARC finding: keep every FFI object alive through the whole exchange above —
            // dropping a Connection/BiStream mid-flight implicitly tears the QUIC connection down.
            withExtendedLifetime((conn, bi, recvA, sendA, serverConn)) {}
            let dialerToClose = dialer
            Task { try? await dialerToClose.close() }
        }
    }

    /// Reads every `LengthPrefix`-framed frame off `recv` until a clean end-of-stream (an empty
    /// read) or a stream error (peer reset / connection closed) — mirrors `IrohConn`'s own read
    /// loop exactly, so this test observes precisely what a real phone would.
    private static func readAllFrames(_ recv: RecvStream) async throws -> [Data] {
        var buffer = Data()
        var frames: [Data] = []
        while true {
            while let frame = try LengthPrefix.unwrap(&buffer, maxBytes: 1 << 20) {
                frames.append(frame)
            }
            let chunk: Data
            do {
                chunk = try await recv.read(sizeLimit: 4096)
            } catch {
                break // stream reset / connection closed
            }
            if chunk.isEmpty { break } // clean EOF
            buffer.append(chunk)
        }
        return frames
    }
}

private struct DeterminismTimeoutError: Error, CustomStringConvertible {
    let context: String
    var description: String { "timed out: \(context)" }
}

/// Per-file copy of the first-wins wall-clock race (`IrohE2ETests`/`IrohListenerTests` carry the
/// same idiom, each with its own copy — this codebase's convention for a test-only helper):
/// iroh-ffi's generated async calls ignore Swift task cancellation, so this is deliberately NOT
/// a `withThrowingTaskGroup` (which awaits every child on scope exit and would hang right along
/// with a stuck one) — two UNSTRUCTURED tasks race, first to resume wins, the loser is abandoned
/// (it leaks until the test process exits — the acceptable cost of failing loudly instead of
/// hanging on a regression).
private func withTimeout<T>(_ seconds: Double, _ context: String = "", _ op: @escaping @Sendable () async throws -> T) async throws -> T {
    let resumed = OSAllocatedUnfairLock(initialState: false)
    let result: Result<T, Error> = await withCheckedContinuation { cont in
        let timer = Task {
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            if resumed.withLock({ let was = $0; $0 = true; return !was }) {
                cont.resume(returning: .failure(DeterminismTimeoutError(context: context)))
            }
        }
        Task {
            let r: Result<T, Error>
            do { r = .success(try await op()) } catch { r = .failure(error) }
            timer.cancel()
            if resumed.withLock({ let was = $0; $0 = true; return !was }) {
                cont.resume(returning: r)
            }
        }
    }
    return try result.get()
}
