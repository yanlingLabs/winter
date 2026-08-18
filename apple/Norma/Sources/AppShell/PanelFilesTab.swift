import Combine
import NormaKit
import SwiftUI

// MARK: - Metrics

/// The gap either side of the chrome row's parts — `PanelEditorTab.swift`'s own
/// `panelEditorChromeGap` reached independently rather than borrowed, for the reason that constant's
/// own doc gives: a metric leaking between two surfaces that only happen to agree at 6pt ties them
/// together at a place they were never meant to be coupled.
let panelFilesChromeGap: CGFloat = 6

/// One tree row's indent per depth level, and its minimum tap-target height — the same
/// `ShellSidebarRowStyle` hover vocabulary every other row in this app wears, at a height close
/// enough to a sidebar row's own that the two read as the same kind of list even though one is
/// native `List` machinery and the other is fully custom.
let fileTreeRowIndent: CGFloat = 14
let fileTreeRowHeight: CGFloat = 22

// MARK: - Pure presentation decisions

/// PURE: what the chrome names itself — the PRIMARY root's last two path components, reusing
/// `fileDiffChipDisplayPath` verbatim (`editorTabDisplayPath`'s own precedent, one door over) rather
/// than a second "shorten a path" rule. No root yet -> the tab's own fallback title, never a blank
/// row.
func filesTabDisplayPath(primaryRoot: String?, fallbackTitle: String) -> String {
    guard let primaryRoot, !primaryRoot.isEmpty else { return fallbackTitle }
    return fileDiffChipDisplayPath(primaryRoot)
}

// MARK: - The per-tab model

/// editor-product Task 7: what a `.files` tab KNOWS. One per tab id, held by `PanelFilesTabModels`
/// rather than by the view — the content slot carries `.id(tabId)` (`ShellPanel.swift`), so
/// switching tabs and switching back REBUILDS the view, and a `FileTreeModel` reborn there would
/// lose every watcher and every expand state on every visit.
///
/// Mirrors `PanelEditorTabModel`'s own `bind`/`activate`/`roots` shape closely on purpose: both
/// answer "what does THIS session's working directory look like right now", off the identical
/// `SessionDirectory.$rows` wire and the identical `EditorTabSessionRoots` three-way read (reused
/// VERBATIM — Task 6's review binds this task to it rather than a second, similar-but-not-identical
/// predicate).
@MainActor
final class PanelFilesTabModel: ObservableObject {
    let tabId: String
    private(set) var sessionId: String?
    /// **Weak, and re-asked rather than remembered** — `PanelEditorTabModel.host`'s own doc gives
    /// the reason: this object is resolved fresh through the host every time it is used, never
    /// cached past a single call, so a session teardown-and-return can never leave this pointed at
    /// something stale.
    private weak var host: ShellSessionHost?

    /// The tree itself — a real object from construction (never optional), so the chrome and the
    /// content can both observe it without either having to handle "no tree yet".
    let tree: FileTreeModel

    @Published private(set) var roots: EditorTabSessionRoots = .unknown

    private var directorySink: AnyCancellable?
    private var activateScheduled = false
    /// Set once, by `deactivate()` — mirrors `PanelEditorTabModel.isRetired` for the identical
    /// reason: a view can outlive the registry entry by a beat, and this stops it waking a model
    /// that is meant to be gone.
    private var isRetired = false

    /// `tree` is REQUIRED, not defaulted to a fresh `FileTreeModel()` — a default-value expression is
    /// evaluated in the caller's context, which for a `@MainActor`-isolated initializer's own default
    /// argument is not guaranteed to already be on the actor (Swift's own rule, not a house
    /// convention). `PanelFilesTabModels.model(for:host:sessionId:)`, the one production caller,
    /// already runs on the main actor and passes one explicitly.
    init(tabId: String, tree: FileTreeModel) {
        self.tabId = tabId
        self.tree = tree
    }

    /// Re-point at a host/session. Called from `panelTabContent(for:)` on EVERY render pass
    /// (`PanelEditorTabModel.bind`'s own doc explains why this must be idempotent, cheap, and must
    /// not publish — the identical constraint applies here for the identical reason).
    ///
    /// A cached model's `sessionId` changing under it (same `tabId`, different session) is correct
    /// by construction even though nothing pins it directly: dropping `directorySink` here and
    /// re-subscribing in `activate()` means `refresh` runs against the NEW session's rows, and
    /// `FileTreeModel.setRoots` releases every OLD section's watcher before installing new ones
    /// (see its own doc). In practice this transition cannot occur: `tabId` is a daemon-minted
    /// `randomUUID()` (`packages/core/src/panel/open-tab.ts`), never reused across sessions, and
    /// `prunePanelTabModelsOnSessionChange` discards a session's cached models on every session hop
    /// before this registry could be asked to rebind one to a different session anyway — so this is
    /// belt-and-suspenders correctness, not a reachable path, which is why it has no dedicated test.
    func bind(host: ShellSessionHost?, sessionId: String?) {
        guard self.host !== host || self.sessionId != sessionId else { return }
        self.host = host
        self.sessionId = sessionId
        directorySink = nil
        scheduleActivate()
    }

    private func scheduleActivate() {
        guard !activateScheduled else { return }
        activateScheduled = true
        Task { @MainActor [weak self] in
            self?.activateScheduled = false
            self?.activate()
        }
    }

    /// Subscribe and resolve. Idempotent — called by both slots' `onAppear` and by `bind`'s hop.
    /// Combine replays the current value on subscribe, so this doubles as the first read.
    func activate() {
        guard !isRetired else { return }
        guard directorySink == nil, let directory = host?.directory else {
            refresh()
            return
        }
        directorySink = directory.$rows.sink { [weak self] rows in self?.refresh(rows: rows) }
    }

    /// **Drop every live wire.** Beyond the Combine subscription `PanelEditorTabModel.deactivate`'s
    /// own doc warns about, this tab's tree can hold live `DispatchSource` watchers — one per
    /// expanded directory — so `tree.setRoots([])` here is not tidiness: it is what stops a Files
    /// tab that is open in a session the shell has LEFT from continuing to fire disk reads for a
    /// directory nobody is looking at. Called on an explicit tab close (`PanelFilesTabModels
    /// .discard`) AND on a session departure that leaves this tab behind but still open
    /// (`ShellSessionHost.prunePanelTabModelsOnSessionChange`) — the second door is what makes this
    /// the SAME "wires that act" class Task 5's own fix round 1 closed for the editor, not a
    /// narrower version of it.
    ///
    /// **Accepted trade, disclosed:** a hop away and back loses which folders were expanded — the
    /// tree re-reads its roots fresh on return, the same "a restored tab re-reads on first
    /// activation" rule the design spec states for code tabs.
    func deactivate() {
        isRetired = true
        directorySink = nil
        tree.setRoots([])
    }

    private func refresh(rows: [SessionSummary]? = nil) {
        guard !isRetired else { return }
        let rows = rows ?? host?.directory.rows ?? []
        let resolved = editorTabSessionRoots(sessionId: sessionId, rows: rows)
        if roots != resolved { roots = resolved }
        switch resolved {
        case .present:
            let row = rows.first { $0.sessionId == sessionId }
            // Filter, not just map: `editorTabSessionRoots` only gates the FIRST entry (`dirs.first?
            // .path.isEmpty == false`), so a second, degenerate entry — `dirs: [{path: "/real"},
            // {path: ""}]` — still reaches here unfiltered. `URL(fileURLWithPath: "")` resolves to
            // the PROCESS's cwd (verified empirically, not assumed), and `listTreeEntries` reads it
            // like any other root — an empty path is not "no root," it is a REAL, populated, wrongly
            // labeled one. Fix-round-1-caught.
            tree.setRoots((row?.dirs?.map(\.path) ?? []).filter { !$0.isEmpty })
        case .none, .unknown:
            tree.setRoots([])
        }
    }

    /// The chrome's PRIMARY root — the same "first dir" convention `resolvedFilePath` resolves a
    /// relative click against, so the chrome names the same directory the door treats as canonical.
    var primaryRootPath: String? { tree.sections.first?.rootPath }

    /// **The tree row's click — routed through the Task-6 door, never a parallel open path.** Task
    /// 6's review named this door's retry as the ONLY cure for a tab stuck on a previously-failed
    /// path (the lazy-open guard on a code tab is keyed on runtime+path precisely so it never
    /// self-retries) — a second "open a file" mechanism here would silently lose that cure for
    /// every click the tree makes.
    func openFile(_ path: String) {
        guard let host, let sessionId else { return }
        host.openFileTab(path, sessionId: sessionId)
    }

    /// Test seam: drive one refresh cycle synchronously, the way `activate()` does, without a view.
    func refreshForTesting() { refresh() }
}

/// One model per tab id, mirroring `PanelEditorTabModels`/`PanelDiffTabModels` — including their
/// reason for existing: the content factory runs on every render pass, so a model born there would
/// be reborn there.
@MainActor
enum PanelFilesTabModels {
    private static var models: [String: PanelFilesTabModel] = [:]

    static func model(for tab: PanelTab, host: ShellSessionHost?, sessionId: String?) -> PanelFilesTabModel {
        if let cached = models[tab.tabId] {
            cached.bind(host: host, sessionId: sessionId)
            return cached
        }
        let fresh = PanelFilesTabModel(tabId: tab.tabId, tree: FileTreeModel())
        models[tab.tabId] = fresh
        fresh.bind(host: host, sessionId: sessionId)
        return fresh
    }

    /// Dropped when the user closes the tab (`ShellSessionHost.closePanelTab`, beside the other
    /// three registries' own discards).
    static func discard(tabId: String) {
        models.removeValue(forKey: tabId)?.deactivate()
    }

    /// **Every model whose tab is no longer on screen, deactivated and dropped** — the Files-tab
    /// half of `ShellSessionHost.prunePanelTabModelsOnSessionChange`; see `PanelFilesTabModel
    /// .deactivate` for why this door exists beside `discard(tabId:)` rather than that one alone.
    static func discardAll(except tabIds: Set<String>) {
        for (tabId, model) in models where !tabIds.contains(tabId) {
            model.deactivate()
            models.removeValue(forKey: tabId)
        }
    }

    /// Test seam only — `models` is process-global state.
    static func removeAllForTesting() {
        models.removeAll()
    }
}

// MARK: - The tab

/// editor-product Task 7: the `.files` implementation of `PanelTabContent`, replacing the Task-2
/// placeholder the factory routed here (`PanelWebTab.swift`'s own TEMPORARY arm comment).
struct PanelFilesTab: PanelTabContent {
    let tab: PanelTab
    /// Shared by both slots, so the chrome's root-path label and the content's tree can never
    /// describe two different sessions. Looked up once, in `panelTabContent(for:host:sessionId:)`.
    let model: PanelFilesTabModel

    var kind: PanelTabKind { .files }
    var title: String { panelTabDisplayTitle(tab) }
    var icon: Image { Image(systemName: panelTabFaviconSystemImage(.files)) }

    func makeChrome() -> AnyView { AnyView(PanelFilesChrome(model: model, tab: tab)) }
    func makeContent() -> AnyView { AnyView(PanelFilesContent(model: model)) }
}

// MARK: - The chrome row

/// Root path, manual refresh. **No navigation** — like the diff and editor chrome rows, there is
/// nowhere to go: a Files tab has exactly one destination and it is already there.
struct PanelFilesChrome: View {
    @ObservedObject var model: PanelFilesTabModel
    let tab: PanelTab

    var body: some View {
        HStack(spacing: panelFilesChromeGap) {
            Text(filesTabDisplayPath(primaryRoot: model.primaryRootPath,
                                     fallbackTitle: panelTabDisplayTitle(tab)))
                .font(Typography.captionMono())
                .foregroundStyle(Theme.textMuted)
                .lineLimit(1)
                .truncationMode(.middle)

            Spacer(minLength: panelFilesChromeGap)

            ShellTitlebarButton(systemImage: "arrow.clockwise", label: "Refresh",
                                size: panelChromeButtonSize) {
                model.tree.refreshAll()
            }
        }
        .padding(.horizontal, panelTabPillInset)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { model.activate() }
    }
}

// MARK: - The content

/// The three-way state (`EditorTabSessionRoots`, reused verbatim — Task 6 review's binding
/// obligation): a row not yet arrived reads as a quiet spinner, never the dirless claim; a genuinely
/// dirless session reads the SAME sentence the editor's own empty state does; otherwise, the tree.
struct PanelFilesContent: View {
    @ObservedObject var model: PanelFilesTabModel

    var body: some View {
        Group {
            switch model.roots {
            case .unknown:
                ProgressView().controlSize(.small)
            case .none:
                emptyState
            case .present:
                tree
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { model.activate() }
    }

    private var emptyState: some View {
        Text(panelDirlessSessionMessage)
            .font(Typography.emptyStateSubtitle)
            .foregroundStyle(.primary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, panelTabPillInset)
    }

    @ViewBuilder
    private var tree: some View {
        // Roots resolved `.present` but `FileTreeModel.setRoots` has not folded a section yet is one
        // main-actor hop, never a real wait — `PanelFilesTabModel.refresh` calls `setRoots`
        // synchronously in the same pass that sets `roots`. Handled honestly rather than assumed
        // away: the three-way read T5 established for the editor applies here too.
        if model.tree.sections.isEmpty {
            ProgressView().controlSize(.small)
        } else {
            List {
                ForEach(model.tree.sections) { section in
                    if model.tree.sections.count > 1 {
                        Section(fileDiffChipDisplayPath(section.rootPath)) {
                            FileTreeChildrenView(node: section.node, model: model.tree, depth: 0,
                                                 onOpen: model.openFile)
                        }
                    } else {
                        FileTreeChildrenView(node: section.node, model: model.tree, depth: 0,
                                             onOpen: model.openFile)
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
        }
    }
}

// MARK: - The tree rows

/// **A `List` with a hand-rolled recursive disclosure row, not SwiftUI's `OutlineGroup(_:children:)`
/// directly.** Two reasons, both self-contained (an earlier version of this doc cited a cross-file
/// precedent for this choice that turned out not to exist — fix round 1, `PanelFilesTab.swift:323`
/// review note — so this now stands on nothing but itself):
/// 1. `OutlineGroup`'s own triangle is opaque UI state with no expand/collapse callback.
/// 2. This model's whole "lazy children, expand-on-demand" contract (`FileTreeModel.expand`/
///    `collapse`) needs an EXPLICIT signal to stay testable without mounting a view.
///
/// `List` still supplies the native scroll container; `FileTreeRowView` supplies the recursion,
/// driven by `node.isExpanded`/`node.children`, which `FileTreeModel.toggle` — not SwiftUI — decides.
/// This satisfies the design spec's "native SwiftUI outline" and the plan's own "List/OutlineGroup"
/// wording as a tree rendered inside a `List`, not as a literal use of the `OutlineGroup` type.
private struct FileTreeChildrenView: View {
    @ObservedObject var node: FileTreeNode
    let model: FileTreeModel
    let depth: Int
    let onOpen: (String) -> Void

    var body: some View {
        ForEach(node.children) { child in
            FileTreeRowView(node: child, model: model, depth: depth, onOpen: onOpen)
        }
    }
}

/// One row — a directory (chevron + folder glyph, tap toggles) or a file (doc glyph, tap opens
/// through the Task-6 door) — plus, when a directory is expanded, its children indented one level
/// deeper.
private struct FileTreeRowView: View {
    @ObservedObject var node: FileTreeNode
    let model: FileTreeModel
    let depth: Int
    let onOpen: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            row
            if node.isDirectory && node.isExpanded {
                FileTreeChildrenView(node: node, model: model, depth: depth + 1, onOpen: onOpen)
            }
        }
    }

    private var row: some View {
        Button {
            if node.isDirectory {
                model.toggle(node)
            } else {
                onOpen(node.path)
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: node.isDirectory
                      ? (node.isExpanded ? "chevron.down" : "chevron.right") : "doc")
                    .font(Typography.caption())
                    .foregroundStyle(Theme.textMuted)
                    .frame(width: 10, alignment: .center)
                if node.isDirectory {
                    Image(systemName: "folder")
                        .font(Typography.caption())
                        .foregroundStyle(Theme.textMuted)
                }
                Text(node.name)
                    .font(Typography.label())
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
            }
            .padding(.leading, CGFloat(depth) * fileTreeRowIndent)
            .padding(.horizontal, panelTabPillInset)
            .frame(maxWidth: .infinity, minHeight: fileTreeRowHeight, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(ShellSidebarRowStyle(isSelected: false))
        .help(node.path)
        .accessibilityLabel(node.name)
    }
}
