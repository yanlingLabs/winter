import XCTest
import WinterProtocol
@testable import WinterKit

final class CoworkClientTests: XCTestCase {
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
        let project = CoworkRequest<CoworkReceipt<CoworkWorkspacePolicy>>.setProjectDefaultPolicy(projectId: "project-fixture", requestId: "policy", expectedRevision: 8, policy: .plan)
        XCTAssertEqual(project.method, "project.setDefaultPolicy")
        let empty = try CoworkRequest<CoworkWorkspacePage>.list().decode(.object(["workspaces": .array([]), "nextCursor": .null]))
        XCTAssertTrue(empty.workspaces.isEmpty); XCTAssertNil(empty.nextCursor)
    }

    func testWorkspaceProjectionDecodesEveryCanonicalRecord() throws {
        let json = #"""
        {"workspaceId":"workspace-fixture","ownership":"project","ownerId":"project-fixture","title":"Fixture","state":"retained","configRevision":3,"grantRevision":2,"instructionRevision":1,"leaseEpoch":1,"power":"starting","createdAt":"2026-10-11","updatedAt":"2026-10-11","policy":{"policyId":"policy-fixture","workspaceId":"workspace-fixture","defaultPolicy":"plan","publication":"github-only-feature-branches","ceiling":{"toolClasses":["read"],"hostServices":[],"connectors":[],"network":"none"},"revision":2,"defaultRevision":2,"publicationRevision":1},"sources":[{"sourceId":"source-fixture","workspaceId":"workspace-fixture","locationId":"location-fixture","kind":"folder","label":"Selected folder","access":"read-only","desired":"present","state":"unavailable","revision":2,"ackRevision":null,"reason":"access_revoked","restartRequired":true,"trust":"revoked","createdAt":"2026-10-11","updatedAt":"2026-10-11"}],"automaticPublication":false}
        """#
        let value = try JSONDecoder().decode(SessionEvent.JSONValue.self, from: Data(json.utf8))
        let workspace = try CoworkRequest<CoworkWorkspace>.get(workspaceId: "workspace-fixture").decode(value)
        XCTAssertEqual(workspace.policy.defaultPolicy, .plan)
        XCTAssertEqual(workspace.sources.first?.reason, "access_revoked")
        XCTAssertNil(workspace.sources.first?.ackRevision)
        XCTAssertEqual(workspace.sources.first?.kind, .folder)
        XCTAssertFalse(workspace.automaticPublication)
        XCTAssertEqual(try JSONDecoder().decode(CoworkWorkspace.self, from: JSONEncoder().encode(workspace)), workspace)
    }

    func testConservativeInnerBudgetFitsTheFullyEncodedPairedEnvelope() throws {
        // Base64's worst slash escaping is included by encoding the actual WireEnvelope.
        let inner = Data(repeating: 0xFF, count: 128 * 1024 + 256)
        let envelope = WireEnvelope(v: 1, pairingEpoch: 1, hostID: String(repeating: "h", count: 200), sessionID: nil, streamID: nil, seq: nil, kind: .rpcResponse, timestamp: 1, payload: inner)
        XCTAssertLessThanOrEqual(try WireFrame.encode(envelope).count, 512 * 1024)
    }
}
