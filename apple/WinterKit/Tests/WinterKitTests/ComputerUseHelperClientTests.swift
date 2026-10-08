import XCTest
@testable import WinterKit

/// `LiveComputerUseHelperClient` at the wire: what Winter.app sends the helper (an app-client `hello`,
/// `view.subscribe`, `view.unsubscribe`) and how it reads what comes back (the four view notifications).
/// A scripted transport stands in for the helper's socket; nothing here touches the real one.
final class ComputerUseHelperClientTests: XCTestCase {
    private func client(_ transport: ScriptedTransport, socketExists: Bool = true,
                        timeout: Duration = .seconds(2)) -> LiveComputerUseHelperClient {
        LiveComputerUseHelperClient(home: "/tmp/winter-test-home",
                                    socketExists: { _ in socketExists },
                                    makeTransport: { _ in transport },
                                    requestTimeout: timeout)
    }

    /// Connects and answers the hello. Returns once the client is ready for calls.
    private func connect(_ c: LiveComputerUseHelperClient, _ t: ScriptedTransport, result: String = #"{"protocol":1,"helperVersion":"0.1.0","pid":4242}"#) async throws {
        async let connected: Void = c.connect()
        let hello = try await waitForSent(t, count: 1)[0]
        t.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(hello)["id"] as! Int),"result":\#(result)}"#)
        try await connected
    }

    private func answer(_ t: ScriptedTransport, sentIndex: Int, result: String) async throws -> [String: Any] {
        let sent = try await waitForSent(t, count: sentIndex + 1)
        let request = decodeLine(sent[sentIndex])
        t.feed(#"{"jsonrpc":"2.0","id":\#(request["id"] as! Int),"result":\#(result)}"#)
        return request
    }

    // MARK: - Connecting

    func testAMissingSocketIsTheAnswerAndNothingIsOpened() async {
        let t = ScriptedTransport()
        let opened = OpenedFlag()
        let c = LiveComputerUseHelperClient(home: "/h", socketExists: { _ in false }, makeTransport: { _ in opened.set(); return t })
        do {
            try await c.connect()
            XCTFail("a missing socket must throw")
        } catch let error as HelperClientError {
            XCTAssertEqual(error, .socketMissing)
            XCTAssertFalse(error.isTerminal, "the helper simply is not running")
        } catch {
            XCTFail("\(error)")
        }
        XCTAssertFalse(opened.value, "no transport is even constructed — and nothing launches the helper")
        XCTAssertTrue(t.sent.isEmpty)
    }

    func testTheHelloIsAnAppClientWithTheHome() async throws {
        let t = ScriptedTransport()
        let c = client(t)
        try await connect(c, t)
        let hello = decodeLine(t.sent[0])
        XCTAssertEqual(hello["method"] as? String, "hello")
        let params = try XCTUnwrap(hello["params"] as? [String: Any])
        XCTAssertEqual(params["protocol"] as? Int, 1)
        XCTAssertEqual(params["client"] as? String, "app")
        XCTAssertEqual(params["home"] as? String, "/tmp/winter-test-home")
        XCTAssertEqual(HelperPaths.socketPath(home: "/h"), "/h/run/computer-use.sock")
    }

    func testAMismatchIsTerminalAndNotAllowedIsReported() async throws {
        for (code, expected) in [("protocol_mismatch", HelperClientError.protocolMismatch), ("home_mismatch", .homeMismatch)] {
            let t = ScriptedTransport()
            let c = client(t)
            async let connected: Void = c.connect()
            let hello = try await waitForSent(t, count: 1)[0]
            t.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(hello)["id"] as! Int),"error":{"code":-32000,"message":"no","data":{"code":"\#(code)"}}}"#)
            do {
                try await connected
                XCTFail("\(code) must throw")
            } catch let error as HelperClientError {
                XCTAssertEqual(error, expected)
                XCTAssertTrue(error.isTerminal)
            }
        }
        XCTAssertEqual(LiveComputerUseHelperClient.error(from: .object(["message": .string("only hello"), "data": .object(["code": .string("not_allowed")])])),
                       .notAllowed("only hello"))
        XCTAssertFalse(HelperClientError.notAllowed("x").isTerminal)
    }

    // MARK: - Calls

    func testSubscribeSendsTheSessionAndFlagsAndReadsTheBoundTargets() async throws {
        let t = ScriptedTransport()
        let c = client(t)
        try await connect(c, t)

        async let targets = c.subscribe(sessionId: "s_1", frames: true, maxFps: 10, maxWidth: 720)
        let request = try await answer(t, sentIndex: 1, result: """
        {"targets":[{"targetId":"t1","pid":501,"windowId":79,"appName":"Notes","bundleId":"com.apple.Notes","windowSize":[800,600]},
                    {"targetId":"t2","pid":502,"windowId":80,"appName":"Finder","bundleId":"com.apple.finder","windowSize":[640.5,480]},
                    {"nope":true}]}
        """.replacingOccurrences(of: "\n", with: ""))
        XCTAssertEqual(request["method"] as? String, "view.subscribe")
        let params = try XCTUnwrap(request["params"] as? [String: Any])
        XCTAssertEqual(params["sessionId"] as? String, "s_1")
        XCTAssertEqual(params["frames"] as? Bool, true)
        XCTAssertEqual(params["maxFps"] as? Int, 10)
        XCTAssertEqual(params["maxWidth"] as? Int, 720)

        let got = try await targets
        XCTAssertEqual(got.map(\.targetId), ["t1", "t2"], "a malformed target is dropped; the helper's order is kept")
        XCTAssertEqual(got[0], HelperTarget(targetId: "t1", pid: 501, windowId: 79, appName: "Notes", bundleId: "com.apple.Notes",
                                            windowSize: CGSize(width: 800, height: 600)))
        XCTAssertEqual(got[1].windowSize, CGSize(width: 640.5, height: 480))
    }

    func testSubscribeOmitsWhatItIsNotGivenAndUnsubscribeNamesTheSession() async throws {
        let t = ScriptedTransport()
        let c = client(t)
        try await connect(c, t)

        async let none = c.subscribe(sessionId: "s_2", frames: false)
        let request = try await answer(t, sentIndex: 1, result: #"{"targets":[]}"#)
        let params = try XCTUnwrap(request["params"] as? [String: Any])
        XCTAssertEqual(Set(params.keys), ["sessionId", "frames"])
        XCTAssertEqual(params["frames"] as? Bool, false)
        let empty = try await none
        XCTAssertTrue(empty.isEmpty)

        async let gone: Void = c.unsubscribe(sessionId: "s_2")
        let unsub = try await answer(t, sentIndex: 2, result: "{}")
        try await gone
        XCTAssertEqual(unsub["method"] as? String, "view.unsubscribe")
        XCTAssertEqual((unsub["params"] as? [String: Any])?["sessionId"] as? String, "s_2")
    }

    func testACallBeforeConnectingFailsTyped() async {
        let c = client(ScriptedTransport())
        do {
            _ = try await c.subscribe(sessionId: "s", frames: true)
            XCTFail("not connected")
        } catch let error as HelperClientError {
            XCTAssertEqual(error, .notConnected)
        } catch {
            XCTFail("\(error)")
        }
    }

    func testARequestTheHelperNeverAnswersTimesOut() async throws {
        let t = ScriptedTransport()
        let c = client(t, timeout: .milliseconds(80))
        try await connect(c, t)
        do {
            _ = try await c.subscribe(sessionId: "s", frames: true)
            XCTFail("must time out")
        } catch let error as HelperClientError {
            if case .rpc(let code, _) = error { XCTAssertEqual(code, -2) } else { XCTFail("\(error)") }
        }
    }

    // MARK: - Notifications

    private func nextEvent(_ c: LiveComputerUseHelperClient, _ iterator: inout AsyncStream<HelperViewEvent>.AsyncIterator) async -> HelperViewEvent? {
        await iterator.next()
    }

    func testTheFourNotificationsDecode() async throws {
        let t = ScriptedTransport()
        let c = client(t)
        try await connect(c, t)
        var it = c.events.makeAsyncIterator()

        t.feed(#"{"jsonrpc":"2.0","method":"view.bound","params":{"sessionId":"s_1","targetId":"t1","pid":501,"windowId":79,"appName":"Notes","bundleId":"com.apple.Notes","windowSize":[800,600]}}"#)
        guard case .bound(let sid, let target) = await it.next() else { return XCTFail("bound") }
        XCTAssertEqual(sid, "s_1")
        XCTAssertEqual(target.appName, "Notes")
        XCTAssertEqual(target.windowSize, CGSize(width: 800, height: 600))

        let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x01, 0x02, 0xFF, 0xD9])
        t.feed(#"{"jsonrpc":"2.0","method":"view.frame","params":{"sessionId":"s_1","targetId":"t1","seq":7,"jpeg":"\#(jpeg.base64EncodedString())","width":720,"height":540,"windowSize":[800,600]}}"#)
        guard case .frame(let frame) = await it.next() else { return XCTFail("frame") }
        XCTAssertEqual(frame, HelperFrame(sessionId: "s_1", targetId: "t1", seq: 7, jpeg: jpeg, width: 720, height: 540,
                                          windowSize: CGSize(width: 800, height: 600)))

        t.feed(#"{"jsonrpc":"2.0","method":"view.cursor","params":{"sessionId":"s_1","targetId":"t1","kind":"drag","point":[10,20],"dragTo":[110,220],"frame":[5,6,70,80],"text":"hi","count":2,"button":"left"}}"#)
        guard case .cursor(let cursor) = await it.next() else { return XCTFail("cursor") }
        XCTAssertEqual(cursor, HelperCursor(sessionId: "s_1", targetId: "t1", kind: "drag", point: CGPoint(x: 10, y: 20),
                                            dragTo: CGPoint(x: 110, y: 220), frame: CGRect(x: 5, y: 6, width: 70, height: 80),
                                            text: "hi", count: 2, button: "left"))

        t.feed(#"{"jsonrpc":"2.0","method":"view.cursor","params":{"sessionId":"s_1","targetId":"t1","kind":"move","point":[1,2]}}"#)
        guard case .cursor(let bare) = await it.next() else { return XCTFail("bare cursor") }
        XCTAssertNil(bare.dragTo)
        XCTAssertNil(bare.frame)
        XCTAssertNil(bare.text)

        t.feed(#"{"jsonrpc":"2.0","method":"view.released","params":{"sessionId":"s_1","targetId":"t1"}}"#)
        guard case .released(let rs, let rt) = await it.next() else { return XCTFail("released") }
        XCTAssertEqual([rs, rt], ["s_1", "t1"])
    }

    func testMalformedAndUnknownNotificationsAreIgnored() async throws {
        let t = ScriptedTransport()
        let c = client(t)
        try await connect(c, t)
        var it = c.events.makeAsyncIterator()
        t.feed("not json")
        t.feed(#"{"jsonrpc":"2.0","method":"view.frame","params":{"sessionId":"s","targetId":"t","jpeg":"!!!not base64!!!","width":1,"height":1,"windowSize":[1,1]}}"#)
        t.feed(#"{"jsonrpc":"2.0","method":"view.future","params":{"sessionId":"s"}}"#)
        t.feed(#"{"jsonrpc":"2.0","method":"view.released","params":{"sessionId":"s","targetId":"after"}}"#)
        guard case .released(_, let id) = await it.next() else { return XCTFail("the first event is the one valid line") }
        XCTAssertEqual(id, "after")
    }

    func testTheConnectionDroppingIsAnEventAndADeliberateCloseIsNot() async throws {
        let t = ScriptedTransport()
        let c = client(t)
        try await connect(c, t)
        var it = c.events.makeAsyncIterator()
        t.dropConnection()
        guard case .connectionLost = await it.next() else { return XCTFail("a lost connection must be said") }

        // A deliberate close says nothing: the next thing this client reports is what its NEXT
        // connection brings, not a stale "lost".
        let first = ScriptedTransport(), second = ScriptedTransport()
        let transports = TransportQueue([first, second])
        let c2 = LiveComputerUseHelperClient(home: "/h", socketExists: { _ in true }, makeTransport: { _ in transports.next() })
        try await connect(c2, first)
        await c2.disconnect()
        first.dropConnection()
        try await connect(c2, second)
        second.feed(#"{"jsonrpc":"2.0","method":"view.released","params":{"sessionId":"s","targetId":"x"}}"#)
        var it2 = c2.events.makeAsyncIterator()
        guard case .released(_, let id) = await it2.next() else { return XCTFail("the deliberate close must not have produced .connectionLost") }
        XCTAssertEqual(id, "x")
    }

    func testPendingCallsFailWhenTheConnectionDrops() async throws {
        let t = ScriptedTransport()
        let c = client(t)
        try await connect(c, t)
        async let call = c.subscribe(sessionId: "s", frames: true)
        _ = try await waitForSent(t, count: 2)
        t.dropConnection()
        do {
            _ = try await call
            XCTFail("the call must fail")
        } catch let error as HelperClientError {
            XCTAssertEqual(error, .notConnected)
        }
    }
}

private final class TransportQueue: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [ScriptedTransport]
    init(_ items: [ScriptedTransport]) { self.items = items }
    func next() -> ScriptedTransport { lock.lock(); defer { lock.unlock() }; return items.removeFirst() }
}

private final class OpenedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var _value = false
    var value: Bool { lock.lock(); defer { lock.unlock() }; return _value }
    func set() { lock.lock(); _value = true; lock.unlock() }
}

// MARK: - A consumer that is behind

extension ComputerUseHelperClientTests {
    private func frameLine(_ seq: Int, target: String = "t1", session: String = "s_1", padding: Int = 2_000) -> String {
        let jpeg = Data(repeating: UInt8(seq % 250), count: padding).base64EncodedString()
        return #"{"jsonrpc":"2.0","method":"view.frame","params":{"sessionId":"\#(session)","targetId":"\#(target)","seq":\#(seq),"jpeg":"\#(jpeg)","width":720,"height":540,"windowSize":[800,600]}}"#
    }

    private func connectedClient() async throws -> (LiveComputerUseHelperClient, ScriptedTransport) {
        let t = ScriptedTransport()
        let c = LiveComputerUseHelperClient(home: "/h", socketExists: { _ in true }, makeTransport: { _ in t })
        async let connected: Void = c.connect()
        let hello = try await waitForSent(t, count: 1)[0]
        t.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(hello)["id"] as! Int),"result":{}}"#)
        try await connected
        return (c, t)
    }

    private func settle(_ c: LiveComputerUseHelperClient, received: Int) async {
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline, await c.framesReceived < received { try? await Task.sleep(nanoseconds: 5_000_000) }
    }

    /// Two hundred frames arrive while nobody is reading: the consumer finds ONE — the newest.
    func testAConsumerThatIsBehindFindsOnlyTheNewestFrame() async throws {
        let (c, t) = try await connectedClient()
        for seq in 1...200 { t.feed(frameLine(seq)) }
        await settle(c, received: 200)
        var it = c.events.makeAsyncIterator()
        guard case .frame(let frame) = await it.next() else { return XCTFail("a frame") }
        XCTAssertEqual(frame.seq, 200, "the newest, not the oldest")
        t.feed(#"{"jsonrpc":"2.0","method":"view.released","params":{"sessionId":"s_1","targetId":"t1"}}"#)
        guard case .released = await it.next() else { return XCTFail("the next thing is the release, not 199 stale frames") }
    }

    /// Frames of different targets do not replace each other.
    func testEachTargetsNewestFrameIsKept() async throws {
        let (c, t) = try await connectedClient()
        for seq in 1...5 { t.feed(frameLine(seq, target: "a")); t.feed(frameLine(100 + seq, target: "b")) }
        await settle(c, received: 10)
        var it = c.events.makeAsyncIterator()
        var seen: [String: Int] = [:]
        for _ in 0..<2 {
            guard case .frame(let f) = await it.next() else { return XCTFail("frame") }
            seen[f.targetId] = f.seq
        }
        XCTAssertEqual(seen, ["a": 5, "b": 105])
    }

    /// In ONE read, a frame a later frame replaces is never even parsed — and the events between survive in order.
    func testASupersededFrameInOneReadIsNeverDecoded() async throws {
        let (c, t) = try await connectedClient()
        let lines = [
            #"{"jsonrpc":"2.0","method":"view.bound","params":{"sessionId":"s_1","targetId":"t1","pid":1,"windowId":2,"appName":"Notes","bundleId":"x","windowSize":[800,600]}}"#,
            frameLine(1), frameLine(2),
            #"{"jsonrpc":"2.0","method":"view.cursor","params":{"sessionId":"s_1","targetId":"t1","kind":"move","point":[1,2]}}"#,
            frameLine(3), frameLine(4),
        ]
        t.feed(lines.joined(separator: "\n"))
        await settle(c, received: 4)
        let decoded = await c.framesDecoded
        XCTAssertEqual(decoded, 1, "four frames received, one decoded")
        var it = c.events.makeAsyncIterator()
        guard case .bound = await it.next() else { return XCTFail("bound first") }
        guard case .cursor = await it.next() else { return XCTFail("then the cursor") }
        guard case .frame(let f) = await it.next() else { return XCTFail("then the newest frame") }
        XCTAssertEqual(f.seq, 4)
    }

    func testTheKeyOfAFrameLineIsReadFromTheRawBytes() {
        let key = LiveComputerUseHelperClient.frameKey(Data(frameLine(9, target: "tx", session: "sx").utf8))
        XCTAssertEqual(key, "sx|tx")
        XCTAssertNil(LiveComputerUseHelperClient.frameKey(Data(#"{"method":"view.cursor","params":{"sessionId":"s","targetId":"t"}}"#.utf8)))
        XCTAssertNil(LiveComputerUseHelperClient.frameKey(Data("garbage".utf8)))
        XCTAssertEqual(LiveComputerUseHelperClient.supersededFrameLines([Data(frameLine(1).utf8)]), [])
    }

    func testTheMailboxCancelsCleanly() async {
        let mailbox = HelperEventMailbox()
        let task = Task { await mailbox.next() }
        try? await Task.sleep(nanoseconds: 30_000_000)
        task.cancel()
        let result = await task.value
        XCTAssertNil(result, "a cancelled reader is released, not left waiting")
        mailbox.push(.connectionLost)
        XCTAssertEqual(mailbox.pendingCount, 1)
    }

    /// Numbers for the idle-CPU report: a hundred 80 KB frames through the client in random 1-16 KB reads
    /// with nobody consuming — how long the client takes, how many frames it parsed, how many wait for the
    /// consumer (one).
    func testBenchHundredEightyKilobyteFramesWithNoConsumer() async throws {
        let (c, t) = try await connectedClient()
        let lines = (1...100).map { frameLine($0, padding: 60 * 1024) } // ~80 KB of base64 each
        let data = Data((lines.joined(separator: "\n") + "\n").utf8)
        var pieces: [Data] = []
        var index = 0
        var seed: UInt64 = 11
        while index < data.count {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            let size = 1024 + Int(seed >> 33) % (15 * 1024)
            let end = min(index + size, data.count)
            pieces.append(data[index..<end])
            index = end
        }
        let started = DispatchTime.now().uptimeNanoseconds
        for piece in pieces { t.feedRaw(piece) }
        await settle(c, received: 100)
        let ms = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
        let received = await c.framesReceived, decoded = await c.framesDecoded
        var it = c.events.makeAsyncIterator()
        guard case .frame(let newest) = await it.next() else { return XCTFail("a frame") }
        print(String(format: "BENCH client: %d frames x ~80 KB (%d KB) in %d reads: %.0f ms; parsed %d; the consumer finds 1 (seq %d)",
                     received, data.count / 1024, pieces.count, ms, decoded, newest.seq))
        XCTAssertEqual(received, 100)
        XCTAssertEqual(newest.seq, 100)
        XCTAssertLessThanOrEqual(decoded, 100)
    }
}
