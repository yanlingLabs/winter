import SwiftUI
import WinterKit

// Plan alarms, the app half (`docs/claude/usage.md`, user 2026-10-18): on a plan line under the pointer a thin white
// marker follows the pointer with the used share that spot stands for; a click there sets a one-shot alarm (whole
// percent) on that window, a click on an alarm's tick removes it, and a click at or below what is already used sets
// nothing and says "Already past". The daemon fires each alarm once and raises the island's notification. Everything
// here is PURE (`UsageWindowTests`); the line draws it (`UsagePlanLine`).

/// What a line can do with its alarms — nil where it cannot (the offscreen gallery, a daemon with no alarms).
struct UsageAlarmActions {
    let set: (_ provider: String, _ windowKey: String, _ thresholdPercent: Int) -> Void
    let remove: (_ id: String) -> Void
}

enum UsageAlarmRules {
    /// How near a click must land to an alarm's tick to remove it (points along the track).
    static let tickTolerance: CGFloat = 4
    /// How long "Already past" shows.
    static let pastFlashSeconds: Double = 1.4

    /// PURE: the track under a point of the line's row — `slot` is the track's RESTING frame in the row (the space the
    /// HStack gives it); under the pointer it reaches out by half the line's length growth at each end
    /// (`UsagePlanLine.lengthGrowth`). Answers the point's x along the track and the track's width, nil off the track.
    static func trackPoint(rowX: CGFloat, slot: CGRect, hovered: Bool) -> (x: CGFloat, width: CGFloat)? {
        let grow = UsagePlanLine.lengthGrowth(hovered: hovered)
        let minX = slot.minX - grow / 2
        let width = slot.width + grow
        guard width > 0, rowX >= minX, rowX <= minX + width else { return nil }
        return (rowX - minX, width)
    }

    /// PURE: the used share a spot on the track stands for, as a whole percent 1…100 (the ends included: the first
    /// point is 1 %, the last 100 %).
    static func percent(x: CGFloat, width: CGFloat) -> Int {
        guard width > 0 else { return 1 }
        return min(100, max(1, Int((Double(x / width) * 100).rounded())))
    }

    /// PURE: where an alarm's tick sits on a track `width` wide.
    static func tickX(_ thresholdPercent: Int, width: CGFloat) -> CGFloat {
        width * CGFloat(min(100, max(0, thresholdPercent))) / 100
    }

    /// PURE: the alarm whose tick a click at `x` lands on — the nearest within `tickTolerance`, or nil.
    static func tickHit(x: CGFloat, width: CGFloat, alarms: [UsageAlarm]) -> UsageAlarm? {
        alarms
            .map { (alarm: $0, distance: abs(tickX($0.thresholdPercent, width: width) - x)) }
            .filter { $0.distance <= tickTolerance }
            .min { $0.distance < $1.distance }?.alarm
    }

    /// PURE: a threshold at or below what is already used would never fire as news — "Already past".
    static func isAlreadyPast(thresholdPercent: Int, usedPercent: Double) -> Bool {
        Double(thresholdPercent) <= usedPercent
    }

    enum TapOutcome: Equatable {
        case remove(String)
        case set(Int)
        case alreadyPast
    }

    /// PURE: what a click at `x` on the track does: on a tick, remove that alarm; else, at or below the used share,
    /// nothing ("Already past"); else set an alarm at that whole percent (one already there is the daemon's to keep once).
    /// A STALE line's share is no longer what is used (its window reset, or it is older than its window): no "Already
    /// past" there — the alarm is set, and the next fresh reading judges it.
    static func tap(x: CGFloat, width: CGFloat, usedPercent: Double, stale: Bool = false, alarms: [UsageAlarm]) -> TapOutcome {
        if let hit = tickHit(x: x, width: width, alarms: alarms) { return .remove(hit.id) }
        let pct = percent(x: x, width: width)
        return !stale && isAlreadyPast(thresholdPercent: pct, usedPercent: usedPercent) ? .alreadyPast : .set(pct)
    }

    /// Where the marker's label goes and which of the line's own words it hides.
    struct MarkerLayout: Equatable {
        /// Right of the marker (else left, when the right runs off the track).
        let labelOnRight: Bool
        let hidesUsed: Bool
        let hidesLeft: Bool
        let hidesReset: Bool
    }

    /// About how wide the marker's label is ("100%" in the tiny digits).
    static func markerLabelWidth(compact: Bool) -> CGFloat { UsagePlanLine.figureSlot(compact: compact) - 6 }

    /// PURE: the marker at `x` on a hovered track `width` wide — its label right of it when that fits, else left — and
    /// which of the line's words (`UsagePlanLine.figureLayout`) sit under the marker or its label and so step aside.
    static func markerLayout(x: CGFloat, width: CGFloat, fraction: Double, compact: Bool, resetWidth: CGFloat) -> MarkerLayout {
        let figures = UsagePlanLine.figureLayout(width: width, fraction: fraction, compact: compact, resetWidth: resetWidth)
        let label = markerLabelWidth(compact: compact)
        let right = x + 4 + label <= width
        let span: ClosedRange<CGFloat> = right ? (x - 1)...(x + 4 + label) : (x - 4 - label)...(x + 1)
        let slot = UsagePlanLine.figureSlot(compact: compact)
        let used: ClosedRange<CGFloat> = max(0, figures.usedSlot - slot)...figures.usedSlot
        let left: ClosedRange<CGFloat> = max(0, width - slot)...width
        let reset: ClosedRange<CGFloat>? = switch figures.reset {
        case .grey: max(0, width - slot - resetWidth)...max(0, width - slot)
        case .fill: 0...min(width, resetWidth)
        case .none: nil
        }
        return MarkerLayout(labelOnRight: right, hidesUsed: span.overlaps(used), hidesLeft: figures.showsLeft && span.overlaps(left),
                            hidesReset: reset.map { span.overlaps($0) } ?? false)
    }
}

/// An alarm's tick on its track: a short white stroke, subtle at rest, clearer under the pointer.
struct UsageAlarmTick: View {
    let x: CGFloat
    let height: CGFloat
    let hovered: Bool

    var body: some View {
        Capsule()
            .fill(Color.white.opacity(hovered ? 0.9 : 0.45))
            .frame(width: 2, height: hovered ? height : height + 4)
            .shadow(color: .black.opacity(0.5), radius: 0.5)
            .offset(x: x - 1)
            .allowsHitTesting(false)
    }
}

/// The marker under the pointer: a thin white line through the track and, beside it, the used share that spot stands
/// for (or "Already past" for a moment) — white with a dark halo, legible over the fill and the grey alike.
struct UsageAlarmMarker: View {
    let x: CGFloat
    let height: CGFloat
    let text: String
    let onRight: Bool

    var body: some View {
        ZStack(alignment: .leading) {
            Rectangle()
                .fill(Color.white)
                .frame(width: 1.5, height: height + 4)
                .shadow(color: .black.opacity(0.6), radius: 1)
                .offset(x: x - 0.75)
            label
        }
        .allowsHitTesting(false)
    }

    @ViewBuilder private var label: some View {
        let text = Text(text)
            .font(Typography.tinyDigits(.semibold))
            .foregroundStyle(Color.white)
            .shadow(color: .black.opacity(0.75), radius: 1.5)
            .lineLimit(1)
            .fixedSize()
        if onRight {
            text.padding(.leading, x + 4)
        } else {
            text.frame(width: max(0, x - 4), alignment: .trailing)
        }
    }
}
