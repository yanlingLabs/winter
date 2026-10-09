import CoreMedia
import CoreVideo
import Foundation
import IOSurface
import ScreenCaptureKit

/// Why a window stream is not delivering frames.
enum WindowStreamFailure: Equatable {
    case windowNotFound
    case screenRecordingDenied
    /// The system stopped the stream; it is being reopened.
    case reconnecting
    /// Reopening failed too many times in a row.
    case gaveUp
    case other(String)

    /// The short state the deprecated floating mirror shows in its caption.
    var caption: String {
        switch self {
        case .windowNotFound: return "window not found"
        case .screenRecordingDenied: return "screen recording off"
        case .reconnecting: return "reconnecting"
        case .gaveUp, .other: return "no live view"
        }
    }
}

/// A live ScreenCaptureKit stream of one window, using a desktop-independent window filter so it keeps working while the
/// window is covered. Each complete frame is turned into a `Payload` by `process` ON THE CAPTURE QUEUE (so heavy work,
/// such as JPEG encoding, never touches the main thread), then delivered on the main thread. Needs the Screen Recording
/// grant.
///
/// When the system stops a running stream (`didStopWithError`: the display slept, the capture service restarted), it is
/// reopened with a bounded backoff for as long as the stream has not been `stop()`ped. A first open that fails (no
/// grant, window gone) is reported, not retried.
@MainActor final class WindowStream<Payload> {
    /// Runs on the capture queue, one frame at a time. Return nil to drop the frame (throttling, a failed encode).
    typealias Process = @Sendable (CVPixelBuffer) -> Payload?

    var onFrame: ((Payload) -> Void)?
    var onFailure: ((WindowStreamFailure) -> Void)?
    /// The window's size in points, as ScreenCaptureKit reported it when the stream opened (or as `resize` set it).
    private(set) var windowSize: CGSize = .zero

    private let windowID: CGWindowID
    private(set) var framesPerSecond: Int
    private let process: Process
    /// The window's frame (points, top-left) → the capture's pixel size. When nil, `start(pixelSize:)`'s size is used.
    private let sizing: (@MainActor (CGRect) -> CGSize)?
    private var stream: SCStream?
    private var output: FrameOutput?
    private var stopped = false
    private var pixelSize: CGSize = .zero
    private var backoff = RestartBackoff()
    /// Bumped on every open, so callbacks from a stream we already replaced are ignored.
    private var generation = 0

    init(windowID: CGWindowID, framesPerSecond: Int, sizing: (@MainActor (CGRect) -> CGSize)? = nil,
         process: @escaping Process) {
        self.windowID = windowID
        self.framesPerSecond = max(1, framesPerSecond)
        self.sizing = sizing
        self.process = process
    }

    func start(pixelSize: CGSize = .zero) {
        self.pixelSize = pixelSize
        Task { @MainActor [weak self] in await self?.open(retrying: false) }
    }

    func resize(pixelSize: CGSize, windowSize: CGSize? = nil) {
        if let windowSize { self.windowSize = windowSize }
        guard pixelSize != self.pixelSize else { return }
        self.pixelSize = pixelSize
        guard let stream else { return }
        let config = configuration()
        Task { try? await stream.updateConfiguration(config) }
    }

    /// A new frame rate for the running stream, through `updateConfiguration` — the stream is not restarted (a
    /// restart gaps the frames, and its first one can come back blank). Kept for the next open when none runs.
    func setFramesPerSecond(_ fps: Int) {
        let fps = max(1, fps)
        guard fps != framesPerSecond else { return }
        framesPerSecond = fps
        guard let stream else { return }
        let config = configuration()
        Task { try? await stream.updateConfiguration(config) }
    }

    func stop() {
        stopped = true
        onFrame = nil
        onFailure = nil
        guard let stream else { return }
        self.stream = nil
        output = nil
        Task { try? await stream.stopCapture() }
    }

    private func open(retrying: Bool) async {
        generation += 1
        let gen = generation
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard !stopped else { return }
            guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
                onFailure?(.windowNotFound)
                return
            }
            windowSize = window.frame.size
            if let sizing { pixelSize = sizing(window.frame) }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let process = self.process
            let output = FrameOutput { [weak self] pixelBuffer in
                guard let payload = process(pixelBuffer) else { return }
                // Hop to the main thread; drop frames that arrive after stop() or from a replaced stream.
                nonisolated(unsafe) let delivered = payload
                DispatchQueue.main.async {
                    MainActor.assumeIsolated { self?.frameArrived(delivered, generation: gen) }
                }
            } onStop: { [weak self] in
                DispatchQueue.main.async {
                    MainActor.assumeIsolated { self?.streamStopped(generation: gen) }
                }
            }
            let stream = SCStream(filter: filter, configuration: configuration(), delegate: output)
            try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: output.queue)
            try await stream.startCapture()
            if stopped {
                try? await stream.stopCapture()
                return
            }
            self.stream = stream
            self.output = output
        } catch {
            guard !stopped else { return }
            PresentationLog.notice("window stream for window \(windowID) failed: \(error.localizedDescription)")
            if retrying {
                scheduleRestart()
            } else {
                onFailure?(Self.failure(for: error))
            }
        }
    }

    private func frameArrived(_ payload: Payload, generation gen: Int) {
        guard !stopped, gen == generation else { return }
        backoff.reset()
        onFrame?(payload)
    }

    /// The system stopped the running stream: reopen it after the next backoff delay, while still wanted.
    private func streamStopped(generation gen: Int) {
        guard !stopped, gen == generation else { return }
        stream = nil
        output = nil
        scheduleRestart()
    }

    private func scheduleRestart() {
        guard let delay = backoff.nextDelay() else {
            PresentationLog.notice("window stream for window \(windowID) gave up after repeated stops")
            onFailure?(.gaveUp)
            return
        }
        onFailure?(.reconnecting)
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard let self, !self.stopped else { return }
            await self.open(retrying: true)
        }
    }

    private func configuration() -> SCStreamConfiguration {
        let config = SCStreamConfiguration()
        config.width = max(2, Int(pixelSize.width))
        config.height = max(2, Int(pixelSize.height))
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(framesPerSecond))
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = false
        config.queueDepth = 3
        config.scalesToFit = true
        config.preservesAspectRatio = true
        config.ignoreShadowsSingleWindow = true
        return config
    }

    private static func failure(for error: Error) -> WindowStreamFailure {
        if let scError = error as? SCStreamError, scError.code == .userDeclined { return .screenRecordingDenied }
        return .other(error.localizedDescription)
    }
}

/// The deprecated floating mirror's stream: frames as IOSurfaces for a layer's `contents`.
typealias MirrorStream = WindowStream<IOSurfaceRef>

extension WindowStream where Payload == IOSurfaceRef {
    convenience init(windowID: CGWindowID, framesPerSecond: Int) {
        self.init(windowID: windowID, framesPerSecond: framesPerSecond) { pixelBuffer in
            CVPixelBufferGetIOSurface(pixelBuffer)?.takeUnretainedValue()
        }
    }
}

/// Receives sample buffers on its own queue and passes complete frames on.
private final class FrameOutput: NSObject, SCStreamOutput, SCStreamDelegate {
    let queue = DispatchQueue(label: "com.winter.computeruse.window-frames", qos: .userInteractive)
    private let onPixelBuffer: (CVPixelBuffer) -> Void
    private let onStop: () -> Void

    init(onPixelBuffer: @escaping (CVPixelBuffer) -> Void, onStop: @escaping () -> Void) {
        self.onPixelBuffer = onPixelBuffer
        self.onStop = onStop
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid else { return }
        // Only complete frames carry new pixels; idle and blank frames are skipped.
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
                as? [[SCStreamFrameInfo: Any]],
              let rawStatus = attachments.first?[.status] as? Int,
              SCFrameStatus(rawValue: rawStatus) == .complete,
              let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer)
        else { return }
        onPixelBuffer(pixelBuffer)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        onStop()
    }
}
