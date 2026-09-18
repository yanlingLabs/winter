import AppKit
import SwiftUI
import UniformTypeIdentifiers

// -----------------------------------------------------------------------------------------------
// Library → Plugins (2026-09-17; drill-in 2026-09-18).
//
// THE MODEL IS REUSED, THE VIEW IS NOT. `PluginManagerModel` owns the whole lifecycle against live
// RPCs (list, install, enable, disable, remove, restart, the consent round-trip, the settle-poll),
// and the pure `pluginRowDisplay`/`PluginAction` decide what a row says and which actions it
// offers — all pinned by `PluginManagerModelTests`. `PluginManagerView` stays the Dashboard's; the
// Library draws two pages over the same model:
//
//   - LIST: every installed plugin (name, status, tier, version), with Install Plugin… and Refresh.
//   - DETAIL: one plugin — status, consent, its lifecycle actions, and the two things that used to
//     ride along in the Dashboard pane's single scroll but are in fact PER PLUGIN:
//       * its live TILE (`TilesStripModel.tiles`, keyed by plugin id), and
//       * its declared SHORTCUTS with their binding capture (`ShortcutBindingEditorModel.rows`,
//         keyed by plugin id).
//     The HELPER-APPROVAL row is not here at all: it reports the privileged `WinterHelper`'s
//     System Settings approval, which is not a plugin's state, and it already lives in
//     Settings → Peripheral.
//
// SHARED MODELS. These are the same instances the Dashboard's Plugins pane observes. That pane's
// `.onDisappear` stops the settle loop; this tab deliberately does NOT, so closing the panel never
// cancels a loop the Dashboard pane (possibly mounted under the scrim) started. A consent sheet
// raised while BOTH surfaces are mounted is bound by both — pre-existing, and unchanged by this.
// -----------------------------------------------------------------------------------------------

// MARK: - Pure display helpers

/// PURE: the plugin row's one-line summary — status first (the thing a user scans for), then the
/// tier and version.
func libraryPluginSubtitle(_ row: PluginRowDisplay) -> String {
    "\(row.statusText) · \(row.tierBadge) · \(row.version)"
}

/// PURE: the shortcuts one plugin declares, in the editor model's own order. Keyed by `pluginId`,
/// which the daemon's `plugins.contrib` spells the same as `plugins.list`'s `name`.
func libraryPluginShortcutRows(_ rows: [ShortcutBindingEditorModel.Row],
                               plugin: String) -> [ShortcutBindingEditorModel.Row] {
    rows.filter { $0.pluginId == plugin }
}

/// PURE: the live tile one plugin publishes, if any.
func libraryPluginTile(_ tiles: [TilesStripModel.PluginTile],
                       plugin: String) -> TilesStripModel.PluginTile? {
    tiles.first { $0.pluginId == plugin }
}

/// PURE: the status dot's colour, or none. `na`/`disabled` have no runtime process to indicate, so
/// they get no dot at all — the Dashboard pane's same rule.
func libraryPluginStatusDot(_ kind: PluginStatusColorKind) -> Color? {
    switch kind {
    case .running: return .green
    case .starting: return .blue
    case .stopped: return Theme.textMuted
    case .backoff: return .orange
    case .circuitOpen: return .red
    case .na, .disabled: return nil
    }
}

// MARK: - The list

struct LibraryPluginsList: View {
    @ObservedObject var model: PluginManagerModel
    @ObservedObject var shortcutsModel: ShortcutBindingEditorModel
    let selected: LibraryItemRef?
    let onOpen: (LibraryItemRef) -> Void

    var body: some View {
        LibraryListPage(title: "Plugins") {
            HStack(spacing: 8) {
                Button("Install Plugin…") { presentLibraryPluginInstallPanel(model: model) }
                    .disabled(model.installing)
                Button("Refresh") { Task { await model.refresh() } }
            }
        } content: {
            if let errorText = model.errorText {
                LibraryErrorLine(text: errorText)
            }
            if model.rows.isEmpty {
                LibraryStateLine(text: "No plugins installed")
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 1) {
                        ForEach(model.rows) { row in
                            let ref = LibraryItemRef.plugin(name: row.name)
                            LibraryLinkRow(
                                systemImage: "puzzlepiece.extension",
                                title: row.name,
                                subtitle: libraryPluginSubtitle(row),
                                isSelected: selected == ref,
                                action: { onOpen(ref) }
                            ) {
                                LibraryPluginStatusMark(row: row)
                            }
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        .task {
            // Same wiring the Dashboard pane makes: every plugin refresh (manual, an action's own,
            // each settle tick) also re-syncs the shortcut rows, so a plugin that just started and
            // declared shortcuts shows them in its detail without a second poll.
            model.onRefreshed = { [weak shortcutsModel] in
                guard let shortcutsModel else { return }
                Task { @MainActor in await shortcutsModel.refresh() }
            }
            await model.refresh()
        }
    }
}

/// The status dot + word a plugin row and its detail header both carry.
struct LibraryPluginStatusMark: View {
    let row: PluginRowDisplay

    var body: some View {
        HStack(spacing: 4) {
            if let dot = libraryPluginStatusDot(row.statusColorKind) {
                Circle().fill(dot).frame(width: 6, height: 6)
            }
            Text(row.statusText)
                .font(Typography.caption())
                .foregroundStyle(Theme.textMuted)
        }
    }
}

// MARK: - The detail

struct LibraryPluginDetail: View {
    @ObservedObject var model: PluginManagerModel
    @ObservedObject var tilesModel: TilesStripModel
    @ObservedObject var shortcutsModel: ShortcutBindingEditorModel
    let name: String
    let onBack: () -> Void
    /// The plugin left the list (removed here, or elsewhere) — the panel steps back.
    let onVanished: () -> Void

    private var row: PluginRowDisplay? { model.rows.first { $0.name == name } }

    var body: some View {
        LibraryDetailPage(
            title: name,
            subtitle: row.map { "\($0.tierBadge) · \($0.version)" } ?? "Plugin",
            backLabel: "Back to Plugins",
            onBack: onBack
        ) {
            if let row { LibraryPluginStatusMark(row: row) }
        } content: {
            if let errorText = model.errorText {
                LibraryErrorLine(text: errorText)
            }
            if let row {
                LibraryDetailField(label: "Consent", value: row.consentText)
                actions(row)
                Divider()
                tileSection
                Divider()
                shortcutsSection
            } else {
                LibraryStateLine(text: "Loading…")
            }
        }
        .task { await tilesModel.start() }
        .task { await shortcutsModel.refresh() }
        .onChange(of: model.rows.map(\.name)) { _, names in
            if !names.contains(name) { onVanished() }
        }
    }

    private func actions(_ row: PluginRowDisplay) -> some View {
        let busy = model.busyName == row.name
        return HStack(spacing: 10) {
            ForEach(row.actions, id: \.self) { action in
                Button(action.title) { Task { await perform(action) } }
                    .font(Typography.label())
                    .foregroundStyle(action == .remove ? Color.red : Theme.textPrimary)
                    .disabled(busy)
            }
            if busy {
                ProgressView().controlSize(.small)
            }
        }
    }

    private func perform(_ action: PluginAction) async {
        switch action {
        case .enable: await model.enable(name)
        case .disable: await model.disable(name)
        case .remove: await model.remove(name)
        case .restart: await model.restart(name)
        }
    }

    // MARK: Its live tile

    @ViewBuilder
    private var tileSection: some View {
        LibraryGroupHeader(title: "Live tile")
        if let tile = libraryPluginTile(tilesModel.tiles, plugin: name) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 4) {
                    if let icon = tile.data.icon {
                        Image(systemName: icon)
                            .font(Typography.label())
                            .foregroundStyle(Theme.textMuted)
                    }
                    Text(tile.data.title)
                        .font(Typography.label(.medium))
                        .foregroundStyle(Theme.textPrimary)
                }
                if let value = tile.data.value {
                    Text(value)
                        .font(Typography.heading(.semibold))
                        .foregroundStyle(Theme.textPrimary)
                }
                if let progress = tile.data.progress {
                    ProgressView(value: min(max(progress, 0), 1))
                }
                if !tile.data.actions.isEmpty {
                    HStack(spacing: 8) {
                        ForEach(tile.data.actions, id: \.id) { action in
                            Button(action.label) {
                                Task { await tilesModel.fireAction(pluginId: tile.pluginId, actionId: action.id) }
                            }
                            .font(Typography.caption())
                        }
                    }
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: shellSidebarRowCornerRadius, style: .continuous)
                    .fill(Theme.rowHover)
            )
        } else {
            LibraryStateLine(text: "This plugin is not showing a tile.")
        }
    }

    // MARK: Its shortcuts

    @ViewBuilder
    private var shortcutsSection: some View {
        let rows = libraryPluginShortcutRows(shortcutsModel.rows, plugin: name)
        LibraryGroupHeader(title: "Shortcuts", detail: rows.isEmpty ? "" : "\(rows.count)")
        if let conflict = shortcutsModel.conflictMessage {
            LibraryErrorLine(text: conflict)
        }
        if rows.isEmpty {
            LibraryStateLine(text: "This plugin declares no shortcuts.")
        } else {
            ForEach(rows) { shortcut in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(shortcut.shortcutId)
                            .font(Typography.label(.medium))
                            .foregroundStyle(Theme.textPrimary)
                        if let description = shortcut.description {
                            Text(description)
                                .font(Typography.caption())
                                .foregroundStyle(Theme.textMuted)
                        }
                    }
                    Spacer()
                    KeyCaptureControl(
                        label: shortcut.binding.map {
                            shortcutDisplayString(keyCode: $0.keyCode, modifiers: $0.modifiers)
                        } ?? shortcut.defaultKeybinding.map { "default: \($0)" } ?? "",
                        onCapture: { keyCode, modifiers in
                            shortcutsModel.capture(pluginId: shortcut.pluginId,
                                                   shortcutId: shortcut.shortcutId,
                                                   keyCode: keyCode, modifiers: modifiers)
                        }
                    )
                    .frame(width: 140, height: 24)
                }
            }
        }
    }
}

// MARK: - The consent sheet

/// The consent sheet, hung at the PANEL's root rather than on either page: it is raised by an
/// install (from the list) or an enable (from a detail), and the list sits under a disabled layer
/// while a detail is showing — a sheet inheriting that would open with dead buttons.
struct LibraryPluginConsentSheetHost: View {
    @ObservedObject var model: PluginManagerModel

    var body: some View {
        Color.clear
            .sheet(item: $model.consentSheet) { sheet in
                ConsentSheet(
                    state: sheet,
                    busy: model.busyName == sheet.pluginName,
                    onConfirm: { Task { await model.confirmConsent() } },
                    onCancel: { model.cancelConsent() }
                )
            }
    }
}

// MARK: - Install

/// "Install Plugin…": a folder or a `.zip`. The same flow the Dashboard pane runs — `NSOpenPanel`,
/// then `extractPluginZip`/`locatePluginRoot` for a zip (the RPC is folder-source-only), then
/// `PluginManagerModel.install(source:)`, which raises the consent sheet on success.
@MainActor
func presentLibraryPluginInstallPanel(model: PluginManagerModel) {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = true
    panel.allowsMultipleSelection = false
    panel.allowedContentTypes = [.zip]
    panel.message = "Choose a plugin folder or a .zip archive"
    guard panel.runModal() == .OK, let url = panel.url else { return }
    Task { await libraryInstallPlugin(from: url, model: model) }
}

/// The extraction temp dir is removed on every exit path — but only AFTER `install` resolves, since
/// the daemon copies from it — and only when it IS a temp dir: a picked folder is never deleted.
@MainActor
private func libraryInstallPlugin(from url: URL, model: PluginManagerModel) async {
    var zipTempDir: URL?
    defer {
        if let zipTempDir { try? FileManager.default.removeItem(at: zipTempDir) }
    }
    let sourceDir: URL
    if url.pathExtension.lowercased() == "zip" {
        do {
            let tempDir = try await extractPluginZip(at: url)
            zipTempDir = tempDir
            guard let root = locatePluginRoot(in: tempDir) else {
                model.errorText = "zip has no winter-plugin.json/plugin.json — not a plugin"
                return
            }
            sourceDir = root
        } catch {
            model.errorText = "couldn't extract the zip — try again"
            return
        }
    } else {
        sourceDir = url
    }
    await model.install(source: sourceDir.path)
}
