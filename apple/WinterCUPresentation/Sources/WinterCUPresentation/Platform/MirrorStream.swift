import CoreMedia
import CoreVideo
import Foundation
import IOSurface
import ScreenCaptureKit

/// A live ScreenCaptureKit stream of one window, using a desktop-independent window filter so it keeps working while the
/// window is covered. Frames arrive as IOSurfaces on the main thread. Needs the Screen Recording grant; without it the
/// stream reports a failure and the mirror shows its caption only.
///
/// When the system stops a running stream (`didStopWithError`: the display slept, the capture service restarted), it is
/// reopened with a bounded backoff for as long as the stream has not been `stop()`ped, i.e. while its mirror is still
/// meant to show. A first open that fails (no grant, window gone) is reported, not retried.
@MainActor final class MirrorStream {
    var onFrame: ((IOSurfaceRef) -> Void)?
    var onFailure: ((String) -> Void)?

    private let windowID: CGWindowID
    private let framesPerSecond: Int
    private var stream: SCStream?
    private var output: FrameOutput?
    private var stopped = false
    private var pixelSize: CGSize = .zero
    private var backoff = RestartBackoff()
    /// Bumped on every open, so callbacks from a stream we already replaced are ignored.
    private var generation = 0

    init(windowID: CGWindowID, framesPerSecond: Int) {
        self.windowID = windowID
        self.framesPerSecond = max(1, framesPerSecond)
    }

    func start(pixelSize: CGSize) {
        self.pixelSize = pixelSize
        Task { @MainActor [weak self] in await self?.open(retrying: false) }
    }

    func resize(pixelSize: CGSize) {
        guard pixelSize != self.pixelSize else { return }
        self.pixelSize = pixelSize
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
                onFailure?("window not found")
                return
            }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let output = FrameOutput { [weak self] surface in
                // Hop to the main thread; drop frames that arrive after stop() or from a replaced stream.
                DispatchQueue.main.async {
                    MainActor.assumeIsolated { self?.frameArrived(surface, generation: gen) }
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
            PresentationLog.notice("mirror stream for window \(windowID) failed: \(error.localizedDescription)")
            if retrying {
                scheduleRestart()
            } else {
                onFailure?(Self.describe(error))
            }
        }
    }

    private func frameArrived(_ surface: IOSurfaceRef, generation gen: Int) {
        guard !stopped, gen == generation else { return }
        backoff.reset()
        onFrame?(surface)
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
            PresentationLog.notice("mirror stream for window \(windowID) gave up after repeated stops")
            onFailure?("no live view")
            return
        }
        onFailure?("reconnecting")
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

    private static func describe(_ error: Error) -> String {
        if let scError = error as? SCStreamError, scError.code == .userDeclined {
            return "screen recording off"
        }
        return "no live view"
    }
}

/// Receives sample buffers on its own queue and passes complete frames on as IOSurfaces.
private final class FrameOutput: NSObject, SCStreamOutput, SCStreamDelegate {
    let queue = DispatchQueue(label: "com.winter.computeruse.mirror-frames", qos: .userInteractive)
    private let onSurface: (IOSurfaceRef) -> Void
    private let onStop: () -> Void

    init(onSurface: @escaping (IOSurfaceRef) -> Void, onStop: @escaping () -> Void) {
        self.onSurface = onSurface
        self.onStop = onStop
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid else { return }
        // Only complete frames carry new pixels; idle and blank frames are skipped.
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
                as? [[SCStreamFrameInfo: Any]],
              let rawStatus = attachments.first?[.status] as? Int,
              SCFrameStatus(rawValue: rawStatus) == .complete,
              let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer),
              let surface = CVPixelBufferGetIOSurface(pixelBuffer)?.takeUnretainedValue()
        else { return }
        onSurface(surface)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        onStop()
    }
}
