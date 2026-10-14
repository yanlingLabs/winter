import XCTest
import CryptoKit
@testable import WinterKit
import WinterProtocol

/// Async fake transport only. Not run under the current Swift/native/test-host hold.
@MainActor final class CoworkGuidanceModelTests: XCTestCase {
    private final class Host {
        enum SaveMode: Equatable { case normal, lostBeforeCommit, lostAfterCommit, conflict, malformedReceipt }
        var calls: [(String, SessionEvent.JSONValue)] = []
        var contents = ["one": "Canonical guidance", "two": "Other workspace guidance"]
        var revisions = ["one": 1, "two": 1]
        var saveMode = SaveMode.normal
        var unreadable = false
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
                if let receipt = receipts[requestId] {
                    guard requests[requestId] == (try encoded(params)) else { throw RpcError(code: -32602, message: "request conflict") }
                    return try json(receipt)
                }
                if saveMode == .lostBeforeCommit { throw NSError(domain: "disconnected", code: 1) }
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
        await model.refreshInstructions(); model.reviewInstructionConflict(keepDraft: false)
        XCTAssertEqual(model.guidance?.draft, "New canonical"); XCTAssertFalse(model.guidance?.hasUnsavedChanges ?? true)
    }
    func testLostAppliedResponseSurvivesRefreshAndRetriesExactCapturedIntentDespiteNewDraft() async throws {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }; await model.select("one")
        model.editInstructions("Captured save"); host.saveMode = .lostAfterCommit; await model.saveInstructions()
        XCTAssertTrue(model.guidance?.hasUnconfirmedSave ?? false); XCTAssertNil(model.guidance?.receipt)
        model.editInstructions("A newer unsaved draft"); await model.refreshInstructions()
        XCTAssertTrue(model.guidance?.hasUnconfirmedSave ?? false); XCTAssertEqual(model.guidance?.draft, "A newer unsaved draft")
        XCTAssertEqual(model.guidance?.pendingContent, "Captured save"); await model.saveInstructions(); XCTAssertEqual(host.updates.count, 1)
        await model.retryInstructionSave(); XCTAssertEqual(host.updates.count, 2); XCTAssertEqual(try host.encoded(host.updates[0]), try host.encoded(host.updates[1]))
        XCTAssertEqual(model.guidance?.receipt?.value.instructionRevision, 2); XCTAssertEqual(model.guidance?.draft, "A newer unsaved draft")
        XCTAssertTrue(model.guidance?.canSave ?? false); await model.saveInstructions()
        let next = try host.updateFields(2), original = try host.updateFields(0)
        XCTAssertNotEqual(next["requestId"] as? String, original["requestId"] as? String)
        XCTAssertEqual(next["expectedInstructionRevision"] as? Int, 2); XCTAssertEqual(next["content"] as? String, "A newer unsaved draft")
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
        await model.refreshInstructions(); XCTAssertEqual(model.guidance?.draft, "Other workspace guidance")
        await model.select("one"); XCTAssertEqual(model.guidance?.draft, "Retained first draft")
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
}
