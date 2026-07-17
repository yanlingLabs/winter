import XCTest
import NormaProtocol
import IrohLib
@testable import NormaKit

/// SP2a Task 0 — verification spike that GATES all of SP2a (see
/// .superpowers/sdd/task-0-brief.md / task-0-report.md). SP1 shipped a
/// `RemoteListener`/`RemoteConn` seam assuming a transport that can ACCEPT inbound
/// connections from a phone; this proves iroh-ffi's *Swift* API actually exposes that
/// server side (not just dial), a bidirectional stream, and the authenticated remote
/// `EndpointId` on the accept side — before any of SP2a's real wiring is built on top.
///
/// Two iroh endpoints in ONE process, mirroring iroh-ffi's own canonical Rust test
/// (`endpoint.rs::tests::test_connect_echo_roundtrip`), driven entirely through the
/// generated Swift bindings (`vendor/IrohLibSwift/IrohLib.swift`):
///   - B binds on loopback, advertising ALPN `computer.norma.rpc/1`, and runs a manual
///     accept loop: `acceptNext()` -> `Incoming.accept()` -> `Accepting.connect()`.
///   - A binds on loopback with no protocols of its own and dials B directly via B's
///     `EndpointAddr` (id + bound address — no relay/discovery needed in-process).
///   - Both sides frame bytes with `NormaProtocol.LengthPrefix` (u32-BE) over a single
///     bidirectional stream (A opens it, B accepts it) and round-trip "ping" / "pong".
///   - B reads the authenticated remote `EndpointId` off its accepted `Connection` and
///     asserts it equals A's own `EndpointId` — the crux of the whole spike.
///
/// Both endpoints explicitly bind `127.0.0.1:0` and disable relay, so this test only
/// ever talks over loopback — no real network reachability required. (An earlier
/// version of this test let iroh's netwatch enrich `EndpointAddr` with the host's real
/// LAN/IPv6 addresses, which are not reliably dialable from every sandboxed build
/// environment and made connection establishment slow/non-deterministic; binding
/// loopback explicitly sidesteps that entirely — see task-0-report.md.)
final class IrohSpikeTests: XCTestCase {
    static let alpn = "computer.norma.rpc/1".data(using: .utf8)!
    static let pingBytes = "ping".data(using: .utf8)!
    static let pongBytes = "pong".data(using: .utf8)!

    func testAcceptDialBiStreamRoundTrip() async throws {
        // B: bind on loopback, advertise the ALPN it will accept connections on.
        let bSecret = SecretKey.generate()
        let b = try await Endpoint.bind(options: EndpointOptions(
            preset: presetN0(),
            bindAddr: "127.0.0.1:0",
            secretKey: bSecret.toBytes(),
            alpns: [Self.alpn],
            relayMode: RelayMode.disabled()
        ))
        defer { Task { try? await b.close() } }

        // A: bind on loopback with no protocols of its own — it only dials.
        let aSecret = SecretKey.generate()
        let a = try await Endpoint.bind(options: EndpointOptions(
            preset: presetN0(),
            bindAddr: "127.0.0.1:0",
            secretKey: aSecret.toBytes(),
            relayMode: RelayMode.disabled()
        ))
        defer { Task { try? await a.close() } }

        let bAddr = b.addr()

        // B's accept loop runs concurrently with A's dial below (`async let` starts it
        // immediately; we `await` the result once both sides have exchanged frames).
        //
        // NOTE: B's `Connection`/`BiStream` are returned here (not just the bytes) and
        // kept alive with `withExtendedLifetime` below until the whole exchange is
        // verified done. Earlier, letting `runAcceptSide` release them as soon as it
        // returned (right after writing "pong") was a genuine, reproducible race: ARC
        // could deallocate B's `Connection` — which drops the underlying Rust QUIC
        // connection and (per iroh's Drop behavior) sends an application-close —
        // before A's `readFrame` had actually finished consuming the "pong" bytes,
        // intermittently surfacing as `ConnectionLost(ApplicationClosed(..code 0..))`
        // on A's side. See task-0-report.md for the full write-up; this is a real
        // finding for whoever builds SP2a's production transport, not a test-only
        // quirk: Rust-FFI-backed connection/stream objects must be kept alive for
        // their full intended lifetime, not just until their last syntactic use.
        async let bResult = Self.runAcceptSide(b)

        // A dials B directly by its EndpointAddr (id + bound address) on the shared ALPN.
        let connA = try await a.connect(addr: bAddr, alpn: Self.alpn)
        XCTAssertEqual(connA.side(), .client)

        let biA = try await connA.openBi()
        try await biA.send().writeAll(buf: LengthPrefix.wrap(Self.pingBytes))

        var bufferA = Data()
        let pong = try await Self.readFrame(biA.recv(), buffer: &bufferA)
        XCTAssertEqual(pong, Self.pongBytes)

        let (remoteIDOnB, pingSeenByB, bConn, bBi) = try await bResult
        XCTAssertEqual(pingSeenByB, Self.pingBytes)
        XCTAssertEqual(
            remoteIDOnB, a.id().toBytes(),
            "B's accepted Connection.remoteId() must equal A's authenticated EndpointID"
        )

        try connA.close(errorCode: 0, reason: Data())
        withExtendedLifetime((connA, biA, bConn, bBi)) {}
    }

    /// B's side: accept the inbound connection, accept its bidirectional stream,
    /// LengthPrefix-unwrap the ping, reply with a wrapped pong, and return what it saw
    /// (the ping bytes), the authenticated remote EndpointID bytes read off the
    /// accepted `Connection` (the thing the STOP-RULE hinges on), and the `Connection`
    /// / `BiStream` objects themselves so the caller can keep them alive past this
    /// function's return (see the note above `bResult`).
    private static func runAcceptSide(
        _ b: Endpoint
    ) async throws -> (remoteID: Data, ping: Data, conn: Connection, bi: BiStream) {
        guard let incoming = await b.acceptNext() else {
            throw SpikeError.noIncomingConnection
        }
        let accepting = try await incoming.accept()
        let conn = try await accepting.connect()
        XCTAssertEqual(conn.side(), .server)

        let bi = try await conn.acceptBi()
        var buffer = Data()
        let ping = try await readFrame(bi.recv(), buffer: &buffer)
        try await bi.send().writeAll(buf: LengthPrefix.wrap(pongBytes))

        let remoteID = conn.remoteId().toBytes()
        return (remoteID, ping, conn, bi)
    }

    /// Reads `NormaProtocol.LengthPrefix`-framed bytes off `recv`, accumulating raw reads
    /// into `buffer` until a full frame is buffered.
    private static func readFrame(_ recv: RecvStream, buffer: inout Data, maxBytes: Int = 1 << 20) async throws -> Data {
        while true {
            if let frame = try LengthPrefix.unwrap(&buffer, maxBytes: maxBytes) {
                return frame
            }
            let chunk = try await recv.read(sizeLimit: 4096)
            guard !chunk.isEmpty else { throw SpikeError.streamEndedMidFrame }
            buffer.append(chunk)
        }
    }

    private enum SpikeError: Error {
        case noIncomingConnection
        case streamEndedMidFrame
    }
}
