import Foundation
import XCTest
import NormaProtocol
@testable import NormaChatKit

/// `LocalEventStore` / `LocalChatSession` — the phone's own append-only chat log. Every test uses a
/// throwaway temp directory (never `~/.norma`); nothing here touches a network or a real model.
final class LocalEventStoreTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("norma-les-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    private func logURL(_ id: String) -> URL { dir.appendingPathComponent("\(id).jsonl") }
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    // MARK: - append / read / lastSeq

    func testCreateAppendReadAndLastSeq() async throws {
        let store = try LocalEventStore(directory: dir)
        let session = try await store.createSession(sessionId: "11111111-1111-4111-8111-111111111111", scope: "global")
        XCTAssertEqual(session.lastSeq, 1) // session_created is seq 1

        session.persist(.userMessage(.init(seq: 2, sessionId: session.sessionId, ts: 0, threadId: "main",
                                            text: "hi", clientName: "phone")))
        session.persist(.assistantMessage(.init(seq: 3, sessionId: session.sessionId, ts: 0, threadId: "main", text: "hello")))
        XCTAssertEqual(session.lastSeq, 3)

        let events = await store.read(sessionId: session.sessionId, fromSeq: 0)
        XCTAssertEqual(events.map { $0.type }, ["session_created", "user_message", "assistant_message"])
        XCTAssertEqual(events.map { $0.seq }, [1, 2, 3])
        // fromSeq is EXCLUSIVE, mirroring the daemon.
        let tail = await store.read(sessionId: session.sessionId, fromSeq: 2)
        XCTAssertEqual(tail.map { $0.type }, ["assistant_message"])
    }

    // MARK: - transient assistant_delta is never persisted

    func testAssistantDeltaIsNotPersistedAndDoesNotAdvanceTheHead() async throws {
        let store = try LocalEventStore(directory: dir)
        let s = try await store.createSession(sessionId: "22222222-2222-4222-8222-222222222222")
        s.persist(.userMessage(.init(seq: 2, sessionId: s.sessionId, ts: 0, threadId: "main", text: "q", clientName: "phone")))
        // A transient delta rides the head (seq == current head), and must not be stored.
        s.persist(.assistantDelta(.init(seq: 2, sessionId: s.sessionId, ts: 0, threadId: "main", delta: "par")))
        s.persist(.assistantMessage(.init(seq: 3, sessionId: s.sessionId, ts: 0, threadId: "main", text: "partial")))
        XCTAssertEqual(s.lastSeq, 3)
        let events = await store.read(sessionId: s.sessionId, fromSeq: 0)
        XCTAssertFalse(events.contains { $0.type == "assistant_delta" })
        XCTAssertEqual(events.map { $0.type }, ["session_created", "user_message", "assistant_message"])
    }

    // MARK: - torn-write recovery (mirrors SessionStore.recoverAll)

    func testTornFinalLineIsRecoveredOnOpenAndRewritten() async throws {
        let id = "33333333-3333-4333-8333-333333333333"
        // A crash mid-append: two good lines, then a partial (unterminated) JSON line.
        let good = """
        {"type":"session_created","sessionId":"\(id)","seq":1,"ts":1,"scope":"global","mode":"chat"}
        {"type":"user_message","sessionId":"\(id)","seq":2,"ts":2,"threadId":"main","text":"one","clientName":"phone"}
        {"type":"user_message","sessionId":"\(id)","seq":3,"ts":3,"threa
        """
        try Data(good.utf8).write(to: logURL(id))

        let store = try LocalEventStore(directory: dir)
        let recoveredHead = await store.lastSeq(sessionId: id)
        XCTAssertEqual(recoveredHead, 2, "torn line dropped, head is the last GOOD seq")
        // The file was rewritten with only good lines — the torn seq-3 tail does not survive, and
        // every surviving line is complete, parseable JSON.
        let onDisk = String(decoding: try Data(contentsOf: logURL(id)), as: UTF8.self)
        let lines = onDisk.split(separator: "\n")
        XCTAssertEqual(lines.count, 2)
        XCTAssertFalse(onDisk.contains("\"seq\":3"), "the torn seq-3 line was dropped")
        for line in lines {
            XCTAssertNotNil(try? JSONSerialization.jsonObject(with: Data(line.utf8)), "every surviving line parses")
        }
        // ...and appends continue cleanly from the recovered head.
        let s = await store.session(id)!
        s.persist(.assistantMessage(.init(seq: 3, sessionId: id, ts: 4, threadId: "main", text: "recovered")))
        XCTAssertEqual(s.lastSeq, 3)
    }

    func testACleanLogWithoutATrailingNewlineIsNotTreatedAsTorn() async throws {
        let id = "44444444-4444-4444-8444-444444444444"
        let clean = #"{"type":"session_created","sessionId":"\#(id)","seq":1,"ts":1,"scope":"global","mode":"chat"}"#
        try Data(clean.utf8).write(to: logURL(id)) // no trailing "\n"
        let store = try LocalEventStore(directory: dir)
        let head = await store.lastSeq(sessionId: id)
        XCTAssertEqual(head, 1)
    }

    // MARK: - lastSyncedSeq persistence

    func testLastSyncedSeqPersistsAcrossReopen() async throws {
        let id = "55555555-5555-4555-8555-555555555555"
        do {
            let store = try LocalEventStore(directory: dir)
            let s = try await store.createSession(sessionId: id)
            s.persist(.userMessage(.init(seq: 2, sessionId: id, ts: 0, threadId: "main", text: "x", clientName: "phone")))
            s.setLastSyncedSeq(2)
            s.setSyncedMeta(title: .some("A chat"), model: .some("gpt-5.4"))
            XCTAssertEqual(s.lastSyncedSeq, 2)
        }
        // A fresh store over the same directory recovers the watermark and meta from the sidecar.
        let reopened = try LocalEventStore(directory: dir)
        let synced = await reopened.lastSyncedSeq(sessionId: id)
        XCTAssertEqual(synced, 2)
        let metas = await reopened.sessions()
        XCTAssertEqual(metas.count, 1)
        XCTAssertEqual(metas[0].title, "A chat")
        XCTAssertEqual(metas[0].model, "gpt-5.4")
        XCTAssertEqual(metas[0].lastSeq, 2)
        XCTAssertEqual(metas[0].lastSyncedSeq, 2)
    }

    func testLastSyncedSeqIsClampedToTheHeadOnRecovery() async throws {
        // A sidecar that claims a watermark past the actual log head (e.g. a truncated log after a
        // partial write) must never claim to have synced bytes it no longer holds.
        let id = "66666666-6666-4666-8666-666666666666"
        let store = try LocalEventStore(directory: dir)
        let s = try await store.createSession(sessionId: id)
        s.setLastSyncedSeq(1)
        // Corrupt: bump the sidecar's watermark beyond the head by hand.
        let sidecar = dir.appendingPathComponent("\(id).meta.json")
        var obj = try JSONSerialization.jsonObject(with: Data(contentsOf: sidecar)) as! [String: Any]
        obj["lastSyncedSeq"] = 99
        try JSONSerialization.data(withJSONObject: obj).write(to: sidecar)

        let reopened = try LocalEventStore(directory: dir)
        let clamped = await reopened.lastSyncedSeq(sessionId: id)
        XCTAssertEqual(clamped, 1, "clamped to the real head")
    }

    // MARK: - priorInput fold (port of historyInput)

    func testPriorInputFoldsEveryProviderShapeInOrder() async throws {
        let id = "77777777-7777-4777-8777-777777777777"
        let store = try LocalEventStore(directory: dir)
        let s = try await store.createSession(sessionId: id)
        s.persist(.userMessage(.init(seq: 2, sessionId: id, ts: 0, threadId: "main", text: "search please", clientName: "phone")))
        s.persist(.toolCall(.init(seq: 3, sessionId: id, ts: 0, threadId: "main", callId: "c1", name: "Search", argsJson: #"{"query":"x"}"#)))
        s.persist(.toolResult(.init(seq: 4, sessionId: id, ts: 0, threadId: "main", callId: "c1", output: "results", isError: false)))
        s.persist(.assistantMessage(.init(seq: 5, sessionId: id, ts: 0, threadId: "main", text: "here you go")))

        let input = s.priorInput()
        // session_created / turn_* / question_* have no provider shape — only these four map.
        XCTAssertEqual(input.count, 4)
        guard case .message(.user, let u) = input[0] else { return XCTFail() }
        XCTAssertEqual(u, "search please")
        guard case .functionCall(let cid, let name, _) = input[1] else { return XCTFail() }
        XCTAssertEqual(cid, "c1"); XCTAssertEqual(name, "Search")
        guard case .toolResult(let rcid, let out, let isErr) = input[2] else { return XCTFail() }
        XCTAssertEqual(rcid, "c1"); XCTAssertEqual(out, "results"); XCTAssertFalse(isErr)
        guard case .message(.assistant, let a) = input[3] else { return XCTFail() }
        XCTAssertEqual(a, "here you go")
    }

    // MARK: - reasoning_item: opaque sink + verbatim replay (the T8 minor)

    func testAppendReasoningIsStoredAndReplayedVerbatimAndNeverRenders() async throws {
        let id = "88888888-8888-4888-8888-888888888888"
        let itemJSON = #"{"type":"reasoning","id":"rs_1","encrypted_content":"OPAQUE_SECRET_BLOB","summary":[]}"#
        let store = try LocalEventStore(directory: dir)
        let s = try await store.createSession(sessionId: id)
        s.persist(.userMessage(.init(seq: 2, sessionId: id, ts: 0, threadId: "main", text: "think", clientName: "phone")))
        s.appendReasoning(itemJSON: itemJSON, seq: 3, ts: 5)
        s.persist(.assistantMessage(.init(seq: 4, sessionId: id, ts: 0, threadId: "main", text: "done")))
        XCTAssertEqual(s.lastSeq, 4)

        // Replayed verbatim into the provider input for continuity...
        let input = s.priorInput()
        guard case .reasoning(let replayed) = input[1] else { return XCTFail("reasoning must replay between user and assistant") }
        XCTAssertEqual(replayed, itemJSON)

        // ...but the reasoning_item is NOT a decodable SessionEvent, so `read` keeps its bytes and a
        // renderer (which walks `.decoded`) skips it — the opaque blob never surfaces.
        let stored = await store.read(sessionId: id, fromSeq: 0)
        let reasoningRow = stored.first { $0.type == "reasoning_item" }
        XCTAssertNotNil(reasoningRow)
        XCTAssertNil(reasoningRow?.decoded, "reasoning_item has no SessionEvent variant — decoded is nil")
        XCTAssertTrue(String(decoding: reasoningRow!.raw, as: UTF8.self).contains("OPAQUE_SECRET_BLOB"))
    }

    // MARK: - end-to-end with the real ChatEngine (persist-on-emit + priorInput next turn)

    func testTwoRealEngineTurnsFoldFaithfullyWithNoDoubledUserMessage() async throws {
        let id = "99999999-9999-4999-8999-999999999999"
        let store = try LocalEventStore(directory: dir)
        let s = try await store.createSession(sessionId: id)
        let provider = ScriptedChatProvider([
            [.textDelta("first-reply"), .done(.endTurn)],
            [.textDelta("second-reply"), .done(.endTurn)],
        ])
        let clock = t0
        let engine = ChatEngine(provider: provider, now: { clock })
        let fetcher = PageFetcher(http: ScriptedChatHTTP(), cache: PageCache(), now: { clock })
        let tools = ChatToolset(http: ScriptedChatHTTP(), fetcher: fetcher)

        await engine.runTurn(session: s, userText: "one", model: "m", tools: tools, emit: s.emit)
        await engine.runTurn(session: s, userText: "two", model: "m", tools: tools, emit: s.emit)

        // The second turn's provider input is the turn-start snapshot: exactly one copy of each prior
        // message, in order, then the new user message appended by the engine itself.
        let secondInput = provider.request(1).input
        let userMsgs = secondInput.compactMap { if case .message(.user, let c) = $0 { return c } else { return nil } }
        XCTAssertEqual(userMsgs, ["one", "two"], "no doubled user message across the turn boundary")
        let asstMsgs = secondInput.compactMap { if case .message(.assistant, let c) = $0 { return c } else { return nil } }
        XCTAssertEqual(asstMsgs, ["first-reply"])

        // The store holds both turns, contiguous, deltas excluded.
        let stored = await store.read(sessionId: id, fromSeq: 0)
        XCTAssertEqual(stored.map { $0.seq }, Array(1...stored.count))
        XCTAssertFalse(stored.contains { $0.type == "assistant_delta" })
        XCTAssertEqual(stored.filter { $0.type == "user_message" }.count, 2)
        XCTAssertEqual(stored.filter { $0.type == "assistant_message" }.count, 2)
    }

    // MARK: - rawTail byte-identity

    func testRawTailReturnsVerbatimBytesPastFromSeq() async throws {
        let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        let store = try LocalEventStore(directory: dir)
        let s = try await store.createSession(sessionId: id)
        s.persist(.userMessage(.init(seq: 2, sessionId: id, ts: 0, threadId: "main", text: "a", clientName: "phone")))
        s.persist(.assistantMessage(.init(seq: 3, sessionId: id, ts: 0, threadId: "main", text: "b")))

        // rawTail(fromSeq: 1) is the on-disk bytes minus the seq-1 line — the exact bytes a push sends.
        let whole = try Data(contentsOf: logURL(id))
        let firstLineEnd = whole.firstIndex(of: 0x0A)!
        let expectedTail = whole.subdata(in: (firstLineEnd + 1)..<whole.count)
        let tail1 = await store.rawTail(sessionId: id, fromSeq: 1)
        XCTAssertEqual(tail1, expectedTail)
        let tail3 = await store.rawTail(sessionId: id, fromSeq: 3)
        XCTAssertEqual(tail3, Data(), "nothing past the head")
    }

    // MARK: - fork byte-identity modulo the id rewrite

    func testForkCopiesTheWholeLogRewritingOnlyTheId() async throws {
        let orig = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        let store = try LocalEventStore(directory: dir)
        let s = try await store.createSession(sessionId: orig)
        s.persist(.userMessage(.init(seq: 2, sessionId: orig, ts: 0, threadId: "main", text: "shared", clientName: "phone")))
        s.persist(.assistantMessage(.init(seq: 3, sessionId: orig, ts: 0, threadId: "main", text: "branch")))
        s.setSyncedMeta(title: .some("Original"), model: .some("gpt-5.4"))

        // plan (pure) → commit: a fork is only written locally once its push has landed (review I1).
        // The id is derived by planFork from the branch point AND content (review round 2).
        let plan = try await store.planFork(originalId: orig, atSeq: 1)
        let newId = plan.newId
        let planned = await store.sessions().count
        XCTAssertEqual(planned, 1, "planFork writes nothing — a failed push can leave no orphan")
        let forkMeta = try await store.commitFork(plan, syncedSeq: 0)

        // Both sessions exist; the fork's log equals the original's, byte-for-byte, with only the
        // sessionId FIELD swapped (the expectation built independently of the SUT's rewriter).
        let sessionCount = await store.sessions().count
        XCTAssertEqual(sessionCount, 2)
        let origBytes = String(decoding: try Data(contentsOf: logURL(orig)), as: UTF8.self)
        let forkBytes = String(decoding: try Data(contentsOf: logURL(newId)), as: UTF8.self)
        XCTAssertEqual(forkBytes, origBytes.replacingOccurrences(of: "\"sessionId\":\"\(orig)\"",
                                                                 with: "\"sessionId\":\"\(newId)\""))
        XCTAssertFalse(forkBytes.contains(orig))
        // Seqs are preserved; provenance + a marked title are stamped.
        let forkHead = await store.lastSeq(sessionId: newId)
        XCTAssertEqual(forkHead, 3)
        XCTAssertEqual(forkMeta.forkedFrom, SessionForkRef(sessionId: orig, atSeq: 1))
        XCTAssertEqual(forkMeta.title, "Original" + LocalEventStore.forkTitleSuffix)
        XCTAssertEqual(forkMeta.model, "gpt-5.4")
    }

    // MARK: - C1: applyPull's watermark is the head it APPLIED, isolated from the SyncClient

    func testApplyPullRecordsTheHeadItActuallyAppliedNotWhatTheCallerExpected() async throws {
        // The store-level half of C1, with no SyncClient (and so no divergence-check safety net) in
        // the way: a pull that carries MORE than the caller's `sync.heads` snapshot advertised — a Mac
        // append landing inside the pull window — must record the applied head. Recording the stale
        // snapshot leaves lastSyncedSeq < lastSeq over daemon-authored bytes, which is what made the
        // next push DIVERGE and mint an "(offline copy)" on every pass.
        let id = "e5000000-0000-4000-8000-000000000001"
        let store = try LocalEventStore(directory: dir)
        var lines = Data()
        for (seq, obj) in [
            (1, ["type": "session_created", "sessionId": id, "seq": 1, "ts": 1, "scope": "global", "mode": "chat"] as [String: Any]),
            (2, ["type": "assistant_message", "sessionId": id, "seq": 2, "ts": 2, "threadId": "main", "text": "a"]),
            (3, ["type": "assistant_message", "sessionId": id, "seq": 3, "ts": 3, "threadId": "main", "text": "b"]),
            // seq 4 — appended by the Mac AFTER heads reported lastSeq 3, still served by this pull.
            (4, ["type": "assistant_message", "sessionId": id, "seq": 4, "ts": 4, "threadId": "main", "text": "raced-in"]),
        ] {
            _ = seq
            lines.append(try JSONSerialization.data(withJSONObject: obj))
            lines.append(0x0A)
        }

        let applied = try await store.applyPull(sessionId: id, data: lines, title: .some("Raced"),
                                                model: .some(nil), forkedFrom: .some(nil))
        XCTAssertEqual(applied, 4)
        let head = await store.lastSeq(sessionId: id)
        let synced = await store.lastSyncedSeq(sessionId: id)
        XCTAssertEqual(head, 4)
        XCTAssertEqual(synced, 4, "the watermark is the applied head — never a caller-supplied snapshot")
        XCTAssertEqual(synced, head, "a pull can never leave the session looking locally-ahead")
    }

    // MARK: - I3: the fork rewrite is scoped to the sessionId FIELD, never event content

    func testForkNeverRewritesASessionIdQUOTEDInMessageContent() async throws {
        let orig = "e0000000-0000-4000-8000-000000000003"
        let store = try LocalEventStore(directory: dir)
        let s = try await store.createSession(sessionId: orig)
        // The user legitimately types the session id into a message — and after a fork+reconcile the
        // fork is the ONLY surviving copy of this conversation, so a silent edit here is unrecoverable.
        let typed = "why is session \(orig) stuck?"
        s.persist(.userMessage(.init(seq: 2, sessionId: orig, ts: 2, threadId: "main", text: typed, clientName: "phone")))

        let plan = try await store.planFork(originalId: orig, atSeq: 1)
        let newId = plan.newId
        try await store.commitFork(plan, syncedSeq: 0)

        let forkEvents = await store.read(sessionId: newId, fromSeq: 0)
        let forkedText = forkEvents.compactMap { ev -> String? in
            if case .userMessage(let v) = ev.decoded { return v.text } else { return nil }
        }.first
        XCTAssertEqual(forkedText, typed, "the user's own words must survive the fork untouched")
        // ...while every envelope really did move to the new id.
        XCTAssertTrue(forkEvents.allSatisfy { $0.sessionId == newId })
        XCTAssertEqual(forkEvents.map { $0.seq }, [1, 2])
    }

    func testForkRewritesTheEnvelopeFieldOnEveryLine() async throws {
        let orig = "e1000000-0000-4000-8000-000000000001"
        let store = try LocalEventStore(directory: dir)
        let s = try await store.createSession(sessionId: orig)
        s.persist(.userMessage(.init(seq: 2, sessionId: orig, ts: 2, threadId: "main", text: "hi", clientName: "phone")))
        s.appendReasoning(itemJSON: #"{"type":"reasoning","encrypted_content":"BLOB"}"#, seq: 3, ts: 3)

        let plan = try await store.planFork(originalId: orig, atSeq: 2)
        let newId = plan.newId
        try await store.commitFork(plan, syncedSeq: 0)

        // Every line — including the reasoning_item, which has no Swift variant — carries the new id.
        let lines = String(decoding: try Data(contentsOf: logURL(newId)), as: UTF8.self)
            .split(separator: "\n").map(String.init)
        XCTAssertEqual(lines.count, 3)
        for line in lines {
            let obj = try JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
            XCTAssertEqual(obj["sessionId"] as? String, newId)
        }
        XCTAssertTrue(lines.contains { $0.contains("BLOB") }, "the opaque payload is copied verbatim")
    }

    // MARK: - I2: a rewrite is an ATOMIC REPLACE — the log is never absent mid-write

    func testAtomicWriteReplacesInOneStepAndNeverLeavesTheTargetMissing() throws {
        let url = dir.appendingPathComponent("atomic.jsonl")
        try Data("old-content\n".utf8).write(to: url)

        // Poll the path from another thread across many replaces: the file must ALWAYS exist and
        // always be one complete version — never the "unlinked" window the old removeItem+moveItem
        // spelling opened, in which a kill would have destroyed the log outright.
        let stop = NSLock()
        var stopped = false
        var sawMissing = false
        var sawPartial = false
        let watcher = Thread {
            while true {
                if stop.withLock({ stopped }) { break }
                if !FileManager.default.fileExists(atPath: url.path) { stop.withLock { sawMissing = true } }
                else if let d = try? Data(contentsOf: url) {
                    let text = String(decoding: d, as: UTF8.self)
                    if text != "old-content\n" && !text.hasPrefix("new-") { stop.withLock { sawPartial = true } }
                }
            }
        }
        watcher.start()
        for i in 0..<300 { LocalChatSession.atomicWrite(Data("new-\(i)-content\n".utf8), to: url) }
        stop.withLock { stopped = true }
        Thread.sleep(forTimeInterval: 0.05)

        XCTAssertFalse(sawMissing, "an atomic replace never unlinks the destination first")
        XCTAssertFalse(sawPartial, "a reader only ever sees a complete version")
        XCTAssertTrue(String(decoding: try Data(contentsOf: url), as: UTF8.self).hasPrefix("new-"))
    }

    // MARK: - M1/M2/M9: the remaining fold + metadata parity items

    func testPriorInputSkipsNonMainThreadEvents() async throws {
        // engine.ts:1389's filter. Unreachable from the phone's own engine, but sync.push accepts any
        // valid SessionEvent from any paired client, so a thread-scoped event CAN land here.
        let id = "e2000000-0000-4000-8000-000000000001"
        let store = try LocalEventStore(directory: dir)
        let s = try await store.createSession(sessionId: id)
        s.persist(.userMessage(.init(seq: 2, sessionId: id, ts: 2, threadId: "main", text: "main-thread", clientName: "phone")))
        s.persist(.assistantMessage(.init(seq: 3, sessionId: id, ts: 3, threadId: "child-7", text: "a child thread's own reply")))

        let texts = s.priorInput().compactMap { if case .message(_, let c) = $0 { return c } else { return nil } }
        XCTAssertEqual(texts, ["main-thread"], "a child thread's events never enter the main context")
    }

    func testNormalizeReplayOrderDefersAMessageFoundInsideAToolPair() {
        // The real reordering path (a steer landing between a call and its result), not just the no-op.
        let input: [ProviderInputItem] = [
            .functionCall(callId: "c1", name: "Search", argumentsJSON: "{}"),
            .message(role: .user, content: "steered mid-pair"),
            .toolResult(callId: "c1", output: "results", isError: false),
            .message(role: .assistant, content: "after"),
        ]
        let out = LocalChatSession.normalizeReplayOrder(input)
        // The message defers to immediately AFTER its pair's result — mirroring what the provider saw.
        guard case .functionCall = out[0] else { return XCTFail() }
        guard case .toolResult = out[1] else { return XCTFail("the result must follow its call directly") }
        guard case .message(_, let deferred) = out[2] else { return XCTFail() }
        XCTAssertEqual(deferred, "steered mid-pair")
        guard case .message(_, let last) = out[3] else { return XCTFail() }
        XCTAssertEqual(last, "after")
    }

    func testTaskNotificationReplaysAsAUserMessage() async throws {
        let id = "e2000000-0000-4000-8000-000000000002"
        let store = try LocalEventStore(directory: dir)
        _ = try await store.createSession(sessionId: id)
        // task_notification has no Swift SessionEvent variant either — write the raw line.
        let line = try JSONSerialization.data(withJSONObject: [
            "type": "task_notification", "sessionId": id, "seq": 2, "ts": 2,
            "threadId": "main", "content": "a detached agent finished",
        ])
        LocalChatSession.appendLine(line, to: logURL(id))
        let reopened = try LocalEventStore(directory: dir)
        let s = await reopened.session(id)!

        let items = s.priorInput()
        XCTAssertEqual(items.count, 1)
        guard case .message(.user, let content) = items[0] else { return XCTFail("replays as a user-role message") }
        XCTAssertEqual(content, "a detached agent finished")
    }

    func testScopeIsDerivedFromTheLogNotLatchedBeforeItExists() async throws {
        let id = "e3000000-0000-4000-8000-000000000001"
        let store = try LocalEventStore(directory: dir)
        _ = try await store.createSession(sessionId: id, scope: "project-alpha", model: "gpt-5.4")

        // The SAME store must already report the real scope — the handle is built before the
        // session_created line is written, so a latched-in-init scope would read "global" here and
        // then be persisted into the sidecar permanently.
        let metas = await store.sessions()
        XCTAssertEqual(metas[0].scope, "project-alpha")
        // ...and it survives a reopen (the sidecar did not freeze the wrong value).
        let reopened = try LocalEventStore(directory: dir)
        let after = await reopened.sessions()
        XCTAssertEqual(after[0].scope, "project-alpha")
    }

    func testAStaleReasoningSeqIsRejectedRatherThanWrittenOutOfOrder() async throws {
        // The log is folded in FILE order, so a non-advancing seq must never be appended (M7).
        let id = "e4000000-0000-4000-8000-000000000001"
        let store = try LocalEventStore(directory: dir)
        let s = try await store.createSession(sessionId: id)
        s.persist(.assistantMessage(.init(seq: 2, sessionId: id, ts: 2, threadId: "main", text: "current")))
        s.appendReasoning(itemJSON: #"{"stale":true}"#, seq: 1, ts: 1) // behind the head — dropped
        XCTAssertEqual(s.lastSeq, 2)
        let stored = await store.read(sessionId: id, fromSeq: 0)
        XCTAssertEqual(stored.map { $0.seq }, [1, 2], "seq order still equals file order")
        XCTAssertFalse(stored.contains { $0.type == "reasoning_item" })
    }

    // MARK: - truncate

    func testTruncateDropsTheTailAboveSeq() async throws {
        let id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
        let store = try LocalEventStore(directory: dir)
        let s = try await store.createSession(sessionId: id)
        s.persist(.userMessage(.init(seq: 2, sessionId: id, ts: 0, threadId: "main", text: "keep", clientName: "phone")))
        s.persist(.assistantMessage(.init(seq: 3, sessionId: id, ts: 0, threadId: "main", text: "drop")))
        await store.truncate(sessionId: id, toSeq: 2)
        let headAfter = await store.lastSeq(sessionId: id)
        XCTAssertEqual(headAfter, 2)
        let seqs = await store.read(sessionId: id, fromSeq: 0).map { $0.seq }
        XCTAssertEqual(seqs, [1, 2])
    }
}
