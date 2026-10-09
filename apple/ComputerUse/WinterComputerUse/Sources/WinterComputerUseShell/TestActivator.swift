import AppKit
import ApplicationServices

/// `test.activate {pid}` params (the live suite only — see `RPCDispatcher.init`'s `liveTest`).
public struct TestActivateParams: Codable, Sendable, Equatable {
    public var pid: Int32
    public init(pid: Int32) { self.pid = pid }
}

public struct TestActivateResult: Codable, Sendable, Equatable {
    /// `AXUIElementSetAttributeValue(app, kAXFrontmost, true)` answered success.
    public var frontmostSet: Bool
    /// A window of the app was raised (`kAXRaiseAction`).
    public var raised: Bool
    /// The app is frontmost right after (NSWorkspace) — the caller still watches for it to settle.
    public var frontmost: Bool
    public init(frontmostSet: Bool, raised: Bool, frontmost: Bool) {
        self.frontmostSet = frontmostSet
        self.raised = raised
        self.frontmost = frontmost
    }
}

/// TEST-ONLY: puts an app in front through Accessibility. macOS 26's cooperative activation ignores an activation a
/// background process asks for — the live suite's runner is one, and its "user's app" fixture cannot activate itself
/// — but setting an app's AXFrontmost from an Accessibility-trusted process (this helper) is honoured. Reached only
/// through a live-test instance's `test.activate`; a normal helper has no such route.
@MainActor
public enum TestActivator {
    public static func activate(pid: Int32) -> TestActivateResult {
        let app = AXUIElementCreateApplication(pid)
        let set = AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue) == .success
        var raised = false
        var value: CFTypeRef?
        if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
           let windows = value as? [AXUIElement], let first = windows.first {
            _ = AXUIElementSetAttributeValue(first, kAXMainAttribute as CFString, kCFBooleanTrue)
            raised = AXUIElementPerformAction(first, kAXRaiseAction as CFString) == .success
        }
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
        return TestActivateResult(frontmostSet: set, raised: raised, frontmost: front)
    }
}
