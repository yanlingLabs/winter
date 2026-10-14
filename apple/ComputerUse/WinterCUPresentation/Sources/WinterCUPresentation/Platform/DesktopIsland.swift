import AppKit
import SwiftUI

// The desktop-switch prompt as a pill born from the camera housing like a drop of water (user ruling 2026-10-14; the
// liquid is `DesktopIslandFluid`): it falls out of the housing (or the top edge of a screen without one), its tail
// snaps, and it spreads into a pill floating just below — one line ("Winter needs your view for a sec on Safari"), a
// red ✕ and a blue ✓. The words come from `CUDesktopPromptModel`; nothing here decides anything.

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

}

/// The island's live state: the surface writes it, the view draws it.
@MainActor final class DesktopIslandState: ObservableObject {
    /// When the birth began (nil: not yet shown).
    @Published var bornAt: Date?
    /// When the way back up began (answered on the pill).
    @Published var returningAt: Date?
    /// The birth (or the way back) is over: the frame driver stops, nothing redraws.
    @Published var still = false
    @Published var secondsLeft: Int
    /// The answer came from the pill's own buttons (it then goes back into the housing before it closes).
    var answeredHere = false
    var onSwitch: (() -> Void)?
    var onRefuse: (() -> Void)?

    init(secondsLeft: Int) { self.secondsLeft = secondsLeft }

    /// The seconds into the birth to draw at `now`: forward from `bornAt`, then backwards faster on the way up.
    func seconds(at now: Date) -> Double {
        guard let bornAt else { return 0 }
        let forward = min(now.timeIntervalSince(bornAt), DesktopIslandFluid.settle)
        guard let returningAt else { return forward }
        return max(0, min(forward, DesktopIslandFluid.settle) - now.timeIntervalSince(returningAt) * DesktopIslandFluid.returnSpeed)
    }
}

struct DesktopIslandView: View {
    let model: CUDesktopPromptModel
    let geometry: DesktopIslandGeometry
    @ObservedObject var state: DesktopIslandState
    var reduceMotion = false

    var body: some View {
        // Display-rate frames while the liquid moves; none once it rests (`still`).
        TimelineView(.animation(minimumInterval: nil, paused: state.still || state.bornAt == nil)) { context in
            IslandFrameView(frame: reduceMotion ? restFrame(context.date) : DesktopIslandFluid(geometry: geometry)
                                .frame(at: state.seconds(at: context.date)),
                            geometry: geometry, model: model, state: state, reduceMotion: reduceMotion)
        }
        .frame(width: geometry.panelSize.width, height: geometry.panelSize.height, alignment: .topLeading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(model.title) Switching in \(state.secondsLeft) seconds.")
    }

    /// Reduce Motion: no birth — the pill fades in where it rests (and out on the way back).
    private func restFrame(_ now: Date) -> DesktopIslandFluid.Frame {
        var f = DesktopIslandFluid(geometry: geometry).frame(at: DesktopIslandFluid.settle)
        let shown = state.seconds(at: now) > 0 ? 1.0 : 0.0
        f.blobs = []
        f.crisp = shown
        f.content = shown
        return f
    }
}

/// One frame of the liquid: the melt (blur + alpha threshold), the crisp pill over it once it rests, the words.
struct IslandFrameView: View {
    let frame: DesktopIslandFluid.Frame
    let geometry: DesktopIslandGeometry
    let model: CUDesktopPromptModel
    @ObservedObject var state: DesktopIslandState
    var reduceMotion = false

    var body: some View {
        let pill = frame.pill
        ZStack(alignment: .topLeading) {
            // The melt is only drawn while it shows anything the crisp pill does not.
            if frame.crisp < 1, !frame.blobs.isEmpty {
                Canvas { ctx, _ in
                    ctx.addFilter(.alphaThreshold(min: 0.5, color: .black))
                    if frame.blur > 0.1 { ctx.addFilter(.blur(radius: frame.blur)) }
                    ctx.drawLayer { layer in
                        for blob in frame.blobs {
                            let path: Path
                            switch blob.kind {
                            case .ellipse: path = Path(ellipseIn: blob.rect)
                            case .capsule: path = Path(roundedRect: blob.rect, cornerRadius: min(blob.rect.width, blob.rect.height) / 2,
                                                       style: .continuous)
                            case .roundedRect(let r): path = Path(roundedRect: blob.rect, cornerRadius: r, style: .continuous)
                            }
                            layer.fill(path, with: .color(.black))
                        }
                    }
                }
                .frame(width: geometry.panelSize.width, height: geometry.panelSize.height)
            }
            Capsule(style: .continuous)
                .fill(Color.black)
                .shadow(color: .black.opacity(0.3 * frame.crisp), radius: 12, y: 5)
                .frame(width: max(pill.width, 0), height: max(pill.height, 0))
                .offset(x: pill.minX, y: pill.minY)
                .opacity(frame.crisp)
            DesktopIslandRow(model: model, state: state)
                .frame(width: geometry.pill.width, height: geometry.pill.height)
                .offset(x: geometry.pill.minX, y: geometry.pill.minY)
                .opacity(frame.content)
                .allowsHitTesting(frame.content > 0.9 && state.returningAt == nil)
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
/// resting pill per case, a filmstrip of the birth (every 0.1 s), and a GIF of it at 30 fps.
public enum CUDesktopIslandGallery {
    /// Writes the files into `directory` (created if needed) and returns them.
    @MainActor public static func render(to directory: URL) throws -> [URL] {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let housing = CGSize(width: 185, height: 32)
        var out: [URL] = []
        for (name, h, slot) in [("housing", Optional(housing), 0), ("no-housing", nil, 0), ("second", nil, 1)] {
            let image = try frame(t: DesktopIslandFluid.settle, housing: h, slot: slot)
            out.append(try write(image, directory.appendingPathComponent("island-\(name)@2x.png")))
        }
        let times = stride(from: 0.0, through: 1.2, by: 0.1).map { $0 }
        let frames = try times.map { try frame(t: $0, housing: housing, slot: 0) }
        out.append(try write(try filmstrip(frames), directory.appendingPathComponent("island-birth-filmstrip@2x.png")))
        let gifFrames = try stride(from: 0.0, through: DesktopIslandFluid.settle, by: 1.0 / 30)
            .map { try frame(t: $0, housing: housing, slot: 0) }
            + Array(repeating: try frame(t: DesktopIslandFluid.settle, housing: housing, slot: 0), count: 30)
        let gif = directory.appendingPathComponent("island-birth.gif")
        try CUCursorGallery.writeGIF(gifFrames, delay: 1.0 / 30, to: gif)
        out.append(gif)
        return out
    }

    /// - Parameter t: seconds into the birth.
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
            IslandFrameView(frame: DesktopIslandFluid(geometry: geometry).frame(at: t), geometry: geometry, model: model,
                            state: state)
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
