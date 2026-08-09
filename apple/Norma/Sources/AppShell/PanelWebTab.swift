import AppKit
import SwiftUI

/// panel-cef Task 6a: the `.web` implementation of Plan A's `PanelTabContent` boundary
/// (`PanelTab.swift`) — a real Chromium page, hosted in an `NSView`, behind the same protocol the
/// frame was written against. The frame does not change: `ShellPanel` renders `makeContent()` in
/// the slot that used to hold `Color.clear`.
///
/// **`makeChrome()` is deliberately empty.** Back/forward/reload, the centre-aligned URL field and
/// the `⋮` overflow are Task 6b; wiring the slot here (rather than in 6b) means 6b is purely
/// additive and today's rendering is byte-identical to Plan A's — the URL row stays blank.
struct PanelWebTab: PanelTabContent {
    let tab: PanelTab

    var kind: PanelTabKind { .web }
    var title: String { panelTabDisplayTitle(tab) }
    var icon: Image { Image(systemName: panelTabFaviconSystemImage(.web)) }

    func makeChrome() -> AnyView { AnyView(Color.clear) }

    func makeContent() -> AnyView {
        AnyView(PanelCEFView(url: tab.url ?? panelWebTabStartPageURL))
    }
}

/// Every non-`.web` kind, rendering exactly what Plan A rendered for ALL kinds: nothing. Document /
/// code / note surfaces are later plans (the spec's LibreOffice and Monaco slots); this exists so
/// `panelTabContent(for:)` below can be exhaustive over `PanelTabKind` instead of falling through a
/// `default:` that would silently swallow a future case — the same discipline `PanelTabKind`'s own
/// doc comment demands of every switch over it.
struct PanelPlaceholderTab: PanelTabContent {
    let tab: PanelTab

    var kind: PanelTabKind { tab.kind }
    var title: String { panelTabDisplayTitle(tab) }
    var icon: Image { Image(systemName: panelTabFaviconSystemImage(tab.kind)) }

    func makeChrome() -> AnyView { AnyView(Color.clear) }
    func makeContent() -> AnyView { AnyView(Color.clear) }
}

/// The one place a `PanelTab` becomes a rendered surface. Exhaustive, no `default:`.
func panelTabContent(for tab: PanelTab) -> PanelTabContent {
    switch tab.kind {
    case .web: return PanelWebTab(tab: tab)
    case .document, .code, .note: return PanelPlaceholderTab(tab: tab)
    }
}

/// PURE: which tab the panel renders. The active one — or, when nothing is active, the FIRST tab.
///
/// The fallback is what makes the panel show anything at all in the ordinary case, and it is a
/// finding rather than a defensive habit: `panel.openTab` (`packages/core/src/ipc/server.ts`)
/// appends `panel_tab_opened` and nothing else — never `panel_tab_activated` — and both folds (TS
/// `foldPanelTabs` and its Swift mirror in `PanelTab.swift`) set `activeTabId` ONLY from
/// `panel_tab_activated`. So a tab that was just opened is open but not active. Plan A could not
/// see this because it rendered `Color.clear` for every tab: "no active tab" and "the active tab is
/// blank" were the same picture. Task 6a is where they stop being the same picture.
///
/// Whether opening a tab SHOULD activate it is a wire decision Plan A owns, carried to Task 6b.
/// Until it is made, the visible cost of resolving it here is that `PanelTabStrip` highlights
/// `activeTabId` while this renders the fallback, so with nothing active the shown tab is not the
/// highlighted one.
func panelShownTab(tabs: [PanelTab], activeTabId: String?) -> PanelTab? {
    if let activeTabId, let tab = tabs.first(where: { $0.tabId == activeTabId }) {
        return tab
    }
    return tabs.first
}

/// What a tab with no URL of its own shows. A daemon-minted `.web` tab carries `url: nil` today —
/// the panel's "+" opens one with no destination and nothing can navigate it until Task 6b — so
/// this is what "a page renders" actually renders in the shipped path.
///
/// A `data:` URL, and safe to be one: Chromium blocks top-frame navigations TO `data:` when a PAGE
/// initiates them, not when the embedder creates a browser at one (Task 1 loaded exactly this shape
/// and screenshotted the result). It is local, needs no network, and is never persisted — Task 6b's
/// URL-scheme policy governs what may be written back to the daemon and restored, which is a
/// different question from what a fresh empty tab paints.
let panelWebTabStartPageURL: String = {
    let html = """
        <!doctype html><meta charset="utf-8"><title>New Tab</title>
        <style>html,body{height:100%;margin:0}body{display:flex;align-items:center;\
        justify-content:center;font:13px -apple-system,system-ui,sans-serif;color:#8a8a8e;\
        background:#fff}@media(prefers-color-scheme:dark){body{background:#1c1c1e;color:#8a8a8e}}\
        </style><body>New Tab
        """
    let encoded = html.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
    return "data:text/html;charset=utf-8,\(encoded)"
}()

// MARK: - Hosting CEF's NSView

/// The SwiftUI seam. `CefWindowHandle` IS an `NSView*` on macOS, so `CefWindowInfo::SetAsChild`
/// adds Chromium's own view as a subview of the container below — no layer surgery, no offscreen
/// rendering.
///
/// **One browser per tab, for this task.** The view is `.id`'d by tab in `ShellPanel`, so switching
/// tabs dismantles this representable and closes its browser; switching back creates a fresh one at
/// the tab's URL. That is a known, deliberate gap — a browser that survives tab switches needs a
/// registry keyed by `tabId` and a close hook wired to `panel_tab_closed`, which is more lifecycle
/// than "a page renders in the panel" is scoped to carry.
struct PanelCEFView: NSViewRepresentable {
    let url: String

    func makeNSView(context: Context) -> PanelCEFContainerView {
        let container = PanelCEFContainerView()
        // NOT synchronous. `makeNSView` runs inside a SwiftUI view update, and `CefInitialize`
        // stands up a process tree, runs `OnContextInitialized` re-entrantly and starts a run-loop
        // timer. Hopping one turn keeps all of that out of the update pass, and it is also what
        // guarantees the run loop is genuinely spinning when CEF comes up (see `NormaCEFRuntime`'s
        // note on Task 1's starvation hypothesis).
        DispatchQueue.main.async {
            guard NormaCEFRuntime.ensureInitialized() else {
                if case .failed(let reason) = NormaCEFRuntime.state {
                    container.showUnavailable(reason)
                }
                return
            }
            NormaCEFCreateBrowser(container, url)
        }
        return container
    }

    func updateNSView(_ nsView: PanelCEFContainerView, context: Context) {}

    /// Closing here — rather than leaking the browser and letting the container's `deinit` decide —
    /// is what keeps a closed or switched-away tab from leaving a live renderer process behind.
    static func dismantleNSView(_ nsView: PanelCEFContainerView, coordinator: ()) {
        NormaCEFCloseBrowser(nsView)
    }
}

/// The container CEF parents its view into.
///
/// It owns exactly one behaviour beyond being an `NSView`: keeping Chromium's subview at its own
/// bounds. CEF does not set an autoresizing mask on the view it adds, and `updateNSView` does not
/// fire for every live-resize step, so the resize is handled here where AppKit actually reports it.
final class PanelCEFContainerView: NSView {
    private var unavailableLabel: NSTextField?

    override func resizeSubviews(withOldSize oldSize: NSSize) {
        super.resizeSubviews(withOldSize: oldSize)
        for subview in subviews where subview !== unavailableLabel {
            subview.frame = bounds
        }
    }

    override func layout() {
        super.layout()
        if let label = unavailableLabel {
            label.frame = bounds.insetBy(dx: 16, dy: 16)
        }
    }

    /// CEF could not start. The panel says so instead of showing a permanently blank rectangle —
    /// and Norma keeps running, which is the whole reason none of the bridge's entry points abort.
    func showUnavailable(_ reason: String) {
        guard unavailableLabel == nil else { return }
        let label = NSTextField(labelWithString: "The browser panel is unavailable.\n\(reason)")
        label.alignment = .center
        label.maximumNumberOfLines = 0
        label.textColor = .secondaryLabelColor
        label.font = .systemFont(ofSize: 12)
        addSubview(label)
        unavailableLabel = label
        needsLayout = true
    }
}
