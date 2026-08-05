import AppKit
import ApplicationServices
import Combine
import NormaKit
import Sparkle

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private(set) var menuBar: MenuBarController?
    private(set) var appModel: AppModel?
    private(set) var orbController: OrbWindowController?
    /// Task 4 (2f): owns the peripheral capability provider, constructed against `appModel.client`
    /// — the app's MAIN feed client/socket (the daemon rule: THE provider = the most-recent-
    /// advertiser CONNECTION, so this must never be a second/detached-window client).
    private(set) var peripheralProvider: PeripheralProvider?
    /// Task 4 (4c): owns the `com.norma.helper` SMAppService lifecycle + XPC connection — read by
    /// both `hardwareBridge` (the approval gate) and the Dashboard's Peripheral pane (the
    /// helper-status row). Constructed unconditionally in `boot()` (its `status` read is safe
    /// anytime); only the real `register()` call is gated behind `!isRunningUnitTests` below.
    private(set) var helperClient: HelperClient?
    /// Task 4 (4c): answers `hardware_requested` pushes (battery charge-limit verbs) by routing
    /// through `helperClient`'s XPC calls — composed into the SAME `onPeripheralEvent` hook
    /// `peripheralProvider` uses, alongside it, never replacing it.
    private(set) var hardwareBridge: HardwareBridge?
    /// Lifecycle T4: owns the "Launch Norma at login" `SMAppService.mainApp` registration — read
    /// by the menu-bar checkbox (`MenuBarController.loginItemItem`). Constructed unconditionally in
    /// `boot()` (`isEnabled`/`hasUserMadeChoice` are plain reads, safe anytime); the default-on
    /// first-launch `setEnabled(true)` call is gated behind `!isRunningUnitTests` below, same
    /// posture as `helper.register()`.
    private(set) var loginItemController: LoginItemController?
    /// Lifecycle T6: owns the bundled `norma-core` daemon's supervised lifecycle — constructed in
    /// `boot()` (production deps `.live` unless `daemonSupervisorDeps` below overrides them) and
    /// stopped in `applicationWillTerminate`.
    private(set) var daemonSupervisor: DaemonSupervisor?
    /// Sparkle T3: owns the silent `SPUStandardUpdaterController` — constructed in `boot()`,
    /// gated `!isRunningUnitTests` (same posture as `daemonSupervisor`'s real spawn path), so no
    /// updater ever starts from the xctest host.
    private(set) var updaterController: SPUStandardUpdaterController?
    /// Sparkle T3: the `SPUUpdaterDelegate` this controller drives — Norma-specific gating (idle
    /// gate in T4, channels in T5) lives on this seam, not in the controller itself.
    private(set) var updaterCoordinator: UpdaterCoordinator?
    /// Sparkle T3 test seam: overrides the `UpdaterCoordinatorDeps` `boot()` constructs the
    /// coordinator with — set BEFORE calling `boot()`. `nil` (production) resolves to `.live`
    /// (mirrors `daemonSupervisorDeps` above).
    var updaterDepsOverride: UpdaterCoordinatorDeps?
    /// Lifecycle T6 test seam: overrides the `DaemonSupervisorDeps` `boot()` constructs the
    /// supervisor with — set BEFORE calling `boot()`. `nil` (production) resolves to `.live`, or to
    /// `.neverSupervise` under `isRunningUnitTests` (see `boot()`); a test injects a
    /// `FakeDaemonProcess`-backed spawn instead so nothing real is ever launched from the xctest
    /// host.
    var daemonSupervisorDeps: DaemonSupervisorDeps?
    /// Lifecycle T6 test seam: overrides `boot()`'s call to `migrateFromLaunchdAgent()` — set
    /// BEFORE calling `boot()`. `nil` (production) runs the REAL migration, gated `!isRunningUnitTests`
    /// (same posture as `helper.register()`/`loginItem.setEnabled(true)` below) so the real
    /// launchctl bootout/plist-remove never runs from a test process; a test overrides this with an
    /// ordering/call-count spy instead — see `AppLifecycleTests.testMigrationRunsBeforeSupervisorSocketProbe`.
    var launchdMigrationOverride: (() -> Void)?
    /// Task 5 (2f-ii): the Dashboard's singleton window controller — `nil` until first opened,
    /// nil'd again via `onClosed` (same one-shot-latch/registry-removal convention as
    /// `registerDetachedWindow`'s `onClosed`). `openDashboard()` below is what enforces the
    /// "second invocation focuses the existing window" contract off this single stored ref.
    private(set) var dashboardWindow: DashboardWindowController?
    /// App shell T1: the ONE app window, for the process lifetime (spec §1 / ruling R2). `nil`
    /// until the first summon, and — UNLIKE `dashboardWindow` above — never nil'd again: the shell
    /// hides on close rather than being destroyed, so this ref outlives every close.
    /// `summonAppWindow(navigatingTo:)` below is the single door.
    private(set) var appWindow: AppWindowController?
    /// SP2b T5: owns this Mac's `RemoteHost` (lazily constructed — nothing starts until either a
    /// pairing window is requested or, autostart follow-up below, this Mac already has ≥1 paired
    /// device). Constructed unconditionally in `boot()` (cheap — it does no I/O of its own; only
    /// touching its `RemoteHost` does), same posture as `peripheralProvider`/`helperClient`.
    private(set) var remoteAccessCoordinator: RemoteAccessCoordinator?
    /// The pairing sheet's singleton window controller — same one-shot-latch/registry-removal
    /// convention as `dashboardWindow`: nil until first opened, nil'd again via `onClosed`.
    private(set) var pairingSheetWindow: PairingSheetWindowController?
    /// The Paired Devices window's singleton controller — same convention as `pairingSheetWindow`.
    private(set) var pairedDevicesWindow: PairedDevicesWindowController?
    /// BYOK T2: the one-time first-run disclosure window (spec §3) — `nil` until (at most once,
    /// ever, per install) `boot()`'s real-launch path presents it; nil'd again via `onClosed` (same
    /// one-shot-latch/registry-removal convention as `dashboardWindow`/`detachedWindows` above).
    private(set) var firstRunDisclosureWindow: FirstRunDisclosureWindowController?
    /// Phase 4d-iii Task 1: the plugin-shortcut multi-hotkey registry — additive to
    /// `HotkeyTrigger.shared` (Hyper+Space summon) and `peripheralProvider`'s panic hotkey, never
    /// touching either. `nil` under unit tests (constructed only inside `boot()`'s
    /// `!isRunningUnitTests` gate below, same posture as `HotkeyTrigger.shared.start()`).
    /// `private(set)` so the Task 4 shortcut-editor UI can call `.reload(_:)` on it after the user
    /// edits a binding, without this file growing an editor-specific API.
    private(set) var shortcutRegistry: ShortcutRegistry?
    private var stickiness: StickinessEngine?
    private var startTask: Task<Void, Never>?
    private var cancellables = Set<AnyCancellable>()
    /// Task 3 (2e-iv): owns the CLI launcher the menu bar's "Open CLI" item drives.
    private let cliLauncher = CliLauncher()

    /// Task 3 (2d-ii-b) registry: every currently-open detached window. Task 4's detach
    /// choreography appends via `registerDetachedWindow` on spawn; `onClosed` (wired there) removes
    /// it again on either a programmatic `close()` or the user's own red traffic light — the list
    /// never accumulates closed controllers.
    private(set) var detachedWindows: [DetachedWindowController] = []

    /// Lifecycle T3: set to `true` ONLY by the menu-bar "Quit Norma" action (T4 wires that call
    /// site) — the SOLE true-quit source. ⌘Q and the dock-tile "Quit" both route through
    /// `applicationShouldTerminate` below, but neither ever sets this: they're intercepted and
    /// treated as "close the main windows, demote to `.accessory`, keep the menu bar + daemon
    /// running" instead — the product's ChatGPT/Claude-desktop-style lifecycle contract.
    var reallyQuitting = false

    /// Sparkle whole-branch review (Critical): the updater's DEDICATED true-quit axis — set by
    /// `UpdaterCoordinator.onWillInstall` (wired in `boot()`) immediately before Sparkle's install
    /// handler runs. Sparkle terminates the host via a CANCELLABLE Apple quit event with no
    /// kAEQuitReason (so `systemQuitReasonProvider` reads false too) — without this axis the
    /// terminate gate below would answer `.terminateCancel` like a ⌘Q and silently defeat the
    /// entire install+relaunch on BOTH paths (idle poll and Restart Now). A dedicated flag rather
    /// than reusing `reallyQuitting`: if the quit somehow failed, a stale `reallyQuitting = true`
    /// would corrupt later ⌘Q semantics (the ONE-true-quit-source contract above).
    private var updaterQuitting = false

    /// Lifecycle T3 review fix: seam for the Apple-Event quit-reason read
    /// (`isSystemInitiatedQuitEvent()` below the class) — injectable so a unit test can drive the
    /// systemInitiated axis of `applicationShouldTerminate` without synthesizing a real
    /// logout/shutdown Apple Event against the xctest host. The real read touches AppKit global
    /// state (`NSAppleEventManager`), which is exactly why it stays OUT of the pure
    /// `terminateDecision` and enters only as a bool computed at the delegate boundary.
    var systemQuitReasonProvider: () -> Bool = isSystemInitiatedQuitEvent

    /// Promotes the app to `.regular` — the dock icon appears. `NSApp.activate` right after the
    /// policy flip works around a known macOS quirk: flipping activation policy alone doesn't
    /// reliably bring the newly-promoted app's window forward.
    func showDockIcon() {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Demotes back to `.accessory` — `applicationDidFinishLaunching`'s launch-time base state
    /// below. The dock icon disappears; the menu bar and daemon are untouched.
    func hideDockIcon() {
        NSApp.setActivationPolicy(.accessory)
    }

    /// True while at least one dock-promoting window is open. Deliberately excludes the orb
    /// (`OrbWindowController`'s `KeyableNonActivatingPanel` — a borderless, non-activating
    /// `NSPanel`, an accessory surface even while morphed into its own `.window` surface) and the
    /// menu bar: neither is a "real user-facing window" per the product spec, so neither may
    /// promote the dock icon.
    /// App shell T1: the shell counts by VISIBILITY, not by existence — its controller is never
    /// deallocated (it hides on close), so `appWindow != nil` would pin the dock icon on forever
    /// after the first summon. `AppWindowController.onVisibilityChange` (wired in
    /// `summonAppWindow`) is what re-runs `syncDockPresence()` when the window hides itself.
    private var hasMainWindow: Bool {
        !detachedWindows.isEmpty || dashboardWindow != nil || appWindow?.isVisible == true
    }

    /// Syncs the dock icon to `hasMainWindow` — called after every mutation of `detachedWindows`/
    /// `dashboardWindow`/the shell's visibility (register, remove, open, close, summon, hide) so
    /// promotion/demotion never drifts out of step with the registries that define it.
    private func syncDockPresence() {
        hasMainWindow ? showDockIcon() : hideDockIcon()
    }

    /// Closes every open main window (detached chat windows + the Dashboard + the shell) — shared
    /// by `applicationShouldTerminate`'s cancel branch (⌘Q/dock-quit: close windows, keep running)
    /// and `applicationWillTerminate`'s final teardown below (a real quit: same windows, harder
    /// stop — spec §5 D9, a closed window must leave nothing running, and termination is harder
    /// than that).
    ///
    /// App shell T1: the shell HIDES here rather than closing (spec §1 — never destroyed). ⌘Q
    /// therefore leaves the singleton and its navigation state intact, ready for the next summon.
    private func closeMainWindows() {
        detachedWindows.forEach { $0.close() }
        dashboardWindow?.close()
        appWindow?.hide()
    }

    /// Test-only seam (DEFECT FIX regression, `StandaloneWindowTests`): `boot()`'s unit-test path
    /// always constructs a degraded (no-token) `AppModel` whose transport never opens — every RPC,
    /// including the very FIRST `createSession`, fails immediately. That makes it impossible to
    /// reach a state with a REAL prior focused session before a LATER createSession failure, which
    /// is exactly the scenario the defect fix targets. This wires in a scripted-transport
    /// `AppModel` (already focused on a real session) directly, bypassing `boot()` entirely — same
    /// "expose a narrow seam, don't fake the whole app" posture as `SessionModel.applyForTesting`/
    /// `OrbWindowController.setSurfaceForTesting`.
    func setAppModelForTesting(_ model: AppModel) {
        appModel = model
    }

    /// Registers a freshly spawned detached window and wires its one-shot `onClosed` to remove it
    /// from `detachedWindows` again. Called by `orb.onWindowDetach`'s closure below (Task 4's
    /// detach choreography — yellow on the morph window) and by `spawnDetachedWindow` (Task 5,
    /// 2e-iii — the sidebar's own "open in a new window" spawn).
    func registerDetachedWindow(_ controller: DetachedWindowController) {
        detachedWindows.append(controller)
        syncDockPresence() // Lifecycle T3: a real chat window just opened — promote if it's the first
        controller.onClosed = { [weak self] closed in
            self?.detachedWindows.removeAll { $0 === closed }
            self?.syncDockPresence() // Lifecycle T3: demote once the LAST main window closes
        }
        // Task 5 (2e-iii): the (Task-6-mounted) sidebar's ⌘-click "open in a new window" — spawns
        // ANOTHER detached window pinned to an explicit sessionId, parameterized by an id instead of
        // the currently-focused session. Every detached window (including ones spawned this way)
        // gets this same hook wired, so its OWN sidebar can keep opening further windows too.
        //
        // Plan-immunity (2026-07-28 design; fix round 1): routed through `openSessionInNewDetachedWindow`
        // (was: a direct `spawnDetachedWindow` call, duplicating the feed/session lookup here) —
        // that's the ONE place `isChat` now auto-derives from `model.directory.rows` when the
        // caller doesn't already know the mode, which THIS door never does (the clicked row could
        // be chat OR code). Passing `frame:` explicitly (this door's own offset-from-source
        // positioning) still overrides the centered-fallback default, unchanged. This also makes
        // `OrbWindowController.onOpenChild`'s own doc comment accurate again — it already claimed
        // this door "uses `openSessionInNewDetachedWindow`", which wasn't true before this fix.
        //
        // Fix round 1 re-review (Minor, closed here): `controller.directory` is THIS SOURCE window's
        // own private `SessionDirectory` — the one that actually rendered the clicked row, so it
        // definitionally already has it. Passed as `sourceRows:` so `openSessionInNewDetachedWindow`
        // can check it BEFORE falling back to `model.directory.rows` (AppModel's separate instance,
        // synced with this one only via daemon broadcast fan-out, which can legitimately lag — see
        // that method's own doc comment for why "not found in model.directory" is the wrong direction
        // for a chat row specifically).
        controller.onOpenSessionDetached = { [weak self, weak controller] sessionId in
            guard let self else { return }
            let sourceFrame = controller?.currentFrame ?? NSRect(origin: .zero, size: chatWindowDefaultSize)
            self.openSessionInNewDetachedWindow(sessionId, frame: sourceFrame.offsetBy(dx: 24, dy: -24), title: "Norma", sourceRows: controller?.directory.rows ?? [])
        }
    }

    /// Task 5 (2e-iii): the shared spawn body BOTH detach paths use — construct, register, show.
    /// Callers own their OWN feed-creation guard above this (so each can log its own
    /// context-specific failure message) and hand the already-built feed/session in.
    /// Task 6 (2e-iii, CARRIED ITEM 3): the MORPH window's left sidebar ⌘-click "open in a new
    /// window" for an ARBITRARY session id — the mirror of `DetachedWindowController`'s
    /// `onOpenSessionDetached`, reusing the SAME `makeDetachedFeed` + `spawnDetachedWindow`
    /// machinery. The morph panel has no production frame accessor, so the new window spawns
    /// centered on the main screen (the user can move it); a `nil` model or missing daemon token
    /// aborts with a log, same posture as the yellow-light and detached-side spawns.
    /// Task 2 (2e-iv): `frame` override lets `openStandaloneNormaWindow()` below reuse this exact
    /// body instead of duplicating it. `nil` (every pre-existing caller) keeps the original
    /// behavior — centered on the main screen — now computed via the shared pure
    /// `centeredStandaloneFrame` instead of the inline midX/midY math this method used before.
    /// Chat Mode Slice A (CM-T3): `title` widened from a fixed `"Norma"` to a defaulted parameter —
    /// every PRE-EXISTING caller (orb's child-status circles, the sidebars' ⌘-click, the Dashboard
    /// SessionsPane row click) keeps the exact same "Norma" fallback, unchanged; `openChat()` below
    /// is the first caller to pass something else (the session's own title, or "Chat").
    ///
    /// Plan-immunity (2026-07-28 design; fix round 1): `isChat: Bool? = nil` — `nil` (every
    /// PRE-EXISTING caller: orb's child-status circles, sidebars' ⌘-click, the Dashboard SessionsPane
    /// row click) means "derive it", via the SAME pure helper `DetachedWindowController.selectSession`
    /// uses (`isChatSession(_:in:)`), off `model.directory.rows` — AppModel's own live session list,
    /// independently refreshed by every session-lifecycle broadcast regardless of which window's
    /// sidebar the caller's `sessionId` actually came from, so it reliably has the row by the time a
    /// user could have clicked it anywhere. `createAndOpenChat()`/`openChat()`'s reopen path pass an
    /// EXPLICIT `true` instead of relying on this derivation — they just created/confirmed the
    /// session themselves and know its mode with certainty the directory's own async refresh cadence
    /// can't beat. (Fix round 1, review finding: three doors — ⌘-click open-in-new-window, the
    /// Dashboard's SessionsPane row click, and the orb's own sidebar — showed BOTH policy pickers
    /// shown-but-broken for a chat session, since only the explicit-`true` callers were ever
    /// threaded. This auto-derivation closes the ⌘-click and Dashboard doors at this ONE shared
    /// choke point; the orb's OWN `WindowContentView` instance renders a SEPARATE adapter
    /// [`OrbWindowController.fieldAdapter`], fixed at its sidebar's own `onSelect` wiring instead —
    /// see that closure's own doc comment.)
    ///
    /// Fix round 1 re-review (Minor, closed here): `sourceRows` — the SOURCE window's own rows,
    /// when the caller has a source window (door 1's ⌘-click; empty for every other caller, which
    /// has no such window). Checked BEFORE `model.directory.rows`: the source window's sidebar is
    /// where the click actually happened, so it definitionally already has the clicked row loaded —
    /// `model.directory` (a SEPARATE instance, kept in sync only by daemon broadcast fan-out) can
    /// legitimately still be missing it. Judgment call (this task's brief asked for one): defaulting
    /// to "not chat" on a miss here would SHOW a policy picker that immediately fires a rejected
    /// `setPolicy` against a real chat session — the exact shown-but-broken bug this whole slice
    /// exists to close — so checking the source first, rather than hiding-by-default for an unknown
    /// mode, is the fix: it resolves the race with real data instead of guessing.
    private func openSessionInNewDetachedWindow(_ sessionId: String, frame: NSRect? = nil, title: String = "Norma", isChat: Bool? = nil, sourceRows: [SessionSummary] = []) {
        guard let model = appModel,
              let (feed, session) = model.makeDetachedFeed(sessionId: sessionId) else {
            OrbDebug.log("openSessionInNewDetachedWindow: no appModel or makeDetachedFeed nil — spawn aborted")
            return
        }
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let resolvedFrame = frame ?? centeredStandaloneFrame(visibleFrame: visible)
        let resolvedIsChat = isChat ?? (
            DetachedWindowController.isChatSession(sessionId, in: sourceRows)
                || DetachedWindowController.isChatSession(sessionId, in: model.directory.rows)
        )
        spawnDetachedWindow(feed: feed, session: session, frame: resolvedFrame, title: title, isChat: resolvedIsChat)
    }

    /// Task 4 (detach choreography) body — extracted from `orb.onWindowDetach`'s closure (Plan-
    /// immunity Task 2) so it's directly unit-testable against a `setAppModelForTesting`-installed
    /// scripted `AppModel`, same "pull the real logic out of a `boot()`-wired closure into a plain
    /// method" move as `OrbWindowController.updateIsChatSession` (see its own doc comment for why
    /// `boot()`'s own AppModel can never be scripted in a test). Returns whether a window actually
    /// spawned — see the call site's own doc comment for the two bail paths and why
    /// `requestWindowDetach()` gates its exit-to-orb on this.
    ///
    /// Plan-immunity Task 2 ("the fifth door"): with the orb's focus/sidebar gates elsewhere in
    /// this file in place, the focused session here can no longer actually BE a chat session — but
    /// this derives `isChat` anyway (defense-in-depth, one argument) rather than trusting that
    /// invariant silently. This slice's own history is exactly "unreachable today" becoming
    /// reachable later; a bare `spawnDetachedWindow` call with no `isChat` here would open a chat
    /// session's detached window with its policy picker shown-but-broken — the same bug the
    /// auto-derivation in `openSessionInNewDetachedWindow` (doors 1/2) already closed for those two.
    @discardableResult
    private func handleWindowDetach(frame: NSRect) -> Bool {
        guard let model = appModel else {
            OrbDebug.log("onWindowDetach: no self/appModel — spawn aborted, window surface kept")
            return false
        }
        let sid = model.focusedSessionId // capture BEFORE the fresh session flips it
        guard let sid, let (feed, session) = model.makeDetachedFeed(sessionId: sid) else {
            OrbDebug.log("onWindowDetach: no focused session or makeDetachedFeed nil — spawn aborted, window surface kept")
            return false
        }
        let title = model.session.state.exchanges.first.map { String($0.prompt.prefix(40)) } ?? "Norma"
        let isChat = DetachedWindowController.isChatSession(sid, in: model.directory.rows)
        // detached window VISIBLE first — the orb panel is still `.window` here
        spawnDetachedWindow(feed: feed, session: session, frame: frame, title: title, isChat: isChat)
        Task { await model.startFreshSessionAfterDetach() } // orb's next summon = clean slate
        return true
    }

    /// Chat Mode Slice A (CM-T3): pure decision helper for the "Chat" menu entry — the newest
    /// `mode == "chat"` row's id, or `nil` meaning "create one". Same shape as `AppModel.
    /// focusNewestSession()`'s own dispatch-only filter (`sessions.filter { $0.mode == "dispatch" }
    /// .max(by: createdAt)`), scoped to chat instead — deliberately free of any client/MainActor
    /// dependency (a plain `[SessionSummary]` in, `String?` out) so it's directly unit-testable
    /// without a scripted transport.
    nonisolated static func chatSessionToOpen(in rows: [SessionSummary]) -> String? {
        rows.filter { $0.mode == "chat" }.max(by: { $0.createdAt < $1.createdAt })?.sessionId
    }

    /// Plan-immunity Task 2 (mode×surface matrix): the orb's OWN sidebar row filter
    /// (`orb.sidebars`'s `rowFilter`, wired in `boot()` below) — dispatch is the ONLY mode the orb
    /// may ever show or focus (`AppModel.refocus`'s own gate is the model-level half of this;
    /// this is the UI half, so a non-dispatch row is never even rendered as clickable there in the
    /// first place). Positive match, same shape as `chatSessionToOpen(in:)`'s own mode filter —
    /// deliberately free of any view/MainActor dependency so it's directly unit-testable without
    /// rendering `SessionSidebar` (this codebase's convention: SwiftUI bodies themselves are never
    /// unit-tested, only their pure decision helpers — see `DashboardTests`' own file doc).
    nonisolated static func isOrbSidebarRow(_ row: SessionSummary) -> Bool {
        row.mode == "dispatch"
    }

    /// Chat Mode Slice A (CM-T3): the detached chat window's title — the session's own title,
    /// trimmed, falling back to "Chat" for a session with none yet (a freshly created one, or an
    /// existing one the daemon hasn't titled). Same trim-and-fallback shape as `SessionsPane.
    /// sessionDisplayTitle`, just chat's own fallback text instead of "New session" — kept
    /// separate rather than reused since the two callers want different defaults.
    nonisolated static func chatWindowTitle(_ title: String?) -> String {
        let trimmed = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "Chat" : trimmed
    }

    /// Chat Mode Slice A (CM-T3): the menu bar's "Chat" entry. Lists sessions FRESH via `client.
    /// listSessions()` rather than trusting `model.directory.rows` — that directory only refreshes
    /// on a session-lifecycle broadcast or a SwiftUI sidebar's own `.task { await directory.
    /// refresh() }` (`SessionSidebar`/`SessionsPane`), neither of which this plain AppKit menu
    /// click can rely on having happened (e.g. right after a fresh launch, before any window has
    /// ever been opened, `rows` is still empty). Opens the newest existing chat session
    /// (`chatSessionToOpen`'s pure decision) via the same detached-window machinery as every other
    /// spawn path, or creates one when none exists yet.
    func openChat() {
        guard let model = appModel else {
            OrbDebug.log("openChat: no appModel — spawn aborted")
            return
        }
        Task { [weak self] in
            guard let self else { return }
            let rows = (try? await model.client.listSessions())?.map {
                SessionSummary(sessionId: $0.sessionId, title: $0.title, createdAt: $0.createdAt, scope: $0.scope, cwd: $0.cwd, mode: $0.mode, parentSessionId: $0.parentSessionId, model: $0.model, effort: $0.effort, dirs: $0.dirs, activity: $0.activity)
            } ?? []
            if let sid = Self.chatSessionToOpen(in: rows) {
                let title = rows.first { $0.sessionId == sid }?.title
                self.openSessionInNewDetachedWindow(sid, title: Self.chatWindowTitle(title), isChat: true)
                return
            }
            await self.createAndOpenChat()
        }
    }

    /// Chat Mode Slice A (CM-T3): the menu bar's "New Chat" entry — ALWAYS creates a fresh chat
    /// session via `session.create({mode:"chat"})`, regardless of any existing chat session
    /// (unlike "Chat" above, which opens the newest one when one exists). Chat sessions are never
    /// the dispatch singleton — `session.create`, never `session.dispatch`.
    func newChat() {
        guard appModel != nil else {
            OrbDebug.log("newChat: no appModel — spawn aborted")
            return
        }
        Task { [weak self] in await self?.createAndOpenChat() }
    }

    /// Shared create+open body for `newChat()` and `openChat()`'s "no chat session exists yet"
    /// path. Same `scope`/`cwd`/`approvalPolicy` as the sidebars' own "+ New session"
    /// (`DetachedWindowController.newSession()`) — a plain, trusted-home-directory session — plus
    /// `mode: "chat"`. A freshly created session never has a title yet, so `chatWindowTitle(nil)`
    /// resolves straight to the "Chat" fallback.
    private func createAndOpenChat() async {
        guard let model = appModel,
              let created = try? await model.client.createSession(scope: "global", cwd: NSHomeDirectory(), approvalPolicy: "auto", mode: "chat") else {
            OrbDebug.log("createAndOpenChat: session.create(mode: chat) failed — spawn aborted")
            return
        }
        openSessionInNewDetachedWindow(created.sessionId, title: Self.chatWindowTitle(nil), isChat: true)
    }

    /// Task 2 (2e-iv): the menu bar's "Open Norma App" entry (`NSMenuItem` wiring is Task 3) — a
    /// brand-new session via the SAME create+focus primitive the detach choreography and sidebar's
    /// "+ New session" already reuse (`AppModel.startFreshSession`). Its orb-focus side effect
    /// isn't separable from the create here, and is harmless: the orb's next summon simply lands on
    /// this same fresh session too. Then a detached window on that id, centered on the main screen
    /// via `centeredStandaloneFrame` — unlike the other two spawn paths (yellow-light detach,
    /// sidebar's ⌘-click), this one is never offset from an existing window/orb frame.
    ///
    /// Defensive, same posture as `openSessionInNewDetachedWindow`'s own guard (line 58 precedent):
    /// no `appModel`, `startFreshSession` returning `nil` (RPC failure), or `makeDetachedFeed` nil
    /// (missing token, checked inside `openSessionInNewDetachedWindow`) all resolve to
    /// `OrbDebug.log` + no-op, never a crash or a half-open window.
    ///
    /// DEFECT FIX (reviewed defect): this used to await the void `startFreshSessionAfterDetach()`
    /// and then read `model.focusedSessionId` — which, on a `createSession` RPC failure, silently
    /// stayed whatever it already was (a STALE PRIOR session, in the orb's normal running state),
    /// so the guard below wrongly passed and spawned the standalone window on that stale session
    /// instead of no-op-ing. Reading `startFreshSession()`'s RETURN VALUE instead — never
    /// `focusedSessionId` — closes that: `nil` on failure is unambiguous regardless of any prior
    /// focus, so a failed create can no longer be mistaken for a fresh one.
    func openStandaloneNormaWindow() {
        guard let model = appModel else {
            OrbDebug.log("openStandaloneNormaWindow: no appModel — spawn aborted")
            return
        }
        Task { @MainActor [weak self] in
            guard let self, let sid = await model.startFreshSession() else {
                OrbDebug.log("openStandaloneNormaWindow: startFreshSession produced no session (RPC failure) — spawn aborted")
                return
            }
            let visible = NSScreen.main?.visibleFrame ?? .zero
            self.openSessionInNewDetachedWindow(sid, frame: centeredStandaloneFrame(visibleFrame: visible))
        }
    }

    /// App shell T1 — THE summon primitive (spec §1). Every path that wants the app window goes
    /// through here: the dock icon (`applicationShouldHandleReopen`), the menu bar's "Open Norma
    /// App" entry, and — as later tasks land them — the orb, the outputs panel, and every "open in
    /// app" affordance. The first call constructs the ONE controller; every later call focuses that
    /// same window (ruling R2: nothing ever spawns a second app window).
    ///
    /// `destination == nil` is a PLAIN refocus that preserves whatever the user was looking at —
    /// the `openDashboard(initialPane:)` precedent below, whose own history is exactly this
    /// distinction (retargeting unconditionally on refocus discarded the user's current pane; the
    /// fix made "no destination requested" mean "leave it alone"). A fresh window with no
    /// destination lands on `defaultShellDestination`, seeded by `ShellNavigationModel` itself.
    ///
    /// Defensive, same posture as `openDashboard`'s own guard: never booted (no `appModel`, hence
    /// no `SessionDirectory` for the Recents list) resolves to a log + no-op, never a crash or a
    /// half-wired window.
    func summonAppWindow(navigatingTo destination: ShellDestination? = nil) {
        if let appWindow {
            appWindow.summon(navigatingTo: destination)
            return
        }
        guard let model = appModel else {
            OrbDebug.log("summonAppWindow: no appModel — summon aborted")
            return
        }
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        // Task 3: the session host — spec §1's attachment policy. Its harnesses come from
        // `makeDetachedFeed`, so the shell shares this AppModel's transport factory and token (one
        // Keychain read) on its OWN socket: the orb's feed is `followFocus` and dispatch-only, and
        // the shell shows code and chat sessions too. A separate socket is also what makes the
        // policy's last row true — the shell's attachment is its own, so a detached window closing
        // is never the last detach for a session the shell is showing.
        // app-shell T4: the landing's roster verbs (stop/background/archive) and "New" button ride
        // this SAME always-connected client — see `ShellSessionHost.managementClient`'s doc for why
        // that must be a bare, non-attaching connection rather than another `makeFeed` harness.
        let host = ShellSessionHost(
            directory: model.directory,
            makeFeed: { [weak model] sessionId in model?.makeDetachedFeed(sessionId: sessionId) },
            managementClient: model.client
        )
        let controller = AppWindowController(
            directory: model.directory,
            host: host,
            frame: centeredAppWindowFrame(visibleFrame: visible)
        )
        // The activation-policy machinery is RETARGETED, not rebuilt: a visible shell is a main
        // window (promote), a hidden one is not (demote). This hook is the only way that stays in
        // step, since the shell hides itself instead of closing — there is no `onClosed` to hang
        // it on, the way `dashboardWindow`/`detachedWindows` do.
        controller.onVisibilityChange = { [weak self] _ in self?.syncDockPresence() }
        // Task 2: the `session.list` poll cadence — visible AND unoccluded starts it, everything
        // else (hidden, occluded, ⌘Q's closeMainWindows()) stops it. `model.directory` is the SAME
        // instance this controller renders (`directory: model.directory` above) and every other
        // app-shell surface reads, so gating polling here gates it for all of them. Wired BEFORE
        // `summon()` below so the very first `syncState()` it triggers (occlusionVisible starts
        // `true`, `window.isVisible` flips `true` on `makeKeyAndOrderFront`) already starts the poll
        // — a freshly summoned shell must not sit unpolled until some LATER occlusion notification.
        controller.onRenderingActiveChange = { [weak model] active in model?.directory.setPolling(active: active) }
        appWindow = controller
        controller.summon(navigatingTo: destination)
    }

    /// Task 5 (2f-ii): the menu bar's "Dashboard…" entry — singleton behavior per the brief: a
    /// second invocation while the window is already open just refocuses it (`show()` is
    /// idempotent — `makeKeyAndOrderFront` on an already-front window is a no-op), never
    /// constructing a second `DashboardWindowController`. Defensive, same posture as
    /// `openSessionInNewDetachedWindow`'s guard: no `appModel`/`peripheralProvider` (never booted)
    /// resolves to a log + no-op, never a crash or a half-wired window.
    /// Phase 4d-iii Task 2: `initialPane` lets `openPluginManager()` below reuse this exact body
    /// (same "shared spawn body" posture as `openSessionInNewDetachedWindow`'s own `frame`
    /// override) instead of duplicating the guard/construction.
    /// Phase 4d-cleanup Task 3 fix 1: a second invocation while one is already open retargets the
    /// pane (`DashboardWindowController.selectPane(_:)`, below) before refocusing via `show()` —
    /// previously this only refocused the window without ever switching panes, so "Manage
    /// Plugins…" fired against an already-open Dashboard silently did nothing pane-wise.
    /// Phase 4d-cleanup Task 3 fix wave 1: that fix over-corrected — retargeting UNCONDITIONALLY
    /// on refocus meant the plain "Dashboard…" entry (`initialPane` omitted, `AppDelegate.swift`'s
    /// `openDashboard: { ... }` wiring below) snapped an already-open window back to the default
    /// pane too, discarding whatever pane the user had navigated to. `initialPane` is now
    /// `DashboardPane?`: `nil` means "no pane requested" — a plain refocus that preserves whatever
    /// is currently showing (the selection model already starts at `defaultDashboardPane` on first
    /// open, so a fresh window still lands correctly). Non-`nil` means "targeted" — callers like
    /// `openPluginManager()` below that must land on a specific pane whether the window is opening
    /// fresh or already open.
    func openDashboard(initialPane: DashboardPane? = nil) {
        if let dashboardWindow {
            // Only a TARGETED open (non-nil `initialPane`) retargets the pane before refocusing —
            // a plain refocus (`initialPane == nil`) leaves the current pane untouched.
            if let initialPane {
                dashboardWindow.selectPane(initialPane)
            }
            dashboardWindow.show()
            return
        }
        guard let model = appModel, let peripheral = peripheralProvider, let helper = helperClient else {
            OrbDebug.log("openDashboard: no appModel/peripheralProvider/helperClient — spawn aborted")
            return
        }
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let controller = DashboardWindowController(
            client: model.client,
            directory: model.directory,
            peripheral: peripheral,
            helperClient: helper,
            shortcutRegistry: shortcutRegistry,
            onOpenSessionDetached: { [weak self] sid in self?.openSessionInNewDetachedWindow(sid) },
            frame: centeredDashboardFrame(visibleFrame: visible),
            initialPane: initialPane ?? defaultDashboardPane,
            // BYOK T2 (T1 report's "Concerns for T2"): a provider-TYPE change only takes effect on
            // the NEXT daemon boot (`providers/manager.ts`'s `createProvider` fixes `providerType`
            // at boot) — `provider.configure` itself only persists the secret + settings. The
            // Provider pane's model has no `AppDelegate` reference of its own; this is the one
            // place that closes the loop, same "AppDelegate wires the real side effect, the pane
            // only fires an injected closure" posture as every other real-side-effect hook in this
            // file (`onRestartDaemon` on the menu bar, just below in this same method's sibling).
            onConfigured: { [weak self] in self?.daemonSupervisor?.restart() },
            // CC-parity phase 3 (Workflows, Track D Task D3): the Workflows pane runs/lists/stops
            // against whichever session is CURRENTLY focused (`model.session` already mirrors
            // exactly that — `AppModel.handle(_:)`'s own `guard e.sessionId == focusedSessionId`
            // gate) — a closure, not a snapshot id, since focus can change while this window stays
            // open (`DashboardWiring`'s own "data OR a closure" convention).
            session: model.session,
            currentSessionId: { model.focusedSessionId }
        )
        controller.onClosed = { [weak self] _ in
            self?.dashboardWindow = nil
            self?.syncDockPresence() // Lifecycle T3: demote once the LAST main window closes
        }
        dashboardWindow = controller
        syncDockPresence() // Lifecycle T3: the Dashboard is a real main window — promote
        controller.show()
    }

    /// Phase 4d-iii Task 2: the menu bar's "Manage Plugins…" entry — opens the SAME singleton
    /// Dashboard window `openDashboard()` owns, landed on `.pluginManager` whether the window is
    /// spawned fresh or already open (a targeted `initialPane` retargets an open window; only the
    /// plain nil-pane "Dashboard…" path preserves the user's current pane — 4d-cleanup T3).
    func openPluginManager() {
        openDashboard(initialPane: .pluginManager)
    }

    /// SP2b T5: the menu bar's "Pair a Device…" entry. A second invocation while the sheet is
    /// already open just refocuses it (same posture as `openDashboard`'s own guard). Building the
    /// model requires an `await` (`RemoteHost.openPairingWindow()` may need to bind a fresh iroh
    /// listener) — the re-check of `pairingSheetWindow` right after that await guards against a
    /// double-click racing two overlapping builds into two separate windows/ceremonies.
    func openPairDevice() {
        if let pairingSheetWindow {
            pairingSheetWindow.show()
            return
        }
        guard let coordinator = remoteAccessCoordinator else {
            OrbDebug.log("openPairDevice: no remoteAccessCoordinator — spawn aborted")
            return
        }
        // Present the panel IMMEDIATELY (in its "Preparing…" state) before awaiting the pairing
        // stack: `RemoteHost.openPairingWindow()` cold-starts an iroh listener and homes it to a
        // relay, which takes seconds on a hotspot — awaiting that first would leave the user
        // staring at nothing and re-clicking the menu item. Creating + registering the window
        // synchronously here also makes any such second click a harmless refocus (the guard above),
        // instead of racing a second overlapping ceremony into a second window.
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let controller = PairingSheetWindowController(frame: centeredPairingSheetFrame(visibleFrame: visible))
        controller.onClosed = { [weak self] closed in
            self?.pairingSheetWindow = nil
            // Teardown order matters (T5 review, Important): stop the model FIRST — cancels its
            // event/countdown background tasks, without which a closed sheet's countdown would keep
            // ticking (and auto-`beginPairing()`-ing against a manager the coordinator may be
            // tearing down) forever; the tasks retain the model for the duration of their in-flight
            // calls, so nothing about window/model deallocation would stop them. `closed.model` is
            // nil if the panel was closed while still "Preparing…" (no model yet) — the build task
            // below stops that late-arriving model itself. THEN `pairingSheetClosed()` (whose
            // `closePairingWindow()` also ends the manager's live offer via `endPairing()`) lets the
            // whole stack tear itself down if idle.
            closed.model?.stop()
            Task { await coordinator.pairingSheetClosed() }
        }
        self.pairingSheetWindow = controller
        controller.show()

        Task { [weak self] in
            guard let self else { return }
            do {
                let model = try await coordinator.makePairingSheetModel()
                // The user may have closed the "Preparing…" panel while homing was in flight — its
                // `onClosed` already ran and tore the stack down. Don't resurrect it; just stop the
                // freshly-built model so its manager/offer doesn't linger.
                guard self.pairingSheetWindow === controller else {
                    model.stop()
                    return
                }
                controller.attach(model: model)
            } catch {
                OrbDebug.log("openPairDevice: couldn't start the pairing stack: \(error)")
                // Homing/bind failed — the panel is stuck "Preparing…". Close it so the normal
                // teardown runs (its `onClosed` → `pairingSheetClosed()` → `stopIfIdle()`); a
                // no-op if the user already closed it (the controller's one-shot `didClose` guard).
                if self.pairingSheetWindow === controller {
                    controller.close()
                }
            }
        }
    }

    /// SP2b T5: the menu bar's "Paired Devices…" entry. `PairedDevicesView` does its own async
    /// listing (`.task`) once presented, so — unlike `openPairDevice` — the window is constructed
    /// synchronously; there is no pairing-window/iroh-listener to force-start just to see the list.
    func openPairedDevices() {
        if let pairedDevicesWindow {
            pairedDevicesWindow.show()
            return
        }
        guard let coordinator = remoteAccessCoordinator else {
            OrbDebug.log("openPairedDevices: no remoteAccessCoordinator — spawn aborted")
            return
        }
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let controller = PairedDevicesWindowController(
            list: { await coordinator.pairedDevices() },
            revoke: { peer in try await coordinator.revoke(phoneEndpointID: peer) },
            frame: centeredPairedDevicesFrame(visibleFrame: visible)
        )
        controller.onClosed = { [weak self] _ in self?.pairedDevicesWindow = nil }
        pairedDevicesWindow = controller
        controller.show()
    }

    @discardableResult
    private func spawnDetachedWindow(feed: SessionFeed, session: SessionModel, frame: NSRect, title: String, isChat: Bool = false) -> DetachedWindowController {
        let detached = DetachedWindowController(feed: feed, session: session, frame: frame, title: title.isEmpty ? "Norma" : title, isChat: isChat)
        registerDetachedWindow(detached)
        detached.show()
        return detached
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        guard !Self.isRunningUnitTests else { return }
        // DD-T4: stamp NORMA_HOME + NORMA_PROFILE into this process's env BEFORE the first
        // `NormaPaths` read (which happens inside `boot()` — `supervisor.start()`'s socket probe,
        // `AppModel.production()`), so the app, NormaKit, and every spawned child (the bundled
        // `norma-core` daemon inherits our env via `Process`'s nil-environment default) resolve one
        // identity. `setenv(…, 0)` never overwrites an explicit env, so tests/power users still win.
        // Placed AFTER the unit-test guard so the xctest host launch never stamps `~/.norma-dev`.
        AppProfile.bootstrapEnvironment()
        _ = boot()
    }

    /// Everything after activation policy. Split out so tests can drive it without
    /// a real app launch. Returns true when boot completed (even degraded: a missing
    /// daemon token must not prevent the orb from appearing).
    @discardableResult
    func boot() -> Bool {
        // Lifecycle T6 (T4 review finding 5f): migration MUST run before the supervisor's
        // socket-exists probe just below — a leftover `com.norma.core` KeepAlive launchd agent
        // would otherwise relaunch a daemon the app just killed, permanently defeating "app quit ->
        // daemon quit" for that user. `launchdMigrationOverride` lets a test drive this exact call
        // with a spy; `nil` (production) runs the real migration, gated the same
        // `!isRunningUnitTests` way as `helper.register()`/`loginItem.setEnabled(true)` below.
        if let launchdMigrationOverride {
            launchdMigrationOverride()
        } else if !Self.isRunningUnitTests {
            migrateFromLaunchdAgent()
        }

        // Lifecycle T6: construct + start the daemon supervisor. `daemonSupervisorDeps` (nil unless
        // a test overrides it) resolves to `.live` in production; under unit tests with no override
        // it resolves to `.neverSupervise` (never a bundled path -> always `.connectOnly` -> spawns
        // nothing), so the dozens of existing tests that call `boot()` directly never risk spawning
        // or probing anything real, regardless of what the test host's `Bundle.main` contains.
        let supervisorDeps = daemonSupervisorDeps ?? (Self.isRunningUnitTests ? .neverSupervise : .live)
        let supervisor = DaemonSupervisor(deps: supervisorDeps)
        supervisor.onStateChange = { [weak self] state in
            self?.menuBar?.setEngineFailed(state == .failed)
        }
        supervisor.start()
        daemonSupervisor = supervisor

        // Sparkle T3: the silent background updater. Never constructed under unit tests — same
        // `!isRunningUnitTests` posture as the daemon supervisor's real spawn path and every other
        // real-side-effect construction in this method; `updaterDepsOverride` (nil in production)
        // lets a test drive `UpdaterCoordinator` directly without ever touching this controller.
        // DD-T4: Sparkle is DIST-ONLY. Only the CONSTRUCTION is gated `#if !DEBUG` (the property
        // declarations + `import Sparkle` stay in both configs) so a dev build never starts an
        // updater against the production feed — matching the dev/dist identity split. The existing
        // `!isRunningUnitTests` gate stays too (no updater from the xctest host).
        if !Self.isRunningUnitTests {
            #if !DEBUG
            // Sparkle T4: live `activeTurns` wiring — `appModel` doesn't exist yet at this point in
            // boot() (it's constructed further down), but the closure only evaluates it lazily at
            // poll time, long after `appModel` is set, so construction order here doesn't matter.
            // `updaterDepsOverride` (a test seam) must keep winning over this live wiring.
            var deps = updaterDepsOverride ?? .live
            if updaterDepsOverride == nil {
                deps.activeTurns = { [weak self] in await self?.appModel?.engineActivity() }
            }
            let coordinator = UpdaterCoordinator(deps: deps)
            let controller = SPUStandardUpdaterController(
                startingUpdater: true, updaterDelegate: coordinator, userDriverDelegate: nil)
            controller.updater.automaticallyChecksForUpdates = true
            controller.updater.automaticallyDownloadsUpdates = true
            updaterCoordinator = coordinator
            updaterController = controller
            #endif
        }

        // AX permission: stickiness needs it; ask once, run degraded until granted.
        // Never prompt during unit tests (ScaffoldTests drives boot() directly); prompt once in real runs.
        let axTrusted = Self.isRunningUnitTests
            ? false
            : AXIsProcessTrustedWithOptions(
                [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            )

        // A missing harness token means the daemon has never run — connecting would fail
        // hello forever. Boot the orb disconnected with an actionable menu line instead
        // of a hopeless retry loop; the user relaunches after `norma daemon run`.
        // Never touch the Keychain during unit tests either: the xctest host is not in the
        // token item's ACL, so SecItemCopyMatching blocks on a securityd consent dialog
        // (observed: testBootInstallsMenuBar hung 394s). Tests exercise the degraded path.
        let production = Self.isRunningUnitTests ? nil : (try? AppModel.production())
        // devfix (socket strand): the degraded fallback must still dial THIS profile's socket —
        // same `AppProfile.normaHome` resolution as `AppModel.production()` above, not the bare
        // `NormaPaths.socketPath()` (which would keep it pinned to the dist path for a dev app).
        let model = production ?? AppModel(
            makeTransport: { UnixSocketTransport(path: NormaPaths.socketPath(home: AppProfile.normaHome)) },
            token: AppModel.missingTokenSentinel
        )
        let tokenMissing = production == nil
        appModel = model
        OrbDebug.log("boot: axTrusted=\(axTrusted) tokenMissing=\(tokenMissing)")

        // Task 4 (2f): the peripheral provider — constructed against `model.client`, the app's
        // MAIN feed client/socket (NOT a detached window's own client — the daemon rule pins THE
        // provider to the most-recent-advertiser CONNECTION). Wired into AppModel's feed hooks
        // (`onPeripheralEvent`/`onClientConnected`) so lease/call events reach it regardless of
        // what session the orb happens to be focused on.
        let peripheral = PeripheralProvider(client: model.client)
        peripheralProvider = peripheral

        // Task 4 (4c): the hardware bridge — battery charge-limit verbs, routed through
        // `HelperClient`'s XPC connection to `NormaHelper`. Composed onto the SAME
        // `onPeripheralEvent` hook `peripheral` uses below (both are side-observers of the raw
        // event stream fired for every `.session` event — see `AppModel.init`'s `feed.onEvent`),
        // never restructuring that plumbing. `HelperClient()`'s own init only reads
        // `service.status` (safe anytime, no prompt/registration side effect); the real
        // `register()` call is gated below, same `!isRunningUnitTests` posture as
        // `peripheral.registerPanicSurfaces()`.
        let helper = HelperClient()
        helperClient = helper
        let hardware = HardwareBridge(client: model.client, helperClient: helper)
        hardwareBridge = hardware

        // Lifecycle T4: `SMLoginItem`'s `isEnabled`/`hasUserMadeChoice` are plain reads (no
        // registration side effect) — safe unconditionally, same posture as `HelperClient()` above.
        // The real default-on `setEnabled(true)` call is gated below.
        let loginItem = LoginItemController(service: SMLoginItem())
        loginItemController = loginItem

        // SP2b T5: constructing the coordinator does no I/O of its own (its `RemoteHost` is a
        // `lazy var`, untouched until a pairing window is actually requested) — safe
        // unconditionally, same posture as `HelperClient()`/`LoginItemController` above.
        remoteAccessCoordinator = RemoteAccessCoordinator()

        // Autostart follow-up (CN combined-review Important 2): start the remote listener NOW if
        // this Mac already has ≥1 paired device — `RemoteHost.startIfNeeded()`'s own gate
        // (`deviceCount > 0 || pairingWindowRequested`) makes this a no-op (one cheap
        // `PairingStore.all()` read) for a Mac nobody has ever paired a phone with. Without this,
        // the ONLY thing that ever started the listener was the "Pair a Device…" menu action, so a
        // paired phone lost its connection on every Mac relaunch (reboot, quit, hourly Sparkle
        // auto-update) until a human reopened that menu — defeating cross-network durability far
        // more often than any relay outage. Gated `!isRunningUnitTests`, same posture as every
        // other real-side-effect call in this method (Sparkle's updater construction,
        // `helper.register()`, `CliInstaller.offerOnFirstLaunchIfNeeded()` below); fire-and-forget
        // (`Task`) — nothing else in `boot()` depends on this completing, and both dev/dist
        // profiles autostart identically, each against its own `NORMA_HOME`/pairing store.
        if !Self.isRunningUnitTests {
            Task { [weak self] in
                await self?.remoteAccessCoordinator?.startRemoteAccessIfPaired()
            }
        }

        model.onPeripheralEvent = { [weak peripheral, weak hardware] event in
            await peripheral?.handle(event)
            await hardware?.handle(event)
        }
        model.onClientConnected = { [weak peripheral] in Task { await peripheral?.advertiseIfConnected() } }

        let orb = OrbWindowController(session: model.session)
        orbController = orb

        // Gate r7 (ARCHITECTURE PIVOT): the window is now a THIRD morph target of the orb panel
        // itself (`OrbWindowController.presentWindowSurface()`), not a separate `ChatWindowController`
        // panel — the whole `ChatWindow/*` layer is deleted. Expand-to-window is driven entirely
        // inside the controller (chevron → `requestExpandToWindow()`), so there is no cross-controller
        // `onExpandToWindow`/`onClose` wiring left to do.

        orb.onSubmit = { [weak self] text in
            guard let model = self?.appModel else { return false }
            let ok = await model.sendOrSteer(text)
            if ok { Haptics.messageSent() }
            return ok
        }
        orb.onEsc = { [weak self] in
            let running = self?.appModel?.session.state.turnRunning
            OrbDebug.log("AppDelegate.onEsc: fired appModel=\(self?.appModel != nil ? "present" : "nil") turnRunning=\(String(describing: running))")
            guard let self, self.appModel?.session.state.turnRunning == true else { return false }
            Task { await self.appModel?.interruptTurn() }
            return true
        }

        // Task 3 (2d-iii): the same seam as `onSubmit` above — the orb's own focused-session
        // respond RPCs, mirrored one-for-one onto `AppModel`'s three new methods.
        orb.onApprovalRespond = { [weak self] callId, approved, optionId, childSessionId in
            await self?.appModel?.respondApproval(callId: callId, approved: approved, optionId: optionId, childSessionId: childSessionId) ?? false
        }
        orb.onQuestionRespond = { [weak self] callId, answers, notes, childSessionId in
            await self?.appModel?.respondQuestion(callId: callId, answers: answers, notes: notes, childSessionId: childSessionId) ?? false
        }
        orb.onPlanRespond = { [weak self] callId, approved, autoAccept, feedback in
            await self?.appModel?.respondPlan(callId: callId, approved: approved, autoAccept: autoAccept, feedback: feedback) ?? false
        }

        // Task 4 (2d-iii): the ⋯ menu's approval-mode picker — same seam as the three respond
        // closures above.
        orb.onSetPolicy = { [weak self] policy in
            await self?.appModel?.setSessionPolicy(policy) ?? false
        }

        // Task 10 (Chat Slice D): the model menu — same seam as the policy picker just above.
        orb.onSetModel = { [weak self] model in
            await self?.appModel?.setSessionModel(model) ?? false
        }

        // provider-correctness T6: the effort menu and the catalogue behind both pickers — same
        // seam as the model menu just above.
        orb.onSetEffort = { [weak self] effort in
            await self?.appModel?.setSessionEffort(effort) ?? false
        }
        orb.onFetchModelCatalogue = { [weak self] in
            await self?.appModel?.fetchModelCatalogue()
        }

        // Dispatch (Phase 7), Task 8: the field's child-status circles — tapping one opens that
        // child session in a detached window via the SAME path the Dashboard's SessionsPane / the
        // sidebar's ⌘-click already use (`openSessionInNewDetachedWindow`, defined below).
        orb.onOpenChild = { [weak self] sessionId in
            self?.openSessionInNewDetachedWindow(sessionId)
        }

        // Task 4 (detach choreography): the yellow traffic light. `requestWindowDetach()` OWNS the
        // ordering — it fires this closure (spawning the detached window SYNCHRONOUSLY via
        // `show()`, before this closure returns) and only THEN runs its own no-animation exit
        // (`exitWindowModeForDetach()`), so there is never a frame with neither surface visible.
        // This closure therefore only spawns the window and kicks the fresh-session Task.
        //
        // I1 fix (review): returns whether a window actually spawned — `requestWindowDetach()`
        // gates its exit-to-orb on this. Two bail paths return `false` (no window, nothing to
        // exit into): no focused session yet (reachable via summon→expand→yellow before any
        // message has ever been sent), and `makeDetachedFeed` returning nil (missing daemon
        // token). Both leave the window surface exactly as it was — the user just keeps their
        // open window instead of losing it into the orb with nothing to show for it.
        //
        // Plan-immunity Task 2: pulled out into `handleWindowDetach(frame:)` below (was inlined
        // here) — same "extract for direct unit-testability without booting the whole app" move
        // as `OrbWindowController.updateIsChatSession` (see that method's own doc comment for why
        // `AppDelegate.boot()`'s AppModel can never be scripted in a test).
        orb.onWindowDetach = { [weak self] frame in self?.handleWindowDetach(frame: frame) ?? false }

        // Task 6 (2e-iii): the morph window's width-responsive sidebars. `onSelect` refocuses the
        // orb's own follow-focus feed in place (`focusSession`); `onNewSession` creates+focuses a
        // fresh session (the same create+focus primitive the detach path reuses); `onOpenDetached`
        // spawns a NEW detached window for an arbitrary session id (CARRIED ITEM 3 — no such path
        // existed before this task). `currentSessionId` reads `focusedSessionId` fresh each render.
        //
        // Plan-immunity (2026-07-28 design; fix round 1, review finding — door 3): `onSelect` ALSO
        // calls `orb.updateIsChatSession` — see that method's own doc comment (OrbWindowController.swift)
        // for why the orb needs this at all (a SEPARATE `FieldStateAdapter` from any
        // `DetachedWindowController`'s own) and why the logic lives there, not inlined here (unit
        // testability — this closure itself stays a thin, obviously-correct one-liner). Without it,
        // selecting a chat row here would leave both policy pickers shown-but-broken on the morph
        // window, exactly the state this whole slice refuses to ship.
        //
        // Plan-immunity Task 2 (mode×surface matrix): `rowFilter: AppDelegate.isOrbSidebarRow` closes
        // the "SHOULD the orb's sidebar be able to select a chat row at all" question fix round 1
        // left open — the orb is a dispatch-only surface, so a chat/cowork/code row is now never even
        // RENDERED here (not merely refused on click). `AppModel.refocus`'s own dispatch-only gate is
        // the model-level belt for this same seam — `updateIsChatSession`/`focusSession` above stay
        // reachable in principle (a filtered-out row can no longer supply them a non-dispatch id in
        // practice, but they don't rely on that to be correct).
        orb.sidebars = SidebarWiring(
            directory: model.directory,
            currentSessionId: { [weak model] in model?.focusedSessionId },
            onSelect: { [weak model, weak orb] sid in
                orb?.updateIsChatSession(for: sid, rows: model?.directory.rows ?? [])
                Task { await model?.focusSession(sid) }
            },
            onOpenDetached: { [weak self] sid in self?.openSessionInNewDetachedWindow(sid) },
            onNewSession: { [weak model] in Task { await model?.startFreshSessionAfterDetach() } },
            rowFilter: AppDelegate.isOrbSidebarRow,
            // App shell T1 (summon path): the ORB's door to the one app window. Wired HERE, on the
            // bundle this method already builds, so the orb gains a summon affordance with zero
            // changes to `OrbWindowController` — its internals are untouched by this plan (Global
            // Constraints) and it only passes this wiring through to `WindowContentView`.
            // Opt-in: `SidebarWiring.onSummonApp` defaults to nil, so the two detached-window
            // construction sites (which never pass it) render exactly as they did before.
            onSummonApp: { [weak self] in self?.summonAppWindow() }
        )

        let sticky = StickinessEngine(onTarget: { [weak orb] target in
            orb?.follower.setMagneticTarget(target)
        })
        stickiness = sticky
        if axTrusted { sticky.start() }
        OrbDebug.log("boot: stickiness \(axTrusted ? "STARTED" : "NOT started (no AX)")")
        orb.follower.onCursorLocationChange = { [weak sticky] location in
            sticky?.updateCursorLocation(location)
        }

        // Trigger sources + Combine wiring: never armed under unit tests. MultitouchTrigger
        // dlopens a private framework the xctest host shouldn't touch, and these sinks have
        // nothing to observe in the degraded test boot path anyway.
        if !Self.isRunningUnitTests {
            MultitouchTrigger.shared.start()
            HotkeyTrigger.shared.start()

            // Phase 4d-iii Task 1: the plugin-shortcut hotkey registry. Additive — never touches
            // `HotkeyTrigger.shared`'s own registration above. Bindings are edited by the Task 4
            // shortcut-editor UI (not built yet); this just loads whatever's already persisted
            // (empty on a fresh install) and arms it. A fired hotkey pushes straight to the owning
            // plugin via NormaKit's `shortcut.invoke` RPC (`shortcutInvoke`) — fire-and-forget from
            // the app's perspective, same posture as the menu bar's other client-call sites; a
            // failure (plugin not connected, unknown plugin, RPC error) is logged, not surfaced,
            // since there's no UI surface here to show it on.
            let shortcuts = ShortcutRegistry()
            shortcuts.onFire = { [weak model] pluginId, shortcutId in
                guard let client = model?.client else { return }
                Task {
                    do {
                        let outcome = try await client.shortcutInvoke(pluginId: pluginId, shortcutId: shortcutId)
                        if outcome != .ok {
                            OrbDebug.log("shortcutRegistry.onFire: shortcutInvoke pluginId=\(pluginId) shortcutId=\(shortcutId) outcome=\(outcome)")
                        }
                    } catch {
                        OrbDebug.log("shortcutRegistry.onFire: shortcutInvoke failed pluginId=\(pluginId) shortcutId=\(shortcutId) error=\(error)")
                    }
                }
            }
            // Phase 4d-cleanup Task 3 fix 2: boot time has no editor UI to surface a per-binding
            // arm failure against (unlike `ShortcutBindingEditorModel.capture`'s `conflictMessage`)
            // — just log how many failed, same posture as this file's other silent-failure paths.
            let failedAtBoot = shortcuts.reload(ShortcutSettingsStore.load())
            if !failedAtBoot.isEmpty {
                OrbDebug.log("boot: \(failedAtBoot.count) plugin shortcut hotkey(s) failed to arm (key may be in use by another app)")
            }
            shortcutRegistry = shortcuts

            // Task 4 (2f): the panic hotkey/screen-lock observer and the TCC-change poll are
            // real Carbon/DistributedNotificationCenter/Timer registrations — same
            // `!isRunningUnitTests` gate as the two triggers above, for the same reason (a real
            // global hotkey grab and a real distributed-notification observer have no place in a
            // unit-test process). `PeripheralProviderTests` exercises `handle`/`panic`/
            // `shouldServe` directly against a scripted client instead.
            peripheral.registerPanicSurfaces()
            peripheral.startTCCPolling()

            // Task 4 (4c): register the NormaHelper daemon with SMAppService at launch. A real
            // registration call (servicemanagementd round-trip) — same `!isRunningUnitTests` gate
            // as above; the `NormaAppTests` bundle loader IS the real `Norma.app`, so an
            // ungated call here would attempt to register an actual privileged daemon from the
            // test process. Live approval (System Settings > Login Items) is Task 6's gate —
            // `helper.status` degrades to `.requiresApproval` until the user acts, which
            // `hardwareBridge`/the dashboard row both already handle.
            helper.register()

            // Lifecycle T4: default-on login item — registers exactly once, on the very first
            // launch, unless the user has already made an explicit choice (including turning it
            // off) via the menu-bar checkbox or a prior launch. Real `SMAppService.mainApp`
            // round-trip — same `!isRunningUnitTests` gate as `helper.register()` above.
            if !loginItem.hasUserMadeChoice {
                loginItem.setEnabled(true)
            }

            // BYOK T2 (spec §3): the one-time first-run disclosure — shown at most once, ever, per
            // install. `shouldShowFirstRunDisclosure`/`markFirstRunDisclosureShown` are the pure
            // seam (`FirstRunDisclosure.swift`); marked shown IMMEDIATELY (not deferred to a button
            // click or the window's close) so a force-quit right after launch can never cause it to
            // reappear. This whole real-launch gate (`!Self.isRunningUnitTests`) is exactly the
            // "never under unit tests" contract the brief calls for — every existing `boot()` test
            // call site runs with this block skipped entirely.
            if shouldShowFirstRunDisclosure(defaults: .standard) {
                markFirstRunDisclosureShown(defaults: .standard)
                let firstRun = FirstRunDisclosureWindowController(
                    onSetupApiKey: { [weak self] in self?.openDashboard(initialPane: .provider) },
                    onSignInWithChatGPT: {}
                )
                firstRun.onClosed = { [weak self] _ in self?.firstRunDisclosureWindow = nil }
                firstRunDisclosureWindow = firstRun
                firstRun.show()
            }

            TriggerHub.shared.didTrigger
                .sink { [weak orb] in
                    Haptics.gestureRecognized()
                    guard let orb else { return }
                    // Gate r7: the window surface is the SAME panel now, so window-open == orb visible
                    // with `surface == .window`. A 4-finger tap while the window is open collapses it
                    // back to the orb (the SAME 140/22 spring the morph uses); otherwise toggle field.
                    switch summonToggleAction(surface: orb.surface, windowVisible: orb.isVisible) {
                    case .closeWindow: orb.collapseWindowToOrb()
                    case .toggleField: orb.toggleField()
                    }
                }
                .store(in: &cancellables)

            var lastPendingApprovalCount = model.session.state.pendingInteractions.count
            model.session.$state
                .sink { state in
                    let count = state.pendingInteractions.count
                    if count > lastPendingApprovalCount {
                        Haptics.approvalRequested()
                    }
                    lastPendingApprovalCount = count
                }
                .store(in: &cancellables)
        }

        let mb = MenuBarController(
            statusLine: { [weak model] in
                tokenMissing ? "no daemon token — run `norma daemon run`, then relaunch"
                             : (model?.connectionSummary ?? "starting…")
            },
            toggleOrb: { [weak self] in
                self?.orbController?.toggle()
                self?.menuBar?.setOrbVisible(self?.orbController?.isVisible ?? false)
            },
            summonField: {
                TriggerHub.shared.fire(from: "menu")
            },
            openCli: { [weak self] in self?.cliLauncher.openCli() },
            // App shell T1 (summon path): "Open Norma App" now summons the ONE app window instead
            // of spawning a fresh-session detached window. `openStandaloneNormaWindow()` above is
            // left in place — Task 6 owns the rest of the menu-bar retarget (`openChat`/`newChat`/
            // `openDashboard`/"Manage Plugins…") and deletes the spawn paths nothing still uses.
            openNormaApp: { [weak self] in self?.summonAppWindow() },
            openNewChat: { [weak self] in self?.newChat() },
            openChat: { [weak self] in self?.openChat() },
            openDashboard: { [weak self] in self?.openDashboard() },
            openPluginManager: { [weak self] in self?.openPluginManager() },
            openPairDevice: { [weak self] in self?.openPairDevice() },
            openPairedDevices: { [weak self] in self?.openPairedDevices() },
            loginItemController: loginItem,
            panic: { [weak peripheral] in peripheral?.panic() },
            quit: { NSApp.terminate(nil) },
            // Lifecycle T4: the ONE true-quit gate — arms `reallyQuitting` so
            // `applicationShouldTerminate` (T3) lets THIS quit through instead of treating it like
            // ⌘Q/dock-quit (close windows, keep running).
            onReallyQuit: { [weak self] in self?.reallyQuitting = true },
            // Lifecycle T6: the `.failed`-state "engine stopped — Restart" item's action.
            onRestartDaemon: { [weak self] in self?.daemonSupervisor?.restart() },
            // Sparkle T3: the "Check for Updates…" item's action — fires Sparkle's own UI-driven
            // check (progress/"you're up to date"/error alerts are Sparkle's standard user driver).
            onCheckForUpdates: { [weak self] in self?.updaterController?.checkForUpdates(nil) },
            // Sparkle T4: the staged-update "Restart Now" line's action — same override path as
            // the idle gate's own poll-triggered install, routed through `installNow()`'s
            // idempotent guard.
            onInstallUpdate: { [weak self] in self?.updaterCoordinator?.installNow() }
        )
        mb.install()
        menuBar = mb

        // Task DD-T5: the live activity icon — `AppModel.handle(_:)` derives `MenuBarActivity`
        // from the event stream at the single point every event flows through and fires this hook
        // only on value change; the menu bar owns frame-cycling/timer lifecycle from there. Same
        // decoupled-closure wiring posture as `onStagedChange`/`onBadgeChange` right below.
        model.onActivityChange = { [weak self] activity in
            self?.menuBar?.setActivity(activity)
        }

        // Sparkle T4: hook the idle gate's staged/badge callbacks to the menu bar. Installed here
        // (after `menuBar = mb`) rather than right where the coordinator is constructed earlier in
        // this method — order is safe either way since staging can only happen after an update
        // check, long past boot; `updaterCoordinator` is nil under unit tests, so these are no-ops
        // there.
        updaterCoordinator?.onStagedChange = { [weak self] staged, version in
            self?.menuBar?.setUpdateStaged(staged, version: version)
        }
        updaterCoordinator?.onBadgeChange = { [weak self] badged in
            self?.menuBar?.setUpdateBadge(badged)
        }
        // Sparkle whole-branch review (Critical): arm the updater-quit axis right before the
        // install handler runs — Sparkle's quit event is cancellable and would otherwise be
        // intercepted by `applicationShouldTerminate` like a ⌘Q (see `updaterQuitting`'s doc).
        updaterCoordinator?.onWillInstall = { [weak self] in self?.updaterQuitting = true }

        // Task 4 (2f): the red panic item mounts/unmounts as `activeLeases` crosses zero. Safe to
        // wire unconditionally (not gated by `isRunningUnitTests`) — `activeLeases` only ever
        // changes via real lease events, which never arrive in the degraded/no-socket test boot
        // path, so this subscription simply never fires there.
        peripheral.$activeLeases
            .receive(on: DispatchQueue.main)
            .sink { [weak self] leases in
                self?.menuBar?.setPanicVisible(!leases.isEmpty)
            }
            .store(in: &cancellables)

        orb.show()
        mb.setOrbVisible(true)

        if !tokenMissing {
            startTask = Task { [weak model, weak mb] in
                await model?.start()
                mb?.refresh()
            }
        }
        // Refresh the menu state line periodically (cheap; 2b has no binding plumbing to NSMenu).
        Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak mb] _ in
            Task { @MainActor in mb?.refresh() }
        }
        // DD-T7: dist-only first-launch offer for the `norma` command — late in launch, after the
        // menu exists (`mb.install()` above), gated `!isRunningUnitTests` the same way as every
        // other real-side-effect call in this method (Sparkle's updater construction, the AX
        // prompt, etc.) since `offerOnFirstLaunchIfNeeded()` can show a real modal `NSAlert`.
        if !Self.isRunningUnitTests {
            CliInstaller.offerOnFirstLaunchIfNeeded()
        }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        startTask?.cancel()
        // Lifecycle T6: stop the supervised daemon FIRST, before the peripheral teardown below —
        // this is what makes app-quit (and, via T3's terminateNow routing, system shutdown too)
        // take the daemon down with it. No-op if we're in `.connectOnly` or nothing was spawned.
        daemonSupervisor?.stop()
        // Task 4 (2f): best-effort revoke-all BEFORE `appModel?.stop()` closes the socket below —
        // `terminate()`'s revoke RPC is fired on an unstructured Task, so ordering it first gives
        // it the best (still not guaranteed) chance to reach the daemon before the connection dies.
        peripheralProvider?.terminate()
        appModel?.stop()
        closeMainWindows()
    }

    /// Lifecycle T3: the source-aware termination gate (product spec — only the menu-bar "Quit
    /// Norma" is a REAL quit). `terminateDecision` is the pure truth table (see its own doc).
    /// Review fix: a system LOGOUT/RESTART/SHUTDOWN arrives through this SAME delegate call as a
    /// user ⌘Q — answering it `.terminateCancel` would BLOCK the user's logout indefinitely, so
    /// `systemQuitReasonProvider` (the Apple-Event quit-reason read, injectable seam above) is the
    /// second true-quit axis alongside `reallyQuitting`. On `.terminateCancel` (⌘Q, dock-tile
    /// quit, or any other `terminate()` call that is neither the menu-bar Quit nor
    /// system-initiated) this closes the main windows and demotes the dock icon instead of
    /// actually quitting. `closeMainWindows()`'s own `onClosed` chain already demotes as each
    /// window closes (`syncDockPresence()`); the explicit `hideDockIcon()` below is
    /// belt-and-suspenders for the edge case where no main window was open (nothing to close, so
    /// nothing to trigger demotion through those callbacks).
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let reply = terminateDecision(
            reallyQuitting: reallyQuitting,
            systemInitiated: systemQuitReasonProvider(),
            updaterQuitting: updaterQuitting)
        if reply == .terminateCancel {
            closeMainWindows()
            hideDockIcon()
        }
        return reply
    }

    /// Lifecycle T3: dock-tile / Finder relaunch while Norma is already running (LSUIElement apps
    /// still receive `reopen` on a Finder double-click even with no dock tile to click). A main
    /// window is already open: return `true` and let AppKit's own default reopen handling bring it
    /// forward (including un-minimizing) — the dock icon is already showing in that case, nothing
    /// else to promote. No main window open: open one ourselves (the same "Open Norma App"
    /// primitive the menu bar uses, which promotes the dock icon as a side effect of the window it
    /// shows) and return `false`, since AppKit has nothing left to do.
    ///
    /// App shell T1 (summon path): that primitive is now `summonAppWindow()` — the dock icon
    /// summons the ONE app window rather than spawning a fresh-session detached window.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        guard !hasMainWindow else { return true }
        summonAppWindow()
        return false
    }

    static var isRunningUnitTests: Bool {
        NSClassFromString("XCTestCase") != nil
    }
}

/// Lifecycle T3: pure decision core for `applicationShouldTerminate` — no `NSApp`/AppleEvent
/// reference, so the whole truth table is unit-testable without any AppKit state (see
/// `AppLifecycleTests.testTerminateDecision`). `.terminateNow` iff `reallyQuitting` (set ONLY by
/// the menu-bar "Quit Norma") OR `systemInitiated` (review fix: the quit Apple Event carries a
/// logout/restart/shutdown reason — refusing THOSE would block the user's logout indefinitely)
/// OR `updaterQuitting` (Sparkle whole-branch review fix: Sparkle's installer quits the host via
/// a CANCELLABLE quit event with no kAEQuitReason — `AppDelegate.updaterQuitting`, armed by
/// `UpdaterCoordinator.onWillInstall` right before the install handler, is the third true-quit
/// axis that lets the install relaunch through); everything else — ⌘Q, dock-tile quit — cancels.
/// Window state never gates a quit: the T3 spec's original `hasMainWindow` param was
/// truth-table-inert and was dropped when `systemInitiated` (the real second axis) replaced it.
func terminateDecision(reallyQuitting: Bool, systemInitiated: Bool, updaterQuitting: Bool = false) -> NSApplication.TerminateReply {
    (reallyQuitting || systemInitiated || updaterQuitting) ? .terminateNow : .terminateCancel
}

/// Lifecycle T3 review fix: TRUE when the in-flight quit Apple Event carries a system quit reason
/// — the four reasons macOS stamps on the `kAEQuitApplication` event it sends every app during
/// logout/restart/shutdown. A user ⌘Q/dock-quit arrives with no quit-reason attribute (and a
/// programmatic `NSApp.terminate(nil)`, e.g. the menu-bar Quit, has no current Apple Event at
/// all) — both read as `false` here. AppKit global state, deliberately OUTSIDE the pure
/// `terminateDecision`; `AppDelegate.systemQuitReasonProvider` is the injectable seam over it.
func isSystemInitiatedQuitEvent() -> Bool {
    guard let reason = NSAppleEventManager.shared().currentAppleEvent?
        .attributeDescriptor(forKeyword: AEKeyword(kAEQuitReason))?.enumCodeValue
    else { return false }
    return reason == OSType(kAELogOut)
        || reason == OSType(kAEReallyLogOut)
        || reason == OSType(kAEShowRestartDialog)
        || reason == OSType(kAEShowShutdownDialog)
}
