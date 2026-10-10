import AppKit
import CoreMedia
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers
import VideoToolbox
import WinterCUCore

// TEST-ONLY (the live suite's freshness measurement): does a window on another Space keep painting, and does an
// active ScreenCaptureKit stream on it make a difference? Reached only through a LIVE-TEST instance's
// `test.capture` / `test.stream` (`RPCDispatcher.init`'s `liveTest`); a normal helper has no such routes.
//   test.capture {windowId, source: "skylight"|"stream", path, rect?: [x, y, w, h]} → {width, height, frameAgeMs?}
//     skylight — the helper's own still path for a window off this desktop (SLSHWCaptureWindowListInRect, 0x800);
//     stream   — the latest complete frame of the test stream (`test.stream`), with how old it is.
//     `rect` is in the window's own points (top-left); the PNG is written to `path`, which must lie inside the
//     instance's home (the run's temp dir) — nothing else is ever written.
//   test.stream {windowId, on, fps?} → {running} — a desktop-independent SCStream on that window, started/stopped.

public struct TestCaptureParams: Codable, Sendable, Equatable {
    public var windowId: UInt32
    public var source: String
    public var path: String
    public var rect: [Double]?
    public init(windowId: UInt32, source: String, path: String, rect: [Double]? = nil) {
        self.windowId = windowId
        self.source = source
        self.path = path
        self.rect = rect
    }
}

public struct TestCaptureResult: Codable, Sendable, Equatable {
    public var width: Int
    public var height: Int
    /// stream only: how long ago the frame it wrote arrived.
    public var frameAgeMs: Int?
    public init(width: Int, height: Int, frameAgeMs: Int? = nil) {
        self.width = width
        self.height = height
        self.frameAgeMs = frameAgeMs
    }
}

public struct TestStreamParams: Codable, Sendable, Equatable {
    public var windowId: UInt32
    public var on: Bool
    public var fps: Int?
    public init(windowId: UInt32, on: Bool, fps: Int? = nil) {
        self.windowId = windowId
        self.on = on
        self.fps = fps
    }
}

public struct TestStreamResult: Codable, Sendable, Equatable {
    public var running: Bool
    public init(running: Bool) { self.running = running }
}

/// What the routes call; injectable so the dispatcher test needs no screen.
public protocol TestCapturing: Sendable {
    func capture(_ p: TestCaptureParams) async throws -> TestCaptureResult
    func stream(_ p: TestStreamParams) async throws -> TestStreamResult
}

public final class TestCapture: TestCapturing, @unchecked Sendable {
    private let home: String
    private let lock = NSLock()
    private var stream: SCStream?
    private var output: TestStreamOutput?

    public init(home: String) { self.home = home }

    /// A PNG path inside `home`, or nil: the file's PARENT must exist and resolve (realpath — `..`, symlinks,
    /// `/var` vs `/private/var`) to `home` or below it, and the file itself must not be a symlink. Returned in
    /// its resolved spelling. (NSURL standardizing is not enough: it drops `/private` only from a path that
    /// EXISTS, so an existing home and a PNG not written yet never compared equal.)
    public static func allowedPath(_ path: String, home: String) -> String? {
        guard path.hasPrefix("/"), path.hasSuffix(".png") else { return nil }
        let name = (path as NSString).lastPathComponent
        guard name.count > 4, !name.hasPrefix(".") else { return nil }
        guard let root = HelperIdentity.canonicalPath(home),
              let parent = HelperIdentity.canonicalPath((path as NSString).deletingLastPathComponent),
              parent == root || parent.hasPrefix(root + "/") else { return nil }
        let resolved = parent + "/" + name
        var st = stat()
        if lstat(resolved, &st) == 0, (st.st_mode & S_IFMT) == S_IFLNK { return nil }
        return resolved
    }

    /// The part of an image under `rect` (window points, top-left), the image being the whole window at
    /// `scale` pixels per point; the whole image when `rect` is nil.
    public static func crop(_ image: CGImage, rect: [Double]?, scale: Double) -> CGImage? {
        guard let rect, rect.count == 4 else { return image }
        let r = CGRect(x: rect[0] * scale, y: rect[1] * scale, width: rect[2] * scale, height: rect[3] * scale)
            .intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height)).integral
        guard !r.isEmpty else { return nil }
        return image.cropping(to: r)
    }

    public func capture(_ p: TestCaptureParams) async throws -> TestCaptureResult {
        guard let path = Self.allowedPath(p.path, home: home) else { throw RPCError.invalidParams("test.capture writes a .png inside the instance's home only") }
        let image: CGImage
        var age: Int?
        switch p.source {
        case "skylight":
            guard let frame = CUWindowLookup.frame(of: p.windowId) else { throw RPCError(code: "no_window", message: "no window \(p.windowId)") }
            var global: CGRect? = nil
            if let r = p.rect, r.count == 4 { global = CGRect(x: frame.minX + r[0], y: frame.minY + r[1], width: r[2], height: r[3]) }
            guard let shot = CUSkyLight.system.captureWithSkyLight(windowIDs: [p.windowId], rect: global).first else {
                throw RPCError(code: "no_window", message: "the window server gave no image of window \(p.windowId)")
            }
            image = shot
        case "stream":
            let latest: (image: CGImage, at: Date, scale: Double)? = lock.withLock { output?.latest }
            guard let latest else { throw RPCError(code: "no_window", message: "the test stream has no frame yet") }
            guard let cropped = Self.crop(latest.image, rect: p.rect, scale: latest.scale) else { throw RPCError.invalidParams("rect misses the frame") }
            image = cropped
            age = Int(Date().timeIntervalSince(latest.at) * 1000)
        default:
            throw RPCError.invalidParams("source is skylight or stream")
        }
        guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            throw RPCError.invalidParams("cannot write \(URL(fileURLWithPath: path).lastPathComponent)")
        }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else { throw RPCError.invalidParams("cannot write the PNG") }
        return TestCaptureResult(width: image.width, height: image.height, frameAgeMs: age)
    }

    public func stream(_ p: TestStreamParams) async throws -> TestStreamResult {
        let old: SCStream? = lock.withLock { () -> SCStream? in
            let s = stream
            stream = nil
            output = nil
            return s
        }
        if let old { try? await old.stopCapture() }
        guard p.on else { return TestStreamResult(running: false) }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let window = content.windows.first(where: { $0.windowID == p.windowId }) else {
            throw RPCError(code: "no_window", message: "ScreenCaptureKit lists no window \(p.windowId)")
        }
        let scale = Double(NSScreen.main?.backingScaleFactor ?? 2)
        let config = SCStreamConfiguration()
        config.width = max(1, Int(window.frame.width * scale))
        config.height = max(1, Int(window.frame.height * scale))
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, min(p.fps ?? 10, 30))))
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = false
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let out = TestStreamOutput(scale: scale)
        let s = SCStream(filter: filter, configuration: config, delegate: nil)
        try s.addStreamOutput(out, type: .screen, sampleHandlerQueue: out.queue)
        try await s.startCapture()
        lock.withLock { stream = s; output = out }
        return TestStreamResult(running: true)
    }
}

/// Keeps the latest complete frame as a CGImage.
final class TestStreamOutput: NSObject, SCStreamOutput, @unchecked Sendable {
    let queue = DispatchQueue(label: "com.winter.computeruse.test-stream")
    private let lock = NSLock()
    private let scale: Double
    private var last: (image: CGImage, at: Date, scale: Double)?

    init(scale: Double) { self.scale = scale }

    var latest: (image: CGImage, at: Date, scale: Double)? { lock.withLock { last } }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
              let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        var image: CGImage?
        VTCreateCGImageFromCVPixelBuffer(pixels, options: nil, imageOut: &image)
        guard let image else { return }
        lock.withLock { last = (image, Date(), scale) }
    }
}
