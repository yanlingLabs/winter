import AppKit
import SwiftUI

// The desktop-switch prompt as a pill born from the camera housing (user ruling 2026-10-14): a black mass grows down
// out of the housing (or the top edge of a screen without one), a pill forms at its tip, and the neck between them
// thins and parts like a drop of ink, leaving the pill floating just below — one line ("Winter needs your view for a
// sec on Safari"), a red ✕ and a blue ✓. The words come from `CUDesktopPromptModel`; nothing here decides anything.

/// Where everything is inside the island's panel, in points, top-left origin (the panel's top is the screen's top).
struct DesktopIslandGeometry: Equatable {
    var panelSize: CGSize
    /// What the pill is born from: the camera housing, or a thin strip at the top edge without one.
    var source: CGRect
    var sourceIsHousing: Bool
    /// Where the pill comes to rest.
    var pill: CGRect
    /// A second prompt: no birth from the top, the pill just grows in place below the first.
    var floating: Bool

    static let pillHeight: CGFloat = 44
    /// Between the housing (or the menu bar) and the resting pill.
    static let gap: CGFloat = 10
    /// Room for the shadow around the pill inside its panel.
    static let margin: CGFloat = 24
    static let stack: CGFloat = 10
    static let widthRange: ClosedRange<CGFloat> = 300...560
    static let font = NSFont.systemFont(ofSize: 13.5, weight: .semibold)

    /// The pill's width for its line: the text, then the two buttons, within `widthRange`.
    static func pillWidth(for headline: String) -> CGFloat {
        let text = ceil((headline as NSString).size(withAttributes: [.font: font]).width)
        // The row: leading, the text, three spacings (text–spacer–✕–✓), the spacer's minimum, the buttons, trailing,
        // and a little slack so the line never truncates by a rounding hair.
        let row = DesktopIslandRow.leading + text + 3 * DesktopIslandRow.spacing + DesktopIslandRow.spacerMin
            + 2 * DesktopIslandRow.button + DesktopIslandRow.trailing + 6
        return min(max(row, widthRange.lowerBound), widthRange.upperBound)
    }

    /// - Parameters:
    ///   - housing: the camera housing's size, nil on a screen without one.
    ///   - menuBarHeight: the top inset with no housing (the pill rests below it).
    static func make(housing: CGSize?, menuBarHeight: CGFloat, pillWidth: CGFloat, slot: Int) -> Self {
        let m = margin
        if slot > 0 {
            let size = CGSize(width: pillWidth + 2 * m, height: pillHeight + 2 * m)
            return Self(panelSize: size, source: .zero, sourceIsHousing: false,
                        pill: CGRect(x: m, y: m, width: pillWidth, height: pillHeight), floating: true)
        }
        let hasHousing = (housing?.width ?? 0) > 0 && (housing?.height ?? 0) > 0
        let top = hasHousing ? housing!.height : max(menuBarHeight, 22)
        let sourceWidth = hasHousing ? housing!.width : 120
        let width = max(pillWidth, sourceWidth) + 2 * m
        let source = CGRect(x: (width - sourceWidth) / 2, y: 0, width: sourceWidth, height: hasHousing ? top : 0)
        let pill = CGRect(x: (width - pillWidth) / 2, y: top + gap, width: pillWidth, height: pillHeight)
        return Self(panelSize: CGSize(width: width, height: pill.maxY + m), source: source,
                    sourceIsHousing: hasHousing, pill: pill, floating: false)
    }

    /// Where a slot's panel's top sits below the screen's top: slot 0 at the top, each later one below the pill
    /// above it.
    static func panelTop(slot: Int, housing: CGSize?, menuBarHeight: CGFloat) -> CGFloat {
        guard slot > 0 else { return 0 }
        let top = (housing?.height ?? 0) > 0 ? housing!.height : max(menuBarHeight, 22)
        return top + gap + pillHeight + CGFloat(slot - 1) * (pillHeight + stack) + stack - margin
    }

    // MARK: the birth, as shapes at a moment t (0 = nothing, 1 = the resting pill)

    struct Blob: Equatable {
        var rect: CGRect
        var radius: CGFloat
    }

    /// The black masses at `t`. Drawn through a blur and an alpha threshold, touching masses melt into one and a
    /// thinning neck parts on its own.
    func blobs(at t: Double) -> [Blob] {
        let t = min(max(t, 0), 1)
        var out: [Blob] = []
        if floating {
            let p = Self.easeOut(t)
            let w = Self.lerp(80, pill.width, Self.easeOutBack(t))
            let h = Self.lerp(12, pill.height, p)
            out.append(Blob(rect: CGRect(x: pill.midX - w / 2, y: pill.midY - h / 2, width: w, height: h), radius: h / 2))
            return out
        }
        // Everything that touches the top runs up past it, so the blur never thins the top edge.
        let above: CGFloat = 40
        if sourceIsHousing {
            out.append(Blob(rect: CGRect(x: source.minX, y: -above, width: source.width, height: source.maxY + above),
                            radius: 9))
        }
        // The stem: a drop that grows down out of the source, then pulls back up into it, so the neck between it and
        // the pill thins and parts.
        let grow = Self.easeInOut(Self.phase(t, 0, 0.42))
        let back = Self.easeIn(Self.phase(t, 0.46, 0.8))
        let reach = pill.midY - source.maxY
        let bottom = source.maxY + reach * grow - (reach + 14) * back
        let dropWidth = sourceIsHousing ? source.width * 0.62 : 90
        let stemWidth = Self.lerp(dropWidth, 30, back)
        if bottom > 0 {
            out.append(Blob(rect: CGRect(x: source.midX - stemWidth / 2, y: -above, width: stemWidth, height: bottom + above),
                            radius: min(stemWidth / 2, 18)))
        }
        // The pill: a round tip forms on the drop and sinks into place (still drop-wide); only as the neck lets go does
        // it widen into the pill, with a little give.
        let form = Self.phase(t, 0.14, 0.56)
        guard form > 0 else { return out }
        let widen = Self.easeOutBack(Self.phase(t, 0.48, 0.9))
        let w = Self.lerp(dropWidth * 0.9, pill.width, widen)
        let h = Self.lerp(26, pill.height, Self.easeOut(form))
        let tip = source.maxY + reach * grow
        let cy = Self.lerp(tip - 12, pill.midY, Self.easeOut(form))
        out.append(Blob(rect: CGRect(x: pill.midX - w / 2, y: cy - h / 2, width: w, height: h), radius: h / 2))
        return out
    }

    /// The melt's blur: full while the masses join and part, gone once the pill floats free (so the pill and the
    /// housing, 10 pt apart, never melt back together).
    static func blur(_ t: Double) -> CGFloat { 7 * CGFloat(1 - phase(t, 0.82, 0.95)) }

    /// The crisp pill drawn over the melted shape once it rests (the threshold's edge is not anti-aliased).
    static func crispAlpha(_ t: Double) -> Double { phase(t, 0.9, 1) }
    /// The line and the buttons.
    static func contentAlpha(_ t: Double) -> Double { easeOut(phase(t, 0.82, 1)) }

    static func phase(_ t: Double, _ a: Double, _ b: Double) -> Double { min(max((t - a) / (b - a), 0), 1) }
    static func lerp(_ a: CGFloat, _ b: CGFloat, _ k: Double) -> CGFloat { a + (b - a) * CGFloat(k) }
    static func easeOut(_ x: Double) -> Double { 1 - pow(1 - x, 3) }
    static func easeIn(_ x: Double) -> Double { x * x * x }
    static func easeInOut(_ x: Double) -> Double { x < 0.5 ? 4 * x * x * x : 1 - pow(-2 * x + 2, 3) / 2 }
    static func easeOutBack(_ x: Double) -> Double {
        let c1 = 1.4, c3 = c1 + 1
        return 1 + c3 * pow(x - 1, 3) + c1 * pow(x - 1, 2)
    }
}

/// The island's live state: the surface writes it, the view draws it.
@MainActor final class DesktopIslandState: ObservableObject {
    @Published var open = false
    @Published var secondsLeft: Int
    /// The answer came from the island's own buttons (it then goes back into the housing before it closes).
    var answeredHere = false
    var onSwitch: (() -> Void)?
    var onRefuse: (() -> Void)?

    init(secondsLeft: Int) { self.secondsLeft = secondsLeft }
}

struct DesktopIslandView: View {
    let model: CUDesktopPromptModel
    let geometry: DesktopIslandGeometry
    @ObservedObject var state: DesktopIslandState
    var reduceMotion = false

    static let duration: Double = 0.9

    var body: some View {
        IslandMorph(t: state.open ? 1 : 0, geometry: geometry, model: model, state: state, reduceMotion: reduceMotion)
            .animation(reduceMotion ? .easeOut(duration: 0.2) : .linear(duration: Self.duration), value: state.open)
            .frame(width: geometry.panelSize.width, height: geometry.panelSize.height, alignment: .topLeading)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("\(model.title) Switching in \(state.secondsLeft) seconds.")
    }
}

/// One frame of the birth: SwiftUI animates `t` and draws each frame.
struct IslandMorph: View, Animatable {
    var t: Double
    let geometry: DesktopIslandGeometry
    let model: CUDesktopPromptModel
    @ObservedObject var state: DesktopIslandState
    var reduceMotion = false

    var animatableData: Double {
        get { t }
        set { t = newValue }
    }

    var body: some View {
        let pill = geometry.pill
        // Reduce Motion: no birth, the pill fades in where it rests.
        let shapeT = reduceMotion ? (t > 0 ? 1 : 0) : t
        ZStack(alignment: .topLeading) {
            if !reduceMotion {
                Canvas { ctx, _ in
                    ctx.addFilter(.alphaThreshold(min: 0.5, color: .black))
                    let blur = DesktopIslandGeometry.blur(shapeT)
                    if blur > 0.1 { ctx.addFilter(.blur(radius: blur)) }
                    ctx.drawLayer { layer in
                        for blob in geometry.blobs(at: shapeT) {
                            layer.fill(Path(roundedRect: blob.rect, cornerRadius: blob.radius, style: .continuous),
                                       with: .color(.black))
                        }
                    }
                }
                .frame(width: geometry.panelSize.width, height: geometry.panelSize.height)
            }
            Capsule(style: .continuous)
                .fill(Color.black)
                .shadow(color: .black.opacity(0.3), radius: 12, y: 5)
                .frame(width: pill.width, height: pill.height)
                .offset(x: pill.minX, y: pill.minY)
                .opacity(reduceMotion ? t : DesktopIslandGeometry.crispAlpha(shapeT))
            DesktopIslandRow(model: model, state: state)
                .frame(width: pill.width, height: pill.height)
                .offset(x: pill.minX, y: pill.minY)
                .opacity(reduceMotion ? t : DesktopIslandGeometry.contentAlpha(shapeT))
                .allowsHitTesting(t > 0.95)
        }
        .frame(width: geometry.panelSize.width, height: geometry.panelSize.height, alignment: .topLeading)
    }
}

/// The pill's one row: the line, then ✕ (don't switch) and ✓ (switch now).
struct DesktopIslandRow: View {
    let model: CUDesktopPromptModel
    @ObservedObject var state: DesktopIslandState

    static let red = Color(red: 1.0, green: 0.27, blue: 0.23)
    static let blue = Color(red: 0.04, green: 0.52, blue: 1.0)
    static let leading: CGFloat = 20
    static let trailing: CGFloat = 7
    static let button: CGFloat = 30
    static let spacing: CGFloat = 8
    static let spacerMin: CGFloat = 6

    var body: some View {
        HStack(spacing: Self.spacing) {
            Text(model.headline)
                .font(Font(DesktopIslandGeometry.font))
                .foregroundStyle(.white)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: Self.spacerMin)
            Button { answer(state.onRefuse) } label: { Image(systemName: "xmark") }
                .buttonStyle(IslandCircleButtonStyle(fill: Self.red))
                .accessibilityLabel("Don't switch")
            Button { answer(state.onSwitch) } label: { Image(systemName: "checkmark") }
                .buttonStyle(IslandCircleButtonStyle(fill: Self.blue))
                .accessibilityLabel("Switch now")
        }
        .padding(.leading, Self.leading)
        .padding(.trailing, Self.trailing)
    }

    private func answer(_ action: (() -> Void)?) {
        state.answeredHere = true
        action?()
    }
}

struct IslandCircleButtonStyle: ButtonStyle {
    let fill: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(.white)
            .frame(width: DesktopIslandRow.button, height: DesktopIslandRow.button)
            .background(Circle().fill(fill))
            .scaleEffect(configuration.isPressed ? 0.9 : 1)
            .opacity(configuration.isPressed ? 0.8 : 1)
            .contentShape(Circle())
    }
}

/// A hosting view that takes the first click on a panel that is never key, without activating the helper.
final class FirstClickHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// The island rendered OFFSCREEN (no window, nothing on screen), for looking at it without a prompt: a still of the
/// resting pill per case, a filmstrip of the birth, and a GIF of it.
public enum CUDesktopIslandGallery {
    /// Writes the files into `directory` (created if needed) and returns them.
    @MainActor public static func render(to directory: URL) throws -> [URL] {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let housing = CGSize(width: 185, height: 32)
        var out: [URL] = []
        for (name, h, slot) in [("housing", Optional(housing), 0), ("no-housing", nil, 0), ("second", nil, 1)] {
            let image = try frame(t: 1, housing: h, slot: slot)
            out.append(try write(image, directory.appendingPathComponent("island-\(name)@2x.png")))
        }
        let times = stride(from: 0.0, through: 1.0, by: 1.0 / 9).map { $0 }
        let frames = try times.map { try frame(t: $0, housing: housing, slot: 0) }
        out.append(try write(try filmstrip(frames), directory.appendingPathComponent("island-birth-filmstrip@2x.png")))
        let gifFrames = try stride(from: 0.0, through: 1.0, by: 1.0 / 36).map { try frame(t: $0, housing: housing, slot: 0) }
            + Array(repeating: try frame(t: 1, housing: housing, slot: 0), count: 24)
        let gif = directory.appendingPathComponent("island-birth.gif")
        try CUCursorGallery.writeGIF(gifFrames, delay: DesktopIslandView.duration / 36, to: gif)
        out.append(gif)
        return out
    }

    @MainActor static func frame(t: Double, housing: CGSize?, slot: Int) throws -> CGImage {
        let model = CUDesktopPromptModel(CUDesktopPromptRequest(promptId: "g", sessionId: "s", app: "Google Chrome",
                                                                bundleId: "com.google.Chrome", reason: "",
                                                                timeoutMs: 60_000), now: 0)
        let state = DesktopIslandState(secondsLeft: 43)
        let geometry = DesktopIslandGeometry.make(housing: housing, menuBarHeight: 24,
                                                  pillWidth: DesktopIslandGeometry.pillWidth(for: model.headline), slot: slot)
        let bar = housing?.height ?? 24
        let lead: CGFloat = slot > 0 ? bar + 20 : 0
        let scene = ZStack(alignment: .top) {
            LinearGradient(colors: [Color(red: 0.55, green: 0.66, blue: 0.82), Color(red: 0.86, green: 0.83, blue: 0.9)],
                           startPoint: .top, endPoint: .bottom)
            // The menu bar strip, and the camera housing itself (black, like the hardware).
            Rectangle().fill(.white.opacity(0.35)).frame(height: bar)
            if let housing {
                UnevenRoundedRectangle(cornerRadii: .init(bottomLeading: 9, bottomTrailing: 9), style: .continuous)
                    .fill(Color.black).frame(width: housing.width, height: housing.height)
            }
            IslandMorph(t: t, geometry: geometry, model: model, state: state)
                .padding(.top, lead)
        }
        .frame(width: geometry.panelSize.width + 160, height: geometry.panelSize.height + lead + 30)
        let renderer = ImageRenderer(content: scene)
        renderer.scale = 2
        guard let image = renderer.cgImage else { throw CUCursorGallery.GalleryError.cannotCreateContext }
        return image
    }

    static func filmstrip(_ frames: [CGImage]) throws -> CGImage {
        guard let first = frames.first,
              let ctx = CGContext(data: nil, width: first.width, height: first.height * frames.count, bitsPerComponent: 8,
                                  bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { throw CUCursorGallery.GalleryError.cannotCreateContext }
        for (i, f) in frames.enumerated() {
            ctx.draw(f, in: CGRect(x: 0, y: (frames.count - 1 - i) * first.height, width: first.width, height: first.height))
        }
        guard let image = ctx.makeImage() else { throw CUCursorGallery.GalleryError.cannotCreateContext }
        return image
    }

    static func write(_ image: CGImage, _ url: URL) throws -> URL {
        try CUCursorGallery.writePNG(image, to: url)
        return url
    }
}
