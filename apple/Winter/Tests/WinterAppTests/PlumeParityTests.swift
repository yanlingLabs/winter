import XCTest
import SwiftUI
import AppKit
@testable import Winter

/// The plume used to be a SwiftUI `Canvas` redrawn every frame; it is layers now (`PlumeLayerView`). This keeps the
/// Canvas, as it was, as a REFERENCE renderer and draws the same model frame both ways: a frozen `PlumeLayerView` must
/// match the reference closely (positions and sizes exactly — they come from the same pure layout — colours and the
/// glow within a small difference). Set `WINTER_PLUME_PARITY_DIR` to also write both renders as PNGs for a look.
@MainActor
final class PlumeParityTests: XCTestCase {
    /// The Canvas, verbatim from before the move to layers.
    private struct ReferencePlume: View {
        let model: WorkingAnimationModel
        var emitterInset: CGFloat?
        var palette: PlumePalette = .blue

        var body: some View {
            let model = self.model
            let emitterInset = self.emitterInset
            let palette = self.palette
            Canvas { context, size in
                let rect = CGRect(origin: .zero, size: size)
                let emitterX = size.width - (emitterInset ?? size.height / 2)
                let tailX = PropulsionPlume.tailX(height: size.height)
                let circles = model.plume.circles(in: rect, emitterX: emitterX, tailX: tailX)
                context.drawLayer { glow in
                    glow.addFilter(.blur(radius: size.height * 0.22))
                    glow.blendMode = .plusLighter
                    glow.opacity = 0.55
                    for circle in circles where !circle.spark {
                        glow.fill(Self.disc(circle, scale: 1.15), with: .color(Self.color(heat: circle.heat, palette)))
                    }
                }
                for circle in circles where !circle.spark {
                    context.fill(Self.disc(circle), with: .color(Self.color(heat: circle.heat, palette)))
                }
                for circle in circles where circle.spark {
                    context.fill(Self.disc(circle), with: .color(Self.color(heat: 1, palette).opacity(0.95)))
                }
                for tile in model.plume.tiles(in: rect, emitterX: emitterX, tailX: tailX) {
                    Self.draw(tile, palette: palette, in: &context)
                }
            }
        }

        private static func draw(_ tile: PlumeTile, palette: PlumePalette, in context: inout GraphicsContext) {
            let side = tile.side
            let disc = CGRect(x: tile.center.x - side / 2, y: tile.center.y - side / 2, width: side, height: side)
            context.fill(Path(ellipseIn: disc), with: .color(.white))
            switch tile.item.kind {
            case .tool(let symbol):
                drawSymbol(symbol, color: color(heat: 0, palette), in: disc.insetBy(dx: side * 0.25, dy: side * 0.25), context: &context)
            case .site:
                let inner = disc.insetBy(dx: side * 0.18, dy: side * 0.18)
                drawSymbol("globe", color: Color(white: 0.45), in: inner.insetBy(dx: side * 0.03, dy: side * 0.03), context: &context)
            }
        }

        private static func drawSymbol(_ symbol: String, color: Color, in box: CGRect, context: inout GraphicsContext) {
            var image = context.resolve(Image(systemName: symbol))
            image.shading = .color(color)
            let natural = image.size
            guard natural.width > 0, natural.height > 0 else { return }
            let scale = min(box.width / natural.width, box.height / natural.height)
            let size = CGSize(width: natural.width * scale, height: natural.height * scale)
            context.draw(image, in: CGRect(x: box.midX - size.width / 2, y: box.midY - size.height / 2, width: size.width, height: size.height))
        }

        private static func disc(_ circle: PlumeCircle, scale: CGFloat = 1) -> Path {
            let d = circle.diameter * scale
            return Path(ellipseIn: CGRect(x: circle.center.x - d / 2, y: circle.center.y - d / 2, width: d, height: d))
        }

        private static func color(heat: Double, _ palette: PlumePalette) -> Color {
            let c = plumeColorComponents(heat: heat, palette: palette)
            return Color(red: c.red, green: c.green, blue: c.blue)
        }
    }

    private let size = CGSize(width: 380, height: 44)

    private func bitmap<V: View>(_ view: V) throws -> NSBitmapImageRep {
        let host = NSHostingView(rootView: view.frame(width: size.width, height: size.height).background(Color.black).environment(\.colorScheme, .dark))
        host.frame = CGRect(origin: .zero, size: size)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: true)
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        withExtendedLifetime(window) {}
        return rep
    }

    /// A plume run forward 2 seconds with a few tools thrown, the way test11 stages it.
    private func stagedModel() -> (WorkingAnimationModel, [PlumeThrow]) {
        let thrown = [PlumeThrow(id: "1", kind: .tool(symbol: "terminal")),
                      PlumeThrow(id: "2", kind: .tool(symbol: "pencil")),
                      PlumeThrow(id: "3", kind: .site(host: "no-such-host.invalid")),
                      PlumeThrow(id: "4", kind: .tool(symbol: "doc.text"))]
        var model = WorkingAnimationModel(seed: 11)
        model.tick(dt: 1.0 / 60.0)
        for i in 0..<120 { model.tick(dt: 1.0 / 60.0, thrown: Array(thrown.prefix(1 + i / 20))) }
        return (model, thrown)
    }

    /// The mean absolute per-channel difference between two renders, 0…255, over the pixels either one lit.
    private func difference(_ a: NSBitmapImageRep, _ b: NSBitmapImageRep) -> (mean: Double, lit: Int) {
        XCTAssertEqual(a.pixelsWide, b.pixelsWide)
        XCTAssertEqual(a.pixelsHigh, b.pixelsHigh)
        var total = 0.0, lit = 0
        for y in 0..<a.pixelsHigh {
            for x in 0..<a.pixelsWide {
                guard let ca = a.colorAt(x: x, y: y)?.usingColorSpace(.sRGB), let cb = b.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                let brightest = max(ca.redComponent, ca.greenComponent, ca.blueComponent, cb.redComponent, cb.greenComponent, cb.blueComponent)
                guard brightest > 0.04 else { continue }
                lit += 1
                total += (abs(ca.redComponent - cb.redComponent) + abs(ca.greenComponent - cb.greenComponent) + abs(ca.blueComponent - cb.blueComponent)) / 3 * 255
            }
        }
        return (lit > 0 ? total / Double(lit) : 0, lit)
    }

    func testTheLayerPlumeLooksLikeTheCanvasItReplaced() throws {
        let (model, thrown) = stagedModel()
        let reference = try bitmap(ReferencePlume(model: model))
        let layers = try bitmap(WorkingAnimationView(thrown: thrown, repeating: thrown, initialModel: model))
        let (mean, lit) = difference(reference, layers)
        print(String(format: "PLUME parity: mean difference %.1f/255 over %d lit pixels", mean, lit))
        if let dir = ProcessInfo.processInfo.environment["WINTER_PLUME_PARITY_DIR"], !dir.isEmpty {
            let url = URL(fileURLWithPath: dir, isDirectory: true)
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            try XCTUnwrap(reference.representation(using: .png, properties: [:])).write(to: url.appendingPathComponent("plume-canvas.png"))
            try XCTUnwrap(layers.representation(using: .png, properties: [:])).write(to: url.appendingPathComponent("plume-layers.png"))
        }
        XCTAssertGreaterThan(lit, 2_000, "the plume filled a good part of the frame")
        XCTAssertLessThan(mean, 12, "the layer plume matches the Canvas it replaced (measured 6)")
    }
}
