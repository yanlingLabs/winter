import Foundation
import NormaProtocol
import NormaSessionKit

/// The gateway-side allowlist lookup `Gateway` and `PairingRouter` both consume — one paired-phone
/// record per authenticated peer, or `nil` if the peer isn't (or is no longer) paired. `PairingStore`
/// (PairingStore.swift) is the sole production conformer; tests use `InMemoryDirectory`
/// (support/InMemoryDirectory.swift).
///
/// Declared `async` even though `PairingStore.record(forPeer:)` itself is written as a plain
/// (non-`async`) actor-isolated method: an actor-isolated method accessed from OUTSIDE the actor is
/// inherently asynchronous, so Swift lets it satisfy an `async` protocol requirement directly (no
/// wrapper needed) — see `PairingStore.swift`'s own conformance, which is a bare `extension
/// PairingStore: PairingDirectory {}`.
public protocol PairingDirectory: Sendable {
    func record(forPeer peerID: String) async -> PairRecord?
}

/// Sits in front of the real transport listener (SP2's `IrohListener`, or a scripted test double)
/// and applies the SP2b trust decision the dev-stub pairing (`IrohListener`'s own header comment)
/// deferred: every accepted connection is looked up by its authenticated `peerID` in `directory`
/// BEFORE it ever reaches `Gateway`.
///
///   - A MEMBER (peer has a `PairRecord`) is forwarded, completely unexamined, to `connections` —
///     `Gateway` does its own (epoch-aware) wire-level handling from there. `PairingRouter` never
///     parses a single `WireEnvelope`; that stays entirely Gateway's job (this type owns ROUTING
///     policy only, never ceremony/wire logic).
///   - A NON-member during an open pairing window (`manager.isWindowOpen`) is handed to
///     `PairingManager.handleConnection(_:)` on its own task — the ceremony's own one-frame
///     `PairRequest` read must never block this accept loop from routing the NEXT connection.
///   - A NON-member with no window open gets exactly one raw JSON `PairRejected(code: "not_paired")`
///     frame, then the connection is closed.
///
/// Membership is re-checked from `directory` on EVERY newly accepted connection (never cached) —
/// this is what makes a revoked-then-reconnecting phone (whose record `PairingStore.revoke` already
/// removed) bounce as `not_paired` on its very next dial, even though nothing about this router's
/// own state ever recorded that specific phone.
public final class PairingRouter: RemoteListener, @unchecked Sendable {
    private let base: RemoteListener
    private let directory: any PairingDirectory
    private let manager: PairingManager

    public let connections: AsyncStream<RemoteConn>
    private let cont: AsyncStream<RemoteConn>.Continuation
    private let acceptTask: Task<Void, Never>

    public init(base: RemoteListener, directory: any PairingDirectory, manager: PairingManager) {
        self.base = base
        self.directory = directory
        self.manager = manager
        var c: AsyncStream<RemoteConn>.Continuation!
        self.connections = AsyncStream { c = $0 }
        self.cont = c
        let cont = c!
        self.acceptTask = Task {
            await PairingRouter.acceptLoop(base: base, directory: directory, manager: manager, cont: cont)
        }
    }

    /// Forwards to the base listener (mirrors `IrohListener.stop()`'s own idiom): stop accepting new
    /// connections, finish this router's own `connections` stream (so `Gateway.run()`'s `for await`
    /// loop over it ends too), then tear down the underlying transport.
    public func stop() {
        acceptTask.cancel()
        cont.finish()
        base.stop()
    }

    private static func acceptLoop(
        base: RemoteListener, directory: any PairingDirectory, manager: PairingManager,
        cont: AsyncStream<RemoteConn>.Continuation
    ) async {
        for await conn in base.connections {
            if Task.isCancelled { break }
            if await directory.record(forPeer: conn.peerID) != nil {
                cont.yield(conn)
            } else if await manager.isWindowOpen {
                // Fire-and-forget: the ceremony's own one-frame read must never stall this loop's
                // ability to route the NEXT accepted connection.
                Task { await manager.handleConnection(conn) }
            } else {
                // Fire-and-forget (see `sendNotPairedRejection`'s own doc comment on why this
                // reads a frame first) — same reasoning as the ceremony branch above: must never
                // stall routing the NEXT accepted connection.
                Task { await sendNotPairedRejection(conn) }
            }
        }
        cont.finish()
    }
}

/// Shared by `PairingRouter` (the primary gate) and `Gateway` (defense-in-depth only — see
/// `Gateway.handle(_:)`'s own directory-membership guard): rejects a not-(or no-longer-)paired
/// phone, in the wire shape THAT phone can actually decode.
///
/// **Dual-path (SP3.1 Task 1).** The reply shape depends on what KIND of dialer this is, told apart
/// by peeking the first frame:
///   - A SESSION dialer (a `NormaSessionClient` reconnecting after a revoke) speaks the
///     `WireEnvelope` protocol — its first frame is a `kind: .hello` envelope. It gets a
///     `WireEnvelope` `error` frame carrying a structured `HandshakeRejection(code: "not_paired")`,
///     which its handshake decodes into a typed `.handshakeRejected` (→ the app's honest `.revoked`
///     state). Before this it got the raw JSON below, which it can't decode → dropped → the refusal
///     collapsed to a bare close / `.macUnavailable`, making the honest state UNREACHABLE from a
///     real revoke. The echoed epoch is the phone's own claimed `pairingEpoch` (the router has no
///     record to consult — that's WHY it's rejecting), so the phone's own strict decode accepts it;
///     `NormaSessionClient` also decodes this one frame epoch-lenient regardless.
///   - A PAIRING dialer (`PhonePairingClient` mid-ceremony) sends a raw-JSON `PairRequest` — no
///     `WireEnvelope` wrapper (it hasn't paired, so it has no epoch to wrap one in). It gets the
///     SAME raw JSON `PairRejected` a failed ceremony uses (`PairingManager.reject(_:code:)`),
///     UNCHANGED — the pairing ceremony wire is untouched. This is also the fallback for any dialer
///     whose first frame isn't a decodable `.hello` envelope.
///
/// Reads (and discards) ONE inbound frame before sending anything — confirmed empirically
/// (`IrohListenerTests`' throwaway diagnostic during this task): a freshly-ACCEPTED iroh bidi
/// stream's send half doesn't reliably flush from the ACCEPTING side until the OPENING side
/// (the phone) has transmitted at least one byte on it; every other response path in this
/// codebase (`Gateway.handle`, `PairingManager.handleConnection`) already reads the phone's
/// first frame before ever sending back, both because the wire protocol has the phone always
/// speak first AND (it turns out) because doing so is what makes a same-connection reply
/// deliverable at all over real iroh. A phone that never sends anything at all simply never gets a
/// response, same as every other read-first path here.
func sendNotPairedRejection(_ conn: RemoteConn) async {
    var iter = conn.inbound.makeAsyncIterator()
    let firstFrame = await iter.next()

    // Peek the first frame epoch-lenient: a SESSION dialer's is a decodable `.hello` `WireEnvelope`;
    // a PAIRING dialer's raw-JSON `PairRequest` (no `v`/`kind`) fails this decode and falls through
    // to the raw path below. Epoch-lenient because the router has no record to know the phone's
    // epoch — the KIND is all this decision needs.
    if let firstFrame,
       let hello = try? WireFrame.decodeLenient(firstFrame),
       hello.kind == .hello {
        let rejection = HandshakeRejection(code: HandshakeRejectionCode.notPaired.rawValue, message: "not paired")
        if let payload = try? JSONEncoder().encode(rejection) {
            let envelope = WireEnvelope(
                v: 1, pairingEpoch: hello.pairingEpoch, hostID: "", sessionID: nil, streamID: nil,
                seq: nil, kind: .error, timestamp: Int(Date().timeIntervalSince1970 * 1000), payload: payload
            )
            if let frame = try? WireFrame.encode(envelope) {
                await conn.send(frame)
            }
        }
        conn.close()
        return
    }

    // Pairing dialer (or an undecodable first frame): the UNCHANGED raw-JSON ceremony reply. No
    // pairID: this connection never reached a ceremony at all (no offer, no PairRequest ever
    // decoded) — there is nothing to disambiguate.
    let message = PairRejected(type: "pair_rejected", code: "not_paired", pairID: nil)
    if let payload = try? JSONEncoder().encode(message) {
        await conn.send(payload)
    }
    conn.close()
}
