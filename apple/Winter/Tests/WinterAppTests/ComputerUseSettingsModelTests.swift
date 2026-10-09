import XCTest
import WinterKit
@testable import Winter

/// ComputerV2 — Settings → Computer Use. The model against `FakeComputerUseClient`: what a load shows,
/// that every toggle and every row writes through the client and is put back when the daemon refuses,
/// the Grant flow, and the pure words the page is made of.
///
/// **What this file does NOT cover: the drawn page.** `SettingsComputerUseSection` is a SwiftUI `View`;
/// nothing here proves a switch renders or a menu opens. The model is what decides what the page shows,
/// and the page is only given it.
@MainActor
final class ComputerUseSettingsModelTests: XCTestCase {
    private typealias Fake = FakeComputerUseClient

    private func notes(access: ComputerUseAppAccess? = .full, grant: ComputerUseGrant? = nil,
                       isDefault: Bool = false, lastUsedAt: Double? = nil) -> ComputerUseApp {
        ComputerUseApp(bundleId: "com.apple.Notes", name: "Notes", access: access, grant: grant,
                       isDefault: isDefault, lastUsedAt: lastUsedAt)
    }

    private let onePassword = ComputerUseApp(bundleId: "com.1password.1password", name: "1Password", access: .deny,
                                             grant: nil, isDefault: true)
    private let textEdit = ComputerUseApp(bundleId: "com.apple.TextEdit", name: "TextEdit", access: nil, grant: .always)

    private func loaded(_ client: Fake, enumerator: (any InstalledAppEnumerating)? = nil) async -> ComputerUseSettingsModel {
        let model = ComputerUseSettingsModel(client: client, enumerator: enumerator,
                                             permissionPollNanoseconds: 1_000, permissionPollLimit: 5)
        await model.load()
        return model
    }

    // MARK: - Loading

    func testLoadReadsTheStatusAndTheApps() async {
        let client = Fake()
        client.statusResults = [.success(Fake.status(mirror: false))]
        client.listAppsResults = [.success([notes(grant: .always)])]
        let model = await loaded(client)
        XCTAssertEqual(model.status?.mirror, false)
        XCTAssertEqual(model.apps, [notes(grant: .always)])
        XCTAssertTrue(model.hasLoaded)
        XCTAssertNil(model.statusError)
        XCTAssertNil(model.appsError)
        XCTAssertFalse(model.isLoading)
    }

    /// An app list that cannot load must not hide the toggles, and the other way round.
    func testTheTwoReadsFailSeparately() async {
        let appsDown = Fake()
        appsDown.listAppsResults = [.failure(Fake.SimpleError())]
        let a = await loaded(appsDown)
        XCTAssertNotNil(a.status)
        XCTAssertNil(a.statusError)
        XCTAssertNotNil(a.appsError)

        let statusDown = Fake()
        statusDown.statusResults = [.failure(Fake.SimpleError())]
        statusDown.listAppsResults = [.success([notes()])]
        let s = await loaded(statusDown)
        XCTAssertNil(s.status)
        XCTAssertNotNil(s.statusError)
        XCTAssertEqual(s.apps.count, 1)
        XCTAssertNil(s.appsError)
    }

    func testWithoutAClientTheModelDoesNothing() async {
        let model = ComputerUseSettingsModel(client: nil)
        XCTAssertFalse(model.isWired)
        await model.load()
        await model.setMirror(false)
        await model.grant(.accessibility)
        XCTAssertNil(model.status)
        XCTAssertFalse(model.hasLoaded, "nothing was asked, so nothing has answered")
        XCTAssertNil(model.actionError)
    }

    // MARK: - The three toggles

    func testEachToggleWritesOnlyItsOwnKeyAndReadsTheDaemonBack() async {
        let client = Fake()
        client.statusResults = [.success(Fake.status()), .success(Fake.status(mirror: false))]
        let model = await loaded(client)

        await model.setMirror(false)
        XCTAssertEqual(client.setSettingsCalls, [ComputerUseSettingsPatch(mirror: false)])
        XCTAssertEqual(model.status?.mirror, false)
        XCTAssertEqual(client.statusCallCount, 2, "a write is followed by one read of what the daemon now says")
        XCTAssertNil(model.actionError)

        await model.setEnabled(false)
        await model.setPrivateEventPath(false)
        XCTAssertEqual(client.setSettingsCalls.dropFirst().map { $0 },
                       [ComputerUseSettingsPatch(enabled: false), ComputerUseSettingsPatch(privateEventPath: false)])
    }

    /// The optimistic copy never outlives a refusal: the switch goes back and the reason is one line.
    func testARefusedWritePutsTheSwitchBackAndSaysWhy() async {
        let client = Fake()
        client.statusResults = [.success(Fake.status(mirror: true))]
        client.setSettingsResult = .failure(Fake.SimpleError())
        let model = await loaded(client)

        await model.setMirror(false)
        XCTAssertEqual(model.status?.mirror, true)
        XCTAssertEqual(model.actionError, "couldn't change the mirror — boom")
        XCTAssertFalse(model.isSavingSettings)
    }

    /// The proposed write is a new RPC; a daemon without it answers `-32601`, and the page says that
    /// plainly instead of presenting it as a fault.
    func testADaemonWithoutTheWriteIsToldPlainly() async {
        let client = Fake()
        client.setSettingsResult = .failure(RpcError(code: -32601, message: "Method not found"))
        let model = await loaded(client)
        await model.setEnabled(false)
        XCTAssertEqual(model.status?.enabled, true)
        XCTAssertEqual(model.actionError, "couldn't change Computer Use — this daemon doesn't support that yet")
    }

    /// If the read-back fails, the optimistic copy stands — the write itself succeeded.
    func testAFailedReadBackKeepsTheWrittenValue() async {
        let client = Fake()
        client.statusResults = [.success(Fake.status(privateEventPath: true)), .failure(Fake.SimpleError())]
        let model = await loaded(client)
        await model.setPrivateEventPath(false)
        XCTAssertEqual(model.status?.privateEventPath, false)
        XCTAssertNil(model.actionError)
    }

    func testTogglingNeverSendsAnEmptyPatchOrTouchesTheLegacyFlag() async {
        let client = Fake()
        client.statusResults = [.success(Fake.status(legacyComputer: true))]
        let model = await loaded(client)
        await model.setEnabled(false)
        await model.setMirror(false)
        await model.setPrivateEventPath(false)
        XCTAssertEqual(model.status?.legacyComputer, true)
        XCTAssertTrue(client.setSettingsCalls.allSatisfy { !$0.isEmpty }, "no empty patch is ever sent")
    }

    // MARK: - Permissions

    func testPermissionStatesComeFromTheHelperAndUnknownIsNotDenied() async {
        let client = Fake()
        client.statusResults = [.success(Fake.status(helper: Fake.running(accessibility: true, screenRecording: false)))]
        let model = await loaded(client)
        XCTAssertEqual(model.permissionState(.accessibility), .granted)
        XCTAssertEqual(model.permissionState(.screenRecording), .notGranted)
        XCTAssertFalse(model.allPermissionsGranted)

        let idle = Fake()
        let idleModel = await loaded(idle)
        XCTAssertEqual(idleModel.permissionState(.accessibility), .unknown)
        XCTAssertEqual(idleModel.permissionState(.screenRecording), .unknown)
    }

    /// Grant asks for exactly that permission, then watches the status until both read granted.
    func testGrantAsksForThePermissionThenWatchesUntilItIsGranted() async {
        let client = Fake()
        client.statusResults = [
            .success(Fake.status(helper: Fake.running(accessibility: false, screenRecording: true))),
            .success(Fake.status(helper: Fake.running(accessibility: false, screenRecording: true))),
            .success(Fake.status(helper: Fake.running(accessibility: true, screenRecording: true))),
        ]
        let model = await loaded(client)

        await model.grant(.accessibility)
        XCTAssertEqual(client.requestPermissionCalls, [.accessibility])
        XCTAssertNil(model.actionError)
        await model.waitForPermissionWatch()
        XCTAssertEqual(model.permissionState(.accessibility), .granted)
        XCTAssertTrue(model.allPermissionsGranted)
        XCTAssertEqual(client.statusCallCount, 3, "the watch stops as soon as everything is granted")
    }

    func testTheWatchIsBoundedAndCanBeStopped() async {
        let client = Fake()
        client.statusResults = [.success(Fake.status(helper: Fake.running(accessibility: false, screenRecording: false)))]
        let model = await loaded(client)
        await model.grant(.screenRecording)
        await model.waitForPermissionWatch()
        XCTAssertEqual(client.statusCallCount, 1 + 5, "one load, then at most the poll limit")

        model.stopWatching()
        await model.waitForPermissionWatch()
    }

    func testARefusedGrantSaysSo() async {
        let client = Fake()
        client.requestPermissionResult = .failure(Fake.SimpleError())
        let model = await loaded(client)
        await model.grant(.accessibility)
        XCTAssertEqual(model.actionError, "couldn't ask for Accessibility — boom")
        XCTAssertNil(model.requestingPermission)
        XCTAssertEqual(client.statusCallCount, 1, "a refused ask starts no watch")
    }

    // MARK: - Allow all apps

    func testTheMasterSwitchDefaultsOnWritesOnlyItsKeyAndReadsTheDaemonBack() async {
        let client = Fake()
        client.statusResults = [.success(Fake.status()), .success(Fake.status(allowAllApps: false))]
        let model = await loaded(client)
        XCTAssertTrue(model.allowAllApps)

        await model.setAllowAllApps(false)
        XCTAssertEqual(client.setSettingsCalls, [ComputerUseSettingsPatch(allowAllApps: false)])
        XCTAssertFalse(model.allowAllApps)
        XCTAssertEqual(model.status?.allowAllApps, false)
        XCTAssertNil(model.actionError)
    }

    func testAnUnreadSwitchReadsAsOnAndARefusedWritePutsItBack() async {
        XCTAssertTrue(ComputerUseSettingsModel(client: nil).allowAllApps, "on is the default before the daemon answers")

        let client = Fake()
        client.setSettingsResult = .failure(Fake.SimpleError())
        let model = await loaded(client)
        await model.setAllowAllApps(false)
        XCTAssertTrue(model.allowAllApps)
        XCTAssertEqual(model.actionError, "couldn't change Allow all apps — boom")
    }

    func testTheCaptionFollowsTheSwitch() {
        XCTAssertEqual(computerUseAllowAllAppsCaption(true), "Computer Use may act in any app, except the ones below.")
        XCTAssertEqual(computerUseAllowAllAppsCaption(false), "Computer Use may only use the apps below.")
    }

    // MARK: - Exceptions

    func testExceptionsAreTheRowsWithALevelAndAlwaysAllowedAreTheRowsWithAGrant() async {
        let client = Fake()
        client.listAppsResults = [.success([textEdit, notes(access: .click, grant: .always), onePassword])]
        let model = await loaded(client)
        XCTAssertEqual(model.exceptions.map(\.name), ["1Password", "Notes"], "by name; a grant-only row is not an exception")
        XCTAssertEqual(model.alwaysAllowed.map(\.name), ["Notes", "TextEdit"])
        XCTAssertTrue(model.exceptions[0].isDefault, "the daemon's own default is tagged")
        XCTAssertFalse(model.exceptions[1].isDefault)
    }

    /// Each row resolves its bundle id to an app on disk; one that does not resolve is not installed and
    /// has no icon path, which is what draws the generic icon and the dimmed row.
    func testARowWhoseAppIsNotInstalledHasNoIconPathAndIsNotInstalled() async {
        let client = Fake()
        client.listAppsResults = [.success([notes(access: .click), onePassword])]
        let enumerator = FakeInstalledAppEnumerator(apps: [], paths: ["com.apple.Notes": "/System/Applications/Notes.app"])
        let model = await loaded(client, enumerator: enumerator)

        let notesRow = model.exceptions[1]
        XCTAssertEqual(model.iconPath(for: notesRow), "/System/Applications/Notes.app")
        XCTAssertTrue(model.isInstalled(notesRow))
        let passwordRow = model.exceptions[0]
        XCTAssertNil(model.iconPath(for: passwordRow))
        XCTAssertFalse(model.isInstalled(passwordRow))
        XCTAssertEqual(enumerator.pathLookups.sorted(), ["com.1password.1password", "com.apple.Notes"])
        XCTAssertFalse(enumerator.anyCallWasOnTheMainThread, "paths are resolved off the main thread")
    }

    func testWithoutAnEnumeratorNothingIsInstalled() async {
        let client = Fake()
        client.listAppsResults = [.success([notes(access: .click)])]
        let model = await loaded(client)
        XCTAssertFalse(model.isInstalled(model.exceptions[0]))
    }

    func testChangingALevelWritesThatAppWithItsNameAndKeepsItsGrantAndDefaultTag() async {
        let client = Fake()
        client.listAppsResults = [.success([onePassword])]
        let model = await loaded(client)

        await model.setAccess(.view, for: onePassword)
        XCTAssertEqual(client.setAppCalls.count, 1)
        XCTAssertEqual(client.setAppCalls[0].bundleId, "com.1password.1password")
        XCTAssertEqual(client.setAppCalls[0].name, "1Password")
        XCTAssertEqual(client.setAppCalls[0].access, .set(.view))
        XCTAssertEqual(client.setAppCalls[0].grant, .leave)
        XCTAssertEqual(model.apps.first?.access, .view)
        XCTAssertEqual(model.apps.first?.isDefault, true, "a default row can be changed and stays tagged")
    }

    /// Allow is a level like the others: setting an exception back to it sends `full`.
    func testSettingBackToAllowSendsFull() async {
        let client = Fake()
        client.listAppsResults = [.success([notes(access: .click)])]
        let model = await loaded(client)
        await model.setAccess(.full, for: notes(access: .click))
        XCTAssertEqual(client.setAppCalls.map(\.access), [.set(.full)])
        XCTAssertEqual(model.apps, [notes(access: .full)])
    }

    func testPickingTheCurrentLevelWritesNothing() async {
        let client = Fake()
        client.listAppsResults = [.success([notes(access: .view)])]
        let model = await loaded(client)
        await model.setAccess(.view, for: notes(access: .view))
        XCTAssertTrue(client.setAppCalls.isEmpty)
    }

    func testARefusedLevelChangePutsTheRowBack() async {
        let client = Fake()
        client.listAppsResults = [.success([notes(access: .full)])]
        client.setAppResult = .failure(Fake.SimpleError())
        let model = await loaded(client)
        await model.setAccess(.deny, for: notes(access: .full))
        XCTAssertEqual(model.apps, [notes(access: .full)])
        XCTAssertEqual(model.actionError, "couldn't change Notes — boom")
    }

    func testRemovingAnExceptionSendsAccessNullAndDropsTheRow() async {
        let client = Fake()
        client.listAppsResults = [.success([notes(access: .click), onePassword])]
        let model = await loaded(client)

        await model.removeException(notes(access: .click))
        XCTAssertEqual(client.setAppCalls.count, 1)
        XCTAssertEqual(client.setAppCalls[0].bundleId, "com.apple.Notes")
        XCTAssertNil(client.setAppCalls[0].name)
        XCTAssertEqual(client.setAppCalls[0].access, .remove)
        XCTAssertEqual(client.setAppCalls[0].grant, .leave)
        XCTAssertEqual(model.apps, [onePassword])

        // A default row can be removed too.
        await model.removeException(onePassword)
        XCTAssertEqual(client.setAppCalls.last?.bundleId, "com.1password.1password")
        XCTAssertTrue(model.apps.isEmpty)
    }

    /// An app that is an exception AND holds an always-grant stays in the grants list when the exception
    /// goes.
    func testRemovingAnExceptionKeepsAGrantOnlyRow() async {
        let client = Fake()
        client.listAppsResults = [.success([notes(access: .click, grant: .always)])]
        let model = await loaded(client)
        await model.removeException(notes(access: .click, grant: .always))
        XCTAssertEqual(model.apps, [notes(access: nil, grant: .always)])
        XCTAssertTrue(model.exceptions.isEmpty)
        XCTAssertEqual(model.alwaysAllowed.map(\.name), ["Notes"])
    }

    func testARefusedRemovalOrAGrantOnlyRowChangesNothing() async {
        let client = Fake()
        client.listAppsResults = [.success([notes(access: .click), textEdit])]
        client.setAppResult = .failure(Fake.SimpleError())
        let model = await loaded(client)

        await model.removeException(notes(access: .click))
        XCTAssertEqual(Set(model.apps.map(\.bundleId)), ["com.apple.Notes", "com.apple.TextEdit"], "the row is back")
        XCTAssertEqual(model.actionError, "couldn't remove the exception for Notes — boom")

        client.setAppResult = .success(())
        let calls = client.setAppCalls.count
        await model.removeException(textEdit)
        XCTAssertEqual(client.setAppCalls.count, calls, "a grant-only row has no exception to remove")
    }

    // MARK: - The add sheet

    private func installed(_ name: String, _ id: String) -> InstalledApp {
        InstalledApp(bundleId: id, name: name, path: "/Applications/\(name).app")
    }

    func testTheSheetScansOnceOffTheMainThreadAndExcludesExistingExceptions() async {
        let client = Fake()
        client.listAppsResults = [.success([notes(access: .click)])]
        let enumerator = FakeInstalledAppEnumerator(apps: [
            installed("Safari", "com.apple.Safari"), installed("Notes", "com.apple.Notes"),
            installed("Calendar", "com.apple.iCal"), installed("calculator", "com.apple.calculator"),
        ])
        let model = await loaded(client, enumerator: enumerator)
        XCTAssertEqual(enumerator.scanCount, 0, "loading the page does not scan the disk")

        await model.loadInstalledApps()
        await model.loadInstalledApps()
        XCTAssertEqual(enumerator.scanCount, 1, "cached for the page's lifetime")
        XCTAssertFalse(enumerator.anyCallWasOnTheMainThread)
        XCTAssertEqual(model.addableApps(query: "").map(\.name), ["calculator", "Calendar", "Safari"],
                       "by name, case-insensitively, without the existing exception")
    }

    func testTheSheetSearchMatchesNameOrBundleId() async {
        let enumerator = FakeInstalledAppEnumerator(apps: [
            installed("Safari", "com.apple.Safari"), installed("Notes", "com.apple.Notes"),
            installed("Slack", "com.tinyspeck.slackmacgap"),
        ])
        let model = await loaded(Fake(), enumerator: enumerator)
        await model.loadInstalledApps()
        XCTAssertEqual(model.addableApps(query: "saf").map(\.name), ["Safari"])
        XCTAssertEqual(model.addableApps(query: "  SLACK ").map(\.name), ["Slack"])
        XCTAssertEqual(model.addableApps(query: "tinyspeck").map(\.name), ["Slack"], "the bundle id matches too")
        XCTAssertEqual(model.addableApps(query: "com.apple").map(\.name), ["Notes", "Safari"])
        XCTAssertTrue(model.addableApps(query: "zzz").isEmpty)
    }

    func testAddableAppsIsPureDedupesAndIgnoresDiacritics() {
        let apps = [installed("Résumé", "a.resume"), installed("Resume Again", "b.resume"),
                    installed("Résumé", "a.resume"), installed("Zed", "z")]
        XCTAssertEqual(computerUseAddableApps(installed: apps, exceptionIds: [], query: "resume").map(\.bundleId),
                       ["a.resume", "b.resume"])
        XCTAssertEqual(computerUseAddableApps(installed: apps, exceptionIds: ["a.resume"], query: "").map(\.bundleId),
                       ["b.resume", "z"])
        XCTAssertEqual(computerUseAddableApps(installed: [], exceptionIds: [], query: "x"), [])
    }

    func testAddingAnAppMakesItAClickOnlyException() async {
        let client = Fake()
        let enumerator = FakeInstalledAppEnumerator(apps: [installed("Safari", "com.apple.Safari")])
        let model = await loaded(client, enumerator: enumerator)
        await model.loadInstalledApps()

        let added = await model.addException(installed("Safari", "com.apple.Safari"))
        XCTAssertTrue(added)
        XCTAssertEqual(client.setAppCalls.count, 1)
        XCTAssertEqual(client.setAppCalls[0].bundleId, "com.apple.Safari")
        XCTAssertEqual(client.setAppCalls[0].name, "Safari")
        XCTAssertEqual(client.setAppCalls[0].access, .set(.click))
        XCTAssertEqual(client.setAppCalls[0].grant, .leave)
        XCTAssertEqual(model.exceptions.map(\.bundleId), ["com.apple.Safari"])
        XCTAssertEqual(model.exceptions.first?.access, .click)
        XCTAssertEqual(model.iconPath(for: model.exceptions[0]), "/Applications/Safari.app", "its icon is known at once")
        XCTAssertTrue(model.addableApps(query: "").isEmpty, "an exception is no longer offered")
    }

    func testAddingAnAppThatHoldsAGrantKeepsTheGrant() async {
        let client = Fake()
        client.listAppsResults = [.success([textEdit])]
        let model = await loaded(client)
        await model.addException(installed("TextEdit", "com.apple.TextEdit"))
        XCTAssertEqual(model.apps, [ComputerUseApp(bundleId: "com.apple.TextEdit", name: "TextEdit", access: .click, grant: .always)])
    }

    func testARefusedAddLeavesTheListAndSaysSo() async {
        let client = Fake()
        client.setAppResult = .failure(Fake.SimpleError())
        let model = await loaded(client)
        let added = await model.addException(installed("Safari", "com.apple.Safari"))
        XCTAssertFalse(added)
        XCTAssertTrue(model.apps.isEmpty)
        XCTAssertEqual(model.actionError, "couldn't add Safari — boom")
    }

    // MARK: - Always allowed in sessions

    func testRemovingAnAlwaysAllowSendsGrantNullAndKeepsAnExceptionsLevel() async {
        let client = Fake()
        client.listAppsResults = [.success([notes(access: .click, grant: .always), textEdit])]
        let model = await loaded(client)

        await model.removeAlwaysAllow(for: notes(access: .click, grant: .always))
        XCTAssertEqual(client.setAppCalls.count, 1)
        XCTAssertEqual(client.setAppCalls[0].bundleId, "com.apple.Notes")
        XCTAssertNil(client.setAppCalls[0].name)
        XCTAssertEqual(client.setAppCalls[0].access, .leave, "the level is not touched")
        XCTAssertEqual(client.setAppCalls[0].grant, .clear)
        XCTAssertEqual(model.apps.first { $0.bundleId == "com.apple.Notes" }, notes(access: .click, grant: nil))

        await model.removeAlwaysAllow(for: textEdit)
        XCTAssertNil(model.apps.first { $0.bundleId == "com.apple.TextEdit" }, "a grant-only row goes with its grant")
        XCTAssertTrue(model.alwaysAllowed.isEmpty, "so the subsection hides")
    }

    func testRemovingAnAlwaysAllowIsNothingForAnAppWithoutOneAndRestoresOnRefusal() async {
        let client = Fake()
        client.listAppsResults = [.success([notes(grant: .always)])]
        let model = await loaded(client)

        await model.removeAlwaysAllow(for: notes(grant: nil))
        XCTAssertTrue(client.setAppCalls.isEmpty)

        client.setAppResult = .failure(Fake.SimpleError())
        await model.removeAlwaysAllow(for: notes(grant: .always))
        XCTAssertEqual(model.apps, [notes(grant: .always)], "the grant is back")
        XCTAssertEqual(model.actionError, "couldn't remove always-allow for Notes — boom")
    }

    // MARK: - The disk enumerator

    /// The real enumerator against a temp tree (never the real /Applications): `.app` bundles in a root
    /// and one level of subfolders, nothing deeper, the first of a repeated id, no app without an id, and
    /// not Winter itself.
    func testTheFileEnumeratorFindsAppsOneLevelDeep() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("cu-enum-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let a = root.appendingPathComponent("A"), b = root.appendingPathComponent("B")

        func makeApp(_ dir: URL, _ file: String, id: String?, displayName: String? = nil, name: String? = nil) throws {
            let contents = dir.appendingPathComponent(file).appendingPathComponent("Contents")
            try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
            var plist: [String: Any] = [:]
            if let id { plist["CFBundleIdentifier"] = id }
            if let displayName { plist["CFBundleDisplayName"] = displayName }
            if let name { plist["CFBundleName"] = name }
            try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
                .write(to: contents.appendingPathComponent("Info.plist"))
        }
        try makeApp(a, "Foo.app", id: "com.x.foo", displayName: "Foo Display", name: "Foo")
        try makeApp(a.appendingPathComponent("Utilities"), "Term.app", id: "com.x.term", name: "Term Name")
        try makeApp(a.appendingPathComponent("Utilities/Deep"), "TooDeep.app", id: "com.x.deep")
        try makeApp(a, "NoId.app", id: nil)
        try makeApp(a, "Winter.app", id: "com.winter.app")
        try makeApp(a, "Plain.app", id: "com.x.plain")
        try makeApp(b, "Foo.app", id: "com.x.foo", displayName: "Foo From B")
        try makeApp(b, "Bar.app", id: "com.x.bar")
        try Data().write(to: a.appendingPathComponent("readme.txt"))

        let found = FileInstalledAppEnumerator(roots: [a, b, root.appendingPathComponent("Missing")]).installedApps()
        let byId = Dictionary(uniqueKeysWithValues: found.map { ($0.bundleId, $0) })
        XCTAssertEqual(Set(byId.keys), ["com.x.foo", "com.x.term", "com.x.plain", "com.x.bar"])
        XCTAssertEqual(byId["com.x.foo"]?.name, "Foo Display", "the first root wins a repeated id; the display name wins")
        XCTAssertEqual(byId["com.x.term"]?.name, "Term Name", "falls back to CFBundleName")
        XCTAssertEqual(byId["com.x.plain"]?.name, "Plain", "and then to the file name")
        // /var is a symlink to /private/var on macOS; the bundle may report either spelling.
        XCTAssertEqual(byId["com.x.foo"].map { URL(fileURLWithPath: $0.path).resolvingSymlinksInPath().path },
                       a.appendingPathComponent("Foo.app").resolvingSymlinksInPath().path)
    }

    // MARK: - The words

    func testAccessWordsAreAllowClickViewDontAllow() {
        XCTAssertEqual(ComputerUseAppAccess.allCases.map(computerUseAccessTitle),
                       ["Allow", "Click only", "View only", "Don't allow"])
        XCTAssertEqual(ComputerUseAppAccess.full.rawValue, "full", "Allow is still `full` on the wire")
        XCTAssertEqual(Set(ComputerUseAppAccess.allCases.map(computerUseAccessHelp)).count, 4)
    }

    func testHelperSummary() {
        XCTAssertEqual(computerUseHelperSummary(ComputerUseHelperStatus(installed: false, running: false)), "Not installed")
        XCTAssertEqual(computerUseHelperSummary(ComputerUseHelperStatus(installed: true, running: false)),
                       "Installed — starts when a session needs it")
        XCTAssertEqual(computerUseHelperSummary(ComputerUseHelperStatus(installed: true, running: true, version: "0.1.0")),
                       "Running — version 0.1.0")
        XCTAssertEqual(computerUseHelperSummary(ComputerUseHelperStatus(installed: true, running: true)), "Running")
        let tooOld = "Winter Computer Use is too old for this Winter (it speaks helper protocol 0, Winter speaks 1) — update Winter"
        XCTAssertEqual(computerUseHelperSummary(ComputerUseHelperStatus(
            installed: true, running: true, version: "0.9.0",
            protocolMismatch: ComputerUseHelperProtocolMismatch(helperProtocol: 0, helperVersion: "0.9.0", winterProtocol: 1, message: tooOld))),
            tooOld, "an incompatible helper says so, not \"Running\"")
    }

    // MARK: - Where the page sits

    /// The page replaced the coming-soon copy: it is a built section that needs the daemon, and none of
    /// its sentences carries a backtick (they reach `Text` as variables, which are not parsed as
    /// Markdown).
    func testComputerUseIsABuiltPageAndItsCopyIsPlainText() {
        XCTAssertTrue(settingsSectionOrder.contains(.computerUse))
        XCTAssertFalse(settingsSectionIsComing(.computerUse))
        XCTAssertNil(settingsSectionComingCopy(.computerUse))
        XCTAssertFalse(settingsSectionRendersWithoutWiring(.computerUse), "it reads the daemon, so it needs wiring")
        for copy in [settingsComputerUseEnableDescription, settingsComputerUseMirrorDescription,
                     settingsComputerUsePrivateEventPathDescription, settingsComputerUseLegacyNote,
                     settingsComputerUseAppsFootnote] {
            XCTAssertFalse(copy.isEmpty)
            XCTAssertFalse(copy.contains("`"), copy)
        }
        XCTAssertTrue(settingsComputerUseEnableDescription.contains("Chat never"), "ComputerV2 is code and dispatch only")
        XCTAssertEqual(settingsComputerUseAppsFootnote,
                       "Exceptions set the most Computer Use can do in an app, under every approval policy (Bypass included). "
                       + "When a session first uses an app, you approve it once, for the session, or always — within that limit. "
                       + "Don't allow also keeps the app out of whole-screen screenshots.")
    }
}
