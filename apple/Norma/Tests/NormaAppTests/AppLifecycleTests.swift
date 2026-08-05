import XCTest
import AppKit
import NormaKit
@testable import Norma

/// Lifecycle T3: the ephemeral dock-icon toggle (activation-policy promote/demote) + the
/// source-aware termination gate. `terminateDecision` is the pure, AppKit-free core (the
/// truth-table test below, per the task brief); the rest are AppKit-wiring smoke tests reusing this
/// target's existing real-window fixtures (`DetachedScriptedTransport` from `DetachedWindowTests`,
/// `NormaClientTestFactory` from `DashboardTests`).
///
/// These tests flip the REAL `NSApp.activationPolicy()` of the xctest host — safe here because the
/// host launches `.accessory` (see `ScaffoldTests.testActivationPolicyIsAccessory`) and every test
/// below closes whatever window(s) it opened, so production's own demotion path
/// (`registerDetachedWindow`'s/`openDashboard`'s `onClosed` → `syncDockPresence`) always restores
/// `.accessory` by the time the test returns — nothing leaks into a later test.
@MainActor
final class AppLifecycleTests: XCTestCase {
    // MARK: - terminateDecision (PURE — no NSApp/AppleEvent reference)

    /// T3 review fix: the second axis is `systemInitiated` (the Apple-Event logout/restart/
    /// shutdown quit reason), not the truth-table-inert `hasMainWindow` the original brief
    /// threaded through. Sparkle whole-branch review fix: the third axis is `updaterQuitting`
    /// (armed by `UpdaterCoordinator.onWillInstall` right before Sparkle's install handler —
    /// Sparkle quits the host via a CANCELLABLE quit event with no kAEQuitReason, so without
    /// this axis the gate would answer it `.terminateCancel` like a ⌘Q and silently defeat the
    /// whole update). ONLY all-false — a plain user ⌘Q/dock-quit — cancels; refusing a
    /// system-initiated quit would block the user's logout indefinitely.
    func testTerminateDecision() {
        XCTAssertEqual(terminateDecision(reallyQuitting: true, systemInitiated: true), .terminateNow)
        XCTAssertEqual(terminateDecision(reallyQuitting: true, systemInitiated: false), .terminateNow)
        XCTAssertEqual(terminateDecision(reallyQuitting: false, systemInitiated: true), .terminateNow)
        XCTAssertEqual(terminateDecision(reallyQuitting: false, systemInitiated: false), .terminateCancel)
        // Sparkle whole-branch review: the updater-quit axis lets Sparkle's install relaunch
        // through; all-false (the default param) still cancels — existing behavior unchanged.
        XCTAssertEqual(terminateDecision(reallyQuitting: false, systemInitiated: false, updaterQuitting: true), .terminateNow)
        XCTAssertEqual(terminateDecision(reallyQuitting: false, systemInitiated: false, updaterQuitting: false), .terminateCancel)
    }

    // MARK: - fixtures

    /// A real `DetachedWindowController` over a scripted transport that never answers the
    /// handshake — same construction shape `DetachedWindowTests.testShowCreatesNativeChromeWindowAtFrame`
    /// uses; these tests only care about the window's presence in `AppDelegate`'s registry, never
    /// its live RPC traffic.
    private func makeDetachedWindow(sessionId: String = "S1") -> DetachedWindowController {
        let t = DetachedScriptedTransport()
        let session = SessionModel()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "orb", mode: .pinned(sessionId: sessionId), session: session)
        return DetachedWindowController(feed: feed, session: session, frame: NSRect(x: 0, y: 0, width: 400, height: 400), title: "Test")
    }

    // MARK: - reallyQuitting

    func testReallyQuittingDefaultsFalse() {
        XCTAssertFalse(AppDelegate().reallyQuitting)
    }

    // MARK: - showDockIcon / hideDockIcon

    func testShowDockIconSetsRegularHideDockIconRestoresAccessory() {
        let delegate = AppDelegate()
        XCTAssertEqual(NSApp.activationPolicy(), .accessory, "the xctest host launches LSUIElement — accessory going in")

        delegate.showDockIcon()
        XCTAssertEqual(NSApp.activationPolicy(), .regular)

        delegate.hideDockIcon()
        XCTAssertEqual(NSApp.activationPolicy(), .accessory)
    }

    // MARK: - registerDetachedWindow: promotion / demotion

    func testRegisteringADetachedWindowPromotesTheDockIcon() {
        let delegate = AppDelegate()
        let window = makeDetachedWindow()
        defer { window.close() }

        delegate.registerDetachedWindow(window)

        XCTAssertEqual(NSApp.activationPolicy(), .regular, "opening a real chat window must show the dock icon")
    }

    func testClosingTheLastDetachedWindowDemotesTheDockIcon() {
        let delegate = AppDelegate()
        let window = makeDetachedWindow()
        delegate.registerDetachedWindow(window)
        XCTAssertEqual(NSApp.activationPolicy(), .regular)

        window.close()

        XCTAssertEqual(NSApp.activationPolicy(), .accessory, "closing the last main window must hide the dock icon again")
    }

    func testClosingOneOfTwoDetachedWindowsKeepsTheDockIconUntilTheOtherAlsoCloses() {
        let delegate = AppDelegate()
        let a = makeDetachedWindow(sessionId: "A")
        let b = makeDetachedWindow(sessionId: "B")
        delegate.registerDetachedWindow(a)
        delegate.registerDetachedWindow(b)

        a.close()
        XCTAssertEqual(NSApp.activationPolicy(), .regular, "one main window is still open — the dock icon must stay")

        b.close()
        XCTAssertEqual(NSApp.activationPolicy(), .accessory, "the last main window just closed — demote")
    }

    // MARK: - openDashboard: promotion / demotion

    func testOpeningDashboardPromotesAndClosingItDemotes() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())

        delegate.openDashboard()
        XCTAssertEqual(NSApp.activationPolicy(), .regular, "the Dashboard is a real main window — must show the dock icon")

        delegate.dashboardWindow?.close()
        XCTAssertEqual(NSApp.activationPolicy(), .accessory, "closing the Dashboard with no other main window open must hide the dock icon")
    }

    /// Mixed registries: the dock icon only demotes once BOTH a detached window and the Dashboard
    /// have closed — proves `hasMainWindow`/`syncDockPresence` OR the two registries together
    /// rather than either one alone.
    func testDetachedWindowAndDashboardTogetherOnlyDemoteAfterBothClose() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        let window = makeDetachedWindow()
        delegate.registerDetachedWindow(window)
        delegate.openDashboard()
        XCTAssertEqual(NSApp.activationPolicy(), .regular)

        delegate.dashboardWindow?.close()
        XCTAssertEqual(NSApp.activationPolicy(), .regular, "the detached window is still open — the dock icon must stay")

        window.close()
        XCTAssertEqual(NSApp.activationPolicy(), .accessory, "both main windows are now closed — demote")
    }

    // MARK: - applicationShouldTerminate: source-aware quit gate

    func testApplicationShouldTerminateCancelsAndClosesWindowsWhenNotReallyQuitting() {
        let delegate = AppDelegate()
        // Pin the seam rather than relying on the host's (absent) current Apple Event — this test
        // is about the plain-⌘Q path, so the system axis must be deterministically false.
        delegate.systemQuitReasonProvider = { false }
        let window = makeDetachedWindow()
        delegate.registerDetachedWindow(window)
        XCTAssertEqual(NSApp.activationPolicy(), .regular)
        XCTAssertFalse(delegate.reallyQuitting, "default — only the menu-bar Quit ever flips this")

        let reply = delegate.applicationShouldTerminate(NSApp)

        XCTAssertEqual(reply, .terminateCancel)
        XCTAssertTrue(delegate.detachedWindows.isEmpty, "⌘Q/dock-quit must close the main windows, not just cancel silently")
        XCTAssertEqual(NSApp.activationPolicy(), .accessory, "⌘Q/dock-quit must demote the dock icon back to accessory")
    }

    func testApplicationShouldTerminateAllowsTerminationAndLeavesWindowsAloneWhenReallyQuitting() {
        let delegate = AppDelegate()
        delegate.systemQuitReasonProvider = { false }
        let window = makeDetachedWindow()
        delegate.registerDetachedWindow(window)
        defer { window.close() }
        delegate.reallyQuitting = true

        let reply = delegate.applicationShouldTerminate(NSApp)

        XCTAssertEqual(reply, .terminateNow)
        XCTAssertFalse(delegate.detachedWindows.isEmpty, "a real quit must not run the cancel-path window teardown — AppKit's own termination handles that")
        XCTAssertEqual(NSApp.activationPolicy(), .regular, "a real quit doesn't demote — the app is exiting")
    }

    /// T3 review fix: a system LOGOUT/RESTART/SHUTDOWN quit (the Apple Event carries a system
    /// quit reason) must terminate even though `reallyQuitting` is false — the pre-fix code
    /// answered it `.terminateCancel` and blocked the user's logout indefinitely. Driven through
    /// the injectable seam; the real Apple-Event read (`isSystemInitiatedQuitEvent`) can't be
    /// exercised from a unit test without synthesizing a logout event against the host.
    func testApplicationShouldTerminateAllowsSystemInitiatedQuitEvenWhenNotReallyQuitting() {
        let delegate = AppDelegate()
        delegate.systemQuitReasonProvider = { true } // a logout/restart/shutdown is in flight
        let window = makeDetachedWindow()
        delegate.registerDetachedWindow(window)
        defer { window.close() }
        XCTAssertFalse(delegate.reallyQuitting, "the menu-bar Quit was never involved — this is purely the system axis")

        let reply = delegate.applicationShouldTerminate(NSApp)

        XCTAssertEqual(reply, .terminateNow, "a system logout/shutdown must never be refused")
        XCTAssertFalse(delegate.detachedWindows.isEmpty, "the cancel-path teardown must not run — applicationWillTerminate owns real-quit teardown")
    }

    /// The host process has no current quit Apple Event, so the REAL default provider must read
    /// as user-initiated — proves the default wiring fails toward the cancel path (never toward
    /// accidentally letting a plain ⌘Q terminate), and covers the no-event branch of
    /// `isSystemInitiatedQuitEvent` directly.
    func testIsSystemInitiatedQuitEventIsFalseWithoutAQuitAppleEvent() {
        XCTAssertFalse(isSystemInitiatedQuitEvent())
    }

    // MARK: - Lifecycle T6: DaemonSupervisor composed into boot()/applicationWillTerminate

    /// Builds `DaemonSupervisorDeps` that always spawns a `FakeDaemonProcess` (via
    /// `DaemonSupervisorTests.swift`'s test double) — the SAME seam production `boot()` uses, but
    /// wired so nothing real is ever launched from the xctest host. `onSpawn` is handed every
    /// spawned fake so the caller can collect them and drive `simulateExit`/inspect call counts —
    /// a plain captured-by-reference local `var` in the caller, same posture as
    /// `DaemonSupervisorTests`' own `procs` arrays.
    private func fakeSupervisorDeps(
        onSpawn: @escaping (FakeDaemonProcess) -> Void,
        socketExists: @escaping () -> Bool = { false }
    ) -> DaemonSupervisorDeps {
        DaemonSupervisorDeps(
            bundledDaemonPath: { "/x/norma-core" },
            socketExists: socketExists,
            isDevEnv: { false },
            spawn: { _ in let p = FakeDaemonProcess(); onSpawn(p); return p },
            now: { Date() }
        )
    }

    /// Task 6 brief, Step 1: `applicationWillTerminate` must stop the daemon supervisor — proven
    /// via the SAME `DaemonSupervisorDeps` seam `DaemonSupervisorTests` builds its `FakeDaemonProcess`
    /// spies with, injected through `AppDelegate.daemonSupervisorDeps` BEFORE `boot()`.
    func testApplicationWillTerminateStopsTheDaemonSupervisor() {
        var procs: [FakeDaemonProcess] = []
        let delegate = AppDelegate()
        delegate.daemonSupervisorDeps = fakeSupervisorDeps(onSpawn: { procs.append($0) })
        XCTAssertTrue(delegate.boot())
        XCTAssertEqual(procs.count, 1, "boot() must have spawned exactly once (supervising mode)")
        XCTAssertEqual(procs[0].terminateGracefullyCallCount, 0)

        delegate.applicationWillTerminate(Notification(name: Notification.Name("test")))

        XCTAssertEqual(procs[0].terminateGracefullyCallCount, 1, "terminate must stop the supervised daemon")
    }

    /// T4 review finding (5f), embedded in the T6 brief: `migrateFromLaunchdAgent` MUST run before
    /// `DaemonSupervisor.start()`'s socket-exists probe — a stale launchd-managed daemon's live
    /// socket would otherwise send the supervisor into `.connectOnly` and permanently defeat "app
    /// quit -> daemon quit". Proven via an ordering spy threaded through BOTH seams
    /// (`launchdMigrationOverride` and `daemonSupervisorDeps.socketExists`).
    func testMigrationRunsBeforeSupervisorSocketProbe() {
        var order: [String] = []
        let delegate = AppDelegate()
        delegate.launchdMigrationOverride = { order.append("migrate") }
        delegate.daemonSupervisorDeps = fakeSupervisorDeps(
            onSpawn: { _ in },
            socketExists: { order.append("socketCheck"); return false }
        )

        XCTAssertTrue(delegate.boot())

        XCTAssertEqual(order, ["migrate", "socketCheck"], "migration must complete before the socket probe runs")
    }

    /// A `.failed` supervisor (rapid-respawn cap tripped) must flip the menu-bar state line to the
    /// actionable "engine stopped — Restart" item, and that item's action must call
    /// `DaemonSupervisor.restart()` — proving the `onStateChange`/`onRestartDaemon` wiring `boot()`
    /// installs end-to-end, not just each half in isolation.
    func testFailedSupervisorStateUpdatesMenuBarAndRestartRecovers() {
        var procs: [FakeDaemonProcess] = []
        let delegate = AppDelegate()
        delegate.daemonSupervisorDeps = fakeSupervisorDeps(onSpawn: { procs.append($0) })
        XCTAssertTrue(delegate.boot())

        for _ in 0..<6 { procs.last!.simulateExit(intentional: false) } // trips the rapid-respawn cap

        XCTAssertEqual(delegate.daemonSupervisor?.state, .failed)
        XCTAssertEqual(delegate.menuBar?.stateItem.title, "engine stopped — Restart")
        XCTAssertTrue(delegate.menuBar?.stateItem.isEnabled ?? false)

        let item = delegate.menuBar!.stateItem
        NSApp.sendAction(item.action!, to: item.target, from: item)

        XCTAssertEqual(delegate.daemonSupervisor?.state, .running, "the menu item's action must call restart()")
    }

    // MARK: - applicationShouldHandleReopen

    func testApplicationShouldHandleReopenReturnsTrueWhenAMainWindowAlreadyExists() {
        let delegate = AppDelegate()
        let window = makeDetachedWindow()
        delegate.registerDetachedWindow(window)
        defer { window.close() }

        XCTAssertTrue(delegate.applicationShouldHandleReopen(NSApp, hasVisibleWindows: true), "a main window is already open — let AppKit's default reopen handling bring it forward")
    }

    func testApplicationShouldHandleReopenAttemptsToOpenAWindowWhenNoneExistsAndReturnsFalse() {
        let delegate = AppDelegate() // never booted — summonAppWindow no-ops (no appModel)

        let handled = delegate.applicationShouldHandleReopen(NSApp, hasVisibleWindows: false)

        XCTAssertFalse(handled, "no main window existed — this call must have attempted to open one itself, leaving nothing for AppKit's default handling")
        XCTAssertTrue(delegate.detachedWindows.isEmpty, "no appModel to open against — the attempt no-ops safely (same guard as summonAppWindow's other callers)")
    }
}
