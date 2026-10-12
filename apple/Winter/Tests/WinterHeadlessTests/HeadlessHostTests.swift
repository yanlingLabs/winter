import AppKit
import XCTest

/// A driver with no CEF: records every call and answers from scripted state.
@MainActor
final class FakeHeadlessDriver {
    var created: [(key: NSView, url: String, sessionId: String)] = []
    var browserIds: [ObjectIdentifier: Int] = [:]
    var sent: [(method: String, params: String, session: String?)] = []
    var sendAnswer: (String) -> (HeadlessCDPStatus, String) = { _ in (.ok, "{}") }
    var eventObservers: [ObjectIdentifier: (String, Data, String?) -> Void] = [:]
    var crashObservers: [ObjectIdentifier: () -> Void] = [:]
    var stateObservers: [ObjectIdentifier: (String, String, Bool) -> Void] = [:]
    var locked: Set<ObjectIdentifier> = []
    var resolved: [HeadlessDialogAction] = []
    var heldDialog = false
    var closed: [ObjectIdentifier] = []
    var disposed: [String] = []
    var noticeObserver: ((Int, String) -> Void)?
    /// Presentations: started (browser id, request), ended, control changes; a scripted refusal.
    var presented: [(browserId: Int, request: HeadlessPresentRequest)] = []
    var unpresented = 0
    var controls: [Bool] = []
    var presentRefusal: String?
    var presentationEnded: ((String) -> Void)?
    /// Browsers appear at once unless a test says otherwise.
    var browsersArriveAtOnce = true

    var driver: HeadlessCEFDriver {
        HeadlessCEFDriver(
            create: { [unowned self] key, url, session in
                created.append((key, url, session))
                if browsersArriveAtOnce { browserIds[ObjectIdentifier(key)] = created.count }
            },
            browserIdentifier: { [unowned self] key in browserIds[ObjectIdentifier(key)] ?? 0 },
            sendCDP: { [unowned self] _, method, params, session, completion in
                sent.append((method, params, session))
                let (status, payload) = sendAnswer(method)
                completion(status, payload)
            },
            setEventObserver: { [unowned self] key, observer in eventObservers[ObjectIdentifier(key)] = observer },
            setCrashObserver: { [unowned self] key, observer in crashObservers[ObjectIdentifier(key)] = observer },
            setStateObserver: { [unowned self] key, observer in stateObservers[ObjectIdentifier(key)] = observer },
            lockNativeUI: { [unowned self] key in locked.insert(ObjectIdentifier(key)) },
            resolveHeldDialog: { [unowned self] _, action, _ in
                resolved.append(action)
                defer { heldDialog = false }
                return heldDialog
            },
            close: { [unowned self] key in
                closed.append(ObjectIdentifier(key))
                browserIds[ObjectIdentifier(key)] = nil
            },
            disposeContext: { [unowned self] session in disposed.append(session) },
            setNoticeObserver: { [unowned self] observer in noticeObserver = observer },
            present: { [unowned self] _, browserId, request, ended in
                if let presentRefusal { return .failure(HeadlessPresentFailure(message: presentRefusal)) }
                presented.append((browserId, request))
                presentationEnded = ended
                return .success((service: "com.winter.headless.present.test.\(presented.count)", handle: NSObject()))
            },
            unpresent: { [unowned self] _ in
                unpresented += 1
                return ["frames": 3]
            },
            setControl: { [unowned self] _, control in controls.append(control) })
    }
}

final class RecordingOutput: HeadlessOutput {
    var events: [(tabId: String, method: String, strip: Bool)] = []
    var gone: [(String, BrowserLinkProtocol.TabGoneReason)] = []
    var notices: [(tabId: String, kind: String)] = []
    func notice(tabId: String, kind: String) { notices.append((tabId, kind)) }
    var presentationsEnded: [(tabId: String, reason: String)] = []
    func presentationEnded(tabId: String, reason: String) { presentationsEnded.append((tabId, reason)) }
    func emitEvent(tabId: String, method: String, params: Data, cdpSessionId: String?, strip: Bool) {
        events.append((tabId, method, strip))
    }
    func tabGone(tabId: String, reason: BrowserLinkProtocol.TabGoneReason) { gone.append((tabId, reason)) }
}

@MainActor
final class HeadlessHostTests: XCTestCase {
    var fake: FakeHeadlessDriver!
    var host: HeadlessHost!
    var output: RecordingOutput!
    var pendingAfter: [(TimeInterval, @MainActor () -> Void)] = []
    var now = Date(timeIntervalSince1970: 1_000)

    override func setUp() async throws {
        fake = FakeHeadlessDriver()
        output = RecordingOutput()
        pendingAfter = []
        let clock = HeadlessHost.Clock(now: { [unowned self] in now }, after: { [unowned self] delay, work in pendingAfter.append((delay, work)) })
        host = HeadlessHost(driver: fake.driver, clock: clock)
        host.output = output
    }

    private func run(_ op: BrowserLinkCommand.Op) -> BrowserLinkReply? {
        var answer: BrowserLinkReply?
        host.handle(BrowserLinkCommand(linkId: "h-1", cmdId: "c", op: op), reply: HeadlessReplier { answer = $0 })
        return answer
    }

    private func open(_ tabId: String, session: String = "s_a", url: String = "https://example.com/") -> BrowserLinkReply? {
        run(.tabEnsure(sessionId: session, tabId: tabId, url: url))
    }

    private func failureCode(_ reply: BrowserLinkReply?) -> BrowserLinkProtocol.ErrorCode? {
        if case .failure(let code, _, _)? = reply { return code }
        return nil
    }

    func testEnsureWithAURLCreatesAWindowlessTabInItsSessionsContextWithNativeUILocked() {
        let reply = open("w-1")
        XCTAssertEqual(fake.created.count, 1)
        XCTAssertEqual(fake.created.first?.url, "https://example.com/")
        XCTAssertEqual(fake.created.first?.sessionId, "s_a")
        let key = ObjectIdentifier(fake.created[0].key)
        XCTAssertTrue(fake.locked.contains(key), "every native-UI flag is set before the browser exists")
        XCTAssertNotNil(fake.eventObservers[key])
        XCTAssertNotNil(fake.crashObservers[key])
        guard case .ok(let value)? = reply else { return XCTFail("expected ok, got \(String(describing: reply))") }
        XCTAssertEqual(value["viewport"], .array([.number(1280), .number(800)]))
        XCTAssertEqual(value["dpr"], .number(1))
        XCTAssertEqual(value["sessionId"], .string("s_a"))
    }

    func testEnsureWithoutAURLNeverBringsBackAMissingTab() {
        XCTAssertEqual(failureCode(run(.tabEnsure(sessionId: "s_a", tabId: "w-gone", url: nil))), .tabGone)
        XCTAssertTrue(fake.created.isEmpty)
    }

    func testEnsureReHoldsAnExistingTabWithoutCreatingAnother() {
        _ = open("w-1")
        XCTAssertNotNil(run(.tabRelease(tabId: "w-1")))
        if case .ok? = run(.tabEnsure(sessionId: "s_a", tabId: "w-1", url: nil)) {} else { XCTFail("re-hold") }
        XCTAssertEqual(fake.created.count, 1)
    }

    /// A refused popup or local-network request is said to the daemon by TAB — once per tab and kind per half second
    /// (a page looping `window.open` cannot flood the pipe); an unknown kind or browser is dropped.
    func testARefusalTheBrowserReportsIsANoticeForItsTab() {
        _ = open("w-1")
        _ = open("w-2")
        let observe = try! XCTUnwrap(fake.noticeObserver, "the host listens from the start")
        observe(2, "popup")
        observe(2, "popup")
        observe(1, "local-network")
        observe(1, "camera")
        observe(99, "popup")
        XCTAssertEqual(output.notices.map { "\($0.tabId) \($0.kind)" }, ["w-2 popup", "w-1 local-network"])
        now = now.addingTimeInterval(HeadlessHost.noticeInterval + 0.01)
        observe(2, "popup")
        XCTAssertEqual(output.notices.count, 3)
    }

    func testATabBelongsToItsOwnSessionOnly() {
        _ = open("w-1", session: "s_a")
        XCTAssertEqual(failureCode(run(.tabEnsure(sessionId: "s_b", tabId: "w-1", url: nil))), .notAllowed)
        XCTAssertEqual(failureCode(open("w-1", session: "s_b")), .notAllowed)
    }

    func testOnlyHttpPagesOrAboutBlankAreOpened() {
        XCTAssertEqual(failureCode(open("w-1", url: "javascript:alert(1)")), .notAllowed)
        XCTAssertEqual(failureCode(open("w-2", url: "file:///etc/hosts")), .notAllowed)
        XCTAssertEqual(failureCode(open("w-3", url: "chrome://settings")), .notAllowed)
        XCTAssertTrue(fake.created.isEmpty)
        if case .ok? = open("w-4", url: "about:blank") {} else { XCTFail("about:blank") }
    }

    func testTheHelpersOwnTabCeilingIsACapacityRefusal() {
        for i in 0..<HeadlessHost.maxTabs { _ = open("w-\(i)", session: "s_\(i % 3)") }
        let reply = open("w-over")
        guard case .failure(let code, _, let data)? = reply else { return XCTFail("expected a refusal") }
        XCTAssertEqual(code, .notAllowed)
        XCTAssertEqual(data?["capacity"], .bool(true))
        XCTAssertEqual(fake.created.count, HeadlessHost.maxTabs)
    }

    func testEnsureWaitsForCEFsAsynchronousCreationAndTimesOutClosingTheTab() {
        fake.browsersArriveAtOnce = false
        var answer: BrowserLinkReply?
        host.handle(BrowserLinkCommand(linkId: "h-1", cmdId: "c", op: .tabEnsure(sessionId: "s_a", tabId: "w-1", url: "https://a.test/")),
                    reply: HeadlessReplier { answer = $0 })
        XCTAssertNil(answer)
        XCTAssertEqual(pendingAfter.count, 1)
        now = now.addingTimeInterval(HeadlessHost.ensureDeadline + 1)
        let next = pendingAfter.removeFirst()
        next.1()
        XCTAssertEqual(failureCode(answer), .timeout)
        XCTAssertEqual(fake.closed.count, 1, "a browser that never arrived is closed")
        XCTAssertNil(host.tabs["w-1"])
    }

    func testCDPSendGoesThroughTheGate() {
        _ = open("w-1")
        // Not on the allowlist.
        XCTAssertEqual(failureCode(run(.cdpSend(tabId: "w-1", method: "Browser.close", params: .object([:]), cdpSessionId: nil))), .notAllowed)
        // The page's own world.
        XCTAssertEqual(failureCode(run(.cdpSend(tabId: "w-1", method: "Runtime.evaluate",
                                               params: .object(["expression": .string("1")]), cdpSessionId: nil))), .notAllowed)
        // A javascript: navigation.
        XCTAssertEqual(failureCode(run(.cdpSend(tabId: "w-1", method: "Page.navigate",
                                               params: .object(["url": .string("javascript:1")]), cdpSessionId: nil))), .notAllowed)
        XCTAssertTrue(fake.sent.isEmpty, "nothing refused reaches CEF")
    }

    func testAWinterWorldTheGateSawCreatedCanBeEvaluatedIn() {
        _ = open("w-1")
        fake.sendAnswer = { method in
            method == "Page.createIsolatedWorld" ? (.ok, #"{"executionContextId":7}"#) : (.ok, #"{"result":{"type":"number","value":1}}"#)
        }
        _ = run(.cdpSend(tabId: "w-1", method: "Page.createIsolatedWorld",
                         params: .object(["frameId": .string("F"), "worldName": .string("winter")]), cdpSessionId: nil))
        let reply = run(.cdpSend(tabId: "w-1", method: "Runtime.evaluate",
                                 params: .object(["expression": .string("1"), "contextId": .number(7)]), cdpSessionId: nil))
        guard case .ok? = reply else { return XCTFail("expected ok, got \(String(describing: reply))") }
        XCTAssertEqual(fake.sent.map(\.method), ["Page.createIsolatedWorld", "Runtime.evaluate"])
    }

    /// A click that navigates ends the winter world before the daemon hears of it: its next call there is
    /// answered in the browser's own words (what the daemon retries on), unsubscribed events or not.
    func testAWinterWorldThatEndedIsAnsweredInTheBrowsersWords() {
        _ = open("w-1")
        fake.sendAnswer = { _ in (.ok, #"{"executionContextId":7}"#) }
        _ = run(.cdpSend(tabId: "w-1", method: "Page.createIsolatedWorld",
                         params: .object(["frameId": .string("F"), "worldName": .string("winter")]), cdpSessionId: nil))
        fake.eventObservers[ObjectIdentifier(fake.created[0].key)]?("Runtime.executionContextDestroyed",
                                                                    Data(#"{"executionContextId":7}"#.utf8), nil)
        let reply = run(.cdpSend(tabId: "w-1", method: "Runtime.callFunctionOn",
                                 params: .object(["functionDeclaration": .string("f"), "executionContextId": .number(7)]),
                                 cdpSessionId: nil))
        guard case .failure(let code, let message, _)? = reply else { return XCTFail("expected a refusal") }
        XCTAssertEqual(code, .notAllowed)
        XCTAssertTrue(message.hasPrefix("Cannot find context with specified id"), message)
        XCTAssertEqual(fake.sent.map(\.method), ["Page.createIsolatedWorld"], "nothing refused reaches CEF")
    }

    func testAnOrdinaryResultLeavesRawAndAnUnheldTabIsNotLive() {
        _ = open("w-1")
        fake.sendAnswer = { _ in (.ok, #"{"data":"AAAA"}"#) }
        let reply = run(.cdpSend(tabId: "w-1", method: "Page.captureScreenshot", params: .object([:]), cdpSessionId: nil))
        XCTAssertEqual(reply, .okRaw(key: "result", json: #"{"data":"AAAA"}"#))
        _ = run(.tabRelease(tabId: "w-1"))
        XCTAssertEqual(failureCode(run(.cdpSend(tabId: "w-1", method: "Page.captureScreenshot", params: .object([:]), cdpSessionId: nil))), .notLive)
        XCTAssertEqual(failureCode(run(.cdpSend(tabId: "w-none", method: "Page.captureScreenshot", params: .object([:]), cdpSessionId: nil))), .tabGone)
    }

    func testAWorldResultThatCantBeReadIsAnErrorNotEmpty() {
        _ = open("w-1")
        fake.sendAnswer = { method in
            method == "Page.createIsolatedWorld" ? (.ok, #"{"executionContextId":7}"#) : (.ok, #"{"result":{"type":"string","value":"x\ud83d"}}"#)
        }
        _ = run(.cdpSend(tabId: "w-1", method: "Page.createIsolatedWorld",
                         params: .object(["frameId": .string("F"), "worldName": .string("winter")]), cdpSessionId: nil))
        let reply = run(.cdpSend(tabId: "w-1", method: "Runtime.evaluate",
                                 params: .object(["expression": .string("1"), "contextId": .number(7)]), cdpSessionId: nil))
        guard case .failure(let code, let message, let data)? = reply else { return XCTFail("an unreadable result must not read as empty") }
        XCTAssertEqual(code, .cdpError)
        XCTAssertEqual(message, "the browser's answer to Runtime.evaluate could not be read")
        XCTAssertEqual(data?["cdpCode"]?.intValue, -32603)
    }

    private func presentRequest(_ tabId: String = "w-1") -> HeadlessPresentRequest {
        HeadlessPresentRequest(tabId: tabId, nonce: 0x0123_4567_89ab_cdef, viewerRequirement: #"identifier "com.winter.app.dev""#,
                               control: false, scale: 2)
    }

    func testAPresentationNeedsALiveTabAndAnswersItsServiceAndSize() {
        var answer: BrowserLinkReply?
        host.present(presentRequest(), reply: HeadlessReplier { answer = $0 })
        XCTAssertEqual(failureCode(answer), .tabGone, "no such tab")
        _ = open("w-1")
        host.present(presentRequest(), reply: HeadlessReplier { answer = $0 })
        guard case .ok(let value)? = answer else { return XCTFail("\(String(describing: answer))") }
        XCTAssertEqual(value["service"]?.stringValue, "com.winter.headless.present.test.1")
        XCTAssertEqual(value["cssWidth"], .number(1280))
        XCTAssertEqual(value["cssHeight"], .number(800))
        XCTAssertEqual(fake.presented.map(\.browserId), [1])
        XCTAssertEqual(fake.presented.first?.request.scale, 2)
    }

    func testPresentingAgainEndsTheOldPresentationAndControlAndUnpresentReachIt() {
        _ = open("w-1")
        host.present(presentRequest(), reply: HeadlessReplier { _ in })
        host.present(presentRequest(), reply: HeadlessReplier { _ in })
        XCTAssertEqual(fake.unpresented, 1, "the first presentation ended before the second")
        XCTAssertTrue(host.setControl(tabId: "w-1", control: true))
        XCTAssertEqual(fake.controls, [true])
        XCTAssertEqual(host.unpresent(tabId: "w-1"), ["frames": 3])
        XCTAssertEqual(host.unpresent(tabId: "w-1"), [:], "nothing left to end")
        XCTAssertFalse(host.setControl(tabId: "w-1", control: false), "not presented")
    }

    func testAViewerThatEndsThePresentationIsSaidAndClosingTheTabEndsIt() {
        _ = open("w-1")
        host.present(presentRequest(), reply: HeadlessReplier { _ in })
        fake.presentationEnded?("the viewer went away")
        XCTAssertEqual(output.presentationsEnded.map(\.reason), ["the viewer went away"])
        XCTAssertEqual(host.unpresent(tabId: "w-1"), [:], "already ended")
        host.present(presentRequest(), reply: HeadlessReplier { _ in })
        _ = run(.tabClose(tabId: "w-1"))
        XCTAssertEqual(fake.unpresented, 1, "closing a presented tab ends its presentation")
    }

    func testARefusedPresentationIsAFailure() {
        _ = open("w-1")
        fake.presentRefusal = "no Metal device"
        var answer: BrowserLinkReply?
        host.present(presentRequest(), reply: HeadlessReplier { answer = $0 })
        XCTAssertEqual(failureCode(answer), .notAllowed)
    }

    func testTheHeldDialogFallbackAnswersWhatDevToolsCannotReach() {
        _ = open("w-1")
        fake.heldDialog = true
        fake.sendAnswer = { _ in (.protocolError, #"{"code":-32000,"message":"No dialog is showing"}"#) }
        let reply = run(.cdpSend(tabId: "w-1", method: "Page.handleJavaScriptDialog", params: .object(["accept": .bool(true)]), cdpSessionId: nil))
        guard case .ok? = reply else { return XCTFail("the tab answers its held dialog itself") }
        XCTAssertEqual(fake.resolved, [.accept])
    }

    func testOnlySubscribedEventsOfAHeldTabLeaveAndNetworkOnesAreStripped() {
        _ = open("w-1")
        let key = ObjectIdentifier(fake.created[0].key)
        fake.eventObservers[key]?("Page.loadEventFired", Data("{}".utf8), nil)
        XCTAssertTrue(output.events.isEmpty, "nothing is subscribed yet")
        XCTAssertNotNil(run(.cdpSubscribe(tabId: "w-1", events: ["Page.loadEventFired", "Network.requestWillBeSent"])))
        fake.eventObservers[key]?("Page.loadEventFired", Data("{}".utf8), nil)
        fake.eventObservers[key]?("Network.requestWillBeSent", Data("{}".utf8), nil)
        XCTAssertEqual(output.events.map(\.method), ["Page.loadEventFired", "Network.requestWillBeSent"])
        XCTAssertEqual(output.events.map(\.strip), [false, true])
        _ = run(.tabRelease(tabId: "w-1"))
        fake.eventObservers[key]?("Page.loadEventFired", Data("{}".utf8), nil)
        XCTAssertEqual(output.events.count, 2, "a released tab's events stop")
        XCTAssertEqual(failureCode(run(.cdpSubscribe(tabId: "w-1", events: ["Browser.downloadProgress"]))), .notLive)
    }

    func testARendererCrashLosesTheTab() {
        _ = open("w-1")
        let key = ObjectIdentifier(fake.created[0].key)
        fake.crashObservers[key]?()
        XCTAssertEqual(output.gone.map(\.0), ["w-1"])
        XCTAssertEqual(output.gone.map(\.1), [.crashed])
        XCTAssertEqual(fake.closed, [key])
        XCTAssertNil(host.tabs["w-1"])
        XCTAssertEqual(failureCode(run(.tabEnsure(sessionId: "s_a", tabId: "w-1", url: nil))), .tabGone)
    }

    func testCloseClosesTheBrowserWithNoGoneReport() {
        _ = open("w-1")
        _ = run(.tabClose(tabId: "w-1"))
        XCTAssertEqual(fake.closed.count, 1)
        XCTAssertTrue(output.gone.isEmpty)
        XCTAssertNil(host.tabs["w-1"])
    }

    func testContextDisposeClosesOnlyThatSessionsTabsAndForgetsItsContext() {
        _ = open("w-1", session: "s_a")
        _ = open("w-2", session: "s_a")
        _ = open("w-3", session: "s_b")
        XCTAssertEqual(host.disposeContext(sessionId: "s_a"), 2)
        XCTAssertEqual(fake.disposed, ["s_a"])
        XCTAssertEqual(Set(host.tabs.keys), ["w-3"])
        XCTAssertEqual(fake.closed.count, 2)
    }

    func testTabsLiveNamesEachTabsSession() {
        _ = open("w-1", session: "s_a")
        _ = open("w-2", session: "s_b")
        guard case .ok(let value)? = run(.tabsLive), let rows = value["tabs"]?.arrayValue else { return XCTFail("rows") }
        XCTAssertEqual(rows.compactMap { $0["sessionId"]?.stringValue }, ["s_a", "s_b"])
        XCTAssertEqual(rows.compactMap { $0["held"]?.boolValue }, [true, true])
    }

    func testWhatAHeadlessTabCannotDoIsRefused() {
        _ = open("w-1")
        XCTAssertEqual(failureCode(run(.tabPresent(sessionId: "s_a", tabId: "w-1"))), .notAllowed)
        XCTAssertEqual(failureCode(run(.tabMute(tabId: "w-1", muted: true))), .notAllowed)
        XCTAssertEqual(failureCode(run(.tabDownloads(tabId: "w-1", arm: .init(dir: "/tmp", until: 1, maxBytes: 1)))), .notAllowed)
        XCTAssertEqual(failureCode(run(.tabDownload(tabId: "w-1", url: "https://a.test/f.zip"))), .notAllowed)
        if case .ok? = run(.overlay(tabId: "w-1", active: true, cursor: nil)) {} else { XCTFail("overlay is a no-op") }
    }

    func testTheStateObserverFeedsTheLiveRows() {
        _ = open("w-1")
        let key = ObjectIdentifier(fake.created[0].key)
        fake.stateObservers[key]?("https://example.com/next", "Next", false)
        guard case .ok(let value)? = run(.tabsLive), let row = value["tabs"]?.arrayValue?.first else { return XCTFail("rows") }
        XCTAssertEqual(row["url"], .string("https://example.com/next"))
        XCTAssertEqual(row["title"], .string("Next"))
    }

    func testAReplierAnswersOnce() {
        var answers: [BrowserLinkReply] = []
        let reply = HeadlessReplier { answers.append($0) }
        reply(.empty)
        reply(.failure(code: .timeout, message: "late"))
        XCTAssertEqual(answers, [.empty])
    }
}
