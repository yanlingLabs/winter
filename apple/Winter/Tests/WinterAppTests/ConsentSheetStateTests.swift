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
                    entry: PluginEntryInfo(command: "node", args: ["./server.js", "--port", "4000"]), fingerprint: "fp-1")
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
                             entry: PluginEntryInfo(command: "node", args: ["server.js", "--port", "4000"]), fingerprint: "fp-1")
        let lines = pluginConsentDisclosureLines(pluginId: "demo", extras: e)
        XCTAssertTrue(lines.contains("- run its own background process: node server.js --port 4000"))
    }

    func testListsEachTccAndHardwarePermissionOnItsOwnLine() {
        let e = PluginExtras(tier: "platform", execPermission: false, tccPermissions: ["microphone", "camera"],
                             hardwarePermissions: ["battery"], requiredConsents: ["tcc", "hardware"],
                             consented: [], entry: nil, fingerprint: "fp-1")
        let lines = pluginConsentDisclosureLines(pluginId: "demo", extras: e)
        XCTAssertTrue(lines.contains("- will request macOS permission: microphone"))
        XCTAssertTrue(lines.contains("- will request macOS permission: camera"))
        XCTAssertTrue(lines.contains("- hardware access via Winter.app's helper: battery"))
    }

    func testOmitsTheExecLineWhenExecPermissionIsFalse() {
        let e = PluginExtras(tier: "capability", execPermission: false, tccPermissions: [], hardwarePermissions: [],
                             requiredConsents: [], consented: [], entry: nil, fingerprint: "fp-1")
        let lines = pluginConsentDisclosureLines(pluginId: "demo", extras: e)
        XCTAssertFalse(lines.contains { $0.contains("background process") })
    }

    /// `execPermission` alone can be absent/false while `requiredConsents` still lists `"exec"` —
    /// the exec line must still show, not render as a bare, contentless header.
    func testListsTheExecLineWhenRequiredConsentsSaysExecEvenIfPermissionFlagIsAbsent() {
        let e = PluginExtras(tier: "platform", execPermission: false, tccPermissions: [], hardwarePermissions: [],
                             requiredConsents: ["exec"], consented: [], entry: nil, fingerprint: "fp-1")
        let lines = pluginConsentDisclosureLines(pluginId: "demo", extras: e)
        XCTAssertTrue(lines.contains { $0.contains("background process") })
    }

    /// Same for a declared `entry` with no `execPermission`/`requiredConsents` echo.
    func testListsTheExecLineWhenEntryIsDeclaredEvenIfPermissionFlagIsAbsent() {
        let e = PluginExtras(tier: "platform", execPermission: false, tccPermissions: [], hardwarePermissions: [],
                             requiredConsents: [], consented: [], entry: PluginEntryInfo(command: "node", args: []), fingerprint: "fp-1")
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

    private let echoListing = #"{"id":"demo","installPath":"/p","scope":"user","enabled":true,"marketplace":"winter-examples","extras":{"tier":"platform","permissions":{"exec":true},"requiredConsents":["exec"],"consented":[],"fingerprint":"fp-1"}}"#
    /// Same plugin, but the daemon's fingerprint already reads it consented (a reinstall to the
    /// identical path/entry) — used to prove C1's "always show the sheet on fresh install anyway".
    private let echoListingAlreadyConsented = #"{"id":"demo","installPath":"/p","scope":"user","enabled":true,"marketplace":"winter-examples","extras":{"tier":"platform","permissions":{"exec":true},"requiredConsents":["exec"],"consented":["exec"],"fingerprint":"fp-1"}}"#

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
                                  requiredConsents: ["exec"], consented: [], entry: nil, fingerprint: "fp-1")
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
        // must NOT re-run the install-declined follow-up. Round 3 (N1) replaced the original
        // `dismissHandledByConfirm` flag with a proactive `lastConsentSheet = nil` INSIDE
        // `confirmConsent()`'s own success branch — `consentSheetDismissed()`'s `guard let sheet =
        // lastConsentSheet else { return }` is then a no-op; simulating the `onDismiss` call here
        // proves it holds.
        await model.consentSheetDismissed()
        XCTAssertEqual(t.sent.count, 4, "no extra plugin.disable/plugin.list after a successful confirm's own dismissal")
        XCTAssertNil(model.noticeText)
    }

    /// N1 (round 3, controller-required): the Dashboard pane AND the Library host both mount
    /// `.sheet(item: $model.consentSheet, onDismiss: ...)` on the SAME published property — a
    /// successful confirm's own `consentSheet = nil` can trigger `onDismiss` on BOTH mounted hosts.
    /// The pre-round-3 `dismissHandledByConfirm` flag was consumed by the FIRST call, leaving the
    /// SECOND to run the install-declined follow-up on a plugin the user just consented to. This
    /// pins that neither of two calls sends a `plugin.disable`.
    func testConfirmConsentThenTwoDismissHandlerCallsSendsNoDisable() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        let extras = PluginExtras(tier: "platform", execPermission: true, tccPermissions: [], hardwarePermissions: [],
                                  requiredConsents: ["exec"], consented: [], entry: nil, fingerprint: "fp-1")
        model.consentSheet = ConsentSheetState(pluginId: "demo", spec: "demo@winter-examples", scope: .user,
                                               extras: extras, openedByInstall: true)

        async let action: Void = model.confirmConsent()
        let setConsentReq = await feedNextRequest(t, index: 1)
        t.feed(#"{"jsonrpc":"2.0","id":\#(setConsentReq["id"] as! Int),"result":{"ok":true}}"#)
        let enableReq = await feedNextRequest(t, index: 2)
        t.feed(#"{"jsonrpc":"2.0","id":\#(enableReq["id"] as! Int),"result":{"ok":true,"spec":"demo@winter-examples","scope":"user","enabled":true}}"#)
        await feedNextResult(t, index: 3, result: #"{"plugins":[]}"#)
        await action
        XCTAssertNil(model.consentSheet)

        // BOTH mounted `.sheet` hosts fire `onDismiss` off the SAME successful `consentSheet = nil`.
        await model.consentSheetDismissed()
        await model.consentSheetDismissed()

        XCTAssertEqual(t.sent.count, 4, "no plugin.disable/refresh from either onDismiss call after a successful confirm")
        XCTAssertNil(model.noticeText)
        XCTAssertNil(model.errorText)
    }

    /// N1 (round 3, controller-required): `lastConsentSheet` tracks the LATEST sheet, not a stale
    /// one — a confirm with NO dismiss call following it (the bug's other half: every mounted host
    /// is gone, or Esc lands while a confirm is still in flight) must not leave a flag that then
    /// swallows the NEXT install sheet's decline.
    func testConfirmConsentWithNoDismissThenCancellingALaterInstallSheetStillDisables() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        let extras = PluginExtras(tier: "platform", execPermission: true, tccPermissions: [], hardwarePermissions: [],
                                  requiredConsents: ["exec"], consented: [], entry: nil, fingerprint: "fp-1")
        model.consentSheet = ConsentSheetState(pluginId: "demo", spec: "demo@winter-examples", scope: .user,
                                               extras: extras, openedByInstall: true)

        async let action: Void = model.confirmConsent()
        let setConsentReq = await feedNextRequest(t, index: 1)
        t.feed(#"{"jsonrpc":"2.0","id":\#(setConsentReq["id"] as! Int),"result":{"ok":true}}"#)
        let enableReq = await feedNextRequest(t, index: 2)
        t.feed(#"{"jsonrpc":"2.0","id":\#(enableReq["id"] as! Int),"result":{"ok":true,"spec":"demo@winter-examples","scope":"user","enabled":true}}"#)
        await feedNextResult(t, index: 3, result: #"{"plugins":[]}"#)
        await action
        // Deliberately NO `consentSheetDismissed()` call here.

        // A second, DIFFERENT plugin's install sheet opens...
        let secondExtras = PluginExtras(tier: "platform", execPermission: true, tccPermissions: [], hardwarePermissions: [],
                                        requiredConsents: ["exec"], consented: [], entry: nil, fingerprint: "fp-2")
        model.consentSheet = ConsentSheetState(pluginId: "other", spec: "other@winter-examples", scope: .user,
                                               extras: secondExtras, openedByInstall: true)
        // ...and is declined via a swipe/Esc (no Cancel button call, matching this file's other
        // dismiss-without-cancel tests).
        model.consentSheet = nil
        async let dismissAction: Void = model.consentSheetDismissed()

        let disableReq = await feedNextRequest(t, index: 4)
        XCTAssertEqual(disableReq["method"] as? String, "plugin.disable")
        XCTAssertEqual((disableReq["params"] as? [String: Any])?["spec"] as? String, "other@winter-examples",
                       "must disable the SECOND (latest) sheet's plugin, not the first one already confirmed")
        t.feed(#"{"jsonrpc":"2.0","id":\#(disableReq["id"] as! Int),"result":{"ok":true,"spec":"other@winter-examples","scope":"user","enabled":false}}"#)
        await feedNextResult(t, index: 5, result: #"{"plugins":[]}"#)

        await dismissAction

        XCTAssertEqual(model.noticeText, "Installed but turned off — enable it to review its permissions again.")
    }

    /// C1: `confirmConsent()` grants EVERY class in `extras.requiredConsents`, not just
    /// `pendingConsents` — a fresh confirmation re-affirms the whole disclosure, not a stale delta.
    func testConfirmConsentGrantsEveryRequiredClassNotJustPending() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        let extras = PluginExtras(tier: "platform", execPermission: true, tccPermissions: ["microphone"], hardwarePermissions: [],
                                  requiredConsents: ["exec", "tcc"], consented: ["exec"], entry: nil, fingerprint: "fp-1")
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
                                  requiredConsents: ["exec"], consented: [], entry: nil, fingerprint: "fp-1")
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

    /// Contract update from L4 (round 3): `.staleDisclosure` (the `fingerprint` no longer matches —
    /// the plugin changed under the sheet, a TOCTOU the fingerprint exists to close) must NOT enable
    /// — it refreshes, rebuilds the sheet from the NEW disclosure, keeps it open, and shows the
    /// "please review again" message.
    func testConfirmConsentRebuildsTheSheetAndKeepsItOpenOnStaleDisclosure() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        let staleExtras = PluginExtras(tier: "platform", execPermission: true, tccPermissions: [], hardwarePermissions: [],
                                       requiredConsents: ["exec"], consented: [], entry: nil, fingerprint: "fp-old")
        model.consentSheet = ConsentSheetState(pluginId: "demo", spec: "demo@winter-examples", scope: .user,
                                               extras: staleExtras, openedByInstall: true)

        async let action: Void = model.confirmConsent()
        let setConsentReq = await feedNextRequest(t, index: 1)
        XCTAssertEqual((setConsentReq["params"] as? [String: Any])?["fingerprint"] as? String, "fp-old")
        t.feed(#"{"jsonrpc":"2.0","id":\#(setConsentReq["id"] as! Int),"result":{"code":"stale_disclosure"}}"#)

        // No plugin.enable — refuses straight to the refresh that rebuilds the sheet.
        let refreshReq = await feedNextRequest(t, index: 2)
        XCTAssertEqual(refreshReq["method"] as? String, "plugin.list", "pluginEnable must be skipped entirely")
        let newExtras = #"{"tier":"platform","permissions":{"exec":true},"requiredConsents":["exec"],"consented":[],"fingerprint":"fp-new"}"#
        t.feed(#"{"jsonrpc":"2.0","id":\#(refreshReq["id"] as! Int),"result":{"plugins":[{"id":"demo","installPath":"/p","scope":"user","enabled":true,"marketplace":"winter-examples","extras":\#(newExtras)}]}}"#)

        await action

        XCTAssertEqual(t.sent.count, 3, "no plugin.enable, and no SECOND trailing refresh beyond the sheet-rebuilding one")
        XCTAssertNotNil(model.consentSheet, "the sheet stays open")
        XCTAssertEqual(model.consentSheet?.extras.fingerprint, "fp-new", "rebuilt from the fresh disclosure, not the stale one")
        XCTAssertTrue(model.consentSheet?.openedByInstall ?? false, "carries the original trigger forward")
        XCTAssertEqual(model.errorText, "This plugin changed while you were reviewing it — please review again.")
    }

    /// The stale-disclosure rebuild's OWN fallback: if the refresh no longer contains the plugin at
    /// all (uninstalled from elsewhere while the sheet sat open), it closes the sheet instead of
    /// rebuilding onto nothing.
    func testConfirmConsentClosesTheSheetOnStaleDisclosureWhenThePluginIsGone() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        let staleExtras = PluginExtras(tier: "platform", execPermission: true, tccPermissions: [], hardwarePermissions: [],
                                       requiredConsents: ["exec"], consented: [], entry: nil, fingerprint: "fp-old")
        model.consentSheet = ConsentSheetState(pluginId: "demo", spec: "demo@winter-examples", scope: .user,
                                               extras: staleExtras, openedByInstall: true)

        async let action: Void = model.confirmConsent()
        let setConsentReq = await feedNextRequest(t, index: 1)
        t.feed(#"{"jsonrpc":"2.0","id":\#(setConsentReq["id"] as! Int),"result":{"code":"stale_disclosure"}}"#)
        let refreshReq = await feedNextRequest(t, index: 2)
        t.feed(#"{"jsonrpc":"2.0","id":\#(refreshReq["id"] as! Int),"result":{"plugins":[]}}"#)

        await action

        XCTAssertNil(model.consentSheet)
        XCTAssertEqual(model.errorText, "This plugin changed while you were reviewing it — please review again.")
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
                                  requiredConsents: ["exec"], consented: [], entry: nil, fingerprint: "fp-1")
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
                                  requiredConsents: ["exec"], consented: [], entry: nil, fingerprint: "fp-1")
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
                                  requiredConsents: ["exec"], consented: [], entry: nil, fingerprint: "fp-1")
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
                                  requiredConsents: ["exec"], consented: [], entry: nil, fingerprint: "fp-1")
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

    /// Helper: feeds the bare-id ambiguity pre-check (`plugin.list`, round 3's new FIRST RPC) with
    /// an empty/non-colliding result, so a test can get straight to the marketplace steps.
    private func feedNoBareIdCollision(_ t: FeedScriptedTransport, index: Int = 1) async {
        let req = await feedNextRequest(t, index: index)
        XCTAssertEqual(req["method"] as? String, "plugin.list")
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"plugins":[]}}"#)
    }

    /// Ordering (round 3 minor): `installFromFolder(_:)` checks the bare-id ambiguity FIRST
    /// (`plugin.list`, using the manifest's own plugin name — nothing is installed yet), then
    /// `plugin.marketplace.list` (C1's collision check), all before ever calling
    /// `plugin.marketplace.add` — this pins the full ordering.
    func testInstallFromFolderChecksBareIdThenMarketplaceListBeforeAdding() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        let dir = try makeMarketplaceDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        async let action: Void = model.installFromFolder(dir)

        await feedNoBareIdCollision(t)

        let listReq = await feedNextRequest(t, index: 2)
        XCTAssertEqual(listReq["method"] as? String, "plugin.marketplace.list")
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"marketplaces":[]}}"#)

        let addReq = await feedNextRequest(t, index: 3)
        XCTAssertEqual(addReq["method"] as? String, "plugin.marketplace.add")
        t.feed(#"{"jsonrpc":"2.0","id":\#(addReq["id"] as! Int),"result":{"ok":true,"marketplace":{"name":"winter-examples","source":"\#(dir.path)","kind":"directory","path":"\#(dir.path)"}}}"#)

        let installReq = await feedNextRequest(t, index: 4)
        XCTAssertEqual(installReq["method"] as? String, "plugin.install")
        t.feed(#"{"jsonrpc":"2.0","id":\#(installReq["id"] as! Int),"result":{"ok":true,"plugin":{"id":"demo","installPath":"\#(dir.path)","scope":"user"}}}"#)

        await feedNextResult(t, index: 5, result: #"{"plugins":[\#(echoListing)]}"#)

        await action

        XCTAssertEqual(model.consentSheet?.pluginId, "demo")
        XCTAssertTrue(model.consentSheet?.openedByInstall ?? false)
    }

    /// Ordering (round 3 minor): a bare-id collision is refused via the PRE-install check, before
    /// any marketplace RPC is ever sent — `pluginName` ("demo") is already installed from another
    /// marketplace.
    func testInstallFromFolderRefusesABareIdCollisionBeforeAnyMarketplaceCall() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        let dir = try makeMarketplaceDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        async let action: Void = model.installFromFolder(dir)

        let bareIdReq = await feedNextRequest(t, index: 1)
        t.feed(#"{"jsonrpc":"2.0","id":\#(bareIdReq["id"] as! Int),"result":{"plugins":[{"id":"demo","installPath":"/elsewhere","scope":"user","enabled":true,"marketplace":"other-market"}]}}"#)

        await action

        XCTAssertEqual(t.sent.count, 2, "hello + the bare-id check — no marketplace.list/add/install")
        XCTAssertNil(model.consentSheet)
        XCTAssertTrue(model.errorText?.contains("demo") ?? false, "\(model.errorText ?? "nil")")
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

        await feedNoBareIdCollision(t)

        let listReq = await feedNextRequest(t, index: 2)
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"marketplaces":[{"name":"winter-examples","source":"/somewhere/else","kind":"directory","path":"/somewhere/else"}]}}"#)

        await action

        XCTAssertEqual(t.sent.count, 3, "no marketplace.add/install/refresh — refused before any of them")
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

        await feedNoBareIdCollision(t)

        let listReq = await feedNextRequest(t, index: 2)
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"marketplaces":[{"name":"winter-examples","source":"\#(dir.path)","kind":"directory","path":"\#(dir.path)"}]}}"#)

        let addReq = await feedNextRequest(t, index: 3)
        XCTAssertEqual(addReq["method"] as? String, "plugin.marketplace.add", "the same path is not a collision")
        t.feed(#"{"jsonrpc":"2.0","id":\#(addReq["id"] as! Int),"result":{"ok":true,"marketplace":{"name":"winter-examples","source":"\#(dir.path)","kind":"directory","path":"\#(dir.path)"}}}"#)

        let installReq = await feedNextRequest(t, index: 4)
        t.feed(#"{"jsonrpc":"2.0","id":\#(installReq["id"] as! Int),"result":{"ok":true,"plugin":{"id":"demo","installPath":"\#(dir.path)","scope":"user"}}}"#)

        await feedNextResult(t, index: 5, result: #"{"plugins":[\#(echoListing)]}"#)

        await action
    }

    /// N2 (round 3): a marketplace this session's OWN action did NOT create (it already existed
    /// under this name — even at the identical path, an idempotent re-add) is never tracked as
    /// "app-added", so a later `uninstall(_:)` never offers to remove it.
    func testInstallFromFolderReaddingTheSamePathDoesNotTrackItAsAppAdded() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        let dir = try makeMarketplaceDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        async let action: Void = model.installFromFolder(dir)
        await feedNoBareIdCollision(t)
        let listReq = await feedNextRequest(t, index: 2)
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"marketplaces":[{"name":"winter-examples","source":"\#(dir.path)","kind":"directory","path":"\#(dir.path)"}]}}"#)
        let addReq = await feedNextRequest(t, index: 3)
        t.feed(#"{"jsonrpc":"2.0","id":\#(addReq["id"] as! Int),"result":{"ok":true,"marketplace":{"name":"winter-examples","source":"\#(dir.path)","kind":"directory","path":"\#(dir.path)"}}}"#)
        let installReq = await feedNextRequest(t, index: 4)
        t.feed(#"{"jsonrpc":"2.0","id":\#(installReq["id"] as! Int),"result":{"ok":true,"plugin":{"id":"demo","installPath":"\#(dir.path)","scope":"user"}}}"#)
        await feedNextResult(t, index: 5, result: #"{"plugins":[\#(echoListing)]}"#)
        await action

        // Now uninstall — since the marketplace was already known (not app-added), no
        // plugin.marketplace.remove should ever be sent, and no unfiltered plugin.list check for
        // "still used" either (the `marketplacesAddedThisSession.contains` guard short-circuits).
        async let uninstallAction: Void = model.uninstall("demo@winter-examples")
        let uninstallReq = await feedNextRequest(t, index: 6)
        XCTAssertEqual(uninstallReq["method"] as? String, "plugin.uninstall")
        t.feed(#"{"jsonrpc":"2.0","id":\#(uninstallReq["id"] as! Int),"result":{"ok":true,"spec":"demo@winter-examples","scope":"user"}}"#)
        let refreshReq = await feedNextRequest(t, index: 7)
        XCTAssertEqual(refreshReq["method"] as? String, "plugin.list", "the trailing refresh — NOT a marketplace.remove or an extra unused-check plugin.list")
        t.feed(#"{"jsonrpc":"2.0","id":\#(refreshReq["id"] as! Int),"result":{"plugins":[]}}"#)
        await uninstallAction

        XCTAssertEqual(t.sent.count, 8, "no plugin.marketplace.remove anywhere in this sequence")
    }

    /// N2 (round 3, controller-required): a marketplace this session DID add (via
    /// `installFromFolder`) is still kept when a PROJECT-scope plugin from the same marketplace is
    /// still using it — `listingsBySpec` only ever holds `.user`-scope rows (`refresh()`'s own
    /// filter), so the unfiltered `plugin.list` check in `uninstall(_:)` is what catches this; the
    /// pre-round-3 code checked only the CACHED (user-scope-only) listings and would have missed it.
    func testUninstallKeepsTheMarketplaceWhenAProjectScopePluginStillUsesIt() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        let dir = try makeMarketplaceDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        async let installAction: Void = model.installFromFolder(dir)
        await feedNoBareIdCollision(t)
        let listReq = await feedNextRequest(t, index: 2)
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"marketplaces":[]}}"#)
        let addReq = await feedNextRequest(t, index: 3)
        t.feed(#"{"jsonrpc":"2.0","id":\#(addReq["id"] as! Int),"result":{"ok":true,"marketplace":{"name":"winter-examples","source":"\#(dir.path)","kind":"directory","path":"\#(dir.path)"}}}"#)
        let installReq = await feedNextRequest(t, index: 4)
        t.feed(#"{"jsonrpc":"2.0","id":\#(installReq["id"] as! Int),"result":{"ok":true,"plugin":{"id":"demo","installPath":"\#(dir.path)","scope":"user"}}}"#)
        await feedNextResult(t, index: 5, result: #"{"plugins":[\#(echoListing)]}"#)
        await installAction

        async let uninstallAction: Void = model.uninstall("demo@winter-examples")
        let uninstallReq = await feedNextRequest(t, index: 6)
        XCTAssertEqual(uninstallReq["method"] as? String, "plugin.uninstall")
        t.feed(#"{"jsonrpc":"2.0","id":\#(uninstallReq["id"] as! Int),"result":{"ok":true,"spec":"demo@winter-examples","scope":"user"}}"#)

        // The unfiltered "still used" check — a DIFFERENT plugin, PROJECT scope, same marketplace.
        let checkReq = await feedNextRequest(t, index: 7)
        XCTAssertEqual(checkReq["method"] as? String, "plugin.list")
        t.feed(#"{"jsonrpc":"2.0","id":\#(checkReq["id"] as! Int),"result":{"plugins":[{"id":"demo2","installPath":"/proj","scope":"project","enabled":true,"marketplace":"winter-examples"}]}}"#)

        let refreshReq = await feedNextRequest(t, index: 8)
        XCTAssertEqual(refreshReq["method"] as? String, "plugin.list")
        t.feed(#"{"jsonrpc":"2.0","id":\#(refreshReq["id"] as! Int),"result":{"plugins":[]}}"#)

        await uninstallAction

        let methods = t.sent.map { feedLineJSON($0)["method"] as? String }
        XCTAssertFalse(methods.contains("plugin.marketplace.remove"),
                       "a project-scope plugin from the same marketplace must keep it")
    }

    /// N2 (round 3, controller-required): a marketplace added OUTSIDE this app session (the `winter`
    /// CLI, another client, or a previous app launch) is never removed on uninstall — this pane only
    /// ever offers to remove a marketplace it itself created via `installFromFolder(_:)` THIS
    /// session; `marketplacesAddedThisSession` starts empty on every fresh `PluginManagerModel`, so
    /// nothing this test does populates it.
    func testUninstallNeverRemovesAMarketplaceAddedOutsideThisSession() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)

        async let refreshAction: Void = model.refresh()
        let refreshReq = await feedNextRequest(t, index: 1)
        t.feed(#"{"jsonrpc":"2.0","id":\#(refreshReq["id"] as! Int),"result":{"plugins":[{"id":"demo","installPath":"/p","scope":"user","enabled":true,"marketplace":"cli-market"}]}}"#)
        await refreshAction

        async let uninstallAction: Void = model.uninstall("demo@cli-market")
        let uninstallReq = await feedNextRequest(t, index: 2)
        XCTAssertEqual(uninstallReq["method"] as? String, "plugin.uninstall")
        t.feed(#"{"jsonrpc":"2.0","id":\#(uninstallReq["id"] as! Int),"result":{"ok":true,"spec":"demo@cli-market","scope":"user"}}"#)

        // NOT the unfiltered "still used" check — straight to the trailing refresh, because
        // `marketplacesAddedThisSession` never contained "cli-market" to begin with.
        let trailingReq = await feedNextRequest(t, index: 3)
        XCTAssertEqual(trailingReq["method"] as? String, "plugin.list")
        t.feed(#"{"jsonrpc":"2.0","id":\#(trailingReq["id"] as! Int),"result":{"plugins":[]}}"#)

        await uninstallAction

        XCTAssertEqual(t.sent.count, 4, "hello + refresh + uninstall + trailing refresh only — no unused-check, no marketplace.remove")
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

        await feedNoBareIdCollision(t)
        let listReq = await feedNextRequest(t, index: 2)
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"marketplaces":[]}}"#)
        let addReq = await feedNextRequest(t, index: 3)
        t.feed(#"{"jsonrpc":"2.0","id":\#(addReq["id"] as! Int),"result":{"ok":true,"marketplace":{"name":"winter-examples","source":"\#(dir.path)","kind":"directory","path":"\#(dir.path)"}}}"#)
        let installReq = await feedNextRequest(t, index: 4)
        t.feed(#"{"jsonrpc":"2.0","id":\#(installReq["id"] as! Int),"result":{"ok":true,"plugin":{"id":"demo","installPath":"\#(dir.path)","scope":"user"}}}"#)

        // The post-install refresh reports the plugin ALREADY fully consented (fingerprint match).
        await feedNextResult(t, index: 5, result: #"{"plugins":[\#(echoListingAlreadyConsented)]}"#)

        await action

        // Still opens the sheet, and never calls plugin.enable directly.
        XCTAssertEqual(model.consentSheet?.pluginId, "demo")
        XCTAssertTrue(model.consentSheet?.openedByInstall ?? false)
        XCTAssertEqual(t.sent.count, 6, "hello + bare-id-check + marketplace.list + marketplace.add + install + refresh — no plugin.enable")
    }

    /// M3: a failed post-install refresh must not fall through to opening a sheet or calling
    /// `performEnable` off a stale/absent listing.
    func testInstallFromFolderStopsIfThePostInstallRefreshFails() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        let dir = try makeMarketplaceDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        async let action: Void = model.installFromFolder(dir)

        await feedNoBareIdCollision(t)
        let listReq = await feedNextRequest(t, index: 2)
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"marketplaces":[]}}"#)
        let addReq = await feedNextRequest(t, index: 3)
        t.feed(#"{"jsonrpc":"2.0","id":\#(addReq["id"] as! Int),"result":{"ok":true,"marketplace":{"name":"winter-examples","source":"\#(dir.path)","kind":"directory","path":"\#(dir.path)"}}}"#)
        let installReq = await feedNextRequest(t, index: 4)
        t.feed(#"{"jsonrpc":"2.0","id":\#(installReq["id"] as! Int),"result":{"ok":true,"plugin":{"id":"demo","installPath":"\#(dir.path)","scope":"user"}}}"#)

        let refreshReq = await feedNextRequest(t, index: 5)
        t.feed(#"{"jsonrpc":"2.0","id":\#(refreshReq["id"] as! Int),"error":{"code":-32000,"message":"daemon unavailable"}}"#)

        await action

        XCTAssertNil(model.consentSheet)
        XCTAssertEqual(model.errorText, "couldn't load plugins: daemon unavailable")
        XCTAssertEqual(t.sent.count, 6, "no plugin.enable after a failed refresh")
    }

    /// Minor (round 3): a SUCCESSFUL refresh that simply doesn't contain the spec just installed
    /// must not return silently — it sets `errorText` rather than leaving no trace anything's wrong.
    func testInstallFromFolderSetsErrorTextWhenTheSpecIsMissingAfterASuccessfulRefresh() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        let dir = try makeMarketplaceDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        async let action: Void = model.installFromFolder(dir)

        await feedNoBareIdCollision(t)
        let listReq = await feedNextRequest(t, index: 2)
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"marketplaces":[]}}"#)
        let addReq = await feedNextRequest(t, index: 3)
        t.feed(#"{"jsonrpc":"2.0","id":\#(addReq["id"] as! Int),"result":{"ok":true,"marketplace":{"name":"winter-examples","source":"\#(dir.path)","kind":"directory","path":"\#(dir.path)"}}}"#)
        let installReq = await feedNextRequest(t, index: 4)
        t.feed(#"{"jsonrpc":"2.0","id":\#(installReq["id"] as! Int),"result":{"ok":true,"plugin":{"id":"demo","installPath":"\#(dir.path)","scope":"user"}}}"#)

        // A SUCCESSFUL refresh, but it comes back with no row for "demo@winter-examples" at all.
        await feedNextResult(t, index: 5, result: #"{"plugins":[]}"#)

        await action

        XCTAssertNil(model.consentSheet)
        XCTAssertEqual(model.errorText, "installed demo@winter-examples but couldn't find it in the list afterward — try Refresh")
    }

    /// M1: the daemon's own refusal text surfaces verbatim, not a generic "try again".
    func testInstallFromFolderSurfacesTheDaemonsOwnErrorMessage() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        let dir = try makeMarketplaceDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        async let action: Void = model.installFromFolder(dir)

        await feedNoBareIdCollision(t)
        let listReq = await feedNextRequest(t, index: 2)
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"marketplaces":[]}}"#)
        let addReq = await feedNextRequest(t, index: 3)
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
