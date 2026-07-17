import Foundation
import os
import NormaProtocol
import IrohLib

/// The real iroh transport behind SP1's `RemoteListener` seam: the Mac binds an iroh
/// endpoint on the private ALPN `computer.norma.rpc/1`, accepts inbound phone connections,
/// and hands the gateway one `IrohConn` per authenticated peer. Each `IrohConn` adapts the
/// accepted QUIC bidirectional stream to the gateway's frame-oriented `RemoteConn`
/// contract, de-framing the raw byte stream into whole `WireEnvelope` frames via
/// `NormaProtocol.LengthPrefix`.
///
/// DEV-STUB PAIRING (SP2b seam): this listener accepts ANY peer that authenticates on the
/// ALPN — there is no allowlist or pairing ceremony yet. That is why `IrohListener` is
/// NEVER constructed in the shipped app (only tests / the dev harness build it); the
/// gateway's own construction-seam comment guards the production path. SP2b replaces the
/// "accept any authenticated peer" policy below with the real allowlist + pairing epoch.
///
/// Concurrency: the accept loop runs on its own `Task`; each accepted connection's mutable
/// state lives in `IrohConn` (a serialized-write actor + a read loop) — no `NSLock` is ever
/// held across an `await` (SP2a gate G6).
public final class IrohListener: RemoteListener, @unchecked Sendable {
    /// The private ALPN this listener accepts — and ONLY this. A dialer negotiating any
    /// other protocol is rejected at accept (iroh fails ALPN negotiation for unadvertised
    /// protocols; `accept` re-checks defensively).
    public static let defaultALPN = "computer.norma.rpc/1"

    public let connections: AsyncStream<RemoteConn>
    private let cont: AsyncStream<RemoteConn>.Continuation

    /// The bound iroh endpoint. Retained for the listener's whole lifetime.
    private let endpoint: Endpoint
    private let acceptTask: Task<Void, Never>

    /// Dev/test hook: the address a dialer uses to reach this listener (id + bound
    /// address). Not part of the `RemoteListener` protocol — production discovery goes
    /// through relay/pairing tickets, which SP2b builds.
    public var endpointAddr: EndpointAddr { endpoint.addr() }
    /// Dev/test hook: this listener's own authenticated EndpointID.
    public var endpointID: EndpointId { endpoint.id() }

    /// Binds an iroh endpoint from `secret` and starts accepting on `alpn`.
    ///
    /// - Parameters:
    ///   - secret: the 32-byte endpoint secret key (identity of this Mac).
    ///   - alpn: the private ALPN to accept on. Defaults to `computer.norma.rpc/1`.
    ///   - relayURLs: relay servers for NAT traversal. Empty disables relays entirely
    ///     (in-process / loopback / same-LAN dev use).
    ///   - bindAddr: dev/test hook to pin the bind address (e.g. `"127.0.0.1:0"` for a
    ///     hermetic loopback test — see task-0-report.md on why wildcard bind + `addr()`
    ///     enrichment is non-deterministic in sandboxed environments). `nil` lets iroh
    ///     choose (the production default).
    ///   - maxFrameBytes: hard cap on a single de-framed frame (oversize → the connection's
    ///     inbound stream ends).
    public static func start(
        secret: Data,
        alpn: String = defaultALPN,
        relayURLs: [String] = [],
        bindAddr: String? = nil,
        maxFrameBytes: Int = 1 << 20
    ) async throws -> IrohListener {
        let alpnData = Data(alpn.utf8)
        let relayMode = relayURLs.isEmpty
            ? RelayMode.disabled()
            : try RelayMode.customFromUrls(urls: relayURLs)
        let endpoint = try await Endpoint.bind(options: EndpointOptions(
            preset: presetN0(),
            bindAddr: bindAddr,
            secretKey: secret,
            alpns: [alpnData],
            relayMode: relayMode
        ))
        return IrohListener(endpoint: endpoint, alpn: alpnData, maxFrameBytes: maxFrameBytes)
    }

    private init(endpoint: Endpoint, alpn: Data, maxFrameBytes: Int) {
        self.endpoint = endpoint
        var c: AsyncStream<RemoteConn>.Continuation!
        self.connections = AsyncStream { c = $0 }
        self.cont = c
        let cont = c!
        // The accept loop captures only Sendable values (endpoint, alpn bytes, the
        // continuation) — never `self` — so it needs no init-completion ordering.
        self.acceptTask = Task {
            await IrohListener.acceptLoop(
                endpoint: endpoint, alpn: alpn, cont: cont, maxFrameBytes: maxFrameBytes
            )
        }
    }

    public func stop() {
        acceptTask.cancel()
        cont.finish()
        // Close the endpoint off the caller's thread (Endpoint.close is async). Closing is
        // also what actually unblocks the accept loop: `acceptNext()` ignores Swift task
        // cancellation (uniffi futures have no cancellation handler) but returns nil once
        // the endpoint closes.
        let ep = endpoint
        Task { try? await ep.close() }
    }

    /// Safety net: the accept loop deliberately does NOT capture `self` (no retain cycle),
    /// so a listener dropped without `stop()` would otherwise leave an orphaned accept loop
    /// holding the endpoint bound forever. `stop()` is idempotent-enough for this
    /// (double-finish of the stream and double-close of the endpoint are both no-ops).
    deinit {
        stop()
    }

    // MARK: - Accept loop

    private static func acceptLoop(
        endpoint: Endpoint,
        alpn: Data,
        cont: AsyncStream<RemoteConn>.Continuation,
        maxFrameBytes: Int
    ) async {
        while !Task.isCancelled {
            guard let incoming = await endpoint.acceptNext() else { break } // endpoint closed
            // Handshake each incoming on its own task so one slow/hostile peer can't stall
            // acceptance of the next. The task self-completes after yielding (or dropping).
            Task {
                await IrohListener.accept(
                    incoming, alpn: alpn, cont: cont, maxFrameBytes: maxFrameBytes
                )
            }
        }
        cont.finish()
    }

    private static func accept(
        _ incoming: Incoming,
        alpn: Data,
        cont: AsyncStream<RemoteConn>.Continuation,
        maxFrameBytes: Int
    ) async {
        do {
            let accepting = try await incoming.accept()
            // Reject a foreign ALPN at accept (defense-in-depth; iroh already refuses
            // unadvertised protocols during negotiation). Dropping `accepting` closes it.
            let negotiated = try await accepting.alpn()
            guard negotiated == alpn else { return }

            let conn = try await accepting.connect()
            // SP2b SEAM: dev-stub pairing accepts ANY authenticated peer here. The real
            // allowlist / pairing-epoch check goes at this point.
            let bi = try await conn.acceptBi()
            let peerID = conn.remoteId().description
            cont.yield(IrohConn(connection: conn, bi: bi, peerID: peerID, maxFrameBytes: maxFrameBytes))
        } catch {
            // Handshake failed, peer went away, or ALPN was refused — drop silently. The
            // dev-stub has no reporting surface; SP2b's pairing layer will observe rejects.
        }
    }
}

/// One accepted phone connection over an iroh QUIC bidirectional stream, adapted to the
/// gateway's frame-oriented `RemoteConn`. Owns its own `LengthPrefix` framing: `inbound`
/// yields one whole de-framed frame per element; `send(_:)` wraps one frame and writes it.
///
/// LIFETIME (Task 0 ARC finding): the FFI `Connection` / `BiStream` / stream halves MUST be
/// retained for the connection's whole life — dropping the Swift wrapper drops the
/// underlying Rust QUIC connection and sends an implicit application-close, which would
/// tear the link down mid-flight. They are held as `let`s here for exactly that reason.
public final class IrohConn: RemoteConn, @unchecked Sendable {
    /// The authenticated remote EndpointID string (`Connection.remoteId()`), not a stub.
    public let peerID: String
    public let inbound: AsyncStream<Data>
    private let inboundCont: AsyncStream<Data>.Continuation

    // Retained for the connection's whole lifetime — see the LIFETIME note above.
    private let connection: Connection
    private let bi: BiStream
    private let recvStream: RecvStream
    private let readTask: Task<Void, Never>
    /// Serializes writes so no two `writeAll`s overlap on the stream — actor isolation
    /// alone is insufficient because reentrancy at the `await writeAll` point would let a
    /// second concurrent `send` (e.g. the gateway's live-event pump racing its request
    /// loop) interleave bytes and corrupt `LengthPrefix` framing.
    private let writer: SendSerializer

    /// Purely-synchronous close bookkeeping (no `await` inside the critical section — G6).
    private let closed = OSAllocatedUnfairLock(initialState: false)

    init(connection: Connection, bi: BiStream, peerID: String, maxFrameBytes: Int) {
        self.connection = connection
        self.bi = bi
        let send = bi.send()
        let recv = bi.recv()
        self.recvStream = recv
        self.writer = SendSerializer(send)
        self.peerID = peerID

        var c: AsyncStream<Data>.Continuation!
        self.inbound = AsyncStream { c = $0 }
        self.inboundCont = c
        let cont = c!
        // The read loop captures only Sendable values (the recv half, the continuation),
        // never `self` — so cancelling `readTask` in `close()` is all teardown needs.
        self.readTask = Task {
            await IrohConn.readLoop(recv: recv, cont: cont, maxBytes: maxFrameBytes)
        }
    }

    public func send(_ frame: Data) async {
        guard !closed.withLock({ $0 }) else { return }
        await writer.write(LengthPrefix.wrap(frame))
    }

    public func close() {
        let first = closed.withLock { c -> Bool in
            guard !c else { return false }
            c = true
            return true
        }
        guard first else { return }
        readTask.cancel()
        inboundCont.finish()
        // Task 4 fix (found by the E2E's scenario F): `Connection.close(errorCode:reason:)` is an
        // ABRUPT reset, not a graceful shutdown — calling it right after a `send()` (e.g. a
        // "pairing revoked" error frame written just before closing a revoked/rejected phone) can
        // race ahead of that write's actual delivery and silently drop it. Confirmed empirically:
        // scenario F's phone consistently observed a bare close, never the preceding error frame,
        // before this fix (deterministic, not a flake — reproduced 5/5). `writer.finish()` chains
        // onto the SAME serialized write queue as `send(_:)`, so it waits for any already-queued
        // write to actually flush before gracefully finishing the stream; only THEN is the
        // connection torn down. Fire-and-forget (this method stays synchronous, matching
        // `RemoteConn.close()`'s contract) — mirrors `IrohListener.stop()`'s own async-cleanup idiom.
        let writer = self.writer
        let connection = self.connection
        Task {
            await writer.finish()
            // `finish()` returning only means the local send-stream FIN was queued with iroh's
            // internal QUIC driver, not that it (or any data just ahead of it) has actually been
            // flushed onto the wire and observed by the peer — an immediate `close()` right after
            // can still race ahead of that flush (empirically: `finish()` alone cut the drop rate
            // but did not eliminate it). A short grace delay gives the driver's background task a
            // real chance to run and push the bytes out over the (loopback-fast) transport before
            // the abrupt connection-level reset.
            try? await Task.sleep(for: .milliseconds(100))
            try? connection.close(errorCode: 0, reason: Data())
        }
    }

    /// De-frames the QUIC byte stream into whole `LengthPrefix` frames, yielding each to
    /// `inbound`. Ends the stream on clean EOF, stream reset/close, or an oversize frame.
    private static func readLoop(
        recv: RecvStream,
        cont: AsyncStream<Data>.Continuation,
        maxBytes: Int
    ) async {
        var buffer = Data()
        do {
            while !Task.isCancelled {
                // Drain every whole frame already buffered before blocking on more bytes.
                while let frame = try LengthPrefix.unwrap(&buffer, maxBytes: maxBytes) {
                    cont.yield(frame)
                }
                let chunk = try await recv.read(sizeLimit: 4096)
                if chunk.isEmpty { break } // clean end-of-stream
                buffer.append(chunk)
            }
        } catch {
            // Stream reset / connection closed / oversize frame → fall through to finish.
        }
        cont.finish()
    }
}

/// Serializes async writes to one QUIC send stream so writes never overlap. Each `write`
/// chains onto the previous via an in-flight `Task`; the chaining prologue is synchronous
/// under the actor's isolation, so even reentrant / concurrent callers produce a
/// well-ordered, non-interleaved write sequence.
private actor SendSerializer {
    private let send: SendStream
    private var tail: Task<Void, Error>?

    init(_ send: SendStream) { self.send = send }

    func write(_ bytes: Data) async {
        let prev = tail
        let current = Task { [send] in
            _ = try? await prev?.value // wait for the previous write to fully flush
            try await send.writeAll(buf: bytes)
        }
        tail = current
        _ = try? await current.value
    }

    /// Gracefully finishes the underlying send stream, chained onto the SAME queue as `write(_:)`
    /// — so a write already queued (or in flight) when `close()` calls this is guaranteed to
    /// actually reach the peer before the stream signals "no more data" (Task 4 fix — see
    /// `IrohConn.close()`'s own doc comment for the bug this closes).
    func finish() async {
        let prev = tail
        let current = Task { [send] in
            _ = try? await prev?.value
            try await send.finish()
        }
        tail = current
        _ = try? await current.value
    }
}
