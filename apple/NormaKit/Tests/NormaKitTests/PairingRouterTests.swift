import XCTest
import os
import NormaProtocol
import NormaSessionKit
@testable import NormaKit

/// SP2b Task 4: `PairingRouter` (PairingRouter.swift) is the SOLE membership gate standing in front
/// of `Gateway` — every accepted connection is looked up by its authenticated `peerID` before it
/// ever reaches the gateway's own (epoch-aware) wire handling. Exercised here with scripted doubles
/// only (`LoopbackListener`/`ScriptedRemoteConn`, RemoteTransport.swift) plus a REAL `PairingStore`/
/// `PairingManager` pair (so the "lands in the ceremony" scenario is genuine, not simulated) — no
/// iroh, no real daemon. The real-transport, full-stack proof lives in `PairingE2ETests`.
final class PairingRouterTests: XCTestCase {

    // MARK: - Shared helpers (per-file copies, matching this codebase's test-double convention)

    private func makeRelayConfig() -> SignedRelayConfig {
        SignedRelayConfig(config: RelayConfig(version: 1, relays: ["relay1.norma.dev"]), sig: Data(repeating: 7, count: 64))
    }

    /// A no-op, immediate `sleepHook` — mirrors `PairingManagerTests`' own convention so the
    /// confirm-timeout watchdog never actually delays these tests.
    private let instantSleepHook: @Sendable (Duration) async -> Void = { _ in await Task.yield() }

    private func makeManager(store: PairingStore, clock: @escaping @Sendable () -> Int = { 1_700_000_000 }) -> PairingManager {
        PairingManager(
            store: store, macEndpointID: "mac-router-test", hostLabel: "Test Mac",
            relayConfig: makeRelayConfig(), clock: clock, rng: { Data(repeating: 0xAB, count: $0) },
            sleepHook: instantSleepHook
        )
    }

    private func tempStoreURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("norma-pairing-router-tests-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent("paired-devices.json")
    }

    /// The phone-side half of a real ceremony request (mirrors `PairingManagerTests`' own
    /// `phonePairRequest` — deliberately re-inlined per-file, not shared, matching that file's own
    /// comment on why: this is throwaway test-only phone-side crypto).
    private func phonePairRequest(qr: QRPayload, phoneEndpointID: String, caps: [String] = ["sessions"]) -> PairRequest {
        let phoneInstallNonce = Data(repeating: 0x11, count: 16)
        let transcript = PairingCrypto.transcript(
            v: qr.v, pairID: qr.pairID, macEndpointID: qr.macEndpointID,
            phoneEndpointID: phoneEndpointID, phoneInstallNonce: phoneInstallNonce, caps: caps
        )
        let proof = PairingCrypto.proof(pairSecret: qr.pairSecret, transcript: transcript)
        return PairRequest(
            type: "pair_request", pairID: qr.pairID, phoneEndpointID: phoneEndpointID,
            phoneInstallNonce: phoneInstallNonce, caps: caps, proof: proof
        )
    }

    /// Drains `router.connections` into a lock-guarded array a test can poll — same "poll a
    /// synchronous collector" idiom `GatewayGateTests`' own `waitForOutbound` uses, rather than
    /// racing a raw `AsyncIterator.next()` against a timeout (this router never talks to real
    /// iroh, so there's no uniffi-cancellation hazard to guard against — unlike `IrohE2ETests`'
    /// own `withTimeout`).
    private final class ConnCollector: @unchecked Sendable {
        private let box = OSAllocatedUnfairLock<[RemoteConn]>(initialState: [])
        func append(_ c: RemoteConn) { box.withLock { $0.append(c) } }
        var all: [RemoteConn] { box.withLock { $0 } }
    }

    private func waitForCount(_ collector: ConnCollector, count: Int, timeout: TimeInterval = 2) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if collector.all.count >= count { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("timed out waiting for \(count) forwarded conns; got \(collector.all.count)")
    }

    private func waitForOutbound(_ conn: ScriptedRemoteConn, count: Int, timeout: TimeInterval = 2) async throws -> [Data] {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if conn.outbound.count >= count { return conn.outbound }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("timed out waiting for \(count) outbound frames; got \(conn.outbound.count)")
        return conn.outbound
    }

    private func waitForClosed(_ conn: ScriptedRemoteConn, timeout: TimeInterval = 2) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if conn.isClosed { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("timed out waiting for conn to close")
    }

    // MARK: - A member conn flows through, completely unexamined

    func test_memberConn_flowsThroughToConnectionsUnexamined() async throws {
        let store = PairingStore(fileURL: tempStoreURL())
        try await store.add(phoneEndpointID: "peer-member", label: "iPhone", caps: ["sessions"], at: 1_000)
        let manager = makeManager(store: store)
        let base = LoopbackListener()
        let router = PairingRouter(base: base, directory: store, manager: manager)
        defer { router.stop() }

        let collector = ConnCollector()
        let drainTask = Task { for await c in router.connections { collector.append(c) } }
        defer { drainTask.cancel() }

        let conn = ScriptedRemoteConn(peerID: "peer-member")
        base.simulateConnection(conn)

        try await waitForCount(collector, count: 1)
        XCTAssertEqual(collector.all.first?.peerID, "peer-member")
        XCTAssertEqual(conn.outbound.count, 0, "the router must not touch a member conn's wire traffic at all")
        XCTAssertFalse(conn.isClosed)
    }

    // MARK: - Non-member, window open -> lands in PairingManager.handleConnection

    func test_nonMemberWithWindowOpen_landsInPairingManagerHandleConnection() async throws {
        let store = PairingStore(fileURL: tempStoreURL())
        let manager = makeManager(store: store)
        let base = LoopbackListener()
        let router = PairingRouter(base: base, directory: store, manager: manager)
        defer { router.stop() }

        let collector = ConnCollector()
        let drainTask = Task { for await c in router.connections { collector.append(c) } }
        defer { drainTask.cancel() }

        var events = manager.events.makeAsyncIterator()
        let qr = await manager.beginPairing()

        let conn = ScriptedRemoteConn(peerID: "peer-new")
        conn.enqueueInbound(try JSONEncoder().encode(phonePairRequest(qr: qr, phoneEndpointID: "peer-new")))
        base.simulateConnection(conn)

        guard case .requestReceived = await events.next() else {
            return XCTFail("expected requestReceived — the conn must have reached PairingManager.handleConnection")
        }
        // Never forwarded to the router's own Gateway-bound `connections` stream.
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(collector.all.count, 0)
    }

    // MARK: - Non-member, window closed -> not_paired then close

    func test_nonMemberWithWindowClosed_observesNotPairedThenClose() async throws {
        let store = PairingStore(fileURL: tempStoreURL())
        let manager = makeManager(store: store)
        let base = LoopbackListener()
        let router = PairingRouter(base: base, directory: store, manager: manager)
        defer { router.stop() }

        let conn = ScriptedRemoteConn(peerID: "peer-stranger")
        base.simulateConnection(conn)
        // The router reads (and discards) one inbound frame before responding — see
        // `sendNotPairedRejection`'s own doc comment on why (a real iroh constraint: the
        // ACCEPTING side can't reliably `send()` before the OPENING side has sent anything).
        // Content is irrelevant; any bytes stand in for whatever a real phone sends first.
        conn.enqueueInbound(Data("client-hello-stand-in".utf8))

        let out = try await waitForOutbound(conn, count: 1)
        let rejected = try JSONDecoder().decode(PairRejected.self, from: out[0])
        XCTAssertEqual(rejected.type, "pair_rejected")
        XCTAssertEqual(rejected.code, "not_paired")
        try await waitForClosed(conn)
    }

    // MARK: - Revoked-then-reconnecting peer: not_paired even mid-stream of an old session

    func test_revokedThenReconnectingPeer_isNotPairedEvenMidStreamOfOldSession() async throws {
        let store = PairingStore(fileURL: tempStoreURL())
        try await store.add(phoneEndpointID: "peer-revoked", label: "iPhone", caps: ["sessions"], at: 1_000)
        let manager = makeManager(store: store)
        let base = LoopbackListener()
        let router = PairingRouter(base: base, directory: store, manager: manager)
        defer { router.stop() }

        let collector = ConnCollector()
        let drainTask = Task { for await c in router.connections { collector.append(c) } }
        defer { drainTask.cancel() }

        // An "old session": still a member at the moment it dials in, forwarded, and left OPEN —
        // the router itself never retroactively touches an already-forwarded connection; only
        // `Gateway.revoke(peerID:)` (a separate mechanism entirely) would tear that down.
        let oldConn = ScriptedRemoteConn(peerID: "peer-revoked")
        base.simulateConnection(oldConn)
        try await waitForCount(collector, count: 1)

        try await store.revoke(phoneEndpointID: "peer-revoked")

        // A brand-new dial from the SAME peerID must now be refused outright.
        let newConn = ScriptedRemoteConn(peerID: "peer-revoked")
        base.simulateConnection(newConn)
        newConn.enqueueInbound(Data("client-hello-stand-in".utf8)) // see the other rejection test
        let out = try await waitForOutbound(newConn, count: 1)
        let rejected = try JSONDecoder().decode(PairRejected.self, from: out[0])
        XCTAssertEqual(rejected.code, "not_paired")
        try await waitForClosed(newConn)

        XCTAssertFalse(oldConn.isClosed, "the router must not retroactively touch the pre-revoke session's own conn")
        XCTAssertEqual(collector.all.count, 1, "only the pre-revoke conn was ever forwarded")
    }
}
