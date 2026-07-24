import Foundation
import os
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
        /// `RemoteHost.openPairingWindow()` succeeded but left `pairingManager` nil. Reachable via
        /// one narrow race: if the user closes the "Preparing…" panel while `openPairingWindow()` is
        /// suspended in its `await pairingManager.beginPairing()`, the close's `pairingSheetClosed()`
        /// → `stopIfIdle()` can tear the stack down (nilling `pairingManager`) before the guard below
        /// reads it. Handled gracefully by `AppDelegate.openPairDevice`'s `catch` (log + close the
        /// stale panel) — kept as a clear failure mode rather than a force-unwrap.
        case pairingUnavailable
    }

    private static let log = Logger(subsystem: "com.norma.app", category: "relay-config")

    /// The safe, pre-Task-6 default: direct connections only, exactly as if no relay fleet
    /// existed — the fallback for any verification failure below (resource missing, unreadable,
    /// malformed JSON, or a signature that doesn't verify). NOT a Debug-vs-Release distinction:
    /// verified against project.yml + the generated pbxproj (CN-T1 review) — the `Resources`
    /// build phase that carries `relay-config.signed.json` is NOT configuration-gated (unlike the
    /// Release-only "Embed norma-core" script), and `RelayConfigTrust` carries no `#if DEBUG` gate
    /// either — so a Debug build ("Norma Dev") embeds and successfully verifies the exact SAME
    /// signed Oracle relay list as Release, and only lands here if verification actually fails.
    /// Practical consequence: every build, Debug included, now probes the production relay hosts
    /// at `RemoteHost.start()` — deliberate: a dev Mac should exercise the same fallback behavior
    /// a shipped one would, rather than silently diverging from it.
    private static let directOnlyFallback: (relayConfig: SignedRelayConfig, relayURLs: [String]) = (
        relayConfig: SignedRelayConfig(config: RelayConfig(version: 1, relays: []), sig: Data()),
        relayURLs: []
    )

    /// Loads the bundled, production-signed relay config (SP2b Task 6 — `apple/Norma/Resources/
    /// relay-config.signed.json`, embedded via `project.yml`'s `Resources` source path) and
    /// verifies it against `RelayConfigTrust.productionPublicKey` (`RelayConfigStore.accept`,
    /// NormaProtocol) BEFORE trusting a single byte of it. On ANY failure — resource missing,
    /// unreadable, malformed JSON, or a signature that doesn't verify — this fatal-logs and falls
    /// back to `directOnlyFallback`: the app keeps working, just without relay fallback for
    /// phones that can't reach this Mac directly. NEVER half-trusts a config that fails
    /// verification (mirrors `RelayConfigStore.accept`'s own all-or-nothing contract).
    private static func loadVerifiedRelayConfig() -> (relayConfig: SignedRelayConfig, relayURLs: [String]) {
        guard let url = Bundle.main.url(forResource: "relay-config.signed", withExtension: "json") else {
            log.fault("relay-config.signed.json not found in the app bundle — falling back to direct-only relays")
            return directOnlyFallback
        }
        guard let data = try? Data(contentsOf: url) else {
            log.fault("could not read bundled relay-config.signed.json — falling back to direct-only relays")
            return directOnlyFallback
        }
        guard let signed = try? JSONDecoder().decode(SignedRelayConfig.self, from: data) else {
            log.fault("bundled relay-config.signed.json failed to decode — falling back to direct-only relays")
            return directOnlyFallback
        }
        guard RelayConfigStore.accept(signed, current: nil, publicKey: RelayConfigTrust.productionPublicKey) != nil else {
            log.fault("bundled relay-config.signed.json failed signature verification — falling back to direct-only relays")
            return directOnlyFallback
        }
        return (relayConfig: signed, relayURLs: signed.config.relays)
    }

    private lazy var host: RemoteHost = {
        let relay = Self.loadVerifiedRelayConfig()
        return RemoteHost(config: RemoteHost.Config(
            storeDir: URL(fileURLWithPath: NormaPaths.homeDirectory()).appendingPathComponent("remote", isDirectory: true),
            socketPath: NormaPaths.socketPath(),
            hostLabel: Host.current().localizedName ?? "Mac",
            relayConfig: relay.relayConfig,
            relayURLs: relay.relayURLs
        ))
    }()

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
