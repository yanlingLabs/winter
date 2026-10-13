import XCTest

final class HeadlessWireTests: XCTestCase {
    private func line(_ json: String) -> Data { Data(json.utf8) }

    func testContextDisposeIsReadBeforeTheBrowserLinkParser() {
        let inbound = HeadlessWire.parse(line(#"{"jsonrpc":"2.0","method":"browserLink.command","params":{"linkId":"h-1","cmdId":"c1","op":"context.dispose","params":{"sessionId":"s_a"}}}"#))
        XCTAssertEqual(inbound, .contextDispose(linkId: "h-1", cmdId: "c1", sessionId: "s_a"))
    }

    func testAPresentationNamesItsOwnUploadsFolderAbsoluteOrNone() {
        let named = HeadlessWire.parse(line(#"{"method":"browserLink.command","params":{"linkId":"h-1","cmdId":"c1","op":"headless.present","params":{"tabId":"w-1","nonce":"0123456789abcdef","viewerRequirement":"r","uploadDir":"/h/cache/headless-uploads/s_a"}}}"#))
        XCTAssertEqual(named, .present(linkId: "h-1", cmdId: "c1", HeadlessPresentRequest(tabId: "w-1", nonce: 0x0123_4567_89ab_cdef, viewerRequirement: "r",
                                                                                        control: false, scale: 1, uploadDir: "/h/cache/headless-uploads/s_a")))
        let relative = HeadlessWire.parse(line(#"{"method":"browserLink.command","params":{"linkId":"h-1","cmdId":"c1","op":"headless.present","params":{"tabId":"w-1","nonce":"0123456789abcdef","viewerRequirement":"r","uploadDir":"cache/x"}}}"#))
        XCTAssertEqual(relative, .present(linkId: "h-1", cmdId: "c1", HeadlessPresentRequest(tabId: "w-1", nonce: 0x0123_4567_89ab_cdef, viewerRequirement: "r",
                                                                                           control: false, scale: 1, uploadDir: nil)))
    }

    func testPresentationOpsAreReadBeforeTheBrowserLinkParser() {
        let present = HeadlessWire.parse(line(#"{"method":"browserLink.command","params":{"linkId":"h-1","cmdId":"c1","op":"headless.present","params":{"tabId":"w-1","nonce":"0123456789abcdef","viewerRequirement":"identifier \"x\"","control":true,"scale":2}}}"#))
        XCTAssertEqual(present, .present(linkId: "h-1", cmdId: "c1", HeadlessPresentRequest(tabId: "w-1", nonce: 0x0123_4567_89ab_cdef,
                                                                                          viewerRequirement: #"identifier "x""#, control: true, scale: 2)))
        XCTAssertEqual(HeadlessWire.parse(line(#"{"method":"browserLink.command","params":{"linkId":"h-1","cmdId":"c2","op":"headless.unpresent","params":{"tabId":"w-1"}}}"#)),
                       .unpresent(linkId: "h-1", cmdId: "c2", tabId: "w-1"))
        XCTAssertEqual(HeadlessWire.parse(line(#"{"method":"browserLink.command","params":{"linkId":"h-1","cmdId":"c3","op":"headless.control","params":{"tabId":"w-1","control":false}}}"#)),
                       .control(linkId: "h-1", cmdId: "c3", tabId: "w-1", control: false))
    }

    func testAPresentationWithoutItsNonceOrRequirementIsOwedAFailure() {
        for params in [#"{"tabId":"w-1","viewerRequirement":"r"}"#, #"{"tabId":"w-1","nonce":"12","viewerRequirement":"r"}"#,
                       #"{"tabId":"w-1","nonce":"0123456789abcdef"}"#] {
            let inbound = HeadlessWire.parse(line(#"{"method":"browserLink.command","params":{"linkId":"h-1","cmdId":"c1","op":"headless.present","params":"# + params + "}}"))
            XCTAssertEqual(inbound, .unreadable(linkId: "h-1", cmdId: "c1", reason: "headless.present needs nonce (16 hex) and viewerRequirement"), params)
        }
        let scale = HeadlessWire.parse(line(#"{"method":"browserLink.command","params":{"linkId":"h-1","cmdId":"c1","op":"headless.present","params":{"tabId":"w-1","nonce":"0123456789abcdef","viewerRequirement":"r","scale":9}}}"#))
        guard case .present(_, _, let request) = scale else { return XCTFail("\(scale)") }
        XCTAssertEqual(request.scale, 1, "a scale out of 1…4 is 1")
        XCTAssertFalse(request.control, "no control unless asked")
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
        // What it can do beyond protocol 1: a daemon sends the presentation ops only to a helper that says "present".
        XCTAssertEqual(value["params"]?["features"], .array([.string("present")]))
    }

    func testPresentationStartedFollowsThePendingEvents() throws {
        let outbox = HeadlessOutbox(linkId: "h-1")
        _ = outbox.event(.init(tabId: "w-1", method: "Page.loadEventFired", params: Data("{}".utf8), cdpSessionId: nil, strip: false))
        let lines = outbox.presentationStarted(tabId: "w-1")
        XCTAssertEqual(lines.count, 2, "the pending events go first")
        let started = try XCTUnwrap(decode(lines[1]))
        XCTAssertEqual(started["method"], .string("headless.presentationStarted"))
        XCTAssertEqual(started["params"]?["tabId"], .string("w-1"))
        XCTAssertEqual(started["params"]?["linkId"], .string("h-1"))
    }

    func testAViewChangeFollowsThePendingEvents() throws {
        let outbox = HeadlessOutbox(linkId: "h-1")
        _ = outbox.event(.init(tabId: "w-1", method: "Page.loadEventFired", params: Data("{}".utf8), cdpSessionId: nil, strip: false))
        let lines = outbox.viewChanged(tabId: "w-1", cssWidth: 704, cssHeight: 900, scale: 2)
        XCTAssertEqual(lines.count, 2, "the pending events (painted in the old view) go first")
        let view = try XCTUnwrap(decode(lines[1]))
        XCTAssertEqual(view["method"], .string("headless.viewChanged"))
        XCTAssertEqual(view["params"]?["linkId"], .string("h-1"))
        XCTAssertEqual(view["params"]?["tabId"], .string("w-1"))
        XCTAssertEqual(view["params"]?["cssWidth"], .number(704))
        XCTAssertEqual(view["params"]?["cssHeight"], .number(900))
        XCTAssertEqual(view["params"]?["scale"], .number(2))
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

    func testANoticeFollowsThePendingEventsAndNamesNoAddress() throws {
        let outbox = HeadlessOutbox(linkId: "h-1")
        _ = outbox.event(.init(tabId: "w-1", method: "Page.loadEventFired", params: Data("{}".utf8), cdpSessionId: nil, strip: false))
        let lines = outbox.notice(tabId: "w-1", kind: "local-network")
        XCTAssertEqual(lines.count, 2)
        let notice = try XCTUnwrap(decode(lines[1]))
        XCTAssertEqual(notice["method"], .string("headless.notice"))
        XCTAssertEqual(notice["params"], .object(["linkId": .string("h-1"), "tabId": .string("w-1"), "kind": .string("local-network")]))
    }
}

final class HeadlessLayoutTests: XCTestCase {
    private func existing(_ paths: [String]) -> (String) -> Bool { { paths.contains($0) } }

    func testNestedInWinterAppItCarriesWintersOneChromiumAndIsItsOwnMainBundle() {
        let winter = "/Applications/Winter.app"
        let helper = "\(winter)/Contents/Helpers/Winter Headless.app"
        let files = [
            "\(helper)/Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework",
            "\(helper)/Contents/Frameworks/Winter Helper.app/Contents/MacOS/Winter Helper",
        ]
        let layout = HeadlessLayout.resolve(bundleURL: URL(fileURLWithPath: helper), exists: existing(files))
        XCTAssertEqual(layout, HeadlessLayout(mainBundle: helper,
                                              frameworkDir: "\(helper)/Contents/Frameworks/Chromium Embedded Framework.framework",
                                              subprocessPath: "\(helper)/Contents/Frameworks/Winter Helper.app/Contents/MacOS/Winter Helper"))
    }

    func testStandingAloneItIsItsOwnMainBundle() {
        let app = "/tmp/dist/dev/Winter Headless Dev.app"
        let files = [
            "\(app)/Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework",
            "\(app)/Contents/Frameworks/Winter Helper.app/Contents/MacOS/Winter Helper",
        ]
        XCTAssertEqual(HeadlessLayout.resolve(bundleURL: URL(fileURLWithPath: app), exists: existing(files))?.mainBundle, app)
    }

    /// Never Winter.app's own Frameworks: the one Chromium is the helper's (a copy there would be a second one).
    func testItNeverBorrowsFromTheEnclosingApp() {
        let winter = "/Applications/Winter.app"
        let files = [
            "\(winter)/Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework",
            "\(winter)/Contents/Frameworks/Winter Helper.app/Contents/MacOS/Winter Helper",
        ]
        XCTAssertNil(HeadlessLayout.resolve(bundleURL: URL(fileURLWithPath: "\(winter)/Contents/Helpers/Winter Headless.app"), exists: existing(files)))
    }

    func testNoChromiumAnywhereIsNoLayout() {
        XCTAssertNil(HeadlessLayout.resolve(bundleURL: URL(fileURLWithPath: "/Applications/Winter.app/Contents/Helpers/Winter Headless.app"),
                                            exists: { _ in false }))
    }

    func testTheUploadsRootIsBesideTheCacheRootTheDaemonMakesAndNowhereElse() {
        XCTAssertEqual(HeadlessArguments.parse(["h", "--winter-cache-root=/Users/u/.winter-dev/cache/headless-cef/ab12"])?.uploadsRoot,
                       "/Users/u/.winter-dev/cache/headless-uploads")
        // Any other layout: no uploads root, so every file-chooser answer is refused.
        XCTAssertNil(HeadlessArguments.parse(["h", "--winter-cache-root=/tmp/x"])?.uploadsRoot)
        XCTAssertNil(HeadlessArguments.parse(["h", "--winter-cache-root=/Users/u/.winter/cache/headless-cef"])?.uploadsRoot)
    }

    func testTheArgumentsNeedAnAbsoluteCacheRootAndPassOnlyDiagnostics() {
        XCTAssertNil(HeadlessArguments.parse(["h"]))
        XCTAssertNil(HeadlessArguments.parse(["h", "--winter-cache-root=relative"]))
        let parsed = HeadlessArguments.parse(["h", "--winter-cache-root=/tmp/x", "--enable-logging=stderr", "--remote-debugging-port=9222",
                                              "--no-sandbox", "--v=1", "--no-proxy-server", "--proxy-server=direct://",
                                              "--host-resolver-rules=MAP * 10.0.0.1", "--log-net-log=/tmp/x/net.json"])
        XCTAssertEqual(parsed?.cacheRoot, "/tmp/x")
        XCTAssertEqual(parsed?.passthrough, ["--enable-logging=stderr", "--v=1", "--log-net-log=/tmp/x/net.json"])
        let argv = parsed?.chromiumArguments(program: "h") ?? []
        XCTAssertFalse(argv.contains { $0.hasPrefix("--remote-debugging") }, "never a debugging port")
        XCTAssertFalse(argv.contains("--no-sandbox"))
        XCTAssertTrue(argv.contains("--use-mock-keychain"))
        XCTAssertTrue(argv.contains("--enable-features=WebMCP"))
        XCTAssertTrue(argv.contains("--mute-audio"))
        XCTAssertTrue(argv.contains(HeadlessNetworkRule.hostResolverRulesSwitch))
        XCTAssertTrue(argv.contains(HeadlessNetworkRule.proxyPacSwitch))
        let disabled = Set((argv.first { $0.hasPrefix("--disable-features=") } ?? "").dropFirst("--disable-features=".count).split(separator: ",").map(String.init))
        for feature in ["MediaRouter", "DialMediaRouteProvider", "WebRtcHideLocalIpsWithMdns", "NetworkTimeServiceQuerying",
                        "AutofillServerCommunication", "AimEnabled"] {
            XCTAssertTrue(disabled.contains(feature), feature)
        }
        XCTAssertEqual(argv.filter { $0.hasPrefix("--disable-features=") }.count, 1, "one list (a second would replace the first)")
        for sw in ["--no-first-run", "--gaia-url=https://127.0.0.1:4/", "--disable-background-networking", "--disable-domain-reliability"] {
            XCTAssertTrue(argv.contains(sw), sw)
        }
        XCTAssertFalse(argv.contains("--disable-component-update"), "the component updater keeps the root store current")
        XCTAssertFalse(argv.contains { $0.hasPrefix("--no-proxy") || $0.hasPrefix("--proxy-server") }, "the PAC belt can't be replaced")
        XCTAssertEqual(argv.filter { $0.hasPrefix("--host-resolver-rules=") }, [HeadlessNetworkRule.hostResolverRulesSwitch])
    }
}
