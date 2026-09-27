import XCTest
import WinterKit
@testable import Winter

/// WS-25 (MCP OAuth), polish round 3: `McpClientSecretSheetModel`'s two-step flow —
/// `clientSecretIssuer` confirmed BEFORE the SecureField ever shows, `setClientSecret`'s
/// `expectedIssuer` carrying that confirmation, and the "never retained past submit" secret
/// discipline (mirrors `AnthropicLoginSheetModelTests`'s own `submitCode()` tests). No socket/
/// transport — `FakeMcpAuthClient` only.
@MainActor
final class McpClientSecretSheetModelTests: XCTestCase {
    // MARK: - start() / confirmIssuer()

    /// `start()` calls the READ-ONLY `mcp.clientSecretIssuer` and moves to `.confirmIssuer` with
    /// its full issuer — never touching the SecureField phase yet.
    func testStartMovesToConfirmIssuerWithTheLookupResult() async {
        let fake = FakeMcpAuthClient()
        fake.clientSecretIssuerResult = .success(McpClientSecretIssuer(
            name: "github", issuer: "https://github.example/issuer",
            issuerOrigin: "https://github.example", authorizeOrigin: "https://github.example"
        ))
        let model = McpClientSecretSheetModel(client: fake, serverName: "github")

        await model.start()

        XCTAssertEqual(fake.clientSecretIssuerCalls, ["github"])
        XCTAssertEqual(model.phase, .confirmIssuer(issuer: "https://github.example/issuer",
                                                    issuerOrigin: "https://github.example",
                                                    authorizeOrigin: "https://github.example"))
    }

    /// An untyped failure from the lookup is a `.failure`, discovered synchronously.
    func testStartFailureTransitionsToFailure() async {
        let fake = FakeMcpAuthClient()
        fake.clientSecretIssuerResult = .failure(FakeMcpAuthClient.SimpleError())
        let model = McpClientSecretSheetModel(client: fake, serverName: "github")

        await model.start()

        XCTAssertEqual(model.phase, .failure(reason: "couldn't look up this server's sign-in details"))
    }

    /// A TYPED refusal from the lookup is mapped through `mcpAuthErrorText`.
    func testStartFailureUsesTheTypedErrorTextWhenRecognized() async {
        let fake = FakeMcpAuthClient()
        fake.clientSecretIssuerResult = .failure(RpcError(code: -1, message: "refused",
                                                           data: .object(["code": .string("mcp_not_preregistered")])))
        let model = McpClientSecretSheetModel(client: fake, serverName: "github")

        await model.start()

        XCTAssertEqual(model.phase, .failure(reason: "this server has no pre-registered client to set a secret for"))
    }

    /// `confirmIssuer()` from `.confirmIssuer` moves to `.enteringSecret`, carrying that issuer as
    /// `expectedIssuer` — the ONLY door to the SecureField phase.
    func testConfirmIssuerMovesToEnteringSecretWithThatIssuer() async {
        let fake = FakeMcpAuthClient()
        let model = McpClientSecretSheetModel(client: fake, serverName: "github")
        await model.start()

        model.confirmIssuer()

        XCTAssertEqual(model.phase, .enteringSecret(expectedIssuer: "https://github.example/issuer"))
    }

    /// A no-op from any OTHER phase — no jumping straight to the secret field from `.starting`.
    func testConfirmIssuerIsANoOpBeforeAnyConfirmPhase() {
        let fake = FakeMcpAuthClient()
        let model = McpClientSecretSheetModel(client: fake, serverName: "github")

        model.confirmIssuer()

        XCTAssertEqual(model.phase, .starting)
    }

    // MARK: - submit()

    /// The trimmed secret reaches `setClientSecret` with the CONFIRMED issuer as `expectedIssuer`,
    /// exactly once, and the field is cleared IMMEDIATELY regardless of outcome.
    func testSubmitSendsTrimmedSecretWithTheConfirmedExpectedIssuerAndClearsField() async {
        let fake = FakeMcpAuthClient()
        fake.setClientSecretResult = .success(McpClientSecretSaved(
            issuer: "https://github.example/issuer", issuerOrigin: "https://github.example"
        ))
        let model = McpClientSecretSheetModel(client: fake, serverName: "github")
        await model.start()
        model.confirmIssuer()
        model.secret = "  shhh-secret  "

        await model.submit()

        XCTAssertEqual(fake.setClientSecretCalls.count, 1)
        XCTAssertEqual(fake.setClientSecretCalls[0].name, "github")
        XCTAssertEqual(fake.setClientSecretCalls[0].secret, "shhh-secret")
        XCTAssertEqual(fake.setClientSecretCalls[0].expectedIssuer, "https://github.example/issuer")
        XCTAssertEqual(model.secret, "")
        XCTAssertNil(model.errorText)
        // Polish round 3: the sheet's success line names the ISSUER this call returned, not the
        // origin.
        XCTAssertEqual(model.phase, .success(issuer: "https://github.example/issuer"))
    }

    /// `submit()` is a no-op from any phase other than `.enteringSecret` — no submitting before the
    /// user has ever confirmed an issuer.
    func testSubmitIsANoOpBeforeEnteringSecret() async {
        let fake = FakeMcpAuthClient()
        let model = McpClientSecretSheetModel(client: fake, serverName: "github")
        model.secret = "some-secret"

        await model.submit()

        XCTAssertTrue(fake.setClientSecretCalls.isEmpty)
    }

    /// An empty (or whitespace-only) secret never reaches the RPC.
    func testSubmitSkipsRpcWhenFieldIsEmpty() async {
        let fake = FakeMcpAuthClient()
        let model = McpClientSecretSheetModel(client: fake, serverName: "github")
        await model.start()
        model.confirmIssuer()
        model.secret = "   "

        await model.submit()

        XCTAssertTrue(fake.setClientSecretCalls.isEmpty)
    }

    /// An untyped thrown `setClientSecret` surfaces as `errorText`, STAYING on `.enteringSecret` —
    /// the field is still cleared (never retained past one submit attempt).
    func testSubmitUntypedErrorSurfacesAsErrorTextAndStaysOnEnteringSecret() async {
        let fake = FakeMcpAuthClient()
        fake.setClientSecretResult = .failure(FakeMcpAuthClient.SimpleError())
        let model = McpClientSecretSheetModel(client: fake, serverName: "github")
        await model.start()
        model.confirmIssuer()
        model.secret = "wrong-secret"

        await model.submit()

        XCTAssertNotNil(model.errorText)
        XCTAssertEqual(model.secret, "")
        XCTAssertEqual(model.phase, .enteringSecret(expectedIssuer: "https://github.example/issuer"))
    }

    /// A TYPED, non-issuer-shaped refusal (e.g. `mcp_client_secret_unavailable`) is mapped through
    /// `mcpAuthErrorText`, same door as the untyped case.
    func testSubmitTypedNonIssuerErrorUsesMcpAuthErrorText() async {
        let fake = FakeMcpAuthClient()
        fake.setClientSecretResult = .failure(RpcError(code: -1, message: "refused",
                                                        data: .object(["code": .string("mcp_client_secret_unavailable")])))
        let model = McpClientSecretSheetModel(client: fake, serverName: "github")
        await model.start()
        model.confirmIssuer()
        model.secret = "some-secret"

        await model.submit()

        XCTAssertEqual(model.errorText, "no client secret is stored for this server")
    }

    /// `mcp_issuer_changed` moves to `.reconfirmIssuer` with the NEW issuer and NO origin (that
    /// refusal's own contract carries only the issuer) — never a flat `errorText`.
    func testSubmitIssuerChangedMovesToReconfirmWithNoOrigin() async {
        let fake = FakeMcpAuthClient()
        fake.setClientSecretResult = .failure(RpcError(code: -1, message: "issuer changed", data: .object([
            "code": .string("mcp_issuer_changed"), "issuer": .string("https://new.example/issuer"),
        ])))
        let model = McpClientSecretSheetModel(client: fake, serverName: "github")
        await model.start()
        model.confirmIssuer()
        model.secret = "some-secret"

        await model.submit()

        XCTAssertEqual(model.phase, .reconfirmIssuer(issuer: "https://new.example/issuer", issuerOrigin: nil))
        XCTAssertNil(model.errorText)
        XCTAssertEqual(model.secret, "", "the secret is gone — re-confirming means re-entering it")
    }

    /// `mcp_expected_issuer_required` moves to `.reconfirmIssuer` WITH an origin (that refusal's
    /// own contract carries both `issuer` and `issuerOrigin`).
    func testSubmitExpectedIssuerRequiredMovesToReconfirmWithOrigin() async {
        let fake = FakeMcpAuthClient()
        fake.setClientSecretResult = .failure(RpcError(code: -1, message: "needs confirmation", data: .object([
            "code": .string("mcp_expected_issuer_required"),
            "issuer": .string("https://correct.example/issuer"),
            "issuerOrigin": .string("https://correct.example"),
        ])))
        let model = McpClientSecretSheetModel(client: fake, serverName: "github")
        await model.start()
        model.confirmIssuer()
        model.secret = "some-secret"

        await model.submit()

        XCTAssertEqual(model.phase, .reconfirmIssuer(issuer: "https://correct.example/issuer",
                                                       issuerOrigin: "https://correct.example"))
    }

    /// After a re-confirm, `confirmIssuer()` moves to a FRESH `.enteringSecret` with the NEW
    /// issuer — the whole point of the two-step flow surviving a mid-flight issuer change.
    func testReconfirmThenConfirmIssuerMovesToEnteringSecretWithTheNewIssuer() async {
        let fake = FakeMcpAuthClient()
        fake.setClientSecretResult = .failure(RpcError(code: -1, message: "issuer changed", data: .object([
            "code": .string("mcp_issuer_changed"), "issuer": .string("https://new.example/issuer"),
        ])))
        let model = McpClientSecretSheetModel(client: fake, serverName: "github")
        await model.start()
        model.confirmIssuer()
        model.secret = "some-secret"
        await model.submit()

        model.confirmIssuer()

        XCTAssertEqual(model.phase, .enteringSecret(expectedIssuer: "https://new.example/issuer"))
    }
}
