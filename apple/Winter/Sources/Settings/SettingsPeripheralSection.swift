import ServiceManagement
import SwiftUI

// -----------------------------------------------------------------------------------------------
// Settings → Peripheral (2026-09-18). Settings-native, written in `SettingsChrome`'s vocabulary
// instead of mounting the Dashboard's `PeripheralPane`.
//
// Same three pieces of logic, none of them re-implemented:
//
//  - the lease list is `PeripheralProvider.activeLeases` (an already-decoupled published
//    view-model, observed directly — never a `WinterClient`), rendered through the pure
//    `holderDisplay` / `peripheralLeaseStateText` helpers that `DashboardSurfaceTests` pins;
//  - Panic calls the SAME `PeripheralProvider.panic()` the menu item and the hotkey use;
//  - the helper-approval line is the pure `helperStatusDisplay(_:)` from `App/HelperClient.swift`,
//    read directly rather than through that file's `HelperApprovalRow` view — the row here has to
//    be a card row, and the DECISION (what it says, whether the System Settings shortcut shows) is
//    the thing worth sharing, not the markup. One implementation of the decision, still.
//
// `PeripheralPane` is untouched; the Dashboard still renders it.
// -----------------------------------------------------------------------------------------------

struct SettingsPeripheralSection: View {
    @ObservedObject var provider: PeripheralProvider
    @ObservedObject var helperClient: HelperClient

    var body: some View {
        SettingsPage(title: settingsSectionTitle(.peripheral),
                     subtitle: settingsSectionSubtitle(.peripheral)) {
            SettingsGroup("Privileged helper") {
                helperRow
            }
            SettingsGroup("Active leases") {
                if provider.activeLeases.isEmpty {
                    SettingsNoteRow("Nothing is holding the keyboard or pointer.")
                } else {
                    ForEach(provider.activeLeases) { lease in
                        leaseRow(lease)
                    }
                }
            }
            SettingsGroup {
                SettingsRow("Release everything",
                            description: "Revokes every active lease at once — the same action as the menu bar's Panic item and its hotkey.") {
                    SettingsButton("Panic",
                                   isDestructive: true,
                                   isEnabled: !provider.activeLeases.isEmpty) {
                        provider.panic()
                    }
                }
            }
        }
    }

    /// The helper's approval state. The button appears only when `helperStatusDisplay` says there
    /// is something Login Items can actually fix — an always-present shortcut to a pane with
    /// nothing to approve in it is a dead end.
    private var helperRow: some View {
        let display = helperStatusDisplay(helperClient.status)
        return SettingsRow("Winter Helper", description: display.stateText) {
            if display.showsOpenSettingsButton {
                SettingsButton("Open System Settings") {
                    SMAppService.openSystemSettingsLoginItems()
                }
            }
        }
    }

    /// One lease: the capability class as the title, who holds it underneath, and how long it has
    /// left on the trailing edge.
    @ViewBuilder
    private func leaseRow(_ lease: PeripheralLeaseInfo) -> some View {
        SettingsRow(lease.class) {
            Text(holderDisplay(kind: lease.holder.kind, id: lease.holder.id))
                .font(Typography.caption())
                .foregroundStyle(Theme.textMuted)
                .textSelection(.enabled)
        } control: {
            // `PeripheralLeaseInfo.expiresAt` is a grant-time value the broker's own renewals
            // never update (F1) — not a live signal, so this surface says the same thing the
            // Dashboard pane does ("active") rather than doing time arithmetic on it.
            Text(peripheralLeaseStateText())
                .font(Typography.caption())
                .foregroundStyle(Theme.textMuted)
        }
    }
}
