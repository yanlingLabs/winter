import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// The helper's own TCC grants. Reading them never prompts; `request` raises the system prompt when macOS
/// still offers it and opens the matching Privacy pane either way (the user toggles the switch there).
enum CUPermissionsProbe {
    static func current() -> CUPermissions {
        CUPermissions(accessibility: AXIsProcessTrusted(), screenRecording: CGPreflightScreenCaptureAccess())
    }

    static let paneURLs: [CUPermissionKind: String] = [
        .accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        .screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    ]

    /// Already granted → nothing to do. Otherwise the system prompt (shown only while macOS still offers it)
    /// plus the Privacy pane, since the prompt alone cannot tell us whether it appeared.
    @MainActor static func request(_ kind: CUPermissionKind) {
        switch kind {
        case .accessibility:
            if AXIsProcessTrusted() { return }
            let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
            _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
        case .screenRecording:
            if CGPreflightScreenCaptureAccess() { return }
            _ = CGRequestScreenCaptureAccess()
        }
        if let s = paneURLs[kind], let url = URL(string: s) { NSWorkspace.shared.open(url) }
    }

    /// The helper's version for `status` (its bundle's short version string).
    static var helperVersion: String {
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0.0.0-dev"
    }
}
