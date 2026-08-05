import XCTest
import AppKit
import NormaKit
@testable import Norma

/// Task 5 (2f-ii): originally the Dashboard WINDOW's pure pieces + a construction/singleton smoke
/// test. Task 7: the window is gone (`DashboardWindowController`/`Dashboard/DashboardView.swift`
/// deleted — the Dashboard is a shell destination now, `AppShell/DashboardSurface.swift`) — this
/// file's remaining job is narrower: every individual PANE's formatting helper (daemon status,
/// quota, trust sort, peripheral holder/age, memory/skill/provider/workflow badges). SwiftUI
/// bodies (`*Pane`) are deliberately NOT exercised here, per this codebase's convention (see
/// `SessionSidebar`/`WorkSidebar` — never unit-tested, only their pure helpers are). The
/// pane-CATALOGUE coverage (order, groups, selection, deep links) moved to
/// `DashboardSurfaceTests.swift` alongside its new subject file.
@MainActor
final class DashboardTests: XCTestCase {
    // Task 7: `dashboardPaneOrder`/`defaultDashboardPane`/`dashboardPaneTitle`/
    // `dashboardPaneSystemImage`/`DashboardSelectionModel` and their tests all MOVED to
    // `DashboardSurfaceTests.swift` — their subject file (`Dashboard/DashboardView.swift`) was
    // deleted outright, replaced by `AppShell/DashboardSurface.swift`. `centeredDashboardFrame`/
    // `dashboardDefaultSize` and their two tests DIED (not moved) along with
    // `Dashboard/DashboardWindowController.swift` — there is no more Dashboard WINDOW to center;
    // `AppWindowController`'s own `centeredAppWindowFrame` (already tested in `AppShellTests.swift`)
    // covers the shell the Dashboard now lives inside. `SessionsPane.swift`'s
    // `sessionDisplayTitle`/`groupedSessionRows` tests left this file in Task 7's first commit — see
    // `AppShellTests.swift`'s own note. `DashboardWindowController` construction +
    // `AppDelegate.openDashboard()` singleton wiring — nine tests total — died with the controller
    // itself (funeral arithmetic in the task report).

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
