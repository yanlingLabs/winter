import SwiftUI
import WinterCUPresentation

// The usage plan lines' hover language (user 2026-10-18), as the primitives the island's tabs share
// (`docs/claude/island.md`, "Island visual language" — user 2026-10-19: shared language, own shapes):
//
//   - A UNIT LIFTS UNDER THE POINTER: its title grows 12 % from its leading (or bottom) edge and what it holds back at
//     rest appears; the hover is set inside `HoverGrowth.animation` (the Dispatch pill's spring), so a unit that grows
//     moves what is below it smoothly — nothing jumps.
//   - A LINE ONLY FOR A REAL AMOUNT: the one drawn here is the cost split by model (`HoverSegmentLine`), at the plan
//     lines' weight — thin at rest, thicker and lengthened under the pointer with its words inside.
//
// The measures are the plan lines' own (`UsagePlanLine`, compact), copied rather than shared while that type is
// changed elsewhere; `HoverLineTests` pins them equal.
//
// This file lives outside `Sources/Island/` on purpose: the island's sources never write a `scaleEffect` of their own
// (`IslandOpenMorphTests` sweeps them) — a title's lift goes through `hoverLiftLabel`, here.

enum HoverLift {
    /// A line at rest and under the pointer.
    static let restThickness: CGFloat = 5
    static let hoverThickness: CGFloat = 14

    static func thickness(hovered: Bool) -> CGFloat { hovered ? hoverThickness : restThickness }

    /// How much longer a line is under the pointer, half on each end: twice every panel's hover grow (≈19 pt).
    static func lengthGrowth(hovered: Bool) -> CGFloat { hovered ? HoverGrowth.points * 2 : 0 }

    /// A title's grow under the pointer, from its leading (or bottom) edge.
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
/// the hover changes (a title growing, details appearing, a unit growing and pushing the ones below) moves on the
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
    /// A title's lift under the pointer: 12 % larger from `anchor`, brightened by the caller.
    func hoverLiftLabel(_ hovered: Bool, anchor: UnitPoint = .leading) -> some View {
        scaleEffect(HoverLift.labelScale(hovered: hovered), anchor: anchor)
    }
}

// MARK: - A line in segments (the cost split by model)

/// One segment of a `HoverSegmentLine`: its share and colour, and what it says inside itself under the pointer — its
/// name at its start and its figure at its end, as a plan line says its reset and its figure.
struct HoverSegment: Identifiable, Equatable {
    let id: String
    /// Its share of the whole track, 0…1.
    let fraction: Double
    let color: Color
    /// Its name ("gpt-5 · Codex"), shown only beside its figure and only when both fit whole; nil: the figure alone.
    var name: String? = nil
    /// Its figure ("$18.75"), glued to its end; shown when it fits whole.
    var figure: String
    /// The words' colour (black on a light fill such as amber).
    var ink: Color = .white
}

/// PURE: segment widths along a track — each its share of `width` less the gaps between them — and which of a
/// segment's words fit it whole.
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

    /// PURE: which words a segment `width` wide shows — its figure when it fits whole, its name too when both fit side
    /// by side; nothing cut, nothing straddling its edge.
    static func words(name: String?, figure: String, width: CGFloat) -> (name: Bool, figure: Bool) {
        let figureWidth = HoverLift.wordsWidth(figure)
        guard figureWidth > 0, figureWidth <= width else { return (false, false) }
        let nameWidth = HoverLift.wordsWidth(name)
        return (nameWidth > 0 && nameWidth + figureWidth - 6 <= width, true)
    }
}

/// A thin line split into segments (each a share of the whole), thickening and lengthening under the pointer with each
/// segment's name at its start and its figure at its end where they fit.
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
                                if hovered {
                                    let shows = HoverSegmentLayout.words(name: segment.name, figure: segment.figure, width: w)
                                    HStack(spacing: 0) {
                                        if shows.name, let name = segment.name {
                                            Text(name).foregroundStyle(segment.ink.opacity(0.9))
                                        }
                                        Spacer(minLength: 0)
                                        if shows.figure { Text(segment.figure).foregroundStyle(segment.ink) }
                                    }
                                    .font(Typography.tinyDigits(.regular))
                                    .lineLimit(1)
                                    .padding(.horizontal, 6)
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
