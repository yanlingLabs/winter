import SwiftUI
import WinterProtocol

// The asks waiting on the user, as the Dispatch pill shows them (user, 2026-10-17): the pill's OWN black shell
// grows and morphs INTO the card — one shape, the same spring, morph blur, rim and shadow as every other change of
// shape the pill makes — and morphs back into the pill once the card is answered (here, on the island, on the
// phone). No second panel is stacked above it. The card itself is drawn in the pill's own language
// (`DispatchPillCardView`), not the transcript's.
//
// This file is the pure layer: which asks are pending, which one the pill has become (`DispatchPillCardQueue`),
// what the card says about who is asking, and when a question's ✓ is enabled. Table-tested in
// `DispatchPillCardTests`.

// MARK: - Which asks are pending (pure — `DispatchPillViewTests`)

/// PURE: every ask the daemon is still waiting on, oldest first — the live
/// `OrbSessionState.pendingInteractions` list UNIONED with the transcript's still-pending interaction
/// records (exactly what `TranscriptView` draws as live cards).
///
/// Both halves are needed, and the transcript half is the one that matters for dispatch.
/// `pendingInteractions` is emptied wholesale by the dispatch session's own turn end
/// (`SessionReducer.endOutstandingInteractions`), but a mirrored CHILD session's ask outlives the
/// parent's turn — the child is still blocked on it (`interactionEndsWithItsTurn` is false for a
/// `childSessionId` record, so its transcript record stays `outcome == nil` until it is answered).
/// Children normally keep running after Dispatch's turn ends, so a pill fed from
/// `pendingInteractions` ALONE would drop a child's approval exactly when it matters. The live list
/// is kept as the other half so an ask that has not (yet) produced a transcript record still shows.
/// Deduplicated by callId; transcript order first (oldest first), then any live-only asks.
///
/// `inactive` is `FieldStateAdapter.inactiveElicitations` — URL-mode elicitation cards this surface
/// already resolved locally as no longer active.
func pendingInteractionRecords(
    in exchanges: [Exchange],
    live: [PendingInteraction] = [],
    inactive: Set<String> = []
) -> [InteractionRecord] {
    var records: [InteractionRecord] = []
    var seen = Set<String>()
    for exchange in exchanges {
        for item in exchange.activity {
            guard let record = item.interactionRecord, interactionIsPending(record),
                  elicitationLocalOutcome(record, inactive: inactive) == nil,
                  seen.insert(record.callId).inserted else { continue }
            records.append(record)
        }
    }
    for interaction in live where !inactive.contains(interaction.callId) {
        guard seen.insert(interaction.callId).inserted else { continue }
        records.append(interactionRecord(for: interaction))
    }
    return records
}

/// The transcript-shaped record of a live pending interaction — same payload, no outcome.
func interactionRecord(for interaction: PendingInteraction) -> InteractionRecord {
    switch interaction {
    case .approval(let callId, let toolName, let summary, let reviewerReason, let childSessionId, let options, let defaultAllowAt):
        return InteractionRecord(callId: callId,
                                 ask: .approval(toolName: toolName, summary: summary,
                                                reviewerReason: reviewerReason, options: options, defaultAllowAt: defaultAllowAt),
                                 childSessionId: childSessionId)
    case .question(let callId, let questions, let childSessionId):
        return InteractionRecord(callId: callId, ask: .question(questions: questions), childSessionId: childSessionId)
    case .plan(let callId, let plan):
        return InteractionRecord(callId: callId, ask: .plan(plan: plan))
    case .urlElicitation(let callId, let serverName, let message, let host, let origin, let expiresAt):
        return InteractionRecord(callId: callId,
                                 ask: .urlElicitation(serverName: serverName, message: message, host: host,
                                                      origin: origin, expiresAt: expiresAt))
    }
}

// MARK: - Which ask the pill has become (pure — `DispatchPillCardTests`)

/// The pill's card state machine: pill → card → pill.
///
/// - The pill BECOMES the oldest pending ask (`front`) — one at a time; the rest wait, counted on the card
///   ("+2 waiting"). A card on the pill is never replaced while it is still pending: a newer ask waits behind it.
/// - Answered anywhere (here, the island, the phone, a timeout) → it leaves the pending list → the next one takes
///   its place (the shape springs card → card), or the pill morphs back.
/// - The user may put the cards ASIDE: typing (a keystroke lands in the composer, mounted under the card) sets every
///   pending card aside and the pill becomes the typing pill again. An ask that ARRIVES while the user is typing is
///   set aside at once — a card never takes over a composer being written in. Set-aside cards wait behind a small
///   "waiting for you" pill above the main one; they come back (`bringBack`) when it is clicked, or when the
///   composer is empty again (sent, cleared, or put away).
struct DispatchPillCardQueue: Equatable {
    /// The ask the pill has become, nil = the pill itself.
    private(set) var front: String?
    /// Asks the user set aside (by typing), still pending.
    private(set) var setAside: Set<String> = []
    /// Every pending ask, oldest first, as of the last update.
    private(set) var pending: [String] = []

    /// How many asks wait behind the one on the pill (or, with none on it, all of them).
    var waiting: Int { front == nil ? pending.count : pending.count - 1 }

    /// The pending list changed (or was re-read). `typing` = the user is writing in the composer right now (the
    /// typing pill is out with text in it) — a NEW ask then waits aside instead of taking the composer over.
    mutating func update(pending next: [String], typing: Bool) {
        let arrivals = next.filter { !pending.contains($0) }
        pending = next
        setAside.formIntersection(next)
        if typing, front == nil { setAside.formUnion(arrivals) }
        reselect()
    }

    /// The user typed while a card was on the pill: every pending card steps aside.
    mutating func setAllAside() {
        setAside = Set(pending)
        front = nil
    }

    /// The set-aside cards come back: the "waiting for you" pill was clicked, or the composer is empty again.
    mutating func bringBack() {
        setAside = []
        reselect()
    }

    /// Keep the card on the pill while it is pending and not set aside; else the oldest one that is not set aside.
    private mutating func reselect() {
        if let front, pending.contains(front), !setAside.contains(front) { return }
        front = pending.first { !setAside.contains($0) }
    }
}

// MARK: - What the card says (pure — `DispatchPillCardTests`)

/// PURE: the card's header — who is asking, and what: "Dispatch · Bash", "release asks", "GitHub · github.com".
/// `childTitle` is the asking child's title as its pill shows it (nil when the ask is Dispatch's own, or the
/// child is not on the roster — then "A session").
func dispatchPillCardHeader(_ record: InteractionRecord, childTitle: String?) -> String {
    let who = record.childSessionId == nil ? "Dispatch" : (childTitle ?? "A session")
    switch record.ask {
    case .approval(let toolName, _, _, _, _): return "\(who) · \(toolName)"
    case .question: return "\(who) asks"
    case .plan: return "\(who) · plan"
    case .urlElicitation(let serverName, _, let host, _, _): return "\(serverName) · \(host)"
    }
}

/// PURE: the header's trailing words — which question of a multi-question ask, and how many asks wait behind this
/// one. Nil when there is nothing to say.
func dispatchPillCardTrailing(questionIndex: Int, questionCount: Int, waiting: Int) -> String? {
    var parts: [String] = []
    if questionCount > 1 { parts.append("\(questionIndex + 1) of \(questionCount)") }
    if waiting > 0 { parts.append("+\(waiting) waiting") }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
}

/// PURE: what the "waiting for you" pill says for `count` set-aside asks.
func dispatchPillSetAsideLabel(_ count: Int) -> String {
    count == 1 ? "1 waiting for you" : "\(count) waiting for you"
}

/// The blue ✓ of a question card: Next (chevron) before the last question, Send on the last.
enum DispatchPillQuestionAdvance: Equatable {
    case next
    case send
}

/// PURE: what a question card's blue ✓ does on the visible question, and whether it is enabled.
///
/// No click on an option answers the card — the pill's card never did (unlike the island's, a single-choice click
/// does not send): the daemon's question broker is first-response-wins, so a mis-click would be irreversible. A
/// choice is made, then sent with ✓ — which is ENABLED once the visible question has an answer (an option chosen,
/// or Other text that is not blank) and, on the last question, once EVERY question has one
/// (`questionCardComplete`, the very rule `questionAnswers` sends by). Never while a send is in flight. Return in
/// the Other field does exactly what ✓ does.
func dispatchPillQuestionAdvance(
    questions: [SessionEvent.Question],
    draft: PendingCardDraft,
    index: Int,
    inFlight: Bool
) -> (action: DispatchPillQuestionAdvance, enabled: Bool) {
    let isLast = index >= questions.count - 1
    guard !inFlight else { return (isLast ? .send : .next, false) }
    let other = draft.otherTexts[index]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let answeredHere = !other.isEmpty || !(draft.selections[index] ?? []).isEmpty
    if !isLast { return (.next, answeredHere) }
    return (.send, answeredHere && questionCardComplete(questions: questions, selections: draft.selections,
                                                        otherTexts: draft.otherTexts))
}

// MARK: - Wiring

/// The transcript's own card wiring, built the way `WindowContentView` builds it — shared by the pill's card and
/// the full-screen transcript, so "Allow" on the pill is exactly "Approve" in the transcript (same callbacks, same
/// in-flight and error state, same per-card drafts). Every pending ask counts as "closed" here: the full-screen
/// transcript has no composer to morph into a question, so a question card there draws its own form.
@MainActor
func dispatchPillCardWiring(adapter: FieldStateAdapter, records: [InteractionRecord]) -> InteractionCardWiring {
    InteractionCardWiring(
        inFlight: adapter.interactionInFlight,
        closedAsks: Set(records.map(\.callId)),
        errorLines: adapter.interactionErrors,
        draftBinding: { callId in adapter.pendingCardDraftBinding(for: callId) },
        onApproval: adapter.onApprovalRespond,
        onQuestion: adapter.onQuestionRespond,
        onPlan: adapter.onPlanRespond,
        onElicitation: adapter.onElicitationRespond,
        inactiveElicitations: adapter.inactiveElicitations
    )
}
