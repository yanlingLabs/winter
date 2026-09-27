import XCTest
import WinterKit
@testable import Winter

/// WS-25 (MCP OAuth): `LiveMcpAuthClient`'s wire-level behavior — the pieces `FakeMcpAuthClient`-
/// driven tests (`McpSignInSheetModelTests`/`McpSignOutSheetModelTests`/
/// `McpClientSecretSheetModelTests`) can't reach, since that fake bypasses wire parsing entirely.
/// Drives a REAL `WinterClient` over `FeedScriptedTransport`, same pattern as
/// `LiveAnthropicAuthClientTests.connectedClient()` beside this file.
@MainActor
final class LiveMcpAuthClientTests: XCTestCase {
    private func connectedClient() async throws -> (WinterClient, FeedScriptedTransport) {
        let t = FeedScriptedTransport()
        let client = WinterClient(makeTransport: { t }, token: "tok", clientName: "mcp-auth-test")
        async let c: Void = client.connect()
        await feedWaitUntil { !t.sent.isEmpty }
        let hello = feedLineJSON(t.sent[0])
        t.feed(#"{"jsonrpc":"2.0","id":\#(hello["id"] as! Int),"result":{"ok":true}}"#)
        try await c
        return (client, t)
    }

    // MARK: - login

    /// `mcp.login` sends `{name}` — no `scope`/`cwd` key at all (this client never has a cwd; see
    /// `McpAuthClient.swift`'s header), and no `confirmIssuerChange` key either via the one-arg
    /// convenience — and decodes `{loginId, authUrl, issuerOrigin, authorizeOrigin}`.
    func testLoginSendsBareNameAndDecodesTheStartResult() async throws {
        let (client, t) = try await connectedClient()
        let live = LiveMcpAuthClient(client: client)

        async let loginTask = live.login(name: "linear")
        await feedWaitUntil { t.sent.count >= 2 }
        let req = feedLineJSON(t.sent[1])
        XCTAssertEqual(req["method"] as? String, "mcp.login")
        XCTAssertEqual((req["params"] as? [String: Any])?["name"] as? String, "linear")
        XCTAssertNil((req["params"] as? [String: Any])?["scope"])
        XCTAssertNil((req["params"] as? [String: Any])?["cwd"])
        XCTAssertNil((req["params"] as? [String: Any])?["confirmIssuerChange"])

        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"loginId":"lg_1","authUrl":"https://mcp.linear.app/authorize?state=abc","issuerOrigin":"https://mcp.linear.app","authorizeOrigin":"https://mcp.linear.app"}}"#)
        let start = try await loginTask

        XCTAssertEqual(start.loginId, "lg_1")
        // The full URL, INCLUDING its query (PKCE state) — never sanitized, unlike the Console
        // login's `urlHint`.
        XCTAssertEqual(start.authUrl.absoluteString, "https://mcp.linear.app/authorize?state=abc")
        XCTAssertEqual(start.issuerOrigin, "https://mcp.linear.app")
        XCTAssertEqual(start.authorizeOrigin, "https://mcp.linear.app")
    }

    /// The explicit two-arg call with `confirmIssuerChange: true` sends the key — the sign-in
    /// sheet's retry after an issuer-change confirmation.
    func testLoginSendsConfirmIssuerChangeWhenTrue() async throws {
        let (client, t) = try await connectedClient()
        let live = LiveMcpAuthClient(client: client)

        async let loginTask = live.login(name: "linear", confirmIssuerChange: true)
        await feedWaitUntil { t.sent.count >= 2 }
        let req = feedLineJSON(t.sent[1])
        XCTAssertEqual((req["params"] as? [String: Any])?["confirmIssuerChange"] as? Bool, true)
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"loginId":"lg_1","authUrl":"https://mcp.linear.app/authorize","issuerOrigin":"https://mcp.linear.app","authorizeOrigin":"https://mcp.linear.app"}}"#)
        _ = try await loginTask
    }

    /// A malformed reply (missing `authUrl`) throws rather than returning a half-built value.
    func testLoginThrowsOnAMalformedResult() async throws {
        let (client, t) = try await connectedClient()
        let live = LiveMcpAuthClient(client: client)

        async let loginTask = live.login(name: "linear")
        await feedWaitUntil { t.sent.count >= 2 }
        let req = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"loginId":"lg_1"}}"#)

        do {
            _ = try await loginTask
            XCTFail("a missing authUrl must throw")
        } catch {
            // expected
        }
    }

    /// A reply missing ONLY `authorizeOrigin` (an older/partial daemon) also throws — this field is
    /// required, not additive, since the whole RPC is new.
    func testLoginThrowsWhenAuthorizeOriginIsMissing() async throws {
        let (client, t) = try await connectedClient()
        let live = LiveMcpAuthClient(client: client)

        async let loginTask = live.login(name: "linear")
        await feedWaitUntil { t.sent.count >= 2 }
        let req = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"loginId":"lg_1","authUrl":"https://mcp.linear.app/authorize","issuerOrigin":"https://mcp.linear.app"}}"#)

        do {
            _ = try await loginTask
            XCTFail("a missing authorizeOrigin must throw")
        } catch {
            // expected
        }
    }

    /// `mcp_issuer_change_requires_confirmation`'s `data` decodes through `RpcError.mcpAuthCode`/
    /// `mcpIssuerChangeConfirmation` — the sign-in sheet's ONLY way to learn both FULL issuers
    /// (polish round 3) and both origins.
    func testLoginRefusedWithIssuerChangeDataDecodesThroughRpcError() async throws {
        let (client, t) = try await connectedClient()
        let live = LiveMcpAuthClient(client: client)

        async let loginTask = live.login(name: "linear")
        await feedWaitUntil { t.sent.count >= 2 }
        let req = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"error":{"code":-1,"message":"issuer changed","data":{"code":"mcp_issuer_change_requires_confirmation","storedIssuer":"https://old.example/issuer","newIssuer":"https://new.example/issuer","storedIssuerOrigin":"https://old.example","newIssuerOrigin":"https://new.example"}}}"#)

        do {
            _ = try await loginTask
            XCTFail("must throw")
        } catch {
            let rpc = try XCTUnwrap(error as? RpcError)
            XCTAssertEqual(rpc.mcpAuthCode, .issuerChangeRequiresConfirmation)
            let confirmation = try XCTUnwrap(rpc.mcpIssuerChangeConfirmation)
            XCTAssertEqual(confirmation.storedIssuer, "https://old.example/issuer")
            XCTAssertEqual(confirmation.newIssuer, "https://new.example/issuer")
            XCTAssertEqual(confirmation.storedIssuerOrigin, "https://old.example")
            XCTAssertEqual(confirmation.newIssuerOrigin, "https://new.example")
        }
    }

    /// A refusal missing the NEW `storedIssuer`/`newIssuer` fields (an older daemon that only sends
    /// the two origins) decodes `mcpIssuerChangeConfirmation` as `nil` — both issuer fields are
    /// required together with the origins, never a half-built confirmation.
    func testLoginRefusedWithIssuerChangeDataMissingTheIssuerFieldsDecodesNil() async throws {
        let (client, t) = try await connectedClient()
        let live = LiveMcpAuthClient(client: client)

        async let loginTask = live.login(name: "linear")
        await feedWaitUntil { t.sent.count >= 2 }
        let req = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"error":{"code":-1,"message":"issuer changed","data":{"code":"mcp_issuer_change_requires_confirmation","storedIssuerOrigin":"https://old.example","newIssuerOrigin":"https://new.example"}}}"#)

        do {
            _ = try await loginTask
            XCTFail("must throw")
        } catch {
            let rpc = try XCTUnwrap(error as? RpcError)
            XCTAssertNil(rpc.mcpIssuerChangeConfirmation)
        }
    }

    // MARK: - loginStatus

    /// Every known `state` word decodes to its own `McpLoginState` case.
    func testLoginStatusDecodesEveryKnownState() async throws {
        let (client, t) = try await connectedClient()
        let live = LiveMcpAuthClient(client: client)

        let cases: [(String, McpLoginState)] = [
            ("pending", .pending), ("done", .done), ("failed", .failed), ("expired", .expired),
        ]
        for (index, (wire, expected)) in cases.enumerated() {
            async let statusTask = live.loginStatus(loginId: "lg_1")
            await feedWaitUntil { t.sent.count >= index + 2 }
            let req = feedLineJSON(t.sent[index + 1])
            XCTAssertEqual(req["method"] as? String, "mcp.loginStatus")
            XCTAssertEqual((req["params"] as? [String: Any])?["loginId"] as? String, "lg_1")
            t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"state":"\#(wire)"}}"#)
            let status = try await statusTask
            XCTAssertEqual(status.state, expected)
        }
    }

    /// An UNRECOGNIZED state word (a newer daemon) decodes to `.unknown(word)` rather than
    /// throwing — the poller's own pure function treats that as an immediate failure naming the
    /// word, but the WIRE decode itself must not refuse a value it merely doesn't recognize.
    func testLoginStatusDecodesAnUnrecognizedStateAsUnknown() async throws {
        let (client, t) = try await connectedClient()
        let live = LiveMcpAuthClient(client: client)

        async let statusTask = live.loginStatus(loginId: "lg_1")
        await feedWaitUntil { t.sent.count >= 2 }
        let req = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"state":"stalled","error":"not a real word"}}"#)

        let status = try await statusTask
        XCTAssertEqual(status.state, .unknown("stalled"))
        XCTAssertEqual(status.error, "not a real word")
    }

    // MARK: - logout

    /// `forgetClient: true` reaches the wire; `nil` omits the key entirely rather than sending
    /// `false` — the daemon's own default (a best-effort revoke that keeps the registration).
    func testLogoutSendsForgetClientOnlyWhenGiven() async throws {
        let (client, t) = try await connectedClient()
        let live = LiveMcpAuthClient(client: client)

        async let logoutTask: () = live.logout(name: "linear", forgetClient: true)
        await feedWaitUntil { t.sent.count >= 2 }
        let req = feedLineJSON(t.sent[1])
        XCTAssertEqual(req["method"] as? String, "mcp.logout")
        XCTAssertEqual((req["params"] as? [String: Any])?["name"] as? String, "linear")
        XCTAssertEqual((req["params"] as? [String: Any])?["forgetClient"] as? Bool, true)
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"ok":true}}"#)
        try await logoutTask

        async let logoutTask2: () = live.logout(name: "linear", forgetClient: nil)
        await feedWaitUntil { t.sent.count >= 3 }
        let req2 = feedLineJSON(t.sent[2])
        XCTAssertNil((req2["params"] as? [String: Any])?["forgetClient"])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req2["id"] as! Int),"result":{"ok":true}}"#)
        try await logoutTask2
    }

    /// `{ok:false}` — a well-formed, non-error reply — surfaces as a THROWN error, same as
    /// `LiveAnthropicAuthClient.logout()`.
    func testLogoutOkFalseThrows() async throws {
        let (client, t) = try await connectedClient()
        let live = LiveMcpAuthClient(client: client)

        async let logoutTask: () = live.logout(name: "linear", forgetClient: nil)
        await feedWaitUntil { t.sent.count >= 2 }
        let req = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"ok":false}}"#)

        do {
            try await logoutTask
            XCTFail("ok:false must throw")
        } catch {
            // expected
        }
    }

    // MARK: - clientSecretIssuer (polish round 3, item 1: the read-only lookup)

    /// `mcp.clientSecretIssuer` sends `{name}` — writes nothing — and decodes
    /// `{name, issuer, issuerOrigin, authorizeOrigin}`.
    func testClientSecretIssuerSendsNameAndDecodesTheResult() async throws {
        let (client, t) = try await connectedClient()
        let live = LiveMcpAuthClient(client: client)

        async let task = live.clientSecretIssuer(name: "github")
        await feedWaitUntil { t.sent.count >= 2 }
        let req = feedLineJSON(t.sent[1])
        XCTAssertEqual(req["method"] as? String, "mcp.clientSecretIssuer")
        XCTAssertEqual((req["params"] as? [String: Any])?["name"] as? String, "github")

        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"name":"github","issuer":"https://github.example/issuer","issuerOrigin":"https://github.example","authorizeOrigin":"https://github.example"}}"#)
        let info = try await task

        XCTAssertEqual(info.name, "github")
        XCTAssertEqual(info.issuer, "https://github.example/issuer")
        XCTAssertEqual(info.issuerOrigin, "https://github.example")
        XCTAssertEqual(info.authorizeOrigin, "https://github.example")
    }

    /// A malformed reply (missing `issuer`) throws rather than returning a half-built value.
    func testClientSecretIssuerThrowsOnAMalformedResult() async throws {
        let (client, t) = try await connectedClient()
        let live = LiveMcpAuthClient(client: client)

        async let task = live.clientSecretIssuer(name: "github")
        await feedWaitUntil { t.sent.count >= 2 }
        let req = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"name":"github"}}"#)

        do {
            _ = try await task
            XCTFail("a missing issuer must throw")
        } catch {
            // expected
        }
    }

    // MARK: - setClientSecret

    /// The secret AND `expectedIssuer` reach the wire, as this call's own arguments — the secret
    /// never logged, never echoed back into anything this test could observe elsewhere. The
    /// reply's own `issuer`/`issuerOrigin` (polish round 3) are returned — the secret never is.
    func testSetClientSecretSendsExpectedIssuerAndReturnsIssuer() async throws {
        let (client, t) = try await connectedClient()
        let live = LiveMcpAuthClient(client: client)

        async let setTask = live.setClientSecret(name: "github", secret: "shhh-secret", expectedIssuer: "https://github.example/issuer")
        await feedWaitUntil { t.sent.count >= 2 }
        let req = feedLineJSON(t.sent[1])
        XCTAssertEqual(req["method"] as? String, "mcp.setClientSecret")
        XCTAssertEqual((req["params"] as? [String: Any])?["name"] as? String, "github")
        XCTAssertEqual((req["params"] as? [String: Any])?["secret"] as? String, "shhh-secret")
        XCTAssertEqual((req["params"] as? [String: Any])?["expectedIssuer"] as? String, "https://github.example/issuer")
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"ok":true,"issuer":"https://github.example/issuer","issuerOrigin":"https://github.example"}}"#)
        let saved = try await setTask
        XCTAssertEqual(saved.issuer, "https://github.example/issuer")
        XCTAssertEqual(saved.issuerOrigin, "https://github.example")
    }

    func testSetClientSecretOkFalseThrows() async throws {
        let (client, t) = try await connectedClient()
        let live = LiveMcpAuthClient(client: client)

        async let setTask = live.setClientSecret(name: "github", secret: "shhh-secret", expectedIssuer: "https://github.example/issuer")
        await feedWaitUntil { t.sent.count >= 2 }
        let req = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"ok":false}}"#)

        do {
            _ = try await setTask
            XCTFail("ok:false must throw")
        } catch {
            // expected
        }
    }

    /// `ok:true` but no `issuer` also throws — the field is required, not additive.
    func testSetClientSecretThrowsWhenIssuerIsMissing() async throws {
        let (client, t) = try await connectedClient()
        let live = LiveMcpAuthClient(client: client)

        async let setTask = live.setClientSecret(name: "github", secret: "shhh-secret", expectedIssuer: "https://github.example/issuer")
        await feedWaitUntil { t.sent.count >= 2 }
        let req = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"ok":true,"issuerOrigin":"https://github.example"}}"#)

        do {
            _ = try await setTask
            XCTFail("a missing issuer must throw")
        } catch {
            // expected
        }
    }

    /// `mcp_issuer_changed`'s `data.issuer` decodes through `RpcError.mcpIssuerChanged` — the ONLY
    /// field that refusal carries.
    func testSetClientSecretRefusedIssuerChangedDecodesThroughRpcError() async throws {
        let (client, t) = try await connectedClient()
        let live = LiveMcpAuthClient(client: client)

        async let setTask = live.setClientSecret(name: "github", secret: "shhh-secret", expectedIssuer: "https://old.example/issuer")
        await feedWaitUntil { t.sent.count >= 2 }
        let req = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"error":{"code":-1,"message":"issuer changed","data":{"code":"mcp_issuer_changed","issuer":"https://new.example/issuer"}}}"#)

        do {
            _ = try await setTask
            XCTFail("must throw")
        } catch {
            let rpc = try XCTUnwrap(error as? RpcError)
            XCTAssertEqual(rpc.mcpIssuerChanged, "https://new.example/issuer")
        }
    }

    /// `mcp_expected_issuer_required`'s `data` (`issuer` + `issuerOrigin`) decodes through
    /// `RpcError.mcpExpectedIssuerRequired`.
    func testSetClientSecretRefusedExpectedIssuerRequiredDecodesThroughRpcError() async throws {
        let (client, t) = try await connectedClient()
        let live = LiveMcpAuthClient(client: client)

        async let setTask = live.setClientSecret(name: "github", secret: "shhh-secret", expectedIssuer: "")
        await feedWaitUntil { t.sent.count >= 2 }
        let req = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"error":{"code":-1,"message":"needs confirmation","data":{"code":"mcp_expected_issuer_required","issuer":"https://correct.example/issuer","issuerOrigin":"https://correct.example"}}}"#)

        do {
            _ = try await setTask
            XCTFail("must throw")
        } catch {
            let rpc = try XCTUnwrap(error as? RpcError)
            let needed = try XCTUnwrap(rpc.mcpExpectedIssuerRequired)
            XCTAssertEqual(needed.issuer, "https://correct.example/issuer")
            XCTAssertEqual(needed.issuerOrigin, "https://correct.example")
        }
    }
}
