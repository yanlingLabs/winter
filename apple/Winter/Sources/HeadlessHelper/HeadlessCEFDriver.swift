import AppKit
import Foundation

/// How a DevTools call ended (`WinterCEFCDPStatus`, without the CEF-facing type, so the host's logic compiles and
/// is tested with no CEF at all).
enum HeadlessCDPStatus: Sendable, Equatable {
    case ok
    case protocolError
    case notLive
    case gone
    case refused
}

/// What to do with the JS dialog a tab holds (`WinterCEFHeldDialogAction`).
enum HeadlessDialogAction: Sendable, Equatable {
    case accept
    case dismiss
    case drop
}

/// Every CEF call Winter Headless makes, behind one seam — the same posture as Winter.app's
/// `BrowserLinkCEFDriver`: no CEF runs under XCTest, so the host's logic is reached through a driver a test
/// substitutes. The production half (`HeadlessCEFDriver.production`, in the app target only) is one forward per
/// `WinterCEF*` entry point.
struct HeadlessCEFDriver {
    /// A windowless browser keyed by the view, loading `url`, in the session's own request context.
    var create: (_ key: NSView, _ url: String, _ sessionId: String) -> Void
    /// The key's live browser id, `0` for none yet.
    var browserIdentifier: (NSView) -> Int
    /// One DevTools method on the tab's own session (`cdpSessionId` nil) or a child target's. The completion
    /// fires once, on the main thread.
    var sendCDP: (NSView, String, String, String?, @escaping (HeadlessCDPStatus, String) -> Void) -> Void
    /// The tab's DevTools events: `(method, params JSON, cdpSessionId)`. `nil` stops them.
    var setEventObserver: (NSView, ((String, Data, String?) -> Void)?) -> Void
    var setCrashObserver: (NSView, (() -> Void)?) -> Void
    /// `(url, title, loading)` as the browser reports them. `nil` stops them.
    var setStateObserver: (NSView, ((String, String, Bool) -> Void)?) -> Void
    /// Every native-UI flag on, for good.
    var lockNativeUI: (NSView) -> Void
    var resolveHeldDialog: (NSView, HeadlessDialogAction, String?) -> Bool
    /// Close the key's browser (it never runs a `beforeunload` prompt — there is nobody to ask).
    var close: (NSView) -> Void
    var disposeContext: (String) -> Void
    /// What a page tried and was refused, by browser id: `"popup"` or `"local-network"` (main thread). `nil` stops it.
    var setNoticeObserver: (((Int, String) -> Void)?) -> Void = { _ in }
    /// A window the page opened while the person holds the browser: `(openerBrowserId, url)` → the key of the tab to
    /// create it under, or nil to refuse it (main thread). `nil` stops it.
    var setPopupAdopter: (((Int, String) -> NSView?)?) -> Void = { _ in }
    /// A browser closed — by the page (`window.close()` of a window it opened) or by Winter (main thread).
    var setClosedObserver: (((Int) -> Void)?) -> Void = { _ in }
    /// A browser's view changed as applied — a shown tab laid out in the panel's size, or the agent's view back:
    /// `(browserId, cssWidth, cssHeight, scale)` (main thread). `nil` stops it.
    var setViewObserver: (((Int, Int, Int, Double) -> Void)?) -> Void = { _ in }
    /// Present the key's browser (`HeadlessPresentation`) to the viewer naming `nonce` and satisfying `requirement`:
    /// the presentation's bootstrap service name and a handle, or why not. `started` runs once when the viewer's HELLO
    /// is accepted; `ended` runs once if the VIEWER ends it.
    var present: (_ key: NSView, _ browserId: Int, _ request: HeadlessPresentRequest, _ started: @escaping () -> Void,
                  _ ended: @escaping (String) -> Void) -> Result<(service: String, handle: AnyObject), HeadlessPresentFailure> = { _, _, _, _, _ in
        .failure(HeadlessPresentFailure(message: "presentation is not available"))
    }
    /// End a presentation now; what it measured.
    var unpresent: (_ handle: AnyObject) -> [String: Double] = { _ in [:] }
    /// Whether the viewer may send input from now on.
    var setControl: (_ handle: AnyObject, _ control: Bool) -> Void = { _, _ in }
}

/// `headless.present`'s parameters (`HeadlessWire`).
struct HeadlessPresentRequest: Equatable, Sendable {
    let tabId: String
    /// The nonce both sides must name (16 hex digits on the wire).
    let nonce: UInt64
    /// The viewer's code-signing requirement (Winter.app's designated requirement), as the daemon names it.
    let viewerRequirement: String
    let control: Bool
    let scale: Double
}

struct HeadlessPresentFailure: Error, Equatable {
    let message: String
}
