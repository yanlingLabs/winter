import XCTest
import WinterKit
@testable import Winter

/// WS-25 (MCP OAuth): `McpSignOutSheetModel` against `FakeMcpAuthClient` — no socket/transport.
@MainActor
final class McpSignOutSheetModelTests: XCTestCase {
    /// `forgetClient` reaches `logout(name:forgetClient:)` exactly as the toggle left it.
    func testConfirmSendsTheForgetClientToggleAsSet() async {
        let fake = FakeMcpAuthClient()
        let model = McpSignOutSheetModel(client: fake, serverName: "linear")
        model.forgetClient = true

        await model.confirm()

        XCTAssertEqual(fake.logoutCalls.count, 1)
        XCTAssertEqual(fake.logoutCalls[0].name, "linear")
        XCTAssertEqual(fake.logoutCalls[0].forgetClient, true)
        XCTAssertTrue(model.done)
        XCTAssertNil(model.errorText)
    }

    /// Leaving the toggle at its default `false` is indistinguishable, wire-side, from never
    /// having shown it — same value the daemon would apply on its own (`McpAuthClient.logout`'s
    /// header note); this test pins that `false` really is sent, not silently dropped.
    func testConfirmDefaultsForgetClientToFalse() async {
        let fake = FakeMcpAuthClient()
        let model = McpSignOutSheetModel(client: fake, serverName: "linear")

        await model.confirm()

        XCTAssertEqual(fake.logoutCalls[0].forgetClient, false)
    }

    func testConfirmFailureSurfacesErrorTextAndLeavesDoneFalse() async {
        let fake = FakeMcpAuthClient()
        fake.logoutResult = .failure(FakeMcpAuthClient.SimpleError())
        let model = McpSignOutSheetModel(client: fake, serverName: "linear")

        await model.confirm()

        XCTAssertNotNil(model.errorText)
        XCTAssertFalse(model.done)
    }

    /// A TYPED refusal (e.g. `mcp_server_not_found`) is mapped through `mcpAuthErrorText` instead
    /// of the generic "couldn't sign out" sentence.
    func testConfirmUsesTheTypedErrorTextWhenTheCodeIsRecognized() async {
        let fake = FakeMcpAuthClient()
        fake.logoutResult = .failure(RpcError(code: -1, message: "gone",
                                               data: .object(["code": .string("mcp_server_not_found")])))
        let model = McpSignOutSheetModel(client: fake, serverName: "linear")

        await model.confirm()

        XCTAssertEqual(model.errorText, "this server isn't configured")
    }

    /// A second `confirm()` while the first is still "in flight" (modeled here by checking the
    /// guard synchronously) never double-submits.
    func testConfirmGuardsAgainstDoubleSubmitFlagged() async {
        let fake = FakeMcpAuthClient()
        let model = McpSignOutSheetModel(client: fake, serverName: "linear")
        XCTAssertFalse(model.submitting)
        await model.confirm()
        XCTAssertFalse(model.submitting, "submitting must be reset once the call resolves")
    }
}
