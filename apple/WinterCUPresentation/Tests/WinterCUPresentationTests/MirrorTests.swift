import CoreGraphics
import CoreVideo
import ImageIO
import SwiftUI
import XCTest
@testable import WinterCUPresentation

/// The in-app mirror: the frame source's maths (throttle, size, JPEG) with fakes, the model (frames, cursor mapping
/// with letterboxing, clear), and the view rendered OFFSCREEN with a synthetic frame. Nothing reaches the screen.
@MainActor final class MirrorTests: XCTestCase {
    final class FakeClock: CUClock { var now: TimeInterval = 100 }

    // MARK: - Frame source maths

    func testThrottleLetsThroughAtMostMaxFps() {
        var throttle = FrameThrottle(maxFps: 10)
        var emitted = 0
        // A source at 60 fps for two seconds.
        for i in 0..<120 where throttle.shouldEmit(at: Double(i) / 60) { emitted += 1 }
        XCTAssertEqual(emitted, 20)
        // Jitter just under the interval still passes; a burst does not.
        var t = FrameThrottle(maxFps: 10)
        XCTAssertTrue(t.shouldEmit(at: 1.0))
        XCTAssertTrue(t.shouldEmit(at: 1.095))
        XCTAssertFalse(t.shouldEmit(at: 1.1))
    }

    func testCaptureSizeIsCappedEvenAndKeepsTheShape() {
        XCTAssertEqual(CaptureSizing.pixelSize(windowSize: CGSize(width: 1440, height: 900), scale: 2, maxWidth: 720),
                       CGSize(width: 720, height: 450))
        XCTAssertEqual(CaptureSizing.pixelSize(windowSize: CGSize(width: 300, height: 200), scale: 2, maxWidth: 720),
                       CGSize(width: 600, height: 400), "small windows are not blown up past their own pixels")
        XCTAssertEqual(CaptureSizing.pixelSize(windowSize: CGSize(width: 400, height: 2000), scale: 2, maxWidth: 720),
                       CGSize(width: 288, height: 1440), "very tall windows are held to twice the width")
        XCTAssertEqual(CaptureSizing.pixelSize(windowSize: CGSize(width: 801, height: 500), scale: 1, maxWidth: 2000),
                       CGSize(width: 802, height: 500), "even dimensions")
        XCTAssertEqual(CaptureSizing.pixelSize(windowSize: .zero, scale: 2, maxWidth: 720), CGSize(width: 2, height: 2))
    }

    func testJPEGRoundTrip() throws {
        let image = try XCTUnwrap(syntheticWindow(appearance: .light, scale: 1))
        let jpeg = try XCTUnwrap(JPEGCodec.encode(image, quality: CUWindowFrameSource.jpegQuality))
        let back = try XCTUnwrap(JPEGCodec.decode(jpeg))
        XCTAssertEqual(back.width, image.width)
        XCTAssertEqual(back.height, image.height)
        XCTAssertNil(JPEGCodec.decode(Data([1, 2, 3])))
    }

    func testTheEncoderThrottlesAndEncodesPixelBuffers() throws {
        var buffer: CVPixelBuffer?
        let attributes = [kCVPixelBufferIOSurfacePropertiesKey as String: [:]] as CFDictionary
        XCTAssertEqual(CVPixelBufferCreate(nil, 64, 40, kCVPixelFormatType_32BGRA, attributes, &buffer), kCVReturnSuccess)
        let pixels = try XCTUnwrap(buffer)
        let encoder = FrameEncoder(maxFps: 10, quality: 0.7)
        let first = try XCTUnwrap(encoder.encode(pixels))
        XCTAssertEqual(first.width, 64)
        XCTAssertEqual(first.height, 40)
        XCTAssertNotNil(JPEGCodec.decode(first.jpeg))
        XCTAssertNil(encoder.encode(pixels), "a second frame right away is throttled")
    }

    // MARK: - Mapping

    func testTheCursorMapsIntoTheImageThroughBothLetterboxes() {
        // The view's content is wider than the image, and the image is wider than the window (which got narrower
        // since the capture opened): the window sits pillarboxed inside the image, inside the content.
        let content = CGRect(x: 0, y: 0, width: 400, height: 200)
        let image = MirrorGeometry.imageRect(content: content, imageSize: CGSize(width: 720, height: 450),
                                             windowSize: CGSize(width: 1200, height: 900))
        XCTAssertEqual(image, CGRect(x: 40, y: 0, width: 320, height: 200))
        let window = MirrorGeometry.windowRect(content: content, imageSize: CGSize(width: 720, height: 450),
                                               windowSize: CGSize(width: 1200, height: 900))
        XCTAssertEqual(window.height, 200, accuracy: 1e-9)
        XCTAssertEqual(window.width, 200 * 1200 / 900, accuracy: 1e-9)
        XCTAssertEqual(window.midX, 200, accuracy: 1e-9)
        let ws = CGSize(width: 1200, height: 900)
        XCTAssertEqual(MirrorGeometry.map(.zero, windowRect: window, windowSize: ws), window.origin)
        let corner = MirrorGeometry.map(CGPoint(x: 1200, y: 900), windowRect: window, windowSize: ws)
        XCTAssertEqual(corner.x, window.maxX, accuracy: 1e-9)
        XCTAssertEqual(corner.y, window.maxY, accuracy: 1e-9)
        // Before any frame, the window's own shape decides.
        XCTAssertEqual(MirrorGeometry.windowRect(content: content, imageSize: nil, windowSize: CGSize(width: 800, height: 400)),
                       content)
    }

    // MARK: - Model

    func testShowApplyAndClear() throws {
        let model = CUMirrorModel(clock: FakeClock())
        XCTAssertFalse(model.isActive)
        model.show(appName: "Notes", windowSize: CGSize(width: 260, height: 170))
        XCTAssertTrue(model.isActive)
        XCTAssertNil(model.image, "a placeholder until the first frame")

        let jpeg = try XCTUnwrap(JPEGCodec.encode(try XCTUnwrap(syntheticWindow(appearance: .light, scale: 2)), quality: 0.7))
        model.apply(frame: jpeg, width: 520, height: 340, windowSize: CGSize(width: 260, height: 170))
        XCTAssertEqual(model.image?.width, 520)
        XCTAssertEqual(model.imageSize, CGSize(width: 520, height: 340))
        model.apply(frame: Data([0, 1]), width: 10, height: 10, windowSize: CGSize(width: 260, height: 170))
        XCTAssertEqual(model.image?.width, 520, "a bad frame keeps the last good one")
        model.apply(frame: jpeg, width: 520, height: 340, windowSize: CGSize(width: 300, height: 170))
        XCTAssertEqual(model.windowSize, CGSize(width: 300, height: 170), "the window's size follows the frames")

        model.applyCursor(kind: "press", point: CGPoint(x: 50, y: 60), dragTo: nil, frame: nil, text: nil, count: nil,
                          button: nil)
        XCTAssertTrue(model.cursorFrame().visible)
        model.clear()
        XCTAssertFalse(model.isActive)
        XCTAssertNil(model.image)
        XCTAssertFalse(model.cursorFrame().visible)
    }

    func testCursorEventsUseTheCoreKindsInWindowSpace() {
        let clock = FakeClock()
        let model = CUMirrorModel(clock: clock)
        model.show(appName: "Notes", windowSize: CGSize(width: 260, height: 170))
        model.applyCursor(kind: "teleport", point: .zero, dragTo: nil, frame: nil, text: nil, count: nil, button: nil)
        XCTAssertFalse(model.cursorFrame().visible, "unknown kinds are ignored")
        let button = CGRect(x: 150, y: 116, width: 70, height: 26)
        model.applyCursor(kind: "target", point: CGPoint(x: 185, y: 129), dragTo: nil, frame: button, text: nil,
                          count: nil, button: nil)
        model.applyCursor(kind: "press", point: CGPoint(x: 185, y: 129), dragTo: nil, frame: nil, text: nil, count: 2,
                          button: nil)
        clock.now += 0.15
        let frame = model.cursorFrame()
        XCTAssertEqual(frame.tip, CGPoint(x: 185, y: 129))
        XCTAssertEqual(frame.reticle?.rect, button)
        XCTAssertEqual(model.cursorNeed, .full)
    }

    /// `view.cursor` as Winter.app forwards it (window-relative points, the window's size from `view.bound`): the
    /// cursor appears, glides between the two points over time (it animates, the view's timeline runs), and is drawn
    /// where the window point lands in the mirror.
    func testTheMirrorCursorAnimatesFromRealViewCursorInput() throws {
        let clock = FakeClock()
        let model = CUMirrorModel(clock: clock)
        let window = CGSize(width: 1211, height: 824)
        model.show(appName: "Safari", windowSize: window)
        XCTAssertEqual(model.cursorNeed, .none)
        model.applyCursor(kind: "move", point: CGPoint(x: 100, y: 100), dragTo: nil, frame: nil, text: nil, count: nil,
                          button: nil)
        XCTAssertNotEqual(model.cursorNeed, .none, "the view's timeline is unpaused")
        clock.now += 1
        let start = model.cursorFrame()
        XCTAssertTrue(start.visible)
        XCTAssertEqual(start.tip, CGPoint(x: 100, y: 100))
        model.applyCursor(kind: "press", point: CGPoint(x: 900, y: 600), dragTo: nil, frame: nil, text: nil, count: 1,
                          button: "left")
        XCTAssertEqual(model.cursorNeed, .full)
        clock.now += 0.1
        let mid = model.cursorFrame()
        XCTAssertGreaterThan(mid.tip.x, 100)
        XCTAssertLessThan(mid.tip.x, 900, "mid-glide: it moves over time, not in one jump")
        clock.now += 1.5
        let end = model.cursorFrame()
        XCTAssertEqual(end.tip, CGPoint(x: 900, y: 600))

        // Drawn into a top-left context (the canvas's), half the window's size: the arrow is at the mapped point.
        let size = CGSize(width: window.width / 2, height: window.height / 2)
        let pixels = try renderCursor(model, size: size)
        let tip = CGPoint(x: 450, y: 300)
        XCTAssertGreaterThan(pixels.alpha(around: CGPoint(x: tip.x + 3, y: tip.y + 5), radius: 3), 0.5,
                             "the arrow sits just below-right of its tip")
        XCTAssertEqual(pixels.alpha(around: CGPoint(x: 60, y: 60), radius: 4), 0, "nothing far from the cursor")
    }

    /// Opaque-ness of a premultiplied BGRA bitmap rendered in top-left points at 2x.
    struct Pixels {
        let data: [UInt8]
        let width: Int, height: Int, scale: CGFloat
        func alpha(around p: CGPoint, radius: CGFloat) -> CGFloat {
            var best: UInt8 = 0
            let r = Int(radius * scale)
            let cx = Int(p.x * scale), cy = Int(p.y * scale)
            for y in max(0, cy - r)...min(height - 1, cy + r) {
                for x in max(0, cx - r)...min(width - 1, cx + r) {
                    best = max(best, data[(y * width + x) * 4 + 3])
                }
            }
            return CGFloat(best) / 255
        }
    }

    func renderCursor(_ model: CUMirrorModel, size: CGSize) throws -> Pixels {
        let scale: CGFloat = 2
        let width = Int(size.width * scale), height = Int(size.height * scale)
        var data = [UInt8](repeating: 0, count: width * height * 4)
        try data.withUnsafeMutableBytes { buffer in
            let ctx = try XCTUnwrap(CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
                                              bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                              bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
                                                  | CGBitmapInfo.byteOrder32Little.rawValue))
            // Row 0 of `data` is the top row; top-left points, like SwiftUI's canvas.
            ctx.translateBy(x: 0, y: CGFloat(height))
            ctx.scaleBy(x: scale, y: -scale)
            model.renderCursor(into: ctx, size: size, scale: scale)
        }
        return Pixels(data: data, width: width, height: height, scale: scale)
    }

    // MARK: - Offscreen render

    func testTheViewRendersOffscreenWithASyntheticFrame() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("cu-mirror-view-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let urls = try renderMirrorViews(to: directory)
        for url in urls {
            let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
            let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
            XCTAssertGreaterThan(image.width, 600)
            XCTAssertGreaterThan(image.height, 400)
        }
    }

    /// Writes mirror-view-light.png / -dark.png into $WINTER_CU_GALLERY_DIR when set.
    func testWriteTheMirrorViewsWhenAsked() throws {
        guard let path = ProcessInfo.processInfo.environment["WINTER_CU_GALLERY_DIR"], !path.isEmpty else {
            throw XCTSkip("set WINTER_CU_GALLERY_DIR to write the mirror views")
        }
        XCTAssertEqual(try renderMirrorViews(to: URL(fileURLWithPath: path, isDirectory: true)).count, 2)
    }

    // MARK: - Helpers

    /// The gallery's mock window as one captured frame.
    func syntheticWindow(appearance: GalleryAppearance, scale: CGFloat) -> CGImage? {
        let size = CUCursorGallery.canvas
        guard let ctx = CGContext(data: nil, width: Int(size.width * scale), height: Int(size.height * scale),
                                  bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { return nil }
        ctx.translateBy(x: 0, y: size.height * scale)
        ctx.scaleBy(x: scale, y: -scale)
        CUCursorGallery.drawBackground(ctx, appearance: appearance)
        return ctx.makeImage()
    }

    func renderMirrorViews(to directory: URL) throws -> [URL] {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var urls: [URL] = []
        for appearance in GalleryAppearance.allCases {
            let clock = FakeClock()
            let model = CUMirrorModel(clock: clock)
            let windowSize = CUCursorGallery.canvas
            model.show(appName: "Notes", windowSize: windowSize)
            let frame = try XCTUnwrap(syntheticWindow(appearance: appearance, scale: 2))
            let jpeg = try XCTUnwrap(JPEGCodec.encode(frame, quality: CUWindowFrameSource.jpegQuality))
            model.apply(frame: jpeg, width: frame.width, height: frame.height, windowSize: windowSize)
            let button = GalleryScene.button
            model.applyCursor(kind: "move", point: CGPoint(x: 60, y: 130), dragTo: nil, frame: nil, text: nil, count: nil,
                              button: nil)
            clock.now += 0.4
            model.applyCursor(kind: "target", point: GalleryScene.buttonCenter, dragTo: nil, frame: button, text: nil,
                              count: nil, button: nil)
            model.applyCursor(kind: "press", point: GalleryScene.buttonCenter, dragTo: nil, frame: nil, text: nil,
                              count: nil, button: nil)
            // Just after the press lands: the reticle on "Save", the squash and the ring.
            clock.now += CursorTimeline.glideDuration(distance: hypot(GalleryScene.buttonCenter.x - 60,
                                                                      GalleryScene.buttonCenter.y - 130))
                + CursorTimeline.Timing.reticleDwell + 0.06

            let windowGround: Color = appearance == .light ? .white : Color(white: 0.094)
            let content = ZStack {
                windowGround
                CUMirrorView(model: model)
                    .frame(width: 360)
                    .padding(20)
            }
            .fixedSize()
            .environment(\.colorScheme, appearance == .light ? .light : .dark)
            let renderer = ImageRenderer(content: content)
            renderer.scale = 2
            let image = try XCTUnwrap(renderer.cgImage, "ImageRenderer produced no image")
            let url = directory.appendingPathComponent("mirror-view-\(appearance.rawValue).png")
            try CUCursorGallery.writePNG(image, to: url)
            urls.append(url)
        }
        return urls
    }
}
