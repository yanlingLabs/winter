import CoreGraphics
import ImageIO
import XCTest
@testable import WinterCUPresentation

/// The gallery renders every state offscreen (bitmap contexts only: no window, overlay, capture or tap), and what it
/// renders is legible: the tip shows dark on a light ground and bright-rimmed on a dark one.
@MainActor final class CursorGalleryTests: XCTestCase {
    var directory: URL!

    override func setUp() async throws {
        await MainActor.run {
            directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("cu-cursor-gallery-\(UUID().uuidString)", isDirectory: true)
        }
    }

    override func tearDown() async throws {
        await MainActor.run { try? FileManager.default.removeItem(at: directory) }
    }

    func testEveryStateRendersOnLightAndDarkAtOneAndTwoX() throws {
        let output = try CUCursorGallery.render(to: directory, gifs: false)
        XCTAssertEqual(output.stills.count, GalleryScene.all.count * 2 * 2)
        for url in output.stills {
            let image = try XCTUnwrap(load(url), url.lastPathComponent)
            let scale = url.lastPathComponent.hasSuffix("@2x.png") ? 2 : 1
            XCTAssertEqual(image.width, 260 * scale)
            XCTAssertEqual(image.height, 170 * scale)
        }
        let sheet = try XCTUnwrap(load(output.contactSheet))
        XCTAssertGreaterThan(sheet.width, 1000)
        XCTAssertGreaterThan(sheet.height, 2000)
        XCTAssertNotNil(load(output.closeUps))
    }

    func testAnimatedStatesBecomeLoopingGIFs() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let scene = try XCTUnwrap(GalleryScene.all.first { $0.name.hasSuffix("press") })
        let frames = try stride(from: 0.0, to: 0.5, by: 0.1).map {
            try CUCursorGallery.renderImage(scene, at: $0, appearance: .dark, scale: 1)
        }
        let url = directory.appendingPathComponent("press.gif")
        try CUCursorGallery.writeGIF(frames, delay: 0.1, to: url)
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
        XCTAssertEqual(CGImageSourceGetCount(source), frames.count)
    }

    func testTheTipReadsOnLightAndDark() throws {
        let idle = try XCTUnwrap(GalleryScene.all.first { $0.name.hasSuffix("idle") })
        let tip = try XCTUnwrap(idle.events.first?.point)
        for appearance in GalleryAppearance.allCases {
            let image = try CUCursorGallery.renderImage(idle, at: idle.stillTime, appearance: appearance, scale: 2)
            let pixels = try XCTUnwrap(Pixels(image))
            // Inside the arrow, below the tip and clear of the frost edge: the black face.
            XCTAssertLessThan(pixels.luma(x: Int((tip.x + 6.5) * 2), y: Int((tip.y + 9) * 2)), 40,
                              "\(appearance): the face is dark")
            // Around the tip: both a dark face and a bright rim, whatever the ground.
            var darkest = 255.0, brightest = 0.0
            for dy in -2...6 {
                for dx in -2...6 {
                    let l = pixels.luma(x: Int(tip.x * 2) + dx, y: Int(tip.y * 2) + dy)
                    darkest = min(darkest, l)
                    brightest = max(brightest, l)
                }
            }
            XCTAssertLessThan(darkest, 50, "\(appearance)")
            XCTAssertGreaterThan(brightest, 200, "\(appearance): the white rim shows at the tip")
        }
    }

    func testIncreaseContrastIsStronger() throws {
        let idle = try XCTUnwrap(GalleryScene.all.first { $0.name.hasSuffix("idle") })
        let normal = try CUCursorGallery.renderImage(idle, at: idle.stillTime, appearance: .dark, scale: 2)
        let strong = try CUCursorGallery.renderImage(idle, at: idle.stillTime, appearance: .dark, scale: 2,
                                                     variant: .init(style: CursorStyle(increaseContrast: true)))
        let tip = try XCTUnwrap(idle.events.first?.point)
        func brightPixels(_ image: CGImage) throws -> Int {
            let p = try XCTUnwrap(Pixels(image))
            var n = 0
            for dy in -4...40 { for dx in -4...36 where p.luma(x: Int(tip.x * 2) + dx, y: Int(tip.y * 2) + dy) > 200 { n += 1 } }
            return n
        }
        XCTAssertGreaterThan(try brightPixels(strong), try brightPixels(normal), "a thicker, brighter rim")
    }

    /// Writes the full gallery (stills, GIFs, contact sheet) to $WINTER_CU_GALLERY_DIR when it is set. Offscreen only.
    func testRenderTheFullGalleryWhenAsked() throws {
        guard let path = ProcessInfo.processInfo.environment["WINTER_CU_GALLERY_DIR"], !path.isEmpty else {
            throw XCTSkip("set WINTER_CU_GALLERY_DIR to write the full gallery")
        }
        let output = try CUCursorGallery.render(to: URL(fileURLWithPath: path, isDirectory: true))
        XCTAssertEqual(output.gifs.count, GalleryScene.all.count * 2)
    }

    private func load(_ url: URL) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }
}

/// RGBA8 pixels of an image, top-left origin, for sampling.
struct Pixels {
    let width: Int, height: Int
    let data: [UInt8]

    init?(_ image: CGImage) {
        width = image.width
        height = image.height
        var buffer = [UInt8](repeating: 0, count: width * height * 4)
        guard let ctx = CGContext(data: &buffer, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        data = buffer
    }

    /// Perceived brightness 0…255 at (x, y), top-left origin.
    func luma(x: Int, y: Int) -> Double {
        guard x >= 0, y >= 0, x < width, y < height else { return 128 }
        let i = (y * width + x) * 4
        return 0.2126 * Double(data[i]) + 0.7152 * Double(data[i + 1]) + 0.0722 * Double(data[i + 2])
    }
}
