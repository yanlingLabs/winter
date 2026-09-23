import SwiftUI
import WinterKit

// -----------------------------------------------------------------------------------------------
// Library → Skills (2026-09-17; drill-in 2026-09-18).
//
// THE MODEL IS REUSED, THE VIEW IS NOT. `SkillsPaneModel` (Sources/Dashboard/panes/SkillsPane.swift,
// on `DashboardWiring.skillsModel`) owns the list, the selection, `skills.read`, and the self-only
// write/delete loop — its logic is right and `SkillsPaneModelTests` pins it. `SkillsPane`'s VIEW is
// a master/detail split, which inside this panel was the third column the user asked to lose, so
// the Library draws its own two pages over the same model:
//
//   - LIST (`LibrarySkillsList`): the skills grouped by source, each row a door to its detail.
//   - DETAIL (`LibrarySkillDetail`): one skill, full width — description and body, and for a
//     SELF-authored skill exactly the edit/save/delete the Dashboard offers (`isSelectedSelf`
//     gates every editing affordance, `canSave` gates Save, delete goes through a confirmation).
//
// SAME MODEL INSTANCE AS THE DASHBOARD. Whichever surface appears last re-seeds the list; a
// half-typed edit in one is visible in the other — one skill store, two windows onto it.
//
// NO per-skill enable/disable toggle, by decision: the daemon's mechanism for that is a permission
// DENY RULE (`Skill(<name>)`), a rules-store write rather than a field on the skill. A toggle here
// would be a second, unbacked source of truth for "is this skill on".
// -----------------------------------------------------------------------------------------------

struct LibrarySkillsList: View {
    @ObservedObject var model: SkillsPaneModel
    /// The skill last opened, marked in the list so stepping back shows where you were.
    let selected: LibraryItemRef?
    let onOpen: (LibraryItemRef) -> Void

    var body: some View {
        LibraryListPage(title: "Skills") {
            Button("Refresh") { Task { await model.refresh() } }
                .disabled(model.loading)
        } content: {
            if let errorText = model.errorText {
                LibraryErrorLine(text: errorText)
            }
            if model.skills.isEmpty {
                // `SkillsPaneModel` has no "has loaded" flag; `loading` is the one honest signal,
                // and on a failed first read the error line above is what explains the empty list.
                LibraryStateLine(text: model.loading ? "Loading…" : "No skills")
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(skillsGroupedBySource(model.skills), id: \.source) { group in
                            VStack(alignment: .leading, spacing: 1) {
                                LibraryGroupHeader(title: skillSourceBadge(group.source),
                                                   detail: "\(group.skills.count)")
                                ForEach(group.skills) { skill in
                                    row(skill)
                                }
                            }
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        .task { await model.refresh() }
    }

    private func row(_ skill: SkillMeta) -> some View {
        let ref = LibraryItemRef.skill(name: skill.name)
        return LibraryLinkRow(
            systemImage: "book.closed",
            title: skill.name,
            subtitle: skill.description,
            isSelected: selected == ref,
            action: { onOpen(ref) }
        ) {
            if let author = skill.author {
                LibraryRowBadge(text: "author: \(author)")
            }
            // 2026-09-22 (lane B): a skill no session can load is badged, with the daemon's reason as
            // the tooltip — listed bare it would read as "available to the agent", which it is not.
            if let note = skill.notInSessionsNote {
                LibraryRowBadge(text: "Not in sessions")
                    .help(note)
            }
        }
    }
}

struct LibrarySkillDetail: View {
    @ObservedObject var model: SkillsPaneModel
    let name: String
    let onBack: () -> Void
    /// The skill's own delete vanished it — the panel steps back to the list.
    let onVanished: () -> Void

    /// Captured at the click, not read back from `model.selectedName` inside the alert's action, so
    /// an in-flight confirmation always targets the skill it was opened for (the Dashboard pane's
    /// same posture).
    @State private var confirmingDeleteName: String?

    /// The loaded detail belongs to THIS page's skill. `detail` is the model's single slot; until
    /// `select(name)` lands it may still hold the previously opened skill.
    private var detailIsCurrent: Bool {
        model.selectedName == name && model.detail?.name == name
    }

    var body: some View {
        LibraryDetailPage(
            title: name,
            subtitle: subtitle,
            backLabel: "Back to Skills",
            onBack: onBack
        ) {
            if detailIsCurrent && model.isSelectedSelf {
                HStack(spacing: 10) {
                    Button("Delete") { confirmingDeleteName = name }
                        .buttonStyle(.plain)
                        .foregroundStyle(.red)
                        .disabled(model.saving || model.deleting)
                    Button("Save") { Task { await model.save() } }
                        .disabled(!model.canSave || model.saving || model.deleting)
                }
                .font(Typography.label())
            }
        } content: {
            content
        }
        .task(id: name) {
            if libraryShouldReloadSkill(opening: name, selectedName: model.selectedName,
                                        isDirty: model.isDirty) {
                await model.select(name)
            }
        }
        // `delete` (and a refresh that no longer lists the skill) clears the model's selection.
        .onChange(of: model.selectedName) { _, selected in
            if selected == nil { onVanished() }
        }
        .alert(
            "Delete \(confirmingDeleteName ?? "")?",
            isPresented: Binding(
                get: { confirmingDeleteName != nil },
                set: { if !$0 { confirmingDeleteName = nil } }
            )
        ) {
            Button("Delete", role: .destructive) {
                if let target = confirmingDeleteName { Task { await model.delete(target) } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This can't be undone.")
        }
    }

    private var subtitle: String {
        guard detailIsCurrent, let detail = model.detail else { return "Skill" }
        return "\(skillSourceBadge(detail.source)) skill"
    }

    @ViewBuilder
    private var content: some View {
        // A failed DELETE reports on the model's list-level line — this page is where it was taken.
        if let errorText = model.errorText {
            LibraryErrorLine(text: errorText)
        }
        if model.selectedName == name, let detailErrorText = model.detailErrorText {
            LibraryErrorLine(text: detailErrorText)
        } else if !detailIsCurrent {
            LibraryStateLine(text: "Loading…")
        } else if model.isSelectedSelf {
            editable
        } else {
            readOnly
        }
    }

    /// Anything not self-authored: read-only. `skills.write`/`skills.delete` are server-confined to
    /// the self source anyway; this page never even offers them.
    @ViewBuilder
    private var readOnly: some View {
        if let detail = model.detail {
            Text(detail.description)
                .font(Typography.label())
                .foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            Divider()
            Text(detail.body)
                .font(Typography.labelMono())
                .foregroundStyle(Theme.textPrimary)
                .frame(maxWidth: .infinity, alignment: .topLeading)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }

    /// Self-authored: the description and body are editable in place. The body editor has a fixed
    /// working height because it sits inside the page's scroll view (an editor with no height of its
    /// own collapses there); its own text scrolls inside it.
    @ViewBuilder
    private var editable: some View {
        TextField("Description", text: $model.editedDescription)
            .textFieldStyle(.roundedBorder)
            .font(Typography.label())
        TextEditor(text: $model.editedBody)
            .font(Typography.labelMono())
            .scrollContentBackground(.hidden)
            .padding(6)
            .frame(maxWidth: .infinity)
            .frame(height: librarySkillEditorHeight)
            .overlay(
                RoundedRectangle(cornerRadius: shellSidebarRowCornerRadius, style: .continuous)
                    .strokeBorder(Theme.hairlineElevated, lineWidth: shellSidebarHairlineWidth)
            )
        if model.saving {
            LibraryStateLine(text: "Saving…")
        }
    }
}

/// The self-skill body editor's height inside the detail page — the card's height less its header
/// and the description field, so the editor fills the page rather than scrolling the page.
let librarySkillEditorHeight: CGFloat = shellOverlayHeight - 150
