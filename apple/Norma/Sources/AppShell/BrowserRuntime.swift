import AppKit
import Foundation

/// browser-runtime T3 — RED STUB. Signatures only; every body lands in the GREEN commit.
@MainActor
final class BrowserRuntime {

    struct CEFDriver {
        var setStateObserver: (PanelCEFContainerView, ((NormaCEFBrowserState?) -> Void)?) -> Void
        var setNavigationObserver: (PanelCEFContainerView, ((String?, String?) -> Void)?) -> Void
        var setPopupObserver: (PanelCEFContainerView, ((String?) -> Void)?) -> Void
        var seedTabState: (PanelCEFContainerView, String, String) -> Void
        var createBrowser: (PanelCEFContainerView, String) -> Void
        var closeBrowser: (PanelCEFContainerView) -> Void
        var ensureInitialized: () -> Bool
        var failureReason: () -> String?
        var isRetryable: () -> Bool
        var clearFailure: () -> Void

        static let production = CEFDriver(
            setStateObserver: { NormaCEFSetStateObserver($0, $1) },
            setNavigationObserver: { NormaCEFSetNavigationObserver($0, $1) },
            setPopupObserver: { NormaCEFSetPopupObserver($0, $1) },
            seedTabState: { NormaCEFSeedTabState($0, $1, $2) },
            createBrowser: { NormaCEFCreateBrowser($0, $1) },
            closeBrowser: { NormaCEFCloseBrowser($0) },
            ensureInitialized: { false },
            failureReason: { nil },
            isRetryable: { false },
            clearFailure: {})
    }

    struct Scheduler {
        struct Cancellable {
            let cancel: () -> Void
        }
        var now: () -> Date
        var mainAsync: (@escaping () -> Void) -> Void
        var timer: (Date, @escaping () -> Void) -> Cancellable

        static let production = Scheduler(now: Date.init, mainAsync: { _ in },
                                          timer: { _, _ in Cancellable(cancel: {}) })
    }

    struct ResponderSearch: Equatable {
        enum MatchKind: String, Equatable { case className, textInputClient, none }
        var view: NSView?
        var matchedBy: MatchKind
        var count: Int
    }

    static let shared = BrowserRuntime()

    static let renderWidgetHostViewClassName = "RenderWidgetHostViewCocoa"
    static let lingerRecheckInterval: TimeInterval = 30

    weak var host: ShellSessionHost?
    var onLingerDeadline: ((String) -> Void)?

    init(driver: CEFDriver = .production, scheduler: Scheduler = .production) {}

    var liveTabIds: Set<String> { [] }
    var viewportTabId: String? { nil }
    var pendingStopDeadlines: [String: Date] { [:] }
    var lruOrder: [String] { [] }
    var hasParkingWindow: Bool { false }
    var parkingWindow: NSWindow { NSWindow() }

    func apply(_ actions: [BrowserAction], tabs: [String: [BrowserTabState]],
               sessionOf: (String) -> String?) {}

    func attachViewport(tabId: String, into host: NSView) {}

    func detachViewport(tabId: String) {}

    func isLive(tabId: String) -> Bool { false }

    func container(forTabId tabId: String) -> PanelCEFContainerView? { nil }

    static func findKeyboardResponder(in container: NSView) -> ResponderSearch {
        ResponderSearch(view: nil, matchedBy: .none, count: 0)
    }
}
