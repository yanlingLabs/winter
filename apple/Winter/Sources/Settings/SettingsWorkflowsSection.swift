import SwiftUI

// -----------------------------------------------------------------------------------------------
// Settings → Workflows (2026-09-18) — the Dashboard's `WorkflowsPane` re-set in the card vocabulary
// so every settings page wears the same chrome (user call: "make the settings tabs, all, look like
// ChatGPT's"). Presentation only: it drives the SAME `WorkflowsPaneModel` the Dashboard pane does
// — the same refresh, run and stop — and the pane itself is untouched.
// -----------------------------------------------------------------------------------------------

struct SettingsWorkflowsSection: View {
    @ObservedObject var model: WorkflowsPaneModel

    var body: some View {
        SettingsPage(title: settingsSectionTitle(.workflows)) {
            SettingsButton("Refresh", isEnabled: !model.loading) {
                Task { await model.refresh() }
            }
        } content: {
            if let errorText = model.errorText {
                SettingsGroup {
                    SettingsNoteRow(errorText, isError: true)
                }
            }
            SettingsGroup("Saved") {
                if model.saved.isEmpty {
                    SettingsNoteRow("No saved workflows")
                }
                ForEach(model.saved, id: \.name) { workflow in
                    SettingsRow(workflow.name, description: workflow.description) {
                        SettingsButton("Run", isEnabled: !model.runningNames.contains(workflow.name)) {
                            Task { await model.run(workflow) }
                        }
                    }
                }
            }
            SettingsGroup("Runs") {
                if model.rows.isEmpty {
                    SettingsNoteRow("No workflow runs yet")
                }
                ForEach(model.rows) { row in
                    runRow(row)
                }
            }
        }
        .task { await model.refresh() }
    }

    private func runRow(_ row: WorkflowRunRow) -> some View {
        SettingsRow(row.name ?? row.runId, description: row.phase) {
            SettingsRowNote("\(row.completed)/\(row.total) done · \(row.running) running")
            if let error = row.error {
                Text(error)
                    .font(Typography.control())
                    .foregroundStyle(.red)
                    .lineLimit(2)
            }
        } control: {
            HStack(spacing: 10) {
                SettingsBadge(workflowStatusBadge(row.status))
                if row.status == "running" {
                    SettingsButton("Stop", isEnabled: !model.stoppingRunIds.contains(row.runId)) {
                        Task { await model.stop(row.runId) }
                    }
                }
            }
        }
    }
}
