import Combine
import NormaKit
import SwiftUI

// -----------------------------------------------------------------------------------------------
// Pure helpers (CC-parity phase 3, Workflows, Track D Task D3) — same "pure helper next to its
// View, table-tested independently" posture as this directory's other panes
// (`pluginRowDisplay`/`memoryTypeBadge`/`groupedSessionRows`).
// -----------------------------------------------------------------------------------------------

/// The pane's own display-ready shape for one workflow run. Deliberately a distinct type, not a
/// reuse of either source verbatim:
///  - `WorkflowRunView` (NormaKit, `workflow.list`'s "running" snapshot) has no public initializer
///    outside the NormaKit module — an intentional read-only wire-decode boundary, same as every
///    other NormaKit response struct (`WorkflowSaved` alongside it, `MemoryFactMeta`, etc.) — so a
///    merge that needs to CONSTRUCT new/blended values can't produce one directly.
///  - `WorkflowRunState` (`SessionModel.swift`'s live fold, Task D3's own reducer cases) has no
///    `startedAt` — the live event stream never carries one — so it alone can't supply this pane's
///    display order either.
struct WorkflowRunRow: Equatable, Identifiable {
    let runId: String
    var name: String?
    var status: String
    var phase: String?
    var running: Int
    var completed: Int
    var total: Int
    var result: String?
    var error: String?
    var startedAt: Int
    var id: String { runId }
}

extension WorkflowRunRow {
    /// Widens a `workflow.list` snapshot entry into this pane's own constructible row shape — pure
    /// 1:1 field copy, no merge logic (see `mergeWorkflowRuns` below for that).
    init(snapshot v: WorkflowRunView) {
        self.init(
            runId: v.runId, name: v.name, status: v.status, phase: v.phase,
            running: v.counts.running, completed: v.counts.completed, total: v.counts.total,
            result: v.result, error: v.error, startedAt: v.startedAt
        )
    }
}

/// Merges `workflow.list`'s daemon snapshot (refreshed on pane-open/after Run/Stop) with this
/// session's LIVE fold (`SessionModel.state.workflowRuns`, updated continuously as
/// `workflow_progress`/etc. stream in) into the single list `WorkflowsPane` renders. The live side
/// wins field-by-field wherever the fold has seen at least one event for that runId — it updates
/// far more often than a manual refresh — falling back to the snapshot's own fields (notably
/// `startedAt`, which the live fold never carries) where the live side has nothing yet. A runId
/// the live fold has but the snapshot doesn't (a run that started AFTER the last refresh) still
/// appears, sorted to the FRONT (`startedAt: .max` — this session's own event stream is the
/// freshest possible signal that it exists, ahead of even the newest stale-snapshot entry).
/// Newest-started first otherwise; ties (e.g. two brand-new live-only runs, both `.max`) break on
/// `runId` for a stable order.
///
/// PURE — no `NormaClient`/SwiftUI — table-tested directly in `DashboardTests.swift`, same posture
/// as `groupedSessionRows`/`pluginRowDisplay` in this same directory's other panes.
func mergeWorkflowRuns(snapshot: [WorkflowRunRow], live: [String: WorkflowRunState]) -> [WorkflowRunRow] {
    var byId: [String: WorkflowRunRow] = [:]
    for row in snapshot { byId[row.runId] = row }
    for (runId, run) in live {
        var row = byId[runId] ?? WorkflowRunRow(
            runId: runId, name: run.name, status: run.status, phase: nil,
            running: 0, completed: 0, total: 0, result: nil, error: nil, startedAt: .max
        )
        row.name = run.name ?? row.name
        row.status = run.status
        row.phase = run.phase ?? row.phase
        row.running = run.running
        row.completed = run.completed
        row.total = run.total
        row.result = run.result ?? row.result
        row.error = run.error ?? row.error
        byId[runId] = row
    }
    return byId.values.sorted { $0.startedAt == $1.startedAt ? $0.runId < $1.runId : $0.startedAt > $1.startedAt }
}

/// `WorkflowRunRow.status` → the row's badge text — same "tierBadge"-style mapping as
/// `pluginRowDisplay`'s badge / `memoryTypeBadge`. The wire enum is closed in practice
/// (workflows/types.ts's `WorkflowStatus`) but `default` guards a future server status this client
/// doesn't know about yet, never a real case today.
func workflowStatusBadge(_ status: String) -> String {
    switch status {
    case "running": return "Running"
    case "completed": return "Completed"
    case "failed": return "Failed"
    case "stopped": return "Stopped"
    default: return status.capitalized
    }
}

// -----------------------------------------------------------------------------------------------
// WorkflowsPaneModel — the pane's live view-model (`@MainActor`/`ObservableObject`), same
// "constructed fresh per dashboard window" posture as `MemoryPaneModel`/`SkillsPaneModel`. Owns the
// `workflow.list` snapshot (saved scripts + this session's run history) and the run/stop actions;
// re-publishes the injected `SessionModel`'s own changes as its own (same Combine-forwarding
// `FieldStateAdapter` uses over that exact class) so `rows` below stays live without the view
// needing to separately observe two objects.
//
// `currentSessionId` is a CLOSURE, not a stored id — `DashboardWiring`'s own "data OR a closure,
// never a raw client" convention (see that struct's doc comment): `AppModel.focusedSessionId` can
// change while the Dashboard window stays open (the user switches focus elsewhere in the app), and
// every RPC below must target whichever session is ACTUALLY focused at call time.
// -----------------------------------------------------------------------------------------------

@MainActor
final class WorkflowsPaneModel: ObservableObject {
    private let client: NormaClient
    private let session: SessionModel
    private let currentSessionId: () -> String?
    private var cancellable: AnyCancellable?

    @Published private(set) var saved: [WorkflowSaved] = []
    /// `workflow.list`'s own `running` array — actually this session's FULL run history
    /// (registry.ts never prunes by status; see `mergeWorkflowRuns`'s own doc), refreshed on
    /// `.task` and after every Run/Stop.
    @Published private(set) var runningSnapshot: [WorkflowRunView] = []
    @Published var errorText: String?
    @Published private(set) var loading = false
    /// Saved-workflow names with a `workflow.run` currently in flight — disables just THAT row's
    /// Run button, same per-key in-flight posture as `FieldStateAdapter.interactionInFlight`.
    @Published private(set) var runningNames: Set<String> = []
    /// runIds with a `workflow.stop` currently in flight — disables just THAT row's Stop button.
    @Published private(set) var stoppingRunIds: Set<String> = []

    init(client: NormaClient, session: SessionModel, currentSessionId: @escaping () -> String?) {
        self.client = client
        self.session = session
        self.currentSessionId = currentSessionId
        cancellable = session.objectWillChange.sink { [weak self] _ in
            self?.objectWillChange.send()
        }
    }

    /// The merged, display-ready run list — see `mergeWorkflowRuns`'s own doc.
    var rows: [WorkflowRunRow] {
        mergeWorkflowRuns(snapshot: runningSnapshot.map(WorkflowRunRow.init(snapshot:)), live: session.state.workflowRuns)
    }

    /// `workflow.list` — refreshes BOTH `saved` (the Run-button list) and `runningSnapshot` (this
    /// session's run history). Called on the pane's `.task` and after every Run/Stop, same
    /// "refresh after every mutation" posture as `MemoryPaneModel.save()/delete()`. No focused
    /// session yet (very early boot) clears both lists rather than attempting a malformed RPC.
    func refresh() async {
        guard let sessionId = currentSessionId() else {
            saved = []
            runningSnapshot = []
            return
        }
        loading = true
        defer { loading = false }
        do {
            let result = try await client.workflowList(sessionId: sessionId)
            saved = result.saved
            runningSnapshot = result.running
            errorText = nil
        } catch {
            errorText = "couldn't load workflows — try Refresh"
        }
    }

    /// Launches a SAVED workflow by name (`workflow.run(sessionId:name:)`). Refreshes on success so
    /// `runningSnapshot` picks up the new run immediately, even before its own `workflow_started`
    /// reaches this session's live fold.
    func run(_ workflow: WorkflowSaved) async {
        guard let sessionId = currentSessionId() else { return }
        runningNames.insert(workflow.name)
        defer { runningNames.remove(workflow.name) }
        do {
            _ = try await client.workflowRun(sessionId: sessionId, name: workflow.name)
            errorText = nil
            await refresh()
        } catch {
            errorText = "couldn't start \(workflow.name) — try again"
        }
    }

    /// `workflow.stop(runId)` — a soft boolean (NormaKit's own doc: never throws for an unknown or
    /// already-terminal runId). Refresh afterward is not just cosmetic: a stop fires NO
    /// `workflow_failed`/`workflow_completed` event (workflows/runtime.ts's `finish()` — the
    /// "stopped" branch never calls `deps.onEvent`; engine.ts's own comment: "onEvent never fires
    /// for 'stopped'"), so the live fold can never learn a run stopped on its own — a fresh
    /// `workflow.list` is the ONLY way this pane ever shows the resulting "stopped" status.
    func stop(_ runId: String) async {
        stoppingRunIds.insert(runId)
        defer { stoppingRunIds.remove(runId) }
        do {
            _ = try await client.workflowStop(runId: runId)
            errorText = nil
            await refresh()
        } catch {
            errorText = "couldn't stop the run — try again"
        }
    }
}

// -----------------------------------------------------------------------------------------------
// WorkflowsPane — modeled on `MemoryPane`'s header/list/empty-state structure and
// `SessionsPane`/`PluginManagerView`'s row-with-action-button idiom. Same macOS 26 Liquid Glass
// tokens the rest of the Dashboard already uses (`.quaternary` fills, `RoundedRectangle(cornerRadius:
// 6, style: .continuous)`, `.system(size:)` type scale, `.secondary` captions) — no new design
// system.
// -----------------------------------------------------------------------------------------------

struct WorkflowsPane: View {
    @ObservedObject var model: WorkflowsPaneModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if let errorText = model.errorText {
                Text(errorText).foregroundStyle(.red).font(Typography.label()).padding(.horizontal)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    savedSection
                    runsSection
                }
                .padding(.vertical, 8)
            }
        }
        .task { await model.refresh() }
    }

    private var header: some View {
        HStack {
            Text("Workflows").font(Typography.paneTitle)
            Spacer()
            Button("Refresh") { Task { await model.refresh() } }
                .disabled(model.loading)
        }
        .padding([.top, .horizontal])
        .padding(.bottom, 4)
    }

    @ViewBuilder
    private var savedSection: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Saved").font(Typography.label(.semibold)).foregroundStyle(.secondary).padding(.horizontal)
            if model.saved.isEmpty {
                Text("No saved workflows").font(Typography.label()).foregroundStyle(.secondary).padding(.horizontal)
            }
            ForEach(model.saved, id: \.name) { workflow in
                savedRow(workflow)
            }
        }
    }

    private func savedRow(_ workflow: WorkflowSaved) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(workflow.name)
                    .font(Typography.label(.medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(workflow.description)
                    .font(Typography.caption())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            Button("Run") { Task { await model.run(workflow) } }
                .disabled(model.runningNames.contains(workflow.name))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
    }

    @ViewBuilder
    private var runsSection: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Runs").font(Typography.label(.semibold)).foregroundStyle(.secondary).padding(.horizontal)
            if model.rows.isEmpty {
                Text("No workflow runs yet").font(Typography.label()).foregroundStyle(.secondary).padding(.horizontal)
            }
            ForEach(model.rows) { row in
                runRow(row)
            }
        }
    }

    private func runRow(_ row: WorkflowRunRow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                statusBadge(row.status)
                Text(row.name ?? row.runId)
                    .font(Typography.label(.medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                if row.status == "running" {
                    Button("Stop") { Task { await model.stop(row.runId) } }
                        .disabled(model.stoppingRunIds.contains(row.runId))
                }
            }
            if let phase = row.phase {
                Text(phase).font(Typography.caption()).foregroundStyle(.secondary).lineLimit(1)
            }
            Text("\(row.completed)/\(row.total) done · \(row.running) running")
                .font(Typography.captionMono())
                .foregroundStyle(.secondary)
            if let error = row.error {
                Text(error).font(Typography.caption()).foregroundStyle(.red).lineLimit(2)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background {
            RoundedRectangle(cornerRadius: 6, style: .continuous).fill(.quaternary.opacity(0.5))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 2)
    }

    private func statusBadge(_ status: String) -> some View {
        Text(workflowStatusBadge(status))
            .font(Typography.tiny(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(RoundedRectangle(cornerRadius: 4, style: .continuous).fill(.quaternary))
            .foregroundStyle(.secondary)
    }
}
