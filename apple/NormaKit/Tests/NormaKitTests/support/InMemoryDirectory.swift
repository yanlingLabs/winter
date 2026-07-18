import Foundation
import os
@testable import NormaKit

/// Test double for `PairingDirectory` (SP2b Task 4) — a plain in-memory allowlist a test seeds
/// directly, standing in for `PairingStore` wherever a test doesn't need real persistence/ceremony
/// machinery (i.e. everywhere except `PairingStoreTests`/`PairingManagerTests`/the E2E). Guarded by
/// `OSAllocatedUnfairLock`, matching this test target's existing double convention
/// (`ScriptedRemoteConn`, RemoteTransport.swift) — never held across an `await`.
final class InMemoryDirectory: PairingDirectory, @unchecked Sendable {
    private let box = OSAllocatedUnfairLock<[String: PairRecord]>(initialState: [:])

    init(records: [PairRecord] = []) {
        box.withLock { table in
            for r in records { table[r.phoneEndpointID] = r }
        }
    }

    /// Convenience for the overwhelmingly common case: one peer, one epoch — most `GatewayTests`/
    /// `GatewayGateTests`/`IrohE2ETests` scenarios only ever need a single member.
    convenience init(peerID: String, epoch: Int = 1, label: String = "test-phone", caps: [String] = ["sessions"]) {
        self.init(records: [
            PairRecord(phoneEndpointID: peerID, label: label, createdAt: 0, caps: caps, pairingEpoch: epoch, lastSeenAt: 0),
        ])
    }

    func record(forPeer peerID: String) async -> PairRecord? {
        box.withLock { $0[peerID] }
    }

    func set(_ record: PairRecord) {
        box.withLock { $0[record.phoneEndpointID] = record }
    }

    func remove(_ peerID: String) {
        box.withLock { $0.removeValue(forKey: peerID) }
    }
}
