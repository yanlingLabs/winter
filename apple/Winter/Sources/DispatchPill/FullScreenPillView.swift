import SwiftUI

/// ↗ — the pill grown to the screen: a header (working status, the child sessions, a small close
/// button), the dispatch session's transcript (`TranscriptView`, the same one the app's windows
/// draw — pending asks render there inline as live cards, which is why the floating overlay hides
/// here), and a composer. The 4-finger tap or Esc collapses it back to the pill; so does the close
/// button.
struct FullScreenPillView: View {
    @ObservedObject var controller: DispatchPillController
    @ObservedObject var adapter: FieldStateAdapter

    /// The full-screen composer's tallest, before it scrolls internally.
    static let maxComposerHeight: CGFloat = 160
    static let headerHeight: CGFloat = 48
    /// One child pill's share of the header row.
    static let headerChildPillWidth: CGFloat = 150

    var body: some View {
        let records = pendingInteractionRecords(in: adapter.transcript, live: adapter.pendingInteractions,
                                                inactive: adapter.inactiveElicitations)
        VStack(spacing: 0) {
            header
            Rectangle().fill(Theme.hairlineElevated).frame(height: 1)
            if adapter.transcript.isEmpty {
                Text("Nothing sent to Dispatch yet.")
                    .font(Typography.label())
                    .foregroundStyle(Theme.textMuted)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                TranscriptView(adapter: adapter, tint: Theme.accent,
                               cardWiring: dispatchPillCardWiring(adapter: adapter, records: records))
                    .padding(.horizontal, 16)
            }
            composer
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text("Dispatch")
                .font(Typography.control(.semibold))
                .foregroundStyle(Theme.textPrimary)
            if adapter.turnRunning {
                WorkingAnimationView(toolName: controller.runningToolName, diameter: 20,
                                     iconFont: Typography.micro(.semibold))
                Text(adapter.verbText)
                    .font(Typography.caption())
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 12)
            if !adapter.dispatchChildren.isEmpty {
                // In the header the row sizes to its children (a full-width pill for ONE child reads
                // as a progress bar here); above the compact/typing pill it spans the pill instead.
                ChildSessionPillsView(
                    children: adapter.dispatchChildren,
                    rowWidth: min(DispatchPillMetrics.expandedWidth,
                                  CGFloat(min(adapter.dispatchChildren.count, DispatchPillMetrics.maxChildPills))
                                      * Self.headerChildPillWidth),
                    onOpen: { controller.onOpenChild?($0) },
                    onStop: { controller.onStopChild?($0) },
                    onOpenOverflow: { controller.onOpenInApp?() }
                )
            }
            Button { controller.closeFullScreen() } label: {
                Image(systemName: "xmark")
                    .font(Typography.caption(.bold))
                    .foregroundStyle(Theme.textSecondary)
                    .frame(width: 22, height: 22)
                    .background(Circle().fill(Theme.controlSurface))
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .help("Close full screen")
        }
        .padding(.horizontal, 16)
        .frame(height: Self.headerHeight)
    }

    private var composer: some View {
        let draft = adapter.composerDraft
        let fieldHeight = min(max(controller.composerContentHeight, 26), Self.maxComposerHeight)
        return HStack(alignment: .bottom, spacing: DispatchPillMetrics.rowSpacing) {
            ZStack(alignment: .topLeading) {
                if draft.isEmpty {
                    Text(adapter.turnRunning ? adapter.verbText : "Type here")
                        .font(Typography.composerField())
                        .foregroundStyle(Theme.textPlaceholder)
                        .lineLimit(1)
                        .padding(.leading, ComposerTextView.textContainerInset.width)
                        .padding(.top, ComposerTextView.textContainerInset.height)
                        .allowsHitTesting(false)
                }
                ComposerTextView(
                    text: adapter.draftBinding,
                    onSubmit: { controller.submit(adapter.composerDraft) },
                    onContentHeightChange: { controller.composerContentHeightChanged($0) },
                    usesAdaptiveColors: true
                )
            }
            .frame(height: fieldHeight)
            .padding(.vertical, 9)
            PillSendStopButton(
                isRunning: adapter.turnRunning,
                canSend: !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                onSend: { controller.submit(adapter.composerDraft) },
                onStop: { controller.interrupt() }
            )
            .padding(.bottom, 6)
        }
        .padding(.leading, DispatchPillMetrics.leadingPadding)
        .padding(.trailing, DispatchPillMetrics.trailingPadding)
        .background(
            RoundedRectangle(cornerRadius: DispatchPillMetrics.maxCornerRadius, style: .continuous)
                .fill(Theme.controlSurface)
        )
        .frame(maxWidth: newChatCardWidth)
        .padding(.horizontal, 16)
        .padding(.bottom, 14)
        .padding(.top, 8)
    }
}
