import XCTest
import NormaProtocol

/// SP3.1 Task 1: the structured handshake-rejection payload + the epoch-lenient decode helper it
/// rides on. `import NormaProtocol` (NOT `@testable`) — like `WireEnvelopeTests`, these are the
/// public phone↔Mac contract the gateway/router/session-client consume, so the tests exercise
/// exactly what an external module sees.
final class HandshakeRejectionTests: XCTestCase {

    // MARK: - HandshakeRejection round-trip

    func testHandshakeRejectionRoundTrip() throws {
        let rejection = HandshakeRejection(code: "revoked", message: "pairing revoked")
        let data = try JSONEncoder().encode(rejection)
        let decoded = try JSONDecoder().decode(HandshakeRejection.self, from: data)
        XCTAssertEqual(decoded, rejection)
        XCTAssertEqual(decoded.code, "revoked")
        XCTAssertEqual(decoded.message, "pairing revoked")
    }

    /// The wire strings are the machine-readable contract the iOS app keys its `.revoked`-vs-
    /// transient mapping off — pin them EXACTLY so a rename can't silently break that mapping.
    func testRejectionCodeRawValuesAreTheExactWireStrings() {
        XCTAssertEqual(HandshakeRejectionCode.notPaired.rawValue, "not_paired")
        XCTAssertEqual(HandshakeRejectionCode.revoked.rawValue, "revoked")
        XCTAssertEqual(HandshakeRejectionCode.staleEpoch.rawValue, "stale_epoch")
        XCTAssertEqual(HandshakeRejectionCode.daemonUnavailable.rawValue, "daemon_unavailable")
        XCTAssertEqual(HandshakeRejectionCode.protocolError.rawValue, "protocol")
        // The full set — a new code added without updating the app's mapping is caught here.
        XCTAssertEqual(
            Set(HandshakeRejectionCode.allCases.map(\.rawValue)),
            ["not_paired", "revoked", "stale_epoch", "daemon_unavailable", "protocol"]
        )
    }

    /// A forward-compatible decode: an older phone build must decode a code it doesn't recognize
    /// (the wire field is a plain `String`, not the enum) rather than failing to parse the frame.
    func testUnknownCodeStillDecodes() throws {
        let json = Data(#"{"code":"some_future_code","message":"why"}"#.utf8)
        let decoded = try JSONDecoder().decode(HandshakeRejection.self, from: json)
        XCTAssertEqual(decoded.code, "some_future_code")
        XCTAssertNil(HandshakeRejectionCode(rawValue: decoded.code))
    }

    // MARK: - Epoch-lenient decode

    private func errorFrame(pairingEpoch: Int, rejection: HandshakeRejection) throws -> Data {
        let env = WireEnvelope(
            v: 1, pairingEpoch: pairingEpoch, hostID: "mac-host", sessionID: nil, streamID: nil,
            seq: nil, kind: .error, timestamp: 0, payload: try JSONEncoder().encode(rejection)
        )
        return try WireFrame.encode(env)
    }

    /// The whole point of `decodeLenient`: a frame stamped with a DIFFERENT epoch (exactly the
    /// `stale_epoch` case — the client's own epoch is the wrong one to validate against) decodes
    /// instead of throwing `.staleEpoch`. Strict `decode` on the same frame still throws.
    func testDecodeLenientIgnoresEpochMismatchWhileStrictDecodeThrows() throws {
        let frame = try errorFrame(pairingEpoch: 2, rejection: HandshakeRejection(code: "stale_epoch", message: "stale"))

        // Strict: the client's epoch (1) ≠ the frame's (2) → staleEpoch.
        XCTAssertThrowsError(try WireFrame.decode(frame, expectedEpoch: 1)) { error in
            XCTAssertEqual(error as? WireError, .staleEpoch)
        }
        // Lenient: decodes regardless, and the `HandshakeRejection` payload reads back.
        let env = try WireFrame.decodeLenient(frame)
        XCTAssertEqual(env.kind, .error)
        XCTAssertEqual(env.pairingEpoch, 2)
        let rejection = try JSONDecoder().decode(HandshakeRejection.self, from: env.payload)
        XCTAssertEqual(rejection.code, "stale_epoch")
    }

    /// Lenient decode still enforces EVERY other structural check strict decode does — only the
    /// epoch guard is dropped. A malformed / unknown-version / too-deep frame still throws.
    func testDecodeLenientStillEnforcesStructuralChecks() throws {
        XCTAssertThrowsError(try WireFrame.decodeLenient(Data("not json".utf8))) { error in
            XCTAssertEqual(error as? WireError, .malformed)
        }
        let wrongVersion = Data(#"{"v":2,"pairingEpoch":1,"hostID":"h","sessionID":null,"streamID":null,"seq":null,"kind":"error","timestamp":0,"payload":""}"#.utf8)
        XCTAssertThrowsError(try WireFrame.decodeLenient(wrongVersion)) { error in
            XCTAssertEqual(error as? WireError, .unknownVersion)
        }
    }
}
