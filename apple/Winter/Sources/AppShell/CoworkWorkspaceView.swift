import AppKit
import SwiftUI
import WinterKit
import WinterProtocol

struct CoworkWorkspaceView: View {
    @ObservedObject var model: CoworkWorkspaceModel
    @State private var selectionGeneration = UUID()
    @State private var projectsOnly = false
    @State private var showingCreate = false
    @State private var title = ""
    @State private var project = false
    @State private var selections: [CoworkSelection] = []
    @State private var selectionLabels: [String] = []
    @State private var preparedIds: [String] = []
    @State private var selectionError: String?
    @State private var selecting = false
    @State private var rename = ""
    @State private var sourceToRemove: CoworkSource?
    @State private var revoke = false

    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading) {
                Picker("Workspace ownership", selection: $projectsOnly) {
                    Text("All workspaces").tag(false)
                    Text("Projects").tag(true)
                }.pickerStyle(.segmented)
                List {
                    ForEach(model.workspaces.filter { !projectsOnly || $0.ownership == .project }, id: \.workspaceId) { workspace in
                        Button {
                            Task { await model.select(workspace.workspaceId) }
                        } label: {
                            VStack(alignment: .leading) {
                                Label(workspace.title, systemImage: workspace.ownership == .project ? "folder.badge.person.crop" : "square.stack")
                                Text("\(workspace.state) · \(workspace.power)").font(.caption).foregroundStyle(.secondary)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }.buttonStyle(.plain)
                        .accessibilityLabel("\(workspace.ownership == .project ? "Project" : "Workspace") \(workspace.title), \(workspace.state), \(workspace.power)")
                        .listRowBackground(model.selected?.workspaceId == workspace.workspaceId ? Color.accentColor.opacity(0.12) : Color.clear)
                    }
                    if model.workspaces.isEmpty && !model.busy { Text("No workspaces").foregroundStyle(.secondary) }
                }
                HStack {
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await model.refresh() } }
                    Spacer()
                    Button("New", systemImage: "plus") {
                        invalidatePreparation(); title = ""; selections = []; selectionLabels = []; preparedIds = []; selectionError = nil; showingCreate = true
                    }.disabled(!model.capabilities.folderPreparation).help("Creation requires host-authorized sources and an available Cowork backend.")
                }
            }.padding().frame(minWidth: 230, idealWidth: 270, maxWidth: 300)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("Cowork workspaces").font(.title2.bold())
                    Label("Conversations are not available yet", systemImage: "info.circle")
                    Text("You can inspect and manage recorded workspace sources here. Cowork execution is waiting for the backend to be ready.").foregroundStyle(.secondary)
                    if !model.capabilities.provisioning {
                        Text("Creating workspaces and adding sources is waiting for storage and folder sharing to be available.")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    if model.busy { ProgressView("Updating workspaces…") }
                    if let error = model.error { Text(error).foregroundStyle(.red).textSelection(.enabled).accessibilityLabel("Workspace error: \(error)") }
                    if let operation = model.operation {
                        Text("Recorded change: \(operation.status)\(operation.terminal ? "" : " — awaiting acknowledgment")")
                            .font(.callout).textSelection(.enabled)
                    }
                    if let workspace = model.selected {
                        Text(workspace.ownership == .project ? "Project" : "Standalone workspace").font(.caption).foregroundStyle(.secondary)
                        Text(workspace.title).font(.title3.bold())
                        Text("State: \(workspace.state) · VM: \(workspace.power)")
                        HStack {
                            TextField("Workspace title", text: $rename)
                            Button("Rename") { Task { await model.rename(rename) } }
                                .disabled(!CoworkWorkspaceModel.validTitle(rename) || rename == workspace.title)
                        }
                        if let policy = model.policy {
                            Text("Default approvals: \(policy.defaultPolicy.rawValue)")
                            Text(workspace.automaticPublication ? "GitHub feature-branch publication is automatic." : "Publication is manual or does not currently apply.")
                        }
                        if let guidance = model.guidance, guidance.workspaceId == workspace.workspaceId {
                            guidanceEditor(guidance)
                        }
                        HStack {
                            Text("Sources").font(.headline)
                            Spacer()
                            Button("Add folder…") { pickFolder(creating: false) }.disabled(!model.capabilities.provisioning || selecting)
                            Button("Add repository…") {}.disabled(true).help("GitHub source authorization is not available yet.").disabled(!model.capabilities.provisioning || selecting)
                        }
                        ForEach(model.sources, id: \.sourceId) { source in
                            VStack(alignment: .leading, spacing: 5) {
                                Label(source.label, systemImage: source.kind == .folder ? "folder" : "chevron.left.forwardslash.chevron.right")
                                Text("\(source.state) · \(source.access) · \(source.trust)").font(.caption)
                                if source.reason == "access_revoked" { Text("Access was revoked. Dependent work is blocked.").foregroundStyle(.orange) }
                                if source.restartRequired { Text("A workspace restart is required to finish applying this change. Removed or revoked access is already blocked.").font(.caption) }
                                HStack {
                                    Button("Remove") { sourceToRemove = source; revoke = false }
                                        .disabled(source.desired == "removed" || model.sources.filter { $0.desired == "present" }.count <= 1)
                                    Button("Revoke access", role: .destructive) { sourceToRemove = source; revoke = true }
                                        .disabled(source.trust == "revoked")
                                }
                            }.padding().frame(maxWidth: .infinity, alignment: .leading)
                                .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 8))
                        }
                    } else if !model.busy { Text("Select a workspace to see its sources and policy.").foregroundStyle(.secondary) }
                    if let selectionError { Text(selectionError).foregroundStyle(.red) }
                }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .navigationTitle("Cowork")
        .disabled(model.busy)
        .task { await model.refresh() }
        .onChange(of: model.selected) { _, value in
            rename = value?.title ?? ""; invalidatePreparation()
        }
        .onChange(of: showingCreate) { _, shown in if !shown { invalidatePreparation() } }
        .onDisappear { invalidatePreparation() }
        .confirmationDialog(revoke ? "Revoke access to this source?" : "Remove this source?", isPresented: Binding(get: { sourceToRemove != nil }, set: { if !$0 { sourceToRemove = nil } })) {
            if let source = sourceToRemove {
                Button(revoke ? "Revoke access" : "Remove source", role: .destructive) {
                    sourceToRemove = nil
                    Task { await model.remove(source, revoke: revoke) }
                }
            }
        } message: {
            Text(revoke ? "Access will be revoked even if this is the last source. The workspace will retain an unavailable source and dependent work will be blocked." : "Dependent work is blocked immediately. The backend still needs to acknowledge detachment; workspace data is retained.")
        }
        .sheet(isPresented: $showingCreate) { creation }
    }

    private func guidanceEditor(_ state: CoworkWorkspaceModel.Guidance) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Shared WINTER.md").font(.headline)
                Spacer()
                Button("Refresh instructions", systemImage: "arrow.clockwise") { Task { await model.refreshInstructions(workspaceId: state.workspaceId) } }
                    .disabled(model.guidanceBusy)
            }
            Text("These instructions are shared by every conversation and subagent in this workspace. Host permissions are managed separately.")
                .font(.callout).foregroundStyle(.secondary)
            if model.guidanceBusy { ProgressView("Updating shared instructions…") }
            if let current = state.current {
                Text("Instruction revision \(current.instructionRevision) · \(current.bytes) bytes").font(.caption)
                Label(state.available ? "Conversation refresh required" : "Shared instructions unavailable",
                      systemImage: state.available ? "arrow.triangle.2.circlepath" : "exclamationmark.triangle")
                    .font(.callout).foregroundStyle(.orange)
            } else {
                Text("Shared instructions unavailable. Refresh to load the existing workspace file.")
                    .foregroundStyle(.secondary)
            }
            if let message = state.message { Text(message).font(.callout).textSelection(.enabled) }
            if let receipt = state.receipt {
                Text("Host save recorded at instruction revision \(receipt.value.instructionRevision).")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let draft = state.draft {
                TextEditor(text: Binding(get: { model.guidance?.workspaceId == state.workspaceId ? (model.guidance?.draft ?? draft) : draft },
                                         set: { model.editInstructions($0, workspaceId: state.workspaceId) }))
                    .font(.system(.body, design: .monospaced)).frame(minHeight: 180)
                    .accessibilityLabel("Shared workspace instructions draft")
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
                let valid = draft.utf8.count <= CoworkWorkspaceModel.instructionMaxBytes && !draft.contains("\0")
                Text("\(draft.utf8.count) / \(CoworkWorkspaceModel.instructionMaxBytes) UTF-8 bytes\(state.hasUnsavedChanges ? " · unsaved draft" : "")")
                    .font(.caption).foregroundStyle(valid ? Color.secondary : Color.red)
                if !valid { Text("The draft exceeds the file limit or contains a NUL character.").font(.caption).foregroundStyle(.red) }
                HStack {
                    Button("Save instructions") {
                        Task { await model.saveInstructions(workspaceId: state.workspaceId, expectedDraft: draft,
                                                           expectedRevision: state.current?.instructionRevision, expectedDigest: state.current?.digest) }
                    }
                        .disabled(model.guidanceBusy || !state.canSave || !valid)
                    if state.hasUnconfirmedSave {
                        Button("Retry pending save") { Task { await model.retryInstructionSave(workspaceId: state.workspaceId, requestId: state.pendingRequestId) } }.disabled(model.guidanceBusy)
                    }
                }
            }
            if state.conflict {
                Text("The shared file changed. Compare the current content with your retained draft before saving.")
                    .foregroundStyle(.orange)
                if state.available, let current = state.currentContent {
                    DisclosureGroup("Current shared content") {
                        ScrollView { Text(current).font(.system(.body, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                            .frame(maxHeight: 180)
                    }
                    HStack {
                        Button("Keep my draft against this version") { model.reviewInstructionConflict(keepDraft: true, workspaceId: state.workspaceId, expectedRevision: state.current?.instructionRevision, expectedDigest: state.current?.digest) }
                        Button("Use current content") { model.reviewInstructionConflict(keepDraft: false, workspaceId: state.workspaceId, expectedRevision: state.current?.instructionRevision, expectedDigest: state.current?.digest) }
                    }.disabled(model.guidanceBusy || state.hasUnconfirmedSave)
                }
            }
            if let pending = state.pendingContent {
                DisclosureGroup("Content of the unconfirmed save") {
                    ScrollView { Text(pending).font(.system(.body, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                        .frame(maxHeight: 180)
                }
            }
            if let provenance = state.provenance {
                DisclosureGroup("Instruction provenance") {
                    ForEach(Array(provenance.entries.enumerated()), id: \.offset) { _, entry in
                        Text(entry.guestPath).textSelection(.enabled)
                        Text(entry.digest).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    }
                    Text("Repository instruction discovery is unavailable until Cowork execution is ready.").font(.caption).foregroundStyle(.secondary)
                }
            }
        }.padding().frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 8))
    }

    private var creation: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Create workspace").font(.title2)
            TextField("Title", text: $title)
            Toggle("Reusable Project workspace", isOn: $project)
            Text("Choose at least one host-authorized source.").foregroundStyle(.secondary)
            if !model.capabilities.provisioning { Text("Workspace creation is waiting for storage and folder sharing. Selecting a folder does not start a workspace.").foregroundStyle(.secondary) }
            ForEach(Array(selectionLabels.enumerated()), id: \.offset) { _, label in Text(label) }
            HStack {
                Button("Choose folder…") { pickFolder(creating: true) }
                Button("Choose repository…") {}.disabled(true).help("GitHub source authorization is not available yet.")
            }.disabled(selecting || !model.capabilities.folderPreparation || selections.count >= 100)
            if selecting { ProgressView("Authorizing source…") }
            if let selectionError { Text(selectionError).foregroundStyle(.red) }
            if let error = model.error { Text(error).foregroundStyle(.red) }
            HStack {
                Button("Cancel") { showingCreate = false }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("Create") {
                    Task {
                        await model.create(title: title, ownership: project ? .project : .standalone, selections: selections)
                        if model.lastMutationRecorded { showingCreate = false }
                    }
                }.keyboardShortcut(.defaultAction)
                    .disabled(!model.capabilities.provisioning || selecting || model.busy || !CoworkWorkspaceModel.validTitle(title) || selections.isEmpty)
            }
        }.padding(24).frame(width: 440).interactiveDismissDisabled(model.busy || selecting)
    }

    private func invalidatePreparation() {
        selectionGeneration = UUID(); selecting = false
        let ids = preparedIds; preparedIds = []
        Task { for id in ids { await model.revokePreparation(id) } }
    }
    private func pickFolder(creating: Bool) {
        guard model.capabilities.folderPreparation, !selecting else { return }
        let panel = NSOpenPanel()
        panel.title = "Choose a Cowork source folder"; panel.canChooseDirectories = true
        panel.canChooseFiles = false; panel.allowsMultipleSelection = false; panel.canCreateDirectories = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let context = CoworkPreparationContext(generation: selectionGeneration, workspaceId: model.selected?.workspaceId, revision: model.selected?.configRevision, creating: creating)
        selecting = true; selectionError = nil
        Task { @MainActor in
            defer { if selectionGeneration == context.generation { selecting = false } }
            do {
                let prepared = try await model.prepareFolder(url)
                guard context.canApply(generation: selectionGeneration, workspaceId: model.selected?.workspaceId, revision: model.selected?.configRevision, creationPresented: showingCreate) else {
                    await model.revokePreparation(prepared.selectionId); return
                }
                if creating {
                    selections.append(prepared.selection); preparedIds.append(prepared.selectionId)
                    selectionLabels.append(prepared.label + " — selected")
                } else {
                    defer { Task { await model.revokePreparation(prepared.selectionId) } }
                    if let id = context.workspaceId, let revision = context.revision {
                        await model.add(prepared.selection, workspaceId: id, expectedRevision: revision)
                    }
                }
            } catch { if selectionGeneration == context.generation { selectionError = error.localizedDescription } }
        }
    }
}
