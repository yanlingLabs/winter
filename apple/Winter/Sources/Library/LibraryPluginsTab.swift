import AppKit
import SwiftUI

// -----------------------------------------------------------------------------------------------
// Library → Plugins (2026-09-17; drill-in 2026-09-18; WS-21 rewrite over `plugin.list`/`.install`/
// `.uninstall`/`.enable`/`.disable`/`.update`/`.marketplace.*`, spec §5.2).
//
// THE MODEL IS REUSED, THE VIEW IS NOT. `PluginManagerModel` owns the whole lifecycle against live
// RPCs (list, install-from-folder, enable, disable, uninstall, update, restart, the consent
// round-trip), and the pure `pluginRowDisplay`/`PluginAction` decide what a row says and which
// actions it offers — all pinned by `PluginManagerModelTests`. `PluginManagerView` stays the
// Dashboard's; the Library draws two pages over the same model:
//
//   - LIST: every installed plugin (id, tier, version, enabled), with Install Plugin… and Refresh.
//   - DETAIL: one plugin — enabled state, consent, its lifecycle actions, and the two things that
//     used to ride along in the Dashboard pane's single scroll but are in fact PER PLUGIN:
//       * its live TILE (`TilesStripModel.tiles`, keyed by the BARE plugin id), and
//       * its declared SHORTCUTS with their binding capture (`ShortcutBindingEditorModel.rows`,
//         keyed by the BARE plugin id).
//     The HELPER-APPROVAL row is not here at all: it reports the privileged `WinterHelper`'s
//     System Settings approval, which is not a plugin's state, and it already lives in
//     Settings → Peripheral.
//
// IDENTITY: a row's list/detail identity is its QUALIFIED spec (`PluginRowDisplay.spec`, `"<id>@
// <marketplace>"`) — NOT unique across marketplaces if the bare id alone were used. The tile/
// shortcut lookups below stay keyed on the BARE `pluginId` because that is what `plugins.contrib`/
// `shortcut.invoke`/`tile.action` name a live plugin CONNECTION by, a different namespace than the
// installed-plugin spec.
//
// SHARED MODELS. These are the same instances the Dashboard's Plugins pane observes — an action
// taken here is visible there on its next refresh, and vice versa. A consent sheet raised while
// BOTH surfaces are mounted is bound by both — pre-existing, and unchanged by this.
// -----------------------------------------------------------------------------------------------

// MARK: - Pure display helpers

/// PURE: the plugin row's one-line summary — enabled state first (the thing a user scans for),
/// then the tier and version. WS-21: there is no live runtime status on the wire any more (see
/// `PluginManagerView.swift`'s own header), so this is enabled/disabled only.
func libraryPluginSubtitle(_ row: PluginRowDisplay) -> String {
    "\(row.enabled ? "Enabled" : "Disabled") · \(row.tierBadge) · \(row.version)"
}

/// PURE: the shortcuts one plugin declares, in the editor model's own order. Keyed by the BARE
/// plugin id, which the daemon's `plugins.contrib` spells the same as `PluginRowDisplay.pluginId`.
func libraryPluginShortcutRows(_ rows: [ShortcutBindingEditorModel.Row],
                               plugin: String) -> [ShortcutBindingEditorModel.Row] {
    rows.filter { $0.pluginId == plugin }
}

/// PURE: the live tile one plugin publishes, if any. Keyed by the BARE plugin id (see above).
func libraryPluginTile(_ tiles: [TilesStripModel.PluginTile],
                       plugin: String) -> TilesStripModel.PluginTile? {
    tiles.first { $0.pluginId == plugin }
}

/// PURE: the status dot's colour, or none for a disabled row — WS-21 dropped the Tier-2 runtime
/// status vocabulary (running/starting/stopped/backoff/circuit-open) entirely; enabled/disabled is
/// all `plugin.list` reports now.
func libraryPluginStatusDot(enabled: Bool) -> Color? {
    enabled ? .green : nil
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
                            let ref = LibraryItemRef.plugin(name: row.spec)
                            LibraryLinkRow(
                                systemImage: "puzzlepiece.extension",
                                title: row.pluginId,
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
            // Same wiring the Dashboard pane makes: every plugin refresh (manual or an action's
            // own trailing one) also re-syncs the shortcut rows, so a plugin that just started and
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
            if let dot = libraryPluginStatusDot(enabled: row.enabled) {
                Circle().fill(dot).frame(width: 6, height: 6)
            }
            Text(row.enabled ? "Enabled" : "Disabled")
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
    /// The qualified `"<id>@<marketplace>"` spec — `LibraryItemRef.plugin(name:)`'s payload.
    let spec: String
    let onBack: () -> Void
    /// The plugin left the list (uninstalled here, or elsewhere) — the panel steps back.
    let onVanished: () -> Void

    private var row: PluginRowDisplay? { model.rows.first { $0.spec == spec } }

    var body: some View {
        LibraryDetailPage(
            title: row?.pluginId ?? spec,
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
        .onChange(of: model.rows.map(\.spec)) { _, specs in
            if !specs.contains(spec) { onVanished() }
        }
    }

    private func actions(_ row: PluginRowDisplay) -> some View {
        let busy = model.busySpec == row.spec
        return HStack(spacing: 10) {
            ForEach(row.actions, id: \.self) { action in
                Button(action.title) { Task { await perform(action) } }
                    .font(Typography.label())
                    .foregroundStyle(action == .uninstall ? Color.red : Theme.textPrimary)
                    .disabled(busy)
            }
            if busy {
                ProgressView().controlSize(.small)
            }
        }
    }

    private func perform(_ action: PluginAction) async {
        switch action {
        case .enable: await model.enable(spec)
        case .disable: await model.disable(spec)
        case .uninstall: await model.uninstall(spec)
        case .restart: await model.restart(spec)
        }
    }

    // MARK: Its live tile

    @ViewBuilder
    private var tileSection: some View {
        LibraryGroupHeader(title: "Live tile")
        if let row, let tile = libraryPluginTile(tilesModel.tiles, plugin: row.pluginId) {
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
        let rows = libraryPluginShortcutRows(shortcutsModel.rows, plugin: row?.pluginId ?? "")
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
                    busy: model.busySpec == sheet.spec,
                    onConfirm: { Task { await model.confirmConsent() } },
                    onCancel: { model.cancelConsent() }
                )
            }
    }
}

// MARK: - Install

/// "Install Plugin…": a folder only (WS-21 dropped zip support — see `PluginManagerView.swift`'s
/// own header on why read-in-place directory marketplaces make that unsafe). The same flow the
/// Dashboard pane runs — `NSOpenPanel` then `PluginManagerModel.installFromFolder(_:)`, which
/// raises the consent sheet when the freshly-installed plugin's extras need one.
@MainActor
func presentLibraryPluginInstallPanel(model: PluginManagerModel) {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.message = "Choose a plugin marketplace folder (containing .claude-plugin/marketplace.json)"
    guard panel.runModal() == .OK, let url = panel.url else { return }
    Task { await model.installFromFolder(url) }
}
