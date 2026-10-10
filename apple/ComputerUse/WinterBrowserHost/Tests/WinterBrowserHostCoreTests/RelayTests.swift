import Foundation
import WinterBrowserHostCore
import XCTest

final class FakeLink: DaemonLink {
    var lines: [Data] = []
    var closed = false
    var writable = true
    func send(_ line: Data) -> Bool {
        guard writable, !closed else { return false }
        lines.append(line)
        return true
    }
    func close() { closed = true }
    func objects() -> [[String: Any]] {
        lines.map { try! JSONSerialization.jsonObject(with: $0.dropLast()) as! [String: Any] }
    }
}

final class FakeConnector: DaemonConnecting {
    var results: [() -> DaemonConnectResult] = []
    var attempts = 0
    var onLine: ((Data) -> Void)?
    var onClose: (() -> Void)?
    func connect(onLine: @escaping (Data) -> Void, onClose: @escaping () -> Void) -> DaemonConnectResult {
        attempts += 1
        self.onLine = onLine
        self.onClose = onClose
        return results.isEmpty ? .unavailable("nothing") : results.removeFirst()()
    }
    func daemonSays(_ json: String) { onLine?(Data(json.utf8)) }
}

final class ManualScheduler: RelayScheduler {
    var pending: [(TimeInterval, () -> Void)] = []
    func after(_ seconds: TimeInterval, _ block: @escaping () -> Void) { pending.append((seconds, block)) }
    func fire() {
        let p = pending
        pending = []
        for (_, b) in p { b() }
    }
}

final class RelayTests: XCTestCase {
    private var connector: FakeConnector!
    private var scheduler: ManualScheduler!
    private var toExtension: [Data] = []
    private var relay: HostRelay!
    private let hello = HostRelay.Hello(origin: "chrome-extension://jikdcokcpbacalfeipkognejnlnobbbf/", browserBundleId: "com.google.Chrome",
                                        browserPid: 4000, hostVersion: "1.9.0", hostPid: 4242)

    override func setUp() {
        connector = FakeConnector()
        scheduler = ManualScheduler()
        toExtension = []
        relay = HostRelay(hello: hello, connector: connector, scheduler: scheduler, toExtension: { [unowned self] in self.toExtension.append($0) })
    }

    /// What reached the extension, unframed and parsed.
    private func extensionGot() -> [[String: Any]] {
        toExtension.map { frame in
            let length = Int(frame[0]) | Int(frame[1]) << 8 | Int(frame[2]) << 16 | Int(frame[3]) << 24
            XCTAssertEqual(length, frame.count - 4)
            return try! JSONSerialization.jsonObject(with: frame.dropFirst(4)) as! [String: Any]
        }
    }

    private func statuses() -> [[String: String]] {
        extensionGot().filter { $0["method"] as? String == "host.status" }.map { $0["params"] as! [String: String] }
    }

    private func connected() -> FakeLink {
        let link = FakeLink()
        connector.results = [{ .connected(link) }]
        relay.start()
        connector.daemonSays(#"{"jsonrpc":"2.0","id":"h1","result":{"protocol":1,"daemonVersion":"0.124.0"}}"#)
        return link
    }

    func testHostHelloIsTheFirstAndOnlyThingSentUntilTheDaemonAnswers() {
        let link = FakeLink()
        connector.results = [{ .connected(link) }]
        relay.start()
        XCTAssertEqual(relay.phase, .helloSent)
        let sent = link.objects()
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent[0]["method"] as? String, "host.hello")
        XCTAssertEqual(sent[0]["id"] as? String, "h1")
        let params = sent[0]["params"] as! [String: Any]
        XCTAssertEqual(params["protocol"] as? Int, 1)
        XCTAssertEqual(params["client"] as? String, "browser-host")
        XCTAssertEqual(params["hostVersion"] as? String, "1.9.0")
        XCTAssertEqual(params["hostPid"] as? Int, 4242)
        XCTAssertEqual(params["origin"] as? String, "chrome-extension://jikdcokcpbacalfeipkognejnlnobbbf/")
        XCTAssertEqual(params["browserBundleId"] as? String, "com.google.Chrome")
        XCTAssertEqual(params["browserPid"] as? Int, 4000)
        // The extension's messages wait: a request is answered here, a notification dropped.
        relay.fromExtension(Data(#"{"jsonrpc":"2.0","id":"e1","method":"hello","params":{}}"#.utf8))
        relay.fromExtension(Data(#"{"jsonrpc":"2.0","method":"tab.gone","params":{}}"#.utf8))
        XCTAssertEqual(link.lines.count, 1)
        let answer = extensionGot().last!
        XCTAssertEqual(answer["id"] as? String, "e1")
        XCTAssertEqual(((answer["error"] as? [String: Any])?["data"] as? [String: String])?["code"], "disconnected")
        // The answer arrives: connected, and the extension is told.
        connector.daemonSays(#"{"jsonrpc":"2.0","id":"h1","result":{"protocol":1,"daemonVersion":"0.124.0"}}"#)
        XCTAssertEqual(relay.phase, .relaying)
        XCTAssertEqual(statuses(), [["daemon": "connected"]])
    }

    func testOnceConnectedEveryObjectIsRelayedUnchangedBothWays() throws {
        let link = connected()
        let fromDaemon = #"{"jsonrpc":"2.0","id":"d1","method":"cdp.send","params":{"tabKey":"418","method":"Page.enable","params":{}}}"#
        connector.daemonSays(fromDaemon)
        XCTAssertEqual(toExtension.last!.dropFirst(4), Data(fromDaemon.utf8))
        let fromExtension = #"{"jsonrpc":"2.0","id":"d1","result":{"result":{}}}"#
        relay.fromExtension(Data(fromExtension.utf8))
        XCTAssertEqual(link.lines.last, Data(fromExtension.utf8) + Data([0x0A]))
        // Not JSON-RPC: dropped, either way.
        relay.fromExtension(Data("garbage".utf8))
        connector.daemonSays(#"{"no":"envelope"}"#)
        XCTAssertEqual(link.lines.count, 2)
        XCTAssertEqual(toExtension.count, 2)
    }

    func testNoDaemonIsSaidOnceAndTriedAgainEvery2Seconds() {
        connector.results = [{ .unavailable("ENOENT") }, { .unavailable("ENOENT") }]
        relay.start()
        XCTAssertEqual(statuses(), [["daemon": "unavailable"]])
        XCTAssertEqual(scheduler.pending.map { $0.0 }, [2])
        scheduler.fire()
        XCTAssertEqual(connector.attempts, 2)
        XCTAssertEqual(statuses(), [["daemon": "unavailable"]], "the same status is not repeated")
        XCTAssertEqual(scheduler.pending.map { $0.0 }, [2])
    }

    func testAnUnverifiedDaemonGetsNothingAndIsTriedAgainIn30Seconds() {
        connector.results = [{ .unverified("not winter-core") }]
        relay.start()
        XCTAssertEqual(statuses(), [["daemon": "unverified"]])
        XCTAssertEqual(scheduler.pending.map { $0.0 }, [30])
    }

    func testARefusedHelloIsReportedWithItsCodeTheLinkClosedAndTriedAgainIn30Seconds() {
        let link = FakeLink()
        connector.results = [{ .connected(link) }]
        relay.start()
        connector.daemonSays(#"{"jsonrpc":"2.0","id":"h1","error":{"code":-32000,"message":"Computer Use is turned off in Winter's settings","data":{"code":"disabled"}}}"#)
        XCTAssertTrue(link.closed)
        XCTAssertEqual(relay.phase, .idle)
        XCTAssertEqual(statuses(), [["daemon": "refused", "code": "disabled", "reason": "Computer Use is turned off in Winter's settings"]])
        XCTAssertEqual(scheduler.pending.map { $0.0 }, [30])
        // Its close arriving later is stale.
        connector.onClose?()
        XCTAssertEqual(scheduler.pending.count, 1)
    }

    func testTheDaemonGoingAwayIsSaidAndAReconnectSaysHelloAgain() {
        _ = connected()
        connector.onClose?()
        XCTAssertEqual(relay.phase, .idle)
        XCTAssertEqual(statuses().last, ["daemon": "unavailable"])
        let second = FakeLink()
        connector.results = [{ .connected(second) }]
        scheduler.fire()
        XCTAssertEqual(second.objects().first?["id"] as? String, "h2")
        connector.daemonSays(#"{"jsonrpc":"2.0","id":"h2","result":{"protocol":1,"daemonVersion":"0.124.0"}}"#)
        XCTAssertEqual(statuses(), [["daemon": "connected"], ["daemon": "unavailable"], ["daemon": "connected"]])
    }

    func testOnlyTheAnswerToItsOwnHelloCounts() {
        let link = FakeLink()
        connector.results = [{ .connected(link) }]
        relay.start()
        connector.daemonSays(#"{"jsonrpc":"2.0","id":"d9","method":"tabs.list","params":{}}"#)
        connector.daemonSays(#"{"jsonrpc":"2.0","id":"h0","result":{}}"#)
        XCTAssertEqual(relay.phase, .helloSent)
        XCTAssertTrue(toExtension.isEmpty)
    }

    func testAnOversizedDaemonMessageIsNotForwarded() {
        _ = connected()
        let before = toExtension.count
        let big = "{\"jsonrpc\":\"2.0\",\"method\":\"x\",\"params\":{\"s\":\"" + String(repeating: "a", count: 1024 * 1024) + "\"}}"
        connector.daemonSays(big)
        XCTAssertEqual(toExtension.count, before)
    }
}
