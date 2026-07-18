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
/// `Gateway.handle(_:)`'s own directory-membership guard): the wire shape a not-(or no-longer-)
/// paired phone sees is the SAME raw JSON `PairRejected` a failed pairing ceremony uses
/// (`PairingManager.reject(_:code:)`), never a `WireEnvelope`-wrapped gateway error — a phone that
/// hasn't completed pairing has no epoch/hostID to validate a `WireEnvelope` against in the first
/// place.
///
/// Reads (and discards) ONE inbound frame before sending anything — confirmed empirically
/// (`IrohListenerTests`' throwaway diagnostic during this task): a freshly-ACCEPTED iroh bidi
/// stream's send half doesn't reliably flush from the ACCEPTING side until the OPENING side
/// (the phone) has transmitted at least one byte on it; every other response path in this
/// codebase (`Gateway.handle`, `PairingManager.handleConnection`) already reads the phone's
/// first frame before ever sending back, both because the wire protocol has the phone always
/// speak first AND (it turns out) because doing so is what makes a same-connection reply
/// deliverable at all over real iroh. This path is the one exception that didn't, until now —
/// the frame's CONTENT is irrelevant (a rejection doesn't depend on what a non-member sent,
/// only that it sent something); a phone that never sends anything at all simply never gets a
/// response, same as every other read-first path here.
func sendNotPairedRejection(_ conn: RemoteConn) async {
    var iter = conn.inbound.makeAsyncIterator()
    _ = await iter.next()
    // No pairID: this connection never reached a ceremony at all (no offer, no PairRequest ever
    // decoded) — there is nothing to disambiguate.
    let message = PairRejected(type: "pair_rejected", code: "not_paired", pairID: nil)
    if let payload = try? JSONEncoder().encode(message) {
        await conn.send(payload)
    }
    conn.close()
}
