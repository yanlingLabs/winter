import CoreGraphics
import Foundation

// The presentation protocol between the helper shell (the caller) and this package. These shapes
// are pinned by the ComputerV2 phase-1 spine (§3): change them only together with the shell.

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
    /// A target was bound with mirror:true → show (or re-show) its mirror at the window's top-left corner, over the traffic
    /// lights; follow the window as it moves; dock to the nearest screen corner when it is minimized/off-Space/off-screen.
    /// At most 2 mirrors on screen (most recent on top); live window stream 10–15 fps ~360 px wide (ScreenCaptureKit,
    /// desktop-independent window filter).
    func showMirror(sessionId: String, target: CUWindowRef)
    func hideMirror(sessionId: String, target: CUWindowRef)
    /// Agent cursor: animate to `point` (screen points) over the target window and show the action; `press` adds a click
    /// pulse. Drawn in a click-through overlay above the target window (only when the window is visible on screen) AND
    /// inside that target's mirror.
    func cursor(sessionId: String, target: CUWindowRef, point: CGPoint, kind: CUCursorKind)
    /// The session's turn ended → fade its mirrors (also auto-fade 30 s after the last cursor/action on a target).
    func turnEnded(sessionId: String)
    func sessionEnded(sessionId: String)
    /// Global enable flag (settings computerUse.mirror). false → no mirrors (cursor overlay still shown).
    var mirrorsEnabled: Bool { get set }
}

public enum CUCursorKind: Sendable { case move, press, type, scroll, drag(to: CGPoint) }

// Additive: lets callers and tests compare kinds. Not part of the pinned shape.
extension CUCursorKind: Equatable {}

@MainActor public protocol CUEscapeTap: AnyObject {
    /// Armed while any session has an active script. When armed, a user-pressed Escape is swallowed and `onEscape` fires.
    func setArmed(_ armed: Bool)
    /// The helper is about to SEND Escape itself (a key action) → let synthetic Escapes through for `window` seconds.
    func expectSyntheticEscape(for window: TimeInterval)
    var onEscape: (() -> Void)? { get set }
}

public enum WinterCUPresentationFactory {
    /// The live presentation (AppKit panels, ScreenCaptureKit mirrors) and the Esc tap. Creating them draws nothing and
    /// installs nothing: panels appear on the first `showMirror`/`cursor`, and the tap is created on the first
    /// `setArmed(true)`.
    @MainActor public static func make() -> (CUPresentation, CUEscapeTap) {
        let presentation = PresentationController(
            windows: SystemWindowSource(),
            surfaces: AppKitSurfaceFactory(),
            clock: SystemClock(),
            ticker: RunLoopTicker()
        )
        let tap = EscapeTap(installer: CGEventTapInstaller(), clock: SystemClock())
        return (presentation, tap)
    }
}
