import AppKit
import SwiftUI

/// panel-cef Task 6a: the `.web` implementation of Plan A's `PanelTabContent` boundary
/// (`PanelTab.swift`) — a real Chromium page, hosted in an `NSView`, behind the same protocol the
/// frame was written against. The frame does not change: `ShellPanel` renders `makeContent()` in
/// the slot that used to hold `Color.clear`.
///
/// panel-cef Task 6b fills the chrome slot (`PanelWebChrome` — back/forward/reload, the
/// centre-aligned URL field, the `⋮` overflow).
///
/// browser-runtime T4: the content slot is now a **viewport** onto a browser this type does not
/// own (`PanelViewport` below).
struct PanelWebTab: PanelTabContent {
    let tab: PanelTab
    /// Shared by both slots — the thing that makes the URL field and the browser it describes the
    /// same tab. Looked up once, in `panelTabContent(for:host:sessionId:)`.
    let model: PanelWebTabModel
    /// The runtime the viewport borrows its container from. Resolved in
    /// `panelTabContent(for:host:sessionId:)` (which is `@MainActor`, and `BrowserRuntime` is) and
    /// carried rather than read as `.shared` further down, so a test can drive a viewport against
    /// its own runtime — `BrowserRuntime.shared` owns containers, timers and a window, all of which
    /// would leak from one test into the next.
    let runtime: BrowserRuntime

    var kind: PanelTabKind { .web }
    var title: String { panelTabDisplayTitle(tab) }
    var icon: Image { Image(systemName: panelTabFaviconSystemImage(.web)) }

    func makeChrome() -> AnyView { AnyView(PanelWebChrome(model: model)) }

    /// The tab's viewport. It carries the tab through **unfiltered** and loads nothing itself:
    /// **enforcement point 3 — restore — moved to `BrowserRuntime.create`** (browser-runtime T3),
    /// which is the one path every browser is born on whether the panel is showing it or not.
    /// `PanelURLPolicy.restorableURL` is still the last mile of the whole policy — a stored
    /// `javascript:` URL would otherwise be re-executed against the page on every restore, for as
    /// long as the session exists, which is forever — but running it here as well would put the
    /// policy in two places while leaving the runtime's own path (spec §5's headless browsers, and
    /// every one of B2's) depending on a view that never runs for them.
    /// `BrowserRuntimeTests.testTheRestoreDoorRefusesEveryDisallowedSchemeAndSeedsNothingForOne`
    /// pins the door itself; `BrowserSignalsTests
    /// .testAStoredHostileURLNeverReachesCEFThroughTheFoldThatRestoresIt` pins that the path a
    /// stored URL actually travels — a daemon fold, through the engine, into a create — reaches it.
    /// (T4's viewport-path pin retired with the bridge Task 5 deleted: this view creates nothing.)
    func makeContent() -> AnyView {
        AnyView(PanelViewport(tab: tab, runtime: runtime))
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
        // `BrowserRuntime.shared` is read HERE, in the one main-actor function on this path, and
        // carried down as a value — see `PanelWebTab.runtime`. Nothing on this line creates or
        // touches a browser: building a `PanelWebTab` is free, and a test that only asks what a tab
        // renders as never reaches the runtime at all.
        return PanelWebTab(tab: tab,
                           model: PanelWebTabModels.model(for: tab, host: host, sessionId: sessionId),
                           runtime: .shared)
    case .note:
        return PanelPlaceholderTab(tab: tab)
    // office-plumbing Task 6: the fifth kind with a real surface — Stage A's placeholder arm,
    // replaced (the same handoff `.code`'s/`.diff`'s/`.files`' own TEMPORARY arms took before their
    // own tasks). The model is looked up (not built) here for the same reason every other kind's
    // is: this function runs on every render pass, and a model born here would be reborn here — for
    // a document tab that would mean losing `hasRequestedOpen`'s own bookkeeping (and the canvas's
    // registered `canvasHost`) on every visit. Nothing on this line touches the office helper:
    // `bind` records the host/session and hops off the current pass; the first open happens once
    // the runtime resolves.
    case .document:
        return PanelDocumentTab(tab: tab,
                                model: PanelDocumentTabModels.model(for: tab, host: host, sessionId: sessionId))
    // editor-product Task 5: the third kind with a real surface — Stage A's placeholder arm,
    // replaced. The model is looked up (not built) here for the reason `.web`'s and `.diff`'s are:
    // this function runs on every render pass, and a model born here would be reborn here — for a
    // code tab that would mean re-reading the file from disk on every visit. Nothing on this line
    // touches CEF: `bind` records the host/session and hops off the current pass, and even the
    // runtime it eventually resolves is only a browser once something opens a file in it.
    case .code:
        return PanelEditorTab(tab: tab,
                              model: PanelEditorTabModels.model(for: tab, host: host,
                                                                sessionId: sessionId))
    // diff-tabs Task 10: the second kind with a real surface — Task 9's TEMPORARY placeholder arm,
    // replaced. The model is looked up (not built) here for the same reason `.web`'s is: this
    // function runs on every render pass, and a model born here would be reborn here, re-fetching
    // the frozen patch on every tab switch. `PanelDiffTabModels` keys by tabId and the fetch closure
    // it builds holds the host WEAKLY — nothing on this line touches the daemon; the first
    // `onAppear` is what starts the one request.
    case .diff:
        return PanelDiffTab(tab: tab,
                            model: PanelDiffTabModels.model(for: tab, host: host, sessionId: sessionId))
    // editor-product Task 7: the fourth kind with a real surface — Task 2's TEMPORARY placeholder
    // arm, replaced (the same handoff `.diff`'s and `.code`'s own TEMPORARY arms used before Tasks
    // 10 and 5 replaced them). The model is looked up (not built) here for the same reason every
    // other kind's is: this function runs on every render pass, and a model born here would be
    // reborn here — for a Files tab that would mean losing every watcher and every expand state on
    // every visit. Nothing on this line touches disk: `bind` records the host/session and hops off
    // the current pass; the first read happens once the session's roots resolve.
    case .files:
        return PanelFilesTab(tab: tab,
                             model: PanelFilesTabModels.model(for: tab, host: host, sessionId: sessionId))
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

// MARK: - The viewport onto a runtime-owned container

/// browser-runtime T4: the SwiftUI seam — **a viewport, not an owner** (spec §2's ownership
/// inversion, on the view side).
///
/// **Before:** this representable created a browser in `makeNSView` and closed it in
/// `dismantleNSView`, so a browser's existence was welded to a mounted view: a tab switch was a
/// create/destroy churn and the page's scroll position, video, form text and JS heap died with it.
/// Everything that used to happen here — the three observer channels, the seed, the deferred
/// `NormaCEFCreateBrowser` and its unavailable/retry placeholder — is `BrowserRuntime`'s create
/// path now (`BrowserRuntime.swift`, absorbed bit-for-bit in T3), and this file no longer calls
/// into `NormaCEF*` at all.
///
/// **After:** this view does exactly two things — hand the runtime a host `NSView` to mount the
/// tab's container into while the tab is on screen, and give it back when it is not. Neither is a
/// create or a destroy; both are `addSubview` moves. `CefWindowHandle` IS an `NSView*` on macOS,
/// which is what makes that possible at all: Chromium's own view is a subview of the container, so
/// moving the container moves the page, live.
struct PanelViewport: NSViewRepresentable {
    let tab: PanelTab
    /// Carried from `panelTabContent`, never read as `.shared` here — see `PanelWebTab.runtime`.
    let runtime: BrowserRuntime

    func makeNSView(context: Context) -> PanelViewportHostView {
        let hostView = PanelViewportHostView(tab: tab, runtime: runtime)
        hostView.attachToRuntime()
        return hostView
    }

    /// **Deliberately empty, and it must stay that way.** SwiftUI calls this whenever a stored
    /// property changes — including `tab.url`, which changes the moment a committed navigation is
    /// reported, folded by the daemon and replayed back into `PanelStore`. Loading it here would
    /// therefore close a loop: navigate → report → fold → `updateNSView` → navigate to where the
    /// browser already is. Navigation is driven by the user through `PanelWebTabModel`'s verbs, and
    /// by nothing else. (The `.id(tabId)` in `ShellPanel` means a genuinely different tab arrives as
    /// a rebuild, not as an update, so there is no case this method needs to handle.)
    ///
    /// T4 adds a second, blunter reason: there is nothing here to load INTO. This view holds no
    /// browser and no container — only the rectangle the runtime mounts one in.
    func updateNSView(_ nsView: PanelViewportHostView, context: Context) {}

    /// **Detach, and nothing else — stopping a browser is not this view's business any more.**
    ///
    /// What stood here closed the browser, justified as "keeps a closed or switched-away tab from
    /// leaving a live renderer process behind". That justification described the ownership this task
    /// deleted: a switched-away tab is now SUPPOSED to leave a live renderer behind — that is the
    /// whole point of the inversion, and it is what makes a tab switch a container swap instead of a
    /// page reload. `detachViewport` parks the container in the runtime's own window; the browser
    /// keeps running there, unwatched and unchanged.
    ///
    /// **Where stopping lives now:** `BrowserRuntime.stop`, executed from a `.stop` action that
    /// `BrowserLifecycleEngine.plan` decided (`BrowserLifecycle.swift`) on the session-lifecycle
    /// rules of spec §4, from the signals `BrowserSignalsCoordinator` assembles
    /// (`BrowserSignals.swift`). This file cannot make that decision: it does not
    /// know whether the tab is still open, whether its session is working, or whether the user is
    /// switching away for a second or for the rest of the day.
    static func dismantleNSView(_ nsView: PanelViewportHostView, coordinator: ()) {
        nsView.detachFromRuntime()
    }
}

/// The rectangle the runtime mounts a container into — **a hole in the SwiftUI view tree, not a
/// browser**. It owns no CEF state and holds no container of its own; `BrowserRuntime` puts one in
/// and takes it back out. Its whole job is to be the right size in the right place, and to say when
/// it has joined a window.
final class PanelViewportHostView: NSView {
    let tab: PanelTab
    let runtime: BrowserRuntime

    /// Set by `detachFromRuntime`. SwiftUI is finished with a dismantled host view, so it is no
    /// longer the viewport holder — and a re-attach from a late window join would take the container
    /// away from whatever view holds it now and mount it in a rectangle nothing is showing.
    private var isDismantled = false

    init(tab: PanelTab, runtime: BrowserRuntime) {
        self.tab = tab
        self.runtime = runtime
        super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("PanelViewportHostView is never unarchived") }

    /// **The third responder door** (T3 review Minor-1).
    ///
    /// A reparent destroys first-responder status and `attachViewport` restores it (spike Fact 2) —
    /// but it can only do that in a window, and SwiftUI runs `makeNSView` BEFORE the view it returns
    /// joins one. That first attach therefore reaches `restoreFirstResponder`'s "container is in no
    /// window yet" exit and logs instead of restoring. Two doors already cover their own paths — a
    /// later plan's `.attachViewport`, and `startBrowser`'s post-create restore — and neither fires
    /// for the ordinary case of a panel simply opening on a browser that is already live. This is
    /// the third: the moment this view joins a window, ask for the same attach again. Without it the
    /// panel shows the page and accepts no keystrokes, and the only trace is one line in the log.
    ///
    /// It is also what re-restores the keyboard when the shell's panel moves between windows.
    ///
    /// **The repeat is a no-op except for the responder, and that was measured rather than assumed**
    /// (AppKit, macOS 26): `addSubview:` of a view that is ALREADY a subview of the same superview
    /// sends no `viewWillMove(toSuperview:)` and no `viewWillMove(toWindow:)` at all — the container
    /// is not unparented and re-parented, so the "in a window at all times" invariant spike Fact 5
    /// rests on is never broken by asking twice. `makeFirstResponder` on a view that is already the
    /// first responder likewise returns `true` without sending `resignFirstResponder` /
    /// `becomeFirstResponder`. What the second attach costs is a dictionary lookup, a frame
    /// assignment and an LRU touch.
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        // Leaving a window is not joining one: `nil` here is the teardown side, and the runtime has
        // either already been told (`detachFromRuntime`) or is about to be.
        guard window != nil else { return }
        attachToRuntime()
    }

    /// Mount this tab's container here. Called twice for an ordinary tab open — once from
    /// `makeNSView`, once when this view joins a window — and again whenever the panel moves
    /// between windows.
    /// **Attaches, and only attaches.** Task 5 deleted the temporary bridge that used to sit here —
    /// the one place in the view layer that asked for a browser to EXIST — so spec §2's "creation
    /// driven only by the engine" is now literally true: `BrowserRuntime.create` has exactly one
    /// caller, `apply`'s `.create` case, and `BrowserLifecycleEngine.plan` is the only thing that
    /// emits one. If the tab this view is showing has no live browser, this mounts nothing and says
    /// so in the log; the fold that put the tab on screen is what re-plans and creates it.
    func attachToRuntime() {
        guard !isDismantled else { return }
        runtime.attachViewport(tabId: tab.tabId, into: self)
    }

    /// SwiftUI is done with this view: give the container back to the runtime, which parks it in its
    /// own window. The browser is untouched — see `PanelViewport.dismantleNSView`.
    func detachFromRuntime() {
        isDismantled = true
        runtime.detachViewport(tabId: tab.tabId)
    }
}

/// The container CEF parents its view into. **Owned by `BrowserRuntime`** since browser-runtime T4
/// — created there, parked there, released there — and merely borrowed by the viewport above.
///
/// It owns exactly one behaviour beyond being an `NSView`: keeping Chromium's subview at its own
/// bounds. CEF does not set an autoresizing mask on the view it adds, and nothing in SwiftUI fires
/// per live-resize step, so the resize is handled here where AppKit actually reports it — and it is
/// what carries an attach's `frame = host.bounds` through to the page (spike Fact 4).
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
        label.font = Typography.panelTabLabelNS
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
