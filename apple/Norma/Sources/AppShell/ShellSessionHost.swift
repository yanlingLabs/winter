import AppKit
import Combine
import NormaKit
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

    /// The typed first message, parked between the create's success and its delivery on the
    /// created session's OWN attach (`deliverPendingFirstMessage`, composed onto the pinned
    /// feed's post-attach `onConnected` — `SessionFeed.start()`'s pinned branch awaits the attach
    /// ack BEFORE firing it, which is what makes create → attach → send hold in wire order with
    /// no sequencing on this side). Keyed by sessionId so it can only ever deliver into the
    /// session it was typed for. Single-slot by construction: a second new-chat flow cannot start
    /// while one is in flight (`sendFirstChatMessage`'s `.creating` block), and delivery consumes
    /// the slot on the very attach the create's own navigation triggers.
    private var pendingFirstMessage: (sessionId: String, text: String)?

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
    /// - **Create lands after the user navigated away:** still navigates onto the session — the
    ///   send is a commitment, and it can only deliver through the session's attach; swallowing
    ///   it would be a silent maybe-never send.
    func sendFirstChatMessage(_ text: String, onCreated: @escaping (String) -> Void) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard newChatCreate != .creating else { return } // double-send: one create, ever
        guard let client = managementClient else {
            newChatCreate = .failed(newChatUnreachableMessage)
            return
        }
        newChatCreate = .creating
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let created = try await client.createSession(scope: "global", approvalPolicy: "auto", mode: "chat")
                // Parked BEFORE `onCreated`: the navigate inside it drives apply → select →
                // attachFresh SYNCHRONOUSLY, and attachFresh must already see the pending text
                // to seed the adapter's composer. Do not reorder.
                self.pendingFirstMessage = (created.sessionId, trimmed)
                self.newChatCreate = .idle
                onCreated(created.sessionId)
            } catch let error as RpcError {
                self.newChatCreate = .failed(error.message)
            } catch {
                self.newChatCreate = .failed(newChatUnreachableMessage)
            }
        }
    }

    /// The delivery half: fires on the pinned feed's post-attach `onConnected` (see
    /// `pendingFirstMessage`'s doc for the ordering guarantee). Sends over the ATTACHED harness —
    /// the daemon refuses `session.send` on a connection that hasn't attached (`ipc/server.ts`:
    /// "no send path around it"), which is exactly why this cannot ride the management client.
    /// On success the seeded composer clears — but only if it still holds the pending text
    /// verbatim, so a user already typing their SECOND message never has it eaten. On failure the
    /// draft stays: the text is visible in the composer, one Enter away from a retry — the same
    /// clear-only-on-success contract `submit` keeps.
    private func deliverPendingFirstMessage(for sessionId: String) {
        guard let pending = pendingFirstMessage, pending.sessionId == sessionId,
              attachedSessionId == sessionId, let live = attachment else { return }
        pendingFirstMessage = nil
        let client = live.feed.client
        Task { @MainActor [weak self] in
            let ok = (try? await client.send(sessionId: sessionId, text: pending.text)) != nil
            guard ok, let self, self.attachedSessionId == sessionId,
                  let adapter = self.attachment?.adapter, adapter.composerDraft == pending.text else { return }
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
            // `sendFirstChatMessage`'s own doc for the navigate-after-departure decision).
            dispatchResolutionToken += 1
            dispatchResolution = .idle
            if newChatCreate != .creating { newChatCreate = .idle }
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

    /// Called by `AppWindowController` on every CHANGE of the window's on-screen state.
    func setShellVisible(_ visible: Bool) {
        guard shellVisible != visible else { return }
        shellVisible = visible
        applyPolicy()
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
        // chatgpt-ui T2: the first-message carry (spec §2 — "composer content carries over; no
        // flicker"). The pending text shows in the attached composer from the very first frame
        // and clears only when the send actually lands (`deliverPendingFirstMessage`) — so the
        // hop from the new-chat page never shows an empty beat, and a failed send leaves the
        // text exactly where the user can retry it.
        if let pending = pendingFirstMessage, pending.sessionId == sessionId {
            adapter.composerDraft = pending.text
        }
        // Forward this harness's session events to the SHARED directory — the same side-observer
        // composition `DetachedWindowController` uses, and `false` for the same reason: the pinned
        // feed's own default application (apply events matching the pinned id + every connection
        // state) must still run. This is also how a `session_activity` transient for the session the
        // shell is showing reaches the directory at all: it is broadcast to that session's
        // ATTACHMENTS, which is this socket, not the orb's.
        made.feed.onEvent = { [weak self] event in
            if case .session(let e) = event { self?.directory.handle(e) }
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
        let live = ShellSessionAttachment(feed: made.feed, session: made.session, adapter: adapter)
        attachment = live
        attachedSessionId = sessionId
        refreshOutputFiles(for: sessionId)
        openOutputFile = nil
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
        attachedSessionId = sessionId
        refreshOutputFiles(for: sessionId)
        openOutputFile = nil
        // Everything the OLD session's identity decided has to be re-derived or dropped, exactly as
        // an in-place switch does elsewhere: a different session means a different mode, a different
        // pinned model/effort, and refusals that were about the session the user just left.
        live.adapter.isChatSession = Self.isChatSession(sessionId, in: directory.rows)
        live.adapter.pendingModel = .none
        live.adapter.pendingEffort = .none
        live.adapter.selectionProbation = nil
        live.adapter.dirsRefusal = nil
        // A refusal is about the session it was refused FOR — "session is archived — resume it
        // first" rendered over a different session is a lie about a rule (the `dirsRefusal` lesson).
        live.adapter.activityRefusal = nil
        Task { @MainActor in await live.feed.repin(to: sessionId) }
    }

    /// Detach = close the socket. There is no `session.detach` RPC (the protocol has never had one);
    /// the daemon detaches a connection's hub client in its socket `close(...)` handler, which is
    /// the same `hub.detach` — and therefore the same app-kind, never-aborting `onDetached` — a hop
    /// goes through. `NormaClient.close()` finishes its event stream for good, so the next attach
    /// mints a fresh harness rather than reviving this one.
    private func detachCurrent() {
        guard let live = attachment else {
            attachedSessionId = nil
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
        live.feedTask?.cancel()
        live.feedTask = nil
        live.feed.stop()
        attachment = nil
        attachedSessionId = nil
        outputFiles = []
        openOutputFile = nil
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
    }

    // MARK: - The hosted view's wiring

    /// The `SidebarWiring` the hosted `WindowContentView` renders. RIGHT-ONLY: the shell's own
    /// `NavigationSplitView` sidebar is the session switcher, so the inner left column is opted out
    /// of (`showsSessionSwitcher: false`) and the work column keeps everything else.
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
                guard let target = childSessionId ?? self?.attachedSessionId else { return }
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
                guard let target = childSessionId ?? self?.attachedSessionId else { return }
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
                guard let sid = self?.attachedSessionId else { return }
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
                if ok { adapter?.sessionPolicy = policy }
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

// MARK: - The hosted surface

/// The shell's session surface: the shared `WindowContentView`, in its right-only configuration.
///
/// GALLERY EXTENSION POINT: `norma-ios/docs/ios26-design-gallery` has no transcript-in-a-split-view
/// geometry (the phone's chat is always full-bleed), so what transfers here is the CONTENT — the
/// same header row, transcript, cards, composer and work column every other Norma window renders —
/// while the framing is the Mac's own: no self-drawn chrome, no `.ignoresSafeArea()`, because the
/// split view's detail column already sits correctly under the window's unified toolbar.
struct ShellSessionView: View {
    @ObservedObject var host: ShellSessionHost
    /// cli-handoff T3: the shared directory, observed HERE (not through `host`, whose reference to
    /// it is a plain `let` no view re-renders on) so the toolbar action's eligibility gate re-reads
    /// the live wire row — a row that archives out from under an open session drops the affordance
    /// the moment the fold lands, not on the next unrelated republish.
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
                        // The detail column is already inset below the toolbar (unlike a detached
                        // window, which bleeds under its own hidden titlebar and pays 52pt for it) —
                        // this is the plain breathing room above the header row. Tune-at-gate constant.
                        topInset: 8,
                        sidebars: host.sidebarWiring
                    ) {
                        EmptyView()
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
            // cli-handoff T3: the open-session "Move to CLI" action — SHELL-OWNED chrome. It lives
            // on THIS view, never inside the shared `WindowContentView` (the orb's morph window and
            // every detached window host that view too, and they gain NOTHING here — the plan's
            // shell-owned-placement constraint), so the window toolbar grows the action only while
            // the shell itself is showing an eligible session. Gated on the ATTACHED session's live
            // wire row through the same ONE function as the landing rows' context-menu item
            // (`moveToCliOffered`) — which is also what keeps it absent on `DispatchSurface`'s
            // hosting of this view (the dispatch singleton's row is mode "dispatch").
            .toolbar {
                if let sessionId = host.attachedSessionId,
                   moveToCliOffered(row: directory.rows.first(where: { $0.sessionId == sessionId })) {
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            host.moveToCli(sessionId: sessionId)
                        } label: {
                            Label("Move to CLI", systemImage: "terminal")
                        }
                        .help("Open Terminal in this session's folder, attached to this session")
                        .accessibilityLabel("Move to CLI")
                    }
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
            Image(systemName: "text.bubble")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(.tertiary)
            Text("This session isn't open")
                .font(.title2)
            Text("Norma couldn't reach the daemon for it. It opens as soon as the connection is back.")
                .font(.callout)
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
                    .font(.system(size: 12, weight: .medium))
                Text("Keep it going unattended?")
                    .font(.system(size: 11))
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
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .shadow(radius: 8)
        .padding(.horizontal, 24)
    }
}
