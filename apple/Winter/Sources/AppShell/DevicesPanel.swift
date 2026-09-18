import SwiftUI

// MARK: - The phone panel (2026-09-17)

/// The connected-phone panel the account row's `iphone` icon opens.
///
/// A re-housing, not a rewrite: `PairedDevicesView` already lists the allowlist, revokes a peer
/// behind a confirm, and opens the pairing sheet — and it calls NO daemon RPCs at all (paired
/// devices are local iroh state, `RemoteAccessCoordinator` → `RemoteHost` → `PairingStore`). So it
/// works here exactly as it worked as a Dashboard pane.
///
/// Pairing presents a SHEET on the shell. That sheet is owned by `AppWindowController`, so it
/// appears over this panel rather than inside it — hence the panel closes first (`onPair` below),
/// or the user would be looking at a sheet stacked on a modal scrim.
struct DevicesPanel: View {
    let wiring: DashboardWiring?
    /// Closes the panel before the pairing sheet is presented.
    var onPair: () -> Void = {}

    var body: some View {
        if let wiring {
            PairedDevicesView(list: wiring.pairedDevicesList,
                              revoke: wiring.pairedDevicesRevoke,
                              onPairDevice: {
                                  onPair()
                                  wiring.presentPairingSheet()
                              })
        } else {
            LibraryPanelPlaceholderBody(
                title: "Devices",
                detail: "The paired-phone list, with pairing and revoke.",
                hasWiring: false)
        }
    }
}
