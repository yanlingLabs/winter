import SwiftUI

/// The dispatch pill itself, as a window's composer (a detached session window —
/// `WindowContentView.pillChrome`): a black capsule with the pill's hairline edge and shadow, white
/// type and caret, and the pill's own trailing circle (`PillSendStopButton`: white, stop while a turn
/// runs, send with text, the voice glyph without). Past one line it grows into the pill's rounded
/// rect (`dispatchPillCornerRadius`), up to `maxFieldHeight`, then scrolls inside.
struct PillChromeComposer: View {
    @ObservedObject var adapter: FieldStateAdapter

    static let maxFieldHeight: CGFloat = 160
    /// The pill's width in a wide window — the typing pill's own, a little wider for a window.
    static let maxWidth: CGFloat = 640

    @State private var contentHeight: CGFloat = 0

    var body: some View {
        let draft = adapter.composerDraft
        let fieldHeight = min(max(contentHeight, 26), Self.maxFieldHeight)
        let shape = RoundedRectangle(
            cornerRadius: dispatchPillCornerRadius(height: fieldHeight + DispatchPillMetrics.composerVerticalPadding),
            style: .continuous)
        HStack(alignment: .bottom, spacing: DispatchPillMetrics.rowSpacing) {
            ZStack(alignment: .topLeading) {
                if draft.isEmpty {
                    Text(adapter.turnRunning ? adapter.verbText : "Type here")
                        .font(Typography.composerField())
                        .foregroundStyle(Color.white.opacity(0.45))
                        .lineLimit(1)
                        .padding(.leading, ComposerTextView.textContainerInset.width)
                        .padding(.top, ComposerTextView.textContainerInset.height)
                        .allowsHitTesting(false)
                }
                ComposerTextView(
                    text: adapter.draftBinding,
                    onSubmit: { adapter.onSubmit(adapter.composerDraft) },
                    onContentHeightChange: { contentHeight = $0 },
                    usesAdaptiveColors: true,
                    tintOverride: .white,
                    imageIntake: adapter.composerImageIntake
                )
            }
            .frame(height: fieldHeight)
            .padding(.vertical, DispatchPillMetrics.fieldBottomInset)
            PillSendStopButton(
                isRunning: adapter.turnRunning,
                canSend: !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                onSend: { adapter.onSubmit(adapter.composerDraft) },
                onStop: { adapter.onInterrupt?() }
            )
            .padding(.bottom, DispatchPillMetrics.sendBottomInset)
        }
        .padding(.leading, DispatchPillMetrics.leadingPadding)
        .padding(.trailing, DispatchPillMetrics.trailingPadding)
        // Its edge is its own surface — a shade above the window's black — never a hairline stroke:
        // a 1 pt stroke on a capsule end rasterises as a stray vertical tick at each end.
        .background(shape.fill(pillChromeSurface))
        .shadow(color: .black.opacity(0.6), radius: 14, y: 4)
        .frame(maxWidth: Self.maxWidth)
        .animation(.spring(response: 0.3, dampingFraction: 0.85), value: fieldHeight)
    }
}

/// The surface of a pill-themed window's floating pieces (its composer, its header pill): a shade
/// above the window's black, so their edge reads without a stroke.
let pillChromeSurface = Color(white: 0.085)
