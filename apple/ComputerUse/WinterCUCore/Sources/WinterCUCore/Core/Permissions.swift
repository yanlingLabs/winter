import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
@preconcurrency import ScreenCaptureKit

/// The helper's own TCC grants. Reading them never prompts; `request` makes sure the helper is LISTED in
/// the matching Privacy pane (so there is a switch to turn on), raises the system prompt when macOS still
/// offers it, and opens the pane.
enum CUPermissionsProbe {
    static func current() -> CUPermissions {
        CUPermissions(accessibility: AXIsProcessTrusted(), screenRecording: CGPreflightScreenCaptureAccess())
    }

    static let paneURLs: [CUPermissionKind: String] = [
        .accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        .screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    ]

    /// How long registering may take before the pane opens anyway.
    static let registerTimeout: Double = 3

    /// Already granted → nothing to do (the helper is listed and on). Otherwise:
    /// - **Screen Recording:** `CGRequestScreenCaptureAccess` alone does not add the app to "Screen & System
    ///   Audio Recording" on macOS 15+; actually touching ScreenCaptureKit does. So after the request the
    ///   helper asks for shareable content and attempts a 2×2-point capture (results discarded), bounded.
    /// - **Accessibility:** the prompting trust check adds the entry; one real AX query follows, which also
    ///   registers the caller on recent macOS.
    /// Then the Privacy pane opens, since neither prompt reports whether it was shown.
    @MainActor static func request(_ kind: CUPermissionKind) async {
        switch kind {
        case .accessibility:
            if AXIsProcessTrusted() { return }
            let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
            _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
            var focused: CFTypeRef?
            _ = AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute as CFString, &focused)
        case .screenRecording:
            if CGPreflightScreenCaptureAccess() { return }
            _ = CGRequestScreenCaptureAccess()
            await bounded(seconds: registerTimeout) { await touchScreenCaptureKit() }
        }
        if let s = paneURLs[kind], let url = URL(string: s) { NSWorkspace.shared.open(url) }
    }

    /// The ScreenCaptureKit calls that register the process for Screen Recording. Without the grant both
    /// fail (that failure is the point); with it, the tiny image is dropped at once.
    static func touchScreenCaptureKit() async {
        _ = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        _ = try? await SCScreenshotManager.captureImage(in: CGRect(x: 0, y: 0, width: 2, height: 2))
    }

    /// Runs `work` but returns after `seconds` at the latest; work still running then is left to finish on
    /// its own (system calls that hang are not cancellable). Returns whether `work` finished in time.
    @discardableResult
    static func bounded(seconds: Double, _ work: @escaping @Sendable () async -> Void) async -> Bool {
        final class Once: @unchecked Sendable {
            private let lock = NSLock()
            private var done = false
            func claim() -> Bool { lock.withLock { if done { return false }; done = true; return true } }
        }
        let once = Once()
        return await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            Task.detached {
                await work()
                if once.claim() { c.resume(returning: true) }
            }
            Task.detached {
                try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
                if once.claim() { c.resume(returning: false) }
            }
        }
    }

    /// The helper's version for `status` (its bundle's short version string).
    static var helperVersion: String {
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0.0.0-dev"
    }
}
