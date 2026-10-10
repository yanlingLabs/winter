import AppKit
import XCTest
import WinterKit
@testable import Winter

/// ComputerV2 Phase 2 — the browser link's executor (`BrowserLinkHost`), end to end through BOTH seams:
/// the runtime's `CEFDriver` (the recorder `BrowserRuntimeTests` uses — so every create and stop here is
/// the real runtime executing a real plan) and the link's own `BrowserLinkCEFDriver`. No CEF anywhere,
/// no shell: every plan here is the headless planner's, which is the no-window case the link exists for.
@MainActor
final class BrowserLinkHostTests: XCTestCase {

    // MARK: - Doubles

    /// Records the link's CEF calls and hands back what a test needs to fire.
    final class LinkDriverRecorder {
        var log: [String] = []
        /// The browser id each container answers (`0` = not created yet).
        var browserIds: [ObjectIdentifier: Int] = [:]
        var eventObservers: [ObjectIdentifier: (String, Data, String?) -> Void] = [:]
        var crashObservers: [ObjectIdentifier: () -> Void] = [:]
        var nativeUI: [ObjectIdentifier: UInt32] = [:]
        /// Outstanding CDP calls, oldest first.
        var cdp: [(method: String, params: String, session: String?, complete: (WinterCEFCDPStatus, String) -> Void)] = []
        /// Whether a container holds a dialog `resolveHeldDialog` can answer.
        var heldDialog: Set<ObjectIdentifier> = []
        var resolved: [String] = []

        var driver: BrowserLinkCEFDriver {
            BrowserLinkCEFDriver(
                browserIdentifier: { [unowned self] in self.browserIds[ObjectIdentifier($0)] ?? 0 },
                sendCDP: { [unowned self] _, method, params, session, completion in
                    self.log.append("cdp \(method)")
                    self.cdp.append((method, params, session, completion))
                },
                setEventObserver: { [unowned self] container, observer in
                    self.eventObservers[ObjectIdentifier(container)] = observer
                    self.log.append("events=\(observer == nil ? "nil" : "set")")
                },
                setCrashObserver: { [unowned self] container, observer in
                    self.crashObservers[ObjectIdentifier(container)] = observer
                },
                setNativeUI: { [unowned self] container, flags in
                    self.nativeUI[ObjectIdentifier(container)] = flags
                    self.log.append("nativeUI=\(flags)")
                },
                resolveHeldDialog: { [unowned self] container, action, prompt in
                    let key = ObjectIdentifier(container)
                    self.resolved.append("\(action.rawValue):\(prompt ?? "-")")
                    return self.heldDialog.remove(key) != nil
                },
                reload: { [unowned self] _ in self.log.append("reload") })
        }

        func answer(_ status: WinterCEFCDPStatus, _ payload: String) {
            let call = cdp.removeFirst()
            call.complete(status, payload)
        }
    }

    final class FakeOutput: BrowserLinkOutput, @unchecked Sendable {
        var events: [(tabId: String, method: String, params: String, session: String?, strip: Bool)] = []
        var gone: [(String, BrowserLinkProtocol.TabGoneReason)] = []
        func emitEvent(tabId: String, method: String, params: Data, cdpSessionId: String?, stripNetworkParams: Bool) {
            events.append((tabId, method, String(decoding: params, as: UTF8.self), cdpSessionId, stripNetworkParams))
        }
        func tabGone(tabId: String, reason: BrowserLinkProtocol.TabGoneReason) { gone.append((tabId, reason)) }
    }

    /// A clock whose deferred work runs only when the test says.
    @MainActor
    final class ManualClock {
        var now = Date(timeIntervalSince1970: 2_000_000)
        var pending: [@MainActor () -> Void] = []
        var clock: BrowserLinkHost.Clock {
            BrowserLinkHost.Clock(now: { [unowned self] in self.now },
                                  after: { [unowned self] delay, work in
                                      self.pending.append { self.now = self.now.addingTimeInterval(delay); work() }
                                  })
        }
        func tick() {
            let work = pending
            pending = []
            for item in work { item() }
        }
    }

    // MARK: - Fixture

    private var cef: BrowserRuntimeTests.CEFRecorder!
    private var scheduler: BrowserRuntimeTests.FakeScheduler!
    private var runtime: BrowserRuntime!
    private var link: LinkDriverRecorder!
    private var clock: ManualClock!
    private var output: FakeOutput!
    private var host: BrowserLinkHost!

    override func setUp() async throws {
        cef = BrowserRuntimeTests.CEFRecorder()
        scheduler = BrowserRuntimeTests.FakeScheduler()
        runtime = BrowserRuntime(driver: cef.driver, scheduler: scheduler.scheduler)
        link = LinkDriverRecorder()
        clock = ManualClock()
        output = FakeOutput()
        host = BrowserLinkHost(runtime: runtime, driver: link.driver, clock: clock.clock)
        host.output = output
        host.browserLinkAttached(linkId: "L1")
    }

    override func tearDown() async throws {
        PanelWebTabModels.removeAllForTesting()
        host = nil
        runtime = nil
    }

    /// Run one command and return what it answered (`nil` while it has not).
    private final class Answer { var value: BrowserLinkReply? }

    private func run(_ op: BrowserLinkCommand.Op, cmdId: String = "c") -> Answer {
        let answer = Answer()
        host.browserLinkCommand(BrowserLinkCommand(linkId: "L1", cmdId: cmdId, op: op),
                                reply: BrowserLinkReplier { reply in
                                    MainActor.assumeIsolated { answer.value = reply }
                                })
        return answer
    }

    /// `tab.ensure` and make CEF "create" the browser, so the answer arrives.
    @discardableResult
    private func ensureLive(_ tabId: String = "t1", session: String = "s1", url: String? = "https://example.com/") -> PanelCEFContainerView {
        let answer = run(.tabEnsure(sessionId: session, tabId: tabId, url: url))
        let container = runtime.container(forTabId: tabId)!
        link.browserIds[ObjectIdentifier(container)] = 7
        clock.tick()
        guard case .ok = answer.value else {
            XCTFail("tab.ensure did not answer ok: \(String(describing: answer.value))")
            return container
        }
        return container
    }

    private func failureCode(_ answer: Answer) -> BrowserLinkProtocol.ErrorCode? {
        if case .failure(let code, _, _) = answer.value { return code }
        return nil
    }

    // MARK: - tab.ensure

    func testEnsureCreatesAParkedBrowserHoldsItAndAnswersOnceItExists() throws {
        let answer = run(.tabEnsure(sessionId: "s1", tabId: "t1", url: "https://example.com/"))
        // The plan created it — parked, at the hold's URL — but CEF has not made the browser yet.
        XCTAssertTrue(runtime.isLive(tabId: "t1"))
        XCTAssertTrue(cef.log.contains("c1 create url=https://example.com/"), "\(cef.log)")
        XCTAssertNil(answer.value, "no answer before the browser exists")
        XCTAssertEqual(runtime.holds["t1"], BrowserHold(sessionId: "s1", url: "https://example.com/"))
        let container = try XCTUnwrap(runtime.container(forTabId: "t1"))
        XCTAssertNil(container.window?.isVisible == true ? container : nil, "parked — in no visible window")
        XCTAssertEqual(link.nativeUI[ObjectIdentifier(container)], BrowserNativeUIPolicy.flags(held: true))
        XCTAssertNotNil(link.eventObservers[ObjectIdentifier(container)])
        XCTAssertNotNil(link.crashObservers[ObjectIdentifier(container)])

        clock.tick()
        XCTAssertNil(answer.value, "still not there")
        link.browserIds[ObjectIdentifier(container)] = 7
        clock.tick()
        guard case .ok(let result) = answer.value else { return XCTFail("\(String(describing: answer.value))") }
        XCTAssertNotNil(result["url"]?.stringValue)
        XCTAssertNotNil(result["loading"]?.boolValue)
        XCTAssertEqual(result["viewport"]?.arrayValue?.count, 2)
        XCTAssertEqual(result["viewport"]?.arrayValue?.first?.intValue, 1280, "a parked browser lays out at the parking size")
        XCTAssertNotNil(result["dpr"])
        XCTAssertEqual(host.heldTabIds, ["t1"])
    }

    func testEnsureOfALiveTabNeitherRecreatesNorNavigatesIt() {
        ensureLive()
        cef.forgetLog()
        let again = run(.tabEnsure(sessionId: "s1", tabId: "t1", url: "https://elsewhere.example/"))
        guard case .ok = again.value else { return XCTFail("a live held tab answers at once") }
        XCTAssertFalse(cef.log.contains { $0.contains("create") || $0.contains("load") }, "\(cef.log)")
    }

    func testEnsureAnswersNotLiveWhenTheEngineCannotStart() {
        cef.initialises = false
        cef.failure = "the helper bundle is missing"
        let answer = run(.tabEnsure(sessionId: "s1", tabId: "t1", url: nil))
        clock.tick()
        XCTAssertEqual(failureCode(answer), .notLive)
        if case .failure(_, let message, _) = answer.value { XCTAssertTrue(message.contains("helper bundle")) }
    }

    func testEnsureTimesOutWhenTheBrowserNeverArrives() {
        let answer = run(.tabEnsure(sessionId: "s1", tabId: "t1", url: nil))
        for _ in 0..<Int(BrowserLinkHost.ensureDeadline / BrowserLinkHost.ensurePollInterval) + 2 { clock.tick() }
        XCTAssertEqual(failureCode(answer), .timeout)
    }

    func testEverythingIsRefusedWhileQuitting() {
        runtime.quiesce()
        XCTAssertEqual(failureCode(run(.tabEnsure(sessionId: "s1", tabId: "t1", url: nil))), .quiescent)
        XCTAssertEqual(failureCode(run(.tabsLive)), .quiescent)
    }

    // MARK: - Holds versus the lifecycle

    func testAHeldTabSurvivesEveryPlanAndIsStoppedOnceReleased() throws {
        let container = ensureLive()
        // Any number of plans later — no shell, no fold: the belt would stop an unheld tab at once.
        BrowserHeadlessPlanner.replan(runtime: runtime)
        BrowserHeadlessPlanner.replan(runtime: runtime)
        XCTAssertTrue(runtime.isLive(tabId: "t1"))
        XCTAssertFalse(cef.log.contains("c1 close"))

        let released = run(.tabRelease(tabId: "t1"))
        XCTAssertEqual(released.value, .empty)
        XCTAssertFalse(runtime.isLive(tabId: "t1"), "released, in no list: the belt's again")
        XCTAssertTrue(cef.log.contains("c1 close"))
        XCTAssertEqual(link.nativeUI[ObjectIdentifier(container)], 0, "native UI back to CEF's defaults")
        XCTAssertNil(link.eventObservers[ObjectIdentifier(container)])
        XCTAssertTrue(output.gone.isEmpty, "a release the daemon asked for is not reported back")
        XCTAssertTrue(host.heldTabIds.isEmpty)
    }

    func testCloseStopsTheBrowserByTheHardenedPathAndReportsNothing() {
        ensureLive()
        let answer = run(.tabClose(tabId: "t1"))
        XCTAssertEqual(answer.value, .empty)
        XCTAssertFalse(runtime.isLive(tabId: "t1"))
        let closeAt = cef.log.firstIndex(of: "c1 close")
        let stateClearedAt = cef.log.firstIndex(of: "c1 state=nil")
        XCTAssertNotNil(closeAt)
        XCTAssertNotNil(stateClearedAt)
        XCTAssertLessThan(stateClearedAt ?? 0, closeAt ?? 0, "observers cleared before the close (the runtime's stop)")
        XCTAssertTrue(output.gone.isEmpty)
        XCTAssertNil(runtime.holds["t1"])
    }

    func testTheLinkGoingAwayReleasesEveryHold() {
        let first = ensureLive("t1")
        let second = ensureLive("t2", session: "s2")
        host.browserLinkLost()
        XCTAssertTrue(runtime.holds.isEmpty)
        XCTAssertTrue(host.heldTabIds.isEmpty)
        XCTAssertFalse(runtime.isLive(tabId: "t1"))
        XCTAssertFalse(runtime.isLive(tabId: "t2"))
        XCTAssertEqual(link.nativeUI[ObjectIdentifier(first)], 0)
        XCTAssertEqual(link.nativeUI[ObjectIdentifier(second)], 0)
    }

    func testAHeldTabStoppedByARouteTheLinkDidNotTakeIsReportedGone() {
        ensureLive()
        // Simulate a stop the link did not ask for: the hold vanishes underneath it, and a plan runs.
        runtime.releaseHold(tabId: "t1")
        BrowserHeadlessPlanner.replan(runtime: runtime)
        XCTAssertEqual(output.gone.map(\.0), ["t1"])
        XCTAssertEqual(output.gone.first?.1, .stopped)
    }

    func testACrashedRendererIsReportedAndReloadedAtTheNextEnsure() throws {
        let container = ensureLive()
        link.crashObservers[ObjectIdentifier(container)]?()
        XCTAssertEqual(output.gone.map(\.0), ["t1"])
        XCTAssertEqual(output.gone.first?.1, .crashed)
        XCTAssertNil(runtime.holds["t1"])

        link.log.removeAll()
        _ = run(.tabEnsure(sessionId: "s1", tabId: "t1", url: nil))
        XCTAssertTrue(link.log.contains("reload"))
    }

    // MARK: - tabs.live

    func testTabsLiveListsEveryLiveBrowserAndWhichAreHeld() {
        ensureLive("t1")
        ensureLive("t2", session: "s2")
        _ = run(.tabRelease(tabId: "t2"))   // stopped by the belt: gone from the list
        let answer = run(.tabsLive)
        guard case .ok(let value) = answer.value else { return XCTFail() }
        let rows = value["tabs"]?.arrayValue ?? []
        XCTAssertEqual(rows.compactMap { $0["tabId"]?.stringValue }, ["t1"])
        XCTAssertEqual(rows.first?["held"]?.boolValue, true)
    }

    // MARK: - cdp.send

    func testCDPToATabNotHeldIsNotLive() {
        XCTAssertEqual(failureCode(run(.cdpSend(tabId: "nope", method: "Page.enable", params: .object([:]), cdpSessionId: nil))),
                       .notLive)
        XCTAssertTrue(link.cdp.isEmpty)
    }

    func testAMethodOffTheAllowlistNeverReachesCEF() {
        ensureLive()
        let answer = run(.cdpSend(tabId: "t1", method: "Network.getCookies", params: .object([:]), cdpSessionId: nil))
        XCTAssertEqual(failureCode(answer), .notAllowed)
        XCTAssertTrue(link.cdp.isEmpty)
        let mainWorld = run(.cdpSend(tabId: "t1", method: "Runtime.evaluate",
                                     params: .object(["expression": .string("document.cookie")]), cdpSessionId: nil))
        XCTAssertEqual(failureCode(mainWorld), .notAllowed)
        XCTAssertTrue(link.cdp.isEmpty)
    }

    func testAnAllowedMethodIsSentAndItsResultAnsweredRaw() {
        ensureLive()
        let answer = run(.cdpSend(tabId: "t1", method: "Page.captureScreenshot",
                                  params: .object(["format": .string("jpeg"), "quality": .number(80)]), cdpSessionId: nil))
        XCTAssertEqual(link.cdp.first?.method, "Page.captureScreenshot")
        XCTAssertTrue(link.cdp.first?.params.contains("\"quality\":80") == true, link.cdp.first?.params ?? "")
        XCTAssertNil(link.cdp.first?.session)
        link.answer(.OK, #"{"data":"/9j/abc"}"#)
        XCTAssertEqual(answer.value, .okRaw(key: "result", json: #"{"data":"/9j/abc"}"#))
    }

    func testAChildSessionIsPassedThrough() {
        ensureLive()
        _ = run(.cdpSend(tabId: "t1", method: "DOM.getDocument", params: .object([:]), cdpSessionId: "S9"))
        XCTAssertEqual(link.cdp.first?.session, "S9")
    }

    func testTheWorldRulesFollowWhatTheBrowserReports() {
        let container = ensureLive()
        // An isolated world is created; its result names the context.
        let world = run(.cdpSend(tabId: "t1", method: "Page.createIsolatedWorld",
                                 params: .object(["frameId": .string("F1"), "worldName": .string("winter")]), cdpSessionId: nil))
        link.answer(.OK, #"{"executionContextId":41}"#)
        XCTAssertEqual(world.value, .ok(.object(["result": .object(["executionContextId": .number(41)])])))
        // …so an evaluate there passes, and one in a context reported only by an event passes too.
        _ = run(.cdpSend(tabId: "t1", method: "Runtime.evaluate", params: .object(["contextId": .number(41)]), cdpSessionId: nil))
        XCTAssertEqual(link.cdp.count, 1)
        link.eventObservers[ObjectIdentifier(container)]?("Runtime.executionContextCreated",
                                                         Data(#"{"context":{"id":52,"name":"winter","uniqueId":"x"}}"#.utf8), nil)
        _ = run(.cdpSend(tabId: "t1", method: "Runtime.evaluate", params: .object(["contextId": .number(52)]), cdpSessionId: nil))
        XCTAssertEqual(link.cdp.count, 2)
        // The page's own world stays out of reach.
        link.eventObservers[ObjectIdentifier(container)]?("Runtime.executionContextCreated",
                                                         Data(#"{"context":{"id":1,"name":""}}"#.utf8), nil)
        let page = run(.cdpSend(tabId: "t1", method: "Runtime.evaluate", params: .object(["contextId": .number(1)]), cdpSessionId: nil))
        XCTAssertEqual(failureCode(page), .notAllowed)
        XCTAssertEqual(link.cdp.count, 2)
    }

    func testFailuresAreTyped() {
        ensureLive()
        let protocolError = run(.cdpSend(tabId: "t1", method: "DOM.describeNode", params: .object([:]), cdpSessionId: nil))
        link.answer(.protocolError, #"{"code":-32000,"message":"Could not find node with given id"}"#)
        guard case .failure(let code, let message, let data) = protocolError.value else { return XCTFail() }
        XCTAssertEqual(code, .cdpError)
        XCTAssertEqual(message, "Could not find node with given id")
        XCTAssertEqual(data?["cdpCode"]?.intValue, -32000)
        XCTAssertEqual(data?["cdpMessage"]?.stringValue, "Could not find node with given id")

        let gone = run(.cdpSend(tabId: "t1", method: "Page.reload", params: .object([:]), cdpSessionId: nil))
        link.answer(.gone, #"{"message":"the tab's browser was closed"}"#)
        XCTAssertEqual(failureCode(gone), .tabGone)

        let notLive = run(.cdpSend(tabId: "t1", method: "Page.reload", params: .object([:]), cdpSessionId: nil))
        link.answer(.notLive, #"{"message":"this tab has no live browser"}"#)
        XCTAssertEqual(failureCode(notLive), .notLive)
    }

    // MARK: - Dialogs

    func testADialogDevToolsAnsweredIsDroppedFromTheTab() {
        let container = ensureLive()
        link.heldDialog.insert(ObjectIdentifier(container))
        let answer = run(.cdpSend(tabId: "t1", method: "Page.handleJavaScriptDialog",
                                  params: .object(["accept": .bool(true)]), cdpSessionId: nil))
        link.answer(.OK, "{}")
        XCTAssertEqual(link.resolved, ["\(WinterCEFHeldDialogAction.drop.rawValue):-"])
        guard case .okRaw = answer.value else { return XCTFail() }
    }

    func testADialogOutOfDevToolsReachIsAnsweredByTheTabItself() {
        let container = ensureLive()
        link.heldDialog.insert(ObjectIdentifier(container))
        let answer = run(.cdpSend(tabId: "t1", method: "Page.handleJavaScriptDialog",
                                  params: .object(["accept": .bool(true), "promptText": .string("hi")]), cdpSessionId: nil))
        link.answer(.protocolError, #"{"code":-32602,"message":"No dialog is showing"}"#)
        XCTAssertEqual(link.resolved, ["\(WinterCEFHeldDialogAction.accept.rawValue):hi"])
        XCTAssertEqual(answer.value, .ok(.object(["result": .object([:])])))
    }

    func testWithNoHeldDialogTheProtocolErrorStands() {
        ensureLive()
        let answer = run(.cdpSend(tabId: "t1", method: "Page.handleJavaScriptDialog",
                                  params: .object(["accept": .bool(false)]), cdpSessionId: nil))
        link.answer(.protocolError, #"{"code":-32602,"message":"No dialog is showing"}"#)
        XCTAssertEqual(failureCode(answer), .cdpError)
    }

    func testADialogClosedEventDropsTheTabsCopy() {
        let container = ensureLive()
        link.heldDialog.insert(ObjectIdentifier(container))
        link.eventObservers[ObjectIdentifier(container)]?("Page.javascriptDialogClosed", Data(#"{"result":true}"#.utf8), nil)
        XCTAssertEqual(link.resolved, ["\(WinterCEFHeldDialogAction.drop.rawValue):-"])
    }

    // MARK: - Events

    func testOnlySubscribedEventsLeaveAndNetworkOnesLeaveStripped() {
        let container = ensureLive()
        let fire = link.eventObservers[ObjectIdentifier(container)]!
        fire("Page.frameNavigated", Data(#"{"frame":{"id":"F"}}"#.utf8), nil)
        XCTAssertTrue(output.events.isEmpty, "nothing subscribed yet")

        XCTAssertEqual(run(.cdpSubscribe(tabId: "t1", events: ["Page.frameNavigated", "Network.requestWillBeSent"])).value, .empty)
        fire("Page.frameNavigated", Data(#"{"frame":{"id":"F"}}"#.utf8), nil)
        fire("Network.requestWillBeSent", Data(#"{"requestId":"r","timestamp":1,"type":"Document","request":{}}"#.utf8), "S1")
        fire("Page.loadEventFired", Data("{}".utf8), nil)
        XCTAssertEqual(output.events.map(\.method), ["Page.frameNavigated", "Network.requestWillBeSent"])
        XCTAssertEqual(output.events.map(\.strip), [false, true])
        XCTAssertEqual(output.events.last?.session, "S1")
        XCTAssertEqual(output.events.first?.tabId, "t1")
    }

    func testASubscribeOutsideTheAllowlistIsRefused() {
        ensureLive()
        let answer = run(.cdpSubscribe(tabId: "t1", events: ["Network.responseReceived"]))
        XCTAssertEqual(failureCode(answer), .notAllowed)
        XCTAssertEqual(failureCode(run(.cdpSubscribe(tabId: "nope", events: []))), .notLive)
    }

    func testOverlayIsABestEffortNoOp() {
        XCTAssertEqual(run(.overlay(tabId: "t1", active: true, cursor: nil)).value, .empty)
    }

    // MARK: - No native UI

    func testAHeldTabSuppressesEveryKindOfNativeUIAndAnUnheldOneNone() {
        let all: WinterCEFAutomationNativeUI = [.holdsJSDialogs, .deniesPermissions, .cancelsFileChooser, .cancelsDownloads]
        XCTAssertEqual(BrowserNativeUIPolicy.flags(held: true), all.rawValue)
        XCTAssertEqual(BrowserNativeUIPolicy.flags(held: false), 0)
        // And the decisions WinterCEF.mm's handlers make from those flags — computed by the very
        // functions the handlers call.
        XCTAssertEqual(WinterCEFAutomationDecisionsForFlags(BrowserNativeUIPolicy.flags(held: true)),
                       "jsdialog=held;beforeunload=held;permission=deny;media=deny;filechooser=cancel;download=refuse")
        XCTAssertEqual(WinterCEFAutomationDecisionsForFlags(BrowserNativeUIPolicy.flags(held: false)),
                       "jsdialog=default;beforeunload=default;permission=default;media=default;filechooser=default;download=default")
        XCTAssertTrue(WinterCEFClientInstallsTheAutomationHandlers(),
                      "a deleted getter would leave every override in the binary and the flags dead")
    }
}

/// ComputerV2 Phase 2 — the browser link's CEF door, through the seams that need no CEF.
final class BrowserLinkCEFSeamTests: XCTestCase {
    func testOnlyAChildSessionsEventIsTakenFromTheRawStream() {
        // A child target's event: its session is the message's LAST key.
        XCTAssertEqual(WinterCEFChildSessionOfDevToolsMessage(
            #"{"method":"Runtime.executionContextCreated","params":{"context":{"id":3}},"sessionId":"AB12CD"}"#),
            #"AB12CD Runtime.executionContextCreated {"context":{"id":3}}"#)
        // A child's RESULT settles by id like any other; the tab's own event goes to the structured callback.
        XCTAssertNil(WinterCEFChildSessionOfDevToolsMessage(#"{"id":12,"result":{},"sessionId":"AB12CD"}"#))
        XCTAssertNil(WinterCEFChildSessionOfDevToolsMessage(#"{"method":"Page.loadEventFired","params":{"timestamp":1}}"#))
        // A sessionId nested in the tab's own event's params is not a child's message.
        XCTAssertNil(WinterCEFChildSessionOfDevToolsMessage(
            #"{"method":"Target.attachedToTarget","params":{"sessionId":"AB12CD"}}"#))
        XCTAssertNil(WinterCEFChildSessionOfDevToolsMessage(
            #"{"method":"Target.attachedToTarget","params":{"targetInfo":{},"sessionId":"AB12CD"}}"#))
        XCTAssertNil(WinterCEFChildSessionOfDevToolsMessage(#"not json "sessionId":"x"}"#))
        XCTAssertNil(WinterCEFChildSessionOfDevToolsMessage(""))
    }

    func testOneCounterKeepsRawAndAssignedIdsApart() {
        // A raw send takes 1; the structured door is suggested 2 and CEF answers 7; the next raw is 8.
        XCTAssertEqual(WinterCEFCDPMessageIdsWithNoCEFAnywhere(), "1,7,8")
    }

    func testTheLinksCDPDoorAlwaysAnswersEvenWithNoEngine() {
        var answers: [(WinterCEFCDPStatus, String)] = []
        WinterCEFSendCDP(NSView(), "Page.enable", "{}", "") { status, payload in answers.append((status, payload ?? "")) }
        WinterCEFSendCDP(NSView(), "", "{}", "S") { status, payload in answers.append((status, payload ?? "")) }
        XCTAssertEqual(answers.map(\.0), [.notLive, .refused])
        XCTAssertTrue(answers[0].1.contains("not running"))
    }

    func testAContainerWithNoHeldDialogResolvesNothing() {
        let view = NSView()
        XCTAssertFalse(WinterCEFResolveHeldDialog(view, .accept, "x"))
        WinterCEFSetAutomationNativeUI(view, BrowserNativeUIPolicy.flags(held: true))
        WinterCEFSetAutomationNativeUI(view, 0)
        XCTAssertFalse(WinterCEFResolveHeldDialog(view, .dismiss, nil))
    }
}
