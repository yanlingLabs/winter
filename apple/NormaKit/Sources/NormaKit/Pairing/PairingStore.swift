import Foundation

/// A phone this Mac has paired with. `phoneEndpointID` is the durable key (iroh's node id for
/// the phone) — everything else is metadata the UI shows or the gateway enforces against.
public struct PairRecord: Codable, Equatable, Sendable {
    public let phoneEndpointID: String
    public var label: String
    public let createdAt: Int
    public var caps: [String]
    public var pairingEpoch: Int
    public var lastSeenAt: Int

    public init(
        phoneEndpointID: String,
        label: String,
        createdAt: Int,
        caps: [String],
        pairingEpoch: Int,
        lastSeenAt: Int
    ) {
        self.phoneEndpointID = phoneEndpointID
        self.label = label
        self.createdAt = createdAt
        self.caps = caps
        self.pairingEpoch = pairingEpoch
        self.lastSeenAt = lastSeenAt
    }
}

public enum PairingStoreError: Error, Equatable {
    /// Thrown by `add` when the store already holds 10 records for a phone NOT already among
    /// them — the paired-device cap. Adding a record for an already-paired phone (a re-pair)
    /// never hits this, since it doesn't grow the count.
    case capReached
}

/// The Mac's persisted allowlist of paired phones — a JSON file, atomically written, that is the
/// single source of truth for "which phones may talk to this daemon." Also remembers, per phone,
/// the next pairing epoch to hand out after a revoke (`epochMemory`), so a revoked-then-re-paired
/// phone's old epoch can never be replayed.
///
/// One actor per file: all reads/writes are serialized through this actor, and every mutation
/// that changes on-disk state persists synchronously (still inside the actor-isolated call) before
/// returning, so two actors pointed at the same file (as the "reload fresh" tests do) always see
/// a consistent, fully-written file rather than a partial write.
public actor PairingStore {
    private struct PersistedFile: Codable {
        var storeVersion: Int
        var records: [PairRecord]
        var epochMemory: [String: Int]
    }

    /// Paired-device cap (SP2b global constraint).
    private static let capacity = 10

    private let fileURL: URL
    private var records: [String: PairRecord] = [:]
    private var epochMemory: [String: Int] = [:]

    public init(fileURL: URL) {
        self.fileURL = fileURL
        guard
            let data = try? Data(contentsOf: fileURL),
            let file = try? JSONDecoder().decode(PersistedFile.self, from: data)
        else {
            return
        }
        for record in file.records {
            records[record.phoneEndpointID] = record
        }
        epochMemory = file.epochMemory
    }

    public func all() -> [PairRecord] {
        Array(records.values)
    }

    public func record(forPeer peer: String) -> PairRecord? {
        records[peer]
    }

    /// Adds (or replaces, for a re-pair of an already-known phone) a record, assigning the
    /// pairing epoch ITSELF — the epoch read and the record write happen inside one actor call,
    /// so no interleaved `revoke`/`add` for the same peer can ever slip between "pick the epoch"
    /// and "persist the record" (the race the original two-call `nextEpoch` + `add(_:)` API
    /// allowed a caller to create). Returns the persisted record; callers read the assigned
    /// epoch off it.
    ///
    /// Only a genuinely NEW phone counts against the cap — re-adding an existing
    /// `phoneEndpointID` (a re-pair) never grows the allowlist, so it can never trip `capReached`.
    @discardableResult
    public func add(phoneEndpointID: String, label: String, caps: [String], at now: Int) throws -> PairRecord {
        if records[phoneEndpointID] == nil, records.count >= Self.capacity {
            throw PairingStoreError.capReached
        }
        let record = PairRecord(
            phoneEndpointID: phoneEndpointID, label: label, createdAt: now,
            caps: caps, pairingEpoch: nextEpoch(forPeer: phoneEndpointID), lastSeenAt: now
        )
        let previousRecord = records[phoneEndpointID]
        let previousEpochMemory = epochMemory[phoneEndpointID]
        records[phoneEndpointID] = record
        do {
            try persist()
        } catch {
            // Keep in-memory state consistent with what's actually on disk — a caller that
            // catches this (e.g. `PairingManager.confirm`) must not be told the record is live
            // when the write that was supposed to make it durable failed. `epochMemory` is
            // restored too so the rollback is total, even though `add` itself never mutates it
            // today (the epoch it assigns is READ from memory, not written back — a re-pair
            // without an intervening revoke deliberately reuses the same epoch).
            records[phoneEndpointID] = previousRecord
            epochMemory[phoneEndpointID] = previousEpochMemory
            throw error
        }
        return record
    }

    /// Removes the phone's record (freeing its cap slot) and bumps its remembered epoch so a
    /// future re-pair can never reuse the revoked epoch. Returns the epoch a future re-pair will
    /// be assigned (persisted into `epochMemory`), or `nil` if the phone had no record. Throws on
    /// persist failure, rolling back BOTH in-memory mutations — a revocation the caller was told
    /// happened must actually be durable (it's a security decision), unlike `touch` below.
    @discardableResult
    public func revoke(phoneEndpointID: String) throws -> Int? {
        guard let removed = records.removeValue(forKey: phoneEndpointID) else { return nil }
        let next = removed.pairingEpoch + 1
        let previousEpochMemory = epochMemory[phoneEndpointID]
        epochMemory[phoneEndpointID] = next
        do {
            try persist()
        } catch {
            records[phoneEndpointID] = removed
            epochMemory[phoneEndpointID] = previousEpochMemory
            throw error
        }
        return next
    }

    /// The epoch a fresh pairing for `peer` would be assigned: the remembered post-revoke epoch,
    /// or `1` for a phone that's never been paired (or paired but never revoked). Internal — the
    /// only production consumer is `add` itself (which reads it inside the same actor call);
    /// tests reach it via `@testable` to assert the persisted epoch memory.
    func nextEpoch(forPeer peer: String) -> Int {
        epochMemory[peer] ?? 1
    }

    /// Deliberately stays `try?` (unlike `add`/`revoke`): `lastSeenAt` is benign display
    /// metadata — a transient persist failure must not fail the caller's connection handling.
    public func touch(peer: String, at timestamp: Int) {
        guard records[peer] != nil else { return }
        records[peer]?.lastSeenAt = timestamp
        try? persist()
    }

    // MARK: - Persistence

    /// Atomic write: encode the whole file, write it to a sibling temp file with mode 0600, then
    /// `replaceItemAt` (a rename under the hood) into place — a reader (including a second
    /// `PairingStore` instance opened on the same path) never observes a partially-written file.
    /// `.usingNewMetadataOnly` makes the temp file's own 0600 mode win over whatever metadata the
    /// file being replaced had, instead of the two getting merged.
    private func persist() throws {
        let file = PersistedFile(storeVersion: 1, records: Array(records.values), epochMemory: epochMemory)
        let data = try JSONEncoder().encode(file)

        let dir = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: dir, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )

        let tmpURL = dir.appendingPathComponent(".\(fileURL.lastPathComponent).tmp-\(UUID().uuidString)")
        guard FileManager.default.createFile(atPath: tmpURL.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
            throw CocoaError(.fileWriteUnknown)
        }
        do {
            _ = try FileManager.default.replaceItemAt(fileURL, withItemAt: tmpURL, options: .usingNewMetadataOnly)
        } catch {
            try? FileManager.default.removeItem(at: tmpURL)
            throw error
        }
    }
}
