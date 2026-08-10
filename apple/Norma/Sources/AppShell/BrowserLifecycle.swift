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
/// `activityFor` (`packages/core/src/sessions/activity.ts`)
/// and the panel's auto-created sessions are mode *chat*, so the label is unavailable exactly where
/// the panel needs it. The underlying signals exist for every session **at the daemon** — this app
/// sees only the derived label, so that guarantee does not reach here; see the spec's §4 T5
/// correction note for exactly what degrades as a result.
struct BrowserSignals: Equatable {
    /// Shown in this Mac app's shell — the session whose tabs the panel is displaying.
    var attachedHere: Bool
    /// Any other harness (the phone) is attached to this session.
    var attachedElsewhere: Bool
    /// `turnRunning || bgWork` — the agent may be driving these pages right now.
    var working: Bool
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

    /// Spec §4 as re-priced by the Task 1 spike (§3 correction): occlusion throttling does not
    /// exist, so a PARKED browser costs what a visible one costs. 16 → 8.
    static let maxLive = 8

    /// What this engine has decided to do with one session's browsers on this pass.
    private enum Disposition {
        /// Stop every live tab of the session now, with no linger.
        case stopNow
        /// Keep every live tab live; create the shown one if it is missing (lazy restore).
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
    ///   - now: the caller's clock reading. The engine never takes its own.
    static func plan(sessions: [String: BrowserSignals],
                     tabs: [String: [BrowserTabState]],
                     live: Set<String>,
                     viewport: String?,
                     pendingStops: [String: Date],
                     lruOrder: [String],
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

        // ── Rule 7: the cap. ────────────────────────────────────────────────────────────────────
        let created = Set(creates.compactMap(\.createdTabId))
        let capStops = capEvictions(live: live,
                                    stopping: stopping,
                                    created: created,
                                    lruOrder: lruOrder,
                                    sessionIds: sessionIds,
                                    sessions: sessions,
                                    tabs: tabs,
                                    disposition: disposition,
                                    desiredViewport: desiredViewport)

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
        // (sessionId order, then fold order), then cap evictions (LRU order), then creates
        // (sessionId order, then fold order), then the bookkeeping.
        return detach + beltStops + sessionStops + capStops + creates + attach + cancels + schedules
    }

    /// Rule 7. Over `maxLive`, stop least-recently-used tabs — but never one that is PROTECTED.
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
    /// **The sharpened edge: when everything live is protected, the cap is EXCEEDED, not enforced.**
    /// The cap exists (spec §4) "so heavy use degrades to v1 behaviour instead of unbounded
    /// renderers" — it is a memory-budget policy. Every protected tab is protected because stopping
    /// it breaks something the user can see or the agent is mid-way through. Correctness outranks
    /// the budget, so this returns fewer evictions than the overage rather than reaching past the
    /// protected set.
    ///
    /// **The overage is UNBOUNDED, not transient.** Every tab of a `working` session is protected
    /// and lazy restore creates one more on each show, so a long turn that browses thirty pages
    /// leaves thirty live browsers with the cap inoperative — it does not "come back under the cap
    /// when an unprotected tab appears", because nothing forces the protected ones to become
    /// unprotected while the turn runs. **v1 accepts this (controller's ruling):** a working
    /// session's visited tabs ARE the user's working set, and the cap's purpose is bounding idle
    /// accumulation, not bounding active work. The last-resort tier — evicting a working session's
    /// non-shown, non-viewport tabs once the overage gets large — is a NAMED FOLLOW-UP, deliberately
    /// not built here.
    private static func capEvictions(live: Set<String>,
                                     stopping: Set<String>,
                                     created: Set<String>,
                                     lruOrder: [String],
                                     sessionIds: [String],
                                     sessions: [String: BrowserSignals],
                                     tabs: [String: [BrowserTabState]],
                                     disposition: [String: Disposition],
                                     desiredViewport: String?) -> [BrowserAction] {
        // A create counts against the cap in the plan that emits it, or the cap is always one plan
        // behind the growth it exists to bound.
        let survivors = live.subtracting(stopping)
        let overBy = survivors.union(created).count - maxLive
        guard overBy > 0 else { return [] }

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

        return candidates.prefix(overBy).map { .stop(tabId: $0) }
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
