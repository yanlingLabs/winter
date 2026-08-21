import AppKit
import Combine
import NormaKit
// b2-agent-browser T3: `onPanelCommand` names `SessionEvent.PanelCommand` in its signature.
// NormaKit re-exports the type in USE (its `NormaEvent.session` case carries one) but not in NAME,
// which is the same wall `PanelStore` and every other panel surface here hit.
import NormaProtocol
import SwiftUI

// MARK: - The attachment policy (PURE — spec §1's table, driven directly by ShellSessionHostTests)

/// What the shell must DO to satisfy spec §1's attachment table, given the only three facts that
/// decide it. Split out of `ShellSessionHost` for the usual reason (a decision a test can drive
/// without a socket, a window, or a run loop) and for one more: the table is a POLICY, and a policy
/// that lives inside an `if` cascade in a method that also does I/O is a policy nobody can read.
enum ShellAttachmentAction: Equatable {
    case none
    case detach
    /// Nothing is attached — open a harness and attach this session.
    case attach(String)
    /// Something ELSE is attached — move onto this session. See `ShellSessionHost.hop` for why one
    /// `session.attach` on the SAME connection *is* "detach previous, attach new".
    case hop(String)
}

/// The table, as a function.
///
/// | Shell state | Attachment |
/// |---|---|
/// | Visible, session selected | attached to THAT session only |
/// | Hop to another session | detach previous, attach new |
/// | Window hidden/closed | detach |
///
/// `selection` is what the shell is SHOWING (it survives a hide — that is what makes re-showing
/// re-attach the same session rather than landing on nothing); `attached` is what its harness is
/// actually attached to, `nil` while detached.
///
/// **`shellVisible`, not `renderingActive`.** T1 publishes two signals: visibility, and
/// visible-AND-unoccluded (`shellRenderingActive`). The poll (T2) gates on the latter because a tick
/// suspended behind another app's window costs nothing to resume. An ATTACHMENT is not like that: it
/// costs a socket, a hello and a full replay from seq 0 to re-acquire, and the spec's own row says
/// "hidden/closed", not "covered". Detaching every time the user clicks another app — and
/// re-replaying the transcript when they come back — would be a self-inflicted churn the table never
/// asked for.
func shellAttachmentAction(selection: String?, attached: String?, shellVisible: Bool) -> ShellAttachmentAction {
    guard shellVisible, let selection else { return attached == nil ? .none : .detach }
    guard let attached else { return .attach(selection) }
    return attached == selection ? .none : .hop(selection)
}

// MARK: - T4: the hop-away "keep working?" moment (spec §1, T3 review as-m9)

/// PURE: the hop-away trigger matrix. Hopping to another session, or hiding/navigating away from
/// one entirely, while its turn was genuinely RUNNING **and the session actually participates in
/// the activity lifecycle** is the one case that surfaces the prompt.
///
/// The participation gate mirrors `backgroundVerbOffered`'s own domain (T3's `ActivityMenu`
/// precedent, and the chip-visibility precedent — `ActivityChip`) rather than re-deriving a mode
/// list: `activity` is the daemon's own answer, relayed off the row, never guessed at client-side.
/// Fail-quiet toward NOT prompting on anything `backgroundVerbOffered` would refuse — chat/dispatch
/// (no lifecycle at all), archived (immutable except through resume), or an unrecognized future
/// value. This closes a real silent-failure path: a mid-turn CHAT session hopped away from used to
/// surface the SAME banner, and "Keep working in background" would then call
/// `setActivityFromRoster` against a session `session.setActivity` refuses outright
/// (`ACTIVITY_MODE_REFUSAL`) — a refusal that landed in `rosterRefusals`, a dictionary only the
/// Background tab's OWN rows ever read, so the banner just cleared as if the click had worked. An
/// idle or non-participating departure has nothing to make sticky either way — the daemon's
/// auto-background (where it applies) already protects a genuinely running turn regardless of
/// whether this banner ever shows.
func hopAwayShouldPromptBackground(turnWasRunning: Bool, activity: String?) -> Bool {
    turnWasRunning && backgroundVerbOffered(activity: activity) != nil
}

/// What the prompt is about — just the departed session's id; the view looks its title up from the
/// shared directory (same "read fresh" convention as everywhere else in this file).
struct HopAwayPrompt: Equatable {
    let sessionId: String
}

// MARK: - cli-handoff T3: "Move to CLI" (PURE — the eligibility gate + directory resolution)

/// PURE: whether a row offers the "Move to CLI" affordance at all — row LOADED, code mode, not
/// archived (spec §1: code only; "Not on archived rows" — attach un-archives by design and this
/// action's name doesn't say that; resume in-app first). BOTH surfaces render off this ONE
/// function — the open-session toolbar action (`ShellSessionView`) and the landing row's
/// context-menu item (`ModeLandingView`) — the same one-gate discipline
/// `landingTabOffersRosterVerbs` established, so chat/cowork/dispatch/archived rows are absent on
/// both at once. `DispatchSurface` hosts `ShellSessionView` too; its singleton row's mode is
/// `"dispatch"`, so the gate keeps the toolbar action structurally absent there with no
/// surface-side special case.
///
/// Mode is FAIL-CLOSED on anything but nil-or-"code": this mirrors the CLI's `isCodeMode` — the
/// RESUME TARGET's gate (`packages/cli/src/session-mode.ts`, `(mode ?? "code") === "code"`; resume
/// refuses everything else) — NOT the sidebar's listing convention (`SessionMode(wire:)`, which
/// degrades unknown future modes to code for DISPLAY). Fix round 1: offering on a row the Terminal
/// will refuse is this affordance's worst failure shape — `open` exits 0 (the script's content is
/// opaque to it), the true move fires (the app steps aside AND drops its attachment), and the
/// resume then silently refuses: an orphaned session on a false-positive success. A `nil` row (not
/// yet in `directory.rows`) is never offered either: there is no wire `dirs` to resolve a
/// directory from, and a launch without one would be a guess.
func moveToCliOffered(row: SessionSummary?) -> Bool {
    guard let row else { return false }
    // Mirrors the CLI's isCodeMode — the resume target's gate, not the sidebar's listing convention.
    return (row.mode == nil || row.mode == "code") && row.activity != "archived"
}

/// PURE: the directory the handoff's Terminal opens in — the WIRE row's `dirs[0]` (the primary by
/// position, pre-designated for exactly this — `packages/core/src/sessions/dirs.ts`), the SAME
/// source the working-folders chip reads (`dirsChipLabel(currentSidebarSessionSummary?.dirs)`).
/// NEVER the row's `cwd`: that field is the daemon's list-time ALIAS of `dirs[0]?.path`, an echo,
/// not an independent fact (`SessionSummary.dirs`'s own doc). Workdir-less (`dirs == []` — a real
/// state) and a dirs-less row both fall back to `$HOME` (spec §1's "$HOME fallback").
func handoffDirectory(row: SessionSummary?) -> String {
    row?.dirs?.first?.path ?? NSHomeDirectory()
}

/// PURE: the visible-failure copy per `HandoffError` case — each sentence carries its payload
/// (the path that was missing/unwritable, `open`'s exit code), because the alert built on it can
/// only ever be as informative as this string (honesty-of-affordance).
func handoffFailureMessage(_ error: HandoffError) -> String {
    switch error {
    case .cliMissing(let path):
        return "The bundled CLI is missing (looked in \(path)). Reinstall Norma to restore it."
    case .scriptWriteFailed(let path):
        return "Couldn't write the launch script at \(path)."
    case .openFailed(let code):
        return "Terminal wouldn't open (open exited \(code))."
    }
}

// MARK: - editor-product T3: the editor runtime's two decisions (PURE)

/// PURE: which session a panel reveal should have an editor ready for — **only a session with real
/// working directories**.
///
/// **wave-8 item 2 (predicate unify): DERIVES from `editorTabSessionRoots` (`PanelEditorTab.swift`)
/// rather than re-reading `dirs` itself.** The two used to be a byte-identical hand-copy of the same
/// three-way read off the WIRE row's `dirs` (never `cwd` — that field is the daemon's list-time ALIAS
/// of `dirs[0]?.path`, an echo rather than an independent fact, `SessionSummary.dirs`'s own doc and
/// `handoffDirectory`'s): `nil` means the daemon populated no set at all (chat/dispatch have no
/// working-directory concept), `[]` means a genuinely workdir-less session, and a degenerate
/// `[{path: ""}]` means a row whose one entry carries no real path. That duplication is exactly the
/// shape that drifted once already — fix-round-1 caught THIS predicate regressed to `!dirs.isEmpty`
/// alone while `editorTabSessionRoots` stayed correct — so one spelling remains now; see that
/// function's own doc for the full reasoning behind each case. **All three non-`.present` answers
/// still get no editor**, because the Files tree and every door that opens a code tab are scoped to
/// those roots, and an editor with no root to reach is a hidden Chromium nobody can ever put a file
/// in.
///
/// A row that is not in `rows` yet (the create-then-navigate race — `attachFresh`'s own one-shot
/// read carries the same caveat) also gets nothing: pre-warming is an optimisation, and guessing a
/// session has directories is how you spend 150 MB on a chat. `editorTabSessionRoots` answers
/// `.unknown` for exactly that row, which is not `.present` either, so the guard below still refuses
/// it.
func editorPrewarmTarget(sessionId: String?, rows: [SessionSummary]) -> String? {
    guard let sessionId, editorTabSessionRoots(sessionId: sessionId, rows: rows) == .present else {
        return nil
    }
    return sessionId
}

/// PURE: **may the shell release a session's editor when it leaves that session?**
///
/// Only when nothing in it is unsaved. This is deliberately NOT the plan's literal "teardown on
/// detach", and the spec is the authority for the difference: "dirty state does NOT survive an app
/// restart — unsaved edits are lost **only if the app quits with dirty tabs**, and quit warns if any
/// exist". A detach is not a quit. It is ⌘W, a click on another app's window, or navigating to the
/// dashboard — doors with no warning attached to any of them — and tearing the runtime down there
/// would destroy the user's unsaved buffers silently at every one of them, which is the exact
/// failure T10's quit gate exists to prevent.
///
/// Releasing a CLEAN runtime costs nothing that is not rebuilt on demand: a restored code tab
/// re-reads its file on first activation (the spec's reattach rule), so what is lost is a browser
/// that will be re-created, not state that cannot be.
func editorRuntimeReleasedOnDeparture(dirtyModels: Int) -> Bool {
    dirtyModels == 0
}

/// Office Stage B Task 3: **the office mirror of the decision immediately above — same question, same
/// answer, a separate function rather than a shared one.** The two runtime kinds happen to reduce to
/// the identical arithmetic (`count == 0`) today, but they are facts about different things (open
/// Monaco models vs. open LOK documents), tested independently, exactly the way `officeDocumentIsDirty`
/// stays a separate function from `editorTabIsDirty` rather than a shared predicate parameterized over
/// a state type (`PanelDocumentTab.swift`'s own header states that precedent). `releaseOfficeRuntimeIfClean`
/// is this function's one caller — see that method's own doc for why Stage A's identical-looking
/// "always release" gate was never actually THIS rule until now: Stage A's document tabs were view-only,
/// so `dirtyDocuments` could never be anything but 0, and the always/clean-only distinction was
/// unobservable. Office Stage B's real edit surface (T2/T2b: `documents[path].dirty`, LOK-driven) is
/// what makes the two rules finally diverge in practice, and this is where that divergence lands.
func officeRuntimeReleasedOnDeparture(dirtyDocuments: Int) -> Bool {
    dirtyDocuments == 0
}

// MARK: - The live harness behind an open session

/// One live attachment: a pinned `SessionFeed` (its own `NormaClient`/socket — a full harness, the
/// spec's "harness-per-window", here "harness-per-shell"), the `SessionModel` it pumps into, and the
/// `FieldStateAdapter` the hosted `WindowContentView` renders.
///
/// A class, not a struct: identity is the point. A HOP keeps this exact object (same socket, same
/// adapter, the transcript replaced by `SessionFeed.repin`'s reset+replay), while a hide DESTROYS it
/// — and those two are precisely the policy table's two different rows.
@MainActor
final class ShellSessionAttachment {
    let feed: SessionFeed
    let session: SessionModel
    let adapter: FieldStateAdapter
    /// The `feed.start()` task, held so a detach can CANCEL it — `SessionFeed.start()`'s initial
    /// connect-backoff loop exits only on `Task.isCancelled` (the same fix `DetachedWindowController`
    /// carries: a hidden shell whose daemon never came up must leave nothing spinning).
    var feedTask: Task<Void, Never>?

    init(feed: SessionFeed, session: SessionModel, adapter: FieldStateAdapter) {
        self.feed = feed
        self.session = session
        self.adapter = adapter
    }
}

// MARK: - The third host

/// app-shell T3: the shell's session host — the THIRD host of the shared `WindowContentView`
/// (after the orb's morph window and every detached window), and the owner of spec §1's attachment
/// policy.
///
/// **It is a harness, not a view model.** Attaching means opening a real socket and pumping a real
/// session; the wiring below (submit/steer, the three respond callbacks, policy/model/effort/dirs)
/// is deliberately the same shape `DetachedWindowController` carries, because it is the same
/// contract: every closure reads `attachedSessionId` FRESH at call time rather than capturing an id,
/// so a hop re-targets them all synchronously (the exact correctness fix that file documents).
///
/// **Why a fresh harness rather than the orb's.** `AppModel`'s own feed is `followFocus` and
/// dispatch-only (`AppModel.refocus`'s mode gate) — the shell shows code and chat sessions too, and
/// borrowing that connection would either break the orb's focus or silently refuse. `makeFeed` is
/// `AppModel.makeDetachedFeed` in production: the SAME transport factory and token (one Keychain
/// read, shared), a separate socket. That separateness is also what makes the policy table's last
/// row true — the shell's attachment is its own, so a detached window closing is never the last
/// detach for a session the shell is showing.
@MainActor
final class ShellSessionHost: ObservableObject {
    /// Mints a pinned harness for a session, or `nil` when one cannot be spawned (no daemon token —
    /// `AppModel.makeDetachedFeed`'s own refusal). Injected so tests drive a scripted transport.
    typealias FeedFactory = (String) -> (feed: SessionFeed, session: SessionModel)?

    /// The session the shell is SHOWING. Survives a hide; `nil` whenever the shell is on a landing
    /// surface, the dashboard, or has never opened a session.
    @Published private(set) var selection: String?

    /// The session this host's harness is ATTACHED to — `nil` whenever the shell is detached. Kept
    /// beside `attachment` (rather than derived from it) because it must flip SYNCHRONOUSLY on a
    /// hop, ahead of the attach round trip, for every live-reading callback below.
    @Published private(set) var attachedSessionId: String?

    /// The live harness, or `nil` while detached. `attachment == nil ⇔ attachedSessionId == nil`.
    @Published private(set) var attachment: ShellSessionAttachment?

    /// The shell window's on-screen state, fed by `AppWindowController` (see `setShellVisible`).
    private(set) var shellVisible = false

    /// The app's ONE session directory — the same instance the shell's sidebar, the landing lists
    /// and the hosted view's work column all read.
    let directory: SessionDirectory

    private let makeFeed: FeedFactory

    /// The window an `NSOpenPanel`/confirm alert attaches to (the working-folders chip's two doors).
    /// AppKit belongs to the window controller, so this is injected by it; `nil` in tests, where the
    /// panel is undrivable anyway — the same seam `DetachedWindowController` gets for free by owning
    /// its own window.
    var presentingWindow: (() -> NSWindow?)?

    /// app-shell T4: the landing's ROSTER client — `AppModel.client`, production (the app's own
    /// ALWAYS-CONNECTED "orb" harness), reused rather than minted per action. `session.interrupt`/
    /// `session.setActivity`/`session.create` are all bare-sessionId (or session-less) RPCs that
    /// never require attaching — unlike `makeFeed` above, which mints a PINNED, ATTACHING harness.
    /// That distinction is load-bearing here, not stylistic: a landing row acts on sessions the
    /// shell is NOT showing, and routing a roster verb through an attach would (for an archived row)
    /// trigger the exact un-archive-by-attaching T3's carried ruling forbids ("the Archived tab's
    /// click resumes BY ATTACH... do NOT also write setActivity(nil) — a double write"). Riding the
    /// same always-open connection the orb's own focus-follow feed uses is safe because these RPCs
    /// never touch that connection's OWN attachment state (only `session.attach`/`NormaClient.close`
    /// do) — multiplexed over one socket like every other request the client already sends.
    /// `nil` (additive, defaulted) in every test that doesn't drive a roster verb or the create flow.
    private let managementClient: NormaClient?

    /// app-shell T4: per-session in-flight/refusal bookkeeping for roster verbs issued from a
    /// LANDING list — keyed by sessionId, unlike `attachment.adapter`'s single-session fields
    /// (`activityChangeInFlight`/`activityRefusal`), because a landing can have several rows'
    /// actions outstanding at once. Read by `ModeLandingView`; written only by the two methods below.
    @Published private(set) var rosterActionInFlight: Set<String> = []
    /// A refusal is published VERBATIM (`set-activity.ts` writes one sentence per rule) — the exact
    /// same discipline `ShellSessionHost.applyActivity`/`WindowContentView`'s header affordance keep,
    /// just keyed per-row instead of per-attachment.
    @Published private(set) var rosterRefusals: [String: String] = [:]

    /// working-directories T8's create-time folder sheet, hoisted here so the landing's "New" button
    /// gets the SAME picker `DetachedWindowController.newSession()` opens rather than a second
    /// implementation of the sheet-retain-and-complete dance. Held for its lifetime, dropped in its
    /// own completion — nothing else retains a sheet controller.
    private var dirPickerSheet: WorkingDirPickerSheetController?

    /// app-shell T4: the hop-away "keep working?" prompt (spec §1's moment, T3 review as-m9) — set
    /// by `hop(to:)`/`detachCurrent()` the instant they leave a session whose turn was running
    /// (`hopAwayShouldPromptBackground`), read by `ShellRootView` so it renders regardless of which
    /// destination the shell is now showing. A NEW departure simply replaces whatever prompt was
    /// already up — there is only ever one "session I just left" worth asking about.
    @Published private(set) var hopAwayPrompt: HopAwayPrompt?

    /// app-shell T8: the ATTACHED session's current output files (`$OUTDIR`'s convention, spec §3 —
    /// read directly, never via RPC). Refreshed SYNCHRONOUSLY on every attach/hop (`refreshOutputFiles`,
    /// no round trip needed — it's a local directory read) and kept live thereafter by
    /// `outputsWatcher`'s `onChange` for AS LONG AS this exact session stays attached. Empty for a
    /// chat/dispatch session by construction (`outputsBoxEligible` gates `refreshOutputFiles`/
    /// `applyOutputsChange` both) — `ShellSessionView` needs no mode check of its own, only
    /// `!outputFiles.isEmpty` (the pinned "collapsed when empty, never a hollow box" rule).
    @Published private(set) var outputFiles: [URL] = []

    /// app-shell T8: which output file the third panel (`FileViewer`) is showing, or `nil` when it's
    /// closed. WINDOW-OWNED (one shell, one viewer at a time) rather than per-attachment — cleared on
    /// every attach/hop/detach, the same "about the session it was about" discipline `hop(to:)`
    /// already keeps for `dirsRefusal`/`activityRefusal` below.
    @Published private(set) var openOutputFile: URL?

    /// app-shell T8: the app-lifetime FSEvents watcher (`AppDelegate.boot()`'s one instance,
    /// injected — `nil` in every test that doesn't drive a live-update pin). `init` COMPOSES onto
    /// whatever `onChange` already holds rather than replacing it — see `OutputsWatcher.onChange`'s
    /// own doc comment for why a second consumer (T9) must do the same.
    private let outputsWatcher: OutputsWatcher?

    /// panel-shell T9: the panel's session-keyed tab state, OWNED here rather than by
    /// `ShellRootView` (Task 8 left that placement for this task to ratify — REJECTED: this host is
    /// constructed in `AppDelegate.summonAppWindow`, before `ShellRootView` even exists, and it is
    /// `attachFresh`/`hop` below that know synchronously, at the exact right moment, which session
    /// just became current — a private `@StateObject` on a child view has no way to be reached from
    /// a controller object that predates it. `ShellRootView` reads `host?.panelStore` instead of
    /// minting its own. `let`, not `@Published`: this store's own IDENTITY never changes across the
    /// host's lifetime — only its INTERNAL `@Published tabs`/`activeTabId` do, and `ShellPanel`
    /// observes those directly, exactly the `let directory: SessionDirectory` precedent just above.
    let panelStore = PanelStore()

    /// panel-shell T12 follow-up (advisor review, post-commit self-check): the in-flight guard
    /// `openPanelTab`'s auto-create branch needs — the SAME double-send race
    /// `sendFirstChatMessage`'s own `newChatCreate != .creating` guard closes
    /// (`testDoubleSendWhileCreateInFlightYieldsExactlyOneCreate`), reproduced here because
    /// `attachedSessionId` only flips once the FIRST create's ack completes the navigate → attach
    /// chain — so two rapid "+" clicks with nothing attached would otherwise each see
    /// `attachedSessionId == nil` and mint their own session. Worse here than in chat: the orphaned
    /// extra session carries a `panel_tab_opened` event (Requirement 2, this same task), so
    /// `SessionStore.emptySessionIds` never reaps it — permanent litter, not a 10-minute one. A
    /// plain `Bool`, not `@Published`: nothing renders off it (this is a re-entrancy lock, not
    /// UI state — the button itself stays visually unchanged, exactly like the composer during a
    /// chat create; only a rapid SECOND click silently no-ops).
    private var panelAutoCreateInFlight = false

    /// IMP-1 fix (final whole-branch review, "the fourth door"): backs the `directory.$rows`
    /// subscription below — the ONE Combine wire this host holds, so its lifetime is this host's
    /// own (no separate teardown needed; `AnyCancellable.cancel()` fires on deinit).
    private var cancellables = Set<AnyCancellable>()

    init(directory: SessionDirectory, makeFeed: @escaping FeedFactory, managementClient: NormaClient? = nil,
         outputsWatcher: OutputsWatcher? = nil) {
        self.directory = directory
        self.makeFeed = makeFeed
        self.managementClient = managementClient
        self.outputsWatcher = outputsWatcher
        let previousOnChange = outputsWatcher?.onChange
        outputsWatcher?.onChange = { [weak self] sessionId, files in
            previousOnChange?(sessionId, files)
            self?.applyOutputsChange(sessionId: sessionId, files: files)
        }
        // IMP-1 fix: see `reconcileIsChatSession`'s own doc comment for the race this closes.
        // Fires once synchronously on subscribe (Combine's `@Published` replays the current
        // value) — a harmless no-op call, since `attachment` is always nil this early in `init`.
        directory.$rows
            .sink { [weak self] rows in self?.reconcileIsChatSession(rows: rows) }
            .store(in: &cancellables)
        // editor-product Task 5 (fix round 1) / Task 7: the panel's own published slice IS the
        // signal for "which code AND files tabs are on screen" — see
        // `prunePanelTabModelsOnSessionChange`. Subscribed rather than called from
        // `switchSession`/`detach`'s six sites, so a future seventh cannot forget it. Fires once on
        // subscribe with the empty state, which prunes nothing.
        panelStore.$tabs
            .sink { [weak self] tabs in self?.prunePanelTabModelsOnSessionChange(shownTabs: tabs) }
            .store(in: &cancellables)
    }

    /// office-plumbing Task 5: releases `officeEventsFanOutTask` — see that property's own doc for
    /// why an uncancelled `Task` iterating a never-finished `AsyncStream` would otherwise outlive
    /// this host entirely, strongly holding `officeHelperSupervisor` (and, transitively, whatever it
    /// pins alive) forever. Every other resource this host owns already tears down on its own
    /// (`cancellables`' `AnyCancellable`s cancel themselves on deinit; `officeRuntimes`/
    /// `editorRuntimes` are plain dictionaries of objects nothing else references once this host is
    /// gone) — this is the one exception, because a bare `Task` has no such auto-cancel behavior.
    deinit {
        officeEventsFanOutTask?.cancel()
    }

    // MARK: - T4: the landing's roster verbs (bare RPCs — see `managementClient`'s doc for why these
    // never go through `makeFeed`'s attaching harness)

    /// Roster "Stop" — `session.interrupt`, verbatim the kit's own wrapper. No refusal vocabulary of
    /// its own (the daemon just answers `wasRunning`), so only in-flight is tracked; a successful
    /// call refreshes the directory since interrupting a running turn changes its derived activity.
    func interruptFromRoster(_ sessionId: String) {
        guard let client = managementClient else { return }
        rosterActionInFlight.insert(sessionId)
        Task { @MainActor [weak self] in
            guard let self else { return }
            _ = try? await client.interrupt(sessionId: sessionId)
            await self.directory.refresh()
            self.rosterActionInFlight.remove(sessionId)
        }
    }

    /// Roster background⇄clear/archive — `session.setActivity` for a row this shell is not
    /// necessarily attached to. `target` is the wire vocabulary verbatim (`"background"` /
    /// `"unbackground"` / `"archived"`), same contract as `ShellSessionHost.applyActivity`'s
    /// single-session twin. A refusal (e.g. "stop or background it first" for an Archive attempt on
    /// a still-running background session) is published VERBATIM, keyed to this row only — it never
    /// touches another row's state.
    func setActivityFromRoster(_ sessionId: String, target: String?) {
        guard let client = managementClient else { return }
        rosterActionInFlight.insert(sessionId)
        rosterRefusals[sessionId] = nil
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                _ = try await client.setActivity(sessionId: sessionId, activity: target)
                await self.directory.refresh()
            } catch let error as RpcError {
                self.rosterRefusals[sessionId] = error.message
            } catch {
                self.rosterRefusals[sessionId] = "couldn't reach the daemon — try again"
            }
            self.rosterActionInFlight.remove(sessionId)
        }
    }

    // MARK: - panel-shell T8/T9/T15: the panel's tab-strip mutation RPCs (bare, session-targeted)
    //
    // Same `managementClient` reasoning as the roster verbs just above: `panel.openTab`/`closeTab`/
    // `activateTab` all take `sessionId` directly, and the daemon appends straight to that
    // session's hub (`hub.append(sessionId, …)`, `ipc/server.ts`) — the calling connection never
    // needs to be ATTACHED to it.
    //
    // **None of these apply anything locally, even though this host now holds `panelStore`
    // (T9).** `PanelStore.apply(_:)` is the ONE path that may ever change `tabs`/`activeTabId` (its
    // own doc comment, `PanelStore.swift`), and it is fed EXCLUSIVELY by the live pump — the
    // `onEvent` hook `attachFresh` wires below, never by these three. They fire the RPC and stop;
    // the resulting `panel_tab_opened`/`closed`/`activated` event reaches `panelStore` (and so the
    // strip) live, through that hook — this is what makes the round trip "tap → daemon → strip
    // updates" rather than an optimistic local mutation racing the daemon's own answer. panel-shell
    // T15 is the ONE exception: a bound-but-unattached session has no live harness to pump FROM at
    // all, so `openPanelTabForNewChatPage`/`closePanelTab`/`activatePanelTab` below explicitly
    // `refreshPanelTabs` after firing, rather than waiting on a pump that will never arrive.

    /// panel-shell T15: which session `closePanelTab`/`activatePanelTab` act on — the ATTACHED
    /// session if there is one (T8/T9's original target: "a tap on the strip the user is CURRENTLY
    /// LOOKING AT"), else the new-chat page's BOUND session (`newChatBoundSessionId`,
    /// `openPanelTabForNewChatPage` below) if the page has one. `nil` when neither — the pre-T15
    /// "nothing to act on" no-op is unchanged for that case
    /// (`testActivateAndCloseTabControlsAreNoOpsWithNoAttachedSession`).
    ///
    /// This is what makes closing/activating the bound session's tab LIVE while un-navigated —
    /// before this task `closePanelTab` guarded on `attachedSessionId` alone, so the strip's "×"
    /// silently no-opped on an un-navigated new-chat page (Requirement 4's own naming of this exact
    /// line). `openPanelTab` itself does NOT use this: it is reached from every OTHER landing's
    /// auto-create too (`ShellPanel`'s "+" only routes to the bound-aware door on `.newChat`
    /// specifically), and widening its target would let a stale binding from an abandoned `.newChat`
    /// visit silently redirect an unrelated landing's "+" — see `openPanelTab`'s own doc for the
    /// fork.
    private var panelTargetSessionId: String? {
        attachedSessionId ?? newChatBoundSessionId
    }

    /// panel-cef Task 6b: the same target, readable from outside.
    ///
    /// Exposed — unlike `panelTargetSessionId`, which stays private — because the web tab's
    /// navigation reporter must CAPTURE the session when its model is wired rather than read it
    /// when a page finishes loading. A user who hops sessions mid-load would otherwise have the
    /// report filed against whatever session had become current by then, cross-posting one
    /// session's browsing into another's permanent log.
    var panelSessionId: String? { panelTargetSessionId }

    /// panel-cef Task 6b: `panel.reportNavigation` — **the RPC's first caller since Plan A defined
    /// it.** A committed top-level navigation is a FACT that only the app can witness (CEF fired
    /// it), which is why this method reports rather than requests and why no `panel.navigate`
    /// exists as its counterpart.
    ///
    /// `sessionId` is passed in, not read from `panelTargetSessionId` here — see `panelSessionId`
    /// just above for why that distinction is the whole point. Fire-and-forget like every other
    /// panel verb: the daemon appends, the event comes back through the live pump, and `PanelStore`
    /// applies it. Nothing is applied locally, so there is no optimistic second path to disagree
    /// with the daemon's own answer.
    ///
    /// **Everything upstream has already been filtered** (`PanelURLPolicy.persistableNavigation` —
    /// scheme allowlist, field caps), so a rejection here means the two sides have drifted. The
    /// `try?` is deliberate and matches every other panel call, but it does make that drift silent:
    /// the daemon-side pin test and the Swift-side pin test each name the other for this reason.
    func reportPanelNavigation(sessionId: String, tabId: String, url: String, title: String) {
        guard let client = managementClient else { return }
        Task {
            _ = try? await client.reportPanelNavigation(
                sessionId: sessionId, tabId: tabId, url: url, title: title)
        }
    }

    /// b2-agent-browser Task 3: `panel.commandResult` — **the answer to a `panel_command`**, and the
    /// second RPC on this connection whose producer arrived long after the method did.
    ///
    /// Rides `managementClient` for the same reason `reportPanelNavigation` does and one sharper
    /// one: an answer is owed even while the shell is mid-hop or has no attachment at all, and the
    /// attaching harness is exactly the thing that may have moved on. A bare, always-connected
    /// connection is what makes "the app always answers" reachable.
    ///
    /// **Fire-and-forget, and the `try?` is not a shrug here.** Every outcome this call can have is
    /// one the app can do nothing about: `{ok:true}` for an accepted result AND for one the daemon
    /// dropped as late (first result wins — the loser has no way to have known, which is why the
    /// method answers success either way), and NOT_FOUND only for a `commandId` the daemon has no
    /// record of, which means the pending entry died with a daemon restart. Retrying any of them
    /// would re-perform nothing and change nothing.
    ///
    /// The CALLER caps `result`/`imageBase64` before this is reached (`PanelCommandConsumer`'s
    /// pre-checks): an over-cap value is refused at `parseParams`, and that rejection would vanish
    /// into this `try?` — the command would then expire on its deadline with the app believing it
    /// had answered.
    func sendPanelCommandResult(sessionId: String, commandId: String, ok: Bool,
                                result: String?, imageBase64: String?) {
        guard let client = managementClient else { return }
        Task {
            _ = try? await client.sendPanelCommandResult(
                sessionId: sessionId, commandId: commandId, ok: ok,
                result: result, imageBase64: imageBase64)
        }
    }

    /// b2-agent-browser Task 3: **"a `panel_command` arrived"** — the hook `PanelCommandConsumer`
    /// is wired onto, in `AppDelegate`, beside the browser-lifecycle coordinator.
    ///
    /// A closure rather than a stored consumer, for the reason every other seam on this object is
    /// one: the shell must build and behave identically in the many tests that drive it with no
    /// browser runtime at all, and `nil` here is exactly that shell.
    ///
    /// See `PanelCommandConsumer`'s own doc for why the call site sits OUTSIDE the
    /// `attachedSessionId` filter that `panelStore.apply` sits inside.
    var onPanelCommand: ((SessionEvent.PanelCommand) -> Void)?

    /// diff-tabs Task 9: **"show the panel"** — the ONE channel from this object into the shell's
    /// panel presentation, registered by `ShellRootView` (`ShellSidebar.swift`).
    ///
    /// A closure for the same reason `onPanelCommand` above is one, plus a structural one: the
    /// requested panel mode is `@State` on `ShellRootView` (`presentation`), a view-local value with
    /// no channel back into it — that view holds `host` as a PLAIN, unobserved `var`, so publishing
    /// a flag here would drive nothing (its own doc records exactly that trap, and Task 8's review
    /// deleted a gate that had fallen into it). Registering a closure the view owns is the only
    /// direction that works.
    ///
    /// `nil` in every test and in every shell built without that view: `openDiffTab` still opens the
    /// tab, it simply cannot reveal a panel that nothing is drawing.
    var onRevealPanel: (() -> Void)?

    // MARK: - editor-product T3: the editor runtimes

    /// **One editor per session that has one** — the table, owned here for the same reason
    /// `panelStore` is: this object knows, synchronously and at the exact right moment, which session
    /// just became current, and it outlives every view that shows one.
    ///
    /// Sessions are ADDED by a panel reveal (`panelDidReveal`, dirs-only) and REMOVED by a departure
    /// that finds nothing unsaved, or by an explicit `teardownEditorRuntime`. Nothing else may touch
    /// it: an editor that appeared for a session nobody asked about is a hidden Chromium.
    private(set) var editorRuntimes: [String: EditorRuntime] = [:]

    /// How a runtime is made. The house seam (`makeFeed`, `handoffLaunch`): production builds the
    /// real thing, and tests substitute one whose CEF calls are recorded — without which every test
    /// that reveals a panel would construct a runtime wired to the real C surface.
    var makeEditorRuntime: (String) -> EditorRuntime = { EditorRuntime(sessionId: $0) }

    /// **The pre-warm hook: the panel just became visible.** Called by `ShellRootView` when the
    /// titlebar toggle reveals it, and by this object's own `revealPanel` for every door that opens
    /// a tab (`openDiffTab` today, T6's file door next).
    ///
    /// Idempotent all the way down — a second reveal finds the runtime already in the table, and
    /// `EditorRuntime.prewarm()` is itself a no-op past `idle`. Nothing happens at all for a session
    /// with no working directories (see `editorPrewarmTarget`), which includes every chat session and
    /// the new-chat page's own.
    ///
    /// **office live-gate Bug 2 (REVIEWED-DECISION OVERRIDE): office now joins this exact door.**
    /// T7 shipped office with no pre-warm of its own ("an open is its own pre-warm" — see
    /// `officeRuntime(for:)`'s and `openDocumentTab`'s own notes for the two sites this reverses) —
    /// the human live gate overruled that after measuring the first office click pay helper-spawn-
    /// plus-LOK-init cold, in full, synchronously with the click. `officeRuntime(for:)` reuses the
    /// SAME `sessionId` `editorPrewarmTarget` already gated above — a dirless/chat session returned
    /// `nil` and this function is already back out by the guard, so a document helper never boots for
    /// either, for free, with no second gate to maintain. Minting the table entry here is cheap (no
    /// process, no socket — `officeRuntime(for:)`'s own doc); `OfficeRuntime.prewarm()` is what
    /// actually asks the shared, app-wide helper process to boot, and is idempotent the same way the
    /// editor's own call is. **Resource note, disclosed**: unlike the editor's per-session CEF
    /// browser, the office helper is ONE process shared app-wide — the first dirs-session reveal in
    /// the app's lifetime boots it, and (per `OfficeHelperSupervisor`'s own persistent-connection
    /// design) it then stays resident until quit, whether or not that session — or any other — ever
    /// actually opens a document. The helper's OWN 120s idle-exit (`OfficeHelperServer
    /// .refreshIdleStateLocked`: zero documents AND zero connections) does not reclaim this: the
    /// supervisor holds its one connection open for the app's whole session once established (closed
    /// only by `.stop()`/a helper death — see that type's own F3 comment on why an open connection
    /// "permanently pins its connectionCount above zero"), so idle-exit was already unreachable during
    /// a live, connected session before this change too — it is the ORPHAN reaper for an unclean app
    /// exit, not a live-session memory reclaimer. Pre-warm does not change that lifecycle, only WHEN
    /// it begins; the pre-existing "stays hot once touched" cost simply now starts at reveal instead
    /// of at first real open, for every dirs session, not only ones that end up using office.
    func panelDidReveal() {
        guard let sessionId = editorPrewarmTarget(sessionId: panelTargetSessionId,
                                                  rows: directory.rows) else { return }
        editorRuntime(for: sessionId).prewarm()
        officeRuntime(for: sessionId).prewarm()
    }

    /// The session's runtime, minted on first use. Reached by the pre-warm above and (from T5) by
    /// the code tab that needs one — an open is its own pre-warm, so a runtime that was never
    /// revealed into existence still boots on the first file.
    @discardableResult
    func editorRuntime(for sessionId: String) -> EditorRuntime {
        if let existing = editorRuntimes[sessionId] { return existing }
        let runtime = makeEditorRuntime(sessionId)
        editorRuntimes[sessionId] = runtime
        return runtime
    }

    /// The session's runtime **if it already has one** — the read every surface should use, since
    /// asking merely to look would create one.
    func existingEditorRuntime(for sessionId: String) -> EditorRuntime? { editorRuntimes[sessionId] }

    /// Which session the editor/files-tab registries were last pruned for. `PanelStore` publishes
    /// `tabs` on every fold; only a change of SESSION means a whole set of this session's tabs
    /// stops being on screen.
    private var lastPanelTabModelPruneSessionId: String?

    /// **editor-product Task 5 (fix round 1) / Task 7: a departed session's code AND files tabs let
    /// go of their wires.**
    ///
    /// The bug this closes was measured rather than reasoned about, for the code tab (Task 5's own
    /// account): the tab-model registry kept a departed session's model alive (it is discarded only
    /// by `closePanelTab`), the model kept a live `SessionDirectory.$rows` subscription, and the 5 s
    /// `session.list` poll ALONE then minted a fresh runtime through `editorRuntimeForCodeTab` and
    /// re-read the file — a hidden Chromium for a session the user had left, which nothing releases,
    /// because a departure releases exactly once and it had already happened. The second harm is
    /// quieter and worse: the re-read happens ~5 s after departure, so a return an hour later shows a
    /// buffer that is stale against everything the agent wrote since — with T8's save behind it, that
    /// is a clobber.
    ///
    /// **Task 7 extends the SAME prune to `PanelFilesTabModel`, for the SAME class of bug.** There is
    /// no minting cost here (no browser, no CEF) — but its model also holds a live `$rows`
    /// subscription, and its `FileTreeModel` holds live `DispatchSource` watchers that keep firing
    /// disk reads for a session nobody is viewing, for as long as its Files tab stays open in a
    /// session the shell has left. `PanelFilesTabModel.deactivate()` already releases both; this is
    /// simply the second door that calls it, beside the tab's own explicit close
    /// (`PanelFilesTabModels.discard`). **Accepted trade, disclosed**: a hop away and back loses
    /// which folders were expanded — the tree re-reads its roots fresh on return, the same "a
    /// restored tab re-reads on first activation" rule the design spec states for code tabs.
    ///
    /// **Keyed on the session changing, not on every fold.** Opening or closing a tab within the
    /// current session republishes `tabs` too, and pruning there could drop the model of a tab that
    /// is on screen right now (the panel's `panel.list` seed publishes an empty slice for a beat on
    /// every attach). A session change is exactly the moment a whole set of this session's tabs
    /// stops being visible, and `except:` keeps whatever the new session already has cached, so a
    /// switch back is not a churn — for either registry.
    private func prunePanelTabModelsOnSessionChange(shownTabs: [PanelTab]) {
        guard panelStore.currentSessionId != lastPanelTabModelPruneSessionId else { return }
        lastPanelTabModelPruneSessionId = panelStore.currentSessionId
        let shownTabIds = Set(shownTabs.map(\.tabId))
        PanelEditorTabModels.discardAll(except: shownTabIds)
        PanelFilesTabModels.discardAll(except: shownTabIds)
        // office-plumbing Task 6: same class of bug, same fix — a `.document` tab's model holds a
        // live `OfficeRuntime.$state` subscription (and, while its canvas is mounted, a live tile
        // subscription on the shared helper); a departed session's tab must not keep either alive
        // just because its `PanelTab` row is still cached elsewhere.
        PanelDocumentTabModels.discardAll(except: shownTabIds)
    }

    /// **editor-product Task 5: the code tab's door — the one place a TAB may mint a runtime.**
    ///
    /// `nil` for a session with no working directories, which is the whole point of routing every
    /// code tab through here rather than through `editorRuntime(for:)` directly: "a dirless session
    /// never stands a hidden Chromium up" is then one rule in one place, enforceable by one test,
    /// instead of a check each of the tab's two slots is trusted to remember. The tab renders that
    /// `nil` as "This session has no working directory" (`EditorViewportState`).
    ///
    /// The gate is `editorTabSessionRoots`, NOT `editorPrewarmTarget`, for the reason that function's
    /// own doc gives: a row that has not arrived yet is `.unknown`, and the tab must wait rather than
    /// claim. `.unknown` mints nothing — an open is its own pre-warm, so the beat costs nothing but a
    /// spinner.
    func editorRuntimeForCodeTab(sessionId: String?) -> EditorRuntime? {
        guard let sessionId,
              editorTabSessionRoots(sessionId: sessionId, rows: directory.rows) == .present else {
            return nil
        }
        return editorRuntime(for: sessionId)
    }

    /// **editor-product Task 8: what the app's ⌘S menu item is looking at.**
    ///
    /// The panel's ACTIVE tab, if it is a code tab with a file (`editorSaveMenuTarget`). Read twice
    /// per use — once to decide whether the menu item is enabled, once when it fires — because both
    /// answers must describe the panel as it is at that instant, not as it was when a menu was built.
    var activeCodeTabPath: String? {
        return editorSaveMenuTarget(tabs: panelStore.tabs, activeTabId: panelStore.activeTabId)?.url
    }

    /// Save the active code tab. **Trigger 1 of 3**, and the only one that starts outside the panel:
    /// the menu item fires wherever the keyboard focus happens to be.
    ///
    /// `existingEditorRuntime`, never `editorRuntimeForCodeTab` — a save must not MINT an editor. A
    /// session with no runtime holds no unsaved buffer by construction, so there is nothing a fresh
    /// one could write.
    @discardableResult
    func saveActiveCodeTab() async -> SaveOutcome {
        guard let path = activeCodeTabPath,
              let sessionId = panelStore.currentSessionId,
              let runtime = existingEditorRuntime(for: sessionId) else {
            return .noModel
        }
        return await runtime.save(path)
    }

    /// **Office Stage B Task 2 — the document-tab leg beside the pair above.** Same shape,
    /// same reasoning, for `.document` tabs: the panel's active tab, if it is a document tab with a
    /// path (`officeSaveMenuTarget`, `PanelDocumentTab.swift`). Read twice per use for the identical
    /// reason `activeCodeTabPath` is — once to decide whether the menu item's document leg applies,
    /// once when it fires.
    var activeDocumentTabPath: String? {
        return officeSaveMenuTarget(tabs: panelStore.tabs, activeTabId: panelStore.activeTabId)?.url
    }

    /// Save the active document tab. **`existingOfficeRuntime`, never `officeRuntime(for:)`** — the
    /// identical reasoning `saveActiveCodeTab` states for its own runtime lookup: a save must not
    /// MINT a runtime. A session with no office runtime holds no open document by construction, so
    /// there is nothing to save. Fire-and-forget from the caller's own point of view — `OfficeRuntime
    /// .save`'s own contract (never sequence off this call returning; observe `state` instead).
    func saveActiveDocumentTab() {
        guard let path = activeDocumentTabPath,
              let sessionId = panelStore.currentSessionId,
              let runtime = existingOfficeRuntime(for: sessionId) else {
            return
        }
        runtime.save(path)
    }

    /// Release a session's editor outright, whatever it is holding. The door for a session that is
    /// genuinely going away (T10's quit path, an explicit close); the shell's own departures go
    /// through `releaseEditorRuntimeIfClean` below instead.
    func teardownEditorRuntime(for sessionId: String) {
        editorRuntimes.removeValue(forKey: sessionId)?.teardown()
    }

    /// The shell is leaving `sessionId` (a hop onto another session, a hide, a navigation away).
    /// Releases its editor only if nothing in it is unsaved — see `editorRuntimeReleasedOnDeparture`
    /// for why a detach is not a quit.
    private func releaseEditorRuntimeIfClean(for sessionId: String) {
        guard let runtime = editorRuntimes[sessionId] else { return }
        guard editorRuntimeReleasedOnDeparture(dirtyModels: runtime.stateSnapshot.dirtyCount) else {
            return
        }
        editorRuntimes.removeValue(forKey: sessionId)?.teardown()
    }

    // MARK: - office-plumbing Task 5: the office runtimes

    /// **One office runtime per session that has one.** Unlike `editorRuntimes` — where each entry
    /// owns its own CEF browser — the underlying resource here (`OfficeHelperSupervisor`) is
    /// APP-WIDE and shared across every entry in this table; see `officeHelperSupervisor`'s own doc
    /// for the fan-out this implies. Sessions are ADDED on first `officeRuntime(for:)` — called both
    /// by a document door's own `open` (still its own pre-warm for a session that mints a runtime
    /// this way first, the same "an open is its own prewarm" shape `editorRuntimeForCodeTab` already
    /// establishes) **and, as of the office live-gate's Bug 2, by `panelDidReveal`** for every
    /// dirs-having session, ahead of any click (see that method's own note — T7's original "office has
    /// no pre-warm door of its own" ruling is the one this overrides) — and REMOVED by a departure
    /// (`releaseOfficeRuntimeIfClean` — ALWAYS, see its own doc) or an explicit `teardownOfficeRuntime`.
    private(set) var officeRuntimes: [String: OfficeRuntime] = [:]

    /// The ONE app-wide helper supervisor, minted lazily on the FIRST `officeRuntime(for:)` call —
    /// never in `init`, because `ShellSessionHostTests` constructs many hosts per run and a
    /// supervisor built (with a fan-out `Task` started) for every one of them, whether or not that
    /// test ever touches office, would be pure waste. `nil` is also what lets the quit path
    /// (`teardownAllOfficeRuntimesAndStopHelper`) answer "nothing to kill" for a host that never
    /// touched office, without minting one just to ask.
    private(set) var officeHelperSupervisor: OfficeHelperSupervisor?

    /// How the supervisor is built. Test seam, mirroring `makeEditorRuntime`'s own reason:
    /// production spawns a real subprocess (`OfficeHelperSupervisor.Configuration.production()`),
    /// which nothing under XCTest may touch directly.
    var makeOfficeHelperSupervisor: () -> OfficeHelperSupervisor = {
        OfficeHelperSupervisor(configuration: .production())
    }

    /// Serializes every call any `OfficeRuntime` in this table makes into the shared supervisor's
    /// client — see `OfficeHelperRequestQueue`'s own header for why a raw, un-serialized call is not
    /// safe from more than one caller at a time. ONE instance per host, for the same reason there is
    /// only one supervisor per host: both describe the one shared connection.
    private let officeRequestQueue = OfficeHelperRequestQueue()

    /// How a runtime is made, GIVEN its driver — the host computes the driver (closing over
    /// `officeHelperSupervisor`/`officeRequestQueue`) and hands it in, rather than `OfficeRuntime`
    /// reaching for a shared global the way `EditorRuntime.CEFDriver.production` can (CEF's own
    /// global C functions): the office helper is owned per-host, not process-wide. Test seam:
    /// overridden to IGNORE the passed driver and substitute a recorder-backed one, exactly as
    /// `editorFactory().make` does for `makeEditorRuntime`.
    var makeOfficeRuntime: (String, OfficeRuntime.Driver) -> OfficeRuntime = { sessionId, driver in
        OfficeRuntime(sessionId: sessionId, driver: driver)
    }

    /// The consumer of `officeHelperSupervisor.events` — **the ONE reader** the stream's own header
    /// requires (`OfficeHelperSupervisor.events`: "still single-consumer... a real constraint for
    /// whichever future task is the first to actually need a second reader" — this is that task).
    /// Started once, alongside the supervisor itself, and fans every event out to every runtime
    /// currently in `officeRuntimes` via `broadcastOfficeHelperEvent`. Cancelled on `deinit` — an
    /// `AsyncStream` never finishes on its own here, so an uncancelled Task would iterate it forever,
    /// strongly holding the supervisor alive past this host's own lifetime.
    private var officeEventsFanOutTask: Task<Void, Never>?

    /// The session's office runtime, minted on first use. Mints the shared supervisor (and starts
    /// its fan-out) on the very first call across this host's whole lifetime, not per session.
    @discardableResult
    func officeRuntime(for sessionId: String) -> OfficeRuntime {
        if let existing = officeRuntimes[sessionId] { return existing }
        let supervisor = ensureOfficeHelperSupervisor()
        let runtime = makeOfficeRuntime(sessionId, officeDriver(for: supervisor))
        officeRuntimes[sessionId] = runtime
        return runtime
    }

    /// The session's office runtime **if it already has one** — mirrors `existingEditorRuntime`.
    func existingOfficeRuntime(for sessionId: String) -> OfficeRuntime? { officeRuntimes[sessionId] }

    private func ensureOfficeHelperSupervisor() -> OfficeHelperSupervisor {
        if let existing = officeHelperSupervisor { return existing }
        let supervisor = makeOfficeHelperSupervisor()
        officeHelperSupervisor = supervisor
        officeEventsFanOutTask = Task { [weak self] in
            for await event in supervisor.events {
                guard let self else { return }
                // Task 6: wire the tile push callbacks onto the FRESH client BEFORE fanning the
                // event out to every runtime — `broadcastOfficeHelperEvent` is what flushes queued
                // opens and unblocks the first `subscribeTiles` call, so wiring it after would race
                // the first tiles home.
                if case .ready = event {
                    self.wireOfficeTileCallbacks(on: supervisor)
                }
                self.broadcastOfficeHelperEvent(event)
            }
        }
        return supervisor
    }

    /// Task 6 — (re)points the shared client's tile push callbacks at this host's routing. Called
    /// every time a fresh client comes up: `OfficeHelperSupervisor.client` is re-minted per attempt
    /// (a new `OfficeHelperClient` on every successful `attemptOnce`), so a wiring done once at
    /// supervisor-creation time would go stale the moment the helper dies and relaunches.
    ///
    /// Fires from the reader task's own thread — no isolation promise
    /// (`OfficeWireConnection.onTile`'s own doc) — so every callback body hops to `@MainActor`
    /// before touching anything: `officeRuntimes`, `OfficeRuntime` and `OfficeTileStore` are all
    /// main-actor-isolated.
    private func wireOfficeTileCallbacks(on supervisor: OfficeHelperSupervisor) {
        // Office Stage B Task 2 — the dirty-tracking wire: `onDocumentEvent` was declared on
        // `OfficeHelperClient` since Task 3 (proxying `OfficeWireConnection.onDocumentEvent`) but
        // had never been pointed at anything — every push it could have delivered went nowhere.
        // Wired HERE, alongside `onTile`/`onTileFailed`/`onInvalidated`, for the identical reason
        // those three already are: `OfficeHelperSupervisor.client` is re-minted on every successful
        // `attemptOnce` (a fresh `OfficeHelperClient` per boot/relaunch), so a wiring done once at
        // supervisor-creation time would go stale the moment the helper dies and relaunches — this
        // method already exists specifically to be the ONE re-pointing site, called every time a
        // fresh client comes up (`.ready` in `ensureOfficeHelperSupervisor`'s fan-out loop).
        supervisor.client?.onDocumentEvent = { [weak self] docId, event in
            Task { @MainActor [weak self] in
                self?.officeRuntime(owning: docId)?.handle(documentEvent: event, docId: docId)
            }
        }
        supervisor.client?.onTile = { [weak self] _, docId, key, generation, _, _, pixels in
            // `width`/`height` (the two skipped params) are the wire's own claim, unvalidated by
            // the reader — obligation 8: `TileMath`/the `TileKey` itself are authoritative on
            // dimensions, never these two ints. Nothing downstream of this callback reads them.
            Task { @MainActor [weak self] in
                self?.officeRuntime(owning: docId)?.tileStore.ingest(
                    docId: docId, key: key, generation: generation, pixels: pixels)
            }
        }
        supervisor.client?.onTileFailed = { [weak self] _, docId, key, reason in
            Task { @MainActor [weak self] in
                self?.officeRuntime(owning: docId)?.tileStore.markFailed(docId: docId, key: key)
                NSLog("[ShellSessionHost] office tile failed doc=\(docId) key=\(key): \(reason)")
            }
        }
        supervisor.client?.onInvalidated = { [weak self] _, docId, keys in
            Task { @MainActor [weak self] in
                self?.officeRuntime(owning: docId)?.tileStore.invalidate(docId: docId, keys: keys)
            }
        }
    }

    /// The runtime that currently owns `docId` — a linear scan over `officeRuntimes.values`,
    /// deliberately not a maintained reverse index: `OfficeRuntimeState.documents` (keyed by path)
    /// is already the one source of truth for "which docId belongs to which runtime", and a second,
    /// hand-maintained map could only ever drift from it. Bounded by how many sessions have office
    /// documents open at once, times how many each holds — realistically single digits, cheap to
    /// scan on every tile push. `nil` for a docId whose runtime already closed it or tore down —
    /// the push is simply dropped, which is correct: nothing is showing it any more.
    func officeRuntime(owning docId: String) -> OfficeRuntime? {
        officeRuntimes.values.first { $0.stateSnapshot.documents.values.contains { $0.docId == docId } }
    }

    /// The fan-out itself, split out as a directly-callable, directly-testable method — the real
    /// `AsyncStream` loop above is deliberately NOT where the routing logic lives: nothing can
    /// inject events into a real supervisor's stream from a test, but this method needs no
    /// supervisor at all to drive with synthetic `OfficeHelperEvent`s against a table of spy
    /// runtimes (`ShellSessionHostTests`' office suite does exactly that).
    func broadcastOfficeHelperEvent(_ event: OfficeHelperEvent) {
        for runtime in officeRuntimes.values {
            runtime.handle(supervisorEvent: event)
        }
    }

    /// The production `OfficeRuntime.Driver` — every call routed through `officeRequestQueue` (the
    /// single-outstanding-request funnel), reaching whatever `officeHelperSupervisor.client` is live
    /// AT CALL TIME (never captured once — the client changes across a death+relaunch). `close`/
    /// `unsubscribeTiles` never throw to their caller (fire-and-forget everywhere `OfficeRuntime`
    /// uses them — see `OfficeRuntime.Driver`'s own doc) and simply no-op when there is no live
    /// client to ask — but a failure that DOES reach one of them (the helper died mid-request, a
    /// malformed reply) is still worth a line, the same "fire-and-forget is not the same as silent"
    /// discipline `EditorRuntime`'s own NSLog calls keep for its own no-caller-to-tell failures.
    private func officeDriver(for supervisor: OfficeHelperSupervisor) -> OfficeRuntime.Driver {
        let queue = officeRequestQueue
        return OfficeRuntime.Driver(
            helperState: { [weak supervisor] in supervisor?.state ?? .notStarted },
            startHelper: { [weak supervisor] in await supervisor?.start() },
            open: { [weak supervisor] docId, path in
                try await queue.run {
                    guard let client = supervisor?.client else {
                        throw OfficeHelperClientError.serverError(reason: "helper not connected")
                    }
                    return try await client.open(docId: docId, path: path)
                }
            },
            close: { [weak supervisor] docId in
                do {
                    try await queue.run {
                        guard let client = supervisor?.client else { return }
                        try await client.close(docId: docId)
                    }
                } catch {
                    NSLog("[ShellSessionHost] office close(\(docId)) failed: \(error)")
                }
            },
            // Office Stage B Task 2 — throws all the way back to `OfficeRuntime.performSave`
            // (unlike `close`/`unsubscribeTiles` above, which are fire-and-forget everywhere they're
            // used): a save's caller needs to know whether it worked, the same reason `open` throws.
            save: { [weak supervisor] docId in
                try await queue.run {
                    guard let client = supervisor?.client else {
                        throw OfficeHelperClientError.serverError(reason: "helper not connected")
                    }
                    return try await client.save(docId: docId)
                }
            },
            subscribeTiles: { [weak supervisor] docId, part, zoomPPT, viewportTwips in
                try await queue.run {
                    guard let client = supervisor?.client else {
                        throw OfficeHelperClientError.serverError(reason: "helper not connected")
                    }
                    return try await client.subscribeTiles(docId: docId, part: part, zoomPPT: zoomPPT,
                                                            viewportTwips: viewportTwips)
                }
            },
            unsubscribeTiles: { [weak supervisor] docId in
                do {
                    try await queue.run {
                        guard let client = supervisor?.client else { return }
                        try await client.unsubscribeTiles(docId: docId)
                    }
                } catch {
                    NSLog("[ShellSessionHost] office unsubscribeTiles(\(docId)) failed: \(error)")
                }
            },
            // office-plumbing Task 6: its own `queue.run`, never composed inside `subscribeTiles`'s
            // — see `OfficeRuntime.perform`'s `.subscribe` case for why the two must stay two
            // sequential awaits (obligation 2: nesting `officeRequestQueue.run` deadlocks every
            // later office call on this host, not just the nested pair).
            requestTiles: { [weak supervisor] docId, keys in
                try await queue.run {
                    guard let client = supervisor?.client else {
                        throw OfficeHelperClientError.serverError(reason: "helper not connected")
                    }
                    try await client.requestTiles(docId: docId, keys: keys)
                }
            },
            // Office Stage B Task 2b — the LIVE supervisor's own configured directory, never
            // `OfficeHelperSupervisor.Configuration.defaultStateDirectory()` read fresh: every live
            // test overrides `socketDirectory` with a scratch dir precisely so its own helper's
            // write fence and this driver's staging directory are one and the same place. Safe to
            // read eagerly (not `[weak supervisor]`-gated the way every closure above is) — see
            // `OfficeHelperSupervisor.statePath`'s own doc: fixed for the supervisor's whole
            // lifetime, and `supervisor` (a `let` parameter of this very method) already outlives
            // this call.
            stateDirectory: supervisor.statePath)
    }

    /// Release a session's office runtime outright, closing whatever documents it holds. **Never
    /// touches the shared helper PROCESS** — the helper is app-wide, and another session's
    /// documents may still be open on it; killing the process here would break them. The door for a
    /// session that is genuinely going away; the shell's own departures go through
    /// `releaseOfficeRuntimeIfClean` below instead, and the quit path's OWN process kill is
    /// `teardownAllOfficeRuntimesAndStopHelper`, a level above this.
    func teardownOfficeRuntime(for sessionId: String) {
        officeRuntimes.removeValue(forKey: sessionId)?.teardown()
    }

    /// The shell is leaving `sessionId`. **Office Stage B Task 3 — the Stage A exception this
    /// method's own comment foretold lands here: real clean-only, mirroring
    /// `releaseEditorRuntimeIfClean` exactly.** Editing is genuinely real now (T2/T2b: `documents
    /// [path].dirty`, driven by LOK's own `.uno:ModifiedStatus` callback), so a departure that
    /// unconditionally tore down a dirty office runtime would silently discard unsaved edits the
    /// instant the user hopped sessions or hid the shell — the exact failure `editorRuntimeReleasedOn
    /// Departure`'s own doc names for the editor side, now equally true here. A dirty runtime is
    /// RETAINED — not released, not torn down — so it survives to the quit gate (`AppDelegate
    /// .editorQuitGate`'s office leg) exactly as a dirty editor already does, and a later return to
    /// this same session finds its unsaved documents exactly as they were left.
    private func releaseOfficeRuntimeIfClean(for sessionId: String) {
        guard let runtime = officeRuntimes[sessionId] else { return }
        let dirtyDocuments = runtime.stateSnapshot.documents.values.filter(\.dirty).count
        guard officeRuntimeReleasedOnDeparture(dirtyDocuments: dirtyDocuments) else { return }
        officeRuntimes.removeValue(forKey: sessionId)?.teardown()
    }

    /// office-plumbing Task 5 — the quit path's process-kill door: walks every session's office
    /// runtime (closing its documents) THEN stops the shared helper process.
    ///
    /// **What "order matters" actually buys, corrected after T5 review (M1)**: the loop below only
    /// CREATES each runtime's close `Task` (fire-and-forget, spawned by `OfficeRuntime.teardown()` ->
    /// `performTeardown`) — it does not run it. Everything here is `@MainActor`-serial, so `stop()`
    /// below runs to completion, including nilling `client`, before any of those already-scheduled
    /// close `Task` bodies get a turn to execute. The guaranteed ordering is Task-CREATION order only.
    /// The practical consequence: on the quit path, every one of those close bodies later hits
    /// `officeDriver(for:)`'s `guard let client = supervisor?.client else { return }` and no-ops —
    /// **no close RPC frame ever reaches the wire here**. The `SIGKILL` inside `stop()` is what
    /// actually reclaims the process; this is not a clean close handshake racing a kill and winning.
    /// Any future "flush an edit on quit" door (Stage B) must NOT be built on the assumption this
    /// comment used to make — it needs its own await-before-kill, not this ordering.
    ///
    /// Tolerates a host that never touched office at all: `officeHelperSupervisor == nil` skips the
    /// kill outright (nothing was ever spawned), and an empty `officeRuntimes` table walks zero times.
    @discardableResult
    func teardownAllOfficeRuntimesAndStopHelper() -> Int {
        let sessionIds = Array(officeRuntimes.keys)
        for sessionId in sessionIds { teardownOfficeRuntime(for: sessionId) }
        officeHelperSupervisor?.stop()
        return sessionIds.count
    }

    /// **Show the panel** — and take the pre-warm with it. Every door that opens a tab goes through
    /// here rather than calling `onRevealPanel` directly, so the editor is warming while the daemon
    /// is still minting the tab.
    private func revealPanel() {
        onRevealPanel?()
        panelDidReveal()
    }

    /// The strip's `+`. Sends no `tabId` — the daemon mints one (`PanelOpenTabResult.tabId`),
    /// which this deliberately discards: nothing here needs it, and seeding it anywhere would be
    /// exactly the second, optimistic code path the design forbids.
    ///
    /// panel-shell T12 (bug found at the live gate, 2026-08-08): with NO attached session this used
    /// to return here, silently — no tab, no error, no explanation (`managementClient` is always
    /// wired once the app has booted at all; it was `attachedSessionId` that was nil). User ruling:
    /// auto-create — the button always works, so there is nothing left to disable (Task 8 tried a
    /// disabled/dim gate for exactly this case; its own review deleted it as non-reactive, and the
    /// EXPLANATION went with it — this fix restores the explanation by removing the silence).
    ///
    /// The create call mirrors `sendFirstChatMessage`'s own shape EXACTLY (scope global,
    /// approvalPolicy auto, mode chat, cwd ABSENT) — the app's one create-a-session-with-nothing-
    /// else-required mechanism, reused rather than duplicated. `mode: "code"` would need a cwd (or
    /// the explicit "no folder" default), dragging `WorkingDirPickerSheetController` into a `+`
    /// click — exactly the friction "the button always works" rules out.
    ///
    /// `onSessionCreated` fires ONLY on this auto-create path (never when a session was already
    /// attached — that path had nothing to create) — the caller uses it to navigate the shell onto
    /// the fresh session, the SAME `onCreated`-then-`nav.navigate(to:)` contract
    /// `sendFirstChatMessage` establishes (`NewChatPage.submit`'s call site). It fires
    /// UNCONDITIONALLY once create succeeds, even if the openTab call below fails (`try?`,
    /// unchanged from the attached-session branch) — a session that now exists should still be
    /// navigated to; the alternative (stranding the user on whatever they were looking at, with a
    /// real session sitting unopened) is worse than an occasionally-empty one.
    ///
    /// panel-shell T15: this is no longer the ONLY door onto "+ with no attached session" — on the
    /// new-chat page specifically, `ShellPanel`'s "+" calls `openPanelTabForNewChatPage` below
    /// instead, which BINDS rather than navigating (the page's draft must survive). This method is
    /// unchanged and still reached from every OTHER landing's auto-create (the dashboard, a mode
    /// list, dispatch) — navigating on create-then-open remains correct there, since none of those
    /// pages carry state a navigate would strand.
    ///
    /// **Ordering is deliberately create → open-tab (awaited) → `onSessionCreated`, NOT the literal
    /// create → attach → open-tab order the bug report describes.** `panel.openTab` is a bare
    /// `managementClient` RPC that never requires the session to be ATTACHED (this section's own
    /// doc above), so nothing here needs to wait for a harness. Opening the tab and awaiting its ack
    /// BEFORE calling `onSessionCreated` (which drives navigate → `apply` → `select` →
    /// `attachFresh`, and so `attachFresh`'s own `refreshPanelTabs`/`panel.list` fetch — Task 9)
    /// GUARANTEES that first snapshot already reflects the tab: both RPCs ride the SAME
    /// `managementClient` connection, so `panel.list` cannot even be SENT until `panel.openTab`'s
    /// response has already been received. Attaching first and letting the two race as independent
    /// in-flight calls on that one connection would leave a narrow window where the very first
    /// `panel.list` snapshot misses the tab — closed here by construction, not by luck.
    ///
    /// **Re-entrant while a create is already in flight → silent no-op** (`panelAutoCreateInFlight`,
    /// this type's own doc comment for why — mirrors `sendFirstChatMessage`'s `newChatCreate !=
    /// .creating` guard for the identical race, one click's worth of round trip wide). Without this,
    /// two rapid "+" clicks with nothing attached would each see `attachedSessionId == nil` and mint
    /// their own session — and the second one would be permanently immune to the empty-session
    /// reaper (Requirement 2 above), not just safe for 10 minutes.
    ///
    /// **`sessionId:` names the session EXPLICITLY, and is how a popup opens its tab in the session
    /// its own browser belongs to** (`PanelWebTabModel.openPopupAsTab`). It bypasses both branches
    /// below — the attached-session read and the auto-create — because neither is right for it: a
    /// popup arrives FROM a live browser, so the session it belongs to already exists and is known,
    /// while `attachedSessionId` is whatever the shell happens to be showing at the instant the page
    /// fired `window.open`. Nothing else passes it; every existing caller keeps today's behaviour by
    /// omitting it. The policy guard above still runs first, for this door as for the other two —
    /// which is the whole point of putting the popup through this method rather than beside it.
    ///
    /// **`diffId:` (diff-tabs Task 9) pairs with `kind: .diff` and nothing else** — the daemon's own
    /// `PanelOpenTabParams` refinement enforces that pairing server-side (methods.ts), so this door
    /// does no kind-conditional gating of its own, exactly the relationship `url` already has with
    /// `PanelURLPolicy` (app side is a courtesy, the daemon is the gate). It rides all three
    /// branches below rather than only the explicit-`sessionId` one `openDiffTab` uses: a signature
    /// that silently drops a caller's argument on two of its three paths is the same coincidence-
    /// not-invariant shape this file's other comments keep warning about.
    func openPanelTab(kind: PanelTabKind = .web, url: String? = nil, title: String? = nil,
                       diffId: String? = nil,
                       sessionId: String? = nil,
                       onSessionCreated: ((String) -> Void)? = nil) {
        guard let client = managementClient else { return }
        // panel-cef Task 6b review (Minor 6): the app's OTHER panel-url producer, and until now the
        // only one with no policy on it. Every call site passes `nil` today — which is not an
        // invariant, it is a coincidence, and this repo has already been bitten by exactly that
        // reasoning (`turn_completed.contextTokens`: a second producer emitting the old shape past
        // a consumer with no gate). Kind-conditional, mirroring the daemon's own `superRefine`.
        //
        // BEFORE the auto-create branch on purpose: with no session attached, a url the daemon
        // would refuse used to mint a session first and then fail its `panel.openTab` silently
        // (`try?`), leaving an orphan empty session behind. Refusing here costs nothing and cannot.
        guard PanelURLPolicy.mayOpenTab(kind: kind, url: url, title: title) else { return }
        let kindRaw = kind.rawValue
        // The explicit door — see this method's doc. A named session needs neither the attach read
        // nor the auto-create, and `onSessionCreated` is meaningless here (nothing is created).
        if let sessionId {
            Task { @MainActor [weak self] in
                _ = try? await client.openPanelTab(sessionId: sessionId, kind: kindRaw, url: url, title: title, diffId: diffId)
                // The re-fetch `closePanelTab` makes while unattached, for the identical reason and
                // generalised to "not the attached session" because this door can name ANY session
                // rather than only the attached-or-bound one: only the ATTACHED session has a live
                // event pump, so a tab opened in any other — the new-chat page's BOUND session is
                // the case that exists today, and it can host a browser — would sit in the daemon,
                // real and persisted, with the tab strip never showing it.
                if self?.attachedSessionId != sessionId { self?.refreshPanelTabs(for: sessionId) }
            }
            return
        }
        guard let attached = attachedSessionId else {
            guard !panelAutoCreateInFlight else { return }
            panelAutoCreateInFlight = true
            Task { @MainActor [weak self] in
                defer { self?.panelAutoCreateInFlight = false }
                guard let created = try? await client.createSession(scope: "global", approvalPolicy: "auto", mode: "chat") else { return }
                _ = try? await client.openPanelTab(sessionId: created.sessionId, kind: kindRaw, url: url, title: title, diffId: diffId)
                onSessionCreated?(created.sessionId)
            }
            return
        }
        Task { @MainActor in
            _ = try? await client.openPanelTab(sessionId: attached, kind: kindRaw, url: url, title: title, diffId: diffId)
        }
    }

    // MARK: - editor-product Task 10: the tab-close gate

    /// editor-product Task 10: the ONE door a tab's `×` goes through (`ShellPanel`'s `onCloseTab`) —
    /// `closePanelTab` below stays the unconditional MECHANISM, reached either straight through (a
    /// non-code, non-document tab, a code/document tab with no file, or one with no live runtime to
    /// ask) or after this gate resolves what a dirty `.code`/`.document` tab means.
    ///
    /// **T9's ⚠️, closed**: `dirtyCloseCandidate` below always resolves a code tab's `(path,
    /// runtime)` pair when one exists, clean or dirty, failed-open or mid-boot — so `runtime
    /// .close(path)` is reached on EVERY code-tab close from here on, not only the dirty ones. A
    /// clean tab (including a failed-open one, or one still queued) takes the silent branch: no
    /// sheet, `dirtyCloseAction(dirty: false, …)`'s own claim (`.close`, whatever `choice` would
    /// have been). That single call is what stops the leak `PanelEditorTabModels.discard` alone left
    /// standing — the page's model plus the watcher's two file descriptors, previously released only
    /// when the whole runtime eventually was.
    ///
    /// **Office Stage B Task 3 — the `.document` leg, deliberately shaped DIFFERENTLY from the
    /// `.code` leg just above it.** `.code`'s clean branch calls `runtime.close(path)` itself because
    /// editor-product Task 10 MOVED that close out of `closePanelTab` and into this gate (that
    /// method's own header explains why: a dirty buffer must never be silently discarded, so the
    /// close had to move behind a gate that can intervene first). Office never had that problem —
    /// `closePanelTab`'s own `.document` branch already calls `officeRuntime.close(path)` inline, and
    /// always has, since Stage A. Moving it here too would not fix anything and would create a SECOND
    /// door that closes an office document (this gate's `.close`/Discard path, AND `closePanelTab`'s
    /// own inline call the moment this method reaches it) — worse, it would silently stop closing the
    /// runtime document for the ONE caller that reaches `closePanelTab` directly, bypassing this gate
    /// entirely: `PanelDocumentTabModel.closeTab()`, the `.deleted`-conflict banner's own "Close"
    /// button (`PanelDocumentTab.swift`'s own header — a deliberate, already-reviewed choice from
    /// Task 2b, kept unchanged by this task). So this gate DECIDES ONLY (sheet or silent-fallthrough);
    /// `closePanelTab` stays the one and only closer for a `.document` tab's own open document, exactly
    /// as it already was — see that method's own updated comment for the seam this reasoning lives at.
    func requestCloseTab(_ tabId: String) {
        if let (path, runtime) = dirtyCloseCandidate(tabId: tabId) {
            guard editorTabIsDirty(state: runtime.stateSnapshot, path: path) else {
                runtime.close(path)
                closePanelTab(tabId)
                return
            }
            let basename = (path as NSString).lastPathComponent
            presentDirtyCloseSheet(basename, presentingWindow?()) { [weak self, weak runtime] choice in
                self?.resolveDirtyTabClose(tabId: tabId, path: path, runtime: runtime, choice: choice)
            }
            return
        }
        if let (path, runtime) = dirtyDocumentCloseCandidate(tabId: tabId) {
            guard officeDocumentIsDirty(state: runtime.stateSnapshot, path: path) else {
                closePanelTab(tabId) // closes the document itself, inline — see this method's own doc
                return
            }
            let basename = (path as NSString).lastPathComponent
            presentDirtyCloseSheet(basename, presentingWindow?()) { [weak self] choice in
                self?.resolveDirtyDocumentTabClose(tabId: tabId, choice: choice)
            }
            return
        }
        closePanelTab(tabId)
    }

    /// Which `(path, runtime)` the tab-close gate applies to — `nil` for everything it leaves to the
    /// UNCHANGED `closePanelTab` alone: a non-`.code` tab, a code tab with no file (unreachable
    /// through any shipped door, same posture `editorSaveMenuTarget` takes toward it), or a session
    /// with no live runtime (a dirless session never minted one — nothing there to close).
    private func dirtyCloseCandidate(tabId: String) -> (path: String, runtime: EditorRuntime)? {
        guard let tab = panelStore.tabs.first(where: { $0.tabId == tabId }),
              tab.kind == .code, let path = tab.url, !path.isEmpty,
              let sessionId = panelTargetSessionId,
              let runtime = existingEditorRuntime(for: sessionId) else {
            return nil
        }
        return (path, runtime)
    }

    /// Office Stage B Task 3 — `dirtyCloseCandidate`'s own `.document` mirror: `nil` for a non-
    /// `.document` tab, a document tab with no path (unreachable, `PanelDocumentTabModel.path`'s own
    /// doc), or a session with no live office runtime (a dirless/never-opened session never minted
    /// one — nothing there to be dirty).
    private func dirtyDocumentCloseCandidate(tabId: String) -> (path: String, runtime: OfficeRuntime)? {
        guard let tab = panelStore.tabs.first(where: { $0.tabId == tabId }),
              tab.kind == .document, let path = tab.url, !path.isEmpty,
              let sessionId = panelTargetSessionId,
              let runtime = existingOfficeRuntime(for: sessionId) else {
            return nil
        }
        return (path, runtime)
    }

    /// The sheet's answer, for a tab already established as dirty. `runtime` is weak-captured at the
    /// door above (`requestCloseTab`) and handed in already-resolved-or-nil: a sheet can sit on
    /// screen for as long as the user takes to answer it, and a session torn down (T10's own quit
    /// sweep is the only realistic way — a DIRTY runtime, the only kind that reaches this function,
    /// is never released by a clean-only departure) while it is up can arrive here `nil`.
    ///
    /// **The branches do not degrade uniformly on `nil` (task-10 review, fix round 1).** `.close`
    /// still calls `closePanelTab(tabId)` unconditionally — `runtime?.close(path)` merely no-ops —
    /// so the tab closes either way. `.awaitSave`'s `guard let runtime else { return }` returns
    /// BEFORE `closePanelTab`, so a nil runtime there instead leaves the tab open, silently. Judged
    /// effectively unreachable rather than fixed to match: landing in `.awaitSave` with a nil
    /// runtime needs the quit sweep to tear the runtime down in the exact window between Save being
    /// chosen and this Task's first hop.
    private func resolveDirtyTabClose(tabId: String, path: String, runtime: EditorRuntime?,
                                      choice: DirtyCloseChoice) {
        switch dirtyCloseAction(dirty: true, choice: choice) {
        case .close:
            runtime?.close(path)
            closePanelTab(tabId)
        case .keepOpen:
            break
        case .awaitSave:
            guard let runtime else { return }
            Task { @MainActor [weak self, weak runtime] in
                guard let runtime else { return }
                let outcome = await runtime.save(path)
                switch dirtyCloseActionAfterSave(outcome) {
                case .close:
                    runtime.close(path)
                    self?.closePanelTab(tabId)
                case .keepOpen, .awaitSave:
                    // `.failed`: T9's banner already carries the sentence — the tab simply stays.
                    break
                }
            }
        }
    }

    /// Office Stage B Task 3 — `resolveDirtyTabClose`'s own `.document` mirror, narrower by exactly
    /// the amount `requestCloseTab`'s own header explains: neither branch here ever calls
    /// `runtime.close(path)` directly — `.close` and a successful `.awaitSave` both route through
    /// `closePanelTab(tabId)`, which is the one place a `.document` tab's own open document has ever
    /// been closed, before or after this task. `runtime` is resolved FRESH here (`existingOfficeRuntime`),
    /// never weak-captured from the door above the way the editor's own `runtime` parameter is —
    /// `saveAndAwaitOutcome` is reached only inside the `.awaitSave` branch below, and re-asking through
    /// the host at fire time (rather than trusting a reference captured when the sheet was first shown)
    /// is the same "re-ask, never remember" discipline `PanelDocumentTabModel.resolvedRuntime`'s own
    /// header states for every other door on that object — a session that departed WHILE the sheet was
    /// up retains its dirty runtime (this task's own `releaseOfficeRuntimeIfClean` fix), so the runtime
    /// this resolves is the SAME one the sheet was originally shown for, not a fresh mint.
    private func resolveDirtyDocumentTabClose(tabId: String, choice: DirtyCloseChoice) {
        switch dirtyCloseAction(dirty: true, choice: choice) {
        case .close:
            closePanelTab(tabId)
        case .keepOpen:
            break
        case .awaitSave:
            guard let (path, runtime) = dirtyDocumentCloseCandidate(tabId: tabId) else { return }
            Task { @MainActor [weak self, weak runtime] in
                guard let runtime else { return }
                let outcome = await runtime.saveAndAwaitOutcome(path)
                switch dirtyCloseActionAfterSave(outcome) {
                case .close:
                    self?.closePanelTab(tabId)
                case .keepOpen, .awaitSave:
                    // `.failed`: the reducer's own `.saveFailed` arm already wrote the sentence into
                    // `documentBanners[path]` (`OfficeRuntimeReducer`'s own doc) — the tab simply stays,
                    // mirroring the editor's identical posture toward T9's banner.
                    break
                }
            }
        }
    }

    /// The tab-close sheet's own presentation — injected on the same terms as
    /// `presentHandoffFailure` above, so a test can script the answer without a real `NSAlert`.
    ///
    /// **Production falls back to `NSAlert.runModal()` when `presentingWindow` answers `nil`** —
    /// which is exactly what an un-wired test host's `presentingWindow` always answers. Any test that
    /// reaches the dirty branch of `requestCloseTab` WITHOUT overriding this first does not fail, it
    /// HANGS the suite on a headless modal waiting for a click nobody can make.
    var presentDirtyCloseSheet: (_ basename: String, _ window: NSWindow?,
                                 _ respond: @escaping (DirtyCloseChoice) -> Void) -> Void = {
        basename, window, respond in
        presentDirtyCloseSheetAlert(basename: basename, on: window, respond: respond)
    }

    /// A tab's `×`. panel-shell T15: targets `panelTargetSessionId` (attached, else the new-chat
    /// page's bound session) — see that property's own doc for why this specific widening is what
    /// makes closing a bound session's LAST tab live (the path Task 16's reaper eventually acts on).
    /// Re-fetches after the ack ONLY while unattached: an attached close is already reflected by the
    /// live pump (`attachFresh`'s `onEvent` hook), but a bound-but-unattached session has no such
    /// pump — without this the strip would show a stale, already-closed tab until the next real
    /// attach.
    ///
    /// **The unconditional mechanism, not the gate** (editor-product Task 10) — `requestCloseTab`
    /// above is the door every real close now goes through; this stays reachable directly for the
    /// callers that already know closing is safe (the resolved gate itself, and the `#if DEBUG` smoke
    /// harness in `ShellSidebar.swift`, which never opens a dirty code tab).
    func closePanelTab(_ tabId: String) {
        guard let client = managementClient, let sessionId = panelTargetSessionId else { return }
        // panel-cef Task 6b: the tab's chrome model goes with it. See `PanelWebTabModels.discard`
        // for the bounded case this does NOT cover (a tab closed by some other producer).
        PanelWebTabModels.discard(tabId: tabId)
        // diff-tabs Task 10: and the diff tab's. A tabId belongs to exactly one kind, so at most one
        // of these two ever finds anything — the pair is cheaper than asking which kind it was.
        // Heavier than the web case, which is why it is not merely tidy: a loaded diff model holds
        // the patch string (capped at 1 MiB) and its parsed rows for the life of the process.
        PanelDiffTabModels.discard(tabId: tabId)
        // editor-product Task 5: and the code tab's, which holds the session's editor state mirror,
        // two Combine subscriptions and T8's save closure. editor-product Task 10: the runtime's own
        // model/watcher are now closed by the GATE in front of this method (`requestCloseTab`), not
        // by this discard — see that method's own doc for why the two are separate calls.
        PanelEditorTabModels.discard(tabId: tabId)
        // editor-product Task 7: and the files tab's, which releases its tree's watchers and
        // Combine subscription — see `PanelFilesTabModels.discard`/`PanelFilesTabModel.deactivate`.
        PanelFilesTabModels.discard(tabId: tabId)
        // office-plumbing Task 6: and the document tab's — including the RUNTIME'S OWN open
        // document, closed right HERE.
        //
        // **Office Stage B Task 3 — the seam the two comments above this one (superseded, kept only
        // as the historical record of the question) were both waiting on, resolved: this stays the
        // ONE closer for a `.document` tab's own open document — it does NOT move behind
        // `requestCloseTab` the way `.code`'s own model/watcher close did in editor-product Task 10.**
        // That move does not apply here: `.code`'s close had to relocate INTO the gate because Task 10
        // found it was previously reached NOWHERE ELSE (a dirty buffer could be silently discarded by
        // `closePanelTab` alone, with no door for a sheet to intervene first) — this call site already
        // WAS that door, since Stage A, before dirty documents could even exist. Duplicating it into
        // the gate too would not add safety, only a second place that closes the same document: this
        // method's own header cites `PanelDocumentTabModel.closeTab()` (the `.deleted`-conflict
        // banner's own "Close" button) as the ONE caller that reaches this method WITHOUT ever passing
        // through the gate, and a close that stopped happening here would silently stop happening for
        // it. `requestCloseTab` (Task 3) now gates the `.document` leg exactly like `.code`'s — a
        // dirty document tab's `×` shows the sheet, and Discard/a successful Save both still end by
        // calling THIS method, unconditionally, so the actual close stays exactly where it already
        // was. `runtime.close(path)` evicts the doc's own tiles from `OfficeTileStore` too
        // (`OfficeRuntime.perform`'s `.helperClose` case) — closing the tab is what makes that
        // eviction correct: a closed document's cached pixels are dead weight for the rest of the
        // process's life.
        if let tab = panelStore.tabs.first(where: { $0.tabId == tabId }), tab.kind == .document,
           let path = tab.url, !path.isEmpty, let officeRuntime = existingOfficeRuntime(for: sessionId) {
            officeRuntime.close(path)
        }
        PanelDocumentTabModels.discard(tabId: tabId)
        Task { @MainActor [weak self] in
            _ = try? await client.closePanelTab(sessionId: sessionId, tabId: tabId)
            if self?.attachedSessionId == nil { self?.refreshPanelTabs(for: sessionId) }
        }
    }

    /// A tab click. Same `panelTargetSessionId` widening and unattached-refetch as `closePanelTab`
    /// just above, for the identical reason — leaving this one behind while fixing only the "×"
    /// would be a visible, confusing half-fix: a tab the panel shows while bound-but-unattached that
    /// silently refuses to respond to a click.
    ///
    /// diff-tabs Task 9: `sessionId:` names the session EXPLICITLY, exactly as `openPanelTab`'s own
    /// parameter of that name does and for the identical reason — the transcript chip's door
    /// (`openDiffTab`) acts on the session its transcript belongs to, which a hop between the click
    /// and this call would otherwise silently change out from under it. Omitted everywhere else, so
    /// the strip's own pills keep today's `panelTargetSessionId` behaviour untouched.
    ///
    /// The re-fetch guard generalises from "nothing is attached" to "the target is not the attached
    /// session" — the same widening `openPanelTab`'s explicit door already carries, and a NO-OP for
    /// every pre-existing caller by construction: without an explicit id the target IS
    /// `attachedSessionId` whenever one exists, so the two predicates agree on both branches.
    func activatePanelTab(_ tabId: String, sessionId explicitSessionId: String? = nil) {
        guard let client = managementClient,
              let sessionId = explicitSessionId ?? panelTargetSessionId else { return }
        Task { @MainActor [weak self] in
            _ = try? await client.activatePanelTab(sessionId: sessionId, tabId: tabId)
            if self?.attachedSessionId != sessionId { self?.refreshPanelTabs(for: sessionId) }
        }
    }

    /// diff-tabs Task 10: **the diff tab's READ door** — the one way `PanelDiffTabModel` reaches
    /// `panel.readDiff`, because `managementClient` is private to this type.
    ///
    /// Unlike every other verb in this section it is `async throws` and RETURNS: the caller is not
    /// firing an intent at the daemon, it is asking a question whose answer is the whole surface. So
    /// the failure cannot be swallowed here — a `try?` at this layer would collapse "the patch is
    /// gone" and "there is no daemon" into a silent empty result, and the model needs to reach its
    /// unavailable state (`PanelDiffUnavailable`, `PanelDiffTab.swift`). NormaKit's own wrapper takes
    /// the same posture for the same reason (`readPanelDiff`'s doc: "don't swallow it").
    ///
    /// Read-only, idempotent, and called at most once per tab — so it needs none of the re-fetch,
    /// hop or in-flight guards the mutating verbs above carry.
    func readPanelDiff(sessionId: String, diffId: String) async throws -> PanelDiffPayload {
        guard let client = managementClient else { throw PanelDiffUnavailable.noClient }
        return try await client.readPanelDiff(sessionId: sessionId, diffId: diffId)
    }

    /// diff-tabs Task 9: **the transcript chip's door — the first path from the transcript into the
    /// panel.**
    ///
    /// One frozen tab per edit (design spec §1), and clicking the same chip twice must land on the
    /// tab the first click opened rather than mint a second one — so the decision is dedupe-by-
    /// `diffId`, made by the pure `panelDiffTabAction` below against the session's own folded tab
    /// list, and performed through the SAME two doors the strip's pills already use
    /// (`activatePanelTab` / `openPanelTab`). No third path, and in particular no optimistic local
    /// mutation: the tab appears when the daemon's `panel_tab_opened` folds, exactly like every tab
    /// the "+" opens (`PanelStore`'s own doc comment).
    ///
    /// **The session is NAMED by the caller rather than read here**, and the caller reads it fresh
    /// at click time (`ShellSessionView`) — this file's standing rule. The transcript the chip lives
    /// in belongs to one specific session, and a hop between the click and this call must not file
    /// the tab into whatever the shell is showing by then; `openPanelTab`'s explicit-`sessionId`
    /// door exists for precisely this case (a popup used it first) and brings its `mayOpenTab` guard
    /// and its unattached re-fetch with it.
    ///
    /// **The panel is revealed on BOTH branches**, mirroring the "+"'s own behaviour: a chip click
    /// that activates an already-open tab behind a hidden panel would otherwise be a click that
    /// visibly does nothing. `onRevealPanel` is `nil`-safe (see its doc).
    ///
    /// KNOWN, disclosed rather than guarded: two clicks in the beat before the first mint's
    /// `panel_tab_opened` folds can open two tabs for one diff — the dedupe reads folded state and
    /// there is nothing on the wire that dedupes by `diffId`. Same class as the double-create race
    /// `panelAutoCreateInFlight` covers for the "+"; a guard here is deliberately out of this task's
    /// scope.
    func openDiffTab(_ ref: FileDiffRef, sessionId: String) {
        switch panelDiffTabAction(tabs: panelStore.allSessionTabStates[sessionId]?.tabs ?? [], ref: ref) {
        case .activate(let tabId):
            activatePanelTab(tabId, sessionId: sessionId)
        case .mint(let title):
            openPanelTab(kind: .diff, title: title, diffId: ref.diffId, sessionId: sessionId)
        }
        // editor-product T3: the reveal carries the editor pre-warm with it (`revealPanel`) — a user
        // who has just opened the panel on a session with working directories is a user about to be
        // one click from a file.
        revealPanel()
    }

    /// editor-product Task 6: **the file door — the SECOND thing in the transcript that opens a
    /// panel tab.** Mirrors `openDiffTab` immediately above wherever the two doors are alike.
    ///
    /// One tab per file: a second click on the same path — from the transcript again, or later from
    /// T7's tree — must land on the tab the first click opened, never mint a second, so the
    /// decision is dedupe-by-PATH (`panelFileTabAction` below), against the session's own folded
    /// tab list, through the SAME two doors the strip's pills and `openDiffTab` already use
    /// (`activatePanelTab` / `openPanelTab`). No optimistic local mutation: the tab appears when the
    /// daemon's `panel_tab_opened` folds, exactly like every other tab.
    ///
    /// **The session is NAMED by the caller**, read fresh at click time by the caller
    /// (`ShellSessionView`) — `openDiffTab`'s own standing rule, unchanged here: the transcript
    /// row's closure captures no id, so a hop between the click and this call cannot file the tab
    /// into the wrong session.
    ///
    /// **Relative paths resolve against the session's cwd FIRST** (`resolvedFilePath`, below),
    /// before the dedupe runs — a relative and an absolute spelling of the same file must collide
    /// on ONE tab, which only holds if both are compared as the same string by the time they reach
    /// `panelFileTabAction`. `directory.rows` is read fresh here, never through a cached row.
    ///
    /// **The retry obligation (Task 5's review, HANDOFFS, binding).** Activating an existing tab
    /// whose read PREVIOUSLY FAILED must not leave it stuck: `panelFileTabAction` decides WHETHER a
    /// retry is owed — pure, off the runtime's CURRENT `openFailures` (obligation 3, below) — and
    /// this door performs it by calling `EditorRuntime.openFile` again. That call is ALL a
    /// `retryOpenIfFailed` method would ever do: `openFile` dispatches `.openRequested`, whose
    /// reducer clears the failure entry for that path UNCONDITIONALLY before deciding what happens
    /// next (`EditorRuntimeReducer`'s own doc) — a fresh read, since an `openFailures` hit always
    /// means the runtime holds no model for the path. A second, differently-named method would only
    /// rename this same call, so the choice documented here is: inline through `openFile`, no new
    /// runtime method.
    ///
    /// **NEVER re-points an existing tab's `url`** (Task 5's review, Minor 2): the two branches
    /// below are `activate` (an unaltered daemon RPC) and `mint` (a brand new tab) — there is no
    /// third path that touches a tab already on screen.
    ///
    /// **The runtime is resolved through the host's table at the moment each read happens, never
    /// cached** (obligation 3). `existingEditorRuntime(for:)` — the non-minting read, since asking
    /// merely to look must not stand up a hidden Chromium — is called once to build the pure
    /// decision's `openFailures` input, and again, fresh, inside the retry's own `Task` (which may
    /// run on a later turn of the run loop than this call), so neither read can act on a runtime a
    /// departure-and-return has since replaced with a fresh one.
    ///
    /// **The panel is revealed on BOTH branches**, mirroring `openDiffTab` and the strip's "+" — an
    /// activate behind a hidden panel would be a click that visibly does nothing.
    ///
    /// **KNOWN, disclosed rather than guarded — two variants, both the diff door's own accepted
    /// class** (editor-product Task 7, landing the disclosure `openDiffTab`'s doc already carries
    /// for its own door): (1) the identical double-mint race — two clicks in the beat before the
    /// first mint's `panel_tab_opened` folds can open two tabs for the same file, because the dedupe
    /// reads folded state and nothing on the wire dedupes a `panel.openTab` call by path; (2) a
    /// variant unique to this door's retry — rapid clicks on a tab whose path currently sits in
    /// `openFailures` can each independently decide `retryOpen: true` (the read is fresh per click,
    /// and the first retry's own `Task` has not necessarily cleared the failure by the time a second
    /// click's decision runs), scheduling more than one redundant re-read of the same file. Both are
    /// bounded and recoverable — wasted work, never a wrong tab or a wrong file — and a guard for
    /// either is deliberately out of this task's scope, the same ruling `openDiffTab` already made
    /// for its own.
    func openFileTab(_ path: String, sessionId: String) {
        let row = directory.rows.first { $0.sessionId == sessionId }
        let absolutePath = resolvedFilePath(path, row: row)
        let tabs = panelStore.allSessionTabStates[sessionId]?.tabs ?? []
        let openFailures = Set((existingEditorRuntime(for: sessionId)?.stateSnapshot.openFailures
            ?? [:]).keys)
        switch panelFileTabAction(tabs: tabs, path: absolutePath, openFailures: openFailures) {
        case .activate(let tabId, let retryOpen):
            activatePanelTab(tabId, sessionId: sessionId)
            if retryOpen {
                Task { @MainActor [weak self] in
                    await self?.existingEditorRuntime(for: sessionId)?.openFile(absolutePath)
                }
            }
        case .mint(let title):
            openPanelTab(kind: .code, url: absolutePath, title: title, sessionId: sessionId)
        }
        // editor-product T3: the reveal carries the editor pre-warm with it — see `openDiffTab`'s
        // identical call, immediately above.
        revealPanel()
    }

    /// office-plumbing Task 6: **the document door — dedupe/activate semantics identical to
    /// `openFileTab`** (this task's own interface note), over `.document` tabs instead of `.code`.
    ///
    /// **No roots resolution needed for the OPEN itself** (unlike `.code`'s `editorRuntimeForCodeTab`
    /// gate) — `officeRuntime(for:)` mints unconditionally, the same "an open is its own pre-warm"
    /// shape `editorRuntimeForCodeTab`'s own doc names, minus the gate: minting an `OfficeRuntime`
    /// stands nothing heavy up by itself (no process, no socket — see that method's own doc), so
    /// there is no "this session has no working directory" question worth asking first. `path`
    /// STILL resolves through `resolvedFilePath` below, for the identical reason `openFileTab`
    /// does: a relative path from the tree must collide with an absolute click on the same file.
    ///
    /// The retry obligation is the same one `openFileTab` carries: an existing tab whose path
    /// currently sits in `openFailures` gets a fresh `open()` alongside the activate, so a retried
    /// file (permissions fixed, file re-created) does not keep showing a stale sentence forever.
    /// `OfficeRuntime.open` is NOT `async` (unlike `EditorRuntime.openFile`), so the retry needs no
    /// `Task` wrapper — it is fire-and-forget from this door's own perspective already.
    func openDocumentTab(_ path: String, sessionId: String) {
        let row = directory.rows.first { $0.sessionId == sessionId }
        let absolutePath = resolvedFilePath(path, row: row)
        let tabs = panelStore.allSessionTabStates[sessionId]?.tabs ?? []
        let openFailures = Set((existingOfficeRuntime(for: sessionId)?.stateSnapshot.openFailures
            ?? [:]).keys)
        switch panelDocumentTabAction(tabs: tabs, path: absolutePath, openFailures: openFailures) {
        case .activate(let tabId, let retryOpen):
            activatePanelTab(tabId, sessionId: sessionId)
            if retryOpen {
                existingOfficeRuntime(for: sessionId)?.open(absolutePath)
            }
        case .mint(let title):
            openPanelTab(kind: .document, url: absolutePath, title: title, sessionId: sessionId)
        }
        // Reveal the panel on both branches — an activate behind a hidden panel is a click that
        // visibly does nothing, mirroring `openFileTab`/`openDiffTab`'s identical calls.
        //
        // **REVIEWED-DECISION OVERRIDE (office live-gate Bug 2), superseding the paragraph this
        // replaced**: that paragraph used to say this call carries no office-specific pre-warm because
        // `panelDidReveal` only pre-warmed the EDITOR — T7's own ruling, "office has no pre-warm door
        // of its own" (`officeRuntime(for:)`'s doc, pre-this-task). The human live gate overruled it:
        // the FIRST office click measurably paid helper-spawn-plus-LOK-init cold, in full, on this
        // exact click, because nothing had ever asked the shared helper to be ready before now.
        // `panelDidReveal` now ALSO pre-warms office (`OfficeRuntime.prewarm()`, gated on the same
        // `editorPrewarmTarget` dirs check the editor's own pre-warm already used) — so by the time a
        // REPEAT click lands here, the helper is very likely already booting or ready; this call site
        // itself is unchanged, purely "show the panel," because the pre-warm lives one level up, at
        // the shared door every tab-opening call already goes through.
        revealPanel()
    }

    /// office-plumbing Task 7: **the ONE router both UI doors call — never `openFileTab`/
    /// `openDocumentTab` directly.** `panelTabKind(forFilePath:)` (`PanelEditorTab.swift`) decides
    /// `.code` vs `.document` off the extension alone; this method is nothing more than that decision
    /// plus a call to whichever door already exists for it. Both underlying doors keep their own full
    /// contract unchanged (dedupe/activate, the retry obligation, the panel reveal) — this adds no
    /// behavior of its own beyond the gate immediately below, which is deliberate: a router that ALSO
    /// reimplemented dedupe or retry would be exactly the "second spelling" `panelTabKind`'s own doc
    /// warns against, one layer up.
    ///
    /// **Callers**: `PanelFilesTabModel.openFile` (the tree) and the `onOpenFile` closure wired to
    /// `WindowContentView` below (the transcript). Neither calls `openFileTab`/`openDocumentTab`
    /// itself any more — `ToolRowTests.testChatContentNeverReachesForTheShellHost`'s banned-name list
    /// is extended this task to also name this method and `openDocumentTab`, so `ChatContent/` could
    /// not reach for either even by accident.
    ///
    /// **The fire-time belt** (`EditorTabTests.testShellPanelGatesTheFilesDoorAndWiresItToTheHosts
    /// RealDoor`'s own "render time AND fire time" precedent, restated here for a second door): the
    /// transcript's clickability render (`toolDetailIsClickablePath`) can go stale between paint and
    /// click — a session hop lands in the gap — so the `.document` branch re-checks the SAME
    /// `editorTabSessionRoots == .present` predicate the render-time gate used, against the CURRENT
    /// rows, immediately before acting, and silently refuses rather than falling back to `.code`:
    /// opening a binary office file as text would violate the policy `toolDetailIsClickablePath`'s
    /// own doc states ("office rides working directories" — gate 4), not honor a degraded version of
    /// it. The tree door is already gated structurally (its rows only exist at `.present`), so this
    /// belt costs it nothing and covers it — and any future caller — for free, rather than needing
    /// its own copy.
    func openFileOrDocumentTab(_ path: String, sessionId: String) {
        switch panelTabKind(forFilePath: path) {
        case .document:
            guard editorTabSessionRoots(sessionId: sessionId, rows: directory.rows) == .present else {
                return
            }
            openDocumentTab(path, sessionId: sessionId)
        default:
            openFileTab(path, sessionId: sessionId)
        }
    }

    /// editor-product Task 7: **the Files tab's door — dedupe by KIND alone, one per session.**
    /// Mirrors `openFileTab`/`openDiffTab` wherever the two-branch shape allows: dedupe-then-
    /// activate-or-mint through the SAME two RPCs (`activatePanelTab`/`openPanelTab`), the panel
    /// revealed on both branches (an activate behind a hidden panel is a click that does nothing).
    ///
    /// **No UI control calls this in this task.** It exists for tests today and for whatever later
    /// surface wants to open the tree (a strip "+"-adjacent affordance is explicitly out of this
    /// task's scope) — the panel strip's own "+" and the transcript's file doors are unchanged by
    /// this door's existence.
    func openFilesTab(sessionId: String) {
        switch panelFilesTabAction(tabs: panelStore.allSessionTabStates[sessionId]?.tabs ?? []) {
        case .activate(let tabId):
            activatePanelTab(tabId, sessionId: sessionId)
        case .mint:
            openPanelTab(kind: .files, title: "Files", sessionId: sessionId)
        }
        revealPanel()
    }

    /// panel-shell T15: the new-chat page's OWN "+" — creates (once) and BINDS rather than
    /// navigating (Requirement 1), so `NewChatPage`'s draft survives. `ShellPanel`'s "+" calls this
    /// instead of `openPanelTab` ONLY while `nav.destination == .newChat`; every other landing's "+"
    /// is unchanged (`openPanelTab`'s own doc, above).
    ///
    /// **Requirement 3 — a SECOND "+" while already bound opens a tab in the SAME session, never a
    /// second create.** This is the SEQUENTIAL counterpart to `panelAutoCreateInFlight`'s
    /// CONCURRENT guard below: that one only spans a single in-flight round trip, this spans the
    /// whole page visit, keyed by `newChatBoundSessionId` rather than a boolean.
    ///
    /// **Requirement 4 — a bound session that has been deleted underneath (cleaner/reaper) must not
    /// dead-end the button.** A silent no-op here would be exactly the "click that does nothing
    /// with no explanation" class Task 12 existed to kill. On failure, the stale binding is cleared
    /// and control falls through to an ordinary auto-create, as if this were the page's first "+".
    /// `try?` conflates "the session is gone" with "some other transient failure" — accepted, the
    /// same bounded trade `sendFirstChatMessage`'s own existence check makes (see its doc): on a
    /// local Unix-socket daemon a spurious retry is rare and merely wasteful, never data-losing.
    ///
    /// **Panel priming is EXPLICIT**, unlike the attached case: the page is deliberately NOT
    /// attaching, so `attachFresh`'s own `panelStore.switchSession`/`refreshPanelTabs` priming
    /// (Task 9) never runs for it. Guarded by `newChatPageEpoch`, captured before the create's async
    /// gap — mirroring `sendFirstChatMessage`'s own epoch guard: the session and its tab are still
    /// created for a departed page instance (a commitment, once the create is in flight — the same
    /// precedent), but the BINDING and the panel priming are skipped so a departed instance's
    /// browse-only session cannot hijack whatever the shell is showing by the time it lands.
    func openPanelTabForNewChatPage(kind: PanelTabKind = .web) {
        guard let client = managementClient else { return }
        let kindRaw = kind.rawValue
        if let bound = newChatBoundSessionId {
            Task { @MainActor [weak self] in
                guard let self else { return }
                if (try? await client.openPanelTab(sessionId: bound, kind: kindRaw)) != nil {
                    self.refreshPanelTabs(for: bound)
                } else {
                    self.newChatBoundSessionId = nil
                    self.autoCreateForNewChatPage(client: client, kindRaw: kindRaw)
                }
            }
            return
        }
        autoCreateForNewChatPage(client: client, kindRaw: kindRaw)
    }

    /// The auto-create half of `openPanelTabForNewChatPage` — split out so the "bound session is
    /// gone" fallback (above) and the "never bound yet" first click both run the identical sequence
    /// rather than two copies of it drifting apart.
    ///
    /// Whole-branch review Important 1: shares `sendFirstChatMessage`'s `newChatCreate` gate, not
    /// just `panelAutoCreateInFlight` — before this fix the two doors were independent booleans
    /// that never cross-checked, so "+" then Enter (or Enter then "+") while the OTHER's create was
    /// still in flight minted TWO sessions. The second one is worse litter than the pre-existing
    /// same-door race `panelAutoCreateInFlight` alone already covered: it carries an open tab (Task
    /// 12 R2 / Task 14 make that permanently immune to both auto-delete doors) with nothing ever
    /// bound to it, so it is also unreachable to close from the panel — an orphan, not merely a
    /// duplicate. Setting `newChatCreate = .creating` here reuses Task 2's own double-Enter ruling
    /// (`sendFirstChatMessage`'s existing `guard newChatCreate != .creating`) rather than inventing
    /// a second cross-door mechanism: a "+" now reads as an in-flight create to BOTH doors, and an
    /// Enter that lands mid-"+" no-ops with the text still in the composer, the same contract a
    /// double-Enter already has.
    private func autoCreateForNewChatPage(client: NormaClient, kindRaw: String) {
        guard !panelAutoCreateInFlight, newChatCreate != .creating else { return }
        panelAutoCreateInFlight = true
        newChatCreate = .creating
        let epoch = newChatPageEpoch
        // mac-chat-parity T7: this door MINTS THE PAGE'S SESSION, so it stamps the page's held
        // model/effort exactly as the send's own create does — captured before the async gap for the
        // same reason `epoch` is, and the same reason `sendFirstChatMessage` captures `bound`: a
        // fresh `.newChat` entry clearing the pick mid-flight must not change what this create sends.
        //
        // Disclosed rather than implied: stamping gives this `try?`-swallowed create a failure class
        // it did not have (a held pair the daemon refuses ⇒ a "+" that silently does nothing, the
        // class Requirement 4 above exists to kill). TWO guards make the pair legal by construction
        // rather than by luck, and fix round 1 added the second:
        //   * a TIER can never be held here — neither of the page's two modes offers one
        //     (`ComposerChrome.offersClientEffortTiers`, pinned);
        //   * a WIRE effort the held model does not accept is cleared the moment the model is picked
        //     or the catalogue lands (`reconcileHeldEffort`) — which is the reachable case, and it
        //     needs no provider change at all: pick an effort with no model pinned (the list comes
        //     from the catalogue's default model), then pick a model that does not accept it.
        // What remains is genuinely narrow: a catalogue that went stale between the last fetch and
        // this create (a `norma model` edit mid-visit), or a daemon that refuses what `sync.config`
        // advertised. Accepted; the send's own stamps carry the choice either way, and the send door
        // reports its refusal visibly (`newChatCreate = .failed`).
        let heldModel = newChatModel
        let heldEffort = newChatEffort
        Task { @MainActor [weak self] in
            defer {
                self?.panelAutoCreateInFlight = false
                // Reset only if still ours to reset — nothing else can write `.creating` while this
                // runs (the guard above makes the two doors mutually exclusive), but guarding on the
                // read rather than writing unconditionally costs nothing and matches this file's
                // existing caution around shared published state.
                if self?.newChatCreate == .creating { self?.newChatCreate = .idle }
            }
            guard let self, let created = try? await client.createSession(scope: "global", approvalPolicy: "auto", mode: "chat",
                                                                          model: heldModel, effort: heldEffort) else { return }
            _ = try? await client.openPanelTab(sessionId: created.sessionId, kind: kindRaw)
            guard epoch == self.newChatPageEpoch else { return } // a departed page instance: create/tab are a commitment, the bind and priming are not
            self.newChatBoundSessionId = created.sessionId
            self.panelStore.switchSession(to: created.sessionId)
            self.refreshPanelTabs(for: created.sessionId)
        }
    }

    /// panel-shell T9: `panel.list` on every attach/hop (`attachFresh`/`hop`, both call this right
    /// after `panelStore.switchSession(to:)`) — the instant-display seed, ahead of whatever the
    /// slower full replay eventually redelivers over the SAME attachment's own event pump. Rides
    /// `managementClient` like the three mutation RPCs above (bare, `sessionId`-targeted, no attach
    /// required) rather than the per-attachment `feed.client` — consistent with them, and available
    /// immediately rather than waiting on this specific attachment's own handshake.
    ///
    /// A daemon that doesn't answer (`try?`), or a response with an unparseable `kind` for one tab,
    /// degrades to "drop that tab" rather than a guessed default (`?? .web`) — mirroring how a
    /// REPLAYED event with an unrecognized `kind` fails its OWN whole-event decode and is silently
    /// skipped (`SessionEvent`'s per-event `try?` decode); a snapshot that disagreed with what
    /// replay would eventually show for the same wire value would be a second, diverging behavior
    /// for the identical case.
    private func refreshPanelTabs(for sessionId: String) {
        guard let client = managementClient else { return }
        Task { @MainActor [weak self] in
            guard let result = try? await client.listPanelTabs(sessionId: sessionId) else { return }
            self?.panelStore.applyFetchedSnapshot(sessionId: sessionId,
                                                  tabs: panelTabs(fromSnapshot: result.tabs),
                                                  activeTabId: result.activeTabId)
        }
    }

    // MARK: - T4: the landing's "New" button — the T8-wd create-time picker, reused

    /// AppKit half: opens the SAME `WorkingDirPickerSheetController` `DetachedWindowController.
    /// newSession()` does, on the shell's own window (`presentingWindow`). Undrivable from a unit
    /// test (a real sheet) — `createSession(with:onCreated:)` below is the TESTABLE seam its
    /// completion feeds, same split that file's own doc documents.
    ///
    /// `onCreated` — NOT a stored callback: this host has no single pinned session to re-target the
    /// way a detached window's `selectSession` does, so the CALLER (the landing) decides what
    /// "created" means. Every landing passes the same thing: navigate the shell onto the fresh id,
    /// which is what actually attaches it (`select`'s job, via `ShellNavigationModel.navigate`) —
    /// this method never attaches anything itself.
    func startNewSession(onCreated: @escaping (String) -> Void) {
        guard dirPickerSheet == nil, let window = presentingWindow?() else { return }
        let sheet = WorkingDirPickerSheetController(
            recents: recentWorkingDirs(directory.rows), host: window
        ) { [weak self] choice in
            self?.dirPickerSheet = nil
            guard let choice else { return } // cancelled: create nothing
            self?.createSession(with: choice, onCreated: onCreated)
        }
        dirPickerSheet = sheet
        sheet.present()
    }

    /// The wire half — `session.create` over `managementClient` (bare, no attach), same params
    /// `DetachedWindowController.startSession(with:)` sends (`scope: "global"`, `approvalPolicy:
    /// "auto"`, `cwd` omitted entirely for `.noFolder`).
    func createSession(with choice: WorkingDirChoice, onCreated: @escaping (String) -> Void) {
        guard let client = managementClient else { return }
        Task { @MainActor in
            guard let created = try? await client.createSession(scope: "global", cwd: choice.cwdParam, approvalPolicy: "auto") else { return }
            onCreated(created.sessionId)
        }
    }

    // MARK: - chatgpt-ui T2: the new-chat page's create-on-send flow (spec §2 — the ONE behavior change)

    /// The page's create state — `idle` doubles as "not currently creating" and "created" (the
    /// same no-second-source-of-truth posture as `DispatchResolution.idle`: once the shell
    /// navigates, the attachment is the answer). `failed` carries the VISIBLE sentence the page
    /// renders (RpcError verbatim — `set-activity.ts`-style one-sentence rules — or the
    /// daemon-unreachable fallback).
    enum NewChatCreateState: Equatable {
        case idle, creating, failed(String)
    }

    @Published private(set) var newChatCreate: NewChatCreateState = .idle

    /// panel-shell T10b: the new-chat page's own draft, hoisted here from `NewChatPage`'s old
    /// `@State private var draft` — that storage does not survive `ShellRootView`'s `if mode !=
    /// .maximized { detail }` teardown (`detail`, and `NewChatPage` inside it, is torn down and
    /// rebuilt on every panel maximize/un-maximize), mirroring exactly the reason
    /// `FieldStateAdapter.composerDraft` already lives off the view for the live composer. Cleared
    /// in `apply(destination:)`'s `.newChat` case, right alongside `newChatCreate`'s own reset —
    /// this is NOT a new behavior: `NewChatPage`'s own doc comment already ruled the draft "drops
    /// on navigate-away", and clearing it on a genuine fresh arrival (as opposed to the
    /// `.maximized` toggle, which never calls `apply` at all — see `PanelPresentation.
    /// toggleMaximized`'s call sites, both of which touch only the panel's own local `@State`)
    /// reproduces that exact contract rather than silently overturning it.
    @Published var newChatDraft: String = ""

    /// mac-chat-parity T7 (spec §5): the new-chat page's HELD model, and `newChatEffort` below its
    /// effort — the pick made before any session exists.
    ///
    /// **Held, then stamped at create** (the user's ruling) rather than create-then-set: the second
    /// leaves a window in which a turn fired immediately after the create resolves at the GLOBAL
    /// effort, and this page fires a turn the instant its session exists. Both of the page's birth
    /// doors stamp it (`sendFirstChatMessage`'s create and `autoCreateForNewChatPage`'s), and the
    /// bound-session REUSE branch — which creates nothing — applies it with `session.setModel`/
    /// `session.setEffort` instead.
    ///
    /// Lives here for the same reason `newChatDraft` does (the page is torn down on `.maximized`),
    /// and **resets with the draft** — not with the binding: a choice held for an abandoned visit
    /// leaking into the next one is the same standing-lie class Task 4 removed from the policy row.
    ///
    /// `private(set)`: only this host writes it, through `setNewChatModel`/`setNewChatEffort` below,
    /// so "who can change the held choice" has one answer.
    ///
    /// **Fix round 1 — a TRI-STATE per axis, not a flat `String?`.** The doubly-optional shape (and
    /// the reason for it) is `FieldStateAdapter.armProbation`'s, already in this codebase:
    ///   * `.none`        → the user has not touched this axis this visit.
    ///   * `.some(nil)`   → the user explicitly picked **Default**.
    ///   * `.some(value)` → the user picked a model / an effort.
    ///
    /// A flat `String?` cannot tell the first two apart, and on the reuse branch that difference is
    /// the whole behaviour: a "+" bound (and stamped) session that the user then re-points at Default
    /// must be CLEARED, while an axis nobody touched must not be written at all — that bound session
    /// is real, listed, and reachable by another client, so this page must never clear an override it
    /// did not set. Before this fix the re-pick was silently dropped: the chip read "Default model"
    /// while the session stayed pinned and the first turn ran at the old model.
    @Published private(set) var newChatModelPick: String??
    @Published private(set) var newChatEffortPick: String??

    /// The VALUE in force for each axis — what the chip shows, and what a create stamps. Flattens
    /// both "untouched" and "explicitly Default" to `nil`, which is right for both of those uses: at
    /// create, an absent key IS the default. Only the reuse branch needs the distinction.
    var newChatModel: String? { newChatModelPick ?? nil }
    var newChatEffort: String? { newChatEffortPick ?? nil }

    /// The page's own catalogue snapshot. The live composer reads the ATTACHED adapter's
    /// (`refreshModelCatalogue`); this page has no attachment, so the same `sync.config` is fetched
    /// on the management connection — the one the orb already reads it on
    /// (`AppModel.fetchModelCatalogue`) — and held here.
    ///
    /// NOT reset on a fresh page entry, deliberately, unlike the held pick beside it: this is a cache
    /// of daemon-wide configuration, not a user choice, so clearing it would only blank the chip's
    /// menu for one round trip on every entry.
    @Published private(set) var newChatCatalogue: SyncConfigSnapshot = .empty

    func setNewChatModel(_ model: String?) {
        newChatModelPick = .some(model)
        // Fix round 1: the held effort is validated against the MODEL, so changing the model can
        // invalidate it — see `reconcileHeldEffort`.
        reconcileHeldEffort()
    }

    func setNewChatEffort(_ effort: String?) { newChatEffortPick = .some(effort) }

    /// **Fix round 1: a held effort must stay legal for the model in force.**
    ///
    /// Wire efforts are validated PER MODEL (`assertEffortSelectable` → `effortsForModel`,
    /// `packages/core/src/ipc/server.ts:476-489`), and `session.create` runs that same check
    /// (`:1112`). So picking an effort while no model is pinned — the list is then built from the
    /// catalogue's default model — and afterwards picking a model that does not accept it leaves a
    /// pair the daemon refuses, with no provider change involved. The send door surfaces that as a
    /// visible `.failed`; the "+" door is `try?` and would surface it as a click that silently does
    /// nothing, the exact class `openPanelTabForNewChatPage`'s Requirement 4 exists to kill. Worse,
    /// `EffortMenuContent`'s `.unknown` branch would keep the now-illegal value visible AND checked.
    ///
    /// CLEARED, never clamped to a neighbour: "high" and "max" are not interchangeable, and silently
    /// substituting one for the other is a second standing lie in place of the first. Clearing falls
    /// back to the new model's own default, which is what the chip then shows.
    ///
    /// It becomes an explicit `.some(nil)` rather than `.none`: on a bound session the invalidated
    /// effort may ALREADY have been stamped by the "+" create, so the reuse branch must clear it
    /// there too. At create the two are indistinguishable anyway (both omit the key).
    ///
    /// **Never clears on silence.** An empty wire list means the daemon has told us nothing about
    /// this model (a BYOK endpoint that cannot enumerate, an unlisted model, or a catalogue not
    /// fetched yet) — the same "empty is a real answer and never a licence to guess" rule
    /// `effortPickerOptions` keeps, applied in the one direction that can destroy a user's pick.
    /// `offersTiers: false` is exact rather than conservative here: the new-chat page's two modes
    /// (chat, cowork) offer no tier, so a tier can never be the held value on this surface.
    private func reconcileHeldEffort() {
        guard case .some(.some(let effort)) = newChatEffortPick else { return }
        let offered = effortPickerOptions(catalogue: newChatCatalogue, model: newChatModel, offersTiers: false)
        guard !offered.wire.isEmpty, !offered.wire.contains(effort) else { return }
        newChatEffortPick = .some(nil)
    }

    /// The wiring `NewChatPage`'s composer chip runs on — the pre-session counterpart of
    /// `WindowContentView.composerModelControl`.
    ///
    /// Both in-flight flags are `false` and that is the honest value, not a stub: there is no RPC to
    /// be in flight. A pick here is a local write that lands with the create.
    var newChatModelControl: ComposerModelControl {
        ComposerModelControl(model: newChatModel,
                             effort: newChatEffort,
                             catalogue: newChatCatalogue,
                             modelChangeInFlight: false,
                             effortChangeInFlight: false,
                             onOpen: { [weak self] in self?.refreshNewChatCatalogue() },
                             onSetModel: { [weak self] in self?.setNewChatModel($0) },
                             onSetEffort: { [weak self] in self?.setNewChatEffort($0) })
    }

    /// The page chip's catalogue fetch — fired when the menu is about to be read, the same
    /// "a snapshot, refreshed exactly when it is about to be read" convention the header's two
    /// buttons follow. `try?`, same posture as `refreshModelCatalogue`: a hiccup leaves the previous
    /// snapshot in place rather than blanking the picker out from under the user.
    private func refreshNewChatCatalogue() {
        guard let client = managementClient else { return }
        Task { @MainActor [weak self] in
            guard let snapshot = try? await client.syncConfig() else { return }
            self?.newChatCatalogue = snapshot
            // Fix round 1: the catalogue arriving is the OTHER moment we learn enough to judge a
            // held effort (a pick made against an empty catalogue was never checked against
            // anything). Same one-way rule — see `reconcileHeldEffort`.
            self?.reconcileHeldEffort()
        }
    }

    /// panel-shell T15: the new-chat page's own BOUND session — set once `openPanelTabForNewChatPage`
    /// auto-creates, so the page can offer the panel a tab without navigating away (Requirement 1).
    /// Lives here for the SAME reason `newChatDraft` does, right above: `detail` (and `NewChatPage`
    /// inside it) is torn down on `.maximized` (Task 10b), so a binding kept in view `@State` would
    /// be lost exactly there. `private(set)`: only this host writes it (`openPanelTabForNewChatPage`,
    /// `sendFirstChatMessage`'s consume-on-send, `apply(destination:)`'s fresh-entry reset) — no view
    /// needs to set it, only to exist alongside `newChatDraft` for whatever the page shows.
    ///
    /// Cleared on a fresh `.newChat` arrival, the identical "starts clean on every entry" contract as
    /// `newChatDraft`/`newChatCreate` — a previous, abandoned visit's binding must never be silently
    /// adopted by a later one (`testApplyNewChatClearsAStaleBindingAndThePanelDisplayOnEveryEntry`).
    @Published private(set) var newChatBoundSessionId: String?

    /// The typed first messages, parked between each create's success and delivery on the created
    /// session's OWN attach (`deliverPendingFirstMessage` — fired from the pinned feed's
    /// post-attach `onConnected` on a fresh attach, and after `repin`'s attach on a hop;
    /// `SessionFeed.start()`'s pinned branch awaits the attach ack BEFORE firing `onConnected`,
    /// which is what makes create → attach → send hold in wire order with no sequencing here).
    ///
    /// T2 fix round 1 (review Important — the single-slot overwrite): a MAP keyed by sessionId,
    /// never a shared slot. Each `sendFirstChatMessage` invocation binds its payload to ITS OWN
    /// create's session identity end-to-end, so a later create can never touch an earlier
    /// payload. The old `.creating` block only spans the create round-trip — it lifts at the
    /// create ACK, before delivery (which waits for the attach on a second transport), so
    /// navigate-away → re-enter → re-send inside that beat is a PLAUSIBLE flow (the page shows no
    /// in-flight feedback yet — T3/T4 minor), and under the slot it silently dropped message A
    /// and orphaned its session empty. **Late delivery is a commitment**: a departed create's
    /// message delivers when THAT session's attach eventually lands — fresh attach or hop,
    /// whenever that is — never timeout-dropped.
    private var pendingFirstMessages: [String: String] = [:]

    /// T2 fix round 1: the page-instance epoch — bumped on EVERY `apply(destination:)` (each
    /// navigation is a new instance boundary; re-entering the page is a NEW instance).
    /// `sendFirstChatMessage` captures it at submit; a create whose epoch has gone stale by ack
    /// time belongs to a DEPARTED page instance: its message still parks (the commitment above)
    /// but `onCreated` — navigation — never fires. The departed session appears in Recents via
    /// the ordinary `session_created` → directory-refresh path and delivers quietly on its own
    /// eventual attach; only the CURRENT page instance's create yanks the shell onto the session.
    /// The same monotonic-token shape as `dispatchResolutionToken`, for the same race class.
    private var newChatPageEpoch = 0

    /// chatgpt-ui T2 (spec §2): the create-on-send flow — THE one `mode:"chat"` create site in
    /// the app (`AppDelegate.newChat()`'s eager create MOVED here; every New-chat door now only
    /// opens the page). Exactly ONE `session.create` (scope global, policy auto, `cwd` OMITTED —
    /// chat sessions carry no fs tools, the established B4 wire shape) rides the bare
    /// `managementClient`, never an attaching harness. On success the typed text is parked as the
    /// pending first message and `onCreated` fires (the page navigates the shell onto the fresh
    /// id) — navigation is what attaches (`apply` → `select` → `attachFresh`, the host's own
    /// separate harness), and the message sends AFTER that attach lands. The text is seeded into
    /// the attached composer until the send succeeds (`attachFresh`), so the hop into the live
    /// session never flashes an empty composer and a failed send never loses the keystrokes.
    ///
    /// The edge decisions (each disclosed in the T2 report):
    /// - **Double-send:** BLOCKED while a create is in flight — the second Enter no-ops; the text
    ///   is still in the page's composer, so nothing is lost and nothing doubles.
    /// - **Unreachable daemon:** VISIBLE failure, page-bound — `newChatCreate = .failed(…)` and
    ///   `onCreated` never fires, so the shell never navigates on failure.
    /// - **Create lands after the user navigated away:** lands QUIETLY — the session appears in
    ///   Recents and the parked message delivers on that session's own attach (fresh or hop);
    ///   only the CURRENT page instance's create navigates (the `newChatPageEpoch` gate below).
    ///   The send is still a commitment — it delivers whenever the session is next opened.
    ///
    /// panel-shell T15 (Requirement 2): if "+" already bound the page to a session
    /// (`newChatBoundSessionId`), reuse it instead of creating a second one — a second create would
    /// orphan the tab-holding original every send, and Task 12 R2 makes an orphan with an open tab
    /// permanently reaper-immune. Requirement 4: verify the bound session still exists FIRST, via
    /// `panel.list` (the same bare RPC `refreshPanelTabs` already rides) — the cleaner/reaper can
    /// have deleted a bound-but-unattached session out from under an idle page; a bound id that no
    /// longer resolves falls back to an ordinary create rather than sending into nothing. `try?`
    /// conflates "gone" with "some other transient failure" — accepted: on a local Unix-socket
    /// daemon that is a bounded, rare cost (an occasional redundant session), and the one thing this
    /// requirement forbids — losing the message outright — cannot happen either way.
    func sendFirstChatMessage(_ text: String, onCreated: @escaping (String) -> Void) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard newChatCreate != .creating else { return } // double-send: one create, ever
        guard let client = managementClient else {
            newChatCreate = .failed(newChatUnreachableMessage)
            return
        }
        newChatCreate = .creating
        let epoch = newChatPageEpoch // T2 fix round 1: which page instance this send belongs to
        // panel-shell T15: captured BEFORE the async gap, mirroring `epoch` just above — a bind
        // that lands WHILE this send is already in flight must not be adopted mid-flight, and a
        // fresh `.newChat` entry clearing the binding mid-flight must not un-bind a reuse already
        // under way.
        let bound = newChatBoundSessionId
        // mac-chat-parity T7: the held model/effort, captured at SUBMIT for the same reason `bound`
        // and `epoch` are — this send carries the choice the user had when they pressed Enter, and a
        // fresh page entry landing mid-flight neither adds to it nor takes it away.
        // Fix round 1: the PICKS (tri-states), not the flattened values — the reuse branch needs
        // "explicitly Default" and "untouched" told apart. Captured at submit for the same reason
        // `bound` and `epoch` are.
        let heldModel = newChatModelPick
        let heldEffort = newChatEffortPick
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let sessionId: String
                if let bound, (try? await client.listPanelTabs(sessionId: bound)) != nil {
                    sessionId = bound // verified to still exist — reuse it, no second create
                    // …but this branch CREATES NOTHING, so there is no create to carry the choice.
                    // The "+" may have stamped part of it already (whatever was picked before the
                    // click) and cannot have stamped what came after — including a re-pick of
                    // Default, which is a CLEAR of what it did stamp. `stampHeldSelection` settles
                    // every axis the user touched this visit, in either direction.
                    await self.stampHeldSelection(on: bound, model: heldModel, effort: heldEffort, client: client)
                } else {
                    // At create, an absent key IS the default — so an explicit Default and an
                    // untouched axis are the same wire shape here, and both flatten to `nil`.
                    let created = try await client.createSession(scope: "global", approvalPolicy: "auto", mode: "chat",
                                                                 model: heldModel ?? nil, effort: heldEffort ?? nil)
                    sessionId = created.sessionId
                }
                // The binding's job ends here either way — reused (about to attach) or abandoned
                // (confirmed gone/never set). Unconditional, matching `newChatCreate = .idle`
                // just below rather than an epoch guard: the same "a departed instance's create is
                // still allowed to settle" precedent that write already establishes.
                self.newChatBoundSessionId = nil
                // Parked BEFORE `onCreated`: the navigate inside it drives apply → select →
                // attachFresh SYNCHRONOUSLY, and attachFresh must already see the pending text
                // to seed the adapter's composer. Do not reorder. Keyed to THIS create's session
                // — a later create writes its own entry, never this one (fix round 1).
                self.pendingFirstMessages[sessionId] = trimmed
                self.newChatCreate = .idle
                // Navigation fires only for the CURRENT page instance's create (fix round 1):
                // a departed create delivers quietly — its session sits in Recents, its message
                // lands on that session's own eventual attach, and nothing yanks the user.
                if epoch == self.newChatPageEpoch {
                    onCreated(sessionId)
                }
            } catch let error as RpcError {
                self.newChatCreate = .failed(error.message)
            } catch {
                self.newChatCreate = .failed(newChatUnreachableMessage)
            }
        }
    }

    /// mac-chat-parity T7: apply a held model/effort to a session that ALREADY EXISTS — the
    /// bound-session reuse branch above, and only that branch. Every other path stamps at create.
    ///
    /// **MODEL FIRST, and that order is load-bearing.** `session.setEffort` validates the effort
    /// against the session's CURRENT model (`assertEffortSelectable`, `packages/core/src/ipc/
    /// server.ts:476-489`), so effort-first would validate the held effort against the daemon's
    /// default model and can refuse a pair that is perfectly legal once the model lands.
    ///
    /// **A refusal never blocks the send** (`try?`, deliberately): the user's message outranks the
    /// stamp. A dead Send button over a failed effort RPC is precisely the class this whole surface
    /// exists to remove — and the alternative (surfacing the refusal and holding the text) would
    /// trade a silent wrong-effort turn for a silent lost message, which is worse. The cost is
    /// bounded and visible: the turn runs at the session's existing selection, which the composer's
    /// chip goes on showing.
    ///
    /// **Fix round 1 — what "picked" means here, per axis.** The parameters are the tri-states
    /// (`newChatModelPick`/`newChatEffortPick`), and the rule is: an axis the user TOUCHED this visit
    /// is written, **including an explicit Default, which goes out as a literal `null` — the clear**;
    /// an axis they never touched is not written at all.
    ///
    /// Both halves matter, and the first is what this round fixes. A "+" that bound the session
    /// already STAMPED whatever was picked before it; re-picking Default afterwards used to send
    /// nothing, so the chip read "Default model" while the session stayed pinned and the first turn
    /// ran at the old model — the mirrored form of the wrong-selection window hold-and-stamp exists
    /// to close. The second half is the reason this is a tri-state rather than an unconditional
    /// null-send: that bound session is real, listed and reachable by another client (the same
    /// argument the sequencing pin rests on), so a page that never touched an axis must not clear
    /// what something else set on it.
    ///
    /// Awaited before the send, and pinned as sequencing rather than as end-state
    /// (`ShellSessionHostTests`): "no turn has fired on a session minted for a panel tab" is true of
    /// today's flows but is not structural — that session is real, listed, and reachable by any other
    /// client.
    private func stampHeldSelection(on sessionId: String, model: String??, effort: String??,
                                    client: NormaClient) async {
        if case .some(let model) = model { _ = try? await client.setModel(sessionId: sessionId, model: model) }
        if case .some(let effort) = effort { _ = try? await client.setEffort(sessionId: sessionId, effort: effort) }
    }

    /// The delivery half: fires on the pinned feed's post-attach `onConnected` for a FRESH
    /// attach, and after `repin`'s attach for a HOP (fix round 1 — a departed create's session is
    /// usually opened from Recents while the shell is attached elsewhere, which is a hop; an
    /// onConnected-only wiring would leave that message parked forever, breaking the late-delivery
    /// commitment). Sends over the ATTACHED harness — the daemon refuses `session.send` on a
    /// connection that hasn't attached (`ipc/server.ts`: "no send path around it"), which is
    /// exactly why this cannot ride the management client. Consumes ONLY this session's own map
    /// entry. On success the seeded composer clears — but only if it still holds the pending text
    /// verbatim, so a user already typing their SECOND message never has it eaten. On failure the
    /// draft stays: the text is visible in the composer, one Enter away from a retry — the same
    /// clear-only-on-success contract `submit` keeps.
    private func deliverPendingFirstMessage(for sessionId: String) {
        guard let text = pendingFirstMessages[sessionId],
              attachedSessionId == sessionId, let live = attachment else { return }
        pendingFirstMessages[sessionId] = nil
        let client = live.feed.client
        Task { @MainActor [weak self] in
            let ok = (try? await client.send(sessionId: sessionId, text: text)) != nil
            guard ok, let self, self.attachedSessionId == sessionId,
                  let adapter = self.attachment?.adapter, adapter.composerDraft == text else { return }
            adapter.composerDraft = ""
        }
    }

    // MARK: - The three doors into the policy

    /// Show a session (a recents row, a landing-list row, an "open in app" affordance).
    func select(_ sessionId: String) {
        if selection != sessionId { selection = sessionId }
        applyPolicy()
    }

    /// Show no session at all — a mode landing, the dashboard. Detaches.
    func deselect() {
        if selection != nil { selection = nil }
        applyPolicy()
    }

    /// The navigation seam: `ShellNavigationModel.onDestinationChange` routes every destination
    /// change here, so "which session is the shell showing" has exactly one source of truth (the
    /// destination) rather than two that can disagree.
    ///
    /// app-shell T5: `.mode(.dispatch)` is the ONE extension of that rule — the design's "the
    /// coordinator's sit-down surface" has no landing list to show instead (`session.dispatch` is a
    /// get-or-create of a SINGLETON, not a roster), so showing it IS showing a session, exactly like
    /// `.session(id)`, just with the id resolved here instead of arriving pre-known. Every other mode
    /// destination keeps the old rule (a landing, never a session).
    func apply(destination: ShellDestination) {
        newChatPageEpoch += 1 // T2 fix round 1: every navigation is a page-instance boundary
        // panel-shell T15: a bound-but-unattached session's tab was primed onto the panel MANUALLY
        // (`openPanelTabForNewChatPage`), never through a real attach — so unlike an attached
        // session's departure (already un-shown by `detachCurrent`'s own `panelStore.detach()`),
        // nothing else clears this one when the shell leaves `.newChat` without sending. Decision,
        // disclosed in the T15 report rather than implied by the task text: the panel shows the
        // CURRENT destination's tabs and nothing else — a bound-but-abandoned session's tab
        // disappears from view the instant the page is left, even though the session and its tab
        // persist durably in the daemon and stay reachable from Recents (Requirement 4 is what
        // keeps that reachable). Runs for EVERY destination, not just `.newChat`, because
        // `.mode`/`.dashboard` leave the shell just as unattached as `.newChat` does; harmless when
        // the destination turns out to be the bound session itself — `select` → `attachFresh`'s own
        // `switchSession`/`refreshPanelTabs` runs synchronously right after, in the same call
        // stack, so there is no visible flicker.
        //
        // Whole-branch review Minor 4: `newChatBoundSessionId` clears HERE too, not only in the
        // `.newChat` case below — the original version cleared the PANEL DISPLAY on every
        // unattached destination change but left the binding VARIABLE itself live-but-stale until
        // whatever later destination happened to be `.newChat`. Inert today only because the empty
        // panel (just cleared) leaves no `×`/click target to misdirect — a two-mechanism invariant
        // that a future path repopulating `panelStore.tabs` while unattached could silently break.
        // Clearing both together, in the one place that already knows "bound but no longer
        // attached", removes the second mechanism instead of relying on the first one alone.
        if newChatBoundSessionId != nil, attachedSessionId == nil {
            panelStore.detach()
            newChatBoundSessionId = nil
        }
        switch destination {
        case .session(let sessionId):
            dispatchResolutionToken += 1 // invalidate any dispatch resolution the shell moved on from
            dispatchResolution = .idle
            select(sessionId)
        case .mode(.dispatch):
            selectDispatch()
        case .newChat:
            // chatgpt-ui T2: the new-chat page shows NO session (spec §2 — nothing attaches, and
            // the wire pin says nothing is created either: arriving here issues zero RPCs). A
            // fresh entry clears a stale create failure — the page starts clean every time; an
            // in-flight create is NOT cancelled (its send is a commitment — see
            // `sendFirstChatMessage`'s own doc for the quiet-departed-landing decision).
            dispatchResolutionToken += 1
            dispatchResolution = .idle
            if newChatCreate != .creating { newChatCreate = .idle }
            // panel-shell T10b: same "starts clean on every entry" contract as `newChatCreate`
            // just above, now covering the draft too — see `newChatDraft`'s own doc for why this
            // is a preservation of the pre-existing "drops on navigate-away" ruling, not a new one.
            newChatDraft = ""
            // mac-chat-parity T7: the held model/effort follows the DRAFT, not the binding — a
            // choice made on an abandoned visit must never be silently adopted by the next one, the
            // same standing-lie class Task 4 removed from the policy row one surface over. (The
            // catalogue beside it deliberately survives: it is a cache of daemon-wide config, not a
            // choice — see `newChatCatalogue`.)
            newChatModelPick = nil
            newChatEffortPick = nil
            // panel-shell T15: `newChatBoundSessionId` needs NO reset here (unlike `newChatDraft`
            // just above) — the top-level guard above already clears it on every unattached
            // destination change, `.newChat` included (whole-branch review Minor 4). Kept out of
            // this case specifically so there is exactly one place that does it, not two that must
            // agree.
            deselect()
        default:
            dispatchResolutionToken += 1
            dispatchResolution = .idle
            deselect()
        }
    }

    // MARK: - T5: the dispatch surface's own door (`session.dispatch` — the singleton conversation)

    /// `DispatchSurface`'s resolving/failed-retry treatment — mirrors iOS's own three-state dance
    /// (`norma-ios/Norma/Code/DispatchModeView.swift`'s `idle`/`resolving`/`failed(retry)` over
    /// `AppNavModel.dispatchState`; there is no Mac gallery page for this moment, so the mirror is
    /// the shipped iOS BEHAVIOR, not a written page — a GALLERY EXTENSION POINT). `.idle` doubles as
    /// "not currently resolving" and "resolved" — once resolved, `attachedSessionId`/`attachment`
    /// are the live answer (the same "no second source of truth" posture `dispatchResolutionToken`
    /// itself follows), so a THIRD published "resolved" case would only be able to disagree with them.
    enum DispatchResolution: Equatable {
        case idle, resolving, failed
    }

    @Published private(set) var dispatchResolution: DispatchResolution = .idle

    /// Bumped on every entry into (or out of) dispatch resolution — an in-flight `session.dispatch`
    /// whose token has gone stale by the time it returns (the shell navigated elsewhere while it was
    /// in flight) must attach NOTHING and must not overwrite whatever state the shell moved on to.
    /// The exact "two doubles bracket the untested middle" race class this plan's own memory has hit
    /// before elsewhere in this app (T2's poll-vs-fresh-transient race is the same shape), closed here
    /// with the same tool: a monotonic token read back after the `await`.
    private var dispatchResolutionToken = 0

    /// `session.dispatch {}` (Phase 7): get-or-create the ONE permanent dispatch session, ridden over
    /// the bare `managementClient` — never `makeFeed`'s attaching harness (the roster verbs'/
    /// `createSession`'s own doors, same reasoning: this is a plain RPC, not an attach). The actual
    /// attach happens through the ordinary `select` door once the id comes back, so the existing
    /// attachment policy (hop/detach/re-show) governs the dispatch session exactly like any other —
    /// nothing about it is a special case past this one resolution step.
    ///
    /// No `managementClient` (every test that doesn't inject one) is the same silent no-op the roster
    /// verbs give that case — never reachable in production (`AppDelegate.summonAppWindow` always
    /// passes `model.client`, unconditionally, once the app has booted at all).
    private func selectDispatch() {
        dispatchResolutionToken += 1
        let token = dispatchResolutionToken
        guard let client = managementClient else {
            dispatchResolution = .idle
            deselect()
            return
        }
        dispatchResolution = .resolving
        Task { @MainActor [weak self] in
            guard let self else { return }
            guard let result = try? await client.dispatchSession() else {
                guard self.dispatchResolutionToken == token else { return } // moved on already
                self.dispatchResolution = .failed
                return
            }
            guard self.dispatchResolutionToken == token else { return } // moved on already
            self.dispatchResolution = .idle
            self.select(result.sessionId)
        }
    }

    /// The failed state's retry door (`DispatchSurface`'s "Try Again"). Safe unconditionally: the
    /// button that calls it only exists while the shell IS showing `.mode(.dispatch)` (the view
    /// itself is the guard), so simply re-running the same resolution is exactly right.
    func retryDispatchResolution() {
        selectDispatch()
    }

    /// browser-runtime T5: "the shell's visibility changed AND the attachment policy has already
    /// run for it." Fired at the end of `setShellVisible` — after `applyPolicy()`, never before,
    /// because a listener that reads `attachedSessionId`/`panelStore.currentSessionId` on the way IN
    /// would see the state the window is leaving rather than the one it just moved to. (That
    /// ordering is also why this is a closure and not a `@Published shellVisible`: `@Published`
    /// notifies in `willSet`, which is the wrong side of the policy.)
    ///
    /// The browser lifecycle needs it because spec §4's window-close rule is about the window, not
    /// the attachment: hiding onto a landing with nothing selected changes no attachment and folds
    /// no tabs, so nothing else would announce it. `nil` in every shell without a browser
    /// coordinator, which is every test that does not drive one.
    var onShellVisibilityApplied: (() -> Void)?

    /// Called by `AppWindowController` on every CHANGE of the window's on-screen state.
    func setShellVisible(_ visible: Bool) {
        guard shellVisible != visible else { return }
        shellVisible = visible
        applyPolicy()
        onShellVisibilityApplied?()
    }

    private func applyPolicy() {
        switch shellAttachmentAction(selection: selection, attached: attachedSessionId, shellVisible: shellVisible) {
        case .none: break
        case .detach: detachCurrent()
        case .attach(let sessionId): attachFresh(to: sessionId)
        case .hop(let sessionId): hop(to: sessionId)
        }
    }

    // MARK: - Attach / hop / detach

    private func attachFresh(to sessionId: String) {
        guard let made = makeFeed(sessionId) else {
            // No token yet (`AppModel.missingTokenSentinel`). The shell simply stays detached and
            // says so in the view — never a half-wired harness that can't authenticate.
            OrbDebug.log("ShellSessionHost: no harness for \(sessionId.prefix(10)) — the shell stays detached")
            return
        }
        let adapter = FieldStateAdapter(session: made.session)
        // A ONE-SHOT read of whatever `directory.rows` holds right now — for a session attached
        // before its own row has loaded (the New-Chat race: create, then navigate onto the id
        // immediately, always losing the `session_created` broadcast's own refresh round trip)
        // this reads `false` and the row isn't found. `reconcileIsChatSession` (wired in `init`)
        // is what makes that transient, not permanent — see its own doc comment.
        adapter.isChatSession = Self.isChatSession(sessionId, in: directory.rows)
        // mac-chat-parity T4: the policy readout is seeded off the SAME one-shot read of
        // `directory.rows`, and inherits the same "the row may not be loaded yet" caveat — which is
        // why `seedSessionPolicy` records whether it actually learned anything, and why the
        // `directory.$rows` subscription in `init` heals it when the row lands.
        adapter.seedSessionPolicy(for: sessionId, in: directory.rows)
        // chatgpt-ui T2: the first-message carry (spec §2 — "composer content carries over; no
        // flicker"). The pending text shows in the attached composer from the very first frame
        // and clears only when the send actually lands (`deliverPendingFirstMessage`) — so the
        // hop from the new-chat page never shows an empty beat, and a failed send leaves the
        // text exactly where the user can retry it.
        if let pending = pendingFirstMessages[sessionId] {
            adapter.composerDraft = pending
        }
        // Forward this harness's session events to the SHARED directory — the same side-observer
        // composition `DetachedWindowController` uses, and `false` for the same reason: the pinned
        // feed's own default application (apply events matching the pinned id + every connection
        // state) must still run. This is also how a `session_activity` transient for the session the
        // shell is showing reaches the directory at all: it is broadcast to that session's
        // ATTACHMENTS, which is this socket, not the orb's.
        //
        // panel-shell T9: `panelStore.apply` rides the SAME hook — this is the ONE pump
        // (`SessionFeed.start()`'s `for await ev in self.client.events`, `PanelStore`'s own doc
        // comment for why a second subscriber would race it, not duplicate it) — filtered to
        // `self?.attachedSessionId` read FRESH on every event, never a captured `sessionId`: this
        // closure is set ONCE per `attachFresh` and survives every later `hop(to:)` on the SAME
        // attachment (`ShellSessionAttachment`'s own doc comment — "a HOP keeps this exact object"),
        // so a captured id would go stale the moment a hop changed which session is current. Mirrors
        // `SessionFeed.handle`'s own `.pinned` branch (`e.sessionId == sessionId`) — the identical
        // guard, just evaluated here instead, since `SessionFeed` has no knowledge of `PanelStore`
        // (a layering boundary Task 9 does not cross — see `PanelStore`'s own doc comment).
        //
        // b2-agent-browser T3: the `panel_command` consumer rides this same ONE pump — and
        // deliberately OUTSIDE the `attachedSessionId` filter the store sits inside. **The reason is
        // the HOP RACE.** `hop(to:)` flips `attachedSessionId` synchronously, while the DEPARTING
        // session's already-in-flight events are still crossing this socket; those commands were
        // dispatched to an attachment that was genuinely ours and their tab's browser is still live
        // in the runtime, so an inside-the-filter consumer would drop every one of them into a
        // `deadlineMs` timeout for nothing. Reading the event's own `sessionId` instead of the
        // shell's current one is what keeps that window servable.
        //
        // It is NOT because unattached sessions get commands — they do not: `broadcastTransient`
        // fans out to `attachments.get(sessionId)` alone (`packages/core/src/sessions/hub.ts`), and
        // one connection is attached to one session. `PanelCommandConsumer`'s own doc carries the
        // full reasoning, the correction, and the gap none of this closes.
        //
        // **`return false` is load-bearing, unchanged**: `SessionFeed.handle` reads `true` as
        // "swallowed" and skips its own pinned application entirely, which would stop the session
        // model dead.
        made.feed.onEvent = { [weak self] event in
            if case .session(let e) = event {
                self?.directory.handle(e)
                if let attached = self?.attachedSessionId, e.sessionId == attached {
                    self?.panelStore.apply(e)
                }
                if case .panelCommand(let command) = e {
                    self?.onPanelCommand?(command)
                }
            }
            return false
        }
        // The pickers' catalogue, fetched when this harness is actually CONNECTED. Deliberately not
        // at construction like `DetachedWindowController`'s: `NormaClient.request` throws outright
        // with no transport, so a fetch fired before `feed.start()` cannot land — that window has
        // only ever been covered by the pickers' own menu-open refresh. Not re-fetched on a hop, for
        // the reason `onRefreshModelCatalogue` documents: the catalogue is daemon-wide, so a session
        // switch cannot change it.
        // chatgpt-ui T2: the pending first message delivers here too — in PINNED mode this hook
        // fires only after `client.attach`'s ack (`SessionFeed.start()`), which is the whole
        // create → attach → send ordering guarantee in one line.
        made.feed.onConnected = { [weak self] in
            self?.refreshModelCatalogue()
            self?.deliverPendingFirstMessage(for: sessionId)
        }
        // browser-runtime live-gate fix A: the replay window's other half. Set ONCE per
        // `attachFresh` and — like `onEvent` above — it survives every later `hop(to:)` on the same
        // attachment, which is what makes `repin`'s re-attach report its own ceiling too. The
        // session comes from the hook rather than this closure's captured `sessionId` for the same
        // reason `onEvent` re-reads `attachedSessionId`: a hop changes which session is current.
        made.feed.onPinnedAttach = { [weak self] attachedSessionId, ceilingSeq in
            self?.panelStore.endReplay(for: attachedSessionId, throughSeq: ceilingSeq)
        }
        let live = ShellSessionAttachment(feed: made.feed, session: made.session, adapter: adapter)
        attachment = live
        attachedSessionId = sessionId
        refreshOutputFiles(for: sessionId)
        openOutputFile = nil
        // panel-shell T9: swap the panel's published slice onto this session BEFORE the feed's pump
        // can deliver a single event for it (both calls below are synchronous), then fetch the
        // instant-display seed — see `PanelStore.switchSession`/`refreshPanelTabs`'s own doc
        // comments for why ordering here matters (a switch after the first event would show a
        // flash of the OLD session's tabs under the NEW session's identity).
        panelStore.switchSession(to: sessionId)
        // browser-runtime live-gate fix A: arm the replay window BEFORE the feed task can send the
        // attach, and AFTER `switchSession` — which must keep its own instant republish of this
        // session's cached fold, since that is the frame the panel shows while the replay runs.
        panelStore.beginReplay(for: sessionId)
        refreshPanelTabs(for: sessionId)
        wire(adapter: adapter, feed: made.feed)
        live.feedTask = Task { await made.feed.start() }
    }

    /// The hop. ONE `session.attach` on the SAME connection, which IS "detach previous, attach new":
    /// the daemon detaches this connection's previous hub client before attaching the new one
    /// (`ipc/server.ts`'s "re-attach = move semantics", and `SessionHub.attach`'s own
    /// `if (prev && prev !== sessionId) this.detach(client)`), so the previous session's detach —
    /// and its app-kind auto-background, since this app's clientName is app-kind by
    /// `harnessKindOf` — happens in the right order, before the new attachment exists, without this
    /// side having to sequence two round trips and hope.
    ///
    /// `attachedSessionId` flips FIRST, synchronously, so every callback that reads it live targets
    /// the new session immediately — the correctness fix `DetachedWindowController.selectSession`
    /// documents, in the second place it now applies.
    private func hop(to sessionId: String) {
        guard let live = attachment else { return attachFresh(to: sessionId) }
        // T4, spec §1's "keep working?" moment: capture the DEPARTING session's running state
        // before anything about it changes below — `hopAwayShouldPromptBackground` is the trigger
        // matrix (hop-away-with-turn-running AND lifecycle-participating shows it; the departing
        // row's OWN `activity` field is the participation answer, read fresh off the directory —
        // never a client-side mode guess, same as `backgroundVerbOffered`'s own callers).
        if let departing = attachedSessionId,
           hopAwayShouldPromptBackground(
               turnWasRunning: live.session.state.turnRunning,
               activity: directory.rows.first(where: { $0.sessionId == departing })?.activity
           ) {
            hopAwayPrompt = HopAwayPrompt(sessionId: departing)
        }
        // editor-product T3: the departing session's editor goes only if it is holding nothing
        // unsaved (`editorRuntimeReleasedOnDeparture`). A hop is not a quit.
        if let departing = attachedSessionId { releaseEditorRuntimeIfClean(for: departing) }
        // office-plumbing Task 5: same departure moment, ALWAYS-release policy (Stage A has no
        // dirty state to protect) — see `releaseOfficeRuntimeIfClean`'s own doc.
        if let departing = attachedSessionId { releaseOfficeRuntimeIfClean(for: departing) }
        attachedSessionId = sessionId
        refreshOutputFiles(for: sessionId)
        openOutputFile = nil
        // panel-shell T9: same swap + instant-seed pair as `attachFresh` — see those calls' own doc
        // comments. Both run synchronously here too, before the `repin` Task below is even created,
        // so `attachedSessionId`/`panelStore.currentSessionId` are never observably out of step.
        panelStore.switchSession(to: sessionId)
        // live-gate fix A: same pair as `attachFresh`, and it matters MORE here — `repin` re-attaches
        // on a live pump, so the replay starts arriving the moment the RPC goes out.
        panelStore.beginReplay(for: sessionId)
        refreshPanelTabs(for: sessionId)
        // Everything the OLD session's identity decided has to be re-derived or dropped, exactly as
        // an in-place switch does elsewhere: a different session means a different mode, a different
        // pinned model/effort, and refusals that were about the session the user just left.
        live.adapter.isChatSession = Self.isChatSession(sessionId, in: directory.rows)
        // mac-chat-parity T4: and a different session means a different POLICY — re-derived here,
        // never carried. `seedSessionPolicy` resets to "unknown" for an arriving row that says
        // nothing rather than leaving the departed session's value on screen; that value would be a
        // claim about a session it was never about, the same class as the refusals cleared below.
        live.adapter.seedSessionPolicy(for: sessionId, in: directory.rows)
        live.adapter.pendingModel = .none
        live.adapter.pendingEffort = .none
        live.adapter.selectionProbation = nil
        live.adapter.dirsRefusal = nil
        // A refusal is about the session it was refused FOR — "session is archived — resume it
        // first" rendered over a different session is a lie about a rule (the `dirsRefusal` lesson).
        live.adapter.activityRefusal = nil
        // panel-shell T10b: same "about the session it was about" discipline as the two resets
        // just above — a pending card's typed-but-unsubmitted answer belongs to the callId it was
        // typed for.
        //
        // Review fix (Important 2): the ORIGINAL version of this comment claimed "callIds don't
        // cross sessions, so a stale entry here is never wrongly displayed" — FALSE, and
        // contradicted by the daemon's own design: callIds are provider-minted with no
        // cross-session uniqueness guarantee (`packages/core/src/agent/engine.ts`'s `imageKey`
        // comment, on the identical image-staging problem). A bare-callId key here risked
        // draining session A's draft into session B's card the moment both sessions' entries ever
        // coexisted in this one dictionary. Fixed structurally, not per-site:
        // `FieldStateAdapter.pendingCardDraftBinding` now composite-keys by `boundSessionId()`
        // (mirroring the daemon's `imageKey(sessionId, threadId, callId)`), so a same-callId
        // collision across sessions can no longer alias.
        //
        // THIS clear is now genuinely hygiene-only — it bounds the dictionary's size across a
        // switch, which was always its real justification even when the comment's correctness
        // claim was wrong. The rest of the time (an ordinary same-session resolve), the adapter's
        // own resolve-path sweep (`FieldStateAdapter`'s `session.$state` sink) bounds it instead.
        live.adapter.pendingCardDrafts = [:]
        // Same sweep, same reason, for the two dictionaries beside it: `interactionInFlight` and
        // `interactionErrors` are keyed by BARE callId — the very cross-session collision hazard
        // `pendingCardDraftKey`'s doc describes, never applied to these two. A stale entry surviving
        // a hop can put a NEW session's card into "Sending…" (buttons replaced, no retry) or print
        // another session's error under it. Free to clear: both describe an in-flight attempt on the
        // session being left.
        live.adapter.interactionInFlight = []
        live.adapter.interactionErrors = [:]
        // T2 fix round 1: the first-message carry on the HOP path too — a departed new-chat
        // session opened from Recents while the shell shows another session arrives HERE, not
        // through `attachFresh`; the seed and the post-attach delivery must ride along or the
        // late-delivery commitment silently breaks on the most natural reopen path.
        if let pending = pendingFirstMessages[sessionId] {
            live.adapter.composerDraft = pending
        }
        Task { @MainActor [weak self] in
            await live.feed.repin(to: sessionId)
            // After the repin's attach ack — same attach-before-send guarantee as `onConnected`'s
            // fresh-attach ordering (`repin` awaits `client.attach` before returning).
            self?.deliverPendingFirstMessage(for: sessionId)
        }
    }

    /// Detach = close the socket. There is no `session.detach` RPC (the protocol has never had one);
    /// the daemon detaches a connection's hub client in its socket `close(...)` handler, which is
    /// the same `hub.detach` — and therefore the same app-kind, never-aborting `onDetached` — a hop
    /// goes through. `NormaClient.close()` finishes its event stream for good, so the next attach
    /// mints a fresh harness rather than reviving this one.
    private func detachCurrent() {
        guard let live = attachment else {
            attachedSessionId = nil
            panelStore.detach() // defensive symmetry with the branch below — see that call's own note
            return
        }
        // Same hop-away moment as `hop(to:)` above — hiding the shell or navigating to a non-session
        // destination is "leaving" a session exactly as much as hopping onto another one is, and the
        // same participation gate applies (a mid-turn CHAT session must never get this prompt).
        if let departing = attachedSessionId,
           hopAwayShouldPromptBackground(
               turnWasRunning: live.session.state.turnRunning,
               activity: directory.rows.first(where: { $0.sessionId == departing })?.activity
           ) {
            hopAwayPrompt = HopAwayPrompt(sessionId: departing)
        }
        // editor-product T3: same departure policy as the hop above — a hidden shell releases a
        // CLEAN editor and keeps a dirty one. ⌘W is not a quit, and nothing warns here.
        if let departing = attachedSessionId { releaseEditorRuntimeIfClean(for: departing) }
        // office-plumbing Task 5: same departure moment, ALWAYS-release policy — see
        // `releaseOfficeRuntimeIfClean`'s own doc.
        if let departing = attachedSessionId { releaseOfficeRuntimeIfClean(for: departing) }
        live.feedTask?.cancel()
        live.feedTask = nil
        live.feed.stop()
        attachment = nil
        attachedSessionId = nil
        outputFiles = []
        openOutputFile = nil
        // panel-shell T9: the panel shows nothing while detached, but `panelStore.detach()` never
        // discards what's cached for any session — a later re-attach, even to this SAME session,
        // still benefits from it (`PanelStore.detach`'s own doc comment).
        panelStore.detach()
    }

    // MARK: - T4: the hop-away prompt's two doors

    /// "Keep working in background" — makes the daemon's already-in-effect app-kind auto-background
    /// STICKY (a stored flag) rather than merely derived from this session no longer being attached
    /// anywhere. Rides the bare `setActivityFromRoster` seam (never `makeFeed`'s attaching harness):
    /// by the time this fires the shell is no longer attached to the departed session at all.
    func confirmHopAwayBackground() {
        guard let prompt = hopAwayPrompt else { return }
        setActivityFromRoster(prompt.sessionId, target: "background")
        hopAwayPrompt = nil
    }

    /// Dismiss without acting — the turn keeps running either way (the daemon's own auto-background
    /// already protects it); this only declines to make that STICKY.
    func dismissHopAwayPrompt() {
        hopAwayPrompt = nil
    }

    // MARK: - cli-handoff T3: "Move to CLI" — the affordances' one verb + its three seams

    /// The launch seam — `nil` = success, an error = what to SURFACE. Defaults to the real
    /// `HandoffLauncher.moveToCli` (Task 1: profile-baked script, `open -a Terminal`); tests inject
    /// a recorder, the house closure-seam pattern (`makeFeed`/`presentingWindow`'s own shape). The
    /// call is synchronous by design — `open` returns fast, and a synchronous seam is what makes
    /// the failure pin ("no navigation after an error") race-free rather than eventually-true.
    var handoffLaunch: (String, String) -> HandoffError? = { sessionId, dir in
        if case .failure(let error) = HandoffLauncher.moveToCli(sessionId: sessionId, dir: dir) {
            return error
        }
        return nil
    }

    /// The true move's navigation seam — wired by `AppWindowController` to
    /// `navigation.navigate(to:)`, so the move rides the SAME navigate → `onDestinationChange` →
    /// `apply(destination:)` loop every other navigation takes (this host never mutates its own
    /// selection out-of-band; the destination stays the one source of truth). `nil` (tests that
    /// don't pin the move, and any host built without a window controller) simply moves nothing.
    var navigateForHandoff: ((ShellDestination) -> Void)?

    /// The visible-failure seam — a handoff failure is NEVER log-only (the honesty-of-affordance
    /// rule; a "Move to CLI" click that silently does nothing teaches the user the button is
    /// decorative). Defaults to an alert on the shell window (`runHandoffFailureAlert`); tests
    /// inject a recorder and pin that presentation happened. The roster-refusal path
    /// (`rosterRefusals`) deliberately does NOT carry this: that dictionary is read only by the
    /// Background tab's own rows (the exact silent-clear trap `hopAwayShouldPromptBackground`'s doc
    /// records), and a handoff can fail from the toolbar or an All-tab row where nothing renders it.
    lazy var presentHandoffFailure: (HandoffError) -> Void = { [weak self] error in
        self?.runHandoffFailureAlert(error)
    }

    /// The verb behind BOTH affordances (spec §1): resolve the row, gate, launch, and — for the
    /// currently-attached session only — the TRUE MOVE (ruling R1: after Terminal opens, the shell
    /// navigates to the Code landing; the attachment drops app-kind through the normal apply path's
    /// deselect→detach, auto-backgrounding a mid-turn session, never aborting it — the CLI seat
    /// attaches when the Terminal spawns). A landing-row trigger for a NON-attached session
    /// launches only: the shell is already exactly where a move would land it, and navigating away
    /// from whatever else it IS showing would be the move stealing an unrelated surface.
    ///
    /// On failure: present and STOP — the app must not step aside from a session the Terminal
    /// never got. The wire is untouched either way: a handoff is never an attach, a detach, an
    /// interrupt or an activity write from this side (the daemon's own attach/detach semantics do
    /// all the lifecycle work once the CLI seat arrives).
    func moveToCli(sessionId: String) {
        let row = directory.rows.first(where: { $0.sessionId == sessionId })
        guard moveToCliOffered(row: row) else {
            // Unreachable from the UI — both affordances render off the same gate. Defense in
            // depth for any future caller; a refusal is not a launch failure, so nothing presents.
            OrbDebug.log("ShellSessionHost.moveToCli: \(sessionId.prefix(10)) is not handoff-eligible — refusing")
            return
        }
        if let error = handoffLaunch(sessionId, handoffDirectory(row: row)) {
            presentHandoffFailure(error)
            return
        }
        if attachedSessionId == sessionId {
            navigateForHandoff?(.mode(.code))
        }
    }

    /// `presentHandoffFailure`'s default: an alert ON the shell window (a sheet when the window is
    /// there to hang it on, app-modal otherwise — still visible, never a log line). Copy comes from
    /// the pure `handoffFailureMessage`, which the tests pin per-case.
    private func runHandoffFailureAlert(_ error: HandoffError) {
        OrbDebug.log("ShellSessionHost.moveToCli failed: \(error)")
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Couldn't move this session to the CLI"
        alert.informativeText = handoffFailureMessage(error)
        if let window = presentingWindow?() {
            alert.beginSheetModal(for: window)
        } else {
            alert.runModal()
        }
    }

    /// One implementation of "is this session chat", deliberately shared with the detached window's
    /// own in-place switch rather than re-written here — including its documented "false when the
    /// row isn't loaded yet" default.
    private static func isChatSession(_ sessionId: String, in rows: [SessionSummary]) -> Bool {
        DetachedWindowController.isChatSession(sessionId, in: rows)
    }

    /// IMP-1 fix (final whole-branch review, "the fourth door" — plan-immunity's own class,
    /// reaching a FOURTH door): `attachFresh` derives `adapter.isChatSession` exactly ONCE, off
    /// whatever `directory.rows` holds at the instant of attach; `hop(to:)` re-derives it too, but
    /// only on ITS OWN transition. Neither ever re-runs merely because the row LANDS — so a
    /// session attached before its row loaded (the New-Chat race is the one this closes, but the
    /// general shape recurs for ANY caller that attaches before `directory`'s refresh round trip
    /// lands, e.g. a phone-created session opened instantly) shows a policy picker whose every tap
    /// fires a `setPolicy` the daemon silently refuses, for the WHOLE attachment's lifetime — the
    /// row's eventual arrival changes `directory.rows` but nothing ever reads it again.
    ///
    /// The general cure, chosen over patching the one call site (`AppDelegate.newChat()` could
    /// instead `await model.directory.refresh()` before summoning): this subscribes to
    /// `directory.$rows` — the ONE source of truth, no second copy of a row's mode cached
    /// anywhere — and re-derives for whichever session is CURRENTLY attached every time the
    /// directory's rows change, so the row's eventual fold self-heals the picker the moment it
    /// lands, regardless of which door attached ahead of it. Exactly the "recompute fresh off the
    /// live source, the very next external trigger" posture `outputsBoxParticipates`'s own doc
    /// comment documents for the outputs box's twin self-healing shape — except THIS trigger is
    /// the directory's own publisher, not "whatever the next hop/watcher-tick happens to be",
    /// because a picker rendered wrong must heal the instant the fact arrives, not whenever the
    /// user next does something unrelated.
    ///
    /// No-op while detached (`attachment == nil`) or for a rows change that doesn't concern the
    /// attached session — `Self.isChatSession` reads only the one matching row, and the equality
    /// guard below means a change to some OTHER session's row never republishes this one for no
    /// reason.
    private func reconcileIsChatSession(rows: [SessionSummary]) {
        guard let live = attachment, let sid = attachedSessionId else { return }
        let derived = Self.isChatSession(sid, in: rows)
        if live.adapter.isChatSession != derived {
            live.adapter.isChatSession = derived
        }
        // mac-chat-parity T4: the same door, for the same race — a session attached before its row
        // loaded has no policy to show either, and nothing else would ever read the row again for
        // the rest of that attachment. ONE-WAY (see `healSessionPolicyIfUnknown`): unlike
        // `isChatSession` above, which re-derives in both directions off a fact only the daemon
        // owns, the policy has a second legitimate writer — the user's own successful `setPolicy` —
        // so a two-way reconcile here would let a list result already in flight when they changed it
        // silently undo the change.
        live.adapter.healSessionPolicyIfUnknown(for: sid, in: rows)
    }

    // MARK: - The hosted view's wiring

    /// The `SidebarWiring` the hosted `WindowContentView` renders. RIGHT-ONLY: the shell's own
    /// custom sidebar pane (`ShellSidebar`) is the session switcher, so the inner left column is
    /// opted out of (`showsSessionSwitcher: false`) and the work column keeps everything else.
    ///
    /// Built fresh per read (a struct of closures — nothing to cache) so `currentSessionId` always
    /// reads the live attachment, the same "read fresh at render" convention the work column's own
    /// info block already relies on.
    var sidebarWiring: SidebarWiring {
        SidebarWiring(
            directory: directory,
            currentSessionId: { [weak self] in self?.attachedSessionId },
            // Reachable only if some future surface renders the inner switcher after all; wired
            // correctly rather than left as a lie.
            onSelect: { [weak self] sessionId in self?.select(sessionId) },
            // The shell renders NO inner switcher, so these two have no affordance behind them
            // here: detaching a session into its own window and creating one are the outer nav's
            // doors (T4's landing "New", the orb's detach choreography), not this column's.
            onOpenDetached: { sessionId in
                OrbDebug.log("ShellSessionHost: onOpenDetached(\(sessionId.prefix(10))) has no affordance in the shell")
            },
            onNewSession: {
                OrbDebug.log("ShellSessionHost: onNewSession has no affordance in the shell")
            },
            showsSessionSwitcher: false
        )
    }

    /// Wires the adapter to THIS harness — same seams, same discipline as
    /// `DetachedWindowController.init`'s: `[weak self]`/`[weak adapter]` throughout (one adapter per
    /// attachment, so a strong self-capture is a real leak, not a harmless app-lifetime one), and
    /// `attachedSessionId` read FRESH at call time so a hop re-targets everything at once.
    private func wire(adapter: FieldStateAdapter, feed: SessionFeed) {
        let client = feed.client
        adapter.onSubmit = { [weak self] text in self?.submit(text) }
        adapter.onClearMessage = { [weak adapter] in adapter?.composerDraft = "" }
        adapter.boundSessionId = { [weak self] in self?.attachedSessionId }

        adapter.onApprovalRespond = { [weak self, weak adapter] callId, approved, optionId, childSessionId in
            guard let adapter else { return }
            adapter.interactionInFlight.insert(callId)
            adapter.interactionErrors[callId] = nil
            Task { @MainActor [weak self, weak adapter] in
                // Dispatch (Phase 7): a mirrored child card answers into the CHILD.
                // A no-target early return must NOT strand the card: `interactionInFlight` was
                // inserted synchronously above, and the card's "Sending…" state REPLACES its
                // buttons — leaving the entry set would wedge it with no retry and no explanation.
                // `onSetPolicy` just below has always handled its identical early return this way.
                guard let target = childSessionId ?? self?.attachedSessionId else { adapter?.interactionInFlight.remove(callId); adapter?.interactionErrors[callId] = "couldn't send — try again"; return }
                let ok = (try? await client.approvalRespond(sessionId: target, callId: callId, approved: approved, optionId: optionId)) != nil
                adapter?.interactionInFlight.remove(callId)
                if !ok { adapter?.interactionErrors[callId] = "couldn't send — try again" }
            }
        }
        adapter.onQuestionRespond = { [weak self, weak adapter] callId, answers, notes, childSessionId in
            guard let adapter else { return }
            adapter.interactionInFlight.insert(callId)
            adapter.interactionErrors[callId] = nil
            Task { @MainActor [weak self, weak adapter] in
                // A no-target early return must NOT strand the card: `interactionInFlight` was
                // inserted synchronously above, and the card's "Sending…" state REPLACES its
                // buttons — leaving the entry set would wedge it with no retry and no explanation.
                // `onSetPolicy` just below has always handled its identical early return this way.
                guard let target = childSessionId ?? self?.attachedSessionId else { adapter?.interactionInFlight.remove(callId); adapter?.interactionErrors[callId] = "couldn't send — try again"; return }
                let ok = (try? await client.askUserRespond(sessionId: target, callId: callId, answers: answers, notes: notes.isEmpty ? nil : notes)) != nil
                adapter?.interactionInFlight.remove(callId)
                if !ok { adapter?.interactionErrors[callId] = "couldn't send — try again" }
            }
        }
        adapter.onPlanRespond = { [weak self, weak adapter] callId, approved, autoAccept, feedback in
            guard let adapter else { return }
            adapter.interactionInFlight.insert(callId)
            adapter.interactionErrors[callId] = nil
            Task { @MainActor [weak self, weak adapter] in
                // A no-target early return must NOT strand the card: `interactionInFlight` was
                // inserted synchronously above, and the card's "Sending…" state REPLACES its
                // buttons — leaving the entry set would wedge it with no retry and no explanation.
                // `onSetPolicy` just below has always handled its identical early return this way.
                guard let sid = self?.attachedSessionId else { adapter?.interactionInFlight.remove(callId); adapter?.interactionErrors[callId] = "couldn't send — try again"; return }
                let ok = (try? await client.planRespond(sessionId: sid, callId: callId, approved: approved, autoAccept: autoAccept, feedback: feedback)) != nil
                adapter?.interactionInFlight.remove(callId)
                if !ok { adapter?.interactionErrors[callId] = "couldn't send — try again" }
            }
        }

        adapter.onSetPolicy = { [weak self, weak adapter] policy in
            guard let adapter else { return }
            adapter.policyChangeInFlight = true
            Task { @MainActor [weak self, weak adapter] in
                guard let sid = self?.attachedSessionId else { adapter?.policyChangeInFlight = false; return }
                let ok = (try? await client.setPolicy(sessionId: sid, policy: policy)) != nil
                adapter?.policyChangeInFlight = false
                if ok { adapter?.adoptSessionPolicy(policy) }
            }
        }
        adapter.onSetModel = { [weak self, weak adapter] model in
            guard let adapter else { return }
            adapter.modelChangeInFlight = true
            Task { @MainActor [weak self, weak adapter] in
                guard let self, let sid = self.attachedSessionId else { adapter?.modelChangeInFlight = false; return }
                let ok = (try? await client.setModel(sessionId: sid, model: model)) != nil
                if ok { await self.directory.refresh() }
                adapter?.pendingModel = .none
                if ok { adapter?.armProbation(model: .some(model)) }
                adapter?.modelChangeInFlight = false
            }
        }
        adapter.onSetEffort = { [weak self, weak adapter] effort in
            guard let adapter else { return }
            adapter.effortChangeInFlight = true
            Task { @MainActor [weak self, weak adapter] in
                guard let self, let sid = self.attachedSessionId else { adapter?.effortChangeInFlight = false; return }
                let ok = (try? await client.setEffort(sessionId: sid, effort: effort)) != nil
                if ok { await self.directory.refresh() }
                adapter?.pendingEffort = .none
                if ok { adapter?.armProbation(effort: .some(effort)) }
                adapter?.effortChangeInFlight = false
            }
        }
        adapter.onRefreshModelCatalogue = { [weak self] in self?.refreshModelCatalogue() }
        adapter.onSetDirs = { [weak self] op, path in self?.applyDirsOp(op, path: path) }
        adapter.onPickWorkingDir = { [weak self] op in self?.pickWorkingDir(op) }
        // app-shell T3: the `/background` affordance. Wiring it is what makes it VISIBLE at all
        // (`FieldStateAdapter.onSetActivity` is optional and nil elsewhere), so the shell is the
        // one surface that grows the verb this task — every pre-existing window is untouched.
        adapter.onSetActivity = { [weak self] target in self?.applyActivity(target) }
    }

    /// Mirrors `DetachedWindowController.submit` — steer a running turn, else send; the draft is
    /// cleared ONLY on success, so a failed send never loses the composed text (spec §6 parity).
    private func submit(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let live = attachment, let sid = attachedSessionId else { return }
        let wasRunning = live.session.state.turnRunning
        let client = live.feed.client
        Task { @MainActor [weak self] in
            let ok: Bool
            if wasRunning {
                ok = (try? await client.steer(sessionId: sid, text: trimmed)) != nil
            } else {
                ok = (try? await client.send(sessionId: sid, text: trimmed)) != nil
            }
            if ok { self?.attachment?.adapter.composerDraft = "" }
        }
    }

    /// The pickers' catalogue snapshot — fetched when a harness opens and whenever a picker menu is
    /// about to be read. `try?`, same posture as everywhere else: a hiccup leaves the previous
    /// catalogue in place rather than blanking a picker out from under the user.
    private func refreshModelCatalogue() {
        guard let client = attachment?.feed.client else { return }
        Task { @MainActor [weak self] in
            guard let snapshot = try? await client.syncConfig() else { return }
            self?.attachment?.adapter.modelCatalogue = snapshot
        }
    }

    /// The working-folders chip's per-entry action. A refusal is published VERBATIM — `set-dirs.ts`
    /// writes one sentence per rule and each names the rule it enforced.
    private func applyDirsOp(_ op: SessionDirsOp, path: String) {
        guard let live = attachment, let sid = attachedSessionId else { return }
        let client = live.feed.client
        live.adapter.dirsChangeInFlight = true
        Task { @MainActor [weak self] in
            guard let self, let adapter = self.attachment?.adapter else { return }
            do {
                _ = try await client.setDirs(sessionId: sid, op: op, path: path)
                await self.directory.refresh()
                adapter.dirsRefusal = nil
            } catch let error as RpcError {
                adapter.dirsRefusal = error.message
            } catch {
                adapter.dirsRefusal = "couldn't reach the daemon — try again"
            }
            adapter.dirsChangeInFlight = false
        }
    }

    /// The `/background` affordance's RPC. `target` is the activity vocabulary VERBATIM (see
    /// `NormaClient.setActivity`); T3's affordance sends two of its values, and the roster verbs
    /// (T4) will send the rest through this same seam.
    ///
    /// A refusal is published VERBATIM (`adapter.activityRefusal`) — `set-activity.ts` writes one
    /// sentence per rule and each names the rule it enforced; a client-side "couldn't change that"
    /// erases exactly the sentence that teaches it. On success the refusal clears and the DIRECTORY
    /// row is refreshed: activity lives on `session.list`'s row (T2), so there is no second source
    /// of truth here to keep in sync — the `onSetDirs`/`onSetModel` precedent. (The daemon also
    /// EMITS the new state to this session's attachments, which includes this harness, and T2's fold
    /// patches the row from that; the refresh is the belt for the emit's own change-filter, which
    /// stays silent when the write moved no bit.)
    private func applyActivity(_ target: String?) {
        guard let live = attachment, let sid = attachedSessionId else { return }
        let client = live.feed.client
        live.adapter.activityChangeInFlight = true
        Task { @MainActor [weak self] in
            guard let self, let adapter = self.attachment?.adapter else { return }
            do {
                _ = try await client.setActivity(sessionId: sid, activity: target)
                await self.directory.refresh()
                adapter.activityRefusal = nil
            } catch let error as RpcError {
                adapter.activityRefusal = error.message
            } catch {
                adapter.activityRefusal = "couldn't reach the daemon — try again"
            }
            adapter.activityChangeInFlight = false
        }
    }

    /// The chip's "Add folder…"/"Change primary folder…" — panel, then the CONFIRM alert (a manual
    /// add is selection + confirm, never a one-click widening of what Norma may write to), then the
    /// RPC. Needs the shell window, which the controller injects; with none, there is nothing to
    /// attach a sheet to and the door simply does not fire.
    private func pickWorkingDir(_ op: SessionDirsOp) {
        guard let window = presentingWindow?() else {
            OrbDebug.log("ShellSessionHost: no window to present the working-folder panel on")
            return
        }
        runWorkingDirOpenPanel(on: window) { [weak self] path in
            guard let self, let path else { return } // cancelled panel: nothing happens
            confirmWorkingDir(op: op, path: path, on: window) { [weak self] confirmed in
                guard let self, confirmed else { return } // declined confirm: nothing happens
                self.applyDirsOp(op, path: path)
            }
        }
    }

    // MARK: - app-shell T8: the outputs box + the third panel's own doors

    /// The box's INITIAL listing on attach/hop — `outputsWatcher.onChange` only fires on a LATER
    /// filesystem change, so a session whose outputs already existed before this attach (reopened
    /// from Recents, or the very first attach of the app's life) needs its own synchronous read.
    /// Cheap (one directory enumeration) and profile-resolved via `AppProfile.normaHome`, never a
    /// literal `~/.norma` — the dev/dist profile-blindness class that shipped as a live bug once.
    /// Gated on `outputsBoxParticipates` so a chat/dispatch attach never even performs the read, let
    /// alone populates `outputFiles` — the "never a hollow box" rule holds structurally, not just at
    /// the view layer.
    private func refreshOutputFiles(for sessionId: String) {
        guard outputsBoxParticipates(sessionId) else { outputFiles = []; return }
        outputFiles = listOutputFiles(home: AppProfile.normaHome, sessionId: sessionId)
    }

    /// `outputsWatcher.onChange`'s composed handler — filters to the session THIS host is showing
    /// (the box's own half of "design the callback surface for both consumers"; T9's floating panel
    /// filters to the opposite set). Same `outputsBoxParticipates` gate as `refreshOutputFiles`, so a
    /// stray event for a non-participating mode (unreachable in practice — the daemon never writes
    /// there for chat/dispatch — but defended anyway, the same posture `dirsMenuIsVisible` keeps
    /// against a fact it does not itself produce) can never populate the box either.
    private func applyOutputsChange(sessionId: String, files: [String]) {
        guard sessionId == attachedSessionId, outputsBoxParticipates(sessionId) else { return }
        outputFiles = files.map { URL(fileURLWithPath: $0) }
    }

    /// Review fix (T8): whether the box participates for `sessionId`, gated on the row actually
    /// being LOADED. FAIL-CLOSED for a row not yet in `directory.rows` (a fresh id the directory's
    /// own refresh hasn't caught up to) — a genuinely reachable trigger (navigate to an existing
    /// session before its row loads), unlike the shown-once-a-session-is-actually-loaded call sites
    /// `DetachedWindowController.isChatSession`'s own "false when not found" default gates (that
    /// default is unreachable for the scenarios it covers; this one was not).
    ///
    /// This is deliberately a DIFFERENT question from `outputsBoxEligible(mode:)`'s own `nil` case,
    /// which answers "the daemon reported this row with an ABSENT mode field" — a wire-confirmed
    /// fact that correctly resolves to "code" (the store-wide `mode ?? "code"` convention
    /// `participatesInActivity` also uses). Conflating "row not loaded" with "row loaded, mode
    /// absent" made the "never a hollow box" guarantee depend on an out-of-file, untested invariant
    /// (chat/dispatch sessions never acquiring fs tools — packages/core's tool registry) instead of
    /// owning it here: this function now answers correctly with NO help from that fact.
    ///
    /// SELF-HEALING: both call sites above route through this one function, so the row's eventual
    /// arrival (the directory's fold, or a refresh) makes the very next call — a hop, or a live
    /// watcher tick — recompute eligibility fresh and the box appears for a genuine code/cowork
    /// session, exactly as if the row had always been there.
    private func outputsBoxParticipates(_ sessionId: String) -> Bool {
        guard let row = directory.rows.first(where: { $0.sessionId == sessionId }) else { return false }
        return outputsBoxEligible(mode: row.mode)
    }

    /// The box's click door — opens the third panel on `url`.
    func showOutputFile(_ url: URL) {
        openOutputFile = url
    }

    /// The panel's own close button.
    func closeOutputFile() {
        openOutputFile = nil
    }
}

// MARK: - editor-product Task 10: the tab-close sheet's AppKit half

/// The dirty-close sheet's real presentation — a FREE function taking the window as a PARAMETER
/// (`confirmWorkingDir`'s own shape, `WorkingDirPickerSheet.swift`) rather than a `lazy var` closing
/// over `self`, which is what lets `ShellSessionHost.presentDirtyCloseSheet` default to it directly
/// without capturing anything.
///
/// A sheet when there is a window to hang it on (there always is, in practice — a tab's `×` cannot
/// be clicked without one), an app-modal fallback otherwise, matching every other alert this file
/// presents.
@MainActor
func presentDirtyCloseSheetAlert(basename: String, on window: NSWindow?,
                                 respond: @escaping (DirtyCloseChoice) -> Void) {
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = "Save changes to \(basename)?"
    alert.addButton(withTitle: "Save")
    alert.addButton(withTitle: "Discard")
    alert.addButton(withTitle: "Cancel") // NSAlert binds Escape to this one automatically.
    let handle: (NSApplication.ModalResponse) -> Void = { response in
        switch response {
        case .alertFirstButtonReturn: respond(.save)
        case .alertSecondButtonReturn: respond(.discard)
        default: respond(.cancel)
        }
    }
    if let window {
        alert.beginSheetModal(for: window, completionHandler: handle)
    } else {
        handle(alert.runModal())
    }
}

// MARK: - The `panel.list` snapshot fold (the app's SECOND fold path)

/// PURE: `panel.list`'s wire rows → the app's own `PanelTab`s. The snapshot half of the pair
/// `foldPanelTabs` (`PanelTab.swift`) forms — that one folds live/replayed EVENTS, this one seeds
/// from a fetch — and it is extracted from `refreshPanelTabs`'s async body precisely so it can be
/// tested without a daemon.
///
/// **`diffId` rides through, and diff-tabs Task 9 exists partly because it did not.** This is the
/// app's ONLY source of a diff tab's identity after an attach or a hop (`PanelTabInfo.diffId`'s own
/// doc in NormaKit says the same from the other side): the panel store is re-seeded from
/// `panel.list` on every switch, so a mapping that dropped the field would leave every surviving
/// diff tab with `diffId == nil` and make the chip's dedupe silently re-mint a duplicate tab for a
/// diff that is already open — visible only after a reattach, which is exactly the kind of bug that
/// ships.
///
/// An unparseable `kind` DROPS that tab rather than guessing `.web` — see `refreshPanelTabs`'s own
/// doc for why that mirrors what a replayed event with the same unknown value does.
func panelTabs(fromSnapshot infos: [PanelTabInfo]) -> [PanelTab] {
    infos.compactMap { info in
        guard let kind = PanelTabKind(rawValue: info.kind) else { return nil }
        return PanelTab(tabId: info.tabId, kind: kind, url: info.url, title: info.title,
                        diffId: info.diffId)
    }
}

// MARK: - diff-tabs Task 9: what a chip click does

/// The two things a diff chip can ask for. Named rather than expressed as an `if` inside
/// `openDiffTab` so the DECISION is testable without a daemon, a socket or a window — the same split
/// this file already makes for `createSession(with:onCreated:)` (the testable seam beside an
/// undrivable sheet).
enum PanelDiffTabAction: Equatable {
    /// A tab for this diff is already open: activate it. Carries the daemon-minted `tabId`, which is
    /// the only identity the activate RPC accepts.
    case activate(tabId: String)
    /// No tab for this diff: mint one, titled with the edited file's last path component.
    case mint(title: String)
}

/// PURE: dedupe a chip click against a session's folded tab list.
///
/// **`diffId` is the key, and it has to be** — `tabId` is minted per tab, so two tabs for one diff
/// would be indistinguishable by it; `title` is a basename, which repeats constantly (`index.ts`);
/// and a diff tab is FROZEN by construction (the patch file never changes after write, design spec
/// §4), so the tab that is already open is not merely equivalent to a fresh one, it is identical.
///
/// A tab whose `diffId` is `nil` can never match: `first(where:)` compares against a non-optional
/// `ref.diffId`, so a `.web` tab and a pre-feature diff tab both fall through to the mint. That is
/// the correct failure — a duplicate tab is recoverable, activating an unrelated page is not.
///
/// The KIND is deliberately not part of the match. `diffId` is only ever set on a `.diff` tab (the
/// daemon's own `PanelOpenTabParams` refinement pairs them), so adding a kind test would guard a
/// case that cannot exist while implying the id alone is not trusted here.
///
/// `lastPathComponent` on the AS-RECEIVED path (`FileDiffRef.path` may be relative) — a string
/// operation on a string, never a filesystem question.
func panelDiffTabAction(tabs: [PanelTab], ref: FileDiffRef) -> PanelDiffTabAction {
    if let open = tabs.first(where: { $0.diffId == ref.diffId }) {
        return .activate(tabId: open.tabId)
    }
    return .mint(title: (ref.path as NSString).lastPathComponent)
}

// MARK: - editor-product Task 6: what a file-door click does

/// PURE: the file door's path resolution — the FIRST step, before the dedupe below ever runs.
///
/// An already-absolute path is returned untouched: reads carry no path fence (CLAUDE.md, "Reads
/// unrestricted"), so a file the agent named outside the session's own roots is still a real file,
/// and resolving it against anything would be wrong. A RELATIVE one resolves against the session's
/// PRIMARY working directory — `handoffDirectory`'s own source (`row.dirs?.first?.path`), NEVER
/// `row.cwd`, which is the daemon's list-time ALIAS of that same field (`SessionSummary.dirs`'s own
/// doc, echoed by `editorPrewarmTarget`/`editorTabSessionRoots`). A relative path in a session with
/// no primary to resolve against is returned untouched too — there is nothing sensible to join it
/// to. **Both of this door's shipped gates now ask the identical question this line does**
/// (editor-product Task 7 reconciliation): the transcript's `sessionHasWorkingDirectory`
/// (`toolDetailIsClickablePath`, `TranscriptMessageViews.swift`) and the Files tab's own
/// `PanelFilesTabModel.roots` are both `editorTabSessionRoots`, which Task 7 tightened to require
/// `dirs.first?.path` be genuinely non-empty — closing the gap a degenerate `dirs: [{path: ""}]` row
/// used to leave (Task 6 review, Minor: that row rendered a clickable button whose click reached
/// here with an empty primary and returned the path untouched, relative, onto the wire). This
/// remains the door's own defensive floor regardless, for any caller that is neither of those two
/// gates.
///
/// Not normalized beyond that one join: `"./src/a.ts"` and `"src/a.ts"` resolve to two DIFFERENT
/// strings and so two different tabs if both are ever clicked for the same file. Known, and left —
/// the diff door accepts an equivalent recoverable duplicate for its own double-click race (its own
/// doc), and a duplicate tab is the same bounded, recoverable failure here.
func resolvedFilePath(_ path: String, row: SessionSummary?) -> String {
    guard !path.hasPrefix("/"), let primary = row?.dirs?.first?.path, !primary.isEmpty else {
        return path
    }
    return (primary as NSString).appendingPathComponent(path)
}

/// The two things a file-door click can ask for — mirrors `PanelDiffTabAction` one door down.
enum PanelFileTabAction: Equatable {
    /// A `.code` tab for this path is already open: activate it. `retryOpen` is Task 5's review
    /// HANDOFFS obligation, decided HERE rather than left to the door to notice: an existing tab
    /// whose path currently sits in the runtime's `openFailures` has NO model to show —
    /// `openFailures` is only ever recorded for a path holding none (`EditorRuntimeState`'s own
    /// doc) — so activating it alone would re-surface the exact same "File not found" sentence
    /// forever, including after the agent creates the file a moment later. `true` tells
    /// `openFileTab` to also ask the runtime to read the file again.
    case activate(tabId: String, retryOpen: Bool)
    /// No tab for this path: mint one, titled with the file's own basename.
    case mint(title: String)
}

/// PURE: dedupe a file-door click against a session's folded tab list, over `.code` tabs, BY PATH.
///
/// `path` is the door's ALREADY-RESOLVED absolute path (`resolvedFilePath`, above) — a relative and
/// an absolute spelling of the same file must collide on the one open tab, which only holds if both
/// are compared as the same string by the time they reach here.
///
/// **Filtered to `.code`**, unlike `panelDiffTabAction`'s deliberately kind-less match: `url` is a
/// field every tab kind carries (a `.web` tab's address is never a filesystem path, but nothing
/// stops the two strings coinciding by chance, where `diffId` structurally cannot), so the kind
/// check is load-bearing here rather than redundant.
///
/// `openFailures` is the session's editor runtime's CURRENT failure set — empty when the session
/// has no runtime yet — read by the caller immediately before this call, never cached (see
/// `openFileTab`'s own doc for why that matters).
func panelFileTabAction(tabs: [PanelTab], path: String, openFailures: Set<String>) -> PanelFileTabAction {
    if let open = tabs.first(where: { $0.kind == .code && $0.url == path }) {
        return .activate(tabId: open.tabId, retryOpen: openFailures.contains(path))
    }
    return .mint(title: (path as NSString).lastPathComponent)
}

// MARK: - editor-product Task 7: what a Files-tab open does

/// The two things a Files-tab open can ask for — mirrors `PanelDiffTabAction`/`PanelFileTabAction`
/// one door up, minus their per-item identity: there is at most ONE `.files` tab per session (design
/// spec: "one per session, deduped like the New Tab"), so the KIND ALONE is the key — no `diffId`,
/// no `url`, nothing else to compare.
enum PanelFilesTabAction: Equatable {
    /// A `.files` tab is already open for this session: activate it.
    case activate(tabId: String)
    /// No `.files` tab yet: mint one — `openFilesTab` titles it "Files" and sends no `url`.
    case mint
}

/// PURE: dedupe a Files-tab open against a session's folded tab list. Any existing `.files` tab
/// matches — there can only ever be one, so unlike `panelFileTabAction`'s path comparison or
/// `panelDiffTabAction`'s `diffId` comparison, the KIND test alone is the whole decision.
func panelFilesTabAction(tabs: [PanelTab]) -> PanelFilesTabAction {
    if let open = tabs.first(where: { $0.kind == .files }) {
        return .activate(tabId: open.tabId)
    }
    return .mint
}

// MARK: - The hosted surface

/// The shell's session surface: the shared `WindowContentView`, in its right-only configuration.
///
/// GALLERY EXTENSION POINT: `norma-ios/docs/ios26-design-gallery` has no transcript-beside-a-
/// sidebar geometry (the phone's chat is always full-bleed), so what transfers here is the
/// CONTENT — the same header row, transcript, cards, composer and work column every other Norma
/// window renders — while the framing is the Mac's own: no self-drawn chrome, no
/// `.ignoresSafeArea()`, because the shell's content column already sits below the titlebar band
/// via the safe area (custom-sidebar rework: the unified toolbar is gone; only the custom PANE
/// bleeds under the transparent titlebar, deliberately).
struct ShellSessionView: View {
    @ObservedObject var host: ShellSessionHost
    /// cli-handoff T3: the shared directory, observed HERE (not through `host`, whose reference to
    /// it is a plain `let` no view re-renders on) so the Move-to-CLI pill's eligibility gate
    /// re-reads the live wire row — a row that archives out from under an open session drops the
    /// affordance the moment the fold lands, not on the next unrelated republish.
    @ObservedObject var directory: SessionDirectory

    var body: some View {
        if let attachment = host.attachment {
            // app-shell T8: the third panel — a genuine `HStack` sibling of the whole hosted
            // column, beside the transcript, never inside `WindowContentView` itself (that view is
            // shared with every morph/detached window, and this panel is Mac-app-shell-only — spec
            // §3's "Gallery has ZERO viewer coverage"). One at a time, closable, window-owned
            // (`host.openOutputFile`).
            HStack(spacing: 0) {
                VStack(spacing: 0) {
                    WindowContentView(
                        adapter: attachment.adapter,
                        tint: Color(red: 0.45, green: 0.75, blue: 1.0),
                        // The detail column is already inset below the titlebar band by the safe
                        // area (unlike a detached window, which bleeds under its own hidden
                        // titlebar and pays 52pt for it) — this is the plain breathing room above
                        // the header row. Tune-at-gate constant.
                        topInset: 8,
                        sidebars: host.sidebarWiring,
                        // The shell's chat page is the ONE surface that opts into the shared
                        // composer card — see `WindowContentView.composerCardMode` for why the
                        // orb's morph window and the detached window deliberately do not.
                        //
                        // Read from the DIRECTORY rather than from `adapter.isChatSession`: that
                        // flag only distinguishes chat from not-chat, and since mac-chat-parity
                        // Task 5 the mode PICKS THE COMPOSER — chat, code and dispatch each have
                        // their own (`ComposerChrome.swift`), so "not chat" is not an answer this
                        // needs. A code session gets the card without the Chat/Cowork segment,
                        // which is correct: it is not one of the two modes that segment offers.
                        // `host.attachedSessionId` READ FRESH, per this type's own standing rule
                        // (see its doc: every closure reads it at call time rather than capturing
                        // an id) — the attachment can be swapped under this view.
                        composerCardMode: SessionMode(
                            wire: directory.rows
                                .first { $0.sessionId == host.attachedSessionId }?.mode
                        ),
                        // diff-tabs Task 9: the transcript's diff door, wired ONLY here — the orb's
                        // morph window and every detached window render the same
                        // `WindowContentView` with no panel to open a tab in, so they leave it nil
                        // and their chips draw as plain text (`TranscriptDiffChip`).
                        //
                        // `host.attachedSessionId` is read INSIDE the closure, at click time, per
                        // this type's standing rule (see `ShellSessionHost`'s own doc: every closure
                        // reads it at call time rather than capturing an id) — a captured id would
                        // survive a hop and file the tab into a session the user has left.
                        onOpenDiff: { ref in
                            guard let sessionId = host.attachedSessionId else { return }
                            host.openDiffTab(ref, sessionId: sessionId)
                        },
                        // editor-product Task 6: the file door, wired identically to `onOpenDiff`
                        // immediately above — same three-homes opt-in, same read-fresh-at-click-time
                        // rule (a hop between the click and this call must not file the tab into a
                        // session the user has left).
                        //
                        // office-plumbing Task 7: routes through `openFileOrDocumentTab`, not
                        // `openFileTab` directly — an office-extension path now opens a `.document`
                        // tab instead of trying to render binary bytes as code. See that method's own
                        // doc for why this is the ONE router, called by both UI doors, and for the
                        // fire-time dirs re-check it applies before minting a document tab.
                        onOpenFile: { path in
                            guard let sessionId = host.attachedSessionId else { return }
                            host.openFileOrDocumentTab(path, sessionId: sessionId)
                        },
                        // editor-product Task 6: the row-level clickability gate's one dynamic
                        // input — see `WindowContentView.sessionHasWorkingDirectory`'s own doc.
                        // Reuses T5's `editorTabSessionRoots` rather than growing a third `dirs`
                        // reader (T5's own review note, honored here as it asked).
                        sessionHasWorkingDirectory: editorTabSessionRoots(
                            sessionId: host.attachedSessionId, rows: directory.rows
                        ) == .present
                    ) {
                        // cli-handoff T3's open-session "Move to CLI", RE-HOSTED (custom-sidebar
                        // rework): the window toolbar it rode died with the native chrome
                        // (`AppWindowController` — ChatGPT has none), so the SAME gated verb now
                        // renders as a custom pill in the header's shell-owned accessory slot —
                        // the exact slot the morph window injects its traffic lights through,
                        // still never inside the shared `WindowContentView` itself. Same ONE
                        // eligibility gate as the landing rows and the Recents context menu
                        // (`moveToCliOffered`, on the ATTACHED session's live wire row — which is
                        // also what keeps it absent on `DispatchSurface`'s hosting of this view),
                        // same host verb, same help/accessibility labels as the toolbar item had.
                        if let sessionId = host.attachedSessionId,
                           moveToCliOffered(row: directory.rows.first(where: { $0.sessionId == sessionId })) {
                            Button {
                                host.moveToCli(sessionId: sessionId)
                            } label: {
                                Label("Move to CLI", systemImage: "terminal")
                                    .font(Typography.caption(.medium))
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 4)
                                    .background(Capsule().fill(.quaternary))
                                    .contentShape(Capsule())
                            }
                            .buttonStyle(.plain)
                            .help("Open Terminal in this session's folder, attached to this session")
                            .accessibilityLabel("Move to CLI")
                        }
                    }
                    // The outputs box — COLLAPSED/ABSENT when empty (the pinned "never a hollow
                    // box" rule). `host.outputFiles` is already mode-gated at the source
                    // (`ShellSessionHost.refreshOutputFiles`/`applyOutputsChange`), so the only
                    // check needed here is emptiness, exactly like `WindowContentView`'s own
                    // `pinnedTasksSection`/`subagentSection` callers.
                    if !host.outputFiles.isEmpty {
                        OutputsBox(files: host.outputFiles, onSelect: { host.showOutputFile($0) })
                            .padding(.horizontal, 16)
                            .padding(.bottom, 12)
                    }
                }
                if let openFile = host.openOutputFile {
                    Divider()
                    FileViewer(url: openFile, onClose: { host.closeOutputFile() })
                }
            }
        } else {
            // Detached: the shell is hidden (nothing renders anyway), or no harness could be
            // spawned at all — which is a real state (no daemon token yet) and says so.
            ShellSessionUnavailableView()
        }
    }
}

struct ShellSessionUnavailableView: View {
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "message")
                .font(Typography.emptyStateGlyph)
                .foregroundStyle(.tertiary)
            Text("This session isn't open")
                .font(Typography.emptyStateTitle)
            Text("Norma couldn't reach the daemon for it. It opens as soon as the connection is back.")
                .font(Typography.emptyStateSubtitle)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - T4: the hop-away "keep working?" banner

/// Renders `host.hopAwayPrompt` as a dismissible inline bar, independent of whatever the shell is
/// showing NOW — the whole point is that it survives the navigation that triggered it. A plain
/// wrapper `View` (rather than reading `host` straight off `ShellRootView`) because
/// `@ObservedObject` cannot wrap an OPTIONAL `ShellSessionHost?` directly; this is the same
/// "observe through a non-optional child" shape `ShellRootView.detail`'s own `if let host { … }`
/// branches already use for `ShellSessionView`.
struct HopAwayBannerHost: View {
    @ObservedObject var host: ShellSessionHost
    @ObservedObject var directory: SessionDirectory

    var body: some View {
        if let prompt = host.hopAwayPrompt {
            HopAwayBackgroundBar(
                title: sessionDisplayTitle(directory.rows.first(where: { $0.sessionId == prompt.sessionId })?.title),
                onKeepWorking: { host.confirmHopAwayBackground() },
                onDismiss: { host.dismissHopAwayPrompt() }
            )
            .padding(.bottom, 20)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .animation(.easeOut(duration: 0.18), value: prompt)
        }
    }
}

/// The bar itself — GALLERY EXTENSION POINT: no first-party pattern exists for this moment
/// (`ActivityMenu.swift`'s own doc: the phone's activity surface is still on its debt list), and a
/// DISMISSIBLE INLINE BAR was chosen over an auto-timed toast deliberately — it needs no clock seam
/// to test (its whole behavior is two callbacks), and "the daemon already protects the turn" (T3's
/// header verb, the auto-background semantics) means there is no urgency a timer would need to
/// convey; the user loses nothing by dismissing it, or by never seeing it at all.
struct HopAwayBackgroundBar: View {
    let title: String
    let onKeepWorking: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "moon.stars")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text("\(title) is still running")
                    .font(Typography.label(.medium))
                Text("Keep it going unattended?")
                    .font(Typography.caption())
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 12)
            Button("Keep working in background", action: onKeepWorking)
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            Button(action: onDismiss) {
                Image(systemName: "xmark")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        // chatgpt-ui T3 clash sweep (spec §4 + the "no glass anywhere in the main window" gate
        // seed): this bar floats INSIDE the shell over the new flat surfaces — `.regularMaterial`
        // was the last glass in the window. Flat `windowBackgroundColor` card + the shell's own
        // 1 pt quaternary stroke vocabulary (the search field / new-chat composer card); radius
        // and shadow unchanged — a minimal deglass, not a restyle. Both appearances follow the
        // system colors by construction.
        .background(Color(nsColor: .windowBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.quaternary, lineWidth: 1))
        .shadow(radius: 8)
        .padding(.horizontal, 24)
    }
}
