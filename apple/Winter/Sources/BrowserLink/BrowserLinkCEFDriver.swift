import AppKit
import Foundation

/// ComputerV2 Phase 2 — **every CEF call the browser link makes**, behind one seam.
///
/// The same posture as `BrowserRuntime.CEFDriver`, for the same standing reason: no CEF client override
/// is callable under XCTest, ever, so the link's logic (`BrowserLinkHost`) must be reachable without CEF
/// and the only way there is a seam a test substitutes. `production` is the whole un-substitutable half —
/// one forward per `WinterCEF*` entry point, no branch and no state of its own.
///
/// Separate from `BrowserRuntime.CEFDriver` because none of this is the runtime's: the runtime owns
/// browsers and decides nothing about automation; these are the link's CDP door, its event channel
/// and its native-UI holds.
struct BrowserLinkCEFDriver {
    /// The container's live browser id, `0` for none (`WinterCEFBrowserIdentifierForParent`) — how
    /// `tab.ensure` knows a created browser has actually arrived.
    var browserIdentifier: (PanelCEFContainerView) -> Int
    /// One DevTools method on the tab's own session (`cdpSessionId` nil) or a child target's
    /// (`WinterCEFSendCDP`). The completion always fires, once, on the main thread.
    var sendCDP: (PanelCEFContainerView, String, String, String?,
                  @escaping (WinterCEFCDPStatus, String) -> Void) -> Void
    /// The tab's DevTools events: `(method, params JSON, cdpSessionId)`. `nil` stops them.
    var setEventObserver: (PanelCEFContainerView, ((String, Data, String?) -> Void)?) -> Void
    var setCrashObserver: (PanelCEFContainerView, (() -> Void)?) -> Void
    /// `WinterCEFAutomationNativeUI` flags (`BrowserNativeUIPolicy.flags(held:)`).
    var setNativeUI: (PanelCEFContainerView, UInt32) -> Void
    /// Answer or forget the JS dialog the tab holds; whether there was one.
    var resolveHeldDialog: (PanelCEFContainerView, WinterCEFHeldDialogAction, String?) -> Bool
    /// Reload the tab — the restart of a crashed renderer.
    var reload: (PanelCEFContainerView) -> Void

    static let production = BrowserLinkCEFDriver(
        browserIdentifier: { Int(WinterCEFBrowserIdentifierForParent($0)) },
        sendCDP: { container, method, params, session, completion in
            // An empty session is the tab's own (`WinterCEFSendCDP`'s contract).
            WinterCEFSendCDP(container, method, params, session ?? "") { status, payload in
                completion(status, payload ?? "{}")
            }
        },
        setEventObserver: { container, observer in
            WinterCEFSetDevToolsEventObserver(container, observer.map { observe in
                { method, params, session in
                    observe(method ?? "", params ?? Data("{}".utf8), session)
                }
            })
        },
        setCrashObserver: { WinterCEFSetRendererCrashObserver($0, $1) },
        setNativeUI: { WinterCEFSetAutomationNativeUI($0, $1) },
        resolveHeldDialog: { container, action, prompt in
            WinterCEFResolveHeldDialog(container, action, prompt ?? "")
        },
        reload: { WinterCEFReload($0) })
}

/// ComputerV2 Phase 2 — **which native UI a tab may show**, as the flags `WinterCEF.mm`'s handlers read.
///
/// While the browser link holds a tab, NOTHING native comes out of it: no JavaScript dialog window, no
/// permission prompt, no file chooser, no download prompt. Those would put Winter's UI in front of the
/// user — the one thing an automated tab must never do (it would take their focus and their view) —
/// and they would block a script on a window no one is looking at. Instead, every kind is answered
/// where the agent can see and act on it:
///
///  * a JS dialog is HELD (never shown) and the engine reads it over CDP (`Page.javascriptDialogOpening`)
///    and answers it (`Page.handleJavaScriptDialog`);
///  * a permission request is denied;
///  * a file chooser is cancelled (the engine intercepts it over CDP first and uploads by
///    `DOM.setFileInputFiles`);
///  * a download is refused (downloads are a later phase).
///
/// A tab the link does not hold gets none of it: every handler then gives CEF's own default, exactly as
/// before the link existed.
enum BrowserNativeUIPolicy {
    static func flags(held: Bool) -> UInt32 {
        guard held else { return 0 }
        let all: WinterCEFAutomationNativeUI = [.holdsJSDialogs, .deniesPermissions, .cancelsFileChooser,
                                                .cancelsDownloads]
        return all.rawValue
    }
}
