import XCTest
import CryptoKit
@testable import LauncherCore

/*
 * The golden vectors are S1's, the cross-language oracle (docs/cowork-native-worker.md): the Swift launcher copies the contract and
 * carries this drift test against them, never the other way round. The copies in Vectors/ are pinned by SHA-256 (Vectors/PINS.json,
 * with the S1 commit they came from), so a silent edit to a copy fails the first test below.
 */
final class GoldenVectorTests: XCTestCase {
    private func failure(_ block: () throws -> Void) -> String? {
        do { try block(); return nil } catch let error as WireFailure { return error.rawValue } catch { return "other:\(error)" }
    }

    // MARK: pins

    func testVectorCopiesMatchTheirPinnedHashes() throws {
        let pins = try loadVector("PINS.json")
        XCTAssertEqual(pins["sourceBranch"] as? String, "cowork/n2-host-adapter")
        XCTAssertEqual((pins["lastCommitTouchingVectors"] as? String)?.count, 40)
        let hashes = try XCTUnwrap(pins["sha256"] as? [String: String])
        XCTAssertEqual(Set(hashes.keys), ["envelopes.json", "launcher-lines.json", "mux-frames.json", "stop-receipts.json"])
        for (name, expected) in hashes {
            let actual = SHA256.hash(data: try Data(contentsOf: vectorURL(name))).map { String(format: "%02x", $0) }.joined()
            XCTAssertEqual(actual, expected, "\(name) differs from the S1 copy it is pinned to")
        }
    }

    // MARK: envelopes (L2)

    func testEnvelopeVectorsByteForByte() throws {
        let document = try loadVector("envelopes.json")
        let positives = try XCTUnwrap(document["positive"] as? [[String: Any]])
        XCTAssertEqual(positives.count, 7)
        for vector in positives {
            let name = vector["name"] as! String
            let raw = bytes(fromHex: vector["hex"] as! String)
            let direction: EnvelopeDirection = (vector["direction"] as! String) == "to-worker" ? .toWorker : .toLauncher
            let parsed = try EnvelopeFormat.parse(raw, rights: vector["rights"] as! Int, direction: direction)
            XCTAssertEqual(Int(parsed.seq), vector["seq"] as! Int, name)
            XCTAssertEqual(try EnvelopeFormat.serialize(parsed), raw, "\(name): encoder and decoder must agree byte for byte")
            XCTAssertEqual(parsed.wantedRights, vector["rights"] as! Int, name)
        }
        let negatives = try XCTUnwrap(document["negative"] as? [[String: Any]])
        XCTAssertEqual(negatives.count, 27)
        for vector in negatives {
            let name = vector["name"] as! String
            let direction: EnvelopeDirection = (vector["direction"] as! String) == "to-worker" ? .toWorker : .toLauncher
            let got = failure { _ = try EnvelopeFormat.parse(bytes(fromHex: vector["hex"] as! String), rights: vector["rights"] as! Int, direction: direction) }
            XCTAssertEqual(got, vector["error"] as? String, name)
        }
    }

    func testScopeDigestMatchesTheVector() throws {
        let document = try loadVector("envelopes.json")
        let entry = try XCTUnwrap(document["scopeDigest"] as? [String: Any])
        let s = try XCTUnwrap(entry["scope"] as? [String: Any])
        let scope = Scope(workspaceId: s["workspaceId"] as! String, incarnationId: s["incarnationId"] as! String, leaseEpoch: s["leaseEpoch"] as! Int, admissionId: s["admissionId"] as! String,
                          controllerInstanceId: s["controllerInstanceId"] as! String, workerInstanceId: s["workerInstanceId"] as! String, runtimeImageDigest: s["runtimeImageDigest"] as! String,
                          vcpus: s["vcpus"] as! Int, memoryMiB: s["memoryMiB"] as! Int)
        XCTAssertEqual(try EnvelopeFormat.scopeDigest(scope), entry["sha256"] as? String)
        var fixture = Fixture.scope; fixture.workerInstanceId = scope.workerInstanceId
        XCTAssertEqual(scope, fixture, "the fixtures of this package are the vectors' scope")
    }

    // MARK: launcher lines (L1)

    func testLauncherLineVectorsByteForByte() throws {
        let document = try loadVector("launcher-lines.json")
        let positives = try XCTUnwrap(document["positive"] as? [[String: Any]])
        XCTAssertEqual(positives.count, 19)
        var seen = Set<String>()
        for vector in positives {
            let name = vector["name"] as! String, line = Array((vector["line"] as! String).utf8), rights = vector["rights"] as! Int
            if (vector["direction"] as! String) == "to-daemon" {
                let message = try LauncherLineCodec.parseToDaemon(line, rights: rights)
                XCTAssertEqual(try LauncherLineCodec.serialize(message), line, "\(name): encoder and decoder must agree byte for byte")
            } else {
                let message = try LauncherLineCodec.parseToLauncher(line, rights: rights)
                XCTAssertEqual(try LauncherLineCodec.serialize(message), line, "\(name): encoder and decoder must agree byte for byte")
            }
            seen.insert(vector["t"] as! String)
        }
        XCTAssertEqual(seen, ["hello", "begin", "begun", "volumes", "volumes_accepted", "refused", "worker_state", "mux_down", "mux_up", "stop", "stopped", "uncertain", "receipt_retire", "ping", "pong", "fault"])
    }

    /// Negative vectors whose refusal depends on a mux PAYLOAD. The launcher relays blind (it reads the 16 byte header and nothing
    /// inside), so it is not the endpoint that can refuse them: the daemon and the guest are. Everything else must match exactly.
    private static let payloadLevelLauncherLines: Set<String> = ["mux-down-line-carrying-up-only-bootstrap-type"]

    func testLauncherLineNegativeVectorsFailWithTheContractsCodes() throws {
        let negatives = try XCTUnwrap(try loadVector("launcher-lines.json")["negative"] as? [[String: Any]])
        XCTAssertEqual(negatives.count, 48)
        var blind = 0
        for vector in negatives {
            let name = vector["name"] as! String, line = Array((vector["line"] as! String).utf8), rights = vector["rights"] as! Int
            let got = failure { if (vector["direction"] as! String) == "to-daemon" { _ = try LauncherLineCodec.parseToDaemon(line, rights: rights) } else { _ = try LauncherLineCodec.parseToLauncher(line, rights: rights) } }
            if Self.payloadLevelLauncherLines.contains(name) { XCTAssertNil(got, "\(name) is payload-level: a blind relay accepts it"); blind += 1; continue }
            XCTAssertEqual(got, vector["error"] as? String, name)
        }
        XCTAssertEqual(blind, Self.payloadLevelLauncherLines.count)
    }

    // MARK: mux frames (L3, L4)

    /// Negatives that only a payload parser can refuse (bad JSON inside a control or bootstrap payload, a wrong message type for the
    /// direction, a nested plan that is not protocol 3). Each is accepted by the launcher's header check, by design; the count is pinned.
    func testMuxFrameVectorsHeaderLevel() throws {
        let document = try loadVector("mux-frames.json")
        let positives = try XCTUnwrap(document["positive"] as? [[String: Any]])
        XCTAssertEqual(positives.count, 15)
        for vector in positives {
            let name = vector["name"] as! String, raw = bytes(fromHex: vector["hex"] as! String)
            let header = try MuxFormat.parseFrame(raw)
            XCTAssertEqual(Int(header.seq), vector["seq"] as! Int, name)
            XCTAssertEqual(header.muxClass, MuxClass.allCases.first { String(describing: $0) == vector["class"] as! String }, name)
            XCTAssertEqual(MuxFormat.frame(header.muxClass, seq: header.seq, payload: Array(raw[WireLimits.headerBytes...])), raw, "\(name): frame encoder and decoder must agree byte for byte")
        }
        let negatives = try XCTUnwrap(document["negative"] as? [[String: Any]])
        XCTAssertEqual(negatives.count, 25)
        var headerLevel = 0, payloadLevel: [String] = []
        for vector in negatives {
            let name = vector["name"] as! String
            let got = failure { _ = try MuxFormat.parseFrame(bytes(fromHex: vector["hex"] as! String)) }
            if let got { XCTAssertEqual(got, vector["error"] as? String, name); headerLevel += 1 } else { payloadLevel.append(name) }
        }
        XCTAssertEqual(headerLevel + payloadLevel.count, 25)
        // The split is part of the contract between the relay and its endpoints: pin it so a drift in either direction is visible.
        XCTAssertEqual(payloadLevel.sorted(), Self.expectedPayloadLevelMux.sorted(), "these are refused by the endpoints, not by the relay")
    }
    static let expectedPayloadLevelMux: [String] = [
        "bootstrap-invalid-utf8", "control-duplicate-key", "control-extra-key", "control-float-number", "control-not-json", "control-reordered-keys", "control-unknown-type",
        "control-whitespace", "drain-travelling-up", "hello-wrong-serial", "plan-protocol-2", "plan-travelling-up", "plan-unsorted-nested-keys",
    ]

    // MARK: stop receipts

    func testStopReceiptVectorsByteForByte() throws {
        let document = try loadVector("stop-receipts.json")
        let positives = try XCTUnwrap(document["positive"] as? [[String: Any]])
        XCTAssertEqual(positives.count, 8)
        for vector in positives {
            let name = vector["name"] as! String, text = Array((vector["text"] as! String).utf8)
            let receipt = try StopReceipt.parse(text)
            XCTAssertEqual(try receipt.serialize(), text, "\(name): encoder and decoder must agree byte for byte")
            switch receipt {
            case .orderly(let r): XCTAssertEqual(vector["class"] as? String, "A", name); XCTAssertEqual(r.invariantsHold, vector["invariantsHold"] as? Bool, name)
            case .uncertain: XCTAssertEqual(vector["class"] as? String, "B", name)
            }
        }
        let notOrderly = try XCTUnwrap(document["parsesButNotOrderly"] as? [[String: Any]])
        XCTAssertEqual(notOrderly.count, 7)
        for vector in notOrderly {
            let name = vector["name"] as! String, text = Array((vector["text"] as! String).utf8)
            guard case .orderly(let receipt) = try StopReceipt.parse(text) else { return XCTFail("\(name) is a Class A text") }
            XCTAssertFalse(receipt.invariantsHold, "\(name) parses but is not orderly evidence")
            XCTAssertEqual(try StopReceipt.parse(text).serialize(), text, name)
        }
        let negatives = try XCTUnwrap(document["negative"] as? [[String: Any]])
        XCTAssertEqual(negatives.count, 14)
        for vector in negatives {
            let name = vector["name"] as! String
            XCTAssertEqual(failure { _ = try StopReceipt.parse(Array((vector["text"] as! String).utf8)) }, vector["error"] as? String, name)
        }
    }
}
