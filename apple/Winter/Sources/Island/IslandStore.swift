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

    // MARK: Reading

    var strip: IslandStripModel { IslandStripModel(waitingCount: cards.count) }

    func card(_ id: String) -> IslandCard? { cards.first { $0.id == id } }

    /// The card expanded on top, the one waiting under it, and the compacted count.
    var currentCard: IslandCard? { queue.current.flatMap { card($0.id) } }
    var waitingCard: IslandCard? { queue.waiting.flatMap { card($0.id) } }

    // MARK: Refresh

    private var refreshing = false
    private var refreshAgain = false

    /// Ask the daemon again (on connect, and on every `island.changed`). Overlapping asks collapse into one more.
    func refresh() async {
        if refreshing { refreshAgain = true; return }
        refreshing = true
        defer { refreshing = false }
        repeat {
            refreshAgain = false
            guard let items = try? await fetch() else { return }
            let next = items.compactMap(IslandCard.from)
            await judgeTerminals(for: next)
            apply(next)
        } while refreshAgain
    }

    /// Re-judge where every card goes (the focus changed: an app came to the front, a window became key, the
    /// Dispatch pill showed or hid, a terminal's tab changed).
    func reroute() async {
        guard !cards.isEmpty else { return }
        await judgeTerminals(for: cards)
        apply(cards)
    }

    private func judgeTerminals(for cards: [IslandCard]) async {
        let ttys = IslandRouter.ttysToJudge(cards, focus: focus())
        terminalFrontness = ttys.isEmpty ? [:] : await readTerminals(ttys)
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
        // Off the top: hidden behind its host, or the Dispatch pill shows it.
        for id in queue.ids where placed[id] != .top { queue.resolve(id, now: now) }
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

/// The slim strip's state: the "waiting for you" count.
struct IslandStripModel: Equatable {
    let waitingCount: Int

    /// "2" — nothing when nothing waits.
    var countLabel: String? { waitingCount > 0 ? "\(waitingCount)" : nil }
    var accessibilityLabel: String {
        switch waitingCount {
        case 0: return "Winter island. Nothing needs you."
        case 1: return "Winter island. 1 thing needs you."
        default: return "Winter island. \(waitingCount) things need you."
        }
    }
}

/// The badge hugging the housing: "2 waiting".
func islandBadgeLabel(_ count: Int) -> String { "\(count) waiting" }
