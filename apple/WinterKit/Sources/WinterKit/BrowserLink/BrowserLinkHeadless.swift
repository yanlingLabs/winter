import Foundation

// -----------------------------------------------------------------------------------------------
// Feature `headless` (ComputerV2 Phase 4, lane H3) — the browser link's three ops for showing a tab of
// Winter's HEADLESS browser in the app's panel, and the person's actions on it.
//
// Daemon → app, on `browserLink.command`:
//   * `headless.show {sessionId, tabId, service, nonce, producerRequirement, control, purpose, url, title,
//     uploadDir}` — connect to the presentation Winter Headless checked in under `service` (naming `nonce`,
//     holding the helper to `producerRequirement`) and show it in the session's panel;
//   * `headless.hide {sessionId, tabId, reason}` — stop showing it;
//   * `headless.tabs {sessionId, tabs}` — the session's headless tabs changed.
// App → daemon: `browserLink.headless {linkId, sessionId, tabId?, action}` (`BrowserLinkClient.headless`).
//
// The three ops are read HERE rather than by `BrowserLinkCommand.parse`: Winter Headless compiles that parser
// into its own target and switches over every case of `BrowserLinkCommand.Op`, so that enum stays closed. A
// `headless.*` op is routed to this parser by `BrowserLinkClient` before the ordinary one is asked; it is just as
// strict — a command that does not read is answered with a failure, never executed.
// -----------------------------------------------------------------------------------------------

/// One headless tab as the panel lists it (`HeadlessTabRow` on the daemon's side).
public struct BrowserLinkHeadlessTab: Sendable, Equatable, Identifiable {
    public let tabId: String
    public let url: String
    public let title: String
    /// Shown in some viewer right now.
    public let presented: Bool
    /// The person holds control of it right now.
    public let control: Bool

    public var id: String { tabId }

    public init(tabId: String, url: String, title: String, presented: Bool, control: Bool) {
        self.tabId = tabId
        self.url = url
        self.title = title
        self.presented = presented
        self.control = control
    }

    /// One row of a `tabs` array, or nil when it is not shaped as the daemon writes one.
    static func read(_ value: JSONValue) -> BrowserLinkHeadlessTab? {
        guard let tabId = value["tabId"]?.stringValue, !tabId.isEmpty,
              let url = value["url"]?.stringValue, let title = value["title"]?.stringValue,
              case .bool(let presented)? = value["presented"], case .bool(let control)? = value["control"] else {
            return nil
        }
        return BrowserLinkHeadlessTab(tabId: tabId, url: url, title: title, presented: presented, control: control)
    }
}

/// Why the daemon shows a tab: the agent waits for the person (`handoff` — a `waitForUser`; the person has control),
/// or the person watches (`watch`) and may take over from the panel.
public enum BrowserLinkHeadlessPurpose: String, Sendable, Equatable {
    case handoff
    case watch
}

/// The person's actions on a headless tab (`browserLink.headless`'s `action`).
public enum BrowserLinkHeadlessAction: String, Sendable, Equatable, CaseIterable {
    /// The session's headless tabs, fresh (no `tabId`).
    case list
    /// Show it, watch-only.
    case watch
    /// The person takes control (the agent's work in flight finishes first).
    case takeOver
    /// Control back to the agent; the view stays, watch-only.
    case handBack
    /// The answers to a `waitForUser` hand-off shown in the panel.
    case done
    case stopWaiting
    /// Stop showing it; control, if held, goes back to the agent.
    case close
}

/// One `headless.*` command, read.
public struct BrowserLinkHeadlessCommand: Sendable, Equatable {
    public let linkId: String
    public let cmdId: String
    public let op: Op

    public enum Op: Sendable, Equatable {
        case show(Show)
        case hide(sessionId: String, tabId: String, reason: String)
        case tabs(sessionId: String, tabs: [BrowserLinkHeadlessTab])
    }

    /// `headless.show`'s params, checked.
    public struct Show: Sendable, Equatable {
        public let sessionId: String
        public let tabId: String
        /// The bootstrap name Winter Headless checked the presentation in under (`com.winter.headless.present.…`).
        public let service: String
        /// The presentation's nonce (16 hex digits on the wire).
        public let nonce: UInt64
        /// The code-signing requirement the presenting process must satisfy.
        public let producerRequirement: String
        /// Whether the person holds control from the start.
        public let control: Bool
        public let purpose: BrowserLinkHeadlessPurpose
        public let url: String
        public let title: String
        /// Where files the person chooses for the page are copied first (absolute).
        public let uploadDir: String

        public init(sessionId: String, tabId: String, service: String, nonce: UInt64, producerRequirement: String,
                    control: Bool, purpose: BrowserLinkHeadlessPurpose, url: String, title: String, uploadDir: String) {
            self.sessionId = sessionId
            self.tabId = tabId
            self.service = service
            self.nonce = nonce
            self.producerRequirement = producerRequirement
            self.control = control
            self.purpose = purpose
            self.url = url
            self.title = title
            self.uploadDir = uploadDir
        }
    }

    public init(linkId: String, cmdId: String, op: Op) {
        self.linkId = linkId
        self.cmdId = cmdId
        self.op = op
    }

    /// The presentation service names Winter Headless checks in (`WinterPresentServiceName`).
    public static let servicePrefix = "com.winter.headless.present."
    /// A bootstrap name is at most this long.
    static let serviceMaxLength = 128
    /// The most rows one `headless.tabs` carries (the daemon's own caps are far below it).
    static let tabsMax = 256

    /// Is `op` one of the ops this parser reads (and `BrowserLinkCommand.parse` does not)?
    public static func handles(op: String) -> Bool {
        op == BrowserLinkProtocol.Op.headlessShow || op == BrowserLinkProtocol.Op.headlessHide
            || op == BrowserLinkProtocol.Op.headlessTabs
    }

    /// Read a notification's params. Never traps; every shape it does not understand is `Unreadable`.
    public static func parse(_ params: JSONValue) -> Result<BrowserLinkHeadlessCommand, BrowserLinkCommand.Unreadable> {
        let linkId = params["linkId"]?.stringValue
        let cmdId = params["cmdId"]?.stringValue
        func unreadable(_ reason: String) -> Result<BrowserLinkHeadlessCommand, BrowserLinkCommand.Unreadable> {
            .failure(BrowserLinkCommand.Unreadable(linkId: linkId, cmdId: cmdId, reason: reason))
        }
        guard let linkId, let cmdId else { return unreadable("a command without linkId/cmdId") }
        guard let op = params["op"]?.stringValue else { return unreadable("a command without an op") }
        let p = params["params"] ?? .object([:])
        guard case .object = p else { return unreadable("\(op): params is not an object") }

        func string(_ key: String) -> String? {
            guard let value = p[key]?.stringValue, !value.isEmpty else { return nil }
            return value
        }
        /// A string that must be present but may be empty (a page's title, an about:blank URL).
        func text(_ key: String) -> String? { p[key]?.stringValue }
        func done(_ op: Op) -> Result<BrowserLinkHeadlessCommand, BrowserLinkCommand.Unreadable> {
            .success(BrowserLinkHeadlessCommand(linkId: linkId, cmdId: cmdId, op: op))
        }

        switch op {
        case BrowserLinkProtocol.Op.headlessShow:
            guard let sessionId = string("sessionId"), let tabId = string("tabId") else {
                return unreadable("headless.show needs sessionId and tabId")
            }
            guard let service = string("service"), isServiceName(service) else {
                return unreadable("headless.show: service is not a presentation service name")
            }
            guard let nonceText = string("nonce"), let nonce = parseNonce(nonceText) else {
                return unreadable("headless.show: nonce is not 16 hex digits")
            }
            guard let requirement = string("producerRequirement") else {
                return unreadable("headless.show needs producerRequirement")
            }
            guard case .bool(let control)? = p["control"] else { return unreadable("headless.show needs control") }
            guard let purposeText = string("purpose"), let purpose = BrowserLinkHeadlessPurpose(rawValue: purposeText) else {
                return unreadable("headless.show: purpose is handoff or watch")
            }
            guard let url = text("url"), let title = text("title") else {
                return unreadable("headless.show needs url and title")
            }
            guard let uploadDir = string("uploadDir"), uploadDir.hasPrefix("/") else {
                return unreadable("headless.show: uploadDir is not an absolute path")
            }
            return done(.show(Show(sessionId: sessionId, tabId: tabId, service: service, nonce: nonce,
                                   producerRequirement: requirement, control: control, purpose: purpose,
                                   url: url, title: title, uploadDir: uploadDir)))
        case BrowserLinkProtocol.Op.headlessHide:
            guard let sessionId = string("sessionId"), let tabId = string("tabId"), let reason = text("reason") else {
                return unreadable("headless.hide needs sessionId, tabId and reason")
            }
            return done(.hide(sessionId: sessionId, tabId: tabId, reason: reason))
        case BrowserLinkProtocol.Op.headlessTabs:
            guard let sessionId = string("sessionId"), let list = p["tabs"]?.arrayValue else {
                return unreadable("headless.tabs needs sessionId and tabs")
            }
            guard list.count <= tabsMax else { return unreadable("headless.tabs: more than \(tabsMax) tabs") }
            let tabs = list.compactMap(BrowserLinkHeadlessTab.read)
            guard tabs.count == list.count else {
                return unreadable("headless.tabs: every tab has tabId, url, title, presented and control")
            }
            return done(.tabs(sessionId: sessionId, tabs: tabs))
        default:
            return unreadable("unknown op \(op)")
        }
    }

    /// `com.winter.headless.present.` and then letters, digits and dots only, within a bootstrap name's length.
    static func isServiceName(_ name: String) -> Bool {
        guard name.hasPrefix(servicePrefix), name.utf8.count <= serviceMaxLength else { return false }
        let rest = name.dropFirst(servicePrefix.count)
        guard !rest.isEmpty else { return false }
        return rest.unicodeScalars.allSatisfy { scalar in
            scalar.isASCII && (CharacterSet.alphanumerics.contains(scalar) || scalar == ".")
        }
    }

    /// Exactly 16 hex digits, as a UInt64 (radix 16).
    static func parseNonce(_ text: String) -> UInt64? {
        guard text.utf8.count == 16, text.unicodeScalars.allSatisfy({ $0.isASCII && $0.properties.isASCIIHexDigit }) else {
            return nil
        }
        return UInt64(text, radix: 16)
    }
}

/// Why a `browserLink.headless` request did not succeed.
public enum BrowserLinkHeadlessError: Error, Equatable, Sendable {
    /// No link is up right now.
    case notConnected
    /// The daemon did not name the `headless` feature at attach (an older daemon).
    case unsupported
    /// The daemon refused it — `code` is its `data.code` when it gave one (`headless_unavailable`,
    /// `headless_refused`, `invalid_params`, …), `message` its sentence.
    case refused(code: String?, message: String)
    /// The request never got an answer (the connection dropped, a timeout).
    case failed(message: String)

    /// One sentence for the panel.
    public var message: String {
        switch self {
        case .notConnected: return "Winter isn't connected to its daemon right now"
        case .unsupported: return "this Winter's daemon can't show headless tabs — update Winter"
        case .refused(_, let message): return message
        case .failed(let message): return message
        }
    }
}
