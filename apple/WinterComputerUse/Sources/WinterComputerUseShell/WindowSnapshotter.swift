import CoreGraphics
import Foundation
import ImageIO
@preconcurrency import ScreenCaptureKit
import UniformTypeIdentifiers
import WinterCUCore

/// One-shot pictures of a window the live stream cannot see (off every screen: another Space or display, in
/// full screen elsewhere, or minimized). Injected so the off-screen rules are tested without capturing.
@MainActor public protocol WindowSnapshotter: AnyObject {
    /// Calls back on the main actor with a frame, or nil when none could be taken (or it came back blank).
    /// `privatePath`: the bind's `computerUse.privateEventPath` — may the window server's own image be used?
    func snapshot(windowID: CGWindowID, maxWidth: Int, privatePath: Bool, completion: @escaping @MainActor (ViewFrame?) -> Void)
}

/// With the private path on, the window server's own image of the window first: SkyLight's
/// `SLSHWCaptureWindowListInRect`, its last drawn content wherever it is (ChatGPT takes its off-screen stills
/// the same way; its live streams have no such fallback, and neither do ours). Then `SCScreenshotManager` with a
/// desktop-independent single-window filter, the engine's public capture. Neither moves, raises or focuses
/// anything — a passive mirror must never. An image that comes back empty (all transparent or all black)
/// counts as none, so it never replaces the last good frame.
@MainActor public final class LiveWindowSnapshotter: WindowSnapshotter {
    public static let jpegQuality: CGFloat = 0.7

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

    public func snapshot(windowID: CGWindowID, maxWidth: Int, privatePath: Bool, completion: @escaping @MainActor (ViewFrame?) -> Void) {
        let privateCapture = self.privateCapture, frameOf = self.frameOf, publicCapture = self.publicCapture
        Task.detached(priority: .utility) {
            let frame = await Self.take(windowID: windowID, maxWidth: maxWidth, privatePath: privatePath,
                                        privateCapture: privateCapture, frameOf: frameOf, publicCapture: publicCapture)
            await MainActor.run { completion(frame) }
        }
    }

    /// The window server's image when the private path allows it and it has content, else the public still.
    nonisolated static func take(windowID: CGWindowID, maxWidth: Int, privatePath: Bool, privateCapture: PrivateCapture,
                                 frameOf: FrameLookup, publicCapture: PublicCapture) async -> ViewFrame? {
        if privatePath, let frame = frameOf(windowID), frame.width >= 2, frame.height >= 2,
           let image = privateCapture(windowID, frame), let still = still(image, windowSize: frame.size, maxWidth: maxWidth) {
            return still
        }
        return await publicCapture(windowID, maxWidth)
    }

    /// A captured image as a mirror frame: drawn down to `maxWidth` pixels at most, JPEG. Nil when blank.
    nonisolated static func still(_ image: CGImage, windowSize: CGSize, maxWidth: Int) -> ViewFrame? {
        guard !isBlank(image) else { return nil }
        let factor = min(1, Double(max(2, maxWidth)) / Double(image.width))
        let width = max(2, Int((Double(image.width) * factor).rounded()))
        let height = max(2, Int((Double(image.height) * factor).rounded()))
        let sized = width == image.width && height == image.height ? image : CUImageTools.scaled(image, width: width, height: height)
        guard let sized, let jpeg = encode(sized) else { return nil }
        return ViewFrame(jpeg: jpeg, width: sized.width, height: sized.height, windowSize: windowSize)
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
              !isBlank(image), let jpeg = encode(image) else { return nil }
        return ViewFrame(jpeg: jpeg, width: image.width, height: image.height, windowSize: window.frame.size)
    }

    /// Drawn down to 8×8: nothing but transparent or black pixels is an image of nothing.
    nonisolated static func isBlank(_ image: CGImage) -> Bool { CUImageTools.isBlank(image) }

    nonisolated private static func encode(_ image: CGImage) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality as String: jpegQuality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }
}
