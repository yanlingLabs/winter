import AppKit

@MainActor
final class MenuBarController {
    private let statusLine: () -> String
    private let toggleOrb: () -> Void
    private let summonField: () -> Void
    private let openCli: () -> Void
    private let openNormaApp: () -> Void
    // Chat Mode Slice A (CM-T3): the "New Chat"/"Chat" entries — same decoupled-closure posture as
    // every other action in this initializer.
    private let openNewChat: () -> Void
    private let openChat: () -> Void
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
    // DD-T7: the dist-only CLI installer item, mounted instead of `openCliItem` when
    // `!AppProfile.isDev`. Title/enabled state is state-driven (`refreshCliInstallItem()`), not
    // fixed at construction like the other items above — `install()` mounts it, and its own action
    // handler re-derives the title after `CliInstaller.install()` runs.
    let cliInstallItem = NSMenuItem(title: "Install norma Command", action: #selector(didInstallCli), keyEquivalent: "")
    let openNormaAppItem = NSMenuItem(title: "Open Norma App", action: #selector(didOpenNormaApp), keyEquivalent: "")
    // Chat Mode Slice A (CM-T3): "New Chat"/"Chat" — same adjacency/testability posture as
    // `openNormaAppItem` (2e-iv precedent), placed right after it.
    let newChatItem = NSMenuItem(title: "New Chat", action: #selector(didNewChat), keyEquivalent: "")
    let chatItem = NSMenuItem(title: "Chat", action: #selector(didChat), keyEquivalent: "")
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

    #if DEBUG
    /// editor-plumbing Task 5 — the editor bridge harness's door for a human.
    ///
    /// **A settable hook rather than another `init` parameter, and only in Debug.** Every other
    /// action here is injected at construction because it is part of the shipped menu's contract;
    /// this one exists only in developer builds and must not widen an initialiser that ten call
    /// sites and several test files name. Nil-by-default is also the mount condition — the item does
    /// not exist unless something set this — so a Debug build that never wires it looks exactly like
    /// a release one.
    ///
    /// **Set it before `install()`**: the menu is built once, there.
    ///
    /// Norma has no debug MENU — the menu bar's status-item menu is the app's only menu (it is
    /// `LSUIElement`, so there is no main menu bar to hang one from), which is why this lands beside
    /// "Dashboard…" rather than under a "Debug" submenu the app does not have.
    var onOpenEditorHarness: (() -> Void)?
    let editorHarnessItem = NSMenuItem(title: "Editor Bridge Harness…",
                                       action: #selector(didOpenEditorHarness), keyEquivalent: "")
    #endif

    // MARK: - Task DD-T5: live activity icon (idle/thinking/working, rotating pulse frames)

    private var activity: MenuBarActivity = .idle
    private var frame = 0
    private var pulseTimer: Timer?
    // DD branch review (I1): the single-writer flag for the Sparkle staged-update badge. Every
    // icon writer now routes through `applyCurrentFrame()` below — `setUpdateBadge(_:)` no longer
    // touches `statusItem?.button?.image` directly, so the activity pulse timer (every ~80ms while
    // non-idle) can never clobber a staged badge back to the plain activity icon, and clearing the
    // badge composes with whatever activity/idle state is current instead of resetting to a fixed
    // placeholder.
    private var updateBadged = false

    /// Pure + testable: the asset name for a given activity/frame/profile-prefix. `frame` wraps
    /// mod 12 (Task 3's 12-frame `mb-thinking-0..11`/`mb-working-0..11` sets); `.idle` ignores
    /// `frame` entirely (one static asset, no pulse).
    nonisolated static func imageName(for activity: MenuBarActivity, frame: Int, prefix: String) -> String {
        switch activity {
        case .idle: return "\(prefix)-idle"
        case .thinking: return "\(prefix)-thinking-\(frame % 12)"
        case .working: return "\(prefix)-working-\(frame % 12)"
        }
    }

    /// menubar-anim: per-state pulse cadence — pure + testable, same posture as `imageName` above.
    /// `.idle` is `nil` (Global Constraint: idle runs zero timers). `.thinking`'s whole-mark
    /// breathing reads best slower (12 frames * 0.15s ≈ 1.8s per full breath); `.working`'s
    /// rotating comet-tail is meant to read "busier", so it runs faster (12 frames * 0.10s ≈ 1.2s
    /// per revolution) — see scripts/render-icons.ts's `thinkingOpacities`/`workingOpacities` doc
    /// comments for the frame math these cadences are paired with.
    nonisolated static func pulseInterval(for activity: MenuBarActivity) -> TimeInterval? {
        switch activity {
        case .idle: return nil
        case .thinking: return 0.15
        case .working: return 0.10
        }
    }

    /// Loads a Task 3 menu-bar asset by name. RUNTIME-VERIFIED bundle layout (DD-T5): the built
    /// product's `Contents/Resources` has NEITHER a `MenuBar/` subdirectory (the `Resources` source
    /// in `project.yml` is a plain xcodegen GROUP, not a folder reference, so Xcode's Copy Bundle
    /// Resources phase flattens every file straight into `Resources/`) NOR a bare `.png` per name —
    /// `COMBINE_HIDPI_IMAGES` (macOS default) merges each `name.png`/`name@2x.png` pair into a
    /// single multi-representation `name.tiff` at build time. Confirmed by inspecting both Debug
    /// and Release `Norma.app/Contents/Resources` under DerivedData: e.g. `mb-idle.tiff`,
    /// `mb-dev-working-3.tiff`, no `MenuBar/` directory anywhere. `Bundle.image(forResource:)` is
    /// exactly AppKit's documented answer to this (`NSImage.h`: "Neither [pathForImageResource:/
    /// URLForImageResource:] can return images with multiple representations in different files...
    /// The above [imageForResource:] method is generally preferred") — a single lookup, no
    /// extension, that resolves the combined TIFF and picks the right representation for the
    /// screen's backing scale.
    private func templateImage(named name: String) -> NSImage? {
        guard let image = Bundle.main.image(forResource: name) else { return nil }
        image.isTemplate = true
        return image
    }

    /// Test seam (DD branch review, I1): pure, mirrors `imageName(for:frame:prefix:)`'s existing
    /// testable posture — the resource/symbol NAME `applyCurrentFrame()` will render right now,
    /// derived from instance state only, no Bundle/AppKit lookup involved. `internal` (not
    /// `private`), same testability posture as `statusItem`/`stateItem` above.
    var currentImageName: String {
        updateBadged ? "arrow.down.circle.fill" : Self.imageName(for: activity, frame: frame, prefix: AppProfile.menuBarAssetPrefix)
    }

    /// Applies the current icon state as the status item's image — the SOLE writer of
    /// `statusItem?.button?.image` (DD branch review, I1). When a Sparkle staged-update badge is
    /// active it wins outright (no attempt to compose it with the activity glyph); otherwise this
    /// renders the same activity/idle template image as before. Every state change that used to
    /// write the image directly (`setActivity`, `setUpdateBadge`) now calls this instead, so the
    /// 80ms activity pulse timer can never clobber a staged badge, and clearing the badge restores
    /// whatever activity/idle asset is actually current rather than a fixed placeholder. `internal`
    /// (not `private`) so `MenuBarEntryPointsTests` can invoke it directly as a stand-in for the
    /// real pulse Timer's next tick, without waiting on a live Timer.
    func applyCurrentFrame() {
        guard !updateBadged else {
            statusItem?.button?.image = NSImage(
                systemSymbolName: currentImageName,
                accessibilityDescription: "Norma — update ready")
            return
        }
        statusItem?.button?.image = templateImage(named: currentImageName)
    }

    /// Menu-bar status feed sink (Task DD-T5): wired to `AppModel.onActivityChange` at the
    /// AppDelegate join point. Resets to frame 0 on every activity change (a fresh transition
    /// restarts the pulse rather than continuing mid-cycle); the timer only runs while non-idle
    /// (Global Constraint: idle = zero timers, zero CPU) and is torn down/rebuilt on every call so
    /// a `.thinking` -> `.working` transition (no idle in between) doesn't leave two timers running.
    /// menubar-anim: the cadence is now PER-STATE (`pulseInterval(for:)` above) instead of a single
    /// fixed 0.08s for every activity — thinking's whole-mark breathing runs slower than working's
    /// rotating comet-tail (see that function's doc comment for the exact numbers/rationale).
    func setActivity(_ new: MenuBarActivity) {
        activity = new
        frame = 0
        pulseTimer?.invalidate()
        pulseTimer = nil
        applyCurrentFrame()
        guard let interval = Self.pulseInterval(for: new) else { return }
        pulseTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.frame += 1
                self.applyCurrentFrame()
            }
        }
    }

    init(
        statusLine: @escaping () -> String,
        toggleOrb: @escaping () -> Void,
        summonField: @escaping () -> Void,
        openCli: @escaping () -> Void,
        openNormaApp: @escaping () -> Void,
        openNewChat: @escaping () -> Void,
        openChat: @escaping () -> Void,
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
        self.openNewChat = openNewChat
        self.openChat = openChat
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

        let menu = NSMenu()
        stateItem.isEnabled = false
        menu.addItem(stateItem)
        menu.addItem(.separator())
        orbItem.target = self
        menu.addItem(orbItem)
        summonFieldItem.target = self
        menu.addItem(summonFieldItem)
        menu.addItem(.separator())
        // DD-T6: the dev-only `norma-dev` wrapper installer/launcher — dist builds never mount
        // this item, so `CliLauncher.openCli()`/`ensureWrapper()` can never fire there. Dist's
        // own CLI story (a packaged `norma` symlink, no wrapper install) is Task 7.
        if AppProfile.isDev {
            openCliItem.target = self
            menu.addItem(openCliItem)
        } else {
            // DD-T7: dist's counterpart at the exact same menu slot.
            cliInstallItem.target = self
            menu.addItem(cliInstallItem)
            refreshCliInstallItem()
        }
        openNormaAppItem.target = self
        menu.addItem(openNormaAppItem)
        newChatItem.target = self
        menu.addItem(newChatItem)
        chatItem.target = self
        menu.addItem(chatItem)
        dashboardItem.target = self
        menu.addItem(dashboardItem)
        pluginManagerItem.target = self
        menu.addItem(pluginManagerItem)
        #if DEBUG
        // Mounted only when something wired the hook — see `onOpenEditorHarness`.
        if onOpenEditorHarness != nil {
            editorHarnessItem.target = self
            menu.addItem(editorHarnessItem)
        }
        #endif
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
        // Task DD-T5: initial image — the idle template asset, replacing the old SF Symbol
        // placeholder that used to sit here (`NSImage(systemSymbolName: "circle.circle", ...)`).
        applyCurrentFrame()
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

    /// DD-T7: titles/enables `cliInstallItem` from `CliInstaller.currentPlan()` — a read-only
    /// probe, so calling this never installs or repairs anything by itself. Called once when the
    /// item is first mounted (dist builds only) and again right after `didInstallCli()` fires, so
    /// the title always reflects the freshest on-disk state.
    private func refreshCliInstallItem() {
        applyCliInstallState(CliInstaller.currentPlan())
    }

    /// DD branch review (m4): `isEnabled = false` alone does not stop a menu item's action from
    /// firing via `NSApp.sendAction`/a direct `target`/`action` invocation — same lesson as
    /// `setEngineFailed`'s enabled/disabled halves above — so the two disabled states also clear
    /// `target`/`action`, and the two enabled states restore them (idempotent: `install()` already
    /// sets `target = self` once before this first runs).
    ///
    /// Factored out of `refreshCliInstallItem()` (which feeds it the real, environment-dependent
    /// `CliInstaller.currentPlan()`) so `MenuBarEntryPointsTests` can drive every `CliInstallAction`
    /// case directly and deterministically, without depending on whatever `/usr/local/bin/norma`
    /// happens to be on the test host, and without needing the dist-only mounting branch in
    /// `install()` (compile-time unreachable from this Debug-config xctest host) to have run.
    /// `internal` (not `private`), same testability posture as `applyCurrentFrame()` above.
    func applyCliInstallState(_ action: CliInstallAction) {
        switch action {
        case .install:
            cliInstallItem.title = "Install norma Command"
            cliInstallItem.isEnabled = true
            cliInstallItem.target = self
            cliInstallItem.action = #selector(didInstallCli)
        case .repair:
            cliInstallItem.title = "Repair norma Command"
            cliInstallItem.isEnabled = true
            cliInstallItem.target = self
            cliInstallItem.action = #selector(didInstallCli)
        case .alreadyInstalled:
            cliInstallItem.title = "norma Command Installed ✓"
            cliInstallItem.isEnabled = false
            cliInstallItem.target = nil
            cliInstallItem.action = nil
        case .refuseForeign:
            cliInstallItem.title = "norma Command: foreign file — see logs"
            cliInstallItem.isEnabled = false
            cliInstallItem.target = nil
            cliInstallItem.action = nil
        }
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
    ///
    /// DD branch review (I1), fixed: `setUpdateBadge(_:)` below no longer writes the status image
    /// directly — it flips `updateBadged` and routes through `applyCurrentFrame()`, the single
    /// writer every icon change now shares with DD-T5's activity pulse. No more collision between
    /// the two.
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

    /// Sparkle T4: >24h staged: badge the status icon. No dialog, ever. Routes through
    /// `applyCurrentFrame()` (DD branch review, I1) rather than writing the image itself, so the
    /// badge survives the activity pulse timer and clearing it (`badged == false`) correctly
    /// restores the current activity/idle asset instead of a fixed placeholder.
    func setUpdateBadge(_ badged: Bool) {
        updateBadged = badged
        applyCurrentFrame()
    }

    @objc private func didToggleOrb() { toggleOrb() }
    @objc private func didSummonField() { summonField() }
    @objc private func didOpenCli() { openCli() }
    // DD-T7: dist's counterpart to `didOpenCli()` — installs/repairs the `norma` symlink, then
    // re-titles the item from the fresh post-install state (no full menu teardown/rebuild needed,
    // same "re-derive and reassign" posture as `refresh()`'s `loginItemItem.state` sync).
    @objc private func didInstallCli() {
        CliInstaller.install()
        refreshCliInstallItem()
    }
    @objc private func didOpenNormaApp() { openNormaApp() }
    @objc private func didNewChat() { openNewChat() }
    @objc private func didChat() { openChat() }
    #if DEBUG
    @objc private func didOpenEditorHarness() { onOpenEditorHarness?() }
    #endif
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
