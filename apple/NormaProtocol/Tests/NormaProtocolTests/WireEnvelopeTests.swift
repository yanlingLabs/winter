import XCTest
import NormaProtocol

/// Remote Gateway sub-project, Task 3: wire envelope + length framing + resume handshake types.
/// Deliberately `import NormaProtocol` (NOT `@testable`) — these types are the public contract
/// Task 4 (gateway) and Task 5 (phone app) consume, so the tests exercise exactly what an
/// external module sees.
final class WireEnvelopeTests: XCTestCase {

    // MARK: - Helpers

    func makeEnvelope(
        v: Int = 1,
        pairingEpoch: Int = 7,
        hostID: String = "host-abc",
        sessionID: String? = "sess-1",
        streamID: String? = "stream-1",
        seq: Int? = 42,
        kind: WireKind = .event,
        timestamp: Int = 1_700_000_000,
        payload: Data = Data(#"{"jsonrpc":"2.0","method":"ping"}"#.utf8)
    ) -> WireEnvelope {
        WireEnvelope(
            v: v,
            pairingEpoch: pairingEpoch,
            hostID: hostID,
            sessionID: sessionID,
            streamID: streamID,
            seq: seq,
            kind: kind,
            timestamp: timestamp,
            payload: payload
        )
    }

    // MARK: - Envelope round-trip

    func testEnvelopeRoundTrip() throws {
        let envelope = makeEnvelope()
        let frame = try WireFrame.encode(envelope)
        let decoded = try WireFrame.decode(frame, expectedEpoch: envelope.pairingEpoch)
        XCTAssertEqual(decoded, envelope)
        XCTAssertEqual(decoded.payload, envelope.payload)
    }

    func testEnvelopeRoundTripWithNilOptionalFields() throws {
        let envelope = makeEnvelope(sessionID: nil, streamID: nil, seq: nil, kind: .hello)
        let frame = try WireFrame.encode(envelope)
        let decoded = try WireFrame.decode(frame, expectedEpoch: envelope.pairingEpoch)
        XCTAssertEqual(decoded, envelope)
        XCTAssertNil(decoded.sessionID)
        XCTAssertNil(decoded.streamID)
        XCTAssertNil(decoded.seq)
    }

    // MARK: - LengthPrefix framing

    func testLengthPrefixWrapUnwrapRoundTrip() throws {
        let payload = Data("hello world".utf8)
        var stream = LengthPrefix.wrap(payload)
        let unwrapped = try LengthPrefix.unwrap(&stream, maxBytes: 1 << 20)
        XCTAssertEqual(unwrapped, payload)
        XCTAssertEqual(stream.count, 0)
    }

    func testLengthPrefixPartialBufferReturnsNil() throws {
        let payload = Data("hello world".utf8)
        let wrapped = LengthPrefix.wrap(payload)
        var partial = wrapped.prefix(wrapped.count - 1) // one byte short of the full frame
        let result = try LengthPrefix.unwrap(&partial, maxBytes: 1 << 20)
        XCTAssertNil(result)
    }

    func testLengthPrefixTwoFramesConcatenated() throws {
        let first = Data("first".utf8)
        let second = Data("second-frame-payload".utf8)
        var stream = LengthPrefix.wrap(first)
        stream.append(LengthPrefix.wrap(second))

        let unwrapped1 = try LengthPrefix.unwrap(&stream, maxBytes: 1 << 20)
        XCTAssertEqual(unwrapped1, first)
        let unwrapped2 = try LengthPrefix.unwrap(&stream, maxBytes: 1 << 20)
        XCTAssertEqual(unwrapped2, second)
        XCTAssertEqual(stream.count, 0)
    }

    func testLengthPrefixOversizeThrows() throws {
        var stream = LengthPrefix.wrap(Data(repeating: 0x41, count: 1000))
        XCTAssertThrowsError(try LengthPrefix.unwrap(&stream, maxBytes: 100)) { error in
            XCTAssertEqual(error as? WireError, .oversize)
        }
    }

    // MARK: - decode rejection matrix

    func testDecodeThrowsOversize() throws {
        let envelope = makeEnvelope(payload: Data(repeating: 0x41, count: 2000))
        let frame = try WireFrame.encode(envelope)
        XCTAssertThrowsError(try WireFrame.decode(frame, maxBytes: 100, expectedEpoch: envelope.pairingEpoch)) { error in
            XCTAssertEqual(error as? WireError, .oversize)
        }
    }

    func testDecodeThrowsInvalidUTF8() throws {
        let bad = Data([0xFF, 0xFE, 0xFD])
        XCTAssertThrowsError(try WireFrame.decode(bad, expectedEpoch: 1)) { error in
            XCTAssertEqual(error as? WireError, .invalidUTF8)
        }
    }

    func testDecodeThrowsTooDeep() throws {
        // {"a":{"a":{"a":{"a":{"a":1}}}}} — 5 levels of object nesting.
        var json = "1"
        for _ in 0..<5 {
            json = "{\"a\":\(json)}"
        }
        let frame = Data(json.utf8)
        XCTAssertThrowsError(try WireFrame.decode(frame, maxDepth: 3, expectedEpoch: 1)) { error in
            XCTAssertEqual(error as? WireError, .tooDeep)
        }
    }

    func testDecodeThrowsDuplicateKey() throws {
        let json = #"{"v":1,"v":1,"pairingEpoch":1,"hostID":"h","kind":"event","timestamp":0,"payload":""}"#
        let frame = Data(json.utf8)
        XCTAssertThrowsError(try WireFrame.decode(frame, expectedEpoch: 1)) { error in
            XCTAssertEqual(error as? WireError, .duplicateKey)
        }
    }

    func testDecodeThrowsUnknownVersion() throws {
        let json = #"{"v":2,"pairingEpoch":1,"hostID":"h","kind":"event","timestamp":0,"payload":""}"#
        let frame = Data(json.utf8)
        XCTAssertThrowsError(try WireFrame.decode(frame, expectedEpoch: 1)) { error in
            XCTAssertEqual(error as? WireError, .unknownVersion)
        }
    }

    func testDecodeThrowsUnknownKind() throws {
        let json = #"{"v":1,"pairingEpoch":1,"hostID":"h","kind":"bogus","timestamp":0,"payload":""}"#
        let frame = Data(json.utf8)
        XCTAssertThrowsError(try WireFrame.decode(frame, expectedEpoch: 1)) { error in
            XCTAssertEqual(error as? WireError, .unknownKind)
        }
    }

    func testDecodeThrowsStaleEpoch() throws {
        let envelope = makeEnvelope(pairingEpoch: 5)
        let frame = try WireFrame.encode(envelope)
        XCTAssertThrowsError(try WireFrame.decode(frame, expectedEpoch: 999)) { error in
            XCTAssertEqual(error as? WireError, .staleEpoch)
        }
    }

    func testDecodeThrowsMalformed() throws {
        // Truncated JSON — passes the byte-shape scan (balanced enough to not blow depth/dup
        // checks) but neither JSONSerialization nor JSONDecoder can parse it.
        let frame = Data(#"{"v":1,"pairingEpoch":1,"#.utf8)
        XCTAssertThrowsError(try WireFrame.decode(frame, expectedEpoch: 1)) { error in
            XCTAssertEqual(error as? WireError, .malformed)
        }
    }

    // MARK: - Resume handshake types — Codable round-trips

    func testStreamResumeRoundTrip() throws {
        let resume = StreamResume(sessionID: "s1", streamID: "st1", lastAppliedSeq: 42)
        let data = try JSONEncoder().encode(resume)
        let decoded = try JSONDecoder().decode(StreamResume.self, from: data)
        XCTAssertEqual(decoded, resume)
    }

    func testClientHelloRoundTrip() throws {
        let hello = ClientHello(
            protocolVersions: [1, 2],
            appBuild: "42",
            clientInstanceID: "client-1",
            pairingEpoch: 3,
            resumes: [
                StreamResume(sessionID: "s1", streamID: "st1", lastAppliedSeq: 10),
                StreamResume(sessionID: "s2", streamID: "st2", lastAppliedSeq: 0),
            ]
        )
        let data = try JSONEncoder().encode(hello)
        let decoded = try JSONDecoder().decode(ClientHello.self, from: data)
        XCTAssertEqual(decoded, hello)
    }

    func testClientHelloRoundTripWithEmptyResumes() throws {
        let hello = ClientHello(
            protocolVersions: [1],
            appBuild: "1",
            clientInstanceID: "client-2",
            pairingEpoch: 0,
            resumes: []
        )
        let data = try JSONEncoder().encode(hello)
        let decoded = try JSONDecoder().decode(ClientHello.self, from: data)
        XCTAssertEqual(decoded, hello)
    }

    func testResumeVerdictRoundTripReplayBegin() throws {
        let verdict = ResumeVerdict.replayBegin(sessionID: "s1", fromSeq: 5, highWatermark: 20)
        let data = try JSONEncoder().encode(verdict)
        let decoded = try JSONDecoder().decode(ResumeVerdict.self, from: data)
        XCTAssertEqual(decoded, verdict)
    }

    func testResumeVerdictRoundTripUpToDate() throws {
        let verdict = ResumeVerdict.upToDate(sessionID: "s2", highWatermark: 30)
        let data = try JSONEncoder().encode(verdict)
        let decoded = try JSONDecoder().decode(ResumeVerdict.self, from: data)
        XCTAssertEqual(decoded, verdict)
    }

    func testResumeVerdictRoundTripSnapshotRequired() throws {
        let verdict = ResumeVerdict.snapshotRequired(sessionID: "s3", reason: "gap too large", oldestAvailableSeq: 100)
        let data = try JSONEncoder().encode(verdict)
        let decoded = try JSONDecoder().decode(ResumeVerdict.self, from: data)
        XCTAssertEqual(decoded, verdict)
    }

    func testServerHelloRoundTrip() throws {
        let hello = ServerHello(
            chosenVersion: 1,
            hostID: "host-abc",
            verdicts: [
                .upToDate(sessionID: "s1", highWatermark: 5),
                .snapshotRequired(sessionID: "s2", reason: "no history", oldestAvailableSeq: 0),
                .replayBegin(sessionID: "s3", fromSeq: 1, highWatermark: 9),
            ]
        )
        let data = try JSONEncoder().encode(hello)
        let decoded = try JSONDecoder().decode(ServerHello.self, from: data)
        XCTAssertEqual(decoded, hello)
    }

    // MARK: - Transport keepalive (KA-T1)

    func testPingPongKindsRoundTrip() throws {
        for kind in [WireKind.ping, WireKind.pong] {
            let env = WireEnvelope(
                v: 1, pairingEpoch: 3, hostID: "h", sessionID: nil, streamID: nil,
                seq: nil, kind: kind, timestamp: 123, payload: Data())
            let decoded = try WireFrame.decode(WireFrame.encode(env), expectedEpoch: 3)
            XCTAssertEqual(decoded.kind, kind)
            XCTAssertTrue(decoded.payload.isEmpty)
        }
    }

    func testGenuinelyUnknownKindStillRejected() {
        // The unknown-kind tripwire must survive the enum growth.
        let json = #"{"v":1,"pairingEpoch":3,"hostID":"h","kind":"warble","timestamp":1,"payload":""}"#
        XCTAssertThrowsError(try WireFrame.decode(Data(json.utf8), expectedEpoch: 3)) { error in
            XCTAssertEqual(error as? WireError, WireError.unknownKind)
        }
    }
}
