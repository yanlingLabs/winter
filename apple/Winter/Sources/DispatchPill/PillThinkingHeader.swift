import SwiftUI

// MARK: - What the pill says (pure — `PillThinkingHeaderTests`)

/// The disc the thinking pill shows — the plume's own white tile with a symbol, as a tool pill's.
let pillThinkingDisc = PlumeThrow(id: "thinking", kind: .tool(symbol: "brain"))

/// PURE: the thinking pill's sentence (user, 2026-10-05, ChatGPT-like): the block's title when it has
/// one — the provider's own `**heading**` or a progress update — else "Thinking" while it streams and
/// "Thought" once it is done (the tool pills' running → done wording). One line; the view truncates.
func pillThinkingLabel(_ item: ThinkingItem, turnIsLive: Bool) -> String {
    item.label(turnIsLive: turnIsLive)
}

// MARK: - The pill

/// One reasoning block in the dispatch pill's own material, beside the tool pills in the pill-themed
/// session window: EXACTLY `PillToolRunHeader`'s capsule — the same height, padding, fill and stroke,
/// the same white disc, the same label font and the same `BandShimmer` while it runs. Not a button
/// and no chevron: the summary's body view is styled later (the item keeps the text for it).
struct PillThinkingHeader: View {
    let item: ThinkingItem
    let turnIsLive: Bool

    /// A long title (an update can run to a sentence or two) is cut with "…" here, so one pill never
    /// outgrows the flow's line.
    static let maxLabelWidth: CGFloat = 360

    var body: some View {
        let running = item.isRunning(turnIsLive: turnIsLive)
        HStack(spacing: 10) {
            PillToolDisc(disc: pillThinkingDisc, size: PillToolRunHeader.discSize, tick: 0)
            Text(pillThinkingLabel(item, turnIsLive: turnIsLive))
                .font(Typography.label(.medium))
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: Self.maxLabelWidth, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .modifier(BandShimmer(active: running, rest: 0.5, inactive: 0.9, minBand: 60, bandShare: 0.6))
                .animation(.easeInOut(duration: 0.18), value: pillThinkingLabel(item, turnIsLive: turnIsLive))
        }
        .padding(.leading, 6)
        .padding(.trailing, 14)
        .frame(height: PillToolRunHeader.height)
        .background(Capsule().fill(Color.white.opacity(0.06)))
        .overlay(Capsule().strokeBorder(running ? Color.white.opacity(0.55) : Color.white.opacity(0.08), lineWidth: 1))
        .clipShape(Capsule())
        .animation(.easeInOut(duration: 0.3), value: running)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(pillThinkingLabel(item, turnIsLive: turnIsLive))
    }
}
