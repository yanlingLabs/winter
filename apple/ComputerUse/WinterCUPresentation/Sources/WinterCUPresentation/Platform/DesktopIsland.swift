import AppKit
import SwiftUI

// The desktop-switch prompt drawn as an island (user ruling 2026-10-14): a black shape that hangs from the top of
// the screen — out of the camera housing on a screen that has one — springs open, and asks in one short line, with
// a blue button to allow. The words come from `CUDesktopPromptModel`; nothing here decides anything.

/// Where and how big the island is on one screen, in points.
struct DesktopIslandGeometry: Equatable {
    /// The open island (without the shadow margin).
    var size: CGSize
    /// The closed shape it springs out of: the camera housing, or a small tab under the top edge.
    var closed: CGSize
    /// The camera housing's height: the content starts below it (0 on a screen without one).
    var topInset: CGFloat
    /// Hangs from the top edge (square top corners). A second prompt sits below the first as a free-floating island.
    var attached: Bool

    static let width: CGFloat = 420
    static let cornerRadius: CGFloat = 26
    /// Room for the shadow around the island inside its panel.
    static let margin: CGFloat = 24
    static let gap: CGFloat = 10

    /// - Parameters:
    ///   - housing: the camera housing's size, nil on a screen without one.
    ///   - menuBarHeight: the top inset with no housing (the closed tab is this tall).
    ///   - contentHeight: the open island's content height, measured below `topInset`.
    static func make(housing: CGSize?, menuBarHeight: CGFloat, contentHeight: CGFloat, slot: Int) -> Self {
        if slot > 0 {
            return Self(size: CGSize(width: width, height: contentHeight), closed: CGSize(width: 180, height: 36),
                        topInset: 0, attached: false)
        }
        if let housing, housing.width > 0, housing.height > 0 {
            return Self(size: CGSize(width: max(width, housing.width + 120), height: housing.height + contentHeight),
                        closed: housing, topInset: housing.height, attached: true)
        }
        let bar = max(menuBarHeight, 22)
        return Self(size: CGSize(width: width, height: bar + contentHeight), closed: CGSize(width: 190, height: bar),
                    topInset: bar, attached: true)
    }
}

/// The island's live state: the surface writes it, the view draws it.
@MainActor final class DesktopIslandState: ObservableObject {
    @Published var open = false
    @Published var secondsLeft: Int
    @Published var fraction: Double
    var onSwitch: (() -> Void)?
    var onRefuse: (() -> Void)?

    init(secondsLeft: Int, fraction: Double) {
        self.secondsLeft = secondsLeft
        self.fraction = fraction
    }
}

struct DesktopIslandView: View {
    let model: CUDesktopPromptModel
    let geometry: DesktopIslandGeometry
    let icon: NSImage?
    @ObservedObject var state: DesktopIslandState
    var reduceMotion = false

    static let blue = Color(red: 0.04, green: 0.52, blue: 1.0)

    var body: some View {
        let open = state.open
        let size = open ? geometry.size : geometry.closed
        let radius = open ? DesktopIslandGeometry.cornerRadius : min(geometry.closed.height / 2, 12)
        ZStack(alignment: .top) {
            shape(radius)
                .fill(Color.black)
                .shadow(color: .black.opacity(open ? 0.35 : 0), radius: 14, y: 6)
            // Laid out at the open size always, and clipped to the shape as it grows: nothing reflows mid-spring.
            DesktopIslandContent(model: model, icon: icon, state: state)
                .padding(.top, geometry.topInset)
                .frame(width: geometry.size.width, height: geometry.size.height, alignment: .top)
                .opacity(open ? 1 : 0)
                .blur(radius: open || reduceMotion ? 0 : 8)
                .scaleEffect(open || reduceMotion ? 1 : 0.92, anchor: .top)
                .frame(width: size.width, height: size.height, alignment: .top)
                .clipShape(shape(radius))
        }
        .frame(width: size.width, height: size.height, alignment: .top)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .padding(.top, geometry.attached ? 0 : DesktopIslandGeometry.margin)
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.45, dampingFraction: 0.76), value: open)
        .environment(\.colorScheme, .dark)
    }

    /// Square top corners when it hangs from the top edge; round all round when it floats.
    private func shape(_ radius: CGFloat) -> UnevenRoundedRectangle {
        let top = geometry.attached ? 0 : radius
        return UnevenRoundedRectangle(cornerRadii: .init(topLeading: top, bottomLeading: radius,
                                                         bottomTrailing: radius, topTrailing: top),
                                      style: .continuous)
    }
}

/// What the open island says: the line, the app (name + bundle id), the model's reason, the countdown and the two
/// answers.
struct DesktopIslandContent: View {
    let model: CUDesktopPromptModel
    let icon: NSImage?
    @ObservedObject var state: DesktopIslandState

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 12) {
                appIcon
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.headline)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.white)
                    HStack(spacing: 5) {
                        Text(model.appName)
                            .foregroundStyle(.white.opacity(0.72))
                        if !model.bundleId.isEmpty {
                            Text(model.bundleId)
                                .foregroundStyle(.white.opacity(0.38))
                                .truncationMode(.middle)
                        }
                    }
                    .font(.system(size: 11.5))
                    .lineLimit(1)
                }
                Spacer(minLength: 8)
                CountdownRing(fraction: state.fraction, seconds: state.secondsLeft)
            }
            if !model.reason.isEmpty {
                Text(model.reason)
                    .font(.system(size: 11.5))
                    .foregroundStyle(.white.opacity(0.5))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 8) {
                Text(model.backLine)
                    .font(.system(size: 11))
                    .foregroundStyle(.white.opacity(0.4))
                    .lineLimit(1)
                Spacer(minLength: 8)
                Button("Not now") { state.onRefuse?() }
                    .buttonStyle(IslandButtonStyle(fill: .white.opacity(0.14), weight: .medium))
                Button("Allow") { state.onSwitch?() }
                    .buttonStyle(IslandButtonStyle(fill: DesktopIslandView.blue, weight: .semibold))
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(.horizontal, 18)
        .padding(.top, 12)
        .padding(.bottom, 16)
    }

    @ViewBuilder private var appIcon: some View {
        if let icon {
            Image(nsImage: icon)
                .resizable()
                .interpolation(.high)
                .frame(width: 34, height: 34)
        } else {
            Image(systemName: "macwindow")
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(.white.opacity(0.8))
                .frame(width: 34, height: 34)
                .background(Circle().fill(.white.opacity(0.12)))
        }
    }
}

/// Time left as a ring that empties, with the seconds inside.
struct CountdownRing: View {
    let fraction: Double
    let seconds: Int

    var body: some View {
        ZStack {
            Circle().stroke(.white.opacity(0.15), lineWidth: 2.5)
            Circle()
                .trim(from: 0, to: fraction)
                .stroke(.white.opacity(0.85), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.linear(duration: CUDesktopPromptController.tickInterval), value: fraction)
            Text("\(seconds)")
                .font(.system(size: 10, weight: .semibold).monospacedDigit())
                .foregroundStyle(.white.opacity(0.85))
        }
        .frame(width: 28, height: 28)
        .accessibilityLabel("Switching in \(seconds) seconds")
    }
}

struct IslandButtonStyle: ButtonStyle {
    let fill: Color
    let weight: Font.Weight

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12.5, weight: weight))
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
            .background(Capsule().fill(fill))
            .opacity(configuration.isPressed ? 0.7 : 1)
            .contentShape(Capsule())
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
        let reason = "The file chooser is not responding to Go to folder in the background; verify and finish "
            + "selecting the requested ZIP."
        let cases: [(name: String, reason: String, housing: CGSize?, slot: Int, open: Bool)] = [
            ("housing-open", reason, CGSize(width: 185, height: 32), 0, true),
            ("housing-open-no-reason", "", CGSize(width: 185, height: 32), 0, true),
            ("housing-closed", reason, CGSize(width: 185, height: 32), 0, false),
            ("no-housing-open", reason, nil, 0, true),
            ("no-housing-closed", reason, nil, 0, false),
            ("second-open", reason, nil, 1, true),
        ]
        var out: [URL] = []
        for c in cases {
            let request = CUDesktopPromptRequest(promptId: c.name, sessionId: "s", app: "Google Chrome",
                                                 bundleId: "com.google.Chrome", reason: c.reason, timeoutMs: 60_000)
            let model = CUDesktopPromptModel(request, now: 0)
            let state = DesktopIslandState(secondsLeft: model.secondsLeft(now: 17), fraction: model.fractionLeft(now: 17))
            state.open = c.open
            let icon = AppKitDesktopPrompt.icon(bundleId: model.bundleId)
            let measure = NSHostingView(rootView: DesktopIslandContent(model: model, icon: icon, state: state)
                .frame(width: DesktopIslandGeometry.width))
            let geometry = DesktopIslandGeometry.make(housing: c.housing, menuBarHeight: 24,
                                                      contentHeight: ceil(measure.fittingSize.height), slot: c.slot)
            let m = DesktopIslandGeometry.margin
            let canvas = CGSize(width: geometry.size.width + 2 * m + 120,
                                height: geometry.size.height + 2 * m + (c.slot > 0 ? 60 : 0))
            let scene = ZStack(alignment: .top) {
                LinearGradient(colors: [Color(red: 0.55, green: 0.66, blue: 0.82), Color(red: 0.86, green: 0.83, blue: 0.9)],
                               startPoint: .top, endPoint: .bottom)
                // The menu bar strip the island hangs over.
                Rectangle().fill(.white.opacity(0.35)).frame(height: c.housing?.height ?? 24)
                DesktopIslandView(model: model, geometry: geometry, icon: icon, state: state)
                    .frame(width: geometry.size.width + 2 * m,
                           height: geometry.size.height + m + (geometry.attached ? 0 : m))
                    .padding(.top, c.slot > 0 ? 60 : 0)
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
