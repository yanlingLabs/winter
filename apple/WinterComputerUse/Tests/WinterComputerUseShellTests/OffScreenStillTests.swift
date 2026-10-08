import CoreGraphics
import Foundation
import ImageIO
import WinterComputerUseShell
import XCTest

/// An off-screen bound window's stills (another Space, full screen elsewhere, minimized): with the private path
/// on they come from the window server's own image of the window, so the mirror shows its real content; with it
/// off, or when that image is blank, from ScreenCaptureKit as before. Nothing here captures anything real.
@MainActor
final class OffScreenStillTests: XCTestCase {
    private func target(privatePath: Bool) -> ViewTarget {
        ViewTarget(sessionId: "s_1", targetId: "t1", pid: 123, windowId: 77, appName: "Safari", bundleId: "com.apple.Safari",
                   windowFrame: CGRect(x: 100, y: 50, width: 800, height: 600), mirror: true, privatePath: privatePath)
    }

    private func solid(_ w: Int, _ h: Int, alpha: CGFloat = 1) -> CGImage {
        let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.setFillColor(CGColor(red: 0.9, green: 0.4, blue: 0.1, alpha: alpha))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        return ctx.makeImage()!
    }

    /// What the snapshotter's captures were asked for.
    private final class Calls: @unchecked Sendable {
        let lock = NSLock()
        var privateRects: [CGRect] = []
        var publicWidths: [Int] = []
    }

    private func snapshotter(_ calls: Calls, image: CGImage?, frame: CGRect? = CGRect(x: -33, y: 144, width: 920, height: 464),
                             publicFrame: ViewFrame? = nil) -> LiveWindowSnapshotter {
        LiveWindowSnapshotter(
            privateCapture: { id, rect in
                XCTAssertEqual(id, 77)
                calls.lock.withLock { calls.privateRects.append(rect) }
                return image
            },
            frameOf: { _ in frame },
            publicCapture: { _, width in
                calls.lock.withLock { calls.publicWidths.append(width) }
                return publicFrame
            })
    }

    private func take(_ s: LiveWindowSnapshotter, privatePath: Bool, maxWidth: Int = 720) async -> ViewFrame? {
        await withCheckedContinuation { done in
            s.snapshot(windowID: 77, maxWidth: maxWidth, privatePath: privatePath) { done.resume(returning: $0) }
        }
    }

    func testTheHubAsksForStillsWithTheBindsPrivatePath() {
        for privatePath in [true, false] {
            let rig = Rig()
            rig.geometry.onScreen[77] = false
            _ = rig.viewHub.subscribe(connection: 1, ViewSubscribeParams(sessionId: "s_1", frames: true))
            rig.viewHub.bound(target(privatePath: privatePath))
            rig.clock.advance(by: ViewHub.visibilityPollInterval)
            XCTAssertEqual(rig.snapshotter.requests.map(\.privatePath), [privatePath])
        }
        let plain = ViewTarget(sessionId: "s", targetId: "t", pid: 1, windowId: 2, appName: "A", bundleId: "b",
                               windowFrame: .zero, mirror: true)
        XCTAssertTrue(plain.privatePath, "absent → on, the setting's default")
    }

    func testWithThePrivatePathTheWindowServersImageIsTheStill() async throws {
        let calls = Calls()
        let s = snapshotter(calls, image: solid(1840, 928))
        let taken = await take(s, privatePath: true)
        let frame = try XCTUnwrap(taken)
        XCTAssertEqual(calls.privateRects, [CGRect(x: -33, y: 144, width: 920, height: 464)], "the whole frame, past the display edge")
        XCTAssertTrue(calls.publicWidths.isEmpty, "ScreenCaptureKit is not asked")
        XCTAssertEqual([frame.width, frame.height], [720, 363], "drawn down to the subscriber's width")
        XCTAssertEqual(frame.windowSize, CGSize(width: 920, height: 464))
        let decoded = try XCTUnwrap(CGImageSourceCreateWithData(frame.jpeg as CFData, nil).flatMap { CGImageSourceCreateImageAtIndex($0, 0, nil) })
        XCTAssertEqual([decoded.width, decoded.height], [720, 363])
    }

    func testASmallImageIsNotEnlarged() async throws {
        let calls = Calls()
        let s = snapshotter(calls, image: solid(400, 200), frame: CGRect(x: 0, y: 0, width: 400, height: 200))
        let taken = await take(s, privatePath: true)
        let frame = try XCTUnwrap(taken)
        XCTAssertEqual([frame.width, frame.height], [400, 200])
    }

    func testABlankOrMissingImageFallsBackToScreenCaptureKit() async {
        let fromStream = ViewFrame(jpeg: Data([1, 2, 3]), width: 10, height: 10, windowSize: CGSize(width: 10, height: 10))
        for image in [solid(800, 600, alpha: 0), nil] {
            let calls = Calls()
            let s = snapshotter(calls, image: image, publicFrame: fromStream)
            let frame = await take(s, privatePath: true)
            XCTAssertEqual(calls.privateRects.count, 1)
            XCTAssertEqual(calls.publicWidths, [720])
            XCTAssertEqual(frame, fromStream)
        }
        let gone = Calls()
        _ = await take(snapshotter(gone, image: solid(10, 10), frame: nil), privatePath: true)
        XCTAssertTrue(gone.privateRects.isEmpty, "a window the window server no longer has is not captured privately")
        XCTAssertEqual(gone.publicWidths, [720])
    }

    func testWithThePrivatePathOffOnlyScreenCaptureKitIsAsked() async {
        let calls = Calls()
        let s = snapshotter(calls, image: solid(1840, 928))
        let frame = await take(s, privatePath: false)
        XCTAssertNil(frame)
        XCTAssertTrue(calls.privateRects.isEmpty)
        XCTAssertEqual(calls.publicWidths, [720])
    }
}
