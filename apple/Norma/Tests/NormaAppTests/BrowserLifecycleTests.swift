import XCTest
@testable import Norma

/// browser-runtime T2: the lifecycle engine's whole coverage (spec §4, §8, §9).
///
/// `BrowserLifecycleEngine.plan` is a pure function, so these tests need no CEF, no MainActor and
/// no app state — which is the point of the spec's §9 posture: "the runtime's lifecycle engine
/// (signals → desired state → actions) must be a pure, fully-testable function … that is where the
/// real coverage lives, and it needs no CEF."
///
/// What these tests do NOT cover: that Task 3's executor applies an action correctly (that a
/// `.create` really reaches `NormaCEFCreateBrowser`, that `.attachViewport` really reparents), and
/// that Task 5 assembles truthful `BrowserSignals` from daemon state. Both are separately pinned in
/// their own tasks. This file pins only the DECISION.
final class BrowserLifecycleTests: XCTestCase {

    // MARK: - Fixtures

    /// A fixed instant. The engine never reads a clock, so "now" is just another input and every
    /// deadline below is expressed relative to this.
    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    private func sig(attachedHere: Bool = false,
                     attachedElsewhere: Bool = false,
                     working: Bool = false,
                     archived: Bool = false,
                     stopImmediately: Bool = false) -> BrowserSignals {
        BrowserSignals(attachedHere: attachedHere,
                       attachedElsewhere: attachedElsewhere,
                       working: working,
                       archived: archived,
                       stopImmediately: stopImmediately)
    }

    private func tab(_ id: String, url: String? = nil, shown: Bool = false) -> BrowserTabState {
        BrowserTabState(tabId: id, url: url, isShown: shown)
    }

    /// Thin wrapper so every row reads as a table entry: only the fields a row cares about are
    /// spelled out.
    ///
    /// `memoryBytesByTab` defaults to EMPTY here and nowhere in production — the engine's own
    /// parameter is deliberately undefaulted (live-gate fix G), so this default is the test
    /// harness's convenience and not a hole in the engine's surface. Empty means "no measurement",
    /// under which `maxLiveBackstop` is the only bound, which is exactly what every row that is not
    /// about the budget wants.
    private func plan(sessions: [String: BrowserSignals] = [:],
                      tabs: [String: [BrowserTabState]] = [:],
                      live: Set<String> = [],
                      viewport: String? = nil,
                      pendingStops: [String: Date] = [:],
                      lruOrder: [String] = [],
                      memoryBytesByTab: [String: UInt64] = [:],
                      now: Date? = nil) -> [BrowserAction] {
        BrowserLifecycleEngine.plan(sessions: sessions,
                                    tabs: tabs,
                                    live: live,
                                    viewport: viewport,
                                    pendingStops: pendingStops,
                                    lruOrder: lruOrder,
                                    memoryBytesByTab: memoryBytesByTab,
                                    now: now ?? t0)
    }

    /// **The budget, expressed as "how many of these fit".** Every tab in `tabIds` is priced at
    /// `memoryBudgetBytes / n`, so exactly `n` of them sit AT the budget and the (n+1)-th is over
    /// it — which is what makes the eviction rows below readable as counts while still exercising
    /// the real byte arithmetic and the real 4 GiB constant.
    ///
    /// It also matches what the app actually supplies: the sampler divides one total equally
    /// (`BrowserMemorySampler.equalShare`), so every live tab really does carry the same number.
    private func bytes(_ tabIds: some Sequence<String>, nFit n: Int) -> [String: UInt64] {
        let perTab = BrowserLifecycleEngine.memoryBudgetBytes / UInt64(n)
        return Dictionary(uniqueKeysWithValues: tabIds.map { ($0, perTab) })
    }

    /// The state an executor would hold, mutated by applying a plan — used by the idempotence rows
    /// and by the session-hop row, which are the only claims that need TWO consecutive plans.
    ///
    /// Deliberately dumb: it mirrors what Task 3's runtime must do to its own bookkeeping and
    /// nothing more. LRU is touched on create/attach (both are "this tab was just used") and on
    /// stop; that mirrors the plan's own note that the runtime records last-shown order (Task 7).
    private struct Sim {
        var live: Set<String> = []
        var viewport: String?
        var pendingStops: [String: Date] = [:]
        var lruOrder: [String] = []

        mutating func apply(_ actions: [BrowserAction]) {
            for action in actions {
                switch action {
                case .create(let tabId, _):
                    live.insert(tabId)
                    touch(tabId)
                case .stop(let tabId):
                    live.remove(tabId)
                    lruOrder.removeAll { $0 == tabId }
                    if viewport == tabId { viewport = nil }
                case .attachViewport(let tabId):
                    viewport = tabId
                    touch(tabId)
                case .detachViewport(let tabId):
                    if viewport == tabId { viewport = nil }
                case .scheduleStop(let sessionId, let at):
                    pendingStops[sessionId] = at
                case .cancelScheduledStop(let sessionId):
                    pendingStops.removeValue(forKey: sessionId)
                }
            }
        }

        private mutating func touch(_ tabId: String) {
            lruOrder.removeAll { $0 == tabId }
            lruOrder.append(tabId)
        }
    }

    /// Plans, applies, then plans again with the SAME inputs — rule 9. The second plan must be
    /// empty: a create of an already-live tab and a stop of an already-dead one are the two shapes
    /// that would make an executor do work twice.
    ///
    /// The FIRST plan is asserted non-empty on purpose. Every row below is built to produce work on
    /// the first pass, and without this check "the second plan is empty" passes vacuously whenever a
    /// mutation makes the first plan empty too — which is precisely a decorative test.
    private func assertIdempotent(sessions: [String: BrowserSignals],
                                  tabs: [String: [BrowserTabState]],
                                  sim: Sim,
                                  memoryBytesByTab: [String: UInt64] = [:],
                                  now: Date? = nil,
                                  file: StaticString = #filePath,
                                  line: UInt = #line) {
        var state = sim
        let first = plan(sessions: sessions, tabs: tabs, live: state.live, viewport: state.viewport,
                         pendingStops: state.pendingStops, lruOrder: state.lruOrder,
                         memoryBytesByTab: memoryBytesByTab, now: now)
        XCTAssertFalse(first.isEmpty, "the first plan did no work — idempotence would be vacuous",
                       file: file, line: line)
        state.apply(first)
        let second = plan(sessions: sessions, tabs: tabs, live: state.live, viewport: state.viewport,
                          pendingStops: state.pendingStops, lruOrder: state.lruOrder,
                          memoryBytesByTab: memoryBytesByTab, now: now)
        XCTAssertEqual(second, [], "re-planning after applying \(first) must be a no-op", file: file, line: line)
    }

    // MARK: - Rule 1: the §8 belt (a live browser with no tab is definitionally a leak)

    func test_belt_liveTabInNoSessionsTabList_stops() {
        let actions = plan(sessions: ["s1": sig(attachedHere: true)],
                           tabs: ["s1": [tab("t1", shown: true)]],
                           live: ["t1", "ghost"],
                           viewport: "t1")
        XCTAssertEqual(actions, [.stop(tabId: "ghost")])
    }

    /// "Unconditionally, first priority": a working session's tabs are protected from every other
    /// stop rule in this engine, but the belt does not consult signals at all — it consults the tab
    /// lists, and a tabId absent from all of them names a browser the daemon no longer knows about.
    func test_belt_beatsWorkingSessionProtection() {
        let actions = plan(sessions: ["s1": sig(working: true)],
                           tabs: ["s1": [tab("t1", shown: true)]],
                           live: ["t1", "ghost"])
        XCTAssertEqual(actions, [.stop(tabId: "ghost")])
    }

    /// The orphan currently holds the viewport (the tab was closed while shown — the audio bug's
    /// exact shape). The viewport must be detached BEFORE the stop, or the executor destroys a
    /// container still mounted in a host view.
    func test_belt_orphanHoldingViewport_detachesThenStops() {
        let actions = plan(sessions: ["s1": sig(attachedHere: true)],
                           tabs: ["s1": []],
                           live: ["ghost"],
                           viewport: "ghost")
        XCTAssertEqual(actions, [.detachViewport(tabId: "ghost"), .stop(tabId: "ghost")])
    }

    func test_belt_severalOrphans_stopInSortedOrder() {
        let actions = plan(live: ["zz", "aa", "mm"])
        XCTAssertEqual(actions, [.stop(tabId: "aa"), .stop(tabId: "mm"), .stop(tabId: "zz")])
    }

    // MARK: - Rule 2: the shown session

    /// The shown tab is created and takes the viewport — and, since live-gate fix C, so is its
    /// sibling: the shown SESSION's tabs are all live (rule 8b's own section below). This row's
    /// predecessor asserted the opposite (`test_shown_siblingIsNotCreatedEagerly`, deleted), which
    /// was the shipped behaviour the user corrected: a ⌘-clicked tab sat unloaded until visited.
    func test_shown_shownTabIsCreatedAndTakesTheViewport() {
        let actions = plan(sessions: ["s1": sig(attachedHere: true)],
                           tabs: ["s1": [tab("t1", url: "https://a", shown: true), tab("t2", url: "https://b")]],
                           live: [])
        XCTAssertEqual(actions, [.create(tabId: "t1", url: "https://a"),
                                 .create(tabId: "t2", url: "https://b"),
                                 .attachViewport(tabId: "t1")])
    }

    /// Siblings that are ALREADY live stay live and parked — the switch-away that used to destroy
    /// them (B1's v1 behaviour) is exactly what this spec exists to delete.
    func test_shown_liveSiblingsAreKeptParked() {
        let actions = plan(sessions: ["s1": sig(attachedHere: true)],
                           tabs: ["s1": [tab("t1", shown: true), tab("t2"), tab("t3")]],
                           live: ["t1", "t2", "t3"],
                           viewport: "t1",
                           lruOrder: ["t3", "t2", "t1"])
        XCTAssertEqual(actions, [])
    }

    /// Tab switch inside the shown session = a viewport move and nothing else. No create (the
    /// sibling is live), no stop (the departing tab parks).
    func test_shown_tabSwitchMovesViewportOnly() {
        let actions = plan(sessions: ["s1": sig(attachedHere: true)],
                           tabs: ["s1": [tab("t1"), tab("t2", shown: true)]],
                           live: ["t1", "t2"],
                           viewport: "t1",
                           lruOrder: ["t2", "t1"])
        XCTAssertEqual(actions, [.detachViewport(tabId: "t1"), .attachViewport(tabId: "t2")])
    }

    /// A shown session whose shown tab is not yet live: create first, attach after — the executor
    /// applies in order and cannot attach a container that does not exist.
    func test_shown_createPrecedesAttach() {
        let actions = plan(sessions: ["s1": sig(attachedHere: true)],
                           tabs: ["s1": [tab("t1"), tab("t2", shown: true)]],
                           live: ["t1"],
                           viewport: "t1",
                           lruOrder: ["t1"])
        XCTAssertEqual(actions, [.detachViewport(tabId: "t1"),
                                 .create(tabId: "t2", url: nil),
                                 .attachViewport(tabId: "t2")])
    }

    /// No shown tab in the shown session (the panel is on a non-web tab, or has none) → nobody
    /// holds the viewport, and the previously-attached tab parks rather than being stopped.
    func test_shown_noShownTab_detachesWithoutStopping() {
        let actions = plan(sessions: ["s1": sig(attachedHere: true)],
                           tabs: ["s1": [tab("t1")]],
                           live: ["t1"],
                           viewport: "t1",
                           lruOrder: ["t1"])
        XCTAssertEqual(actions, [.detachViewport(tabId: "t1")])
    }

    // MARK: - Rule 3: working / attached-elsewhere sessions are held live, parked

    func test_working_holdsAllLiveTabsAndTakesNoViewport() {
        let actions = plan(sessions: ["s1": sig(working: true)],
                           tabs: ["s1": [tab("t1", shown: true), tab("t2")]],
                           live: ["t1", "t2"],
                           lruOrder: ["t2", "t1"])
        XCTAssertEqual(actions, [])
    }

    func test_attachedElsewhere_holdsAllLiveTabsAndTakesNoViewport() {
        let actions = plan(sessions: ["s1": sig(attachedElsewhere: true)],
                           tabs: ["s1": [tab("t1", shown: true), tab("t2")]],
                           live: ["t1", "t2"],
                           lruOrder: ["t2", "t1"])
        XCTAssertEqual(actions, [])
    }

    /// A session viewed on the phone while another is viewed here: the phone session's browsers are
    /// live and headless, the Mac's shown tab owns the viewport. Both at once — the spec's §4 table
    /// rows 1 and 2 in one plan.
    func test_workingSessionStaysLiveWhileAnotherSessionIsShownHere() {
        let actions = plan(sessions: ["a": sig(attachedHere: true), "b": sig(working: true)],
                           tabs: ["a": [tab("a1", shown: true)], "b": [tab("b1", shown: true), tab("b2")]],
                           live: ["a1", "b1", "b2"],
                           viewport: "a1",
                           lruOrder: ["b2", "b1", "a1"])
        XCTAssertEqual(actions, [])
    }

    // MARK: - Rule 8: lazy restore

    /// A waking session (work started while it was stopped) creates ONLY its shown tab. The
    /// siblings' pills still render from daemon state; their browsers appear on first show.
    func test_lazyRestore_wakingSessionCreatesOnlyTheShownTab() {
        let actions = plan(sessions: ["s1": sig(working: true)],
                           tabs: ["s1": [tab("t1", url: "https://one", shown: true),
                                         tab("t2", url: "https://two"),
                                         tab("t3", url: "https://three")]],
                           live: [])
        XCTAssertEqual(actions, [.create(tabId: "t1", url: "https://one")])
    }

    /// …and the sibling is created when it BECOMES the shown tab, not before.
    func test_lazyRestore_siblingCreatesOnFirstShow() {
        let actions = plan(sessions: ["s1": sig(working: true)],
                           tabs: ["s1": [tab("t1"), tab("t2", url: "https://two", shown: true)]],
                           live: ["t1"],
                           lruOrder: ["t1"])
        XCTAssertEqual(actions, [.create(tabId: "t2", url: "https://two")])
    }

    // MARK: - Rule 8b: the shown session's tabs are ALL live (live-gate fix C)

    /// **The user's policy correction, as the table row that states it.** ⌘-clicking a link minted
    /// the tab and left it unloaded until first shown; Chrome loads a background tab immediately,
    /// and that is what was asked for. Three web tabs, one shown, nothing live → three creates.
    func test_rule8b_theShownSessionCreatesEveryOneOfItsWebTabs() {
        let actions = plan(sessions: ["s1": sig(attachedHere: true)],
                           tabs: ["s1": [tab("t1", url: "https://one", shown: true),
                                         tab("t2", url: "https://two"),
                                         tab("t3", url: "https://three")]],
                           live: [])
        XCTAssertEqual(actions, [.create(tabId: "t1", url: "https://one"),
                                 .create(tabId: "t2", url: "https://two"),
                                 .create(tabId: "t3", url: "https://three"),
                                 .attachViewport(tabId: "t1")])
    }

    /// **…and no other held session does — the half that keeps the fix from being "wake
    /// everything".** Both sessions here are `hold` and both have three tabs with one shown; only
    /// the one the shell is DISPLAYING is eager. Stated as one plan over two sessions rather than
    /// two plans, because "eager" and "lazy" being decided by shown-ness rather than by disposition
    /// is exactly what a single row can show and two cannot.
    ///
    /// `s2` is `working`, i.e. an agent may be driving it right now, which is the strongest form of
    /// held there is — and it still restores lazily (spec §6).
    func test_rule8b_onlyTheShownSessionIsEagerEveryOtherHeldSessionStaysLazy() {
        let actions = plan(sessions: ["s1": sig(attachedHere: true), "s2": sig(working: true)],
                           tabs: ["s1": [tab("a1", url: "https://a1", shown: true),
                                         tab("a2", url: "https://a2"),
                                         tab("a3", url: "https://a3")],
                                  "s2": [tab("b1", url: "https://b1", shown: true),
                                         tab("b2", url: "https://b2"),
                                         tab("b3", url: "https://b3")]],
                           live: [])
        XCTAssertEqual(actions, [
            // Rule 8, in sessionId order: each held session's shown tab.
            .create(tabId: "a1", url: "https://a1"),
            .create(tabId: "b1", url: "https://b1"),
            // Rule 8b, fold order: the SHOWN session's remaining tabs, and only its.
            .create(tabId: "a2", url: "https://a2"),
            .create(tabId: "a3", url: "https://a3"),
            .attachViewport(tabId: "a1"),
        ])
    }

    /// **Rule 8b stops at the BUDGET, and this row is why that is not a detail** (live-gate fix G).
    ///
    /// A shown session's non-shown tabs are deliberately NOT protected from eviction
    /// (`capEvictions`' own doc — spec §4's "never the shown tab, never a working session's tabs",
    /// read literally). So an UNBOUNDED eager pass would create one more tab, have the cap evict it
    /// as least-recently-used, and create it again on the very next plan, forever — the create/stop
    /// loop `capEvictions` names as the thing eviction must never cause, arrived at from the create
    /// side instead. The second plan below is what catches it: with the rule bounded it is empty.
    ///
    /// Four of the ten are already live and measured at an eighth of the budget each, so the
    /// engine's estimate for a tab it has not created yet (the heaviest measured tab) is that same
    /// eighth — and exactly four more fit.
    func test_rule8b_stopsAtTheBudgetInsteadOfCreatingTabsTheCapWouldImmediatelyEvict() {
        let many = (1...10).map { tab("t\($0)", url: "https://t\($0)", shown: $0 == 1) }
        let sessions = ["s1": sig(attachedHere: true)]
        let alreadyLive: Set<String> = ["t1", "t2", "t3", "t4"]
        let memory = bytes(alreadyLive, nFit: 8)

        let actions = plan(sessions: sessions, tabs: ["s1": many], live: alreadyLive,
                           viewport: "t1", lruOrder: ["t1", "t2", "t3", "t4"],
                           memoryBytesByTab: memory)

        XCTAssertEqual(actions.compactMap { if case .create(let id, _) = $0 { return id } else { return nil } },
                       ["t5", "t6", "t7", "t8"],
                       "the budget is the eager pass's allowance, spent in fold order")
        XCTAssertFalse(actions.contains { if case .stop = $0 { return true } else { return false } },
                       "a plan must never create a tab and evict one in the same breath")

        var sim = Sim(live: alreadyLive, viewport: "t1", lruOrder: ["t1", "t2", "t3", "t4"])
        sim.apply(actions)
        // The four new tabs measure what the engine estimated they would — which is what the app's
        // own equal-share sampler produces once they exist (`BrowserMemorySampler.equalShare`).
        let second = plan(sessions: sessions, tabs: ["s1": many], live: sim.live,
                          viewport: sim.viewport, lruOrder: sim.lruOrder,
                          memoryBytesByTab: bytes(sim.live, nFit: 8))
        XCTAssertEqual(second, [],
                       "the create/stop loop: rule 8b re-created what the budget had just refused")
    }

    /// **The empty map: no measurement, so the count backstop is the only bound** (live-gate fix G).
    ///
    /// Reachable in production and not merely defensive — it is the state of every launch until the
    /// first `ps` sweep answers, and the state of any machine where the sweep fails. The correct
    /// degradation is "we cannot justify stopping anything for memory", i.e. the process bound and
    /// nothing else; the cost is a cold session with more tabs than that opening at the backstop
    /// rather than at a measured budget, corrected by the very next plan once a sample lands.
    func test_rule8b_withNoMeasurementAtAllStopsAtTheCountBackstop() {
        let many = (1...30).map { tab("t\($0)", url: "https://t\($0)", shown: $0 == 1) }
        let actions = plan(sessions: ["s1": sig(attachedHere: true)], tabs: ["s1": many], live: [])

        let created = actions.compactMap { if case .create(let id, _) = $0 { return id } else { return nil } }
        XCTAssertEqual(created.count, BrowserLifecycleEngine.maxLiveBackstop)
        XCTAssertEqual(created, (1...BrowserLifecycleEngine.maxLiveBackstop).map { "t\($0)" },
                       "fold order, and the backstop is where it stops")
        XCTAssertFalse(actions.contains { if case .stop = $0 { return true } else { return false } })
    }

    /// The two policy numbers, written out. Every row above expresses its budget as a FRACTION of
    /// `memoryBudgetBytes` and its backstop through `maxLiveBackstop`, which is what keeps them
    /// readable — and also what makes them all move silently if either constant is edited. This is
    /// the one row that does not, so a change to the policy has to be a deliberate change to the
    /// policy. (It replaces `XCTAssertEqual(maxLive, 8)`, which did the same job for the count cap.)
    func test_budget_theConstantsAreTheDocumentedPolicy() {
        XCTAssertEqual(BrowserLifecycleEngine.memoryBudgetBytes, 4 * 1024 * 1024 * 1024,
                       "4 GiB — spec §4's budget")
        XCTAssertEqual(BrowserLifecycleEngine.maxLiveBackstop, 24,
                       "the process/fd backstop, and the whole rule when nothing is measured")
    }

    /// **The user's headline case: 16 tabs that barely eat any memory all stay alive.**
    ///
    /// The whole reason the count cap was replaced — under `maxLive = 8` these would have been
    /// halved on principle. Sixteen tabs at a sixty-fourth of the budget each spend a quarter of it
    /// between them, so nothing is evicted and nothing is refused.
    func test_budget_sixteenTinyTabsAllStayLive() {
        let tabs = [tab("t0", shown: true)] + (1...15).map { tab("t\($0)") }
        let ids = Set(tabs.map(\.tabId))
        let actions = plan(sessions: ["a": sig(attachedElsewhere: true)],
                           tabs: ["a": tabs],
                           live: ids,
                           lruOrder: tabs.map(\.tabId),
                           memoryBytesByTab: bytes(ids, nFit: 64))
        XCTAssertEqual(actions, [], "a count cap would have stopped eight of these: \(actions)")
    }

    /// The same sixteen tabs, heavy instead of tiny: a quarter of the budget each, so four fit and
    /// the twelve least-recently-used go. The count is identical, the answer is not — which is the
    /// whole of the change.
    func test_budget_heavyTabsAreEvictedLeastRecentlyUsedFirst() {
        let tabs = [tab("t0", shown: true)] + (1...15).map { tab("t\($0)") }
        let ids = Set(tabs.map(\.tabId))
        // t0 is the session's shown tab and therefore protected, so eviction starts at t1.
        let actions = plan(sessions: ["a": sig(attachedElsewhere: true)],
                           tabs: ["a": tabs],
                           live: ids,
                           lruOrder: tabs.map(\.tabId),
                           memoryBytesByTab: bytes(ids, nFit: 4))
        XCTAssertEqual(actions, (1...12).map { .stop(tabId: "t\($0)") })
    }

    /// **The count backstop still bites when the pages are weightless.** Twenty-five tabs at a
    /// thousandth of the budget each are nowhere near it, and one still has to go: a live browser is
    /// a renderer process with its own descriptors and IPC channels whatever the page weighs.
    func test_budget_theCountBackstopBoundsEvenWeightlessTabs() {
        let tabs = [tab("t00", shown: true)] + (1...24).map { tab(String(format: "t%02d", $0)) }
        let ids = Set(tabs.map(\.tabId))
        let actions = plan(sessions: ["a": sig(attachedElsewhere: true)],
                           tabs: ["a": tabs],
                           live: ids,
                           lruOrder: tabs.map(\.tabId),
                           memoryBytesByTab: bytes(ids, nFit: 1000))
        XCTAssertEqual(actions, [.stop(tabId: "t01")])
    }

    /// The protections are the budget's, not the count's: over budget by miles, with every live tab
    /// belonging to a working session, nothing is stopped. (`capEvictions`' sharpened edge, restated
    /// against the new bound so a mutation that swapped byte-overage for count-overage cannot pass
    /// it by accident.)
    func test_budget_protectionsHoldWhenTheBudgetIsBlownWideOpen() {
        let workTabs = [tab("w0", shown: true)] + (1...5).map { tab("w\($0)") }
        let ids = Set(workTabs.map(\.tabId))
        let actions = plan(sessions: ["w": sig(working: true)],
                           tabs: ["w": workTabs],
                           live: ids,
                           lruOrder: workTabs.map(\.tabId),
                           memoryBytesByTab: bytes(ids, nFit: 1))   // each tab alone fills the budget
        XCTAssertEqual(actions, [])
    }

    // MARK: - Rule 4: the linger

    func test_quiet_schedulesStopAtNowPlusLinger() {
        let actions = plan(sessions: ["s1": sig()],
                           tabs: ["s1": [tab("t1", shown: true)]],
                           live: ["t1"],
                           lruOrder: ["t1"])
        XCTAssertEqual(actions, [.scheduleStop(sessionId: "s1", at: t0.addingTimeInterval(300))])
        XCTAssertEqual(BrowserLifecycleEngine.stopLinger, 300)
    }

    /// THE LINGER COMPARISON, half one: the deadline has NOT passed, so the browsers stay live.
    /// Inverting the engine's `deadline <= now` test reds this row.
    func test_quiet_insideTheLinger_keepsBrowsersLive() {
        let actions = plan(sessions: ["s1": sig()],
                           tabs: ["s1": [tab("t1", shown: true), tab("t2")]],
                           live: ["t1", "t2"],
                           pendingStops: ["s1": t0.addingTimeInterval(1)],
                           lruOrder: ["t2", "t1"])
        XCTAssertEqual(actions, [])
    }

    /// THE LINGER COMPARISON, half two: the deadline has passed, so the browsers stop and the fired
    /// deadline is cleared. Inverting `deadline <= now` reds this row too.
    func test_quiet_deadlinePassed_stopsAllTabsAndClearsTheDeadline() {
        let actions = plan(sessions: ["s1": sig()],
                           tabs: ["s1": [tab("t1", shown: true), tab("t2")]],
                           live: ["t1", "t2"],
                           pendingStops: ["s1": t0.addingTimeInterval(-1)],
                           lruOrder: ["t2", "t1"])
        XCTAssertEqual(actions, [.stop(tabId: "t1"),
                                 .stop(tabId: "t2"),
                                 .cancelScheduledStop(sessionId: "s1")])
    }

    /// The boundary is inclusive: a deadline exactly at `now` has passed.
    func test_quiet_deadlineExactlyNow_stops() {
        let actions = plan(sessions: ["s1": sig()],
                           tabs: ["s1": [tab("t1", shown: true)]],
                           live: ["t1"],
                           pendingStops: ["s1": t0],
                           lruOrder: ["t1"])
        XCTAssertEqual(actions, [.stop(tabId: "t1"), .cancelScheduledStop(sessionId: "s1")])
    }

    func test_signalReturn_cancelsTheScheduledStop() {
        let actions = plan(sessions: ["s1": sig(attachedHere: true)],
                           tabs: ["s1": [tab("t1", shown: true)]],
                           live: ["t1"],
                           viewport: "t1",
                           pendingStops: ["s1": t0.addingTimeInterval(120)],
                           lruOrder: ["t1"])
        XCTAssertEqual(actions, [.cancelScheduledStop(sessionId: "s1")])
    }

    func test_workSignalReturn_cancelsTheScheduledStop() {
        let actions = plan(sessions: ["s1": sig(working: true)],
                           tabs: ["s1": [tab("t1", shown: true)]],
                           live: ["t1"],
                           pendingStops: ["s1": t0.addingTimeInterval(120)],
                           lruOrder: ["t1"])
        XCTAssertEqual(actions, [.cancelScheduledStop(sessionId: "s1")])
    }

    /// A quiet session with nothing live has nothing to stop — no timer is armed for it.
    func test_quiet_withNoLiveTabs_schedulesNothing() {
        let actions = plan(sessions: ["s1": sig()], tabs: ["s1": [tab("t1", shown: true)]], live: [])
        XCTAssertEqual(actions, [])
    }

    /// …and a deadline left over from before its last browser went away is cleared, so the runtime
    /// does not hold a timer that can only ever fire into an empty session.
    func test_quiet_staleDeadlineWithNoLiveTabs_isCleared() {
        let actions = plan(sessions: ["s1": sig()],
                           tabs: ["s1": [tab("t1", shown: true)]],
                           live: [],
                           pendingStops: ["s1": t0.addingTimeInterval(120)])
        XCTAssertEqual(actions, [.cancelScheduledStop(sessionId: "s1")])
    }

    /// THE HEADLINE of rule 4: leave a session and come back inside the linger → not one stop and
    /// not one create, in either plan. This is the "quick session-hops never reload" promise, and
    /// it needs two consecutive plans to state at all.
    func test_hop_awayAndBackInsideTheLinger_producesZeroStopsAndZeroCreates() {
        let tabs = ["a": [tab("a1", url: "https://a", shown: true), tab("a2", url: "https://a2")],
                    "b": [tab("b1", url: "https://b", shown: true)]]
        var sim = Sim(live: ["a1", "a2", "b1"], viewport: "a1", lruOrder: ["a2", "b1", "a1"])

        // Hop A → B.
        let away = plan(sessions: ["a": sig(), "b": sig(attachedHere: true)],
                        tabs: tabs, live: sim.live, viewport: sim.viewport,
                        pendingStops: sim.pendingStops, lruOrder: sim.lruOrder, now: t0)
        sim.apply(away)
        XCTAssertEqual(away, [.detachViewport(tabId: "a1"),
                              .attachViewport(tabId: "b1"),
                              .scheduleStop(sessionId: "a", at: t0.addingTimeInterval(300))])

        // …and back, 10 seconds later — well inside the 300s linger.
        let back = plan(sessions: ["a": sig(attachedHere: true), "b": sig()],
                        tabs: tabs, live: sim.live, viewport: sim.viewport,
                        pendingStops: sim.pendingStops, lruOrder: sim.lruOrder,
                        now: t0.addingTimeInterval(10))
        sim.apply(back)
        XCTAssertEqual(back, [.detachViewport(tabId: "b1"),
                              .attachViewport(tabId: "a1"),
                              .cancelScheduledStop(sessionId: "a"),
                              .scheduleStop(sessionId: "b", at: t0.addingTimeInterval(310))])

        for action in away + back {
            switch action {
            case .stop(let tabId): XCTFail("hop inside the linger stopped \(tabId)")
            case .create(let tabId, _): XCTFail("hop inside the linger created \(tabId)")
            default: break
            }
        }
        XCTAssertEqual(sim.live, ["a1", "a2", "b1"])
    }

    // MARK: - Rule 5: stopImmediately (window close skips the linger)

    func test_stopImmediately_stopsNowWithNoLinger() {
        let actions = plan(sessions: ["s1": sig(stopImmediately: true)],
                           tabs: ["s1": [tab("t1", shown: true), tab("t2")]],
                           live: ["t1", "t2"],
                           lruOrder: ["t2", "t1"])
        XCTAssertEqual(actions, [.stop(tabId: "t1"), .stop(tabId: "t2")])
    }

    /// Window close while the session was the viewed one: the viewport is released first, then the
    /// browsers die. Live gate §10.4 ("close the window mid-audio → audio stops") is this row.
    func test_stopImmediately_overridesAStaleAttachedHere() {
        let actions = plan(sessions: ["s1": sig(attachedHere: true, stopImmediately: true)],
                           tabs: ["s1": [tab("t1", shown: true), tab("t2")]],
                           live: ["t1", "t2"],
                           viewport: "t1",
                           lruOrder: ["t2", "t1"])
        XCTAssertEqual(actions, [.detachViewport(tabId: "t1"),
                                 .stop(tabId: "t1"),
                                 .stop(tabId: "t2")])
    }

    /// Sharpening (documented in BrowserLifecycle.swift): `stopImmediately` skips the LINGER, it
    /// does not beat spec §4's "never stop mid-work … regardless of attachment". Closing the window
    /// on a running turn must not pull the agent's pages out from under it; the flag stays set, so
    /// the very next plan after the turn ends stops them with no linger.
    func test_stopImmediately_doesNotStopAWorkingSession() {
        let actions = plan(sessions: ["s1": sig(working: true, stopImmediately: true)],
                           tabs: ["s1": [tab("t1", shown: true), tab("t2")]],
                           live: ["t1", "t2"],
                           lruOrder: ["t2", "t1"])
        XCTAssertEqual(actions, [])
    }

    /// The other half of that sharpening, as an actual TRANSITION: the window closed mid-turn, the
    /// turn then ended, and the flag is still set. Two plans over one `Sim`, because the claim is
    /// about what changes between them — a single plan with `working: false` would just restate
    /// `test_stopImmediately_stopsNowWithNoLinger` with a different name.
    ///
    /// Note what this does NOT prove: that anything in the app RE-PLANS after work ends. The engine
    /// cannot force that (see `BrowserLifecycle.swift`'s requirement-on-the-caller note at the
    /// `.hold` branch — the `session.list` poll is gated off while the window is hidden), so this
    /// row pins the decision, and Task 5 owes the trigger.
    func test_stopImmediately_stopsOnceWorkEnds() {
        let tabs = ["s1": [tab("t1", shown: true), tab("t2")]]
        var sim = Sim(live: ["t1", "t2"], lruOrder: ["t2", "t1"])

        // Window closed while the turn is running: held, so nothing happens at all.
        let duringWork = plan(sessions: ["s1": sig(working: true, stopImmediately: true)],
                              tabs: tabs, live: sim.live, viewport: sim.viewport,
                              pendingStops: sim.pendingStops, lruOrder: sim.lruOrder, now: t0)
        sim.apply(duringWork)
        XCTAssertEqual(duringWork, [])
        XCTAssertEqual(sim.live, ["t1", "t2"])

        // The turn ends. The flag is still set, so the very next plan stops — with no linger and no
        // `scheduleStop` on the way.
        let afterWork = plan(sessions: ["s1": sig(stopImmediately: true)],
                             tabs: tabs, live: sim.live, viewport: sim.viewport,
                             pendingStops: sim.pendingStops, lruOrder: sim.lruOrder,
                             now: t0.addingTimeInterval(60))
        sim.apply(afterWork)
        XCTAssertEqual(afterWork, [.stop(tabId: "t1"), .stop(tabId: "t2")])
        XCTAssertEqual(sim.live, [])
    }

    /// A phone attached to the session keeps it alive by the same rule that `working` does — the
    /// Mac's window closing says nothing about the phone's harness.
    func test_stopImmediately_doesNotStopASessionAttachedElsewhere() {
        let actions = plan(sessions: ["s1": sig(attachedElsewhere: true, stopImmediately: true)],
                           tabs: ["s1": [tab("t1", shown: true)]],
                           live: ["t1"],
                           lruOrder: ["t1"])
        XCTAssertEqual(actions, [])
    }

    func test_stopImmediately_clearsAPendingDeadline() {
        let actions = plan(sessions: ["s1": sig(stopImmediately: true)],
                           tabs: ["s1": [tab("t1", shown: true)]],
                           live: ["t1"],
                           pendingStops: ["s1": t0.addingTimeInterval(120)],
                           lruOrder: ["t1"])
        XCTAssertEqual(actions, [.stop(tabId: "t1"), .cancelScheduledStop(sessionId: "s1")])
    }

    // MARK: - Rule 6: archived

    func test_archived_stopsNow() {
        let actions = plan(sessions: ["s1": sig(archived: true)],
                           tabs: ["s1": [tab("t1", shown: true), tab("t2")]],
                           live: ["t1", "t2"],
                           lruOrder: ["t2", "t1"])
        XCTAssertEqual(actions, [.stop(tabId: "t1"), .stop(tabId: "t2")])
    }

    /// Archived is the ONE disposition that beats every live-holding signal: the session is gone,
    /// so a turn still marked running on it cannot be a reason to keep renderers.
    func test_archived_beatsWorkingAndAttachedHere() {
        let actions = plan(sessions: ["s1": sig(attachedHere: true, working: true, archived: true)],
                           tabs: ["s1": [tab("t1", shown: true), tab("t2")]],
                           live: ["t1", "t2"],
                           viewport: "t1",
                           lruOrder: ["t2", "t1"])
        XCTAssertEqual(actions, [.detachViewport(tabId: "t1"),
                                 .stop(tabId: "t1"),
                                 .stop(tabId: "t2")])
    }

    /// …and it creates nothing, so an archived session cannot be woken by its own shown tab.
    func test_archived_createsNothing() {
        let actions = plan(sessions: ["s1": sig(attachedHere: true, archived: true)],
                           tabs: ["s1": [tab("t1", url: "https://a", shown: true)]],
                           live: [])
        XCTAssertEqual(actions, [])
    }

    func test_archived_clearsAPendingDeadline() {
        let actions = plan(sessions: ["s1": sig(archived: true)],
                           tabs: ["s1": [tab("t1", shown: true)]],
                           live: ["t1"],
                           pendingStops: ["s1": t0.addingTimeInterval(120)],
                           lruOrder: ["t1"])
        XCTAssertEqual(actions, [.stop(tabId: "t1"), .cancelScheduledStop(sessionId: "s1")])
    }

    // MARK: - Rule 7: the cap (a BUDGET since live-gate fix G)

    /// Ten live tabs across two phone-attached sessions; the cap is 8, so the two least-recently
    /// used EVICTABLE tabs go. Evictable = not a session's shown tab (which would be recreated on
    /// the very next plan) and not a working session's tab.
    func test_cap_overCap_stopsLeastRecentlyUsedFirst() {
        let tabsA = [tab("a0", shown: true)] + (1...4).map { tab("a\($0)") }
        let tabsB = [tab("b0", shown: true)] + (1...4).map { tab("b\($0)") }
        let all = Set(tabsA.map(\.tabId)).union(tabsB.map(\.tabId))
        XCTAssertEqual(all.count, 10)

        let actions = plan(sessions: ["a": sig(attachedElsewhere: true), "b": sig(attachedElsewhere: true)],
                           tabs: ["a": tabsA, "b": tabsB],
                           live: all,
                           lruOrder: ["a1", "b1", "a2", "b2", "a3", "b3", "a4", "b4", "a0", "b0"],
                           memoryBytesByTab: bytes(all, nFit: 8))
        XCTAssertEqual(actions, [.stop(tabId: "a1"), .stop(tabId: "b1")])
    }

    /// Exactly AT the budget, nothing is evicted — the rule is `>`, not `>=`.
    func test_cap_exactlyAtTheCap_evictsNothing() {
        let tabs = [tab("t0", shown: true)] + (1...7).map { tab("t\($0)") }
        let ids = Set(tabs.map(\.tabId))
        let actions = plan(sessions: ["a": sig(attachedElsewhere: true)],
                           tabs: ["a": tabs],
                           live: ids,
                           lruOrder: tabs.map(\.tabId),
                           memoryBytesByTab: bytes(ids, nFit: 8))
        XCTAssertEqual(actions, [])
    }

    /// The viewport tab is the least-recently-used entry, and is skipped: evicting it would black
    /// out the window the user is looking at.
    func test_cap_neverEvictsTheViewportTab() {
        let shownTabs = [tab("v", shown: true)] + (1...4).map { tab("s\($0)") }
        let otherTabs = [tab("o0", shown: true)] + (1...3).map { tab("o\($0)") }
        let all = Set(shownTabs.map(\.tabId)).union(otherTabs.map(\.tabId))
        XCTAssertEqual(all.count, 9)

        let actions = plan(sessions: ["s": sig(attachedHere: true), "o": sig(attachedElsewhere: true)],
                           tabs: ["s": shownTabs, "o": otherTabs],
                           live: all,
                           viewport: "v",
                           lruOrder: ["v", "s1", "s2", "s3", "s4", "o1", "o2", "o3", "o0"],
                           memoryBytesByTab: bytes(all, nFit: 8))
        XCTAssertEqual(actions, [.stop(tabId: "s1")])
    }

    /// A working session's tabs are the whole LRU tail and are all skipped; the one evictable tab
    /// elsewhere takes the hit.
    func test_cap_neverEvictsAWorkingSessionsTabs() {
        let workTabs = [tab("w0", shown: true)] + (1...6).map { tab("w\($0)") }
        let otherTabs = [tab("o0", shown: true), tab("o1")]
        let all = Set(workTabs.map(\.tabId)).union(otherTabs.map(\.tabId))
        XCTAssertEqual(all.count, 9)

        let actions = plan(sessions: ["w": sig(working: true), "o": sig(attachedElsewhere: true)],
                           tabs: ["w": workTabs, "o": otherTabs],
                           live: all,
                           lruOrder: ["w1", "w2", "w3", "w4", "w5", "w6", "w0", "o1", "o0"],
                           memoryBytesByTab: bytes(all, nFit: 8))
        XCTAssertEqual(actions, [.stop(tabId: "o1")])
    }

    /// THE SHARPENED EDGE (see BrowserLifecycle.swift's `capEvictions` doc): when everything live
    /// is protected, the cap is EXCEEDED rather than satisfied. Nine tabs, all belonging to a
    /// working session — zero stops.
    func test_cap_everythingProtected_exceedsTheCapRatherThanStopping() {
        let workTabs = [tab("w0", shown: true)] + (1...8).map { tab("w\($0)") }
        let ids = Set(workTabs.map(\.tabId))
        let actions = plan(sessions: ["w": sig(working: true)],
                           tabs: ["w": workTabs],
                           live: ids,
                           lruOrder: workTabs.map(\.tabId),
                           memoryBytesByTab: bytes(ids, nFit: 8))
        XCTAssertEqual(actions, [])
    }

    /// A create counts against the cap in the same plan that emits it — otherwise the cap is always
    /// one plan behind the growth it exists to bound.
    func test_cap_aCreateCountsTowardTheCap() {
        let tabs = [tab("t0", shown: true)] + (1...7).map { tab("t\($0)") }   // 8 live, exactly the budget
        let waking = [tab("n0", url: "https://n", shown: true)]               // +1 create
        let ids = Set(tabs.map(\.tabId))
        let actions = plan(sessions: ["a": sig(attachedElsewhere: true), "z": sig(working: true)],
                           tabs: ["a": tabs, "z": waking],
                           live: ids,
                           lruOrder: tabs.map(\.tabId),
                           memoryBytesByTab: bytes(ids, nFit: 8))
        XCTAssertEqual(actions, [.stop(tabId: "t1"), .create(tabId: "n0", url: "https://n")])
    }

    // ("a tab created by THIS plan is never an eviction candidate" had a row here with inputs
    // byte-identical to the one above, whose exact-equality assertion already proves it. Deleted as
    // decorative — and it cannot be made non-decorative: eviction candidates are drawn from
    // `live.subtracting(stopping)`, which a just-created tab is definitionally absent from, AND
    // every create targets a held session's shown tab, which the protected set covers. Two
    // independent structural guarantees, neither isolable by an input.)

    /// The belt and the cap interact through the count: a browser the belt is already stopping must
    /// NOT be counted as a survivor, or an orphan at the cap boundary buys a spurious eviction of a
    /// real tab. Eight legitimate live tabs (exactly the cap) plus one orphan → the orphan dies and
    /// nothing else does.
    func test_cap_beltStoppedOrphansDoNotCountAsSurvivors() {
        let tabs = [tab("a0", shown: true)] + (1...7).map { tab("a\($0)") }   // 8 = exactly the budget
        let live = Set(tabs.map(\.tabId)).union(["ghost"])
        let actions = plan(sessions: ["a": sig(attachedElsewhere: true)],
                           tabs: ["a": tabs],
                           live: live,
                           // `ghost` last = most-recently-used, so a mutation that counts it as a
                           // survivor evicts a REAL tab (a1) rather than double-stopping the orphan.
                           lruOrder: (1...7).map { "a\($0)" } + ["a0", "ghost"],
                           // The sampler measures every LIVE tab, orphan included — which is what
                           // makes the survivor arithmetic the thing under test: count the ghost in
                           // and the eight real tabs are over budget.
                           memoryBytesByTab: bytes(live, nFit: 8))
        XCTAssertEqual(actions, [.stop(tabId: "ghost")])
    }

    /// A quiet session inside its linger is HELD by the linger, not PROTECTED from the cap: its
    /// tabs — including its shown one — are ordinary eviction candidates. Deliberate: the linger
    /// exists so a hop back is cheap, not to reserve renderers for a session nobody is using, and
    /// the cap's own purpose is bounding exactly this kind of idle accumulation.
    func test_cap_evictsAQuietSessionsTabsEvenInsideTheLinger() {
        let quietTabs = [tab("q0", shown: true)] + (1...3).map { tab("q\($0)") }
        let heldTabs = [tab("h0", shown: true)] + (1...4).map { tab("h\($0)") }
        let all = Set(quietTabs.map(\.tabId)).union(heldTabs.map(\.tabId))
        XCTAssertEqual(all.count, 9)

        let actions = plan(sessions: ["h": sig(attachedElsewhere: true), "q": sig()],
                           tabs: ["h": heldTabs, "q": quietTabs],
                           live: all,
                           pendingStops: ["q": t0.addingTimeInterval(100)],   // well inside the linger
                           lruOrder: ["q0", "q1", "q2", "q3", "h1", "h2", "h3", "h4", "h0"],
                           memoryBytesByTab: bytes(all, nFit: 8))
        // The quiet session's SHOWN tab is the LRU-oldest and is taken — quiet is not `hold`, so
        // sharpening (c)'s shown-tab protection does not reach it.
        XCTAssertEqual(actions, [.stop(tabId: "q0")])
    }

    /// A live tab missing from `lruOrder` has unknown recency. It is evicted LAST (unknown recency
    /// is treated as most-recent, so a KNOWN-old tab always goes first) and, among such tabs,
    /// in sorted order — rule 10 leaves no ambiguity even on malformed input.
    func test_cap_tabsMissingFromLruOrderAreEvictedLastAndSorted() {
        let tabs = [tab("t0", shown: true)] + (1...9).map { tab("t\($0)") }   // 10 live, 8 fit
        let ids = Set(tabs.map(\.tabId))
        let actions = plan(sessions: ["a": sig(attachedElsewhere: true)],
                           tabs: ["a": tabs],
                           live: ids,
                           lruOrder: ["t3", "t1"],
                           memoryBytesByTab: bytes(ids, nFit: 8))
        XCTAssertEqual(actions, [.stop(tabId: "t3"), .stop(tabId: "t1")])
    }

    func test_cap_whenLruIsExhaustedTheRemainderIsSorted() {
        let tabs = [tab("t0", shown: true)] + (1...9).map { tab("t\($0)") }
        let ids = Set(tabs.map(\.tabId))
        let actions = plan(sessions: ["a": sig(attachedElsewhere: true)],
                           tabs: ["a": tabs],
                           live: ids,
                           lruOrder: ["t9"],
                           memoryBytesByTab: bytes(ids, nFit: 8))
        XCTAssertEqual(actions, [.stop(tabId: "t9"), .stop(tabId: "t1")])
    }

    /// **An UNMEASURED tab is never evicted for the budget's sake** — it contributed nothing to the
    /// total, so it cannot be why the total is over, and stopping it would free nothing while
    /// destroying a real page. Here the two measured tabs blow the budget between them and the
    /// unmeasured one sits first in LRU order: it is skipped, and the eviction reaches past it.
    ///
    /// (Today's sampler measures every live tab or none, so this is a contract the engine holds
    /// rather than a state the app produces — which is exactly why it needs a row rather than a
    /// comment.)
    func test_budget_anUnmeasuredTabIsNotEvictedToPayAByteOverage() {
        let tabs = [tab("t0", shown: true), tab("unmeasured"), tab("t1"), tab("t2")]
        let actions = plan(sessions: ["a": sig(attachedElsewhere: true)],
                           tabs: ["a": tabs],
                           live: ["t0", "unmeasured", "t1", "t2"],
                           lruOrder: ["unmeasured", "t1", "t2", "t0"],
                           memoryBytesByTab: bytes(["t0", "t1", "t2"], nFit: 2))
        XCTAssertEqual(actions, [.stop(tabId: "t1")])
    }

    // MARK: - Rule 10: determinism, and the documented action order

    /// One plan that emits all six action kinds, asserted as an exact sequence. The order is a
    /// CONTRACT for the executor (detach before stop; create before attach), not an accident of
    /// how the engine happens to build its arrays.
    func test_actionOrderIsDetachStopCreateAttachCancelSchedule() {
        let actions = plan(sessions: ["a": sig(archived: true),          // stop now
                                      "s": sig(attachedHere: true),     // create + attach
                                      "q": sig()],                      // schedule
                           tabs: ["a": [tab("a1", shown: true)],
                                  "s": [tab("s1", url: "https://s", shown: true)],
                                  "q": [tab("q1", shown: true)]],
                           live: ["a1", "q1", "ghost", "old"],
                           viewport: "old",
                           pendingStops: ["a": t0.addingTimeInterval(60)],
                           lruOrder: ["old", "a1", "q1"])
        XCTAssertEqual(actions, [.detachViewport(tabId: "old"),
                                 .stop(tabId: "ghost"),
                                 .stop(tabId: "old"),
                                 .stop(tabId: "a1"),
                                 .create(tabId: "s1", url: "https://s"),
                                 .attachViewport(tabId: "s1"),
                                 .cancelScheduledStop(sessionId: "a"),
                                 .scheduleStop(sessionId: "q", at: t0.addingTimeInterval(300))])
    }

    /// Session-keyed actions are ordered by sessionId, and a session's tabs in fold order — the two
    /// dictionary inputs have no order of their own, so the engine imposes one.
    func test_determinism_sessionsSortedByIdAndTabsInFoldOrder() {
        let sessions = ["zz": sig(), "aa": sig(), "mm": sig()]
        let tabs = ["zz": [tab("z2", shown: true), tab("z1")],
                    "aa": [tab("a2", shown: true), tab("a1")],
                    "mm": [tab("m2", shown: true), tab("m1")]]
        let expected: [BrowserAction] = [.scheduleStop(sessionId: "aa", at: t0.addingTimeInterval(300)),
                                         .scheduleStop(sessionId: "mm", at: t0.addingTimeInterval(300)),
                                         .scheduleStop(sessionId: "zz", at: t0.addingTimeInterval(300))]
        for _ in 0..<10 {
            XCTAssertEqual(plan(sessions: sessions, tabs: tabs,
                                live: ["z1", "z2", "a1", "a2", "m1", "m2"],
                                lruOrder: ["a1", "a2", "m1", "m2", "z1", "z2"]), expected)
        }
    }

    func test_determinism_expiredSessionsStopInSessionThenFoldOrder() {
        let sessions = ["zz": sig(), "aa": sig()]
        let tabs = ["zz": [tab("z2", shown: true), tab("z1")],
                    "aa": [tab("a2", shown: true), tab("a1")]]
        let actions = plan(sessions: sessions, tabs: tabs,
                           live: ["z1", "z2", "a1", "a2"],
                           pendingStops: ["zz": t0.addingTimeInterval(-1), "aa": t0.addingTimeInterval(-1)],
                           lruOrder: ["a1", "a2", "z1", "z2"])
        XCTAssertEqual(actions, [.stop(tabId: "a2"), .stop(tabId: "a1"),
                                 .stop(tabId: "z2"), .stop(tabId: "z1"),
                                 .cancelScheduledStop(sessionId: "aa"),
                                 .cancelScheduledStop(sessionId: "zz")])
    }

    /// Two sessions both claiming the viewport is incoherent input (one shell, one shown session),
    /// but it must still be DECIDED the same way every time: lowest sessionId wins.
    func test_determinism_twoSessionsClaimingAttachedHere_lowestIdOwnsTheViewport() {
        let actions = plan(sessions: ["b": sig(attachedHere: true), "a": sig(attachedHere: true)],
                           tabs: ["a": [tab("a1", shown: true)], "b": [tab("b1", shown: true)]],
                           live: ["a1", "b1"],
                           lruOrder: ["a1", "b1"])
        XCTAssertEqual(actions, [.attachViewport(tabId: "a1")])
    }

    // MARK: - Defaults and empty inputs

    func test_emptyInputs_planIsEmpty() {
        XCTAssertEqual(plan(), [])
    }

    /// A session with tabs but no signals entry yet (Task 5's list refresh has not reached it) is
    /// treated as quiet — the memory-safe default, and harmless because the linger is 300s and the
    /// first refresh cancels it.
    func test_sessionWithTabsButNoSignals_isTreatedAsQuiet() {
        let actions = plan(tabs: ["s1": [tab("t1", shown: true)]], live: ["t1"], lruOrder: ["t1"])
        XCTAssertEqual(actions, [.scheduleStop(sessionId: "s1", at: t0.addingTimeInterval(300))])
    }

    /// A deadline for a session the engine knows nothing about is cleared rather than left to fire
    /// forever into nothing.
    func test_pendingStopForAnUnknownSession_isCleared() {
        let actions = plan(pendingStops: ["gone": t0.addingTimeInterval(60)])
        XCTAssertEqual(actions, [.cancelScheduledStop(sessionId: "gone")])
    }

    // MARK: - Rule 9: idempotence

    func test_idempotent_shownSessionWaking() {
        assertIdempotent(sessions: ["s1": sig(attachedHere: true)],
                         tabs: ["s1": [tab("t1", url: "https://a", shown: true), tab("t2")]],
                         sim: Sim())
    }

    func test_idempotent_expiredLinger() {
        assertIdempotent(sessions: ["s1": sig()],
                         tabs: ["s1": [tab("t1", shown: true), tab("t2")]],
                         sim: Sim(live: ["t1", "t2"],
                                  pendingStops: ["s1": t0.addingTimeInterval(-1)],
                                  lruOrder: ["t2", "t1"]))
    }

    func test_idempotent_quietSchedulingItsFirstStop() {
        assertIdempotent(sessions: ["s1": sig()],
                         tabs: ["s1": [tab("t1", shown: true)]],
                         sim: Sim(live: ["t1"], lruOrder: ["t1"]))
    }

    func test_idempotent_archivedSession() {
        assertIdempotent(sessions: ["s1": sig(attachedHere: true, archived: true)],
                         tabs: ["s1": [tab("t1", shown: true), tab("t2")]],
                         sim: Sim(live: ["t1", "t2"],
                                  viewport: "t1",
                                  pendingStops: ["s1": t0.addingTimeInterval(60)],
                                  lruOrder: ["t2", "t1"]))
    }

    func test_idempotent_beltOrphans() {
        assertIdempotent(sessions: ["s1": sig(attachedHere: true)],
                         tabs: ["s1": [tab("t1", shown: true)]],
                         sim: Sim(live: ["t1", "ghost"], viewport: "t1", lruOrder: ["ghost", "t1"]))
    }

    func test_idempotent_windowClose() {
        assertIdempotent(sessions: ["s1": sig(attachedHere: true, stopImmediately: true)],
                         tabs: ["s1": [tab("t1", shown: true), tab("t2")]],
                         sim: Sim(live: ["t1", "t2"], viewport: "t1", lruOrder: ["t2", "t1"]))
    }

    /// The cap's second pass must not keep evicting: after one eviction the survivor count is at the
    /// cap, so the re-plan is empty (the shown tab it protected is NOT re-created either).
    func test_idempotent_capEviction() {
        let tabs = [tab("t0", shown: true)] + (1...8).map { tab("t\($0)") }
        let ids = Set(tabs.map(\.tabId))
        assertIdempotent(sessions: ["a": sig(attachedElsewhere: true)],
                         tabs: ["a": tabs],
                         sim: Sim(live: ids, lruOrder: tabs.map(\.tabId)),
                         memoryBytesByTab: bytes(ids, nFit: 8))
    }
}
