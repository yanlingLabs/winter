import SwiftUI

/// The dispatch pill itself, as a window's composer (a detached session window —
/// `WindowContentView.pillChrome`): a black capsule with the pill's hairline edge and shadow, white
/// type and caret, and the pill's own trailing circle (`PillSendStopButton`: white, stop while a turn
/// runs, send with text, the voice glyph without). Past one line it grows into the pill's rounded
/// rect (`dispatchPillCornerRadius`), up to `maxFieldHeight`, then scrolls inside.
///
/// While the session works and nothing is typed, the plume fills it (`showsPlume`) — in the
/// session's colours (`pillChromePalette`), throwing the tools and sites the turn uses, its nozzle on
/// the stop circle — exactly like the dispatch pill's working state. The text view stays mounted
/// underneath, invisible, so the first keystroke lands in it, and the plume fades out for the text.
struct PillChromeComposer: View {
    @ObservedObject var adapter: FieldStateAdapter
    @Environment(\.pillChromePalette) private var palette

    static let maxFieldHeight: CGFloat = 160
    /// The gap between the floating composer and the window's bottom edge, which it keeps black.
    static let bottomSkirt: CGFloat = 16
    /// The pill's width in a wide window — the typing pill's own, a little wider for a window.
    static let maxWidth: CGFloat = 640

    @State private var contentHeight: CGFloat = 0

    var body: some View {
        let draft = adapter.composerDraft
        let stopping = adapter.isStopping
        // The plume is the "working" picture; once Stop is pressed it gives way to the words "Stopping…",
        // so the press visibly lands and the window does not look busy while it waits for the turn to end.
        let showsPlume = adapter.turnRunning && draft.isEmpty && !stopping
        let fieldHeight = min(max(contentHeight, 26), Self.maxFieldHeight)
        let shape = RoundedRectangle(
            cornerRadius: dispatchPillCornerRadius(height: fieldHeight + DispatchPillMetrics.composerVerticalPadding),
            style: .continuous)
        HStack(alignment: .bottom, spacing: DispatchPillMetrics.rowSpacing) {
            ZStack(alignment: .topLeading) {
                if stopping && draft.isEmpty {
                    Text(pillStoppingLabel)
                        .font(Typography.composerField())
                        .foregroundStyle(Color.white.opacity(0.7))
                        .lineLimit(1)
                        .padding(.leading, ComposerTextView.textContainerInset.width)
                        .padding(.top, ComposerTextView.textContainerInset.height)
                        .allowsHitTesting(false)
                } else if draft.isEmpty && !showsPlume {
                    Text("Type here")
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
                    viewAlpha: showsPlume ? 0 : 1,
                    imageIntake: adapter.composerImageIntake
                )
            }
            .frame(height: fieldHeight)
            .padding(.vertical, DispatchPillMetrics.fieldBottomInset)
            PillSendStopButton(
                isRunning: adapter.turnRunning,
                canSend: !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                isStopping: stopping,
                onSend: { adapter.onSubmit(adapter.composerDraft) },
                onStop: { adapter.beginStop(); adapter.onInterrupt?() }
            )
            .padding(.bottom, DispatchPillMetrics.sendBottomInset)
        }
        .padding(.leading, DispatchPillMetrics.leadingPadding)
        .padding(.trailing, DispatchPillMetrics.trailingPadding)
        // Its edge is its own surface — a shade above the window's black — never a hairline stroke:
        // a 1 pt stroke on a capsule end rasterises as a stray vertical tick at each end.
        .background {
            ZStack {
                shape.fill(pillChromeSurface)
                if showsPlume {
                    let thrown = plumeThrows(for: adapter.transcript.last)
                    WorkingAnimationView(thrown: thrown, repeating: thrown,
                                         emitterInset: DispatchPillMetrics.trailingPadding + DispatchPillMetrics.sendCircleSize / 2,
                                         palette: palette)
                        .clipShape(shape)
                        .transition(.opacity.animation(.easeOut(duration: 0.25)))
                }
            }
        }
        .shadow(color: .black.opacity(0.6), radius: 14, y: 4)
        // Below the floating composer the transcript would show through the gap to the window's
        // edge (a rule under a message read as a rim) — that strip is the window's black, edge to
        // edge, behind the composer's lower half.
        .background(alignment: .bottom) {
            Color.black
                .frame(width: 4000, height: Self.bottomSkirt + DispatchPillMetrics.pillHeight / 2)
                .offset(y: Self.bottomSkirt)
                .allowsHitTesting(false)
        }
        .frame(maxWidth: Self.maxWidth)
        .animation(.spring(response: 0.3, dampingFraction: 0.85), value: fieldHeight)
    }
}

/// The surface of a pill-themed window's floating pieces (its composer, its header pill): a shade
/// above the window's black, so their edge reads without a stroke.
let pillChromeSurface = Color(white: 0.085)

private struct PillChromePaletteKey: EnvironmentKey {
    static let defaultValue: PlumePalette = .blue
}

extension EnvironmentValues {
    /// The plume colours a pill-themed window's composer streams in — its session's.
    var pillChromePalette: PlumePalette {
        get { self[PillChromePaletteKey.self] }
        set { self[PillChromePaletteKey.self] = newValue }
    }
}
