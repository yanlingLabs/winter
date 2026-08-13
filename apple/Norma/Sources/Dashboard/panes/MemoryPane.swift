import NormaKit
import SwiftUI

// -----------------------------------------------------------------------------------------------
// Pure display helper (Task 5, Phase 5b): `MemoryFactMeta.type` -> the row's badge text
// (methods.ts `MemoryTypeSchema`: user/feedback/project/reference) — same "tierBadge"-style
// mapping as `pluginRowDisplay`'s badge (`PluginManagerView.swift`). Table-tested directly in
// `DashboardTests.swift`, no `NormaClient`/SwiftUI involved, same posture as this directory's
// other pure pane helpers (`sortedTrustPaths`, `holderDisplay`, ...).
// -----------------------------------------------------------------------------------------------

/// The wire enum is closed (four cases) — `default` only guards a FUTURE server adding a fifth
/// type this client doesn't know about yet, never a real case today.
func memoryTypeBadge(_ type: String) -> String {
    switch type {
    case "user": return "User"
    case "feedback": return "Feedback"
    case "project": return "Project"
    case "reference": return "Reference"
    default: return type.capitalized
    }
}

// -----------------------------------------------------------------------------------------------
// MemoryPaneModel — the pane's live view-model (`@MainActor`/`ObservableObject`), same posture as
// `PluginManagerModel`: owns the fact list + the selected fact's detail/edit state + the audit
// tail, constructed around the raw `NormaClient` — never closures, mirroring how
// `PluginManagerModel`/`TilesStripModel`/`ShortcutBindingEditorModel` are wired into
// `DashboardWiring`. App shell T7: built once, for the process lifetime, by
// `AppDelegate.makeDashboardWiring` — replacing `DashboardWindowController.init`'s old "fresh per
// dashboard window-open" role; harmless, since `MemoryPane.task` already re-seeds it on appearance.
//
// Pane v1 scope (design doc / brief): USER scope only — the dashboard has no cwd context to
// source a project scope from, so every call below hardcodes `scope: "user"`, `cwd: nil`. Create
// is out of scope for v1: the pane only lists/edits/deletes facts `memory.list` already surfaced.
// -----------------------------------------------------------------------------------------------

@MainActor
final class MemoryPaneModel: ObservableObject {
    private let client: NormaClient
    /// Pane v1 scope: the dashboard has no cwd context, so every RPC below is pinned to the user
    /// scope — never project (that would need a `cwd` this connection doesn't have).
    private let scope = "user"

    @Published private(set) var facts: [MemoryFactMeta] = []
    @Published var errorText: String?
    @Published private(set) var loading = false

    @Published private(set) var selectedName: String?
    @Published private(set) var detail: MemoryFact?
    @Published private(set) var detailLoading = false
    @Published var detailErrorText: String?

    /// Bound directly to the detail view's `TextEditor`/`TextField` — `isDirty` compares these
    /// against `detail` to gate the Save button, same "compare live edit state to the last loaded
    /// snapshot" posture as most editor UIs in this codebase.
    @Published var editedBody: String = ""
    @Published var editedDescription: String = ""
    @Published private(set) var saving = false
    @Published private(set) var deleting = false

    @Published private(set) var auditLines: [MemoryAuditLine] = []
    @Published var auditExpanded = false
    @Published var auditErrorText: String?
    @Published private(set) var auditLoading = false

    init(client: NormaClient) {
        self.client = client
    }

    /// `true` once a fact is loaded AND its editable fields diverge from the last-loaded snapshot
    /// — `false` (not just disabled-but-clickable) while nothing is selected or nothing changed,
    /// so a stray Save tap can never fire an RPC with no actual edit.
    var isDirty: Bool {
        guard let detail else { return false }
        return editedBody != detail.body || editedDescription != detail.description
    }

    /// Save gating beyond `isDirty` (5b T5 review): `memory.write`'s wire schema requires
    /// non-empty description/body (methods.ts `min(1)`) — an emptied field could only round-trip
    /// to a server rejection surfaced as the generic save error, so the button disables
    /// client-side instead. Trimmed check (whitespace-only is as unwritable as empty); the SENT
    /// values stay untrimmed — this only gates.
    var canSave: Bool {
        isDirty
            && !editedBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !editedDescription.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Refresh the fact list — called on the pane's `.task` (initial appear) and after every
    /// mutation (save/delete), same "refresh after every action" posture as
    /// `PluginManagerModel.refresh()`. If the currently-selected fact vanished (deleted from
    /// elsewhere, or this pane's own delete already cleared it), the detail panel is cleared too —
    /// it must never keep showing a fact `memory.list` no longer reports.
    func refresh() async {
        loading = true
        defer { loading = false }
        do {
            facts = try await client.memoryList(scope: scope)
            errorText = nil
            if let name = selectedName, !facts.contains(where: { $0.name == name }) {
                clearSelection()
            }
        } catch {
            errorText = "couldn't load memory facts — try Refresh"
        }
    }

    /// Loads `name`'s full body via `memory.read` and seeds the editable fields from it.
    ///
    /// Stale-response guard (5b T5 review): two quick row taps run CONCURRENT selects; an earlier
    /// tap's slower `memory.read` resolving after a newer selection started must not overwrite the
    /// newer fact's detail/edit state — `save()` reads `selectedName` and `detail`/`editedBody` as
    /// one unit, so a stale overwrite would write fact A's body/type/description UNDER B'S NAME.
    /// The same `selectedName == name` condition gates the defer and the catch: a stale response
    /// may neither clear the NEWER selection's still-in-flight loading state nor surface its own
    /// error under the newer name.
    func select(_ name: String) async {
        selectedName = name
        detail = nil
        detailErrorText = nil
        detailLoading = true
        defer { if selectedName == name { detailLoading = false } }
        do {
            let fact = try await client.memoryRead(scope: scope, name: name)
            guard selectedName == name else { return }
            detail = fact
            editedBody = fact.body
            editedDescription = fact.description
        } catch {
            guard selectedName == name else { return }
            detailErrorText = "couldn't load \(name) — try again"
        }
    }

    /// Clears the detail panel entirely — used when the selected fact disappears from `facts`
    /// (see `refresh()`) and after a successful delete.
    func clearSelection() {
        selectedName = nil
        detail = nil
        detailErrorText = nil
        editedBody = ""
        editedDescription = ""
    }

    /// `memory.write` with the SAME name/type — this pane never renames or retypes a fact, only
    /// edits body/description (brief scope). Refreshes the list + re-reads the fact + re-loads the
    /// audit tail on success, so the row's description and the "Recent changes" tail both reflect
    /// the write immediately.
    func save() async {
        // `canSave` re-checked here, not just at the button's `.disabled` (5b T5 review): a click
        // landing before SwiftUI re-evaluates the disabled state must not send an emptied
        // body/description the server would reject — same belt-and-suspenders posture as
        // `PluginManagerModel.confirmConsent`'s double-submit guard.
        guard canSave, let name = selectedName, let type = detail?.type else { return }
        saving = true
        defer { saving = false }
        do {
            try await client.memoryWrite(scope: scope, name: name, description: editedDescription, type: type, body: editedBody)
            detailErrorText = nil
            await refresh()
            await select(name)
            await loadAudit()
        } catch {
            detailErrorText = "couldn't save \(name) — try again"
        }
    }

    /// `memory.delete` for `name` — the view gates this behind its own confirmation dialog before
    /// calling here, same "confirm before the destructive call" posture as
    /// `PluginManagerView`'s remove action (there via `.disabled(busy)` on a plain Remove button,
    /// here via an explicit alert since delete has no undo).
    func delete(_ name: String) async {
        deleting = true
        defer { deleting = false }
        do {
            try await client.memoryDelete(scope: scope, name: name)
            // Same-shape stale guard as `select(_:)` (5b T5 review): the user may have selected a
            // DIFFERENT fact while this delete was in flight — only clear the detail panel if the
            // deleted fact is still the selected one (`refresh()` below prunes the deleted row
            // from the list either way).
            if selectedName == name { clearSelection() }
            errorText = nil
            await refresh()
            await loadAudit()
        } catch {
            errorText = "couldn't delete \(name) — try again"
        }
    }

    /// `memory.audit` tail — newest-first already (the RPC's own wire contract), so this is
    /// rendered verbatim, no client-side reversal.
    func loadAudit() async {
        auditLoading = true
        defer { auditLoading = false }
        do {
            auditLines = try await client.memoryAudit(limit: 20)
            auditErrorText = nil
        } catch {
            auditErrorText = "couldn't load recent changes — try again"
        }
    }
}

// -----------------------------------------------------------------------------------------------
// MemoryPane — modeled on `PluginManagerView`'s list+detail+actions structure and `TrustPane`'s
// loading/error/empty idiom, adding a left-list/right-detail split (this pane's own addition —
// no existing Dashboard pane shows a per-row detail editor) since a fact's body needs real estate
// a single-line row can't offer.
// -----------------------------------------------------------------------------------------------

struct MemoryPane: View {
    @ObservedObject var model: MemoryPaneModel
    /// The fact pending a confirmed delete — set when "Delete" is tapped, `nil` once the alert
    /// resolves either way. Kept as a LOCAL name capture (not read back through
    /// `model.selectedName` inside the alert's action) so an in-flight confirmation always targets
    /// the fact it was opened for, even if selection somehow changed underneath it.
    @State private var confirmingDeleteName: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if let errorText = model.errorText {
                Text(errorText).foregroundStyle(.red).font(Typography.label()).padding(.horizontal)
            }
            HStack(spacing: 0) {
                factList
                    .frame(width: 220)
                Divider()
                detailSection
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .frame(maxHeight: .infinity)
            Divider()
            auditSection
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

    private var header: some View {
        HStack {
            Text("Memory").font(Typography.paneTitle)
            Spacer()
            Button("Refresh") { Task { await model.refresh(); await model.loadAudit() } }
                .disabled(model.loading)
        }
        .padding([.top, .horizontal])
        .padding(.bottom, 4)
    }

    private var factList: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                if model.facts.isEmpty {
                    Text("No memory facts")
                        .font(Typography.label())
                        .foregroundStyle(.secondary)
                        .padding(.horizontal)
                }
                ForEach(model.facts) { fact in
                    factRow(fact)
                }
            }
            .padding(.vertical, 8)
        }
    }

    private func factRow(_ fact: MemoryFactMeta) -> some View {
        let isSelected = model.selectedName == fact.name
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(fact.name)
                    .font(Typography.label(.medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 4)
                typeBadge(fact.type)
            }
            Text(fact.description)
                .font(Typography.caption())
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background {
            if isSelected {
                RoundedRectangle(cornerRadius: 6, style: .continuous).fill(.quaternary)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { Task { await model.select(fact.name) } }
    }

    private func typeBadge(_ type: String) -> some View {
        Text(memoryTypeBadge(type))
            .font(Typography.tiny(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(RoundedRectangle(cornerRadius: 4, style: .continuous).fill(.quaternary))
            .foregroundStyle(.secondary)
    }

    @ViewBuilder
    private var detailSection: some View {
        if model.selectedName == nil {
            Text("Select a fact to view or edit it")
                .font(Typography.label())
                .foregroundStyle(.secondary)
                .padding()
        } else if model.detailLoading {
            Text("Loading…")
                .font(Typography.label())
                .foregroundStyle(.secondary)
                .padding()
        } else if let detailErrorText = model.detailErrorText {
            Text(detailErrorText).foregroundStyle(.red).font(Typography.label()).padding()
        } else if model.detail != nil {
            factDetail
        }
    }

    private var factDetail: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(model.selectedName ?? "").font(Typography.control(.semibold))
                typeBadge(model.detail?.type ?? "user")
                Spacer()
                Button("Delete") { confirmingDeleteName = model.selectedName }
                    .foregroundStyle(.red)
                    .disabled(model.saving || model.deleting)
                Button("Save") { Task { await model.save() } }
                    .disabled(!model.canSave || model.saving || model.deleting)
            }
            TextField("Description", text: $model.editedDescription)
                .textFieldStyle(.roundedBorder)
                .font(Typography.label())
            TextEditor(text: $model.editedBody)
                .font(Typography.labelMono())
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(.quaternary))
        }
        .padding()
    }

    private var auditSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                model.auditExpanded.toggle()
            } label: {
                HStack {
                    Image(systemName: model.auditExpanded ? "chevron.down" : "chevron.right")
                        .font(Typography.tiny())
                    Text("Recent changes").font(Typography.label(.semibold))
                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if model.auditExpanded {
                if let auditErrorText = model.auditErrorText {
                    Text(auditErrorText).foregroundStyle(.red).font(Typography.caption())
                } else if model.auditLines.isEmpty {
                    Text("No recent changes").font(Typography.caption()).foregroundStyle(.secondary)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 2) {
                            // `MemoryAuditLine` carries no unique id of its own (the wire doesn't
                            // provide one) — enumerated offset stands in, same as any other
                            // display-only, non-`Identifiable` list in SwiftUI.
                            ForEach(Array(model.auditLines.enumerated()), id: \.offset) { _, line in
                                auditRow(line)
                            }
                        }
                    }
                    .frame(maxHeight: 120)
                }
            }
        }
        .padding()
    }

    private func auditRow(_ line: MemoryAuditLine) -> some View {
        HStack(spacing: 6) {
            Text(Date(timeIntervalSince1970: TimeInterval(line.ts) / 1000), style: .relative)
                .font(Typography.captionMono())
                .foregroundStyle(.secondary)
            Text(line.action)
                .font(Typography.caption(.medium))
            Text(line.name)
                .font(Typography.captionMono())
                .lineLimit(1)
            Spacer()
            Text(line.source)
                .font(Typography.tiny())
                .foregroundStyle(.secondary)
        }
    }
}
