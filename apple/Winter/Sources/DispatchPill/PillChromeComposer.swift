import SwiftUI

/// The dispatch pill's composer, for a window that wears the pill's theme (a detached session
/// window — `WindowContentView.pillChrome`): a dark rounded field with a hairline edge, white type
/// and caret, and the pill's own trailing circle (`PillSendStopButton`: white, stop while a turn
/// runs, send with text, the voice glyph without). It grows with the text up to `maxFieldHeight`,
/// then scrolls inside.
struct PillChromeComposer: View {
    @ObservedObject var adapter: FieldStateAdapter

    static let maxFieldHeight: CGFloat = 160
    static let cornerRadius: CGFloat = DispatchPillMetrics.maxCornerRadius

    @State private var contentHeight: CGFloat = 0

    var body: some View {
        let draft = adapter.composerDraft
        let shape = RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous)
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
            .frame(height: min(max(contentHeight, 26), Self.maxFieldHeight))
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
        .background(shape.fill(Color.white.opacity(0.06)))
        .overlay(shape.strokeBorder(Color.white.opacity(0.12), lineWidth: 1))
    }
}
