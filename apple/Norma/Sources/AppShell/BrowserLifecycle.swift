import Foundation

/// browser-runtime T2: the lifecycle engine — the ONE place browser-lifecycle policy lives.
///
/// Spec: `docs/superpowers/specs/2026-08-10-browser-runtime-design.md` §4 (the signal table), §8
/// (the belt), §9 (why this is a pure function). The ownership inversion (§2) means no SwiftUI view
/// and no CEF call decides whether a browser exists any more: this function does, and Task 3's
/// runtime only executes what it returns. **If the executor or the signal plumbing ever wants to
/// decide something, the decision belongs here** — that is the whole reason this file is pure.
///
/// Pure means: no clock read (`now` is a parameter), no singleton, no CEF, no `@MainActor`. The
/// entire coverage of the runtime's behaviour lives in `BrowserLifecycleTests`, which needs none of
/// those things — which matters because spec §9 records that no CEF client override is callable
/// under XCTest, ever.

/// One session's inputs, as assembled by `BrowserSignalsCoordinator` (`BrowserSignals.swift`) from
/// the shell's own attach state and the sidebar's `session.list` rows. Deliberately signals, not
/// the daemon's four-state activity LABEL: chat and dispatch modes do not participate in
/// `activityFor` (`packages/core/src/sessions/activity.ts`) and the panel's auto-created sessions
/// are mode *chat*, so the label is unavailable exactly where the panel needs it.
///
/// **The signals themselves now reach the app for every mode** (b2-agent-browser T1, spec §5): the
/// daemon computes `attachedElsewhere`/`working` per `session.list` row outside the label's mode
/// gate, and the archived flag rides the row raw. The browser-runtime spec §4 T5 correction note
/// records the three degradations that existed while this app had only the label — an unattached
/// chat session's browsers stopping mid-work, a phone-attached chat session stopping, an archived
/// chat session waiting out the full linger — and all three are closed by that surface, with no
/// rule in this engine changed: better inputs, same policy.
struct BrowserSignals: Equatable {
    /// Shown in this Mac app's shell — the session whose tabs the panel is displaying.
    var attachedHere: Bool
    /// Any other harness (the phone) is attached to this session — the daemon's own count, minus the
    /// attachment of the connection that asked for the list (`SessionSummary.signals`). That asker
    /// is NOT the shell's harness, so this app's own attachment can appear here;
    /// `BrowserSignalsCoordinator.assemble` documents why reading it verbatim is safe anyway, and
    /// the answer starts with the fact that this signal can only ever hold, never stop.
    var attachedElsewhere: Bool
    /// `turnRunning || bgWork` — the agent may be driving these pages right now. The daemon's answer
    /// for every mode, OR'd with the attached harness's own live turn state (which arrives without
    /// waiting for a poll).
    var working: Bool
    /// The daemon's stored archived flag, read mode-blind off the row — NOT the `"archived"` label,
    /// which chat/dispatch never carry.
    var archived: Bool
    /// Window close. `BrowserSignalsCoordinator.assemble` sets it — as `!shellVisible && sessionId
    /// == lastPanelSessionId` — for the session the shell window was viewing when it went away, and
    /// keeps it set for as long as the window stays closed. It skips the LINGER — see `Disposition`
    /// for the precedence, which is the one place this engine sharpens the brief.
    var stopImmediately: Bool = false
}

/// One browser-backed tab of one session.
///
/// **Caller contract, met by `BrowserSignalsCoordinator.assemble`:** only tabs that *should* have a
/// browser are passed — the panel's `.web` tabs, filtered there. This engine has no concept of
/// `PanelTabKind`; a `.document` tab handed to it would get a browser created for it, and a live
/// browser whose tab is withheld from the list would be stopped
/// by the §8 belt.
struct BrowserTabState: Equatable {
    var tabId: String
    var url: String?
    /// This tab is its SESSION's shown tab — not "on screen". The daemon fold's `activeTabId`,
    /// resolved through `panelShownTab` so the engine and the panel's renderer can never name
    /// different tabs (`BrowserSignalsCoordinator.assemble` says why the fallback is reachable).
    /// Every session has at most one, including the ones nobody is looking at; that is what makes
    /// lazy restore (§6) expressible for a session waking up in the background. Only the
    /// `attachedHere` session's shown tab additionally gets the viewport.
    var isShown: Bool
    /// **Carried FOR THE EXECUTOR, never read by this engine** — no rule below mentions it, and none
    /// may: a title cannot make a browser more or less worth having.
    ///
    /// It is here because `NormaCEFSeedTabState` primes the navigation channel's dedupe memory with
    /// the (url, title) PAIR, and Task 3 reaches a tab's title through no other route: `plan`'s
    /// `tabs` argument is the executor's only per-tab lookup, and `.create` carries the url alone.
    /// Seeding an empty title would let every restore re-report a `panel_tab_navigated` the log
    /// already holds — the exact leak `NormaCEFSeedTabState` exists to stop (`NormaCEF.h`).
    /// Declared LAST, with a default, so it is invisible to every caller that does not need it.
    var title: String? = nil
}

/// What the executor must do. Six cases, no more: anything an executor could infer, it must not.
enum BrowserAction: Equatable {
    /// Ensure a live browser for this tab (Task 3 seeds it from daemon state before creating).
    case create(tabId: String, url: String?)
    case stop(tabId: String)
    /// Mount this tab's runtime-owned container in the panel's host view. Exactly one tab may hold
    /// the viewport, so a plan emits at most one of these.
    case attachViewport(tabId: String)
    case detachViewport(tabId: String)
    /// Arm the linger: re-plan when this deadline arrives. The engine never stops on the strength
    /// of having scheduled — it stops on a LATER plan whose `pendingStops` deadline has passed.
    ///
    /// **Executor obligation:** a plan that finds an UNEXPIRED pending deadline emits nothing at all
    /// for that session — not a fresh `scheduleStop`, not a `cancelScheduledStop`. So the executor
    /// must KEEP (or re-arm) its timer until it actually sees `cancelScheduledStop` for the session.
    /// A timer that fires early — a clock adjustment, a sleep/wake — must re-arm rather than be
    /// dropped, or the stop is stranded and the browsers live forever.
    case scheduleStop(sessionId: String, at: Date)
    /// Drop the session's pending deadline. Emitted both when a signal returns (the stop is
    /// cancelled) and when a deadline has just been consumed by the stops in the same plan (the
    /// deadline is spent). The executor's job is identical in both: forget the deadline.
    case cancelScheduledStop(sessionId: String)
}

struct BrowserLifecycleEngine {

    /// Spec §4: `browserStopLingerSeconds`. Quick session-hops never reload; abandoned sessions
    /// release renderers within minutes.
    static let stopLinger: TimeInterval = 300

    /// **The cap, as a MEMORY BUDGET — live-gate fix G, and the user's own design.**
    ///
    /// Spec §4 wrote it as `browserMaxLive = 8`, re-priced there from 16 by the Task 1 spike's §3
    /// correction (occlusion throttling does not exist, so a parked browser costs what a visible one
    /// costs). The count was always a proxy for the thing that actually matters, and the user named
    /// the proxy's failure exactly: *"instead of a tab cap we could do like a memory cap so for
    /// example 16 tabs that barely eat any memory can still stay alive."* A count cap charges a
    /// pinned reference page the same as a YouTube tab. This does not.
    ///
    /// **4 GiB, and it is a policy number rather than a measured one** — generous on purpose, so the
    /// budget bites on genuine accumulation and never on ordinary use. TUNABLE: this is the one
    /// place it is written, and it is where a `settings.json` key would land the day one is wanted
    /// (hot-reloadable like every other setting — nothing here caches it, `plan` reads it per pass).
    /// It is deliberately NOT a `plan` parameter: policy lives in this file, and a call site able to
    /// pass its own budget is a call site able to set policy.
    static let memoryBudgetBytes: UInt64 = 4 * 1024 * 1024 * 1024

    /// **The count BACKSTOP — a process bound, not a memory one.**
    ///
    /// Each live browser is a renderer process with its own file descriptors, IPC channels and
    /// helper-process slot, and those are finite whatever the pages weigh. A thousand `about:blank`
    /// tabs would sit inside a 4 GiB budget and still be a broken app. So the budget rule above is
    /// bounded by a count that no measurement can talk it past.
    ///
    /// **It is also the whole rule when there is no measurement at all.** An empty
    /// `memoryBytesByTab` (the sampler has not answered yet, or `ps` is unavailable) makes every
    /// byte comparison below trivially satisfied, and this is what is left — which is the correct
    /// degradation: unmeasured means "we cannot justify stopping anything for memory", not
    /// "stop everything" and not "keep everything".
    static let maxLiveBackstop = 24

    /// What this engine has decided to do with one session's browsers on this pass.
    private enum Disposition {
        /// Stop every live tab of the session now, with no linger.
        case stopNow
        /// Keep every live tab live; create the shown one if it is missing (lazy restore) — or, for
        /// the one session the shell is DISPLAYING, all of its web tabs up to the cap (rule 8b).
        case hold
        /// Nobody wants this session: arm the linger, or stop if its deadline has passed.
        case quiet
    }

    /// Signals → actions. See the rule-by-rule commentary inline; the ORDER of the returned array
    /// is a contract, documented at the `return` statement at the end of this function.
    ///
    /// - Parameters:
    ///   - sessions: sessionId → signals. A session present in `tabs` but absent here is treated as
    ///     **quiet** — the memory-safe default, and harmless: the linger is 300s and the caller's
    ///     next list refresh cancels it.
    ///   - tabs: sessionId → its browser-backed tabs in fold order (see `BrowserTabState`).
    ///   - live: tabIds that currently have a live browser.
    ///   - viewport: the tabId whose container is currently mounted in the panel, if any. Must name
    ///     a live tab; the runtime clears it when it stops that browser.
    ///   - pendingStops: sessionId → armed linger deadline.
    ///   - lruOrder: live tabIds, least-recently-used FIRST. Only consulted by the cap.
    ///   - memoryBytesByTab: **approximate** per-tab renderer memory, for the live tabs only
    ///     (live-gate fix G). Approximate is not a hedge: Chromium's site isolation shares one
    ///     renderer process between same-site tabs, so there is no exact per-tab number to have, and
    ///     the coordinator's sampler divides the helper tree's total RSS equally
    ///     (`BrowserMemory.swift`). The engine consumes it as a TOTAL and a MAXIMUM, never as a
    ///     ranking — see `capEvictions` — so a better attribution can be dropped in later without
    ///     any rule here changing. **Empty is a legitimate value** and means "no measurement": every
    ///     byte comparison is then trivially satisfied and `maxLiveBackstop` is the only bound left.
    ///     Deliberately NOT defaulted, so a new caller has to decide rather than silently get `[:]`.
    ///   - now: the caller's clock reading. The engine never takes its own.
    static func plan(sessions: [String: BrowserSignals],
                     tabs: [String: [BrowserTabState]],
                     live: Set<String>,
                     viewport: String?,
                     pendingStops: [String: Date],
                     lruOrder: [String],
                     memoryBytesByTab: [String: UInt64],
                     now: Date) -> [BrowserAction] {

        // Every session this pass knows about, in a fixed order. Sorting here is what makes rule 10
        // (determinism) hold: all three of the inputs it unions are unordered dictionaries/sets.
        let sessionIds = Set(sessions.keys).union(tabs.keys).union(pendingStops.keys).sorted()

        // ── Rule 1: the §8 belt. ────────────────────────────────────────────────────────────────
        // "The daemon's state is the truth; a browser without a tab is definitionally a leak."
        // Unconditional and first: it consults the tab LISTS, never the signals, so no protection
        // in this engine (working sessions, the viewport) can save an orphan. This is the
        // structural kill for the audio-after-close bug — the browser of a closed tab has no tab
        // list to appear in, so it cannot be missed by any code path that reaches this function.
        let ownedTabIds = Set(tabs.values.joined().map(\.tabId))
        var stopping = Set<String>()
        var beltStops: [BrowserAction] = []
        for tabId in live.subtracting(ownedTabIds).sorted() {
            beltStops.append(.stop(tabId: tabId))
            stopping.insert(tabId)
        }

        // ── Disposition, and who owns the viewport. ─────────────────────────────────────────────
        var disposition: [String: Disposition] = [:]
        var viewportSession: String?
        for sessionId in sessionIds {
            let signals = sessions[sessionId] ?? .quiet
            // `stopImmediately` NULLIFIES `attachedHere`: the window is closed, so nothing of this
            // session is on screen here, whatever a racing `attachedHere` still says. Without this,
            // a stale attach flag at window-close time would re-open the exact hole (spec §8) that
            // `stopImmediately` exists to close.
            let shownHere = signals.attachedHere && !signals.stopImmediately && !signals.archived
            if signals.archived {
                // Rule 6. The one disposition that beats every live-holding signal — the session is
                // gone, so a turn still marked running on it is not a reason to keep renderers.
                disposition[sessionId] = .stopNow
            } else if signals.working || signals.attachedElsewhere || shownHere {
                // Rules 2 + 3. Note this is checked BEFORE `stopImmediately`, which is the
                // sharpening: `stopImmediately` skips the LINGER, it does not beat spec §4's "never
                // stop mid-work: `turnRunning || bgWork` holds browsers live regardless of
                // attachment". Closing the window must not pull an agent's pages out from under a
                // running turn.
                //
                // A REQUIREMENT ON THE CALLER, not a property of this engine — and one the caller
                // now meets, so this describes the app rather than asking something of it. A
                // session that is `stopImmediately` AND held gets NO actions from this plan, so the
                // stop happens only on a LATER plan taken against FRESHLY REFRESHED signals once
                // work ends — including while the shell window is hidden. Nothing here can force
                // that: `hold` emits no `scheduleStop` (it would churn against the cancel below and
                // still needs a while-hidden timer), so if signals froze at `working = true` the
                // browsers would stay live indefinitely.
                //
                // **Who does it, and where:** `BrowserSignalsCoordinator` (`BrowserSignals.swift`).
                // It re-plans on every `SessionDirectory.$rows` publication, and — because the
                // `session.list` poll was gated on the shell window being on screen
                // (`SessionDirectory.setPolling`, driven by
                // `AppWindowController.onRenderingActiveChange`), which is exactly the freeze this
                // paragraph describes — its `syncPolling()` keeps that poll running for as long as
                // the runtime has ANY live browser, window or no window. `session_activity` events
                // do not cover chat-mode sessions, which is what the panel auto-creates (see this
                // file's header), so the list refresh is the only signal that can arrive; spec §10
                // gate 4 is what fails if it stops arriving.
                disposition[sessionId] = .hold
            } else if signals.stopImmediately {
                // Rule 5.
                disposition[sessionId] = .stopNow
            } else {
                // Rule 4.
                disposition[sessionId] = .quiet
            }
            // One shell shows one session, so at most one should ever claim `attachedHere`. Two is
            // incoherent input, not a state to model — but it must still be DECIDED identically
            // every time (rule 10), so the lowest sessionId wins and the other gets no viewport.
            if shownHere, viewportSession == nil { viewportSession = sessionId }
        }
        let desiredViewport = viewportSession.flatMap { tabs[$0]?.first(where: \.isShown)?.tabId }

        // ── Rules 2, 3, 4, 5, 6, 8: per-session stops, creates and the linger. ───────────────────
        var sessionStops: [BrowserAction] = []
        var creates: [BrowserAction] = []
        var cancels: [BrowserAction] = []
        var schedules: [BrowserAction] = []
        for sessionId in sessionIds {
            let sessionTabs = tabs[sessionId] ?? []
            let hasPendingStop = pendingStops[sessionId] != nil
            // Tabs the belt has not already claimed. (`stopping` cannot contain one of this
            // session's tabs at this point — the belt only stops tabIds absent from every list —
            // but the filter states the invariant instead of relying on it.)
            let liveTabs = sessionTabs.filter { live.contains($0.tabId) && !stopping.contains($0.tabId) }

            switch disposition[sessionId]! {
            case .stopNow:
                for tab in liveTabs {
                    sessionStops.append(.stop(tabId: tab.tabId))
                    stopping.insert(tab.tabId)
                }
                if hasPendingStop { cancels.append(.cancelScheduledStop(sessionId: sessionId)) }

            case .hold:
                // Rule 8, lazy restore (spec §6): "the shown tab eagerly, siblings on first show".
                // Only the shown tab is created; already-live siblings are simply left alone, which
                // is what "live + parked" means in the §4 table. Tabs are never stopped here — the
                // cap below is the only thing that may take one from a held session.
                //
                // This is now the rule for every held session EXCEPT the shown one, which rule 8b
                // below serves instead (live-gate fix C). Waking, working and
                // attached-elsewhere sessions keep lazy restore exactly as before.
                for tab in sessionTabs where tab.isShown && !live.contains(tab.tabId) {
                    creates.append(.create(tabId: tab.tabId, url: tab.url))
                }
                // Any signal returning cancels the linger.
                if hasPendingStop { cancels.append(.cancelScheduledStop(sessionId: sessionId)) }

            case .quiet:
                if liveTabs.isEmpty {
                    // Nothing to stop. A deadline left over from before the last browser went away
                    // is cleared rather than left to fire forever into an empty session.
                    if hasPendingStop { cancels.append(.cancelScheduledStop(sessionId: sessionId)) }
                } else if let deadline = pendingStops[sessionId] {
                    // THE LINGER COMPARISON. `deadline > now` → still inside the linger, browsers
                    // stay live and this plan says nothing about the session at all: that is what
                    // makes a hop away and back inside 300s produce zero stops and zero creates.
                    if deadline <= now {
                        for tab in liveTabs {
                            sessionStops.append(.stop(tabId: tab.tabId))
                            stopping.insert(tab.tabId)
                        }
                        cancels.append(.cancelScheduledStop(sessionId: sessionId))
                    }
                } else {
                    schedules.append(.scheduleStop(sessionId: sessionId, at: now.addingTimeInterval(stopLinger)))
                }
            }
        }

        // ── Rule 8b: the SHOWN session's tabs are ALL live (live-gate fix C). ────────────────────
        //
        // **A policy correction from the user, and it lives here because it IS policy.** ⌘-clicking
        // a link minted the tab and left it unloaded until first shown; Chrome loads a new
        // background tab immediately, and that is the behaviour asked for. So for the ONE session
        // the shell is displaying, every web tab gets a browser — not just `isShown`. Every other
        // held session keeps rule 8's lazy restore, which is what stops this from being "wake every
        // tab of every session anyone ever attached to".
        //
        // **Bounded by the same budget the cap enforces, and that pairing is what makes this rule
        // safe rather than a create/stop loop.** The cap does not protect a shown session's
        // non-shown tabs (see `capEvictions`), so an unbounded eager pass would create one more tab,
        // have the cap evict it as least-recently-used, and create it again on the very next plan —
        // for as long as the session stayed shown. That is the thrash `capEvictions` names as the
        // thing eviction must never do, arrived at from the create side. Stopping at the budget
        // instead produces exactly spec §10 gate 13's promise: past it, the tabs that do not fit
        // simply are not loaded until shown, and showing one makes it the shown tab (protected) and
        // evicts the genuine least-recently-used.
        //
        // **The estimate for a tab that does not exist yet is the HEAVIEST tab we can measure, and
        // that is a proof rather than a preference** (live-gate fix G). A create's cost is unknowable
        // — the page has not loaded — so this rule has to guess, and the direction of the guess
        // decides whether the pair above can oscillate. With `estimate = max measured per-tab`:
        // eviction stops the moment the total is back inside the budget, so the headroom it leaves
        // is strictly LESS than the last evicted tab's own size, which is at most `estimate`;
        // therefore `total + estimate > budget` and this rule refuses to create. **A plan can never
        // re-create what the previous plan's eviction just took.** An average-sized guess would not
        // carry that, and a growing page (renderers do grow) would then flip the pair into a
        // period-2 create/stop loop on the LRU tab.
        //
        // Fold order among the candidates, which is deterministic (rule 10) and means "the tabs you
        // opened first" get the budget.
        let survivors = live.subtracting(stopping)
        let estimate = heaviestMeasuredTab(among: survivors, memoryBytesByTab: memoryBytesByTab)
        if let shownSession = viewportSession {
            var pending = Set(creates.compactMap(\.createdTabId))
            var projectedCount = survivors.union(pending).count
            var projectedBytes = measuredBytes(of: survivors, memoryBytesByTab: memoryBytesByTab)
                + UInt64(pending.count) * estimate
            for tab in tabs[shownSession] ?? []
            where !live.contains(tab.tabId) && !pending.contains(tab.tabId) {
                guard projectedCount < maxLiveBackstop else { break }
                guard projectedBytes + estimate <= memoryBudgetBytes else { break }
                creates.append(.create(tabId: tab.tabId, url: tab.url))
                pending.insert(tab.tabId)
                projectedCount += 1
                projectedBytes += estimate
            }
        }

        // ── Rule 7: the cap. ────────────────────────────────────────────────────────────────────
        let created = Set(creates.compactMap(\.createdTabId))
        let capStops = capEvictions(survivors: survivors,
                                    created: created,
                                    lruOrder: lruOrder,
                                    sessionIds: sessionIds,
                                    sessions: sessions,
                                    tabs: tabs,
                                    disposition: disposition,
                                    desiredViewport: desiredViewport,
                                    memoryBytesByTab: memoryBytesByTab,
                                    estimate: estimate)

        // ── The viewport move. ──────────────────────────────────────────────────────────────────
        var detach: [BrowserAction] = []
        var attach: [BrowserAction] = []
        if viewport != desiredViewport {
            if let current = viewport { detach.append(.detachViewport(tabId: current)) }
            if let desired = desiredViewport { attach.append(.attachViewport(tabId: desired)) }
        }

        // ── The order. ──────────────────────────────────────────────────────────────────────────
        // Two of these are hard ORDERING CONTRACTS the executor cannot fix up for itself:
        //   • detach precedes every stop — stopping a browser whose container is still mounted in
        //     the panel's host view destroys a live subview of a visible window;
        //   • create precedes attach — there is no container to mount before the browser exists.
        // The rest is ordered for readability and determinism: belt stops, then per-session stops
        // (sessionId order, then fold order), then cap evictions (LRU order), then creates — rule
        // 8's, in sessionId order then fold order, followed by rule 8b's for the shown session, in
        // fold order — then the bookkeeping.
        return detach + beltStops + sessionStops + capStops + creates + attach + cancels + schedules
    }

    /// Rule 7. Over BUDGET (or over the count backstop), stop least-recently-used tabs — but never
    /// one that is PROTECTED.
    ///
    /// **The budget, not a count — live-gate fix G.** Two independent overages, checked together and
    /// satisfied together:
    ///   * `memoryBudgetBytes`, against the measured total of the surviving live tabs plus one
    ///     `estimate` for each tab this plan is creating (a create counts in the plan that emits it,
    ///     see below — and its cost is not measurable yet, so it is estimated the same way rule 8b
    ///     estimates it);
    ///   * `maxLiveBackstop`, against the count. This is the only bound with no measurement, so it
    ///     is also the whole rule when `memoryBytesByTab` is empty.
    ///
    /// **The per-tab map is consumed as a TOTAL and a MAXIMUM, never as a ranking**, and that is
    /// deliberate honesty rather than a shortcut. Site isolation shares one renderer between
    /// same-site tabs, so per-tab attribution is approximate by construction and today's sampler
    /// makes it an equal share (`BrowserMemory.swift`) — under which every live tab carries the same
    /// number and "evict the heaviest" would be a coin toss dressed up as a policy. Eviction order
    /// stays LRU, which is a real signal. The map is per-tab anyway so that a better attribution can
    /// be dropped into the sampler without touching a rule here.
    ///
    /// Protected, and why each is:
    ///   • the tab that will hold the viewport — evicting it blacks out the window the user is
    ///     looking at (spec §4: "never the shown tab");
    ///   • every tab of a `working` session — spec §4: "never a working session's tabs";
    ///   • every held session's shown tab, viewport or not. This one is a SHARPENING the brief did
    ///     not spell out, and it is not optional: `hold` re-creates a missing shown tab on the very
    ///     next plan (rule 8), so evicting one would produce a create/stop loop that cycles through
    ///     the whole set forever. Eviction must never target a tab these same rules would
    ///     immediately recreate — that is thrash, not degradation.
    ///
    /// **What is deliberately NOT protected, and how it stays clear of that same thrash rule:** the
    /// SHOWN session's non-shown tabs. Rule 8b creates all of them, and they are ordinary cap
    /// candidates like anyone else's — over budget, least-recently-used still wins, which is spec
    /// §4's "never the shown tab, never a working session's tabs" read literally. That would be the
    /// create/stop loop above if rule 8b were unbounded, so rule 8b stops at the same budget
    /// instead: past it the tabs that do not fit are simply never created, so there is nothing for
    /// an eviction here to fight with. The two rules are a pair — changing either one alone
    /// reintroduces the loop, and rule 8b's own comment carries the proof that the pair cannot
    /// oscillate across plans either.
    ///
    /// **The sharpened edge: when everything live is protected, the budget is EXCEEDED, not
    /// enforced.** The cap exists (spec §4) "so heavy use degrades to v1 behaviour instead of
    /// unbounded renderers" — it is a memory-budget policy, now literally. Every protected tab is
    /// protected because stopping it breaks something the user can see or the agent is mid-way
    /// through. Correctness outranks the budget, so this returns fewer evictions than the overage
    /// rather than reaching past the protected set.
    ///
    /// **The overage is UNBOUNDED, not transient.** Every tab of a `working` session is protected
    /// and lazy restore creates one more on each show, so a long turn that browses thirty pages
    /// leaves thirty live browsers with the budget inoperative — it does not "come back under it
    /// when an unprotected tab appears", because nothing forces the protected ones to become
    /// unprotected while the turn runs. **v1 accepts this (controller's ruling):** a working
    /// session's visited tabs ARE the user's working set, and the cap's purpose is bounding idle
    /// accumulation, not bounding active work. The last-resort tier — evicting a working session's
    /// non-shown, non-viewport tabs once the overage gets large — is a NAMED FOLLOW-UP, deliberately
    /// not built here.
    private static func capEvictions(survivors: Set<String>,
                                     created: Set<String>,
                                     lruOrder: [String],
                                     sessionIds: [String],
                                     sessions: [String: BrowserSignals],
                                     tabs: [String: [BrowserTabState]],
                                     disposition: [String: Disposition],
                                     desiredViewport: String?,
                                     memoryBytesByTab: [String: UInt64],
                                     estimate: UInt64) -> [BrowserAction] {
        // A create counts against BOTH bounds in the plan that emits it, or the cap is always one
        // plan behind the growth it exists to bound. `survivors` already excludes everything this
        // plan is stopping (the belt's orphans and every per-session stop), which is what keeps an
        // orphan at the boundary from buying a spurious eviction of a real tab.
        var countOver = survivors.union(created).count - maxLiveBackstop
        var projectedBytes = measuredBytes(of: survivors, memoryBytesByTab: memoryBytesByTab)
            + UInt64(created.count) * estimate
        guard countOver > 0 || projectedBytes > memoryBudgetBytes else { return [] }

        var protected = Set<String>()
        if let desiredViewport { protected.insert(desiredViewport) }
        for sessionId in sessionIds {
            let sessionTabs = tabs[sessionId] ?? []
            if sessions[sessionId]?.working == true {
                protected.formUnion(sessionTabs.map(\.tabId))
            } else if disposition[sessionId] == .hold {
                protected.formUnion(sessionTabs.filter(\.isShown).map(\.tabId))
            }
        }

        // Candidates: survivors that are not protected, least-recently-used first. Tabs created by
        // THIS plan are absent from `lruOrder` and from `survivors`, so they can never be evicted
        // by the plan that made them.
        //
        // A live tab missing from `lruOrder` has unknown recency; it goes LAST (so a known-old tab
        // is always evicted before a tab we cannot date) and, among such tabs, in sorted order —
        // rule 10 has to hold even on malformed input.
        var candidates: [String] = []
        var seen = Set<String>()
        for tabId in lruOrder where survivors.contains(tabId) && !protected.contains(tabId) {
            if seen.insert(tabId).inserted { candidates.append(tabId) }
        }
        candidates += survivors.subtracting(protected).subtracting(seen).sorted()

        // Take from the front until BOTH overages are gone, or the candidates run out (the
        // sharpened edge above). Each eviction pays down the count by one and the budget by that
        // tab's own measured bytes.
        var stops: [BrowserAction] = []
        for tabId in candidates {
            guard countOver > 0 || projectedBytes > memoryBudgetBytes else { break }
            let bytes = memoryBytesByTab[tabId] ?? 0
            // **An UNMEASURED tab is never evicted for the budget's sake.** It contributed nothing
            // to `projectedBytes`, so it cannot be why we are over it, and stopping it would free
            // nothing while destroying a real page — the plain reading of "the total is what
            // drives eviction". It is still an ordinary candidate for the count backstop, which is
            // a bound it does contribute to. (Today's sampler measures every live tab or none, so
            // this is a contract the engine holds rather than a case it meets in production.)
            if countOver <= 0 && bytes == 0 { continue }
            stops.append(.stop(tabId: tabId))
            countOver -= 1
            projectedBytes = projectedBytes > bytes ? projectedBytes - bytes : 0
        }
        return stops
    }

    /// The measured total for a set of tabs. A tab absent from the map contributes zero — see the
    /// eviction loop for why that absence is load-bearing rather than defensive.
    private static func measuredBytes(of tabIds: Set<String>,
                                      memoryBytesByTab: [String: UInt64]) -> UInt64 {
        tabIds.reduce(UInt64(0)) { $0 + (memoryBytesByTab[$1] ?? 0) }
    }

    /// The heaviest measured live tab, or zero if nothing is measured — **the cost this engine
    /// charges a tab that does not exist yet.** Rule 8b's own comment carries the proof that using
    /// the maximum (rather than a mean) is what makes the create rule and the eviction rule unable
    /// to fight each other across consecutive plans.
    private static func heaviestMeasuredTab(among tabIds: Set<String>,
                                            memoryBytesByTab: [String: UInt64]) -> UInt64 {
        tabIds.compactMap { memoryBytesByTab[$0] }.max() ?? 0
    }
}

private extension BrowserSignals {
    /// The default for a session the signal plumbing has not described yet.
    static let quiet = BrowserSignals(attachedHere: false, attachedElsewhere: false,
                                      working: false, archived: false)
}

private extension BrowserAction {
    /// The tabId of a `.create`, or nil for every other case — used to count this plan's creates
    /// against the cap without a second parallel array to keep in sync.
    var createdTabId: String? {
        if case .create(let tabId, _) = self { return tabId }
        return nil
    }
}
