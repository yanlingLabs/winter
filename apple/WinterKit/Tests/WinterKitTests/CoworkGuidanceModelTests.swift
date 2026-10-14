import XCTest
import CryptoKit
@testable import WinterKit
import WinterProtocol

/// Async fake transport only. Not run under the current Swift/native/test-host hold.
@MainActor final class CoworkGuidanceModelTests: XCTestCase {
    private final class Host {
        /// `journalFailed`: the NEXT update fails like a journaled operation that could not finish; the
        /// host then answers `recovery_required` forever to that request ID, while a new one proceeds.
        enum SaveMode: Equatable { case normal, lostBeforeCommit, lostAfterCommit, conflict, malformedReceipt, journalFailed }
        var calls: [(String, SessionEvent.JSONValue)] = []
        var contents = ["one": "Canonical guidance", "two": "Other workspace guidance"]
        var revisions = ["one": 1, "two": 1]
        var saveMode = SaveMode.normal
        var unreadable = false
        /// A one-shot `error.data.code` the next update is refused with, before any write.
        var refuseNextUpdate: String?
        var updateUnsupported = false
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
            case "workspace.get":
                return try json(["workspaceId": id, "ownership": "project", "ownerId": "project-" + id, "title": id,
                    "state": "retained", "configRevision": revisions[id]!, "grantRevision": 1, "instructionRevision": revisions[id]!,
                    "leaseEpoch": 0, "power": "stopped", "createdAt": "fixture", "updatedAt": "fixture", "automaticPublication": false,
                    "detailState": "summary", "detailReason": "response_limit", "sourceCount": 0, "policySummary": policy(id),
                    "detailMethods": ["sources": "workspace.source.list", "policy": "workspace.policy.get"]])
            case "workspace.source.list": return try json(["sources": [], "nextCursor": NSNull()])
            case "workspace.policy.get": return try json(["policy": policy(id), "entries": [], "nextCursor": NSNull()])
            case "workspace.capabilities.get": return try json(["folderPreparation": false, "repositoryPreparation": false, "provisioning": false, "execution": false])
            case "workspace.list": return try json(["workspaces": [], "nextCursor": NSNull()])
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
                if saveMode == .conflict || fields["expectedInstructionRevision"] as? Int != revisions[id]
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
    func testStrictReadRefusesMalformedEncodingBoundsBytesDigestAndForeignMetadata() async {
        let invalid = Data([0xc3, 0x28])
        let host = Host(); let validBytes = Data(host.contents["one"]!.utf8)
        let cases: [[String: Any]] = [
            ["contentBase64": invalid.base64EncodedString(), "bytes": invalid.count, "digest": host.digest(invalid)],
            ["contentBase64": " \n" + validBytes.base64EncodedString()], ["contentBase64": String(repeating: "A", count: 87_388)],
            ["bytes": validBytes.count + 1], ["bytes": 65_537], ["digest": String(repeating: "0", count: 64)],
            ["encoding": "utf-16"], ["workspaceId": "two"], ["instructionRevision": 0], ["refreshState": "ready"],
            ["contentBase64": Data([0]).base64EncodedString(), "bytes": 1, "digest": host.digest(Data([0]))],
        ]
        for fields in cases {
            host.readOverride = fields
            let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
            XCTAssertNil(model.guidance?.draft); XCTAssertFalse(model.guidance?.available ?? true)
            XCTAssertNotNil(model.guidance?.message); await model.saveInstructions()
        }
        XCTAssertTrue(host.updates.isEmpty)
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
