import XCTest
import WinterKit
@testable import Winter

/// Winter Phase 10a fix round 1: `LiveAnthropicAuthClient`'s wire-level behavior — the pieces
/// `FakeAnthropicAuthClient`-driven tests (`AnthropicAuthSectionModelTests`/
/// `AnthropicLoginSheetModelTests`) can't reach, since that fake bypasses wire parsing entirely.
/// Drives a REAL `WinterClient` over `FeedScriptedTransport` (`SessionFeedTests.swift`, shared
/// target-wide — same pattern as `ProviderPaneModelTests.connectedClient()`).
@MainActor
final class LiveAnthropicAuthClientTests: XCTestCase {
    private func connectedClient() async throws -> (WinterClient, FeedScriptedTransport) {
        let t = FeedScriptedTransport()
        let client = WinterClient(makeTransport: { t }, token: "tok", clientName: "anthropic-auth-test")
        async let c: Void = client.connect()
        await feedWaitUntil { !t.sent.isEmpty }
        let hello = feedLineJSON(t.sent[0])
        t.feed(#"{"jsonrpc":"2.0","id":\#(hello["id"] as! Int),"result":{"ok":true}}"#)
        try await c
        return (client, t)
    }

    /// `provider.status` sends `{}` — NO `provider` key (fix round 1: Lane O's final shape) — and
    /// the result's `anthropic` sub-object is parsed directly, with no per-provider filtering.
    func testStatusSendsEmptyParamsAndParsesAnthropicSubObject() async throws {
        let (client, t) = try await connectedClient()
        let live = LiveAnthropicAuthClient(client: client)

        async let statusTask = live.status()
        await feedWaitUntil { t.sent.count >= 2 }
        let req = feedLineJSON(t.sent[1])
        XCTAssertEqual(req["method"] as? String, "provider.status")
        XCTAssertEqual((req["params"] as? [String: Any])?.isEmpty, true, "provider.status must send {} — no provider key")

        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"anthropic":{"apiKey":true,"consoleProfile":false,"auth":"api-key","effective":"api-key"}}}"#)
        let status = try await statusTask

        XCTAssertEqual(status, AnthropicAuthStatus(apiKey: true, consoleProfile: false, auth: "api-key", effective: "api-key"))
    }

    /// `provider.login`'s `urlHint`, when present, is sanitized (query stripped) and returned.
    func testLoginReturnsSanitizedUrlHint() async throws {
        let (client, t) = try await connectedClient()
        let live = LiveAnthropicAuthClient(client: client)

        async let loginTask = live.login()
        await feedWaitUntil { t.sent.count >= 2 }
        let req = feedLineJSON(t.sent[1])
        XCTAssertEqual(req["method"] as? String, "provider.login")

        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"started":true,"urlHint":"https://console.anthropic.com/oauth?code=abc123"}}"#)
        let url = try await loginTask

        XCTAssertEqual(url?.absoluteString, "https://console.anthropic.com/oauth")
    }

    /// No `urlHint` in the reply → `nil`, not a thrown error.
    func testLoginReturnsNilWhenNoUrlHint() async throws {
        let (client, t) = try await connectedClient()
        let live = LiveAnthropicAuthClient(client: client)

        async let loginTask = live.login()
        await feedWaitUntil { t.sent.count >= 2 }
        let req = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"started":true}}"#)

        let url = try await loginTask
        XCTAssertNil(url)
    }

    /// `provider.loginCode`'s `{ok:true}` resolves without throwing.
    func testSubmitLoginCodeOkTrueSucceeds() async throws {
        let (client, t) = try await connectedClient()
        let live = LiveAnthropicAuthClient(client: client)

        async let submitTask: () = live.submitLoginCode("ABC-123")
        await feedWaitUntil { t.sent.count >= 2 }
        let req = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"ok":true}}"#)

        try await submitTask
    }

    /// `provider.loginCode`'s `{ok:false}` — a well-formed, non-error reply — must still surface as
    /// a THROWN error (fix round 1: `ok:false` is a failure, not only a thrown RPC error).
    func testSubmitLoginCodeOkFalseThrows() async throws {
        let (client, t) = try await connectedClient()
        let live = LiveAnthropicAuthClient(client: client)

        async let submitTask: () = live.submitLoginCode("wrong-code")
        await feedWaitUntil { t.sent.count >= 2 }
        let req = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"ok":false}}"#)

        do {
            try await submitTask
            XCTFail("ok:false must throw")
        } catch {
            // expected
        }
    }

    /// `provider.logout`'s `{ok:true}` resolves without throwing.
    func testLogoutOkTrueSucceeds() async throws {
        let (client, t) = try await connectedClient()
        let live = LiveAnthropicAuthClient(client: client)

        async let logoutTask: () = live.logout()
        await feedWaitUntil { t.sent.count >= 2 }
        let req = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"ok":true}}"#)

        try await logoutTask
    }

    /// `provider.logout`'s `{ok:false}` must throw, same as `submitLoginCode`.
    func testLogoutOkFalseThrows() async throws {
        let (client, t) = try await connectedClient()
        let live = LiveAnthropicAuthClient(client: client)

        async let logoutTask: () = live.logout()
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
}
