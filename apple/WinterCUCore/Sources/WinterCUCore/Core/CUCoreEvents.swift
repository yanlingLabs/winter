import CoreGraphics
import Foundation

/// Events core → shell (spine §3b). Delivered on the main actor. The shell maps them onto the presentation
/// layer (mirror, cursor, Esc tap) and the daemon notifications (`targetLost`, `permissionsChanged`).
@MainActor public protocol CUCoreEvents: AnyObject {
    func targetBound(sessionId: String, pid: pid_t, windowID: CGWindowID, appName: String, mirror: Bool)
    func targetReleased(sessionId: String, pid: pid_t, windowID: CGWindowID)
    /// `kind`: "move" | "press" | "type" | "scroll" | "drag"; `dragTo` only for "drag".
    func actionAt(sessionId: String, pid: pid_t, windowID: CGWindowID, point: CGPoint, kind: String, dragTo: CGPoint?)
    /// `reason`: "app_quit" | "window_closed".
    func targetLost(targetId: String, reason: String)
    func permissionsChanged(accessibility: Bool, screenRecording: Bool)
    /// The core is about to send Escape itself → the shell lets synthetic Escapes through the Esc tap.
    func willSendEscape()
}
