import AppKit
import CoreGraphics
import Foundation
import ImageIO
@preconcurrency import ScreenCaptureKit
import UniformTypeIdentifiers

/// One encoded image plus the coordinate space it was taken in.
struct CUCapturedImage {
    var jpeg: Data
    var width: Int
    var height: Int
    /// The captured area in points (window-relative for windows, global for screens).
    var pointsRect: CGRect
}

/// Window, region and whole-screen capture through `SCScreenshotManager` (spec §3.5, §10).
///
/// - Windows are captured with a desktop-independent single-window filter: what is on top of the window
///   (other apps, the helper's own mirror and cursor overlay) can never appear in the image.
/// - Whole-screen images exclude the helper itself (its mirrors and cursor overlay), the system auth agents
///   and every app the daemon names (the user's "Don't allow" apps). Winter's own app windows are shown:
///   seeing them is fine, controlling them is refused at bind and at `screen.appAt`.
/// - One capture is in flight at a time: concurrent requests are serialised inside `replayd` with a large
///   per-request penalty, so queueing them here is faster.
/// - Shareable-content lookups are cached for 2 s, since enumerating them dominates a one-shot capture.
actor CUCapturer {
    private var cached: (at: Date, content: SCShareableContent)?
    private var busy = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    private func acquire() async {
        if !busy { busy = true; return }
        await withCheckedContinuation { waiters.append($0) }
    }

    private func release() {
        if waiters.isEmpty { busy = false } else { waiters.removeFirst().resume() }
    }

    private func content(fresh: Bool = false) async throws -> SCShareableContent {
        if !fresh, let c = cached, Date().timeIntervalSince(c.at) < 2 { return c.content }
        do {
            let c = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            cached = (Date(), c)
            return c
        } catch {
            if !CGPreflightScreenCaptureAccess() { throw CUError.permissionMissing(.screenRecording) }
            throw CUError.unsupported("screen capture is unavailable: \(error.localizedDescription)")
        }
    }

    // MARK: window / region

    func captureWindow(windowID: UInt32, region: CGRect?, budget: CUImageBudget) async throws -> CUCapturedImage {
        await acquire()
        defer { release() }
        guard CGPreflightScreenCaptureAccess() else { throw CUError.permissionMissing(.screenRecording) }
        // The size the image maps onto must be the window's size NOW: a cached SCWindow can be up to 2 s old
        // and a resized window would be letterboxed inside its stale frame, skewing every point click.
        guard let current = CUWindowServer.window(id: windowID)?.frame else { throw CUError.targetLost("the window is gone") }
        var scWindow = try await content().windows.first { $0.windowID == windowID }
        if scWindow == nil || !Self.sameFrame(scWindow!.frame, current) {
            scWindow = try await content(fresh: true).windows.first { $0.windowID == windowID }
        }
        guard let window = scWindow else { throw CUError.targetLost("the window is gone") }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let scale = Double(filter.pointPixelScale)
        let windowSize = current.size
        var area = CGRect(origin: .zero, size: windowSize)
        if let region {
            area = region.intersection(CGRect(origin: .zero, size: windowSize))
            guard !area.isNull, area.width >= 1, area.height >= 1 else {
                throw CUError.invalidParams("region is outside the window (\(Int(windowSize.width))×\(Int(windowSize.height)) points)")
            }
        }
        let source = CGSize(width: area.width * scale, height: area.height * scale)
        let (w, h) = CUCaptureBudget.targetSize(source: source, budget: budget)
        let config = SCStreamConfiguration()
        config.width = w
        config.height = h
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        config.captureResolution = .best
        if region != nil { config.sourceRect = area }
        let image = try await shoot(filter: filter, config: config)
        let encoded = try encode(image, width: w, height: h, quality: budget.quality)
        return CUCapturedImage(jpeg: encoded.data, width: encoded.width, height: encoded.height, pointsRect: area)
    }

    // MARK: whole screen

    func captureScreen(display: CUDisplaySelector?, displayId: UInt32?, excludeBundleIds: [String],
                       budget: CUImageBudget) async throws -> CUCapturedImage {
        await acquire()
        defer { release() }
        guard CGPreflightScreenCaptureAccess() else { throw CUError.permissionMissing(.screenRecording) }
        let content = try await content(fresh: true)
        let displays = Self.orderedDisplays(content.displays)
        let chosen = try Self.choose(displays.map(\.displayID), display: display, displayId: displayId)
            .compactMap { id in displays.first { $0.displayID == id } }
        guard !chosen.isEmpty else { throw CUError.unsupported("no display to capture") }

        // The helper (by bundle id and by pid), the auth agents, and the caller's exclusions. Winter's own app
        // windows stay in the image: seeing them is fine, controlling them is refused at bind and appAt.
        var extra = Set(excludeBundleIds)
        if let own = Bundle.main.bundleIdentifier { extra.insert(own) }
        let ownPid = getpid()
        let excludedApps = content.applications.filter {
            CUFloors.excludedFromScreenshots($0.bundleIdentifier, extra: extra) || $0.processID == ownPid
        }

        // Global frames (points, top-left origin) and their union.
        let frames = chosen.map { CGDisplayBounds($0.displayID) }
        let union = frames.dropFirst().reduce(frames[0]) { $0.union($1) }
        let maxScale = chosen.map { Self.pixelScale($0.displayID) }.max() ?? 1
        let (w, h) = CUCaptureBudget.targetSize(
            source: CGSize(width: union.width * maxScale, height: union.height * maxScale), budget: budget)
        let pxPerPt = Double(w) / union.width

        let image: CGImage
        if chosen.count == 1 {
            let filter = SCContentFilter(display: chosen[0], excludingApplications: excludedApps, exceptingWindows: [])
            let config = SCStreamConfiguration()
            config.width = w
            config.height = h
            config.showsCursor = false
            image = try await shoot(filter: filter, config: config)
        } else {
            guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                      bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
            else { throw CUError.unsupported("could not compose the displays") }
            ctx.setFillColor(CGColor(gray: 0, alpha: 1))
            ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
            for (d, f) in zip(chosen, frames) {
                let filter = SCContentFilter(display: d, excludingApplications: excludedApps, exceptingWindows: [])
                let config = SCStreamConfiguration()
                config.width = max(1, Int(f.width * pxPerPt))
                config.height = max(1, Int(f.height * pxPerPt))
                config.showsCursor = false
                let part = try await shoot(filter: filter, config: config)
                // CGContext's origin is bottom-left; the union's is top-left.
                let x = (f.minX - union.minX) * pxPerPt
                let y = Double(h) - (f.minY - union.minY) * pxPerPt - Double(config.height)
                ctx.draw(part, in: CGRect(x: x, y: y, width: Double(config.width), height: Double(config.height)))
            }
            guard let composed = ctx.makeImage() else { throw CUError.unsupported("could not compose the displays") }
            image = composed
        }
        let encoded = try encode(image, width: w, height: h, quality: budget.quality)
        return CUCapturedImage(jpeg: encoded.data, width: encoded.width, height: encoded.height, pointsRect: union)
    }

    static func sameFrame(_ a: CGRect, _ b: CGRect) -> Bool {
        abs(a.minX - b.minX) < 0.5 && abs(a.minY - b.minY) < 0.5 && abs(a.width - b.width) < 0.5
            && abs(a.height - b.height) < 0.5
    }

    /// Which displays to capture (pure): `displayId` when given, else an index (0 = main), else all, else the
    /// main display. `ordered` has the main display first.
    static func choose(_ ordered: [CGDirectDisplayID], display: CUDisplaySelector?, displayId: UInt32?) throws
        -> [CGDirectDisplayID] {
        if let id = displayId {
            guard ordered.contains(id) else { throw CUError.invalidParams("no display with id \(id)") }
            return [id]
        }
        switch display {
        case nil: return Array(ordered.prefix(1))
        case .all?: return ordered
        case .index(let n)?:
            guard n >= 0, n < ordered.count else {
                throw CUError.invalidParams("no display \(n) — there are \(ordered.count) (0 is the main one)")
            }
            return [ordered[n]]
        }
    }

    static func orderedDisplays(_ displays: [SCDisplay]) -> [SCDisplay] {
        let main = CGMainDisplayID()
        return displays.sorted { a, b in
            if a.displayID == main { return true }
            if b.displayID == main { return false }
            let fa = CGDisplayBounds(a.displayID), fb = CGDisplayBounds(b.displayID)
            return (fa.minX, fa.minY) < (fb.minX, fb.minY)
        }
    }

    static func pixelScale(_ id: CGDirectDisplayID) -> Double {
        guard let mode = CGDisplayCopyDisplayMode(id), mode.width > 0 else { return 1 }
        return Double(mode.pixelWidth) / Double(mode.width)
    }

    // MARK: plumbing

    private func shoot(filter: SCContentFilter, config: SCStreamConfiguration) async throws -> CGImage {
        do {
            return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        } catch {
            if !CGPreflightScreenCaptureAccess() { throw CUError.permissionMissing(.screenRecording) }
            throw CUError.unsupported("capture failed: \(error.localizedDescription)")
        }
    }

    private func encode(_ image: CGImage, width: Int, height: Int, quality: Double) throws -> (data: Data, width: Int, height: Int) {
        let result = CUCaptureBudget.encodeWithinCap(width: width, height: height, quality: quality) { w, h, q in
            let img = (w == image.width && h == image.height) ? image : Self.scaled(image, w, h)
            return img.flatMap { Self.jpeg($0, quality: q) }
        }
        guard let result else { throw CUError.unsupported("could not encode the image") }
        return result
    }

    static func scaled(_ image: CGImage, _ w: Int, _ h: Int) -> CGImage? {
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { return nil }
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        return ctx.makeImage()
    }

    static func jpeg(_ image: CGImage, quality: Double) -> Data? {
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return data as Data
    }
}
