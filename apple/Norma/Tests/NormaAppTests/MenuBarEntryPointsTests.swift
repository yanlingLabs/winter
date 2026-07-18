import XCTest
import AppKit
@testable import Norma

/// Task 3 (2e-iv): the menu bar's two new entry points — "Open CLI" (`CliLauncher.openCli`, Task 1)
/// and "Open Norma App" (`AppDelegate.openStandaloneNormaWindow`, Task 2). No prior MenuBarController
/// test file existed (grepped Tests/ — only `ScaffoldTests.testBootInstallsMenuBar`, which just
/// asserts `menuBar` is non-nil after `boot()`), so this is a new file.
///
/// `statusItem` and the two new items (`openCliItem`/`openNormaAppItem`) are exposed as internal
/// (not `private`) stored properties on `MenuBarController` specifically so this file — via
/// `@testable import Norma` — can walk the real built `NSMenu` for order and fire the items'
/// `target`/`action` directly for the closure-firing assertions, exactly like a real menu click
/// would (`NSApplication.sendAction`), without needing to call the `@objc private` methods by name.
@MainActor
final class MenuBarEntryPointsTests: XCTestCase {
    private func makeController(
        openCli: @escaping () -> Void = {},
        openNormaApp: @escaping () -> Void = {},
        openDashboard: @escaping () -> Void = {},
        openPluginManager: @escaping () -> Void = {},
        openPairDevice: @escaping () -> Void = {},
        openPairedDevices: @escaping () -> Void = {},
        loginItemController: LoginItemController? = nil,
        panic: @escaping () -> Void = {},
        quit: @escaping () -> Void = {},
        onReallyQuit: @escaping () -> Void = {},
        onRestartDaemon: @escaping () -> Void = {},
        onCheckForUpdates: @escaping () -> Void = {},
        onInstallUpdate: @escaping () -> Void = {}
    ) -> MenuBarController {
        MenuBarController(
            statusLine: { "idle" },
            toggleOrb: {},
            summonField: {},
            openCli: openCli,
            openNormaApp: openNormaApp,
            openDashboard: openDashboard,
            openPluginManager: openPluginManager,
            openPairDevice: openPairDevice,
            openPairedDevices: openPairedDevices,
            // A fresh, uniquely-named `UserDefaults` suite per call — never `UserDefaults.standard`,
            // so these menu-shape/closure-firing tests (which don't care about login-item
            // persistence) never leave a stray key behind in the real xctest-host defaults domain.
            loginItemController: loginItemController
                ?? LoginItemController(service: FakeLoginItemService(), defaults: UserDefaults(suiteName: "MenuBarEntryPointsTests.\(UUID().uuidString)")!),
            panic: panic,
            quit: quit,
            onReallyQuit: onReallyQuit,
            onRestartDaemon: onRestartDaemon,
            onCheckForUpdates: onCheckForUpdates,
            onInstallUpdate: onInstallUpdate
        )
    }

    // MARK: - Menu shape / order

    func testMenuContainsOpenCliAndOpenNormaAppAfterSummonField() {
        let controller = makeController()
        controller.install()

        let items = controller.statusItem?.menu?.items ?? []
        let titles = items.map(\.title)

        XCTAssertTrue(titles.contains("Open CLI"))
        XCTAssertTrue(titles.contains("Open Norma App"))

        guard let summonIdx = titles.firstIndex(of: "Summon Field"),
              let cliIdx = titles.firstIndex(of: "Open CLI"),
              let appIdx = titles.firstIndex(of: "Open Norma App"),
              let quitIdx = titles.firstIndex(of: "Quit Norma") else {
            XCTFail("expected all four items present, got \(titles)")
            return
        }

        XCTAssertLessThan(summonIdx, cliIdx, "Open CLI must come after Summon Field")
        XCTAssertLessThan(cliIdx, appIdx, "Open Norma App must come right after Open CLI")
        XCTAssertLessThan(appIdx, quitIdx, "both new items must precede Quit Norma")

        // Exactly one separator between Summon Field and Open CLI (the new one this task inserts),
        // and Open CLI/Open Norma App are adjacent (no separator between them).
        XCTAssertEqual(cliIdx, summonIdx + 2, "expected exactly one separator between Summon Field and Open CLI")
        XCTAssertEqual(appIdx, cliIdx + 1, "Open CLI and Open Norma App must be adjacent, no separator between them")
        XCTAssertTrue(items[summonIdx + 1].isSeparatorItem)
    }

    // MARK: - Task 5 (2f-ii): "Dashboard…" — same section, mirrors Open CLI/Open Norma App exactly.

    func testMenuContainsDashboardRightAfterOpenNormaAppThenPluginManagerThenPreQuitSeparator() {
        let controller = makeController()
        controller.install()

        let items = controller.statusItem?.menu?.items ?? []
        let titles = items.map(\.title)

        guard let appIdx = titles.firstIndex(of: "Open Norma App"),
              let dashboardIdx = titles.firstIndex(of: "Dashboard…"),
              let pluginManagerIdx = titles.firstIndex(of: "Manage Plugins…"),
              let quitIdx = titles.firstIndex(of: "Quit Norma") else {
            XCTFail("expected Open Norma App, Dashboard…, Manage Plugins…, and Quit Norma present, got \(titles)")
            return
        }

        XCTAssertEqual(dashboardIdx, appIdx + 1, "Dashboard… must be adjacent to Open Norma App, no separator between them")
        // Phase 4d-iii Task 2: "Manage Plugins…" is adjacent to Dashboard…, same posture as
        // Dashboard… itself being adjacent to Open Norma App — no separator between them either.
        XCTAssertEqual(pluginManagerIdx, dashboardIdx + 1, "Manage Plugins… must be adjacent to Dashboard…, no separator between them")
        // SP2b T5: "Pair a Device…"/"Paired Devices…" sit right after Manage Plugins… — same
        // "adjacent, no separator" posture as every other entry point in this run.
        guard let pairDeviceIdx = titles.firstIndex(of: "Pair a Device…"),
              let pairedDevicesIdx = titles.firstIndex(of: "Paired Devices…") else {
            return XCTFail("expected Pair a Device… and Paired Devices… present, got \(titles)")
        }
        XCTAssertEqual(pairDeviceIdx, pluginManagerIdx + 1, "Pair a Device… must be adjacent to Manage Plugins…, no separator between them")
        XCTAssertEqual(pairedDevicesIdx, pairDeviceIdx + 1, "Paired Devices… must be adjacent to Pair a Device…, no separator between them")
        // Lifecycle T4: "Launch Norma at login" sits between Paired Devices… and the pre-existing
        // pre-Quit separator — still no separator between Paired Devices… and it.
        guard let loginItemIdx = titles.firstIndex(of: "Launch Norma at login") else {
            return XCTFail("expected Launch Norma at login present, got \(titles)")
        }
        XCTAssertEqual(loginItemIdx, pairedDevicesIdx + 1, "Launch Norma at login must be adjacent to Paired Devices…, no separator between them")
        // Sparkle T3: "Check for Updates…" sits between "Launch Norma at login" and the
        // pre-existing pre-Quit separator — still no separator between Launch Norma at login and it.
        guard let checkForUpdatesIdx = titles.firstIndex(of: "Check for Updates…") else {
            return XCTFail("expected Check for Updates… present, got \(titles)")
        }
        XCTAssertEqual(checkForUpdatesIdx, loginItemIdx + 1, "Check for Updates… must be adjacent to Launch Norma at login, no separator between them")
        XCTAssertEqual(quitIdx, checkForUpdatesIdx + 2)
        XCTAssertTrue(items[checkForUpdatesIdx + 1].isSeparatorItem)
    }

    func testDashboardItemFiresInjectedClosure() {
        var fired = 0
        let controller = makeController(openDashboard: { fired += 1 })
        controller.install()

        let item = controller.dashboardItem
        XCTAssertNotNil(item.target)
        XCTAssertNotNil(item.action)
        NSApp.sendAction(item.action!, to: item.target, from: item)

        XCTAssertEqual(fired, 1)
    }

    func testPluginManagerItemFiresInjectedClosure() {
        var fired = 0
        let controller = makeController(openPluginManager: { fired += 1 })
        controller.install()

        let item = controller.pluginManagerItem
        XCTAssertNotNil(item.target)
        XCTAssertNotNil(item.action)
        NSApp.sendAction(item.action!, to: item.target, from: item)

        XCTAssertEqual(fired, 1)
    }

    func testPairDeviceItemFiresInjectedClosure() {
        var fired = 0
        let controller = makeController(openPairDevice: { fired += 1 })
        controller.install()

        let item = controller.pairDeviceItem
        XCTAssertNotNil(item.target)
        XCTAssertNotNil(item.action)
        NSApp.sendAction(item.action!, to: item.target, from: item)

        XCTAssertEqual(fired, 1)
    }

    func testPairedDevicesItemFiresInjectedClosure() {
        var fired = 0
        let controller = makeController(openPairedDevices: { fired += 1 })
        controller.install()

        let item = controller.pairedDevicesItem
        XCTAssertNotNil(item.target)
        XCTAssertNotNil(item.action)
        NSApp.sendAction(item.action!, to: item.target, from: item)

        XCTAssertEqual(fired, 1)
    }

    /// Firing "Manage Plugins…" must never fire "Dashboard…" (and vice versa) — same independence
    /// guarantee as `testOpenCliAndOpenNormaAppClosuresAreIndependent`.
    func testDashboardAndPluginManagerClosuresAreIndependent() {
        var dashboardFired = 0
        var pluginManagerFired = 0
        let controller = makeController(
            openDashboard: { dashboardFired += 1 },
            openPluginManager: { pluginManagerFired += 1 }
        )
        controller.install()

        let pluginManagerItem = controller.pluginManagerItem
        NSApp.sendAction(pluginManagerItem.action!, to: pluginManagerItem.target, from: pluginManagerItem)

        XCTAssertEqual(pluginManagerFired, 1)
        XCTAssertEqual(dashboardFired, 0)
    }

    func testInstallIsIdempotentForNewItems() {
        // Matches install()'s existing `guard statusItem == nil else { return }` idempotence —
        // a second install() call must not duplicate the new items either.
        let controller = makeController()
        controller.install()
        controller.install()
        let titles = controller.statusItem?.menu?.items.map(\.title) ?? []
        XCTAssertEqual(titles.filter { $0 == "Open CLI" }.count, 1)
        XCTAssertEqual(titles.filter { $0 == "Open Norma App" }.count, 1)
        XCTAssertEqual(titles.filter { $0 == "Dashboard…" }.count, 1)
        XCTAssertEqual(titles.filter { $0 == "Manage Plugins…" }.count, 1)
        XCTAssertEqual(titles.filter { $0 == "Pair a Device…" }.count, 1)
        XCTAssertEqual(titles.filter { $0 == "Paired Devices…" }.count, 1)
        XCTAssertEqual(titles.filter { $0 == "Launch Norma at login" }.count, 1)
        XCTAssertEqual(titles.filter { $0 == "Check for Updates…" }.count, 1)
    }

    // MARK: - Closure firing

    func testOpenCliItemFiresInjectedClosure() {
        var fired = 0
        let controller = makeController(openCli: { fired += 1 })
        controller.install()

        let item = controller.openCliItem
        XCTAssertNotNil(item.target)
        XCTAssertNotNil(item.action)
        NSApp.sendAction(item.action!, to: item.target, from: item)

        XCTAssertEqual(fired, 1)
    }

    func testOpenNormaAppItemFiresInjectedClosure() {
        var fired = 0
        let controller = makeController(openNormaApp: { fired += 1 })
        controller.install()

        let item = controller.openNormaAppItem
        XCTAssertNotNil(item.target)
        XCTAssertNotNil(item.action)
        NSApp.sendAction(item.action!, to: item.target, from: item)

        XCTAssertEqual(fired, 1)
    }

    /// Firing one item must never fire the other.
    func testOpenCliAndOpenNormaAppClosuresAreIndependent() {
        var cliFired = 0
        var appFired = 0
        let controller = makeController(openCli: { cliFired += 1 }, openNormaApp: { appFired += 1 })
        controller.install()

        let cliItem = controller.openCliItem
        NSApp.sendAction(cliItem.action!, to: cliItem.target, from: cliItem)

        XCTAssertEqual(cliFired, 1)
        XCTAssertEqual(appFired, 0)
    }

    // MARK: - Task 4 (2f): panic item mount/unmount

    /// The red panic item must not exist in the menu at all until a lease is active — unlike
    /// `orbItem`'s title-flip, this is a true add/remove (spec §A4: "mounts/unmounts with
    /// active-lease count").
    func testPanicItemNotMountedByDefault() {
        let controller = makeController()
        controller.install()
        let titles = controller.statusItem?.menu?.items.map(\.title) ?? []
        XCTAssertFalse(titles.contains("Stop Norma's Control"), "panic item must not be mounted with zero active leases")
    }

    func testSetPanicVisibleMountsRightBeforeQuitAndUnmountsAgain() {
        let controller = makeController()
        controller.install()

        controller.setPanicVisible(true)
        var items = controller.statusItem?.menu?.items ?? []
        var titles = items.map(\.title)
        guard let panicIdx = titles.firstIndex(of: "Stop Norma's Control"),
              let quitIdx = titles.firstIndex(of: "Quit Norma") else {
            return XCTFail("expected panic item mounted before Quit Norma, got \(titles)")
        }
        XCTAssertEqual(quitIdx, panicIdx + 2, "expected panic item then the pre-existing separator then Quit Norma")
        XCTAssertTrue(items[panicIdx + 1].isSeparatorItem)

        controller.setPanicVisible(false)
        items = controller.statusItem?.menu?.items ?? []
        titles = items.map(\.title)
        XCTAssertFalse(titles.contains("Stop Norma's Control"), "panic item must be fully removed once no leases are active")
    }

    func testSetPanicVisibleIsIdempotent() {
        let controller = makeController()
        controller.install()
        controller.setPanicVisible(true)
        controller.setPanicVisible(true)
        let titles = controller.statusItem?.menu?.items.map(\.title) ?? []
        XCTAssertEqual(titles.filter { $0 == "Stop Norma's Control" }.count, 1, "a repeated setPanicVisible(true) must not duplicate the item")
    }

    func testPanicItemFiresInjectedClosure() {
        var fired = 0
        let controller = makeController(panic: { fired += 1 })
        controller.install()
        controller.setPanicVisible(true)

        let item = controller.panicItem
        XCTAssertNotNil(item.target)
        XCTAssertNotNil(item.action)
        NSApp.sendAction(item.action!, to: item.target, from: item)

        XCTAssertEqual(fired, 1)
    }

    // MARK: - Sparkle T3: "Check for Updates…"

    func testCheckForUpdatesItemFiresInjectedClosure() {
        var fired = 0
        let controller = makeController(onCheckForUpdates: { fired += 1 })
        controller.install()

        let item = controller.checkForUpdatesItem
        XCTAssertNotNil(item.target)
        XCTAssertNotNil(item.action)
        NSApp.sendAction(item.action!, to: item.target, from: item)

        XCTAssertEqual(fired, 1)
    }

    // MARK: - Sparkle T4: staged-update "Restart Now" override

    /// The staged-update line only exists once an update is staged (`setUpdateStaged(true, ...)`),
    /// same mount-not-by-default posture as `panicItem` — so this test mounts it first, then fires
    /// the injected `onInstallUpdate` closure exactly like every other item's firing test above.
    func testUpdateItemFiresInjectedClosure() {
        var fired = 0
        let controller = makeController(onInstallUpdate: { fired += 1 })
        controller.install()
        controller.setUpdateStaged(true, version: "0.2.002")

        let item = controller.updateItem
        XCTAssertNotNil(item.target)
        XCTAssertNotNil(item.action)
        NSApp.sendAction(item.action!, to: item.target, from: item)

        XCTAssertEqual(fired, 1)
    }

    // MARK: - Lifecycle T4: reallyQuit arming order

    /// The ONE true-quit contract: `onReallyQuit()` must fire BEFORE `quitApplication()` — a real
    /// `NSApp.terminate` call synchronously re-enters `applicationShouldTerminate`, so if the order
    /// were reversed the flag would still read `false` there and the menu-bar Quit itself would be
    /// cancelled.
    func testQuitItemFiresOnReallyQuitBeforeQuitApplication() {
        var order: [String] = []
        let controller = makeController(
            quit: { order.append("quit") },
            onReallyQuit: { order.append("reallyQuit") }
        )
        controller.install()

        let item = controller.statusItem?.menu?.items.first { $0.title == "Quit Norma" }
        XCTAssertNotNil(item)
        NSApp.sendAction(item!.action!, to: item!.target, from: item!)

        XCTAssertEqual(order, ["reallyQuit", "quit"])
    }

    // MARK: - Lifecycle T6: ".failed" supervisor state -> "engine stopped — Restart"

    func testSetEngineFailedRepurposesStateItemIntoARestartAction() {
        var restarted = 0
        let controller = makeController(onRestartDaemon: { restarted += 1 })
        controller.install()
        XCTAssertFalse(controller.stateItem.isEnabled, "the state line is inert (not clickable) by default")

        controller.setEngineFailed(true)

        XCTAssertEqual(controller.stateItem.title, "engine stopped — Restart")
        XCTAssertTrue(controller.stateItem.isEnabled)
        XCTAssertNotNil(controller.stateItem.target)
        XCTAssertNotNil(controller.stateItem.action)
        NSApp.sendAction(controller.stateItem.action!, to: controller.stateItem.target, from: controller.stateItem)
        XCTAssertEqual(restarted, 1)
    }

    func testSetEngineFailedFalseRevertsToTheInertStatusLine() {
        let controller = makeController()
        controller.install()
        controller.setEngineFailed(true)

        controller.setEngineFailed(false)

        XCTAssertEqual(controller.stateItem.title, "idle", "reverts to statusLine()'s current value")
        XCTAssertFalse(controller.stateItem.isEnabled)
        XCTAssertNil(controller.stateItem.action)
    }

    /// `refresh()` runs on a periodic Timer in production — it must never stomp the failed-state
    /// title/action back to the plain status line before `setEngineFailed(false)` explicitly
    /// reverts it.
    func testRefreshDoesNotOverwriteTheFailedStateTitle() {
        let controller = makeController()
        controller.install()
        controller.setEngineFailed(true)

        controller.refresh()

        XCTAssertEqual(controller.stateItem.title, "engine stopped — Restart")
        XCTAssertTrue(controller.stateItem.isEnabled)
    }

    func testSetEngineFailedIsIdempotent() {
        var restarted = 0
        let controller = makeController(onRestartDaemon: { restarted += 1 })
        controller.install()
        controller.setEngineFailed(true)
        controller.setEngineFailed(true) // repeated true must not re-wire/duplicate anything

        NSApp.sendAction(controller.stateItem.action!, to: controller.stateItem.target, from: controller.stateItem)

        XCTAssertEqual(restarted, 1)
    }

    // MARK: - Lifecycle T4: "Launch Norma at login" checkbox

    func testLoginItemCheckboxReflectsControllerStateAfterInstall() {
        let fake = FakeLoginItemService()
        let controller = LoginItemController(service: fake, defaults: UserDefaults(suiteName: "MenuBarEntryPointsTests.\(UUID().uuidString)")!)
        let menuBar = makeController(loginItemController: controller)

        menuBar.install()
        XCTAssertEqual(menuBar.loginItemItem.state, .off)

        controller.setEnabled(true)
        menuBar.refresh()
        XCTAssertEqual(menuBar.loginItemItem.state, .on)
    }

    func testLoginItemCheckboxTogglesTheControllerOnClick() {
        let fake = FakeLoginItemService()
        let controller = LoginItemController(service: fake, defaults: UserDefaults(suiteName: "MenuBarEntryPointsTests.\(UUID().uuidString)")!)
        let menuBar = makeController(loginItemController: controller)
        menuBar.install()

        let item = menuBar.loginItemItem
        NSApp.sendAction(item.action!, to: item.target, from: item)
        XCTAssertTrue(fake.isEnabled)
        XCTAssertEqual(item.state, .on)

        NSApp.sendAction(item.action!, to: item.target, from: item)
        XCTAssertFalse(fake.isEnabled)
        XCTAssertEqual(item.state, .off)
    }

    /// Lifecycle T4 review regression: against the REAL `SMLoginItem`, `disable()` fires
    /// `SMAppService.unregister()` fire-and-forget and returns before it lands, so `isEnabled`
    /// (a live `SMAppService.mainApp.status` read) is still `.enabled` the instant the click
    /// handler returns. If the handler read `isEnabled` back synchronously it would immediately
    /// revert an uncheck to CHECKED. `DeferredLoginItemService` models exactly that async/sync
    /// mismatch (enable/disable record the request but DON'T flip `isEnabled` until `settle()`),
    /// so the checkbox must show the REQUESTED state right after the click, before the service
    /// settles — proving the handler is optimistic, not read-back.
    func testLoginItemCheckboxShowsRequestedStateImmediatelyEvenWhenServiceIsAsync() {
        let deferred = DeferredLoginItemService(startEnabled: true)
        let controller = LoginItemController(service: deferred, defaults: UserDefaults(suiteName: "MenuBarEntryPointsTests.\(UUID().uuidString)")!)
        let menuBar = makeController(loginItemController: controller)
        menuBar.install()
        XCTAssertEqual(menuBar.loginItemItem.state, .on, "install()/refresh() reflect the service's starting enabled state")

        let item = menuBar.loginItemItem
        NSApp.sendAction(item.action!, to: item.target, from: item) // request: turn OFF

        // The service HASN'T flipped yet — isEnabled still reads true (the exact real-API instant).
        XCTAssertTrue(deferred.isEnabled, "the async disable() has not landed — service still reads enabled")
        XCTAssertEqual(item.state, .off, "the checkbox must show the REQUESTED (off) state immediately, not the stale read-back")

        // Once the async work settles and a refresh() runs, the read-back reconciles (unchanged here).
        deferred.settle()
        menuBar.refresh()
        XCTAssertEqual(item.state, .off, "refresh() reconciles to the now-settled service state")
    }
}

/// A `LoginItemService` that models the REAL `SMLoginItem`'s async/sync mismatch: `enable()`/
/// `disable()` record the LAST requested state but do NOT flip `isEnabled` until `settle()` — so a
/// synchronous read-back after a click still sees the OLD value, exactly like `SMAppService.mainApp.
/// status` does before a fire-and-forget register/unregister lands.
final class DeferredLoginItemService: LoginItemService {
    private(set) var isEnabled: Bool
    private var pending: Bool

    init(startEnabled: Bool) {
        isEnabled = startEnabled
        pending = startEnabled
    }

    func enable() throws { pending = true }
    func disable() throws { pending = false }

    /// Applies the last requested state — the "async work landed" moment.
    func settle() { isEnabled = pending }
}
