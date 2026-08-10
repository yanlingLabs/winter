import AppKit
import SwiftUI

/// panel-cef Task 6a: the `.web` implementation of Plan A's `PanelTabContent` boundary
/// (`PanelTab.swift`) — a real Chromium page, hosted in an `NSView`, behind the same protocol the
/// frame was written against. The frame does not change: `ShellPanel` renders `makeContent()` in
/// the slot that used to hold `Color.clear`.
///
/// panel-cef Task 6b fills the chrome slot (`PanelWebChrome` — back/forward/reload, the
/// centre-aligned URL field, the `⋮` overflow) and applies **enforcement point 3 of the URL scheme
/// policy** below.
struct PanelWebTab: PanelTabContent {
    let tab: PanelTab
    /// Shared by both slots — the thing that makes the URL field and the browser it describes the
    /// same tab. Looked up once, in `panelTabContent(for:host:)`.
    let model: PanelWebTabModel

    var kind: PanelTabKind { .web }
    var title: String { panelTabDisplayTitle(tab) }
    var icon: Image { Image(systemName: panelTabFaviconSystemImage(.web)) }

    func makeChrome() -> AnyView { AnyView(PanelWebChrome(model: model)) }

    /// **Enforcement point 3 — restore.** `PanelURLPolicy.restorableURL` stands between whatever is
    /// stored on the tab and a real Chromium browser, and it is the last mile of the whole policy:
    /// every other door can be bypassed by data that predates it or arrives from a producer that
    /// does not exist yet, but this one is on the path of *every* load. A stored `javascript:` URL
    /// would otherwise be re-executed against the page on each restore, for as long as the session
    /// exists — which is forever, since sessions are user-delete-only.
    func makeContent() -> AnyView {
        AnyView(PanelCEFView(tab: tab, model: model, url: PanelURLPolicy.restorableURL(tab.url)))
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
///
/// panel-cef Task 6b threads the host and its session through, for one reason each: the host is how
/// a committed navigation reaches `panel.reportNavigation`, and the session id is CAPTURED here
/// (rather than read at the moment a page finishes loading) so a session hop mid-load cannot file
/// one session's browsing into another's log. Both are optional — a shell built without a host
/// renders exactly as before, with a chrome row whose verbs work and whose reports go nowhere.
@MainActor
func panelTabContent(for tab: PanelTab, host: ShellSessionHost? = nil,
                     sessionId: String? = nil) -> PanelTabContent {
    switch tab.kind {
    case .web:
        return PanelWebTab(tab: tab,
                           model: PanelWebTabModels.model(for: tab, host: host, sessionId: sessionId))
    case .document, .code, .note:
        return PanelPlaceholderTab(tab: tab)
    }
}

/// PURE: which tab the panel renders. The active one — or, when nothing is active, the FIRST tab.
///
/// **The wire decision this fallback was born from has since been MADE, in the daemon.** Task 6a
/// found that `panel.openTab` appended `panel_tab_opened` and nothing else, while both folds (TS
/// `foldPanelTabs` and its Swift mirror in `PanelTab.swift`) set `activeTabId` ONLY from
/// `panel_tab_activated` — so a freshly opened tab was open but never active, and resolving that at
/// the rendering boundary was all Task 6a could do. Task 6b fixed it at the one place tabs are
/// minted: `panel.openTab` now appends `panel_tab_activated` too
/// (`packages/core/src/ipc/server.ts`, "THE WIRE DECISION Plan A left open"), so an agent-opened
/// tab and a user-opened tab are indistinguishable downstream. The cost Task 6a carried — the strip
/// highlighting `activeTabId` while this rendered something else — went with it, and `ShellPanel`
/// now passes `shownTabId` so the highlight follows THIS function rather than `activeTabId`.
///
/// The fallback is still needed, for the two cases the daemon-side comment names: sessions written
/// BEFORE that change (their logs carry `panel_tab_opened` alone, forever — sessions are
/// user-delete-only), and the beat after the active tab is closed, where `foldPanelTabs` clears
/// `activeTabId` by design.
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
    let tab: PanelTab
    let model: PanelWebTabModel
    let url: String

    func makeNSView(context: Context) -> PanelCEFContainerView {
        let container = PanelCEFContainerView()
        model.container = container

        // panel-cef Task 6b: both channels are registered BEFORE the browser exists — that is why
        // the bridge keys them on the container view rather than on a browser id. Creation is
        // asynchronous and can queue behind `OnContextInitialized`, so there is no later moment
        // that is guaranteed to come.
        NormaCEFSetStateObserver(container) { [weak model] state in
            guard let state else { return }
            model?.apply(state)
        }
        NormaCEFSetNavigationObserver(container) { [weak model] committedURL, committedTitle in
            model?.reportCommittedNavigation(url: committedURL ?? "", title: committedTitle ?? "")
        }
        // Prime the dedupe memory AND the displayed address with what the daemon already knows, so
        // a tab switched away from and back to neither re-reports its own stored URL nor flashes an
        // empty field. Seeded with the URL actually being loaded — if scheme policy refused the
        // stored one, this is empty rather than the refused value.
        NormaCEFSeedTabState(container,
                             PanelURLPolicy.isAllowed(url) ? url : "",
                             tab.title ?? "")

        startBrowser(in: container)
        return container
    }

    /// Bring CEF up if needed and create the browser. Split out of `makeNSView` because the
    /// unavailable placeholder's **Try again** button runs this exact path again — the retry has to
    /// re-do the whole sequence, not merely clear a flag, since the async block below has long since
    /// run by the time a user reads the message and clicks.
    private func startBrowser(in container: PanelCEFContainerView) {
        // NOT synchronous. `makeNSView` runs inside a SwiftUI view update, and `CefInitialize`
        // stands up a process tree, runs `OnContextInitialized` re-entrantly and starts a run-loop
        // timer. Hopping one turn keeps all of that out of the update pass, and it is also what
        // guarantees the run loop is genuinely spinning when CEF comes up (see `NormaCEFRuntime`'s
        // note on Task 1's starvation hypothesis).
        DispatchQueue.main.async {
            guard NormaCEFRuntime.ensureInitialized() else {
                if case .failed(let reason) = NormaCEFRuntime.state {
                    // `[weak container]`: this closure is STORED ON the container as
                    // `retryAction`, so a strong capture is a cycle — container → closure →
                    // container. `didTapRetry` nils it, so it is broken the moment the button is
                    // pressed, but a user who reads "unavailable" and never clicks would leak that
                    // container and its whole view tree for the life of the process.
                    container.showUnavailable(reason, retry: NormaCEFRuntime.isRetryable ? { [weak container] in
                        guard let container else { return }
                        NormaCEFRuntime.clearFailure()
                        startBrowser(in: container)
                    } : nil)
                }
                return
            }
            NormaCEFCreateBrowser(container, url)
        }
    }

    /// **Deliberately empty, and it must stay that way.** SwiftUI calls this whenever a stored
    /// property changes — including `url`, which changes the moment a committed navigation is
    /// reported, folded by the daemon and replayed back into `PanelStore`. Loading `url` here would
    /// therefore close a loop: navigate → report → fold → `updateNSView` → navigate to where the
    /// browser already is. Navigation is driven by the user through `PanelWebTabModel`'s verbs, and
    /// by nothing else. (The `.id(tabId)` in `ShellPanel` means a genuinely different tab arrives as
    /// a rebuild, not as an update, so there is no case this method needs to handle.)
    func updateNSView(_ nsView: PanelCEFContainerView, context: Context) {}

    /// Closing here — rather than leaking the browser and letting the container's `deinit` decide —
    /// is what keeps a closed or switched-away tab from leaving a live renderer process behind.
    ///
    /// Task 6b: the observers are cleared FIRST. Both blocks capture the model weakly, so a late
    /// callback would be harmless — but a `panel_tab_navigated` filed by a tab the user has already
    /// closed is not harmless, it is a permanent line in a log describing something that is no
    /// longer on screen.
    static func dismantleNSView(_ nsView: PanelCEFContainerView, coordinator: ()) {
        NormaCEFSetStateObserver(nsView, nil)
        NormaCEFSetNavigationObserver(nsView, nil)
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
    private var retryButton: NSButton?
    private var retryAction: (() -> Void)?

    /// Every subview that is NOT part of the unavailable placeholder — i.e. CEF's own view.
    private var isPlaceholder: (NSView) -> Bool {
        { [weak self] view in view === self?.unavailableLabel || view === self?.retryButton }
    }

    override func resizeSubviews(withOldSize oldSize: NSSize) {
        super.resizeSubviews(withOldSize: oldSize)
        let placeholder = isPlaceholder
        for subview in subviews where !placeholder(subview) {
            subview.frame = bounds
        }
    }

    override func layout() {
        super.layout()
        guard let label = unavailableLabel else { return }
        let button = retryButton
        let buttonHeight: CGFloat = button == nil ? 0 : 24
        let box = bounds.insetBy(dx: 16, dy: 16)
        label.frame = NSRect(x: box.minX, y: box.midY, width: box.width,
                             height: max(0, box.height / 2))
        button?.frame = NSRect(x: box.midX - 50, y: box.midY - buttonHeight - 8,
                               width: 100, height: buttonHeight)
    }

    /// CEF could not start. The panel says so instead of showing a permanently blank rectangle —
    /// and Norma keeps running, which is the whole reason none of the bridge's entry points abort.
    ///
    /// **Task 6b adds the retry door, and it is not cosmetic.** `NormaCEFRuntime.ensureInitialized`
    /// returns early on `.failed` and nothing ever reset that state, so ONE transient startup
    /// failure disabled the browser panel for the rest of the process's life — and the failures
    /// that actually happen are transient by nature: Chromium's profile lock (exit code 24) when a
    /// second copy of the app holds the same `root_cache_path`, and a stale `SingletonLock` left by
    /// a `kill -9`. Both are fixed by quitting the other copy and trying again, which until now
    /// meant relaunching Norma. `retry` is `nil` for failures that genuinely cannot be retried
    /// (`CefShutdown` has run; the helper bundle is missing from the build), so the button is not
    /// offered where it would only fail again.
    func showUnavailable(_ reason: String, retry: (() -> Void)? = nil) {
        guard unavailableLabel == nil else { return }
        let label = NSTextField(labelWithString: "The browser panel is unavailable.\n\(reason)")
        label.alignment = .center
        label.maximumNumberOfLines = 0
        label.textColor = .secondaryLabelColor
        label.font = .systemFont(ofSize: 12)
        addSubview(label)
        unavailableLabel = label

        if let retry {
            retryAction = retry
            let button = NSButton(title: "Try Again", target: self, action: #selector(didTapRetry))
            button.bezelStyle = .rounded
            button.controlSize = .small
            addSubview(button)
            retryButton = button
        }
        needsLayout = true
    }

    @objc private func didTapRetry() {
        let action = retryAction
        // Tear the placeholder down first: a retry that succeeds must leave a browser behind, not a
        // browser with "unavailable" still written across it, and a retry that fails calls
        // `showUnavailable` again — which no-ops unless the previous label is gone.
        unavailableLabel?.removeFromSuperview()
        retryButton?.removeFromSuperview()
        unavailableLabel = nil
        retryButton = nil
        retryAction = nil
        action?()
    }
}
