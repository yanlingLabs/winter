import AppKit
import Foundation

/// browser-runtime T3: the OWNER and the EXECUTOR — spec §2's ownership inversion, made real.
///
/// **Before:** SwiftUI's view lifecycle owned browsers. `PanelWebTab.makeNSView` created one and
/// `dismantleNSView` destroyed it, so a tab switch was a create/destroy churn and a browser's
/// existence was welded to a mounted view. **After:** this object owns every browser and every
/// container `NSView` for the life of the app, and the panel's web tab becomes a *viewport* that
/// merely borrows a container while it is on screen.
///
/// **This file DECIDES NOTHING.** Whether a browser should exist is `BrowserLifecycleEngine.plan`'s
/// question and only its question (`BrowserLifecycle.swift`); `apply` executes the returned actions
/// in the order given, naively — no reordering, no deduping, no inference. The engine's own header
/// states the two orderings that are hard contracts (detach before every stop; create before
/// attach) precisely so a naive executor is sufficient, and staying naive is what keeps that true.
/// There is exactly ONE documented departure, and it is an obligation the engine imposes rather
/// than a decision this file takes: `scheduleStop`'s "keep or re-arm the timer until you actually
/// see `cancelScheduledStop`" (see `lingerFired`).
///
/// What it owns:
///   * `tabId → PanelCEFContainerView`, strongly — the registry that outlives every view update;
///   * the **parking window** (spec §3): one borderless `NSWindow`, created lazily and *never*
///     ordered in, whose content view holds every container that is not in the panel. Task 1
///     measured all three plausible park shapes as indistinguishable and told this task to take the
///     simplest (`docs/research/2026-08-10-cef-reparent-spike.md`, Fact 9);
///   * the per-tab `PanelWebTabModel` wiring absorbed from `makeNSView`;
///   * the linger timers the engine arms.
@MainActor
final class BrowserRuntime {

    // MARK: - The injected seams

    /// **Every CEF call this file makes.** Spec §9's constraint is absolute — "no CEF client
    /// override is callable under XCTest, ever" — so the runtime's logic has to be reachable without
    /// CEF, and the only way to get there is a seam the tests can substitute.
    ///
    /// `production` below is the whole of the un-substitutable half: ten one-line forwards to
    /// `NormaCEF*` / `NormaCEFRuntime`, with no branch and no state, which is what "thin enough to
    /// verify by reading" has to mean when reading is the only verification available.
    struct CEFDriver {
        var setStateObserver: (PanelCEFContainerView, ((NormaCEFBrowserState?) -> Void)?) -> Void
        var setNavigationObserver: (PanelCEFContainerView, ((String?, String?) -> Void)?) -> Void
        var setPopupObserver: (PanelCEFContainerView, ((String?) -> Void)?) -> Void
        var seedTabState: (PanelCEFContainerView, String, String) -> Void
        var createBrowser: (PanelCEFContainerView, String) -> Void
        var closeBrowser: (PanelCEFContainerView) -> Void

        /// `NormaCEFRuntime`'s four doors: the lazy start, the reason the placeholder shows, whether
        /// a retry can succeed, and the reset that makes one possible. Injected for the same reason
        /// as the rest and one sharper one — `ensureInitialized` refuses outright under XCTest (the
        /// structural guard that keeps Chromium out of the suite), so a runtime calling it directly
        /// could never have its create path tested at all.
        ///
        /// The four are `@MainActor` because `NormaCEFRuntime` is: annotating the closure TYPE is
        /// what lets `production` below be a plain `static let` (a static initializer is a
        /// nonisolated context and cannot call main-actor code otherwise).
        var ensureInitialized: @MainActor () -> Bool
        var failureReason: @MainActor () -> String?
        var isRetryable: @MainActor () -> Bool
        var clearFailure: @MainActor () -> Void

        static let production = CEFDriver(
            setStateObserver: { NormaCEFSetStateObserver($0, $1) },
            setNavigationObserver: { NormaCEFSetNavigationObserver($0, $1) },
            setPopupObserver: { NormaCEFSetPopupObserver($0, $1) },
            seedTabState: { NormaCEFSeedTabState($0, $1, $2) },
            createBrowser: { NormaCEFCreateBrowser($0, $1) },
            closeBrowser: { NormaCEFCloseBrowser($0) },
            ensureInitialized: { NormaCEFRuntime.ensureInitialized() },
            failureReason: {
                if case .failed(let reason) = NormaCEFRuntime.state { return reason }
                return nil
            },
            isRetryable: { NormaCEFRuntime.isRetryable },
            clearFailure: { NormaCEFRuntime.clearFailure() })
    }

    /// The clock and the two ways this file defers work. Separate from `CEFDriver` because none of
    /// it is CEF: naming it `CEFDriver` would be a false label on the one seam whose honesty the
    /// whole testing posture rests on.
    struct Scheduler {
        struct Cancellable {
            let cancel: () -> Void
        }

        /// The executor's clock. Read in exactly one place — the early-fire comparison in
        /// `lingerFired`. Every deadline it compares against comes from the ENGINE, which took its
        /// own reading; this never invents one.
        var now: () -> Date
        /// Run on the main queue, on a later turn.
        var mainAsync: (@escaping @MainActor @Sendable () -> Void) -> Void
        /// A one-shot timer at an absolute date, and its canceller.
        var timer: (Date, @escaping @MainActor @Sendable () -> Void) -> Cancellable

        static let production = Scheduler(
            now: Date.init,
            mainAsync: { work in
                // `assumeIsolated` rather than a `Task`: the block is being run ON the main queue,
                // so the assumption is a statement of fact, and it keeps the hop to exactly one
                // turn — which is what `PanelWebTab.makeNSView` measured its behaviour against.
                DispatchQueue.main.async { MainActor.assumeIsolated { work() } }
            },
            timer: { fireAt, work in
                let timer = Timer(fire: fireAt, interval: 0, repeats: false) { _ in
                    MainActor.assumeIsolated { work() }
                }
                // **Common modes, not the default one.** `Timer.scheduledTimer` registers in the
                // default mode alone, and `NormaCEF.mm`'s pump measured that costing 0 callbacks
                // across a 5-second event-tracking window. A linger that cannot fire while a menu is
                // open or a window is being dragged is a stop the user can indefinitely postpone by
                // holding the mouse down.
                RunLoop.main.add(timer, forMode: .common)
                return Cancellable { timer.invalidate() }
            })
    }

    // MARK: - The first-responder search (spike Fact 2)

    /// Which descendant of a container can actually take a keystroke, and how sure we are.
    ///
    /// This is a search rather than a path because **Chromium's view tree is not Norma's to
    /// promise**. The spike dumped one spine, three deep, with exactly one candidate at the bottom —
    /// and explicitly refused to let this task key on that: "find it by identity, not by depth".
    struct ResponderSearch: Equatable {
        enum MatchKind: String, Equatable {
            /// The exact Objective-C class name Chromium gives the view — the primary rule.
            case className
            /// `NSTextInputClient` conformance — the durable rule, and the fallback if the class is
            /// ever renamed. That conformance is *what makes a view able to take a keystroke*.
            case textInputClient
            case none
        }
        var view: NSView?
        var matchedBy: MatchKind
        var count: Int
    }

    /// Chromium's own class, named as a string because it is internal to CEF's framework and cannot
    /// be referenced from Swift at all.
    static let renderWidgetHostViewClassName = "RenderWidgetHostViewCocoa"

    /// **Spike Fact 2's search.** Pre-order walk; class-name matches win outright when there are
    /// any; `NSTextInputClient` conformance is the fallback. Deliberately does NOT filter on
    /// `acceptsFirstResponder` — the spike's harness used "the last `acceptsFirstResponder` view in
    /// a pre-order walk" and then retired that heuristic in its own findings, because it happens to
    /// equal the right view only in the single tree that was measured.
    ///
    /// The count is returned rather than swallowed so `attachViewport` can log it: zero means nobody
    /// in the panel can type, more than one means the choice is a guess. Both are conditions the
    /// spike says to report loudly, and neither is a reason to refuse to attach.
    static func findKeyboardResponder(in container: NSView) -> ResponderSearch {
        var walked: [NSView] = []
        func walk(_ view: NSView) {
            for subview in view.subviews {
                walked.append(subview)
                walk(subview)
            }
        }
        walk(container)

        let byName = walked.filter { NSStringFromClass(type(of: $0)) == renderWidgetHostViewClassName }
        if !byName.isEmpty {
            // `.last` is the tiebreak, not the rule: for an unambiguous tree it is the only match,
            // and for an ambiguous one it is the deepest — which is where the measured tree put it.
            return ResponderSearch(view: byName.last, matchedBy: .className, count: byName.count)
        }
        let byConformance = walked.filter { $0 is NSTextInputClient }
        if !byConformance.isEmpty {
            return ResponderSearch(view: byConformance.last, matchedBy: .textInputClient,
                                   count: byConformance.count)
        }
        return ResponderSearch(view: nil, matchedBy: .none, count: 0)
    }

    // MARK: - Construction and state

    /// The app's one runtime. Tests construct their own instead — this holds containers, timers and
    /// a window, all of which would leak from test to test.
    static let shared = BrowserRuntime()

    /// **Executor mechanics, not policy.** After a deadline has genuinely passed the executor asks
    /// for a re-plan and then must keep the deadline armed until it sees `cancelScheduledStop` (the
    /// engine's own instruction). This is how often it re-asks in the meantime. It never moves the
    /// DEADLINE — the engine still decides the stop by comparing its own `now` against the deadline
    /// the engine itself set; this only decides how often the question gets put.
    static let lingerRecheckInterval: TimeInterval = 30

    private let driver: CEFDriver
    private let scheduler: Scheduler

    private var containers: [String: PanelCEFContainerView] = [:]
    private var lingers: [String: Linger] = [:]

    /// Least-recently-used FIRST — the order `plan`'s cap consumes. A tab is "used" when it is
    /// created and when it takes the viewport; a stopped tab drops out. Mirrors the `Sim` in
    /// `BrowserLifecycleTests`, which is the shape the engine's cap rows were written against.
    private var lru: [String] = []

    /// The tab whose container is mounted in the panel right now, or `nil`. Fed straight back to
    /// `plan(viewport:)`, so it must mean *mounted*, never *intended*.
    private(set) var viewportTabId: String?

    /// Where the panel puts its browser. Registered by `attachViewport(tabId:into:)` (Task 4's call)
    /// and remembered so that a `.attachViewport` ACTION — which carries no view — has somewhere to
    /// mount. Weak: the panel's host view belongs to SwiftUI.
    private weak var viewportHost: NSView?

    /// The shell, for the two model channels that reach the daemon (`reportPanelNavigation` and
    /// `openPanelTab`).
    ///
    /// **Set by Task 5, and it matters for more than tidiness.** A parked, agent-driven browser
    /// (spec §5) is never rendered, so nothing else will ever bind a host to its model — and a model
    /// with no host silently records no navigations at all. `wire` logs when this is nil.
    weak var host: ShellSessionHost?

    /// "A linger deadline has arrived; re-plan." Set by Task 5. The executor deliberately cannot
    /// stop anything itself here — the stop is the engine's decision, taken on a later plan against
    /// freshly read signals.
    var onLingerDeadline: ((String) -> Void)?

    init(driver: CEFDriver = .production, scheduler: Scheduler = .production) {
        self.driver = driver
        self.scheduler = scheduler
    }

    // MARK: - What Task 5 feeds back into `plan`

    var liveTabIds: Set<String> { Set(containers.keys) }
    var lruOrder: [String] { lru }
    var pendingStopDeadlines: [String: Date] { lingers.mapValues(\.deadline) }

    /// B2's whole view of this object (spec §5: the runtime's API surface is view-free). A browser
    /// is live whether or not anything is mounted anywhere — "headless" is not a mode, it is a
    /// parked container.
    func isLive(tabId: String) -> Bool { containers[tabId] != nil }

    /// The container a tab's browser lives in. `PanelWebTabModel` already holds the same reference
    /// weakly for its verbs; this is the owner's copy, and Task 4's viewport reads it through
    /// `attachViewport` rather than directly.
    func container(forTabId tabId: String) -> PanelCEFContainerView? { containers[tabId] }

    // MARK: - The parking window (spec §3)

    private var parkingWindowStorage: NSWindow?

    /// `true` once anything has needed parking. Exists so the laziness is assertable: a Norma that
    /// never opens a web tab must not build a window for it.
    var hasParkingWindow: Bool { parkingWindowStorage != nil }

    /// Borderless, `isReleasedWhenClosed = false`, and **never ordered in** — the spec's literal
    /// shape, which Task 1 measured as indistinguishable from ordered-out and offscreen on audio,
    /// rAF, timers, visibility and CPU (Fact 9), so the simplest wins.
    ///
    /// Its size is a plausible desktop viewport rather than anything derived: a parked page is a
    /// real page and lays itself out against whatever it is given, and every attach resizes it
    /// exactly (Fact 4 — set the frame after `addSubview` and the page follows).
    var parkingWindow: NSWindow {
        if let existing = parkingWindowStorage { return existing }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "Norma browser parking"
        parkingWindowStorage = window
        return window
    }

    // MARK: - The executor

    /// Apply one plan. **Verbatim, in order, with no cleverness** — see this file's header for why
    /// that is a requirement rather than a simplification.
    ///
    /// - Parameters:
    ///   - actions: exactly what `BrowserLifecycleEngine.plan` returned.
    ///   - tabs: the same per-session tab lists the plan was computed from. The only thing read out
    ///     of them is a created tab's **title**, for the seed — `.create` carries the url itself.
    ///   - sessionOf: the session a tab belongs to, bound onto its model at create time.
    func apply(_ actions: [BrowserAction], tabs: [String: [BrowserTabState]],
               sessionOf: (String) -> String?) {
        var titles: [String: String?] = [:]
        for state in tabs.values.joined() { titles[state.tabId] = state.title }

        for action in actions {
            switch action {
            case .create(let tabId, let url):
                create(tabId: tabId, url: url, title: titles[tabId] ?? nil, sessionId: sessionOf(tabId))
            case .stop(let tabId):
                stop(tabId: tabId)
            case .attachViewport(let tabId):
                guard let host = viewportHost else {
                    // The panel has no host view yet (it is not on screen, or Task 4's viewport has
                    // not appeared). Mount nothing and claim nothing: `viewportTabId` stays as it
                    // was, so the next plan still sees `viewport != desired` and re-emits this.
                    NSLog("[BrowserRuntime] attachViewport(\(tabId)) with no panel host — deferred")
                    continue
                }
                mountViewport(tabId: tabId, into: host)
            case .detachViewport(let tabId):
                detachViewport(tabId: tabId)
            case .scheduleStop(let sessionId, let deadline):
                scheduleStop(sessionId: sessionId, at: deadline)
            case .cancelScheduledStop(let sessionId):
                cancelScheduledStop(sessionId: sessionId)
            }
        }
    }

    // MARK: Create

    /// `create` = container into the parking window → wire the model → seed → `NormaCEFCreateBrowser`.
    ///
    /// The whole sequence is `PanelWebTab.makeNSView`'s, moved here unchanged, **including its
    /// order**: the state observer publishes the current snapshot the moment it is registered, and
    /// the seed is what makes that first snapshot the tab's known address instead of blank
    /// (`NormaCEF.h`). Observers, then seed, then create.
    private func create(tabId: String, url: String?, title: String?, sessionId: String?) {
        // **The double-create guard.** Rule 8 re-creates a held session's shown tab on every plan
        // where it is missing, so a create for a tab that already has one is ordinary traffic — and
        // a second `NormaCEFCreateBrowser` into the same container is a second live browser that
        // nothing will ever close, because the registry only remembers one container per tab.
        guard containers[tabId] == nil else { return }

        let container = PanelCEFContainerView()
        containers[tabId] = container
        park(container)
        touch(tabId)

        wire(container: container, tabId: tabId, url: url, title: title, sessionId: sessionId)

        // **Enforcement point 3 — restore.** `PanelURLPolicy.restorableURL` stands between whatever
        // the daemon stored and a real Chromium browser, and it is the last mile of the whole
        // policy: every other door can be bypassed by data that predates it or arrives from a
        // producer that does not exist yet, but this one is on the path of EVERY load. A stored
        // `javascript:` URL would otherwise be re-executed against the page on each restore, for as
        // long as the session exists — which is forever, since sessions are user-delete-only.
        let loadURL = PanelURLPolicy.restorableURL(url)
        // Seeded with the URL actually being loaded — if scheme policy refused the stored one, this
        // is empty rather than the refused value, so the address bar shows nothing rather than
        // something the panel will not load.
        driver.seedTabState(container, PanelURLPolicy.isAllowed(loadURL) ? loadURL : "", title ?? "")

        startBrowser(tabId: tabId, container: container, url: loadURL)
    }

    /// The three observer channels, bound to the tab's **shared** model — the same object
    /// `PanelWebChrome` reads, so the URL field and the browser it describes stay the same tab.
    ///
    /// `sessionId` is captured HERE, at create time, exactly as `panelTabContent(for:host:sessionId:)`
    /// does today: a user who hops sessions mid-page-load would otherwise have the report filed
    /// against whatever session was current when the load finished, cross-posting one session's
    /// browsing into another's permanent log.
    ///
    /// Every block captures the model weakly, because the block is stored on the CONTAINER, which
    /// the model does not own.
    private func wire(container: PanelCEFContainerView, tabId: String, url: String?,
                      title: String?, sessionId: String?) {
        if host == nil {
            // Not fatal, and not silent: with no host a parked browser's committed navigations are
            // dropped on the floor rather than recorded, and nothing else will bind one for a tab
            // that is never rendered. Task 5 sets `host` before the first `apply`.
            NSLog("[BrowserRuntime] wiring \(tabId) with no ShellSessionHost — its navigations and "
                  + "popups will go nowhere until one is set")
        }
        let model = PanelWebTabModels.model(for: PanelTab(tabId: tabId, kind: .web, url: url, title: title),
                                            host: host, sessionId: sessionId)
        model.container = container

        // All three are registered BEFORE the browser exists — that is why the bridge keys them on
        // the container view rather than on a browser id. Creation is asynchronous and can queue
        // behind `OnContextInitialized`, so there is no later moment that is guaranteed to come.
        driver.setStateObserver(container) { [weak model] state in
            guard let state else { return }
            model?.apply(state)
        }
        driver.setNavigationObserver(container) { [weak model] committedURL, committedTitle in
            model?.reportCommittedNavigation(url: committedURL ?? "", title: committedTitle ?? "")
        }
        // Three producers come down this one channel — `window.open`, ⌘/middle/shift-click, and the
        // context menu's "Open Link in New Tab" (`NormaCEFSetPopupObserver`). CEF cancels the popup
        // regardless; this is what turns the cancelled one into a real panel tab.
        driver.setPopupObserver(container) { [weak model] popupURL in
            model?.openPopupAsTab(url: popupURL ?? "")
        }
    }

    /// Bring CEF up if needed and create the browser. Split out because the unavailable
    /// placeholder's **Try again** button runs this exact path again — the retry has to re-do the
    /// whole sequence, not merely clear a flag, since the async block below has long since run by
    /// the time a user reads the message and clicks.
    private func startBrowser(tabId: String, container: PanelCEFContainerView, url: String) {
        // NOT synchronous. `CefInitialize` stands up a process tree, runs `OnContextInitialized`
        // re-entrantly and starts a run-loop timer; hopping one turn keeps all of that out of
        // whatever pass called `apply` (Task 5's caller may well be a SwiftUI update, which is the
        // case `makeNSView` had), and guarantees the run loop is genuinely spinning when CEF comes
        // up (see `NormaCEFRuntime`'s note on Task 1's starvation hypothesis).
        scheduler.mainAsync { [weak self] in
            guard let self else { return }
            // **The race `PanelWebTab` could not have.** There, nothing could interleave between
            // `makeNSView` and the hop — `dismantleNSView` cannot beat a same-turn async. Here a
            // LATER PLAN can: a `.stop` for this tab may have already run, releasing the container.
            // Creating a browser into it now would leave one live, observer-less, and closed by
            // nobody for the life of the process.
            guard self.containers[tabId] === container else { return }

            guard self.driver.ensureInitialized() else {
                guard let reason = self.driver.failureReason() else { return }
                // `[weak container]`: this closure is STORED ON the container as `retryAction`, so a
                // strong capture is a cycle — container → closure → container. `didTapRetry` nils
                // it, so it breaks the moment the button is pressed, but a user who reads
                // "unavailable" and never clicks would leak that container and its whole view tree.
                let retry: (() -> Void)? = self.driver.isRetryable() ? { [weak self, weak container] in
                    guard let self, let container, self.containers[tabId] === container else { return }
                    self.driver.clearFailure()
                    self.startBrowser(tabId: tabId, container: container, url: url)
                } : nil
                container.showUnavailable(reason, retry: retry)
                return
            }
            self.driver.createBrowser(container, url)
        }
    }

    // MARK: Stop

    /// `stop` = clear the observers → close the browser → release the container.
    ///
    /// **The order of the first two is load-bearing.** Every block captures its model weakly, so a
    /// late callback would be harmless in itself — but a `panel_tab_navigated` filed by a tab that
    /// is already gone is a permanent line in an append-only log describing something no longer on
    /// screen, and the popup channel is sharper still: a tab OPENED by a page whose own tab has been
    /// closed is a visible, permanent artefact. Closing first leaves exactly that window open.
    ///
    /// An unknown `tabId` is a no-op, deliberately: the §8 belt stops by id and the id it names may
    /// already be gone (a stop this runtime has applied from an earlier plan, two plans in flight).
    private func stop(tabId: String) {
        guard let container = containers.removeValue(forKey: tabId) else { return }

        driver.setStateObserver(container, nil)
        driver.setNavigationObserver(container, nil)
        driver.setPopupObserver(container, nil)
        driver.closeBrowser(container)

        // Only AFTER the close: CEF's own view is a subview of this container, and the spike's
        // invariant is that a CEF view stays in a window at all times. By here the browser is gone,
        // so what is being unparented is an empty container — and leaving it in a superview would
        // both retain it forever and, if it were still mounted, leave a dead rectangle where the
        // page was.
        container.removeFromSuperview()

        lru.removeAll { $0 == tabId }
        // The engine's contract: `viewport` "must name a live tab; the runtime clears it when it
        // stops that browser". A stale viewport would tell the next plan the panel is showing
        // something that no longer exists, and no attach would ever be emitted.
        if viewportTabId == tabId { viewportTabId = nil }

        // The MODEL deliberately survives: the tab still exists, and its chrome must keep showing
        // the address it was last on. `PanelWebTabModel.container` is weak, so the verbs go quiet on
        // their own. `PanelWebTabModels.discard` belongs to closing a TAB, not stopping a browser.
    }

    // MARK: Viewport

    /// Task 4's call: mount `tabId`'s container in the panel, and remember the panel's host view so
    /// a later plan's `.attachViewport` has somewhere to put things.
    func attachViewport(tabId: String, into host: NSView) {
        viewportHost = host
        mountViewport(tabId: tabId, into: host)
    }

    private func mountViewport(tabId: String, into host: NSView) {
        guard let container = containers[tabId] else {
            // Nothing to mount, so nothing is claimed. Silent about the viewport on purpose: saying
            // "t is shown" here would tell the next plan a lie it has no way to detect.
            NSLog("[BrowserRuntime] attachViewport(\(tabId)): no live browser to mount")
            return
        }

        // Spike Fact 5: **one `addSubview`, never `removeFromSuperview` first.** The "in a window at
        // all times" invariant is what was measured, and `addSubview` already re-parents a view that
        // has a superview. Fact 4: setting the frame after the move is the whole of the resize —
        // `PanelCEFContainerView.resizeSubviews(withOldSize:)` carries it to CEF's view.
        host.addSubview(container)
        container.frame = host.bounds
        container.autoresizingMask = [.width, .height]

        viewportTabId = tabId
        touch(tabId)
        restoreFirstResponder(in: container, tabId: tabId)
    }

    /// **Spike Fact 2, and it is an obligation, not a nicety.** A reparent destroys first-responder
    /// status and attaching does not restore it — every attach the spike logged read
    /// `frBefore=NSWindow frAfter=NSWindow` — so without this the shown tab accepts zero keystrokes.
    /// Worse, the two obvious targets (`container.subviews.first`, `GetWindowHandle()`'s view) are
    /// both the outer `CefBrowserHostView`, which *accepts* first-responder status and then delivers
    /// nothing: getting it wrong looks green from every angle.
    private func restoreFirstResponder(in container: PanelCEFContainerView, tabId: String) {
        let found = Self.findKeyboardResponder(in: container)
        if found.count != 1 {
            // The loud log the spike asked for. Zero: nobody can type in the panel — most likely the
            // browser has not been created into the container yet, which is benign and transient,
            // or Chromium's view tree has changed shape, which is not. More than one: the choice
            // below is a guess.
            NSLog("[BrowserRuntime] first-responder search for \(tabId) found \(found.count) "
                  + "candidates (matched by \(found.matchedBy.rawValue)) — expected exactly 1")
        }
        guard let view = found.view, let window = container.window else { return }
        if !window.makeFirstResponder(view) {
            NSLog("[BrowserRuntime] \(tabId): \(NSStringFromClass(type(of: view))) refused first "
                  + "responder — the panel will take no keyboard input")
        }
    }

    /// Park `tabId`'s container back in the parking window. Never stops anything — that is the whole
    /// point of the inversion: a tab switch is a container swap, and page state survives it by
    /// construction.
    func detachViewport(tabId: String) {
        if viewportTabId == tabId { viewportTabId = nil }
        guard let container = containers[tabId] else { return }
        park(container)
    }

    private func park(_ container: PanelCEFContainerView) {
        guard let parkingHost = parkingWindow.contentView else { return }
        parkingHost.addSubview(container)
        container.frame = parkingHost.bounds
        container.autoresizingMask = [.width, .height]
    }

    /// Most-recently-used LAST — `lruOrder` hands the engine the reverse.
    private func touch(_ tabId: String) {
        lru.removeAll { $0 == tabId }
        lru.append(tabId)
    }

    // MARK: The linger

    private struct Linger {
        /// **The ENGINE's deadline, and it never moves.** Task 5 feeds it straight back into
        /// `plan(pendingStops:)`, where it is compared against the engine's own clock; an executor
        /// that pushed it forward would make every later plan see an unexpired deadline and say
        /// nothing at all — the stop would never happen.
        let deadline: Date
        var cancellable: Scheduler.Cancellable
    }

    /// Naive by contract: a second `scheduleStop` for a session that already has one replaces it.
    /// The engine never emits that today (a session with a pending deadline gets no fresh
    /// `scheduleStop`), and the executor does not get to assume so.
    private func scheduleStop(sessionId: String, at deadline: Date) {
        arm(sessionId, deadline: deadline, fireAt: deadline)
    }

    /// Replace whatever timer a session has with one firing at `fireAt`, keeping `deadline` as the
    /// recorded truth. Cancelling first is not bookkeeping for its own sake: a one-shot that has
    /// already fired is spent, but one that has NOT — the `scheduleStop`-replaces case — is still
    /// live and would fire a second time against a deadline that no longer exists.
    private func arm(_ sessionId: String, deadline: Date, fireAt: Date) {
        lingers[sessionId]?.cancellable.cancel()
        lingers[sessionId] = Linger(deadline: deadline, cancellable: armTimer(sessionId, fireAt: fireAt))
    }

    /// Both cases the engine emits this for — a signal returning, and a deadline just consumed by
    /// the stops in the same plan — mean the same thing here: forget the deadline. Unknown session:
    /// no-op.
    private func cancelScheduledStop(sessionId: String) {
        lingers.removeValue(forKey: sessionId)?.cancellable.cancel()
    }

    private func armTimer(_ sessionId: String, fireAt: Date) -> Scheduler.Cancellable {
        scheduler.timer(fireAt) { [weak self] in self?.lingerFired(sessionId: sessionId) }
    }

    /// **The one place this file departs from "apply the plan and nothing else" — and the departure
    /// is an obligation the engine imposes, not a decision taken here.** `BrowserAction.scheduleStop`
    /// says it in full: a plan that finds an unexpired pending deadline emits *nothing* for that
    /// session, so the executor must keep (or re-arm) its timer until it actually sees
    /// `cancelScheduledStop`, and a timer that fires early must re-arm rather than be dropped.
    ///
    /// Three cases, in the order they are checked:
    ///
    ///  1. **No deadline** — a cancel landed while this timer was in flight. Do nothing at all.
    ///  2. **Early fire** (a clock adjustment, a sleep/wake) — re-arm at the SAME deadline and ask
    ///     for nothing. The deadline has not arrived; announcing it would have the engine stop
    ///     browsers inside the linger it just granted them.
    ///  3. **The deadline has arrived** — ask for a re-plan, and then keep the deadline armed unless
    ///     that re-plan cancelled it. The stop itself is still the engine's to decide, on the next
    ///     plan, against freshly read signals; nothing here stops anything.
    private func lingerFired(sessionId: String) {
        guard let linger = lingers[sessionId] else { return }

        if scheduler.now() < linger.deadline {
            arm(sessionId, deadline: linger.deadline, fireAt: linger.deadline)
            return
        }

        if onLingerDeadline == nil {
            NSLog("[BrowserRuntime] linger for \(sessionId) expired with no re-plan hook — nothing "
                  + "will stop its browsers until one is set")
        }
        onLingerDeadline?(sessionId)

        // Still pending ⇒ the re-plan did not cancel it (it held, or nobody was listening). Keep
        // asking, at the recheck interval, rather than letting the stop be stranded.
        guard let survived = lingers[sessionId] else { return }
        arm(sessionId, deadline: survived.deadline,
            fireAt: scheduler.now().addingTimeInterval(Self.lingerRecheckInterval))
    }
}
