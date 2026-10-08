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
    case .full: return "Full"
    case .click: return "Click only"
    case .view: return "View only"
    case .deny: return "Don't allow"
    }
}

/// PURE: what an access level lets the agent do, for the menu's help text.
func computerUseAccessHelp(_ access: ComputerUseAppAccess) -> String {
    switch access {
    case .full: return "Winter can look at the app and use it."
    case .click: return "Winter can look, click and scroll, but not type, press keys, paste or drag."
    case .view: return "Winter can look at the app but not act in it."
    case .deny: return "Winter never opens or sees the app, and it is blacked out of whole-screen screenshots."
    }
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

/// PURE: the Apps list's order — apps used most recently first, then the rest by name. A list that
/// reshuffled on every use would move the row under the pointer, so only `lastUsedAt` and the name decide.
func computerUseSortedApps(_ apps: [ComputerUseApp]) -> [ComputerUseApp] {
    apps.sorted { lhs, rhs in
        switch (lhs.lastUsedAt, rhs.lastUsedAt) {
        case let (l?, r?) where l != r: return l > r
        case (_?, nil): return true
        case (nil, _?): return false
        default:
            let order = lhs.name.localizedCaseInsensitiveCompare(rhs.name)
            return order == .orderedSame ? lhs.bundleId < rhs.bundleId : order == .orderedAscending
        }
    }
}

/// PURE: "Used 3 hours ago" for an app row, or nil when the daemon has never seen it used.
func computerUseLastUsedText(_ app: ComputerUseApp, now: Date = Date()) -> String? {
    guard let date = app.lastUsedDate else { return nil }
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .full
    return "Used " + formatter.localizedString(for: date, relativeTo: now)
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
    @Published private(set) var apps: [ComputerUseApp] = []
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
    private let permissionPollNanoseconds: UInt64
    private let permissionPollLimit: Int
    private var permissionWatch: Task<Void, Never>?

    /// - Parameters:
    ///   - client: nil when the app runs without daemon wiring; the page then says so and does nothing.
    ///   - permissionPollNanoseconds/permissionPollLimit: after Grant, macOS decides in its own window, so
    ///     the page asks the daemon for the status on this cadence, for at most this many asks, until both
    ///     permissions read granted. Injectable so a test does not wait.
    init(client: (any ComputerUseClient)?,
         permissionPollNanoseconds: UInt64 = 1_500_000_000,
         permissionPollLimit: Int = 80) {
        self.client = client
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

    var sortedApps: [ComputerUseApp] { computerUseSortedApps(apps) }

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

    func setAccess(_ access: ComputerUseAppAccess, for app: ComputerUseApp) async {
        guard let client, !pendingApps.contains(app.bundleId), app.access != access else { return }
        pendingApps.insert(app.bundleId)
        defer { pendingApps.remove(app.bundleId) }
        replaceRow(ComputerUseApp(bundleId: app.bundleId, name: app.name, access: access,
                                  grant: app.grant, lastUsedAt: app.lastUsedAt))
        do {
            try await client.setApp(bundleId: app.bundleId, name: app.name, access: access, grant: .leave)
            actionError = nil
        } catch {
            replaceRow(app)
            actionError = computerUseWriteFailureText("change \(app.name)", error)
        }
    }

    /// "Remove always-allow": the app keeps its access level; only the saved answer to the per-app card
    /// goes, so the next session that binds it is asked again.
    func removeAlwaysAllow(for app: ComputerUseApp) async {
        guard let client, app.grant != nil, !pendingApps.contains(app.bundleId) else { return }
        pendingApps.insert(app.bundleId)
        defer { pendingApps.remove(app.bundleId) }
        replaceRow(ComputerUseApp(bundleId: app.bundleId, name: app.name, access: app.access,
                                  grant: nil, lastUsedAt: app.lastUsedAt))
        do {
            try await client.setApp(bundleId: app.bundleId, name: nil, access: nil, grant: .clear)
            actionError = nil
        } catch {
            replaceRow(app)
            actionError = computerUseWriteFailureText("remove always-allow for \(app.name)", error)
        }
    }

    /// Swaps in `row` for the row with its bundle id.
    private func replaceRow(_ row: ComputerUseApp) {
        guard let index = apps.firstIndex(where: { $0.bundleId == row.bundleId }) else { return }
        apps[index] = row
    }
}
