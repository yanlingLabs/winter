import Foundation

// -----------------------------------------------------------------------------------------------
// ComputerV2 Phase 2 — the BROWSER LINK: Winter.app ↔ the daemon, the dedicated connection through
// which the daemon's browser engine drives Winter's built-in (CEF) browser over CDP, with no window.
//
// The daemon side is `packages/core/src/computer-use/browser/cef-link/`. This file is the Swift half of
// the wire's fixed vocabulary — method names, ops, error codes, caps and the protocol number — so the
// link client (`BrowserLinkClient`) and the app's executor share one spelling of each.
//
// The wire, in one paragraph: a `WinterClient` named `browser-link` says `protocol.hello` as a harness,
// then `browserLink.attach {protocol, appVersion, pid}` → `{linkId, protocol}`. The daemon sends
// `browserLink.command {linkId, cmdId, op, params}` notifications; the app answers each with ONE
// `browserLink.result` request, and sends `browserLink.events` (batched CDP events) and
// `browserLink.tabGone` requests of its own. A second attach from anywhere replaces the first, which is
// told so with `browserLink.detached {linkId, reason: "replaced"}`. Nothing on this connection is a
// `SessionEvent`, and it never attaches to a session.
// -----------------------------------------------------------------------------------------------

public enum BrowserLinkProtocol {
    /// `BROWSER_LINK_PROTOCOL` — bumped on any observable change to the wire. A repo test keeps this
    /// equal to the daemon's constant (`BrowserLinkProtocolParityTests`).
    public static let version = 1

    /// The link's own connection, separate from every other harness the app runs.
    public static let clientName = "browser-link"

    public enum Method {
        public static let attach = "browserLink.attach"
        public static let result = "browserLink.result"
        public static let events = "browserLink.events"
        public static let tabGone = "browserLink.tabGone"
        /// Daemon → app notification.
        public static let command = "browserLink.command"
        /// Daemon → app notification.
        public static let detached = "browserLink.detached"
    }

    /// `browserLink.command`'s `op`.
    public enum Op {
        public static let tabEnsure = "tab.ensure"
        public static let tabRelease = "tab.release"
        public static let tabClose = "tab.close"
        public static let tabsLive = "tabs.live"
        public static let cdpSend = "cdp.send"
        public static let cdpSubscribe = "cdp.subscribe"
        public static let overlay = "overlay"
    }

    /// The codes a failed `browserLink.result` may carry — the whole set; the app answers nothing else.
    public enum ErrorCode: String, Sendable, Equatable {
        case tabGone = "tab_gone"
        case notLive = "not_live"
        case cdpError = "cdp_error"
        case notAllowed = "not_allowed"
        case timeout
        /// The app's browser runtime is shutting down (the quit beat).
        case quiescent
    }

    /// `browserLink.tabGone`'s `reason`.
    public enum TabGoneReason: String, Sendable, Equatable {
        case closed
        case crashed
        case stopped
    }

    /// At most this many events per `browserLink.events` batch…
    public static let eventBatchMax = 256
    /// …and none waits longer than this for its batch to go out.
    public static let eventFlushWindow: Duration = .milliseconds(50)

    /// The daemon's cap on one line from an authenticated client — a `browserLink.result` must fit (a
    /// 3 MiB JPEG in base64 does). A result whose payload would not fit is answered as a failure rather
    /// than sent: an oversized line makes the daemon drop the whole connection.
    public static let resultLineCap = 8 * 1024 * 1024
    /// Room left in `resultLineCap` for the envelope around a result's payload, and for JSON escaping.
    public static let resultEnvelopeAllowance = 256 * 1024

    /// The link reconnects on this backoff, doubling from the first to the second.
    public static let reconnectBackoffInitial: Duration = .seconds(1)
    public static let reconnectBackoffMax: Duration = .seconds(30)
}

/// The answer to one `browserLink.command`. `.okRaw` carries a JSON object the app already holds as
/// text (a CDP result — a screenshot's is several megabytes), placed under `key` in the result object
/// without the app ever building a tree for it on the main thread.
public enum BrowserLinkReply: Sendable, Equatable {
    case ok(JSONValue)
    case okRaw(key: String, json: String)
    case failure(code: BrowserLinkProtocol.ErrorCode, message: String, data: JSONValue? = nil)

    public static let empty = BrowserLinkReply.ok(.object([:]))
}
