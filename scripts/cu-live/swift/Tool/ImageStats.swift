import CoreGraphics
import Foundation
import ImageIO

// `cu-live-tool image-stats <file>`: what the live suite wants to know about a screenshot or a mirrored frame —
// is it blank, and does it contain the fixture's SENTINEL (a solid #FF00FF block, see the fixture's `Sentinel`).

struct ImageError: Error, Equatable {
    let message: String
    init(_ message: String) { self.message = message }
}

struct ImageReport: Equatable {
    var width: Int
    var height: Int
    var meanLuma: Double
    var stddevLuma: Double
    var sentinelPixels: Int

    var blank: Bool { stddevLuma < ImageStats.blankThreshold }
    var sentinelFraction: Double { Double(sentinelPixels) / Double(max(width * height, 1)) }

    /// `{"width","height","meanLuma","stddevLuma","blank","sentinelPixels","sentinelFraction"}`
    var json: String {
        "{\"width\":\(width),\"height\":\(height),\"meanLuma\":\(JSONOut.number((meanLuma * 10).rounded() / 10)),"
            + "\"stddevLuma\":\(JSONOut.number((stddevLuma * 100).rounded() / 100)),\"blank\":\(blank),"
            + "\"sentinelPixels\":\(sentinelPixels),\"sentinelFraction\":\(JSONOut.number(sentinelFraction))}"
    }
}

enum ImageStats {
    /// Luma is measured on this many samples (a 64x40 downsample, as the view probe does), so a number from here
    /// and one from the probe mean the same thing. A flat window stays flat; `blank` is stddev under 2.
    static let gridWidth = 64
    static let gridHeight = 40
    static let blankThreshold = 2.0

    /// The sentinel rule, deliberately loose around #FF00FF so JPEG fuzz and colour-profile conversion do not
    /// drop edge pixels: red and blue high, green low.
    static func isSentinel(r: UInt8, g: UInt8, b: UInt8) -> Bool { r >= 200 && g <= 70 && b >= 200 }

    static func analyze(path: String) -> Result<ImageReport, ImageError> {
        guard let data = FileManager.default.contents(atPath: path) else { return .failure(ImageError("cannot read \(path)")) }
        return analyze(data: data)
    }

    static func analyze(data: Data) -> Result<ImageReport, ImageError> {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0,
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            return .failure(ImageError("not an image ImageIO can decode"))
        }
        guard let report = analyze(image: image) else { return .failure(ImageError("the image could not be read into a bitmap")) }
        return .success(report)
    }

    static func bitmap(of image: CGImage, width: Int, height: Int) -> [UInt8]? {
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
            // sRGB, so a Display P3 screenshot is converted to the space the rule is written in (a P3-tagged
            // #FF00FF block reads as ~(255, 0, 255) here, not as its raw P3 code values).
            guard let space = CGColorSpace(name: CGColorSpace.sRGB),
                  let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
                                          bytesPerRow: width * 4, space: space,
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.interpolationQuality = .high
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        return drawn ? pixels : nil
    }

    static func analyze(image: CGImage) -> ImageReport? {
        let width = image.width, height = image.height
        guard width > 0, height > 0 else { return nil }

        // The sentinel is counted on the FULL image: a 48-point block downsampled to 64x40 would be a handful of
        // blended cells, which no threshold could count reliably.
        guard let full = bitmap(of: image, width: width, height: height) else { return nil }
        var sentinel = 0
        full.withUnsafeBufferPointer { pixels in
            var index = 0
            while index < pixels.count {
                if isSentinel(r: pixels[index], g: pixels[index + 1], b: pixels[index + 2]) { sentinel += 1 }
                index += 4
            }
        }

        // Luma on the downsample. Rec. 601 on sRGB code values (not a gray colour space: Core Graphics' managed
        // conversion is non-linear, sRGB 128 comes out near 146).
        guard let grid = bitmap(of: image, width: gridWidth, height: gridHeight) else { return nil }
        let count = gridWidth * gridHeight
        var lumas = [Double](repeating: 0, count: count)
        for index in 0..<count {
            let base = index * 4
            lumas[index] = 0.299 * Double(grid[base]) + 0.587 * Double(grid[base + 1]) + 0.114 * Double(grid[base + 2])
        }
        let mean = lumas.reduce(0, +) / Double(count)
        let variance = lumas.reduce(0) { $0 + ($1 - mean) * ($1 - mean) } / Double(count)
        return ImageReport(width: width, height: height, meanLuma: mean, stddevLuma: variance.squareRoot(), sentinelPixels: sentinel)
    }
}
