import AppKit

@MainActor
final class MenuBarController {
    private let statusLine: () -> String
    private let toggleOrb: () -> Void
    private let summonField: () -> Void
    private let openCli: () -> Void
    private let openNormaApp: () -> Void
    private let openDashboard: () -> Void
    private let openPluginManager: () -> Void
    // SP2b T5: the two Remote-pairing entry points — same decoupled-closure posture as every
    // other action in this initializer.
    private let openPairDevice: () -> Void
    private let openPairedDevices: () -> Void
    private let panicAction: () -> Void
    private let quitApplication: () -> Void
    // Lifecycle T4: arms the ONE true-quit gate (`AppDelegate.reallyQuitting`) — fired BEFORE
    // `quitApplication()` in `didQuit()` below. An injected closure (not a direct `AppDelegate`
    // reference) so this controller stays decoupled from the app delegate, same posture as every
    // other closure in this initializer.
    private let onReallyQuit: () -> Void
    // Lifecycle T6: fires `DaemonSupervisor.restart()` — wired to `stateItem` only while
    // `engineFailed` is true (see `setEngineFailed`/`didRestartDaemon` below).
    private let onRestartDaemon: () -> Void
    // Sparkle T3: fires the "Check for Updates…" item's manual Sparkle check — same
    // decoupled-closure posture as every other action in this initializer.
    private let onCheckForUpdates: () -> Void
    // Sparkle T4: fires the staged-update "Restart Now" override — same decoupled-closure
    // posture as every other action in this initializer.
    private let onInstallUpdate: () -> Void
    private let loginItemController: LoginItemController
    // Task 3 (2e-iv): internal (not private), same stored-`let` pattern as `stateItem` below, so
    // `MenuBarEntryPointsTests` (`@testable import Norma`) can walk `statusItem`'s built menu for
    // order and fire these items' actions via their `target`/`action` directly.
    var statusItem: NSStatusItem?
    // Lifecycle T6: internal (not private) — `AppLifecycleTests` reads `.title` and fires
    // `.action`/`.target` directly (same testability posture as `openCliItem`/`panicItem` below)
    // to assert the `.failed`-state "engine stopped — Restart" wiring.
    let stateItem = NSMenuItem(title: "starting…", action: nil, keyEquivalent: "")
    // Lifecycle T6: true while the daemon supervisor is `.failed` — `refresh()`'s periodic
    // `statusLine()` update is suppressed while this is true, so it never stomps the "engine
    // stopped — Restart" title/action `setEngineFailed(true)` installs below.
    private var engineFailed = false
    private let orbItem = NSMenuItem(title: "Hide Orb", action: #selector(didToggleOrb), keyEquivalent: "o")
    private let summonFieldItem = NSMenuItem(title: "Summon Field", action: #selector(didSummonField), keyEquivalent: "")
    let openCliItem = NSMenuItem(title: "Open CLI", action: #selector(didOpenCli), keyEquivalent: "")
    let openNormaAppItem = NSMenuItem(title: "Open Norma App", action: #selector(didOpenNormaApp), keyEquivalent: "")
    // Task 5 (2f-ii): the Dashboard entry — same section/adjacency convention as `openCliItem`/
    // `openNormaAppItem` (2e-iv), mirrored exactly.
    let dashboardItem = NSMenuItem(title: "Dashboard…", action: #selector(didOpenDashboard), keyEquivalent: "")
    // Phase 4d-iii Task 2: "Manage Plugins…" — same 4-touch-point precedent as `dashboardItem`,
    // placed right after it (opens the Dashboard window focused on `.pluginManager`).
    let pluginManagerItem = NSMenuItem(title: "Manage Plugins…", action: #selector(didOpenPluginManager), keyEquivalent: "")
    // SP2b T5: "Pair a Device…"/"Paired Devices…" — same adjacency/testability posture as
    // `pluginManagerItem` (4d-iii Task 2's own precedent), placed right after it.
    let pairDeviceItem = NSMenuItem(title: "Pair a Device…", action: #selector(didOpenPairDevice), keyEquivalent: "")
    let pairedDevicesItem = NSMenuItem(title: "Paired Devices…", action: #selector(didOpenPairedDevices), keyEquivalent: "")
    // Task 4 (2f): the red "Stop Norma's Control" panic item — mounted/unmounted (not just
    // shown/hidden, unlike `orbItem`'s title-flip via `setOrbVisible`) with the active-lease count.
    // `internal`, same testability posture as `openCliItem`/`openNormaAppItem` above.
    let panicItem = NSMenuItem(title: "Stop Norma's Control", action: #selector(didPanic), keyEquivalent: "")
    private let preQuitSeparator = NSMenuItem.separator()
    private let quitItem = NSMenuItem(title: "Quit Norma", action: #selector(didQuit), keyEquivalent: "q")
    // Lifecycle T4: the "Launch Norma at login" checkbox, bound to `loginItemController`. `internal`
    // (not `private`), same testability posture as `openCliItem`/`panicItem` above.
    let loginItemItem = NSMenuItem(title: "Launch Norma at login", action: #selector(didToggleLoginItem), keyEquivalent: "")
    // Sparkle T3: manual "Check for Updates…" entry — `internal`, same testability posture as
    // `openCliItem`/`panicItem` above.
    let checkForUpdatesItem = NSMenuItem(title: "Check for Updates…", action: #selector(didCheckForUpdates), keyEquivalent: "")
    // Sparkle T4: the staged-update "Restart Now" line — mounted/unmounted (not just shown/hidden)
    // like `panicItem`, since it must not exist at all while no update is staged. `internal`, same
    // testability posture as `checkForUpdatesItem`/`panicItem` above.
    let updateItem = NSMenuItem(title: "Update ready — Restart Now", action: #selector(didInstallUpdate), keyEquivalent: "")
    private var panicMounted = false

    init(
        statusLine: @escaping () -> String,
        toggleOrb: @escaping () -> Void,
        summonField: @escaping () -> Void,
        openCli: @escaping () -> Void,
        openNormaApp: @escaping () -> Void,
        openDashboard: @escaping () -> Void,
        openPluginManager: @escaping () -> Void,
        openPairDevice: @escaping () -> Void,
        openPairedDevices: @escaping () -> Void,
        loginItemController: LoginItemController,
        panic: @escaping () -> Void,
        quit: @escaping () -> Void,
        onReallyQuit: @escaping () -> Void,
        onRestartDaemon: @escaping () -> Void,
        onCheckForUpdates: @escaping () -> Void,
        onInstallUpdate: @escaping () -> Void
    ) {
        self.statusLine = statusLine
        self.toggleOrb = toggleOrb
        self.summonField = summonField
        self.openCli = openCli
        self.openNormaApp = openNormaApp
        self.openDashboard = openDashboard
        self.openPluginManager = openPluginManager
        self.openPairDevice = openPairDevice
        self.openPairedDevices = openPairedDevices
        self.loginItemController = loginItemController
        self.panicAction = panic
        self.quitApplication = quit
        self.onReallyQuit = onReallyQuit
        self.onRestartDaemon = onRestartDaemon
        self.onCheckForUpdates = onCheckForUpdates
        self.onInstallUpdate = onInstallUpdate
    }

    func install() {
        guard statusItem == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "circle.circle", accessibilityDescription: "Norma")

        let menu = NSMenu()
        stateItem.isEnabled = false
        menu.addItem(stateItem)
        menu.addItem(.separator())
        orbItem.target = self
        menu.addItem(orbItem)
        summonFieldItem.target = self
        menu.addItem(summonFieldItem)
        menu.addItem(.separator())
        openCliItem.target = self
        menu.addItem(openCliItem)
        openNormaAppItem.target = self
        menu.addItem(openNormaAppItem)
        dashboardItem.target = self
        menu.addItem(dashboardItem)
        pluginManagerItem.target = self
        menu.addItem(pluginManagerItem)
        pairDeviceItem.target = self
        menu.addItem(pairDeviceItem)
        pairedDevicesItem.target = self
        menu.addItem(pairedDevicesItem)
        loginItemItem.target = self
        menu.addItem(loginItemItem)
        checkForUpdatesItem.target = self
        menu.addItem(checkForUpdatesItem)
        menu.addItem(preQuitSeparator)
        quitItem.target = self
        menu.addItem(quitItem)

        item.menu = menu
        statusItem = item
        panicItem.target = self
        panicItem.attributedTitle = NSAttributedString(
            string: panicItem.title, attributes: [.foregroundColor: NSColor.systemRed]
        )
        refresh()
    }

    func refresh() {
        // Lifecycle T6: never overwrite the "engine stopped — Restart" title/action while failed —
        // this runs on a 2s Timer (`AppDelegate.boot()`), which would otherwise stomp it right back
        // to the plain status line on the very next tick.
        if !engineFailed {
            stateItem.title = statusLine()
        }
        // Lifecycle T4: the checkbox tracks `SMAppService.mainApp`'s live status (e.g. the user
        // can flip it from System Settings > Login Items directly, outside this menu entirely),
        // so it's re-synced on the SAME periodic cadence as the state line above rather than only
        // right after a click.
        loginItemItem.state = loginItemController.isEnabled ? .on : .off
    }

    /// Lifecycle T6: the daemon supervisor tripped `.failed` (rapid-respawn cap) or recovered —
    /// repurposes the (normally inert, `isEnabled = false`) state line into an actionable "engine
    /// stopped — Restart" item wired to `DaemonSupervisor.restart()` via the injected
    /// `onRestartDaemon` closure — same dependency-inversion posture as every other action in this
    /// file. Idempotent.
    func setEngineFailed(_ failed: Bool) {
        guard failed != engineFailed else { return }
        engineFailed = failed
        if failed {
            stateItem.title = "engine stopped — Restart"
            stateItem.isEnabled = true
            stateItem.target = self
            stateItem.action = #selector(didRestartDaemon)
        } else {
            stateItem.isEnabled = false
            stateItem.target = nil
            stateItem.action = nil
            stateItem.title = statusLine()
        }
    }

    func setOrbVisible(_ visible: Bool) {
        orbItem.title = visible ? "Hide Orb" : "Show Orb"
    }

    /// Task 4 (2f): mounts (inserts, right above the pre-Quit separator) or unmounts (removes) the
    /// red panic item as the active-lease count crosses zero — a true add/remove, unlike
    /// `setOrbVisible`'s title-flip, since the item must not exist at all while nothing is leased.
    /// Idempotent (`panicMounted` guard) and safe to call before `install()` (no-op — nothing to
    /// mount into yet; `install()` doesn't re-derive panic visibility, so a caller that flips this
    /// before `install()` and expects it mounted would need to call `setPanicVisible` again after —
    /// not a scenario any current caller hits, since `activeLeases` starts empty at boot).
    func setPanicVisible(_ visible: Bool) {
        guard visible != panicMounted else { return }
        guard let menu = statusItem?.menu else { panicMounted = visible; return }
        if visible {
            let idx = menu.index(of: preQuitSeparator)
            if idx >= 0 { menu.insertItem(panicItem, at: idx) }
        } else {
            menu.removeItem(panicItem)
        }
        panicMounted = visible
    }

    /// Sparkle T4: Show/hide the staged-update line (inserted above the pre-quit separator).
    func setUpdateStaged(_ staged: Bool, version: String?) {
        guard let menu = statusItem?.menu else { return }
        let present = menu.items.contains(updateItem)
        if staged && !present {
            updateItem.title = "Update ready (\(version ?? "new version")) — Restart Now"
            updateItem.target = self
            menu.insertItem(updateItem, at: menu.index(of: preQuitSeparator))
        } else if !staged && present {
            menu.removeItem(updateItem)
            setUpdateBadge(false)
        }
    }

    /// Sparkle T4: >24h staged: swap the status icon to a badged variant. No dialog, ever.
    func setUpdateBadge(_ badged: Bool) {
        statusItem?.button?.image = NSImage(
            systemSymbolName: badged ? "arrow.down.circle.fill" : "circle.circle",
            accessibilityDescription: "Norma")
    }

    @objc private func didToggleOrb() { toggleOrb() }
    @objc private func didSummonField() { summonField() }
    @objc private func didOpenCli() { openCli() }
    @objc private func didOpenNormaApp() { openNormaApp() }
    @objc private func didOpenDashboard() { openDashboard() }
    @objc private func didOpenPluginManager() { openPluginManager() }
    @objc private func didOpenPairDevice() { openPairDevice() }
    @objc private func didOpenPairedDevices() { openPairedDevices() }
    @objc private func didPanic() { panicAction() }
    @objc private func didRestartDaemon() { onRestartDaemon() }
    @objc private func didCheckForUpdates() { onCheckForUpdates() }
    @objc private func didInstallUpdate() { onInstallUpdate() }

    // Lifecycle T4: `reallyQuitting` MUST be armed before `quitApplication()` runs — reversed
    // order would let `NSApp.terminate`'s synchronous `applicationShouldTerminate` round-trip read
    // the still-false flag and cancel the menu-bar Quit itself (the ONE true-quit source, per
    // `AppDelegate.reallyQuitting`'s doc comment).
    @objc private func didQuit() {
        onReallyQuit()
        quitApplication()
    }

    // Lifecycle T4 review: the checkbox is set OPTIMISTICALLY to the requested state, NOT by
    // reading `isEnabled` back after `setEnabled`. `SMLoginItem.disable()` fires the real
    // `SMAppService.unregister()` on a fire-and-forget Task and returns before it lands, while
    // `isEnabled` reads the live `SMAppService.mainApp.status` — still `.enabled` at that instant,
    // so a read-back would immediately revert an uncheck to CHECKED. `refresh()`'s own `isEnabled`
    // read is the eventual source of truth and reconciles once the async register/unregister
    // settles (and corrects the checkbox if it genuinely failed).
    @objc private func didToggleLoginItem() {
        let desired = !loginItemController.isEnabled
        loginItemController.setEnabled(desired)
        loginItemItem.state = desired ? .on : .off
    }
}
