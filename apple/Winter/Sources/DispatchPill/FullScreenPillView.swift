import SwiftUI

/// ↗ — the pill grown to the screen: a header (working status, the child sessions, a small close
/// button), the dispatch session's transcript (`TranscriptView`, the same one the app's windows
/// draw — pending asks render there inline as live cards, which is why the floating overlay hides
/// here) — and NO composer: full screen is for reading. A draft typed before ↗ waits in the adapter
/// and is back in the typing pill when this closes. The 4-finger tap or Esc collapses it back to the
/// pill; so does the close button.
struct FullScreenPillView: View {
    @ObservedObject var controller: DispatchPillController
    @ObservedObject var adapter: FieldStateAdapter

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
                TranscriptView(adapter: adapter, tint: .blue,
                               cardWiring: dispatchPillCardWiring(adapter: adapter, records: records))
                    .padding(.horizontal, 16)
                    .padding(.bottom, 12)
            }
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text("Dispatch")
                .font(Typography.control(.semibold))
                .foregroundStyle(Theme.textPrimary)
            if adapter.turnRunning {
                WorkingAnimationView(thrown: controller.plumeThrows, repeating: controller.plumeRepeatingThrows)
                    .frame(width: 110, height: 22)
                    .clipShape(Capsule())
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
                                  CGFloat(min(adapter.dispatchChildren.count, 4))
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
}
