import AppKit
import Carbon
import Foundation

/// `test.automation {pid?, bundleId?}` params — the live suite only (a live-test instance's route, `RPCDispatcher`).
public struct TestAutomationParams: Codable, Sendable, Equatable {
    public var pid: Int32?
    public var bundleId: String?
    public init(pid: Int32? = nil, bundleId: String? = nil) {
        self.pid = pid
        self.bundleId = bundleId
    }
}

/// `granted` (noErr), `would_ask` (-1744: macOS would put its question on screen), `denied` (-1743), `not_running`
/// (-600, or no such app), else `unknown` — with the raw status.
public struct TestAutomationResult: Codable, Sendable, Equatable {
    public var status: String
    public var code: Int32
    public init(status: String, code: Int32) {
        self.status = status
        self.code = code
    }
}

/// TEST-ONLY: may this helper send Apple Events to an app — asked WITHOUT ever raising macOS's Automation question
/// (`AEDeterminePermissionToAutomateTarget` with `askUserIfNeeded: false`, the same check `target.applescript` makes
/// first). The live suite runs an AppleScript-backed scenario only when this answers `granted`, so a test never puts a
/// permission prompt on screen.
public enum CUAutomationProbe {
    public static func status(_ p: TestAutomationParams) -> TestAutomationResult {
        let pid: pid_t? = p.pid ?? p.bundleId.flatMap { NSRunningApplication.runningApplications(withBundleIdentifier: $0).first?.processIdentifier }
        guard let pid, pid > 0 else { return TestAutomationResult(status: "not_running", code: Int32(procNotFound)) }
        return word(CUAppleScriptRunner.automationPermission(pid: pid))
    }

    /// The status word for an `AEDeterminePermissionToAutomateTarget` answer. Pure.
    public static func word(_ s: OSStatus) -> TestAutomationResult {
        switch s {
        case OSStatus(noErr): return TestAutomationResult(status: "granted", code: s)
        case OSStatus(errAEEventWouldRequireUserConsent): return TestAutomationResult(status: "would_ask", code: s)
        case OSStatus(errAEEventNotPermitted): return TestAutomationResult(status: "denied", code: s)
        case OSStatus(procNotFound): return TestAutomationResult(status: "not_running", code: s)
        default: return TestAutomationResult(status: "unknown", code: s)
        }
    }
}
