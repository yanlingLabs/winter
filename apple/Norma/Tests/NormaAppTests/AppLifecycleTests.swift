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
/// Dock seam retarget: these tests used to flip the REAL `NSApp.activationPolicy()` of the xctest
/// host. With the seam (`DockPolicy.apply`, swapped for `HarnessTeardownObserver`'s recorder at
/// bundle load) the host can never really promote — a killed/cancelled clone can no longer strand
/// a ghost Dock tile — so the dock-presence pins below assert the recorded SEQUENCE of applied
/// policies instead: every transition production attempted, in order, which is strictly stronger
/// than the end-state reads they replaced. The recorder is cleared after every case (observer),
/// so each test reads exactly its own applications; the observer's tripwire separately pins that
/// the REAL policy never moved.
@MainActor
final class AppLifecycleTests: XCTestCase {

    /// The seam recorder, under a case-local name — the policies production applied since this
    /// case started.
    private var applied: [NSApplication.ActivationPolicy] { HarnessTeardownObserver.recordedPolicies }
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
        XCTAssertEqual(NSApp.activationPolicy(), .accessory, "the xctest host launches LSUIElement — accessory going in (a real read, still valid: the seam means nothing under test can change it)")
        XCTAssertEqual(applied, [], "no dock-policy application yet")

        delegate.showDockIcon()
        XCTAssertEqual(applied, [.regular])

        delegate.hideDockIcon()
        XCTAssertEqual(applied, [.regular, .accessory])
    }

    // MARK: - registerDetachedWindow: promotion / demotion

    func testRegisteringADetachedWindowPromotesTheDockIcon() {
        let delegate = AppDelegate()
        let window = makeDetachedWindow()
        defer { window.close() }

        delegate.registerDetachedWindow(window)

        XCTAssertEqual(applied, [.regular], "opening a real chat window must apply the dock-icon promotion")
    }

    func testClosingTheLastDetachedWindowDemotesTheDockIcon() {
        let delegate = AppDelegate()
        let window = makeDetachedWindow()
        delegate.registerDetachedWindow(window)
        XCTAssertEqual(applied, [.regular])

        window.close()

        XCTAssertEqual(applied, [.regular, .accessory], "closing the last main window must apply the demotion")
    }

    func testClosingOneOfTwoDetachedWindowsKeepsTheDockIconUntilTheOtherAlsoCloses() {
        let delegate = AppDelegate()
        let a = makeDetachedWindow(sessionId: "A")
        let b = makeDetachedWindow(sessionId: "B")
        delegate.registerDetachedWindow(a)
        delegate.registerDetachedWindow(b)
        // `syncDockPresence` applies unconditionally on every registry mutation, so two registers
        // are two `.regular` applications — the duplicates are the machinery's real behavior, and
        // the pin is the full transition sequence. Don't "fix" them here.
        XCTAssertEqual(applied, [.regular, .regular])

        a.close()
        XCTAssertEqual(applied, [.regular, .regular, .regular], "one main window is still open — the close's re-sync must re-apply promotion, never demote")

        b.close()
        XCTAssertEqual(applied, [.regular, .regular, .regular, .accessory], "the last main window just closed — demote")
    }

    // Task 7: `testOpeningDashboardPromotesAndClosingItDemotes` and
    // `testDetachedWindowAndDashboardTogetherOnlyDemoteAfterBothClose` DIED here — their subject
    // (a SEPARATE `dashboardWindow` registry, OR'd with `detachedWindows`/`appWindow` in
    // `hasMainWindow`) no longer exists: the Dashboard is a shell DESTINATION now
    // (`ShellDestination.dashboard(pane:)`), not a second window with its own dock-promotion
    // registry. `hasMainWindow`'s remaining OR (`detachedWindows` vs `appWindow?.isVisible`) is
    // already covered — the detached-window half by
    // `testClosingOneOfTwoDetachedWindowsKeepsTheDockIconUntilTheOtherAlsoCloses` above, the
    // shell half by `AppShellTests.testShellPromotesTheDockIconAndHidingDemotes` — and dock
    // promotion has never distinguished WHICH destination the shell is showing, only whether it's
    // visible at all, so a Dashboard-specific promotion test would only re-prove the same fact a
    // third way.

    // MARK: - applicationShouldTerminate: source-aware quit gate

    func testApplicationShouldTerminateCancelsAndClosesWindowsWhenNotReallyQuitting() {
        let delegate = AppDelegate()
        // Pin the seam rather than relying on the host's (absent) current Apple Event — this test
        // is about the plain-⌘Q path, so the system axis must be deterministically false.
        delegate.systemQuitReasonProvider = { false }
        let window = makeDetachedWindow()
        delegate.registerDetachedWindow(window)
        XCTAssertEqual(applied, [.regular])
        XCTAssertFalse(delegate.reallyQuitting, "default — only the menu-bar Quit ever flips this")

        let reply = delegate.applicationShouldTerminate(NSApp)

        XCTAssertEqual(reply, .terminateCancel)
        XCTAssertTrue(delegate.detachedWindows.isEmpty, "⌘Q/dock-quit must close the main windows, not just cancel silently")
        // Two demotions, deliberately: the closed window's own `onClosed` → `syncDockPresence`
        // applies one, then the cancel branch's explicit belt-and-suspenders `hideDockIcon()`
        // (for the nothing-was-open edge) applies another. The duplicate IS the machinery.
        XCTAssertEqual(applied, [.regular, .accessory, .accessory], "⌘Q/dock-quit must demote the dock icon back to accessory")
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
        XCTAssertEqual(applied, [.regular], "a real quit doesn't demote — the register's promotion stands and no demotion was ever applied; the app is exiting")
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

    // MARK: - editor-product Task 10: the quit path's dirty-editor gate (PURE)

    private func dirtyState(_ path: String, dirty: Bool = true) -> EditorRuntimeState {
        var state = EditorRuntimeState()
        state.models[path] = EditorRuntimeState.ModelEntry(dirty: dirty)
        return state
    }

    func testQuitDirtyFilePathsGathersEveryDirtyModelAcrossEveryRuntimeAndIgnoresCleanOnes() {
        let clean = dirtyState("/repo/clean.ts", dirty: false)
        var mixed = dirtyState("/repo/a.ts", dirty: true)
        mixed.models["/repo/clean2.ts"] = EditorRuntimeState.ModelEntry(dirty: false)
        let secondRuntime = dirtyState("/other/b.ts", dirty: true)

        XCTAssertEqual(quitDirtyFilePaths(runtimeStates: []), [])
        XCTAssertEqual(quitDirtyFilePaths(runtimeStates: [clean]), [], "nothing dirty, nothing gathered")
        // Two runtimes: `Dictionary` iteration order is not guaranteed, so this is a Set, never a
        // positional array comparison.
        XCTAssertEqual(Set(quitDirtyFilePaths(runtimeStates: [mixed, secondRuntime])),
                       Set(["/repo/a.ts", "/other/b.ts"]))
    }

    /// **Obligation 6's pin, at exactly the level it belongs**: this decision, not "did teardown
    /// run" (that is unconditional — see `EditorQuitGate`'s own tests below).
    func testQuitDirtyGateDecisionIsProceedUntouchedOnlyWhenNothingIsDirty() {
        XCTAssertEqual(quitDirtyGateDecision(dirtyPaths: []), .proceedUntouched)
        XCTAssertEqual(quitDirtyGateDecision(dirtyPaths: ["/repo/a.ts"]),
                       .confirm(dirtyPaths: ["/repo/a.ts"]))
    }

    func testQuitGateActionMapsReviewToCancelAndQuitAnywayToProceed() {
        XCTAssertEqual(quitGateAction(choice: .review), .cancelQuit)
        XCTAssertEqual(quitGateAction(choice: .quitAnyway), .proceedWithTeardown)
    }

    func testQuitDirtyAlertTitleIsSingularAware() {
        XCTAssertEqual(quitDirtyAlertTitle(count: 1), "1 unsaved file")
        XCTAssertEqual(quitDirtyAlertTitle(count: 2), "2 unsaved files")
        XCTAssertEqual(quitDirtyAlertTitle(count: 0), "0 unsaved files")
    }

    /// Sorted (a stable list — `quitDirtyFilePaths`' own order is whatever one run's `Dictionary`
    /// iteration gives it) and capped at `quitDirtyAlertListCap` with a "…and N more" tail.
    func testQuitDirtyAlertFileListSortsAndCapsWithAnAndNMoreTail() {
        XCTAssertEqual(quitDirtyAlertFileList(dirtyPaths: ["/repo/b.ts", "/repo/a.ts"]), "a.ts\nb.ts")
        XCTAssertEqual(quitDirtyAlertListCap, 5, "the cap this test's fixture below is built against")
        let many = (1...7).map { "/repo/f\($0).ts" }
        XCTAssertEqual(quitDirtyAlertFileList(dirtyPaths: many),
                       "f1.ts\nf2.ts\nf3.ts\nf4.ts\nf5.ts\n…and 2 more")
    }

    // MARK: - EditorQuitGate: the orchestration, driven with spies
    //
    // Never a real BrowserRuntime/CEF/NSApp.terminate stack — and never `run()`/`proceedWithQuit` on
    // a REAL AppDelegate with `reallyQuitting == true`: that would reach `NSApp.terminate`, which
    // `applicationShouldTerminate` would answer `.terminateNow` for, tearing down the xctest host
    // itself mid-suite. `EditorQuitGate`'s injected seams are exactly what make the ORDERING
    // obligation (T3 review: teardown for every live runtime BEFORE the settle beat) provable
    // without touching any of that.

    func testEditorQuitGateProceedsUntouchedTearsDownEveryRuntimeAndNeverPresentsAnAlertWhenNothingIsDirty() {
        var order: [String] = []
        var presented = 0
        var cancelled = 0
        let gate = EditorQuitGate(
            dirtyRuntimeStates: { [] },
            teardownAllRuntimes: { order.append("teardown"); return 2 },
            presentAlert: { _ in presented += 1; return .review },
            proceedWithQuit: { count in order.append("proceed(\(count))") },
            cancelQuit: { cancelled += 1 })

        gate.run()

        XCTAssertEqual(order, ["teardown", "proceed(2)"],
                       "obligation 1: teardown runs even with nothing dirty (clean runtimes too), "
                       + "strictly before proceed")
        XCTAssertEqual(presented, 0, "obligation 6's pin: zero dirty ⇒ no alert, ever constructed")
        XCTAssertEqual(cancelled, 0)
    }

    func testEditorQuitGateReviewCancelsWithoutTearingDownOrProceeding() {
        var teardownCalls = 0
        var proceedCalls = 0
        var cancelled = 0
        let gate = EditorQuitGate(
            dirtyRuntimeStates: { [self.dirtyState("/repo/a.ts")] },
            teardownAllRuntimes: { teardownCalls += 1; return 1 },
            presentAlert: { _ in .review },
            proceedWithQuit: { _ in proceedCalls += 1 },
            cancelQuit: { cancelled += 1 })

        gate.run()

        XCTAssertEqual(cancelled, 1)
        XCTAssertEqual(teardownCalls, 0, "Review must never tear anything down")
        XCTAssertEqual(proceedCalls, 0, "Review must never proceed to the browser sweep")
    }

    /// **The order pin.** A second, CLEAN runtime is in the mix deliberately — obligation 1 says
    /// EVERY live runtime, not only the dirty one the alert asked about.
    func testEditorQuitGateQuitAnywayTearsDownEveryRuntimeBeforeProceedingWithTheCount() {
        var order: [String] = []
        var presentedPaths: [String]?
        let gate = EditorQuitGate(
            dirtyRuntimeStates: { [self.dirtyState("/repo/a.ts", dirty: true),
                                  self.dirtyState("/repo/b.ts", dirty: false)] },
            teardownAllRuntimes: { order.append("teardown"); return 2 },
            presentAlert: { paths in presentedPaths = paths; return .quitAnyway },
            proceedWithQuit: { count in order.append("proceed(\(count))") },
            cancelQuit: { XCTFail("Quit Anyway must never cancel") })

        gate.run()

        XCTAssertEqual(presentedPaths, ["/repo/a.ts"], "only the dirty model is asked about")
        XCTAssertEqual(order, ["teardown", "proceed(2)"],
                       "obligation 1: EVERY live runtime is torn down — the clean second one too — "
                       + "strictly before proceedWithQuit, which owns the settle beat")
    }

    // MARK: - reallyQuitting reset on Review (necessary for correctness; not named in the brief)

    /// **This gate is the FIRST cancellable point the true-quit path has ever had.**
    /// `reallyQuitting` is armed by the menu's `onReallyQuit()` BEFORE this gate ever runs
    /// (`MenuBarController.didQuit`'s own ordering doc) and nothing else in this file ever resets
    /// it — so a Review that left it `true` would corrupt every LATER plain ⌘Q into a silent full
    /// quit (the exact corruption class `updaterQuitting`'s own doc comment already names for a
    /// stale `reallyQuitting = true`). Driven by calling `cancelQuit` DIRECTLY — never `run()` or
    /// `proceedWithQuit` on a real delegate with `reallyQuitting == true` (see this section's own
    /// header comment for why that is unsafe here).
    func testEditorQuitGateCancelQuitResetsReallyQuittingSoALaterPlainQuitDoesNotSilentlyFullyQuit() {
        let delegate = AppDelegate()
        delegate.reallyQuitting = true // simulates the menu-bar Quit's own onReallyQuit() firing

        delegate.editorQuitGate.cancelQuit()

        XCTAssertFalse(delegate.reallyQuitting,
                       "Review must undo the arm, or a later plain ⌘Q silently full-quits")
    }
}
