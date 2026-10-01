import SwiftUI

// MARK: - Width splitting (pure — `ChildSessionPillsTests`)

/// How the child row divides its width. One child takes the main pill's whole width, two split it
/// in half, three in thirds, and so on — for as long as every pill stays at least `minPillWidth`
/// wide. Past that, as many pills as fit beside a "+n" circle keep an even share, and the rest
/// collapse into the circle at the trailing end. So the wider typing pill holds more children
/// than the compact one.
struct ChildPillLayout: Equatable {
    /// How many children get a pill of their own.
    let visibleCount: Int
    /// Each visible pill's width.
    let pillWidth: CGFloat
    /// How many children the "+n" circle stands for (0 = no circle).
    let overflowCount: Int
}

func childPillLayout(
    count: Int,
    rowWidth: CGFloat,
    gap: CGFloat = DispatchPillMetrics.childPillGap,
    overflowDiameter: CGFloat = DispatchPillMetrics.childRowHeight,
    minPillWidth: CGFloat = DispatchPillMetrics.minChildPillWidth
) -> ChildPillLayout {
    guard count > 0 else { return ChildPillLayout(visibleCount: 0, pillWidth: 0, overflowCount: 0) }
    // How many pills fit side by side at the minimum width (n pills need n·min + (n-1)·gap).
    let fitting = max(1, Int(((rowWidth + gap) / (minPillWidth + gap)).rounded(.down)))
    if count <= fitting {
        let width = (rowWidth - gap * CGFloat(count - 1)) / CGFloat(count)
        return ChildPillLayout(visibleCount: count, pillWidth: max(0, width), overflowCount: 0)
    }
    // Beside the circle: n pills need n·min + n·gap + the circle.
    let visible = max(1, Int(((rowWidth - overflowDiameter) / (minPillWidth + gap)).rounded(.down)))
    let width = (rowWidth - overflowDiameter - gap * CGFloat(visible)) / CGFloat(visible)
    return ChildPillLayout(visibleCount: visible, pillWidth: max(0, width), overflowCount: count - visible)
}

/// What a child pill draws for its status. Statuses are `child_update`'s own strings
/// (`OrbSessionState.children`): `running`, `awaiting_approval`, `awaiting_input`, `completed`,
/// `error` — anything unrecognised is treated as working, the safe reading for a child that exists.
enum ChildPillStatus: Equatable {
    case working
    case needsYou
    case failed
    case done

    init(wireStatus: String) {
        switch wireStatus {
        case "awaiting_approval", "awaiting_input": self = .needsYou
        case "error": self = .failed
        case "completed": self = .done
        default: self = .working
        }
    }

    /// A child that can still be stopped — the same stop affordance the main pill offers.
    var isStoppable: Bool { self == .working || self == .needsYou }
}

// MARK: - The row

/// The child sessions this dispatch session has spawned, as a row of small pills above the main
/// pill. Click one to open it in a detached window; each running child shows the same working
/// animation and stop button the main pill does. The "+n" circle opens the Dispatch page in the app,
/// where every child is listed.
struct ChildSessionPillsView: View {
    let children: [ChildItem]
    let rowWidth: CGFloat
    let onOpen: (String) -> Void
    let onStop: (String) -> Void
    let onOpenOverflow: () -> Void

    private var layout: ChildPillLayout { childPillLayout(count: children.count, rowWidth: rowWidth) }

    var body: some View {
        HStack(spacing: DispatchPillMetrics.childPillGap) {
            ForEach(Array(children.prefix(layout.visibleCount).enumerated()), id: \.element.id) { index, child in
                ChildSessionPill(child: child, palette: .child(at: index),
                                 onOpen: { onOpen(child.sessionId) },
                                 onStop: { onStop(child.sessionId) })
                    .frame(width: layout.pillWidth, height: DispatchPillMetrics.childRowHeight)
            }
            if layout.overflowCount > 0 {
                Button(action: onOpenOverflow) {
                    Text("+\(layout.overflowCount)")
                        .font(Typography.label(.semibold))
                        .foregroundStyle(Color.white)
                        .frame(width: DispatchPillMetrics.childRowHeight,
                               height: DispatchPillMetrics.childRowHeight)
                        .background(Circle().fill(Color.black))
                        .overlay(Circle().strokeBorder(Color.white.opacity(0.09), lineWidth: 1))
                }
                .buttonStyle(.plain)
                .help("\(layout.overflowCount) more — open Dispatch")
            }
        }
        .frame(width: rowWidth, height: DispatchPillMetrics.childRowHeight)
    }
}

/// One child: its own coloured plume while it works (or a status glyph), its title, and — while it
/// runs — a stop button in its plume's colour, sitting on the nozzle.
private struct ChildSessionPill: View {
    let child: ChildItem
    let palette: PlumePalette
    let onOpen: () -> Void
    let onStop: () -> Void

    private var status: ChildPillStatus { ChildPillStatus(wireStatus: child.status) }

    var body: some View {
        HStack(spacing: 6) {
            statusGlyph
            Text(child.title.isEmpty ? "Session" : child.title)
                .font(Typography.label(.medium))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)
                .shadow(color: .black.opacity(status == .working ? 0.8 : 0), radius: 2)
                .frame(maxWidth: .infinity, alignment: .leading)
            if status.isStoppable {
                Button(action: onStop) {
                    Image(systemName: "stop.fill")
                        .font(Typography.label(.bold))
                        .foregroundStyle(.white)
                        .frame(width: DispatchPillMetrics.sendCircleSize, height: DispatchPillMetrics.sendCircleSize)
                        .background(Circle().fill(palette.bodyColor))
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .help("Stop this session")
            }
        }
        .padding(.leading, 12)
        .padding(.trailing, DispatchPillMetrics.trailingPadding)
        .background {
            ZStack {
                Capsule().fill(Color.black)
                if status == .working {
                    // The main pill's plume in this child's own colours, its nozzle on this pill's
                    // stop button — a little dimmed, so the title over it stays readable.
                    WorkingAnimationView(emitterInset: DispatchPillMetrics.trailingPadding + DispatchPillMetrics.sendCircleSize / 2,
                                         palette: palette)
                        .opacity(0.8)
                        .clipShape(Capsule())
                        .transition(.opacity.animation(.easeOut(duration: 0.25)))
                }
            }
        }
        .overlay(Capsule().strokeBorder(status == .needsYou ? Color.orange : Color.white.opacity(0.09),
                                        lineWidth: 1))
        .contentShape(Capsule())
        .onTapGesture(perform: onOpen)
        .help(child.title)
    }

    @ViewBuilder
    private var statusGlyph: some View {
        switch status {
        case .working:
            // The plume behind the whole pill is this state's mark (`body`); no glyph of its own.
            EmptyView()
        case .needsYou:
            Image(systemName: "hand.raised.fill")
                .font(Typography.caption())
                .foregroundStyle(.orange)
                .frame(width: 20, height: 20)
        case .failed:
            Image(systemName: "exclamationmark.triangle.fill")
                .font(Typography.caption())
                .foregroundStyle(.red)
                .frame(width: 20, height: 20)
        case .done:
            Image(systemName: "checkmark")
                .font(Typography.caption(.semibold))
                .foregroundStyle(.green)
                .frame(width: 20, height: 20)
        }
    }
}
