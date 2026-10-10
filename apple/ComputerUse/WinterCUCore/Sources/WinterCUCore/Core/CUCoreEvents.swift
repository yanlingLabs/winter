import CoreGraphics
import Foundation

/// Events core → shell (spine §3b). Delivered on the main actor. The shell maps them onto the presentation
/// layer (mirror, cursor, Esc tap) and the daemon notifications (`targetLost`, `permissionsChanged`).
@MainActor public protocol CUCoreEvents: AnyObject {
    func targetBound(sessionId: String, pid: pid_t, windowID: CGWindowID, appName: String, mirror: Bool)
    func targetReleased(sessionId: String, pid: pid_t, windowID: CGWindowID)
    /// What the agent cursor shows (WinterCUPresentation's DESIGN-cursor.md, "What the core emits"). `kind` and
    /// its payload:
    /// - "move"; "press" (`count`, `button` "left"/"right"/"middle"); "type"; "drag" (`dragTo`);
    /// - "target" (`frame`, the element's frame in screen points) just before an act on a ref;
    /// - "key" (`text` = the combo); "scroll" (`text` = the direction);
    /// - "waitBegin" (`text` = what is awaited, optional) / "waitEnd";
    /// - "refused"; "foreground" (`text` = "on"/"off", `point` = the real pointer); "done";
    /// - "caption" (`text`; nil clears) before a consequential action.
    /// `point` is in screen points, top-left origin; kinds that are not about a place carry the last point.
    func actionAt(sessionId: String, pid: pid_t, windowID: CGWindowID, point: CGPoint, kind: String, dragTo: CGPoint?,
                  frame: CGRect?, text: String?, count: Int?, button: String?)
    /// `reason`: "app_quit" | "window_closed".
    func targetLost(targetId: String, reason: String)
    func permissionsChanged(accessibility: Bool, screenRecording: Bool)
    /// The core is about to send Escape itself → the shell lets synthetic Escapes through the Esc tap.
    func willSendEscape()
    /// A desktop visit that moved (or tried to move) the user CLOSED, whatever its outcome — the work done, a failed
    /// primitive, a cancelled request, a window that never came on screen — so the daemon counts every one.
    func desktopVisited(_ visit: CUDesktopVisitEvent)
}

extension CUCoreEvents {
    public func desktopVisited(_ visit: CUDesktopVisitEvent) {}
}

/// One closed desktop visit, as the daemon is told of it (`desktopVisited`).
public struct CUDesktopVisitEvent: Sendable, Equatable {
    public let sessionId: String
    /// The request that opened it, when it had a call id.
    public let callId: String?
    public let report: CUVisitReport

    public init(sessionId: String, callId: String?, report: CUVisitReport) {
        self.sessionId = sessionId
        self.callId = callId
        self.report = report
    }
}
