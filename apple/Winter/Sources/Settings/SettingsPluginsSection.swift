import SwiftUI

// -----------------------------------------------------------------------------------------------
// Settings → Plugins (2026-09-18) — a DOOR into the library panel, not a second library.
//
// The library floating panel (`LibraryPanel`, `ShellOverlays.swift`) already lists skills, plugins,
// hooks, MCP tools and agents, each on its own tab. A settings page that listed them again would be
// two homes for one thing — the exact duplication Settings was restructured to avoid. So this page
// is five rows, each opening the library AT that tab, plus the one fact about hooks that is a
// setting rather than a list (`hooks.enabled`).
//
// Hooks are here because plugins declare them (each manifest's `contributes.hooks`, reported by the
// daemon per plugin as `manifestHooks`) — which is also why the row sits next to Plugins and Skills
// rather than in the Assistant group where its standalone section used to be.
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
                        description: "The hooks your plugins declare.",
                        tab: .hooks),
    SettingsLibraryDoor(title: "MCP servers",
                        description: "Tool servers — stdio, HTTP or SSE — added under mcpServers "
                            + "in settings.json, and the tools each one offers.",
                        tab: .mcp),
    SettingsLibraryDoor(title: "Agents",
                        description: "Agent definitions.",
                        tab: .agents),
]

/// PURE: the note under the rows. `hooks.enabled` is the ONE setting about plugin hooks in general —
/// not about any one plugin — so it is a note on this page rather than a sixth door. Verified
/// against `packages/core/src/settings.ts`'s `hooksEnabledFrom` (`s.hooks?.enabled !== false`): on
/// unless explicitly false. It gates the PLUGIN hook registry (`plugins/hook-registry.ts`'s
/// `HookFacade`) — not the daemon's own built-in hooks (the bash reviewer, diagnostics-after-edit),
/// which is why the note says "plugin hooks" rather than "hooks". A note, not a disabled toggle: a control that cannot be used reads as broken.
/// Plain text, no backticks (it reaches `Text` as a variable).
let settingsHooksSwitchNote =
    "Whether plugin hooks run at all is one switch: hooks.enabled in settings.json today. They "
    + "run unless it is set to false."

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
