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
///
///     **Only a full answer carries new SIGNALS** (b2-agent-browser T1). `SessionDirectory.handle`
///     patches a row in place for the `session_activity` transient, which re-plans (any assignment
///     publishes) but updates the LABEL alone — the event carries nothing else, and synthesising
///     signals from it would be the label-decoding this task removed, wrong for chat besides (chat
///     never emits it). So a remote attach/detach reaches this coordinator on the next `session.list`
///     tick, ≤5s, against a 300s linger — and `syncPolling` keeps that tick running with the window
///     shut whenever a browser is live, which is the case that would otherwise never converge.
///  3. **The attached session's turn state** (`SessionModel.$state.turnRunning`) — the local,
///     immediate half of `working`. Since b2-agent-browser T1 the daemon reports the other half for
///     every mode (`SessionSummary.signals`), so this is no longer chat's ONLY working signal; it is
///     still the one that arrives without waiting for a poll.
///  4. **The shell window's visibility** (`ShellSessionHost.onShellVisibilityApplied`). On a CLOSE
///     this one fetches a fresh `session.list` before it plans — live-gate fix F, see
///     `shellVisibilityChanged`, which is the only asynchronous trigger of the five.
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

    /// live-gate fix G: the renderer-RSS total behind `plan(memoryBytesByTab:)`. Supplying the
    /// engine's inputs is this file's job; deciding what to do with them is not — the budget, the
    /// backstop and every rule that spends them live in `BrowserLifecycle.swift`.
    ///
    /// A CLOSURE rather than the sampler itself, so a test can hand over a number instead of a
    /// process: `BrowserMemorySampler`'s refresh is a detached `ps` sweep, and a suite that let the
    /// real one through would spawn one per world and then have to wait for it. The sampler's own
    /// two decisions — the throttle and the equal share — are pinned directly
    /// (`BrowserMemoryTests`), which is where they are actually visible.
    private let memoryBytes: @MainActor () -> UInt64

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
    /// makes every signal change land exactly one publication late, which for this coordinator
    /// means the plan that should stop a session's browsers is computed from the very signals that
    /// were true before the change: the poll answers "the turn ended", the re-plan reads "the turn
    /// is running", and nothing ever stops. (`ShellSessionHost.reconcileIsChatSession` takes its
    /// rows as a parameter for the same reason.)
    private var latestRows: [SessionSummary] = []

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
    init(host: ShellSessionHost, runtime: BrowserRuntime, now: @escaping () -> Date = Date.init,
         memoryBytes: (@MainActor () -> UInt64)? = nil) {
        self.host = host
        self.runtime = runtime
        self.now = now
        // Defaulted so the app's one construction site stays a single line. The sampler takes `now`
        // with it: one clock for the whole coordinator, so nothing refreshes on a schedule the
        // caller cannot reach.
        let sampler = BrowserMemorySampler(now: now)
        self.memoryBytes = memoryBytes ?? { sampler.totalBytesRefreshingIfStale() }

        runtime.host = host
        runtime.onLingerDeadline = { [weak self] _ in self?.replan() }

        // Trigger 1. See `PanelStore.onFold` for why this is a hook rather than a `$tabs` sink.
        host.panelStore.onFold = { [weak self] in self?.replan() }

        // Trigger 4. Not a bare `replan()` since live-gate fix F — see `shellVisibilityChanged`.
        host.onShellVisibilityApplied = { [weak self] in self?.shellVisibilityChanged() }

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

    // MARK: - The window close (live-gate fix F)

    /// **Trigger 4, split in two: the window OPENING re-plans at once; the window CLOSING fetches a
    /// fresh session list first.**
    ///
    /// **Why it survives b2-agent-browser T1 — and why deleting it would be the worst edit anyone
    /// could make to this file.** T1 deleted the suppression this fix was written alongside, and the
    /// temptation is to read the fetch as part of the same machinery. It is not: the fetch was never
    /// about the suppression, it was about the row being STALE, and **it is now the ONLY thing that
    /// makes the close's answer current.** A stale row at the close is what plays audio out of a
    /// window the user just shut.
    ///
    /// The case it was written for — a session co-attached by this Mac and the phone, no turn
    /// running, window closing — went: the close detaches us, `ownAttachmentStillCountedIn` is armed
    /// for that session, `attachedElsewhere` is suppressed to `false`, nothing else holds the
    /// session, and `stopImmediately` carries a `.stopNow` **spec §4 row 2 forbids**. Disclosed as
    /// "a wrong stop followed by a re-create, converging within one poll interval", the user's live
    /// gate showed what it converged TO: the re-created page never resumes playback (Chromium's
    /// autoplay policy gates *initiation*, and a fresh browser has no user gesture), so the audible
    /// result was permanent silence. That failure mode is gone because the suppression is gone —
    /// **not because the daemon excludes anything this shell does.** The daemon excludes the
    /// connection that ASKED, and the asker is the orb's (`AppModel.init`'s lister), which attaches
    /// only to DISPATCH sessions (`AppModel.focusNewestSession`/`refocus`' mode gate). The shell's
    /// own attachment is not excluded at all — see `assemble` for what does make it safe.
    ///
    /// What remains is the ordinary staleness a poll always has, and this closes it: by the time
    /// this hook runs, `applyPolicy()` has detached this shell (`ShellSessionHost.setShellVisible`
    /// calls it before firing the hook — what that ordering was always for), so a list fetched NOW
    /// carries the truth. The phone still attached reads `attachedElsewhere` → **hold**; nobody
    /// attached reads both signals false → `stopImmediately` → **stop**, exactly as designed.
    ///
    /// **Three consequences, all deliberate:**
    ///
    ///  1. **The close-stop is no longer synchronous.** It costs one `session.list` round trip,
    ///     during which a genuinely abandoned page keeps playing. Milliseconds against a local
    ///     daemon, and the alternative is silencing a page the phone is using.
    ///  2. **A FAILED fetch does not strand anything.** `refresh()` swallows its own errors and
    ///     leaves `rows` untouched, so no sink-driven re-plan happens; the explicit `replan()`
    ///     below still runs, and a stale `attachedElsewhere` holds rather than stops. The browsers
    ///     are live, so `syncPolling` keeps the `session.list` poll running with the window shut
    ///     (obligation #4) and the next tick that succeeds stops them.
    ///  3. **A daemon that has not yet processed our detach** still counts this shell's own harness
    ///     (which rides its own socket — see `assemble`), so the stop is deferred by one poll
    ///     interval rather than made wrongly. The two errors point opposite ways and this is the
    ///     harmless one.
    ///
    /// Obligation #4's machinery is otherwise untouched: this is an extra *signal*, not a second
    /// poll. `refresh()` does not start, stop or reschedule `pollTask` — `setPolling` is still the
    /// only thing that does, and `syncPolling()` is still the only caller of it here.
    private func shellVisibilityChanged() {
        guard !host.shellVisible else {
            // The window came back. Nothing is stale in the direction that matters (the shown
            // session is about to be attached again) and the viewport must be given back on this
            // very pass — a round trip here would be a visible blank panel.
            replan()
            return
        }
        Task { [weak self] in
            guard let self else { return }
            // The fetch IS the fresh signal: a successful one assigns `rows`, whose sink re-plans.
            // This second call is the belt for the failed-fetch case above — and harmless
            // otherwise, since a plan reads state and accumulates none.
            await self.host.directory.refresh()
            self.replan()
        }
    }

    // MARK: - The pass

    /// Gather → plan → apply. Idempotent by construction: it reads state, it never accumulates any.
    func replan() {
        let (sessions, tabs) = assemble()

        // live-gate fix G. The sampler answers from its cache and kicks a refresh only when that has
        // gone stale, so this never blocks a plan on a `ps` sweep — see `BrowserMemorySampler` for
        // what "up to `interval` seconds old" costs and why it is the right trade for a bound whose
        // job is to stop idle accumulation. The share is computed against the SAME live set the plan
        // is given, so the map can never describe a tab the plan does not know about.
        let live = runtime.liveTabIds
        let memoryBytesByTab = BrowserMemorySampler.equalShare(totalBytes: memoryBytes(),
                                                               liveTabIds: live)

        let actions = BrowserLifecycleEngine.plan(sessions: sessions,
                                                  tabs: tabs,
                                                  live: live,
                                                  viewport: runtime.viewportTabId,
                                                  pendingStops: runtime.pendingStopDeadlines,
                                                  lruOrder: runtime.lruOrder,
                                                  memoryBytesByTab: memoryBytesByTab,
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

        // What the daemon says about each session, read fresh off the sidebar's own rows.
        //
        // **The whole row since b2-agent-browser T1, not its `activity` label.** The label is
        // withheld from chat/dispatch (`participatesInActivity`), which is the panel's own session
        // class, so reading it here answered "no signal at all" for exactly the sessions this
        // coordinator exists to describe. `row.signals` is computed for every mode and
        // `row.archived` is the mode-blind flag; see the `BrowserSignals` construction below for
        // what each one becomes.
        var rowBySession: [String: SessionSummary] = [:]
        for row in latestRows { rowBySession[row.sessionId] = row }

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
            let row = rowBySession[sessionId]
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
                // **The daemon's answer, verbatim** (b2-agent-browser T1) — including this shell's
                // OWN attachment, which it does not exclude.
                //
                // Read that plainly, because the obvious reading is wrong: the daemon does subtract
                // the connection that ASKED, but the asker here is the ORB's (`AppModel.init` closes
                // the directory's `lister` over `feed.client`) and the orb attaches only to DISPATCH
                // sessions (`AppModel.focusNewestSession`/`refocus`' mode gate). The shell window's
                // per-session harness rides a different socket (`AppDelegate`'s `makeFeed:` →
                // `makeDetachedFeed`). So for exactly the sessions this coordinator describes —
                // chat and code, in the panel — the daemon's exclusion subtracts nothing, and a row
                // fetched while this shell was attached reports our own reflection as `true`.
                //
                // **What makes reading it verbatim SAFE is not the exclusion. It is three things:**
                //
                //  1. **`attachedElsewhere` can only ever HOLD.** Walk the dispositions in
                //     `BrowserLifecycle.swift`: it appears in exactly one branch (rules 2+3, the
                //     `.hold` arm) and in no stop of any kind, and a hold emits only rule 8's create
                //     for a session's `isShown` tab plus the cancel of a pending linger. In every
                //     scenario a reflection can arise in, that tab is already live — so a stale
                //     `true` is inert, not merely tolerable.
                //  2. **Fix F** — the window close re-fetches AFTER `applyPolicy()` has detached us,
                //     so the one moment a held browser must actually stop plans against a row we are
                //     no longer in. That fetch is load-bearing; see `shellVisibilityChanged`.
                //  3. **Poll decay** everywhere else: a hop or deselect leaves the reflection
                //     standing for at most one `session.list` tick (≤5s) against a 300s linger.
                //
                // The suppression this replaced was not needed for those three, and could do harm
                // the three cannot (it produced a wrong STOP). Making the exclusion actually cover
                // this shell means listing on the shell's own connection — a wiring change, not a
                // signal one, and a named follow-up rather than something this reads around.
                attachedElsewhere: row?.signals?.attachedElsewhere ?? false,
                // Two halves, and the local one is not redundant: `signals.working` is the daemon's
                // `turnRunning || bgWork` for every mode, and `attachedTurnRunning` is the same fact
                // for THIS session arriving over the attached harness's event stream — no poll
                // interval behind it. Either one alone would be correct; both together are correct
                // and immediate.
                working: (sessionId == host.attachedSessionId && attachedTurnRunning)
                    || (row?.signals?.working ?? false),
                // The stored flag, not the label's `"archived"` — the two are the same fact
                // (`activityFor` returns "archived" for exactly this flag) but the label is withheld
                // from chat/dispatch, and an archived CHAT session used to be invisible here and sat
                // out the full 300s linger as a result.
                archived: row?.archived == true,
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
