import XCTest
import CryptoKit
@testable import WinterKit
import WinterProtocol

/// Async fake transport only: no daemon, guest, native worker or home.
@MainActor final class CoworkGuidanceModelTests: XCTestCase {
    private final class Host {
        /// `journalFailed`: the NEXT update fails like a journaled operation that could not finish; the
        /// host then answers `recovery_required` forever to that request ID, while a new one proceeds.
        enum SaveMode: Equatable { case normal, lostBeforeCommit, lostAfterCommit, malformedReceipt, journalFailed }
        var calls: [(String, SessionEvent.JSONValue)] = []
        var contents = ["one": "Canonical guidance", "two": "Other workspace guidance"]
        var revisions = ["one": 1, "two": 1]
        var saveMode = SaveMode.normal
        var unreadable = false
        /// A one-shot `error.data.code` the next update is refused with, before any write.
        var refuseNextUpdate: String?
        var updateUnsupported = false
        /// The workspaces `workspace.list` answers with.
        var listed = ["one", "two"]
        private var failedRequests = Set<String>()
        var readOverride: [String: Any] = [:], provenanceOverride: [String: Any] = [:]
        private var receipts: [String: [String: Any]] = [:]
        private var requests: [String: Data] = [:]
        func encoded(_ value: SessionEvent.JSONValue) throws -> Data {
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
            return try encoder.encode(value)
        }
        func digest(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
        func json(_ value: [String: Any]) throws -> SessionEvent.JSONValue {
            try JSONDecoder().decode(SessionEvent.JSONValue.self, from: JSONSerialization.data(withJSONObject: value))
        }
        func refusal(_ code: String) -> RpcError {
            // Wire numbers follow ipc/server.ts: authority_denied is UNAUTHORIZED, a daemon fault is INTERNAL.
            var wire = -32602
            if code == "authority_denied" { wire = -32001 }
            if code == "recovery_required" { wire = -32603 }
            return RpcError(code: wire, message: "Cowork request refused", data: .object(["code": .string(code)]))
        }
        func metadata(_ id: String) -> [String: Any] {
            let bytes = Data(contents[id]!.utf8)
            return ["workspaceId": id, "instructionRevision": revisions[id]!, "digest": digest(bytes), "bytes": bytes.count, "refreshState": "refresh-required"]
        }
        func externalEdit(_ content: String, id: String = "one") { contents[id] = content; revisions[id]! += 1 }
        func call(_ method: String, _ params: SessionEvent.JSONValue) throws -> SessionEvent.JSONValue {
            calls.append((method, params))
            let fields = try JSONSerialization.jsonObject(with: JSONEncoder().encode(params)) as! [String: Any]
            let id = fields["workspaceId"] as? String ?? "one"
            switch method {
            case "workspace.get": return try json(workspace(id))
            case "workspace.source.list": return try json(["sources": [], "nextCursor": NSNull()])
            case "workspace.policy.get": return try json(["policy": policy(id), "entries": [], "nextCursor": NSNull()])
            case "workspace.capabilities.get": return try json(["folderPreparation": false, "repositoryPreparation": false, "provisioning": false, "execution": false])
            case "workspace.list": return try json(["workspaces": listed.map(workspace), "nextCursor": NSNull()])
            case "workspace.instructions.get":
                if unreadable { throw RpcError(code: -32602, message: "Cowork request refused", data: .object(["code": .string("instruction_unavailable")])) }
                var read = metadata(id); read["contentBase64"] = Data(contents[id]!.utf8).base64EncodedString(); read["encoding"] = "utf-8"
                read.merge(readOverride) { _, replacement in replacement }; return try json(read)
            case "workspace.instructions.provenance":
                var value = metadata(id); value["sourceDiscovery"] = "unavailable"
                value["entries"] = [["kind": "workspace", "guestPath": "/workspace/.winter/WINTER.md", "digest": metadata(id)["digest"]!]]
                value.merge(provenanceOverride) { _, replacement in replacement }; return try json(value)
            case "workspace.instructions.update":
                let requestId = fields["requestId"] as! String
                if failedRequests.contains(requestId) { throw refusal("recovery_required") }
                if let receipt = receipts[requestId] {
                    guard requests[requestId] == (try encoded(params)) else { throw RpcError(code: -32602, message: "request conflict") }
                    return try json(receipt)
                }
                if updateUnsupported { throw RpcError(code: -32601, message: "Method not found") }
                if let code = refuseNextUpdate { refuseNextUpdate = nil; throw refusal(code) }
                if saveMode == .lostBeforeCommit { throw NSError(domain: "disconnected", code: 1) }
                if saveMode == .journalFailed { saveMode = .normal; failedRequests.insert(requestId); throw refusal("recovery_required") }
                if fields["expectedInstructionRevision"] as? Int != revisions[id]
                    || fields["expectedDigest"] as? String != metadata(id)["digest"] as? String {
                    throw RpcError(code: -32602, message: "Cowork request refused", data: .object(["code": .string("revision_conflict")]))
                }
                contents[id] = fields["content"] as? String; revisions[id]! += 1
                let receipt: [String: Any] = ["operationId": "operation-" + requestId, "workspaceId": id, "revision": revisions[id]!, "value": metadata(id)]
                receipts[requestId] = receipt; requests[requestId] = try encoded(params)
                let mode = saveMode; saveMode = .normal
                if mode == .lostAfterCommit { throw NSError(domain: "disconnected-after-commit", code: 1) }
                if mode == .malformedReceipt {
                    var malformed = receipt; var value = metadata(id); value["digest"] = String(repeating: "0", count: 64); malformed["value"] = value
                    return try json(malformed)
                }
                return try json(receipt)
            default: throw RpcError(code: -32601, message: "Unexpected fixture method")
            }
        }
        func workspace(_ id: String) -> [String: Any] {
            ["workspaceId": id, "ownership": "project", "ownerId": "project-" + id, "title": id,
             "state": "retained", "configRevision": revisions[id]!, "grantRevision": 1, "instructionRevision": revisions[id]!,
             "leaseEpoch": 0, "power": "stopped", "createdAt": "fixture", "updatedAt": "fixture", "automaticPublication": false,
             "detailState": "summary", "detailReason": "response_limit", "sourceCount": 0, "policySummary": policy(id),
             "detailMethods": ["sources": "workspace.source.list", "policy": "workspace.policy.get"]]
        }
        func policy(_ id: String) -> [String: Any] {
            ["policyId": "policy-" + id, "workspaceId": id, "defaultPolicy": "auto", "publication": "manual", "revision": 1,
             "defaultRevision": 1, "publicationRevision": 1, "network": "none", "capabilityCounts": ["toolClasses": 0, "hostServices": 0, "connectors": 0]]
        }
        var updates: [SessionEvent.JSONValue] { calls.filter { $0.0 == "workspace.instructions.update" }.map(\.1) }
        func updateFields(_ index: Int) throws -> [String: Any] {
            try JSONSerialization.jsonObject(with: JSONEncoder().encode(updates[index])) as! [String: Any]
        }
    }
    func testLoadsActualCanonicalBytesRevisionDigestAndProvenanceWithoutExecution() async throws {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }
        await model.select("one")
        XCTAssertEqual(model.guidance?.draft, host.contents["one"]); XCTAssertEqual(model.guidance?.currentContent, host.contents["one"])
        XCTAssertEqual(model.guidance?.current?.instructionRevision, 1)
        XCTAssertEqual(model.guidance?.current?.digest, host.digest(Data(host.contents["one"]!.utf8)))
        XCTAssertEqual(model.guidance?.provenance?.entries.first?.guestPath, "/workspace/.winter/WINTER.md")
        XCTAssertEqual(model.guidance?.current?.refreshState, "refresh-required")
        XCTAssertFalse(model.guidance?.canSave ?? true); XCTAssertNil(model.error)
        XCTAssertFalse(host.calls.contains { $0.0.hasPrefix("session.") || $0.0.hasPrefix("workspace.create") })
    }
    func testMissingBackingNeverSeedsOrSavesBlankContentAndMetadataStillLoads() async {
        let host = Host(); host.unreadable = true
        let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        XCTAssertEqual(model.selected?.workspaceId, "one"); XCTAssertNil(model.error); XCTAssertNil(model.guidance?.draft)
        model.editInstructions("Invented seed"); await model.saveInstructions()
        XCTAssertTrue(host.updates.isEmpty); XCTAssertFalse(model.guidance?.available ?? true)
        host.unreadable = false; await model.refreshInstructions(); model.editInstructions("Unsaved")
        host.unreadable = true; await model.refreshInstructions()
        XCTAssertEqual(model.guidance?.draft, "Unsaved"); XCTAssertFalse(model.guidance?.canSave ?? true)
    }
    /// A provenance report that agrees with `read` field for field, so that a case which corrupts one read
    /// field trips ONLY the validator named for it and not also the read-versus-provenance cross-check.
    /// `workspaceId` is deliberately not mirrored: the provenance check compares it with the SELECTED id.
    private func mirroring(_ read: [String: Any]) -> [String: Any] {
        var provenance: [String: Any] = [:]
        for key in ["instructionRevision", "digest", "bytes", "refreshState"] { if let value = read[key] { provenance[key] = value } }
        if let digest = read["digest"] { provenance["entries"] = [["kind": "workspace", "guestPath": "/workspace/.winter/WINTER.md", "digest": digest]] }
        return provenance
    }
    /// Selects a workspace the host answers with `host`'s overrides and asserts nothing was published or sendable.
    private func assertRefused(_ host: Host, _ label: String, file: StaticString = #filePath, line: UInt = #line) async {
        let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        XCTAssertNotNil(model.guidance, label, file: file, line: line)
        XCTAssertNil(model.guidance?.draft, label, file: file, line: line); XCTAssertNil(model.guidance?.current, label, file: file, line: line)
        XCTAssertNil(model.guidance?.provenance, label, file: file, line: line)
        XCTAssertFalse(model.guidance?.available ?? true, label, file: file, line: line)
        XCTAssertNotNil(model.guidance?.message, label, file: file, line: line)
        await model.saveInstructions(); XCTAssertTrue(host.updates.isEmpty, label, file: file, line: line)
    }
    /// One read field is wrong per case, everything else is valid, and the provenance report mirrors the
    /// read, so dropping the single validator named in the label turns that case red and no other.
    /// Checked by removing each validator from `decodeInstructions`/`validMetadata` in turn: every one
    /// named below is killed by exactly its own case.
    ///
    /// Six checks have no case of their own, in three groups, because within a group none can be
    /// tripped alone (removing any one of them leaves the test green; removing the whole group turns
    /// `...OverlappingValidators` red):
    /// - the byte-count bounds: `bytes >= 0` and `bytes <= max` in the metadata check, and the decoded
    ///   `count <= max`, are implied by each other once `bytes == decoded count` holds;
    /// - the digest's length and lowercase-hex shape are implied by `digest == sha256(bytes)`, since a
    ///   SHA-256 hex digest is always 64 lowercase hex characters;
    /// - the base64 length cap is implied by the decoded-size and canonical-encoding checks, since a
    ///   canonical encoding of at most 65,536 bytes is at most 87,384 characters.
    func testStrictReadRefusesAFieldThatViolatesExactlyOneValidator() async {
        let valid = Data(Host().contents["one"]!.utf8).base64EncodedString()
        let host0 = Host(); let validCount = host0.contents["one"]!.utf8.count
        let a = Data("A".utf8), invalid = Data([0xc3, 0x28]), nul = Data([0])
        let cases: [(String, [String: Any])] = [
            ("workspaceId is the selected workspace", ["workspaceId": "two"]),
            ("instructionRevision is positive", ["instructionRevision": 0]),
            ("instructionRevision is a safe integer", ["instructionRevision": 9_007_199_254_740_992]),
            ("refreshState is a known state", ["refreshState": "ready"]),
            ("encoding is utf-8", ["encoding": "utf-16"]),
            ("base64 decodes (leading whitespace)", ["contentBase64": " \n" + valid]),
            ("base64 decodes (not base64)", ["contentBase64": "not base64!"]),
            ("base64 is canonical", ["contentBase64": "QR==", "bytes": 1, "digest": host0.digest(a)]),
            ("bytes equals the decoded length", ["bytes": validCount + 1]),
            ("content is valid UTF-8", ["contentBase64": invalid.base64EncodedString(), "bytes": invalid.count, "digest": host0.digest(invalid)]),
            ("content has no NUL", ["contentBase64": nul.base64EncodedString(), "bytes": 1, "digest": host0.digest(nul)]),
            ("digest matches the bytes", ["digest": String(repeating: "0", count: 64)]),
        ]
        for (label, read) in cases {
            let host = Host(); host.readOverride = read; host.provenanceOverride = mirroring(read)
            await assertRefused(host, label)
        }
        // Controls: the same mirroring with VALID values loads, so a case is red because of its one
        // violation and not because the mirroring itself breaks the cross-check.
        for (label, read) in [("another revision", ["instructionRevision": 7] as [String: Any]),
                              ("other content", ["contentBase64": "QQ==", "bytes": 1, "digest": host0.digest(a)])] {
            let host = Host(); host.readOverride = read; host.provenanceOverride = mirroring(read)
            let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
            XCTAssertTrue(model.guidance?.available ?? false, label); XCTAssertNotNil(model.guidance?.draft, label)
        }
    }
    /// Inputs that more than one validator refuses. Each is rejected, but no single validator is
    /// load-bearing for it, so this is breadth, not per-validator strength (see the groups above).
    func testStrictReadAlsoRefusesInputsThatOverlappingValidatorsEachCatch() async {
        let host0 = Host(); let validBytes = Data(host0.contents["one"]!.utf8)
        let big = Data(repeating: 65, count: 65_537)
        let cases: [(String, [String: Any])] = [
            ("bytes above the limit", ["bytes": 65_537]),
            ("negative bytes", ["bytes": -1]),
            ("content above the limit", ["contentBase64": big.base64EncodedString(), "bytes": big.count, "digest": host0.digest(big)]),
            ("base64 above its length cap", ["contentBase64": String(repeating: "A", count: 87_388)]),
            ("short digest", ["digest": String(repeating: "0", count: 63)]),
            ("uppercase digest", ["digest": host0.digest(validBytes).uppercased()]),
            ("non-hex digest", ["digest": String(repeating: "g", count: 64)]),
        ]
        for (label, read) in cases {
            let host = Host(); host.readOverride = read; host.provenanceOverride = mirroring(read)
            await assertRefused(host, label)
        }
    }
    /// The read is valid in every case; one provenance field disagrees with it, or is not the single
    /// workspace entry this build understands.
    func testStrictProvenanceRefusesAFieldThatViolatesExactlyOneCheck() async {
        let zeros = String(repeating: "0", count: 64)
        let host0 = Host(); let digest = host0.digest(Data(host0.contents["one"]!.utf8))
        let good: [String: Any] = ["kind": "workspace", "guestPath": "/workspace/.winter/WINTER.md", "digest": digest]
        func entry(_ field: String, _ value: Any) -> [[String: Any]] { var copy = good; copy[field] = value; return [copy] }
        let cases: [(String, [String: Any])] = [
            ("provenance workspaceId", ["workspaceId": "two"]),
            ("provenance instructionRevision", ["instructionRevision": 99]),
            ("provenance digest", ["digest": zeros]),
            ("provenance bytes", ["bytes": 1]),
            ("provenance refreshState", ["refreshState": "unavailable"]),
            ("provenance sourceDiscovery", ["sourceDiscovery": "available"]),
            ("no entries", ["entries": [] as [[String: Any]]]),
            ("two entries", ["entries": [good, good]]),
            ("entry kind", ["entries": entry("kind", "repository")]),
            ("entry guestPath", ["entries": entry("guestPath", "/workspace/WINTER.md")]),
            ("entry digest", ["entries": entry("digest", zeros)]),
        ]
        for (label, provenance) in cases {
            let host = Host(); host.provenanceOverride = provenance
            await assertRefused(host, label)
        }
        // Control: the untouched report loads.
        let model = CoworkWorkspaceModel { try host0.call($0, $1) }; await model.select("one")
        XCTAssertTrue(model.guidance?.available ?? false); XCTAssertNotNil(model.guidance?.provenance)
    }
    func testProvenanceRaceDoesNotPublishMixedGenerationOrReplaceExistingDraft() async {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        model.editInstructions("Unsaved")
        host.externalEdit("Concurrent edit"); host.provenanceOverride = ["instructionRevision": 99]
        await model.refreshInstructions()
        XCTAssertEqual(model.guidance?.draft, "Unsaved"); XCTAssertEqual(model.guidance?.current?.instructionRevision, 1)
        XCTAssertFalse(model.guidance?.available ?? true); XCTAssertFalse(model.guidance?.canSave ?? true)
        host.provenanceOverride = [:]; await model.refreshInstructions()
        XCTAssertEqual(model.guidance?.currentContent, "Concurrent edit"); XCTAssertTrue(model.guidance?.conflict ?? false)
    }
    func testConflictPreservesDraftUntilExplicitReviewBindsNextSaveToCurrentDigest() async throws {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        model.editInstructions("My draft"); host.externalEdit("Another user's edit"); await model.refreshInstructions()
        XCTAssertEqual(model.guidance?.draft, "My draft"); XCTAssertEqual(model.guidance?.currentContent, "Another user's edit")
        XCTAssertTrue(model.guidance?.conflict ?? false); await model.saveInstructions(); XCTAssertTrue(host.updates.isEmpty)
        model.reviewInstructionConflict(keepDraft: true); await model.saveInstructions()
        let request = try host.updateFields(0)
        XCTAssertEqual(request["expectedInstructionRevision"] as? Int, 2)
        XCTAssertEqual(request["expectedDigest"] as? String, host.digest(Data("Another user's edit".utf8)))
        XCTAssertEqual(request["content"] as? String, "My draft"); XCTAssertEqual(model.guidance?.receipt?.value.instructionRevision, 3)
        XCTAssertFalse(model.guidance?.hasUnsavedChanges ?? true)
    }
    func testConflictFromWriteRetainsDraftAndExplicitCurrentChoiceDiscardsIt() async {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        model.editInstructions("My draft"); host.externalEdit("New canonical"); await model.saveInstructions()
        XCTAssertFalse(model.guidance?.hasUnconfirmedSave ?? true); XCTAssertEqual(model.guidance?.draft, "My draft")
        XCTAssertTrue(model.guidance?.conflict ?? false); XCTAssertFalse(model.guidance?.canSave ?? true)
        // The conflict read fetched the version that won, so it is reviewable without a manual refresh, and the
        // state is a conflict (available), not "unavailable".
        XCTAssertTrue(model.guidance?.available ?? false); XCTAssertEqual(model.guidance?.currentContent, "New canonical")
        model.reviewInstructionConflict(keepDraft: false)
        XCTAssertEqual(model.guidance?.draft, "New canonical"); XCTAssertFalse(model.guidance?.hasUnsavedChanges ?? true)
    }
    func testUseCurrentContentDiscardsADraftOnlyWhenTheDraftExistsNowhereElse() async {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        XCTAssertFalse(model.guidance?.useCurrentDiscardsDraft ?? true, "an untouched draft is the host's content")
        model.editInstructions("My draft"); host.externalEdit("Another user's edit"); await model.refreshInstructions()
        XCTAssertTrue(model.guidance?.conflict ?? false); XCTAssertTrue(model.guidance?.useCurrentDiscardsDraft ?? false)
        // Typed back to exactly the content that would replace it: nothing is lost.
        model.editInstructions("Another user's edit"); XCTAssertFalse(model.guidance?.useCurrentDiscardsDraft ?? true)
        model.editInstructions("My draft"); XCTAssertTrue(model.guidance?.useCurrentDiscardsDraft ?? false)
        // Reviewing against the new version does not make the draft any less the person's own.
        model.reviewInstructionConflict(keepDraft: true); XCTAssertTrue(model.guidance?.useCurrentDiscardsDraft ?? false)
        model.reviewInstructionConflict(keepDraft: false)
        XCTAssertEqual(model.guidance?.draft, "Another user's edit"); XCTAssertFalse(model.guidance?.useCurrentDiscardsDraft ?? true)
    }
    func testAfterAnAbandonThereIsNoBaseSoAnyDifferingDraftCountsAsUnsaved() async throws {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        model.editInstructions("Doomed save"); host.saveMode = .journalFailed; await model.saveInstructions()
        await model.abandonInstructionSave()
        XCTAssertTrue(model.guidance?.conflict ?? false); XCTAssertTrue(model.guidance?.useCurrentDiscardsDraft ?? false)
        model.editInstructions("Canonical guidance"); XCTAssertFalse(model.guidance?.useCurrentDiscardsDraft ?? true)
    }
    func testAChoiceMadeAgainstAVersionAHostChangeHasSinceReplacedSaysSoAndChangesNothing() async throws {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        model.editInstructions("My draft"); host.externalEdit("Another user's edit"); await model.refreshInstructions()
        let seen = try XCTUnwrap(model.guidance?.current)
        host.externalEdit("A third version"); await model.refreshInstructions()
        XCTAssertEqual(model.guidance?.current?.instructionRevision, 3)
        model.reviewInstructionConflict(keepDraft: false, expectedRevision: seen.instructionRevision, expectedDigest: seen.digest)
        XCTAssertEqual(model.guidance?.draft, "My draft"); XCTAssertTrue(model.guidance?.conflict ?? false)
        XCTAssertEqual(model.guidance?.message, "The shared instructions changed while you were deciding. Review the current version and choose again.")
        model.reviewInstructionConflict(keepDraft: false, expectedRevision: 3, expectedDigest: model.guidance?.current?.digest)
        XCTAssertEqual(model.guidance?.draft, "A third version"); XCTAssertNil(model.guidance?.message)
    }
    func testWriteConflictWhoseFollowUpReadFailsStaysAConflictThatNeedsARefresh() async {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        model.editInstructions("My draft"); host.externalEdit("New canonical"); host.unreadable = true; await model.saveInstructions()
        XCTAssertTrue(model.guidance?.conflict ?? false); XCTAssertFalse(model.guidance?.available ?? true)
        XCTAssertEqual(model.guidance?.draft, "My draft"); XCTAssertFalse(model.guidance?.hasUnconfirmedSave ?? true)
        model.reviewInstructionConflict(keepDraft: true); XCTAssertTrue(model.guidance?.conflict ?? false)
        host.unreadable = false; await model.refreshInstructions()
        XCTAssertTrue(model.guidance?.available ?? false); XCTAssertTrue(model.guidance?.conflict ?? false)
        model.reviewInstructionConflict(keepDraft: true); XCTAssertTrue(model.guidance?.canSave ?? false)
    }
    func testLostAppliedResponseRetriesExactCapturedIntentDespiteNewDraft() async throws {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        model.editInstructions("Captured save"); host.saveMode = .lostAfterCommit; await model.saveInstructions()
        XCTAssertTrue(model.guidance?.hasUnconfirmedSave ?? false); XCTAssertNil(model.guidance?.receipt)
        model.editInstructions("A newer unsaved draft"); XCTAssertEqual(model.guidance?.draft, "A newer unsaved draft")
        XCTAssertEqual(model.guidance?.pendingContent, "Captured save"); await model.saveInstructions(); XCTAssertEqual(host.updates.count, 1)
        await model.retryInstructionSave(); XCTAssertEqual(host.updates.count, 2); XCTAssertEqual(try host.encoded(host.updates[0]), try host.encoded(host.updates[1]))
        XCTAssertEqual(model.guidance?.receipt?.value.instructionRevision, 2); XCTAssertEqual(model.guidance?.draft, "A newer unsaved draft")
        XCTAssertTrue(model.guidance?.canSave ?? false); await model.saveInstructions()
        let next = try host.updateFields(2), original = try host.updateFields(0)
        XCTAssertNotEqual(next["requestId"] as? String, original["requestId"] as? String)
        XCTAssertEqual(next["expectedInstructionRevision"] as? Int, 2); XCTAssertEqual(next["content"] as? String, "A newer unsaved draft")
    }
    func testUnappliedSaveSurvivesRefreshAndRetriesExactCapturedIntentDespiteNewDraft() async throws {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        model.editInstructions("Captured save"); host.saveMode = .lostBeforeCommit; await model.saveInstructions()
        model.editInstructions("A newer unsaved draft"); await model.refreshInstructions()
        // The host never applied it (still revision 1): refresh must not settle or drop the pending save.
        XCTAssertTrue(model.guidance?.hasUnconfirmedSave ?? false); XCTAssertEqual(model.guidance?.draft, "A newer unsaved draft")
        XCTAssertEqual(model.guidance?.pendingContent, "Captured save"); await model.saveInstructions(); XCTAssertEqual(host.updates.count, 1)
        host.saveMode = .normal; await model.retryInstructionSave()
        XCTAssertEqual(host.updates.count, 2); XCTAssertEqual(try host.encoded(host.updates[0]), try host.encoded(host.updates[1]))
        XCTAssertEqual(model.guidance?.receipt?.value.instructionRevision, 2); XCTAssertEqual(model.guidance?.draft, "A newer unsaved draft")
        XCTAssertEqual(host.contents["one"], "Captured save")
    }
    func testUnconfirmedSaveAndDraftSurviveWorkspaceNavigationAndReconnectReads() async throws {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        model.editInstructions("Saved later"); host.saveMode = .lostBeforeCommit; await model.saveInstructions()
        model.editInstructions("Later draft"); await model.select("two")
        XCTAssertEqual(model.guidance?.draft, "Other workspace guidance")
        await model.select("one"); await model.refresh()
        XCTAssertEqual(model.guidance?.draft, "Later draft"); XCTAssertEqual(model.guidance?.pendingContent, "Saved later")
        host.saveMode = .normal; await model.retryInstructionSave()
        XCTAssertEqual(try host.encoded(host.updates[0]), try host.encoded(host.updates[1])); XCTAssertEqual(model.guidance?.draft, "Later draft")
    }
    func testRetainedDraftsOfWorkspacesThatLeaveTheListArePrunedButTheSelectedOneIsNeverDroppedUnderTheUser() async {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }
        await model.select("one"); model.editInstructions("Draft one")
        await model.select("two"); model.editInstructions("Draft two")
        // A refresh that still lists both keeps both.
        await model.refresh(); XCTAssertEqual(model.guidance?.draft, "Draft two")
        await model.select("one"); XCTAssertEqual(model.guidance?.draft, "Draft one")
        await model.select("two")
        // "one" leaves the list: its retained draft goes with it and a later visit starts from the host's content.
        host.listed = ["two"]; await model.refresh()
        XCTAssertEqual(model.guidance?.draft, "Draft two")
        await model.select("one"); XCTAssertEqual(model.guidance?.draft, "Canonical guidance")
        // The selected workspace is exempt even when the list no longer names it: edits typed next must land.
        model.editInstructions("Draft one again"); await model.refresh()
        XCTAssertEqual(model.guidance?.draft, "Draft one again")
        model.editInstructions("Draft one, edited after the refresh"); XCTAssertEqual(model.guidance?.draft, "Draft one, edited after the refresh")
        // Once something else is selected the next listing prunes it.
        await model.select("two"); await model.refresh()
        await model.select("one"); XCTAssertEqual(model.guidance?.draft, "Canonical guidance")
    }
    func testAWorkspaceThatLeavesTheListWhileItsSaveIsInFlightKeepsItsEntryUntilTheSaveSettles() async {
        for fails in [false, true] {
            let host = Host(); var resume: CheckedContinuation<Void, Never>?
            if fails { host.refuseNextUpdate = "authority_denied" }
            let model = CoworkWorkspaceModel { method, params in
                if method == "workspace.instructions.update" { await withCheckedContinuation { resume = $0 } }
                return try host.call(method, params)
            }
            await model.select("one"); model.editInstructions("Saved while leaving")
            let saving = Task { await model.saveInstructions() }
            while resume == nil { await Task.yield() }
            // The person moves on, "one" is removed elsewhere, and a listing runs before the save answers.
            await model.select("two"); host.listed = ["two"]; await model.refresh()
            resume?.resume(); await saving.value
            XCTAssertFalse(model.guidanceBusy)
            XCTAssertEqual(model.guidance?.workspaceId, "two")
            XCTAssertEqual(host.contents["one"], fails ? "Canonical guidance" : "Saved while leaving")
            // The settled entry is the retained one: a refused save keeps the draft it refused.
            await model.select("one"); XCTAssertEqual(model.guidance?.draft, "Saved while leaving")
        }
    }
    func testAConflictedSaveWhoseWorkspaceLeavesTheListDuringItsSettlingReadStillRetainsTheDraft() async {
        let host = Host(); var resume: CheckedContinuation<Void, Never>?, parkNextRead = false
        let model = CoworkWorkspaceModel { method, params in
            if method == "workspace.instructions.update" { parkNextRead = true }
            if method == "workspace.instructions.get", parkNextRead { parkNextRead = false; await withCheckedContinuation { resume = $0 } }
            return try host.call(method, params)
        }
        await model.select("one"); model.editInstructions("My draft"); host.externalEdit("Someone else's version")
        let saving = Task { await model.saveInstructions() }
        while resume == nil { await Task.yield() }
        // The save was refused as a conflict; while its read of the winning version is outstanding the
        // person moves on, "one" leaves the list and a listing runs.
        await model.select("two"); host.listed = ["two"]; await model.refresh()
        resume?.resume(); await saving.value
        XCTAssertFalse(model.guidanceBusy)
        await model.select("one")
        XCTAssertEqual(model.guidance?.draft, "My draft"); XCTAssertEqual(model.guidance?.conflict, true)
    }
    func testADirtyDraftWhoseWorkspaceLeavesTheListDuringARefreshOfItsGuidanceIsRetained() async {
        let host = Host(); var resume: CheckedContinuation<Void, Never>?, parkNextRead = false
        let model = CoworkWorkspaceModel { method, params in
            if method == "workspace.instructions.get", parkNextRead { parkNextRead = false; await withCheckedContinuation { resume = $0 } }
            return try host.call(method, params)
        }
        await model.select("one"); model.editInstructions("My draft"); parkNextRead = true
        let refreshing = Task { await model.refreshInstructions() }
        while resume == nil { await Task.yield() }
        // While the refresh's read is outstanding the person moves on, "one" leaves the list and a listing runs.
        await model.select("two"); host.listed = ["two"]; await model.refresh()
        resume?.resume(); await refreshing.value
        XCTAssertFalse(model.guidanceBusy)
        await model.select("one"); XCTAssertEqual(model.guidance?.draft, "My draft")
    }
    func testAQueuedReadKeepsItsWorkspaceEntryWhenTheWorkspaceLeavesTheListWhileThatReadIsOutstanding() async {
        let host = Host(); var parked: [CheckedContinuation<Void, Never>] = [], parkReads = 0
        let model = CoworkWorkspaceModel { method, params in
            if method == "workspace.instructions.get", parkReads > 0 { parkReads -= 1; await withCheckedContinuation { parked.append($0) } }
            return try host.call(method, params)
        }
        await model.select("two"); model.editInstructions("Two draft"); await model.select("one")
        parkReads = 2
        let refreshing = Task { await model.refreshInstructions() }
        while parked.count < 1 { await Task.yield() }
        // Selecting "two" while "one"'s refresh holds the lane queues "two"'s read; it starts when that refresh ends.
        await model.select("two"); parked[0].resume()
        while parked.count < 2 { await Task.yield() }
        // While the queued read is outstanding the person moves back, "two" leaves the list and a listing runs.
        await model.select("one"); host.listed = ["one"]; await model.refresh()
        parked[1].resume(); await refreshing.value
        XCTAssertFalse(model.guidanceBusy)
        await model.select("two"); XCTAssertEqual(model.guidance?.draft, "Two draft")
    }
    func testInFlightSaveCapturesContentAndDoesNotDropSubsequentEditsOrDuplicateWrite() async {
        let host = Host(); var resume: CheckedContinuation<Void, Never>?
        let model = CoworkWorkspaceModel { method, params in
            if method == "workspace.instructions.update" { await withCheckedContinuation { resume = $0 } }
            return try host.call(method, params)
        }
        await model.select("one"); model.editInstructions("Captured")
        let saving = Task { await model.saveInstructions() }
        while resume == nil { await Task.yield() }
        model.editInstructions("Typed while saving"); await model.saveInstructions(); await model.retryInstructionSave()
        XCTAssertTrue(host.updates.isEmpty); XCTAssertTrue(model.guidanceBusy)
        resume?.resume(); await saving.value
        XCTAssertEqual(host.updates.count, 1); XCTAssertEqual(model.guidance?.currentContent, "Captured")
        XCTAssertEqual(model.guidance?.draft, "Typed while saving"); XCTAssertTrue(model.guidance?.hasUnsavedChanges ?? false)
    }
    func testLateGuidanceReadCannotPublishIntoAnotherSelectedWorkspace() async {
        let host = Host(); var parked = false; var resume: CheckedContinuation<Void, Never>?
        let model = CoworkWorkspaceModel { method, params in
            let response = try host.call(method, params)
            if parked && method == "workspace.instructions.get" { await withCheckedContinuation { resume = $0 } }
            return response
        }
        await model.select("one"); model.editInstructions("Retained first draft"); parked = true
        let reading = Task { await model.refreshInstructions() }
        while resume == nil { await Task.yield() }
        await model.select("two")
        XCTAssertEqual(model.selected?.workspaceId, "two"); XCTAssertEqual(model.guidance?.workspaceId, "two")
        parked = false; resume?.resume(); await reading.value
        XCTAssertEqual(model.guidance?.workspaceId, "two"); XCTAssertNotEqual(model.guidance?.draft, "Retained first draft")
        // B was selected while A's read held the lane; A's end ran B's read, with no manual refresh.
        XCTAssertEqual(model.guidance?.draft, "Other workspace guidance"); XCTAssertFalse(model.guidanceBusy)
        await model.select("one"); XCTAssertEqual(model.guidance?.draft, "Retained first draft")
    }
    func testWorkspaceSelectedDuringAnotherWorkspacesSaveReadsItsGuidanceWhenTheSaveEnds() async {
        let host = Host(); var resume: CheckedContinuation<Void, Never>?
        let model = CoworkWorkspaceModel { method, params in
            if method == "workspace.instructions.update" { await withCheckedContinuation { resume = $0 } }
            return try host.call(method, params)
        }
        await model.select("one"); model.editInstructions("First workspace save")
        let saving = Task { await model.saveInstructions() }
        while resume == nil { await Task.yield() }
        let readsBefore = host.calls.filter { $0.0 == "workspace.instructions.get" }.count
        await model.select("two"); await model.select("one"); await model.select("two")
        XCTAssertEqual(host.calls.filter { $0.0 == "workspace.instructions.get" }.count, readsBefore)
        XCTAssertNil(model.guidance?.draft); XCTAssertTrue(model.guidanceBusy)
        resume?.resume(); await saving.value
        XCTAssertFalse(model.guidanceBusy); XCTAssertEqual(model.guidance?.workspaceId, "two")
        XCTAssertEqual(model.guidance?.draft, "Other workspace guidance"); XCTAssertEqual(host.contents["one"], "First workspace save")
        XCTAssertEqual(host.calls.filter { $0.0 == "workspace.instructions.get" }.count, readsBefore + 2)
    }
    func testMalformedReceiptRemainsUnconfirmedUntilExactReplayReturnsValidReceipt() async throws {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        model.editInstructions("Captured"); host.saveMode = .malformedReceipt; await model.saveInstructions()
        XCTAssertTrue(model.guidance?.hasUnconfirmedSave ?? false); XCTAssertNil(model.guidance?.receipt)
        await model.retryInstructionSave(); XCTAssertEqual(try host.encoded(host.updates[0]), try host.encoded(host.updates[1]))
        XCTAssertFalse(model.guidance?.hasUnconfirmedSave ?? true); XCTAssertEqual(model.guidance?.receipt?.value.instructionRevision, 2)
    }
    func testEmptyFileAndExactUtf8LimitAreAcceptedButOversizedAndNulDraftsNeverSend() async {
        let host = Host(); host.contents["one"] = ""
        let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        XCTAssertEqual(model.guidance?.draft, ""); XCTAssertTrue(model.guidance?.available ?? false)
        let exact = String(repeating: "é", count: 32_768)
        model.editInstructions(exact); await model.saveInstructions(); XCTAssertEqual(host.updates.count, 1)
        XCTAssertEqual(model.guidance?.current?.bytes, 65_536)
        model.editInstructions(exact + "é"); await model.saveInstructions()
        model.editInstructions("Has\0NUL"); await model.saveInstructions(); XCTAssertEqual(host.updates.count, 1)
        XCTAssertEqual(model.guidance?.draft, "Has\0NUL"); XCTAssertNotNil(model.guidance?.message)
    }
    func testCanonicallyEquivalentUnicodeDraftRemainsByteDistinctAcrossRefresh() async throws {
        let host = Host(); host.contents["one"] = "\u{e9}"
        let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        model.editInstructions("e\u{301}"); XCTAssertTrue(model.guidance?.hasUnsavedChanges ?? false)
        await model.refreshInstructions()
        XCTAssertEqual(Data(try XCTUnwrap(model.guidance?.draft).utf8), Data("e\u{301}".utf8))
        await model.saveInstructions(); XCTAssertEqual(host.updates.count, 1)
        XCTAssertEqual(model.guidance?.current?.digest, host.digest(Data("e\u{301}".utf8)))
    }
    func testUtf8BomRemainsCanonicalContentAndIsNotStrippedFromItsDigest() async throws {
        let host = Host(); host.contents["one"] = "\u{feff}Guidance"
        let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        XCTAssertTrue(model.guidance?.available ?? false)
        XCTAssertEqual(Data(try XCTUnwrap(model.guidance?.draft).utf8), Data("\u{feff}Guidance".utf8))
        XCTAssertEqual(model.guidance?.current?.digest, host.digest(Data("\u{feff}Guidance".utf8)))
    }
    func testStaleViewActionsCannotEditSaveRebaseOrRetryAnotherWorkspaceOrNewerDraft() async throws {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        let firstDigest = try XCTUnwrap(model.guidance?.current?.digest)
        model.editInstructions("First draft"); await model.select("two"); model.editInstructions("Second draft")
        model.editInstructions("Late first edit", workspaceId: "one")
        await model.saveInstructions(workspaceId: "one", expectedDraft: "First draft", expectedRevision: 1, expectedDigest: firstDigest)
        await model.retryInstructionSave(workspaceId: "one", requestId: "first-pending")
        XCTAssertEqual(model.guidance?.draft, "Second draft"); XCTAssertTrue(host.updates.isEmpty)
        await model.saveInstructions(workspaceId: "two", expectedDraft: "Old second draft")
        await model.saveInstructions(workspaceId: "two", expectedDraft: "Second draft", expectedRevision: 99)
        XCTAssertTrue(host.updates.isEmpty)
        host.externalEdit("Concurrent second version", id: "two"); await model.refreshInstructions()
        model.reviewInstructionConflict(keepDraft: true, workspaceId: "one")
        model.reviewInstructionConflict(keepDraft: true, workspaceId: "two", expectedRevision: 1)
        XCTAssertTrue(model.guidance?.conflict ?? false)
        model.reviewInstructionConflict(keepDraft: true, workspaceId: "two", expectedRevision: 2, expectedDigest: model.guidance?.current?.digest)
        host.saveMode = .lostBeforeCommit; await model.saveInstructions()
        let count = host.updates.count; await model.retryInstructionSave(workspaceId: "two", requestId: "stale-pending")
        XCTAssertEqual(host.updates.count, count); XCTAssertTrue(model.guidance?.hasUnconfirmedSave ?? false)
    }
    func testASaveFromAViewThatDrewAnOlderDraftRevisionOrDigestSaysSoInsteadOfDoingNothing() async throws {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        let digest = try XCTUnwrap(model.guidance?.current?.digest)
        model.editInstructions("Current draft")
        await model.saveInstructions(expectedDraft: "The draft the view drew")
        XCTAssertEqual(model.guidance?.message, "The draft changed before it could be saved. Review it and save again.")
        // That message is about the draft, so the next edit supersedes it.
        model.editInstructions("Current draft, edited"); XCTAssertNil(model.guidance?.message)
        await model.saveInstructions(expectedDraft: "Current draft, edited", expectedRevision: 99)
        XCTAssertEqual(model.guidance?.message, "The shared instructions changed before this save. Review them and save again.")
        model.editInstructions("Current draft, edited again")
        await model.saveInstructions(expectedDraft: "Current draft, edited again", expectedRevision: 1, expectedDigest: String(repeating: "0", count: 64))
        XCTAssertEqual(model.guidance?.message, "The shared instructions changed before this save. Review them and save again.")
        XCTAssertTrue(host.updates.isEmpty); XCTAssertFalse(model.guidance?.hasUnconfirmedSave ?? true)
        XCTAssertEqual(model.guidance?.draft, "Current draft, edited again"); XCTAssertTrue(model.guidance?.canSave ?? false)
        // The matching request still saves, and its first act retires the message.
        await model.saveInstructions(expectedDraft: "Current draft, edited again", expectedRevision: 1, expectedDigest: digest)
        XCTAssertEqual(host.updates.count, 1); XCTAssertNil(model.guidance?.message)
    }
    func testRecoveryRequiredForeverIsEscapedByAbandoningAndTheDraftSurvives() async throws {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        model.editInstructions("Doomed save"); host.saveMode = .journalFailed; await model.saveInstructions()
        XCTAssertTrue(model.guidance?.hasUnconfirmedSave ?? false); XCTAssertNil(model.guidance?.receipt)
        let doomed = try XCTUnwrap(try host.updateFields(0)["requestId"] as? String)
        // Retrying the same request ID can never resolve: the host answers recovery_required forever.
        await model.retryInstructionSave(); await model.retryInstructionSave()
        XCTAssertEqual(host.updates.count, 3); XCTAssertTrue(model.guidance?.hasUnconfirmedSave ?? false)
        XCTAssertEqual(try host.updateFields(2)["requestId"] as? String, doomed)
        XCTAssertFalse(model.guidance?.canSave ?? true); await model.saveInstructions(); XCTAssertEqual(host.updates.count, 3)
        model.editInstructions("Doomed save, then more")
        await model.abandonInstructionSave()
        XCTAssertFalse(model.guidance?.hasUnconfirmedSave ?? true); XCTAssertNil(model.guidance?.pendingContent)
        XCTAssertEqual(model.guidance?.draft, "Doomed save, then more"); XCTAssertTrue(model.guidance?.hasUnsavedChanges ?? false)
        // The host never applied it, yet a review is still required before anything is sent.
        XCTAssertTrue(model.guidance?.conflict ?? false); XCTAssertTrue(model.guidance?.available ?? false)
        XCTAssertEqual(model.guidance?.currentContent, "Canonical guidance"); XCTAssertNotNil(model.guidance?.message)
        XCTAssertFalse(model.guidance?.canSave ?? true); await model.saveInstructions(); XCTAssertEqual(host.updates.count, 3)
        await model.refreshInstructions(); XCTAssertTrue(model.guidance?.conflict ?? false); XCTAssertFalse(model.guidance?.canSave ?? true)
        model.reviewInstructionConflict(keepDraft: true); XCTAssertTrue(model.guidance?.canSave ?? false)
        await model.saveInstructions()
        XCTAssertEqual(host.updates.count, 4)
        let fresh = try host.updateFields(3)
        XCTAssertNotEqual(fresh["requestId"] as? String, doomed); XCTAssertEqual(fresh["content"] as? String, "Doomed save, then more")
        XCTAssertEqual(fresh["expectedInstructionRevision"] as? Int, 1); XCTAssertEqual(host.contents["one"], "Doomed save, then more")
        XCTAssertFalse(model.guidance?.hasUnconfirmedSave ?? true); XCTAssertEqual(model.guidance?.receipt?.value.instructionRevision, 2)
    }
    func testAbandonStillSettlesASaveTheHostHadAlreadyAppliedAndOnlyActsOnItsOwnRequest() async throws {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        model.editInstructions("Applied after all"); host.saveMode = .lostAfterCommit; await model.saveInstructions()
        await model.abandonInstructionSave(workspaceId: "one", requestId: "someone-elses-request")
        XCTAssertTrue(model.guidance?.hasUnconfirmedSave ?? false)
        await model.abandonInstructionSave(workspaceId: "two"); XCTAssertTrue(model.guidance?.hasUnconfirmedSave ?? false)
        await model.abandonInstructionSave(requestId: model.guidance?.pendingRequestId)
        // The abandon's own refresh found the content applied, so it is settled, not discarded into a conflict.
        XCTAssertFalse(model.guidance?.hasUnconfirmedSave ?? true); XCTAssertFalse(model.guidance?.conflict ?? true)
        XCTAssertEqual(model.guidance?.current?.instructionRevision, 2); XCTAssertEqual(model.guidance?.draft, "Applied after all")
        XCTAssertFalse(model.guidance?.hasUnsavedChanges ?? true); XCTAssertEqual(host.updates.count, 1)
    }
    func testAbandonIsRefusedWhileTheSettlingReadFailsAndTheSavePendingSurvivesIt() async throws {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        model.editInstructions("Maybe applied"); host.saveMode = .lostAfterCommit; await model.saveInstructions()
        let pendingId = try XCTUnwrap(model.guidance?.pendingRequestId)
        host.unreadable = true; await model.abandonInstructionSave()
        // Nothing is known about the save: it stays pending, byte for byte, and no review is forced on a stale base.
        XCTAssertTrue(model.guidance?.hasUnconfirmedSave ?? false); XCTAssertEqual(model.guidance?.pendingRequestId, pendingId)
        XCTAssertEqual(model.guidance?.pendingContent, "Maybe applied"); XCTAssertEqual(model.guidance?.draft, "Maybe applied")
        XCTAssertFalse(model.guidance?.conflict ?? true); XCTAssertFalse(model.guidance?.available ?? true)
        XCTAssertTrue(model.guidance?.message?.contains("not abandoned") ?? false); XCTAssertFalse(model.guidanceBusy)
        // The same refusal on every attempt.
        await model.abandonInstructionSave(); XCTAssertEqual(model.guidance?.pendingRequestId, pendingId)
        XCTAssertEqual(host.updates.count, 1)
        // Once the host can be read the abandon works: here the read finds the save applied and settles it.
        host.unreadable = false; await model.abandonInstructionSave()
        XCTAssertFalse(model.guidance?.hasUnconfirmedSave ?? true); XCTAssertFalse(model.guidance?.conflict ?? true)
        XCTAssertEqual(model.guidance?.current?.instructionRevision, 2); XCTAssertEqual(model.guidance?.draft, "Maybe applied")
    }
    func testAbandonAfterASuccessfulReadStillForgetsAnUnappliedSaveAndForcesAReview() async throws {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        model.editInstructions("Never applied"); host.saveMode = .lostBeforeCommit; await model.saveInstructions()
        host.unreadable = true; await model.abandonInstructionSave()
        XCTAssertTrue(model.guidance?.hasUnconfirmedSave ?? false)
        host.unreadable = false; await model.abandonInstructionSave()
        XCTAssertFalse(model.guidance?.hasUnconfirmedSave ?? true); XCTAssertTrue(model.guidance?.conflict ?? false)
        XCTAssertEqual(model.guidance?.draft, "Never applied"); XCTAssertFalse(model.guidance?.canSave ?? true)
    }
    func testAbandonWithNoPendingSaveDoesNothing() async {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        model.editInstructions("Plain draft"); let reads = host.calls.count
        await model.abandonInstructionSave()
        XCTAssertEqual(host.calls.count, reads); XCTAssertEqual(model.guidance?.draft, "Plain draft"); XCTAssertFalse(model.guidance?.conflict ?? true)
    }
    func testDefinitiveRefusalsClearThePendingSaveKeepTheDraftAndEachNameTheirOwnCause() async throws {
        var messages = Set<String>()
        for code in ["authority_denied", "invalid_request", "not_found", "unsupported_topology", "request_conflict"] {
            let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
            model.editInstructions("Refused draft"); host.refuseNextUpdate = code; await model.saveInstructions()
            XCTAssertEqual(host.updates.count, 1, code)
            XCTAssertFalse(model.guidance?.hasUnconfirmedSave ?? true, code); XCTAssertEqual(model.guidance?.draft, "Refused draft", code)
            let message = try XCTUnwrap(model.guidance?.message, code)
            XCTAssertFalse(message.localizedCaseInsensitiveContains("retry"), code); messages.insert(message)
            // Nothing is pending, so a retry of the dead request ID is impossible and a fresh save is allowed.
            await model.retryInstructionSave(); XCTAssertEqual(host.updates.count, 1, code)
            XCTAssertTrue(model.guidance?.canSave ?? false, code); await model.saveInstructions()
            XCTAssertEqual(host.updates.count, 2, code)
            let first = try host.updateFields(0)["requestId"] as? String, second = try host.updateFields(1)["requestId"] as? String
            XCTAssertNotEqual(first, second, code); XCTAssertEqual(host.contents["one"], "Refused draft", code)
        }
        XCTAssertEqual(messages.count, 5)
    }
    func testRefusalMessageAboutTheDraftClearsOnTheNextEdit() async {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        model.editInstructions("Refused draft"); host.refuseNextUpdate = "invalid_request"; await model.saveInstructions()
        XCTAssertNotNil(model.guidance?.message); model.editInstructions("Refused draft, fixed"); XCTAssertNil(model.guidance?.message)
    }
    func testDaemonWithoutTheUpdateMethodIsADefinitiveRefusalNotAnUnconfirmedSave() async {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        model.editInstructions("Draft for an old daemon"); host.updateUnsupported = true; await model.saveInstructions()
        XCTAssertFalse(model.guidance?.hasUnconfirmedSave ?? true); XCTAssertEqual(model.guidance?.draft, "Draft for an old daemon")
        XCTAssertNotNil(model.guidance?.message); XCTAssertEqual(host.updates.count, 1)
    }
    func testUnknownAndTransportFailuresKeepThePendingSaveAndNeverClaimItWasRefused() async {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        model.editInstructions("Maybe applied"); host.saveMode = .lostBeforeCommit; await model.saveInstructions()
        XCTAssertTrue(model.guidance?.hasUnconfirmedSave ?? false); XCTAssertEqual(model.guidance?.pendingContent, "Maybe applied")
        XCTAssertTrue(model.guidance?.message?.contains("abandon") ?? false); XCTAssertTrue(model.guidance?.message?.contains("Retry") ?? false)
        XCTAssertTrue(model.guidance?.available ?? false)
    }
    func testRefreshSettlesAnUnconfirmedSaveTheHostAlreadyAppliedWithoutInventingAReceipt() async throws {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        model.editInstructions("Applied behind the scenes"); host.saveMode = .lostAfterCommit; await model.saveInstructions()
        XCTAssertTrue(model.guidance?.hasUnconfirmedSave ?? false)
        await model.refreshInstructions()
        XCTAssertFalse(model.guidance?.hasUnconfirmedSave ?? true); XCTAssertNil(model.guidance?.receipt)
        XCTAssertEqual(model.guidance?.current?.instructionRevision, 2); XCTAssertFalse(model.guidance?.conflict ?? true)
        XCTAssertEqual(model.guidance?.draft, "Applied behind the scenes"); XCTAssertFalse(model.guidance?.hasUnsavedChanges ?? true)
        XCTAssertNotNil(model.guidance?.message); XCTAssertEqual(host.updates.count, 1)
        // Nothing left to retry, and a later edit is a normal save against the settled revision.
        await model.retryInstructionSave(); XCTAssertEqual(host.updates.count, 1)
        model.editInstructions("Next version"); await model.saveInstructions()
        XCTAssertEqual(try host.updateFields(1)["expectedInstructionRevision"] as? Int, 2)
    }
    func testSettledSaveKeepsAnEditTypedAfterItAsAnUnsavedDraftAgainstTheSavedBase() async throws {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        model.editInstructions("Applied"); host.saveMode = .lostAfterCommit; await model.saveInstructions()
        model.editInstructions("Applied, then edited"); await model.refreshInstructions()
        XCTAssertFalse(model.guidance?.hasUnconfirmedSave ?? true); XCTAssertEqual(model.guidance?.draft, "Applied, then edited")
        XCTAssertTrue(model.guidance?.hasUnsavedChanges ?? false); XCTAssertFalse(model.guidance?.conflict ?? true)
        XCTAssertTrue(model.guidance?.canSave ?? false); await model.saveInstructions()
        XCTAssertEqual(try host.updateFields(1)["expectedInstructionRevision"] as? Int, 2)
        XCTAssertEqual(host.contents["one"], "Applied, then edited")
    }
    func testRefreshDoesNotSettleASaveWhenTheHostChangedForSomeoneElseOrChangedAgain() async {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        model.editInstructions("Mine"); host.saveMode = .lostBeforeCommit; await model.saveInstructions()
        // Revision 2 is what the save would have produced, but with someone else's bytes.
        host.externalEdit("Someone else's bytes"); await model.refreshInstructions()
        XCTAssertTrue(model.guidance?.hasUnconfirmedSave ?? false); XCTAssertTrue(model.guidance?.conflict ?? false)
        // Same bytes as the save, but two revisions on: not "exactly applied once", so still unconfirmed.
        host.externalEdit("Mine"); await model.refreshInstructions()
        XCTAssertTrue(model.guidance?.hasUnconfirmedSave ?? false); XCTAssertTrue(model.guidance?.conflict ?? false)
        XCTAssertEqual(model.guidance?.current?.instructionRevision, 3)
    }
    func testReceiptBannerClearsOnEditAndOnRefreshButSurvivesTheReadThatFollowsItsOwnSave() async {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        model.editInstructions("First"); await model.saveInstructions()
        XCTAssertEqual(model.guidance?.receipt?.value.instructionRevision, 2)
        model.editInstructions("Second"); XCTAssertNil(model.guidance?.receipt)
        await model.saveInstructions(); XCTAssertEqual(model.guidance?.receipt?.value.instructionRevision, 3)
        await model.refreshInstructions(); XCTAssertNil(model.guidance?.receipt)
        model.editInstructions("Third"); await model.saveInstructions(); XCTAssertNotNil(model.guidance?.receipt)
        await model.refresh(); XCTAssertNil(model.guidance?.receipt)
    }
    func testOversizeDraftMessageClearsOnEditButUnconfirmedSaveExplanationDoesNot() async {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        model.editInstructions(String(repeating: "é", count: 32_769)); await model.saveInstructions()
        XCTAssertNotNil(model.guidance?.message); XCTAssertTrue(host.updates.isEmpty)
        model.editInstructions("Short again"); XCTAssertNil(model.guidance?.message)
        host.saveMode = .lostBeforeCommit; await model.saveInstructions()
        let explanation = model.guidance?.message; XCTAssertNotNil(explanation); XCTAssertTrue(model.guidance?.hasUnconfirmedSave ?? false)
        model.editInstructions("Short again, more"); XCTAssertEqual(model.guidance?.message, explanation)
    }
}
