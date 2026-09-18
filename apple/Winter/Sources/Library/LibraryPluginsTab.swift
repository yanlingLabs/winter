import SwiftUI

// -----------------------------------------------------------------------------------------------
// Library → Plugins (2026-09-17).
//
// The other pure re-housing. `PluginManagerModel` already owns the WHOLE plugin lifecycle against
// live RPCs — list, install (file picker), enable, disable, remove, restart, and the consent sheet
// — plus the settle-poll that keeps a just-enabled row's status honest while the supervisor starts
// the process. None of that is re-implemented here; `PluginManagerView` is mounted verbatim.
//
// WHAT RIDES ALONG, on purpose: `PluginManagerView`'s body is not only the plugin list. It also
// renders the live tiles strip (`TilesStripView`), the shortcut binding editor
// (`ShortcutBindingEditor`) and the helper-approval row (`HelperApprovalRow`) — all four sections
// belong to the same Dashboard pane today and its list section is `private`, so mounting "just the
// plugin rows" is not possible without editing `PluginManagerView.swift`, which this session does
// not own. Mounting the whole pane is the honest read of "re-house it": the tab shows everything
// the Plugins pane shows, in the same order. Splitting the strip and the shortcut editor out into
// their own Library tabs (or back into the Dashboard only) is a follow-up for whoever owns that
// file.
//
// SHARED MODEL CAVEAT: this mounts the same `PluginManagerModel`/`TilesStripModel`/
// `ShortcutBindingEditorModel` instances the Dashboard's Plugins pane uses (one each per process,
// `AppDelegate.makeDashboardWiring`). `PluginManagerView.onDisappear` calls `model.stopSettling()`,
// so closing this panel while the Dashboard's own Plugins pane is mounted underneath the scrim
// cancels a settle loop that pane may have started. The consequence is cosmetic and self-healing —
// the row's status stops auto-refreshing and the next `refresh()` (the pane's own Refresh button,
// or any action) corrects it — but it is real, and it is the kind of cross-mount interference that
// only exists because the two surfaces share one model. Noted rather than fixed: the fix belongs
// in `PluginManagerView`/`PluginManagerModel`, which this session does not own.
// -----------------------------------------------------------------------------------------------

struct LibraryPluginsTab: View {
    @ObservedObject var model: PluginManagerModel
    @ObservedObject var tilesModel: TilesStripModel
    @ObservedObject var shortcutsModel: ShortcutBindingEditorModel
    @ObservedObject var helperClient: HelperClient

    var body: some View {
        PluginManagerView(
            model: model,
            tilesModel: tilesModel,
            shortcutsModel: shortcutsModel,
            helperClient: helperClient
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
