import XCTest
import AppKit
@testable import Norma

/// Mac app shell, Task 1: the singleton app window, its summon paths, and the sidebar's selection
/// model. Same posture as `DashboardTests`/`StandaloneWindowTests` — the PURE decision helpers
/// (mode order, destination titles, summon geometry, the rendering-active gate) are exercised
/// directly, plus wiring-level construction/singleton smoke tests against the real
/// `AppWindowController`. SwiftUI bodies (`ShellRootView`/`ShellSidebar`) are deliberately NOT
/// exercised here, per this codebase's convention (see `DashboardTests`' own file doc).
@MainActor
final class AppShellTests: XCTestCase {
    // MARK: - SessionMode: the iOS nav mirror (PURE)

    /// RETRUED (chatgpt-ui T1, spec R1): the mode rows are now Chats-first — the ChatGPT-desktop
    /// sidebar order (New chat sits above these as an ACTION row, `shellSidebarTopRows`). This pin
    /// used to assert the phone's own `[.code, .dispatch, .cowork, .chat]` literal ("two lists that
    /// must move together"); the 2026-08-06 spec supersedes the iOS-mirror ruling FOR THE MAC ONLY
    /// (spec "Why" #3 — the phone keeps the Liquid Glass gallery and its own order, pinned there by
    /// `SessionModeTests`; the two lists deliberately no longer move together).
    func testSidebarModeRowOrderIsChatsFirstPerTheChatGPTShape() {
        XCTAssertEqual(SessionMode.sidebarOrder, [.chat, .code, .dispatch, .cowork])
        XCTAssertEqual(Set(SessionMode.sidebarOrder), Set(SessionMode.allCases), "every mode appears exactly once")
    }

    func testEveryModeHasATitleAndSystemImage() {
        for mode in SessionMode.sidebarOrder {
            XCTAssertFalse(mode.title.isEmpty, "\(mode) needs a non-empty title")
            XCTAssertFalse(mode.systemImage.isEmpty, "\(mode) needs a non-empty SF Symbol name")
        }
    }

    /// Cowork is the ONLY unavailable mode (spec §2: iOS's actual pattern — a "Coming soon"
    /// unavailable-view, never an empty list). A future mode flipping available must be a
    /// deliberate edit here.
    func testOnlyCoworkIsUnavailable() {
        XCTAssertEqual(SessionMode.sidebarOrder.filter { !$0.isAvailable }, [.cowork])
    }

    /// The wire's `mode` string (`SessionSummary.mode`) maps onto the sidebar's rows; an absent or
    /// unknown mode reads as `.code` (the daemon omits `mode` for plain code sessions).
    func testSessionModeFromWireString() {
        XCTAssertEqual(SessionMode(wire: "chat"), .chat)
        XCTAssertEqual(SessionMode(wire: "dispatch"), .dispatch)
        XCTAssertEqual(SessionMode(wire: "cowork"), .cowork)
        XCTAssertEqual(SessionMode(wire: "code"), .code)
        XCTAssertEqual(SessionMode(wire: nil), .code, "the daemon omits `mode` for a plain code session")
        XCTAssertEqual(SessionMode(wire: "mystery"), .code, "an unknown future mode degrades to code, never crashes")
    }

    // MARK: - ShellDestination / ShellNavigationModel (PURE)

    /// RETRUED (chatgpt-ui T2, spec R2): the app LAUNCHES onto the new-chat page — chat mode,
    /// ready to type, no session minted. T1 deliberately hard-coded `.mode(.code)` (decoupling
    /// this constant from `sidebarOrder.first` precisely so the reorder didn't smuggle a launch
    /// change) with a "T2 retargets" note; this is that retarget. Re-summon mid-run still
    /// preserves prior state — `summon(navigatingTo: nil)` never touches the destination
    /// (`testLaunchLandsOnNewChatAndResummonPreservesPriorState`).
    func testNavigationModelDefaultsToTheNewChatPage() {
        XCTAssertEqual(ShellNavigationModel().destination, defaultShellDestination)
        XCTAssertEqual(defaultShellDestination, .newChat)
    }

    func testNavigateRetargetsTheDestination() {
        let nav = ShellNavigationModel()
        nav.navigate(to: .dashboard(pane: nil))
        XCTAssertEqual(nav.destination, .dashboard(pane: nil))
        nav.navigate(to: .session("s_1"))
        XCTAssertEqual(nav.destination, .session("s_1"))
    }

    /// Task 7: a `.dashboard` destination carrying a PANE payload is still a `.dashboard` for
    /// every purpose that doesn't care which pane — but it is NOT equal to `.dashboard(pane: nil)`,
    /// which is exactly the mechanism the deep-link differentiation (`.pluginManager` vs a plain
    /// open) relies on.
    func testDashboardDestinationEqualityIsPaneSensitive() {
        XCTAssertNotEqual(ShellDestination.dashboard(pane: nil), .dashboard(pane: .pluginManager))
        XCTAssertEqual(ShellDestination.dashboard(pane: .pluginManager), .dashboard(pane: .pluginManager))
    }

    /// The sidebar highlights a MODE row only for a mode destination — a recents entry or the
    /// Dashboard leaves all four rows unhighlighted (iOS's own nav: the gear is not a fifth
    /// session-like row). Holds for EVERY pane payload, not just the plain (`nil`) case.
    func testSelectedSidebarModeIsNilForSessionAndDashboardDestinations() {
        XCTAssertEqual(selectedSidebarMode(for: .mode(.dispatch)), .dispatch)
        XCTAssertNil(selectedSidebarMode(for: .session("s_1")))
        XCTAssertNil(selectedSidebarMode(for: .dashboard(pane: nil)))
        XCTAssertNil(selectedSidebarMode(for: .dashboard(pane: .pluginManager)))
    }

    func testEveryDestinationHasATitleAndSystemImage() {
        let destinations: [ShellDestination] = SessionMode.sidebarOrder.map { .mode($0) } + [.session("s_1"), .dashboard(pane: nil), .dashboard(pane: .pluginManager), .newChat]
        for destination in destinations {
            XCTAssertFalse(shellDestinationTitle(destination).isEmpty, "\(destination) needs a non-empty title")
            XCTAssertFalse(shellDestinationSystemImage(destination).isEmpty, "\(destination) needs a non-empty SF Symbol name")
        }
    }

    // MARK: - Window geometry (PURE)

    func testCenteredAppWindowFrame() {
        let f = centeredAppWindowFrame(visibleFrame: NSRect(x: 0, y: 0, width: 2000, height: 1400))
        XCTAssertEqual(f.size, appWindowDefaultSize)
        XCTAssertEqual(f.midX, 1000, accuracy: 1)
        XCTAssertEqual(f.midY, 700, accuracy: 1)
    }

    /// A non-origin visible frame (secondary monitor / menu-bar inset) must still center correctly
    /// — mirrors `DashboardTests.testCenteredDashboardFrameOffsetVisibleFrame`.
    func testCenteredAppWindowFrameOffsetVisibleFrame() {
        let f = centeredAppWindowFrame(visibleFrame: NSRect(x: 500, y: 100, width: 1600, height: 1000))
        XCTAssertEqual(f.size, appWindowDefaultSize)
        XCTAssertEqual(f.midX, 1300, accuracy: 1)
        XCTAssertEqual(f.midY, 600, accuracy: 1)
    }

    /// A window already ON the keyboard-focus display keeps its exact frame — summoning must never
    /// yank a window the user has positioned/resized.
    func testSummonFrameKeepsAFrameAlreadyOnTheKeyboardFocusDisplay() {
        let current = NSRect(x: 120, y: 90, width: 900, height: 600)
        let target = NSRect(x: 0, y: 0, width: 2000, height: 1200)
        XCTAssertEqual(summonFrame(current: current, targetVisibleFrame: target), current)
    }

    /// A window left on a display that no longer has keyboard focus re-centers onto the one that
    /// does, at its CURRENT size (spec §1: "summons to the display with keyboard focus").
    func testSummonFrameRecentersOntoTheKeyboardFocusDisplay() {
        let current = NSRect(x: -1800, y: 0, width: 900, height: 600) // a display to the left
        let target = NSRect(x: 0, y: 0, width: 2000, height: 1200)
        let f = summonFrame(current: current, targetVisibleFrame: target)
        XCTAssertEqual(f.size, current.size, "size is preserved — only the position moves")
        XCTAssertEqual(f.midX, target.midX, accuracy: 1)
        XCTAssertEqual(f.midY, target.midY, accuracy: 1)
    }

    /// A window bigger than the display it's summoned onto is clamped to fit rather than hanging
    /// off both edges (a laptop-only session after a large external display goes away).
    func testSummonFrameClampsAWindowLargerThanTheTargetDisplay() {
        let current = NSRect(x: -4000, y: 0, width: 3000, height: 2000)
        let target = NSRect(x: 0, y: 0, width: 1440, height: 900)
        let f = summonFrame(current: current, targetVisibleFrame: target)
        XCTAssertEqual(f.width, 1440, accuracy: 1)
        XCTAssertEqual(f.height, 900, accuracy: 1)
        XCTAssertTrue(target.contains(f), "a clamped frame must sit entirely inside the target display")
    }

    // MARK: - sessionDisplayTitle (PURE, moved from `Dashboard/panes/SessionsPane.swift` — Task 7's
    // SessionsPane funeral. The pane VIEW died (spec §4: redundant with the shell's own lists) but
    // this helper stayed alive — `ShellSidebar`'s Recents list, `ChatLandingView`/`ModeLandingView`'s
    // rows, and `ShellSessionHost`'s hop-away banner all still call it — so it moved to
    // `AppShell/ShellNavigation.swift` (the shared pure-helpers home those files already read) and
    // its tests moved here, unchanged in substance (fixture-mechanics only). `groupedSessionRows`,
    // `SessionsPane.swift`'s OTHER pure helper, had no other consumer and died with the pane — its
    // five tests are gone, not moved (the funeral, not a move).

    func testSessionDisplayTitleFallsBackToNewSessionForNilEmptyOrWhitespace() {
        XCTAssertEqual(sessionDisplayTitle(nil), "New session")
        XCTAssertEqual(sessionDisplayTitle(""), "New session")
        XCTAssertEqual(sessionDisplayTitle("   \n  "), "New session")
    }

    func testSessionDisplayTitleTrimsAndKeepsARealTitle() {
        XCTAssertEqual(sessionDisplayTitle("  Fix the parser  "), "Fix the parser")
        XCTAssertEqual(sessionDisplayTitle("Already trimmed"), "Already trimmed")
    }

    // MARK: - shellRenderingActive (PURE) — hidden-window hygiene

    /// Rendering (the transcript's `TimelineView` ticks, T2's `session.list` poll) runs ONLY while
    /// the window is both on screen AND at least partially unoccluded. Every other combination
    /// suspends — a hidden shell must cost nothing.
    func testRenderingIsActiveOnlyWhenVisibleAndUnoccluded() {
        XCTAssertTrue(shellRenderingActive(isWindowVisible: true, occlusionVisible: true))
        XCTAssertFalse(shellRenderingActive(isWindowVisible: true, occlusionVisible: false), "fully occluded (another app's window covers it) — suspend")
        XCTAssertFalse(shellRenderingActive(isWindowVisible: false, occlusionVisible: true), "ordered out — suspend regardless of the last occlusion reading")
        XCTAssertFalse(shellRenderingActive(isWindowVisible: false, occlusionVisible: false))
    }

    // MARK: - AppWindowController: the singleton window contract

    private func makeController() -> AppWindowController {
        AppWindowController(
            directory: SessionDirectory(lister: { [] }),
            frame: NSRect(x: 100, y: 80, width: 1100, height: 720)
        )
    }

    func testSummonTwiceYieldsOneWindowInstance() {
        let controller = makeController()
        defer { controller.hide() }

        controller.summon()
        let first = controller.windowForTesting
        controller.summon()

        XCTAssertNotNil(first)
        XCTAssertTrue(controller.windowForTesting === first, "the shell owns exactly ONE window for the process lifetime")
        XCTAssertTrue(controller.isVisible)
    }

    /// Closing the window HIDES it (spec §1: never destroyed) — the controller, its window, and its
    /// navigation state all stay alive. This is the singleton's defining difference from
    /// `DashboardWindowController` (whose `onClosed` nils the ref out).
    func testCloseHidesTheWindowAndKeepsTheControllerAlive() {
        let controller = makeController()
        controller.summon(navigatingTo: .mode(.dispatch))
        guard let window = controller.windowForTesting else {
            return XCTFail("summon() must construct a real window")
        }

        let shouldClose = controller.windowShouldClose(window)

        XCTAssertFalse(shouldClose, "the red traffic light must hide, never close — AppKit must be told no")
        XCTAssertFalse(controller.isVisible)
        XCTAssertTrue(controller.windowForTesting === window, "the window instance survives a close")
        XCTAssertEqual(controller.navigation.destination, .mode(.dispatch), "navigation state survives a close")
    }

    func testReSummonShowsTheSameInstance() {
        let controller = makeController()
        defer { controller.hide() }
        controller.summon()
        guard let window = controller.windowForTesting else {
            return XCTFail("summon() must construct a real window")
        }
        _ = controller.windowShouldClose(window)
        XCTAssertFalse(controller.isVisible)

        controller.summon()

        XCTAssertTrue(controller.isVisible)
        XCTAssertTrue(controller.windowForTesting === window, "re-summon shows the SAME window, never a second one")
    }

    /// Spec §1: native full-screen is opted OUT (a hidden full-screen window strands a Space).
    func testWindowOptsOutOfNativeFullScreen() {
        let controller = makeController()
        defer { controller.hide() }
        controller.summon()
        guard let window = controller.windowForTesting else {
            return XCTFail("summon() must construct a real window")
        }

        XCTAssertFalse(window.collectionBehavior.contains(.fullScreenPrimary), "a hidden full-screen window would strand a Space")
        XCTAssertTrue(window.collectionBehavior.contains(.fullScreenNone))
        XCTAssertTrue(window.styleMask.contains(.titled))
        XCTAssertTrue(window.styleMask.contains(.closable))
        XCTAssertTrue(window.styleMask.contains(.resizable))
        XCTAssertTrue(window.styleMask.contains(.miniaturizable))
    }

    /// chatgpt-ui T3 (spec §4): the seamless ChatGPT-desktop chrome, asserted on the REAL window.
    /// Transparent titlebar over full-size content — the traffic lights float over the custom
    /// pane's own flat background (which ignores the top safe area and clears them with
    /// `shellSidebarTopInset`); the title TEXT is hidden (the seamless top carries no "Norma"
    /// label) while the window KEEPS its title — Mission Control/Window-menu identity must
    /// survive the reskin.
    ///
    /// RETRUED (custom-sidebar rework): the toolbar assertion INVERTED — pass 1 kept an empty
    /// unified toolbar as inset-traffic-lights machinery, but the ChatGPT desktop app has no
    /// toolbar at all, and with the native `NavigationSplitView` gone nothing needs one; the
    /// traffic lights sit at their standard inline position. `nil` is now the pinned state so a
    /// toolbar can never quietly grow back (native chrome needs an explicit user OK). The
    /// summon/visibility/geometry pins around this one are the guardrail — chrome flags must
    /// never change behavior.
    func testWindowChromeIsSeamlessTitlebarOverFullSizeContent() {
        let controller = makeController()
        defer { controller.hide() }
        controller.summon()
        guard let window = controller.windowForTesting else {
            return XCTFail("summon() must construct a real window")
        }

        XCTAssertTrue(window.titlebarAppearsTransparent, "spec §4: the seamless top — the sidebar shows through the titlebar")
        XCTAssertTrue(window.styleMask.contains(.fullSizeContentView), "content extends under the titlebar")
        XCTAssertEqual(window.titleVisibility, .hidden, "no title text over the seamless top")
        XCTAssertEqual(window.title, "Norma", "the window keeps its NAME — Mission Control/Window-menu identity")
        XCTAssertNil(window.toolbar, "custom-sidebar: NO toolbar — ChatGPT has none; the traffic lights float over the custom pane")
        XCTAssertTrue(window.isOpaque, "the shell is an opaque window — the detached windows' clear shell is NOT this recipe")
    }

    /// panel-shell T2 review round 2: the panel toggle's disabled help text ("Widen the window or
    /// hide the sidebar to use the panel.", `ShellSidebar.swift`) is only ALWAYS true if hiding
    /// the sidebar can alone always restore enough content width — which needs the window's own
    /// floor to never itself be narrower than the panel requires. This is a cross-file invariant
    /// that lived only in a comment; pinning it here means a future change to either side (this
    /// `minSize`, or `panelMinContentWidth`) fails a test instead of quietly making that help
    /// text a lie.
    func testWindowMinimumSizeCanAlwaysFitThePanelWithoutTheSidebar() {
        let controller = makeController()
        defer { controller.hide() }
        controller.summon()
        guard let window = controller.windowForTesting else {
            return XCTFail("summon() must construct a real window")
        }

        XCTAssertGreaterThanOrEqual(window.minSize.width, panelMinContentWidth,
            "the window's floor must fit the panel once the sidebar is hidden, or the disabled toggle's help text can be wrong")
    }

    /// A plain re-summon PRESERVES the current destination (the `openDashboard` plain-refocus
    /// precedent); a targeted summon retargets it.
    func testSummonNavigatesOnlyWhenGivenADestination() {
        let controller = makeController()
        defer { controller.hide() }

        controller.summon()
        XCTAssertEqual(controller.navigation.destination, defaultShellDestination)

        controller.summon(navigatingTo: .dashboard(pane: nil))
        XCTAssertEqual(controller.navigation.destination, .dashboard(pane: nil))

        controller.summon()
        XCTAssertEqual(controller.navigation.destination, .dashboard(pane: nil), "a plain re-summon must preserve the user's current destination")
    }

    /// Task 7: a TARGETED `.dashboard(pane:)` summon ALSO retargets `dashboardSelection` — pure
    /// window-level mechanics, provable with no `dashboardWiring` at all (`makeController()` never
    /// passes one). A plain `.dashboard(pane: nil)` summon, or navigating away to a different
    /// destination entirely, must never touch the pane memory — the direct descendant of
    /// `openDashboard(initialPane:)`'s old "nil never resets" contract
    /// (`DashboardWindowController`, deleted this task).
    func testTargetedDashboardSummonRetargetsSelectionPlainSummonPreservesIt() {
        let controller = makeController()
        defer { controller.hide() }
        XCTAssertEqual(controller.dashboardSelection.selection, defaultDashboardPane)

        controller.summon(navigatingTo: .dashboard(pane: .trust))
        XCTAssertEqual(controller.dashboardSelection.selection, .trust)

        controller.summon(navigatingTo: .dashboard(pane: nil))
        XCTAssertEqual(controller.dashboardSelection.selection, .trust, "a plain dashboard summon must preserve the current pane")

        controller.summon(navigatingTo: .mode(.chat))
        XCTAssertEqual(controller.dashboardSelection.selection, .trust, "navigating away from the dashboard must not reset the pane memory")

        controller.summon(navigatingTo: .dashboard(pane: .pluginManager))
        XCTAssertEqual(controller.dashboardSelection.selection, .pluginManager, "a second targeted summon retargets even after leaving and returning to the dashboard")
    }

    // MARK: - Hidden-window hygiene (wiring)

    func testHidingSuspendsRenderingAndSummonResumesIt() {
        let controller = makeController()
        defer { controller.hide() }
        var seen: [Bool] = []
        controller.onRenderingActiveChange = { seen.append($0) }

        controller.summon()
        XCTAssertTrue(controller.isRenderingActive)

        controller.hide()
        XCTAssertFalse(controller.isRenderingActive, "a hidden shell accumulates no view work")

        controller.summon()
        XCTAssertTrue(controller.isRenderingActive)
        XCTAssertEqual(seen, [true, false, true], "every transition fires the hook exactly once")
    }

    /// The occlusion seam: a fully covered (but still on-screen) window suspends too — the
    /// `windowDidChangeOcclusionState` delegate callback's pure half, driven directly.
    func testOcclusionSuspendsRenderingWhileTheWindowStaysVisible() {
        let controller = makeController()
        defer { controller.hide() }
        controller.summon()
        XCTAssertTrue(controller.isRenderingActive)

        controller.applyOcclusion(visible: false)

        XCTAssertTrue(controller.isVisible, "still ordered in — merely covered")
        XCTAssertFalse(controller.isRenderingActive)

        controller.applyOcclusion(visible: true)
        XCTAssertTrue(controller.isRenderingActive)
    }

    /// The visibility hook is what keeps `AppDelegate.syncDockPresence()` in step with a window
    /// that hides itself (the red traffic light) rather than being closed.
    func testVisibilityChangeHookFiresOnSummonAndHide() {
        let controller = makeController()
        defer { controller.hide() }
        var seen: [Bool] = []
        controller.onVisibilityChange = { seen.append($0) }

        controller.summon()
        controller.hide()
        controller.hide() // idempotent — no duplicate notification

        XCTAssertEqual(seen, [true, false])
    }

    // MARK: - AppDelegate.summonAppWindow(navigatingTo:) — the summon paths

    /// Defensive-guard precedent (matches `openDashboard`'s own guard): never booted → no
    /// `appModel` → log + no-op, no crash, no window.
    func testSummonAppWindowNoOpsWithoutAppModel() {
        let delegate = AppDelegate()
        delegate.summonAppWindow()
        XCTAssertNil(delegate.appWindow)
    }

    func testSummonAppWindowTwiceReusesTheSameController() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        delegate.summonAppWindow()
        guard let first = delegate.appWindow else {
            return XCTFail("summonAppWindow() must construct a controller when booted")
        }

        delegate.summonAppWindow()

        XCTAssertTrue(delegate.appWindow === first, "nothing ever spawns a second app window (spec R2)")
        delegate.appWindow?.hide()
    }

    /// Hiding the shell must NOT clear the singleton ref (the `DashboardWindowController` contrast)
    /// — a re-summon reuses the same controller, with its navigation state intact.
    func testHidingTheShellKeepsTheSingletonRefAndItsState() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        delegate.summonAppWindow(navigatingTo: .dashboard(pane: nil))
        guard let first = delegate.appWindow else {
            return XCTFail("summonAppWindow() must construct a controller when booted")
        }
        first.hide()

        XCTAssertTrue(delegate.appWindow === first, "hide must never nil the singleton out")

        delegate.summonAppWindow()
        XCTAssertTrue(delegate.appWindow === first)
        XCTAssertEqual(first.navigation.destination, .dashboard(pane: nil))
        delegate.appWindow?.hide()
    }

    /// The shell is a real main window: it promotes the dock icon while visible and demotes on
    /// hide, through the SAME `hasMainWindow`/`syncDockPresence` machinery the Dashboard and
    /// detached windows already drive (spec §1: retargeted, not rebuilt).
    func testShellPromotesTheDockIconAndHidingDemotes() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())

        delegate.summonAppWindow()
        XCTAssertEqual(NSApp.activationPolicy(), .regular, "the shell is a real main window — must show the dock icon")

        delegate.appWindow?.hide()
        XCTAssertEqual(NSApp.activationPolicy(), .accessory, "hiding the shell with no other main window open must hide the dock icon")
    }

    /// ⌘Q / dock-tile quit (the intercepted lifecycle): the shell HIDES like every other main
    /// window, the controller survives, and the dock icon demotes.
    func testCommandQHidesTheShellWithoutDestroyingIt() {
        let delegate = AppDelegate()
        delegate.systemQuitReasonProvider = { false }
        XCTAssertTrue(delegate.boot())
        delegate.summonAppWindow()
        guard let controller = delegate.appWindow else {
            return XCTFail("summonAppWindow() must construct a controller when booted")
        }

        let reply = delegate.applicationShouldTerminate(NSApp)

        XCTAssertEqual(reply, .terminateCancel)
        XCTAssertFalse(controller.isVisible, "⌘Q must close (hide) the shell like any other main window")
        XCTAssertTrue(delegate.appWindow === controller, "…without destroying the singleton")
        XCTAssertEqual(NSApp.activationPolicy(), .accessory)
    }

    /// The dock-icon summon path: a Finder/dock reopen with no main window open summons the shell
    /// (previously: spawned a standalone detached window).
    func testReopenSummonsTheShell() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())

        let handled = delegate.applicationShouldHandleReopen(NSApp, hasVisibleWindows: false)

        XCTAssertFalse(handled, "the reopen was handled here — nothing left for AppKit's default handling")
        XCTAssertNotNil(delegate.appWindow, "the dock icon summons the shell")
        XCTAssertTrue(delegate.appWindow?.isVisible ?? false)
        XCTAssertTrue(delegate.detachedWindows.isEmpty, "the reopen path no longer spawns a standalone detached window")
        delegate.appWindow?.hide()
    }

    /// A visible shell is already a main window — reopen defers to AppKit's default handling.
    func testReopenWithTheShellAlreadyVisibleDefersToAppKit() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        delegate.summonAppWindow()

        XCTAssertTrue(delegate.applicationShouldHandleReopen(NSApp, hasVisibleWindows: true))
        delegate.appWindow?.hide()
    }

    /// app-shell Task 2: the END-TO-END wiring for the `session.list` poll — not just
    /// `SessionDirectory.setPolling`'s own unit tests (`SessionDirectoryTests`), but the actual
    /// `AppWindowController.onRenderingActiveChange` hook `summonAppWindow` wires it through. Proves
    /// `model.directory` (the SAME instance `AppWindowController` renders and every app-shell
    /// surface reads) starts polling the instant the shell becomes visible, and stops the instant
    /// it hides — mirroring `testShellPromotesTheDockIconAndHidingDemotes`'s wiring-level posture
    /// for `onVisibilityChange` just above.
    func testSummonAppWindowStartsPollingAndHidingItStopsThePoll() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        XCTAssertFalse(delegate.appModel?.directory.isPollingForTesting ?? true, "no polling before the shell is ever summoned")

        delegate.summonAppWindow()
        XCTAssertTrue(delegate.appModel?.directory.isPollingForTesting ?? false, "a visible, unoccluded shell starts the poll")

        delegate.appWindow?.hide()
        XCTAssertFalse(delegate.appModel?.directory.isPollingForTesting ?? true, "hiding the shell stops the poll")
    }

    // MARK: - The orb's summon door (NO OrbWindowController change — Global Constraints)

    /// The orb's sidebar carries a summon door, and firing it summons the singleton. Wired on the
    /// `SidebarWiring` bundle `boot()` already builds for the orb, so `OrbWindowController` itself
    /// is untouched (`git diff` on that file must stay empty for this whole plan).
    func testOrbSidebarWiringCarriesTheSummonDoor() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        guard let summon = delegate.orbController?.sidebars?.onSummonApp else {
            return XCTFail("boot() must wire the orb's summon door")
        }
        XCTAssertNil(delegate.appWindow, "nothing summoned yet")

        summon()

        XCTAssertNotNil(delegate.appWindow, "the orb's door must summon the one app window")
        XCTAssertTrue(delegate.appWindow?.isVisible ?? false)
        delegate.appWindow?.hide()
    }

    /// The compatibility bar: the door is OPT-IN. Both detached-window construction sites build a
    /// `SidebarWiring` without it, so their sidebars render exactly as before this task.
    func testSidebarWiringSummonDoorDefaultsToNilForEveryOtherSurface() {
        let wiring = SidebarWiring(
            directory: SessionDirectory(lister: { [] }),
            currentSessionId: { nil },
            onSelect: { _ in },
            onOpenDetached: { _ in },
            onNewSession: {}
        )
        XCTAssertNil(wiring.onSummonApp, "a wiring that doesn't ask for the door must not get one")
    }

    /// app-shell T3, the same compatibility bar one field over: the left session switcher is
    /// OPT-OUT. Both detached-window construction sites (and the orb's) build a `SidebarWiring`
    /// without the flag, so they keep both sidebars exactly as before; only the shell — which
    /// provides its own outer nav — asks for the right-only configuration.
    func testSidebarWiringShowsTheSessionSwitcherByDefault() {
        let wiring = SidebarWiring(
            directory: SessionDirectory(lister: { [] }),
            currentSessionId: { nil },
            onSelect: { _ in },
            onOpenDetached: { _ in },
            onNewSession: {}
        )
        XCTAssertTrue(wiring.showsSessionSwitcher, "a wiring that doesn't opt out must keep its left column")
    }

    /// The menu bar's "Open Norma App" entry summons the singleton — fired through the REAL menu
    /// item's target/action, exactly like a click (the `MenuBarEntryPointsTests` idiom).
    func testOpenNormaAppMenuItemSummonsTheShell() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        guard let item = delegate.menuBar?.openNormaAppItem else {
            return XCTFail("boot() must have installed the menu bar")
        }

        NSApp.sendAction(item.action!, to: item.target, from: item)

        XCTAssertNotNil(delegate.appWindow, "the menu item must summon the shell, not spawn a detached window")
        XCTAssertTrue(delegate.detachedWindows.isEmpty)
        delegate.appWindow?.hide()
    }

    // MARK: - App shell T6: the menu-bar retarget's funeral

    /// "Chat" summons the shell and lands on the chat mode's landing — same fired-through-the-real-
    /// item posture as `testOpenNormaAppMenuItemSummonsTheShell`. `openChat()` (the detached-window
    /// spawn it used to drive) is retired.
    func testChatMenuItemSummonsToTheChatLanding() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        guard let item = delegate.menuBar?.chatItem else {
            return XCTFail("boot() must have installed the menu bar")
        }

        NSApp.sendAction(item.action!, to: item.target, from: item)

        XCTAssertNotNil(delegate.appWindow, "the menu item must summon the shell, not spawn a detached window")
        XCTAssertEqual(delegate.appWindow?.navigation.destination, .mode(.chat))
        XCTAssertTrue(delegate.detachedWindows.isEmpty)
        delegate.appWindow?.hide()
    }

    /// RETRUED (chatgpt-ui T2, spec §2): "New Chat" no longer creates at the door — it summons the
    /// shell onto the NEW-CHAT PAGE (`.newChat`), same fired-through-the-real-item posture as
    /// "Chat" beside it. The old pin proved the degraded boot's create failure summoned nothing;
    /// that create no longer exists at the door at all — the page opens fine with no daemon (the
    /// FIRST SEND is what needs one, and its failure is the page's own visible state:
    /// `ChatWindowTests.testFirstSendCreateFailureIsVisibleOnThePageAndNeverNavigates`). The
    /// zero-create wire proof needs a recorder and lives in
    /// `testNewChatDoorsOpenThePageAndMintNothing`.
    func testNewChatMenuItemSummonsToTheNewChatPage() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        guard let item = delegate.menuBar?.newChatItem else {
            return XCTFail("boot() must have installed the menu bar")
        }

        NSApp.sendAction(item.action!, to: item.target, from: item)

        XCTAssertNotNil(delegate.appWindow, "the menu item must summon the shell, not spawn a detached window")
        XCTAssertEqual(delegate.appWindow?.navigation.destination, .newChat, "the door opens the page — the create waits for the first send")
        XCTAssertTrue(delegate.detachedWindows.isEmpty)
        delegate.appWindow?.hide()
    }

    /// "Dashboard…" summons the shell onto a PLAIN `.dashboard(pane: nil)` — App shell T7: the real
    /// `DashboardSurface` ships this task; a plain open preserves whatever pane is already showing
    /// (or lands on `defaultDashboardPane` when freshly opened). The real `DashboardWindowController`
    /// is gone (T7's funeral) — this menu item never constructed it once T6 retargeted it anyway.
    func testDashboardMenuItemSummonsToThePlainDashboardDestination() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        guard let item = delegate.menuBar?.dashboardItem else {
            return XCTFail("boot() must have installed the menu bar")
        }

        NSApp.sendAction(item.action!, to: item.target, from: item)

        XCTAssertNotNil(delegate.appWindow, "the menu item must summon the shell, not spawn a Dashboard window")
        XCTAssertEqual(delegate.appWindow?.navigation.destination, .dashboard(pane: nil))
        delegate.appWindow?.hide()
    }

    /// "Manage Plugins…" is now a TARGETED deep link to `.pluginManager` specifically — T7
    /// differentiates it from the plain "Dashboard…" entry for the first time (T6 shipped both
    /// landing on the same bare `.dashboard`, before the pane payload existed).
    /// `openPluginManager()` (T6's thin `openDashboard(initialPane: .pluginManager)` wrapper) is
    /// long gone; this item now goes straight through `summonAppWindow(navigatingTo:)`.
    func testManagePluginsMenuItemSummonsToThePluginManagerPane() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        guard let item = delegate.menuBar?.pluginManagerItem else {
            return XCTFail("boot() must have installed the menu bar")
        }

        NSApp.sendAction(item.action!, to: item.target, from: item)

        XCTAssertNotNil(delegate.appWindow, "the menu item must summon the shell, not spawn a Dashboard window")
        XCTAssertEqual(delegate.appWindow?.navigation.destination, .dashboard(pane: .pluginManager))
        delegate.appWindow?.hide()
    }

    /// The plan's grep-pin, as a live test: after this task, no menu path can construct a
    /// `DetachedWindowController` except an explicit detach action — the real Dashboard WINDOW this
    /// pin originally also checked for (`AppDelegate.dashboardWindow`) is gone as a TYPE, Task 7
    /// (`DashboardWindowController` deleted), so there is nothing left of that half to assert;
    /// structurally impossible now, not merely untrue. Fires every retargeted item plus "Open Norma
    /// App" in one pass — the funeral's actual proof, not just each item's own destination in
    /// isolation — and additionally proves the ROUTING actually reaches the surface: the last item
    /// fired, "Manage Plugins…", must leave the shell on its targeted pane.
    func testNoMenuPathSpawnsADetachedWindowAndRoutingReachesTheSurface() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        guard let menuBar = delegate.menuBar else {
            return XCTFail("boot() must have installed the menu bar")
        }
        let items = [
            menuBar.openNormaAppItem, menuBar.newChatItem, menuBar.chatItem,
            menuBar.dashboardItem, menuBar.pluginManagerItem,
        ]
        for item in items {
            NSApp.sendAction(item.action!, to: item.target, from: item)
        }
        XCTAssertTrue(delegate.detachedWindows.isEmpty, "no retargeted menu item may ever spawn a detached window")
        XCTAssertEqual(delegate.appWindow?.navigation.destination, .dashboard(pane: .pluginManager), "the last-fired item's deep link must have actually landed")
        delegate.appWindow?.hide()
    }

    // MARK: - chatgpt-ui T1: the sidebar's row table (PURE — spec §1's exact structure)

    /// THE row-order pin, spec §1 top-to-bottom: New chat (an ACTION row — the one row that fires
    /// a door instead of setting selection), then Chats, then Code/Dispatch/Cowork. The search
    /// field, Recents, and the account row sit below these and are pinned separately
    /// (`filteredRecents`, `shellSidebarAccountRowDestination`).
    func testShellSidebarTopRowsAreNewChatThenChatsThenTheModeRows() {
        XCTAssertEqual(shellSidebarTopRows, [
            .newChat, .mode(.chat), .mode(.code), .mode(.dispatch), .mode(.cowork),
        ])
    }

    /// The destination table: every mode row navigates to its `.mode(...)` landing UNCHANGED; New
    /// chat is `nil` — an action row, never a selection (T2: the door it fires now opens the
    /// `.newChat` page; kept as an action so the row's no-dead-affordance wiring gate survives,
    /// and `.newChat` matches no row tag — the sidebar goes quiet on the page, the same posture
    /// as a `.session` destination).
    func testShellSidebarRowDestinationsModeRowsNavigateNewChatIsAnAction() {
        XCTAssertNil(shellSidebarRowDestination(.newChat), "New chat is an action row — never a selection destination")
        XCTAssertEqual(shellSidebarRowDestination(.mode(.chat)), .mode(.chat))
        XCTAssertEqual(shellSidebarRowDestination(.mode(.code)), .mode(.code))
        XCTAssertEqual(shellSidebarRowDestination(.mode(.dispatch)), .mode(.dispatch))
        XCTAssertEqual(shellSidebarRowDestination(.mode(.cowork)), .mode(.cowork))
    }

    /// Row labels: "New chat" (sentence case — the ChatGPT reference's own register) and "Chats"
    /// (PLURAL — the row lists chat sessions; the MODE's title stays "Chat" everywhere else:
    /// `ChatLandingView`'s navigation title, `shellDestinationTitle`). Code/Dispatch/Cowork read
    /// their mode titles verbatim.
    func testShellSidebarRowTitles() {
        XCTAssertEqual(shellSidebarRowTitle(.newChat), "New chat")
        XCTAssertEqual(shellSidebarRowTitle(.mode(.chat)), "Chats")
        XCTAssertEqual(shellSidebarRowTitle(.mode(.code)), "Code")
        XCTAssertEqual(shellSidebarRowTitle(.mode(.dispatch)), "Dispatch")
        XCTAssertEqual(shellSidebarRowTitle(.mode(.cowork)), "Cowork")
        XCTAssertEqual(SessionMode.chat.title, "Chat", "the MODE title is untouched — only the sidebar row pluralizes")
    }

    /// Glyphs: the pencil-square on New chat (spec §1's named glyph); mode rows keep their own
    /// `systemImage` (the phone's glyph set, unchanged by the reskin).
    func testShellSidebarRowGlyphs() {
        // RETRUED (sidebar-chrome-2, user call 2026-08-07): a PLUS, not the 2026-08-06 spec's
        // pencil-square. The pencil is ChatGPT's register; "+ New" is Claude's, which is what this
        // pane is converging on. The DESTINATION glyph (`shellDestinationSystemImage(.newChat)`)
        // deliberately keeps the pencil — see `shellSidebarRowSystemImage`'s doc for why the two
        // now differ on purpose.
        XCTAssertEqual(shellSidebarRowSystemImage(.newChat), "plus")
        XCTAssertEqual(shellDestinationSystemImage(.newChat), "square.and.pencil",
                       "the destination keeps 'compose'; only the ACTION row became a plus")
        for mode in SessionMode.sidebarOrder {
            XCTAssertEqual(shellSidebarRowSystemImage(.mode(mode)), mode.systemImage)
        }
    }

    /// RETIRED (sidebar-chrome-2, user call 2026-08-07): `shellSidebarAccountRowDestination` is
    /// gone with the plain navigate-to-Dashboard row. The account row is a MENU now, and every
    /// entry targets a NAMED pane — "the dashboard should be split into settings and other things
    /// rather than everything being in dashboard". Its replacement pins live in
    /// `SidebarBrandTests` (`testAccountMenu*`); the untargeted `.dashboard(pane: nil)` door,
    /// whose pane-memory contract this used to pin, still exists on the menu-bar item.
    func testShellSidebarAccountMenuTargetsNamedPanesNotAPlainDashboard() {
        XCTAssertFalse(shellAccountMenuPanes.isEmpty,
                       "the account row's menu is what replaced the plain Dashboard door")
    }

    // MARK: - chatgpt-ui T1: the Recents search filter (PURE — the exhaustive matrix)

    private func searchRows() -> [SessionSummary] {
        [
            SessionSummary(sessionId: "s_parser", title: "Fix the Parser", createdAt: 5, scope: "global", cwd: "/repo", mode: "code", activity: "idle"),
            SessionSummary(sessionId: "s_untitled", title: nil, createdAt: 4, scope: "global", cwd: nil, mode: "chat", activity: nil),
            SessionSummary(sessionId: "s_release", title: "release notes", createdAt: 3, scope: "global", cwd: "/repo", mode: "code", activity: "active"),
            SessionSummary(sessionId: "s_ws", title: "   ", createdAt: 2, scope: "global", cwd: nil, mode: "chat", activity: nil),
        ]
    }

    /// Empty and whitespace-only queries filter NOTHING — the field at rest shows the full list.
    func testFilteredRecentsEmptyAndWhitespaceQueriesReturnAllRowsInOrder() {
        let rows = searchRows()
        XCTAssertEqual(filteredRecents(rows, query: "").map(\.sessionId), rows.map(\.sessionId))
        XCTAssertEqual(filteredRecents(rows, query: "   \n ").map(\.sessionId), rows.map(\.sessionId))
    }

    /// Case-insensitive SUBSTRING match, anywhere in the title — never prefix-only, never
    /// case-sensitive, and the directory's order (newest first) is preserved, never re-sorted.
    func testFilteredRecentsMatchesCaseInsensitiveSubstringsPreservingOrder() {
        let rows = searchRows()
        XCTAssertEqual(filteredRecents(rows, query: "parser").map(\.sessionId), ["s_parser"])
        XCTAssertEqual(filteredRecents(rows, query: "PARSER").map(\.sessionId), ["s_parser"])
        XCTAssertEqual(filteredRecents(rows, query: "RELEASE").map(\.sessionId), ["s_release"])
        XCTAssertEqual(filteredRecents(rows, query: "e").map(\.sessionId), ["s_parser", "s_untitled", "s_release", "s_ws"],
                       "a one-letter query matches every title containing it — display order intact")
        XCTAssertEqual(filteredRecents(rows, query: "ix the p").map(\.sessionId), ["s_parser"], "substrings span word boundaries")
    }

    /// The filter matches what the USER SEES: an untitled (nil or whitespace) row displays — and
    /// therefore matches — "New session" (`sessionDisplayTitle`'s fallback), never the raw title.
    func testFilteredRecentsMatchesUntitledRowsByTheirDisplayedFallbackTitle() {
        let rows = searchRows()
        XCTAssertEqual(filteredRecents(rows, query: "new session").map(\.sessionId), ["s_untitled", "s_ws"])
        XCTAssertEqual(filteredRecents(rows, query: "SESS").map(\.sessionId), ["s_untitled", "s_ws"])
    }

    /// No match → empty, with surrounding whitespace trimmed before matching (a trailing space
    /// must not turn a hit into a miss).
    func testFilteredRecentsNoMatchIsEmptyAndQueryWhitespaceIsTrimmed() {
        let rows = searchRows()
        XCTAssertEqual(filteredRecents(rows, query: "zebra").map(\.sessionId), [])
        XCTAssertEqual(filteredRecents(rows, query: "  parser  ").map(\.sessionId), ["s_parser"])
        XCTAssertEqual(filteredRecents([], query: "anything").map(\.sessionId), [], "an empty directory filters to empty, never crashes")
    }

    // MARK: - chatgpt-ui T1: the Recents activity dot (PURE — the deglassed chip's compact form)

    /// Spec §1: Recents shows activity as a SUBTLE dot — only for the two states that mean
    /// "something is happening" (active/background, the chip colors' own live states). Idle is the
    /// resting state (a dot on every row says nothing); `nil` is a non-participating mode
    /// (chat/dispatch — `ACTIVITY_MODES`); archived never reaches Recents (`excludingArchived`,
    /// pinned upstream) but reads quiet here too rather than guessing; an unknown future value is
    /// NOT a licence to guess (`moveToCliOffered`'s own fail-quiet posture) — the mode landings'
    /// full chip still shows it verbatim, so nothing is silently lost.
    func testRecentsActivityDotOnlyForActiveAndBackground() {
        XCTAssertEqual(recentsActivityDotStyle("active"), .active)
        XCTAssertEqual(recentsActivityDotStyle("background"), .background)
        XCTAssertNil(recentsActivityDotStyle("idle"), "idle is the resting state — no dot")
        XCTAssertNil(recentsActivityDotStyle(nil), "chat/dispatch rows carry no activity at all")
        XCTAssertNil(recentsActivityDotStyle("archived"), "archived never reaches Recents anyway — quiet, not guessed")
        XCTAssertNil(recentsActivityDotStyle("teleporting"), "an unknown future value is not a licence to guess")
    }

    // MARK: - custom-sidebar: the row fill decision (PURE — one function, every row obeys it)

    /// The custom pane's rounded-rect row fill, decided in ONE pure function so every row — top
    /// rows, Recents rows, the account row — behaves identically: selection beats hover (a hovered
    /// selected row must not flicker to the weaker fill), hover shows only on an unselected row,
    /// and a row at rest draws no fill at all (the flat pane IS the resting background).
    func testSidebarRowFillSelectionBeatsHoverAndRestIsBare() {
        XCTAssertEqual(shellSidebarRowFill(isSelected: true, isHovered: true), .selected,
                       "selection beats hover — hovering a selected row never weakens its fill")
        XCTAssertEqual(shellSidebarRowFill(isSelected: true, isHovered: false), .selected)
        XCTAssertEqual(shellSidebarRowFill(isSelected: false, isHovered: true), .hover)
        XCTAssertEqual(shellSidebarRowFill(isSelected: false, isHovered: false), ShellSidebarRowFill.none,
                       "a row at rest draws no fill — the flat pane is the background")
    }

    /// The custom pane's row-selection decision (replaces `List(selection:)`'s tag matching): a
    /// mode row is selected exactly on its own `.mode(...)` landing; New chat is an ACTION row and
    /// is NEVER selected — including while the `.newChat` page itself is showing (the pinned
    /// quiet-sidebar posture: the page matches no row, same as a `.session` destination); every
    /// row goes quiet on `.session`/`.dashboard` destinations.
    func testSidebarRowSelectionFollowsModeLandingsAndIsQuietElsewhere() {
        XCTAssertTrue(shellSidebarRowIsSelected(.mode(.chat), destination: .mode(.chat)))
        XCTAssertTrue(shellSidebarRowIsSelected(.mode(.cowork), destination: .mode(.cowork)),
                      "an unavailable mode still selects — dimmed, never dead")
        XCTAssertFalse(shellSidebarRowIsSelected(.mode(.code), destination: .mode(.chat)))
        XCTAssertFalse(shellSidebarRowIsSelected(.newChat, destination: .newChat),
                       "New chat is an action row — never selected, even on the page it opens")
        XCTAssertFalse(shellSidebarRowIsSelected(.newChat, destination: .mode(.chat)))
        for row in shellSidebarTopRows {
            XCTAssertFalse(shellSidebarRowIsSelected(row, destination: .session("s1")),
                           "\(row): every row goes quiet while a session is showing")
            XCTAssertFalse(shellSidebarRowIsSelected(row, destination: .dashboard(pane: nil)),
                           "\(row): every row goes quiet on the Dashboard")
        }
    }

    // MARK: - Bugfix pass B4: the chat landing's own "New Chat" door (injected — never a second create path)

    /// The recorder seam: `AppWindowController` CARRIES the injected door verbatim (it's what
    /// `ShellRootView` hands the chat landing's button), and defaults to none — a shell built
    /// without it (this file's own `makeController()`, the pure window/geometry tests) renders no
    /// dead button (`chatLandingShowsNewChatButton`'s gate). One invocation fires the injected
    /// action exactly once.
    func testAppWindowControllerCarriesTheInjectedNewChatDoorExactlyOnce() {
        XCTAssertNil(makeController().openNewChat, "a shell built without the door stays door-less")

        var fired = 0
        let controller = AppWindowController(
            directory: SessionDirectory(lister: { [] }),
            openNewChat: { fired += 1 },
            frame: NSRect(x: 100, y: 80, width: 1100, height: 720)
        )
        controller.openNewChat?()
        XCTAssertEqual(fired, 1, "one tap = exactly one firing of the injected action")
    }

    /// RETARGETED (chatgpt-ui T2) — THE all-doors wire pin (spec §2: "one behavior everywhere; no
    /// door mints a session without a send"): the injected door `summonAppWindow` wires
    /// (`AppWindowController.openNewChat` — the sidebar's New chat row AND the chat landing's
    /// button both fire this exact closure) and the menu path (`newChat()` — proven wired to the
    /// real item by `testNewChatMenuItemSummonsToTheNewChatPage`) are the SAME door, and firing
    /// them ALL now produces ZERO `session.create` across EVERY transport the app has ever
    /// minted — the eager create is gone from every door at once. The create belongs to the
    /// page's first send alone (`ChatWindowTests.
    /// testNewChatOpensThePageAndOnlyTheFirstSendCreatesWithChatModeNoCwd`). B4's "second create
    /// path with no owner" warning still binds — a landing button growing its own
    /// `session.create` fails the zero count here.
    func testNewChatDoorsOpenThePageAndMintNothing() async throws {
        let factory = RecordingTransportFactory()
        let model = AppModel(makeTransport: { factory.make() }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }

        await waitUntil { !factory.made.isEmpty }
        let t = factory.made[0]
        await waitUntil { t.sent.count >= 1 }
        t.feed(#"{"jsonrpc":"2.0","id":\#(lineJSON(t.sent[0])["id"] as! Int),"result":{"ok":true}}"#)
        await waitUntil { t.sent.count >= 2 }
        let list = lineJSON(t.sent[1])
        XCTAssertEqual(list["method"] as? String, "session.list")
        t.feed(#"{"jsonrpc":"2.0","id":\#(list["id"] as! Int),"result":{"sessions":[]}}"#)
        await waitUntil { model.session.state.status == .idle }

        let delegate = AppDelegate()
        delegate.setAppModelForTesting(model)
        defer { delegate.appWindow?.hide() }

        // Door 1: the menu path (the real item fires this exact method — see the booted pin).
        delegate.newChat()
        XCTAssertEqual(delegate.appWindow?.navigation.destination, .newChat, "the menu door opens the page")

        // Doors 2+3: the injected closure — the sidebar's New chat row and the chat landing's
        // button both fire this verbatim (`ShellRootView.newChat` → `ShellSidebar`/`ChatLandingView`).
        guard let door = delegate.appWindow?.openNewChat else {
            return XCTFail("summonAppWindow must inject the New Chat door into the shell it constructs")
        }
        // Navigate away first so the door's page-open is observable again.
        delegate.appWindow?.navigation.navigate(to: .mode(.code))
        door()
        XCTAssertEqual(delegate.appWindow?.navigation.destination, .newChat, "the injected door opens the page")

        try? await Task.sleep(nanoseconds: 300_000_000)
        let creates = factory.made.flatMap(\.sent).map(lineJSON).filter { $0["method"] as? String == "session.create" }
        XCTAssertEqual(creates.count, 0, "NO door mints a session without a send — the eager-create path is gone everywhere: \(creates)")
    }

    // MARK: - chatgpt-ui T2: the new-chat page (spec §2 — launch destination + house-voice greeting)

    /// The launch-vs-resummon split, at the controller level (spec R2's two halves in one pin): a
    /// FRESH shell lands on the new-chat page (`defaultShellDestination`, seeded by
    /// `ShellNavigationModel` itself); a mid-run re-summon with no destination PRESERVES whatever
    /// the user was on (the existing `summon(navigatingTo: nil)` restore machinery, untouched) —
    /// launching onto the page must never come at the cost of yanking a running shell back to it.
    func testLaunchLandsOnNewChatAndResummonPreservesPriorState() {
        let controller = makeController()
        defer { controller.hide() }

        controller.summon()
        XCTAssertEqual(controller.navigation.destination, .newChat, "launch = the new-chat page, ready to type")

        controller.navigation.navigate(to: .mode(.code))
        controller.hide()
        controller.summon()
        XCTAssertEqual(controller.navigation.destination, .mode(.code), "re-summon mid-run = prior state, never a forced hop back to the page")
    }

    /// RETRUED (sidebar-chrome-2, user call 2026-08-07): the greeting ROTATES and is time-aware
    /// (`newChatGreetings`), replacing the single fixed "Ask Norma anything.".
    ///
    /// This also retires the 2026-08-06 ruling that it must be a calm STATEMENT rather than a
    /// question — the user asked for the reference's register directly, so the question form is
    /// now wanted. What survives is the part that still matters: the copy is OURS. Every hour of
    /// the day must offer a real choice of lines, and none of them may be a competitor's.
    func testNewChatGreetingsRotateAndStayHouseVoice() {
        for hour in 0..<24 {
            let pool = newChatGreetings(hour: hour)
            XCTAssertGreaterThan(pool.count, 2, "hour \(hour) needs a real pool, not one line")
            XCTAssertEqual(Set(pool).count, pool.count, "hour \(hour) repeats a line")
            for line in pool {
                XCTAssertFalse(line.isEmpty)
                // Verbatim competitor copy, the one thing the original pin really guarded.
                XCTAssertFalse(line.contains("help with"), "\(line) is ChatGPT's")
                XCTAssertNotEqual(line, "Ready when you are.", "ChatGPT's")
                XCTAssertNotEqual(line, "Evening, how are things?", "Claude's — ours may rhyme, not copy")
            }
        }
    }

    /// The bands must actually DIFFER, or "time-aware" is decoration. Morning and evening are the
    /// two furthest apart, so they are the honest check.
    func testGreetingBandsDifferByHour() {
        XCTAssertNotEqual(newChatGreetings(hour: 8), newChatGreetings(hour: 20))
        XCTAssertEqual(newChatGreetings(hour: 8), newChatGreetings(hour: 11), "same band, same pool")
    }

    func testGreetingHourComesFromTheGivenDate() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let date = DateComponents(calendar: calendar, year: 2026, month: 8, day: 7, hour: 19).date!
        XCTAssertEqual(newChatGreetingHour(date, calendar: calendar), 19)
    }

    /// The page's daemon-unreachable sentence is the house fallback, shared with every other RPC
    /// seam's copy (`setActivityFromRoster`/`applyDirsOp`'s exact string) — one voice for one
    /// failure.
    func testNewChatUnreachableMessageMatchesTheHouseFallback() {
        XCTAssertEqual(newChatUnreachableMessage, "couldn't reach the daemon — try again")
    }

    // MARK: - panel-shell T10b: the page's draft must survive `.maximized` teardown

    /// `ShellRootView`'s `if mode != .maximized { detail }` (`ShellSidebar.swift`) tears `detail`
    /// — and everything inside it, including `NewChatPage` — down and rebuilds it on every panel
    /// maximize/un-maximize toggle. `@State`'s own contract (SwiftUI allocates fresh storage the
    /// first time a view's IDENTITY is added to the hierarchy, which a torn-down-and-reinserted
    /// subtree triggers again) means a `@State`-backed draft is silently lost on that round trip.
    ///
    /// This constructs `NewChatPage` directly — a plain struct init, no `.body` ever evaluated,
    /// consistent with this file's own "SwiftUI bodies are deliberately NOT exercised" convention
    /// (see the type doc at the top of this file) — and inspects its stored properties via
    /// `Mirror`, which reflects the compiler-synthesized `_draft` backing storage regardless of
    /// `draft`'s `private` access (`Mirror` walks runtime type metadata, which carries no notion
    /// of Swift's compile-time access control). This is a genuine RUNTIME check of the exact
    /// mechanism behind the bug — not a stand-in, not a compile-time symbol check — and it fails
    /// against today's code before any implementation change: `NewChatPage` currently declares
    /// `@State private var draft = ""`, so `_draft` of type `State<String>` is present.
    func testNewChatPageDraftIsNotViewLocalState() {
        let directory = SessionDirectory(lister: { [] })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        let nav = ShellNavigationModel()
        let page = NewChatPage(nav: nav, host: host)
        let hasDraftState = Mirror(reflecting: page).children.contains { $0.label == "_draft" }
        XCTAssertFalse(hasDraftState,
            "NewChatPage's draft must not be view-local @State — it needs to live on `host` " +
            "(mirroring FieldStateAdapter.composerDraft's precedent) so it survives ShellRootView's " +
            "`.maximized` teardown of `detail`")
    }

    // MARK: - chatgpt-ui T3: the page's in-flight feedback (c-m3 — PURE send-state mapping)

    /// The T2 review's routed minor, root cause of both send-race windows: a create in flight
    /// must READ as one. `.creating` — and ONLY `.creating` — disables the composer and shows
    /// the working indicator; idle and failed both leave the composer enabled (a failure must
    /// never wedge the page — the error text's own display is pinned by
    /// `ChatWindowTests.testFirstSendCreateFailureIsVisibleOnThePageAndNeverNavigates`, and
    /// Enter retries per the T2 contract). Exhaustive over `NewChatCreateState`.
    func testNewChatSendUIDisablesComposerAndShowsIndicatorOnlyWhileCreating() {
        XCTAssertEqual(newChatSendUI(.idle), NewChatSendUI(composerEnabled: true, showsWorkingIndicator: false))
        XCTAssertEqual(newChatSendUI(.creating), NewChatSendUI(composerEnabled: false, showsWorkingIndicator: true))
        XCTAssertEqual(newChatSendUI(.failed("boom")), NewChatSendUI(composerEnabled: true, showsWorkingIndicator: false),
                       "a failed create re-enables — the page must never wedge; its error text is a separate, pinned display")
    }
}
