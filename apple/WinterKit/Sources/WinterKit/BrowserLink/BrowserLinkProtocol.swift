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
    ///
    /// 2 (ComputerV2 Phase 3): the ops `tab.present`, `tab.mute`, `tab.downloads` and `tab.download`, and the
    /// app's `browserLink.download` request.
    public static let version = 2

    /// The link's own connection, separate from every other harness the app runs.
    public static let clientName = "browser-link"

    /// `BROWSER_LINK_FEATURES` — what this side can do beyond the protocol number, named at attach (the app in its
    /// params, the daemon in its answer). A side never uses a feature the other did not name. A repo test keeps this
    /// equal to the daemon's list (`BrowserLinkParityTests`).
    ///
    /// `headless` (ComputerV2 Phase 4, lane H3): the app's panel can show a tab of Winter's HEADLESS browser — the
    /// live page drawn from Winter Headless's own GPU frames (`headless.show`/`headless.hide`/`headless.tabs`), and
    /// the person's actions on it go back as `browserLink.headless`.
    /// `watchOnly` (ComputerV2 wake triggers): `tab.ensure` may carry `watchOnly: true` — a WATCH-ONLY hold, under which
    /// the app sets none of its native-UI holds (`BrowserNativeUIPolicy`): the tab's dialogs, permission prompts, file
    /// choosers, downloads, context menus, keys and focus stay the user's while a wake trigger waits on it. A
    /// `tab.ensure` without it takes the full hold back; one with it drops back. It still counts toward the held-tab
    /// ceiling.
    public static let features = ["headless", "watchOnly"]

    public enum Method {
        public static let attach = "browserLink.attach"
        public static let result = "browserLink.result"
        public static let events = "browserLink.events"
        public static let tabGone = "browserLink.tabGone"
        /// Phase 3: one download the built-in browser saved for an armed tab (or refused for an unarmed one).
        public static let download = "browserLink.download"
        /// Feature `headless`: the person, in Winter's panel, acting on one of a session's headless tabs.
        public static let headless = "browserLink.headless"
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
        /// Phase 3: show the session's window with this panel tab selected (the sign-in handoff, on the user's OK).
        public static let tabPresent = "tab.present"
        public static let tabMute = "tab.mute"
        /// Phase 3: arm (or disarm, `dir: null`) the tab's own download handler.
        public static let tabDownloads = "tab.downloads"
        /// Phase 3: download a URL in the tab's browser (its cookies), caught by the armed handler.
        public static let tabDownload = "tab.download"
        /// Feature `headless`: connect to a headless tab's presentation and show it in the session's panel. These
        /// three are read by `BrowserLinkHeadlessCommand`, never by `BrowserLinkCommand.parse` (whose `Op` stays
        /// closed: Winter Headless compiles that parser and switches over every case).
        public static let headlessShow = "headless.show"
        /// Feature `headless`: stop showing it.
        public static let headlessHide = "headless.hide"
        /// Feature `headless`: the session's headless tabs changed (the panel's list).
        public static let headlessTabs = "headless.tabs"
        /// Feature `headless`: why a shown tab is shown changed (a watch became a hand-off, a hand-off is over).
        public static let headlessUpdate = "headless.update"
    }

    /// A download the app reports (`browserLink.download`'s `download.state`).
    public enum DownloadState: String, Sendable, Equatable {
        case started, progress, done, failed, refused
    }
    /// At most one `progress` report per download this often.
    public static let downloadProgressInterval: Duration = .milliseconds(500)

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

    /// **Every line the link sends must stay far under `resultLineCap`** — the daemon drops the whole
    /// connection on one oversized line, so a page that could make one (a 10 MB frame name, a giant
    /// URL) could cut the built-in browser off for every session. Events are bounded three ways:
    /// a string in an event's params is cut to `eventStringMaxBytes` (marked as cut); an event still
    /// over `eventMaxBytes` is dropped, logged by method only; and a batch is sent before it would pass
    /// `eventBatchMaxBytes`.
    public static let eventStringMaxBytes = 4 * 1024
    public static let eventMaxBytes = 256 * 1024
    public static let eventBatchMaxBytes = 4 * 1024 * 1024

    /// A failed result's message is cut to this (UTF-8 bytes, marker included well inside the daemon's
    /// 4,096-character limit on it).
    public static let failureMessageMaxBytes = 2 * 1024

    /// Whether a result payload of `bytes` fits one line the daemon accepts, with room for its envelope.
    public static func resultFits(bytes: Int) -> Bool {
        bytes + resultEnvelopeAllowance <= resultLineCap
    }

    /// The answer for a result that does not fit — never sent as is (see `resultFits`).
    public static func resultTooLarge(bytes: Int) -> BrowserLinkReply {
        .failure(code: .cdpError,
                 message: "the browser's answer (\(bytes) bytes) is over the browser link's \(resultLineCap / (1024 * 1024)) MiB line cap",
                 data: .object(["cdpCode": .number(-32603), "cdpMessage": .string("result too large for the browser link")]))
    }

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
