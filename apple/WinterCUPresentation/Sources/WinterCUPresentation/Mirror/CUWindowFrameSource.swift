import AppKit
import CoreVideo
import Foundation
import VideoToolbox

/// One encoded frame of a window, for `view.frame`.
public struct CUEncodedFrame: Sendable {
    public let jpeg: Data
    /// The image's size in pixels.
    public let width: Int
    public let height: Int
    /// The window's size in points.
    public let windowSize: CGSize
    /// Increases by one per frame of this source.
    public let seq: Int

    public init(jpeg: Data, width: Int, height: Int, windowSize: CGSize, seq: Int) {
        self.jpeg = jpeg
        self.width = width
        self.height = height
        self.windowSize = windowSize
        self.seq = seq
    }
}

public enum CUWindowFrameSourceError: Error, Equatable {
    case windowNotFound
    case screenRecordingDenied
    /// The system kept stopping the stream; reopening gave up.
    case gaveUp
    case captureFailed(String)
}

/// Captures one window for the in-app mirror: ScreenCaptureKit with a desktop-independent window filter (it works while
/// the window is covered), at most `maxFps` frames a second, at most `maxWidth` pixels wide, JPEG-encoded (quality 0.7)
/// on the capture queue, delivered on the main actor. Follows the window's size, and reopens a stream the system
/// stopped, with a bounded backoff. `stop()` releases everything.
@MainActor public final class CUWindowFrameSource {
    public static let jpegQuality: CGFloat = 0.7
    /// How often the window's size is re-read while frames flow.
    static let sizeCheckInterval: TimeInterval = 0.5

    private let windowID: CGWindowID
    private var maxFps: Int
    private var maxWidth: Int
    private var encoder: FrameEncoder?
    private var onFrame: (@MainActor (CUEncodedFrame) -> Void)?
    private var onError: (@MainActor (Error) -> Void)?
    private var stream: WindowStream<EncodedImage>?
    private var seq = 0
    private var lastSizeCheck: TimeInterval = 0
    private var sizeProbeInFlight = false
    private let server: WindowServer
    /// The size probe runs here, never on the main thread.
    private let probeQueue = DispatchQueue(label: "com.winter.computeruse.frame-source-size", qos: .utility)

    public convenience init(windowID: CGWindowID, maxFps: Int, maxWidth: Int,
                            onFrame: @escaping @MainActor (CUEncodedFrame) -> Void,
                            onError: @escaping @MainActor (Error) -> Void) {
        self.init(windowID: windowID, maxFps: maxFps, maxWidth: maxWidth, server: SystemWindowServer(),
                  onFrame: onFrame, onError: onError)
    }

    init(windowID: CGWindowID, maxFps: Int, maxWidth: Int, server: WindowServer,
         onFrame: @escaping @MainActor (CUEncodedFrame) -> Void, onError: @escaping @MainActor (Error) -> Void) {
        self.server = server
        self.windowID = windowID
        self.maxFps = max(1, maxFps)
        self.maxWidth = max(16, maxWidth)
        self.onFrame = onFrame
        self.onError = onError
    }

    public func start() {
        guard stream == nil else { return }
        let encoder = FrameEncoder(maxFps: maxFps, quality: Self.jpegQuality)
        self.encoder = encoder
        let stream = WindowStream<EncodedImage>(
            windowID: windowID, framesPerSecond: maxFps,
            sizing: { [weak self] frame in
                // The screen's scale comes from AppKit; nothing here asks the window server.
                CaptureSizing.pixelSize(windowSize: frame.size, scale: AppKitScreens.backingScale(for: frame),
                                        maxWidth: self?.maxWidth ?? 720)
            },
            process: { pixelBuffer in encoder.encode(pixelBuffer) }
        )
        stream.onFrame = { [weak self] image in self?.deliver(image) }
        stream.onFailure = { [weak self] failure in self?.fail(failure) }
        self.stream = stream
        stream.start()
    }

    /// A new rate or width for the running capture, applied in place (`SCStream.updateConfiguration`): no restart,
    /// so no gap and no blank first frame. The helper's idle throttle moves a window between its full rate and
    /// 1 fps this way on every burst of agent actions.
    public func update(maxFps: Int, maxWidth: Int) {
        let fps = max(1, maxFps), width = max(16, maxWidth)
        if fps != self.maxFps {
            self.maxFps = fps
            encoder?.setMaxFps(fps)
            stream?.setFramesPerSecond(fps)
        }
        if width != self.maxWidth {
            self.maxWidth = width
            if let stream, Self.hasSize(stream.windowSize) {
                let frame = CGRect(origin: .zero, size: stream.windowSize)
                stream.resize(pixelSize: CaptureSizing.pixelSize(windowSize: stream.windowSize,
                                                                 scale: AppKitScreens.backingScale(for: frame), maxWidth: width))
            }
        }
    }

    nonisolated static func hasSize(_ size: CGSize) -> Bool { size.width >= 1 && size.height >= 1 }

    public func stop() {
        stream?.stop()
        stream = nil
        encoder = nil
        onFrame = nil
        onError = nil
    }

    private func deliver(_ image: EncodedImage) {
        guard let stream else { return }
        followWindowSize(stream)
        seq += 1
        onFrame?(CUEncodedFrame(jpeg: image.jpeg, width: image.width, height: image.height,
                                windowSize: stream.windowSize, seq: seq))
    }

    /// Re-reads the window's frame now and then — ONE window's description, on a background queue — and gives a new
    /// shape a new capture size (the old one would letterbox).
    private func followWindowSize(_ stream: WindowStream<EncodedImage>) {
        let now = ProcessInfo.processInfo.systemUptime
        guard now - lastSizeCheck >= Self.sizeCheckInterval, !sizeProbeInFlight else { return }
        lastSizeCheck = now
        sizeProbeInFlight = true
        let server = self.server
        let id = windowID
        probeQueue.async { [weak self] in
            let frame = server.describe([id]).first?.bounds
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.sizeProbed(frame) }
            }
        }
    }

    private func sizeProbed(_ frame: CGRect?) {
        sizeProbeInFlight = false
        guard let stream, let frame,
              Self.shapeChanged(from: stream.windowSize, to: frame.size) else { return }
        let pixels = CaptureSizing.pixelSize(windowSize: frame.size, scale: AppKitScreens.backingScale(for: frame),
                                             maxWidth: maxWidth)
        stream.resize(pixelSize: pixels, windowSize: frame.size)
    }

    /// More than a point of change on either side.
    nonisolated static func shapeChanged(from old: CGSize, to new: CGSize) -> Bool {
        abs(new.width - old.width) > 1 || abs(new.height - old.height) > 1
    }

    private func fail(_ failure: WindowStreamFailure) {
        switch failure {
        case .reconnecting:
            return // logged by the stream; frames resume on their own
        case .windowNotFound: onError?(CUWindowFrameSourceError.windowNotFound)
        case .screenRecordingDenied: onError?(CUWindowFrameSourceError.screenRecordingDenied)
        case .gaveUp: onError?(CUWindowFrameSourceError.gaveUp)
        case .other(let message): onError?(CUWindowFrameSourceError.captureFailed(message))
        }
    }
}

/// A frame encoded on the capture queue.
struct EncodedImage: Sendable {
    let jpeg: Data
    let width: Int
    let height: Int
}

/// Throttles and encodes on the capture queue (the stream calls it one frame at a time); its rate can be changed
/// from the main actor, under the lock.
final class FrameEncoder: @unchecked Sendable {
    private var throttle: FrameThrottle
    private let quality: CGFloat
    private let lock = NSLock()

    init(maxFps: Int, quality: CGFloat) {
        throttle = FrameThrottle(maxFps: maxFps)
        self.quality = quality
    }

    func setMaxFps(_ fps: Int) {
        lock.withLock { throttle.setMaxFps(fps) }
    }

    func encode(_ pixelBuffer: CVPixelBuffer) -> EncodedImage? {
        // A frame of nothing (fully transparent, or pure black everywhere — what a stream can hand over while a
        // window is being re-rendered) never replaces a real picture, and does not use up the rate either.
        guard !Self.isBlank(pixelBuffer) else { return nil }
        let due = lock.withLock { throttle.shouldEmit(at: ProcessInfo.processInfo.systemUptime) }
        guard due else { return nil }
        var image: CGImage?
        guard VTCreateCGImageFromCVPixelBuffer(pixelBuffer, options: nil, imageOut: &image) == noErr, let image,
              let jpeg = JPEGCodec.encode(image, quality: quality) else { return nil }
        return EncodedImage(jpeg: jpeg, width: image.width, height: image.height)
    }

    /// An 8×8 sample of a 32BGRA buffer: every sample transparent, or every sample exactly black. A real window has
    /// an opaque, non-black pixel somewhere on that grid (a title bar, a control, text).
    static func isBlank(_ pixelBuffer: CVPixelBuffer) -> Bool {
        guard CVPixelBufferGetPixelFormatType(pixelBuffer) == kCVPixelFormatType_32BGRA else { return false }
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else { return true }
        let width = CVPixelBufferGetWidth(pixelBuffer), height = CVPixelBufferGetHeight(pixelBuffer)
        let rowBytes = CVPixelBufferGetBytesPerRow(pixelBuffer)
        guard width > 0, height > 0 else { return true }
        let bytes = base.assumingMemoryBound(to: UInt8.self)
        var allTransparent = true, allBlack = true
        for gy in 0..<8 {
            let y = min(height - 1, (gy * 2 + 1) * height / 16)
            for gx in 0..<8 {
                let x = min(width - 1, (gx * 2 + 1) * width / 16)
                let p = bytes + y * rowBytes + x * 4 // B, G, R, A
                if p[3] != 0 { allTransparent = false }
                if p[0] != 0 || p[1] != 0 || p[2] != 0 { allBlack = false }
                if !allTransparent && !allBlack { return false }
            }
        }
        return true
    }
}
