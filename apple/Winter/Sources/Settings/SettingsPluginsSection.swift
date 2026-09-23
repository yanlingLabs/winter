import SwiftUI

// -----------------------------------------------------------------------------------------------
// Settings → Plugins (2026-09-18; WS-21 copy pass 2026-09-23) — a DOOR into the library panel, not
// a second library.
//
// The library floating panel (`LibraryPanel`, `ShellOverlays.swift`) already lists skills, plugins,
// hooks, MCP tools and agents, each on its own tab. A settings page that listed them again would be
// two homes for one thing — the exact duplication Settings was restructured to avoid. So this page
// is five rows, each opening the library AT that tab, plus the one fact about hooks that used to be
// a setting rather than a list (`hooks.enabled`) — see the note below for why that's now a fact
// about the PAST rather than a live toggle.
//
// WS-21: a plugin's hooks are claude-native `hooks/hooks.json` content now, loaded directly by
// both runtimes — the daemon no longer parses or runs a plugin's declared hooks itself
// (`plugins/hook-registry.ts`'s `HookFacade` is permanently inert, spec §5.3/§5.5's own "Removed"
// list), so `hooks.enabled` gates nothing real any more (it still exists in `settings.json` — it
// "stays", spec §4.1's table — but has no live plugin-hook mechanism left to switch off). The
// Hooks row/tab is kept for continuity, not because the daemon has anything to report there any
// more — see `LibraryHooksTab.swift`'s own header.
// -----------------------------------------------------------------------------------------------

/// The narrow door the Plugins page needs from the shell: "show the library at this tab". Declared
/// here and conformed to by `ShellOverlayPresentation`, the same shape as
/// `SettingsRolePickerPresenting` — Settings depends on the capability, not on the shell's whole
/// modal layer, and a test can stand in for it.
protocol SettingsLibraryPresenting: AnyObject {
    func openLibrary(at tab: LibraryTab)
}

/// One row of the Plugins page: what it is called here, what it says, and which library tab it
/// opens.
struct SettingsLibraryDoor: Hashable, Sendable {
    let title: String
    let description: String
    let tab: LibraryTab
}

/// PURE: the page's rows, in order. The user's order — plugins, then the things plugins bring —
/// with Hooks beside the plugins that declare them.
///
/// Each description says what the tab SHOWS, never more: the Agents tab is fed an empty list by
/// `LibraryPanel` today, so its row claims no content at all.
let settingsLibraryDoors: [SettingsLibraryDoor] = [
    SettingsLibraryDoor(title: "Plugins",
                        description: "Installed plugins, and the shortcuts they declare.",
                        tab: .plugins),
    SettingsLibraryDoor(title: "Skills",
                        description: "The skills Winter can load.",
                        tab: .skills),
    SettingsLibraryDoor(title: "Hooks",
                        description: "No longer reported here — hooks live in each plugin's own "
                            + "hooks/hooks.json and run directly, without the daemon listing them.",
                        tab: .hooks),
    SettingsLibraryDoor(title: "MCP servers",
                        description: "Tool servers — stdio, HTTP or SSE — added under mcpServers "
                            + "in sdk/.winter.json (claude's own config file), and the tools each "
                            + "one offers.",
                        tab: .mcp),
    SettingsLibraryDoor(title: "Agents",
                        description: "Agent definitions.",
                        tab: .agents),
]

/// PURE: the note under the rows. WS-21 retired the daemon-side plugin hook registry
/// (`plugins/hook-registry.ts`'s `HookFacade` — `pluginHooksEligible` is now permanently `false`,
/// `agent/plugins.ts`) — a plugin's hooks are claude-native `hooks/hooks.json` content, loaded
/// directly by both runtimes, so `hooks.enabled` (still present in `settings.json`, spec §4.1: it
/// "stays") has nothing left to gate. The note says that plainly rather than describing a switch
/// that no longer switches anything, which is what it said before this pass.
/// Plain text, no backticks (it reaches `Text` as a variable).
let settingsHooksSwitchNote =
    "Plugin hooks run directly now, declared in each plugin's own hooks/hooks.json — there is no "
    + "daemon-side switch for them any more (hooks.enabled in settings.json still exists but no "
    + "longer gates anything)."

/// PURE: whether a door row can be clicked. With no presenter (a preview, a test, a surface built
/// without a shell) the row is honestly inert rather than clickable-but-dead.
func settingsLibraryDoorIsOpenable(hasPresenter: Bool) -> Bool { hasPresenter }

/// The Plugins page.
struct SettingsPluginsSection: View {
    /// The shell's modal layer, narrowed to the one door this page uses.
    let library: (any SettingsLibraryPresenting)?

    var body: some View {
        SettingsPage(title: settingsSectionTitle(.plugins),
                     subtitle: "Everything that extends what Winter can do lives in the library. "
                        + "Each row opens it at that list.") {
            SettingsGroup {
                ForEach(settingsLibraryDoors, id: \.self) { door in
                    SettingsRow(door.title, description: door.description) {
                        SettingsButton("Open",
                                       isEnabled: settingsLibraryDoorIsOpenable(hasPresenter: library != nil)) {
                            library?.openLibrary(at: door.tab)
                        }
                    }
                }
            }
            SettingsGroup("Hooks") {
                SettingsNoteRow(settingsHooksSwitchNote)
            }
        }
    }
}
