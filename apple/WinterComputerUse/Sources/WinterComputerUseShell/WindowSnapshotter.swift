import CoreGraphics
import Foundation
import ImageIO
@preconcurrency import ScreenCaptureKit
import UniformTypeIdentifiers
import WinterCUCore

/// What one still of a window came to.
public enum WindowStill: Sendable, Equatable {
    /// A picture, with a digest of its pixels (equal pixels, equal digest).
    case frame(ViewFrame, digest: Int)
    /// The pixels are the ones whose digest the caller passed: nothing was encoded.
    case unchanged
    /// None could be taken, or it came back blank.
    case none
}

/// One-shot pictures of a window the live stream cannot see (off every screen: another Space or display, in
/// full screen elsewhere, or minimized), and of a paused one being checked for change. Injected so the rules are
/// tested without capturing.
@MainActor public protocol WindowSnapshotter: AnyObject {
    /// Calls back on the main actor. `privatePath`: the bind's `computerUse.privateEventPath` — may the window
    /// server's own image be used? `unlessDigest`: the digest of the last still of this window — pixels with the
    /// same digest answer `.unchanged` without being encoded.
    func snapshot(windowID: CGWindowID, maxWidth: Int, privatePath: Bool, unlessDigest: Int?,
                  completion: @escaping @MainActor (WindowStill) -> Void)
}

/// With the private path on, the window server's own image of the window first: SkyLight's
/// `SLSHWCaptureWindowListInRect`, its content wherever it is (current for an app that keeps drawing; ChatGPT takes its off-screen stills
/// the same way; its live streams have no such fallback, and neither do ours). Then `SCScreenshotManager` with a
/// desktop-independent single-window filter, the engine's public capture. Neither moves, raises or focuses
/// anything — a passive mirror must never. An image that comes back empty (all transparent or all black)
/// counts as none, so it never replaces the last good frame.
///
/// Cost (measured idle at ~4.6% CPU with one still a second): the image is drawn down to the subscriber's width
/// ONCE, in its own color space (a conversion to sRGB on the way tripled the draw: 16 ms → 5.5 ms for a 2880 px
/// window), the blank check and the digest read that small bitmap, and an unchanged picture is never encoded.
@MainActor public final class LiveWindowSnapshotter: WindowSnapshotter {
    public nonisolated static let jpegQuality: CGFloat = 0.7

    /// SkyLight's image of a window in a global rect (points), or nil.
    public typealias PrivateCapture = @Sendable (CGWindowID, CGRect) -> CGImage?
    /// The window's frame in global points, or nil when it is gone.
    public typealias FrameLookup = @Sendable (CGWindowID) -> CGRect?
    /// The public (ScreenCaptureKit) still, sized to a max width.
    public typealias PublicCapture = @Sendable (CGWindowID, Int) async -> ViewFrame?

    private let privateCapture: PrivateCapture
    private let frameOf: FrameLookup
    private let publicCapture: PublicCapture

    public convenience init() {
        self.init(privateCapture: { id, rect in
                      guard CGPreflightScreenCaptureAccess() else { return nil }
                      return CUSkyLight.system.captureWithSkyLight(windowIDs: [id], rect: rect).first
                  },
                  frameOf: { CUWindowLookup.frame(of: $0) },
                  publicCapture: { id, width in await LiveWindowSnapshotter.screenCaptureKit(windowID: id, maxWidth: width) })
    }

    /// The captures, injectable for tests.
    public init(privateCapture: @escaping PrivateCapture, frameOf: @escaping FrameLookup, publicCapture: @escaping PublicCapture) {
        self.privateCapture = privateCapture
        self.frameOf = frameOf
        self.publicCapture = publicCapture
    }

    public func snapshot(windowID: CGWindowID, maxWidth: Int, privatePath: Bool, unlessDigest: Int?,
                         completion: @escaping @MainActor (WindowStill) -> Void) {
        let privateCapture = self.privateCapture, frameOf = self.frameOf, publicCapture = self.publicCapture
        Task.detached(priority: .utility) {
            let still = await Self.take(windowID: windowID, maxWidth: maxWidth, privatePath: privatePath, unlessDigest: unlessDigest,
                                        privateCapture: privateCapture, frameOf: frameOf, publicCapture: publicCapture)
            await MainActor.run { completion(still) }
        }
    }

    /// The still as a frame (nil when none, blank or unchanged) — for callers that only want a picture.
    public func snapshot(windowID: CGWindowID, maxWidth: Int, privatePath: Bool, completion: @escaping @MainActor (ViewFrame?) -> Void) {
        snapshot(windowID: windowID, maxWidth: maxWidth, privatePath: privatePath, unlessDigest: nil) { still in
            if case .frame(let frame, _) = still { completion(frame) } else { completion(nil) }
        }
    }

    /// The window server's image when the private path allows it and it has content, else the public still.
    nonisolated static func take(windowID: CGWindowID, maxWidth: Int, privatePath: Bool, unlessDigest: Int?,
                                 privateCapture: PrivateCapture, frameOf: FrameLookup, publicCapture: PublicCapture) async -> WindowStill {
        if privatePath, let frame = frameOf(windowID), frame.width >= 2, frame.height >= 2,
           let image = privateCapture(windowID, frame) {
            let still = still(image, windowSize: frame.size, maxWidth: maxWidth, unlessDigest: unlessDigest)
            if still != .none { return still }
        }
        guard let frame = await publicCapture(windowID, maxWidth) else { return .none }
        let digest = ViewHub.digest(frame)
        return digest == unlessDigest ? .unchanged : .frame(frame, digest: digest)
    }

    /// A captured image as a mirror frame: drawn down to `maxWidth` pixels at most, JPEG. `.none` when blank.
    nonisolated static func still(_ image: CGImage, windowSize: CGSize, maxWidth: Int, unlessDigest: Int? = nil) -> WindowStill {
        let factor = min(1, Double(max(2, maxWidth)) / Double(image.width))
        let width = max(2, Int((Double(image.width) * factor).rounded()))
        let height = max(2, Int((Double(image.height) * factor).rounded()))
        guard let bitmap = Bitmap(drawing: image, width: width, height: height), !bitmap.isBlank else { return .none }
        let digest = bitmap.digest
        if digest == unlessDigest { return .unchanged }
        guard let sized = bitmap.image, let jpeg = encode(sized) else { return .none }
        return .frame(ViewFrame(jpeg: jpeg, width: width, height: height, windowSize: windowSize), digest: digest)
    }

    /// The old frame-or-nil shape of `still`.
    nonisolated static func still(_ image: CGImage, windowSize: CGSize, maxWidth: Int) -> ViewFrame? {
        if case .frame(let frame, _) = still(image, windowSize: windowSize, maxWidth: maxWidth, unlessDigest: nil) { return frame }
        return nil
    }

    nonisolated static func screenCaptureKit(windowID: CGWindowID, maxWidth: Int) async -> ViewFrame? {
        guard CGPreflightScreenCaptureAccess(),
              let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false),
              let window = content.windows.first(where: { $0.windowID == windowID }),
              window.frame.width >= 2, window.frame.height >= 2 else { return nil }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let scale = Double(filter.pointPixelScale)
        let pixelWidth = window.frame.width * scale
        let factor = min(1, Double(maxWidth) / pixelWidth)
        let config = SCStreamConfiguration()
        config.width = max(2, Int((pixelWidth * factor).rounded()))
        config.height = max(2, Int((window.frame.height * scale * factor).rounded()))
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        guard let image = try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config),
              case .frame(let frame, _) = still(image, windowSize: window.frame.size, maxWidth: maxWidth, unlessDigest: nil)
        else { return nil }
        return frame
    }

    nonisolated private static func encode(_ image: CGImage) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality as String: jpegQuality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }

    /// An image drawn down into memory we own: opaque 32-bit, in the image's own RGB color space when a bitmap can
    /// use it (no color conversion of the full-size source; the JPEG carries the profile), else sRGB.
    struct Bitmap {
        let context: CGContext
        let width: Int
        let height: Int

        init?(drawing image: CGImage, width: Int, height: Int) {
            let info = CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
            func make(_ space: CGColorSpace) -> CGContext? {
                CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: space,
                          bitmapInfo: info)
            }
            let own = image.colorSpace.flatMap { $0.model == .rgb ? make($0) : nil }
            guard let context = own ?? CGColorSpace(name: CGColorSpace.sRGB).flatMap(make), context.data != nil else { return nil }
            context.interpolationQuality = width == image.width && height == image.height ? .none : .high
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            self.context = context
            self.width = width
            self.height = height
        }

        private var words: UnsafeBufferPointer<UInt32> {
            UnsafeBufferPointer(start: context.data!.assumingMemoryBound(to: UInt32.self), count: context.bytesPerRow / 4 * height)
        }

        /// Every pixel black (or transparent, which an opaque bitmap draws as black): an image of nothing.
        var isBlank: Bool {
            // BGRX little-endian: the low three bytes are the color.
            !words.contains { pixel in (pixel & 0xFF) >= 4 || ((pixel >> 8) & 0xFF) >= 4 || ((pixel >> 16) & 0xFF) >= 4 }
        }

        /// FNV-1a over the pixels, a word at a time (the padding byte is ignored).
        var digest: Int {
            var hash: UInt64 = 0xcbf2_9ce4_8422_2325
            hash ^= UInt64(width) &* 31 &+ UInt64(height)
            for pixel in words {
                hash ^= UInt64(pixel & 0x00FF_FFFF)
                hash = hash &* 0x0000_0100_0000_01B3
            }
            return Int(truncatingIfNeeded: hash)
        }

        var image: CGImage? { context.makeImage() }
    }
}
