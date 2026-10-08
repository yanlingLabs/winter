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
    private let maxFps: Int
    private let maxWidth: Int
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
        let maxWidth = self.maxWidth
        let stream = WindowStream<EncodedImage>(
            windowID: windowID, framesPerSecond: maxFps,
            sizing: { frame in
                // The screen's scale comes from AppKit; nothing here asks the window server.
                CaptureSizing.pixelSize(windowSize: frame.size, scale: AppKitScreens.backingScale(for: frame),
                                        maxWidth: maxWidth)
            },
            process: { pixelBuffer in encoder.encode(pixelBuffer) }
        )
        stream.onFrame = { [weak self] image in self?.deliver(image) }
        stream.onFailure = { [weak self] failure in self?.fail(failure) }
        self.stream = stream
        stream.start()
    }

    public func stop() {
        stream?.stop()
        stream = nil
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

/// Throttles and encodes on the capture queue. Touched only there (the stream calls it one frame at a time).
final class FrameEncoder: @unchecked Sendable {
    private var throttle: FrameThrottle
    private let quality: CGFloat

    init(maxFps: Int, quality: CGFloat) {
        throttle = FrameThrottle(maxFps: maxFps)
        self.quality = quality
    }

    func encode(_ pixelBuffer: CVPixelBuffer) -> EncodedImage? {
        guard throttle.shouldEmit(at: ProcessInfo.processInfo.systemUptime) else { return nil }
        var image: CGImage?
        guard VTCreateCGImageFromCVPixelBuffer(pixelBuffer, options: nil, imageOut: &image) == noErr, let image,
              let jpeg = JPEGCodec.encode(image, quality: quality) else { return nil }
        return EncodedImage(jpeg: jpeg, width: image.width, height: image.height)
    }
}
