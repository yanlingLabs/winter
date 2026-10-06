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
/// the same white disc, the same label font and the same `BandShimmer` while it runs.
///
/// A block with readable text carries a chevron (2026-10-06); clicking it morphs the capsule into a
/// rounded rectangle (`PillMorphChrome`) holding the same row and, below it, the reasoning itself
/// (`PillThinkingText`) — streaming while the block does. A hidden block has no text, so no chevron.
struct PillThinkingHeader: View {
    let item: ThinkingItem
    let turnIsLive: Bool
    var isExpanded: Bool = false
    /// What the opened pill shows (`thinkingDisplayText`) — passed only while it is open, so a closed
    /// pill never holds on to a streaming block's text.
    var text: String? = nil
    var toggle: () -> Void = {}

    /// A long title (an update can run to a sentence or two) is cut with "…" here, so one pill never
    /// outgrows the flow's line.
    static let maxLabelWidth: CGFloat = 360

    var body: some View {
        let running = item.isRunning(turnIsLive: turnIsLive)
        let label = pillThinkingLabel(item, turnIsLive: turnIsLive)
        let expandable = thinkingHasReadableText(item)
        let open = isExpanded && expandable && text != nil
        VStack(alignment: .leading, spacing: 0) {
            Button(action: toggle) {
                HStack(spacing: 10) {
                    PillToolDisc(disc: pillThinkingDisc, size: PillToolRunHeader.discSize, tick: 0)
                    Text(label)
                        .font(Typography.label(.medium))
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: open ? nil : Self.maxLabelWidth, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .modifier(BandShimmer(active: running, rest: 0.5, inactive: 0.9, minBand: 60, bandShare: 0.6))
                        .animation(.easeInOut(duration: 0.18), value: label)
                    if expandable {
                        PillChevron(isExpanded: open, label: open ? "Hide thinking" : "Show thinking")
                    }
                }
                .padding(.leading, 6)
                .padding(.trailing, 14)
                .frame(height: PillToolRunHeader.height)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .allowsHitTesting(expandable)
            .accessibilityElement(children: .combine)
            // With nothing to open it is a label, not a button.
            .accessibilityRemoveTraits(expandable ? [] : .isButton)
            if open, let text {
                PillThinkingText(text: thinkingBodyText(text, title: item.title), isLive: item.isLive,
                                 truncated: item.truncated)
                    .padding(.horizontal, 16)
                    .padding(.top, 2)
                    .padding(.bottom, 14)
                    .transition(.opacity)
            }
        }
        .fixedSize(horizontal: !open, vertical: true)
        .frame(maxWidth: open ? .infinity : nil, alignment: .leading)
        .modifier(PillMorphChrome(expanded: open, rim: running ? PillMorphChrome.liveRim : PillMorphChrome.restRim))
        .animation(.easeInOut(duration: 0.3), value: running)
    }
}
