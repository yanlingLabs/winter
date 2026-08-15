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
/// Three documented departures, and none is a decision about whether a browser should exist.
/// **(1)** `scheduleStop`'s "keep or re-arm the timer until you actually see
/// `cancelScheduledStop`" — an obligation the engine imposes on its executor (see `lingerFired`).
/// **(2)** Application is NOT fully synchronous: `create` parks and wires its container inline but
/// defers the CEF call by one turn (`startBrowser`), so a `.attachViewport` applied later in the
/// same plan reaches its container BEFORE the browser is asked for. Create-before-attach still
/// holds in the sense the engine's contract needs — there is a container to mount — but it is
/// inverted in the CEF sense, and that inversion is load-bearing: it is why the responder restore
/// runs a second time after the create, and why the hop re-checks that the runtime still owns the
/// container it was handed. **(3)** (arrived in T5, after this inventory was first written)
/// `.attachViewport` can be silently DEFERRED rather than applied: `apply`'s case for it guards on
/// the remembered `viewportHost` being both non-nil and actually in a window, and skips the mount
/// when it is not — logging rather than asserting. Nothing is lost by the skip: the viewport stays
/// unclaimed, so the next plan still sees the mismatch and re-emits the same action, and a live
/// host re-attaches directly the moment it joins a window (full rationale at that case, below).
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
    /// `production` below is the whole of the un-substitutable half: thirteen forwards to
    /// `NormaCEF*` / `NormaCEFRuntime` (ten of them until B2 Task 3 added the agent's three), one
    /// line each but for `failureReason`'s three-line unwrap of an enum, with
    /// no branch and no state of their own — which is what "thin enough to verify by reading" has to
    /// mean when reading is the only verification available.
    struct CEFDriver {
        var setStateObserver: (PanelCEFContainerView, ((NormaCEFBrowserState?) -> Void)?) -> Void
        var setNavigationObserver: (PanelCEFContainerView, ((String?, String?) -> Void)?) -> Void
        var setPopupObserver: (PanelCEFContainerView, ((String?) -> Void)?) -> Void
        var seedTabState: (PanelCEFContainerView, String, String) -> Void
        var createBrowser: (PanelCEFContainerView, String) -> Void
        var closeBrowser: (PanelCEFContainerView) -> Void

        /// B2 Task 3 — **the three calls the agent's verbs make**, added to this seam rather than
        /// beside it for the reason the seam exists at all: `PanelCommandConsumer` is pure routing
        /// and policy, and spec §9 says its logic tests through a driver.
        ///
        /// `loadURL` and `goBack` are the SAME two C entry points the chrome's own buttons use
        /// (`NormaCEFLoadURL`/`NormaCEFGoBack`, reached from `PanelWebTabModel.navigate(typed:)` and
        /// `.goBack()`) — deliberately not a second load path. What differs is only where the policy
        /// ran: the field's Return key filters at the field, the agent's `navigate` filters at the
        /// consumer, and both filter with `PanelURLPolicy`.
        var loadURL: (PanelCEFContainerView, String) -> Void
        var goBack: (PanelCEFContainerView) -> Void
        /// One DevTools protocol method and its reply — `NormaCEFExecuteCDP`, whose completion
        /// ALWAYS fires (`NormaCEF.h` carries that contract and the three points that keep it true
        /// when a browser goes away mid-call). A recorder substituted here holds the completion and
        /// fires it when the test says so, which is the whole of how the read verbs are testable.
        var executeCDP: (PanelCEFContainerView, String, String?, @escaping (Bool, String) -> Void) -> Void

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
            // editor-product Task 4: `0` is "no override" (CEF's own `background_color` contract —
            // fully transparent alpha) — an ordinary web tab has no brand to anticipate, so this
            // preserves today's behaviour byte-for-byte rather than growing this closure's own
            // signature for a value every caller here would pass the same constant for anyway.
            createBrowser: { NormaCEFCreateBrowser($0, $1, 0) },
            closeBrowser: { NormaCEFCloseBrowser($0) },
            loadURL: { NormaCEFLoadURL($0, $1) },
            goBack: { NormaCEFGoBack($0) },
            executeCDP: { NormaCEFRuntime.executeCDP(in: $0, method: $1, paramsJSON: $2, completion: $3) },
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
                // turn — the same one-turn hop the view-owned create used, for the reason
                // `startBrowser` below sets out.
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
    ///
    /// **It installs the pre-shutdown hook, and doing it HERE is what makes "only the real runtime"
    /// structural** (live-gate fix H). The hook is process-global; installing it in `init` would
    /// have the last-constructed runtime win, which in a test bundle is whichever test ran most
    /// recently. Tying it to `shared` means the only object that can ever hold a browser at
    /// `applicationWillTerminate` is the only object that registers to let go of one.
    static let shared: BrowserRuntime = {
        let runtime = BrowserRuntime()
        NormaCEFSetPreShutdownHook {
            // Called from `NormaCEFShutdown`, i.e. from `applicationWillTerminate:`, i.e. on the
            // main thread — a statement of fact rather than an assumption, which is what
            // `assumeIsolated` is for (the same reason `Scheduler.production.mainAsync` uses it).
            MainActor.assumeIsolated { runtime.releaseViewsForShutdown() }
        }
        return runtime
    }()

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
    /// **Set by `BrowserSignalsCoordinator.init`, before it can ever call `apply`, and it matters
    /// for more than tidiness.** A parked, agent-driven browser (spec §5) is never rendered, so
    /// nothing else will ever bind a host to its model — and a model with no host silently records
    /// no navigations at all. `wire` logs when this is nil.
    weak var host: ShellSessionHost?

    /// "A linger deadline has arrived; re-plan." Set by `BrowserSignalsCoordinator.init`, in the
    /// same two lines as `host` and for the same reason: both are wired before the coordinator's
    /// first `apply`. The executor deliberately cannot stop anything itself here — the stop is the
    /// engine's decision, taken on a later plan against freshly read signals.
    var onLingerDeadline: ((String) -> Void)?

    init(driver: CEFDriver = .production, scheduler: Scheduler = .production) {
        self.driver = driver
        self.scheduler = scheduler
    }

    // MARK: - What `BrowserSignalsCoordinator` feeds back into `plan`

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

    // MARK: - B2 Task 3: performing a verb against a tab's browser

    /// **The agent's three verbs, and nothing more than a container lookup plus a driver call.**
    ///
    /// They live here because this object is the one that OWNS containers — including the parked
    /// ones nothing renders, which is exactly the set an agent browses in (spec §5's headless case).
    /// A consumer that resolved tabs itself would be a second registry, and a consumer that reached
    /// for `PanelWebTabModels` would be asking the VIEW world for a browser that may never have been
    /// rendered.
    ///
    /// **They decide nothing**, which is this file's standing rule: whether a browser should exist is
    /// `BrowserLifecycleEngine.plan`'s question, whether a URL may be loaded is `PanelURLPolicy`'s
    /// (applied at the consumer, before `loadURL` is ever called — door 5), and which verbs exist at
    /// all is `PanelCommandConsumer`'s.
    ///
    /// Each returns whether the call was DISPATCHED, never whether it succeeded — the browser has no
    /// synchronous answer to give. `false` means one of two things the consumer must be able to tell
    /// apart from a verb that ran and failed: no live browser for that tab, or the quit latch is
    /// shut.
    @discardableResult
    func loadURL(tabId: String, url: String) -> Bool {
        // live-gate fix I: the same door `attachViewport`/`detachViewport` refuse at, for the same
        // reason — the world is ending and this object is frozen. Unreachable in practice, because
        // `PanelCommandConsumer` checks `isQuiescent` before it routes anything (it has to: a
        // dropped command must produce no RESULT either, which is a decision this method cannot
        // make). Kept as the belt, so "quiesced means nothing reaches CEF" holds for every door.
        guard !isQuiescent, let container = containers[tabId] else { return false }
        driver.loadURL(container, url)
        return true
    }

    @discardableResult
    func goBack(tabId: String) -> Bool {
        guard !isQuiescent, let container = containers[tabId] else { return false }
        driver.goBack(container)
        return true
    }

    /// Run one DevTools protocol method against `tabId`'s browser.
    ///
    /// **`completion` is called if and only if this returns `true`** — which is the whole reason it
    /// returns anything. `NormaCEFExecuteCDP` guarantees its own completion always fires, so a caller
    /// that got `true` will hear back; a caller that got `false` never dispatched anything and must
    /// answer for itself rather than wait.
    @discardableResult
    func executeCDP(tabId: String, method: String, paramsJSON: String?,
                    completion: @escaping (Bool, String) -> Void) -> Bool {
        guard !isQuiescent, let container = containers[tabId] else { return false }
        driver.executeCDP(container, method, paramsJSON, completion)
        return true
    }

    // MARK: - The parking window (spec §3)

    private var parkingWindowStorage: NSWindow?

    /// `true` once anything has needed parking. Exists so the laziness is assertable: a Norma that
    /// never opens a web tab must not build a window for it.
    var hasParkingWindow: Bool { parkingWindowStorage != nil }

    /// Borderless, `isReleasedWhenClosed = false`, and **never ordered in** — the spec's literal
    /// shape, which Task 1 measured as indistinguishable from ordered-out and offscreen on audio,
    /// rAF, timers, visibility and CPU (Fact 9), so the simplest wins.
    ///
    /// **Its size is load-bearing for headless, and this rect is where a never-attached browser
    /// lives for life.** `CreateBrowserNow` reads `[parent bounds]` exactly ONCE, at creation, and
    /// hands it to `CefWindowInfo::SetAsChild` (`NormaCEF.mm`) — so a browser created into a parked
    /// container is laid out at whatever the container measured at that instant. An *attach* fixes a
    /// visible tab (Fact 4: set the frame after `addSubview` and the page follows, via
    /// `resizeSubviews(withOldSize:)`), but a browser created parked and NEVER attached — spec §5's
    /// headless case, and the whole of B2's — has no such rescue: at a zero-sized parking window it
    /// would run at zero width forever, laying out as if on a viewport nobody could ever see.
    /// 1280×800 is therefore a plausible desktop viewport chosen deliberately, not an arbitrary
    /// placeholder, and `BrowserRuntimeTests` pins that a create measures a non-zero container.
    ///
    /// **Since live-gate fix B this rect is an INITIAL SIZE, not a size parked containers are held
    /// at.** `park` no longer resizes anything (see its own doc for the scroll drift that caused),
    /// so a container mounted in a 1600×1000 panel and then parked stays 1600×1000 — larger than the
    /// window it now lives in. That is fine and needs no handling: this window is never ordered in,
    /// so nothing is drawn, nothing is clipped that anyone can see, and AppKit imposes no
    /// containment on a subview that overflows its superview's bounds. The window's size is read in
    /// exactly one place — `create`, for a container that has no size of its own yet.
    var parkingWindow: NSWindow {
        if let existing = parkingWindowStorage { return existing }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "Norma browser parking"
        parkingWindowStorage = window
        return window
    }

    // MARK: - The quiescence latch (live-gate fix I)

    /// **The quit beat is not quiescent unless something makes it so.**
    ///
    /// Fix H bought the clean shutdown with a beat: `AppDelegate.quitReleasingBrowserViews`
    /// unparents every container and only THEN calls `NSApp.terminate`, ~150 ms later
    /// (`AppDelegate.browserQuitSettleSeconds`). A beat is run-loop turns, and run-loop turns are
    /// exactly when a session fold, a Combine sink or the session-list poll reaches
    /// `BrowserSignalsCoordinator.replan`. That re-plan is computed against a world where the
    /// viewport has just been released, so it legitimately emits `.attachViewport` (the engine sees
    /// `viewport != desired`) or `.create` — and either one puts back what the beat just gave up:
    /// the attach re-mounts a container into the window and responder chain it was taken out of,
    /// the create makes a browser nothing will ever close.
    ///
    /// The user's third live gate is that at real scale: eleven browsers, ten closed cleanly before
    /// terminate, then `shutting down (1 browser(s) still open, 50/50 drain turns)` — and the
    /// survivor was **id=49, the newest**, which is the signature of a browser that came into
    /// existence during the beat rather than one that was open when the user chose Quit.
    ///
    /// So the quit door latches this object shut on its way through: `apply` drops every action,
    /// the two view doors refuse, the in-flight create hop refuses, and every linger timer is
    /// cancelled. **Runtime mechanics, not policy** — it decides nothing about which browsers
    /// should exist (that is `BrowserLifecycleEngine.plan`'s question and only its); it freezes the
    /// world for the last ~150 ms of the process.
    ///
    /// **One-way, with no un-quiesce, and that is a fact about the callers rather than a
    /// convenience.** `quiesce()` is called only from `AppDelegate.quitReleasingBrowserViews()`,
    /// which has exactly two callers, both true quits that cannot be cancelled:
    ///
    ///   * the menu bar's "Quit Norma" — the `quit:` closure at `AppDelegate.swift:1082`, fired by
    ///     `MenuBarController.didQuit()` (`MenuBarController.swift:454`), which runs `onReallyQuit()`
    ///     — setting `AppDelegate.reallyQuitting = true` — BEFORE `quitApplication()`, so
    ///     `applicationShouldTerminate` answers `.terminateNow` and the quit cannot be refused;
    ///   * `SpikeCloseLeakHarness.quit()` (`SpikeCloseLeak.swift:677`), `#if DEBUG` and env-gated,
    ///     which arms that same flag first for that same reason.
    ///
    /// **It deliberately does NOT gate `releaseViewsForShutdown`.** That is fix H's other half and
    /// the belt for a shutdown reached without this door (the `NormaCEFSetPreShutdownHook` block, a
    /// system logout): `NormaCEFCloseAllBrowsers`' sweep must still get every host view back, and a
    /// latch that silenced the release would trade this fix for the one it is built on.
    private(set) var isQuiescent = false

    /// One line, not a page of them: a replan storm during the beat reaches `apply` repeatedly.
    private var loggedQuiescentApply = false

    /// Latch shut. Idempotent — a second call is a no-op, so nothing depends on the door being
    /// walked through exactly once.
    ///
    /// The linger timers are cancelled here because they are the one thing that can wake this
    /// object up with nobody calling into it. A fire during the beat would ask the coordinator for
    /// a re-plan (harmless now — that `apply` is a no-op) and then **re-arm itself**, which is
    /// pointless work inside a process that is ending. `lingerFired` needs no latch of its own: it
    /// guards on `lingers[sessionId]`, which this empties.
    func quiesce() {
        guard !isQuiescent else { return }
        isQuiescent = true
        let armed = lingers.count
        for linger in lingers.values { linger.cancellable.cancel() }
        lingers.removeAll()
        NSLog("[BrowserRuntime] quiesced for the quit — \(containers.count) browser(s) frozen, "
              + "\(armed) linger(s) cancelled; nothing can create, attach or detach from here")
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
        // **live-gate fix I: after the quit door, no plan is applied at all.** Not a decision about
        // the plan — the plan is correct, and on any other beat this would execute it faithfully.
        // The world is simply ending, and re-attaching or creating now is what left the user's
        // newest browser open at `CefShutdown`. See `isQuiescent`.
        guard !isQuiescent else {
            if !loggedQuiescentApply {
                loggedQuiescentApply = true
                NSLog("[BrowserRuntime] quiesced — dropping this plan (\(actions.count) action(s)) "
                      + "and every later one; logged once")
            }
            return
        }

        var titles: [String: String?] = [:]
        for state in tabs.values.joined() { titles[state.tabId] = state.title }

        for action in actions {
            switch action {
            case .create(let tabId, let url):
                create(tabId: tabId, url: url, title: titles[tabId] ?? nil, sessionId: sessionOf(tabId))
            case .stop(let tabId):
                stop(tabId: tabId)
            case .attachViewport(let tabId):
                // **The remembered host must be BOTH there and in a window** (T4 review Minor-3,
                // discharged here — obligation #7 — in the same commit that first gives `apply` a
                // caller). `viewportHost` is weak and the panel's host view belongs to SwiftUI, so
                // between `PanelViewport.dismantleNSView` and ARC releasing that view the reference
                // is non-nil while the view is in no window at all. Mounting into it would durably
                // break spike Fact 5 (a container is in a window at all times — the invariant the
                // whole reparenting design rests on) and put the page in a rectangle nothing shows.
                //
                // The window check lives HERE, on the action path, and not inside `mountViewport`:
                // the view's own `attachViewport(tabId:into:)` deliberately mounts before its host
                // joins a window (SwiftUI runs `makeNSView` first, and T4 MEASURED that ordering
                // together with `viewDidMoveToWindow`'s re-attach). Only the action path can reach
                // a host SwiftUI has already finished with.
                //
                // Clearing `viewportHost` in `detachViewport` was the alternative Minor-3 offered
                // and it is the wrong one: a single plan legitimately emits `.detachViewport(A)`
                // then `.attachViewport(B)`, and a detach that cleared the host would leave that
                // same-pass attach with nowhere to mount.
                //
                // Either way nothing is claimed: `viewportTabId` stays as it was, so the next plan
                // still sees `viewport != desired` and re-emits this — and a live host view
                // re-attaches directly the moment it joins a window.
                guard let host = viewportHost, host.window != nil else {
                    NSLog("[BrowserRuntime] attachViewport(\(tabId)) with no panel host in a window "
                          + "— deferred")
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
    /// The CEF part of the sequence was `PanelWebTab.makeNSView`'s, absorbed **in its order** (T4
    /// deleted that copy, so this is now the only one), and that order
    /// is load-bearing: the state observer publishes the current snapshot the moment it is
    /// registered, and the seed is what makes that first snapshot the tab's known address instead of
    /// blank (`NormaCEF.h`). Observers, then seed, then create. The two steps BEFORE it — parking
    /// the container and the LRU touch — are this task's, and had no equivalent in the view.
    private func create(tabId: String, url: String?, title: String?, sessionId: String?) {
        // **The double-create guard.** Rule 8 re-creates a held session's shown tab on every plan
        // where it is missing, so a create for a tab that already has one is ordinary traffic — and
        // a second `NormaCEFCreateBrowser` into the same container is a second live browser that
        // nothing will ever close, because the registry only remembers one container per tab.
        guard containers[tabId] == nil else { return }

        let container = PanelCEFContainerView()
        containers[tabId] = container
        park(container)
        // **The INITIAL size of a browser born parked, and since live-gate fix B the only place the
        // parking window's rect is used as a size at all.** A fresh `PanelCEFContainerView` measures
        // zero, and `CreateBrowserNow` reads `[parent bounds]` exactly ONCE, at creation
        // (`NormaCEF.mm`) — so a headless browser created into an unsized container would lay out at
        // zero width for life, with no attach ever coming to rescue it (spec §5, and all of B2).
        // Parking no longer supplies that rect on every park, so the create path has to.
        if let parkingBounds = parkingWindow.contentView?.bounds {
            container.frame = parkingBounds
        }
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
            // that is never rendered. `BrowserSignalsCoordinator.init` sets `host` before its
            // first `apply` — see that property's own doc.
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
        // whatever pass called `apply` (`BrowserSignalsCoordinator.replan` runs from a fold, i.e.
        // from inside the session event pump, and from a Combine sink), and guarantees the run loop
        // is genuinely spinning when CEF comes
        // up (see `NormaCEFRuntime`'s note on Task 1's starvation hypothesis).
        scheduler.mainAsync { [weak self] in
            guard let self else { return }
            // **The race `PanelWebTab` could not have.** There, nothing could interleave between
            // `makeNSView` and the hop — `dismantleNSView` cannot beat a same-turn async. Here a
            // LATER PLAN can: a `.stop` for this tab may have already run, releasing the container.
            // Creating a browser into it now would leave one live, observer-less, and closed by
            // nobody for the life of the process.
            guard self.containers[tabId] === container else { return }
            // **live-gate fix I, and the reason the latch cannot live in `apply` alone.** This hop
            // is the one piece of `create` that runs on a LATER turn, so a create applied in the
            // last plan before the quit door opens still has its `NormaCEFCreateBrowser` pending
            // when the beat starts — and the identity guard above passes, because quiescing does
            // not clear the registry. Asking CEF for a browser now is exactly the racing-create
            // shape the tripwire counts (`NormaCEF.mm`), one turn from `NSApp.terminate`.
            guard !self.isQuiescent else {
                NSLog("[BrowserRuntime] quiesced — \(tabId)'s create never reached CEF")
                return
            }

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
            // A plan may create and attach in the same pass (a session waking up on its shown tab),
            // and attach ran BEFORE this hop — with no CEF view in the container, so nothing could
            // be made first responder. Completing that same obligation now, for the one tab it can
            // apply to. Not a second policy: `restoreFirstResponder` is idempotent and does nothing
            // unless this tab is the mounted one.
            if self.viewportTabId == tabId {
                self.restoreFirstResponder(in: container, tabId: tabId)
            }
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

        // Only AFTER the close, and the ordering is the same one the shipped `dismantleNSView` had.
        // CEF's close is ASYNCHRONOUS — `OnBeforeClose` lands later — but `NormaCEFCloseBrowser`
        // both detaches CEF's own host view from this container AND releases the registry's strong
        // reference to it before returning (`CompleteCloseByReleasingHostView` — the release is
        // what lets the close COMPLETE; Task 6 measured that the detach alone completes nothing).
        // So what is unparented here is an empty container rather than one still carrying a live
        // CEF view, and this runtime is never the last retain on that view. Unparenting it matters
        // both ways round: left in the parking window it is retained for the life of the process,
        // and left in the PANEL's host it is a dead rectangle where the page used to be.
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
        // live-gate fix I: the VIEW door, refused after the quit door. `PanelViewportHostView`
        // calls this from `viewDidMoveToWindow` as well as from `makeNSView`, so a window closing
        // during the beat is enough to reach it — and a mount now re-takes the window retain and
        // the responder chain that `releaseViewsForShutdown` just gave up. Not even the host is
        // remembered: there is no later plan for it to serve.
        guard !isQuiescent else { return }
        viewportHost = host
        mountViewport(tabId: tabId, into: host)
    }

    private func mountViewport(tabId: String, into host: NSView) {
        guard let container = containers[tabId] else {
            // Nothing to mount, so nothing is claimed — `viewportTabId` is deliberately left alone.
            // Recording this tab as the viewport would tell the next plan the panel is showing a
            // browser that does not exist, and the plan has no way to detect the lie.
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
            // The loud log the spike asked for. Zero: nobody can type in this tab. Two causes, and
            // only one of them is a defect — CEF has not parented its view into the container yet
            // (creation is asynchronous, so a plan that creates and attaches in one pass reaches
            // here first; `startBrowser` calls this again once the create has been made, and a click
            // into the page fixes it in any case, since Chromium's own focus machinery then runs),
            // or Chromium's view tree has changed shape, which is. More than one: the choice below
            // is a guess.
            //
            // A THIRD cause reaches neither of those branches and is logged separately below: the
            // search finds its one candidate, but the host is not in a window yet (SwiftUI runs
            // `makeNSView` before the view joins one). `count == 1` would otherwise make that the
            // only silently-skipped restore on the one path the spike calls silently breakable.
            NSLog("[BrowserRuntime] first-responder search for \(tabId) found \(found.count) "
                  + "candidates (matched by \(found.matchedBy.rawValue)) — expected exactly 1")
        }
        guard let view = found.view else { return }
        guard let window = container.window else {
            // See the third cause above. Not an error — the next attach, once the host has joined a
            // window, restores it, and since T4 that attach is guaranteed rather than hoped for
            // (`PanelViewportHostView.viewDidMoveToWindow` re-calls `attachViewport` on window
            // join) — but it must not be the one exit here that says nothing.
            NSLog("[BrowserRuntime] \(tabId): container is in no window yet — first responder not "
                  + "restored (nothing can take a keystroke until it is)")
            return
        }
        if !window.makeFirstResponder(view) {
            NSLog("[BrowserRuntime] \(tabId): \(NSStringFromClass(type(of: view))) refused first "
                  + "responder — the panel will take no keyboard input")
        }
    }

    /// Park `tabId`'s container back in the parking window. Never stops anything — that is the whole
    /// point of the inversion: a tab switch is a container swap, and page state survives it by
    /// construction.
    func detachViewport(tabId: String) {
        // live-gate fix I: refused after the quit door, for symmetry with the attach and because
        // there is nothing left for it to do — `releaseViewsForShutdown` has already parked every
        // container and cleared the viewport. `PanelViewport.dismantleNSView` reaches here while
        // `applicationWillTerminate` closes the main windows, i.e. after the beat; letting that
        // through would only re-run a park that has already happened.
        guard !isQuiescent else { return }
        if viewportTabId == tabId { viewportTabId = nil }
        guard let container = containers[tabId] else { return }
        park(container)
    }

    /// **live-gate fix H: give every CEF host view back to the parking window, right before CEF's
    /// shutdown sweep.**
    ///
    /// Two callers, and the difference between them is the whole of what fix H measured.
    /// **`AppDelegate.quitReleasingBrowserViews` is the one that works** — it runs this one
    /// run-loop beat before `NSApp.terminate`, which is what actually lets the references go (that
    /// method carries the measured table). The `NormaCEFSetPreShutdownHook` block installed on
    /// `shared` below runs it again from inside `NormaCEFShutdown`, as the belt for a quit that
    /// never passed through that door.
    ///
    /// **The stall it exists to kill, as the user measured it:** `shutting down (2 browser(s) still
    /// open, 50/50 drain turns, …)` and then `browser closed (id=30, live browsers=0)` from inside
    /// `CefShutdown`. A close completes when CEF's host view DEALLOCATES, and
    /// `CompleteCloseByReleasingHostView` only achieves that if its release is the LAST one. T7's
    /// harness parked everything, so it always was, and measured `0/50`. The shipped app does not
    /// park everything: the SHOWN tab's container is mounted in the app window, and a container that
    /// has been there carries references — the responder chain among them, since this runtime makes
    /// Chromium's own view first responder on every attach — that outlive the sweep's pool.
    ///
    /// Deliberately NOT a stop: nothing is closed, no observer is cleared, no model is touched. The
    /// sweep immediately afterwards is what closes browsers, and it is CEF's to run. This only
    /// changes WHERE the views are when it does.
    ///
    /// **Lazy-window discipline is preserved**: a Norma that never opened a web tab must not build a
    /// parking window on its way out, which is exactly what the empty guard is for
    /// (`hasParkingWindow` is asserted elsewhere for the same reason).
    /// Whether anything at all needs `releaseViewsForShutdown`. Read by the quit path so a Norma
    /// that never opened a web tab pays no deferral (`AppDelegate.deferQuitToReleaseBrowserViews`).
    var hasLiveBrowsers: Bool { !containers.isEmpty }

    func releaseViewsForShutdown() {
        guard !containers.isEmpty else { return }
        // The viewport is the one container that is genuinely somewhere else, and clearing the id is
        // not bookkeeping for its own sake: `viewportTabId` must mean *mounted*, and after this it
        // is not.
        viewportTabId = nil
        let parking = parkingWindow
        for container in containers.values {
            resignFirstResponder(in: container)
            // Already parked is the common case (every tab but the shown one), and a repeat
            // `addSubview` of an existing subview is measured as a no-op — see
            // `PanelViewportHostView.viewDidMoveToWindow`.
            if container.superview !== parking.contentView { park(container) }
        }
    }

    /// **A window RETAINS its first responder, and taking the view out of the window does not
    /// resign it.** Measured, not assumed: with the hook parking containers but leaving the
    /// responder alone, the MOUNTED browser was still `1 browser(s) still open, 50/50 drain turns`
    /// while every parked one closed in `0/50`.
    ///
    /// The runtime is the reason there is one to resign: `restoreFirstResponder` makes Chromium's
    /// `RenderWidgetHostViewCocoa` the window's first responder on every attach (spike Fact 2 —
    /// without it the panel takes no keystrokes at all), so the shown tab's CEF view is exactly the
    /// object AppKit is holding.
    ///
    /// Scoped as narrowly as it can be: only when the window's current first responder is inside
    /// THIS container, and never for the parking window (nothing ever makes a responder there, and
    /// clearing one we did not set would be reaching outside what this method is for).
    private func resignFirstResponder(in container: PanelCEFContainerView) {
        guard let window = container.window, window !== parkingWindowStorage else { return }
        guard let responder = window.firstResponder as? NSView,
              responder.isDescendant(of: container) else { return }
        window.makeFirstResponder(nil)
    }

    /// **Moves the container, and touches nothing else — live-gate fix B.**
    ///
    /// It used to snap the container to the parking window's contentView bounds (1280×800) on the
    /// way in. That is a genuine viewport resize for a live page: Chromium reflows, lazily-loaded
    /// content re-lays-out at the new width, and the scroll OFFSET the page keeps in pixels then
    /// points at different content. The user's report was exactly that — a YouTube feed came back
    /// "decently far" from where they left it, on a design whose whole premise (spec §2) is that a
    /// tab switch preserves state by construction. Nothing about parking needs a size: the window is
    /// never shown, so there is no layout to satisfy and no clipping anyone can see.
    ///
    /// The autoresizing mask is deliberately not set here either. It belongs to `mountViewport`,
    /// where a superview that really does resize is what makes it mean something; the parking
    /// window's contentView never resizes, so a mask assigned on the way in would be inert.
    private func park(_ container: PanelCEFContainerView) {
        parkingWindow.contentView?.addSubview(container)
    }

    /// Appends, so the array reads least-recently-used FIRST — which is the order `plan(lruOrder:)`
    /// documents and consumes, with no reversal anywhere.
    private func touch(_ tabId: String) {
        lru.removeAll { $0 == tabId }
        lru.append(tabId)
    }

    // MARK: The linger

    private struct Linger {
        /// **The ENGINE's deadline, and it never moves.** `BrowserSignalsCoordinator` feeds it
        /// straight back into `plan(pendingStops:)`, where it is compared against the engine's own clock; an executor
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
