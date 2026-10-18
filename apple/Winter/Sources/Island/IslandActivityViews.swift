import SwiftUI
import WinterCUPresentation
import WinterKit

// The Winter island's activity views (phase 2, `docs/claude/island.md`): the computer-use pill and its mirror, the
// turn-result card, and the Watches tab. Same look as phase 1: black shells, the house type (`Typography` only —
// `TypographyTests` sweeps this folder), white ✕ / blue ✓ circles with the pills' hover glow, the island's hover grow
// (`IslandHover`).

enum IslandCUColors {
    /// Winter's blue (the island's ✓): the computer-use pill's mark.
    static let accent = IslandCircleButtonStyle.blue
}

enum IslandActivityLayout {
    /// The computer-use pill's width.
    static let cuPillWidth: CGFloat = 340
    /// The mirror in the island: its outer size and corner.
    static let mirrorSize = CGSize(width: 380, height: 300)
    static let mirrorCorner: CGFloat = 24
    /// Room kept around a resting slot for its shadow and hover grow (the panel is cut to it).
    static let shadowRoom: CGFloat = 22
}

/// The text cross-fade the Dispatch pill's rows use: the old words blur out as the new ones sharpen in.
private struct IslandBlurFade: ViewModifier {
    let progress: Double
    func body(content: Content) -> some View {
        content.opacity(progress).blur(radius: (1 - progress) * 6)
    }
}

extension AnyTransition {
    static var islandBlurFade: AnyTransition {
        .modifier(active: IslandBlurFade(progress: 0), identity: IslandBlurFade(progress: 1))
    }
}

/// A line that cross-fades (with the morph blur) whenever its words change. Animates only on a change.
struct IslandCrossfadeText: View {
    let text: String
    var font: Font = Typography.composerField()
    var color: Color = .white

    var body: some View {
        ZStack(alignment: .leading) {
            Text(text)
                .font(font)
                .foregroundStyle(color)
                .lineLimit(1)
                .truncationMode(.middle)
                .id(text)
                .transition(.islandBlurFade)
        }
        .animation(.easeInOut(duration: 0.3), value: text)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A small round button in the shells' headers (detach, collapse): white on a faint disc, glowing under the pointer.
struct IslandSmallCircleButton: View {
    let symbol: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(Typography.caption(.bold))
                .foregroundStyle(Color.white)
                .frame(width: 24, height: 24)
                .background(Circle().fill(Color.white.opacity(0.14)))
                .contentShape(Circle())
                .pillHoverGlow(Color.white)
        }
        .buttonStyle(IslandPressStyle())
    }
}

// MARK: - The computer-use pill

/// The pill's row: the computer-use mark, what is being done now (cross-fading), and how many sessions are at it.
struct IslandCUPillContent: View {
    let presentation: IslandCUPresentation

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "cursorarrow.motionlines")
                .font(Typography.label(.semibold))
                .foregroundStyle(IslandCUColors.accent)
            IslandCrossfadeText(text: presentation.line)
            if let count = presentation.countLabel {
                Text(count)
                    .font(Typography.captionDigits(.semibold))
                    .foregroundStyle(Color.black)
                    .padding(.horizontal, 6)
                    .frame(height: 16)
                    .background(Capsule().fill(Color.white))
                    .accessibilityHidden(true)
            }
        }
        .padding(.leading, 18)
        .padding(.trailing, 14)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .opacity(presentation.lingering ? 0.7 : 1)
        .animation(.easeInOut(duration: 0.3), value: presentation.lingering)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(presentation.accessibilityLabel)
        .accessibilityAddTraits(.isButton)
    }
}

/// The pill opened into its mirror: the line on top (still live), detach and collapse, and the live view of the window
/// the agent works in.
struct IslandMirrorContent: View {
    let presentation: IslandCUPresentation
    let model: CUMirrorModel?
    var placeholder: Image?
    let onDetach: () -> Void
    let onCollapse: () -> Void

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "cursorarrow.motionlines")
                    .font(Typography.label(.semibold))
                    .foregroundStyle(IslandCUColors.accent)
                IslandCrossfadeText(text: presentation.line, font: Typography.label(.medium))
                IslandSmallCircleButton(symbol: "rectangle.portrait.on.rectangle.portrait", action: onDetach)
                    .accessibilityLabel("Detach the live view")
                    .help("Detach")
                IslandSmallCircleButton(symbol: "chevron.up", action: onCollapse)
                    .accessibilityLabel("Close the live view")
                    .help("Close")
            }
            IslandMirrorPicture(model: model, placeholder: placeholder)
            if let title = presentation.title, !title.isEmpty {
                Text(title)
                    .font(Typography.caption(.medium))
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .padding(IslandMirrorPicture.inset)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The computer-use slot at rest: the black shell morphing between the pill and the mirror on a spring, the content
/// cross-fading with the morph blur. (Born and retreating, it is drawn by the liquid instead — `IslandActivityRoot`.)
struct IslandMorphShell<Content: View>: View {
    let size: CGSize
    let cornerRadius: CGFloat?
    let hovered: Bool
    let content: Content

    init(size: CGSize, cornerRadius: CGFloat?, hovered: Bool, @ViewBuilder content: () -> Content) {
        self.size = size
        self.cornerRadius = cornerRadius
        self.hovered = hovered
        self.content = content()
    }

    var body: some View {
        let shape = CUIslandShellShape(cornerRadius: cornerRadius)
        content
            .frame(width: size.width, height: size.height)
            .islandPanelSpace()
            .clipShape(shape)
            .background(shape.fill(Color.black))
            .overlay(shape.strokeBorder(Color.white.opacity(0.09), lineWidth: 1))
            .compositingGroup()
            .shadow(color: .black.opacity(0.45), radius: 14, y: 4)
            .islandHoverGrow(hovered, size: size)
    }
}

// MARK: - The turn-result card

/// A turn that ended while you were elsewhere: the session, what it said last (two lines), ✕ and Open.
struct IslandResultContent: View {
    let item: IslandResultItem
    let onOpen: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "checkmark.circle.fill")
                    .font(Typography.caption(.semibold))
                    .foregroundStyle(IslandCUColors.accent)
                Text(islandResultTitle(item))
                    .font(Typography.caption(.medium))
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 4)
            }
            HStack(alignment: .bottom, spacing: 8) {
                Text(item.summary)
                    .font(Typography.composerField())
                    .foregroundStyle(Color.white)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                IslandAnswerButton(role: .refuse, action: onDismiss)
                    .accessibilityLabel("Dismiss")
                IslandAnswerButton(role: .accept, symbol: "arrow.up.right", action: onOpen)
                    .accessibilityLabel("Open \(islandResultTitle(item))")
            }
        }
        .padding(IslandLayout.cardPadding)
        .frame(width: IslandLayout.cardWidth, alignment: .topLeading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(islandResultTitle(item)) finished: \(item.summary)")
    }
}

// MARK: - A plan alarm's notification

/// A plan alarm fired (`docs/claude/usage.md`): the plan, the window and the threshold ("Claude Code · Weekly at 80%"),
/// when it resets, ✕ and ↗ — a click anywhere on it opens the island's Usage tab.
struct IslandUsageAlarmContent: View {
    let item: IslandUsageAlarmItem
    let now: Date
    let onOpen: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        let title = UsagePresentation.alarmNoticeTitle(item)
        let detail = UsagePresentation.alarmNoticeDetail(item, now: now)
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "bell.fill")
                    .font(Typography.caption(.semibold))
                    .foregroundStyle(UsagePlanColor.of(provider: item.provider))
                Text("Usage alarm")
                    .font(Typography.caption(.medium))
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(1)
                Spacer(minLength: 4)
            }
            HStack(alignment: .bottom, spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(Typography.composerField())
                        .foregroundStyle(Color.white)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    if let detail {
                        Text(detail).font(Typography.caption()).foregroundStyle(Theme.textMuted).lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                IslandAnswerButton(role: .refuse, action: onDismiss)
                    .accessibilityLabel("Dismiss")
                IslandAnswerButton(role: .accept, symbol: "arrow.up.right", action: onOpen)
                    .accessibilityLabel("Open usage")
            }
        }
        .padding(IslandLayout.cardPadding)
        .frame(width: IslandLayout.cardWidth, alignment: .topLeading)
        .contentShape(Rectangle())
        .onTapGesture(perform: onOpen)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Usage alarm: \(title)\(detail.map { ", \($0)" } ?? "")")
    }
}

// MARK: - The Watches tab

/// Every armed computer-use watch — what the agent waits for, in which session and app, since when — each with Stop.
struct IslandWatchesList: View {
    @ObservedObject var activity: IslandActivityStore
    var scrolls = true
    /// Epoch ms (the gallery passes a fixed one).
    var nowMs: () -> Int = { Int(Date().timeIntervalSince1970 * 1000) }

    var body: some View {
        if activity.watches.isEmpty {
            IslandEmptyTab(symbol: "eye", line: "Nothing is being watched")
        } else {
            IslandTabScroll(scrolls: scrolls) { rows }
        }
    }

    private var rows: some View {
        let now = nowMs()
        return VStack(alignment: .leading, spacing: IslandLayout.rowGap) {
            ForEach(activity.watches, id: \.wakeId) { watch in
                IslandWatchRow(watch: watch, nowMs: now, stopping: activity.disarming.contains(watch.wakeId),
                               error: activity.disarmErrors[watch.wakeId]) { activity.disarmWatch(watch) }
            }
        }
        .padding(.horizontal, IslandLayout.listInset)
        .padding(.bottom, IslandLayout.listInset)
    }
}

struct IslandWatchRow: View {
    let watch: IslandWatchItem
    let nowMs: Int
    let stopping: Bool
    let error: String?
    let onStop: () -> Void

    var body: some View {
        IslandHoverSurface { _ in row }
    }

    private var row: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: islandWatchSymbol(watch.condition))
                .font(Typography.label(.semibold))
                .foregroundStyle(IslandCUColors.accent)
                .frame(width: 30, height: 30)
                .background(Circle().fill(Color.white.opacity(0.08)))
            VStack(alignment: .leading, spacing: 3) {
                Text(islandWatchConditionLine(watch))
                    .font(Typography.composerField())
                    .foregroundStyle(Color.white)
                    .lineLimit(2)
                Text("\(islandWatchSessionLine(watch)) · \(watch.targetLabel)")
                    .font(Typography.caption(.medium))
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(error ?? islandWatchTimeLine(watch, nowMs: nowMs))
                    .font(Typography.captionDigits())
                    .foregroundStyle(error == nil ? Theme.textMuted : pillReviewAmber)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            IslandAnswerButton(role: .refuse, symbol: "stop.fill", enabled: !stopping, action: onStop)
                .accessibilityLabel("Stop waiting")
        }
        .padding(12)
    }
}
