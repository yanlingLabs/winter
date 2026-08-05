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

    /// The sidebar's four rows, in the phone's own `sidebarOrder` — pinned on iOS by
    /// `SessionModeTests` (`norma-ios/NormaTests/SessionModeTests.swift`) with this exact literal.
    /// Two lists that must move together; this is the Mac half of that pin.
    func testSidebarOrderMirrorsThePhonesFourRows() {
        XCTAssertEqual(SessionMode.sidebarOrder, [.code, .dispatch, .cowork, .chat])
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

    func testNavigationModelDefaultsToTheCodeLanding() {
        XCTAssertEqual(ShellNavigationModel().destination, defaultShellDestination)
        XCTAssertEqual(defaultShellDestination, .mode(.code))
    }

    func testNavigateRetargetsTheDestination() {
        let nav = ShellNavigationModel()
        nav.navigate(to: .dashboard)
        XCTAssertEqual(nav.destination, .dashboard)
        nav.navigate(to: .session("s_1"))
        XCTAssertEqual(nav.destination, .session("s_1"))
    }

    /// The sidebar highlights a MODE row only for a mode destination — a recents entry or the
    /// Dashboard leaves all four rows unhighlighted (iOS's own nav: the gear is not a fifth
    /// session-like row).
    func testSelectedSidebarModeIsNilForSessionAndDashboardDestinations() {
        XCTAssertEqual(selectedSidebarMode(for: .mode(.dispatch)), .dispatch)
        XCTAssertNil(selectedSidebarMode(for: .session("s_1")))
        XCTAssertNil(selectedSidebarMode(for: .dashboard))
    }

    func testEveryDestinationHasATitleAndSystemImage() {
        let destinations: [ShellDestination] = SessionMode.sidebarOrder.map { .mode($0) } + [.session("s_1"), .dashboard]
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

    /// A plain re-summon PRESERVES the current destination (the `openDashboard` plain-refocus
    /// precedent); a targeted summon retargets it.
    func testSummonNavigatesOnlyWhenGivenADestination() {
        let controller = makeController()
        defer { controller.hide() }

        controller.summon()
        XCTAssertEqual(controller.navigation.destination, defaultShellDestination)

        controller.summon(navigatingTo: .dashboard)
        XCTAssertEqual(controller.navigation.destination, .dashboard)

        controller.summon()
        XCTAssertEqual(controller.navigation.destination, .dashboard, "a plain re-summon must preserve the user's current destination")
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
        delegate.summonAppWindow(navigatingTo: .dashboard)
        guard let first = delegate.appWindow else {
            return XCTFail("summonAppWindow() must construct a controller when booted")
        }
        first.hide()

        XCTAssertTrue(delegate.appWindow === first, "hide must never nil the singleton out")

        delegate.summonAppWindow()
        XCTAssertTrue(delegate.appWindow === first)
        XCTAssertEqual(first.navigation.destination, .dashboard)
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
}
