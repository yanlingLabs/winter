import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// The helper's own TCC grants. The helper — not Winter.app, not the daemon — holds them, and shows in
/// System Settings as "Winter Computer Use".
public struct HelperPermissions: Codable, Equatable, Sendable {
    public var accessibility: Bool
    public var screenRecording: Bool

    public init(accessibility: Bool, screenRecording: Bool) {
        self.accessibility = accessibility
        self.screenRecording = screenRecording
    }
}

public enum PermissionKind: String, Codable, Sendable {
    case accessibility
    case screenRecording
}

/// `status` → `{helperVersion, permissions}`.
public struct HelperStatusResult: Codable, Equatable, Sendable {
    public var helperVersion: String
    public var permissions: HelperPermissions
}

/// `permissions.request` params and result.
public struct HelperPermissionsRequest: Codable, Equatable, Sendable {
    public var kind: PermissionKind
}

public struct HelperPermissionsRequestResult: Codable, Equatable, Sendable {
    public var opened: Bool
}

public protocol PermissionSystem: AnyObject {
    /// The grants as they stand. Never prompts.
    func current() -> HelperPermissions
    /// Raises the system prompt if macOS still offers it, otherwise opens the matching Privacy pane. Only ever
    /// reached from `permissions.request`, i.e. the user's Grant button in Winter's Settings.
    @MainActor func request(_ kind: PermissionKind)
}

/// The live grants. `current()` uses only the non-prompting checks (`AXIsProcessTrusted`,
/// `CGPreflightScreenCaptureAccess`).
public final class LivePermissionSystem: PermissionSystem {
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func current() -> HelperPermissions {
        HelperPermissions(accessibility: AXIsProcessTrusted(), screenRecording: CGPreflightScreenCaptureAccess())
    }

    @MainActor public func request(_ kind: PermissionKind) {
        let granted = kind == .accessibility ? AXIsProcessTrusted() : CGPreflightScreenCaptureAccess()
        let askedKey = "promptShown.\(kind.rawValue)"
        // macOS shows each prompt once per app; after that the calls below return without any UI, so a second
        // request goes to the pane (and so does a request for a grant that is already on, to let the user see it).
        if !granted, !defaults.bool(forKey: askedKey) {
            defaults.set(true, forKey: askedKey)
            switch kind {
            case .accessibility:
                _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
            case .screenRecording:
                _ = CGRequestScreenCaptureAccess()
            }
            return
        }
        let anchor = kind == .accessibility ? "Privacy_Accessibility" : "Privacy_ScreenCapture"
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") {
            NSWorkspace.shared.open(url)
        }
    }
}
