import SwiftUI
import WinterCUPresentation

// The usage plan lines' hover language (user 2026-10-18), as primitives the island's tabs draw with
// (`docs/claude/island.md`, "Island visual language"):
//
//   - QUIET AT REST: no card behind a row; its data drawn as a SHAPE — a thin line filling with what it measures —
//     never as trailing figures; secondary words muted.
//   - REVEAL ON HOVER, INSIDE THE SHAPE: the line thickens (5 → 14 pt) and lengthens by twice every panel's hover grow
//     (half on each end); the row's label grows 12 % from its leading (or bottom) edge and brightens; the details show
//     INSIDE the line in the light tiny digits, each only where it fits whole.
//   - A UNIT HOVERS AS A WHOLE, and NOTHING JUMPS: the hover is set inside `HoverGrowth.animation` (the Dispatch pill's
//     spring), rows reserve the thick line's height.
//
// The constants are the plan lines' own (`UsagePlanLine`, compact), copied rather than shared while that type is
// being changed elsewhere; `HoverLineTests` pins them equal. The plan lines move onto these primitives later.
//
// This file lives outside `Sources/Island/` on purpose: the island's sources never write a `scaleEffect` of their own
// (`IslandOpenMorphTests` sweeps them) — a row's label lift goes through `hoverLiftLabel`, here.

enum HoverLift {
    /// The line at rest and under the pointer.
    static let restThickness: CGFloat = 5
    static let hoverThickness: CGFloat = 14

    static func thickness(hovered: Bool) -> CGFloat { hovered ? hoverThickness : restThickness }

    /// How much longer a line is under the pointer, half on each end: twice every panel's hover grow (≈19 pt).
    static func lengthGrowth(hovered: Bool) -> CGFloat { hovered ? HoverGrowth.points * 2 : 0 }

    /// A label's grow under the pointer, from its leading (or bottom) edge.
    static func labelScale(hovered: Bool) -> CGFloat { hovered ? 1.12 : 1 }

    /// The spring every lift rides (the Dispatch pill's).
    static var animation: Animation { HoverGrowth.animation }

    /// About how wide words are in the tiny face (≈ 5.4 pt a character at 10 pt) with their 6 pt inset on each side —
    /// the plan lines' own estimate. 0 for nothing.
    static func wordsWidth(_ words: String?) -> CGFloat {
        guard let words, !words.isEmpty else { return 0 }
        return CGFloat(words.count) * 5.4 + 12
    }
}

// MARK: - Reading the hover

private struct HoverLiftPreviewKey: EnvironmentKey {
    static let defaultValue: Set<String> = []
}

extension EnvironmentValues {
    /// Ids drawn hovered whatever the pointer does — ONLY the offscreen gallery sets it (a one-shot render has no
    /// pointer and runs no `onChange`).
    var hoverLiftPreview: Set<String> {
        get { self[HoverLiftPreviewKey.self] }
        set { self[HoverLiftPreviewKey.self] = newValue }
    }
}

/// Whether a unit (a row, a tile, a block) is under the pointer — the island's pointer (its panels are never key) or the
/// window's `onHover` — handed to its content as the state that is SHOWN: set inside `HoverLift.animation`, so whatever
/// the hover changes (a line thickening, words appearing, a unit growing and pushing the ones below) moves on the
/// spring and never jumps.
struct HoverLiftReader<Content: View>: View {
    /// The unit's id, for the gallery's forced hover (`hoverLiftPreview`); nil = never forced.
    var id: String? = nil
    @ViewBuilder let content: (Bool) -> Content
    @Environment(\.hoverLiftPreview) private var preview
    @State private var localHover = false
    @State private var shown = false

    var body: some View {
        if let id, preview.contains(id) {
            content(true)
        } else {
            IslandPointerReader { islandHovered in
                content(shown)
                    .onChange(of: islandHovered || localHover) { _, hovered in
                        withAnimation(HoverLift.animation) { shown = hovered }
                    }
            }
            .onHover { localHover = $0 }
        }
    }
}

extension View {
    /// A label's lift under the pointer: 12 % larger from `anchor`, brightened by the caller.
    func hoverLiftLabel(_ hovered: Bool, anchor: UnitPoint = .leading) -> some View {
        scaleEffect(HoverLift.labelScale(hovered: hovered), anchor: anchor)
    }
}

// MARK: - One line

/// The words a hovered line may show inside itself.
struct HoverLineWords: Equatable {
    /// From the track's start (the row's main fact: "Working · sonnet-4.5").
    var start: String? = nil
    /// Glued to the END of the fill, inside it (the plan lines' used figure: "up 3 h", "armed 4 min ago").
    var atFill: String? = nil
    /// At the track's end, in the grey (the plan lines' left figure: ":3000 :3001", "56 min left").
    var end: String? = nil
    /// The start words are content that must not vanish (a device's detail): too long for the line, they are cut at
    /// their tail instead of dropped (and take the end words' room).
    var startTruncates = false
}

/// PURE: where a hovered line's words go — each shown only where it fits WHOLE, else dropped (start words marked
/// `startTruncates` are cut at their tail instead).
struct HoverLineLayout: Equatable {
    /// The fill as drawn (never under `minFill`: a started line shows at least a dot).
    var fill: CGFloat
    /// Where the glued words' region ends: the fill's end when they sit inside it, past it when they follow it.
    var fillSlot: CGFloat
    var start: Bool
    var atFill: Bool
    /// The glued words fit INSIDE the fill (right-aligned at its end, on the colour); else they follow it in the grey.
    var atFillInside: Bool
    var end: Bool
    /// The room the start words have from the track's start (they are cut to it when they truncate).
    var startRegion: CGFloat = 0

    static func of(width: CGFloat, fraction: Double, words: HoverLineWords, minFill: CGFloat = 0) -> HoverLineLayout {
        let f = CGFloat(min(1, max(0, fraction)))
        let fill = f > 0 ? min(width, max(minFill, width * f)) : 0
        let glued = HoverLift.wordsWidth(words.atFill)
        let startW = HoverLift.wordsWidth(words.start)
        let endW = HoverLift.wordsWidth(words.end)
        if glued > 0 {
            let inside = fill >= glued
            let slot = inside ? fill : fill + glued
            let atFill = slot <= width
            let end = endW > 0 && width - (atFill ? slot : fill) >= endW
            // The start words sit in the fill before the glued ones.
            let region = inside ? fill - glued : 0
            let start = startW > 0 && inside && (region >= startW || (words.startTruncates && region >= 24))
            return HoverLineLayout(fill: fill, fillSlot: slot, start: start, atFill: atFill, atFillInside: inside, end: end,
                                   startRegion: max(0, region))
        }
        // No glued words: the start first, then the end when both fit whole side by side; start words that truncate
        // always show, cut to the track (the end words then dropped).
        let fits = startW > 0 && startW <= width
        let start = fits || (startW > 0 && words.startTruncates)
        let end = endW > 0 && (start ? min(startW, width) : 0) + endW <= width
        return HoverLineLayout(fill: fill, fillSlot: fill, start: start, atFill: false, atFillInside: false, end: end,
                               startRegion: width - (end ? endW : 0))
    }
}

/// A thin line filled to `fraction` (0…1) in `color` over a grey track; under the pointer it thickens, lengthens and
/// shows `words` inside itself in the light tiny digits. The caller reserves `HoverLift.hoverThickness` of height (the
/// line is drawn centred in it), so nothing below moves.
struct HoverLine: View {
    let fraction: Double
    let color: Color
    var hovered = false
    var words = HoverLineWords()
    /// The words' colour over the fill (white) — a light fill (amber) takes black.
    var inkOnFill: Color = .white

    var body: some View {
        let height = HoverLift.thickness(hovered: hovered)
        let f = min(1, max(0, fraction))
        return GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.08))
                Capsule().fill(color)
                    .frame(width: max(f > 0 ? height : 0, proxy.size.width * f))
                if hovered {
                    let layout = HoverLineLayout.of(width: proxy.size.width, fraction: f, words: words, minFill: height)
                    ZStack(alignment: .leading) {
                        if layout.start, let s = words.start {
                            // On the fill, or on the grey of a line with none.
                            Text(s).foregroundStyle(f > 0 ? inkOnFill.opacity(0.9) : Color.white.opacity(0.75))
                                .truncationMode(.tail)
                                .padding(.horizontal, 6)
                                .frame(width: max(0, layout.startRegion), alignment: .leading)
                        }
                        if layout.atFill, layout.atFillInside, let a = words.atFill {
                            Text(a).foregroundStyle(inkOnFill).padding(.trailing, 6)
                                .frame(width: max(0, layout.fill), alignment: .trailing)
                        }
                        if layout.atFill, !layout.atFillInside, let a = words.atFill {
                            // Too long for the fill: right after it, in the grey.
                            Text(a).foregroundStyle(Color.white.opacity(0.85))
                                .padding(.leading, 6)
                                .offset(x: layout.fill)
                        }
                        if layout.end, let e = words.end {
                            Text(e).foregroundStyle(f >= 1 ? inkOnFill.opacity(0.75) : Color.white.opacity(0.6))
                                .padding(.trailing, 6)
                                .frame(maxWidth: .infinity, alignment: .trailing)
                        }
                    }
                    .font(Typography.tinyDigits(.regular))
                    .lineLimit(1)
                    .transition(.opacity)
                }
            }
        }
        .frame(height: height)
        .padding(.horizontal, -HoverLift.lengthGrowth(hovered: hovered) / 2)
        .frame(height: HoverLift.hoverThickness)
    }
}

// MARK: - A line in segments

/// One segment of a `HoverSegmentLine`.
struct HoverSegment: Identifiable, Equatable {
    let id: String
    /// Its share of the whole track, 0…1.
    let fraction: Double
    let color: Color
    /// What it says inside itself under the pointer, the most telling first ("gpt-5 · Codex $18.75", "$18.75"): the first
    /// that fits whole is shown, else none.
    let labels: [String]
    /// The label's colour (black on a light fill such as amber).
    var ink: Color = .white

    init(id: String, fraction: Double, color: Color, label: String?, ink: Color = .white) {
        self.init(id: id, fraction: fraction, color: color, labels: label.map { [$0] } ?? [], ink: ink)
    }

    init(id: String, fraction: Double, color: Color, labels: [String], ink: Color = .white) {
        self.id = id; self.fraction = fraction; self.color = color; self.labels = labels; self.ink = ink
    }
}

/// PURE: segment widths along a track — each its share of `width` less the gaps between them; a segment narrower than
/// its label drops it.
enum HoverSegmentLayout {
    static let gap: CGFloat = 2

    static func widths(_ fractions: [Double], width: CGFloat) -> [CGFloat] {
        let n = fractions.count
        guard n > 0, width > 0 else { return [] }
        let usable = max(0, width - gap * CGFloat(n - 1))
        let total = fractions.reduce(0) { $0 + max(0, $1) }
        guard total > 0 else { return fractions.map { _ in 0 } }
        // The segments fill the share they are of the WHOLE (an unfilled rest stays grey).
        return fractions.map { usable * CGFloat(max(0, $0)) }
    }

    static func showsLabel(_ label: String?, width: CGFloat) -> Bool {
        let w = HoverLift.wordsWidth(label)
        return w > 0 && width >= w
    }

    /// PURE: the first of a segment's labels that fits its width whole; nil when none does.
    static func label(_ labels: [String], width: CGFloat) -> String? {
        labels.first { showsLabel($0, width: width) }
    }
}

/// A thin line split into segments (each a share of the whole), thickening under the pointer with each segment's label
/// inside it where it fits.
struct HoverSegmentLine: View {
    let segments: [HoverSegment]
    var hovered = false

    var body: some View {
        let height = HoverLift.thickness(hovered: hovered)
        return GeometryReader { proxy in
            let widths = HoverSegmentLayout.widths(segments.map(\.fraction), width: proxy.size.width)
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.08))
                HStack(spacing: HoverSegmentLayout.gap) {
                    ForEach(Array(segments.enumerated()), id: \.element.id) { i, segment in
                        let w = i < widths.count ? widths[i] : 0
                        Rectangle().fill(segment.color)
                            .frame(width: w)
                            .overlay {
                                if hovered, let label = HoverSegmentLayout.label(segment.labels, width: w) {
                                    Text(label)
                                        .font(Typography.tinyDigits(.regular))
                                        .foregroundStyle(segment.ink)
                                        .lineLimit(1)
                                        .fixedSize()
                                        .transition(.opacity)
                                }
                            }
                    }
                }
                .clipShape(Capsule())
            }
        }
        .frame(height: height)
        .padding(.horizontal, -HoverLift.lengthGrowth(hovered: hovered) / 2)
        .frame(height: HoverLift.hoverThickness)
    }
}
