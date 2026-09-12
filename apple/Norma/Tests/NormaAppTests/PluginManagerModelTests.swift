import XCTest
import WinterKit
@testable import Winter

/// Task 2 (Phase 4d-iii): `pluginRowDisplay(...)` — the PURE `plugins.list` entry → row-display
/// mapping (tier badge / version / consent text / status text+color / action set). No
/// `WinterClient`, no SwiftUI — same "pure helper, table-tested directly" posture as
/// `DashboardTests`' coverage of `formatDaemonStatus`/`formatQuotaState`/`sortedTrustPaths`.
final class PluginManagerModelTests: XCTestCase {
    /// Convenience default-args wrapper so each test below only spells out the fields it's
    /// actually varying.
    private func row(
        name: String = "sample-echo",
        version: String? = "1.2.0",
        tier: String? = "platform",
        requiredConsents: [String] = [],
        consented: [String] = [],
        legacy: Bool = false,
        status: String? = "running",
        disabled: Bool = false
    ) -> PluginRowDisplay {
        pluginRowDisplay(
            name: name, version: version, tier: tier, requiredConsents: requiredConsents,
            consented: consented, legacy: legacy, status: status, disabled: disabled
        )
    }

    // MARK: - Action rule: running Tier-2 → [.restart, .disable, .remove]

    func testRunningTier2EnabledGetsRestartDisableRemove() {
        let r = row(tier: "platform", status: "running", disabled: false)
        XCTAssertEqual(r.tierBadge, "Tier 2")
        XCTAssertEqual(r.statusText, "Running")
        XCTAssertEqual(r.statusColorKind, .running)
        XCTAssertEqual(r.actions, [.restart, .disable, .remove])
    }

    /// The central "never offer .enable for an already-running plugin" carryover from 4d-ii —
    /// enabling a running plugin bounces it.
    func testNeverOffersEnableForARunningPlugin() {
        let r = row(status: "running", disabled: false)
        XCTAssertFalse(r.actions.contains(.enable))
    }

    // MARK: - Action rule: `.restart` ONLY for a running Tier-2 plugin — every other enabled,
    // non-running Tier-2 runtime state (stopped/backoff/circuit-open/starting) gets
    // [.disable, .remove], no restart button (recovery goes through disable→enable instead, which
    // hot-restarts the process server-side via `PluginSupervisor.restart`).

    func testStoppedTier2EnabledGetsDisableRemoveNoRestart() {
        let r = row(tier: "platform", status: "stopped", disabled: false)
        XCTAssertEqual(r.statusText, "Stopped")
        XCTAssertEqual(r.statusColorKind, .stopped)
        XCTAssertEqual(r.actions, [.disable, .remove])
    }

    func testBackoffTier2EnabledGetsDisableRemoveNoRestart() {
        let r = row(tier: "platform", status: "backoff", disabled: false)
        XCTAssertEqual(r.statusText, "Backoff")
        XCTAssertEqual(r.statusColorKind, .backoff)
        XCTAssertEqual(r.actions, [.disable, .remove])
    }

    func testCircuitOpenTier2EnabledGetsDisableRemoveNoRestart() {
        let r = row(tier: "platform", status: "circuit-open", disabled: false)
        XCTAssertEqual(r.statusText, "Circuit open")
        XCTAssertEqual(r.statusColorKind, .circuitOpen)
        XCTAssertEqual(r.actions, [.disable, .remove])
    }

    func testStartingTier2EnabledGetsDisableRemoveNoRestart() {
        let r = row(tier: "platform", status: "starting", disabled: false)
        XCTAssertEqual(r.statusText, "Starting")
        XCTAssertEqual(r.statusColorKind, .starting)
        XCTAssertEqual(r.actions, [.disable, .remove])
    }

    func testRestartIsNeverOfferedOutsideRunning() {
        for status in ["stopped", "backoff", "circuit-open", "starting", "na", nil] {
            let r = row(status: status, disabled: false)
            XCTAssertFalse(r.actions.contains(.restart), "status \(status ?? "nil") must not offer .restart")
        }
    }

    // MARK: - Action rule: DISABLED (any tier/status) → [.enable, .remove]

    func testDisabledTier2GetsEnableRemove() {
        let r = row(tier: "platform", status: "na", disabled: true)
        XCTAssertEqual(r.statusText, "Disabled")
        XCTAssertEqual(r.statusColorKind, .disabled)
        XCTAssertEqual(r.actions, [.enable, .remove])
    }

    func testDisabledTier1GetsEnableRemove() {
        let r = row(tier: "capability", status: "na", disabled: true)
        XCTAssertEqual(r.statusText, "Disabled")
        XCTAssertEqual(r.statusColorKind, .disabled)
        XCTAssertEqual(r.actions, [.enable, .remove])
    }

    /// `disabled` is checked BEFORE `status` — a stale/inconsistent "running" status on a disabled
    /// row (shouldn't happen server-side, but the mapping must still fail toward "Disabled", never
    /// toward offering a Restart on a plugin the user just turned off) still reads as disabled.
    func testDisabledTakesPriorityOverAnyReportedStatus() {
        let r = row(status: "running", disabled: true)
        XCTAssertEqual(r.statusText, "Disabled")
        XCTAssertEqual(r.statusColorKind, .disabled)
        XCTAssertEqual(r.actions, [.enable, .remove])
        XCTAssertFalse(r.actions.contains(.restart))
    }

    // MARK: - Action rule: na/Tier-1/legacy (enabled) → [.disable, .remove], NO running indicator

    func testTier1EnabledNaGetsDisableRemove() {
        let r = row(tier: "capability", status: "na", disabled: false)
        XCTAssertEqual(r.tierBadge, "Tier 1")
        XCTAssertEqual(r.statusText, "N/A")
        XCTAssertEqual(r.statusColorKind, .na)
        XCTAssertEqual(r.actions, [.disable, .remove])
    }

    func testLegacyPluginGetsLegacyBadgeAndNaBehavior() {
        let r = row(tier: nil, legacy: true, status: nil, disabled: false)
        XCTAssertEqual(r.tierBadge, "Legacy")
        XCTAssertEqual(r.statusText, "N/A")
        XCTAssertEqual(r.statusColorKind, .na)
        XCTAssertEqual(r.actions, [.disable, .remove])
    }

    func testUnrecognizedTierNonLegacyGetsUnknownBadge() {
        let r = row(tier: nil, legacy: false)
        XCTAssertEqual(r.tierBadge, "Unknown")
    }

    // MARK: - `na` must render DISTINCTLY from every Tier-2 runtime state (and `disabled`)

    func testNaColorKindIsDistinctFromEveryOtherKind() {
        let others: Set<PluginStatusColorKind> = [.running, .starting, .stopped, .backoff, .circuitOpen, .disabled]
        XCTAssertFalse(others.contains(.na))
    }

    func testNaAndStoppedAreDifferentRenderStates() {
        let na = row(tier: "capability", status: "na", disabled: false)
        let stopped = row(tier: "platform", status: "stopped", disabled: false)
        XCTAssertNotEqual(na.statusColorKind, stopped.statusColorKind)
        XCTAssertNotEqual(na.statusText, stopped.statusText)
    }

    // MARK: - Consent text

    func testConsentTextNoConsentRequired() {
        let r = row(requiredConsents: [], consented: [])
        XCTAssertEqual(r.consentText, "No consent required")
    }

    func testConsentTextFullyConsented() {
        let r = row(requiredConsents: ["network"], consented: ["network"])
        XCTAssertEqual(r.consentText, "Consented: network")
    }

    func testConsentTextReportsOnlyMissingClasses() {
        let r = row(requiredConsents: ["network", "fs"], consented: ["network"])
        XCTAssertEqual(r.consentText, "Needs consent: fs")
    }

    // MARK: - Version

    func testVersionPassesThroughVerbatim() {
        XCTAssertEqual(row(version: "3.4.5").version, "3.4.5")
    }

    func testMissingVersionRendersEmDash() {
        XCTAssertEqual(row(version: nil).version, "—")
    }

    // MARK: - Identifiable

    func testRowIdIsThePluginName() {
        XCTAssertEqual(row(name: "sample-echo").id, "sample-echo")
    }

    // MARK: - `settleShouldContinue` (4d gate-fix loop 1, UX fix #1): the settle loop's PURE
    // CONTINUE/STOP decision — continues only while a row is STILL "starting" and under the 15s
    // bound; stops for every other status (or `nil`) regardless of elapsed time, and for "starting"
    // itself once the bound is reached.

    func testSettleContinuesWhileStartingUnder15Seconds() {
        XCTAssertTrue(settleShouldContinue(status: "starting", elapsedSeconds: 0))
        XCTAssertTrue(settleShouldContinue(status: "starting", elapsedSeconds: 14.9))
    }

    func testSettleStopsOnceStartingReaches15Seconds() {
        // Exact boundary: `elapsedSeconds == 15` must stop (strict `<`, not `<=`).
        XCTAssertFalse(settleShouldContinue(status: "starting", elapsedSeconds: 15))
        XCTAssertFalse(settleShouldContinue(status: "starting", elapsedSeconds: 20))
    }

    func testSettleStopsForEveryNonStartingStatusRegardlessOfElapsed() {
        for status in ["running", "stopped", "backoff", "circuit-open", "na", nil] {
            XCTAssertFalse(settleShouldContinue(status: status, elapsedSeconds: 0), "status \(status ?? "nil") must stop immediately")
            XCTAssertFalse(settleShouldContinue(status: status, elapsedSeconds: 10), "status \(status ?? "nil") must stay stopped")
        }
    }
}

// -----------------------------------------------------------------------------------------------
// PluginManagerModel — async error-surfacing path (Fix wave 1, Task 2 review defect). A SEPARATE
// `@MainActor` test class (not folded into `PluginManagerModelTests` above) so that class's 21
// pure-`pluginRowDisplay` tests stay byte-for-byte untouched, per the fix brief. Uses the SAME
// scripted-transport double every other test file in this target uses to drive a real (actor)
// `WinterClient` end-to-end (`FeedScriptedTransport`/`feedLineJSON`/`feedWaitUntil`, defined in
// `SessionFeedTests.swift`, same target) — `PluginManagerModel` takes a concrete `WinterClient`,
// but that client is ALREADY mockable at the transport layer (see `PeripheralProviderTests.
// connectedProvider()`/`HardwareBridgeTests.connectedBridge()`), so no new protocol seam is
// introduced here.
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

    /// THE defect this fix wave closes: `enable`'s `.unknownPlugin` branch used to write
    /// `errorText` directly, then unconditionally `await refresh()` — whose SUCCESS path
    /// unconditionally nils `errorText` — wiping the action's error the instant `plugins.list`
    /// (called independently of whether the action failed) came back clean. Pre-fix this test
    /// fails (`model.errorText` ends up `nil`); post-fix the action error is the LAST write and
    /// survives the trailing refresh.
    func testFailedActionErrorSurvivesTrailingRefresh() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)

        async let action: Void = model.enable("ghost")

        // Request #2 (after hello): `plugin.enable` — respond with the typed `unknown_plugin`
        // failure result (methods.ts `PluginEnableResult`), NOT a thrown RpcError.
        await feedWaitUntil { t.sent.count >= 2 }
        let enableReq = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(enableReq["id"] as! Int),"result":{"code":"unknown_plugin"}}"#)

        // Request #3: the action's trailing `refresh()` → `plugins.list` — succeeds with an empty
        // list, exercising the exact "refresh succeeds independently of the action's failure" path
        // that used to wipe the error.
        await feedWaitUntil { t.sent.count >= 3 }
        let listReq = feedLineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"plugins":[]}}"#)

        await action

        XCTAssertEqual(model.errorText, "unknown plugin: ghost")
        XCTAssertTrue(model.rows.isEmpty)
        // Re-targeted from the deleted `pendingConsent` field (Task 2 review fix wave): an
        // `.unknownPlugin` outcome must not spuriously open the consent sheet either.
        XCTAssertNil(model.consentSheet)
    }

    /// A genuinely-successful action must still end with `errorText == nil` (clearing any stale
    /// error) — the normal `refresh()` clear already does this; this test pins that it keeps doing
    /// so under the fix (the fix only special-cases the FAILURE path).
    func testSuccessfulActionClearsStaleError() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        model.errorText = "stale error from a previous action"

        async let action: Void = model.disable("sample-echo")

        await feedWaitUntil { t.sent.count >= 2 }
        let disableReq = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(disableReq["id"] as! Int),"result":{"ok":true}}"#)

        await feedWaitUntil { t.sent.count >= 3 }
        let listReq = feedLineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"plugins":[]}}"#)

        await action

        XCTAssertNil(model.errorText)
    }

    /// UX fix #2 (4d gate-fix loop 1): `onRefreshed` is the hook `PluginManagerView` wires to
    /// `shortcutsModel.refresh()` (and every settle-loop tick funnels through it too) so a newly
    /// installed plugin's declared shortcuts show up without the dashboard being closed/reopened —
    /// this pins that it fires at the end of a `refresh()` call, independent of the view.
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
