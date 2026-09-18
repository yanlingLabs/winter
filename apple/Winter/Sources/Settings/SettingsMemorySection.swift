import SwiftUI

// -----------------------------------------------------------------------------------------------
// Settings → Memory (2026-09-18) — the Dashboard's `MemoryPane` re-set in the card vocabulary, so
// every settings page wears the same chrome (user call: "make the settings tabs, all, look like
// ChatGPT's"). It drives the SAME `MemoryPaneModel` — refresh, select, save, delete, the audit
// read — and the Dashboard pane is untouched.
//
// The pane's list/detail SPLIT becomes a drill-in, the shape the library panel and the model picker
// already use: the page lists the facts as rows; choosing one swaps the page to that fact, with a
// back row to return. A 220 pt list beside an editor does not fit a centred reading column, and a
// drill-in gives the editor the column's whole width.
// -----------------------------------------------------------------------------------------------

struct SettingsMemorySection: View {
    @ObservedObject var model: MemoryPaneModel
    /// The fact pending a confirmed delete — captured by NAME, as the pane does, so the alert always
    /// targets the fact it was opened for.
    @State private var confirmingDeleteName: String?

    var body: some View {
        SettingsPage(title: settingsSectionTitle(.memory)) {
            SettingsButton("Refresh", isEnabled: !model.loading) {
                Task { await model.refresh(); await model.loadAudit() }
            }
        } content: {
            if let errorText = model.errorText {
                SettingsGroup {
                    SettingsNoteRow(errorText, isError: true)
                }
            }
            if let selected = model.selectedName {
                factPage(selected)
            } else {
                factList
                recentChanges
            }
        }
        .task {
            await model.refresh()
            await model.loadAudit()
        }
        .alert(
            "Delete \(confirmingDeleteName ?? "")?",
            isPresented: Binding(
                get: { confirmingDeleteName != nil },
                set: { if !$0 { confirmingDeleteName = nil } }
            )
        ) {
            Button("Delete", role: .destructive) {
                if let name = confirmingDeleteName { Task { await model.delete(name) } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This can't be undone.")
        }
    }

    // MARK: The list

    private var factList: some View {
        SettingsGroup("Facts") {
            if model.facts.isEmpty {
                SettingsNoteRow(model.loading ? "Loading…" : "No memory facts")
            }
            ForEach(model.facts) { fact in
                Button {
                    Task { await model.select(fact.name) }
                } label: {
                    SettingsRow(fact.name, description: fact.description) {
                        HStack(spacing: 10) {
                            SettingsBadge(memoryTypeBadge(fact.type))
                            Image(systemName: "chevron.right")
                                .font(Typography.caption(.medium))
                                .foregroundStyle(Theme.textMuted)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var recentChanges: some View {
        SettingsGroup("Recent changes") {
            if let auditErrorText = model.auditErrorText {
                SettingsNoteRow(auditErrorText, isError: true)
            } else if model.auditLines.isEmpty {
                SettingsNoteRow("No recent changes")
            } else {
                // `MemoryAuditLine` carries no id of its own — the enumerated offset stands in, as
                // it does in the pane.
                ForEach(Array(model.auditLines.prefix(12).enumerated()), id: \.offset) { _, line in
                    SettingsRow("\(line.action) · \(line.name)", description: line.source) {
                        Text(Date(timeIntervalSince1970: TimeInterval(line.ts) / 1000), style: .relative)
                            .font(Typography.control())
                            .foregroundStyle(Theme.textMuted)
                    }
                }
            }
        }
    }

    // MARK: One fact

    @ViewBuilder
    private func factPage(_ name: String) -> some View {
        Button {
            model.clearSelection()
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "chevron.left")
                    .font(Typography.control(.medium))
                Text("All memories")
                    .font(Typography.body())
            }
            .foregroundStyle(Theme.textSecondary)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)

        SettingsGroup(name) {
            if model.detailLoading {
                SettingsNoteRow("Loading…")
            } else if let detailErrorText = model.detailErrorText {
                SettingsNoteRow(detailErrorText, isError: true)
            } else if model.detail != nil {
                SettingsRow("Type") {
                    SettingsBadge(memoryTypeBadge(model.detail?.type ?? "user"))
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("Description")
                        .font(Typography.body())
                        .foregroundStyle(Theme.textPrimary)
                    TextField("Description", text: $model.editedDescription)
                        .textFieldStyle(.roundedBorder)
                        .font(Typography.control())
                }
                .padding(.horizontal, SettingsChrome.rowHorizontalPadding)
                .padding(.vertical, SettingsChrome.rowVerticalPadding)
                VStack(alignment: .leading, spacing: 8) {
                    Text("Contents")
                        .font(Typography.body())
                        .foregroundStyle(Theme.textPrimary)
                    TextEditor(text: $model.editedBody)
                        .font(Typography.labelMono())
                        .scrollContentBackground(.hidden)
                        .padding(6)
                        .frame(minHeight: 260)
                        .background(
                            RoundedRectangle(cornerRadius: SettingsChrome.controlCornerRadius, style: .continuous)
                                .fill(Theme.controlSurface)
                        )
                }
                .padding(.horizontal, SettingsChrome.rowHorizontalPadding)
                .padding(.vertical, SettingsChrome.rowVerticalPadding)
                HStack(spacing: 10) {
                    Spacer()
                    SettingsButton("Delete", isDestructive: true,
                                   isEnabled: !(model.saving || model.deleting)) {
                        confirmingDeleteName = name
                    }
                    SettingsButton("Save",
                                   isEnabled: model.canSave && !model.saving && !model.deleting) {
                        Task { await model.save() }
                    }
                }
                .padding(.horizontal, SettingsChrome.rowHorizontalPadding)
                .padding(.vertical, SettingsChrome.rowVerticalPadding)
            }
        }
    }
}
