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
        XCTAssertEqual(pins["sourceBranch"] as? String, "cowork/output-integration", "the vectors are read from the integration branch, where the contract was merged")
        XCTAssertEqual((pins["lastCommitTouchingVectors"] as? String)?.count, 40)
        let hashes = try XCTUnwrap(pins["sha256"] as? [String: String])
        XCTAssertEqual(Set(hashes.keys), ["bootstrap-order.json", "envelopes.json", "guest-stop.json", "launcher-lines.json", "mux-frames.json", "runtime-flow.json", "runtime-image.json", "stop-receipts.json"])
        for (name, expected) in hashes {
            let actual = SHA256.hash(data: try Data(contentsOf: vectorURL(name))).map { String(format: "%02x", $0) }.joined()
            XCTAssertEqual(actual, expected, "\(name) differs from the S1 copy it is pinned to")
        }
    }

    // MARK: envelopes (L2)

    func testEnvelopeVectorsByteForByte() throws {
        let document = try loadVector("envelopes.json")
        let positives = try XCTUnwrap(document["positive"] as? [[String: Any]])
        XCTAssertEqual(positives.count, 28)
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
        XCTAssertEqual(negatives.count, 30)
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
        XCTAssertEqual(positives.count, 32)
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

    /// Foundation's JSON reader drops a U+FEFF that opens a string value, which is exactly the byte-order mark the `bom-*` vectors are about.
    /// The file holds it as the three bytes EF BB BF right after `"line": "`, so they are put back from the file's own bytes.
    private func lineBytes(_ vector: [String: Any], rawFile: Data) -> [UInt8] {
        let name = vector["name"] as! String, bytes = Array((vector["line"] as! String).utf8)
        guard name.hasPrefix("bom-") else { return bytes }
        XCTAssertNotNil(rawFile.range(of: Data(Array("\"line\": \"".utf8) + [0xef, 0xbb, 0xbf] + Array("{".utf8))), "the vector file still opens \(name) with a byte-order mark")
        return [0xef, 0xbb, 0xbf] + bytes
    }

    func testLauncherLineNegativeVectorsFailWithTheContractsCodes() throws {
        let rawFile = try Data(contentsOf: vectorURL("launcher-lines.json"))
        let negatives = try XCTUnwrap(try loadVector("launcher-lines.json")["negative"] as? [[String: Any]])
        XCTAssertEqual(negatives.count, 63)
        var blind = 0
        for vector in negatives {
            let name = vector["name"] as! String, line = lineBytes(vector, rawFile: rawFile), rights = vector["rights"] as! Int
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
        XCTAssertEqual(positives.count, 36)
        for vector in positives {
            let name = vector["name"] as! String, raw = bytes(fromHex: vector["hex"] as! String)
            let header = try MuxFormat.parseFrame(raw)
            XCTAssertEqual(Int(header.seq), vector["seq"] as! Int, name)
            XCTAssertEqual(header.muxClass, MuxClass.allCases.first { String(describing: $0) == vector["class"] as! String }, name)
            XCTAssertEqual(MuxFormat.frame(header.muxClass, seq: header.seq, payload: Array(raw[WireLimits.headerBytes...])), raw, "\(name): frame encoder and decoder must agree byte for byte")
        }
        let negatives = try XCTUnwrap(document["negative"] as? [[String: Any]])
        XCTAssertEqual(negatives.count, 109)
        var headerLevel = 0, payloadLevel: [String] = []
        for vector in negatives {
            let name = vector["name"] as! String
            let got = failure { _ = try MuxFormat.parseFrame(bytes(fromHex: vector["hex"] as! String)) }
            if let got { XCTAssertEqual(got, vector["error"] as? String, name); headerLevel += 1 } else { payloadLevel.append(name) }
        }
        XCTAssertEqual(headerLevel + payloadLevel.count, 109)
        // The split is part of the contract between the relay and its endpoints: pin it so a drift in either direction is visible.
        XCTAssertEqual(payloadLevel.sorted(), Self.expectedPayloadLevelMux.sorted(), "these are refused by the endpoints, not by the relay")
    }
    static let expectedPayloadLevelMux: [String] = [
    "bom-mux", "bom-mux-bootstrap", "bootstrap-fault-unknown-code", "bootstrap-invalid-utf8", "control-duplicate-key", "control-extra-key",
    "control-fault-missing-nonce-key", "control-fault-travelling-down", "control-fault-unknown-code", "control-fault-uppercase-nonce", "control-float-number",
    "control-not-json", "control-reordered-keys", "control-unknown-type", "control-whitespace", "conversations-binding-not-uuid4",
    "conversations-boot-ids-differ-across-items", "conversations-duplicate-backend-session", "conversations-duplicate-logical-session", "conversations-empty-list",
    "conversations-extra-key-in-item", "conversations-generation-zero", "conversations-gid-equals-a-runtime-uid", "conversations-gid-equals-a-tool-uid",
    "conversations-gid-nobody", "conversations-guided-profile-without-binding", "conversations-host-query-plan-writable", "conversations-host-query-sees-the-winter-tree",
    "conversations-id-too-long", "conversations-mixed-lease-epoch", "conversations-mixed-workspace", "conversations-no-roots", "conversations-non-ascii-model",
    "conversations-over-the-message-cap", "conversations-plain-profile-with-binding", "conversations-policy-unknown", "conversations-profile-null-but-runtime-present",
    "conversations-profile-present-but-runtime-absent", "conversations-provider-boot-id-not-a-uuid", "conversations-provider-credential-key",
    "conversations-provider-model-differs", "conversations-provider-over-4k", "conversations-provider-scope-key-missing", "conversations-provider-scope-other-backend",
    "conversations-provider-scope-other-epoch", "conversations-provider-scope-other-grant", "conversations-provider-scope-other-session",
    "conversations-provider-selection-extra-key", "conversations-provider-selection-key-missing", "conversations-provider-unsorted-keys",
    "conversations-provider-url-key", "conversations-root-dotdot", "conversations-root-empty-component", "conversations-root-folders-without-name",
    "conversations-root-ids-repeat", "conversations-root-outputs-of-another-session", "conversations-root-relative", "conversations-root-source-outside-workspace",
    "conversations-root-view-not-allowed", "conversations-root-views-nested", "conversations-runtime-uid-equals-tool-uid", "conversations-seventeen-items",
    "conversations-timeout-fraction", "conversations-timeout-over-ten-minutes", "conversations-timeout-zero", "conversations-tool-class-unknown",
    "conversations-tool-classes-repeat", "conversations-tool-classes-unordered", "conversations-travelling-up", "conversations-two-host-query-conversations",
    "conversations-uid-65535", "conversations-uid-above-65535", "conversations-uid-and-gid-as-strings", "conversations-uid-below-1000", "conversations-uid-nobody-65534",
    "conversations-uid-reused-across-items", "conversations-unknown-profile", "conversations-wrong-incarnation-in-item", "conversations-wrong-incarnation-in-message",
    "drain-travelling-up", "hello-wrong-serial", "plan-protocol-2", "plan-travelling-up", "plan-unsorted-nested-keys", "runtime-conversation-sixteen",
    "runtime-empty-without-end", "runtime-flags-two", "runtime-prefix-too-short", "runtime-ready-seventeen-conversations", "runtime-ready-travelling-down",
    "runtime-ready-zero-conversations", "runtime-reserved-nonzero", "runtime-stderr-travelling-down", "runtime-stdin-travelling-up", "runtime-stdout-travelling-down",
    "runtime-stream-four", "runtime-stream-zero",
    ]

    // MARK: the runtime image digest (the launcher recomputes it)

    func testRuntimeImageDigestVectors() throws {
        let document = try loadVector("runtime-image.json")
        let positives = try XCTUnwrap(document["positive"] as? [[String: Any]])
        XCTAssertEqual(positives.count, 2)
        for vector in positives {
            XCTAssertEqual(RuntimeImageDigest.combine(kernelSha256: vector["kernelSha256"] as! String, initramfsSha256: vector["initramfsSha256"] as! String), vector["runtimeImageDigest"] as? String, vector["name"] as! String)
        }
        // Order matters, and a part that is not a lowercase hex digest is not a digest.
        XCTAssertNotEqual(positives[0]["runtimeImageDigest"] as? String, positives[1]["runtimeImageDigest"] as? String)
        XCTAssertNil(RuntimeImageDigest.combine(kernelSha256: "AB", initramfsSha256: positives[0]["initramfsSha256"] as! String))
    }

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
        XCTAssertEqual(notOrderly.count, 12)
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

    // MARK: the guest's part of a stop (guest-stop.json)

    private static let statusNames: [String: WorkerStatus] = ["sandboxed": .sandboxed, "volumes_accepted": .volumesAccepted, "vm_running": .vmRunning, "guest_hello": .guestHello, "draining": .draining,
        "drain_acked": .drainAcked, "halting": .halting, "guest_halted": .guestHalted, "guest_fault": .guestFault, "exiting": .exiting]
    private func guestStopCases() throws -> [(name: String, states: [WorkerStatus], reason: LibkrunExitReason?, counters: [FlushDevice]?, verdict: GuestStopVerdict)] {
        let document = try loadVector("guest-stop.json")
        let reasons = try XCTUnwrap(document["exitReasons"] as? [String: Int])
        XCTAssertEqual(reasons, ["none": 0, "off": 1, "reset": 2, "vcpu-error": 3, "terminal-fault": 4], "libkrun's exit reasons, as uint32_t")
        return try XCTUnwrap(document["cases"] as? [[String: Any]]).map { vector in
            let states = (vector["states"] as! [String]).map { Self.statusNames[$0]! }
            let reason = (vector["exitReason"] as? String).map { LibkrunExitReason(rawValue: $0)! }
            let counters = (vector["counters"] as? [[String: Int]])?.map { FlushDevice(requested: UInt64($0["requested"]!), completed: UInt64($0["completed"]!), finalSyncAttempted: UInt64($0["finalSyncAttempted"]!), finalSyncCompleted: UInt64($0["finalSyncCompleted"]!)) }
            let v = vector["verdict"] as! [String: String]
            let verdict: GuestStopVerdict = v["guest"] == "orderly" ? .orderly : v["guest"] == "not-booted" ? .notBooted : .uncertain(UncertainReason(rawValue: v["reason"]!)!)
            return (vector["name"] as! String, states, reason, counters, verdict)
        }
    }
    func testGuestStopVerdictAgreesWithEveryVectorExactly() throws {
        let cases = try guestStopCases()
        XCTAssertEqual(cases.count, 29)
        XCTAssertTrue(cases.contains { $0.name == "guest-halted-after-mux-quarantine" && $0.verdict == .uncertain(.guestFault) })
        XCTAssertTrue(cases.contains { $0.name == "guest-halted-without-drain-ack" && $0.verdict == .uncertain(.guestFault) })
        for c in cases { XCTAssertEqual(GuestStop.verdict(states: c.states, exitReason: c.reason, counters: c.counters), c.verdict, c.name) }
        XCTAssertEqual(cases.filter { $0.verdict == .orderly }.map(\.name), ["orderly"], "exactly one vector is orderly")
    }
    /// What the LAUNCHER sees: no exit reason and no final-sync flags, only the statuses. The worker reports `guest_halted` only for reason `off` with both
    /// final syncs completed, so a vector where it would not have reported it is replayed without that status. The class (orderly, not booted, uncertain)
    /// must be the vector's; only a reason code may differ.
    /// Orders the vectors do not exercise, decided by the contract's function: the drain ack before the drain, and the power-off report before `halting`.
    func testStatusOrdersTheVectorsDoNotCoverStillCannotBeOrderly() {
        let full = [FlushDevice(requested: 3, completed: 3, finalSyncAttempted: 1, finalSyncCompleted: 1), FlushDevice(requested: 3, completed: 3, finalSyncAttempted: 1, finalSyncCompleted: 1)]
        XCTAssertEqual(GuestStop.verdict(states: [.vmRunning, .drainAcked, .draining, .halting, .guestHalted], exitReason: .off, counters: full), .uncertain(.guestFault))
        XCTAssertEqual(GuestStop.verdict(states: [.vmRunning, .draining, .drainAcked, .guestHalted, .halting], exitReason: .off, counters: full), .uncertain(.flushUncertain))
        XCTAssertEqual(GuestStop.verdict(states: [.vmRunning, .draining, .drainAcked, .halting, .guestHalted], exitReason: .off, counters: full), .orderly)
        // The stricter rules of contract round 3b: the VM runs before it drains; the flush counts are EQUAL (more completed than requested is an invented flush); exactly two disks.
        XCTAssertEqual(GuestStop.verdict(states: [.draining, .vmRunning, .drainAcked, .halting, .guestHalted], exitReason: .off, counters: full), .uncertain(.guestFault))
        var invented = full; invented[0].completed = 4
        XCTAssertEqual(GuestStop.verdict(states: [.vmRunning, .draining, .drainAcked, .halting, .guestHalted], exitReason: .off, counters: invented), .uncertain(.flushUncertain))
        XCTAssertEqual(GuestStop.verdict(states: [.vmRunning, .draining, .drainAcked, .halting, .guestHalted], exitReason: .off, counters: [full[0]]), .uncertain(.flushUncertain))
        XCTAssertEqual(GuestStop.verdict(states: [.vmRunning, .draining, .drainAcked, .halting, .guestHalted], exitReason: .off, counters: full + [full[0]]), .uncertain(.flushUncertain))
    }
    func testWhatTheLauncherCanSeeReachesTheSameClassAsEveryVector() throws {
        for c in try guestStopCases() {
            var states = c.states
            if c.reason != .off || !GuestStop.flushesComplete(c.counters) { states.removeAll { $0 == .guestHalted } }
            let pair = c.counters.flatMap { $0.count == 2 ? $0 : nil }.map { CounterPair(data: FlushCounters(requested: $0[0].requested, completed: $0[0].completed), environment: FlushCounters(requested: $0[1].requested, completed: $0[1].completed)) }
            let observed = GuestStop.observed(states: states, counters: pair)
            switch (observed, c.verdict) {
            case (.orderly, .orderly), (.notBooted, .notBooted), (.uncertain, .uncertain): break
            default: XCTFail("\(c.name): the launcher concluded \(observed), the vector says \(c.verdict)")
            }
        }
    }
    func testTheStopTimelineValuesAndOrder() {
        XCTAssertEqual(WireLimits.libkrunExitWatchdogMs, 20_000); XCTAssertEqual(WireLimits.launcherKillMarginMs, 5_000); XCTAssertEqual(WireLimits.hostStopMarginMs, 10_000)
        XCTAssertEqual(WireLimits.launcherKillMs(budgetMs: 30_000), 55_000); XCTAssertEqual(WireLimits.hostStopWaitMs(budgetMs: 30_000), 65_000)
        for budget in [0, 1_000, 30_000, WireLimits.drainBudgetCeilingMs] {
            XCTAssertGreaterThan(WireLimits.launcherKillMs(budgetMs: budget), budget + WireLimits.libkrunExitWatchdogMs, "the kill is later than anything the exit watchdog could still do")
            XCTAssertGreaterThan(WireLimits.hostStopWaitMs(budgetMs: budget), WireLimits.launcherKillMs(budgetMs: budget))
        }
    }

    // MARK: what the relay does NOT decide: bootstrap order and the runtime IN bound

    /// `bootstrap-order.json` and `runtime-flow.json` are rules for the ENDPOINTS (the host sender and the guest). The launcher relays L3 blind: it checks a frame's header
    /// (class, ceiling, length, per-class sequence) and nothing inside it, so it carries every transcript, mis-ordered ones included. Pinned so that a launcher that
    /// started to judge order or flow (a second, divergent oracle) would fail here.
    func testTheRelayCarriesEveryBootstrapTranscriptAndEveryRuntimeFlowStepWithoutJudgingThem() throws {
        let order = try XCTUnwrap(try loadVector("bootstrap-order.json")["cases"] as? [[String: Any]])
        XCTAssertEqual(order.count, 16)
        var misordered = 0
        for transcript in order {
            if ((transcript["result"] as! [String: Any])["ok"] as? Bool) == false { misordered += 1 }
            for (index, event) in (transcript["events"] as! [[String: Any]]).enumerated() {
                let frame = MuxFormat.frame(.bootstrap, seq: UInt32(index + 1), payload: Array("{\"v\":1,\"t\":\"\(event["t"] as! String)\"}\n".utf8))
                XCTAssertEqual(try MuxFormat.parseRelayable(frame).muxClass, .bootstrap, "\(transcript["name"] as! String) / \(event["t"] as! String)")
            }
        }
        XCTAssertGreaterThanOrEqual(misordered, 8, "the transcripts include orders the relay must still carry")
        let flow = try loadVector("runtime-flow.json")
        XCTAssertEqual(flow["limitBytes"] as? Int, 1_048_576)
        let cases = try XCTUnwrap(flow["cases"] as? [[String: Any]])
        XCTAssertEqual(cases.count, 13)
        var refused = 0
        for c in cases {
            if c["refusedAt"] as? Int != nil { refused += 1 }
            for (index, step) in (c["steps"] as! [[String: Any]]).enumerated() {
                let stream: UInt8 = ["in": 1, "out": 2, "err": 3][step["stream"] as! String]!
                let data = step["bytes"] as! Int
                let payload = [0, stream, (step["end"] as? Bool) == true ? 1 : 0, 0] + [UInt8](repeating: 0x61, count: data)
                let frame = MuxFormat.frame(.runtime, seq: UInt32(index + 1), payload: payload)
                // The relay's only bound is the class ceiling, prefix included (a sender chunks at 256 KiB); the 1 MiB IN flow bound is not its business.
                if payload.count <= MuxClass.runtime.payloadCeiling { XCTAssertEqual(try MuxFormat.parseRelayable(frame).muxClass, .runtime, c["name"] as! String) }
                else { XCTAssertThrowsError(try MuxFormat.parseRelayable(frame), "a payload over the class ceiling is refused by the header check") }
            }
        }
        XCTAssertGreaterThanOrEqual(refused, 4)
    }

    // MARK: the retained-receipt MAC (stop-receipts.json, macVectors)

    func testReceiptMacVectorsAgreeByteForByte() throws {
        let mac = try XCTUnwrap(try loadVector("stop-receipts.json")["macVectors"] as? [String: Any])
        let keyUtf8 = Array((mac["keyUtf8"] as! String).utf8)
        XCTAssertEqual(keyUtf8.count, 32)
        XCTAssertEqual(bytes(fromHex: mac["keyHex"] as! String), keyUtf8)
        XCTAssertEqual(Data(keyUtf8).base64EncodedString(), mac["keyBase64"] as? String)
        XCTAssertEqual(mac["keyBase64"] as? String, Fixture.receiptKeyBase64, "the fixtures use S1's synthetic key")
        let key = try XCTUnwrap(ReceiptKey(base64: mac["keyBase64"] as! String))
        XCTAssertEqual(key, ReceiptKey(bytes: keyUtf8))
        let positives = try XCTUnwrap(mac["positive"] as? [[String: Any]])
        XCTAssertEqual(positives.count, 4)
        for vector in positives {
            let name = vector["name"] as! String, text = Array((vector["receipt"] as! String).utf8)
            guard case .orderly(let receipt) = try StopReceipt.parse(text) else { return XCTFail("\(name) is Class A") }
            XCTAssertEqual(String(decoding: receipt.macInput(), as: UTF8.self), vector["macInput"] as? String, "\(name): the exact bytes the MAC covers")
            XCTAssertEqual(receipt.mac, vector["macBase64"] as? String, name)
            let tag = try XCTUnwrap(key.mac(receipt.macInput()))
            XCTAssertEqual(Data(tag).base64EncodedString(), vector["macBase64"] as? String, "\(name): HMAC-SHA256, base64")
            XCTAssertEqual(tag.map { String(format: "%02x", $0) }.joined(), vector["macHex"] as? String, name)
            XCTAssertTrue(receipt.macVerifies(under: key), name)
            var unsigned = receipt; unsigned.mac = ""
            XCTAssertEqual(unsigned.signed(with: key), receipt, "\(name): signing the unsigned receipt reproduces the vector")
        }
        let negatives = try XCTUnwrap(mac["negative"] as? [[String: Any]])
        XCTAssertEqual(negatives.count, 11)
        for vector in negatives {
            let name = vector["name"] as! String, expect = vector["expect"] as! String, text = Array((vector["text"] as! String).utf8)
            if expect.hasPrefix("parse:") {
                XCTAssertEqual(failure { _ = try StopReceipt.parse(text) }, String(expect.dropFirst(6)), name)
            } else {
                guard case .orderly(let receipt) = try StopReceipt.parse(text) else { return XCTFail("\(name) is Class A") }
                XCTAssertEqual(receipt.macVerifies(under: key), expect == "mac-valid", name)
            }
        }
    }
}
