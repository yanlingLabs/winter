import Foundation
import IrohLib

/// How an iroh endpoint (a Mac `IrohListener` accept side, or a phone `IrohDialer`/
/// `PhonePairingClient` dial side) chooses its relay servers — the one knob that decides whether
/// two endpoints on DIFFERENT networks (phone on cellular, Mac behind home NAT) have a rendezvous
/// to reach each other through at all.
///
/// - `.disabled` — no relays; listening and dialing via relay are both off. The ONLY hermetic
///   choice: loopback / same-LAN / in-process dev where a direct route always exists. Every
///   hermetic test in this package binds this way (see `IrohListener`/`IrohDialer`/
///   `PhonePairingClient` doc comments on why a loopback listener with relays disabled is the only
///   deterministic sandboxed setup).
/// - `.n0Default` — n0's public production relay fleet (`RelayMode.defaultMode()`). INTERIM
///   cross-network rendezvous until Norma's own signed Oracle relay config is provisioned (SP2b T6
///   / `RemoteHost.Config.relayURLs`). Because both sides bind with `presetN0()` (which is
///   "relays + DISCOVERY" — see the vendored `presetN0()` doc), a Mac listener on `.n0Default`
///   both homes to an n0 relay AND publishes its current node address (home relay + candidate
///   addresses) to n0's pkarr/DNS discovery; a phone dialing the Mac's bare `EndpointID` (no
///   `relayUrl` hint, no direct addresses) then resolves that published address through the SAME
///   discovery service and connects via whichever n0 relay the Mac actually homed to. Hardcoding a
///   single n0 relay URL into the dial address would be WRONG — n0 runs a geo-distributed fleet
///   and the Mac homes to the lowest-latency member, which the phone cannot know a priori;
///   discovery is exactly what reports the Mac's real home relay.
/// - `.custom(urls)` — a private relay fleet by URL (`RelayMode.customFromUrls`). What the
///   live-gate `IrohRelayE2ETests` forces against the Oracle Frankfurt relays, and what production
///   switches to automatically once `RemoteHost.Config.relayURLs` carries real Oracle relays.
public enum RelaySelection: Sendable {
    case disabled
    case n0Default
    case custom([String])

    /// Maps this selection onto the iroh binding's `RelayMode`. `.custom` can throw (a malformed
    /// relay URL) — mirrors `RelayMode.customFromUrls`'s own throwing constructor; `.disabled` and
    /// `.n0Default` are infallible.
    public func relayMode() throws -> RelayMode {
        switch self {
        case .disabled:
            return RelayMode.disabled()
        case .n0Default:
            return RelayMode.defaultMode()
        case .custom(let urls):
            return try RelayMode.customFromUrls(urls: urls)
        }
    }

    /// Whether this selection actually has relays to home to — i.e. whether the endpoint should
    /// `await endpoint.online()` after binding (SP3.2b). `Endpoint.online()` "resolves once the
    /// endpoint has a usable home relay" (IrohLib's own doc): with relays enabled it is what makes
    /// the endpoint HOME to a relay and publish its NodeAddr to discovery — without it a
    /// `.n0Default` Mac binds but never registers, so a phone's dial-by-id finds nothing (verified
    /// live: lsof showed zero relay connections until online() was awaited). With `.disabled`
    /// there is no relay to home to, so online() would hang — every loopback/hermetic path MUST
    /// skip it, which is exactly what gating on this flag does. `.custom([])` (an empty custom
    /// fleet — normally unreachable, since `fromLegacyURLs` maps empty to `.disabled`) is treated
    /// as not-enabled for the same no-relay-to-home-to reason.
    public var isEnabled: Bool {
        switch self {
        case .disabled: return false
        case .n0Default: return true
        case .custom(let urls): return !urls.isEmpty
        }
    }

    /// The EFFECTIVE selection from the new explicit `relays` override and the legacy `relayURLs`
    /// seam: an explicit `relays` wins; `nil` falls back to `fromLegacyURLs(legacyURLs)`. The bind
    /// sites use this (rather than `resolve`, which collapses straight to a `RelayMode`) because
    /// SP3.2b needs the selection itself after binding, to decide whether to `online()`.
    public static func effective(relays: RelaySelection?, legacyURLs: [String]) -> RelaySelection {
        relays ?? fromLegacyURLs(legacyURLs)
    }

    /// The legacy `relayURLs: [String]` seam expressed as a selection: empty → `.disabled`,
    /// non-empty → `.custom(urls)`. This is the EXACT behavior every existing call site had before
    /// `relays:` was threaded through, so a caller that passes only `relayURLs` (i.e. leaves
    /// `relays` nil) keeps its old relay behavior verbatim — which is what keeps the hermetic
    /// loopback tests unchanged and green.
    public static func fromLegacyURLs(_ urls: [String]) -> RelaySelection {
        urls.isEmpty ? .disabled : .custom(urls)
    }

    /// Resolves the effective relay mode from the new explicit `relays` override and the legacy
    /// `relayURLs` seam: an explicit `relays` wins; `nil` falls back to `fromLegacyURLs(relayURLs)`.
    /// Unambiguous by construction — `nil` means "unspecified, use the legacy seam," distinct from
    /// an explicit `.disabled`.
    public static func resolve(relays: RelaySelection?, legacyURLs: [String]) throws -> RelayMode {
        try effective(relays: relays, legacyURLs: legacyURLs).relayMode()
    }
}
