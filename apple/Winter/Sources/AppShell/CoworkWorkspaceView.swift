import AppKit
import SwiftUI
import WinterKit
import WinterProtocol

/// Selection issuance is a separate local authority operation, never a path-based RPC.
/// Nil in the current production composition until the host issuer/provisioner is admitted.
struct CoworkSelectionIssuer {
    let folder: @MainActor (URL) async throws -> CoworkSelection
    let repository: @MainActor () async throws -> CoworkSelection?
}

struct CoworkWorkspaceView: View {
    @ObservedObject var model: CoworkWorkspaceModel
    var issuer: CoworkSelectionIssuer? = nil
    @State private var projectsOnly = false
    @State private var showingCreate = false
    @State private var title = ""
    @State private var project = false
    @State private var selections: [CoworkSelection] = []
    @State private var selectionLabels: [String] = []
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
                        title = ""; selections = []; selectionLabels = []; selectionError = nil; showingCreate = true
                    }.disabled(issuer == nil).help("Creation requires host-authorized sources and an available Cowork backend.")
                }
            }.padding().frame(minWidth: 230, idealWidth: 270, maxWidth: 300)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("Cowork workspaces").font(.title2.bold())
                    Label("Conversations are not available yet", systemImage: "info.circle")
                    Text("You can inspect and manage recorded workspace sources here. Cowork execution is waiting for the backend to be ready.").foregroundStyle(.secondary)
                    if issuer == nil {
                        Text("Creating workspaces and adding sources requires the Mac host selection service, which is not available yet.")
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
                        HStack {
                            Text("Sources").font(.headline)
                            Spacer()
                            Button("Add folder…") { pickFolder(creating: false) }.disabled(issuer == nil || selecting)
                            Button("Add repository…") { pickRepository(creating: false) }.disabled(issuer == nil || selecting)
                        }
                        ForEach(model.sources, id: \.sourceId) { source in
                            VStack(alignment: .leading, spacing: 5) {
                                Label(source.label, systemImage: source.kind == .folder ? "folder" : "chevron.left.forwardslash.chevron.right")
                                Text("\(source.state) · \(source.access) · \(source.trust)").font(.caption)
                                if source.reason == "access_revoked" { Text("Access was revoked. Dependent work is blocked.").foregroundStyle(.orange) }
                                if source.restartRequired { Text("A workspace restart is required before this change takes effect.").font(.caption) }
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
        .onChange(of: model.selected) { _, value in rename = value?.title ?? "" }
        .confirmationDialog(revoke ? "Revoke access to this source?" : "Remove this source?", isPresented: Binding(get: { sourceToRemove != nil }, set: { if !$0 { sourceToRemove = nil } })) {
            if let source = sourceToRemove {
                Button(revoke ? "Revoke access" : "Remove source", role: .destructive) {
                    sourceToRemove = nil
                    Task { await model.remove(source, revoke: revoke) }
                }
            }
        } message: {
            Text(revoke ? "Access will be revoked even if this is the last source. The workspace will retain an unavailable source and dependent work will be blocked." : "The source will stop being available after the backend acknowledges removal. Workspace data is retained.")
        }
        .sheet(isPresented: $showingCreate) { creation }
    }

    private var creation: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Create workspace").font(.title2)
            TextField("Title", text: $title)
            Toggle("Reusable Project workspace", isOn: $project)
            Text("Choose at least one host-authorized source.").foregroundStyle(.secondary)
            ForEach(Array(selectionLabels.enumerated()), id: \.offset) { _, label in Text(label) }
            HStack {
                Button("Choose folder…") { pickFolder(creating: true) }
                Button("Choose repository…") { pickRepository(creating: true) }
            }.disabled(selecting || issuer == nil || selections.count >= 100)
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
                    .disabled(issuer == nil || selecting || model.busy || !CoworkWorkspaceModel.validTitle(title) || selections.isEmpty)
            }
        }.padding(24).frame(width: 440).interactiveDismissDisabled(model.busy || selecting)
    }
    private func pickFolder(creating: Bool) {
        guard let issuer, !selecting else { return }
        let panel = NSOpenPanel()
        panel.title = "Choose a Cowork source folder"; panel.canChooseDirectories = true
        panel.canChooseFiles = false; panel.allowsMultipleSelection = false; panel.canCreateDirectories = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        authorize(creating: creating, label: url.lastPathComponent) { try await issuer.folder(url) }
    }
    private func pickRepository(creating: Bool) {
        guard let issuer, !selecting else { return }
        authorize(creating: creating, label: "GitHub repository") { try await issuer.repository() }
    }
    private func authorize(creating: Bool, label: String, issue: @escaping @MainActor () async throws -> CoworkSelection?) {
        selecting = true; selectionError = nil
        Task { @MainActor in
            defer { selecting = false }
            do {
                guard let selection = try await issue() else { return }
                if creating { selections.append(selection); selectionLabels.append(label) }
                else { await model.add(selection) }
            } catch { selectionError = error.localizedDescription }
        }
    }
}
