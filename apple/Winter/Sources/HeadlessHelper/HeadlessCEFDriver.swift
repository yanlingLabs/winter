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
}
