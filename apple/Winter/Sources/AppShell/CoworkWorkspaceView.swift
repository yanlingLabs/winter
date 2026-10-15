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
    @State private var confirmingAbandon = false
    @State private var confirmingUseCurrent = false

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
                                Text("\(workspace.state) · \(workspace.power)").font(Typography.caption()).foregroundStyle(.secondary)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }.buttonStyle(.plain)
                        .accessibilityLabel("\(workspace.ownership == .project ? "Project" : "Workspace") \(workspace.title), \(workspace.state), \(workspace.power)")
                        .listRowBackground(model.selected?.workspaceId == workspace.workspaceId ? Theme.selectionPill : Color.clear)
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
                    Text("Cowork workspaces").font(Typography.heading(.bold))
                    Label("Conversations are not available yet", systemImage: "info.circle")
                    Text("You can inspect and manage recorded workspace sources here. Cowork execution is waiting for the backend to be ready.").foregroundStyle(.secondary)
                    if !model.capabilities.provisioning {
                        Text("Creating workspaces and adding sources is waiting for storage and folder sharing to be available.")
                            .font(Typography.label()).foregroundStyle(.secondary)
                    }
                    if model.busy { ProgressView("Updating workspaces…") }
                    if let error = model.error { Text(error).foregroundStyle(.red).textSelection(.enabled).accessibilityLabel("Workspace error: \(error)") }
                    if let operation = model.operation {
                        Text("Recorded change: \(operation.status)\(operation.terminal ? "" : " — awaiting acknowledgment")")
                            .font(Typography.label()).textSelection(.enabled)
                    }
                    if let workspace = model.selected {
                        Text(workspace.ownership == .project ? "Project" : "Standalone workspace").font(Typography.caption()).foregroundStyle(.secondary)
                        Text(workspace.title).font(Typography.bodyLarge(.bold))
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
                        CoworkSchedulesView(model: model.schedules, workspace: workspace, policyRevision: model.policy?.revision)
                        HStack {
                            Text("Sources").font(Typography.paneTitle)
                            Spacer()
                            Button("Add folder…") { pickFolder(creating: false) }.disabled(!model.capabilities.provisioning || selecting)
                            Button("Add repository…") {}.disabled(true).help("GitHub source authorization is not available yet.").disabled(!model.capabilities.provisioning || selecting)
                        }
                        ForEach(model.sources, id: \.sourceId) { source in
                            VStack(alignment: .leading, spacing: 5) {
                                Label(source.label, systemImage: source.kind == .folder ? "folder" : "chevron.left.forwardslash.chevron.right")
                                Text("\(source.state) · \(source.access) · \(source.trust)").font(Typography.caption())
                                if source.reason == "access_revoked" { Text("Access was revoked. Dependent work is blocked.").foregroundStyle(.orange) }
                                if source.restartRequired { Text("A workspace restart is required to finish applying this change. Removed or revoked access is already blocked.").font(Typography.caption()) }
                                HStack {
                                    Button("Remove") { sourceToRemove = source; revoke = false }
                                        .disabled(source.desired == "removed" || model.sources.filter { $0.desired == "present" }.count <= 1)
                                    Button("Revoke access", role: .destructive) { sourceToRemove = source; revoke = true }
                                        .disabled(source.trust == "revoked")
                                }
                            }.padding().frame(maxWidth: .infinity, alignment: .leading)
                                .background(Theme.elevatedSurface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        }
                    } else if !model.busy { Text("Select a workspace to see its sources and policy.").foregroundStyle(.secondary) }
                    if let selectionError { Text(selectionError).foregroundStyle(.red) }
                }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .navigationTitle("Cowork")
        .disabled(model.busy)
        .task { await model.refresh() }
        // Status and error text appears and disappears without moving focus, so VoiceOver would never
        // say it. Guidance text that arrives while an operation is running is announced once, when the
        // operation ends, so a retry that fails with the same words as before is still heard.
        .onChange(of: model.error) { _, text in coworkAnnounce(text) }
        .onChange(of: selectionError) { _, text in coworkAnnounce(text) }
        .onChange(of: guidanceAnnouncement) { _, text in if !model.guidanceBusy { coworkAnnounce(text) } }
        .onChange(of: model.guidanceBusy) { wasBusy, busy in if wasBusy && !busy { coworkAnnounce(guidanceAnnouncement) } }
        .onChange(of: draftProblem) { _, text in coworkAnnounce(text) }
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

    /// What the guidance panel is currently saying about the last operation: its message, else its receipt.
    private var guidanceAnnouncement: String? {
        guard let state = model.guidance, state.workspaceId == model.selected?.workspaceId else { return nil }
        return state.message ?? state.receipt.map { "Host save recorded at instruction revision \($0.value.instructionRevision)." }
    }
    private var draftProblem: String? {
        guard let state = model.guidance, state.workspaceId == model.selected?.workspaceId, let draft = state.draft,
              !Self.draftIsValid(draft) else { return nil }
        return Self.draftProblemText
    }
    private static let draftProblemText = "The draft exceeds the file limit or contains a NUL character."
    private static func draftIsValid(_ draft: String) -> Bool {
        draft.utf8.count <= CoworkWorkspaceModel.instructionMaxBytes && !draft.contains("\0")
    }

    private func guidanceEditor(_ state: CoworkWorkspaceModel.Guidance) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Shared WINTER.md").font(Typography.paneTitle)
                Spacer()
                Button("Refresh instructions", systemImage: "arrow.clockwise") { Task { await model.refreshInstructions(workspaceId: state.workspaceId) } }
                    .disabled(model.guidanceBusy)
            }
            Text("These instructions are shared by every conversation and subagent in this workspace. Host permissions are managed separately.")
                .font(Typography.label()).foregroundStyle(Theme.textMuted)
            if model.guidanceBusy { ProgressView("Updating shared instructions…") }
            if let current = state.current {
                Text("Instruction revision \(current.instructionRevision) · \(current.bytes) bytes").font(Typography.caption())
                guidanceStatus(state)
            } else {
                Text("Shared instructions unavailable. Refresh to load the existing workspace file.")
                    .font(Typography.label()).foregroundStyle(Theme.textMuted)
            }
            if let message = state.message { Text(message).font(Typography.label()).textSelection(.enabled) }
            if let receipt = state.receipt {
                Text("Host save recorded at instruction revision \(receipt.value.instructionRevision).")
                    .font(Typography.caption()).foregroundStyle(Theme.textMuted)
            }
            if let draft = state.draft {
                GuidanceTextEditor(text: Binding(get: { model.guidance?.workspaceId == state.workspaceId ? (model.guidance?.draft ?? draft) : draft },
                                                 set: { model.editInstructions($0, workspaceId: state.workspaceId) }))
                    .frame(maxWidth: .infinity, minHeight: 180, idealHeight: 240, maxHeight: 360)
                    .background(Theme.controlSurface, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Theme.hairlineElevated, lineWidth: 1))
                    .accessibilityLabel(GuidanceTextEditor.accessibilityName)
                let valid = Self.draftIsValid(draft)
                Text("\(draft.utf8.count) / \(CoworkWorkspaceModel.instructionMaxBytes) UTF-8 bytes\(state.hasUnsavedChanges ? " · unsaved draft" : "")")
                    .font(Typography.caption()).foregroundStyle(valid ? Theme.textMuted : Color.red)
                if !valid { Text(Self.draftProblemText).font(Typography.caption()).foregroundStyle(Color.red) }
                HStack {
                    Button("Save instructions") {
                        Task { await model.saveInstructions(workspaceId: state.workspaceId, expectedDraft: draft,
                                                           expectedRevision: state.current?.instructionRevision, expectedDigest: state.current?.digest) }
                    }
                        .disabled(model.guidanceBusy || !state.canSave || !valid)
                    if state.hasUnconfirmedSave {
                        Button("Retry pending save") { Task { await model.retryInstructionSave(workspaceId: state.workspaceId, requestId: state.pendingRequestId) } }.disabled(model.guidanceBusy)
                        Button("Abandon unconfirmed save", role: .destructive) { confirmingAbandon = true }.disabled(model.guidanceBusy)
                    }
                }
            }
            if state.conflict {
                Text("Compare the current shared content with your retained draft before saving.")
                    .font(Typography.label())
                if state.available, let current = state.currentContent {
                    DisclosureGroup("Current shared content") {
                        ScrollView { Text(current).font(Typography.labelMono()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                            .frame(maxHeight: 180)
                    }
                    HStack {
                        Button("Keep my draft against this version") { model.reviewInstructionConflict(keepDraft: true, workspaceId: state.workspaceId, expectedRevision: state.current?.instructionRevision, expectedDigest: state.current?.digest) }
                        // Replacing the draft is the one choice here that cannot be taken back: ask first
                        // unless the draft holds nothing that is not already in the shared content.
                        Button("Use current content") {
                            if state.useCurrentDiscardsDraft { confirmingUseCurrent = true } else { useCurrentContent(state) }
                        }
                    }.disabled(model.guidanceBusy || state.hasUnconfirmedSave)
                    .confirmationDialog("Replace your draft with the current shared content?", isPresented: $confirmingUseCurrent) {
                        Button("Replace my draft", role: .destructive) { useCurrentContent(state) }
                    } message: {
                        Text("Your unsaved changes to this draft are discarded and cannot be recovered. The shared content stays as it is.")
                    }
                }
            }
            if let pending = state.pendingContent {
                DisclosureGroup("Content of the unconfirmed save") {
                    ScrollView { Text(pending).font(Typography.labelMono()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                        .frame(maxHeight: 180)
                }
            }
            if let provenance = state.provenance {
                DisclosureGroup("Instruction provenance") {
                    ForEach(Array(provenance.entries.enumerated()), id: \.offset) { _, entry in
                        Text(entry.guestPath).textSelection(.enabled)
                        Text(entry.digest).font(Typography.captionMono()).textSelection(.enabled)
                    }
                    Text("Repository instruction discovery is unavailable until Cowork execution is ready.").font(Typography.caption()).foregroundStyle(Theme.textMuted)
                }
            }
        }.padding().frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.elevatedSurface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.hairlineElevated, lineWidth: 1))
            .confirmationDialog("Abandon the unconfirmed save?", isPresented: $confirmingAbandon) {
                Button("Abandon unconfirmed save", role: .destructive) {
                    Task { await model.abandonInstructionSave(workspaceId: state.workspaceId, requestId: state.pendingRequestId) }
                }
            } message: {
                Text("Winter stops trying to confirm that save and keeps your current draft. If the host already applied it, the refresh shows it as the current shared content; either way you review it against your draft before saving again.")
            }
    }

    private func useCurrentContent(_ state: CoworkWorkspaceModel.Guidance) {
        model.reviewInstructionConflict(keepDraft: false, workspaceId: state.workspaceId,
                                        expectedRevision: state.current?.instructionRevision, expectedDigest: state.current?.digest)
    }

    /// The one status line under the revision. Only a real problem is drawn as one: a conflict (a
    /// review is owed) or an unreadable file. The healthy steady state is a quiet note, not a warning,
    /// and no state is drawn in a colour of its own: the glyph and the words carry it.
    @ViewBuilder
    private func guidanceStatus(_ state: CoworkWorkspaceModel.Guidance) -> some View {
        if state.conflict {
            Label(state.available ? "Review needed before saving" : "Review needed before saving · refresh to load the current content",
                  systemImage: "exclamationmark.triangle")
                .font(Typography.label())
        } else if !state.available {
            Label("Shared instructions unavailable", systemImage: "exclamationmark.triangle")
                .font(Typography.label())
        } else {
            Label("Saved changes reach a conversation once it refreshes.", systemImage: "arrow.triangle.2.circlepath")
                .font(Typography.caption()).foregroundStyle(Theme.textMuted)
        }
    }

    private var creation: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Create workspace").font(Typography.heading())
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

/// The guidance draft's editor. SwiftUI's `TextEditor` has no way to switch off the system's text
/// substitutions on macOS, and this text is saved byte for byte (the host compares a SHA-256 of it),
/// so smart quotes and dashes, autocorrection, text replacement, completion and link or data
/// detection must never rewrite a character the person did not type. It follows `ComposerTextView`'s
/// shape (an `NSScrollView` around a plain-text `NSTextView`, a `Coordinator` delegate writing the
/// binding) and its `isAutomaticQuoteSubstitutionEnabled = false` precedent. That component itself
/// cannot be reused here: Return submits in it and it claims first responder on every update.
private struct GuidanceTextEditor: NSViewRepresentable {
    static let accessibilityName = "Shared workspace instructions draft"
    @Binding var text: String

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSTextView.scrollableTextView()
        guard let textView = scrollView.documentView as? NSTextView else { return scrollView }
        let font = Typography.monoNS(ofSize: Typography.labelSize)
        let color = NSColor(named: "TextPrimary") ?? .labelColor
        textView.delegate = context.coordinator
        // On the text view itself: the SwiftUI label below reaches the scroll view that wraps it, and
        // VoiceOver would otherwise land in an unnamed edit field.
        textView.setAccessibilityLabel(GuidanceTextEditor.accessibilityName)
        textView.isRichText = false
        textView.allowsUndo = true
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isAutomaticTextCompletionEnabled = false
        textView.isAutomaticLinkDetectionEnabled = false
        textView.isAutomaticDataDetectionEnabled = false
        textView.isContinuousSpellCheckingEnabled = false
        textView.isGrammarCheckingEnabled = false
        textView.smartInsertDeleteEnabled = false
        textView.inlinePredictionType = .no
        textView.mathExpressionCompletionType = .no
        textView.font = font
        textView.textColor = color
        textView.typingAttributes = [.font: font, .foregroundColor: color]
        textView.insertionPointColor = NSColor(named: "AccentColor") ?? .labelColor
        textView.drawsBackground = false
        textView.textContainerInset = NSSize(width: 6, height: 6)
        textView.replaceTextFromModel(text)
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.borderType = .noBorder
        scrollView.drawsBackground = false
        return scrollView
    }

    func updateNSView(_ nsView: NSScrollView, context: Context) {
        guard let textView = nsView.documentView as? NSTextView else { return }
        context.coordinator.parent = self
        // An AppKit view ignores the SwiftUI `.disabled(model.busy)` above it unless told.
        textView.isEditable = context.environment.isEnabled
        // Only a model-driven replacement lands here (the person's own typing comes back byte-equal and
        // changes nothing). It also drops the undo entries that point into the text that was replaced:
        // left on the stack, Cmd-Z raises NSRangeException.
        textView.replaceTextFromModel(text)
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: GuidanceTextEditor

        init(_ parent: GuidanceTextEditor) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            parent.text = textView.string
        }
    }
}

/// Speaks `text` through VoiceOver (and any other assistive technology listening). Nothing for nil or empty.
@MainActor func coworkAnnounce(_ text: String?) {
    guard let text, !text.isEmpty else { return }
    AccessibilityNotification.Announcement(text).post()
}
