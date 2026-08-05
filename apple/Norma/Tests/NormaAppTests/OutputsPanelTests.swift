import XCTest
import AppKit
import NormaKit
@testable import Norma

/// app-shell T9 (spec §3): the floating corner panel's SEAM — everything through
/// `OutputsPanelController.handleOutputsChange` is pure or driven by injected closures, exercised
/// here with no real `NSPanel`/`FSEventStream` involved (`OutputsPanelWindowController` itself is
/// LIVE-GATED, same posture as T8's `FileViewer` — see `OutputsPanel.swift`'s own doc header).
@MainActor
final class OutputsPanelTests: XCTestCase {
    // MARK: - The trigger matrix (PURE) — {shell-shown, detached-shown, neither} × {panel visible}

    /// The plan's own bullet, driven across the full product: only "neither shown" ever triggers
    /// anything, regardless of whether the panel happens to already be visible — `panelVisible` only
    /// decides HOW (present vs fold-in), never WHETHER. Includes the "both shown at once" corner
    /// (reachable in practice: a session can be both shell-attached AND open in a detached window).
    func testOutputsPanelActionOnlyNeitherShownEverTriggers() {
        for panelVisible in [false, true] {
            XCTAssertEqual(outputsPanelAction(shellShown: true, detachedShown: false, panelVisible: panelVisible), .none)
            XCTAssertEqual(outputsPanelAction(shellShown: false, detachedShown: true, panelVisible: panelVisible), .none)
            XCTAssertEqual(outputsPanelAction(shellShown: true, detachedShown: true, panelVisible: panelVisible), .none)
        }
        XCTAssertEqual(outputsPanelAction(shellShown: false, detachedShown: false, panelVisible: false), .present)
        XCTAssertEqual(outputsPanelAction(shellShown: false, detachedShown: false, panelVisible: true), .update)
    }

    // MARK: - outputsPanelAdditions (PURE)

    func testOutputsPanelAdditionsReportsOnlyTheNewFiles() {
        let additions = outputsPanelAdditions(previous: ["a.md"], current: ["a.md", "b.md"])
        XCTAssertEqual(additions, ["b.md"])
    }

    /// Deleted-only diffs (files vanished) never show the panel — the caller's `guard
    /// !additions.isEmpty` falls out of this returning empty.
    func testOutputsPanelAdditionsIsEmptyForADeletionOnlyDiff() {
        let additions = outputsPanelAdditions(previous: ["a.md", "b.md"], current: ["a.md"])
        XCTAssertEqual(additions, [])
    }

    func testOutputsPanelAdditionsIsEmptyWhenNothingChanged() {
        XCTAssertEqual(outputsPanelAdditions(previous: ["a.md"], current: ["a.md"]), [])
    }

    /// The vanish-tolerant watcher's empty re-list of a removed session dir — no crash, no
    /// "everything vanished" false additions.
    func testOutputsPanelAdditionsIsEmptyForAnEmptyCurrentListing() {
        XCTAssertEqual(outputsPanelAdditions(previous: ["a.md"], current: []), [])
    }

    // MARK: - outputsPanelDisplayTitle (PURE)

    func testOutputsPanelDisplayTitleUsesTheRealTitleWhenPresent() {
        XCTAssertEqual(outputsPanelDisplayTitle(title: "  Build report  ", sessionId: "S1"), "Build report")
    }

    /// The fail-quiet rule, verbatim: no title → the session id, never a generic placeholder.
    func testOutputsPanelDisplayTitleFallsBackToTheSessionId() {
        XCTAssertEqual(outputsPanelDisplayTitle(title: nil, sessionId: "S1"), "S1")
        XCTAssertEqual(outputsPanelDisplayTitle(title: "", sessionId: "S1"), "S1")
        XCTAssertEqual(outputsPanelDisplayTitle(title: "   ", sessionId: "S1"), "S1")
    }

    // MARK: - outputsPanelFrame (PURE)

    func testOutputsPanelFramePlacesTheTopRightCornerWithMargin() {
        let visible = CGRect(x: 0, y: 0, width: 1440, height: 900)
        let size = CGSize(width: 320, height: 100)
        let frame = outputsPanelFrame(size: size, visibleFrame: visible, margin: 16)
        XCTAssertEqual(frame, CGRect(x: 1440 - 320 - 16, y: 900 - 100 - 16, width: 320, height: 100))
    }

    /// A non-origin-zero screen (a secondary display to the right of the main one) — the corner
    /// tracks `visibleFrame`'s own max, never assumes `(0, 0)`.
    func testOutputsPanelFrameHandlesAnOffsetScreenOrigin() {
        let visible = CGRect(x: 1440, y: 0, width: 1920, height: 1080)
        let frame = outputsPanelFrame(size: CGSize(width: 320, height: 100), visibleFrame: visible, margin: 16)
        XCTAssertEqual(frame.maxX, visible.maxX - 16)
        XCTAssertEqual(frame.maxY, visible.maxY - 16)
    }

    // MARK: - upsertOutputsPanelEntry (PURE) — the "second session while visible" shape

    func testUpsertAppendsANewSessionAsANewCard() {
        let entries = upsertOutputsPanelEntry([], sessionId: "S1", title: "Session 1", additions: ["a.md"])
        let more = upsertOutputsPanelEntry(entries, sessionId: "S2", title: "Session 2", additions: ["b.md"])
        XCTAssertEqual(more.map(\.sessionId), ["S1", "S2"], "newest session appended, not jumped to the top")
        XCTAssertEqual(more[1].files, ["b.md"])
    }

    /// The SAME session dropping a second batch while its card already exists updates IN PLACE
    /// (position unchanged, files unioned) — never a duplicate card.
    func testUpsertUpdatesAnExistingSessionsCardInPlaceWithoutReordering() {
        var entries = upsertOutputsPanelEntry([], sessionId: "S1", title: "Session 1", additions: ["a.md"])
        entries = upsertOutputsPanelEntry(entries, sessionId: "S2", title: "Session 2", additions: ["b.md"])
        entries = upsertOutputsPanelEntry(entries, sessionId: "S1", title: "Session 1", additions: ["c.md"])

        XCTAssertEqual(entries.map(\.sessionId), ["S1", "S2"], "S1 stays in its original slot")
        XCTAssertEqual(entries[0].files, ["a.md", "c.md"])
    }

    func testUpsertDedupesAFileAlreadyOnTheCard() {
        var entries = upsertOutputsPanelEntry([], sessionId: "S1", title: "Session 1", additions: ["a.md"])
        entries = upsertOutputsPanelEntry(entries, sessionId: "S1", title: "Session 1", additions: ["a.md", "b.md"])
        XCTAssertEqual(entries[0].files, ["a.md", "b.md"], "a.md must not appear twice")
    }

    func testUpsertWithNoAdditionsIsANoOp() {
        let entries = [OutputsPanelEntry(sessionId: "S1", title: "Session 1", files: ["a.md"])]
        XCTAssertEqual(upsertOutputsPanelEntry(entries, sessionId: "S1", title: "Session 1", additions: []), entries)
    }

    // MARK: - OutputsPanelController.handleOutputsChange — the orchestration seam

    /// A no-injected-closure controller reads every hook as "not shown" — fail toward showing (the
    /// safe direction: a not-yet-wired controller is never mistaken for "already displayed
    /// elsewhere").
    func testPanelShowsWhenNeitherShellNorDetachedShowsTheSession() {
        let controller = OutputsPanelController()
        controller.handleOutputsChange(sessionId: "S1", files: ["a.md"])
        XCTAssertTrue(controller.isVisible)
        XCTAssertEqual(controller.entries.map(\.sessionId), ["S1"])
    }

    func testPanelStaysSuppressedWhenTheShellIsShowingTheSession() {
        let controller = OutputsPanelController()
        controller.isShellShowing = { $0 == "S1" }
        controller.handleOutputsChange(sessionId: "S1", files: ["a.md"])
        XCTAssertFalse(controller.isVisible)
        XCTAssertEqual(controller.entries, [])
    }

    func testPanelStaysSuppressedWhenADetachedWindowIsShowingTheSession() {
        let controller = OutputsPanelController()
        controller.isDetachedShowing = { $0 == "S1" }
        controller.handleOutputsChange(sessionId: "S1", files: ["a.md"])
        XCTAssertFalse(controller.isVisible)
    }

    func testPanelStaysSuppressedWhenBothShowTheSession() {
        let controller = OutputsPanelController()
        controller.isShellShowing = { _ in true }
        controller.isDetachedShowing = { _ in true }
        controller.handleOutputsChange(sessionId: "S1", files: ["a.md"])
        XCTAssertFalse(controller.isVisible)
    }

    /// A DIFFERENT session (not shown anywhere) must still show, even while an unrelated session IS
    /// shell-shown — the gate is per-session, never global.
    func testPanelShowsForANotShownSessionEvenWhileAnotherIsShellShown() {
        let controller = OutputsPanelController()
        controller.isShellShowing = { $0 == "S_shown" }
        controller.handleOutputsChange(sessionId: "S_shown", files: ["a.md"])
        XCTAssertFalse(controller.isVisible)
        controller.handleOutputsChange(sessionId: "S_other", files: ["b.md"])
        XCTAssertTrue(controller.isVisible)
        XCTAssertEqual(controller.entries.map(\.sessionId), ["S_other"])
    }

    func testDeletionOnlyDiffNeverShowsThePanel() {
        let controller = OutputsPanelController()
        // First tick establishes the last-seen listing WITHOUT ever showing the panel — simulates
        // the box's own initial state already existing before the panel controller starts watching.
        controller.handleOutputsChange(sessionId: "S1", files: ["a.md", "b.md"])
        controller.dismiss() // as if the panel had shown-and-cleared already; state below is what matters
        controller.handleOutputsChange(sessionId: "S1", files: ["a.md"]) // b.md vanished — no new file
        XCTAssertFalse(controller.isVisible, "a deletion-only diff must never (re)trigger the panel")
    }

    /// The vanish-tolerant watcher's empty re-list (a deleted session dir) — never an empty panel.
    func testEmptyListingNeverShowsAnEmptyPanel() {
        let controller = OutputsPanelController()
        controller.handleOutputsChange(sessionId: "S1", files: [])
        XCTAssertFalse(controller.isVisible)
        XCTAssertEqual(controller.entries, [])
    }

    /// The "second session while visible" shape, driven end-to-end through the controller: a second,
    /// DIFFERENT session's files landing while the panel is already up appends a new card rather than
    /// replacing the first.
    func testSecondSessionWhileVisibleAppendsANewCardRatherThanReplacing() {
        let controller = OutputsPanelController()
        controller.handleOutputsChange(sessionId: "S1", files: ["a.md"])
        XCTAssertTrue(controller.isVisible)
        controller.handleOutputsChange(sessionId: "S2", files: ["b.md"])
        XCTAssertEqual(controller.entries.map(\.sessionId), ["S1", "S2"])
        XCTAssertTrue(controller.isVisible)
    }

    /// The SAME session dropping a second batch while its own card is already showing updates that
    /// card in place — one entry, not two.
    func testSameSessionSecondBatchWhileVisibleUnionsFilesInPlace() {
        let controller = OutputsPanelController()
        controller.handleOutputsChange(sessionId: "S1", files: ["a.md"])
        controller.handleOutputsChange(sessionId: "S1", files: ["a.md", "b.md"])
        XCTAssertEqual(controller.entries.count, 1)
        XCTAssertEqual(controller.entries[0].files, ["a.md", "b.md"])
    }

    func testNoTitleFallsBackToSessionIdThroughTheController() {
        let controller = OutputsPanelController()
        controller.titleForSession = { _ in nil }
        controller.handleOutputsChange(sessionId: "S1", files: ["a.md"])
        XCTAssertEqual(controller.entries.first?.title, "S1")
    }

    func testARealTitleIsUsedWhenPresent() {
        let controller = OutputsPanelController()
        controller.titleForSession = { _ in "Build report" }
        controller.handleOutputsChange(sessionId: "S1", files: ["a.md"])
        XCTAssertEqual(controller.entries.first?.title, "Build report")
    }

    // MARK: - The click-through door + dismiss

    func testOpenFileFiresTheCallbackAndDismissesThePanel() {
        let controller = OutputsPanelController()
        controller.handleOutputsChange(sessionId: "S1", files: ["a.md"])
        var opened: (String, String)?
        controller.onOpenFile = { opened = ($0, $1) }

        controller.openFile(sessionId: "S1", path: "a.md")

        XCTAssertEqual(opened?.0, "S1")
        XCTAssertEqual(opened?.1, "a.md")
        XCTAssertFalse(controller.isVisible)
        XCTAssertEqual(controller.entries, [])
    }

    func testDismissClearsEntriesAndHidesThePanel() {
        let controller = OutputsPanelController()
        controller.handleOutputsChange(sessionId: "S1", files: ["a.md"])
        controller.dismiss()
        XCTAssertFalse(controller.isVisible)
        XCTAssertEqual(controller.entries, [])
    }

    /// `onStateChange` — the AppKit half's one hook — fires on a fresh show and on a dismiss, but NOT
    /// on a redundant no-op dismiss (nothing to react to).
    func testOnStateChangeFiresOnShowAndDismissButNotRedundantly() {
        let controller = OutputsPanelController()
        var fireCount = 0
        controller.onStateChange = { fireCount += 1 }
        controller.handleOutputsChange(sessionId: "S1", files: ["a.md"])
        XCTAssertEqual(fireCount, 1)
        controller.dismiss()
        XCTAssertEqual(fireCount, 2)
        controller.dismiss() // already empty/hidden — no-op
        XCTAssertEqual(fireCount, 2)
    }

    // MARK: - Auto-dismiss (probe-cycle: an injected zero-delay clock, no real sleep)

    /// `dismissAfter` is the SAME "injectable clock" seam `SessionDirectory`'s poll (`sleepTick`)
    /// uses — here driven with a closure that returns immediately, then polled via the shared
    /// `waitUntil` helper (`AppModelTests.swift`) rather than a real multi-second sleep.
    func testAutoDismissClearsThePanelAfterTheInjectedDelay() async {
        let controller = OutputsPanelController(dismissAfter: {})
        controller.handleOutputsChange(sessionId: "S1", files: ["a.md"])
        XCTAssertTrue(controller.isVisible)
        await waitUntil { !controller.isVisible }
        XCTAssertFalse(controller.isVisible)
        XCTAssertEqual(controller.entries, [])
    }

    /// A second batch while already visible re-arms the clock — the panel must not dismiss out from
    /// under a JUST-updated card. `dismissAfter` never resolves for this test, so the ONLY way the
    /// panel could end up hidden is if the first tick's now-cancelled task fired anyway.
    func testASecondBatchReArmsTheAutoDismissClock() async {
        let controller = OutputsPanelController(dismissAfter: { try? await Task.sleep(for: .seconds(3600)) })
        controller.handleOutputsChange(sessionId: "S1", files: ["a.md"])
        controller.handleOutputsChange(sessionId: "S1", files: ["a.md", "b.md"])
        try? await Task.sleep(nanoseconds: 50_000_000) // let any stray first-arm timer have its chance
        XCTAssertTrue(controller.isVisible, "the re-armed (long) clock must still be the one governing dismissal")
    }

    // MARK: - Compose, never replace (T8's own seam — T9 must respect it too)

    func testControllerComposesOntoAPreExistingOnChangeHandlerRatherThanReplacingIt() {
        let watcher = OutputsWatcher(home: FileManager.default.temporaryDirectory.appendingPathComponent("OutputsPanelTests-\(UUID().uuidString)").path)
        var previousHandlerFired = false
        watcher.onChange = { _, _ in previousHandlerFired = true }

        let controller = OutputsPanelController(outputsWatcher: watcher)
        watcher.onChange?("S1", ["a.md"])

        XCTAssertTrue(previousHandlerFired, "the handler present BEFORE construction must still run")
        XCTAssertTrue(controller.isVisible, "and this controller's own handling must ALSO have run")
    }

    // MARK: - AppDelegate wiring — isDetachedShowing + the click-through call shape

    /// Same construction shape as `AppLifecycleTests.makeDetachedWindow` — a scripted transport that
    /// never answers the handshake; these tests only care about the window's presence/`sessionId`,
    /// never its live RPC traffic.
    private func makeDetachedWindow(sessionId: String) -> DetachedWindowController {
        let t = DetachedScriptedTransport()
        let session = SessionModel()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "orb", mode: .pinned(sessionId: sessionId), session: session)
        return DetachedWindowController(feed: feed, session: session, frame: NSRect(x: 0, y: 0, width: 400, height: 400), title: "Test")
    }

    func testIsDetachedShowingReflectsTheLiveRegistry() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        XCTAssertNotNil(delegate.outputsPanel, "boot() must construct the panel controller")

        delegate.registerDetachedWindow(makeDetachedWindow(sessionId: "S1"))
        defer { delegate.detachedWindows.forEach { $0.close() } }

        XCTAssertTrue(delegate.outputsPanel?.isDetachedShowing?("S1") ?? false)
        XCTAssertFalse(delegate.outputsPanel?.isDetachedShowing?("S2") ?? true)
    }

    /// T9's click-through door, pinned at the navigation call shape: summon + `.session(id)` +
    /// `ShellSessionHost.showOutputFile` — the SAME pattern `ShellSessionHostTests.
    /// testSummonAppWindowWiresAHostThatStaysDetachedWhileHidden` uses for the shell's own
    /// summon-while-degraded posture (no daemon token — `attachFresh` bails before touching
    /// `openOutputFile`, so this closes purely on navigation + the viewer door, independent of
    /// whether a real attach could succeed).
    func testOpenOutputFileFromPanelSummonsNavigatesAndOpensTheViewer() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        // A real window gets summoned/activated below — hide it again so this test's dock-icon
        // promotion never leaks into a LATER test in the same process (`AppLifecycleTests`'s own
        // documented discipline: "every test below closes whatever window(s) it opened").
        defer { delegate.appWindow?.hide() }

        delegate.openOutputFileFromPanel(sessionId: "S1", path: "/tmp/somewhere/S1/report.md")

        guard let controller = delegate.appWindow else {
            return XCTFail("openOutputFileFromPanel must summon the app window")
        }
        XCTAssertEqual(controller.navigation.destination, .session("S1"))
        XCTAssertEqual(controller.host?.openOutputFile, URL(fileURLWithPath: "/tmp/somewhere/S1/report.md"))
    }

    /// A SECOND click-through (a different session) must retarget both the navigation AND the
    /// viewer — never leave the first session's file open behind a new destination.
    func testASecondClickThroughRetargetsBothNavigationAndTheViewer() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        defer { delegate.appWindow?.hide() } // same dock-icon-leak discipline as the test above

        delegate.openOutputFileFromPanel(sessionId: "S1", path: "/tmp/s1/a.md")
        delegate.openOutputFileFromPanel(sessionId: "S2", path: "/tmp/s2/b.md")

        XCTAssertEqual(delegate.appWindow?.navigation.destination, .session("S2"))
        XCTAssertEqual(delegate.appWindow?.host?.openOutputFile, URL(fileURLWithPath: "/tmp/s2/b.md"))
    }
}
