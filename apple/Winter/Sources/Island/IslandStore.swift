import AppKit
import Combine
import SwiftUI
import WinterKit
import WinterProtocol

// The Winter island's state (`docs/claude/island.md`): every pending card (from `island.pending`), where each one goes
// (`IslandRouter`), what is on top (`IslandQueue`), the open island's tab, and the answers in flight. Main-actor;
// every input is injected, so `IslandStoreTests` drives it with fakes. Idle cost: nothing — the only clock is ONE
// one-shot wake-up at the queue's next self-compaction, armed only while a card is expanded on top.

/// How the island answers (WinterKit's respond calls, against the card's answer session).
struct IslandResponder {
    var approval: (_ sessionId: String, _ callId: String, _ approved: Bool, _ optionId: String?) async -> Bool
    var question: (_ sessionId: String, _ callId: String, _ answers: [String: String], _ notes: [String: String]) async -> Bool
    var elicitationURL: (_ sessionId: String, _ elicitationId: String) async -> String?
    var elicitation: (_ sessionId: String, _ elicitationId: String, _ accept: Bool) async -> ElicitationSendResult

    static let inert = IslandResponder(approval: { _, _, _, _ in false }, question: { _, _, _, _ in false },
                                       elicitationURL: { _, _ in nil }, elicitation: { _, _, _ in .failed })

    /// The live answers, through the app's own client (the island never attaches to the sessions it answers).
    static func live(_ client: WinterClient) -> IslandResponder {
        IslandResponder(
            approval: { sid, callId, approved, optionId in
                (try? await client.approvalRespond(sessionId: sid, callId: callId, approved: approved, optionId: optionId)) != nil
            },
            question: { sid, callId, answers, notes in
                (try? await client.askUserRespond(sessionId: sid, callId: callId, answers: answers, notes: notes.isEmpty ? nil : notes)) != nil
            },
            elicitationURL: { sid, id in try? await client.elicitationURL(sessionId: sid, elicitationId: id) },
            elicitation: { sid, id, accept in
                elicitationSendResult(alreadyResolved: try? await client.elicitationRespond(sessionId: sid, elicitationId: id, accept: accept))
            }
        )
    }
}

@MainActor
final class IslandStore: ObservableObject {
    /// Every pending card, oldest first — the Needs-you list and the strip's count.
    @Published private(set) var cards: [IslandCard] = []
    /// Where each card goes now.
    @Published private(set) var placements: [String: IslandPlacement] = [:]
    /// What is on top.
    @Published private(set) var queue = IslandQueue()
    /// The open island's tab.
    @Published var tabs = IslandTabState()
    /// Answers sent and not yet settled; a failed one's line.
    @Published private(set) var inFlight: Set<String> = []
    @Published private(set) var errors: [String: String] = [:]
    /// Cards answered from the island itself — the view request goes back up into the housing.
    private(set) var answeredHere: Set<String> = []

    /// Cards that have been on top before: when one comes back after being hidden (its host was in front), it goes
    /// straight to the badge instead of popping out again.
    private var everOnTop: Set<String> = []
    /// What the routing last judged each terminal (tty) to be; refreshed before each apply that needs it.
    private(set) var terminalFrontness: [String: TerminalFrontness] = [:]
    /// Typed answers to question cards in the Needs-you list (`TranscriptInteractionCard`), by card id.
    var drafts: [String: PendingCardDraft] = [:]

    // MARK: Seams

    /// `island.pending`.
    var fetch: () async throws -> [IslandPendingItem] = { [] }
    /// The focus facts the router reads (the terminal part is filled from `terminalFrontness`).
    var focus: () -> IslandFocus = { IslandFocus() }
    /// Reads the terminals' frontness for these ttys (off the main thread in the app; synchronous fakes in tests).
    var readTerminals: (Set<String>) async -> [String: TerminalFrontness] = { ttys in
        Dictionary(uniqueKeysWithValues: ttys.map { ($0, TerminalFrontness.unknown) })
    }
    var responder = IslandResponder.inert
    /// Monotonic seconds.
    var clock: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
    /// Arms the one wake-up (nil cancels). The app uses a `DispatchWorkItem`; tests call `tick()` by hand.
    var scheduleWake: (TimeInterval?) -> Void = { _ in }
    /// Opens a link (an elicitation's "Open link").
    var openURL: (URL) -> Bool = { _ in false }
    /// Told after every change of what is on top (the controller lays out its panels).
    var onChange: (() -> Void)?
    /// Acks view requests the controller has on screen (`WinterClient.islandShown`).
    var onShown: (([String]) -> Void)?

    // MARK: Reading

    /// Sessions the daemon last said are working (the session directory's `signals.working`) — the strip's second count.
    @Published var workingSessions = 0

    var strip: IslandStripModel { IslandStripModel(waitingCount: cards.count, workingCount: workingSessions) }

    func card(_ id: String) -> IslandCard? { cards.first { $0.id == id } }

    /// The card expanded on top, the one waiting under it, and the compacted count.
    var currentCard: IslandCard? { queue.current.flatMap { card($0.id) } }
    var waitingCard: IslandCard? { queue.waiting.flatMap { card($0.id) } }

    // MARK: Refresh

    // ONE pump serves both asks: a fetch (`refresh`) and a re-judging (`reroute`). Only one runs at a time; asks that
    // arrive meanwhile collapse into one more pass, and a pass whose judgement went stale while it was being read (a
    // newer ask came in — `generation` moved) is not applied: the next pass applies fresh facts instead.
    private var pumping = false
    private var wantFetch = false
    private var wantRoute = false
    /// Bumped by every ask; a judgement is applied only when no ask came in while it was read.
    private(set) var generation = 0
    /// The newest list fetched and not yet applied (kept across a pass skipped as stale).
    private var fetched: [IslandCard]?
    /// A pass skipped as stale this many times in a row is applied anyway: a burst of asks never starves the island.
    static let maxStaleSkips = 3
    private var staleSkips = 0

    /// Ask the daemon again (on connect, and on every `island.changed`).
    func refresh() async {
        wantFetch = true
        generation += 1
        await pump()
    }

    /// Re-judge where every card goes (the focus changed: an app came to the front, a window became key, the
    /// Dispatch pill showed or hid, a terminal's tab changed). Coalesced with any fetch or re-judging under way.
    func reroute() async {
        guard !cards.isEmpty || wantFetch || fetched != nil else { return }
        wantRoute = true
        generation += 1
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
            let started = generation
            // A failed fetch keeps whatever re-judging was asked with it: the pass goes on with the cards it has.
            if fetchNow, let items = try? await fetch() {
                fetched = items.compactMap(IslandCard.from)
            }
            let next = fetched ?? cards
            let judged = await judgeTerminals(for: next)
            // Stale: another ask came in while this one read the terminals — run again with what is true now, unless
            // that has already happened `maxStaleSkips` times in a row (then this one is applied, and the next pass
            // still runs for the newer ask).
            if started != generation || wantFetch || wantRoute, staleSkips < Self.maxStaleSkips {
                staleSkips += 1
                continue
            }
            staleSkips = 0
            terminalFrontness = judged
            fetched = nil
            apply(next)
        }
    }

    private func judgeTerminals(for cards: [IslandCard]) async -> [String: TerminalFrontness] {
        let ttys = IslandRouter.ttysToJudge(cards, focus: focus())
        return ttys.isEmpty ? [:] : await readTerminals(ttys)
    }

    /// The cards' current focus, with the terminal judgements filled in.
    private func currentFocus() -> IslandFocus {
        var f = focus()
        let judged = terminalFrontness
        f.terminalFrontness = { judged[$0] ?? .unknown }
        return f
    }

    /// Reconciles a fresh card list with the queue (PURE apart from the published state; tests call it directly).
    func apply(_ next: [IslandCard]) {
        let now = clock()
        let ids = Set(next.map(\.id))
        // Answered anywhere (or gone): out of the queue.
        for id in queue.ids where !ids.contains(id) { queue.resolve(id, now: now) }
        everOnTop.formIntersection(ids)
        answeredHere.formIntersection(ids)
        inFlight.formIntersection(ids)
        errors = errors.filter { ids.contains($0.key) }
        drafts = drafts.filter { ids.contains($0.key) }

        let focus = currentFocus()
        var placed: [String: IslandPlacement] = [:]
        for card in next { placed[card.id] = IslandRouter.placement(of: card, focus: focus) }
        // Off the top: hidden behind its host, or the Dispatch pill shows it — never the card being typed into.
        for id in queue.ids where placed[id] != .top && !(queue.currentTyping && queue.current?.id == id) {
            queue.resolve(id, now: now)
        }
        // Onto the top: new ones arrive (oldest first, so the newest ends up expanded); ones seen before go to the badge.
        // (A card answered from here is not brought back by a list fetched before the answer landed.)
        for card in next where placed[card.id] == .top && !queue.ids.contains(card.id)
            && !(answeredHere.contains(card.id) && !inFlight.contains(card.id)) {
            if everOnTop.contains(card.id) {
                queue.addCompacted(card.id, selfCompacts: card.kind.selfCompacts)
            } else {
                queue.arrive(card.id, selfCompacts: card.kind.selfCompacts, now: now)
                everOnTop.insert(card.id)
            }
        }
        cards = next
        placements = placed
        changed()
    }

    /// The view requests the queue holds on top (expanded, waiting or compacted): what the controller acks to the
    /// daemon (`island.shown`) once its panel is actually on screen.
    var viewRequestsOnTop: [IslandCard] {
        let held = queue.ids
        return cards.filter { $0.kind == .viewRequest && held.contains($0.id) }
    }

    // MARK: The queue's inputs

    func tick() {
        queue.tick(now: clock())
        changed()
    }

    func hoverCurrent(_ hovered: Bool) {
        guard queue.currentHovered != hovered else { return }
        queue.hoverCurrent(hovered, now: clock())
        changed()
    }

    /// The current card's panel took the keyboard (a click in its text field) or gave it back.
    func typingCurrent(_ typing: Bool) {
        guard queue.currentTyping != typing else { return }
        queue.typingCurrent(typing, now: clock())
        changed()
        // Typing held the card on top whatever the routing said; now the routing decides again (its host may have
        // come to the front meanwhile).
        if !typing { Task { await reroute() } }
    }

    func clickWaiting() {
        queue.clickWaiting(now: clock())
        changed()
    }

    func hoverBadge() {
        guard queue.current == nil else { return }
        queue.expandNewestCompacted(now: clock())
        changed()
    }

    private func changed() {
        scheduleWake(queue.nextDeadline)
        onChange?()
    }

    // MARK: Answers

    /// ✕ / ✓ on an approval (✓ = allow once, or the card's chosen rule option), and the view request's ✕ / ✓
    /// (✓ = switch now, the card's `switch` option).
    func answerApproval(_ card: IslandCard, approved: Bool, optionId: String? = nil) {
        let option = card.kind == .viewRequest && approved ? DesktopVisitCardWords.switchOptionId : optionId
        send(card) { r in await r.approval(card.answerSessionId, card.callId, approved, option) }
    }

    func answerQuestion(_ card: IslandCard, answers: [String: String], notes: [String: String] = [:]) {
        send(card) { r in await r.question(card.answerSessionId, card.callId, answers, notes) }
    }

    func answerElicitation(_ card: IslandCard, accept: Bool) {
        guard case .elicitation(_, _, let host, _) = card.payload else { return }
        let responder = responder
        let open = openURL
        begin(card)
        Task { @MainActor [weak self] in
            let result = await performElicitationAnswer(
                accept: accept, host: host, expiresAt: card.expiresAt ?? islandUnknownExpiry(),
                fetchURL: { await responder.elicitationURL(card.answerSessionId, card.callId) },
                open: open,
                send: { await responder.elicitation(card.answerSessionId, card.callId, $0) })
            switch result {
            case .done, .inactive: self?.settle(card, ok: true)
            case .error(let line): self?.settle(card, ok: false, line: line)
            }
        }
    }

    private func send(_ card: IslandCard, _ call: @escaping (IslandResponder) async -> Bool) {
        let responder = responder
        begin(card)
        Task { @MainActor [weak self] in
            let ok = await call(responder)
            self?.settle(card, ok: ok)
        }
    }

    private func begin(_ card: IslandCard) {
        inFlight.insert(card.id)
        errors[card.id] = nil
        answeredHere.insert(card.id)
    }

    /// An answer came back: on success the card leaves the top at once (the daemon's `island.changed` confirms);
    /// on failure it stays, with a line saying so.
    private func settle(_ card: IslandCard, ok: Bool, line: String = "couldn't send — try again") {
        inFlight.remove(card.id)
        if ok {
            queue.resolve(card.id, now: clock())
            changed()
        } else {
            answeredHere.remove(card.id)
            errors[card.id] = line
            onChange?()
        }
    }

    /// The question card's draft binding, for the Needs-you list's full card.
    func draftBinding(for cardId: String) -> Binding<PendingCardDraft> {
        Binding(get: { [weak self] in self?.drafts[cardId] ?? PendingCardDraft() },
                set: { [weak self] in self?.drafts[cardId] = $0 })
    }
}

/// The slim strip's state: the "waiting for you" count, and the working-sessions count beside it.
struct IslandStripModel: Equatable {
    let waitingCount: Int
    var workingCount: Int = 0

    /// The wings show (and take clicks) only while they have something to say; idle, the strip is the housing alone.
    var showsWings: Bool { waitingCount > 0 || workingCount > 0 }
    /// "2" — nothing when nothing waits.
    var countLabel: String? { waitingCount > 0 ? "\(waitingCount)" : nil }
    /// "3" — nothing when nothing works.
    var workingLabel: String? { workingCount > 0 ? "\(workingCount)" : nil }
    var accessibilityLabel: String {
        let waiting: String
        switch waitingCount {
        case 0: waiting = "Winter island. Nothing needs you."
        case 1: waiting = "Winter island. 1 thing needs you."
        default: waiting = "Winter island. \(waitingCount) things need you."
        }
        switch workingCount {
        case 0: return waiting
        case 1: return waiting + " 1 session working."
        default: return waiting + " \(workingCount) sessions working."
        }
    }
}

/// The badge hugging the housing: "2 waiting".
func islandBadgeLabel(_ count: Int) -> String { "\(count) waiting" }
