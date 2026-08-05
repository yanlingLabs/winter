import XCTest
import AppKit
import NormaKit
@testable import Norma

/// Task 5 (2f-ii): the Dashboard window's PURE pieces — pane order/default selection, window
/// centering geometry, and every pane's formatting helper (daemon status, quota, trust sort,
/// peripheral holder/age, session title fallback). SwiftUI bodies (`DashboardView`/`*Pane`) are
/// deliberately NOT exercised here, per this codebase's convention (see `SessionSidebar`/
/// `WorkSidebar` — never unit-tested, only their pure helpers are).
///
/// A `DashboardWindowController`/`AppDelegate.openDashboard()` construction+singleton smoke test
/// closes out the file, mirroring `DetachedWindowTests`/`StandaloneWindowTests`'s own wiring-level
/// coverage for the other window-spawn paths.
@MainActor
final class DashboardTests: XCTestCase {
    // MARK: - dashboardPaneOrder / defaultDashboardPane (PURE)

    /// Task 7: `.sessions` is GONE (spec §4 — the funeral; see `AppShellTests.swift`'s own note).
    /// The remaining nine keep their pre-T7 relative order — this task only REMOVED a pane here,
    /// never reordered the survivors. `DashboardSurfaceTests.swift` (App shell T7) takes over this
    /// pane-catalogue coverage once the Mac-group/Devices-group additions land.
    func testDashboardPaneOrderContainsAllNinePanesInSpecOrder() {
        // Phase 4d-iii Task 2: `.pluginManager` appended at the END, every pre-existing pane keeps
        // its position (see `dashboardPaneOrder`'s own doc comment). Phase 5b Task 5: `.memory`
        // appended the same way. Phase 5c Task 4: `.skills` appended the same way again. BYOK T2:
        // `.provider` appended the same way again. CC-parity phase 3 (Workflows, Track D Task D3):
        // `.workflows` appended the same way again.
        XCTAssertEqual(dashboardPaneOrder, [.daemonStatus, .quota, .trust, .peripheral, .pluginManager, .memory, .skills, .provider, .workflows])
        XCTAssertEqual(Set(dashboardPaneOrder), Set(DashboardPane.allCases), "every case must appear exactly once")
    }

    /// Task 7: the default pane follows `.sessions`' death — `.daemonStatus` (the new first entry)
    /// is now `dashboardPaneOrder.first`, computed exactly as before (never hardcoded).
    func testDefaultDashboardPaneIsFirstInOrder() {
        XCTAssertEqual(defaultDashboardPane, dashboardPaneOrder.first)
        XCTAssertEqual(defaultDashboardPane, .daemonStatus)
    }

    func testEveryPaneHasATitleAndSystemImage() {
        for pane in dashboardPaneOrder {
            XCTAssertFalse(dashboardPaneTitle(pane).isEmpty, "\(pane) needs a non-empty title")
            XCTAssertFalse(dashboardPaneSystemImage(pane).isEmpty, "\(pane) needs a non-empty SF Symbol name")
        }
    }

    // MARK: - centeredDashboardFrame (PURE)

    func testCenteredDashboardFrame() {
        let f = centeredDashboardFrame(visibleFrame: NSRect(x: 0, y: 0, width: 2000, height: 1200))
        XCTAssertEqual(f.size, dashboardDefaultSize)
        XCTAssertEqual(f.midX, 1000, accuracy: 1)
        XCTAssertEqual(f.midY, 600, accuracy: 1)
    }

    /// A non-origin visible frame (secondary monitor / menu-bar inset) must still center correctly
    /// — proves the math uses midX/midY of the given rect, not a bare width/height halving from
    /// (0, 0). Mirrors `StandaloneWindowTests.testCenteredStandaloneFrameOffsetVisibleFrame`.
    func testCenteredDashboardFrameOffsetVisibleFrame() {
        let f = centeredDashboardFrame(visibleFrame: NSRect(x: 500, y: 100, width: 1600, height: 1000))
        XCTAssertEqual(f.size, dashboardDefaultSize)
        XCTAssertEqual(f.midX, 1300, accuracy: 1)
        XCTAssertEqual(f.midY, 600, accuracy: 1)
    }

    // Task 7: the `sessionDisplayTitle`/`groupedSessionRows` tests that used to live here moved
    // (and, for `groupedSessionRows`, died) with `SessionsPane.swift` — see `AppShellTests.swift`'s
    // "SessionsPane funeral" section for the arithmetic and `sessionDisplayTitle`'s two surviving
    // tests' new home.

    // MARK: - formatDaemonStatus (PURE, DaemonStatusPane.swift)

    func testFormatDaemonStatusWithFullProvider() {
        let d = formatDaemonStatus(version: "0.1.0", uptimeMs: 123_000, socketPath: "/tmp/norma.sock", providerId: "conn_1", providerModel: "gpt-5", sessionsCount: 3, pluginsCount: 0)
        XCTAssertEqual(d.version, "0.1.0")
        XCTAssertEqual(d.uptime, formatElapsed(123_000)) // "2m 3s" — reuses the shared task-display helper
        XCTAssertEqual(d.uptime, "2m 3s")
        XCTAssertEqual(d.socketPath, "/tmp/norma.sock")
        XCTAssertEqual(d.provider, "conn_1 (gpt-5)")
        XCTAssertEqual(d.sessionsCount, "3")
        XCTAssertEqual(d.pluginsCount, "0")
    }

    func testFormatDaemonStatusWithNoProvider() {
        let d = formatDaemonStatus(version: "0.1.0", uptimeMs: 3_840_000, socketPath: "/tmp/norma.sock", providerId: nil, providerModel: nil, sessionsCount: 0, pluginsCount: 0)
        XCTAssertEqual(d.provider, "none")
        XCTAssertEqual(d.uptime, "1h 4m")
    }

    /// A providerId present without a model (contract doesn't guarantee they're always paired) —
    /// falls back to the bare id rather than dropping the provider entirely.
    func testFormatDaemonStatusWithProviderIdOnly() {
        let d = formatDaemonStatus(version: "0.1.0", uptimeMs: 14_000, socketPath: "/tmp/norma.sock", providerId: "conn_1", providerModel: nil, sessionsCount: 1, pluginsCount: 0)
        XCTAssertEqual(d.provider, "conn_1")
        XCTAssertEqual(d.uptime, "14s")
    }

    // MARK: - formatQuotaState (PURE, QuotaPane.swift)

    func testFormatQuotaStateOK() {
        let q = formatQuotaState(kind: "ok", resumeAt: nil, inputTokens: 842, outputTokens: 10_600, nowMs: 1_000)
        XCTAssertEqual(q.statusLine, "OK")
        XCTAssertEqual(q.tokensLine, "↑ 842 ↓ 10.6k tokens") // reuses the shared formatTokens helper
    }

    func testFormatQuotaStateLimitedWithFutureResumeAt() {
        let q = formatQuotaState(kind: "limited", resumeAt: 125_000, inputTokens: 0, outputTokens: 0, nowMs: 2_000)
        XCTAssertEqual(q.statusLine, "Limited — resumes in \(formatElapsed(123_000))")
        XCTAssertEqual(q.statusLine, "Limited — resumes in 2m 3s")
    }

    /// `resumeAt` already in the past (clock skew, or the daemon hasn't flipped `kind` back yet) —
    /// falls back to the bare "Limited" rather than printing a nonsensical negative duration.
    func testFormatQuotaStateLimitedWithPastResumeAtFallsBackToBareLimited() {
        let q = formatQuotaState(kind: "limited", resumeAt: 1_000, inputTokens: 0, outputTokens: 0, nowMs: 2_000)
        XCTAssertEqual(q.statusLine, "Limited")
    }

    func testFormatQuotaStateLimitedWithNoResumeAt() {
        let q = formatQuotaState(kind: "limited", resumeAt: nil, inputTokens: 0, outputTokens: 0, nowMs: 2_000)
        XCTAssertEqual(q.statusLine, "Limited")
    }

    /// An unrecognized `kind` string fails safe toward "OK" rather than alarming the user over
    /// something the client doesn't understand.
    func testFormatQuotaStateUnrecognizedKindReadsAsOK() {
        let q = formatQuotaState(kind: "weird", resumeAt: nil, inputTokens: 0, outputTokens: 0, nowMs: 0)
        XCTAssertEqual(q.statusLine, "OK")
    }

    // MARK: - sortedTrustPaths (PURE, TrustPane.swift)

    func testSortedTrustPathsIsAlphabetical() {
        XCTAssertEqual(sortedTrustPaths(["/z", "/a", "/m"]), ["/a", "/m", "/z"])
    }

    func testSortedTrustPathsEmpty() {
        XCTAssertEqual(sortedTrustPaths([]), [])
    }

    // MARK: - holderDisplay / peripheralLeaseAgeText (PURE, PeripheralPane.swift)

    func testHolderDisplay() {
        XCTAssertEqual(holderDisplay(kind: "session", id: "s_1"), "session:s_1")
        XCTAssertEqual(holderDisplay(kind: "plugin", id: "p_7"), "plugin:p_7")
    }

    func testPeripheralLeaseAgeTextStillActive() {
        // 90s remaining → formatElapsed(90_000) == "1m 30s"
        XCTAssertEqual(peripheralLeaseAgeText(expiresAt: 100_000, nowMs: 10_000), "expires in 1m 30s")
    }

    func testPeripheralLeaseAgeTextExpired() {
        XCTAssertEqual(peripheralLeaseAgeText(expiresAt: 5_000, nowMs: 10_000), "expired")
    }

    /// The exact boundary (`nowMs == expiresAt`) reads as expired — matches core's own
    /// `expiredLeases`/`shouldServe`'s inclusive-expired convention (`nowMs < lease.expiresAt`).
    func testPeripheralLeaseAgeTextExactlyAtExpiryReadsExpired() {
        XCTAssertEqual(peripheralLeaseAgeText(expiresAt: 10_000, nowMs: 10_000), "expired")
    }

    // MARK: - memoryTypeBadge (PURE, MemoryPane.swift)

    func testMemoryTypeBadgeMapsAllFourWireTypes() {
        XCTAssertEqual(memoryTypeBadge("user"), "User")
        XCTAssertEqual(memoryTypeBadge("feedback"), "Feedback")
        XCTAssertEqual(memoryTypeBadge("project"), "Project")
        XCTAssertEqual(memoryTypeBadge("reference"), "Reference")
    }

    /// An unrecognized type (a future server-side addition this client predates) falls back to a
    /// capitalized rendering of the raw string rather than crashing or showing blank.
    func testMemoryTypeBadgeUnrecognizedTypeFallsBackToCapitalized() {
        XCTAssertEqual(memoryTypeBadge("archived"), "Archived")
    }

    // MARK: - skillSourceBadge / skillsGroupedBySource (PURE, SkillsPane.swift)

    func testSkillSourceBadgeMapsAllFiveWireSources() {
        XCTAssertEqual(skillSourceBadge("project"), "Project")
        XCTAssertEqual(skillSourceBadge("user"), "User")
        XCTAssertEqual(skillSourceBadge("self"), "Self")
        XCTAssertEqual(skillSourceBadge("plugin"), "Plugin")
        XCTAssertEqual(skillSourceBadge("builtin"), "Builtin")
    }

    /// An unrecognized source (a future server-side addition this client predates) falls back to a
    /// capitalized rendering of the raw string rather than crashing or showing blank — same
    /// posture as `memoryTypeBadge`'s own fallback.
    func testSkillSourceBadgeUnrecognizedSourceFallsBackToCapitalized() {
        XCTAssertEqual(skillSourceBadge("mystery"), "Mystery")
    }

    private func skill(_ name: String, source: String, author: String? = nil) -> SkillMeta {
        SkillMeta(name: name, description: "d", source: source, path: "/tmp/\(name)", claudeFormat: nil, author: author)
    }

    /// Groups land in the fixed `skillSourceOrder` (project > user > self > plugin > builtin) —
    /// the store's own resolution precedence — REGARDLESS of the input array's order, and a
    /// source with zero skills produces no group at all.
    func testSkillsGroupedBySourceOrdersGroupsAndOmitsEmptyOnes() {
        let skills = [
            skill("b-skill", source: "builtin"),
            skill("self-skill", source: "self", author: "norma"),
            skill("proj-skill", source: "project"),
        ]
        let groups = skillsGroupedBySource(skills)
        XCTAssertEqual(groups.map(\.source), ["project", "self", "builtin"], "user/plugin have no skills — no empty groups")
        XCTAssertEqual(groups[0].skills.map(\.name), ["proj-skill"])
        XCTAssertEqual(groups[1].skills.map(\.name), ["self-skill"])
        XCTAssertEqual(groups[1].skills[0].author, "norma")
        XCTAssertEqual(groups[2].skills.map(\.name), ["b-skill"])
    }

    /// A source outside the known five (a future server addition) still gets its own trailing
    /// group instead of silently vanishing from the pane.
    func testSkillsGroupedBySourceUnknownSourceGetsATrailingGroup() {
        let skills = [skill("mystery-skill", source: "mystery"), skill("proj-skill", source: "project")]
        let groups = skillsGroupedBySource(skills)
        XCTAssertEqual(groups.map(\.source), ["project", "mystery"])
    }

    func testSkillsGroupedBySourceEmptyInputProducesNoGroups() {
        XCTAssertTrue(skillsGroupedBySource([]).isEmpty)
    }

    // MARK: - providerStatusText (PURE, ProviderPane.swift, BYOK T2)

    func testProviderStatusTextWithIdAndModel() {
        XCTAssertEqual(providerStatusText(providerId: "openai-compatible", providerModel: "gpt-4o"), "openai-compatible (gpt-4o)")
    }

    /// A providerId present without a model (contract doesn't guarantee they're always paired,
    /// same posture as `formatDaemonStatus`'s own provider field) — falls back to the bare id.
    func testProviderStatusTextWithIdOnly() {
        XCTAssertEqual(providerStatusText(providerId: "codex-oauth", providerModel: nil), "codex-oauth")
    }

    func testProviderStatusTextWithNeitherReadsAsNoneConfigured() {
        XCTAssertEqual(providerStatusText(providerId: nil, providerModel: nil), "none configured")
    }

    // MARK: - mergeWorkflowRuns / workflowStatusBadge (PURE, WorkflowsPane.swift — CC-parity
    // phase 3, Workflows, Track D Task D3)

    func testWorkflowStatusBadgeMapsAllFourWireStatuses() {
        XCTAssertEqual(workflowStatusBadge("running"), "Running")
        XCTAssertEqual(workflowStatusBadge("completed"), "Completed")
        XCTAssertEqual(workflowStatusBadge("failed"), "Failed")
        XCTAssertEqual(workflowStatusBadge("stopped"), "Stopped")
    }

    /// An unrecognized status (a future server-side addition this client predates) falls back to a
    /// capitalized rendering of the raw string — same posture as `memoryTypeBadge`/
    /// `skillSourceBadge`'s own fallback.
    func testWorkflowStatusBadgeUnrecognizedStatusFallsBackToCapitalized() {
        XCTAssertEqual(workflowStatusBadge("mystery"), "Mystery")
    }

    private func workflowRow(_ runId: String, status: String = "running", startedAt: Int, total: Int = 0) -> WorkflowRunRow {
        WorkflowRunRow(runId: runId, name: nil, status: status, phase: nil, running: 0, completed: 0, total: total, result: nil, error: nil, startedAt: startedAt)
    }

    func testMergeWorkflowRunsSnapshotOnlyPassesThroughSortedNewestFirst() {
        let snapshot = [workflowRow("r_old", startedAt: 10), workflowRow("r_new", startedAt: 30), workflowRow("r_mid", startedAt: 20)]
        let merged = mergeWorkflowRuns(snapshot: snapshot, live: [:])
        XCTAssertEqual(merged.map(\.runId), ["r_new", "r_mid", "r_old"])
    }

    /// The live fold's fields win over a matching snapshot row's — status/counts/phase — while
    /// `startedAt` (which the live fold never carries) is preserved from the snapshot.
    func testMergeWorkflowRunsLiveOverlayWinsFieldsForAMatchingRunId() {
        let snapshot = [workflowRow("r1", status: "running", startedAt: 100, total: 0)]
        let live = ["r1": WorkflowRunState(runId: "r1", name: "nightly", status: "completed", phase: "done", running: 0, completed: 20, total: 20, result: "ok", error: nil)]
        let merged = mergeWorkflowRuns(snapshot: snapshot, live: live)
        XCTAssertEqual(merged.count, 1)
        XCTAssertEqual(merged[0].status, "completed")
        XCTAssertEqual(merged[0].total, 20)
        XCTAssertEqual(merged[0].phase, "done")
        XCTAssertEqual(merged[0].startedAt, 100, "startedAt has no live-fold equivalent — the snapshot's own value survives")
    }

    /// A runId the live fold has learned about (via `workflow_started`) but the last
    /// `workflow.list` snapshot doesn't yet (a run that started after the last refresh) is still
    /// surfaced — and sorts AHEAD of every snapshot row, since it's the freshest possible signal a
    /// run exists.
    func testMergeWorkflowRunsLiveOnlyEntryIsSynthesizedAndSortedFirst() {
        let snapshot = [workflowRow("r_old", startedAt: 999_999)]
        let live = ["r_new": WorkflowRunState(runId: "r_new", name: "just-started", status: "running")]
        let merged = mergeWorkflowRuns(snapshot: snapshot, live: live)
        XCTAssertEqual(merged.map(\.runId), ["r_new", "r_old"])
    }

    func testMergeWorkflowRunsEmptyInputsProduceNoRows() {
        XCTAssertTrue(mergeWorkflowRuns(snapshot: [], live: [:]).isEmpty)
    }

    // MARK: - DashboardSelectionModel (PURE — Phase 4d-cleanup Task 3 fix 1)

    func testDashboardSelectionModelDefaultsToDefaultDashboardPane() {
        let model = DashboardSelectionModel()
        XCTAssertEqual(model.selection, defaultDashboardPane)
    }

    func testDashboardSelectionModelInitialPaneOverridesTheDefault() {
        let model = DashboardSelectionModel(initialPane: .pluginManager)
        XCTAssertEqual(model.selection, .pluginManager)
    }

    func testDashboardSelectionModelSelectionIsSettable() {
        let model = DashboardSelectionModel()
        model.selection = .trust
        XCTAssertEqual(model.selection, .trust)
    }

    // MARK: - DashboardWindowController construction (wiring smoke test)

    func testShowCreatesNativeChromeWindowAtFrame() {
        let client = NormaClientTestFactory.make()
        let directory = SessionDirectory(lister: { [] })
        let peripheral = PeripheralProvider(client: client)
        let helperClient = HelperClient()
        let frame = NSRect(x: 100, y: 80, width: 800, height: 560)
        let controller = DashboardWindowController(client: client, directory: directory, peripheral: peripheral, helperClient: helperClient, onOpenSessionDetached: { _ in }, frame: frame)
        defer { controller.close() }

        controller.show()

        guard let window = controller.windowForTesting else {
            XCTFail("DashboardWindowController must construct a real window")
            return
        }
        XCTAssertTrue(window.styleMask.contains(.titled))
        XCTAssertTrue(window.styleMask.contains(.miniaturizable))
        XCTAssertTrue(window.styleMask.contains(.resizable))
        XCTAssertTrue(window.styleMask.contains(.closable))
        XCTAssertTrue(window.styleMask.contains(.fullSizeContentView))
        XCTAssertEqual(window.frame, frame)
        XCTAssertEqual(window.title, "Dashboard")
    }

    /// `selectPane(_:)` retargets the controller's `DashboardSelectionModel` — the mechanism the
    /// refocus-branch fix below relies on.
    func testSelectPaneUpdatesTheControllersSelectionModel() {
        let client = NormaClientTestFactory.make()
        let directory = SessionDirectory(lister: { [] })
        let peripheral = PeripheralProvider(client: client)
        let helperClient = HelperClient()
        let frame = NSRect(x: 100, y: 80, width: 800, height: 560)
        let controller = DashboardWindowController(client: client, directory: directory, peripheral: peripheral, helperClient: helperClient, onOpenSessionDetached: { _ in }, frame: frame)
        defer { controller.close() }

        XCTAssertEqual(controller.selectionForTesting, defaultDashboardPane)
        controller.selectPane(.pluginManager)
        XCTAssertEqual(controller.selectionForTesting, .pluginManager)
    }

    /// A fresh window still seeds its selection model with `initialPane` at construction (the
    /// non-refocus half of the fix — unchanged behavior, kept as regression coverage).
    func testFreshWindowSeedsSelectionModelWithInitialPane() {
        let client = NormaClientTestFactory.make()
        let directory = SessionDirectory(lister: { [] })
        let peripheral = PeripheralProvider(client: client)
        let helperClient = HelperClient()
        let frame = NSRect(x: 100, y: 80, width: 800, height: 560)
        let controller = DashboardWindowController(client: client, directory: directory, peripheral: peripheral, helperClient: helperClient, onOpenSessionDetached: { _ in }, frame: frame, initialPane: .pluginManager)
        defer { controller.close() }

        XCTAssertEqual(controller.selectionForTesting, .pluginManager)
    }

    // MARK: - AppDelegate.openDashboard() singleton wiring

    /// Defensive-guard precedent (matches `openSessionInNewDetachedWindow`'s own guard): never
    /// booted → no `appModel`/`peripheralProvider` → log + no-op, no crash, no window.
    func testOpenDashboardNoOpsWithoutAppModel() {
        let delegate = AppDelegate()
        delegate.openDashboard()
        XCTAssertNil(delegate.dashboardWindow)
    }

    /// A second "Dashboard…" invocation must refocus the SAME controller, never construct another.
    func testOpenDashboardTwiceReusesTheSameController() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        delegate.openDashboard()
        guard let first = delegate.dashboardWindow else {
            XCTFail("openDashboard() must construct a controller when booted")
            return
        }
        delegate.openDashboard()
        XCTAssertTrue(delegate.dashboardWindow === first, "a second invocation must reuse the existing controller")
        delegate.dashboardWindow?.close()
    }

    /// The regression this fix targets: a TARGETED entry ("Manage Plugins…" →
    /// `openDashboard(initialPane: .pluginManager)`) fired while the Dashboard is ALREADY open
    /// must switch the already-open window to that pane, not just refocus it while leaving
    /// whatever pane was showing untouched.
    func testOpenDashboardRefocusSwitchesPaneOnAnAlreadyOpenWindow() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        delegate.openDashboard()
        guard let first = delegate.dashboardWindow else {
            XCTFail("openDashboard() must construct a controller when booted")
            return
        }
        XCTAssertEqual(first.selectionForTesting, defaultDashboardPane)

        delegate.openDashboard(initialPane: .pluginManager)

        XCTAssertTrue(delegate.dashboardWindow === first, "a second invocation must reuse the existing controller")
        XCTAssertEqual(delegate.dashboardWindow?.selectionForTesting, .pluginManager, "a targeted open must retarget the pane")
        delegate.dashboardWindow?.close()
    }

    /// Phase 4d-cleanup Task 3 fix wave 1 (the over-correction this wave fixes): a PLAIN
    /// "Dashboard…" refocus — `openDashboard()` with no `initialPane` — must PRESERVE whatever
    /// pane the user had already navigated to. `testOpenDashboardRefocusSwitchesPaneOnAnAlreadyOpenWindow`
    /// above proves the TARGETED path still retargets; this proves the untargeted path no longer
    /// does, closing the regression where the plain menu entry silently snapped an already-open
    /// window back to the default pane on every refocus.
    func testOpenDashboardPlainRefocusPreservesTheCurrentPane() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        delegate.openDashboard()
        guard let first = delegate.dashboardWindow else {
            XCTFail("openDashboard() must construct a controller when booted")
            return
        }
        // Simulate the user having navigated away from the default pane before refocusing.
        first.selectPane(.trust)
        XCTAssertEqual(first.selectionForTesting, .trust)

        delegate.openDashboard() // plain refocus — no pane requested

        XCTAssertTrue(delegate.dashboardWindow === first, "a second invocation must reuse the existing controller")
        XCTAssertEqual(delegate.dashboardWindow?.selectionForTesting, .trust, "a plain refocus must preserve the current pane")
        delegate.dashboardWindow?.close()
    }

    /// A FRESH open via the plain "Dashboard…" entry (no window yet, no `initialPane` requested)
    /// still lands on the default pane — unaffected by this fix, since the selection model itself
    /// seeds to `defaultDashboardPane` regardless of whether `openDashboard` passes it explicitly.
    func testOpenDashboardPlainFreshOpenLandsOnDefaultPane() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        delegate.openDashboard()
        XCTAssertEqual(delegate.dashboardWindow?.selectionForTesting, defaultDashboardPane)
        delegate.dashboardWindow?.close()
    }

    /// The window's `onClosed` hook nils the registry ref out — a THIRD `openDashboard()` after a
    /// close constructs a fresh controller rather than reusing the (now-closed) old one.
    func testClosingDashboardWindowClearsTheSingletonRef() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        delegate.openDashboard()
        delegate.dashboardWindow?.close()
        XCTAssertNil(delegate.dashboardWindow, "windowWillClose must clear the singleton ref")
    }
}

/// A minimal `NormaClient` for tests that only need a real instance to satisfy a type signature
/// (constructing `DashboardWindowController` closes over `client.daemonStatus()`/etc. as lazy
/// async closures — none of them are ever awaited in these construction-only tests) — never
/// connects, mirroring `PeripheralProviderTests`' own posture of never touching the network.
enum NormaClientTestFactory {
    static func make() -> NormaClient {
        NormaClient(makeTransport: { NeverOpensTransport() }, token: "test-token", clientName: "dashboard-tests")
    }
}

private final class NeverOpensTransport: NormaTransport, @unchecked Sendable {
    let incoming: AsyncStream<TransportEvent> = AsyncStream { _ in }
    func open() async throws { throw NSError(domain: "NeverOpensTransport", code: 1) }
    func send(_ data: Data) async throws {}
    func close() {}
}
