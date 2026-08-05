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

    init(directory: SessionDirectory, makeFeed: @escaping FeedFactory) {
        self.directory = directory
        self.makeFeed = makeFeed
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
    func apply(destination: ShellDestination) {
        if case .session(let sessionId) = destination {
            select(sessionId)
        } else {
            deselect()
        }
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
        live.feedTask?.cancel()
        live.feedTask = nil
        live.feed.stop()
        attachment = nil
        attachedSessionId = nil
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
