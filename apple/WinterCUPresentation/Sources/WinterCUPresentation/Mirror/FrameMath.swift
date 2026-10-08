import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// The capture's pixel size for a window: its size at the screen's backing scale, no wider than `maxWidth` pixels,
/// aspect kept, even dimensions (what video-style pixel buffers like), at least 2×2. A very tall window is also held
/// to twice `maxWidth` in height.
enum CaptureSizing {
    static func pixelSize(windowSize: CGSize, scale: CGFloat, maxWidth: Int) -> CGSize {
        guard windowSize.width > 0, windowSize.height > 0, maxWidth > 0 else { return CGSize(width: 2, height: 2) }
        let aspect = windowSize.width / windowSize.height
        var width = min(CGFloat(maxWidth), (windowSize.width * max(scale, 1)).rounded())
        var height = width / aspect
        let maxHeight = CGFloat(maxWidth) * 2
        if height > maxHeight {
            height = maxHeight
            width = height * aspect
        }
        func even(_ v: CGFloat) -> CGFloat { max(2, (v / 2).rounded() * 2) }
        return CGSize(width: even(width), height: even(height))
    }
}

/// Lets a frame through at most every `1 / maxFps` seconds. A frame arriving a little early (within 10% of the
/// interval) still passes, so a source running exactly at `maxFps` is not halved by jitter.
struct FrameThrottle: Equatable {
    let minInterval: TimeInterval
    private(set) var lastEmit: TimeInterval = -.infinity

    init(maxFps: Int) {
        minInterval = 1 / Double(max(1, maxFps))
    }

    mutating func shouldEmit(at t: TimeInterval) -> Bool {
        guard t - lastEmit >= minInterval * 0.9 else { return false }
        lastEmit = t
        return true
    }
}

/// JPEG in and out, with ImageIO.
enum JPEGCodec {
    static func encode(_ image: CGImage, quality: CGFloat) -> Data? {
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality as String: quality] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return data as Data
    }

    /// Decodes now (not lazily at first draw), so the cost lands where the caller expects it.
    static func decode(_ data: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately as String: true] as CFDictionary)
    }
}

/// Where things go inside the in-app mirror: the live image aspect-fit in the content area, and the WINDOW inside the
/// image (aspect-fit again, because the capture letterboxes a window whose shape changed since the stream opened).
enum MirrorGeometry {
    /// The rect the image is drawn in, inside `content`.
    static func imageRect(content: CGRect, imageSize: CGSize?, windowSize: CGSize) -> CGRect {
        let size = imageSize ?? windowSize
        guard size.width > 0, size.height > 0 else { return content }
        return MirrorLayout.aspectFit(aspect: size.width / size.height, in: content)
    }

    /// The rect the window's own pixels occupy inside `content`.
    static func windowRect(content: CGRect, imageSize: CGSize?, windowSize: CGSize) -> CGRect {
        let image = imageRect(content: content, imageSize: imageSize, windowSize: windowSize)
        guard windowSize.width > 0, windowSize.height > 0 else { return image }
        return MirrorLayout.aspectFit(aspect: windowSize.width / windowSize.height, in: image)
    }

    /// A window-relative point (points) → the mirror's space.
    static func map(_ p: CGPoint, windowRect: CGRect, windowSize: CGSize) -> CGPoint {
        guard windowSize.width > 0, windowSize.height > 0 else { return windowRect.origin }
        return CGPoint(x: windowRect.minX + p.x / windowSize.width * windowRect.width,
                       y: windowRect.minY + p.y / windowSize.height * windowRect.height)
    }
}
