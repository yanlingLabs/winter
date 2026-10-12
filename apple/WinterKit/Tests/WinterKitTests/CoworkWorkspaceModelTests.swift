import XCTest
@testable import WinterKit
import WinterProtocol

@MainActor final class CoworkWorkspaceModelTests: XCTestCase {
    private final class Host {
        var calls: [(String, SessionEvent.JSONValue)] = []
        var failMutation = false, failDetail = false, repeatCursor = false
        var revision = 1
        func json(_ value: [String: Any]) throws -> SessionEvent.JSONValue {
            try JSONDecoder().decode(SessionEvent.JSONValue.self, from: JSONSerialization.data(withJSONObject: value))
        }
        var policy: [String: Any] {
            ["policyId": "policy", "workspaceId": "workspace", "defaultPolicy": "auto", "publication": "manual", "revision": revision, "defaultRevision": 1, "publicationRevision": 1, "network": "none", "capabilityCounts": ["toolClasses": 0, "hostServices": 0, "connectors": 0]]
        }
        var source: [String: Any] {
            ["sourceId": "source", "workspaceId": "workspace", "locationId": "location", "kind": "folder", "label": "Fixture", "access": "read-write", "desired": "present", "state": "preparing", "revision": revision, "ackRevision": NSNull(), "reason": NSNull(), "restartRequired": false, "trust": "untrusted", "createdAt": "fixture", "updatedAt": "fixture"]
        }
        var workspace: [String: Any] {
            ["workspaceId": "workspace", "ownership": "project", "ownerId": "project", "title": "Fixture", "state": "retained", "configRevision": revision, "grantRevision": revision, "instructionRevision": revision, "leaseEpoch": 0, "power": "stopped", "createdAt": "fixture", "updatedAt": "fixture", "automaticPublication": false, "detailState": "summary", "detailReason": "response_limit", "sourceCount": 1, "policySummary": policy, "detailMethods": ["sources": "workspace.source.list", "policy": "workspace.policy.get"]]
        }
        func call(_ method: String, _ params: SessionEvent.JSONValue) throws -> SessionEvent.JSONValue {
            calls.append((method, params))
            switch method {
            case "workspace.list": return try json(["workspaces": [workspace], "nextCursor": repeatCursor ? "repeated" : NSNull()])
            case "workspace.get":
                if failDetail { throw NSError(domain: "fixture", code: 1) }
                return try json(workspace)
            case "workspace.source.list": return try json(["sources": [source], "nextCursor": NSNull()])
            case "workspace.policy.get": return try json(["policy": policy, "entries": [], "nextCursor": NSNull()])
            case "workspace.operation.get": return try json(["operationId": "operation", "workspaceId": "workspace", "revision": revision, "status": "pending", "terminal": false])
            default:
                if failMutation { throw NSError(domain: "lost-response", code: 1) }
                revision += 1
                var value = workspace
                if method == "project.create" || method == "workspace.create" {
                    value = workspace; value["detailState"] = "complete"
                    ["detailReason", "sourceCount", "policySummary", "detailMethods"].forEach { value.removeValue(forKey: $0) }
                    value["sources"] = [source]
                    var full = policy; full.removeValue(forKey: "network"); full.removeValue(forKey: "capabilityCounts")
                    full["ceiling"] = ["toolClasses": [], "hostServices": [], "connectors": [], "network": "none"] as [String: Any]
                    value["policy"] = full
                } else if method.hasPrefix("workspace.source.") { value = source }
                else { ["automaticPublication", "detailState", "detailReason", "sourceCount", "policySummary", "detailMethods"].forEach { value.removeValue(forKey: $0) } }
                return try json(["operationId": "operation", "workspaceId": "workspace", "revision": revision, "value": value])
            }
        }
        func params(_ method: String) throws -> [[String: Any]] {
            try calls.filter { $0.0 == method }.map { try JSONSerialization.jsonObject(with: JSONEncoder().encode($0.1)) as! [String: Any] }
        }
    }
    func testSummaryLoadsRealSourcesAndPolicyWithBoundRevision() async throws {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }
        await model.refresh(); await model.select("workspace")
        XCTAssertNil(model.error); XCTAssertEqual(model.workspaces.count, 1)
        XCTAssertEqual(model.sources.count, 1); XCTAssertEqual(model.sources.first?.state, "preparing")
        XCTAssertEqual(model.policy?.defaultPolicy, .auto)
        XCTAssertEqual(try host.params("workspace.policy.get").first?["expectedRevision"] as? Int, 1)
        XCTAssertEqual(try host.params("workspace.source.list").first?["expectedRevision"] as? Int, 1)
        XCTAssertFalse(host.calls.contains { $0.0.hasPrefix("session.") })
    }
    func testCursorLoopFailsWithoutPublishingPartialList() async {
        let host = Host(); host.repeatCursor = true
        let model = CoworkWorkspaceModel { try host.call($0, $1) }
        await model.refresh()
        XCTAssertNotNil(model.error); XCTAssertTrue(model.workspaces.isEmpty); XCTAssertFalse(model.busy)
    }
    func testLostResponseRetainsRequestIdentityAndExpectedRevision() async throws {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }
        await model.select("workspace"); host.failMutation = true
        await model.rename("Renamed"); await model.rename("Renamed")
        let calls = try host.params("workspace.update")
        XCTAssertEqual(calls.count, 2); XCTAssertEqual(calls[0]["requestId"] as? String, calls[1]["requestId"] as? String)
        XCTAssertEqual(calls[0]["expectedRevision"] as? Int, 1); XCTAssertNotNil(model.error)
    }
    func testCommittedMutationSurvivesRefreshFailureAndRefreshCanRecover() async {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }
        await model.select("workspace"); host.failDetail = true
        await model.rename("Renamed")
        XCTAssertEqual(model.operation?.status, "recorded"); XCTAssertFalse(model.operation?.terminal ?? true)
        XCTAssertTrue(model.error?.hasPrefix("Change recorded") == true); XCTAssertNil(model.selected)
        host.failDetail = false; await model.refresh()
        XCTAssertEqual(model.selected?.configRevision, 2); XCTAssertNil(model.error)
    }
    func testLastSourceCanBeRevokedWithoutClaimingReady() async throws {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }
        await model.select("workspace")
        await model.remove(try XCTUnwrap(model.sources.first), revoke: true)
        XCTAssertEqual(try host.params("workspace.source.revoke").count, 1)
        XCTAssertEqual(model.sources.first?.state, "preparing"); XCTAssertEqual(model.operation?.status, "pending")
        XCTAssertFalse(host.calls.contains { $0.0.hasPrefix("session.") })
    }
    func testProjectCreationUsesOpaqueSelectionsAndRealReceipt() async throws {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }
        await model.create(title: "Reusable", ownership: .project, selections: [.init(selectionId: "selected", kind: .folder)])
        XCTAssertNil(model.error); XCTAssertEqual(model.selected?.workspaceId, "workspace")
        let request = try XCTUnwrap(host.params("project.create").first)
        XCTAssertEqual(request["title"] as? String, "Reusable")
        XCTAssertEqual((request["selections"] as? [[String: String]])?.first, ["kind": "folder", "selectionId": "selected"])
        XCTAssertNil(request["path"]); XCTAssertEqual(model.operation?.status, "pending")
    }
    func testAdditionUsesExpectedRevisionAndDoesNotExposePath() async throws {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }
        await model.select("workspace"); await model.add(.init(selectionId: "repo-selection", kind: .githubRepository))
        let request = try XCTUnwrap(host.params("workspace.source.addRepository").first)
        XCTAssertEqual(request["expectedRevision"] as? Int, 1)
        XCTAssertEqual(request["selectionId"] as? String, "repo-selection"); XCTAssertNil(request["url"])
    }
    func testCommittedCreateRetryPreservesItsRequestIdAfterReadFailure() async throws {
        let host = Host(); host.failDetail = true
        let model = CoworkWorkspaceModel { try host.call($0, $1) }
        let selections = [CoworkSelection(selectionId: "selection", kind: .folder)]
        await model.create(title: "Reusable", ownership: .project, selections: selections)
        XCTAssertTrue(model.lastMutationRecorded); XCTAssertTrue(model.error?.hasPrefix("Change recorded") == true)
        await model.create(title: "Reusable", ownership: .project, selections: selections)
        let requests = try host.params("project.create")
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0]["requestId"] as? String, requests[1]["requestId"] as? String)
    }
    func testConcurrentCreateIsSerializedWhileReceiptIsInFlight() async {
        let host = Host()
        var resume: CheckedContinuation<Void, Never>?
        let model = CoworkWorkspaceModel { method, params in
            if method == "project.create" { await withCheckedContinuation { resume = $0 } }
            return try host.call(method, params)
        }
        let selections = [CoworkSelection(selectionId: "selection", kind: .folder)]
        let first = Task { await model.create(title: "Reusable", ownership: .project, selections: selections) }
        while resume == nil { await Task.yield() }
        await model.create(title: "Reusable", ownership: .project, selections: selections)
        XCTAssertTrue(model.busy); XCTAssertTrue(host.calls.isEmpty)
        resume?.resume(); await first.value
        XCTAssertEqual(host.calls.filter { $0.0 == "project.create" }.count, 1)
        XCTAssertFalse(model.busy)
    }
    func testInvalidCreationNeverCallsDaemon() async {
        let host = Host(); let model = CoworkWorkspaceModel { try host.call($0, $1) }
        await model.create(title: "Valid", ownership: .standalone, selections: [])
        await model.create(title: "bad\nlabel", ownership: .standalone, selections: [.init(selectionId: "selection", kind: .folder)])
        XCTAssertTrue(host.calls.isEmpty)
    }
}
