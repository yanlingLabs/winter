import AppKit
import Foundation

/// ComputerV2 Phase 4 — **Winter Headless's executor: the browser-link op set on windowless browsers.**
///
/// The daemon's headless pool drives this over the helper's pipe (`HeadlessLink`) with the same ops Winter.app's
/// `BrowserLinkHost` executes, read by the same parser (`BrowserLinkCommand`), gated by the same Swift copy of the
/// CDP allowlist and the world rules (`CDPTabGate`). What differs is what a tab IS here:
///
///  * **Every tab is the daemon's.** `tab.ensure` WITH a `url` creates the tab (a windowless browser in its
///    session's own in-memory request context) when it does not exist yet; WITHOUT one it only re-holds an
///    existing tab, and an unknown tab is `tab_gone` — a tab that was closed or crashed is never brought back.
///  * **A tab belongs to one session** for its whole life; `tab.ensure` naming another session is refused.
///  * **No native UI, ever** — every `WinterCEFAutomationNativeUI` flag is set when the browser is created and
///    never cleared (nobody can see or answer this browser): dialogs held for the engine, permissions denied,
///    file choosers cancelled, downloads refused, context menus empty, focus refused, fullscreen exited.
///  * **A renderer crash loses the tab** (reported `tabGone {crashed}`, the browser closed), as a crashed tab is
///    lost on the other backends.
///  * **`context.dispose {sessionId}`** closes the session's tabs and forgets its request context (its cookies).
///  * `tab.present`, `tab.mute`, `tab.downloads` and `tab.download` are refused: nobody can be shown a headless
///    tab, it never plays sound, and it never downloads.
@MainActor
final class HeadlessHost {

    /// Clock and deferral for `tab.ensure`'s wait for CEF's asynchronous creation (injected for tests).
    struct Clock {
        var now: () -> Date
        var after: (TimeInterval, @escaping @MainActor () -> Void) -> Void

        static let production = Clock(
            now: Date.init,
            after: { delay, work in
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { MainActor.assumeIsolated { work() } }
            })
    }

    static let ensurePollInterval: TimeInterval = 0.05
    /// Inside the daemon's 20 s `tab.ensure` timeout, so this side's own `timeout` answer is the one it reads.
    static let ensureDeadline: TimeInterval = 15
    /// The most tabs this helper keeps open — a ceiling under the daemon's own caps (8 per session, 24 in all),
    /// never a queue. Past it `tab.ensure` is refused with `data.capacity`.
    static let maxTabs = 24

    static let worldMethods: Set<String> = ["Page.createIsolatedWorld", "Runtime.evaluate", "Runtime.callFunctionOn",
                                            "DOM.resolveNode", "Runtime.releaseObject", "Runtime.releaseObjectGroup"]

    final class Tab {
        let tabId: String
        let sessionId: String
        let key: NSView
        /// Present while the daemon holds the tab (between `tab.ensure` and `tab.release`); its presence IS the hold.
        var gate: CDPTabGate?
        var url: String
        var title = ""
        var loading = true

        init(tabId: String, sessionId: String, key: NSView, url: String) {
            self.tabId = tabId
            self.sessionId = sessionId
            self.key = key
            self.url = url
        }
    }

    private let driver: HeadlessCEFDriver
    private let clock: Clock
    weak var output: HeadlessOutput?

    private(set) var tabs: [String: Tab] = [:]

    init(driver: HeadlessCEFDriver, clock: Clock = .production) {
        self.driver = driver
        self.clock = clock
    }

    // MARK: - Commands

    func handle(_ command: BrowserLinkCommand, reply: HeadlessReplier) {
        switch command.op {
        case .tabEnsure(let sessionId, let tabId, let url):
            ensure(sessionId: sessionId, tabId: tabId, url: url, reply: reply)
        case .tabRelease(let tabId):
            tabs[tabId]?.gate = nil
            reply(.empty)
        case .tabClose(let tabId):
            close(tabId)
            reply(.empty)
        case .tabsLive:
            reply(.ok(liveTabs()))
        case .cdpSend(let tabId, let method, let params, let session):
            send(tabId: tabId, method: method, params: params, cdpSessionId: session, reply: reply)
        case .cdpSubscribe(let tabId, let events):
            guard let gate = tabs[tabId]?.gate else {
                reply(.failure(code: .notLive, message: "the tab is not held — tab.ensure it first"))
                return
            }
            if let refusal = gate.subscribe(events) {
                reply(.failure(code: .notAllowed, message: refusal.message))
            } else {
                reply(.empty)
            }
        case .overlay:
            // Best effort by contract, and nothing to draw on: nobody sees a headless tab.
            reply(.empty)
        case .tabPresent:
            reply(.failure(code: .notAllowed, message: "a headless tab can't be shown — nobody can see it"))
        case .tabMute:
            reply(.failure(code: .notAllowed, message: "a headless tab never plays sound"))
        case .tabDownloads, .tabDownload:
            reply(.failure(code: .notAllowed, message: "Winter's headless browser doesn't download files"))
        }
    }

    /// `context.dispose {sessionId}`: the session's tabs closed, then its request context forgotten.
    func disposeContext(sessionId: String) -> Int {
        let doomed = tabs.values.filter { $0.sessionId == sessionId }.map(\.tabId)
        for tabId in doomed { close(tabId) }
        driver.disposeContext(sessionId)
        return doomed.count
    }

    /// Every tab closed (the pipe closed: the helper is going away).
    func closeEverything() {
        for tabId in Array(tabs.keys) { close(tabId) }
    }

    // MARK: - tab.ensure

    private func ensure(sessionId: String, tabId: String, url: String?, reply: HeadlessReplier) {
        if let tab = tabs[tabId] {
            guard tab.sessionId == sessionId else {
                reply(.failure(code: .notAllowed, message: "this headless tab belongs to another session"))
                return
            }
            if tab.gate == nil { tab.gate = CDPTabGate() }
            waitForBrowser(tab, deadline: clock.now().addingTimeInterval(Self.ensureDeadline), reply: reply)
            return
        }
        guard let url else {
            reply(.failure(code: .tabGone, message: "the headless tab is gone"))
            return
        }
        guard CDPTabGate.isNavigableURL(url) else {
            reply(.failure(code: .notAllowed, message: "a headless tab opens only http(s) pages or about:blank"))
            return
        }
        guard tabs.count < Self.maxTabs else {
            reply(.failure(code: .notAllowed,
                           message: "Winter's headless browser already has \(Self.maxTabs) tabs open — close one with tab.close()",
                           data: .object(["capacity": .bool(true)])))
            return
        }
        let tab = Tab(tabId: tabId, sessionId: sessionId, key: NSView(frame: .zero), url: url)
        tab.gate = CDPTabGate()
        tabs[tabId] = tab
        install(tab)
        driver.create(tab.key, url, sessionId)
        waitForBrowser(tab, deadline: clock.now().addingTimeInterval(Self.ensureDeadline), reply: reply)
    }

    private func install(_ tab: Tab) {
        let tabId = tab.tabId
        // Before the browser exists, so its very first page already gets none of it.
        driver.lockNativeUI(tab.key)
        driver.setEventObserver(tab.key) { [weak self] method, params, session in
            self?.event(tabId: tabId, method: method, params: params, cdpSessionId: session)
        }
        driver.setCrashObserver(tab.key) { [weak self] in self?.rendererCrashed(tabId) }
        driver.setStateObserver(tab.key) { [weak self] url, title, loading in
            guard let tab = self?.tabs[tabId] else { return }
            tab.url = url
            tab.title = title
            tab.loading = loading
        }
    }

    private func waitForBrowser(_ tab: Tab, deadline: Date, reply: HeadlessReplier) {
        guard tabs[tab.tabId] === tab else {
            reply(.failure(code: .tabGone, message: "the tab went away before its browser was ready"))
            return
        }
        if driver.browserIdentifier(tab.key) != 0 {
            reply(.ok(ensureResult(tab)))
            return
        }
        guard clock.now() < deadline else {
            // A browser that never arrived is closed: the daemon will not be told about it again.
            close(tab.tabId)
            reply(.failure(code: .timeout, message: "the headless tab's browser did not start within \(Int(Self.ensureDeadline)) s"))
            return
        }
        clock.after(Self.ensurePollInterval) { [weak self] in
            self?.waitForBrowser(tab, deadline: deadline, reply: reply)
        }
    }

    private func ensureResult(_ tab: Tab) -> JSONValue {
        .object([
            "url": .string(tab.url),
            "title": .string(tab.title),
            "loading": .bool(tab.loading),
            "sessionId": .string(tab.sessionId),
            "viewport": .array([.number(Double(HeadlessHost.viewWidth)), .number(Double(HeadlessHost.viewHeight))]),
            "dpr": .number(1),
        ])
    }

    /// The fixed view every headless browser reports (`WinterCEFHeadlessViewWidth`/`Height`).
    static let viewWidth = 1280
    static let viewHeight = 800

    // MARK: - Closing

    private func close(_ tabId: String) {
        guard let tab = tabs.removeValue(forKey: tabId) else { return }
        tab.gate = nil
        driver.setEventObserver(tab.key, nil)
        driver.setCrashObserver(tab.key, nil)
        driver.setStateObserver(tab.key, nil)
        driver.close(tab.key)
    }

    private func rendererCrashed(_ tabId: String) {
        guard tabs[tabId] != nil else { return }
        close(tabId)
        output?.tabGone(tabId: tabId, reason: .crashed)
    }

    // MARK: - tabs.live

    private func liveTabs() -> JSONValue {
        let rows: [JSONValue] = tabs.keys.sorted().compactMap { tabId in
            guard let tab = tabs[tabId] else { return nil }
            return .object([
                "tabId": .string(tabId),
                "sessionId": .string(tab.sessionId),
                "url": .string(tab.url),
                "title": .string(tab.title),
                "held": .bool(tab.gate != nil),
            ])
        }
        return .object(["tabs": .array(rows)])
    }

    // MARK: - cdp.send

    private func send(tabId: String, method: String, params: JSONValue, cdpSessionId: String?, reply: HeadlessReplier) {
        guard let tab = tabs[tabId], let gate = tab.gate else {
            reply(.failure(code: tabs[tabId] == nil ? .tabGone : .notLive,
                           message: tabs[tabId] == nil ? "the headless tab is gone" : "the tab is not held — tab.ensure it first"))
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
        let key = tab.key
        driver.sendCDP(key, method, paramsJSON, cdpSessionId) { [weak self] status, payload in
            guard let self else {
                reply(.failure(code: .notLive, message: "Winter's headless browser is not available"))
                return
            }
            self.settle(tabId: tabId, key: key, method: method, params: params, cdpSessionId: cdpSessionId,
                        status: status, payload: payload, reply: reply)
        }
    }

    private func settle(tabId: String, key: NSView, method: String, params: JSONValue, cdpSessionId: String?,
                        status: HeadlessCDPStatus, payload: String, reply: HeadlessReplier) {
        switch status {
        case .ok:
            if method == "Page.handleJavaScriptDialog", cdpSessionId == nil {
                _ = driver.resolveHeldDialog(key, .drop, nil)
            }
            if Self.worldMethods.contains(method) {
                guard BrowserLinkProtocol.resultFits(bytes: payload.utf8.count) else {
                    reply(BrowserLinkProtocol.resultTooLarge(bytes: payload.utf8.count))
                    return
                }
                let result = Self.decode(payload) ?? .object([:])
                tabs[tabId]?.gate?.noteResult(method: method, params: params, cdpSessionId: cdpSessionId, result: result)
                reply(.ok(.object(["result": result])))
            } else if method == "Network.getResponseBody" {
                guard BrowserLinkProtocol.resultFits(bytes: payload.utf8.count) else {
                    reply(BrowserLinkProtocol.resultTooLarge(bytes: payload.utf8.count))
                    return
                }
                let result = CDPTabGate.filterResult(method: method, result: Self.decode(payload) ?? .object([:]))
                reply(.ok(.object(["result": result])))
            } else {
                reply(.okRaw(key: "result", json: payload))
            }
        case .protocolError:
            // A dialog this tab holds may be out of DevTools' reach ("No dialog is showing"): the tab answers it.
            if method == "Page.handleJavaScriptDialog", cdpSessionId == nil,
               driver.resolveHeldDialog(key, params["accept"]?.boolValue == true ? .accept : .dismiss,
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
        }
    }

    // MARK: - Events

    private func event(tabId: String, method: String, params: Data, cdpSessionId: String?) {
        guard let tab = tabs[tabId], let gate = tab.gate else { return }
        if CDPTabGate.tracksEvent(method), let value = Self.decode(params) {
            gate.noteEvent(method: method, params: value, cdpSessionId: cdpSessionId)
        }
        if method == "Page.javascriptDialogClosed", cdpSessionId == nil {
            _ = driver.resolveHeldDialog(tab.key, .drop, nil)
        }
        switch gate.disposition(forEvent: method) {
        case .drop:
            return
        case .forward:
            output?.emitEvent(tabId: tabId, method: method, params: params, cdpSessionId: cdpSessionId, strip: false)
        case .forwardStripped:
            output?.emitEvent(tabId: tabId, method: method, params: params, cdpSessionId: cdpSessionId, strip: true)
        }
    }

    // MARK: - JSON

    static func decode(_ text: String) -> JSONValue? { decode(Data(text.utf8)) }
    static func decode(_ data: Data) -> JSONValue? { try? JSONDecoder().decode(JSONValue.self, from: data) }
}

/// What the host sends on its own: CDP events, and tabs that went away by a route the daemon did not take.
protocol HeadlessOutput: AnyObject {
    func emitEvent(tabId: String, method: String, params: Data, cdpSessionId: String?, strip: Bool)
    func tabGone(tabId: String, reason: BrowserLinkProtocol.TabGoneReason)
}

/// The answer door for ONE command. A second answer is ignored, so a late completion racing a failure can never
/// answer a command twice.
struct HeadlessReplier {
    private let deliver: (BrowserLinkReply) -> Void

    init(_ deliver: @escaping (BrowserLinkReply) -> Void) {
        var answered = false
        self.deliver = { reply in
            guard !answered else { return }
            answered = true
            deliver(reply)
        }
    }

    func callAsFunction(_ reply: BrowserLinkReply) { deliver(reply) }
}
