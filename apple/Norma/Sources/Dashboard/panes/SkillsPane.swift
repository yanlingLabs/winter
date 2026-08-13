import NormaKit
import SwiftUI

// -----------------------------------------------------------------------------------------------
// Pure display helpers (Task 4, Phase 5c) — table-tested directly in `DashboardTests.swift`, no
// `NormaClient`/SwiftUI involved, same posture as `memoryTypeBadge` (`MemoryPane.swift`) and this
// directory's other pure pane helpers.
// -----------------------------------------------------------------------------------------------

/// The wire enum is closed (five cases) — `default` only guards a FUTURE server adding a sixth
/// source this client doesn't know about yet, never a real case today.
func skillSourceBadge(_ source: String) -> String {
    switch source {
    case "project": return "Project"
    case "user": return "User"
    case "self": return "Self"
    case "plugin": return "Plugin"
    case "builtin": return "Builtin"
    default: return source.capitalized
    }
}

/// The fixed group display order — `skills.read`'s own resolution precedence (methods.ts's header
/// comment above `SkillsReadParams`: "project > user > self > plugin > builtin"), reused here as
/// the pane's per-source section order.
let skillSourceOrder: [String] = ["project", "user", "self", "plugin", "builtin"]

/// Groups `skills` by `source` in `skillSourceOrder`, omitting empty groups; a source outside that
/// fixed list (a future server addition) still gets its own trailing group — sorted alphabetically
/// among themselves — rather than silently vanishing from the pane. Each group's skills keep the
/// order `skills.list` returned them in (no client-side re-sort within a group).
func skillsGroupedBySource(_ skills: [SkillMeta]) -> [(source: String, skills: [SkillMeta])] {
    var groups: [(source: String, skills: [SkillMeta])] = []
    for source in skillSourceOrder {
        let matched = skills.filter { $0.source == source }
        if !matched.isEmpty { groups.append((source, matched)) }
    }
    let known = Set(skillSourceOrder)
    let unknownSources = Set(skills.map(\.source)).subtracting(known).sorted()
    for source in unknownSources {
        groups.append((source, skills.filter { $0.source == source }))
    }
    return groups
}

// -----------------------------------------------------------------------------------------------
// SkillsPaneModel — the pane's live view-model (`@MainActor`/`ObservableObject`). Modeled directly
// on `MemoryPaneModel` (Phase 5b Task 5, freshest reviewed precedent): owns the skill list + the
// selected skill's detail/edit state, constructed around the raw `NormaClient`. App shell T7:
// built once, for the process lifetime, by `AppDelegate.makeDashboardWiring` — replacing
// `DashboardWindowController.init`'s old "fresh per dashboard window-open" role; harmless, since
// `SkillsPane.task` already re-seeds it on appearance.
//
// Unlike Memory, there is no scope/cwd param to choose here: `skills.list`/`skills.read` resolve
// against the connection's own cwd-less view (the dashboard has none), and `skills.write`/
// `skills.delete` are server-confined to the self source regardless of any scope this pane could
// pass — see `NormaClient+Methods.swift`'s Skills section header comment. Non-self skills are
// READ-ONLY here: this pane must never offer Save/Delete for anything `isSelectedSelf` reports
// `false` for (a "duplicate to self" affordance is explicitly OUT of scope, brief T4).
// -----------------------------------------------------------------------------------------------

@MainActor
final class SkillsPaneModel: ObservableObject {
    private let client: NormaClient

    @Published private(set) var skills: [SkillMeta] = []
    @Published var errorText: String?
    @Published private(set) var loading = false

    @Published private(set) var selectedName: String?
    @Published private(set) var detail: Skill?
    @Published private(set) var detailLoading = false
    @Published var detailErrorText: String?

    /// Bound directly to the detail view's `TextEditor`/`TextField` when the selection is
    /// self-authored — same "compare live edit state to the last loaded snapshot" posture as
    /// `MemoryPaneModel`.
    @Published var editedBody: String = ""
    @Published var editedDescription: String = ""
    @Published private(set) var saving = false
    @Published private(set) var deleting = false

    init(client: NormaClient) {
        self.client = client
    }

    /// Whether the CURRENTLY-LOADED detail is self-authored — gates every editing affordance
    /// (Save/Delete, and whether the detail view renders editable fields at all). `skills.write`/
    /// `skills.delete` are self-confined server-side regardless, but the pane must never even
    /// OFFER them for a non-self skill (brief T4 scope).
    var isSelectedSelf: Bool { detail?.source == "self" }

    /// `true` once a self-authored skill is loaded AND its editable fields diverge from the
    /// last-loaded snapshot — `false` for a non-self skill even if the (inert) fields somehow
    /// differ, same "never savable unless truly editable" posture as `isSelectedSelf` gating.
    var isDirty: Bool {
        guard let detail, isSelectedSelf else { return false }
        return editedBody != detail.body || editedDescription != detail.description
    }

    /// Save gating beyond `isDirty` (mirrors `MemoryPaneModel.canSave`): `skills.write`'s wire
    /// schema requires non-empty description/body (methods.ts `min(1)`) — an emptied field could
    /// only round-trip to a server rejection surfaced as the generic save error, so the button
    /// disables client-side instead. Trimmed check (whitespace-only is as unwritable as empty);
    /// the SENT values stay untrimmed — this only gates.
    var canSave: Bool {
        isSelectedSelf
            && isDirty
            && !editedBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !editedDescription.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Refresh the skill list — called on the pane's `.task` (initial appear) and after every
    /// mutation (save/delete). If the currently-selected skill vanished (deleted from elsewhere,
    /// or this pane's own delete already cleared it), the detail panel is cleared too.
    func refresh() async {
        loading = true
        defer { loading = false }
        do {
            skills = try await client.skillsList()
            errorText = nil
            if let name = selectedName, !skills.contains(where: { $0.name == name }) {
                clearSelection()
            }
        } catch {
            errorText = "couldn't load skills — try Refresh"
        }
    }

    /// Loads `name`'s full body via `skills.read` and seeds the editable fields from it.
    ///
    /// Stale-response guard (copied verbatim from `MemoryPaneModel.select(_:)`, house pattern):
    /// two quick row taps run CONCURRENT selects; an earlier tap's slower `skills.read` resolving
    /// after a newer selection started must not overwrite the newer skill's detail/edit state —
    /// `save()` reads `selectedName` and `detail`/`editedBody` as one unit, so a stale overwrite
    /// would write skill A's body/description UNDER B'S NAME. The same `selectedName == name`
    /// condition gates the defer and the catch: a stale response may neither clear the NEWER
    /// selection's still-in-flight loading state nor surface its own error under the newer name.
    func select(_ name: String) async {
        selectedName = name
        detail = nil
        detailErrorText = nil
        detailLoading = true
        defer { if selectedName == name { detailLoading = false } }
        do {
            let skill = try await client.skillsRead(name: name)
            guard selectedName == name else { return }
            detail = skill
            editedBody = skill.body
            editedDescription = skill.description
        } catch {
            guard selectedName == name else { return }
            detailErrorText = "couldn't load \(name) — try again"
        }
    }

    /// Clears the detail panel entirely — used when the selected skill disappears from `skills`
    /// (see `refresh()`) and after a successful delete.
    func clearSelection() {
        selectedName = nil
        detail = nil
        detailErrorText = nil
        editedBody = ""
        editedDescription = ""
    }

    /// `skills.write` with the SAME name — this pane never renames a skill, only edits
    /// body/description (brief scope). Refreshes the list + re-reads the skill on success, so the
    /// row's description reflects the write immediately.
    func save() async {
        // `canSave` re-checked here, not just at the button's `.disabled` (same belt-and-suspenders
        // posture as `MemoryPaneModel.save()`): a click landing before SwiftUI re-evaluates the
        // disabled state must not send an emptied body/description the server would reject.
        guard canSave, let name = selectedName else { return }
        saving = true
        defer { saving = false }
        do {
            try await client.skillsWrite(name: name, description: editedDescription, body: editedBody)
            detailErrorText = nil
            await refresh()
            await select(name)
        } catch {
            detailErrorText = "couldn't save \(name) — try again"
        }
    }

    /// `skills.delete` for `name` — the view gates this behind its own confirmation dialog before
    /// calling here, same posture as `MemoryPaneModel.delete(_:)`.
    func delete(_ name: String) async {
        deleting = true
        defer { deleting = false }
        do {
            try await client.skillsDelete(name: name)
            // Same-shape stale guard as `select(_:)` (copied from `MemoryPaneModel.delete(_:)`):
            // the user may have selected a DIFFERENT skill while this delete was in flight — only
            // clear the detail panel if the deleted skill is still the selected one (`refresh()`
            // below prunes the deleted row from the list either way).
            if selectedName == name { clearSelection() }
            errorText = nil
            await refresh()
        } catch {
            errorText = "couldn't delete \(name) — try again"
        }
    }
}

// -----------------------------------------------------------------------------------------------
// SkillsPane — modeled directly on `MemoryPane`'s list+detail split, replacing the flat fact list
// with per-source GROUPED sections (`skillsGroupedBySource`) since a skill's source (project/user/
// self/plugin/builtin) is the pane's primary organizing axis, unlike Memory's flat user-scope-only
// list. No audit tail here — skills has no `skills.audit` RPC.
// -----------------------------------------------------------------------------------------------

struct SkillsPane: View {
    @ObservedObject var model: SkillsPaneModel
    /// The skill pending a confirmed delete — set when "Delete" is tapped, `nil` once the alert
    /// resolves either way. Kept as a LOCAL name capture (not read back through
    /// `model.selectedName` inside the alert's action) so an in-flight confirmation always targets
    /// the skill it was opened for, even if selection somehow changed underneath it — same posture
    /// as `MemoryPane`'s `confirmingDeleteName`.
    @State private var confirmingDeleteName: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if let errorText = model.errorText {
                Text(errorText).foregroundStyle(.red).font(Typography.label()).padding(.horizontal)
            }
            HStack(spacing: 0) {
                skillList
                    .frame(width: 220)
                Divider()
                detailSection
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .frame(maxHeight: .infinity)
        }
        .task {
            await model.refresh()
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
            Text("Skills").font(Typography.paneTitle)
            Spacer()
            Button("Refresh") { Task { await model.refresh() } }
                .disabled(model.loading)
        }
        .padding([.top, .horizontal])
        .padding(.bottom, 4)
    }

    private var skillList: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 4) {
                if model.skills.isEmpty {
                    Text("No skills")
                        .font(Typography.label())
                        .foregroundStyle(.secondary)
                        .padding(.horizontal)
                }
                ForEach(skillsGroupedBySource(model.skills), id: \.source) { group in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(skillSourceBadge(group.source).uppercased())
                            .font(Typography.tiny(.semibold))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 8)
                            .padding(.top, 6)
                        ForEach(group.skills) { skill in
                            skillRow(skill)
                        }
                    }
                }
            }
            .padding(.vertical, 8)
        }
    }

    private func skillRow(_ skill: SkillMeta) -> some View {
        let isSelected = model.selectedName == skill.name
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(skill.name)
                    .font(Typography.label(.medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 4)
                if let author = skill.author {
                    authorMarker(author)
                }
            }
            Text(skill.description)
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
        .onTapGesture { Task { await model.select(skill.name) } }
    }

    /// The "author: norma" marker (brief T4) — shown whenever `SkillMeta.author` is set (in
    /// practice, always "norma": `SkillStore.writeSelf` stamps it on every self-authored skill).
    private func authorMarker(_ author: String) -> some View {
        Text("author: \(author)")
            .font(Typography.badge(.semibold))
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(RoundedRectangle(cornerRadius: 3, style: .continuous).fill(.quaternary))
            .foregroundStyle(.secondary)
    }

    private func sourceBadge(_ source: String) -> some View {
        Text(skillSourceBadge(source))
            .font(Typography.tiny(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(RoundedRectangle(cornerRadius: 4, style: .continuous).fill(.quaternary))
            .foregroundStyle(.secondary)
    }

    @ViewBuilder
    private var detailSection: some View {
        if model.selectedName == nil {
            Text("Select a skill to view it")
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
            if model.isSelectedSelf {
                editableSkillDetail
            } else {
                readOnlySkillDetail
            }
        }
    }

    /// Non-self detail: read-only (brief T4 — this pane never offers Save/Delete for anything
    /// `skills.write`/`skills.delete` couldn't touch anyway).
    private var readOnlySkillDetail: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(model.selectedName ?? "").font(Typography.control(.semibold))
                sourceBadge(model.detail?.source ?? "")
                Spacer()
            }
            Text(model.detail?.description ?? "")
                .font(Typography.label())
                .foregroundStyle(.secondary)
            ScrollView {
                Text(model.detail?.body ?? "")
                    .font(Typography.labelMono())
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .padding(8)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(.quaternary))
        }
        .padding()
    }

    /// Self detail: editable body/description, Save (canSave-gated), Delete (confirmation) —
    /// same "MemoryPane treatment" as `MemoryPane.factDetail` (brief T4).
    private var editableSkillDetail: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(model.selectedName ?? "").font(Typography.control(.semibold))
                sourceBadge(model.detail?.source ?? "self")
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
}
