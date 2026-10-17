import SwiftUI
import WinterCUPresentation

// The open island's morph (`docs/claude/island.md`): the black mass grows OUT OF the strip (or the housing alone) into
// the open island — one shape whose rect, bottom corners and top shoulders reshape continuously from the strip's into the
// island's, on critically damped springs (no overshoot, no bounce: the size only ever grows towards its rest), with the
// contents fading and un-blurring in (the cards' morph blur) only once the shape has nearly grown. Its top is the
// screen's edge on EVERY frame: flat, flush with it, flaring into it through two concave shoulders (`IslandEdgeShape`),
// so the island reads as the hardware housing grown, never as a panel hanging below it. Closing plays it backwards,
// faster: the contents go first, then the mass shrinks back into the strip. Pure — a function of the seconds since the
// opening began (`IslandOpenMorphTests`); display-rate frames only while it moves.

struct IslandOpenMorph: Equatable {
    /// Where it grows from (the strip as it is drawn, or the housing alone) and where it rests — panel-local, top-left.
    let source: CGRect
    let target: CGRect
    let sourceCorner: CGFloat
    let targetCorner: CGFloat
    /// The top shoulders: none on the strip (the housing's own silhouette, black on black), the island's at rest.
    var sourceShoulder: CGFloat = 0
    var targetShoulder: CGFloat = IslandLayout.islandShoulder

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
        /// Its top shoulders now: the concave fillets by which its flat top flares into the screen's edge, OUTSIDE the
        /// rect (`IslandEdgeShape`).
        var shoulder: CGFloat
        /// How much of the contents shows (0…1), and their blur.
        var content: Double
        var blur: CGFloat

        /// The island at rest in `rect`: its corners and shoulders, contents in.
        static func resting(_ rect: CGRect) -> Frame {
            Frame(rect: rect, corner: IslandLayout.islandCorner, shoulder: IslandLayout.islandShoulder, content: 1, blur: 0)
        }
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
        // The shoulders spread with the width (along the screen's edge), never deeper than the body beside them.
        let shoulder = IslandEdgeShape.clampedShoulder(Self.lerp(sourceShoulder, targetShoulder, kw), height: height,
                                                       corner: corner)
        let content = t >= Self.settle ? 1 : Self.easeOut(Self.phase(t, Self.contentIn.from, Self.contentIn.to))
        // The cards' morph blur: by how far the shape still has to go, and while the contents are still coming in.
        let blur = content >= 1 ? 0 : DesktopIslandGeometry.morphBlur(size: rect.size, target: target.size)
            + DesktopIslandGeometry.maxMorphBlur * CGFloat(1 - content)
        return Frame(rect: rect, corner: max(0, corner), shoulder: shoulder, content: content, blur: blur)
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
/// faster), and at rest (`still`: no frame driver). The open island has no hover grow (user 2026-10-17): its rows and
/// tiles glow under the pointer, the island itself stays put.
@MainActor final class IslandOpenModel: ObservableObject {
    @Published private(set) var openedAt: Date?
    @Published private(set) var closing: (at: Date, from: Double)?
    /// At rest (fully open, or not drawn): the frame driver stops.
    @Published var still = true

    var isClosing: Bool { closing != nil }
    /// Fully open and at rest: its contents are in (what a view request's ack waits for).
    var isRestingOpen: Bool { still && closing == nil && openedAt != nil }

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
    }

    /// Starts closing from wherever the opening is. Returns how long the way back takes.
    @discardableResult
    func beginClosing(now: Date = Date()) -> TimeInterval {
        let from = seconds(at: now)
        closing = (now, from)
        still = false
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
    /// A click on the top band, x from the island's centre (the strip's own coordinates): the controller maps it to the
    /// strip's parts — a wing switches to its tab, anything else closes.
    let onTopBand: (CGPoint) -> Void

    var morph: IslandOpenMorph {
        IslandOpenMorph(source: source, target: target, sourceCorner: IslandLayout.stripCorner, targetCorner: IslandLayout.islandCorner)
    }

    var body: some View {
        // ONE timeline, paused at rest (frames only while it moves): switching between a timeline and a plain view would
        // rebuild the island's contents when the morph settles, resetting their scroll and focus.
        TimelineView(.animation(minimumInterval: nil, paused: model.still)) { context in
            frameView(at: model.still ? Date() : context.date)
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
            f = .resting(target)
            f.content = on
        }
        return IslandOpenFrame(frame: f, target: target, shape: shape,
                               interactive: f.content > 0.9 && !model.isClosing, onTopBand: onTopBand) {
            IslandExpandedContent(store: store, shape: shape, size: target.size, tabModels: tabModels)
        }
    }
}

/// One frame of the open island: pure black, the hardware housing grown — its flat top flush with the screen's edge and
/// flaring into it through concave shoulders, rounded below (`IslandEdgeShape`). No rim (a light line would outline it
/// against the housing) and no hover grow. The soft drop shadow only below the housing's height, fading in, so nothing
/// darkens the menu bar along its top edge or its shoulders. The contents are laid out at the island's resting size,
/// clipped to the shape, blurred and faded by the morph.
struct IslandOpenFrame<Content: View>: View {
    let frame: IslandOpenMorph.Frame
    let target: CGRect
    let shape: IslandScreenShape
    var interactive = true
    /// A click on the top band (the housing's height), x from the shape's centre.
    var onTopBand: (CGPoint) -> Void = { _ in }
    @ViewBuilder let content: () -> Content

    var body: some View {
        let outline = IslandEdgeShape(corner: frame.corner, shoulder: frame.shoulder)
        ZStack(alignment: .top) {
            content()
                .frame(width: target.width, height: target.height, alignment: .top)
                .islandPanelSpace()
                .blur(radius: frame.blur)
                .opacity(frame.content)
                .allowsHitTesting(interactive)
            // A click on the top band (the housing's height, where the strip is): a wing's tab, or close.
            Color.clear
                .frame(width: frame.rect.width, height: shape.topInset)
                .contentShape(Rectangle())
                .onTapGesture(coordinateSpace: .local) { location in
                    onTopBand(CGPoint(x: location.x - frame.rect.width / 2, y: location.y))
                }
        }
        .frame(width: frame.rect.width, height: frame.rect.height, alignment: .top)
        .clipShape(outline)
        .background {
            ZStack {
                outline.fill(Color.black)
                    .shadow(color: .black.opacity(IslandOpenFrame.shadowOpacity), radius: IslandOpenFrame.shadowRadius,
                            y: IslandOpenFrame.shadowY)
                    .mask { IslandOpenFrame.shadowMask(size: frame.rect.size, from: shape.topInset) }
                outline.fill(Color.black)
            }
        }
        .offset(x: frame.rect.minX, y: frame.rect.minY)
    }

    static var shadowOpacity: Double { 0.45 }
    static var shadowRadius: CGFloat { 18 }
    static var shadowY: CGFloat { 6 }
    /// How far past the shape the shadow reaches (its radius plus its drop), for its mask.
    static var shadowReach: CGFloat { 40 }
    /// Over this many points below the housing's height the shadow fades in.
    static var shadowFadeIn: CGFloat { 28 }

    /// The shadow's mask: nothing down to the housing's height (no shadow on the menu bar, along the top edge or by the
    /// shoulders), fading in below it; reaching past the shape on every other side.
    static func shadowMask(size: CGSize, from top: CGFloat) -> some View {
        let reach = shadowReach
        return VStack(spacing: 0) {
            Color.clear.frame(height: reach + top)
            LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom).frame(height: shadowFadeIn)
            Color.black
        }
        .frame(width: size.width + 2 * reach, height: size.height + 2 * reach)
        .frame(width: size.width, height: size.height)
    }
}

/// The open island's outline: a flat top flush with the screen's edge, a concave shoulder at each top corner flaring OUT
/// into that edge (outside the rect, like the hardware housing's own flare into the display), straight sides, and
/// continuous rounded bottom corners. One path (the shoulders are sub-paths adjoining the body), so a fill has no seam.
struct IslandEdgeShape: Shape {
    var corner: CGFloat
    var shoulder: CGFloat

    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(corner, shoulder) }
        set { corner = newValue.first; shoulder = newValue.second }
    }

    /// The circle's control-point ratio for a quarter arc drawn as one cubic.
    static let kappa: CGFloat = 0.552_284_75

    /// PURE: a shoulder never deeper than the side it flares from (the height less the bottom corner), nor than half the
    /// height.
    static func clampedShoulder(_ shoulder: CGFloat, height: CGFloat, corner: CGFloat) -> CGFloat {
        max(0, min(shoulder, height - corner, height / 2))
    }

    func path(in rect: CGRect) -> Path {
        var path = UnevenRoundedRectangle(cornerRadii: .init(bottomLeading: max(0, corner), bottomTrailing: max(0, corner)),
                                          style: .continuous).path(in: rect)
        let s = Self.clampedShoulder(shoulder, height: rect.height, corner: corner)
        guard s > 0.01 else { return path }
        let k = Self.kappa * s
        // Left: from the screen's edge `s` out from the side, along the edge to the body's corner, down its side, and
        // back up along the quarter circle centred `s` out and `s` down — concave, flaring into the edge.
        path.move(to: CGPoint(x: rect.minX - s, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + s))
        path.addCurve(to: CGPoint(x: rect.minX - s, y: rect.minY),
                      control1: CGPoint(x: rect.minX, y: rect.minY + s - k),
                      control2: CGPoint(x: rect.minX - s + k, y: rect.minY))
        path.closeSubpath()
        // Right: the mirror image.
        path.move(to: CGPoint(x: rect.maxX + s, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY + s))
        path.addCurve(to: CGPoint(x: rect.maxX + s, y: rect.minY),
                      control1: CGPoint(x: rect.maxX, y: rect.minY + s - k),
                      control2: CGPoint(x: rect.maxX + s - k, y: rect.minY))
        path.closeSubpath()
        return path
    }
}

// MARK: - Hover

/// Every floating island panel — a card on top (approval, question, link, view request), the waiting pill, the turn
/// result, the computer-use pill and the in-island mirror — grows under the pointer by the SAME few points as the
/// compact Dispatch pill (`HoverGrowth`: its width by 9.48 pt, uniformly), from its TOP edge (the housing's side), on
/// the same spring. The open island does not grow at all; inner rows and tiles never grow: they lighten and glow
/// (`IslandHoverSurface`).
enum IslandHover {
    static let animation = HoverGrowth.animation
    /// A row's soft glow under the pointer (the pills' `pillHoverGlow` radii, white, gentler on a large surface).
    static let rowGlowNear: Double = 0.10
    static let rowGlowFar: Double = 0.05
}

extension IslandHover {
    /// PURE: a panel of `size`'s scale under the pointer (`HoverGrowth.scale(for:)`).
    static func scale(for size: CGSize) -> CGSize { HoverGrowth.scale(for: size) }

    /// PURE: `rect` grown by the hover from its top edge — what a hovered panel covers, and so its hit area while
    /// hovered (it leaves the hover only when the pointer leaves the GROWN shape: no flicker at the edge).
    static func grown(_ rect: CGRect) -> CGRect {
        HoverGrowth.grown(rect, anchor: .top)
    }

    /// PURE: hovering with this hysteresis — inside the shape, or inside the grown one while already hovered.
    static func isOver(_ point: CGPoint?, _ rect: CGRect, wasHovered: Bool) -> Bool {
        guard let point, !rect.isEmpty else { return false }
        return (wasHovered ? grown(rect) : rect).contains(point)
    }

    /// PURE: a point over a panel resting at `rect` (grown from its top edge when `grown`) → the panel's OWN unscaled
    /// space, origin at its top-left: where its rows and buttons are laid out, so their hover sits under the pointer
    /// whether or not the panel has grown.
    static func unscaled(_ point: CGPoint, in rect: CGRect, grown: Bool) -> CGPoint {
        let s = grown ? scale(for: rect.size) : CGSize(width: 1, height: 1)
        return CGPoint(x: (point.x - rect.midX) / s.width + rect.width / 2, y: (point.y - rect.minY) / s.height)
    }
}

/// The top panel's hover state, decided by the controller (with `IslandHover.isOver`'s hysteresis) so the hit area, the
/// hold and the grow all agree. Changes only when the pointer enters or leaves.
@MainActor final class IslandPanelHover: ObservableObject {
    @Published var card = false
    @Published var waiting = false
}

extension View {
    /// Grows a panel of `size` by `HoverGrowth` from its top edge while `hovered`; the animation is scoped to the scale.
    func islandHoverGrow(_ hovered: Bool, size: CGSize) -> some View {
        hoverGrowth(hovered, size: size, anchor: .top)
    }

    /// The panel's own space for the pointer-reading views inside it (rows, buttons): the controller publishes the
    /// pointer already mapped into it (`IslandHover.unscaled`), so a hover sits under the pointer at any grow.
    func islandPanelSpace() -> some View {
        coordinateSpace(name: DispatchPillView.canvasSpace)
    }
}
