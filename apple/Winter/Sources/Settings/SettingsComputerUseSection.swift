import AppKit
import SwiftUI
import UniformTypeIdentifiers
import WinterKit

// -----------------------------------------------------------------------------------------------
// Settings → Computer Use. Settings-native, written in `SettingsChrome`'s vocabulary. The page is a
// view over the daemon's computer-use RPCs (`ComputerUseSettingsModel`): the enable switch, the helper
// app and the two macOS permissions it needs, the Mirror and background-click switches, and the Apps
// section — a master "Allow all apps" switch, the list of exceptions (an access level per app, each
// removable), an "Add exception…" sheet over the installed apps, and the apps the user has chosen
// "Always allow" for.
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
let settingsComputerUseAppsFootnote =
    "Exceptions set the most Computer Use can do in an app, under every approval policy (Bypass "
    + "included). When a session first uses an app, you approve it once, for the session, or always "
    + "— within that limit. Don't allow also keeps the app out of whole-screen screenshots."
let settingsComputerUseLegacyNote =
    "The previous computer tool is in use (computerUse.legacyComputer is set in settings.json), so "
    + "the helper, the mirror and the app settings below do not apply to new sessions."

struct SettingsComputerUseSection: View {
    @StateObject private var model: ComputerUseSettingsModel
    @State private var isAddingException = false

    init(client: (any ComputerUseClient)?, enumerator: any InstalledAppEnumerating = FileInstalledAppEnumerator()) {
        _model = StateObject(wrappedValue: ComputerUseSettingsModel(client: client, enumerator: enumerator))
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
                if model.dockSwitchesSpaces { desktopSwitchingGroup }
                allowAllAppsGroup
                exceptionsGroup
                if !model.alwaysAllowed.isEmpty {
                    alwaysAllowedGroup
                }
                SettingsRowNote(settingsComputerUseAppsFootnote)
                    .padding(.horizontal, SettingsChrome.rowHorizontalPadding)
                SettingsBrowsersGroup(status: status)
                if let actionError = model.actionError {
                    SettingsGroup {
                        SettingsNoteRow(actionError, isError: true)
                    }
                }
            } else {
                SettingsGroup {
                    SettingsNoteRow(model.statusError ?? "Loading…", isError: model.statusError != nil)
                }
            }
        }
        .task { await model.load() }
        .onAppear { model.refreshDockSetting() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in model.refreshDockSetting() }
        .onDisappear { model.stopWatching() }
        .sheet(isPresented: $isAddingException) {
            ComputerUseAddExceptionSheet(model: model, isPresented: $isAddingException)
        }
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

    /// A hint, shown only while macOS's "switch to a Space with open windows for the application" is on: an app that
    /// brings itself forward can move the user to another desktop. The button opens Desktop & Dock; Winter never
    /// changes the setting itself.
    private var desktopSwitchingGroup: some View {
        SettingsGroup {
            SettingsRow(DockSpaceSwitching.hintTitle, description: DockSpaceSwitching.hint) {
                SettingsButton(DockSpaceSwitching.openButtonTitle) { DockSpaceSwitching.openSettings() }
            }
        }
    }

    /// The master switch. On (the default), Computer Use may act in any app except the exceptions; off,
    /// only in the apps the exceptions list names.
    private var allowAllAppsGroup: some View {
        SettingsGroup("Apps") {
            SettingsRow("Allow all apps", description: computerUseAllowAllAppsCaption(model.allowAllApps)) {
                SettingsToggle(isOn: Binding(get: { model.allowAllApps },
                                             set: { value in Task { await model.setAllowAllApps(value) } }))
                    .disabled(model.isSavingSettings)
            }
        }
    }

    /// The exceptions, then the button that adds one.
    private var exceptionsGroup: some View {
        SettingsGroup("Exceptions") {
            if let appsError = model.appsError {
                SettingsNoteRow(appsError, isError: true)
            }
            if !model.hasLoaded {
                SettingsNoteRow("Loading…")
            } else if model.exceptions.isEmpty, model.appsError == nil {
                SettingsNoteRow("No exceptions.")
            } else {
                ForEach(model.exceptions) { app in
                    exceptionRow(app)
                }
            }
            HStack {
                SettingsButton("Add exception…", isEnabled: model.hasLoaded) { isAddingException = true }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, SettingsChrome.rowHorizontalPadding)
            .padding(.vertical, 10)
        }
    }

    /// The apps the user answered "Always allow" to on the per-app card.
    private var alwaysAllowedGroup: some View {
        SettingsGroup("Always allowed in sessions") {
            ForEach(model.alwaysAllowed) { app in
                appLine(app, dimmed: !model.isInstalled(app)) {
                    SettingsButton("Remove", isEnabled: !model.pendingApps.contains(app.bundleId)) {
                        Task { await model.removeAlwaysAllow(for: app) }
                    }
                }
            }
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

    /// One exception: its icon, its name over its bundle id (with a "Default" tag when the daemon put it
    /// there), and on the trailing edge the access picker and the (×) that removes the exception. An app
    /// this Mac does not have is dimmed.
    private func exceptionRow(_ app: ComputerUseApp) -> some View {
        appLine(app, dimmed: !model.isInstalled(app), tag: app.isDefault ? "Default" : nil) {
            if let access = app.access {
                accessMenu(app, access: access)
            }
            Button {
                Task { await model.removeException(app) }
            } label: {
                Image(systemName: "xmark")
                    .font(Typography.control(.medium))
                    .foregroundStyle(Theme.textMuted)
                    .frame(width: SettingsChrome.controlHeight, height: SettingsChrome.controlHeight)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(model.pendingApps.contains(app.bundleId))
            .help("Remove this exception")
            .accessibilityLabel("Remove the exception for \(app.name)")
        }
    }

    /// The shared shape of the exception rows and the always-allowed rows: icon, name, bundle id, an
    /// optional tag, and whatever controls the caller puts on the trailing edge.
    private func appLine<Controls: View>(_ app: ComputerUseApp, dimmed: Bool, tag: String? = nil,
                                         @ViewBuilder controls: () -> Controls) -> some View {
        HStack(alignment: .center, spacing: SettingsChrome.rowControlGap) {
            ComputerUseAppIcon(path: model.iconPath(for: app))
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(app.name)
                        .font(Typography.body())
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if let tag { SettingsBadge(tag) }
                }
                Text(app.bundleId)
                    .font(Typography.caption())
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                    .help(app.bundleId)
            }
            Spacer(minLength: SettingsChrome.rowControlGap)
            HStack(spacing: 8) { controls() }
        }
        .padding(.horizontal, SettingsChrome.rowHorizontalPadding)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .opacity(dimmed ? 0.55 : 1)
    }

    /// The access picker: a `Menu` over the settings pill, with the current level checked.
    private func accessMenu(_ app: ComputerUseApp, access: ComputerUseAppAccess) -> some View {
        Menu {
            Picker("", selection: Binding(get: { access },
                                          set: { level in Task { await model.setAccess(level, for: app) } })) {
                ForEach(ComputerUseAppAccess.allCases, id: \.self) { level in
                    Text(computerUseAccessTitle(level)).tag(level)
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        } label: {
            SettingsMenuPill(computerUseAccessTitle(access), isMuted: access == .deny, width: 130)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .disabled(model.pendingApps.contains(app.bundleId))
        .help(computerUseAccessHelp(access))
        .accessibilityLabel("Access for \(app.name)")
        .accessibilityValue(computerUseAccessTitle(access))
    }

    /// A switch bound to the daemon's value: it reads `current` and writes through `write`, so it can
    /// only ever show what the daemon last said (or what the in-flight write is about to make true).
    private func toggle(_ current: Bool, write: @escaping (Bool) async -> Void) -> Binding<Bool> {
        Binding(get: { current }, set: { value in Task { await write(value) } })
    }
}

// MARK: - The icon

/// An app's icon (`NSWorkspace.icon(forFile:)`), read off the main thread and cached for the process, so
/// a list neither blocks the page nor reads an icon twice. An app with no path (one the daemon knows but
/// this Mac does not have) draws the generic application icon, as does an icon still loading.
struct ComputerUseAppIcon: View {
    let path: String?

    @State private var image: NSImage?

    static let size: CGFloat = 28

    var body: some View {
        Image(nsImage: image ?? ComputerUseIconCache.generic)
            .resizable()
            .interpolation(.high)
            .frame(width: Self.size, height: Self.size)
            .accessibilityHidden(true)
            .task(id: path) {
                guard let path else { image = nil; return }
                image = await ComputerUseIconCache.shared.icon(forPath: path)
            }
    }
}

/// The process-wide icon cache behind `ComputerUseAppIcon`.
final class ComputerUseIconCache: @unchecked Sendable {
    static let shared = ComputerUseIconCache()

    /// The generic application icon — the fallback for an app with no bundle on disk.
    static let generic: NSImage = NSWorkspace.shared.icon(for: .applicationBundle)

    private let cache = NSCache<NSString, NSImage>()

    func icon(forPath path: String) async -> NSImage {
        if let hit = cache.object(forKey: path as NSString) { return hit }
        let loaded = await Task.detached(priority: .utility) { NSWorkspace.shared.icon(forFile: path) }.value
        cache.setObject(loaded, forKey: path as NSString)
        return loaded
    }
}

// MARK: - The add sheet

/// "Add exception…": every installed app that is not already an exception, with its icon, under a search
/// field, by name. Picking one adds it at Click only; the user then sets its level in the row.
struct ComputerUseAddExceptionSheet: View {
    @ObservedObject var model: ComputerUseSettingsModel
    @Binding var isPresented: Bool

    @State private var query = ""

    var body: some View {
        let apps = model.addableApps(query: query)
        VStack(spacing: 0) {
            HStack {
                Text("Add exception")
                    .font(Typography.bodyLarge(.medium))
                    .foregroundStyle(Theme.textPrimary)
                Spacer(minLength: 12)
                SettingsButton("Cancel") { isPresented = false }
            }
            .padding(SettingsChrome.rowHorizontalPadding)

            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(Typography.control())
                    .foregroundStyle(Theme.textMuted)
                TextField("Search apps", text: $query)
                    .textFieldStyle(.plain)
                    .font(Typography.body())
                    .foregroundStyle(Theme.textPrimary)
                if !query.isEmpty {
                    Button { query = "" } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(Typography.control())
                            .foregroundStyle(Theme.textMuted)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear search")
                }
            }
            .padding(.horizontal, 10)
            .frame(height: SettingsChrome.controlHeight)
            .background(RoundedRectangle(cornerRadius: SettingsChrome.controlCornerRadius, style: .continuous)
                .fill(Theme.controlSurface))
            .padding(.horizontal, SettingsChrome.rowHorizontalPadding)
            .padding(.bottom, 10)

            Rectangle().fill(Theme.hairline).frame(height: 1)

            if model.isScanningInstalled && model.installedApps.isEmpty {
                note("Looking for apps…")
            } else if apps.isEmpty {
                note(query.trimmingCharacters(in: .whitespaces).isEmpty
                     ? "There are no other apps to add."
                     : "No apps match “\(query.trimmingCharacters(in: .whitespacesAndNewlines))”.")
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(apps, id: \.bundleId) { app in
                            row(app)
                        }
                    }
                }
            }
        }
        .frame(width: 440, height: 520)
        .background(Theme.cardSurface)
        .task { await model.loadInstalledApps() }
    }

    private func row(_ app: InstalledApp) -> some View {
        Button {
            Task { if await model.addException(app) { isPresented = false } }
        } label: {
            HStack(spacing: SettingsChrome.rowControlGap) {
                ComputerUseAppIcon(path: app.path)
                VStack(alignment: .leading, spacing: 2) {
                    Text(app.name)
                        .font(Typography.body())
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    Text(app.bundleId)
                        .font(Typography.caption())
                        .foregroundStyle(Theme.textMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, SettingsChrome.rowHorizontalPadding)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(model.pendingApps.contains(app.bundleId))
        .accessibilityLabel("Add \(app.name) as an exception")
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .font(Typography.control())
            .foregroundStyle(Theme.textMuted)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
