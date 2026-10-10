import CoreGraphics
import XCTest
@testable import WinterCUCore

/// A screenshot's `budget.maxBytes` (helper 1.7.0): over it, the SAME captured image is encoded again at the next
/// lower quality — 0.8, 0.6, 0.45, 0.3, only those below the one asked for — and the first that fits is returned,
/// else the last. The picture is captured once (a visited live shot is never taken again for its size).
final class MaxBytesTests: XCTestCase {
    func testTheLadderStartsBelowTheQualityAskedFor() {
        XCTAssertEqual(CUCaptureBudget.maxBytesLadder(below: 0.9), [0.8, 0.6, 0.45, 0.3])
        XCTAssertEqual(CUCaptureBudget.maxBytesLadder(below: 0.8), [0.6, 0.45, 0.3])
        XCTAssertEqual(CUCaptureBudget.maxBytesLadder(below: 0.5), [0.45, 0.3])
        XCTAssertEqual(CUCaptureBudget.maxBytesLadder(below: 0.3), [])
    }

    func testTheFirstQualityThatFitsWinsElseTheLast() {
        var asked: [Double] = []
        let encode = { (q: Double) -> Data? in asked.append(q); return Data(count: Int(q * 1000)) }
        let fits = CUCaptureBudget.fitMaxBytes(Data(count: 800), quality: 0.8, maxBytes: 500, encode: encode)
        XCTAssertEqual(fits.count, 450)
        XCTAssertEqual(asked, [0.6, 0.45], "stops at the first that fits")
        asked = []
        let none = CUCaptureBudget.fitMaxBytes(Data(count: 800), quality: 0.8, maxBytes: 10, encode: encode)
        XCTAssertEqual(none.count, 300, "the last when none fits")
        asked = []
        let already = CUCaptureBudget.fitMaxBytes(Data(count: 400), quality: 0.8, maxBytes: 500, encode: encode)
        XCTAssertEqual(already.count, 400)
        XCTAssertTrue(asked.isEmpty, "a picture that fits is not encoded again")
    }

    /// The real encoder: a noisy picture (its JPEG size follows the quality) is the same size in pixels, smaller in
    /// bytes, when it was over `maxBytes`.
    func testAWindowPictureOverItsMaxBytesIsEncodedAgainSmaller() throws {
        let w = 400, h = 300
        let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        var seed: UInt64 = 42
        for y in stride(from: 0, to: h, by: 2) {
            for x in stride(from: 0, to: w, by: 2) {
                seed = seed &* 6_364_136_223_846_793_005 &+ 1
                let v = CGFloat((seed >> 33) % 256) / 255
                ctx.setFillColor(CGColor(red: v, green: 1 - v, blue: v / 2, alpha: 1))
                ctx.fill(CGRect(x: x, y: y, width: 2, height: 2))
            }
        }
        let image = ctx.makeImage()!
        let area = CGRect(x: 0, y: 0, width: w, height: h)
        let plain = try CUCapturer.encodeWindowImage(image, pointsRect: area, budget: CUImageBudget(maxLongEdge: 1000, quality: 0.9))
        let capped = try CUCapturer.encodeWindowImage(image, pointsRect: area,
                                                      budget: CUImageBudget(maxLongEdge: 1000, quality: 0.9, maxBytes: plain.jpeg.count / 2))
        XCTAssertEqual([capped.width, capped.height], [plain.width, plain.height], "the same pixels")
        XCTAssertLessThan(capped.jpeg.count, plain.jpeg.count)
    }
}
