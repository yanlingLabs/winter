import XCTest
import AppKit
@testable import Norma

/// Task 3 (2e-iv): the menu bar's two new entry points — "Open CLI" (`CliLauncher.openCli`, Task 1)
/// and "Open Norma App" (`AppDelegate.summonAppWindow`, App shell T1 — retargeted from the original
/// `openStandaloneNormaWindow`, since retired by App shell T6). No prior MenuBarController
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
        openNewChat: @escaping () -> Void = {},
        openChat: @escaping () -> Void = {},
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
            openNewChat: openNewChat,
            openChat: openChat,
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

    // MARK: - DD-T7: dist-only CLI installer item

    /// `MenuBarController.install()`'s dist branch (`cliInstallItem`, "Install norma Command") is
    /// compile-time unreachable from this xctest host — it always builds under the Debug config,
    /// so `AppProfile.isDev` is always `true` here and only the dev branch (`openCliItem`) ever
    /// mounts. That dist item is exercised at the live gate instead; here we assert the DEV side
    /// of the same `if AppProfile.isDev { … } else { … }` branch — the norma-dev CLI item is
    /// present, and the dist-only title never leaks into the dev menu.
    func testDevMenuContainsNormaDevCliItemNotDistInstallItem() {
        let controller = makeController()
        controller.install()

        let titles = controller.statusItem?.menu?.items.map(\.title) ?? []

        XCTAssertTrue(titles.contains("Open CLI"), "dev builds must mount the norma-dev CLI item")
        XCTAssertFalse(titles.contains("Install norma Command"), "the dist-only installer item must never appear in a dev build's menu")
    }

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

        // Chat Mode Slice A (CM-T3): "New Chat"/"Chat" sit right after Open Norma App, adjacent
        // to each other and to Dashboard… — same "no separator" posture as every other entry
        // point in this run.
        guard let newChatIdx = titles.firstIndex(of: "New Chat"),
              let chatIdx = titles.firstIndex(of: "Chat") else {
            return XCTFail("expected New Chat and Chat present, got \(titles)")
        }
        XCTAssertEqual(newChatIdx, appIdx + 1, "New Chat must be adjacent to Open Norma App, no separator between them")
        XCTAssertEqual(chatIdx, newChatIdx + 1, "Chat must be adjacent to New Chat, no separator between them")
        XCTAssertEqual(dashboardIdx, chatIdx + 1, "Dashboard… must be adjacent to Chat, no separator between them")
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
        XCTAssertEqual(titles.filter { $0 == "New Chat" }.count, 1)
        XCTAssertEqual(titles.filter { $0 == "Chat" }.count, 1)
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

    // MARK: - Chat Mode Slice A (CM-T3): "New Chat"/"Chat"

    func testNewChatItemFiresInjectedClosure() {
        var fired = 0
        let controller = makeController(openNewChat: { fired += 1 })
        controller.install()

        let item = controller.newChatItem
        XCTAssertNotNil(item.target)
        XCTAssertNotNil(item.action)
        NSApp.sendAction(item.action!, to: item.target, from: item)

        XCTAssertEqual(fired, 1)
    }

    func testChatItemFiresInjectedClosure() {
        var fired = 0
        let controller = makeController(openChat: { fired += 1 })
        controller.install()

        let item = controller.chatItem
        XCTAssertNotNil(item.target)
        XCTAssertNotNil(item.action)
        NSApp.sendAction(item.action!, to: item.target, from: item)

        XCTAssertEqual(fired, 1)
    }

    /// Firing "New Chat" must never fire "Chat" (and vice versa) — same independence guarantee as
    /// `testOpenCliAndOpenNormaAppClosuresAreIndependent`.
    func testNewChatAndChatClosuresAreIndependent() {
        var newChatFired = 0
        var chatFired = 0
        let controller = makeController(
            openNewChat: { newChatFired += 1 },
            openChat: { chatFired += 1 }
        )
        controller.install()

        let chatItem = controller.chatItem
        NSApp.sendAction(chatItem.action!, to: chatItem.target, from: chatItem)

        XCTAssertEqual(chatFired, 1)
        XCTAssertEqual(newChatFired, 0)
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

    // MARK: - DD branch review (I1): single-writer icon (badge vs. activity collision)

    /// The exact DD-T5/Sparkle-T4 collision this review item fixed: a badge set while activity is
    /// non-idle must survive a subsequent frame tick (the real pulse Timer fires every ~80ms).
    /// `applyCurrentFrame()` stands in for that tick — same posture as calling any other internal
    /// seam directly in this file.
    func testUpdateBadgeSurvivesAnActivityFrameTick() {
        let controller = makeController()
        controller.install()
        controller.setActivity(.thinking) // non-idle: the pulse timer would be running for real
        controller.setUpdateBadge(true)
        XCTAssertEqual(controller.currentImageName, "arrow.down.circle.fill")

        controller.applyCurrentFrame() // stand-in for the pulse timer's next tick
        XCTAssertEqual(controller.currentImageName, "arrow.down.circle.fill", "the badge must survive an activity frame tick, not get clobbered back to the activity glyph")
    }

    /// Clearing the badge while idle must restore the idle BRAND asset name — never the retired
    /// `circle.circle` SF Symbol placeholder `setUpdateBadge(false)` used to reset to.
    func testUpdateBadgeClearedWhileIdleRestoresIdleBrandAssetNotTheStub() {
        let controller = makeController()
        controller.install()
        controller.setUpdateBadge(true)
        XCTAssertEqual(controller.currentImageName, "arrow.down.circle.fill")

        controller.setUpdateBadge(false)
        XCTAssertEqual(controller.currentImageName, MenuBarController.imageName(for: .idle, frame: 0, prefix: AppProfile.menuBarAssetPrefix))
        XCTAssertNotEqual(controller.currentImageName, "circle.circle", "must never fall back to the retired SF-symbol stub")
    }

    /// `setUpdateStaged(false, ...)` calls `setUpdateBadge(false)` internally — this end-to-end
    /// path (rather than calling `setUpdateBadge` directly) must produce the same non-stub result.
    func testSetUpdateStagedFalseClearsBadgeToIdleBrandAsset() {
        let controller = makeController()
        controller.install()
        controller.setUpdateStaged(true, version: "0.2.002")
        controller.setUpdateBadge(true)

        controller.setUpdateStaged(false, version: nil)

        XCTAssertEqual(controller.currentImageName, MenuBarController.imageName(for: .idle, frame: 0, prefix: AppProfile.menuBarAssetPrefix))
    }

    // MARK: - DD branch review (m4): cliInstallItem's disabled states actually disable

    /// Both disabled states (already-installed, foreign-refused) must clear `target`/`action` too,
    /// not just flip `isEnabled` — `isEnabled = false` alone does not stop a direct
    /// `NSApp.sendAction`/`target`/`action` invocation from firing (`setEngineFailed`'s own
    /// precedent above hits the same lesson).
    func testCliInstallItemDisabledStatesClearTargetAndAction() {
        let controller = makeController()
        controller.install()

        controller.applyCliInstallState(.alreadyInstalled)
        XCTAssertFalse(controller.cliInstallItem.isEnabled)
        XCTAssertNil(controller.cliInstallItem.target)
        XCTAssertNil(controller.cliInstallItem.action)

        controller.applyCliInstallState(.refuseForeign("/usr/local/bin/norma"))
        XCTAssertFalse(controller.cliInstallItem.isEnabled)
        XCTAssertNil(controller.cliInstallItem.target)
        XCTAssertNil(controller.cliInstallItem.action)
    }

    /// The two enabled states (install, repair) must (re)wire `target`/`action` — proving a
    /// transition FROM a disabled state back to an enabled one actually restores clickability, not
    /// just that a fresh item starts wired.
    func testCliInstallItemEnabledStatesRestoreTargetAndAction() {
        let controller = makeController()
        controller.install()
        controller.applyCliInstallState(.alreadyInstalled) // disable first
        XCTAssertNil(controller.cliInstallItem.target)

        controller.applyCliInstallState(.install)
        XCTAssertTrue(controller.cliInstallItem.isEnabled)
        XCTAssertNotNil(controller.cliInstallItem.target)
        XCTAssertNotNil(controller.cliInstallItem.action)

        controller.applyCliInstallState(.alreadyInstalled)
        controller.applyCliInstallState(.repair)
        XCTAssertTrue(controller.cliInstallItem.isEnabled)
        XCTAssertNotNil(controller.cliInstallItem.target)
        XCTAssertNotNil(controller.cliInstallItem.action)
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

    // MARK: - editor-plumbing Task 5: the editor bridge harness item (Debug only)

    #if DEBUG
    /// **The hook being nil is the mount condition, and that is load-bearing rather than tidy.**
    ///
    /// Every adjacency assertion in this file is written against the shipped menu, and this item
    /// sits inside it — so a Debug build that mounted it unconditionally would move "Pair a
    /// Device…" one place down and fail `testMenuContains…` for a developer-only entry. Nothing
    /// wires the hook here, so an unwired controller's menu is byte-for-byte the shipped one.
    func testTheEditorHarnessItemIsNotMountedUnlessSomethingWiresIt() {
        let controller = makeController()
        controller.install()

        let titles = controller.statusItem?.menu?.items.map(\.title) ?? []
        XCTAssertFalse(titles.contains("Editor Bridge Harness…"),
                       "the harness item must not exist unless onOpenEditorHarness was set")
    }

    /// Wired before `install()` — which is where the menu is built, once — the item appears beside
    /// the other developer-facing windows and fires its hook.
    func testTheEditorHarnessItemMountsAfterManagePluginsAndFiresItsHook() {
        var fired = 0
        let controller = makeController()
        controller.onOpenEditorHarness = { fired += 1 }
        controller.install()

        let titles = controller.statusItem?.menu?.items.map(\.title) ?? []
        guard let pluginsIdx = titles.firstIndex(of: "Manage Plugins…"),
              let harnessIdx = titles.firstIndex(of: "Editor Bridge Harness…") else {
            return XCTFail("expected the harness item mounted after Manage Plugins…, got \(titles)")
        }
        XCTAssertEqual(harnessIdx, pluginsIdx + 1)

        let item = controller.editorHarnessItem
        XCTAssertNotNil(item.target)
        XCTAssertNotNil(item.action)
        NSApp.sendAction(item.action!, to: item.target, from: item)
        XCTAssertEqual(fired, 1)
    }
    #endif
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
