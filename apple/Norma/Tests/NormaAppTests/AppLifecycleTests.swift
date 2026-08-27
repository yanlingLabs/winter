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

    // MARK: - office-plumbing Task 5: the quit sweep grows the office leg

    /// **The order pin** (the plan's own sequence style: `["editorTeardown", "officeTeardown",
    /// "proceed"]`), as a documented equivalent of that literal array. The REAL
    /// `AppDelegate.editorQuitGate` wiring runs BOTH legs inside its ONE `teardownAllRuntimes`
    /// closure — a straight-line synchronous function body (the editor loop, then ONE call to
    /// `teardownAllOfficeRuntimesAndStopHelper()`, then `return`), so Swift's own execution order
    /// is what pins "editor leg before office leg" here; there is no concurrency between them for a
    /// test to race. This spy stands in for that closure's two-line body — see
    /// `testAppDelegateTeardownAllRuntimesClosureWalksBothRuntimeTablesAndStopsTheSharedOfficeHelper`
    /// immediately below for the proof that the REAL wiring (not merely this spy's say-so) reaches
    /// both tables.
    func testEditorQuitGateTeardownAllRuntimesRepresentsBothLegsStrictlyBeforeProceed() {
        var order: [String] = []
        let gate = EditorQuitGate(
            dirtyRuntimeStates: { [] },
            teardownAllRuntimes: {
                order.append("editorTeardown") // host.teardownEditorRuntime(for:), looped
                order.append("officeTeardown") // host.teardownAllOfficeRuntimesAndStopHelper()
                return 2
            },
            presentAlert: { _ in .review },
            proceedWithQuit: { count in order.append("proceed(\(count))") },
            cancelQuit: { XCTFail("nothing is dirty here — cancelQuit must never run") })

        gate.run()

        XCTAssertEqual(order, ["editorTeardown", "officeTeardown", "proceed(2)"],
                       "both legs complete, in order, strictly before the settle beat")
    }

    /// **The real-wiring proof**: `AppDelegate.editorQuitGate.teardownAllRuntimes` — the actual
    /// production closure, not a spy standing in for it — reaches a REAL `ShellSessionHost` and
    /// tears down BOTH tables. Driven the same way
    /// `testEditorQuitGateCancelQuitResetsReallyQuittingSoALaterPlainQuitDoesNotSilentlyFullyQuit`
    /// already established is safe: calling one closure DIRECTLY, never `run()`/`proceedWithQuit` on
    /// a delegate with `reallyQuitting == true` (see this file's own header on why that would reach
    /// `NSApp.terminate` from inside the xctest host). `setAppWindowForTesting` is the seam that
    /// makes a REAL host reachable here without booting the rest of the app shell.
    ///
    /// No editor runtimes are minted (Task 10's own suite already proves that leg's behavior
    /// thoroughly; re-proving it here would only test-double what T10 already owns for real) — this
    /// test's only job is proving Task 5's ADDITION is actually wired into the closure T10 built,
    /// not a parallel one that looks right in isolation but is never reached.
    func testAppDelegateTeardownAllRuntimesClosureWalksBothRuntimeTablesAndStopsTheSharedOfficeHelper() {
        let directory = SessionDirectory(lister: { [] })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        // Mints the shared, never-started (inert — no process spawn happens until `start()`)
        // `OfficeHelperSupervisor`, exactly as any first office door would.
        _ = host.officeRuntime(for: "S1")
        XCTAssertEqual(host.officeRuntimes.count, 1)
        XCTAssertNotNil(host.officeHelperSupervisor)

        let controller = AppWindowController(directory: directory, host: host,
                                             frame: NSRect(x: 0, y: 0, width: 100, height: 100))
        let delegate = AppDelegate()
        delegate.setAppWindowForTesting(controller)

        let torn = delegate.editorQuitGate.teardownAllRuntimes()

        XCTAssertEqual(torn, 0, "the returned count stays EDITOR-only (feeds the CEF settle beat, "
                       + "which the office leg has no equivalent of) — zero editor runtimes were "
                       + "ever minted in this test")
        XCTAssertEqual(host.officeRuntimes.count, 0, "the office leg ran too, inside the SAME closure")
        XCTAssertEqual(host.officeHelperSupervisor?.state, .stopped, "and it stopped the shared helper")
    }

    /// The office leg must not misbehave on a host that never touched office at all — the ordinary
    /// case for every quit until a document tab has actually been opened once.
    func testAppDelegateTeardownAllRuntimesToleratesAHostThatNeverTouchedOffice() {
        let directory = SessionDirectory(lister: { [] })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        XCTAssertNil(host.officeHelperSupervisor)

        let controller = AppWindowController(directory: directory, host: host,
                                             frame: NSRect(x: 0, y: 0, width: 100, height: 100))
        let delegate = AppDelegate()
        delegate.setAppWindowForTesting(controller)

        let torn = delegate.editorQuitGate.teardownAllRuntimes()

        XCTAssertEqual(torn, 0)
        XCTAssertNil(host.officeHelperSupervisor, "still never minted — the quit leg must not "
                     + "construct one just to immediately stop it")
    }

    // MARK: - Office Stage B Task 3: the quit gate's office leg (PURE)

    private func officeDirtyState(_ path: String, dirty: Bool = true) -> OfficeRuntimeState {
        var state = OfficeRuntimeState()
        state.documents[path] = OfficeRuntimeState.DocumentEntry(
            docId: "doc-\(path)", stagedPath: "/tmp/staged-\(path)", type: .spreadsheet, parts: 1,
            sizeTwips: OfficeDocumentSize(widthTwips: 100, heightTwips: 100), dirty: dirty)
        return state
    }

    /// Small, bounded polling helper — this file's own version of `ShellSessionHostTests
    /// .officeWaitUntil` (there is no existing one here to reuse; the two test targets do not share
    /// private helpers across files). Never an unconditional sleep: every caller checks a real
    /// condition each pass, so this only ever waits as long as Swift's own async machinery actually
    /// takes to settle, bounded by `timeout` as the failure backstop.
    private func waitUntil(timeout: TimeInterval = 2, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() >= deadline { return false }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        return true
    }

    /// `quitDirtyFilePathsGathersEveryDirtyModelAcrossEveryRuntimeAndIgnoresCleanOnes`'s own
    /// `.document` mirror.
    func testOfficeDirtyFilePathsGathersEveryDirtyDocumentAcrossEveryRuntimeAndIgnoresCleanOnes() {
        let clean = officeDirtyState("/repo/clean.xlsx", dirty: false)
        var mixed = officeDirtyState("/repo/a.xlsx", dirty: true)
        mixed.documents["/repo/clean2.xlsx"] = OfficeRuntimeState.DocumentEntry(
            docId: "doc-clean2", stagedPath: "/tmp/staged-clean2", type: .spreadsheet, parts: 1,
            sizeTwips: OfficeDocumentSize(widthTwips: 100, heightTwips: 100), dirty: false)
        let secondRuntime = officeDirtyState("/other/b.xlsx", dirty: true)

        XCTAssertEqual(officeDirtyFilePaths(runtimeStates: []), [])
        XCTAssertEqual(officeDirtyFilePaths(runtimeStates: [clean]), [], "nothing dirty, nothing gathered")
        XCTAssertEqual(Set(officeDirtyFilePaths(runtimeStates: [mixed, secondRuntime])),
                       Set(["/repo/a.xlsx", "/other/b.xlsx"]))
    }

    /// **The alert is ONE list, both sources.** `EditorQuitGate.run()` concatenates `quitDirtyFilePaths`'
    /// own gather with `officeDirtyFilePaths`'s — a user with one dirty code tab and one dirty
    /// document tab sees a single "2 unsaved files" alert naming both, not two separate prompts.
    func testEditorQuitGateCombinesEditorAndOfficeDirtyPathsIntoOneAlert() {
        var presentedPaths: [String]?
        let gate = EditorQuitGate(
            dirtyRuntimeStates: { [self.dirtyState("/repo/a.ts")] },
            dirtyOfficeRuntimeStates: { [self.officeDirtyState("/repo/b.xlsx")] },
            teardownAllRuntimes: { 2 },
            presentAlert: { paths in presentedPaths = paths; return .quitAnyway },
            proceedWithQuit: { _ in },
            cancelQuit: { XCTFail("Quit Anyway must never cancel") })

        gate.run()

        XCTAssertEqual(Set(presentedPaths ?? []), Set(["/repo/a.ts", "/repo/b.xlsx"]),
                       "both sources' dirty paths reach the SAME alert")
    }

    /// **The regression this test exists to catch**: a quit gate that only ever asked
    /// `dirtyRuntimeStates` would answer `.proceedUntouched` — no alert, straight to teardown — for a
    /// session whose ONLY unsaved work is an office document. `dirtyOfficeRuntimeStates`'s own
    /// default (`{ [] }`, additive so old tests keep compiling) is exactly what would produce that
    /// silent-data-loss shape if `AppDelegate.editorQuitGate`'s real wiring ever forgot to override it
    /// — this test pins the DECISION side of that claim; `testAppDelegateEditorQuitGate
    /// DirtyOfficeRuntimeStatesReadsTheHostsOfficeRuntimeTable` below pins the WIRING side.
    func testEditorQuitGateConfirmsWhenOnlyOfficeIsDirty() {
        var presented = 0
        var proceeded = 0
        let gate = EditorQuitGate(
            dirtyRuntimeStates: { [] },
            dirtyOfficeRuntimeStates: { [self.officeDirtyState("/repo/b.xlsx")] },
            teardownAllRuntimes: { 1 },
            presentAlert: { paths in presented += 1; XCTAssertEqual(paths, ["/repo/b.xlsx"]); return .review },
            proceedWithQuit: { _ in proceeded += 1 },
            cancelQuit: { })

        gate.run()

        XCTAssertEqual(presented, 1, "an office-only dirty document must still gate the quit")
        XCTAssertEqual(proceeded, 0)
    }

    /// **The real-wiring proof**: `AppDelegate.editorQuitGate.dirtyOfficeRuntimeStates` — the actual
    /// production closure, not a spy standing in for it — reaches a REAL `ShellSessionHost` and reads
    /// its `officeRuntimes` table. Mirrors `testAppDelegateTeardownAllRuntimesClosureWalksBothRuntime
    /// TablesAndStopsTheSharedOfficeHelper`'s own proof for `teardownAllRuntimes`, at the GATHER level
    /// instead of the teardown level — the two closures are independent fields on `EditorQuitGate`
    /// (that struct's own doc explains why), so proving one is wired says nothing about the other.
    /// No `.open()` here, deliberately — MINTING alone (`officeRuntime(for:)`) never touches the
    /// driver, so this stays exactly as safe as `testAppDelegateTeardownAllRuntimesClosureWalksBoth
    /// RuntimeTablesAndStopsTheSharedOfficeHelper`'s own identical choice.
    func testAppDelegateEditorQuitGateDirtyOfficeRuntimeStatesReadsTheHostsOfficeRuntimeTable() {
        let directory = SessionDirectory(lister: { [] })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        _ = host.officeRuntime(for: "S1")
        XCTAssertEqual(host.officeRuntimes.count, 1)

        let controller = AppWindowController(directory: directory, host: host,
                                             frame: NSRect(x: 0, y: 0, width: 100, height: 100))
        let delegate = AppDelegate()
        delegate.setAppWindowForTesting(controller)

        let states = delegate.editorQuitGate.dirtyOfficeRuntimeStates()

        XCTAssertEqual(states.count, 1, "the real closure must read the host's officeRuntimes table, "
                       + "not the struct's own defaulted empty array")
    }

    // MARK: - Office Stage B Task 3: Sparkle's dirty-editors gate grows an office leg

    /// A scripted, fully in-process `Driver` — no real helper process, so `runtime.open` resolves in
    /// this test host exactly as `OfficeRuntimeWatcherTests.makeDriver` (`OfficeRuntimeReducerTests.swift`)
    /// resolves in its own file; duplicated here rather than shared because that helper is `private`
    /// to a different test target file, and the seam is four fields, not worth threading across files.
    private func scratchOfficeDriver() -> OfficeRuntime.Driver {
        OfficeRuntime.Driver(
            helperState: { .ready }, startHelper: { },
            open: { _, _, _ in OfficeDocumentMetadata(
                type: .spreadsheet, parts: 1, sizeTwips: OfficeDocumentSize(widthTwips: 100, heightTwips: 100)) },
            close: { _ in }, save: { _, _ in "/tmp/live-dirty-gate-unused-save" },
            subscribeTiles: { _, _, _, _ in [] }, unsubscribeTiles: { _ in }, requestTiles: { _, _ in },
            postKey: { _, _, _, _, _ in }, postMouse: { _, _, _, _, _, _, _, _ in },
            postExtTextInput: { _, _, _, _ in },
            clipboardCopy: { _, _ in nil },
            clipboardCut: { _, _ in nil },
            clipboardPaste: { _, _, _ in },
            undo: { _, _ in },
            redo: { _, _ in },
            // office-live-edit R3 — `nil` = "this stub cannot answer", which every caller reads as
            // "fall back to ONE action", i.e. exactly the pre-R3 granularity these tests were written
            // against. Never 0: a zero would mean "undo nothing".
            undoDepth: { _ in nil },
            sheetsInfo: { _ in throw OfficeHelperClientError.serverError(reason: "fake driver: sheets not implemented") },
            sheetsRead: { _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: sheets not implemented") },
            sheetsSet: { _, _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: sheets not implemented") },
            sheetsResize: { _, _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: sheets not implemented") },
            sheetsManageSheet: { _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: sheets not implemented") },
            sheetsManageSheetBatch: { _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: sheets batch not implemented") },
            sheetsFormat: { _, _, _, _, _, _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: sheets not implemented") },
            slidesInfo: { _ in throw OfficeHelperClientError.serverError(reason: "fake driver: slides not implemented") },
            slidesRead: { _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: slides not implemented") },
            slidesSetText: { _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: slides not implemented") },
            slidesManagePage: { _, _, _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: slides not implemented") },
            slidesManagePageBatch: { _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: slides batch not implemented") },
            docsInfo: { _ in throw OfficeHelperClientError.serverError(reason: "fake driver: docs not implemented") },
            docsRead: { _ in throw OfficeHelperClientError.serverError(reason: "fake driver: docs not implemented") },
            docsReplace: { _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: docs not implemented") },
            docsInsert: { _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: docs not implemented") },
            stateDirectory: FileManager.default.temporaryDirectory
                .appendingPathComponent("live-dirty-gate-state-\(UUID().uuidString)", isDirectory: true))
    }

    /// **The claim `deps.dirtyEditors`'s own wiring comment makes**: an in-flight Sparkle install must
    /// defer for a genuinely dirty OFFICE document, exactly as it already does for a dirty editor
    /// model — proven end-to-end (a real open, a real `.modifiedChanged(true)` callback, read back
    /// through the SAME method `AppDelegate.boot()` actually wires into `deps.dirtyEditors`), not
    /// merely at the pure-function or wiring-only level the two tests above stop at.
    func testLiveDirtyEditorsOrOfficeDocumentsIsTrueWhenAnOfficeDocumentIsGenuinelyDirty() async throws {
        let directory = SessionDirectory(lister: { [] })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        let driver = scratchOfficeDriver()
        host.makeOfficeRuntime = { sessionId, _ in OfficeRuntime(sessionId: sessionId, driver: driver) }
        let runtime = host.officeRuntime(for: "S1")
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("live-dirty-gate-\(UUID().uuidString).xlsx").path
        try Data().write(to: URL(fileURLWithPath: path))
        defer { try? FileManager.default.removeItem(atPath: path) }
        runtime.open(path)
        let opened = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        XCTAssertTrue(opened, "setup: the scripted open must land")

        let controller = AppWindowController(directory: directory, host: host,
                                             frame: NSRect(x: 0, y: 0, width: 100, height: 100))
        let delegate = AppDelegate()
        delegate.setAppWindowForTesting(controller)
        XCTAssertFalse(delegate.liveDirtyEditorsOrOfficeDocuments(), "clean so far — nothing to defer for")

        let docId = try XCTUnwrap(runtime.stateSnapshot.documents[path]?.docId)
        runtime.handle(documentEvent: .modifiedChanged(true), docId: docId)

        XCTAssertTrue(delegate.liveDirtyEditorsOrOfficeDocuments(), "a dirty office document, with no "
                     + "dirty editor at all, must still trip Sparkle's install-deferral gate")
    }

    func testLiveDirtyEditorsOrOfficeDocumentsIsFalseWithNoAppWindow() {
        let delegate = AppDelegate()
        XCTAssertFalse(delegate.liveDirtyEditorsOrOfficeDocuments(), "no host at all reads as clean, "
                       + "never as an error")
    }

    // MARK: - Office Stage B Task 9, fix round 1 (review F3): the quit gate must agree with the mask

    /// **The quit gate's own leg of the claim the test above proves for Sparkle's dirty gate** —
    /// `officeDirtyFilePaths` must never name a read-only-format document, because its `dirty` field
    /// can no longer BECOME true for one, gated at the single writer (`.modifiedStatusChanged`'s
    /// reducer arm), not merely at `officeDocumentIsDirty`'s own UI-facing mask. Driving state
    /// through the REAL reducer (`runtime.handle(documentEvent:docId:)`, exactly like the sibling
    /// test above) is the whole point — a test that hand-set `dirty = true` on a struct literal
    /// (`officeDirtyState`'s own helper above, used elsewhere on purpose for a DIFFERENT concern that
    /// already knows its dirty flag is genuine) would pass by construction without ever exercising
    /// the fix, since `officeDirtyFilePaths` itself still reads the field raw either way.
    func testOfficeDirtyFilePathsNeverNamesAReadOnlyFormatDocumentEvenAfterAGenuineModifiedChangedTrue() async throws {
        let directory = SessionDirectory(lister: { [] })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        let driver = scratchOfficeDriver()
        host.makeOfficeRuntime = { sessionId, _ in OfficeRuntime(sessionId: sessionId, driver: driver) }
        let runtime = host.officeRuntime(for: "S1")
        // .xlsm — Task 9's own widened, read-only-format extension: no OfficeSaveFormat case, so
        // officeDocumentIsReadOnlyFormat(path:) (PanelEditorTab.swift) is true for it.
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("read-only-quit-gate-\(UUID().uuidString).xlsm").path
        try Data().write(to: URL(fileURLWithPath: path))
        defer { try? FileManager.default.removeItem(atPath: path) }
        runtime.open(path)
        let opened = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        XCTAssertTrue(opened, "setup: the scripted open must land")

        let docId = try XCTUnwrap(runtime.stateSnapshot.documents[path]?.docId)
        runtime.handle(documentEvent: .modifiedChanged(true), docId: docId)

        XCTAssertFalse(runtime.stateSnapshot.documents[path]?.dirty ?? true, "the writer itself must "
                       + "never set dirty=true for a read-only-format path, even on a genuine "
                       + "ModifiedStatus=true callback")
        XCTAssertEqual(officeDirtyFilePaths(runtimeStates: [runtime.stateSnapshot]), [], "the quit "
                       + "gate must never name a read-only document as unsaved — before this fix it "
                       + "read dirty RAW and disagreed with officeDocumentIsDirty's own masked answer")
    }
}
