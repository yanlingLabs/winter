import XCTest
import WinterKit
@testable import Winter

/// WS-21 rewrite: `ConsentSheetState` — the PURE state machine backing the plugin install/enable
/// consent sheet, now seeded from a `plugin.list` row's `PluginExtras` rather than a wire outcome's
/// `consentBlock` string array. No `WinterClient`, no SwiftUI — same "pure model, table-tested
/// directly" posture as `PluginManagerModelTests`' coverage of `pluginRowDisplay`.
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

    func testConstructsWithPluginIdSpecScopeAndExtras() {
        let e = extras()
        let state = ConsentSheetState(pluginId: "demo", spec: "demo@winter-examples", scope: .user, extras: e)
        XCTAssertEqual(state.pluginId, "demo")
        XCTAssertEqual(state.spec, "demo@winter-examples")
        XCTAssertEqual(state.scope, .user)
        XCTAssertEqual(state.extras, e)
        XCTAssertEqual(state.decision, .pending)
    }

    func testPendingConsentsIsExtrasOwnPendingConsents() {
        let e = extras(required: ["exec", "tcc", "hardware"], consented: ["exec"])
        let state = ConsentSheetState(pluginId: "demo", spec: "demo@winter-examples", scope: .user, extras: e)
        XCTAssertEqual(state.pendingConsents, ["tcc", "hardware"])
    }

    // MARK: - `confirm()`/`cancel()` state transitions

    func testStartsPending() {
        let state = ConsentSheetState(pluginId: "demo", spec: "demo@winter-examples", scope: .user, extras: extras())
        XCTAssertEqual(state.decision, .pending)
    }

    /// `confirm()` maps to "call `pluginSetConsent` then `pluginEnable`" — this type only records
    /// the intent; `PluginManagerModel.confirmConsent()` is what actually performs the calls.
    func testConfirmTransitionsToConfirmed() {
        var state = ConsentSheetState(pluginId: "demo", spec: "demo@winter-examples", scope: .user, extras: extras())
        state.confirm()
        XCTAssertEqual(state.decision, .confirmed)
    }

    /// `cancel()` dismisses without granting consent or enabling — a distinct terminal state from
    /// `.confirmed`.
    func testCancelTransitionsToCancelled() {
        var state = ConsentSheetState(pluginId: "demo", spec: "demo@winter-examples", scope: .user, extras: extras())
        state.cancel()
        XCTAssertEqual(state.decision, .cancelled)
    }

    func testIdentifiableIdIsTheQualifiedSpec() {
        let state = ConsentSheetState(pluginId: "demo", spec: "demo@winter-examples", scope: .user, extras: extras())
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
}

// -----------------------------------------------------------------------------------------------
// `directoryMarketplacePluginNames` — Task 3's real-filesystem (not `WinterClient`) install
// helper, WS-21 rewrite (replaces `locatePluginRoot`'s winter-plugin.json/plugin.json sniffing
// with a directory marketplace's own `.claude-plugin/marketplace.json`). Directly testable against
// a real temp directory rather than mocked.
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
}

// -----------------------------------------------------------------------------------------------
// PluginManagerModel — the consent-sheet-driving methods (`enable`'s pending-consent path,
// `installFromFolder`, `confirmConsent`, `cancelConsent`). A SEPARATE `@MainActor` test class,
// same posture as `PluginManagerModelAsyncTests` (`PluginManagerModelTests.swift`) — drives a real
// (actor) `WinterClient` end-to-end via the same scripted-transport double
// (`FeedScriptedTransport`/`feedLineJSON`/`feedWaitUntil`, `SessionFeedTests.swift`, same target).
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

    /// `enable(_:)` on a row whose extras still have a pending class opens the sheet WITHOUT
    /// calling `plugin.enable` at all — consent is a client-side decision off the already-loaded
    /// row now, not a wire round trip.
    func testEnableOnPendingConsentRowOpensSheetWithoutAnyEnableCall() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)

        async let refresh: Void = model.refresh()
        await feedWaitUntil { t.sent.count >= 2 }
        let listReq = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"plugins":[\#(echoListing)]}}"#)
        await refresh

        await model.enable("demo@winter-examples")

        XCTAssertEqual(t.sent.count, 2, "no plugin.enable sent — the sheet opens off already-loaded row data")
        XCTAssertEqual(model.consentSheet?.pluginId, "demo")
        XCTAssertEqual(model.consentSheet?.spec, "demo@winter-examples")
        XCTAssertEqual(model.consentSheet?.pendingConsents, ["exec"])
    }

    /// `confirmConsent()` calls `plugin.setConsent` FIRST, then `plugin.enable` — the daemon's
    /// `plugin.enable` handler hot-spawns synchronously and reads consent right then.
    func testConfirmConsentCallsSetConsentThenEnableInOrderAndDismisses() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        let extras = PluginExtras(tier: "platform", execPermission: true, tccPermissions: [], hardwarePermissions: [],
                                  requiredConsents: ["exec"], consented: [], entry: nil)
        model.consentSheet = ConsentSheetState(pluginId: "demo", spec: "demo@winter-examples", scope: .user, extras: extras)

        async let action: Void = model.confirmConsent()

        await feedWaitUntil { t.sent.count >= 2 }
        let setConsentReq = feedLineJSON(t.sent[1])
        XCTAssertEqual(setConsentReq["method"] as? String, "plugin.setConsent")
        let setConsentParams = setConsentReq["params"] as? [String: Any]
        XCTAssertEqual(setConsentParams?["name"] as? String, "demo")
        XCTAssertEqual(setConsentParams?["classes"] as? [String], ["exec"])
        t.feed(#"{"jsonrpc":"2.0","id":\#(setConsentReq["id"] as! Int),"result":{"ok":true}}"#)

        await feedWaitUntil { t.sent.count >= 3 }
        let enableReq = feedLineJSON(t.sent[2])
        XCTAssertEqual(enableReq["method"] as? String, "plugin.enable")
        let enableParams = enableReq["params"] as? [String: Any]
        XCTAssertEqual(enableParams?["spec"] as? String, "demo@winter-examples")
        XCTAssertEqual(enableParams?["scope"] as? String, "user")
        t.feed(#"{"jsonrpc":"2.0","id":\#(enableReq["id"] as! Int),"result":{"ok":true,"spec":"demo@winter-examples","scope":"user","enabled":true}}"#)

        await feedWaitUntil { t.sent.count >= 4 }
        let listReq = feedLineJSON(t.sent[3])
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"plugins":[]}}"#)

        await action

        XCTAssertNil(model.consentSheet)
        XCTAssertNil(model.errorText)
    }

    /// `cancelConsent()` dismisses without ever calling `pluginSetConsent`/`pluginEnable` — no RPC
    /// beyond the initial handshake is ever sent.
    func testCancelConsentDismissesWithoutAnyCall() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        let extras = PluginExtras(tier: "platform", execPermission: true, tccPermissions: [], hardwarePermissions: [],
                                  requiredConsents: ["exec"], consented: [], entry: nil)
        model.consentSheet = ConsentSheetState(pluginId: "demo", spec: "demo@winter-examples", scope: .user, extras: extras)

        model.cancelConsent()

        XCTAssertNil(model.consentSheet)
        XCTAssertEqual(t.sent.count, 1) // hello only
    }

    /// Fix wave (consent double-submit guard, carried through WS-21): a second `confirmConsent()`
    /// call landing while the first is still in flight is a no-op.
    func testConfirmConsentIgnoresReentryWhileFirstCallInFlight() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        let extras = PluginExtras(tier: "platform", execPermission: true, tccPermissions: [], hardwarePermissions: [],
                                  requiredConsents: ["exec"], consented: [], entry: nil)
        model.consentSheet = ConsentSheetState(pluginId: "demo", spec: "demo@winter-examples", scope: .user, extras: extras)

        async let action1: Void = model.confirmConsent()
        async let action2: Void = model.confirmConsent()

        await feedWaitUntil { t.sent.count >= 2 }
        let setConsentReq = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(setConsentReq["id"] as! Int),"result":{"ok":true}}"#)

        await feedWaitUntil { t.sent.count >= 3 }
        let enableReq = feedLineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(enableReq["id"] as! Int),"result":{"ok":true,"spec":"demo@winter-examples","scope":"user","enabled":true}}"#)

        await feedWaitUntil { t.sent.count >= 4 }
        let listReq = feedLineJSON(t.sent[3])
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"plugins":[]}}"#)

        _ = await (action1, action2)

        // hello + the ONE plugin.setConsent + the ONE plugin.enable + its trailing refresh — the
        // second `confirmConsent()` call sent nothing at all.
        XCTAssertEqual(t.sent.count, 4)
        XCTAssertNil(model.consentSheet)
    }

    /// `installFromFolder(_:)`'s success opens the SAME sheet type when the freshly-installed
    /// plugin's extras still need consent.
    func testInstallFromFolderOpensConsentSheetWhenExtrasNeedConsent() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)

        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("winter-install-test-\(UUID().uuidString)", isDirectory: true)
        let manifestDir = dir.appendingPathComponent(".claude-plugin", isDirectory: true)
        try FileManager.default.createDirectory(at: manifestDir, withIntermediateDirectories: true)
        try Data(#"{"name":"winter-examples","plugins":[{"name":"demo","source":"."}]}"#.utf8)
            .write(to: manifestDir.appendingPathComponent("marketplace.json"))
        defer { try? FileManager.default.removeItem(at: dir) }

        async let action: Void = model.installFromFolder(dir)

        await feedWaitUntil { t.sent.count >= 2 }
        let addReq = feedLineJSON(t.sent[1])
        XCTAssertEqual(addReq["method"] as? String, "plugin.marketplace.add")
        t.feed(#"{"jsonrpc":"2.0","id":\#(addReq["id"] as! Int),"result":{"ok":true,"marketplace":{"name":"winter-examples","source":"\#(dir.path)","kind":"directory","path":"\#(dir.path)"}}}"#)

        await feedWaitUntil { t.sent.count >= 3 }
        let installReq = feedLineJSON(t.sent[2])
        XCTAssertEqual(installReq["method"] as? String, "plugin.install")
        XCTAssertEqual((installReq["params"] as? [String: Any])?["spec"] as? String, "demo@winter-examples")
        t.feed(#"{"jsonrpc":"2.0","id":\#(installReq["id"] as! Int),"result":{"ok":true,"plugin":{"id":"demo","installPath":"\#(dir.path)","scope":"user"}}}"#)

        await feedWaitUntil { t.sent.count >= 4 }
        let listReq = feedLineJSON(t.sent[3])
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"plugins":[\#(echoListing)]}}"#)

        await action

        XCTAssertEqual(model.consentSheet?.pluginId, "demo")
        XCTAssertEqual(model.consentSheet?.spec, "demo@winter-examples")
        XCTAssertNil(model.errorText)
    }

    /// A folder with no `.claude-plugin/marketplace.json` is refused before any RPC is sent.
    func testInstallFromFolderWithNoManifestSurfacesErrorTextNoRpc() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("winter-install-empty-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        await model.installFromFolder(dir)

        XCTAssertEqual(t.sent.count, 1, "hello only — no marketplace.add for an unreadable folder")
        XCTAssertNil(model.consentSheet)
        XCTAssertNotNil(model.errorText)
    }
}
