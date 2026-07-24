import Testing
import Foundation
@testable import NormaProtocol

/// SP2b Task 2: pairing-ceremony crypto — transcript binding, HMAC proof, 4-word SAS, and the
/// QR payload that seeds a fresh pairing. Fixed inputs throughout; only the SAS words are
/// "derived" (computed by the production code, then asserted for structural properties —
/// wordlist membership, determinism, peer-binding) rather than hand-computed, per the brief.
struct PairingCryptoTests {
    let tPairID = Data(repeating: 0xA1, count: 16)
    let tNonce = Data(repeating: 0xB2, count: 16)
    let tSecret = Data(repeating: 0xC3, count: 32)

    @Test func transcriptIsCanonicalAndStable() {
        let t1 = PairingCrypto.transcript(v: 1, pairID: tPairID, macEndpointID: "mac1",
            phoneEndpointID: "phone1", phoneInstallNonce: tNonce, caps: ["sessions"])
        let t2 = PairingCrypto.transcript(v: 1, pairID: tPairID, macEndpointID: "mac1",
            phoneEndpointID: "phone1", phoneInstallNonce: tNonce, caps: ["sessions"])
        #expect(t1 == t2)
        // decodes as a canonical CBOR map with exactly the 6 keys, in RFC 8949 encoded-key
        // order — length-first for text keys, since the header byte embeds the length:
        // "v"(1) 0x61 < "caps"(4) 0x64 < "pairID"(6) 0x66 < "macEndpointID"(13) 0x6D
        // < "phoneEndpointID"(15) 0x6F < "phoneInstallNonce"(17) 0x71.
        let decoded = try! CanonicalCBOR.decode(t1)
        guard case .map(let entries) = decoded else { Issue.record("not a map"); return }
        #expect(entries.map(\.0) == ["v", "caps", "pairID", "macEndpointID", "phoneEndpointID", "phoneInstallNonce"])
    }

    @Test func proofBindsEveryField() {
        let base = PairingCrypto.transcript(v: 1, pairID: tPairID, macEndpointID: "mac1",
            phoneEndpointID: "phone1", phoneInstallNonce: tNonce, caps: ["sessions"])
        let proof = PairingCrypto.proof(pairSecret: tSecret, transcript: base)
        #expect(proof.count == 32)
        let other = PairingCrypto.transcript(v: 1, pairID: tPairID, macEndpointID: "mac1",
            phoneEndpointID: "EVIL", phoneInstallNonce: tNonce, caps: ["sessions"])
        #expect(PairingCrypto.proof(pairSecret: tSecret, transcript: other) != proof)
        #expect(PairingCrypto.proof(pairSecret: Data(repeating: 0, count: 32), transcript: base) != proof)
    }

    @Test func sasIsFourWordsFromWordlistAndPeerBound() {
        let t = PairingCrypto.transcript(v: 1, pairID: tPairID, macEndpointID: "mac1",
            phoneEndpointID: "phone1", phoneInstallNonce: tNonce, caps: ["sessions"])
        let words = PairingCrypto.sasWords(pairSecret: tSecret, transcript: t)
        #expect(words.count == 4)
        #expect(words.allSatisfy { effShortWordlist.contains($0) })
        // deterministic
        #expect(PairingCrypto.sasWords(pairSecret: tSecret, transcript: t) == words)
        // attacker with the SAME pairSecret but different phoneEndpointID gets different words
        let tEvil = PairingCrypto.transcript(v: 1, pairID: tPairID, macEndpointID: "mac1",
            phoneEndpointID: "EVIL", phoneInstallNonce: tNonce, caps: ["sessions"])
        #expect(PairingCrypto.sasWords(pairSecret: tSecret, transcript: tEvil) != words)
    }

    @Test func wordlistIs1296UniqueSortedWords() {
        #expect(effShortWordlist.count == 1296)
        #expect(Set(effShortWordlist).count == 1296)
        #expect(effShortWordlist == effShortWordlist.sorted())
    }

    @Test func qrPayloadRoundTripsBase64URL() throws {
        let cfg = SignedRelayConfig(config: RelayConfig(version: 1, relays: ["https://relay-1.yanlinglabs.com."]), sig: Data(repeating: 7, count: 64))
        // No SP3.2c hints (older/loopback shape): macRelayURL defaults nil, macDirectAddresses [].
        let qr = QRPayload(v: 1, pairID: tPairID, pairSecret: tSecret, expiresAt: 1_800_000_000,
            macEndpointID: "mac1", relayConfig: cfg, alpn: "computer.norma.rpc/1", hostLabel: "Test Mac")
        let s = qr.encodeBase64URL()
        #expect(!s.contains("+") && !s.contains("/") && !s.contains("="))
        let decoded = try QRPayload.decode(base64URL: s)
        #expect(decoded == qr)
        #expect(decoded.macRelayURL == nil)
        #expect(decoded.macDirectAddresses == [])
        #expect(throws: Error.self) { try QRPayload.decode(base64URL: "!!!") }
    }

    /// SP3.2c: a QR carrying the Mac's homed relay + direct addresses round-trips those hints.
    @Test func qrPayloadRoundTripsAddressHints() throws {
        let cfg = SignedRelayConfig(config: RelayConfig(version: 1, relays: ["https://relay-1.yanlinglabs.com."]), sig: Data(repeating: 7, count: 64))
        let qr = QRPayload(v: 1, pairID: tPairID, pairSecret: tSecret, expiresAt: 1_800_000_000,
            macEndpointID: "mac1", relayConfig: cfg, alpn: "computer.norma.rpc/1", hostLabel: "Test Mac",
            macRelayURL: "https://use1-1.relay.iroh.network./",
            macDirectAddresses: ["192.168.1.9:53421", "[fe80::1]:53421"])
        let decoded = try QRPayload.decode(base64URL: qr.encodeBase64URL())
        #expect(decoded == qr)
        #expect(decoded.macRelayURL == "https://use1-1.relay.iroh.network./")
        #expect(decoded.macDirectAddresses == ["192.168.1.9:53421", "[fe80::1]:53421"])
    }

    /// SP3.2c tolerance: a relay URL present but NO direct addresses (empty array) still round-trips.
    @Test func qrPayloadRoundTripsRelayOnlyNoDirectAddrs() throws {
        let cfg = SignedRelayConfig(config: RelayConfig(version: 1, relays: []), sig: Data(repeating: 7, count: 64))
        let qr = QRPayload(v: 1, pairID: tPairID, pairSecret: tSecret, expiresAt: 1_800_000_000,
            macEndpointID: "mac1", relayConfig: cfg, alpn: "computer.norma.rpc/1", hostLabel: "Test Mac",
            macRelayURL: "https://use1-1.relay.iroh.network./", macDirectAddresses: [])
        let decoded = try QRPayload.decode(base64URL: qr.encodeBase64URL())
        #expect(decoded == qr)
        #expect(decoded.macRelayURL == "https://use1-1.relay.iroh.network./")
        #expect(decoded.macDirectAddresses == [])
    }

    // MARK: - Additional coverage (beyond the brief's literal vectors — same spirit)

    @Test func proofIsDeterministic() {
        let t = PairingCrypto.transcript(v: 1, pairID: tPairID, macEndpointID: "mac1",
            phoneEndpointID: "phone1", phoneInstallNonce: tNonce, caps: ["sessions"])
        let p1 = PairingCrypto.proof(pairSecret: tSecret, transcript: t)
        let p2 = PairingCrypto.proof(pairSecret: tSecret, transcript: t)
        #expect(p1 == p2)
    }

    /// Hand-builds a QR payload's CBOR map (canonically encoded, so only the FIELD values are
    /// hostile, not the CBOR framing) and returns it base64url'd — for feeding
    /// `QRPayload.decode` inputs its own encoder would refuse to produce.
    private func handBuiltQR(
        pairID: Data? = nil,
        expiresAt: UInt64 = 1_800_000_000,
        v: UInt64 = 1,
        relayVersion: UInt64 = 1
    ) -> String {
        let relayMap = CBORValue.map([
            ("config", .map([
                ("relays", .array([])),
                ("version", .uint(relayVersion)),
            ])),
            ("sig", .bytes(Data(repeating: 7, count: 64))),
        ])
        let map = CBORValue.map([
            ("alpn", .text("computer.norma.rpc/1")),
            ("expiresAt", .uint(expiresAt)),
            ("hostLabel", .text("Test Mac")),
            ("macEndpointID", .text("mac1")),
            ("pairID", .bytes(pairID ?? tPairID)),
            ("pairSecret", .bytes(tSecret)),
            ("relayConfig", relayMap),
            ("v", .uint(v)),
        ])
        return CanonicalCBOR.encode(map)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    @Test func qrPayloadDecodeRejectsBadFieldLengths() {
        // pairID must be 16 bytes, pairSecret 32 — a hand-built CBOR map with a short pairID
        // must be rejected rather than silently accepted.
        let b64 = handBuiltQR(pairID: Data(repeating: 0xA1, count: 4))
        #expect(throws: Error.self) { try QRPayload.decode(base64URL: b64) }
    }

    @Test func qrPayloadDecodeRejectsOversizedUintsWithoutTrapping() {
        // A uint ≥ 2^63 is fully-valid canonical CBOR but doesn't fit `Int` — decode must
        // THROW `.badPayload`, never trap (crash) on the conversion. One case per field.
        #expect(throws: PairingError.badPayload) {
            try QRPayload.decode(base64URL: handBuiltQR(expiresAt: UInt64.max))
        }
        #expect(throws: PairingError.badPayload) {
            try QRPayload.decode(base64URL: handBuiltQR(v: UInt64.max))
        }
    }

    @Test func qrPayloadDecodeRejectsOversizedRelayVersionWithoutTrapping() {
        // Same trap-hazard for the nested relayConfig.config.version (decoded in
        // `decodeRelayConfig`) — 2^63 exactly is the smallest value that doesn't fit `Int`.
        #expect(throws: PairingError.badPayload) {
            try QRPayload.decode(base64URL: handBuiltQR(relayVersion: UInt64(1) << 63))
        }
    }

    @Test func verifyProofAcceptsGenuineAndRejectsForged() {
        let t = PairingCrypto.transcript(v: 1, pairID: tPairID, macEndpointID: "mac1",
            phoneEndpointID: "phone1", phoneInstallNonce: tNonce, caps: ["sessions"])
        let genuine = PairingCrypto.proof(pairSecret: tSecret, transcript: t)
        // positive: the exact proof verifies
        #expect(PairingCrypto.verifyProof(pairSecret: tSecret, transcript: t, proof: genuine))
        // negative: a single flipped bit fails
        var forged = genuine
        forged[0] ^= 0x01
        #expect(!PairingCrypto.verifyProof(pairSecret: tSecret, transcript: t, proof: forged))
        // negative: right proof, wrong transcript fails
        let tEvil = PairingCrypto.transcript(v: 1, pairID: tPairID, macEndpointID: "mac1",
            phoneEndpointID: "EVIL", phoneInstallNonce: tNonce, caps: ["sessions"])
        #expect(!PairingCrypto.verifyProof(pairSecret: tSecret, transcript: tEvil, proof: genuine))
        // negative: empty/truncated proof fails rather than crashing
        #expect(!PairingCrypto.verifyProof(pairSecret: tSecret, transcript: t, proof: Data()))
    }

    @Test func pairRequestAndAcceptedAndRejectedAreCodable() throws {
        let req = PairRequest(type: "pair_request", pairID: tPairID, phoneEndpointID: "phone1",
            phoneInstallNonce: tNonce, caps: ["sessions"], proof: Data(repeating: 1, count: 32))
        let reqData = try JSONEncoder().encode(req)
        #expect(try JSONDecoder().decode(PairRequest.self, from: reqData) == req)

        let acc = PairAccepted(type: "pair_accepted", pairID: tPairID, macEndpointID: "mac1",
            phoneEndpointID: "phone1", epoch: 1, grantedCaps: ["sessions"], protoVersion: 1,
            sessionNonce: Data(repeating: 2, count: 16))
        let accData = try JSONEncoder().encode(acc)
        #expect(try JSONDecoder().decode(PairAccepted.self, from: accData) == acc)

        let rej = PairRejected(type: "pair_rejected", code: "denied", pairID: tPairID)
        let rejData = try JSONEncoder().encode(rej)
        #expect(try JSONDecoder().decode(PairRejected.self, from: rejData) == rej)
    }
}
