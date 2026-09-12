import XCTest
import WinterKit
@testable import Winter

/// BYOK T2: `ProviderPaneModel`'s save flow — entered form values reach `configureProvider(...)`
/// verbatim, a successful save fires the injected `onConfigured` closure (the daemon-restart hook,
/// wired by `AppDelegate` in production) and refreshes the status row, and a thrown server error
/// surfaces as `saveErrorText` without crashing or firing `onConfigured`. Drives a real (actor)
/// `WinterClient` over the same scripted-transport double every other async pane-model test in this
/// target uses (`FeedScriptedTransport`/`feedLineJSON`/`feedWaitUntil`, `SessionFeedTests.swift`) —
/// same posture as `MemoryPaneModelTests`/`PluginManagerModelAsyncTests`, no new client seam.
@MainActor
final class ProviderPaneModelTests: XCTestCase {
    /// Opens + hellos a scripted `WinterClient`, mirroring `MemoryPaneModelTests.connectedClient()`
    /// exactly (send count 1 == `protocol.hello`).
    private func connectedClient() async throws -> (WinterClient, FeedScriptedTransport) {
        let t = FeedScriptedTransport()
        let client = WinterClient(makeTransport: { t }, token: "tok", clientName: "provider-pane-test")
        async let c: Void = client.connect()
        await feedWaitUntil { !t.sent.isEmpty }
        let hello = feedLineJSON(t.sent[0])
        t.feed(#"{"jsonrpc":"2.0","id":\#(hello["id"] as! Int),"result":{"ok":true}}"#)
        try await c
        return (client, t)
    }

    /// The happy path: entered baseUrl/apiKey/model reach `provider.configure` verbatim,
    /// `onConfigured` fires exactly once, `savedConfirmation` flips true, and the trailing
    /// `refreshStatus()` (a fresh `daemon.status`) seeds `providerId`/`providerModel` from the
    /// response.
    func testSaveCallsConfigureProviderWithEnteredValuesAndFiresOnConfiguredOnSuccess() async throws {
        let (client, t) = try await connectedClient()
        var onConfiguredCallCount = 0
        let model = ProviderPaneModel(client: client, onConfigured: { onConfiguredCallCount += 1 })
        model.baseUrl = "https://api.openai.com/v1"
        model.apiKey = "sk-test-123"
        model.model = "gpt-4o-mini"

        async let saveTask: Void = model.save()
        await feedWaitUntil { t.sent.count >= 2 } // request #2 (after hello): provider.configure
        let configureReq = feedLineJSON(t.sent[1])
        XCTAssertEqual(configureReq["method"] as? String, "provider.configure")
        let params = configureReq["params"] as? [String: Any]
        XCTAssertEqual(params?["type"] as? String, "openai-compatible")
        XCTAssertEqual(params?["baseUrl"] as? String, "https://api.openai.com/v1")
        XCTAssertEqual(params?["apiKey"] as? String, "sk-test-123")
        XCTAssertEqual(params?["model"] as? String, "gpt-4o-mini")
        t.feed(#"{"jsonrpc":"2.0","id":\#(configureReq["id"] as! Int),"result":{"ok":true}}"#)

        await feedWaitUntil { t.sent.count >= 3 } // request #3: the trailing daemon.status refresh
        let statusReq = feedLineJSON(t.sent[2])
        XCTAssertEqual(statusReq["method"] as? String, "daemon.status")
        t.feed(#"{"jsonrpc":"2.0","id":\#(statusReq["id"] as! Int),"result":{"version":"0.1.0","uptimeMs":1000,"socketPath":"/tmp/x.sock","provider":{"id":"openai-compatible","model":"gpt-4o-mini"},"sessionsCount":0,"pluginsCount":0}}"#)
        await saveTask

        XCTAssertTrue(model.savedConfirmation)
        XCTAssertNil(model.saveErrorText)
        XCTAssertEqual(onConfiguredCallCount, 1)
        XCTAssertFalse(model.saving)
        XCTAssertEqual(model.providerId, "openai-compatible")
        XCTAssertEqual(model.providerModel, "gpt-4o-mini")
    }

    /// An empty (whitespace-trimmed) model field must be omitted from the wire params entirely —
    /// same "omit, never null" convention `WinterClient.configureProvider` itself documents — so the
    /// server falls back to its own default rather than receiving an explicit empty string.
    func testSaveOmitsModelFieldWhenLeftEmpty() async throws {
        let (client, t) = try await connectedClient()
        let model = ProviderPaneModel(client: client)
        model.baseUrl = "https://api.openai.com/v1"
        model.apiKey = "sk-test-456"
        model.model = "   " // whitespace-only — must trim to empty and be omitted, not sent as "   "

        async let saveTask: Void = model.save()
        await feedWaitUntil { t.sent.count >= 2 }
        let configureReq = feedLineJSON(t.sent[1])
        let params = configureReq["params"] as? [String: Any]
        XCTAssertNil(params?["model"], "an empty/whitespace-only model must not be sent at all")
        t.feed(#"{"jsonrpc":"2.0","id":\#(configureReq["id"] as! Int),"result":{"ok":true}}"#)

        await feedWaitUntil { t.sent.count >= 3 }
        let statusReq = feedLineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(statusReq["id"] as! Int),"result":{"version":"0.1.0","uptimeMs":0,"socketPath":"/tmp/x.sock","provider":null,"sessionsCount":0,"pluginsCount":0}}"#)
        await saveTask
    }

    /// A thrown server error (e.g. an invalid base URL/key `provider.configure` itself rejects)
    /// must surface as `saveErrorText`, never crash, and never fire `onConfigured` — a failed save
    /// must not trick `AppDelegate` into restarting the daemon for a change that never took effect.
    /// No trailing `daemon.status` refresh happens on this path either (only scripted through the
    /// error response, so a hang here would mean the model wrongly still tried to refresh).
    func testSaveErrorSurfacesAsErrorStateWithoutFiringOnConfiguredOrCrashing() async throws {
        let (client, t) = try await connectedClient()
        var onConfiguredCallCount = 0
        let model = ProviderPaneModel(client: client, onConfigured: { onConfiguredCallCount += 1 })
        model.baseUrl = "https://api.openai.com/v1"
        model.apiKey = "sk-bad"

        async let saveTask: Void = model.save()
        await feedWaitUntil { t.sent.count >= 2 }
        let configureReq = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(configureReq["id"] as! Int),"error":{"code":-32602,"message":"invalid params"}}"#)
        await saveTask

        XCTAssertFalse(model.savedConfirmation)
        XCTAssertNotNil(model.saveErrorText)
        XCTAssertEqual(onConfiguredCallCount, 0, "a failed save must never fire the restart hook")
        XCTAssertFalse(model.saving, "saving must be reset even on failure — no stuck spinner")
        XCTAssertEqual(t.sent.count, 2, "a failed configure must not trigger a trailing daemon.status refresh")
    }

    /// `canSave` gating — pure/synchronous, no RPC involved. An empty API key blocks Save
    /// regardless of the (defaulted, non-empty) base URL; a whitespace-only base URL blocks it too.
    func testCanSaveRequiresNonEmptyApiKeyAndBaseUrl() {
        let client = WinterClientTestFactory.make()
        let model = ProviderPaneModel(client: client)

        XCTAssertFalse(model.canSave, "empty apiKey must block save even with the default baseUrl")
        model.apiKey = "sk-test"
        XCTAssertTrue(model.canSave)

        model.baseUrl = "   \n  "
        XCTAssertFalse(model.canSave, "whitespace-only baseUrl must block save")

        model.baseUrl = "https://api.openai.com/v1"
        XCTAssertTrue(model.canSave)
    }
}
