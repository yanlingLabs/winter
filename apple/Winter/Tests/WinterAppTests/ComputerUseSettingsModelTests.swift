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

    private func notes(access: ComputerUseAppAccess = .full, grant: ComputerUseGrant? = nil,
                       lastUsedAt: Double? = nil) -> ComputerUseApp {
        ComputerUseApp(bundleId: "com.apple.Notes", name: "Notes", access: access, grant: grant, lastUsedAt: lastUsedAt)
    }

    private func loaded(_ client: Fake) async -> ComputerUseSettingsModel {
        let model = ComputerUseSettingsModel(client: client, permissionPollNanoseconds: 1_000, permissionPollLimit: 5)
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

    // MARK: - Apps

    func testChangingAnAppsAccessWritesThatAppAndKeepsItsGrant() async {
        let client = Fake()
        client.listAppsResults = [.success([notes(grant: .always)])]
        let model = await loaded(client)

        await model.setAccess(.click, for: notes(grant: .always))
        XCTAssertEqual(client.setAppCalls.count, 1)
        XCTAssertEqual(client.setAppCalls[0].bundleId, "com.apple.Notes")
        XCTAssertEqual(client.setAppCalls[0].name, "Notes")
        XCTAssertEqual(client.setAppCalls[0].access, .click)
        XCTAssertEqual(client.setAppCalls[0].grant, .leave, "a level change does not touch the saved answer")
        XCTAssertEqual(model.apps, [notes(access: .click, grant: .always)])
        XCTAssertTrue(model.pendingApps.isEmpty)
    }

    func testPickingTheCurrentLevelWritesNothing() async {
        let client = Fake()
        client.listAppsResults = [.success([notes(access: .view)])]
        let model = await loaded(client)
        await model.setAccess(.view, for: notes(access: .view))
        XCTAssertTrue(client.setAppCalls.isEmpty)
    }

    func testARefusedAccessChangePutsTheRowBack() async {
        let client = Fake()
        client.listAppsResults = [.success([notes(access: .full)])]
        client.setAppResult = .failure(Fake.SimpleError())
        let model = await loaded(client)
        await model.setAccess(.deny, for: notes(access: .full))
        XCTAssertEqual(model.apps, [notes(access: .full)])
        XCTAssertEqual(model.actionError, "couldn't change Notes — boom")
    }

    func testRemoveAlwaysAllowClearsOnlyTheGrant() async {
        let client = Fake()
        client.listAppsResults = [.success([notes(access: .click, grant: .always)])]
        let model = await loaded(client)

        await model.removeAlwaysAllow(for: notes(access: .click, grant: .always))
        XCTAssertEqual(client.setAppCalls.count, 1)
        XCTAssertEqual(client.setAppCalls[0].bundleId, "com.apple.Notes")
        XCTAssertNil(client.setAppCalls[0].access, "the level is not resent")
        XCTAssertEqual(client.setAppCalls[0].grant, .clear)
        XCTAssertEqual(model.apps, [notes(access: .click, grant: nil)], "the app keeps its level")
    }

    func testRemoveAlwaysAllowIsNothingForAnAppWithoutOneAndRestoresOnRefusal() async {
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

    // MARK: - The words

    func testAccessWordsAreTheDaemonsFourLevels() {
        XCTAssertEqual(ComputerUseAppAccess.allCases.map(computerUseAccessTitle),
                       ["Full", "Click only", "View only", "Don't allow"])
        XCTAssertEqual(Set(ComputerUseAppAccess.allCases.map(computerUseAccessHelp)).count, 4)
    }

    func testHelperSummary() {
        XCTAssertEqual(computerUseHelperSummary(ComputerUseHelperStatus(installed: false, running: false)), "Not installed")
        XCTAssertEqual(computerUseHelperSummary(ComputerUseHelperStatus(installed: true, running: false)),
                       "Installed — starts when a session needs it")
        XCTAssertEqual(computerUseHelperSummary(ComputerUseHelperStatus(installed: true, running: true, version: "0.1.0")),
                       "Running — version 0.1.0")
        XCTAssertEqual(computerUseHelperSummary(ComputerUseHelperStatus(installed: true, running: true)), "Running")
    }

    func testAppsAreOrderedByRecentUseThenName() {
        let apps = [
            ComputerUseApp(bundleId: "b", name: "Zed", access: .full, lastUsedAt: nil),
            ComputerUseApp(bundleId: "c", name: "Mail", access: .full, lastUsedAt: 100),
            ComputerUseApp(bundleId: "a", name: "Alpha", access: .full, lastUsedAt: nil),
            ComputerUseApp(bundleId: "d", name: "Notes", access: .full, lastUsedAt: 200),
        ]
        XCTAssertEqual(computerUseSortedApps(apps).map(\.name), ["Notes", "Mail", "Alpha", "Zed"])
        XCTAssertEqual(computerUseSortedApps([]), [])
    }

    func testLastUsedText() {
        let now = Date(timeIntervalSince1970: 1_760_000_000)
        let app = ComputerUseApp(bundleId: "a", name: "A", access: .full, lastUsedAt: (1_760_000_000 - 3 * 3600) * 1000)
        XCTAssertEqual(computerUseLastUsedText(app, now: now), "Used 3 hours ago")
        XCTAssertNil(computerUseLastUsedText(ComputerUseApp(bundleId: "a", name: "A", access: .full), now: now))
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
    }
}
