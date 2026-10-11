import XCTest

final class HeadlessWireTests: XCTestCase {
    private func line(_ json: String) -> Data { Data(json.utf8) }

    func testContextDisposeIsReadBeforeTheBrowserLinkParser() {
        let inbound = HeadlessWire.parse(line(#"{"jsonrpc":"2.0","method":"browserLink.command","params":{"linkId":"h-1","cmdId":"c1","op":"context.dispose","params":{"sessionId":"s_a"}}}"#))
        XCTAssertEqual(inbound, .contextDispose(linkId: "h-1", cmdId: "c1", sessionId: "s_a"))
    }

    func testContextDisposeWithoutASessionIsOwedAFailure() {
        let inbound = HeadlessWire.parse(line(#"{"method":"browserLink.command","params":{"linkId":"h-1","cmdId":"c1","op":"context.dispose","params":{}}}"#))
        XCTAssertEqual(inbound, .unreadable(linkId: "h-1", cmdId: "c1", reason: "context.dispose needs sessionId"))
    }

    func testTheBrowserLinkOpsParseAsWinterAppsDo() {
        let inbound = HeadlessWire.parse(line(#"{"method":"browserLink.command","params":{"linkId":"h-1","cmdId":"c2","op":"tab.ensure","params":{"sessionId":"s_a","tabId":"w-1","url":"https://a.test/"}}}"#))
        XCTAssertEqual(inbound, .command(BrowserLinkCommand(linkId: "h-1", cmdId: "c2",
                                                            op: .tabEnsure(sessionId: "s_a", tabId: "w-1", url: "https://a.test/"))))
        guard case .unreadable(_, let cmdId, _) = HeadlessWire.parse(line(#"{"method":"browserLink.command","params":{"linkId":"h-1","cmdId":"c3","op":"nope","params":{}}}"#)) else {
            return XCTFail("an unknown op is unreadable")
        }
        XCTAssertEqual(cmdId, "c3")
    }

    func testAnythingElseIsIgnored() {
        guard case .ignored = HeadlessWire.parse(line("not json")) else { return XCTFail() }
        guard case .ignored = HeadlessWire.parse(line(#"{"method":"other"}"#)) else { return XCTFail() }
        guard case .ignored = HeadlessWire.parse(line("[1]")) else { return XCTFail() }
    }

    private func decode(_ data: Data) -> JSONValue? {
        try? JSONDecoder().decode(JSONValue.self, from: data.dropLast())
    }

    func testARawResultIsSplicedIntoItsLineUnchanged() throws {
        let outbox = HeadlessOutbox(linkId: "h-1")
        let lines = outbox.result(cmdId: "c1", reply: .okRaw(key: "result", json: #"{"data":"iVBOR/w=="}"#))
        XCTAssertEqual(lines.count, 1)
        XCTAssertEqual(lines[0].last, 0x0a)
        let value = try XCTUnwrap(decode(lines[0]))
        XCTAssertEqual(value["method"], .string("browserLink.result"))
        XCTAssertEqual(value["params"]?["cmdId"], .string("c1"))
        XCTAssertEqual(value["params"]?["ok"], .bool(true))
        XCTAssertEqual(value["params"]?["result"]?["result"]?["data"], .string("iVBOR/w=="))
    }

    func testARawResultThatIsNotJSONIsAFailure() throws {
        let outbox = HeadlessOutbox(linkId: "h-1")
        let value = try XCTUnwrap(decode(outbox.result(cmdId: "c1", reply: .okRaw(key: "result", json: "{nope"))[0]))
        XCTAssertEqual(value["params"]?["ok"], .bool(false))
        XCTAssertEqual(value["params"]?["error"]?["code"], .string("cdp_error"))
    }

    func testAFailureMessageIsCut() throws {
        let outbox = HeadlessOutbox(linkId: "h-1")
        let long = String(repeating: "x", count: 10_000)
        let value = try XCTUnwrap(decode(outbox.result(cmdId: "c1", reply: .failure(code: .notAllowed, message: long))[0]))
        let message = try XCTUnwrap(value["params"]?["error"]?["message"]?.stringValue)
        XCTAssertLessThan(message.utf8.count, 2 * 1024 + 64)
        XCTAssertTrue(message.contains("cut by Winter"))
    }

    func testEventsWaitInABatchThatAResultSendsAheadOfItself() throws {
        let outbox = HeadlessOutbox(linkId: "h-1")
        XCTAssertTrue(outbox.event(.init(tabId: "w-1", method: "Page.loadEventFired", params: Data("{}".utf8), cdpSessionId: nil, strip: false)).isEmpty)
        XCTAssertTrue(outbox.hasPendingEvents)
        let lines = outbox.result(cmdId: "c1", reply: .empty)
        XCTAssertEqual(lines.count, 2)
        XCTAssertEqual(try XCTUnwrap(decode(lines[0]))["method"], .string("browserLink.events"))
        XCTAssertEqual(try XCTUnwrap(decode(lines[1]))["method"], .string("browserLink.result"))
        XCTAssertFalse(outbox.hasPendingEvents)
    }

    func testEventsAreBoundedCutAndSplit() throws {
        var limits = HeadlessOutbox.Limits()
        limits.stringMaxBytes = 16
        limits.eventMaxBytes = 400
        limits.batchMaxBytes = 300
        limits.batchMax = 100
        var dropped: [String] = []
        let outbox = HeadlessOutbox(linkId: "h-1", limits: limits, log: { dropped.append($0) })
        var lines: [Data] = []
        let longString = #"{"url":""# + String(repeating: "a", count: 100) + #""}"#
        lines += outbox.event(.init(tabId: "w-1", method: "Page.frameNavigated", params: Data(longString.utf8), cdpSessionId: nil, strip: false))
        // Many keys, each short: survives the string cut, but the whole event is over its cap.
        let wide = "{" + (0..<40).map { #""k\#($0)":"vvvvvvvvvvvv""# }.joined(separator: ",") + "}"
        lines += outbox.event(.init(tabId: "w-1", method: "Page.lifecycleEvent", params: Data(wide.utf8), cdpSessionId: nil, strip: false))
        for _ in 0..<6 {
            lines += outbox.event(.init(tabId: "w-1", method: "Page.loadEventFired", params: Data(#"{"timestamp":1}"#.utf8), cdpSessionId: "S1", strip: false))
        }
        lines += outbox.flush()
        XCTAssertGreaterThan(lines.count, 1, "the batch is split before a line passes its byte cap")
        XCTAssertEqual(dropped.count, 1)
        XCTAssertTrue(dropped[0].contains("Page.lifecycleEvent"))
        let first = try XCTUnwrap(decode(lines[0]))
        let url = try XCTUnwrap(first["params"]?["events"]?.arrayValue?.first?["params"]?["url"]?.stringValue)
        XCTAssertTrue(url.hasPrefix(String(repeating: "a", count: 16)))
        XCTAssertTrue(url.contains("cut by Winter: 100 bytes"))
        let all = lines.compactMap { decode($0)?["params"]?["events"]?.arrayValue }.flatMap { $0 }
        XCTAssertEqual(all.count, 7)
        XCTAssertEqual(all.last?["cdpSessionId"], .string("S1"))
    }

    func testAFullBatchGoesOutAtOnce() {
        var limits = HeadlessOutbox.Limits()
        limits.batchMax = 3
        let outbox = HeadlessOutbox(linkId: "h-1", limits: limits)
        let event = HeadlessOutbox.PendingEvent(tabId: "w-1", method: "Page.loadEventFired", params: Data("{}".utf8), cdpSessionId: nil, strip: false)
        XCTAssertTrue(outbox.event(event).isEmpty)
        XCTAssertTrue(outbox.event(event).isEmpty)
        XCTAssertEqual(outbox.event(event).count, 1)
        XCTAssertFalse(outbox.hasPendingEvents)
    }

    func testHelloNamesTheProtocolTheLinkAndThePid() throws {
        let value = try XCTUnwrap(decode(HeadlessOutbox(linkId: "h-9").hello(pid: 42, version: "0.124.0")))
        XCTAssertEqual(value["method"], .string("headless.hello"))
        XCTAssertEqual(value["params"]?["protocol"], .number(Double(HeadlessWire.protocolVersion)))
        XCTAssertEqual(value["params"]?["linkId"], .string("h-9"))
        XCTAssertEqual(value["params"]?["pid"], .number(42))
        XCTAssertEqual(value["params"]?["version"], .string("0.124.0"))
    }

    func testTabGoneFlushesFirst() throws {
        let outbox = HeadlessOutbox(linkId: "h-1")
        _ = outbox.event(.init(tabId: "w-1", method: "Page.loadEventFired", params: Data("{}".utf8), cdpSessionId: nil, strip: false))
        let lines = outbox.tabGone(tabId: "w-1", reason: .crashed)
        XCTAssertEqual(lines.count, 2)
        let gone = try XCTUnwrap(decode(lines[1]))
        XCTAssertEqual(gone["method"], .string("browserLink.tabGone"))
        XCTAssertEqual(gone["params"]?["reason"], .string("crashed"))
    }
}

final class HeadlessLayoutTests: XCTestCase {
    private func existing(_ paths: [String]) -> (String) -> Bool { { paths.contains($0) } }

    func testNestedInWinterAppItBorrowsWintersChromiumAndNamesWinterAsTheMainBundle() {
        let winter = "/Applications/Winter.app"
        let files = [
            "\(winter)/Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework",
            "\(winter)/Contents/Frameworks/Winter Helper.app/Contents/MacOS/Winter Helper",
        ]
        let layout = HeadlessLayout.resolve(bundleURL: URL(fileURLWithPath: "\(winter)/Contents/Helpers/Winter Headless.app"),
                                            exists: existing(files))
        XCTAssertEqual(layout, HeadlessLayout(mainBundle: winter,
                                              frameworkDir: "\(winter)/Contents/Frameworks/Chromium Embedded Framework.framework",
                                              subprocessPath: "\(winter)/Contents/Frameworks/Winter Helper.app/Contents/MacOS/Winter Helper"))
    }

    func testSelfContainedItIsItsOwnMainBundle() {
        let app = "/tmp/dist/dev/Winter Headless Dev.app"
        let files = [
            "\(app)/Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework",
            "\(app)/Contents/Frameworks/Winter Helper.app/Contents/MacOS/Winter Helper",
        ]
        XCTAssertEqual(HeadlessLayout.resolve(bundleURL: URL(fileURLWithPath: app), exists: existing(files))?.mainBundle, app)
    }

    func testNoChromiumAnywhereIsNoLayout() {
        XCTAssertNil(HeadlessLayout.resolve(bundleURL: URL(fileURLWithPath: "/Applications/Winter.app/Contents/Helpers/Winter Headless.app"),
                                            exists: { _ in false }))
    }

    func testTheArgumentsNeedAnAbsoluteCacheRootAndPassOnlyDiagnostics() {
        XCTAssertNil(HeadlessArguments.parse(["h"]))
        XCTAssertNil(HeadlessArguments.parse(["h", "--winter-cache-root=relative"]))
        let parsed = HeadlessArguments.parse(["h", "--winter-cache-root=/tmp/x", "--enable-logging=stderr", "--remote-debugging-port=9222",
                                              "--no-sandbox", "--v=1"])
        XCTAssertEqual(parsed?.cacheRoot, "/tmp/x")
        XCTAssertEqual(parsed?.passthrough, ["--enable-logging=stderr", "--v=1"])
        let argv = parsed?.chromiumArguments(program: "h") ?? []
        XCTAssertFalse(argv.contains { $0.hasPrefix("--remote-debugging") }, "never a debugging port")
        XCTAssertFalse(argv.contains("--no-sandbox"))
        XCTAssertTrue(argv.contains("--use-mock-keychain"))
        XCTAssertTrue(argv.contains("--enable-features=WebMCP"))
        XCTAssertTrue(argv.contains("--mute-audio"))
    }
}
