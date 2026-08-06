import AppKit
import SwiftUI

// MARK: - Window geometry (PURE — table-tested in AppShellTests.swift)

/// The shell's default content size. Wider/taller than `dashboardDefaultSize` (800×560): this one
/// window has to hold a nav sidebar, a session list or transcript, and (Task 8) an outputs viewer
/// beside it.
let appWindowDefaultSize = CGSize(width: 1100, height: 720)

/// `appWindowDefaultSize` CENTERED in `visibleFrame`. PURE (no `NSScreen` dependency) so the
/// centering math is unit-tested directly, same posture as `centeredDashboardFrame`/
/// `centeredStandaloneFrame`.
func centeredAppWindowFrame(visibleFrame: CGRect) -> CGRect {
    let size = appWindowDefaultSize
    return CGRect(
        x: visibleFrame.midX - size.width / 2,
        y: visibleFrame.midY - size.height / 2,
        width: size.width,
        height: size.height
    )
}

/// PURE: the frame the shell should occupy when summoned, given where it currently is and the
/// visible frame of the display with keyboard focus (spec §1: "summons to the display with
/// keyboard focus").
///
/// A window that already OVERLAPS that display keeps its exact frame — summoning must never yank a
/// window the user has positioned or resized. Otherwise it re-centers on the focused display at its
/// current size, clamped to fit (a window sized for a large external display must not hang off both
/// edges of a laptop screen after that display goes away).
func summonFrame(current: CGRect, targetVisibleFrame: CGRect) -> CGRect {
    if current.intersects(targetVisibleFrame) { return current }
    let size = CGSize(
        width: min(current.width, targetVisibleFrame.width),
        height: min(current.height, targetVisibleFrame.height)
    )
    return CGRect(
        x: targetVisibleFrame.midX - size.width / 2,
        y: targetVisibleFrame.midY - size.height / 2,
        width: size.width,
        height: size.height
    )
}

/// PURE: hidden-window hygiene (spec §1 — "while hidden: rendering timers suspend, transcripts stop
/// accumulating view work"). Rendering runs ONLY while the window is BOTH ordered in AND at least
/// partially unoccluded; every other combination suspends.
///
/// Split out of `AppWindowController` deliberately (the pure-helper pattern): `NSWindow.
/// occlusionState` can't be driven from a unit test, but the DECISION it feeds can be — the
/// controller's `applyOcclusion(visible:)` seam is the only thing the AppKit callback touches.
func shellRenderingActive(isWindowVisible: Bool, occlusionVisible: Bool) -> Bool {
    isWindowVisible && occlusionVisible
}

// MARK: - The singleton app window

/// Spec §1, the singleton: ONE `AppWindowController` owns the app window for the process lifetime.
/// Every summon path — the dock icon, the menu bar, (later) the orb and the outputs panel —
/// focuses and navigates THIS window; nothing ever spawns a second one (ruling R2; attached
/// sheets/popovers stay legal).
///
/// Two deliberate differences from `DashboardWindowController`, the singleton-focus precedent this
/// otherwise follows:
///
/// 1. **Hide, never close.** `windowShouldClose` orders the window out and answers `false`, so the
///    red traffic light (and `AppDelegate.closeMainWindows()`, the ⌘Q path) leave the controller,
///    its window, and its navigation state intact. `AppDelegate.appWindow` is therefore never
///    nil'd — unlike `dashboardWindow`, which its own `onClosed` clears.
/// 2. **No native full-screen.** `collectionBehavior` is `.fullScreenNone`: a window that can be
///    hidden while full-screen would strand an empty Space. The green button zooms instead.
///
/// The activation-policy machinery is REUSED, not rebuilt: `onVisibilityChange` is what keeps
/// `AppDelegate.hasMainWindow`/`syncDockPresence()` in step with a window that hides itself rather
/// than being closed (a hidden shell is not a main window and must not hold the dock icon).
@MainActor
final class AppWindowController: NSObject, NSWindowDelegate {
    private let window: NSWindow

    /// The shell's navigation state — owned here, handed to the SwiftUI root as an
    /// `@ObservedObject` so `summon(navigatingTo:)` can retarget an already-rendered view (the
    /// `DashboardSelectionModel` lesson).
    let navigation: ShellNavigationModel

    /// app-shell T3: the session host — spec §1's attachment policy in one object. Optional (and
    /// defaulted `nil` in `init`) because it needs an `AppModel` to mint harnesses from, which the
    /// pure window/geometry tests have no business booting; a host-less shell simply renders no
    /// session surface. `AppDelegate.summonAppWindow` is the one production caller that passes one.
    let host: ShellSessionHost?

    /// Task 7: the Dashboard's injected data/closures — `nil` for a shell built without one (same
    /// "pure window tests don't boot an `AppModel`" posture as `host` above); `.dashboard` then
    /// falls back to `ShellLandingView`. `AppDelegate.summonAppWindow` builds the real one, ONCE,
    /// alongside `host`.
    let dashboardWiring: DashboardWiring?

    /// Bugfix pass B4: the chat landing's "New Chat" door — `AppDelegate.newChat()` injected at
    /// construction (the same one-owner discipline `dashboardWiring` follows): the landing's button
    /// must fire the EXACT create-then-summon flow the menu-bar entry does (`newChat()`'s create →
    /// `.session(id)` → the `isChatSession` self-heal), never a `session.create` call site of its
    /// own. `nil` for a shell built without it (the pure window/geometry tests) — the landing then
    /// renders no dead button (`chatLandingShowsNewChatButton`).
    let openNewChat: (() -> Void)?

    /// Task 7: the Dashboard's current-pane memory — UNCONDITIONALLY constructed (unlike
    /// `dashboardWiring`): it has no `AppModel` dependency of its own, and a host-less/wiring-less
    /// shell still benefits from a real object here rather than an extra layer of optionality. See
    /// `DashboardSelectionModel`'s own doc comment (`DashboardSurface.swift`) for the "why a
    /// separate object from `navigation`" reasoning.
    let dashboardSelection = DashboardSelectionModel()

    /// Task 7 (spec §1 windows disposition): the pairing sheet's presentation state — see
    /// `PairingSheetPresentationModel`'s own doc comment (`Remote/PairingSheetView.swift`).
    /// Unconditional for the same reason `dashboardSelection` is: no `AppModel` dependency, cheap to
    /// always have a real (idle) instance.
    let pairingPresentation = PairingSheetPresentationModel()

    /// Hidden-window hygiene: `false` whenever the window is ordered out OR fully occluded. Views
    /// read `navigation.renderingActive` (the published mirror); non-view consumers (Task 2's
    /// `session.list` poll — "hidden = no polling") take `onRenderingActiveChange` below.
    private(set) var isRenderingActive = false

    /// Fires on every CHANGE of the window's on-screen state. `AppDelegate` wires this to
    /// `syncDockPresence()`.
    var onVisibilityChange: ((Bool) -> Void)?

    /// Fires on every CHANGE of `isRenderingActive` — the seam Task 2's poll cadence gates on.
    var onRenderingActiveChange: ((Bool) -> Void)?

    /// Test-only read-through, same convention as `DashboardWindowController.windowForTesting`.
    var windowForTesting: NSWindow? { window }

    var isVisible: Bool { window.isVisible }

    /// Last reading from `windowDidChangeOcclusionState`. Starts `true`: a window that has never
    /// been shown reports `.visible` off, and the FIRST real notification arrives after the first
    /// `orderFront` anyway — seeding `false` would leave a freshly summoned window suspended until
    /// AppKit got around to notifying.
    private var occlusionVisible = true
    private var lastVisible = false

    /// `navigation` is `ShellNavigationModel?` rather than defaulting straight to a fresh one:
    /// `ShellNavigationModel.init` is `@MainActor`-isolated, and a default ARGUMENT VALUE
    /// expression is checked as a nonisolated context regardless of the enclosing initializer's
    /// own isolation — the exact trap `DashboardWindowController.init`'s `session:` parameter
    /// documents. The fallback is constructed in this (`@MainActor`) body instead.
    init(directory: SessionDirectory, host: ShellSessionHost? = nil, dashboardWiring: DashboardWiring? = nil, navigation: ShellNavigationModel? = nil, openNewChat: (() -> Void)? = nil, frame: NSRect) {
        let window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = "Norma"
        window.isReleasedWhenClosed = false // this controller owns the window's lifetime, forever
        window.minSize = NSSize(width: 820, height: 520)
        // Spec §1: opt OUT of native full-screen — a hidden full-screen window strands a Space.
        // `.fullScreenNone` also leaves the green button as a plain zoom, which is the right verb
        // for a window that hides rather than closes.
        window.collectionBehavior = [.fullScreenNone]
        // Same Safari-style unified-toolbar technique `DetachedWindowController`/
        // `DashboardWindowController` use for inset traffic lights (an empty toolbar + `.unified`
        // style). On macOS 26 this is also what lets the `NavigationSplitView` sidebar render as the
        // system's own glass column rather than a flush opaque panel.
        let toolbar = NSToolbar(identifier: "norma.appshell.toolbar")
        toolbar.displayMode = .iconOnly
        window.toolbar = toolbar
        window.toolbarStyle = .unified
        let navigationModel = navigation ?? ShellNavigationModel()
        self.window = window
        self.navigation = navigationModel
        self.host = host
        self.dashboardWiring = dashboardWiring
        self.openNewChat = openNewChat

        super.init()

        window.delegate = self
        // app-shell T3: the destination is the ONE source of truth for what the shell is showing,
        // so the host learns of a session selection from the navigation itself rather than from a
        // parallel call at each navigation site (the sidebar's recents rows, a landing list's row,
        // `summon(navigatingTo:)`, a future deep link — all of them go through `navigate`).
        navigationModel.onDestinationChange = { [weak host] destination in host?.apply(destination: destination) }
        host?.apply(destination: navigationModel.destination)
        // The working-folders chip's panel/confirm attach to THIS window (AppKit belongs to the
        // controller). `[weak self]` — the host is owned above this object, not below it.
        host?.presentingWindow = { [weak self] in self?.window }
        // cli-handoff T3: the true move's navigation seam — a successful handoff of the ATTACHED
        // session navigates to the Code landing through the SAME navigate → onDestinationChange →
        // apply(destination:) loop wired two lines up, which is what actually detaches app-kind
        // (`apply`'s non-session case deselects; `detachCurrent` closes the socket). `[weak
        // navigationModel]` mirrors the `[weak host]` capture above — the controller owns both;
        // neither owns the other.
        host?.navigateForHandoff = { [weak navigationModel] destination in
            navigationModel?.navigate(to: destination)
        }
        window.contentView = NSHostingView(rootView: ShellRootView(
            nav: navigationModel, directory: directory, host: host,
            dashboardWiring: dashboardWiring, newChat: openNewChat,
            dashboardSelection: dashboardSelection,
            pairingPresentation: pairingPresentation
        ))
        window.setFrame(frame, display: true)
    }

    /// The one summon primitive every path funnels through (dock, menu bar, and — later — the orb,
    /// the outputs panel, and every "open in app" affordance).
    ///
    /// `destination == nil` is a PLAIN refocus: it preserves whatever the user was looking at,
    /// exactly like `openDashboard()`'s untargeted branch (whose over-correcting fix — retargeting
    /// unconditionally — is the recorded bug this mirrors the shape of). A non-nil destination
    /// retargets, whether the window is being shown for the first time or already open.
    ///
    /// Task 7: a `.dashboard(pane: let pane)` destination with a NON-nil `pane` ALSO retargets
    /// `dashboardSelection` — the direct descendant of `openDashboard(initialPane:)`'s old "a
    /// targeted open retargets the pane before refocusing" branch (`DashboardWindowController`,
    /// deleted this task). `pane == nil` (a plain "Dashboard…" open) never touches it, preserving
    /// whatever pane `DashboardSurface` is already showing — same "nil never resets" contract that
    /// method's own fix-wave-1 regression test pinned. This runs unconditionally whenever the
    /// payload is non-nil, even if `navigation.navigate` itself was a no-op (the destination was
    /// already exactly this pane) — a redundant re-selection is harmless, and it's what makes a
    /// SECOND "Manage Plugins…" while already on a DIFFERENT pane retarget correctly (the destination
    /// values differ — `.dashboard(pane: .trust) != .dashboard(pane: .pluginManager)` — so
    /// `navigate` proceeds regardless).
    func summon(navigatingTo destination: ShellDestination? = nil) {
        if let destination {
            navigation.navigate(to: destination)
            if case .dashboard(let pane) = destination, let pane {
                dashboardSelection.selection = pane
            }
        }
        // The display with keyboard focus: `NSScreen.main` is documented as "the screen containing
        // the window with keyboard focus", NOT the hardware's primary display.
        if let visible = NSScreen.main?.visibleFrame {
            let target = summonFrame(current: window.frame, targetVisibleFrame: visible)
            if target != window.frame { window.setFrame(target, display: true) }
        }
        occlusionVisible = true
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        syncState()
    }

    /// Orders the window out WITHOUT closing it — the shell's "close". Shared by the red traffic
    /// light (`windowShouldClose` below) and `AppDelegate.closeMainWindows()` (the ⌘Q/dock-quit
    /// cancel path, and the real-quit teardown).
    func hide() {
        window.orderOut(nil)
        syncState()
    }

    /// Spec §1: the window hides on close, never destroyed. Answering `false` is what stops AppKit
    /// from tearing the window down — the ordering-out is ours.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        hide()
        return false
    }

    func windowDidChangeOcclusionState(_ notification: Notification) {
        applyOcclusion(visible: window.occlusionState.contains(.visible))
    }

    /// The occlusion seam (see `shellRenderingActive`'s doc): the AppKit callback above reduces to
    /// one bool, and everything downstream of it is pure and directly testable.
    func applyOcclusion(visible: Bool) {
        occlusionVisible = visible
        syncState()
    }

    /// Recomputes both derived flags and fires their hooks ON CHANGE ONLY — a repeated `hide()` or
    /// a redundant occlusion notification must not re-notify (`AppDelegate.syncDockPresence()` is
    /// idempotent, but a poll cadence gating on `onRenderingActiveChange` would not be).
    private func syncState() {
        let visible = window.isVisible
        if visible != lastVisible {
            lastVisible = visible
            // app-shell T3, spec §1's attachment table: HIDDEN (not merely occluded) is the row that
            // detaches — see `shellAttachmentAction`'s own doc for why the attachment tracks
            // visibility while the poll tracks `isRenderingActive`. Driven here rather than through
            // `onVisibilityChange` so the policy holds regardless of who else wires that hook.
            host?.setShellVisible(visible)
            onVisibilityChange?(visible)
        }
        let active = shellRenderingActive(isWindowVisible: visible, occlusionVisible: occlusionVisible)
        if active != isRenderingActive {
            isRenderingActive = active
            navigation.setRenderingActive(active)
            onRenderingActiveChange?(active)
        }
    }
}
