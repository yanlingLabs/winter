import SwiftUI

/// The live mirror inside Winter.app's window: a black rounded panel with a faint white rim, the window's live image
/// (aspect-fit), the agent cursor drawn over it with the same rig as the on-screen overlay (at the mirror's size), and
/// the app's name underneath. A calm placeholder (Winter's twelve rays, still) shows until the first frame. The panel
/// takes the width its container gives it and keeps the window's shape. Draws nothing once the model is cleared.
public struct CUMirrorView: View {
    @ObservedObject private var model: CUMirrorModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.displayScale) private var displayScale

    public init(model: CUMirrorModel) {
        self.model = model
    }

    public var body: some View {
        if model.isActive {
            panel
                .onAppear(perform: syncAccessibility)
                .onChange(of: reduceMotion) { _, _ in syncAccessibility() }
                .onChange(of: contrast) { _, _ in syncAccessibility() }
        }
    }

    private var panel: some View {
        VStack(spacing: 0) {
            TimelineView(.animation(minimumInterval: model.cursorNeed == .low ? 1.0 / 20 : 1.0 / 60,
                                    paused: model.cursorNeed == .none)) { _ in
                Canvas { context, size in draw(&context, size: size) }
            }
            .aspectRatio(aspect, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            Text(model.appName ?? "")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Color.white.opacity(contrast == .increased ? 0.9 : 0.62))
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity)
                .frame(height: 20)
        }
        .padding(.horizontal, 3)
        .padding(.top, 3)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.black.opacity(0.92)))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(Color.white.opacity(contrast == .increased ? 0.4 : 0.14), lineWidth: 1))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Live view of \(model.appName ?? "the app")"))
    }

    /// The window's shape (or the frame's, or 16:10 before either is known).
    private var aspect: CGFloat {
        let size = model.windowSize.width > 0 ? model.windowSize : (model.imageSize ?? CGSize(width: 16, height: 10))
        return size.height > 0 ? size.width / size.height : 1.6
    }

    private func draw(_ context: inout GraphicsContext, size: CGSize) {
        let content = CGRect(origin: .zero, size: size)
        context.fill(Path(content), with: .color(Color(white: 0.08)))
        if let image = model.image {
            let rect = MirrorGeometry.imageRect(content: content, imageSize: model.imageSize, windowSize: model.windowSize)
            context.draw(Image(decorative: image, scale: 1), in: rect)
        } else {
            drawPlaceholder(&context, in: content)
        }
        let scale = displayScale
        context.withCGContext { cg in
            MainActor.assumeIsolated { model.renderCursor(into: cg, size: size, scale: scale) }
        }
    }

    /// Twelve faint rays, still: Winter's mark, waiting for the first frame.
    private func drawPlaceholder(_ context: inout GraphicsContext, in rect: CGRect) {
        let c = CGPoint(x: rect.midX, y: rect.midY)
        let r = min(rect.width, rect.height)
        let inner = r * 0.045, outer = r * 0.11
        var rays = Path()
        for i in 0..<12 {
            let a = CGFloat(i) / 12 * 2 * .pi - .pi / 2
            rays.move(to: CGPoint(x: c.x + cos(a) * inner, y: c.y + sin(a) * inner))
            rays.addLine(to: CGPoint(x: c.x + cos(a) * outer, y: c.y + sin(a) * outer))
        }
        context.stroke(rays, with: .color(Color.white.opacity(0.22)),
                       style: StrokeStyle(lineWidth: max(1.2, r * 0.012), lineCap: .round))
    }

    private func syncAccessibility() {
        model.reduceMotion = reduceMotion
        model.increaseContrast = contrast == .increased
    }
}
