import SwiftUI
import WinterKit
import WinterProtocol

/// Existing local metadata only. Neither this view nor a claim/VM-power field starts guest work.
@MainActor struct CoworkSchedulesView: View {
    @ObservedObject var model: CoworkSchedulesModel
    let workspace: CoworkWorkspace
    let policyRevision: Int?
    @State private var bindingToken: UUID?
    @State private var cancellation: CoworkScheduleView?
    private var workspaceGeneration: String {
        "\(workspace.workspaceId):\(workspace.configRevision):\(workspace.grantRevision):\(workspace.instructionRevision):\(workspace.leaseEpoch):\(policyRevision ?? 0):\(workspace.state)"
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Schedules").font(.headline)
                Spacer()
                Button("Refresh schedules", systemImage: "arrow.clockwise") { Task { await model.refresh() } }
            }
            Label("Scheduled execution is unavailable", systemImage: "clock").foregroundStyle(.secondary)
            if model.busy { ProgressView("Reading schedule metadata…") }
            if let error = model.error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if let receipt = model.lastCancellation {
                Text("Cancellation recorded for \(receipt.scheduleId). Check occurrence status for any uncertain effects.")
                    .font(.caption).textSelection(.enabled)
            }
            if model.schedules.isEmpty && !model.busy { Text("No schedules on this page.").foregroundStyle(.secondary) }
            ForEach(model.schedules, id: \.scheduleId) { value in
                VStack(alignment: .leading, spacing: 6) {
                    switch value {
                    case let .schedule(record):
                        Text(record.definition.prompt).lineLimit(2)
                        Text("\(record.state.rawValue) · revision \(record.revision)").font(.caption)
                        Text(timing(record.definition)).font(.caption).foregroundStyle(.secondary)
                        Text(record.nextDue.map { "Next due: \(date($0))" } ?? "No future due time recorded").font(.caption).foregroundStyle(.secondary)
                        Text("Approvals: \(record.definition.policy.rawValue) · source: \(record.definition.sourceId)").font(.caption).textSelection(.enabled)
                    case let .quarantined(record):
                        Text("Schedule quarantined").foregroundStyle(.orange)
                        Text("invalid_schedule · revision \(record.revision)\(record.cancelled ? " · cancelled" : "")").font(.caption)
                    }
                    Text(value.scheduleId).font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
                    HStack {
                        Button("Details") { Task { await model.inspect(scheduleId: value.scheduleId) } }
                        Button("Cancel schedule", role: .destructive) { cancellation = value }.disabled(!value.canCancel)
                    }
                }.padding().frame(maxWidth: .infinity, alignment: .leading)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
            }
            HStack {
                Button("Previous page") { Task { await model.previousPage() } }.disabled(!model.canGoBack)
                Spacer()
                Button("Next page") { Task { await model.nextPage() } }.disabled(model.nextCursor == nil)
            }
            if let status = model.status { detail(status) }
        }
        .disabled(model.busy)
        .task(id: workspaceGeneration) {
            cancellation = nil; bindingToken = model.bind(workspaceId: workspace.workspaceId)
            await model.refresh()
        }
        .onDisappear { if let bindingToken { model.release(bindingToken) } }
        .confirmationDialog("Cancel this schedule?", isPresented: Binding(get: { cancellation != nil }, set: { if !$0 { cancellation = nil } })) {
            if let value = cancellation, let binding = bindingToken, value.workspaceId == workspace.workspaceId {
                Button("Cancel schedule", role: .destructive) {
                    cancellation = nil
                    Task { await model.cancel(scheduleId: value.scheduleId, expectedRevision: value.revision, binding: binding) }
                }
            }
        } message: { Text("Future schedule occurrences will be cancelled. Already uncertain effects still require recovery.") }
    }
    private func detail(_ value: CoworkScheduleStatus) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("Occurrence status").font(.headline)
            Text(value.schedule.scheduleId).font(.caption).textSelection(.enabled)
            Text("Execution: \(value.execution.rawValue)").foregroundStyle(.secondary)
            if case let .schedule(record) = value.schedule {
                Text(record.definition.prompt).textSelection(.enabled)
                Text("Target: \(target(record.definition.target))").font(.caption).textSelection(.enabled)
                Text("Timezone: \(record.definition.timezone) · overlap: \(record.definition.overlap.rawValue)").font(.caption)
                if let branch = record.definition.branchPrecondition { Text("Required branch: \(branch)").font(.caption).textSelection(.enabled) }
                Text("Saved ceiling — network: \(record.definition.savedCeiling.network)").font(.caption)
                Text("Tools: \(record.definition.savedCeiling.toolClasses.joined(separator: ", "))").font(.caption).textSelection(.enabled)
                Text("Host services: \(record.definition.savedCeiling.hostServices.joined(separator: ", "))").font(.caption).textSelection(.enabled)
                Text("Connectors: \(record.definition.savedCeiling.connectors.joined(separator: ", "))").font(.caption).textSelection(.enabled)
            } else { Text("The invalid definition is retained by the host and is not shown here.").foregroundStyle(.secondary) }
            if value.occurrences.isEmpty { Text("No recorded occurrences.").foregroundStyle(.secondary) }
            ForEach(value.occurrences, id: \.occurrenceId) { occurrence in
                VStack(alignment: .leading, spacing: 3) {
                    Text("\(occurrence.state.rawValue) · missed: \(occurrence.missedCount)")
                    Text("First due: \(date(occurrence.dueAt)); latest coalesced: \(date(occurrence.latestDueAt))").font(.caption)
                    if let reason = occurrence.reason { Text(reason.rawValue).font(.caption).foregroundStyle(.secondary) }
                    if occurrence.state == .uncertain { Text("Recovery required. A completed effect is not confirmed.").font(.caption).foregroundStyle(.orange) }
                    Text(occurrence.occurrenceId).font(.caption2).textSelection(.enabled)
                }
            }
        }.padding().frame(maxWidth: .infinity, alignment: .leading)
    }
    private func timing(_ value: CoworkScheduleDefinition) -> String {
        switch value.timing { case let .once(at): "Once: \(date(at))"; case let .recurring(spec): "Recurring: \(spec) · \(value.timezone)" }
    }
    private func target(_ value: CoworkScheduleTarget) -> String {
        switch value { case let .conversation(id): "Conversation \(id)"; case let .project(id): "Project \(id)" }
    }
    private func date(_ milliseconds: Double) -> String {
        guard abs(milliseconds) <= 8_640_000_000_000_000 else { return String(milliseconds) }
        return Date(timeIntervalSince1970: milliseconds / 1000).formatted(date: .abbreviated, time: .shortened)
    }
}
