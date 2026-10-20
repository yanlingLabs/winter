import XCTest
@testable import Winter
import WinterProtocol

/// Source-only under the current native/test-host hold; run when Swift validation is admitted.
final class CoworkWorkspaceReducerTests: XCTestCase {
    private func event(_ type: String, _ seq: Int, _ fields: String) throws -> SessionEvent {
        let json = "{\"type\":\"\(type)\",\"seq\":\(seq),\"sessionId\":\"s_one\",\"ts\":0,\"workspaceId\":\"w_one\",\"workspaceChangeId\":\"change_\(seq)\",\"operationId\":\"op_one\",\"workspaceRevision\":3,\(fields)}"
        return try JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
    }

    func testMetadataDoesNotEnableExecutionOrClaimMountedSource() throws {
        var state = OrbSessionState()
        state = SessionReducer.reduce(state, try event("workspace_sources_changed", 2,
            #""phase":"requested","sources":[{"sourceId":"source_one","sourceRevision":2,"desired":"present","state":"unavailable","ackRevision":null,"restartRequired":true,"reason":"access_revoked"}]"#))
        XCTAssertEqual(state.coworkWorkspaces["w_one"]?.sources["source_one"]?.state, "unavailable")
        XCTAssertNil(state.coworkWorkspaces["w_one"]?.sources["source_one"]?.ackRevision)
        XCTAssertFalse(state.turnRunning)
        state = SessionReducer.reduce(state, try event("workspace_policy_changed", 3,
            #""phase":"metadata","defaultPolicy":"plan","policyRevision":2"#))
        XCTAssertEqual(state.coworkWorkspaces["w_one"]?.policy?.phase, "metadata")
        XCTAssertEqual(state.coworkWorkspaces["w_one"]?.refetchRequired, true)
        XCTAssertFalse(state.turnRunning)
    }

    func testReplayKeepsTerminalOperationSeparateFromSourceReadiness() throws {
        var state = OrbSessionState()
        let changed = try event("workspace_operation_changed", 4, #""status":"superseded","terminal":true,"supersededBy":"op_two""#)
        state = SessionReducer.reduce(state, changed)
        state = SessionReducer.reduce(state, changed)
        XCTAssertEqual(state.coworkWorkspaces["w_one"]?.operations.count, 1)
        XCTAssertEqual(state.coworkWorkspaces["w_one"]?.operations["op_one"]?.status, "superseded")
        XCTAssertEqual(state.coworkWorkspaces["w_one"]?.sources.count, 0)
    }
}
