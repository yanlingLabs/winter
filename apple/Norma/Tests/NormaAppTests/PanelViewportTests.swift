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
    private func makeHostView(_ tab: PanelTab) -> PanelViewportHostView {
        let view = PanelViewportHostView(tab: tab, runtime: runtime)
        view.frame = NSRect(x: 0, y: 0, width: 900, height: 600)
        return view
    }

    /// The browser this tab's viewport will borrow, created the ONLY way one can be created since
    /// Task 5: a `.create` action, as the engine emits it. Before Task 5 these tests got their
    /// browsers from the viewport's own temporary bridge — deleting that bridge is precisely the
    /// commit where "no view asks for a browser to exist" became true, so every row here that needs
    /// a live browser now says so out loud.
    private func createBrowser(_ tab: PanelTab, sessionId: String = "s1") {
        runtime.apply([.create(tabId: tab.tabId, url: tab.url)],
                      tabs: [sessionId: [BrowserTabState(tabId: tab.tabId, url: tab.url,
                                                         isShown: true, title: tab.title)]],
                      sessionOf: { _ in sessionId })
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
        let tab = webTab("t1", url: "https://example.com")
        createBrowser(tab)
        let hostView = makeHostView(tab)

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
        let tab = webTab("t1", url: "https://example.com")
        createBrowser(tab)
        let hostView = makeHostView(tab)
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
        let tab = webTab("t1", url: "https://example.com")
        createBrowser(tab)
        let hostView = makeHostView(tab)
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
        let tab = webTab("t1", url: "https://example.com")
        createBrowser(tab)
        let hostView = makeHostView(tab)
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
        createBrowser(tab)
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

    // MARK: - The bridge is gone (Task 5)

    /// **The commit where spec §2's "creation driven only by the engine" became literally true.**
    ///
    /// Four rows stood here between T4 and Task 5, all of them about the temporary bridge
    /// `PanelViewportHostView.attachToRuntime` carried: that it asked for a browser exactly once
    /// per tab, that it asked for nothing when one was already live, that a stored hostile URL
    /// still reached `PanelURLPolicy.restorableURL` through it, and that it handed the runtime a
    /// `ShellSessionHost` so a created tab's navigations were recorded. Their subject no longer
    /// exists, so they are retired rather than adapted — a test whose mechanism has been deleted
    /// cannot fail, and one kept alive by rewriting it around a different mechanism is a claim
    /// nobody made. Where each claim went:
    ///
    ///   * "asks once, and asks for nothing when live" — `BrowserRuntime.create`'s double-create
    ///     guard, pinned by `BrowserRuntimeTests`, and by the row below (which proves the VIEW no
    ///     longer asks at all).
    ///   * the hostile-URL door — `BrowserRuntimeTests
    ///     .testTheRestoreDoorRefusesEveryDisallowedSchemeAndSeedsNothingForOne` pins the door
    ///     itself; `BrowserSignalsTests
    ///     .testAStoredHostileURLNeverReachesCEFThroughTheFoldThatRestoresIt` pins that the path a
    ///     user actually takes — a fold, through the engine — reaches it.
    ///   * `runtime.host` — `BrowserSignalsTests.testTheRuntimeIsWiredBeforeTheFirstCreate`
    ///     (ledger obligation #6), which is stronger: the coordinator wires it in `init`, before
    ///     any plan can run, rather than on the first viewport attach.
    ///
    /// This row is the deletion's own pin: attaching a viewport for a tab with no browser must
    /// reach CEF NOT AT ALL. Asserted as "the whole transcript is empty" rather than "no create",
    /// so a bridge reintroduced as a seed, an observer registration or anything else fails it too.
    func testAViewportForATabWithNoBrowserAsksForNothingAndMountsNothing() {
        installFakeCEFTreeOnCreate()
        let hostView = makeHostView(webTab("t1", url: "https://example.com"))
        makeWindow().contentView?.addSubview(hostView)

        hostView.attachToRuntime()

        XCTAssertEqual(cef.log, [],
                       "the view layer asked for a browser to exist: \(cef.log)")
        XCTAssertFalse(runtime.isLive(tabId: "t1"))
        XCTAssertNil(runtime.viewportTabId,
                     "and nothing may be claimed as the viewport when nothing was mounted")
        XCTAssertNil(runtime.host, "nor may a view bind the runtime's shell host any more")
    }
}
