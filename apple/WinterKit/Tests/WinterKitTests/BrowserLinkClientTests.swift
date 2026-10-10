import XCTest
import WinterProtocol
@testable import WinterKit

// MARK: - A scripted daemon

/// A transport that plays the daemon's side of the browser link: it answers `protocol.hello`, answers
/// `browserLink.attach` as the test scripts it, answers every `browserLink.result`/`events`/`tabGone`
/// with `{}`, and records everything the client sent. The test injects commands with `feed`.
final class FakeLinkDaemon: WinterTransport, SentLineRecording, @unchecked Sendable {
    enum AttachAnswer {
        case link(String, protocolVersion: Int = 1)
        case methodNotFound
        case protocolMismatch
    }

    let incoming: AsyncStream<TransportEvent>
    private let cont: AsyncStream<TransportEvent>.Continuation
    private let lock = NSLock()
    private var _sent: [String] = []
    private let attachAnswer: AttachAnswer

    var sent: [String] { lock.withLock { _sent } }

    init(attach: AttachAnswer) {
        attachAnswer = attach
        var c: AsyncStream<TransportEvent>.Continuation!
        incoming = AsyncStream { c = $0 }
        cont = c
    }

    func open() async throws {}

    func send(_ data: Data) async throws {
        let line = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .newlines)
        lock.withLock { _sent.append(line) }
        let message = decodeLine(line)
        guard let id = message["id"] as? Int, let method = message["method"] as? String else { return }
        switch method {
        case "protocol.hello":
            feed(#"{"jsonrpc":"2.0","id":\#(id),"result":{"ok":true}}"#)
        case BrowserLinkProtocol.Method.attach:
            switch attachAnswer {
            case .link(let linkId, let version):
                feed(#"{"jsonrpc":"2.0","id":\#(id),"result":{"linkId":"\#(linkId)","protocol":\#(version)}}"#)
            case .methodNotFound:
                feed(#"{"jsonrpc":"2.0","id":\#(id),"error":{"code":-32601,"message":"method not found"}}"#)
            case .protocolMismatch:
                feed(#"{"jsonrpc":"2.0","id":\#(id),"error":{"code":-32602,"message":"protocol","data":{"code":"protocol_mismatch","expected":2}}}"#)
            }
        default:
            feed(#"{"jsonrpc":"2.0","id":\#(id),"result":{}}"#)
        }
    }

    func close() { cont.finish() }
    func feed(_ line: String) { cont.yield(.data(Data((line + "\n").utf8))) }
    func drop() { cont.yield(.closed(nil)) }

    func command(linkId: String, cmdId: String, op: String, params: String = "{}") {
        feed(#"{"jsonrpc":"2.0","method":"browserLink.command","params":{"linkId":"\#(linkId)","cmdId":"\#(cmdId)","op":"\#(op)","params":\#(params)}}"#)
    }

    /// Every request the client sent with `method`, decoded.
    func requests(_ method: String) -> [[String: Any]] {
        sent.map(decodeLine).filter { $0["method"] as? String == method }
    }

    /// Every sent line's method, in order (handy for ordering assertions).
    var methods: [String] { sent.map(decodeLine).compactMap { $0["method"] as? String } }
}

// MARK: - A recording handler

@MainActor
final class FakeLinkHandler: BrowserLinkHandler {
    var attached: [String] = []
    var lost = 0
    var commands: [BrowserLinkCommand] = []
    /// What to answer each command with; `nil` keeps the replier in `held` for the test to use.
    var answer: (BrowserLinkCommand) -> BrowserLinkReply? = { _ in .empty }
    var held: [BrowserLinkReplier] = []

    func browserLinkAttached(linkId: String) { attached.append(linkId) }
    func browserLinkLost() { lost += 1 }
    func browserLinkCommand(_ command: BrowserLinkCommand, reply: BrowserLinkReplier) {
        commands.append(command)
        if let answer = answer(command) { reply(answer) } else { held.append(reply) }
    }
}

/// Polls until `condition` holds (the link runs on its own tasks).
func eventually(_ what: String, timeout: TimeInterval = 3, _ condition: () async -> Bool) async {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if await condition() { return }
        try? await Task.sleep(nanoseconds: 10_000_000)
    }
    XCTFail("timed out waiting for \(what)")
}

// MARK: - Tests

@MainActor
final class BrowserLinkClientTests: XCTestCase {

    /// Hands out the given daemons in order, one per connection attempt, then fresh ones from `make`
    /// (a closed transport cannot be dialled twice), and counts the attempts.
    final class Daemons: @unchecked Sendable {
        private let lock = NSLock()
        private var queue: [FakeLinkDaemon]
        private let make: () -> FakeLinkDaemon
        private var _all: [FakeLinkDaemon] = []
        init(_ daemons: [FakeLinkDaemon], then make: @escaping () -> FakeLinkDaemon = { FakeLinkDaemon(attach: .link("LZ")) }) {
            queue = daemons
            self.make = make
        }
        func next() -> FakeLinkDaemon {
            lock.withLock {
                let daemon = queue.isEmpty ? make() : queue.removeFirst()
                _all.append(daemon)
                return daemon
            }
        }
        var all: [FakeLinkDaemon] { lock.withLock { _all } }
        var attemptCount: Int { all.count }
    }

    private var links: [BrowserLinkClient] = []

    override func tearDown() async throws {
        for link in links { link.stop() }
        links = []
    }

    private func makeLink(_ daemons: Daemons, handler: FakeLinkHandler,
                          configure: (inout BrowserLinkClient.Configuration) -> Void = { _ in }) -> BrowserLinkClient {
        var configuration = BrowserLinkClient.Configuration(appVersion: "9.9.9", pid: 4242)
        configuration.sleep = { _ in try? await Task.sleep(nanoseconds: 5_000_000) }
        configure(&configuration)
        let link = BrowserLinkClient(configuration: configuration, makeClient: { _ in
            let daemon = daemons.next()
            return WinterClient(makeTransport: { daemon }, token: "tok-link", clientName: BrowserLinkProtocol.clientName)
        }, handler: handler)
        links.append(link)
        return link
    }

    func testTheHandshakeIsAHarnessHelloThenAnAttach() async throws {
        let daemon = FakeLinkDaemon(attach: .link("L1"))
        let handler = FakeLinkHandler()
        let link = makeLink(Daemons([daemon]), handler: handler)
        link.start()
        await eventually("attached") { handler.attached == ["L1"] }

        let lines = daemon.sent.map(decodeLine)
        XCTAssertEqual(lines.first?["method"] as? String, "protocol.hello")
        let hello = lines.first?["params"] as? [String: Any]
        XCTAssertEqual(hello?["role"] as? String, "harness")
        XCTAssertEqual(hello?["clientName"] as? String, "browser-link")
        XCTAssertEqual(hello?["token"] as? String, "tok-link")
        let attach = daemon.requests("browserLink.attach").first?["params"] as? [String: Any]
        XCTAssertEqual(attach?["protocol"] as? Int, 1)
        XCTAssertEqual(attach?["appVersion"] as? String, "9.9.9")
        XCTAssertEqual(attach?["pid"] as? Int, 4242)
        XCTAssertEqual(link.linkId, "L1")
        // Never a session attach on this connection.
        XCTAssertFalse(daemon.methods.contains("hub.attach"))
        XCTAssertFalse(daemon.methods.contains { $0.hasPrefix("session.") })
    }

    func testACommandReachesTheHandlerAndItsAnswerIsOneResult() async throws {
        let daemon = FakeLinkDaemon(attach: .link("L1"))
        let handler = FakeLinkHandler()
        handler.answer = { _ in .ok(.object(["tabs": .array([])])) }
        makeLink(Daemons([daemon]), handler: handler).start()
        await eventually("attached") { handler.attached == ["L1"] }

        daemon.command(linkId: "L1", cmdId: "c1", op: "tabs.live")
        await eventually("a result") { !daemon.requests("browserLink.result").isEmpty }
        XCTAssertEqual(handler.commands, [BrowserLinkCommand(linkId: "L1", cmdId: "c1", op: .tabsLive)])
        let result = try XCTUnwrap(daemon.requests("browserLink.result").first?["params"] as? [String: Any])
        XCTAssertEqual(result["linkId"] as? String, "L1")
        XCTAssertEqual(result["cmdId"] as? String, "c1")
        XCTAssertEqual(result["ok"] as? Bool, true)
        XCTAssertEqual((result["result"] as? [String: Any])?["tabs"] as? [String], [])
    }

    func testCommandsReachTheHandlerInTheOrderTheyWereSent() async throws {
        let daemon = FakeLinkDaemon(attach: .link("L1"))
        let handler = FakeLinkHandler()
        makeLink(Daemons([daemon]), handler: handler).start()
        await eventually("attached") { handler.attached == ["L1"] }

        for i in 0..<40 {
            daemon.command(linkId: "L1", cmdId: "c\(i)", op: "cdp.send",
                           params: #"{"tabId":"t1","method":"Input.dispatchMouseEvent","params":{"n":\#(i)}}"#)
        }
        await eventually("40 commands") { handler.commands.count == 40 }
        XCTAssertEqual(handler.commands.map(\.cmdId), (0..<40).map { "c\($0)" })
        await eventually("40 results") { daemon.requests("browserLink.result").count == 40 }
    }

    func testAnUnreadableCommandIsAnsweredNotAllowedAndNeverReachesTheHandler() async throws {
        let daemon = FakeLinkDaemon(attach: .link("L1"))
        let handler = FakeLinkHandler()
        makeLink(Daemons([daemon]), handler: handler).start()
        await eventually("attached") { handler.attached == ["L1"] }

        daemon.command(linkId: "L1", cmdId: "c9", op: "tab.teleport")
        daemon.command(linkId: "L1", cmdId: "c10", op: "cdp.send", params: #"{"tabId":"t1"}"#)
        await eventually("two failures") { daemon.requests("browserLink.result").count == 2 }
        XCTAssertTrue(handler.commands.isEmpty)
        for request in daemon.requests("browserLink.result") {
            let params = request["params"] as? [String: Any]
            XCTAssertEqual(params?["ok"] as? Bool, false)
            XCTAssertEqual((params?["error"] as? [String: Any])?["code"] as? String, "not_allowed")
        }
    }

    func testACommandForAnotherLinkIsIgnored() async throws {
        let daemon = FakeLinkDaemon(attach: .link("L1"))
        let handler = FakeLinkHandler()
        makeLink(Daemons([daemon]), handler: handler).start()
        await eventually("attached") { handler.attached == ["L1"] }
        daemon.command(linkId: "OTHER", cmdId: "c1", op: "tabs.live")
        daemon.command(linkId: "L1", cmdId: "c2", op: "tabs.live")
        await eventually("one command") { handler.commands.count == 1 }
        XCTAssertEqual(handler.commands.first?.cmdId, "c2")
    }

    func testEventsLeaveInBatchesOfAtMost256() async throws {
        let daemon = FakeLinkDaemon(attach: .link("L1"))
        let handler = FakeLinkHandler()
        let link = makeLink(Daemons([daemon]), handler: handler)
        link.start()
        await eventually("attached") { handler.attached == ["L1"] }

        for i in 0..<300 {
            link.emitEvent(tabId: "t1", method: "Page.lifecycleEvent", params: Data(#"{"name":"n\#(i)"}"#.utf8),
                           cdpSessionId: nil, stripNetworkParams: false)
        }
        await eventually("two batches") {
            daemon.requests("browserLink.events").reduce(0) { $0 + ((($1["params"] as? [String: Any])?["events"] as? [Any])?.count ?? 0) } == 300
        }
        let batches = daemon.requests("browserLink.events").map { (($0["params"] as? [String: Any])?["events"] as? [[String: Any]]) ?? [] }
        XCTAssertEqual(batches.count, 2)
        XCTAssertEqual(batches.first?.count, 256)
        XCTAssertEqual(batches.last?.count, 44)
        let first = try XCTUnwrap(batches.first?.first)
        XCTAssertEqual(first["tabId"] as? String, "t1")
        XCTAssertEqual(first["method"] as? String, "Page.lifecycleEvent")
        XCTAssertEqual((first["params"] as? [String: Any])?["name"] as? String, "n0")
        XCTAssertNil(first["cdpSessionId"])
        // In order across the two batches.
        let names = batches.flatMap { $0 }.compactMap { ($0["params"] as? [String: Any])?["name"] as? String }
        XCTAssertEqual(names, (0..<300).map { "n\($0)" })
    }

    func testAFewEventsLeaveWithinTheFlushWindow() async throws {
        let daemon = FakeLinkDaemon(attach: .link("L1"))
        let handler = FakeLinkHandler()
        let link = makeLink(Daemons([daemon]), handler: handler) { config in
            config.sleep = { duration in try? await Task.sleep(for: duration) }
        }
        link.start()
        await eventually("attached") { handler.attached == ["L1"] }

        let start = Date()
        for i in 0..<3 {
            link.emitEvent(tabId: "t1", method: "Page.frameNavigated", params: Data(#"{"i":\#(i)}"#.utf8),
                           cdpSessionId: "S\(i)", stripNetworkParams: false)
        }
        await eventually("one batch") { daemon.requests("browserLink.events").count == 1 }
        XCTAssertLessThan(Date().timeIntervalSince(start), 1.0, "a batch waits ~50 ms, never long")
        let events = ((daemon.requests("browserLink.events").first?["params"] as? [String: Any])?["events"] as? [[String: Any]]) ?? []
        XCTAssertEqual(events.compactMap { $0["cdpSessionId"] as? String }, ["S0", "S1", "S2"], "one batch, in order")
    }

    func testEventsBeforeAResultLeaveBeforeIt() async throws {
        let daemon = FakeLinkDaemon(attach: .link("L1"))
        let handler = FakeLinkHandler()
        handler.answer = { _ in nil }
        // A long window: if ordering relied on the timer, the result would overtake the events.
        let link = makeLink(Daemons([daemon]), handler: handler) { config in
            config.flushWindow = .seconds(10)
            config.sleep = { duration in try? await Task.sleep(for: duration) }
        }
        link.start()
        await eventually("attached") { handler.attached == ["L1"] }
        daemon.command(linkId: "L1", cmdId: "c1", op: "tabs.live")
        await eventually("held replier") { handler.held.count == 1 }

        link.emitEvent(tabId: "t1", method: "Page.frameNavigated", params: Data("{}".utf8), cdpSessionId: nil,
                       stripNetworkParams: false)
        link.emitEvent(tabId: "t1", method: "Page.loadEventFired", params: Data("{}".utf8), cdpSessionId: nil,
                       stripNetworkParams: false)
        handler.held[0](.empty)

        await eventually("events then result") { daemon.methods.contains("browserLink.result") }
        let order = daemon.methods.filter { $0 == "browserLink.events" || $0 == "browserLink.result" }
        XCTAssertEqual(order, ["browserLink.events", "browserLink.result"])
    }

    func testNetworkEventParamsLeaveStripped() async throws {
        let daemon = FakeLinkDaemon(attach: .link("L1"))
        let handler = FakeLinkHandler()
        let link = makeLink(Daemons([daemon]), handler: handler)
        link.start()
        await eventually("attached") { handler.attached == ["L1"] }
        let full = #"{"requestId":"r1","timestamp":1.5,"type":"XHR","request":{"url":"https://x/?t=secret","headers":{"Authorization":"Bearer z"}}}"#
        link.emitEvent(tabId: "t1", method: "Network.requestWillBeSent", params: Data(full.utf8), cdpSessionId: nil,
                       stripNetworkParams: true)
        await eventually("a batch") { !daemon.requests("browserLink.events").isEmpty }
        let line = try XCTUnwrap(daemon.sent.first { $0.contains("browserLink.events") })
        XCTAssertFalse(line.contains("secret"))
        XCTAssertFalse(line.contains("Authorization"))
        let params = (((decodeLine(line)["params"] as? [String: Any])?["events"] as? [[String: Any]])?.first?["params"]) as? [String: Any]
        XCTAssertEqual(Set(params.map { Array($0.keys) } ?? []), ["requestId", "timestamp", "type"])
    }

    func testATabGoneIsReported() async throws {
        let daemon = FakeLinkDaemon(attach: .link("L1"))
        let handler = FakeLinkHandler()
        let link = makeLink(Daemons([daemon]), handler: handler)
        link.start()
        await eventually("attached") { handler.attached == ["L1"] }
        link.tabGone(tabId: "t7", reason: .crashed)
        await eventually("tabGone") { !daemon.requests("browserLink.tabGone").isEmpty }
        let params = daemon.requests("browserLink.tabGone").first?["params"] as? [String: Any]
        XCTAssertEqual(params?["linkId"] as? String, "L1")
        XCTAssertEqual(params?["tabId"] as? String, "t7")
        XCTAssertEqual(params?["reason"] as? String, "crashed")
    }

    func testADroppedConnectionLosesTheLinkAndReattachesFresh() async throws {
        let first = FakeLinkDaemon(attach: .link("L1"))
        let second = FakeLinkDaemon(attach: .link("L2"))
        let handler = FakeLinkHandler()
        let link = makeLink(Daemons([first, second]), handler: handler)
        link.start()
        await eventually("attached") { handler.attached == ["L1"] }

        first.drop()
        await eventually("lost then re-attached") { handler.lost == 1 && handler.attached == ["L1", "L2"] }
        XCTAssertEqual(link.linkId, "L2")
        XCTAssertEqual(second.requests("browserLink.attach").count, 1, "a fresh connection, a fresh attach")
    }

    func testAReplyForALinkThatIsGoneIsDropped() async throws {
        let first = FakeLinkDaemon(attach: .link("L1"))
        let second = FakeLinkDaemon(attach: .link("L2"))
        let handler = FakeLinkHandler()
        handler.answer = { _ in nil }
        makeLink(Daemons([first, second]), handler: handler).start()
        await eventually("attached") { handler.attached == ["L1"] }
        first.command(linkId: "L1", cmdId: "old", op: "tabs.live")
        await eventually("held") { handler.held.count == 1 }

        first.drop()
        await eventually("re-attached") { handler.attached == ["L1", "L2"] }
        handler.held[0](.empty)
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertTrue(second.requests("browserLink.result").isEmpty, "L1's answer must never reach L2")
    }

    func testReplacedYieldsAndDoesNotReattachOnTheSameConnection() async throws {
        let first = FakeLinkDaemon(attach: .link("L1"))
        let second = FakeLinkDaemon(attach: .link("L3"))
        let handler = FakeLinkHandler()
        let daemons = Daemons([first, second])
        makeLink(daemons, handler: handler).start()
        await eventually("attached") { handler.attached == ["L1"] }

        first.feed(#"{"jsonrpc":"2.0","method":"browserLink.detached","params":{"linkId":"L1","reason":"replaced"}}"#)
        await eventually("lost") { handler.lost == 1 }
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(first.requests("browserLink.attach").count, 1, "no attach war on the connection that lost")
        XCTAssertEqual(daemons.attemptCount, 1)

        // Only a new daemon connection competes again.
        first.drop()
        await eventually("re-attached after the reconnect") { handler.attached == ["L1", "L3"] }
    }

    func testAnOlderDaemonWithoutTheLinkIsRetriedQuietlyAndNeverAttached() async throws {
        let handler = FakeLinkHandler()
        let daemons = Daemons([], then: { FakeLinkDaemon(attach: .methodNotFound) })
        let logs = LogBox()
        makeLink(daemons, handler: handler) { config in config.log = { line in logs.append(line) } }.start()
        await eventually("several attempts") { daemons.attemptCount >= 3 }
        XCTAssertTrue(handler.attached.isEmpty)
        XCTAssertEqual(handler.lost, 0)
        XCTAssertEqual(logs.lines.filter { $0.contains("has no browserLink") }.count, 1, "said once, not per attempt")
    }

    func testAProtocolMismatchIsNeverAttached() async throws {
        let handler = FakeLinkHandler()
        let daemons = Daemons([], then: { FakeLinkDaemon(attach: .protocolMismatch) })
        makeLink(daemons, handler: handler).start()
        await eventually("an attempt") { daemons.all.first.map { !$0.requests("browserLink.attach").isEmpty } ?? false }
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertTrue(handler.attached.isEmpty)

        let other = FakeLinkHandler()
        let wrong = Daemons([], then: { FakeLinkDaemon(attach: .link("LX", protocolVersion: 2)) })
        makeLink(wrong, handler: other).start()
        await eventually("an attempt") { wrong.all.first.map { !$0.requests("browserLink.attach").isEmpty } ?? false }
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertTrue(other.attached.isEmpty, "a daemon answering another protocol is not attached to")
    }

    func testStopEndsTheLink() async throws {
        let daemon = FakeLinkDaemon(attach: .link("L1"))
        let handler = FakeLinkHandler()
        let daemons = Daemons([daemon])
        let link = makeLink(daemons, handler: handler)
        link.start()
        await eventually("attached") { handler.attached == ["L1"] }
        link.stop()
        await eventually("lost") { handler.lost == 1 }
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(daemons.attemptCount, 1, "a stopped link never reconnects")
        XCTAssertNil(link.linkId)
    }

    // MARK: - Pure pieces

    func testAReplierAnswersOnce() async {
        let count = LogBox()
        let reply = BrowserLinkReplier { _ in count.append("x") }
        reply(.empty)
        reply(.failure(code: .tabGone, message: "late"))
        XCTAssertEqual(count.lines.count, 1)
    }

    func testARawResultIsPlacedUnderItsKeyOrRefusedOverTheCap() {
        XCTAssertEqual(BrowserLinkClient.resolve(.okRaw(key: "result", json: #"{"data":"abc"}"#)),
                       .ok(.object(["result": .object(["data": .string("abc")])])))
        let huge = #"{"data":""# + String(repeating: "A", count: BrowserLinkProtocol.resultLineCap) + #""}"#
        guard case .failure(let code, _, _) = BrowserLinkClient.resolve(.okRaw(key: "result", json: huge)) else {
            return XCTFail("an over-cap result must not be sent")
        }
        XCTAssertEqual(code, .cdpError)
        guard case .failure = BrowserLinkClient.resolve(.okRaw(key: "result", json: "not json")) else {
            return XCTFail("unreadable")
        }
    }
}

final class LogBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _lines: [String] = []
    func append(_ line: String) { lock.withLock { _lines.append(line) } }
    var lines: [String] { lock.withLock { _lines } }
}

/// The `browserLink.command` reader.
final class BrowserLinkCommandTests: XCTestCase {
    private func parse(_ json: String) -> Result<BrowserLinkCommand, BrowserLinkCommand.Unreadable> {
        BrowserLinkCommand.parse(try! JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)))
    }

    func testEveryOpIsRead() throws {
        func op(_ json: String) throws -> BrowserLinkCommand.Op { try parse(json).get().op }
        XCTAssertEqual(try op(#"{"linkId":"L","cmdId":"c","op":"tab.ensure","params":{"sessionId":"s","tabId":"t","url":"https://x/"}}"#),
                       .tabEnsure(sessionId: "s", tabId: "t", url: "https://x/"))
        XCTAssertEqual(try op(#"{"linkId":"L","cmdId":"c","op":"tab.ensure","params":{"sessionId":"s","tabId":"t"}}"#),
                       .tabEnsure(sessionId: "s", tabId: "t", url: nil))
        XCTAssertEqual(try op(#"{"linkId":"L","cmdId":"c","op":"tab.release","params":{"tabId":"t"}}"#), .tabRelease(tabId: "t"))
        XCTAssertEqual(try op(#"{"linkId":"L","cmdId":"c","op":"tab.close","params":{"tabId":"t"}}"#), .tabClose(tabId: "t"))
        XCTAssertEqual(try op(#"{"linkId":"L","cmdId":"c","op":"tabs.live","params":{}}"#), .tabsLive)
        XCTAssertEqual(try op(#"{"linkId":"L","cmdId":"c","op":"tabs.live"}"#), .tabsLive)
        XCTAssertEqual(try op(#"{"linkId":"L","cmdId":"c","op":"cdp.send","params":{"tabId":"t","method":"Page.enable"}}"#),
                       .cdpSend(tabId: "t", method: "Page.enable", params: .object([:]), cdpSessionId: nil))
        XCTAssertEqual(try op(#"{"linkId":"L","cmdId":"c","op":"cdp.send","params":{"tabId":"t","method":"Runtime.evaluate","params":{"contextId":3},"cdpSessionId":"S"}}"#),
                       .cdpSend(tabId: "t", method: "Runtime.evaluate", params: .object(["contextId": .number(3)]), cdpSessionId: "S"))
        XCTAssertEqual(try op(#"{"linkId":"L","cmdId":"c","op":"cdp.subscribe","params":{"tabId":"t","events":["Page.frameNavigated"]}}"#),
                       .cdpSubscribe(tabId: "t", events: ["Page.frameNavigated"]))
        XCTAssertEqual(try op(#"{"linkId":"L","cmdId":"c","op":"overlay","params":{"tabId":"t","active":true}}"#),
                       .overlay(tabId: "t", active: true, cursor: nil))
    }

    func testAnUnreadableCommandKeepsWhatItNeedsToBeAnswered() {
        guard case .failure(let u) = parse(#"{"linkId":"L","cmdId":"c","op":"nope"}"#) else { return XCTFail() }
        XCTAssertEqual(u.linkId, "L")
        XCTAssertEqual(u.cmdId, "c")
        guard case .failure(let v) = parse(#"{"op":"tabs.live"}"#) else { return XCTFail() }
        XCTAssertNil(v.cmdId)
        guard case .failure = parse(#"{"linkId":"L","cmdId":"c","op":"cdp.send","params":{"tabId":"t","method":"X","params":[1]}}"#) else {
            return XCTFail("method params must be an object")
        }
        guard case .failure = parse(#"{"linkId":"L","cmdId":"c","op":"cdp.subscribe","params":{"tabId":"t","events":[1]}}"#) else {
            return XCTFail("events are names")
        }
    }
}

/// Non-event notifications reach `notifications(method:)` and nothing else.
final class WinterClientNotificationTests: XCTestCase {
    func testANotificationIsParsedAsOneAndAnEventStaysAnEvent() {
        guard case .notification(let method, let params) = parseServerLine(
            #"{"jsonrpc":"2.0","method":"browserLink.command","params":{"cmdId":"c1"}}"#) else { return XCTFail() }
        XCTAssertEqual(method, "browserLink.command")
        XCTAssertEqual(params["cmdId"]?.stringValue, "c1")
        guard case .notification(_, let none) = parseServerLine(#"{"jsonrpc":"2.0","method":"x.y"}"#) else { return XCTFail() }
        XCTAssertEqual(none, .null)
        // A response is still a response, and an unknown event still an unknown event.
        guard case .response = parseServerLine(#"{"jsonrpc":"2.0","id":1,"method":"x","result":{}}"#) else { return XCTFail() }
        guard case .unknownEvent = parseServerLine(#"{"jsonrpc":"2.0","method":"event","params":{"type":"nope"}}"#) else {
            return XCTFail()
        }
    }

    func testNotificationsReachOnlyTheirMethodsStreamAndNeverTheEvents() async throws {
        let t = ScriptedTransport()
        let client = WinterClient(makeTransport: { t }, token: "tok", clientName: "browser-link")
        async let connected: Void = client.connect()
        let hello = try await waitForSent(t, count: 1)[0]
        t.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(hello)["id"] as! Int),"result":{"ok":true}}"#)
        try await connected

        let commands = client.notifications(method: "browserLink.command")
        let detaches = client.notifications(method: "browserLink.detached")
        let anyEvent = client.observe(where: { _ in true })

        t.feed(#"{"jsonrpc":"2.0","method":"browserLink.command","params":{"cmdId":"c1"}}"#)
        t.feed(#"{"jsonrpc":"2.0","method":"browserLink.detached","params":{"reason":"replaced"}}"#)
        t.feed(#"{"jsonrpc":"2.0","method":"browserLink.command","params":{"cmdId":"c2"}}"#)

        var commandIterator = commands.makeAsyncIterator()
        let first = await commandIterator.next()
        let second = await commandIterator.next()
        XCTAssertEqual(first?["cmdId"]?.stringValue, "c1")
        XCTAssertEqual(second?["cmdId"]?.stringValue, "c2")
        var detachIterator = detaches.makeAsyncIterator()
        let detach = await detachIterator.next()
        XCTAssertEqual(detach?["reason"]?.stringValue, "replaced")

        // Nothing of the three reached the event side streams, and a closed client ends both kinds.
        await client.close()
        var collected = 0
        for await _ in anyEvent { collected += 1 }
        XCTAssertEqual(collected, 0)
        let ended = await commandIterator.next()
        XCTAssertNil(ended)
    }
}
