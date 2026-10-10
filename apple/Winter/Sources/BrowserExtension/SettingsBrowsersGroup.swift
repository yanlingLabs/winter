import SwiftUI
import WinterKit

// -----------------------------------------------------------------------------------------------
// Settings → Computer Use → Browsers: which of the user's browsers Winter can drive tabs in (through the Winter for
// Chrome extension), read from `computerUse.status`'s `browsers` (WinterKit's `ComputerUseStatus.browsers`). Winter's
// built-in browser is listed too; it needs nothing installed. A status from a daemon that does not report browsers
// shows the note instead. Copy names only what exists.
// -----------------------------------------------------------------------------------------------

let settingsBrowsersFootnote =
    "Winter for Chrome lets Winter work in tabs of your own Chrome, Edge, Brave, Vivaldi, Opera or Arc in the "
    + "background, with your sign-ins. Winter asks before it uses a browser the first time, like any app. Tabs it "
    + "opens sit in a \"Winter\" tab group; while it works in a tab, the extension's toolbar button stops it."
let settingsBrowsersUnreported =
    "This Winter does not report its browsers yet."

/// The group the Computer Use page shows, below its apps.
struct SettingsBrowsersGroup: View {
    let status: ComputerUseStatus

    var body: some View {
        SettingsGroup("Browsers") {
            if let rows = status.browsers, !rows.isEmpty {
                ForEach(rows, id: \.id) { row in
                    SettingsValueRow(title: row.name,
                                     description: row.connected ? nil : row.reason,
                                     value: row.connected ? "Connected" : "Not connected",
                                     isMuted: !row.connected)
                }
            } else {
                SettingsNoteRow(settingsBrowsersUnreported)
            }
        }
        SettingsRowNote(settingsBrowsersFootnote)
            .padding(.horizontal, SettingsChrome.rowHorizontalPadding)
    }
}
