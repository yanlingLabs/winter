import Combine
import Foundation

/// browser-runtime T5: **the assembly point** — the one place the app's own state becomes
/// `BrowserSignals` + `[BrowserTabState]`, and the only caller of `BrowserLifecycleEngine.plan`.
///
/// Spec §4 (the signal table) and §8 (the belt). The shape is deliberately three lines long:
/// gather → `plan` → `BrowserRuntime.apply`. Everything hard is on either side of it — the policy
/// is `BrowserLifecycle.swift`'s and the mechanics are `BrowserRuntime.swift`'s — so this file has
/// exactly two jobs of its own: **describe the world honestly**, and **make sure a re-plan
/// happens**.
///
/// **It contains no policy, and that is a rule rather than an aspiration.** Nothing here decides
/// whether a browser should exist, live, stop or move; if an integration pressure ever seems to
/// need a special case, that is a gap in the ENGINE and belongs there. The two derivations that
/// look like judgement calls are both re-uses of decisions the app had already made elsewhere, and
/// each names where:
///   * which tab a session SHOWS is `panelShownTab` — the pure function `ShellPanel` renders from,
///     so the engine's viewport choice and the panel's rendered tab cannot disagree;
///   * which sessions exist and what tabs they have is `PanelStore`'s fold, unmodified.
///
/// ## Re-plan triggers
///
/// A plan is a snapshot; a stop only happens because a LATER plan saw the signal go quiet. So the
/// full set of things that must provoke one is part of this file's contract, not an implementation
/// detail:
///
///  1. **Every fold** (`PanelStore.onFold`) — spec §8 states the belt per fold, and three of the
///     four fold sites are the only ways a tab can leave a list or a session can stop being shown.
///  2. **The session list** (`SessionDirectory.$rows`) — the poll and every lifecycle broadcast.
///     This is where another harness attaching, a turn ending, or an archive lands.
///  3. **The attached session's turn state** (`SessionModel.$state.turnRunning`) — the local,
///     immediate half of `working`, which the daemon's derived label does not carry for chat.
///  4. **The shell window's visibility** (`ShellSessionHost.onShellVisibilityApplied`).
///  5. **A linger deadline** (`BrowserRuntime.onLingerDeadline`) — the executor asking the engine
///     to look again; the stop is still the engine's to decide.
///
/// ## The hidden-window guarantee (ledger obligation #4)
///
/// `hold` emits no actions, so a session whose signals FREEZE while held keeps its browsers
/// forever. Before this task the freeze was real and reachable: the `session.list` poll is gated on
/// the shell window being on screen (`SessionDirectory.setPolling`, driven by
/// `AppWindowController.onRenderingActiveChange`), so a window closed mid-turn stopped refreshing
/// the only signal that could ever say the turn had ended.
///
/// `syncPolling()` below opens that gate on a second, narrow condition: **whenever the runtime has
/// a live browser, the poll runs regardless of window state.** A dedicated timer was the
/// alternative and is worse — it would be a SECOND producer of `session.list` refreshes with its
/// own cadence, and the refresh is not the point in itself: what closes the loop is that
/// `SessionDirectory.refresh()` republishes `rows`, which is already trigger 2. One mechanism, one
/// cadence, and the gate closes again by itself the moment the last browser stops.
@MainActor
final class BrowserSignalsCoordinator {

    private let host: ShellSessionHost
    private let runtime: BrowserRuntime
    /// The plan's clock. The engine never reads one (`plan(now:)` is a parameter) and neither does
    /// this — it passes the caller's, so a test drives the linger without waiting 300 seconds.
    private let now: () -> Date

    private var cancellables = Set<AnyCancellable>()

    /// The session the panel is displaying, or — once nothing is displayed **because the window
    /// went away** — the one it was displaying when that happened. `nil` otherwise.
    ///
    /// Needed because hiding the shell window DETACHES (`ShellSessionHost.applyPolicy` → the
    /// policy table's hidden row), which clears `PanelStore.currentSessionId` before this
    /// coordinator ever runs — so by the time a re-plan happens, "the session the window was
    /// viewing" exists nowhere else. Spec §4's window-close rule is stated about exactly that
    /// session.
    ///
    /// **"Last displayed while the window was open" would be a different, wrong thing**, and the
    /// difference is reachable: view a session, navigate to the dashboard (which detaches and
    /// un-displays it while the window is still open), then close the window. Spec §4 grants the
    /// linger skip to the session the window was VIEWING; that one was already abandoned and is
    /// entitled to its 300 seconds like any other. So a pass that finds nothing displayed **while
    /// the window is open** clears this — the user left the session, the window did not.
    private var lastPanelSessionId: String?

    /// `AppWindowController.isRenderingActive`, mirrored — the poll's ORIGINAL gate, which this
    /// coordinator now unions with "a browser is live" (see the type doc). Starts `false`: nothing
    /// is on screen until the first `setRenderingActive(true)`, which is exactly what
    /// `AppShellTests`' "no polling before the shell is ever summoned" pins.
    private var renderingActive = false

    /// The session list, **as delivered to the subscription** rather than read back off
    /// `SessionDirectory.rows`.
    ///
    /// `@Published` sends its value from `willSet`, so a sink that reads the property it is
    /// subscribed to gets the OLD array — the new one has not been stored yet. Reading it that way
    /// makes every activity change land exactly one publication late, which for this coordinator
    /// means the plan that should stop a session's browsers is computed from the very signals that
    /// were true before the change: the poll answers "the turn ended", the re-plan reads "the turn
    /// is running", and nothing ever stops. (`ShellSessionHost.reconcileIsChatSession` takes its
    /// rows as a parameter for the same reason.)
    private var latestRows: [SessionSummary] = []

    /// `host.attachedSessionId` as of the last pass, so a pass can notice that this shell has
    /// stopped being some session's attachment.
    private var previousAttachedSessionId: String?

    /// Sessions whose row-level `"active"` this shell must NOT read as "another harness is here".
    ///
    /// `session.list`'s `activity` is derived from `SessionHub.attachedCount` — it counts THIS
    /// shell's own harness like any other, so `"active"` on a row this shell was attached to when
    /// the daemon answered is our own reflection, not the phone. While we are still attached that
    /// is harmless (`attachedHere` says the same thing and the engine holds either way); the moment
    /// we DETACH it is not, because a stale reflection then reads as `attachedElsewhere`, and
    /// `attachedElsewhere` beats `stopImmediately` by design — a window closed on a playing page
    /// would keep playing until the list happened to be re-read.
    ///
    /// **Cleared by the next `$rows` PUBLICATION — which is usually a full `session.list` answer but
    /// is not always one.** `SessionDirectory.handle` patches a single row in place for
    /// `session_activity` and `session_titled` (`SessionDirectory.swift`), and `@Published` publishes
    /// on any assignment, so an activity event about an UNRELATED session drops this suppression
    /// while the stale reflection it was suppressing still stands. Both ends are bounded by one poll
    /// interval — the next real answer settles it — and the two errors point opposite ways: an early
    /// clear defers a window-close stop (the page keeps playing), a late clear is Case A below.
    ///
    /// **This is NOT "never a wrong stop", and here is the case that isn't** (review round 1,
    /// Important-1). A session **co-attached by this shell and the phone**, no turn running, window
    /// closing:
    ///
    ///   1. the row reads `"active"` — correctly, because the phone is on it;
    ///   2. the close detaches us, so this suppression is armed for that session;
    ///   3. `attachedElsewhere` is therefore suppressed to `false`, nothing else holds it, and
    ///      `stopImmediately` carries a `.stopNow` — **a stop spec §4 row 2 forbids**;
    ///   4. the next publication clears the suppression, the row still says `"active"` (the phone
    ///      never left), so the session is `hold` again and engine rule 8 RE-CREATES its shown tab.
    ///
    /// So the honest bound is: **a wrong stop followed by a re-create, for a session another harness
    /// is also attached to, converging within one poll interval.** The daemon cannot rescue it —
    /// `SessionHub.emitActivity` suppresses an emit when the derived state is unchanged
    /// (`packages/core/src/sessions/hub.ts`), and with the phone still attached our detach changes
    /// nothing, so no `session_activity` arrives to correct the row sooner.
    ///
    /// It is disclosed rather than designed away because the alternative is worse in the common
    /// case: not suppressing at all makes EVERY window close on a page this shell alone was
    /// attached to read as `attachedElsewhere` and keep playing — the audio surprise this whole plan
    /// opened with, and spec §10 gate 4. Pre-B2 the blast radius here is a headless reload of a page
    /// nothing renders (the phone sees tab state, not a viewport — spec §7); the day an agent drives
    /// these pages it becomes a real interruption and wants a signal that separates our own
    /// attachment from anyone else's, which `session.list` does not carry today.
    private var ownAttachmentStillCountedIn: Set<String> = []

    /// What was last asked of `SessionDirectory.setPolling`. **The change-guard is load-bearing,
    /// not tidiness:** `setPolling(active: true)` cancels the outstanding loop and starts a fresh
    /// one, so calling it again on every re-plan would reset the 5-second wait every time and the
    /// poll would never tick at all — the exact opposite of what obligation #4 asks for.
    private var pollActive = false

    /// Wires the runtime's two callbacks FIRST, then subscribes, then plans once.
    ///
    /// **The order of the first two lines is ledger obligation #6**, and both halves have teeth.
    /// `host` is read by `BrowserRuntime.wire` at CREATE time and bound onto the tab's model: a
    /// browser created before it is set records no navigations at all, and nothing rebinds a model
    /// for a parked browser nobody renders. `onLingerDeadline` is how an armed stop ever gets
    /// re-examined: without it the runtime logs and the session's browsers live forever.
    /// Assigning them in `init`, above the first `replan()`, is what makes "before the first
    /// `apply`" structural rather than a convention someone has to remember.
    init(host: ShellSessionHost, runtime: BrowserRuntime, now: @escaping () -> Date = Date.init) {
        self.host = host
        self.runtime = runtime
        self.now = now

        runtime.host = host
        runtime.onLingerDeadline = { [weak self] _ in self?.replan() }

        // Trigger 1. See `PanelStore.onFold` for why this is a hook rather than a `$tabs` sink.
        host.panelStore.onFold = { [weak self] in self?.replan() }

        // Trigger 4.
        host.onShellVisibilityApplied = { [weak self] in self?.replan() }

        // Trigger 2. `refresh()` assigns `rows` wholesale on every successful poll, so this fires
        // once per tick even when nothing about the list changed — which is the point: it is the
        // heartbeat that re-examines a held session while the window is hidden.
        host.directory.$rows
            .sink { [weak self] rows in
                // The value comes from the SUBSCRIPTION, never from `directory.rows` — see
                // `latestRows` for the `willSet` trap that makes the difference between a stop that
                // happens and one that never does. Combine delivers the current value on subscribe,
                // so this is populated before the first plan below.
                self?.latestRows = rows
                // A full answer re-describes every row, including the ones this shell's own
                // attachment was being counted in. NOT every publication is a full answer — see
                // `ownAttachmentStillCountedIn` for the in-place single-row patches that reach here
                // too, and for what clearing early and clearing late each cost.
                self?.ownAttachmentStillCountedIn.removeAll()
                self?.replan()
            }
            .store(in: &cancellables)

        // Trigger 3. `$attachment` republishes on attach and detach but NOT on a hop (a hop keeps
        // the same `ShellSessionAttachment` object — its own doc comment), which is fine: the hop
        // re-plans through trigger 1 anyway, and `switchToLatest` keeps following whatever
        // attachment is current. `removeDuplicates` is what keeps a streamed reply from re-planning
        // once per token — `session.$state` publishes on every delta, and only `turnRunning` here
        // is a browser signal.
        host.$attachment
            .map { attachment -> AnyPublisher<Bool, Never> in
                guard let attachment else { return Just(false).eraseToAnyPublisher() }
                return attachment.session.$state.map(\.turnRunning).eraseToAnyPublisher()
            }
            .switchToLatest()
            .removeDuplicates()
            .sink { [weak self] _ in self?.replan() }
            .store(in: &cancellables)

        replan()
    }

    /// `AppWindowController.onRenderingActiveChange`'s new home. It no longer drives
    /// `SessionDirectory.setPolling` directly — this coordinator owns the union of that signal with
    /// "a browser is live" (see the type doc's hidden-window section). The window's own gate is
    /// unchanged in every other respect: `shellRenderingActive` still decides it, and a shell with
    /// no live browser polls exactly when it did before.
    func setRenderingActive(_ active: Bool) {
        renderingActive = active
        syncPolling()
    }

    // MARK: - The pass

    /// Gather → plan → apply. Idempotent by construction: it reads state, it never accumulates any.
    func replan() {
        let (sessions, tabs) = assemble()

        let actions = BrowserLifecycleEngine.plan(sessions: sessions,
                                                  tabs: tabs,
                                                  live: runtime.liveTabIds,
                                                  viewport: runtime.viewportTabId,
                                                  pendingStops: runtime.pendingStopDeadlines,
                                                  lruOrder: runtime.lruOrder,
                                                  now: now())

        // The reverse index the executor needs to bind a created tab's model to its session. Built
        // from the same `tabs` the plan was computed from, so a `.create` can never be attributed to
        // a session the plan did not see.
        var sessionOf: [String: String] = [:]
        for (sessionId, list) in tabs {
            for tab in list { sessionOf[tab.tabId] = sessionId }
        }

        runtime.apply(actions, tabs: tabs, sessionOf: { sessionOf[$0] })

        // After `apply`, because the live set is what the gate reads and this pass may have just
        // created the first browser or stopped the last one.
        syncPolling()
    }

    /// The whole of the signal assembly, and the only place in the app that knows how the shell's
    /// state maps onto the engine's vocabulary.
    private func assemble() -> (sessions: [String: BrowserSignals], tabs: [String: [BrowserTabState]]) {
        let displayed = host.panelStore.currentSessionId
        if let displayed {
            lastPanelSessionId = displayed
        } else if host.shellVisible {
            // Nothing displayed and the window is still open: the session was left, not closed on.
            // See `lastPanelSessionId` for why that must not read as a window close.
            lastPanelSessionId = nil
        }

        // This shell has stopped being some session's attachment (a hop, a detach, a window close).
        // Its row's `"active"` was answered while we were still counted in it.
        if previousAttachedSessionId != host.attachedSessionId {
            if let departed = previousAttachedSessionId { ownAttachmentStillCountedIn.insert(departed) }
            previousAttachedSessionId = host.attachedSessionId
        }

        // Which sessions the daemon says are running a turn / attached elsewhere / archived, read
        // fresh off the sidebar's own rows. See `mapped(activity:)` below for the mapping and for
        // what it CANNOT answer.
        var activityBySession: [String: String] = [:]
        for row in latestRows {
            if let activity = row.activity { activityBySession[row.sessionId] = activity }
        }

        // The local half of `working`: the shell is attached to this session and its harness says a
        // turn is running. `attachedSessionId`, not `displayed` — the new-chat page's bound session
        // is displayed with nothing attached, so it has no turn state to read.
        let attachedTurnRunning = host.attachment?.session.state.turnRunning ?? false

        var sessions: [String: BrowserSignals] = [:]
        var tabs: [String: [BrowserTabState]] = [:]

        // EVERY session this shell has folded, not merely the displayed one. The §8 belt asks
        // "which live browsers belong to no tab of any session", and a browser parked for a session
        // the user hopped away from must find its tab list here or the belt stops it on the spot —
        // which would make hopping away a reload, the exact thing this plan exists to prevent.
        for (sessionId, state) in host.panelStore.allSessionTabStates {
            let activity = activityBySession[sessionId]
            let attachedHere = sessionId == displayed

            // **Obligation #2, and the one place it is subtler than "read `activeTabId`".** The
            // engine's `isShown` is per SESSION, never "on screen" — every session has at most one,
            // including the ones nobody is looking at, which is what makes lazy restore expressible
            // for a session waking up in the background.
            //
            // `panelShownTab` — the pure function `ShellPanel` renders from — is the app's ONE
            // answer to "which tab does this session show", and using it here is what stops the
            // engine and the renderer from disagreeing. Its fallback ("no active tab → the first
            // one") is not a nicety: `panel.closeTab` appends `panel_tab_closed` and nothing else
            // (`packages/core/src/ipc/server.ts` — deliberate; `panel.openTab` activates, close does
            // not), and `foldPanelTabs` clears `activeTabId` when the ACTIVE tab is the one closed.
            // So after closing the active tab a session has tabs and no `activeTabId` until the user
            // clicks one. Reading `activeTabId` literally would leave the engine creating nothing
            // and detaching the viewport while the panel rendered — and highlighted — a tab.
            let shownTabId = panelShownTab(tabs: state.tabs, activeTabId: state.activeTabId)?.tabId

            // **Obligation #1: `.web` tabs only.** The engine has no concept of `PanelTabKind`; a
            // `.document` tab handed to it would get a browser created for it. The shown-tab
            // resolution above runs over the FULL list first, deliberately: if the session's shown
            // tab is a document, no web tab is shown, and the engine creates nothing eagerly — the
            // same answer the panel gives by rendering that document's placeholder.
            tabs[sessionId] = state.tabs.filter { $0.kind == .web }.map { tab in
                BrowserTabState(tabId: tab.tabId,
                                url: tab.url,
                                isShown: tab.tabId == shownTabId,
                                // Obligation #5. Never read by the engine — it is here for
                                // `NormaCEFSeedTabState`, which primes the navigation channel's
                                // dedupe with the (url, title) PAIR; seeding an empty title lets
                                // every restore re-report a navigation the log already holds.
                                title: tab.title)
            }

            sessions[sessionId] = BrowserSignals(
                attachedHere: attachedHere,
                // "active" means the daemon counts at least one attached harness — and it counts
                // OURS. So it is evidence of somebody else (the phone, a detached window, the CLI)
                // only when this shell is neither the attachment now nor the attachment the answer
                // was taken during; see `ownAttachmentStillCountedIn` for why the second clause is
                // needed and what it costs.
                attachedElsewhere: activity == "active"
                    && sessionId != host.attachedSessionId
                    && !ownAttachmentStillCountedIn.contains(sessionId),
                working: (sessionId == host.attachedSessionId && attachedTurnRunning)
                    || activity == "background",
                archived: activity == "archived",
                // **Obligation #3: it stays SET for as long as the window remains closed**, which
                // is what makes the stop actually happen for a session that was mid-work when the
                // window went away: `hold` beats `stopImmediately` (never stop mid-work), so the
                // stop lands on the LATER plan that sees the work end — and that plan must still
                // see this flag. Derived from live state rather than latched at close time for
                // exactly that reason, and it clears itself the moment the window comes back.
                stopImmediately: !host.shellVisible && sessionId == lastPanelSessionId)
        }

        return (sessions, tabs)
    }

    // MARK: - The poll gate (obligation #4)

    /// The union gate. See the type doc for why this, and not a second timer.
    private func syncPolling() {
        let active = renderingActive || !runtime.liveTabIds.isEmpty
        guard active != pollActive else { return }
        pollActive = active
        host.directory.setPolling(active: active)
    }
}
