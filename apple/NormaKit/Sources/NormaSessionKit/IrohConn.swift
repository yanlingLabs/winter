import Foundation
import os
import NormaProtocol
import IrohLib

/// One accepted phone connection over an iroh QUIC bidirectional stream, adapted to the
/// gateway's frame-oriented `RemoteConn`. Owns its own `LengthPrefix` framing: `inbound`
/// yields one whole de-framed frame per element; `send(_:)` wraps one frame and writes it.
///
/// SP3 Task 2: extracted verbatim from `IrohListener.swift` (NormaKit) into `NormaSessionKit` so
/// both sides of the transport can share ONE adapter — the Mac's `IrohListener` (accept side,
/// still in NormaKit) and the new phone-side `IrohDialer` (this package) both produce one of
/// these. No behavior changed by the move.
///
/// LIFETIME (Task 0 ARC finding): the FFI `Connection` / `BiStream` / stream halves MUST be
/// retained for the connection's whole life — dropping the Swift wrapper drops the
/// underlying Rust QUIC connection and sends an implicit application-close, which would
/// tear the link down mid-flight. They are held as `let`s here for exactly that reason.
///
/// SEND-BEFORE-RECEIVE (SP2b Task 4 finding, confirmed empirically): on the ACCEPTING side of a
/// freshly-opened bidi stream, `send(_:)` does not reliably flush until the OPENING side (the
/// phone) has transmitted at least one byte on that stream — a `send()` attempted first, before
/// the phone has sent anything at all, can hang indefinitely (reproduced via a throwaway
/// diagnostic in `IrohListenerTests` during this task; not something NormaKit's Swift code
/// controls). Every response path in this codebase already reads the phone's first frame before
/// ever sending back (`Gateway.handle`, `PairingManager.handleConnection`,
/// `PairingRouter`'s `sendNotPairedRejection`) for the wire protocol's own "phone always speaks
/// first" convention — which happens to ALSO be what makes this safe. Any FUTURE code on this
/// type that wants to speak before reading anything must account for this.
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

    /// SP3 Task 2 finding (new — extends the Task 0 ARC note above to the DIALING side): on the
    /// accept side, `IrohListener` retains its own bound `Endpoint` for the listener's whole
    /// lifetime, independently of any individual accepted `IrohConn` — but a phone's *dialing*
    /// `Endpoint` (created fresh per dial, e.g. by `IrohDialer.dial`) has no other owner. Dropping
    /// it once the dial function returns tears down the Rust endpoint and, with it, every
    /// connection spawned from it — including the one this very `IrohConn` wraps. Confirmed
    /// empirically: without this, the listener's `acceptBi()` never resolves (the dialed stream
    /// gets torn down out from under it moments after opening, even though the dialer's own
    /// `openBi()`/`send()` had already returned successfully). `nil` for the accept side (default),
    /// where `IrohListener` already retains the endpoint separately.
    private let ownedEndpoint: Endpoint?

    /// Purely-synchronous close bookkeeping (no `await` inside the critical section — G6).
    private let closed = OSAllocatedUnfairLock(initialState: false)

    /// `public` (SP3 Task 2): both `IrohListener` (NormaKit, accept side) and `IrohDialer`
    /// (NormaSessionKit, phone-dial side) construct this cross-module, so the initializer must be
    /// visible outside this file's module — it was `internal` pre-move, when both constructors
    /// lived in the same NormaKit module.
    ///
    /// - Parameter ownedEndpoint: pass the phone's own dialing `Endpoint` here when constructing
    ///   from a dial (see the `ownedEndpoint` property's own doc comment on why) — `nil` (the
    ///   default) for the accept side, unchanged from before the move.
    public init(connection: Connection, bi: BiStream, peerID: String, maxFrameBytes: Int, ownedEndpoint: Endpoint? = nil) {
        self.connection = connection
        self.bi = bi
        self.ownedEndpoint = ownedEndpoint
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
        //
        // SP2b Task 1 fix (the SP2a whole-branch review's BINDING gate on this listener): delivery
        // is now ACKNOWLEDGED, not merely hoped for. `finish()` returning only means the local
        // send-stream FIN was queued with iroh's internal QUIC driver, not that it (or any data
        // just ahead of it) has actually reached the peer — a probabilistic grace sleep here
        // (the pre-fix approach) gives the driver's background task A chance to flush before the
        // abrupt connection-level reset, but is not a guarantee: on a slower/loaded transport
        // (real network, not fast loopback) the sleep can still lose the race. `finishAndAwaitAcked`
        // chains onto the SAME write queue and then awaits `stopped()`, which resolves only once
        // the peer has genuinely acked the finished stream (bounded by a 2s cap so a dead/hung peer
        // can't wedge teardown forever) — so `connection.close()` below runs strictly after
        // ack-or-timeout, never racing ahead of the flush.
        let writer = self.writer
        let connection = self.connection
        let ownedEndpoint = self.ownedEndpoint
        Task {
            await writer.finishAndAwaitAcked(timeout: .seconds(2))
            try? connection.close(errorCode: 0, reason: Data())
            // SP3 Task 2: on the dial side, also tear down the phone's own dialing `Endpoint` —
            // see the `ownedEndpoint` property's own doc comment. Strictly after the connection
            // close above (never racing ahead of it), mirroring `IrohListener.stop()`'s own
            // "connection/stream cleanup, then endpoint close" ordering. `nil` on the accept side
            // (unchanged from before the move) — `IrohListener` owns that endpoint's lifetime.
            if let ownedEndpoint {
                try? await ownedEndpoint.close()
            }
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

    /// Chains onto the same write queue: finish the stream, then await the peer's
    /// acknowledgement (`stopped()` resolves nil once all data is acked / the stream is
    /// fully finished). Bounded by `timeout` via a first-wins unstructured race —
    /// uniffi futures ignore Swift cancellation, so no task group.
    func finishAndAwaitAcked(timeout: Duration) async {
        let prev = tail
        let current = Task { [send] in
            _ = try? await prev?.value
            try await send.finish()
        }
        tail = current
        _ = try? await current.value
        // Race stopped() against the deadline; first winner resolves the continuation.
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            let state = OSAllocatedUnfairLock(initialState: false)
            let resume = { if state.withLock({ done -> Bool in
                guard !done else { return false }; done = true; return true
            }) { cont.resume() } }
            let send = self.send
            Task { _ = try? await send.stopped(); resume() }
            Task { try? await Task.sleep(for: timeout); resume() }
        }
    }
}
