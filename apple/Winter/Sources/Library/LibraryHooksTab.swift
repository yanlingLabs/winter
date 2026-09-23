import SwiftUI

// -----------------------------------------------------------------------------------------------
// Library → Hooks (2026-09-17). WS-21 (2026-09-23): RETIRED, honestly.
//
// A plugin's hooks are claude-native `hooks/hooks.json` content now (spec §5.1/§5.3), loaded
// directly by both runtimes — the daemon no longer parses or enumerates a plugin's hook
// declarations at all. The narrowed `WinterPluginManifest` (`agent/plugin-manifest.ts`) dropped
// `contributes.hooks` outright, and `plugin.list`'s `extras` object (the WS-21 replacement for the
// old `PluginInfoSchema`) carries no hooks field either — see `PluginManagerView.swift`'s own
// header for the wider "no daemon-reported plugin extras beyond tier/permissions/consent" story.
//
// So there is nothing left for this tab to list, ever, on any daemon — not "not yet reported",
// which is what the pre-WS-21 version of this file (`manifestHooks` absent vs. `[]`) was built to
// distinguish. It stays wired into the Library's tab column (so a user who remembers this tab from
// before WS-21 is not met with a missing menu entry) and always shows the same explanation instead
// of a list or a drill-in.
// -----------------------------------------------------------------------------------------------

struct LibraryHooksList: View {
    @ObservedObject var model: PluginManagerModel
    let selected: LibraryItemRef?
    let onOpen: (LibraryItemRef) -> Void

    var body: some View {
        LibraryListPage(title: "Hooks") {
            LibraryPendingNote(
                subject: "Commands a plugin runs at session start, around every tool call, and at "
                    + "the end of a turn.",
                waitingOn: "Hooks are declared in each plugin's own hooks/hooks.json now and run "
                    + "directly by Winter's runtime — the daemon does not enumerate them, so there "
                    + "is nothing to list here. Open the plugin itself, on the Plugins tab, to see "
                    + "what it installed."
            )
        }
    }
}

struct LibraryHooksDetail: View {
    @ObservedObject var model: PluginManagerModel
    let pluginName: String
    let onBack: () -> Void
    /// A hook has no toggle of its own — the declaring plugin's enable/disable is the only
    /// control — so the page's one action is a door to that plugin's own detail.
    let onOpenPlugin: () -> Void
    let onVanished: () -> Void

    var body: some View {
        LibraryDetailPage(
            title: pluginName,
            subtitle: "Hooks",
            backLabel: "Back to Hooks",
            onBack: onBack
        ) {
            Button("Open plugin", action: onOpenPlugin)
                .font(Typography.label())
        } content: {
            LibraryStateLine(text: "This daemon no longer reports a plugin's hooks — see the "
                + "plugin's own hooks/hooks.json.")
        }
    }
}
