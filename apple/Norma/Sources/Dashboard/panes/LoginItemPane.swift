import SwiftUI

/// Task 7 (spec §4's Mac-group additions): "launch behavior"'s dashboard row — the SAME
/// `LoginItemController` toggle the menu bar already offers (`MenuBarController.loginItemItem`),
/// surfaced here too. Static fetch + toggle (same "no polling loop" v1 posture as
/// `DaemonStatusPane`) — `isEnabled`/`setEnabled` are injected closures over the real
/// `LoginItemController`, never a `NormaClient`/the controller itself.
struct LoginItemPane: View {
    let isEnabled: () -> Bool
    let setEnabled: (Bool) -> Void

    @State private var enabled = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Launch at Login").font(Typography.paneTitle)
            Toggle("Launch Norma at login", isOn: Binding(
                get: { enabled },
                set: { newValue in
                    enabled = newValue
                    setEnabled(newValue)
                }
            ))
            Text("Norma starts automatically when you log in — the same setting as the menu bar's own checkbox.")
                .font(Typography.caption())
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
        }
        .padding()
        .task { enabled = isEnabled() }
    }
}
