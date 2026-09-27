import XCTest
import WinterKit
@testable import Winter

/// WS-25 (MCP OAuth): `McpClientSecretSheetModel` — the "never retained past submit" secret
/// discipline (mirrors `AnthropicLoginSheetModelTests`'s own `submitCode()` tests exactly).
@MainActor
final class McpClientSecretSheetModelTests: XCTestCase {
    /// The trimmed secret reaches `setClientSecret` exactly once, and the field is cleared
    /// IMMEDIATELY regardless of outcome — never retained in the view model after submit.
    func testSubmitSendsTrimmedSecretOnceAndClearsField() async {
        let fake = FakeMcpAuthClient()
        let model = McpClientSecretSheetModel(client: fake, serverName: "github")
        model.secret = "  shhh-secret  "

        await model.submit()

        XCTAssertEqual(fake.setClientSecretCalls.count, 1)
        XCTAssertEqual(fake.setClientSecretCalls[0].name, "github")
        XCTAssertEqual(fake.setClientSecretCalls[0].secret, "shhh-secret")
        XCTAssertEqual(model.secret, "")
        XCTAssertTrue(model.done)
        XCTAssertNil(model.errorText)
    }

    /// An empty (or whitespace-only) secret never reaches the RPC.
    func testSubmitSkipsRpcWhenFieldIsEmpty() async {
        let fake = FakeMcpAuthClient()
        let model = McpClientSecretSheetModel(client: fake, serverName: "github")
        model.secret = "   "

        await model.submit()

        XCTAssertTrue(fake.setClientSecretCalls.isEmpty)
        XCTAssertFalse(model.done)
    }

    /// A thrown `setClientSecret` surfaces as `errorText` — the field is STILL cleared (the value
    /// was already sent to the wire once; a retained copy would defeat the "never twice" rule this
    /// model exists to enforce).
    func testSubmitErrorSurfacesAsErrorTextAndStillClearsField() async {
        let fake = FakeMcpAuthClient()
        fake.setClientSecretResult = .failure(FakeMcpAuthClient.SimpleError())
        let model = McpClientSecretSheetModel(client: fake, serverName: "github")
        model.secret = "wrong-secret"

        await model.submit()

        XCTAssertNotNil(model.errorText)
        XCTAssertEqual(model.secret, "")
        XCTAssertFalse(model.done)
    }
}
