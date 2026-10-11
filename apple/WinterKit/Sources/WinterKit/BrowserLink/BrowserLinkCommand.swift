import Foundation

/// One `browserLink.command` notification, read. Everything the app executes arrives as one of these.
public struct BrowserLinkCommand: Sendable, Equatable {
    public let linkId: String
    public let cmdId: String
    public let op: Op

    public enum Op: Sendable, Equatable {
        /// Make the tab's browser live (created parked if it is not), load `url` if it has to create
        /// it, and hold it until `tabRelease`/`tabClose` or the link closes.
        case tabEnsure(sessionId: String, tabId: String, url: String?)
        case tabRelease(tabId: String)
        /// Close the tab's browser by the hardened path. The daemon appends `panel_tab_closed` itself.
        case tabClose(tabId: String)
        case tabsLive
        /// `params` is always a JSON object (`{}` when the command carried none).
        case cdpSend(tabId: String, method: String, params: JSONValue, cdpSessionId: String?)
        case cdpSubscribe(tabId: String, events: [String])
        case overlay(tabId: String, active: Bool, cursor: JSONValue?)
    }

    public init(linkId: String, cmdId: String, op: Op) {
        self.linkId = linkId
        self.cmdId = cmdId
        self.op = op
    }

    /// Why a command could not be read. When the command at least named itself (`linkId` and `cmdId`),
    /// it is still owed an answer — a failure saying so — and these carry what that answer needs.
    public struct Unreadable: Error, Equatable, Sendable {
        public let linkId: String?
        public let cmdId: String?
        public let reason: String
    }

    /// Read a notification's params. Never traps; every shape it does not understand is `Unreadable`.
    public static func parse(_ params: JSONValue) -> Result<BrowserLinkCommand, Unreadable> {
        let linkId = params["linkId"]?.stringValue
        let cmdId = params["cmdId"]?.stringValue
        func unreadable(_ reason: String) -> Result<BrowserLinkCommand, Unreadable> {
            .failure(Unreadable(linkId: linkId, cmdId: cmdId, reason: reason))
        }
        guard let linkId, let cmdId else { return unreadable("a command without linkId/cmdId") }
        guard let op = params["op"]?.stringValue else { return unreadable("a command without an op") }
        let p = params["params"] ?? .object([:])
        guard case .object = p else { return unreadable("\(op): params is not an object") }

        func string(_ key: String) -> String? {
            guard let value = p[key]?.stringValue, !value.isEmpty else { return nil }
            return value
        }
        func done(_ op: Op) -> Result<BrowserLinkCommand, Unreadable> {
            .success(BrowserLinkCommand(linkId: linkId, cmdId: cmdId, op: op))
        }

        switch op {
        case BrowserLinkProtocol.Op.tabEnsure:
            guard let sessionId = string("sessionId"), let tabId = string("tabId") else {
                return unreadable("tab.ensure needs sessionId and tabId")
            }
            return done(.tabEnsure(sessionId: sessionId, tabId: tabId, url: string("url")))
        case BrowserLinkProtocol.Op.tabRelease:
            guard let tabId = string("tabId") else { return unreadable("tab.release needs tabId") }
            return done(.tabRelease(tabId: tabId))
        case BrowserLinkProtocol.Op.tabClose:
            guard let tabId = string("tabId") else { return unreadable("tab.close needs tabId") }
            return done(.tabClose(tabId: tabId))
        case BrowserLinkProtocol.Op.tabsLive:
            return done(.tabsLive)
        case BrowserLinkProtocol.Op.cdpSend:
            guard let tabId = string("tabId"), let method = string("method") else {
                return unreadable("cdp.send needs tabId and method")
            }
            let methodParams = p["params"] ?? .object([:])
            guard case .object = methodParams else { return unreadable("cdp.send: the method's params are not an object") }
            return done(.cdpSend(tabId: tabId, method: method, params: methodParams, cdpSessionId: string("cdpSessionId")))
        case BrowserLinkProtocol.Op.cdpSubscribe:
            guard let tabId = string("tabId"), let list = p["events"]?.arrayValue else {
                return unreadable("cdp.subscribe needs tabId and events")
            }
            let events = list.compactMap(\.stringValue)
            guard events.count == list.count else { return unreadable("cdp.subscribe: every event is a method name") }
            return done(.cdpSubscribe(tabId: tabId, events: events))
        case BrowserLinkProtocol.Op.overlay:
            guard let tabId = string("tabId") else { return unreadable("overlay needs tabId") }
            return done(.overlay(tabId: tabId, active: p["active"]?.boolValue ?? false, cursor: p["cursor"]))
        default:
            return unreadable("unknown op \(op)")
        }
    }
}
