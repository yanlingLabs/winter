import Foundation

/// Mac → phone, the structured refusal payload carried inside an `.error`-kind `WireEnvelope` when
/// the gateway (or the pairing router, on the `not_paired` path) turns a session dialer's handshake
/// away (SP3.1 Task 1). Before this, a real revoke/not-paired/stale-epoch reached the phone only as
/// a bare connection close (the router sent a raw-JSON `PairRejected` a `NormaSessionClient` can't
/// decode, or the gateway sent an id-less error the client's rpc-error path ignores) — so the app
/// collapsed every honest refusal to `.macUnavailable`. This gives it a TYPED signal instead: the
/// `code` distinguishes a re-pair-required refusal (`not_paired`/`revoked`/`stale_epoch`, all of
/// which the iOS app maps to its honest `.revoked` state) from a transient one
/// (`daemon_unavailable`/`protocol`).
///
/// **Phone-wire only.** Like `WireEnvelope`/`ClientHello`/`ServerHello`, this is a Swift-native type
/// of the phone↔Mac transport — it has NO counterpart in the daemon's TS/zod protocol and no
/// generated fixture, so adding it needs no `pnpm protocol:generate` run.
public struct HandshakeRejection: Codable, Equatable, Sendable {
    /// A `HandshakeRejectionCode` raw value. Kept a plain `String` (not the enum) on the wire so an
    /// older phone build can still decode a future code it doesn't recognize instead of failing to
    /// parse the whole frame — the same forward-compatibility posture `PairRejected.code` takes.
    public let code: String
    /// Free-text, for diagnostics only — never rendered as UI, never carries secrets/content. The
    /// `code` is the machine-readable signal; this is a human-readable "why" for logs.
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}

/// The exact set of reason codes a `HandshakeRejection.code` carries. Raw values are the wire
/// strings (EXACT — the iOS app keys its `.revoked`-vs-transient mapping off them).
///
///   - `notPaired`   — the peer holds no `PairRecord` (never paired, or its record was revoked and
///                     removed). The pairing router's `sendNotPairedRejection` assigns this.
///   - `revoked`     — the peer's `clientInstanceID` is in the gateway's revoked set (a mid-session
///                     revoke whose record still exists). The gateway assigns this.
///   - `staleEpoch`  — the hello's `pairingEpoch` no longer matches the current record's (revoked +
///                     re-paired: the epoch bumped). The gateway assigns this on the `WireFrame.decode`
///                     `.staleEpoch` catch.
///   - `daemonUnavailable` — the gateway could not reach the local daemon to service the session.
///   - `protocolError`     — a malformed/invalid/unexpected hello frame (a wire-protocol violation).
///
/// The first three mean "re-pair required" → the app's honest `.revoked`; the last two are transient.
public enum HandshakeRejectionCode: String, Sendable, CaseIterable {
    case notPaired = "not_paired"
    case revoked
    case staleEpoch = "stale_epoch"
    case daemonUnavailable = "daemon_unavailable"
    case protocolError = "protocol"
}
