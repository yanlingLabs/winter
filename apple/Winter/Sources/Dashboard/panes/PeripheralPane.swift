import SwiftUI

/// "kind:id" — e.g. "session:s_1". Takes plain strings (not `SessionEvent.Holder` — that type has
/// no PUBLIC memberwise initializer, see `PeripheralProviderTests`' own doc comment on the same
/// constraint) so this stays trivially unit-testable without decoding a fixture.
func holderDisplay(kind: String, id: String) -> String {
    "\(kind):\(id)"
}

/// F1 fix (2026-09-22): this pane used to read "expires in <elapsed>" / "expired" derived from
/// `PeripheralLeaseInfo.expiresAt` (a value stamped once at grant time and never updated — the
/// broker renews it server-side on every heartbeat without emitting an event for the extension),
/// so a lease well within a normal, actively-renewed session would read "expired" the moment its
/// ORIGINAL 15s grant window passed, even though it was still very much held. `expiresAt` is not a
/// live signal, so this no longer does time arithmetic on it at all: every lease still present in
/// `activeLeases` is, by construction (see `shouldServe`'s own comment in `PeripheralProvider.swift`),
/// one the broker still considers held — "active" is the only honest thing to say about it. Kept
/// as a named pure function (rather than a literal at each call site) so `DashboardTests` still has
/// something to pin.
func peripheralLeaseStateText() -> String { "active" }

/// Task 5 (2f-ii): the Dashboard's Peripheral pane — spec §B: "active leases (class, holder, age)
/// + the panic button (same action as the menu item)". `provider` is injected directly (an
/// already-decoupled, published view-model — same posture as `SessionsPane`'s `SessionDirectory`,
/// not a `WinterClient`); the Panic button calls the SAME `PeripheralProvider.panic()` the menu
/// item and hotkey use (Task 4).
struct PeripheralPane: View {
    @ObservedObject var provider: PeripheralProvider
    /// Task 4 (4c): the helper-approval row below reads this directly — same `@ObservedObject`
    /// posture as `provider` above.
    @ObservedObject var helperClient: HelperClient

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Peripheral").font(Typography.paneTitle)
                Spacer()
                Button("Panic") { provider.panic() }
                    .foregroundStyle(.red)
                    .disabled(provider.activeLeases.isEmpty)
            }
            HelperApprovalRow(helperClient: helperClient)
            Divider()
            if provider.activeLeases.isEmpty {
                Text("No active leases").font(Typography.label()).foregroundStyle(.secondary)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(provider.activeLeases) { lease in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(lease.class)
                                    .font(Typography.control(.medium))
                                Text(holderDisplay(kind: lease.holder.kind, id: lease.holder.id))
                                    .font(Typography.captionMono())
                                    .foregroundStyle(.secondary)
                                Text(peripheralLeaseStateText())
                                    .font(Typography.caption())
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            Spacer()
        }
        .padding()
    }
}
