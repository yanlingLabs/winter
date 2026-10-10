import AppKit
import Foundation
import WinterKit

/// ComputerV2 Phase 2 — **the app half of the browser link: the executor of `browserLink.command`s.**
///
/// The daemon's browser engine drives Winter's built-in browser through here, with no window attached
/// and none opened: `tab.ensure` makes a tab's browser live (created parked, headless, if it was not)
/// and HOLDS it; `cdp.send` runs DevTools methods on it; its events flow back; `tab.release` /
/// `tab.close` end the hold. The wire is `BrowserLinkClient`'s (WinterKit); this object only executes.
///
/// It decides nothing about whether a browser should exist — that stays `BrowserLifecycleEngine.plan`'s
/// question. A hold is recorded on the runtime (`BrowserRuntime.hold`) and a plan is asked for; the
/// engine's rule H then creates the browser and keeps it from every stop. What this object does own:
///
///  * **what reaches CEF** — every method through the tab's `CDPTabGate` (the allowlist and the world
///    rules), refused `not_allowed` before CEF sees it;
///  * **what leaves** — only subscribed, allowlisted events, `Network.*` params stripped;
///  * **no native UI from a held tab** — `BrowserNativeUIPolicy` flags on the tab while it is held, and
///    the JS dialog the tab holds answered when DevTools cannot;
///  * **telling the daemon a held tab went away** by a route the daemon did not take (`tabGone`).
@MainActor
final class BrowserLinkHost: BrowserLinkHandler {

    /// The clock and the one deferral `tab.ensure` needs: polling for the browser CEF creates
    /// asynchronously. Injected so a test drives the wait without waiting.
    struct Clock {
        var now: () -> Date
        var after: (TimeInterval, @escaping @MainActor () -> Void) -> Void

        static let production = Clock(
            now: Date.init,
            after: { delay, work in
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { MainActor.assumeIsolated { work() } }
            })
    }

    /// How often `tab.ensure` looks for its browser, and for how long. Inside the daemon's 20 s
    /// `tab.ensure` timeout, so the app's own `timeout` answer is the one the daemon reads.
    static let ensurePollInterval: TimeInterval = 0.05
    static let ensureDeadline: TimeInterval = 15

    /// The methods whose result the gate must read (contexts and objects they mint or release).
    static let worldMethods: Set<String> = ["Page.createIsolatedWorld", "Runtime.evaluate", "Runtime.callFunctionOn",
                                            "DOM.resolveNode", "Runtime.releaseObject", "Runtime.releaseObjectGroup"]

    private let runtime: BrowserRuntime
    private let driver: BrowserLinkCEFDriver
    private let clock: Clock
    private let replan: () -> Void

    /// Where events and gone tabs go — the link client. Set once by `BrowserLinkStarter`.
    var output: BrowserLinkOutput?

    /// One per held tab. Its presence IS "this link holds the tab" on this side.
    private var gates: [String: CDPTabGate] = [:]
    /// Tabs whose renderer died while held; the next `tab.ensure` reloads them.
    private var crashed: Set<String> = []
    /// Set only for the span of this object's own `tab.close`, so the stop it causes is not reported
    /// back to the daemon as a tab that went away by itself.
    private var closingNow: Set<String> = []

    /// The link that is up, as last announced.
    private(set) var linkId: String?

    init(runtime: BrowserRuntime, driver: BrowserLinkCEFDriver = .production, clock: Clock = .production,
         replan: (() -> Void)? = nil) {
        self.runtime = runtime
        self.driver = driver
        self.clock = clock
        self.replan = replan ?? { [unowned runtime] in BrowserHeadlessPlanner.replan(runtime) }
        runtime.onBrowserStopped = { [weak self] tabId in self?.browserStopped(tabId) }
    }

    /// The tabs this link holds right now — for tests and logs.
    var heldTabIds: Set<String> { Set(gates.keys) }

    // MARK: - BrowserLinkHandler

    func browserLinkAttached(linkId: String) {
        self.linkId = linkId
        // Nothing can be held across links; `browserLinkLost` already let go. Belt for a lost that
        // never came.
        releaseEverything()
    }

    func browserLinkLost() {
        linkId = nil
        releaseEverything()
    }

    func browserLinkCommand(_ command: BrowserLinkCommand, reply: BrowserLinkReplier) {
        guard !runtime.isQuiescent else {
            reply(.failure(code: .quiescent, message: "Winter is quitting"))
            return
        }
        switch command.op {
        case .tabEnsure(let sessionId, let tabId, let url):
            ensure(sessionId: sessionId, tabId: tabId, url: url, reply: reply)
        case .tabRelease(let tabId):
            if release(tabId) { replan() }
            reply(.empty)
        case .tabClose(let tabId):
            close(tabId)
            reply(.empty)
        case .tabsLive:
            reply(.ok(liveTabs()))
        case .cdpSend(let tabId, let method, let params, let session):
            send(tabId: tabId, method: method, params: params, cdpSessionId: session, reply: reply)
        case .cdpSubscribe(let tabId, let events):
            guard let gate = gates[tabId] else {
                reply(.failure(code: .notLive, message: "the tab is not held — tab.ensure it first"))
                return
            }
            if let refusal = gate.subscribe(events) {
                reply(.failure(code: .notAllowed, message: refusal.message))
            } else {
                reply(.empty)
            }
        case .overlay:
            // Best effort by contract, and a no-op here: the built-in browser's tabs are parked, with no
            // view anyone is looking at to draw an agent cursor over.
            reply(.empty)
        }
    }

    // MARK: - tab.ensure

    private func ensure(sessionId: String, tabId: String, url: String?, reply: BrowserLinkReplier) {
        let isNewHold = gates[tabId] == nil
        runtime.hold(tabId: tabId, sessionId: sessionId, url: url)
        if isNewHold || !runtime.isLive(tabId: tabId) { replan() }
        guard let container = runtime.container(forTabId: tabId) else {
            runtime.releaseHold(tabId: tabId)
            gates[tabId] = nil
            reply(.failure(code: .notLive, message: "Winter could not make a browser for this tab"))
            return
        }
        install(tabId: tabId, container: container)
        if crashed.remove(tabId) != nil {
            driver.reload(container)
        }
        waitForBrowser(tabId: tabId, container: container, deadline: clock.now().addingTimeInterval(Self.ensureDeadline),
                       reply: reply)
    }

    private func install(tabId: String, container: PanelCEFContainerView) {
        if gates[tabId] == nil { gates[tabId] = CDPTabGate() }
        driver.setNativeUI(container, BrowserNativeUIPolicy.flags(held: true))
        driver.setEventObserver(container) { [weak self] method, params, session in
            self?.event(tabId: tabId, method: method, params: params, cdpSessionId: session)
        }
        driver.setCrashObserver(container) { [weak self] in self?.rendererCrashed(tabId) }
    }

    /// CEF creates a browser asynchronously (one main-queue hop, then CEF's own queue), so a held tab's
    /// container exists before its browser does — and a CDP call before then has nothing to reach.
    private func waitForBrowser(tabId: String, container: PanelCEFContainerView, deadline: Date,
                                reply: BrowserLinkReplier) {
        guard gates[tabId] != nil, runtime.container(forTabId: tabId) === container else {
            reply(.failure(code: .tabGone, message: "the tab went away before its browser was ready"))
            return
        }
        if driver.browserIdentifier(container) != 0 {
            reply(.ok(ensureResult(tabId: tabId, container: container)))
            return
        }
        if let reason = runtime.engineFailureReason {
            reply(.failure(code: .notLive, message: "Winter's built-in browser could not start: \(reason)"))
            return
        }
        guard clock.now() < deadline else {
            reply(.failure(code: .timeout,
                           message: "the tab's browser did not start within \(Int(Self.ensureDeadline)) s"))
            return
        }
        clock.after(Self.ensurePollInterval) { [weak self] in
            self?.waitForBrowser(tabId: tabId, container: container, deadline: deadline, reply: reply)
        }
    }

    private func ensureResult(tabId: String, container: PanelCEFContainerView) -> JSONValue {
        let model = PanelWebTabModels.existing(tabId: tabId)
        let size = container.bounds.size
        let dpr = container.window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        return .object([
            "url": .string(model?.url ?? ""),
            "title": .string(model?.title ?? ""),
            "loading": .bool(model?.isLoading ?? false),
            "viewport": .array([.number(Double(size.width.rounded())), .number(Double(size.height.rounded()))]),
            "dpr": .number(Double(dpr)),
        ])
    }

    // MARK: - tab.release / tab.close / the link going away

    /// Drop the hold. Returns whether there was one. The browser stays — the next plan decides.
    @discardableResult
    private func release(_ tabId: String) -> Bool {
        let wasHeld = runtime.releaseHold(tabId: tabId) != nil
        let hadGate = gates[tabId] != nil
        uninstall(tabId)
        return wasHeld || hadGate
    }

    private func uninstall(_ tabId: String) {
        gates[tabId] = nil
        guard let container = runtime.container(forTabId: tabId) else { return }
        driver.setEventObserver(container, nil)
        driver.setCrashObserver(container, nil)
        // Clearing the flags also dismisses a dialog the tab is still holding (`WinterCEF.h`).
        driver.setNativeUI(container, BrowserNativeUIPolicy.flags(held: false))
    }

    /// The hardened close: the runtime's own `stop` (observers cleared, the browser closed without a
    /// `beforeunload`, the container released), reached through the engine's rule C so the tab is not
    /// re-created before the daemon's `panel_tab_closed` is folded.
    private func close(_ tabId: String) {
        uninstall(tabId)
        crashed.remove(tabId)
        closingNow.insert(tabId)
        runtime.markClosing(tabId: tabId)
        replan()
        closingNow.remove(tabId)
    }

    private func releaseEverything() {
        let held = Set(runtime.holds.keys).union(gates.keys)
        guard !held.isEmpty else { return }
        for tabId in held { release(tabId) }
        replan()
    }

    // MARK: - Tabs that go away by themselves

    /// The runtime stopped a browser. For a held tab that is a route this link did not take — with
    /// rule H nothing in the engine stops one, so this is a belt — and the daemon must hear of it.
    private func browserStopped(_ tabId: String) {
        guard gates[tabId] != nil, !closingNow.contains(tabId) else { return }
        gates[tabId] = nil
        runtime.releaseHold(tabId: tabId)
        output?.tabGone(tabId: tabId, reason: .stopped)
    }

    private func rendererCrashed(_ tabId: String) {
        guard gates[tabId] != nil else { return }
        crashed.insert(tabId)
        release(tabId)
        output?.tabGone(tabId: tabId, reason: .crashed)
        replan()
    }

    // MARK: - tabs.live

    private func liveTabs() -> JSONValue {
        let rows: [JSONValue] = runtime.liveTabIds.sorted().map { tabId in
            let model = PanelWebTabModels.existing(tabId: tabId)
            return .object([
                "tabId": .string(tabId),
                "url": .string(model?.url ?? ""),
                "title": .string(model?.title ?? ""),
                "held": .bool(runtime.holds[tabId] != nil),
            ])
        }
        return .object(["tabs": .array(rows)])
    }

    // MARK: - cdp.send

    private func send(tabId: String, method: String, params: JSONValue, cdpSessionId: String?,
                      reply: BrowserLinkReplier) {
        guard let gate = gates[tabId], runtime.holds[tabId] != nil,
              let container = runtime.container(forTabId: tabId) else {
            reply(.failure(code: .notLive, message: "the tab is not held — tab.ensure it first"))
            return
        }
        if let refusal = gate.check(method: method, params: params, cdpSessionId: cdpSessionId) {
            reply(.failure(code: .notAllowed, message: refusal.message))
            return
        }
        guard let data = try? JSONEncoder().encode(params), let paramsJSON = String(data: data, encoding: .utf8) else {
            reply(.failure(code: .notAllowed, message: "\(method): the params could not be encoded"))
            return
        }
        driver.sendCDP(container, method, paramsJSON, cdpSessionId) { [weak self] status, payload in
            guard let self else {
                reply(.failure(code: .notLive, message: "Winter's built-in browser is not available"))
                return
            }
            self.settle(tabId: tabId, method: method, params: params, cdpSessionId: cdpSessionId,
                        status: status, payload: payload, reply: reply)
        }
    }

    private func settle(tabId: String, method: String, params: JSONValue, cdpSessionId: String?,
                        status: WinterCEFCDPStatus, payload: String, reply: BrowserLinkReplier) {
        let container = runtime.container(forTabId: tabId)
        switch status {
        case .OK:
            if method == "Page.handleJavaScriptDialog", cdpSessionId == nil, let container {
                // DevTools answered the dialog; the tab's own copy of it is spent.
                _ = driver.resolveHeldDialog(container, .drop, nil)
            }
            if Self.worldMethods.contains(method) {
                let result = Self.decode(payload) ?? .object([:])
                gates[tabId]?.noteResult(method: method, params: params, cdpSessionId: cdpSessionId, result: result)
                reply(.ok(.object(["result": result])))
            } else {
                reply(.okRaw(key: "result", json: payload))
            }
        case .protocolError:
            // The dialog fallback: a dialog this tab holds as a custom one may be out of DevTools' reach
            // ("No dialog is showing"). The tab answers it itself, exactly as the engine asked.
            if method == "Page.handleJavaScriptDialog", cdpSessionId == nil, let container,
               driver.resolveHeldDialog(container, params["accept"]?.boolValue == true ? .accept : .dismiss,
                                        params["promptText"]?.stringValue) {
                reply(.ok(.object(["result": .object([:])])))
                return
            }
            let error = Self.decode(payload)
            let message = error?["message"]?.stringValue ?? "the browser refused \(method)"
            reply(.failure(code: .cdpError, message: message,
                           data: .object(["cdpCode": error?["code"] ?? .number(-32603), "cdpMessage": .string(message)])))
        case .notLive:
            reply(.failure(code: .notLive, message: Self.decode(payload)?["message"]?.stringValue ?? "this tab has no live browser"))
        case .gone:
            reply(.failure(code: .tabGone, message: Self.decode(payload)?["message"]?.stringValue ?? "the tab's browser went away"))
        case .refused:
            let message = Self.decode(payload)?["message"]?.stringValue ?? "the browser refused \(method)"
            reply(.failure(code: .cdpError, message: message,
                           data: .object(["cdpCode": .number(-32603), "cdpMessage": .string(message)])))
        @unknown default:
            reply(.failure(code: .cdpError, message: "the browser answered \(method) with an unknown status",
                           data: .object(["cdpCode": .number(-32603), "cdpMessage": .string("unknown status")])))
        }
    }

    // MARK: - Events

    private func event(tabId: String, method: String, params: Data, cdpSessionId: String?) {
        guard let gate = gates[tabId] else { return }
        if CDPTabGate.tracksEvent(method), let value = Self.decode(params) {
            gate.noteEvent(method: method, params: value, cdpSessionId: cdpSessionId)
        }
        if method == "Page.javascriptDialogClosed", cdpSessionId == nil, let container = runtime.container(forTabId: tabId) {
            _ = driver.resolveHeldDialog(container, .drop, nil)
        }
        switch gate.disposition(forEvent: method) {
        case .drop:
            return
        case .forward:
            output?.emitEvent(tabId: tabId, method: method, params: params, cdpSessionId: cdpSessionId,
                              stripNetworkParams: false)
        case .forwardStripped:
            output?.emitEvent(tabId: tabId, method: method, params: params, cdpSessionId: cdpSessionId,
                              stripNetworkParams: true)
        }
    }

    // MARK: - JSON

    static func decode(_ text: String) -> JSONValue? { decode(Data(text.utf8)) }
    static func decode(_ data: Data) -> JSONValue? { try? JSONDecoder().decode(JSONValue.self, from: data) }
}
