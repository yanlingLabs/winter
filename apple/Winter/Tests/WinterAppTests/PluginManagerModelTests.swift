import XCTest
import WinterKit
@testable import Winter

/// WS-21 rewrite: `pluginRowDisplay(_:)` — the PURE `plugin.list` entry → row-display mapping
/// (tier badge / version / consent text / enabled state / action set). No `WinterClient`, no
/// SwiftUI — same "pure helper, table-tested directly" posture as `DashboardTests`' coverage of
/// `formatDaemonStatus`/`formatQuotaState`/`sortedTrustPaths`.
final class PluginManagerModelTests: XCTestCase {
    /// Convenience default-args wrapper so each test below only spells out the fields it's
    /// actually varying.
    private func listing(
        id: String = "sample-echo",
        version: String? = "1.2.0",
        marketplace: String = "winter-examples",
        scope: PluginScope = .user,
        enabled: Bool = true,
        extras: PluginExtras? = PluginExtras(
            tier: "platform", execPermission: true, tccPermissions: [], hardwarePermissions: [],
            requiredConsents: [], consented: [], entry: nil
        )
    ) -> PluginListing {
        PluginListing(id: id, installPath: "/plugins/\(id)", scope: scope, enabled: enabled,
                      marketplace: marketplace, version: version, extras: extras)
    }

    private func row(
        id: String = "sample-echo",
        version: String? = "1.2.0",
        tier: String = "platform",
        requiredConsents: [String] = [],
        consented: [String] = [],
        enabled: Bool = true,
        hasExtras: Bool = true
    ) -> PluginRowDisplay {
        let extras: PluginExtras? = hasExtras
            ? PluginExtras(tier: tier, execPermission: true, tccPermissions: [], hardwarePermissions: [],
                           requiredConsents: requiredConsents, consented: consented, entry: nil)
            : nil
        return pluginRowDisplay(listing(id: id, version: version, enabled: enabled, extras: extras))
    }

    // MARK: - Action rule: enabled Tier-2 (`platform`, extras present) → [.restart, .disable, .uninstall]

    func testEnabledTier2GetsRestartDisableUninstall() {
        let r = row(tier: "platform", enabled: true)
        XCTAssertEqual(r.tierBadge, "Tier 2")
        XCTAssertTrue(r.enabled)
        XCTAssertEqual(r.actions, [.restart, .disable, .uninstall])
    }

    /// The central "never offer .enable for an already-enabled plugin" carryover.
    func testNeverOffersEnableForAnEnabledPlugin() {
        let r = row(enabled: true)
        XCTAssertFalse(r.actions.contains(.enable))
    }

    // MARK: - Action rule: DISABLED (any tier) → [.enable, .uninstall]

    func testDisabledTier2GetsEnableUninstall() {
        let r = row(tier: "platform", enabled: false)
        XCTAssertFalse(r.enabled)
        XCTAssertEqual(r.actions, [.enable, .uninstall])
    }

    func testDisabledTier1GetsEnableUninstall() {
        let r = row(tier: "capability", enabled: false)
        XCTAssertEqual(r.actions, [.enable, .uninstall])
    }

    func testDisabledTakesPriorityOverTier() {
        let r = row(tier: "platform", enabled: false)
        XCTAssertEqual(r.actions, [.enable, .uninstall])
        XCTAssertFalse(r.actions.contains(.restart))
    }

    // MARK: - Action rule: enabled, no Tier-2 entry (Tier-1 or no extras) → [.disable, .uninstall],
    // never `.restart` (there is no process to restart).

    func testEnabledTier1GetsDisableUninstallNoRestart() {
        let r = row(tier: "capability", enabled: true)
        XCTAssertEqual(r.tierBadge, "Tier 1")
        XCTAssertEqual(r.actions, [.disable, .uninstall])
    }

    func testEnabledPluginWithNoExtrasGetsDisableUninstallNoRestart() {
        let r = row(enabled: true, hasExtras: false)
        XCTAssertEqual(r.tierBadge, "Plugin")
        XCTAssertEqual(r.actions, [.disable, .uninstall])
    }

    func testUnrecognizedTierGetsUnknownBadge() {
        let extras = PluginExtras(tier: "mystery", execPermission: false, tccPermissions: [],
                                  hardwarePermissions: [], requiredConsents: [], consented: [], entry: nil)
        let r = pluginRowDisplay(listing(extras: extras))
        XCTAssertEqual(r.tierBadge, "Unknown")
    }

    // MARK: - Consent text

    func testConsentTextNoExtras() {
        let r = row(hasExtras: false)
        XCTAssertEqual(r.consentText, "No consent required")
    }

    func testConsentTextNoConsentRequired() {
        let r = row(requiredConsents: [], consented: [])
        XCTAssertEqual(r.consentText, "No consent required")
    }

    func testConsentTextFullyConsented() {
        let r = row(requiredConsents: ["exec"], consented: ["exec"])
        XCTAssertEqual(r.consentText, "Consented: exec")
    }

    func testConsentTextReportsOnlyMissingClasses() {
        let r = row(requiredConsents: ["exec", "tcc"], consented: ["exec"])
        XCTAssertEqual(r.consentText, "Needs consent: tcc")
    }

    // MARK: - Version

    func testVersionPassesThroughVerbatim() {
        XCTAssertEqual(row(version: "3.4.5").version, "3.4.5")
    }

    func testMissingVersionRendersEmDash() {
        XCTAssertEqual(row(version: nil).version, "—")
    }

    // MARK: - Identity

    func testRowIdIsTheQualifiedSpec() {
        let r = row(id: "sample-echo")
        XCTAssertEqual(r.spec, "sample-echo@winter-examples")
        XCTAssertEqual(r.id, r.spec)
        XCTAssertEqual(r.pluginId, "sample-echo")
    }
}

// -----------------------------------------------------------------------------------------------
// PluginManagerModel — async error-surfacing path (Fix wave 1, Task 2 review defect, carried
// through the WS-21 rewrite). A SEPARATE `@MainActor` test class (not folded into
// `PluginManagerModelTests` above) so that class's pure-`pluginRowDisplay` tests stay untouched.
// Uses the SAME scripted-transport double every other test file in this target uses to drive a
// real (actor) `WinterClient` end-to-end (`FeedScriptedTransport`/`feedLineJSON`/`feedWaitUntil`,
// defined in `SessionFeedTests.swift`, same target).
// -----------------------------------------------------------------------------------------------
@MainActor
final class PluginManagerModelAsyncTests: XCTestCase {
    /// Opens + hellos a scripted `WinterClient`, mirroring `PeripheralProviderTests.
    /// connectedProvider()`'s handshake exactly (send count 1 == `protocol.hello`).
    private func connectedClient() async throws -> (WinterClient, FeedScriptedTransport) {
        let t = FeedScriptedTransport()
        let client = WinterClient(makeTransport: { t }, token: "tok", clientName: "plugin-manager-test")
        async let c: Void = client.connect()
        await feedWaitUntil { !t.sent.isEmpty }
        let hello = feedLineJSON(t.sent[0])
        t.feed(#"{"jsonrpc":"2.0","id":\#(hello["id"] as! Int),"result":{"ok":true}}"#)
        try await c
        return (client, t)
    }

    /// `enable(_:)` on a spec `plugin.list` never reported is a silent no-op (no matching listing
    /// to act against) — no RPC beyond the initial `refresh()`-free handshake is sent.
    func testEnableOnUnknownSpecIsANoOp() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)

        await model.enable("ghost@nowhere")

        XCTAssertEqual(t.sent.count, 1, "hello only — no plugin.enable for a spec never listed")
        XCTAssertNil(model.consentSheet)
    }

    /// THE defect this fix wave closes (carried through WS-21): an action's own failure must
    /// survive the trailing `refresh()`, which clears `errorText` on ITS OWN success independent
    /// of whether the action failed.
    func testFailedActionErrorSurvivesTrailingRefresh() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)

        // Seed a listing via a first refresh so `disable("sample-echo@winter-examples")` has a
        // row to act against.
        async let firstRefresh: Void = model.refresh()
        await feedWaitUntil { t.sent.count >= 2 }
        let listReq1 = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq1["id"] as! Int),"result":{"plugins":[{"id":"sample-echo","installPath":"/p","scope":"user","enabled":true,"marketplace":"winter-examples"}]}}"#)
        await firstRefresh

        async let action: Void = model.disable("sample-echo@winter-examples")

        await feedWaitUntil { t.sent.count >= 3 }
        let disableReq = feedLineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(disableReq["id"] as! Int),"error":{"code":-32000,"message":"unknown plugin: sample-echo@winter-examples"}}"#)

        await feedWaitUntil { t.sent.count >= 4 }
        let listReq2 = feedLineJSON(t.sent[3])
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq2["id"] as! Int),"result":{"plugins":[]}}"#)

        await action

        XCTAssertEqual(model.errorText, "couldn't disable sample-echo@winter-examples — try again")
        XCTAssertTrue(model.rows.isEmpty)
    }

    /// A genuinely-successful action must still end with `errorText == nil` (clearing any stale
    /// error) — the normal `refresh()` clear already does this; this test pins that it keeps doing
    /// so under the fix (the fix only special-cases the FAILURE path).
    func testSuccessfulActionClearsStaleError() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        model.errorText = "stale error from a previous action"

        async let firstRefresh: Void = model.refresh()
        await feedWaitUntil { t.sent.count >= 2 }
        let listReq1 = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq1["id"] as! Int),"result":{"plugins":[{"id":"sample-echo","installPath":"/p","scope":"user","enabled":true,"marketplace":"winter-examples"}]}}"#)
        await firstRefresh

        async let action: Void = model.disable("sample-echo@winter-examples")

        await feedWaitUntil { t.sent.count >= 3 }
        let disableReq = feedLineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(disableReq["id"] as! Int),"result":{"ok":true,"spec":"sample-echo@winter-examples","scope":"user","enabled":false}}"#)

        await feedWaitUntil { t.sent.count >= 4 }
        let listReq2 = feedLineJSON(t.sent[3])
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq2["id"] as! Int),"result":{"plugins":[]}}"#)

        await action

        XCTAssertNil(model.errorText)
    }

    /// `onRefreshed` fires at the end of a `refresh()` call, independent of the view — the hook
    /// `PluginManagerView` wires to `shortcutsModel.refresh()`.
    func testOnRefreshedFiresAfterRefresh() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        var fireCount = 0
        model.onRefreshed = { fireCount += 1 }

        async let refresh: Void = model.refresh()

        await feedWaitUntil { t.sent.count >= 2 }
        let listReq = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"plugins":[]}}"#)

        await refresh

        XCTAssertEqual(fireCount, 1)
    }
}
