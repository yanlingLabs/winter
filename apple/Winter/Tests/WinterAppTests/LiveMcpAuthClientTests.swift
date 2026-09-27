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
    /// `McpAuthClient.swift`'s header) — and decodes `{loginId, authUrl, issuerOrigin}`.
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

        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"loginId":"lg_1","authUrl":"https://mcp.linear.app/authorize?state=abc","issuerOrigin":"https://mcp.linear.app"}}"#)
        let start = try await loginTask

        XCTAssertEqual(start.loginId, "lg_1")
        // The full URL, INCLUDING its query (PKCE state) — never sanitized, unlike the Console
        // login's `urlHint`.
        XCTAssertEqual(start.authUrl.absoluteString, "https://mcp.linear.app/authorize?state=abc")
        XCTAssertEqual(start.issuerOrigin, "https://mcp.linear.app")
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

    // MARK: - setClientSecret

    /// The secret reaches the wire exactly once, as this call's own argument — never logged,
    /// never echoed back into anything this test could observe elsewhere.
    func testSetClientSecretSendsNameAndSecret() async throws {
        let (client, t) = try await connectedClient()
        let live = LiveMcpAuthClient(client: client)

        async let setTask: () = live.setClientSecret(name: "github", secret: "shhh-secret")
        await feedWaitUntil { t.sent.count >= 2 }
        let req = feedLineJSON(t.sent[1])
        XCTAssertEqual(req["method"] as? String, "mcp.setClientSecret")
        XCTAssertEqual((req["params"] as? [String: Any])?["name"] as? String, "github")
        XCTAssertEqual((req["params"] as? [String: Any])?["secret"] as? String, "shhh-secret")
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"ok":true}}"#)
        try await setTask
    }

    func testSetClientSecretOkFalseThrows() async throws {
        let (client, t) = try await connectedClient()
        let live = LiveMcpAuthClient(client: client)

        async let setTask: () = live.setClientSecret(name: "github", secret: "shhh-secret")
        await feedWaitUntil { t.sent.count >= 2 }
        let req = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"ok":false}}"#)

        do {
            try await setTask
            XCTFail("ok:false must throw")
        } catch {
            // expected
        }
    }
}
