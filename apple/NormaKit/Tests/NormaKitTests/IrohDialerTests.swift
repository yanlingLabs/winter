import XCTest
import os
import NormaProtocol
import IrohLib
@testable import NormaKit
@testable import NormaSessionKit

/// SP3 Task 2 — proves `IrohDialer.dial` (the new reusable phone-side dial, lifted from
/// `norma-fake-phone`'s hand-rolled `--attach` reconnect dial at main.swift:171-189) produces a
/// working `IrohConn` against a real (loopback) `IrohListener` — the SAME Mac accept side
/// `IrohListenerTests` already exercises. Two things this suite must show:
///   - a frame round-trips BOTH ways over the dialed `IrohConn` (listener -> dialer AND
///     dialer -> listener), proving the dialer's `IrohConn` is the identical adapter the
///     listener's own accept path hands the gateway, not a parallel implementation, and
///   - dialing a WRONG `macEndpointID` throws `IrohDialer.DialError.macIdentityMismatch`
///     rather than silently proceeding once ANY connection lands (the SP2b global "verify
///     remoteId()" rule `PhonePairingClient` already enforces).
///
/// **Why this goes through `dialInternal(addrOverride:)`, not the public `dial(...)`.** The
/// public entry point resolves `macEndpointID` purely via iroh's own DNS/pkarr discovery (no
/// direct address, no relay) — correct for a real phone reaching a real, internet-connected Mac,
/// but NOT hermetically testable: confirmed empirically while writing this suite, dialing a bare
/// `macEndpointID` against a loopback (`relayURLs: []`) listener fails outright with iroh's own
/// "All address lookup services failed... Service 'dns' failed: no calls succeeded" — a loopback
/// listener with no relay never registers with any discovery service, so no amount of network
/// access would make it resolvable by ID alone. `dialInternal`'s `addrOverride` seam (`internal`,
/// reachable via `@testable import`) sidesteps exactly that gap, mirroring
/// `PhonePairingClient.pairInternal`'s own identical seam and identical reasoning — see that
/// file's own doc comment. Both endpoints bind loopback (`127.0.0.1:0`) with relay disabled,
/// matching `IrohListenerTests`'/`PairingE2ETests`' own hermeticity rationale (task-0-report.md:
/// wildcard bind + `addr()` enrichment is non-deterministic in a sandboxed build environment).
///
/// **A second empirical finding this suite surfaced**, fixed in `IrohConn`/`IrohDialer` (see
/// `IrohConn.ownedEndpoint`'s own doc comment): the phone's dialing `Endpoint` has no owner once
/// `dial`/`dialInternal` returns — unlike `IrohListener`, which retains its bound endpoint for the
/// listener's own whole lifetime independently of any one accepted connection. Without the fix,
/// ARC drops the dialer `Endpoint` right after the dial function returns, tearing down every
/// connection spawned from it — the listener's `acceptBi()` would then never resolve, even though
/// the dialer's own `openBi()`/`send()` had already returned successfully moments earlier.
///
/// Every network step runs under `withTimeout` (below) — iroh-ffi's generated async calls ignore
/// Swift task cancellation, so a hang would otherwise wedge the whole suite instead of failing
/// loudly (the same established rationale `IrohListenerTests`/`IrohE2ETests` document).
final class IrohDialerTests: XCTestCase {
    func testDialRoundTripsFramesBothWaysOverTheReturnedConn() async throws {
        try await withTimeout(20) {
            // Listener: the Mac accept side — loopback, relay disabled, matching
            // `IrohListenerTests`' own hermetic setup.
            let listener = try await IrohListener.start(
                secret: SecretKey.generate().toBytes(),
                relayURLs: [],
                bindAddr: "127.0.0.1:0"
            )
            defer { listener.stop() }

            // Dialer: the phone side, via the new reusable `IrohDialer.dialInternal` — pinned at
            // the listener's own advertised address (see the file header on why: the public
            // `dial(...)`'s bare-ID discovery path isn't hermetically testable).
            let dialerConn = try await IrohDialer.dialInternal(
                secret: SecretKey.generate().toBytes(),
                macEndpointID: listener.endpointID.description,
                alpn: IrohListener.defaultALPN,
                relayURLs: [],
                addrOverride: listener.endpointAddr,
                bindAddr: "127.0.0.1:0"
            )

            XCTAssertEqual(
                dialerConn.peerID, listener.endpointID.description,
                "the dialer's IrohConn.peerID must be the authenticated Mac EndpointID"
            )

            // The phone speaks first (`IrohConn`'s own SEND-BEFORE-RECEIVE note): a real phone
            // always sends its `ClientHello`/pairing request before reading anything, and this
            // codebase's wire protocol relies on that convention throughout.
            let phoneToServer = Data("phone-to-server-frame".utf8)
            await dialerConn.send(phoneToServer)

            var connIter = listener.connections.makeAsyncIterator()
            guard let serverConn = await connIter.next() else {
                XCTFail("listener emitted no RemoteConn for the dialer")
                return
            }
            defer { dialerConn.close(); serverConn.close() }

            // dialer -> listener: the frame that just unblocked the listener's own accept.
            var serverInboundIter = serverConn.inbound.makeAsyncIterator()
            let receivedByServer = await serverInboundIter.next()
            XCTAssertEqual(receivedByServer, phoneToServer, "the listener's inbound must yield the dialer's whole frame")

            // listener -> dialer
            let serverToPhone = Data("server-to-phone-frame".utf8)
            await serverConn.send(serverToPhone)
            var dialerInboundIter = dialerConn.inbound.makeAsyncIterator()
            let receivedByPhone = await dialerInboundIter.next()
            XCTAssertEqual(receivedByPhone, serverToPhone, "the dialer's inbound must yield the listener's whole frame")
        }
    }

    /// SP3.3: the explicit-address attach path — passing `macRelayURL`/`macDirectAddresses` (NOT
    /// `addrOverride`) must build a working `EndpointAddr` and connect, discovery-free. This is the
    /// exact production shape the iOS app uses on reconnect (it has no `addrOverride`, only the
    /// Mac's stored `PairedHostRecord` address). Reconstructs the loopback listener's OWN address
    /// from its parts (`relayUrl()` is nil for a relay-disabled loopback listener;
    /// `directAddresses()` is its pinned `127.0.0.1:port`) and feeds them through the new params —
    /// so a successful round-trip proves branch 2 built the same reachable addr `addrOverride`
    /// would have, without touching iroh's DNS/pkarr discovery at all. Fully hermetic (loopback,
    /// relay disabled, no network), same rationale as the tests above.
    func testDialWithExplicitMacAddressesConnectsWithoutDiscovery() async throws {
        try await withTimeout(20) {
            let listener = try await IrohListener.start(
                secret: SecretKey.generate().toBytes(),
                relayURLs: [],
                bindAddr: "127.0.0.1:0"
            )
            defer { listener.stop() }

            let listenerAddr = listener.endpointAddr
            let directAddresses = listenerAddr.directAddresses()
            XCTAssertFalse(
                directAddresses.isEmpty,
                "a bindAddr-pinned loopback listener must advertise at least one direct address to dial explicitly"
            )

            // No `addrOverride` — the NEW params must carry the address instead (production shape).
            let dialerConn = try await IrohDialer.dialInternal(
                secret: SecretKey.generate().toBytes(),
                macEndpointID: listener.endpointID.description,
                alpn: IrohListener.defaultALPN,
                relayURLs: [],
                macRelayURL: listenerAddr.relayUrl(),
                macDirectAddresses: directAddresses,
                addrOverride: nil,
                bindAddr: "127.0.0.1:0"
            )

            XCTAssertEqual(
                dialerConn.peerID, listener.endpointID.description,
                "the explicit-address dial must reach the authenticated Mac EndpointID"
            )

            // Prove it's a live, usable conn (phone speaks first — `IrohConn`'s SEND-BEFORE-RECEIVE).
            let phoneToServer = Data("explicit-addr-frame".utf8)
            await dialerConn.send(phoneToServer)
            var connIter = listener.connections.makeAsyncIterator()
            guard let serverConn = await connIter.next() else {
                XCTFail("listener emitted no RemoteConn for the explicit-address dialer")
                return
            }
            defer { dialerConn.close(); serverConn.close() }
            var serverInboundIter = serverConn.inbound.makeAsyncIterator()
            let receivedByServer = await serverInboundIter.next()
            XCTAssertEqual(receivedByServer, phoneToServer, "the frame must round-trip over the explicit-address conn")
        }
    }

    /// A phone that dials a `macEndpointID` other than the one it actually reaches must refuse to
    /// proceed — same rule `PhonePairingClient.pairInternal` already enforces, now also enforced
    /// by the reusable dialer every future caller (including a future `norma-fake-phone`
    /// refactor, SP3 Task 5) gets for free. Dials the REAL listener (via `addrOverride`, same as
    /// above) but claims a WRONG `macEndpointID` — mirrors
    /// `PhonePairingClientTests.testMacIdentityMismatch_ThrowsRatherThanProceeding`'s identical
    /// shape for the identical reason: a genuinely unreachable ID (no address at all) would fail
    /// at `connect` itself, before ever reaching the identity check this test means to exercise.
    func testDialWithWrongMacEndpointIDThrowsMacIdentityMismatch() async throws {
        try await withTimeout(20) {
            let listener = try await IrohListener.start(
                secret: SecretKey.generate().toBytes(),
                relayURLs: [],
                bindAddr: "127.0.0.1:0"
            )
            defer { listener.stop() }

            // A DIFFERENT, real EndpointID (not the listener's) — pure key derivation, no
            // networking, so this is guaranteed to mismatch whatever the dialer actually reaches.
            let wrongEndpointID = SecretKey.generate().public().description
            XCTAssertNotEqual(wrongEndpointID, listener.endpointID.description)

            do {
                _ = try await IrohDialer.dialInternal(
                    secret: SecretKey.generate().toBytes(),
                    macEndpointID: wrongEndpointID,
                    alpn: IrohListener.defaultALPN,
                    relayURLs: [],
                    addrOverride: listener.endpointAddr
                )
                XCTFail("expected IrohDialer.dial to throw macIdentityMismatch")
            } catch IrohDialer.DialError.macIdentityMismatch {
                // expected
            }
        }
    }
}

/// Runs `op` with a hard wall-clock bound: iroh's accept/connect/stream calls have no timeout of
/// their own, so a deadlock regression becomes a loud, fast test failure instead of a hung CI job
/// — a per-file copy of `IrohListenerTests`' own identical helper (this codebase's established
/// per-file convention for this exact idiom).
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
