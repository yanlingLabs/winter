import Foundation
import NormaKit
import NormaProtocol

/// Owns this Mac's `RemoteHost` (SP2b's whole phone-pairing/remote-access stack) LAZILY — nothing
/// about it starts until the user explicitly opens "Pair a Device…" or "Paired Devices…" from the
/// menu bar (`MenuBarController.pairDeviceItem`/`pairedDevicesItem`, wired in `AppDelegate`).
/// Mirrors `DaemonSupervisor`'s own `@MainActor` convention (`apple/Norma/Sources/App/
/// DaemonSupervisor.swift`): a UI-facing controller, single-threaded by construction.
///
/// `socketPath`/the home directory `storeDir` derives from both come from `NormaPaths` — the
/// SAME `$NORMA_HOME ?? ~/.norma` derivation `DaemonSupervisor`/`AppModel` already use elsewhere
/// in this app, reused (not re-derived) here.
@MainActor
final class RemoteAccessCoordinator {
    enum CoordinatorError: Error {
        /// `RemoteHost.openPairingWindow()` succeeded but somehow left `pairingManager` nil —
        /// per that property's own doc comment this should be unreachable in practice; kept as a
        /// clear failure mode rather than a force-unwrap.
        case pairingUnavailable
    }

    private lazy var host: RemoteHost = RemoteHost(config: RemoteHost.Config(
        storeDir: URL(fileURLWithPath: NormaPaths.homeDirectory()).appendingPathComponent("remote", isDirectory: true),
        socketPath: NormaPaths.socketPath(),
        hostLabel: Host.current().localizedName ?? "Mac",
        // No production relay fleet exists yet — SP2b T6 wires the real signed config (a
        // `RelayConfigStore.accept`-verified bundle). Until then this is inert cargo the QR
        // carries for the phone's benefit only: `relays: []` means a scanning phone attempts a
        // DIRECT connection only, exactly like this Mac's own listener below (`relayURLs: []`).
        relayConfig: SignedRelayConfig(config: RelayConfig(version: 1, relays: []), sig: Data()),
        // SP2b T6 wires the production signed config — direct connections only until then.
        relayURLs: []
    ))

    /// Force-starts the stack (even at zero paired devices — that's the whole point of opening a
    /// pairing window) and returns a fresh `PairingSheetModel` bound to the resulting ceremony.
    /// Throws whatever `RemoteHost.openPairingWindow()` itself throws (e.g. a failed iroh listener
    /// bind) — the caller (the menu action) surfaces that rather than opening a half-wired sheet.
    func makePairingSheetModel() async throws -> PairingSheetModel {
        _ = try await host.openPairingWindow()
        guard let manager = host.pairingManager else { throw CoordinatorError.pairingUnavailable }
        return PairingSheetModel(
            events: manager.events,
            beginPairing: { await manager.beginPairing() },
            confirm: { label in await manager.confirm(label: label) },
            deny: { await manager.deny() }
        )
    }

    /// The pairing sheet window closed — drops the "keep running for pairing" request and lets
    /// the stack tear itself down if nothing else needs it (mirrors `RemoteHost.closePairingWindow`'s
    /// own "caller re-evaluates idleness" contract).
    func pairingSheetClosed() async {
        await host.closePairingWindow()
        await host.stopIfIdle()
    }

    func pairedDevices() async -> [PairRecord] {
        await host.pairedDevices()
    }

    /// Propagates `RemoteHost.revoke`'s own failure rather than swallowing it — the caller (the
    /// Paired Devices window) surfaces the error instead of silently pretending the revoke
    /// succeeded.
    func revoke(phoneEndpointID: String) async throws {
        try await host.revoke(phoneEndpointID: phoneEndpointID)
        await host.stopIfIdle()
    }
}
