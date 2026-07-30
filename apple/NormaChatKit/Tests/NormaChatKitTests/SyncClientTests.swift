import Foundation
import XCTest
import NormaProtocol
@testable import NormaChatKit

/// `SyncClient` — the phone half of the replication wire, driven against a `FakeDaemon` (the scripted
/// `RpcConn` double). The fake implements the daemon's push/pull/heads semantics in memory: chunk
/// reassembly, the chat-only create path, base-seq divergence, and byte-verbatim storage — enough to
/// prove the client's pull-fold, push-chunking, and the full `DIVERGED` fork sequence WITHOUT a
/// socket. The real daemon is exercised separately by the TypeScript drill.
final class SyncClientTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("norma-sc-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    private func logURL(_ id: String) -> URL { dir.appendingPathComponent("\(id).jsonl") }

    // MARK: - JSONL builders (the daemon's / a peer's bytes)

    private func line(_ obj: [String: Any]) -> Data { try! JSONSerialization.data(withJSONObject: obj) }
    private func created(_ id: String, seq: Int = 1) -> Data {
        line(["type": "session_created", "sessionId": id, "seq": seq, "ts": seq, "scope": "global", "mode": "chat"])
    }
    private func user(_ id: String, _ seq: Int, _ text: String) -> Data {
        line(["type": "user_message", "sessionId": id, "seq": seq, "ts": seq, "threadId": "main", "text": text, "clientName": "mac"])
    }
    private func asst(_ id: String, _ seq: Int, _ text: String) -> Data {
        line(["type": "assistant_message", "sessionId": id, "seq": seq, "ts": seq, "threadId": "main", "text": text])
    }

    // MARK: - pull: a daemon session the phone has never seen

    func testSyncAllPullsANewDaemonSessionIntoTheEmptyStore() async throws {
        let id = "10000000-0000-4000-8000-000000000001"
        let daemon = FakeDaemon()
        daemon.seed(id, [created(id), user(id, 2, "from mac"), asst(id, 3, "reply")], title: "Mac chat", model: "gpt-5.4")
        let store = try LocalEventStore(directory: dir)
        let client = SyncClient(store: store, conn: daemon)

        try await client.syncAll()

        let metas = await store.sessions()
        XCTAssertEqual(metas.map { $0.sessionId }, [id])
        XCTAssertEqual(metas[0].lastSeq, 3)
        XCTAssertEqual(metas[0].lastSyncedSeq, 3)
        XCTAssertEqual(metas[0].title, "Mac chat")
        XCTAssertEqual(metas[0].model, "gpt-5.4")
        // The phone's copy is byte-identical to the daemon's.
        XCTAssertEqual(try Data(contentsOf: logURL(id)), daemon.rawLog(id))
    }

    // MARK: - pull: strictly-behind fast-forward

    func testSyncAllFastForwardsASessionThePhoneIsBehindOn() async throws {
        let id = "10000000-0000-4000-8000-000000000002"
        let daemon = FakeDaemon()
        // Phone already has seq 1..2 synced; daemon has advanced to seq 3.
        let store = try LocalEventStore(directory: dir)
        let s = try await store.createSession(sessionId: id)
        s.persist(.userMessage(.init(seq: 2, sessionId: id, ts: 2, threadId: "main", text: "hi", clientName: "phone")))
        s.setLastSyncedSeq(2)
        // The daemon copy is the phone's exact bytes (seq 1..2) plus one new event, so the append lines up.
        daemon.replace(id, phoneBytes: try Data(contentsOf: logURL(id)), plus: [asst(id, 3, "later")])

        let client = SyncClient(store: store, conn: daemon)
        try await client.syncAll()

        let head = await store.lastSeq(sessionId: id)
        XCTAssertEqual(head, 3)
        let synced = await store.lastSyncedSeq(sessionId: id)
        XCTAssertEqual(synced, 3)
        let seqs = await store.read(sessionId: id, fromSeq: 0).map { $0.seq }
        XCTAssertEqual(seqs, [1, 2, 3])
    }

    // MARK: - push: a brand-new local session is created on the daemon

    func testSyncAllCreatesALocalSessionOnTheDaemon() async throws {
        let id = "10000000-0000-4000-8000-000000000003"
        let daemon = FakeDaemon()
        let store = try LocalEventStore(directory: dir)
        let s = try await store.createSession(sessionId: id, model: "gpt-5.4")
        s.persist(.userMessage(.init(seq: 2, sessionId: id, ts: 2, threadId: "main", text: "created on phone", clientName: "phone")))
        s.setSyncedMeta(title: .some("Phone chat"))

        let client = SyncClient(store: store, conn: daemon)
        try await client.syncAll()

        XCTAssertTrue(daemon.has(id))
        XCTAssertEqual(daemon.rawLog(id), try Data(contentsOf: logURL(id)), "daemon stored the phone's bytes verbatim")
        XCTAssertEqual(daemon.meta(id)?.title, "Phone chat")
        XCTAssertEqual(daemon.meta(id)?.model, "gpt-5.4")
        let synced = await store.lastSyncedSeq(sessionId: id)
        XCTAssertEqual(synced, 2)
    }

    // MARK: - push chunking + reassembly

    func testPushChunksALogAcrossMultipleFramesAndTheDaemonReassemblesIt() async throws {
        let id = "10000000-0000-4000-8000-000000000004"
        let daemon = FakeDaemon()
        let store = try LocalEventStore(directory: dir)
        let s = try await store.createSession(sessionId: id)
        for i in 2...6 { s.persist(.assistantMessage(.init(seq: i, sessionId: id, ts: i, threadId: "main", text: "chunk-\(i)"))) }

        // A deliberately tiny chunk so the single log spans several frames (including mid-line splits).
        let client = SyncClient(store: store, conn: daemon, chunkBytes: 40)
        try await client.syncAll()

        XCTAssertGreaterThan(daemon.pushFrames, 1, "the log was pushed over multiple frames")
        XCTAssertEqual(daemon.rawLog(id), try Data(contentsOf: logURL(id)), "reassembled byte-identically")
        let synced = await store.lastSyncedSeq(sessionId: id)
        XCTAssertEqual(synced, 6)
    }

    // MARK: - DIVERGED{lastSeq:0} → re-push from seq 1, NOT a fork

    func testDivergedWithZeroLastSeqRePushesTheWholeLogAndNeverForks() async throws {
        let id = "10000000-0000-4000-8000-000000000005"
        let daemon = FakeDaemon()
        let store = try LocalEventStore(directory: dir)
        let s = try await store.createSession(sessionId: id)
        s.persist(.userMessage(.init(seq: 2, sessionId: id, ts: 2, threadId: "main", text: "a", clientName: "phone")))
        s.persist(.assistantMessage(.init(seq: 3, sessionId: id, ts: 3, threadId: "main", text: "b")))
        // The phone believes it already synced to seq 2, but the daemon holds NOTHING for this id.
        s.setLastSyncedSeq(2)

        let client = SyncClient(store: store, conn: daemon)
        try await client.syncAll()

        // Exactly one session on both sides — a spurious fork would have minted a second.
        let count = await store.sessions().count
        XCTAssertEqual(count, 1)
        XCTAssertEqual(daemon.sessionIds(), [id])
        XCTAssertEqual(daemon.rawLog(id), try Data(contentsOf: logURL(id)), "the WHOLE log was re-pushed from seq 1")
        let synced = await store.lastSyncedSeq(sessionId: id)
        XCTAssertEqual(synced, 3)
    }

    // MARK: - DIVERGED{lastSeq>0} → the full fork sequence + postcondition

    func testDivergedWithNonZeroLastSeqForksAndReconciles() async throws {
        let id = "10000000-0000-4000-8000-000000000006"
        let daemon = FakeDaemon()
        let store = try LocalEventStore(directory: dir)
        // Shared prefix synced at seq 1 (the session_created). Then BOTH sides diverged offline.
        let s = try await store.createSession(sessionId: id)
        s.setLastSyncedSeq(1)
        s.setSyncedMeta(title: .some("Shared"))
        s.persist(.userMessage(.init(seq: 2, sessionId: id, ts: 2, threadId: "main", text: "phone-a", clientName: "phone")))
        s.persist(.assistantMessage(.init(seq: 3, sessionId: id, ts: 3, threadId: "main", text: "phone-b")))
        let phonePreForkBytes = try Data(contentsOf: logURL(id)) // seq 1,2,3 — what the fork must copy

        // The daemon's OWN branch off the same seq-1 prefix.
        daemon.seed(id, [created(id), user(id, 2, "mac-x"), asst(id, 3, "mac-y"), asst(id, 4, "mac-z")], title: "Shared")

        let client = SyncClient(store: store, conn: daemon)
        try await client.syncAll()

        // ---- Postcondition: both stores hold BOTH sessions ----
        let metas = await store.sessions()
        XCTAssertEqual(metas.count, 2)
        let forkId = metas.map { $0.sessionId }.first { $0 != id }!
        XCTAssertEqual(daemon.sessionIds().sorted(), [id, forkId].sorted())

        // ---- The fork is the phone's pre-fork log, byte-identical modulo the id rewrite ----
        let forkBytes = try Data(contentsOf: logURL(forkId))
        let expected = LocalEventStore.rewriteSessionId(phonePreForkBytes, from: id, to: forkId)
        XCTAssertEqual(forkBytes, expected)
        XCTAssertEqual(daemon.rawLog(forkId), forkBytes, "the daemon stored the pushed fork verbatim")

        // ...with provenance + a marked title.
        let forkMeta = metas.first { $0.sessionId == forkId }!
        XCTAssertEqual(forkMeta.forkedFrom, SessionForkRef(sessionId: id, atSeq: 1))
        XCTAssertEqual(forkMeta.title, "Shared" + LocalEventStore.forkTitleSuffix)
        let forkSynced = await store.lastSyncedSeq(sessionId: forkId)
        XCTAssertEqual(forkSynced, 3)

        // ---- The original now carries the DAEMON's branch (the divergent local tail moved to the fork) ----
        let originalTexts = await store.read(sessionId: id, fromSeq: 0).compactMap { ev -> String? in
            if case .assistantMessage(let v) = ev.decoded { return v.text }
            if case .userMessage(let v) = ev.decoded { return v.text }
            return nil
        }
        XCTAssertEqual(originalTexts, ["mac-x", "mac-y", "mac-z"])
        let origHead = await store.lastSeq(sessionId: id)
        XCTAssertEqual(origHead, 4)
        let origSynced = await store.lastSyncedSeq(sessionId: id)
        XCTAssertEqual(origSynced, 4)
    }

    // MARK: - config / memory bootstrap

    func testFetchConfigAndMemory() async throws {
        let daemon = FakeDaemon()
        daemon.config = SyncConfig(exaKey: "exa-123", dangerousDomains: ["evil.test"], defaultModel: "gpt-5.4")
        daemon.memory = [SyncMemoryFile(name: "MEMORY.md", content: "# facts"), SyncMemoryFile(name: "prefs.md", content: "likes tea")]
        let store = try LocalEventStore(directory: dir)
        let client = SyncClient(store: store, conn: daemon)

        let config = try await client.fetchConfig()
        XCTAssertEqual(config, SyncConfig(exaKey: "exa-123", dangerousDomains: ["evil.test"], defaultModel: "gpt-5.4"))
        let memory = try await client.fetchMemory()
        XCTAssertEqual(memory.map { $0.name }, ["MEMORY.md", "prefs.md"])
    }
}

// ================================================================================================
// FakeDaemon — an in-memory scripted `RpcConn` that honours the daemon's sync semantics. NOT the
// real daemon (that is the TS drill's job); enough to drive the client through every branch.
// ================================================================================================

final class FakeDaemon: RpcConn, @unchecked Sendable {
    private let lock = NSLock()
    private var logs: [String: [Data]] = [:]                                  // sessionId → lines (seq order)
    private var metas: [String: (title: String?, model: String?, forkedFrom: SessionForkRef?)] = [:]
    private var buffer: [String: Data] = [:]                                  // reassembly (single conn)
    private(set) var pushFrames = 0
    var config = SyncConfig(exaKey: nil, dangerousDomains: [], defaultModel: "gpt-5.4")
    var memory: [SyncMemoryFile] = []

    // MARK: seeding helpers

    func seed(_ id: String, _ lines: [Data], title: String? = nil, model: String? = nil, forkedFrom: SessionForkRef? = nil) {
        lock.withLock { logs[id] = lines; metas[id] = (title, model, forkedFrom) }
    }
    /// Rebuilds a session as the phone's EXACT bytes plus extra lines, so an append lines up seq-wise.
    func replace(_ id: String, phoneBytes: Data, plus extra: [Data]) {
        lock.withLock { logs[id] = LocalChatSession.split(phoneBytes) + extra }
    }
    func has(_ id: String) -> Bool { lock.withLock { logs[id] != nil } }
    func sessionIds() -> [String] { lock.withLock { Array(logs.keys) } }
    func rawLog(_ id: String) -> Data { lock.withLock { LocalChatSession.join(logs[id] ?? []) } }
    func meta(_ id: String) -> (title: String?, model: String?, forkedFrom: SessionForkRef?)? { lock.withLock { metas[id] } }

    // MARK: RpcConn

    func call(method: String, paramsJSON: Data) async throws -> Data {
        let params = (try? JSONSerialization.jsonObject(with: paramsJSON)) as? [String: Any] ?? [:]
        switch method {
        case METHODS.syncHeads:  return try heads()
        case METHODS.syncPull:   return try pull(params)
        case METHODS.syncPush:   return try push(params)
        case METHODS.syncConfig: return try JSONEncoder().encode(config)
        case METHODS.syncMemory: return try encodeMemory()
        default: throw RpcError(code: -32601, message: "method not found: \(method)")
        }
    }

    private func heads() throws -> Data {
        let rows: [[String: Any]] = lock.withLock {
            logs.keys.sorted().map { id in
                var row: [String: Any] = ["sessionId": id, "lastSeq": logs[id]!.count, "title": (metas[id]?.title as String?) ?? NSNull()]
                if let m = metas[id]?.model { row["model"] = m }
                if let f = metas[id]?.forkedFrom { row["forkedFrom"] = ["sessionId": f.sessionId, "atSeq": f.atSeq] }
                return row
            }
        }
        return try JSONSerialization.data(withJSONObject: ["sessions": rows])
    }

    private func pull(_ p: [String: Any]) throws -> Data {
        let id = p["sessionId"] as! String
        let fromSeq = (p["fromSeq"] as! NSNumber).intValue
        let tail: Data = lock.withLock {
            let kept = (logs[id] ?? []).filter { (LineEnvelope($0)?.seq ?? 0) > fromSeq }
            return kept.isEmpty ? Data() : LocalChatSession.join(kept)
        }
        return try JSONSerialization.data(withJSONObject: ["data": tail.base64EncodedString(), "complete": true])
    }

    private func push(_ p: [String: Any]) throws -> Data {
        let id = p["sessionId"] as! String
        let baseSeq = (p["baseSeq"] as! NSNumber).intValue
        let complete = p["complete"] as! Bool
        let chunk = Data(base64Encoded: p["data"] as! String) ?? Data()
        lock.lock(); pushFrames += 1; buffer[id, default: Data()].append(chunk); lock.unlock()

        if !complete {
            let head = lock.withLock { logs[id]?.count ?? 0 }
            let buffered = lock.withLock { buffer[id]?.count ?? 0 }
            return try JSONSerialization.data(withJSONObject: ["applied": false, "lastSeq": head, "buffered": buffered])
        }

        let batch = lock.withLock { () -> Data in let b = buffer[id] ?? Data(); buffer[id] = nil; return b }
        let head = lock.withLock { logs[id]?.count ?? 0 }
        let creating = lock.withLock { logs[id] == nil }
        if creating && baseSeq != 0 { throw RpcError(code: ERR_DIVERGED, message: "unknown session", divergedLastSeq: 0) }
        if !creating && baseSeq != head {
            throw RpcError(code: ERR_DIVERGED, message: "baseSeq mismatch", divergedLastSeq: head)
        }
        let lines = LocalChatSession.split(batch)
        lock.withLock {
            logs[id, default: []].append(contentsOf: lines)
            if let metaObj = p["meta"] as? [String: Any] {
                var fork: SessionForkRef? = metas[id]?.forkedFrom
                if let f = metaObj["forkedFrom"] as? [String: Any], let sid = f["sessionId"] as? String, let at = (f["atSeq"] as? NSNumber)?.intValue {
                    fork = SessionForkRef(sessionId: sid, atSeq: at)
                }
                metas[id] = (metaObj["title"] as? String ?? metas[id]?.title,
                             metaObj["model"] as? String ?? metas[id]?.model, fork)
            }
        }
        let newHead = lock.withLock { logs[id]!.count }
        return try JSONSerialization.data(withJSONObject: ["applied": true, "lastSeq": newHead, "buffered": 0])
    }

    private func encodeMemory() throws -> Data {
        let files = memory.map { ["name": $0.name, "content": $0.content] }
        return try JSONSerialization.data(withJSONObject: ["files": files, "complete": true])
    }
}
