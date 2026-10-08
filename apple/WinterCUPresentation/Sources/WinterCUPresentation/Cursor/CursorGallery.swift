import AppKit
import CoreText
import ImageIO
import UniformTypeIdentifiers

/// Renders every cursor state to files, offscreen: no window, no overlay, no capture. Each state is a small scene (a
/// mock window with a text field and a button) played through the real `CursorTimeline` and drawn by the real
/// `CursorRig` into a bitmap, so the gallery shows exactly what the overlay and the mirror draw.
///
/// Output, per scene: stills on light and dark at 1x and 2x, and a GIF at 2x on each; plus one contact sheet with every
/// state on light, dark, Reduce Motion and Increase Contrast, and the mirror-sized cursor.
public enum CUCursorGallery {
    public struct Output: Sendable {
        public var stills: [URL]
        public var gifs: [URL]
        public var contactSheet: URL
        /// Every state at 4x, cropped around the cursor, on light and dark: the detail view.
        public var closeUps: URL
    }

    public enum GalleryError: Error, CustomStringConvertible {
        case cannotCreateContext
        case cannotWrite(URL)

        public var description: String {
            switch self {
            case .cannotCreateContext: return "could not create a bitmap context"
            case .cannotWrite(let url): return "could not write \(url.path)"
            }
        }
    }

    /// Renders the whole gallery into `directory` (created if needed). `gifs: false` skips the animations (faster).
    @MainActor public static func render(to directory: URL, gifs: Bool = true) throws -> Output {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var stills: [URL] = []
        var gifURLs: [URL] = []
        for scene in GalleryScene.all {
            for appearance in GalleryAppearance.allCases {
                for scale in [1, 2] as [CGFloat] {
                    let image = try renderImage(scene, at: scene.stillTime, appearance: appearance, scale: scale)
                    let url = directory.appendingPathComponent("\(scene.name)-\(appearance.rawValue)@\(Int(scale))x.png")
                    try writePNG(image, to: url)
                    stills.append(url)
                }
                if gifs {
                    let frames = try stride(from: scene.gifRange.lowerBound, to: scene.gifRange.upperBound, by: 1.0 / 30)
                        .map { try renderImage(scene, at: $0, appearance: appearance, scale: 2) }
                    let url = directory.appendingPathComponent("\(scene.name)-\(appearance.rawValue).gif")
                    try writeGIF(frames, delay: 1.0 / 30, to: url)
                    gifURLs.append(url)
                }
            }
        }
        let sheet = directory.appendingPathComponent("contact-sheet.png")
        try writePNG(try contactSheet(), to: sheet)
        let closeUps = directory.appendingPathComponent("cursor-closeups.png")
        try writePNG(try closeUpSheet(), to: closeUps)
        return Output(stills: stills, gifs: gifURLs, contactSheet: sheet, closeUps: closeUps)
    }

    // MARK: - Rendering

    struct Variant {
        var style = CursorStyle()
        var reduceMotion = false
        /// Draw the scene the size of the mirror's live image, with the mirror's smaller cursor.
        var mirror = false
    }

    static let canvas = CGSize(width: 260, height: 170)
    static let mirrorScale: CGFloat = 0.62

    @MainActor static func renderImage(_ scene: GalleryScene, at t: TimeInterval, appearance: GalleryAppearance,
                                       scale: CGFloat, variant: Variant = Variant()) throws -> CGImage {
        let k = variant.mirror ? mirrorScale : 1
        let size = CGSize(width: canvas.width * k, height: canvas.height * k)
        guard let ctx = CGContext(data: nil, width: Int(size.width * scale), height: Int(size.height * scale),
                                  bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { throw GalleryError.cannotCreateContext }

        // The mock window, drawn top-left.
        ctx.saveGState()
        ctx.translateBy(x: 0, y: size.height * scale)
        ctx.scaleBy(x: scale * k, y: -scale * k)
        drawBackground(ctx, appearance: appearance)
        ctx.restoreGState()

        // The cursor, through the real timeline and rig.
        var timeline = CursorTimeline(options: .init(reduceMotion: variant.reduceMotion))
        for event in scene.events { timeline.receive(event.kind, at: event.point, now: event.time) }
        var mapping = CursorRig.Mapping()
        if variant.mirror {
            mapping.point = { CGPoint(x: $0.x * k, y: $0.y * k) }
            mapping.sizeScale = mirrorScale
            mapping.showsCaption = false
        }
        let rig = CursorRig(style: variant.style, mapping: mapping)
        rig.contentsScale = scale
        rig.uprightTextInFlippedContext = true
        rig.root.frame = CGRect(origin: .zero, size: size)
        let frame = timeline.frame(at: t)
        rig.apply(frame)
        // `render(in:)` ignores geometry flipping, so flip the context instead: the rig's top-left space lands upright.
        ctx.saveGState()
        ctx.translateBy(x: 0, y: size.height * scale)
        ctx.scaleBy(x: scale, y: -scale)
        rig.root.render(in: ctx)
        // In the foreground the overlay draws no arrow: the system's own pointer is there. Stand one in for the picture.
        if let halo = frame.foreground, halo.opacity > 0.5 {
            drawSystemPointer(ctx, at: mapping.point(halo.center), scale: mapping.sizeScale)
        }
        ctx.restoreGState()

        guard let image = ctx.makeImage() else { throw GalleryError.cannotCreateContext }
        return image
    }

    /// A small window: a title strip, a text field, a few lines of text, a "Save" button, and a band of ice blue so the
    /// cursor is also seen over a mid tone. Colours are the brand's own (CardSurface, Hairline, ElevatedSurface, …).
    static func drawBackground(_ ctx: CGContext, appearance: GalleryAppearance) {
        let p = appearance.palette
        ctx.setFillColor(p.canvas)
        ctx.fill(CGRect(origin: .zero, size: canvas))
        let window = CGRect(x: 8, y: 8, width: canvas.width - 16, height: canvas.height - 16)
        ctx.addPath(CGPath(roundedRect: window, cornerWidth: 10, cornerHeight: 10, transform: nil))
        ctx.setFillColor(p.card)
        ctx.fillPath()
        ctx.addPath(CGPath(roundedRect: window.insetBy(dx: 0.5, dy: 0.5), cornerWidth: 10, cornerHeight: 10, transform: nil))
        ctx.setStrokeColor(p.hairline)
        ctx.setLineWidth(1)
        ctx.strokePath()
        // Traffic lights.
        for (i, color) in [CGColor(srgbRed: 1, green: 0.37, blue: 0.34, alpha: 1),
                           CGColor(srgbRed: 1, green: 0.74, blue: 0.18, alpha: 1),
                           CGColor(srgbRed: 0.16, green: 0.79, blue: 0.25, alpha: 1)].enumerated() {
            ctx.setFillColor(color)
            ctx.fillEllipse(in: CGRect(x: 18 + CGFloat(i) * 15, y: 16, width: 9, height: 9))
        }
        // A mid-tone band (an image strip, say) on the right.
        ctx.setFillColor(CGColor(srgbRed: 140 / 255, green: 203 / 255, blue: 240 / 255, alpha: appearance == .dark ? 0.35 : 0.55))
        ctx.fill(CGRect(x: 200, y: 32, width: 44, height: 56))
        // The text field.
        let field = GalleryScene.field
        ctx.addPath(CGPath(roundedRect: field, cornerWidth: 6, cornerHeight: 6, transform: nil))
        ctx.setFillColor(p.elevated)
        ctx.fillPath()
        ctx.addPath(CGPath(roundedRect: field.insetBy(dx: 0.5, dy: 0.5), cornerWidth: 6, cornerHeight: 6, transform: nil))
        ctx.setStrokeColor(p.hairlineElevated)
        ctx.strokePath()
        drawText(ctx, "Groceries", at: CGPoint(x: field.minX + 8, y: field.midY + 4), size: 11, color: p.text)
        // Lines of text.
        for (i, width) in [150.0, 120.0, 136.0].enumerated() {
            ctx.setFillColor(p.muted)
            ctx.fill(CGRect(x: 30, y: 98 + CGFloat(i) * 12, width: CGFloat(width) * 0.62, height: 4))
        }
        // The button.
        let button = GalleryScene.button
        ctx.addPath(CGPath(roundedRect: button, cornerWidth: 7, cornerHeight: 7, transform: nil))
        ctx.setFillColor(p.inverse)
        ctx.fillPath()
        drawText(ctx, "Save", at: CGPoint(x: button.midX - 13, y: button.midY + 4), size: 12, color: p.inverseText)
    }

    /// A plain stand-in for the system pointer (the gallery has no real mouse): white with a black outline.
    static func drawSystemPointer(_ ctx: CGContext, at tip: CGPoint, scale s: CGFloat) {
        let points: [CGPoint] = [(0, 0), (0, 17), (4, 13.2), (6.8, 19.4), (9.4, 18.2), (6.7, 12.2), (12, 12.2)]
            .map { CGPoint(x: tip.x + $0.0 * s, y: tip.y + $0.1 * s) }
        ctx.saveGState()
        ctx.beginPath()
        ctx.addLines(between: points)
        ctx.closePath()
        ctx.setFillColor(CGColor(gray: 1, alpha: 1))
        ctx.setStrokeColor(CGColor(gray: 0, alpha: 1))
        ctx.setLineWidth(1.2 * s)
        ctx.setLineJoin(.round)
        ctx.drawPath(using: .fillStroke)
        ctx.restoreGState()
    }

    static func drawText(_ ctx: CGContext, _ text: String, at baseline: CGPoint, size: CGFloat, color: CGColor) {
        let font = CTFontCreateUIFontForLanguage(.system, size, nil) ?? CTFontCreateWithName("Helvetica" as CFString, size, nil)
        let attributed = NSAttributedString(string: text, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): color,
        ])
        let line = CTLineCreateWithAttributedString(attributed)
        ctx.saveGState()
        ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
        ctx.textPosition = baseline
        CTLineDraw(line, ctx)
        ctx.restoreGState()
    }

    // MARK: - Contact sheet

    @MainActor static func contactSheet() throws -> CGImage {
        let columns: [(String, GalleryAppearance, Variant)] = [
            ("Light", .light, Variant()),
            ("Dark", .dark, Variant()),
            ("Reduce Motion", .light, Variant(reduceMotion: true)),
            ("Increase Contrast", .dark, Variant(style: CursorStyle(increaseContrast: true))),
        ]
        let scale: CGFloat = 2
        let labelWidth: CGFloat = 120, header: CGFloat = 34, gap: CGFloat = 10
        let cell = canvas
        let rows = GalleryScene.all.count + 1 // + the mirror row
        let width = labelWidth + CGFloat(columns.count) * (cell.width + gap) + gap
        let height = header + CGFloat(rows) * (cell.height + gap) + gap
        guard let ctx = CGContext(data: nil, width: Int(width * scale), height: Int(height * scale), bitsPerComponent: 8,
                                  bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { throw GalleryError.cannotCreateContext }
        ctx.translateBy(x: 0, y: height * scale)
        ctx.scaleBy(x: scale, y: -scale)
        ctx.setFillColor(CGColor(srgbRed: 0.93, green: 0.93, blue: 0.94, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let ink = CGColor(srgbRed: 0.1, green: 0.11, blue: 0.12, alpha: 1)
        for (i, column) in columns.enumerated() {
            drawText(ctx, column.0, at: CGPoint(x: labelWidth + gap + CGFloat(i) * (cell.width + gap), y: 22), size: 13, color: ink)
        }
        func place(_ image: CGImage, row: Int, column: Int, size: CGSize) {
            let x = labelWidth + gap + CGFloat(column) * (cell.width + gap)
            let y = header + CGFloat(row) * (cell.height + gap)
            ctx.saveGState()
            // Undo the flip for the image so it lands upright.
            ctx.translateBy(x: x, y: y + size.height)
            ctx.scaleBy(x: 1, y: -1)
            ctx.draw(image, in: CGRect(origin: .zero, size: size))
            ctx.restoreGState()
        }
        for (row, scene) in GalleryScene.all.enumerated() {
            drawText(ctx, scene.title, at: CGPoint(x: 12, y: header + CGFloat(row) * (cell.height + gap) + cell.height / 2 + 4),
                     size: 12, color: ink)
            for (column, spec) in columns.enumerated() {
                let image = try renderImage(scene, at: scene.stillTime, appearance: spec.1, scale: scale, variant: spec.2)
                place(image, row: row, column: column, size: cell)
            }
        }
        // The mirror row: the press scene at the mirror's size.
        let mirrorRow = GalleryScene.all.count
        drawText(ctx, "In the mirror", at: CGPoint(x: 12, y: header + CGFloat(mirrorRow) * (cell.height + gap) + cell.height / 2 + 4),
                 size: 12, color: ink)
        let press = GalleryScene.all.first { $0.name.hasSuffix("press") } ?? GalleryScene.all[0]
        for (column, spec) in columns.enumerated() {
            var variant = spec.2
            variant.mirror = true
            let image = try renderImage(press, at: press.stillTime, appearance: spec.1, scale: scale, variant: variant)
            place(image, row: mirrorRow, column: column, size: CGSize(width: cell.width * mirrorScale, height: cell.height * mirrorScale))
        }
        guard let image = ctx.makeImage() else { throw GalleryError.cannotCreateContext }
        return image
    }

    // MARK: - Close-ups

    /// Every state at 4x on light and dark, cropped to the neighbourhood of the cursor.
    @MainActor static func closeUpSheet() throws -> CGImage {
        let scale: CGFloat = 4
        let crop = CGSize(width: 150, height: 96)
        let labelWidth: CGFloat = 120, header: CGFloat = 30, gap: CGFloat = 8
        let appearances = GalleryAppearance.allCases
        let rows = GalleryScene.all.count
        let width = labelWidth + CGFloat(appearances.count) * (crop.width + gap) + gap
        let height = header + CGFloat(rows) * (crop.height + gap) + gap
        guard let ctx = CGContext(data: nil, width: Int(width * scale), height: Int(height * scale), bitsPerComponent: 8,
                                  bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { throw GalleryError.cannotCreateContext }
        ctx.translateBy(x: 0, y: height * scale)
        ctx.scaleBy(x: scale, y: -scale)
        ctx.setFillColor(CGColor(srgbRed: 0.93, green: 0.93, blue: 0.94, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let ink = CGColor(srgbRed: 0.1, green: 0.11, blue: 0.12, alpha: 1)
        for (i, appearance) in appearances.enumerated() {
            drawText(ctx, appearance.rawValue.capitalized + " · 4x",
                     at: CGPoint(x: labelWidth + gap + CGFloat(i) * (crop.width + gap), y: 20), size: 11, color: ink)
        }
        for (row, scene) in GalleryScene.all.enumerated() {
            let y = header + CGFloat(row) * (crop.height + gap)
            drawText(ctx, scene.title, at: CGPoint(x: 10, y: y + crop.height / 2 + 4), size: 11, color: ink)
            var timeline = CursorTimeline()
            for event in scene.events { timeline.receive(event.kind, at: event.point, now: event.time) }
            let tip = timeline.frame(at: scene.stillTime).tip
            let origin = CGPoint(x: min(max(tip.x - 50, 0), canvas.width - crop.width),
                                 y: min(max(tip.y - 34, 0), canvas.height - crop.height))
            for (column, appearance) in appearances.enumerated() {
                let full = try renderImage(scene, at: scene.stillTime, appearance: appearance, scale: scale)
                let pixels = CGRect(x: origin.x * scale, y: origin.y * scale, width: crop.width * scale, height: crop.height * scale)
                guard let part = full.cropping(to: pixels) else { continue }
                let x = labelWidth + gap + CGFloat(column) * (crop.width + gap)
                ctx.saveGState()
                ctx.translateBy(x: x, y: y + crop.height)
                ctx.scaleBy(x: 1, y: -1)
                ctx.draw(part, in: CGRect(origin: .zero, size: crop))
                ctx.restoreGState()
            }
        }
        guard let image = ctx.makeImage() else { throw GalleryError.cannotCreateContext }
        return image
    }

    // MARK: - Files

    static func writePNG(_ image: CGImage, to url: URL) throws {
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            throw GalleryError.cannotWrite(url)
        }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else { throw GalleryError.cannotWrite(url) }
    }

    static func writeGIF(_ frames: [CGImage], delay: Double, to url: URL) throws {
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.gif.identifier as CFString, frames.count, nil) else {
            throw GalleryError.cannotWrite(url)
        }
        let loop = [kCGImagePropertyGIFDictionary as String: [kCGImagePropertyGIFLoopCount as String: 0]]
        CGImageDestinationSetProperties(dest, loop as CFDictionary)
        let frameProperties = [kCGImagePropertyGIFDictionary as String: [
            kCGImagePropertyGIFDelayTime as String: delay,
            kCGImagePropertyGIFUnclampedDelayTime as String: delay,
        ]]
        for frame in frames { CGImageDestinationAddImage(dest, frame, frameProperties as CFDictionary) }
        guard CGImageDestinationFinalize(dest) else { throw GalleryError.cannotWrite(url) }
    }
}

enum GalleryAppearance: String, CaseIterable {
    case light, dark

    struct Palette {
        var canvas, card, hairline, elevated, hairlineElevated, text, muted, inverse, inverseText: CGColor
    }

    /// The Mac catalog's tokens (docs/brand.md § 1), light and dark.
    var palette: Palette {
        func hex(_ v: UInt32, _ a: CGFloat = 1) -> CGColor {
            CGColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255,
                    blue: CGFloat(v & 0xFF) / 255, alpha: a)
        }
        switch self {
        case .light:
            return Palette(canvas: hex(0xFCFCFC), card: hex(0xFFFFFF), hairline: hex(0xEAEAEA), elevated: hex(0xF7F7F7),
                           hairlineElevated: hex(0xDADADB), text: hex(0x1A1C1F), muted: hex(0x767778, 0.45),
                           inverse: hex(0x1A1C1F), inverseText: hex(0xFFFFFF))
        case .dark:
            return Palette(canvas: hex(0x262626), card: hex(0x181818), hairline: hex(0x373737), elevated: hex(0x232323),
                           hairlineElevated: hex(0x3C3C3C), text: hex(0xFFFFFF), muted: hex(0x8B8B8B, 0.45),
                           inverse: hex(0xFFFFFF), inverseText: hex(0x1A1C1F))
        }
    }
}

/// One state, as a short script of cursor events and the instants to show.
struct GalleryScene {
    struct Event {
        var time: TimeInterval
        var kind: CUCursorKind
        var point: CGPoint
    }

    var name: String
    var title: String
    var events: [Event]
    var stillTime: TimeInterval
    var gifRange: ClosedRange<TimeInterval>

    static let field = CGRect(x: 30, y: 46, width: 160, height: 26)
    static let button = CGRect(x: 150, y: 116, width: 70, height: 26)
    static var buttonCenter: CGPoint { CGPoint(x: button.midX, y: button.midY) }
    static let fieldPoint = CGPoint(x: 96, y: 59)

    /// When event `index`'s segment starts once the script has run (the timeline queues events).
    static func start(of index: Int, in events: [Event]) -> TimeInterval {
        var timeline = CursorTimeline()
        var start: TimeInterval = 0
        for (i, e) in events.enumerated() {
            let s = timeline.receive(e.kind, at: e.point, now: e.time)
            if i == index { start = s }
        }
        return start
    }

    static func make(_ name: String, _ title: String, _ events: [Event], still: (Int, TimeInterval),
                     gif: ClosedRange<TimeInterval>) -> GalleryScene {
        GalleryScene(name: name, title: title, events: events,
                     stillTime: start(of: still.0, in: events) + still.1, gifRange: gif)
    }

    static let all: [GalleryScene] = {
        let rest = CGPoint(x: 120, y: 100)
        let far = CGPoint(x: 52, y: 140)
        func arrival(from a: CGPoint, to b: CGPoint) -> TimeInterval {
            CursorTimeline.glideDuration(distance: hypot(b.x - a.x, b.y - a.y))
        }
        return [
            make("01-idle", "Idle (breathing)", [Event(time: 0, kind: .idle, point: rest)],
                 still: (0, CursorTimeline.Timing.breathPeriod / 2), gif: 0...3.2),
            make("02-moving", "Moving", [Event(time: 0, kind: .idle, point: far),
                                        Event(time: 0.4, kind: .move, point: CGPoint(x: 214, y: 40))],
                 still: (1, arrival(from: far, to: CGPoint(x: 214, y: 40)) * 0.45), gif: 0...1.4),
            make("03-targeting", "Targeting", [Event(time: 0, kind: .idle, point: far),
                                              Event(time: 0.3, kind: .target(frame: button), point: buttonCenter)],
                 still: (1, arrival(from: far, to: buttonCenter) + 0.1), gif: 0...1.6),
            make("04-press", "Press", [Event(time: 0, kind: .idle, point: far),
                                      Event(time: 0.2, kind: .target(frame: button), point: buttonCenter),
                                      Event(time: 0.2, kind: .press, point: buttonCenter)],
                 still: (2, 0.06), gif: 0...1.6),
            make("05-double-click", "Double click", [Event(time: 0, kind: .idle, point: far),
                                                     Event(time: 0.2, kind: .target(frame: field), point: fieldPoint),
                                                     Event(time: 0.2, kind: .doubleClick, point: fieldPoint)],
                 still: (2, 0.17), gif: 0...1.6),
            make("06-right-click", "Right click", [Event(time: 0, kind: .idle, point: far),
                                                   Event(time: 0.2, kind: .target(frame: button), point: buttonCenter),
                                                   Event(time: 0.2, kind: .rightClick, point: buttonCenter)],
                 still: (2, 0.14), gif: 0...1.8),
            make("07-typing", "Typing", [Event(time: 0, kind: .idle, point: far),
                                        Event(time: 0.2, kind: .target(frame: field), point: fieldPoint),
                                        Event(time: 0.2, kind: .type, point: fieldPoint)],
                 still: (2, 0.3), gif: 0...2.2),
            make("08-key", "Key combo", [Event(time: 0, kind: .idle, point: fieldPoint),
                                        Event(time: 0.2, kind: .key(combo: "cmd+s"), point: fieldPoint)],
                 still: (1, 0.3), gif: 0...1.8),
            make("09-scroll", "Scrolling", [Event(time: 0, kind: .idle, point: rest),
                                           Event(time: 0.2, kind: .scrollToward(.down), point: rest)],
                 still: (1, 0.22), gif: 0...1.4),
            make("10-drag", "Dragging", [Event(time: 0, kind: .idle, point: CGPoint(x: 60, y: 124)),
                                        Event(time: 0.3, kind: .drag(to: CGPoint(x: 214, y: 50)), point: CGPoint(x: 60, y: 124))],
                 still: (1, 0.34), gif: 0...1.8),
            make("11-waiting", "Waiting", [Event(time: 0, kind: .idle, point: rest),
                                          Event(time: 0.2, kind: .wait(.begin(label: "Saved")), point: rest),
                                          Event(time: 2.6, kind: .wait(.end), point: rest)],
                 still: (1, 1.5), gif: 0...3.2),
            make("12-refused", "Refused", [Event(time: 0, kind: .idle, point: rest),
                                          Event(time: 0.3, kind: .refused, point: rest)],
                 still: (1, 0.1), gif: 0...1.6),
            make("13-foreground", "Foreground (real mouse)", [Event(time: 0, kind: .idle, point: rest),
                                                              Event(time: 0.2, kind: .foreground(true), point: rest),
                                                              Event(time: 0.6, kind: .press, point: buttonCenter),
                                                              Event(time: 1.9, kind: .foreground(false), point: buttonCenter)],
                 still: (2, 0.5), gif: 0...2.4),
            make("14-done", "Done (fade)", [Event(time: 0, kind: .idle, point: rest),
                                           Event(time: 0.6, kind: .done, point: rest)],
                 still: (1, 0.16), gif: 0...1.2),
            make("15-caption", "Caption", [Event(time: 0, kind: .idle, point: far),
                                          Event(time: 0.2, kind: .caption("Clicking “Save”"), point: far),
                                          Event(time: 0.2, kind: .target(frame: button), point: buttonCenter),
                                          Event(time: 0.2, kind: .press, point: buttonCenter)],
                 still: (3, 0.08), gif: 0...1.8),
        ]
    }()
}
