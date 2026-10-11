import SwiftUI

// MARK: - Which asks float (pure — `DispatchPillViewTests`)

/// PURE: every ask the daemon is still waiting on, oldest first — the live
/// `OrbSessionState.pendingInteractions` list UNIONED with the transcript's still-pending interaction
/// records (exactly what `TranscriptView` draws as live cards).
///
/// Both halves are needed, and the transcript half is the one that matters for dispatch.
/// `pendingInteractions` is emptied wholesale by the dispatch session's own turn end
/// (`SessionReducer.endOutstandingInteractions`), but a mirrored CHILD session's ask outlives the
/// parent's turn — the child is still blocked on it (`interactionEndsWithItsTurn` is false for a
/// `childSessionId` record, so its transcript record stays `outcome == nil` until it is answered).
/// Children normally keep running after Dispatch's turn ends, so an overlay fed from
/// `pendingInteractions` ALONE would drop a child's approval exactly when it matters. The live list
/// is kept as the other half so an ask that has not (yet) produced a transcript record still floats.
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

/// PURE: how many of `records` float, and how many wait behind the "+n more" line.
func floatingCardSplit(_ count: Int, max: Int = DispatchPillMetrics.maxFloatingCards) -> (shown: Int, waiting: Int) {
    let shown = Swift.min(count, Swift.max(0, max))
    return (shown, count - shown)
}

// MARK: - The overlay

/// The asks waiting on the user, floating above the pill stack on black cards — the SAME card the
/// transcript draws (`TranscriptInteractionCard`), wired to the same respond callbacks the
/// transcript's cards fire, so "Approve" here is exactly "Approve" there. Rendered in the dark
/// appearance whatever the system's is: the cards sit on a black ground over arbitrary desktop
/// content, and the light card would read as a hole in it.
///
/// Hidden in full screen — the transcript is on screen there and draws every pending card inline.
struct ApprovalCardOverlay: View {
    @ObservedObject var adapter: FieldStateAdapter
    let width: CGFloat

    var body: some View {
        let records = pendingInteractionRecords(in: adapter.transcript, live: adapter.pendingInteractions,
                                                inactive: adapter.inactiveElicitations)
        let split = floatingCardSplit(records.count)
        if !records.isEmpty {
            VStack(spacing: DispatchPillMetrics.stackGap) {
                ForEach(Array(records.prefix(split.shown)), id: \.callId) { record in
                    TranscriptInteractionCard(record: record, wiring: dispatchPillCardWiring(adapter: adapter, records: records))
                        .padding(4)
                        .background(Color.black, in: RoundedRectangle(cornerRadius: 32, style: .continuous))
                        .shadow(color: .black.opacity(0.35), radius: 14, y: 4)
                }
                if split.waiting > 0 {
                    Text(split.waiting == 1 ? "+1 more waiting" : "+\(split.waiting) more waiting")
                        .font(Typography.caption(.medium))
                        .foregroundStyle(Theme.textPrimary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(Capsule().fill(Color.black))
                }
            }
            .frame(width: width)
            .environment(\.colorScheme, .dark)
        }
    }

}

/// The transcript's own card wiring, built the way `WindowContentView` builds it — shared by the
/// floating overlay and the full-screen transcript. Every pending ask counts as "closed" here: the
/// pill's composer never morphs into a question box, so a question card must draw its own form
/// rather than step aside for one that is not there.
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
