import SwiftUI

// -----------------------------------------------------------------------------------------------
// Settings → Dispatch (2026-10-01). The dispatch pill's own preference: how long a pill put away
// with the 4-finger tap keeps its unsent draft (`DispatchPillDraftExpiry`).
//
// App-local — `DispatchPillSettings` over `UserDefaults`, no daemon call — and written to the SAME
// store instance the pill reads (`AppDelegate.dispatchPillSettings`, carried by `DashboardWiring`),
// so a change here reaches a put-away pill's running countdown at once: no restart, no reopen.
// -----------------------------------------------------------------------------------------------

/// The row's copy, in one place so the page and its test read the same sentence. Plain text, no
/// backticks: it reaches `Text` as a variable, which is never parsed as Markdown.
let settingsDispatchDraftExpiryDescription =
    "When the four-finger tap puts the pill away, its unsent draft is kept this long and then "
    + "cleared. Opening the pill again before then keeps the draft, and the next close starts the "
    + "countdown over. Clicking outside the pill only makes it smaller — it stays on screen and "
    + "keeps the draft."

struct SettingsDispatchSection: View {
    /// nil only in a wiring built without the store (pure-construction tests): the row then shows
    /// the default, muted, with nothing to click.
    let settings: DispatchPillSettings?

    var body: some View {
        SettingsPage(title: settingsSectionTitle(.dispatch),
                     subtitle: settingsSectionSubtitle(.dispatch)) {
            SettingsGroup("Pill") {
                if let settings {
                    SettingsDispatchDraftExpiryRow(settings: settings)
                } else {
                    SettingsValueRow(title: settingsDispatchDraftExpiryTitle,
                                     description: settingsDispatchDraftExpiryDescription,
                                     value: DispatchPillDraftExpiry.default.label,
                                     isMuted: true)
                }
            }
        }
    }
}

let settingsDispatchDraftExpiryTitle = "Clear an unsent draft"

/// One row: the sentence, and the five options in the settings menu pill. A `Menu` over the pill
/// rather than a native segmented control — the settings surface is drawn in its own chrome.
private struct SettingsDispatchDraftExpiryRow: View {
    @ObservedObject var settings: DispatchPillSettings

    /// Fixed, so the pill does not jump between "Never" and "Clear draft on close".
    private static let pillWidth: CGFloat = 200

    var body: some View {
        SettingsRow(settingsDispatchDraftExpiryTitle, description: settingsDispatchDraftExpiryDescription) {
            Menu {
                // An inline picker gives the menu its checkmark on the current option for free.
                Picker("", selection: Binding(get: { settings.draftExpiry },
                                              set: { settings.setDraftExpiry($0) })) {
                    ForEach(DispatchPillDraftExpiry.allCases, id: \.self) { option in
                        Text(option.label).tag(option)
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            } label: {
                SettingsMenuPill(settings.draftExpiry.label, width: Self.pillWidth)
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            .fixedSize()
            .accessibilityLabel("When the dispatch pill clears an unsent draft")
            .accessibilityValue(settings.draftExpiry.label)
        }
    }
}
