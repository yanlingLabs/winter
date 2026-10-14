import AppKit
import SwiftUI

// The desktop-switch prompt drawn as an island (user ruling 2026-10-14): a black shape that grows out of the top
// edge of the screen — out of the camera housing on a screen that has one, its top corners curving into the edge —
// springs open, and asks in one short line, with a red ✕ and a blue ✓. The words come from `CUDesktopPromptModel`;
// nothing here decides anything. (The session card in Winter names the app and the reason.)

/// Where and how big the island is on one screen, in points.
struct DesktopIslandGeometry: Equatable {
    /// The open island's body (without its ears and the shadow margin).
    var size: CGSize
    /// The closed body it springs out of: the camera housing, or a small tab under the top edge.
    var closed: CGSize
    /// The camera housing's height: the content sits below it (0 on a screen without one).
    var topInset: CGFloat
    /// Grows out of the top edge, its top corners curving into it. A second prompt floats below the first instead.
    var attached: Bool

    static let width: CGFloat = 360
    /// The open island's content row, below `topInset`.
    static let rowHeight: CGFloat = 50
    static let cornerRadius: CGFloat = 22
    static let closedCornerRadius: CGFloat = 10
    /// The concave curve on each side where the island meets the top edge.
    static let ear: CGFloat = 10
    /// Room for the ears and the shadow around the island inside its panel.
    static let margin: CGFloat = 24
    static let gap: CGFloat = 10

    /// - Parameters:
    ///   - housing: the camera housing's size, nil on a screen without one.
    ///   - menuBarHeight: the top inset with no housing (the closed tab is this tall).
    static func make(housing: CGSize?, menuBarHeight: CGFloat, slot: Int) -> Self {
        if slot > 0 {
            return Self(size: CGSize(width: width, height: rowHeight), closed: CGSize(width: 160, height: 36),
                        topInset: 0, attached: false)
        }
        if let housing, housing.width > 0, housing.height > 0 {
            return Self(size: CGSize(width: max(width, housing.width + 150), height: housing.height + rowHeight),
                        closed: housing, topInset: housing.height, attached: true)
        }
        let bar = max(menuBarHeight, 22)
        return Self(size: CGSize(width: width, height: bar + rowHeight), closed: CGSize(width: 180, height: bar),
                    topInset: bar, attached: true)
    }
}

/// The island's live state: the surface writes it, the view draws it.
@MainActor final class DesktopIslandState: ObservableObject {
    @Published var open = false
    @Published var secondsLeft: Int
    var onSwitch: (() -> Void)?
    var onRefuse: (() -> Void)?

    init(secondsLeft: Int) { self.secondsLeft = secondsLeft }
}

/// The island's outline: a body with round bottom corners and, when it hangs from the top edge, a concave curve
/// (an "ear") on each side flowing into that edge, the way the camera housing meets the screen's border.
struct IslandShape: Shape {
    var bottomRadius: CGFloat
    var ear: CGFloat
    /// Round top corners too (a floating island) instead of ears.
    var floating: Bool

    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(bottomRadius, ear) }
        set { (bottomRadius, ear) = (newValue.first, newValue.second) }
    }

    func path(in rect: CGRect) -> Path {
        var p = Path()
        if floating {
            p.addRoundedRect(in: rect, cornerSize: CGSize(width: bottomRadius, height: bottomRadius), style: .continuous)
            return p
        }
        let e = min(ear, rect.width / 4, rect.height / 2)
        let r = min(bottomRadius, (rect.width - 2 * e) / 2, rect.height - e)
        let left = rect.minX + e, right = rect.maxX - e
        p.move(to: CGPoint(x: rect.minX, y: rect.minY))
        p.addQuadCurve(to: CGPoint(x: left, y: rect.minY + e), control: CGPoint(x: left, y: rect.minY))
        p.addLine(to: CGPoint(x: left, y: rect.maxY - r))
        p.addQuadCurve(to: CGPoint(x: left + r, y: rect.maxY), control: CGPoint(x: left, y: rect.maxY))
        p.addLine(to: CGPoint(x: right - r, y: rect.maxY))
        p.addQuadCurve(to: CGPoint(x: right, y: rect.maxY - r), control: CGPoint(x: right, y: rect.maxY))
        p.addLine(to: CGPoint(x: right, y: rect.minY + e))
        p.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY), control: CGPoint(x: right, y: rect.minY))
        p.closeSubpath()
        return p
    }
}

struct DesktopIslandView: View {
    let model: CUDesktopPromptModel
    let geometry: DesktopIslandGeometry
    @ObservedObject var state: DesktopIslandState
    var reduceMotion = false

    var body: some View {
        let open = state.open
        let body = open ? geometry.size : geometry.closed
        // Closed, it is the housing itself; the ears grow as it opens.
        let ears = geometry.attached && open ? DesktopIslandGeometry.ear : 0
        let shape = IslandShape(bottomRadius: open ? DesktopIslandGeometry.cornerRadius
                                    : (geometry.attached ? DesktopIslandGeometry.closedCornerRadius : geometry.closed.height / 2),
                                ear: ears, floating: !geometry.attached)
        ZStack(alignment: .top) {
            shape
                .fill(Color.black)
                .shadow(color: .black.opacity(open ? 0.3 : 0), radius: 12, y: 5)
            // Laid out at the open size always, and clipped to the shape as it grows: nothing reflows mid-spring.
            DesktopIslandRow(model: model, state: state)
                .padding(.top, geometry.topInset)
                .frame(width: geometry.size.width, height: geometry.size.height, alignment: .top)
                .opacity(open ? 1 : 0)
                .blur(radius: open || reduceMotion ? 0 : 6)
                .scaleEffect(open || reduceMotion ? 1 : 0.94, anchor: .top)
                .frame(width: body.width + 2 * ears, height: body.height, alignment: .top)
                .clipShape(shape)
        }
        .frame(width: body.width + 2 * ears, height: body.height, alignment: .top)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .padding(.top, geometry.attached ? 0 : DesktopIslandGeometry.margin)
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.42, dampingFraction: 0.8), value: open)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(model.title) Switching in \(state.secondsLeft) seconds.")
    }
}

/// The open island's one row: the line, then ✕ (don't switch) and ✓ (switch now).
struct DesktopIslandRow: View {
    let model: CUDesktopPromptModel
    @ObservedObject var state: DesktopIslandState

    static let red = Color(red: 1.0, green: 0.27, blue: 0.23)
    static let blue = Color(red: 0.04, green: 0.52, blue: 1.0)

    var body: some View {
        HStack(spacing: 10) {
            Text(model.headline)
                .font(.system(size: 13.5, weight: .semibold))
                .foregroundStyle(.white)
                .lineLimit(1)
            Spacer(minLength: 12)
            Button { state.onRefuse?() } label: { Image(systemName: "xmark") }
                .buttonStyle(IslandCircleButtonStyle(fill: Self.red))
                .accessibilityLabel("Don't switch")
            Button { state.onSwitch?() } label: { Image(systemName: "checkmark") }
                .buttonStyle(IslandCircleButtonStyle(fill: Self.blue))
                .accessibilityLabel("Switch now")
        }
        .padding(.leading, 22)
        .padding(.trailing, 14)
        .frame(height: DesktopIslandGeometry.rowHeight)
    }
}

struct IslandCircleButtonStyle: ButtonStyle {
    let fill: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(.white)
            .frame(width: 30, height: 30)
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

/// The island rendered OFFSCREEN to PNG files (no window, nothing on screen), for looking at it without a prompt.
public enum CUDesktopIslandGallery {
    /// Writes one PNG per case into `directory` (created if needed) and returns them.
    @MainActor public static func render(to directory: URL) throws -> [URL] {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let cases: [(name: String, housing: CGSize?, slot: Int, open: Bool)] = [
            ("housing-open", CGSize(width: 185, height: 32), 0, true),
            ("housing-closed", CGSize(width: 185, height: 32), 0, false),
            ("no-housing-open", nil, 0, true),
            ("second-open", nil, 1, true),
        ]
        var out: [URL] = []
        for c in cases {
            let request = CUDesktopPromptRequest(promptId: c.name, sessionId: "s", app: "Google Chrome",
                                                 bundleId: "com.google.Chrome", reason: "", timeoutMs: 60_000)
            let model = CUDesktopPromptModel(request, now: 0)
            let state = DesktopIslandState(secondsLeft: 43)
            state.open = c.open
            let geometry = DesktopIslandGeometry.make(housing: c.housing, menuBarHeight: 24, slot: c.slot)
            let m = DesktopIslandGeometry.margin
            let bar = c.housing?.height ?? 24
            let canvas = CGSize(width: geometry.size.width + 2 * m + 200, height: geometry.size.height + 2 * m + 40)
            let scene = ZStack(alignment: .top) {
                LinearGradient(colors: [Color(red: 0.55, green: 0.66, blue: 0.82), Color(red: 0.86, green: 0.83, blue: 0.9)],
                               startPoint: .top, endPoint: .bottom)
                // The menu bar strip the island hangs over.
                Rectangle().fill(.white.opacity(0.35)).frame(height: bar)
                DesktopIslandView(model: model, geometry: geometry, state: state)
                    .frame(width: geometry.size.width + 2 * m,
                           height: geometry.size.height + m + (geometry.attached ? 0 : m))
                    .padding(.top, c.slot > 0 ? bar + 30 : 0)
            }
            .frame(width: canvas.width, height: canvas.height)
            let renderer = ImageRenderer(content: scene)
            renderer.scale = 2
            guard let image = renderer.cgImage else { throw CUCursorGallery.GalleryError.cannotCreateContext }
            let url = directory.appendingPathComponent("island-\(c.name)@2x.png")
            try CUCursorGallery.writePNG(image, to: url)
            out.append(url)
        }
        return out
    }
}
