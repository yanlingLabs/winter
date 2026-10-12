import XCTest
import WinterProtocol
@testable import WinterKit

final class CoworkClientTests: XCTestCase {
    func testFolderPreparationInventoryRemainsMacLocal() throws {
        for method in ["workspace.capabilities.get", "workspace.selection.prepareFolder", "workspace.selection.revoke"] {
            XCTAssertFalse(Gateway.remoteAllowedMethods.contains(method))
        }
        let request = CoworkRequest<CoworkPreparedFolder>.prepareFolder(bookmark: Data([1, 2, 3]), label: "Fixture", access: "read-only", requestId: "attempt")
        XCTAssertEqual(request.method, "workspace.selection.prepareFolder")
        let params = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request.params)) as! [String: String]
        XCTAssertEqual(params["requestId"], "attempt"); XCTAssertEqual(params["bookmarkBase64"], "AQID")
        XCTAssertNil(params["path"])
    }
    func testTypedOperationCallAndHostRefusalSurviveRPC() async throws {
        let transport = ScriptedTransport()
        let client = WinterClient(makeTransport: { transport }, token: "fixture-token", clientName: "cowork-fixture")
        async let connected: Void = client.connect()
        let hello = decodeLine(try await waitForSent(transport, count: 1)[0])
        transport.feed(#"{"jsonrpc":"2.0","id":\#(hello["id"] as! Int),"result":{"ok":true}}"#)
        try await connected
        defer { Task { await client.close() } }
        async let operation = client.cowork(CoworkRequest<CoworkOperation>.operation(workspaceId: "workspace-fixture", operationId: "operation-fixture"))
        let request = decodeLine(try await waitForSent(transport, count: 2)[1])
        XCTAssertEqual(request["method"] as? String, "workspace.operation.get")
        XCTAssertEqual((request["params"] as? [String: String])?["workspaceId"], "workspace-fixture")
        transport.feed(#"{"jsonrpc":"2.0","id":\#(request["id"] as! Int),"result":{"operationId":"operation-fixture","workspaceId":"workspace-fixture","revision":2,"status":"superseded","terminal":true}}"#)
        let result = try await operation
        XCTAssertEqual(result.status, "superseded"); XCTAssertTrue(result.terminal)
        async let create = client.cowork(CoworkRequest<CoworkReceipt<CoworkWorkspace>>.create(requestId: "create-fixture", ownership: .project, title: "Fixture", selections: [.init(selectionId: "repo-choice", kind: .githubRepository)]))
        let creation = decodeLine(try await waitForSent(transport, count: 3)[2])
        XCTAssertEqual(creation["method"] as? String, "workspace.create")
        transport.feed(#"{"jsonrpc":"2.0","id":\#(creation["id"] as! Int),"error":{"code":-32602,"message":"Cowork request refused","data":{"code":"unsupported_topology"}}}"#)
        do { _ = try await create; XCTFail("production refusal must propagate") }
        catch let error as RpcError { XCTAssertEqual(error.data?["code"]?.stringValue, "unsupported_topology") }
    }

    func testSharedRequestFactoriesUseOpaqueSourceSelectionsAndCanonicalProjectPolicy() throws {
        let request = CoworkRequest<CoworkReceipt<CoworkSource>>.addSource(workspaceId: "workspace-fixture", requestId: "add", expectedRevision: 7, selectionId: "folder-choice", kind: .folder)
        XCTAssertEqual(request.method, "workspace.source.addFolder")
        let encoded = String(decoding: try JSONEncoder().encode(request.params), as: UTF8.self)
        XCTAssertTrue(encoded.contains("selectionId")); XCTAssertFalse(encoded.contains("grantRef")); XCTAssertFalse(encoded.contains("path"))
        let project = CoworkRequest<CoworkReceipt<CoworkPolicyValue>>.setProjectDefaultPolicy(projectId: "project-fixture", requestId: "policy", expectedRevision: 8, policy: .plan)
        XCTAssertEqual(project.method, "project.setDefaultPolicy")
        let empty = try CoworkRequest<CoworkWorkspacePage>.list().decode(.object(["workspaces": .array([]), "nextCursor": .null]))
        XCTAssertTrue(empty.workspaces.isEmpty); XCTAssertNil(empty.nextCursor)
    }

    func testWorkspaceProjectionDecodesEveryCanonicalRecord() throws {
        let json = #"""
        {"workspaceId":"workspace-fixture","ownership":"project","ownerId":"project-fixture","title":"Fixture","state":"retained","configRevision":3,"grantRevision":2,"instructionRevision":1,"leaseEpoch":1,"power":"starting","createdAt":"2026-10-11","updatedAt":"2026-10-11","detailState":"complete","policy":{"policyId":"policy-fixture","workspaceId":"workspace-fixture","defaultPolicy":"plan","publication":"github-only-feature-branches","ceiling":{"toolClasses":["read"],"hostServices":[],"connectors":[],"network":"none"},"revision":2,"defaultRevision":2,"publicationRevision":1},"sources":[{"sourceId":"source-fixture","workspaceId":"workspace-fixture","locationId":"location-fixture","kind":"folder","label":"Selected folder","access":"read-only","desired":"present","state":"unavailable","revision":2,"ackRevision":null,"reason":"access_revoked","restartRequired":true,"trust":"revoked","createdAt":"2026-10-11","updatedAt":"2026-10-11"}],"automaticPublication":false}
        """#
        let value = try JSONDecoder().decode(SessionEvent.JSONValue.self, from: Data(json.utf8))
        let workspace = try CoworkRequest<CoworkWorkspace>.get(workspaceId: "workspace-fixture").decode(value)
        XCTAssertEqual(workspace.detailState, .complete); XCTAssertNil(workspace.policySummary)
        XCTAssertEqual(workspace.policy?.defaultPolicy, .plan)
        XCTAssertEqual(workspace.sources?.first?.reason, "access_revoked")
        XCTAssertNil(workspace.sources?.first?.ackRevision)
        XCTAssertEqual(workspace.sources?.first?.kind, .folder)
        XCTAssertFalse(workspace.automaticPublication)
        XCTAssertEqual(try JSONDecoder().decode(CoworkWorkspace.self, from: JSONEncoder().encode(workspace)), workspace)
    }

    func testSummaryAndPagedRecoveryAreExplicitAndCannotMasqueradeAsCompleteAuthority() throws {
        let json = #"""
        {"workspaceId":"workspace-fixture","ownership":"project","ownerId":"project-fixture","title":"Legacy","state":"retained","configRevision":3,"grantRevision":2,"instructionRevision":1,"leaseEpoch":1,"power":"stopped","createdAt":"2026-10-11","updatedAt":"2026-10-11","detailState":"summary","detailReason":"response_limit","policySummary":{"policyId":"policy-fixture","workspaceId":"workspace-fixture","defaultPolicy":"plan","publication":"manual","revision":2,"defaultRevision":1,"publicationRevision":1,"network":"internet","capabilityCounts":{"toolClasses":256,"hostServices":256,"connectors":256}},"sourceCount":22,"automaticPublication":false,"detailMethods":{"sources":"workspace.source.list","policy":"workspace.policy.get"}}
        """#
        let workspace = try JSONDecoder().decode(CoworkWorkspace.self, from: Data(json.utf8))
        XCTAssertEqual(workspace.detailState, .summary); XCTAssertEqual(workspace.detailReason, "response_limit")
        XCTAssertNil(workspace.policy); XCTAssertNil(workspace.sources)
        XCTAssertEqual(workspace.sourceCount, 22); XCTAssertEqual(workspace.policySummary?.capabilityCounts.toolClasses, 256)
        XCTAssertEqual(workspace.detailMethods?.policy, "workspace.policy.get")
        XCTAssertEqual(try JSONDecoder().decode(CoworkWorkspace.self, from: JSONEncoder().encode(workspace)), workspace)
        XCTAssertThrowsError(try JSONDecoder().decode(CoworkWorkspace.self, from: Data(json.replacingOccurrences(of: "\"detailState\":\"summary\"", with: "\"detailState\":\"complete\"").utf8)))
        XCTAssertThrowsError(try JSONDecoder().decode(CoworkWorkspace.self, from: Data(json.replacingOccurrences(of: "\"sourceCount\":22", with: "\"sourceCount\":22,\"sources\":[]").utf8)))
        let request = CoworkRequest<CoworkPolicyPage>.policy(workspaceId: workspace.workspaceId, cursor: "2:100", limit: 25, expectedRevision: 2)
        XCTAssertEqual(request.method, "workspace.policy.get")
        let params = String(decoding: try JSONEncoder().encode(request.params), as: UTF8.self)
        XCTAssertTrue(params.contains("2:100")); XCTAssertTrue(params.contains("expectedRevision"))
        let policyJson = #"""
        {"policy":{"policyId":"policy-fixture","workspaceId":"workspace-fixture","defaultPolicy":"plan","publication":"manual","revision":2,"defaultRevision":1,"publicationRevision":1,"network":"internet","capabilityCounts":{"toolClasses":256,"hostServices":256,"connectors":256}},"entries":[{"kind":"toolClasses","name":"read"}],"nextCursor":"2:101"}
        """#
        let page = try request.decode(JSONDecoder().decode(SessionEvent.JSONValue.self, from: Data(policyJson.utf8)))
        XCTAssertEqual(page.entries.first?.name, "read"); XCTAssertEqual(page.nextCursor, "2:101")
        XCTAssertEqual(CoworkRequest<CoworkSourceList>.listSources(workspaceId: workspace.workspaceId, cursor: "3:1", limit: 1, expectedRevision: 3).method, "workspace.source.list")
    }

    func testConservativeInnerBudgetFitsTheFullyEncodedPairedEnvelope() throws {
        // Base64's worst slash escaping is included by encoding the actual WireEnvelope.
        let inner = Data(repeating: 0xFF, count: 128 * 1024 + 256)
        let envelope = WireEnvelope(v: 1, pairingEpoch: 1, hostID: String(repeating: "h", count: 200), sessionID: nil, streamID: nil, seq: nil, kind: .rpcResponse, timestamp: 1, payload: inner)
        XCTAssertLessThanOrEqual(try WireFrame.encode(envelope).count, 512 * 1024)
    }
    func testPolicyMutationReceiptsDiscriminateCompleteAndBoundedRecoveryValues() throws {
        let complete = #"""
        {"operationId":"operation-fixture","workspaceId":"workspace-fixture","revision":2,"value":{"detailState":"complete","policyId":"policy-fixture","workspaceId":"workspace-fixture","defaultPolicy":"plan","publication":"manual","ceiling":{"toolClasses":["read"],"hostServices":[],"connectors":[],"network":"none"},"revision":2,"defaultRevision":1,"publicationRevision":2}}
        """#
        let summary = #"""
        {"operationId":"operation-fixture","workspaceId":"workspace-fixture","revision":2,"value":{"detailState":"summary","detailReason":"response_limit","detailMethod":"workspace.policy.get","policySummary":{"policyId":"policy-fixture","workspaceId":"workspace-fixture","defaultPolicy":"plan","publication":"manual","revision":2,"defaultRevision":1,"publicationRevision":2,"network":"none","capabilityCounts":{"toolClasses":256,"hostServices":256,"connectors":256}}}}
        """#
        let request = CoworkRequest<CoworkReceipt<CoworkPolicyValue>>.setPublicationPolicy(workspaceId: "workspace-fixture", requestId: "narrow", expectedRevision: 1, publication: .manual)
        XCTAssertEqual(request.method, "workspace.setPublicationPolicy")
        let decoder = JSONDecoder()
        let full = try request.decode(decoder.decode(SessionEvent.JSONValue.self, from: Data(complete.utf8)))
        guard case let .complete(policy) = full.value else { return XCTFail("Expected complete policy authority details") }
        XCTAssertEqual(policy.ceiling.toolClasses, ["read"])
        let bounded = try request.decode(decoder.decode(SessionEvent.JSONValue.self, from: Data(summary.utf8)))
        guard case let .summary(metadata) = bounded.value else { return XCTFail("Expected explicit bounded mutation summary") }
        XCTAssertEqual(metadata.network, "none"); XCTAssertEqual(metadata.publication, .manual); XCTAssertEqual(metadata.capabilityCounts.connectors, 256)
        for receipt in [full, bounded] { XCTAssertEqual(try decoder.decode(CoworkReceipt<CoworkPolicyValue>.self, from: JSONEncoder().encode(receipt)), receipt) }
        let confused = summary.replacingOccurrences(of: "\"detailReason\":\"response_limit\"", with: "\"detailReason\":\"response_limit\",\"ceiling\":{}")
        XCTAssertThrowsError(try decoder.decode(CoworkReceipt<CoworkPolicyValue>.self, from: Data(confused.utf8)))
        let incomplete = summary.replacingOccurrences(of: "\"detailState\":\"summary\"", with: "\"detailState\":\"complete\"")
        XCTAssertThrowsError(try decoder.decode(CoworkReceipt<CoworkPolicyValue>.self, from: Data(incomplete.utf8)))
    }
}
