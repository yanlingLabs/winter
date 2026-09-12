import XCTest
import WinterKit
@testable import Winter

/// Task 3 (4d-iii): `ConsentSheetState` — the PURE state machine backing the plugin install/enable
/// consent sheet. No `WinterClient`, no SwiftUI — same "pure model, table-tested directly" posture
/// as `PluginManagerModelTests`' coverage of `pluginRowDisplay`.
final class ConsentSheetStateTests: XCTestCase {
    /// Deliberately odd content (empty line, leading/trailing whitespace, a long line) — the point
    /// of these tests is that `ConsentSheetState` never reformats/truncates/reorders this, so the
    /// fixture needs shapes a naive "trim + wrap" implementation would corrupt.
    private let sampleBlock = [
        "plugin demo requests:",
        "  exec: mcp: node ./server.js --port 4000",
        "  tcc: will request macOS permission: microphone",
    ]

    // MARK: - Construction from `plugin.enable`'s `.needsConsent(...)`

    func testConstructsFromNeedsConsentOutcome() {
        let outcome = PluginEnableOutcome.needsConsent(requiredConsents: ["exec", "tcc"], consentBlock: sampleBlock)
        let state = ConsentSheetState(pluginName: "demo", needsConsent: outcome)
        XCTAssertNotNil(state)
        XCTAssertEqual(state?.pluginName, "demo")
        XCTAssertEqual(state?.requiredConsents, ["exec", "tcc"])
        XCTAssertEqual(state?.consentBlock, sampleBlock)
        XCTAssertEqual(state?.decision, .pending)
    }

    func testNilFromNonNeedsConsentEnableOutcomes() {
        XCTAssertNil(ConsentSheetState(pluginName: "demo", needsConsent: .ok(status: "running")))
        XCTAssertNil(ConsentSheetState(pluginName: "demo", needsConsent: .unknownPlugin))
    }

    // MARK: - Construction from `plugins.install`'s `.ok(...)`

    func testConstructsFromInstallOkOutcome() {
        let outcome = PluginsInstallOutcome.ok(name: "demo", requiredConsents: ["exec"], hasMcp: true, consentBlock: sampleBlock)
        let state = ConsentSheetState(installOutcome: outcome)
        XCTAssertNotNil(state)
        XCTAssertEqual(state?.pluginName, "demo")
        XCTAssertEqual(state?.requiredConsents, ["exec"])
        XCTAssertEqual(state?.consentBlock, sampleBlock)
        XCTAssertEqual(state?.decision, .pending)
    }

    /// Even a plugin needing zero consent classes still round-trips into a state (the header-only
    /// `consentBlock` `buildConsentBlock` produces for that case) — `install` always shows the
    /// sheet, since installs always land disabled server-side regardless of consent needs.
    func testConstructsFromInstallOkOutcomeWithNoRequiredConsents() {
        let outcome = PluginsInstallOutcome.ok(name: "no-consent-plugin", requiredConsents: [], hasMcp: false, consentBlock: ["plugin no-consent-plugin requests:"])
        let state = ConsentSheetState(installOutcome: outcome)
        XCTAssertNotNil(state)
        XCTAssertEqual(state?.requiredConsents, [])
        XCTAssertEqual(state?.consentBlock, ["plugin no-consent-plugin requests:"])
    }

    func testNilFromNonOkInstallOutcomes() {
        XCTAssertNil(ConsentSheetState(installOutcome: .invalidSource))
        XCTAssertNil(ConsentSheetState(installOutcome: .alreadyInstalled(name: "demo")))
    }

    // MARK: - Disclosure lines carried VERBATIM — no reformatting/truncation/reordering.

    func testConsentBlockCarriedVerbatim() {
        let odd = [
            "",
            "  leading and trailing whitespace preserved  ",
            "a very very very long exec line that must not be truncated, wrapped, or summarized in any way whatsoever no matter how long it runs on for",
        ]
        let state = ConsentSheetState(pluginName: "demo", consentBlock: odd, requiredConsents: ["exec"])
        XCTAssertEqual(state.consentBlock.count, odd.count)
        for (got, want) in zip(state.consentBlock, odd) {
            XCTAssertEqual(got, want)
        }
    }

    // MARK: - `confirm()`/`cancel()` state transitions

    func testStartsPending() {
        let state = ConsentSheetState(pluginName: "demo", consentBlock: sampleBlock, requiredConsents: ["exec"])
        XCTAssertEqual(state.decision, .pending)
    }

    /// `confirm()` maps to "call `pluginEnable(name:consent:true)`" — this type only records the
    /// intent; `PluginManagerModel.confirmConsent()` is what actually performs the call.
    func testConfirmTransitionsToConfirmed() {
        var state = ConsentSheetState(pluginName: "demo", consentBlock: sampleBlock, requiredConsents: ["exec"])
        state.confirm()
        XCTAssertEqual(state.decision, .confirmed)
    }

    /// `cancel()` dismisses without enabling — a distinct terminal state from `.confirmed`.
    func testCancelTransitionsToCancelled() {
        var state = ConsentSheetState(pluginName: "demo", consentBlock: sampleBlock, requiredConsents: ["exec"])
        state.cancel()
        XCTAssertEqual(state.decision, .cancelled)
    }

    func testIdentifiableIdIsThePluginName() {
        let state = ConsentSheetState(pluginName: "demo", consentBlock: sampleBlock, requiredConsents: [])
        XCTAssertEqual(state.id, "demo")
    }
}

// -----------------------------------------------------------------------------------------------
// `locatePluginRoot` — Task 3's real-filesystem (not `WinterClient`) install helper. Directly
// testable against a real temp directory rather than mocked (same posture as `CliLauncher`'s own
// `wrapperInstallPath`/`ensureWrapper` tests elsewhere in this target).
// -----------------------------------------------------------------------------------------------

final class LocatePluginRootTests: XCTestCase {
    private var tempDir: URL!

    override func setUpWithError() throws {
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("winter-locate-root-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tempDir)
    }

    func testFindsManifestAtTopLevel() {
        FileManager.default.createFile(
            atPath: tempDir.appendingPathComponent("winter-plugin.json").path, contents: Data("{}".utf8)
        )
        XCTAssertEqual(locatePluginRoot(in: tempDir)?.standardizedFileURL.path, tempDir.standardizedFileURL.path)
    }

    func testFindsLegacyManifestNameAtTopLevel() {
        FileManager.default.createFile(
            atPath: tempDir.appendingPathComponent("plugin.json").path, contents: Data("{}".utf8)
        )
        XCTAssertEqual(locatePluginRoot(in: tempDir)?.standardizedFileURL.path, tempDir.standardizedFileURL.path)
    }

    func testFindsManifestInSingleTopLevelSubdirectory() throws {
        let sub = tempDir.appendingPathComponent("demo-plugin", isDirectory: true)
        try FileManager.default.createDirectory(at: sub, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: sub.appendingPathComponent("plugin.json").path, contents: Data("{}".utf8))

        XCTAssertEqual(locatePluginRoot(in: tempDir)?.standardizedFileURL.path, sub.standardizedFileURL.path)
    }

    func testNilWhenNoManifestAnywhere() {
        XCTAssertNil(locatePluginRoot(in: tempDir))
    }

    func testNilWhenMultipleTopLevelSubdirectoriesAndNoTopLevelManifest() throws {
        for name in ["a", "b"] {
            try FileManager.default.createDirectory(
                at: tempDir.appendingPathComponent(name, isDirectory: true), withIntermediateDirectories: true
            )
        }
        XCTAssertNil(locatePluginRoot(in: tempDir))
    }

    // Fix wave 2: Finder's "Compress" zips a folder as `{PluginDir/..., __MACOSX/...}` — the
    // most common way a Mac user makes a zip. `__MACOSX` and dot-prefixed entries (`.DS_Store`,
    // `.git`) must not count as a second "top-level subdirectory" candidate.

    func testFindsManifestInSingleSubdirectoryAlongsideMACOSXDir() throws {
        let sub = tempDir.appendingPathComponent("PluginDir", isDirectory: true)
        try FileManager.default.createDirectory(at: sub, withIntermediateDirectories: true)
        FileManager.default.createFile(
            atPath: sub.appendingPathComponent("winter-plugin.json").path, contents: Data("{}".utf8)
        )

        let macosx = tempDir.appendingPathComponent("__MACOSX", isDirectory: true)
        try FileManager.default.createDirectory(at: macosx, withIntermediateDirectories: true)
        FileManager.default.createFile(
            atPath: macosx.appendingPathComponent("._PluginDir").path, contents: Data()
        )

        XCTAssertEqual(locatePluginRoot(in: tempDir)?.standardizedFileURL.path, sub.standardizedFileURL.path)
    }

    func testFindsManifestInSingleSubdirectoryAlongsideDotFile() throws {
        let sub = tempDir.appendingPathComponent("PluginDir", isDirectory: true)
        try FileManager.default.createDirectory(at: sub, withIntermediateDirectories: true)
        FileManager.default.createFile(
            atPath: sub.appendingPathComponent("plugin.json").path, contents: Data("{}".utf8)
        )

        FileManager.default.createFile(
            atPath: tempDir.appendingPathComponent(".DS_Store").path, contents: Data()
        )

        XCTAssertEqual(locatePluginRoot(in: tempDir)?.standardizedFileURL.path, sub.standardizedFileURL.path)
    }

    func testNilWhenOnlyMACOSXDirAndNoRealPluginDir() throws {
        let macosx = tempDir.appendingPathComponent("__MACOSX", isDirectory: true)
        try FileManager.default.createDirectory(at: macosx, withIntermediateDirectories: true)
        FileManager.default.createFile(
            atPath: macosx.appendingPathComponent("._something").path, contents: Data()
        )

        XCTAssertNil(locatePluginRoot(in: tempDir))
    }

    // Fix wave (Task 2 review, symlink guard): `fileExists` follows symlinks, so a manifest name
    // that's actually a symlink (pointing anywhere on disk) would otherwise be accepted. The
    // symlink's TARGET is a real file — `fileExists` on the manifest path is `true` either way, so
    // this only exercises the guard (vs. a dangling symlink, where `fileExists` alone already
    // returns `false` and the guard is never reached).
    func testNilWhenManifestIsASymlink() throws {
        let realFile = tempDir.appendingPathComponent("real-manifest.json")
        FileManager.default.createFile(atPath: realFile.path, contents: Data("{}".utf8))
        let manifestLink = tempDir.appendingPathComponent("winter-plugin.json")
        try FileManager.default.createSymbolicLink(at: manifestLink, withDestinationURL: realFile)

        XCTAssertNil(locatePluginRoot(in: tempDir))
    }
}

// -----------------------------------------------------------------------------------------------
// PluginManagerModel — the consent-sheet-driving methods (`enable`'s needsConsent path, `install`,
// `confirmConsent`, `cancelConsent`). A SEPARATE `@MainActor` test class, same posture as
// `PluginManagerModelAsyncTests` (`PluginManagerModelTests.swift`) — drives a real (actor)
// `WinterClient` end-to-end via the same scripted-transport double
// (`FeedScriptedTransport`/`feedLineJSON`/`feedWaitUntil`, `SessionFeedTests.swift`, same target).
// `PluginManagerModel` has no `PluginManagerClient` protocol seam (Task 2 didn't introduce one —
// the concrete `WinterClient` is already mockable at the transport layer), so no new seam is
// introduced here either.
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

    /// `enable`'s `.needsConsent` path opens the sheet (replacing Task 2's dead orange-banner-only
    /// surfacing) — seeded verbatim from the server's `consentBlock`/`requiredConsents`.
    func testNeedsConsentEnableOpensConsentSheet() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)

        async let action: Void = model.enable("demo")

        await feedWaitUntil { t.sent.count >= 2 }
        let enableReq = feedLineJSON(t.sent[1])
        t.feed(#"""
        {"jsonrpc":"2.0","id":\#(enableReq["id"] as! Int),"result":{"code":"needs_consent","requiredConsents":["exec"],"consentBlock":["plugin demo requests:","  exec: mcp: node server.js"]}}
        """#)

        await feedWaitUntil { t.sent.count >= 3 }
        let listReq = feedLineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"plugins":[]}}"#)

        await action

        XCTAssertEqual(model.consentSheet?.pluginName, "demo")
        XCTAssertEqual(model.consentSheet?.requiredConsents, ["exec"])
        XCTAssertEqual(model.consentSheet?.consentBlock, ["plugin demo requests:", "  exec: mcp: node server.js"])
        // (Deleted `pendingConsent`'s own `?.name` assertion here, Task 2 review fix wave — it
        // checked strictly less than the three `consentSheet` assertions immediately above, which
        // already fully cover this outcome.)
    }

    /// `confirmConsent()` re-calls `plugin.enable` with `consent:true` for the sheet's plugin —
    /// on `.ok` the sheet dismisses and the list refreshes.
    func testConfirmConsentCallsEnableWithConsentTrueAndDismisses() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        model.consentSheet = ConsentSheetState(pluginName: "demo", consentBlock: ["plugin demo requests:"], requiredConsents: ["exec"])

        async let action: Void = model.confirmConsent()

        await feedWaitUntil { t.sent.count >= 2 }
        let enableReq = feedLineJSON(t.sent[1])
        XCTAssertEqual(enableReq["method"] as? String, "plugin.enable")
        let params = enableReq["params"] as? [String: Any]
        XCTAssertEqual(params?["name"] as? String, "demo")
        XCTAssertEqual(params?["consent"] as? Bool, true)
        t.feed(#"{"jsonrpc":"2.0","id":\#(enableReq["id"] as! Int),"result":{"status":"running"}}"#)

        await feedWaitUntil { t.sent.count >= 3 }
        let listReq = feedLineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"plugins":[]}}"#)

        await action

        XCTAssertNil(model.consentSheet)
        XCTAssertNil(model.errorText)
    }

    /// `cancelConsent()` dismisses without ever calling `pluginEnable` — no RPC beyond the initial
    /// handshake is ever sent.
    func testCancelConsentDismissesWithoutEnabling() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        model.consentSheet = ConsentSheetState(pluginName: "demo", consentBlock: ["plugin demo requests:"], requiredConsents: ["exec"])

        model.cancelConsent()

        XCTAssertNil(model.consentSheet)
        XCTAssertEqual(t.sent.count, 1) // hello only
    }

    /// Fix wave (Task 2 review, consent double-submit guard): a second `confirmConsent()` call
    /// landing while the first is still in flight (its `plugin.enable` RPC not yet resolved) is a
    /// no-op — `isConfirmingConsent` guards re-entry, so at most ONE `plugin.enable` RPC is ever
    /// sent per grant, independent of the view's own `.disabled(busy)` on the button.
    func testConfirmConsentIgnoresReentryWhileFirstCallInFlight() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)
        model.consentSheet = ConsentSheetState(pluginName: "demo", consentBlock: ["plugin demo requests:"], requiredConsents: ["exec"])

        async let action1: Void = model.confirmConsent()
        async let action2: Void = model.confirmConsent()

        await feedWaitUntil { t.sent.count >= 2 }
        let enableReq = feedLineJSON(t.sent[1])
        XCTAssertEqual(enableReq["method"] as? String, "plugin.enable")
        t.feed(#"{"jsonrpc":"2.0","id":\#(enableReq["id"] as! Int),"result":{"status":"running"}}"#)

        await feedWaitUntil { t.sent.count >= 3 }
        let listReq = feedLineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"plugins":[]}}"#)

        _ = await (action1, action2)

        // hello + the ONE plugin.enable + its trailing plugins.list refresh — the second
        // `confirmConsent()` call sent nothing at all.
        XCTAssertEqual(t.sent.count, 3)
        XCTAssertNil(model.consentSheet)
    }

    /// `install(source:)`'s `.ok` result opens the SAME sheet type — even a plugin needing zero
    /// consent classes still gets one (the header-only `consentBlock`), since installs always land
    /// disabled server-side and the sheet is also the "confirm enable" step.
    func testInstallOkOpensConsentSheet() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)

        async let action: Void = model.install(source: "/tmp/some-plugin-dir")

        await feedWaitUntil { t.sent.count >= 2 }
        let installReq = feedLineJSON(t.sent[1])
        XCTAssertEqual(installReq["method"] as? String, "plugins.install")
        let installParams = installReq["params"] as? [String: Any]
        XCTAssertEqual(installParams?["source"] as? String, "/tmp/some-plugin-dir")
        t.feed(#"{"jsonrpc":"2.0","id":\#(installReq["id"] as! Int),"result":{"ok":true,"name":"demo","requiredConsents":[],"hasMcp":false,"consentBlock":["plugin demo requests:"]}}"#)

        await feedWaitUntil { t.sent.count >= 3 }
        let listReq = feedLineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"plugins":[]}}"#)

        await action

        XCTAssertEqual(model.consentSheet?.pluginName, "demo")
        XCTAssertEqual(model.consentSheet?.consentBlock, ["plugin demo requests:"])
        XCTAssertNil(model.errorText)
    }

    /// `.alreadyInstalled` surfaces via `errorText`, never opens a sheet.
    func testInstallAlreadyInstalledSurfacesErrorTextNoSheet() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)

        async let action: Void = model.install(source: "/tmp/some-plugin-dir")

        await feedWaitUntil { t.sent.count >= 2 }
        let installReq = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(installReq["id"] as! Int),"result":{"code":"already_installed","name":"demo"}}"#)

        await feedWaitUntil { t.sent.count >= 3 }
        let listReq = feedLineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"plugins":[]}}"#)

        await action

        XCTAssertNil(model.consentSheet)
        XCTAssertEqual(model.errorText, "demo is already installed")
    }

    /// `.invalidSource` surfaces via `errorText`, never opens a sheet.
    func testInstallInvalidSourceSurfacesErrorTextNoSheet() async throws {
        let (client, t) = try await connectedClient()
        let model = PluginManagerModel(client: client)

        async let action: Void = model.install(source: "/tmp/not-a-plugin")

        await feedWaitUntil { t.sent.count >= 2 }
        let installReq = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(installReq["id"] as! Int),"result":{"code":"invalid_source"}}"#)

        await feedWaitUntil { t.sent.count >= 3 }
        let listReq = feedLineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"plugins":[]}}"#)

        await action

        XCTAssertNil(model.consentSheet)
        XCTAssertEqual(model.errorText, "not a valid plugin source — no winter-plugin.json/plugin.json found")
    }
}
