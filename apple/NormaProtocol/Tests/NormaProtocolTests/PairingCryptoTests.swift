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
        // decodes as a canonical CBOR map with exactly the 6 sorted keys
        let decoded = try! CanonicalCBOR.decode(t1)
        guard case .map(let entries) = decoded else { Issue.record("not a map"); return }
        #expect(entries.map(\.0) == ["caps", "macEndpointID", "pairID", "phoneEndpointID", "phoneInstallNonce", "v"])
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
        let qr = QRPayload(v: 1, pairID: tPairID, pairSecret: tSecret, expiresAt: 1_800_000_000,
            macEndpointID: "mac1", relayConfig: cfg, alpn: "computer.norma.rpc/1", hostLabel: "Alex's Mac")
        let s = qr.encodeBase64URL()
        #expect(!s.contains("+") && !s.contains("/") && !s.contains("="))
        #expect(try QRPayload.decode(base64URL: s) == qr)
        #expect(throws: Error.self) { try QRPayload.decode(base64URL: "!!!") }
    }

    // MARK: - Additional coverage (beyond the brief's literal vectors — same spirit)

    @Test func proofIsDeterministic() {
        let t = PairingCrypto.transcript(v: 1, pairID: tPairID, macEndpointID: "mac1",
            phoneEndpointID: "phone1", phoneInstallNonce: tNonce, caps: ["sessions"])
        let p1 = PairingCrypto.proof(pairSecret: tSecret, transcript: t)
        let p2 = PairingCrypto.proof(pairSecret: tSecret, transcript: t)
        #expect(p1 == p2)
    }

    @Test func qrPayloadDecodeRejectsBadFieldLengths() {
        // pairID must be 16 bytes, pairSecret 32 — a hand-built CBOR map with a short pairID
        // must be rejected rather than silently accepted.
        let cfg = SignedRelayConfig(config: RelayConfig(version: 1, relays: []), sig: Data(repeating: 7, count: 64))
        let badPairID = Data(repeating: 0xA1, count: 4) // wrong length
        let relayMap = CBORValue.map([
            ("config", .map([
                ("relays", .array(cfg.config.relays.map { .text($0) })),
                ("version", .uint(UInt64(cfg.config.version))),
            ])),
            ("sig", .bytes(cfg.sig)),
        ])
        let map = CBORValue.map([
            ("alpn", .text("computer.norma.rpc/1")),
            ("expiresAt", .uint(1_800_000_000)),
            ("hostLabel", .text("Alex's Mac")),
            ("macEndpointID", .text("mac1")),
            ("pairID", .bytes(badPairID)),
            ("pairSecret", .bytes(tSecret)),
            ("relayConfig", relayMap),
            ("v", .uint(1)),
        ])
        let bytes = CanonicalCBOR.encode(map)
        let b64 = bytes.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        #expect(throws: Error.self) { try QRPayload.decode(base64URL: b64) }
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

        let rej = PairRejected(type: "pair_rejected", code: "denied")
        let rejData = try JSONEncoder().encode(rej)
        #expect(try JSONDecoder().decode(PairRejected.self, from: rejData) == rej)
    }
}
