import Foundation
import os
import NormaProtocol
import IrohLib

/// Reusable phone-side iroh dial (SP3 Task 2): binds an iroh endpoint from the phone's own
/// identity secret, dials the Mac by its bare `EndpointID`, verifies the peer actually reached is
/// who was promised, opens the bidi stream, and wraps it in an `IrohConn` — the SAME adapter the
/// Mac's `IrohListener` (accept side, still in NormaKit) hands to the gateway, so both directions
/// of this transport speak the identical `RemoteConn` contract.
///
/// Lifted from `norma-fake-phone`'s hand-rolled `--attach` reconnect dial
/// (`Sources/norma-fake-phone/main.swift:171-189`), which stays as its own hand-rolled copy for
/// now — SP3 Task 5 switches that CLI over to calling this instead. `PhonePairingClient`'s own
/// production (non-test) dial path resolves the Mac the identical way (bare `macEndpointID`, no
/// direct address, no relay by default) — this is that same proven shape, generalized into a
/// standalone reusable entry point instead of being embedded in the pairing ceremony.
public enum IrohDialer {
    /// Errors this dial raises directly — distinct from whatever `Endpoint.bind`/`connect`/
    /// `EndpointId.fromString` throw, which propagate unchanged.
    public enum DialError: Error, Equatable {
        /// The peer this phone reached doesn't hold the identity `macEndpointID` promised — the
        /// SP2b global rule ("dialer must verify remoteId() == the promised identity") exists to
        /// catch a MITM/relay mix-up before any traffic is exchanged. Mirrors
        /// `PhonePairingError.macIdentityMismatch`.
        case macIdentityMismatch
    }

    /// Hard cap on a single de-framed frame the returned `IrohConn` will accept — mirrors
    /// `IrohListener.start`'s own default (oversize → the connection's inbound stream ends).
    private static let defaultMaxFrameBytes = 1 << 20

    /// Dials `macEndpointID` and returns a ready `IrohConn` wrapping the opened bidi stream.
    ///
    /// - Parameters:
    ///   - secret: the phone's own 32-byte endpoint secret key (its stable identity).
    ///   - macEndpointID: the Mac's authenticated `EndpointID`, as a string — resolved via iroh's
    ///     own endpoint discovery (no direct address is passed), the same way
    ///     `PhonePairingClient`'s production dial path and the fake-phone's attach reconnect both
    ///     already resolve the Mac.
    ///   - alpn: the private ALPN to dial on (must match what the Mac's `IrohListener` advertises).
    ///   - relayURLs: LEGACY relay seam — empty disables relays (loopback / same-LAN dev),
    ///     non-empty means custom relays by URL. Superseded by `relays`; retained (now defaulted
    ///     to `[]`) so existing callers compile unchanged. Ignored whenever `relays` is non-nil.
    ///   - relays: explicit relay selection (`.disabled` / `.n0Default` / `.custom`). `nil` (the
    ///     default) falls back to the legacy `relayURLs` behavior. The iOS app passes `.n0Default`
    ///     to attach across networks: with `.n0Default` the Mac's `EndpointID` is resolved through
    ///     n0's pkarr/DNS discovery (part of `presetN0()`) to whichever n0 relay the Mac homed to —
    ///     the bare-id dial below (no `relayUrl` hint) is exactly what discovery needs.
    ///   - connectTimeout: bounds dialing + opening the bidi stream. iroh-ffi's generated async
    ///     calls ignore Swift task cancellation (this codebase's established, repeatedly-verified
    ///     finding — see `PhonePairingClient`/`IrohE2ETests`/`norma-fake-phone`'s own identical
    ///     `withTimeout` idioms), so this is a first-wins race between two UNSTRUCTURED tasks,
    ///     never a `withThrowingTaskGroup` (which awaits every child on scope exit and would hang
    ///     right along with a stuck one).
    public static func dial(
        secret: Data,
        macEndpointID: String,
        alpn: String,
        relayURLs: [String] = [],
        relays: RelaySelection? = nil,
        connectTimeout: Duration = .seconds(20)
    ) async throws -> IrohConn {
        try await dialInternal(
            secret: secret, macEndpointID: macEndpointID, alpn: alpn, relayURLs: relayURLs,
            relays: relays, addrOverride: nil, connectTimeout: connectTimeout
        )
    }

    /// Test-only seam (reachable via `@testable import` — `internal`, mirrors
    /// `PhonePairingClient.pairInternal`'s own identical seam and identical reasoning):
    /// production has no direct-address discovery wired up hermetically (`macEndpointID` alone is
    /// resolved via iroh's own DNS/pkarr discovery service, which needs real internet AND the
    /// Mac's endpoint to have actually registered with it — neither holds for an in-process
    /// loopback listener with `relayURLs: []`, confirmed empirically while writing
    /// `IrohDialerTests`: `Endpoint.connect` on a bare `macEndpointID` against such a listener
    /// fails outright with iroh's own "All address lookup services failed... Service 'dns'
    /// failed"). A hermetic test has nothing else to dial through, so it pins `addrOverride` to
    /// the listener's own advertised `EndpointAddr` instead — exactly what
    /// `PhonePairingClientTests`/`PairingE2ETests` already do for the identical reason.
    static func dialInternal(
        secret: Data,
        macEndpointID: String,
        alpn: String,
        relayURLs: [String],
        relays: RelaySelection? = nil,
        addrOverride: EndpointAddr?,
        bindAddr: String? = nil,
        connectTimeout: Duration = .seconds(20)
    ) async throws -> IrohConn {
        let dialer = try await Endpoint.bind(options: EndpointOptions(
            preset: presetN0(),
            bindAddr: bindAddr,
            secretKey: secret,
            relayMode: try RelaySelection.resolve(relays: relays, legacyURLs: relayURLs)
        ))
        let macAddr = try addrOverride ?? EndpointAddr(
            id: EndpointId.fromString(s: macEndpointID), relayUrl: nil, addresses: []
        )
        let alpnData = Data(alpn.utf8)
        let (conn, bi): (Connection, BiStream) = try await withTimeout(connectTimeout) {
            let conn = try await dialer.connect(addr: macAddr, alpn: alpnData)
            // Verify the peer we actually reached is who was promised BEFORE opening a stream to
            // it — same SP2b global rule `PhonePairingClient.pairInternal` already enforces.
            guard conn.remoteId().description == macEndpointID else {
                try? conn.close(errorCode: 0, reason: Data())
                throw DialError.macIdentityMismatch
            }
            let bi = try await conn.openBi()
            return (conn, bi)
        }
        let peerID = conn.remoteId().description
        // `ownedEndpoint: dialer` (SP3 Task 2 ARC finding — see `IrohConn.ownedEndpoint`'s own doc
        // comment): unlike the Mac's `IrohListener`, which retains its bound endpoint for its own
        // whole lifetime independently of any one accepted connection, this dial's `dialer`
        // endpoint has no other owner once this function returns — it must be retained by the
        // very `IrohConn` it dialed, or ARC tears it (and every connection spawned from it) down.
        return IrohConn(connection: conn, bi: bi, peerID: peerID, maxFrameBytes: defaultMaxFrameBytes, ownedEndpoint: dialer)
    }
}

private struct IrohDialerTimeoutError: Error, CustomStringConvertible {
    var description: String { "IrohDialer.dial timed out" }
}

/// Runs `op` with a hard wall-clock bound — a per-file copy of this codebase's established
/// first-wins-race timeout idiom (see `PhonePairingClient.swift`'s own copy for the fullest
/// explanation of why this can't be a `withThrowingTaskGroup`: iroh-ffi's generated async calls
/// ignore Swift task cancellation, so a stuck child would keep a task group's own timeout-races
/// alive right along with it).
private func withTimeout<T>(
    _ timeout: Duration,
    _ op: @escaping @Sendable () async throws -> T
) async throws -> T {
    let resumed = OSAllocatedUnfairLock(initialState: false)
    let result: Result<T, Error> = await withCheckedContinuation { cont in
        let timer = Task {
            try? await Task.sleep(for: timeout)
            guard !Task.isCancelled else { return }
            if resumed.withLock({ let was = $0; $0 = true; return !was }) {
                cont.resume(returning: .failure(IrohDialerTimeoutError()))
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
