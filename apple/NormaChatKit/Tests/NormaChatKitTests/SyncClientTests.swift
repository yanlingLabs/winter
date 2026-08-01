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
        // Shared prefix synced at seq 1 (the session_created). A genuinely shared prefix means the
        // phone PUSHED that line, so the daemon holds the phone's exact bytes for it — seed the
        // daemon's branch on top of the real seq-1 line rather than a separately-built one, or the
        // final byte-comparison would be measuring the test's own inconsistency.
        let s = try await store.createSession(sessionId: id)
        s.setLastSyncedSeq(1)
        s.setSyncedMeta(title: .some("Shared"))
        let sharedPrefix = LocalChatSession.split(try Data(contentsOf: logURL(id)))
        // The daemon's OWN branch off that same seq-1 prefix.
        daemon.seed(id, sharedPrefix + [user(id, 2, "mac-x"), asst(id, 3, "mac-y"), asst(id, 4, "mac-z")], title: "Shared")

        // ...and the phone's divergent offline tail.
        s.persist(.userMessage(.init(seq: 2, sessionId: id, ts: 2, threadId: "main", text: "phone-a", clientName: "phone")))
        s.persist(.assistantMessage(.init(seq: 3, sessionId: id, ts: 3, threadId: "main", text: "phone-b")))
        let phonePreForkBytes = try Data(contentsOf: logURL(id)) // seq 1,2,3 — what the fork must copy

        let client = SyncClient(store: store, conn: daemon)
        try await client.syncAll()

        // ---- Postcondition: both stores hold BOTH sessions ----
        let metas = await store.sessions()
        XCTAssertEqual(metas.count, 2)
        let forkId = metas.map { $0.sessionId }.first { $0 != id }!
        XCTAssertEqual(daemon.sessionIds().sorted(), [id, forkId].sorted())

        // ---- The fork is the phone's pre-fork log, byte-identical modulo the id-FIELD rewrite ----
        // The expectation is built INDEPENDENTLY (Foundation's own replace over the exact key/value
        // token), never by calling the SUT's rewriter — a wrong rewrite must not be wrong identically
        // on both sides of the assertion (review M4).
        let forkBytes = try Data(contentsOf: logURL(forkId))
        let expected = Data(String(decoding: phonePreForkBytes, as: UTF8.self)
            .replacingOccurrences(of: "\"sessionId\":\"\(id)\"", with: "\"sessionId\":\"\(forkId)\"").utf8)
        XCTAssertEqual(forkBytes, expected)
        XCTAssertEqual(daemon.rawLog(forkId), forkBytes, "the daemon stored the pushed fork verbatim")

        // ...with provenance + a marked title.
        let forkMeta = metas.first { $0.sessionId == forkId }!
        XCTAssertEqual(forkMeta.forkedFrom, SessionForkRef(sessionId: id, atSeq: 1))
        XCTAssertEqual(forkMeta.title, "Shared" + LocalEventStore.forkTitleSuffix)
        let forkSynced = await store.lastSyncedSeq(sessionId: forkId)
        XCTAssertEqual(forkSynced, 3)

        // ---- The original now carries the DAEMON's branch (the divergent local tail moved to the
        // fork) — BYTE-compared against the daemon's copy, not merely shape-asserted (review M4). ----
        XCTAssertEqual(try Data(contentsOf: logURL(id)), daemon.rawLog(id),
                       "the original converged byte-identically with the daemon's branch")
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

    // MARK: - WB-I1: the marked fork title must clear the wire's own 200-char title ceiling

    /// Whole-branch review WB-I1. `SyncPushParams.meta.title` is `z.string().max(200)` — a ZOD
    /// schema check, so it refuses the call in `parseParams` before any handler runs; it is never a
    /// clamp. `planFork` appended the 15-character " (offline copy)" marker to whatever title the
    /// session already carried, with no bound of its own. A session titled at (or near) the cap —
    /// which the daemon happily SERVES, and which the phone stores verbatim off `sync.heads` —
    /// therefore produced a fork title the wire refuses, so the fork's creating push failed with
    /// INVALID_PARAMS on every pass and the divergent branch could never leave the phone.
    ///
    /// Driven end-to-end through a genuine divergence, because the fork title is only ever built on
    /// that path. `FakeDaemon` now enforces the same ceiling the real schema does (it did not
    /// before — that leniency is the second half of why this went unnoticed).
    func testForkOfANearCapTitleStillPushes_TheMarkedTitleFitsTheWire() async throws {
        let id = "10000000-0000-4000-8000-000000000011"
        let daemon = FakeDaemon()
        let store = try LocalEventStore(directory: dir)

        // A title the daemon can legitimately serve: exactly at the cap. + the marker = 215 > 200.
        let atCap = String(repeating: "T", count: LocalEventStore.maxTitleChars)
        let s = try await store.createSession(sessionId: id)
        s.setLastSyncedSeq(1)
        s.setSyncedMeta(title: .some(atCap))
        let sharedPrefix = LocalChatSession.split(try Data(contentsOf: logURL(id)))
        daemon.seed(id, sharedPrefix + [user(id, 2, "mac-x"), asst(id, 3, "mac-y")], title: atCap)
        s.persist(.userMessage(.init(seq: 2, sessionId: id, ts: 2, threadId: "main", text: "phone-a", clientName: "phone")))

        let client = SyncClient(store: store, conn: daemon)
        try await client.syncAll() // pre-fix: throws SyncPassError — the fork push is refused

        let metas = await store.sessions()
        XCTAssertEqual(metas.count, 2, "the divergent branch forked")
        let forkId = metas.map { $0.sessionId }.first { $0 != id }!
        XCTAssertTrue(daemon.has(forkId), "the fork actually LANDED on the daemon — the point of the fix")

        let forkTitle = metas.first { $0.sessionId == forkId }!.title!
        XCTAssertLessThanOrEqual(forkTitle.utf16.count, LocalEventStore.maxTitleChars)
        XCTAssertEqual(daemon.meta(forkId)?.title, forkTitle, "local and daemon agree on the clamped title")
        XCTAssertTrue(forkTitle.hasSuffix("…"), "clamped titles are marked as truncated, ellipsis inside the budget")

        // Control: an ORDINARY title still gets the full, unmangled marker.
        XCTAssertEqual(LocalEventStore.capTitle("Shared" + LocalEventStore.forkTitleSuffix),
                       "Shared" + LocalEventStore.forkTitleSuffix)
    }

    /// The other half of WB-I1's contract, at the wire boundary rather than the fork path: ANY title
    /// this client sends is bounded, whatever built it. `PushMetaParams`' initializer is the single
    /// construction point, so a future local titler (T11) cannot wedge a session by forgetting.
    func testPushMetaTitleIsClampedWhateverTheLocalSourceWas() async throws {
        let id = "10000000-0000-4000-8000-000000000012"
        let daemon = FakeDaemon()
        let store = try LocalEventStore(directory: dir)
        let s = try await store.createSession(sessionId: id)
        // A title no daemon would have served — stands in for a future phone-side titler.
        s.setSyncedMeta(title: .some(String(repeating: "L", count: 900)))

        let client = SyncClient(store: store, conn: daemon)
        try await client.syncAll() // creating push; pre-fix the wire refuses it outright

        XCTAssertTrue(daemon.has(id))
        let pushed = daemon.meta(id)?.title
        XCTAssertEqual(pushed?.utf16.count, LocalEventStore.maxTitleChars)

        // UTF-16 measurement, not grapheme count: a 200-emoji title is 400 units on the wire.
        let emoji = String(repeating: "🙂", count: 300)
        XCTAssertLessThanOrEqual(LocalEventStore.capTitle(emoji).utf16.count, LocalEventStore.maxTitleChars)
        XCTAssertTrue(LocalEventStore.capTitle(emoji).hasSuffix("🙂…"), "truncation lands on a Character boundary — no surrogate pair split")
    }

    // MARK: - C1: a daemon append RACING the pull must not wedge the session into forking forever

    func testARacingDaemonAppendDoesNotLeaveAStaleWatermarkOrMintForks() async throws {
        let id = "10000000-0000-4000-8000-000000000007"
        let daemon = FakeDaemon()
        daemon.seed(id, [created(id), user(id, 2, "mac-a"), asst(id, 3, "mac-b")], title: "Racy")
        // The Mac appends seq 4 INSIDE the pull window: heads said 3, the pull will return 1..4.
        daemon.beforePull[id] = { daemon.daemonAppend(id, self.asst(id, 4, "mac-c-appended-mid-pull")) }

        let store = try LocalEventStore(directory: dir)
        let client = SyncClient(store: store, conn: daemon)
        try await client.syncAll()

        // The watermark must equal the head that was ACTUALLY applied (4), not the stale heads
        // snapshot (3). A stale watermark here is what made the next push DIVERGE over daemon-authored
        // bytes and mint an "(offline copy)" every pass.
        let head = await store.lastSeq(sessionId: id)
        let synced = await store.lastSyncedSeq(sessionId: id)
        XCTAssertEqual(head, 4)
        XCTAssertEqual(synced, 4, "watermark comes from the applied head, not the pre-pull heads snapshot")

        // ...and the session count is stable across further passes — no fork, ever.
        for _ in 0..<3 { try await client.syncAll() }
        let localCount = await store.sessions().count
        XCTAssertEqual(localCount, 1, "no spurious fork across repeated syncs")
        XCTAssertEqual(daemon.sessionIds().count, 1)
        let forks = await store.sessions().filter { $0.forkedFrom != nil }
        XCTAssertTrue(forks.isEmpty)
    }

    func testTheWatermarkIsClampedToTheLocalHead() async throws {
        // Defence in depth for C1: even a caller handing over a head that ran ahead of our copy (a
        // push result reflecting someone else's events) can never record a promise the log can't keep.
        let id = "10000000-0000-4000-8000-000000000008"
        let store = try LocalEventStore(directory: dir)
        let s = try await store.createSession(sessionId: id)
        s.setLastSyncedSeq(999)
        XCTAssertEqual(s.lastSyncedSeq, 1, "clamped to the real head")
    }

    // MARK: - I1: DIVERGED{>0} must not fork unless the branches genuinely differ

    func testLostPushAckAdoptsTheDaemonHeadInsteadOfForking() async throws {
        // The daemon APPLIED our push; the acknowledgement never arrived, so lastSyncedSeq stayed put.
        let id = "10000000-0000-4000-8000-000000000009"
        let daemon = FakeDaemon()
        let store = try LocalEventStore(directory: dir)
        let s = try await store.createSession(sessionId: id)
        s.persist(.userMessage(.init(seq: 2, sessionId: id, ts: 2, threadId: "main", text: "a", clientName: "phone")))
        s.persist(.assistantMessage(.init(seq: 3, sessionId: id, ts: 3, threadId: "main", text: "b")))
        // The daemon already holds ALL of it; the phone thinks it only synced seq 1.
        daemon.replace(id, phoneBytes: try Data(contentsOf: logURL(id)), plus: [])
        s.setLastSyncedSeq(1)

        let client = SyncClient(store: store, conn: daemon)
        try await client.syncAll()

        let count = await store.sessions().count
        XCTAssertEqual(count, 1, "a lost ACK must never fork — the daemon already had our bytes")
        XCTAssertEqual(daemon.sessionIds(), [id])
        let synced = await store.lastSyncedSeq(sessionId: id)
        XCTAssertEqual(synced, 3, "adopted the daemon head after byte-verifying it holds our events")
    }

    func testLostAckWithDaemonSideExtraEventsAdoptsTheRemainderWithoutForking() async throws {
        // Same lost ACK, but the Mac then added its own events on TOP of ours. Our bytes are still a
        // prefix of theirs, so the answer is "append their remainder", not "fork".
        let id = "10000000-0000-4000-8000-00000000000a"
        let daemon = FakeDaemon()
        let store = try LocalEventStore(directory: dir)
        let s = try await store.createSession(sessionId: id)
        s.persist(.userMessage(.init(seq: 2, sessionId: id, ts: 2, threadId: "main", text: "ours", clientName: "phone")))
        daemon.replace(id, phoneBytes: try Data(contentsOf: logURL(id)), plus: [asst(id, 3, "mac-added")])
        s.setLastSyncedSeq(1)

        let client = SyncClient(store: store, conn: daemon)
        try await client.syncAll()

        let count = await store.sessions().count
        XCTAssertEqual(count, 1)
        let head = await store.lastSeq(sessionId: id)
        let synced = await store.lastSyncedSeq(sessionId: id)
        XCTAssertEqual(head, 3)
        XCTAssertEqual(synced, 3)
        XCTAssertEqual(try Data(contentsOf: logURL(id)), daemon.rawLog(id), "converged byte-identically")
    }

    func testAFailedForkPushLeavesNoOrphanAndTheRetryDoesNotDuplicate() async throws {
        // The third I1 trigger: a genuine divergence whose FORK PUSH fails. The old order (create
        // locally, then push) left an orphan that the next pass pushed as yet another new session
        // while minting a second fresh UUID.
        let id = "10000000-0000-4000-8000-00000000000b"
        let daemon = FailingForkPushDaemon()
        let store = try LocalEventStore(directory: dir)
        let s = try await store.createSession(sessionId: id)
        s.setLastSyncedSeq(1)
        s.persist(.userMessage(.init(seq: 2, sessionId: id, ts: 2, threadId: "main", text: "phone-branch", clientName: "phone")))
        daemon.seed(id, [created(id), asst(id, 2, "mac-branch")])

        let client = SyncClient(store: store, conn: daemon)
        // Pass 1: the fork push is made to fail — nothing may be left behind.
        daemon.failCreatingPush = true
        do { try await client.syncAll(); XCTFail("the fork push should have thrown") } catch {}
        let afterFailure = await store.sessions().count
        XCTAssertEqual(afterFailure, 1, "a failed fork push must leave NO orphan local fork")

        // Pass 2: the network recovers. Exactly one fork is created, not two.
        daemon.failCreatingPush = false
        try await client.syncAll()
        let metas = await store.sessions()
        XCTAssertEqual(metas.count, 2, "exactly one fork after recovery")
        XCTAssertEqual(daemon.sessionIds().count, 2)

        // Pass 3: a steady state — no further forks.
        try await client.syncAll()
        let settled = await store.sessions().count
        XCTAssertEqual(settled, 2)
    }

    func testTheForkIdIsDeterministicInBothItsBranchPointAndItsContent() {
        let orig = "10000000-0000-4000-8000-0000000000ff"
        let branchOne = Data("line-one\n".utf8)
        let branchTwo = Data("line-one\nline-two\n".utf8)

        // Same point AND same content → the same id: what makes a retried reconcile converge rather
        // than mint a new session each attempt (review I1's idempotency guarantee, preserved exactly).
        let a = LocalEventStore.forkId(originalId: orig, atSeq: 5, contentOf: branchOne)
        let b = LocalEventStore.forkId(originalId: orig, atSeq: 5, contentOf: branchOne)
        XCTAssertEqual(a, b)

        // A different branch POINT → a different id (as before).
        XCTAssertNotEqual(a, LocalEventStore.forkId(originalId: orig, atSeq: 6, contentOf: branchOne))
        // ...and — the round-2 fix — a different branch CONTENT at the SAME point → a different id, so
        // a second divergent branch can never collide with the first and be silently discarded.
        XCTAssertNotEqual(a, LocalEventStore.forkId(originalId: orig, atSeq: 5, contentOf: branchTwo))

        // It must be the UUID shape the daemon's creating-push path requires.
        XCTAssertNotNil(UUID(uuidString: a))
        XCTAssertEqual(a.count, 36)
    }

    // MARK: - PROBE4: a second divergent branch must never be silently discarded

    func testASecondBranchSurvivesWhenTheOriginalPullFailedAfterAFork() async throws {
        // The reviewer's PROBE4 chain, link for link:
        //  1. genuine divergence → fork F pushed and committed,
        //  2. the original's branch pull FAILS (connection drop) → syncAll throws; the original is
        //     already truncated, so branch ONE now lives only in F,
        //  3. the user takes another offline turn → the original holds branch TWO,
        //  4. next pass forks again — and must NOT derive F, adopt it, and drop branch two.
        let id = "10000000-0000-4000-8000-00000000000e"
        let daemon = FailingBranchPullDaemon()
        let store = try LocalEventStore(directory: dir)
        let s = try await store.createSession(sessionId: id)
        s.setLastSyncedSeq(1)
        let sharedPrefix = LocalChatSession.split(try Data(contentsOf: logURL(id)))
        daemon.seed(id, sharedPrefix + [asst(id, 2, "mac-branch")])

        // Branch ONE, offline.
        s.persist(.userMessage(.init(seq: 2, sessionId: id, ts: 2, threadId: "main", text: "BRANCH-ONE", clientName: "phone")))

        // Pass 1: the divergence byte-compare (pull #1) and the fork push succeed; the original's
        // branch pull (pull #2) fails.
        daemon.failPullOccurrences = [id: [2]]
        do { try await client(store, daemon).syncAll(); XCTFail("the branch pull should have failed") } catch {}
        let afterPass1 = await store.sessions()
        XCTAssertEqual(afterPass1.count, 2, "fork F committed; the original truncated")
        let forkOne = afterPass1.first { $0.forkedFrom != nil }!
        XCTAssertTrue(String(decoding: try Data(contentsOf: logURL(forkOne.sessionId)), as: UTF8.self).contains("BRANCH-ONE"))

        // Step 3: the user takes ANOTHER offline turn on the original.
        let original = await store.session(id)!
        original.persist(.userMessage(.init(seq: 2, sessionId: id, ts: 3, threadId: "main", text: "BRANCH-TWO", clientName: "phone")))

        // Pass 4: the transport recovers.
        daemon.failPullOccurrences = [:]
        try await client(store, daemon).syncAll()

        // ---- The postcondition PROBE4 violated: BOTH branches must still exist somewhere. ----
        let finalMetas = await store.sessions()
        var localTexts: [String] = []
        for meta in finalMetas {
            localTexts.append(String(decoding: try Data(contentsOf: logURL(meta.sessionId)), as: UTF8.self))
        }
        XCTAssertTrue(localTexts.contains { $0.contains("BRANCH-ONE") }, "branch one must survive")
        XCTAssertTrue(localTexts.contains { $0.contains("BRANCH-TWO") },
                      "branch two must survive — it was silently discarded before the content-derived id")
        // ...and on the daemon too, so it is not merely phone-local.
        let daemonTexts = daemon.sessionIds().map { String(decoding: daemon.rawLog($0), as: UTF8.self) }
        XCTAssertTrue(daemonTexts.contains { $0.contains("BRANCH-ONE") })
        XCTAssertTrue(daemonTexts.contains { $0.contains("BRANCH-TWO") },
                      "branch two must be replicated, not just held locally")
        // Two distinct forks + the original.
        XCTAssertEqual(finalMetas.filter { $0.forkedFrom != nil }.count, 2)
        XCTAssertEqual(finalMetas.count, 3)
    }

    func testAdoptingAnExistingForkIsRefusedWhenItsBytesDiffer() async throws {
        // The second variant: the fork id exists on the DAEMON with different bytes (a hash collision,
        // or an externally-modified log). Adopting it would mark two divergent replicas "synced" and
        // strand both forever, since lastSeq == lastSyncedSeq on each. It must refuse instead.
        let id = "10000000-0000-4000-8000-00000000000f"
        let daemon = FakeDaemon()
        let store = try LocalEventStore(directory: dir)
        let s = try await store.createSession(sessionId: id)
        s.setLastSyncedSeq(1)
        let sharedPrefix = LocalChatSession.split(try Data(contentsOf: logURL(id)))
        daemon.seed(id, sharedPrefix + [asst(id, 2, "mac-branch")])
        s.persist(.userMessage(.init(seq: 2, sessionId: id, ts: 2, threadId: "main", text: "phone-branch", clientName: "phone")))

        // Pre-seed the daemon with the fork id this reconcile WILL derive, holding different content.
        let plan = try await store.planFork(originalId: id, atSeq: 1)
        daemon.seed(plan.newId, [created(plan.newId), asst(plan.newId, 2, "SOMEONE ELSE'S BYTES")])

        do {
            try await client(store, daemon).syncAll()
            XCTFail("adopting a fork whose bytes differ must be refused")
        } catch {
            // Surfaced per-session (N-M2) rather than swallowed.
            let pass = error as? SyncPassError
            XCTAssertEqual(pass?.sessionIds, [id])
        }
        // The local divergent branch is untouched, so nothing was lost and a later pass can retry.
        let head = await store.lastSeq(sessionId: id)
        XCTAssertEqual(head, 2)
        XCTAssertTrue(String(decoding: try Data(contentsOf: logURL(id)), as: UTF8.self).contains("phone-branch"))
    }

    // MARK: - PROBE5 (T9 round-2 M1): the adopt guard is a PREFIX relation, not equality

    /// The reviewer's PROBE5 chain: the fork push LANDS, its acknowledgement is lost, and before the
    /// phone's next pass the Mac types into the new "(offline copy)". The daemon's copy of the fork is
    /// then `plan.bytes` PLUS the Mac's line — and the adopt guard, written as `remote == plan.bytes`,
    /// read that as "a different branch" and refused. Every subsequent pass refused identically
    /// (`outcomes=[threw, threw, threw]`, the original frozen at head=2/synced=1) until the user
    /// happened to send another message, which changed the source bytes and therefore the
    /// content-derived fork id.
    ///
    /// Rated Minor on consequence (loud, nothing lost, self-heals on the next user turn) and promoted
    /// to must-fix by the whole-branch review for one reason: WB-C1's fix is what makes this code path
    /// EXECUTE in production for the first time, and the kit tag freezes it.
    ///
    /// The correct relation is the one `reconcileDivergence` two functions up already uses:
    /// daemon ⊇ local ⟹ the daemon holds our bytes. Adopt, and let the pull phase collect the rest.
    func testAdoptingAForkTheMacHasSinceAppendedToConverges() async throws {
        let id = "10000000-0000-4000-8000-000000000013"
        let daemon = FakeDaemon()
        let store = try LocalEventStore(directory: dir)
        let s = try await store.createSession(sessionId: id)
        s.setLastSyncedSeq(1)
        let sharedPrefix = LocalChatSession.split(try Data(contentsOf: logURL(id)))
        daemon.seed(id, sharedPrefix + [asst(id, 2, "mac-branch")])
        s.persist(.userMessage(.init(seq: 2, sessionId: id, ts: 2, threadId: "main", text: "phone-branch", clientName: "phone")))

        // The lost-ack state: the daemon ALREADY holds this exact fork (same content-derived id, same
        // bytes) — and the Mac has since appended one message to it.
        let plan = try await store.planFork(originalId: id, atSeq: 1)
        daemon.seed(plan.newId, LocalChatSession.split(plan.bytes) + [asst(plan.newId, plan.lastSeq + 1, "mac-typed-into-the-copy")],
                    title: plan.title, forkedFrom: plan.forkedFrom)

        // Three passes, exactly as PROBE5 ran them. Pre-fix: [threw, threw, threw].
        var outcomes: [String] = []
        for _ in 0..<3 {
            do { try await client(store, daemon).syncAll(); outcomes.append("ok") }
            catch { outcomes.append("threw: \(error)") }
        }
        XCTAssertEqual(outcomes, ["ok", "ok", "ok"], "the adopt must converge, not refuse forever")

        // ---- Postcondition: the fork is adopted locally, INCLUDING the Mac's later message ----
        let metas = await store.sessions()
        XCTAssertEqual(metas.count, 2)
        let fork = metas.first { $0.sessionId == plan.newId }
        XCTAssertNotNil(fork, "the adopted fork keeps the content-derived id — no duplicate was minted")
        XCTAssertEqual(daemon.sessionIds().count, 2, "no second fork on the daemon either")
        let forkBytes = try Data(contentsOf: logURL(plan.newId))
        XCTAssertEqual(forkBytes, daemon.rawLog(plan.newId), "the pull phase fast-forwarded the adopted fork")
        XCTAssertTrue(String(decoding: forkBytes, as: UTF8.self).contains("phone-typed") == false)
        XCTAssertTrue(String(decoding: forkBytes, as: UTF8.self).contains("mac-typed-into-the-copy"))
        XCTAssertEqual(fork?.lastSyncedSeq, fork?.lastSeq, "watermark caught up — no perpetual re-push")

        // ...and the ORIGINAL converged onto the daemon's branch, which is what stayed frozen before.
        XCTAssertEqual(try Data(contentsOf: logURL(id)), daemon.rawLog(id))
        let origSynced = await store.lastSyncedSeq(sessionId: id)
        let origHead = await store.lastSeq(sessionId: id)
        XCTAssertEqual(origSynced, origHead)
        XCTAssertEqual(origHead, 2)
    }

    /// The refusal must stay REAL: a prefix relation is not "anything goes". A fork id holding bytes
    /// that are NOT ours is still refused — `testAdoptingAnExistingForkIsRefusedWhenItsBytesDiffer`
    /// above covers the daemon side; this covers the LOCAL store's own adopt gate, which the same fix
    /// loosened from `==` to `starts(with:)`.
    func testCommitForkStillRefusesALocalLogThatIsNotOurBranch() async throws {
        let id = "10000000-0000-4000-8000-000000000014"
        let store = try LocalEventStore(directory: dir)
        let s = try await store.createSession(sessionId: id)
        s.persist(.userMessage(.init(seq: 2, sessionId: id, ts: 2, threadId: "main", text: "ours", clientName: "phone")))
        let plan = try await store.planFork(originalId: id, atSeq: 1)

        // A local log already registered under the fork id whose FIRST bytes are somebody else's.
        let alien = try await store.createSession(sessionId: plan.newId)
        alien.persist(.assistantMessage(.init(seq: 2, sessionId: plan.newId, ts: 2, threadId: "main", text: "SOMEONE ELSE'S BYTES")))

        do {
            _ = try await store.commitFork(plan, syncedSeq: 2)
            XCTFail("a local log that does not contain our branch must never be adopted")
        } catch {
            XCTAssertEqual(error as? LocalStoreError, .forkBytesMismatch(plan.newId))
        }
    }

    // MARK: - N-M2: one failing session must not block the others in the pass

    func testOneFailingSessionStillLetsEveryOtherSessionSync() async throws {
        let bad = "10000000-0000-4000-8000-000000000010"
        let good = "10000000-0000-4000-8000-000000000011"
        let daemon = FailingBranchPullDaemon()
        daemon.seed(bad, [created(bad), asst(bad, 2, "unreachable")])
        daemon.seed(good, [created(good), asst(good, 2, "reachable")])
        daemon.failPullOccurrences = [bad: [1]] // the FIRST session in id order fails

        let store = try LocalEventStore(directory: dir)
        do {
            try await client(store, daemon).syncAll()
            XCTFail("the failing session must still be surfaced")
        } catch {
            XCTAssertEqual((error as? SyncPassError)?.sessionIds, [bad])
        }
        // The later session synced anyway — before per-session isolation it was left untouched.
        let syncedGood = await store.lastSyncedSeq(sessionId: good)
        XCTAssertEqual(syncedGood, 2, "a later session must not be blocked by an earlier failure")
        let badHead = await store.lastSeq(sessionId: bad)
        XCTAssertEqual(badHead, 0)
    }

    // MARK: - N-M1: the scoped rewrite is verified to have applied

    func testPlanForkRefusesALogWhoseIdFieldTheScopedRewriteCannotReach() async throws {
        // A line written as `"sessionId" : "<id>"` (spaces around the colon) is not matched by the
        // scoped token. No writer here emits that — and the guard is what keeps that assumption honest
        // instead of shipping a fork whose lines still carry the original id.
        let id = "10000000-0000-4000-8000-000000000012"
        let store = try LocalEventStore(directory: dir)
        _ = try await store.createSession(sessionId: id)
        let spaced = #"{"type":"assistant_message","sessionId" : "\#(id)","seq":2,"ts":2,"threadId":"main","text":"x"}"#
        LocalChatSession.appendLine(Data(spaced.utf8), to: logURL(id))
        let reopened = try LocalEventStore(directory: dir)

        do {
            _ = try await reopened.planFork(originalId: id, atSeq: 1)
            XCTFail("planFork must refuse a log the scoped rewrite could not fully apply to")
        } catch {
            XCTAssertEqual(error as? LocalStoreError, .forkRewriteIncomplete(id))
        }
    }

    private func client(_ store: LocalEventStore, _ conn: RpcConn) -> SyncClient {
        SyncClient(store: store, conn: conn)
    }

    // MARK: - I4: the Swift cursor-resume loops must actually execute

    func testPullResumesAcrossCursorPagesAndReassemblesByteIdentically() async throws {
        let id = "10000000-0000-4000-8000-00000000000c"
        let daemon = FakeDaemon()
        var lines = [created(id)]
        for seq in 2...12 { lines.append(asst(id, seq, String(repeating: "p", count: 200))) }
        daemon.seed(id, lines)
        daemon.pageBytes = 128 // forces many cursor-resumed pages

        let store = try LocalEventStore(directory: dir)
        let client = SyncClient(store: store, conn: daemon)
        try await client.syncAll()

        XCTAssertGreaterThan(daemon.pullPages, 1, "the Swift client's cursor-resume loop ran")
        XCTAssertEqual(try Data(contentsOf: logURL(id)), daemon.rawLog(id), "pages reassembled byte-identically")
        let synced = await store.lastSyncedSeq(sessionId: id)
        XCTAssertEqual(synced, 12)
    }

    func testFetchMemoryWalksEveryPage() async throws {
        let daemon = FakeDaemon()
        daemon.memory = (1...7).map { SyncMemoryFile(name: "m\($0).md", content: "body-\($0)") }
        daemon.memoryPageSize = 2
        let store = try LocalEventStore(directory: dir)
        let client = SyncClient(store: store, conn: daemon)

        let files = try await client.fetchMemory()
        XCTAssertEqual(files.map { $0.name }, ["m1.md", "m2.md", "m3.md", "m4.md", "m5.md", "m6.md", "m7.md"])
        XCTAssertGreaterThan(daemon.memoryPages, 1, "the memory cursor loop ran")
    }

    // MARK: - M3: the 384 KiB ceiling is a guard, not a comment

    func testChunkSizeAlwaysFitsTheBase64Ceiling() {
        // The production size, and the clamp that stops any caller breaching the daemon's hard cap.
        XCTAssertLessThanOrEqual(SyncClient.base64Length(ofRawBytes: SyncClient.rawChunkBytes),
                                 SyncClient.maxChunkBase64)
        XCTAssertEqual(SyncClient.base64Length(ofRawBytes: 256 * 1024), 349_528)
        XCTAssertEqual(SyncClient.maxChunkBase64, 384 * 1024)
    }

    func testAnOversizedChunkSizeIsClampedRatherThanBreachingTheCap() async throws {
        // A caller (or a future edit) asking for a 4 MiB chunk must not be able to emit a frame the
        // daemon refuses outright — and that on the phone transport would end the connection.
        let id = "10000000-0000-4000-8000-00000000000d"
        let daemon = RecordingChunkDaemon()
        let store = try LocalEventStore(directory: dir)
        let s = try await store.createSession(sessionId: id)
        s.persist(.assistantMessage(.init(seq: 2, sessionId: id, ts: 2, threadId: "main",
                                           text: String(repeating: "q", count: 900 * 1024))))
        let client = SyncClient(store: store, conn: daemon, chunkBytes: 4 * 1024 * 1024)
        try await client.syncAll()

        XCTAssertGreaterThan(daemon.base64Lengths.count, 1, "the oversized request was split")
        for length in daemon.base64Lengths {
            XCTAssertLessThanOrEqual(length, SyncClient.maxChunkBase64)
        }
    }

    // MARK: - G1-G6: FakeDaemon now refuses what the wire refuses (whole-branch combined review,
    // Important-1 mandate). Each test drives `daemon.call` directly — the same `RpcConn` seam a real
    // client bug would misuse — rather than through `SyncClient`, since the point is that the DOUBLE
    // itself must refuse bad input regardless of how well-behaved the caller is.

    func testPushRefusesAChunkThatBreachesTheWiresBase64Ceiling() async throws {
        // G1: `SyncPushParams.data` is `z.string().max(SYNC_MAX_CHUNK_B64)` (384 KiB) — a schema-level
        // hard refusal. Pre-fix, FakeDaemon had no size check at all.
        let daemon = FakeDaemon()
        let oversized = String(repeating: "A", count: SyncClient.maxChunkBase64 + 4)
        let params: [String: Any] = [
            "sessionId": "10000000-0000-4000-8000-000000000030", "baseSeq": 0,
            "data": oversized, "complete": true,
        ]
        do {
            _ = try await daemon.call(method: METHODS.syncPush, paramsJSON: try! JSONSerialization.data(withJSONObject: params))
            XCTFail("a chunk over the 384 KiB base64 ceiling must be refused, matching SyncPushParams.data's max()")
        } catch {
            // refused — proof the double no longer accepts what the wire refuses
        }
    }

    func testPushRefusesInvalidBase64InsteadOfSilentlyEmptyingTheChunk() async throws {
        // G2: invalid base64 must hard-refuse (ipc/sync.ts's round-trip check), not silently become an
        // empty chunk — the double's pre-fix `Data(base64Encoded:) ?? Data()` fallback was silent
        // corruption, strictly worse than mere leniency.
        let daemon = FakeDaemon()
        let id = "10000000-0000-4000-8000-000000000031"
        let params: [String: Any] = [
            "sessionId": id, "baseSeq": 0, "data": "not-valid-base64!!!", "complete": true,
        ]
        do {
            _ = try await daemon.call(method: METHODS.syncPush, paramsJSON: try! JSONSerialization.data(withJSONObject: params))
            XCTFail("invalid base64 must be refused, not silently treated as an empty chunk")
        } catch {}
        XCTAssertFalse(daemon.has(id), "nothing may be created from a refused push")
    }

    func testPushRefusesACreatingPushWhoseSessionIdIsNotAUuid() async throws {
        // G3: a creating push's sessionId must be a UUID (sync.ts's SYNCED_SESSION_ID_RE mirror) — it
        // becomes a filesystem path component. Pre-fix, any string could create a session.
        let daemon = FakeDaemon()
        let id = "not-a-uuid-at-all"
        let params: [String: Any] = [
            "sessionId": id, "baseSeq": 0, "data": created(id).base64EncodedString(), "complete": true,
        ]
        do {
            _ = try await daemon.call(method: METHODS.syncPush, paramsJSON: try! JSONSerialization.data(withJSONObject: params))
            XCTFail("a non-UUID creating-push sessionId must be refused")
        } catch {}
        XCTAssertFalse(daemon.has(id))
    }

    func testPushRefusesALineThatIsEnvelopeValidButNotAFullSessionEvent() async throws {
        // G4 — the widest gap: a line carrying {seq, sessionId, type} but missing a variant's required
        // fields (here `user_message` with no threadId/text/clientName) passed the old envelope-only
        // check. The wire's `SessionEvent.safeParse` refuses the WHOLE batch; nothing may be appended.
        let daemon = FakeDaemon()
        let id = "10000000-0000-4000-8000-000000000032"
        let malformed = line(["type": "user_message", "sessionId": id, "seq": 2, "ts": 2])
        let batch = LocalChatSession.join([created(id), malformed])
        let params: [String: Any] = [
            "sessionId": id, "baseSeq": 0, "data": batch.base64EncodedString(), "complete": true,
        ]
        do {
            _ = try await daemon.call(method: METHODS.syncPush, paramsJSON: try! JSONSerialization.data(withJSONObject: params))
            XCTFail("a line missing required SessionEvent fields must be refused")
        } catch {}
        XCTAssertFalse(daemon.has(id), "nothing may be partially appended from a refused batch")
    }

    func testPushRefusesAnEmptyOrOverlongModelInMeta() async throws {
        // G5: `meta.model` is `z.string().min(1).max(SESSION_MODEL_MAX_CHARS)` (200) — a schema-level
        // bound. Pre-fix, FakeDaemon accepted and applied any model, including "" and >200 chars.
        let daemon = FakeDaemon()
        let batch = created("10000000-0000-4000-8000-000000000033")
        func attempt(model: String) async -> Bool {
            let params: [String: Any] = [
                "sessionId": "10000000-0000-4000-8000-000000000033", "baseSeq": 0,
                "data": batch.base64EncodedString(), "complete": true, "meta": ["model": model],
            ]
            do {
                _ = try await daemon.call(method: METHODS.syncPush, paramsJSON: try! JSONSerialization.data(withJSONObject: params))
                return true // did not throw
            } catch { return false }
        }
        let emptyAccepted = await attempt(model: "")
        XCTAssertFalse(emptyAccepted, "an empty meta.model must be refused — z.string().min(1)")
        let overlongAccepted = await attempt(model: String(repeating: "m", count: 201))
        XCTAssertFalse(overlongAccepted, "a >200 char meta.model must be refused — SESSION_MODEL_MAX_CHARS")
    }

    func testPushRefusesAMalformedForkedFromInsteadOfSilentlyDroppingIt() async throws {
        // G6: a malformed `forkedFrom` fails `SessionForkRef`'s zod shape at the wire, refusing the
        // WHOLE call. Pre-fix, FakeDaemon silently kept the session's previous forkedFrom (or nil) and
        // let the rest of the push through — a fork-provenance encoding bug passing silently.
        let daemon = FakeDaemon()
        let id = "10000000-0000-4000-8000-000000000034"
        let batch = created(id)
        for badFork in [["sessionId": "", "atSeq": 1] as [String: Any],
                         ["sessionId": "parent", "atSeq": -1] as [String: Any],
                         ["sessionId": "parent"] as [String: Any]] {
            let params: [String: Any] = [
                "sessionId": id, "baseSeq": 0, "data": batch.base64EncodedString(), "complete": true,
                "meta": ["forkedFrom": badFork],
            ]
            do {
                _ = try await daemon.call(method: METHODS.syncPush, paramsJSON: try! JSONSerialization.data(withJSONObject: params))
                XCTFail("a malformed forkedFrom (\(badFork)) must refuse the whole call, not silently drop the field")
            } catch {}
        }
        XCTAssertFalse(daemon.has(id), "every attempt above was refused — nothing was ever created")
    }

    // MARK: - provider-correctness T6: per-session effort replicates BOTH ways

    /// PUSH. The T4-review I2 gap in the direction it was named: a phone-set effort must reach the
    /// Mac's index. Would fail before T6 — `PushMetaParams` had no `effort` field, so the value
    /// stayed on the phone and the Mac kept resolving that session at its global default while the
    /// phone's UI showed the override.
    func testPushCarriesThePerSessionEffort() async throws {
        let id = "60000000-0000-4000-8000-000000000001"
        let daemon = FakeDaemon()
        let store = try LocalEventStore(directory: dir)
        try await store.createSession(sessionId: id, model: "gpt-5.6-luna", effort: "xhigh")
        let client = SyncClient(store: store, conn: daemon)

        try await client.syncAll()

        XCTAssertEqual(daemon.meta(id)?.effort, "xhigh", "the phone's effort must ride sync.push's meta")
        XCTAssertEqual(daemon.meta(id)?.model, "gpt-5.6-luna")
    }

    /// PULL. The same field in the other direction — the Mac's own picker can set an effort on a
    /// chat session, and a one-way field would reproduce the identical divergence mirrored.
    func testPullAdoptsTheDaemonsEffort() async throws {
        let id = "60000000-0000-4000-8000-000000000002"
        let daemon = FakeDaemon()
        daemon.seed(id, [created(id), user(id, 2, "from mac")], title: "Mac chat", model: "gpt-5.6-sol", effort: "low")
        let store = try LocalEventStore(directory: dir)
        let client = SyncClient(store: store, conn: daemon)

        try await client.syncAll()

        let metas = await store.sessions()
        XCTAssertEqual(metas.first?.effort, "low")
    }

    /// ABSENT means "no override", and it must survive as absent rather than being invented into a
    /// level — the never-synced rule applied to this field. `effort: nil` is the deliberate opt-out
    /// of `FakeDaemon.seededEffort`.
    func testAnAbsentEffortStaysAbsentThroughAPull() async throws {
        let id = "60000000-0000-4000-8000-000000000003"
        let daemon = FakeDaemon()
        daemon.seed(id, [created(id), user(id, 2, "from mac")], title: "Mac chat", effort: nil)
        let store = try LocalEventStore(directory: dir)
        let client = SyncClient(store: store, conn: daemon)

        try await client.syncAll()

        let metas = await store.sessions()
        XCTAssertNil(metas.first?.effort)
    }

    /// The effort is SIDECAR-DURABLE — it survives the process, like title/model. A store rebuilt
    /// over the same directory must recover it, or every relaunch would re-push a nil and the Mac
    /// would… keep its value (absent = unchanged), leaving the two silently disagreeing forever.
    func testEffortSurvivesAStoreReopen() async throws {
        let id = "60000000-0000-4000-8000-000000000004"
        let store = try LocalEventStore(directory: dir)
        try await store.createSession(sessionId: id, effort: "high")
        let before = await store.sessions()
        XCTAssertEqual(before.first?.effort, "high")

        let reopened = try LocalEventStore(directory: dir)
        let after = await reopened.sessions()
        XCTAssertEqual(after.first?.effort, "high", "the meta sidecar must carry effort across a relaunch")
    }

    /// A FORK inherits the original's effort, exactly as it inherits its model — a fork is the same
    /// conversation branched, so it must resolve at the same reasoning level.
    func testAForkInheritsTheEffort() async throws {
        let id = "60000000-0000-4000-8000-000000000005"
        let store = try LocalEventStore(directory: dir)
        try await store.createSession(sessionId: id, model: "gpt-5.6-sol", effort: "xhigh")
        let plan = try await store.planFork(originalId: id, atSeq: 1)
        XCTAssertEqual(plan.effort, "xhigh")
        XCTAssertEqual(plan.model, "gpt-5.6-sol")
    }

    // MARK: - provider-correctness T6 review (C6): ABSENT vs. a wire null

    /// **THE PROTECTION.** A STALE phone — one holding a session it has no effort for, while the Mac
    /// has an override it has not learned about yet — must push the `effort` key ABSENT, never
    /// `null`. Absent reads as UNCHANGED on the daemon; `null` reads as CLEAR. Mapping a nil local
    /// effort to null would turn every routine push from a not-yet-caught-up phone into a silent
    /// wipe of the Mac's setting.
    ///
    /// Would fail against any "simplification" that made `PushMetaParams.effort` a plain `String?`
    /// again and let nil encode as null.
    func testAStalePhonePushesAbsentEffortNotNull() async throws {
        let id = "70000000-0000-4000-8000-000000000001"
        let daemon = FakeDaemon()
        let store = try LocalEventStore(directory: dir)
        // No effort locally — the stale case, exactly.
        try await store.createSession(sessionId: id, model: "gpt-5.6-sol")
        let client = SyncClient(store: store, conn: daemon)

        try await client.syncAll()

        let meta = try XCTUnwrap(daemon.lastPushMeta)
        XCTAssertNil(meta["effort"],
                     "a nil local effort must OMIT the key — present-and-null would clear the Mac's override")
        XCTAssertFalse(meta["effort"] is NSNull)
        XCTAssertEqual(meta["model"] as? String, "gpt-5.6-sol", "…while the fields it DOES hold still ride")
    }

    /// The other side of the same encoder: an effort the phone actually holds rides as a plain
    /// string, so "absent" really is reserved for "I have nothing to say".
    func testAPhoneWithAnEffortPushesItAsAString() async throws {
        let id = "70000000-0000-4000-8000-000000000002"
        let daemon = FakeDaemon()
        let store = try LocalEventStore(directory: dir)
        try await store.createSession(sessionId: id, effort: "xhigh")
        let client = SyncClient(store: store, conn: daemon)

        try await client.syncAll()

        let meta = try XCTUnwrap(daemon.lastPushMeta)
        XCTAssertEqual(meta["effort"] as? String, "xhigh")
        XCTAssertFalse(meta["effort"] is NSNull)
    }

    /// The DOUBLE's own three-state fold, driven directly — `SyncClient` cannot produce a wire null
    /// today (by design, see the test above), so the only way to prove `FakeDaemon` mirrors
    /// `applySyncMeta` rather than quietly treating a clear as a no-op is to hand it one.
    func testFakeDaemonMirrorsTheThreeStateEffortSemantics() async throws {
        let id = "70000000-0000-4000-8000-000000000003"
        let daemon = FakeDaemon()
        let line = created(id)

        func push(_ meta: [String: Any], baseSeq: Int, lines: [Data]) async throws {
            let params: [String: Any] = [
                "sessionId": id, "baseSeq": baseSeq,
                "data": LocalChatSession.join(lines).base64EncodedString(),
                "complete": true, "meta": meta,
            ]
            _ = try await daemon.call(method: METHODS.syncPush,
                                      paramsJSON: try JSONSerialization.data(withJSONObject: params))
        }

        try await push(["effort": "high"], baseSeq: 0, lines: [line])
        XCTAssertEqual(daemon.meta(id)?.effort, "high")

        // ABSENT → unchanged.
        try await push(["title": "t"], baseSeq: 1, lines: [user(id, 2, "a")])
        XCTAssertEqual(daemon.meta(id)?.effort, "high")

        // NULL → cleared.
        try await push(["effort": NSNull()], baseSeq: 2, lines: [user(id, 3, "b")])
        XCTAssertNil(daemon.meta(id)?.effort, "a wire null must CLEAR, exactly as applySyncMeta does")
    }

    // MARK: - config / memory bootstrap

    func testFetchConfigAndMemory() async throws {
        let daemon = FakeDaemon()
        let served = SyncConfig(provider: "codex-oauth", exaKey: "exa-123", dangerousDomains: ["evil.test"], defaultModel: "gpt-5.6-terra",
                                models: [SyncConfigModel(id: "gpt-5.6-terra", efforts: FakeDaemon.wireEfforts)],
                                defaultEffort: "high", clientEfforts: FakeDaemon.clientTiers)
        daemon.config = served
        daemon.memory = [SyncMemoryFile(name: "MEMORY.md", content: "# facts"), SyncMemoryFile(name: "prefs.md", content: "likes tea")]
        let store = try LocalEventStore(directory: dir)
        let client = SyncClient(store: store, conn: daemon)

        let config = try await client.fetchConfig()
        XCTAssertEqual(config, served)
        let memory = try await client.fetchMemory()
        XCTAssertEqual(memory.map { $0.name }, ["MEMORY.md", "prefs.md"])
    }

    // MARK: - provider-correctness T3: the model catalogue on sync.config

    /// The catalogue survives the wire verbatim — per-model efforts included.
    ///
    /// This is the whole point of the field: before it, the phone SPLIT `defaultModel` on its last
    /// `-` and synthesized sibling slugs by string concatenation, which cannot be proved correct.
    /// Now the Mac says what exists, and the phone repeats it.
    func testTheModelCatalogueRoundTripsWithPerModelEfforts() async throws {
        let daemon = FakeDaemon()
        let store = try LocalEventStore(directory: dir)
        let client = SyncClient(store: store, conn: daemon)

        let config = try await client.fetchConfig()
        XCTAssertEqual(config.models.map(\.id), ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])
        for model in config.models {
            XCTAssertEqual(model.efforts, FakeDaemon.wireEfforts,
                           "every row carries its OWN effort list — a client must never have to know they match today")
            XCTAssertFalse(model.efforts.contains("ultra"), "a global enum rejects ultra — it must never reach a picker")
            XCTAssertFalse(model.efforts.contains("minimal"), "minimal is rejected PER MODEL — the reason efforts ride per model")
            XCTAssertTrue(model.efforts.contains("none"), "none IS honoured, measured live — the old mock omitted it")
        }
        XCTAssertEqual(config.defaultEffort, "medium")
    }

    /// A Mac that reports NO catalogue decodes as an empty one — and empty must stay empty.
    ///
    /// The never-synced rule: a phone that has not been told a lineup WAITS. It does not derive one
    /// from `defaultModel`, which is exactly the guess that shipped a 400-on-first-turn once already.
    /// This pins that the kit hands its caller a truthful `[]` rather than helping.
    func testAnUnenumerableProviderYieldsAnEmptyCatalogueNeverAGuessedOne() async throws {
        let daemon = FakeDaemon()
        daemon.config = SyncConfig(provider: "openai-compatible", exaKey: nil, dangerousDomains: [], defaultModel: "my-local-llm",
                                   models: [], defaultEffort: "", clientEfforts: [])
        let store = try LocalEventStore(directory: dir)
        let client = SyncClient(store: store, conn: daemon)

        let config = try await client.fetchConfig()
        XCTAssertEqual(config.models, [], "no catalogue was served — none may be invented from the model slug")
        XCTAssertEqual(config.defaultEffort, "", "unset is not \"none\": an unset effort omits the reasoning block entirely")
        XCTAssertEqual(config.defaultModel, "my-local-llm", "the model is still served — the phone can run on it")
    }

    /// An OLDER Mac (built before these fields existed) degrades to "no catalogue", not to a failed
    /// bootstrap. This kit ships in an app that updates on its own schedule, so a phone WILL meet a
    /// daemon that predates the field; requiring it would fail the whole bundle and take the Exa key
    /// and dangerous-domain list down with it.
    func testAPreCatalogueDaemonBodyStillDecodesAsTheNeverSyncedState() throws {
        let body = Data(#"{"exaKey":"k","dangerousDomains":["evil.test"],"defaultModel":"gpt-5.6-sol"}"#.utf8)
        let config = try JSONDecoder().decode(SyncConfig.self, from: body)
        XCTAssertEqual(config.models, [])
        XCTAssertEqual(config.defaultEffort, "")
        XCTAssertEqual(config.exaKey, "k", "the fields that DO exist still land — this is a degrade, not a drop")
        XCTAssertEqual(config.dangerousDomains, ["evil.test"])
    }

    /// …and the leniency above is scoped to the two NEW fields ONLY. A body missing
    /// `dangerousDomains` or `defaultModel` must still fail the decode outright: that hard failure is
    /// the only thing standing between a partial response and `ChatConfigStore.apply` clearing the
    /// user's stored Exa key.
    func testAPartialBodyMissingAnOriginalFieldStillRefusesToDecode() {
        for body in [#"{"exaKey":"k","defaultModel":"gpt-5.6-sol","models":[],"defaultEffort":""}"#,
                     #"{"exaKey":"k","dangerousDomains":[],"models":[],"defaultEffort":""}"#] {
            XCTAssertThrowsError(try JSONDecoder().decode(SyncConfig.self, from: Data(body.utf8)),
                                 "a partial body must fail the decode, never half-apply: \(body)")
        }
    }

    /// A malformed catalogue ROW is refused, not silently dropped.
    ///
    /// T3 review I2: this used to assert only the cases Swift's SYNTHESIZED `Decodable` already
    /// rejected (missing key, wrong type) and claimed the min-length rules in prose. It did not
    /// hold — `{"id":"","efforts":[""]}` decoded cleanly while zod refuses both. The empty-string
    /// cases below are the ones that matter: an empty slug reaches a request body verbatim and
    /// returns an opaque 400, so the decoder now enforces `z.string().min(1)` on both fields and
    /// this test is what keeps that true.
    func testAMalformedCatalogueRowRefusesTheWholeBody() {
        for models in [
            #"[{"efforts":["low"]}]"#,                          // id missing
            #"[{"id":"gpt-5.6-sol"}]"#,                         // efforts missing
            #"[{"id":"gpt-5.6-sol","efforts":"low"}]"#,         // efforts not an array
            #"[{"id":"","efforts":["low"]}]"#,                  // z.string().min(1) on id
            #"[{"id":"gpt-5.6-sol","efforts":[""]}]"#,          // z.string().min(1) inside efforts
            #"[{"id":"gpt-5.6-sol","efforts":["low",""]}]"#,    // ...including a LATER element
            // One bad row poisons the whole body rather than being dropped: a catalogue silently
            // short by one model is indistinguishable from a Mac that genuinely stopped offering it.
            #"[{"id":"gpt-5.6-sol","efforts":["low"]},{"id":"","efforts":["low"]}]"#,
        ] {
            let body = #"{"exaKey":null,"dangerousDomains":[],"defaultModel":"m","defaultEffort":"","models":\#(models)}"#
            XCTAssertThrowsError(try JSONDecoder().decode(SyncConfig.self, from: Data(body.utf8)),
                                 "a malformed catalogue row must refuse the body: \(models)")
        }
    }

    // MARK: - provider-correctness T5: Norma-level client tiers on sync.config

    /// The tiers arrive as their OWN list and are never folded into a model's wire efforts.
    ///
    /// This is the property that keeps `ultra` off the wire on THIS device: the phone builds its own
    /// chat requests, so a tier that leaked into `models[].efforts` would be selected and sent, and a
    /// global enum on the backend would 400 it. Separate lists, separate meanings, asserted together.
    func testClientTiersRideTheirOwnListAndNeverAModelsWireEfforts() async throws {
        let daemon = FakeDaemon()
        let store = try LocalEventStore(directory: dir)
        let client = SyncClient(store: store, conn: daemon)

        let config = try await client.fetchConfig()
        XCTAssertEqual(config.clientEfforts, ["ultra"])
        for model in config.models {
            XCTAssertFalse(model.efforts.contains("ultra"),
                           "a Norma-level tier must never appear as a wire level for any model")
            XCTAssertTrue(Set(model.efforts).isDisjoint(with: Set(config.clientEfforts)),
                          "the two lists are disjoint by construction — never concatenate them")
        }
    }

    /// A Mac that offers NO tiers says so, and `[]` is never a licence to substitute one.
    func testADaemonOfferingNoTiersDecodesAsEmptyNeverAsAGuess() async throws {
        let daemon = FakeDaemon()
        daemon.config = SyncConfig(provider: "openai-compatible", exaKey: nil, dangerousDomains: [], defaultModel: "my-local-llm",
                                   models: [], defaultEffort: "", clientEfforts: [])
        let store = try LocalEventStore(directory: dir)
        let client = SyncClient(store: store, conn: daemon)

        let config = try await client.fetchConfig()
        XCTAssertEqual(config.clientEfforts, [])
    }

    /// A PRE-T5 Mac degrades to "no tiers", not to a failed bootstrap — and the degrade is exactly
    /// the pre-T5 behaviour (wire levels only), which is why this leniency cannot invent anything.
    func testAPreTierDaemonBodyDecodesAsNoTiersRatherThanFailing() throws {
        let body = Data(#"{"exaKey":"k","dangerousDomains":[],"defaultModel":"m","models":[],"defaultEffort":"high"}"#.utf8)
        let config = try JSONDecoder().decode(SyncConfig.self, from: body)
        XCTAssertEqual(config.clientEfforts, [])
        XCTAssertEqual(config.defaultEffort, "high", "the fields that DO exist still land")
    }

    /// The tiers survive the wire verbatim through a real encode/decode round trip, including the
    /// case that matters most: a tier list that is NOT what this build happens to hard-code.
    func testClientTiersRoundTripVerbatimIncludingAnUnfamiliarOne() throws {
        let body = #"{"exaKey":null,"dangerousDomains":[],"defaultModel":"m","defaultEffort":"","models":[],"clientEfforts":["ultra","hypermax"]}"#
        let config = try JSONDecoder().decode(SyncConfig.self, from: Data(body.utf8))
        XCTAssertEqual(config.clientEfforts, ["ultra", "hypermax"],
                       "the Mac is the authority on its own tiers — the phone repeats them, it does not filter to a list it knows")
        let reencoded = try JSONDecoder().decode(SyncConfig.self, from: try JSONEncoder().encode(config))
        XCTAssertEqual(reencoded, config)
    }

    /// The boundary the rule above must NOT overshoot: an empty `efforts` ARRAY is legal
    /// (`z.array(...)` with no `.min()`), and so is an empty `models` array. "This model accepts no
    /// effort levels" is a statement the wire can make; "" as a level is not.
    func testAnEmptyEffortsArrayIsLegalUnlikeAnEmptyEffortString() throws {
        let body = #"{"exaKey":null,"dangerousDomains":[],"defaultModel":"m","defaultEffort":"","models":[{"id":"m","efforts":[]}]}"#
        let config = try JSONDecoder().decode(SyncConfig.self, from: Data(body.utf8))
        XCTAssertEqual(config.models, [SyncConfigModel(id: "m", efforts: [])])
    }

    // MARK: - whole-branch review C1: `provider` — the field that makes the bundle self-describing

    /// The identity rides the wire and reaches the caller. Every other field says WHAT the Mac runs;
    /// this one says WHOSE, and without it a phone cannot tell a catalogue it may adopt from one it
    /// must discard.
    func testTheProviderIdentityRidesTheConfigBundle() async throws {
        let daemon = FakeDaemon()
        let store = try LocalEventStore(directory: dir)
        let client = SyncClient(store: store, conn: daemon)

        let config = try await client.fetchConfig()
        XCTAssertEqual(config.provider, "codex-oauth",
                       "the double models a codex Mac — the same provider this device runs")
    }

    /// THE LIVE 400 THIS FIELD CLOSES, as a shape assertion. A BYOK Mac honestly reports an EMPTY
    /// catalogue — its provider cannot enumerate — while `defaultModel` stays a non-empty FOREIGN
    /// slug. `ChatConfigStore.apply` stores any non-empty `defaultModel`, so a phone reading only
    /// those two would send a llama slug to Codex `/responses` and be 400'd on its first turn.
    /// `models: []` does not protect it (the empty-catalogue rule governs `models` only); the
    /// provider identity is the only field that distinguishes this bundle from a codex Mac's.
    func testABYOKMacsBundleIsDistinguishableEvenThoughItsCatalogueIsEmpty() async throws {
        let daemon = FakeDaemon()
        daemon.config = SyncConfig(provider: "openai-compatible", exaKey: nil, dangerousDomains: [],
                                   defaultModel: "llama-3.3-70b-local", models: [], defaultEffort: "",
                                   clientEfforts: [])
        let store = try LocalEventStore(directory: dir)
        let client = SyncClient(store: store, conn: daemon)

        let config = try await client.fetchConfig()
        XCTAssertEqual(config.models, [], "honest: that provider cannot enumerate")
        XCTAssertFalse(config.defaultModel.isEmpty, "…yet the slug is NOT empty — this is the trap")
        XCTAssertNotEqual(config.provider, "codex-oauth",
                          "the mismatch is visible: this device must treat the model half as never-synced")
    }

    /// A PRE-C1 Mac degrades to `""`, and `""` must NOT read as a mismatch. This is the one place
    /// the leniency direction matters: requiring the field would fail the whole bundle (Exa key and
    /// dangerous-domain list included) against every older daemon, and treating absence as FOREIGN
    /// would take local chat down on every one of them instead. Absent means "the Mac did not say",
    /// which is the pre-field status quo.
    func testAPreProviderDaemonBodyDecodesAsUnknownRatherThanForeign() throws {
        let body = Data(#"{"exaKey":"k","dangerousDomains":[],"defaultModel":"gpt-5.6-sol","models":[],"defaultEffort":"high","clientEfforts":[]}"#.utf8)
        let config = try JSONDecoder().decode(SyncConfig.self, from: body)
        XCTAssertEqual(config.provider, "")
        XCTAssertEqual(config.defaultModel, "gpt-5.6-sol", "the fields that DO exist still land — a degrade, not a drop")
    }

    /// The value survives a real encode/decode round trip verbatim, including a provider name this
    /// build has never heard of. The Mac is the authority on what it runs; the phone compares that
    /// string against its own and does not filter it to a vocabulary it knows — which is also why
    /// the wire type is a plain string rather than an enum.
    func testTheProviderRoundTripsVerbatimIncludingAnUnfamiliarOne() throws {
        for name in ["codex-oauth", "openai-compatible", "none", "some-future-provider"] {
            let body = #"{"provider":"\#(name)","exaKey":null,"dangerousDomains":[],"defaultModel":"m","defaultEffort":"","models":[],"clientEfforts":[]}"#
            let config = try JSONDecoder().decode(SyncConfig.self, from: Data(body.utf8))
            XCTAssertEqual(config.provider, name)
            let reencoded = try JSONDecoder().decode(SyncConfig.self, from: try JSONEncoder().encode(config))
            XCTAssertEqual(reencoded, config, "the identity must survive this kit's own re-encode: \(name)")
        }
    }

    // MARK: - T11-review F-8: the per-session leg

    /// A leg reconciles ONE session and leaves every other alone — the property the phone's
    /// store-wide turn queue needs so a Send waits for one session's reconcile, not a whole pass.
    func testAPerSessionLegReconcilesOnlyThatSession() async throws {
        let a = "10000000-0000-4000-8000-000000000020"
        let b = "10000000-0000-4000-8000-000000000021"
        let daemon = FakeDaemon()
        daemon.seed(a, [created(a), asst(a, 2, "from mac A")])
        daemon.seed(b, [created(b), asst(b, 2, "from mac B")])
        let store = try LocalEventStore(directory: dir)
        let client = SyncClient(store: store, conn: daemon)

        let heads = try await client.heads()
        let ids = await client.passSessionIds(heads: heads)
        XCTAssertEqual(Set(ids), [a, b])

        try await client.syncSession(a, heads: heads)
        let headA = await store.lastSeq(sessionId: a)
        let headBBeforeItsLeg = await store.lastSeq(sessionId: b)
        XCTAssertEqual(headA, 2)
        XCTAssertEqual(headBBeforeItsLeg, 0, "B's leg has not run — it must be untouched")

        try await client.syncSession(b, heads: heads)
        let headB = await store.lastSeq(sessionId: b)
        XCTAssertEqual(headB, 2)
        // Leg-by-leg lands EXACTLY where the indivisible pass would.
        XCTAssertEqual(try Data(contentsOf: logURL(a)), daemon.rawLog(a))
        XCTAssertEqual(try Data(contentsOf: logURL(b)), daemon.rawLog(b))
    }

    /// A leg pushes a purely LOCAL session too (it is in `passSessionIds` via the store, not heads),
    /// and a leg for a session neither side has is a no-op rather than a throw.
    func testAPerSessionLegPushesALocalOnlySessionAndIgnoresAnUnknownOne() async throws {
        let local = "10000000-0000-4000-8000-000000000022"
        let daemon = FakeDaemon()
        let store = try LocalEventStore(directory: dir)
        let session = try await store.createSession(sessionId: local)
        session.persist(.userMessage(.init(seq: 2, sessionId: local, ts: 2, threadId: "main", text: "typed offline", clientName: "phone")))
        let client = SyncClient(store: store, conn: daemon)

        let heads = try await client.heads()
        let ids = await client.passSessionIds(heads: heads)
        XCTAssertEqual(heads, [], "the daemon has nothing yet")
        XCTAssertEqual(ids, [local])

        try await client.syncSession(local, heads: heads)
        let synced = await store.lastSyncedSeq(sessionId: local)
        XCTAssertTrue(daemon.has(local))
        XCTAssertEqual(daemon.head(local), 2)
        XCTAssertEqual(synced, 2)

        // A leg for an id neither side holds does nothing at all.
        try await client.syncSession("10000000-0000-4000-8000-0000000000ff", heads: heads)
    }
}

// ================================================================================================
// FakeDaemon — an in-memory scripted `RpcConn` honouring the daemon's sync semantics. NOT the real
// daemon (that is the TS drill's job), but deliberately held to the SAME validation the real one
// applies (review M5), so a client regression cannot pass here and fail on a real socket:
//   • `lastSeq` is the last event's SEQ, never the line count,
//   • a batch's seqs must be contiguous from `head + 1`,
//   • every event must carry the target `sessionId`,
//   • a batch starting at seq 1 must open with a `session_created` carrying `mode:"chat"`,
//   • `baseSeq` must equal the head exactly (else DIVERGED with the real head).
// It also PAGES (`pageBytes`) so the Swift client's cursor-resume loops actually execute (review I4),
// and can run a hook on first pull to simulate a Mac append racing the pull window (review C1).
//
// WIRE-SCHEMA HARDENING (whole-branch combined review, Important-1 mandate): the list above is the
// daemon's HANDLER semantics; `push()` below now ALSO mirrors the five `sync.*` zod schemas'
// (packages/protocol/src/methods.ts) own refusals, comment-tagged G1-G6 at each check, the same
// per-rule commenting convention already used for the `meta.title` cap above — so a future reader can
// diff double-against-wire by eye. G7/G8 are commented at their own call sites as deliberately NOT
// modeled (ruled unreachable / end-state-identical by the same review), not silently absent.
// ================================================================================================

class FakeDaemon: RpcConn, @unchecked Sendable {
    private let lock = NSLock()
    private var logs: [String: [Data]] = [:]                                  // sessionId → lines (seq order)
    private var metas: [String: (title: String?, model: String?, effort: String?, forkedFrom: SessionForkRef?)] = [:]
    private var buffer: [String: Data] = [:]                                  // reassembly (single conn)
    private(set) var pushFrames = 0
    /// The RAW `meta` object of the last COMPLETE push, exactly as it arrived. Recorded because the
    /// T6 review's C6 protection is about a key being ABSENT vs. present-and-null — a distinction
    /// that is invisible once the double has folded it into `metas`. `nil` when the push carried no
    /// meta at all. (`NSNull` shows up for a wire null, as `JSONSerialization` produces it.)
    private(set) var lastPushMeta: [String: Any]?
    private(set) var pullPages = 0
    private(set) var memoryPages = 0
    /// Max raw bytes per pull page / files per memory page — `nil` means "one complete page".
    var pageBytes: Int? = nil
    var memoryPageSize: Int? = nil
    /// Runs before a pull is served, once, keyed by session — the racing-daemon-append hook.
    var beforePull: [String: () -> Void] = [:]
    /// G9 (provider-correctness T3, widened again by T5 and by the whole-branch review's C1): the
    /// default carries the FULL `sync.config` shape — the PROVIDER IDENTITY, the model catalogue,
    /// the live effort, and the Norma-level client tiers, not just a model string. `codex-oauth`
    /// specifically, because that is what the phone itself runs: a double serving a foreign provider
    /// by default would put every consumer on the never-synced path. A double that kept serving the old
    /// three-field body would have every catalogue consumer testing against an empty lineup while the
    /// real wire always sends one; that is the precise class of gap that let two real bugs through a
    /// green suite in an earlier slice. `SyncConfig`'s memberwise init takes no default arguments, so
    /// this line could not have been left behind silently.
    var config = SyncConfig(provider: "codex-oauth", exaKey: nil, dangerousDomains: [], defaultModel: "gpt-5.6-sol",
                            models: [
                                SyncConfigModel(id: "gpt-5.6-sol", efforts: FakeDaemon.wireEfforts),
                                SyncConfigModel(id: "gpt-5.6-terra", efforts: FakeDaemon.wireEfforts),
                                SyncConfigModel(id: "gpt-5.6-luna", efforts: FakeDaemon.wireEfforts),
                            ],
                            defaultEffort: "medium", clientEfforts: FakeDaemon.clientTiers)
    /// The EXACT effort universe the wire serves, mirrored from `REASONING_EFFORTS`
    /// (packages/core/src/settings.ts). `none` is in it (genuinely honoured, measured live); `ultra`
    /// is NOT (a global enum rejects it) and neither is `minimal` (rejected per model). The phone's
    /// pre-T3 mock effort list had the first two exactly backwards — a double that invented its own
    /// list would let that recur.
    static let wireEfforts = ["none", "low", "medium", "high", "xhigh", "max"]
    /// The NORMA-LEVEL tiers a current Mac offers (`CLIENT_EFFORTS`, packages/core/src/settings.ts).
    /// A SEPARATE constant from `wireEfforts` because they are separate lists on the wire and must
    /// stay separate here: a double that merged them would let a picker offer `ultra` as if the
    /// endpoint accepted it — the exact drift T3/T5 exist to make impossible.
    static let clientTiers = ["ultra"]
    var memory: [SyncMemoryFile] = []

    // MARK: seeding helpers

    func seed(_ id: String, _ lines: [Data], title: String? = nil, model: String? = nil,
              effort: String? = FakeDaemon.seededEffort, forkedFrom: SessionForkRef? = nil) {
        lock.withLock { logs[id] = lines; metas[id] = (title, model, effort, forkedFrom) }
    }
    /// G10 (provider-correctness T6): every seeded session carries an effort BY DEFAULT, for the same
    /// reason `config` above carries a full catalogue rather than an empty one. A double whose
    /// sessions never have an effort would test every consumer against the never-synced path — the
    /// exact gap shape that let two real bugs through a green suite in an earlier slice — while the
    /// real wire, once a picker exists, sends one on most sessions. A test that specifically wants
    /// the no-override case passes `effort: nil` explicitly, which now READS as the deliberate choice
    /// it is.
    static let seededEffort: String? = "medium"
    /// Rebuilds a session as the phone's EXACT bytes plus extra lines, so an append lines up seq-wise.
    func replace(_ id: String, phoneBytes: Data, plus extra: [Data]) {
        lock.withLock { logs[id] = LocalChatSession.split(phoneBytes) + extra }
    }
    /// Appends one line as the DAEMON would (used by the racing-append hook).
    func daemonAppend(_ id: String, _ line: Data) { lock.withLock { logs[id, default: []].append(line) } }
    func has(_ id: String) -> Bool { lock.withLock { logs[id] != nil } }
    func sessionIds() -> [String] { lock.withLock { Array(logs.keys) } }
    func rawLog(_ id: String) -> Data { lock.withLock { LocalChatSession.join(logs[id] ?? []) } }
    func meta(_ id: String) -> (title: String?, model: String?, effort: String?, forkedFrom: SessionForkRef?)? { lock.withLock { metas[id] } }
    /// The head as the daemon computes it: the LAST EVENT'S SEQ (M5 — not the line count).
    func head(_ id: String) -> Int {
        lock.withLock { (logs[id]?.last.flatMap { LineEnvelope($0)?.seq }) ?? 0 }
    }

    // MARK: RpcConn

    func call(method: String, paramsJSON: Data) async throws -> Data {
        let params = (try? JSONSerialization.jsonObject(with: paramsJSON)) as? [String: Any] ?? [:]
        switch method {
        case METHODS.syncHeads:  return try heads()
        case METHODS.syncPull:   return try pull(params)
        case METHODS.syncPush:   return try push(params)
        case METHODS.syncConfig: return try JSONEncoder().encode(config)
        case METHODS.syncMemory: return try encodeMemory(params)
        default: throw RpcError(code: -32601, message: "method not found: \(method)")
        }
    }

    private func heads() throws -> Data {
        let ids = lock.withLock { logs.keys.sorted() }
        let rows: [[String: Any]] = ids.map { id in
            var row: [String: Any] = ["sessionId": id, "lastSeq": head(id),
                                      "title": (lock.withLock { metas[id]?.title } as String?) ?? NSNull()]
            if let m = lock.withLock({ metas[id]?.model }) { row["model"] = m }
            // T6: OMITTED when absent, exactly as the daemon serves it (`syncHeads`, ipc/sync.ts) —
            // absent means "no override", which is a different fact from any level.
            if let e = lock.withLock({ metas[id]?.effort }) { row["effort"] = e }
            if let f = lock.withLock({ metas[id]?.forkedFrom }) { row["forkedFrom"] = ["sessionId": f.sessionId, "atSeq": f.atSeq] }
            return row
        }
        return try JSONSerialization.data(withJSONObject: ["sessions": rows])
    }

    /// Byte-offset-cursor paging over the tail, exactly as `SessionStore.readRawTail` does.
    ///
    /// G7 (deliberately unmodeled, not fixed): the wire's `resolveChatSession` (ipc/sync.ts:161-183)
    /// makes an unknown sessionId NOT_FOUND and a non-chat session INVALID_PARAMS; this double has no
    /// mode concept at all and returns an empty success (`logs[id] ?? []`) for an id it has never seen.
    /// Left as-is because it is unreachable from today's `SyncClient` control flow (it only ever pulls
    /// an id sourced from `heads` or a post-DIVERGED fork/reconcile path) — the combined review's ruling.
    private func pull(_ p: [String: Any]) throws -> Data {
        let id = p["sessionId"] as! String
        let fromSeq = (p["fromSeq"] as! NSNumber).intValue
        let cursor = (p["cursor"] as? NSNumber)?.intValue ?? 0
        if let hook = beforePull[id] { beforePull[id] = nil; hook() } // the racing-append window
        pullPages += 1
        let tail: Data = lock.withLock {
            let kept = (logs[id] ?? []).filter { (LineEnvelope($0)?.seq ?? 0) > fromSeq }
            return kept.isEmpty ? Data() : LocalChatSession.join(kept)
        }
        guard cursor <= tail.count else { throw RpcError(code: -32602, message: "cursor past the end of the tail") }
        let limit = pageBytes ?? max(tail.count, 1)
        let end = min(cursor + limit, tail.count)
        let page = tail.subdata(in: cursor..<end)
        var out: [String: Any] = ["data": page.base64EncodedString(), "complete": end >= tail.count]
        if end < tail.count { out["nextCursor"] = end }
        return try JSONSerialization.data(withJSONObject: out)
    }

    private func push(_ p: [String: Any]) throws -> Data {
        let id = p["sessionId"] as! String
        let metaObj = p["meta"] as? [String: Any]

        // WIRE CAP, mirrored from `SyncPushParams.meta.title` = `z.string().max(200)`. It is a ZOD
        // SCHEMA check, so it runs in `parseParams` before any handler sees the call and it is a hard
        // refusal, never a clamp. This double did not model it, which is why the phone could build a
        // 210-char fork title (a served-at-the-cap title plus the 15-char marker) and no test noticed
        // that every push carrying it would be refused for as long as the title lived — whole-branch
        // WB-I1. A test double that is lenient where the wire is strict proves nothing about the wire.
        if let title = metaObj?["title"] as? String, title.utf16.count > 200 {
            throw RpcError(code: -32602, message: "expected string to have <=200 characters (meta.title was \(title.utf16.count))")
        }
        // G5 — WIRE RULE mirrored from `SyncPushParams.meta.model` = `z.string().min(1).max(SESSION_MODEL_MAX_CHARS)`
        // (methods.ts:1044, 200 chars) — a schema-level bound, refused before any handler logic runs.
        // Distinct from (and NOT modeled here) the separate handler-level policy in `validateSyncMeta`
        // where an unknown-but-well-shaped model slug is DROPPED rather than failing the call: that
        // needs a model catalogue this double has no concept of, so it is out of scope for a wire-SHAPE
        // check. Only the hard length bound — where the double used to accept "" and any length — is.
        if let model = metaObj?["model"] as? String, model.isEmpty || model.utf16.count > 200 {
            throw RpcError(code: -32602, message: "expected string to have >=1 and <=200 characters (meta.model was \(model.utf16.count))")
        }
        // G10 — WIRE RULE mirrored from `SyncPushParams.meta.effort` = `z.string().min(1).max(
        // SESSION_EFFORT_MAX_CHARS)` (methods.ts, 32 chars), a schema-level bound refused before any
        // handler logic runs. Distinct from (and NOT modeled here, exactly as for `model`) the
        // handler-level DROP of a wire-invalid or tier value in `validateSyncMeta`: that needs a
        // model catalogue and a mode concept this double has neither of, so it is out of scope for a
        // wire-SHAPE check.
        if let effort = metaObj?["effort"] as? String, effort.isEmpty || effort.utf16.count > 32 {
            throw RpcError(code: -32602, message: "expected string to have >=1 and <=32 characters (meta.effort was \(effort.utf16.count))")
        }
        // G6 — WIRE RULE mirrored from `SessionForkRef` (methods.ts:75-78): `{sessionId: min(1) string,
        // atSeq: nonnegative int}`. A malformed shape fails zod's parse BEFORE any handler runs, so the
        // WHOLE call is refused — this double used to silently keep whatever `forkedFrom` the session
        // already had (or nil) and let the rest of the push through, which is a fork-provenance
        // corruption passing silently rather than loudly.
        if let forkAny = metaObj?["forkedFrom"] {
            guard let fork = forkAny as? [String: Any],
                  let forkSid = fork["sessionId"] as? String, !forkSid.isEmpty,
                  let atSeqNum = fork["atSeq"] as? NSNumber,
                  atSeqNum.doubleValue == atSeqNum.doubleValue.rounded(), atSeqNum.intValue >= 0
            else {
                throw RpcError(code: -32602, message: "meta.forkedFrom must be {sessionId: non-empty string, atSeq: nonnegative int}")
            }
        }

        // G1 — WIRE CEILING mirrored from `SyncPushParams.data` = `z.string().max(SYNC_MAX_CHUNK_B64)`
        // (methods.ts:1038, 384 KiB) — a hard refusal at the schema, before any bytes are buffered. This
        // double had NO size check at all, so a kit regression removing the client's own `chunkBytes`
        // clamp would pass every test here and only fail on a real (frame-ending) phone socket.
        let dataStr = p["data"] as! String
        guard dataStr.utf16.count <= SyncClient.maxChunkBase64 else {
            throw RpcError(code: -32602, message: "expected string to have <=\(SyncClient.maxChunkBase64) characters (data was \(dataStr.utf16.count))")
        }
        // G2 — WIRE RULE mirrored from `sync.ts`'s post-decode round-trip check (ipc/sync.ts ~373-380):
        // `Buffer.from(s, "base64")` never throws — it silently discards non-alphabet characters — so
        // the wire re-encodes and compares byte-for-byte, refusing anything that doesn't round-trip
        // EXACTLY. This double used to fall back to `Data()` on a decode failure — SILENT CORRUPTION
        // dressed up as an empty chunk, worse than mere leniency (a kit encoding bug would silently
        // corrupt the batch here while the real wire fails loudly).
        guard let chunk = Data(base64Encoded: dataStr), chunk.base64EncodedString() == dataStr else {
            throw RpcError(code: -32602, message: "sync.push data is not valid standard (padded) base64")
        }

        let baseSeq = (p["baseSeq"] as! NSNumber).intValue
        let complete = p["complete"] as! Bool
        // G8 (deliberately unmodeled, not fixed): the wire re-checks `baseSeq` against the head on
        // EVERY chunk before buffering (ipc/sync.ts:346-353, review M5), so a stale client learns of a
        // divergence on frame 1 rather than after uploading the whole batch; this double only checks it
        // below, on the final chunk. Reassembly here is also unbounded, where the real daemon caps it
        // at 32 MiB / 16 open pushes (`SyncPushBuffers`). Both are timing/bounds only — the end state
        // (applied vs. refused) is identical either way, which is why the combined review ruled this
        // gap class unreachable-in-effect rather than a correctness hole worth spending lines on here.
        lock.lock(); pushFrames += 1; buffer[id, default: Data()].append(chunk); lock.unlock()

        if !complete {
            let buffered = lock.withLock { buffer[id]?.count ?? 0 }
            return try JSONSerialization.data(withJSONObject: ["applied": false, "lastSeq": head(id), "buffered": buffered])
        }

        let batch = lock.withLock { () -> Data in let b = buffer[id] ?? Data(); buffer[id] = nil; return b }
        let currentHead = head(id)
        let creating = lock.withLock { logs[id] == nil }
        if creating && baseSeq != 0 { throw RpcError(code: ERR_DIVERGED, message: "unknown session", divergedLastSeq: 0) }
        if !creating && baseSeq != currentHead {
            throw RpcError(code: ERR_DIVERGED, message: "baseSeq mismatch", divergedLastSeq: currentHead)
        }
        if creating {
            // G3 — WIRE RULE mirrored from `sync.ts`'s SYNCED_SESSION_ID_RE check (ipc/sync.ts:365-370):
            // a creating push's sessionId must be a UUID — it becomes a filesystem path component.
            // Production's `LocalEventStore.forkId` and "+ New chat"'s `UUID()` both conform today, so
            // this hides a FUTURE id source: a forkId refactor that breaks the shape would pass every
            // kit test here and strand every fork/creating push in production.
            guard id.range(of: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", options: .regularExpression) != nil else {
                throw RpcError(code: -32602, message: "a sync-created session id must be a UUID (got \(id))")
            }
        }

        // The daemon's own batch validation (M5) — every one of these is a hard refusal server-side.
        let lines = LocalChatSession.split(batch)
        guard !lines.isEmpty else { throw RpcError(code: -32602, message: "complete push carried no events") }
        var expected = currentHead + 1
        for line in lines {
            guard let env = LineEnvelope(line) else { throw RpcError(code: -32602, message: "unparseable event line") }
            // G4 — THE WIDEST GAP. WIRE RULE mirrored from `sync.ts`'s `parseBatch` (ipc/sync.ts:306-332):
            // every line must be a full `SessionEvent.safeParse`, not merely carry the
            // `{seq, sessionId, type}` envelope `LineEnvelope` checks. An envelope-only check lets a
            // variant with a MISSING REQUIRED FIELD (or an unrecognized `type`) through — exactly what a
            // phone-engine event-construction bug or a fork-rewrite corruption could produce — and every
            // SyncClient test would still pass. `NormaProtocol.SessionEvent` is the Swift mirror of the
            // same zod schema, so decoding each line with it is the cheap, faithful fix.
            guard (try? JSONDecoder().decode(NormaProtocol.SessionEvent.self, from: line)) != nil else {
                throw RpcError(code: -32602, message: "unparseable or invalid SessionEvent line")
            }
            guard env.sessionId == id else {
                throw RpcError(code: -32602, message: "event carries sessionId \(env.sessionId), not \(id)")
            }
            guard env.seq == expected else {
                throw RpcError(code: -32602, message: "seqs must be contiguous: got \(env.seq), expected \(expected)")
            }
            if env.seq == 1 {
                guard env.type == "session_created", env.object["mode"] as? String == "chat" else {
                    throw RpcError(code: -32602, message: #"a log-starting push must open with session_created mode:"chat""#)
                }
            }
            expected += 1
        }

        lock.withLock {
            logs[id, default: []].append(contentsOf: lines)
            lastPushMeta = metaObj
            if let metaObj = metaObj {
                // (title length + model bound + forkedFrom shape already refused above)
                var fork: SessionForkRef? = metas[id]?.forkedFrom
                if let f = metaObj["forkedFrom"] as? [String: Any], let sid = f["sessionId"] as? String, let at = (f["atSeq"] as? NSNumber)?.intValue {
                    fork = SessionForkRef(sessionId: sid, atSeq: at)
                }
                // T6, widened by the review's C6 ruling — THREE states for `effort`, mirroring
                // `applySyncMeta` (packages/core/src/sessions/store.ts) exactly:
                //   key absent → UNCHANGED,  NSNull → CLEAR,  String → set.
                // The double used to fold `NSNull` into "unchanged" via `as? String ?? existing`,
                // which would have made a clear look like a no-op here while the real daemon nulled
                // the column — a lenient double hiding the very state the ruling added.
                let effort: String?
                if let raw = metaObj["effort"] {
                    effort = raw is NSNull ? nil : (raw as? String)
                } else {
                    effort = metas[id]?.effort
                }
                metas[id] = (metaObj["title"] as? String ?? metas[id]?.title,
                             metaObj["model"] as? String ?? metas[id]?.model,
                             effort, fork)
            }
        }
        return try JSONSerialization.data(withJSONObject: ["applied": true, "lastSeq": head(id), "buffered": 0])
    }

    /// Whole-file paging over a stable sorted list, mirroring `syncMemory`'s index cursor.
    private func encodeMemory(_ p: [String: Any]) throws -> Data {
        memoryPages += 1
        let cursor = (p["cursor"] as? NSNumber)?.intValue ?? 0
        let size = memoryPageSize ?? max(memory.count, 1)
        let end = min(cursor + size, memory.count)
        let slice = cursor < end ? Array(memory[cursor..<end]) : []
        var out: [String: Any] = ["files": slice.map { ["name": $0.name, "content": $0.content] },
                                  "complete": end >= memory.count]
        if end < memory.count { out["nextCursor"] = end }
        return try JSONSerialization.data(withJSONObject: out)
    }
}

/// A `FakeDaemon` whose CREATING pushes can be made to fail — the network failure that used to leave
/// an orphaned local fork behind (review I1, third trigger).
final class FailingForkPushDaemon: FakeDaemon, @unchecked Sendable {
    var failCreatingPush = false

    override func call(method: String, paramsJSON: Data) async throws -> Data {
        if method == METHODS.syncPush, failCreatingPush,
           let p = (try? JSONSerialization.jsonObject(with: paramsJSON)) as? [String: Any],
           (p["baseSeq"] as? NSNumber)?.intValue == 0,
           let sid = p["sessionId"] as? String, !has(sid) {
            throw RpcError(code: -32603, message: "simulated network failure during the fork push")
        }
        return try await super.call(method: method, paramsJSON: paramsJSON)
    }
}

/// A `FakeDaemon` whose PULLS can be made to fail per session — the connection drop that leaves a
/// reconcile half-finished (PROBE4's step 2) and the per-session isolation probe (N-M2).
///
/// Selection is by OCCURRENCE, not by `fromSeq`: a reconcile issues TWO pulls for the same session at
/// the same `fromSeq` (first `reconcileDivergence`'s byte-compare, then — after the fork push lands —
/// the original's branch pull), so `fromSeq` cannot tell them apart. `failPullOccurrences[id] = [2]`
/// therefore fails exactly the branch pull while letting the compare and the fork push succeed.
final class FailingBranchPullDaemon: FakeDaemon, @unchecked Sendable {
    var failPullOccurrences: [String: Set<Int>] = [:]
    private var seen: [String: Int] = [:]

    override func call(method: String, paramsJSON: Data) async throws -> Data {
        if method == METHODS.syncPull,
           let p = (try? JSONSerialization.jsonObject(with: paramsJSON)) as? [String: Any],
           let sid = p["sessionId"] as? String {
            let n = (seen[sid] ?? 0) + 1
            seen[sid] = n
            if failPullOccurrences[sid]?.contains(n) == true {
                throw RpcError(code: -32603, message: "simulated connection drop during sync.pull #\(n)")
            }
        }
        return try await super.call(method: method, paramsJSON: paramsJSON)
    }
}

/// Records the base64 length of every push frame — the evidence for the chunk-ceiling clamp.
final class RecordingChunkDaemon: FakeDaemon, @unchecked Sendable {
    private(set) var base64Lengths: [Int] = []

    override func call(method: String, paramsJSON: Data) async throws -> Data {
        if method == METHODS.syncPush,
           let p = (try? JSONSerialization.jsonObject(with: paramsJSON)) as? [String: Any],
           let data = p["data"] as? String {
            base64Lengths.append(data.count)
        }
        return try await super.call(method: method, paramsJSON: paramsJSON)
    }
}
