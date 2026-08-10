import AppKit
import XCTest
@testable import Norma

/// browser-runtime T4: **the view side of the ownership inversion** (spec §2).
///
/// `BrowserRuntimeTests` proves the runtime executes what it is handed. This file proves the panel
/// stopped owning anything: that `PanelViewport`'s host view borrows a runtime-owned container and
/// gives it back, that dismantling one reaches CEF not at all, and that the keyboard survives the
/// one gap SwiftUI's own ordering opens (`makeNSView` runs before the view joins a window).
///
/// **The doubles are `BrowserRuntimeTests`', deliberately, not copies.** `CEFRecorder`,
/// `FakeScheduler` and the two fake view classes are that file's nested types; re-declaring them
/// here would fork the recorder's transcript format from the assertions written against it, and
/// `FakeRenderWidgetHostView` in particular is `@objc(RenderWidgetHostViewCocoa)` — a second class
/// claiming the Objective-C name the runtime matches on would be a runtime collision, not a
/// duplicate.
///
/// **What no test here covers:** that CEF, once really running, keeps rendering across the reparent.
/// That is not testable in this process at all (spec §9: no CEF client override is callable under
/// XCTest) and is not assumed either — Task 1's spike measured it in the real app, 138 reparents
/// across 9 runs (`docs/research/2026-08-10-cef-reparent-spike.md`).
@MainActor
final class PanelViewportTests: XCTestCase {

    private var cef = BrowserRuntimeTests.CEFRecorder()
    private var clock = BrowserRuntimeTests.FakeScheduler()
    private var runtime: BrowserRuntime!

    override func setUp() {
        super.setUp()
        cef = BrowserRuntimeTests.CEFRecorder()
        clock = BrowserRuntimeTests.FakeScheduler()
        // Never `BrowserRuntime.shared`: it is process-global and would carry containers, timers and
        // a window into every test that ran afterwards.
        runtime = BrowserRuntime(driver: cef.driver, scheduler: clock.scheduler)
        PanelWebTabModels.removeAllForTesting()
    }

    override func tearDown() {
        PanelWebTabModels.removeAllForTesting()
        runtime = nil
        super.tearDown()
    }

    // MARK: - Fixtures

    private func webTab(_ tabId: String, url: String? = nil, title: String? = nil) -> PanelTab {
        PanelTab(tabId: tabId, kind: .web, url: url, title: title)
    }

    /// A viewport host view exactly as `PanelViewport.makeNSView` builds one, at a real size (the
    /// frame is SwiftUI's job in the app, and a zero-sized host would make the attach's
    /// `frame = host.bounds` unfalsifiable).
    private func makeHostView(_ tab: PanelTab, sessionId: String? = "s1",
                              host: ShellSessionHost? = nil) -> PanelViewportHostView {
        let view = PanelViewportHostView(tab: tab, runtime: runtime, sessionId: sessionId, host: host)
        view.frame = NSRect(x: 0, y: 0, width: 900, height: 600)
        return view
    }

    /// A window that is never ordered in — `makeFirstResponder` does not need a visible window, and
    /// the harness-wide teardown observer sweeps stray VISIBLE windows, so showing one would be test
    /// pollution.
    private func makeWindow() -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 600),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSView(frame: NSRect(x: 0, y: 0, width: 900, height: 600))
        return window
    }

    /// What `NormaCEFCreateBrowser` does as far as the view tree is concerned: parent a two-deep
    /// spine into the container with the keystroke-taking view at the bottom, mirroring the shape the
    /// spike dumped live. The box is how a test reaches the view CEF would have made.
    private final class DeepViewBox {
        var view: NSView?
    }

    @discardableResult
    private func installFakeCEFTreeOnCreate() -> DeepViewBox {
        let box = DeepViewBox()
        cef.onCreate = { container, _ in
            let shallow = BrowserRuntimeTests.GreedyShallowView()
            container.addSubview(shallow)
            let deep = BrowserRuntimeTests.FakeRenderWidgetHostView()
            shallow.addSubview(deep)
            box.view = deep
        }
        return box
    }

    // MARK: - The third responder door

    /// **The gap SwiftUI's own ordering opens, and the door that closes it** (T3 review Minor-1).
    ///
    /// A reparent destroys first-responder status and `attachViewport` restores it (spike Fact 2) —
    /// but only in a window, and SwiftUI runs `makeNSView` BEFORE the view it returns joins one. That
    /// first attach therefore lands on `restoreFirstResponder`'s "container is in no window yet"
    /// exit and writes a log line instead. Nothing else covers the ordinary case of a panel opening
    /// on a live browser: the runtime's other two restores fire on a later plan's `.attachViewport`
    /// and after a create, neither of which happens here.
    ///
    /// Without `viewDidMoveToWindow` the panel shows the page and accepts **zero keystrokes** — the
    /// failure the spike calls silently breakable, since every other signal (the page renders, the
    /// container is mounted, the tree is right) looks green.
    func testTheHostViewRestoresTheKeyboardWhenItJoinsAWindow() throws {
        let deep = installFakeCEFTreeOnCreate()
        let hostView = makeHostView(webTab("t1", url: "https://example.com"))

        hostView.attachToRuntime()   // what `makeNSView` does, and where SwiftUI leaves it

        let container = try XCTUnwrap(runtime.container(forTabId: "t1"))
        XCTAssertTrue(container.superview === hostView, "the container mounts with or without a window")
        XCTAssertNil(hostView.window, "the premise: SwiftUI has not put this view in a window yet")
        XCTAssertNil(try XCTUnwrap(deep.view).window,
                     "so nothing in the page could have been made first responder")

        let window = makeWindow()
        XCTAssertFalse(window.firstResponder === deep.view,
                       "the discriminator — a window starts as its own first responder")

        window.contentView?.addSubview(hostView)   // SwiftUI's very next move

        XCTAssertTrue(window.firstResponder === deep.view,
                      "joining a window did not re-attach: the panel is showing a page that cannot "
                          + "take a keystroke, and the only trace is one line in the log")
        XCTAssertEqual(container.frame, hostView.bounds,
                       "and the re-attach re-sizes the container to its host, as every attach does")
    }

    /// The same door is what re-restores the keyboard when the shell's panel moves between windows —
    /// the second window join is not a special case, it is the same call.
    func testMovingTheHostBetweenWindowsRestoresTheKeyboardInTheNewOne() throws {
        let deep = installFakeCEFTreeOnCreate()
        let hostView = makeHostView(webTab("t1", url: "https://example.com"))
        hostView.attachToRuntime()

        let first = makeWindow()
        first.contentView?.addSubview(hostView)
        XCTAssertTrue(first.firstResponder === deep.view)

        let second = makeWindow()
        second.contentView?.addSubview(hostView)

        XCTAssertTrue(second.firstResponder === deep.view,
                      "the page moved to another window and stopped accepting keystrokes there")
        XCTAssertTrue(try XCTUnwrap(runtime.container(forTabId: "t1")).window === second,
                      "and the container went with it")
    }

    // MARK: - Dismantle

    /// **Dismantling a viewport reaches CEF not at all** — the commit where "closing is no longer the
    /// view's business" becomes true.
    ///
    /// What stood in `dismantleNSView` cleared the three observers and called `NormaCEFCloseBrowser`,
    /// justified as keeping a switched-away tab from leaving a live renderer behind. A switched-away
    /// tab is now SUPPOSED to leave one behind: that is the inversion, and it is what makes a tab
    /// switch a container swap instead of a page reload. Stopping is `BrowserLifecycleEngine`'s
    /// decision and `BrowserRuntime.stop`'s execution, on signals this view cannot see.
    ///
    /// Asserted as "the whole transcript is unchanged" rather than "no close": a dismantle that
    /// cleared the observers, or seeded, or created anything would be just as wrong, and this cannot
    /// pass by naming only the call someone happened to think of.
    func testDismantleParksTheContainerAndNeverStopsTheBrowser() throws {
        installFakeCEFTreeOnCreate()
        let hostView = makeHostView(webTab("t1", url: "https://example.com"))
        let window = makeWindow()
        window.contentView?.addSubview(hostView)
        hostView.attachToRuntime()

        let container = try XCTUnwrap(runtime.container(forTabId: "t1"))
        let transcript = cef.log

        PanelViewport.dismantleNSView(hostView, coordinator: ())

        XCTAssertEqual(cef.log, transcript,
                       "dismantling a viewport must reach CEF not at all — log was \(cef.log)")
        XCTAssertTrue(runtime.isLive(tabId: "t1"),
                      "the browser must survive the view that was showing it")
        XCTAssertTrue(runtime.container(forTabId: "t1") === container,
                      "and it must be the SAME container — a new one is a reloaded page")
        XCTAssertTrue(container.window === runtime.parkingWindow,
                      "parked in the runtime's own window, not left in a host nothing shows")
        XCTAssertNil(runtime.viewportTabId, "nothing is mounted in the panel any more")
        XCTAssertNotNil(cef.stateBlocks["c1"], "a stop would have cleared the observers; this is not one")
        XCTAssertNotNil(cef.navigationBlocks["c1"])
        XCTAssertNotNil(cef.popupBlocks["c1"])
    }

    /// **A host view SwiftUI has finished with is not the viewport holder any more.** `viewDidMoveTo
    /// Window` fires on any window join, including one that reaches a dismantled view (AppKit moves
    /// views for reasons SwiftUI does not narrate) — and a re-attach from there would take the
    /// container away from whoever holds it now and mount it in a rectangle nothing is showing.
    func testAHostViewSwiftUIHasDismantledNeverTakesTheViewportBack() throws {
        installFakeCEFTreeOnCreate()
        let hostView = makeHostView(webTab("t1", url: "https://example.com"))
        hostView.attachToRuntime()
        let container = try XCTUnwrap(runtime.container(forTabId: "t1"))

        PanelViewport.dismantleNSView(hostView, coordinator: ())
        makeWindow().contentView?.addSubview(hostView)   // the late join

        XCTAssertNil(runtime.viewportTabId,
                     "a dismantled host view claimed the viewport back")
        XCTAssertTrue(container.window === runtime.parkingWindow,
                      "and dragged the container out of the parking window to do it")
    }

    /// **The headline property of the whole plan, at the view layer:** switching away from a tab and
    /// back is a container swap. Nothing is created, nothing is closed, and the page the user comes
    /// back to is the same object — with its scroll position, its video, its form text and its JS
    /// heap, none of which any test in this process can see, all of which live in that container.
    func testSwitchingAwayAndBackCreatesNothingAndClosesNothing() throws {
        installFakeCEFTreeOnCreate()
        let tab = webTab("t1", url: "https://example.com")
        let window = makeWindow()

        let first = makeHostView(tab)
        window.contentView?.addSubview(first)
        first.attachToRuntime()
        let container = try XCTUnwrap(runtime.container(forTabId: "t1"))

        // The switch away, then the switch back: SwiftUI dismantles one host view and builds
        // another, because `ShellPanel`'s content slot is `.id`'d by tab.
        PanelViewport.dismantleNSView(first, coordinator: ())
        let second = makeHostView(tab)
        window.contentView?.addSubview(second)
        second.attachToRuntime()

        XCTAssertEqual(cef.log.filter { $0.contains("create url=") }.count, 1,
                       "a second create is a reloaded page: \(cef.log)")
        XCTAssertFalse(cef.log.contains { $0.hasSuffix(" close") }, "log was \(cef.log)")
        XCTAssertTrue(runtime.container(forTabId: "t1") === container,
                      "the user came back to a different browser")
        XCTAssertTrue(container.superview === second, "mounted in the view that is on screen now")
        XCTAssertEqual(runtime.viewportTabId, "t1")
    }

    // MARK: - The temporary bridge (Task 5 deletes it)

    /// **The bridge asks for a browser once per tab and never again** — `ensureLive` forwards to the
    /// runtime's create, whose own double-create guard is what makes every later attach a no-op.
    /// Both later attaches are real paths, not hypotheticals: the window join happens on every tab
    /// open, and the second host view happens on every switch back.
    ///
    /// This whole block is scaffolding between T4 and Task 5, which replaces it with the engine's
    /// `.create` actions — but while it exists, a second `NormaCEFCreateBrowser` into the same
    /// container would be a second live browser that nothing can ever close, because the registry
    /// remembers one container per tab.
    func testTheBridgeAsksForABrowserOnceAndOnlyOnce() {
        installFakeCEFTreeOnCreate()
        let tab = webTab("t1", url: "https://example.com")
        let hostView = makeHostView(tab)

        hostView.attachToRuntime()
        XCTAssertEqual(cef.log.filter { $0.contains("create url=") }.count, 1,
                       "the panel would paint an empty rectangle: \(cef.log)")

        makeWindow().contentView?.addSubview(hostView)   // the window-join attach
        makeHostView(tab).attachToRuntime()              // the switch-back attach

        XCTAssertEqual(cef.log.filter { $0.contains("create url=") }.count, 1,
                       "asked for a second browser in the same tab: \(cef.log)")
    }

    /// And it asks for nothing at all when the browser is already live — the shape every attach will
    /// have once Task 5's engine is the one creating them.
    func testTheBridgeAsksForNothingWhenTheBrowserAlreadyExists() {
        installFakeCEFTreeOnCreate()
        runtime.apply([.create(tabId: "t1", url: "https://example.com")],
                      tabs: ["s1": [BrowserTabState(tabId: "t1", url: "https://example.com",
                                                    isShown: true, title: "Example")]],
                      sessionOf: { _ in "s1" })
        let transcript = cef.log

        let hostView = makeHostView(webTab("t1", url: "https://example.com"))
        makeWindow().contentView?.addSubview(hostView)
        hostView.attachToRuntime()

        XCTAssertEqual(cef.log, transcript,
                       "attaching a viewport to a live browser must reach CEF not at all: \(cef.log)")
        XCTAssertEqual(runtime.viewportTabId, "t1", "and must still mount it")
    }

    /// **Enforcement point 3, through the path a user actually takes.** The viewport hands the tab's
    /// STORED url straight through — filtering moved to `BrowserRuntime.create`, which is the one
    /// path every browser is born on, headless ones included — so this is what proves the view path
    /// reaches that filter rather than routing around it. A stored `javascript:` URL would otherwise
    /// be re-executed against the page on every restore, for as long as the session exists, which is
    /// forever: sessions are user-delete-only.
    ///
    /// Replaces `PanelWebChromeTests.testAWebTabWithAHostileStoredURLResolvesToTheStartPage`, which
    /// pinned the same door back when `makeContent()` was the one applying it.
    func testAStoredHostileURLNeverReachesCEFThroughTheViewport() {
        for hostile in ["javascript:alert(document.cookie)",
                        "file:///Users/someone/.ssh/id_rsa",
                        "data:text/html,<script>fetch('//evil')</script>"] {
            cef = BrowserRuntimeTests.CEFRecorder()
            runtime = BrowserRuntime(driver: cef.driver, scheduler: clock.scheduler)
            PanelWebTabModels.removeAllForTesting()

            makeHostView(webTab("t1", url: hostile, title: "stored")).attachToRuntime()

            XCTAssertTrue(cef.log.contains("c1 create url=\(panelWebTabStartPageURL)"),
                          "\(hostile) reached a real Chromium browser: \(cef.log)")
            XCTAssertTrue(cef.log.contains("c1 seed url= title=stored"),
                          "and the address bar must show nothing rather than the refused value: "
                              + "\(cef.log)")
        }

        // Without this the assertions above cannot tell "filtered" from "always the start page".
        cef = BrowserRuntimeTests.CEFRecorder()
        runtime = BrowserRuntime(driver: cef.driver, scheduler: clock.scheduler)
        PanelWebTabModels.removeAllForTesting()
        makeHostView(webTab("t1", url: "https://example.com", title: "Example")).attachToRuntime()
        XCTAssertTrue(cef.log.contains("c1 create url=https://example.com"), "log was \(cef.log)")
    }

    /// The other half of the bridge, and the reason it is two lines rather than one: the runtime
    /// binds each tab's model to its `host` AT CREATE TIME, and a model with no host records no
    /// navigations at all. Task 5 owes the real wiring (ledger item #6); until then this is what
    /// keeps panel history being written across the intermediate commit instead of silently stopping.
    func testTheBridgeGivesTheRuntimeAHostSoACreatedTabStillReportsItsNavigations() {
        let shellHost = ShellSessionHost(directory: SessionDirectory(lister: { [] }),
                                         makeFeed: { _ in nil })
        XCTAssertNil(runtime.host, "the premise: nothing else sets this before Task 5")

        makeHostView(webTab("t1", url: "https://example.com"), host: shellHost).attachToRuntime()

        XCTAssertTrue(runtime.host === shellHost,
                      "a browser created through the bridge would report its navigations nowhere")
    }
}
