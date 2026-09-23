import XCTest
import WinterKit
@testable import Winter

/// WS-21 rewrite (fix round 1, 2026-09-24): `ConsentSheetState` — the PURE state machine backing
/// the plugin install/enable consent sheet, seeded from a `plugin.list` row's `PluginExtras`. No
/// `WinterClient`, no SwiftUI — same "pure model, table-tested directly" posture as
/// `PluginManagerModelTests`' coverage of `pluginRowDisplay`.
final class ConsentSheetStateTests: XCTestCase {
    private func extras(
        tier: String = "platform",
        exec: Bool = true,
        tcc: [String] = ["microphone"],
        hardware: [String] = [],
        required: [String] = ["exec", "tcc"],
        consented: [String] = []
    ) -> PluginExtras {
        PluginExtras(tier: tier, execPermission: exec, tccPermissions: tcc, hardwarePermissions: hardware,
                    requiredConsents: required, consented: consented,
                    entry: PluginEntryInfo(command: "node", args: ["./server.js", "--port", "4000"]))
    }

    // MARK: - Construction

    func testConstructsWithPluginIdSpecScopeExtrasAndOpenedByInstall() {
        let e = extras()
        let state = ConsentSheetState(pluginId: "demo", spec: "demo@winter-examples", scope: .user,
                                      extras: e, openedByInstall: true)
        XCTAssertEqual(state.pluginId, "demo")
        XCTAssertEqual(state.spec, "demo@winter-examples")
        XCTAssertEqual(state.scope, .user)
        XCTAssertEqual(state.extras, e)
        XCTAssertTrue(state.openedByInstall)
        XCTAssertEqual(state.decision, .pending)
    }

    /// Fix round 1 (I2): the two triggers are distinguishable — `PluginManagerModel.cancelConsent()`
    /// reads this to decide whether declining needs a follow-up `pluginDisable`.
    func testOpenedByInstallDistinguishesTheTwoTriggers() {
        let fromInstall = ConsentSheetState(pluginId: "demo", spec: "demo@m", scope: .user, extras: extras(), openedByInstall: true)
        let fromEnable = ConsentSheetState(pluginId: "demo", spec: "demo@m", scope: .user, extras: extras(), openedByInstall: false)
        XCTAssertTrue(fromInstall.openedByInstall)
        XCTAssertFalse(fromEnable.openedByInstall)
    }

    func testPendingConsentsIsExtrasOwnPendingConsents() {
        let e = extras(required: ["exec", "tcc", "hardware"], consented: ["exec"])
        let state = ConsentSheetState(pluginId: "demo", spec: "demo@winter-examples", scope: .user,
                                      extras: e, openedByInstall: false)
        XCTAssertEqual(state.pendingConsents, ["tcc", "hardware"])
    }

    // MARK: - `confirm()`/`cancel()` state transitions

    func testStartsPending() {
        let state = ConsentSheetState(pluginId: "demo", spec: "demo@winter-examples", scope: .user,
                                      extras: extras(), openedByInstall: false)
        XCTAssertEqual(state.decision, .pending)
    }

    /// `confirm()` maps to "call `pluginSetConsent` then `pluginEnable`" — this type only records
    /// the intent; `PluginManagerModel.confirmConsent()` is what actually performs the calls.
    func testConfirmTransitionsToConfirmed() {
        var state = ConsentSheetState(pluginId: "demo", spec: "demo@winter-examples", scope: .user,
                                      extras: extras(), openedByInstall: false)
        state.confirm()
        XCTAssertEqual(state.decision, .confirmed)
    }

    /// `cancel()` dismisses without granting consent or enabling — a distinct terminal state from
    /// `.confirmed`.
    func testCancelTransitionsToCancelled() {
        var state = ConsentSheetState(pluginId: "demo", spec: "demo@winter-examples", scope: .user,
                                      extras: extras(), openedByInstall: false)
        state.cancel()
        XCTAssertEqual(state.decision, .cancelled)
    }

    func testIdentifiableIdIsTheQualifiedSpec() {
        let state = ConsentSheetState(pluginId: "demo", spec: "demo@winter-examples", scope: .user,
                                      extras: extras(), openedByInstall: false)
        XCTAssertEqual(state.id, "demo@winter-examples")
    }
}

// -----------------------------------------------------------------------------------------------
// `pluginConsentDisclosureLines` — the pure daemon-data → disclosure-lines mapping `ConsentSheet`
// renders verbatim (`ConsentSheet.swift`). Sourced from `PluginExtras`' own fields (the daemon's
// `winter-plugin.json` read), never fabricated or summarized — each declared permission gets its
// own line.
// -----------------------------------------------------------------------------------------------

final class PluginConsentDisclosureLinesTests: XCTestCase {
    func testListsTheEntryCommandWhenExecIsRequested() {
        let e = PluginExtras(tier: "platform", execPermission: true, tccPermissions: [], hardwarePermissions: [],
                             requiredConsents: ["exec"], consented: [],
                             entry: PluginEntryInfo(command: "node", args: ["server.js", "--port", "4000"]))
        let lines = pluginConsentDisclosureLines(pluginId: "demo", extras: e)
        XCTAssertTrue(lines.contains("- run its own background process: node server.js --port 4000"))
    }

    func testListsEachTccAndHardwarePermissionOnItsOwnLine() {
        let e = PluginExtras(tier: "platform", execPermission: false, tccPermissions: ["microphone", "camera"],
                             hardwarePermissions: ["battery"], requiredConsents: ["tcc", "hardware"],
                             consented: [], entry: nil)
        let lines = pluginConsentDisclosureLines(pluginId: "demo", extras: e)
        XCTAssertTrue(lines.contains("- will request macOS permission: microphone"))
        XCTAssertTrue(lines.contains("- will request macOS permission: camera"))
        XCTAssertTrue(lines.contains("- hardware access via Winter.app's helper: battery"))
    }

    func testOmitsTheExecLineWhenExecPermissionIsFalse() {
        let e = PluginExtras(tier: "capability", execPermission: false, tccPermissions: [], hardwarePermissions: [],
                             requiredConsents: [], consented: [], entry: nil)
        let lines = pluginConsentDisclosureLines(pluginId: "demo", extras: e)
        XCTAssertFalse(lines.contains { $0.contains("background process") })
    }

    /// `execPermission` alone can be absent/false while `requiredConsents` still lists `"exec"` —
    /// the exec line must still show, not render as a bare, contentless header.
    func testListsTheExecLineWhenRequiredConsentsSaysExecEvenIfPermissionFlagIsAbsent() {
        let e = PluginExtras(tier: "platform", execPermission: false, tccPermissions: [], hardwarePermissions: [],
                             requiredConsents: ["exec"], consented: [], entry: nil)
        let lines = pluginConsentDisclosureLines(pluginId: "demo", extras: e)
        XCTAssertTrue(lines.contains { $0.contains("background process") })
    }

    /// Same for a declared `entry` with no `execPermission`/`requiredConsents` echo.
    func testListsTheExecLineWhenEntryIsDeclaredEvenIfPermissionFlagIsAbsent() {
        let e = PluginExtras(tier: "platform", execPermission: false, tccPermissions: [], hardwarePermissions: [],
                             requiredConsents: [], consented: [], entry: PluginEntryInfo(command: "node", args: []))
        let lines = pluginConsentDisclosureLines(pluginId: "demo", extras: e)
        XCTAssertTrue(lines.contains("- run its own background process: node"))
    }
}

// -----------------------------------------------------------------------------------------------
// `directoryMarketplacePluginNames`/`readDirectoryMarketplaceManifest` — the real-filesystem (not
// `WinterClient`) install helpers. Directly testable against a real temp directory rather than
// mocked.
// -----------------------------------------------------------------------------------------------

final class DirectoryMarketplacePluginNamesTests: XCTestCase {
    private var tempDir: URL!

    override func setUpWithError() throws {
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("winter-marketplace-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tempDir)
    }

    private func writeManifest(_ json: String) throws {
        let dir = tempDir.appendingPathComponent(".claude-plugin", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data(json.utf8).write(to: dir.appendingPathComponent("marketplace.json"))
    }

    func testReadsPluginNamesFromTheManifest() throws {
        try writeManifest(#"{"name":"winter-examples","plugins":[{"name":"battery-limiter","source":"./battery-limiter"},{"name":"sample-echo","source":"./sample-echo"}]}"#)
        XCTAssertEqual(try directoryMarketplacePluginNames(at: tempDir), ["battery-limiter", "sample-echo"])
    }

    func testSinglePluginManifestReadsOneName() throws {
        try writeManifest(#"{"name":"demo-mkt","plugins":[{"name":"demo","source":"."}]}"#)
        XCTAssertEqual(try directoryMarketplacePluginNames(at: tempDir), ["demo"])
    }

    func testThrowsWhenNoManifestExists() {
        XCTAssertThrowsError(try directoryMarketplacePluginNames(at: tempDir)) { error in
            XCTAssertTrue((error as? PluginFolderReadError)?.message.contains("no marketplace manifest there") ?? false)
        }
    }

    func testThrowsOnMalformedManifest() throws {
        let dir = tempDir.appendingPathComponent(".claude-plugin", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: dir.appendingPathComponent("marketplace.json"))
        XCTAssertThrowsError(try directoryMarketplacePluginNames(at: tempDir))
    }

    func testDropsEntriesWithNoName() throws {
        try writeManifest(#"{"name":"mkt","plugins":[{"source":"./a"},{"name":"b","source":"./b"}]}"#)
        XCTAssertEqual(try directoryMarketplacePluginNames(at: tempDir), ["b"])
    }

    /// Fix round 1 (C1): `readDirectoryMarketplaceManifest` also reads the marketplace's own NAME —
    /// what `plugin.marketplace.add` will register it as — so `installFromFolder` can check for a
    /// collision BEFORE ever calling it.
    func testReadDirectoryMarketplaceManifestReadsTheMarketplaceName() throws {
        try writeManifest(#"{"name":"winter-examples","plugins":[{"name":"demo","source":"."}]}"#)
        let manifest = try readDirectoryMarketplaceManifest(at: tempDir)
        XCTAssertEqual(manifest.name, "winter-examples")
        XCTAssertEqual(manifest.pluginNames, ["demo"])
    }

    func testReadDirectoryMarketplaceManifestThrowsWhenNameIsMissing() throws {
        try writeManifest(#"{"plugins":[{"name":"demo","source":"."}]}"#)
        XCTAssertThrowsError(try readDirectoryMarketplaceManifest(at: tempDir)) { error in
            XCTAssertTrue((error as? PluginFolderReadError)?.message.contains("no name") ?? false)
        }
    }
}

// -----------------------------------------------------------------------------------------------
// PluginManagerModel — the consent-sheet-driving methods (`enable`'s pending-consent path,
// `installFromFolder`, `confirmConsent`, `cancelConsent`), plus fix round 1's C1/C2/I1/I2/M-item
// coverage. A SEPARATE `@MainActor` test class, same posture as `PluginManagerModelAsyncTests`
// (`PluginManagerModelTests.swift`) — drives a real (actor) `WinterClient` end-to-end via the same
// scripted-transport double (`FeedScriptedTransport`/`feedLineJSON`/`feedWaitUntil`,
// `SessionFeedTests.swift`, same target).
// -----------------------------------------------------------------------------------------------
@MainActor
final class PluginManagerModelConsentTests: XCTestCase {
    private func connectedClient() async throws -> (WinterClient, FeedScriptedTransport) {
        let t = FeedScriptedTransport()
        let client = WinterClient(makeTransport: { t }, token: "tok", clientName: "consent-sheet-test")
        async let c: Void = client.connect()
        await feedWaitUntil { !t.sent.isEmpty }
        let hello = feedLineJSON(t.sent[0])
        t.feed(#"{"jsonrpc":"2.0","id":\#(hello["id"] as! Int),"result":{"ok":true}}"#)
        try await c
        return (client, t)
    }

    private let echoListing = #"{"id":"demo","installPath":"/p","scope":"user","enabled":true,"marketplace":"winter-examples","extras":{"tier":"platform","permissions":{"exec":true},"requiredConsents":["exec"],"consented":[]}}"#
    /// Same plugin, but the daemon's fingerprint already reads it consented (a reinstall to the
    /// identical path/entry) — used to prove C1's "always show the sheet on fresh install anyway".
    private let echoListingAlreadyConsented = #"{"id":"demo","installPath":"/p","scope":"user","enabled":true,"marketplace":"winter-examples","extras":{"tier":"platform","permissions":{"exec":true},"requiredConsents":["exec"],"consented":["exec"]}}"#

    private func feedNextResult(_ t: FeedScriptedTransport, index: Int, result: String) async {
        await feedWaitUntil { t.sent.count > index }
        let req = feedLineJSON(t.sent[index])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":\#(result)}"#)
    }

    private func feedNextRequest(_ t: FeedScriptedTransport, index: Int) async -> [String: Any] {
        await feedWaitUntil { t.sent.count > index }
        return feedLineJSON(t.sent[index])
    }

    /// Fix round 1 (M5): `enable(_:)` refreshes FIRST, so it sends its OWN `plugin.list` before
    /// ever deciding whether a sheet is needed — this pins that ordering, not just the "no
    /// plugin.enable RPC" outcome the pre-round test already covered.
    func testEnableOnPendingConsentRowRefreshesFirstThenOpensSheetWithoutAnyEnableCall() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)

        async let action: Void = model.enable("demo@winter-examples")

        // enable(_:)'s OWN refresh — sent even though nothing was loaded yet.
        let listReq = await feedNextRequest(t, index: 1)
        XCTAssertEqual(listReq["method"] as? String, "plugin.list")
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"plugins":[\#(echoListing)]}}"#)

        await action

        XCTAssertEqual(t.sent.count, 2, "hello + enable(_:)'s own refresh — no plugin.enable sent")
        XCTAssertEqual(model.consentSheet?.pluginId, "demo")
        XCTAssertEqual(model.consentSheet?.spec, "demo@winter-examples")
        XCTAssertEqual(model.consentSheet?.pendingConsents, ["exec"])
        XCTAssertFalse(model.consentSheet?.openedByInstall ?? true, "an existing-row enable, not an install")
    }

    /// `confirmConsent()` calls `plugin.setConsent {spec, classes}` FIRST (fix round 1: `spec`
    /// replaces `name`), then `plugin.enable` — the daemon's `plugin.enable` handler hot-spawns
    /// synchronously and reads consent right then.
    func testConfirmConsentSendsSpecCallsSetConsentThenEnableInOrderAndDismisses() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        let extras = PluginExtras(tier: "platform", execPermission: true, tccPermissions: [], hardwarePermissions: [],
                                  requiredConsents: ["exec"], consented: [], entry: nil)
        model.consentSheet = ConsentSheetState(pluginId: "demo", spec: "demo@winter-examples", scope: .user,
                                               extras: extras, openedByInstall: false)

        async let action: Void = model.confirmConsent()

        let setConsentReq = await feedNextRequest(t, index: 1)
        XCTAssertEqual(setConsentReq["method"] as? String, "plugin.setConsent")
        let setConsentParams = setConsentReq["params"] as? [String: Any]
        XCTAssertEqual(setConsentParams?["spec"] as? String, "demo@winter-examples")
        XCTAssertNil(setConsentParams?["name"], "the retired name param must not still be sent")
        XCTAssertEqual(setConsentParams?["classes"] as? [String], ["exec"])
        t.feed(#"{"jsonrpc":"2.0","id":\#(setConsentReq["id"] as! Int),"result":{"ok":true}}"#)

        let enableReq = await feedNextRequest(t, index: 2)
        XCTAssertEqual(enableReq["method"] as? String, "plugin.enable")
        let enableParams = enableReq["params"] as? [String: Any]
        XCTAssertEqual(enableParams?["spec"] as? String, "demo@winter-examples")
        XCTAssertEqual(enableParams?["scope"] as? String, "user")
        t.feed(#"{"jsonrpc":"2.0","id":\#(enableReq["id"] as! Int),"result":{"ok":true,"spec":"demo@winter-examples","scope":"user","enabled":true}}"#)

        await feedNextResult(t, index: 3, result: #"{"plugins":[]}"#)

        await action

        XCTAssertNil(model.consentSheet)
        XCTAssertNil(model.errorText)

        // Fix round 2 (I2, "don't touch the confirm path"): a successful confirm still triggers
        // SwiftUI's `onDismiss` in production (its own `consentSheet = nil` IS a dismissal) — this
        // must NOT re-run the install-declined follow-up. `dismissHandledByConfirm` is what
        // prevents it; simulating the `onDismiss` call here proves it holds.
        await model.consentSheetDismissed()
        XCTAssertEqual(t.sent.count, 4, "no extra plugin.disable/plugin.list after a successful confirm's own dismissal")
        XCTAssertNil(model.noticeText)
    }

    /// C1: `confirmConsent()` grants EVERY class in `extras.requiredConsents`, not just
    /// `pendingConsents` — a fresh confirmation re-affirms the whole disclosure, not a stale delta.
    func testConfirmConsentGrantsEveryRequiredClassNotJustPending() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        let extras = PluginExtras(tier: "platform", execPermission: true, tccPermissions: ["microphone"], hardwarePermissions: [],
                                  requiredConsents: ["exec", "tcc"], consented: ["exec"], entry: nil)
        model.consentSheet = ConsentSheetState(pluginId: "demo", spec: "demo@winter-examples", scope: .user,
                                               extras: extras, openedByInstall: true)
        XCTAssertEqual(model.consentSheet?.pendingConsents, ["tcc"], "sanity: only tcc is still pending")

        async let action: Void = model.confirmConsent()
        let setConsentReq = await feedNextRequest(t, index: 1)
        XCTAssertEqual((setConsentReq["params"] as? [String: Any])?["classes"] as? [String], ["exec", "tcc"],
                       "grants the FULL required set, not the ['tcc'] pending delta")
        t.feed(#"{"jsonrpc":"2.0","id":\#(setConsentReq["id"] as! Int),"result":{"ok":true}}"#)
        let enableReq = await feedNextRequest(t, index: 2)
        t.feed(#"{"jsonrpc":"2.0","id":\#(enableReq["id"] as! Int),"result":{"ok":true,"spec":"demo@winter-examples","scope":"user","enabled":true}}"#)
        await feedNextResult(t, index: 3, result: #"{"plugins":[]}"#)
        await action
    }

    /// I1: an `.unknownPlugin` refusal from `pluginSetConsent` must not fall through to
    /// `pluginEnable` — the sheet stays open (never nil'd) and the error surfaces.
    func testConfirmConsentKeepsSheetOpenAndSkipsEnableOnUnknownPlugin() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        let extras = PluginExtras(tier: "platform", execPermission: true, tccPermissions: [], hardwarePermissions: [],
                                  requiredConsents: ["exec"], consented: [], entry: nil)
        model.consentSheet = ConsentSheetState(pluginId: "ghost", spec: "ghost@winter-examples", scope: .user,
                                               extras: extras, openedByInstall: false)

        async let action: Void = model.confirmConsent()
        let setConsentReq = await feedNextRequest(t, index: 1)
        XCTAssertEqual(setConsentReq["method"] as? String, "plugin.setConsent")
        t.feed(#"{"jsonrpc":"2.0","id":\#(setConsentReq["id"] as! Int),"result":{"code":"unknown_plugin"}}"#)

        // No plugin.enable — the very next request is the trailing refresh's plugin.list.
        let refreshReq = await feedNextRequest(t, index: 2)
        XCTAssertEqual(refreshReq["method"] as? String, "plugin.list", "pluginEnable must be skipped entirely")
        t.feed(#"{"jsonrpc":"2.0","id":\#(refreshReq["id"] as! Int),"result":{"plugins":[]}}"#)

        await action

        XCTAssertNotNil(model.consentSheet, "the sheet stays open on an unknownPlugin refusal")
        XCTAssertEqual(model.errorText, "ghost is no longer installed — couldn't record consent")
    }

    /// Fix round 2 (I2): `consentSheetDismissed()` for an ENABLE-triggered sheet (not an install)
    /// runs without ever calling `pluginDisable` — no RPC beyond the initial handshake is sent.
    /// `model.consentSheet = nil` here stands in for EITHER the sheet's Cancel button (`onCancel`
    /// is now just this same assignment, no model method) or a swipe/Esc (SwiftUI does the
    /// identical assignment itself) — from the model's side the two are indistinguishable, which
    /// is the whole point of routing both through the same `onDismiss` hook.
    func testConsentSheetDismissedOnAnEnableTriggeredSheetSendsNoCall() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        let extras = PluginExtras(tier: "platform", execPermission: true, tccPermissions: [], hardwarePermissions: [],
                                  requiredConsents: ["exec"], consented: [], entry: nil)
        model.consentSheet = ConsentSheetState(pluginId: "demo", spec: "demo@winter-examples", scope: .user,
                                               extras: extras, openedByInstall: false)

        model.consentSheet = nil
        await model.consentSheetDismissed()

        XCTAssertNil(model.consentSheet)
        XCTAssertEqual(t.sent.count, 1) // hello only
        XCTAssertNil(model.noticeText)
    }

    /// I2: `consentSheetDismissed()` for an INSTALL-triggered sheet turns the plugin back off (a
    /// fresh install lands enabled regardless of consent, spec §5.4) and leaves one explanatory
    /// line — exercised here via the sheet's own Cancel button path (`onCancel`'s `consentSheet =
    /// nil`, immediately followed by the `onDismiss` hook it triggers).
    func testConsentSheetDismissedViaCancelButtonOnAnInstallTriggeredSheetDisablesAndShowsNotice() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        let extras = PluginExtras(tier: "platform", execPermission: true, tccPermissions: [], hardwarePermissions: [],
                                  requiredConsents: ["exec"], consented: [], entry: nil)
        model.consentSheet = ConsentSheetState(pluginId: "demo", spec: "demo@winter-examples", scope: .user,
                                               extras: extras, openedByInstall: true)

        model.consentSheet = nil // `onCancel: { model.consentSheet = nil }`
        async let action: Void = model.consentSheetDismissed() // the `onDismiss` this triggers

        let disableReq = await feedNextRequest(t, index: 1)
        XCTAssertEqual(disableReq["method"] as? String, "plugin.disable")
        XCTAssertEqual((disableReq["params"] as? [String: Any])?["spec"] as? String, "demo@winter-examples")
        t.feed(#"{"jsonrpc":"2.0","id":\#(disableReq["id"] as! Int),"result":{"ok":true,"spec":"demo@winter-examples","scope":"user","enabled":false}}"#)

        await feedNextResult(t, index: 2, result: #"{"plugins":[]}"#)

        await action

        XCTAssertNil(model.consentSheet)
        XCTAssertEqual(model.noticeText, "Installed but turned off — enable it to review its permissions again.")
    }

    /// Controller-requested (I2 round 2): dismisses the sheet WITHOUT ever going through the
    /// Cancel button/method — `model.consentSheet = nil` here is exactly what a swipe-down or Esc
    /// does to the `.sheet(item:)` binding directly, bypassing `ConsentSheet`'s `onCancel` closure
    /// entirely; `consentSheetDismissed()` is exactly what `.sheet(item:onDismiss:)`'s `onDismiss`
    /// then calls. `pluginDisable` still fires — proving the follow-up is reachable from the
    /// dismissal itself, not from any one button's call site.
    func testDismissingWithoutCancelStillSendsPluginDisableForAnInstallTriggeredSheet() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        let extras = PluginExtras(tier: "platform", execPermission: true, tccPermissions: [], hardwarePermissions: [],
                                  requiredConsents: ["exec"], consented: [], entry: nil)
        model.consentSheet = ConsentSheetState(pluginId: "demo", spec: "demo@winter-examples", scope: .user,
                                               extras: extras, openedByInstall: true)

        // A swipe/Esc: SwiftUI nils the bound item directly — no `onCancel`, no "cancel" of any
        // kind is ever invoked.
        model.consentSheet = nil
        async let action: Void = model.consentSheetDismissed()

        let disableReq = await feedNextRequest(t, index: 1)
        XCTAssertEqual(disableReq["method"] as? String, "plugin.disable")
        XCTAssertEqual((disableReq["params"] as? [String: Any])?["spec"] as? String, "demo@winter-examples")
        t.feed(#"{"jsonrpc":"2.0","id":\#(disableReq["id"] as! Int),"result":{"ok":true,"spec":"demo@winter-examples","scope":"user","enabled":false}}"#)
        await feedNextResult(t, index: 2, result: #"{"plugins":[]}"#)

        await action

        XCTAssertEqual(model.noticeText, "Installed but turned off — enable it to review its permissions again.")
    }

    /// Fix wave (consent double-submit guard, carried through WS-21): a second `confirmConsent()`
    /// call landing while the first is still in flight is a no-op.
    func testConfirmConsentIgnoresReentryWhileFirstCallInFlight() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        let extras = PluginExtras(tier: "platform", execPermission: true, tccPermissions: [], hardwarePermissions: [],
                                  requiredConsents: ["exec"], consented: [], entry: nil)
        model.consentSheet = ConsentSheetState(pluginId: "demo", spec: "demo@winter-examples", scope: .user,
                                               extras: extras, openedByInstall: false)

        async let action1: Void = model.confirmConsent()
        async let action2: Void = model.confirmConsent()

        let setConsentReq = await feedNextRequest(t, index: 1)
        t.feed(#"{"jsonrpc":"2.0","id":\#(setConsentReq["id"] as! Int),"result":{"ok":true}}"#)

        let enableReq = await feedNextRequest(t, index: 2)
        t.feed(#"{"jsonrpc":"2.0","id":\#(enableReq["id"] as! Int),"result":{"ok":true,"spec":"demo@winter-examples","scope":"user","enabled":true}}"#)

        await feedNextResult(t, index: 3, result: #"{"plugins":[]}"#)

        _ = await (action1, action2)

        // hello + the ONE plugin.setConsent + the ONE plugin.enable + its trailing refresh — the
        // second `confirmConsent()` call sent nothing at all.
        XCTAssertEqual(t.sent.count, 4)
        XCTAssertNil(model.consentSheet)
    }

    private func makeMarketplaceDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("winter-install-test-\(UUID().uuidString)", isDirectory: true)
        let manifestDir = dir.appendingPathComponent(".claude-plugin", isDirectory: true)
        try FileManager.default.createDirectory(at: manifestDir, withIntermediateDirectories: true)
        try Data(#"{"name":"winter-examples","plugins":[{"name":"demo","source":"."}]}"#.utf8)
            .write(to: manifestDir.appendingPathComponent("marketplace.json"))
        return dir
    }

    /// `installFromFolder(_:)` checks `plugin.marketplace.list` FIRST (C1's collision check) before
    /// ever calling `plugin.marketplace.add` — this pins that new RPC and its ordering.
    func testInstallFromFolderChecksMarketplaceListBeforeAdding() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        let dir = try makeMarketplaceDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        async let action: Void = model.installFromFolder(dir)

        let listReq = await feedNextRequest(t, index: 1)
        XCTAssertEqual(listReq["method"] as? String, "plugin.marketplace.list")
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"marketplaces":[]}}"#)

        let addReq = await feedNextRequest(t, index: 2)
        XCTAssertEqual(addReq["method"] as? String, "plugin.marketplace.add")
        t.feed(#"{"jsonrpc":"2.0","id":\#(addReq["id"] as! Int),"result":{"ok":true,"marketplace":{"name":"winter-examples","source":"\#(dir.path)","kind":"directory","path":"\#(dir.path)"}}}"#)

        let installReq = await feedNextRequest(t, index: 3)
        XCTAssertEqual(installReq["method"] as? String, "plugin.install")
        t.feed(#"{"jsonrpc":"2.0","id":\#(installReq["id"] as! Int),"result":{"ok":true,"plugin":{"id":"demo","installPath":"\#(dir.path)","scope":"user"}}}"#)

        await feedNextResult(t, index: 4, result: #"{"plugins":[\#(echoListing)]}"#)

        await action

        XCTAssertEqual(model.consentSheet?.pluginId, "demo")
        XCTAssertTrue(model.consentSheet?.openedByInstall ?? false)
    }

    /// C1: a marketplace name collision with a DIFFERENT path is refused before `plugin.marketplace.
    /// add` is ever called — adding it again would silently repoint every plugin already installed
    /// from the old path.
    func testInstallFromFolderRefusesAMarketplaceNameCollisionWithADifferentPath() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        let dir = try makeMarketplaceDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        async let action: Void = model.installFromFolder(dir)

        let listReq = await feedNextRequest(t, index: 1)
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"marketplaces":[{"name":"winter-examples","source":"/somewhere/else","kind":"directory","path":"/somewhere/else"}]}}"#)

        await action

        XCTAssertEqual(t.sent.count, 2, "no marketplace.add/install/list — refused before any of them")
        XCTAssertNil(model.consentSheet)
        XCTAssertTrue(model.errorText?.contains("/somewhere/else") ?? false, "\(model.errorText ?? "nil")")
    }

    /// The SAME path re-adding itself is NOT a collision (idempotent re-add, e.g. reinstalling the
    /// identical folder) — installation proceeds normally.
    func testInstallFromFolderAllowsReaddingTheSamePath() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        let dir = try makeMarketplaceDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        async let action: Void = model.installFromFolder(dir)

        let listReq = await feedNextRequest(t, index: 1)
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"marketplaces":[{"name":"winter-examples","source":"\#(dir.path)","kind":"directory","path":"\#(dir.path)"}]}}"#)

        let addReq = await feedNextRequest(t, index: 2)
        XCTAssertEqual(addReq["method"] as? String, "plugin.marketplace.add", "the same path is not a collision")
        t.feed(#"{"jsonrpc":"2.0","id":\#(addReq["id"] as! Int),"result":{"ok":true,"marketplace":{"name":"winter-examples","source":"\#(dir.path)","kind":"directory","path":"\#(dir.path)"}}}"#)

        let installReq = await feedNextRequest(t, index: 3)
        t.feed(#"{"jsonrpc":"2.0","id":\#(installReq["id"] as! Int),"result":{"ok":true,"plugin":{"id":"demo","installPath":"\#(dir.path)","scope":"user"}}}"#)

        await feedNextResult(t, index: 4, result: #"{"plugins":[\#(echoListing)]}"#)

        await action
    }

    /// C1: a plugin whose `requiredConsents` is non-empty ALWAYS gets the sheet on a fresh install,
    /// even when the daemon's own fingerprint already reads it fully consented (a reinstall to the
    /// identical path/entry) — `performEnable` is never called directly for such a plugin.
    func testInstallFromFolderAlwaysShowsSheetWhenRequiredConsentsIsNonEmptyEvenIfAlreadyConsented() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        let dir = try makeMarketplaceDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        async let action: Void = model.installFromFolder(dir)

        let listReq = await feedNextRequest(t, index: 1)
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"marketplaces":[]}}"#)
        let addReq = await feedNextRequest(t, index: 2)
        t.feed(#"{"jsonrpc":"2.0","id":\#(addReq["id"] as! Int),"result":{"ok":true,"marketplace":{"name":"winter-examples","source":"\#(dir.path)","kind":"directory","path":"\#(dir.path)"}}}"#)
        let installReq = await feedNextRequest(t, index: 3)
        t.feed(#"{"jsonrpc":"2.0","id":\#(installReq["id"] as! Int),"result":{"ok":true,"plugin":{"id":"demo","installPath":"\#(dir.path)","scope":"user"}}}"#)

        // The post-install refresh reports the plugin ALREADY fully consented (fingerprint match).
        await feedNextResult(t, index: 4, result: #"{"plugins":[\#(echoListingAlreadyConsented)]}"#)

        await action

        // Still opens the sheet, and never calls plugin.enable directly.
        XCTAssertEqual(model.consentSheet?.pluginId, "demo")
        XCTAssertTrue(model.consentSheet?.openedByInstall ?? false)
        XCTAssertEqual(t.sent.count, 5, "hello + marketplace.list + marketplace.add + install + refresh — no plugin.enable")
    }

    /// M3: a failed post-install refresh must not fall through to opening a sheet or calling
    /// `performEnable` off a stale/absent listing.
    func testInstallFromFolderStopsIfThePostInstallRefreshFails() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        let dir = try makeMarketplaceDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        async let action: Void = model.installFromFolder(dir)

        let listReq = await feedNextRequest(t, index: 1)
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"marketplaces":[]}}"#)
        let addReq = await feedNextRequest(t, index: 2)
        t.feed(#"{"jsonrpc":"2.0","id":\#(addReq["id"] as! Int),"result":{"ok":true,"marketplace":{"name":"winter-examples","source":"\#(dir.path)","kind":"directory","path":"\#(dir.path)"}}}"#)
        let installReq = await feedNextRequest(t, index: 3)
        t.feed(#"{"jsonrpc":"2.0","id":\#(installReq["id"] as! Int),"result":{"ok":true,"plugin":{"id":"demo","installPath":"\#(dir.path)","scope":"user"}}}"#)

        let refreshReq = await feedNextRequest(t, index: 4)
        t.feed(#"{"jsonrpc":"2.0","id":\#(refreshReq["id"] as! Int),"error":{"code":-32000,"message":"daemon unavailable"}}"#)

        await action

        XCTAssertNil(model.consentSheet)
        XCTAssertEqual(model.errorText, "couldn't load plugins: daemon unavailable")
        XCTAssertEqual(t.sent.count, 5, "no plugin.enable after a failed refresh")
    }

    /// M1: the daemon's own refusal text surfaces verbatim, not a generic "try again".
    func testInstallFromFolderSurfacesTheDaemonsOwnErrorMessage() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        let dir = try makeMarketplaceDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        async let action: Void = model.installFromFolder(dir)

        let listReq = await feedNextRequest(t, index: 1)
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"marketplaces":[]}}"#)
        let addReq = await feedNextRequest(t, index: 2)
        t.feed(#"{"jsonrpc":"2.0","id":\#(addReq["id"] as! Int),"error":{"code":-32000,"message":"not a directory marketplace"}}"#)

        await action

        XCTAssertEqual(model.errorText, "couldn't install \(dir.lastPathComponent): not a directory marketplace")
    }

    /// A folder with no `.claude-plugin/marketplace.json` is refused locally before any RPC — the
    /// marketplace-collision check never runs on a folder that can't even be read.
    func testInstallFromFolderWithNoManifestSurfacesErrorTextNoRpc() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("winter-install-empty-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        await model.installFromFolder(dir)

        XCTAssertEqual(t.sent.count, 1, "hello only — no marketplace.list for an unreadable folder")
        XCTAssertNil(model.consentSheet)
        XCTAssertNotNil(model.errorText)
    }

    // MARK: - C2 defence in depth: ambiguous bare id

    /// `enable(_:)` refuses when the SAME bare id is installed (user scope) from more than one
    /// marketplace — `plugin.setConsent`/`plugin.restart` are both keyed by the bare id daemon-side
    /// and would silently act on whichever one the daemon's own lookup finds first.
    func testEnableRefusesAnAmbiguousBareId() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)

        async let action: Void = model.enable("demo@winter-examples")
        let listReq = await feedNextRequest(t, index: 1)
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"plugins":[{"id":"demo","installPath":"/a","scope":"user","enabled":true,"marketplace":"winter-examples"},{"id":"demo","installPath":"/b","scope":"user","enabled":true,"marketplace":"other-market"}]}}"#)
        await action

        XCTAssertNil(model.consentSheet)
        XCTAssertTrue(model.errorText?.contains("more than one marketplace") ?? false, "\(model.errorText ?? "nil")")
    }
}
