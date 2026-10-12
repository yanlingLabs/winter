import XCTest
import WinterProtocol
@testable import WinterKit

/// Feature `headless` (ComputerV2 Phase 4, lane H3): the three `headless.*` ops' parser, the link client naming the
/// feature at attach and keeping the daemon's answer, the ops reaching the handler, and `browserLink.headless`.
@MainActor
final class BrowserLinkHeadlessTests: XCTestCase {

    // MARK: - The parser

    private func parse(_ json: String) -> Result<BrowserLinkHeadlessCommand, BrowserLinkCommand.Unreadable> {
        BrowserLinkHeadlessCommand.parse(try! JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)))
    }

    private static let goodShowParams: [String: String] = [
        "sessionId": #""s_1""#,
        "tabId": #""ht_1""#,
        "service": #""com.winter.headless.present.4242.0123456789abcdef0123456789abcdef""#,
        "nonce": #""00ff00ff00ff00fA""#,
        "producerRequirement": #""identifier \"com.winter.headless\" and anchor apple generic""#,
        "control": "true",
        "purpose": #""handoff""#,
        "url": #""https://example.com/login""#,
        "title": #""Sign in""#,
        "uploadDir": #""/tmp/home/cache/headless-uploads""#,
    ]

    private func show(_ overrides: [String: String?] = [:]) -> String {
        var params = Self.goodShowParams
        for (key, value) in overrides { params[key] = value }
        let body = params.sorted { $0.key < $1.key }.map { "\"\($0.key)\":\($0.value)" }.joined(separator: ",")
        return #"{"linkId":"L","cmdId":"c1","op":"headless.show","params":{\#(body)}}"#
    }

    func testAShowIsRead() throws {
        let command = try parse(show()).get()
        XCTAssertEqual(command.linkId, "L")
        XCTAssertEqual(command.cmdId, "c1")
        guard case .show(let s) = command.op else { return XCTFail("not a show") }
        XCTAssertEqual(s.sessionId, "s_1")
        XCTAssertEqual(s.tabId, "ht_1")
        XCTAssertEqual(s.service, "com.winter.headless.present.4242.0123456789abcdef0123456789abcdef")
        XCTAssertEqual(s.nonce, 0x00ff00ff00ff00fa)
        XCTAssertEqual(s.producerRequirement, #"identifier "com.winter.headless" and anchor apple generic"#)
        XCTAssertTrue(s.control)
        XCTAssertEqual(s.purpose, .handoff)
        XCTAssertEqual(s.url, "https://example.com/login")
        XCTAssertEqual(s.title, "Sign in")
        XCTAssertEqual(s.uploadDir, "/tmp/home/cache/headless-uploads")
    }

    func testAShowWithAnEmptyTitleAndURLIsStillRead() throws {
        guard case .show(let s) = try parse(show(["title": #""""#, "url": #""""#, "purpose": #""watch""#, "control": "false"])).get().op else {
            return XCTFail("not a show")
        }
        XCTAssertEqual(s.title, "")
        XCTAssertEqual(s.url, "")
        XCTAssertEqual(s.purpose, .watch)
        XCTAssertFalse(s.control)
    }

    func testAShowRefusesWhatItCannotRead() {
        let bad: [(String, [String: String?])] = [
            ("another service prefix", ["service": #""com.example.present.1.abc""#]),
            ("the bare prefix", ["service": #""com.winter.headless.present.""#]),
            ("a service with a slash", ["service": #""com.winter.headless.present.1/abc""#]),
            ("a service too long", ["service": "\"com.winter.headless.present.\(String(repeating: "a", count: 120))\""]),
            ("a short nonce", ["nonce": #""00ff00ff00ff00f""#]),
            ("a long nonce", ["nonce": #""00ff00ff00ff00ff0""#]),
            ("a nonce that is not hex", ["nonce": #""00ff00ff00ff00fg""#]),
            ("a signed nonce", ["nonce": #""+0ff00ff00ff00ff""#]),
            ("a numeric nonce", ["nonce": "12345"]),
            ("no requirement", ["producerRequirement": nil]),
            ("an empty requirement", ["producerRequirement": #""""#]),
            ("control not a bool", ["control": #""yes""#]),
            ("no control", ["control": nil]),
            ("another purpose", ["purpose": #""steal""#]),
            ("no url", ["url": nil]),
            ("no title", ["title": nil]),
            ("a relative uploadDir", ["uploadDir": #""cache/headless-uploads""#]),
            ("no uploadDir", ["uploadDir": nil]),
            ("no tabId", ["tabId": nil]),
            ("an empty sessionId", ["sessionId": #""""#]),
        ]
        for (what, overrides) in bad {
            guard case .failure(let u) = parse(show(overrides)) else { XCTFail("should be unreadable: \(what)"); continue }
            // Still owed an answer: it named itself.
            XCTAssertEqual(u.linkId, "L", what)
            XCTAssertEqual(u.cmdId, "c1", what)
        }
    }

    func testAHideIsRead() throws {
        let command = try parse(#"{"linkId":"L","cmdId":"c2","op":"headless.hide","params":{"sessionId":"s_1","tabId":"ht_1","reason":"done"}}"#).get()
        XCTAssertEqual(command.op, .hide(sessionId: "s_1", tabId: "ht_1", reason: "done"))
        for json in [
            #"{"linkId":"L","cmdId":"c2","op":"headless.hide","params":{"sessionId":"s_1","reason":"done"}}"#,
            #"{"linkId":"L","cmdId":"c2","op":"headless.hide","params":{"tabId":"ht_1","reason":"done"}}"#,
            #"{"linkId":"L","cmdId":"c2","op":"headless.hide","params":{"sessionId":"s_1","tabId":"ht_1"}}"#,
            #"{"linkId":"L","cmdId":"c2","op":"headless.hide","params":[1]}"#,
        ] {
            guard case .failure = parse(json) else { return XCTFail("should be unreadable: \(json)") }
        }
    }

    func testTabsAreRead() throws {
        let command = try parse(#"{"linkId":"L","cmdId":"c3","op":"headless.tabs","params":{"sessionId":"s_1","tabs":[{"tabId":"ht_1","url":"https://a.example/","title":"A","presented":true,"control":false},{"tabId":"ht_2","url":"","title":"","presented":false,"control":false}]}}"#).get()
        XCTAssertEqual(command.op, .tabs(sessionId: "s_1", tabs: [
            BrowserLinkHeadlessTab(tabId: "ht_1", url: "https://a.example/", title: "A", presented: true, control: false),
            BrowserLinkHeadlessTab(tabId: "ht_2", url: "", title: "", presented: false, control: false),
        ]))
        let empty = try parse(#"{"linkId":"L","cmdId":"c3","op":"headless.tabs","params":{"sessionId":"s_1","tabs":[]}}"#).get()
        XCTAssertEqual(empty.op, .tabs(sessionId: "s_1", tabs: []))
        for json in [
            #"{"linkId":"L","cmdId":"c3","op":"headless.tabs","params":{"sessionId":"s_1"}}"#,
            #"{"linkId":"L","cmdId":"c3","op":"headless.tabs","params":{"tabs":[]}}"#,
            #"{"linkId":"L","cmdId":"c3","op":"headless.tabs","params":{"sessionId":"s_1","tabs":[{"tabId":"ht_1","url":"u","title":"t","presented":"yes","control":false}]}}"#,
            #"{"linkId":"L","cmdId":"c3","op":"headless.tabs","params":{"sessionId":"s_1","tabs":[{"tabId":"","url":"u","title":"t","presented":true,"control":false}]}}"#,
            #"{"linkId":"L","cmdId":"c3","op":"headless.tabs","params":{"sessionId":"s_1","tabs":[1]}}"#,
        ] {
            guard case .failure = parse(json) else { return XCTFail("should be unreadable: \(json)") }
        }
    }

    func testTheOrdinaryParserNeverReadsAHeadlessOp() {
        // Winter Headless compiles `BrowserLinkCommand.parse` and switches over its whole `Op`: a headless op stays
        // outside it.
        guard case .failure(let u) = BrowserLinkCommand.parse(try! JSONDecoder().decode(JSONValue.self, from: Data(show().utf8))) else {
            return XCTFail("BrowserLinkCommand.parse read headless.show")
        }
        XCTAssertTrue(u.reason.contains("unknown op"))
        XCTAssertTrue(BrowserLinkHeadlessCommand.handles(op: "headless.show"))
        XCTAssertFalse(BrowserLinkHeadlessCommand.handles(op: "headless.present"))
        XCTAssertFalse(BrowserLinkHeadlessCommand.handles(op: "tab.ensure"))
    }

    // MARK: - The link

    private var links: [BrowserLinkClient] = []

    override func tearDown() async throws {
        for link in links { link.stop() }
        links = []
    }

    private func makeLink(_ daemon: FakeLinkDaemon, handler: BrowserLinkHandler,
                          configure: (inout BrowserLinkClient.Configuration) -> Void = { _ in }) -> BrowserLinkClient {
        var configuration = BrowserLinkClient.Configuration(appVersion: "9.9.9", pid: 4242)
        configuration.sleep = { _ in try? await Task.sleep(nanoseconds: 5_000_000) }
        configure(&configuration)
        let link = BrowserLinkClient(configuration: configuration, makeClient: { _ in
            WinterClient(makeTransport: { daemon }, token: "tok-link", clientName: BrowserLinkProtocol.clientName)
        }, handler: handler)
        links.append(link)
        return link
    }

    func testTheAttachNamesTheFeatureAndKeepsWhatTheDaemonNamed() async throws {
        let daemon = FakeLinkDaemon(attach: .link("L1", features: ["headless", "somethingNewer"]))
        let handler = FakeHeadlessLinkHandler()
        let link = makeLink(daemon, handler: handler)
        link.start()
        await eventually("attached") { handler.attached == ["L1"] }

        let attach = try XCTUnwrap(daemon.requests("browserLink.attach").first?["params"] as? [String: Any])
        XCTAssertEqual(attach["features"] as? [String], ["headless"])
        // Only what BOTH sides named.
        XCTAssertEqual(link.daemonFeatures, ["headless"])
    }

    func testADaemonThatNamesNoFeaturesLeavesNoneInUse() async throws {
        let daemon = FakeLinkDaemon(attach: .link("L1"))
        let handler = FakeHeadlessLinkHandler()
        let link = makeLink(daemon, handler: handler)
        link.start()
        await eventually("attached") { handler.attached == ["L1"] }
        XCTAssertEqual(link.daemonFeatures, [])
        do {
            try await link.headless(sessionId: "s_1", tabId: "ht_1", action: .watch)
            XCTFail("an older daemon must not be asked")
        } catch {
            XCTAssertEqual(error as? BrowserLinkHeadlessError, .unsupported)
        }
        XCTAssertTrue(daemon.requests("browserLink.headless").isEmpty)
    }

    func testAnAppThatNamesNothingSendsNoFeatures() async throws {
        let daemon = FakeLinkDaemon(attach: .link("L1", features: ["headless"]))
        let handler = FakeHeadlessLinkHandler()
        let link = makeLink(daemon, handler: handler) { $0.features = [] }
        link.start()
        await eventually("attached") { handler.attached == ["L1"] }
        let attach = try XCTUnwrap(daemon.requests("browserLink.attach").first?["params"] as? [String: Any])
        XCTAssertNil(attach["features"])
        XCTAssertEqual(link.daemonFeatures, [])
    }

    func testAHeadlessCommandReachesTheHandlerAndIsAnsweredOnce() async throws {
        let daemon = FakeLinkDaemon(attach: .link("L1", features: ["headless"]))
        let handler = FakeHeadlessLinkHandler()
        makeLink(daemon, handler: handler).start()
        await eventually("attached") { handler.attached == ["L1"] }

        daemon.command(linkId: "L1", cmdId: "c1", op: "headless.hide", params: #"{"sessionId":"s_1","tabId":"ht_1","reason":"closed"}"#)
        daemon.command(linkId: "L1", cmdId: "c2", op: "tabs.live")
        await eventually("two results") { daemon.requests("browserLink.result").count == 2 }
        XCTAssertEqual(handler.headless, [BrowserLinkHeadlessCommand(linkId: "L1", cmdId: "c1", op: .hide(sessionId: "s_1", tabId: "ht_1", reason: "closed"))])
        XCTAssertEqual(handler.commands.map(\.cmdId), ["c2"])
        let results = daemon.requests("browserLink.result").compactMap { $0["params"] as? [String: Any] }
        XCTAssertEqual(results.map { $0["cmdId"] as? String }, ["c1", "c2"], "in the order they were sent")
        XCTAssertEqual(results.first?["ok"] as? Bool, true)
    }

    func testAnUnreadableHeadlessCommandIsAnsweredNotAllowedAndNeverReachesTheHandler() async throws {
        let daemon = FakeLinkDaemon(attach: .link("L1", features: ["headless"]))
        let handler = FakeHeadlessLinkHandler()
        makeLink(daemon, handler: handler).start()
        await eventually("attached") { handler.attached == ["L1"] }

        daemon.command(linkId: "L1", cmdId: "c9", op: "headless.show", params: #"{"sessionId":"s_1","tabId":"ht_1","nonce":"zz"}"#)
        await eventually("a result") { !daemon.requests("browserLink.result").isEmpty }
        XCTAssertTrue(handler.headless.isEmpty)
        let result = try XCTUnwrap(daemon.requests("browserLink.result").first?["params"] as? [String: Any])
        XCTAssertEqual(result["cmdId"] as? String, "c9")
        XCTAssertEqual(result["ok"] as? Bool, false)
        XCTAssertEqual((result["error"] as? [String: Any])?["code"] as? String, "not_allowed")
    }

    func testAHandlerWithoutHeadlessRefusesIt() async throws {
        let daemon = FakeLinkDaemon(attach: .link("L1", features: ["headless"]))
        let handler = FakeLinkHandler()
        let link = BrowserLinkClient(configuration: {
            var c = BrowserLinkClient.Configuration(appVersion: "1", pid: 1)
            c.sleep = { _ in try? await Task.sleep(nanoseconds: 5_000_000) }
            return c
        }(), makeClient: { _ in WinterClient(makeTransport: { daemon }, token: "t", clientName: BrowserLinkProtocol.clientName) },
           handler: handler)
        links.append(link)
        link.start()
        await eventually("attached") { handler.attached == ["L1"] }
        daemon.command(linkId: "L1", cmdId: "c1", op: "headless.tabs", params: #"{"sessionId":"s_1","tabs":[]}"#)
        await eventually("a result") { !daemon.requests("browserLink.result").isEmpty }
        let result = try XCTUnwrap(daemon.requests("browserLink.result").first?["params"] as? [String: Any])
        XCTAssertEqual(result["ok"] as? Bool, false)
        XCTAssertTrue(handler.commands.isEmpty)
    }

    func testAnActionIsOneHeadlessRequestNamingTheLink() async throws {
        let daemon = FakeLinkDaemon(attach: .link("L1", features: ["headless"]))
        let handler = FakeHeadlessLinkHandler()
        let link = makeLink(daemon, handler: handler)
        link.start()
        await eventually("attached") { handler.attached == ["L1"] }

        let none = try await link.headless(sessionId: "s_1", tabId: "ht_1", action: .takeOver)
        XCTAssertNil(none)
        let params = try XCTUnwrap(daemon.requests("browserLink.headless").first?["params"] as? [String: Any])
        XCTAssertEqual(params["linkId"] as? String, "L1")
        XCTAssertEqual(params["sessionId"] as? String, "s_1")
        XCTAssertEqual(params["tabId"] as? String, "ht_1")
        XCTAssertEqual(params["action"] as? String, "takeOver")
    }

    func testAListReturnsTheTabsAndNamesNoTab() async throws {
        let daemon = FakeLinkDaemon(attach: .link("L1", features: ["headless"]))
        daemon.headlessResponse = #""result":{"tabs":[{"tabId":"ht_1","url":"https://a.example/","title":"A","presented":false,"control":false}]}"#
        let handler = FakeHeadlessLinkHandler()
        let link = makeLink(daemon, handler: handler)
        link.start()
        await eventually("attached") { handler.attached == ["L1"] }

        let tabs = try await link.headless(sessionId: "s_1", tabId: nil, action: .list)
        XCTAssertEqual(tabs, [BrowserLinkHeadlessTab(tabId: "ht_1", url: "https://a.example/", title: "A", presented: false, control: false)])
        let params = try XCTUnwrap(daemon.requests("browserLink.headless").first?["params"] as? [String: Any])
        XCTAssertNil(params["tabId"])
        XCTAssertEqual(params["action"] as? String, "list")
    }

    func testARefusalIsTyped() async throws {
        let daemon = FakeLinkDaemon(attach: .link("L1", features: ["headless"]))
        daemon.headlessResponse = #""error":{"code":-32602,"message":"Winter's headless browser is not available","data":{"code":"headless_unavailable"}}"#
        let handler = FakeHeadlessLinkHandler()
        let link = makeLink(daemon, handler: handler)
        link.start()
        await eventually("attached") { handler.attached == ["L1"] }
        do {
            try await link.headless(sessionId: "s_1", tabId: "ht_1", action: .done)
            XCTFail("should throw")
        } catch {
            XCTAssertEqual(error as? BrowserLinkHeadlessError,
                           .refused(code: "headless_unavailable", message: "Winter's headless browser is not available"))
            XCTAssertEqual((error as? BrowserLinkHeadlessError)?.message, "Winter's headless browser is not available")
        }
    }

    func testAnActionWithNoLinkUpIsNotConnected() async throws {
        let daemon = FakeLinkDaemon(attach: .link("L1", features: ["headless"]))
        let link = makeLink(daemon, handler: FakeHeadlessLinkHandler())
        // Never started.
        do {
            try await link.headless(sessionId: "s_1", tabId: nil, action: .list)
            XCTFail("should throw")
        } catch {
            XCTAssertEqual(error as? BrowserLinkHeadlessError, .notConnected)
        }
    }

    /// The daemon answers an action only after the app has answered the `headless.show` it sends meanwhile: the
    /// action must not sit in the outbox in front of that answer.
    func testAnActionDoesNotBlockTheResultsItWaitsFor() async throws {
        let daemon = FakeLinkDaemon(attach: .link("L1", features: ["headless"]))
        daemon.holdHeadless = true
        let handler = FakeHeadlessLinkHandler()
        let link = makeLink(daemon, handler: handler)
        link.start()
        await eventually("attached") { handler.attached == ["L1"] }

        let action = Task { try await link.headless(sessionId: "s_1", tabId: "ht_1", action: .watch) }
        await eventually("the action reached the daemon") { !daemon.requests("browserLink.headless").isEmpty }
        // While the action is pending the daemon sends a command and waits for its result.
        daemon.command(linkId: "L1", cmdId: "c1", op: "headless.hide", params: #"{"sessionId":"s_1","tabId":"ht_1","reason":"x"}"#)
        await eventually("the command's result left while the action was pending") {
            !daemon.requests("browserLink.result").isEmpty
        }
        daemon.releaseHeadless()
        _ = try await action.value
    }
}
