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
        /// Phase 3: the download arms, the download observers, the downloads started, the mutes.
        var arms: [ObjectIdentifier: (dir: String?, until: Double, maxBytes: Int64)] = [:]
        var downloadObservers: [ObjectIdentifier: ([AnyHashable: Any]) -> Void] = [:]
        var started: [String] = []
        var muted: [ObjectIdentifier: Bool] = [:]

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
                reload: { [unowned self] _ in self.log.append("reload") },
                setDownloadArm: { [unowned self] container, dir, until, maxBytes in
                    self.arms[ObjectIdentifier(container)] = (dir, until, maxBytes)
                    self.log.append("arm=\(dir ?? "nil")")
                },
                setDownloadObserver: { [unowned self] container, observer in
                    self.downloadObservers[ObjectIdentifier(container)] = observer
                },
                startDownload: { [unowned self] _, url in self.started.append(url); return true },
                setAudioMuted: { [unowned self] container, muted in self.muted[ObjectIdentifier(container)] = muted })
        }

        func answer(_ status: WinterCEFCDPStatus, _ payload: String) {
            let call = cdp.removeFirst()
            call.complete(status, payload)
        }
    }

    final class FakeOutput: BrowserLinkOutput, @unchecked Sendable {
        var events: [(tabId: String, method: String, params: String, session: String?, strip: Bool)] = []
        var gone: [(String, BrowserLinkProtocol.TabGoneReason)] = []
        var downloads: [(String, JSONValue)] = []
        func download(tabId: String, download: JSONValue) { downloads.append((tabId, download)) }
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
    /// Phase 3: the app's downloads folder (`<home>/cache/downloads`), a temp directory.
    private var downloadsRoot: URL!

    override func setUp() async throws {
        cef = BrowserRuntimeTests.CEFRecorder()
        scheduler = BrowserRuntimeTests.FakeScheduler()
        runtime = BrowserRuntime(driver: cef.driver, scheduler: scheduler.scheduler)
        link = LinkDriverRecorder()
        clock = ManualClock()
        output = FakeOutput()
        downloadsRoot = FileManager.default.temporaryDirectory.appendingPathComponent("winter-link-downloads-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: downloadsRoot.appendingPathComponent("s1/abc"), withIntermediateDirectories: true)
        let root = downloadsRoot!
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        host = BrowserLinkHost(runtime: runtime, driver: link.driver, clock: clock.clock, downloadsRoot: downloadsRoot.path)
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

    // MARK: - A ceiling on holds

    /// Each hold is a renderer the engine may not stop, so their number has a ceiling — a hold past it
    /// is refused, typed, and releasing one makes room again.
    func testHoldsPastTheCeilingAreRefused() {
        for i in 0..<BrowserLinkHost.maxHeldTabs { ensureLive("t\(i)", session: "s") }
        XCTAssertEqual(host.heldTabIds.count, BrowserLinkHost.maxHeldTabs)
        let refused = run(.tabEnsure(sessionId: "s", tabId: "one-too-many", url: nil))
        XCTAssertEqual(failureCode(refused), .notAllowed)
        XCTAssertFalse(runtime.isLive(tabId: "one-too-many"), "no renderer for a refused hold")
        XCTAssertNil(runtime.holds["one-too-many"])
        // An existing hold is still ensured at the ceiling…
        guard case .ok = run(.tabEnsure(sessionId: "s", tabId: "t0", url: nil)).value else { return XCTFail() }
        // …and a release makes room.
        _ = run(.tabRelease(tabId: "t0"))
        ensureLive("one-too-many", session: "s")
        XCTAssertEqual(host.heldTabIds.count, BrowserLinkHost.maxHeldTabs)
    }

    /// A result the gate must decode (a world method's) is bounded too, before it is decoded: a page
    /// whose text runs to megabytes must not make a line the daemon drops.
    func testAnOversizedWorldResultIsRefusedNotSent() {
        ensureLive()
        let world = run(.cdpSend(tabId: "t1", method: "Page.createIsolatedWorld",
                                 params: .object(["frameId": .string("F"), "worldName": .string("winter")]), cdpSessionId: nil))
        link.answer(.OK, #"{"executionContextId":4}"#)
        guard case .ok = world.value else { return XCTFail() }
        let big = run(.cdpSend(tabId: "t1", method: "Runtime.evaluate", params: .object(["contextId": .number(4)]), cdpSessionId: nil))
        link.answer(.OK, #"{"result":{"type":"string","value":""# + String(repeating: "a", count: BrowserLinkProtocol.resultLineCap) + #""}}"#)
        guard case .failure(let code, _, let data) = big.value else { return XCTFail("an over-cap result must not be sent") }
        XCTAssertEqual(code, .cdpError)
        XCTAssertEqual(data?["cdpCode"]?.intValue, -32603)
    }

    /// A result the gate must read (a world method's, a response body) that Swift's decoder refuses — a lone surrogate
    /// Chromium wrote for a string cut mid-pair — is an error, never a silently empty `{"result":{}}`.
    func testAWorldResultThatCantBeReadIsAnErrorNotEmpty() {
        ensureLive()
        let world = run(.cdpSend(tabId: "t1", method: "Page.createIsolatedWorld",
                                 params: .object(["frameId": .string("F"), "worldName": .string("winter")]), cdpSessionId: nil))
        link.answer(.OK, #"{"executionContextId":4}"#)
        guard case .ok = world.value else { return XCTFail() }
        let cut = run(.cdpSend(tabId: "t1", method: "Runtime.evaluate", params: .object(["contextId": .number(4)]), cdpSessionId: nil))
        link.answer(.OK, #"{"result":{"type":"string","value":"x\ud83d"}}"#)
        guard case .failure(let code, let message, let data) = cut.value else { return XCTFail("an unreadable result must not read as empty") }
        XCTAssertEqual(code, .cdpError)
        XCTAssertEqual(message, "the browser's answer to Runtime.evaluate could not be read")
        XCTAssertEqual(data?["cdpCode"]?.intValue, -32603)
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
        // …so an evaluate there passes, and so does one in the winter world of a new document in the
        // frame the link made its world in (reported only by an event).
        _ = run(.cdpSend(tabId: "t1", method: "Runtime.evaluate", params: .object(["contextId": .number(41)]), cdpSessionId: nil))
        XCTAssertEqual(link.cdp.count, 1)
        link.eventObservers[ObjectIdentifier(container)]?("Runtime.executionContextCreated",
                                                         Data(#"{"context":{"id":52,"name":"winter","uniqueId":"x","auxData":{"frameId":"F1"}}}"#.utf8), nil)
        _ = run(.cdpSend(tabId: "t1", method: "Runtime.evaluate", params: .object(["contextId": .number(52)]), cdpSessionId: nil))
        XCTAssertEqual(link.cdp.count, 2)
        // A world merely NAMED "winter" in a frame the link never made one in is someone else's.
        link.eventObservers[ObjectIdentifier(container)]?("Runtime.executionContextCreated",
                                                         Data(#"{"context":{"id":53,"name":"winter","uniqueId":"y","auxData":{"frameId":"F2"}}}"#.utf8), nil)
        let foreign = run(.cdpSend(tabId: "t1", method: "Runtime.evaluate", params: .object(["contextId": .number(53)]), cdpSessionId: nil))
        XCTAssertEqual(failureCode(foreign), .notAllowed)
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
        let answer = run(.cdpSubscribe(tabId: "t1", events: ["Network.requestWillBeSentExtraInfo"]))
        XCTAssertEqual(failureCode(answer), .notAllowed)
        XCTAssertEqual(failureCode(run(.cdpSubscribe(tabId: "nope", events: []))), .notLive)
    }

    func testOverlayIsABestEffortNoOp() {
        XCTAssertEqual(run(.overlay(tabId: "t1", active: true, cursor: nil)).value, .empty)
    }

    // MARK: - Phase 3 (link protocol 2)

    func testPresentShowsTheTabThroughTheAppAndGivesTheUserItsNativeUIBack() {
        XCTAssertEqual(failureCode(run(.tabPresent(sessionId: "s1", tabId: "t1"))), .notAllowed, "nobody to show it")
        let container = ensureLive()
        var shown: [String] = []
        host.onPresent = { sessionId, tabId in shown.append("\(sessionId)/\(tabId)") }
        XCTAssertEqual(run(.tabPresent(sessionId: "s1", tabId: "t1")).value, .empty)
        XCTAssertEqual(shown, ["s1/t1"])
        XCTAssertEqual(link.nativeUI[ObjectIdentifier(container)], 0, "dialogs, prompts, keys and focus are the user's again")
        // Taken again later: suppressed again.
        _ = run(.tabEnsure(sessionId: "s1", tabId: "t1", url: nil))
        XCTAssertEqual(link.nativeUI[ObjectIdentifier(container)], BrowserNativeUIPolicy.flags(held: true))
    }

    func testMuteReachesTheTabsBrowser() {
        XCTAssertEqual(failureCode(run(.tabMute(tabId: "t1", muted: true))), .notLive)
        let container = ensureLive()
        XCTAssertEqual(run(.tabMute(tabId: "t1", muted: true)).value, .empty)
        XCTAssertEqual(link.muted[ObjectIdentifier(container)], true)
    }

    func testTheDownloadArmTakesOnlyAFolderInsideTheAppsDownloadsFolder() {
        let container = ensureLive()
        let inside = downloadsRoot.appendingPathComponent("s1/abc").path
        XCTAssertEqual(run(.tabDownloads(tabId: "t1", arm: .init(dir: inside, until: 9e12, maxBytes: 10))).value, .empty)
        // Armed with the path that was checked: standardised, links resolved (/var → /private/var here).
        let resolvedInside = URL(fileURLWithPath: inside).standardizedFileURL.resolvingSymlinksInPath().path
        XCTAssertEqual(link.arms[ObjectIdentifier(container)]?.dir, resolvedInside)
        // A spelling with `..` that still lands inside is armed with the resolved path, not as written.
        let dotted = downloadsRoot.appendingPathComponent("s1/abc/../abc").path
        XCTAssertEqual(run(.tabDownloads(tabId: "t1", arm: .init(dir: dotted, until: 9e12, maxBytes: 10))).value, .empty)
        XCTAssertEqual(link.arms[ObjectIdentifier(container)]?.dir, resolvedInside)
        XCTAssertEqual(link.arms[ObjectIdentifier(container)]?.maxBytes, 10)
        for outside in [NSTemporaryDirectory(), downloadsRoot.path, downloadsRoot.appendingPathComponent("s1/../..").path,
                        downloadsRoot.appendingPathComponent("s1/missing").path] {
            XCTAssertEqual(failureCode(run(.tabDownloads(tabId: "t1", arm: .init(dir: outside, until: 9e12, maxBytes: 10)))), .notAllowed, outside)
        }
        // A link out of the folder is followed, and refused.
        let escape = downloadsRoot.appendingPathComponent("s1/escape")
        try? FileManager.default.createSymbolicLink(atPath: escape.path, withDestinationPath: NSTemporaryDirectory())
        XCTAssertEqual(failureCode(run(.tabDownloads(tabId: "t1", arm: .init(dir: escape.path, until: 9e12, maxBytes: 10)))), .notAllowed)
        XCTAssertEqual(run(.tabDownloads(tabId: "t1", arm: nil)).value, .empty)
        XCTAssertNil(link.arms[ObjectIdentifier(container)]?.dir)
        // Releasing the tab disarms it too.
        _ = run(.tabDownloads(tabId: "t1", arm: .init(dir: inside, until: 9e12, maxBytes: 10)))
        _ = run(.tabRelease(tabId: "t1"))
        XCTAssertNil(link.arms[ObjectIdentifier(container)]?.dir)
    }

    func testADownloadStartsOnlyForAnHttpURLInAHeldTab() {
        XCTAssertEqual(failureCode(run(.tabDownload(tabId: "t1", url: "https://x/a.csv"))), .notLive)
        ensureLive()
        XCTAssertEqual(run(.tabDownload(tabId: "t1", url: "https://x/a.csv")).value, .empty)
        XCTAssertEqual(failureCode(run(.tabDownload(tabId: "t1", url: "file:///etc/hosts"))), .notAllowed)
        XCTAssertEqual(link.started, ["https://x/a.csv"])
    }

    func testDownloadReportsGoToTheDaemonWithProgressThinnedOut() throws {
        let container = ensureLive()
        let report = try XCTUnwrap(link.downloadObservers[ObjectIdentifier(container)])
        report(["id": "cef-1", "state": "started", "name": "a.csv", "bytes": NSNumber(value: 0), "totalBytes": NSNumber(value: 4)])
        report(["id": "cef-1", "state": "progress", "name": "a.csv", "bytes": NSNumber(value: 1)])
        report(["id": "cef-1", "state": "progress", "name": "a.csv", "bytes": NSNumber(value: 2)])
        clock.now = clock.now.addingTimeInterval(1)
        report(["id": "cef-1", "state": "progress", "name": "a.csv", "bytes": NSNumber(value: 3)])
        report(["id": "cef-1", "state": "done", "name": "a.csv", "bytes": NSNumber(value: 4), "path": "/h/a.csv", "mime": "text/csv"])
        report(["id": "x", "state": "exploded", "name": "b", "bytes": NSNumber(value: 1)])
        XCTAssertEqual(output.downloads.map { $0.1["state"]?.stringValue }, ["started", "progress", "progress", "done"])
        XCTAssertEqual(output.downloads.last?.1["path"]?.stringValue, "/h/a.csv")
        XCTAssertEqual(output.downloads.last?.0, "t1")
        _ = run(.tabRelease(tabId: "t1"))
        XCTAssertNil(link.downloadObservers[ObjectIdentifier(container)], "a released tab reports nothing")
    }

    /// Review MEDIUM 5: a re-arm (and a disarm, and the link letting go) CANCELS what the earlier arm still follows — the
    /// one whose callback is known at once, the one without at its first update — never leaves it running past the cap.
    func testARearmCancelsEveryDownloadTheEarlierArmFollows() {
        XCTAssertEqual(WinterCEFDownloadFollowingDecisions(), "followed=2;after=0;one=1;two=1;twoCancelling=1;unknownCancelling=0")
    }

    /// Review MEDIUM 5: the arm's deadline ends it by itself, even if no download update ever comes again.
    func testTheArmsDeadlineEndsItWithNoUpdate() {
        let view = NSView()
        WinterCEFSetDownloadArm(view, "/tmp/winter-arm-test", Date().timeIntervalSince1970 * 1000 + 150, 10)
        XCTAssertTrue(WinterCEFDownloadArmed(view))
        let ended = expectation(description: "the deadline ends the arm")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            XCTAssertFalse(WinterCEFDownloadArmed(view))
            ended.fulfill()
        }
        wait(for: [ended], timeout: 3)
        // A disarm ends it at once too.
        WinterCEFSetDownloadArm(view, "/tmp/winter-arm-test", Date().timeIntervalSince1970 * 1000 + 60_000, 10)
        XCTAssertTrue(WinterCEFDownloadArmed(view))
        WinterCEFSetDownloadArm(view, nil, 0, 0)
        XCTAssertFalse(WinterCEFDownloadArmed(view))
    }

    func testAnArmedDownloadsFileNameIsSafe() {
        XCTAssertEqual(WinterCEFDownloadFileName("report.csv"), "report.csv")
        XCTAssertEqual(WinterCEFDownloadFileName("../../etc/passwd"), "passwd")
        XCTAssertEqual(WinterCEFDownloadFileName("..\\win.ini"), "win.ini")
        XCTAssertEqual(WinterCEFDownloadFileName("...env"), "env")
        XCTAssertEqual(WinterCEFDownloadFileName("a:b\u{7}c.txt"), "abc.txt")
        XCTAssertEqual(WinterCEFDownloadFileName(""), "download")
        let long = WinterCEFDownloadFileName(String(repeating: "é", count: 150) + ".tar.gz") ?? ""
        XCTAssertLessThanOrEqual(long.utf8.count, 200)
        XCTAssertTrue(long.hasSuffix(".gz"))
    }

    // MARK: - No native UI

    func testAHeldTabSuppressesEveryKindOfNativeUIAndAnUnheldOneNone() {
        let all: WinterCEFAutomationNativeUI = [.holdsJSDialogs, .deniesPermissions, .cancelsFileChooser, .cancelsDownloads,
                                                .suppressesContextMenus, .swallowsUnhandledKeys, .refusesFocus, .exitsFullscreen]
        XCTAssertEqual(BrowserNativeUIPolicy.flags(held: true), all.rawValue)
        XCTAssertEqual(BrowserNativeUIPolicy.flags(held: false), 0)
        // And the decisions WinterCEF.mm's handlers make from those flags — computed by the very
        // functions the handlers call.
        XCTAssertEqual(WinterCEFAutomationDecisionsForFlags(BrowserNativeUIPolicy.flags(held: true)),
                       "jsdialog=held;beforeunload=held;permission=deny;media=deny;filechooser=cancel;download=refuse;"
                       + "contextmenu=none;unhandledkeys=swallow;focus=refuse;fullscreen=exit")
        XCTAssertEqual(WinterCEFAutomationDecisionsForFlags(BrowserNativeUIPolicy.flags(held: false)),
                       "jsdialog=default;beforeunload=default;permission=default;media=default;filechooser=default;"
                       + "download=default;contextmenu=default;unhandledkeys=default;focus=default;fullscreen=default")
        XCTAssertTrue(WinterCEFClientInstallsTheAutomationHandlers(),
                      "a deleted getter would leave every override in the binary and the flags dead")
    }

    /// Every flag is its own: dropping any one kind from the held set shows up as that kind alone
    /// answering "default".
    func testEachNativeUIFlagDecidesExactlyItsOwnKind() {
        let kinds: [(WinterCEFAutomationNativeUI, String)] = [
            (.holdsJSDialogs, "jsdialog=held"), (.deniesPermissions, "permission=deny"),
            (.cancelsFileChooser, "filechooser=cancel"), (.cancelsDownloads, "download=refuse"),
            (.suppressesContextMenus, "contextmenu=none"), (.swallowsUnhandledKeys, "unhandledkeys=swallow"),
            (.refusesFocus, "focus=refuse"), (.exitsFullscreen, "fullscreen=exit"),
        ]
        for (flag, decision) in kinds {
            let alone: String = WinterCEFAutomationDecisionsForFlags(flag.rawValue) ?? ""
            XCTAssertTrue(alone.contains(decision), "\(decision) from its own flag")
            let without: String = WinterCEFAutomationDecisionsForFlags(BrowserNativeUIPolicy.flags(held: true) & ~flag.rawValue) ?? ""
            XCTAssertFalse(without.contains(decision), "\(decision) without its flag")
        }
    }
}

/// ComputerV2 Phase 2 — the browser link's CEF door, through the seams that need no CEF.
final class BrowserLinkCEFSeamTests: XCTestCase {
    func testOnlyAChildSessionsEventIsTakenFromTheRawStream() {
        // A child target's event: its session is the message's LAST key.
        XCTAssertEqual(WinterCEFChildSessionOfDevToolsMessage(
            #"{"method":"Runtime.executionContextCreated","params":{"context":{"id":3}},"sessionId":"AB12CD"}"#),
            #"AB12CD Runtime.executionContextCreated {"context":{"id":3}}"#)
        // A child's RESULT is not an event (the raw observer settles it); the tab's own event goes to the
        // structured callback.
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

    /// The raw observer's whole decision, against calls pending on a browser: a flattened child's RESULT settles its
    /// call by id — read by slicing, so one Foundation can't parse (a lone surrogate) settles all the same, and one
    /// whose body can't be read at all settles as an error, never left to time out; a child's EVENT goes on with its
    /// session (sliced, never re-encoded); a child's message nothing can be read of is consumed and dropped; anything
    /// else is left to CEF.
    func testTheRawObserverSettlesAChildsResultsAndDeliversItsEvents() {
        XCTAssertEqual(WinterCEFRawMessageTranscriptWithNoCEFAnywhere(#"{"id":12,"result":{"executionContextId":2},"sessionId":"AB12CD"}"#),
                       #"consumed=1;settled 12 ok=1 {"executionContextId":2}"#)
        XCTAssertEqual(WinterCEFRawMessageTranscriptWithNoCEFAnywhere(#"{"id":13,"result":{"result":{"type":"string","value":"x\ud83d"}},"sessionId":"AB12CD"}"#),
                       #"consumed=1;settled 13 ok=1 {"result":{"type":"string","value":"x\ud83d"}}"#)
        XCTAssertEqual(WinterCEFRawMessageTranscriptWithNoCEFAnywhere(#"{"id":14,"error":{"code":-32000,"message":"No frame"},"sessionId":"AB12CD"}"#),
                       #"consumed=1;settled 14 ok=0 {"code":-32000,"message":"No frame"}"#)
        XCTAssertEqual(WinterCEFRawMessageTranscriptWithNoCEFAnywhere(#"{"id":15,"weird":1,"sessionId":"AB12CD"}"#),
                       #"consumed=1;settled 15 ok=0 {"code":-32603,"message":"the child session's result could not be read"}"#)
        XCTAssertEqual(WinterCEFRawMessageTranscriptWithNoCEFAnywhere(#"{"method":"Runtime.consoleAPICalled","params":{"args":[{"value":"\ud83d"}]},"sessionId":"AB12CD"}"#),
                       #"consumed=1;event AB12CD Runtime.consoleAPICalled {"args":[{"value":"\ud83d"}]}"#)
        XCTAssertEqual(WinterCEFRawMessageTranscriptWithNoCEFAnywhere(#"{"method":"Page.frameStartedLoading","sessionId":"AB12CD"}"#),
                       #"consumed=1;event AB12CD Page.frameStartedLoading {}"#)
        // A grandchild detaching on a child's session fails the calls sent to it (15 and 16 went to AB12CD).
        XCTAssertEqual(WinterCEFRawMessageTranscriptWithNoCEFAnywhere(#"{"method":"Target.detachedFromTarget","params":{"sessionId":"AB12CD"},"sessionId":"PARENT"}"#),
                       #"consumed=1;settled 15 ok=0 {"message":"the frame's DevTools session ended before it answered"};settled 16 ok=0 {"message":"the frame's DevTools session ended before it answered"};event PARENT Target.detachedFromTarget {"sessionId":"AB12CD"}"#)
        // A child's message nothing can be read of: consumed (never handed to CEF, which would drop its session).
        XCTAssertEqual(WinterCEFRawMessageTranscriptWithNoCEFAnywhere(#"{"method":"Runtime.\"odd","sessionId":"AB12CD"}"#), "consumed=1")
        // The tab's own messages are CEF's.
        XCTAssertEqual(WinterCEFRawMessageTranscriptWithNoCEFAnywhere(#"{"id":12,"result":{}}"#), "consumed=0")
        XCTAssertEqual(WinterCEFRawMessageTranscriptWithNoCEFAnywhere(#"{"id":12,"result":{"sessionId":"AB12CD"}}"#), "consumed=0")
        XCTAssertEqual(WinterCEFRawMessageTranscriptWithNoCEFAnywhere(#"{"method":"Page.loadEventFired","params":{"timestamp":1}}"#), "consumed=0")
        XCTAssertEqual(WinterCEFRawMessageTranscriptWithNoCEFAnywhere(""), "consumed=0")
    }

    /// The door's own body, with the send injected: registered BEFORE it is sent (an answer from inside the send is
    /// not lost), a child's result Foundation can't parse still answered, a child's error typed, a child session that
    /// detaches failing only its own calls, and every refusal answered at once with its own sentence.
    func testTheDoorRegistersBeforeItSendsAndAlwaysAnswers() {
        let expected = [
            #"status=0 {}"#,
            #"status=0 {"result":{"type":"string","value":"x\ud83d"}}"#,
            #"status=1 {"code":-32000,"message":"No node"}"#,
            #"status=3 {"message":"the frame's DevTools session ended before it answered"}"#,
            "own pending=1",
            #"status=4 {"message":"the browser refused to submit the DevTools message"}"#,
            #"status=4 {"message":"the DevTools params were not a JSON object"}"#,
            #"status=4 {"message":"the DevTools params were not a JSON object"}"#,
            #"status=4 {"message":"the DevTools params nest too deeply"}"#,
            #"status=4 {"message":"the DevTools method name is not valid UTF-8"}"#,
            "pending=0",
        ].joined(separator: "\n")
        XCTAssertEqual(WinterCEFSendCDPTranscriptWithNoCEFAnywhere(), expected)
    }

    /// One raw message for both sessions: the params placed as given (never re-encoded), a child's session last.
    func testTheDoorsRawMessageCarriesTheParamsAsGiven() {
        XCTAssertEqual(WinterCEFRawDevToolsMessageWithNoCEFAnywhere(7, "Runtime.evaluate", #"{"expression":"1.0","contextId":3}"#, nil),
                       #"{"id":7,"method":"Runtime.evaluate","params":{"expression":"1.0","contextId":3}}"#)
        XCTAssertEqual(WinterCEFRawDevToolsMessageWithNoCEFAnywhere(8, "Page.enable", nil, "AB12CD"),
                       #"{"id":8,"method":"Page.enable","params":{},"sessionId":"AB12CD"}"#)
        XCTAssertEqual(WinterCEFRawDevToolsMessageWithNoCEFAnywhere(9, "Page.enable", "", ""),
                       #"{"id":9,"method":"Page.enable","params":{}}"#)
        // Anything but one JSON object that starts with `{` is refused before it could be sent.
        XCTAssertNil(WinterCEFRawDevToolsMessageWithNoCEFAnywhere(10, "Page.enable", "[1]", nil))
        XCTAssertNil(WinterCEFRawDevToolsMessageWithNoCEFAnywhere(10, "Page.enable", #"{"a":1} , "id": 5"#, nil))
        XCTAssertNil(WinterCEFRawDevToolsMessageWithNoCEFAnywhere(10, "Page.enable", "{", nil))
        XCTAssertNil(WinterCEFRawDevToolsMessageWithNoCEFAnywhere(10, "Page.enable", " {}", nil))
    }

    /// A page can call `window.print()` with no input from anyone, and no CEF handler stops the macOS
    /// print panel — so printing is switched off by Chromium's own preference at context init. Nothing
    /// is set unless the build registers the preference and lets it be set.
    func testPrintingIsSwitchedOffOnlyWhereTheBuildAllowsIt() {
        XCTAssertEqual(WinterCEFPrintingPreferenceDecisions(),
                       "absent;not-settable;refused: policy (set);disabled (set)")
        XCTAssertEqual(WinterCEFPrintingPreferenceOutcome(), "not attempted", "CEF never starts under XCTest")
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

/// ComputerV2 Phase 2 — **the whole app side of the link, over a scripted daemon.** The real
/// `BrowserLinkClient` (handshake, command intake, ordered outbox) drives the real `BrowserLinkHost`
/// (which drives a real `BrowserRuntime` through a real plan) with fake CEF on both seams. The daemon is
/// scripted: it answers the hello and the attach, sends commands, and records what comes back.
@MainActor
final class BrowserLinkEndToEndTests: XCTestCase {

    final class ScriptedLinkDaemon: WinterTransport, @unchecked Sendable {
        let incoming: AsyncStream<TransportEvent>
        private let cont: AsyncStream<TransportEvent>.Continuation
        private let lock = NSLock()
        private var _sent: [[String: Any]] = []

        init() {
            var c: AsyncStream<TransportEvent>.Continuation!
            incoming = AsyncStream { c = $0 }
            cont = c
        }

        var sent: [[String: Any]] { lock.withLock { _sent } }
        func open() async throws {}
        func close() { cont.finish() }
        func feed(_ line: String) { cont.yield(.data(Data((line + "\n").utf8))) }

        func send(_ data: Data) async throws {
            guard let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
            lock.withLock { _sent.append(message) }
            guard let id = message["id"] as? Int, let method = message["method"] as? String else { return }
            switch method {
            case "browserLink.attach":
                feed(#"{"jsonrpc":"2.0","id":\#(id),"result":{"linkId":"L1","protocol":\#(BrowserLinkProtocol.version)}}"#)
            default:
                feed(#"{"jsonrpc":"2.0","id":\#(id),"result":{}}"#)
            }
        }

        func command(_ cmdId: String, _ op: String, _ params: String) {
            feed(#"{"jsonrpc":"2.0","method":"browserLink.command","params":{"linkId":"L1","cmdId":"\#(cmdId)","op":"\#(op)","params":\#(params)}}"#)
        }

        func requests(_ method: String) -> [[String: Any]] {
            sent.filter { $0["method"] as? String == method }.compactMap { $0["params"] as? [String: Any] }
        }

        func result(_ cmdId: String) -> [String: Any]? {
            requests("browserLink.result").first { $0["cmdId"] as? String == cmdId }
        }
    }

    private func eventually(_ what: String, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(5)
        while !condition() && Date() < deadline {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertTrue(condition(), "timed out waiting for \(what)")
    }

    override func tearDown() async throws {
        PanelWebTabModels.removeAllForTesting()
    }

    func testAScriptedDaemonDrivesABuiltInTabThroughTheLink() async throws {
        let cef = BrowserRuntimeTests.CEFRecorder()
        let scheduler = BrowserRuntimeTests.FakeScheduler()
        let runtime = BrowserRuntime(driver: cef.driver, scheduler: scheduler.scheduler)
        let linkCEF = BrowserLinkHostTests.LinkDriverRecorder()
        // CEF "creates" the browser the moment the runtime asks for it.
        cef.onCreate = { container, _ in linkCEF.browserIds[ObjectIdentifier(container)] = 3 }
        let host = BrowserLinkHost(runtime: runtime, driver: linkCEF.driver)
        let daemon = ScriptedLinkDaemon()
        let client = BrowserLinkClient(configuration: .init(appVersion: "1.2.3", pid: 99), makeClient: { _ in
            WinterClient(makeTransport: { daemon }, token: "tok", clientName: BrowserLinkProtocol.clientName)
        }, handler: host)
        host.output = client
        client.start()
        defer { client.stop() }

        await eventually("the attach") { host.linkId == "L1" }
        XCTAssertEqual(daemon.sent.first?["method"] as? String, "protocol.hello")

        // tab.ensure for a session no shell has ever shown.
        daemon.command("c1", "tab.ensure", #"{"sessionId":"s1","tabId":"t1","url":"https://example.com/"}"#)
        await eventually("tab.ensure's answer") { daemon.result("c1") != nil }
        let ensured = try XCTUnwrap(daemon.result("c1"))
        XCTAssertEqual(ensured["ok"] as? Bool, true, "\(ensured)")
        XCTAssertEqual(((ensured["result"] as? [String: Any])?["viewport"] as? [Int])?.count, 2)
        XCTAssertTrue(cef.log.contains("c1 create url=https://example.com/"))

        // cdp.send: refused off the allowlist (nothing reaches CEF), sent when allowed.
        daemon.command("c2", "cdp.send", #"{"tabId":"t1","method":"Network.getCookies","params":{}}"#)
        daemon.command("c3", "cdp.send", #"{"tabId":"t1","method":"Page.enable","params":{}}"#)
        await eventually("the refusal, and the send reaching CEF") { daemon.result("c2") != nil && linkCEF.cdp.count == 1 }
        XCTAssertEqual(((daemon.result("c2")?["error"]) as? [String: Any])?["code"] as? String, "not_allowed")
        XCTAssertEqual(linkCEF.cdp.first?.method, "Page.enable")
        linkCEF.answer(.OK, "{}")
        await eventually("cdp.send's answer") { daemon.result("c3") != nil }
        XCTAssertEqual(daemon.result("c3")?["ok"] as? Bool, true)

        // An event leaves once subscribed — before the result of a command answered after it.
        daemon.command("c4", "cdp.subscribe", #"{"tabId":"t1","events":["Page.loadEventFired"]}"#)
        await eventually("the subscribe") { daemon.result("c4") != nil }
        let container = try XCTUnwrap(runtime.container(forTabId: "t1"))
        linkCEF.eventObservers[ObjectIdentifier(container)]?("Page.loadEventFired", Data(#"{"timestamp":5}"#.utf8), nil)
        daemon.command("c5", "tabs.live", "{}")
        await eventually("the event batch and tabs.live") { !daemon.requests("browserLink.events").isEmpty && daemon.result("c5") != nil }
        let methods = daemon.sent.compactMap { $0["method"] as? String }
        XCTAssertLessThan(methods.firstIndex(of: "browserLink.events") ?? .max,
                          methods.lastIndex(of: "browserLink.result") ?? -1)
        let event = ((daemon.requests("browserLink.events").first?["events"] as? [[String: Any]])?.first) ?? [:]
        XCTAssertEqual(event["tabId"] as? String, "t1")
        XCTAssertEqual(event["method"] as? String, "Page.loadEventFired")

        // tab.close: the browser goes by the runtime's hardened stop.
        daemon.command("c6", "tab.close", #"{"tabId":"t1"}"#)
        await eventually("the close") { daemon.result("c6") != nil }
        XCTAssertFalse(runtime.isLive(tabId: "t1"))
        XCTAssertTrue(cef.log.contains("c1 close"))
        XCTAssertTrue(daemon.requests("browserLink.tabGone").isEmpty)
    }
}
