import Foundation
import SwiftUI
import WinterKit

// The Winter island's ACTIVITY state (phase 2, `docs/claude/island.md`): the computer-use pill (`IslandCUState`), the
// turn-result cards (`IslandResultQueue`) and the Watches tab, from the daemon's `island.activity` plus the agent
// cursor's own words (the helper's `view.cursor`, through `MirrorCoordinator`). Main-actor; every input is injected, so
// `IslandActivityStoreTests` drives it with fakes. Idle cost: nothing — the only clock is ONE one-shot wake-up, armed
// only while a pill lingers or a result shows.

@MainActor
final class IslandActivityStore: ObservableObject {
    @Published private(set) var cu = IslandCUState()
    @Published private(set) var results = IslandResultQueue()
    /// The results the queue holds, by id.
    @Published private(set) var resultItems: [String: IslandResultItem] = [:]
    /// Every armed computer-use watch, oldest first (the Watches tab).
    @Published private(set) var watches: [IslandWatchItem] = []
    /// Computer-use sessions whose host is in front (their pill is not shown: the user sees the work there).
    @Published private(set) var hiddenSessions: Set<String> = []
    /// The user opened the pill into its mirror — of THIS session (another session taking the pill closes it).
    @Published private(set) var mirrorOpen = false
    private(set) var mirrorSessionId: String?
    /// Watches being disarmed, and a failed one's line.
    @Published private(set) var disarming: Set<String> = []
    @Published private(set) var disarmErrors: [String: String] = [:]

    // MARK: Seams

    /// `island.activity`.
    var fetch: () async throws -> IslandActivitySnapshot = { .empty }
    /// The focus facts (the island's own: `IslandStore.focus`).
    var focus: () -> IslandFocus = { IslandFocus() }
    var readTerminals: (Set<String>) async -> [String: TerminalFrontness] = { ttys in
        Dictionary(uniqueKeysWithValues: ttys.map { ($0, TerminalFrontness.unknown) })
    }
    /// Monotonic seconds, and the wall clock (epoch seconds) a result's age is read against.
    var clock: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
    var wallClock: () -> TimeInterval = { Date().timeIntervalSince1970 }
    /// Arms the one wake-up (nil cancels).
    var scheduleWake: (TimeInterval?) -> Void = { _ in }
    /// Moves the app's view to a session (a result's Open).
    var openSession: (String) -> Void = { _ in }
    /// `computerUse.wakes.cancel`.
    var disarm: (_ sessionId: String, _ wakeId: String) async -> Bool = { _, _ in false }
    /// Told after every change of what the activity panel may draw.
    var onChange: (() -> Void)?
    /// The sessions whose agent cursor the pill follows changed (the app subscribes to their `view.cursor`).
    var onCursorSessionsChange: ((Set<String>) -> Void)?

    /// A card needing an answer owns the top (the phase-1 queue): results are held, the pill yields.
    private(set) var cardOnTop = false

    // MARK: Reading

    var cuPresentation: IslandCUPresentation? { cu.presentation(hidden: hiddenSessions) }
    /// Rung 4 somewhere: the agent's hardware pointer is in use — the island's slot and detached mirrors step aside.
    var usingRealMouse: Bool { cu.usingRealMouse }
    var currentResult: IslandResultItem? { results.current.flatMap { resultItems[$0.id] } }

    // MARK: Refresh

    private var pumping = false
    private var wantFetch = false
    private var wantRoute = false
    private var last = IslandActivitySnapshot.empty
    private var cursorSessions: Set<String> = []

    /// Ask the daemon again (on connect, and on every `island.activityChanged`).
    func refresh() async {
        wantFetch = true
        await pump()
    }

    /// Re-judge which computer-use sessions have their host in front (the focus changed).
    func reroute() async {
        guard !cu.sessions.isEmpty else { return }
        wantRoute = true
        await pump()
    }

    private func pump() async {
        guard !pumping else { return }
        pumping = true
        defer { pumping = false }
        while wantFetch || wantRoute {
            let fetchNow = wantFetch
            wantFetch = false
            wantRoute = false
            var next = last
            if fetchNow, let fresh = try? await fetch() { next = fresh }
            let f = focus()
            let fresh = next.results.filter { !results.seen.contains($0.id) }
            let judge = next.computerUse.map { ($0.sessionId, $0.session, $0.hosts) } + fresh.map { ($0.sessionId, $0.session, $0.hosts) }
            let ttys = IslandRouter.ttysToJudge(sessions: judge.map { (sessionId: $0.0, facts: $0.1, hosts: $0.2) }, focus: f)
            let judged = ttys.isEmpty ? [:] : await readTerminals(ttys)
            apply(next, terminals: judged)
        }
    }

    /// Reconciles a fresh snapshot (PURE apart from the published state; tests call it directly).
    func apply(_ snapshot: IslandActivitySnapshot, terminals: [String: TerminalFrontness] = [:]) {
        let now = clock()
        last = snapshot
        var f = focus()
        f.terminalFrontness = { terminals[$0] ?? .unknown }

        // Computer use: who, and whose host is in front (only "in front" hides the pill; Dispatch's family keeps it —
        // the Dispatch pill does not say what the computer is doing).
        cu.apply(snapshot.computerUse, now: now)
        var hidden = Set<String>()
        for item in snapshot.computerUse
        where IslandRouter.placement(sessionId: item.sessionId, facts: item.session, hosts: item.hosts, focus: f) == .hidden {
            hidden.insert(item.sessionId)
        }
        if hidden != hiddenSessions { hiddenSessions = hidden }

        // Results: born once, or dropped once (never deferred); one the daemon no longer lists (the session moved on)
        // goes.
        let listed = Set(snapshot.results.map(\.id))
        for id in [results.current?.id, results.held?.id].compactMap({ $0 }) where !listed.contains(id) { results.dismiss(id) }
        for item in snapshot.results where !results.seen.contains(item.id) {
            let placement = IslandRouter.placement(sessionId: item.sessionId, facts: item.session, hosts: item.hosts, focus: f)
            let age = wallClock() - Double(item.at) / 1000
            if IslandResultQueue.shouldBear(placement: placement, ageSeconds: age) {
                results.arrive(item.id, busy: cardOnTop, now: now)
                resultItems[item.id] = item
            } else {
                results.markSeen(item.id)
            }
        }
        pruneResultItems()

        let w = snapshot.watches.sorted { $0.armedAt == $1.armedAt ? $0.wakeId < $1.wakeId : $0.armedAt < $1.armedAt }
        if w != watches { watches = w }
        disarming.formIntersection(Set(w.map(\.wakeId)))
        let armed = Set(w.map(\.wakeId))
        if disarmErrors.keys.contains(where: { !armed.contains($0) }) { disarmErrors = disarmErrors.filter { armed.contains($0.key) } }
        changed()
    }

    // MARK: Inputs

    /// The agent cursor did something (the helper's `view.cursor`, for a session the pill follows).
    func cursor(sessionId: String, kind: String, text: String?, appName: String?) {
        guard cu.sessions[sessionId] != nil else { return }
        let before = cu
        cu.cursor(sessionId: sessionId, kind: kind, text: text, appName: appName, now: clock())
        if cu != before { changed() }
    }

    /// The helper's connection was lost (`MirrorCoordinator`): the cursor stream is gone, and rung 4 with it.
    func helperConnectionLost() {
        let before = cu
        cu.helperConnectionLost()
        if cu != before { changed() }
    }

    /// The phase-1 queue's top changed: a card needing an answer is (or no longer is) on top.
    func setCardOnTop(_ busy: Bool) {
        guard busy != cardOnTop else { return }
        cardOnTop = busy
        results.setBusy(busy, now: clock())
        pruneResultItems()
        changed()
    }

    func tick() {
        let now = clock()
        cu.tick(now: now)
        results.tick(now: now)
        pruneResultItems()
        changed()
    }

    func hoverResult(_ on: Bool) {
        guard results.current != nil, results.hovered != on else { return }
        results.hover(on, now: clock())
        changed()
    }

    /// ✕ on a result.
    func dismissResult(_ id: String) {
        results.dismiss(id)
        pruneResultItems()
        changed()
    }

    /// Open on a result: the app shows the session; the card goes.
    func openResult(_ id: String) {
        if let item = resultItems[id] { openSession(item.sessionId) }
        dismissResult(id)
    }

    /// A click on the computer-use pill opens its mirror; on the mirror's ✕ (or a click on its header) it closes.
    func setMirrorOpen(_ open: Bool) {
        let next = open && cuPresentation != nil
        guard next != mirrorOpen else { return }
        mirrorOpen = next
        mirrorSessionId = next ? cuPresentation?.sessionId : nil
        changed()
    }

    /// The Watches tab's Stop: `computerUse.wakes.cancel`.
    func disarmWatch(_ watch: IslandWatchItem) {
        guard !disarming.contains(watch.wakeId) else { return }
        disarming.insert(watch.wakeId)
        disarmErrors[watch.wakeId] = nil
        let disarm = self.disarm
        Task { @MainActor [weak self] in
            let ok = await disarm(watch.sessionId, watch.wakeId)
            guard let self else { return }
            if ok {
                // The daemon's `island.activityChanged` confirms; until then it reads as stopping.
                self.watches.removeAll { $0.wakeId == watch.wakeId }
            } else {
                self.disarmErrors[watch.wakeId] = "couldn't stop it — it may have ended already"
            }
            self.disarming.remove(watch.wakeId)
        }
    }

    private func pruneResultItems() {
        let keep = Set([results.current?.id, results.held?.id].compactMap { $0 })
        if resultItems.keys.contains(where: { !keep.contains($0) }) { resultItems = resultItems.filter { keep.contains($0.key) } }
    }

    private func changed() {
        // The mirror shows the session it was opened on: when the pill moves to another session (a focus or recency
        // change), or has nothing left, the mirror closes back to the pill — never another session's pictures.
        if mirrorOpen, cuPresentation?.sessionId != mirrorSessionId {
            mirrorOpen = false
            mirrorSessionId = nil
        }
        let deadlines = [cu.nextDeadline, results.nextDeadline].compactMap { $0 }
        scheduleWake(deadlines.min())
        let sessions = cu.activeSessionIds
        if sessions != cursorSessions {
            cursorSessions = sessions
            onCursorSessionsChange?(sessions)
        }
        onChange?()
    }
}

// MARK: - The Watches tab's words (pure — `IslandWatchesTests`)

/// PURE: a watch's condition as a person says it — "click “Submit”", "“Saved” to appear", "the title to change".
func islandWatchConditionLine(_ w: IslandWatchItem) -> String {
    let element = w.elementLabel?.trimmingCharacters(in: .whitespacesAndNewlines).islandBlankToNil
    switch w.condition {
    case "clicked": return element.map { "You click \($0)" } ?? "You click"
    case "submitted": return element.map { "You submit \($0)" } ?? "You submit the form"
    case "navigated": return element.map { "The page goes to \($0)" } ?? "The page changes"
    case "appeared": return element.map { "\($0) appears" } ?? "Something appears"
    case "gone": return element.map { "\($0) goes away" } ?? "Something goes away"
    case "changed": return element.map { "You change \($0)" } ?? "You change the field"
    case "titled": return element.map { "The title becomes \($0)" } ?? "The title changes"
    default: return element ?? w.condition
    }
}

/// PURE: how long ago it was armed, and how long it has left — "armed 4 min ago · 56 min left".
func islandWatchTimeLine(_ w: IslandWatchItem, nowMs: Int) -> String {
    func span(_ ms: Int) -> String {
        let minutes = max(0, ms) / 60_000
        if minutes < 1 { return "under a minute" }
        if minutes < 60 { return "\(minutes) min" }
        let h = minutes / 60, m = minutes % 60
        return m == 0 ? "\(h) h" : "\(h) h \(m) min"
    }
    let armed = nowMs - w.armedAt < 60_000 ? "armed just now" : "armed \(span(nowMs - w.armedAt)) ago"
    return "\(armed) · \(span(w.expiresAt - nowMs)) left"
}

/// PURE: the session a watch belongs to, as the tab names it.
func islandWatchSessionLine(_ w: IslandWatchItem) -> String {
    if let title = w.session.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty { return title }
    switch w.session.mode {
    case "dispatch": return "Dispatch"
    case "chat": return "Chat"
    default: return w.session.origin == "dispatch-child" ? "Dispatch task" : "Session"
    }
}

/// PURE: the symbol for a watch's condition.
func islandWatchSymbol(_ condition: String) -> String {
    switch condition {
    case "clicked": return "cursorarrow.click"
    case "submitted": return "paperplane"
    case "navigated": return "arrow.right.circle"
    case "appeared": return "text.viewfinder"
    case "gone": return "eye.slash"
    case "changed": return "character.cursor.ibeam"
    case "titled": return "macwindow"
    default: return "eye"
    }
}

extension String {
    fileprivate var islandBlankToNil: String? { isEmpty ? nil : self }
}
