import AppKit
import XCTest
@testable import Norma

/// browser-runtime T3: the executor's whole coverage (spec §2, §5, §6).
///
/// `BrowserRuntime` is the half of the runtime that TOUCHES things — CEF, `NSView`s, timers — so
/// unlike `BrowserLifecycleTests` it cannot be a pure-function table. Spec §9's constraint is
/// absolute ("no CEF client override is callable under XCTest, ever"), so every CEF call goes
/// through `BrowserRuntime.CEFDriver` and these tests substitute a recorder. What that leaves
/// uncovered is stated plainly rather than papered over:
///
///   * **`CEFDriver.production` itself** — ten one-line forwards to `NormaCEF*`. Nothing here
///     executes them; they are verified by reading, which is what "thin enough to verify by
///     reading" has to mean for a seam no test may cross.
///   * **What CEF does with the calls** — that `NormaCEFCreateBrowser` really parents a browser,
///     that `NormaCEFCloseBrowser` really drains the registry. B1 pinned those; Task 1's spike
///     measured the reparent itself in the real app (`docs/research/2026-08-10-cef-reparent-spike.md`).
///   * **The DECISIONS** — whether a browser should exist at all is `BrowserLifecycleEngine`'s, and
///     `BrowserLifecycleTests` is where that lives. These tests only ask whether the executor
///     executes what it was handed, in the order it was handed it.
///
/// Real `NSView`s and a real (never-shown) parking `NSWindow` are used throughout: they are free,
/// they need no CEF, and a fake view tree would make the first-responder claim — the one thing the
/// spike says is silently breakable — untestable.
@MainActor
final class BrowserRuntimeTests: XCTestCase {

    // MARK: - Doubles

    /// Records every CEF call in order and hands the observer blocks back so a test can fire them.
    ///
    /// Containers are labelled `c1`, `c2`, … in first-touch order, so an ordering assertion reads as
    /// a transcript instead of a set of pointer comparisons.
    @MainActor
    final class CEFRecorder {
        private(set) var log: [String] = []
        private var marks: [ObjectIdentifier: String] = [:]

        var stateBlocks: [String: (NormaCEFBrowserState?) -> Void] = [:]
        var navigationBlocks: [String: (String?, String?) -> Void] = [:]
        var popupBlocks: [String: (String?) -> Void] = [:]

        /// What `NormaCEFRuntime.ensureInitialized()` answers. `true` is the ordinary path; the
        /// failure trio below drives the unavailable placeholder.
        var initialises = true
        var failure: String?
        var retryable = false
        private(set) var clearFailureCount = 0

        /// Stands in for what `NormaCEFCreateBrowser` does to the container: CEF parents its own
        /// view tree into it. Tests that care about the view tree install one here.
        var onCreate: ((PanelCEFContainerView, String) -> Void)?

        /// **The container's bounds AT THE INSTANT the browser was asked for**, which is the only
        /// instant that matters: `CreateBrowserNow` reads `[parent bounds]` once and hands it to
        /// `CefWindowInfo::SetAsChild` (`NormaCEF.mm`). Recorded separately from `log` so that the
        /// ordering assertions stay readable.
        private(set) var boundsAtCreate: [String: NSRect] = [:]

        func mark(_ view: NSView) -> String {
            let key = ObjectIdentifier(view)
            if let existing = marks[key] { return existing }
            let fresh = "c\(marks.count + 1)"
            marks[key] = fresh
            return fresh
        }

        var driver: BrowserRuntime.CEFDriver {
            BrowserRuntime.CEFDriver(
                setStateObserver: { [unowned self] container, block in
                    let mark = self.mark(container)
                    self.stateBlocks[mark] = block
                    self.log.append("\(mark) state=\(block == nil ? "nil" : "set")")
                },
                setNavigationObserver: { [unowned self] container, block in
                    let mark = self.mark(container)
                    self.navigationBlocks[mark] = block
                    self.log.append("\(mark) nav=\(block == nil ? "nil" : "set")")
                },
                setPopupObserver: { [unowned self] container, block in
                    let mark = self.mark(container)
                    self.popupBlocks[mark] = block
                    self.log.append("\(mark) popup=\(block == nil ? "nil" : "set")")
                },
                seedTabState: { [unowned self] container, url, title in
                    self.log.append("\(self.mark(container)) seed url=\(url) title=\(title)")
                },
                createBrowser: { [unowned self] container, url in
                    let mark = self.mark(container)
                    self.boundsAtCreate[mark] = container.bounds
                    self.log.append("\(mark) create url=\(url)")
                    self.onCreate?(container, url)
                },
                closeBrowser: { [unowned self] container in
                    self.log.append("\(self.mark(container)) close")
                },
                ensureInitialized: { [unowned self] in self.initialises },
                failureReason: { [unowned self] in self.failure },
                isRetryable: { [unowned self] in self.retryable },
                clearFailure: { [unowned self] in self.clearFailureCount += 1 })
        }
    }

    /// A clock and two schedulers under the test's thumb. Nothing here waits.
    @MainActor
    final class FakeScheduler {
        var current = Date(timeIntervalSince1970: 1_000_000)

        /// `mainAsync` work. `autoRun` = the ordinary shape (run it straight away); a test that
        /// needs to interleave something between the plan and the hop turns it off.
        var autoRun = true
        private(set) var pendingWork: [() -> Void] = []

        struct Armed {
            let id: Int
            let fireAt: Date
            let work: () -> Void
        }
        private(set) var armed: [Armed] = []
        private(set) var cancelled: [Int] = []
        private(set) var fired: [Int] = []
        private var nextId = 0

        /// The timers that will still fire: armed, not cancelled, and **not already spent**.
        ///
        /// Modelling `fired` is not fussiness — it is what makes every row below discriminate. A
        /// one-shot `Timer` is dead the moment it fires, so a double that kept a fired timer in this
        /// list would report "still armed" for a linger that can never fire again, and the
        /// re-arm-on-early-fire row went GREEN against an executor that dropped the re-arm entirely
        /// (measured, mutation E). This is the project's decorative-test class, caught in the act.
        var liveTimers: [Armed] {
            armed.filter { !cancelled.contains($0.id) && !fired.contains($0.id) }
        }

        func runPendingWork() {
            let work = pendingWork
            pendingWork = []
            for item in work { item() }
        }

        /// Fire an armed timer by id, exactly as the run loop would.
        func fire(_ id: Int) {
            guard let entry = armed.first(where: { $0.id == id }) else {
                return XCTFail("no timer with id \(id)")
            }
            fired.append(id)
            entry.work()
        }

        var scheduler: BrowserRuntime.Scheduler {
            BrowserRuntime.Scheduler(
                now: { [unowned self] in self.current },
                mainAsync: { [unowned self] work in
                    if self.autoRun { work() } else { self.pendingWork.append(work) }
                },
                timer: { [unowned self] fireAt, work in
                    self.nextId += 1
                    let id = self.nextId
                    self.armed.append(Armed(id: id, fireAt: fireAt, work: work))
                    return BrowserRuntime.Scheduler.Cancellable { [unowned self] in
                        self.cancelled.append(id)
                    }
                })
        }
    }

    // MARK: - Fake CEF view trees

    /// Stands in for Chromium's own `RenderWidgetHostViewCocoa`. `@objc(…)` gives it that exact
    /// Objective-C class name, which is the string the runtime matches on — the class is
    /// Chromium-internal and cannot be named from Swift any other way (spike Fact 2). No collision
    /// with the real one is possible: CEF's framework is never `dlopen`ed under XCTest
    /// (`NormaCEFRuntime` refuses), so this is the only class with that name in the process.
    @objc(RenderWidgetHostViewCocoa)
    final class FakeRenderWidgetHostView: NSView {
        override var acceptsFirstResponder: Bool { true }
    }

    /// The trap the spike measured: a shallow view that ACCEPTS first-responder status and then
    /// delivers nothing. `CefBrowserHostView` is not this greedy (it answers NO), which is exactly
    /// why a depth-or-`acceptsFirstResponder` heuristic looks correct in the one tree that was
    /// measured — this one makes the wrong answer reachable so the right rule can be pinned.
    final class GreedyShallowView: NSView {
        override var acceptsFirstResponder: Bool { true }
    }

    /// The durable half of Fact 2: `NSTextInputClient` conformance is what makes a view able to take
    /// a keystroke, and is the fallback when the class name ever changes.
    final class TextInputView: NSView, NSTextInputClient {
        override var acceptsFirstResponder: Bool { true }
        func insertText(_ string: Any, replacementRange: NSRange) {}
        func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {}
        func unmarkText() {}
        func selectedRange() -> NSRange { NSRange(location: NSNotFound, length: 0) }
        func markedRange() -> NSRange { NSRange(location: NSNotFound, length: 0) }
        func hasMarkedText() -> Bool { false }
        func attributedSubstring(forProposedRange range: NSRange,
                                 actualRange: NSRangePointer?) -> NSAttributedString? { nil }
        func validAttributesForMarkedText() -> [NSAttributedString.Key] { [] }
        func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect { .zero }
        func characterIndex(for point: NSPoint) -> Int { NSNotFound }
    }

    /// What `NormaCEFCreateBrowser` does, as far as the view tree is concerned: parent a two-deep
    /// spine into the container, with the keystroke-taking view at the bottom. Mirrors the shape the
    /// spike dumped live (`PanelCEFContainerView > CefBrowserHostView > … > RenderWidgetHostViewCocoa`).
    @discardableResult
    private func installFakeCEFTree(in container: PanelCEFContainerView) -> FakeRenderWidgetHostView {
        let shallow = GreedyShallowView()
        container.addSubview(shallow)
        let deep = FakeRenderWidgetHostView()
        shallow.addSubview(deep)
        return deep
    }

    // MARK: - Fixtures

    private var cef = CEFRecorder()
    private var clock = FakeScheduler()

    override func setUp() {
        super.setUp()
        cef = CEFRecorder()
        clock = FakeScheduler()
        PanelWebTabModels.removeAllForTesting()
    }

    override func tearDown() {
        PanelWebTabModels.removeAllForTesting()
        super.tearDown()
    }

    /// A fresh runtime per test. NEVER `BrowserRuntime.shared` — it is process-global and would
    /// carry containers, timers and a parking window into every test that ran afterwards.
    private func makeRuntime() -> BrowserRuntime {
        BrowserRuntime(driver: cef.driver, scheduler: clock.scheduler)
    }

    private func tab(_ tabId: String, url: String? = nil, shown: Bool = false,
                     title: String? = nil) -> BrowserTabState {
        BrowserTabState(tabId: tabId, url: url, isShown: shown, title: title)
    }

    /// One session's tabs, the shape `plan` takes and `apply` is handed back.
    private func tabs(_ sessionId: String, _ states: BrowserTabState...) -> [String: [BrowserTabState]] {
        [sessionId: states]
    }

    /// A host view in a real window. Never ordered in — `makeFirstResponder` does not need a visible
    /// window, and the harness-wide teardown observer sweeps stray VISIBLE windows, so a shown one
    /// would be test pollution.
    private func makeHostView() -> (window: NSWindow, host: NSView) {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 600),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSView(frame: NSRect(x: 0, y: 0, width: 900, height: 600))
        window.contentView = host
        return (window, host)
    }

    // MARK: - Create

    /// The absorbed `makeNSView` sequence, in the order that file wrote it (T4 deleted the original,
    /// so this is now the only copy) — which is load-bearing,
    /// not cosmetic: `NormaCEFSetStateObserver` publishes the current snapshot the moment it is
    /// registered, and `NormaCEFSeedTabState` is what makes that first snapshot the tab's known
    /// address instead of blank (`NormaCEF.h`). Observers, then seed, then create.
    func testCreateWiresTheThreeObserversThenSeedsThenCreates() {
        let runtime = makeRuntime()
        runtime.apply([.create(tabId: "t1", url: "https://example.com")],
                      tabs: tabs("s1", tab("t1", url: "https://example.com", title: "Example")),
                      sessionOf: { _ in "s1" })

        XCTAssertEqual(cef.log, [
            "c1 state=set",
            "c1 nav=set",
            "c1 popup=set",
            "c1 seed url=https://example.com title=Example",
            "c1 create url=https://example.com",
        ])
        XCTAssertTrue(runtime.isLive(tabId: "t1"))
        XCTAssertEqual(runtime.liveTabIds, ["t1"])
    }

    /// Spec §3 and spike Fact 7: the container is in the parking window BEFORE the browser is
    /// created, and a browser created into a parked container loads normally. The window is
    /// borderless and never ordered in — the park mode the spike says to take, because all three
    /// measured identically and this is the simplest (Fact 9).
    func testTheContainerIsParkedInANeverShownBorderlessWindowBeforeCEFIsAsked() {
        let runtime = makeRuntime()
        XCTAssertFalse(runtime.hasParkingWindow, "no browser yet — nothing to park, no window to make")

        runtime.apply([.create(tabId: "t1", url: "https://example.com")],
                      tabs: tabs("s1", tab("t1")), sessionOf: { _ in "s1" })

        XCTAssertTrue(runtime.hasParkingWindow)
        let window = runtime.parkingWindow
        XCTAssertFalse(window.isVisible, "the parking window must never be ordered in")
        XCTAssertTrue(window.styleMask.contains(.borderless))
        let container = runtime.container(forTabId: "t1")
        XCTAssertNotNil(container)
        XCTAssertTrue(container?.window === window, "the container must be in the parking window")
        XCTAssertEqual(container?.frame, window.contentView?.bounds)
    }

    /// **The parked container must be a REAL SIZE before the browser is asked for, and this is the
    /// only moment that can be checked.** `CreateBrowserNow` reads `[parent bounds]` exactly once
    /// and hands it to `CefWindowInfo::SetAsChild` (`NormaCEF.mm`), so the rect a browser is born
    /// with is whatever the container measured at that instant. A tab that is later attached is
    /// rescued by `resizeSubviews(withOldSize:)` — but spec §5's headless browsers, and every one of
    /// B2's, are created parked and may NEVER be attached. At a zero-sized parking window they would
    /// lay out at zero width for life, and every other row in this file would stay green: they
    /// assert the container matches the parking window's bounds, which is just as true at zero.
    func testTheContainerHasARealViewportSizeAtTheMomentTheBrowserIsAskedFor() {
        let runtime = makeRuntime()
        runtime.apply([.create(tabId: "t1", url: "https://example.com")],
                      tabs: tabs("s1", tab("t1")), sessionOf: { _ in "s1" })

        let bounds = cef.boundsAtCreate["c1"]
        XCTAssertNotNil(bounds, "the browser must have been asked for at all")
        XCTAssertEqual(bounds, NSRect(x: 0, y: 0, width: 1280, height: 800))
        XCTAssertTrue((bounds?.width ?? 0) > 0 && (bounds?.height ?? 0) > 0,
                      "a headless browser born into a zero-sized container lays out at zero for life")
    }

    /// **Enforcement point 3, moved here intact.** `PanelWebTab.makeContent()` ran the stored URL
    /// through `PanelURLPolicy.restorableURL` before it could reach a browser, and `makeNSView`
    /// seeded the DISPLAYED address as `""` whenever the policy refused the stored value. Both halves
    /// are the restore door; both are asserted here, because this create path is now the only one.
    func testTheRestoreDoorRefusesEveryDisallowedSchemeAndSeedsNothingForOne() {
        for refused in ["javascript:alert(document.cookie)",
                        "file:///Users/someone/.ssh/id_rsa",
                        "data:text/html,<script>fetch('//evil')</script>",
                        "view-source:https://example.com"] {
            cef = CEFRecorder()
            let runtime = makeRuntime()
            runtime.apply([.create(tabId: "t1", url: refused)],
                          tabs: tabs("s1", tab("t1", url: refused, title: "stored")),
                          sessionOf: { _ in "s1" })

            XCTAssertTrue(cef.log.contains("c1 create url=\(panelWebTabStartPageURL)"),
                          "\(refused) must never reach a browser; the New Tab page loads instead")
            XCTAssertTrue(cef.log.contains("c1 seed url= title=stored"),
                          "\(refused) must not be seeded as the tab's displayed address")
        }
    }

    /// A tab with no URL at all — the daemon mints these — loads the built-in New Tab page and seeds
    /// an empty address, exactly as the view did.
    func testATabWithNoStoredURLLoadsTheNewTabPageAndSeedsNoAddress() {
        let runtime = makeRuntime()
        runtime.apply([.create(tabId: "t1", url: nil)],
                      tabs: tabs("s1", tab("t1", title: "New Tab")), sessionOf: { _ in "s1" })

        XCTAssertTrue(cef.log.contains("c1 create url=\(panelWebTabStartPageURL)"))
        XCTAssertTrue(cef.log.contains("c1 seed url= title=New Tab"))
    }

    /// The seed's SECOND argument is the whole reason `BrowserTabState` carries a title. Seeding
    /// `(url, "")` for a tab whose stored title is known re-opens the restore re-report: the dedupe
    /// memory is the (url, title) PAIR, so the first `OnLoadEnd` after a restore would differ from
    /// the seed and file a `panel_tab_navigated` the log already holds (`NormaCEF.h`).
    func testTheSeedCarriesTheStoredTitleNotAnEmptyOne() {
        let runtime = makeRuntime()
        runtime.apply([.create(tabId: "t1", url: "https://example.com")],
                      tabs: tabs("s1", tab("t1", url: "https://example.com", title: "Example Domain")),
                      sessionOf: { _ in "s1" })

        XCTAssertTrue(cef.log.contains("c1 seed url=https://example.com title=Example Domain"),
                      "log was \(cef.log)")
    }

    /// The model is the SHARED one — the same object `PanelWebChrome` reads — and its session is
    /// bound at CREATE time, exactly as `panelTabContent(for:host:sessionId:)` does today. A model
    /// minted privately here would give the chrome half a different object and the URL field would
    /// never move.
    func testCreateWiresTheTabsSharedModelAndBindsItsSessionAtCreateTime() {
        let runtime = makeRuntime()
        runtime.apply([.create(tabId: "t1", url: "https://example.com")],
                      tabs: tabs("s1", tab("t1")), sessionOf: { tabId in tabId == "t1" ? "s1" : nil })

        let shared = PanelWebTabModels.model(for: PanelTab(tabId: "t1", kind: .web, url: nil, title: nil),
                                             host: nil, sessionId: nil)
        XCTAssertEqual(shared.sessionId, "s1", "bound at create time, not read when a load finishes")
        XCTAssertTrue(shared.container === runtime.container(forTabId: "t1"),
                      "the chrome's verbs reach the browser through this reference")
    }

    /// Routing: each container's state observer must publish into ITS OWN tab's model. Getting this
    /// wrong puts one tab's address in another tab's URL field, and no CEF is needed to prove it.
    ///
    /// `NormaCEFBrowserState`'s properties are readonly in the header and readwrite in the `.mm`, so
    /// the setters exist at runtime and KVC reaches them — the same trick `CEFRuntimeTests` uses to
    /// read that type's values.
    func testEachTabsStateObserverPublishesIntoItsOwnModel() {
        let runtime = makeRuntime()
        runtime.apply([.create(tabId: "t1", url: "https://one.example"),
                       .create(tabId: "t2", url: "https://two.example")],
                      tabs: tabs("s1", tab("t1"), tab("t2")), sessionOf: { _ in "s1" })

        let state = NormaCEFBrowserState()
        state.setValue("https://moved.example", forKey: "url")
        state.setValue("Moved", forKey: "title")
        state.setValue(true, forKey: "canGoBack")
        cef.stateBlocks["c1"]?(state)

        let model1 = PanelWebTabModels.model(for: PanelTab(tabId: "t1", kind: .web, url: nil, title: nil),
                                             host: nil, sessionId: nil)
        let model2 = PanelWebTabModels.model(for: PanelTab(tabId: "t2", kind: .web, url: nil, title: nil),
                                             host: nil, sessionId: nil)
        XCTAssertEqual(model1.url, "https://moved.example")
        XCTAssertEqual(model1.title, "Moved")
        XCTAssertTrue(model1.canGoBack)
        XCTAssertEqual(model2.url, "", "t2's model must not have moved")
    }

    /// **The double-create guard.** The engine's rule 8 re-creates a held session's shown tab on
    /// every plan where it is missing, so a create for a tab that already has one is ordinary
    /// traffic, not a bug — and a second `NormaCEFCreateBrowser` into the same container is a second
    /// live browser nothing will ever close.
    func testASecondCreateForALiveTabIsANoOp() {
        let runtime = makeRuntime()
        let plan: [BrowserAction] = [.create(tabId: "t1", url: "https://example.com")]
        runtime.apply(plan, tabs: tabs("s1", tab("t1")), sessionOf: { _ in "s1" })
        let container = runtime.container(forTabId: "t1")
        let afterFirst = cef.log

        runtime.apply(plan, tabs: tabs("s1", tab("t1")), sessionOf: { _ in "s1" })

        XCTAssertEqual(cef.log, afterFirst, "the second create must reach CEF not at all")
        XCTAssertEqual(cef.log.filter { $0.hasPrefix("c1 create") }.count, 1)
        XCTAssertTrue(runtime.container(forTabId: "t1") === container,
                      "and must not swap the container out from under the live browser")
    }

    /// **The create/stop race the view could not have.** `PanelWebTab.makeNSView` hopped one turn
    /// before `NormaCEFCreateBrowser` and nothing could interleave — `dismantleNSView` cannot beat a
    /// same-turn async. Here a LATER PLAN can: create is queued, the next plan stops the tab, and if
    /// the hop then fired it would create a browser into a container the runtime has already
    /// released — live, observer-less, and closed by nobody for the life of the process.
    func testACreateStoppedBeforeItsHopRunsNeverReachesCEF() {
        clock.autoRun = false
        let runtime = makeRuntime()
        runtime.apply([.create(tabId: "t1", url: "https://example.com")],
                      tabs: tabs("s1", tab("t1")), sessionOf: { _ in "s1" })
        runtime.apply([.stop(tabId: "t1")], tabs: [:], sessionOf: { _ in nil })

        clock.runPendingWork()

        XCTAssertFalse(cef.log.contains { $0.contains("create url=") },
                       "log was \(cef.log)")
        XCTAssertFalse(runtime.isLive(tabId: "t1"))
    }

    /// The unavailable placeholder and its retry door, absorbed whole. A transient
    /// `CefInitialize` failure (Chromium's exclusive profile lock, exit code 24) must leave a
    /// message and a working button, not a permanently blank rectangle.
    func testAFailedInitialisationShowsThePlaceholderAndItsRetryReRunsTheWholeCreatePath() {
        cef.initialises = false
        cef.failure = "CefInitialize failed (24)"
        cef.retryable = true
        let runtime = makeRuntime()
        runtime.apply([.create(tabId: "t1", url: "https://example.com")],
                      tabs: tabs("s1", tab("t1")), sessionOf: { _ in "s1" })

        let container = runtime.container(forTabId: "t1")
        XCTAssertFalse(cef.log.contains { $0.contains("create url=") },
                       "no browser may be created when CEF did not come up")
        let label = container?.subviews.compactMap { $0 as? NSTextField }.first
        XCTAssertTrue(label?.stringValue.contains("CefInitialize failed (24)") == true,
                      "the reason belongs on screen")

        cef.initialises = true
        let button = container?.subviews.compactMap { $0 as? NSButton }.first
        XCTAssertNotNil(button, "a retryable failure must offer the button")
        button?.performClick(nil)

        XCTAssertEqual(cef.clearFailureCount, 1, "a retry must clear the sticky .failed state first")
        XCTAssertTrue(cef.log.contains("c1 create url=https://example.com"),
                      "the retry re-runs the create, not merely a flag reset; log was \(cef.log)")
    }

    /// The retry must not be offered for a failure that can only fail again — after `CefShutdown`,
    /// or under XCTest, where the structural guard exists precisely to keep Chromium out.
    func testAnUnretryableFailureOffersNoButton() {
        cef.initialises = false
        cef.failure = "CEF has been shut down"
        cef.retryable = false
        let runtime = makeRuntime()
        runtime.apply([.create(tabId: "t1", url: "https://example.com")],
                      tabs: tabs("s1", tab("t1")), sessionOf: { _ in "s1" })

        let container = runtime.container(forTabId: "t1")
        XCTAssertEqual(container?.subviews.compactMap { $0 as? NSButton }.count, 0)
        XCTAssertEqual(container?.subviews.compactMap { $0 as? NSTextField }.count, 1)
    }

    // MARK: - Stop

    /// **The pinned order: every observer cleared, THEN the browser closed.** Every block captures
    /// its model weakly, so a late callback is harmless in itself — but a `panel_tab_navigated`
    /// filed by a tab the user has already closed is a permanent line in an append-only log, and a
    /// popup arriving after the close would mint a whole visible tab in the session. Closing first
    /// leaves exactly that window open.
    func testStopClearsEveryObserverBeforeClosingTheBrowser() {
        let runtime = makeRuntime()
        runtime.apply([.create(tabId: "t1", url: "https://example.com")],
                      tabs: tabs("s1", tab("t1")), sessionOf: { _ in "s1" })
        let created = cef.log.count

        runtime.apply([.stop(tabId: "t1")], tabs: [:], sessionOf: { _ in nil })

        XCTAssertEqual(Array(cef.log.dropFirst(created)),
                       ["c1 state=nil", "c1 nav=nil", "c1 popup=nil", "c1 close"])
        XCTAssertNil(cef.stateBlocks["c1"])
        XCTAssertNil(cef.navigationBlocks["c1"])
        XCTAssertNil(cef.popupBlocks["c1"])
    }

    /// The §8 belt stops by `tabId`, and a tabId it names may already be gone (two plans in flight,
    /// a stop the runtime has already applied). A naive executor must not fault on that.
    func testStopOfAnUnknownTabIdIsANoOp() {
        let runtime = makeRuntime()
        runtime.apply([.stop(tabId: "ghost")], tabs: [:], sessionOf: { _ in nil })
        XCTAssertEqual(cef.log, [])
        XCTAssertFalse(runtime.isLive(tabId: "ghost"))
    }

    /// Stop releases the container — which means taking it out of whatever view is holding it. A
    /// stopped container left in a superview is retained by it forever, and a stopped container left
    /// in the PANEL's host view is a dead grey rectangle where a page used to be.
    func testStopUnmountsTheContainerAndForgetsTheTabEntirely() {
        let runtime = makeRuntime()
        runtime.apply([.create(tabId: "t1", url: "https://example.com")],
                      tabs: tabs("s1", tab("t1")), sessionOf: { _ in "s1" })
        let container = runtime.container(forTabId: "t1")
        XCTAssertNotNil(container?.superview)

        runtime.apply([.stop(tabId: "t1")], tabs: [:], sessionOf: { _ in nil })

        XCTAssertNil(container?.superview)
        XCTAssertNil(container?.window)
        XCTAssertFalse(runtime.isLive(tabId: "t1"))
        XCTAssertNil(runtime.container(forTabId: "t1"))
        XCTAssertEqual(runtime.lruOrder, [])
    }

    /// The engine's own contract: "`viewport` … must name a live tab; the runtime clears it when it
    /// stops that browser." A stale viewport would make the next plan believe the panel is already
    /// showing a tab that no longer exists, and no attach would ever be emitted.
    func testStoppingTheViewportTabClearsTheViewport() {
        let (window, host) = makeHostView()
        _ = window
        let runtime = makeRuntime()
        runtime.apply([.create(tabId: "t1", url: "https://example.com")],
                      tabs: tabs("s1", tab("t1", shown: true)), sessionOf: { _ in "s1" })
        runtime.attachViewport(tabId: "t1", into: host)
        XCTAssertEqual(runtime.viewportTabId, "t1")

        runtime.apply([.stop(tabId: "t1")], tabs: [:], sessionOf: { _ in nil })

        XCTAssertNil(runtime.viewportTabId)
    }

    /// **Stopping a BROWSER is not closing a TAB, and the model is where that difference shows.**
    /// `PanelWebTabModels.discard` belongs to `ShellSessionHost.closePanelTab`; calling it here
    /// would blank the chrome of a tab that is still open and still in the strip — the URL field,
    /// the title, the back/forward state would all go empty the moment the linger expired, with the
    /// tab still sitting there. The verbs going quiet is correct — the runtime drops the container,
    /// and the model holds it weakly — but losing the address is not.
    ///
    /// Deliberately does NOT assert that `model.container` has become nil: that is autorelease
    /// timing, not a claim this file gets to make. What is asserted is the thing the runtime
    /// decides — it no longer owns the container — plus everything the model kept.
    func testStoppingABrowserKeepsTheTabsModelAndTheStateItIsShowing() {
        let runtime = makeRuntime()
        runtime.apply([.create(tabId: "t1", url: "https://example.com")],
                      tabs: tabs("s1", tab("t1")), sessionOf: { _ in "s1" })
        let state = NormaCEFBrowserState()
        state.setValue("https://example.com/page", forKey: "url")
        state.setValue("A Page", forKey: "title")
        cef.stateBlocks["c1"]?(state)
        let before = PanelWebTabModels.model(for: PanelTab(tabId: "t1", kind: .web, url: nil, title: nil),
                                             host: nil, sessionId: nil)

        runtime.apply([.stop(tabId: "t1")], tabs: [:], sessionOf: { _ in nil })

        let after = PanelWebTabModels.model(for: PanelTab(tabId: "t1", kind: .web, url: nil, title: nil),
                                            host: nil, sessionId: nil)
        XCTAssertTrue(after === before, "a stop must not discard the tab's model — the tab still exists")
        XCTAssertEqual(after.url, "https://example.com/page", "nor the address it was last on")
        XCTAssertEqual(after.title, "A Page")
        XCTAssertEqual(after.sessionId, "s1")
        XCTAssertNil(runtime.container(forTabId: "t1"), "only the browser is gone, and the owner let go")
    }

    // MARK: - Viewport

    /// Spike Fact 5: ONE `addSubview`, never `removeFromSuperview` first — the "in a window at all
    /// times" invariant is what was measured, and `addSubview` already re-parents a view that has a
    /// superview. Fact 4: setting the container's frame after `addSubview` is all the resize needs.
    func testAttachMovesTheContainerIntoTheHostAndSizesItToIt() {
        let (window, host) = makeHostView()
        let runtime = makeRuntime()
        runtime.apply([.create(tabId: "t1", url: "https://example.com")],
                      tabs: tabs("s1", tab("t1", shown: true)), sessionOf: { _ in "s1" })
        let container = runtime.container(forTabId: "t1")
        XCTAssertNotNil(container)
        XCTAssertTrue(container?.window === runtime.parkingWindow)

        runtime.attachViewport(tabId: "t1", into: host)

        XCTAssertTrue(container?.superview === host)
        XCTAssertTrue(container?.window === window)
        XCTAssertEqual(container?.frame, host.bounds)
        XCTAssertEqual(container?.autoresizingMask, [.width, .height])
        XCTAssertEqual(runtime.viewportTabId, "t1")
    }

    /// **Spike Fact 2, the silent one.** A reparent destroys first-responder status and attaching
    /// does not restore it, so the shown tab takes zero keystrokes unless the host does this itself
    /// — and `makeFirstResponder` on the wrong view SUCCEEDS and then delivers nothing. The greedy
    /// shallow view here is the wrong answer made reachable: it accepts first-responder status, sits
    /// where `container.subviews.first` and `GetWindowHandle()` point, and is not the view that can
    /// take a key.
    func testAttachMakesTheKeystrokeTakingDescendantFirstResponderNotTheShallowOne() {
        var deep: FakeRenderWidgetHostView?
        cef.onCreate = { [unowned self] container, _ in deep = self.installFakeCEFTree(in: container) }
        let (window, host) = makeHostView()
        let runtime = makeRuntime()
        runtime.apply([.create(tabId: "t1", url: "https://example.com")],
                      tabs: tabs("s1", tab("t1", shown: true)), sessionOf: { _ in "s1" })

        runtime.attachViewport(tabId: "t1", into: host)

        XCTAssertNotNil(deep)
        XCTAssertTrue(window.firstResponder === deep,
                      "first responder was \(String(describing: window.firstResponder))")
    }

    /// **Create and attach in the same plan** — a session waking up on its shown tab. The attach
    /// runs first (the engine's order: there is no container to mount before the browser exists, and
    /// the container exists the instant `.create` is applied), but CEF's view arrives a turn later,
    /// so the attach finds nothing to focus. Without the second restore after the create, that tab
    /// takes no keystrokes until the user clicks into the page.
    func testATabCreatedAndAttachedInOnePlanStillGetsItsFirstResponderOnceCEFArrives() {
        var deep: FakeRenderWidgetHostView?
        cef.onCreate = { [unowned self] container, _ in deep = self.installFakeCEFTree(in: container) }
        clock.autoRun = false
        let (window, host) = makeHostView()
        let runtime = makeRuntime()
        runtime.attachViewport(tabId: "t1", into: host)   // registers the panel's host; mounts nothing

        runtime.apply([.create(tabId: "t1", url: "https://example.com"),
                       .attachViewport(tabId: "t1")],
                      tabs: tabs("s1", tab("t1", shown: true)), sessionOf: { _ in "s1" })
        XCTAssertEqual(runtime.viewportTabId, "t1", "the container is mounted even though CEF is not in it")
        XCTAssertNil(deep, "the create has not run yet")

        clock.runPendingWork()

        XCTAssertNotNil(deep)
        XCTAssertTrue(window.firstResponder === deep,
                      "first responder was \(String(describing: window.firstResponder))")
    }

    /// The search itself, isolated from the mounting. The class name wins outright when it is
    /// present — the shallow greedy view and a stray `NSTextInputClient` conformer are both
    /// candidates by weaker rules and neither may be chosen.
    func testTheResponderSearchPrefersTheChromiumClassNameOverEveryWeakerCandidate() {
        let container = PanelCEFContainerView()
        let shallow = GreedyShallowView()
        container.addSubview(shallow)
        let stray = TextInputView()
        container.addSubview(stray)
        let deep = FakeRenderWidgetHostView()
        shallow.addSubview(deep)

        let found = BrowserRuntime.findKeyboardResponder(in: container)
        XCTAssertTrue(found.view === deep)
        XCTAssertEqual(found.matchedBy, .className)
        XCTAssertEqual(found.count, 1)
    }

    /// The durable fallback, and the two counts the spike says to log loudly. Chromium's view tree
    /// "is not Norma's to promise": zero matches means nobody can type, more than one means the
    /// choice is a guess — both are reported rather than silently absorbed.
    func testTheResponderSearchFallsBackToTextInputConformanceAndReportsZeroAndMany() {
        let empty = PanelCEFContainerView()
        empty.addSubview(GreedyShallowView())
        let none = BrowserRuntime.findKeyboardResponder(in: empty)
        XCTAssertNil(none.view)
        XCTAssertEqual(none.matchedBy, .none)
        XCTAssertEqual(none.count, 0)

        let one = PanelCEFContainerView()
        let onlyConformer = TextInputView()
        one.addSubview(GreedyShallowView())
        one.subviews[0].addSubview(onlyConformer)
        let fallback = BrowserRuntime.findKeyboardResponder(in: one)
        XCTAssertTrue(fallback.view === onlyConformer)
        XCTAssertEqual(fallback.matchedBy, .textInputClient)
        XCTAssertEqual(fallback.count, 1)

        let many = PanelCEFContainerView()
        many.addSubview(TextInputView())
        let deeper = TextInputView()
        many.subviews[0].addSubview(deeper)
        let ambiguous = BrowserRuntime.findKeyboardResponder(in: many)
        XCTAssertEqual(ambiguous.count, 2)
        XCTAssertTrue(ambiguous.view === deeper, "the deepest match is the tiebreak the spike measured")
    }

    /// Detach is the other half of the move: back to the parking window, in one `addSubview`, with
    /// the browser untouched. The engine emits it before every stop and before every viewport swap.
    func testDetachParksTheContainerBackInTheParkingWindow() {
        let (window, host) = makeHostView()
        _ = window
        let runtime = makeRuntime()
        runtime.apply([.create(tabId: "t1", url: "https://example.com")],
                      tabs: tabs("s1", tab("t1", shown: true)), sessionOf: { _ in "s1" })
        runtime.attachViewport(tabId: "t1", into: host)
        let container = runtime.container(forTabId: "t1")

        runtime.detachViewport(tabId: "t1")

        XCTAssertTrue(container?.window === runtime.parkingWindow)
        XCTAssertNil(runtime.viewportTabId)
        XCTAssertTrue(runtime.isLive(tabId: "t1"), "detach never stops a browser — that is the point")
        XCTAssertFalse(cef.log.contains("c1 close"))
    }

    /// Attach for a tab with no live browser mounts nothing and claims nothing. Claiming the
    /// viewport here would tell the next plan the panel is showing a tab it is not, and the attach
    /// would never be re-emitted.
    func testAttachOfATabWithNoLiveBrowserClaimsNothing() {
        let (window, host) = makeHostView()
        _ = window
        let runtime = makeRuntime()
        runtime.attachViewport(tabId: "t1", into: host)
        XCTAssertNil(runtime.viewportTabId)
        XCTAssertEqual(host.subviews.count, 0)
    }

    /// The `.attachViewport` ACTION carries no host — the panel supplies that through
    /// `attachViewport(tabId:into:)`. Before the panel has ever mounted one there is nowhere to put
    /// the container, so the action mounts nothing and leaves the viewport unclaimed, which is what
    /// makes the next plan re-emit it (the engine emits attach whenever `viewport != desired`).
    func testAnAttachActionBeforeThePanelHasAHostLeavesTheViewportUnclaimed() {
        let runtime = makeRuntime()
        runtime.apply([.create(tabId: "t1", url: "https://example.com"),
                       .attachViewport(tabId: "t1")],
                      tabs: tabs("s1", tab("t1", shown: true)), sessionOf: { _ in "s1" })
        XCTAssertNil(runtime.viewportTabId)

        let (window, host) = makeHostView()
        _ = window
        runtime.attachViewport(tabId: "t1", into: host)
        XCTAssertEqual(runtime.viewportTabId, "t1")

        // With a host now registered, the ACTION alone moves the viewport — no second call from the
        // panel is needed for a session hop.
        runtime.apply([.create(tabId: "t2", url: "https://two.example"),
                       .detachViewport(tabId: "t1"), .attachViewport(tabId: "t2")],
                      tabs: tabs("s1", tab("t1"), tab("t2", shown: true)), sessionOf: { _ in "s1" })
        XCTAssertEqual(runtime.viewportTabId, "t2")
        XCTAssertTrue(runtime.container(forTabId: "t2")?.superview === host)
        XCTAssertTrue(runtime.container(forTabId: "t1")?.window === runtime.parkingWindow)
    }

    // MARK: - The linger timers

    /// `scheduleStop` arms at the engine's deadline — the engine's clock reading plus its own
    /// linger, never one the executor computes.
    func testScheduleStopArmsATimerAtTheEnginesDeadline() {
        let runtime = makeRuntime()
        let deadline = clock.current.addingTimeInterval(300)
        runtime.apply([.scheduleStop(sessionId: "s1", at: deadline)], tabs: [:], sessionOf: { _ in nil })

        XCTAssertEqual(clock.liveTimers.count, 1)
        XCTAssertEqual(clock.liveTimers.first?.fireAt, deadline)
        XCTAssertEqual(runtime.pendingStopDeadlines, ["s1": deadline])
    }

    /// **The executor obligation the engine spells out**: "a timer that fires early — a clock
    /// adjustment, a sleep/wake — must re-arm rather than be dropped, or the stop is stranded and
    /// the browsers live forever." An early fire asks for nothing and re-arms at the SAME deadline:
    /// moving the deadline forward would make the next plan see it unexpired and say nothing at all.
    func testAnEarlyTimerFireReArmsAtTheSameDeadlineAndAsksForNothing() {
        var replans: [String] = []
        let runtime = makeRuntime()
        runtime.onLingerDeadline = { replans.append($0) }
        let deadline = clock.current.addingTimeInterval(300)
        runtime.apply([.scheduleStop(sessionId: "s1", at: deadline)], tabs: [:], sessionOf: { _ in nil })

        clock.fire(1)   // the run loop fires 300s early

        XCTAssertEqual(replans, [], "an early fire is not a deadline; nothing may be asked of the engine")
        XCTAssertEqual(clock.liveTimers.count, 1, "and the timer must still be armed")
        XCTAssertEqual(clock.liveTimers.first?.fireAt, deadline)
        XCTAssertEqual(runtime.pendingStopDeadlines, ["s1": deadline],
                       "the deadline itself must not move — the engine compares against it")
    }

    /// The ordinary fire: the deadline has passed, so the executor asks for a re-plan — and the
    /// engine, not the executor, decides the stop. The deadline STAYS until a `cancelScheduledStop`
    /// arrives, which is the same obligation read from the other end.
    func testATimerThatFiresOnTimeAsksForAReplanAndKeepsTheDeadlineUntilCancelled() {
        var replans: [String] = []
        let runtime = makeRuntime()
        runtime.onLingerDeadline = { replans.append($0) }
        let deadline = clock.current.addingTimeInterval(300)
        runtime.apply([.scheduleStop(sessionId: "s1", at: deadline)], tabs: [:], sessionOf: { _ in nil })

        clock.current = deadline.addingTimeInterval(1)
        clock.fire(1)

        XCTAssertEqual(replans, ["s1"])
        XCTAssertEqual(runtime.pendingStopDeadlines, ["s1": deadline],
                       "no cancel was seen, so the deadline is still owed")
        XCTAssertEqual(clock.liveTimers.count, 1, "and a fresh recheck timer keeps it from being stranded")
        XCTAssertEqual(clock.liveTimers.first?.fireAt,
                       clock.current.addingTimeInterval(BrowserRuntime.lingerRecheckInterval))
    }

    /// A re-plan that answers the fire by cancelling ends the whole cycle — no recheck timer is left
    /// behind. This is the shape the engine actually produces: stops plus `cancelScheduledStop`.
    func testAReplanThatCancelsDuringTheFireLeavesNoTimerBehind() {
        let runtime = makeRuntime()
        runtime.onLingerDeadline = { [unowned runtime] sessionId in
            runtime.apply([.stop(tabId: "t1"), .cancelScheduledStop(sessionId: sessionId)],
                          tabs: [:], sessionOf: { _ in nil })
        }
        let deadline = clock.current.addingTimeInterval(300)
        runtime.apply([.create(tabId: "t1", url: "https://example.com"),
                       .scheduleStop(sessionId: "s1", at: deadline)],
                      tabs: tabs("s1", tab("t1")), sessionOf: { _ in "s1" })

        clock.current = deadline.addingTimeInterval(1)
        clock.fire(1)

        XCTAssertEqual(runtime.pendingStopDeadlines, [:])
        XCTAssertEqual(clock.liveTimers.count, 0)
        XCTAssertFalse(runtime.isLive(tabId: "t1"))
    }

    /// `cancelScheduledStop` means forget the deadline, in both of the cases the engine emits it
    /// for — a signal returning, and a deadline just consumed. The timer goes with it, and a stale
    /// fire afterwards must do nothing.
    func testCancelScheduledStopForgetsTheDeadlineAndTheTimerAndSurvivesAStaleFire() {
        var replans: [String] = []
        let runtime = makeRuntime()
        runtime.onLingerDeadline = { replans.append($0) }
        let deadline = clock.current.addingTimeInterval(300)
        runtime.apply([.scheduleStop(sessionId: "s1", at: deadline)], tabs: [:], sessionOf: { _ in nil })
        runtime.apply([.cancelScheduledStop(sessionId: "s1")], tabs: [:], sessionOf: { _ in nil })

        XCTAssertEqual(runtime.pendingStopDeadlines, [:])
        XCTAssertEqual(clock.cancelled, [1])

        clock.current = deadline.addingTimeInterval(1)
        clock.fire(1)   // a timer already in flight when the cancel landed
        XCTAssertEqual(replans, [], "a cancelled linger must not ask for anything, ever")
    }

    /// **The other half of the obligation**: "a plan that finds an UNEXPIRED pending deadline emits
    /// nothing at all for that session". Applying such a plan must therefore leave the timer exactly
    /// where it was — an executor that re-derived its timers from each plan would drop it.
    func testAPlanThatSaysNothingAboutAnArmedSessionLeavesItsTimerArmed() {
        let runtime = makeRuntime()
        let deadline = clock.current.addingTimeInterval(300)
        runtime.apply([.scheduleStop(sessionId: "s1", at: deadline)], tabs: [:], sessionOf: { _ in nil })

        runtime.apply([], tabs: tabs("s1", tab("t9")), sessionOf: { _ in "s1" })

        XCTAssertEqual(runtime.pendingStopDeadlines, ["s1": deadline])
        XCTAssertEqual(clock.liveTimers.count, 1)
        XCTAssertEqual(clock.cancelled, [])
    }

    /// Naive by contract: a second `scheduleStop` for an armed session replaces the timer rather
    /// than leaving two. The engine never emits this today; the executor does not get to assume so.
    func testASecondScheduleStopReplacesTheTimerRatherThanLeavingTwo() {
        let runtime = makeRuntime()
        let first = clock.current.addingTimeInterval(300)
        let second = clock.current.addingTimeInterval(600)
        runtime.apply([.scheduleStop(sessionId: "s1", at: first)], tabs: [:], sessionOf: { _ in nil })
        runtime.apply([.scheduleStop(sessionId: "s1", at: second)], tabs: [:], sessionOf: { _ in nil })

        XCTAssertEqual(runtime.pendingStopDeadlines, ["s1": second])
        XCTAssertEqual(clock.cancelled, [1])
        XCTAssertEqual(clock.liveTimers.map(\.fireAt), [second])
    }

    func testCancelScheduledStopForAnUnknownSessionIsANoOp() {
        let runtime = makeRuntime()
        runtime.apply([.cancelScheduledStop(sessionId: "nobody")], tabs: [:], sessionOf: { _ in nil })
        XCTAssertEqual(runtime.pendingStopDeadlines, [:])
        XCTAssertEqual(clock.cancelled, [])
    }

    // MARK: - Executor discipline

    /// **The order is the engine's, and the executor is naive by design.** Two of the orderings are
    /// hard contracts (`BrowserLifecycle.swift`, "The order"): detach precedes every stop, because
    /// stopping a browser whose container is still mounted destroys a live subview of a visible
    /// window; and create precedes attach, because there is no container to mount before the browser
    /// exists. A run of a whole session-hop plan, asserted end to end.
    func testAWholeSessionHopPlanIsAppliedVerbatimInTheOrderGiven() {
        let (window, host) = makeHostView()
        _ = window
        let runtime = makeRuntime()
        runtime.apply([.create(tabId: "old", url: "https://old.example")],
                      tabs: tabs("s1", tab("old", shown: true)), sessionOf: { _ in "s1" })
        runtime.attachViewport(tabId: "old", into: host)
        let baseline = cef.log.count

        // Exactly the shape `plan` returns: detach + stops + creates + attach + bookkeeping.
        runtime.apply([.detachViewport(tabId: "old"),
                       .stop(tabId: "old"),
                       .create(tabId: "new", url: "https://new.example"),
                       .attachViewport(tabId: "new"),
                       .cancelScheduledStop(sessionId: "s2")],
                      tabs: tabs("s2", tab("new", url: "https://new.example", shown: true)),
                      sessionOf: { _ in "s2" })

        XCTAssertEqual(Array(cef.log.dropFirst(baseline)), [
            "c1 state=nil", "c1 nav=nil", "c1 popup=nil", "c1 close",
            "c2 state=set", "c2 nav=set", "c2 popup=set",
            "c2 seed url=https://new.example title=",
            "c2 create url=https://new.example",
        ])
        XCTAssertEqual(runtime.viewportTabId, "new")
        XCTAssertTrue(runtime.container(forTabId: "new")?.superview === host)
        XCTAssertFalse(runtime.isLive(tabId: "old"))
    }

    /// The LRU order the cap consumes (`plan`'s `lruOrder`, least-recently-used FIRST). A tab is
    /// "used" when it is created and when it takes the viewport; stopping one drops it. Mirrors the
    /// `Sim` in `BrowserLifecycleTests`, which is where the engine's own rows assume this shape.
    func testLruOrderIsTouchedOnCreateAndOnAttachAndDroppedOnStop() {
        let (window, host) = makeHostView()
        _ = window
        let runtime = makeRuntime()
        runtime.apply([.create(tabId: "t1", url: "https://one.example"),
                       .create(tabId: "t2", url: "https://two.example"),
                       .create(tabId: "t3", url: "https://three.example")],
                      tabs: tabs("s1", tab("t1"), tab("t2"), tab("t3")), sessionOf: { _ in "s1" })
        XCTAssertEqual(runtime.lruOrder, ["t1", "t2", "t3"])

        runtime.attachViewport(tabId: "t1", into: host)
        XCTAssertEqual(runtime.lruOrder, ["t2", "t3", "t1"], "showing a tab makes it the most recent")

        runtime.apply([.stop(tabId: "t2")], tabs: [:], sessionOf: { _ in nil })
        XCTAssertEqual(runtime.lruOrder, ["t3", "t1"])
    }

    /// `isLive` is B2's whole view of the runtime — view-free by construction (spec §5): a browser's
    /// existence is independent of whether anything is mounted anywhere.
    func testIsLiveIsIndependentOfTheViewport() {
        let (window, host) = makeHostView()
        _ = window
        let runtime = makeRuntime()
        runtime.apply([.create(tabId: "parked", url: "https://a.example"),
                       .create(tabId: "shown", url: "https://b.example")],
                      tabs: tabs("s1", tab("parked"), tab("shown", shown: true)), sessionOf: { _ in "s1" })
        runtime.attachViewport(tabId: "shown", into: host)

        XCTAssertTrue(runtime.isLive(tabId: "parked"), "headless is not a mode — it is a parked container")
        XCTAssertTrue(runtime.isLive(tabId: "shown"))
        XCTAssertFalse(runtime.isLive(tabId: "never-created"))
    }
}
