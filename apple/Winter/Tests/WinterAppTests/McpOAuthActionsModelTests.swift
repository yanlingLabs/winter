import XCTest
import WinterKit
@testable import Winter

/// WS-25 (MCP OAuth): `McpOAuthActionsModel` — the owning model `LibraryMcpServerDetail` builds
/// per server, wiring the three sheets to a `FakeMcpAuthClient` (no socket/transport).
@MainActor
final class McpOAuthActionsModelTests: XCTestCase {
    /// `client == nil` (no wiring) is a first-class no-op state — every `start…` call is ignored,
    /// no sheet opens, `isUnwired` is `true`.
    func testUnwiredClientMakesEveryStartACallNoOp() {
        let model = McpOAuthActionsModel(client: nil, onAuthChanged: {})
        XCTAssertTrue(model.isUnwired)

        model.startSignIn(serverName: "linear", issuerOriginHint: nil)
        model.startSignOut(serverName: "linear")
        model.startClientSecret(serverName: "linear")

        XCTAssertNil(model.signInSheet)
        XCTAssertNil(model.signOutSheet)
        XCTAssertNil(model.clientSecretSheet)
    }

    /// `startSignIn` opens the sheet SYNCHRONOUSLY (so the sheet shows "Starting sign-in…"
    /// immediately) and fires `mcp.login` off as its own task.
    func testStartSignInOpensTheSheetAndCallsLogin() async {
        let fake = FakeMcpAuthClient()
        let model = McpOAuthActionsModel(client: fake, onAuthChanged: {})

        model.startSignIn(serverName: "linear", issuerOriginHint: "https://mcp.linear.app")
        XCTAssertNotNil(model.signInSheet)

        await feedWaitUntil { fake.loginCalls.count == 1 }
        XCTAssertEqual(fake.loginCalls[0].name, "linear")
        model.signInSheet?.cancel()
    }

    /// Closing the sign-in sheet nils it AND re-polls `mcp.list` (item 1's "after every
    /// login/logout" rule) via `onAuthChanged`.
    func testSignInSheetClosedNilsTheSheetAndCallsOnAuthChanged() async {
        let fake = FakeMcpAuthClient()
        var authChangedCount = 0
        let model = McpOAuthActionsModel(client: fake, onAuthChanged: { authChangedCount += 1 })
        model.startSignIn(serverName: "linear", issuerOriginHint: nil)

        model.signInSheetClosed()

        XCTAssertNil(model.signInSheet)
        await feedWaitUntil { authChangedCount == 1 }
    }

    func testSignOutSheetClosedNilsTheSheetAndCallsOnAuthChanged() async {
        let fake = FakeMcpAuthClient()
        var authChangedCount = 0
        let model = McpOAuthActionsModel(client: fake, onAuthChanged: { authChangedCount += 1 })
        model.startSignOut(serverName: "linear")

        model.signOutSheetClosed()

        XCTAssertNil(model.signOutSheet)
        await feedWaitUntil { authChangedCount == 1 }
    }

    /// Closing the client-secret sheet does NOT re-poll — a secret's presence isn't reflected in
    /// `auth` at all, so there is nothing for a re-poll to pick up.
    func testClientSecretSheetClosedDoesNotCallOnAuthChanged() {
        let fake = FakeMcpAuthClient()
        var authChangedCount = 0
        let model = McpOAuthActionsModel(client: fake, onAuthChanged: { authChangedCount += 1 })
        model.startClientSecret(serverName: "github")

        model.clientSecretSheetClosed()

        XCTAssertNil(model.clientSecretSheet)
        XCTAssertEqual(authChangedCount, 0)
    }
}
