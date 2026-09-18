import SwiftUI

// -----------------------------------------------------------------------------------------------
// Settings → Launch at Login (2026-09-18). Settings-native, written in `SettingsChrome`'s
// vocabulary instead of mounting the Dashboard's `LoginItemPane`.
//
// The LOGIC is the pane's, unchanged: the same two injected closures over the same
// `LoginItemController` the menu bar's own checkbox drives (`MenuBarController.loginItemItem`),
// seeded once in `.task` with no polling loop. Only the PRESENTATION moved. `LoginItemPane` itself
// is untouched — the Dashboard still renders it.
// -----------------------------------------------------------------------------------------------

/// One toggle, which is the whole section — so the card carries no group label: "Launch at Login"
/// over a label reading "Launch at login" over a row reading "Start Winter at login" would be the
/// same sentence three times.
struct SettingsLaunchAtLoginSection: View {
    let isEnabled: () -> Bool
    let setEnabled: (Bool) -> Void

    @State private var enabled = false

    var body: some View {
        SettingsPage(title: settingsSectionTitle(.launchAtLogin),
                     subtitle: settingsSectionSubtitle(.launchAtLogin)) {
            SettingsGroup {
                SettingsRow("Start Winter at login",
                            description: "Winter opens automatically when you log in — the same setting as the menu bar's own checkbox.") {
                    SettingsToggle(isOn: Binding(
                        get: { enabled },
                        set: { newValue in
                            enabled = newValue
                            setEnabled(newValue)
                        }
                    ))
                }
            }
        }
        .task { enabled = isEnabled() }
    }
}
