import SwiftUI
import WinterKit

// -----------------------------------------------------------------------------------------------
// Settings → Computer Use → Browsers: which of the user's browsers Winter can drive tabs in (through the Winter for
// Chrome extension), read from `computerUse.status`'s `browsers` list. Winter's built-in browser is listed too; it needs
// nothing installed.
//
// The rows are read from the status by their WIRE KEYS (a JSON round trip of the decoded status), so this group needs
// no field of its own on WinterKit's `ComputerUseStatus`: a status that carries `browsers` lists them; one from a daemon
// that does not report them shows the note instead. Copy names only what exists.
// -----------------------------------------------------------------------------------------------

/// One browser as `computerUse.status` reports it.
struct SettingsBrowserRow: Decodable, Equatable, Identifiable {
    let id: String
    let name: String
    let connected: Bool
    let reason: String?

    private struct Envelope: Decodable { let browsers: [SettingsBrowserRow]? }

    /// The status's `browsers`, or nil when this status carries none.
    static func rows(from status: ComputerUseStatus) -> [SettingsBrowserRow]? {
        guard let data = try? JSONEncoder().encode(status) else { return nil }
        return (try? JSONDecoder().decode(Envelope.self, from: data))?.browsers
    }
}

let settingsBrowsersFootnote =
    "Winter for Chrome lets Winter work in tabs of your own Chrome, Edge, Brave, Vivaldi, Opera or Arc in the "
    + "background, with your sign-ins. Winter asks before it uses a browser the first time, like any app. Tabs it "
    + "opens sit in a \"Winter\" tab group; anything it is doing shows a Stop button in the tab."
let settingsBrowsersUnreported =
    "This Winter does not report its browsers yet."

/// The group the Computer Use page shows, below its apps.
struct SettingsBrowsersGroup: View {
    let status: ComputerUseStatus

    var body: some View {
        let rows = SettingsBrowserRow.rows(from: status)
        SettingsGroup("Browsers") {
            if let rows, !rows.isEmpty {
                ForEach(rows) { row in
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
