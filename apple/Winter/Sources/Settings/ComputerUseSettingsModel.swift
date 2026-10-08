import Foundation
import WinterKit

// -----------------------------------------------------------------------------------------------
// Settings → Computer Use: the page's model. Everything the page shows comes from the daemon's four
// computer-use RPCs through `ComputerUseClient` (a protocol, so the tests drive a hand-written fake);
// the page keeps no copy of a setting that could disagree with the daemon's. Writes are optimistic —
// the row moves at once — and a refusal puts the row back and says why in one line, so a toggle can
// never claim a state the daemon did not accept.
// -----------------------------------------------------------------------------------------------

/// PURE: an access level as the picker words it.
func computerUseAccessTitle(_ access: ComputerUseAppAccess) -> String {
    switch access {
    case .full: return "Allow"
    case .click: return "Click only"
    case .view: return "View only"
    case .deny: return "Don't allow"
    }
}

/// PURE: what an access level lets the agent do, for the menu's help text.
func computerUseAccessHelp(_ access: ComputerUseAppAccess) -> String {
    switch access {
    case .full: return "Winter can look at the app and use it, once you approve it in a session."
    case .click: return "Winter can look, click and scroll, but not type, press keys, paste or drag."
    case .view: return "Winter can look at the app but not act in it."
    case .deny: return "Winter never opens or sees the app, and it is blacked out of whole-screen screenshots."
    }
}

/// PURE: the sentence under the master switch, for its state.
func computerUseAllowAllAppsCaption(_ allowAll: Bool) -> String {
    allowAll ? "Computer Use may act in any app, except the ones below."
             : "Computer Use may only use the apps below."
}

/// PURE: the permission's name on the page.
func computerUsePermissionTitle(_ kind: ComputerUsePermissionKind) -> String {
    switch kind {
    case .accessibility: return "Accessibility"
    case .screenRecording: return "Screen Recording"
    }
}

/// PURE: the one line under a permission's name.
func computerUsePermissionDescription(_ kind: ComputerUsePermissionKind) -> String {
    switch kind {
    case .accessibility: return "Lets Winter read and operate other apps' windows."
    case .screenRecording: return "Lets Winter see what an app's window shows."
    }
}

/// PURE: the helper's state in a few words. A helper that is installed but not running is the normal
/// idle state — it starts when a session needs it and quits when it is unused — so it is not an error.
func computerUseHelperSummary(_ helper: ComputerUseHelperStatus) -> String {
    if !helper.installed { return "Not installed" }
    if !helper.running { return "Installed — starts when a session needs it" }
    if let version = helper.version, !version.isEmpty { return "Running — version \(version)" }
    return "Running"
}

/// PURE: why a write failed, in the page's one-line voice. A daemon that has no such method (an older
/// build, or one that predates the proposed settings write) is said so plainly rather than as a fault.
func computerUseWriteFailureText(_ what: String, _ error: Error) -> String {
    if isMethodNotFoundError(error) {
        return "couldn't \(what) — this daemon doesn't support that yet"
    }
    return "couldn't \(what) — \(error.localizedDescription)"
}

@MainActor
final class ComputerUseSettingsModel: ObservableObject {
    /// Whether macOS has granted a permission to the helper. `unknown` while the helper has not reported
    /// (it is not running, or the daemon is too old to say) — which is not the same as denied.
    enum PermissionState: Equatable {
        case granted
        case notGranted
        case unknown
    }

    @Published private(set) var status: ComputerUseStatus?
    /// The daemon's rows (`computerUse.apps.list`): the exceptions, plus any app that holds an
    /// always-grant (a row with no access is there only for that).
    @Published private(set) var apps: [ComputerUseApp] = []
    /// Where each row's app lives on disk, by bundle id. A row with no entry is not installed (it is
    /// dimmed and wears the generic icon).
    @Published private(set) var appPaths: [String: String] = [:]
    /// Every installed app, scanned the first time the add sheet opens and kept for the page's lifetime.
    @Published private(set) var installedApps: [InstalledApp] = []
    @Published private(set) var isScanningInstalled = false
    @Published private(set) var isLoading = false
    /// False until the first load has answered, so the page can say "Loading…" instead of an empty list.
    @Published private(set) var hasLoaded = false
    @Published private(set) var statusError: String?
    @Published private(set) var appsError: String?
    /// The last refused write, one line. Cleared by the next write that succeeds or a refresh.
    @Published private(set) var actionError: String?
    /// A settings write is in flight; the three toggles wait for it.
    @Published private(set) var isSavingSettings = false
    /// Bundle ids with a write in flight; each row's controls wait for their own.
    @Published private(set) var pendingApps: Set<String> = []
    @Published private(set) var requestingPermission: ComputerUsePermissionKind?

    private let client: (any ComputerUseClient)?
    private let enumerator: (any InstalledAppEnumerating)?
    private var hasScannedInstalled = false
    private let permissionPollNanoseconds: UInt64
    private let permissionPollLimit: Int
    private var permissionWatch: Task<Void, Never>?

    /// - Parameters:
    ///   - client: nil when the app runs without daemon wiring; the page then says so and does nothing.
    ///   - enumerator: where installed apps come from. nil finds none, so every row reads as not installed
    ///     — what a test that does not care about the disk gets; nothing here scans it by default.
    ///   - permissionPollNanoseconds/permissionPollLimit: after Grant, macOS decides in its own window, so
    ///     the page asks the daemon for the status on this cadence, for at most this many asks, until both
    ///     permissions read granted. Injectable so a test does not wait.
    init(client: (any ComputerUseClient)?,
         enumerator: (any InstalledAppEnumerating)? = nil,
         permissionPollNanoseconds: UInt64 = 1_500_000_000,
         permissionPollLimit: Int = 80) {
        self.client = client
        self.enumerator = enumerator
        self.permissionPollNanoseconds = permissionPollNanoseconds
        self.permissionPollLimit = permissionPollLimit
    }

    var isWired: Bool { client != nil }

    func permissionState(_ kind: ComputerUsePermissionKind) -> PermissionState {
        guard let permissions = status?.helper.permissions else { return .unknown }
        switch kind {
        case .accessibility: return permissions.accessibility ? .granted : .notGranted
        case .screenRecording: return permissions.screenRecording ? .granted : .notGranted
        }
    }

    var allPermissionsGranted: Bool {
        ComputerUsePermissionKind.allCases.allSatisfy { permissionState($0) == .granted }
    }

    /// The exceptions: rows that carry an access level, by name.
    var exceptions: [ComputerUseApp] { computerUseSortedByName(apps.filter { $0.access != nil }) }

    /// The apps holding an always-grant, by name.
    var alwaysAllowed: [ComputerUseApp] { computerUseSortedByName(apps.filter { $0.grant != nil }) }

    /// Whether the master switch is on. The daemon's default, and so this page's until it answers.
    var allowAllApps: Bool { status?.allowAllApps ?? true }

    /// The `.app` path to draw a row's icon from; nil draws the generic icon.
    func iconPath(for app: ComputerUseApp) -> String? { appPaths[app.bundleId] }

    func isInstalled(_ app: ComputerUseApp) -> Bool { appPaths[app.bundleId] != nil }

    /// What the add sheet lists for `query`: installed apps that are not already exceptions.
    func addableApps(query: String) -> [InstalledApp] {
        computerUseAddableApps(installed: installedApps, exceptionIds: Set(exceptions.map(\.bundleId)), query: query)
    }

    // MARK: - Reading

    /// Reads the status and the app list. The two fail separately: an app list that cannot load must
    /// not hide the toggles above it, and the other way round.
    func load() async {
        guard let client else { return }
        isLoading = true
        defer { isLoading = false; hasLoaded = true }
        actionError = nil
        do {
            status = try await client.status()
            statusError = nil
        } catch {
            statusError = "couldn't load computer-use settings — try Refresh"
        }
        do {
            apps = try await client.listApps()
            appsError = nil
        } catch {
            appsError = "couldn't load the app list — try Refresh"
        }
        await resolvePaths()
    }

    /// Resolves each row's bundle id to the app on disk, off the main thread.
    private func resolvePaths() async {
        guard let enumerator else { return }
        let ids = apps.map(\.bundleId)
        let resolved = await Task.detached(priority: .utility) {
            ids.compactMap { id in enumerator.appPath(forBundleId: id).map { (id, $0) } }
        }.value
        appPaths = Dictionary(resolved, uniquingKeysWith: { first, _ in first })
    }

    /// Scans the installed apps for the add sheet, off the main thread, the first time only.
    func loadInstalledApps() async {
        guard let enumerator, !hasScannedInstalled, !isScanningInstalled else { return }
        isScanningInstalled = true
        defer { isScanningInstalled = false }
        installedApps = await Task.detached(priority: .utility) { enumerator.installedApps() }.value
        hasScannedInstalled = true
    }

    /// Status alone, quietly: a failure keeps what is already shown.
    func refreshStatus() async {
        guard let client else { return }
        if let fresh = try? await client.status() {
            status = fresh
            statusError = nil
        }
    }

    // MARK: - The three toggles

    func setEnabled(_ value: Bool) async { await write(ComputerUseSettingsPatch(enabled: value), what: "change Computer Use") }
    func setMirror(_ value: Bool) async { await write(ComputerUseSettingsPatch(mirror: value), what: "change the mirror") }
    func setPrivateEventPath(_ value: Bool) async {
        await write(ComputerUseSettingsPatch(privateEventPath: value), what: "change background clicks")
    }
    func setAllowAllApps(_ value: Bool) async { await write(ComputerUseSettingsPatch(allowAllApps: value), what: "change Allow all apps") }

    private func write(_ patch: ComputerUseSettingsPatch, what: String) async {
        guard let client, let before = status, !isSavingSettings, !patch.isEmpty else { return }
        isSavingSettings = true
        defer { isSavingSettings = false }
        status = before.applying(patch)
        do {
            try await client.setSettings(patch)
            actionError = nil
            // The daemon is the record: read it back rather than trust the optimistic copy, and keep
            // the copy if the read fails.
            await refreshStatus()
        } catch {
            status = before
            actionError = computerUseWriteFailureText(what, error)
        }
    }

    // MARK: - Permissions

    func grant(_ kind: ComputerUsePermissionKind) async {
        guard let client, requestingPermission == nil else { return }
        requestingPermission = kind
        defer { requestingPermission = nil }
        do {
            try await client.requestPermission(kind)
            actionError = nil
            watchPermissions()
        } catch {
            actionError = computerUseWriteFailureText("ask for \(computerUsePermissionTitle(kind))", error)
        }
    }

    private func watchPermissions() {
        permissionWatch?.cancel()
        let interval = permissionPollNanoseconds
        let limit = permissionPollLimit
        permissionWatch = Task { [weak self] in
            for _ in 0..<limit {
                try? await Task.sleep(nanoseconds: interval)
                guard let self, !Task.isCancelled else { return }
                await self.refreshStatus()
                if self.allPermissionsGranted { return }
            }
        }
    }

    /// Ends the permission watch (the page went away). Safe to call when none is running.
    func stopWatching() {
        permissionWatch?.cancel()
        permissionWatch = nil
    }

    /// Test seam: returns once the current permission watch has run to its end.
    func waitForPermissionWatch() async {
        await permissionWatch?.value
    }

    // MARK: - Apps

    /// Sets an exception's level (`apps.set {bundleId, name, access}`). Allow — the default level — is
    /// sent as `full` like any other, so a row can be set back to it.
    func setAccess(_ access: ComputerUseAppAccess, for app: ComputerUseApp) async {
        guard let client, !pendingApps.contains(app.bundleId), access != app.access else { return }
        pendingApps.insert(app.bundleId)
        defer { pendingApps.remove(app.bundleId) }
        let before = apps
        upsertRow(ComputerUseApp(bundleId: app.bundleId, name: app.name, access: access, grant: app.grant,
                                 isDefault: app.isDefault, lastUsedAt: app.lastUsedAt))
        do {
            try await client.setApp(bundleId: app.bundleId, name: app.name, access: .set(access), grant: .leave)
            actionError = nil
        } catch {
            apps = before
            actionError = computerUseWriteFailureText("change \(app.name)", error)
        }
    }

    /// The (×) button: removes the exception (`apps.set {bundleId, access: null}`). An app that also holds
    /// an always-grant keeps a grant-only row; any other row goes.
    func removeException(_ app: ComputerUseApp) async {
        guard let client, app.access != nil, !pendingApps.contains(app.bundleId) else { return }
        pendingApps.insert(app.bundleId)
        defer { pendingApps.remove(app.bundleId) }
        let before = apps
        if app.grant != nil {
            upsertRow(ComputerUseApp(bundleId: app.bundleId, name: app.name, access: nil, grant: app.grant,
                                     isDefault: false, lastUsedAt: app.lastUsedAt))
        } else {
            apps.removeAll { $0.bundleId == app.bundleId }
        }
        do {
            try await client.setApp(bundleId: app.bundleId, name: nil, access: .remove, grant: .leave)
            actionError = nil
        } catch {
            apps = before
            actionError = computerUseWriteFailureText("remove the exception for \(app.name)", error)
        }
    }

    /// The add sheet's pick: an exception at Click only (`apps.set {bundleId, name, access: "click"}`),
    /// which the user then changes in its row. True when the daemon took it, so the sheet can close.
    @discardableResult
    func addException(_ app: InstalledApp) async -> Bool {
        guard let client, !pendingApps.contains(app.bundleId) else { return false }
        pendingApps.insert(app.bundleId)
        defer { pendingApps.remove(app.bundleId) }
        let before = apps
        let existing = apps.first { $0.bundleId == app.bundleId }
        upsertRow(ComputerUseApp(bundleId: app.bundleId, name: app.name, access: .click, grant: existing?.grant,
                                 isDefault: false, lastUsedAt: existing?.lastUsedAt))
        do {
            try await client.setApp(bundleId: app.bundleId, name: app.name, access: .set(.click), grant: .leave)
            appPaths[app.bundleId] = app.path
            actionError = nil
            return true
        } catch {
            apps = before
            actionError = computerUseWriteFailureText("add \(app.name)", error)
            return false
        }
    }

    /// "Remove" under Always allowed in sessions: only the saved answer to the per-app card goes
    /// (`apps.set {bundleId, grant: null}`), so the next session that binds the app is asked again. An
    /// app that is also an exception keeps its level; a grant-only row goes.
    func removeAlwaysAllow(for app: ComputerUseApp) async {
        guard let client, app.grant != nil, !pendingApps.contains(app.bundleId) else { return }
        pendingApps.insert(app.bundleId)
        defer { pendingApps.remove(app.bundleId) }
        let before = apps
        if app.access != nil {
            upsertRow(ComputerUseApp(bundleId: app.bundleId, name: app.name, access: app.access, grant: nil,
                                     isDefault: app.isDefault, lastUsedAt: app.lastUsedAt))
        } else {
            apps.removeAll { $0.bundleId == app.bundleId }
        }
        do {
            try await client.setApp(bundleId: app.bundleId, name: nil, access: .leave, grant: .clear)
            actionError = nil
        } catch {
            apps = before
            actionError = computerUseWriteFailureText("remove always-allow for \(app.name)", error)
        }
    }

    /// Puts `row` in place of the row with its bundle id, or adds it when the daemon has none yet.
    private func upsertRow(_ row: ComputerUseApp) {
        if let index = apps.firstIndex(where: { $0.bundleId == row.bundleId }) {
            apps[index] = row
        } else {
            apps.append(row)
        }
    }
}
