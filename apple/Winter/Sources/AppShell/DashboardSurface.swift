import WinterKit
import SwiftUI

// -----------------------------------------------------------------------------------------------
// Task 7: the Dashboard, re-hosted INSIDE the shell (spec §4). Replaces `Dashboard/DashboardView.
// swift` + `Dashboard/DashboardWindowController.swift`, both deleted this task — the Dashboard is
// no longer its own window; it is one more `ShellDestination` (`.dashboard(pane:)`,
// `ShellNavigation.swift`), rendered by `ShellRootView.detail` exactly like `.mode`/`.session`.
//
// `DashboardWiring` is unchanged in KIND from its `DashboardWindowController`-era self — still
// injection-only DATA/CLOSURES, never a `WinterClient` directly (the design review's own verified
// finding: pane moves are RE-HOSTING, not rewrites) — only WHO builds it and HOW OFTEN changed:
// `AppDelegate.summonAppWindow` now builds it once, for the process lifetime (alongside
// `ShellSessionHost`), where `DashboardWindowController.init` used to rebuild it fresh every time
// the window opened. The per-instance view-models this hands out (`pluginManager`/`tilesModel`/
// `shortcutsModel`/`memoryModel`/`skillsModel`/`providerModel`/`workflowsModel`) therefore now
// live for the app's whole run instead of one Dashboard-window-open — harmless: every one of them
// already re-seeds itself on `.task` (appear), and none holds a socket of its own.
// -----------------------------------------------------------------------------------------------

// MARK: - Pane catalogue + groups (spec §4's disposition table, landed)

/// One pane the surface can show. String raw value (not an opaque index), same "a future pane is a
/// plain new case, never a renumbering" posture the pre-T7 enum already had.
///
/// Task 7 disposition, vs. the pre-existing ten: `.sessions` already died in this task's own first
/// commit (redundant with the shell's own lists — see `AppShellTests.swift`'s "SessionsPane
/// funeral" section). This commit adds FOUR: `.pairedDevices` (spec §4 — "Remote windows
/// (PairedDevices) → becomes a pane, Devices group") and three "Mac group additions" the spec names
/// by function, not by an existing pane (CLI installer, updater, login item/launch behavior) —
/// `.cliInstaller`, `.updater`, `.loginItem`. "Computer capabilities" (the additions bullet's
/// fourth item) is read here as `.peripheral` — already a pane, moved into the Mac group rather
/// than invented fresh; see the task report for why.
enum DashboardPane: String, CaseIterable, Identifiable, Equatable {
    case daemonStatus, peripheral, trust, cliInstaller, updater, loginItem
    case provider, quota
    case memory, skills
    case workflows, pluginManager
    case pairedDevices
    var id: String { rawValue }
}

/// One named group in the sidebar — the "iOS-settings-informed groups + the Mac group" structure
/// spec §4 calls for (R5: "the Mac AUTHORS the structure... Mac-only group appended"). iOS's own
/// 4-section settings sheet (`norma-ios/Winter/App/SettingsView.swift`: "Your Mac", "OpenAI
/// Account", "About") has no dashboard to mirror wholesale — it INFORMS three of these five names
/// (Devices ~ "Your Mac", Provider ~ "OpenAI Account", This Mac ~ "About"); Memory and Automations
/// are Mac-only additions with no phone analogue at all (the phone has no memory/plugin/workflow
/// UI), authored here rather than borrowed. GALLERY EXTENSION POINT: no first-party pattern exists
/// for a secondary grouped-sidebar surface hosted inside a primary sidebar shell (nesting another
/// `NavigationSplitView` here would read as a broken double-sidebar) — this mirrors the pre-T7
/// `DashboardView`'s own flat `HStack` sidebar instead, now with named section headers.
struct DashboardPaneGroup: Identifiable, Equatable {
    let id: String
    let title: String
    let panes: [DashboardPane]
}

/// The sidebar's fixed group/pane order — ONE data array `dashboardPaneOrder` derives from
/// (`flatMap`), so there is exactly one place that lists every pane, never two lists that could
/// drift apart. "This Mac" leads (spec §4: "DaemonStatus... anchors the Mac group" — anchoring the
/// group's OWN first row, and this task's choice to also anchor the whole surface's default
/// landing pane there, replacing the dead `.sessions`' old role as `dashboardPaneOrder.first`).
let dashboardPaneGroups: [DashboardPaneGroup] = [
    DashboardPaneGroup(id: "mac", title: "This Mac", panes: [.daemonStatus, .peripheral, .trust, .cliInstaller, .updater, .loginItem]),
    DashboardPaneGroup(id: "provider", title: "Provider", panes: [.provider, .quota]),
    DashboardPaneGroup(id: "memory", title: "Memory", panes: [.memory, .skills]),
    DashboardPaneGroup(id: "automations", title: "Automations", panes: [.workflows, .pluginManager]),
    DashboardPaneGroup(id: "devices", title: "Devices", panes: [.pairedDevices]),
]

/// Flat pane order, derived from the groups above — the SAME shape `dashboardPaneOrder` has always
/// had (a plain data array every pane-catalogue test reads), just no longer hand-maintained
/// separately from the group structure.
let dashboardPaneOrder: [DashboardPane] = dashboardPaneGroups.flatMap(\.panes)

/// The surface's default/initial selection — always the FIRST pane in `dashboardPaneOrder`
/// (unchanged posture from the pre-T7 constant), now `.daemonStatus` since `.sessions` (the old
/// first entry) is gone.
let defaultDashboardPane: DashboardPane = dashboardPaneOrder.first ?? .daemonStatus

func dashboardPaneTitle(_ pane: DashboardPane) -> String {
    switch pane {
    case .daemonStatus: return "Daemon Status"
    case .peripheral: return "Peripheral"
    case .trust: return "Trust"
    case .cliInstaller: return "Command Line"
    case .updater: return "Updates"
    case .loginItem: return "Launch at Login"
    case .provider: return "AI Provider"
    case .quota: return "Quota"
    case .memory: return "Memory"
    case .skills: return "Skills"
    case .workflows: return "Workflows"
    case .pluginManager: return "Plugins"
    case .pairedDevices: return "Paired Devices"
    }
}

func dashboardPaneSystemImage(_ pane: DashboardPane) -> String {
    switch pane {
    case .daemonStatus: return "server.rack"
    case .peripheral: return "keyboard"
    case .trust: return "checkmark.shield"
    case .cliInstaller: return "terminal"
    case .updater: return "arrow.triangle.2.circlepath"
    case .loginItem: return "power"
    case .provider: return "cpu"
    case .quota: return "gauge.with.needle"
    case .memory: return "brain"
    case .skills: return "book.closed"
    case .workflows: return "flowchart"
    case .pluginManager: return "puzzlepiece.extension"
    case .pairedDevices: return "iphone"
    }
}

/// The fixed left-sidebar width — unchanged from the pre-T7 `DashboardView`'s own constant.
let dashboardSidebarWidth: CGFloat = 180

/// Owns the surface's currently-selected pane. Task 7: now constructed ONCE by `AppWindowController`
/// (alongside `navigation`/`host`), for the process lifetime — replacing `DashboardWindowController`,
/// which used to construct a fresh instance every window-open. The SAME `@ObservedObject`-not-
/// `@State` reasoning that motivated this type in the first place still holds (`AppWindowController.
/// summon(navigatingTo:)` must be able to retarget an already-rendered `DashboardSurface`, exactly
/// the class of bug a `@State` cannot fix — a `@State` only ever seeds once, at construction).
///
/// A separate object from `ShellNavigationModel.destination` deliberately: the OUTER shell's
/// destination only needs to know "the user is somewhere in the Dashboard," not which pane —
/// clicking between panes INSIDE the surface never touches `ShellNavigationModel` (would otherwise
/// re-fire `ShellSessionHost.apply(destination:)`'s deselect on every click, and would make a
/// same-value re-navigation's own no-op guard fight the deep-link mechanism below). The two meet at
/// exactly one seam: `AppWindowController.summon(navigatingTo:)` pushes a non-nil `.dashboard(pane:)`
/// payload into this model as a one-shot deep link; `nil` never touches it.
@MainActor
final class DashboardSelectionModel: ObservableObject {
    @Published var selection: DashboardPane

    init(initialPane: DashboardPane = defaultDashboardPane) {
        self.selection = initialPane
    }
}

// MARK: - Mountable-pane contract (spec §B / §4)

/// The injected bundle every pane is built from — DATA or a CLOSURE, never a `WinterClient` itself
/// (mirrors `SessionDirectory`'s own `lister` closure convention). Built ONCE, in
/// `AppDelegate.summonAppWindow` (the one place that closes over the real client, alongside
/// `ShellSessionHost`) — `DashboardWindowController.init`'s old role, now discharged at the shell's
/// own construction instead of a per-window-open one.
///
/// Two fields the pre-T7 struct carried — `directory`/`onOpenSessionDetached` — are GONE: they
/// existed only for the now-dead `.sessions` pane (`SessionsPane`'s own "open in a new detached
/// window" row action); no surviving pane needs a session directory.
struct DashboardWiring {
    let daemonStatus: () async throws -> (version: String, uptimeMs: Int, socketPath: String, providerId: String?, providerModel: String?, sessionsCount: Int, pluginsCount: Int)
    let quotaState: () async throws -> (kind: String, resumeAt: Int?, inputTokens: Int, outputTokens: Int)
    let trustList: () async throws -> [String]
    let trustRemove: (String) async throws -> Bool
    let peripheral: PeripheralProvider
    let helperClient: HelperClient
    let pluginManager: PluginManagerModel
    let tilesModel: TilesStripModel
    let shortcutsModel: ShortcutBindingEditorModel
    let memoryModel: MemoryPaneModel
    let skillsModel: SkillsPaneModel
    let providerModel: ProviderPaneModel
    let workflowsModel: WorkflowsPaneModel

    // Task 7: the Mac-group additions (spec §4) — every one of these is an existing controller's
    // own action/state, newly SURFACED as a dashboard row rather than reachable from the menu bar
    // only; none of them is a new daemon/protocol capability.
    /// `AppProfile.isDev` — `CliInstallerPane` reads this to decide between the dev `winter-dev`
    /// wrapper story (`CliLauncher`) and the distribution `winter` symlink installer (`CliInstaller`),
    /// the SAME branch `MenuBarController.install()` already makes for the menu item.
    let isDevProfile: Bool
    /// `CliInstaller.currentPlan()` — a read-only probe, never installs anything by itself (same
    /// contract `MenuBarController.refreshCliInstallItem()` relies on).
    let cliInstallState: () -> CliInstallAction
    /// `CliInstaller.install()` — dist only; `CliInstallerPane` re-derives `cliInstallState()`
    /// right after, mirroring `MenuBarController.didInstallCli()`'s own "re-derive and reassign"
    /// posture instead of trusting a return value it would otherwise have to thread through.
    let installCli: () -> Void
    /// `CliLauncher.openCli()` — dev only.
    let openDevCli: () -> Void
    let appVersion: () -> String
    /// `UpdaterCoordinator.readChannelFromSettings()` — READ-ONLY (spec's no-protocol-change rule
    /// and the absence of any pre-existing settings-WRITE surface on the Mac app make a live
    /// channel-picker out of scope this task; disclosed in the report as a v1 cut).
    let updateChannel: () -> String?
    /// `UpdatePresenter.check()` — the same manual Sparkle check the menu bar's "Check for
    /// Updates…" item fires, and the same one the Updates panel runs when it opens. Routed through
    /// the presenter (2026-09-18) rather than straight at `SPUUpdater` so the outcome is recorded
    /// somewhere a surface can read it.
    let checkForUpdates: () -> Void
    let loginItemEnabled: () -> Bool
    let setLoginItemEnabled: (Bool) -> Void

    // Task 7: the Devices group (spec §4 — "Remote windows (PairedDevices) → becomes a pane").
    let pairedDevicesList: () async -> [PairRecord]
    let pairedDevicesRevoke: (String) async throws -> Void
    /// Presents the pairing sheet ON THE SHELL (spec §1 windows disposition: "`PairingSheetWindow`
    /// → becomes a sheet on the shell") — wired to `AppDelegate.openPairDevice()`, which now summons
    /// the shell and drives `AppWindowController.pairingPresentation` instead of spawning
    /// `PairingSheetWindowController` (deleted this task).
    let presentPairingSheet: () -> Void

    /// 2026-09-17 — the library panel's MCP tab. `var` with a `nil` default, unlike every `let`
    /// above: `DashboardWiring` is constructed in several places (the app's one real wiring, plus
    /// pure-construction tests) and a required field would break all of them for a tab that treats
    /// "no lister" as a first-class state anyway.
    ///
    /// Deliberately CWD-LESS. Passing a cwd to `mcp.list` is not a read — it SPAWNS that project's
    /// servers — and the tab must never do that as a side effect of being looked at. The cost,
    /// stated in the tab itself: project-scoped servers cannot appear there.
    var mcpList: (() async throws -> [(name: String, status: String, toolNames: [String], source: String)])? = nil

    /// 2026-09-18 — the Updates panel's observable. `var` with a `nil` default for the same reason
    /// `mcpList` above is one: this struct is also constructed by pure-construction tests, and a
    /// required field would break every one of them for a panel that treats "no presenter" as a
    /// first-class state anyway.
    ///
    /// Always non-nil in the real app, INCLUDING Debug builds — the presenter exists whether or not
    /// Sparkle does, and reports `UpdateStatus.unavailable` when it does not. That is what lets the
    /// panel degrade honestly instead of looking empty.
    var updates: UpdatePresenter? = nil

    /// 2026-09-18 — the three SDK versions (Winter agent SDK, Winter runtime SDK, Claude agent SDK).
    ///
    /// `nil` TODAY, deliberately: the daemon RPC that answers this is being built by another
    /// session. The panel renders `pendingSdkComponents` in that case — three named rows that say
    /// they are waiting — so the shape of the table is already final and wiring the RPC is a single
    /// closure here, with no view change at all.
    ///
    /// Each row carries BOTH numbers (`InstalledComponent.pinned` = what this build was compiled
    /// against, `.installed` = what actually resolved). A disagreement is a normal thing to look at,
    /// not an error: the resolver has several rungs and which one answered is exactly the fact a
    /// version panel exists to show.
    var sdkVersions: (() async throws -> [InstalledComponent])? = nil

    /// 2026-09-18 — the Library panel's MCP tab, Winter half: `capabilities.list`, the daemon's own
    /// in-process capability servers (`winter__<key>`), which `mcp.list` does not carry at all.
    ///
    /// Params-less and side-effect-free, unlike `mcpList` with a cwd — a panel may call it on
    /// appear. `nil` (and a daemon too old to answer it) both render the tab's pre-RPC section.
    var capabilitiesList: (() async throws -> [WinterCapability])? = nil

    /// 2026-09-18 — Settings → Roles: `settings.modelRoles`, the effective model for each of the
    /// nine roles plus whether it was chosen or derived and what the daemon would accept instead.
    ///
    /// Keyed by the SETTINGS PATH (`pins.dispatch`, `provider.model`, …) — the raw wire keys, not
    /// the app's enum, because a role a later daemon adds must survive the trip even though this
    /// build has no case for it.
    var modelRoles: (() async throws -> [String: ModelRoleValue])? = nil

    /// 2026-09-18 — the write half, `settings.setModelRole`. **Carried but not yet called from any
    /// surface**: the Roles pane is deliberately read-only for now (pickers are the next step).
    /// It is here so the write is one construction away and so the read and the write are wired
    /// from the same place, having the same lifetime.
    ///
    /// The reply is the WHOLE effective map — one write refreshes every row, which matters because
    /// clearing one role moves every role that was following it.
    ///
    /// 2026-09-18: takes the effort too, as a THREE-state `ModelRoleEffortWrite` — leave / clear /
    /// set. Carried even while the effort control is gated off, because the picker still sends a
    /// CLEAR alongside every model change: without it a role would keep an effort the new model may
    /// not offer, harmless only until the day something spends a role's effort.
    var setModelRole: ((_ role: String, _ model: String?, _ effort: ModelRoleEffortWrite) async throws
        -> [String: ModelRoleValue])? = nil

    /// 2026-09-18 — `models.catalog`: the pinned provider catalog as this daemon resolved it. What
    /// the Roles model picker needs and `settings.modelRoles` does not carry — the families in use,
    /// each provider's PRICING BASIS and CREDENTIAL DOOR, and one row per provider+model pair with
    /// whatever pricing evidence the catalog holds (18 of ~618 rows carry a price).
    ///
    /// Params-less, read-only and LOCAL-only. ~134 KB of compiled-in, immutable catalog data, so it
    /// is read ONCE per session and cached (`ModelCatalogFactsModel`), lazily, the first time a
    /// picker opens — never on a settings visit and never per keystroke.
    ///
    /// `nil` and a daemon that answers `-32601` are the same thing to the picker: `.none` facts,
    /// which is a fully usable picker with no families and no prices.
    var modelsCatalog: (() async throws -> ModelsCatalog)? = nil
}

/// The Dashboard's root content inside the shell: a fixed-width, GROUPED left pane list + the
/// selected pane's detail. Same manual `ScrollView`/`VStack`/`onTapGesture` sidebar convention the
/// pre-T7 `DashboardView` used (see `DashboardPaneGroup`'s own doc for why this doesn't become a
/// nested `NavigationSplitView`).
struct DashboardSurface: View {
    let wiring: DashboardWiring
    @ObservedObject var selection: DashboardSelectionModel

    var body: some View {
        HStack(spacing: 0) {
            paneList
                .frame(width: dashboardSidebarWidth)
                .frame(maxHeight: .infinity)
            Divider()
            detailView
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    private var paneList: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                ForEach(dashboardPaneGroups) { group in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(group.title.uppercased())
                            .font(Typography.chipLabel.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 8)
                            .padding(.bottom, 2)
                        ForEach(group.panes) { pane in
                            paneRow(pane)
                        }
                    }
                }
            }
            .padding(8)
        }
    }

    private func paneRow(_ pane: DashboardPane) -> some View {
        let isCurrent = pane == selection.selection
        return HStack(spacing: 6) {
            Image(systemName: dashboardPaneSystemImage(pane))
                .font(Typography.label())
                .frame(width: 16)
            Text(dashboardPaneTitle(pane))
                .font(Typography.label())
            Spacer()
        }
        .foregroundStyle(isCurrent ? .primary : .secondary)
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background {
            if isCurrent {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(.quaternary)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { selection.selection = pane }
    }

    @ViewBuilder
    private var detailView: some View {
        switch selection.selection {
        case .daemonStatus:
            DaemonStatusPane(fetch: wiring.daemonStatus)
        case .peripheral:
            PeripheralPane(provider: wiring.peripheral, helperClient: wiring.helperClient)
        case .trust:
            TrustPane(list: wiring.trustList, remove: wiring.trustRemove)
        case .cliInstaller:
            CliInstallerPane(isDev: wiring.isDevProfile, cliInstallState: wiring.cliInstallState, installCli: wiring.installCli, openDevCli: wiring.openDevCli)
        case .updater:
            UpdaterPane(appVersion: wiring.appVersion, updateChannel: wiring.updateChannel, checkForUpdates: wiring.checkForUpdates)
        case .loginItem:
            LoginItemPane(isEnabled: wiring.loginItemEnabled, setEnabled: wiring.setLoginItemEnabled)
        case .provider:
            ProviderPane(model: wiring.providerModel)
        case .quota:
            QuotaPane(fetch: wiring.quotaState)
        case .memory:
            MemoryPane(model: wiring.memoryModel)
        case .skills:
            SkillsPane(model: wiring.skillsModel)
        case .workflows:
            WorkflowsPane(model: wiring.workflowsModel)
        case .pluginManager:
            PluginManagerView(
                model: wiring.pluginManager,
                tilesModel: wiring.tilesModel,
                shortcutsModel: wiring.shortcutsModel,
                helperClient: wiring.helperClient
            )
        case .pairedDevices:
            PairedDevicesView(list: wiring.pairedDevicesList, revoke: wiring.pairedDevicesRevoke, onPairDevice: wiring.presentPairingSheet)
        }
    }
}
