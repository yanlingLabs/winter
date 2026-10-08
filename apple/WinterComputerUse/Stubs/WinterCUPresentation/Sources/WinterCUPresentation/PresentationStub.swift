import CoreGraphics
import Foundation

// STUB of the presentation protocol the helper shell calls (ComputerV2 phase-1 contract §3), transcribed
// from the real package's `API.swift` so the shell compiles and links before that package merges. The
// factory returns inert objects: no panel, no stream, no event tap. Deleted at merge.

/// One window the helper works on. `windowID` is the window server's id (`CGWindowID`).
public struct CUWindowRef: Sendable, Hashable {
    public let pid: pid_t
    public let windowID: CGWindowID
    public let appName: String

    public init(pid: pid_t, windowID: CGWindowID, appName: String) {
        self.pid = pid
        self.windowID = windowID
        self.appName = appName
    }
}

@MainActor public protocol CUPresentation: AnyObject {
    func showMirror(sessionId: String, target: CUWindowRef)
    func hideMirror(sessionId: String, target: CUWindowRef)
    func cursor(sessionId: String, target: CUWindowRef, point: CGPoint, kind: CUCursorKind)
    func turnEnded(sessionId: String)
    func sessionEnded(sessionId: String)
    var mirrorsEnabled: Bool { get set }
}

public enum CUCursorKind: Sendable { case move, press, type, scroll, drag(to: CGPoint) }

extension CUCursorKind: Equatable {}

@MainActor public protocol CUEscapeTap: AnyObject {
    func setArmed(_ armed: Bool)
    func expectSyntheticEscape(for window: TimeInterval)
    var onEscape: (() -> Void)? { get set }
}

public enum WinterCUPresentationFactory {
    @MainActor public static func make() -> (CUPresentation, CUEscapeTap) {
        (InertPresentation(), InertEscapeTap())
    }
}

@MainActor private final class InertPresentation: CUPresentation {
    var mirrorsEnabled = true
    func showMirror(sessionId: String, target: CUWindowRef) {}
    func hideMirror(sessionId: String, target: CUWindowRef) {}
    func cursor(sessionId: String, target: CUWindowRef, point: CGPoint, kind: CUCursorKind) {}
    func turnEnded(sessionId: String) {}
    func sessionEnded(sessionId: String) {}
}

@MainActor private final class InertEscapeTap: CUEscapeTap {
    var onEscape: (() -> Void)?
    func setArmed(_ armed: Bool) {}
    func expectSyntheticEscape(for window: TimeInterval) {}
}
