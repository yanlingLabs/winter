import SwiftUI

// MARK: - Pure pane-order / selection (Task 5, 2f-ii) — table-tested in DashboardTests.swift.

/// One entry in the Dashboard's left sidebar. `String` raw value (not an opaque index) so a
/// future pane — Phase 4's `PluginManagerView`, per spec §B's "the same mountable-pane contract"
/// — is a plain new case, never a renumbering of existing ones.
enum DashboardPane: String, CaseIterable, Identifiable, Equatable {
    // Task 7: `.sessions` DIED here (spec §4 — "redundant with the shell's own lists") — the
    // Dashboard's Sessions pane and its file (`Dashboard/panes/SessionsPane.swift`) are deleted
    // outright; `groupedSessionRows` died with it (no other consumer), `sessionDisplayTitle`
    // survived (moved to `AppShell/ShellNavigation.swift` — see that file's own doc comment).
    case daemonStatus, quota, trust, peripheral, pluginManager, memory, skills, provider, workflows
    var id: String { rawValue }
}

/// The sidebar's fixed display order — a plain DATA array (not scattered per-view logic), so
/// adding a pane later is a one-line change here, not a restructuring of `DashboardView.body`.
/// Phase 4d-iii Task 2: `.pluginManager` appended at the END — every existing pane keeps its
/// position, so this is purely additive (no renumbering of `dashboardSidebarWidth`/selection math,
/// which reads this array, not the enum's raw ordinal). Phase 5b Task 5: `.memory` appended at the
/// END the same way. Phase 5c Task 4: `.skills` appended at the END the same way again. BYOK T2:
/// `.provider` appended at the END the same way again. CC-parity phase 3 (Workflows, Track D Task
/// D3): `.workflows` appended at the END the same way again.
let dashboardPaneOrder: [DashboardPane] = [.daemonStatus, .quota, .trust, .peripheral, .pluginManager, .memory, .skills, .provider, .workflows]

/// The window's default/initial selection — always the FIRST pane in `dashboardPaneOrder`, so a
/// pane appended to the end of that list never silently becomes the landing pane just by being
/// added.
let defaultDashboardPane: DashboardPane = dashboardPaneOrder.first ?? .daemonStatus

func dashboardPaneTitle(_ pane: DashboardPane) -> String {
    switch pane {
    case .daemonStatus: return "Daemon Status"
    case .quota: return "Quota"
    case .trust: return "Trust"
    case .peripheral: return "Peripheral"
    case .pluginManager: return "Plugins"
    case .memory: return "Memory"
    case .skills: return "Skills"
    case .provider: return "AI Provider"
    case .workflows: return "Workflows"
    }
}

func dashboardPaneSystemImage(_ pane: DashboardPane) -> String {
    switch pane {
    case .daemonStatus: return "server.rack"
    case .quota: return "gauge.with.needle"
    case .trust: return "checkmark.shield"
    case .peripheral: return "keyboard"
    case .pluginManager: return "puzzlepiece.extension"
    case .memory: return "brain"
    case .skills: return "book.closed"
    case .provider: return "cpu"
    case .workflows: return "flowchart"
    }
}

/// The fixed left-sidebar width (spec §B: "left pane sidebar (fixed 180pt)").
let dashboardSidebarWidth: CGFloat = 180

/// Phase 4d-cleanup Task 3 fix 1: owns the Dashboard's currently-selected pane. Previously this
/// lived as `DashboardView`'s own `@State private var selection` — a `@State` only ever seeds
/// ONCE, at the view's construction, so nothing outside the view could ever retarget it after the
/// fact. That was the bug: the menu bar's "Manage Plugins…" entry, fired while the Dashboard was
/// already open, refocused the window (`DashboardWindowController.show()`) but never switched
/// panes, because `AppDelegate.openDashboard(initialPane:)`'s refocus branch had no way to reach
/// into the already-constructed `DashboardView`'s state. `DashboardSelectionModel` is OWNED by
/// `DashboardWindowController` (constructed once per window, alongside `pluginManager`/
/// `tilesModel`/`shortcutsModel` — see that controller's `init`) and handed to `DashboardView` as
/// an `@ObservedObject`, so `DashboardWindowController.selectPane(_:)` can retarget the SAME
/// instance the already-rendered view is observing.
@MainActor
final class DashboardSelectionModel: ObservableObject {
    @Published var selection: DashboardPane

    init(initialPane: DashboardPane = defaultDashboardPane) {
        self.selection = initialPane
    }
}

// MARK: - Mountable-pane contract (spec §B)

/// The injected bundle every pane is built from — DATA or a CLOSURE, never a `NormaClient`
/// itself (mirrors `SessionDirectory`'s own `lister` closure convention, and `SidebarWiring`'s
/// posture of handing panes already-decoupled view-models rather than transports). Built once by
/// `DashboardWindowController.init`, which is the one place that closes over the real client.
struct DashboardWiring {
    let directory: SessionDirectory
    let onOpenSessionDetached: (String) -> Void
    let daemonStatus: () async throws -> (version: String, uptimeMs: Int, socketPath: String, providerId: String?, providerModel: String?, sessionsCount: Int, pluginsCount: Int)
    let quotaState: () async throws -> (kind: String, resumeAt: Int?, inputTokens: Int, outputTokens: Int)
    let trustList: () async throws -> [String]
    let trustRemove: (String) async throws -> Bool
    let peripheral: PeripheralProvider
    /// Task 4 (4c): the Peripheral pane's helper-approval row reads this directly
    /// (`@ObservedObject`) — same "hand the pane an already-decoupled view-model" posture as
    /// `peripheral` above, not a `NormaClient`/XPC connection of its own.
    let helperClient: HelperClient
    /// Phase 4d-iii Task 2: the PluginManagerView's live view-model — same `@ObservedObject`
    /// "already-decoupled view-model" posture as `peripheral`/`helperClient` above, not a
    /// `NormaClient` of its own.
    let pluginManager: PluginManagerModel
    /// Phase 4d-iii Task 4: the live tiles strip's own view-model — same posture as `pluginManager`.
    let tilesModel: TilesStripModel
    /// Phase 4d-iii Task 4: the shortcut binding editor's own view-model — same posture as
    /// `pluginManager`/`tilesModel`.
    let shortcutsModel: ShortcutBindingEditorModel
    /// Phase 5b Task 5: the Memory pane's own view-model — same "constructed fresh per dashboard
    /// window, injected here" posture as `pluginManager`/`tilesModel`/`shortcutsModel` above.
    let memoryModel: MemoryPaneModel
    /// Phase 5c Task 4: the Skills pane's own view-model — same posture as `memoryModel`.
    let skillsModel: SkillsPaneModel
    /// BYOK T2: the Provider pane's own view-model — same "constructed fresh per dashboard window,
    /// injected here" posture as `memoryModel`/`skillsModel` above. Its `onConfigured` closure
    /// (fired after a successful `provider.configure`) is baked in at construction time
    /// (`DashboardWindowController.init`), not carried separately on this struct — mirrors how
    /// `shortcutsModel` bakes in its own `shortcutRegistry` dependency rather than exposing it here.
    let providerModel: ProviderPaneModel
    /// CC-parity phase 3 (Workflows, Track D Task D3): same "constructed fresh per dashboard
    /// window, injected here" posture as `memoryModel`/`skillsModel`/`providerModel` above. UNLIKE
    /// those, it also closes over a live `SessionModel` + a `currentSessionId` closure
    /// (`DashboardWindowController.init` bakes both in) — workflows are per-SESSION, the first pane
    /// dependency here that is.
    let workflowsModel: WorkflowsPaneModel
}

/// The Dashboard window's root content: a fixed-width left pane list + the selected pane's
/// detail. Manual `ScrollView`/`VStack`/`onTapGesture` sidebar — matches this codebase's existing
/// convention (`SessionSidebar`) rather than `List`/`NavigationSplitView`, neither of which is
/// used anywhere else in this target.
struct DashboardView: View {
    let wiring: DashboardWiring
    /// Phase 4d-cleanup Task 3 fix 1: `@ObservedObject`, not `@State` — see
    /// `DashboardSelectionModel`'s own doc comment for why. Owned + constructed by
    /// `DashboardWindowController`, which seeds it with `initialPane` at window-open and can
    /// retarget it later via `DashboardWindowController.selectPane(_:)` (the refocus path).
    @ObservedObject var selectionModel: DashboardSelectionModel

    init(wiring: DashboardWiring, selectionModel: DashboardSelectionModel) {
        self.wiring = wiring
        self.selectionModel = selectionModel
    }

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
            VStack(alignment: .leading, spacing: 2) {
                ForEach(dashboardPaneOrder) { pane in
                    paneRow(pane)
                }
            }
            .padding(8)
        }
    }

    private func paneRow(_ pane: DashboardPane) -> some View {
        let isCurrent = pane == selectionModel.selection
        return HStack(spacing: 6) {
            Image(systemName: dashboardPaneSystemImage(pane))
                .font(.system(size: 12))
                .frame(width: 16)
            Text(dashboardPaneTitle(pane))
                .font(.system(size: 12))
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
        .onTapGesture { selectionModel.selection = pane }
    }

    @ViewBuilder
    private var detailView: some View {
        switch selectionModel.selection {
        case .daemonStatus:
            DaemonStatusPane(fetch: wiring.daemonStatus)
        case .quota:
            QuotaPane(fetch: wiring.quotaState)
        case .trust:
            TrustPane(list: wiring.trustList, remove: wiring.trustRemove)
        case .peripheral:
            PeripheralPane(provider: wiring.peripheral, helperClient: wiring.helperClient)
        case .pluginManager:
            PluginManagerView(
                model: wiring.pluginManager,
                tilesModel: wiring.tilesModel,
                shortcutsModel: wiring.shortcutsModel,
                helperClient: wiring.helperClient
            )
        case .memory:
            MemoryPane(model: wiring.memoryModel)
        case .skills:
            SkillsPane(model: wiring.skillsModel)
        case .provider:
            ProviderPane(model: wiring.providerModel)
        case .workflows:
            WorkflowsPane(model: wiring.workflowsModel)
        }
    }
}
