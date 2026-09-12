import Foundation
import CryptoKit

/// Errors thrown while decoding a `QRPayload` (or, transitively, the `SignedRelayConfig` nested
/// inside it) from its wire form.
public enum PairingError: Error, Equatable {
    case badPayload
}

/// The phone<->Mac pairing ceremony's crypto core (SP2b Task 2): a canonical-CBOR transcript
/// binding every field the two sides agree on, an HMAC "proof" the phone presents to show it
/// holds the pairing secret, and a 4-word Short Authentication String (SAS) a human can compare
/// out-of-band. All three are pure functions of their inputs — no state, no I/O.
public enum PairingCrypto {
    /// Domain-separates the proof MAC from the SAS MAC (and from every other HMAC in the
    /// system) so the same transcript+secret pair can never produce a value one construction
    /// would accept for the other.
    private static let proofDomain = Data("norma-pair-proof/1".utf8)
    private static let sasDomain = Data("norma-pair-sas/1".utf8)

    /// `1296^0 ... 1296^3` — precomputed so `sasWords` can extract each base-1296 digit with a
    /// single divide-and-mod instead of repeated exponentiation.
    private static let pow1296: [UInt64] = [1, 1296, 1_679_616, 2_176_782_336]

    /// Builds the canonical-CBOR transcript both sides of a pairing ceremony hash and sign over.
    /// Every field either side could disagree about — protocol version, the pairing ID, both
    /// endpoint IDs, the phone's install nonce, and the requested capabilities — is bound in,
    /// so a MITM can't quietly substitute its own endpoint ID or capability list. Keys are
    /// listed alphabetically here purely for readability; `CanonicalCBOR.encode` sorts
    /// unconditionally by ENCODED key bytes (RFC 8949 — length-first for text keys), so the
    /// wire order is `v, caps, pairID, macEndpointID, phoneEndpointID, phoneInstallNonce`.
    public static func transcript(
        v: Int,
        pairID: Data,
        macEndpointID: String,
        phoneEndpointID: String,
        phoneInstallNonce: Data,
        caps: [String]
    ) -> Data {
        let map = CBORValue.map([
            ("caps", .array(caps.map { .text($0) })),
            ("macEndpointID", .text(macEndpointID)),
            ("pairID", .bytes(pairID)),
            ("phoneEndpointID", .text(phoneEndpointID)),
            ("phoneInstallNonce", .bytes(phoneInstallNonce)),
            ("v", .uint(UInt64(v))),
        ])
        return CanonicalCBOR.encode(map)
    }

    /// The phone's proof that it holds `pairSecret` (learned from the QR code) — the Mac
    /// recomputes this from its own copy of the secret and the same transcript and compares.
    /// A 32-byte HMAC-SHA256, domain-separated from the SAS MAC below.
    public static func proof(pairSecret: Data, transcript: Data) -> Data {
        let key = SymmetricKey(data: pairSecret)
        let mac = HMAC<SHA256>.authenticationCode(for: proofDomain + transcript, using: key)
        return Data(mac)
    }

    /// Constant-time check of a received `proof` against the locally-recomputed one — the ONLY
    /// way the Mac side (Task 3's PairingManager) should compare proofs. `Data == Data` is an
    /// early-exit memcmp whose timing leaks how many leading bytes matched; CryptoKit's
    /// `isValidAuthenticationCode` compares in constant time.
    public static func verifyProof(pairSecret: Data, transcript: Data, proof: Data) -> Bool {
        let key = SymmetricKey(data: pairSecret)
        return HMAC<SHA256>.isValidAuthenticationCode(
            proof,
            authenticating: proofDomain + transcript,
            using: key
        )
    }

    /// A 4-word Short Authentication String either side can render for a human to compare
    /// out-of-band, binding `pairSecret` and `transcript` the same way `proof` does but through
    /// a domain-separated MAC so proof and SAS values can never collide. Takes the first 5
    /// bytes (40 bits) of the MAC, big-endian, and reads off 4 base-1296 digits into
    /// `effShortWordlist`, most-significant digit first.
    public static func sasWords(pairSecret: Data, transcript: Data) -> [String] {
        let key = SymmetricKey(data: pairSecret)
        let mac = HMAC<SHA256>.authenticationCode(for: sasDomain + transcript, using: key)
        let first5 = Data(mac).prefix(5)
        var value: UInt64 = 0
        for byte in first5 {
            value = (value << 8) | UInt64(byte)
        }
        var words: [String] = []
        for i in (0..<4).reversed() {
            let digit = Int((value / pow1296[i]) % 1296)
            words.append(effShortWordlist[digit])
        }
        return words
    }
}

/// Everything a fresh phone needs to join a pairing ceremony, carried in the QR code the Mac
/// displays: the pairing identifiers/secret, where and how to reach the Mac, the relay config
/// (in case a direct connection isn't available), and when the pairing offer expires. Encoded
/// as a canonical-CBOR map (so it round-trips byte-for-byte and has a compact QR-friendly
/// binary form) then base64url'd for embedding in the QR payload text.
public struct QRPayload: Equatable {
    public let v: Int
    public let pairID: Data
    public let pairSecret: Data
    public let expiresAt: Int
    public let macEndpointID: String
    public let relayConfig: SignedRelayConfig
    public let alpn: String
    public let hostLabel: String
    /// SP3.2c: the Mac's HOMED relay URL (from `IrohListener.endpointAddr.relayUrl()` after
    /// `online()`), embedded so the phone can dial the FULL `EndpointAddr` without any DNS/pkarr
    /// discovery lookup — iOS's network stack fails iroh's pkarr TXT-record resolution (verified
    /// live: `Service 'dns' failed: Failed to resolve TXT record`), so a bare-node-id dial that
    /// depends on discovery never connects from a phone. `nil` when relays are disabled (loopback /
    /// same-LAN dev). NOT part of the pairing HMAC transcript (identity is `macEndpointID`) — a
    /// pure connection hint, so it needs no crypto/transcript change.
    public let macRelayURL: String?
    /// SP3.2c: the Mac's direct (IP/port) candidate addresses (from
    /// `IrohListener.endpointAddr.directAddresses()`), embedded alongside `macRelayURL` for the
    /// same discovery-free reason. Empty when none are known/advertised. Same "connection hint,
    /// not in the transcript" status as `macRelayURL`.
    public let macDirectAddresses: [String]

    public init(
        v: Int,
        pairID: Data,
        pairSecret: Data,
        expiresAt: Int,
        macEndpointID: String,
        relayConfig: SignedRelayConfig,
        alpn: String,
        hostLabel: String,
        macRelayURL: String? = nil,
        macDirectAddresses: [String] = []
    ) {
        self.v = v
        self.pairID = pairID
        self.pairSecret = pairSecret
        self.expiresAt = expiresAt
        self.macEndpointID = macEndpointID
        self.relayConfig = relayConfig
        self.alpn = alpn
        self.hostLabel = hostLabel
        self.macRelayURL = macRelayURL
        self.macDirectAddresses = macDirectAddresses
    }

    private func toCBOR() -> CBORValue {
        // `CanonicalCBOR.encode` sorts unconditionally by encoded key bytes (RFC 8949), so the
        // listing order here is irrelevant to the wire form. `macDirectAddresses` is always
        // present as an `.array` (empty encodes cleanly as `[]`); `macRelayURL` is OMITTED when
        // nil (text-or-absent) — an old-shape QR with neither field still decodes (see `decode`).
        var entries: [(String, CBORValue)] = [
            ("alpn", .text(alpn)),
            ("expiresAt", .uint(UInt64(expiresAt))),
            ("hostLabel", .text(hostLabel)),
            ("macDirectAddresses", .array(macDirectAddresses.map { .text($0) })),
            ("macEndpointID", .text(macEndpointID)),
            ("pairID", .bytes(pairID)),
            ("pairSecret", .bytes(pairSecret)),
            ("relayConfig", Self.encodeRelayConfig(relayConfig)),
            ("v", .uint(UInt64(v))),
        ]
        if let macRelayURL {
            entries.append(("macRelayURL", .text(macRelayURL)))
        }
        return .map(entries)
    }

    /// Encodes exactly the nested shape the brief specifies:
    /// `{config: {relays: [tstr], version: uint}, sig: bstr}` — reusing
    /// `RelayConfigSigner.canonicalMap` for the inner map so the QR's wire shape and the
    /// signed payload can never drift apart.
    private static func encodeRelayConfig(_ signed: SignedRelayConfig) -> CBORValue {
        .map([
            ("config", RelayConfigSigner.canonicalMap(signed.config)),
            ("sig", .bytes(signed.sig)),
        ])
    }

    private static func decodeRelayConfig(_ value: CBORValue) throws -> SignedRelayConfig {
        guard case .map(let entries) = value else { throw PairingError.badPayload }
        let fields = Dictionary(uniqueKeysWithValues: entries)
        guard
            case .map(let configEntries)? = fields["config"],
            case .bytes(let sig)? = fields["sig"]
        else {
            throw PairingError.badPayload
        }
        let configFields = Dictionary(uniqueKeysWithValues: configEntries)
        guard
            case .array(let relaysCBOR)? = configFields["relays"],
            case .uint(let versionU)? = configFields["version"]
        else {
            throw PairingError.badPayload
        }
        var relays: [String] = []
        relays.reserveCapacity(relaysCBOR.count)
        for entry in relaysCBOR {
            guard case .text(let relay) = entry else { throw PairingError.badPayload }
            relays.append(relay)
        }
        // `Int(exactly:)`, not `Int(_:)` — a uint ≥ 2^63 is fully-valid canonical CBOR, and a
        // trapping conversion would let a crafted payload crash the process instead of being
        // rejected like any other malformed field.
        guard let version = Int(exactly: versionU) else { throw PairingError.badPayload }
        return SignedRelayConfig(config: RelayConfig(version: version, relays: relays), sig: sig)
    }

    /// Base64url, no padding — the alphabet QR-code text payloads and URL query strings both
    /// tolerate without escaping.
    public func encodeBase64URL() -> String {
        CanonicalCBOR.encode(toCBOR())
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Reverses `encodeBase64URL`, validating every field's type and the two fixed-length
    /// fields (`pairID` 16 bytes, `pairSecret` 32 bytes) — anything else throws
    /// `PairingError.badPayload` rather than producing a half-populated value.
    public static func decode(base64URL: String) throws -> QRPayload {
        var base64 = base64URL
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 {
            base64.append("=")
        }
        guard let bytes = Data(base64Encoded: base64) else { throw PairingError.badPayload }

        let value: CBORValue
        do {
            value = try CanonicalCBOR.decode(bytes)
        } catch {
            throw PairingError.badPayload
        }
        guard case .map(let entries) = value else { throw PairingError.badPayload }
        let fields = Dictionary(uniqueKeysWithValues: entries)

        guard
            case .text(let alpn)? = fields["alpn"],
            case .uint(let expiresAtU)? = fields["expiresAt"],
            case .text(let hostLabel)? = fields["hostLabel"],
            case .text(let macEndpointID)? = fields["macEndpointID"],
            case .bytes(let pairID)? = fields["pairID"],
            case .bytes(let pairSecret)? = fields["pairSecret"],
            let relayConfigCBOR = fields["relayConfig"],
            case .uint(let vU)? = fields["v"]
        else {
            throw PairingError.badPayload
        }
        guard pairID.count == 16, pairSecret.count == 32 else { throw PairingError.badPayload }
        // `Int(exactly:)`, not `Int(_:)` — a uint ≥ 2^63 is fully-valid canonical CBOR, and a
        // trapping conversion would let a crafted QR code crash the process instead of being
        // rejected like any other malformed field.
        guard let v = Int(exactly: vU), let expiresAt = Int(exactly: expiresAtU) else {
            throw PairingError.badPayload
        }

        // SP3.2c connection hints — TOLERANT: absent means an older/loopback QR that predates these
        // fields, which must still decode (default nil / []). A PRESENT field is decoded strictly
        // (text / array-of-text), rejecting a genuinely malformed value the same way every other
        // field above does — consistent with `decodeRelayConfig`'s own array handling.
        var macRelayURL: String? = nil
        if let relayURLField = fields["macRelayURL"] {
            guard case .text(let s) = relayURLField else { throw PairingError.badPayload }
            macRelayURL = s
        }
        var macDirectAddresses: [String] = []
        if let addressesField = fields["macDirectAddresses"] {
            guard case .array(let addrCBOR) = addressesField else { throw PairingError.badPayload }
            macDirectAddresses.reserveCapacity(addrCBOR.count)
            for entry in addrCBOR {
                guard case .text(let addr) = entry else { throw PairingError.badPayload }
                macDirectAddresses.append(addr)
            }
        }

        let relayConfig = try decodeRelayConfig(relayConfigCBOR)
        return QRPayload(
            v: v,
            pairID: pairID,
            pairSecret: pairSecret,
            expiresAt: expiresAt,
            macEndpointID: macEndpointID,
            relayConfig: relayConfig,
            alpn: alpn,
            hostLabel: hostLabel,
            macRelayURL: macRelayURL,
            macDirectAddresses: macDirectAddresses
        )
    }
}

/// Phone -> Mac: "I'd like to pair, and here's proof I hold the secret from your QR code."
/// Plain JSON on the wire (framing is Task 4's router) — `Data` fields ride as base64 strings
/// via Foundation's default `Codable` conformance. Canonical-CBOR bytes only matter for the
/// transcript/QR types above, not for these ceremony messages.
public struct PairRequest: Codable, Equatable {
    public let type: String
    public let pairID: Data
    public let phoneEndpointID: String
    public let phoneInstallNonce: Data
    public let caps: [String]
    public let proof: Data

    public init(
        type: String,
        pairID: Data,
        phoneEndpointID: String,
        phoneInstallNonce: Data,
        caps: [String],
        proof: Data
    ) {
        self.type = type
        self.pairID = pairID
        self.phoneEndpointID = phoneEndpointID
        self.phoneInstallNonce = phoneInstallNonce
        self.caps = caps
        self.proof = proof
    }
}

/// Mac -> phone: pairing accepted — the epoch and granted capabilities the phone should now
/// operate under, plus a fresh session nonce.
public struct PairAccepted: Codable, Equatable {
    public let type: String
    public let pairID: Data
    public let macEndpointID: String
    public let phoneEndpointID: String
    public let epoch: Int
    public let grantedCaps: [String]
    public let protoVersion: Int
    public let sessionNonce: Data

    public init(
        type: String,
        pairID: Data,
        macEndpointID: String,
        phoneEndpointID: String,
        epoch: Int,
        grantedCaps: [String],
        protoVersion: Int,
        sessionNonce: Data
    ) {
        self.type = type
        self.pairID = pairID
        self.macEndpointID = macEndpointID
        self.phoneEndpointID = phoneEndpointID
        self.epoch = epoch
        self.grantedCaps = grantedCaps
        self.protoVersion = protoVersion
        self.sessionNonce = sessionNonce
    }
}

/// Mac -> phone: pairing refused. `code` is one of `"denied"`, `"timeout"`, `"not_paired"`,
/// `"bad_request"` — a plain `String` here (not an enum) so an older phone build can still
/// decode a future code it doesn't recognize instead of failing to parse the whole message.
///
/// `pairID` (SP3 T5 carry-in gate) disambiguates WHICH ceremony this rejection belongs to, so a
/// caller juggling more than one in-flight ceremony (or a superseded/stale one, e.g.
/// `PairingManager.beginPairing()`'s own orphan-reject path) can bind the failure to the right
/// one instead of guessing from `code` alone. `nil` for the two rejection paths that have no
/// ceremony context at all: a stranger's `"not_paired"` bounce (`PairingRouter`'s
/// `sendNotPairedRejection` — the connection never even reached a `PairRequest`) and an
/// undecodable `"bad_request"` (the pairID inside the malformed frame couldn't be trusted/read
/// in the first place).
public struct PairRejected: Codable, Equatable {
    public let type: String
    public let code: String
    public let pairID: Data?

    public init(type: String, code: String, pairID: Data?) {
        self.type = type
        self.code = code
        self.pairID = pairID
    }
}
