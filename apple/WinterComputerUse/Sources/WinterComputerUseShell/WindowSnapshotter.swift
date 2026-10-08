import CoreGraphics
import Foundation
import ImageIO
@preconcurrency import ScreenCaptureKit
import UniformTypeIdentifiers

/// One-shot pictures of a window the live stream cannot see (off every screen: another Space or display, or
/// minimized). Injected so the off-screen rules are tested without ScreenCaptureKit.
@MainActor public protocol WindowSnapshotter: AnyObject {
    /// Calls back on the main actor with a frame, or nil when none could be taken (or it came back blank).
    func snapshot(windowID: CGWindowID, maxWidth: Int, completion: @escaping @MainActor (ViewFrame?) -> Void)
}

/// `SCScreenshotManager` with a desktop-independent single-window filter — the same capture the engine's own
/// screenshots use, without its last resort (moving the window to this desktop), which a passive mirror must
/// never do. Whether macOS renders a window that is on another Space varies; an image that comes back empty
/// (all transparent or all black) counts as none, so it never replaces the last good frame.
@MainActor public final class LiveWindowSnapshotter: WindowSnapshotter {
    public static let jpegQuality: CGFloat = 0.7

    public init() {}

    public func snapshot(windowID: CGWindowID, maxWidth: Int, completion: @escaping @MainActor (ViewFrame?) -> Void) {
        Task.detached(priority: .utility) {
            let frame = await Self.take(windowID: windowID, maxWidth: maxWidth)
            await MainActor.run { completion(frame) }
        }
    }

    nonisolated private static func take(windowID: CGWindowID, maxWidth: Int) async -> ViewFrame? {
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
              !isBlank(image), let jpeg = encode(image) else { return nil }
        return ViewFrame(jpeg: jpeg, width: image.width, height: image.height, windowSize: window.frame.size)
    }

    /// Drawn down to 8×8: nothing but transparent or black pixels is an image of nothing.
    nonisolated static func isBlank(_ image: CGImage) -> Bool {
        var pixels = [UInt8](repeating: 0, count: 8 * 8 * 4)
        let drawn = pixels.withUnsafeMutableBytes { raw -> Bool in
            guard let context = CGContext(data: raw.baseAddress, width: 8, height: 8, bitsPerComponent: 8, bytesPerRow: 32,
                                          space: CGColorSpaceCreateDeviceRGB(),
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.interpolationQuality = .low
            context.draw(image, in: CGRect(x: 0, y: 0, width: 8, height: 8))
            return true
        }
        guard drawn else { return true }
        return stride(from: 0, to: pixels.count, by: 4).allSatisfy { i in
            pixels[i + 3] == 0 || (pixels[i] < 4 && pixels[i + 1] < 4 && pixels[i + 2] < 4)
        }
    }

    nonisolated private static func encode(_ image: CGImage) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality as String: jpegQuality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }
}
