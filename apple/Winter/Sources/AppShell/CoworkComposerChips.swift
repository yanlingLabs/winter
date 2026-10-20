import AppKit
import SwiftUI
import WinterKit
import WinterProtocol

// The Cowork composer's live chips (design 7.9). Everything here is reachable only through
// `CoworkComposerStripSwitch`, which draws the original placeholder strip, byte for byte, until
// `CoworkComposerModel.isOpen` — the app's own availability constant AND the daemon's `execution` and
// `provisioning`. The constant is `false` today, so none of this appears.

/// What the Cowork composer is wired to: the one model that holds the folder and approval choices, and how to
/// open the native folder picker. A struct of references so `ComposerContext` stays a plain value.
struct CoworkComposerWiring {
    let model: CoworkComposerModel
    /// Opens the native picker and prepares the chosen folder through the host. Never called while closed.
    let pickFolder: () -> Void
}

/// PURE: the strip a Cowork composer shows for a gate state. Two answers only — the placeholders that have
/// always been there, or the live chips — so a test can assert that a closed gate shows exactly the old thing.
enum CoworkStripFace: Equatable {
    case placeholders, live
}

func coworkStripFace(isOpen: Bool) -> CoworkStripFace { isOpen ? .live : .placeholders }

/// Swaps the placeholders for the live chips when (and only when) the model says Cowork is open. Observes the
/// model, so the swap happens when the capabilities read lands.
struct CoworkComposerStripSwitch: View {
    @ObservedObject var model: CoworkComposerModel
    let wiring: CoworkComposerWiring
    let announcement: String

    var body: some View {
        switch coworkStripFace(isOpen: model.isOpen) {
        case .placeholders: CoworkComposerStrip(announcement: announcement)
        case .live: CoworkLiveStrip(model: model, wiring: wiring, announcement: announcement)
        }
    }
}

/// The folder and approval chips, live. Laid out exactly like `CoworkComposerStrip` (same inset, same height,
/// same chip), because it is the same band.
struct CoworkLiveStrip: View {
    @ObservedObject var model: CoworkComposerModel
    let wiring: CoworkComposerWiring
    let announcement: String
    @State private var showingFolders = false
    @State private var showingApproval = false

    var body: some View {
        HStack(spacing: 10) {
            folderChip
            approvalChip
            if let problem = model.folderError {
                Text(problem)
                    .font(Typography.control())
                    .foregroundStyle(.red)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 12)
            if !announcement.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "sparkles").font(Typography.caption())
                    Text(announcement).lineLimit(1).truncationMode(.tail)
                }
                .font(Typography.control())
                .foregroundStyle(Theme.textMuted)
            }
        }
        .padding(.horizontal, 18)
        .frame(height: newChatComposerStripHeight)
    }

    private var folderChip: some View {
        let copy = coworkFolderChipCopy(model.folder)
        return NewChatControlChip(systemImage: "folder", title: copy.title, label: copy.help,
                                  action: { showingFolders = true })
            .popover(isPresented: $showingFolders, arrowEdge: .top) { folderPicker }
    }

    private var folderPicker: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Working folder")
                .font(Typography.caption(.semibold))
                .foregroundStyle(.secondary)
            Text(coworkFolderPickerNote)
                .font(Typography.caption())
                .foregroundStyle(Theme.textMuted)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, 6)
            Button {
                showingFolders = false
                wiring.pickFolder()
            } label: {
                Label("Choose folder…", systemImage: "folder.badge.plus")
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.vertical, 4)
            if !model.projects.isEmpty {
                Text("Projects")
                    .font(Typography.caption(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.top, 6)
                ForEach(model.projects, id: \.workspaceId) { project in
                    Button {
                        model.chooseProject(project)
                        showingFolders = false
                    } label: {
                        HStack {
                            Text(project.title)
                            Spacer()
                            if case .existingProject(let id, _)? = model.folder, id == project.workspaceId {
                                Image(systemName: "checkmark")
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .padding(.vertical, 4)
                }
            }
            if model.folder != nil {
                Button {
                    model.clearFolder()
                    showingFolders = false
                } label: {
                    Text("Clear").foregroundStyle(.secondary).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.top, 6)
            }
        }
        .padding(12)
        .frame(width: 280, alignment: .leading)
    }

    private var approvalChip: some View {
        let copy = coworkApprovalChipCopy(model.approval)
        return NewChatControlChip(systemImage: "hand.raised", title: copy.title, label: copy.help,
                                  titleStyle: model.approval == .bypass ? AnyShapeStyle(.red) : AnyShapeStyle(.primary),
                                  action: { showingApproval = true })
            .popover(isPresented: $showingApproval, arrowEdge: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Approval mode")
                        .font(Typography.caption(.semibold))
                        .foregroundStyle(.secondary)
                    Text(coworkApprovalPickerNote)
                        .font(Typography.caption())
                        .foregroundStyle(Theme.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.bottom, 6)
                    Button {
                        model.setApproval(nil)
                    } label: {
                        HStack {
                            Text("Workspace default")
                            Spacer()
                            if model.approval == nil { Image(systemName: "checkmark") }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .padding(.vertical, 4)
                    ForEach(coworkApprovalOffers, id: \.rawValue) { policy in
                        PolicyPickerRow(policy: policy.rawValue, current: model.approval?.rawValue, isDisabled: false) { raw in
                            model.setApproval(CoworkApprovalPolicy(rawValue: raw))
                        }
                    }
                }
                .padding(12)
                .frame(width: 280, alignment: .leading)
            }
    }
}

/// The approval modes the picker offers, in the session picker's order (`sessionPolicyModes`).
let coworkApprovalOffers: [CoworkApprovalPolicy] = sessionPolicyModes.compactMap { CoworkApprovalPolicy(rawValue: $0) }

// MARK: - The native folder picker

/// Opens the system folder picker and hands the choice to the host for preparation. A URL string is never
/// sent as authority: `prepareFolder` takes a bookmark made from the picker's own URL.
@MainActor
func coworkPickFolder(into composer: CoworkComposerModel, workspaces: CoworkWorkspaceModel?) {
    guard composer.isOpen, let workspaces else { return }
    let panel = NSOpenPanel()
    panel.title = "Choose a working folder for this Cowork workspace"
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.canCreateDirectories = false
    guard panel.runModal() == .OK, let url = panel.url else { return }
    Task { @MainActor in
        // The workspace model owns the capability read that says folders can be prepared; refresh it so a
        // picker opened before the first read does not fail on a stale answer.
        if !workspaces.capabilities.folderPreparation { await workspaces.refresh() }
        await composer.pickFolder { try await workspaces.prepareFolder(url) }
    }
}
