import SwiftUI
import WinterCUPresentation

// The open island's morph (`docs/claude/island.md`): the black mass grows OUT OF the strip (or the housing alone) into
// the open island — one shape whose rect and bottom corners reshape continuously from the strip's into the island's, on
// critically damped springs (no overshoot, no bounce: the size only ever grows towards its rest), with the contents
// fading and un-blurring in (the cards' morph blur) only once the shape has nearly grown. Closing plays it backwards,
// faster: the contents go first, then the mass shrinks back into the strip. Pure — a function of the seconds since the
// opening began (`IslandOpenMorphTests`); display-rate frames only while it moves.

struct IslandOpenMorph: Equatable {
    /// Where it grows from (the strip as it is drawn, or the housing alone) and where it rests — panel-local, top-left.
    let source: CGRect
    let target: CGRect
    let sourceCorner: CGFloat
    let targetCorner: CGFloat

    /// The opening is over after this many seconds.
    static let settle: Double = 0.5
    /// Closing plays the opening backwards this much faster.
    static let closeSpeed: Double = 1.6

    // Width leads and height follows a little behind (the mass spreads along the housing, then drops), both critically
    // damped; the contents come in over the last part of the growth.
    static let widthResponse: Double = 0.3
    static let heightResponse: Double = 0.36
    static let contentIn = (from: 0.2, to: 0.45)

    struct Frame: Equatable {
        /// The shape now (panel-local, top-left).
        var rect: CGRect
        /// Its bottom corners now (the top is the screen's edge: square).
        var corner: CGFloat
        /// How much of the contents shows (0…1), and their blur.
        var content: Double
        var blur: CGFloat
    }

    func frame(at seconds: Double) -> Frame {
        let t = min(max(seconds, 0), Self.settle)
        // At rest exactly the target, never a rounding hair short of it.
        let kw = t >= Self.settle ? 1 : Self.criticalSpring(t, response: Self.widthResponse)
        let kh = t >= Self.settle ? 1 : Self.criticalSpring(t, response: Self.heightResponse)
        let width = Self.lerp(source.width, target.width, kw)
        let height = Self.lerp(source.height, target.height, kh)
        let midX = Self.lerp(source.midX, target.midX, kw)
        let minY = Self.lerp(source.minY, target.minY, kh)
        let rect = CGRect(x: midX - width / 2, y: minY, width: width, height: height)
        let corner = min(Self.lerp(sourceCorner, targetCorner, kh), min(width, height) / 2)
        let content = t >= Self.settle ? 1 : Self.easeOut(Self.phase(t, Self.contentIn.from, Self.contentIn.to))
        // The cards' morph blur: by how far the shape still has to go, and while the contents are still coming in.
        let blur = content >= 1 ? 0 : DesktopIslandGeometry.morphBlur(size: rect.size, target: target.size)
            + DesktopIslandGeometry.maxMorphBlur * CGFloat(1 - content)
        return Frame(rect: rect, corner: max(0, corner), content: content, blur: blur)
    }

    // MARK: curves

    /// A critically damped spring's travel 0 → 1 `t` seconds after it starts: monotonic, never past 1 (no overshoot).
    static func criticalSpring(_ t: Double, response: Double) -> Double {
        guard t > 0 else { return 0 }
        let w = 2 * Double.pi / response
        return min(1, 1 - exp(-w * t) * (1 + w * t))
    }

    static func phase(_ t: Double, _ a: Double, _ b: Double) -> Double { min(max((t - a) / (b - a), 0), 1) }
    static func lerp(_ a: CGFloat, _ b: CGFloat, _ k: Double) -> CGFloat { a + (b - a) * CGFloat(k) }
    static func easeOut(_ x: Double) -> Double { 1 - pow(1 - x, 3) }
}

/// The open island's clock: opening (forward from `openedAt`), closing (backwards from where it was, `closeSpeed`
/// faster), and at rest (`still`: no frame driver). `hovered` changes only when the pointer enters or leaves.
@MainActor final class IslandOpenModel: ObservableObject {
    @Published private(set) var openedAt: Date?
    @Published private(set) var closing: (at: Date, from: Double)?
    /// At rest (fully open, or not drawn): the frame driver stops.
    @Published var still = true
    /// The pointer is over the open island: it grows a little (`IslandHover.scale`).
    @Published var hovered = false

    var isClosing: Bool { closing != nil }

    /// The seconds into the opening to draw at `now`.
    func seconds(at now: Date) -> Double {
        if let closing { return max(0, closing.from - now.timeIntervalSince(closing.at) * IslandOpenMorph.closeSpeed) }
        guard let openedAt else { return 0 }
        return min(now.timeIntervalSince(openedAt), IslandOpenMorph.settle)
    }

    /// Starts opening — from wherever a closing had got to, so a quick reopen never jumps.
    func beginOpening(now: Date = Date(), instant: Bool = false) {
        let from = instant ? IslandOpenMorph.settle : (closing != nil ? seconds(at: now) : 0)
        closing = nil
        openedAt = now.addingTimeInterval(-from)
        still = instant
        hovered = false
    }

    /// Starts closing from wherever the opening is. Returns how long the way back takes.
    @discardableResult
    func beginClosing(now: Date = Date()) -> TimeInterval {
        let from = seconds(at: now)
        closing = (now, from)
        still = false
        hovered = false
        return from / IslandOpenMorph.closeSpeed
    }

    /// The opening has settled (the controller's one wake-up): stop the frame driver.
    func settled() {
        guard closing == nil, openedAt != nil else { return }
        still = true
    }

    /// Fully closed (or never shown).
    func reset() {
        openedAt = nil
        closing = nil
        still = true
        hovered = false
    }
}

/// The open island's panel content: the morphing shell around the island's contents, a tap on its top band closing it.
struct IslandOpenRoot: View {
    @ObservedObject var store: IslandStore
    @ObservedObject var model: IslandOpenModel
    let shape: IslandScreenShape
    /// The island's rect and the strip's (what it grows from), panel-local.
    let target: CGRect
    let source: CGRect
    var tabModels: IslandTabModels?
    var pointer: DispatchPillPointer?
    var reduceMotion = false
    let onClose: () -> Void

    var morph: IslandOpenMorph {
        IslandOpenMorph(source: source, target: target, sourceCorner: IslandLayout.stripCorner, targetCorner: IslandLayout.islandCorner)
    }

    var body: some View {
        Group {
            if model.still {
                frameView(at: Date())
            } else {
                TimelineView(.animation) { context in frameView(at: context.date) }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .coordinateSpace(name: DispatchPillView.canvasSpace)
        .environment(\.dispatchPillPointer, pointer)
        .environment(\.colorScheme, .dark)
    }

    private func frameView(at date: Date) -> some View {
        var f = morph.frame(at: model.seconds(at: date))
        if reduceMotion {
            // No growth: the island fades in and out where it rests.
            let on = model.isClosing ? 0.0 : 1.0
            f = IslandOpenMorph.Frame(rect: target, corner: IslandLayout.islandCorner, content: on, blur: 0)
        }
        return IslandOpenFrame(frame: f, target: target, shape: shape, hovered: model.hovered,
                               interactive: f.content > 0.9 && !model.isClosing, onClose: onClose) {
            IslandExpandedContent(store: store, shape: shape, size: target.size, tabModels: tabModels)
        }
    }
}

/// One frame of the open island: the black shell at the morph's rect and corners (hairline rim, shadow), the contents laid
/// out at the island's resting size, clipped to the shell, blurred and faded by the morph; growing a little under the
/// pointer from its top edge (the housing's side).
struct IslandOpenFrame<Content: View>: View {
    let frame: IslandOpenMorph.Frame
    let target: CGRect
    let shape: IslandScreenShape
    var hovered = false
    var interactive = true
    var onClose: () -> Void = {}
    @ViewBuilder let content: () -> Content

    var body: some View {
        let outline = UnevenRoundedRectangle(cornerRadii: .init(bottomLeading: frame.corner, bottomTrailing: frame.corner),
                                             style: .continuous)
        ZStack(alignment: .top) {
            content()
                .frame(width: target.width, height: target.height, alignment: .top)
                .blur(radius: frame.blur)
                .opacity(frame.content)
                .allowsHitTesting(interactive)
            // A tap on the top band (the housing's height) closes it.
            Color.clear
                .frame(width: frame.rect.width, height: shape.topInset)
                .contentShape(Rectangle())
                .onTapGesture(perform: onClose)
        }
        .frame(width: frame.rect.width, height: frame.rect.height, alignment: .top)
        .clipShape(outline)
        .background(outline.fill(Color.black))
        .overlay(outline.strokeBorder(Color.white.opacity(0.09), lineWidth: 1).opacity(frame.content))
        .compositingGroup()
        .shadow(color: .black.opacity(0.45), radius: 18, y: 6)
        .islandHoverGrow(hovered)
        .offset(x: frame.rect.minX, y: frame.rect.minY)
    }
}

// MARK: - Hover

/// Every standalone island panel grows by the Dispatch pill's own hover (`DesktopIslandGeometry.hoverScale`, the same
/// value as `DispatchPillMetrics.hoverScale`) from its TOP edge (the housing's side), on the same spring. Inner rows and
/// tiles never add a second grow: they lighten and glow (`IslandHoverSurface`).
enum IslandHover {
    static let scale = DesktopIslandGeometry.hoverScale
    static let animation = Animation.spring(response: 0.3, dampingFraction: 0.7)
    /// A row's soft glow under the pointer (the pills' `pillHoverGlow` radii, white, gentler on a large surface).
    static let rowGlowNear: Double = 0.10
    static let rowGlowFar: Double = 0.05
}

extension View {
    /// Grows by `IslandHover.scale` from the top edge while `hovered`; the animation is scoped to the scale alone.
    func islandHoverGrow(_ hovered: Bool) -> some View {
        animation(IslandHover.animation) { view in
            view.scaleEffect(hovered ? IslandHover.scale : 1, anchor: .top)
        }
    }

    /// Grows by `IslandHover.scale` from the top edge while the island's pointer (`dispatchPillPointer`) is over this
    /// view — for a panel whose hover nothing else tracks (the waiting pill). No pointer (the gallery): at rest.
    func islandPointerHoverGrow() -> some View {
        modifier(IslandPointerHoverGrow())
    }
}

private struct IslandPointerHoverGrow: ViewModifier {
    @Environment(\.dispatchPillPointer) private var pointer

    func body(content: Content) -> some View {
        if let pointer {
            content.modifier(IslandPointerHoverGrowTracking(pointer: pointer))
        } else {
            content
        }
    }
}

private struct IslandPointerHoverGrowTracking: ViewModifier {
    @ObservedObject var pointer: DispatchPillPointer
    @State private var frame: CGRect = .zero

    func body(content: Content) -> some View {
        let hovered = pointer.location.map { frame.contains($0) } ?? false
        content
            .onGeometryChange(for: CGRect.self) { proxy in
                proxy.frame(in: .named(DispatchPillView.canvasSpace))
            } action: { frame = $0 }
            .islandHoverGrow(hovered)
    }
}
