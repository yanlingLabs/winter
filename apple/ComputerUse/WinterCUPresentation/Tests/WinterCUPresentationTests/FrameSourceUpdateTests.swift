import CoreVideo
import XCTest
@testable import WinterCUPresentation

/// The frame source's rate changes happen in place (the encoder's throttle follows a new rate without a new
/// stream), and a frame of nothing — fully transparent, or pure black on the whole sample grid — never reaches
/// the mirror.
final class FrameSourceUpdateTests: XCTestCase {
    private func buffer(width: Int = 64, height: Int = 48, fill: (Int, Int) -> (b: UInt8, g: UInt8, r: UInt8, a: UInt8)) -> CVPixelBuffer {
        var made: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, nil, &made), kCVReturnSuccess)
        let pb = made!
        CVPixelBufferLockBaseAddress(pb, [])
        let rowBytes = CVPixelBufferGetBytesPerRow(pb)
        let bytes = CVPixelBufferGetBaseAddress(pb)!.assumingMemoryBound(to: UInt8.self)
        for y in 0..<height {
            for x in 0..<width {
                let p = bytes + y * rowBytes + x * 4
                let c = fill(x, y)
                p[0] = c.b; p[1] = c.g; p[2] = c.r; p[3] = c.a
            }
        }
        CVPixelBufferUnlockBaseAddress(pb, [])
        return pb
    }

    func testTransparentAndPureBlackFramesAreBlank() {
        XCTAssertTrue(FrameEncoder.isBlank(buffer { _, _ in (0, 0, 0, 0) }), "transparent")
        XCTAssertTrue(FrameEncoder.isBlank(buffer { _, _ in (0, 0, 0, 255) }), "opaque, pure black")
    }

    func testARealWindowIsNotBlankEvenWhenMostlyDark() {
        XCTAssertFalse(FrameEncoder.isBlank(buffer { _, _ in (236, 236, 236, 255) }), "a light window")
        // A dark terminal: near-black, with a grey title bar on top.
        XCTAssertFalse(FrameEncoder.isBlank(buffer { _, y in y < 6 ? (60, 60, 60, 255) : (12, 12, 12, 255) }))
        // Pure black content under a title bar is still a window.
        XCTAssertFalse(FrameEncoder.isBlank(buffer { _, y in y < 6 ? (40, 40, 40, 255) : (0, 0, 0, 255) }))
    }

    func testABlankFrameIsNeverEncoded() {
        let encoder = FrameEncoder(maxFps: 30, quality: 0.7)
        XCTAssertNil(encoder.encode(buffer { _, _ in (0, 0, 0, 0) }))
        XCTAssertNotNil(encoder.encode(buffer { x, _ in (UInt8(x * 3), 120, 200, 255) }))
    }

    func testTheThrottleFollowsANewRate() {
        var throttle = FrameThrottle(maxFps: 10)
        XCTAssertTrue(throttle.shouldEmit(at: 0))
        XCTAssertTrue(throttle.shouldEmit(at: 0.1))
        throttle.setMaxFps(1)
        XCTAssertFalse(throttle.shouldEmit(at: 0.5), "1 fps now")
        XCTAssertTrue(throttle.shouldEmit(at: 1.1))
        throttle.setMaxFps(10)
        XCTAssertTrue(throttle.shouldEmit(at: 1.2), "back up at once")
    }
}
