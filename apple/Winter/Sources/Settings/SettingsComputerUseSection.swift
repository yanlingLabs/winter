import SwiftUI
import WinterKit

// -----------------------------------------------------------------------------------------------
// Settings → Computer Use. Settings-native, written in `SettingsChrome`'s vocabulary. The page is a
// view over the daemon's four computer-use RPCs (`ComputerUseSettingsModel`): the enable switch, the
// helper app and the two macOS permissions it needs, the Mirror and background-click switches, and the
// per-app list where each app can be limited or have its "Always allow" taken back.
//
// Copy names only what exists: `legacyComputer` is shown only because the daemon reports it, and the
// access levels are exactly the daemon's four.
// -----------------------------------------------------------------------------------------------

/// The page's copy, in one place so the page and its test read the same sentences. Plain text, no
/// backticks: it reaches `Text` as a variable, which is never parsed as Markdown.
let settingsComputerUseEnableDescription =
    "Lets Code and Dispatch sessions see and use apps on this Mac. Chat never gets it. A change "
    + "applies to the next session that starts; one already running keeps its tool list."
let settingsComputerUseMirrorDescription =
    "While Winter works in an app, show a small live view of that window in its top-left corner."
let settingsComputerUsePrivateEventPathDescription =
    "Click inside Chrome, Edge and other Chromium-based apps without bringing them to the front, using "
    + "a private macOS event API. When this is off, Winter asks before bringing such an app forward."
let settingsComputerUseLegacyNote =
    "The previous computer tool is in use (computerUse.legacyComputer is set in settings.json), so "
    + "the helper, the mirror and the per-app list below do not apply to new sessions."
let settingsComputerUseAppsFootnote =
    "These limits apply under every approval policy, Bypass included. Don't allow also keeps the app "
    + "out of whole-screen screenshots. An app appears here after Winter has used it."

struct SettingsComputerUseSection: View {
    @StateObject private var model: ComputerUseSettingsModel

    init(client: (any ComputerUseClient)?) {
        _model = StateObject(wrappedValue: ComputerUseSettingsModel(client: client))
    }

    var body: some View {
        SettingsPage(title: settingsSectionTitle(.computerUse),
                     subtitle: settingsSectionSubtitle(.computerUse)) {
            SettingsButton("Refresh", isEnabled: model.isWired && !model.isLoading) { Task { await model.load() } }
        } content: {
            if !model.isWired {
                SettingsGroup {
                    SettingsNoteRow("This app is running without daemon wiring, so there is nothing to show or change here.")
                }
            } else if let status = model.status {
                enableGroup(status)
                helperGroup(status)
                behaviorGroup(status)
                appsGroup
                if let actionError = model.actionError {
                    SettingsGroup {
                        SettingsNoteRow(actionError, isError: true)
                    }
                }
            } else {
                SettingsGroup {
                    SettingsNoteRow(model.statusError ?? "Loading…", isError: model.statusError != nil)
                }
                appsGroup
            }
        }
        .task { await model.load() }
        .onDisappear { model.stopWatching() }
    }

    // MARK: - Groups

    @ViewBuilder
    private func enableGroup(_ status: ComputerUseStatus) -> some View {
        SettingsGroup {
            SettingsRow("Use Computer Use", description: settingsComputerUseEnableDescription) {
                SettingsToggle(isOn: toggle(status.enabled) { value in await model.setEnabled(value) })
                    .disabled(model.isSavingSettings)
            }
            if status.legacyComputer {
                SettingsNoteRow(settingsComputerUseLegacyNote)
            }
        }
    }

    @ViewBuilder
    private func helperGroup(_ status: ComputerUseStatus) -> some View {
        SettingsGroup("Helper") {
            SettingsValueRow(title: "Winter Computer Use",
                             description: "The small helper app that sees and operates other apps for Winter.",
                             value: computerUseHelperSummary(status.helper),
                             isMuted: !status.helper.running)
            ForEach(ComputerUsePermissionKind.allCases, id: \.self) { kind in
                permissionRow(kind)
            }
        }
    }

    @ViewBuilder
    private func behaviorGroup(_ status: ComputerUseStatus) -> some View {
        SettingsGroup {
            SettingsRow("Mirror", description: settingsComputerUseMirrorDescription) {
                SettingsToggle(isOn: toggle(status.mirror) { value in await model.setMirror(value) })
                    .disabled(model.isSavingSettings)
            }
            SettingsRow("Background clicks in Chrome-based apps",
                        description: settingsComputerUsePrivateEventPathDescription) {
                SettingsToggle(isOn: toggle(status.privateEventPath) { value in await model.setPrivateEventPath(value) })
                    .disabled(model.isSavingSettings)
            }
        }
    }

    private var appsGroup: some View {
        SettingsGroup("Apps") {
            if let appsError = model.appsError {
                SettingsNoteRow(appsError, isError: true)
            }
            if !model.hasLoaded {
                SettingsNoteRow("Loading…")
            } else if model.sortedApps.isEmpty, model.appsError == nil {
                SettingsNoteRow("No apps yet.")
            } else {
                ForEach(model.sortedApps) { app in
                    appRow(app)
                }
            }
            SettingsNoteRow(settingsComputerUseAppsFootnote)
        }
    }

    // MARK: - Rows

    /// A permission: "Granted" once macOS has said so, otherwise the button that raises the prompt (or
    /// opens the matching Privacy pane). A helper that has not reported keeps the button — it is how the
    /// helper gets started to ask.
    @ViewBuilder
    private func permissionRow(_ kind: ComputerUsePermissionKind) -> some View {
        SettingsRow(computerUsePermissionTitle(kind), description: computerUsePermissionDescription(kind)) {
            switch model.permissionState(kind) {
            case .granted:
                SettingsBadge("Granted")
            case .notGranted, .unknown:
                SettingsButton("Grant", isEnabled: model.requestingPermission == nil) {
                    Task { await model.grant(kind) }
                }
            }
        }
    }

    private func appRow(_ app: ComputerUseApp) -> some View {
        SettingsRow(app.name) {
            VStack(alignment: .leading, spacing: 3) {
                Text(app.bundleId)
                    .font(Typography.caption())
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                    .help(app.bundleId)
                if app.grant != nil || computerUseLastUsedText(app) != nil {
                    HStack(spacing: 8) {
                        if app.grant != nil { SettingsBadge("Always allowed") }
                        if let used = computerUseLastUsedText(app) {
                            Text(used)
                                .font(Typography.caption())
                                .foregroundStyle(Theme.textMuted)
                        }
                    }
                }
            }
        } control: {
            HStack(spacing: 10) {
                if app.grant != nil {
                    SettingsButton("Remove always-allow", isEnabled: !model.pendingApps.contains(app.bundleId)) {
                        Task { await model.removeAlwaysAllow(for: app) }
                    }
                }
                accessMenu(app)
            }
        }
    }

    /// The access picker: a `Menu` over the settings pill, with the current level checked.
    private func accessMenu(_ app: ComputerUseApp) -> some View {
        Menu {
            Picker("", selection: Binding(get: { app.access },
                                          set: { level in Task { await model.setAccess(level, for: app) } })) {
                ForEach(ComputerUseAppAccess.allCases, id: \.self) { level in
                    Text(computerUseAccessTitle(level)).tag(level)
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        } label: {
            SettingsMenuPill(computerUseAccessTitle(app.access), isMuted: app.access == .deny, width: 130)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .disabled(model.pendingApps.contains(app.bundleId))
        .help(computerUseAccessHelp(app.access))
        .accessibilityLabel("Access for \(app.name)")
        .accessibilityValue(computerUseAccessTitle(app.access))
    }

    /// A switch bound to the daemon's value: it reads `current` and writes through `write`, so it can
    /// only ever show what the daemon last said (or what the in-flight write is about to make true).
    private func toggle(_ current: Bool, write: @escaping (Bool) async -> Void) -> Binding<Bool> {
        Binding(get: { current }, set: { value in Task { await write(value) } })
    }
}
