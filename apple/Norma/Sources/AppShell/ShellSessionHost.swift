import AppKit
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

    init(directory: SessionDirectory, makeFeed: @escaping FeedFactory, managementClient: NormaClient? = nil) {
        self.directory = directory
        self.makeFeed = makeFeed
        self.managementClient = managementClient
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
        adapter.isChatSession = Self.isChatSession(sessionId, in: directory.rows)
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
        made.feed.onConnected = { [weak self] in self?.refreshModelCatalogue() }
        let live = ShellSessionAttachment(feed: made.feed, session: made.session, adapter: adapter)
        attachment = live
        attachedSessionId = sessionId
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

    /// One implementation of "is this session chat", deliberately shared with the detached window's
    /// own in-place switch rather than re-written here — including its documented "false when the
    /// row isn't loaded yet" default.
    private static func isChatSession(_ sessionId: String, in rows: [SessionSummary]) -> Bool {
        DetachedWindowController.isChatSession(sessionId, in: rows)
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

    var body: some View {
        if let attachment = host.attachment {
            WindowContentView(
                adapter: attachment.adapter,
                tint: Color(red: 0.45, green: 0.75, blue: 1.0),
                // The detail column is already inset below the toolbar (unlike a detached window,
                // which bleeds under its own hidden titlebar and pays 52pt for it) — this is the
                // plain breathing room above the header row. Tune-at-gate constant.
                topInset: 8,
                sidebars: host.sidebarWiring
            ) {
                EmptyView()
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
